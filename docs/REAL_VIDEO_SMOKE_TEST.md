# Real video integration test

Run a disposable local SFU with the official [LiveKit local setup](https://docs.livekit.io/transport/self-hosting/local/):

```sh
livekit-server --dev --bind 127.0.0.1
```

Build the browser test from the repository root:

```sh
pnpm --filter @ctracking/web-admin exec vite build --config scripts/media-smoke.config.ts
```

From `apps/backend`, start the test-only server:

```sh
go run ./cmd/media-smoke
```

Open `http://127.0.0.1:5191` and select **Run video test**. This uses fixed local
development credentials, a unique disposable room, and a synthetic animated
canvas; it never requests camera or screen access. Credentials stay in memory,
are not printed, and expire after two minutes. The test command is separate from
the production backend and the test page is outside the deployed admin bundle.

The test checks actual room creation by our Go provider, server-recognized
publisher permissions, H.264 through the SFU, at least 15 decoded frames in the
production browser adapter, changing decoded pixels, and room deletion causing
both clients to disconnect and the viewer to clear its stream. It always stops
local tracks and disconnects. Abandoned rooms are deleted after two minutes.

The PostgreSQL/control-plane integration also runs against the actual SFU:

```sh
# In apps/backend, with TEST_DATABASE_URL set to a disposable PostgreSQL database:
LIVEKIT_LOCAL_TEST=1 go test -race ./internal/handlers -run TestMediaLifecycleWithRealLiveKit -count=1 -v
```

This checks current handler/store contracts and cross-tenant refusal, real room
creation/deletion, scoped token responses, and withdrawal of device demand and
publisher credentials after stop. Test authentication is injected by the existing
handler harness; it does not test login.

Observed 2026-09-05 on macOS, LiveKit server 1.13.6, in-app Chromium:

- Browser: PASS, 15 H.264 frames decoded at 640×360, two distinct remote pixel
  samples, publisher and viewer disconnected by server stop, viewer cleared.
- PostgreSQL + real SFU lifecycle: PASS under Go's race detector.

These results establish a real local media round trip. They do not establish
Windows screen capture, WAN/TURN connectivity, deployed credentials, recording,
or remote control. Windows installer CI separately verifies the installed sidecar
matches the staged executable and can start without needing a desktop capture.
Use `scripts/verify-windows-install.ps1` on an interactive Windows machine for
the installed capture test.

Viewer crash recovery uses migration 21: the player renews its lease while it
polls session state. Device demand expires when every viewer has been absent for
90 seconds. Expiry and heartbeat updates lock the same parent session; an expired
heartbeat cannot resurrect capture. Four PostgreSQL tests cover abandonment,
renewal, tenant scope, and retaining a second active viewer; the browser test
verifies teardown when renewal is refused.

The Windows CI and installer workflow also run `scripts/test-windows-media.ps1`.
It verifies the official server archive's SHA-256, starts a loopback SFU, and
explicitly runs the ignored Rust synthetic-video test. That test uses the same
publisher implementation as screen capture and requires at least 20 remotely
decoded 640×360 frames. It requires no screen permissions. The interactive
capture test remains separately ignored and cannot silently pass when its
environment variables are missing.
