# 145 — V03: media control plane contracts, schema, RBAC and audit

**Status:** Implemented (no SFU wired up — that is V05)
**Area:** backend (media package, store, handlers, middleware, config, migration 00020)
**Slice:** V03 of `docs/ENGOSOFT_MEDIA_BACKLOG_AR.md`
**Decision:** [ADR 0002](../adr/0002-video-first-media-plane.md)

## Goal

Build the control plane the video media plane needs, without picking a vendor.
After this slice the API can authorize a live session, mint scoped short-lived
tokens, drive a session through an explicit lifecycle, and record who did what —
all exercised end to end in CI against a fake provider and a real Postgres.

## What changed

**`internal/media` — the contracts.** `MediaProvider` and `RecordingStore` are
interfaces; handlers depend on them and never on a vendor SDK. Alongside them:
the session state machine, the seven media permissions, an `Unconfigured`
provider, and `internal/media/mediafake` for tests.

**Migration 00020.** `media_sessions`, `media_tracks`, `viewer_sessions`,
`media_audit_events` — metadata only, no bytes. Constraints do the work that
would otherwise be application etiquette: a terminal session must have an
`ended_at`, a `failure_code` may only exist on a failed session, and a partial
unique index allows one open session per device per kind. `recording_assets` and
`recording_gaps` are deliberately absent; they arrive with V08 rather than
sitting empty.

**State machine.** The full lifecycle from the master prompt —
`requested → authorizing → waiting_for_agent → negotiating → live ⇄ reconnecting
→ ending → ended`, plus `failed` with one of eight codes. Persisting the finer
states is a deliberate superset of the spec's illustrative column: collapsing
them makes every stalled session look identical, and "the live view didn't work"
is exactly the report that has to be answerable.

**RBAC.** Seven permissions (`live_view.start`, `live_view.watch`,
`recordings.view`, `recordings.delete`, `remote_control.start`,
`media_settings.manage`, `media_audit.view`), resolved from the membership role
and enforced per call site. **Limitation, stated rather than hidden:**
`memberships.role` is still `CHECK (role IN ('owner','employee'))`, so an
organization cannot yet grant "watch live but never take control". What this buys
today is that every call site already asks for the specific permission it needs,
so a real role model changes one function instead of every handler. Owner gets
all; employee gets none; an unknown role gets none, so adding a role without
updating the map denies rather than grants.

**Typed errors + request id.** Media endpoints return
`{"error":{"code","message","request_id","retryable"}}`. `retryable` is the field
that earns its place: without it a client cannot tell "the device is offline, try
in a moment" from "you are not allowed to do this". `middleware.RequestID()` puts
the same id on the response header, the error body, every log line, and every
audit row. An inbound `X-Request-Id` is honoured only after being length-capped
and alphabet-restricted — it is attacker-controlled text that reaches logs.
The older endpoints keep their `{"error":"message"}` shape; rewriting them is a
breaking change for no benefit to this slice.

**Endpoints.** `POST /v1/devices/:device_id/media/live`,
`GET /v1/media/sessions/:session_id`, `POST …/viewer-token`,
`POST …/publisher-token` (agent only), `POST …/stop`.

## Design decisions worth naming

- **Room names are opaque UUIDs** with no relationship to the employee, device or
  business, and `provider_room_id` is `json:"-"` so it never reaches a client.
- **Two viewers share one session.** A second request joins rather than creating
  a second session; the partial unique index makes that safe under a race, and
  the loser reads the winner's row instead of failing.
- **Stop is per-viewer.** One person closing a tab must not cut off everyone
  else, so the session only ends when the last viewer leaves. Stopping twice
  succeeds.
- **Permissions are re-checked at token mint,** not trusted from session
  creation: a session can outlive the grant that started it.
- **An audit write failure never fails the request.** Turning an observability
  outage into a monitoring outage would be worse; the failure is logged loudly so
  the gap is visible.

## Bug found by end-to-end verification

Starting a live session against a device that had enrolled but **never sent a
heartbeat** returned `MEDIA_INTERNAL_ERROR` (500). `presence_seen_at` is NULL on
such a device, and `NULL > interval` is NULL, not false, so the scan into a bool
failed. This is the first live request anyone makes against a new device — the
most likely first contact with the feature. Fixed with `COALESCE(..., false)`;
regression test added. It returns `MEDIA_AGENT_OFFLINE` / 409 / retryable now.

Unit tests did not catch it because they aged an existing device's presence
rather than using one that had never reported.

## Verified

**Acceptance criteria, all covered by tests:**

| Criterion | Test |
|---|---|
| Tenant A cannot see tenant B's session on any endpoint | `TestMediaSessionsAreInvisibleToOtherTenants` (404, indistinguishable from a nonexistent id) |
| Viewer token grants no publish | `TestViewerTokenIsSubscribeOnly`, `TestSubscriberTokenNeverGrantsPublish` |
| Token TTL is bounded and configured | `TestMintedTokensExpireWithinTheConfiguredTTL`, `TestMediaTokenTTLIsClamped` |
| An agent cannot mint for another device | `TestAgentCannotMintAPublisherTokenForAnotherDevice` (a same-tenant peer, and the owner, are both refused) |
| start/join/token/stop are all audited | `TestSessionLifecycleIsFullyAudited` |
| No tokens, room names or credentials in logs | `TestNoTokensOrRoomNamesReachTheLogs`, `TestAuditMetadataCarriesNoSecrets` |

The log test writes a marker first and fails if the marker is missing, so "no
secrets found" cannot pass by virtue of an empty log. Both it and the video-first
CI guard were negative-tested: a deliberately leaking `obs.Info` line makes the
test fail, and removing it makes it pass.

**Migration:** forward and backward verified — `TestMigration20RollsBackAndReapplies`
applies the Down section and re-migrates through the real migrator. All eight
indexes confirmed present on a live database.

**Live server:** typed envelope with matching header/body request ids;
`MEDIA_PROVIDER_UNCONFIGURED` / 503 for a start with no SFU;
`MEDIA_AGENT_OFFLINE` / 409 / retryable for an offline device, with an audit row
naming the reason and **zero** `media_sessions` rows for the refusal.

**Suites:** Go **155 passed** (was 108) · `go vet` · `go test -race` · web-admin
192 · extension 63 · all three CI guards · `git diff --check` — clean.

## Not done

- **No SFU.** `MEDIA_PROVIDER` is empty, so the unconfigured provider fails every
  media operation with a typed error. Nothing in this slice moves a video frame,
  and no live session can reach `live`. That is V05.
- **No Windows agent side.** The publisher-token endpoint is tested with a
  simulated agent principal, not a real one.
- **Role granularity.** See the RBAC limitation above.
- `recording_assets` / `recording_gaps` / `remote_control_sessions` — V07/V08.
