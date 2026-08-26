-- +goose Up
-- F7: lightweight organizational structure for policy and productivity scopes.

CREATE TABLE departments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_departments_business_name ON departments (business_id, lower(name));
CREATE UNIQUE INDEX uq_departments_business_id_id ON departments (business_id, id);

CREATE TABLE job_roles (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_job_roles_business_name ON job_roles (business_id, lower(name));
CREATE UNIQUE INDEX uq_job_roles_business_id_id ON job_roles (business_id, id);

ALTER TABLE memberships
    ADD COLUMN department_id uuid,
    ADD COLUMN job_role_id uuid,
    ADD CONSTRAINT fk_membership_department_business
        FOREIGN KEY (business_id, department_id) REFERENCES departments(business_id, id),
    ADD CONSTRAINT fk_membership_job_role_business
        FOREIGN KEY (business_id, job_role_id) REFERENCES job_roles(business_id, id);

CREATE INDEX idx_memberships_department ON memberships (business_id, department_id);
CREATE INDEX idx_memberships_job_role ON memberships (business_id, job_role_id);

-- +goose Down
ALTER TABLE memberships
    DROP CONSTRAINT fk_membership_job_role_business,
    DROP CONSTRAINT fk_membership_department_business,
    DROP COLUMN job_role_id,
    DROP COLUMN department_id;
DROP TABLE job_roles;
DROP TABLE departments;
