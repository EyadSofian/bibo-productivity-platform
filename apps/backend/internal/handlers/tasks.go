package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type TaskHandler struct{ store *store.Store }

func NewTaskHandler(s *store.Store) *TaskHandler { return &TaskHandler{store: s} }

type createTaskReq struct {
	BusinessID       string     `json:"business_id"`
	AssigneeUserID   string     `json:"assignee_user_id"`
	Title            string     `json:"title"`
	Description      string     `json:"description"`
	WorkType         string     `json:"work_type"`
	Priority         string     `json:"priority"`
	EstimatedMinutes *int       `json:"estimated_minutes"`
	DueAt            *time.Time `json:"due_at"`
}

func (h *TaskHandler) Create(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	var req createTaskReq
	if c.ShouldBindJSON(&req) != nil {
		badRequest(c, "invalid body")
		return
	}
	req.BusinessID, req.AssigneeUserID = strings.TrimSpace(req.BusinessID), strings.TrimSpace(req.AssigneeUserID)
	req.Title, req.Description, req.Priority = strings.TrimSpace(req.Title), strings.TrimSpace(req.Description), strings.TrimSpace(req.Priority)
	req.WorkType = strings.ToLower(strings.TrimSpace(req.WorkType))
	if _, err := uuid.Parse(req.BusinessID); err != nil {
		badRequest(c, "business_id must be a uuid")
		return
	}
	if _, err := uuid.Parse(req.AssigneeUserID); err != nil {
		badRequest(c, "assignee_user_id must be a uuid")
		return
	}
	if req.Title == "" || len(req.Title) > 180 || len(req.Description) > 5000 {
		badRequest(c, "title must be 1-180 characters and description at most 5000")
		return
	}
	if req.Priority == "" {
		req.Priority = "normal"
	}
	if req.WorkType == "" {
		req.WorkType = "general"
	}
	if len(req.WorkType) > 80 {
		badRequest(c, "work_type must be at most 80 characters")
		return
	}
	if req.Priority != "low" && req.Priority != "normal" && req.Priority != "high" && req.Priority != "urgent" {
		badRequest(c, "priority must be low, normal, high, or urgent")
		return
	}
	if req.EstimatedMinutes != nil && *req.EstimatedMinutes <= 0 {
		badRequest(c, "estimated_minutes must be positive")
		return
	}
	item, err := h.store.CreateTask(c.Request.Context(), ownerID, store.NewTask{
		BusinessID: req.BusinessID, AssigneeUserID: req.AssigneeUserID, Title: req.Title,
		Description: req.Description, WorkType: req.WorkType, Priority: req.Priority, EstimatedMinutes: req.EstimatedMinutes, DueAt: req.DueAt,
	})
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "business or employee not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"task": item})
}

func (h *TaskHandler) ListBusiness(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	if _, err := uuid.Parse(c.Param("id")); err != nil {
		badRequest(c, "business id must be a uuid")
		return
	}
	items, err := h.store.ListTasksForOwner(c.Request.Context(), ownerID, c.Param("id"))
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"tasks": items})
}

func (h *TaskHandler) ListMine(c *gin.Context) {
	userID, _ := auth.UserID(c)
	items, err := h.store.ListTasksForEmployee(c.Request.Context(), userID)
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"tasks": items})
}

type startTaskReq struct {
	DeviceID string `json:"device_id"`
}

func (h *TaskHandler) Start(c *gin.Context) {
	userID, _ := auth.UserID(c)
	var req startTaskReq
	if c.Request.ContentLength > 0 && c.ShouldBindJSON(&req) != nil {
		badRequest(c, "invalid body")
		return
	}
	req.DeviceID = strings.TrimSpace(req.DeviceID)
	if req.DeviceID != "" {
		if _, err := uuid.Parse(req.DeviceID); err != nil {
			badRequest(c, "device_id must be a uuid")
			return
		}
	}
	item, session, err := h.store.StartTask(c.Request.Context(), userID, c.Param("task_id"), req.DeviceID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusBadRequest, gin.H{"error": "device does not belong to this employee"})
	case errors.Is(err, store.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "finish or pause the active task before starting another"})
	case err != nil:
		serverError(c, err)
	default:
		c.JSON(http.StatusOK, gin.H{"task": item, "work_session": session})
	}
}

func (h *TaskHandler) Pause(c *gin.Context)    { h.end(c, "pause") }
func (h *TaskHandler) Complete(c *gin.Context) { h.end(c, "complete") }

func (h *TaskHandler) Cancel(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	item, err := h.store.CancelTaskForOwner(c.Request.Context(), ownerID, c.Param("task_id"))
	switch {
	case errors.Is(err, store.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "task is already completed or cancelled"})
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
	case err != nil:
		serverError(c, err)
	default:
		c.JSON(http.StatusOK, gin.H{"task": item})
	}
}

func (h *TaskHandler) Timeline(c *gin.Context) {
	userID, _ := auth.UserID(c)
	timeline, err := h.store.TaskTimelineForMember(c.Request.Context(), userID, c.Param("task_id"))
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, timeline)
}

func (h *TaskHandler) Analysis(c *gin.Context) {
	userID, _ := auth.UserID(c)
	analysis, err := h.store.TaskAnalysisForMember(c.Request.Context(), userID, c.Param("task_id"))
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, analysis)
}

func (h *TaskHandler) end(c *gin.Context, action string) {
	userID, _ := auth.UserID(c)
	item, err := h.store.EndTaskWork(c.Request.Context(), userID, c.Param("task_id"), action)
	switch {
	case errors.Is(err, store.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "task is not currently active"})
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
	case err != nil:
		serverError(c, err)
	default:
		c.JSON(http.StatusOK, gin.H{"task": item})
	}
}
