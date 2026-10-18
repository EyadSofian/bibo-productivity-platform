# 148 — Production-readiness hardening: boot-time secret check, HTTP timeouts, dependency audit

**Status:** Implemented, with one item blocked upstream (zip / `tauri-plugin-updater`).
**Branch:** `fix/live-after-sleep-1.5.18`

## Why

The 2026-10-18 full-check pass was green everywhere — Go with `-race` against a real
Postgres, 243 web-admin tests, 63 extension tests, 49 + 100 Rust tests, 35/35 live
end-to-end checks — and still shipped four production-only gaps. All four were invisible
because the `security` job in `.github/workflows/ci.yml` is `continue-on-error: true`, so
CI stayed green while the dependency audit failed inside it.

That is the root cause worth naming: the audit job has been advisory since it was added,
which means it has never once blocked a merge, which means its findings accumulated
unread. Everything below was already being reported by a job that nobody had to look at.

## 1. JWT secret was only checked for emptiness

`config.Load()` added `JWT_SECRET` to `missing` when it was `""` and accepted anything
else — including `dev-only-change-me` from `.env.example` and
`prod-change-me-to-a-long-random-secret` from `.env.prod.example`. Both are committed to
this repository, so both are public. A deploy that forgot to set the variable would boot
normally, verify every token, and look healthy right up until someone forged an owner
token with a secret they read off GitHub.

**Fix:** `weakJWTSecret(env, secret)` in `internal/config/config.go`, called from `Load()`
right after the `missing` check and following the same shape. Outside `APP_ENV=local` it
rejects a secret that is under 32 bytes or that matches a committed placeholder. Both
checks run against the whitespace-trimmed value, so padding and a copy-paste trailing
newline do not get around them; the stored secret stays untrimmed, because changing the
signing key here would silently invalidate every token already issued. The error names the
problem without reprinting the secret, since it lands in boot logs and Sentry.

`APP_ENV=local` stays exempt — a forgery against a developer's own machine grants nothing,
and the committed `.env.example` has to keep working. An **unrecognised** `APP_ENV` is
treated as deployed, not as local, so a typo in the deploy variable cannot reopen the hole.

Note the production placeholder is 38 bytes, so the length floor alone would have accepted
it. That length is exactly what let it survive. The placeholder list is what catches it.

Tests: `TestLoadRejectsWeakJWTSecretOutsideLocal` (12 cases),
`TestLoadReportsEmptyJWTSecretAsMissing` (pins the check ordering),
`TestWeakJWTSecretReasons`.

## 2. The HTTP server had no timeouts at all

`cmd/server/main.go` built `&http.Server{Addr, Handler}`. With `ReadHeaderTimeout`,
`ReadTimeout` and `IdleTimeout` all unset, one client could hold a connection open
indefinitely without ever completing a request, and a handful of them exhaust the listener
without the traffic ever looking like load. The comment on that struct already said to use
`ReadHeaderTimeout`; nothing did.

**Fix:** `server.NewHTTPServer` in `internal/server/http.go` now owns the values, so one
place defines them and the tests can assert them:

| Setting | Value | Why |
|---|---|---|
| `ReadHeaderTimeout` | 10s | The slowloris window. Headers are a few hundred bytes. |
| `ReadTimeout` | 60s | Largest accepted body is a 256 KB remote-assist frame; a minute covers a slow agent uplink and still cuts off a dribbled body. |
| `IdleTimeout` | 120s | Must be explicit: when it is zero net/http falls back to `ReadTimeout`, and when both are zero idle connections are never reaped. |
| `WriteTimeout` | **unset, deliberately** | See below. |

`WriteTimeout` stays off. It is a deadline on the whole response, not on a single write, so
any value at all would cut the three long-lived `text/event-stream` routes mid-session:
`/v1/remote-assist/:session_id/frames/stream`, `/v1/devices/:device_id/live/stream` and
`/v1/agent/commands/stream`. The last one is how an agent learns it should go live, so a
`WriteTimeout` here would surface as "Live Now never starts" — a long way from the line
that caused it. `TestWriteTimeoutStaysUnset` guards it.

### Why `ReadTimeout` is safe here, and how that was established

`ReadTimeout` is a read deadline on the connection, and Go cancels the request context when
a read against an expired deadline fails — and `streamFrames` returns on `ctx.Done()`. So
the real risk was never the file uploads named in the original brief; it was the SSE
routes. This was measured rather than assumed: a probe serving an SSE response under a
500ms `ReadTimeout` kept streaming for the full 3s run. Go only cancels on a *background*
read, which it never starts for the bodyless `GET`s these three routes are.

That is a property of net/http, not of this code, so it is pinned by
`TestReadTimeoutDoesNotCutStreamingResponses`: if a Go upgrade ever changes it, the three
stream routes break and that test fails first.

## 3. Go dependencies — closed, including a stdlib finding

`govulncheck` reported **11 vulnerabilities**: one in `golang.org/x/text`, five in
`golang.org/x/net`, and ten standard-library findings (overlapping — several CVEs hit both
`x/net`'s `http2` and the vendored stdlib copy).

- `golang.org/x/net` 0.55.0 → **0.61.0**
- `golang.org/x/text` 0.39.0 → **0.43.0**
- `golang.org/x/crypto` 0.51.0 → 0.58.0, `x/sync` 0.21.0 → 0.24.0, `x/sys` 0.45.0 → 0.49.0
  (pulled forward transitively by `x/net` 0.61.0)

That cleared the module findings and left ten stdlib ones. **These needed a toolchain
bump, not a module bump** — the `go 1.26` directive was the other half of the problem:

| Toolchain | `govulncheck` result |
|---|---|
| go1.27.0 (the local default) | 10 vulnerabilities |
| **go1.26.9** | **0 vulnerabilities** |
| go1.27.2 | 0 vulnerabilities |

So both release lines carry the backport — 1.26.9 and 1.27.2 — and the choice between them
turns on a detail of how the `go` directive works.

**The directive is a floor, not a pin.** `go 1.26.9` is satisfied by *any* toolchain at or
above it, which includes go1.27.0 and go1.27.1 — both unpatched. A developer on 1.27.0
would clear a 1.26.9 floor and still build a vulnerable binary, and nothing in go.mod could
stop them. Pinning to the newest patched release instead makes the floor enforce itself:
every toolchain that can build the module is then 1.27.2 or later, and all of those are
clean. A developer on 1.27.0 is *made* to fetch 1.27.2 by `GOTOOLCHAIN=auto`.

- `apps/backend/go.mod`: `go 1.26` → **`go 1.27.2`**. CI resolves its Go version from this
  file (`go-version-file: apps/backend/go.mod`), so this is also what makes CI's
  `govulncheck` meaningful instead of green-by-accident.
- `apps/backend/Dockerfile` and the root `Dockerfile`: `golang:1.26-alpine` →
  **`golang:1.27.2-alpine`**. The floating minor tag resolves to whatever was current when
  the image was pulled; production should not depend on that.

The cost is that the language version moves from 1.26 to 1.27. Go's compatibility promise
means existing code keeps compiling, which `go build ./...`, `go vet ./...` and the full
`-race` suite confirm. `apps/monitor` is a separate module and still declares `go 1.26.2`;
it was out of scope here and is built non-blocking in CI.

**Verified self-enforcing, which is the whole point of choosing 1.27.2 over 1.26.9:** with
the local default toolchain still go1.27.0 and *no* `GOTOOLCHAIN` override, `govulncheck
./...` now reports **0 vulnerabilities** and exits 0 — Go selected 1.27.2 because the
directive demanded it. Under the previous `go 1.26.9` the same command on the same machine
reported 10 stdlib findings and exited 3.

## 4. Rust dependencies — 10 advisories down to 3, all `zip`

`cargo audit` in `apps/desktop/src-tauri` reported 10 vulnerabilities. `cargo update` on
the indirect dependencies closed seven, with no Tauri bump:

- `quinn-proto` 0.11.17 → **0.11.19** — closes RUSTSEC-2026-0343 (7.5), -0340 (7.5), -0338
- `quinn` 0.11.11 → 0.11.12
- `rustls` 0.23.45 → **0.23.46** — closes RUSTSEC-2026-0346, -0347, -0348, -0349

### Blocked upstream: `zip` 4.6.1 (3 advisories, one critical)

| Advisory | Severity | Title |
|---|---|---|
| RUSTSEC-2026-0369 | **9.1 critical** | `extract()` applies Unix permissions through symlinks without confining the target |
| RUSTSEC-2026-0367 | 7.3 high | SUID/SGID bits preserved during extraction |
| RUSTSEC-2026-0368 | — | `extract()` creates symlinks whose targets are outside the destination |

All three are fixed in `zip >= 9.0.0`. **This cannot be reached by `cargo update`**, and
that was verified rather than assumed:

```
$ cargo update -p zip --precise 9.0.0
error: failed to select a version for the requirement `zip = "^4"`
candidate versions found which didn't match: 9.0.0
required by package `tauri-plugin-updater v2.10.1`
```

`tauri-plugin-updater` 2.10.1 requires `zip = "^4"`, and 2.10.1 is the newest 2.x release —
a full `cargo update --dry-run` does not move it. So no published `tauri-plugin-updater`
has migrated to `zip` 9 yet. Forcing it would mean patching or vendoring the plugin, which
is not worth doing for the exposure below. **Recorded here instead of forced.**

Actual exposure is narrow, on three counts:

1. **Windows-only.** The dependency is declared under
   `[target.'cfg(target_os = "windows")'.dependencies.zip]`, and `extract_zip` is
   `#[cfg(target_os = "windows")]`. The macOS build never links it — `cargo tree -i zip`
   on the host target returns nothing.
2. **Unix semantics on a Windows-only path.** -0367 (SUID/SGID) and -0369 (Unix
   permissions) describe permission bits that do not apply to the Windows target that is
   the only one reaching this code.
3. **Signature-gated input.** In `tauri-plugin-updater`, `download()` calls
   `verify_signature(&buffer, &self.signature, &self.config.pubkey)` *before* `install()`
   reaches `ZipArchive::extract`. The bytes being extracted are minisign-verified against
   the pubkey embedded in the app. Reaching the vulnerable code requires an archive that
   passes that check — i.e. a compromised signing key, at which point an attacker can ship
   arbitrary code through the updater regardless of `zip`.

**Action:** watch for a `tauri-plugin-updater` release on `zip >= 9`, then `cargo update
-p tauri-plugin-updater`. Until then this is three known-open advisories on the Windows
updater path, gated behind update signing. If the audit job is made blocking (below), add
exactly these three IDs to a `.cargo/audit.toml` ignore list with a link to this ticket, so
the gate stays meaningful rather than being switched off.

Also present, unchanged, and not vulnerabilities: 9 `unmaintained` warnings
(`proc-macro-error`, five `unic-*`, `zbus_names`, `zvariant`, `zvariant_derive`) and 1
`unsound` (`glib` 0.18.5, RUSTSEC-2024-0429). `cargo audit` already treats these as
allowed warnings.

## Verification

Run from the Terminal panel — the Bash sandbox blocks Postgres and localhost TCP, so both
the DB-backed Go tests and the SSE timeout test have to run outside it.

```
cd apps/backend && go vet ./...                                    # exit 0
cd apps/backend && TEST_DATABASE_URL="postgres://ctracking:ctracking@127.0.0.1:5432/ctracking_test?sslmode=disable" go test -race ./...
cd apps/desktop/src-tauri && cargo check --all-targets && cargo test
```

- **Go:** `go vet` clean; `go test -race ./...` all 12 packages `ok`. `internal/server`
  gains a test binary where it previously had no test files.
- **Rust:** `cargo check --all-targets` clean (pre-existing dead-code warnings only);
  `cargo test` 100 passed, 0 failed, 4 ignored.
- **`govulncheck`** under go1.26.9: 0 vulnerabilities (was 11).
- **`cargo audit`**: 3 vulnerabilities (was 10), all `zip`, all blocked upstream.

## 5. The audit job is now blocking

Applied, on the owner's approval.

The `security` job in `.github/workflows/ci.yml` was `continue-on-error: true`, described
in its own comment as "Advisory only until F32 triages the findings and makes them
blocking". That advisory status is why all four gaps above sat unseen behind a green CI
badge. With the Go side at zero and the Rust side down to three documented,
upstream-blocked advisories, the triage that comment was waiting for is done — so
`continue-on-error` is gone and these cannot silently come back.

Three changes were needed together, because removing the flag on its own would have turned
CI red on the first push:

1. **`continue-on-error: true` removed** from the `security` job; renamed from "Dependency
   audit (advisory)" to "Dependency audit".
2. **`apps/desktop/src-tauri/.cargo/audit.toml`** added, ignoring exactly
   RUSTSEC-2026-0367, -0368 and -0369, with the reasoning above and the one command that
   retires the waiver. `cargo audit` reads this because CI runs the step with
   `working-directory: apps/desktop/src-tauri`.
3. **`source-map-js` 1.2.1 → 1.2.2** in `pnpm-lock.yaml`. The third step of the job,
   `pnpm audit --audit-level high`, was *already failing* — GHSA-68fv-2mgg-jv7q, a high
   event-loop DoS, via `apps/design > vite > postcss > source-map-js`. It had been
   invisible for exactly the same reason as everything else in this ticket. 1.2.2 is
   semver-compatible with the `^1.0.2` that `postcss` asks for, so
   `pnpm update source-map-js --recursive` closed it in a 4-line lockfile change with no
   package.json edit and no override.

That third one is worth dwelling on: it is a fourth live finding that the advisory job had
been reporting into the void, found only by actually running the step rather than trusting
that a green badge meant a passing job.

### Gate verified step by step, with real exit codes

| Step | Exit | Result |
|---|---|---|
| `govulncheck ./...` | 0 | No vulnerabilities found |
| `cargo audit` | 0 | 3 ignored (the zip waiver), 10 allowed warnings |
| `pnpm audit --audit-level high` | 0 | No known vulnerabilities found |

Checked because the lockfile moved: web-admin tests (24 files, 243 passed) and the
`@ctracking/design` build — both clean.

One advisory remains, reported but not failing: **GO-2026-5932** in
`golang.org/x/crypto@v0.58.0`, **fixed in: N/A** — no patched release exists yet. It shows
up only in govulncheck's *Module Results*; Symbol and Package Results are both empty, so
nothing in this codebase calls it, and govulncheck exits 0. Nothing to do now, but note the
shape of the risk: if a future change makes it reachable at symbol level, the gate goes red
with no upgrade available. Watch for an `x/crypto` release that fixes it.

The first row needs no toolchain caveat, which is the payoff of pinning the floor to
`go 1.27.2` in §3 rather than `go 1.26.9`. This machine's installed Go is still go1.27.0
(`GOTOOLCHAIN=local go version`), and the command above was run with no `GOTOOLCHAIN`
override: Go fetched 1.27.2 on its own because the directive demanded it. Under a 1.26.9
floor the identical command on the identical machine reported 10 stdlib findings and exited
3, because 1.27.0 satisfies that floor while being unpatched. The gate is now green for the
same reason in CI and on a developer's laptop.

**Known consequence, accepted:** `govulncheck` and `pnpm audit` fail on a *newly published*
advisory against an unchanged dependency, so CI can now go red with nobody having pushed a
commit. That is the gate working. The cost is that the ignore list needs an owner who
revisits it — the zip waiver has a removal command attached precisely so it does not become
permanent by default.
