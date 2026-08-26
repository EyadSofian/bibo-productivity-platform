#!/bin/sh
set -eu

storage_dir="${STORAGE_DIR:-/app/storage}"
log_dir="${LOG_DIR:-/app/logs}"

# Railway mounts volumes as root. Prepare their writable directories before the
# API is started as the unprivileged app user.
mkdir -p "$storage_dir/screenshots" "$log_dir"
chown -R app:app "$storage_dir" "$log_dir"

exec su-exec app:app /app/server
