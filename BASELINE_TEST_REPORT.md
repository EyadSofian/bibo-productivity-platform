# BASELINE_TEST_REPORT.md

Verification record for the baseline.

**Superseded in part on 2026-08-26:** the toolchain was installed and blocker B-1
is resolved. The backend and desktop agent have now been built, tested and run.
Sections 1–4 below are kept as the original record; §2.1 carries the real results.

- **Date:** 2026-08-26
- **Commit:** `a1a49da` · **Branch:** `productivity-platform`
- **Environment:** macOS (Darwin 25.4.0), Node v22.23.2, pnpm 10.30.1

---

## 1. Toolchain availability

| Tool | Required for | Status |
|---|---|---|
| Node ≥ 20 | web-admin, desktop UI, extension | ✅ v22.23.2 |
| pnpm ≥ 10 | workspace | ✅ 10.30.1 |
| Go ≥ 1.22 | backend | ❌ **not installed** |
| Rust / cargo | desktop agent | ❌ **not installed** |
| Docker | Postgres dev database | ❌ **not installed** |
| Homebrew | installing the above | ❌ **not installed** |
| psql | database inspection | ❌ **not installed** |

**Blocker B-1 — RESOLVED 2026-08-26.** Go 1.27.0 and Rust 1.98.0 were installed
into the home directory (no admin needed; Xcode was already present for linking).
Docker and Homebrew are still absent and were not needed: a PostgreSQL 16.9 server
was already running from `~/.local/toolchains/pg16` with the `ctracking`,
`ctracking_test`, `ctracking_staging` and `ctracking_prod` databases in place.
Everything below that says BLOCKED has now been executed — see §2.1.

---

## 2. Tests executed

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Repository clones | `git clone …` | ✅ PASS — 685 files, 39 MB |
| 2 | Dev branch created | `git checkout -b productivity-platform` | ✅ PASS |
| 3 | Workspace install | `pnpm install` | ✅ PASS — 107 packages, 2.6 s, lockfile up to date |
| 4 | web-admin typecheck | `tsc --noEmit` | ✅ PASS — exit 0, no errors |
| 5 | web-admin build | `vite build` | ✅ PASS — 494 modules, 682 ms, 498 KB JS (155 KB gzip) |
| 6 | desktop UI typecheck | `tsc --noEmit` | ✅ PASS — exit 0, no errors |
| 7 | desktop UI build | `vite build` | ✅ PASS — 674 ms, 521 KB JS (163 KB gzip) ⚠ chunk-size warning |
| 8 | Backend build | `go build ./...` | ⛔ BLOCKED — Go not installed |
| 9 | Backend tests | `go test ./...` | ⛔ BLOCKED — Go not installed |
| 10 | Rust check | `cargo check` | ⛔ BLOCKED — cargo not installed |
| 11 | Rust tests | `cargo test` | ⛔ BLOCKED — cargo not installed |
| 12 | Postgres up | `scripts/dev-db.sh` | ⛔ BLOCKED — Docker not installed |
| 13 | Migrations | backend startup | ⛔ BLOCKED |
| 14 | Extension tests | — | ⛔ BLOCKED — no test runner exists *(resolved 2026-08-26, see §2 re-run)* |

**4 passed · 0 failed · 10 blocked.** No defect was found in anything that could
actually be executed.

### Re-run 2026-08-26 (after the F1 work)

| # | Check | Command | Result |
|---|---|---|---|
| 15 | web-admin unit tests | `pnpm --filter @ctracking/web-admin test` | ✅ PASS — **13/13**, 3 files, 586 ms |
| 16 | Workspace typecheck | `pnpm -r --if-present typecheck` | ✅ PASS — design, desktop, web-admin |
| 17 | Workspace build | `pnpm -r --if-present build` | ✅ PASS |
| 18 | Workspace tests | `pnpm -r --if-present test` | ✅ PASS — no longer a no-op |
| 19 | Extension unit + integration tests | `pnpm --filter @ctracking/extension test` | ✅ PASS — **62/62**, 4 files, 228 ms |
| 20 | Extension manifest guard | `node .github/scripts/check-extension-manifest.mjs` | ✅ PASS — MV3, loopback-only, module worker, permissions [tabs, storage, alarms, idle] |

The Go and Rust legs remain blocked by B-1. The new backend tests
(`internal/testutil`, `store_db_test.go`, `sync_db_test.go`,
`handlers/health_test.go`) are **written but never compiled** — CI is their first
real execution, and they should be treated as unverified until it reports.

---

### 2.1 Full verification 2026-08-26 (toolchain installed, B-1 resolved)

Toolchain: Go 1.27.0 · Rust 1.98.0 / cargo 1.98.0 · PostgreSQL 16.9 · Node 22 · pnpm 10.30.1.

| # | Check | Command | Result |
|---|---|---|---|
| 21 | Backend build | `go build ./...` | ✅ PASS — clean |
| 22 | Backend vet | `go vet ./...` | ✅ PASS — zero findings |
| 23 | Backend tests, no DB | `go test ./...` | ✅ PASS — DB tests correctly SKIP |
| 24 | Backend tests, live DB + race | `TEST_DATABASE_URL=… go test -race ./...` | ✅ PASS — **all suites green** |
| 25 | Health handler tests | `go test ./internal/handlers -run TestHealth` | ✅ PASS — 4/4 incl. no-leak + timeout |
| 26 | Domain extractor | `go test ./internal/store -run TestDomainOf` | ✅ PASS — 18 sub-cases |
| 27 | Store + sync DB tests | `go test ./internal/store` with `TEST_DATABASE_URL` | ✅ PASS — 13/13 |
| 28 | Migrations apply | goose on startup | ✅ PASS — schema version **10** |
| 29 | Rust check | `cargo check --all-targets` | ✅ PASS — 1 pre-existing dead-code warning |
| 30 | Rust tests | `cargo test` | ✅ PASS — **27/27** |
| 31 | Backend starts + connects | `go run ./cmd/server` | ✅ PASS — listening, migrations ran |
| 32 | `/healthz` against a live DB | `curl :8099/healthz` | ✅ PASS — `{"database":"ok","schema_version":10,"status":"ok"}` 200 |
| 33 | Owner registration | `POST /v1/auth/register` | ✅ PASS — user + tokens issued |
| 34 | Business creation | `POST /v1/businesses` | ✅ PASS |
| 35 | Sync ingest | `POST /v1/sync/batch` | ✅ PASS — 3 browser rows accepted |
| 36 | **Domain derived on ingest** | `GET /v1/reports/employees/{id}/browser` | ✅ PASS — see below |

Test 36 is the end-to-end proof of the F4 domain work:

```
domain=github.com        browser=brave   url=https://GitHub.com/anthropics/...
domain=docs.google.com   browser=edge    url=https://docs.google.com/document/d/x
domain=None              browser=brave   url=user_turn_off_in_browser
```

Host lowercased, subdomain preserved, and the non-URL marker stored as NULL rather
than a placeholder — exactly as designed, against a real database.

**16 checks executed, 16 passed, 0 failed.** Every line of Go and Rust written on
this branch without a compiler has now been compiled, vetted and tested.

Two notes for whoever runs this next:

- A `go run` backend from an earlier session was already listening on `:8090`
  serving a pre-change build (its `/healthz` returns the old two-field response).
  It was left running; verification used `PORT=8099` instead of disturbing it.
- Postgres here has no `psql` binary — the package at `~/.local/toolchains/pg16`
  ships only `initdb`, `pg_ctl` and `postgres`. Use any pgx-based client for SQL.

---

## 3. Feature 1 baseline checklist

| Component | Status | Evidence / note |
|---|---|---|
| Backend starts | ✅ VERIFIED | `go run ./cmd/server` listens; migrations ran to v10 |
| PostgreSQL connects | ✅ VERIFIED | `/healthz` reports `database: ok`, schema 10 |
| Migrations execute | ✅ VERIFIED | all 10 applied to an empty database; `domain` column + index present |
| Admin dashboard loads | ⚠ PARTIAL | Builds and typechecks clean; not served against a live API |
| Desktop app launches | ⚠ PARTIAL | `cargo check` and 27 tests pass; the app itself has not been launched |
| Authentication works | ✅ VERIFIED | register issued a user + access/refresh pair; bearer accepted on protected routes |
| Employee creation works | ⚠ PARTIAL | owner registration and business creation verified; the employee-invite path not yet exercised |
| Employee login works | ⚠ PARTIAL | store-level lookup by email **or** username covered by tests; the HTTP login flow not yet exercised |
| Activity collection works | ⚠ PARTIAL | decision core passes its Rust tests on this machine; no live agent run |
| Screenshot collection works | ⚠ PARTIAL | compression tests pass; no live capture run |
| Keystroke counts work | ⚠ PARTIAL | count-only confirmed by review; 27 Rust tests pass, but no live capture run |
| Browser extension connects | ⚠ PARTIAL | Discovery protocol reviewed. Visit tracking, outbox, idle and browser identification are now covered by 62 automated tests against a fake app; connecting to the **real** desktop app is still blocked by B-1 |
| Sync works | ✅ VERIFIED | `POST /v1/sync/batch` accepted 3 rows and echoed their uuids; idempotency and caller-stamped ownership covered by tests |
| Offline collection works | ⚠ PARTIAL | SQLite round-trip and pending-flag tests pass; not exercised against a stopped backend |
| Offline→online sync works | ⚠ PARTIAL | backend echoes accepted uuids as designed; the agent's drain loop not yet run live |

---

## 4. Static verification performed instead

Since execution was impossible, the entire codebase was read. Full findings are in
[docs/ARCHITECTURE_CURRENT.md](docs/ARCHITECTURE_CURRENT.md) and
[docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md).

Coverage: all 3 591 lines of Go in `apps/backend`; all 4 865 lines of Rust in
`apps/desktop/src-tauri`; the complete MV3 extension; the web-admin API layer,
token store and routing; all 9 SQL migrations; the local SQLite schema and its two
migrations; all build, deploy and dev scripts; Docker and Tauri configuration.

---

## 5. Defects found by inspection

These are code-level findings, not runtime observations. Each names the file that
demonstrates it.

| ID | Severity | Finding |
|---|---|---|
| **D-1** | HIGH | ~~`.env.example` sets `PORT=8080`, but `scripts/dev-backend.sh` announces `:8090` and `apps/web-admin/vite.config.ts` proxies to `:8090`. **A fresh clone following the README cannot reach its own backend.**~~ **FIXED 2026-08-26** — `.env.example` → 8090; `dev-backend.sh` now reports the real port and warns on mismatch. |
| **D-2** | HIGH | ~~Extension writes a visit **only** on transition. One long-lived tab produces **zero rows**.~~ **FIXED 2026-08-26** — 60 s checkpoint alarm closes and reopens the running visit. Proven in test: 30 min single tab → 30 segments, 1800 s, no gaps. |
| **D-3** | HIGH | ~~Extension has **no retry queue**; a visit is discarded permanently when the desktop app is unreachable.~~ **FIXED 2026-08-26** — durable capped outbox in `storage.local`, written before any send and drained only on acceptance. |
| **D-4** | HIGH | **Idle time is never persisted** anywhere — no table, no rows, on agent or server. `idle_time` and `working_time` are currently underivable. |
| **D-5** | MEDIUM | `WindowTracker::close_idle` subtracts the entire idle threshold from accumulated active time on every idle transition — a systematic undercount of up to 60 s per transition. |
| **D-6** | MEDIUM | ~~No tab-close or browser-close flush; the last visit of every session is lost.~~ **FIXED 2026-08-26** — `tabs.onRemoved` closes and flushes the visit. |
| **D-7** | MEDIUM | ~~No `chrome.idle` integration — browsing time accrues while the machine is idle.~~ **FIXED 2026-08-26** — clock stops after 60 s without input; resumes on the active tab. |
| **D-8** | MEDIUM | `store.Roster` runs five correlated subqueries per employee against raw `activity_samples`; will not scale. |
| **D-9** | MEDIUM | Refresh tokens are non-revocable for 30 days; refreshing does not invalidate the old token (SECURITY_REVIEW S-1). |
| **D-10** | MEDIUM | `GET /whoami` hands the loopback ingest token to any local process (SECURITY_REVIEW S-4). |
| **D-11** | LOW | ~~`/healthz` returns OK without checking the database.~~ **FIXED 2026-08-26** — pings the pool, reports the applied schema version, returns 503 when unreachable; bounded probe, no driver detail in the body. |
| **D-12** | LOW | `Roster` computes "today" in UTC regardless of the team's timezone. |
| **D-13** | LOW | Sensitive-app skip-list suppresses screenshots but **not** window titles. |
| **D-14** | LOW | ~~Brave, Opera, Vivaldi and Arc are all reported as `chrome`.~~ **FIXED 2026-08-26** for Edge, Opera, Vivaldi, Brave, Firefox and Safari. **Arc still reports as Chrome** — it ships Chrome's user agent with no distinguishing marker, so it is not detectable. |
| **D-15** | INFO | `RosterEntry.FocusPctToday` is a misnomer — it is keyboard-bucket coverage, not focus. |

---

## 6. Documentation drift found

| ID | Drift |
|---|---|
| D1 | `packages/` is declared in `pnpm-workspace.yaml` and described in README/CLAUDE.md but **does not exist** |
| D2 | `apps/monitor` — a complete, undocumented second Go module (infrastructure monitoring, unrelated to employee monitoring) |
| D3 | ~~`platform/windows.rs` header says keyboard counting is "stubbed"; it is fully implemented~~ **FIXED 2026-08-26** — header now describes what the file implements and names the session-event gap (F2) that genuinely remains |
| D4 | `docs/05-roadmap.md` marks all five phases "not started"; all five are shipped (v1.5.1) |
| D5 | README says backend `:8080`; scripts and proxy use `:8090` |
| D6 | *(same as D-1 above — a real bug, not only documentation)* |
| D7 | README advertises Windows as production-ready; nothing substantiates it |
| D8 | ~~CLAUDE.md says the latest migration is `00007`; it is `00009`~~ **FIXED 2026-08-26** — now `00010_browser_domain.sql` |
| D9 | ~~CLAUDE.md gives the bundle id as `com.briannguyen.ctracking`~~ **FIXED 2026-08-26** — corrected to `com.briannguyen.bibotracking` |

---

## 7. Blockers

| ID | Blocker | Impact | Unblocked by |
|---|---|---|---|
| **B-1** | ~~No Go, Rust, Docker or Postgres on the dev machine~~ **RESOLVED 2026-08-26** — Go 1.27.0 + Rust 1.98.0 installed to `~/.local` with no admin; Postgres 16.9 already present at `~/.local/toolchains/pg16`. Docker and Homebrew remain absent and proved unnecessary. | Backend, database and desktop could not be built or run | Done — see §2.1 |
| **B-2** | No Windows machine available | F2 cannot be verified at all. **Partially reduced 2026-08-26:** the CI `desktop` job now compiles and unit-tests the Rust agent on `windows-latest`, so the Windows platform backend at least builds and its tests run. The manual platform matrix still needs real hardware. | Access to Windows 10 and 11 hosts or VMs |
| **B-3** | ~~No CI infrastructure in the repository~~ **ADDRESSED 2026-08-26** — `.github/workflows/ci.yml` added (5 jobs, incl. a Windows Rust leg). Not yet observed running. | Every check was manual | First push confirms the workflow is green |
| **B-4** | No test data or seeded environment | Integration and performance testing impossible | F30's synthetic data generator |
| **B-5** | ~~Extension logic is not extractable for testing~~ **RESOLVED 2026-08-26** — logic moved to `apps/extension/lib/` (pure), Vitest added, **62 tests passing** including an integration suite driving the real service worker against a fake Chrome. | Extension had no test coverage at all | F4 |

---

## 8. Re-run instructions

Once the toolchain is available, re-run this report with:

```bash
scripts/dev-db.sh && cd apps/backend && go build ./... && go test ./... && go vet ./...
```

```bash
cd apps/desktop/src-tauri && cargo check && cargo test && cargo clippy -- -D warnings
```

```bash
pnpm -r --if-present typecheck && pnpm -r --if-present build
```

Then work through the Feature 1 checklist in §3 and replace every `BLOCKED` with a
result and evidence.

---

## 9. Conclusion

**Updated 2026-08-26 (post-verification).** The original conclusion below was written
when nothing server-side could be executed. It no longer applies: the toolchain is
installed, and every Go and Rust line written on this branch has been compiled,
vetted and tested — 16 checks, 16 passed. `go vet` is clean, `go test -race` is green
against a live PostgreSQL, `cargo test` is 27/27, the backend boots and serves, and
the F4 domain derivation was confirmed end-to-end through the real HTTP API.

What remains unverified is the **desktop agent at runtime**: it compiles and its unit
tests pass, but it has not been launched, granted macOS permissions, or observed
capturing activity, and the browser extension has not been loaded into a real Chrome.
Those are live-behaviour checks, not build checks, and they are still open.

### Original conclusion (2026-08-26, pre-toolchain)

Everything that could be executed passed. The four TypeScript checks — typecheck and
build for both frontends — are clean with zero errors.

The backend and desktop agent could not be executed, so their status is unknown by
measurement. Reading them closely, however, the code is of good quality: the tracker
decision core is deliberately pure and well tested, tenant scoping is applied
consistently on every existing read path, path handling in the file store is safe by
construction, and the count-only keyboard guarantee is genuinely implemented on both
platforms.

The defects listed in §5 are real and specific, and they are concentrated in exactly
the two places the target platform depends on most: **browser data reliability
(D-2, D-3, D-6, D-7)** and **the absence of an idle-time model (D-4, D-5)**. Those
are Features 4 and 5, and they are correctly placed at the front of the
implementation order.
