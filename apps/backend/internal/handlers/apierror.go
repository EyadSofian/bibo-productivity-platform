package handlers

import (
	"net/http"

	"ctracking/backend/internal/middleware"
	"ctracking/backend/internal/obs"

	"github.com/gin-gonic/gin"
)

// The media control plane returns machine-readable errors:
//
//	{"error": {"code": "...", "message": "...", "request_id": "...", "retryable": bool}}
//
// The older endpoints keep their `{"error": "message"}` shape. Rewriting them is
// a breaking change to every existing client for no benefit to this slice, so the
// new envelope is scoped to the new surface and the old one is migrated when its
// endpoints are replaced.
//
// `retryable` is the field that earns its place. Without it a client cannot tell
// "the device is offline, try again in a moment" from "you are not allowed to do
// this", and ends up either retrying forever or giving up on a transient fault.

// Media error codes. Each one maps to a distinct thing the UI must say: a viewer
// told "unavailable" learns nothing and asks a human instead.
const (
	// CodeForbidden: authenticated, but lacking the required permission.
	CodeForbidden = "MEDIA_FORBIDDEN"
	// CodeSessionNotFound: no such session, or not one the caller may see. The
	// two are deliberately indistinguishable.
	CodeSessionNotFound = "MEDIA_SESSION_NOT_FOUND"
	// CodeDeviceNotFound: no such device in a business the caller belongs to.
	CodeDeviceNotFound = "MEDIA_DEVICE_NOT_FOUND"
	// CodeAgentOffline: the device exists but is not currently reachable.
	CodeAgentOffline = "MEDIA_AGENT_OFFLINE"
	// CodeMonitoringDisabled: the owner turned monitoring off for this device.
	CodeMonitoringDisabled = "MEDIA_MONITORING_DISABLED"
	// CodeSessionEnded: the session is terminal; a token cannot be minted.
	CodeSessionEnded = "MEDIA_SESSION_ENDED"
	// CodeInvalidState: the requested transition is illegal from where the
	// session actually is.
	CodeInvalidState = "MEDIA_INVALID_STATE"
	// CodeProviderUnconfigured: no SFU is wired up yet (slice V05). Distinct
	// from a provider error: nothing is broken, the feature is not deployed.
	CodeProviderUnconfigured = "MEDIA_PROVIDER_UNCONFIGURED"
	// CodeProviderError: the SFU rejected or failed the operation.
	CodeProviderError = "MEDIA_PROVIDER_ERROR"
	// CodeInvalidRequest: malformed input.
	CodeInvalidRequest = "MEDIA_INVALID_REQUEST"
	// CodeInternal: an unexpected server-side failure.
	CodeInternal = "MEDIA_INTERNAL_ERROR"
)

type apiErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Retryable bool   `json:"retryable"`
}

// mediaError writes the typed envelope.
//
// The message is for a person and must stay free of internals: it is rendered in
// the admin UI, and a driver error or a room name in it would leak infrastructure
// to whoever can read the screen. The real error goes to the log, correlated by
// request id.
func mediaError(c *gin.Context, status int, code, message string, retryable bool) {
	c.AbortWithStatusJSON(status, gin.H{"error": apiErrorBody{
		Code:      code,
		Message:   message,
		RequestID: middleware.RequestIDOf(c),
		Retryable: retryable,
	}})
}

// mediaInternal logs the real cause and returns an opaque error carrying the
// request id, so a support conversation can find the log line without the
// response ever containing the reason.
func mediaInternal(c *gin.Context, err error) {
	obs.Error("media control plane error",
		"err", err,
		"path", c.FullPath(),
		"method", c.Request.Method,
		"request_id", middleware.RequestIDOf(c))
	mediaError(c, http.StatusInternalServerError, CodeInternal,
		"Something went wrong. Try again.", true)
}

// requestIDFor is the request id for audit metadata, so an audit row and the log
// lines for the same request can be joined.
func requestIDFor(c *gin.Context) string { return middleware.RequestIDOf(c) }

// auditWriteFailed records that the audit trail itself could not be written.
// Loud on purpose: a missing audit row is a gap in the record of who watched
// whom, and the only thing worse than the gap is not knowing it is there.
func auditWriteFailed(c *gin.Context, action string, err error) {
	obs.Error("media audit write failed",
		"err", err,
		"action", action,
		"request_id", middleware.RequestIDOf(c))
}
