package live

import (
	"sync"
	"time"
)

// Command is a hint pushed to an agent telling it to act now instead of waiting
// for its next heartbeat. Commands are an accelerator, never a source of truth:
// every command has a polling path behind it that still works when the stream is
// down, so a lost command costs latency and nothing else.
type Command struct {
	Type string `json:"type"`
	// ExpiresInMs is set on renewable commands (LiveViewActive). The agent stops
	// the associated work when the signal is not renewed within this window.
	ExpiresInMs int64 `json:"expires_in_ms,omitempty"`
}

const (
	// CommandCaptureNow tells the agent a one-shot live frame was requested.
	// The agent responds by heartbeating immediately; the heartbeat's atomic
	// ConsumeLiveCaptureRequest remains what actually authorizes the capture.
	CommandCaptureNow = "capture_now"

	// CommandLiveViewActive is renewed for as long as at least one viewer is
	// attached. It is deliberately a renewal rather than a start/stop pair:
	// if the stream drops, the message is lost, or the backend restarts, the
	// signal simply stops arriving and the agent stops capturing. Capture can
	// only ever be extended by a fresh signal, never left running by a lost one.
	CommandLiveViewActive = "live_view_active"

	// CommandRemoteAssistPending tells the agent a session is awaiting the
	// employee's decision, so the prompt appears without waiting for the poll.
	CommandRemoteAssistPending = "remote_assist_pending"
)

// LiveViewRenewInterval is how often the backend re-sends LiveViewActive while
// viewers are attached. LiveViewTTL is how long the agent honours one signal.
// The TTL is several intervals so a single dropped renewal does not visibly
// stutter the stream, while an abandoned session still stops promptly.
const (
	LiveViewRenewInterval = 5 * time.Second
	LiveViewTTL           = 16 * time.Second
)

// CommandBus fans device-addressed commands out to connected agents. Like the
// frame hub it is per-process and non-blocking; see the package doc.
type CommandBus struct {
	mu      sync.Mutex
	nextSub int
	devices map[string]map[int]chan Command
}

func NewCommandBus() *CommandBus {
	return &CommandBus{devices: make(map[string]map[int]chan Command)}
}

// Publish delivers cmd to every agent connected for deviceID. A slow or wedged
// agent is skipped rather than allowed to block the caller: commands are hints,
// and the agent's polling fallback covers anything it misses.
func (b *CommandBus) Publish(deviceID string, cmd Command) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.devices[deviceID] {
		select {
		case ch <- cmd:
		default:
		}
	}
}

// Subscribe returns a channel of commands for deviceID plus a cancel function
// that must be called to release it.
func (b *CommandBus) Subscribe(deviceID string) (<-chan Command, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subs, ok := b.devices[deviceID]
	if !ok {
		subs = make(map[int]chan Command)
		b.devices[deviceID] = subs
	}
	id := b.nextSub
	b.nextSub++
	// A small buffer absorbs a burst while the agent is mid-write without
	// making the publisher wait.
	ch := make(chan Command, 8)
	subs[id] = ch

	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		devSubs, ok := b.devices[deviceID]
		if !ok {
			return
		}
		if sub, ok := devSubs[id]; ok {
			delete(devSubs, id)
			close(sub)
		}
		if len(devSubs) == 0 {
			delete(b.devices, deviceID)
		}
	}
}

// Connected reports how many agents are listening for deviceID. Used to tell an
// operator "this device is not reachable" instead of silently doing nothing.
func (b *CommandBus) Connected(deviceID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.devices[deviceID])
}

// Devices reports how many devices have at least one connected agent.
func (b *CommandBus) Devices() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.devices)
}
