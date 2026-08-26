# ARCHITECTURE_CURRENT.md — verified baseline

**Method:** every statement below was verified against source code at commit `a1a49da`
(branch `productivity-platform`, forked from `main`). Where the repository's own
documentation disagrees with the code, **the code is recorded here and the drift is
flagged**. Do not trust `README.md`, `CLAUDE.md`, or `docs/00`–`docs/14` without
re-verifying: several are materially stale (see §10).

---

## 1. Repository shape

```
bibo-emplooyee-tracking/
├── apps/
│   ├── backend      Go 1.26 · Gin · pgx · Postgres · goose      (module ctracking/backend)
│   ├── web-admin    React 19 · Vite 7 · TS · i18next            (SPA served at /admin)
│   ├── desktop      Tauri 2 (Rust) + React/Vite                 (crate ctracking, v1.5.1)
│   ├── extension    Chrome MV3 (plain JS, no build step)        (v0.2.0)
│   ├── monitor      Go 1.26 — UNDOCUMENTED second module        (module ctracking/monitor)
│   └── design       React sandbox for UI prototyping            (not shipped)
├── marketing/       generated static landing site (7 locales)
├── scripts/         dev + build shell scripts
└── docs/            14 design docs + docs/tickets/ (144 files)
```

**Drift D1 — `packages/` does not exist.** `pnpm-workspace.yaml` declares
`packages: ["apps/*", "packages/*"]` and both `README.md` and `CLAUDE.md` describe
`packages/` as "shared workspace packages". The directory is absent. There is **no
shared code package**: types, constants and the sensitive-app list are duplicated by
hand across Go, Rust and TypeScript.

**Drift D2 — `apps/monitor` is undocumented.** A complete second Go module
(`cmd/bibomon` with `agent` and `server` modes: systemd unit checks, journald
parsing, host metrics, HTTP probing, Telegram alerting). It is **infrastructure
uptime monitoring for the team's own VPS**, not employee monitoring. It shares
nothing with `apps/backend` except a module-name prefix. It appears in neither
`README.md` nor `CLAUDE.md`. Treat it as out of scope for this platform but do not
delete it without asking the maintainer.

---

## 2. Verified data flow (as built)

```
                     ┌──────────────────────── Employee device ───────────────────────┐
                     │                                                                │
  Chrome/Edge        │   Tauri desktop app (ctracking)                                │
  ┌───────────┐      │   ┌──────────────────────────────────────────────────────┐     │
  │ MV3 SW    │      │   │ trackers::run          1 s poll  → activity_sample    │    │
  │ background│──────┼──▶│ trackers::start_keyboard  15 s flush → keystroke_bucket│    │
  │  .js      │ HTTP │   │ trackers::start_screenshots  N s → screenshot (WebP)   │    │
  └───────────┘ POST │   │ server::start (axum, 127.0.0.1) → browser_visit        │    │
   /ingest           │   └──────────────────────┬───────────────────────────────┘     │
   + /whoami         │                          ▼                                     │
   token handoff     │                    SQLite  data.db      (WAL, single Mutex)    │
                     │                    4 tables, synced flag                       │
                     │                          │                                     │
                     │                    sync::worker  (300 s, ×2 backoff → 960 s)   │
                     └──────────────────────────┼─────────────────────────────────────┘
                                                │ HTTPS, Bearer JWT
                                                ▼
                                    ┌───────────────────────┐
                                    │ Go backend (one binary)│
                                    │ POST /v1/sync/batch    │  JSON, ≤1000 rows/kind
                                    │ POST /v1/sync/screenshots│ multipart, ≤200 KB
                                    └───────┬────────────┬───┘
                                            │            │
                                   Postgres │            │ local disk (STORAGE_DIR)
                                   9 tables │            │ screenshots/<biz>/<user>/<date>/<uuid>.webp
                                            │            │
                                            ▼            ▼
                                    ┌───────────────────────┐
                                    │ GET /v1/reports/*      │  owner-only reads
                                    └───────────┬───────────┘
                                                ▼
                                    web-admin SPA at /admin
```

The same Go binary also serves the marketing site at `/` and the SPA at `/admin`
(`server.staticSite`), so production needs no nginx.

---

## 3. Desktop agent (`apps/desktop/src-tauri`, ~4 900 lines Rust)

### 3.1 Capture loops — all verified in `src/trackers/mod.rs`

| Loop | Cadence | Writes | Gating |
|---|---|---|---|
| `run` (window+idle) | 1 s poll | `activity_sample` | `paused`, idle < threshold |
| `start_keyboard` | 15 s flush, 60 s buckets | `keystroke_bucket` | `paused`, `count_keystrokes`, Input Monitoring granted |
| `start_screenshots` | `screenshot_interval_s` (default 300) | `screenshot` | `paused`, `capture_screenshots`, Screen Recording granted, skip-list |
| `start_cleanup` | 3600 s | deletes local shots | `screenshot_retention_days` (default 30) |
| `server::start` (axum) | event-driven | `browser_visit` | `paused` (markers exempt) |
| `sync::worker` | 300 s + 10 s startup delay | pushes `synced=0` rows | logged in, backend URL set |

### 3.2 The activity model — **this is the single most important constraint**

`WindowTracker::tick` is a pure function `(active, window, threshold, now) → Option<sample>`
and is well unit-tested (10 tests). Its semantics:

- A sample is `{ts = interval start, app_name, window_title, pid, duration_s}`.
- `duration_s` counts **active seconds only**. One tick = 1 s.
- An interval is flushed on app/title change, on loss of foreground window, at
  `MAX_CHUNK_S = 60 s`, or on going idle.
- Going idle calls `close_idle`, which **subtracts the whole idle threshold** from
  the accumulated duration (`duration_s = max(0, duration_s - threshold_s)`) to undo
  the grace period counted before idle was detected.

**Consequences that Feature 5 must solve:**

- **C1 — Idle time is never stored anywhere.** Not locally, not in Postgres. There
  is no `idle_period` table and no idle row type. The system can currently answer
  "how much active time?" but *cannot* answer "how much idle time?" or "what was
  the working span?". `Working Time` and `Idle Time` in the target spec are
  **not derivable from existing data**.
- **C2 — Systematic undercount.** Every idle transition silently discards up to
  `idle_threshold_s` (default 60 s) of genuinely-counted active time. With a 60 s
  threshold and 30 idle transitions a day this is up to 30 minutes lost per day.
- **C3 — No distinction between idle, locked, asleep, and app-not-running.** All
  four produce the same thing: absence of rows. `idle_seconds()` on both platforms
  grows during lock/sleep, so they collapse into "idle", and a shut-down agent is
  indistinguishable from a very idle one.
- **C4 — No mouse activity.** `grep` confirms zero mouse counting. Mouse movement
  only feeds `idle_seconds()` (macOS `CGEventSourceSecondsSinceLastEventType`,
  Windows `GetLastInputInfo`). There is no mouse-event counter analogous to the
  keyboard one.
- **C5 — Overlap is possible today.** `activity_sample` and `browser_visit` both
  cover the same wall-clock seconds when the user is in a browser. Nothing
  de-duplicates them. Summing both double-counts.

### 3.3 Platform layer (`src/platform/`)

`platform/mod.rs` defines the contract and re-exports the `cfg`-selected backend.
Active window is cross-platform via `active-win-pos-rs`; screenshots via `xcap`.

| Capability | macOS (`macos.rs`, 269 ln) | Windows (`windows.rs`, 168 ln) |
|---|---|---|
| Active window | `active-win-pos-rs` | `active-win-pos-rs` |
| Idle seconds | `CGEventSourceSecondsSinceLastEventType` | `GetLastInputInfo` + `GetTickCount` (wrap-safe) |
| Key counting | CoreGraphics `CGEventTapCreate`, listen-only, `kCGEventKeyDown` mask, **never decodes the key** | `SetWindowsHookExW(WH_KEYBOARD_LL)`, counts `WM_KEYDOWN`/`WM_SYSKEYDOWN`, **never reads lParam** |
| Permission model | Real TCC: `AXIsProcessTrusted`, `IOHIDCheckAccess`, `CGPreflightScreenCaptureAccess`; request + deep-link per permission | **No OS permission model** — `permission_status()` returns `Granted` unconditionally; consent is an in-app opt-out |
| Screen lock / sleep / resume | Not detected (folds into idle) | Not detected (folds into idle) |
| Multi-monitor | `xcap::Monitor::all()`, one shot per display in `normal` mode | same |
| User switching | Not handled | Not handled |

**The privacy guarantee is real and correctly implemented on both platforms.** Both
key counters increment an atomic and never touch the keycode. This must be
preserved verbatim through all future work.

**Drift D3 —** `windows.rs`'s own header comment says "Keyboard counting (M2) is
stubbed — see `run_keyboard_tap`", but `run_keyboard_tap` is fully implemented
(hook + message pump + unhook). The comment is stale.

### 3.4 Local storage (`src/storage/mod.rs`, 768 ln)

SQLite via `rusqlite` (bundled), WAL, one `Connection` behind a `Mutex`.
`user_version` migrations, currently at **v2**.

```sql
activity_sample (id, ts, app_name, window_title, pid, duration_s,
                 client_uuid, synced, updated_at)
keystroke_bucket(id, ts_bucket UNIQUE, count, client_uuid, synced, updated_at)
screenshot      (id, ts, file_path, display_id, width, height,
                 client_uuid, synced, updated_at)
browser_visit   (id, ts, url, page_title, browser, duration_s,
                 client_uuid, synced, updated_at)
```

`client_uuid` is the natural sync key; a partial index `WHERE synced = 0` per table
makes "what is pending" cheap. Rows are **never deleted after sync** (except by the
screenshot retention job), so the local DB grows unbounded for activity/keystroke/
browser data. **No local retention for the three non-screenshot tables.**

### 3.5 Sync (`src/sync/`)

- `worker.rs` — 5-minute passes, exponential backoff to 16 min on failure. Batches
  of `BATCH_LIMIT`. Marks only `client_uuid`s the backend echoes back. Breaks the
  loop if the backend accepts nothing, so one poison row cannot spin.
- `client.rs` (428 ln) — `reqwest` + rustls, bearer auth, refresh-on-401.
- `auth.rs` — session (`access_token`, `refresh_token`, `email`, `business_id`)
  persisted as **plaintext JSON** in the app data dir. `chmod 0600` is applied
  under `#[cfg(unix)]` only — **on Windows the file inherits default ACLs**.

**Offline behaviour is genuinely local-first and works:** rows accumulate with
`synced = 0` and drain when connectivity and login return. This is a real strength;
reuse it.

### 3.6 Desktop UI

React 19 + Vite, screens: Welcome, Onboarding, Permissions, Login, Dashboard,
Activity, Browser, Screenshots, Settings. Rust tray with localized labels.
`tauri.conf.json` sets **`"csp": null`** — the webview has no Content Security
Policy.

---

## 4. Browser extension (`apps/extension`) — **the weakest link**

MV3, plain JS, no build step. Permissions: `tabs`, `storage`, `alarms`;
host permission `http://127.0.0.1/*`. Reports **only** to loopback.

**Discovery:** probes 6 fixed ports `[47615, 48291, 49377, 50603, 51719, 52837]`,
calls `GET /whoami`, checks `app === "employeetrack"`, caches `{port, token}` in
`chrome.storage.local`. A 1-minute `rediscover` alarm re-links.

**Visit lifecycle:** a "current visit" `{url, title, startTs}` lives in
`chrome.storage.session`. `transition()` finalises the previous visit and starts a
new one. It is called from exactly three listeners: `tabs.onActivated`,
`tabs.onUpdated` (url change or `status === "complete"`), and
`windows.onFocusChanged`.

### Root-cause analysis of `"browser_visit": []` (Feature 4's core defect)

All five are confirmed by reading `background.js`; none is speculative.

- **B1 — No periodic flush.** A visit is only ever written *on transition*. A user
  who opens one tab and stays on it for two hours produces **zero rows**. This alone
  explains an empty `browser_visit` array during heavy single-tab use (YouTube,
  a long doc, a SaaS dashboard).
- **B2 — No retry queue, no buffering.** `postVisit` returns `false` and the visit
  is **discarded permanently** when the desktop app is not running, is starting up,
  or all candidate ports are taken. There is no local queue in the extension, so
  every visit during a desktop-app restart is lost. Contrast with the desktop's own
  local-first SQLite queue.
- **B3 — Browser close and tab close lose the in-flight visit.** There is no
  `tabs.onRemoved` listener and no `runtime.onSuspend` flush. The last visit of every
  session is dropped.
- **B4 — No idle awareness.** `chrome.idle` is not used. If the machine goes idle
  with Chrome focused, the visit keeps accruing wall-clock time and lands as one
  long "active" visit — directly contradicting the desktop tracker, which correctly
  stops counting. This is also a **double-count** source (C5).
- **B5 — MV3 service-worker termination.** The worker is evicted after ~30 s idle.
  Listeners are registered at top level so events do revive it, and `current` lives
  in `chrome.storage.session`, so this is *mitigated* — but combined with B1 it
  means long dwell times are never checkpointed.

**Also:** the manifest declares no `"minimum_chrome_version"`, there is no Firefox
or Safari support, and `BROWSER` is inferred from `navigator.userAgent` (`"Edg"` →
`edge`, else `chrome`) — which will mislabel Brave, Opera, Vivaldi and Arc as Chrome.

**Privacy posture is correct:** only `url`, `page_title`, `ts`, `duration_s`,
`browser` are sent. No cookies, no form data, no page content, no `webRequest`.
`domain_only` mode on the desktop side rewrites the URL to its origin and drops the
title before storage.

---

## 5. Backend (`apps/backend`, ~3 600 lines Go)

### 5.1 Complete route table (verified in `internal/server/server.go`)

**The API is mounted at `/v1`, not `/api/v1`.** The target spec's `/api/v1/…` paths
do not exist today. This is a breaking-change decision to make deliberately.

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/healthz` | none | `handlers.Health` |
| GET | `/download/:file` | none | `downloadsH.Serve` (only if `STATIC_DIR` set) |
| GET | `/v1/public/businesses` | **none** | `authH.PublicBusinesses` |
| GET | `/v1/public/stats/downloads` | none | `downloadsH.Stats` |
| GET | `/v1/public/screenshot-privacy-apps` | none | `handlers.PrivacyApps` |
| POST | `/v1/keepalive` | token | `keepaliveH.Burn` (only if token set) |
| POST | `/v1/auth/register` | none, rate-limited | `authH.Register` |
| POST | `/v1/auth/login` | none, rate-limited | `authH.Login` |
| POST | `/v1/auth/refresh` | none, rate-limited | `authH.Refresh` |
| GET | `/v1/me` | JWT | `authH.Me` |
| POST | `/v1/businesses` | JWT | `ownerH.CreateBusiness` |
| GET | `/v1/businesses/mine` | JWT | `ownerH.ListMine` |
| GET | `/v1/businesses/:id/employees` | JWT + owner | `ownerH.ListEmployees` |
| PATCH | `/v1/businesses/:id/settings` | JWT + owner | `ownerH.UpdateSettings` |
| POST | `/v1/businesses/:id/screenshots/cleanup` | JWT + owner | `retentionH.Cleanup` |
| POST | `/v1/employees` | JWT | `ownerH.CreateEmployee` |
| GET | `/v1/policy` | JWT | `ownerH.Policy` |
| POST | `/v1/sync/batch` | JWT + membership | `syncH.Batch` |
| POST | `/v1/sync/screenshots` | JWT + membership | `shotH.Upload` |
| GET | `/v1/reports/employees` | JWT + owner | `reportsH.Roster` |
| GET | `/v1/reports/employees/:id/activity` | JWT + owner | `reportsH.Activity` |
| GET | `/v1/reports/employees/:id/keystrokes` | JWT + owner | `reportsH.Keystrokes` |
| GET | `/v1/reports/employees/:id/browser` | JWT + owner | `reportsH.Browser` |
| GET | `/v1/reports/employees/:id/screenshots` | JWT + owner | `reportsH.Screenshots` |
| GET | `/v1/screenshots/:client_uuid` | JWT + owner | `reportsH.ScreenshotImage` |
| * | everything else | none | static site fallback |

**24 routes total.** Of the target spec's endpoint list, only `employees` (as
`reports/employees`), `activity`, `browser` (≈`websites`) and `screenshots` exist in
any form. `timeline`, `productivity`, `efficiency`, `applications`, `reports/company`
and `alerts` do not exist.

### 5.2 Authorization model — owner-only, two roles

`memberships.role` is `CHECK (role IN ('owner','employee'))`. There is **no manager,
admin, viewer, or per-permission model**. Every read path funnels through one of:

```go
// reports.go:53
const ownedFilter = `business_id IN (SELECT id FROM businesses WHERE owner_user_id = $2)`
```

or `IsBusinessOwner` / `OwnsEmployee`. Both check `businesses.owner_user_id = caller`.

**Tenant isolation on the read path is sound.** Every per-employee query joins
through `owner_user_id`; `ScreenshotPathForOwner` deliberately returns `ErrNotFound`
rather than 403 so existence is not leaked. Ingest resolves the business through
`ResolveBusinessForUser`, which requires membership. I found **no IDOR** on the
existing routes. This is a genuine strength to preserve as roles are added.

**But:** an employee has *no* read access to their own data through the API. Only
the owner can read anything. Feature 25's `EMPLOYEE` role has no foundation yet.

### 5.3 Postgres schema (9 migrations, goose, embedded, run at startup)

```
users        (id, email NULLABLE UNIQUE, username NULLABLE UNIQUE, password_hash,
              display_name, account_type CHECK(manager|parent), created_at)
              CONSTRAINT users_identifier_chk: email IS NOT NULL OR username IS NOT NULL
businesses   (id, name, owner_user_id, screenshot_retention_days NULLABLE,
              screenshot_interval_s DEFAULT 300, idle_threshold_s DEFAULT 60,
              allow_employee_override DEFAULT false, kind CHECK(team|family),
              screenshot_mode DEFAULT 'privacy', screenshot_skip_apps text[], created_at)
memberships  (id, user_id, business_id, role CHECK(owner|employee), UNIQUE(user_id,business_id))
devices      (id PK client-generated, user_id, label, last_seen_at)
activity_samples  (id, client_uuid UNIQUE, user_id, business_id, device_id, ts,
                   app_name, window_title, pid, duration_s, client_updated_at, received_at)
keystroke_buckets (id, client_uuid UNIQUE, user_id, business_id, device_id,
                   ts_bucket, count, client_updated_at, received_at)
browser_visits    (id, client_uuid UNIQUE, user_id, business_id, device_id, ts,
                   url, page_title, browser, duration_s, client_updated_at, received_at)
screenshots       (id, client_uuid UNIQUE, user_id, business_id, device_id, ts,
                   file_path, byte_size, width, height, display_id,
                   client_updated_at, received_at)
download_counts   (file PK, platform, count, updated_at)
```

**Indexes present:** `(business_id, ts)` and `(user_id, ts)` on all four activity
tables; `businesses(owner_user_id)`; `memberships(business_id)`; unique `client_uuid`
per table; partial unique `users(username)`.

**Missing for the target platform:** no `domain` column on `browser_visits` (every
domain rollup requires parsing `url` in SQL or in Go); no `is_idle`/state column; no
`(user_id, business_id, ts)` composite; no aggregation/summary tables; no
`departments`, `job_roles`, `classifications`, `rules`, `alerts`, `audit_log`,
`api_keys`, `refresh_tokens`, `live_sessions`, `webhooks`.

### 5.4 Screenshot storage

Metadata → Postgres. **Bytes → local disk**, `filestore.Store` rooted at
`STORAGE_DIR`:
`screenshots/<business_id>/<user_id>/<yyyy-mm-dd>/<client_uuid>.webp`.
Every path component is a validated UUID or a derived date, so traversal is
impossible by construction; `Open` additionally re-checks the prefix. Writes are
temp-file + rename (atomic). Upload cap 200 KB; the desktop targets ≤50 KB by
stepping WebP quality `[55,45,35,25,20]` then long edge `[1366,1152,960]`.

**No object storage.** `grep` for `s3|minio|r2|b2` across all Go/Rust/TOML: zero
hits. This is single-host-bound and is the main blocker for horizontal scaling.

Images are served through `GET /v1/screenshots/:client_uuid` with a Bearer token, so
the SPA fetches each image via `fetch` + `URL.createObjectURL` (`client.ts:156`).
Correct for authorization; **expensive for a gallery** — every thumbnail is a
separate authenticated round-trip with no caching and no thumbnail variant.

### 5.5 Retention, observability, rate limiting

- `retention.Service` sweeps hourly (`main.go`) plus once at startup, per business
  `screenshot_retention_days`. Files first, then rows, so a partial run self-heals.
  **Only screenshots are swept** — activity/keystroke/browser data is kept forever.
- `obs` package: structured logging with lumberjack rotation; Sentry optional
  (no-op when `SENTRY_DSN` empty). `/healthz` exists but does **not** check the DB.
- Rate limiting: in-memory token bucket, 1 rps / burst 5, **per IP, on `/v1/auth/*`
  only**. Not applied to sync, reports, or screenshot upload. Not shared across
  instances. The bucket map is never evicted (unbounded growth under IP churn).

---

## 6. Web admin (`apps/web-admin`)

React 19 + Vite 7, `base: "/admin/"`, router `basename=/admin`, dev port 5174 with
`/v1` proxied. Pages: `Dashboard`, `Employees`, `EmployeeDetail`, `Settings`, plus
`SignIn` / `SignupWizard`. Report panels: `ActivityPanel`, `BrowserPanel`,
`KeystrokePanel`, `ScreenshotGallery`. i18n across 7 locales. A `demo.ts` module
short-circuits API calls with fixture data when demo mode is on.

Tokens live in **`localStorage`** (`tokenStore.ts`) with an explicit, honest
tradeoff comment in the file. Refresh is single-flight; a failed refresh emits a
logout event.

There is **no** timeline view, no productivity view, no company-wide analytics, no
alerts UI, no playback, no live view.

---

## 7. Build, test, CI, release

| | State |
|---|---|
| CI | **None.** No `.github/`, no `.gitlab-ci.yml`, no any CI config. |
| Go tests | 6, in 2 files — `auth` (4) and `obs` (2). **Zero handler, store, or route tests.** |
| Rust tests | 27, across `trackers` (10), `storage` (10), `settings` (4), `commands` (2), `server` (1). Genuinely good coverage of the tracker decision core. |
| TS tests | **Zero.** No test runner configured in any frontend package. |
| Extension tests | **Zero.** |
| Integration / API / E2E | **Zero.** |
| Docker | `apps/backend/Dockerfile` (multi-stage, non-root uid 10001) + `docker-compose.yml` (Postgres 16 + backend). No web-admin or marketing build stage. |
| Release | Manual. `scripts/sign-macos.sh`, `docs/10-release-signing-notarization.md`. macOS signed with `Developer ID Application: Nguyen Giang Nam (MVT95X368D)`. |
| Auto-update | **Implemented** — `tauri-plugin-updater`, minisign pubkey embedded in `tauri.conf.json`, manifest at `https://bibotracker.com/download/latest.json`, Windows `installMode: quiet`, `createUpdaterArtifacts: true`. |
| Versioning | Ad hoc. No `CHANGELOG.md`. Release branches `release/v1.5.0`, `release/v1.5.1`. |

---

## 8. Configuration

Backend env (`internal/config/config.go`): `PORT`, `DATABASE_URL` (**required**),
`JWT_SECRET` (**required**), `STORAGE_DIR`, `WEB_ADMIN_ORIGIN`, `STATIC_DIR`,
`SENTRY_DSN`, `APP_ENV`, `LOG_DIR`, `LOG_MAX_SIZE_MB`, `LOG_MAX_BACKUPS`,
`LOG_MAX_AGE_DAYS`, `KEEPALIVE_TOKEN`. Fails fast listing all missing required keys.

Desktop backend URL: compile-time Cargo features `local | staging | production`
(default `production`), overridden at runtime by `CTRACKING_BACKEND_URL`.

---

## 9. What works / partially works / is missing

### Works (verified in code, not yet run end-to-end here — see BASELINE_TEST_REPORT.md)
- Active app + window title capture, cross-platform, well tested.
- Idle detection on both platforms.
- Keystroke **counting** with a real, correctly-implemented privacy guarantee.
- Screenshot capture, privacy/normal modes, sensitive-app skip-list, ≤50 KB WebP.
- Local-first SQLite queue with idempotent `client_uuid` sync and offline drain.
- Owner-scoped tenant isolation on every existing read path.
- argon2id password hashing.
- Signed desktop auto-update.
- 7-locale i18n across desktop, web and marketing.
- Screenshot retention sweeper.

### Partially works
- **Browser tracking** — architecture is sound, delivery is unreliable (B1–B5).
- **Windows support** — idle, keys, window, screenshots work; lock/sleep/resume,
  user switching, multi-monitor edge cases and installer/uninstall are unverified.
  The "no OS permission model" shortcut means Windows consent is app-level only.
- **Rate limiting** — auth only, in-memory, unbounded map.
- **Retention** — screenshots only.
- **Health check** — returns OK without checking the database.

### Missing entirely (zero code)
Idle-time persistence · mouse activity · productivity classification · departments ·
job roles · productivity/activity/focus/efficiency scores · unified timeline ·
playback · presence/heartbeat · live screen · rule engine · alerts · reporting API ·
webhooks · API keys · RBAC beyond owner/employee · audit log · object storage ·
background job system · aggregation tables · AI-ready analytics endpoints ·
CI · integration tests · CHANGELOG.

---

## 10. Documentation drift register

| ID | Claim | Reality |
|---|---|---|
| D1 | `packages/` holds shared workspace packages | Directory does not exist; no shared package |
| D2 | Monorepo is backend/web-admin/desktop/extension | `apps/monitor` (full Go module) and `apps/design` also exist, undocumented |
| D3 | `windows.rs`: "Keyboard counting (M2) is stubbed" | Fully implemented |
| D4 | `docs/05-roadmap.md`: all 5 phases "not started" | All 5 phases are implemented and shipped (v1.5.1) |
| D5 | ~~`README.md`: backend on `:8080`~~ | **FIXED 2026-08-26** — README quick start now says `:8090` |
| **D6** | ~~`.env.example` sets `PORT=8080`~~ | **FIXED 2026-08-26** — `.env.example` → `PORT=8090`; `docker-compose.yml` publishes host `:8090`; `dev-backend.sh` announces the port it actually configured and warns when a stale `.env` disagrees. |
| D7 | `README.md`: "Platform: macOS · Windows" production-ready | Windows has never been verified against the checklist in Feature 2 |
| D8 | `CLAUDE.md`: latest migration is `00007_member_username.sql` | Latest is `00009_screenshot_mode.sql` |
| D9 | `tauri.conf.json` identifier is `com.briannguyen.ctracking` (per CLAUDE.md) | Actually `com.briannguyen.bibotracking` |

D6 was a real bug, not just a doc issue. It was the first task in the implementation
order and is now fixed (F1). D1–D4 and D7–D9 remain open and are recorded above.

**CI (added 2026-08-26):** the "no CI at all" row in §7 is now out of date —
`.github/workflows/ci.yml` covers backend (Go), frontend (TypeScript), desktop
(Rust on macOS **and Windows**) and an advisory dependency audit. Test *counts* in
§7 are unchanged: CI runs the existing suites, it does not add tests.
