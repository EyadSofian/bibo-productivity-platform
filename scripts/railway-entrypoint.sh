#!/bin/sh
set -eu

storage_dir="${STORAGE_DIR:-/app/storage}"
log_dir="${LOG_DIR:-/app/logs}"

# Railway mounts volumes as root. Prepare their writable directories before the
# API is started as the unprivileged app user.
mkdir -p "$storage_dir/screenshots" "$storage_dir/download" "$log_dir"
chown -R app:app "$storage_dir" "$log_dir"

# Installer binaries are deployment artifacts rather than source files. Keep
# them on the persistent Railway volume and expose that directory through the
# static tree expected by the existing /download/:file handler.
if [ ! -e /app/web/download ]; then
  ln -s "$storage_dir/download" /app/web/download
fi

exec su-exec app:app /app/server
