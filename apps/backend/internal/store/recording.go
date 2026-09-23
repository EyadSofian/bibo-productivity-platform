package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// RecordingAsset is metadata for one independently seekable video chunk.
// ManifestKey is intentionally hidden from JSON; clients receive a short-lived
// signed URL instead of the private object-store key.
type RecordingAsset struct {
	ID                  string     `json:"id"`
	BusinessID          string     `json:"business_id"`
	MediaSessionID      string     `json:"media_session_id"`
	EmployeeID          string     `json:"employee_id"`
	DeviceID            string     `json:"device_id"`
	Status              string     `json:"status"`
	Format              string     `json:"format"`
	StorageProvider     string     `json:"storage_provider"`
	ProviderRecordingID string     `json:"-"`
	ManifestKey         string     `json:"-"`
	DurationMS          int64      `json:"duration_ms"`
	ByteSize            int64      `json:"byte_size"`
	StartedAt           time.Time  `json:"started_at"`
	EndedAt             *time.Time `json:"ended_at,omitempty"`
	RetentionUntil      *time.Time `json:"retention_until,omitempty"`
}

// RecordingRecoveryCandidate is the minimum metadata needed to resume a
// finalization interrupted by a backend restart.
type RecordingRecoveryCandidate struct {
	ID                  string
	ManifestKey         string
	ProviderRecordingID string
	Status              string
	EndedAt             time.Time
}

type RecordingSummary struct {
	Ready      int64                  `json:"ready"`
	Recording  int64                  `json:"recording"`
	Processing int64                  `json:"processing"`
	Failed     int64                  `json:"failed"`
	Stale      int64                  `json:"stale"`
	Recent     []RecordingSummaryItem `json:"recent"`
}

type RecordingSummaryItem struct {
	ID             string     `json:"id"`
	EmployeeID     string     `json:"employee_id"`
	EmployeeName   string     `json:"employee_name"`
	Status         string     `json:"status"`
	FailureCode    string     `json:"failure_code"`
	ByteSize       int64      `json:"byte_size"`
	StartedAt      time.Time  `json:"started_at"`
	EndedAt        *time.Time `json:"ended_at,omitempty"`
	RetentionUntil *time.Time `json:"retention_until,omitempty"`
}

const recordingColumns = `
	ra.id, ra.business_id, ra.media_session_id, ms.employee_id, ms.device_id,
	ra.status, ra.format, ra.storage_provider, ra.manifest_key,
	ra.provider_recording_id, ra.duration_ms, ra.byte_size,
	ra.started_at, ra.ended_at, ra.retention_until`

func scanRecording(row pgx.Row) (RecordingAsset, error) {
	var a RecordingAsset
	var employeeID, providerID *string
	err := row.Scan(&a.ID, &a.BusinessID, &a.MediaSessionID, &employeeID, &a.DeviceID,
		&a.Status, &a.Format, &a.StorageProvider, &a.ManifestKey, &providerID,
		&a.DurationMS, &a.ByteSize, &a.StartedAt, &a.EndedAt, &a.RetentionUntil)
	if employeeID != nil {
		a.EmployeeID = *employeeID
	}
	if providerID != nil {
		a.ProviderRecordingID = *providerID
	}
	return a, err
}

func (s *Store) CreateRecordingAsset(ctx context.Context, session MediaSession, objectKey, storageProvider string) (RecordingAsset, error) {
	row := s.pool.QueryRow(ctx, `
		INSERT INTO recording_assets
			(business_id, media_session_id, storage_provider, manifest_key, started_at)
		VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (media_session_id) DO UPDATE SET media_session_id=EXCLUDED.media_session_id
		RETURNING id`, session.BusinessID, session.ID, storageProvider, objectKey)
	var id string
	if err := row.Scan(&id); err != nil {
		return RecordingAsset{}, err
	}
	return s.RecordingAssetForSession(ctx, session.ID)
}

func (s *Store) RecordingAssetForSession(ctx context.Context, sessionID string) (RecordingAsset, error) {
	a, err := scanRecording(s.pool.QueryRow(ctx, `SELECT `+recordingColumns+`
		FROM recording_assets ra JOIN media_sessions ms ON ms.id=ra.media_session_id
		WHERE ra.media_session_id=$1`, sessionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordingAsset{}, ErrNotFound
	}
	return a, err
}

func (s *Store) StartRecordingAsset(ctx context.Context, assetID, providerID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE recording_assets
		SET status='recording', provider_recording_id=$2 WHERE id=$1`, assetID, providerID)
	return err
}

func (s *Store) ProcessRecordingAsset(ctx context.Context, assetID string, endedAt time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE recording_assets
		SET status='processing',
		    ended_at=$2, duration_ms=GREATEST(0, extract(epoch FROM ($2-started_at))*1000)::bigint
		WHERE id=$1 AND status IN ('pending','recording','processing')`, assetID, endedAt)
	return err
}

func (s *Store) ReadyRecordingAsset(ctx context.Context, assetID string, byteSize int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE recording_assets
		SET status='ready', byte_size=$2,
		    retention_until=COALESCE(ended_at,now()) + interval '30 days'
		WHERE id=$1 AND status IN ('processing','recording','pending','failed')
		  AND (retention_until IS NULL OR retention_until > now())`, assetID, byteSize)
	return err
}

func (s *Store) FailRecordingAsset(ctx context.Context, assetID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE recording_assets
		SET status='failed', ended_at=COALESCE(ended_at,now()),
		    retention_until=COALESCE(ended_at,now()) + interval '30 days',
		    duration_ms=GREATEST(0, extract(epoch FROM (COALESCE(ended_at,now())-started_at))*1000)::bigint
		WHERE id=$1 AND status IN ('pending','recording','processing')`, assetID)
	return err
}

// RecordingAssetsNeedingRecovery includes unfinished assets whose original
// finalizer may have vanished with a process restart. It is bounded per sweep.
func (s *Store) RecordingAssetsNeedingRecovery(ctx context.Context, limit int) ([]RecordingRecoveryCandidate, error) {
	rows, err := s.pool.Query(ctx, `
		WITH selected AS (
			SELECT ra.id FROM recording_assets ra
			JOIN media_sessions ms ON ms.id=ra.media_session_id
			WHERE (ra.status='processing'
			   OR (ra.status IN ('pending','recording') AND ms.state IN ('ended','failed')))
			  AND (ra.last_checked_at IS NULL OR ra.last_checked_at < now()-interval '1 minute')
			ORDER BY ra.last_checked_at NULLS FIRST, COALESCE(ra.ended_at, ms.ended_at, ra.started_at)
			LIMIT $1 FOR UPDATE OF ra SKIP LOCKED
		), claimed AS (
			UPDATE recording_assets ra SET last_checked_at=now()
			FROM selected WHERE ra.id=selected.id
			RETURNING ra.id,ra.manifest_key,ra.provider_recording_id,ra.status,ra.ended_at,ra.media_session_id
		)
		SELECT claimed.id, claimed.manifest_key, COALESCE(claimed.provider_recording_id,''),
		       claimed.status, COALESCE(claimed.ended_at, ms.ended_at, now())
		FROM claimed JOIN media_sessions ms ON ms.id=claimed.media_session_id`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecordingRecoveryCandidate{}
	for rows.Next() {
		var item RecordingRecoveryCandidate
		if err := rows.Scan(&item.ID, &item.ManifestKey, &item.ProviderRecordingID, &item.Status, &item.EndedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) RecordingAssetsDueForDeletion(ctx context.Context, limit int) ([]RecordingRecoveryCandidate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, manifest_key FROM recording_assets
		 WHERE status IN ('ready','failed') AND retention_until <= now()
		 ORDER BY retention_until LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecordingRecoveryCandidate{}
	for rows.Next() {
		var item RecordingRecoveryCandidate
		if err := rows.Scan(&item.ID, &item.ManifestKey); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) MarkRecordingAssetDeleted(ctx context.Context, assetID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE recording_assets SET status='deleted'
		WHERE id=$1 AND status IN ('ready','failed') AND retention_until <= now()`, assetID)
	return err
}

// RecordingSummaryForBusiness is one bounded overview query plus the latest
// handful of rows; the dashboard never calls the per-employee list N times.
func (s *Store) RecordingSummaryForBusiness(ctx context.Context, businessID string, since time.Time) (RecordingSummary, error) {
	var out RecordingSummary
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE status='ready'),
		       count(*) FILTER (WHERE status='recording'),
		       count(*) FILTER (WHERE status='processing'),
		       count(*) FILTER (WHERE status='failed'),
		       count(*) FILTER (WHERE status='processing' AND ended_at < now()-interval '45 minutes')
		  FROM recording_assets
		 WHERE business_id=$1 AND started_at >= $2`, businessID, since).Scan(
		&out.Ready, &out.Recording, &out.Processing, &out.Failed, &out.Stale)
	if err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT ra.id, COALESCE(ms.employee_id::text,''), COALESCE(u.display_name,''),
		       ra.status, COALESCE(ms.failure_code,''), ra.byte_size,
		       ra.started_at, ra.ended_at, ra.retention_until
		  FROM recording_assets ra
		  JOIN media_sessions ms ON ms.id=ra.media_session_id
		  LEFT JOIN users u ON u.id=ms.employee_id
		 WHERE ra.business_id=$1 AND ra.status <> 'deleted' AND ra.started_at >= $2
		 ORDER BY ra.started_at DESC LIMIT 8`, businessID, since)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	out.Recent = []RecordingSummaryItem{}
	for rows.Next() {
		var item RecordingSummaryItem
		if err := rows.Scan(&item.ID, &item.EmployeeID, &item.EmployeeName, &item.Status,
			&item.FailureCode, &item.ByteSize, &item.StartedAt, &item.EndedAt, &item.RetentionUntil); err != nil {
			return out, err
		}
		out.Recent = append(out.Recent, item)
	}
	return out, rows.Err()
}

func (s *Store) RecordingForMember(ctx context.Context, userID, recordingID string) (RecordingAsset, error) {
	a, err := scanRecording(s.pool.QueryRow(ctx, `SELECT `+recordingColumns+`
		FROM recording_assets ra
		JOIN media_sessions ms ON ms.id=ra.media_session_id
		JOIN memberships m ON m.business_id=ra.business_id AND m.user_id=$1
		WHERE ra.id=$2 AND ra.status <> 'deleted'`, userID, recordingID))
	if errors.Is(err, pgx.ErrNoRows) {
		return RecordingAsset{}, ErrNotFound
	}
	return a, err
}

// EmployeeBusinessForMember resolves the tenant that contains an employee.
// The membership join keeps tenant isolation inside the query, before any
// recording metadata is returned to the handler.
func (s *Store) EmployeeBusinessForMember(ctx context.Context, userID, employeeID string) (string, error) {
	var businessID string
	err := s.pool.QueryRow(ctx, `
		SELECT employee.business_id
		FROM memberships employee
		JOIN memberships viewer ON viewer.business_id=employee.business_id AND viewer.user_id=$1
		WHERE employee.user_id=$2`, userID, employeeID).Scan(&businessID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return businessID, err
}

func (s *Store) RecordingsForEmployee(ctx context.Context, userID, employeeID string, from, to time.Time) ([]RecordingAsset, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+recordingColumns+`
		FROM recording_assets ra
		JOIN media_sessions ms ON ms.id=ra.media_session_id
		JOIN memberships viewer ON viewer.business_id=ra.business_id AND viewer.user_id=$1
		WHERE ms.employee_id=$2 AND ra.status <> 'deleted'
		  AND ra.started_at < $4 AND COALESCE(ra.ended_at, now()) > $3
		ORDER BY ra.started_at`, userID, employeeID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RecordingAsset{}
	for rows.Next() {
		a, err := scanRecording(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
