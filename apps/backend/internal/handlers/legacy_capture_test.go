package handlers

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"ctracking/backend/internal/filestore"
	"ctracking/backend/internal/obs"

	"github.com/gin-gonic/gin"
)

const (
	testClientUUID = "6f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
	testDeviceUUID = "b26c3607-e66a-4e20-b488-89b21174be13"
)

func init() { gin.SetMode(gin.TestMode) }

// screenshotForm builds a well-formed upload: if the retired pipeline still ran,
// this request would be stored.
func screenshotForm(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range map[string]string{
		"client_uuid": testClientUUID,
		"device_id":   testDeviceUUID,
		"ts":          "1756700000",
		"updated_at":  "1756700000",
		"width":       "1366",
		"height":      "768",
	} {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	part, err := w.CreateFormFile("image", "shot.webp")
	if err != nil {
		t.Fatalf("create file part: %v", err)
	}
	// A real WebP header, so nothing rejects this as "not an image".
	if _, err := part.Write([]byte("RIFF\x00\x00\x00\x00WEBPVP8 ")); err != nil {
		t.Fatalf("write image bytes: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	return &body, w.FormDataContentType()
}

// A disabled still pipeline must not reach Postgres or the disk. The store is nil
// on purpose: any database access panics the test rather than quietly succeeding.
func TestScreenshotUploadDiscardedWhenStillCaptureRetired(t *testing.T) {
	obs.ResetCounters()
	dir := t.TempDir()
	h := NewScreenshotHandler(nil, filestore.New(dir), false)

	body, contentType := screenshotForm(t)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/sync/screenshots", body)
	c.Request.Header.Set("Content-Type", contentType)

	h.Upload(c)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (an agent that keeps retrying never drains its outbox)", rec.Code, http.StatusOK)
	}

	var resp struct {
		Accepted            []string `json:"accepted"`
		StillCaptureEnabled bool     `json:"still_capture_enabled"`
		Code                string   `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Accepted) != 1 || resp.Accepted[0] != testClientUUID {
		t.Errorf("accepted = %v, want [%s] so the agent marks it synced and stops retrying", resp.Accepted, testClientUUID)
	}
	if resp.StillCaptureEnabled {
		t.Error("still_capture_enabled = true, want false")
	}
	if resp.Code != CodeLegacyCaptureDisabled {
		t.Errorf("code = %q, want %q", resp.Code, CodeLegacyCaptureDisabled)
	}

	// The decisive assertion: no bytes were written anywhere under the store root.
	var written []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			written = append(written, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk storage dir: %v", err)
	}
	if len(written) != 0 {
		t.Errorf("storage dir has %d file(s) %v, want none", len(written), written)
	}

	if got := obs.LegacyStillCaptureRejected(); got != 1 {
		t.Errorf("rejected counter = %d, want 1", got)
	}
}

// A malformed request is still rejected on its own terms. The kill switch must not
// turn the endpoint into an unconditional 200.
func TestScreenshotUploadStillValidatesWhenRetired(t *testing.T) {
	obs.ResetCounters()
	h := NewScreenshotHandler(nil, filestore.New(t.TempDir()), false)

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if err := w.WriteField("client_uuid", "not-a-uuid"); err != nil {
		t.Fatalf("write field: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/sync/screenshots", &body)
	c.Request.Header.Set("Content-Type", w.FormDataContentType())

	h.Upload(c)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if got := obs.LegacyStillCaptureRejected(); got != 0 {
		t.Errorf("rejected counter = %d, want 0: a malformed request is not a legacy capture", got)
	}
}

// The one-shot capture endpoint drives the retained pipeline, so it is refused
// outright. Its caller is an owner, not a retry loop.
func TestRequestLiveCaptureGoneWhenStillCaptureRetired(t *testing.T) {
	obs.ResetCounters()
	h := NewDeviceHandler(nil, nil, false)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/devices/"+testDeviceUUID+"/live-capture", nil)
	c.Params = gin.Params{{Key: "device_id", Value: testDeviceUUID}}

	h.RequestLiveCapture(c)

	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusGone)
	}
	var resp struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Code != CodeLegacyCaptureDisabled {
		t.Errorf("code = %q, want %q", resp.Code, CodeLegacyCaptureDisabled)
	}
	if got := obs.LegacyStillCaptureRejected(); got != 1 {
		t.Errorf("rejected counter = %d, want 1", got)
	}
}

// A bad device id is still a 400, and is not counted as a legacy capture.
func TestRequestLiveCaptureValidatesDeviceIDBeforeKillSwitch(t *testing.T) {
	obs.ResetCounters()
	h := NewDeviceHandler(nil, nil, false)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/devices/nope/live-capture", nil)
	c.Params = gin.Params{{Key: "device_id", Value: "nope"}}

	h.RequestLiveCapture(c)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if got := obs.LegacyStillCaptureRejected(); got != 0 {
		t.Errorf("rejected counter = %d, want 0", got)
	}
}

// The policy payload is how a managed agent learns the platform decision, so the
// field must be present on every branch -- including the unmanaged ones, which is
// exactly where a standalone device reads it.
func TestPolicyPublishesStillCaptureFlag(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		h := NewOwnerHandler(nil, enabled)
		if got := h.stillCaptureEnabled(); got != enabled {
			t.Errorf("stillCaptureEnabled() = %v, want %v", got, enabled)
		}
	}
}

func TestThrottledLoggerEmitsOncePerIntervalAndCountsSuppressed(t *testing.T) {
	base := time.Unix(1756700000, 0)
	now := base
	logger := &throttledLogger{interval: time.Minute, now: func() time.Time { return now }}

	// First call always writes and reports nothing suppressed.
	logger.warn("first")
	if logger.suppressed != 0 || logger.last != base {
		t.Fatalf("after first call suppressed=%d last=%v, want 0 and %v", logger.suppressed, logger.last, base)
	}

	// Everything inside the window is counted, not written.
	for i := 0; i < 5; i++ {
		now = base.Add(time.Duration(i+1) * time.Second)
		logger.warn("inside window")
	}
	if logger.suppressed != 5 {
		t.Fatalf("suppressed = %d, want 5", logger.suppressed)
	}
	if logger.last != base {
		t.Errorf("last = %v, want it unchanged at %v while suppressing", logger.last, base)
	}

	// The first call past the interval writes again and clears the tally.
	now = base.Add(time.Minute + time.Second)
	logger.warn("after window")
	if logger.suppressed != 0 {
		t.Errorf("suppressed = %d after emitting, want 0", logger.suppressed)
	}
	if logger.last != now {
		t.Errorf("last = %v, want %v", logger.last, now)
	}
}
