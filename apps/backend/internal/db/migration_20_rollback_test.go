package db

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A migration that cannot be rolled back is a one-way door, and this one creates
// the tables the whole media plane depends on. The test applies the Down section
// and then re-applies Up through the real migrator -- which is exactly what a
// rollback followed by a redeploy does.
func TestMigration20RollsBackAndReapplies(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is unset; skipping test that needs Postgres")
	}
	ctx := context.Background()

	if err := Migrate(dsn); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	// Share the store/handler test lock while rolling back shared tables.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(0x62_74_72_6B)); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, int64(0x62_74_72_6B)) }()

	if got := mediaTableCount(t, ctx, pool); got != 4 {
		t.Fatalf("media tables before rollback = %d, want 4", got)
	}

	// The Down section of 00020_media_control_plane.sql, verbatim, plus the
	// goose bookkeeping the migrator would remove.
	for _, stmt := range []string{
		`DROP INDEX idx_viewer_sessions_lease`,
		`ALTER TABLE viewer_sessions DROP COLUMN last_seen_at`,
		`DROP TABLE media_audit_events`,
		`DROP TABLE viewer_sessions`,
		`DROP TABLE media_tracks`,
		`DROP TABLE media_sessions`,
		`DELETE FROM goose_db_version WHERE version_id IN (20,21)`,
	} {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("rollback %q: %v", stmt, err)
		}
	}
	if got := mediaTableCount(t, ctx, pool); got != 0 {
		t.Fatalf("media tables after rollback = %d, want 0", got)
	}

	if err := Migrate(dsn); err != nil {
		t.Fatalf("re-migrate after rollback: %v", err)
	}
	if got := mediaTableCount(t, ctx, pool); got != 4 {
		t.Errorf("media tables after re-applying = %d, want 4", got)
	}
	var leases int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='viewer_sessions' AND column_name='last_seen_at'`).Scan(&leases); err != nil || leases != 1 {
		t.Fatalf("viewer lease migration did not reapply: count=%d err=%v", leases, err)
	}
}

func mediaTableCount(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM information_schema.tables
		 WHERE table_schema = 'public'
		   AND table_name IN ('media_sessions','media_tracks','viewer_sessions','media_audit_events')`).Scan(&n); err != nil {
		t.Fatalf("count media tables: %v", err)
	}
	return n
}
