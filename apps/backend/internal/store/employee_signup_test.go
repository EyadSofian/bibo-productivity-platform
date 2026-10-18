package store

import (
	"errors"
	"testing"
)

func TestEmployeeSelfEnrollment(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "owner@example.com", "")
	business, err := s.CreateBusiness(ctx, owner.ID, "Example", "team")
	if err != nil {
		t.Fatal(err)
	}
	code, err := s.JoinCode(ctx, business.ID)
	if err != nil || code == "" {
		t.Fatalf("join code = %q, err = %v", code, err)
	}
	if _, err := s.RegisterEmployee(ctx, business.ID, "wrong", "worker@example.com", "hash", "Worker"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong code error = %v, want ErrNotFound", err)
	}
	if got, err := s.ListEmployees(ctx, business.ID); err != nil || len(got) != 0 {
		t.Fatalf("roster after invalid code = %v, %v", got, err)
	}
	emp, err := s.RegisterEmployee(ctx, business.ID, code, "WORKER@Example.COM", "hash", "Worker")
	if err != nil {
		t.Fatal(err)
	}
	if emp.Email != "worker@example.com" {
		t.Fatalf("email = %q", emp.Email)
	}
	if member, err := s.IsMember(ctx, emp.ID, business.ID); err != nil || !member {
		t.Fatalf("membership = %v, %v", member, err)
	}
	if got, err := s.ListEmployees(ctx, business.ID); err != nil || len(got) != 1 || got[0].ID != emp.ID {
		t.Fatalf("roster after enrollment = %v, %v", got, err)
	}
	if _, err := s.RegisterEmployee(ctx, business.ID, code, "worker@example.com", "hash", "Other"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate error = %v, want ErrConflict", err)
	}
	newCode, err := s.RotateJoinCode(ctx, business.ID)
	if err != nil || newCode == code {
		t.Fatalf("rotated code = %q, err = %v", newCode, err)
	}
	if _, err := s.RegisterEmployee(ctx, business.ID, code, "second@example.com", "hash", "Second"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old code error = %v, want ErrNotFound", err)
	}
	if _, err := s.RegisterEmployee(ctx, business.ID, newCode, "second@example.com", "hash", "Second"); err != nil {
		t.Fatalf("new code enrollment: %v", err)
	}
}
