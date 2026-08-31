package store

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestRemoteAssistAuthorizationTenantIsolationAndLifecycle(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "remote-owner@example.com", "")
	business, err := s.CreateBusiness(ctx, owner.ID, "Remote Co", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	employee := mustUser(t, ctx, s, "remote-employee@example.com", "")
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		employee.ID, business.ID,
	); err != nil {
		t.Fatalf("add employee: %v", err)
	}
	deviceID := uuid.NewString()
	if _, err := s.UpdatePresence(ctx, employee.ID, business.ID, deviceID, "active", nil, nil, 1, nil); err != nil {
		t.Fatalf("seed presence: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE devices SET os='Windows 11 Professional' WHERE id=$1`, deviceID); err != nil {
		t.Fatalf("mark Windows device: %v", err)
	}

	session, err := s.CreateRemoteAssist(ctx, owner.ID, deviceID)
	if err != nil || session.Status != "pending" || session.OwnerUserID != owner.ID {
		t.Fatalf("create session = %#v, %v", session, err)
	}
	if _, err := s.CreateRemoteAssist(ctx, owner.ID, deviceID); !errors.Is(err, ErrConflict) {
		t.Fatalf("second open session err=%v, want conflict", err)
	}
	pending, err := s.PendingRemoteAssist(ctx, employee.ID, deviceID)
	if err != nil || pending == nil || pending.ID != session.ID {
		t.Fatalf("employee pending = %#v, %v", pending, err)
	}

	intruder := mustUser(t, ctx, s, "remote-intruder@example.com", "")
	if _, err := s.RemoteAssistForUser(ctx, intruder.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder session err=%v, want not found", err)
	}
	if _, err := s.DecideRemoteAssist(ctx, intruder.ID, session.ID, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder decision err=%v, want not found", err)
	}

	active, err := s.DecideRemoteAssist(ctx, employee.ID, session.ID, true)
	if err != nil || active.Status != "active" || active.DecidedAt == nil {
		t.Fatalf("accepted session = %#v, %v", active, err)
	}

	payload := json.RawMessage(`{"x":0.25,"y":0.75,"button":"left"}`)
	actionID, err := s.EnqueueRemoteAssistAction(ctx, owner.ID, session.ID, "click", payload)
	if err != nil || actionID == 0 {
		t.Fatalf("enqueue action id=%d err=%v", actionID, err)
	}
	if _, err := s.EnqueueRemoteAssistAction(ctx, intruder.ID, session.ID, "click", payload); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder action err=%v, want not found", err)
	}
	actions, err := s.ConsumeRemoteAssistActions(ctx, employee.ID, session.ID, 0)
	if err != nil || len(actions) != 1 || actions[0].ID != actionID {
		t.Fatalf("consume actions = %#v, %v", actions, err)
	}
	actions, err = s.ConsumeRemoteAssistActions(ctx, employee.ID, session.ID, 0)
	if err != nil || len(actions) != 0 {
		t.Fatalf("action replayed = %#v, %v", actions, err)
	}

	frameBytes := []byte("RIFFfakeWEBP")
	if err := s.SaveRemoteAssistFrame(ctx, employee.ID, session.ID, RemoteAssistFrame{
		Bytes: frameBytes, Width: 1280, Height: 720,
	}); err != nil {
		t.Fatalf("save frame: %v", err)
	}
	frame, err := s.RemoteAssistFrameForOwner(ctx, owner.ID, session.ID)
	if err != nil || string(frame.Bytes) != string(frameBytes) || frame.Width != 1280 {
		t.Fatalf("owner frame = %#v, %v", frame, err)
	}
	if _, err := s.RemoteAssistFrameForOwner(ctx, intruder.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder frame err=%v, want not found", err)
	}

	ended, err := s.EndRemoteAssist(ctx, employee.ID, session.ID)
	if err != nil || ended.Status != "ended" || ended.EndReason == nil || *ended.EndReason != "employee_ended" {
		t.Fatalf("ended session = %#v, %v", ended, err)
	}
	if _, err := s.EnqueueRemoteAssistAction(ctx, owner.ID, session.ID, "click", payload); !errors.Is(err, ErrNotFound) {
		t.Fatalf("post-end action err=%v, want not found", err)
	}
}

func TestRemoteAssistRequiresFreshWindowsDevice(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "remote-platform-owner@example.com", "")
	business, _ := s.CreateBusiness(ctx, owner.ID, "Platform Co", "team")
	employee := mustUser(t, ctx, s, "remote-platform-employee@example.com", "")
	_, _ = s.pool.Exec(ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		employee.ID, business.ID,
	)
	deviceID := uuid.NewString()
	if _, err := s.UpdatePresence(ctx, employee.ID, business.ID, deviceID, "active", nil, nil, 1, nil); err != nil {
		t.Fatalf("seed presence: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE devices SET os='macOS 15' WHERE id=$1`, deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateRemoteAssist(ctx, owner.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("macOS session err=%v, want not found", err)
	}
}
