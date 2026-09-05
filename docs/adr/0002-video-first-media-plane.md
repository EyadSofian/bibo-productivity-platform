# ADR 0002 — Video-first WebRTC media plane; no still screenshots

- **Status:** Accepted
- **Date:** 2026-09-01
- **Slice:** V01 (media audit) exit gate — the decision the V02–V14 backlog executes
- **Supersedes:** the live-view half of [ADR 0001](0001-ephemeral-live-frames.md).
  ADR 0001's *ephemeral, never-in-Postgres* rule stands and is strengthened; its
  *SSE + WebP still frames* transport is replaced.
- **Driver:** `docs/ENGOSOFT_VIDEO_FIRST_MONITORING_MASTER_PROMPT_AR.md`
- **Evidence:** `docs/V01_MEDIA_AUDIT_AR.md`

## Context

The product calls its screen feature "Live View". It is not video. The agent
captures one independent full-screen image every 900 ms, walks a
(resolution × quality) ladder to encode it as WebP, POSTs it to the Go API,
which base64-encodes it into a JSON SSE event that the React admin renders into
an `<img>`. Three separate still-image paths exist today, and a fourth surface
(Playback) replays retained screenshots as a filmstrip.

ADR 0001 already removed the worst of this — frame bytes no longer reach
Postgres, and frames are pushed rather than polled. What it could not fix is the
*representation*: independent, fully-intra-coded images have no temporal
compression, so the cost per delivered frame does not improve with tuning. It
said so itself: "WebRTC is the P08 target and remains so."

Measured on this machine (Apple Silicon, `cargo test --release -- --ignored
capture_cost`, 2560×1440 RGBA source), the live path costs:

| | typical | worst case |
|---|---|---|
| encode time per frame | 66.8 ms | 453.6 ms |
| encoded size | 59 KiB | 178 KiB |
| on the wire after base64 (+33%) | 78.7 KiB | 237.3 KiB |
| sustained bitrate at 1.11 FPS | **0.72 Mbps** | **2.16 Mbps** |
| per hour of one viewer | 322 MB | 972 MB |

The target profile in the master prompt is 1280×720 at 15 FPS and 1.2 Mbps.
Per delivered frame, the current path spends **8.1× (typical) to 24.3× (worst
case)** more bits than the video profile it is meant to be replaced by — while
delivering **1/13.5th** of the frame rate. That gap is structural, not a tuning
problem: it is what "no inter-frame prediction" costs.

Three further consequences are visible in the code rather than inferred:

1. **The API is a media relay.** Every frame transits the Go process and the
   Railway HTTP service. `POST /v1/agent/live/frame` sits behind
   `IngestRateLimit` at 10 rps **per client IP** (`middleware/ratelimit.go`).
   At 1.11 FPS per device, roughly **nine devices behind one office NAT
   saturate the limiter** and start losing frames. Media on the control plane
   does not scale past a small office.
2. **Live view has no audit trail.** `remote_assist_audit` covers remote
   assistance; opening `GET /v1/devices/:device_id/live/stream` and watching an
   employee's screen writes nothing. Authorization is a single owner check
   (`AuthorizeLiveView`), and `memberships.role` only has `owner|employee` — the
   granular permissions the product needs (`live_view.watch`, `recordings.view`,
   `recordings.delete`, `remote_control.start`) do not exist.
3. **Remote control is REST polling.** The agent polls
   `GET /v1/remote-assist/:id/actions` every 180 ms
   (`sync/remote_assist.rs:ACTIVE_POLL`), so input latency is 90 ms average /
   180 ms worst before any network time, against a 1.1 FPS video feed the
   operator is aiming with.

## Decision

**Screen monitoring becomes video. Still images stop being a monitoring
artifact anywhere in the product.**

1. **Live View is WebRTC.** The agent publishes an encoded screen track to an
   SFU; the admin subscribes and renders it in an HTML `<video>` element bound
   to a `MediaStream`. No `<img>`, no canvas blitting loop, no data URLs.
2. **History is recorded video.** When a Monitoring Profile enables it, a
   recorder/egress subscribes to the same track and writes fMP4/HLS segments to
   S3-compatible object storage. Postgres holds metadata, never bytes.
3. **No still monitoring images are produced, uploaded, stored, or displayed.**
   This bans image files, image HTTP payloads, and image database records on
   monitoring paths. It does not ban the frames inside a video codec, and it does
   not touch static UI assets (logo, icons).
4. **No fake video.** A sequence of JPEG/PNG/WebP images rendered into a
   `<video>` or a canvas and called a stream is prohibited.
5. **The Go API never carries media bytes.** It authenticates, authorizes,
   orchestrates sessions, mints short-lived scoped tokens, records metadata and
   audit, and runs retention. It does not relay frames and is not a TURN server.
6. **No screenshot fallback.** When WebRTC fails, the UI shows a typed error
   state and reconnects. It never silently reverts to image polling. Rollback is
   a full version rollback, not a hidden legacy capture path.
7. **No stored thumbnails.** Video Moments — the replacement for a snapshot
   grid — is an *index into existing recordings*. Each tile is a paused
   `<video>` seeked to a deterministic timestamp, decoded in the viewer's
   browser and never persisted. No `preview_image_url`, no `canvas.toDataURL()`,
   no thumbnail objects, no image endpoint.

**Recording is policy-driven and off by default for this migration.** The
default posture is: no image storage at all, video storage only when Session
Recording is explicitly enabled on a Monitoring Profile. With recording off there
is no history and no Session Player, and the product must say so plainly rather
than showing an empty player.

## Alternatives considered

**Keep still frames, raise the frame rate.** Rejected on the measurement above.
At 15 FPS the typical frame costs 9.7 Mbps and the worst case 29 Mbps, and the
encode ladder alone (66.8–453.6 ms/frame on the *fastest* hardware available)
exceeds the 66 ms budget a 15 FPS interval allows. The audit's §3.2 note that a
typical Windows laptop is 3–4× slower single-core makes this arithmetically
impossible, not merely expensive.

**Ship video through the existing Go API** (HLS push through the backend).
Rejected: it keeps the API in the media path, keeps the per-IP ingest limiter in
front of a media stream, and gives up WebRTC's congestion control and sub-second
latency — the glass-to-glass SLO is 700 ms p95, which an HTTP segment pipeline
cannot meet.

**Self-host the SFU on Railway alongside the API.** Rejected for the first
implementation. Realtime media needs verified UDP, public addressability, and
egress bandwidth headroom that the current Railway web service has not been shown
to have. The API, Postgres and jobs stay on Railway; the media plane moves to a
dedicated service. Self-hosting stays open behind the `MediaProvider` interface
after UDP/ports/public-IP/autoscaling are actually tested.

## Consequences

**A provider abstraction is mandatory.** Handlers bind to `MediaProvider` and
`RecordingStore` interfaces, never to a LiveKit or S3 SDK directly. First
implementation: LiveKit Cloud + LiveKit Egress + S3-compatible storage, with
STUN/TURN over TLS and short-lived TURN credentials.

**A native media runtime is required on Windows, separate from the Tauri
WebView.** Capture must survive the UI window being closed or reloaded, so the
media runtime is its own process under the existing Windows service supervisor.
The capture/encode/publish binding (C++/WinRT vs Rust vs a LiveKit-compatible
native publisher) is chosen by a measured spike in **V04** and recorded in a
follow-up ADR — this ADR deliberately does not pre-decide it.

**New schema, no renamed old schema.** `media_sessions`, `media_tracks`,
`recording_assets`, `recording_gaps`, `viewer_sessions`,
`remote_control_sessions`, `media_audit_events`. Creating a `frames`,
`screenshots_v2`, `thumbnails` or `image_blobs` table under a new name is
explicitly a violation of this ADR, not a workaround for it.

**Gaps become data.** `offline`, `locked`, `outside_schedule`,
`privacy_blackout`, `capture_error`, `network_unavailable`, `recorder_error`.
Holding the last frame to paper over a gap is prohibited; the timeline shows the
gap, its reason and its duration.

**Existing screenshots are not deleted by this decision.** V02 stops *new*
still capture; the historical `screenshots` table, its filestore blobs and their
retention are inventoried and disposed of in V12 only after an explicit decision
by the data owner. Stopping collection is safe and reversible; deletion is not.

**Removal is bounded.** The legacy media surface being retired is ~2 600 lines
across `internal/live`, `handlers/live_view.go`, `handlers/remote_assist.go`,
`handlers/screenshot.go`, `retention/`, `filestore/`, `sync/live_view.rs`,
`sync/remote_assist.rs`, `ScreenshotGallery.tsx` and `PlaybackPanel.tsx`, plus
their routes, locale keys and tests.

**Enforced by CI, not by intent.** A no-image guard fails the build on
`image/jpeg|png|webp` content types in media APIs, on `.jpg/.jpeg/.png/.webp`
object keys under media prefixes, on `<img>` inside the live/session/moments
components, and on new screenshot-shaped tables. Static UI assets are exempt.

**Accepted limitation — this ADR is a decision, not an implementation.** No
WebRTC code exists at the time of writing. Nothing in V01 built, prototyped or
verified a media plane; V01 measured the current one and wrote this down.

## Follow-ups

1. **ADR 0003** — Windows capture/encode/publish binding, decided by the V04
   benchmark on real hardware.
2. **ADR 0004** — retention, legal hold and deletion semantics for recorded
   video, before V08 ships storage.
3. **Drop `remote_assist_frames`** (ADR 0001 follow-up 2) as part of V12 rather
   than in isolation — it has been written-to by nothing since ADR 0001.
4. **Redis-backed `live.Store`** (ADR 0001 follow-up 1) is **cancelled** if V05
   lands before the backend scales out: the SFU owns fan-out, and the in-process
   hub is deleted rather than distributed.
