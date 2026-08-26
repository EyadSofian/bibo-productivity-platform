// Package testutil provides a disposable Postgres for store and handler tests.
//
// Tests skip themselves when TEST_DATABASE_URL is unset, so `go test ./...` still
// works on a machine with no database. CI sets it (see .github/workflows/ci.yml).
package testutil

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"ctracking/backend/internal/db"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// batchLockID namespaces the advisory lock that serializes database tests.
const batchLockID = 0x62_74_72_6B // "btrk"

// lockWait bounds how long one test waits for another package's test to finish.
const lockWait = 60 * time.Second

var (
	initOnce sync.Once
	shared   *pgxpool.Pool
	initErr  error
)

// Pool returns a migrated, empty database. Every table is truncated before the
// test runs, and the test holds an advisory lock for its duration.
//
// The lock matters: `go test ./...` runs each package's binary concurrently, and
// they all share one database. Without it, one package's truncate would delete
// rows another package was mid-assertion on — a flake that only appears under
// load and reads like a logic bug.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is unset; skipping test that needs Postgres")
	}

	initOnce.Do(func() {
		if initErr = db.Migrate(dsn); initErr != nil {
			return
		}
		shared, initErr = db.Connect(context.Background(), dsn)
	})
	if initErr != nil {
		t.Fatalf("prepare test database: %v", initErr)
	}

	lock(t, shared)
	truncateAll(t, shared)
	return shared
}

// lock takes a session-scoped advisory lock. It has to be held on one dedicated
// connection, since Postgres releases the lock with the session that took it.
//
// The wait is bounded so the wait-forever case fails with a readable message.
// Calling Pool twice inside one test is the way to hit it: the second call takes
// a different pooled connection, which is a different session, so it blocks on a
// lock its own test already holds.
func lock(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), lockWait)
	defer cancel()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire connection for advisory lock: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, batchLockID); err != nil {
		conn.Release()
		t.Fatalf("take advisory lock after %s — is this test calling Pool twice? %v", lockWait, err)
	}

	t.Cleanup(func() {
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, batchLockID); err != nil {
			t.Errorf("release advisory lock: %v", err)
		}
		conn.Release()
	})
}

// truncateAll empties every application table, discovered from the catalog so a
// new migration needs no change here. goose's own bookkeeping table is kept.
func truncateAll(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	rows, err := pool.Query(ctx,
		`SELECT tablename FROM pg_tables
		  WHERE schemaname = 'public' AND tablename <> 'goose_db_version'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		names = append(names, pgx.Identifier{name}.Sanitize())
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("list tables: %v", err)
	}
	if len(names) == 0 {
		return
	}

	if _, err := pool.Exec(ctx,
		`TRUNCATE `+strings.Join(names, ", ")+` RESTART IDENTITY CASCADE`); err != nil {
		t.Fatalf("truncate tables: %v", err)
	}
}
