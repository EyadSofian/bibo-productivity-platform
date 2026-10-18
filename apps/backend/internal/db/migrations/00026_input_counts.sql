-- +goose Up
-- Mouse counts next to the keystroke count in each one-minute bucket. Counts
-- only: no key, pointer position or target window is ever stored. Existing rows
-- predate mouse counting, so 0 is their true value, not a guess.
ALTER TABLE keystroke_buckets ADD COLUMN clicks   integer NOT NULL DEFAULT 0;
ALTER TABLE keystroke_buckets ADD COLUMN scrolls  integer NOT NULL DEFAULT 0;
ALTER TABLE keystroke_buckets ADD COLUMN mouse_px bigint  NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE keystroke_buckets DROP COLUMN mouse_px;
ALTER TABLE keystroke_buckets DROP COLUMN scrolls;
ALTER TABLE keystroke_buckets DROP COLUMN clicks;
