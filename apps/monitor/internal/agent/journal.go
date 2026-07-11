package agent

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"ctracking/monitor/internal/parse"
	"ctracking/monitor/internal/wire"
)

// maxLogLines caps how many journal lines one tick ships, so a log storm
// can't produce a giant batch. Requests are still parsed from every line.
const maxLogLines = 5000

// readJournal reads new journald entries for the units since the persisted
// cursor and turns them into request events + log lines. The cursor is only
// advanced after a successful read, so lines are never skipped (at-least-once).
func readJournal(units []string, cursorFile string) ([]wire.Request, []wire.LogLine, error) {
	args := []string{"-o", "json", "--no-pager", "-q"}
	for _, u := range units {
		args = append(args, "-u", u)
	}
	if cur, err := os.ReadFile(cursorFile); err == nil && strings.TrimSpace(string(cur)) != "" {
		args = append(args, "--after-cursor", strings.TrimSpace(string(cur)))
	} else {
		args = append(args, "--since", "-2 minutes")
	}
	out, err := exec.Command("journalctl", args...).Output()
	if err != nil {
		return nil, nil, err
	}

	var reqs []wire.Request
	var logs []wire.LogLine
	var lastCursor string
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		var e struct {
			Cursor  string          `json:"__CURSOR"`
			RT      string          `json:"__REALTIME_TIMESTAMP"`
			Unit    string          `json:"_SYSTEMD_UNIT"`
			Message json.RawMessage `json:"MESSAGE"`
		}
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue
		}
		if e.Cursor != "" {
			lastCursor = e.Cursor
		}
		var msg string
		if json.Unmarshal(e.Message, &msg) != nil {
			continue // binary/array MESSAGE
		}
		usec, _ := strconv.ParseInt(e.RT, 10, 64)
		ts := usec / 1000
		service := strings.TrimSuffix(e.Unit, ".service")
		if r, ok := parse.ParseRequest(msg); ok {
			reqs = append(reqs, wire.Request{TS: ts, Service: service, Status: r.Status, DurMS: r.DurMS, Method: r.Method, Path: r.Path})
		}
		if len(logs) < maxLogLines {
			logs = append(logs, wire.LogLine{TS: ts, Service: service, Level: parse.Level(msg), Line: msg})
		}
	}
	if lastCursor != "" {
		os.WriteFile(cursorFile, []byte(lastCursor), 0o644)
	}
	return reqs, logs, sc.Err()
}
