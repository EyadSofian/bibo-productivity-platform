-- +goose Up
-- Device inventory & per-machine monitoring control (F40).
--
-- Until now `devices` held only (id, user_id, label, last_seen_at) and existed
-- purely as a sync side-effect. To manage a fleet an owner needs three things
-- the table could not answer: which business a device belongs to (so it can be
-- listed and tenant-scoped), whether monitoring is currently on for it, and
-- enough identity (OS, agent version) to tell two machines apart.
--
-- business_id is denormalized onto the device rather than derived from its
-- activity rows every time: a freshly-registered device has no activity yet but
-- must still appear in the inventory, and per-request derivation could not be
-- indexed. It is set by the sync upsert from the caller's resolved business,
-- never from the client payload — the same trust rule the activity tables use.

ALTER TABLE devices ADD COLUMN business_id uuid REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE devices ADD COLUMN monitoring_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN os text;
ALTER TABLE devices ADD COLUMN agent_version text;
-- When monitoring was turned off, and by whom — a light audit trail until the
-- full audit log (F26) exists. NULL means monitoring is on.
ALTER TABLE devices ADD COLUMN disabled_at timestamptz;
ALTER TABLE devices ADD COLUMN disabled_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Backfill business_id for devices that already have activity, from their most
-- recent activity row. Devices that never synced activity stay NULL until their
-- next sync sets it.
UPDATE devices d
   SET business_id = a.business_id
  FROM (
    SELECT DISTINCT ON (device_id) device_id, business_id
      FROM activity_samples
     ORDER BY device_id, ts DESC
  ) a
 WHERE a.device_id = d.id
   AND d.business_id IS NULL;

CREATE INDEX idx_devices_business ON devices(business_id);

-- +goose Down
DROP INDEX idx_devices_business;
ALTER TABLE devices DROP COLUMN disabled_by;
ALTER TABLE devices DROP COLUMN disabled_at;
ALTER TABLE devices DROP COLUMN agent_version;
ALTER TABLE devices DROP COLUMN os;
ALTER TABLE devices DROP COLUMN monitoring_enabled;
ALTER TABLE devices DROP COLUMN business_id;
