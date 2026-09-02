# ADR 0003 — Windows screen capture for the media publisher uses Windows Graphics Capture

**Status:** accepted for the capture layer · 2026-09-02
**Supersedes:** the agent-side capture half of [ADR 0001](0001-ephemeral-live-frames.md)
(`xcap` + `webp::Encoder` still frames)

## Context

The Windows media sidecar (`apps/desktop/native/media-publisher/`) has to feed a
LiveKit video track continuously. It needs one screen-capture backend, and the
media brief is explicit that the choice may **not** be made from documentation —
only from measurements taken on real Windows hardware.

Two candidates ship in the Windows SDK, both present on this machine
(`10.0.26100.0`):

| Candidate | Header | Notes |
| --- | --- | --- |
| Windows Graphics Capture (WGC) | `winrt/Windows.Graphics.Capture.h` | WinRT, Windows 10 1803+ |
| DXGI Desktop Duplication | `dxgi1_2.h` | Win32, Windows 8+ |

A third option — a mature pure-Rust capture crate that could live inside the
agent instead of a sidecar — was considered and rejected before measurement.
`xcap`, already a dependency, is a *still-frame* API: it returns an owned
`RgbaImage` per call with no notion of a change-driven frame stream, which is
exactly the model the media plane is replacing. Nothing in the Rust ecosystem
wraps WGC's `FrameArrived` with the maturity this needs, so the capture layer
stays native C++ next to the LiveKit C++ SDK.

## Method

`bench/capture_bench.cpp`, built with MSVC and run on this machine.

Three fairness properties, each of which was got wrong first and then fixed:

1. **The workload is driven, not assumed.** Both APIs are *change-driven* — they
   emit frames when the desktop changes and stay silent when it does not, so a
   measurement on an idle desktop describes the desktop, not the API. The
   harness runs its own activity driver: a top-most window repainting at ~60 Hz.
   Both backends therefore see an identical workload.
2. **Runs are duration-based, not frame-count-based**, so a backend cannot look
   good by finishing early.
3. **One backend per process.** `GetProcessTimes` is cumulative, so running both
   in one process charges the second one for the first one's CPU.

The first version of this harness also **polled** `TryGetNextFrame` on a fixed
tick for WGC. That measured the poll loop, not the API, and produced a badly
wrong result — see *Correction* below. WGC is now driven by the `FrameArrived`
event, which `CreateFreeThreaded` dispatches on a threadpool thread.

### Test machine

```
CPU   AMD Ryzen 5 7535HS (6C/12T)
GPU   NVIDIA GeForce RTX 3050 Laptop + AMD Radeon integrated
OS    Windows 11 Home Single Language, build 26200
MSVC  14.44.35207   Windows SDK 10.0.26100.0
Capture target: primary monitor, 1920x1080
```

## Measured

### Active desktop (60 Hz activity driver), 10 s

| | DXGI Desktop Duplication | Windows Graphics Capture |
| --- | --- | --- |
| frames delivered | 599 | 592 |
| effective FPS | 59.88 | 59.15 |
| inter-arrival p50 | 16.680 ms | 16.647 ms |
| inter-arrival p95 | 17.144 ms | 17.727 ms |
| inter-arrival max | **33.483 ms** | 84.609 ms |
| process CPU | 578.1 ms | 671.9 ms |
| CPU, share of one core | **5.8 %** | 6.7 % |

### Idle desktop (no activity driver), 10 s

| | DXGI | WGC |
| --- | --- | --- |
| frames delivered | 466 | 370 |
| effective FPS | 46.57 | 36.96 |
| inter-arrival p50 | 16.749 ms | 17.797 ms |
| inter-arrival max | 869.808 ms | **453.530 ms** |
| CPU, share of one core | **2.8 %** | 3.9 % |

### Reading of the numbers

- **Throughput is a tie.** Both track a 60 Hz source at ~59 FPS with a p50 of one
  vsync interval. Against the 12–15 FPS product target that is roughly 4x
  headroom, so capture is not the constraint for either backend and FPS cannot
  decide this.
- **Tail latency splits, and the split reverses.** Under load DXGI's worst gap is
  33 ms against WGC's 85 ms; idle, WGC's worst gap is 454 ms against DXGI's
  870 ms. Neither is consistently better, and both tails are single samples from
  one run on one machine — too weak to carry a decision.
- **CPU differs by about one percentage point of a single core**, in DXGI's
  favour in both conditions. Both sit far inside the <12 % agent budget.
- **Capture is change-driven in both cases.** Idle worst-case gaps of 0.45–0.87 s
  mean neither API alone can hold a steady 12–15 FPS. This is a design
  requirement, not a backend difference.

## Decision

**Use Windows Graphics Capture**, with DXGI Desktop Duplication kept as a
documented fallback.

Performance did not decide it — the measurements above are close enough that it
could not. What decides it is a capability DXGI does not have at all.

WGC draws a **system-enforced capture border** around whatever is being captured.
Verified in the SDK headers rather than assumed:

```
Windows.Graphics.Capture.h
  get_IsBorderRequired / put_IsBorderRequired
  get_IsCursorCaptureEnabled / put_IsCursorCaptureEnabled
  IGraphicsCaptureAccessStatics
```

The border is on by default, it is drawn by the OS rather than by us, and
turning it off requires a capability granted through `GraphicsCaptureAccess` —
an application cannot silently remove it. That makes it a monitoring indicator
the monitored person can trust, which is a product acceptance criterion, not a
nice-to-have. **DXGI Desktop Duplication has no indicator of any kind**: a
capture is invisible to the person being captured. Shipping a monitoring agent
on an API with no tamper-proof indicator is not acceptable for this product,
whatever it costs in CPU.

`IsCursorCaptureEnabled` additionally gives explicit control over the required
visible cursor; with DXGI the pointer arrives as a separate shape that we would
have to composite ourselves.

The remaining WGC advantages are secondary but real: per-window and per-display
capture items, no interaction with the elevated-desktop restrictions that
complicate `DuplicateOutput`, and it is the API Microsoft is investing in.

The ~1 point of extra CPU is accepted as the price of the indicator.

## Correction

An earlier run of this benchmark reported WGC at **12.79 FPS with 22 dropped
frames** against DXGI at 14.99 FPS with none, and was committed in
`15cfaf2` with a warning that the comparison was not yet fair.

That result was an artefact of the harness. It polled `TryGetNextFrame` on a
fixed 15 FPS tick; because that call is non-blocking, the "drops" were simply
polls that arrived before the pool had buffered a frame, and the sub-microsecond
p50 was measuring a buffer check rather than a capture. Driven by `FrameArrived`,
WGC delivers 592 frames where DXGI delivers 599 — a 1.2 % difference, not the
15 % deficit first reported. No decision was taken on the wrong numbers.

## Consequences

1. **A pacing layer is required.** Capture is change-driven with idle gaps up to
   ~0.9 s, so the sidecar must hold the last frame and re-submit it to keep the
   track at its configured rate. Without this a still screen looks to the viewer
   like a frozen or dead stream. This applies to either backend.
2. **The capture border ships enabled** and the sidecar must not expose a way to
   disable it. This belongs in the V11 security review as an explicit check.
3. **Frames need no colour conversion.** WGC yields
   `DirectXPixelFormat::B8G8R8A8UIntNormalized`, which maps onto
   `livekit::VideoBufferType::BGRA` (verified in the SDK headers), so frames go
   to the encoder without a conversion pass.
4. **Minimum supported Windows rises to 10 1803**, and `GraphicsCaptureSession::IsSupported()`
   must be checked at startup. If it returns false the sidecar reports
   `capture_failed` with a distinct reason rather than silently falling back —
   falling back to a hidden capture path would defeat the indicator guarantee.
5. **DXGI stays in the tree** behind a build flag, for diagnosing WGC-specific
   problems. It is not a runtime fallback, for the reason in (4).

## Open items

- Tail latency was measured once per condition on one machine. Before V14 sign-off
  this needs repeat runs, and a run on at least one Intel/iGPU-only machine —
  this box has a discrete NVIDIA GPU and hybrid graphics, which is not
  representative of typical office hardware.
- Multi-monitor is not yet measured. WGC needs one capture item per display, and
  the brief calls for independent tracks per monitor.
- ~~The H.264 encode path is not measured here; this ADR covers acquisition only.
  Media Foundation hardware encode (`mfapi.h`, `codecapi.h`) is present and gets
  its own measurement before the sidecar is considered done.~~ **Closed — the
  question does not arise.** See *Encoding* below.

## Encoding: the sidecar does not encode

This open item was written on the assumption that the sidecar hands H.264 to
the SDK. Reading the LiveKit headers showed otherwise, and the correction is
large enough to record here rather than leave in a commit message.

`livekit::VideoSource` takes **raw pixels** and the SDK encodes internally via
its bundled libwebrtc. Three independent signals in the v1.10.0 headers say so:

- `VideoBufferType` (`video_frame.h`) has no compressed member — every
  enumerator is a raw pixel layout.
- `VideoFrame::create` sizes its buffer arithmetically from
  `width * height * bpp`. A compressed frame has no such size.
- The Rust FFI hands the buffer straight to a `NativeVideoSource`.

So Media Foundation is dropped from the design entirely. There is no encoder in
this process, no hardware-encoder selection to measure, and `EncoderKind` in the
metrics is only ever set from what the SDK reports — never inferred.

What this does buy back is a scaling decision. Because the SDK takes raw pixels,
publishing at native resolution would push 1920x1080 BGRA (8.3 MB) across the
FFI boundary 15 times a second and leave libwebrtc to downscale on the CPU. The
sidecar therefore downsamples on the GPU before readback, which cuts the copy to
3.7 MB per frame and moves the filtering off the CPU.

## Implementation outcome

Built and measured on the same machine, Release, MSVC 14.44.35207 with Windows
SDK 10.0.26100.0, against LiveKit C++ SDK 1.10.0 (prebuilt binary release —
no vcpkg, no libwebrtc compile).

| Run (1920x1080 source) | Delivered | New | Repeated | CPU (one core) | Working set |
| --- | --- | --- | --- | --- | --- |
| 1280x720 @ 15, idle-ish, 10.4 s | 14.48/s | 150 | 0 | — | 40.5 MB |
| 1280x720 @ 15, 60 Hz activity driver, 12.3 s | 14.66/s | 179 | 1 | **3.4 %** | 40.1 MB |
| 1280x720 @ 30, 8.3 s | 28.92/s | 236 | 3 | 3.8 % | 40.1 MB |
| 800x800 @ 15 (letterbox), 8.3 s | 14.45/s | 120 | 0 | 4.3 % | 39.6 MB |

Two things in that table matter beyond the totals:

- Under a 60 Hz-changing desktop the published rate holds at 14.66/s, not 60/s.
  Consequence (1) said the pacer must fill gaps upward; the same measurement
  shows it must also **discard downward**. Source frames above the published rate
  are dropped before any GPU work, which is why CPU stays at 3.4 % instead of
  roughly four times that.
- 3.4 % of one core against the <12 % agent budget is measured for capture and
  scaling only. The encode and transport cost is inside the LiveKit DLL and is
  not represented here; it lands in V05.

Consequence (2) — the border ships enabled — is now enforced in code rather than
by intent: `IsBorderRequired(false)` is never called, and no IPC message carries
the field. Consequence (4) is enforced by `CaptureSession::Start` returning
`kUnsupported` with no fallback path.
