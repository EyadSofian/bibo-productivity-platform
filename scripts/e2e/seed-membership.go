package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	userID, businessID := os.Args[1], os.Args[2]
	if _, err := pool.Exec(ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')
		 ON CONFLICT DO NOTHING`, userID, businessID); err != nil {
		panic(err)
	}
	fmt.Println("membership seeded")
}
