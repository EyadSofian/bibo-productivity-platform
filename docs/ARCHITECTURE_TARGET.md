# ARCHITECTURE_TARGET.md

Target state for the productivity-monitoring platform. Written against the verified
baseline in [ARCHITECTURE_CURRENT.md](ARCHITECTURE_CURRENT.md).

**Governing principle: evolve, do not rewrite.** The existing tracker decision core,
the local-first SQLite queue, the idempotent `client_uuid` sync protocol, and the
owner-scoped tenant filter are correct and well tested. They are the foundation, not
the thing to replace.

**Second principle: modular monolith.** One Go binary, one Postgres, clear internal
package boundaries. No microservices until a measured bottleneck justifies one. The
only processes that may be split out later are the worker pool and the WebRTC SFU.

---

## 1. Target diagram

```
                              Employee Device
                                     │
        ┌────────────────┬───────────┼───────────┬────────────────┐
        │                │           │           │                │
   Activity Monitor  Screen Capture  │   Browser Monitor    Presence Agent
   ├ active window    ├ privacy mode │   ├ MV3 extension    ├ heartbeat 30 s
   ├ window title     ├ full screen  │   ├ local queue      ├ state machine
   ├ idle detection   ├ skip-list    │   ├ periodic flush   │  ACTIVE/IDLE/LOCKED
   ├ key COUNTS       └ blur (opt)   │   └ idle-aware       └ session events
   ├ mouse COUNTS                    │
   └ power/lock events               │
        └────────────────┴───────────┴───────────┴────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  Local Queue (SQLite)│  local-first, offline-safe
                          │  + local retention   │  NEW: idle_period, input_sample,
                          └──────────┬──────────┘        session_event
                                     │
                          ┌──────────▼──────────┐
                          │     Sync Layer       │  batched, idempotent,
                          │  exponential backoff │  client_uuid upsert
                          └──────────┬──────────┘
                                     │ HTTPS · JWT (agent) / API key (integrations)
                ┌────────────────────▼────────────────────┐
                │            Backend API (Go)              │
                │  /api/v1/*  versioned · RBAC · tenant    │
                └──┬──────────────┬───────────────┬────────┘
                   │              │               │
         ┌─────────▼──┐   ┌───────▼──────┐  ┌────▼─────────┐
         │ PostgreSQL │   │Object Storage│  │ Redis + Queue│
         │  raw +     │   │ S3/R2/MinIO  │  │  (asynq)     │
         │  summaries │   │ screenshots  │  │  optional    │
         └─────────┬──┘   └──────────────┘  └────┬─────────┘
                   │                              │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼──────────────┐
                   │      Analytics Engine        │
                   │  (internal packages)         │
                   ├──────────┬─────────┬─────────┤
                   │ Activity │Productiv│  Rules  │
                   │  Engine  │ ity Eng.│  Engine │
                   │ normalize│ classify│ evaluate│
                   │ dedupe   │ score   │ alert   │
                   └──────────┴────┬────┴─────────┘
                                   │
                   ┌───────────────▼───────────────┐
                   │     Management Dashboard       │
                   ├────────┬──────────┬────────────┤
                   │Employees│ Timeline │  Reports   │
                   │ Company │ Playback │  Alerts    │
                   │  Live   │          │  Settings  │
                   └────────────────────────────────┘
```

---

## 2. Backend package layout (target)

```
apps/backend/internal/
├── auth/           existing + refresh-token store, API keys, MFA hooks
├── rbac/           NEW  roles, permissions, policy checks
├── config/         existing
├── db/             existing + new migrations
├── obs/            existing + metrics
├── middleware/     existing + tenant guard, RBAC guard, general rate limit
├── store/          existing, split per aggregate as it grows
├── handlers/       existing, re-mounted under /api/v1
├── blobstore/      NEW  interface: Put/Get/Delete/SignedURL
│                        impls: local (existing filestore), s3 (S3/R2/MinIO/B2)
├── activity/       NEW  Activity Engine — normalization, dedupe, rollups
├── productivity/   NEW  Productivity Engine — classification + scores
├── scoring/        NEW  configurable score/weight evaluation
├── rules/          NEW  Rule Engine — trigger/condition/window/action/cooldown
├── alerts/         NEW  alert lifecycle, dedupe, cooldown, severity, ack
├── reports/        NEW  report builders + CSV/JSON export
├── presence/       NEW  heartbeat ingest, state machine, SSE/WS fanout
├── live/           NEW  live-screen session authorization + signalling
├── webhooks/       NEW  HMAC signing, retries, delivery log
├── audit/          NEW  append-only audit log
├── retention/      existing, extended to all data classes
└── jobs/           NEW  background worker registry
```

**Rule:** engines are pure-ish packages that take data and configuration and return
results. They must be unit-testable without a database or HTTP.

---

## 3. The Activity Engine (Feature 5) — resolving C1–C5

The current agent stores only active intervals. The target stores an explicit,
gap-free account of the working span.

### 3.1 New agent-side tables (SQLite v3)

```sql
idle_period   (id, start_ts, end_ts, reason, client_uuid, synced, updated_at)
              -- reason: 'idle' | 'locked' | 'sleep' | 'paused'
input_sample  (id, ts_bucket, key_count, mouse_count, client_uuid, synced, updated_at)
              -- supersedes keystroke_bucket; keystroke_bucket retained for migration
session_event (id, ts, kind, client_uuid, synced, updated_at)
              -- kind: 'agent_start' | 'agent_stop' | 'lock' | 'unlock'
              --     | 'sleep' | 'wake' | 'user_switch'
```

`session_event` is what finally separates C3's four collapsed states.

### 3.2 Normalized time model

For an employee-day, the engine produces a **non-overlapping, ordered segment list**:

```
segment = { start_ts, end_ts, state, app, window_title, url, domain, source }
state   ∈ ACTIVE | IDLE | LOCKED | ASLEEP | PAUSED | OFFLINE | UNKNOWN
```

Derived metrics, all from the same segment list so they cannot disagree:

```
working_time   = last_signal_ts − first_signal_ts − OFFLINE − PAUSED
active_time    = Σ ACTIVE
idle_time      = Σ (IDLE + LOCKED + ASLEEP)
activity_pct   = active_time / (active_time + idle_time) × 100
app_duration   = Σ ACTIVE grouped by app
browser_duration = Σ ACTIVE where source = browser, grouped by domain
```

### 3.3 Conflict resolution rules (must be explicit and tested)

| Situation | Rule |
|---|---|
| Browser visit overlaps an activity sample | Browser is a **refinement**, not an addition. The activity sample owns the second; the browser row supplies `url`/`domain`/`page_title`. Never sum both. |
| Two activity samples overlap (clock skew, two devices) | Later `client_updated_at` wins for the overlap; the loser is truncated. |
| Gap < `GAP_TOLERANCE_S` (default 90 s) between samples | Bridge as `IDLE`. |
| Gap ≥ `GAP_TOLERANCE_S` with no `session_event` | `UNKNOWN` — reported separately, never counted as active or idle. |
| Gap bounded by `agent_stop` / `agent_start` | `OFFLINE`. |
| Gap bounded by `lock` / `unlock` | `LOCKED`. |
| Sample crosses midnight in the employee's timezone | Split at the boundary; each part belongs to its own day. |
| Idle-threshold grace (C2) | Stop discarding it. Emit an `idle_period` starting at `now − threshold` instead, so the seconds are re-attributed rather than lost. |

### 3.4 Timezone

All storage stays **unix seconds UTC**. Every *day* boundary is computed in the
employee's timezone. `users` gains a `timezone` column (IANA, default from the
business). The current `Roster` handler hard-codes `time.Now().UTC()` day
boundaries — a known correctness bug for non-UTC teams.

---

## 4. Productivity Engine (Features 6–10)

### 4.1 Classification

```sql
classification_rule (
  id, business_id,
  scope        CHECK (scope IN ('global','company','department','role','employee')),
  scope_id     uuid NULL,           -- department/role/employee id, NULL for company
  match_type   CHECK (match_type IN ('app','domain','url_pattern','title_pattern')),
  match_value  text,
  category     CHECK (category IN ('PRODUCTIVE','NEUTRAL','UNPRODUCTIVE')),
  priority     integer,
  created_at, updated_at
)
```

**Resolution order (first match wins):**

```
employee override → role rule → department rule → company rule → global default
                                                        → UNCLASSIFIED
```

Within a scope, more specific `match_type` wins: `url_pattern` > `domain` >
`title_pattern` > `app`. Ties break on `priority` then newest.

This must be a pure function
`classify(segment, ruleset) → (category, matched_rule_id)`, memoized per
`(app, domain, employee)` for a request, and exhaustively unit tested.

### 4.2 Scores — configurable, never hard-coded

```sql
scoring_config (id, business_id, name, weights jsonb, params jsonb,
                effective_from, created_at)
```

| Score | Definition (default; all weights configurable) |
|---|---|
| **Activity** | `active_time / (active_time + idle_time) × 100`, optionally blended with input intensity normalized against a role baseline |
| **Productivity** | `productive_active_time / classified_active_time × 100`. `UNCLASSIFIED` is excluded from the denominator and reported separately, so low coverage is visible rather than silently deflating the score. |
| **Focus** | Sustained productive work. Inputs: longest productive run, count of productive sessions ≥ `focus_min_session_s`, context switches per productive hour, idle interruptions. **Role-aware:** each role carries an expected switch rate; a support agent at 40 switches/hour is not penalized against a developer's baseline. |
| **Efficiency** | `w_a·Activity + w_p·Productivity + w_f·Focus + w_i·Idle`. Default `25/40/25/10`. |

**Efficiency must be labelled in the UI and in every API response as an
organization-defined operational metric, not a scientific measure of performance.**
Ship it with `"metric_type": "organization_defined"` in the payload.

### 4.3 Recomputation

Scores are derived, never authoritative. Changing a classification rule or a weight
must recompute affected summaries. Store `scoring_config_id` and `ruleset_version`
on every summary row so a score can always be explained and reproduced.

---

## 5. Storage strategy

### 5.1 Object storage (Feature 14)

```go
type BlobStore interface {
    Put(ctx, key string, r io.Reader, size int64, contentType string) error
    Get(ctx, key string) (io.ReadCloser, error)
    Delete(ctx, keys ...string) error
    SignedURL(ctx, key string, ttl time.Duration) (string, error)
}
```

Two implementations: `local` (wraps the existing `filestore`, keeps self-hosting
one-binary-simple) and `s3` (AWS S3, Cloudflare R2, MinIO, Backblaze B2 — all
S3-compatible). Chosen by `BLOB_BACKEND=local|s3`.

`screenshots.file_path` becomes `storage_key` + `storage_backend`. Migration
backfills existing rows as `local`.

**Screenshots are served via short-TTL signed URLs**, not proxied bytes — this fixes
the per-thumbnail authenticated round-trip. Authorization is checked when the URL is
minted; TTL ≤ 300 s; every mint is audit-logged (Feature 26). A separate small
thumbnail variant is generated for gallery and playback scrubbing.

### 5.2 Aggregation (Feature 28)

Raw rows are never scanned for a dashboard.

```sql
activity_hourly (business_id, user_id, hour_ts, active_s, idle_s,
                 productive_s, neutral_s, unproductive_s, unclassified_s,
                 key_count, mouse_count, switches, PRIMARY KEY(...))
activity_daily  (business_id, user_id, day, timezone, working_s, active_s, idle_s,
                 productive_s, neutral_s, unproductive_s, unclassified_s,
                 activity_score, productivity_score, focus_score, efficiency_score,
                 scoring_config_id, ruleset_version, ...)
app_daily       (business_id, user_id, day, app_name, active_s, category)
domain_daily    (business_id, user_id, day, domain, active_s, category)
```

Regular tables maintained by workers (not materialized views) so they can be
incrementally updated and selectively recomputed. Indexes to add on raw tables:
`(business_id, user_id, ts)`, `(business_id, ts)` already exists,
`browser_visits(business_id, domain, ts)` after adding a `domain` column.

---

## 6. API surface (Feature 21)

**Decision: mount the new API at `/api/v1` and keep `/v1` as a frozen compatibility
alias for shipped desktop agents and extensions.** Old agents in the field cannot be
force-upgraded. `/v1` gets no new routes; it is deprecated with a sunset date once
auto-update adoption is confirmed.

```
GET  /api/v1/employees
GET  /api/v1/employees/{id}
GET  /api/v1/employees/{id}/activity
GET  /api/v1/employees/{id}/applications
GET  /api/v1/employees/{id}/websites
GET  /api/v1/employees/{id}/screenshots
GET  /api/v1/employees/{id}/timeline
GET  /api/v1/employees/{id}/productivity
GET  /api/v1/employees/{id}/efficiency
GET  /api/v1/employees/{id}/focus-sessions
GET  /api/v1/reports/company
GET  /api/v1/reports/employees
GET  /api/v1/reports/departments
GET  /api/v1/alerts
POST /api/v1/alerts/{id}/acknowledge
GET  /api/v1/presence
POST /api/v1/presence/heartbeat            (agent)
GET  /api/v1/analytics/summary             (AI-ready)
GET  /api/v1/analytics/compare             (AI-ready)
GET  /api/v1/analytics/outliers            (AI-ready)
CRUD /api/v1/classifications
CRUD /api/v1/departments  /api/v1/roles
CRUD /api/v1/rules  /api/v1/webhooks  /api/v1/api-keys
GET  /api/v1/audit
```

**Conventions, enforced by shared middleware and tested for every route:**
cursor pagination (`limit`, `cursor`); `from`/`to` unix seconds with a documented
max range; consistent error envelope `{error: {code, message, details}}`;
`X-Request-Id` on every response; explicit `403` for cross-tenant, `404` for
non-existent-or-not-visible.

**Authentication:** JWT for the dashboard and the agent; API keys
(`Authorization: Bearer sk_...`, hashed at rest, scoped, revocable) for integrations.

---

## 7. Presence and live view (Features 16–17)

**Presence:** agent heartbeat every 30 s carrying `{state, app, since}`. Backend
keeps last-heartbeat per device in Redis (or Postgres when Redis is absent) and
derives `ONLINE / ACTIVE / IDLE / LOCKED / OFFLINE` with a 90 s offline timeout.
Dashboard subscribes via **SSE** (simpler than WebSocket, one-directional, survives
proxies). One SSE stream per dashboard session, fanned out from an in-process hub.

**Live screen:** WebRTC, agent as sender, manager browser as receiver, backend as
signalling + TURN credential issuer. Strictly gated:

- requires the `view_live_screen` permission, checked at session creation;
- creates a `live_session` row (`manager_id`, `employee_id`, `start_ts`, `end_ts`,
  `session_id`) which **is** the audit record;
- the agent shows a visible, non-dismissible indicator while streaming — this is a
  hard requirement, not a setting;
- **no automatic recording**, ever;
- one-time signalling tokens, ≤ 60 s TTL, single-use, bound to session + employee.

**Build this last.** It depends on presence, RBAC, and audit all being solid.

---

## 8. Background jobs (Feature 29)

Start with an **in-process scheduler** in the existing binary (the retention sweeper
already sets this precedent). Introduce Redis + `asynq` only when a job needs
retries with visibility, or a second instance is deployed.

| Job | Cadence |
|---|---|
| hourly rollup | every 10 min, last 2 h window |
| daily rollup + scores | hourly, plus at each timezone's midnight+15 min |
| rule evaluation | every 5 min |
| alert dispatch | every 1 min |
| webhook delivery | continuous with exponential backoff |
| retention sweep (all classes) | hourly |
| recompute-on-rule-change | on demand, enqueued |

Every job: idempotent, bounded batch, structured start/end/error logging, a metric.

---

## 9. Security and privacy posture (Features 32–33)

Preserved as hard invariants, enforced by tests:

- **Keyboard capture stays count-only.** No keycode is ever read, on any platform.
- **No credential or content capture.** No form fields, no cookies, no clipboard.
- **No stealth.** The agent is visible in the tray/menu bar, its window is
  reachable, pause is available where policy allows, and live view is indicated.
- **Sensitive-app exclusion** is expanded and applies to screenshots *and*
  window-title capture (currently titles are captured even for skip-listed apps).

Added:

- RBAC with an explicit permission matrix, `view_live_screen` and `view_screenshots`
  as separate grants.
- Append-only audit log for every sensitive action.
- Tenant guard middleware so business scoping is structural, not per-handler.
- Signed, short-TTL screenshot URLs.
- Refresh-token rotation with reuse detection and a revocation store.
- General rate limiting (not just auth), with a bounded, evicting bucket map.

---

## 10. Deployment target (Feature 34)

```
Reverse proxy / Cloudflare Tunnel (TLS)
        │
        ├── backend (Go binary or container) ×N stateless
        ├── worker  (same binary, --mode=worker) — optional, when Redis is present
        │
        ├── PostgreSQL 16          (managed or self-hosted, PITR backups)
        ├── Object storage         (S3 / R2 / MinIO / B2)
        └── Redis                  (optional: presence, queue, rate limits)
```

Stateless backend is the goal — the only thing preventing horizontal scale today is
local screenshot disk, which §5.1 removes. Secrets via environment/secret manager,
never committed. `.env.example` stays the documented contract.
