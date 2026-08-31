package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type MonitoringProfileHandler struct{ store *store.Store }

func NewMonitoringProfileHandler(s *store.Store) *MonitoringProfileHandler {
	return &MonitoringProfileHandler{store: s}
}

type monitoringDetailReq struct {
	TrackingKey string          `json:"tracking_key"`
	TrackingVal json.RawMessage `json:"tracking_val"`
	DaysOfWeek  []int16         `json:"days_of_week"`
	StartMinute int             `json:"start_minute"`
	EndMinute   int             `json:"end_minute"`
	Timezone    string          `json:"timezone"`
}

type monitoringAssignmentReq struct {
	ScopeType string `json:"scope_type"`
	ScopeID   string `json:"scope_id"`
}

type monitoringProfileReq struct {
	BusinessID  string                    `json:"business_id"`
	Name        string                    `json:"name"`
	Description string                    `json:"description"`
	ParentID    *string                   `json:"parent_id"`
	Private     bool                      `json:"private"`
	Details     []monitoringDetailReq     `json:"details"`
	Assignments []monitoringAssignmentReq `json:"assignments"`
}

var trackingKeyRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,79}$`)

func (r *monitoringProfileReq) input() (store.MonitoringProfileInput, string) {
	r.BusinessID = strings.TrimSpace(r.BusinessID)
	r.Name = strings.TrimSpace(r.Name)
	r.Description = strings.TrimSpace(r.Description)
	if _, err := uuid.Parse(r.BusinessID); err != nil {
		return store.MonitoringProfileInput{}, "business_id must be a uuid"
	}
	if r.Name == "" || len(r.Name) > 120 {
		return store.MonitoringProfileInput{}, "name must be 1-120 characters"
	}
	if len(r.Description) > 1000 {
		return store.MonitoringProfileInput{}, "description is too long"
	}
	if r.ParentID != nil {
		if _, err := uuid.Parse(*r.ParentID); err != nil {
			return store.MonitoringProfileInput{}, "parent_id must be a uuid"
		}
	}
	if len(r.Details) > 200 || len(r.Assignments) > 1000 {
		return store.MonitoringProfileInput{}, "profile is too large"
	}

	in := store.MonitoringProfileInput{
		BusinessID: r.BusinessID, Name: r.Name, Description: r.Description,
		ParentID: r.ParentID, Private: r.Private,
	}
	seenKeys := map[string]bool{}
	for _, d := range r.Details {
		d.TrackingKey = strings.TrimSpace(d.TrackingKey)
		d.Timezone = strings.TrimSpace(d.Timezone)
		if !trackingKeyRe.MatchString(d.TrackingKey) || seenKeys[d.TrackingKey] {
			return store.MonitoringProfileInput{}, "details contain an invalid or duplicate tracking_key"
		}
		seenKeys[d.TrackingKey] = true
		if len(d.TrackingVal) == 0 || !json.Valid(d.TrackingVal) {
			return store.MonitoringProfileInput{}, "tracking_val must be valid JSON"
		}
		if len(d.DaysOfWeek) == 0 || len(d.DaysOfWeek) > 7 || d.StartMinute < 0 ||
			d.StartMinute > 1439 || d.EndMinute < 1 || d.EndMinute > 1440 {
			return store.MonitoringProfileInput{}, "details contain an invalid schedule"
		}
		seenDays := map[int16]bool{}
		for _, day := range d.DaysOfWeek {
			if day < 1 || day > 7 || seenDays[day] {
				return store.MonitoringProfileInput{}, "days_of_week must contain unique ISO days 1-7"
			}
			seenDays[day] = true
		}
		if _, err := time.LoadLocation(d.Timezone); err != nil {
			return store.MonitoringProfileInput{}, "timezone must be a valid IANA timezone"
		}
		in.Details = append(in.Details, store.MonitoringDetail{
			TrackingKey: d.TrackingKey, TrackingVal: d.TrackingVal, DaysOfWeek: d.DaysOfWeek,
			StartMinute: d.StartMinute, EndMinute: d.EndMinute, Timezone: d.Timezone,
		})
	}
	seenAssignments := map[string]bool{}
	for _, a := range r.Assignments {
		if a.ScopeType != "business" && a.ScopeType != "department" && a.ScopeType != "employee" && a.ScopeType != "device" {
			return store.MonitoringProfileInput{}, "scope_type is not available yet"
		}
		if _, err := uuid.Parse(a.ScopeID); err != nil {
			return store.MonitoringProfileInput{}, "scope_id must be a uuid"
		}
		key := a.ScopeType + ":" + a.ScopeID
		if seenAssignments[key] {
			return store.MonitoringProfileInput{}, "assignments contain a duplicate scope"
		}
		seenAssignments[key] = true
		in.Assignments = append(in.Assignments, store.MonitoringAssignment(a))
	}
	return in, ""
}

func (h *MonitoringProfileHandler) List(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	businessID := c.Param("id")
	if _, err := uuid.Parse(businessID); err != nil {
		badRequest(c, "business id must be a uuid")
		return
	}
	profiles, err := h.store.ListMonitoringProfiles(c.Request.Context(), ownerID, businessID)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"profiles": profiles})
}

func (h *MonitoringProfileHandler) Create(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	var req monitoringProfileReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, "invalid body")
		return
	}
	in, message := req.input()
	if message != "" {
		badRequest(c, message)
		return
	}
	profile, err := h.store.CreateMonitoringProfile(c.Request.Context(), ownerID, in)
	h.writeMutation(c, profile, err, http.StatusCreated)
}

func (h *MonitoringProfileHandler) Update(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	profileID := c.Param("profile_id")
	if _, err := uuid.Parse(profileID); err != nil {
		badRequest(c, "profile_id must be a uuid")
		return
	}
	var req monitoringProfileReq
	if err := c.ShouldBindJSON(&req); err != nil {
		badRequest(c, "invalid body")
		return
	}
	in, message := req.input()
	if message != "" {
		badRequest(c, message)
		return
	}
	profile, err := h.store.UpdateMonitoringProfile(c.Request.Context(), ownerID, profileID, in)
	h.writeMutation(c, profile, err, http.StatusOK)
}

func (h *MonitoringProfileHandler) writeMutation(c *gin.Context, profile store.MonitoringProfile, err error, status int) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "profile or target not found"})
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusBadRequest, gin.H{"error": "assignment target is outside this business"})
	case errors.Is(err, store.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "profile name, parent, or assignment conflicts"})
	case err != nil:
		serverError(c, err)
	default:
		c.JSON(status, gin.H{"profile": profile})
	}
}

func (h *MonitoringProfileHandler) Delete(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	profileID := c.Param("profile_id")
	if _, err := uuid.Parse(profileID); err != nil {
		badRequest(c, "profile_id must be a uuid")
		return
	}
	err := h.store.DeleteMonitoringProfile(c.Request.Context(), ownerID, profileID)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "profile not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *MonitoringProfileHandler) Resolved(c *gin.Context) {
	requesterID, _ := auth.UserID(c)
	deviceID := c.Query("device_id")
	if _, err := uuid.Parse(deviceID); err != nil {
		badRequest(c, "device_id must be a uuid")
		return
	}
	profile, err := h.store.ResolveMonitoringProfile(c.Request.Context(), requesterID, deviceID)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "device not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, profile)
}
