import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listDevices, setDeviceArchived, setDeviceMonitoring } from "../api/endpoints";
import type { Device } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { fmtRelative } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Icon } from "../ui/Icon";
import { Avatar, Card, Empty, ErrorNote, LoadingRows, Toggle } from "../ui/kit";

/** A device counts as connected if it checked in within the last two minutes. */
export function isConnected(d: Device, nowMs = Date.now()): boolean {
  return Boolean(d.last_seen_at && nowMs - Date.parse(d.last_seen_at) < 120_000);
}

export default function Devices() {
  const { t } = useTranslation("app");
  const { selectedId } = useBusinesses();
  const [showArchived, setShowArchived] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Map<string, Device>>(new Map());
  const [actionError, setActionError] = useState<unknown>(null);

  const devices = useAsync(
    () => (selectedId ? listDevices(selectedId) : Promise.resolve({ devices: [] })),
    [selectedId],
    60_000,
  );

  const all = useMemo(
    () => (devices.data?.devices ?? []).map((d) => overrides.get(d.id) ?? d),
    [devices.data, overrides],
  );
  const active = all.filter((d) => !d.deleted_at);
  const archived = all.filter((d) => d.deleted_at);
  const list = showArchived ? archived : active;
  const connected = active.filter((d) => isConnected(d)).length;

  usePageHeader(t("devices.title"), t("devices.subtitle", { count: active.length, connected }));

  const run = async (id: string, action: () => Promise<{ device: Device }>) => {
    setPending((s) => new Set(s).add(id));
    setActionError(null);
    try {
      const { device } = await action();
      setOverrides((m) => new Map(m).set(id, device));
    } catch (err) {
      setActionError(err);
    } finally {
      setPending((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="page">
      <Card
        title={showArchived ? t("devices.archivedTitle") : t("devices.listTitle")}
        sub={t("devices.listSub")}
        actions={
          archived.length > 0 || showArchived ? (
            <button type="button" className="btn btn-sm" onClick={() => setShowArchived(!showArchived)}>
              <Icon name={showArchived ? "monitor" : "archive"} />
              {showArchived ? t("devices.showActive") : t("devices.showArchived", { count: archived.length })}
            </button>
          ) : null
        }
      >
        <ErrorNote error={devices.error ?? actionError} onRetry={devices.error ? devices.reload : undefined} />
        {devices.loading && !devices.data ? (
          <LoadingRows rows={5} />
        ) : list.length === 0 ? (
          <Empty icon="monitor" title={showArchived ? t("devices.noArchived") : t("devices.none")}>
            {showArchived ? null : t("devices.noneHint")}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("devices.device")}</th>
                  <th>{t("table.employee")}</th>
                  <th className="hide-sm">{t("devices.version")}</th>
                  <th>{t("devices.connection")}</th>
                  <th>{t("devices.monitoring")}</th>
                  <th className="end">
                    <span className="sr-only">{t("table.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => {
                  const on = isConnected(d);
                  const busy = pending.has(d.id);
                  return (
                    <tr key={d.id}>
                      <td>
                        <span className="person">
                          <span className="usage-glyph">
                            <Icon name="monitor" />
                          </span>
                          <span className="person-text">
                            <span className="person-name ltr-auto">{d.label || t("devices.unnamed")}</span>
                            <span className="person-sub ltr-auto">{d.os || "—"}</span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="person">
                          <Avatar name={d.user_display_name || "?"} size="sm" />
                          <span className="person-text">
                            <span className="person-name">{d.user_display_name}</span>
                            <span className="person-sub ltr">{d.user_login}</span>
                          </span>
                        </span>
                      </td>
                      <td className="hide-sm">
                        <code className="ltr">{d.agent_version || "—"}</code>
                      </td>
                      <td>
                        <span className={`badge ${on ? "badge-ok" : ""}`}>
                          <span className={`dot ${on ? "dot-active" : ""}`} />
                          {on ? t("devices.connected") : fmtRelative(d.last_seen_at ? Date.parse(d.last_seen_at) / 1000 : null)}
                        </span>
                        {d.recording_state === "recording" ? (
                          <span className="badge badge-danger" style={{ marginInlineStart: 6 }}>
                            <span className="dot dot-live" />
                            {t("devices.recording")}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {d.deleted_at ? (
                          <span className="subtle">—</span>
                        ) : (
                          <Toggle
                            checked={d.monitoring_enabled}
                            disabled={busy}
                            onChange={(next) => void run(d.id, () => setDeviceMonitoring(d.id, next))}
                            label={<span className="sr-only">{t("devices.monitoringFor", { name: d.label || d.user_display_name })}</span>}
                          />
                        )}
                      </td>
                      <td className="end">
                        <button
                          type="button"
                          className={`btn btn-sm ${d.deleted_at ? "" : "btn-ghost"}`}
                          disabled={busy}
                          onClick={() => void run(d.id, () => setDeviceArchived(d.id, !d.deleted_at))}
                        >
                          <Icon name={d.deleted_at ? "restore" : "archive"} />
                          <span className="hide-sm">{d.deleted_at ? t("devices.restore") : t("devices.archive")}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
