# 138 — Infra monitoring: Grafana dashboard + Telegram alerts (both VPS boxes)

**Date:** 2026-07-04 · **Status: SUPERSEDED by ticket 140 (bibomon)** — this Grafana/
Prometheus/Loki/Alloy stack was removed from both boxes on 2026-07-05; kept for reference.

## Why

On 2026-07-03 a prod deploy built from a stale feature branch shipped without the
`/v1/keepalive` endpoint — the external monitor 404'd silently for ~2h and nothing told
anyone (Oracle idle-reclaim protection was off). We had no view of server load, request
success/error rates, or logs without SSHing in. This ticket adds a proper monitoring stack
with push alerts, covering **BiBoTracking (prod + staging) and BiBoReward**.

## Architecture

```
             https://monitor.namnguyen.pro  (Grafana login: admin / see grafana.ini)
                          │ Cloudflare tunnel (mac-vps)
┌─ mac VPS (namng@ssh.namnguyen.pro, Intel, macOS 13) ────────────────────────────┐
│  Grafana :3200 ── Prometheus :9090 (30d, remote-write receiver)                 │
│                └─ Loki :3100 (30d retention)                                    │
│  Alloy :12345 — mac host metrics, staging log files (~/ctracking/logs/*.log),   │
│                 blackbox HTTP probes of ALL public endpoints                    │
│  sshtunnel agent: ssh -N -R 127.0.0.1:9091→9090 -R 127.0.0.1:3101→3100 opc@oracle│
└──────────────────────────────────────────────────────────────────────────────────┘
                          │ (outbound SSH from mac; loopback-bound on Oracle)
┌─ Oracle A1 (opc@161.118.200.227, PROD) ──────────────────────────────────────────┐
│  Alloy (dnf pkg, /etc/alloy/config.alloy, HTTP 127.0.0.1:12345):                 │
│    host metrics + systemd unit states + journald logs                           │
│    (bibotracking, biboreward{,-web,-marketing}, cloudflared)                    │
│    → pushes to 127.0.0.1:9091 / :3101   →   ZERO new listening ports            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Key property: **monitoring lives OFF the prod box** — if Oracle dies or is reclaimed, the
mac still alerts (blackbox probes + Prometheus staleness → NoData alerts). Oracle keeps
zero open ports (verified: only :22 answers externally; firewalld allows only ssh, OCI
security list blocks the rest — note the Go services actually bind 0.0.0.0:8080-8083,
they're just double-firewalled).

## Components & paths

| Where | What | Path |
|---|---|---|
| mac | Grafana 12.3.1, Prometheus 3.13, Loki 3.7.3, Alloy 1.17.1 (official darwin-amd64 binaries — **brew unusable on macOS 13**, no bottles) | `~/monitoring/{bin,grafana,etc,data,logs}` |
| mac | launchd agents (KeepAlive) | `~/Library/LaunchAgents/pro.namnguyen.monitor.{grafana,prometheus,loki,alloy,sshtunnel}.plist` |
| mac | Grafana provisioning (datasources, dashboards, alerting) | `~/monitoring/etc/grafana/provisioning/` |
| mac | Dashboards JSON | `~/monitoring/etc/grafana/dashboards/dash-{vps,api,logs}.json` |
| Oracle | Alloy config / port override | `/etc/alloy/config.alloy`, `/etc/sysconfig/alloy` |
| Oracle | mac's pubkey authorized for the reverse tunnel | `~opc/.ssh/authorized_keys` (key `macvps-bibo-backup`) |

## Dashboards (folder "BiBo")

- **VPS Overview** — endpoint UP/DOWN (blackbox), Oracle systemd states, CPU/RAM/disk/load
  both hosts, network I/O, probe latency.
- **API Health** — req/min by status class, error counts, p95 latency (gin lines parsed with
  LogQL `pattern`, biboreward slog via `logfmt`), keepalive-200 tracker. p95 **excludes
  `/v1/keepalive`** (intentional 120s requests would poison it).
- **Log Explorer** — unit selector + free-text search over all prod services + staging.

## Alerts → Telegram @biboinfra_bot (chat 462097600)

| Rule | Condition | For |
|---|---|---|
| Public endpoint DOWN | any `probe_success < 1` (bibotracker.com, api/app/marketing biboreward, staging) | 2m |
| Oracle service not active | `node_systemd_unit_state{state="active"} < 1`; **NoData⇒Alerting** doubles as "box unreachable" | 2m |
| Disk > 80% / Mem > 90% | either host | 10m |
| Keepalive broken | no keepalive-200 log line in 20m (**NoData⇒Alerting**) — catches the 2026-07-03 incident class | 5m |
| Error spikes | >3 in 5m: app ERROR lines or 5xx (per product) | 0 |

Verified 2026-07-04: stopped staging → Telegram **Firing** at ~3.5 min → restarted →
**Resolved** arrived. Bot token lives in the provisioning YAML on the mac (not in this repo).

## Gotchas (hard-won)

1. **Grafana Loki alert queries need `queryType: instant`** in the data model — otherwise
   the alert engine runs a range query at 1s step and the threshold node errors
   ("Pending (Error)" state with no obvious message).
2. **mac DNS was a single flaky resolver** (router 192.168.2.253; 9.5s lookups). Broke Go's
   resolver (blackbox probes all failed with `probe_success=0` while curl worked) and caused
   the long-standing cloudflared `i/o timeout` log spam. Fixed:
   `networksetup -setdnsservers "Dell Universal Dock D6000" 1.1.1.1 8.8.8.8 192.168.2.253`
   — the active NIC is en7 = "Dell Universal Dock D6000", **not** "SZNX LAN 100M".
3. **mac live tunnel config is `/etc/cloudflared/config.yml`** (root-owned; namng has no
   passwordless sudo). `~/.cloudflared/config.yml` is a stale decoy. DNS routes need no
   sudo: `cloudflared tunnel route dns mac-vps <hostname>`.
4. Deploy branch guard added to `deploy/deploy-oracle.sh` (root cause of the keepalive
   outage): refuses to build from any branch other than `main`/`staging`.

## Operate

```bash
# mac: restart a component
launchctl kickstart -k gui/$(id -u)/pro.namnguyen.monitor.grafana   # or prometheus|loki|alloy|sshtunnel
# Oracle: agent
sudo systemctl restart alloy && sudo journalctl -u alloy -n 20
# Alert rule states
curl -s -u admin:<pw> https://monitor.namnguyen.pro/api/prometheus/grafana/api/v1/rules
```
