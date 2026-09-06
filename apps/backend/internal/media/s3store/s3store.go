// Package s3store provides private object playback for S3-compatible storage.
package s3store

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"ctracking/backend/internal/media"
)

type Config struct {
	Endpoint, Bucket, Region, AccessKey, SecretKey string
	ForcePathStyle                                 bool
}

type Store struct {
	cfg  Config
	http *http.Client
	now  func() time.Time
}

func New(cfg Config) (*Store, error) {
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil ||
		cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, media.ErrProviderUnconfigured
	}
	if cfg.Region == "" {
		cfg.Region = "auto"
	}
	cfg.Endpoint = strings.TrimRight(cfg.Endpoint, "/")
	return &Store{cfg: cfg, http: &http.Client{Timeout: 15 * time.Second}, now: time.Now}, nil
}

func (s *Store) objectURL(key string) (*url.URL, error) {
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "..") || strings.ContainsRune(key, '\\') {
		return nil, errors.New("s3store: invalid object key")
	}
	base, _ := url.Parse(s.cfg.Endpoint)
	if s.cfg.ForcePathStyle {
		base.Path = path.Join(base.Path, s.cfg.Bucket, key)
	} else {
		base.Host = s.cfg.Bucket + "." + base.Host
		base.Path = "/" + key
	}
	return base, nil
}

func hmacSHA256(key []byte, value string) []byte {
	m := hmac.New(sha256.New, key)
	_, _ = m.Write([]byte(value))
	return m.Sum(nil)
}

func (s *Store) presign(method, key string, ttl time.Duration) (string, time.Time, error) {
	if ttl < time.Second || ttl > 15*time.Minute {
		return "", time.Time{}, errors.New("s3store: invalid playback ttl")
	}
	u, err := s.objectURL(key)
	if err != nil {
		return "", time.Time{}, err
	}
	now := s.now().UTC()
	date := now.Format("20060102")
	scope := date + "/" + s.cfg.Region + "/s3/aws4_request"
	q := u.Query()
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", s.cfg.AccessKey+"/"+scope)
	q.Set("X-Amz-Date", now.Format("20060102T150405Z"))
	q.Set("X-Amz-Expires", strconv.FormatInt(int64(ttl/time.Second), 10))
	q.Set("X-Amz-SignedHeaders", "host")
	u.RawQuery = q.Encode()
	canonical := method + "\n" + u.EscapedPath() + "\n" + u.RawQuery + "\nhost:" + u.Host + "\n\nhost\nUNSIGNED-PAYLOAD"
	h := sha256.Sum256([]byte(canonical))
	toSign := "AWS4-HMAC-SHA256\n" + now.Format("20060102T150405Z") + "\n" + scope + "\n" + hex.EncodeToString(h[:])
	kDate := hmacSHA256([]byte("AWS4"+s.cfg.SecretKey), date)
	kRegion := hmacSHA256(kDate, s.cfg.Region)
	kService := hmacSHA256(kRegion, "s3")
	kSigning := hmacSHA256(kService, "aws4_request")
	q.Set("X-Amz-Signature", hex.EncodeToString(hmacSHA256(kSigning, toSign)))
	u.RawQuery = q.Encode()
	return u.String(), now.Add(ttl), nil
}

// SignManifest signs one MP4 object. The interface retains its historical
// name because HLS may be added later; callers pass the asset's private key.
func (s *Store) SignManifest(_ context.Context, objectKey string, ttl time.Duration) (media.SignedPlayback, error) {
	value, expires, err := s.presign(http.MethodGet, objectKey, ttl)
	return media.SignedPlayback{ManifestURL: value, ExpiresAt: expires}, err
}

func (s *Store) DeleteAsset(ctx context.Context, objectKey string) error {
	value, _, err := s.presign(http.MethodDelete, objectKey, time.Minute)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, value, nil)
	if err != nil {
		return err
	}
	res, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
		return fmt.Errorf("s3store: delete returned HTTP %d", res.StatusCode)
	}
	return nil
}

func (s *Store) VerifyAsset(ctx context.Context, objectKey string) (media.AssetVerification, error) {
	value, _, err := s.presign(http.MethodHead, objectKey, time.Minute)
	if err != nil {
		return media.AssetVerification{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, value, nil)
	if err != nil {
		return media.AssetVerification{}, err
	}
	res, err := s.http.Do(req)
	if err != nil {
		return media.AssetVerification{}, err
	}
	res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return media.AssetVerification{Exists: false}, nil
	}
	if res.StatusCode != http.StatusOK {
		return media.AssetVerification{}, fmt.Errorf("s3store: head returned HTTP %d", res.StatusCode)
	}
	return media.AssetVerification{Exists: true, ByteSize: res.ContentLength}, nil
}

var _ media.RecordingStore = (*Store)(nil)
