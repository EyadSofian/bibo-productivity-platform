package s3store

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSignedPlaybackUsesShortLivedSigV4URL(t *testing.T) {
	s, err := New(Config{
		Endpoint: "https://storage.example.test", Bucket: "private-recordings",
		Region: "auto", AccessKey: "access-key", SecretKey: "secret-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC) }
	signed, err := s.SignManifest(context.Background(), "tenant/a/session/b/screen.mp4", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(signed.ManifestURL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "private-recordings.storage.example.test" || u.Path != "/tenant/a/session/b/screen.mp4" {
		t.Fatalf("unexpected private object address: %s%s", u.Host, u.Path)
	}
	q := u.Query()
	if q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" || q.Get("X-Amz-Expires") != "300" || q.Get("X-Amz-Signature") == "" {
		t.Fatalf("missing SigV4 playback scope: %v", q)
	}
	if strings.Contains(signed.ManifestURL, "secret-key") {
		t.Fatal("secret key leaked into signed playback URL")
	}
	if !signed.ExpiresAt.Equal(s.now().Add(5 * time.Minute)) {
		t.Fatalf("expiry = %v", signed.ExpiresAt)
	}
}

func TestSignedPlaybackRejectsObjectTraversal(t *testing.T) {
	s, err := New(Config{
		Endpoint: "https://storage.example.test", Bucket: "private-recordings",
		AccessKey: "access-key", SecretKey: "secret-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SignManifest(context.Background(), "../other-tenant/video.mp4", time.Minute); err == nil {
		t.Fatal("accepted a traversing object key")
	}
}
