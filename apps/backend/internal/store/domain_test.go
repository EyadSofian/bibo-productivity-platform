package store

import "testing"

func TestDomainOf(t *testing.T) {
	for _, tc := range []struct {
		name string
		url  string
		want string // "" means nil
	}{
		{"plain host", "https://github.com/a/b?c=1", "github.com"},
		{"subdomain is kept", "https://docs.google.com/document/d/x", "docs.google.com"},
		{"lowercased", "https://GitHub.COM/a", "github.com"},
		{"port stripped", "http://localhost:3000/app", "localhost"},
		{"ipv4 host", "https://192.168.1.5:8443/x", "192.168.1.5"},
		{"ipv6 host", "https://[2606:4700::1111]/x", "2606:4700::1111"},
		{"userinfo is not the host", "https://user:pw@example.com/x", "example.com"},
		{"trailing dot kept as written", "https://example.com./x", "example.com."},
		{"no path", "https://example.com", "example.com"},

		// Not page views.
		{"marker value", "user_turn_off_in_browser", ""},
		{"empty", "", ""},
		{"scheme only", "https://", ""},
		{"non-web scheme", "mailto:someone@example.com", ""},
		{"file url", "file:///Users/me/notes.txt", ""},
		{"browser internal", "chrome://settings", ""},
		{"bare path", "/just/a/path", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := DomainOf(tc.url)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("DomainOf(%q) = %q, want nil", tc.url, *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("DomainOf(%q) = nil, want %q", tc.url, tc.want)
			}
			if *got != tc.want {
				t.Fatalf("DomainOf(%q) = %q, want %q", tc.url, *got, tc.want)
			}
		})
	}
}

// Internationalized hosts reach the backend already punycoded by the browser,
// but a hand-built request may not be. Recording whichever form arrives is
// acceptable; silently failing to record a domain at all is not.
func TestDomainOfUnicodeHost(t *testing.T) {
	got := DomainOf("https://münchen.de/x")

	if got == nil {
		t.Fatal("DomainOf returned nil for a unicode host")
	}
	if *got != "münchen.de" && *got != "xn--mnchen-3ya.de" {
		t.Fatalf("DomainOf = %q, want the unicode or punycode form", *got)
	}
}
