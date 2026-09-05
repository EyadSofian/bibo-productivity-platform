-- +goose Up
ALTER TABLE viewer_sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX idx_viewer_sessions_lease ON viewer_sessions(media_session_id, last_seen_at) WHERE left_at IS NULL;

-- +goose Down
DROP INDEX idx_viewer_sessions_lease;
ALTER TABLE viewer_sessions DROP COLUMN last_seen_at;
