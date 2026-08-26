# PRODUCT_ROADMAP.md

Roadmap for evolving BiBoTracking into a focused employee productivity monitoring
platform. Baseline verified from source — see [ARCHITECTURE_CURRENT.md](ARCHITECTURE_CURRENT.md).

**Status values:** `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `READY FOR TEST` · `DONE`
**Priorities:** `P0 Critical` · `P1 High` · `P2 Medium` · `P3 Later`

**Explicitly out of scope:** task management, project management (except where
internally required), billing, invoicing, payroll, CRM, stealth/hidden monitoring,
keyboard *content* capture, credential capture, password capture.

---

## Phase overview

| Phase | Theme | Features | Exit criterion |
|---|---|---|---|
| **P-0** | Baseline & planning | 0 | Docs complete, repo understood, blockers logged |
| **P-1** | Stability & platform truth | 1, 2, 3 | Stack runs; Windows + macOS verified against a real checklist |
| **P-2** | Reliable data capture | 4, 5 | Browser data is trustworthy; idle/active are normalized and non-overlapping |
| **P-3** | Org model & productivity | 6, 7, 8 | Classification + productivity score working end to end |
| **P-4** | Scoring & dashboards | 9, 10, 11, 12, 13 | Employee + company dashboards with all four scores and a timeline |
| **P-5** | Storage & API | 14, 21, 24, 25, 26, 28 | Object storage, `/api/v1`, RBAC, audit log, aggregation tables |
| **P-6** | Rules, alerts, reporting | 18, 19, 20, 27, 29 | Configurable rules, deduped alerts, exportable reports, retention |
| **P-7** | Playback & presence | 15, 16 | Screenshot playback and live presence |
| **P-8** | Live view | 17 | WebRTC live screen with strict authorization and audit |
| **P-9** | Integrations & AI | 22, 23 | Webhooks, AI-ready aggregation endpoints |
| **P-10** | Production readiness | 30–39 | Perf tested, secured, deployed, backed up, observable, signed |

---

## Summary table

| # | Feature | Pri | Phase | Depends on | Status |
|---|---|---|---|---|---|
| 1 | Baseline stability | P0 | P-1 | — | IN PROGRESS |
| 2 | Windows production support | P0 | P-1 | 1 | NOT STARTED |
| 3 | macOS production support | P0 | P-1 | 1 | NOT STARTED |
| 4 | Browser monitoring | P0 | P-2 | 1 | NOT STARTED |
| 5 | Activity engine | P0 | P-2 | 1, 4 | NOT STARTED |
| 6 | Productivity classification | P0 | P-3 | 5, 7 | NOT STARTED |
| 7 | Employee job roles | P1 | P-3 | 1 | NOT STARTED |
| 8 | Productivity score | P0 | P-3 | 5, 6 | NOT STARTED |
| 9 | Focus score | P1 | P-4 | 5, 6, 7 | NOT STARTED |
| 10 | Efficiency score | P0 | P-4 | 5, 8, 9 | NOT STARTED |
| 11 | Employee dashboard | P0 | P-4 | 8, 10, 13 | NOT STARTED |
| 12 | Company dashboard | P0 | P-4 | 8, 10, 28 | NOT STARTED |
| 13 | Employee timeline | P0 | P-4 | 5, 6 | NOT STARTED |
| 14 | Screenshots (object storage) | P0 | P-5 | 1 | NOT STARTED |
| 15 | Historical playback v1 | P1 | P-7 | 13, 14 | NOT STARTED |
| 16 | Live employee presence | P1 | P-7 | 5, 21 | NOT STARTED |
| 17 | Live screen view | P1 | P-8 | 16, 25, 26 | NOT STARTED |
| 18 | Rule engine | P1 | P-6 | 8, 10, 29 | NOT STARTED |
| 19 | Alerts | P1 | P-6 | 18 | NOT STARTED |
| 20 | Reporting | P1 | P-6 | 8, 10, 28 | NOT STARTED |
| 21 | REST API `/api/v1` | P0 | P-5 | 1 | NOT STARTED |
| 22 | Webhooks | P2 | P-9 | 19, 29 | NOT STARTED |
| 23 | AI-ready analytics | P2 | P-9 | 20, 28 | NOT STARTED |
| 24 | Authentication hardening | P0 | P-5 | 1 | NOT STARTED |
| 25 | Roles and permissions | P1 | P-5 | 7, 24 | NOT STARTED |
| 26 | Audit log | P1 | P-5 | 25 | NOT STARTED |
| 27 | Data retention | P1 | P-6 | 14, 29 | NOT STARTED |
| 28 | Database performance | P1 | P-5 | 5, 6 | NOT STARTED |
| 29 | Background jobs | P1 | P-6 | 21 | NOT STARTED |
| 30 | Performance testing | P0 (pre-prod) | P-10 | 28, 29 | NOT STARTED |
| 31 | Desktop performance | P1 | P-10 | 2, 3, 4, 5 | NOT STARTED |
| 32 | Security review | P0 | P-10 | 21, 24, 25, 26 | NOT STARTED |
| 33 | Privacy safeguards | P0 | P-2 | 1 | NOT STARTED |
| 34 | Deployment | P0 (pre-prod) | P-10 | 14, 29 | NOT STARTED |
| 35 | Backups | P0 (pre-prod) | P-10 | 34 | NOT STARTED |
| 36 | Observability | P1 | P-10 | 29 | NOT STARTED |
| 37 | Release process | P1 | P-1 | — | NOT STARTED |
| 38 | Desktop auto-update | P1 | P-10 | 37 | NOT STARTED (partially exists) |
| 39 | Code signing | P1 | P-10 | 37 | NOT STARTED (macOS exists) |

---

## Feature detail

Each entry carries: Current State · Target State · Backend / Desktop / Frontend /
Database / API changes · Tests Required · Dependencies · Risks · Status.

---

### F1 — Baseline stability · P0 · Phase P-1
- **Current State:** Stack has never been verified end-to-end in this environment.
  Go, Rust, Docker and Postgres are absent from the dev machine (see
  [BASELINE_TEST_REPORT.md](../BASELINE_TEST_REPORT.md)). `.env.example` sets
  `PORT=8080` while `dev-backend.sh` and the Vite proxy target `:8090` — **a fresh
  clone cannot talk to its own backend** (drift D6). No CI. 6 Go tests, 27 Rust
  tests, 0 TS tests, 0 integration tests.
- **Target State:** Every component starts, connects and passes a documented
  smoke test. CI runs build + test for all four apps on every push.
  `BASELINE_TEST_REPORT.md` records each verified component with evidence.
- **Backend:** fix port drift; add DB connectivity to `/healthz`; add handler and
  store test harness (testcontainers or a disposable Postgres).
- **Desktop:** confirm `cargo check` / `cargo test` clean on both platforms.
- **Frontend:** add Vitest; smoke-test the API client and auth flow.
- **Database:** none.
- **API:** `/healthz` reports DB status.
- **Tests Required:** unit (existing must pass), first integration test
  (register → login → sync → report), CI green.
- **Dependencies:** none.
- **Risks:** toolchain install may need admin rights; Postgres port 5432 may be
  occupied by a native install.
- **Status:** IN PROGRESS — port drift fixed and CI added (2026-08-26); toolchain
  install and the end-to-end smoke run remain, blocked on B-1.

### F2 — Windows production support · P0 · Phase P-1
- **Current State:** Idle (`GetLastInputInfo`), key counting (`WH_KEYBOARD_LL`),
  active window and screenshots are implemented. `permission_status()` returns
  `Granted` unconditionally — there is no OS permission model. Lock, sleep, resume,
  user switching and multi-monitor edge cases are **unhandled and unverified**.
  Installer, uninstall, app-data paths and update flow are undocumented and untested.
  README claims production readiness; nothing substantiates it.
- **Target State:** Verified on Windows 10 and 11, single and multi monitor, across
  sleep/wake, lock/unlock, network loss, app restart and machine restart. Installer
  and uninstaller verified. No stealth: tray icon always visible.
- **Backend:** none.
- **Desktop:** session-state detection (`WTSRegisterSessionNotification` for
  lock/unlock/logon, `WM_POWERBROADCAST` for sleep/resume) emitting `session_event`;
  verify DPI/multi-monitor capture; harden token file ACLs.
- **Frontend:** Windows-accurate consent copy on the permissions screen.
- **Database:** `session_event` ingest (shared with F5).
- **API:** none beyond F5.
- **Tests Required:** manual matrix (documented, repeatable), Rust unit tests for
  the session-state mapper, 8-hour soak.
- **Dependencies:** F1.
- **Risks:** no Windows machine in this environment — **this feature is BLOCKED on
  hardware access**. Low-level hooks cannot observe elevated foreground apps.
- **Status:** NOT STARTED (expected to move to BLOCKED)

### F3 — macOS production support · P0 · Phase P-1
- **Current State:** TCC handling is genuinely good — real preflight checks, real
  request calls, per-permission Settings deep links, a data-driven permissions
  screen. Window titles need Screen Recording on recent macOS. Sleep/resume and
  lock are folded into idle; no `NSWorkspace` notifications.
- **Target State:** Verified on supported macOS versions; permission revocation
  mid-session is detected and recovered gracefully; sleep/lock produce explicit
  `session_event`s.
- **Backend:** none.
- **Desktop:** subscribe to `NSWorkspace` sleep/wake and
  `com.apple.screenIsLocked`/`screenIsUnlocked` distributed notifications; permission
  re-check loop with a clear recovery UX.
- **Frontend:** permission-recovery flow when a grant disappears.
- **Database:** `session_event` (shared with F5).
- **API:** none.
- **Tests Required:** manual matrix, unit tests for the notification→event mapper.
- **Dependencies:** F1.
- **Risks:** notarization required to test a realistic build; TCC behaviour differs
  between macOS versions.
- **Status:** NOT STARTED

### F4 — Browser monitoring · P0 · Phase P-2
- **Current State:** MV3 extension → loopback axum server → SQLite. Reliable in
  principle, unreliable in practice: **no periodic flush** (a single long-lived tab
  produces zero rows — the direct cause of `"browser_visit": []`), **no retry queue**
  (visits are dropped when the desktop app is not running), **no tab-close or
  browser-close flush**, **no idle awareness**, and Brave/Opera/Vivaldi/Arc are
  mislabelled as Chrome.
- **Target State:** Trustworthy browser data on Chrome and Edge. Visits checkpoint
  on an interval, survive a desktop-app restart, respect idle, and are correctly
  attributed. Firefox and Safari assessed later.
- **Backend:** add `domain` column and backfill; ingest `active_tab`; index
  `(business_id, domain, ts)`.
- **Desktop:** loopback server accepts batches and an explicit checkpoint/heartbeat;
  reconcile browser time against activity samples (refinement, not addition).
- **Frontend (extension):** periodic checkpoint alarm (≤60 s); durable outbox in
  `chrome.storage.local` with retry and cap; `tabs.onRemoved` + `runtime.onSuspend`
  flush; `chrome.idle` integration; accurate browser identification; incognito
  handling per policy (default: do not track).
- **Database:** `browser_visits.domain`, `browser_visits.active_tab`.
- **API:** `/api/v1/employees/{id}/websites` with domain rollups.
- **Tests Required:** extension unit tests for the visit state machine; integration
  test extension→desktop→backend; manual matrix — tab switching, multiple windows,
  incognito, YouTube, GitHub, Google, SaaS apps, browser minimized, browser closed,
  machine idle, rapid tab switching.
- **Dependencies:** F1.
- **Risks:** MV3 service-worker eviction limits how well any timer can be trusted —
  design must assume the worker dies at any moment and recover from
  `chrome.storage`. Chrome Web Store review needed for a new extension version.
- **Status:** IN PROGRESS — extension half done and tested (2026-08-26).
  Checkpoint, durable outbox, tab-close flush, idle awareness and browser
  identification all landed; logic extracted to `apps/extension/lib/` and covered by
  62 passing tests. All state is recovered from `chrome.storage`, so worker eviction
  costs at most one checkpoint interval. Remaining: desktop/backend `domain` +
  `active_tab` columns, batch ingest, local `ON CONFLICT(client_uuid)` upsert, the
  websites panel, and the full manual browser matrix. Incognito policy still
  unaddressed. Arc remains undetectable and reports as Chrome.

### F5 — Activity engine · P0 · Phase P-2
- **Current State:** Only **active** intervals are stored. **Idle time is never
  persisted** — no table, no rows, anywhere. Every idle transition silently
  discards up to `idle_threshold_s` of counted active time. Idle, locked, asleep and
  agent-not-running are indistinguishable. No mouse activity. Browser visits and
  activity samples overlap with no de-duplication. Day boundaries are hard-coded UTC.
- **Target State:** A normalized, gap-free, non-overlapping segment model producing
  `working_time`, `active_time`, `idle_time`, `activity_percentage`, per-app,
  per-window and per-domain durations that always agree with one another. Explicit,
  tested rules for app switching, idle, sleep, lock, disconnection and missing
  samples. Employee-timezone day boundaries.
- **Backend:** new `internal/activity` package — segment builder, overlap resolver,
  gap classifier, metric derivation. Pure and DB-free.
- **Desktop:** SQLite v3 — `idle_period`, `input_sample` (key + mouse counts),
  `session_event`; stop discarding the idle grace window; mouse-event counter
  (count only, mirroring the keyboard tap).
- **Frontend:** none directly (consumed by F11–F13).
- **Database:** `idle_periods`, `input_samples`, `session_events`;
  `users.timezone`.
- **API:** `/api/v1/employees/{id}/activity` returns the normalized model.
- **Tests Required:** heavy unit coverage — overlapping samples, gaps at every
  tolerance boundary, midnight split, DST transition, clock skew, two devices at
  once, sleep spanning days, out-of-order arrival, duplicate `client_uuid`.
- **Dependencies:** F1, F4.
- **Risks:** **highest-risk feature in the roadmap.** Everything downstream
  (F6/F8/F9/F10/F11/F12/F13/F18/F20) is arithmetic on this output. Getting it wrong
  produces plausible-looking but wrong numbers that managers may act on. Historical
  data predating `idle_period` cannot be back-filled — document the cutover date.
- **Status:** NOT STARTED

### F6 — Productivity classification engine · P0 · Phase P-3
- **Current State:** Does not exist. Zero references to productivity or
  classification in the codebase.
- **Target State:** `PRODUCTIVE / NEUTRAL / UNPRODUCTIVE / UNCLASSIFIED` resolved by
  app, domain, URL pattern and window-title pattern, with the hierarchy
  employee → role → department → company → global. Admin-manageable.
- **Backend:** `internal/productivity` — pure `classify()` with memoization;
  seeded default ruleset; CRUD + bulk import.
- **Desktop:** none.
- **Frontend:** classification management UI; "classify this app/domain" shortcut
  from the timeline; unclassified-coverage indicator.
- **Database:** `classification_rules`.
- **API:** CRUD `/api/v1/classifications`; classification surfaced on activity,
  timeline and website responses.
- **Tests Required:** exhaustive hierarchy resolution tests; specificity ordering;
  pattern matching including malicious/pathological patterns; the spec's worked
  examples (VS Code/Developer→PRODUCTIVE, youtube.com/Developer→UNPRODUCTIVE,
  youtube.com/Marketing→NEUTRAL or PRODUCTIVE, Figma/Designer→PRODUCTIVE).
- **Dependencies:** F5, F7.
- **Risks:** ReDoS via admin-supplied URL/title patterns — use RE2 (Go's `regexp`
  is already RE2, so this is safe by default) and cap pattern length. Rule changes
  must trigger recomputation or historical scores silently disagree.
- **Status:** NOT STARTED

### F7 — Employee job roles · P1 · Phase P-3
- **Current State:** Does not exist. `memberships.role` is only `owner|employee`.
- **Target State:** Lightweight `Department` and `JobRole` entities, enough to drive
  classification and role-aware scoring. **Not HR** — no salary, no hierarchy, no
  reviews.
- **Backend:** CRUD + assignment; role baselines for F9.
- **Desktop:** none.
- **Frontend:** department/role management; assignment on the employee page;
  department and role filters.
- **Database:** `departments`, `job_roles`, `memberships.department_id`,
  `memberships.job_role_id`.
- **API:** CRUD `/api/v1/departments`, `/api/v1/roles`.
- **Tests Required:** tenant isolation on CRUD; cascade behaviour on delete;
  unassigned employees fall back to company rules.
- **Dependencies:** F1.
- **Risks:** scope creep into HR features that are explicitly out of scope.
- **Status:** NOT STARTED

### F8 — Productivity score · P0 · Phase P-3
- **Current State:** Does not exist. The roster's `focus_pct_today` is a misnomer —
  it is keyboard-bucket coverage over active time, not focus and not productivity.
- **Target State:** `productive_time`, `neutral_time`, `unproductive_time`,
  `unclassified_time`, `productivity_percentage`, computed by a **configurable**
  scoring engine. Default:
  `productive_active_time / classified_active_time × 100`, with unclassified
  excluded from the denominator and reported separately.
- **Backend:** `internal/scoring` — config-driven, versioned.
- **Desktop:** none.
- **Frontend:** productivity breakdown on the employee page.
- **Database:** `scoring_configs`; score columns on `activity_daily`.
- **API:** `/api/v1/employees/{id}/productivity`.
- **Tests Required:** formula unit tests; zero-classified-time edge case;
  all-unclassified day; config change → recompute; reproducibility from stored
  `scoring_config_id` + `ruleset_version`.
- **Dependencies:** F5, F6.
- **Risks:** low classification coverage produces misleading scores — surface
  coverage % alongside every score.
- **Status:** NOT STARTED

### F9 — Focus score · P1 · Phase P-4
- **Current State:** Does not exist.
- **Target State:** Measures sustained productive work from productive-run length,
  app/context switch counts, idle interruptions and productive session count.
  **Role-aware** — a support agent's normal tool-switching must not be penalized
  against a developer's baseline.
- **Backend:** focus-session detection; per-role switch-rate baselines.
- **Desktop:** none.
- **Frontend:** focus sessions list ("Deep Focus Session · VS Code · 42 minutes").
- **Database:** `focus_sessions`; role baseline columns on `job_roles`.
- **API:** `/api/v1/employees/{id}/focus-sessions`.
- **Tests Required:** session detection at boundaries; role baseline application;
  a switch-heavy support role scores comparably to a switch-light dev role at equal
  productive time.
- **Dependencies:** F5, F6, F7.
- **Risks:** easy to build a metric that punishes legitimate job behaviour. Validate
  against at least two contrasting real roles before shipping.
- **Status:** NOT STARTED

### F10 — Efficiency score · P0 · Phase P-4
- **Current State:** Does not exist.
- **Target State:** Configurable weighted blend, default
  `Activity 25% · Productivity 40% · Focus 25% · Idle 10%`, over daily / weekly /
  monthly / custom ranges. **Labelled everywhere as an organization-defined
  operational metric, not a scientific measure.**
- **Backend:** weight resolution, range aggregation, recompute on weight change.
- **Desktop:** none.
- **Frontend:** weight editor; efficiency display carrying the disclaimer.
- **Database:** weights in `scoring_configs`; `efficiency_score` on `activity_daily`.
- **API:** `/api/v1/employees/{id}/efficiency?period=daily|weekly|monthly|custom`.
- **Tests Required:** weight normalization (must sum to 1); partial-data ranges;
  weekly/monthly aggregation is not a naive average of daily scores but a
  recomputation from component totals.
- **Dependencies:** F5, F8, F9.
- **Risks:** **misuse risk.** A single number invites HR decisions it cannot
  support. The disclaimer must be in the API payload, not only the UI.
- **Status:** NOT STARTED

### F11 — Employee dashboard · P0 · Phase P-4
- **Current State:** `EmployeeDetail.tsx` shows activity, keystrokes, browser and
  screenshots as separate panels. No scores, no timeline, no focus sessions,
  no alerts, no trends.
- **Target State:** Overview (four scores + time breakdown), Timeline, Applications,
  Websites, Activity, Screenshots, Focus Sessions, Alerts, Trends.
- **Backend:** aggregate endpoint so the page is one round-trip.
- **Desktop:** none.
- **Frontend:** full page rebuild with the section structure above.
- **Database:** reads summaries from F28.
- **API:** `/api/v1/employees/{id}` returning the overview payload.
- **Tests Required:** component tests per section; loading/empty/error states; a
  day with no data must render meaningfully, not blank.
- **Dependencies:** F8, F10, F13.
- **Risks:** N+1 request patterns; ensure one aggregate call.
- **Status:** NOT STARTED

### F12 — Company dashboard · P0 · Phase P-4
- **Current State:** `Dashboard.tsx` shows roster metrics computed by scanning raw
  `activity_samples` with correlated subqueries per employee — will not scale.
- **Target State:** Employees online/active/idle; average activity, productivity,
  efficiency; total active hours; top performers; lowest efficiency; highest idle;
  highest unproductive. Filters: today, yesterday, this week, last week, this month,
  custom range, department, role, employee.
- **Backend:** company rollup served from `activity_daily`/`activity_hourly`.
- **Desktop:** none.
- **Frontend:** dashboard rebuild with the filter bar.
- **Database:** summary tables from F28.
- **API:** `/api/v1/reports/company`.
- **Tests Required:** filter correctness including week/month boundaries in the
  business timezone; performance at 1000 employees (< 500 ms p95).
- **Dependencies:** F8, F10, F28.
- **Risks:** "top performers" / "lowest efficiency" leaderboards are ethically
  loaded; keep them behind a permission and label them clearly.
- **Status:** NOT STARTED

### F13 — Employee timeline · P0 · Phase P-4
- **Current State:** Does not exist. `ActivityPanel` lists raw samples only.
- **Target State:** One merged, chronological timeline combining apps, websites,
  idle, activity, screenshots and alerts, optimized for long ranges.
- **Backend:** timeline builder over the F5 segment model; cursor pagination.
- **Desktop:** none.
- **Frontend:** virtualized timeline with zoom (day/hour/minute) and filters.
- **Database:** covering indexes; hourly pre-bucketing for wide ranges.
- **API:** `/api/v1/employees/{id}/timeline?from&to&cursor&limit`.
- **Tests Required:** merge ordering with identical timestamps; pagination
  stability; 30-day range performance.
- **Dependencies:** F5, F6.
- **Risks:** unbounded ranges; enforce a documented max window per resolution.
- **Status:** NOT STARTED

### F14 — Screenshots (object storage) · P0 · Phase P-5
- **Current State:** Metadata in Postgres, bytes on **local disk** via `filestore`.
  Path construction is safe by design. Privacy mode (active window only), normal
  mode (per display) and a sensitive-app skip-list all work. Images are proxied
  through an authenticated endpoint — one round-trip per thumbnail, no caching, no
  thumbnail variant. No object storage anywhere in the codebase.
- **Target State:** Pluggable `BlobStore` — local for simple self-hosting,
  S3-compatible (S3/R2/MinIO/B2) for production. Short-TTL signed URLs. Thumbnails.
  Admin controls for interval, retention, quality, privacy mode, excluded apps.
  Optional blur.
- **Backend:** `internal/blobstore` interface + two impls; signed URL minting with
  authorization + audit; thumbnail generation.
- **Desktop:** optional blur; skip-list also suppresses window-title capture.
- **Frontend:** gallery using signed URLs; admin screenshot settings.
- **Database:** `screenshots.storage_key`, `storage_backend`, `thumb_key`;
  migration backfills existing rows as `local`.
- **API:** screenshot responses carry signed URLs, not raw bytes.
- **Tests Required:** both backends against the same interface suite; signed-URL
  expiry and tamper resistance; cross-tenant URL access denied; retention deletes
  from both blob store and DB.
- **Dependencies:** F1.
- **Risks:** signed URLs bypass per-request auth for their TTL — keep TTL short and
  audit every mint. Storage cost growth must be modelled in F30.
- **Status:** NOT STARTED

### F15 — Historical playback v1 · P1 · Phase P-7
- **Current State:** Does not exist.
- **Target State:** **Screenshot-based** playback (explicitly not video). Scrub a
  time axis; at each moment show screenshot, application, website, window title,
  activity, keyboard activity and productivity state. Play/pause; 1×, 2×, 5×, 10×.
- **Backend:** playback frame assembly — screenshots joined to the segment model.
- **Desktop:** none.
- **Frontend:** player component with prefetch and thumbnail scrubbing.
- **Database:** none beyond F13/F14 indexes.
- **API:** `/api/v1/employees/{id}/playback?from&to`.
- **Tests Required:** frame alignment when screenshot and segment timestamps differ;
  gaps render as gaps, not as the previous frame; playback speed correctness.
- **Dependencies:** F13, F14.
- **Risks:** bandwidth at 10× — prefetch thumbnails, load full images on pause.
- **Status:** NOT STARTED

### F16 — Live employee presence · P1 · Phase P-7
- **Current State:** Does not exist. The roster's `last_seen` comes from
  `devices.last_seen_at`, updated only on sync (every 5 minutes) — far too coarse.
- **Target State:** `ONLINE / ACTIVE / IDLE / OFFLINE / LOCKED (where detectable)`
  via a 30 s heartbeat, with dashboard updates over SSE. No polling storms.
- **Backend:** `internal/presence` — heartbeat ingest, state machine, 90 s offline
  timeout, SSE hub.
- **Desktop:** heartbeat sender, cheap and independent of the 5-minute sync.
- **Frontend:** live presence indicators driven by one SSE connection.
- **Database:** `device_presence` (or Redis when available).
- **API:** `POST /api/v1/presence/heartbeat`, `GET /api/v1/presence`,
  `GET /api/v1/presence/stream` (SSE).
- **Tests Required:** state transitions; offline timeout; SSE auth and per-tenant
  fanout isolation; heartbeat load at 1000 agents.
- **Dependencies:** F5, F21.
- **Risks:** 1000 agents × 30 s = 33 rps of writes — must not hit Postgres per
  heartbeat; buffer in memory/Redis and persist periodically.
- **Status:** NOT STARTED

### F17 — Live screen view · P1 · Phase P-8
- **Current State:** Does not exist.
- **Target State:** WebRTC stream from agent to an authorized manager's browser.
  Strict authorization, visible on-screen indicator for the employee, **no automatic
  recording**, full audit log of every session.
- **Backend:** signalling, one-time short-TTL tokens, TURN credential issuance,
  `live_sessions` audit rows.
- **Desktop:** capture + encode (H.264/VP8/VP9 per platform), adaptive bitrate,
  mandatory non-dismissible indicator.
- **Frontend:** viewer with connection state, bandwidth indicator, explicit start/stop.
- **Database:** `live_sessions (id, manager_id, employee_id, start_ts, end_ts, session_id)`.
- **API:** `POST /api/v1/live/sessions`, `GET /api/v1/live/sessions/{id}/signal`.
- **Tests Required:** authorization bypass attempts; token replay; cross-tenant
  access; reconnect; NAT/firewall traversal; low bandwidth; employee sleep; manager
  disconnect; multiple monitors; Windows and macOS.
- **Dependencies:** F16, F25, F26.
- **Risks:** **highest security and ethical risk in the project.** Build last, only
  after RBAC and audit are proven. Any authorization bypass here is a serious
  privacy breach. TURN infrastructure adds real operational cost.
- **Status:** NOT STARTED — do not start before its dependencies are DONE

### F18 — Rule engine · P1 · Phase P-6
- **Current State:** Does not exist in this platform. (`apps/monitor` has an
  unrelated infrastructure alerting engine — do not confuse the two.)
- **Target State:** Configurable `Trigger · Condition · Evaluation Window · Action ·
  Cooldown`. Examples: idle > 30 min; YouTube > 45 min/day; productivity < 50% for
  2 h; efficiency drops > 20% vs a 30-day average; unproductive time > 2 h.
- **Backend:** `internal/rules` — declarative rule model, safe evaluator (no
  arbitrary code execution), scheduled evaluation.
- **Desktop:** none.
- **Frontend:** rule builder with live preview against historical data.
- **Database:** `rules`, `rule_evaluations`.
- **API:** CRUD `/api/v1/rules`.
- **Tests Required:** each example rule; window boundaries; cooldown suppression;
  rule changes do not retroactively fire.
- **Dependencies:** F8, F10, F29.
- **Risks:** evaluation cost at scale — evaluate from summary tables only.
- **Status:** NOT STARTED

### F19 — Alerts · P1 · Phase P-6
- **Current State:** Does not exist.
- **Target State:** Dashboard notification, email and webhook actions (Slack/Teams
  later). Severities `INFO / WARNING / HIGH`. Cooldown, deduplication,
  acknowledgement.
- **Backend:** `internal/alerts` — lifecycle, dedupe key, cooldown, delivery.
- **Desktop:** none.
- **Frontend:** alert centre; per-employee alerts tab; acknowledgement.
- **Database:** `alerts`, `alert_deliveries`.
- **API:** `GET /api/v1/alerts`, `POST /api/v1/alerts/{id}/acknowledge`.
- **Tests Required:** dedupe across evaluation cycles; cooldown; delivery failure
  retry; no notification spam under a flapping condition.
- **Dependencies:** F18.
- **Risks:** alert fatigue destroys trust in the system — dedupe and cooldown are
  not optional polish.
- **Status:** NOT STARTED

### F20 — Reporting · P1 · Phase P-6
- **Current State:** Does not exist as a reporting layer; the SPA renders raw
  report endpoints directly.
- **Target State:** Employee daily/weekly, department, company, productivity,
  activity, idle, application usage, website usage and efficiency-trend reports.
  CSV and JSON exports. API exposes report data independently of the UI.
- **Backend:** `internal/reports` — one builder per report, shared into CSV/JSON.
- **Desktop:** none.
- **Frontend:** report browser with filters and export buttons.
- **Database:** reads summaries from F28.
- **API:** `/api/v1/reports/*` with `format=json|csv`.
- **Tests Required:** golden-file tests per report; CSV escaping/injection safety;
  large export streaming without loading everything into memory.
- **Dependencies:** F8, F10, F28.
- **Risks:** CSV formula injection — prefix risky cells. PDF deferred.
- **Status:** NOT STARTED

### F21 — REST API `/api/v1` · P0 · Phase P-5
- **Current State:** 24 routes under **`/v1`**, not `/api/v1`. No pagination
  convention (only screenshots take limit/offset), inconsistent error shapes,
  no request ids, no API keys, no OpenAPI spec.
- **Target State:** Stable, versioned `/api/v1` with consistent pagination, error
  envelope, filtering and auth. `/v1` frozen as a compatibility alias for deployed
  agents. JWT for the UI, API keys for integrations.
- **Backend:** route re-mount; shared middleware for tenant, RBAC, pagination and
  errors; API key issuance/verification; OpenAPI generation.
- **Desktop:** migrate to `/api/v1` behind a capability check; keep `/v1` fallback.
- **Frontend:** migrate the API client.
- **Database:** `api_keys` (hashed, scoped, revocable, last-used).
- **API:** the full surface listed in ARCHITECTURE_TARGET §6.
- **Tests Required:** for **every** route — 200/400/401/403/404, validation, tenant
  isolation, pagination, date filters. This is the largest single test block.
- **Dependencies:** F1.
- **Risks:** breaking deployed agents. `/v1` must keep working until auto-update
  adoption is measured; do not sunset on a guess.
- **Status:** NOT STARTED

### F22 — Webhooks · P2 · Phase P-9
- **Current State:** Does not exist.
- **Target State:** Events `employee.online/offline/idle`,
  `employee.low_productivity`, `employee.low_efficiency`, `alert.created`,
  `screenshot.created`. HMAC signature, retries with exponential backoff, delivery log.
- **Backend:** `internal/webhooks` — signing, delivery worker, log.
- **Desktop:** none.
- **Frontend:** webhook management with secret rotation and delivery history.
- **Database:** `webhooks`, `webhook_deliveries`.
- **API:** CRUD `/api/v1/webhooks`.
- **Tests Required:** signature verification; retry/backoff; SSRF protection
  (block private ranges and metadata endpoints); delivery log correctness.
- **Dependencies:** F19, F29.
- **Risks:** **SSRF** — an admin-supplied URL that resolves to internal
  infrastructure. Validate at resolution time, not just at save time.
- **Status:** NOT STARTED

### F23 — AI-ready analytics · P2 · Phase P-9
- **Current State:** Does not exist.
- **Target State:** Structured aggregation endpoints that let an AI layer answer
  "who had the lowest productivity today?", "why did an employee's efficiency
  decrease?", "which employees increased YouTube usage?", "summarize Development
  team performance", "compare this week with last week" — **without coupling to any
  AI provider**.
- **Backend:** `summary`, `compare`, `outliers`, `trends`, `attribution` endpoints
  returning normalized, self-describing JSON with units and definitions inline.
- **Desktop:** none.
- **Frontend:** none required initially.
- **Database:** reads summaries from F28.
- **API:** `/api/v1/analytics/*`.
- **Tests Required:** each spec question answerable from the endpoints; response
  schemas stable and documented.
- **Dependencies:** F20, F28.
- **Risks:** premature coupling to a provider. Do not add one unless asked.
- **Status:** NOT STARTED

### F24 — Authentication hardening · P0 · Phase P-5
- **Current State:** argon2id hashing (64 MB, t=1, p=4) — good. JWT HS256, access
  15 min, refresh 30 days. **Refresh tokens are stateless and never revoked** — a
  stolen refresh token is valid for 30 days and refreshing does not invalidate the
  old one. **No server-side logout, no session invalidation.** Rate limiting is
  auth-only, in-memory, with an unbounded bucket map. No password reset. No
  invitation flow. Desktop tokens are plaintext JSON, `0600` on Unix only —
  **default ACLs on Windows**. Web tokens in `localStorage`.
- **Target State:** Rotating refresh tokens with reuse detection and a revocation
  store; real logout; password reset; employee invitation; manager account creation;
  broader rate limiting. MFA and SSO designed for, not built yet.
- **Backend:** `refresh_tokens` table with family tracking; logout and revoke-all;
  reset and invitation flows; evicting rate-limit buckets applied beyond `/auth`.
- **Desktop:** DPAPI on Windows / Keychain on macOS for token storage.
- **Frontend:** logout calls the server; reset and invitation UI.
- **Database:** `refresh_tokens`, `password_resets`, `invitations`.
- **API:** `POST /api/v1/auth/logout`, `/logout-all`, `/password/reset/*`,
  `/invitations/*`.
- **Tests Required:** rotation and reuse detection; revocation takes effect
  immediately; reset token single-use and expiring; rate limit under burst.
- **Dependencies:** F1.
- **Risks:** rotation bugs log users out unexpectedly — ship behind a flag.
- **Status:** NOT STARTED

### F25 — Roles and permissions · P1 · Phase P-5
- **Current State:** Two roles only (`owner|employee`); every read path is
  owner-only; employees cannot read their own data. No permission concept.
- **Target State:** `OWNER, ADMIN, MANAGER, VIEWER, EMPLOYEE` with permissions
  `view_all_employees, view_team, view_screenshots, view_live_screen, view_reports,
  manage_productivity_rules, manage_employees, manage_settings, manage_api_keys`.
  **`view_live_screen` must be an explicit, separately-granted permission.**
- **Backend:** `internal/rbac` — permission matrix, middleware guard; replace
  `ownedFilter` with a scope resolver honouring team assignment.
- **Desktop:** none.
- **Frontend:** role management; permission-aware navigation and controls.
- **Database:** `memberships.role` CHECK extended; `role_permissions` or a static
  matrix; `teams`/manager-assignment for `view_team`.
- **API:** every route declares its required permission.
- **Tests Required:** a full matrix test — every role × every route × expected
  status. Cross-tenant and cross-team denial. Privilege-escalation attempts.
- **Dependencies:** F7, F24.
- **Risks:** replacing `ownedFilter` touches every read path — the highest
  regression risk of any refactor. Do it with the F21 route tests already green.
- **Status:** NOT STARTED

### F26 — Audit log · P1 · Phase P-5
- **Current State:** Does not exist. Sentry captures errors, not audit events.
- **Target State:** Append-only log of login, employee creation/deletion, settings
  change, productivity rule change, **screenshot viewed**, **live screen
  opened/closed**, API key creation, role change. Stores actor, action, resource,
  timestamp, metadata and IP where appropriate.
- **Backend:** `internal/audit` with a single `Record()` entry point called from
  handlers; append-only enforcement.
- **Desktop:** none.
- **Frontend:** audit viewer with filters.
- **Database:** `audit_log` with `(business_id, ts)` and `(actor_id, ts)` indexes.
- **API:** `GET /api/v1/audit`.
- **Tests Required:** every sensitive action produces exactly one entry; entries
  cannot be updated or deleted through the API; tenant isolation.
- **Dependencies:** F25.
- **Risks:** audit volume — screenshot views are frequent; consider sampling reads
  but never sampling writes or live-screen sessions.
- **Status:** NOT STARTED

### F27 — Data retention · P1 · Phase P-6
- **Current State:** **Screenshots only.** `retention.Service` sweeps hourly per
  business. Activity, keystroke and browser rows are kept forever in Postgres, and
  the desktop's local SQLite never prunes those three tables either.
- **Target State:** Per-class policies — activity 365 d, screenshots 30 d,
  browser 180 d, audit 365 d (defaults, all configurable). Cleanup workers for each,
  on both server and agent.
- **Backend:** extend `retention` to all classes with batched deletes.
- **Desktop:** local retention for `activity_sample`, `input_sample`,
  `browser_visit` — synced rows only.
- **Frontend:** retention settings with a clear "this permanently deletes data"
  confirmation.
- **Database:** retention columns on `businesses`; partitioning considered in F28.
- **API:** retention settings in business settings.
- **Tests Required:** each class deletes at its own boundary; unsynced rows are
  never deleted locally; deletion is batched and does not lock the table.
- **Dependencies:** F14, F29.
- **Risks:** irreversible data loss from a misconfiguration — require explicit
  confirmation and log every policy change to the audit log.
- **Status:** NOT STARTED

### F28 — Database performance · P1 · Phase P-5
- **Current State:** Indexes exist on `(business_id, ts)` and `(user_id, ts)` for
  all four activity tables — a reasonable start. But the roster query runs
  **five correlated subqueries per employee against raw `activity_samples`**, and
  every dashboard load scans raw rows. No summary tables, no partitioning, no
  `domain` column (domain rollups would require parsing URLs in SQL).
- **Target State:** `activity_hourly`, `activity_daily`, `app_daily`,
  `domain_daily`. Dashboards read summaries only. Raw rows queried only for
  timeline and playback within bounded windows.
- **Backend:** rollup jobs; query rewrite to summaries.
- **Desktop:** none.
- **Frontend:** none.
- **Database:** summary tables; `(business_id, user_id, ts)` composite;
  `browser_visits.domain` + index; monthly partitioning of raw tables evaluated
  against measured volume.
- **API:** unchanged shape, different source.
- **Tests Required:** summary correctness vs raw recomputation (property test);
  incremental update idempotency; late-arriving data triggers recompute;
  benchmarks at 100/500/1000 employees.
- **Dependencies:** F5, F6.
- **Risks:** summaries silently diverging from raw data — a scheduled
  reconciliation check is mandatory, not optional.
- **Status:** NOT STARTED

### F29 — Background jobs · P1 · Phase P-6
- **Current State:** One in-process goroutine (`retention.StartSweeper`, hourly).
  No queue, no retries, no visibility, no Redis.
- **Target State:** A job registry in the existing binary for aggregation,
  screenshot cleanup, report generation, alert evaluation, webhook delivery,
  notification delivery and retention. Redis/`asynq` introduced only when
  complexity justifies it.
- **Backend:** `internal/jobs` — registry, scheduler, per-job metrics and error
  reporting; `--mode=worker` flag for later separation.
- **Desktop:** none.
- **Frontend:** job health on an admin page.
- **Database:** `job_runs` for observability.
- **API:** internal/admin only.
- **Tests Required:** idempotency per job; failure isolation (one failing job must
  not stop others); overlapping-run prevention.
- **Dependencies:** F21.
- **Risks:** in-process jobs plus multiple backend instances = duplicate work.
  Add advisory locking before scaling horizontally.
- **Status:** NOT STARTED

### F30 — Performance testing · P0 before production · Phase P-10
- **Current State:** None. No load tests, no benchmarks, no measured baseline.
- **Target State:** Documented results at 10 / 50 / 100 / 500 / 1000 employees,
  simulating activity uploads, screenshot uploads, dashboard requests, reports and
  browser events; measuring CPU, RAM, DB load, API latency, storage growth and
  bandwidth.
- **Backend:** load-test harness and a synthetic data generator.
- **Tests Required:** the full matrix, with results committed to the repo.
- **Dependencies:** F28, F29.
- **Risks:** storage growth is the likely first wall — 1000 employees × 96
  screenshots/day × 50 KB ≈ **4.8 GB/day**. Model this before promising retention.
- **Status:** NOT STARTED

### F31 — Desktop performance · P1 · Phase P-10
- **Current State:** Unmeasured. The 1 s poll loop calls `active_window()` every
  second; screenshot compression tries up to 15 encode passes per capture.
- **Target State:** Documented budgets for idle CPU, active CPU, RAM, disk, network
  and battery, with measurements on both platforms.
- **Desktop:** profile and optimize the poll loop and the compression ladder;
  consider event-driven window-change notification instead of polling.
- **Tests Required:** measured budgets; 8-hour soak with no leak.
- **Dependencies:** F2, F3, F4, F5.
- **Risks:** an agent that drains battery gets uninstalled or resented.
- **Status:** NOT STARTED

### F32 — Security review · P0 · Phase P-10
- **Current State:** No formal review. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md)
  for the initial threat model and findings from this baseline pass.
- **Target State:** Every threat in the model has a control and a test.
- **Tests Required:** the full test matrix in SECURITY_REVIEW.md §6.
- **Dependencies:** F21, F24, F25, F26.
- **Status:** NOT STARTED

### F33 — Privacy safeguards · P0 · Phase P-2
- **Current State:** Strong foundations: keyboard is genuinely count-only on both
  platforms; no credential/content/cookie capture; a curated ~70-app sensitive
  skip-list; privacy screenshot mode is the **default**; domain-only URL mode.
  Gap: the skip-list suppresses **screenshots only** — window titles of
  skip-listed apps are still captured and synced.
- **Target State:** Skip-list applies to window titles too. A published, in-product
  data-collection disclosure. Per-business privacy policy configuration.
- **Desktop:** extend skip-list to title capture; user-visible "what is collected"
  screen.
- **Frontend:** privacy policy configuration and an employee-facing disclosure page.
- **Tests Required:** assert no keycode is ever read (compile-time and unit);
  skip-listed apps produce neither screenshots nor titles.
- **Dependencies:** F1.
- **Risks:** none technically; this is a trust and legal requirement.
- **Status:** NOT STARTED

### F34 — Deployment · P0 before production · Phase P-10
- **Current State:** `Dockerfile` (multi-stage, non-root) and `docker-compose.yml`
  (Postgres + backend) exist. No web-admin/marketing build stage, no reverse proxy,
  no worker, no object storage, no Redis. Production runs a hand-built binary on a
  VPS behind a Cloudflare Tunnel.
- **Target State:** Reproducible containerized stack — reverse proxy, backend,
  dashboard, Postgres, object storage, optional Redis and worker. Secrets from the
  environment. `.env.example` complete and current.
- **Tests Required:** clean-machine deploy from scratch; documented rollback.
- **Dependencies:** F14, F29.
- **Status:** NOT STARTED

### F35 — Backups · P0 before production · Phase P-10
- **Current State:** Undocumented. No backup or restore procedure in the repo.
- **Target State:** Documented Postgres backup (PITR), object storage backup,
  restore procedure and retention — with **an actual restore test performed and
  recorded before production**.
- **Dependencies:** F34.
- **Risks:** an untested backup is not a backup.
- **Status:** NOT STARTED

### F36 — Observability · P1 · Phase P-10
- **Current State:** Structured logging with rotation and optional Sentry — a good
  base. `/healthz` does **not** check the database. No metrics, no job failure
  visibility, no desktop sync error surface.
- **Target State:** Structured logs, API error tracking, job failure alerts, desktop
  sync error reporting, DB error visibility, real health checks and Prometheus
  metrics. No tokens or passwords in logs, ever.
- **Tests Required:** health check fails when the DB is down; a log-scrubbing test
  asserting no secret ever reaches the log writer.
- **Dependencies:** F29.
- **Status:** NOT STARTED

### F37 — Release process · P1 · Phase P-1
- **Current State:** Ad hoc. Release branches exist; **no `CHANGELOG.md`**, no
  documented process, no CI.
- **Target State:** Versioning scheme `v0.1-baseline → v0.2-browser → v0.3-analytics
  → v0.4-productivity → v0.5-dashboard → v0.6-rules → v0.7-playback → v0.8-live →
  v1.0-production`, a maintained CHANGELOG, and a documented release checklist.
- **Dependencies:** none — **start early**, it costs little and organizes everything.
- **Status:** NOT STARTED

### F38 — Desktop auto-update · P1 · Phase P-10
- **Current State:** **Largely already built** — `tauri-plugin-updater`, minisign
  public key embedded, signed manifest endpoint, `createUpdaterArtifacts: true`,
  Windows quiet install. Missing: documented rollback strategy, update-failure
  handling and staged rollout.
- **Target State:** Signed updates with a release manifest, checksums, signature
  verification, rollback and failure handling.
- **Tests Required:** update from N-1 to N; corrupted download rejected; signature
  mismatch rejected; rollback path exercised.
- **Dependencies:** F37.
- **Risks:** a bad update bricks every agent — staged rollout is mandatory.
- **Status:** NOT STARTED (foundation exists)

### F39 — Code signing · P1 · Phase P-10
- **Current State:** macOS signing identity configured in `tauri.conf.json`;
  `scripts/sign-macos.sh` and `docs/10-release-signing-notarization.md` exist.
  **Windows Authenticode is not configured.**
- **Target State:** Both platforms signed; macOS notarized; setup documented;
  **no certificates in source control**.
- **Dependencies:** F37.
- **Risks:** Windows EV certificates require purchase and identity verification —
  start the procurement lead time early.
- **Status:** NOT STARTED (macOS partially done)

---

## Phase P-11 — Teramind parity (added 2026-08-26)

Scope decision of record: the product targets **full Teramind parity**,
including the content capture the original brief excluded. The gap analysis
that produced these entries — and the reasoning behind the two carve-outs — is
[TERAMIND_PARITY.md](TERAMIND_PARITY.md). Read it before starting any F40+ item.

Two entries need reading before they are picked up:
- **F61** (endpoint restrictions) is the only item marked go/no-go rather than a
  priority. It is device control, not monitoring, and needs signed kernel
  drivers on both platforms.
- **F55** (keystroke content) ships with password-field masking on by default.
  That default is a design constraint, not a preference — see
  TERAMIND_PARITY.md §4.

### F41 — Monitoring profiles & scheduled capture · P0 · Phase P-11
- **Current State:** Capture settings are per-business global booleans with an
  optional per-device override (`settings` table + desktop `settings/mod.rs`).
  There is no concept of *when* to capture — capture is always-on whenever the
  agent runs.
- **Target State:** A named, inheritable profile holds `{tracking_key,
  tracking_val}` pairs and binds to a scope (employees, devices, departments,
  directory groups). Every capture category carries its own `days_of_week` and
  `time_range`, so a profile can capture websites 09:00–17:00 Mon–Fri and never
  capture audio. Profiles inherit via `parent_id`.
- **Backend:** `monitoring_profiles`, `monitoring_profile_details`,
  `monitoring_profile_assignments`; resolution walks the inheritance chain and
  the assignment scope, most-specific wins.
- **Desktop:** agent fetches its resolved profile on start and on change; every
  capture loop consults its own schedule window before firing.
- **Frontend:** profile editor — categories, keys, schedule per category, scope
  picker, inheritance preview showing which parent each value came from.
- **Database:** three new tables + a resolution index on (scope_type, scope_id).
- **API:** `GET/POST/PUT/DELETE /api/v1/monitoring-profiles`, plus
  `GET /api/v1/monitoring-profiles/resolved?device_id=` for the agent.
- **Tests Required:** resolution order (employee > device > department > company
  > global), schedule-window boundary cases (midnight wrap, DST, day-of-week
  edges), agent honours a mid-shift profile change.
- **Dependencies:** F1. Blocks every F52–F63 capture feature.
- **Risks:** getting resolution wrong silently captures more than intended —
  the failure mode is over-collection, so tests come before implementation.
- **Status:** NOT STARTED

### F40 — Devices & per-machine monitoring control · P1 · Phase P-11
- **Current State:** `devices` table records a device on sync; nothing manages it.
- **Target State:** Device inventory with last-seen, OS, agent version; enable
  and disable monitoring per machine; soft-delete and restore.
- **API:** `GET /api/v1/devices`, `POST /api/v1/devices/{id}/enable-monitoring`,
  `.../disable-monitoring`, `POST /api/v1/devices/{id}/restore`.
- **Dependencies:** F1. **Status:** NOT STARTED

### F42 — Work schedules & shifts · P1 · Phase P-11
- **Current State:** none. Nothing in the system knows an employee's expected hours.
- **Target State:** Shift templates, positions, and per-employee modifications
  (exceptions). Unlocks worked-vs-scheduled reporting, late/early detection, and
  makes "unproductive time" meaningful by excluding off-shift activity.
- **Note:** a *shift* and a *capture window* (F41) are different objects.
  Conflating them would prevent capturing an employee who works unscheduled hours.
- **Dependencies:** F7. **Status:** NOT STARTED

### F43 — Shared lists · P2 · F44 — Reports hub & async export · P1
### F45 — Employee notifications · P1 · F46 — Directory sync · P2
### F47 — License & seat usage · P2 · F48 — Timeline tags · P2
### F49 — Attendance & clock-in · P1 · F50 — Instance analytics state · P3
### F51 — Outbound mail configuration · P2
- Specced in [TERAMIND_PARITY.md](TERAMIND_PARITY.md) §3. **Status:** NOT STARTED

### F52–F64 — Content capture · Phase P-11
- F52 Email · F53 IM/conversations · F54 VoIP & audio · F55 Keystroke content ·
  F56 File activity · F57 Print · F58 Network · F59 Social media · F60 SQL ·
  F62 Screen OCR · F63 Location & camera · F64 Tasks & cost reporting.
- Each is a set of tracking keys inside an F41 profile. Building any of them
  before F41 exists means building it twice.
- **F61 Endpoint restrictions** — go/no-go, not scheduled. See §1.3.
- **Status:** NOT STARTED (all)
