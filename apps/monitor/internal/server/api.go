package server

import (
	"net/http"
	"strconv"
	"time"
)

func hoursParam(r *http.Request, def int) int64 {
	h, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if h <= 0 {
		h = def
	}
	if h > 24*31 {
		h = 24 * 31
	}
	return time.Now().Add(-time.Duration(h) * time.Hour).UnixMilli()
}

// handleOverview: latest state of everything — hosts, units, probes (+24h
// uptime), firing alerts.
func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	db := s.store.db
	out := map[string]any{}
	nowMS := time.Now().UnixMilli()

	hosts := []map[string]any{}
	rows, err := db.Query(`SELECT host, ts, cpu, mem, disk, load1 FROM metrics WHERE (host, ts) IN
		(SELECT host, MAX(ts) FROM metrics GROUP BY host) ORDER BY host`)
	if err == nil {
		for rows.Next() {
			var host string
			var ts int64
			var c, m, d, l float64
			rows.Scan(&host, &ts, &c, &m, &d, &l)
			hosts = append(hosts, map[string]any{"host": host, "ts": ts, "cpu": c, "mem": m, "disk": d, "load1": l,
				"stale": nowMS-ts > 3*60*1000})
		}
		rows.Close()
	}
	out["hosts"] = hosts

	units := []map[string]any{}
	rows, err = db.Query(`SELECT host, unit, active, state, ts FROM unit_state WHERE (host, unit, ts) IN
		(SELECT host, unit, MAX(ts) FROM unit_state GROUP BY host, unit) ORDER BY host, unit`)
	if err == nil {
		for rows.Next() {
			var host, unit, state string
			var active int
			var ts int64
			rows.Scan(&host, &unit, &active, &state, &ts)
			units = append(units, map[string]any{"host": host, "unit": unit, "active": active == 1, "state": state,
				"ts": ts, "stale": nowMS-ts > 3*60*1000})
		}
		rows.Close()
	}
	out["units"] = units

	probes := []map[string]any{}
	rows, err = db.Query(`SELECT p.target, p.ts, p.up, p.ms, p.code,
			(SELECT AVG(up) FROM probes q WHERE q.target = p.target AND q.ts > ?) AS uptime24h
		FROM probes p WHERE (p.target, p.ts) IN
		(SELECT target, MAX(ts) FROM probes GROUP BY target) ORDER BY p.target`, nowMS-24*3600*1000)
	if err == nil {
		for rows.Next() {
			var target string
			var ts int64
			var up, code int
			var ms, uptime float64
			rows.Scan(&target, &ts, &up, &ms, &code, &uptime)
			probes = append(probes, map[string]any{"target": target, "ts": ts, "up": up == 1, "ms": ms,
				"code": code, "uptime24h": uptime})
		}
		rows.Close()
	}
	out["probes"] = probes

	alerts := []map[string]any{}
	rows, err = db.Query(`SELECT key, summary, first_true FROM alert_state WHERE firing=1 ORDER BY first_true`)
	if err == nil {
		for rows.Next() {
			var key, summary string
			var since int64
			rows.Scan(&key, &summary, &since)
			alerts = append(alerts, map[string]any{"key": key, "summary": summary, "since": since})
		}
		rows.Close()
	}
	out["alerts"] = alerts
	writeJSON(w, out)
}

// handleMetrics: host metric series. ?host=&hours=
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	since := hoursParam(r, 24)
	rows, err := s.store.db.Query(`SELECT host, ts, cpu, mem, disk, load1 FROM metrics
		WHERE ts > ? AND (? = '' OR host = ?) ORDER BY ts`,
		since, r.URL.Query().Get("host"), r.URL.Query().Get("host"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type row struct {
		Host  string  `json:"host"`
		TS    int64   `json:"ts"`
		CPU   float64 `json:"cpu"`
		Mem   float64 `json:"mem"`
		Disk  float64 `json:"disk"`
		Load1 float64 `json:"load1"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		rows.Scan(&x.Host, &x.TS, &x.CPU, &x.Mem, &x.Disk, &x.Load1)
		out = append(out, x)
	}
	writeJSON(w, out)
}

// handleRollup: per-minute API stats per service. ?hours=
func (s *Server) handleRollup(w http.ResponseWriter, r *http.Request) {
	sinceMin := hoursParam(r, 24) / 60000
	rows, err := s.store.db.Query(`SELECT service, minute, count, c2xx, c4xx, c5xx, avg_ms, p95_ms
		FROM rollup WHERE minute > ? ORDER BY minute`, sinceMin)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type row struct {
		Service string  `json:"service"`
		Minute  int64   `json:"minute"`
		Count   int     `json:"count"`
		C2xx    int     `json:"c2xx"`
		C4xx    int     `json:"c4xx"`
		C5xx    int     `json:"c5xx"`
		AvgMS   float64 `json:"avg_ms"`
		P95MS   float64 `json:"p95_ms"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		rows.Scan(&x.Service, &x.Minute, &x.Count, &x.C2xx, &x.C4xx, &x.C5xx, &x.AvgMS, &x.P95MS)
		out = append(out, x)
	}
	writeJSON(w, out)
}

// handleLogs: filterable log view. ?service=&level=&q=&before=&limit=
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	before, _ := strconv.ParseInt(q.Get("before"), 10, 64)
	if before <= 0 {
		before = time.Now().UnixMilli() + 1
	}
	sql := `SELECT id, host, service, ts, level, line FROM logs WHERE ts < ?`
	args := []any{before}
	if v := q.Get("service"); v != "" {
		sql += ` AND service = ?`
		args = append(args, v)
	}
	if v := q.Get("level"); v != "" {
		sql += ` AND level = ?`
		args = append(args, v)
	}
	if v := q.Get("q"); v != "" {
		sql += ` AND line LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(v)+"%")
	}
	sql += ` ORDER BY ts DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.store.db.Query(sql, args...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type row struct {
		ID      int64  `json:"id"`
		Host    string `json:"host"`
		Service string `json:"service"`
		TS      int64  `json:"ts"`
		Level   string `json:"level"`
		Line    string `json:"line"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		rows.Scan(&x.ID, &x.Host, &x.Service, &x.TS, &x.Level, &x.Line)
		out = append(out, x)
	}
	writeJSON(w, out)
}

func escapeLike(s string) string {
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' || s[i] == '_' || s[i] == '\\' {
			b = append(b, '\\')
		}
		b = append(b, s[i])
	}
	return string(b)
}
