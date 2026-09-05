package livekit

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ctracking/backend/internal/media"
	"github.com/golang-jwt/jwt/v5"
)

func testProvider(t *testing.T, address string) *Provider {
	t.Helper()
	p, err := New(Config{URL: address, APIKey: "test-key", APISecret: "test-secret"})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestScopedTokens(t *testing.T) {
	p := testProvider(t, "wss://media.example.test")
	for _, publisher := range []bool{false, true} {
		var token media.Token
		var err error
		if publisher {
			token, err = p.MintPublisherToken(context.Background(), media.PublisherTokenRequest{Room: "opaque-room", Identity: "device", TTL: 120 * time.Second, Sources: []media.TrackSource{media.SourceScreen}})
		} else {
			token, err = p.MintSubscriberToken(context.Background(), media.SubscriberTokenRequest{Room: "opaque-room", Identity: "viewer", TTL: 120 * time.Second})
		}
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := jwt.Parse(token.Value, func(*jwt.Token) (any, error) { return []byte("test-secret"), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("test-key"))
		if err != nil {
			t.Fatal(err)
		}
		claims := parsed.Claims.(jwt.MapClaims)
		grant := claims["video"].(map[string]any)
		if grant["room"] != "opaque-room" || grant["canPublish"] != publisher || grant["canSubscribe"] != !publisher || grant["canPublishData"] != false {
			t.Fatal("token grants exceed role scope")
		}
		if publisher {
			sources := grant["canPublishSources"].([]any)
			if len(sources) != 1 || sources[0] != "screen_share" {
				t.Fatal("publisher not limited to screen")
			}
		}
		if token.CanPublish != publisher || token.CanSubscribe != !publisher || token.URL != p.cfg.URL {
			t.Fatal("token metadata does not match credential")
		}
	}
}

func TestRefusesAudioAndExcessiveTTL(t *testing.T) {
	p := testProvider(t, "wss://media.example.test")
	for _, sources := range [][]media.TrackSource{nil, {media.SourceAudio}} {
		if _, err := p.MintPublisherToken(context.Background(), media.PublisherTokenRequest{Room: "r", Identity: "d", TTL: time.Minute, Sources: sources}); err == nil {
			t.Fatal("invalid source accepted")
		}
	}
	if _, err := p.MintSubscriberToken(context.Background(), media.SubscriberTokenRequest{Room: "r", Identity: "v", TTL: time.Hour}); err == nil {
		t.Fatal("excessive lifetime accepted")
	}
}

func TestRoomCallsAndRedactedErrors(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/twirp/livekit.RoomService/") || r.Header.Get("Authorization") == "" {
			t.Error("invalid provider request")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"msg":"private screen content and secrets"}`))
	}))
	defer srv.Close()
	p := testProvider(t, strings.Replace(srv.URL, "http://", "ws://", 1))
	if _, err := p.CreateRoom(context.Background(), media.RoomSpec{Name: "r", MaxPublishers: 1, EmptyTimeout: time.Minute}); err != nil {
		t.Fatal(err)
	}
	status = http.StatusNotFound
	if err := p.EndRoom(context.Background(), "r"); !errors.Is(err, media.ErrRoomNotFound) {
		t.Fatalf("expected missing room, got %v", err)
	}
	status = http.StatusInternalServerError
	if err := p.EndRoom(context.Background(), "r"); err == nil || strings.Contains(err.Error(), "secrets") {
		t.Fatal("provider error absent or leaked server payload")
	}
}

func TestRejectsUnsafeServerURLs(t *testing.T) {
	for _, address := range []string{"ws://remote.example.test", "wss://user:password@host.test", "wss://host.test?secret=x", "file:///tmp/media"} {
		if _, err := New(Config{URL: address, APIKey: "k", APISecret: "s"}); err == nil {
			t.Fatalf("accepted unsafe URL %q", address)
		}
	}
}
