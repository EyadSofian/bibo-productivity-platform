# media-publisher IPC protocol

The contract between the Rust agent (`apps/desktop/src-tauri`) and the native
media sidecar. The agent is the **server**; the sidecar is the **client** and
connects on startup.

This document is the source of truth for both sides. It is deliberately written
before either implementation so the Rust and C++ ends cannot drift.

## Why a sidecar at all

Capture and WebRTC publishing do not belong in the Tauri WebView:

- The WebView cannot reach Windows Graphics Capture or a native SFU client.
- A crash in the media path must not take the agent (and its tracking) down.
- The media process can be killed instantly for the emergency-stop requirement
  without touching the agent.

## Transport

| Property | Value |
| --- | --- |
| Transport | Windows named pipe |
| Name | `\\.\pipe\engosoft-media-<agent_pid>` |
| Mode | message-oriented, duplex |
| Access | restricted by SDDL to the creating interactive user only |
| Remote clients | rejected |
| Encoding | one UTF-8 JSON object per message, no framing bytes |

The pipe name embeds the agent PID so a stale sidecar from a previous run can
never attach to a new agent.

### Peer verification

Both ends verify the other before exchanging anything sensitive:

- The agent checks the connecting client's PID is the sidecar it spawned.
- The sidecar refuses to proceed if the server PID is not its own parent.

## Security rules

These are requirements, not suggestions.

1. **The publisher token never touches the command line.** On Windows any user in
   the same session can read another process's command line, so a token in
   `argv` is effectively public. It is sent only over the pipe, after peer
   verification.
2. **The sidecar never holds an API key or secret.** It receives only a
   short-lived publisher JWT that the *backend* minted. It cannot mint its own.
3. **The sidecar never logs a token, a signed URL, or any pixel data.** The log
   redactor drops any field named `token`, `jwt`, `secret`, `url`, or
   `authorization` regardless of nesting.
4. **Capture stops when the agent dies.** The sidecar watches the pipe; a broken
   pipe means the agent is gone and capture must stop immediately. A media
   process must never outlive the agent that authorized it.
5. **The system capture border stays enabled.** No message can turn it off; the
   field does not exist in this protocol.

## Message envelope

Every message, both directions:

```json
{
  "v": 1,
  "id": "b1c2...",
  "type": "<message type>",
  "ts_ms": 1756800000000,
  "payload": { }
}
```

`id` is echoed in the corresponding response so requests and replies can be
correlated. Unknown `type` values are ignored with a warning rather than
treated as fatal, so the two sides can be upgraded independently.

## Agent → sidecar

### `start_session`

Begins capturing and publishing. The only message carrying a token.

```json
{
  "type": "start_session",
  "payload": {
    "session_id": "e1f2...",
    "room": "org_42__device_7",
    "livekit_url": "wss://example.livekit.cloud",
    "publisher_token": "<short-lived JWT, publish-only, single room>",
    "track_name": "screen0",
    "display_id": 0,
    "video": { "width": 1280, "height": 720, "fps": 15 }
  }
}
```

`publisher_token` is redacted from every log line. The sidecar zeroes the buffer
holding it once the room is connected.

### `stop_session`

```json
{ "type": "stop_session", "payload": { "session_id": "e1f2...", "reason": "owner_closed" } }
```

Valid reasons: `owner_closed`, `policy_stop`, `schedule_end`, `agent_shutdown`,
`emergency_stop`.

### `emergency_stop`

Unconditional. Capture stops before the reply is sent — the ack confirms it has
already happened, so an ack that never arrives still means capture is down
(the process is gone). Requirement: under 500 ms.

```json
{ "type": "emergency_stop", "payload": { "reason": "owner_pressed_stop" } }
```

### `update_policy`

Applied to a live session without a reconnect.

```json
{
  "type": "update_policy",
  "payload": {
    "video": { "fps": 10 },
    "privacy_blackout": true
  }
}
```

`privacy_blackout` replaces captured frames with a solid frame at the source, so
no real pixels reach the encoder — a blackout enforced in the viewer would not
be a blackout.

### `ping`

Liveness. The sidecar replies with `pong` carrying its current state.

## Sidecar → agent

### `state`

Sent on every transition, unsolicited.

```json
{
  "type": "state",
  "payload": {
    "session_id": "e1f2...",
    "state": "publishing",
    "reason": null
  }
}
```

States: `idle`, `starting`, `connecting`, `publishing`, `reconnecting`,
`stopping`, `stopped`, `failed`.

When `state` is `failed`, `reason` is one of — and these map onto the player's
error states, so the viewer sees a real cause rather than a spinner:

| reason | meaning |
| --- | --- |
| `capture_unsupported` | `GraphicsCaptureSession::IsSupported()` returned false |
| `capture_failed` | capture item could not be created or was closed |
| `encoder_failed` | no usable encoder |
| `connect_failed` | could not reach the SFU |
| `token_rejected` | SFU refused the publisher token |
| `ice_failed` | transport could not be established |
| `display_gone` | the captured display disappeared |
| `internal_error` | anything else, with a redacted message |

### `metrics`

Emitted on a fixed interval while publishing.

```json
{
  "type": "metrics",
  "payload": {
    "session_id": "e1f2...",
    "capture_backend": "wgc",
    "encoder": "hardware_h264",
    "capture_fps": 14.8,
    "published_fps": 14.9,
    "frames_captured": 4470,
    "frames_repeated": 122,
    "frames_dropped": 3,
    "width": 1280,
    "height": 720,
    "bitrate_bps": 1180000,
    "rtt_ms": 34,
    "packet_loss": 0.002,
    "reconnect_count": 1,
    "cpu_percent": 6.4,
    "memory_mb": 148,
    "border_enabled": true
  }
}
```

`frames_repeated` is not a defect. Both Windows capture APIs are change-driven
and go silent on a still screen — measured gaps up to 0.9 s (ADR 0003) — so the
sidecar repeats the last frame to hold the configured rate. The counter makes
that visible instead of hiding it as capture output.

`border_enabled` is reported so the backend can audit that the tamper-proof
capture indicator was actually on for the whole session.

### `ack`

```json
{ "type": "ack", "payload": { "for": "<id of the request>", "ok": true, "error": null } }
```

### `log`

Structured, already redacted by the sidecar. The agent forwards these to its own
log sink.

```json
{ "type": "log", "payload": { "level": "warn", "msg": "frame pool recreated", "fields": { "reason": "resolution_change" } } }
```

## Lifecycle

```
agent                                  sidecar
  |  spawn (no token on the cmdline)      |
  |-------------------------------------->|
  |            connect to pipe            |
  |<--------------------------------------|
  |  verify peer PID both directions      |
  |<------------------------------------->|
  |             start_session             |
  |-------------------------------------->|
  |         state: starting               |
  |<--------------------------------------|
  |         state: connecting             |
  |<--------------------------------------|
  |         state: publishing             |
  |<--------------------------------------|
  |         metrics (periodic)            |
  |<--------------------------------------|
  |             stop_session              |
  |-------------------------------------->|
  |         state: stopped                |
  |<--------------------------------------|
```

If the pipe breaks at any point, the sidecar stops capture and exits. It does
not attempt to reconnect to the agent — a media process that survives its
authorizing agent is exactly the failure this design is meant to prevent.
