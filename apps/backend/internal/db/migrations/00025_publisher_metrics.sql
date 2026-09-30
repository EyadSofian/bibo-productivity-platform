-- +goose Up
-- Keep the latest device-side counters so a live session can be diagnosed when
-- the SFU has a published track but no video reaches its viewers.
ALTER TABLE media_sessions ADD COLUMN publisher_metrics jsonb;
ALTER TABLE media_sessions ADD COLUMN publisher_metrics_at timestamptz;

-- +goose Down
ALTER TABLE media_sessions DROP COLUMN publisher_metrics_at;
ALTER TABLE media_sessions DROP COLUMN publisher_metrics;
