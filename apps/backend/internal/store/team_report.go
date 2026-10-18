package store

import "context"

// TeamUsage is time spent in one app or on one site across a business.
type TeamUsage struct {
	Name      string `json:"name"`
	DurationS int64  `json:"duration_s"`
	// How many people used it in the window.
	Employees int64 `json:"employees"`
}

// TeamInput is the business-wide input total for a window (counts only).
type TeamInput struct {
	Keystrokes int64 `json:"keystrokes"`
	Clicks     int64 `json:"clicks"`
	Scrolls    int64 `json:"scrolls"`
	MousePx    int64 `json:"mouse_px"`
}

// TeamHour is the active foreground time recorded in one hour of the window.
type TeamHour struct {
	// Hour offset from the start of the window (0 = the first hour).
	Hour      int   `json:"hour"`
	DurationS int64 `json:"duration_s"`
}

// TeamReport answers the overview's questions for a whole business: where the
// team's time went (apps and sites), how hard it typed and clicked, and when in
// the window it was active.
type TeamReport struct {
	From    int64       `json:"from"`
	To      int64       `json:"to"`
	Apps    []TeamUsage `json:"apps"`
	Domains []TeamUsage `json:"domains"`
	Input   TeamInput   `json:"input"`
	Hours   []TeamHour  `json:"hours"`
}

// teamTopN caps the app and site lists; the overview shows a top list, not an
// inventory, and the per-employee reports carry the full detail.
const teamTopN = 12

// memberFilter keeps a report to people who are members of the business, so a
// removed employee's old rows do not keep counting toward the team.
const memberFilter = `user_id IN (SELECT user_id FROM memberships
                                  WHERE business_id = $1 AND role IN ('owner','employee'))`

// TeamReportFor builds the business-wide report for [from, to). The caller must
// already have checked that the requester owns businessID.
func (s *Store) TeamReportFor(ctx context.Context, businessID string, from, to int64) (TeamReport, error) {
	out := TeamReport{From: from, To: to, Apps: []TeamUsage{}, Domains: []TeamUsage{}, Hours: []TeamHour{}}

	usage := func(query string) ([]TeamUsage, error) {
		rows, err := s.pool.Query(ctx, query, businessID, from, to, teamTopN)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		list := []TeamUsage{}
		for rows.Next() {
			var u TeamUsage
			if err := rows.Scan(&u.Name, &u.DurationS, &u.Employees); err != nil {
				return nil, err
			}
			list = append(list, u)
		}
		return list, rows.Err()
	}

	var err error
	if out.Apps, err = usage(`
		SELECT app_name, sum(duration_s)::bigint, count(DISTINCT user_id)
		  FROM activity_samples
		 WHERE business_id = $1 AND ts >= $2 AND ts < $3 AND ` + memberFilter + `
		 GROUP BY app_name
		 ORDER BY 2 DESC, 1
		 LIMIT $4`); err != nil {
		return out, err
	}
	// "www.github.com" and "github.com" are one site to the person reading, the
	// same rule the per-employee report applies when it groups visits.
	if out.Domains, err = usage(`
		SELECT regexp_replace(domain, '^www\.', ''), sum(duration_s)::bigint, count(DISTINCT user_id)
		  FROM browser_visits
		 WHERE business_id = $1 AND ts >= $2 AND ts < $3 AND ` + memberFilter + `
		   AND domain IS NOT NULL AND domain <> ''
		 GROUP BY 1
		 ORDER BY 2 DESC, 1
		 LIMIT $4`); err != nil {
		return out, err
	}

	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(sum(count), 0)::bigint, COALESCE(sum(clicks), 0)::bigint,
		       COALESCE(sum(scrolls), 0)::bigint, COALESCE(sum(mouse_px), 0)::bigint
		  FROM keystroke_buckets
		 WHERE business_id = $1 AND ts_bucket >= $2 AND ts_bucket < $3 AND `+memberFilter,
		businessID, from, to,
	).Scan(&out.Input.Keystrokes, &out.Input.Clicks, &out.Input.Scrolls, &out.Input.MousePx); err != nil {
		return out, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT ((ts - $2) / 3600)::int AS hour, sum(duration_s)::bigint
		  FROM activity_samples
		 WHERE business_id = $1 AND ts >= $2 AND ts < $3 AND `+memberFilter+`
		 GROUP BY 1
		 ORDER BY 1`, businessID, from, to)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var h TeamHour
		if err := rows.Scan(&h.Hour, &h.DurationS); err != nil {
			return out, err
		}
		out.Hours = append(out.Hours, h)
	}
	return out, rows.Err()
}
