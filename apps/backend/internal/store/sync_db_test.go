package store

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

type syncFixture struct {
	store    *Store
	ctx      context.Context
	userID   string
	bizID    string
	deviceID string
}

func newSyncFixture(t *testing.T) syncFixture {
	t.Helper()
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "owner@example.com", "")
	biz, err := s.CreateBusiness(ctx, owner.ID, "Acme", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	return syncFixture{s, ctx, owner.ID, biz.ID, uuid.NewString()}
}

func (f syncFixture) sync(t *testing.T, act []ActivityRow, ks []KeystrokeRow, br []BrowserRow) {
	t.Helper()
	if _, err := f.store.SyncBatch(f.ctx, f.userID, f.bizID, f.deviceID, nil, nil, nil, act, ks, br); err != nil {
		t.Fatalf("sync batch: %v", err)
	}
}

func (f syncFixture) count(t *testing.T, table string) int {
	t.Helper()
	var n int
	// table is a literal from this test file, never request data.
	if err := f.store.pool.QueryRow(f.ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

func activity(clientUUID, app string, duration int, updatedAt int64) ActivityRow {
	return ActivityRow{
		ClientUUID:      clientUUID,
		Ts:              1_700_000_000,
		AppName:         app,
		DurationS:       duration,
		ClientUpdatedAt: updatedAt,
	}
}

// The desktop re-sends anything it has not seen acknowledged, so the same batch
// arriving twice must not double-count a single interval.
func TestSyncBatchIsIdempotent(t *testing.T) {
	f := newSyncFixture(t)
	rows := []ActivityRow{
		activity(uuid.NewString(), "Code", 60, 1),
		activity(uuid.NewString(), "Chrome", 30, 1),
	}

	f.sync(t, rows, nil, nil)
	f.sync(t, rows, nil, nil)

	if got := f.count(t, "activity_samples"); got != 2 {
		t.Fatalf("activity_samples = %d, want 2 after re-sending the same batch", got)
	}
}

func TestSyncBatchRespectsLocalOnResend(t *testing.T) {
	f := newSyncFixture(t)
	id := uuid.NewString()

	f.sync(t, []ActivityRow{activity(id, "Code", 60, 1)}, nil, nil)
	f.sync(t, []ActivityRow{activity(id, "Code", 95, 2)}, nil, nil)

	var duration int
	var updatedAt int64
	if err := f.store.pool.QueryRow(f.ctx,
		`SELECT duration_s, client_updated_at FROM activity_samples WHERE client_uuid = $1`, id,
	).Scan(&duration, &updatedAt); err != nil {
		t.Fatalf("read back: %v", err)
	}

	if duration != 95 || updatedAt != 2 {
		t.Fatalf("duration/updated = %d/%d, want the client's later values 95/2", duration, updatedAt)
	}
	if got := f.count(t, "activity_samples"); got != 1 {
		t.Fatalf("activity_samples = %d, want 1", got)
	}
}

// user_id and business_id come from the authenticated caller, never the payload.
// The row type carries no such fields, and this asserts the stored ownership
// matches the caller so that stays true.
func TestSyncBatchStampsCallerOwnership(t *testing.T) {
	f := newSyncFixture(t)
	id := uuid.NewString()

	f.sync(t, []ActivityRow{activity(id, "Code", 60, 1)}, nil, nil)

	var userID, bizID, deviceID string
	if err := f.store.pool.QueryRow(f.ctx,
		`SELECT user_id, business_id, device_id FROM activity_samples WHERE client_uuid = $1`, id,
	).Scan(&userID, &bizID, &deviceID); err != nil {
		t.Fatalf("read back: %v", err)
	}

	if userID != f.userID || bizID != f.bizID || deviceID != f.deviceID {
		t.Fatalf("stored ownership %s/%s/%s, want %s/%s/%s",
			userID, bizID, deviceID, f.userID, f.bizID, f.deviceID)
	}
}

func TestSyncBatchIngestsEveryRowKind(t *testing.T) {
	f := newSyncFixture(t)

	f.sync(t,
		[]ActivityRow{activity(uuid.NewString(), "Code", 60, 1)},
		[]KeystrokeRow{{ClientUUID: uuid.NewString(), TsBucket: 1_700_000_000, Count: 42, ClientUpdatedAt: 1}},
		[]BrowserRow{{ClientUUID: uuid.NewString(), Ts: 1_700_000_000, URL: "https://github.com", DurationS: 15, ClientUpdatedAt: 1}},
	)

	for table, want := range map[string]int{
		"activity_samples":  1,
		"keystroke_buckets": 1,
		"browser_visits":    1,
	} {
		if got := f.count(t, table); got != want {
			t.Fatalf("%s = %d, want %d", table, got, want)
		}
	}
}

// The domain is derived from the URL during ingest, never sent by the client,
// so a visit cannot be filed under a domain other than the one it came from.
func TestSyncBatchDerivesDomain(t *testing.T) {
	f := newSyncFixture(t)
	visits := []BrowserRow{
		{ClientUUID: uuid.NewString(), Ts: 1, URL: "https://GitHub.com/a/b?c=1", DurationS: 10, ClientUpdatedAt: 1},
		{ClientUUID: uuid.NewString(), Ts: 2, URL: "https://docs.google.com/d/x", DurationS: 10, ClientUpdatedAt: 1},
		{ClientUUID: uuid.NewString(), Ts: 3, URL: "user_turn_off_in_browser", DurationS: 0, ClientUpdatedAt: 1},
	}

	f.sync(t, nil, nil, visits)

	for _, tc := range []struct {
		clientUUID string
		want       string // "" means NULL
	}{
		{visits[0].ClientUUID, "github.com"},
		{visits[1].ClientUUID, "docs.google.com"},
		{visits[2].ClientUUID, ""},
	} {
		var got *string
		if err := f.store.pool.QueryRow(f.ctx,
			`SELECT domain FROM browser_visits WHERE client_uuid = $1`, tc.clientUUID,
		).Scan(&got); err != nil {
			t.Fatalf("read back: %v", err)
		}
		if tc.want == "" {
			if got != nil {
				t.Fatalf("domain = %q, want NULL for a non-URL marker", *got)
			}
			continue
		}
		if got == nil || *got != tc.want {
			t.Fatalf("domain = %v, want %q", got, tc.want)
		}
	}
}

// A heartbeat with nothing to report still registers the device, which is what
// the roster's last-seen column reads.
func TestSyncBatchRegistersDeviceOnEmptyBatch(t *testing.T) {
	f := newSyncFixture(t)

	f.sync(t, nil, nil, nil)

	if got := f.count(t, "devices"); got != 1 {
		t.Fatalf("devices = %d, want 1", got)
	}
}

func TestSyncBatchKeepsDeviceLabelWhenOmitted(t *testing.T) {
	f := newSyncFixture(t)
	label := "Work laptop"
	if _, err := f.store.SyncBatch(f.ctx, f.userID, f.bizID, f.deviceID, &label, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("sync with label: %v", err)
	}

	f.sync(t, nil, nil, nil)

	var got *string
	if err := f.store.pool.QueryRow(f.ctx,
		`SELECT label FROM devices WHERE id = $1`, f.deviceID).Scan(&got); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got == nil || *got != label {
		t.Fatalf("label = %v, want it preserved as %q", got, label)
	}
}
