-- +goose Up
-- Latest device-health snapshot sent with the 30-second presence heartbeat.
-- These are current machine totals/rates, not process contents or file data.

ALTER TABLE devices ADD COLUMN resource_cpu_pct real
    CHECK (resource_cpu_pct IS NULL OR (resource_cpu_pct >= 0 AND resource_cpu_pct <= 100));
ALTER TABLE devices ADD COLUMN resource_memory_used_bytes bigint
    CHECK (resource_memory_used_bytes IS NULL OR resource_memory_used_bytes >= 0);
ALTER TABLE devices ADD COLUMN resource_memory_total_bytes bigint
    CHECK (resource_memory_total_bytes IS NULL OR resource_memory_total_bytes >= 0),
    ADD CONSTRAINT device_resource_memory_bounds
    CHECK (resource_memory_used_bytes IS NULL OR resource_memory_total_bytes IS NULL
        OR resource_memory_used_bytes <= resource_memory_total_bytes);
ALTER TABLE devices ADD COLUMN resource_disk_used_bytes bigint
    CHECK (resource_disk_used_bytes IS NULL OR resource_disk_used_bytes >= 0);
ALTER TABLE devices ADD COLUMN resource_disk_total_bytes bigint
    CHECK (resource_disk_total_bytes IS NULL OR resource_disk_total_bytes >= 0),
    ADD CONSTRAINT device_resource_disk_bounds
    CHECK (resource_disk_used_bytes IS NULL OR resource_disk_total_bytes IS NULL
        OR resource_disk_used_bytes <= resource_disk_total_bytes);
ALTER TABLE devices ADD COLUMN resource_network_rx_bps bigint
    CHECK (resource_network_rx_bps IS NULL OR resource_network_rx_bps >= 0);
ALTER TABLE devices ADD COLUMN resource_network_tx_bps bigint
    CHECK (resource_network_tx_bps IS NULL OR resource_network_tx_bps >= 0);
ALTER TABLE devices ADD COLUMN resource_seen_at timestamptz;

-- +goose Down
ALTER TABLE devices DROP COLUMN resource_seen_at;
ALTER TABLE devices DROP COLUMN resource_network_tx_bps;
ALTER TABLE devices DROP COLUMN resource_network_rx_bps;
ALTER TABLE devices DROP COLUMN resource_disk_total_bytes;
ALTER TABLE devices DROP COLUMN resource_disk_used_bytes;
ALTER TABLE devices DROP COLUMN resource_memory_total_bytes;
ALTER TABLE devices DROP COLUMN resource_memory_used_bytes;
ALTER TABLE devices DROP COLUMN resource_cpu_pct;
