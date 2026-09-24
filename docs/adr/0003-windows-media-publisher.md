# ADR 0003 — Windows screen publisher integration

- Status: accepted implementation choice; Windows end-to-end validation pending
- Integration date: 2026-09-05
- Baseline: [ADR 0002](0002-video-first-media-plane.md)
- Status: [ticket 147](../tickets/147-windows-live-video-integration.md)

The Windows delivery at commit `9cce5fc` used a standalone Rust publisher with
Windows Graphics Capture and the LiveKit Rust SDK. The desktop WebView does not
capture or encode the screen. Version `1.5.24` uses Windows Graphics Capture again
after a physical post-sleep test showed that the borderless DXGI and GDI paths could
connect successfully yet deliver zero frames.

## Capture and visibility

Windows Graphics Capture delivers desktop frames and the system cursor through the
interactive user session. It displays the native yellow privacy border while sharing.
That border makes an active share visible to the person at the computer; it neither
opens a terminal window nor controls the lifetime of the publisher. The sidecar is
launched with `CREATE_NO_WINDOW`, so it stays hidden and minimizing a terminal cannot
end a stream.

Capture depends on the existing local consent, monitoring schedule, pause and
excluded-app gates. Windows session checks require an active, unlocked session and
the ordinary input desktop; unknown OS state denies capture. The capture handler
reports a closed surface to the agent, which ends the session with a typed failure
instead of leaving the dashboard indefinitely waiting for frames.

The original capture benchmark reported WGC at 14.6 fps and 6.1% of one CPU core
versus **uncapped** DXGI at 62.3 fps and 25%. Raw data is preserved in
[the benchmark JSON](../measurements/v04-capture-bench-windows.json).

## Encoding and transport

The imported LiveKit publisher uses the SDK's H.264 path and reports software
encoding. Hardware encoding, sustained CPU/RAM limits, capture latency and a real
browser receiving and decoding Windows frames still require target-machine tests.
Passing protocol tests or reaching a local `publishing` state does not prove that
a remote browser received video.

The backend holds the LiveKit API secret. The agent receives only a short-lived,
room-scoped token with screen publication permission. Viewers receive subscribe-only
tokens. Neither role can publish data in this integration, and the agent never
arms remote input. Recording remains unavailable until private storage, egress,
webhooks, retention and playback are integrated and verified.

## Supervision and packaging

The agent owns a local, owner/SYSTEM-only named pipe rejecting remote clients.
Connection setup has a five-second deadline and observes local stop and child
exit. The temporary nonblocking connection phase returns to ordinary blocking
I/O before the JSON protocol is used; this follows the connection-state semantics
in [Microsoft's ConnectNamedPipe reference](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe).

Authorization polling fails closed. Between server polls, local gates are checked
every 100 ms. Stop asks the child to exit and kills/reaps it after a 400 ms grace
period. These are configured budgets, not measured end-to-end latency guarantees.
Old event readers cannot change the indicator for a newer session.

The sidecar is included through `tauri.windows.conf.json` only. macOS builds do
not require a Windows executable. Windows CI tests and stages the publisher before
building Tauri. The local installer script fails on every failed build, checks
artifact timestamps and emits checksums. Installation and a real stream remain
required before treating an installer as releasable.
