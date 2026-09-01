# V04 — Windows Baseline Results

- **Date:** 2026-09-01
- **Machine:** `LAPTOP-K8QC2FHI`, Windows 11 Home Single Language 10.0.26200
- **Repo:** `EyadSofian/bibo-productivity-platform`
- **Base commit:** `96332fa` — *feat: apply Engosoft workforce identity*
- **Branch:** `feat/video-first-media-windows`

## 0. Correction — the first baseline was run against the wrong repository

An earlier pass in this session baselined `ngnclht1102/bibo-emplooyee-tracking`, which is
the **stale upstream**: `EyadSofian/bibo-productivity-platform` is **51 commits ahead of
it and 0 behind**. Every conclusion drawn from that pass was wrong in the same direction —
it reported no CI, no JS tests, no live view and thin Go coverage, none of which is true
of the real codebase. That baseline is superseded by this document.

The upstream is retained as the `origin` remote; the real codebase is `mine`.
Note that `origin` is **not writable** by this account:

```
remote: Permission to ngnclht1102/bibo-emplooyee-tracking.git denied to EyadSofian.
```

## 1. Toolchain

| Tool | Version | Note |
| --- | --- | --- |
| git | 2.53.0.windows.2 | pre-existing |
| **node** | **v25.1.0** | ⚠️ **CI uses Node 22** — see §3.1 |
| pnpm | 10.30.1 | installed (`packageManager` pin) |
| Go | go1.26.5 windows/amd64 | installed; `go.mod` requires 1.26 |
| rustc / cargo | 1.98.0 `stable-x86_64-pc-windows-msvc` | installed |
| rustfmt / clippy | present | |
| CMake | 4.4.3 | installed |
| Docker | 29.3.1 | pre-existing |
| WebView2 | 150.0.4078.105 | pre-existing |
| **VS Build Tools 2022** | 17.14, `isComplete=1` | MSVC 14.44.35207 |
| **Windows SDK** | **10.0.26100.0** | `um\x64\kernel32.Lib` present |

`corepack` is **not bundled in Node 25**, so the documented
`corepack prepare pnpm@10.30.1` is not runnable; pnpm was installed globally at the
version pinned in `packageManager`.

### C toolchain — resolved

The Build Tools install initially landed **incomplete** (`isComplete=0`, MSVC present but
no Windows SDK). Two symptoms, one cause:

- plain `rustc` → `linker link.exe not found` — Rust queries vswhere, which **skips
  instances with `isComplete=0`**, so it could not see a linker that was on disk;
- `rustc` under `vcvars64.bat` → `LNK1181: cannot open input file 'kernel32.lib'` — the
  linker ran, and the Windows SDK import libraries were genuinely absent.

After the SDK completed, the probe passes with **no** `vcvars64` and the binary runs:

```
rustc probe.rs -o probe_final.exe   → exit 0
./probe_final.exe                   → ok
```

## 2. Test results

Run from repo root on `96332fa`.

All JS commands are run under **Node 22** (see §3.1).

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | ✅ 90 packages, 10.2s |
| `node .github/scripts/check-no-still-capture.mjs` | 0 | ✅ green, 10 legacy paths pinned |
| `pnpm --filter @ctracking/web-admin typecheck` | 0 | ✅ `tsc --noEmit` clean |
| `pnpm --filter @ctracking/web-admin test` | 0 | ✅ **192 passed (17 files)**, 22.13s |
| `pnpm --filter @ctracking/web-admin build` | 0 | ✅ 7.72s |
| `pnpm --filter @ctracking/extension test` | 0 | ✅ **63 passed (4 files)**, 1.98s |
| `go build ./...` | 0 | ✅ |
| `go vet ./...` | 0 | ✅ |
| `go test ./...` | 0 | ✅ auth, handlers, live, middleware, obs, store |
| `go test -race ./...` | 0 | ✅ all packages, after installing mingw-w64 — §3.2 |
| `cargo check --all-targets` | 0 | ✅ 7m 35s |
| `cargo fmt --check` | 0 | ✅ |
| `cargo clippy --all-targets` | 0 | ✅ 1 advisory warning (`items_after_test_module`); CI treats clippy as advisory |
| `cargo test` | 0 | ✅ **83 passed, 0 failed, 4 ignored**, 4.50s |

### Go — full pass

```
ok  ctracking/backend/internal/auth        2.963s
ok  ctracking/backend/internal/handlers    4.203s
ok  ctracking/backend/internal/live        1.721s
ok  ctracking/backend/internal/middleware  2.082s
ok  ctracking/backend/internal/obs         (cached)
ok  ctracking/backend/internal/store       1.800s
```

## 3. Root causes found and fixed

### 3.1 The 26 JS failures were a Node version mismatch, not repo bugs — resolved

Every failure across the 4 failing files carries the identical error:

```
TypeError: localStorage.clear is not a function
```

Affected: `src/api/tokenStore.test.ts` (5), `src/api/client.test.ts` (5),
`src/api/liveFrames.test.ts` (13), `src/components/ProtectedRoute.test.tsx` (3).
All four call `localStorage.clear()` in `beforeEach`.

Cause, measured on this machine:

```
$ node -e "console.log(typeof globalThis.localStorage, typeof globalThis.localStorage?.clear)"
object undefined
(node:45336) Warning: `--localstorage-file` was provided without a valid path
```

**Node 25 ships a built-in global `localStorage`** (SQLite-backed Web Storage) whose
`clear` is unavailable without `--localstorage-file`. That global **shadows the one jsdom
installs**, so the `environment: "jsdom"` tests get Node's object instead of jsdom's.

`.github/workflows/ci.yml` pins **`node-version: 22`** in all three jobs, which has no
built-in `localStorage` — which is why CI is green and this machine is not.

**No application code is at fault and none was changed.**

The deeper cause was that **nothing in the repo declared a Node version** — `node-version:
22` was duplicated across three CI jobs and no local tool could read it. Fixed by adding
`.node-version` and pointing all three `actions/setup-node` steps at
`node-version-file: .node-version`, so CI and developer machines share one source of truth.

Locally, Node 22.23.2 is installed through **fnm** rather than replacing Node 25
system-wide, because other projects on this machine use the newer runtime. Verified:

```
$ node --version                      → v22.23.2
$ node -e "typeof globalThis.localStorage"  → undefined
$ pnpm --filter @ctracking/web-admin test   → 192 passed (17 files), exit 0
```

### 3.2 `go test -race` needs a GCC toolchain, which MSVC does not provide

```
$ go env CC          → gcc
$ where gcc          → not found
$ go test -race ./... → FAIL [build failed]
```

Go's race detector requires cgo, and cgo on Windows requires a **GCC-compatible**
compiler (mingw-w64); the MSVC toolchain installed for Rust does not satisfy it.

This is **not a CI gate on Windows**: `.github/workflows/ci.yml` runs the Go backend job —
including `go test -race ./...` — on `ubuntu-latest`, where GCC is present by default.
The Windows matrix only covers the Rust desktop job.

Local `-race` is still worth having for the concurrent media work ahead (`live.Hub`,
`CommandBus`, the WebRTC plane), so **mingw-w64 GCC 14.2.0 (UCRT) was installed**.
`go test -race ./...` now passes on Windows:

```
ok  internal/auth 2.783s   ok  internal/handlers 4.339s   ok  internal/live 2.268s
ok  internal/middleware 2.301s   ok  internal/obs 4.619s   ok  internal/store 2.267s
```

## 4. Still-capture guard (ticket 144)

`.github/scripts/check-no-still-capture.mjs` is added by this branch. It fails CI on
*new* still capture while pinning pre-existing offenders, so the allowlist doubles as the
migration checklist. It is deliberately narrow — an earlier draft matched log tags
(`log_warn!("screenshot", …)`) and UI labels and was tightened until it produced zero
false positives on this tree.

Rules: `image-encode`, `canvas-frame-grab`, `still-api-contract`, `image-in-media-path`,
`still-object-key`, `sse-image-stream`, `data-uri-image`, `image-frame-contract`,
`img-frame-render`.

Pinned legacy — **this is the V04→V09 work list**:

| Path | Rule | Replaced by |
| --- | --- | --- |
| `desktop/src-tauri/src/trackers/mod.rs` | image-encode | media sidecar (V04) |
| `desktop/src-tauri/src/sync/client.rs` | image-frame-contract | SFU publish (V04) |
| `backend/internal/handlers/live_view.go` | image-frame-contract | WebRTC plane (V05/V06) |
| `backend/internal/handlers/remote_assist.go` | image-frame-contract | track + DataChannel (V07) |
| `backend/internal/db/migrations/00018_remote_assist.sql` | image-frame-contract | table already empty per ADR 0001 |
| `backend/internal/handlers/reports.go` | image-frame-contract | HLS moments (V09) |
| `backend/internal/filestore/filestore.go` | still-object-key | segment storage (V08) |
| `web-admin/src/pages/EmployeeDetail.tsx` | data-uri-image, img-frame-render | LivePlayer `<video>` (V06) |
| `web-admin/src/components/reports/PlaybackPanel.tsx` | img-frame-render | Session Player (V09) |
| `scripts/measure-live-frame-cost.go` | image-frame-contract | retired with the frame path |

## 5. Prior art that changes the plan

`docs/adr/0001-ephemeral-live-frames.md` (Accepted, 2026-08-31) already moved live frames
out of Postgres into an in-process hub pushed over SSE, and **explicitly names WebRTC as
the P08 target**, deferred only because it "needs signalling, STUN/TURN infrastructure,
and a Rust media pipeline — none of which can be verified without a Windows device."

That device now exists and its toolchain is working. The video-first plane is therefore
the **already-designed successor** to ADR 0001, not a change of direction. ADR 0001 also
records three still-open items that V04 must close: real-device first-frame time, agent
CPU at capture rate, and the absent on-screen indicator during live view.

## 6. Baseline verdict

**Fully green on Windows.**

```
guard         ✅   web-admin test  ✅ 192    extension test ✅ 63
typecheck     ✅   web-admin build ✅        go build/vet/test ✅
cargo check   ✅   cargo fmt ✅  clippy ✅   cargo test ✅ 83
go test -race ✅
```

## 7. Known limitations

- `cargo clippy` carries one advisory warning, unchanged from the base commit.
- The desktop agent has been compiled and unit-tested on Windows but **not run**; ADR 0001's
  three open items (real-device first-frame time, agent CPU at capture rate, the missing
  on-screen indicator during live view) are still open and are V04 acceptance criteria.
- No LiveKit, media sidecar, or performance evidence — that work has not started.
