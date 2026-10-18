package config

import (
	"strings"
	"testing"
)

// The still-capture kill switch must fail closed. A missing, empty, or malformed
// value has to leave the retired pipeline shut: the failure mode of a typo in a
// deploy variable is "screenshots stay off", never "screenshots come back".
func TestLegacyStillCaptureDefaultsClosed(t *testing.T) {
	cases := []struct {
		name string
		set  bool
		val  string
		want bool
	}{
		{name: "unset", set: false, want: false},
		{name: "empty", set: true, val: "", want: false},
		{name: "whitespace", set: true, val: "   ", want: false},
		{name: "typo", set: true, val: "ture", want: false},
		{name: "yes is not a bool", set: true, val: "yes", want: false},
		{name: "explicit false", set: true, val: "false", want: false},
		{name: "explicit 0", set: true, val: "0", want: false},
		{name: "explicit true", set: true, val: "true", want: true},
		{name: "explicit 1", set: true, val: "1", want: true},
		{name: "TRUE", set: true, val: "TRUE", want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("LEGACY_STILL_CAPTURE_ENABLED", tc.val)
			}
			if got := getenvBool("LEGACY_STILL_CAPTURE_ENABLED", false); got != tc.want {
				t.Errorf("getenvBool(%q) = %v, want %v", tc.val, got, tc.want)
			}
		})
	}
}

// A media token is a bearer credential for the media plane. A TTL of zero would
// mean a token that never expires, and an absurd one would mean a token that
// outlives the session it was minted for, so the value is clamped rather than
// trusted.
func TestMediaTokenTTLIsClamped(t *testing.T) {
	cases := []struct {
		name string
		val  string
		want int
	}{
		{name: "unset", val: "", want: 120},
		{name: "zero", val: "0", want: 120},
		{name: "negative", val: "-60", want: 120},
		{name: "absurdly long", val: "86400", want: 120},
		{name: "below the floor", val: "5", want: 120},
		{name: "not a number", val: "soon", want: 120},
		{name: "reasonable", val: "300", want: 300},
		{name: "at the floor", val: "30", want: 30},
		{name: "at the ceiling", val: "900", want: 900},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://localhost/x")
			t.Setenv("JWT_SECRET", "test-secret")
			t.Setenv("APP_ENV", "local")
			if tc.val != "" {
				t.Setenv("MEDIA_TOKEN_TTL_SECONDS", tc.val)
			}
			cfg, err := Load()
			if err != nil {
				t.Fatalf("load: %v", err)
			}
			if cfg.MediaTokenTTLSeconds != tc.want {
				t.Errorf("MediaTokenTTLSeconds = %d, want %d", cfg.MediaTokenTTLSeconds, tc.want)
			}
		})
	}
}

// No SFU is wired up yet. The default must be the provider that fails loudly,
// never one that silently does nothing.
func TestMediaProviderDefaultsToUnset(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/x")
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("APP_ENV", "local")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.MediaProvider != "" {
		t.Errorf("MediaProvider = %q, want empty until a real provider ships", cfg.MediaProvider)
	}
}

// A weak signing key is the one misconfiguration that fails silently: the
// service boots, tokens verify, and the first sign of trouble is a forged owner
// token. Boot must refuse it in every deployed environment.
func TestLoadRejectsWeakJWTSecretOutsideLocal(t *testing.T) {
	const strong = "0f3c1a8e5b7d2946af10c3e8b5d7916a" // 32 bytes
	cases := []struct {
		name   string
		env    string
		secret string
		reject bool
	}{
		// Local keeps the convenience of the committed .env.example: a forgery
		// against a developer's own machine grants nothing.
		{name: "local allows the dev placeholder", env: "local", secret: "dev-only-change-me"},
		{name: "local allows a short secret", env: "local", secret: "x"},

		// The placeholders committed to this repo are public by definition.
		{name: "staging rejects the dev placeholder", env: "staging", secret: "dev-only-change-me", reject: true},
		{name: "staging rejects its own placeholder", env: "staging", secret: "staging-only-change-me", reject: true},
		{name: "production rejects the dev placeholder", env: "production", secret: "dev-only-change-me", reject: true},
		{
			// 38 bytes: long enough to clear the floor, which is exactly why it
			// survived in .env.prod.example. Only the placeholder check catches it.
			name: "production rejects the long prod placeholder",
			env:  "production", secret: "prod-change-me-to-a-long-random-secret", reject: true,
		},
		{name: "a trailing newline is still the placeholder", env: "production", secret: "dev-only-change-me\n", reject: true},

		// Length floor.
		{name: "production rejects a short secret", env: "production", secret: "short", reject: true},
		{name: "31 bytes is one short of the floor", env: "production", secret: strong[:31], reject: true},
		{name: "32 bytes clears the floor", env: "production", secret: strong},
		{name: "padding is not entropy", env: "production", secret: "                                 ", reject: true},
		{name: "a padded strong secret is accepted", env: "production", secret: "  " + strong + "\n"},

		// An unrecognised APP_ENV is treated as deployed, not as local: a typo
		// in the deploy variable must not reopen the hole.
		{name: "an unknown env is held to the same bar", env: "prod", secret: "dev-only-change-me", reject: true},
		{name: "an unset env does not grant the local exemption", env: "", secret: "dev-only-change-me", reject: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://localhost/x")
			t.Setenv("APP_ENV", tc.env)
			t.Setenv("JWT_SECRET", tc.secret)

			cfg, err := Load()
			if tc.reject {
				if err == nil {
					t.Fatalf("Load() accepted a weak JWT_SECRET for APP_ENV=%s", tc.env)
				}
				// The error lands in boot logs and in Sentry, so it must describe
				// the problem without reprinting the secret itself. An
				// all-whitespace secret has nothing to leak, and Contains would
				// match its empty trimmed form against anything.
				if secret := strings.TrimSpace(tc.secret); secret != "" && strings.Contains(err.Error(), secret) {
					t.Errorf("Load() error leaks the secret: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() rejected an acceptable JWT_SECRET for APP_ENV=%s: %v", tc.env, err)
			}
			// The accepted secret is stored verbatim: trimming it here would
			// invalidate every token already signed with the padded value.
			if cfg.JWTSecret != tc.secret {
				t.Errorf("JWTSecret = %q, want the value as supplied %q", cfg.JWTSecret, tc.secret)
			}
		})
	}
}

// An absent secret is a missing-env error, not a weak-secret one. The two checks
// are ordered, and swapping them would replace a clear "missing required env"
// boot failure with a confusing complaint about a zero-length secret.
func TestLoadReportsEmptyJWTSecretAsMissing(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://localhost/x")
	t.Setenv("APP_ENV", "production")
	t.Setenv("JWT_SECRET", "")

	_, err := Load()
	if err == nil {
		t.Fatal("Load() accepted an empty JWT_SECRET")
	}
	if !strings.Contains(err.Error(), "missing required env") {
		t.Errorf("error = %v, want it to name the missing env var", err)
	}
}

// weakJWTSecret is the gate; these assert the reasons it gives, since the
// combined case is the one an operator is most likely to hit on a first deploy.
func TestWeakJWTSecretReasons(t *testing.T) {
	reasons := weakJWTSecret("production", "dev-only-change-me")
	if len(reasons) != 2 {
		t.Fatalf("weakJWTSecret() = %q, want both the length and placeholder reasons", reasons)
	}
	if got := weakJWTSecret("local", "dev-only-change-me"); got != nil {
		t.Errorf("weakJWTSecret(local) = %q, want nil", got)
	}
}
