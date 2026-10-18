package store

import (
	"testing"

	"github.com/google/uuid"
)

// teamFixture is a business with its owner and one employee, each with a device,
// so team totals can be checked against rows from more than one person.
type teamFixture struct {
	syncFixture
	employeeID     string
	employeeDevice string
}

func newTeamFixture(t *testing.T) teamFixture {
	t.Helper()
	f := newSyncFixture(t)
	employee := mustUser(t, f.ctx, f.store, "team-employee@example.com", "")
	if _, err := f.store.pool.Exec(f.ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		employee.ID, f.bizID,
	); err != nil {
		t.Fatalf("add employee: %v", err)
	}
	return teamFixture{f, employee.ID, uuid.NewString()}
}

func (f teamFixture) syncAs(t *testing.T, userID, deviceID string, act []ActivityRow, ks []KeystrokeRow, br []BrowserRow) {
	t.Helper()
	if _, err := f.store.SyncBatch(f.ctx, userID, f.bizID, deviceID, nil, nil, nil, act, ks, br, nil); err != nil {
		t.Fatalf("sync batch: %v", err)
	}
}

// Mouse counts ride in the keystroke bucket. A resend with new totals replaces
// the old ones, exactly as the keystroke count always has.
func TestSyncBatchStoresMouseCounts(t *testing.T) {
	f := newSyncFixture(t)
	id := uuid.NewString()
	bucket := int64(1_700_000_040)

	f.sync(t, nil, []KeystrokeRow{{ClientUUID: id, TsBucket: bucket, Count: 10, Clicks: 3, Scrolls: 2, MousePx: 900, ClientUpdatedAt: 1}}, nil)
	f.sync(t, nil, []KeystrokeRow{{ClientUUID: id, TsBucket: bucket, Count: 12, Clicks: 5, Scrolls: 2, MousePx: 1400, ClientUpdatedAt: 2}}, nil)

	got, err := f.store.KeystrokesReport(f.ctx, f.userID, f.userID, bucket, bucket+60)
	if err != nil {
		t.Fatalf("keystrokes report: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("buckets = %d, want 1", len(got))
	}
	b := got[0]
	if b.Count != 12 || b.Clicks != 5 || b.Scrolls != 2 || b.MousePx != 1400 {
		t.Fatalf("bucket = %+v, want the resent totals 12/5/2/1400", b)
	}
}

func TestRosterReportsInputTotalsForTheRequestedDay(t *testing.T) {
	f := newTeamFixture(t)
	dayStart := int64(1_700_000_000)

	f.syncAs(t, f.employeeID, f.employeeDevice, nil, []KeystrokeRow{
		{ClientUUID: uuid.NewString(), TsBucket: dayStart + 60, Count: 40, Clicks: 7, ClientUpdatedAt: 1},
		{ClientUUID: uuid.NewString(), TsBucket: dayStart + 120, Count: 2, Clicks: 1, ClientUpdatedAt: 1},
		// The next day must not leak into this one.
		{ClientUUID: uuid.NewString(), TsBucket: dayStart + 86400 + 60, Count: 999, Clicks: 999, ClientUpdatedAt: 1},
	}, nil)

	roster, err := f.store.Roster(f.ctx, f.bizID, dayStart, dayStart+86400)
	if err != nil {
		t.Fatalf("roster: %v", err)
	}
	for _, e := range roster {
		if e.ID != f.employeeID {
			continue
		}
		if e.KeystrokesToday != 42 || e.ClicksToday != 8 {
			t.Fatalf("totals = %d keys / %d clicks, want 42 / 8", e.KeystrokesToday, e.ClicksToday)
		}
		return
	}
	t.Fatal("employee missing from roster")
}

func TestTeamReportAggregatesAcrossEmployees(t *testing.T) {
	f := newTeamFixture(t)
	from := int64(1_700_000_000)
	to := from + 86400

	at := func(offset int64, app string, dur int) ActivityRow {
		return ActivityRow{ClientUUID: uuid.NewString(), Ts: from + offset, AppName: app, DurationS: dur, ClientUpdatedAt: 1}
	}
	visit := func(offset int64, url string, dur int) BrowserRow {
		return BrowserRow{ClientUUID: uuid.NewString(), Ts: from + offset, URL: url, DurationS: dur, ClientUpdatedAt: 1}
	}

	f.syncAs(t, f.userID, f.deviceID,
		[]ActivityRow{at(0, "Code", 600), at(3600, "Chrome", 300)},
		[]KeystrokeRow{{ClientUUID: uuid.NewString(), TsBucket: from, Count: 100, Clicks: 10, Scrolls: 4, MousePx: 5000, ClientUpdatedAt: 1}},
		[]BrowserRow{visit(3600, "https://github.com/acme", 200)},
	)
	f.syncAs(t, f.employeeID, f.employeeDevice,
		[]ActivityRow{at(60, "Code", 900), at(7200, "Slack", 120), at(86400+10, "Code", 5000)},
		[]KeystrokeRow{{ClientUUID: uuid.NewString(), TsBucket: from + 60, Count: 50, Clicks: 5, Scrolls: 1, MousePx: 1000, ClientUpdatedAt: 1}},
		[]BrowserRow{
			visit(3700, "https://www.github.com/acme/pulls", 100),
			visit(3800, "https://mail.google.com", 50),
			// The extension's on/off marker is not a site.
			visit(3900, "user_turn_off_in_browser", 0),
		},
	)

	r, err := f.store.TeamReportFor(f.ctx, f.bizID, from, to)
	if err != nil {
		t.Fatalf("team report: %v", err)
	}

	if len(r.Apps) != 3 || r.Apps[0].Name != "Code" || r.Apps[0].DurationS != 1500 || r.Apps[0].Employees != 2 {
		t.Fatalf("apps = %+v, want Code first with 1500s across 2 people (next day excluded)", r.Apps)
	}
	if len(r.Domains) != 2 || r.Domains[0].Name != "github.com" || r.Domains[0].DurationS != 300 || r.Domains[0].Employees != 2 {
		t.Fatalf("domains = %+v, want github.com first with 300s across 2 people", r.Domains)
	}
	if r.Input != (TeamInput{Keystrokes: 150, Clicks: 15, Scrolls: 5, MousePx: 6000}) {
		t.Fatalf("input = %+v", r.Input)
	}
	hours := map[int]int64{}
	for _, h := range r.Hours {
		hours[h.Hour] = h.DurationS
	}
	if hours[0] != 1500 || hours[1] != 300 || hours[2] != 120 || len(hours) != 3 {
		t.Fatalf("hours = %+v, want 0:1500 1:300 2:120", r.Hours)
	}
}

// Someone removed from the business keeps their old rows, but they no longer
// count toward the team.
func TestTeamReportIgnoresFormerMembers(t *testing.T) {
	f := newTeamFixture(t)
	from := int64(1_700_000_000)
	f.syncAs(t, f.employeeID, f.employeeDevice,
		[]ActivityRow{{ClientUUID: uuid.NewString(), Ts: from, AppName: "Code", DurationS: 60, ClientUpdatedAt: 1}}, nil, nil)
	if _, err := f.store.pool.Exec(f.ctx,
		`DELETE FROM memberships WHERE user_id = $1 AND business_id = $2`, f.employeeID, f.bizID,
	); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	r, err := f.store.TeamReportFor(f.ctx, f.bizID, from, from+86400)
	if err != nil {
		t.Fatalf("team report: %v", err)
	}
	if len(r.Apps) != 0 {
		t.Fatalf("apps = %+v, want none after the member left", r.Apps)
	}
}
