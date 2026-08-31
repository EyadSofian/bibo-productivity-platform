# ADR 0001 — Live screen frames leave Postgres and are pushed, not polled

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** P03 (object storage & media lifecycle) exit gate, co-designed with P0-1
- **Supersedes:** the `remote_assist_frames.image` storage path from `00018_remote_assist.sql`

## Context

`FULL_SYSTEM_AUDIT.md` recorded two findings that its own remediation plan said
must be designed together, not separately:

- **P1-1** — live frames were written to `remote_assist_frames.image bytea`.
  Measured: 12–36 MB of dead TOAST and ~65 KiB of WAL per frame, for data that is
  overwritten within a second and never read again.
- **P0-1** — the live view was not live: first frame took up to 19s and the
  steady rate was one frame per 20s (0.05 FPS), because three polls were chained
  (agent heartbeat 15s → dashboard request 20s → dashboard discovery poll 3s).

Live frames are ephemeral by design: only the newest frame of a session is ever
served, and sessions last minutes. `ARCHITECTURE_TARGET`/§4.3 of the platform
prompt already states that the latest live frame must not be held in Postgres
and must not pass through WAL.

## Decision

**1. Frame bytes move to an in-process ephemeral store (`internal/live`).**

`live.Hub` keeps the newest frame per session behind a 30s TTL, capped at 64
sessions (≤16 MiB worst case at the 256 KiB frame limit). Postgres keeps the
session row, its lifecycle, and the audit trail — everything except the bytes.

Authorization deliberately stays in Postgres. `AuthorizeRemoteAssistFrame` and
`AuthorizeRemoteAssistViewer` are SELECT-only statements run on every frame; the
hub is a cache and a bus, never a permission boundary. Durable "frames are
flowing" bookkeeping (`last_frame_at`) is throttled to at most one write per 10s
via `Hub.ShouldPersist`, so it does not ride along with every frame.

**2. Frames are pushed to the dashboard over SSE, not polled.**

`GET /v1/remote-assist/:session_id/frames/stream` streams `frame`, `ping` and
`end` events. The dashboard renders a frame when it arrives instead of finding
it up to 3s later.

## Why SSE rather than WebSocket or WebRTC

- **WebRTC** is the P08 target and remains so. It needs signalling, STUN/TURN
  infrastructure, and a Rust media pipeline — none of which can be verified
  without a Windows device. It is not a prerequisite for getting frames out of
  Postgres, and blocking on it would leave the measured 36 MB/200-frame churn in
  production indefinitely.
- **WebSocket** would need a new direct dependency (`gorilla/websocket`) and its
  own ADR, and buys nothing here: the frame path is strictly server→client, and
  input actions already POST over the existing API.
- **SSE** needs no new dependency, survives the Cloudflare Tunnel in front of
  production, and reconnects natively. The event contract is transport-agnostic,
  so replacing it with WebSocket or a WebRTC track later does not change the
  client's rendering path.

The browser's built-in `EventSource` cannot send an `Authorization` header, and
putting an access token in the query string would leak it into proxy logs and
browser history. The client therefore reads the stream with `fetch()` +
`ReadableStream` and decodes SSE itself (`src/api/sse.ts`).

## Consequences

**Measured** (200 frames of 178 KiB incompressible WebP, PostgreSQL 16.9,
local; `scripts/measure-live-frame-cost.go`):

| | frame table growth | WAL | WAL/frame |
|---|---|---|---|
| Before — bytea | 36.4 MiB | 38.3 MiB | 196.0 KiB |
| After — in-memory | **0 B** | **2.1 KiB** | **10 B** |

The frame table growth reproduces the audit's independently measured 36 MB.

**Accepted limitation — single backend instance.** The hub is per-process. If a
frame is uploaded to instance A and a viewer is attached to instance B, the
viewer sees nothing. This is correct for the current Railway deployment, which
runs one instance.

This is deliberately *not* solved with a database fallback, which would restore
exactly the churn this removes. The seam for solving it is the `live.Store`
interface: a Redis implementation (`SET session:<id> EX 30` plus pub/sub for
fan-out) satisfies it without touching the handler or the client. **Before the
backend is scaled past one instance, that implementation is required** — see
"Follow-ups".

**Rollback.** `remote_assist_frames` is intentionally left in place and empty
rather than dropped in the same release that stopped writing to it (forward-safe
migration rule). Rolling back to the previous binary reads an empty table and
returns 204 until the agent uploads again, ~900ms later. The table can be
dropped in a later release.

**Frames are lost on restart.** A backend restart drops in-flight frames; the
agent's next upload repopulates within ~900ms and the client reconnects on its
own. This is strictly better than the previous behaviour, where a restart mid-
session left a stale frame in the table.

## Part 2 — the agent side (2026-08-31, same day)

Follow-ups 1 and 2 below are now done. The agent no longer waits for a heartbeat,
and live view no longer runs at one frame per 20 seconds.

**Command bus.** `live.CommandBus` fans device-addressed commands to agents over
`GET /v1/agent/commands/stream`. Commands are hints with a polling path behind
each one, so an agent that cannot hold the stream open behaves exactly as before,
only slower. Nothing on this channel authorizes anything.

**Live view is now its own ephemeral path.** An owner opening
`GET /v1/devices/:device_id/live/stream` is what makes the agent capture; the
agent pushes frames to `POST /v1/agent/live/frame`, which puts them in the hub.
They are never persisted.

This is deliberately *not* the retained-screenshot pipeline. Screenshots are
monitoring evidence written to filestore on the policy's own schedule; raising
*that* to 1 FPS would store 3600 images per hour of viewing. Keeping live frames
ephemeral is what makes the frame rate affordable at all.

**The keep-capturing signal is a renewal, not a start/stop pair.** The backend
re-sends `live_view_active` every 5s while a viewer is attached, carrying a 16s
TTL that the agent clamps to 60s. The agent captures only while that deadline is
in the future. A dropped message, a dead connection, or a backend restart makes
the signal stop arriving and capture stops on its own. **A lost message can only
ever stop capture early — never leave it running after the viewer has gone.**
There are three independent backstops: the agent's TTL, the backend answering
`409` on upload when no viewer is subscribed, and the agent clearing its
authorization whenever the command stream drops.

**Policy is re-checked per frame,** not once per session: schedule, employee
pause, the owner's per-device monitoring switch, and screen-recording permission
are all evaluated on every capture, so a schedule that closes mid-session stops
capture.

### Measured (loopback, `scripts/e2e/`)

| Hop | Before | After |
|---|---|---|
| Owner asks for a frame → agent knows | 0–15 000 ms | **13 ms** |
| Owner opens live view → agent told to capture | did not exist | **7 ms** |
| Agent uploads frame → viewer renders it | 0–3 000 ms | **7 ms** |
| Live-view frame rate | 0.05 FPS (1 per 20s) | ~1.1 FPS |

Loopback excludes WAN latency and the 60–457 ms capture itself (audit §3.2);
these bound the coordination cost, which is what P0-1 measured.

### Still open

- **Real-device verification.** The agent half is compiled, unit-tested and
  clippy-clean, and the protocol is verified end-to-end against a live backend —
  but it has not run on a Windows machine. First-frame time on real hardware and
  a real network is unmeasured, so P0-1's `<3s` acceptance is **not** signed off.
- **Agent CPU at ~1.1 FPS** is unmeasured on reference hardware (SLO: <12%
  during live). The encode ladder was measured at 118 ms/frame worst case after
  P0-3, which suggests headroom, but suggestion is not measurement.
- **No visible on-screen indicator during live view.** Remote assistance shows an
  always-on-top Stop control; live view, like scheduled screenshots, relies on
  the disclosed monitoring policy. Continuous ~1 FPS viewing is arguably a
  different thing from a screenshot every few minutes, and whether it warrants
  its own indicator is a product/legal decision, not one to make silently in
  code. Flagged, not changed.

## Follow-ups (not done here)

1. **Redis-backed `live.Store` and `CommandBus`** before running more than one
   backend instance. Both are per-process; with two instances an agent connected
   to A cannot be reached by a viewer on B.
2. **Drop `remote_assist_frames`** once this release is proven in production.
3. **Multi-monitor and DPI** (audit P1-3/P1-4) are untouched and still need a
   real Windows device.
