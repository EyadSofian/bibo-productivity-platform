package store

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// state builds one interval row. Times are relative to `base` so the tests read
// as a timeline rather than as epoch arithmetic.
func state(kind string, startOffset, duration int64) OsStateRow {
	return OsStateRow{
		ClientUUID: uuid.NewString(),
		State:      kind,
		Ts:         testBase + startOffset,
		DurationS:  int(duration),
	}
}

// testBase is a fixed point in the recent past: far enough back that the whole
// window has elapsed (so `offline` is computed against real time, not clamped),
// but not so far that it drifts out of any retention behaviour.
var testBase = time.Now().Unix() - 86400

func (f syncFixture) syncStates(t *testing.T, states []OsStateRow) {
	t.Helper()
	if _, err := f.store.SyncBatch(f.ctx, f.userID, f.bizID, f.deviceID,
		nil, nil, nil, nil, nil, nil, states); err != nil {
		t.Fatalf("sync states: %v", err)
	}
}

func TestOsStateReportSplitsAnHourIntoActiveAndIdle(t *testing.T) {
	f := newSyncFixture(t)
	// 20 min active, 20 min idle, 20 min active — a normal hour with a break.
	f.syncStates(t, []OsStateRow{
		state("active", 0, 1200),
		state("idle", 1200, 1200),
		state("active", 2400, 1200),
	})

	got, err := f.store.OsStateReportFor(f.ctx, f.userID, f.userID, testBase, testBase+3600)
	if err != nil {
		t.Fatalf("report: %v", err)
	}

	if got.Totals.ActiveS != 2400 {
		t.Errorf("active = %d, want 2400", got.Totals.ActiveS)
	}
	if got.Totals.IdleS != 1200 {
		t.Errorf("idle = %d, want 1200", got.Totals.IdleS)
	}
	// The whole window is accounted for, so nothing is offline.
	if got.Totals.OfflineS != 0 {
		t.Errorf("offline = %d, want 0", got.Totals.OfflineS)
	}
	if got.Totals.CoveredS != 3600 {
		t.Errorf("covered = %d, want 3600", got.Totals.CoveredS)
	}
	if len(got.Intervals) != 3 {
		t.Errorf("intervals = %d, want 3", len(got.Intervals))
	}
}

// The property the whole feature rests on: the four totals partition the window.
func TestOsStateTotalsPartitionTheWindow(t *testing.T) {
	f := newSyncFixture(t)
	// The timeline covers the whole hour EXCEPT one deliberate gap, so the only
	// offline time the report can find is that gap.
	f.syncStates(t, []OsStateRow{
		state("active", 0, 600),
		state("idle", 600, 300),
		// A gap from 900 to 1800: the agent was not running and could not say so.
		state("suspended", 1800, 900),
		state("active", 2700, 900),
	})

	window := int64(3600)
	got, err := f.store.OsStateReportFor(f.ctx, f.userID, f.userID, testBase, testBase+window)
	if err != nil {
		t.Fatalf("report: %v", err)
	}

	sum := got.Totals.ActiveS + got.Totals.IdleS + got.Totals.SuspendedS + got.Totals.OfflineS
	if sum != got.Totals.ElapsedS {
		t.Fatalf("totals do not partition the window: active=%d idle=%d suspended=%d offline=%d sum=%d elapsed=%d",
			got.Totals.ActiveS, got.Totals.IdleS, got.Totals.SuspendedS,
			got.Totals.OfflineS, sum, got.Totals.ElapsedS)
	}
	// The 900s the agent never reported must surface as offline, not vanish and
	// not be absorbed into an adjacent state.
	if got.Totals.OfflineS != 900 {
		t.Errorf("offline = %d, want 900 (the unreported gap)", got.Totals.OfflineS)
	}
	if got.Totals.SuspendedS != 900 {
		t.Errorf("suspended = %d, want 900", got.Totals.SuspendedS)
	}
}

// An interval spanning a day boundary must be split, not double-counted, or two
// consecutive daily reports would each claim the whole night.
func TestOsStateIntervalsAreClippedToTheWindow(t *testing.T) {
	f := newSyncFixture(t)
	// One 2-hour suspend starting an hour before the window opens.
	f.syncStates(t, []OsStateRow{state("suspended", -3600, 7200)})

	from, to := testBase, testBase+3600
	got, err := f.store.OsStateReportFor(f.ctx, f.userID, f.userID, from, to)
	if err != nil {
		t.Fatalf("report: %v", err)
	}

	// Only the hour inside the window counts.
	if got.Totals.SuspendedS != 3600 {
		t.Errorf("suspended = %d, want 3600 (clipped)", got.Totals.SuspendedS)
	}
	if len(got.Intervals) != 1 {
		t.Fatalf("intervals = %d, want 1", len(got.Intervals))
	}
	if got.Intervals[0].Ts != from {
		t.Errorf("interval start = %d, want the window start %d", got.Intervals[0].Ts, from)
	}
}

func TestOsStateReportsFirstAndLastActivity(t *testing.T) {
	f := newSyncFixture(t)
	f.syncStates(t, []OsStateRow{
		state("idle", 0, 600),
		state("active", 600, 300),
		state("idle", 900, 1200),
		state("active", 2100, 600),
		state("idle", 2700, 900),
	})

	got, err := f.store.OsStateReportFor(f.ctx, f.userID, f.userID, testBase, testBase+3600)
	if err != nil {
		t.Fatalf("report: %v", err)
	}

	if got.FirstActivity == nil || *got.FirstActivity != testBase+600 {
		t.Errorf("first activity = %v, want %d", got.FirstActivity, testBase+600)
	}
	// Last activity is when the final active stretch ENDED, not when it began.
	if got.LastActivity == nil || *got.LastActivity != testBase+2700 {
		t.Errorf("last activity = %v, want %d", got.LastActivity, testBase+2700)
	}
}

// Re-sending a batch (the offline backlog case) must not double the totals.
func TestOsStateResendIsIdempotent(t *testing.T) {
	f := newSyncFixture(t)
	batch := []OsStateRow{
		state("active", 0, 1800),
		state("idle", 1800, 1800),
	}

	f.syncStates(t, batch)
	f.syncStates(t, batch) // the agent never saw the first response

	got, err := f.store.OsStateReportFor(f.ctx, f.userID, f.userID, testBase, testBase+3600)
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if got.Totals.ActiveS != 1800 {
		t.Errorf("active = %d after a resend, want 1800", got.Totals.ActiveS)
	}
	if n := f.count(t, "os_states"); n != 2 {
		t.Errorf("rows = %d after a resend, want 2", n)
	}
}

// Another owner's employee must not be readable, like every other report.
func TestOsStateReportIsTenantScoped(t *testing.T) {
	f := newSyncFixture(t)
	f.syncStates(t, []OsStateRow{state("active", 0, 600)})

	stranger := mustUser(t, f.ctx, f.store, "stranger@example.com", "")
	_, err := f.store.OsStateReportFor(f.ctx, f.userID, stranger.ID, testBase, testBase+3600)
	if err != ErrForbidden {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

// A window entirely in the future has nothing elapsed, so nothing is offline —
// "today" must not report the remaining hours of the day as offline time.
func TestOsStateFutureWindowReportsNoOfflineTime(t *testing.T) {
	f := newSyncFixture(t)
	future := time.Now().Unix() + 3600
	got, err := f.store.OsStateReportFor(f.ctx, f.userID, f.userID, future, future+3600)
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if got.Totals.OfflineS != 0 {
		t.Errorf("offline = %d for a future window, want 0", got.Totals.OfflineS)
	}
	if got.Totals.ElapsedS != 0 {
		t.Errorf("elapsed = %d for a future window, want 0", got.Totals.ElapsedS)
	}
}
