// media-smoke exercises the real provider and browser transport. It never
// captures a user's screen or uses app data. The HTTP harness binds loopback only.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"ctracking/backend/internal/media"
	"ctracking/backend/internal/media/livekit"
	"ctracking/backend/internal/media/s3store"
	"github.com/google/uuid"
)

type smokeRecording struct {
	ID        string
	ObjectKey string
}

func main() {
	assets := flag.String("assets", "../../.media-smoke", "directory containing the smoke-test browser bundle")
	configuredSFU := flag.Bool("configured-sfu", false, "explicitly test the SFU in LIVEKIT_URL/API_KEY/API_SECRET instead of local development")
	flag.Parse()
	cfg := livekit.Config{URL: "ws://127.0.0.1:7880", APIKey: "devkey", APISecret: "secret"}
	if *configuredSFU {
		cfg = livekit.Config{
			URL: os.Getenv("LIVEKIT_URL"), APIKey: os.Getenv("LIVEKIT_API_KEY"), APISecret: os.Getenv("LIVEKIT_API_SECRET"),
			S3Endpoint: os.Getenv("RECORDING_S3_ENDPOINT"), S3Bucket: os.Getenv("RECORDING_S3_BUCKET"),
			S3Region: os.Getenv("RECORDING_S3_REGION"), S3AccessKey: os.Getenv("RECORDING_S3_ACCESS_KEY"),
			S3SecretKey: os.Getenv("RECORDING_S3_SECRET_KEY"),
		}
	}
	p, err := livekit.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	objects, _ := s3store.New(s3store.Config{
		Endpoint: cfg.S3Endpoint, Bucket: cfg.S3Bucket, Region: cfg.S3Region,
		AccessKey: cfg.S3AccessKey, SecretKey: cfg.S3SecretKey,
	})
	var mu sync.Mutex
	rooms := map[string]bool{}
	recordings := map[string]smokeRecording{}
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServer(http.Dir(*assets)))
	mux.HandleFunc("POST /start", func(w http.ResponseWriter, r *http.Request) {
		room := "smoke-" + uuid.NewString()
		if _, err := p.CreateRoom(r.Context(), media.RoomSpec{Name: room, MaxPublishers: 1, EmptyTimeout: 30 * time.Second}); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		publisher, err := p.MintPublisherToken(r.Context(), media.PublisherTokenRequest{Room: room, Identity: "smoke-publisher", TTL: 2 * time.Minute, Sources: []media.TrackSource{media.SourceScreen}})
		if err != nil {
			http.Error(w, "publisher token failed", 500)
			return
		}
		viewer, err := p.MintSubscriberToken(r.Context(), media.SubscriberTokenRequest{Room: room, Identity: "smoke-viewer", TTL: 2 * time.Minute})
		if err != nil {
			http.Error(w, "viewer token failed", 500)
			return
		}
		mu.Lock()
		rooms[room] = true
		mu.Unlock()
		// Bound rooms left by a closed test tab. No credentials are logged.
		time.AfterFunc(2*time.Minute, func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = p.EndRoom(ctx, room)
			mu.Lock()
			delete(rooms, room)
			mu.Unlock()
		})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"url": publisher.URL, "room": room, "publisher": publisher.Value, "viewer": viewer.Value})
	})
	mux.HandleFunc("POST /record", func(w http.ResponseWriter, r *http.Request) {
		if objects == nil {
			http.Error(w, "recording storage is not configured", http.StatusServiceUnavailable)
			return
		}
		var body struct {
			Room string `json:"room"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body) != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		mu.Lock()
		known := rooms[body.Room]
		_, alreadyRecording := recordings[body.Room]
		mu.Unlock()
		if !known || alreadyRecording {
			http.Error(w, "room is not ready to record", http.StatusConflict)
			return
		}
		assetID := uuid.NewString()
		objectKey := "smoke/" + assetID + "/screen.mp4"
		job, err := p.StartRecording(r.Context(), media.RecordingRequest{
			Room: body.Room, ParticipantIdentity: "smoke-publisher", AssetID: assetID, ObjectKey: objectKey,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		mu.Lock()
		recordings[body.Room] = smokeRecording{ID: job.ID, ObjectKey: objectKey}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"recording_id": job.ID})
	})
	mux.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Room string `json:"room"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		mu.Lock()
		known := rooms[body.Room]
		recording, hasRecording := recordings[body.Room]
		mu.Unlock()
		if !known {
			http.Error(w, "unknown test room", 404)
			return
		}
		var byteSize int64
		if hasRecording {
			if err := p.StopRecording(r.Context(), recording.ID); err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			deadline := time.Now().Add(30 * time.Second)
			for time.Now().Before(deadline) {
				verification, verifyErr := objects.VerifyAsset(r.Context(), recording.ObjectKey)
				if verifyErr == nil && verification.Exists && verification.ByteSize > 0 {
					byteSize = verification.ByteSize
					break
				}
				time.Sleep(500 * time.Millisecond)
			}
			if byteSize == 0 {
				http.Error(w, "recording was not finalized in private storage", http.StatusGatewayTimeout)
				return
			}
			if err := objects.DeleteAsset(r.Context(), recording.ObjectKey); err != nil {
				http.Error(w, "recording cleanup failed", http.StatusBadGateway)
				return
			}
		}
		if err := p.EndRoom(r.Context(), body.Room); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		mu.Lock()
		delete(rooms, body.Room)
		delete(recordings, body.Room)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"recording_bytes": byteSize})
	})
	srv := &http.Server{Addr: "127.0.0.1:5191", ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Host != "127.0.0.1:5191" || (r.Method != "GET" && r.Header.Get("Origin") != "http://127.0.0.1:5191") {
			http.Error(w, "local same-origin requests only", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})}
	log.Print("Local video smoke test: http://127.0.0.1:5191 (synthetic canvas only)")
	log.Fatal(srv.ListenAndServe())
}
