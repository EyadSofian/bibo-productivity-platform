-- +goose Up
-- Recoverable fleet removal for F40. Archiving is deliberately separate from
-- pausing monitoring: it removes a retired machine from the active inventory,
-- while preserving its historical activity and allowing an owner to restore it.

ALTER TABLE devices ADD COLUMN deleted_at timestamptz;
ALTER TABLE devices ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_devices_business_active
    ON devices(business_id, last_seen_at DESC)
    WHERE deleted_at IS NULL;

-- +goose Down
DROP INDEX idx_devices_business_active;
ALTER TABLE devices DROP COLUMN deleted_by;
ALTER TABLE devices DROP COLUMN deleted_at;
