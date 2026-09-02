# media-publisher — the Windows media sidecar

Captures one display with **Windows Graphics Capture** and publishes it to a
**LiveKit** room as a video track. It is a separate process from the Tauri
agent, driven entirely over the named pipe in [`docs/ipc-protocol.md`](docs/ipc-protocol.md).

Backend choice and the measurements behind it: [`docs/adr/0003-windows-media-publisher.md`](../../../../docs/adr/0003-windows-media-publisher.md).

## What this process deliberately cannot do

These are enforced by construction, not by convention:

| Property | How it is enforced |
| --- | --- |
| Holds no API key or secret | There is no config for one. It receives only a short-lived publish-only JWT that the backend minted. |
| Never takes a token on the command line | On Windows any process in the same session can read another's command line. The token arrives only over the pipe, after both ends check the other's PID. |
| Writes no image file, ever | There is no image encoder linked and no code path that opens a file for writing. |
| Cannot disable the capture border | `IGraphicsCaptureSession3::IsBorderRequired(false)` is never called, and no IPC message carries that field. |
| Cannot outlive the agent | A broken pipe stops capture and exits the process. There is deliberately no reconnect to the agent. |
| Never logs a token or a signed URL | Every log line goes through `Redact()`, which strips any key ending in `token`, `jwt`, `secret`, `url`, `authorization`, `password`, or `key` at any nesting depth. Covered end-to-end by `ipc_test`. |

## The sidecar never encodes

`livekit::VideoSource` takes **raw BGRA pixels** and the SDK encodes internally
through its bundled libwebrtc. This is visible in the headers three ways:
`VideoBufferType` has no compressed member, `VideoFrame::create` sizes its
buffer arithmetically from `width * height * bpp`, and the Rust FFI hands the
buffer to a `NativeVideoSource`.

So there is no Media Foundation, no H.264 encoder, and no hardware-encoder
selection in this process. `EncoderKind` in the metrics is reported from what
the SDK says, never inferred.

WGC yields `B8G8R8A8UIntNormalized` and the SDK accepts `VideoBufferType::BGRA`,
so no colour conversion sits in the path either.

## Dependencies

The **LiveKit C++ SDK** is consumed as the upstream **prebuilt binary release**,
not built from source. Upstream ships a CMake package with an imported target,
so there is no vcpkg step and no libwebrtc compile.

| | |
| --- | --- |
| Version | **1.10.0** (`livekit_ffi` 0.12.75, built 2026-08-28) |
| Asset | `livekit-sdk-windows-x64-1.10.0.zip` |
| SHA256 | `6808B44E8EF8FDB31194AC084049F416EAE144A34C51A6233F43A5106A54B6D2` |
| Source | <https://github.com/livekit/client-sdk-cpp/releases/tag/v1.10.0> |

Fetch it (SHA256 is verified; a mismatch deletes the archive and fails):

```powershell
pwsh -File tools/fetch-livekit-sdk.ps1
```

It extracts to `third_party/livekit-sdk-windows-x64-1.10.0/`, which is
gitignored — 26 MB of binaries does not belong in the repository.

Bumping the version means **re-reading the headers**. The publisher is written
against exact signatures read from `include/livekit/*.h`, not against the README
example, which is misleading in two places that matter (see the comments in
`src/livekit_publisher.cpp`).

Everything else comes from the Windows SDK: `d3d11`, `dxgi`, `d3dcompiler`,
`windowsapp` (C++/WinRT), `psapi`, `user32`.

## Build

Requires Visual Studio 2022 Build Tools with *Desktop development with C++*,
MSVC v143, and the Windows 10/11 SDK. Verified against MSVC 14.44.35207 and
Windows SDK 10.0.26100.0.

```powershell
pwsh -File tools/fetch-livekit-sdk.ps1
cmake -S . -B build/cmake -G "Visual Studio 17 2022" -A x64
cmake --build build/cmake --config Release
```

Two targets, split along the LiveKit dependency:

- **`media_publisher_core`** — metrics, JSON, capture, IPC. Windows SDK only, so
  its tests build and run on a machine that has never fetched the LiveKit SDK.
- **`media_publisher`** — the executable. Adds the LiveKit publisher and
  `main()`. Without the SDK present, CMake warns and builds only the core.

`livekit.dll` and `livekit_ffi.dll` are copied next to the executable after the
link, so it runs from the build tree with no `PATH` edit.

## Test

```powershell
ctest --test-dir build/cmake -C Release --output-on-failure
```

or run the binaries directly from `build/cmake/Release/`:

| Test | What it covers |
| --- | --- |
| `metrics_test` | Redaction (JSON keys, nesting, bare `key=value` in free text), the metrics payload shape, rate computation. |
| `json_test` | The IPC reader: escapes, surrogate pairs, depth and size limits, and every malformed input it must refuse — including duplicate keys, which are how a sender smuggles a second value past a first-wins reader. |
| `ipc_test` | **End to end over a real named pipe.** The test process becomes the agent, spawns itself as the child, and the child connects through `AgentIpc` exactly as the sidecar does. Covers peer-PID rejection, framing, `ping`/`pong`, policy updates, survival of malformed and unknown messages, emergency-stop latency, and the promise that a token handed in over the pipe never comes back out in a log. |

No mocked transport: `ipc_test` uses `CreateNamedPipeW`, `CreateProcessW`, and
the real `AgentIpc`.

## Running it by hand

Normal operation is as a child of the Rust agent — `Connect` refuses any peer
that is not this process's parent, so it cannot be driven from a shell.

Two diagnostic modes exist for verifying the capture half on a Windows machine
without a LiveKit room:

```powershell
media_publisher.exe --self-test
media_publisher.exe --capture-probe=10 --size=1280x720 --fps=15
```

`--capture-probe` runs the **real** WGC pipeline for N seconds and reports what
it measured. It writes nothing anywhere; the callback only counts frames and
samples a checksum. It is a diagnostic of the real path, **not** a stand-in for
one — nothing it prints is evidence that publishing works.

### Measured on the development machine

AMD Ryzen 5 7535HS, RTX 3050 Laptop, Windows 11 build 26200, one 1920x1080
display, Release build.

| Run | Delivered | New | Repeated | CPU | Working set | Stop |
| --- | --- | --- | --- | --- | --- | --- |
| 1280x720 @ 15, idle-ish desktop, 10.4 s | 14.48/s | 150 | 0 | — | 40.5 MB | 40.1 ms |
| 1280x720 @ 15, 60 Hz activity driver, 12.3 s | 14.66/s | 179 | 1 | **3.4 %** of one core | 40.1 MB | 32.8 ms |
| 1280x720 @ 30, 8.3 s | 28.92/s | 236 | 3 | 3.8 % | 40.1 MB | 33.3 ms |
| 800x800 @ 15 (letterbox path), 8.3 s | 14.45/s | 120 | 0 | 4.3 % | 39.6 MB | 28.8 ms |

The second row is the load-bearing one: with the desktop changing at 60 Hz the
published rate stays at 14.66/s rather than 60/s, which is the source-rate
limiter doing its job — WGC delivers at the desktop's change rate, and doing the
GPU work plus a readback for every one of those would cost four times what the
published rate needs.

## Design notes worth knowing before editing

**Scaling happens on the GPU.** A fullscreen-triangle shader downsamples the
captured desktop into the published resolution before readback. Handing the
encoder a native-resolution frame instead would mean copying 8.3 MB per frame
across the FFI boundary and letting libwebrtc downscale on the CPU. The GPU path
cuts the copy to 3.7 MB and moves the filtering off the CPU entirely. Aspect
ratio is preserved by letterboxing, never by stretching.

**The pacer repeats frames, and says so.** Both Windows capture APIs are
change-driven and go silent on a still screen — measured idle gaps reach 0.9 s
(ADR 0003). A publisher that forwarded only real capture events would look
frozen. The pacer re-emits the last frame to hold the configured rate, and
`frames_repeated` is counted separately so it is never mistaken for capture
output.

**Blackout is enforced at the source.** `SetBlackout(true)` makes the capture
callback return *before reading a single pixel off the GPU*. A blackout applied
anywhere downstream would mean the real desktop had already been copied into
process memory.

**Emergency stop is an atomic store first.** The IPC handler sets blackout
inline — real pixels stop within one frame interval (≤ 67 ms at 15 FPS) — and
queues the orderly teardown behind it, so a connect in progress cannot hold the
500 ms budget hostage. Measured round trip in `ipc_test`: **16.6 ms**.

**Failures are polled, not pushed.** A display disappearing or a lost D3D device
is detected on a WinRT threadpool thread; tearing capture down from inside its
own event handler would deadlock event revocation. `CaptureSession::status()` is
read on the metrics tick instead.

## Not done yet

- `LiveKitPublisher::Stats()` returns zeroes. `Room::getStats()` is called and
  its result deliberately left unmapped rather than filled with plausible
  numbers; V06 pins down which `RTCStats` members the quality panel needs.
- No live publish against a real LiveKit room has been run from this machine
  yet — that is V05, and it needs the backend's token minting.
- Multi-monitor capture is one display per session (`display_index`). Separate
  tracks per monitor come later.
