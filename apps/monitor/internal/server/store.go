package server

import (
	"database/sql"
	"sort"
	"time"

	_ "modernc.org/sqlite"

	"ctracking/monitor/internal/wire"
)

const schema = `
CREATE TABLE IF NOT EXISTS metrics (
  host TEXT NOT NULL, ts INTEGER NOT NULL,
  cpu REAL, mem REAL, disk REAL, load1 REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(host, ts);

CREATE TABLE IF NOT EXISTS unit_state (
  host TEXT NOT NULL, unit TEXT NOT NULL, ts INTEGER NOT NULL,
  active INTEGER NOT NULL, state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unit_state ON unit_state(host, unit, ts);

CREATE TABLE IF NOT EXISTS requests (
  service TEXT NOT NULL, ts INTEGER NOT NULL,
  status INTEGER NOT NULL, dur_ms REAL NOT NULL, method TEXT, path TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests ON requests(service, ts);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);

CREATE TABLE IF NOT EXISTS rollup (
  service TEXT NOT NULL, minute INTEGER NOT NULL,
  count INTEGER NOT NULL, c2xx INTEGER NOT NULL, c4xx INTEGER NOT NULL, c5xx INTEGER NOT NULL,
  avg_ms REAL NOT NULL, p95_ms REAL NOT NULL,
  PRIMARY KEY (service, minute)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL, service TEXT NOT NULL, ts INTEGER NOT NULL,
  level TEXT NOT NULL, line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs ON logs(service, ts);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

CREATE TABLE IF NOT EXISTS probes (
  target TEXT NOT NULL, ts INTEGER NOT NULL,
  up INTEGER NOT NULL, ms REAL NOT NULL, code INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probes ON probes(target, ts);

CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  first_true INTEGER NOT NULL,
  firing INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

type Store struct {
	db *sql.DB
}

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	// SQLite writes must be serialized; a single connection avoids SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) InsertBatch(b *wire.Batch) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, m := range b.Metrics {
		if _, err := tx.Exec(`INSERT INTO metrics (host, ts, cpu, mem, disk, load1) VALUES (?,?,?,?,?,?)`,
			b.Host, m.TS, m.CPUPct, m.MemPct, m.DiskPct, m.Load1); err != nil {
			return err
		}
	}
	for _, u := range b.Units {
		if _, err := tx.Exec(`INSERT INTO unit_state (host, unit, ts, active, state) VALUES (?,?,?,?,?)`,
			b.Host, u.Unit, u.TS, boolInt(u.Active), u.State); err != nil {
			return err
		}
	}
	minMinute := int64(0)
	for _, r := range b.Requests {
		if _, err := tx.Exec(`INSERT INTO requests (service, ts, status, dur_ms, method, path) VALUES (?,?,?,?,?,?)`,
			r.Service, r.TS, r.Status, r.DurMS, r.Method, r.Path); err != nil {
			return err
		}
		if m := r.TS / 60000; minMinute == 0 || m < minMinute {
			minMinute = m
		}
	}
	// Late-arriving requests (spool drained after a tunnel outage) may be older
	// than the rollup watermark; rewind it so those minutes get re-aggregated
	// (rollup uses INSERT OR REPLACE, so re-rolling is idempotent).
	if minMinute > 0 {
		if _, err := tx.Exec(`UPDATE meta SET value = ? WHERE key='last_rollup_minute' AND CAST(value AS INTEGER) >= ?`,
			minMinute-1, minMinute); err != nil {
			return err
		}
	}
	for _, l := range b.Logs {
		if _, err := tx.Exec(`INSERT INTO logs (host, service, ts, level, line) VALUES (?,?,?,?,?)`,
			b.Host, l.Service, l.TS, l.Level, l.Line); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// rollupClosedMinutes aggregates raw requests into per-minute rows for every
// minute that has fully closed since the last run. Keepalive requests are
// counted but excluded from avg/p95 (their 30-120s burn would poison latency).
func (s *Store) rollupClosedMinutes(keepalivePath string, now time.Time) error {
	var last int64
	s.db.QueryRow(`SELECT value FROM meta WHERE key='last_rollup_minute'`).Scan(&last)
	current := now.UnixMilli() / 60000
	if last == 0 {
		last = current - 10 // cold start: pick up the recent past
	}
	for m := last + 1; m < current-1; m++ {
		rows, err := s.db.Query(`SELECT service, status, dur_ms, path FROM requests WHERE ts >= ? AND ts < ?`,
			m*60000, (m+1)*60000)
		if err != nil {
			return err
		}
		type agg struct {
			count, c2xx, c4xx, c5xx int
			durs                    []float64
		}
		byService := map[string]*agg{}
		for rows.Next() {
			var service, path string
			var status int
			var dur float64
			if err := rows.Scan(&service, &status, &dur, &path); err != nil {
				rows.Close()
				return err
			}
			a := byService[service]
			if a == nil {
				a = &agg{}
				byService[service] = a
			}
			a.count++
			switch {
			case status >= 500:
				a.c5xx++
			case status >= 400:
				a.c4xx++
			default:
				a.c2xx++
			}
			if path != keepalivePath {
				a.durs = append(a.durs, dur)
			}
		}
		rows.Close()
		for service, a := range byService {
			var avg, p95 float64
			if len(a.durs) > 0 {
				sort.Float64s(a.durs)
				sum := 0.0
				for _, d := range a.durs {
					sum += d
				}
				avg = sum / float64(len(a.durs))
				p95 = a.durs[(len(a.durs)*95)/100]
			}
			if _, err := s.db.Exec(`INSERT OR REPLACE INTO rollup (service, minute, count, c2xx, c4xx, c5xx, avg_ms, p95_ms)
				VALUES (?,?,?,?,?,?,?,?)`, service, m, a.count, a.c2xx, a.c4xx, a.c5xx, avg, p95); err != nil {
				return err
			}
		}
	}
	_, err := s.db.Exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_rollup_minute', ?)`, current-2)
	return err
}

func (s *Store) prune(retentionDays, rawRequestHours int, now time.Time) {
	cut30 := now.AddDate(0, 0, -retentionDays).UnixMilli()
	cutRaw := now.Add(-time.Duration(rawRequestHours) * time.Hour).UnixMilli()
	s.db.Exec(`DELETE FROM requests WHERE ts < ?`, cutRaw)
	s.db.Exec(`DELETE FROM logs WHERE ts < ?`, cut30)
	s.db.Exec(`DELETE FROM metrics WHERE ts < ?`, cut30)
	s.db.Exec(`DELETE FROM probes WHERE ts < ?`, cut30)
	s.db.Exec(`DELETE FROM unit_state WHERE ts < ?`, cut30)
	s.db.Exec(`DELETE FROM rollup WHERE minute < ?`, cut30/60000)
}
