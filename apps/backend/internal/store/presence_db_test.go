package store

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestPresenceLifecycle(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "presence-owner@example.com", "")
	business, err := s.CreateBusiness(ctx, owner.ID, "Presence Co", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	employee := mustUser(t, ctx, s, "presence-employee@example.com", "")
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		employee.ID, business.ID,
	); err != nil {
		t.Fatalf("add employee: %v", err)
	}

	deviceID := uuid.NewString()
	app, title := "Google Chrome", "BiBoTracking — admin"
	resources := &ResourceSnapshot{
		CPUPct: 23.5, MemoryUsedBytes: 4_000, MemoryTotalBytes: 8_000,
		DiskUsedBytes: 20_000, DiskTotalBytes: 100_000,
		NetworkRxBPS: 5_000, NetworkTxBPS: 800,
	}
	enabled, err := s.UpdatePresence(
		ctx, employee.ID, business.ID, deviceID, "active", &app, &title, 1234, resources,
	)
	if err != nil {
		t.Fatalf("update presence: %v", err)
	}
	if !enabled {
		t.Fatal("new device unexpectedly disabled")
	}

	presence, err := s.PresenceForOwner(ctx, owner.ID, employee.ID)
	if err != nil {
		t.Fatalf("read presence: %v", err)
	}
	if presence.State != "active" || presence.App == nil || *presence.App != app {
		t.Fatalf("presence = %#v", presence)
	}
	if presence.Since == nil || *presence.Since != 1234 || presence.SeenAt == nil {
		t.Fatalf("timestamps = %#v", presence)
	}
	if presence.Resources == nil || presence.Resources.CPUPct != 23.5 ||
		presence.Resources.NetworkRxBPS != 5_000 || presence.Resources.SeenAt == nil {
		t.Fatalf("resources = %#v", presence.Resources)
	}

	// Repeating the same signal refreshes seen_at without resetting "since".
	if _, err := s.UpdatePresence(
		ctx, employee.ID, business.ID, deviceID, "active", &app, &title, 9999, resources,
	); err != nil {
		t.Fatalf("refresh presence: %v", err)
	}
	presence, err = s.PresenceForOwner(ctx, owner.ID, employee.ID)
	if err != nil {
		t.Fatalf("read refreshed presence: %v", err)
	}
	if presence.Since == nil || *presence.Since != 1234 {
		t.Fatalf("same signal reset since: %#v", presence.Since)
	}
}

func TestPresencePrivacyAndOfflineBoundary(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "privacy-owner@example.com", "")
	business, err := s.CreateBusiness(ctx, owner.ID, "Privacy Co", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	employee := mustUser(t, ctx, s, "privacy-employee@example.com", "")
	if _, err := s.pool.Exec(ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		employee.ID, business.ID,
	); err != nil {
		t.Fatalf("add employee: %v", err)
	}
	deviceID := uuid.NewString()
	app := "Private App"
	resources := &ResourceSnapshot{
		CPUPct: 12, MemoryUsedBytes: 1_000, MemoryTotalBytes: 2_000,
		DiskUsedBytes: 4_000, DiskTotalBytes: 8_000,
		NetworkRxBPS: 600, NetworkTxBPS: 100,
	}
	if _, err := s.UpdatePresence(ctx, employee.ID, business.ID, deviceID, "active", &app, nil, 100, resources); err != nil {
		t.Fatalf("seed presence: %v", err)
	}
	if _, err := s.SetDeviceMonitoring(ctx, owner.ID, deviceID, false); err != nil {
		t.Fatalf("disable monitoring: %v", err)
	}
	presence, err := s.PresenceForOwner(ctx, owner.ID, employee.ID)
	if err != nil {
		t.Fatalf("read immediately paused presence: %v", err)
	}
	if presence.State != "online" || presence.App != nil || presence.Resources != nil {
		t.Fatalf("disabling did not immediately clear live data: %#v", presence)
	}
	enabled, err := s.UpdatePresence(ctx, employee.ID, business.ID, deviceID, "active", &app, nil, 200, nil)
	if err != nil {
		t.Fatalf("paused heartbeat: %v", err)
	}
	if enabled {
		t.Fatal("disabled device reported enabled")
	}
	presence, err = s.PresenceForOwner(ctx, owner.ID, employee.ID)
	if err != nil {
		t.Fatalf("read paused presence: %v", err)
	}
	if presence.State != "online" || presence.App != nil || presence.Resources != nil {
		t.Fatalf("paused device leaked app: %#v", presence)
	}

	if _, err := s.pool.Exec(ctx,
		`UPDATE devices SET presence_seen_at = now() - interval '2 minutes' WHERE id=$1`,
		deviceID,
	); err != nil {
		t.Fatalf("age heartbeat: %v", err)
	}
	presence, err = s.PresenceForOwner(ctx, owner.ID, employee.ID)
	if err != nil {
		t.Fatalf("read stale presence: %v", err)
	}
	if presence.State != "offline" || presence.App != nil || presence.WindowTitle != nil {
		t.Fatalf("stale heartbeat presented as live: %#v", presence)
	}
}

func TestPresenceRejectsForeignOwnerAndDeviceClaim(t *testing.T) {
	s, ctx := newStore(t)
	owner := mustUser(t, ctx, s, "one@example.com", "")
	business, _ := s.CreateBusiness(ctx, owner.ID, "One", "team")
	employee := mustUser(t, ctx, s, "worker@example.com", "")
	_, _ = s.pool.Exec(ctx,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		employee.ID, business.ID,
	)
	deviceID := uuid.NewString()
	if _, err := s.UpdatePresence(ctx, employee.ID, business.ID, deviceID, "active", nil, nil, 1, nil); err != nil {
		t.Fatalf("seed presence: %v", err)
	}

	stranger := mustUser(t, ctx, s, "stranger-presence@example.com", "")
	otherBusiness, _ := s.CreateBusiness(ctx, stranger.ID, "Other", "team")
	if _, err := s.PresenceForOwner(ctx, stranger.ID, employee.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("foreign read err = %v, want forbidden", err)
	}
	if _, err := s.UpdatePresence(ctx, stranger.ID, otherBusiness.ID, deviceID, "active", nil, nil, 2, nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("device claim err = %v, want forbidden", err)
	}
}
