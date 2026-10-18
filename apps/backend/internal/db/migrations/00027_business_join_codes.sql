-- +goose Up
-- A high entropy invite code lets an employee join immediately without giving
-- every visitor to the public business picker access to a company's roster.
ALTER TABLE businesses ADD COLUMN join_code uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX businesses_join_code_unique ON businesses (join_code);

-- +goose Down
DROP INDEX businesses_join_code_unique;
ALTER TABLE businesses DROP COLUMN join_code;
