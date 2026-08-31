package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/time/rate"
)

// Rate limit budgets. Login stays tight enough to throttle scripted guessing while
// letting a human retry; ingest is generous because a healthy agent syncs in
// batches and a backlog after an outage arrives as a burst.
const (
	loginRPS    = 1
	loginBurst  = 5
	ingestRPS   = 10
	ingestBurst = 60
)

// bucketTTL is how long an idle bucket is kept. Without eviction the map grows
// without bound, keyed by a value the caller influences — a slow memory leak and
// a DoS vector in its own right.
const bucketTTL = 30 * time.Minute

// ipLimiter keeps a token-bucket rate limiter per client IP. In-memory, so it
// guards a single instance; a multi-instance deployment needs a shared store.
type ipLimiter struct {
	mu        sync.Mutex
	buckets   map[string]*ipBucket
	rps       rate.Limit
	burst     int
	ttl       time.Duration
	lastSweep time.Time
	// now is injectable so eviction can be tested without sleeping.
	now func() time.Time
}

type ipBucket struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newIPLimiter(rps rate.Limit, burst int) *ipLimiter {
	return &ipLimiter{
		buckets: make(map[string]*ipBucket),
		rps:     rps,
		burst:   burst,
		ttl:     bucketTTL,
		now:     time.Now,
	}
}

// LoginRateLimit limits auth attempts per client IP.
//
// The key is gin's ClientIP(), which only reflects X-Forwarded-For when the
// engine has been told which proxies to trust (see server.New / TRUSTED_PROXIES).
// With no trusted proxies configured, a forged header cannot move a caller to a
// fresh bucket.
func LoginRateLimit() gin.HandlerFunc {
	return limitBy(newIPLimiter(loginRPS, loginBurst), "too many attempts, slow down")
}

// IngestRateLimit caps how fast one machine can push activity batches, screenshots
// and live frames. It bounds the damage a stolen agent token or a looping client
// can do; a healthy agent stays far below it.
func IngestRateLimit() gin.HandlerFunc {
	return limitBy(newIPLimiter(ingestRPS, ingestBurst), "too many requests, slow down")
}

func limitBy(l *ipLimiter, message string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !l.allow(c.ClientIP()) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": message})
			return
		}
		c.Next()
	}
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweepLocked(now)

	b, ok := l.buckets[ip]
	if !ok {
		b = &ipBucket{limiter: rate.NewLimiter(l.rps, l.burst)}
		l.buckets[ip] = b
	}
	b.lastSeen = now
	return b.limiter.Allow()
}

// sweepLocked drops buckets untouched for longer than the TTL. It runs at most
// once per TTL so the common path stays a single map lookup.
func (l *ipLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < l.ttl {
		return
	}
	l.lastSweep = now
	for ip, b := range l.buckets {
		if now.Sub(b.lastSeen) >= l.ttl {
			delete(l.buckets, ip)
		}
	}
}
