package s3store

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPrivateBucketRoundTrip(t *testing.T) {
	if os.Getenv("RECORDING_S3_INTEGRATION_TEST") != "1" {
		t.Skip("set RECORDING_S3_INTEGRATION_TEST=1 to test a private S3 bucket")
	}
	s, err := New(Config{
		Endpoint: os.Getenv("RECORDING_S3_ENDPOINT"), Bucket: os.Getenv("RECORDING_S3_BUCKET"),
		Region: os.Getenv("RECORDING_S3_REGION"), AccessKey: os.Getenv("RECORDING_S3_ACCESS_KEY"),
		SecretKey: os.Getenv("RECORDING_S3_SECRET_KEY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	key := "integration/" + time.Now().UTC().Format("20060102T150405.000000000") + "/probe.mp4"
	payload := []byte("private-recording-storage-probe")
	putURL, _, err := s.presign(http.MethodPut, key, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPut, putURL, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNoContent {
		t.Fatalf("private upload returned HTTP %d", res.StatusCode)
	}
	defer func() { _ = s.DeleteAsset(context.Background(), key) }()

	verification, err := s.VerifyAsset(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	if !verification.Exists || verification.ByteSize != int64(len(payload)) {
		t.Fatalf("verification = %#v", verification)
	}
	signed, err := s.SignManifest(context.Background(), key, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	get, err := s.http.Get(signed.ManifestURL)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(get.Body)
	get.Body.Close()
	if readErr != nil || get.StatusCode != http.StatusOK || !strings.EqualFold(string(got), string(payload)) {
		t.Fatalf("private playback round trip failed: status=%d body=%q err=%v", get.StatusCode, got, readErr)
	}
}
