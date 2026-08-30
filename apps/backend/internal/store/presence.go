package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const PresenceOfflineAfter = 90 * time.Second

// Presence is the newest heartbeat for one employee. App/window are nullable
// because a paused device still reports that it is online without reporting
// foreground-work metadata.
type Presence struct {
	DeviceID    *string `json:"device_id"`
	State       string  `json:"state"`
	App         *string `json:"app"`
	WindowTitle *string `json:"window_title"`
	Since       *int64  `json:"since"`
	SeenAt      *int64  `json:"seen_at"`
}

// UpdatePresence records one employee-authenticated heartbeat. A UUID already
// registered to another user/business cannot be claimed by this request.
// Monitoring-disabled devices remain visible as online, but foreground app and
// window metadata are discarded server-side.
func (s *Store) UpdatePresence(
	ctx context.Context,
	userID, businessID, deviceID, state string,
	app, windowTitle *string,
	since int64,
) (bool, error) {
	var enabled bool
	err := s.pool.QueryRow(ctx, `
		INSERT INTO devices
		  (id, user_id, business_id, last_seen_at, presence_state, current_app,
		   current_window_title, presence_since, presence_seen_at)
		VALUES ($1, $2, $3, now(), $4, $5, $6, $7, now())
		ON CONFLICT (id) DO UPDATE SET
		  last_seen_at = now(),
		  presence_state = CASE
		    WHEN devices.monitoring_enabled AND devices.deleted_at IS NULL
		      THEN EXCLUDED.presence_state ELSE 'online' END,
		  current_app = CASE
		    WHEN devices.monitoring_enabled AND devices.deleted_at IS NULL
		      THEN EXCLUDED.current_app ELSE NULL END,
		  current_window_title = CASE
		    WHEN devices.monitoring_enabled AND devices.deleted_at IS NULL
		      THEN EXCLUDED.current_window_title ELSE NULL END,
		  presence_since = CASE
		    WHEN devices.monitoring_enabled AND devices.deleted_at IS NULL
		      AND (devices.presence_state IS DISTINCT FROM EXCLUDED.presence_state
		        OR devices.current_app IS DISTINCT FROM EXCLUDED.current_app
		        OR devices.current_window_title IS DISTINCT FROM EXCLUDED.current_window_title)
		      THEN EXCLUDED.presence_since
		    WHEN (NOT devices.monitoring_enabled OR devices.deleted_at IS NOT NULL)
		      AND devices.presence_state IS DISTINCT FROM 'online'
		      THEN EXCLUDED.presence_since
		    ELSE devices.presence_since END,
		  presence_seen_at = now()
		WHERE devices.user_id = EXCLUDED.user_id
		  AND devices.business_id = EXCLUDED.business_id
		RETURNING monitoring_enabled AND deleted_at IS NULL`,
		deviceID, userID, businessID, state, app, windowTitle, since,
	).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrForbidden
	}
	return enabled, err
}

// PresenceForOwner returns the freshest device heartbeat for an employee that
// belongs to one of the caller's businesses. A stale or missing heartbeat is an
// honest offline response and never reuses the last app as if it were current.
func (s *Store) PresenceForOwner(ctx context.Context, ownerID, employeeID string) (Presence, error) {
	owned, err := s.OwnsEmployee(ctx, ownerID, employeeID)
	if err != nil {
		return Presence{}, err
	}
	if !owned {
		return Presence{}, ErrForbidden
	}

	var p Presence
	var seen time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT d.id, d.presence_state, d.current_app, d.current_window_title,
		       d.presence_since, d.presence_seen_at
		  FROM devices d
		  JOIN businesses b ON b.id = d.business_id
		 WHERE d.user_id = $1
		   AND b.owner_user_id = $2
		   AND d.deleted_at IS NULL
		   AND d.presence_seen_at IS NOT NULL
		 ORDER BY d.presence_seen_at DESC
		 LIMIT 1`, employeeID, ownerID,
	).Scan(&p.DeviceID, &p.State, &p.App, &p.WindowTitle, &p.Since, &seen)
	if errors.Is(err, pgx.ErrNoRows) {
		return Presence{State: "offline"}, nil
	}
	if err != nil {
		return Presence{}, err
	}
	seenUnix := seen.Unix()
	p.SeenAt = &seenUnix
	if time.Since(seen) > PresenceOfflineAfter {
		return Presence{DeviceID: p.DeviceID, State: "offline", SeenAt: p.SeenAt}, nil
	}
	return p, nil
}
