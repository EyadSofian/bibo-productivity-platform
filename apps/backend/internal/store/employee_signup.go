package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// JoinCode is read only by the owner. The UUID is a bearer invitation secret;
// employees enter it once when they create their own account.
func (s *Store) JoinCode(ctx context.Context, businessID string) (string, error) {
	var code string
	err := s.pool.QueryRow(ctx, `SELECT join_code FROM businesses WHERE id = $1`, businessID).Scan(&code)
	if errors.Is(err, pgx.ErrNoRows) || invalidUUID(err) {
		return "", ErrNotFound
	}
	return code, err
}

func (s *Store) RotateJoinCode(ctx context.Context, businessID string) (string, error) {
	var code string
	err := s.pool.QueryRow(ctx,
		`UPDATE businesses SET join_code = gen_random_uuid() WHERE id = $1 RETURNING join_code`,
		businessID).Scan(&code)
	if errors.Is(err, pgx.ErrNoRows) || invalidUUID(err) {
		return "", ErrNotFound
	}
	return code, err
}

// RegisterEmployee creates the user and employee membership together. A join
// code, which is not returned by public APIs, authorizes immediate enrollment.
func (s *Store) RegisterEmployee(ctx context.Context, businessID, joinCode, email, hash, displayName string) (Employee, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Employee{}, err
	}
	defer tx.Rollback(ctx)
	var matchedID string
	err = tx.QueryRow(ctx,
		`SELECT id FROM businesses WHERE id = $1 AND join_code = $2 FOR SHARE`,
		businessID, joinCode).Scan(&matchedID)
	if errors.Is(err, pgx.ErrNoRows) || invalidUUID(err) {
		return Employee{}, ErrNotFound
	}
	if err != nil {
		return Employee{}, err
	}
	var emp Employee
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, display_name)
		 VALUES ($1, $2, $3) RETURNING id, email, display_name`,
		normalizeEmail(email), hash, displayName).Scan(&emp.ID, &emp.Email, &emp.DisplayName)
	if isUniqueViolation(err) {
		return Employee{}, ErrConflict
	}
	if err != nil {
		return Employee{}, err
	}
	if _, err = tx.Exec(ctx,
		`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'employee')`,
		emp.ID, businessID); err != nil {
		return Employee{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Employee{}, err
	}
	return emp, nil
}

func invalidUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}
