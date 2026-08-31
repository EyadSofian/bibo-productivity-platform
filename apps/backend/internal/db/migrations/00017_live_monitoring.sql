-- +goose Up
-- Track a continuous connected session and one-shot live frame requests. The
-- desktop still enforces consent, schedules, permissions and sensitive-app skips.

ALTER TABLE devices ADD COLUMN session_started_at timestamptz;
UPDATE devices
   SET session_started_at = presence_seen_at
 WHERE presence_seen_at IS NOT NULL;

ALTER TABLE devices ADD COLUMN live_capture_requested_at timestamptz;
ALTER TABLE devices ADD COLUMN live_capture_served_at timestamptz;

-- +goose Down
ALTER TABLE devices DROP COLUMN live_capture_served_at;
ALTER TABLE devices DROP COLUMN live_capture_requested_at;
ALTER TABLE devices DROP COLUMN session_started_at;
