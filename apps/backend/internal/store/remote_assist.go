package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const remoteAssistActiveFor = 15 * time.Minute

// RemoteAssistSession is a short, explicitly accepted support session. Pending
// requests expire quickly; accepted sessions are capped at fifteen minutes.
type RemoteAssistSession struct {
	ID             string     `json:"id"`
	DeviceID       string     `json:"device_id"`
	BusinessID     string     `json:"business_id"`
	EmployeeUserID string     `json:"employee_user_id"`
	OwnerUserID    string     `json:"owner_user_id"`
	OwnerName      string     `json:"owner_name"`
	Status         string     `json:"status"`
	RequestedAt    time.Time  `json:"requested_at"`
	DecidedAt      *time.Time `json:"decided_at"`
	ExpiresAt      time.Time  `json:"expires_at"`
	EndedAt        *time.Time `json:"ended_at"`
	EndReason      *string    `json:"end_reason"`
	LastFrameAt    *time.Time `json:"last_frame_at"`
}

type RemoteAssistAction struct {
	ID      int64           `json:"id"`
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

const remoteSessionCols = `s.id, s.device_id, s.business_id, s.employee_user_id,
	s.owner_user_id, COALESCE(o.display_name, ''), s.status, s.requested_at,
	s.decided_at, s.expires_at, s.ended_at, s.end_reason, s.last_frame_at`

func scanRemoteSession(row pgx.Row) (RemoteAssistSession, error) {
	var session RemoteAssistSession
	err := row.Scan(
		&session.ID, &session.DeviceID, &session.BusinessID, &session.EmployeeUserID,
		&session.OwnerUserID, &session.OwnerName, &session.Status, &session.RequestedAt,
		&session.DecidedAt, &session.ExpiresAt, &session.EndedAt, &session.EndReason,
		&session.LastFrameAt,
	)
	return session, err
}

func (s *Store) expireRemoteAssist(ctx context.Context, deviceID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE remote_assist_sessions
		   SET status = 'expired', ended_at = now(), end_reason = 'timeout'
		 WHERE device_id = $1 AND status IN ('pending','active') AND expires_at <= now()`,
		deviceID,
	)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		DELETE FROM remote_assist_frames f
		 USING remote_assist_sessions s
		 WHERE f.session_id = s.id AND s.device_id = $1
		   AND s.status NOT IN ('pending','active')`, deviceID)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		DELETE FROM remote_assist_actions a
		 USING remote_assist_sessions s
		 WHERE a.session_id = s.id AND s.device_id = $1
		   AND s.status NOT IN ('pending','active')`, deviceID)
	return err
}

// CreateRemoteAssist requests assistance only for a fresh, monitored Windows
// device owned by ownerID. Activation remains authorized by the target computer.
func (s *Store) CreateRemoteAssist(ctx context.Context, ownerID, deviceID string) (RemoteAssistSession, error) {
	if err := s.expireRemoteAssist(ctx, deviceID); err != nil {
		return RemoteAssistSession{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RemoteAssistSession{}, err
	}
	defer tx.Rollback(ctx)
	row := tx.QueryRow(ctx, `
		WITH inserted AS (
			INSERT INTO remote_assist_sessions
				(device_id, business_id, employee_user_id, owner_user_id)
			SELECT d.id, d.business_id, d.user_id, $2
			  FROM devices d
			  JOIN businesses b ON b.id = d.business_id
			 WHERE d.id = $1
			   AND b.owner_user_id = $2
			   AND d.deleted_at IS NULL
			   AND d.monitoring_enabled
			   AND d.presence_seen_at > now() - interval '90 seconds'
			   AND lower(COALESCE(d.os, '')) LIKE '%windows%'
			RETURNING *
		)
		SELECT i.id, i.device_id, i.business_id, i.employee_user_id,
		       i.owner_user_id, COALESCE(o.display_name, ''), i.status,
		       i.requested_at, i.decided_at, i.expires_at, i.ended_at,
		       i.end_reason, i.last_frame_at
		  FROM inserted i JOIN users o ON o.id = i.owner_user_id`, deviceID, ownerID)
	session, err := scanRemoteSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoteAssistSession{}, ErrNotFound
	}
	if isUniqueViolation(err) {
		return RemoteAssistSession{}, ErrConflict
	}
	if err != nil {
		return RemoteAssistSession{}, err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO remote_assist_audit (session_id, actor_user_id, event)
		VALUES ($1, $2, 'requested')`, session.ID, ownerID)
	if err != nil {
		return RemoteAssistSession{}, err
	}
	return session, tx.Commit(ctx)
}

// RemoteAssistForUser returns a session only to its requesting owner or the
// employee using that device.
func (s *Store) RemoteAssistForUser(ctx context.Context, userID, sessionID string) (RemoteAssistSession, error) {
	_, err := s.pool.Exec(ctx, `
		UPDATE remote_assist_sessions
		   SET status = 'expired', ended_at = now(), end_reason = 'timeout'
		 WHERE id = $1 AND status IN ('pending','active') AND expires_at <= now()`, sessionID)
	if err != nil {
		return RemoteAssistSession{}, err
	}
	_, err = s.pool.Exec(ctx, `
		DELETE FROM remote_assist_frames WHERE session_id = $1
		  AND EXISTS (SELECT 1 FROM remote_assist_sessions
		               WHERE id = $1 AND status NOT IN ('pending','active'))`, sessionID)
	if err != nil {
		return RemoteAssistSession{}, err
	}
	session, err := scanRemoteSession(s.pool.QueryRow(ctx, `
		SELECT `+remoteSessionCols+`
		  FROM remote_assist_sessions s
		  JOIN users o ON o.id = s.owner_user_id
		 WHERE s.id = $1 AND (s.owner_user_id = $2 OR s.employee_user_id = $2)`,
		sessionID, userID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoteAssistSession{}, ErrNotFound
	}
	return session, err
}

// PendingRemoteAssist is polled by the signed-in desktop. It never exposes a
// request for another user, even if a device id is guessed.
func (s *Store) PendingRemoteAssist(ctx context.Context, employeeID, deviceID string) (*RemoteAssistSession, error) {
	if err := s.expireRemoteAssist(ctx, deviceID); err != nil {
		return nil, err
	}
	session, err := scanRemoteSession(s.pool.QueryRow(ctx, `
		SELECT `+remoteSessionCols+`
		  FROM remote_assist_sessions s
		  JOIN users o ON o.id = s.owner_user_id
		 WHERE s.device_id = $1 AND s.employee_user_id = $2
		   AND s.status = 'pending' AND s.expires_at > now()
		 ORDER BY s.requested_at DESC LIMIT 1`, deviceID, employeeID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &session, err
}

// DecideRemoteAssist records the employee's one-time accept/decline decision.
func (s *Store) DecideRemoteAssist(ctx context.Context, employeeID, sessionID string, accepted bool) (RemoteAssistSession, error) {
	status := "declined"
	endReason := any("employee_declined")
	if accepted {
		status = "active"
		endReason = nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RemoteAssistSession{}, err
	}
	defer tx.Rollback(ctx) // no-op after commit
	session, err := scanRemoteSession(tx.QueryRow(ctx, `
		UPDATE remote_assist_sessions s
		   SET status = $3,
		       decided_at = now(),
		       expires_at = CASE WHEN $3 = 'active' THEN now() + $4::interval ELSE now() END,
		       ended_at = CASE WHEN $3 = 'active' THEN NULL ELSE now() END,
		       end_reason = $5
		  FROM users o
		 WHERE s.id = $1 AND s.employee_user_id = $2
		   AND s.status = 'pending' AND s.expires_at > now()
		   AND o.id = s.owner_user_id
		RETURNING `+remoteSessionCols,
		sessionID, employeeID, status, remoteAssistActiveFor.String(), endReason,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoteAssistSession{}, ErrNotFound
	}
	if err != nil {
		return RemoteAssistSession{}, err
	}
	event := "declined"
	if accepted {
		event = "accepted"
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO remote_assist_audit (session_id, actor_user_id, event)
		VALUES ($1, $2, $3)`, sessionID, employeeID, event); err != nil {
		return RemoteAssistSession{}, err
	}
	return session, tx.Commit(ctx)
}

// EndRemoteAssist lets either participant end an active or pending session.
func (s *Store) EndRemoteAssist(ctx context.Context, actorID, sessionID string) (RemoteAssistSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RemoteAssistSession{}, err
	}
	defer tx.Rollback(ctx)
	session, err := scanRemoteSession(tx.QueryRow(ctx, `
		UPDATE remote_assist_sessions s
		   SET status = 'ended', ended_at = now(), expires_at = now(),
		       end_reason = CASE WHEN s.owner_user_id = $2 THEN 'owner_ended' ELSE 'employee_ended' END
		  FROM users o
		 WHERE s.id = $1 AND (s.owner_user_id = $2 OR s.employee_user_id = $2)
		   AND s.status IN ('pending','active') AND o.id = s.owner_user_id
		RETURNING `+remoteSessionCols, sessionID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoteAssistSession{}, ErrNotFound
	}
	if err != nil {
		return RemoteAssistSession{}, err
	}
	reason := "ended"
	if session.EndReason != nil {
		reason = *session.EndReason
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO remote_assist_audit (session_id, actor_user_id, event, metadata)
		VALUES ($1, $2, 'ended', jsonb_build_object('reason', $3::text))`,
		sessionID, actorID, reason); err != nil {
		return RemoteAssistSession{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM remote_assist_frames WHERE session_id = $1`, sessionID); err != nil {
		return RemoteAssistSession{}, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM remote_assist_actions WHERE session_id = $1`, sessionID); err != nil {
		return RemoteAssistSession{}, err
	}
	return session, tx.Commit(ctx)
}

func (s *Store) EnqueueRemoteAssistAction(ctx context.Context, ownerID, sessionID, kind string, payload json.RawMessage) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO remote_assist_actions (session_id, kind, payload)
		SELECT s.id, $3, $4
		  FROM remote_assist_sessions s
		 WHERE s.id = $1 AND s.owner_user_id = $2
		   AND s.status = 'active' AND s.expires_at > now()
		RETURNING id`, sessionID, ownerID, kind, payload).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// ConsumeRemoteAssistActions atomically hands the employee agent each queued
// action once. Old actions are ignored so reconnecting cannot replay clicks.
func (s *Store) ConsumeRemoteAssistActions(ctx context.Context, employeeID, sessionID string, afterID int64) ([]RemoteAssistAction, error) {
	rows, err := s.pool.Query(ctx, `
		WITH picked AS (
			SELECT a.id
			  FROM remote_assist_actions a
			  JOIN remote_assist_sessions s ON s.id = a.session_id
			 WHERE a.session_id = $1 AND s.employee_user_id = $2
			   AND s.status = 'active' AND s.expires_at > now()
			   AND a.id > $3 AND a.consumed_at IS NULL
			   AND a.created_at > now() - interval '10 seconds'
			 ORDER BY a.id LIMIT 64
			 FOR UPDATE OF a SKIP LOCKED
		)
		UPDATE remote_assist_actions a
		   SET consumed_at = now()
		  FROM picked p
		 WHERE a.id = p.id
		RETURNING a.id, a.kind, a.payload`, sessionID, employeeID, afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	actions := make([]RemoteAssistAction, 0)
	for rows.Next() {
		var action RemoteAssistAction
		if err := rows.Scan(&action.ID, &action.Kind, &action.Payload); err != nil {
			return nil, err
		}
		actions = append(actions, action)
	}
	return actions, rows.Err()
}

// AuthorizeRemoteAssistFrame reports whether sessionID is an active, unexpired
// session belonging to employeeID. It is the permission check for the live
// frame path; the frame bytes themselves never reach Postgres (see
// internal/live and docs/adr/0001-ephemeral-live-frames.md). This is a
// SELECT-only statement so it produces no WAL and no table churn per frame.
func (s *Store) AuthorizeRemoteAssistFrame(ctx context.Context, employeeID, sessionID string) error {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT true
		  FROM remote_assist_sessions s
		 WHERE s.id = $1 AND s.employee_user_id = $2
		   AND s.status = 'active' AND s.expires_at > now()`,
		sessionID, employeeID,
	).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// AuthorizeRemoteAssistViewer reports whether sessionID is an active, unexpired
// session owned by ownerID, i.e. whether this admin may watch it.
func (s *Store) AuthorizeRemoteAssistViewer(ctx context.Context, ownerID, sessionID string) error {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT true
		  FROM remote_assist_sessions s
		 WHERE s.id = $1 AND s.owner_user_id = $2
		   AND s.status = 'active' AND s.expires_at > now()`,
		sessionID, ownerID,
	).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// MarkRemoteAssistFrameAt records that frames are flowing for this session.
// Callers throttle it (see live.Hub.ShouldPersist) so it runs on the order of
// once per 10s rather than once per frame.
func (s *Store) MarkRemoteAssistFrameAt(ctx context.Context, employeeID, sessionID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE remote_assist_sessions SET last_frame_at = now()
		 WHERE id = $1 AND employee_user_id = $2 AND status = 'active'`, sessionID, employeeID)
	return err
}
