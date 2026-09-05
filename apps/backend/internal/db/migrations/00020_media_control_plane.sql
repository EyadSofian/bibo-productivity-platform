-- +goose Up
-- Video-first media control plane (docs/adr/0002-video-first-media-plane.md).
--
-- These tables hold metadata ONLY. Media bytes live in the SFU and, when a policy
-- enables recording, in object storage. Nothing here ever stores a frame, an
-- image, or a video segment -- that is the whole point of the decision these
-- tables implement. A future `frames`, `screenshots_v2`, `thumbnails` or
-- `image_blobs` table is a violation of ADR 0002, not an extension of it.
--
-- Recording assets and gaps are deliberately absent: they arrive with the egress
-- pipeline (slice V08) rather than sitting empty until then.

CREATE TABLE media_sessions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The employee being watched. Nullable because a device can be enrolled
    -- before it is assigned to anyone.
    employee_id      uuid REFERENCES users(id) ON DELETE SET NULL,
    device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind             text NOT NULL CHECK (kind IN ('live','recording','remote_control')),
    -- The full lifecycle from the master prompt's state machine, not a collapsed
    -- summary of it. 'authorizing', 'waiting_for_agent' and 'ending' are what
    -- make a stalled session diagnosable: without them every stall looks
    -- identical to every other stall.
    state            text NOT NULL DEFAULT 'requested'
                     CHECK (state IN ('requested','authorizing','waiting_for_agent',
                                      'negotiating','live','reconnecting','ending',
                                      'ended','failed')),
    provider         text NOT NULL,
    -- Opaque room identifier. It is a random UUID with no relationship to the
    -- employee, the device or the business, so it carries nothing to leak: room
    -- names must never contain an email or a person's name.
    provider_room_id text NOT NULL,
    -- The monitoring policy as it was when this session started. Without it a
    -- historical session cannot be explained -- profiles change, and "which rules
    -- applied at the time" stops being answerable the moment they do.
    policy_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at       timestamptz NOT NULL DEFAULT now(),
    ended_at         timestamptz,
    failure_code     text,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    -- A terminal session has an end time; a live one does not. Enforced here
    -- rather than in application code so no path can leave a session that is
    -- ended-but-open or open-but-ended.
    CONSTRAINT media_sessions_terminal_has_end
        CHECK ((state IN ('ended','failed')) = (ended_at IS NOT NULL)),
    CONSTRAINT media_sessions_failure_code_only_on_failure
        CHECK (failure_code IS NULL OR state = 'failed')
);

CREATE INDEX idx_media_sessions_device
    ON media_sessions(business_id, device_id, started_at DESC);
CREATE INDEX idx_media_sessions_employee
    ON media_sessions(business_id, employee_id, started_at DESC);
-- One open session per device per kind. Two viewers share a session rather than
-- racing to create two, and a stuck session cannot silently accumulate duplicates.
CREATE UNIQUE INDEX idx_media_sessions_one_open_per_device
    ON media_sessions(device_id, kind)
    WHERE state NOT IN ('ended','failed');

CREATE TABLE media_tracks (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    media_session_id uuid NOT NULL REFERENCES media_sessions(id) ON DELETE CASCADE,
    -- One row per published track. Multi-monitor publishes independent tracks
    -- rather than one giant composited bitmap, so the display a viewer picks is
    -- a track selection, not a crop.
    source           text NOT NULL CHECK (source IN ('screen','screen_2','audio')),
    codec            text NOT NULL,
    width            integer CHECK (width IS NULL OR width > 0),
    height           integer CHECK (height IS NULL OR height > 0),
    nominal_fps      numeric CHECK (nominal_fps IS NULL OR nominal_fps > 0),
    started_at       timestamptz NOT NULL DEFAULT now(),
    ended_at         timestamptz,
    -- One row per source per session. A publisher that reconnects re-reports the
    -- same track, and a second row would make one screen look like two displays.
    UNIQUE (media_session_id, source)
);

CREATE INDEX idx_media_tracks_session
    ON media_tracks(business_id, media_session_id, started_at);

CREATE TABLE viewer_sessions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    media_session_id uuid NOT NULL REFERENCES media_sessions(id) ON DELETE CASCADE,
    viewer_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at        timestamptz NOT NULL DEFAULT now(),
    left_at          timestamptz,
    end_reason       text
);

CREATE INDEX idx_viewer_sessions_session
    ON viewer_sessions(business_id, media_session_id, joined_at DESC);
-- "Who is watching right now", and the join that closes a viewer's previous row
-- when they reconnect.
CREATE INDEX idx_viewer_sessions_open
    ON viewer_sessions(media_session_id, viewer_user_id)
    WHERE left_at IS NULL;

CREATE TABLE media_audit_events (
    id               bigserial PRIMARY KEY,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    media_session_id uuid REFERENCES media_sessions(id) ON DELETE SET NULL,
    actor_type       text NOT NULL CHECK (actor_type IN ('user','agent','system')),
    -- Text, not a uuid FK: a system actor is a job name, and an audit row must
    -- survive the deletion of whoever caused it. An audit trail that cascades
    -- away with its subject is not an audit trail.
    actor_id         text NOT NULL,
    action           text NOT NULL,
    outcome          text NOT NULL CHECK (outcome IN ('allowed','denied','error')),
    -- Never a token, an SDP, a signed URL or a credential. Ids, codes, counts.
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_audit_session
    ON media_audit_events(business_id, media_session_id, occurred_at);
-- Denials are the rows a reviewer actually goes looking for, and they are rare
-- enough that a partial index stays small.
CREATE INDEX idx_media_audit_denied
    ON media_audit_events(business_id, occurred_at DESC)
    WHERE outcome = 'denied';

-- +goose Down
DROP TABLE media_audit_events;
DROP TABLE viewer_sessions;
DROP TABLE media_tracks;
DROP TABLE media_sessions;
