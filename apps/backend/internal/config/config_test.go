package config

import "testing"

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
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.MediaProvider != "" {
		t.Errorf("MediaProvider = %q, want empty until a real provider ships", cfg.MediaProvider)
	}
}
