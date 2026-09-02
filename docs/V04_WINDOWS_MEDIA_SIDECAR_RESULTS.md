# V04 — Windows media sidecar: results

Follows [V04_WINDOWS_BASELINE_RESULTS.md](V04_WINDOWS_BASELINE_RESULTS.md), which
recorded the green Windows baseline before any media code existed.

Branch `feat/video-first-media-windows`. All commands were run on the Windows
development machine; nothing here is inferred from macOS or from documentation.

## Machine

```
CPU   AMD Ryzen 5 7535HS (6C/12T)
GPU   NVIDIA GeForce RTX 3050 Laptop + AMD Radeon integrated
OS    Windows 11 Home Single Language, build 26200
MSVC  14.44.35207     Windows SDK 10.0.26100.0     CMake 4.4.3
Display: one, 1920x1080
```

## What was built

`apps/desktop/native/media-publisher/` — the native sidecar. Complete as a
process: it builds, links against the real LiveKit SDK, runs, and captures.

| File | |
| --- | --- |
| `CMakeLists.txt` | Two targets split along the LiveKit dependency. |
| `src/metrics.{h,cpp}` | State, failure reasons, counters, redaction. *(earlier commit)* |
| `src/json.{h,cpp}` | Strict reader for the IPC protocol. |
| `src/capture_session.{h,cpp}` | Windows Graphics Capture, GPU downscale, rate pacing, blackout. |
| `src/agent_ipc.{h,cpp}` | Named-pipe client, peer-PID verification, message dispatch. |
| `src/livekit_publisher.{h,cpp}` | LiveKit room + video track. *(earlier commit; first compiled here)* |
| `src/main.cpp` | Lifecycle, emergency stop, metrics timer, diagnostics. |
| `tests/{metrics,json,ipc}_test.cpp` | |
| `tools/fetch-livekit-sdk.ps1` | SHA256-pinned SDK fetch. |
| `README.md` | Build, test, and the design decisions worth knowing before editing. |

## The LiveKit SDK blocker is gone

The previous session recorded that `livekit_publisher.cpp` had never been
compiled, and that building the SDK would need vcpkg with an
`x64-windows-static-md` triplet and a source build.

That was unnecessary. Upstream ships **prebuilt per-platform binary releases**
with a CMake package config and an imported target:

```
livekit-sdk-windows-x64-1.10.0.zip
sha256 6808B44E8EF8FDB31194AC084049F416EAE144A34C51A6233F43A5106A54B6D2
livekit_ffi 0.12.75, built 2026-08-28
```

`tools/fetch-livekit-sdk.ps1` downloads it, verifies the hash, and extracts it
into a gitignored `third_party/`. No vcpkg, no libwebrtc compile.

`src/livekit_publisher.cpp` was written in an earlier commit against signatures
read from these headers but had never been through a compiler. It now compiles
and links unchanged apart from two added standard includes — every signature it
was written against was correct.

## Commands and results

### Build

```
pwsh -File tools/fetch-livekit-sdk.ps1
cmake -S . -B build/cmake -G "Visual Studio 17 2022" -A x64
cmake --build build/cmake --config Release
```

Clean tree, full rebuild: **0 errors, 0 warnings** at `/W4 /permissive-`.

Artifacts: `media_publisher_core.lib`, `media_publisher.exe`,
`metrics_test.exe`, `json_test.exe`, `ipc_test.exe`.

### Tests

```
ctest --test-dir build/cmake -C Release --output-on-failure
```

```
1/3 Test #1: metrics ..........................   Passed    0.02 sec
2/3 Test #2: json .............................   Passed    0.02 sec
3/3 Test #3: ipc ..............................   Passed    0.17 sec
100% tests passed out of 3
```

Assertion counts from the binaries themselves:

| Test | Checks | Failures |
| --- | --- | --- |
| `metrics_test` | 39 | 0 |
| `json_test` | 65 | 0 |
| `ipc_test` | 52 | 0 |

`ipc_test` is not a serializer unit test. The test process **becomes the agent**:
it creates the real named pipe with `CreateNamedPipeW`, spawns itself as a child
with `CreateProcessW`, and the child connects through `AgentIpc` exactly as the
sidecar does. No mocked transport. It covers:

- the pipe name in `docs/ipc-protocol.md`, verbatim;
- **peer rejection** — `Connect(0)` and a peer that is not this process's parent
  are both refused;
- `start_session` → `ack` → `log` → `state`, with the envelope id echoed;
- **that a publisher token handed in over the pipe never comes back out.** The
  child is given a JWT-shaped token and deliberately logs it under a
  `publisher_token` field; the parent asserts the raw bytes of the reply do not
  contain it anywhere and that the field reads `[redacted]`;
- `display_id` in the protocol mapping onto `display_index` in the struct;
- `ping` → `pong` carrying the live state, not a placeholder;
- `update_policy` with fps and blackout;
- survival of a truncated message and of an unknown message type — each logged
  as a warning, with the child still answering a `ping` afterwards;
- **emergency stop acknowledged in 16.6 ms** against the 500 ms requirement;
- the sidecar exiting cleanly when the agent closes the pipe.

### Still-capture guard

```
node .github/scripts/check-no-still-capture.mjs
✔ still-capture guard: no new still capture (10 legacy path(s) pinned)
```

The sidecar adds no new still-capture path. It links no image encoder and has no
code path that opens a file for writing.

### Real capture on real hardware

`media_publisher.exe --capture-probe` runs the **real** WGC pipeline and reports
what it measured. It writes nothing anywhere — the callback counts frames and
samples a checksum so the compiler cannot elide the path. It is a diagnostic of
the real pipeline, not a stand-in for one.

```
> media_publisher.exe --self-test
capture supported : yes
displays          : 1
capture border    : always on (never disabled by this build)
```

| Run | Delivered | New | Repeated | CPU (one core) | Working set | Stop |
| --- | --- | --- | --- | --- | --- | --- |
| 1280x720 @ 15, idle-ish, 10.4 s | 14.48/s | 150 | 0 | — | 40.5 MB | 40.1 ms |
| 1280x720 @ 15, 60 Hz activity driver, 12.3 s | 14.66/s | 179 | 1 | **3.4 %** | 40.1 MB | 32.8 ms |
| 1280x720 @ 30, 8.3 s | 28.92/s | 236 | 3 | 3.8 % | 40.1 MB | 33.3 ms |
| 800x800 @ 15 (letterbox path), 8.3 s | 14.45/s | 120 | 0 | 4.3 % | 39.6 MB | 28.8 ms |

Backend reported as `wgc`, border `on`, status `ok` in every run.

The second row is the one that matters. With the desktop changing at 60 Hz the
published rate stays at 14.66/s, not 60/s: source frames above the target rate
are discarded before any GPU work. That is why CPU is 3.4 % of one core rather
than roughly four times it.

Against the V14 SLOs, for the capture half only:

| SLO | Target | Measured |
| --- | --- | --- |
| frame rate | 12–15 FPS | 14.5–14.7 FPS |
| agent CPU | < 12 % | 3.4 % of one core |
| agent memory increment | < 250 MB | 40 MB working set, flat across runs |
| emergency stop | < 500 ms | 16.6 ms (IPC round trip incl. the handler) |

## What is deliberately not claimed

- **No live publish has been run.** Nothing has connected to a LiveKit room from
  this machine. `PublishStatus`, reconnect handling, and the token lifecycle are
  written against the headers and compile, but they are unexercised. That is V05
  and it needs the backend's token minting.
- **The CPU figure covers capture and scaling only.** Encode and transport happen
  inside the LiveKit DLL and are not in these numbers.
- **`LiveKitPublisher::Stats()` returns zeroes.** `Room::getStats()` is called and
  its result left deliberately unmapped rather than filled with plausible
  numbers; V06 decides which `RTCStats` members the quality panel needs.
- **One display, one machine, one GPU.** Multi-monitor is untested. ADR 0003's
  open item about running on Intel/iGPU-only hardware stands.
- **The Rust agent end of the pipe does not exist yet.** The protocol is
  implemented and tested on the C++ side against a test harness that plays the
  agent; the real agent-side server is the next piece of work.

## Next

1. Rust agent side: request the publisher token from the backend, spawn and
   supervise the sidecar, serve the pipe, forward state and metrics.
2. V05: the real LiveKit provider in `apps/backend/internal/media/`, so a token
   exists to publish with.
