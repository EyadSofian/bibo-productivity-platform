package store

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// Sets up an owner, an employee with a live device, and an unrelated intruder.
func seedLiveViewDevice(t *testing.T) (s *Store, ctx context.Context, owner, employee, intruder User, deviceID string) {
	t.Helper()
	store, c := newStore(t)
	o := mustUser(t, c, store, "liveview-owner@example.com", "")
	business, err := store.CreateBusiness(c, o.ID, "Live View Co", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	e := mustUser(t, c, store, "liveview-employee@example.com", "")
	if _, err := store.pool.Exec(c,
		`INSERT INTO memberships (user_id,business_id,role) VALUES ($1,$2,'employee')`,
		e.ID, business.ID,
	); err != nil {
		t.Fatalf("add employee: %v", err)
	}
	id := uuid.NewString()
	if _, err := store.UpdatePresence(c, e.ID, business.ID, id, "active", nil, nil, 1, nil); err != nil {
		t.Fatalf("seed presence: %v", err)
	}
	i := mustUser(t, c, store, "liveview-intruder@example.com", "")
	return store, c, o, e, i, id
}

func TestAuthorizeLiveViewIsOwnerScoped(t *testing.T) {
	s, ctx, owner, employee, intruder, deviceID := seedLiveViewDevice(t)

	if err := s.AuthorizeLiveView(ctx, owner.ID, deviceID); err != nil {
		t.Fatalf("owner live view: %v", err)
	}
	// The employee whose screen it is is not a viewer of it.
	if err := s.AuthorizeLiveView(ctx, employee.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("employee live view err=%v, want not found", err)
	}
	if err := s.AuthorizeLiveView(ctx, intruder.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder live view err=%v, want not found", err)
	}
	if err := s.AuthorizeLiveView(ctx, owner.ID, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown device err=%v, want not found", err)
	}
}

func TestAuthorizeDeviceAgentIsDeviceScoped(t *testing.T) {
	s, ctx, owner, employee, intruder, deviceID := seedLiveViewDevice(t)

	if err := s.AuthorizeDeviceAgent(ctx, employee.ID, deviceID); err != nil {
		t.Fatalf("employee agent: %v", err)
	}
	// Only the machine's own account may open its command stream or push its
	// frames -- not the owner, and certainly not a stranger.
	if err := s.AuthorizeDeviceAgent(ctx, owner.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner as agent err=%v, want not found", err)
	}
	if err := s.AuthorizeDeviceAgent(ctx, intruder.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder as agent err=%v, want not found", err)
	}
}

// Turning monitoring off must stop the live path too, not just stored telemetry.
func TestLiveViewStopsWhenMonitoringIsDisabled(t *testing.T) {
	s, ctx, owner, employee, _, deviceID := seedLiveViewDevice(t)

	if _, err := s.SetDeviceMonitoring(ctx, owner.ID, deviceID, false); err != nil {
		t.Fatalf("disable monitoring: %v", err)
	}
	if err := s.AuthorizeLiveView(ctx, owner.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("live view on a disabled device err=%v, want not found", err)
	}
	if err := s.AuthorizeDeviceAgent(ctx, employee.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("agent stream on a disabled device err=%v, want not found", err)
	}

	if _, err := s.SetDeviceMonitoring(ctx, owner.ID, deviceID, true); err != nil {
		t.Fatalf("re-enable monitoring: %v", err)
	}
	if err := s.AuthorizeLiveView(ctx, owner.ID, deviceID); err != nil {
		t.Fatalf("live view after re-enabling: %v", err)
	}
}

// An archived device must not be reachable through the live path.
func TestLiveViewStopsWhenDeviceIsArchived(t *testing.T) {
	s, ctx, owner, employee, _, deviceID := seedLiveViewDevice(t)

	if _, err := s.SetDeviceArchived(ctx, owner.ID, deviceID, true); err != nil {
		t.Fatalf("archive device: %v", err)
	}
	if err := s.AuthorizeLiveView(ctx, owner.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("live view on an archived device err=%v, want not found", err)
	}
	if err := s.AuthorizeDeviceAgent(ctx, employee.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("agent stream on an archived device err=%v, want not found", err)
	}
}

// AuthorizeLiveView must not be a weaker door than the one-shot capture it
// replaces: an offline device is refused by both.
func TestLiveViewRequiresARecentlySeenDevice(t *testing.T) {
	s, ctx, owner, _, _, deviceID := seedLiveViewDevice(t)

	if _, err := s.pool.Exec(ctx,
		`UPDATE devices SET presence_seen_at = now() - interval '10 minutes' WHERE id = $1`,
		deviceID,
	); err != nil {
		t.Fatalf("age presence: %v", err)
	}
	if err := s.AuthorizeLiveView(ctx, owner.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("live view on a stale device err=%v, want not found", err)
	}
	if _, err := s.RequestLiveCapture(ctx, owner.ID, deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("one-shot capture on a stale device err=%v, want not found", err)
	}
}
