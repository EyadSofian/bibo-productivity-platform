package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"ctracking/backend/internal/live"
)

func TestValidateRemoteAction(t *testing.T) {
	valid := []remoteActionReq{
		{Kind: "click", Payload: json.RawMessage(`{"x":0,"y":1,"button":"left"}`)},
		{Kind: "move", Payload: json.RawMessage(`{"x":0.5,"y":0.5}`)},
		{Kind: "key", Payload: json.RawMessage(`{"key":"Enter"}`)},
		{Kind: "text", Payload: json.RawMessage(`{"text":"hello"}`)},
	}
	for _, action := range valid {
		if !validateRemoteAction(action) {
			t.Errorf("valid action rejected: %#v", action)
		}
	}

	invalid := []remoteActionReq{
		{Kind: "click", Payload: json.RawMessage(`{"x":-1,"y":0,"button":"left"}`)},
		{Kind: "click", Payload: json.RawMessage(`{"x":0.5,"y":0.5,"button":"middle"}`)},
		{Kind: "move", Payload: json.RawMessage(`{"x":2,"y":0.5}`)},
		{Kind: "key", Payload: json.RawMessage(`{"key":"Meta"}`)},
		{Kind: "text", Payload: json.RawMessage(`{"text":""}`)},
		{Kind: "shell", Payload: json.RawMessage(`{"command":"whoami"}`)},
	}
	for _, action := range invalid {
		if validateRemoteAction(action) {
			t.Errorf("invalid action accepted: %#v", action)
		}
	}
}

// --- live frame streaming (SSE) ---

// flushRecorder counts flushes so tests can assert a frame was actually pushed
// to the wire rather than left sitting in a buffer, which is the whole point of
// the streaming endpoint.
type flushRecorder struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	flushes int
	failAt  int // when > 0, the write at this index fails, simulating a dead client
	writes  int
}

func (f *flushRecorder) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	if f.failAt > 0 && f.writes >= f.failAt {
		return 0, errors.New("client gone")
	}
	return f.buf.Write(p)
}

func (f *flushRecorder) Flush() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.flushes++
}

func (f *flushRecorder) body() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buf.String()
}

func (f *flushRecorder) flushCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.flushes
}

func TestStreamFramesEmitsFrameEvents(t *testing.T) {
	frames := make(chan live.Frame, 1)
	rec := &flushRecorder{}
	receivedAt := time.Unix(1_700_000_000, 0).UTC()
	frames <- live.Frame{Bytes: []byte("webp-bytes"), Width: 1280, Height: 720, ReceivedAt: receivedAt}
	close(frames)

	streamFrames(context.Background(), rec, rec, frames, nil)

	body := rec.body()
	if !strings.Contains(body, "event: frame\n") {
		t.Fatalf("no frame event in stream:\n%s", body)
	}
	// One frame + the close notice must both reach the wire.
	if !strings.Contains(body, "event: end\n") {
		t.Fatalf("closing the session did not emit an end event:\n%s", body)
	}
	if rec.flushCount() < 2 {
		t.Fatalf("want a flush per event, got %d", rec.flushCount())
	}

	line := ""
	for _, l := range strings.Split(body, "\n") {
		if strings.HasPrefix(l, "data: ") && strings.Contains(l, "image") {
			line = strings.TrimPrefix(l, "data: ")
			break
		}
	}
	if line == "" {
		t.Fatalf("no data line for the frame event:\n%s", body)
	}
	var got frameEvent
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("frame event is not valid JSON: %v (%s)", err, line)
	}
	decoded, err := base64.StdEncoding.DecodeString(got.Image)
	if err != nil {
		t.Fatalf("image is not base64: %v", err)
	}
	if string(decoded) != "webp-bytes" {
		t.Fatalf("image round-tripped as %q", decoded)
	}
	if got.Width != 1280 || got.Height != 720 {
		t.Fatalf("dimensions lost: %+v", got)
	}
	if got.ReceivedAt != receivedAt.Format(time.RFC3339Nano) {
		t.Fatalf("received_at = %q, want %q", got.ReceivedAt, receivedAt.Format(time.RFC3339Nano))
	}
}

// Every event must be exactly one SSE record: no stray blank lines inside a
// payload, which would split one frame into two malformed events.
func TestStreamFramesEventsAreWellFormed(t *testing.T) {
	frames := make(chan live.Frame, 1)
	rec := &flushRecorder{}
	frames <- live.Frame{Bytes: []byte{0x00, 0x0a, 0xff, '\n'}, Width: 8, Height: 8, ReceivedAt: time.Unix(1, 0)}
	close(frames)

	streamFrames(context.Background(), rec, rec, frames, nil)

	for _, record := range strings.Split(strings.TrimSuffix(rec.body(), "\n\n"), "\n\n") {
		lines := strings.Split(record, "\n")
		if len(lines) != 2 {
			t.Fatalf("record is not exactly event+data:\n%q", record)
		}
		if !strings.HasPrefix(lines[0], "event: ") || !strings.HasPrefix(lines[1], "data: ") {
			t.Fatalf("malformed SSE record:\n%q", record)
		}
	}
}

func TestStreamFramesStopsWhenClientDisconnects(t *testing.T) {
	frames := make(chan live.Frame)
	rec := &flushRecorder{}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		defer close(done)
		streamFrames(ctx, rec, rec, frames, nil)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not return when the client disconnected")
	}
}

func TestStreamFramesStopsWhenWriteFails(t *testing.T) {
	frames := make(chan live.Frame, 2)
	rec := &flushRecorder{failAt: 1}
	frames <- live.Frame{Bytes: []byte("a"), Width: 1, Height: 1, ReceivedAt: time.Unix(1, 0)}
	frames <- live.Frame{Bytes: []byte("b"), Width: 1, Height: 1, ReceivedAt: time.Unix(2, 0)}

	done := make(chan struct{})
	go func() {
		defer close(done)
		streamFrames(context.Background(), rec, rec, frames, nil)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream kept writing to a disconnected client")
	}
}

func TestStreamFramesSendsKeepalive(t *testing.T) {
	frames := make(chan live.Frame)
	ticks := make(chan time.Time, 1)
	rec := &flushRecorder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		streamFrames(ctx, rec, rec, frames, ticks)
	}()

	ticks <- time.Now()
	deadline := time.After(2 * time.Second)
	for {
		if strings.Contains(rec.body(), "event: ping\n") {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("no keepalive ping was sent:\n%s", rec.body())
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

// End-to-end through the hub: an uploaded frame reaches an attached viewer, and
// ending the session closes the viewer's stream.
func TestStreamFramesDeliversHubFramesAndSessionEnd(t *testing.T) {
	hub := live.NewHub()
	const session = "11111111-1111-1111-1111-111111111111"

	frames, cancelSub := hub.Subscribe(session)
	defer cancelSub()
	rec := &flushRecorder{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		streamFrames(ctx, rec, rec, frames, nil)
	}()

	if err := hub.PutFrame(session, live.Frame{Bytes: []byte("live"), Width: 640, Height: 480}); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}

	deadline := time.After(2 * time.Second)
	for !strings.Contains(rec.body(), "event: frame\n") {
		select {
		case <-deadline:
			t.Fatalf("frame never reached the viewer:\n%s", rec.body())
		case <-time.After(10 * time.Millisecond):
		}
	}

	hub.DropSession(session)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ending the session did not close the viewer's stream")
	}
	if !strings.Contains(rec.body(), "event: end\n") {
		t.Fatalf("viewer was not told the session ended:\n%s", rec.body())
	}
}
