# BASELINE_TEST_REPORT.md

Verification record for the baseline. This report is **partial**: the dev machine
has no Go, Rust, Docker, Homebrew or Postgres, so the backend and desktop agent
could not be built or run. Everything that could be verified was; everything that
could not is recorded as a blocker rather than assumed to work.

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

**Blocker B-1:** without Go, Rust, Docker and Postgres, the backend, database and
desktop agent cannot be built or run here. All backend/desktop items below are
`BLOCKED`, not `FAILED` — no defect is implied.

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
| 14 | Extension tests | — | ⛔ BLOCKED — no test runner exists |

**4 passed · 0 failed · 10 blocked.** No defect was found in anything that could
actually be executed.

---

## 3. Feature 1 baseline checklist

| Component | Status | Evidence / note |
|---|---|---|
| Backend starts | ⛔ BLOCKED | B-1 |
| PostgreSQL connects | ⛔ BLOCKED | B-1 |
| Migrations execute | ⛔ BLOCKED | 9 migration files reviewed; goose, embedded, run from `main.go` before the pool opens |
| Admin dashboard loads | ⚠ PARTIAL | Builds and typechecks clean; not served against a live API |
| Desktop app launches | ⛔ BLOCKED | B-1. UI half builds clean |
| Authentication works | ⛔ BLOCKED | Code reviewed: argon2id + JWT access/refresh, kinds enforced |
| Employee creation works | ⛔ BLOCKED | Handler reviewed; validation present |
| Employee login works | ⛔ BLOCKED | Handler reviewed; identifier = email or username |
| Activity collection works | ⛔ BLOCKED | Decision core reviewed and covered by 10 Rust unit tests |
| Screenshot collection works | ⛔ BLOCKED | Capture + compression reviewed; 2 unit tests exist |
| Keystroke counts work | ⛔ BLOCKED | Both platform implementations reviewed — count-only confirmed |
| Browser extension connects | ⛔ BLOCKED | Discovery protocol reviewed; **defects found by inspection, see §5** |
| Sync works | ⛔ BLOCKED | Worker + client reviewed; idempotent upsert by `client_uuid` |
| Offline collection works | ⛔ BLOCKED | Design verified: `synced = 0` rows persist; sound by construction |
| Offline→online sync works | ⛔ BLOCKED | Design verified: backoff 300 s → 960 s, marks only echoed uuids |

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
| **D-1** | HIGH | `.env.example` sets `PORT=8080`, but `scripts/dev-backend.sh` announces `:8090` and `apps/web-admin/vite.config.ts` proxies to `:8090`. **A fresh clone following the README cannot reach its own backend.** |
| **D-2** | HIGH | Extension writes a visit **only** on transition (`background.js`). One long-lived tab produces **zero rows** — the direct cause of the reported `"browser_visit": []`. |
| **D-3** | HIGH | Extension has **no retry queue**: `postVisit` returns `false` and the visit is discarded permanently when the desktop app is unreachable. |
| **D-4** | HIGH | **Idle time is never persisted** anywhere — no table, no rows, on agent or server. `idle_time` and `working_time` are currently underivable. |
| **D-5** | MEDIUM | `WindowTracker::close_idle` subtracts the entire idle threshold from accumulated active time on every idle transition — a systematic undercount of up to 60 s per transition. |
| **D-6** | MEDIUM | No tab-close or browser-close flush in the extension; the last visit of every session is lost. |
| **D-7** | MEDIUM | Extension has no `chrome.idle` integration — browsing time accrues while the machine is idle, contradicting the desktop tracker and double-counting. |
| **D-8** | MEDIUM | `store.Roster` runs five correlated subqueries per employee against raw `activity_samples`; will not scale. |
| **D-9** | MEDIUM | Refresh tokens are non-revocable for 30 days; refreshing does not invalidate the old token (SECURITY_REVIEW S-1). |
| **D-10** | MEDIUM | `GET /whoami` hands the loopback ingest token to any local process (SECURITY_REVIEW S-4). |
| **D-11** | LOW | `/healthz` returns OK without checking the database. |
| **D-12** | LOW | `Roster` computes "today" in UTC regardless of the team's timezone. |
| **D-13** | LOW | Sensitive-app skip-list suppresses screenshots but **not** window titles. |
| **D-14** | LOW | Brave, Opera, Vivaldi and Arc are all reported as `chrome` by the extension. |
| **D-15** | INFO | `RosterEntry.FocusPctToday` is a misnomer — it is keyboard-bucket coverage, not focus. |

---

## 6. Documentation drift found

| ID | Drift |
|---|---|
| D1 | `packages/` is declared in `pnpm-workspace.yaml` and described in README/CLAUDE.md but **does not exist** |
| D2 | `apps/monitor` — a complete, undocumented second Go module (infrastructure monitoring, unrelated to employee monitoring) |
| D3 | `platform/windows.rs` header says keyboard counting is "stubbed"; it is fully implemented |
| D4 | `docs/05-roadmap.md` marks all five phases "not started"; all five are shipped (v1.5.1) |
| D5 | README says backend `:8080`; scripts and proxy use `:8090` |
| D6 | *(same as D-1 above — a real bug, not only documentation)* |
| D7 | README advertises Windows as production-ready; nothing substantiates it |
| D8 | CLAUDE.md says the latest migration is `00007`; it is `00009` |
| D9 | CLAUDE.md gives the bundle id as `com.briannguyen.ctracking`; it is `com.briannguyen.bibotracking` |

---

## 7. Blockers

| ID | Blocker | Impact | Unblocked by |
|---|---|---|---|
| **B-1** | No Go, Rust, Docker or Postgres on the dev machine | Backend, database and desktop cannot be built or run | Installing the toolchain (needs admin rights / Homebrew) |
| **B-2** | No Windows machine available | F2 cannot be verified at all | Access to Windows 10 and 11 hosts or VMs |
| **B-3** | No CI infrastructure in the repository | Every check is manual | F1 adds `.github/workflows/ci.yml` |
| **B-4** | No test data or seeded environment | Integration and performance testing impossible | F30's synthetic data generator |
| **B-5** | Extension logic is not extractable for testing | Extension cannot be unit tested at all | F4 refactors the visit state machine into a module |

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
