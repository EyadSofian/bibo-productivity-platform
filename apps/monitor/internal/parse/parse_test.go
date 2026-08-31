package parse

import "testing"

// Real lines captured from journald on the Oracle prod box (2026-07-05).
func TestParseGin(t *testing.T) {
	cases := []struct {
		line   string
		status int
		durMS  float64
		method string
		path   string
	}{
		{`[GIN] 2026/07/05 - 16:30:21 | 200 |   83.549697ms |   171.251.232.5 | POST     "/v1/sync/screenshots"`, 200, 83.549697, "POST", "/v1/sync/screenshots"},
		{`[GIN] 2026/07/05 - 16:30:20 | 200 |        38.2µs |   171.251.232.5 | GET      "/healthz"`, 200, 0.0382, "GET", "/healthz"},
		{`[GIN] 2026/07/05 - 16:28:47 | 200 |     298.523µs | 2a06:98c0:3600::103 | GET      "/wp-admin/install.php?step=1"`, 200, 0.298523, "GET", "/wp-admin/install.php"},
		{`[GIN] 2026/07/05 - 16:52:00 | 200 |          2m0s |   171.251.232.5 | POST     "/v1/keepalive?seconds=120&percent=30"`, 200, 120000, "POST", "/v1/keepalive"},
		{`[GIN] 2026/07/03 - 10:00:00 | 500 |          2.1s |       1.2.3.4 | GET      "/v1/x"`, 500, 2100, "GET", "/v1/x"},
	}
	for _, c := range cases {
		r, ok := ParseRequest(c.line)
		if !ok {
			t.Fatalf("no parse: %s", c.line)
		}
		if r.Status != c.status || r.Method != c.method || r.Path != c.path {
			t.Errorf("got %+v want %+v", r, c)
		}
		if diff := r.DurMS - c.durMS; diff > 0.0001 || diff < -0.0001 {
			t.Errorf("dur %v want %v (%s)", r.DurMS, c.durMS, c.line)
		}
	}
}

func TestParseLogfmt(t *testing.T) {
	line := `time=2026-07-05T16:30:38.203Z level=INFO msg=http method=GET path=/healthz status=200 dur=5.32µs`
	r, ok := ParseRequest(line)
	if !ok {
		t.Fatal("no parse")
	}
	if r.Status != 200 || r.Method != "GET" || r.Path != "/healthz" {
		t.Errorf("got %+v", r)
	}
	if r.DurMS < 0.005 || r.DurMS > 0.006 {
		t.Errorf("dur %v", r.DurMS)
	}
}

func TestNonRequestLines(t *testing.T) {
	for _, line := range []string{
		`{"time":"2026-07-05T12:00:00Z","level":"INFO","msg":"retention sweep","env":"production","deleted":3}`,
		`2026/07/05 12:00:00.000000 listening on :8080`,
		``,
	} {
		if _, ok := ParseRequest(line); ok {
			t.Errorf("unexpected parse: %s", line)
		}
	}
}

func TestLevel(t *testing.T) {
	cases := map[string]string{
		`{"time":"x","level":"ERROR","msg":"boom"}`:                           "ERROR",
		`time=x level=WARN msg=slow`:                                          "WARN",
		`[GIN] 2026/07/05 - 16:30:20 | 500 |  1ms |  1.2.3.4 | GET      "/x"`: "ERROR",
		`[GIN] 2026/07/05 - 16:30:20 | 404 |  1ms |  1.2.3.4 | GET      "/x"`: "WARN",
		`[GIN] 2026/07/05 - 16:30:20 | 200 |  1ms |  1.2.3.4 | GET      "/x"`: "INFO",
		`plain startup line`: "INFO",
	}
	for line, want := range cases {
		if got := Level(line); got != want {
			t.Errorf("Level(%q) = %s want %s", line, got, want)
		}
	}
}
