package store

import (
	"encoding/json"
	"errors"
	"testing"

	"ctracking/backend/internal/media"

	"github.com/google/uuid"
)

// mediaFixture is one business with one registered device, plus a second,
// unrelated tenant. Almost every property worth testing here is "the second
// tenant cannot reach the first one's rows", so the intruder is part of the
// fixture rather than something each test rebuilds.
type mediaFixture struct {
	syncFixture
	deviceID string

	intruderID  string
	intruderBiz string
}

func newMediaFixture(t *testing.T) mediaFixture {
	t.Helper()
	f := newSyncFixture(t)
	deviceID := registerDevice(t, f)

	intruder := mustUser(t, f.ctx, f.store, "intruder@example.com", "")
	intruderBiz, err := f.store.CreateBusiness(f.ctx, intruder.ID, "Other Co", "team")
	if err != nil {
		t.Fatalf("create intruder business: %v", err)
	}
	return mediaFixture{
		syncFixture: f,
		deviceID:    deviceID,
		intruderID:  intruder.ID,
		intruderBiz: intruderBiz.ID,
	}
}

func (f mediaFixture) openLive(t *testing.T) MediaSession {
	t.Helper()
	session, _, err := f.store.OpenMediaSession(f.ctx, NewMediaSession{
		BusinessID:     f.bizID,
		DeviceID:       f.deviceID,
		Kind:           media.KindLive,
		Provider:       "fake",
		ProviderRoomID: uuid.NewString(),
		CreatedBy:      f.userID,
	})
	if err != nil {
		t.Fatalf("open session: %v", err)
	}
	return session
}

func TestOpenMediaSessionCreatesThenJoins(t *testing.T) {
	f := newMediaFixture(t)

	first, created, err := f.store.OpenMediaSession(f.ctx, NewMediaSession{
		BusinessID: f.bizID, DeviceID: f.deviceID, Kind: media.KindLive,
		Provider: "fake", ProviderRoomID: uuid.NewString(), CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if !created {
		t.Error("first open reported that it joined an existing session")
	}
	if first.State != media.StateRequested {
		t.Errorf("state = %s, want %s", first.State, media.StateRequested)
	}

	// A second viewer must land on the same session. Two sessions would make
	// the agent publish twice and make "who watched this" unanswerable.
	second, created, err := f.store.OpenMediaSession(f.ctx, NewMediaSession{
		BusinessID: f.bizID, DeviceID: f.deviceID, Kind: media.KindLive,
		Provider: "fake", ProviderRoomID: uuid.NewString(), CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if created {
		t.Error("second open created a duplicate session for the same device")
	}
	if second.ID != first.ID {
		t.Errorf("second session id = %s, want the first session %s", second.ID, first.ID)
	}

	// Once ended, a new request starts a genuinely new session.
	if _, err := f.store.AdvanceMediaSession(f.ctx, first.ID, media.StateEnded, ""); err != nil {
		t.Fatalf("end: %v", err)
	}
	third, created, err := f.store.OpenMediaSession(f.ctx, NewMediaSession{
		BusinessID: f.bizID, DeviceID: f.deviceID, Kind: media.KindLive,
		Provider: "fake", ProviderRoomID: uuid.NewString(), CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("third open: %v", err)
	}
	if !created || third.ID == first.ID {
		t.Error("after ending, a new request should start a new session")
	}
}

// The core isolation property. An id is not a capability: knowing another
// tenant's session id must reveal nothing.
func TestMediaSessionIsTenantScoped(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	if _, err := f.store.MediaSessionForMember(f.ctx, f.userID, session.ID); err != nil {
		t.Fatalf("owner cannot read their own session: %v", err)
	}
	if _, err := f.store.MediaSessionForMember(f.ctx, f.intruderID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder read another tenant's session: err = %v, want ErrNotFound", err)
	}
	// And the device behind it is equally out of reach.
	if _, err := f.store.MediaDeviceTargetFor(f.ctx, f.intruderID, f.deviceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("intruder resolved another tenant's device: err = %v, want ErrNotFound", err)
	}
}

// A device that has enrolled but never sent a heartbeat has a NULL
// presence_seen_at, and NULL is not false in SQL. This is the first live request
// against a brand new device, which is the most likely first contact with the
// feature -- it must report "offline", not fail.
func TestMediaDeviceTargetHandlesADeviceThatNeverHeartbeated(t *testing.T) {
	f := newMediaFixture(t)

	target, err := f.store.MediaDeviceTargetFor(f.ctx, f.userID, f.deviceID)
	if err != nil {
		t.Fatalf("a never-seen device failed to resolve: %v", err)
	}
	if target.Online {
		t.Error("a device that never heartbeated reported itself online")
	}
	if !target.MonitoringEnabled {
		t.Error("a new device should default to monitoring enabled")
	}
}

// An agent holding a valid credential for its own device must not be able to
// reach a session belonging to a different device.
func TestMediaSessionForAgentIsScopedToItsOwnDevice(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	// The device's own user can read it: this is the publisher-token path.
	if _, err := f.store.MediaSessionForAgent(f.ctx, f.userID, session.ID); err != nil {
		t.Fatalf("the device's own agent cannot read its session: %v", err)
	}

	// A second employee in the SAME business, with their own device. Same
	// tenant, valid credential, different machine -- and still refused.
	otherEmployee := mustUser(t, f.ctx, f.store, "employee2@example.com", "")
	otherDevice := uuid.NewString()
	if _, err := f.store.SyncBatch(f.ctx, otherEmployee.ID, f.bizID, otherDevice, nil, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("register second device: %v", err)
	}

	if _, err := f.store.MediaSessionForAgent(f.ctx, otherEmployee.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an agent minted against another device's session: err = %v, want ErrNotFound", err)
	}
	if _, err := f.store.MediaSessionForAgent(f.ctx, f.intruderID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an out-of-tenant agent reached the session: err = %v, want ErrNotFound", err)
	}
}

// An archived device must not keep publishing: archiving is how an owner stops
// a machine they no longer control.
func TestMediaSessionForAgentRefusesArchivedDevice(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	if _, err := f.store.SetDeviceArchived(f.ctx, f.userID, f.deviceID, true); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if _, err := f.store.MediaSessionForAgent(f.ctx, f.userID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an archived device kept publisher access: err = %v, want ErrNotFound", err)
	}
}

// The database enforces the state machine, not just the Go layer: a caller that
// bypasses the helper still cannot revive an ended session.
func TestAdvanceMediaSessionRefusesIllegalTransitions(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	if _, err := f.store.AdvanceMediaSession(f.ctx, session.ID, media.StateLive, ""); err == nil {
		t.Error("requested -> live was allowed; negotiation was skipped")
	}

	for _, to := range []media.State{media.StateAuthorizing, media.StateWaitingForAgent, media.StateNegotiating, media.StateLive} {
		if _, err := f.store.AdvanceMediaSession(f.ctx, session.ID, to, ""); err != nil {
			t.Fatalf("advance to %s: %v", to, err)
		}
	}

	ended, err := f.store.AdvanceMediaSession(f.ctx, session.ID, media.StateEnded, "")
	if err != nil {
		t.Fatalf("end: %v", err)
	}
	if ended.EndedAt == nil {
		t.Error("an ended session has no ended_at; the terminal-state constraint did not fire")
	}
	if _, err := f.store.AdvanceMediaSession(f.ctx, session.ID, media.StateLive, ""); err == nil {
		t.Error("an ended session was revived")
	}
}

func TestFailedSessionRecordsItsFailureCode(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	failed, err := f.store.AdvanceMediaSession(f.ctx, session.ID, media.StateFailed, media.FailAgentOffline)
	if err != nil {
		t.Fatalf("fail: %v", err)
	}
	if failed.FailureCode != string(media.FailAgentOffline) {
		t.Errorf("failure_code = %q, want %q", failed.FailureCode, media.FailAgentOffline)
	}
	if failed.EndedAt == nil {
		t.Error("a failed session has no ended_at")
	}
}

// Reconnecting must not accumulate open viewer rows, or "who is watching now"
// becomes a count of reconnections.
func TestViewerSessionsTrackWhoIsWatchingNow(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	if _, err := f.store.JoinViewerSession(f.ctx, session.ID, f.bizID, f.userID); err != nil {
		t.Fatalf("join: %v", err)
	}
	if n := mustViewerCount(t, f, session.ID); n != 1 {
		t.Fatalf("viewers = %d, want 1", n)
	}

	// Same viewer reconnecting.
	if _, err := f.store.JoinViewerSession(f.ctx, session.ID, f.bizID, f.userID); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	if n := mustViewerCount(t, f, session.ID); n != 1 {
		t.Errorf("viewers after a reconnect = %d, want 1", n)
	}

	// A second, different viewer.
	second := mustUser(t, f.ctx, f.store, "viewer2@example.com", "")
	if _, err := f.store.JoinViewerSession(f.ctx, session.ID, f.bizID, second.ID); err != nil {
		t.Fatalf("second join: %v", err)
	}
	if n := mustViewerCount(t, f, session.ID); n != 2 {
		t.Errorf("viewers = %d, want 2", n)
	}

	if err := f.store.LeaveViewerSession(f.ctx, session.ID, f.userID, "stopped"); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if n := mustViewerCount(t, f, session.ID); n != 1 {
		t.Errorf("viewers after one left = %d, want 1", n)
	}

	// Leaving twice is not an error: a closed tab plus an explicit stop is
	// normal client behaviour.
	if err := f.store.LeaveViewerSession(f.ctx, session.ID, f.userID, "stopped"); err != nil {
		t.Errorf("second leave: %v", err)
	}
}

func mustViewerCount(t *testing.T, f mediaFixture, sessionID string) int {
	t.Helper()
	n, err := f.store.ActiveViewerCount(f.ctx, sessionID)
	if err != nil {
		t.Fatalf("viewer count: %v", err)
	}
	return n
}

// A denial that leaves no trace is indistinguishable from nobody having tried,
// so refusals are recorded as deliberately as successes.
func TestMediaAuditRecordsAndIsTenantScoped(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	events := []MediaAuditEvent{
		{BusinessID: f.bizID, MediaSessionID: session.ID, ActorType: "user", ActorID: f.userID,
			Action: AuditLiveSessionStart, Outcome: OutcomeAllowed},
		{BusinessID: f.bizID, MediaSessionID: session.ID, ActorType: "user", ActorID: f.userID,
			Action: AuditViewerTokenMint, Outcome: OutcomeAllowed,
			Metadata: map[string]any{"expires_in_s": 120}},
		{BusinessID: f.bizID, MediaSessionID: session.ID, ActorType: "agent", ActorID: f.deviceID,
			Action: AuditPublisherTokenMint, Outcome: OutcomeDenied,
			Metadata: map[string]any{"reason": "not_this_device"}},
	}
	for _, e := range events {
		if err := f.store.RecordMediaAudit(f.ctx, e); err != nil {
			t.Fatalf("record %s: %v", e.Action, err)
		}
	}

	got, err := f.store.MediaAuditForSession(f.ctx, f.userID, session.ID)
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if len(got) != len(events) {
		t.Fatalf("audit rows = %d, want %d", len(got), len(events))
	}
	if got[2].Outcome != OutcomeDenied {
		t.Errorf("outcome = %q, want the denial to be recorded", got[2].Outcome)
	}

	// The audit trail is tenant-scoped like everything else.
	intruderView, err := f.store.MediaAuditForSession(f.ctx, f.intruderID, session.ID)
	if err != nil {
		t.Fatalf("intruder audit read: %v", err)
	}
	if len(intruderView) != 0 {
		t.Errorf("intruder read %d audit rows from another tenant", len(intruderView))
	}
}

// Without the snapshot, a historical session stops being explainable the moment
// a profile changes.
func TestPolicySnapshotIsStoredWithTheSession(t *testing.T) {
	f := newMediaFixture(t)
	snapshot := json.RawMessage(`{"recording":{"mode":"off"},"max_fps":15}`)

	session, _, err := f.store.OpenMediaSession(f.ctx, NewMediaSession{
		BusinessID: f.bizID, DeviceID: f.deviceID, Kind: media.KindLive,
		Provider: "fake", ProviderRoomID: uuid.NewString(),
		PolicySnapshot: snapshot, CreatedBy: f.userID,
	})
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	read, err := f.store.MediaSessionForMember(f.ctx, f.userID, session.ID)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(read.PolicySnapshot, &decoded); err != nil {
		t.Fatalf("snapshot did not round-trip: %v", err)
	}
	if decoded["max_fps"] != float64(15) {
		t.Errorf("snapshot = %v, want the policy as it was at session start", decoded)
	}
}

// The room name is what a provider-side observer sees. It must carry nothing
// about who is being watched.
func TestProviderRoomIDIsOpaqueAndNotSerialized(t *testing.T) {
	f := newMediaFixture(t)
	session := f.openLive(t)

	if _, err := uuid.Parse(session.ProviderRoomID); err != nil {
		t.Errorf("room id %q is not an opaque uuid", session.ProviderRoomID)
	}
	for _, secret := range []string{f.userID, f.deviceID, f.bizID} {
		if session.ProviderRoomID == secret {
			t.Errorf("room id reuses an identifying id (%s)", secret)
		}
	}

	// The API shape must not leak it either.
	encoded, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytesContain(encoded, session.ProviderRoomID) {
		t.Errorf("provider_room_id was serialized to clients: %s", encoded)
	}
}

func bytesContain(haystack []byte, needle string) bool {
	if needle == "" {
		return false
	}
	n := len(needle)
	for i := 0; i+n <= len(haystack); i++ {
		if string(haystack[i:i+n]) == needle {
			return true
		}
	}
	return false
}
