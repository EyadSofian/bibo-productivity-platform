package middleware

import (
	"crypto/rand"
	"encoding/hex"

	"github.com/gin-gonic/gin"
)

// ContextRequestID is the gin context key holding the current request id.
const ContextRequestID = "request_id"

// HeaderRequestID is the header a request id is read from and echoed back on.
const HeaderRequestID = "X-Request-Id"

// maxInboundRequestID bounds an id supplied by the caller. The value is echoed
// in responses and written to logs, so an unbounded one is a log-flooding vector.
const maxInboundRequestID = 64

// RequestID attaches an id to every request and echoes it in the response.
//
// It is what makes a user-visible error traceable: the API returns the id in the
// error body, and the same id appears on every log line for that request, so
// "live view failed at 14:32" becomes a specific request rather than a search.
//
// An inbound X-Request-Id is honoured so a trace started at the edge stays whole,
// but only after being length-capped and stripped of anything outside a safe
// alphabet. It is attacker-controlled text that ends up in logs and headers, and
// a newline in it would let a caller forge log lines.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := sanitizeRequestID(c.GetHeader(HeaderRequestID))
		if id == "" {
			id = newRequestID()
		}
		c.Set(ContextRequestID, id)
		c.Header(HeaderRequestID, id)
		c.Next()
	}
}

// RequestIDOf returns the current request's id, or "" outside a request.
func RequestIDOf(c *gin.Context) string {
	if c == nil {
		return ""
	}
	if v, ok := c.Get(ContextRequestID); ok {
		if id, ok := v.(string); ok {
			return id
		}
	}
	return ""
}

func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// A request id is a correlation aid, not a security control, so a
		// failure here must not fail the request.
		return "unavailable"
	}
	return hex.EncodeToString(b[:])
}

// sanitizeRequestID keeps only characters that are safe in a header and a log
// line: letters, digits, dash and underscore. Anything else means the value is
// not a real trace id, so it is dropped rather than partially salvaged.
func sanitizeRequestID(raw string) string {
	if raw == "" || len(raw) > maxInboundRequestID {
		return ""
	}
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '_':
		default:
			return ""
		}
	}
	return raw
}
