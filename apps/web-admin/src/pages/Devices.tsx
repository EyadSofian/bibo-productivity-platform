import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listDevices, setDeviceArchived, setDeviceMonitoring } from "../api/endpoints";
import { ApiError, type Device } from "../api/types";
import { Empty, Notice, Spinner } from "../components/ui";
import { useBusinesses } from "../useBusinesses";

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconLaptop = svg(<><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" /></>);
const IconMonitor = svg(<><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></>);
const IconShield = svg(<><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></>);
const IconArchive = svg(<><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" /></>);
const IconRestore = svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>);

/** A device is "live" when its last heartbeat is recent. The agent syncs on a
 *  short cycle, so five minutes of silence means it is not currently running.
 *  This is heartbeat freshness, not the presence system F16 will build. */
const LIVE_WINDOW_MS = 5 * 60 * 1000;
export function isLive(lastSeen: string | null, now: number = Date.now()): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  return Number.isFinite(t) && now - t < LIVE_WINDOW_MS;
}

/** Coarse relative time via Intl, so it localizes — including Arabic — instead
 *  of concatenating an English unit onto a number. */
export function relativeTime(
  iso: string | null,
  locale: string,
  never: string,
  now: number = Date.now(),
): string {
  if (!iso) return never;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return never;
  const diffS = Math.round((t - now) / 1000);
  const abs = Math.abs(diffS);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diffS), "second");
  if (abs < 3600) return rtf.format(Math.round(diffS / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffS / 3600), "hour");
  return rtf.format(Math.round(diffS / 86400), "day");
}

const isDesktopOS = (os: string | null) => !!os && /windows/i.test(os);

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="bibo-card bibo-card--default ad-cardpad">
      <div className="bibo-stat">
        <div className="bibo-stat__top">
          <div className="bibo-stat__icon">{icon}</div>
          <div className="bibo-stat__label">{label}</div>
        </div>
        <div className="bibo-stat__value">
          <bdi dir="ltr">{value}</bdi>
        </div>
      </div>
    </div>
  );
}

export function Devices() {
  const { t, i18n } = useTranslation("dashboard");
  const { selectedId, loading: bizLoading } = useBusinesses();

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-device in-flight flag, so toggling one row does not disable the others.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    if (!selectedId) return;
    setError(null);
    try {
      const res = await listDevices(selectedId);
      setDevices(res.devices);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("devices.errorLoad"));
      setDevices([]);
    }
  }, [selectedId, t]);

  useEffect(() => {
    setDevices(null);
    void load();
  }, [load]);

  async function toggle(device: Device) {
    const next = !device.monitoring_enabled;
    setPending((p) => ({ ...p, [device.id]: true }));
    setError(null);
    // Optimistic: the switch flips at once and rolls back if the call fails.
    setDevices((ds) =>
      ds?.map((d) => (d.id === device.id ? { ...d, monitoring_enabled: next } : d)) ?? ds,
    );
    try {
      const res = await setDeviceMonitoring(device.id, next);
      // UPDATE ... RETURNING cannot include the joined user fields in the
      // backend. Merge the response into the existing row so toggling a device
      // never makes its employee identity disappear from the table.
      setDevices((ds) =>
        ds?.map((d) =>
          d.id === device.id
            ? {
                ...d,
                ...res.device,
                user_display_name: res.device.user_display_name || d.user_display_name,
                user_login: res.device.user_login || d.user_login,
              }
            : d,
        ) ?? ds,
      );
    } catch (err) {
      setDevices((ds) =>
        ds?.map((d) => (d.id === device.id ? { ...d, monitoring_enabled: !next } : d)) ?? ds,
      );
      setError(err instanceof ApiError ? err.message : t("devices.errorToggle"));
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[device.id];
        return next;
      });
    }
  }

  async function changeArchived(device: Device, archived: boolean) {
    setPending((p) => ({ ...p, [device.id]: true }));
    setError(null);
    try {
      const res = await setDeviceArchived(device.id, archived);
      setDevices((ds) =>
        ds?.map((d) =>
          d.id === device.id
            ? {
                ...d,
                ...res.device,
                user_display_name: res.device.user_display_name || d.user_display_name,
                user_login: res.device.user_login || d.user_login,
              }
            : d,
        ) ?? ds,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("devices.errorArchive"));
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[device.id];
        return next;
      });
    }
  }

  if (bizLoading) return <Spinner label={t("devices.loading")} />;
  if (!selectedId) return <Empty>{t("profiles.noBusiness")}</Empty>;
  if (devices === null) return <Spinner label={t("devices.loading")} />;

  const activeDevices = devices.filter((d) => !d.deleted_at);
  const archivedDevices = devices.filter((d) => !!d.deleted_at);
  const visibleDevices = showArchived ? archivedDevices : activeDevices;
  const monitored = activeDevices.filter((d) => d.monitoring_enabled).length;
  const live = activeDevices.filter((d) => isLive(d.last_seen_at)).length;

  return (
    <div className="ad-page">
      <div className="ad-pagehead ad-pagehead--devices">
        <div className="ad-pagehead__main">
          <h1 className="ad-h1">{t("devices.title")}</h1>
          <p className="ad-sub">{t("devices.subtitle")}</p>
        </div>
        <div className="ad-pagehead__actions">
          <button
            type="button"
            className="bibo-btn bibo-btn--secondary bibo-btn--sm"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((value) => !value)}
          >
            {IconArchive}
            {showArchived
              ? t("devices.showActive")
              : t("devices.showArchived", { count: archivedDevices.length })}
          </button>
        </div>
      </div>

      {error && <Notice kind="danger">{error}</Notice>}

      <div className="ad-stats ad-stats--three">
        <Stat icon={IconLaptop} label={t("devices.statTotal")} value={activeDevices.length} />
        <Stat icon={IconShield} label={t("devices.statMonitored")} value={monitored} />
        <Stat icon={IconMonitor} label={t("devices.statLive")} value={live} />
      </div>

      {visibleDevices.length === 0 ? (
        <Empty>{t(showArchived ? "devices.emptyArchived" : "devices.emptyBody")}</Empty>
      ) : (
        <div className="bibo-card bibo-card--default ad-tablecard">
          <table className="ad-table">
            <thead>
              <tr>
                <th>{t("devices.table.device")}</th>
                <th>{t("devices.table.user")}</th>
                <th>{t("devices.table.os")}</th>
                <th>{t("devices.table.agent")}</th>
                <th>{t("devices.table.lastSeen")}</th>
                <th className="r">{t("devices.table.monitoring")}</th>
                <th className="r">{t("devices.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleDevices.map((d) => {
                const busy = !!pending[d.id];
                const liveNow = isLive(d.last_seen_at);
                const name = d.label || t("devices.unnamed");
                return (
                  <tr key={d.id} className={d.monitoring_enabled ? undefined : "ad-row--off"}>
                    <td>
                      <span className="ad-device">
                        <span className="ad-device__icon" aria-hidden="true">
                          {isDesktopOS(d.os) ? IconMonitor : IconLaptop}
                        </span>
                        <span className="ad-device__text">
                          <span className="ad-device__name">{name}</span>
                          <span className={`ad-live ad-live--${liveNow ? "on" : "off"}`}>
                            <span className="ad-live__dot" aria-hidden="true" />
                            {liveNow ? t("devices.live") : t("devices.offline")}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td>
                      <div className="ad-device__name">{d.user_display_name || "—"}</div>
                      <div className="ad-muted">
                        <bdi>{d.user_login}</bdi>
                      </div>
                    </td>
                    <td><bdi dir="ltr">{d.os || "—"}</bdi></td>
                    <td><bdi dir="ltr">{d.agent_version || "—"}</bdi></td>
                    <td>{relativeTime(d.last_seen_at, i18n.language, t("devices.never"))}</td>
                    <td className="r">
                      {d.deleted_at ? (
                        <span className="ad-switchstate">{t("devices.archived")}</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={d.monitoring_enabled}
                            aria-label={t("devices.toggleLabel", { device: name })}
                            disabled={busy}
                            onClick={() => void toggle(d)}
                            className={`bibo-switch${d.monitoring_enabled ? " bibo-switch--on" : ""}`}
                          >
                            <span className="bibo-switch__knob" />
                          </button>
                          <span className="ad-switchstate">
                            {d.monitoring_enabled ? t("devices.enabled") : t("devices.paused")}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="r">
                      <button
                        type="button"
                        className="bibo-btn bibo-btn--ghost bibo-btn--sm ad-deviceaction"
                        disabled={busy}
                        onClick={() => void changeArchived(d, !d.deleted_at)}
                      >
                        {d.deleted_at ? IconRestore : IconArchive}
                        {d.deleted_at ? t("devices.restore") : t("devices.archive")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="ad-muted ad-note">{t("devices.note")}</p>
    </div>
  );
}
