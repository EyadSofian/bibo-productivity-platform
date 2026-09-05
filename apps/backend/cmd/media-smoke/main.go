// media-smoke exercises the real provider and browser transport against a LOCAL
// LiveKit development server. It never captures a user's screen or uses app data.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"sync"
	"time"

	"ctracking/backend/internal/media"
	"ctracking/backend/internal/media/livekit"
	"github.com/google/uuid"
)

func main() {
	assets := flag.String("assets", "../../.media-smoke", "directory containing the smoke-test browser bundle")
	flag.Parse()
	// Intentionally fixed to loopback and disposable development credentials.
	// This command must not mint credentials for a production SFU.
	p, err := livekit.New(livekit.Config{URL: "ws://127.0.0.1:7880", APIKey: "devkey", APISecret: "secret"})
	if err != nil {
		log.Fatal(err)
	}
	var mu sync.Mutex
	rooms := map[string]bool{}
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
		mu.Unlock()
		if !known {
			http.Error(w, "unknown test room", 404)
			return
		}
		if err := p.EndRoom(r.Context(), body.Room); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		mu.Lock()
		delete(rooms, body.Room)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
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
