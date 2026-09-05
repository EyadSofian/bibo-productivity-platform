package media

import (
	"context"
	"time"
)

// Unconfigured is the provider that ships until a real SFU is wired up (slice
// V05). Every operation fails with ErrProviderUnconfigured.
//
// It exists so the control plane is complete and testable before the media plane
// is chosen, and so the failure is loud. The alternatives are worse: a provider
// that pretends to succeed produces sessions that never carry media and cannot
// be diagnosed, and a provider that falls back to still images reintroduces
// exactly what ADR 0002 retired.
type Unconfigured struct{}

// NewUnconfigured builds the placeholder provider.
func NewUnconfigured() *Unconfigured { return &Unconfigured{} }

func (*Unconfigured) Name() string { return "unconfigured" }

func (*Unconfigured) CreateRoom(context.Context, RoomSpec) (Room, error) {
	return Room{}, ErrProviderUnconfigured
}

func (*Unconfigured) MintPublisherToken(context.Context, PublisherTokenRequest) (Token, error) {
	return Token{}, ErrProviderUnconfigured
}

func (*Unconfigured) MintSubscriberToken(context.Context, SubscriberTokenRequest) (Token, error) {
	return Token{}, ErrProviderUnconfigured
}

func (*Unconfigured) StartRecording(context.Context, RecordingRequest) (RecordingJob, error) {
	return RecordingJob{}, ErrProviderUnconfigured
}

func (*Unconfigured) StopRecording(context.Context, string) error {
	return ErrProviderUnconfigured
}

func (*Unconfigured) EndRoom(context.Context, string) error {
	// Ending a room on a provider that was never configured is not a failure
	// the caller should have to special-case: no room was ever created, so the
	// desired state already holds. Session teardown must not be blocked by the
	// absence of an SFU.
	return nil
}

// UnconfiguredStore is the RecordingStore counterpart. Same reasoning: no object
// storage is configured until slice V08, and pretending otherwise would produce
// playback URLs that resolve to nothing.
type UnconfiguredStore struct{}

// NewUnconfiguredStore builds the placeholder recording store.
func NewUnconfiguredStore() *UnconfiguredStore { return &UnconfiguredStore{} }

func (*UnconfiguredStore) SignManifest(context.Context, string, time.Duration) (SignedPlayback, error) {
	return SignedPlayback{}, ErrProviderUnconfigured
}

func (*UnconfiguredStore) DeleteAsset(context.Context, string) error {
	return ErrProviderUnconfigured
}

func (*UnconfiguredStore) VerifyAsset(context.Context, string) (AssetVerification, error) {
	return AssetVerification{}, ErrProviderUnconfigured
}
