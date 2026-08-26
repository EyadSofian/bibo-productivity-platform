-- +goose Up
-- F41: named, inheritable capture profiles with a schedule per tracking key.

CREATE TABLE monitoring_profiles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    parent_id   uuid REFERENCES monitoring_profiles(id) ON DELETE SET NULL,
    private     boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, name),
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE monitoring_profile_details (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id     uuid NOT NULL REFERENCES monitoring_profiles(id) ON DELETE CASCADE,
    tracking_key   text NOT NULL,
    tracking_val   jsonb NOT NULL,
    days_of_week   smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
    start_minute   integer NOT NULL DEFAULT 0 CHECK (start_minute BETWEEN 0 AND 1439),
    end_minute     integer NOT NULL DEFAULT 1440 CHECK (end_minute BETWEEN 1 AND 1440),
    timezone       text NOT NULL DEFAULT 'UTC',
    UNIQUE (profile_id, tracking_key),
    CHECK (tracking_key ~ '^[a-z][a-z0-9_.-]{0,79}$'),
    CHECK (cardinality(days_of_week) BETWEEN 1 AND 7),
    CHECK (days_of_week <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);

CREATE TABLE monitoring_profile_assignments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id  uuid NOT NULL REFERENCES monitoring_profiles(id) ON DELETE CASCADE,
    scope_type  text NOT NULL CHECK (scope_type IN ('business','employee','device','department','directory_group')),
    scope_id    uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope_type, scope_id)
);

CREATE INDEX idx_monitoring_profiles_business ON monitoring_profiles(business_id);
CREATE INDEX idx_monitoring_assignments_scope ON monitoring_profile_assignments(scope_type, scope_id);

-- +goose Down
DROP TABLE monitoring_profile_assignments;
DROP TABLE monitoring_profile_details;
DROP TABLE monitoring_profiles;
