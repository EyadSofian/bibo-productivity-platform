package server

import (
	"net/http"
	"time"
)

// Connection timeouts. A server with none of these set — which is what this
// backend shipped with — lets one client hold a connection open forever without
// completing a request, so a handful of them exhausts the listener without ever
// looking like load.
const (
	// ReadHeaderTimeout bounds the slowloris window: the time a client gets to
	// finish sending its request headers. Headers are a few hundred bytes, so
	// anything slower than this is not a real client.
	ReadHeaderTimeout = 10 * time.Second

	// ReadTimeout bounds the whole request read, headers and body. The largest
	// body this API accepts is a 256 KB remote-assist frame
	// (handlers.maxRemoteFrameBytes), so a minute covers an agent on a very slow
	// uplink while still cutting off a client that dribbles a body forever.
	//
	// This does NOT cut the SSE routes short. Go only cancels a request context
	// on a read deadline once it starts a background read on the connection, and
	// it never does that for the bodyless GETs those routes are
	// (TestReadTimeoutDoesNotCutStreamingResponses pins that behaviour).
	ReadTimeout = 60 * time.Second

	// IdleTimeout bounds how long a kept-alive connection may sit between
	// requests. It must be set explicitly: when it is zero net/http falls back to
	// ReadTimeout, and when both are zero idle connections are never reaped.
	// Agents reconnect transparently, so closing an idle one costs nothing.
	IdleTimeout = 120 * time.Second
)

// NewHTTPServer builds the listener the backend serves on.
//
// WriteTimeout IS DELIBERATELY UNSET AND MUST STAY THAT WAY. It is a deadline on
// the whole response, not on a single write, so any value at all would kill the
// three long-lived text/event-stream routes mid-session:
//
//	GET /v1/remote-assist/:session_id/frames/stream
//	GET /v1/devices/:device_id/live/stream
//	GET /v1/agent/commands/stream
//
// The last one is how an agent learns it should go live, so a WriteTimeout here
// would present as "Live Now never starts" far from this line. Bound slow
// clients with ReadHeaderTimeout, ReadTimeout or a per-route timeout instead.
// TestWriteTimeoutStaysUnset guards this.
func NewHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: ReadHeaderTimeout,
		ReadTimeout:       ReadTimeout,
		IdleTimeout:       IdleTimeout,
	}
}
