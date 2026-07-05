// Package parse extracts per-request events (status, latency, method, path)
// and log levels from the service log lines we actually ship:
//   - gin default access lines (bibotracking):
//     [GIN] 2026/07/05 - 16:30:21 | 200 |   83.549697ms |   171.251.232.5 | POST     "/v1/sync/screenshots"
//   - slog logfmt http lines (biboreward):
//     time=2026-07-05T16:30:38.203Z level=INFO msg=http method=GET path=/healthz status=200 dur=5.32µs
//   - slog JSON lines (bibotracking obs package) — level only, no request data.
package parse

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Request struct {
	Status int
	DurMS  float64
	Method string
	Path   string
}

var ginRe = regexp.MustCompile(`^\[GIN\] \d{4}/\d{2}/\d{2} - \d{2}:\d{2}:\d{2} \|\s*(\d{3})\s*\|\s*(\S+)\s*\|\s*\S+\s*\|\s*([A-Z]+)\s+"([^"]*)"`)

// ParseRequest returns the request event embedded in a log line, if any.
func ParseRequest(line string) (Request, bool) {
	if strings.HasPrefix(line, "[GIN]") {
		m := ginRe.FindStringSubmatch(line)
		if m == nil {
			return Request{}, false
		}
		status, _ := strconv.Atoi(m[1])
		dur, err := time.ParseDuration(m[2])
		if err != nil {
			return Request{}, false
		}
		return Request{Status: status, DurMS: float64(dur) / float64(time.Millisecond), Method: m[3], Path: stripQuery(m[4])}, true
	}
	if strings.HasPrefix(line, "time=") && strings.Contains(line, "msg=http") {
		var r Request
		var haveStatus, haveDur bool
		for _, f := range strings.Fields(line) {
			k, v, ok := strings.Cut(f, "=")
			if !ok {
				continue
			}
			switch k {
			case "method":
				r.Method = v
			case "path":
				r.Path = stripQuery(v)
			case "status":
				if n, err := strconv.Atoi(v); err == nil {
					r.Status = n
					haveStatus = true
				}
			case "dur":
				if d, err := time.ParseDuration(v); err == nil {
					r.DurMS = float64(d) / float64(time.Millisecond)
					haveDur = true
				}
			}
		}
		if haveStatus && haveDur {
			return r, true
		}
	}
	return Request{}, false
}

// stripQuery drops the query string: paths are matched exactly (keepalive
// exclusion, alert rules) and queries would explode cardinality.
func stripQuery(p string) string {
	if i := strings.IndexByte(p, '?'); i >= 0 {
		return p[:i]
	}
	return p
}

// Level classifies a log line as ERROR, WARN or INFO.
func Level(line string) string {
	if r, ok := ParseRequest(line); ok {
		if r.Status >= 500 {
			return "ERROR"
		}
		if r.Status >= 400 {
			return "WARN"
		}
		return "INFO"
	}
	switch {
	case strings.Contains(line, `"level":"ERROR"`), strings.Contains(line, "level=ERROR"),
		strings.Contains(line, " ERR "), strings.Contains(line, "panic:"):
		return "ERROR"
	case strings.Contains(line, `"level":"WARN"`), strings.Contains(line, "level=WARN"):
		return "WARN"
	}
	return "INFO"
}
