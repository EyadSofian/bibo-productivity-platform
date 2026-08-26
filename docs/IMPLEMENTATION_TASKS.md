# IMPLEMENTATION_TASKS.md — MASTER TASK FILE

The single source of truth for what is done and what is next. Update this file
**before** starting work and **after** finishing it.

**Rules**
1. Never mark a feature `DONE` unless every Definition-of-Done box is ticked.
2. If a task depends on unfinished infrastructure, mark it `BLOCKED` and say what
   unblocks it.
3. Before starting a major feature: check this file → confirm dependencies are
   `DONE` → run existing tests → implement → test → update docs → commit.
4. Work incrementally. Smallest working change first.
5. Statuses: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `READY FOR TEST` · `DONE`.

**Baseline facts every task must respect**
- The API is currently at `/v1`, not `/api/v1`. Deployed agents depend on `/v1`.
- Keyboard capture is **count-only** on both platforms and must stay that way.
- Idle time is **not stored anywhere** today. F5 introduces it; nothing before F5
  can report idle time honestly.
- Tenant scoping today is owner-only via `businesses.owner_user_id`. F25 replaces it.
- There is **no CI**. F1 adds it; until then, every check is manual.

---

## Prioritized implementation order

```
 1. F1   Baseline stability          ← start here (includes CI + the :8080/:8090 fix)
 2. F37  Release process             ← cheap, do alongside F1
 3. F33  Privacy safeguards          ← small, protects the product's core promise
 4. F4   Browser monitoring          ← fixes the reported "browser_visit: []" defect
 5. F5   Activity engine             ← the foundation everything else computes on
 6. F7   Employee job roles          ← required by F6
 7. F6   Productivity classification
 8. F8   Productivity score
 9. F21  REST API /api/v1            ← do before the surface grows further
10. F24  Authentication hardening
11. F25  Roles and permissions
12. F26  Audit log
13. F28  Database performance
14. F14  Screenshots → object storage
15. F13  Employee timeline
16. F9   Focus score  →  F10 Efficiency score
17. F11  Employee dashboard  →  F12 Company dashboard
18. F29  Background jobs  →  F18 Rules  →  F19 Alerts  →  F20 Reporting  →  F27 Retention
19. F15  Playback  →  F16 Presence
20. F22  Webhooks  →  F23 AI-ready analytics
21. F30–F36, F38, F39  Production readiness
22. F17  Live screen view            ← last, after RBAC + audit are proven
23. F2 / F3  Platform verification   ← run continuously; F2 is hardware-blocked
```

---
---

## F1 — Baseline stability

**Status:** IN PROGRESS · **Priority:** P0 · **Depends on:** —

### Progress log
- **2026-08-26 — port drift fixed (defect D-1).** `.env.example` now sets
  `PORT=8090`, matching `scripts/dev-backend.sh`, the web-admin Vite proxy and the
  desktop's local default. `README.md` quick start corrected. `docker-compose.yml`
  now publishes host `:8090` → container `:8080` so the compose path lines up too.
  `scripts/dev-backend.sh` now reads the port from `.env` and announces the real
  value, warning when it disagrees with `:8090` — so an already-cloned repo with a
  stale `.env` gets told, and this class of drift cannot silently recur. Verified
  end-to-end against a stubbed `go` for fresh-clone, stale-`.env` and missing-`PORT`
  cases.
- **2026-08-26 — CI added.** `.github/workflows/ci.yml` with five jobs: `backend`
  (Go build/vet/test with a Postgres service), `monitor` (non-blocking, see note in
  the file), `frontend` (pnpm install/typecheck/build/test + extension manifest
  validation), `desktop` (Rust check/test on **macOS and Windows**; clippy advisory),
  `security` (govulncheck / cargo audit / pnpm audit, advisory). Plus
  `.github/scripts/check-extension-manifest.mjs`, which enforces the extension's
  privacy posture (MV3, loopback-only hosts, no permission creep, no
  `content_scripts`) and is negative-tested against 6 regression cases.
  **Not yet observed running** — no Go/Rust toolchain here, so the first push is its
  real verification.
- **2026-08-26 — `/healthz` now checks the database (defect D-11).** Pings the pool
  and reports the highest applied goose version, returning 503 when the database is
  unreachable so an orchestrator stops routing to a backend that cannot serve a
  query. The probe is bounded at 2 s, and the response carries no error detail —
  the endpoint is unauthenticated and pgx errors embed the DSN. 4 handler tests
  cover it, including the no-leak guarantee. *Written, not compiled (B-1).*
- **2026-08-26 — Go database test harness added.** `internal/testutil` hands tests a
  migrated, empty database from `TEST_DATABASE_URL` (already provisioned by the CI
  `backend` job); tests skip themselves when it is unset, so `go test ./...` still
  passes with no Postgres. Each test holds a session advisory lock, because package
  test binaries run concurrently against one database and would otherwise truncate
  each other's rows mid-assertion. The lock wait is bounded so the
  `Pool`-twice-in-one-test case fails with a readable message instead of hanging.
  First store tests landed: identifier normalization, duplicate rejection, login by
  email **or** username, business resolution (including that naming a business you
  do not belong to is refused), and the sync ingest path — idempotent resend,
  respect-local overwrite, caller-stamped ownership, device registration on an empty
  batch. *Written, not compiled (B-1).*
- **2026-08-26 — web-admin has a test runner.** Vitest + jsdom + Testing Library, and
  the three smoke suites this feature asks for. **13 tests, all passing locally** —
  the first executed test signal on this branch. `pnpm -r typecheck` and
  `pnpm -r build` remain clean. The CI `pnpm -r --if-present test` step is no longer
  a no-op.
- **2026-08-26 — drift D3 and a security-guidance gap closed.** `windows.rs` no longer
  claims keyboard counting is stubbed (it has been implemented for some time) and now
  names the session-event gap that genuinely remains, pointing at F2. `.env.example`
  says what a production `JWT_SECRET` must be and how to generate one.

### Goal
Make the existing platform provably run and stay running, with automation that
catches regressions, before any feature work begins.

### Current implementation
Four apps that build (TS verified here) but have never been run end-to-end in this
environment. 6 Go tests (auth, obs only), 27 Rust tests, 0 TS tests, 0 integration
tests, no CI. `.env.example` sets `PORT=8080`; `scripts/dev-backend.sh` announces
`:8090`; `apps/web-admin/vite.config.ts` proxies to `:8090`.

### Missing pieces
- Working out-of-the-box local dev (port drift).
- Go, Rust, Docker, Postgres on the dev machine.
- Any CI.
- Handler/store test infrastructure for Go.
- Any frontend test runner.
- A real health check.
- A recorded baseline verification.

### Architecture
No architectural change. Add `apps/backend/internal/testutil` for a disposable
Postgres harness; add Vitest to `web-admin` and `desktop`; add
`.github/workflows/ci.yml` with four parallel jobs.

### Backend tasks
- [x] Fix `PORT` drift: `.env.example` → `8090`. README, script, proxy, desktop
      default, CLAUDE.md and docker-compose now agree. `dev-backend.sh` reports the
      port it actually configured and warns on mismatch.
- [x] `/healthz` pings the pool and reports database status + applied schema version,
      returning 503 when unreachable. Bounded probe, no error detail in the body.
- [x] Add `internal/testutil` — migrated database from `TEST_DATABASE_URL`, truncated
      per test, serialized across packages by advisory lock, skipped when unset.
- [x] First store tests: `CreateUser`, `GetUserByIdentifier`, `ResolveBusinessForUser`,
      `SyncBatch` idempotency. *(written; CI runs them first)*
- [ ] First handler tests: register → login → `/v1/me`.
- [ ] `go vet ./...` clean. *(in CI; not yet observed)*

### Desktop tasks
- [ ] `cargo check` and `cargo test` clean on macOS.
- [ ] `cargo clippy -- -D warnings` clean (or record an agreed allowlist).
- [ ] Verify the app launches, requests permissions, and writes to `data.db`.
- [x] Fix the stale "M2 is stubbed" comment in `platform/windows.rs`.

### Web dashboard tasks
- [x] Add Vitest + Testing Library to `apps/web-admin`.
- [x] Smoke tests: `tokenStore` persistence, `client.ts` refresh single-flight,
      `ProtectedRoute` redirect. **13 tests passing.**
- [x] `pnpm typecheck` and `vite build` wired into CI.

### Database tasks
- [ ] Confirm all 9 migrations apply cleanly to an empty database.
- [ ] Confirm every `-- +goose Down` actually reverses its `Up`.

### API tasks
- [ ] Document the current 24 routes in `docs/API_CURRENT.md` (input, output, auth).

### Security tasks
- [x] Confirm `JWT_SECRET` has no default and boot fails without it. *(verified: it does)*
- [x] Confirm no secrets are committed. *(verified: `.env` is gitignored)*
- [x] Add a `.env.example` comment requiring a ≥32-byte random `JWT_SECRET` in prod,
      with the command to generate one.

### Unit tests
- [ ] Existing 6 Go + 27 Rust tests pass. *(cannot run here — B-1)*
- [ ] New store/handler tests pass. *(written; CI is the first run)*
- [x] New frontend smoke tests pass. **13/13 locally.**

### Integration tests
- [ ] register → create business → create employee → employee login →
      `POST /v1/sync/batch` → `GET /v1/reports/employees/{id}/activity` returns the row.
- [ ] Screenshot upload → metadata row + file on disk → `GET /v1/screenshots/{uuid}`
      returns the bytes.

### Desktop tests
- [ ] Offline collection: kill the backend, generate activity, confirm rows persist
      with `synced = 0`.
- [ ] Offline → online: restart the backend, confirm the queue drains and rows flip
      to `synced = 1`.

### API tests
- [ ] Each of the 24 routes returns 401 without a token.
- [ ] Owner A cannot read Owner B's employees, screenshots or reports.

### UI tests
- [ ] Login → dashboard → employee detail renders with seeded data.

### Manual verification
- [ ] `scripts/dev-db.sh` starts Postgres.
- [ ] `scripts/dev-backend.sh` starts and runs migrations.
- [ ] `scripts/dev-web.sh` serves `/admin/` and the API proxy works.
- [ ] `scripts/dev-desktop.sh` launches the tracker.
- [ ] Owner registration, employee creation, employee login all work.
- [ ] Activity, screenshots and keystroke counts appear in the dashboard.
- [ ] Extension connects (popup shows linked) and browser visits appear.

### Performance tests
- [ ] Record a baseline: backend RSS at idle, desktop CPU at idle, one sync pass
      duration with 1000 pending rows.

### Definition of Done
- [ ] Local dev works from a clean clone following the README, with no manual fixes.
      *(port drift resolved; still needs an end-to-end run once Go/Docker are installed)*
- [ ] CI runs on every push: Go build+test+vet, Rust check+test+clippy,
      web-admin typecheck+build+test, desktop typecheck+build.
      *(workflow written and locally dry-run where possible; the first push verifies it)*
- [ ] `BASELINE_TEST_REPORT.md` records every component with pass/fail and evidence.
- [ ] All documentation drift D1–D9 is either fixed or explicitly recorded.

---

## F2 — Windows production support

**Status:** NOT STARTED (expected `BLOCKED` — no Windows hardware available)
**Priority:** P0 · **Depends on:** F1

### Goal
Establish, by testing rather than assertion, whether the Windows agent is production
ready — and make it so.

### Current implementation
`platform/windows.rs` (168 lines): idle via `GetLastInputInfo` + `GetTickCount`
(wrap-safe), key counting via `WH_KEYBOARD_LL` with a message pump, capability rows
derived from in-app opt-outs. Active window and screenshots come from the
cross-platform `active-win-pos-rs` / `xcap`. `permission_status()` returns `Granted`
unconditionally.

### Missing pieces
Lock/unlock detection · sleep/resume detection · user switching · multi-monitor
verification · DPI handling · installer and uninstaller verification · app-data path
verification · update mechanism verification · token file ACLs · tray behaviour
verification.

### Architecture
Add a Windows session-event listener: a hidden message window registered with
`WTSRegisterSessionNotification` (`WM_WTSSESSION_CHANGE`) and
`WM_POWERBROADCAST`, mapping OS notifications to `session_event` rows (shared model
with F5).

### Backend tasks
- [ ] Accept `session_event` in the sync batch (shared with F5).

### Desktop tasks
- [ ] Hidden message window + `WTSRegisterSessionNotification`.
- [ ] Map `WTS_SESSION_LOCK/UNLOCK/LOGON/LOGOFF` → `session_event`.
- [ ] Map `PBT_APMSUSPEND` / `PBT_APMRESUMEAUTOMATIC` → `session_event`.
- [ ] Verify multi-monitor capture including mixed DPI.
- [ ] Restrict `session.json` ACLs to the current user (or use DPAPI — see F24).
- [ ] Verify tray icon is always visible (no stealth).
- [ ] Verify app-data path resolution under roaming profiles.

### Web dashboard tasks
- [ ] Windows-accurate consent copy on the permissions/consent screen.

### Database tasks
- [ ] `session_events` table (shared with F5).

### API tasks
- [ ] `session_event` in `POST /api/v1/sync/batch`.

### Security tasks
- [ ] Confirm the keyboard hook never reads `lParam`. *(verified today: it does not)*
- [ ] Confirm token file is not world-readable.

### Unit tests
- [ ] Session-notification → `session_event` mapper.
- [ ] `GetTickCount` wraparound arithmetic.

### Integration tests
- [ ] Lock → unlock produces a `LOCKED` segment of the right duration.

### Desktop tests
- [ ] Windows 10 and Windows 11.
- [ ] Single monitor and multiple monitors.
- [ ] Sleep/wake · lock/unlock · network disconnect/reconnect · app restart ·
      machine restart · fast user switching.

### API tests
- [ ] `session_event` ingest validation and idempotency.

### UI tests
- [ ] Consent screen reflects actual opt-out state.

### Manual verification
- [ ] Installer installs; app auto-starts; tray icon present.
- [ ] Uninstaller removes the app and leaves no orphaned service.
- [ ] Auto-update N-1 → N succeeds silently (`installMode: quiet`).
- [ ] 8-hour real-use session produces coherent data.

### Performance tests
- [ ] Idle CPU < 1%, RSS < 150 MB, no handle/memory leak over 8 hours.

### Definition of Done
- [ ] Every item in the test matrix executed and recorded with OS build numbers.
- [ ] Lock, sleep and user-switch produce correct segments.
- [ ] Installer, uninstaller and updater verified.
- [ ] No stealth behaviour: the employee can always see the app is installed.

---

## F3 — macOS production support

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F1

### Goal
Verify and harden the macOS agent, especially permission lifecycle and recovery.

### Current implementation
`platform/macos.rs` (269 lines): non-prompting preflight for all three TCC
permissions (`AXIsProcessTrusted`, `IOHIDCheckAccess`,
`CGPreflightScreenCaptureAccess`); prompting request calls; per-permission
`x-apple.systempreferences:` deep links with a root-pane fallback; a listen-only
CoreGraphics key-down tap that re-enables itself after
`kCGEventTapDisabledByTimeout`. Permissions are deliberately **not** requested at
startup — the UI routes the user to a screen where every request is user-initiated.
This is good design; keep it.

### Missing pieces
Sleep/wake and lock/unlock notifications · permission-revoked-mid-session recovery ·
version matrix testing · window titles when Screen Recording is absent.

### Architecture
Subscribe to `NSWorkspace` `willSleep`/`didWake` and the distributed notifications
`com.apple.screenIsLocked` / `com.apple.screenIsUnlocked`; emit `session_event`.

### Backend tasks
- [ ] (shared with F2/F5) accept `session_event`.

### Desktop tasks
- [ ] `NSWorkspace` sleep/wake observer → `session_event`.
- [ ] Distributed lock/unlock observer → `session_event`.
- [ ] Permission watcher: detect a revoked grant and surface recovery UX.
- [ ] Handle "Screen Recording missing → no window titles" explicitly in the UI
      rather than silently recording `None`.

### Web dashboard tasks
- [ ] None.

### Database tasks
- [ ] `session_events` (shared).

### API tasks
- [ ] None beyond F5.

### Security tasks
- [ ] Confirm the event tap remains `kCGEventTapOptionListenOnly`. *(verified)*
- [ ] Confirm no keycode is decoded. *(verified)*

### Unit tests
- [ ] Notification → `session_event` mapper.
- [ ] Permission state machine transitions.

### Integration tests
- [ ] Lock → unlock produces a `LOCKED` segment.

### Desktop tests
- [ ] Each supported macOS major version.
- [ ] Grant each permission, revoke each permission mid-session, re-grant.
- [ ] Multi-monitor, sleep/resume, app restart, login-item startup.

### API tests
- [ ] None beyond F5.

### UI tests
- [ ] Permissions screen reflects live OS state; recovery path is reachable.

### Manual verification
- [ ] Fresh install: all three prompts appear only when the user asks.
- [ ] Revoking Screen Recording stops screenshots and shows a clear message.
- [ ] App restarts cleanly after a permission change.

### Performance tests
- [ ] Idle CPU < 1%, RSS < 150 MB, no leak over 8 hours.

### Definition of Done
- [ ] Version matrix executed and recorded.
- [ ] Permission recovery works for all three permissions.
- [ ] Lock and sleep produce correct segments.

---

## F4 — Browser monitoring

**Status:** IN PROGRESS · **Priority:** P0 · **Depends on:** F1

### Progress log
- **2026-08-26 — extension side rewritten; D-2, D-3, D-6, D-7, D-14 closed.**
  The logic moved out of `background.js` into `apps/extension/lib/` — `visit.js`
  (state machine), `outbox.js` (durable queue), `browsers.js` (identification) — all
  pure: no Chrome APIs, no clock, no I/O. `background.js` is now glue. This is what
  made the extension testable and **closes blocker B-5**.
  - A **60 s checkpoint alarm** closes and reopens the running visit, so a tab left
    open reports time as it accrues (D-2). Chunking matches the desktop's existing
    60 s activity chunking, so both sources are shaped alike.
  - A **durable outbox** in `storage.local` is written *before* any send and drained
    only on acceptance (D-3). Capped at 500, oldest-evicted, evictions reported.
  - **Tab close** now closes and flushes (D-6); **`chrome.idle`** stops the clock
    after 60 s without input (D-7); **browser identification** distinguishes Edge,
    Opera, Vivaldi, Brave, Firefox and Safari (D-14).
  - `domain` is now sent as a first-class field.
  - Each segment carries a `client_uuid`. Nothing dedupes on it yet — the desktop
    assigns its own id on insert — so a send whose response is lost can still
    duplicate. Shipping the field now means the eventual local upsert does not also
    need a Web Store release.
  - **62 tests, all passing**, including an integration suite that drives the real
    service worker against a fake Chrome and a fake desktop app. It caught a real
    bug during development: the tab-close path queued a visit but never flushed it.
  - Manifest is now a module service worker (required by the `lib/` imports); the CI
    guard enforces both that and the narrow `idle` permission.
  - **Not yet done:** batch ingest, the local `client_uuid` upsert, the websites
    panel, and the full manual browser matrix. See the unticked boxes.
- **2026-08-26 — `domain` stored, derived server-side.** Migration `00010` adds
  `browser_visits.domain` with a backfill and a `(business_id, domain, ts)` index;
  `store.DomainOf` computes it during ingest. `BrowserRow` has no Domain field on
  purpose, so a client cannot file a visit under a domain other than its URL's —
  which is why the planned "accept `domain` in the sync batch" task was dropped
  rather than implemented. The desktop needs no change. `domain` is now returned by
  the browser report. *Go written, not compiled (B-1); TypeScript verified.*

### Goal
Make browser data trustworthy. Eliminate the confirmed causes of `"browser_visit": []`.

### Current implementation
`apps/extension/background.js` (MV3, ~200 lines). Discovers the desktop app by
probing 6 fixed ports and reading a token from `GET /whoami`. Tracks a "current
visit" in `chrome.storage.session`. Writes a visit **only** from `transition()`,
called by `tabs.onActivated`, `tabs.onUpdated`, and `windows.onFocusChanged`.
`postVisit` drops the visit permanently if the desktop app is unreachable.
The desktop side (`server/mod.rs`) validates a token header, rejects web origins,
applies pause and domain-only rewriting, and writes to SQLite.

### Missing pieces
- ~~**Periodic checkpoint**~~ — done 2026-08-26 (60 s alarm).
- ~~**Durable outbox**~~ — done 2026-08-26 (capped, write-before-send).
- ~~**Tab-close / browser-close flush**~~ — done 2026-08-26.
- ~~**Idle awareness** (`chrome.idle`)~~ — done 2026-08-26.
- ~~Accurate browser identification~~ — done 2026-08-26. Arc remains
  indistinguishable from Chrome; it exposes no marker to detect.
- `domain` as a first-class field — **sent by the extension**; not yet stored by the
  desktop or the backend.
- `active_tab` flag — deliberately deferred. The extension only ever tracks the
  focused tab, so the field would be a constant `true` until background-tab tracking
  exists. Adding it now would encode a value that means nothing.
- Batch ingest endpoint (still one HTTP POST per visit). The outbox already flushes
  in bounded passes, so this is now a throughput optimization rather than a
  correctness gap.
- Local `ON CONFLICT(client_uuid)` upsert, so a resend after a lost response cannot
  duplicate a row.

### Architecture
```
tab events ─┐
idle events ─┼─▶ visit state machine ─▶ outbox (chrome.storage.local, capped ring)
alarm (60s) ─┘                                │
                                              ▼
                                   batch POST /ingest  (retry w/ backoff)
                                              │
                                   desktop SQLite browser_visit
```
The state machine emits a **closed segment** on: tab change, URL change, window
focus change, tab close, idle start, checkpoint alarm, and worker suspend. Segments
are appended to the outbox first, then flushed — so a failed POST never loses data.

### Backend tasks
- [x] Add `browser_visits.domain` (+ backfill from `url`). Migration `00010`.
      `active_tab` deliberately not added — see Missing pieces.
- [x] Index `(business_id, domain, ts)`.
- [x] ~~Accept `domain` … in `POST /v1/sync/batch`~~ — **derived instead.**
      `store.DomainOf` computes it during ingest and `BrowserRow` has no Domain
      field, so a client cannot file a visit under a domain other than its URL's.
      This is strictly better than accepting the field, and needs no agent change.
- [x] Expose `domain` on the existing browser report.

### Desktop tasks
- [ ] `POST /ingest` accepts an **array** of visits (keep single-object support).
      *(now a throughput optimization: the outbox already flushes in bounded passes)*
- [x] ~~Derive and store `domain` server-side too (never trust the client alone).~~
      Done in the backend, which is the authoritative store. The desktop passes the
      URL through unchanged and needs no schema change for this.
- [ ] Local `ON CONFLICT(client_uuid)` upsert (SQLite v3) so a resend after a lost
      response cannot duplicate a row. The extension already sends `client_uuid`.
- [ ] Reconcile browser visits against activity samples — browser data is a
      *refinement* of an ACTIVE segment, never additional time (see F5 rule).
- [ ] Rotate the ingest token on app start and expose it only over loopback
      *(review `/whoami`: any local process can read the token — see SECURITY_REVIEW S-4)*.

### Web dashboard tasks
- [ ] Websites panel grouped by domain with durations and category (post-F6).

### Database tasks
- [x] Migration `00010`: `domain` + backfill + `(business_id, domain, ts)` index.
      `active_tab` omitted on purpose.
- [ ] SQLite v3: unique index on `client_uuid`, for the local upsert above.

### API tasks
- [ ] `GET /api/v1/employees/{id}/websites` with domain rollup and pagination.

### Security tasks
- [x] Verify no cookies, form data, page content or auth tokens are ever read.
      *(only `url`, `domain`, `title`, `ts`, `duration`, `browser` — and the CI
      manifest guard now rejects `content_scripts` / `web_accessible_resources`,
      so page access cannot be reintroduced quietly)*
- [x] Verify the extension never talks to any non-loopback host.
      *(guard enforces loopback-only `host_permissions`)*
- [x] Cap outbox size so a long offline period cannot exhaust extension storage.
      *(500 segments, oldest-evicted, eviction reported)*

### Unit tests
- [x] Visit state machine: every transition, including idle-start mid-visit.
      *(23 tests, incl. clock-skew and same-URL refocus)*
- [x] Outbox: append, flush, partial-failure retry, cap eviction. *(12 tests)*
- [x] Browser identification for Chrome, Edge, Brave, Opera, Vivaldi. *(13 tests)*
      Arc is **not** covered: it ships Chrome's user agent with no distinguishing
      marker, so it is not detectable and is reported as Chrome.
- [x] A `domain()` extractor including punycode, ports, IP hosts and
      `about:`/`chrome://` rejection. `origin_only()` in Rust is unchanged.

### Integration tests
- [ ] Extension → desktop → SQLite → backend → report, for a single visit.
      *(blocked: needs a running desktop app and backend — B-1)*
- [x] Desktop app restarted mid-session: no visits lost. *(verified against a fake
      app that goes down and returns; the outbox drains on reconnect)*
- [x] Rapid tab switches produce correctly-bounded visits. *(20 switches, each
      attributed to the right URL with the right duration)*

### Desktop tests
- [ ] Loopback server rejects a bad token, a web origin, and an oversized batch.
- [ ] Pause suppresses visits but not markers.

### API tests
- [ ] `websites` endpoint: pagination, date filter, tenant isolation, empty range.

### UI tests
- [ ] Websites panel renders domains, durations and categories.

### Manual verification
- [ ] Tab switching · multiple windows · incognito (per policy) · YouTube · GitHub ·
      Google · a SaaS app · browser minimized · browser closed · computer idle ·
      rapid tab switching.
- [ ] **Watch one tab for 30 minutes without switching — rows must appear.**
      *(This is the specific regression that produced `"browser_visit": []`.)*

### Performance tests
- [ ] Extension CPU and memory during 500 tab switches.
- [ ] Outbox flush with 1000 queued visits.

### Definition of Done
- [x] A 30-minute single-tab session produces continuous, correctly-bounded rows.
      *(proven in test: 30 checkpoints, 1800 s total, no gaps between segments.
      Still needs the manual run against a real browser before F4 is DONE.)*
- [x] Visits survive a desktop-app restart with zero loss. *(proven in test)*
- [x] Idle time inside the browser is not counted as browsing time. *(proven in test)*
- [ ] Chrome and Edge both verified against the full manual matrix.
- [x] No page content, cookies or credentials are captured — proven by test.
      *(CI guard rejects the manifest keys that would allow it)*

**Not DONE.** The extension half is complete and tested; the desktop/backend half
(`domain` + `active_tab` columns, batch ingest, websites panel, local upsert) and the
entire manual matrix remain. Do not mark this feature DONE on the strength of the
automated tests alone.

---

## F5 — Activity engine

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F1, F4
**⚠ Highest-risk feature. Everything downstream is arithmetic on its output.**

### Goal
A single normalized, non-overlapping, gap-explained model of an employee's time,
from which every metric is derived so no two numbers can disagree.

### Current implementation
`trackers::WindowTracker::tick` — a well-tested pure function producing
active-only intervals. `duration_s` counts active seconds; intervals flush on
app/title change, foreground loss, 60 s chunk cap, or idle. `close_idle` subtracts
the entire idle threshold from the accumulated duration.

### Missing pieces
- **Idle is never persisted.** No table, no rows. `idle_time` is currently
  unanswerable.
- **Up to `idle_threshold_s` of real active time is discarded per idle transition.**
- Idle / locked / asleep / agent-offline are indistinguishable.
- No mouse activity counter.
- Activity samples and browser visits overlap with no de-duplication.
- Day boundaries are hard-coded UTC (`reports.go` `Roster`).

### Architecture
See ARCHITECTURE_TARGET §3. Agent emits `idle_period`, `input_sample` and
`session_event`; backend `internal/activity` builds a segment list and derives all
metrics from it. The segment builder is pure and DB-free.

### Backend tasks
- [ ] `internal/activity`: `BuildSegments(samples, idles, sessions, visits, opts) []Segment`.
- [ ] Overlap resolver (later `client_updated_at` wins; loser truncated).
- [ ] Gap classifier (`< GAP_TOLERANCE_S` → IDLE; bounded by session events →
      LOCKED/OFFLINE; otherwise UNKNOWN).
- [ ] Metric derivation: `working_time`, `active_time`, `idle_time`,
      `activity_percentage`, per-app/window/domain durations.
- [ ] Midnight split in the employee's timezone.
- [ ] Ingest `idle_period`, `input_sample`, `session_event`.

### Desktop tasks
- [ ] SQLite v3 migration: `idle_period`, `input_sample`, `session_event`.
- [ ] Emit an `idle_period` on every idle transition **instead of discarding** the
      grace window (fixes the systematic undercount).
- [ ] Mouse-event counter — **count only**, mirroring the keyboard tap
      (macOS: add mouse event types to the existing tap mask; Windows:
      `WH_MOUSE_LL`). Never record coordinates.
- [ ] Emit `agent_start` / `agent_stop` session events.
- [ ] Keep writing `keystroke_bucket` during a transition period for compatibility.

### Web dashboard tasks
- [ ] None directly; consumed by F11–F13.

### Database tasks
- [ ] `idle_periods`, `input_samples`, `session_events` (mirroring the four
      existing sync tables: `client_uuid UNIQUE`, `user_id`, `business_id`,
      `device_id`, `client_updated_at`, `received_at`, `(business_id, ts)` and
      `(user_id, ts)` indexes).
- [ ] `users.timezone` (IANA, default from business).

### API tasks
- [ ] `GET /api/v1/employees/{id}/activity` returns the normalized segment model
      plus derived metrics.
- [ ] Sync batch accepts the three new row kinds.

### Security tasks
- [ ] Assert mouse capture stores **counts only** — no coordinates, no button
      identity, no timing patterns.
- [ ] Tenant scoping on all new ingest paths.

### Unit tests
- [ ] Two overlapping samples → correct truncation, total unchanged.
- [ ] Gap of exactly `GAP_TOLERANCE_S` and ±1 s.
- [ ] Gap bounded by lock/unlock → LOCKED; by agent_stop/start → OFFLINE;
      unexplained → UNKNOWN.
- [ ] Sample crossing midnight in a non-UTC timezone splits correctly.
- [ ] DST spring-forward and fall-back days.
- [ ] Browser visit overlapping an activity sample adds **zero** extra time.
- [ ] Two devices reporting simultaneously.
- [ ] Out-of-order and duplicate `client_uuid` arrival.
- [ ] `working = active + idle + unknown` invariant holds for every generated case
      (property test).

### Integration tests
- [ ] Agent generates activity + idle + lock; backend reports match a hand-computed
      expected value.
- [ ] Re-syncing the same batch changes no totals (idempotency).

### Desktop tests
- [ ] Idle transition emits an `idle_period` whose start is `now - threshold`.
- [ ] Mouse counter increments without a keyboard event.
- [ ] Local retention does not delete unsynced rows.

### API tests
- [ ] `activity` endpoint: date filters, tenant isolation, empty range, huge range
      rejected with a clear error.

### UI tests
- [ ] Deferred to F11/F13.

### Manual verification
- [ ] Work 1 hour with deliberate idle gaps; confirm reported active + idle matches
      observed reality within ±2 minutes.
- [ ] Lock the machine for 10 minutes; confirm a LOCKED segment of ~10 minutes.
- [ ] Quit the agent for 10 minutes; confirm OFFLINE, not idle.

### Performance tests
- [ ] Segment building for one employee-day (~5000 rows) < 50 ms.
- [ ] One business-day at 1000 employees < 30 s total.

### Definition of Done
- [ ] `working_time`, `active_time`, `idle_time` and `activity_percentage` are
      produced and reconcile exactly.
- [ ] No double-counting between apps and browser — proven by test.
- [ ] Idle, locked, asleep, paused and offline are distinguishable.
- [ ] Mouse activity is captured as counts only.
- [ ] Timezone-correct day boundaries.
- [ ] The cutover date is documented: data before it has no idle history and must
      never be presented as if it does.

---

## F6 — Productivity classification engine

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F5, F7

### Goal
Label every segment `PRODUCTIVE / NEUTRAL / UNPRODUCTIVE / UNCLASSIFIED` using an
admin-managed, hierarchical ruleset.

### Current implementation
None. Zero occurrences of "productivity" or "classification" in the codebase.

### Missing pieces
Everything: rule storage, resolution hierarchy, matchers, seed ruleset, admin UI,
recomputation on change.

### Architecture
Pure `classify(ctx Segment, rs *Ruleset) (Category, ruleID)`.
Resolution: **employee → role → department → company → global → UNCLASSIFIED**.
Within a scope, specificity: `url_pattern` > `domain` > `title_pattern` > `app`;
ties break on `priority`, then newest.

### Backend tasks
- [ ] `internal/productivity`: `Ruleset` loader (per business, cached, versioned).
- [ ] Matchers for app, domain, url_pattern, title_pattern.
- [ ] `classify()` with per-request memoization on `(app, domain, employee)`.
- [ ] Seed ruleset for a sensible default company policy.
- [ ] CRUD handlers + bulk import/export (CSV/JSON).
- [ ] Emit a `ruleset_version` bump on any change; enqueue recomputation (F29).

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Classification management page: list, filter by scope, create, edit, delete.
- [ ] "Classify this" action from the timeline and app/website lists.
- [ ] Unclassified-coverage indicator so low coverage is visible.

### Database tasks
- [ ] `classification_rules` (see ARCHITECTURE_TARGET §4.1) with
      `(business_id, scope, match_type)` index.
- [ ] `rulesets` version counter per business.

### API tasks
- [ ] CRUD `/api/v1/classifications`.
- [ ] `category` on activity, timeline, applications and websites responses.

### Security tasks
- [ ] Cap pattern length (e.g. 512 chars) and rule count per business.
- [ ] Go's `regexp` is RE2 — no catastrophic backtracking. **Do not** swap in a
      backtracking engine.
- [ ] Tenant scoping on all CRUD.

### Unit tests
- [ ] Every hierarchy level wins over the one below it.
- [ ] Specificity ordering within a scope.
- [ ] The spec's worked examples: VS Code/Developer→PRODUCTIVE;
      github.com/Developer→PRODUCTIVE; youtube.com/Developer→UNPRODUCTIVE;
      youtube.com/Marketing→NEUTRAL or PRODUCTIVE; Figma/Designer→PRODUCTIVE.
- [ ] No matching rule → UNCLASSIFIED (never a silent default to NEUTRAL).
- [ ] Invalid regex is rejected at write time, not at evaluation time.

### Integration tests
- [ ] Changing a rule recomputes affected summaries and old scores change accordingly.

### Desktop tests
- [ ] None.

### API tests
- [ ] CRUD 200/400/401/403/404; tenant isolation; pagination.

### UI tests
- [ ] Create a rule and see a segment's category change.

### Manual verification
- [ ] Classify a real day's data for two different roles and confirm the same app
      resolves differently per role.

### Performance tests
- [ ] Classifying 100 000 segments < 1 s with memoization.

### Definition of Done
- [ ] All four categories produced; hierarchy verified at every level.
- [ ] Admin can manage rules for app, domain, URL pattern and title pattern.
- [ ] Rule changes trigger recomputation.
- [ ] Unclassified coverage is visible, never hidden.

---

## F7 — Employee job roles

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F1

### Goal
Just enough organizational structure to drive classification and role-aware scoring.
**Not HR.**

### Current implementation
`memberships.role` is `owner|employee` only. No department or job-role concept.

### Missing pieces
`departments`, `job_roles`, assignment, filters, role baselines for F9.

### Architecture
`Business 1─* Department 1─* JobRole`; `Membership` optionally references one of
each. Example tree: Development → {Backend Developer, Frontend Developer};
Design → {UI Designer}; Marketing → {Content Creator}; Support → {Support Agent}.

### Backend tasks
- [ ] CRUD for departments and job roles, scoped to the business.
- [ ] Assign/unassign on membership.
- [ ] Role baseline fields for F9 (expected switches/hour, expected session length).

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Department/role management page.
- [ ] Assignment control on the employee page.
- [ ] Department and role filters on dashboards and reports.

### Database tasks
- [ ] `departments (id, business_id, name, created_at)` unique `(business_id, name)`.
- [ ] `job_roles (id, business_id, department_id, name, baseline jsonb, created_at)`.
- [ ] `memberships.department_id`, `memberships.job_role_id` (nullable,
      `ON DELETE SET NULL`).

### API tasks
- [ ] CRUD `/api/v1/departments`, `/api/v1/roles`.

### Security tasks
- [ ] Tenant scoping; a role from business A can never be assigned in business B.

### Unit tests
- [ ] Unassigned employee falls back to company rules.

### Integration tests
- [ ] Deleting a department nulls assignments and does not delete employees.

### Desktop tests
- [ ] None.

### API tests
- [ ] CRUD status codes; cross-tenant assignment rejected with 403/404.

### UI tests
- [ ] Assign a role and see it reflected on the employee page.

### Manual verification
- [ ] Build the example org tree end to end.

### Performance tests
- [ ] None required.

### Definition of Done
- [ ] Departments and roles are manageable and assignable.
- [ ] Filters work across dashboards and reports.
- [ ] No HR features crept in (no salary, hierarchy, reviews, or scheduling).

---

## F8 — Productivity score

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F5, F6

### Goal
Produce `productive_time`, `neutral_time`, `unproductive_time`,
`unclassified_time` and `productivity_percentage` from a **configurable** engine.

### Current implementation
None. Note: `RosterEntry.FocusPctToday` is a **misnomer** — it is
`60 × keystroke-buckets-with-input ÷ active_seconds`, i.e. keyboard coverage. It is
neither focus nor productivity. Rename or remove it during this work to avoid
entrenching a misleading metric.

### Missing pieces
Scoring config storage, the score computation, daily persistence, recomputation.

### Architecture
`internal/scoring` reads a versioned `scoring_config` and computes scores from the
F5 segment model plus F6 categories. Default:
`productivity_pct = productive_active_s / classified_active_s × 100`,
where `classified = productive + neutral + unproductive` (**unclassified excluded**
and reported separately).

### Backend tasks
- [ ] `internal/scoring` with a config-driven formula (never a hard-coded constant).
- [ ] Persist per-day scores with `scoring_config_id` and `ruleset_version`.
- [ ] Recompute path when config or ruleset changes.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Productivity breakdown (four buckets + percentage + coverage %).

### Database tasks
- [ ] `scoring_configs (id, business_id, name, weights jsonb, params jsonb, effective_from)`.
- [ ] Score and bucket columns on `activity_daily`.

### API tasks
- [ ] `GET /api/v1/employees/{id}/productivity?from&to`.

### Security tasks
- [ ] Only `manage_settings` may change scoring config (post-F25).

### Unit tests
- [ ] Formula correctness against hand-computed fixtures.
- [ ] Zero classified time → percentage is `null`, not `0` or a divide-by-zero.
- [ ] All-unclassified day reports 100% unclassified coverage.
- [ ] Buckets sum to classified active time.

### Integration tests
- [ ] Changing a classification rule changes the score for the affected day only.
- [ ] Stored `scoring_config_id` + `ruleset_version` reproduce the score exactly.

### Desktop tests
- [ ] None.

### API tests
- [ ] Date filters, tenant isolation, empty range.

### UI tests
- [ ] Breakdown renders and sums correctly.

### Manual verification
- [ ] Compare a hand-audited day against the computed score.

### Performance tests
- [ ] Daily scoring for 1000 employees completes inside the nightly window.

### Definition of Done
- [ ] All five values produced and reconciling.
- [ ] The formula is configurable, not hard-coded.
- [ ] Unclassified coverage is always reported alongside the score.
- [ ] The misleading `focus_pct_today` is renamed or removed.

---

## F9 — Focus score

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F5, F6, F7

### Goal
Measure sustained productive work in a way that does not punish legitimate job
behaviour.

### Current implementation
None.

### Missing pieces
Focus-session detection, switch-rate measurement, role baselines, the score itself.

### Architecture
A **focus session** is a maximal run of PRODUCTIVE segments with no idle
interruption longer than `focus_break_tolerance_s` and total length ≥
`focus_min_session_s`. Score inputs: total focus-session time, longest session,
session count, switches per productive hour **normalized against the role baseline**.

### Backend tasks
- [ ] Focus-session detector over the segment model.
- [ ] Switch-rate computation per productive hour.
- [ ] Role-baseline normalization from `job_roles.baseline`.
- [ ] Persist sessions and the daily score.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Focus Sessions list — e.g. "Deep Focus Session · VS Code · 42 minutes".

### Database tasks
- [ ] `focus_sessions (id, business_id, user_id, start_ts, end_ts, primary_app, switches)`.
- [ ] `job_roles.baseline` populated with expected switch rate and session length.

### API tasks
- [ ] `GET /api/v1/employees/{id}/focus-sessions?from&to`.

### Security tasks
- [ ] Tenant scoping.

### Unit tests
- [ ] Session boundaries at exactly the break tolerance and ±1 s.
- [ ] A session shorter than the minimum is not counted.
- [ ] **A support role at 40 switches/hour scores comparably to a dev role at 5
      switches/hour, given equal productive time.** This test is the feature's
      whole point.
- [ ] Missing role baseline falls back to a company default without crashing.

### Integration tests
- [ ] Sessions computed from real data match manual inspection.

### Desktop tests
- [ ] None.

### API tests
- [ ] Filters, tenant isolation, pagination.

### UI tests
- [ ] Sessions list renders with durations and apps.

### Manual verification
- [ ] Validate against two contrasting real roles before shipping.

### Performance tests
- [ ] Detection for one employee-day < 20 ms.

### Definition of Done
- [ ] Focus sessions detected and listed.
- [ ] Score is role-aware and demonstrably fair across contrasting roles.
- [ ] Documented as a behavioural indicator, not a performance verdict.

---

## F10 — Efficiency score

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F5, F8, F9

### Goal
A single configurable composite, honestly labelled.

### Current implementation
None.

### Missing pieces
Weight configuration, the composite, range aggregation, the disclaimer.

### Architecture
`Efficiency = w_a·Activity + w_p·Productivity + w_f·Focus + w_i·Idle`,
default `25 / 40 / 25 / 10`. Weights live in `scoring_configs.weights` and are
admin-editable. **Weekly and monthly efficiency are recomputed from component
totals, never averaged from daily scores** (averaging scores is mathematically wrong
when days have different durations).

### Backend tasks
- [ ] Weight resolution and normalization (must sum to 1; reject otherwise).
- [ ] Composite computation for daily / weekly / monthly / custom ranges.
- [ ] Recompute on weight change.
- [ ] Include `"metric_type": "organization_defined"` in every response.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Weight editor with live preview.
- [ ] Efficiency display always accompanied by the disclaimer.

### Database tasks
- [ ] `efficiency_score` on `activity_daily`; weights in `scoring_configs`.

### API tasks
- [ ] `GET /api/v1/employees/{id}/efficiency?period=daily|weekly|monthly|custom&from&to`.

### Security tasks
- [ ] Only `manage_settings` may change weights (post-F25); log changes to audit.

### Unit tests
- [ ] Weights not summing to 1 are rejected.
- [ ] A range with partial data reports coverage rather than silently scaling.
- [ ] Weekly ≠ naive mean of dailies when day lengths differ (assert the difference).
- [ ] A zero-length range returns `null`, not `0`.

### Integration tests
- [ ] Changing weights changes stored scores after recomputation.

### Desktop tests
- [ ] None.

### API tests
- [ ] All four period modes; tenant isolation; invalid period rejected.

### UI tests
- [ ] Weight editor persists; disclaimer is always present.

### Manual verification
- [ ] Confirm the disclaimer appears in both the UI and the raw API payload.

### Performance tests
- [ ] Monthly efficiency for 1000 employees < 5 s.

### Definition of Done
- [ ] Configurable weights, all four periods supported.
- [ ] Labelled as an organization-defined operational metric **in the API payload**,
      not only in the UI.
- [ ] Weekly/monthly recomputed from components, not averaged.

---

## F11 — Employee dashboard

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F8, F10, F13

### Goal
One page that answers "how is this person working?" without a manager needing to
cross-reference four panels.

### Current implementation
`EmployeeDetail.tsx` with four independent panels (activity, keystrokes, browser,
screenshots), each doing its own fetch. No scores, no timeline, no trends.

### Missing pieces
Overview with four scores and the time breakdown; Timeline; Applications; Websites;
Focus Sessions; Alerts; Trends. A single aggregate endpoint.

### Architecture
One `GET /api/v1/employees/{id}` overview call; sections lazy-load their own detail.

### Backend tasks
- [ ] Aggregate overview endpoint (scores + time breakdown + top apps/domains).

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Overview: Efficiency / Productivity / Activity / Focus; Working / Active /
      Idle; Productive / Neutral / Unproductive.
- [ ] Sections: Overview · Timeline · Applications · Websites · Activity ·
      Screenshots · Focus Sessions · Alerts · Trends.
- [ ] Date-range control shared across sections.
- [ ] Loading, empty and error states for every section.

### Database tasks
- [ ] Reads from `activity_daily` (F28).

### API tasks
- [ ] `GET /api/v1/employees/{id}?from&to`.

### Security tasks
- [ ] Screenshots section hidden without `view_screenshots` (post-F25).

### Unit tests
- [ ] Formatting helpers (durations, percentages) including zero and null.

### Integration tests
- [ ] Overview totals match the individual section endpoints.

### Desktop tests
- [ ] None.

### API tests
- [ ] Overview endpoint: filters, tenant isolation, missing employee → 404.

### UI tests
- [ ] Each section renders with seeded data.
- [ ] A day with no data renders a meaningful empty state, not a blank page.

### Manual verification
- [ ] Compare the page against the spec's example layout.

### Performance tests
- [ ] Page interactive in < 1.5 s on a 30-day range.

### Definition of Done
- [ ] All nine sections present and correct.
- [ ] One aggregate call for the overview (no N+1).
- [ ] Numbers reconcile with the timeline and with reports.

---

## F12 — Company dashboard

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F8, F10, F28

### Goal
A company-wide view that loads fast at 1000 employees.

### Current implementation
`Dashboard.tsx` backed by `store.Roster`, which runs **five correlated subqueries
per employee against raw `activity_samples`**. This will not scale.

### Missing pieces
Online/active/idle counts; averages; total active hours; leaderboards; the full
filter set; summary-backed queries.

### Architecture
All figures read from `activity_daily` / `activity_hourly`; presence counts from
F16 (until then, from `devices.last_seen_at` with an honest coarse-granularity note).

### Backend tasks
- [ ] Company rollup endpoint reading only summary tables.
- [ ] Replace the correlated-subquery roster query.
- [ ] Filters: today, yesterday, this week, last week, this month, custom,
      department, role, employee — all in the business timezone.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Rebuild with a filter bar and the metric tiles from the spec.
- [ ] Leaderboards: top performers, lowest efficiency, highest idle, highest
      unproductive — each behind `view_reports`.

### Database tasks
- [ ] Summary tables from F28.

### API tasks
- [ ] `GET /api/v1/reports/company?from&to&department_id&role_id`.

### Security tasks
- [ ] `view_all_employees` vs `view_team` scoping (post-F25).
- [ ] Leaderboards behind a permission and clearly labelled.

### Unit tests
- [ ] Week and month boundary computation in non-UTC timezones.

### Integration tests
- [ ] Company averages equal the mean of the individual employee values.

### Desktop tests
- [ ] None.

### API tests
- [ ] Every filter combination; tenant isolation; empty business.

### UI tests
- [ ] Filters change the data; leaderboards render.

### Manual verification
- [ ] Cross-check one metric by hand against raw data.

### Performance tests
- [ ] **p95 < 500 ms at 1000 employees over a 30-day range.**

### Definition of Done
- [ ] All spec metrics and filters present.
- [ ] No raw-table scans on dashboard load.
- [ ] Performance target met and recorded.

---

## F13 — Employee timeline

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F5, F6

### Goal
One chronological view merging apps, websites, idle, activity, screenshots and
alerts.

### Current implementation
None. `ActivityPanel` lists raw activity samples only.

### Missing pieces
The merge, ordering, pagination, zoom levels, and query optimization for long ranges.

### Architecture
Timeline entries derive from the F5 segment model, enriched with screenshots and
alerts by timestamp. Cursor pagination on `(ts, id)`. Resolution auto-selects:
raw segments for ≤ 2 days, hourly buckets beyond.

### Backend tasks
- [ ] Timeline builder merging segments + screenshots + alerts.
- [ ] Cursor pagination; documented max window per resolution.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Virtualized timeline with day/hour/minute zoom.
- [ ] Filters by entry type.
- [ ] Click a screenshot entry to open it in the gallery.

### Database tasks
- [ ] Covering indexes for the merge; hourly pre-bucketing for wide ranges.

### API tasks
- [ ] `GET /api/v1/employees/{id}/timeline?from&to&cursor&limit&types`.

### Security tasks
- [ ] Screenshot entries omitted without `view_screenshots`.

### Unit tests
- [ ] Merge ordering with identical timestamps is deterministic.
- [ ] Cursor pagination is stable when new data arrives mid-scroll.

### Integration tests
- [ ] Timeline entries reconcile with activity and screenshot endpoints.

### Desktop tests
- [ ] None.

### API tests
- [ ] Pagination, filters, tenant isolation, oversized range rejected.

### UI tests
- [ ] Renders the spec's example shape (09:00 VS Code, 09:42 Chrome – GitHub,
      10:02 Idle, …).

### Manual verification
- [ ] Scroll a full day and confirm nothing is missing or duplicated.

### Performance tests
- [ ] 30-day timeline first page < 800 ms.

### Definition of Done
- [ ] All six entry types merged and ordered.
- [ ] Long ranges perform within budget.
- [ ] Reconciles exactly with F5 and F11.

---

## F14 — Screenshots → object storage

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F1

### Goal
Move screenshot bytes out of local disk and out of the request path, without
breaking simple self-hosting.

### Current implementation
`internal/filestore` writes to `STORAGE_DIR/screenshots/<biz>/<user>/<date>/<uuid>.webp`
with UUID-validated path components (traversal-safe by construction) and atomic
temp+rename. Metadata in Postgres. Images served through an authenticated endpoint,
fetched by the SPA as blobs — one round-trip per thumbnail, no caching, no
thumbnails. Capture side already supports privacy mode (active window only), normal
mode (per display), a ~70-app skip-list, and ≤50 KB WebP.

### Missing pieces
Object storage · signed URLs · thumbnails · blur · admin controls for quality ·
skip-list applying to window titles.

### Architecture
`internal/blobstore.BlobStore` interface with `local` and `s3` implementations
(S3 / R2 / MinIO / B2), selected by `BLOB_BACKEND`.

### Backend tasks
- [ ] `BlobStore` interface: `Put`, `Get`, `Delete`, `SignedURL`.
- [ ] `local` impl wrapping the existing `filestore` (signed URL = HMAC'd path).
- [ ] `s3` impl (AWS SDK v2, works with R2/MinIO/B2 via endpoint override).
- [ ] Thumbnail generation on upload.
- [ ] Signed-URL minting with authorization check + audit record.
- [ ] Retention deletes from the blob store and the DB.

### Desktop tasks
- [ ] Optional blur mode.
- [ ] Skip-list also suppresses **window-title** capture (currently screenshots only).
- [ ] Admin-controlled quality respected.

### Web dashboard tasks
- [ ] Gallery uses signed URLs and thumbnails.
- [ ] Screenshot settings: interval, retention, quality, privacy mode, excluded apps.

### Database tasks
- [ ] `screenshots.storage_key`, `storage_backend`, `thumb_key`.
- [ ] Migration backfills existing rows as `backend='local'`, `storage_key=file_path`.

### API tasks
- [ ] Screenshot responses carry `url` and `thumb_url` (signed), not bytes.
- [ ] Keep `GET /v1/screenshots/{uuid}` working for compatibility.

### Security tasks
- [ ] TTL ≤ 300 s; URLs bound to the screenshot id; tamper-evident.
- [ ] Every mint audit-logged (F26).
- [ ] Verify a signed URL for business A is unusable by business B.
- [ ] Bucket must not be public; verify with an unauthenticated request.

### Unit tests
- [ ] Both impls pass the same interface conformance suite.
- [ ] Signed URL expiry and signature tampering rejected.
- [ ] Path safety preserved for `local`.

### Integration tests
- [ ] Upload → metadata + blob → signed URL → fetch succeeds; after TTL, fails.
- [ ] Retention removes both blob and row.

### Desktop tests
- [ ] Skip-listed app produces neither a screenshot nor a window title.
- [ ] Blur mode produces a blurred image.

### API tests
- [ ] Cross-tenant screenshot access → 404 (not 403 — don't leak existence).

### UI tests
- [ ] Gallery loads thumbnails quickly; lightbox loads the full image.

### Manual verification
- [ ] Run against MinIO locally and against one real S3-compatible provider.

### Performance tests
- [ ] Gallery of 100 thumbnails loads < 2 s.
- [ ] Storage growth model recorded (1000 employees × 96/day × 50 KB ≈ 4.8 GB/day).

### Definition of Done
- [ ] Both backends work; switching is config-only.
- [ ] Images never stored in Postgres.
- [ ] Signed URLs, short TTL, audited.
- [ ] Thumbnails in use.
- [ ] Skip-list covers titles as well as screenshots.

---

## F15 — Historical playback v1

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F13, F14

### Goal
A Teramind-like review experience built on **screenshots, not video** — the same
value at a fraction of the storage cost.

### Current implementation
None.

### Missing pieces
Frame assembly, player, prefetch, speed control.

### Architecture
A playback frame = `{ts, screenshot_url, thumb_url, app, window_title, url, domain,
state, key_count, mouse_count, category}`. Frames are screenshots joined to the
segment covering their timestamp. Gaps render as explicit gaps.

### Backend tasks
- [ ] Frame assembly endpoint over a bounded range.
- [ ] Frame index (timestamps only) for cheap scrubbing.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Player: play/pause, 1× / 2× / 5× / 10×, scrub bar with thumbnails.
- [ ] Side panel showing the metadata for the current frame.
- [ ] Prefetch thumbnails ahead of playhead; full image only on pause.

### Database tasks
- [ ] Index supporting `(user_id, ts)` frame lookup.

### API tasks
- [ ] `GET /api/v1/employees/{id}/playback?from&to`.
- [ ] `GET /api/v1/employees/{id}/playback/index?from&to`.

### Security tasks
- [ ] Requires `view_screenshots`; every playback session audit-logged.

### Unit tests
- [ ] Frame ↔ segment alignment when timestamps differ.
- [ ] A gap longer than the capture interval renders as a gap, not a stale frame.

### Integration tests
- [ ] Frames reconcile with the timeline.

### Desktop tests
- [ ] None.

### API tests
- [ ] Range limits, tenant isolation, permission enforcement.

### UI tests
- [ ] Play, pause, seek and each speed behave correctly.

### Manual verification
- [ ] Play back a real workday and confirm it reads coherently.

### Performance tests
- [ ] 10× playback over 8 hours does not exceed a documented bandwidth budget.

### Definition of Done
- [ ] Scrub, play/pause and all four speeds work.
- [ ] Every frame shows screenshot, app, website, title, activity, keyboard
      activity and productivity state.
- [ ] Gaps are honest.
- [ ] No continuous video recording introduced.

---

## F16 — Live employee presence

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F5, F21

### Goal
Know who is online, active, idle, offline or locked — now, cheaply.

### Current implementation
None. The roster's `last_seen` comes from `devices.last_seen_at`, updated only on
the 5-minute sync — far too coarse to call "live".

### Missing pieces
Heartbeat, state machine, offline timeout, SSE fanout, dashboard indicators.

### Architecture
Agent → `POST /api/v1/presence/heartbeat` every 30 s with `{state, app, since}`.
Backend keeps the latest per device in memory/Redis, persists periodically, and
derives state with a 90 s offline timeout. Dashboards subscribe over **SSE**.

### Backend tasks
- [ ] Heartbeat ingest (cheap; must not write to Postgres per beat).
- [ ] Presence state machine with configurable offline timeout.
- [ ] In-process SSE hub with per-tenant fanout.
- [ ] Periodic flush of presence to Postgres for durability.

### Desktop tasks
- [ ] Heartbeat sender independent of the sync worker.
- [ ] Report `LOCKED` where detectable (F2/F3).
- [ ] Backoff when the backend is unreachable; never spin.

### Web dashboard tasks
- [ ] Presence indicators on roster and employee pages.
- [ ] One SSE connection per dashboard session, with reconnect.

### Database tasks
- [ ] `device_presence (device_id PK, user_id, business_id, state, app, since, updated_at)`.

### API tasks
- [ ] `POST /api/v1/presence/heartbeat`, `GET /api/v1/presence`,
      `GET /api/v1/presence/stream` (SSE).

### Security tasks
- [ ] SSE authenticated and tenant-scoped; a client must never receive another
      business's events.
- [ ] Heartbeat rate-limited per device.

### Unit tests
- [ ] State transitions including the offline timeout boundary.

### Integration tests
- [ ] Agent stops → dashboard shows OFFLINE within the timeout.

### Desktop tests
- [ ] Heartbeat continues while paused (presence ≠ tracking).

### API tests
- [ ] Auth, tenant isolation, rate limiting.

### UI tests
- [ ] Indicators update live without a page refresh.

### Manual verification
- [ ] Two machines; observe transitions in real time.

### Performance tests
- [ ] **1000 agents × 30 s = ~33 heartbeats/s** sustained with no Postgres write
      amplification.
- [ ] 50 concurrent SSE dashboards.

### Definition of Done
- [ ] All five states reported.
- [ ] Updates are push-based, not polled.
- [ ] Load target met without per-heartbeat DB writes.

---

## F17 — Live screen view

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F16, F25, F26
**⚠ Build last. Highest security and ethical risk in the project.**

### Goal
Transparent, strictly-authorized, fully-audited live screen viewing.

### Current implementation
None.

### Missing pieces
Everything: capture pipeline, encoder, WebRTC, signalling, TURN, authorization,
employee indicator, audit.

### Architecture
`Screen Capture → Video Encoder → WebRTC → authorized manager's browser`.
Backend is signalling + TURN credential issuer only. Media never transits the
backend.

### Backend tasks
- [ ] `POST /api/v1/live/sessions` — permission check, creates `live_sessions` row,
      returns a one-time signalling token (≤60 s TTL, single-use, bound to
      session + employee + manager).
- [ ] Signalling relay (SDP/ICE) over the authenticated channel.
- [ ] TURN credential issuance with short TTL.
- [ ] Session close writes `end_ts`.

### Desktop tasks
- [ ] Screen capture + encode (H.264 / VP8 / VP9 per platform capability).
- [ ] Adaptive bitrate and resolution under bandwidth pressure.
- [ ] **Mandatory, non-dismissible on-screen indicator while streaming.**
- [ ] Refuse to stream if the indicator cannot be shown.
- [ ] Reconnect handling; stop on sleep/lock.

### Web dashboard tasks
- [ ] Viewer with connection state, bandwidth indicator, explicit start/stop.
- [ ] Clear notice that the session is logged.

### Database tasks
- [ ] `live_sessions (id, business_id, manager_id, employee_id, session_id,
      start_ts, end_ts, created_at)`.

### API tasks
- [ ] `POST /api/v1/live/sessions`, `DELETE /api/v1/live/sessions/{id}`,
      signalling endpoints.

### Security tasks
- [ ] Requires explicit `view_live_screen` — **never implied by any other permission.**
- [ ] Token is single-use and expires; replay must fail.
- [ ] Cross-tenant and cross-team access must fail.
- [ ] **No automatic recording of any kind.**
- [ ] Every session start and end audit-logged.

### Unit tests
- [ ] Token minting, single-use enforcement, expiry.
- [ ] Permission checks for every role.

### Integration tests
- [ ] Full session lifecycle produces exactly two audit entries.

### Desktop tests
- [ ] Indicator visible for the entire session on both platforms.
- [ ] Stream stops on lock/sleep.

### API tests
- [ ] Authorization bypass attempts: wrong role, wrong tenant, expired token,
      replayed token, another manager's session id.

### UI tests
- [ ] Viewer connects, displays, and stops cleanly.

### Manual verification
- [ ] Windows · macOS · multiple monitors · low bandwidth · reconnect ·
      employee sleep · manager disconnect · NAT · firewall.

### Performance tests
- [ ] CPU on the agent during a stream stays within the F31 budget.

### Definition of Done
- [ ] Streaming works across the full test matrix.
- [ ] Authorization cannot be bypassed — proven by explicit attack tests.
- [ ] Employee always sees the indicator.
- [ ] Nothing is recorded automatically.
- [ ] Every session is in the audit log with manager, employee, start, end, id.

---

## F18 — Rule engine

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F8, F10, F29

### Goal
Let admins express conditions over productivity data without writing code.

### Current implementation
None in this platform. (`apps/monitor` has an unrelated infrastructure alerting
engine — do not reuse or confuse it.)

### Missing pieces
Rule model, evaluator, scheduling, preview.

### Architecture
`Trigger · Condition · Evaluation Window · Action · Cooldown`. Declarative only —
**no arbitrary code or expression execution.** A fixed set of metrics, operators and
aggregations, validated at write time.

### Backend tasks
- [ ] Rule model + JSON schema validation.
- [ ] Safe evaluator over summary tables only.
- [ ] Scheduled evaluation (every 5 min) via F29.
- [ ] Preview: evaluate a draft rule against historical data.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Rule builder with preview ("this would have fired 4 times last week").

### Database tasks
- [ ] `rules`, `rule_evaluations` (for cooldown and dedupe state).

### API tasks
- [ ] CRUD `/api/v1/rules`; `POST /api/v1/rules/preview`.

### Security tasks
- [ ] `manage_productivity_rules` permission; changes audit-logged.
- [ ] No expression evaluation that could reach the database or the filesystem.

### Unit tests
- [ ] Each spec example: idle > 30 min; YouTube > 45 min/day; productivity < 50%
      for 2 h; efficiency drop > 20% vs 30-day average; unproductive > 2 h.
- [ ] Window boundary conditions.
- [ ] Cooldown suppresses a repeat within the window.
- [ ] Editing a rule does not retroactively fire for past data.

### Integration tests
- [ ] A rule fires and creates exactly one alert.

### Desktop tests
- [ ] None.

### API tests
- [ ] CRUD, validation rejection of malformed rules, tenant isolation.

### UI tests
- [ ] Builder creates a valid rule; preview returns counts.

### Manual verification
- [ ] Create each example rule and observe correct firing.

### Performance tests
- [ ] Evaluating 100 rules × 1000 employees < 60 s.

### Definition of Done
- [ ] All five example rules expressible and correct.
- [ ] Cooldown and evaluation windows work.
- [ ] Evaluation reads summaries only.

---

## F19 — Alerts

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F18

### Goal
Deliver rule outcomes without creating alert fatigue.

### Current implementation
None.

### Missing pieces
Alert lifecycle, severity, dedupe, cooldown, acknowledgement, delivery channels.

### Architecture
Rule fires → alert created with a `dedupe_key` → suppressed if an unacknowledged
alert with the same key exists inside the cooldown → otherwise dispatched to the
configured actions.

### Backend tasks
- [ ] Alert lifecycle: created → delivered → acknowledged → resolved.
- [ ] Severity `INFO / WARNING / HIGH`.
- [ ] Dedupe key + cooldown enforcement.
- [ ] Channels: dashboard notification, email, webhook (Slack/Teams later).
- [ ] Delivery retry with backoff and a delivery log.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Alert centre with filters and bulk acknowledge.
- [ ] Alerts tab on the employee page.
- [ ] Unread badge.

### Database tasks
- [ ] `alerts`, `alert_deliveries`.

### API tasks
- [ ] `GET /api/v1/alerts`, `POST /api/v1/alerts/{id}/acknowledge`.

### Security tasks
- [ ] Tenant scoping; alerts reference employees the caller may see.
- [ ] Email content must not leak sensitive detail to the wrong recipient.

### Unit tests
- [ ] Dedupe across evaluation cycles.
- [ ] Cooldown boundary.
- [ ] A flapping condition produces one alert, not fifty.

### Integration tests
- [ ] Rule → alert → delivery → acknowledgement, end to end.

### Desktop tests
- [ ] None.

### API tests
- [ ] List filters, pagination, tenant isolation, acknowledge idempotency.

### UI tests
- [ ] Alert centre renders and acknowledgement persists.

### Manual verification
- [ ] Trigger a flapping condition; confirm no spam.

### Performance tests
- [ ] 10 000 alerts listed with pagination < 300 ms.

### Definition of Done
- [ ] Three severities, dedupe, cooldown, acknowledgement all working.
- [ ] Dashboard, email and webhook actions deliver.
- [ ] A flapping condition demonstrably does not spam.

---

## F20 — Reporting

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F8, F10, F28

### Goal
Report data available through the API independently of the UI, exportable.

### Current implementation
None as a layer; the SPA renders raw report endpoints.

### Missing pieces
The ten report types, CSV/JSON export, streaming for large exports.

### Architecture
One builder per report, sharing the summary tables; a single serializer producing
JSON or CSV from the same structure.

### Backend tasks
- [ ] Builders: employee daily, employee weekly, department, company, productivity,
      activity, idle, application usage, website usage, efficiency trends.
- [ ] `format=json|csv`; stream CSV rather than buffering.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Report browser with filters and export buttons.

### Database tasks
- [ ] Reads from F28 summaries.

### API tasks
- [ ] `/api/v1/reports/*` — one route per report, consistent parameters.

### Security tasks
- [ ] `view_reports` permission; tenant scoping.
- [ ] **CSV formula-injection protection** — prefix cells starting with `= + - @`.
- [ ] Exports audit-logged.

### Unit tests
- [ ] Golden-file test per report.
- [ ] CSV escaping including quotes, newlines and formula prefixes.

### Integration tests
- [ ] Report totals match the dashboards.

### Desktop tests
- [ ] None.

### API tests
- [ ] Every report: filters, formats, tenant isolation, empty result.

### UI tests
- [ ] Export downloads a valid file.

### Manual verification
- [ ] Open an exported CSV in a spreadsheet; verify no formula executes.

### Performance tests
- [ ] 100 000-row export streams without exceeding a memory budget.

### Definition of Done
- [ ] All ten reports available in JSON and CSV.
- [ ] API usable without the UI.
- [ ] Formula injection prevented.

---

## F21 — REST API `/api/v1`

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F1

### Goal
A stable, versioned, consistent public API — established before the surface grows
further.

### Current implementation
24 routes under **`/v1`**. No pagination convention (only screenshots take
limit/offset), inconsistent error shapes, no request ids, no API keys, no spec.

### Missing pieces
`/api/v1` mount, pagination, error envelope, request ids, API keys, OpenAPI,
the new endpoint surface.

### Architecture
Mount the full surface at `/api/v1`. **Freeze `/v1` as a compatibility alias** —
deployed agents and extensions depend on it and cannot be force-upgraded. No new
routes on `/v1`.

### Backend tasks
- [ ] Mount `/api/v1`; alias existing handlers from `/v1`.
- [ ] Shared middleware: tenant guard, RBAC guard (F25), pagination, error envelope
      `{error:{code,message,details}}`, `X-Request-Id`.
- [ ] Cursor pagination helper.
- [ ] API key issuance, hashing, scoping, revocation, last-used tracking.
- [ ] OpenAPI 3 spec generated and served.

### Desktop tasks
- [ ] Migrate to `/api/v1` with a `/v1` fallback for older backends.

### Web dashboard tasks
- [ ] Migrate the API client to `/api/v1`.
- [ ] API key management page.

### Database tasks
- [ ] `api_keys (id, business_id, name, key_hash, scopes, last_used_at, revoked_at, created_at)`.

### API tasks
- [ ] The full surface from ARCHITECTURE_TARGET §6.

### Security tasks
- [ ] API keys hashed at rest; shown once on creation.
- [ ] Key scopes enforced.
- [ ] Rate limiting per key and per user.
- [ ] Creation and revocation audit-logged.

### Unit tests
- [ ] Pagination helper; error envelope; key hashing and verification.

### Integration tests
- [ ] `/v1` and `/api/v1` return equivalent data for the shared routes.

### Desktop tests
- [ ] Agent works against both mounts.

### API tests
- [ ] **For every route: 200, 400, 401, 403, 404, validation, tenant isolation,
      pagination, date filters.** This is the largest single test block in the
      project — budget for it accordingly.

### UI tests
- [ ] Dashboard works entirely on `/api/v1`.

### Manual verification
- [ ] An old agent build still syncs against the new backend.

### Performance tests
- [ ] Middleware adds < 1 ms p95.

### Definition of Done
- [ ] Full surface on `/api/v1`; `/v1` still works for deployed clients.
- [ ] Consistent pagination, errors and request ids everywhere.
- [ ] API keys working and scoped.
- [ ] OpenAPI spec published; the full route test matrix is green.

---

## F22 — Webhooks

**Status:** NOT STARTED · **Priority:** P2 · **Depends on:** F19, F29

### Goal
Let external systems react to platform events, safely.

### Current implementation
None.

### Missing pieces
Event emission, subscriptions, HMAC signing, retries, delivery log, SSRF defence.

### Architecture
Events → durable queue → delivery worker with exponential backoff → delivery log.
Payloads signed with HMAC-SHA256 over `timestamp.body`, sent as
`X-Signature` + `X-Timestamp`.

### Backend tasks
- [ ] Event emission for `employee.online/offline/idle`,
      `employee.low_productivity`, `employee.low_efficiency`, `alert.created`,
      `screenshot.created`.
- [ ] Subscription CRUD with per-endpoint secrets.
- [ ] Delivery worker: retry with exponential backoff, max attempts, dead-letter.
- [ ] Delivery log with response status and body excerpt.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Webhook management, secret rotation, delivery history, manual retry.

### Database tasks
- [ ] `webhooks`, `webhook_deliveries`.

### API tasks
- [ ] CRUD `/api/v1/webhooks`.

### Security tasks
- [ ] **SSRF defence: resolve the target at delivery time and reject private,
      loopback, link-local and cloud-metadata ranges.** Validating only at save
      time is insufficient — DNS can be re-pointed.
- [ ] Enforce HTTPS; cap redirects at zero.
- [ ] Secrets stored encrypted; never returned after creation.

### Unit tests
- [ ] Signature generation and verification.
- [ ] Backoff schedule.
- [ ] SSRF rejection for each blocked range, including DNS rebinding.

### Integration tests
- [ ] Alert created → webhook delivered → logged.

### Desktop tests
- [ ] None.

### API tests
- [ ] CRUD, tenant isolation, invalid URL rejection.

### UI tests
- [ ] Management page and delivery history render.

### Manual verification
- [ ] Deliver to a real external endpoint and verify the signature independently.

### Performance tests
- [ ] 1000 queued deliveries drain without blocking other jobs.

### Definition of Done
- [ ] All six events delivered with HMAC signatures.
- [ ] Retries with backoff and a visible delivery log.
- [ ] SSRF prevented at resolution time — proven by test.

---

## F23 — AI-ready analytics

**Status:** NOT STARTED · **Priority:** P2 · **Depends on:** F20, F28

### Goal
Aggregation endpoints structured so an AI layer can answer natural-language
questions later — **without coupling to any AI provider now.**

### Current implementation
None.

### Missing pieces
Summary, compare, outliers, trends and attribution endpoints with self-describing
schemas.

### Architecture
Endpoints return normalized JSON with explicit units, definitions and periods
inline, so a consumer needs no out-of-band knowledge.

### Backend tasks
- [ ] `/analytics/summary` — one period, one scope (employee/department/company).
- [ ] `/analytics/compare` — two periods with deltas.
- [ ] `/analytics/outliers` — lowest/highest on a chosen metric.
- [ ] `/analytics/trends` — time series with change points.
- [ ] `/analytics/attribution` — which apps/domains drove a metric change.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Optional: a trends panel consuming the same endpoints.

### Database tasks
- [ ] Reads from F28 summaries only.

### API tasks
- [ ] `/api/v1/analytics/*`.

### Security tasks
- [ ] Same RBAC and tenant scoping as reports.
- [ ] No PII beyond what the caller may already see.

### Unit tests
- [ ] Delta and change-point computation.

### Integration tests
- [ ] Each spec question is answerable from these endpoints:
      lowest productivity today · why an efficiency score decreased ·
      who increased YouTube usage · summarize a team · compare two weeks.

### Desktop tests
- [ ] None.

### API tests
- [ ] Filters, scopes, tenant isolation, stable response schemas.

### UI tests
- [ ] N/A initially.

### Manual verification
- [ ] Answer all five spec questions using only these endpoints.

### Performance tests
- [ ] Each endpoint < 1 s at 1000 employees.

### Definition of Done
- [ ] All five endpoints live and documented.
- [ ] All five spec questions answerable.
- [ ] **No AI provider dependency added.**

---

## F24 — Authentication hardening

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F1

### Goal
Close the session-management gaps before the platform holds more sensitive data.

### Current implementation
argon2id (m=64 MB, t=1, p=4) — good. JWT HS256, access 15 min, refresh 30 days.
**Refresh tokens are stateless: `Refresh` issues a new pair but the old refresh
token remains valid for its full 30 days.** No revocation, no server-side logout, no
session invalidation. Rate limiting is auth-only, in-memory, per-IP, with a bucket
map that is never evicted. No password reset, no invitation flow. Desktop tokens are
plaintext JSON, `0600` under `#[cfg(unix)]` only — **Windows gets default ACLs**.
Web tokens in `localStorage`.

### Missing pieces
Refresh rotation + reuse detection · revocation store · logout · password reset ·
invitations · broader rate limiting · secure desktop token storage.

### Architecture
Refresh-token families: each rotation issues a child and revokes the parent; reuse
of a revoked token revokes the entire family and forces re-login.

### Backend tasks
- [ ] `refresh_tokens (id, user_id, family_id, token_hash, expires_at, revoked_at, replaced_by)`.
- [ ] Rotation on every refresh; reuse detection revokes the family.
- [ ] `POST /auth/logout` (this session) and `/auth/logout-all`.
- [ ] Password reset: single-use, time-limited token, no user enumeration.
- [ ] Employee invitation flow.
- [ ] Rate limiting beyond `/auth`, with an evicting bucket map (bound memory).
- [ ] Enforce a minimum `JWT_SECRET` length at boot.

### Desktop tasks
- [ ] Store tokens with DPAPI (Windows) / Keychain (macOS), or at minimum restrict
      the file ACL on Windows.
- [ ] Handle forced logout (family revoked) gracefully — keep local data, re-auth.

### Web dashboard tasks
- [ ] Logout calls the server.
- [ ] Password reset and invitation acceptance UI.

### Database tasks
- [ ] `refresh_tokens`, `password_resets`, `invitations`.

### API tasks
- [ ] `/api/v1/auth/logout`, `/logout-all`, `/password/reset/request`,
      `/password/reset/confirm`, `/invitations/*`.

### Security tasks
- [ ] Reuse detection verified by test.
- [ ] Reset does not reveal whether an account exists.
- [ ] Tokens never logged.
- [ ] MFA and SSO: design notes only, not implemented.

### Unit tests
- [ ] Rotation issues a child and revokes the parent.
- [ ] Reusing a revoked token revokes the family.
- [ ] Reset token is single-use and expires.
- [ ] Rate-limit bucket eviction bounds memory.

### Integration tests
- [ ] Logout invalidates the refresh token immediately.
- [ ] Login on two devices; `logout-all` ends both.

### Desktop tests
- [ ] Token file is not readable by another user account.

### API tests
- [ ] Auth endpoints: 400/401/429; no enumeration through timing or message.

### UI tests
- [ ] Logout returns to sign-in and clears storage.

### Manual verification
- [ ] Steal a refresh token, rotate legitimately, confirm the stolen one fails.

### Performance tests
- [ ] argon2id cost is acceptable under login burst (tune `t`/`p` if not).

### Definition of Done
- [ ] Rotation with reuse detection working.
- [ ] Real logout and session invalidation.
- [ ] Password reset and invitations working.
- [ ] Rate limiting bounded and applied beyond `/auth`.
- [ ] Desktop tokens protected on both platforms.

---

## F25 — Roles and permissions

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F7, F24

### Goal
Replace owner-only authorization with a real permission model.

### Current implementation
`memberships.role CHECK (role IN ('owner','employee'))`. Every read path filters on
`businesses.owner_user_id = caller` (`ownedFilter`, `IsBusinessOwner`,
`OwnsEmployee`). Employees have **no** read access to their own data.

### Missing pieces
Roles `ADMIN / MANAGER / VIEWER`; the permission set; team assignment for
`view_team`; permission-aware UI.

### Architecture
Roles: `OWNER, ADMIN, MANAGER, VIEWER, EMPLOYEE`.
Permissions: `view_all_employees, view_team, view_screenshots, view_live_screen,
view_reports, manage_productivity_rules, manage_employees, manage_settings,
manage_api_keys`. A static role→permission matrix, overridable per membership later.

### Backend tasks
- [ ] `internal/rbac` with the matrix and a `Require(perm)` middleware.
- [ ] Scope resolver replacing `ownedFilter`: OWNER/ADMIN → whole business;
      MANAGER → assigned team; VIEWER → per grant; EMPLOYEE → self only.
- [ ] Every route declares its required permission.

### Desktop tasks
- [ ] None (agents authenticate as the employee).

### Web dashboard tasks
- [ ] Role management.
- [ ] Permission-aware navigation — hide what the user cannot access, and still
      enforce server-side.

### Database tasks
- [ ] Extend `memberships.role` CHECK.
- [ ] `teams` / manager assignment for `view_team`.
- [ ] Optional `membership_permissions` for per-user overrides.

### API tasks
- [ ] Permission enforcement on every `/api/v1` route.

### Security tasks
- [ ] **`view_live_screen` is never implied by any other permission.**
- [ ] `view_screenshots` separate from `view_reports`.
- [ ] Role changes audit-logged.
- [ ] Privilege escalation attempts tested explicitly.

### Unit tests
- [ ] Matrix resolution for every role.
- [ ] Scope resolver for each role.

### Integration tests
- [ ] An EMPLOYEE can read their own data and nothing else.
- [ ] A MANAGER sees only their team.

### Desktop tests
- [ ] Agent sync still works under the EMPLOYEE role.

### API tests
- [ ] **Full matrix: every role × every route × expected status.** Plus cross-tenant
      and cross-team denial, and escalation attempts.

### UI tests
- [ ] Navigation reflects permissions for each role.

### Manual verification
- [ ] Create one user per role and walk the app as each.

### Performance tests
- [ ] Permission check adds < 0.5 ms.

### Definition of Done
- [ ] All five roles and nine permissions enforced server-side.
- [ ] `ownedFilter` fully replaced with no regression (F21 tests green throughout).
- [ ] Live screen requires its own explicit permission.

---

## F26 — Audit log

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F25

### Goal
An append-only record of every sensitive action.

### Current implementation
None. Sentry captures errors, not audit events.

### Missing pieces
The table, the recorder, call sites, the viewer, retention.

### Architecture
One `audit.Record(ctx, actor, action, resource, metadata)` entry point called from
handlers. Append-only: no update or delete path exists in code.

### Backend tasks
- [ ] `internal/audit` with a single `Record()`.
- [ ] Call sites: login, employee create/delete, settings change, productivity rule
      change, **screenshot viewed**, **live screen opened/closed**, API key
      creation, role change.
- [ ] Query endpoint with filters.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Audit viewer with actor/action/resource/date filters and export.

### Database tasks
- [ ] `audit_log (id, business_id, actor_user_id, action, resource_type,
      resource_id, metadata jsonb, ip, user_agent, ts)` with `(business_id, ts)`
      and `(actor_user_id, ts)` indexes.
- [ ] No `UPDATE`/`DELETE` grants for the app role, if DB-level roles are used.

### API tasks
- [ ] `GET /api/v1/audit`.

### Security tasks
- [ ] IP recorded only where appropriate and documented.
- [ ] No secrets, tokens or screenshot bytes in `metadata`.
- [ ] Audit retention is independent of and longer than data retention (365 d default).

### Unit tests
- [ ] Each action records exactly one entry with the right shape.

### Integration tests
- [ ] Viewing a screenshot produces an audit entry.
- [ ] A live-screen session produces exactly two entries.

### Desktop tests
- [ ] None.

### API tests
- [ ] Tenant isolation; no write endpoint exists; filters work.

### UI tests
- [ ] Viewer renders and filters.

### Manual verification
- [ ] Perform each sensitive action and confirm the entry.

### Performance tests
- [ ] Audit writes do not measurably slow the actions they record.

### Definition of Done
- [ ] All nine action types recorded.
- [ ] Append-only enforced.
- [ ] Viewer available; retention configured.

---

## F27 — Data retention

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F14, F29

### Goal
Bounded storage with configurable, honest policies.

### Current implementation
**Screenshots only.** `retention.Service` sweeps hourly per business
(`screenshot_retention_days`, NULL = forever). Activity, keystroke and browser rows
are kept forever server-side; the desktop's local SQLite also never prunes them.

### Missing pieces
Policies and workers for activity, browser and audit, on both server and agent.

### Architecture
Per-class policy on `businesses`. Batched deletes (e.g. 10 000 rows per pass) so no
long lock is held. Local agent retention deletes **only synced rows**.

### Backend tasks
- [ ] Extend `retention` to activity, browser and audit classes.
- [ ] Batched, resumable deletes with progress logging.
- [ ] Defaults: activity 365 d, screenshots 30 d, browser 180 d, audit 365 d.

### Desktop tasks
- [ ] Local retention for `activity_sample`, `input_sample`, `browser_visit` —
      synced rows only, never pending ones.

### Web dashboard tasks
- [ ] Retention settings with an explicit destructive-action confirmation.

### Database tasks
- [ ] Retention columns per class on `businesses`.
- [ ] Evaluate monthly partitioning of raw tables against measured volume (F30).

### API tasks
- [ ] Retention settings in business settings.

### Security tasks
- [ ] Only `manage_settings` may change retention; every change audit-logged.
- [ ] Deleted data must be unrecoverable through the API.

### Unit tests
- [ ] Each class deletes exactly at its boundary.
- [ ] Unsynced local rows are never deleted.

### Integration tests
- [ ] A full sweep removes rows and blobs together.

### Desktop tests
- [ ] Local DB stops growing under a retention policy.

### API tests
- [ ] Settings validation; tenant isolation.

### UI tests
- [ ] Confirmation dialog is required before shortening retention.

### Manual verification
- [ ] Set a short retention and observe correct deletion.

### Performance tests
- [ ] Deleting 1 M rows does not block API traffic.

### Definition of Done
- [ ] All four classes have configurable policies and working workers.
- [ ] Agent-side retention works and never loses unsynced data.
- [ ] Policy changes are confirmed and audited.

---

## F28 — Database performance

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F5, F6

### Goal
Dashboards that never scan raw activity rows.

### Current implementation
Indexes exist on `(business_id, ts)` and `(user_id, ts)` for all four activity
tables — a reasonable start. But `store.Roster` runs **five correlated subqueries
per employee against raw `activity_samples`**, and every dashboard load scans raw
rows. No summary tables. No `domain` column. No partitioning.

### Missing pieces
Summary tables, rollup jobs, query rewrites, composite indexes, reconciliation.

### Architecture
`activity_hourly`, `activity_daily`, `app_daily`, `domain_daily` as **regular
tables** maintained incrementally by jobs (not materialized views, which cannot be
incrementally refreshed or selectively recomputed).

### Backend tasks
- [ ] Rollup jobs: hourly (10 min cadence, 2 h window) and daily (per timezone).
- [ ] Rewrite roster, dashboards and reports to read summaries.
- [ ] Scheduled reconciliation comparing summaries against raw recomputation.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] None (transparent change).

### Database tasks
- [ ] Create the four summary tables with appropriate primary keys.
- [ ] `(business_id, user_id, ts)` composite on raw tables.
- [ ] `browser_visits.domain` + `(business_id, domain, ts)` (from F4).
- [ ] Evaluate monthly partitioning against measured volume.

### API tasks
- [ ] Unchanged response shapes.

### Security tasks
- [ ] Summary tables carry `business_id` and are subject to the same tenant guard.

### Unit tests
- [ ] Rollup arithmetic.
- [ ] Incremental update is idempotent.

### Integration tests
- [ ] **Property test: summaries always equal a raw recomputation** for randomly
      generated days.
- [ ] Late-arriving data triggers recompute of the affected window.

### Desktop tests
- [ ] None.

### API tests
- [ ] Responses identical before and after the rewrite (golden files).

### UI tests
- [ ] Dashboards unchanged visually.

### Manual verification
- [ ] Compare a summary-backed dashboard against a hand-computed day.

### Performance tests
- [ ] Benchmarks at 100 / 500 / 1000 employees, before and after, recorded.

### Definition of Done
- [ ] Dashboards read summaries only.
- [ ] Reconciliation job in place and green.
- [ ] Measured improvement documented.

---

## F29 — Background jobs

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F21

### Goal
A dependable place for scheduled and queued work.

### Current implementation
One goroutine: `retention.StartSweeper`, hourly, started from `main.go`. No queue,
no retries, no visibility.

### Missing pieces
A registry, scheduling, retries, metrics, failure isolation, overlap prevention.

### Architecture
Start with an **in-process scheduler** in the existing binary. Introduce Redis +
`asynq` only when a job needs durable retries with visibility, or when a second
instance is deployed. Add Postgres advisory locking before running two instances.

### Backend tasks
- [ ] `internal/jobs`: registry, scheduler, per-job context and timeout.
- [ ] Jobs: hourly rollup, daily rollup+scores, rule evaluation, alert dispatch,
      webhook delivery, notification delivery, retention sweep, screenshot cleanup,
      report generation.
- [ ] Failure isolation — one panicking job must not stop the others.
- [ ] Overlap prevention (per-job mutex + advisory lock).
- [ ] `job_runs` recording start, end, status, error.
- [ ] `--mode=worker` flag for later process separation.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Job health panel for admins.

### Database tasks
- [ ] `job_runs`.

### API tasks
- [ ] Admin-only job status endpoint.

### Security tasks
- [ ] Job status is admin-only and leaks no tenant data across businesses.

### Unit tests
- [ ] Registry, scheduling, timeout, overlap prevention.

### Integration tests
- [ ] A failing job is recorded and retried without affecting others.

### Desktop tests
- [ ] None.

### API tests
- [ ] Status endpoint permissions.

### UI tests
- [ ] Job health renders.

### Manual verification
- [ ] Kill a job mid-run; confirm recovery on the next cycle.

### Performance tests
- [ ] All jobs complete within their cadence at 1000 employees.

### Definition of Done
- [ ] All listed jobs registered, idempotent and observable.
- [ ] Failures isolated, recorded and retried.
- [ ] Redis introduced only if justified — decision recorded either way.

---

## F30 — Performance testing

**Status:** NOT STARTED · **Priority:** P0 before production · **Depends on:** F28, F29

### Goal
Know the platform's real limits before customers find them.

### Current implementation
None. No load tests, no benchmarks, no measured baseline anywhere in the repo.

### Missing pieces
Synthetic data generator, load harness, measurement, documented results.

### Architecture
A generator producing realistic employee-days; a load harness (k6 or Go) driving
sync uploads, screenshot uploads, dashboard requests, reports and browser events
concurrently.

### Backend tasks
- [ ] Synthetic data generator (configurable employees × days).
- [ ] Load scenarios per traffic type.

### Desktop tasks
- [ ] A headless agent simulator for N virtual agents.

### Web dashboard tasks
- [ ] None.

### Database tasks
- [ ] Capture `EXPLAIN ANALYZE` for the slowest queries at each scale.

### API tasks
- [ ] None.

### Security tasks
- [ ] Load-test data must never reach a production database.

### Unit tests
- [ ] Generator produces valid, self-consistent data.

### Integration tests
- [ ] A generated dataset flows through the full pipeline.

### Desktop tests
- [ ] Simulator matches real agent traffic shape.

### API tests
- [ ] No errors under sustained load.

### UI tests
- [ ] Dashboard remains usable at 1000 employees.

### Manual verification
- [ ] Review results and set capacity guidance.

### Performance tests
- [ ] At **10 / 50 / 100 / 500 / 1000 employees**, measure and record:
      CPU · RAM · DB load · API latency (p50/p95/p99) · storage growth · bandwidth.
- [ ] Screenshot storage model: 1000 × 96/day × 50 KB ≈ **4.8 GB/day, ~144 GB/month**
      at 30-day retention. Confirm against measurement.

### Definition of Done
- [ ] All five scales tested; results committed to the repo.
- [ ] Bottlenecks identified with owners and follow-up tasks.
- [ ] Capacity guidance published for self-hosters.

---

## F31 — Desktop performance

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F2, F3, F4, F5

### Goal
An agent light enough that nobody wants it removed.

### Current implementation
Unmeasured. The window/idle loop polls every 1 s and calls `active_window()` each
tick. Screenshot compression may run up to **15 encode passes** per capture
(3 resolutions × 5 qualities).

### Missing pieces
Measurement, budgets, optimization.

### Architecture
Set budgets first, then optimize against them.

### Backend tasks
- [ ] Accept agent self-reported resource metrics (optional, opt-in).

### Desktop tasks
- [ ] Instrument CPU, RSS, disk and network.
- [ ] Optimize the compression ladder (start from the last successful setting).
- [ ] Evaluate event-driven window-change notification instead of 1 s polling.
- [ ] Verify no thread or handle leaks over 8 hours.

### Web dashboard tasks
- [ ] Optional agent health display.

### Database tasks
- [ ] None.

### API tasks
- [ ] None.

### Security tasks
- [ ] Metrics must contain no activity data.

### Unit tests
- [ ] Compression ladder chooses the cheapest passing setting.

### Integration tests
- [ ] None.

### Desktop tests
- [ ] 8-hour soak on both platforms with resource sampling.

### API tests
- [ ] None.

### UI tests
- [ ] None.

### Manual verification
- [ ] Battery impact assessment on a laptop (macOS Activity Monitor "Energy
      Impact"; Windows battery report).

### Performance tests
- [ ] Proposed budgets — idle CPU < 1%, active CPU < 5%, RSS < 150 MB,
      disk < 500 MB local DB + screenshots, network < 10 MB/day/employee.
      Adjust once measured, but publish the numbers.

### Definition of Done
- [ ] Budgets defined, measured and met on both platforms.
- [ ] No leaks over an 8-hour soak.
- [ ] Battery impact documented.

---

## F32 — Security review

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F21, F24, F25, F26

### Goal
Every threat in the model has a control and an automated test.

### Current implementation
No formal review. Initial findings from this baseline pass are in
[SECURITY_REVIEW.md](SECURITY_REVIEW.md).

### Missing pieces
Controls for the open findings; automated security tests; dependency scanning.

### Architecture
Threat model in SECURITY_REVIEW.md §2; controls in §5; test matrix in §6.

### Backend tasks
- [ ] Resolve every open finding in SECURITY_REVIEW.md.
- [ ] Tenant guard middleware so scoping is structural, not per-handler.
- [ ] Security headers on all responses.

### Desktop tasks
- [ ] Set a real CSP (`tauri.conf.json` currently has `"csp": null`).
- [ ] Harden the loopback ingest token handoff.

### Web dashboard tasks
- [ ] Review for XSS sinks (`dangerouslySetInnerHTML`, URL injection).

### Database tasks
- [ ] Confirm every query is parameterized. *(Baseline check: all observed queries
      use pgx parameters; the only string interpolation is the constant
      `ownedFilter`, which contains no user input.)*

### API tasks
- [ ] Authorization test for every route (shared with F21/F25).

### Security tasks
- [ ] Full threat matrix from SECURITY_REVIEW.md §6 executed.
- [ ] Dependency scanning in CI (`govulncheck`, `cargo audit`, `pnpm audit`).
- [ ] Secret scanning in CI.

### Unit tests
- [ ] Path traversal, signed URL tampering, token replay.

### Integration tests
- [ ] Cross-tenant access denied on every read path.

### Desktop tests
- [ ] Loopback server rejects web origins and bad tokens. *(already implemented —
      add a regression test)*

### API tests
- [ ] The complete matrix in SECURITY_REVIEW.md §6.

### UI tests
- [ ] No XSS from stored window titles or page titles (both are attacker-influenced
      strings that reach the dashboard).

### Manual verification
- [ ] Manual penetration pass against the listed threats.

### Performance tests
- [ ] Security middleware overhead measured.

### Definition of Done
- [ ] Every finding resolved or explicitly accepted with a rationale.
- [ ] Threat matrix automated in CI.
- [ ] Dependency and secret scanning green.

---

## F33 — Privacy safeguards

**Status:** NOT STARTED · **Priority:** P0 · **Depends on:** F1

### Goal
Keep the product's central promise provable, not merely stated.

### Current implementation
Genuinely strong: keyboard capture is count-only on both platforms (macOS
`kCGEventTapOptionListenOnly` with only the key-down mask and no keycode read;
Windows `WH_KEYBOARD_LL` incrementing without touching `lParam`). No credential,
cookie, form or page-content capture anywhere. A curated ~70-app sensitive skip-list
covering chat, password managers, crypto wallets, VPN, mail and meeting apps.
Privacy screenshot mode (active window only) is the **default**. Domain-only URL mode
available.

**Gap:** the skip-list suppresses **screenshots only** — the window title of a
skip-listed app is still captured and synced.

### Missing pieces
Skip-list coverage for window titles; a published in-product data-collection
disclosure; per-business privacy policy configuration.

### Architecture
Move the skip-list check into the activity tracker as well as the screenshot loop.

### Backend tasks
- [ ] Per-business privacy policy settings.
- [ ] Serve the collection disclosure through the policy endpoint.

### Desktop tasks
- [ ] Skip-list suppresses window-title capture (record the app name only, or
      nothing, per policy).
- [ ] A "what is collected" screen the employee can open at any time.

### Web dashboard tasks
- [ ] Privacy policy configuration.
- [ ] Employee-facing disclosure page.

### Database tasks
- [ ] Privacy policy columns on `businesses`.

### API tasks
- [ ] Disclosure included in `GET /api/v1/policy`.

### Security tasks
- [ ] A test asserting no keycode is ever read (both platforms).
- [ ] A test asserting skip-listed apps produce neither screenshots nor titles.
- [ ] No stealth: verify the tray icon and window are always reachable.

### Unit tests
- [ ] Skip-list matching (already covered for screenshots — extend to titles).

### Integration tests
- [ ] A skip-listed app produces no title in the synced data.

### Desktop tests
- [ ] Disclosure screen reachable at all times.

### API tests
- [ ] Policy endpoint returns the disclosure.

### UI tests
- [ ] Disclosure renders in all 7 locales.

### Manual verification
- [ ] Open a password manager; confirm no screenshot **and** no window title.

### Performance tests
- [ ] Negligible.

### Definition of Done
- [ ] Skip-list covers screenshots and titles.
- [ ] Collection disclosure published in-product.
- [ ] Count-only keyboard capture proven by test.
- [ ] No stealth behaviour anywhere.

---

## F34 — Deployment

**Status:** NOT STARTED · **Priority:** P0 before production · **Depends on:** F14, F29

### Goal
A reproducible production deployment.

### Current implementation
`apps/backend/Dockerfile` (multi-stage, non-root uid 10001) and
`docker-compose.yml` (Postgres 16 + backend). No web-admin/marketing build stage, no
reverse proxy, no worker, no object storage, no Redis. Production is a hand-built
binary on a VPS behind a Cloudflare Tunnel.

### Missing pieces
Full compose stack; reverse proxy; worker; object storage; secret management;
a complete `.env.example`.

### Architecture
Reverse proxy → backend (×N) + worker; Postgres; object storage; optional Redis.

### Backend tasks
- [ ] Multi-stage build including the dashboard and marketing site.
- [ ] `--mode=worker` entrypoint.
- [ ] Config validation at boot with clear failure messages.

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] Build stage in the container image.

### Database tasks
- [ ] Migration strategy for zero-downtime deploys (expand/contract).

### API tasks
- [ ] None.

### Security tasks
- [ ] Secrets from the environment or a secret manager; **never committed**.
- [ ] `.env.example` complete and current, with no real values.
- [ ] TLS terminated at the proxy; HSTS.

### Unit tests
- [ ] Config validation.

### Integration tests
- [ ] `docker compose up` produces a working stack from scratch.

### Desktop tests
- [ ] Agent connects to the deployed backend.

### API tests
- [ ] Smoke suite against a deployed instance.

### UI tests
- [ ] Dashboard loads from the deployed origin.

### Manual verification
- [ ] Deploy to a clean machine following only the documentation.

### Performance tests
- [ ] Deployed instance meets F30 targets.

### Definition of Done
- [ ] Full stack deploys reproducibly.
- [ ] Secrets externalized; `.env.example` accurate.
- [ ] Documented rollback procedure.

---

## F35 — Backups

**Status:** NOT STARTED · **Priority:** P0 before production · **Depends on:** F34

### Goal
Recoverability, proven rather than assumed.

### Current implementation
Undocumented. No backup or restore procedure exists in the repository.

### Missing pieces
Backup automation, restore runbook, an actual restore test.

### Architecture
Postgres PITR (base backup + WAL archiving) plus object storage versioning or
replication.

### Backend tasks
- [ ] None (operational).

### Desktop tasks
- [ ] None.

### Web dashboard tasks
- [ ] None.

### Database tasks
- [ ] Automated backup with retention; WAL archiving; encryption at rest.

### API tasks
- [ ] None.

### Security tasks
- [ ] Backups encrypted; access restricted; restore requires authorization.

### Unit tests
- [ ] None.

### Integration tests
- [ ] Automated restore verification job.

### Desktop tests
- [ ] None.

### API tests
- [ ] None.

### UI tests
- [ ] None.

### Manual verification
- [ ] **Perform a full restore to a clean environment and verify data integrity.
      An untested backup is not a backup.**

### Performance tests
- [ ] Measure and record RTO and RPO.

### Definition of Done
- [ ] Automated backups running for database and object storage.
- [ ] Restore runbook written.
- [ ] **A real restore test performed and recorded before production.**

---

## F36 — Observability

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** F29

### Goal
Know something is wrong before a customer reports it.

### Current implementation
A good base: structured logging via `internal/obs` with lumberjack rotation
(`LOG_MAX_SIZE_MB` / `BACKUPS` / `AGE_DAYS`), gin output routed into the same
stream, optional Sentry with panic capture and user tagging. Desktop and extension
errors are also forwarded to Sentry (the extension via the desktop app, rate-limited
to 10/min).

**Gap:** `/healthz` returns OK **without checking the database**. No metrics. No job
failure visibility. No desktop sync error surface for admins.

### Missing pieces
Real health checks, metrics, job failure alerting, sync error visibility,
log scrubbing tests.

### Architecture
`/healthz` (liveness) and `/readyz` (DB + storage). Prometheus metrics at `/metrics`
behind auth.

### Backend tasks
- [ ] `/healthz` liveness; `/readyz` checks DB and blob store.
- [ ] Prometheus metrics: request rate/latency/errors, job durations and failures,
      sync throughput, queue depth.
- [ ] Job failure alerting through F19.

### Desktop tasks
- [ ] Report sync errors to the backend so admins can see agents that cannot sync.

### Web dashboard tasks
- [ ] System health page: job status, agents failing to sync.

### Database tasks
- [ ] Slow query logging enabled.

### API tasks
- [ ] `/metrics` behind auth or network policy.

### Security tasks
- [ ] **Never log tokens, passwords, or screenshot bytes.** Add a scrubbing test
      asserting no secret reaches the log writer.
- [ ] `/metrics` must not expose tenant-identifying labels.

### Unit tests
- [ ] Log scrubbing.
- [ ] Health check reports unhealthy when the DB is down.

### Integration tests
- [ ] Stop Postgres → `/readyz` fails → recovers when it returns.

### Desktop tests
- [ ] Sync errors surface to the backend.

### API tests
- [ ] Health endpoints; `/metrics` authorization.

### UI tests
- [ ] Health page renders.

### Manual verification
- [ ] Induce a failure and confirm it is visible.

### Performance tests
- [ ] Metrics collection overhead < 1%.

### Definition of Done
- [ ] Real health checks; metrics exported; job failures visible and alerting.
- [ ] Desktop sync errors visible to admins.
- [ ] Log scrubbing proven by test.

---

## F37 — Release process

**Status:** NOT STARTED · **Priority:** P1 · **Depends on:** — · **Start early**

### Goal
Predictable releases and a readable history. Cheap to set up; organizes everything
else.

### Current implementation
Ad hoc. `release/v1.5.0` and `release/v1.5.1` branches exist. **No `CHANGELOG.md`.**
No documented process. No CI.

### Missing pieces
Versioning scheme, CHANGELOG, release checklist, automation.

### Architecture
Milestones: `v0.1-baseline · v0.2-browser · v0.3-analytics · v0.4-productivity ·
v0.5-dashboard · v0.6-rules · v0.7-playback · v0.8-live · v1.0-production`.

### Backend tasks
- [ ] Version embedded in the binary and exposed at `/healthz`.

### Desktop tasks
- [ ] Version alignment across `Cargo.toml`, `tauri.conf.json` and `package.json`.

### Web dashboard tasks
- [ ] Version shown in the UI footer.

### Database tasks
- [ ] Migration version reported by the health endpoint.

### API tasks
- [ ] `GET /api/v1/version`.

### Security tasks
- [ ] Release artifacts checksummed and signed (F38/F39).

### Unit tests
- [ ] Version parsing.

### Integration tests
- [ ] Reported version matches the built artifact.

### Desktop tests
- [ ] Installer version matches the manifest.

### API tests
- [ ] Version endpoint.

### UI tests
- [ ] Footer shows the version.

### Manual verification
- [ ] Run a full release following only the checklist.

### Performance tests
- [ ] None.

### Definition of Done
- [ ] `CHANGELOG.md` created and maintained from now on.
- [ ] Versioning scheme adopted; release checklist documented.
- [ ] Every component reports a consistent version.

---

## F38 — Desktop auto-update

**Status:** NOT STARTED (foundation already exists) · **Priority:** P1 · **Depends on:** F37

### Goal
Safe, signed, reversible updates.

### Current implementation
**Largely built.** `tauri-plugin-updater` is wired in `lib.rs`; the minisign public
key is embedded in `tauri.conf.json`; the manifest endpoint is
`https://bibotracker.com/download/latest.json`; `createUpdaterArtifacts: true`;
Windows `installMode: "quiet"`. `apps/desktop/src/updater.ts` drives the UI side.

### Missing pieces
Documented rollback strategy · update-failure handling · staged rollout ·
verification tests.

### Architecture
Signed manifest with per-platform artifacts, checksums and signatures; staged
rollout by percentage; rollback by republishing the previous version.

### Backend tasks
- [ ] Serve the manifest with correct caching and staged-rollout support.

### Desktop tasks
- [ ] Handle update failure gracefully — never leave a broken install.
- [ ] Report update success/failure telemetry.
- [ ] Verify signature before applying (plugin does this — add a test).

### Web dashboard tasks
- [ ] Agent version distribution across the fleet.

### Database tasks
- [ ] Track agent version per device.

### API tasks
- [ ] Agent version reported on sync/heartbeat.

### Security tasks
- [ ] **Never deploy unsigned binaries.**
- [ ] Private signing key never in source control.
- [ ] Manifest served over HTTPS only.

### Unit tests
- [ ] Manifest parsing; version comparison.

### Integration tests
- [ ] Update N-1 → N succeeds.
- [ ] Corrupted download rejected.
- [ ] Signature mismatch rejected.

### Desktop tests
- [ ] Update on both platforms; quiet install on Windows.

### API tests
- [ ] Manifest endpoint.

### UI tests
- [ ] Update prompt and progress.

### Manual verification
- [ ] Full update cycle on both platforms.
- [ ] Rollback exercised.

### Performance tests
- [ ] Update download does not disrupt tracking.

### Definition of Done
- [ ] Signed updates verified end to end on both platforms.
- [ ] Failure handling and rollback documented and exercised.
- [ ] Staged rollout available — **a bad update must not reach the whole fleet.**

---

## F39 — Code signing

**Status:** NOT STARTED (macOS partially done) · **Priority:** P1 · **Depends on:** F37

### Goal
Installers that the OS and the user trust.

### Current implementation
macOS: signing identity `Developer ID Application: Nguyen Giang Nam (MVT95X368D)`
configured in `tauri.conf.json`; `scripts/sign-macos.sh` and
`docs/10-release-signing-notarization.md` exist.
**Windows: Authenticode is not configured at all.**

### Missing pieces
Windows code-signing certificate and pipeline; documented setup for both;
notarization verification in the release checklist.

### Architecture
CI signs release artifacts using secrets from the CI secret store. No certificate
material in the repository.

### Backend tasks
- [ ] None.

### Desktop tasks
- [ ] Windows Authenticode signing in the build pipeline.
- [ ] macOS notarization + stapling verified in the checklist.

### Web dashboard tasks
- [ ] None.

### Database tasks
- [ ] None.

### API tasks
- [ ] None.

### Security tasks
- [ ] **No certificates or private keys in source control** — verify with secret
      scanning.
- [ ] Signing keys in a CI secret store or an HSM.
- [ ] Document key rotation.

### Unit tests
- [ ] None.

### Integration tests
- [ ] Signature verification in CI after build.

### Desktop tests
- [ ] Gatekeeper accepts the macOS build on a clean machine.
- [ ] SmartScreen accepts the Windows build.

### API tests
- [ ] None.

### UI tests
- [ ] None.

### Manual verification
- [ ] Download and install both installers on clean machines with no warnings.

### Performance tests
- [ ] None.

### Definition of Done
- [ ] Both platforms signed; macOS notarized and stapled.
- [ ] Setup documented, including EV certificate procurement lead time.
- [ ] No certificate material in the repository.
