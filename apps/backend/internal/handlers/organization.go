package handlers

import (
	"errors"
	"net/http"
	"strings"

	"ctracking/backend/internal/auth"
	"ctracking/backend/internal/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type OrganizationHandler struct{ store *store.Store }

func NewOrganizationHandler(s *store.Store) *OrganizationHandler {
	return &OrganizationHandler{store: s}
}

type organizationItemReq struct {
	BusinessID  string `json:"business_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (r *organizationItemReq) validate(requireBusiness bool) string {
	r.BusinessID = strings.TrimSpace(r.BusinessID)
	r.Name = strings.TrimSpace(r.Name)
	r.Description = strings.TrimSpace(r.Description)
	if requireBusiness {
		if _, err := uuid.Parse(r.BusinessID); err != nil {
			return "business_id must be a uuid"
		}
	}
	if r.Name == "" || len(r.Name) > 120 {
		return "name must be 1-120 characters"
	}
	if len(r.Description) > 1000 {
		return "description is too long"
	}
	return ""
}

func (h *OrganizationHandler) List(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	businessID := c.Param("id")
	if _, err := uuid.Parse(businessID); err != nil {
		badRequest(c, "business id must be a uuid")
		return
	}
	organization, err := h.store.ListOrganization(c.Request.Context(), ownerID, businessID)
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "business not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.JSON(http.StatusOK, organization)
}

func (h *OrganizationHandler) CreateDepartment(c *gin.Context) { h.create(c, "department") }
func (h *OrganizationHandler) CreateJobRole(c *gin.Context)    { h.create(c, "job_role") }
func (h *OrganizationHandler) UpdateDepartment(c *gin.Context) { h.update(c, "department") }
func (h *OrganizationHandler) UpdateJobRole(c *gin.Context)    { h.update(c, "job_role") }
func (h *OrganizationHandler) DeleteDepartment(c *gin.Context) { h.delete(c, "department") }
func (h *OrganizationHandler) DeleteJobRole(c *gin.Context)    { h.delete(c, "job_role") }

func (h *OrganizationHandler) create(c *gin.Context, kind string) {
	ownerID, _ := auth.UserID(c)
	var req organizationItemReq
	if c.ShouldBindJSON(&req) != nil {
		badRequest(c, "invalid body")
		return
	}
	if message := req.validate(true); message != "" {
		badRequest(c, message)
		return
	}
	if kind == "department" {
		item, err := h.store.CreateDepartment(c.Request.Context(), ownerID, req.BusinessID, req.Name, req.Description)
		h.write(c, gin.H{"department": item}, err, http.StatusCreated)
		return
	}
	item, err := h.store.CreateJobRole(c.Request.Context(), ownerID, req.BusinessID, req.Name, req.Description)
	h.write(c, gin.H{"job_role": item}, err, http.StatusCreated)
}

func (h *OrganizationHandler) update(c *gin.Context, kind string) {
	ownerID, _ := auth.UserID(c)
	id := c.Param("item_id")
	if _, err := uuid.Parse(id); err != nil {
		badRequest(c, "item id must be a uuid")
		return
	}
	var req organizationItemReq
	if c.ShouldBindJSON(&req) != nil {
		badRequest(c, "invalid body")
		return
	}
	if message := req.validate(false); message != "" {
		badRequest(c, message)
		return
	}
	if kind == "department" {
		item, err := h.store.UpdateDepartment(c.Request.Context(), ownerID, id, req.Name, req.Description)
		h.write(c, gin.H{"department": item}, err, http.StatusOK)
		return
	}
	item, err := h.store.UpdateJobRole(c.Request.Context(), ownerID, id, req.Name, req.Description)
	h.write(c, gin.H{"job_role": item}, err, http.StatusOK)
}

func (h *OrganizationHandler) delete(c *gin.Context, kind string) {
	ownerID, _ := auth.UserID(c)
	id := c.Param("item_id")
	if _, err := uuid.Parse(id); err != nil {
		badRequest(c, "item id must be a uuid")
		return
	}
	var err error
	if kind == "department" {
		err = h.store.DeleteDepartment(c.Request.Context(), ownerID, id)
	} else {
		err = h.store.DeleteJobRole(c.Request.Context(), ownerID, id)
	}
	if errors.Is(err, store.ErrNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "organization item not found"})
		return
	}
	if err != nil {
		serverError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *OrganizationHandler) write(c *gin.Context, body gin.H, err error, status int) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "business or organization item not found"})
	case errors.Is(err, store.ErrConflict):
		c.JSON(http.StatusConflict, gin.H{"error": "that name is already used in this business"})
	case err != nil:
		serverError(c, err)
	default:
		c.JSON(status, body)
	}
}

type employeeOrganizationReq struct {
	DepartmentID *string `json:"department_id"`
	JobRoleID    *string `json:"job_role_id"`
}

func (h *OrganizationHandler) AssignEmployee(c *gin.Context) {
	ownerID, _ := auth.UserID(c)
	businessID, employeeID := c.Param("id"), c.Param("employee_id")
	if _, err := uuid.Parse(businessID); err != nil {
		badRequest(c, "business id must be a uuid")
		return
	}
	if _, err := uuid.Parse(employeeID); err != nil {
		badRequest(c, "employee id must be a uuid")
		return
	}
	var req employeeOrganizationReq
	if c.ShouldBindJSON(&req) != nil {
		badRequest(c, "invalid body")
		return
	}
	for _, id := range []**string{&req.DepartmentID, &req.JobRoleID} {
		if *id == nil {
			continue
		}
		trimmed := strings.TrimSpace(**id)
		if _, err := uuid.Parse(trimmed); err != nil {
			badRequest(c, "organization ids must be uuid or null")
			return
		}
		*id = &trimmed
	}
	employee, err := h.store.AssignEmployeeOrganization(c.Request.Context(), ownerID, businessID, employeeID, req.DepartmentID, req.JobRoleID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "business or employee not found"})
	case errors.Is(err, store.ErrForbidden):
		c.JSON(http.StatusBadRequest, gin.H{"error": "organization assignment is outside this business"})
	case err != nil:
		serverError(c, err)
	default:
		c.JSON(http.StatusOK, gin.H{"employee": employee})
	}
}
