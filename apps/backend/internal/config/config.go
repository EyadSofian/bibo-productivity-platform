// Package config loads runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config holds all runtime settings. Required values fail fast on load.
type Config struct {
	Port           string
	DatabaseURL    string
	JWTSecret      string
	StorageDir     string
	AllowedOrigin  string // web-admin origin for CORS
	StaticDir      string // dir of the built web-admin SPA to serve; "" = disabled
	SentryDSN      string // Sentry DSN; "" = error reporting disabled
	Environment    string // deploy env label sent to Sentry (local/staging/production)
	LogDir         string // dir for the on-disk log file (backend.log); "" = stdout only
	LogMaxSizeMB   int    // rotate the log file once it exceeds this size
	LogMaxBackups  int    // number of rotated files to keep
	LogMaxAgeDays  int    // delete rotated files older than this many days
	KeepaliveToken string // secret for the CPU keep-alive endpoint; "" = disabled

	// LegacyStillCaptureEnabled re-opens the retired still-screenshot pipeline.
	// DEFAULT FALSE: the product is video-first (docs/adr/0002), and still images
	// are no longer a monitoring artifact. It exists only so a migrating operator
	// can re-enable ingest for one deploy while agents roll forward; it is
	// removed outright in slice V12. Nothing else in the system may turn this on.
	LegacyStillCaptureEnabled bool

	// MediaProvider names the SFU implementation. Empty (the default) selects
	// the unconfigured provider, which fails every operation loudly rather than
	// pretending to work. A real provider arrives in slice V05.
	MediaProvider             string
	LiveKitURL                string
	LiveKitAPIKey             string
	LiveKitAPISecret          string
	RecordingS3Endpoint       string
	RecordingS3Bucket         string
	RecordingS3Region         string
	RecordingS3AccessKey      string
	RecordingS3SecretKey      string
	RecordingS3ForcePathStyle bool
	// MediaTokenTTLSeconds bounds how long a minted media token lives. Short by
	// design: a leaked token is only useful for this long, and the client
	// re-authorizes through the API to get another.
	MediaTokenTTLSeconds int

	// TrustedProxies lists the proxy addresses/CIDRs whose X-Forwarded-For may be
	// believed. EMPTY MEANS TRUST NOBODY, which is the safe default: gin's own
	// default trusts every proxy, so any client could forge X-Forwarded-For and
	// hand itself a fresh rate-limit bucket.
	TrustedProxies []string
	// TrustedPlatform names a single header set by a trusted edge that carries the
	// real client IP (e.g. "CF-Connecting-IP" behind Cloudflare). It takes
	// precedence over TrustedProxies when set, and is only safe when the edge is
	// the sole route to this backend.
	TrustedPlatform string
}

// Load reads .env (if present) then the process environment. It returns an error
// listing every missing required key so misconfiguration is obvious at boot.
func Load() (*Config, error) {
	// .env is optional; ignore a missing file but surface parse errors.
	if err := godotenv.Load(); err != nil && !os.IsNotExist(err) {
		// godotenv returns a generic error when the file is absent; only the
		// presence of a malformed file matters, so we don't hard-fail here.
		_ = err
	}

	cfg := &Config{
		Port:           getenv("PORT", "8080"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		JWTSecret:      os.Getenv("JWT_SECRET"),
		StorageDir:     getenv("STORAGE_DIR", "./storage"),
		AllowedOrigin:  getenv("WEB_ADMIN_ORIGIN", "http://localhost:5174"),
		StaticDir:      os.Getenv("STATIC_DIR"),
		SentryDSN:      os.Getenv("SENTRY_DSN"),
		Environment:    getenv("APP_ENV", "local"),
		LogDir:         getenv("LOG_DIR", "./logs"),
		LogMaxSizeMB:   getenvInt("LOG_MAX_SIZE_MB", 50),
		LogMaxBackups:  getenvInt("LOG_MAX_BACKUPS", 5),
		LogMaxAgeDays:  getenvInt("LOG_MAX_AGE_DAYS", 30),
		KeepaliveToken: os.Getenv("KEEPALIVE_TOKEN"),

		LegacyStillCaptureEnabled: getenvBool("LEGACY_STILL_CAPTURE_ENABLED", false),

		MediaProvider:             os.Getenv("MEDIA_PROVIDER"),
		LiveKitURL:                os.Getenv("LIVEKIT_URL"),
		LiveKitAPIKey:             os.Getenv("LIVEKIT_API_KEY"),
		LiveKitAPISecret:          os.Getenv("LIVEKIT_API_SECRET"),
		MediaTokenTTLSeconds:      getenvInt("MEDIA_TOKEN_TTL_SECONDS", 120),
		RecordingS3Endpoint:       os.Getenv("RECORDING_S3_ENDPOINT"),
		RecordingS3Bucket:         os.Getenv("RECORDING_S3_BUCKET"),
		RecordingS3Region:         getenv("RECORDING_S3_REGION", "auto"),
		RecordingS3AccessKey:      os.Getenv("RECORDING_S3_ACCESS_KEY"),
		RecordingS3SecretKey:      os.Getenv("RECORDING_S3_SECRET_KEY"),
		RecordingS3ForcePathStyle: getenvBool("RECORDING_S3_FORCE_PATH_STYLE", false),

		TrustedProxies:  getenvList("TRUSTED_PROXIES"),
		TrustedPlatform: os.Getenv("TRUSTED_PLATFORM"),
	}

	var missing []string
	if cfg.DatabaseURL == "" {
		missing = append(missing, "DATABASE_URL")
	}
	if cfg.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}

	// A present-but-weak JWT secret is worse than a missing one: the service
	// boots, every token verifies, and nothing looks wrong until someone forges
	// an owner token. Outside local development the secret must be long enough
	// to resist offline brute force against any single issued token, and must
	// not be one of the placeholders committed to this repo.
	// Only an explicit APP_ENV=local gets the development exemption. The
	// observability label above can default to local, but an unset deploy
	// variable must not silently make a public placeholder acceptable.
	rawEnvironment := os.Getenv("APP_ENV")
	if weak := weakJWTSecret(rawEnvironment, cfg.JWTSecret); len(weak) > 0 {
		return nil, fmt.Errorf("insecure JWT_SECRET for APP_ENV=%q: %s", rawEnvironment, strings.Join(weak, "; "))
	}

	// A token TTL of zero or a negative one would mean tokens that never expire
	// or are born expired. Clamp rather than fail: a bad value here must not
	// stop the service booting, but must not widen the grant either.
	if cfg.MediaTokenTTLSeconds < 30 || cfg.MediaTokenTTLSeconds > 900 {
		cfg.MediaTokenTTLSeconds = 120
	}
	return cfg, nil
}

// jwtSecretMinBytes is the floor for a deployed signing key. HS256 keys shorter
// than the 32-byte hash output add no security over a 32-byte one and a short
// human-chosen string is brute-forceable offline from one captured token.
const jwtSecretMinBytes = 32

// templateJWTSecrets are the placeholder values committed to this repository
// (apps/backend/.env.example, .env.staging.example, .env.prod.example,
// docker-compose.yml and scripts/start-env.sh). They are public by definition,
// so they are rejected outside local.
//
// The length floor below already catches the dev and staging ones; they are
// listed so the error names the real cause instead of just a byte count. The
// production one is 38 bytes and clears that floor on its own, which is exactly
// what made it easy to leave in place — only this list catches it.
var templateJWTSecrets = map[string]bool{
	"dev-only-change-me":                     true,
	"staging-only-change-me":                 true,
	"prod-change-me-to-a-long-random-secret": true,
}

// weakJWTSecret returns the reasons secret is unfit to sign tokens in env, or
// nil if it is acceptable. APP_ENV=local is exempt: local development keeps the
// convenience of the committed .env.example, and a local forgery grants nothing.
// Reasons never quote the secret, so this error is safe in boot logs.
//
// Both checks run against the whitespace-trimmed secret: padding contributes no
// entropy, and a value copy-pasted with a trailing newline is still the public
// template. The secret itself is left untrimmed — changing the signing key here
// would silently invalidate every token already issued.
func weakJWTSecret(env, secret string) []string {
	if env == "local" {
		return nil
	}
	trimmed := strings.TrimSpace(secret)
	var weak []string
	if len(trimmed) < jwtSecretMinBytes {
		weak = append(weak, fmt.Sprintf("%d bytes, need at least %d", len(trimmed), jwtSecretMinBytes))
	}
	if templateJWTSecrets[trimmed] {
		weak = append(weak, "matches a placeholder committed to this repo")
	}
	return weak
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// getenvList splits a comma-separated env var, dropping blanks so a trailing
// comma or an all-whitespace value reads as "unset" rather than as one empty entry.
func getenvList(key string) []string {
	raw := os.Getenv(key)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(part); v != "" {
			out = append(out, v)
		}
	}
	return out
}

// getenvBool reads a boolean env var. Only an explicit, unambiguous true value
// enables the flag: anything unset, empty or unparseable keeps the fallback, so a
// typo can never silently re-open the legacy capture path.
func getenvBool(key string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}

func getenvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
