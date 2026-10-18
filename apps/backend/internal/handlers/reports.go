package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/filestore"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
)

// ReportsHandler serves the owner read path (roster, per-employee data, images).
type ReportsHandler struct {
	store *store.Store
	files *filestore.Store
}

// NewReportsHandler wires the reports handler.
func NewReportsHandler(s *store.Store, files *filestore.Store) *ReportsHandler {
	return &ReportsHandler{store: s, files: files}
}

// Roster returns the employee roster for a business the caller owns.
// Query: business_id (required).
func (h *ReportsHandler) Roster(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	businessID := c.Query("business_id")
	if businessID == "" {
		badRequest(c, "business_id is required")
		return
	}
	owns, err := h.store.IsBusinessOwner(c.Request.Context(), ownerID, businessID)
	if err != nil {
		serverError(c, err)
		return
	}
	if !owns {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your business"})
		return
	}

	dayStart, dayEnd, ok := dayWindow(c)
	if !ok {
		return
	}
	roster, err := h.store.Roster(c.Request.Context(), businessID, dayStart, dayEnd)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"employees": roster})
}

// maxRosterWindow bounds a caller-supplied roster day. A local calendar day is
// 23–25 hours across a DST change; anything longer is not a "day".
const maxRosterWindow = 25 * 3600

// maxTeamWindow bounds the team report so one request cannot scan years of rows.
const maxTeamWindow = 31 * 86400

// dayWindow reads the optional ?from&to day for the roster. The viewer's own
// midnight is the meaningful "today" for a manager in Cairo or Riyadh, so the
// browser sends it; without one the window falls back to the current UTC day,
// which is what older admin builds expect.
func dayWindow(c *gin.Context) (from, to int64, ok bool) {
	if c.Query("from") == "" && c.Query("to") == "" {
		now := time.Now().UTC()
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Unix()
		return start, start + 86400, true
	}
	return boundedWindow(c, maxRosterWindow)
}

// boundedWindow parses a required ?from&to pair and rejects an empty, inverted
// or oversized window with a 400 that names the problem.
func boundedWindow(c *gin.Context, max int64) (from, to int64, ok bool) {
	from = parseInt64(c.Query("from"), -1)
	to = parseInt64(c.Query("to"), -1)
	if from < 0 || to <= from {
		badRequest(c, "from and to must be unix seconds with from < to")
		return 0, 0, false
	}
	if to-from > max {
		badRequest(c, "window too large")
		return 0, 0, false
	}
	return from, to, true
}

// Team returns the business-wide report for the overview: top apps and sites,
// input totals and active time per hour.
// Query: business_id, from, to (required).
func (h *ReportsHandler) Team(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	businessID := c.Query("business_id")
	if businessID == "" {
		badRequest(c, "business_id is required")
		return
	}
	owns, err := h.store.IsBusinessOwner(c.Request.Context(), ownerID, businessID)
	if err != nil {
		serverError(c, err)
		return
	}
	if !owns {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your business"})
		return
	}
	from, to, ok := boundedWindow(c, maxTeamWindow)
	if !ok {
		return
	}
	report, err := h.store.TeamReportFor(c.Request.Context(), businessID, from, to)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, report)
}

// Activity returns the timeline + app breakdown for an employee.
func (h *ReportsHandler) Activity(c *gin.Context) {
	ownerID, empID, from, to, ok := h.scope(c)
	if !ok {
		return
	}
	samples, breakdown, err := h.store.ActivityReport(c.Request.Context(), empID, ownerID, from, to)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"samples": samples, "breakdown": breakdown})
}

// Keystrokes returns count buckets for an employee.
func (h *ReportsHandler) Keystrokes(c *gin.Context) {
	ownerID, empID, from, to, ok := h.scope(c)
	if !ok {
		return
	}
	buckets, err := h.store.KeystrokesReport(c.Request.Context(), empID, ownerID, from, to)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"buckets": buckets})
}

// Browser returns page visits for an employee.
func (h *ReportsHandler) Browser(c *gin.Context) {
	ownerID, empID, from, to, ok := h.scope(c)
	if !ok {
		return
	}
	visits, err := h.store.BrowserReport(c.Request.Context(), empID, ownerID, from, to)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"visits": visits})
}

// Screenshots returns paginated screenshot metadata for an employee.
func (h *ReportsHandler) Screenshots(c *gin.Context) {
	ownerID, empID, from, to, ok := h.scope(c)
	if !ok {
		return
	}
	limit := clampInt(c.Query("limit"), 50, 1, 200)
	offset := clampInt(c.Query("offset"), 0, 0, 1<<31)
	shots, err := h.store.ScreenshotsReport(c.Request.Context(), empID, ownerID, from, to, limit, offset)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"screenshots": shots, "limit": limit, "offset": offset})
}

// ScreenshotImage streams a stored screenshot if the caller owns the business it
// belongs to.
func (h *ReportsHandler) ScreenshotImage(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	clientUUID := c.Param("client_uuid")

	relPath, err := h.store.ScreenshotPathForOwner(c.Request.Context(), ownerID, clientUUID)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	f, err := h.files.Open(relPath)
	if err != nil {
		// Metadata exists but the file is gone (e.g. cleaned up) — treat as missing.
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		serverError(c, err)
		return
	}
	c.DataFromReader(http.StatusOK, fi.Size(), "image/webp", f, nil)
}

// scope authenticates, validates the :id employee is one the caller owns, and parses
// the from/to window. It writes the error response and returns ok=false on failure.
// States returns the device-state timeline: how the window splits into active,
// idle, suspended and offline time. This is the source for the profile's idle
// and total-device-time figures, which activity_samples alone cannot answer.
func (h *ReportsHandler) States(c *gin.Context) {
	ownerID, empID, from, to, ok := h.scope(c)
	if !ok {
		return
	}
	report, err := h.store.OsStateReportFor(c.Request.Context(), empID, ownerID, from, to)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, report)
}

func (h *ReportsHandler) scope(c *gin.Context) (ownerID, empID string, from, to int64, ok bool) {
	ownerID, _ = auth.UserID(c)
	empID = c.Param("id")

	owns, err := h.store.OwnsEmployee(c.Request.Context(), ownerID, empID)
	if err != nil {
		serverError(c, err)
		return
	}
	if !owns {
		c.JSON(http.StatusForbidden, gin.H{"error": "not your employee"})
		return
	}

	from = parseInt64(c.Query("from"), 0)
	to = parseInt64(c.Query("to"), time.Now().Unix()+1)
	return ownerID, empID, from, to, true
}

func parseInt64(s string, def int64) int64 {
	if s == "" {
		return def
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return def
	}
	return v
}

func clampInt(s string, def, lo, hi int) int {
	v := def
	if s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			v = n
		}
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
