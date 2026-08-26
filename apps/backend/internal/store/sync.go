package store

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ErrAmbiguousBusiness is returned when a user belongs to multiple businesses and
// the sync request didn't say which one the data is for.
var ErrAmbiguousBusiness = errors.New("ambiguous business")

// Row types mirror the desktop's local tables. Nullable columns use pointers.

// ActivityRow is one foreground-app interval.
type ActivityRow struct {
	ClientUUID      string
	Ts              int64
	AppName         string
	WindowTitle     *string
	Pid             *int
	DurationS       int
	ClientUpdatedAt int64
}

// KeystrokeRow is one keypress-count bucket (counts only — never keys).
type KeystrokeRow struct {
	ClientUUID      string
	TsBucket        int64
	Count           int
	ClientUpdatedAt int64
}

// BrowserRow is one page visit reported by the extension.
//
// There is deliberately no Domain field: the domain is derived from URL during
// ingest (see DomainOf), so a client cannot report a URL under one domain and
// have it grouped, classified or alerted on as another.
type BrowserRow struct {
	ClientUUID      string
	Ts              int64
	URL             string
	PageTitle       *string
	Browser         *string
	DurationS       int
	ClientUpdatedAt int64
}

// DomainOf extracts the hostname a visit belongs to, or nil when the URL has
// none — which includes the reserved on/off marker values, that are not URLs.
//
// The full hostname is kept rather than a registrable domain: reducing
// "docs.google.com" to "google.com" needs a public-suffix list, and the
// distinction matters for classification. Narrowing later is always possible;
// recovering detail that was discarded is not.
func DomainOf(rawURL string) *string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" {
		return nil
	}
	// Parse accepts a lot that is not a web URL ("mailto:", bare paths). Only
	// http(s) visits are page views.
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return nil
	}
	host := strings.ToLower(u.Hostname())
	return &host
}

// ResolveBusinessForUser determines which business synced data belongs to. If
// explicit is non-nil it must be a business the user is a member of. Otherwise the
// user's single membership is used; zero memberships → ErrNotFound, more than one →
// ErrAmbiguousBusiness (the client must specify business_id).
func (s *Store) ResolveBusinessForUser(ctx context.Context, userID string, explicit *string) (string, error) {
	if explicit != nil {
		member, err := s.IsMember(ctx, userID, *explicit)
		if err != nil {
			return "", err
		}
		if !member {
			return "", ErrForbidden
		}
		return *explicit, nil
	}

	rows, err := s.pool.Query(ctx, `SELECT business_id FROM memberships WHERE user_id = $1`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	switch len(ids) {
	case 0:
		return "", ErrNotFound
	case 1:
		return ids[0], nil
	default:
		return "", ErrAmbiguousBusiness
	}
}

const (
	activityUpsert = `
INSERT INTO activity_samples
  (client_uuid, user_id, business_id, device_id, ts, app_name, window_title, pid, duration_s, client_updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
ON CONFLICT (client_uuid) DO UPDATE SET
  ts = EXCLUDED.ts, app_name = EXCLUDED.app_name, window_title = EXCLUDED.window_title,
  pid = EXCLUDED.pid, duration_s = EXCLUDED.duration_s,
  client_updated_at = EXCLUDED.client_updated_at, received_at = now()`

	keystrokeUpsert = `
INSERT INTO keystroke_buckets
  (client_uuid, user_id, business_id, device_id, ts_bucket, count, client_updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (client_uuid) DO UPDATE SET
  ts_bucket = EXCLUDED.ts_bucket, count = EXCLUDED.count,
  client_updated_at = EXCLUDED.client_updated_at, received_at = now()`

	browserUpsert = `
INSERT INTO browser_visits
  (client_uuid, user_id, business_id, device_id, ts, url, domain, page_title, browser, duration_s, client_updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (client_uuid) DO UPDATE SET
  ts = EXCLUDED.ts, url = EXCLUDED.url, domain = EXCLUDED.domain,
  page_title = EXCLUDED.page_title,
  browser = EXCLUDED.browser, duration_s = EXCLUDED.duration_s,
  client_updated_at = EXCLUDED.client_updated_at, received_at = now()`

	// business_id/os/agent_version are COALESCEd so a sparse heartbeat (which may
	// omit os/version) never nulls out what a fuller sync already recorded.
	// last_seen_at is bumped unconditionally — the device is alive even when its
	// monitoring is off. RETURNING monitoring_enabled lets the caller decide
	// whether to ingest this batch's data at all.
	deviceUpsert = `
INSERT INTO devices (id, user_id, business_id, label, os, agent_version, last_seen_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  business_id = COALESCE(EXCLUDED.business_id, devices.business_id),
  label = COALESCE(EXCLUDED.label, devices.label),
  os = COALESCE(EXCLUDED.os, devices.os),
  agent_version = COALESCE(EXCLUDED.agent_version, devices.agent_version),
  last_seen_at = now()
RETURNING monitoring_enabled`
)

// SyncBatch upserts a batch of activity/keystroke/browser rows for one user+business
// +device, in a single transaction. Idempotent by client_uuid; the client's values
// always win (respect local). user_id/business_id come from the caller (token +
// membership), never the payload, so a row can't claim another user.
//
// A device whose monitoring has been turned off (F40) still registers and has
// its last_seen_at bumped — so it stays visible in the inventory as alive — but
// none of its activity/keystroke/browser rows are ingested. The dropped count
// is returned so the handler can still acknowledge the client_uuids (the agent
// must mark them synced and move on, or it would resend forever) while logging
// that the data was intentionally discarded. Enforcement lives here, at the one
// choke point every device's data passes through, rather than in the agent,
// which is the untrusted side.
func (s *Store) SyncBatch(ctx context.Context, userID, businessID, deviceID string, label *string,
	act []ActivityRow, ks []KeystrokeRow, br []BrowserRow) (SyncResult, error) {

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SyncResult{}, err
	}
	defer tx.Rollback(ctx)

	var os, agentVersion *string // reserved for a later agent that reports them
	var monitoringEnabled bool
	if err := tx.QueryRow(ctx, deviceUpsert,
		deviceID, userID, businessID, label, os, agentVersion,
	).Scan(&monitoringEnabled); err != nil {
		return SyncResult{}, err
	}

	if !monitoringEnabled {
		// Commit the heartbeat (device registration + last_seen), drop the data.
		if err := tx.Commit(ctx); err != nil {
			return SyncResult{}, err
		}
		return SyncResult{
			MonitoringEnabled: false,
			Dropped:           len(act) + len(ks) + len(br),
		}, nil
	}

	batch := &pgx.Batch{}
	for _, a := range act {
		batch.Queue(activityUpsert, a.ClientUUID, userID, businessID, deviceID,
			a.Ts, a.AppName, a.WindowTitle, a.Pid, a.DurationS, a.ClientUpdatedAt)
	}
	for _, k := range ks {
		batch.Queue(keystrokeUpsert, k.ClientUUID, userID, businessID, deviceID,
			k.TsBucket, k.Count, k.ClientUpdatedAt)
	}
	for _, b := range br {
		// Derived here, not taken from the payload, so the stored domain always
		// matches the stored URL.
		batch.Queue(browserUpsert, b.ClientUUID, userID, businessID, deviceID,
			b.Ts, b.URL, DomainOf(b.URL), b.PageTitle, b.Browser, b.DurationS, b.ClientUpdatedAt)
	}

	if batch.Len() > 0 {
		res := tx.SendBatch(ctx, batch)
		for i := 0; i < batch.Len(); i++ {
			if _, err := res.Exec(); err != nil {
				res.Close()
				return SyncResult{}, err
			}
		}
		if err := res.Close(); err != nil {
			return SyncResult{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return SyncResult{}, err
	}
	return SyncResult{MonitoringEnabled: true}, nil
}

// SyncResult reports what SyncBatch did with a batch. When MonitoringEnabled is
// false the device is registered but its data was discarded (Dropped rows); the
// handler still acknowledges the client_uuids so the agent stops resending.
type SyncResult struct {
	MonitoringEnabled bool
	Dropped           int
}
