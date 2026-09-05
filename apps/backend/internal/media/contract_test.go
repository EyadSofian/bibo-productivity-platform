package media_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"ctracking/backend/internal/media"
	"ctracking/backend/internal/media/mediafake"
)

// Compile-time proof that both implementations satisfy the contracts. Without
// this, a signature drift is only caught wherever they happen to be wired up.
var (
	_ media.MediaProvider  = (*media.Unconfigured)(nil)
	_ media.MediaProvider  = (*mediafake.Provider)(nil)
	_ media.RecordingStore = (*media.UnconfiguredStore)(nil)
)

// providers runs the shared contract against every implementation, so a future
// LiveKit provider is held to the same rules by adding one line here.
func providers() map[string]media.MediaProvider {
	return map[string]media.MediaProvider{
		"fake": mediafake.New(),
	}
}

// The single most important scope rule: a viewer token can never publish. A
// viewer who could publish could inject video into a monitoring session.
func TestSubscriberTokenNeverGrantsPublish(t *testing.T) {
	for name, p := range providers() {
		t.Run(name, func(t *testing.T) {
			tok, err := p.MintSubscriberToken(context.Background(), media.SubscriberTokenRequest{
				Room: "room-1", Identity: "viewer-1", TTL: time.Minute,
			})
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			if tok.CanPublish {
				t.Error("subscriber token grants publish")
			}
			if !tok.CanSubscribe {
				t.Error("subscriber token does not grant subscribe")
			}
		})
	}
}

// The mirror rule: a publisher token is for the agent, and subscribing is not
// part of what an agent needs.
func TestPublisherTokenIsPublishOnlyAndScoped(t *testing.T) {
	for name, p := range providers() {
		t.Run(name, func(t *testing.T) {
			tok, err := p.MintPublisherToken(context.Background(), media.PublisherTokenRequest{
				Room: "room-1", Identity: "device-1", TTL: time.Minute,
				Sources: []media.TrackSource{media.SourceScreen},
			})
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			if !tok.CanPublish {
				t.Error("publisher token does not grant publish")
			}
			if tok.CanSubscribe {
				t.Error("publisher token grants subscribe")
			}
		})
	}
}

// A token with no sources would be a token that can publish anything.
func TestPublisherTokenRequiresExplicitSources(t *testing.T) {
	for name, p := range providers() {
		t.Run(name, func(t *testing.T) {
			_, err := p.MintPublisherToken(context.Background(), media.PublisherTokenRequest{
				Room: "room-1", Identity: "device-1", TTL: time.Minute,
			})
			if err == nil {
				t.Error("minted a publisher token with no sources")
			}
		})
	}
}

// A token with no expiry is a permanent credential.
func TestTokensAlwaysExpire(t *testing.T) {
	for name, p := range providers() {
		t.Run(name, func(t *testing.T) {
			for _, ttl := range []time.Duration{0, -time.Minute} {
				if _, err := p.MintSubscriberToken(context.Background(), media.SubscriberTokenRequest{
					Room: "r", Identity: "v", TTL: ttl,
				}); err == nil {
					t.Errorf("minted a subscriber token with TTL %v", ttl)
				}
				if _, err := p.MintPublisherToken(context.Background(), media.PublisherTokenRequest{
					Room: "r", Identity: "d", TTL: ttl,
					Sources: []media.TrackSource{media.SourceScreen},
				}); err == nil {
					t.Errorf("minted a publisher token with TTL %v", ttl)
				}
			}

			tok, err := p.MintSubscriberToken(context.Background(), media.SubscriberTokenRequest{
				Room: "r", Identity: "v", TTL: 90 * time.Second,
			})
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			if !tok.ExpiresAt.After(time.Now().Add(-time.Hour)) || tok.ExpiresAt.IsZero() {
				t.Errorf("ExpiresAt = %v, want a real expiry", tok.ExpiresAt)
			}
		})
	}
}

// Until an SFU is wired up (V05) every operation must fail loudly, and with a
// typed error the handlers can turn into a specific message.
func TestUnconfiguredProviderFailsLoudly(t *testing.T) {
	p := media.NewUnconfigured()
	ctx := context.Background()

	if _, err := p.CreateRoom(ctx, media.RoomSpec{Name: "r"}); !errors.Is(err, media.ErrProviderUnconfigured) {
		t.Errorf("CreateRoom err = %v, want ErrProviderUnconfigured", err)
	}
	if _, err := p.MintSubscriberToken(ctx, media.SubscriberTokenRequest{Room: "r", TTL: time.Minute}); !errors.Is(err, media.ErrProviderUnconfigured) {
		t.Errorf("MintSubscriberToken err = %v, want ErrProviderUnconfigured", err)
	}
	if _, err := p.MintPublisherToken(ctx, media.PublisherTokenRequest{Room: "r", TTL: time.Minute}); !errors.Is(err, media.ErrProviderUnconfigured) {
		t.Errorf("MintPublisherToken err = %v, want ErrProviderUnconfigured", err)
	}

	// EndRoom is the exception: no room exists, so the desired state already
	// holds and teardown must not be blocked by the absence of a provider.
	if err := p.EndRoom(ctx, "r"); err != nil {
		t.Errorf("EndRoom err = %v, want nil so session teardown still works", err)
	}
}
