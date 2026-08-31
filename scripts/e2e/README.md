# Live-view end-to-end checks

These drive the pushed live-view path against a **running backend**, playing both
sides for real: the agent's command stream and frame upload, and the owner's
frame stream. They exist because the desktop agent's half of this path cannot be
exercised on a machine without a Windows device — but the protocol between agent
and backend can be, and that is where the latency and the authorization live.

They are not part of `go test`: they need a live server and they take ~40s.

## Running them

Start a backend against a scratch database (never a real one — these create
accounts and devices):

```bash
PORT=8099 \
DATABASE_URL='postgres://USER:PASS@localhost:5432/ctracking_test?sslmode=disable' \
JWT_SECRET='local-only-secret-at-least-32-bytes-long' \
STORAGE_DIR=/tmp/e2e-storage \
go run ./cmd/server
```

Then seed the fixtures:

```bash
python3 scripts/e2e/seed-fixtures.py $RANDOM        # owner, business, employee
go run scripts/e2e/seed-membership.go <user_id> <business_id>
```

`seed-fixtures.py` writes ids and tokens to `/tmp/e2e_state.json`, which the
three scripts read. `seed-membership.go` exists because joining a business has
no API route yet; it inserts the row the same way the store tests do.

**Re-seed for every session.** The access tokens in `/tmp/e2e_state.json` expire
after 15 minutes. Reusing a stale file fails with `not a member of that business`
or a 401 — that is expired fixtures, not a regression. Re-run both seed steps.

| Script | What it proves |
|---|---|
| `live-view-path.py` | Opening the player makes the agent start capturing, and an uploaded frame reaches the viewer. |
| `live-view-latency.py` | Measures the push latencies P0-1 is about, and that the path fails closed once nobody is watching. |
| `live-view-tenant-isolation.py` | No cross-tenant access on the new streaming endpoints. |

## Measured on 2026-08-31 (loopback, PostgreSQL 16.9)

| Hop | Before | After |
|---|---|---|
| Owner asks for a frame → agent knows | 0–15 000 ms (heartbeat wait) | **13 ms** |
| Owner opens live view → agent told to capture | n/a (did not exist) | **7 ms** |
| Agent uploads frame → viewer renders it | 0–3 000 ms (discovery poll) | **7 ms** |

Loopback numbers exclude WAN latency and screen-capture time (60–457 ms, audit
§3.2). They bound the *coordination* cost, which is what P0-1 was about.
