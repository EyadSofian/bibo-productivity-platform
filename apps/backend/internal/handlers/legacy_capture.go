package handlers

import (
	"sync"
	"time"

	"ctracking/backend/internal/obs"
)

// CodeLegacyCaptureDisabled is the machine-readable reason a still-image request
// was refused or discarded: screen monitoring is video-only
// (docs/adr/0002-video-first-media-plane.md). Clients must treat it as permanent
// and stop capturing, not retry.
const CodeLegacyCaptureDisabled = "MEDIA_LEGACY_CAPTURE_DISABLED"

// legacyLogInterval is the minimum gap between legacy-capture log lines. An agent
// that has not rolled forward retries on every sync pass, and the ingest limiter
// still allows 10 requests per second per IP, so logging each one would bury the
// rest of the log. One line per interval carries the suppressed count with it, so
// no information is lost -- only volume.
const legacyLogInterval = time.Minute

// One limiter per call site, deliberately not shared. The two events have very
// different shapes: agent uploads arrive in a flood from every un-upgraded
// device, while a live-capture request is a rare, human-triggered action. A
// single shared limiter would let the flood swallow the interesting event.
//
// The running totals live in obs (LegacyStillCaptureRejected) and are exposed on
// /healthz; these only control how often the condition is written to the log.
var (
	legacyUploadLog      = &throttledLogger{interval: legacyLogInterval}
	legacyLiveCaptureLog = &throttledLogger{interval: legacyLogInterval}
)

type throttledLogger struct {
	interval time.Duration
	mu       sync.Mutex
	last     time.Time
	// suppressed counts the lines dropped since the last one that was written.
	suppressed int
	// now is injectable so tests do not sleep.
	now func() time.Time
}

// warn writes msg at WARN level at most once per interval, appending how many
// occurrences were suppressed since the previous line.
func (t *throttledLogger) warn(msg string, args ...any) {
	t.mu.Lock()
	clock := t.now
	if clock == nil {
		clock = time.Now
	}
	at := clock()
	if !t.last.IsZero() && at.Sub(t.last) < t.interval {
		t.suppressed++
		t.mu.Unlock()
		return
	}
	suppressed := t.suppressed
	t.suppressed = 0
	t.last = at
	t.mu.Unlock()

	obs.Warn(msg, append(args, "suppressed_since_last", suppressed)...)
}
