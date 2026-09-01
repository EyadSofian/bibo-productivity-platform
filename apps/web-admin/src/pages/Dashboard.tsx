import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { reportEmployees } from "../api/endpoints";
import type { ReportEmployee } from "../api/types";
import { Empty, Notice, Spinner } from "../components/ui";
import { fmtRelative } from "../format";
import { useBusinesses } from "../useBusinesses";
import { memberTerms } from "../terms";
import { useAuth } from "../auth/AuthContext";

function fmtClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

type Status = "active" | "idle" | "offline";

function memberStatus(lastSeen: number | null): Status {
  if (!lastSeen) return "offline";
  const ageSeconds = Date.now() / 1000 - lastSeen;
  if (ageSeconds < 5 * 60) return "active";
  if (ageSeconds < 30 * 60) return "idle";
  return "offline";
}

function rosterStatus(employee: ReportEmployee): Status {
  if (employee.presence_state === "active" || employee.presence_state === "idle") {
    return employee.presence_state;
  }
  return memberStatus(employee.last_seen);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function focusTone(percent: number | null): "good" | "watch" | "low" | "muted" {
  if (percent == null) return "muted";
  if (percent >= 75) return "good";
  if (percent >= 55) return "watch";
  return "low";
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const ClockIcon = <Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></Icon>;
const PeopleIcon = <Icon><circle cx="9" cy="8" r="3" /><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19M16 5.5a3 3 0 0 1 0 5.8M18 13.5a4 4 0 0 1 2.5 3.7V19" /></Icon>;
const FocusIcon = <Icon><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" /></Icon>;
const CameraIcon = <Icon><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3" /></Icon>;
const ArrowIcon = <Icon><path d="M5 12h13M13 7l5 5-5 5" /></Icon>;

type Delta = { value: number; direction: "up" | "down" | "flat" };

function delta(today: number, yesterday: number): Delta | null {
  if (yesterday <= 0) return null;
  const value = Math.round(Math.abs(((today - yesterday) / yesterday) * 100));
  return { value, direction: today === yesterday ? "flat" : today > yesterday ? "up" : "down" };
}

function OpsMetric({
  icon,
  label,
  value,
  detail,
  change,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: string;
  change?: Delta | null;
  tone: "ink" | "mint" | "amber" | "blue";
}) {
  return (
    <article className={`ops-metric ops-metric--${tone}`}>
      <div className="ops-metric__icon">{icon}</div>
      <div className="ops-metric__copy">
        <span>{label}</span>
        <strong dir="ltr">{value}</strong>
      </div>
      <div className="ops-metric__foot">
        <small>{detail}</small>
        {change ? (
          <span className={`ops-delta ops-delta--${change.direction}`} dir="ltr">
            {change.direction === "up" ? "↗" : change.direction === "down" ? "↘" : "→"} {change.value}%
          </span>
        ) : null}
      </div>
    </article>
  );
}

export function Dashboard() {
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { user } = useAuth();
  const { businesses, selected, selectedId, loading: businessLoading } = useBusinesses();
  const terms = memberTerms(selected?.kind);
  const [rows, setRows] = useState<ReportEmployee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const refresh = (initial = false) => {
      if (initial) setLoading(true);
      setError(null);
      reportEmployees(selectedId)
        .then((result) => {
          if (cancelled) return;
          setRows(result.employees);
          setLastRefresh(new Date());
        })
        .catch(() => !cancelled && setError(t("dashboard.errorRoster")))
        .finally(() => initial && !cancelled && setLoading(false));
    };
    refresh(true);
    const timer = window.setInterval(() => refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId, t]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const metrics = useMemo(() => {
    const totalRecorded = rows.reduce((sum, employee) => sum + employee.active_today_s, 0);
    const totalYesterday = rows.reduce((sum, employee) => sum + employee.active_yesterday_s, 0);
    const screenshots = rows.reduce((sum, employee) => sum + employee.screenshots_today, 0);
    const screenshotsYesterday = rows.reduce((sum, employee) => sum + employee.screenshots_yesterday, 0);
    const statuses = rows.map(rosterStatus);
    const active = statuses.filter((status) => status === "active").length;
    const idle = statuses.filter((status) => status === "idle").length;
    const offline = statuses.filter((status) => status === "offline").length;
    const focusValues = rows
      .map((employee) => employee.focus_pct_today)
      .filter((value): value is number => value != null);
    const averageFocus = focusValues.length
      ? Math.round(focusValues.reduce((sum, value) => sum + value, 0) / focusValues.length)
      : null;
    return { totalRecorded, totalYesterday, screenshots, screenshotsYesterday, active, idle, offline, averageFocus };
  }, [rows]);

  const sortedRows = useMemo(() => {
    const weight: Record<Status, number> = { active: 0, idle: 1, offline: 2 };
    return [...rows].sort((a, b) => {
      const stateOrder = weight[rosterStatus(a)] - weight[rosterStatus(b)];
      return stateOrder || b.active_today_s - a.active_today_s;
    });
  }, [rows]);

  const maxActive = Math.max(1, ...rows.map((employee) => employee.active_today_s));
  const onlineCount = metrics.active + metrics.idle;
  const activeShare = rows.length ? Math.round((metrics.active / rows.length) * 100) : 0;
  const idleShare = rows.length ? Math.round((metrics.idle / rows.length) * 100) : 0;
  const offlineShare = Math.max(0, 100 - activeShare - idleShare);

  return (
    <div className="ad-wrap ops-dashboard">
      <header className="ops-hero">
        <div className="ops-hero__copy">
          <span className="ops-kicker"><i aria-hidden />{t("dashboard.ops.eyebrow")}</span>
          <h1>{t("dashboard.ops.headline")}</h1>
          <p>{t("dashboard.ops.subtitle", { name: selected?.name ?? "BiBo", count: rows.length, members: terms.many })}</p>
          <div className="ops-hero__actions">
            <Link className="ops-action ops-action--primary" to="/employees">{t("dashboard.ops.openWorkforce")}{ArrowIcon}</Link>
            <Link className="ops-action" to="/devices">{t("devices.title")}</Link>
          </div>
        </div>
        <div className="ops-hero__signal" aria-label={t("dashboard.statRecorded")}>
          <span>{t("dashboard.statRecorded")}</span>
          <strong dir="ltr">{fmtClock(metrics.totalRecorded)}</strong>
          <div className="ops-hero__signalbar"><i style={{ width: `${Math.min(100, rows.length ? (metrics.totalRecorded / (rows.length * 8 * 3600)) * 100 : 0)}%` }} /></div>
          <small>{onlineCount} {t("dashboard.ops.reportingNow")} · {lastRefresh ? t("dashboard.ops.updatedNow") : t("dashboard.loadingRoster")}</small>
        </div>
      </header>

      {businessLoading ? <Spinner label={t("dashboard.loadingBusinesses")} /> : null}
      {!businessLoading && businesses.length === 0 ? (
        <Empty>
          <Trans i18nKey="dashboard.noBusinesses" t={t} values={{ members: terms.many, member: terms.lowerOne }} components={[<Link to="/employees" />]} />
        </Empty>
      ) : null}
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {loading ? <Spinner label={t("dashboard.loadingRoster")} /> : null}
      {!loading && !error && selectedId && rows.length === 0 ? <Empty>{t("dashboard.noActivity", { members: terms.lowerMany })}</Empty> : null}

      {rows.length > 0 ? (
        <>
          <section className="ops-metrics" aria-label={t("dashboard.ops.overview")}>
            <OpsMetric icon={ClockIcon} label={t("dashboard.statRecorded")} value={fmtClock(metrics.totalRecorded)} detail={t("dashboard.todayLabel")} change={delta(metrics.totalRecorded, metrics.totalYesterday)} tone="ink" />
            <OpsMetric icon={PeopleIcon} label={t("dashboard.statActive")} value={`${onlineCount}/${rows.length}`} detail={t("dashboard.ops.activeIdle", { active: metrics.active, idle: metrics.idle })} tone="mint" />
            <OpsMetric icon={FocusIcon} label={t("dashboard.statFocus")} value={metrics.averageFocus == null ? "—" : `${metrics.averageFocus}%`} detail={t("dashboard.todayLabel")} tone="amber" />
            <OpsMetric icon={CameraIcon} label={t("dashboard.statScreenshots")} value={metrics.screenshots} detail={t("dashboard.todayLabel")} change={delta(metrics.screenshots, metrics.screenshotsYesterday)} tone="blue" />
          </section>

          <section className="ops-grid">
            <article className="ops-panel ops-pulse">
              <div className="ops-panel__head">
                <div><span>{t("dashboard.ops.teamPulse")}</span><h2>{t("dashboard.ops.presenceMix")}</h2></div>
                <small>{rows.length}</small>
              </div>
              <div className="ops-pulse__body">
                <div className="ops-donut" style={{ background: `conic-gradient(var(--ops-mint) 0 ${activeShare}%, var(--ops-amber) ${activeShare}% ${activeShare + idleShare}%, var(--ops-offline) ${activeShare + idleShare}% 100%)` }}>
                  <span><strong>{onlineCount}</strong><small>{t("dashboard.ops.online")}</small></span>
                </div>
                <div className="ops-legend">
                  {(["active", "idle", "offline"] as const).map((status) => {
                    const count = status === "active" ? metrics.active : status === "idle" ? metrics.idle : metrics.offline;
                    const share = status === "active" ? activeShare : status === "idle" ? idleShare : offlineShare;
                    return <div key={status} className={`ops-legend__row ops-legend__row--${status}`}><i aria-hidden /><span>{t(`dashboard.states.${status}`)}</span><strong>{count}</strong><small>{share}%</small></div>;
                  })}
                </div>
              </div>
            </article>

            <article className="ops-panel ops-now">
              <div className="ops-panel__head">
                <div><span>{t("dashboard.ops.liveDesk")}</span><h2>{t("dashboard.table.currentNow")}</h2></div>
                <Link to="/employees">{t("dashboard.ops.viewAll")}{ArrowIcon}</Link>
              </div>
              <div className="ops-now__list">
                {sortedRows.slice(0, 5).map((employee) => {
                  const status = rosterStatus(employee);
                  const focus = employee.focus_pct_today;
                  return (
                    <button key={employee.id} type="button" className="ops-person" onClick={() => navigate(`/employees/${employee.id}?business=${selectedId}`)}>
                      <span className={`ops-avatar ops-avatar--${status}`}>{initials(employee.display_name)}<i aria-hidden /></span>
                      <span className="ops-person__identity"><strong>{employee.display_name}</strong><small>{employee.current_window_title || employee.current_app || t("dashboard.noCurrentApp")}</small></span>
                      <span className="ops-person__app"><strong>{employee.current_app || t(`dashboard.states.${status}`)}</strong><small>{status === "offline" ? fmtRelative(employee.last_seen) : t(`dashboard.states.${status}`)}</small></span>
                      <span className={`ops-focus ops-focus--${focusTone(focus)}`}><strong>{focus == null ? "—" : `${focus}%`}</strong><small>{t("dashboard.table.focus")}</small></span>
                      <span className="ops-chevron">{ArrowIcon}</span>
                    </button>
                  );
                })}
              </div>
            </article>
          </section>

          <section className="ops-panel ops-roster">
            <div className="ops-panel__head ops-roster__head">
              <div><span>{t("dashboard.ops.workforce")}</span><h2>{t("dashboard.ops.rosterTitle")}</h2></div>
              <small>{t("dashboard.ops.autoRefresh")}</small>
            </div>
            <div className="ops-roster__scroll">
              <table>
                <thead><tr><th>{t("dashboard.table.name")}</th><th>{t("dashboard.table.currentNow")}</th><th>{t("dashboard.table.onlineFor")}</th><th>{t("dashboard.table.activeToday")}</th><th>{t("dashboard.table.focus")}</th><th aria-label={t("dashboard.view")} /></tr></thead>
                <tbody>
                  {sortedRows.map((employee) => {
                    const status = rosterStatus(employee);
                    const isSelf = employee.role === "owner" || employee.id === user?.id;
                    const focus = employee.focus_pct_today;
                    const activeWidth = (employee.active_today_s / maxActive) * 100;
                    return (
                      <tr key={employee.id} onClick={() => navigate(`/employees/${employee.id}?business=${selectedId}`)}>
                        <td><div className="ops-name"><span className={`ops-avatar ops-avatar--${status}`}>{initials(employee.display_name)}<i aria-hidden /></span><span><strong>{employee.display_name}{isSelf ? <em>{t("dashboard.selfBadge")}</em> : null}</strong><small>{employee.email || employee.username}</small></span></div></td>
                        <td><div className="ops-current"><span className={`ops-state ops-state--${status}`}>{t(`dashboard.states.${status}`)}</span><strong>{employee.current_app || t("dashboard.noCurrentApp")}</strong><small title={employee.current_window_title ?? undefined}>{employee.current_window_title || "—"}</small></div></td>
                        <td className="ops-mono">{employee.session_started_at && status !== "offline" ? <bdi dir="ltr">{fmtClock(now - employee.session_started_at)}</bdi> : fmtRelative(employee.last_seen)}</td>
                        <td><div className="ops-activebar"><strong dir="ltr">{fmtClock(employee.active_today_s)}</strong><span><i style={{ width: `${activeWidth}%` }} /></span></div></td>
                        <td><span className={`ops-focus ops-focus--${focusTone(focus)}`}><strong>{focus == null ? "—" : `${focus}%`}</strong></span></td>
                        <td>
                          <button
                            type="button"
                            className="ops-rowlink"
                            aria-label={`${t("dashboard.view")} ${employee.display_name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              navigate(`/employees/${employee.id}?business=${selectedId}`);
                            }}
                          >
                            <span className="ops-table-arrow">{ArrowIcon}</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
