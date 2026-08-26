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
	// The person who owns/uses the device, joined for display. Not a device
	// column — the inventory is far more legible with a name than a user UUID.
	UserDisplayName string `json:"user_display_name"`
	UserLogin       string `json:"user_login"`
}

const deviceCols = `d.id, d.business_id, d.user_id, d.label, d.os, d.agent_version,
	d.monitoring_enabled, d.last_seen_at, d.disabled_at,
	COALESCE(u.display_name, ''), COALESCE(u.email, u.username, '')`

func scanDevice(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.BusinessID, &d.UserID, &d.Label, &d.OS, &d.AgentVersion,
		&d.MonitoringEnabled, &d.LastSeenAt, &d.DisabledAt, &d.UserDisplayName, &d.UserLogin)
	return d, err
}

// ListDevices returns every device belonging to a business the caller owns,
// newest-seen first. Ownership is enforced in the query: a device is returned
// only when its business_id names a business whose owner_user_id is the caller,
// so passing another owner's business id yields an empty list, never their
// devices.
func (s *Store) ListDevices(ctx context.Context, ownerID, businessID string) ([]Device, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+deviceCols+`
		  FROM devices d
		  JOIN businesses b ON b.id = d.business_id
		  JOIN users u ON u.id = d.user_id
		 WHERE d.business_id = $1
		   AND b.owner_user_id = $2
		 ORDER BY d.last_seen_at DESC NULLS LAST`, businessID, ownerID)
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
		       disabled_by = $5
		  FROM businesses b
		 WHERE d.id = $1
		   AND d.business_id = b.id
		   AND b.owner_user_id = $2
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
	d.monitoring_enabled, d.last_seen_at, d.disabled_at`

func scanDeviceReturning(row pgx.Row) (Device, error) {
	var d Device
	err := row.Scan(&d.ID, &d.BusinessID, &d.UserID, &d.Label, &d.OS, &d.AgentVersion,
		&d.MonitoringEnabled, &d.LastSeenAt, &d.DisabledAt)
	return d, err
}
