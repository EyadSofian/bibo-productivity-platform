package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ctracking/backend/internal/media"
	"ctracking/backend/internal/media/mediafake"
	"ctracking/backend/internal/middleware"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/store"
	"ctracking/backend/internal/testutil"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// mediaEnv is a router wired exactly as production wires it, over a real
// database and the fake provider. Testing through the router rather than calling
// handlers directly is what makes the auth, request-id and error-envelope
// behaviour real rather than assumed.
type mediaEnv struct {
	handler  *MediaHandler
	router   *gin.Engine
	store    *store.Store
	provider *mediafake.Provider
	pool     *pgxpool.Pool
	ctx      context.Context

	ownerID    string
	employeeID string
	businessID string
	deviceID   string

	intruderID string
}

func newMediaEnv(t *testing.T) *mediaEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)

	pool := testutil.Pool(t)
	st := store.New(pool)
	ctx := context.Background()

	owner, err := st.CreateUser(ctx, "owner@example.com", "", "hash", "Owner", "")
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	biz, err := st.CreateBusiness(ctx, owner.ID, "Acme", "team")
	if err != nil {
		t.Fatalf("create business: %v", err)
	}
	employee, _, err := st.CreateEmployee(ctx, owner.ID, &biz.ID, "employee@example.com", "", "hash", "Employee")
	if err != nil {
		t.Fatalf("create employee: %v", err)
	}
	intruder, err := st.CreateUser(ctx, "intruder@example.com", "", "hash", "Intruder", "")
	if err != nil {
		t.Fatalf("create intruder: %v", err)
	}
	if _, err := st.CreateBusiness(ctx, intruder.ID, "Other Co", "team"); err != nil {
		t.Fatalf("create intruder business: %v", err)
	}

	// A device belonging to the employee, registered the way an agent does it.
	deviceID := uuid.NewString()
	if _, err := st.SyncBatch(ctx, employee.ID, biz.ID, deviceID, nil, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("register device: %v", err)
	}
	// Presence: StartLive refuses an offline device, and that refusal has its
	// own test.
	if _, err := pool.Exec(ctx,
		`UPDATE devices SET presence_seen_at = now() WHERE id = $1`, deviceID); err != nil {
		t.Fatalf("set presence: %v", err)
	}

	provider := mediafake.New()
	h := NewMediaHandler(st, provider, 120*time.Second)

	r := gin.New()
	r.Use(middleware.RequestID())
	// Stand in for the JWT middleware: the caller's identity comes from a header
	// so a test can act as any principal without minting tokens.
	r.Use(func(c *gin.Context) {
		if id := c.GetHeader("X-Test-User"); id != "" {
			c.Set("user_id", id)
		}
		c.Next()
	})
	r.POST("/v1/devices/:device_id/media/live", h.StartLive)
	r.GET("/v1/media/agent/session", h.AgentSession)
	r.GET("/v1/media/sessions/:session_id", h.Session)
	r.POST("/v1/media/sessions/:session_id/viewer-token", h.ViewerToken)
	r.POST("/v1/media/sessions/:session_id/publisher-token", h.PublisherToken)
	r.POST("/v1/media/sessions/:session_id/stop", h.Stop)
	r.POST("/v1/agent/media/sessions/:session_id/state", h.AgentState)

	return &mediaEnv{
		router: r, store: st, provider: provider, pool: pool, ctx: ctx, handler: h,
		ownerID: owner.ID, employeeID: employee.ID, businessID: biz.ID,
		deviceID: deviceID, intruderID: intruder.ID,
	}
}

// postJSON is the agent-state path, which is the only one with a body.
func (e *mediaEnv) postJSON(t *testing.T, path, asUser, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if asUser != "" {
		req.Header.Set("X-Test-User", asUser)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)

	var decoded map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode POST %s: %v (body %q)", path, err, rec.Body.String())
		}
	}
	return rec, decoded
}

// reportState drives the session forward as a publisher would.
func (e *mediaEnv) reportState(t *testing.T, sessionID, asUser, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return e.postJSON(t, "/v1/agent/media/sessions/"+sessionID+"/state", asUser, body)
}

func (e *mediaEnv) call(t *testing.T, method, path, asUser string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if asUser != "" {
		req.Header.Set("X-Test-User", asUser)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)

	var body map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %s %s: %v (body %q)", method, path, err, rec.Body.String())
		}
	}
	return rec, body
}

func (e *mediaEnv) startLive(t *testing.T, asUser string) string {
	t.Helper()
	rec, body := e.call(t, http.MethodPost, "/v1/devices/"+e.deviceID+"/media/live", asUser)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("start live: status %d, body %v", rec.Code, body)
	}
	session, _ := body["session"].(map[string]any)
	id, _ := session["id"].(string)
	if id == "" {
		t.Fatalf("start live returned no session id: %v", body)
	}
	return id
}

func errorBody(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	e, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("response has no typed error envelope: %v", body)
	}
	return e
}

// The envelope is a contract: without a code the UI cannot say anything
// specific, and without retryable a client cannot tell a transient fault from a
// permanent refusal.
func TestMediaErrorsUseTheTypedEnvelope(t *testing.T) {
	e := newMediaEnv(t)

	rec, body := e.call(t, http.MethodPost, "/v1/devices/not-a-uuid/media/live", e.ownerID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	err := errorBody(t, body)
	if err["code"] != CodeInvalidRequest {
		t.Errorf("code = %v, want %s", err["code"], CodeInvalidRequest)
	}
	if err["retryable"] != false {
		t.Errorf("retryable = %v, want false for malformed input", err["retryable"])
	}
	if id, _ := err["request_id"].(string); id == "" {
		t.Error("error carries no request_id; a reported failure cannot be traced")
	}
	if got := rec.Header().Get(middleware.HeaderRequestID); got == "" {
		t.Error("response has no X-Request-Id header")
	}
	if err["request_id"] != rec.Header().Get(middleware.HeaderRequestID) {
		t.Error("the body and header request ids disagree")
	}
}

// Acceptance: tenant A must not see tenant B's session through any endpoint,
// and must not be able to tell "not yours" from "does not exist".
func TestMediaSessionsAreInvisibleToOtherTenants(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	paths := []struct{ method, path string }{
		{http.MethodGet, "/v1/media/sessions/" + sessionID},
		{http.MethodPost, "/v1/media/sessions/" + sessionID + "/viewer-token"},
		{http.MethodPost, "/v1/media/sessions/" + sessionID + "/stop"},
		{http.MethodPost, "/v1/media/sessions/" + sessionID + "/publisher-token"},
	}
	for _, p := range paths {
		rec, body := e.call(t, p.method, p.path, e.intruderID)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s as intruder: status %d, want 404", p.method, p.path, rec.Code)
			continue
		}
		if code := errorBody(t, body)["code"]; code != CodeSessionNotFound {
			t.Errorf("%s %s: code = %v, want %s", p.method, p.path, code, CodeSessionNotFound)
		}
	}

	// The same 404 for a session id that never existed: the two must be
	// indistinguishable, or the API confirms which ids are real.
	rec, _ := e.call(t, http.MethodGet, "/v1/media/sessions/"+uuid.NewString(), e.intruderID)
	if rec.Code != http.StatusNotFound {
		t.Errorf("nonexistent session: status %d, want the same 404", rec.Code)
	}
}

// Acceptance: an employee has no media permissions, so being inside the tenant
// is not enough.
func TestEmployeeCannotStartOrWatch(t *testing.T) {
	e := newMediaEnv(t)

	rec, body := e.call(t, http.MethodPost, "/v1/devices/"+e.deviceID+"/media/live", e.employeeID)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("employee started a session: status %d, body %v", rec.Code, body)
	}
	if code := errorBody(t, body)["code"]; code != CodeForbidden {
		t.Errorf("code = %v, want %s", code, CodeForbidden)
	}

	// And the denial is on the record. A refusal that leaves no trace is
	// indistinguishable from nobody having tried.
	events, err := e.store.MediaAuditForBusiness(e.ctx, e.ownerID, e.businessID, 50)
	if err != nil {
		t.Fatalf("audit read: %v", err)
	}
	var denied bool
	for _, ev := range events {
		if ev.Action == store.AuditLiveSessionStart && ev.Outcome == store.OutcomeDenied {
			denied = true
			if ev.Metadata["permission"] != string(media.PermLiveViewStart) {
				t.Errorf("denial metadata does not name the permission: %v", ev.Metadata)
			}
		}
	}
	if !denied {
		t.Error("a refused start left no audit record")
	}
}

// Acceptance: a viewer token subscribes and never publishes.
func TestViewerTokenIsSubscribeOnly(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID)
	if rec.Code != http.StatusOK {
		t.Fatalf("mint viewer token: status %d, body %v", rec.Code, body)
	}
	if body["can_publish"] != false {
		t.Error("viewer token reports publish permission")
	}
	if body["can_subscribe"] != true {
		t.Error("viewer token does not report subscribe permission")
	}
	if tok, _ := body["token"].(string); tok == "" {
		t.Error("no token returned")
	}
}

// Acceptance: a token's lifetime is bounded, and it is the configured bound.
func TestMintedTokensExpireWithinTheConfiguredTTL(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	_, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID)
	raw, _ := body["expires_at"].(string)
	expiresAt, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("parse expires_at %q: %v", raw, err)
	}
	ttl := expiresAt.Sub(e.provider.Now())
	if ttl <= 0 {
		t.Errorf("token is already expired (ttl %v)", ttl)
	}
	if ttl > 120*time.Second {
		t.Errorf("token ttl = %v, want at most the configured 120s", ttl)
	}
}

// Acceptance: an agent may only publish for its own device. This is the test
// that a stolen or misused agent credential cannot widen itself.
func TestAgentCannotMintAPublisherTokenForAnotherDevice(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	// The device's own agent can.
	rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", e.employeeID)
	if rec.Code != http.StatusOK {
		t.Fatalf("the device's own agent was refused: status %d, body %v", rec.Code, body)
	}
	if body["can_publish"] != true || body["can_subscribe"] != false {
		t.Errorf("publisher token scope wrong: publish=%v subscribe=%v", body["can_publish"], body["can_subscribe"])
	}

	// A second employee with their own device, inside the same business.
	other, _, err := e.store.CreateEmployee(e.ctx, e.ownerID, &e.businessID, "employee2@example.com", "", "hash", "Employee 2")
	if err != nil {
		t.Fatalf("create second employee: %v", err)
	}
	otherDevice := uuid.NewString()
	if _, err := e.store.SyncBatch(e.ctx, other.ID, e.businessID, otherDevice, nil, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("register second device: %v", err)
	}

	rec, body = e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", other.ID)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("an agent minted a publisher token for another device: status %d, body %v", rec.Code, body)
	}

	// Even the owner, whose permissions are otherwise total, is not an agent.
	rec, _ = e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", e.ownerID)
	if rec.Code != http.StatusNotFound {
		t.Errorf("the owner minted a publisher token: status %d, want 404 -- only the device may publish", rec.Code)
	}
}

// Acceptance: start, join, token mint and stop all leave a trail.
func TestSessionLifecycleIsFullyAudited(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	if rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID); rec.Code != http.StatusOK {
		t.Fatalf("viewer token: %d %v", rec.Code, body)
	}
	if rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", e.employeeID); rec.Code != http.StatusOK {
		t.Fatalf("publisher token: %d %v", rec.Code, body)
	}
	if rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/stop", e.ownerID); rec.Code != http.StatusOK {
		t.Fatalf("stop: %d %v", rec.Code, body)
	}

	events, err := e.store.MediaAuditForSession(e.ctx, e.ownerID, sessionID)
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	seen := map[string]bool{}
	for _, ev := range events {
		seen[ev.Action] = true
		if ev.Metadata["request_id"] == nil {
			t.Errorf("audit row %q has no request_id; it cannot be joined to the logs", ev.Action)
		}
	}
	for _, want := range []string{
		store.AuditLiveSessionStart,
		store.AuditViewerTokenMint,
		store.AuditPublisherTokenMint,
		store.AuditLiveSessionStop,
	} {
		if !seen[want] {
			t.Errorf("no audit row for %q", want)
		}
	}
}

// A session that has ended cannot hand out new tokens: a stale tab must not be
// able to resume watching.
func TestEndedSessionMintsNoTokens(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	if rec, _ := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/stop", e.ownerID); rec.Code != http.StatusOK {
		t.Fatalf("stop: %d", rec.Code)
	}
	// Stopping twice is fine.
	if rec, _ := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/stop", e.ownerID); rec.Code != http.StatusOK {
		t.Errorf("a second stop returned %d, want 200: stopping is idempotent", rec.Code)
	}

	rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("minted a viewer token for an ended session: status %d", rec.Code)
	}
	if code := errorBody(t, body)["code"]; code != CodeSessionEnded {
		t.Errorf("code = %v, want %s", code, CodeSessionEnded)
	}
	rec, _ = e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", e.employeeID)
	if rec.Code != http.StatusConflict {
		t.Errorf("minted a publisher token for an ended session: status %d", rec.Code)
	}
}

// One viewer closing a tab must not cut off everyone else.
func TestStopKeepsTheSessionAliveWhileOthersWatch(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	second, err := e.store.CreateUser(e.ctx, "owner2@example.com", "", "hash", "Owner 2", "")
	if err != nil {
		t.Fatalf("create second owner: %v", err)
	}
	e.addOwner(t, second.ID)

	for _, user := range []string{e.ownerID, second.ID} {
		if rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", user); rec.Code != http.StatusOK {
			t.Fatalf("viewer token for %s: %d %v", user, rec.Code, body)
		}
	}

	_, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/stop", e.ownerID)
	session, _ := body["session"].(map[string]any)
	if state, _ := session["state"].(string); state == string(media.StateEnded) {
		t.Fatal("one viewer leaving ended the session for everyone else")
	}

	_, body = e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/stop", second.ID)
	session, _ = body["session"].(map[string]any)
	if state, _ := session["state"].(string); state != string(media.StateEnded) {
		t.Errorf("state = %q after the last viewer left, want ended", state)
	}
}

// Acceptance: no token, no room name, no credential reaches the logs. This runs
// a full lifecycle with file logging on and then reads the log back.
func TestNoTokensOrRoomNamesReachTheLogs(t *testing.T) {
	e := newMediaEnv(t)

	dir := t.TempDir()
	if err := obs.Init("test", obs.FileConfig{Dir: dir, MaxSizeMB: 1, MaxBackups: 1, MaxAgeDays: 1}); err != nil {
		t.Fatalf("init logging: %v", err)
	}
	defer func() { _ = obs.Close() }()

	// Route gin's access log into the same stream, exactly as the server does.
	// Request paths are logged, so this covers that surface too.
	gin.DefaultWriter = obs.Writer()
	e.router.Use(gin.LoggerWithWriter(obs.Writer()))

	// A marker proves the capture mechanism works. Without it, "no secrets in
	// the log" would also be the result of an empty log, and the test would
	// pass while checking nothing.
	const marker = "media-log-capture-marker"
	obs.Info(marker)

	sessionID := e.startLive(t, e.ownerID)
	_, tokenBody := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID)
	viewerToken, _ := tokenBody["token"].(string)
	roomName, _ := tokenBody["room"].(string)
	_, pubBody := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", e.employeeID)
	publisherToken, _ := pubBody["token"].(string)
	e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/stop", e.ownerID)

	// Also exercise the failure paths, which are where a careless log line is
	// most likely to include the thing that failed.
	e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID)
	e.call(t, http.MethodPost, "/v1/devices/"+e.deviceID+"/media/live", e.employeeID)

	_ = obs.Close()
	logged, err := os.ReadFile(filepath.Join(dir, "backend.log"))
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	text := string(logged)
	if !strings.Contains(text, marker) {
		t.Fatalf("the marker is missing: log capture is not working, so this test proves nothing\n%s", text)
	}

	for name, secret := range map[string]string{
		"viewer token":    viewerToken,
		"publisher token": publisherToken,
		"room name":       roomName,
	} {
		if secret == "" {
			t.Fatalf("%s was empty; the test is not exercising what it claims", name)
		}
		if strings.Contains(text, secret) {
			t.Errorf("%s appears in the log:\n%s", name, text)
		}
	}
}

// The audit trail is read by people reviewing who watched whom. A token in its
// metadata would be a durable copy of a credential.
func TestAuditMetadataCarriesNoSecrets(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	_, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/viewer-token", e.ownerID)
	token, _ := body["token"].(string)
	room, _ := body["room"].(string)

	events, err := e.store.MediaAuditForSession(e.ctx, e.ownerID, sessionID)
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	for _, ev := range events {
		encoded, err := json.Marshal(ev.Metadata)
		if err != nil {
			t.Fatalf("marshal metadata: %v", err)
		}
		if token != "" && strings.Contains(string(encoded), token) {
			t.Errorf("audit metadata for %q contains the token: %s", ev.Action, encoded)
		}
		if room != "" && strings.Contains(string(encoded), room) {
			t.Errorf("audit metadata for %q contains the room name: %s", ev.Action, encoded)
		}
	}
}

// An offline device is refused as RETRYABLE, because it is a condition that
// resolves on its own. Getting this wrong in either direction is a real bug: a
// client that treats it as permanent stops trying, and one that treats a
// permission denial as retryable hammers the API forever.
func TestOfflineDeviceIsRefusedAsRetryable(t *testing.T) {
	e := newMediaEnv(t)
	e.goOffline(t)

	rec, body := e.call(t, http.MethodPost, "/v1/devices/"+e.deviceID+"/media/live", e.ownerID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	errBody := errorBody(t, body)
	if errBody["code"] != CodeAgentOffline {
		t.Errorf("code = %v, want %s", errBody["code"], CodeAgentOffline)
	}
	if errBody["retryable"] != true {
		t.Error("an offline device was reported as not retryable")
	}

	// No session row is created for a refusal: a session that never had a
	// chance to exist must not appear in the history as if it did.
	events, err := e.store.MediaAuditForBusiness(e.ctx, e.ownerID, e.businessID, 50)
	if err != nil {
		t.Fatalf("audit read: %v", err)
	}
	var found bool
	for _, ev := range events {
		if ev.Outcome == store.OutcomeDenied && ev.Metadata["reason"] == string(media.FailAgentOffline) {
			found = true
		}
	}
	if !found {
		t.Error("the offline refusal was not audited with its reason")
	}
}

// Monitoring turned off is a permanent refusal, not a transient one.
func TestMonitoringDisabledIsNotRetryable(t *testing.T) {
	e := newMediaEnv(t)
	if _, err := e.store.SetDeviceMonitoring(e.ctx, e.ownerID, e.deviceID, false); err != nil {
		t.Fatalf("disable monitoring: %v", err)
	}

	rec, body := e.call(t, http.MethodPost, "/v1/devices/"+e.deviceID+"/media/live", e.ownerID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	errBody := errorBody(t, body)
	if errBody["code"] != CodeMonitoringDisabled {
		t.Errorf("code = %v, want %s", errBody["code"], CodeMonitoringDisabled)
	}
	if errBody["retryable"] != false {
		t.Error("a policy refusal was reported as retryable; a client would retry forever")
	}
}

// addOwner grants a second user the owner role in a business. Written as SQL in
// the test rather than as a store method: co-ownership is not a product feature
// yet, and inventing an API for it here would be inventing a product decision.
func (e *mediaEnv) addOwner(t *testing.T, userID string) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx,
		`INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'owner')`,
		userID, e.businessID); err != nil {
		t.Fatalf("add owner membership: %v", err)
	}
}

// goOffline ages the device's presence past the liveness window.
func (e *mediaEnv) goOffline(t *testing.T) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx,
		`UPDATE devices SET presence_seen_at = now() - interval '10 minutes' WHERE id = $1`,
		e.deviceID); err != nil {
		t.Fatalf("age presence: %v", err)
	}
}

// The publisher is the only party that can tell "connecting" from "connected but
// black", so the whole live lifecycle is driven from its callback.
func TestPublisherDrivesTheSessionToLive(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	// The token mint moves waiting_for_agent -> negotiating.
	if rec, body := e.call(t, http.MethodPost, "/v1/media/sessions/"+sessionID+"/publisher-token", e.employeeID); rec.Code != http.StatusOK {
		t.Fatalf("publisher token: %d %v", rec.Code, body)
	}

	rec, body := e.reportState(t, sessionID, e.employeeID,
		`{"state":"live","track":{"source":"screen","codec":"h264","width":1280,"height":720,"nominal_fps":15}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("report live: %d %v", rec.Code, body)
	}
	session, _ := body["session"].(map[string]any)
	if state, _ := session["state"].(string); state != string(media.StateLive) {
		t.Fatalf("state = %q, want live", state)
	}

	// What is being published is recorded, which is what a viewer's display
	// picker and the quality badge read.
	tracks, err := e.store.MediaTracksFor(e.ctx, e.ownerID, sessionID)
	if err != nil {
		t.Fatalf("read tracks: %v", err)
	}
	if len(tracks) != 1 {
		t.Fatalf("tracks = %d, want 1", len(tracks))
	}
	if tracks[0].Width != 1280 || tracks[0].Height != 720 || tracks[0].Codec != "h264" {
		t.Errorf("track = %+v, want 1280x720 h264", tracks[0])
	}

	// A reconnect re-reports the same track. One screen must not become two.
	if rec, _ := e.reportState(t, sessionID, e.employeeID, `{"state":"reconnecting"}`); rec.Code != http.StatusOK {
		t.Fatalf("report reconnecting: %d", rec.Code)
	}
	if rec, _ := e.reportState(t, sessionID, e.employeeID,
		`{"state":"live","track":{"source":"screen","codec":"h264","width":1920,"height":1080,"nominal_fps":15}}`); rec.Code != http.StatusOK {
		t.Fatalf("report live again: %d", rec.Code)
	}
	tracks, err = e.store.MediaTracksFor(e.ctx, e.ownerID, sessionID)
	if err != nil {
		t.Fatalf("re-read tracks: %v", err)
	}
	if len(tracks) != 1 {
		t.Fatalf("tracks after a reconnect = %d, want 1", len(tracks))
	}
	if tracks[0].Width != 1920 {
		t.Errorf("track width = %d, want the re-reported 1920", tracks[0].Width)
	}
}

// A failure with no code produces "it didn't work" with nothing to act on.
func TestPublisherFailureRequiresAKnownCode(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	for _, body := range []string{
		`{"state":"failed"}`,
		`{"state":"failed","failure_code":""}`,
		`{"state":"failed","failure_code":"SOMETHING_BROKE"}`,
	} {
		rec, decoded := e.reportState(t, sessionID, e.employeeID, body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", body, rec.Code)
			continue
		}
		if code := errorBody(t, decoded)["code"]; code != CodeInvalidRequest {
			t.Errorf("%s: code = %v", body, code)
		}
	}

	rec, decoded := e.reportState(t, sessionID, e.employeeID,
		`{"state":"failed","failure_code":"CAPTURE_FAILED"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("a known failure code was refused: %d %v", rec.Code, decoded)
	}
	session, _ := decoded["session"].(map[string]any)
	if session["failure_code"] != string(media.FailCaptureFailed) {
		t.Errorf("failure_code = %v, want %s", session["failure_code"], media.FailCaptureFailed)
	}
}

// A publisher reports what IT does. Claiming a control-plane state would let a
// device authorize itself.
func TestPublisherCannotClaimControlPlaneStates(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	for _, state := range []string{"requested", "authorizing", "waiting_for_agent", "ending", "nonsense"} {
		rec, _ := e.reportState(t, sessionID, e.employeeID, `{"state":"`+state+`"}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("a publisher reported %q: status %d, want 400", state, rec.Code)
		}
	}
}

// The same scoping as the publisher token: an agent may only speak for its own
// device's session.
func TestAgentStateIsScopedToItsOwnDevice(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	other, _, err := e.store.CreateEmployee(e.ctx, e.ownerID, &e.businessID, "employee3@example.com", "", "hash", "Employee 3")
	if err != nil {
		t.Fatalf("create employee: %v", err)
	}
	otherDevice := uuid.NewString()
	if _, err := e.store.SyncBatch(e.ctx, other.ID, e.businessID, otherDevice, nil, nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatalf("register device: %v", err)
	}

	if rec, _ := e.reportState(t, sessionID, other.ID, `{"state":"live"}`); rec.Code != http.StatusNotFound {
		t.Errorf("another device's agent drove the session: status %d, want 404", rec.Code)
	}
	if rec, _ := e.reportState(t, sessionID, e.intruderID, `{"state":"live"}`); rec.Code != http.StatusNotFound {
		t.Errorf("an out-of-tenant agent drove the session: status %d, want 404", rec.Code)
	}
	// The owner has every permission, and is still not the publisher.
	if rec, _ := e.reportState(t, sessionID, e.ownerID, `{"state":"live"}`); rec.Code != http.StatusNotFound {
		t.Errorf("the owner reported publisher state: status %d, want 404", rec.Code)
	}
}

// An illegal transition means the publisher and the control plane disagree about
// where the session is. Absorbing that silently is how sessions get stuck in
// states nobody can explain.
func TestIllegalPublisherTransitionIsRefusedAndAudited(t *testing.T) {
	e := newMediaEnv(t)
	sessionID := e.startLive(t, e.ownerID)

	if rec, _ := e.reportState(t, sessionID, e.employeeID, `{"state":"ended"}`); rec.Code != http.StatusOK {
		t.Fatalf("end: %d", rec.Code)
	}
	rec, body := e.reportState(t, sessionID, e.employeeID, `{"state":"live"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("an ended session was revived: status %d", rec.Code)
	}
	if code := errorBody(t, body)["code"]; code != CodeInvalidState {
		t.Errorf("code = %v, want %s", code, CodeInvalidState)
	}

	events, err := e.store.MediaAuditForSession(e.ctx, e.ownerID, sessionID)
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	var denied bool
	for _, ev := range events {
		if ev.Action == store.AuditAgentState && ev.Outcome == store.OutcomeDenied {
			denied = true
		}
	}
	if !denied {
		t.Error("the refused transition was not audited")
	}
}

func TestAgentDemandIsBoundToDeviceAndCurrentMembership(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	path := "/v1/media/agent/session?device_id=" + e.deviceID
	rec, body := e.call(t, http.MethodGet, path, e.employeeID)
	if rec.Code != http.StatusOK || body["session_id"] != id || body["control_armed"] != false {
		t.Fatalf("agent demand: %d %v", rec.Code, body)
	}
	rec, _ = e.call(t, http.MethodGet, path, e.intruderID)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("other tenant discovered demand: %d", rec.Code)
	}
	rec, _ = e.call(t, http.MethodGet, "/v1/media/agent/session?device_id=invalid", e.employeeID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid device: %d", rec.Code)
	}
	if _, err := e.pool.Exec(e.ctx, "DELETE FROM memberships WHERE user_id=$1 AND business_id=$2", e.employeeID, e.businessID); err != nil {
		t.Fatal(err)
	}
	rec, _ = e.call(t, http.MethodGet, path, e.employeeID)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("removed membership kept demand: %d", rec.Code)
	}
	rec, _ = e.call(t, http.MethodPost, "/v1/media/sessions/"+id+"/publisher-token", e.employeeID)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("removed membership received token: %d", rec.Code)
	}
}

func TestEndingSessionCannotAuthorizeMoreCapture(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	if _, err := e.store.AdvanceMediaSession(e.ctx, id, media.StateEnding, ""); err != nil {
		t.Fatal(err)
	}
	rec, _ := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("ending session still requested capture: %d", rec.Code)
	}
	rec, _ = e.call(t, http.MethodPost, "/v1/media/sessions/"+id+"/publisher-token", e.employeeID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("ending session issued credentials: %d", rec.Code)
	}
}

type blockedRoomStop struct {
	media.MediaProvider
	entered chan struct{}
	release chan struct{}
}

func (p *blockedRoomStop) EndRoom(ctx context.Context, room string) error {
	close(p.entered)
	select {
	case <-p.release:
		return p.MediaProvider.EndRoom(ctx, room)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestStopWithdrawsAgentDemandBeforeWaitingForProvider(t *testing.T) {
	e := newMediaEnv(t)
	id := e.startLive(t, e.ownerID)
	provider := &blockedRoomStop{MediaProvider: e.provider, entered: make(chan struct{}), release: make(chan struct{})}
	e.handler.provider = provider
	done := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/v1/media/sessions/"+id+"/stop", nil)
		req.Header.Set("X-Test-User", e.ownerID)
		rec := httptest.NewRecorder()
		e.router.ServeHTTP(rec, req)
		done <- rec.Code
	}()
	defer func() {
		close(provider.release)
		select {
		case code := <-done:
			if code != http.StatusOK {
				t.Errorf("stop status: %d", code)
			}
		case <-time.After(3 * time.Second):
			t.Error("stop did not finish")
		}
	}()
	select {
	case <-provider.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("provider was not called")
	}
	rec, _ := e.call(t, http.MethodGet, "/v1/media/agent/session?device_id="+e.deviceID, e.employeeID)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("agent still authorized while SFU is blocked: %d", rec.Code)
	}
	rec, _ = e.call(t, http.MethodPost, "/v1/media/sessions/"+id+"/publisher-token", e.employeeID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("token granted during stop: %d", rec.Code)
	}
}
