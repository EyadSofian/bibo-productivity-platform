-- +goose Up
-- Device state timeline (audit finding P0-2).
--
-- `activity_samples` only records *active* foreground intervals, so idle time was
-- the absence of rows — indistinguishable from a shut laptop, a paused agent or a
-- dropped network. That made idle time, total device time and first/last activity
-- impossible to compute, and they are required by the employee profile.
--
-- The agent emits closed, contiguous intervals, so for any window
-- `sum(duration_s)` is the wall-clock time the agent was running. Offline is NOT
-- a stored state: a disconnected agent cannot report its own disconnection, so it
-- is derived from the gaps between intervals at query time.
--
-- `client_uuid` is the natural key, exactly as on the other synced tables, so a
-- re-sent batch upserts instead of duplicating.

CREATE TABLE os_states (
    id                bigserial PRIMARY KEY,
    client_uuid       uuid NOT NULL UNIQUE,
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    device_id         uuid NOT NULL,
    -- 'suspended' covers sleep, hibernate and the agent being stopped: the agent
    -- can tell that time passed without it, but not why.
    state             text NOT NULL CHECK (state IN ('active','idle','suspended')),
    ts                bigint NOT NULL,
    duration_s        integer NOT NULL CHECK (duration_s > 0),
    client_updated_at bigint NOT NULL,
    received_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_os_states_user_ts ON os_states(user_id, ts);
CREATE INDEX idx_os_states_biz_ts ON os_states(business_id, ts);

-- +goose Down
DROP TABLE os_states;
