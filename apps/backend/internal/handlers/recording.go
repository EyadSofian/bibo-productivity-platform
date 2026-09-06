package handlers

import (
	"errors"
	"net/http"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/media"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func (h *MediaHandler) ListRecordings(c *gin.Context) {
	userID, _ := auth.UserID(c)
	employeeID := c.Param("employee_id")
	if _, err := uuid.Parse(employeeID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "employee_id must be a uuid", false)
		return
	}
	businessID, err := h.store.EmployeeBusinessForMember(c.Request.Context(), userID, employeeID)
	if errors.Is(err, store.ErrNotFound) {
		mediaError(c, http.StatusNotFound, CodeSessionNotFound, "Employee not found.", false)
		return
	}
	if err != nil {
		mediaInternal(c, err)
		return
	}
	if !h.require(c, userID, businessID, media.PermRecordingsView, store.AuditRecordingView) {
		return
	}
	from := time.Unix(parseInt64(c.Query("from"), 0), 0).UTC()
	to := time.Unix(parseInt64(c.Query("to"), time.Now().Unix()+1), 0).UTC()
	assets, err := h.store.RecordingsForEmployee(c.Request.Context(), userID, employeeID, from, to)
	if err != nil {
		mediaInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"recordings": assets})
}

func (h *MediaHandler) Recording(c *gin.Context) {
	userID, _ := auth.UserID(c)
	asset, ok := h.recordingForMember(c, userID)
	if !ok {
		return
	}
	if !h.require(c, userID, asset.BusinessID, media.PermRecordingsView, store.AuditRecordingView) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"recording": asset})
}

func (h *MediaHandler) PlaybackToken(c *gin.Context) {
	userID, _ := auth.UserID(c)
	asset, ok := h.recordingForMember(c, userID)
	if !ok {
		return
	}
	if !h.require(c, userID, asset.BusinessID, media.PermRecordingsView, store.AuditPlaybackTokenMint) {
		return
	}
	verification, err := h.recordings.VerifyAsset(c.Request.Context(), asset.ManifestKey)
	if errors.Is(err, media.ErrProviderUnconfigured) {
		h.providerError(c, err)
		return
	}
	if err != nil {
		mediaInternal(c, err)
		return
	}
	if !verification.Exists {
		mediaError(c, http.StatusConflict, CodeRecordingNotReady, "This recording is still being prepared.", true)
		return
	}
	if asset.Status != "ready" {
		if err := h.store.ReadyRecordingAsset(c.Request.Context(), asset.ID, verification.ByteSize); err != nil {
			mediaInternal(c, err)
			return
		}
	}
	signed, err := h.recordings.SignManifest(c.Request.Context(), asset.ManifestKey, 5*time.Minute)
	if err != nil {
		h.providerError(c, err)
		return
	}
	h.audit(c, asset.BusinessID, asset.MediaSessionID, store.AuditPlaybackTokenMint, store.OutcomeAllowed,
		map[string]any{"recording_id": asset.ID, "expires_in_s": 300})
	c.JSON(http.StatusOK, gin.H{
		"recording_id": asset.ID, "url": signed.ManifestURL, "expires_at": signed.ExpiresAt,
		"started_at": asset.StartedAt, "ended_at": asset.EndedAt, "duration_ms": asset.DurationMS,
	})
}

func (h *MediaHandler) recordingForMember(c *gin.Context, userID string) (store.RecordingAsset, bool) {
	recordingID := c.Param("recording_id")
	if _, err := uuid.Parse(recordingID); err != nil {
		mediaError(c, http.StatusBadRequest, CodeInvalidRequest, "recording_id must be a uuid", false)
		return store.RecordingAsset{}, false
	}
	asset, err := h.store.RecordingForMember(c.Request.Context(), userID, recordingID)
	if errors.Is(err, store.ErrNotFound) {
		mediaError(c, http.StatusNotFound, CodeSessionNotFound, "Recording not found.", false)
		return store.RecordingAsset{}, false
	}
	if err != nil {
		mediaInternal(c, err)
		return store.RecordingAsset{}, false
	}
	return asset, true
}
