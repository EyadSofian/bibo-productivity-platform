// Package server is the monitoring hub on the mac VPS: it ingests agent
// batches, stores them in SQLite, probes public endpoints, evaluates alert
// rules (Telegram), and serves the dashboard at monitor.namnguyen.pro.
package server

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"ctracking/monitor/internal/server/ui"
	"ctracking/monitor/internal/wire"
)

type Server struct {
	cfg     *Config
	store   *Store
	tg      *telegram
	started time.Time
}

func Run(cfgPath string) error {
	cfg, err := loadConfig(cfgPath)
	if err != nil {
		return err
	}
	store, err := openStore(cfg.DB)
	if err != nil {
		return err
	}
	s := &Server{cfg: cfg, store: store, tg: newTelegram(cfg.Telegram.Token, cfg.Telegram.ChatID), started: time.Now()}

	go s.runProber()
	go s.runAlerts()
	go s.runLocalCollector()
	go s.runMaintenance()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /ingest", s.handleIngest)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.Handle("GET /api/overview", s.auth(s.handleOverview))
	mux.Handle("GET /api/metrics", s.auth(s.handleMetrics))
	mux.Handle("GET /api/rollup", s.auth(s.handleRollup))
	mux.Handle("GET /api/logs", s.auth(s.handleLogs))
	mux.Handle("GET /", s.auth(ui.Handler().ServeHTTP))

	log.Printf("bibomon server listening on %s", cfg.Listen)
	return http.ListenAndServe(cfg.Listen, mux)
}

func (s *Server) runMaintenance() {
	tick := time.NewTicker(time.Minute)
	for ; ; <-tick.C {
		if err := s.store.rollupClosedMinutes(s.cfg.KeepalivePath, time.Now()); err != nil {
			log.Printf("rollup: %v", err)
		}
		if time.Now().Minute() == 0 {
			s.store.prune(s.cfg.RetentionDays, s.cfg.RawRequestHours, time.Now())
		}
	}
}

func (s *Server) auth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(user), []byte(s.cfg.DashUser)) != 1 ||
			subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.DashPass)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="bibomon"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	})
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Bibomon-Token") != s.cfg.Token {
		http.Error(w, "bad token", http.StatusUnauthorized)
		return
	}
	var b wire.Batch
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&b); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if b.Host == "" {
		http.Error(w, "missing host", http.StatusBadRequest)
		return
	}
	if err := s.store.InsertBatch(&b); err != nil {
		log.Printf("ingest: %v", err)
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
