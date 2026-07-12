package handlers

import (
	"net/http"

	"ctracking/backend/internal/privacyapps"

	"github.com/gin-gonic/gin"
)

// PrivacyApps serves the curated sensitive-app list (see internal/privacyapps).
// Public: the desktop needs it in personal (no-account) mode too.
func PrivacyApps(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"categories": privacyapps.Categories()})
}
