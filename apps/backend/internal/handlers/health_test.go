package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type fakeDB struct {
	version int64
	err     error
	delay   time.Duration
	gotCtx  context.Context
}

func (f *fakeDB) Health(ctx context.Context) (int64, error) {
	f.gotCtx = ctx
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	return f.version, f.err
}

func callHealth(t *testing.T, db DBChecker) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/healthz", NewHealthHandler(db).Health)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body %q: %v", w.Body.String(), err)
	}
	return w, body
}

func TestHealthReportsSchemaVersion(t *testing.T) {
	w, body := callHealth(t, &fakeDB{version: 9})

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if body["status"] != "ok" || body["database"] != "ok" {
		t.Fatalf("status/database = %v/%v, want ok/ok", body["status"], body["database"])
	}
	if got := body["schema_version"]; got != float64(9) {
		t.Fatalf("schema_version = %v, want 9", got)
	}
}

func TestHealthUnreachableDatabaseReturns503(t *testing.T) {
	w, body := callHealth(t, &fakeDB{err: errors.New("connect postgres: dial tcp 10.0.0.1:5432: refused")})

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	if body["database"] != "unreachable" {
		t.Fatalf("database = %v, want unreachable", body["database"])
	}
}

// The endpoint is unauthenticated, so a driver error (which can carry the DSN,
// host and port) must never reach the response body.
func TestHealthDoesNotLeakDriverError(t *testing.T) {
	_, body := callHealth(t, &fakeDB{err: errors.New("postgres://user:hunter2@db.internal:5432/ctracking")})

	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, leak := range []string{"hunter2", "db.internal", "5432", "postgres://"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("response leaked %q: %s", leak, raw)
		}
	}
}

func TestHealthBoundsSlowDatabase(t *testing.T) {
	db := &fakeDB{delay: healthTimeout + time.Second}

	start := time.Now()
	w, _ := callHealth(t, db)
	elapsed := time.Since(start)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when the probe times out", w.Code)
	}
	if elapsed > healthTimeout+2*time.Second {
		t.Fatalf("took %v, want the probe bounded near %v", elapsed, healthTimeout)
	}
	if _, ok := db.gotCtx.Deadline(); !ok {
		t.Fatal("probe context carried no deadline")
	}
}
