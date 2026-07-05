package server

import (
	"fmt"

	"github.com/BurntSushi/toml"
)

type Config struct {
	Listen          string `toml:"listen"`
	DB              string `toml:"db"`
	Token           string `toml:"token"` // ingest auth
	DashUser        string `toml:"dash_user"`
	DashPass        string `toml:"dash_pass"`
	RetentionDays   int    `toml:"retention_days"`
	RawRequestHours int    `toml:"raw_request_hours"`
	// AgentHost is the host whose agent silence means "prod box unreachable".
	AgentHost string `toml:"agent_host"`
	// Keepalive watch: alert when no 200 on this service+path for 20m.
	KeepaliveService string `toml:"keepalive_service"`
	KeepalivePath    string `toml:"keepalive_path"`

	Telegram struct {
		Token  string `toml:"token"`
		ChatID string `toml:"chat_id"`
	} `toml:"telegram"`

	Probes []Probe `toml:"probe"`

	Local LocalConfig `toml:"local"`
}

type Probe struct {
	Name string `toml:"name"`
	URL  string `toml:"url"`
}

// LocalConfig makes the server also collect data about its own box (the mac
// VPS), so no separate agent process is needed there.
type LocalConfig struct {
	Host   string `toml:"host"`
	Tails  []Tail `toml:"tail"`
	Checks []struct {
		Unit string `toml:"unit"`
		URL  string `toml:"url"`
	} `toml:"service_probe"`
}

type Tail struct {
	Service string `toml:"service"`
	File    string `toml:"file"`
}

func loadConfig(path string) (*Config, error) {
	var cfg Config
	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if cfg.Listen == "" {
		cfg.Listen = ":3200"
	}
	if cfg.RetentionDays <= 0 {
		cfg.RetentionDays = 30
	}
	if cfg.RawRequestHours <= 0 {
		cfg.RawRequestHours = 48
	}
	if cfg.KeepalivePath == "" {
		cfg.KeepalivePath = "/v1/keepalive"
	}
	if cfg.DB == "" || cfg.Token == "" || cfg.DashUser == "" || cfg.DashPass == "" {
		return nil, fmt.Errorf("config: db, token, dash_user, dash_pass are required")
	}
	return &cfg, nil
}
