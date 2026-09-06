-- +goose Up
-- Recorded screen video metadata. Video bytes stay in private object storage.
CREATE TABLE recording_assets (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    media_session_id      uuid NOT NULL UNIQUE REFERENCES media_sessions(id) ON DELETE CASCADE,
    status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','recording','processing','ready','failed','deleted')),
    format                text NOT NULL DEFAULT 'mp4' CHECK (format IN ('mp4','hls','fmp4','webm')),
    storage_provider      text NOT NULL,
    manifest_key          text NOT NULL UNIQUE,
    provider_recording_id text,
    duration_ms           bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    byte_size             bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
    sha256                text,
    started_at            timestamptz NOT NULL DEFAULT now(),
    ended_at              timestamptz,
    retention_until       timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recording_assets_employee_time
    ON recording_assets (business_id, started_at DESC);
CREATE INDEX idx_recording_assets_retention
    ON recording_assets (retention_until)
    WHERE status IN ('ready','failed');

CREATE TABLE recording_gaps (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    recording_asset_id uuid NOT NULL REFERENCES recording_assets(id) ON DELETE CASCADE,
    reason             text NOT NULL CHECK (reason IN (
                         'offline','locked','outside_schedule','privacy_blackout',
                         'capture_error','network_unavailable','recorder_error')),
    started_at         timestamptz NOT NULL,
    ended_at           timestamptz NOT NULL,
    CHECK (ended_at > started_at)
);

CREATE INDEX idx_recording_gaps_asset
    ON recording_gaps (recording_asset_id, started_at);

-- +goose Down
DROP TABLE recording_gaps;
DROP TABLE recording_assets;
