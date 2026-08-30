-- +goose Up
-- Near-real-time device presence (F16 foundation). The desktop refreshes these
-- fields every 30 seconds, independently of the five-minute telemetry sync, so
-- the dashboard can answer "what is open now?" without pretending historical
-- samples are live.

ALTER TABLE devices ADD COLUMN presence_state text
    CHECK (presence_state IN ('online', 'active', 'idle'));
ALTER TABLE devices ADD COLUMN current_app text
    CHECK (current_app IS NULL OR char_length(current_app) <= 255);
ALTER TABLE devices ADD COLUMN current_window_title text
    CHECK (current_window_title IS NULL OR char_length(current_window_title) <= 1000);
ALTER TABLE devices ADD COLUMN presence_since bigint;
ALTER TABLE devices ADD COLUMN presence_seen_at timestamptz;

CREATE INDEX idx_devices_presence_employee
    ON devices(user_id, presence_seen_at DESC)
    WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX idx_devices_presence_employee;
ALTER TABLE devices DROP COLUMN presence_seen_at;
ALTER TABLE devices DROP COLUMN presence_since;
ALTER TABLE devices DROP COLUMN current_window_title;
ALTER TABLE devices DROP COLUMN current_app;
ALTER TABLE devices DROP COLUMN presence_state;
