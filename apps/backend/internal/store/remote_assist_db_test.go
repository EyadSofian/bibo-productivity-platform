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

	// Frame bytes live in internal/live, not Postgres; what the store still
	// owns is the permission decision on both ends of the live path.
	if err := s.AuthorizeRemoteAssistFrame(ctx, employee.ID, session.ID); err != nil {
		t.Fatalf("employee frame upload authorization: %v", err)
	}
	if err := s.AuthorizeRemoteAssistFrame(ctx, intruder.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder frame upload err=%v, want not found", err)
	}
	if err := s.AuthorizeRemoteAssistViewer(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("owner viewer authorization: %v", err)
	}
	if err := s.AuthorizeRemoteAssistViewer(ctx, intruder.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder viewer err=%v, want not found", err)
	}
	// The employee uploads and the owner watches: neither may take the other's role.
	if err := s.AuthorizeRemoteAssistFrame(ctx, owner.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner uploading as employee err=%v, want not found", err)
	}
	if err := s.AuthorizeRemoteAssistViewer(ctx, employee.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("employee watching as owner err=%v, want not found", err)
	}
	if err := s.MarkRemoteAssistFrameAt(ctx, employee.ID, session.ID); err != nil {
		t.Fatalf("mark last_frame_at: %v", err)
	}

	ended, err := s.EndRemoteAssist(ctx, employee.ID, session.ID)
	if err != nil || ended.Status != "ended" || ended.EndReason == nil || *ended.EndReason != "employee_ended" {
		t.Fatalf("ended session = %#v, %v", ended, err)
	}
	if _, err := s.EnqueueRemoteAssistAction(ctx, owner.ID, session.ID, "click", payload); !errors.Is(err, ErrNotFound) {
		t.Fatalf("post-end action err=%v, want not found", err)
	}
	if err := s.AuthorizeRemoteAssistFrame(ctx, employee.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("post-end frame upload err=%v, want not found", err)
	}
	if err := s.AuthorizeRemoteAssistViewer(ctx, owner.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("post-end viewer err=%v, want not found", err)
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

// TestLiveSessionDoesNotGrowPostgres is the regression guard for the P03 exit
// gate ("no new frames in bytea") and audit item P1-1. Routing frames through
// remote_assist_frames.image cost a measured 12-36 MB of dead TOAST and ~65 KiB
// of WAL per frame (FULL_SYSTEM_AUDIT §3.3) for data discarded within seconds.
//
// It drives the store side of a live session the way the handler does and
// asserts the frame table is never touched. If someone reintroduces a blob
// write on this path, this fails.
func TestLiveSessionDoesNotGrowPostgres(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "live-size-owner@example.com", "")
	business, err := s.CreateBusiness(ctx, owner.ID, "Live Size Co", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	employee := mustUser(t, ctx, s, "live-size-employee@example.com", "")
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
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := s.DecideRemoteAssist(ctx, employee.ID, session.ID, true); err != nil {
		t.Fatalf("accept session: %v", err)
	}

	relSize := func() int64 {
		var size int64
		if err := s.pool.QueryRow(ctx,
			`SELECT pg_total_relation_size('remote_assist_frames')`).Scan(&size); err != nil {
			t.Fatalf("relation size: %v", err)
		}
		return size
	}
	rowCount := func() int64 {
		var n int64
		if err := s.pool.QueryRow(ctx,
			`SELECT count(*) FROM remote_assist_frames`).Scan(&n); err != nil {
			t.Fatalf("row count: %v", err)
		}
		return n
	}

	sizeBefore, rowsBefore := relSize(), rowCount()

	// 200 frames: the same count the audit measured at 12-36 MB of growth.
	const frames = 200
	for i := 0; i < frames; i++ {
		if err := s.AuthorizeRemoteAssistFrame(ctx, employee.ID, session.ID); err != nil {
			t.Fatalf("frame %d authorization: %v", i, err)
		}
	}
	// Durable bookkeeping is throttled by the handler; do it once, as a ~10s
	// interval over a 200-frame session would.
	if err := s.MarkRemoteAssistFrameAt(ctx, employee.ID, session.ID); err != nil {
		t.Fatalf("mark last_frame_at: %v", err)
	}

	if got := relSize(); got != sizeBefore {
		t.Errorf("remote_assist_frames grew by %d bytes over %d frames; live frames must not reach Postgres",
			got-sizeBefore, frames)
	}
	if got := rowCount(); got != rowsBefore {
		t.Errorf("remote_assist_frames gained %d rows over %d frames", got-rowsBefore, frames)
	}
}
