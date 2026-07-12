// Package privacyapps holds the curated sensitive-app rules (ticket 141): the
// single source of truth served at /v1/public/screenshot-privacy-apps, used to
// prefill new businesses' skip-lists, and mirrored by the desktop's baked-in
// fallback (trackers::DEFAULT_PRIVACY_APPS — keep in sync).
package privacyapps

// Category is one group of the curated sensitive-app list.
type Category struct {
	Key  string   `json:"key"`
	Apps []string `json:"apps"`
}

// Entries are the names the OS actually reports (device matching is
// case-insensitive whole-word, so "Telegram" also covers "Telegram Desktop");
// WeChat 4.0 reports "Weixin" and macOS Zoom reports "zoom.us", hence the
// extra entries.
var categories = []Category{
	{Key: "Chat", Apps: []string{
		"Zalo", "WhatsApp", "Telegram", "Signal", "Viber", "WeChat", "Weixin",
		"QQ", "LINE", "KakaoTalk", "Discord", "Messages", "FaceTime", "Element",
		"Threema", "Wire", "Beeper", "Ferdium", "Rambox", "Caprine",
	}},
	{Key: "Security", Apps: []string{
		"1Password", "Bitwarden", "LastPass", "KeePass", "KeePassXC", "Keeper",
		"NordPass", "Proton Pass", "Enpass", "RoboForm", "Keychain Access",
		"Passwords", "Ledger Live", "Trezor Suite", "Exodus", "Electrum",
		"Sparrow", "Proton VPN", "NordVPN", "TeamViewer", "AnyDesk",
	}},
	{Key: "Work", Apps: []string{
		"Slack", "Microsoft Teams", "Zoom", "zoom.us", "Webex", "DingTalk",
		"Lark", "Feishu", "Mattermost", "Rocket.Chat",
	}},
	{Key: "Mail", Apps: []string{
		"Mail", "Outlook", "Thunderbird", "Spark", "Proton Mail", "eM Client",
		"Mailbird", "Superhuman", "Airmail",
	}},
}

// Categories returns the curated list grouped for the UIs.
func Categories() []Category {
	return categories
}

// Flat returns every app name in one list — the default skip-list prefill.
func Flat() []string {
	var out []string
	for _, c := range categories {
		out = append(out, c.Apps...)
	}
	return out
}
