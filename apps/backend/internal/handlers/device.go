package handlers

import (
	"errors"
	"net/http"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/live"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// DeviceHandler serves the fleet inventory and per-machine monitoring control
// (F40). Every operation is scoped to businesses the caller owns; the store
// enforces that in SQL, so these handlers do not re-check ownership beyond
// resolving which business to list.
type DeviceHandler struct {
	store    *store.Store
	commands *live.CommandBus
	// legacyStillCapture gates RequestLiveCapture, which despite its name drives
	// the RETAINED screenshot pipeline: the agent answers it by writing a stored
	// screenshot, not by streaming. See config.LegacyStillCaptureEnabled.
	legacyStillCapture bool
}

// NewDeviceHandler wires the device handler.
func NewDeviceHandler(s *store.Store, bus *live.CommandBus, legacyStillCapture bool) *DeviceHandler {
	return &DeviceHandler{store: s, commands: bus, legacyStillCapture: legacyStillCapture}
}

// List returns the devices in one business the caller owns.
// GET /v1/businesses/:id/devices
func (h *DeviceHandler) List(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	businessID := c.Param("id")

	includeDeleted := c.Query("include_deleted") == "true"
	devices, err := h.store.ListDevices(c.Request.Context(), ownerID, businessID, includeDeleted)
	if err != nil {
		serverError(c, err)
		return
	}
	// A caller who owns no such business gets an empty list, not a 403: the store
	// query simply matches no rows. That is deliberate — it does not confirm or
	// deny the existence of a business they cannot see.
	c.JSON(http.StatusOK, gin.H{"devices": devices})
}

// Archive removes a retired device from the active inventory without erasing
// historical activity. POST /v1/devices/:device_id/archive
func (h *DeviceHandler) Archive(c *gin.Context) {
	h.setArchived(c, true)
}

// Restore returns an archived device to the inventory. Monitoring remains
// paused until the owner explicitly enables it.
// POST /v1/devices/:device_id/restore
func (h *DeviceHandler) Restore(c *gin.Context) {
	h.setArchived(c, false)
}

func (h *DeviceHandler) setArchived(c *gin.Context, archived bool) {
	ownerID, _ := auth.UserID(c)
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}

	device, err := h.store.SetDeviceArchived(c.Request.Context(), ownerID, deviceID, archived)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "device not found"})
		return
	case err != nil:
		serverError(c, err)
		return
	}

	obs.Info("device archive changed", "owner", ownerID, "device", deviceID, "archived", archived)
	c.JSON(http.StatusOK, gin.H{"device": device})
}

type setMonitoringReq struct {
	Enabled *bool `json:"enabled"`
}

// SetMonitoring turns a device's monitoring on or off.
// POST /v1/devices/:device_id/monitoring   { "enabled": false }
func (h *DeviceHandler) SetMonitoring(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}

	var req setMonitoringReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, "invalid body")
		return
	}
	if req.Enabled == nil {
		badRequest(c, "enabled is required")
		return
	}

	device, err := h.store.SetDeviceMonitoring(c.Request.Context(), ownerID, deviceID, *req.Enabled)
	switch {
	case errors.Is(err, store.ErrNotFound):
		// The device does not exist, or is not in a business the caller owns —
		// the same answer either way, so an owner cannot probe for devices in
		// businesses they do not own.
		c.JSON(http.StatusNotFound, gin.H{"error": "device not found"})
		return
	case err != nil:
		serverError(c, err)
		return
	}

	obs.Info("device monitoring changed",
		"owner", ownerID, "device", deviceID, "enabled", *req.Enabled)

	c.JSON(http.StatusOK, gin.H{"device": device})
}

// RequestLiveCapture asks an online managed device for one policy-compliant
// frame. The next authenticated heartbeat consumes the request.
//
// The name is misleading and the behaviour is the reason this endpoint is retired:
// the agent services it through capture_once(), which writes a PERMANENT
// screenshot to local disk, the local database and then the server -- a button
// labelled "live" that produced stored evidence. Video-first screen viewing is
// GET /v1/devices/:device_id/live/stream, which stores nothing.
func (h *DeviceHandler) RequestLiveCapture(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	deviceID := c.Param("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}

	// Refused outright rather than acknowledged-and-discarded: this caller is an
	// owner or an API client, not an agent retry loop, so a plain permanent error
	// is the honest answer. 410 says the endpoint is gone, not that this request
	// was malformed or that retrying later might work.
	if !h.legacyStillCapture {
		obs.RecordLegacyStillCaptureRejected()
		legacyLiveCaptureLog.warn("live-capture request refused: still capture retired (adr/0002)",
			"owner", ownerID, "device", deviceID)
		c.JSON(http.StatusGone, gin.H{
			"error": "still-image capture is retired; use live video",
			"code":  CodeLegacyCaptureDisabled,
		})
		return
	}

	request, err := h.store.RequestLiveCapture(c.Request.Context(), ownerID, deviceID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusConflict, gin.H{"error": "device is offline or unavailable for live capture"})
		return
	case err != nil:
		serverError(c, err)
		return
	}

	// Wake the agent now instead of letting it discover the request on its next
	// heartbeat (0-15s). The heartbeat still carries the request, so this is
	// purely an accelerator: an agent with no command stream behaves as before.
	h.commands.Publish(deviceID, live.Command{Type: live.CommandCaptureNow})

	obs.Info("live capture requested", "owner", ownerID, "device", deviceID)
	c.JSON(http.StatusAccepted, gin.H{
		"device_id": request.DeviceID, "requested_at": request.RequestedAt.Unix(),
		"agent_connected": h.commands.Connected(deviceID) > 0,
	})
}
