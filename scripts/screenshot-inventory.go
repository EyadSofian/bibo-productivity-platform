// Read-only inventory of the retired still-screenshot store.
//
// Slice V02 stops NEW screenshot collection. What already exists is a separate,
// destructive decision that belongs to whoever owns the data, so this program
// only counts and measures: it opens no write transaction, and deletes nothing.
// Its output is the input to that decision (backlog slice V12).
//
// Run it from apps/backend so the module's pgx dependency resolves:
//
//	DATABASE_URL=postgres://... STORAGE_DIR=/srv/ctracking/storage \
//	  go run ../../scripts/screenshot-inventory.go
//
// STORAGE_DIR is optional. Without it the database side is still reported, which
// is the part that matters on a host where the blobs live on a mounted volume.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx := context.Background()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(2)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	fmt.Println("Still-screenshot inventory")
	fmt.Println("==========================")
	fmt.Printf("taken at   %s\n\n", time.Now().UTC().Format(time.RFC3339))

	reportTotals(ctx, pool)
	reportPerBusiness(ctx, pool)
	reportRecent(ctx, pool)

	if dir := os.Getenv("STORAGE_DIR"); dir != "" {
		reportDisk(filepath.Join(dir, "screenshots"))
	} else {
		fmt.Println("\nOn disk: skipped (STORAGE_DIR not set)")
	}

	fmt.Println("\nNothing was modified or deleted. Deletion is slice V12 and needs")
	fmt.Println("an explicit decision from the data owner first.")
}

func reportTotals(ctx context.Context, pool *pgxpool.Pool) {
	var rows, bytes int64
	var oldest, newest *time.Time
	err := pool.QueryRow(ctx, `
		SELECT count(*),
		       coalesce(sum(byte_size), 0),
		       to_timestamp(min(ts)),
		       to_timestamp(max(ts))
		  FROM screenshots`).Scan(&rows, &bytes, &oldest, &newest)
	if err != nil {
		fmt.Fprintf(os.Stderr, "totals: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("In Postgres (metadata)")
	fmt.Printf("  rows          %d\n", rows)
	fmt.Printf("  bytes         %s\n", humanBytes(bytes))
	fmt.Printf("  oldest        %s\n", stamp(oldest))
	fmt.Printf("  newest        %s\n", stamp(newest))

	// The decisive number for "has V02 actually stopped collection": anything
	// arriving after the rollout means an agent is still capturing.
	var lastDay int64
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM screenshots
		 WHERE received_at > now() - interval '24 hours'`).Scan(&lastDay); err != nil {
		fmt.Fprintf(os.Stderr, "recent count: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  last 24h      %d", lastDay)
	if lastDay > 0 {
		fmt.Print("   <-- still arriving: V02 has not finished rolling out")
	}
	fmt.Println()
}

func reportPerBusiness(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := pool.Query(ctx, `
		SELECT business_id::text,
		       count(*),
		       coalesce(sum(byte_size), 0),
		       to_timestamp(min(ts))
		  FROM screenshots
		 GROUP BY business_id
		 ORDER BY count(*) DESC
		 LIMIT 50`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "per business: %v\n", err)
		os.Exit(1)
	}
	defer rows.Close()

	fmt.Println("\nPer business (top 50 by row count)")
	any := false
	for rows.Next() {
		var id string
		var n, bytes int64
		var oldest *time.Time
		if err := rows.Scan(&id, &n, &bytes, &oldest); err != nil {
			fmt.Fprintf(os.Stderr, "scan: %v\n", err)
			os.Exit(1)
		}
		any = true
		fmt.Printf("  %s  %8d rows  %10s  since %s\n", id, n, humanBytes(bytes), stamp(oldest))
	}
	if err := rows.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "iterate: %v\n", err)
		os.Exit(1)
	}
	if !any {
		fmt.Println("  (none)")
	}
}

// reportRecent shows the arrival pattern over the rollout window, so "collection
// stopped" can be read off a trend rather than asserted from a single total.
func reportRecent(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := pool.Query(ctx, `
		SELECT date_trunc('day', received_at)::date::text, count(*)
		  FROM screenshots
		 WHERE received_at > now() - interval '14 days'
		 GROUP BY 1
		 ORDER BY 1 DESC`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "recent: %v\n", err)
		os.Exit(1)
	}
	defer rows.Close()

	fmt.Println("\nArrivals per day (last 14 days)")
	any := false
	for rows.Next() {
		var day string
		var n int64
		if err := rows.Scan(&day, &n); err != nil {
			fmt.Fprintf(os.Stderr, "scan: %v\n", err)
			os.Exit(1)
		}
		any = true
		fmt.Printf("  %s  %8d\n", day, n)
	}
	if err := rows.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "iterate: %v\n", err)
		os.Exit(1)
	}
	if !any {
		fmt.Println("  (none — no screenshot has been accepted in 14 days)")
	}
}

func reportDisk(root string) {
	var files, bytes int64
	var oldest, newest time.Time

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		files++
		bytes += info.Size()
		mod := info.ModTime()
		if oldest.IsZero() || mod.Before(oldest) {
			oldest = mod
		}
		if mod.After(newest) {
			newest = mod
		}
		return nil
	})

	fmt.Printf("\nOn disk (%s)\n", root)
	if os.IsNotExist(err) {
		fmt.Println("  directory does not exist — no blobs on this host")
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "walk: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("  files         %d\n", files)
	fmt.Printf("  bytes         %s\n", humanBytes(bytes))
	if files > 0 {
		fmt.Printf("  oldest mtime  %s\n", oldest.UTC().Format(time.RFC3339))
		fmt.Printf("  newest mtime  %s\n", newest.UTC().Format(time.RFC3339))
	}
}

func stamp(t *time.Time) string {
	if t == nil {
		return "—"
	}
	return t.UTC().Format(time.RFC3339)
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
