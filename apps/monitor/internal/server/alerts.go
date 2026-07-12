package server

import (
	"fmt"
	"log"
	"strings"
	"time"
)

// A condition is an instantaneously-true incident; the engine adds the
// "must stay true for X" behaviour before notifying.
type condition struct {
	key     string
	summary string
	holdFor time.Duration
}

// runAlerts evaluates all rules every 30s and drives a per-key state machine:
// condition true for >= holdFor  -> FIRING (Telegram), condition false -> RESOLVED.
func (s *Server) runAlerts() {
	tick := time.NewTicker(30 * time.Second)
	for ; ; <-tick.C {
		now := time.Now()
		active := map[string]condition{}
		for _, c := range s.evaluate(now) {
			active[c.key] = c
		}

		rows, err := s.store.db.Query(`SELECT key, summary, first_true, firing FROM alert_state`)
		if err != nil {
			log.Printf("alerts: %v", err)
			continue
		}
		type st struct {
			summary   string
			firstTrue int64
			firing    bool
		}
		known := map[string]st{}
		for rows.Next() {
			var k, sum string
			var ft int64
			var f int
			rows.Scan(&k, &sum, &ft, &f)
			known[k] = st{sum, ft, f == 1}
		}
		rows.Close()

		for key, c := range active {
			prev, ok := known[key]
			if !ok {
				s.store.db.Exec(`INSERT INTO alert_state (key, summary, first_true, firing) VALUES (?,?,?,0)`,
					key, c.summary, now.UnixMilli())
				prev = st{c.summary, now.UnixMilli(), false}
			}
			if !prev.firing && now.UnixMilli()-prev.firstTrue >= c.holdFor.Milliseconds() {
				s.store.db.Exec(`UPDATE alert_state SET firing=1, summary=? WHERE key=?`, c.summary, key)
				s.tg.send("🔥 FIRING: " + c.summary)
			}
		}
		warmedUp := now.Sub(s.started) > 5*time.Minute
		for key, prev := range known {
			if _, still := active[key]; still {
				continue
			}
			// NoData rules are skipped (unknown, not false) during warmup —
			// don't resolve them until they are actually evaluated again.
			if !warmedUp && (key == "keepalive" || strings.HasPrefix(key, "agent:")) {
				continue
			}
			s.store.db.Exec(`DELETE FROM alert_state WHERE key=?`, key)
			if prev.firing {
				s.tg.send("✅ RESOLVED: " + prev.summary)
			}
		}
	}
}

func (s *Server) evaluate(now time.Time) []condition {
	var conds []condition
	db := s.store.db
	nowMS := now.UnixMilli()

	// 1. Public endpoint down (latest probe failed).
	rows, _ := db.Query(`SELECT target, up FROM probes WHERE (target, ts) IN
		(SELECT target, MAX(ts) FROM probes GROUP BY target)`)
	if rows != nil {
		for rows.Next() {
			var target string
			var up int
			rows.Scan(&target, &up)
			if up == 0 {
				conds = append(conds, condition{"endpoint:" + target,
					fmt.Sprintf("endpoint DOWN: %s", target), 2 * time.Minute})
			}
		}
		rows.Close()
	}

	// NoData-style rules need history; skip them during the first minutes after
	// a server (re)start or they fire spuriously on an empty/stale window.
	warmedUp := now.Sub(s.started) > 5*time.Minute

	// 2. Agent silent = prod box unreachable (NoData alert).
	if s.cfg.AgentHost != "" && warmedUp {
		var lastTS int64
		db.QueryRow(`SELECT COALESCE(MAX(ts),0) FROM metrics WHERE host=?`, s.cfg.AgentHost).Scan(&lastTS)
		if nowMS-lastTS > 3*60*1000 {
			conds = append(conds, condition{"agent:" + s.cfg.AgentHost,
				fmt.Sprintf("no data from %s for >3m (box or tunnel down?)", s.cfg.AgentHost), 0})
		}
	}

	// 3. Service (systemd unit / staging check) not active — only on fresh data,
	// stale rows mean the agent is down, which rule 2 covers.
	rows, _ = db.Query(`SELECT host, unit, active, state, ts FROM unit_state WHERE (host, unit, ts) IN
		(SELECT host, unit, MAX(ts) FROM unit_state GROUP BY host, unit)`)
	if rows != nil {
		for rows.Next() {
			var host, unit, state string
			var active int
			var ts int64
			rows.Scan(&host, &unit, &active, &state, &ts)
			if active == 0 && nowMS-ts < 2*60*1000 {
				conds = append(conds, condition{"unit:" + host + "/" + unit,
					fmt.Sprintf("service %s on %s is %s", unit, host, state), 2 * time.Minute})
			}
		}
		rows.Close()
	}

	// 4. Host usage high (latest sample, hold 10m).
	rows, _ = db.Query(`SELECT host, cpu, mem, disk, ts FROM metrics WHERE (host, ts) IN
		(SELECT host, MAX(ts) FROM metrics GROUP BY host)`)
	if rows != nil {
		for rows.Next() {
			var host string
			var cpu, memv, diskv float64
			var ts int64
			rows.Scan(&host, &cpu, &memv, &diskv, &ts)
			if nowMS-ts > 3*60*1000 {
				continue
			}
			if diskv > 80 {
				conds = append(conds, condition{"disk:" + host, fmt.Sprintf("disk %.0f%% on %s (>80%%)", diskv, host), 10 * time.Minute})
			}
			if memv > 90 {
				conds = append(conds, condition{"mem:" + host, fmt.Sprintf("memory %.0f%% on %s (>90%%)", memv, host), 10 * time.Minute})
			}
			if cpu > 90 {
				conds = append(conds, condition{"cpu:" + host, fmt.Sprintf("CPU %.0f%% on %s (>90%%)", cpu, host), 10 * time.Minute})
			}
		}
		rows.Close()
	}

	// 5. API fail rate high per service: >3 5xx in 5m, or >10% errors with >=20 reqs.
	rows, _ = db.Query(`SELECT service,
			COUNT(*) AS total,
			SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS c5xx
		FROM requests WHERE ts > ? GROUP BY service`, nowMS-5*60*1000)
	if rows != nil {
		for rows.Next() {
			var service string
			var total, c5xx int
			rows.Scan(&service, &total, &c5xx)
			if c5xx > 3 || (total >= 20 && float64(c5xx)/float64(total) > 0.10) {
				conds = append(conds, condition{"apierr:" + service,
					fmt.Sprintf("API errors on %s: %d of %d requests 5xx in 5m", service, c5xx, total), 0})
			}
		}
		rows.Close()
	}

	// 6. Keepalive broken: no keepalive 200 in 20m (the 2026-07-03 incident class).
	if s.cfg.KeepaliveService != "" && warmedUp {
		var n int
		db.QueryRow(`SELECT COUNT(*) FROM requests WHERE service=? AND path=? AND status=200 AND ts > ?`,
			s.cfg.KeepaliveService, s.cfg.KeepalivePath, nowMS-20*60*1000).Scan(&n)
		if n == 0 {
			conds = append(conds, condition{"keepalive",
				fmt.Sprintf("no %s 200 on %s in 20m — external keepalive broken", s.cfg.KeepalivePath, s.cfg.KeepaliveService), 0})
		}
	}
	return conds
}
