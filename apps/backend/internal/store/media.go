package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"ctracking/backend/internal/media"

	"github.com/jackc/pgx/v5"
)

// Tenant isolation in this file is done in SQL, on every statement, not by
// checking an id in Go afterwards. A query that returns a row the caller may not
// see has already leaked it -- that a handler then discards it is luck, not a
// boundary. Every statement here joins through memberships or businesses so the
// database itself cannot return another tenant's session.

// MediaDeviceTarget is the device a media session would be opened against, with
// everything needed to decide whether that is allowed.
type MediaDeviceTarget struct {
	DeviceID   string
	BusinessID string
	// EmployeeID is the user the device belongs to. Empty when the device is
	// enrolled but unassigned.
	EmployeeID        string
	MonitoringEnabled bool
	// Online is presence within the same 90-second window the rest of the
	// system uses, so "offline" means the same thing everywhere.
	Online bool
}

// MediaDeviceTargetFor resolves a device for a caller who must be a member of
// its business. Returns ErrNotFound when the device does not exist, is archived,
// or belongs to a business the caller is not a member of -- deliberately the same
// error for all three, so this cannot be used to probe which devices exist.
func (s *Store) MediaDeviceTargetFor(ctx context.Context, userID, deviceID string) (MediaDeviceTarget, error) {
	var out MediaDeviceTarget
	var employeeID *string
	err := s.pool.QueryRow(ctx, `
		SELECT d.id, d.business_id, d.user_id, d.monitoring_enabled,
		       -- COALESCE, not a bare comparison: a device that has enrolled but
		       -- never sent a heartbeat has a NULL presence_seen_at, and NULL is
		       -- not false in SQL. Without this, the very first live request
		       -- against a freshly enrolled device fails to scan.
		       COALESCE(d.presence_seen_at > now() - interval '90 seconds', false) AS online
		  FROM devices d
		  JOIN memberships m ON m.business_id = d.business_id AND m.user_id = $1
		 WHERE d.id = $2
		   AND d.deleted_at IS NULL`, userID, deviceID).
		Scan(&out.DeviceID, &out.BusinessID, &employeeID, &out.MonitoringEnabled, &out.Online)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaDeviceTarget{}, ErrNotFound
	}
	if err != nil {
		return MediaDeviceTarget{}, err
	}
	if employeeID != nil {
		out.EmployeeID = *employeeID
	}
	return out, nil
}

// MediaRoleFor returns the caller's membership role in a business, which is what
// resolves to a permission set. ErrNotFound when they are not a member.
func (s *Store) MediaRoleFor(ctx context.Context, userID, businessID string) (string, error) {
	var role string
	err := s.pool.QueryRow(ctx, `
		SELECT role FROM memberships WHERE user_id = $1 AND business_id = $2`,
		userID, businessID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

// MediaSession is one row of media_sessions.
type MediaSession struct {
	ID             string          `json:"id"`
	BusinessID     string          `json:"business_id"`
	EmployeeID     string          `json:"employee_id,omitempty"`
	DeviceID       string          `json:"device_id"`
	Kind           media.Kind      `json:"kind"`
	State          media.State     `json:"state"`
	Provider       string          `json:"provider"`
	PolicySnapshot json.RawMessage `json:"policy_snapshot,omitempty"`
	StartedAt      time.Time       `json:"started_at"`
	EndedAt        *time.Time      `json:"ended_at,omitempty"`
	FailureCode    string          `json:"failure_code,omitempty"`
	CreatedBy      string          `json:"created_by,omitempty"`

	// ProviderRoomID is the opaque room name. It is NOT serialized to API
	// clients: a viewer needs a token, not a room name, and handing out room
	// names invites someone to try joining one directly.
	ProviderRoomID string `json:"-"`
}

// NewMediaSession is the input to CreateMediaSession.
type NewMediaSession struct {
	BusinessID     string
	EmployeeID     string
	DeviceID       string
	Kind           media.Kind
	Provider       string
	ProviderRoomID string
	PolicySnapshot json.RawMessage
	CreatedBy      string
}

// Every query below aliases media_sessions as `ms`, so one column list serves
// both the plain and the joined statements.
const mediaSessionColumns = `
	ms.id, ms.business_id, ms.employee_id, ms.device_id, ms.kind, ms.state, ms.provider,
	ms.provider_room_id, ms.policy_snapshot, ms.started_at, ms.ended_at, ms.failure_code,
	ms.created_by`

func scanMediaSession(row pgx.Row) (MediaSession, error) {
	var m MediaSession
	var employeeID, failureCode, createdBy *string
	err := row.Scan(&m.ID, &m.BusinessID, &employeeID, &m.DeviceID, &m.Kind, &m.State,
		&m.Provider, &m.ProviderRoomID, &m.PolicySnapshot, &m.StartedAt, &m.EndedAt,
		&failureCode, &createdBy)
	if err != nil {
		return MediaSession{}, err
	}
	if employeeID != nil {
		m.EmployeeID = *employeeID
	}
	if failureCode != nil {
		m.FailureCode = *failureCode
	}
	if createdBy != nil {
		m.CreatedBy = *createdBy
	}
	return m, nil
}

// OpenMediaSession returns the device's existing open session of this kind, or
// creates one.
//
// Two viewers opening the same device must land on the same session rather than
// racing to create two: a second session would make the agent publish twice, and
// would make "who watched this session" unanswerable. The partial unique index
// is what makes that safe under concurrency -- the loser of the race reads the
// winner's row instead of failing.
//
// The bool reports whether a session was created, which is what decides between
// a "started" and a "joined" audit event.
func (s *Store) OpenMediaSession(ctx context.Context, in NewMediaSession) (MediaSession, bool, error) {
	if len(in.PolicySnapshot) == 0 {
		in.PolicySnapshot = json.RawMessage(`{}`)
	}
	existing, err := s.openMediaSessionFor(ctx, in.DeviceID, in.Kind)
	if err == nil {
		return existing, false, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return MediaSession{}, false, err
	}

	row := s.pool.QueryRow(ctx, `
		INSERT INTO media_sessions
			(business_id, employee_id, device_id, kind, state, provider,
			 provider_room_id, policy_snapshot, created_by)
		VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, $8)
		RETURNING`+unaliased(mediaSessionColumns),
		in.BusinessID, nullableID(in.EmployeeID), in.DeviceID, in.Kind, in.Provider,
		in.ProviderRoomID, in.PolicySnapshot, nullableID(in.CreatedBy))
	created, err := scanMediaSession(row)
	if isUniqueViolation(err) {
		// Lost the race: another request created the session between our read
		// and our insert. Return theirs.
		existing, readErr := s.openMediaSessionFor(ctx, in.DeviceID, in.Kind)
		if readErr != nil {
			return MediaSession{}, false, readErr
		}
		return existing, false, nil
	}
	if err != nil {
		return MediaSession{}, false, err
	}
	return created, true, nil
}

func (s *Store) openMediaSessionFor(ctx context.Context, deviceID string, kind media.Kind) (MediaSession, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT`+mediaSessionColumns+`
		  FROM media_sessions ms
		 WHERE ms.device_id = $1 AND ms.kind = $2 AND ms.state NOT IN ('ended','failed')`,
		deviceID, kind)
	m, err := scanMediaSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaSession{}, ErrNotFound
	}
	return m, err
}

// MediaSessionForMember reads a session, scoped to a business the caller belongs
// to. A caller outside the tenant gets ErrNotFound, which is the same answer they
// get for a session that does not exist: the API must not confirm that another
// tenant's session id is real.
func (s *Store) MediaSessionForMember(ctx context.Context, userID, sessionID string) (MediaSession, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT`+mediaSessionColumns+`
		  FROM media_sessions ms
		  JOIN memberships m ON m.business_id = ms.business_id AND m.user_id = $1
		 WHERE ms.id = $2`, userID, sessionID)
	m, err := scanMediaSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaSession{}, ErrNotFound
	}
	return m, err
}

// MediaSessionForAgent reads a session on behalf of the device that is being
// captured.
//
// The predicate is the whole point: the session's device must belong to the
// authenticated agent's own user. An agent holding a valid token for device A
// cannot mint a publisher token for device B, because device B's rows do not
// match its user id.
func (s *Store) MediaSessionForAgent(ctx context.Context, agentUserID, sessionID string) (MediaSession, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT`+mediaSessionColumns+`
		  FROM media_sessions ms
		  JOIN devices d ON d.id = ms.device_id AND d.business_id = ms.business_id
		  JOIN memberships member ON member.business_id = d.business_id AND member.user_id = d.user_id
		 WHERE ms.id = $1
		   AND d.user_id = $2
		   AND d.deleted_at IS NULL
		   AND d.monitoring_enabled`, sessionID, agentUserID)
	m, err := scanMediaSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaSession{}, ErrNotFound
	}
	return m, err
}

// PendingMediaSessionForAgent resolves demand through the enrolled device and
// current membership. Caller-supplied business/user pairs are never trusted.
func (s *Store) PendingMediaSessionForAgent(ctx context.Context, userID, deviceID string) (MediaSession, error) {
	row := s.pool.QueryRow(ctx, `SELECT`+mediaSessionColumns+`
	  FROM media_sessions ms
	  JOIN devices d ON d.id = ms.device_id AND d.business_id = ms.business_id
	  JOIN memberships member ON member.business_id = d.business_id AND member.user_id = d.user_id
	 WHERE d.user_id = $1 AND d.id = $2 AND d.deleted_at IS NULL
	   AND d.monitoring_enabled AND ms.kind = 'live'
	   AND ms.state IN ('waiting_for_agent','negotiating','live','reconnecting')
	 ORDER BY ms.started_at DESC LIMIT 1`, userID, deviceID)
	m, err := scanMediaSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaSession{}, ErrNotFound
	}
	return m, err
}

// AdvanceMediaSession moves a session to a new state, refusing an illegal
// transition. The state machine is checked against the row as it is in the
// database, inside the same statement's read, so two concurrent callers cannot
// both believe they made a legal move from the same starting state.
func (s *Store) AdvanceMediaSession(ctx context.Context, sessionID string, to media.State, failure media.FailureCode) (MediaSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MediaSession{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var current media.State
	err = tx.QueryRow(ctx,
		`SELECT state FROM media_sessions WHERE id = $1 FOR UPDATE`, sessionID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return MediaSession{}, ErrNotFound
	}
	if err != nil {
		return MediaSession{}, err
	}
	if err := media.Transition(current, to); err != nil {
		return MediaSession{}, err
	}

	var endedAt *time.Time
	if to.Terminal() {
		now := time.Now().UTC()
		endedAt = &now
	}
	var code *string
	if to == media.StateFailed && failure != "" {
		v := string(failure)
		code = &v
	}

	row := tx.QueryRow(ctx, `
		UPDATE media_sessions ms
		   SET state = $2,
		       ended_at = CASE WHEN $3::timestamptz IS NOT NULL THEN $3 ELSE ended_at END,
		       failure_code = $4
		 WHERE ms.id = $1
		RETURNING`+mediaSessionColumns, sessionID, to, endedAt, code)
	updated, err := scanMediaSession(row)
	if err != nil {
		return MediaSession{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return MediaSession{}, err
	}
	return updated, nil
}

// JoinViewerSession records that a viewer attached, closing any row they left
// open on the same session first. Reconnecting must not accumulate open rows, or
// "who is watching now" becomes a count of reconnections.
func (s *Store) JoinViewerSession(ctx context.Context, sessionID, businessID, viewerID string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE viewer_sessions
		   SET left_at = now(), end_reason = 'superseded'
		 WHERE media_session_id = $1 AND viewer_user_id = $2 AND left_at IS NULL`,
		sessionID, viewerID); err != nil {
		return "", err
	}

	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO viewer_sessions (business_id, media_session_id, viewer_user_id)
		VALUES ($1, $2, $3) RETURNING id`, businessID, sessionID, viewerID).Scan(&id); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// LeaveViewerSession closes a viewer's open row. A viewer with no open row is
// not an error: a duplicate stop, or a stop after a timeout already closed it,
// is a normal thing for a client to send.
func (s *Store) LeaveViewerSession(ctx context.Context, sessionID, viewerID, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE viewer_sessions
		   SET left_at = now(), end_reason = $3
		 WHERE media_session_id = $1 AND viewer_user_id = $2 AND left_at IS NULL`,
		sessionID, viewerID, reason)
	return err
}

// ActiveViewerCount reports how many viewers are attached. This is what decides
// whether a session still has a reason to exist.
func (s *Store) ActiveViewerCount(ctx context.Context, sessionID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM viewer_sessions
		 WHERE media_session_id = $1 AND left_at IS NULL`, sessionID).Scan(&n)
	return n, err
}

// MediaAuditEvent is one row of the media audit trail.
type MediaAuditEvent struct {
	BusinessID     string
	MediaSessionID string
	ActorType      string
	ActorID        string
	Action         string
	Outcome        string
	Metadata       map[string]any
}

// Audit actions. Named constants rather than strings at the call site, so the
// trail cannot be made unqueryable by a typo.
const (
	AuditLiveSessionStart   = "live_session.start"
	AuditLiveSessionJoin    = "live_session.join"
	AuditLiveSessionLeave   = "live_session.leave"
	AuditLiveSessionStop    = "live_session.stop"
	AuditViewerTokenMint    = "viewer_token.mint"
	AuditPublisherTokenMint = "publisher_token.mint"
	AuditSessionRead        = "media_session.read"
	AuditAgentState         = "agent.state"
)

// Audit outcomes.
const (
	OutcomeAllowed = "allowed"
	OutcomeDenied  = "denied"
	OutcomeError   = "error"
)

// RecordMediaAudit appends to the audit trail.
//
// Denials are recorded as deliberately as successes: "nobody watched this
// employee" and "somebody tried and was refused" are different facts, and only
// one of them is visible if failures go unrecorded.
//
// Metadata must never carry a token, an SDP, a signed URL, or a credential.
func (s *Store) RecordMediaAudit(ctx context.Context, e MediaAuditEvent) error {
	metadata := e.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO media_audit_events
			(business_id, media_session_id, actor_type, actor_id, action, outcome, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		e.BusinessID, nullableID(e.MediaSessionID), e.ActorType, e.ActorID,
		e.Action, e.Outcome, encoded)
	return err
}

// MediaAuditForSession reads a session's audit trail, scoped to the caller's
// tenant.
func (s *Store) MediaAuditForSession(ctx context.Context, userID, sessionID string) ([]MediaAuditEvent, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.business_id, a.actor_type, a.actor_id, a.action, a.outcome, a.metadata
		  FROM media_audit_events a
		  JOIN memberships m ON m.business_id = a.business_id AND m.user_id = $1
		 WHERE a.media_session_id = $2
		 ORDER BY a.occurred_at`, userID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MediaAuditEvent
	for rows.Next() {
		var e MediaAuditEvent
		var raw []byte
		if err := rows.Scan(&e.BusinessID, &e.ActorType, &e.ActorID, &e.Action, &e.Outcome, &raw); err != nil {
			return nil, err
		}
		e.MediaSessionID = sessionID
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &e.Metadata)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// NewMediaTrack describes a published track.
type NewMediaTrack struct {
	BusinessID     string
	MediaSessionID string
	Source         media.TrackSource
	Codec          string
	Width          int
	Height         int
	NominalFPS     float64
}

// RecordMediaTrack records what a publisher is sending.
//
// Re-reporting the same source replaces the row rather than adding one: a
// publisher that reconnects and reports again is describing the same track, and
// a second row would make a single screen look like two displays.
func (s *Store) RecordMediaTrack(ctx context.Context, t NewMediaTrack) error {
	if t.Codec == "" {
		t.Codec = "unknown"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO media_tracks
			(business_id, media_session_id, source, codec, width, height, nominal_fps)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (media_session_id, source) DO UPDATE
		   SET codec = EXCLUDED.codec,
		       width = EXCLUDED.width,
		       height = EXCLUDED.height,
		       nominal_fps = EXCLUDED.nominal_fps,
		       ended_at = NULL`,
		t.BusinessID, t.MediaSessionID, t.Source, t.Codec,
		nullablePositive(t.Width), nullablePositive(t.Height), nullablePositiveFloat(t.NominalFPS))
	return err
}

// MediaTracksFor lists a session's tracks, scoped to the caller's tenant.
func (s *Store) MediaTracksFor(ctx context.Context, userID, sessionID string) ([]NewMediaTrack, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.business_id, t.media_session_id, t.source, t.codec,
		       COALESCE(t.width, 0), COALESCE(t.height, 0), COALESCE(t.nominal_fps, 0)
		  FROM media_tracks t
		  JOIN memberships m ON m.business_id = t.business_id AND m.user_id = $1
		 WHERE t.media_session_id = $2
		 ORDER BY t.source`, userID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []NewMediaTrack
	for rows.Next() {
		var t NewMediaTrack
		if err := rows.Scan(&t.BusinessID, &t.MediaSessionID, &t.Source, &t.Codec,
			&t.Width, &t.Height, &t.NominalFPS); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// nullablePositive turns a non-positive dimension into NULL. The column has a
// CHECK for positivity, so "unknown" has to be absent rather than zero.
func nullablePositive(v int) any {
	if v <= 0 {
		return nil
	}
	return v
}

func nullablePositiveFloat(v float64) any {
	if v <= 0 {
		return nil
	}
	return v
}

// MediaAuditForBusiness reads a business's recent media audit trail, scoped to
// the caller's tenant. This is the read behind the media_audit.view permission,
// and it is the only way to see denials: a refusal that never reached a session
// has no session id to be found under.
func (s *Store) MediaAuditForBusiness(ctx context.Context, userID, businessID string, limit int) ([]MediaAuditEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.business_id, a.media_session_id, a.actor_type, a.actor_id,
		       a.action, a.outcome, a.metadata
		  FROM media_audit_events a
		  JOIN memberships m ON m.business_id = a.business_id AND m.user_id = $1
		 WHERE a.business_id = $2
		 ORDER BY a.occurred_at DESC
		 LIMIT $3`, userID, businessID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MediaAuditEvent
	for rows.Next() {
		var e MediaAuditEvent
		var sessionID *string
		var raw []byte
		if err := rows.Scan(&e.BusinessID, &sessionID, &e.ActorType, &e.ActorID,
			&e.Action, &e.Outcome, &raw); err != nil {
			return nil, err
		}
		if sessionID != nil {
			e.MediaSessionID = *sessionID
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &e.Metadata)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// nullableID turns an empty id into a NULL so an optional uuid column does not
// receive the empty string, which Postgres rejects as a malformed uuid.
func nullableID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

// unaliased strips the `ms.` qualifier for statements where the table cannot be
// aliased -- INSERT ... RETURNING, which has no FROM clause to attach an alias to.
func unaliased(columns string) string {
	return strings.ReplaceAll(columns, "ms.", "")
}
