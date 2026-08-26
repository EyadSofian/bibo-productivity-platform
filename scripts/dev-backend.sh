#!/usr/bin/env bash
# Run the Go backend locally. Migrations run automatically on startup.
# Needs Postgres up first — run scripts/dev-db.sh in another terminal.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/backend"

# Port the rest of local dev expects to find the backend on: the web-admin Vite
# proxy (apps/web-admin/vite.config.ts) and the desktop's local default
# (src-tauri/src/settings/mod.rs) both target this.
EXPECTED_PORT=8090

# Seed a local .env from the example on first run (loaded by godotenv).
if [[ ! -f .env ]]; then
  echo "→ creating apps/backend/.env from .env.example"
  cp .env.example .env
fi

# Announce the port actually configured, not a hard-coded one — a stale .env used
# to leave this message claiming :8090 while the backend bound :8080, so the
# dashboard proxied into a void. Warn instead of silently disagreeing.
PORT="$(sed -n 's/^[[:space:]]*PORT=\([0-9]\{1,5\}\).*/\1/p' .env | tail -n 1)"
if [[ -n "$PORT" ]]; then
  SOURCE="apps/backend/.env sets PORT=$PORT"
else
  PORT=8080          # config.Load()'s fallback when PORT is unset
  SOURCE="apps/backend/.env sets no PORT, so the backend defaults to :$PORT"
fi

if [[ "$PORT" != "$EXPECTED_PORT" ]]; then
  echo "⚠ $SOURCE, but the web-admin proxy and the"
  echo "  desktop app expect :$EXPECTED_PORT — the dashboard will not reach this backend."
  echo "  Fix: set PORT=$EXPECTED_PORT in apps/backend/.env (see .env.example)."
fi

echo "→ backend on http://localhost:$PORT  (Ctrl-C to stop)"
go run ./cmd/server
