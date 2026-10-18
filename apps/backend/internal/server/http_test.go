package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// WriteTimeout is a deadline on the whole response, so setting it would cut the
// three text/event-stream routes off mid-session — including
// /v1/agent/commands/stream, which is how an agent learns to go live. That
// failure would show up as "Live Now never starts", nowhere near this setting,
// so it gets a test rather than only a comment.
func TestWriteTimeoutStaysUnset(t *testing.T) {
	srv := NewHTTPServer(":8080", http.NotFoundHandler())

	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %v, want 0: it would kill the SSE routes", srv.WriteTimeout)
	}
}

// The other three must be set: a server with no timeouts at all lets one client
// hold a connection open indefinitely without completing a request.
func TestConnectionTimeoutsAreSet(t *testing.T) {
	srv := NewHTTPServer(":8080", http.NotFoundHandler())

	if srv.Addr != ":8080" {
		t.Errorf("Addr = %q, want :8080", srv.Addr)
	}
	if srv.Handler == nil {
		t.Error("Handler is nil")
	}
	for _, tc := range []struct {
		name string
		got  time.Duration
	}{
		{"ReadHeaderTimeout", srv.ReadHeaderTimeout},
		{"ReadTimeout", srv.ReadTimeout},
		{"IdleTimeout", srv.IdleTimeout},
	} {
		if tc.got <= 0 {
			t.Errorf("%s = %v, want a positive bound", tc.name, tc.got)
		}
	}
	// A header deadline at or past the whole-request deadline can never fire,
	// which would quietly give back the slowloris window it exists to close.
	if srv.ReadHeaderTimeout >= srv.ReadTimeout {
		t.Errorf("ReadHeaderTimeout (%v) >= ReadTimeout (%v): the header bound can never fire",
			srv.ReadHeaderTimeout, srv.ReadTimeout)
	}
	// IdleTimeout falls back to ReadTimeout when it is zero, so an explicit
	// value shorter than ReadTimeout would be a surprising downgrade.
	if srv.IdleTimeout < srv.ReadTimeout {
		t.Errorf("IdleTimeout (%v) < ReadTimeout (%v)", srv.IdleTimeout, srv.ReadTimeout)
	}
}

// ReadTimeout is a read deadline on the connection, and Go cancels a request
// context when a read against that deadline fails. That only happens once the
// server starts a background read, which it does not do for the bodyless GETs
// the SSE routes are — so a streaming response outlives its ReadTimeout.
//
// This is the assumption that makes ReadTimeout safe to set here at all, and it
// is a property of net/http rather than of this code, so it is pinned: if a Go
// upgrade ever changes it, the three stream routes break and this fails first.
// The handler mirrors the contract of handlers.streamFrames — event-stream
// headers, an immediate flush, then keepalives until ctx is done.
func TestReadTimeoutDoesNotCutStreamingResponses(t *testing.T) {
	const readTimeout = 250 * time.Millisecond

	cancelled := make(chan time.Duration, 1)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()

		keepalive := time.NewTicker(readTimeout / 5)
		defer keepalive.Stop()
		// Four times the read deadline: long enough that a deadline-driven
		// cancellation cannot be missed, short enough to stay a unit test.
		done := time.After(4 * readTimeout)
		for {
			select {
			case <-r.Context().Done():
				cancelled <- time.Since(started)
				return
			case <-done:
				cancelled <- 0
				return
			case <-keepalive.C:
				fmt.Fprint(w, ": keepalive\n\n")
				w.(http.Flusher).Flush()
			}
		}
	})

	// Built through NewHTTPServer so the real policy is under test; only the
	// duration is shortened, since the shipped ReadTimeout is a minute.
	ts := httptest.NewUnstartedServer(handler)
	ts.Config = NewHTTPServer("", handler)
	ts.Config.ReadTimeout = readTimeout
	ts.Config.ReadHeaderTimeout = readTimeout / 2
	ts.Start()
	defer ts.Close()

	res, err := ts.Client().Get(ts.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()

	// Drain the stream; without a reader the response would block on the socket
	// buffer instead of running to the handler's own deadline.
	go func() {
		buf := make([]byte, 1024)
		for {
			if _, err := res.Body.Read(buf); err != nil {
				return
			}
		}
	}()

	select {
	case after := <-cancelled:
		if after != 0 {
			t.Fatalf("the stream's context was cancelled after %v, within the %v ReadTimeout: "+
				"ReadTimeout now cuts SSE responses and must come off the server", after, readTimeout)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("handler never returned")
	}
}
