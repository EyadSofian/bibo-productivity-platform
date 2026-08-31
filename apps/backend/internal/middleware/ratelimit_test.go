package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// engine builds a router with the same trusted-proxy posture as production's
// default: no proxy is believed, so X-Forwarded-For cannot pick the bucket.
func engine(t *testing.T, h gin.HandlerFunc) *gin.Engine {
	t.Helper()
	r := gin.New()
	if err := r.SetTrustedProxies(nil); err != nil {
		t.Fatalf("SetTrustedProxies: %v", err)
	}
	r.POST("/login", h, func(c *gin.Context) { c.Status(http.StatusOK) })
	return r
}

func post(r *gin.Engine, forwardedFor string) int {
	req := httptest.NewRequest(http.MethodPost, "/login", nil)
	req.RemoteAddr = "192.0.2.10:34567"
	if forwardedFor != "" {
		req.Header.Set("X-Forwarded-For", forwardedFor)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code
}

func TestLoginRateLimitBlocksAfterBurst(t *testing.T) {
	r := engine(t, LoginRateLimit())

	for i := 0; i < loginBurst; i++ {
		if code := post(r, ""); code != http.StatusOK {
			t.Fatalf("request %d within the burst was rejected: %d", i+1, code)
		}
	}
	if code := post(r, ""); code != http.StatusTooManyRequests {
		t.Fatalf("request past the burst got %d, want 429", code)
	}
}

// The regression this file exists for: rotating X-Forwarded-For used to defeat
// the limiter completely, because gin trusts every proxy unless told otherwise.
func TestLoginRateLimitIgnoresForgedForwardedFor(t *testing.T) {
	r := engine(t, LoginRateLimit())

	for i := 0; i < loginBurst; i++ {
		if code := post(r, "203.0.113.1"); code != http.StatusOK {
			t.Fatalf("request %d within the burst was rejected: %d", i+1, code)
		}
	}
	// A different forged client IP on every attempt must not buy more attempts.
	for i := 0; i < 5; i++ {
		if code := post(r, forgedIP(i)); code != http.StatusTooManyRequests {
			t.Fatalf("forged X-Forwarded-For %q bypassed the limit: got %d, want 429",
				forgedIP(i), code)
		}
	}
}

func forgedIP(i int) string {
	return "203.0.113." + string(rune('1'+i))
}

func TestIngestRateLimitAllowsAHealthyBurst(t *testing.T) {
	r := engine(t, IngestRateLimit())

	for i := 0; i < ingestBurst; i++ {
		if code := post(r, ""); code != http.StatusOK {
			t.Fatalf("ingest request %d within the burst was rejected: %d", i+1, code)
		}
	}
	if code := post(r, ""); code != http.StatusTooManyRequests {
		t.Fatalf("ingest past the burst got %d, want 429", code)
	}
}

func TestIdleBucketsAreEvicted(t *testing.T) {
	l := newIPLimiter(1, 1)
	now := time.Now()
	l.now = func() time.Time { return now }

	l.allow("198.51.100.1")
	l.allow("198.51.100.2")
	if got := len(l.buckets); got != 2 {
		t.Fatalf("expected 2 buckets, got %d", got)
	}

	// Past the TTL, a request from a third address sweeps the two idle ones.
	now = now.Add(bucketTTL + time.Minute)
	l.allow("198.51.100.3")
	if got := len(l.buckets); got != 1 {
		t.Fatalf("idle buckets were not evicted: %d remain", got)
	}
	if _, ok := l.buckets["198.51.100.3"]; !ok {
		t.Fatal("the active bucket was evicted instead of the idle ones")
	}
}

func TestActiveBucketSurvivesSweep(t *testing.T) {
	l := newIPLimiter(100, 100)
	now := time.Now()
	l.now = func() time.Time { return now }

	l.allow("198.51.100.1")
	// Keep it warm across the sweep boundary.
	for i := 0; i < 4; i++ {
		now = now.Add(bucketTTL / 2)
		l.allow("198.51.100.1")
	}
	if _, ok := l.buckets["198.51.100.1"]; !ok {
		t.Fatal("a continuously used bucket was evicted")
	}
}
