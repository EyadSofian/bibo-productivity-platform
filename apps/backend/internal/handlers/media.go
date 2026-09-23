package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/media"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// MediaHandler is the video control plane.
//
// It never carries media bytes. It decides who may watch what, opens and closes
// rooms on the provider, mints short-lived scoped tokens, and records what
// happened. The bytes go agent → SFU → viewer, and separately to the recorder,
// without passing through this process (docs/adr/0002-video-first-media-plane.md).
type MediaHandler struct {
	store      *store.Store
	provider   media.MediaProvider
	recordings media.RecordingStore
	tokenTTL   time.Duration
	// roomEmptyTimeout is how long the provider keeps a room with nobody in it.
	roomEmptyTimeout time.Duration
}

// Short chunks make a finished, independently seekable recording available to
// reviewers within minutes while bounding the amount lost to a network or
// recorder failure.
const recordingChunkDuration = 5 * time.Minute
const recordingFinalizeDeadline = 45 * time.Minute

// Provider failures are normally quota or regional-capacity failures. Retrying
// on every one-second agent poll only creates failed rows and extra rooms; a
// bounded cooldown keeps telemetry healthy while still recovering without an
// operator after a transient outage or a plan upgrade.
const recordingProviderRetryCooldown = 15 * time.Minute

// NewMediaHandler wires the control plane.
func NewMediaHandler(s *store.Store, provider media.MediaProvider, recordings media.RecordingStore, tokenTTL time.Duration) *MediaHandler {
	return &MediaHandler{
		store:            s,
		provider:         provider,
		recordings:       recordings,
		tokenTTL:         tokenTTL,
		roomEmptyTimeout: 60 * time.Second,
	}
}

// StartRecordingMaintenance makes the five-minute boundary a server guarantee.
// The agent poll remains the fast path, while this sweeper closes an expired
// room even if authentication or the device network is unhealthy.
func (h *MediaHandler) StartRecordingMaintenance(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	go func() {
		h.sweepExpiredRecordings(ctx)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				h.sweepExpiredRecordings(ctx)
			}
		}
	}()
}

func (h *MediaHandler) sweepExpiredRecordings(ctx context.Context) {
	sessions, err := h.store.RecordingSessionsStartedBefore(ctx, time.Now().UTC().Add(-recordingChunkDuration))
	if err != nil {
		obs.Warn("recording rotation sweep failed", "err", err)
		return
	}
	for _, session := range sessions {
		updated, err := h.store.AdvanceMediaSession(ctx, session.ID, media.StateEnded, "")
		if err != nil {
			// A request or agent callback may have won this race.
			continue
		}
		_ = h.store.RecordMediaAudit(ctx, store.MediaAuditEvent{
			BusinessID: updated.BusinessID, MediaSessionID: updated.ID,
			ActorType: "system", ActorID: "recording-scheduler",
			Action: store.AuditRecordingStop, Outcome: store.OutcomeAllowed,
			Metadata: map[string]any{"device_id": updated.DeviceID, "reason": "chunk_duration"},
		})
		h.finalizeRecording(updated)
	}
}

// sessionResponse is the API shape of a session. It deliberately omits the
// provider room id: a viewer needs a token, and a room name in a response is an
// invitation to try joining one directly.
type sessionResponse struct {
	Session store.MediaSession `json:"session"`
}

// AgentSession exposes only an existing, authorised device session. Remote
// control is not armed by this video integration.
func (h *MediaHandler) AgentSession(c *gin.Context) {
	userID, _ := auth.UserID(c)
	deviceID := c.Query("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "device_id must be a uuid", false)
		return
	}
	session, err := h.store.PendingMediaSessionForAgent(c.Request.Context(), userID, deviceID)
	if errors.Is(err, store.ErrNotFound) {
		session, err = h.openScheduledRecording(c, userID, deviceID)
		if errors.Is(err, store.ErrNotFound) {
			c.Status(http.StatusNoContent)
			return
		}
	}
	if err != nil {
		mediaInternal(c, err)
		return
	}
	if session.Kind == media.KindRecording {
		active, policyErr := h.recordingPolicyActive(c, userID, deviceID)
		if policyErr != nil {
			mediaInternal(c, policyErr)
			return
		}
		if !active || time.Since(session.StartedAt) >= recordingChunkDuration {
			h.stopRecording(c, session)
			if !active {
				c.Status(http.StatusNoContent)
				return
			}
			session, err = h.openScheduledRecording(c, userID, deviceID)
			if err != nil {
				mediaInternal(c, err)
				return
			}
		}
	} else if h.expireUnwatched(c, session) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"session_id": session.ID, "room": session.ProviderRoomID, "state": session.State, "control_armed": false})
}

func (h *MediaHandler) recordingPolicyActive(c *gin.Context, userID, deviceID string) (bool, error) {
	enabled, active, err := h.monitoringKeyPolicy(c, userID, deviceID, "recording")
	return enabled && active, err
}

// monitoringKeyPolicy mirrors the schedule enforced by the desktop agent. A
// live request must not create a room while the agent is correctly refusing to
// capture outside its screen-monitoring hours.
func (h *MediaHandler) monitoringKeyPolicy(c *gin.Context, userID, deviceID, key string) (bool, bool, error) {
	resolved, err := h.store.ResolveMonitoringProfile(c.Request.Context(), userID, deviceID)
	if err != nil {
		return false, false, err
	}
	for _, detail := range resolved.Details {
		if detail.TrackingKey != key {
			continue
		}
		var enabled bool
		if err := json.Unmarshal(detail.TrackingVal, &enabled); err != nil || !enabled {
			return false, false, nil
		}
		active, err := store.ScheduleActiveAt(detail.DaysOfWeek, detail.StartMinute, detail.EndMinute, detail.Timezone, time.Now())
		return true, active, err
	}
	return false, false, nil
}

func (h *MediaHandler) openScheduledRecording(c *gin.Context, userID, deviceID string) (store.MediaSession, error) {
	active, err := h.recordingPolicyActive(c, userID, deviceID)
	if err != nil {
		return store.MediaSession{}, err
	}
	if !active {
		return store.MediaSession{}, store.ErrNotFound
	}
	target, err := h.store.MediaDeviceTargetFor(c.Request.Context(), userID, deviceID)
	if err != nil || !target.MonitoringEnabled || target.EmployeeID == "" {
		return store.MediaSession{}, store.ErrNotFound
	}
	providerCoolingDown, err := h.store.RecentRecordingProviderFailure(
		c.Request.Context(), target.BusinessID, target.DeviceID,
		time.Now().UTC().Add(-recordingProviderRetryCooldown),
	)
	if err != nil {
		return store.MediaSession{}, err
	}
	if providerCoolingDown {
		return store.MediaSession{}, store.ErrNotFound
	}
	session, created, err := h.store.OpenMediaSession(c.Request.Context(), store.NewMediaSession{
		BusinessID: target.BusinessID, EmployeeID: target.EmployeeID, DeviceID: target.DeviceID,
		Kind: media.KindRecording, Provider: h.provider.Name(), ProviderRoomID: uuid.NewString(),
		PolicySnapshot: h.policySnapshot(c, userID, deviceID),
	})
	if err != nil {
		return store.MediaSession{}, err
	}
	if !created {
		return session, nil
	}
	if _, err := h.provider.CreateRoom(c.Request.Context(), media.RoomSpec{
		Name: session.ProviderRoomID, EmptyTimeout: h.roomEmptyTimeout, MaxPublishers: 1,
	}); err != nil {
		h.failSession(c, session, media.FailRoomFailed)
		return store.MediaSession{}, err
	}
	if session, err = h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateAuthorizing, ""); err != nil {
		return store.MediaSession{}, err
	}
	if session, err = h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateWaitingForAgent, ""); err != nil {
		return store.MediaSession{}, err
	}
	h.auditAs(c, "system", "recording-scheduler", session.BusinessID, session.ID,
		store.AuditRecordingStart, store.OutcomeAllowed, map[string]any{"device_id": deviceID})
	return session, nil
}

func (h *MediaHandler) expireUnwatched(c *gin.Context, session store.MediaSession) bool {
	expired, err := h.store.ExpireUnwatchedMediaSession(c.Request.Context(), session.ID)
	if err != nil {
		mediaInternal(c, err)
		return true
	}
	if !expired {
		return false
	}
	h.auditAs(c, "system", "", session.BusinessID, session.ID, store.AuditLiveSessionStop, store.OutcomeAllowed, map[string]any{"reason": "viewer_heartbeat_timeout"})
	// The terminal row is committed first: a slow SFU cannot extend capture.
	_ = h.provider.EndRoom(c.Request.Context(), session.ProviderRoomID)
	c.Status(http.StatusNoContent)
	return true
}

type tokenResponse struct {
	URL       string    `json:"url,omitempty"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	Room      string    `json:"room"`
	// Permissions the token actually carries, so a client can assert scope
	// without decoding a vendor token.
	CanPublish   bool `json:"can_publish"`
	CanSubscribe bool `json:"can_subscribe"`
}

// StartLive opens (or joins) a live session for a device.
// POST /v1/devices/:device_id/media/live
func (h *MediaHandler) StartLive(c *gin.Context) {
	userID, _ := auth.UserID(c)
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "device_id must be a uuid", false)
		return
	}

	target, err := h.store.MediaDeviceTargetFor(c.Request.Context(), userID, deviceID)
	if errors.Is(err, store.ErrNotFound) {
		mediaError(c, http.StatusNotFound, CodeDeviceNotFound, "Device not found.", false)
		return
	}
	if err != nil {
		mediaInternal(c, err)
		return
	}

	if !h.require(c, userID, target.BusinessID, media.PermLiveViewStart, store.AuditLiveSessionStart) {
		return
	}

	// Policy first, transport second. An owner who is not allowed to watch this
	// device right now must be refused before a room exists and before the agent
	// is told to publish anything.
	if !target.MonitoringEnabled {
		h.audit(c, target.BusinessID, "", store.AuditLiveSessionStart, store.OutcomeDenied,
			map[string]any{"device_id": deviceID, "reason": string(media.FailDeniedByPolicy)})
		mediaError(c, http.StatusConflict, CodeMonitoringDisabled,
			"Monitoring is turned off for this device.", false)
		return
	}
	screenEnabled, screenActive, err := h.monitoringKeyPolicy(c, userID, deviceID, "screen")
	if err != nil {
		mediaInternal(c, err)
		return
	}
	if !screenEnabled {
		h.audit(c, target.BusinessID, "", store.AuditLiveSessionStart, store.OutcomeDenied,
			map[string]any{"device_id": deviceID, "reason": string(media.FailDeniedByPolicy)})
		mediaError(c, http.StatusConflict, CodeMonitoringDisabled,
			"Screen monitoring is turned off for this device.", false)
		return
	}
	if !screenActive {
		h.audit(c, target.BusinessID, "", store.AuditLiveSessionStart, store.OutcomeDenied,
			map[string]any{"device_id": deviceID, "reason": "outside_screen_schedule"})
		mediaError(c, http.StatusConflict, CodeOutsideSchedule,
			"Live view is outside this device's scheduled screen-monitoring hours.", false)
		return
	}
	if !target.Online {
		h.audit(c, target.BusinessID, "", store.AuditLiveSessionStart, store.OutcomeDenied,
			map[string]any{"device_id": deviceID, "reason": string(media.FailAgentOffline)})
		mediaError(c, http.StatusConflict, CodeAgentOffline, "The device is offline.", true)
		return
	}

	// Continuous recording already has the device publishing. A live viewer
	// subscribes to that same room and leaves the recording lifecycle alone.
	if recording, recErr := h.store.OpenRecordingMediaSessionFor(c.Request.Context(), deviceID); recErr == nil {
		h.audit(c, recording.BusinessID, recording.ID, store.AuditLiveSessionJoin, store.OutcomeAllowed,
			map[string]any{"device_id": deviceID, "kind": string(media.KindRecording)})
		c.JSON(http.StatusOK, sessionResponse{Session: recording})
		return
	} else if !errors.Is(recErr, store.ErrNotFound) {
		mediaInternal(c, recErr)
		return
	}

	// The room name is a fresh random uuid with no relationship to the employee,
	// the device or the business. Anyone who can see provider-side room lists
	// learns nothing about who is being watched.
	roomName := uuid.NewString()
	session, created, err := h.store.OpenMediaSession(c.Request.Context(), store.NewMediaSession{
		BusinessID:     target.BusinessID,
		EmployeeID:     target.EmployeeID,
		DeviceID:       target.DeviceID,
		Kind:           media.KindLive,
		Provider:       h.provider.Name(),
		ProviderRoomID: roomName,
		PolicySnapshot: h.policySnapshot(c, userID, deviceID),
		CreatedBy:      userID,
	})
	if err != nil {
		mediaInternal(c, err)
		return
	}

	if created {
		// Only the session that actually created the row creates the room. A
		// second viewer joining must not create a second room for the same
		// session.
		if _, err := h.provider.CreateRoom(c.Request.Context(), media.RoomSpec{
			Name:          session.ProviderRoomID,
			EmptyTimeout:  h.roomEmptyTimeout,
			MaxPublishers: 1, // the agent, and nobody else
		}); err != nil {
			h.failSession(c, session, media.FailRoomFailed)
			h.providerError(c, err)
			return
		}
		if _, err := h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateAuthorizing, ""); err != nil {
			mediaInternal(c, err)
			return
		}
		var advanced store.MediaSession
		if advanced, err = h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateWaitingForAgent, ""); err != nil {
			mediaInternal(c, err)
			return
		}
		session = advanced
	}

	action := store.AuditLiveSessionJoin
	if created {
		action = store.AuditLiveSessionStart
	}
	h.audit(c, session.BusinessID, session.ID, action, store.OutcomeAllowed,
		map[string]any{"device_id": deviceID, "kind": string(media.KindLive)})

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	c.JSON(status, sessionResponse{Session: session})
}

// Session reads one session.
// GET /v1/media/sessions/:session_id
func (h *MediaHandler) Session(c *gin.Context) {
	userID, _ := auth.UserID(c)
	session, ok := h.memberSession(c, userID)
	if !ok {
		return
	}
	if !h.require(c, userID, session.BusinessID, media.PermLiveViewWatch, store.AuditSessionRead) {
		return
	}
	c.JSON(http.StatusOK, sessionResponse{Session: session})
}

// ViewerHeartbeat renews the current viewer's lease and returns session state.
// Reading the session alone must not keep unattended screen capture alive.
func (h *MediaHandler) ViewerHeartbeat(c *gin.Context) {
	userID, _ := auth.UserID(c)
	session, ok := h.memberSession(c, userID)
	if !ok {
		return
	}
	if !h.require(c, userID, session.BusinessID, media.PermLiveViewWatch, store.AuditSessionRead) {
		return
	}
	if !session.State.Terminal() && session.State != media.StateEnding {
		if err := h.store.TouchViewerSession(c.Request.Context(), session.ID, userID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				mediaError(c, http.StatusConflict, CodeSessionEnded, "Viewer session expired. Start watching again.", false)
				return
			}
			mediaInternal(c, err)
			return
		}
	}
	c.JSON(http.StatusOK, sessionResponse{Session: session})
}

// ViewerToken mints a short-lived subscribe-only token.
// POST /v1/media/sessions/:session_id/viewer-token
//
// Permissions are re-checked here rather than trusted from session creation: a
// session can outlive the grant that started it, and a token minted now must
// reflect what the caller may do now.
func (h *MediaHandler) ViewerToken(c *gin.Context) {
	userID, _ := auth.UserID(c)
	session, ok := h.memberSession(c, userID)
	if !ok {
		return
	}
	if !h.require(c, userID, session.BusinessID, media.PermLiveViewWatch, store.AuditViewerTokenMint) {
		return
	}
	if session.State.Terminal() {
		h.audit(c, session.BusinessID, session.ID, store.AuditViewerTokenMint, store.OutcomeDenied,
			map[string]any{"reason": "session_terminal", "state": string(session.State)})
		mediaError(c, http.StatusConflict, CodeSessionEnded, "This session has ended.", false)
		return
	}

	token, err := h.provider.MintSubscriberToken(c.Request.Context(), media.SubscriberTokenRequest{
		Room:     session.ProviderRoomID,
		Identity: userID,
		TTL:      h.tokenTTL,
	})
	if err != nil {
		h.audit(c, session.BusinessID, session.ID, store.AuditViewerTokenMint, store.OutcomeError,
			map[string]any{"reason": "provider"})
		h.providerError(c, err)
		return
	}

	if _, err := h.store.JoinViewerSession(c.Request.Context(), session.ID, session.BusinessID, userID); err != nil {
		mediaInternal(c, err)
		return
	}
	h.audit(c, session.BusinessID, session.ID, store.AuditViewerTokenMint, store.OutcomeAllowed,
		map[string]any{"expires_in_s": int(h.tokenTTL.Seconds())})

	c.JSON(http.StatusOK, tokenResponse{
		Token:        token.Value,
		URL:          token.URL,
		ExpiresAt:    token.ExpiresAt,
		Room:         session.ProviderRoomID,
		CanPublish:   token.CanPublish,
		CanSubscribe: token.CanSubscribe,
	})
}

// PublisherToken mints a short-lived publish-only token for the agent.
// POST /v1/media/sessions/:session_id/publisher-token
//
// Agent authentication only. The store predicate requires the session's device
// to belong to the calling agent's own user, so an agent holding a valid token
// for its own device cannot mint a publisher token for somebody else's.
func (h *MediaHandler) PublisherToken(c *gin.Context) {
	agentUserID, _ := auth.UserID(c)
	sessionID := c.Param("session_id")
	if _, err := uuid.Parse(sessionID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "session_id must be a uuid", false)
		return
	}

	session, err := h.store.MediaSessionForAgent(c.Request.Context(), agentUserID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		// Same answer whether the session does not exist, belongs to another
		// device, or the device was archived: an agent must not be able to probe
		// for session ids.
		mediaError(c, http.StatusNotFound, CodeSessionNotFound, "Session not found.", false)
		return
	}
	if err != nil {
		mediaInternal(c, err)
		return
	}
	if session.State.Terminal() || session.State == media.StateEnding {
		mediaError(c, http.StatusConflict, CodeSessionEnded, "This session has ended.", false)
		return
	}

	if session.State == media.StateRequested || session.State == media.StateAuthorizing {
		mediaError(c, http.StatusConflict, CodeInvalidState, "The session is not authorized to publish yet.", true)
		return
	}

	token, err := h.provider.MintPublisherToken(c.Request.Context(), media.PublisherTokenRequest{
		Room:     session.ProviderRoomID,
		Identity: session.DeviceID,
		TTL:      h.tokenTTL,
		// Screen only. An agent has no reason to publish audio in this slice,
		// and a token that could is a wider grant than the feature needs.
		Sources: []media.TrackSource{media.SourceScreen},
	})
	if err != nil {
		h.audit(c, session.BusinessID, session.ID, store.AuditPublisherTokenMint, store.OutcomeError,
			map[string]any{"reason": "provider"})
		h.providerError(c, err)
		return
	}

	// The agent asking to publish is what moves the session out of waiting.
	if session.State == media.StateWaitingForAgent {
		if advanced, err := h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateNegotiating, ""); err == nil {
			session = advanced
		}
	}

	h.auditAs(c, "agent", session.DeviceID, session.BusinessID, session.ID,
		store.AuditPublisherTokenMint, store.OutcomeAllowed,
		map[string]any{"expires_in_s": int(h.tokenTTL.Seconds()), "device_id": session.DeviceID})

	c.JSON(http.StatusOK, tokenResponse{
		Token:        token.Value,
		URL:          token.URL,
		ExpiresAt:    token.ExpiresAt,
		Room:         session.ProviderRoomID,
		CanPublish:   token.CanPublish,
		CanSubscribe: token.CanSubscribe,
	})
}

// agentStateReq is what a publisher reports as it progresses.
type agentStateReq struct {
	State string `json:"state"`
	// FailureCode is required when state is "failed" and ignored otherwise. A
	// failure with no code is what produces "live view didn't work" with nothing
	// to act on, so it is rejected rather than defaulted.
	FailureCode string `json:"failure_code"`
	// Track describes what is being published, recorded once when the publisher
	// reaches "live". Optional: a publisher that cannot describe its encoding
	// must still be able to report that it is live.
	Track *agentTrackReq `json:"track"`
}

type agentTrackReq struct {
	Source     string  `json:"source"`
	Codec      string  `json:"codec"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	NominalFPS float64 `json:"nominal_fps"`
}

// AgentState is how a publisher drives its own session forward.
// POST /v1/agent/media/sessions/:session_id/state
//
// The publisher is the only party that knows whether media is actually flowing:
// the API cannot see the SFU's tracks, and a viewer cannot tell "connecting"
// from "connected but black". So negotiating → live, the reconnect cycle, and
// every capture or encoder failure are reported from here.
//
// Agent-authenticated, with the same predicate as the publisher token: the
// session's device must belong to the calling agent's own user.
func (h *MediaHandler) AgentState(c *gin.Context) {
	agentUserID, _ := auth.UserID(c)
	sessionID := c.Param("session_id")
	if _, err := uuid.Parse(sessionID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "session_id must be a uuid", false)
		return
	}

	var req agentStateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "invalid body", false)
		return
	}
	to := media.State(req.State)
	if !to.Valid() {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "unknown state", false)
		return
	}
	// A publisher reports what IT does. It cannot claim the states that belong to
	// the control plane -- authorizing a session or deciding it was requested --
	// so those are refused here even though the machine would allow them.
	if !agentReportableStates[to] {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest,
			"a publisher cannot report that state", false)
		return
	}

	var failure media.FailureCode
	if to == media.StateFailed {
		failure = media.FailureCode(req.FailureCode)
		if !media.ValidFailureCode(failure) {
			mediaError(c, http.StatusBadRequest, CodeInvalidRequest,
				"failed requires a known failure_code", false)
			return
		}
	}

	session, err := h.store.MediaSessionForAgent(c.Request.Context(), agentUserID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		mediaError(c, http.StatusNotFound, CodeSessionNotFound, "Session not found.", false)
		return
	}
	if err != nil {
		mediaInternal(c, err)
		return
	}

	updated, err := h.store.AdvanceMediaSession(c.Request.Context(), session.ID, to, failure)
	if errors.Is(err, store.ErrNotFound) {
		mediaError(c, http.StatusNotFound, CodeSessionNotFound, "Session not found.", false)
		return
	}
	if err != nil {
		// An illegal transition is the publisher and the control plane
		// disagreeing about where the session is. That is worth telling the
		// publisher plainly rather than absorbing.
		h.auditAs(c, "agent", session.DeviceID, session.BusinessID, session.ID,
			store.AuditAgentState, store.OutcomeDenied,
			map[string]any{"from": string(session.State), "to": req.State})
		mediaError(c, http.StatusConflict, CodeInvalidState, err.Error(), false)
		return
	}

	if to == media.StateLive && req.Track != nil {
		// Best effort: a track row that cannot be written must not undo a
		// session that is genuinely live.
		if err := h.recordTrack(c, updated, req.Track); err != nil {
			obs.Warn("media track not recorded", "err", err, "session", updated.ID)
		}
	}
	if to == media.StateLive && updated.Kind == media.KindRecording {
		if err := h.startRecording(c, updated); err != nil {
			_ = h.provider.EndRoom(c.Request.Context(), updated.ProviderRoomID)
			_, _ = h.store.AdvanceMediaSession(c.Request.Context(), updated.ID, media.StateFailed, media.FailProviderUnavailable)
			h.providerError(c, err)
			return
		}
	}

	h.auditAs(c, "agent", session.DeviceID, session.BusinessID, session.ID,
		store.AuditAgentState, store.OutcomeAllowed,
		map[string]any{"state": string(to), "failure_code": string(failure)})
	if updated.Kind == media.KindRecording && to.Terminal() {
		h.stopRecording(c, updated)
	}

	c.JSON(http.StatusOK, sessionResponse{Session: updated})
}

// agentReportableStates is what a publisher is allowed to say about itself.
// Everything else belongs to the control plane.
var agentReportableStates = map[media.State]bool{
	media.StateNegotiating:  true,
	media.StateLive:         true,
	media.StateReconnecting: true,
	media.StateEnded:        true,
	media.StateFailed:       true,
}

func (h *MediaHandler) recordTrack(c *gin.Context, session store.MediaSession, t *agentTrackReq) error {
	source := media.TrackSource(t.Source)
	if source == "" {
		source = media.SourceScreen
	}
	return h.store.RecordMediaTrack(c.Request.Context(), store.NewMediaTrack{
		BusinessID:     session.BusinessID,
		MediaSessionID: session.ID,
		Source:         source,
		Codec:          t.Codec,
		Width:          t.Width,
		Height:         t.Height,
		NominalFPS:     t.NominalFPS,
	})
}

// Stop ends a session.
// POST /v1/media/sessions/:session_id/stop
//
// Stopping is idempotent: an already-ended session returns success. A client
// that stops twice -- a closed tab plus an explicit stop -- has achieved what it
// asked for, and failing the second call would only teach clients to ignore
// errors from this endpoint.
func (h *MediaHandler) Stop(c *gin.Context) {
	userID, _ := auth.UserID(c)
	session, ok := h.memberSession(c, userID)
	if !ok {
		return
	}
	if !h.require(c, userID, session.BusinessID, media.PermLiveViewStart, store.AuditLiveSessionStop) {
		return
	}
	if session.Kind == media.KindRecording {
		if err := h.store.LeaveViewerSession(c.Request.Context(), session.ID, userID, "viewer_left"); err != nil {
			mediaInternal(c, err)
			return
		}
		h.audit(c, session.BusinessID, session.ID, store.AuditLiveSessionLeave, store.OutcomeAllowed, nil)
		c.JSON(http.StatusOK, sessionResponse{Session: session})
		return
	}

	updated, remaining, ended, err := h.store.LeaveMediaViewerAndMaybeEnd(c.Request.Context(), session.ID, userID)
	if err != nil {
		mediaInternal(c, err)
		return
	}
	session = updated
	if !ended && session.State.Terminal() {
		c.JSON(http.StatusOK, sessionResponse{Session: updated})
		return
	}

	// Another viewer is still attached: this caller leaves, the session stays.
	// Ending it would cut off everyone else because one person closed a tab.
	if remaining > 0 {
		h.audit(c, session.BusinessID, session.ID, store.AuditLiveSessionLeave, store.OutcomeAllowed,
			map[string]any{"remaining_viewers": remaining})
		c.JSON(http.StatusOK, sessionResponse{Session: session})
		return
	}

	// Persist the stop before calling an external provider. The agent polls this
	// row and must stop even when the SFU is slow or unreachable.
	if err := h.provider.EndRoom(c.Request.Context(), session.ProviderRoomID); err != nil && !errors.Is(err, media.ErrRoomNotFound) {
		h.audit(c, session.BusinessID, session.ID, store.AuditLiveSessionStop, store.OutcomeError,
			map[string]any{"reason": "end_room_failed"})
	}

	h.audit(c, updated.BusinessID, updated.ID, store.AuditLiveSessionStop, store.OutcomeAllowed,
		map[string]any{"device_id": updated.DeviceID})
	c.JSON(http.StatusOK, sessionResponse{Session: updated})
}

func (h *MediaHandler) startRecording(c *gin.Context, session store.MediaSession) error {
	objectKey := "tenant/" + session.BusinessID + "/device/" + session.DeviceID + "/date/" +
		time.Now().UTC().Format("2006-01-02") + "/session/" + session.ID + "/screen.mp4"
	asset, err := h.store.CreateRecordingAsset(c.Request.Context(), session, objectKey, "s3")
	if err != nil {
		return err
	}
	if asset.ProviderRecordingID != "" {
		return nil
	}
	job, err := h.provider.StartRecording(c.Request.Context(), media.RecordingRequest{
		Room: session.ProviderRoomID, ParticipantIdentity: session.DeviceID,
		AssetID: asset.ID, Prefix: "", ObjectKey: objectKey,
	})
	if err != nil {
		_ = h.store.FailRecordingAsset(c.Request.Context(), asset.ID)
		return err
	}
	return h.store.StartRecordingAsset(c.Request.Context(), asset.ID, job.ID)
}

func (h *MediaHandler) stopRecording(c *gin.Context, session store.MediaSession) {
	asset, err := h.store.RecordingAssetForSession(c.Request.Context(), session.ID)
	if !session.State.Terminal() {
		if ended, endErr := h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateEnded, ""); endErr == nil {
			session = ended
		}
	}
	h.auditAs(c, "system", "recording-scheduler", session.BusinessID, session.ID,
		store.AuditRecordingStop, store.OutcomeAllowed, map[string]any{"device_id": session.DeviceID})
	h.finalizeRecordingAsset(session, asset, err)
}

func (h *MediaHandler) finalizeRecording(session store.MediaSession) {
	asset, err := h.store.RecordingAssetForSession(context.Background(), session.ID)
	h.finalizeRecordingAsset(session, asset, err)
}

func (h *MediaHandler) finalizeRecordingAsset(session store.MediaSession, asset store.RecordingAsset, assetErr error) {
	// Finalizing an MP4 can take longer than the agent's two-second authorization
	// poll. The database stop is already committed, so finish provider teardown
	// in the background and let the agent move to its next chunk immediately.
	go func() {
		endedAt := time.Now().UTC()
		if session.EndedAt != nil {
			endedAt = *session.EndedAt
		}
		stopCtx, cancelStop := context.WithTimeout(context.Background(), 2*time.Minute)
		if assetErr == nil && asset.ProviderRecordingID != "" {
			if stopErr := h.provider.StopRecording(stopCtx, asset.ProviderRecordingID); stopErr != nil {
				obs.Warn("recording provider stop did not confirm", "recording_id", asset.ID, "err", stopErr)
			}
			_ = h.store.ProcessRecordingAsset(context.Background(), asset.ID, endedAt)
			go h.waitForRecordingAsset(asset, endedAt)
		}
		cancelStop()
		roomCtx, cancelRoom := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelRoom()
		_ = h.provider.EndRoom(roomCtx, session.ProviderRoomID)
	}()
}

func (h *MediaHandler) waitForRecordingAsset(asset store.RecordingAsset, started time.Time) {
	deadline := started.Add(recordingFinalizeDeadline)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		verification, err := h.recordings.VerifyAsset(ctx, asset.ManifestKey)
		cancel()
		if err == nil && verification.Exists && verification.ByteSize > 0 {
			_ = h.store.ReadyRecordingAsset(context.Background(), asset.ID, verification.ByteSize)
			return
		}
		time.Sleep(15 * time.Second)
	}
	_ = h.store.FailRecordingAsset(context.Background(), asset.ID)
	obs.Warn("recording asset did not finalize before deadline", "recording_id", asset.ID)
}

// memberSession loads a session the caller's tenant owns, writing the error
// response itself. A session in another tenant is reported as not found.
func (h *MediaHandler) memberSession(c *gin.Context, userID string) (store.MediaSession, bool) {
	sessionID := c.Param("session_id")
	if _, err := uuid.Parse(sessionID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "session_id must be a uuid", false)
		return store.MediaSession{}, false
	}
	session, err := h.store.MediaSessionForMember(c.Request.Context(), userID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		mediaError(c, http.StatusNotFound, CodeSessionNotFound, "Session not found.", false)
		return store.MediaSession{}, false
	}
	if err != nil {
		mediaInternal(c, err)
		return store.MediaSession{}, false
	}
	return session, true
}

// require enforces one permission, recording the denial. A refusal that leaves
// no trace is indistinguishable from nobody having tried.
func (h *MediaHandler) require(c *gin.Context, userID, businessID string, perm media.Permission, action string) bool {
	role, err := h.store.MediaRoleFor(c.Request.Context(), userID, businessID)
	if errors.Is(err, store.ErrNotFound) {
		h.audit(c, businessID, "", action, store.OutcomeDenied,
			map[string]any{"permission": string(perm), "reason": "not_a_member"})
		mediaError(c, http.StatusForbidden, CodeForbidden, "You do not have access to this.", false)
		return false
	}
	if err != nil {
		mediaInternal(c, err)
		return false
	}
	if !media.PermissionsForRole(role).Has(perm) {
		h.audit(c, businessID, "", action, store.OutcomeDenied,
			map[string]any{"permission": string(perm), "role": role})
		mediaError(c, http.StatusForbidden, CodeForbidden, "You do not have access to this.", false)
		return false
	}
	return true
}

// providerError turns a provider failure into the right code. "Not configured"
// is a deployment fact, not a fault, and telling the two apart is the difference
// between an operator checking the SFU and an operator checking nothing.
func (h *MediaHandler) providerError(c *gin.Context, err error) {
	if errors.Is(err, media.ErrProviderUnconfigured) {
		mediaError(c, http.StatusServiceUnavailable, CodeProviderUnconfigured,
			"Live video is not available on this deployment yet.", false)
		return
	}
	obs.Error("media provider error",
		"err", err,
		"path", c.FullPath(),
		"method", c.Request.Method,
		"request_id", requestIDFor(c))
	mediaError(c, http.StatusServiceUnavailable, CodeProviderError,
		"The video provider is temporarily unavailable. Recording will retry later.", true)
}

// failSession marks a session failed on a best-effort basis. The caller is
// already returning an error to the client, so a failure to record the failure
// must not replace that response.
func (h *MediaHandler) failSession(c *gin.Context, session store.MediaSession, code media.FailureCode) {
	if _, err := h.store.AdvanceMediaSession(c.Request.Context(), session.ID, media.StateFailed, code); err != nil {
		return
	}
	h.audit(c, session.BusinessID, session.ID, store.AuditLiveSessionStart, store.OutcomeError,
		map[string]any{"failure_code": string(code)})
}

func (h *MediaHandler) audit(c *gin.Context, businessID, sessionID, action, outcome string, metadata map[string]any) {
	userID, _ := auth.UserID(c)
	h.auditAs(c, "user", userID, businessID, sessionID, action, outcome, metadata)
}

// auditAs writes an audit row. A failure to write one is logged but never fails
// the request: refusing to serve because the audit trail is unavailable would
// turn an observability outage into a monitoring outage. It is logged loudly so
// the gap is visible rather than silent.
func (h *MediaHandler) auditAs(c *gin.Context, actorType, actorID, businessID, sessionID, action, outcome string, metadata map[string]any) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["request_id"] = requestIDFor(c)
	err := h.store.RecordMediaAudit(c.Request.Context(), store.MediaAuditEvent{
		BusinessID:     businessID,
		MediaSessionID: sessionID,
		ActorType:      actorType,
		ActorID:        actorID,
		Action:         action,
		Outcome:        outcome,
		Metadata:       metadata,
	})
	if err != nil {
		auditWriteFailed(c, action, err)
	}
}

// policySnapshot captures the monitoring policy as it is right now, so a
// historical session can still be explained after the profile changes. A
// snapshot that cannot be read is stored as empty rather than blocking the
// session: no snapshot is a gap in the record, but a refused session is a
// broken feature.
func (h *MediaHandler) policySnapshot(c *gin.Context, userID, deviceID string) json.RawMessage {
	resolved, err := h.store.ResolveMonitoringProfile(c.Request.Context(), userID, deviceID)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	encoded, err := json.Marshal(resolved)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}
