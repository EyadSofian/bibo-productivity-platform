package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const maxRemoteFrameBytes = 256 * 1024

type RemoteAssistHandler struct {
	store *store.Store
}

func NewRemoteAssistHandler(s *store.Store) *RemoteAssistHandler {
	return &RemoteAssistHandler{store: s}
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
	err = h.store.SaveRemoteAssistFrame(c.Request.Context(), employeeID, sessionID, store.RemoteAssistFrame{
		Bytes: data, Width: width, Height: height,
	})
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusConflict, gin.H{"error": "session is not active"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *RemoteAssistHandler) Frame(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	sessionID, ok := remoteSessionID(c)
	if !ok {
		return
	}
	frame, err := h.store.RemoteAssistFrameForOwner(c.Request.Context(), ownerID, sessionID)
	if errors.Is(err, store.ErrNotFound) {
		c.Status(http.StatusNoContent)
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Frame-Width", strconv.Itoa(frame.Width))
	c.Header("X-Frame-Height", strconv.Itoa(frame.Height))
	c.Header("X-Frame-At", frame.ReceivedAt.UTC().Format(http.TimeFormat))
	c.Data(http.StatusOK, "image/webp", frame.Bytes)
}
