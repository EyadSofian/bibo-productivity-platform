package handlers

import (
	"errors"
	"net/http"
	"os"
	"testing"

	"ctracking/backend/internal/media"
	"ctracking/backend/internal/media/livekit"
)

// Opt-in: needs a local livekit-server --dev and TEST_DATABASE_URL. Unlike the
// normal suite this crosses the real SFU room API as well as PostgreSQL.
func TestMediaLifecycleWithRealLiveKit(t *testing.T) {
	if os.Getenv("LIVEKIT_LOCAL_TEST") != "1" {
		t.Skip("set LIVEKIT_LOCAL_TEST=1 with a local LiveKit development server")
	}
	e := newMediaEnv(t)
	p, err := livekit.New(livekit.Config{URL: "ws://127.0.0.1:7880", APIKey: "devkey", APISecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	e.handler.provider = p
	id := e.startLive(t, e.ownerID)
	path := "/v1/media/sessions/" + id
	t.Cleanup(func() { e.call(t, http.MethodPost, path+"/stop", e.ownerID) })

	rec, demand := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID)
	if rec.Code != http.StatusOK || demand["session_id"] != id {
		t.Fatalf("agent demand: HTTP %d", rec.Code)
	}
	for _, role := range []struct {
		user, endpoint string
		publish        bool
	}{
		{e.employeeID, "publisher-token", true}, {e.ownerID, "viewer-token", false},
	} {
		rec, token := e.call(t, http.MethodPost, path+"/"+role.endpoint, role.user)
		if rec.Code != http.StatusOK || token["can_publish"] != role.publish || token["can_subscribe"] != !role.publish || token["url"] != "ws://127.0.0.1:7880" || token["room"] != demand["room"] {
			t.Fatalf("invalid %s response: HTTP %d (credentials omitted)", role.endpoint, rec.Code)
		}
	}
	if rec, _ := e.call(t, http.MethodPost, path+"/viewer-token", e.intruderID); rec.Code != http.StatusNotFound {
		t.Fatalf("other tenant viewer: HTTP %d", rec.Code)
	}
	if rec, _ := e.reportState(t, id, e.employeeID, `{"state":"live","track":{"source":"screen","codec":"h264","width":640,"height":360,"nominal_fps":15}}`); rec.Code != http.StatusOK {
		t.Fatalf("report state: HTTP %d", rec.Code)
	}
	if rec, _ := e.call(t, http.MethodPost, path+"/stop", e.ownerID); rec.Code != http.StatusOK {
		t.Fatalf("stop: HTTP %d", rec.Code)
	}
	if rec, _ := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID); rec.Code != http.StatusNoContent {
		t.Fatalf("ended session still demanded: HTTP %d", rec.Code)
	}
	if rec, _ := e.call(t, http.MethodPost, path+"/publisher-token", e.employeeID); rec.Code != http.StatusConflict {
		t.Fatalf("ended session still mints: HTTP %d", rec.Code)
	}
	// LiveKit confirms that the backend deleted the actual room.
	if err := p.EndRoom(e.ctx, demand["room"].(string)); !errors.Is(err, media.ErrRoomNotFound) {
		t.Fatalf("expected actual room deletion, got %v", err)
	}
}
