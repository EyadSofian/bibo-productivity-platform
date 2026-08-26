// Package handlers contains the HTTP route handlers.
package handlers

import (
	"context"
	"net/http"
	"time"

	"ctracking/backend/internal/obs"

	"github.com/gin-gonic/gin"
)

// Version is stamped at build time via -ldflags; defaults to "dev".
var Version = "dev"

// healthTimeout bounds the database probe so a hung database cannot hold the
// health endpoint open and stall a load balancer's own timeout.
const healthTimeout = 2 * time.Second

// DBChecker reports database reachability and the applied schema version.
type DBChecker interface {
	Health(ctx context.Context) (int64, error)
}

// HealthHandler serves the liveness/readiness endpoint.
type HealthHandler struct {
	db DBChecker
}

// NewHealthHandler builds a HealthHandler over the given database checker.
func NewHealthHandler(db DBChecker) *HealthHandler {
	return &HealthHandler{db: db}
}

// Health reports build version and database state. It returns 503 when the
// database is unreachable so an orchestrator stops routing to a backend that
// cannot serve requests. The response deliberately carries no error detail:
// this endpoint is unauthenticated and driver errors can contain the DSN.
func (h *HealthHandler) Health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), healthTimeout)
	defer cancel()

	schema, err := h.db.Health(ctx)
	if err != nil {
		obs.Error("health check: database unreachable", "err", err)
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status":   "degraded",
			"version":  Version,
			"database": "unreachable",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":         "ok",
		"version":        Version,
		"database":       "ok",
		"schema_version": schema,
	})
}
