// Package agent runs on a monitored box (Oracle A1). Every tick it collects
// host metrics + systemd unit states + new journald lines for the configured
// units, and POSTs one wire.Batch to the server's /ingest endpoint (reached
// over the existing SSH reverse tunnel — the agent opens no listening ports).
// Failed batches are spooled to disk and drained on the next successful tick.
package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/BurntSushi/toml"

	"ctracking/monitor/internal/wire"
)

type Config struct {
	Host         string   `toml:"host"`
	IngestURL    string   `toml:"ingest_url"`
	Token        string   `toml:"token"`
	IntervalSecs int      `toml:"interval_secs"`
	Units        []string `toml:"units"`
	StateDir     string   `toml:"state_dir"`
}

const maxSpoolBytes = 20 << 20

func Run(cfgPath string) error {
	var cfg Config
	if _, err := toml.DecodeFile(cfgPath, &cfg); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if cfg.IntervalSecs <= 0 {
		cfg.IntervalSecs = 15
	}
	if err := os.MkdirAll(cfg.StateDir, 0o755); err != nil {
		return err
	}
	cursorFile := filepath.Join(cfg.StateDir, "journal.cursor")
	spoolFile := filepath.Join(cfg.StateDir, "spool.jsonl")
	client := &http.Client{Timeout: 30 * time.Second}

	log.Printf("bibomon agent: host=%s units=%d interval=%ds -> %s", cfg.Host, len(cfg.Units), cfg.IntervalSecs, cfg.IngestURL)
	ticker := time.NewTicker(time.Duration(cfg.IntervalSecs) * time.Second)
	for ; ; <-ticker.C {
		batch := collect(&cfg, cursorFile)
		if err := send(client, &cfg, batch); err != nil {
			log.Printf("send failed (spooling): %v", err)
			spoolAppend(spoolFile, batch)
			continue
		}
		drainSpool(client, &cfg, spoolFile)
	}
}

func collect(cfg *Config, cursorFile string) *wire.Batch {
	now := time.Now().UnixMilli()
	b := &wire.Batch{Host: cfg.Host}

	if m, err := hostMetric(now); err == nil {
		b.Metrics = append(b.Metrics, m)
	} else {
		log.Printf("host metrics: %v", err)
	}
	b.Units = unitStates(cfg.Units, now)

	reqs, logs, err := readJournal(cfg.Units, cursorFile)
	if err != nil {
		log.Printf("journal: %v", err)
	}
	b.Requests = reqs
	b.Logs = logs
	return b
}

func send(client *http.Client, cfg *Config, b *wire.Batch) error {
	body, err := json.Marshal(b)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, cfg.IngestURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Bibomon-Token", cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ingest returned %s", resp.Status)
	}
	return nil
}

func spoolAppend(path string, b *wire.Batch) {
	if st, err := os.Stat(path); err == nil && st.Size() > maxSpoolBytes {
		// Spool full — drop oldest half rather than growing without bound.
		if data, err := os.ReadFile(path); err == nil {
			os.WriteFile(path, data[len(data)/2:], 0o644)
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.Encode(b)
}

func drainSpool(client *http.Client, cfg *Config, path string) {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return
	}
	var remaining [][]byte
	sent := 0
	for _, line := range bytes.Split(data, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if len(remaining) > 0 {
			remaining = append(remaining, line)
			continue
		}
		var b wire.Batch
		if json.Unmarshal(line, &b) != nil {
			continue
		}
		if err := send(client, cfg, &b); err != nil {
			remaining = append(remaining, line)
			continue
		}
		sent++
	}
	if len(remaining) == 0 {
		os.Remove(path)
	} else {
		os.WriteFile(path, append(bytes.Join(remaining, []byte("\n")), '\n'), 0o644)
	}
	if sent > 0 {
		log.Printf("drained %d spooled batches (%d left)", sent, len(remaining))
	}
}
