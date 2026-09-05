package handlers

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/filestore"
	"ctracking/backend/internal/obs"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// maxScreenshotBytes guards the upload. The desktop compresses to <=50 KB; this is a
// generous ceiling that still rejects anything clearly wrong.
const maxScreenshotBytes = 200 * 1024

// ScreenshotHandler ingests multipart screenshot uploads.
//
// This is the retired still-image pipeline (docs/adr/0002-video-first-media-plane.md).
// With legacyEnabled false — the default, and the only production setting — nothing
// reaches disk or Postgres: the submission is counted, logged, and discarded.
type ScreenshotHandler struct {
	store *store.Store
	files *filestore.Store
	// legacyEnabled re-opens ingest for one migration deploy. See
	// config.LegacyStillCaptureEnabled; removed entirely in slice V12.
	legacyEnabled bool
}

// NewScreenshotHandler wires the screenshot handler. legacyEnabled must come from
// config, never from a per-request or per-business value: this is a platform
// migration switch, not a customer setting.
func NewScreenshotHandler(s *store.Store, files *filestore.Store, legacyEnabled bool) *ScreenshotHandler {
	return &ScreenshotHandler{store: s, files: files, legacyEnabled: legacyEnabled}
}

// Upload accepts a multipart screenshot (metadata fields + an "image" file part),
// stores the bytes on disk, and idempotently records metadata by client_uuid.
func (h *ScreenshotHandler) Upload(c *gin.Context) {
	userID, _ := auth.UserID(c)

	// Cap the whole request body so an oversized upload is refused early.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxScreenshotBytes+16*1024)

	clientUUID := c.PostForm("client_uuid")
	deviceID := c.PostForm("device_id")
	if _, err := uuid.Parse(clientUUID); err != nil {
		badRequest(c, "client_uuid must be a uuid")
		return
	}
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	ts, err := strconv.ParseInt(c.PostForm("ts"), 10, 64)
	if err != nil {
		badRequest(c, "ts must be an integer")
		return
	}
	updatedAt, err := strconv.ParseInt(c.PostForm("updated_at"), 10, 64)
	if err != nil {
		badRequest(c, "updated_at must be an integer")
		return
	}
	// The still pipeline is retired. Acknowledge and discard BEFORE touching the
	// image part, the business lookup, filestore or Postgres, so a submission from
	// an agent that has not rolled forward yet cannot create a stored screenshot.
	//
	// Acknowledging rather than refusing is deliberate, and matches the remote-pause
	// path below. The agent's sync worker does not mark a rejected shot as synced
	// and does not stop retrying it (sync/worker.rs), so a 4xx would make every old
	// agent re-upload the same image on every sync pass, forever. A discarded
	// acknowledgement stops the retry loop and drains the outbox; the bytes are
	// dropped either way.
	if !h.legacyEnabled {
		obs.RecordLegacyStillCaptureRejected()
		legacyUploadLog.warn("still screenshot upload discarded: pipeline retired (adr/0002)",
			"device", deviceID, "user", userID)
		c.JSON(http.StatusOK, gin.H{
			"accepted":              []string{clientUUID},
			"monitoring_enabled":    true,
			"still_capture_enabled": false,
			"code":                  CodeLegacyCaptureDisabled,
		})
		return
	}

	var businessID *string
	if v := c.PostForm("business_id"); v != "" {
		businessID = &v
	}

	fileHeader, err := c.FormFile("image")
	if err != nil {
		badRequest(c, "image file part is required")
		return
	}
	if fileHeader.Size > maxScreenshotBytes {
		badRequest(c, "image exceeds size limit")
		return
	}
	f, err := fileHeader.Open()
	if err != nil {
		serverError(c, err)
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxScreenshotBytes+1))
	if err != nil {
		serverError(c, err)
		return
	}
	if len(data) > maxScreenshotBytes {
		badRequest(c, "image exceeds size limit")
		return
	}
	if !strings.HasPrefix(http.DetectContentType(data), "image/") {
		badRequest(c, "uploaded file is not an image")
		return
	}

	bizID, err := h.resolveBusiness(c, userID, businessID)
	if err != nil {
		return // resolveBusiness already wrote the response
	}
	allowed, err := h.store.DeviceMonitoringAllowed(c.Request.Context(), userID, bizID, deviceID)
	if err != nil {
		serverError(c, err)
		return
	}
	if !allowed {
		// Acknowledge and discard, matching SyncBatch. Older agents that have not
		// learned the remote pause must not retry the same private image forever.
		c.JSON(http.StatusOK, gin.H{"accepted": []string{clientUUID}, "monitoring_enabled": false})
		return
	}

	// Write the file first, then record metadata (so a row never points at a
	// missing file). A failed metadata write leaves a blob that a retry overwrites.
	relPath, err := h.files.Write(bizID, userID, ts, clientUUID, data)
	if err != nil {
		serverError(c, err)
		return
	}

	row := store.ScreenshotRow{
		ClientUUID:      clientUUID,
		DeviceID:        deviceID,
		Ts:              ts,
		FilePath:        relPath,
		ByteSize:        len(data),
		Width:           optInt(c.PostForm("width")),
		Height:          optInt(c.PostForm("height")),
		DisplayID:       optInt(c.PostForm("display_id")),
		ClientUpdatedAt: updatedAt,
	}
	if err := h.store.UpsertScreenshot(c.Request.Context(), userID, bizID, row); err != nil {
		serverError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"accepted": []string{clientUUID}, "monitoring_enabled": true})
}

// resolveBusiness mirrors the sync handler's resolution, writing the error response
// itself and returning an error to signal the caller to stop.
func (h *ScreenshotHandler) resolveBusiness(c *gin.Context, userID string, explicit *string) (string, error) {
	bizID, err := h.store.ResolveBusinessForUser(c.Request.Context(), userID, explicit)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusForbidden, gin.H{"error": "user belongs to no business"})
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": "not a member of that business"})
	case errors.Is(err, store.ErrAmbiguousBusiness):
		badRequest(c, "multiple businesses: specify business_id")
	case err != nil:
		serverError(c, err)
	}
	return bizID, err
}

// optInt parses an optional integer form field; empty/invalid → nil.
func optInt(s string) *int {
	if s == "" {
		return nil
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return &v
}
