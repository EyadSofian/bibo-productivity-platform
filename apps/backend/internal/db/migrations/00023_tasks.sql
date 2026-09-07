-- +goose Up
-- Tasks are the unit of work; work sessions are the measured intervals that
-- connect an assignment to activity, browser and recorded-video evidence.

CREATE TABLE tasks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    assignee_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
    description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 5000),
    work_type         text NOT NULL DEFAULT 'general' CHECK (char_length(work_type) BETWEEN 1 AND 80),
    status            text NOT NULL DEFAULT 'assigned'
                      CHECK (status IN ('assigned','in_progress','paused','completed','cancelled')),
    priority          text NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low','normal','high','urgent')),
    estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
    due_at            timestamptz,
    started_at        timestamptz,
    completed_at      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tasks_completion_time CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX idx_tasks_business_status ON tasks (business_id, status, updated_at DESC);
CREATE INDEX idx_tasks_assignee_status ON tasks (assignee_user_id, status, updated_at DESC);
CREATE INDEX idx_tasks_baseline ON tasks (business_id, work_type, status, completed_at);

CREATE TABLE task_work_sessions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
    started_at       timestamptz NOT NULL DEFAULT now(),
    ended_at         timestamptz,
    end_reason       text CHECK (end_reason IS NULL OR end_reason IN ('paused','completed','cancelled','switched')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX idx_task_work_sessions_task ON task_work_sessions (task_id, started_at);
CREATE INDEX idx_task_work_sessions_employee ON task_work_sessions (employee_user_id, started_at DESC);
CREATE UNIQUE INDEX idx_task_work_sessions_one_active_employee
    ON task_work_sessions (employee_user_id) WHERE ended_at IS NULL;

CREATE TABLE task_events (
    id          bigserial PRIMARY KEY,
    task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    event_type  text NOT NULL CHECK (event_type IN ('created','updated','started','paused','completed','cancelled')),
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_events_task ON task_events (task_id, occurred_at);

ALTER TABLE media_sessions
    ADD COLUMN work_session_id uuid REFERENCES task_work_sessions(id) ON DELETE SET NULL;
CREATE INDEX idx_media_sessions_work_session ON media_sessions (work_session_id, started_at);

-- +goose Down
DROP INDEX idx_media_sessions_work_session;
ALTER TABLE media_sessions DROP COLUMN work_session_id;
DROP TABLE task_events;
DROP TABLE task_work_sessions;
DROP TABLE tasks;
