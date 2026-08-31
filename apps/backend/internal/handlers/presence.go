package handlers

import (
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type PresenceHandler struct {
	store *store.Store
}

func NewPresenceHandler(s *store.Store) *PresenceHandler {
	return &PresenceHandler{store: s}
}

type presenceHeartbeatReq struct {
	DeviceID    string                  `json:"device_id"`
	BusinessID  *string                 `json:"business_id"`
	State       string                  `json:"state"`
	App         *string                 `json:"app"`
	WindowTitle *string                 `json:"window_title"`
	Since       int64                   `json:"since"`
	Resources   *store.ResourceSnapshot `json:"resources"`
}

// Heartbeat accepts a cheap 30-second presence signal from the signed-in
// employee's desktop app. It is intentionally separate from telemetry sync.
func (h *PresenceHandler) Heartbeat(c *gin.Context) {
	userID, _ := auth.UserID(c)
	var req presenceHeartbeatReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, "invalid body")
		return
	}
	if _, err := uuid.Parse(req.DeviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	if req.State != "online" && req.State != "active" && req.State != "idle" {
		badRequest(c, "state must be online, active or idle")
		return
	}
	req.App = cleanPresenceText(req.App, 255)
	req.WindowTitle = cleanPresenceText(req.WindowTitle, 1000)
	if req.State == "online" {
		req.App = nil
		req.WindowTitle = nil
	}
	if !validResourceSnapshot(req.Resources) {
		badRequest(c, "invalid resource snapshot")
		return
	}
	if req.Since <= 0 || req.Since > time.Now().Unix()+60 {
		req.Since = time.Now().Unix()
	}

	businessID, err := h.store.ResolveBusinessForUser(c.Request.Context(), userID, req.BusinessID)
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of that business"})
		return
	case errors.Is(err, store.ErrAmbiguousBusiness):
		badRequest(c, "multiple businesses: specify business_id")
		return
	case err != nil:
		serverError(c, err)
		return
	}

	enabled, err := h.store.UpdatePresence(
		c.Request.Context(), userID, businessID, req.DeviceID,
		req.State, req.App, req.WindowTitle, req.Since, req.Resources,
	)
	if errors.Is(err, store.ErrForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"error": "device belongs to another account"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	captureRequested, err := h.store.ConsumeLiveCaptureRequest(
		c.Request.Context(), userID, businessID, req.DeviceID,
	)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"status": "ok", "monitoring_enabled": enabled,
		"capture_requested": captureRequested,
	})
}

func validResourceSnapshot(value *store.ResourceSnapshot) bool {
	if value == nil {
		return true
	}
	cpu := float64(value.CPUPct)
	return !math.IsNaN(cpu) && !math.IsInf(cpu, 0) && cpu >= 0 && cpu <= 100 &&
		value.MemoryUsedBytes >= 0 && value.MemoryTotalBytes >= value.MemoryUsedBytes &&
		value.DiskUsedBytes >= 0 && value.DiskTotalBytes >= value.DiskUsedBytes &&
		value.NetworkRxBPS >= 0 && value.NetworkTxBPS >= 0
}

// Employee returns the freshest presence for an employee owned by the caller.
func (h *PresenceHandler) Employee(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	presence, err := h.store.PresenceForOwner(c.Request.Context(), ownerID, c.Param("id"))
	if errors.Is(err, store.ErrForbidden) {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your employee"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"presence": presence})
}

func cleanPresenceText(value *string, max int) *string {
	if value == nil {
		return nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil
	}
	runes := []rune(clean)
	if len(runes) > max {
		clean = string(runes[:max])
	}
	return &clean
}
