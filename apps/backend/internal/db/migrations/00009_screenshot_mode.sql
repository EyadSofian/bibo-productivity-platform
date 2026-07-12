-- +goose Up
-- Screenshot capture mode + privacy skip-list (ticket 141), org-controlled like the
-- rest of the capture policy. mode: 'privacy' (frontmost window only — the default)
-- or 'normal' (one shot per display). skip_apps: app names for which the capture
-- tick is skipped entirely while that app is frontmost (applies in both modes);
-- prefilled with the curated sensitive-app rules on business creation (Go side).
ALTER TABLE businesses ADD COLUMN screenshot_mode text NOT NULL DEFAULT 'privacy';
ALTER TABLE businesses ADD COLUMN screenshot_skip_apps text[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE businesses DROP COLUMN screenshot_skip_apps;
ALTER TABLE businesses DROP COLUMN screenshot_mode;
