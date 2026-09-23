-- +goose Up
-- Video objects expire after 30 days. Metadata stays for diagnostics and audit.
UPDATE recording_assets
   SET retention_until = COALESCE(ended_at, started_at) + interval '30 days'
 WHERE retention_until IS NULL AND status IN ('ready', 'failed');

ALTER TABLE recording_assets ADD COLUMN last_checked_at timestamptz;

CREATE INDEX idx_recording_assets_recovery
    ON recording_assets (last_checked_at NULLS FIRST)
    WHERE status IN ('pending', 'recording', 'processing');

CREATE INDEX idx_media_sessions_open_recording_age
    ON media_sessions (started_at)
    WHERE kind='recording' AND state NOT IN ('ended','failed');

-- +goose Down
DROP INDEX idx_media_sessions_open_recording_age;
DROP INDEX idx_recording_assets_recovery;
ALTER TABLE recording_assets DROP COLUMN last_checked_at;
-- Preserve any retention dates already applied to user recordings.
