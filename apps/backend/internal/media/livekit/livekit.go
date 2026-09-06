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

type Config struct {
	URL, APIKey, APISecret                                   string
	S3Endpoint, S3Bucket, S3Region, S3AccessKey, S3SecretKey string
	S3ForcePathStyle                                         bool
}
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

func (p *Provider) callService(ctx context.Context, service, method string, grant map[string]any, input, output any) error {
	tok, err := p.sign("backend-control-plane", 30*time.Second, grant)
	if err != nil {
		return err
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	base := strings.Replace(strings.Replace(p.cfg.URL, "wss://", "https://", 1), "ws://", "http://", 1)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/twirp/livekit."+service+"/"+method, bytes.NewReader(body))
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
	if res.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		return media.ErrRoomNotFound
	}
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		return fmt.Errorf("livekit: %s returned HTTP %d", method, res.StatusCode)
	}
	if output != nil {
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(output); err != nil {
			return fmt.Errorf("livekit: decode %s response: %w", method, err)
		}
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	}
	return nil
}

func (p *Provider) call(ctx context.Context, method string, grant map[string]any, input any) error {
	return p.callService(ctx, "RoomService", method, grant, input, nil)
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

func (p *Provider) StartRecording(ctx context.Context, req media.RecordingRequest) (media.RecordingJob, error) {
	if req.Room == "" || req.ParticipantIdentity == "" || req.AssetID == "" || req.ObjectKey == "" {
		return media.RecordingJob{}, errors.New("livekit: incomplete recording request")
	}
	if p.cfg.S3Endpoint == "" || p.cfg.S3Bucket == "" || p.cfg.S3AccessKey == "" || p.cfg.S3SecretKey == "" {
		return media.RecordingJob{}, media.ErrProviderUnconfigured
	}
	region := p.cfg.S3Region
	if region == "" {
		region = "auto"
	}
	input := map[string]any{
		"room_name": req.Room,
		"media": map[string]any{"participant_video": map[string]any{
			"identity": req.ParticipantIdentity, "prefer_screen_share": true,
		}},
		"outputs": []any{map[string]any{"file": map[string]any{
			"file_type": "MP4", "filepath": req.ObjectKey,
		}}},
		"storage": map[string]any{"s3": map[string]any{
			"access_key":       p.cfg.S3AccessKey,
			"secret":           p.cfg.S3SecretKey,
			"region":           region,
			"endpoint":         p.cfg.S3Endpoint,
			"bucket":           p.cfg.S3Bucket,
			"force_path_style": p.cfg.S3ForcePathStyle,
		}},
	}
	var out struct {
		EgressID string `json:"egress_id"`
	}
	if err := p.callService(ctx, "Egress", "StartEgress", map[string]any{"roomRecord": true}, input, &out); err != nil {
		return media.RecordingJob{}, err
	}
	if out.EgressID == "" {
		return media.RecordingJob{}, errors.New("livekit: egress response has no id")
	}
	return media.RecordingJob{ID: out.EgressID, StartedAt: time.Now().UTC()}, nil
}
func (p *Provider) StopRecording(ctx context.Context, recordingID string) error {
	if recordingID == "" {
		return errors.New("livekit: recording id required")
	}
	var out map[string]any
	return p.callService(ctx, "Egress", "StopEgress", map[string]any{"roomRecord": true}, map[string]any{"egress_id": recordingID}, &out)
}

var _ media.MediaProvider = (*Provider)(nil)
