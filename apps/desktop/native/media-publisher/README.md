# media-publisher — Windows capture sidecar

> Imported from Windows delivery `9cce5fc` and adapted to the newer application.
> Historical Windows measurements below belong to that delivery. They were not
> rerun on this integration. Recording and remote input are not enabled here.

Captures the screen and publishes it to the SFU for the video-first media plane.

- Design: [`docs/adr/0002-video-first-media-plane.md`](../../../../docs/adr/0002-video-first-media-plane.md)
- Backend choice + measurements: [`docs/adr/0003-windows-media-publisher.md`](../../../../docs/adr/0003-windows-media-publisher.md)
- Integration status and validation: [`docs/tickets/147-windows-live-video-integration.md`](../../../../docs/tickets/147-windows-live-video-integration.md)

## Why a separate process

The sidecar is **not** part of the Tauri app's build and does not run inside the
WebView. A capture or encoder crash must not take down the agent UI, and the WebView
must never be responsible for capture or WebRTC.

## Pinned versions

Bumping any of these is a deliberate, reviewed change — the capture path is
sensitive to backend behaviour.

| Component | Version | Why pinned |
|---|---|---|
| `windows-capture` | **2.0.1** | Windows Graphics Capture + the DXGI path used for the ADR 0003 comparison |
| `windows` | **0.62** | Microsoft's official bindings (DXGI/D3D11, process timing) |
| Rust toolchain | **stable-x86_64-pc-windows-msvc** | MSVC only. The GNU toolchain cannot link the Tauri test cdylib (`ld: export ordinal too large`) |
| MSVC | 14.44.35207 | verified build machine |
| Windows SDK | 10.0.22621 / 10.0.26100 | verified build machine |

> **LiveKit SDK.** There is no official LiveKit **C++** SDK — `livekit/client-sdk-cpp`
> is a 404. The official client SDK is Rust (`livekit` crate). See ADR 0003, Decision 1.

## Build

```
set CARGO_TARGET_DIR=C:\lkb
cargo build --release
```

Requires MSVC and the Windows SDK. Standalone crate with its own `[workspace]`, so it
is not built by the Tauri app.

### The short target directory is required, not a preference

`webrtc-sys` unpacks the prebuilt libwebrtc into the target directory, and some of its
abseil headers sit ~190 characters deep. Built in place, the deepest path is **266
characters** — over Windows' 260-char `MAX_PATH` — and the compiler fails with a
misleading error:

```
fatal error C1083: Cannot open include file: 'absl/functional/internal/any_invocable.h'
```

The file is present; it simply cannot be opened at that path length. Two fixes:

- **Set `CARGO_TARGET_DIR` to a short path** (e.g. `C:\lkb`). No admin needed. This is
  what CI and the dev setup should do.
- Or enable long paths system-wide
  (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`), which
  **requires administrator rights**. It was `0` on the reference machine.

## Run

```
media-publisher --pipe \\.\pipe\bibotracking-media-<session>   # normal operation
media-publisher --selftest                                     # local capture check
```

`--selftest` captures for 3s and prints a metrics line. It publishes nothing and
connects to nothing — it exists to verify the capture path on a machine with no
backend.

Measured on the reference machine (i7-9850H, Quadro T2000, Win11 26200):

```json
{"event":"selftest_done","metrics":{"frames_captured":45,"width":1920,"height":1080,
 "fps":14.999,"capture_errors":0,"encoder":"unknown"}}
```

`"encoder":"unknown"` in a selftest run is honest: selftest does not publish, so no
encoder is negotiated. During a real session the metric reports `software` (see Status).

## Benchmark

```
cargo run --release --bin capture-bench -- 10
```

Compares WGC against DXGI Desktop Duplication and writes JSON to stdout. Results
committed at [`docs/measurements/v04-capture-bench-windows.json`](../../../../docs/measurements/v04-capture-bench-windows.json).

## IPC

Newline-delimited JSON over a local named pipe. The **agent** creates the pipe server
and owns its ACL; the sidecar connects as a client. Types are in
[`src/agent_ipc.rs`](src/agent_ipc.rs).

Agent → sidecar: `start`, `stop`, `ping`, `get_metrics`.
Sidecar → agent: `state`, `metrics`, `warning`, `fatal`, `pong`.

A closed pipe means the agent is gone, and is treated as an implicit stop — the
sidecar must never outlive the agent and keep capturing.

## Security properties

- **No API secret.** The sidecar receives only a short-lived publisher token over IPC,
  holds it in memory, and never logs, persists or echoes it. `metrics::redact()`
  reduces any such value to `<redacted:Nchars>`.
- **No screen content in logs.** Metrics describe the stream (rate, size, codec,
  drops), never what is on it. Enforced by
  `metrics::tests::snapshot_carries_no_identifiers_or_content` and
  `agent_ipc::tests::no_event_variant_can_carry_a_token`.
- **No files written.** No JPEG/PNG/WebP, no frame dumps, no scratch images. Frames go
  to a sink and are dropped.
- **Interactive session only.** No service mode, no hidden capture. The cursor is
  captured and the app shows a persistent monitoring indicator.
- **Immediate stop.** `stop()` is checked before every frame is delivered, so session
  end, policy stop and emergency stop all take effect at once. Verified under the
  500ms budget by `capture_delivers_frames_and_stops_promptly`.

## Status

| Piece | State |
|---|---|
| WGC capture at 15fps, cursor, source-capped | **done, verified on hardware** |
| Immediate stop (<500ms) | **done, tested** |
| Typed named-pipe IPC | **done, tested** |
| Metrics + safe JSON logging | **done, tested** |
| Capture-backend benchmark | **done, measured** |
| H.264 encode + LiveKit publish | **done, verified against a real SFU** |
| **Hardware** H.264 encoding | **NOT achieved** — see below |
| Downscale to the configured resolution | **NOT implemented** — see below |
| Multi-monitor as separate tracks | not started |
| Reconnect on network change | not started |
| Rust agent supervision (spawn/token/state) | not started |

### Verified end to end

`cargo test --test publish_integration` against `livekit-server 1.13.6` on
`ws://127.0.0.1:7880`:

```
frames_captured: 15, frames_published: 15, frames_dropped: 0,
capture_errors: 0, encoder_errors: 0, reconnects: 0
test captures_and_publishes_real_frames_to_a_real_sfu ... ok
test subscribe_only_token_cannot_publish ... ok
```

Server-side confirmation that the permission model holds — the SFU refused the
subscribe-only token's publish attempt:

```
WARN livekit.pub  no permission to publish track
  {"room":"biz-itest--session-viewer","participant":"user-itest","kind":"VIDEO"}
  "reason":"NOT_ALLOWED","addTrack":{"name":"screen","source":"SCREEN_SHARE",...}
```

### Two honest gaps

1. **The encoder is software, not hardware.** libwebrtc's built-in H.264 on Windows is
   **OpenH264**, which the run announces itself:
   `[OpenH264] ... AdaptiveQuant is not supported yet for screen content`. Hardware
   encoding (NVENC / Quick Sync / AMF) requires installing a custom encoder factory,
   which this build does not do. `metrics.encoder` therefore reports **`software`** —
   declared, not hidden, as the spec requires. The SLO work in V14 needs the hardware
   path.
2. **The configured resolution is not enforced.** `PublishConfig.width/height` are
   passed to the video source, but WGC delivers the monitor's native frames
   (1920x1080 on the reference machine) and the publisher reallocates its I420 buffer
   to match. There is no downscale step yet, so the stream is native resolution.
   `metrics.width/height` report what is actually sent, not what was requested.
