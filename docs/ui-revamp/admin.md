# BiBoTracking — Web Admin UI revamp brief

React 19 + Vite SPA, served at `/admin`. Owner/manager dashboard. Light / dark / system
themes. Persona-aware vocabulary swaps everywhere: **Team → "Employees"**, **Family →
"Kids"**. Must tolerate 7 locales (en, zh, ja, vi, id, fr, es) — flexible text lengths.

Tone: privacy-first, calm, trustworthy. The product watches people, so the UI must feel
transparent, not surveillance-creepy.

---

## Visual direction (apply across every screen)

Inspired by a soft, premium **glassmorphism** crypto-dashboard look. Same language for
all three surfaces (marketing, admin, desktop) so the product feels like one family.

- **Background:** subtle blue-grey gradient, not flat white. Frosted/translucent panels
  appear to float above it.
- **Cards:** large rounded corners (~20px radius), soft diffuse drop shadows so each card
  hovers. Generous padding and whitespace — nothing cramped.
- **Selection / hero state:** one **near-black dark card** marks the active/selected item
  amid the light cards (high contrast). Use sparingly — one focal dark element per view.
- **Palette:** light lavender-white surfaces + pastel data accents — lavender, mint green,
  coral/red, sky blue. **Green = positive, coral/red = negative**, applied only to data
  (deltas, chart lines), never to chrome.
- **Charts:** smooth curved area/line charts with glowing node dots and small dark tooltip
  bubbles; thin gradient progress bars; multi-color donut/radial rings with a big centered
  number. Tiny inline **sparklines** on stat/list rows.
- **Controls:** pill **segmented toggles** (e.g. Day/Week/Month/Year), rounded pill search
  fields, soft circular icon buttons, slim icon-only left nav rail.
- **Typography:** bold near-black headlines, light grey muted secondary text, prominent
  numbers with small muted labels. Clean sans-serif. Color reserved for data only.
- **Imagery for this app specifically:** carry the same look into our domains — activity
  timelines, app-usage bars, keystroke charts, screenshot galleries, status pills.

Provide **light and dark** variants of every screen.

---

## Authentication & onboarding

### Sign in (`/login`)
- Fields: **Identifier** (username *or* email), **Password**.
- Primary CTA: Sign in.
- Footer link: "New here? Create account".
- Secondary link: Download desktop app.
- States: inline error notice (bad credentials).

### Sign up wizard (`/signup`) — 5 steps with a progress rail
1. **Persona selection** — full-width cards: Just me (🧍, redirects to download),
   Manage a team (👥), Manage a family (👨‍👩‍👧). Step dots indicator.
2. **Account creation** — Display name, Identifier (email/username), Password (8+ chars).
   Live validation: username/email uniqueness, password strength. Back + Continue.
3. **Organization setup** — Organization name (Team/Family name; placeholder varies by
   persona). Continue.
4. **Add members** — inline add form: Display name, Login (email/username), Temporary
   password. Auto-suggested username (e.g. `yojeecorp_emp1`), generate-password button.
   Add / Skip. Added-members list below each row: ✓ Name, Login, hidden Password, with
   **Copy credentials** and **Remove** actions. Member count summary. Finish / Skip.
5. **Success** — SuccessBurst checklist: ✓ Account created, ✓ Organization ready,
   ✓ Members added (if any). "Go to dashboard" CTA.

---

## Protected app (post-login)

### Dashboard (`/`)
- **Business picker** dropdown (select team/family) in header.
- Roster table — columns: Name (with **"Self"** badge for own account), Login
  (email/username), Last seen (relative time), Active today (duration), View link.
- Row action: View → Employee Detail.
- States: empty ("No activity yet"), loading spinner, error notice.

### Employees / Kids (`/employees`) — persona-aware title
- Business picker + action buttons: **New Business** (modal), **Add Employee/Kid** (modal).
- Notice if no business yet; success banner if a business was auto-created.
- Roster table — columns: Name, Login, View Reports link. Empty state: "No members yet".
- **New Business modal**: Name field, Create / Cancel.
- **New Employee/Kid modal** (persona-aware heading): Display name, Username/Email,
  Temporary password. Notice if no business selected ("will auto-create a business").
  Inline validation errors. Add / Cancel.

### Employee / Kid detail (`/employees/:id`)
- Breadcrumb: Dashboard / [member term].
- Header: member name + email/username + **date mode toggle**:
  - Single day picker (date input), or
  - Date range (From / To date inputs).
- **Summary cards** (4): Active time (day or range), Top app, Keypresses, Screenshots.
- **Tabbed report panels** (4):
  - **Activity** — app/window breakdown by duration (chart + list).
  - **Keystrokes** — keystroke count timeline / heatmap.
  - **Browser** — visits grouped by domain + time spent.
  - **Screenshots** — gallery of captured shots with timestamps.
- States: loading spinner; "No business context" notice; date-range error.
- Data: switching date mode/range fires 4 parallel report requests.

### Settings (`/settings`) — persona-aware, scoped per business
- Business picker at top; heading "Settings for [Business] [members/kids]".
- **Capture policy** — segmented toggle: Locked / Allow override. Saves on click.
- **Screenshot interval** — segmented: 1 / 5 / 10 / 15 min. Saves on click.
- **Idle threshold** — segmented: 1 / 3 / 5 min. Saves on click.
- **Screenshot retention** — segmented: 7 / 14 / 30 / 90 days / Never. Saves on click.
- **Manual cleanup** — "Clean up now" → confirm modal (preset 7/14/30/90, warning text,
  Delete / Cancel). Result: "Deleted X files, freed Y MB".
- **Account info** (read-only): Email, Display name.
- All save ops show inline success/error notices.

---

## Shared components to design
Business picker dropdown, roster data table, summary stat cards, tabbed report panels,
date pickers + range toggle, segmented controls, switches, modals, confirm dialog, badges
("Self", status), empty/loading/error states, inline notices, screenshot gallery/lightbox.
