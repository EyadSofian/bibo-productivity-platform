// Package live holds ephemeral, in-process state for live screen sessions.
//
// Live frames are transient by design: only the newest frame of a session is
// ever read, and a session lives for minutes. Storing them in Postgres cost
// 12-36 MB of dead TOAST and ~65 KiB of WAL per frame (see
// docs/FULL_SYSTEM_AUDIT.md §3.3) for data that is never queried, never backed
// up on purpose, and discarded within seconds.
//
// The hub keeps the newest frame per session in memory behind a TTL and fans it
// out to subscribers. Authorization is NOT done here: callers must have already
// checked, against Postgres, that the session exists, is active, and belongs to
// the caller. The hub is a cache and a bus, never a permission boundary.
//
// Scope: this is per-process state. It is correct for a single backend
// instance, which is the current Railway deployment. The Store interface below
// is the seam a Redis-backed implementation slots into when the backend scales
// out; see docs/adr/0001-ephemeral-live-frames.md.
package live

import (
	"sync"
	"time"
)

// Frame is one ephemeral screen frame.
type Frame struct {
	Bytes      []byte
	Width      int
	Height     int
	ReceivedAt time.Time
}

// Frames from two different sources share the hub, so keys are namespaced
// rather than raw UUIDs: a remote-assistance session and a device live view are
// different streams with different authorization rules, and must never alias
// each other even if their identifiers ever collide.

// SessionKey addresses the frames of a remote-assistance session.
func SessionKey(sessionID string) string { return "session:" + sessionID }

// DeviceKey addresses the frames of a device's live view.
func DeviceKey(deviceID string) string { return "device:" + deviceID }

// Store is the seam between the live frame path and its backing store. The
// in-process Hub implements it today; a Redis implementation implements it
// when the backend runs more than one instance.
type Store interface {
	PutFrame(sessionID string, frame Frame) error
	Frame(sessionID string) (Frame, bool)
	DropSession(sessionID string)
}

const (
	// defaultTTL is how long a frame stays servable. Well above the agent's
	// ~900ms capture interval, short enough that a dead session's memory is
	// reclaimed promptly.
	defaultTTL = 30 * time.Second
	// defaultMaxSessions bounds total memory: 256 KiB max per frame
	// (maxRemoteFrameBytes) x 64 = 16 MiB worst case.
	defaultMaxSessions = 64
)

type entry struct {
	frame Frame
	subs  map[int]chan Frame
	// persistedAt is the last time the caller was told to write this
	// session's progress to Postgres. It keeps the durable bookkeeping write
	// off the per-frame path.
	persistedAt time.Time
}

// Hub is an in-process implementation of Store with subscriber fan-out.
type Hub struct {
	mu          sync.Mutex
	ttl         time.Duration
	maxSessions int
	now         func() time.Time
	sessions    map[string]*entry
	nextSub     int
}

// NewHub builds a hub with the default TTL and session cap.
func NewHub() *Hub {
	return newHub(defaultTTL, defaultMaxSessions, time.Now)
}

// newHub is the injectable constructor used by tests.
func newHub(ttl time.Duration, maxSessions int, now func() time.Time) *Hub {
	return &Hub{
		ttl:         ttl,
		maxSessions: maxSessions,
		now:         now,
		sessions:    make(map[string]*entry),
	}
}

// entryLocked returns the session entry, creating it if needed. The caller
// holds the lock.
func (h *Hub) entryLocked(sessionID string) *entry {
	if e, ok := h.sessions[sessionID]; ok {
		return e
	}
	e := &entry{subs: make(map[int]chan Frame)}
	h.sessions[sessionID] = e
	return e
}

// PutFrame stores frame as the newest for sessionID and notifies subscribers.
// It never blocks on a slow subscriber: a subscriber that has not drained its
// previous frame has it replaced, so viewers always get the newest frame and a
// stalled viewer can never back-pressure the uploading agent.
func (h *Hub) PutFrame(sessionID string, frame Frame) error {
	if frame.ReceivedAt.IsZero() {
		frame.ReceivedAt = h.now()
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	h.evictExpiredLocked()
	if _, known := h.sessions[sessionID]; !known {
		h.evictOverflowLocked()
	}

	e := h.entryLocked(sessionID)
	e.frame = frame
	for _, ch := range e.subs {
		select {
		case ch <- frame:
		default:
			// Drop the stale frame this subscriber never read, then hand it
			// the newest one. Both operations are non-blocking.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- frame:
			default:
			}
		}
	}
	return nil
}

// Frame returns the newest unexpired frame for sessionID.
func (h *Hub) Frame(sessionID string) (Frame, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e, ok := h.sessions[sessionID]
	if !ok || e.frame.Bytes == nil || h.expiredLocked(e.frame) {
		return Frame{}, false
	}
	return e.frame, true
}

// Subscribe returns a channel carrying newest-frame notifications for
// sessionID, and a cancel function that must be called to release it. The
// channel is closed by cancel; callers must not close it themselves.
func (h *Hub) Subscribe(sessionID string) (<-chan Frame, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	e := h.entryLocked(sessionID)
	id := h.nextSub
	h.nextSub++
	ch := make(chan Frame, 1)
	e.subs[id] = ch

	// Seed the subscriber with the current frame so a viewer that attaches
	// mid-session renders immediately instead of waiting for the next capture.
	if e.frame.Bytes != nil && !h.expiredLocked(e.frame) {
		ch <- e.frame
	}

	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		sess, ok := h.sessions[sessionID]
		if !ok {
			return
		}
		if sub, ok := sess.subs[id]; ok {
			delete(sess.subs, id)
			close(sub)
		}
		h.dropIfIdleLocked(sessionID, sess)
	}
}

// Subscribers reports how many viewers are attached to sessionID. The agent
// uses this, via the session status, to stop capturing when nobody is watching.
func (h *Hub) Subscribers(sessionID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	e, ok := h.sessions[sessionID]
	if !ok {
		return 0
	}
	return len(e.subs)
}

// DropSession discards a session's frame and closes its subscribers. Called
// when a session ends so viewers see the stream close instead of hanging.
func (h *Hub) DropSession(sessionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	e, ok := h.sessions[sessionID]
	if !ok {
		return
	}
	for id, ch := range e.subs {
		delete(e.subs, id)
		close(ch)
	}
	delete(h.sessions, sessionID)
}

// Sessions reports how many sessions the hub is holding. Exposed for metrics
// and tests.
func (h *Hub) Sessions() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.sessions)
}

// Sweep discards expired frames and sessions nothing references. Safe to call
// from a ticker.
func (h *Hub) Sweep() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.evictExpiredLocked()
}

// ShouldPersist reports whether the caller should write this session's
// progress to Postgres now, allowing at most one write per interval. It exists
// so durable bookkeeping (last_frame_at) does not ride along with every frame:
// at 1.1 FPS with a 10s interval that is ~11x fewer writes.
func (h *Hub) ShouldPersist(sessionID string, interval time.Duration) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	e, ok := h.sessions[sessionID]
	if !ok {
		return false
	}
	now := h.now()
	if !e.persistedAt.IsZero() && now.Sub(e.persistedAt) < interval {
		return false
	}
	e.persistedAt = now
	return true
}

func (h *Hub) expiredLocked(f Frame) bool {
	return h.now().Sub(f.ReceivedAt) > h.ttl
}

// dropIfIdleLocked removes a session that holds neither a frame nor a
// subscriber, so Subscribe on an unknown session cannot leak an empty entry.
func (h *Hub) dropIfIdleLocked(sessionID string, e *entry) {
	if len(e.subs) == 0 && e.frame.Bytes == nil {
		delete(h.sessions, sessionID)
	}
}

// evictExpiredLocked clears frames past their TTL. A session with live
// subscribers keeps its entry (so the viewer stays attached for the next
// frame); only the stale bytes are released.
func (h *Hub) evictExpiredLocked() {
	for id, e := range h.sessions {
		if e.frame.Bytes != nil && h.expiredLocked(e.frame) {
			e.frame = Frame{}
		}
		h.dropIfIdleLocked(id, e)
	}
}

// evictOverflowLocked makes room for a new session by dropping the one with
// the oldest frame, preferring sessions no viewer is attached to.
func (h *Hub) evictOverflowLocked() {
	for len(h.sessions) >= h.maxSessions {
		var oldestID string
		var oldestAt time.Time
		for id, e := range h.sessions {
			if len(e.subs) > 0 {
				continue
			}
			if oldestID == "" || e.frame.ReceivedAt.Before(oldestAt) {
				oldestID, oldestAt = id, e.frame.ReceivedAt
			}
		}
		if oldestID == "" {
			// Every session has a viewer; evict the globally oldest so the
			// cap still holds.
			for id, e := range h.sessions {
				if oldestID == "" || e.frame.ReceivedAt.Before(oldestAt) {
					oldestID, oldestAt = id, e.frame.ReceivedAt
				}
			}
		}
		if oldestID == "" {
			return
		}
		e := h.sessions[oldestID]
		for id, ch := range e.subs {
			delete(e.subs, id)
			close(ch)
		}
		delete(h.sessions, oldestID)
	}
}
