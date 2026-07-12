# 140 — bibomon: replace the Grafana stack with our own monitoring

**Date:** 2026-07-05 · **Status: Done** (verified end-to-end) · Supersedes the ticket 138
stack (Grafana/Prometheus/Loki/Alloy — removed from both boxes).

## Why

The ticket-138 stack worked but was heavyweight: ~2.9 GB of binaries/data on the mac, four
daemons plus Grafana's YAML/LogQL provisioning gotchas, all to answer five questions. This
ticket replaces it with **bibomon** — one small self-built Go binary (~9 MB) covering
exactly what we need: VPS usage, service states, per-service API fail rate + latency,
filterable logs, and Telegram alerts. Same topology as before: agent on Oracle pushes to
the mac over the existing SSH reverse tunnel; the mac serves the dashboard at
https://monitor.namnguyen.pro (login `admin`, same password as the old Grafana).

## Architecture

```
monitor.namnguyen.pro ── cloudflared mac-vps tunnel (route unchanged: localhost:3200)
┌─ mac VPS ─────────────────────────────────────────────────────────────────────┐
│ bibomon SERVER (launchd pro.namnguyen.monitor.bibomon, :3200)                 │
│   SQLite ~/monitoring/data/bibomon.db (WAL; logs/metrics 30d, raw reqs 48h,   │
│   per-minute rollups 30d)                                                     │
│   + local collector: mac host metrics, staging healthz, staging log tail     │
│   + prober: 6 public endpoints every 30s                                     │
│   + alert engine (30s) → Telegram @biboinfra_bot                              │
│   sshtunnel agent (kept, repointed): -R 127.0.0.1:9091 → 127.0.0.1:3200      │
└───────────────────────────────────────────────────────────────────────────────┘
┌─ Oracle A1 (PROD) ────────────────────────────────────────────────────────────┐
│ bibomon AGENT (systemd bibomon-agent, runs as opc, ZERO listening ports)     │
│   15s: gopsutil host metrics + `systemctl is-active` for 9 units             │
│   journald tail (json + persisted cursor) → gin/logfmt parsed into request   │
│   events (status, latency, path) + raw log lines                             │
│   POST → http://127.0.0.1:9091/ingest (token header); disk spool on failure  │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Code & deploy

- Source: `apps/monitor` (Go module `ctracking/monitor`, pure-Go: modernc sqlite,
  gopsutil, BurntSushi/toml, vendored uPlot). One binary, `bibomon agent|server`.
- Dashboard: embedded static HTML/JS (go:embed), Basic auth, tabs **Overview**
  (alerts, endpoint UP/DOWN + 24h uptime, service states, host CPU/mem/disk + charts),
  **API** (per service: req/min total/4xx/5xx, fail rate, avg+p95 latency —
  `/v1/keepalive` excluded from latency), **Logs** (service/level/text filters, load-older).
- Deploy: `deploy/deploy-monitor.sh` (idempotent; builds darwin-amd64 + linux-arm64,
  installs launchd/systemd units, repoints the tunnel). Secrets never leave the boxes:
  dashboard pw = old Grafana admin pw (grafana.ini), Telegram token lifted from the old
  provisioning YAML, ingest token generated once into `~/monitoring/etc/bibomon.token`.
- Config: real files `~/monitoring/etc/bibomon.toml` (mac) and `/opt/bibomon/agent.toml`
  (Oracle); templates in `apps/monitor/config/`.

## Alerts (same Telegram bot/chat as 138)

| Rule | Condition | Hold |
|---|---|---|
| Endpoint DOWN | latest probe failed (6 public URLs) | 2m |
| Prod box unreachable | no agent data for >3m (NoData) | 0 |
| Service down | latest unit state ≠ active (fresh data only) | 2m |
| Disk >80% / Mem >90% / CPU >90% | latest sample, either host | 10m |
| API fail rate | per service: >3 5xx in 5m, or >10% 5xx with ≥20 reqs | 0 |
| Keepalive broken | no `/v1/keepalive` 200 in 20m (the 2026-07-03 class) | 0 |

Firing → 🔥 message, recovery → ✅. 5-minute startup grace so restarts don't fire the
NoData rules spuriously.

## Verified 2026-07-05

- Parser unit tests against real journald lines (gin durations incl. µs, logfmt).
- Local smoke: ingest auth (200/401), overview/logs/rollup APIs, rollup math (keepalive
  excluded from avg/p95, status classes counted), dashboard rendered in Chrome.
- Live: both hosts + 10 units + 6 probes green on monitor.namnguyen.pro; rollups for
  bibotracking, biboreward, bibotracking-staging; log filter over live prod lines.
- Alert drill: synthetic failing unit ingested → 🔥 FIRING after 2m hold → ✅ RESOLVED
  (full ingest→engine→Telegram path).

## Gotchas

1. **SELinux on Oracle Linux**: a binary `mv`'d from /tmp keeps `user_tmp_t` and systemd
   gets 203/EXEC Permission denied → `restorecon -R /opt/bibomon` (now in deploy script).
2. Rollup watermark rewinds when late/spooled batches arrive (INSERT OR REPLACE makes
   re-rolling idempotent) — otherwise post-outage minutes never chart.
3. macOS disk usage must be read from `/System/Volumes/Data`, not the sealed `/`.
4. Port 3200 was reused from Grafana so the root-owned `/etc/cloudflared/config.yml`
   (no sudo for namng) needed no change.

## Cleanup performed

- mac: booted out + deleted launchd plists `pro.namnguyen.monitor.{grafana,prometheus,loki,alloy}`;
  deleted `~/monitoring/{bin,grafana,dl,etc/{alloy.river,loki.yml,prometheus.yml},data}` old
  Grafana/Prom/Loki data (~2.9 GB freed). Kept: sshtunnel agent (repointed), bibomon files.
- Oracle: `systemctl disable --now alloy`, `dnf remove alloy`, removed `/etc/alloy`,
  `/etc/sysconfig/alloy`.

## Operate

```bash
# mac server
launchctl kickstart -k gui/$(id -u)/pro.namnguyen.monitor.bibomon
tail -f ~/monitoring/logs/bibomon.err.log
# Oracle agent
sudo systemctl restart bibomon-agent && journalctl -u bibomon-agent -f
# redeploy after code changes
deploy/deploy-monitor.sh
```
