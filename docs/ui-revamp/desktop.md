# BiBoTracking — Desktop App UI revamp brief

Tauri 2 (Rust) + React/Vite. macOS + Windows. Small window, native-feeling, tray-driven.
Light / dark / system theme per window. Language switcher present throughout
(8 options: EN, ZH, JA, VI, ID, FR, ES). Must tolerate variable text lengths per locale.

Three personas: **Solo** (local-only, no account), **Team** (employee, synced),
**Family** (kid, synced). Persona changes the "who sees this?" framing and vocabulary.

Tone: transparent and calm — the app captures screenshots/keystrokes/browsing, so make
capture state and consent always obvious.

---

## Visual direction (apply across every screen)

Inspired by a soft, premium **glassmorphism** crypto-dashboard look. Same language for
all three surfaces (marketing, admin, desktop) so the product feels like one family.
Scaled down for a compact desktop window — keep the airy feel but tighter density.

- **Background:** subtle blue-grey gradient, not flat white. Frosted/translucent panels
  appear to float above it.
- **Cards:** large rounded corners (~20px radius), soft diffuse drop shadows so each card
  hovers. Generous padding; nothing cramped.
- **Selection / hero state:** one **near-black dark card** marks the active/selected item
  amid light cards (high contrast). Use sparingly — one focal dark element per view (e.g.
  the active tracking-state card).
- **Palette:** light lavender-white surfaces + pastel data accents — lavender, mint green,
  coral/red, sky blue. **Green = positive/active, coral/red = paused/negative**, applied
  only to data and status, never to chrome. Map to tracking pill: 🟢 green, 🟡 amber,
  ❚❚ coral.
- **Charts:** smooth curved area/line charts with glowing node dots and small dark tooltip
  bubbles; thin gradient bars; multi-color donut/radial rings with a big centered number.
  Tiny inline **sparklines** on stat/list rows. Carry this into the 24h activity timeline,
  keystroke bar chart, and time-by-app bars.
- **Controls:** pill **segmented toggles** (theme Light/Dark/System), rounded pill fields,
  soft circular icon buttons, slim icon-only left nav rail.
- **Typography:** bold near-black headlines, light grey muted secondary text, prominent
  numbers with small muted labels. Clean sans-serif. Color reserved for data/status.

Provide **light and dark** variants of every screen.

---

## Authentication & onboarding

### Welcome (first launch, no session)
- Two cards: **Just me** (🧍 → local-only mode, no account) and **I have an account**
  (👥 → login screen).
- Link: "Need an account? Sign up".

### Login
- Back button (→ Welcome).
- Fields: Identifier (email/username), Password. Sign in button. Error display.
- Language switcher top-right. "Don't have an account?" opens signup in system browser.

### Consent (Windows only, first-run)
- Title: "We need your consent to capture".
- Explanation + bullets: Screenshots, keystrokes, activity time, web pages.
- Note: can opt out in Settings. Accept button.

### Onboarding (shows once per install) — 3-step rail, language switcher at top
1. **Welcome** — explains the four capture types; persona-aware "Who sees this?" notice
   (local-only / your team / parent). Next.
2. **Configure capture** — notice if org-locked (disabled toggles). Rows: Capture
   screenshots (switch), Count keystrokes (switch), Screenshot interval (1/5/10/15 min),
   Idle threshold (1/3/5 min), Screenshot retention (7/30/90 days). Next.
3. **Permissions** — macOS: Screen Recording, Input Monitoring, Accessibility TCC prompts.
   Windows: consent (already accepted). Finish.

---

## Main app shell (signed in or local mode)

### Sidebar
- Brand "BiBoTracking" + version (v1.3.x).
- Nav: Dashboard, Activity, Screenshots, Browser, Permissions, Settings (active item
  highlighted).
- Footer: signed-in → email + Sign out; local mode → "Local mode" (tooltip) + Set up
  account. Tracking-state pill (red/yellow/green).

### Header
- Page title (matches active nav).
- Language switcher dropdown.
- Theme segmented toggle: Light / Dark / System.
- **Tracking status pill** (clickable): 🟢 Tracking (click to pause), 🟡 Idle (not
  clickable), ❚❚ Paused (click to resume). Hover tooltip shows full status.

---

## Screens

### Dashboard (refresh ~3s)
- 4 live stat cards: Active time today, Top app, Keypresses, Screenshots.
- **24-hour timeline bar**: active app segments (app names in opacity gradient) + grayed
  idle gaps. Hover tooltip: "[App] · [duration]" or "Idle · [duration]". Caption: idle
  segments grayed.
- **Time by app**: horizontal bar rows (App | duration | % bar), max app fills 100%.

### Activity (refresh ~5s)
- Title: "Keystroke activity".
- Bar chart of 30-minute slots; each bar = keystroke count in that window. Tooltip:
  "[HH:MM] · [count] keypresses". Y normalized to max. Total keypresses summary.

### Screenshots (refresh ~5s)
- Intro: "Screenshots taken today". **Capture now** button (manual trigger).
- Grid of today's thumbnails with timestamps (HH:MM:SS), click to enlarge.
- Feedback message: "Captured X screenshots" or error.

### Browser
- **Extension guide** (until first visit recorded): title "Track this browser", steps
  (install extension → get extension → authorize → data syncs), waiting notice "Waiting
  for extension data on port [XXXX]", support note, GIF placeholder.
- **Browser visits** (after first visit): "Sites visited today" table — Domain | Time |
  Duration | Browser. Grouped by domain, sorted by time spent. Auto-refreshes.

### Permissions (OS-driven table, refresh button)
- macOS rows (TCC): Screen recording, Input monitoring, Accessibility — each with
  grant/deny indicator (● granted / ▲ denied), label, description, and action button
  (Request / Open Settings) or status pill.
- Windows rows: Screenshot capture, Keystroke counting (consent-based, no request action).

### Settings (vertical sections, max-width ~680px)
- **General**: Language switcher; Hide dock toggle (title/desc differs macOS vs Windows).
- **Updates**: Version (read-only); Check for updates button; status message area.
- **Capture** (locked notice if org-managed): Capture screenshots (toggle, lockable),
  Count keystrokes (toggle, lockable), Screenshot interval (1/5/10/15 min), Idle threshold
  (1/3/5 min), Screenshot retention (7/30/90 days).
- **Privacy**: Store domain only (toggle); "Permissions / What's captured" button → opens
  Permissions screen.
- **Browser link** (read-only): Ingest port "127.0.0.1 : XXXX" or "No free port"; Pairing
  token pill (green "Token active" / red "No token").
- **Export**: Export as CSV / Export as JSON → file picker → status (file count + row
  count + directory).

---

## Native tray / menu bar
- Icon changes by state: 🟢 tracking, 🟡 idle, ❚❚ paused.
- Items: Open main UI · — · Start (greyed if tracking) · Stop (greyed if paused) · — ·
  Quit BiBoTracking. All localized; relabel on language change.

---

## Shared components to design
Sidebar + header shell, tracking status pill (3 states), live stat cards, 24h timeline,
keystroke bar chart, screenshot grid/lightbox, OS permission table, segmented controls,
switches (with locked state), dropdowns, language switcher, theme toggle, onboarding rail,
consent/welcome cards, status/feedback messages.
