package handlers

import (
	"net/http"
	"testing"
)

func ageViewerLease(t *testing.T, e *mediaEnv, id, user string) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, `UPDATE media_sessions SET started_at=now()-interval '2 minutes' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE viewer_sessions SET last_seen_at=now()-interval '2 minutes' WHERE media_session_id=$1 AND viewer_user_id=$2`, id, user); err != nil {
		t.Fatal(err)
	}
}

func TestAbandonedViewerStopsAgentAndRoom(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	if rec, _ := e.call(t, http.MethodPost, "/v1/media/sessions/"+id+"/viewer-token", e.ownerID); rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	ageViewerLease(t, e, id, e.ownerID)
	if rec, _ := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID); rec.Code != http.StatusNoContent {
		t.Fatalf("abandoned session still demanded: %d", rec.Code)
	}
	if len(e.provider.EndedRooms) != 1 {
		t.Fatal("SFU room not ended")
	}
	if rec, _ := e.call(t, http.MethodPost, "/v1/media/sessions/"+id+"/publisher-token", e.employeeID); rec.Code != http.StatusConflict {
		t.Fatalf("abandoned session still authorizes publish: %d", rec.Code)
	}
	var reason string
	if err := e.pool.QueryRow(e.ctx, `SELECT end_reason FROM viewer_sessions WHERE media_session_id=$1 ORDER BY joined_at DESC LIMIT 1`, id).Scan(&reason); err != nil || reason != "heartbeat_timeout" {
		t.Fatalf("lease end audit: %q %v", reason, err)
	}
}

func TestFreshHeartbeatKeepsSessionAliveAndIsScoped(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	path := "/v1/media/sessions/" + id
	e.call(t, http.MethodPost, path+"/viewer-token", e.ownerID)
	if _, err := e.pool.Exec(e.ctx, `UPDATE media_sessions SET started_at=now()-interval '2 minutes' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE viewer_sessions SET last_seen_at=now()-interval '80 seconds' WHERE media_session_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if rec, _ := e.call(t, http.MethodPost, path+"/heartbeat", e.intruderID); rec.Code != http.StatusNotFound {
		t.Fatalf("other tenant heartbeat: %d", rec.Code)
	}
	if rec, _ := e.call(t, http.MethodPost, path+"/heartbeat", e.ownerID); rec.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d", rec.Code)
	}
	var fresh bool
	if err := e.pool.QueryRow(e.ctx, `SELECT last_seen_at > now()-interval '5 seconds' FROM viewer_sessions WHERE media_session_id=$1 AND left_at IS NULL`, id).Scan(&fresh); err != nil || !fresh {
		t.Fatalf("lease not renewed: %v", err)
	}
	if rec, _ := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID); rec.Code != http.StatusOK {
		t.Fatalf("fresh viewer lost capture: %d", rec.Code)
	}
}

func TestExpiredLeaseCannotBeResurrectedByHeartbeat(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	path := "/v1/media/sessions/" + id
	e.call(t, http.MethodPost, path+"/viewer-token", e.ownerID)
	ageViewerLease(t, e, id, e.ownerID)
	if rec, _ := e.call(t, http.MethodPost, path+"/heartbeat", e.ownerID); rec.Code != http.StatusConflict {
		t.Fatalf("expired viewer resurrected: %d", rec.Code)
	}
}

func TestOneExpiredViewerDoesNotStopAnotherActiveViewer(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	e.call(t, http.MethodPost, "/v1/media/sessions/"+id+"/viewer-token", e.ownerID)
	// Store join models an additional authorized viewer, independent of role setup.
	if _, err := e.store.JoinViewerSession(e.ctx, id, e.businessID, e.employeeID); err != nil {
		t.Fatal(err)
	}
	ageViewerLease(t, e, id, e.ownerID)
	if rec, _ := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID); rec.Code != http.StatusOK {
		t.Fatalf("active viewer interrupted: %d", rec.Code)
	}
	if len(e.provider.EndedRooms) != 0 {
		t.Fatal("active room ended")
	}
	if count, err := e.store.ActiveViewerCount(e.ctx, id); err != nil || count != 1 {
		t.Fatalf("viewers=%d err=%v", count, err)
	}
}
