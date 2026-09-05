# 143 — Video-first media plane: V01 audit, ADR, and the V02–V14 backlog

**Status:** V01 done (audit only — no code changed)
**Area:** docs / architecture (drives backend + desktop + web-admin in later slices)
**Driver:** `docs/ENGOSOFT_VIDEO_FIRST_MONITORING_MASTER_PROMPT_AR.md`

## Goal

Replace the still-image screen pipeline with real video: WebRTC for Live View,
recorded video segments for history. This ticket covers **V01 only** — measuring
what exists, deciding the target, and laying out the slices that build it.

## What V01 established

The product's "Live View" is not video. The agent captures one independent WebP
image every 900 ms, POSTs it to the Go API, which base64-encodes it into an SSE
JSON event rendered into an `<img>`. Three still-image paths run today, plus a
Playback filmstrip built from retained screenshots.

**Measured** (`cargo test --release -- --ignored capture_cost`, Apple Silicon,
2560×1440 source):

| | typical | worst case |
|---|---|---|
| encode/frame | 66.8 ms | 453.6 ms |
| encoded size | 59 KiB | 178 KiB |
| bitrate at 1.11 FPS (after base64) | 0.72 Mbps | 2.16 Mbps |

Against the 720p15 @ 1.2 Mbps target that is **8.1×–24.3× the bits per delivered
frame for 7.4% of the frame rate**. Structural, not tunable.

Three findings beyond the frame rate:

- `POST /v1/agent/live/frame` sits behind a **10 rps per-IP** ingest limiter, so
  ~9 devices behind one office NAT saturate it.
- **Live view writes no audit record at all**, and RBAC is a single owner check
  (`memberships.role` is only `owner|employee`).
- Remote control input is **REST polling every 180 ms**.

Corrections to the brief's assumptions, found in the code:

- Live frames already left Postgres (ADR 0001). `remote_assist_frames` is a dead
  table — only ever `DELETE`d.
- **The timezone bug is already fixed.** IANA identifiers flow correctly from
  `src/timeZone.ts` through `time.LoadLocation` to `chrono-tz`. V10 shrinks to
  adding the video policy section plus a regression test.
- `POST /v1/devices/:id/live-capture` has **no UI caller** but is live in the
  backend and agent — and it writes a *permanent* screenshot. Closing it is V02.

## Deliverables

- `docs/adr/0002-video-first-media-plane.md` — the decision, its alternatives and
  its consequences. Supersedes the live-view transport half of ADR 0001.
- `docs/V01_MEDIA_AUDIT_AR.md` — inventory (routes, tables, files, retention),
  current and target data-flow diagrams, measurements, gaps, and an explicit list
  of what could not be measured.
- `docs/ENGOSOFT_MEDIA_BACKLOG_AR.md` — V02→V14 with a dependency graph and
  per-slice acceptance criteria and tests.

## Baseline (run 2026-09-01, all green)

| Suite | Result |
|---|---|
| Backend Go (`go test -count=1 ./...` with `TEST_DATABASE_URL`) | 100 passed |
| Desktop Rust (`cargo test`) | 78 passed, 4 ignored (the capture_cost benchmarks) |
| web-admin (vitest) | 192 passed / 17 files |
| extension (vitest) | 63 passed / 4 files |
| **Total** | **433 passed, 0 failed** |

## Explicitly NOT done

No WebRTC code, no SFU, no object storage, no new tables, no deletions, no
feature flags. V01 measured and wrote down; it did not build. Every video claim
in these documents is a target, not an implementation.

## Next

**V02 — stop all new still-image capture.** Independent of everything else and
first in order, because it stops data being collected that the product has
decided not to keep. It stops new capture only; historical screenshots are
inventoried and left untouched until an explicit decision (V12).
