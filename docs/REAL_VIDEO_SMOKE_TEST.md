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

To validate a newly provisioned cloud SFU, explicitly run
`go run ./cmd/media-smoke --configured-sfu` with `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
and `LIVEKIT_API_SECRET` provided securely through its environment. No other app
configuration or database is needed. Only synthetic video is sent. The harness
still binds loopback and accepts only same-origin requests; it does not expose
an unauthenticated credential endpoint to the network. Do not paste secrets into
commands, browser URLs, logs, source files, or this document.

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

The full CI run
[33977238220](https://github.com/EyadSofian/bibo-productivity-platform/actions/runs/33977238220)
and installer run
[33977238183](https://github.com/EyadSofian/bibo-productivity-platform/actions/runs/33977238183)
passed at revision `d496de5`, version 1.5.11. Windows results include 53 native
unit tests, the real SFU/native decode test, 103 desktop tests, and an actual
NSIS installation. The installed automatic-start supervisor ran successfully;
the installed publisher matched the build hash and its version command passed.
macOS, web, backend and dependency checks also passed. None of these hosted
Windows tests captures an interactive user's desktop.

The last-viewer stop decision now uses the same database transaction/parent lock
as viewer joins. A race-detector test runs concurrent join/leave 20 times and
asserts either the join succeeds with its session alive or it is refused after
the session ends. A successful join cannot be silently cut off by a stale count.

Before deployment, production was inspected read-only on 2026-09-05: `/healthz` reported schema 19;
the Railway web service had no `MEDIA_PROVIDER` or `LIVEKIT_*` configuration.
That deployment is distinct from this tested branch. Desktop release version is
now 1.5.11.

## Deployed verification, later on 2026-09-05

Railway deployment `02a3cade-707b-4900-bb67-db2c0fe3eb22` now serves revision
`d496de5`, with schema 21 and `status: ok`. LiveKit Cloud project `tracking` is
configured through service environment secrets. Cloud-only smoke and the
deployed control-plane smoke both passed, including actual H.264 decode and
server-driven teardown. No real employee content was used.

The deployed check can be repeated explicitly from the repository root:

```sh
python3 scripts/deployed-media-smoke.py --base-url https://web-production-25e92.up.railway.app
```

This creates a separate, clearly named synthetic QA tenant and accounts, logs
in through the production auth endpoint, enrolls an empty synthetic device,
and uses production media endpoints to obtain the browser/publisher tokens.
Open the loopback URL it prints. After the browser reports PASS, stop the
harness with Ctrl+C: it ends any remaining test sessions and archives its device.
The isolated QA tenant remains as an audit record. Credentials stay in memory.
It is not a load test and does not capture a screen or camera.

The user confirmed on 2026-09-05 that the physical Windows device is currently
unavailable. Real desktop capture, lock/unlock, sleep/resume, network recovery,
local privacy stop and sustained performance on that device remain unverified.
Recording/Video Moments and remote control remain unavailable in this version.
