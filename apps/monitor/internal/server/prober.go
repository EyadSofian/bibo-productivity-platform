package server

import (
	"net/http"
	"time"
)

// runProber GETs each public endpoint every 30s and records up/down + latency.
// This lives on the mac so it keeps working even if the prod box dies.
func (s *Server) runProber() {
	client := &http.Client{Timeout: 10 * time.Second}
	tick := time.NewTicker(30 * time.Second)
	for ; ; <-tick.C {
		for _, p := range s.cfg.Probes {
			start := time.Now()
			up, code := 0, 0
			resp, err := client.Get(p.URL)
			if err == nil {
				code = resp.StatusCode
				resp.Body.Close()
				if code < 400 {
					up = 1
				}
			}
			s.store.db.Exec(`INSERT INTO probes (target, ts, up, ms, code) VALUES (?,?,?,?,?)`,
				p.Name, start.UnixMilli(), up, float64(time.Since(start))/float64(time.Millisecond), code)
		}
	}
}
