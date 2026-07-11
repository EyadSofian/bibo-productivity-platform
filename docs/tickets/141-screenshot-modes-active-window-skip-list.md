# 141 — Screenshot modes: active-window capture + app skip-list

**Status:** Planned
**Area:** desktop (Rust trackers + settings + React Settings UI)

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
