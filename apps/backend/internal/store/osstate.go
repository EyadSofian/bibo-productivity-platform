package store

import (
	"context"
	"time"
)

// OsStateInterval is one closed device-state interval, clipped to the requested
// window so a stretch that straddles midnight is not counted twice across two
// days' reports.
type OsStateInterval struct {
	State     string `json:"state"`
	Ts        int64  `json:"ts"`
	DurationS int64  `json:"duration_s"`
}

// OsStateTotals is the time budget for a window. The four values are disjoint and
// together cover it exactly, which is the property that makes them trustworthy:
//
//	active + idle + suspended + offline == the elapsed part of the window
//
// Offline is not reported by the agent — a disconnected agent cannot report its
// own disconnection — so it is whatever the timeline does not account for.
type OsStateTotals struct {
	ActiveS    int64 `json:"active_s"`
	IdleS      int64 `json:"idle_s"`
	SuspendedS int64 `json:"suspended_s"`
	OfflineS   int64 `json:"offline_s"`
	// CoveredS is active+idle+suspended: the time the agent actually accounted
	// for. Exposed so the dashboard can show how complete a day's data is.
	CoveredS int64 `json:"covered_s"`
	// ElapsedS is the part of the window that has already happened.
	ElapsedS int64 `json:"elapsed_s"`
}

// OsStateReport is the device-state timeline plus its totals.
type OsStateReport struct {
	Totals        OsStateTotals     `json:"totals"`
	FirstActivity *int64            `json:"first_activity"`
	LastActivity  *int64            `json:"last_activity"`
	Intervals     []OsStateInterval `json:"intervals"`
}

// clippedDuration is the overlap between an interval and the window, in SQL.
// Both bounds are clamped, so an interval that starts before `from` or ends after
// `to` contributes only the part inside the window.
const clippedDuration = `LEAST(ts + duration_s, $4) - GREATEST(ts, $3)`

// The overlap predicate: any interval touching the window, not just ones starting
// inside it. A half-open comparison on `ts` alone would drop a long suspend that
// began the previous evening.
const overlapsWindow = `ts < $4 AND ts + duration_s > $3`

// OsStateReportFor returns the state timeline for one employee within [from, to).
// Scoped to businesses the caller owns, like every other per-employee read.
func (s *Store) OsStateReportFor(
	ctx context.Context, employeeID, ownerID string, from, to int64,
) (OsStateReport, error) {
	report := OsStateReport{Intervals: []OsStateInterval{}}

	owned, err := s.OwnsEmployee(ctx, ownerID, employeeID)
	if err != nil {
		return report, err
	}
	if !owned {
		return report, ErrForbidden
	}

	rows, err := s.pool.Query(ctx,
		`SELECT state, GREATEST(ts, $3) AS start_ts, `+clippedDuration+` AS duration_s
		   FROM os_states
		  WHERE user_id = $1 AND `+ownedFilter+` AND `+overlapsWindow+`
		  ORDER BY start_ts`,
		employeeID, ownerID, from, to)
	if err != nil {
		return report, err
	}
	defer rows.Close()

	for rows.Next() {
		var iv OsStateInterval
		if err := rows.Scan(&iv.State, &iv.Ts, &iv.DurationS); err != nil {
			return report, err
		}
		// A zero-width clip means the interval only touched the boundary.
		if iv.DurationS <= 0 {
			continue
		}
		report.Intervals = append(report.Intervals, iv)
		switch iv.State {
		case "active":
			report.Totals.ActiveS += iv.DurationS
		case "idle":
			report.Totals.IdleS += iv.DurationS
		case "suspended":
			report.Totals.SuspendedS += iv.DurationS
		}
	}
	if err := rows.Err(); err != nil {
		return report, err
	}

	// First/last moment the employee was actually at the machine, from the
	// clipped active intervals rather than from raw row timestamps.
	for _, iv := range report.Intervals {
		if iv.State != "active" {
			continue
		}
		start, end := iv.Ts, iv.Ts+iv.DurationS
		if report.FirstActivity == nil {
			first := start
			report.FirstActivity = &first
		}
		last := end
		report.LastActivity = &last
	}

	report.Totals.CoveredS = report.Totals.ActiveS + report.Totals.IdleS + report.Totals.SuspendedS

	// Only the part of the window that has already elapsed can be accounted for;
	// a range ending at 23:59 today must not report the rest of the day offline.
	now := time.Now().Unix()
	end := to
	if now < end {
		end = now
	}
	elapsed := end - from
	if elapsed < 0 {
		elapsed = 0
	}
	report.Totals.ElapsedS = elapsed

	offline := elapsed - report.Totals.CoveredS
	if offline < 0 {
		// Clock skew between device and server can make the timeline overshoot
		// the window. Report zero rather than a negative duration.
		offline = 0
	}
	report.Totals.OfflineS = offline

	return report, nil
}
