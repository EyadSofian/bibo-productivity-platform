package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Device is one installed agent, as shown in the fleet inventory (F40). It is
// registered as a side effect of sync; the fields beyond id/label are managed
// here.
type Device struct {
	ID                string     `json:"id"`
	BusinessID        *string    `json:"business_id"`
	UserID            string     `json:"user_id"`
	Label             *string    `json:"label"`
	OS                *string    `json:"os"`
	AgentVersion      *string    `json:"agent_version"`
	MonitoringEnabled bool       `json:"monitoring_enabled"`
	LastSeenAt        *time.Time `json:"last_seen_at"`
	DisabledAt        *time.Time `json:"disabled_at"`
	DeletedAt         *time.Time `json:"deleted_at"`
	// The person who owns/uses the device, joined for display. Not a device
	// column — the inventory is far more legible with a name than a user UUID.
	UserDisplayName string `json:"user_display_name"`
	UserLogin       string `json:"user_login"`
}

// LiveCaptureRequest is a one-shot request for the managed agent to take and
// immediately upload a policy-compliant screenshot.
type LiveCaptureRequest struct {
	DeviceID    string    `json:"device_id"`
	RequestedAt time.Time `json:"requested_at"`
}

const deviceCols = `d.id, d.business_id, d.user_id, d.label, d.os, d.agent_version,
	d.monitoring_enabled, d.last_seen_at, d.disabled_at, d.deleted_at,
	COALESCE(u.display_name, ''), COALESCE(u.email, u.username, '')`

func scanDevice(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.BusinessID, &d.UserID, &d.Label, &d.OS, &d.AgentVersion,
		&d.MonitoringEnabled, &d.LastSeenAt, &d.DisabledAt, &d.DeletedAt,
		&d.UserDisplayName, &d.UserLogin)
	return d, err
}

// ListDevices returns every device belonging to a business the caller owns,
// newest-seen first. Ownership is enforced in the query: a device is returned
// only when its business_id names a business whose owner_user_id is the caller,
// so passing another owner's business id yields an empty list, never their
// devices.
func (s *Store) ListDevices(ctx context.Context, ownerID, businessID string, includeDeleted bool) ([]Device, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+deviceCols+`
		  FROM devices d
		  JOIN businesses b ON b.id = d.business_id
		  JOIN users u ON u.id = d.user_id
		 WHERE d.business_id = $1
		   AND b.owner_user_id = $2
		   AND ($3 OR d.deleted_at IS NULL)
		 ORDER BY d.deleted_at NULLS FIRST, d.last_seen_at DESC NULLS LAST`, businessID, ownerID, includeDeleted)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := make([]Device, 0)
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

// SetDeviceMonitoring turns monitoring on or off for one device, but only when
// the device belongs to a business the caller owns. The ownership predicate is
// part of the UPDATE, so a caller who names a device they do not own affects no
// rows and receives ErrNotFound — indistinguishable from a device that does not
// exist, which is the correct answer to give an unauthorized caller.
//
// Turning monitoring off does not delete anything: past data stays, and the
// device keeps registering heartbeats (SyncBatch still bumps last_seen), it just
// stops contributing new activity. Turning it back on resumes ingestion from the
// next sync; the gap is real and intended.
func (s *Store) SetDeviceMonitoring(ctx context.Context, ownerID, deviceID string, enabled bool) (Device, error) {
	// disabled_at/by track when and by whom, and are cleared on re-enable, so the
	// columns answer "is it off, and since when" without a separate audit read.
	var disabledAt any
	var disabledBy any
	if !enabled {
		disabledAt = time.Now()
		disabledBy = ownerID
	}
	row := s.pool.QueryRow(ctx, `
		UPDATE devices d
		   SET monitoring_enabled = $3,
		       disabled_at = $4,
		       disabled_by = $5,
		       presence_state = CASE WHEN $3 THEN presence_state ELSE 'online' END,
		       current_app = CASE WHEN $3 THEN current_app ELSE NULL END,
		       current_window_title = CASE WHEN $3 THEN current_window_title ELSE NULL END,
		       presence_since = CASE WHEN $3 THEN presence_since ELSE EXTRACT(EPOCH FROM now())::bigint END,
		       resource_cpu_pct = CASE WHEN $3 THEN resource_cpu_pct ELSE NULL END,
		       resource_memory_used_bytes = CASE WHEN $3 THEN resource_memory_used_bytes ELSE NULL END,
		       resource_memory_total_bytes = CASE WHEN $3 THEN resource_memory_total_bytes ELSE NULL END,
		       resource_disk_used_bytes = CASE WHEN $3 THEN resource_disk_used_bytes ELSE NULL END,
		       resource_disk_total_bytes = CASE WHEN $3 THEN resource_disk_total_bytes ELSE NULL END,
		       resource_network_rx_bps = CASE WHEN $3 THEN resource_network_rx_bps ELSE NULL END,
		       resource_network_tx_bps = CASE WHEN $3 THEN resource_network_tx_bps ELSE NULL END,
		       resource_seen_at = CASE WHEN $3 THEN resource_seen_at ELSE NULL END
		  FROM businesses b
		 WHERE d.id = $1
		   AND d.business_id = b.id
		   AND b.owner_user_id = $2
		   AND d.deleted_at IS NULL
		RETURNING `+deviceReturnCols, deviceID, ownerID, enabled, disabledAt, disabledBy)

	d, err := scanDeviceReturning(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	return d, err
}

// The RETURNING form of an UPDATE ... FROM cannot reach the joined users row, so
// monitoring changes return the device with UserDisplayName/UserLogin empty.
// That is enough for the toggle's response, whose caller already has the name
// from the list it was rendered from; the next List refreshes it.
const deviceReturnCols = `d.id, d.business_id, d.user_id, d.label, d.os, d.agent_version,
	d.monitoring_enabled, d.last_seen_at, d.disabled_at, d.deleted_at`

func scanDeviceReturning(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.BusinessID, &d.UserID, &d.Label, &d.OS, &d.AgentVersion,
		&d.MonitoringEnabled, &d.LastSeenAt, &d.DisabledAt, &d.DeletedAt)
	return d, err
}

// SetDeviceArchived retires or restores a device without deleting its history.
// Archiving also disables future ingestion. Restoration intentionally keeps
// monitoring paused: the owner must explicitly enable it again, which prevents
// a restore action from unexpectedly resuming collection.
func (s *Store) SetDeviceArchived(ctx context.Context, ownerID, deviceID string, archived bool) (Device, error) {
	var deletedAt any
	var deletedBy any
	if archived {
		deletedAt = time.Now()
		deletedBy = ownerID
	}

	row := s.pool.QueryRow(ctx, `
		UPDATE devices d
		   SET deleted_at = $3,
		       deleted_by = $4,
		       monitoring_enabled = CASE WHEN $5 THEN false ELSE monitoring_enabled END,
		       disabled_at = CASE WHEN $5 AND disabled_at IS NULL THEN now() ELSE disabled_at END,
		       disabled_by = CASE WHEN $5 AND disabled_by IS NULL THEN $2::uuid ELSE disabled_by END,
		       presence_state = CASE WHEN $5 THEN 'online' ELSE presence_state END,
		       current_app = CASE WHEN $5 THEN NULL ELSE current_app END,
		       current_window_title = CASE WHEN $5 THEN NULL ELSE current_window_title END,
		       presence_since = CASE WHEN $5 THEN EXTRACT(EPOCH FROM now())::bigint ELSE presence_since END,
		       resource_cpu_pct = CASE WHEN $5 THEN NULL ELSE resource_cpu_pct END,
		       resource_memory_used_bytes = CASE WHEN $5 THEN NULL ELSE resource_memory_used_bytes END,
		       resource_memory_total_bytes = CASE WHEN $5 THEN NULL ELSE resource_memory_total_bytes END,
		       resource_disk_used_bytes = CASE WHEN $5 THEN NULL ELSE resource_disk_used_bytes END,
		       resource_disk_total_bytes = CASE WHEN $5 THEN NULL ELSE resource_disk_total_bytes END,
		       resource_network_rx_bps = CASE WHEN $5 THEN NULL ELSE resource_network_rx_bps END,
		       resource_network_tx_bps = CASE WHEN $5 THEN NULL ELSE resource_network_tx_bps END,
		       resource_seen_at = CASE WHEN $5 THEN NULL ELSE resource_seen_at END
		  FROM businesses b
		 WHERE d.id = $1
		   AND d.business_id = b.id
		   AND b.owner_user_id = $2
		RETURNING `+deviceReturnCols, deviceID, ownerID, deletedAt, deletedBy, archived)

	d, err := scanDeviceReturning(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Device{}, ErrNotFound
	}
	return d, err
}

// DeviceMonitoringAllowed is the server-side enforcement check used by capture
// paths that do not pass through SyncBatch (currently screenshot upload). An
// unknown device is allowed so a first screenshot cannot deadlock registration;
// once a device is known, both its identity and business must match.
func (s *Store) DeviceMonitoringAllowed(ctx context.Context, userID, businessID, deviceID string) (bool, error) {
	var allowed bool
	err := s.pool.QueryRow(ctx, `
		SELECT monitoring_enabled AND deleted_at IS NULL
		  FROM devices
		 WHERE id = $1 AND user_id = $2 AND business_id = $3`,
		deviceID, userID, businessID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return allowed, err
}

// RequestLiveCapture queues one frame for an online, monitored device owned by
// ownerID. Repeated web polling inside ten seconds coalesces into one request.
func (s *Store) RequestLiveCapture(ctx context.Context, ownerID, deviceID string) (LiveCaptureRequest, error) {
	var request LiveCaptureRequest
	err := s.pool.QueryRow(ctx, `
		UPDATE devices d
		   SET live_capture_requested_at = CASE
		     WHEN d.live_capture_requested_at IS NULL
		       OR d.live_capture_requested_at < now() - interval '10 seconds'
		       THEN now() ELSE d.live_capture_requested_at END
		  FROM businesses b
		 WHERE d.id = $1
		   AND d.business_id = b.id
		   AND b.owner_user_id = $2
		   AND d.deleted_at IS NULL
		   AND d.monitoring_enabled
		   AND d.presence_seen_at > now() - interval '90 seconds'
		RETURNING d.id, d.live_capture_requested_at`, deviceID, ownerID,
	).Scan(&request.DeviceID, &request.RequestedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return LiveCaptureRequest{}, ErrNotFound
	}
	return request, err
}

// ConsumeLiveCaptureRequest atomically acknowledges at most one fresh request.
// It is called after the same heartbeat authenticated this user/device pair.
func (s *Store) ConsumeLiveCaptureRequest(ctx context.Context, userID, businessID, deviceID string) (bool, error) {
	var served time.Time
	err := s.pool.QueryRow(ctx, `
		UPDATE devices
		   SET live_capture_served_at = now()
		 WHERE id = $1 AND user_id = $2 AND business_id = $3
		   AND deleted_at IS NULL AND monitoring_enabled
		   AND live_capture_requested_at > now() - interval '2 minutes'
		   AND (live_capture_served_at IS NULL
		        OR live_capture_served_at < live_capture_requested_at)
		RETURNING live_capture_served_at`, deviceID, userID, businessID,
	).Scan(&served)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// AuthorizeDeviceAgent reports whether deviceID is a live, monitored device
// belonging to userID. It is the permission check an agent passes to open its
// command stream and to push ephemeral live-view frames.
//
// Monitoring being enabled is part of the predicate on purpose: an owner who
// switches a device off must stop its live path too, not only its stored
// telemetry. Archived (soft-deleted) devices are excluded for the same reason.
func (s *Store) AuthorizeDeviceAgent(ctx context.Context, userID, deviceID string) error {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT true
		  FROM devices d
		 WHERE d.id = $1
		   AND d.user_id = $2
		   AND d.deleted_at IS NULL
		   AND d.monitoring_enabled`, deviceID, userID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// AuthorizeLiveView reports whether ownerID may watch deviceID's live screen.
// The predicate deliberately matches RequestLiveCapture's: same ownership, same
// monitoring switch, same 90-second liveness window. Live viewing must not be
// reachable through a path with weaker conditions than the one-shot capture it
// replaces.
func (s *Store) AuthorizeLiveView(ctx context.Context, ownerID, deviceID string) error {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT true
		  FROM devices d
		  JOIN businesses b ON d.business_id = b.id
		 WHERE d.id = $1
		   AND b.owner_user_id = $2
		   AND d.deleted_at IS NULL
		   AND d.monitoring_enabled
		   AND d.presence_seen_at > now() - interval '90 seconds'`, deviceID, ownerID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
