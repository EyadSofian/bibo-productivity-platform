# SECURITY_REVIEW.md

Initial security review of the baseline, performed by reading source at commit
`a1a49da`. This is a **code review, not a penetration test** — no running instance
was available (see [BASELINE_TEST_REPORT.md](../BASELINE_TEST_REPORT.md)). Findings
marked *(verified in code)* were confirmed by reading the implementation; findings
marked *(needs runtime verification)* require a live instance to confirm.

---

## 1. What this system is, from a security standpoint

An employee monitoring platform holds some of the most sensitive data an employer
can collect: what people work on, when they are and are not at their desk, the
titles of their windows, the sites they visit, and periodic images of their screens.

Two consequences shape everything below:

1. **Tenant isolation is the product's core security property.** A cross-tenant leak
   is not a bug; it is an incident with legal consequences.
2. **The privacy limits are a security control, not marketing.** "Counts, not
   keystrokes" must remain provably true, because the alternative — a keylogger —
   is what this software would otherwise be.

---

## 2. Threat model

| # | Threat | Baseline status |
|---|---|---|
| T1 | Employee A reads Employee B's data | **Mitigated** — no employee-facing read API exists at all; all reads are owner-scoped |
| T2 | Manager/owner of company A reads company B's data | **Mitigated** *(verified in code)* — every read path filters on `businesses.owner_user_id = caller` |
| T3 | Screenshot URL guessing / enumeration | **Mitigated** — keyed by random `client_uuid` and authorization-checked; returns 404 rather than 403 to avoid leaking existence |
| T4 | JWT theft | **Partially mitigated** — 15 min access TTL, but see S-1 (refresh tokens) |
| T5 | API key theft | **N/A** — API keys do not exist yet (F21) |
| T6 | SQL injection | **Mitigated** *(verified in code)* — all queries use pgx parameters; the only interpolated fragment is the constant `ownedFilter`, which contains no user input |
| T7 | XSS in the dashboard | **Needs verification** — window titles and page titles are attacker-influenceable strings rendered in the SPA; React escapes by default, but see S-8 |
| T8 | CSRF | **Low risk** — bearer tokens in headers, not cookies; CORS restricted to one origin |
| T9 | Path traversal on screenshot storage | **Mitigated** *(verified in code)* — every path component is a validated UUID or a derived date; `Open` re-checks the root prefix |
| T10 | Malicious file upload | **Partially mitigated** — 200 KB cap and `DetectContentType` prefix check, but see S-6 |
| T11 | Broken object-level authorization (IDOR) | **Mitigated on existing routes** — no IDOR found in the 24 current routes |
| T12 | Tenant isolation failure as roles expand | **Future risk** — F25 replaces `ownedFilter` across every read path; highest regression risk in the roadmap |
| T13 | WebSocket / SSE authorization | **N/A** — not yet implemented (F16) |
| T14 | Live screen authorization bypass | **N/A** — not yet implemented (F17); highest future risk |
| T15 | Local privilege: another process on the employee's machine reads monitoring data or the ingest token | **Open** — see S-4, S-5 |
| T16 | Credential/keystroke capture (the software becoming a keylogger) | **Mitigated** *(verified in code)* — see §3 |
| T17 | SSRF via webhooks | **N/A** — not yet implemented (F22); designed for in the task list |
| T18 | Denial of service via unauthenticated endpoints | **Partially mitigated** — see S-7 |

---

## 3. The privacy guarantee — verified

This is the most important thing to get right, so it was checked line by line.

**macOS** (`platform/macos.rs`, `mod keytap`):
- `CGEventTapCreate` is called with `kCGEventTapOptionListenOnly` (value `1`).
- The event mask is `1 << kCGEventKeyDown` only.
- The callback increments an atomic and returns the event untouched. **The keycode
  is never read** — no `CGEventGetIntegerValueField`, no keyboard layout lookup.
- The code comment explains this is deliberate: decoding keys is what crashed an
  earlier `rdev` approach *and* is exactly the privacy guarantee.

**Windows** (`platform/windows.rs`, `keyboard_hook_proc`):
- `WH_KEYBOARD_LL` hook; increments only on `WM_KEYDOWN` / `WM_SYSKEYDOWN`.
- **`lparam` is never dereferenced** — the `KBDLLHOOKSTRUCT` containing the virtual
  key code is passed straight to `CallNextHookEx` without being read.

**Data actually collected**, confirmed across all four capture paths: app name,
window title, PID, active/idle duration, key counts per 60 s bucket, screenshot
images, and browser URL + page title + duration. **No cookies, no form fields, no
page content, no clipboard, no credentials, no `webRequest` interception.**

**Conclusion: the count-only guarantee is real.** It must be protected by explicit
tests (F33) so a future refactor cannot silently break it.

---

## 4. Findings

Severity reflects impact in a production deployment of this platform.

### S-1 · HIGH · Refresh tokens cannot be revoked
`internal/auth/jwt.go`, `handlers/auth.go`

Refresh tokens are stateless JWTs with a **30-day TTL**. `Refresh` issues a new pair
but does **not** invalidate the presented token — it remains valid for its full
lifetime. There is no revocation store, no server-side logout, and no session
invalidation. A stolen refresh token grants 30 days of access that cannot be
withdrawn without rotating `JWT_SECRET` and logging out every user on the platform.

*Fix:* F24 — refresh-token families with rotation, reuse detection and a revocation
store; real `logout` and `logout-all`.

### S-2 · HIGH · No role model beyond owner/employee
`db/migrations/00002_auth.sql`, `store/reports.go`

`memberships.role CHECK (role IN ('owner','employee'))`. Every read is owner-only.
There is no manager, admin or viewer, and **no separate permission for viewing
screenshots**. Anyone who can log in as the owner can see every screenshot of every
employee, with no audit trail (S-3). When live screen ships, the same all-or-nothing
model would grant it to everyone with owner access.

*Fix:* F25 — five roles, nine permissions, `view_screenshots` and `view_live_screen`
as separate explicit grants.

### S-3 · HIGH · No audit log
No `audit` package or table exists. Screenshot viewing, settings changes, employee
deletion and role changes leave no record. For a monitoring product this is both a
security gap and, in many jurisdictions, a compliance gap — the people being
monitored have no way to know who looked at their data.

*Fix:* F26.

### S-4 · MEDIUM · Loopback ingest token is readable by any local process
`apps/desktop/src-tauri/src/server/mod.rs`

`GET /whoami` is unauthenticated and returns the shared ingest token to **any**
local caller. The comment correctly notes that a web page cannot read the response
(no CORS headers) and that `/ingest` rejects web origins — both true. But any native
process running as the user, or any other browser extension with loopback host
permission, can fetch the token and then **inject fabricated browser visits** into
the employee's record.

Impact is limited (data fabrication on one's own record, not data exfiltration), but
in a monitoring product, falsifiable data undermines the product's purpose.

*Fix (F4):* prefer a handshake that binds the token to the requesting extension
(e.g. Chrome native messaging, or a token displayed once in the app UI and pasted
into the extension), or at minimum rotate on every app start and rate-limit `/ingest`.

### S-5 · MEDIUM · Desktop session tokens are unprotected on Windows
`apps/desktop/src-tauri/src/sync/auth.rs`

Access and refresh tokens are written as **plaintext JSON**. `chmod 0600` is applied
under `#[cfg(unix)]` only — on Windows the file inherits default ACLs. Combined with
S-1 (30-day non-revocable refresh tokens), a token read from a shared or compromised
Windows profile is a durable credential.

*Fix:* F24 — DPAPI on Windows, Keychain on macOS, or at minimum an explicit ACL.

### S-6 · MEDIUM · Screenshot upload content check is weak
`handlers/screenshot.go`

`http.DetectContentType(data)` must merely return something starting with `image/`.
A polyglot file (valid image header, arbitrary trailing bytes) passes. Files are
served back with a hard-coded `image/webp` content type and are never executed, so
exploitation requires a downstream image-parsing vulnerability — but the check is
weaker than it appears.

*Fix (F14):* validate the WebP container specifically, verify declared dimensions by
decoding, and re-encode server-side.

### S-7 · MEDIUM · Rate limiting is narrow and unbounded
`internal/middleware/ratelimit.go`

- Applied to `/v1/auth/*` **only**. Sync, screenshot upload and every report endpoint
  are unlimited. A single authenticated account can hammer expensive report queries.
- The per-IP bucket map **is never evicted** — memory grows without bound under IP
  churn, which is itself a slow DoS.
- In-memory, so it is per-instance and defeated by horizontal scaling.

*Fix:* F24 — evicting buckets, broader coverage, per-key and per-user limits.

### S-8 · MEDIUM · Untrusted strings reach the dashboard
`window_title` and `page_title` are attacker-influenceable (an employee can name a
window anything; a visited page controls its own title). They are stored verbatim
and rendered in the SPA. React escapes by default, so this is likely safe — but it
has not been verified, there is no CSP on the web-admin, and CSV export (F20) will
expose the same strings to formula injection.

*Fix:* F32 — audit for `dangerouslySetInnerHTML` and URL-injection sinks, add a CSP,
and add CSV formula-injection protection in F20. *(needs runtime verification)*

### S-9 · LOW–MEDIUM · Business names and owner names are public
`GET /v1/public/businesses` (no auth) returns every business with its owner's
display name, to support the employee login picker. This enumerates every customer
of a hosted deployment and the name of a person at each.

*Fix:* replace the open picker with an invitation/workspace-slug flow, or require a
partial identifier before returning matches.

### S-10 · LOW · Desktop webview has no CSP
`tauri.conf.json` sets `"csp": null`. The webview loads only local assets, so the
practical risk is low, but a CSP is free defence-in-depth for a webview that renders
untrusted strings (window titles, page titles).

*Fix:* F32.

### S-11 · LOW · Health check does not check the database
`/healthz` returns OK even when Postgres is unreachable, so a load balancer will
keep routing to a broken instance.

*Fix:* F1 (`/healthz`) and F36 (`/readyz`).

### S-12 · LOW · UTC-only day boundaries
`handlers/reports.go` `Roster` computes "today" with `time.Now().UTC()`. For any team
not on UTC, "today" is wrong at the edges. There is a fix commit for the *dashboard*
default day (`a1a49da`), but the server-side roster window is still UTC.

*Fix:* F5 — employee timezone on the user record; all day boundaries computed in it.

### S-13 · INFO · Screenshot bytes proxied through the API
Every thumbnail is a separate authenticated request streaming full bytes. Correct
for authorization, but it makes the gallery slow and the backend a bandwidth
bottleneck.

*Fix:* F14 — signed short-TTL URLs plus thumbnails.

---

## 5. Controls to build

| Control | Feature | Priority |
|---|---|---|
| Refresh-token rotation, reuse detection, revocation | F24 | P0 |
| Real logout and session invalidation | F24 | P0 |
| RBAC with `view_screenshots` / `view_live_screen` as separate grants | F25 | P1 |
| Append-only audit log | F26 | P1 |
| Tenant guard middleware (structural, not per-handler) | F21/F25 | P0 |
| Signed short-TTL screenshot URLs | F14 | P0 |
| Broadened, bounded rate limiting | F24 | P0 |
| Secure desktop token storage (DPAPI / Keychain) | F24 | P1 |
| Hardened loopback token handoff | F4 | P1 |
| Stronger upload validation + server-side re-encode | F14 | P1 |
| CSP on desktop webview and dashboard | F32 | P1 |
| CSV formula-injection protection | F20 | P1 |
| SSRF defence at DNS-resolution time for webhooks | F22 | P1 |
| Live-screen authorization + mandatory indicator + audit | F17 | P0 for that feature |
| Dependency and secret scanning in CI | F1/F32 | P1 |

---

## 6. Security test matrix

Every row becomes an automated test. This matrix is the Definition of Done for F32.

### Tenant isolation
- [ ] Owner A → every one of owner B's employees, screenshots, reports, timelines → **404**
- [ ] Sync with a `business_id` the caller does not belong to → **403**
- [ ] Screenshot signed URL from business A used against business B → **denied**
- [ ] Summary tables respect `business_id` scoping
- [ ] SSE/presence stream never emits another tenant's events

### Authentication
- [ ] Expired access token → 401
- [ ] Refresh token used as an access token → 401 *(already covered by `TestTokenKindEnforced`)*
- [ ] Token signed with a different secret → 401 *(already covered)*
- [ ] `alg: none` / algorithm confusion → 401
- [ ] Revoked refresh token → 401
- [ ] Refresh reuse → whole family revoked
- [ ] Logout invalidates immediately
- [ ] Password reset token is single-use and expires
- [ ] No user enumeration through message or timing

### Authorization
- [ ] Full matrix: every role × every route × expected status
- [ ] EMPLOYEE can read own data only
- [ ] MANAGER limited to their team
- [ ] Live screen denied without the explicit permission
- [ ] Screenshots denied without the explicit permission
- [ ] Privilege escalation via self-role-change → denied

### Injection
- [ ] SQL injection attempts on every string parameter
- [ ] XSS payloads in `window_title` and `page_title` rendered safely in the dashboard
- [ ] CSV formula injection (`=`, `+`, `-`, `@`) neutralized on export
- [ ] Path traversal in every storage-key-derived input
- [ ] Malicious regex in classification rules (RE2 makes this safe — assert it)

### Upload and storage
- [ ] Oversized upload → 400
- [ ] Non-image upload → 400
- [ ] Polyglot image → rejected after F14 hardening
- [ ] Signed URL expiry enforced
- [ ] Signed URL signature tampering rejected
- [ ] Object storage bucket is not publicly readable

### Rate limiting and DoS
- [ ] Login brute force throttled
- [ ] Report endpoint flooding throttled
- [ ] Oversized date range rejected rather than executed
- [ ] Rate-limit bucket map memory stays bounded under IP churn
- [ ] Sync batch over the row limit → 400

### Webhooks (F22)
- [ ] Private, loopback, link-local and cloud-metadata targets rejected **at
      resolution time**, not only at save time
- [ ] DNS rebinding rejected
- [ ] HMAC signature verifiable by an independent implementation

### Privacy invariants (F33)
- [ ] No keycode is ever read (macOS and Windows)
- [ ] Skip-listed apps produce neither screenshots nor window titles
- [ ] Extension sends only loopback traffic
- [ ] No cookies, form data or page content captured
- [ ] Tray icon always visible — no stealth mode exists

---

## 7. Compliance and ethical notes

Not legal advice, but load-bearing for a product in this category:

- **Employee notice and consent** are legally required in many jurisdictions
  (GDPR Art. 6/13 in the EU; various US state laws). The platform must make
  transparent operation the only mode — which it currently does, and which F33
  reinforces.
- **Purpose limitation:** collect only what productivity monitoring needs. The
  existing "counts, not content" line is exactly the right one; hold it.
- **Data subject access:** employees should be able to see their own data. Today
  they cannot — there is no employee read path at all. F25's `EMPLOYEE` role should
  be treated as a compliance feature, not just a convenience.
- **Retention limits** are a legal expectation, not just a storage optimization (F27).
- **Live screen** is the most intrusive capability in the product. The mandatory
  visible indicator, explicit permission and full audit trail in F17 are not
  optional polish — they are what makes the feature defensible.
- **Efficiency score** must be labelled as an organization-defined operational
  metric in the API payload as well as the UI (F10), so downstream consumers cannot
  present it as an objective measure of a person's worth.
