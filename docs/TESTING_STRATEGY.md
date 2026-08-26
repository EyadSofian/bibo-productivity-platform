# TESTING_STRATEGY.md

## 1. Where we are starting from

| Layer | Framework | Count | Coverage |
|---|---|---|---|
| Go backend | stdlib `testing` | **6** | `auth` (4), `obs` (2). **Zero** handler, store, or route tests. |
| Rust desktop | built-in `#[cfg(test)]` | **27** | `trackers` (10), `storage` (10), `settings` (4), `commands` (2), `server` (1) |
| web-admin | *none* | **0** | No test runner installed |
| desktop UI | *none* | **0** | No test runner installed |
| extension | *none* | **0** | No test runner, no build step |
| Integration | *none* | **0** | — |
| API contract | *none* | **0** | — |
| E2E | *none* | **0** | — |
| CI | *none* | — | No `.github/`, no CI config of any kind |

**The good news:** the 27 Rust tests are genuinely well-designed. `WindowTracker::tick`
was deliberately written as a pure function over `(active, window, threshold, now)`
so it can be tested without timers or platform calls, and it is — including the
subtle idle-grace-trim and chunking cases. `compress_to_webp` is tested against a
synthetic high-entropy image. The skip-list matcher is tested for whole-word,
case-insensitive behaviour including negatives (`Outline` must not match `LINE`).

**Follow that pattern everywhere.** Extract decision logic into pure functions; test
those exhaustively; keep the I/O shell thin.

**The bad news:** the backend has no test for a single HTTP route, a single store
query, or a single authorization check — and authorization is the thing this product
most needs to get right.

---

## 2. Testing pyramid for this project

```
                    ╱ Manual (documented, repeatable) ╲     ← platform + privacy
                   ╱───────────────────────────────────╲
                  ╱   E2E: 5–10 critical user flows      ╲
                 ╱─────────────────────────────────────────╲
                ╱  API contract: every route × every status  ╲   ← the safety net
               ╱───────────────────────────────────────────────╲
              ╱   Integration: desktop→API→DB, ext→desktop       ╲
             ╱─────────────────────────────────────────────────────╲
            ╱      Unit: engines, calculations, matchers, parsers    ╲  ← the bulk
           ╱───────────────────────────────────────────────────────────╲
```

The **API contract layer is unusually important here** because tenant isolation is
the product's core security property. Every route gets a cross-tenant test, always.

---

## 3. Unit tests

### What must be unit tested (non-negotiable)

| Area | Why |
|---|---|
| Activity engine segment builder (F5) | Every downstream number is arithmetic on it |
| Overlap resolution and gap classification | Silent wrongness otherwise |
| Timezone / midnight / DST handling | Off-by-one-day errors are invisible and common |
| Classification hierarchy (F6) | Five levels of precedence; easy to get subtly wrong |
| Score formulas (F8, F9, F10) | Managers will act on these numbers |
| Focus role-awareness (F9) | The feature is meaningless if it punishes normal behaviour |
| Extension visit state machine (F4) | Source of the reported data-loss defect |
| RBAC matrix resolution (F25) | Security-critical |
| Signed URL minting/verification (F14) | Security-critical |
| Refresh rotation + reuse detection (F24) | Security-critical |
| CSV escaping (F20) | Formula injection |
| Rate-limit bucket eviction (F24) | Memory exhaustion |

### Conventions
- **Go:** table-driven tests. `internal/testutil` provides a disposable Postgres for
  store tests. Pure engine packages (`activity`, `productivity`, `scoring`, `rules`)
  must be testable with **no database at all**.
- **Rust:** keep decision cores pure, as `WindowTracker` already is. Use
  `Db::open_in_memory()` (already provided) for storage tests.
- **TypeScript:** Vitest + Testing Library. Test the API client's refresh
  single-flight, token store, formatters, and each dashboard section's states.
- **Extension:** Vitest with a mocked `chrome.*` namespace. The visit state machine
  must be extracted from `background.js` into a testable module — currently it is
  entangled with the listeners and cannot be tested at all.

### Property tests where they earn their place
- `working = active + idle + unknown` for any generated day (F5).
- Summary tables always equal a raw recomputation (F28).
- Re-syncing any batch changes no totals (idempotency).

---

## 4. Integration tests

Boundaries that must be exercised, per the spec:

### Desktop → API
- [ ] Batch sync of activity, keystrokes, browser, idle, input and session rows.
- [ ] Idempotency: the same batch twice produces one set of rows and identical totals.
- [ ] Partial acceptance: only echoed `client_uuid`s flip to `synced = 1`.
- [ ] Screenshot multipart upload → metadata row + stored blob.
- [ ] Auth failure mid-sync → refresh → retry.
- [ ] Batch over the 1000-row limit → 400 with a clear message.

### API → DB
- [ ] Migrations apply to an empty database; every `Down` reverses its `Up`.
- [ ] Tenant scoping holds at the query level, not just the handler level.
- [ ] Concurrent sync from two devices for one user.

### Browser → Desktop
- [ ] Extension discovers the port and token via `/whoami`.
- [ ] `/ingest` rejects a bad token (401) and a web origin (403).
- [ ] Batch ingest writes all rows.
- [ ] **Desktop app restarted mid-session: no visits lost** (F4 outbox).

### Desktop → Sync (offline)
- [ ] Generate data with the backend down → rows persist as `synced = 0`.
- [ ] Bring the backend up → the queue drains → rows flip to `synced = 1`.
- [ ] Backoff grows on repeated failure and resets on success.

### Harness
Go integration tests with a real Postgres (testcontainers, or `PGURL` pointing at a
disposable database). Truncate between tests. Never run against a shared database.

---

## 5. API tests

**Every route, every time.** For each endpoint:

| Case | Expected |
|---|---|
| Valid request | 200 / 201 with the documented schema |
| Malformed body / bad params | 400 with the error envelope |
| No token | 401 |
| Valid token, insufficient permission | 403 |
| Valid token, another tenant's resource | **404** (not 403 — do not leak existence) |
| Nonexistent resource | 404 |
| Pagination | stable ordering, working cursor, respected limit |
| Date filters | boundaries inclusive/exclusive as documented; invalid range rejected |
| Oversized range | 400, not a 30-second query |

### Tenant isolation — the standing test
For every read route, a fixture with **two businesses, two owners, two employees**
asserts that owner A receives 404 for every one of owner B's resources. This test
must exist for a route before that route ships.

### Contract testing
Generate an OpenAPI spec (F21) and validate responses against it in CI so schema
drift is caught automatically.

---

## 6. UI tests

Critical flows only — do not chase coverage percentages in the UI.

- [ ] Sign in → dashboard loads.
- [ ] Sign up wizard → business created → employee created.
- [ ] Employee detail: every section renders with data, empty state, and error state.
- [ ] Timeline: scroll, filter, zoom.
- [ ] Screenshot gallery: thumbnails load; lightbox opens.
- [ ] Settings: change a capture policy and see it persist.
- [ ] Role-based navigation: each role sees only what it should.
- [ ] Locale switch: all 7 locales render without layout breakage.

Tooling: Vitest + Testing Library for components; Playwright for the handful of
true E2E flows, run against a seeded backend.

---

## 7. Desktop tests

- [ ] `cargo test` on both platforms in CI (Windows runner needed — see blocker).
- [ ] Tracker decision core: extend the existing 10 tests to cover idle-period
      emission and session events (F5).
- [ ] Storage migrations v1 → v2 → v3 on a populated database.
- [ ] Local retention never deletes unsynced rows.
- [ ] Loopback server: token, origin, batch size, pause behaviour.
- [ ] 8-hour soak with resource sampling (F31).

---

## 8. Manual test procedures

Manual tests must be **written down and repeatable**, not improvised. Each lives in
`docs/manual/` with: preconditions, numbered steps, expected result, and a place to
record the actual result plus OS build number.

### Required manual suites
1. **Windows platform matrix (F2)** — Win 10 / Win 11 × single/multi monitor ×
   {sleep-wake, lock-unlock, network drop, app restart, machine restart,
   user switch}, plus installer, uninstaller and update.
2. **macOS platform matrix (F3)** — each supported version × permission grant,
   revoke and re-grant × {sleep-wake, lock-unlock, app restart, login-item start}.
3. **Browser matrix (F4)** — tab switching, multiple windows, incognito, YouTube,
   GitHub, Google, a SaaS app, browser minimized, browser closed, computer idle,
   rapid tab switching, **and a 30-minute single-tab dwell** (the specific
   regression that produced `"browser_visit": []`).
4. **Privacy verification (F33)** — open a password manager: no screenshot **and**
   no window title. Confirm counts-only keyboard data. Confirm the tray icon is
   always visible.
5. **Live screen (F17)** — the full authorization and indicator matrix.
6. **Restore drill (F35)** — restore from backup to a clean environment.

---

## 9. Regression testing

**Rule: existing working features must keep working.**

- CI runs the full suite on every push — no exceptions, no "just this once".
- Before any refactor that touches shared code (notably F25 replacing `ownedFilter`,
  which touches every read path), the API contract suite must already be green;
  it is the safety net for that change.
- Golden-file tests for report and dashboard payloads catch silent output changes.
- The reconciliation job (F28) is a production regression test: summaries must keep
  matching raw recomputation.
- When a bug is fixed, a test reproducing it is added **in the same commit**.

---

## 10. Performance testing

| Target | Budget |
|---|---|
| Company dashboard, 1000 employees, 30-day range | p95 < 500 ms |
| Employee timeline first page, 30-day range | < 800 ms |
| Employee dashboard interactive | < 1.5 s |
| Segment building, one employee-day | < 50 ms |
| Presence heartbeats | 1000 agents @ 30 s with no per-beat DB write |
| Agent idle CPU | < 1% |
| Agent RSS | < 150 MB |
| Agent network | < 10 MB/day/employee |
| Screenshot storage | measured; ~4.8 GB/day at 1000 employees, 96 shots/day, 50 KB |

Scales to test: **10 / 50 / 100 / 500 / 1000 employees.** Results committed to the
repository, not just observed.

---

## 11. Security testing

Automated in CI:
- `govulncheck` (Go), `cargo audit` (Rust), `pnpm audit` (JS).
- Secret scanning.
- The tenant-isolation suite (§5).
- The threat matrix in [SECURITY_REVIEW.md](SECURITY_REVIEW.md) §6.

---

## 12. CI pipeline (F1 deliverable)

```yaml
# .github/workflows/ci.yml — four parallel jobs
backend:    go build ./... · go vet ./... · go test ./... (with Postgres service)
desktop:    cargo check · cargo test · cargo clippy -- -D warnings
web-admin:  pnpm typecheck · pnpm build · pnpm test
extension:  pnpm test · manifest lint
security:   govulncheck · cargo audit · pnpm audit · secret scan
```

Nightly: integration + E2E against a seeded environment.
Weekly: performance suite at 100 employees (full scales run before each release).

---

## 13. Definition of Done — applies to every feature

A feature is `DONE` only when **all** of these hold:

- [ ] Unit tests written and passing.
- [ ] Integration tests written and passing where a boundary is involved.
- [ ] API tests cover 200/400/401/403/404, validation, tenant isolation,
      pagination and date filters for every new or changed route.
- [ ] UI tests cover the critical flow.
- [ ] Manual verification steps documented **and executed**, with results recorded.
- [ ] Performance measured against the stated budget.
- [ ] Regression suite green.
- [ ] Documentation updated (this file, IMPLEMENTATION_TASKS.md, PRODUCT_ROADMAP.md).
- [ ] Security implications reviewed against SECURITY_REVIEW.md.
- [ ] Status moved to `READY FOR TEST`, verified, then `DONE`.

`READY FOR TEST` means the code is complete and automated tests pass.
`DONE` means a human has also run the manual verification and it passed.
Never skip the intermediate state.
