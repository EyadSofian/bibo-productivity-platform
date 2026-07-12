# 141 — Screenshot modes: active-window capture + app skip-list

**Status:** Implemented (manual QA pending)
**Area:** backend (capture policy) + web-admin (org Settings) + desktop (Rust trackers + settings + React Settings UI)

> **Design change at implementation time:** mode + skip-list are an **org setting**
> (business capture policy), not device-local as originally planned below. They ride
> the existing ticket-105 pipeline: `businesses` columns → owner PATCH
> `/v1/businesses/:id/settings` → `GET /v1/policy` → desktop `apply_org_policy`.
> Like interval/idle/retention, they're locked on employee devices unless
> `allow_employee_override` is on; standalone/local-only users edit them freely in
> the desktop Settings.

## Goal

Two capture modes for periodic screenshots, plus a privacy skip-list:

1. **Full screen** (current behavior, stays the default) — one shot per display.
2. **Active window** (new) — capture only the frontmost window.

Independently of mode, a user-editable **skip-list of app names** (e.g. `Zalo`):
when the active app is on the list at capture time, that capture tick is skipped
entirely (no shot at all, in both modes — privacy-consistent).

## Feasibility notes

- `xcap` 0.9 (already the capture dependency) supports per-window capture
  cross-platform: `xcap::Window::all()` + `capture_image()`, with `pid()` /
  `app_name()` to identify windows.
- The tracker already resolves the active window every tick
  (`platform::active_window()` → app name, title, pid), so both the skip check
  and the window lookup reuse existing data.
- No new OS permission: window capture is covered by the same Screen Recording
  grant (macOS); nothing extra on Windows.
- Caveat: sometimes the frontmost "window" is not capturable (desktop focus,
  transient/system surfaces, window gone between poll and capture). Active-window
  mode must handle a lookup/capture miss — **fallback: capture full screen** for
  that tick (never silently drop, except via the skip-list).

## Design

### Settings (local `settings.json`, per device — not pushed from web-admin)

| key | type | default |
|---|---|---|
| `screenshot_mode` | `"full_screen" \| "active_window"` | `"full_screen"` |
| `screenshot_skip_apps` | `string[]` | `[]` (UI suggests `Zalo`) |

- Skip match: case-insensitive exact match on the app name reported by
  `active_window()` (same string shown in "Time by app", so users can copy it).
- Missing keys in an existing settings.json load as defaults (serde defaults),
  same pattern as previous settings additions.

### Capture flow (`trackers/mod.rs::capture_once`)

```
tick →
  active = platform::active_window()
  if active.app_name ∈ skip_apps (case-insensitive) → log + skip tick
  match mode:
    full_screen   → existing per-monitor loop (unchanged)
    active_window → find xcap::Window with pid == active.pid
                     (visible, non-minimized; largest if several)
                    ok  → capture that window
                    miss/err → log + full-screen fallback
```

- Compression path unchanged (`compress_to_webp`, ≤50 KB WebP cap).
- DB row: reuse `Screenshot` as-is; `display_id = NULL` for window shots
  (already nullable). No schema/backend change — backend + web-admin display
  the image regardless of origin.
- File name: `{ts}_window.webp` vs existing `{ts}_display{i}.webp`.

### TrackerControl plumbing

- `screenshot_mode` as an atomic (u8 enum) + `screenshot_skip_apps` behind a
  `RwLock<Vec<String>>` (list can't be an atomic), both on `TrackerControl`,
  applied in `apply_settings` like `capture_screenshots`.

### UI (`apps/desktop/src/screens/Settings.tsx`)

- Radio/segmented control: "Capture all screens" / "Capture active window only",
  under the existing screenshots toggle, disabled when screenshots are off.
- Skip-list editor: simple tag input (add by name, remove chip), helper text
  "App names as shown in Time by app, e.g. Zalo".
- i18n: new keys in all 7 locale catalogs (`en, zh, ja, vi, id, fr, es`).

## Out of scope

- Owner-side (web-admin) control of mode/skip-list — local device setting only.
- Blurring/redaction instead of skipping.
- Domain/URL-based skipping (browser tabs) — skip-list is app-level.

## Implementation steps

1. Settings struct + defaults + `TrackerControl` fields + `apply_settings`
   → verify: `cargo check` in `apps/desktop/src-tauri`.
2. `capture_once`: skip-list gate + mode branch + window lookup w/ fallback;
   unit test for the skip matcher (case-insensitivity, no-title windows)
   → verify: `cargo test`.
3. Settings UI + `set_settings` payload + locale keys ×7
   → verify: `tsc --noEmit` + `vite build`.
4. Manual QA (interactive):
   - full mode unchanged (multi-monitor: one shot per display);
   - active-window mode: shot contains only the front window;
   - Zalo (or any listed app) focused → no shot that tick, next tick resumes;
   - desktop focused in active-window mode → full-screen fallback shot;
   - settings persist across restart; old settings.json still loads.

## Open questions (decide before implementation)

- Should the skip check also consider the app being *visible on screen* in
  full-screen mode (not just frontmost)? Current design: frontmost only.
- Multi-monitor + active-window mode: window shot only (current design), or
  window + other displays?

## Implementation notes (2026-07-11)

### Privacy mode + backend-served rules (same-day follow-up)

- **Modes are now two:** `privacy` (**the default** — captures only the active
  window) | `normal` (every display in full). The skip list applies in **both**
  modes and is **prefilled with the curated sensitive-app rules** (fresh desktop
  installs via serde default; new businesses via `createBusinessTx`; users
  add/remove freely). Switching into privacy with an emptied skip list re-prefills
  it in the UI. Pre-rename values still parse everywhere: `full_screen`→normal,
  `active_window`/unknown→privacy (captures the least). Both Settings UIs render
  the mode as two radio cards with full explanations (×7 locales). Migration
  `00009` default is `'privacy'` (edited before any prod deploy); the local dev
  DB (which had already applied 00009) was ALTERed + backfilled in place.
- **Rules live in the backend:** `GET /v1/public/screenshot-privacy-apps`
  (public — personal/no-account desktops need it too) serves the curated list
  from `internal/privacyapps` (the single source of truth; also used to prefill
  new businesses). web-admin fetches it for suggestion chips + the privacy-mode
  prefill (`getPrivacyApps`); the desktop fetches it via the `privacy_apps`
  command, falling back to a baked-in copy (`trackers::DEFAULT_PRIVACY_APPS` —
  keep in sync with the Go list) when offline.
- **Skip-list UI moved to a modal** (both apps): the Settings row shows only a
  count + "Manage…" button. The modal has an add-input for custom apps, a
  "Custom" chip section for user-typed entries, and every suggested category as
  **toggle chips** (✓ added / + not) with per-category **Add all / Remove all**
  buttons and an added/total counter.
- **Smart visibility (2026-07-12):** the skip list is a privacy-mode feature —
  hidden in normal mode in both UIs AND ignored by the matcher in normal mode
  (`capture_once` checks it only when mode = privacy). Desktop: turning
  screenshots off hides mode/skip-list/interval/retention (Settings and the
  onboarding configure step). Settings are grouped: web-admin under "Tracking
  policy" / "Screenshots" headings; desktop split into "Screenshots" and
  "Capture" sections.
- **Org-locked = not rendered (2026-07-12):** when the org disallows overrides
  the desktop renders NO capture controls at all — Settings shows only the
  managed-by-org notice, and the onboarding drops the configure step entirely
  (2-step flow). Enforcement in `set_settings` remains the backstop.
- **Org lock covers the new fields:** `set_settings` forces `screenshot_mode` +
  `screenshot_skip_apps` back to the org values when the policy is locked (not
  just UI-disabled), same as interval/idle/retention.

- **Backend:** migration `00009_screenshot_mode.sql` adds
  `businesses.screenshot_mode text NOT NULL DEFAULT 'full_screen'` and
  `businesses.screenshot_skip_apps text[] NOT NULL DEFAULT '{}'`. Both wired
  through `store/owner.go` (`Business`, `businessCols`, `scanBusiness`,
  `settableColumns`, `CapturePolicy`, `PolicyForUser`) and `handlers/owner.go`
  (`UpdateSettings` validation: mode enum; skip apps ≤100 entries, trimmed,
  non-empty, ≤200 chars each; `Policy` JSON output).
- **web-admin:** `pages/Settings.tsx` capture-policy group gains a
  full-screen/active-window segmented control and a skip-list editor (add input +
  removable `.pill` chips); `Business`/`BusinessSettingsPatch` types extended;
  `settings.json` keys (`screenshotMode.*`, `skipApps.*`) added to all 7 locales.
- **desktop Rust:** `Settings.screenshot_mode` (serde default `full_screen`) +
  `screenshot_skip_apps` (default `[]`); `TrackerControl.screenshot_mode:
  AtomicU8` + `screenshot_skip_apps: RwLock<Vec<String>>` applied in
  `settings::apply`. `capture_once` now takes `&TrackerControl`: skip-list gate
  first (case-insensitive **whole-word** match on `active_window().app_name` —
  "Zalo" also matches "Zalo PC" / "zalo - the best app", but "LINE" doesn't
  match "Outline"; logged),
  then active-window capture via `xcap::Window::all()` matched by pid
  (non-minimized; preferring an exact title match, then the topmost by z-order —
  size is wrong when an app has several windows, e.g. two Chrome windows),
  saved as `{ts}_window.webp` with `display_id = NULL`;
  any miss falls back to the full-screen loop. `Policy` struct + `set_settings`
  locked-block + `apply_org_policy` carry the two new fields. Unit tests:
  `skip_list_matches_case_insensitively`, `shot_mode_parses_with_safe_fallback`.
- **desktop React:** Settings → Capture gains a mode `Select` and a skip-apps tag
  editor (both disabled when org-locked or screenshots off); `AppSettings` type
  extended; keys added to all 7 desktop locale catalogs.
- **Suggestions:** both Settings UIs offer a prebuilt one-click list of ~60
  privacy-sensitive apps (`SUGGESTED_SKIP_APPS`, kept in sync between web-admin
  and desktop), grouped into 4 localized categories; already-added entries are
  hidden. Entries are the names the OS actually reports (researched 2026-07-11):
  - *Chat & social:* Zalo, WhatsApp, Telegram, Signal, Viber, WeChat, **Weixin**
    (the 4.0 unified client's real name), QQ, LINE, KakaoTalk, Discord,
    Messages, FaceTime, Element, Threema, Wire, Beeper, Ferdium, Rambox, Caprine.
  - *Passwords & security:* 1Password, Bitwarden, LastPass, KeePass, KeePassXC,
    Keeper, NordPass, Proton Pass, Enpass, RoboForm, Keychain Access, Passwords
    (macOS 15 app), Ledger Live, Trezor Suite, Exodus, Electrum, Sparrow,
    Proton VPN, NordVPN, TeamViewer, AnyDesk.
  - *Work & meetings:* Slack, Microsoft Teams, Zoom, **zoom.us** (the macOS
    bundle still reports this even after the Zoom Workplace rebrand), Webex,
    DingTalk, Lark, Feishu, Mattermost, Rocket.Chat.
  - *Mail:* Mail, Outlook, Thunderbird, Spark, Proton Mail, eM Client,
    Mailbird, Superhuman, Airmail.
  - Deliberately omitted: Skype (retired 2025-05), Authy desktop (killed
    2024-03), Dashlane desktop (sunset 2022), Facebook Messenger desktop (shut
    down 2025-12; "Messenger" alone is too generic), Franz (abandonware).
    Chinese-locale reported names (微信/钉钉/飞书) are not suggested as chips but
    can be added manually.
- Verified: `go build ./...` + `go vet`, web-admin & desktop `tsc --noEmit` +
  `vite build`, `cargo check` + `cargo test` (26 passed).

## Manual QA checklist (pending)

- Owner flips mode / edits skip-list in web-admin → employee device picks it up
  on next policy fetch; controls locked on the device unless override allowed.
- Full mode unchanged (multi-monitor: one shot per display).
- Active-window mode: shot contains only the front window; desktop focus →
  full-screen fallback shot.
- Listed app (e.g. Zalo) focused → no shot that tick, next tick resumes.
- Settings persist across restart; pre-141 settings.json still loads.
