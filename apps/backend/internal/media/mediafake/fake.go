// Package mediafake is an in-memory MediaProvider and RecordingStore for tests.
//
// It is a separate package rather than a _test.go file because handler and store
// tests in other packages need it, and because keeping it out of internal/media
// means the production build cannot accidentally depend on it.
//
// The fake is deliberately strict. It records what it was asked for and enforces
// the parts of the contract that a real provider also enforces -- a subscriber
// token never grants publish, a publisher token names its sources, a TTL is
// always set -- so a test that passes against the fake is testing the contract
// rather than the fake's good manners.
package mediafake

import (
	"context"
	"errors"
	"sync"
	"time"

	"ctracking/backend/internal/media"
)

// Provider is an in-memory MediaProvider.
type Provider struct {
	mu sync.Mutex

	// Rooms created, keyed by name.
	Rooms map[string]media.Room
	// EndedRooms names every room EndRoom was called on, in order.
	EndedRooms []string
	// Recordings started, keyed by job id.
	Recordings map[string]media.RecordingRequest
	// StoppedRecordings names every recording StopRecording was called on.
	StoppedRecordings []string

	// FailCreateRoom, when set, is returned by CreateRoom. Lets a test drive the
	// ROOM_FAILED path without inventing a broken provider.
	FailCreateRoom error
	// FailMintToken, when set, is returned by both token minters.
	FailMintToken error

	now  func() time.Time
	seq  int
	name string
}

// New builds a fake provider with a clock fixed for its lifetime, so token
// expiry is assertable through SetNow without tying a newly minted token to a
// date that will eventually be in the past.
func New() *Provider {
	base := time.Now().UTC().Truncate(time.Second)
	return &Provider{
		Rooms:      map[string]media.Room{},
		Recordings: map[string]media.RecordingRequest{},
		now:        func() time.Time { return base },
		name:       "fake",
	}
}

// SetNow overrides the clock, so a test can advance time past a token's expiry.
func (p *Provider) SetNow(fn func() time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.now = fn
}

// Now reports the fake's current time.
func (p *Provider) Now() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.now()
}

func (p *Provider) Name() string { return p.name }

func (p *Provider) CreateRoom(_ context.Context, spec media.RoomSpec) (media.Room, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.FailCreateRoom != nil {
		return media.Room{}, p.FailCreateRoom
	}
	if spec.Name == "" {
		return media.Room{}, errors.New("fake: room name is required")
	}
	room := media.Room{Name: spec.Name, CreatedAt: p.now()}
	p.Rooms[spec.Name] = room
	return room, nil
}

func (p *Provider) MintPublisherToken(_ context.Context, req media.PublisherTokenRequest) (media.Token, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.FailMintToken != nil {
		return media.Token{}, p.FailMintToken
	}
	if req.TTL <= 0 {
		return media.Token{}, errors.New("fake: publisher token needs a positive TTL")
	}
	if len(req.Sources) == 0 {
		// A publisher token with no declared sources would be a token that can
		// publish anything. Refuse it here so the mistake surfaces in a test
		// rather than in an SFU.
		return media.Token{}, errors.New("fake: publisher token needs explicit sources")
	}
	p.seq++
	return media.Token{
		Value:        "fake-publisher-token-" + req.Room,
		ExpiresAt:    p.now().Add(req.TTL),
		CanPublish:   true,
		CanSubscribe: false,
	}, nil
}

func (p *Provider) MintSubscriberToken(_ context.Context, req media.SubscriberTokenRequest) (media.Token, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.FailMintToken != nil {
		return media.Token{}, p.FailMintToken
	}
	if req.TTL <= 0 {
		return media.Token{}, errors.New("fake: subscriber token needs a positive TTL")
	}
	p.seq++
	return media.Token{
		Value:        "fake-subscriber-token-" + req.Room,
		ExpiresAt:    p.now().Add(req.TTL),
		CanPublish:   false, // never, by contract
		CanSubscribe: true,
	}, nil
}

func (p *Provider) StartRecording(_ context.Context, req media.RecordingRequest) (media.RecordingJob, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seq++
	id := "fake-recording-" + req.AssetID
	p.Recordings[id] = req
	return media.RecordingJob{ID: id, StartedAt: p.now()}, nil
}

func (p *Provider) StopRecording(_ context.Context, recordingID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.StoppedRecordings = append(p.StoppedRecordings, recordingID)
	return nil
}

func (p *Provider) EndRoom(_ context.Context, roomID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.EndedRooms = append(p.EndedRooms, roomID)
	delete(p.Rooms, roomID)
	return nil
}

// RoomCount reports how many rooms are open.
func (p *Provider) RoomCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.Rooms)
}
