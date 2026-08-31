package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/live"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxRemoteFrameBytes = 256 * 1024

// framePersistInterval bounds how often a live session touches Postgres for
// durable bookkeeping. Frames themselves never go there.
const framePersistInterval = 10 * time.Second

// streamKeepalive keeps SSE connections alive through proxies that close idle
// connections, and lets the handler notice a client that has gone away.
const streamKeepalive = 20 * time.Second

type RemoteAssistHandler struct {
	store    *store.Store
	live     *live.Hub
	commands *live.CommandBus
}

func NewRemoteAssistHandler(s *store.Store, hub *live.Hub, bus *live.CommandBus) *RemoteAssistHandler {
	return &RemoteAssistHandler{store: s, live: hub, commands: bus}
}

func remoteSessionID(c *gin.Context) (string, bool) {
	sessionID := c.Param("session_id")
	if _, err := uuid.Parse(sessionID); err != nil {
		badRequest(c, "session_id must be a uuid")
		return "", false
	}
	return sessionID, true
}

// Request creates a short pending request. The desktop activates it after either
// a per-session decision or a one-time, device-local unattended-support opt-in.
func (h *RemoteAssistHandler) Request(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	session, err := h.store.CreateRemoteAssist(c.Request.Context(), ownerID, deviceID)
	switch {
	case errors.Is(err, store.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "a remote assistance session is already open"})
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusConflict, gin.H{"error": "the Windows device is offline or unavailable"})
	case err != nil:
		serverError(c, err)
	default:
		// Surface the consent prompt on the employee's screen now rather than on
		// the agent's next 2s poll. The poll still finds it if this is missed.
		h.commands.Publish(deviceID, live.Command{Type: live.CommandRemoteAssistPending})
		obs.Info("remote assistance requested", "owner", ownerID, "device", deviceID, "session", session.ID)
		c.JSON(http.StatusAccepted, gin.H{"session": session})
	}
}

func (h *RemoteAssistHandler) Session(c *gin.Context) {
	userID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	session, err := h.store.RemoteAssistForUser(c.Request.Context(), userID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": session})
}

// Pending is the device-agent poll. The authenticated account and device id
// must both match the session.
func (h *RemoteAssistHandler) Pending(c *gin.Context) {
	employeeID, _ := auth.UserID(c)
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	session, err := h.store.PendingRemoteAssist(c.Request.Context(), employeeID, deviceID)
	if err != nil {
		serverError(c, err)
		return
	}
	if session == nil {
		c.Status(http.StatusNoContent)
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": session})
}

type remoteDecisionReq struct {
	Accepted *bool `json:"accepted"`
}

func (h *RemoteAssistHandler) Decide(c *gin.Context) {
	employeeID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	var req remoteDecisionReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Accepted == nil {
		badRequest(c, "accepted is required")
		return
	}
	session, err := h.store.DecideRemoteAssist(c.Request.Context(), employeeID, sessionID, *req.Accepted)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusConflict, gin.H{"error": "request expired or is not available"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	obs.Info("remote assistance decision", "employee", employeeID, "session", session.ID, "accepted", *req.Accepted)
	c.JSON(http.StatusOK, gin.H{"session": session})
}

func (h *RemoteAssistHandler) End(c *gin.Context) {
	actorID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	session, err := h.store.EndRemoteAssist(c.Request.Context(), actorID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusConflict, gin.H{"error": "session is no longer active"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	// Release the in-memory frame and close attached viewers' streams.
	h.live.DropSession(sessionID)
	obs.Info("remote assistance ended", "actor", actorID, "session", session.ID)
	c.JSON(http.StatusOK, gin.H{"session": session})
}

type remoteActionReq struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

type pointPayload struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button string  `json:"button"`
}

type keyPayload struct {
	Key string `json:"key"`
}

type textPayload struct {
	Text string `json:"text"`
}

func validateRemoteAction(req remoteActionReq) bool {
	switch req.Kind {
	case "click", "move":
		var payload pointPayload
		if json.Unmarshal(req.Payload, &payload) != nil ||
			math.IsNaN(payload.X) || math.IsNaN(payload.Y) ||
			payload.X < 0 || payload.X > 1 || payload.Y < 0 || payload.Y > 1 {
			return false
		}
		return req.Kind == "move" || payload.Button == "left" || payload.Button == "right"
	case "key":
		var payload keyPayload
		if json.Unmarshal(req.Payload, &payload) != nil {
			return false
		}
		switch payload.Key {
		case "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight":
			return true
		}
		return false
	case "text":
		var payload textPayload
		return json.Unmarshal(req.Payload, &payload) == nil && len([]rune(payload.Text)) > 0 && len([]rune(payload.Text)) <= 256
	default:
		return false
	}
}

func (h *RemoteAssistHandler) Action(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	var req remoteActionReq
	if err := c.ShouldBindJSON(&req); err != nil || !validateRemoteAction(req) {
		badRequest(c, "invalid remote action")
		return
	}
	id, err := h.store.EnqueueRemoteAssistAction(c.Request.Context(), ownerID, sessionID, req.Kind, req.Payload)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusConflict, gin.H{"error": "session is not active"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"action_id": id})
}

func (h *RemoteAssistHandler) Actions(c *gin.Context) {
	employeeID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	after, err := strconv.ParseInt(c.DefaultQuery("after", "0"), 10, 64)
	if err != nil || after < 0 {
		badRequest(c, "after must be a non-negative integer")
		return
	}
	actions, err := h.store.ConsumeRemoteAssistActions(c.Request.Context(), employeeID, sessionID, after)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"actions": actions})
}

func (h *RemoteAssistHandler) UploadFrame(c *gin.Context) {
	employeeID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	if !strings.HasPrefix(c.GetHeader("Content-Type"), "image/webp") {
		badRequest(c, "frame must be image/webp")
		return
	}
	width, widthErr := strconv.Atoi(c.GetHeader("X-Frame-Width"))
	height, heightErr := strconv.Atoi(c.GetHeader("X-Frame-Height"))
	if widthErr != nil || heightErr != nil || width <= 0 || height <= 0 || width > 10000 || height > 10000 {
		badRequest(c, "invalid frame dimensions")
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRemoteFrameBytes)
	data, err := io.ReadAll(c.Request.Body)
	if err != nil || len(data) == 0 || len(data) > maxRemoteFrameBytes {
		badRequest(c, "invalid or oversized frame")
		return
	}
	// Authorization stays in Postgres; only the bytes are kept out of it.
	if err := h.store.AuthorizeRemoteAssistFrame(c.Request.Context(), employeeID, sessionID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusConflict, gin.H{"error": "session is not active"})
			return
		}
		serverError(c, err)
		return
	}
	if err := h.live.PutFrame(sessionID, live.Frame{
		Bytes: data, Width: width, Height: height,
	}); err != nil {
		serverError(c, err)
		return
	}
	if h.live.ShouldPersist(sessionID, framePersistInterval) {
		if err := h.store.MarkRemoteAssistFrameAt(c.Request.Context(), employeeID, sessionID); err != nil {
			// Bookkeeping only: the frame is already visible to viewers, so a
			// failed timestamp update must not fail the upload.
			obs.Warn("remote assist last_frame_at update failed", "err", err, "session", sessionID)
		}
	}
	c.Status(http.StatusNoContent)
}

// Frame returns the newest frame as a plain image response. The dashboard now
// uses FrameStream instead, but this endpoint is kept as the graceful-degradation
// path for a client that cannot hold a stream open (a corporate proxy that buffers
// or blocks text/event-stream), and because removing a live API route needs a
// deprecation cycle. It reads from the same in-memory hub, so it no longer
// touches Postgres for the bytes either.
func (h *RemoteAssistHandler) Frame(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	if err := h.store.AuthorizeRemoteAssistViewer(c.Request.Context(), ownerID, sessionID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.Status(http.StatusNoContent)
			return
		}
		serverError(c, err)
		return
	}
	frame, ok := h.live.Frame(sessionID)
	if !ok {
		c.Status(http.StatusNoContent)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Frame-Width", strconv.Itoa(frame.Width))
	c.Header("X-Frame-Height", strconv.Itoa(frame.Height))
	c.Header("X-Frame-At", frame.ReceivedAt.UTC().Format(http.TimeFormat))
	c.Data(http.StatusOK, "image/webp", frame.Bytes)
}

// FrameStream pushes live frames to the owner over Server-Sent Events, so the
// dashboard renders a frame the moment it lands instead of discovering it on a
// poll (docs/FULL_SYSTEM_AUDIT.md P0-1: the poll alone cost 0-3s per frame).
//
// SSE is deliberate: it needs no new dependency, survives the Cloudflare
// Tunnel in front of production, and browsers reconnect on their own. The event
// contract is transport-agnostic so a WebSocket can replace it without
// touching the client's rendering path.
//
// Frames are base64-encoded in a JSON event rather than sent as binary, which
// SSE cannot carry. At the 256 KiB frame cap that is ~341 KiB on the wire.
func (h *RemoteAssistHandler) FrameStream(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	if err := h.store.AuthorizeRemoteAssistViewer(c.Request.Context(), ownerID, sessionID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusConflict, gin.H{"error": "session is not active"})
			return
		}
		serverError(c, err)
		return
	}

	// gin.ResponseWriter embeds http.Flusher, so flushing is always available.
	flusher := c.Writer

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store")
	c.Header("Connection", "keep-alive")
	// Defeat proxy buffering, which would otherwise hold frames back and
	// reintroduce exactly the latency this endpoint removes.
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher.Flush()

	frames, cancel := h.live.Subscribe(sessionID)
	defer cancel()

	keepalive := time.NewTicker(streamKeepalive)
	defer keepalive.Stop()

	streamFrames(c.Request.Context(), c.Writer, flusher, frames, keepalive.C)
}

// streamFrames is the transport-independent body of FrameStream: it forwards
// frames until the client disconnects or the session closes. Keeping it free of
// gin and the store is what makes the streaming contract directly testable.
func streamFrames(
	ctx context.Context,
	w io.Writer,
	flusher http.Flusher,
	frames <-chan live.Frame,
	keepalive <-chan time.Time,
) {
	for {
		select {
		case <-ctx.Done():
			return
		case frame, open := <-frames:
			if !open {
				// The session ended; tell the viewer so it stops rendering a
				// frozen frame rather than leaving the stream hanging.
				writeSSE(w, "end", []byte(`{"reason":"session_closed"}`))
				flusher.Flush()
				return
			}
			payload, err := json.Marshal(frameEvent{
				Image:      base64.StdEncoding.EncodeToString(frame.Bytes),
				Width:      frame.Width,
				Height:     frame.Height,
				ReceivedAt: frame.ReceivedAt.UTC().Format(time.RFC3339Nano),
			})
			if err != nil {
				obs.Error("remote assist frame encode failed", "err", err)
				return
			}
			if !writeSSE(w, "frame", payload) {
				return
			}
			flusher.Flush()
		case <-keepalive:
			if !writeSSE(w, "ping", []byte("{}")) {
				return
			}
			flusher.Flush()
		}
	}
}

// frameEvent is the payload of an SSE "frame" event. The image is base64 because
// SSE is a text protocol; the field set is deliberately the same shape the
// polling endpoint returns in headers, so the client renders both identically.
type frameEvent struct {
	Image      string `json:"image"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	ReceivedAt string `json:"received_at"`
}

// writeSSE emits one Server-Sent Event and reports whether the client is still
// connected. data must not contain newlines, which is guaranteed here because
// every payload is compact JSON.
func writeSSE(w io.Writer, event string, data []byte) bool {
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); err != nil {
		return false
	}
	return true
}
