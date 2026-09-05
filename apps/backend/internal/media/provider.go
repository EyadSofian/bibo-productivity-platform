// Package media holds the contracts for the video media plane: who may do what,
// what a session may do next, and the two seams to outside infrastructure.
//
// Nothing in this package talks to a specific vendor. Handlers depend on
// MediaProvider and RecordingStore; a LiveKit or S3 implementation satisfies them
// from its own package. That is not architectural decoration -- it is the reason
// the SFU can be swapped, and the reason CI can exercise every control-plane path
// without a network.
//
// The one rule that outranks the rest: media bytes never pass through this
// process. The Go API authenticates, authorizes, orchestrates, mints short-lived
// tokens, and records what happened. It does not relay frames and is not a TURN
// server (docs/adr/0002-video-first-media-plane.md).
package media

import (
	"context"
	"errors"
	"time"
)

// ErrProviderUnconfigured is returned by the unconfigured provider that ships
// until a real SFU is wired up (slice V05). It is a deliberate, typed failure:
// the alternative -- silently doing nothing, or falling back to still images --
// is what this whole migration exists to remove.
var ErrProviderUnconfigured = errors.New("media provider is not configured")

// ErrRoomNotFound is returned when a room has already been reaped by the
// provider. Ending a session that the provider has forgotten is not an error the
// caller should have to care about, so implementations return this and callers
// treat it as success.
var ErrRoomNotFound = errors.New("media room not found")

// Kind is what a media session is for. A session is one kind for its whole life:
// recording alongside a live view is the same screen track subscribed by a second
// consumer, not a second session.
type Kind string

const (
	KindLive          Kind = "live"
	KindRecording     Kind = "recording"
	KindRemoteControl Kind = "remote_control"
)

// TrackSource identifies a published track. Multi-monitor publishes independent
// tracks; it never composites displays into one oversized frame.
type TrackSource string

const (
	SourceScreen  TrackSource = "screen"
	SourceScreen2 TrackSource = "screen_2"
	SourceAudio   TrackSource = "audio"
)

// RoomSpec describes a room to create. Name is assigned by the caller and is an
// opaque identifier: it must never carry an email, an employee name, a device
// label, or anything else that leaks who is being watched to whoever can see
// provider-side room lists.
type RoomSpec struct {
	Name string
	// EmptyTimeout is how long the provider keeps an empty room before reaping
	// it. It bounds the cost of a session whose participants all vanished.
	EmptyTimeout time.Duration
	// MaxPublishers caps how many participants may publish. Screen capture has
	// exactly one publisher: the agent.
	MaxPublishers int
}

// Room is a created room as the provider sees it.
type Room struct {
	Name      string
	CreatedAt time.Time
}

// PublisherTokenRequest asks for a token that lets one agent publish one
// device's screen tracks into one room, and nothing else.
type PublisherTokenRequest struct {
	Room     string
	Identity string
	TTL      time.Duration
	// Sources the token may publish. An empty slice is a programming error, not
	// "everything": a token that can publish anything is exactly what the scope
	// tests exist to prevent.
	Sources []TrackSource
}

// SubscriberTokenRequest asks for a token that lets one viewer watch one room.
// A subscriber token can never publish; that is asserted by the contract tests
// rather than left to each implementation's good behaviour.
type SubscriberTokenRequest struct {
	Room     string
	Identity string
	TTL      time.Duration
}

// Token is a short-lived credential for the media plane. It is a secret: never
// log it, never store it, never put it in a URL.
type Token struct {
	Value     string
	ExpiresAt time.Time
	// CanPublish and CanSubscribe describe what the value actually grants, so a
	// caller (and a test) can assert scope without decoding a vendor token.
	CanPublish   bool
	CanSubscribe bool
}

// RecordingRequest starts an egress job against a room's screen track.
type RecordingRequest struct {
	Room string
	// AssetID is the caller's identifier for the resulting recording, and is
	// what the object key is derived from.
	AssetID string
	// Prefix is the object-storage key prefix. It is built from tenant, device,
	// date and session ids so a key is never guessable.
	Prefix string
}

// RecordingJob is a started egress job.
type RecordingJob struct {
	ID        string
	StartedAt time.Time
}

// SignedPlayback is a short-lived, signed manifest URL. It is a secret in the
// same sense a token is: it grants access to recorded video for as long as it
// lives, so it is never logged and never persisted.
type SignedPlayback struct {
	ManifestURL string
	ExpiresAt   time.Time
}

// AssetVerification reports what the object store actually holds, which is how
// retention tells "deleted" apart from "we think it is deleted".
type AssetVerification struct {
	Exists   bool
	ByteSize int64
	SHA256   string
}

// MediaProvider is the seam to the SFU. Handlers depend on this and never on a
// vendor SDK.
type MediaProvider interface {
	// Name identifies the implementation for metadata and audit.
	Name() string
	CreateRoom(ctx context.Context, spec RoomSpec) (Room, error)
	MintPublisherToken(ctx context.Context, req PublisherTokenRequest) (Token, error)
	MintSubscriberToken(ctx context.Context, req SubscriberTokenRequest) (Token, error)
	StartRecording(ctx context.Context, req RecordingRequest) (RecordingJob, error)
	StopRecording(ctx context.Context, recordingID string) error
	EndRoom(ctx context.Context, roomID string) error
}

// RecordingStore is the seam to object storage. Video bytes live behind this
// interface; Postgres holds only the metadata that points at them.
type RecordingStore interface {
	SignManifest(ctx context.Context, assetID string, ttl time.Duration) (SignedPlayback, error)
	DeleteAsset(ctx context.Context, assetID string) error
	VerifyAsset(ctx context.Context, assetID string) (AssetVerification, error)
}
