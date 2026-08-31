// Measures the Postgres cost of the live-frame path, before and after moving
// frames out of the database. Run against a scratch database.
package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const frames = 200

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("MEASURE_DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	mustExec(ctx, pool, `DROP TABLE IF EXISTS measure_frames`)
	mustExec(ctx, pool, `DROP TABLE IF EXISTS measure_sessions`)
	mustExec(ctx, pool, `CREATE TABLE measure_sessions (
		id bigserial PRIMARY KEY, status text NOT NULL DEFAULT 'active',
		expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
		last_frame_at timestamptz)`)
	mustExec(ctx, pool, `CREATE TABLE measure_frames (
		session_id bigint PRIMARY KEY REFERENCES measure_sessions(id),
		received_at timestamptz NOT NULL DEFAULT now(),
		width integer NOT NULL, height integer NOT NULL,
		mime_type text NOT NULL, image bytea NOT NULL)`)
	mustExec(ctx, pool, `INSERT INTO measure_sessions (id) VALUES (1)`)

	// A realistic worst-case frame from the audit: 178 KiB of WebP. WebP is
	// already compressed, so the bytes must be incompressible -- a repeating
	// pattern would be shrunk by TOAST's pglz and understate the real cost.
	image := make([]byte, 178*1024)
	if _, err := rand.Read(image); err != nil {
		panic(err)
	}

	fmt.Printf("=== live-frame Postgres cost over %d frames (178 KiB each) ===\n\n", frames)

	// --- OLD PATH: upsert the blob per frame ---
	walBefore := lsn(ctx, pool)
	sizeBefore := relSize(ctx, pool, "measure_frames")
	start := time.Now()
	for i := 0; i < frames; i++ {
		if _, err := rand.Read(image); err != nil {
			panic(err)
		}
		mustExec(ctx, pool, `
			INSERT INTO measure_frames (session_id, width, height, mime_type, image)
			SELECT s.id, $2, $3, 'image/webp', $4 FROM measure_sessions s
			 WHERE s.id = $1 AND s.status='active' AND s.expires_at > now()
			ON CONFLICT (session_id) DO UPDATE
			  SET received_at=now(), width=EXCLUDED.width, height=EXCLUDED.height,
			      mime_type=EXCLUDED.mime_type, image=EXCLUDED.image`,
			1, 1600, 900, image)
		mustExec(ctx, pool, `UPDATE measure_sessions SET last_frame_at=now() WHERE id=$1 AND status='active'`, 1)
	}
	oldElapsed := time.Since(start)
	oldWAL := lsn(ctx, pool) - walBefore
	oldSize := relSize(ctx, pool, "measure_frames") - sizeBefore

	report("OLD  frames in bytea", oldWAL, oldSize, oldElapsed)

	// --- NEW PATH: authorize per frame, persist bookkeeping every ~10s ---
	// At the agent's 900ms frame interval, 200 frames is ~180s, so a 10s
	// throttle yields ~18 bookkeeping writes.
	mustExec(ctx, pool, `VACUUM FULL measure_frames`)
	walBefore = lsn(ctx, pool)
	sizeBefore = relSize(ctx, pool, "measure_frames")
	start = time.Now()
	for i := 0; i < frames; i++ {
		var ok bool
		if err := pool.QueryRow(ctx, `
			SELECT true FROM measure_sessions s
			 WHERE s.id=$1 AND s.status='active' AND s.expires_at > now()`, 1).Scan(&ok); err != nil {
			panic(err)
		}
		if i%11 == 0 {
			mustExec(ctx, pool, `UPDATE measure_sessions SET last_frame_at=now() WHERE id=$1 AND status='active'`, 1)
		}
	}
	newElapsed := time.Since(start)
	newWAL := lsn(ctx, pool) - walBefore
	newSize := relSize(ctx, pool, "measure_frames") - sizeBefore

	report("NEW  frames in memory", newWAL, newSize, newElapsed)

	fmt.Printf("\nWAL reduction:            %.0fx  (%s -> %s)\n",
		float64(oldWAL)/float64(max64(newWAL, 1)), human(oldWAL), human(newWAL))
	fmt.Printf("frame-table growth:       %s -> %s\n", human(oldSize), human(newSize))
	fmt.Printf("WAL per frame:            %s -> %s\n",
		human(oldWAL/frames), human(newWAL/frames))

	mustExec(ctx, pool, `DROP TABLE measure_frames`)
	mustExec(ctx, pool, `DROP TABLE measure_sessions`)
}

func report(label string, wal, size int64, elapsed time.Duration) {
	fmt.Printf("%-24s WAL %10s   table growth %10s   %6.1f ms/frame\n",
		label, human(wal), human(size), float64(elapsed.Microseconds())/float64(frames)/1000)
}

func mustExec(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) {
	if _, err := pool.Exec(ctx, sql, args...); err != nil {
		panic(fmt.Sprintf("%s: %v", sql, err))
	}
}

func lsn(ctx context.Context, pool *pgxpool.Pool) int64 {
	var v int64
	if err := pool.QueryRow(ctx, `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint`).Scan(&v); err != nil {
		panic(err)
	}
	return v
}

func relSize(ctx context.Context, pool *pgxpool.Pool, table string) int64 {
	var v int64
	if err := pool.QueryRow(ctx, `SELECT pg_total_relation_size($1)`, table).Scan(&v); err != nil {
		panic(err)
	}
	return v
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func human(b int64) string {
	switch {
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(b)/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(b)/(1<<10))
	default:
		return fmt.Sprintf("%d B", b)
	}
}
