package store

import (
	"context"
	"errors"
	"testing"

	"ctracking/backend/internal/testutil"
)

func newStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	return New(testutil.Pool(t)), context.Background()
}

func mustUser(t *testing.T, ctx context.Context, s *Store, email, username string) User {
	t.Helper()
	u, err := s.CreateUser(ctx, email, username, "hash", "Display Name", "")
	if err != nil {
		t.Fatalf("create user %q/%q: %v", email, username, err)
	}
	return u
}

func TestCreateUserDefaultsAccountType(t *testing.T) {
	s, ctx := newStore(t)

	u := mustUser(t, ctx, s, "Owner@Example.COM", "")

	if u.AccountType != "manager" {
		t.Fatalf("account_type = %q, want manager", u.AccountType)
	}
	// Identifiers are lowercased on write so login lookups can compare directly.
	if u.Email != "owner@example.com" {
		t.Fatalf("email = %q, want lowercased", u.Email)
	}
	if u.ID == "" {
		t.Fatal("no id returned")
	}
}

func TestCreateUserRejectsDuplicateIdentifier(t *testing.T) {
	s, ctx := newStore(t)
	mustUser(t, ctx, s, "dup@example.com", "")

	_, err := s.CreateUser(ctx, "DUP@example.com", "", "hash", "Other", "")

	if !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

// Blank identifiers are stored as NULL, so two username-only users must not
// collide on an empty email (and vice versa).
func TestCreateUserAllowsManyBlankIdentifiers(t *testing.T) {
	s, ctx := newStore(t)

	mustUser(t, ctx, s, "", "alice")
	mustUser(t, ctx, s, "", "bob")
}

func TestGetUserByIdentifierMatchesEitherField(t *testing.T) {
	s, ctx := newStore(t)
	byEmail := mustUser(t, ctx, s, "owner@example.com", "")
	byName := mustUser(t, ctx, s, "", "worker")

	for _, tc := range []struct {
		identifier string
		want       string
	}{
		{"owner@example.com", byEmail.ID},
		{"  OWNER@example.com  ", byEmail.ID},
		{"worker", byName.ID},
		{"WORKER", byName.ID},
	} {
		got, hash, err := s.GetUserByIdentifier(ctx, tc.identifier)
		if err != nil {
			t.Fatalf("lookup %q: %v", tc.identifier, err)
		}
		if got.ID != tc.want {
			t.Fatalf("lookup %q returned %s, want %s", tc.identifier, got.ID, tc.want)
		}
		if hash != "hash" {
			t.Fatalf("lookup %q returned hash %q", tc.identifier, hash)
		}
	}
}

func TestGetUserByIdentifierUnknown(t *testing.T) {
	s, ctx := newStore(t)

	_, _, err := s.GetUserByIdentifier(ctx, "nobody@example.com")

	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestResolveBusinessForUser(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "owner@example.com", "")
	first, err := s.CreateBusiness(ctx, owner.ID, "First", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}

	t.Run("single membership is implicit", func(t *testing.T) {
		got, err := s.ResolveBusinessForUser(ctx, owner.ID, nil)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if got != first.ID {
			t.Fatalf("resolved %s, want %s", got, first.ID)
		}
	})

	t.Run("explicit membership is honoured", func(t *testing.T) {
		got, err := s.ResolveBusinessForUser(ctx, owner.ID, &first.ID)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if got != first.ID {
			t.Fatalf("resolved %s, want %s", got, first.ID)
		}
	})

	// A user must never be able to file data against a business they don't
	// belong to, even by naming its id explicitly.
	t.Run("foreign business is refused", func(t *testing.T) {
		stranger := mustUser(t, ctx, s, "stranger@example.com", "")
		theirs, err := s.CreateBusiness(ctx, stranger.ID, "Theirs", "team")
		if err != nil {
			t.Fatalf("create business: %v", err)
		}

		_, err = s.ResolveBusinessForUser(ctx, owner.ID, &theirs.ID)

		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})

	t.Run("multiple memberships need an explicit choice", func(t *testing.T) {
		if _, err := s.CreateBusiness(ctx, owner.ID, "Second", "team"); err != nil {
			t.Fatalf("create business: %v", err)
		}

		_, err := s.ResolveBusinessForUser(ctx, owner.ID, nil)

		if !errors.Is(err, ErrAmbiguousBusiness) {
			t.Fatalf("err = %v, want ErrAmbiguousBusiness", err)
		}
	})
}

func TestResolveBusinessForUserWithoutMembership(t *testing.T) {
	s, ctx := newStore(t)
	orphan := mustUser(t, ctx, s, "orphan@example.com", "")

	_, err := s.ResolveBusinessForUser(ctx, orphan.ID, nil)

	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
