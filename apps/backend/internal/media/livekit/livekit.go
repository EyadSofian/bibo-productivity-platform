// Package livekit adapts the Windows delivery to the existing, tenant-scoped
// media contracts. The API carries credentials and metadata only.
package livekit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"ctracking/backend/internal/media"
	"github.com/golang-jwt/jwt/v5"
)

type Config struct{ URL, APIKey, APISecret string }
type Provider struct {
	cfg  Config
	http *http.Client
}

func New(cfg Config) (*Provider, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || cfg.APIKey == "" || cfg.APISecret == "" {
		return nil, media.ErrProviderUnconfigured
	}
	if u.Scheme != "wss" && !(u.Scheme == "ws" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, errors.New("livekit: use wss, or ws on loopback for local tests")
	}
	cfg.URL = strings.TrimRight(cfg.URL, "/")
	return &Provider{cfg: cfg, http: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (*Provider) Name() string { return "livekit" }

func (p *Provider) sign(identity string, ttl time.Duration, grant map[string]any) (media.Token, error) {
	if identity == "" || ttl < 30*time.Second || ttl > 15*time.Minute {
		return media.Token{}, errors.New("livekit: invalid identity or token lifetime")
	}
	now := time.Now().UTC()
	end := now.Add(ttl)
	claims := jwt.MapClaims{"iss": p.cfg.APIKey, "sub": identity, "iat": now.Unix(), "nbf": now.Add(-5 * time.Second).Unix(), "exp": end.Unix(), "video": grant}
	value, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(p.cfg.APISecret))
	return media.Token{Value: value, URL: p.cfg.URL, ExpiresAt: end, CanPublish: grant["canPublish"] == true, CanSubscribe: grant["canSubscribe"] == true}, err
}

func (p *Provider) MintPublisherToken(_ context.Context, req media.PublisherTokenRequest) (media.Token, error) {
	if req.Room == "" || len(req.Sources) == 0 {
		return media.Token{}, errors.New("livekit: room and screen sources required")
	}
	for _, source := range req.Sources {
		if source != media.SourceScreen && source != media.SourceScreen2 {
			return media.Token{}, errors.New("livekit: only screen publication is supported")
		}
	}
	return p.sign(req.Identity, req.TTL, map[string]any{"room": req.Room, "roomJoin": true, "canPublish": true, "canSubscribe": false, "canPublishData": false, "canPublishSources": []string{"screen_share"}})
}
func (p *Provider) MintSubscriberToken(_ context.Context, req media.SubscriberTokenRequest) (media.Token, error) {
	if req.Room == "" {
		return media.Token{}, errors.New("livekit: room required")
	}
	return p.sign(req.Identity, req.TTL, map[string]any{"room": req.Room, "roomJoin": true, "canPublish": false, "canSubscribe": true, "canPublishData": false})
}

func (p *Provider) call(ctx context.Context, method string, grant map[string]any, input any) error {
	tok, err := p.sign("backend-control-plane", 30*time.Second, grant)
	if err != nil {
		return err
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	base := strings.Replace(strings.Replace(p.cfg.URL, "wss://", "https://", 1), "ws://", "http://", 1)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/twirp/livekit.RoomService/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok.Value)
	res, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("livekit: %s request failed", method)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	if res.StatusCode == http.StatusNotFound {
		return media.ErrRoomNotFound
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("livekit: %s returned HTTP %d", method, res.StatusCode)
	}
	return nil
}
func (p *Provider) CreateRoom(ctx context.Context, spec media.RoomSpec) (media.Room, error) {
	if spec.Name == "" || spec.MaxPublishers != 1 {
		return media.Room{}, errors.New("livekit: one device publisher is required")
	}
	err := p.call(ctx, "CreateRoom", map[string]any{"roomCreate": true}, map[string]any{"name": spec.Name, "empty_timeout": int(spec.EmptyTimeout.Seconds()), "max_participants": 16})
	return media.Room{Name: spec.Name, CreatedAt: time.Now().UTC()}, err
}
func (p *Provider) EndRoom(ctx context.Context, room string) error {
	if room == "" {
		return errors.New("livekit: room required")
	}
	return p.call(ctx, "DeleteRoom", map[string]any{"roomCreate": true, "roomAdmin": true, "room": room}, map[string]any{"room": room})
}

// Recording stays unavailable until private storage and its lifecycle are wired.
// A configured SFU alone must never start an untracked recording.
func (*Provider) StartRecording(context.Context, media.RecordingRequest) (media.RecordingJob, error) {
	return media.RecordingJob{}, media.ErrProviderUnconfigured
}
func (*Provider) StopRecording(context.Context, string) error { return media.ErrProviderUnconfigured }

var _ media.MediaProvider = (*Provider)(nil)
