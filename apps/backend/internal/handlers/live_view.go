package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
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

// LiveViewHandler serves the pushed live-screen path: a command stream the agent
// listens on, the agent's ephemeral frame upload, and the owner's frame stream.
//
// Live-view frames are deliberately NOT the same thing as scheduled screenshots.
// Screenshots are retained monitoring evidence written through filestore on the
// policy's own schedule. Live-view frames exist only while somebody is watching,
// are held in memory with a TTL, and are never persisted -- which is what makes
// a ~1 FPS rate affordable at all. Raising the screenshot rate to 1 FPS would
// mean 3600 retained images per hour of viewing.
type LiveViewHandler struct {
	store    *store.Store
	live     *live.Hub
	commands *live.CommandBus
}

func NewLiveViewHandler(s *store.Store, hub *live.Hub, bus *live.CommandBus) *LiveViewHandler {
	return &LiveViewHandler{store: s, live: hub, commands: bus}
}

func deviceIDParam(c *gin.Context) (string, bool) {
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return "", false
	}
	return deviceID, true
}

// AgentCommands is the agent's push channel. It replaces waiting up to a full
// heartbeat interval (15s) to learn that an owner asked for a frame, which was
// the dominant term in the measured 9s-average / 19s-worst start-up latency
// (docs/FULL_SYSTEM_AUDIT.md §3.4).
//
// Commands are hints only. Everything they trigger is still reachable through
// the agent's polling path, so an agent that cannot hold this stream open keeps
// working exactly as before -- just slower.
func (h *LiveViewHandler) AgentCommands(c *gin.Context) {
	userID, _ := auth.UserID(c)
	deviceID := c.Query("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	if err := h.store.AuthorizeDeviceAgent(c.Request.Context(), userID, deviceID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"error": "device is not registered to this account"})
			return
		}
		serverError(c, err)
		return
	}

	commands, cancel := h.commands.Subscribe(deviceID)
	defer cancel()

	flusher := c.Writer
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher.Flush()

	keepalive := time.NewTicker(streamKeepalive)
	defer keepalive.Stop()
	ctx := c.Request.Context()

	for {
		select {
		case <-ctx.Done():
			return
		case cmd, open := <-commands:
			if !open {
				return
			}
			payload, err := json.Marshal(cmd)
			if err != nil {
				obs.Error("agent command encode failed", "err", err, "device", deviceID)
				return
			}
			if !writeSSE(flusher, "command", payload) {
				return
			}
			flusher.Flush()
		case <-keepalive.C:
			if !writeSSE(flusher, "ping", []byte("{}")) {
				return
			}
			flusher.Flush()
		}
	}
}

// UploadFrame accepts one ephemeral live-view frame from the agent. The bytes go
// straight into the in-memory hub; nothing is written to Postgres or to disk.
func (h *LiveViewHandler) UploadFrame(c *gin.Context) {
	userID, _ := auth.UserID(c)
	deviceID := c.Query("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
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
	if err := h.store.AuthorizeDeviceAgent(c.Request.Context(), userID, deviceID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"error": "device is not registered to this account"})
			return
		}
		serverError(c, err)
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRemoteFrameBytes)
	data, err := io.ReadAll(c.Request.Body)
	if err != nil || len(data) == 0 || len(data) > maxRemoteFrameBytes {
		badRequest(c, "invalid or oversized frame")
		return
	}

	key := live.DeviceKey(deviceID)
	// Nobody is watching: tell the agent to stop rather than silently absorbing
	// frames. This is the backstop for a renewal the agent kept honouring after
	// the last viewer left.
	if h.live.Subscribers(key) == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "no viewer is attached"})
		return
	}
	if err := h.live.PutFrame(key, live.Frame{Bytes: data, Width: width, Height: height}); err != nil {
		serverError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// AgentStatus is the reliable fallback behind the best-effort command stream.
// Corporate proxies and laptop network changes can interrupt a long-lived SSE
// connection even while normal HTTPS requests keep working. The agent polls
// this cheap, authenticated endpoint at a low rate so an attached viewer still
// starts and renews capture instead of being left with an unexplained blank
// player. A viewer is the only thing that can make Active true.
func (h *LiveViewHandler) AgentStatus(c *gin.Context) {
	userID, _ := auth.UserID(c)
	deviceID := c.Query("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	if err := h.store.AuthorizeDeviceAgent(c.Request.Context(), userID, deviceID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"error": "device is not registered to this account"})
			return
		}
		serverError(c, err)
		return
	}

	active, expiresInMs := agentLiveViewStatus(h.live, deviceID)
	c.JSON(http.StatusOK, gin.H{
		"active":        active,
		"expires_in_ms": expiresInMs,
	})
}

func agentLiveViewStatus(hub *live.Hub, deviceID string) (bool, int64) {
	if hub.Subscribers(live.DeviceKey(deviceID)) == 0 {
		return false, 0
	}
	return true, live.LiveViewTTL.Milliseconds()
}

// Stream pushes a device's live frames to an authorized owner, and keeps the
// agent capturing for as long as it stays connected.
//
// The keep-capturing signal is renewed on a ticker rather than sent once as a
// start/stop pair. If this connection drops, the backend restarts, or a renewal
// is lost, the signal simply stops arriving and the agent stops capturing on its
// own TTL. Capture can only be extended by a fresh signal -- never left running
// by a lost one.
func (h *LiveViewHandler) Stream(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	deviceID, ok := deviceIDParam(c)
	if !ok {
		return
	}
	if err := h.store.AuthorizeLiveView(c.Request.Context(), ownerID, deviceID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusConflict, gin.H{"error": "device is offline or unavailable for live capture"})
			return
		}
		serverError(c, err)
		return
	}

	key := live.DeviceKey(deviceID)
	frames, cancel := h.live.Subscribe(key)
	defer cancel()
	defer h.live.DropSession(key)

	flusher := c.Writer
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher.Flush()

	// Ask the agent to start immediately, then keep renewing.
	renewal := live.Command{
		Type:        live.CommandLiveViewActive,
		ExpiresInMs: live.LiveViewTTL.Milliseconds(),
	}
	h.commands.Publish(deviceID, renewal)
	if h.commands.Connected(deviceID) == 0 {
		// The agent is not holding a command stream; it will still pick the
		// session up on its next heartbeat, just more slowly. Tell the viewer so
		// a blank player is explained rather than mysterious.
		writeSSE(flusher, "agent_unreachable", []byte(`{"reason":"no_command_stream"}`))
		flusher.Flush()
	}

	renew := time.NewTicker(live.LiveViewRenewInterval)
	defer renew.Stop()
	keepalive := time.NewTicker(streamKeepalive)
	defer keepalive.Stop()
	ctx := c.Request.Context()

	for {
		select {
		case <-ctx.Done():
			return
		case <-renew.C:
			h.commands.Publish(deviceID, renewal)
		case frame, open := <-frames:
			if !open {
				return
			}
			payload, err := json.Marshal(frameEvent{
				Image:      base64.StdEncoding.EncodeToString(frame.Bytes),
				Width:      frame.Width,
				Height:     frame.Height,
				ReceivedAt: frame.ReceivedAt.UTC().Format(time.RFC3339Nano),
			})
			if err != nil {
				obs.Error("live view frame encode failed", "err", err, "device", deviceID)
				return
			}
			if !writeSSE(flusher, "frame", payload) {
				return
			}
			flusher.Flush()
		case <-keepalive.C:
			if !writeSSE(flusher, "ping", []byte("{}")) {
				return
			}
			flusher.Flush()
		}
	}
}
