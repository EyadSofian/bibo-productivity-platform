# 146 — V05 (partial): agent-state callback, live player, synthetic publisher

**Status:** Implemented — the agent-free half of V05
**Area:** backend (media handler, store, migration 00020) + web-admin (media transport, LivePlayer, i18n) + CI guard
**Slice:** V05 of `docs/ENGOSOFT_MEDIA_BACKLOG_AR.md`, minus everything that needs the Windows agent or an SFU
**Decision:** [ADR 0002](../adr/0002-video-first-media-plane.md)

## Goal

Take V05 as far as it can honestly go with no Windows machine and no SFU
account, and put a real substitute in place of the agent so the work is verified
rather than assumed.

## What changed

**Agent-state callback.** `POST /v1/agent/media/sessions/:session_id/state` is
how a publisher drives its own session: `negotiating → live ⇄ reconnecting →
ended`, or `failed` with one of the eight codes. The publisher is the only party
that knows whether media is actually flowing — the API cannot see the SFU's
tracks, and a viewer cannot tell "connecting" from "connected but black".

Constrained deliberately: a publisher may only report states that describe
itself. `requested`, `authorizing`, `waiting_for_agent` and `ending` belong to
the control plane, and a device that could claim them could authorize itself.
`failed` without a known code is refused rather than defaulted — a failure with
no code is what produces "it didn't work" with nothing to act on.

**`media_tracks` recording.** What the publisher is sending, upserted per source
so a reconnect re-describes the same track instead of making one screen look like
two displays. Migration 00020 gained the `UNIQUE (media_session_id, source)` this
needs; it is unreleased, so it was corrected rather than patched by a follow-up.

**Browser-side transport seam.** `MediaTransport` mirrors the backend's
`MediaProvider`: the player depends on it, never on a vendor SDK. That is what
lets the whole rendering path be exercised with no SFU, and what makes swapping
the SFU a change to one adapter.

**`LivePlayer`.** A `MediaStream` bound to `<video autoPlay playsInline muted>`.
Every phase has its own message in 8 locales, the API's typed error codes are
translated and shown with their `request_id`, publisher failure codes surface as
specific text, and every waiting state has a 15-second deadline — a spinner with
no timeout is a UI that never admits failure. Unmounting stops every track:
a stream left running after the viewer has gone is a privacy failure, not a leak.

**`SyntheticTransport` — the agent substitute.** Paints a moving scene to a
canvas and hands over `canvas.captureStream()`: a real `MediaStream` with a real
encoded video track. It can also simulate a publisher that never arrives and a
connection that fails, so the waiting, timeout and error paths are exercised
without an agent. The scene moves on purpose — a static test image would let a
frozen `<video>` pass as a working one, which is exactly the failure V01 measured.

**`dev/live-harness.html`.** A dev-only page that runs the real transport in a
real browser. Not in the production build (Vite's build input is `index.html`);
confirmed absent from `dist/`.

## Verified in a real browser

Loaded the harness in the Browser pane and inspected the live DOM:

| | Result |
|---|---|
| `srcObject instanceof MediaStream` | true |
| Track | `video`, `readyState: "live"` |
| Resolution | 1280×720 |
| `<img>` elements on the page | **0** |
| Decoded frames advancing | 11 → 14 over 2.5 s |
| Sampled pixels changed between grabs | true |
| Visible frame counter across two screenshots | 36 → 57, bar swept, gradient shifted |

## Bug found by that verification

The first browser run decoded **exactly one frame**: `currentTime` never
advanced and the pixels never changed. The draw loop used
`requestAnimationFrame`, which stops completely while a tab is hidden — and
`document.hidden` was true. It also ignores the requested rate and runs at the
display's, so `fps` was decorative.

Switched to `setInterval` at `1000/fps`. Browsers throttle background timers to
roughly 1 Hz but never stop them, so the stand-in keeps publishing when nobody is
looking at it. The throttling is documented on the harness page so it is not
mistaken for a player defect. A regression test asserts the loop keeps drawing
after the first frame and stops drawing after teardown.

## CI guard correction

The video-first guard flagged `LivePlayer.tsx` and its test — both false
positives: the prose comments explaining that these files must not use `<img>`
matched the pattern warning against it. Documenting a rule is not breaking it, so
the guard now skips comment-only lines. Re-verified both ways: a real `<img>` in
the component and a real `image/png` in `src/media` still fail the build.
`src/media` was added to the video-only list.

## Suites

Go **160 passed** (was 155) · web-admin **209** (was 192) · extension 63 ·
`go vet`, `go test -race`, `tsc --noEmit`, `vite build`, all three CI guards,
`git diff --check` — clean.

## Still needs the Windows agent or an SFU

Everything below is untouched and cannot be closed from this machine:

1. **A LiveKit (or other) `MediaProvider` implementation.** `MEDIA_PROVIDER` is
   still empty; the unconfigured provider fails every operation with a typed
   error. Needs an SFU account to verify against.
2. **The Windows publisher.** V04's capture/encode spike has not run, so there is
   no ADR 0003 and no binding chosen. The whole agent side of V05 is unstarted.
3. **Every SLO in the backlog.** Time to first frame, glass-to-glass latency,
   stable FPS, reconnect time, TURN-only networks, packet-loss behaviour, agent
   CPU and RAM. None are measurable without a real device on a real network.
4. **`MEDIA_LIVE_ENABLED` rollout to a test device group.**
5. **Wiring `LivePlayer` into the employee profile / Live Monitor page** — that
   is V06's information architecture, and doing it now would mean shipping a
   button that cannot work on any current deployment.
