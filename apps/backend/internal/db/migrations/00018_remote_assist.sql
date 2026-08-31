-- +goose Up
-- Device-authorized remote assistance. Authorization is either a per-session
-- decision or a one-time local unattended-support opt-in. Only the newest frame
-- is retained and input actions are short-lived; this is not an activity archive.

CREATE TABLE remote_assist_sessions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','declined','ended','expired')),
    requested_at     timestamptz NOT NULL DEFAULT now(),
    decided_at       timestamptz,
    expires_at       timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
    ended_at         timestamptz,
    end_reason       text,
    last_frame_at    timestamptz
);
CREATE INDEX idx_remote_assist_device_status
    ON remote_assist_sessions(device_id, status, requested_at DESC);

CREATE TABLE remote_assist_frames (
    session_id  uuid PRIMARY KEY REFERENCES remote_assist_sessions(id) ON DELETE CASCADE,
    received_at timestamptz NOT NULL DEFAULT now(),
    width       integer NOT NULL CHECK (width > 0 AND width <= 10000),
    height      integer NOT NULL CHECK (height > 0 AND height <= 10000),
    mime_type   text NOT NULL CHECK (mime_type = 'image/webp'),
    image       bytea NOT NULL
);

CREATE TABLE remote_assist_actions (
    id          bigserial PRIMARY KEY,
    session_id  uuid NOT NULL REFERENCES remote_assist_sessions(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('click','move','key','text')),
    payload     jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz
);
CREATE INDEX idx_remote_assist_actions_pending
    ON remote_assist_actions(session_id, id) WHERE consumed_at IS NULL;

CREATE TABLE remote_assist_audit (
    id            bigserial PRIMARY KEY,
    session_id    uuid NOT NULL REFERENCES remote_assist_sessions(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    event         text NOT NULL,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_remote_assist_audit_session
    ON remote_assist_audit(session_id, created_at);

-- At most one unresolved request/session per machine.
CREATE UNIQUE INDEX idx_remote_assist_one_open_session
    ON remote_assist_sessions(device_id)
    WHERE status IN ('pending','active');

-- +goose Down
DROP INDEX idx_remote_assist_one_open_session;
DROP TABLE remote_assist_audit;
DROP TABLE remote_assist_actions;
DROP TABLE remote_assist_frames;
DROP TABLE remote_assist_sessions;
