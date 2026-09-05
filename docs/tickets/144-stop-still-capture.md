# 144 — V02: stop all new still-screenshot capture

**Status:** Implemented (Windows real-device verification pending)
**Area:** backend (config, screenshot/device/owner/health handlers, obs) + desktop
(Rust trackers/settings/policy + React Settings & Screenshots) + web-admin (Settings) + CI
**Slice:** V02 of `docs/ENGOSOFT_MEDIA_BACKLOG_AR.md`
**Decision:** [ADR 0002](../adr/0002-video-first-media-plane.md) · **Baseline:** [V01 audit](../V01_MEDIA_AUDIT_AR.md)

## Goal

Stop the product collecting still screenshots. Screen monitoring is video; V01
measured why. This slice closes every path that *creates* a stored image and
leaves every path that *reads* one alone — deleting the history is a separate,
explicit decision (V12).

## What changed

**One switch, off by default.** `LEGACY_STILL_CAPTURE_ENABLED` (default false,
and false for anything unset, empty or unparseable) is the only thing that can
re-open the pipeline, and only for a migration deploy. It is a deployment
variable: the CI guard fails the build if it is ever committed as enabled.

**Backend — three closed paths.**

- `POST /v1/sync/screenshots` acknowledges and **discards** before touching the
  image part, the business lookup, filestore or Postgres.
- `POST /v1/devices/:device_id/live-capture` returns **410 Gone** with
  `MEDIA_LEGACY_CAPTURE_DISABLED`. Despite its name this endpoint drove the
  *retained* pipeline: the agent answered it by storing a screenshot.
- `GET /v1/policy` now carries `still_capture_enabled` on every branch, so a
  managed device learns the decision on its normal policy fetch.

**Why discard rather than refuse on the upload.** The V02 plan said 403. The
agent's sync worker does not mark a rejected shot as synced and does not stop
retrying it (`sync/worker.rs`), so a 4xx would make every un-upgraded agent
re-upload the same image on every sync pass, forever — leaving the images sitting
in the outbox on the employee's machine, which is the opposite of the goal. The
codebase already made this call for the remote-pause path and documented it
there. The bytes are dropped either way; acknowledging drains the outbox.
`live-capture` keeps a hard refusal because its caller is an owner, not a loop.

**Agent — off by default, not off by configuration.** A new
`TrackerControl.still_capture_enabled` (default false) gates `capture_once`, the
only function that writes a stored screenshot. A device that is fresh, offline,
standalone or has never reached the backend is already off, because the safe
state is the absence of a signal rather than its presence. `apply_org_policy`
applies the flag **outside** the `locked` branch — `allow_employee_override` must
not be able to bring stored screenshots back — and `set_settings` preserves it,
so no settings payload can raise it. A missing field on an older backend reads as
retired.

**UI — no controls that do nothing.** The desktop Settings screenshot section and
the web-admin capture section say plainly that screenshots are no longer captured
and that the settings now only describe retained history. The desktop Screenshots
screen keeps showing images captured before the change but loses its "Capture
now" button. Copy added in all 8 locales.

**Observability.** `obs.RecordLegacyStillCaptureRejected` counts refusals and
`/healthz` reports `legacy_still_capture_rejected` and `still_capture_enabled`
alongside `version` — the existing bibomon probes already read that endpoint.
Each call site has its own rate-limited WARN (one line per minute carrying the
suppressed count), deliberately not shared: an agent flood must not swallow the
rare owner-triggered event. bibomon's log tail already classifies WARN.

**CI.** `.github/scripts/check-no-still-capture.mjs` fails the build on a
committed enabled flag, on image content types outside an allowlist of files V12
deletes, and on `<img>` in the live/session/moments components (forward-looking —
those files do not exist yet). Also replaced `pnpm -r --if-present test` with
explicit per-workspace runs: the recursive form reports success when it matches
nothing, which the V01 audit observed happening.

**Inventory, not deletion.** `scripts/screenshot-inventory.go` is read-only:
totals, per-business breakdown, arrivals per day over the last 14 days, and the
on-disk size. Its "last 24h" line is how you tell whether the rollout has
actually finished. It opens no write transaction.

## Verified

Local end-to-end against a running backend and a real Postgres:

| Check | Result |
|---|---|
| `POST /v1/sync/screenshots` (switch off) | 200, `MEDIA_LEGACY_CAPTURE_DISABLED`, uuid acknowledged |
| `POST /v1/devices/:id/live-capture` (switch off) | 410, `MEDIA_LEGACY_CAPTURE_DISABLED` |
| Files under `STORAGE_DIR` after both | **0** |
| Rows added to `screenshots` | **0** (count unchanged) |
| `/healthz` counter | 0 → 2 |
| `GET /v1/policy` | `still_capture_enabled: false` |
| Rejection logged at WARN | yes, with `suppressed_since_last` |
| Switch **on**: upload | stored to disk as before — escape hatch intact |
| Historical read on a switch-off deployment | 200 `image/webp`, bytes identical, metadata report still lists it |

Suites: Go **108 passed** (was 100) · Rust **83 passed**, 4 ignored (was 78) ·
web-admin **192** · extension **63**. `go vet`, `go test -race`, `cargo clippy -D
warnings`, `tsc --noEmit` (all workspaces), `vite build`, all three CI guards,
`git diff --check` — clean.

## Not done

- **No Windows real-device run.** The agent gate is compiled, unit-tested and
  clippy-clean, and the backend half is verified end-to-end, but no Windows
  machine has run it. Acceptance criterion 2 ("zero new rows over 24h of
  staging") is **not** signed off.
- **Production inventory not taken.** The script exists and works; it has been
  run only against a local test database. Acceptance criterion 4 needs a run
  against production before V12 can start.
- Historical screenshots, the `screenshots` table, the filestore blobs and the
  retention jobs are all untouched, by design.
