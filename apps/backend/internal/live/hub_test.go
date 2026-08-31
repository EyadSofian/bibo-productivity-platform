package live

import (
	"sync"
	"testing"
	"time"
)

// fakeClock lets the TTL and eviction paths be tested without sleeping.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newTestHub(ttl time.Duration, max int) (*Hub, *fakeClock) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0).UTC()}
	return newHub(ttl, max, clock.now), clock
}

func frameOf(b byte) Frame {
	return Frame{Bytes: []byte{b}, Width: 100, Height: 50}
}

func TestFrameRoundTripAndUnknownSession(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)

	if _, ok := h.Frame("missing"); ok {
		t.Fatal("unknown session returned a frame")
	}

	if err := h.PutFrame("s1", frameOf(1)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	got, ok := h.Frame("s1")
	if !ok {
		t.Fatal("stored frame not returned")
	}
	if len(got.Bytes) != 1 || got.Bytes[0] != 1 || got.Width != 100 || got.Height != 50 {
		t.Fatalf("frame round-tripped wrong: %+v", got)
	}
	if got.ReceivedAt.IsZero() {
		t.Fatal("ReceivedAt was not stamped")
	}
}

func TestNewestFrameReplacesPrevious(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	for i := byte(1); i <= 5; i++ {
		if err := h.PutFrame("s1", frameOf(i)); err != nil {
			t.Fatalf("PutFrame: %v", err)
		}
	}
	got, ok := h.Frame("s1")
	if !ok {
		t.Fatal("no frame")
	}
	if got.Bytes[0] != 5 {
		t.Fatalf("want newest frame 5, got %d", got.Bytes[0])
	}
	if h.Sessions() != 1 {
		t.Fatalf("want 1 session after 5 frames, got %d", h.Sessions())
	}
}

func TestFrameExpiresAfterTTL(t *testing.T) {
	h, clock := newTestHub(30*time.Second, 8)
	if err := h.PutFrame("s1", frameOf(1)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}

	clock.advance(29 * time.Second)
	if _, ok := h.Frame("s1"); !ok {
		t.Fatal("frame expired before its TTL")
	}

	clock.advance(2 * time.Second)
	if _, ok := h.Frame("s1"); ok {
		t.Fatal("frame served after its TTL")
	}

	// Sweep reclaims the session entirely once nothing references it.
	h.Sweep()
	if h.Sessions() != 0 {
		t.Fatalf("want expired session swept, got %d sessions", h.Sessions())
	}
}

func TestSubscriberReceivesNewFrames(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	ch, cancel := h.Subscribe("s1")
	defer cancel()

	if err := h.PutFrame("s1", frameOf(7)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	select {
	case got := <-ch:
		if got.Bytes[0] != 7 {
			t.Fatalf("want frame 7, got %d", got.Bytes[0])
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber never received the frame")
	}
}

func TestSubscribeSeedsCurrentFrame(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	if err := h.PutFrame("s1", frameOf(3)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}

	// A viewer attaching mid-session must render immediately rather than wait
	// for the agent's next capture.
	ch, cancel := h.Subscribe("s1")
	defer cancel()
	select {
	case got := <-ch:
		if got.Bytes[0] != 3 {
			t.Fatalf("want seeded frame 3, got %d", got.Bytes[0])
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber was not seeded with the current frame")
	}
}

func TestSubscribeDoesNotSeedExpiredFrame(t *testing.T) {
	h, clock := newTestHub(30*time.Second, 8)
	if err := h.PutFrame("s1", frameOf(3)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	clock.advance(31 * time.Second)

	ch, cancel := h.Subscribe("s1")
	defer cancel()
	select {
	case got := <-ch:
		t.Fatalf("stale frame %d was seeded to a new subscriber", got.Bytes[0])
	default:
	}
}

// A viewer that stops reading must never block the agent uploading frames, and
// must receive the newest frame rather than a queue of stale ones.
func TestSlowSubscriberNeverBlocksPublisherAndGetsNewest(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	ch, cancel := h.Subscribe("s1")
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := byte(1); i <= 200; i++ {
			if err := h.PutFrame("s1", frameOf(i)); err != nil {
				t.Errorf("PutFrame: %v", err)
				return
			}
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("publisher blocked on a subscriber that was not reading")
	}

	got := <-ch
	if got.Bytes[0] != 200 {
		t.Fatalf("slow subscriber should hold the newest frame 200, got %d", got.Bytes[0])
	}
}

func TestCancelReleasesSubscriberAndSession(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	ch, cancel := h.Subscribe("s1")
	if h.Subscribers("s1") != 1 {
		t.Fatalf("want 1 subscriber, got %d", h.Subscribers("s1"))
	}

	cancel()
	if _, open := <-ch; open {
		t.Fatal("cancel did not close the subscriber channel")
	}
	if h.Subscribers("s1") != 0 {
		t.Fatalf("want 0 subscribers after cancel, got %d", h.Subscribers("s1"))
	}
	// Subscribing to a session that never carried a frame must not leak an
	// entry once the viewer leaves.
	if h.Sessions() != 0 {
		t.Fatalf("want session reclaimed after cancel, got %d", h.Sessions())
	}
}

func TestCancelIsIdempotent(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	_, cancel := h.Subscribe("s1")
	cancel()
	cancel() // must not panic on a double close
}

func TestMultipleSubscribersEachGetTheFrame(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	chA, cancelA := h.Subscribe("s1")
	defer cancelA()
	chB, cancelB := h.Subscribe("s1")
	defer cancelB()

	if err := h.PutFrame("s1", frameOf(9)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	for name, ch := range map[string]<-chan Frame{"A": chA, "B": chB} {
		select {
		case got := <-ch:
			if got.Bytes[0] != 9 {
				t.Fatalf("viewer %s got frame %d, want 9", name, got.Bytes[0])
			}
		case <-time.After(time.Second):
			t.Fatalf("viewer %s never received the frame", name)
		}
	}
}

func TestDropSessionClosesSubscribers(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	ch, cancel := h.Subscribe("s1")
	defer cancel()
	if err := h.PutFrame("s1", frameOf(1)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	<-ch // drain the published frame

	h.DropSession("s1")
	if _, open := <-ch; open {
		t.Fatal("ending a session must close its viewers")
	}
	if _, ok := h.Frame("s1"); ok {
		t.Fatal("frame served after the session was dropped")
	}
	if h.Sessions() != 0 {
		t.Fatalf("want 0 sessions after drop, got %d", h.Sessions())
	}
}

// Sessions are capped so a burst of sessions cannot grow memory without bound.
func TestSessionCapEvictsUnwatchedSessionsFirst(t *testing.T) {
	h, clock := newTestHub(time.Hour, 3)

	if err := h.PutFrame("watched", frameOf(1)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	_, cancel := h.Subscribe("watched")
	defer cancel()

	clock.advance(time.Second)
	if err := h.PutFrame("idle-old", frameOf(2)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	clock.advance(time.Second)
	if err := h.PutFrame("idle-new", frameOf(3)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}

	clock.advance(time.Second)
	if err := h.PutFrame("fresh", frameOf(4)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}

	if h.Sessions() > 3 {
		t.Fatalf("session cap exceeded: %d sessions", h.Sessions())
	}
	if _, ok := h.Frame("watched"); !ok {
		t.Fatal("a session with an attached viewer was evicted first")
	}
	if _, ok := h.Frame("idle-old"); ok {
		t.Fatal("oldest unwatched session should have been evicted")
	}
	if _, ok := h.Frame("fresh"); !ok {
		t.Fatal("newly stored frame is missing")
	}
}

// Guards the ordering invariant the SSE handler depends on: publishing while
// viewers attach and detach must not race or deadlock.
func TestConcurrentPublishAndSubscribe(t *testing.T) {
	h, _ := newTestHub(time.Minute, 32)

	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := byte(0); i < 50; i++ {
				if err := h.PutFrame("s1", frameOf(i)); err != nil {
					t.Errorf("PutFrame: %v", err)
					return
				}
			}
		}()
	}
	for v := 0; v < 8; v++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				ch, cancel := h.Subscribe("s1")
				select {
				case <-ch:
				default:
				}
				cancel()
			}
		}()
	}
	wg.Wait()

	if got := h.Subscribers("s1"); got != 0 {
		t.Fatalf("subscribers leaked: %d still attached", got)
	}
}

func TestShouldPersistThrottlesDurableWrites(t *testing.T) {
	h, clock := newTestHub(time.Minute, 8)

	// An unknown session never triggers a write.
	if h.ShouldPersist("missing", 10*time.Second) {
		t.Fatal("unknown session asked for a durable write")
	}

	if err := h.PutFrame("s1", frameOf(1)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	if !h.ShouldPersist("s1", 10*time.Second) {
		t.Fatal("first frame should trigger a durable write")
	}
	// Every frame inside the interval is served from memory only.
	for i := 0; i < 11; i++ {
		clock.advance(900 * time.Millisecond)
		if err := h.PutFrame("s1", frameOf(byte(i))); err != nil {
			t.Fatalf("PutFrame: %v", err)
		}
		if h.ShouldPersist("s1", 10*time.Second) && i < 10 {
			t.Fatalf("durable write at frame %d, inside the throttle interval", i)
		}
	}
	clock.advance(10 * time.Second)
	if !h.ShouldPersist("s1", 10*time.Second) {
		t.Fatal("durable write never resumed after the interval elapsed")
	}
}

func TestKeysAreNamespacedSoStreamsCannotAlias(t *testing.T) {
	h, _ := newTestHub(time.Minute, 8)
	const id = "11111111-1111-1111-1111-111111111111"

	// The same UUID used as a session and as a device must address two
	// independent streams: they carry different data under different rules.
	if err := h.PutFrame(SessionKey(id), frameOf(1)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}
	if err := h.PutFrame(DeviceKey(id), frameOf(2)); err != nil {
		t.Fatalf("PutFrame: %v", err)
	}

	session, ok := h.Frame(SessionKey(id))
	if !ok || session.Bytes[0] != 1 {
		t.Fatalf("session frame = %#v, ok=%v", session, ok)
	}
	device, ok := h.Frame(DeviceKey(id))
	if !ok || device.Bytes[0] != 2 {
		t.Fatalf("device frame = %#v, ok=%v", device, ok)
	}
	if SessionKey(id) == DeviceKey(id) {
		t.Fatal("session and device keys collide")
	}
}
