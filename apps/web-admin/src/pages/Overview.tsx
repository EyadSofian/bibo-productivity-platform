import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { reportEmployees, reportTeam } from "../api/endpoints";
import { getRecordingSummary } from "../api/media";
import type { ReportEmployee } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { dayRange, elapsedEnd } from "../lib/day";
import {
  fmtClock,
  fmtCompact,
  fmtDistance,
  fmtDuration,
  fmtHours,
  fmtLongDay,
  fmtNumber,
  fmtRelative,
} from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { EngosoftMark } from "../ui/Brand";
import { HourBars, type HourBar } from "../ui/charts";
import { Icon } from "../ui/Icon";
import { Avatar, Card, Empty, ErrorNote, Kpi, LoadingRows, PresenceBadge, UsageList } from "../ui/kit";

const ORDER: Record<string, number> = { active: 0, idle: 1, online: 2, offline: 3 };

export function sortByPresence(list: ReportEmployee[]): ReportEmployee[] {
  return [...list].sort(
    (a, b) =>
      (ORDER[a.presence_state] ?? 9) - (ORDER[b.presence_state] ?? 9) ||
      b.active_today_s - a.active_today_s ||
      a.display_name.localeCompare(b.display_name),
  );
}

/** Hours worth drawing: the working day at minimum, stretched to cover any
 *  activity before 8:00 or after 18:00 and the current hour. */
export function hourWindow(hours: Array<{ hour: number }>, currentHour: number): [number, number] {
  const seen = hours.map((h) => h.hour);
  const first = Math.min(8, ...seen);
  const last = Math.max(18, currentHour, ...seen);
  return [Math.max(0, first), Math.min(23, last)];
}

export default function Overview() {
  const { t } = useTranslation("app");
  const navigate = useNavigate();
  const { selectedId, selected, loading: bizLoading } = useBusinesses();
  const today = useMemo(() => dayRange(new Date()), []);

  usePageHeader(t("overview.title"), fmtLongDay(today.date));

  const roster = useAsync(
    () => (selectedId ? reportEmployees(selectedId, { from: today.start, to: today.end }) : Promise.resolve({ employees: [] })),
    [selectedId, today.start],
    30_000,
  );
  const team = useAsync(
    () => (selectedId ? reportTeam(selectedId, today.start, Math.max(today.start + 60, elapsedEnd(today))) : Promise.resolve(null)),
    [selectedId, today.start],
    60_000,
  );
  const recordings = useAsync(
    () => (selectedId ? getRecordingSummary(selectedId).catch(() => null) : Promise.resolve(null)),
    [selectedId],
    120_000,
  );

  const people = useMemo(() => sortByPresence(roster.data?.employees ?? []), [roster.data]);
  const counts = useMemo(() => {
    const c = { active: 0, idle: 0, online: 0, offline: 0 };
    for (const p of people) c[p.presence_state in c ? p.presence_state : "offline"] += 1;
    return c;
  }, [people]);
  const totalActive = people.reduce((s, p) => s + p.active_today_s, 0);
  const workedPeople = people.filter((p) => p.active_today_s > 0);
  const avgWorked = workedPeople.length ? totalActive / workedPeople.length : 0;
  const focusValues = people.map((p) => p.focus_pct_today).filter((v): v is number => v !== null && v !== undefined);
  const avgFocus = focusValues.length ? Math.round(focusValues.reduce((a, b) => a + b, 0) / focusValues.length) : null;

  const now = new Date();
  const hourBars: HourBar[] = useMemo(() => {
    const hours = team.data?.hours ?? [];
    const [first, last] = hourWindow(hours, now.getHours());
    const byHour = new Map(hours.map((h) => [h.hour, h.duration_s]));
    const bars: HourBar[] = [];
    for (let h = first; h <= last; h++) {
      const value = byHour.get(h) ?? 0;
      const label = fmtClock(today.start + h * 3600);
      bars.push({ key: h, label, value, tip: t("overview.hourTip", { time: fmtDuration(value) }) });
    }
    return bars;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.data, today.start, t]);

  if (!bizLoading && !selectedId) {
    return (
      <div className="page">
        <Card>
          <Empty icon="building" title={t("overview.noCompanyTitle")}>
            {t("overview.noCompanyBody")}
          </Empty>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Link to="/employees" className="btn btn-primary">
              <Icon name="plus" />
              {t("overview.createCompany")}
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const workingNow = people.filter((p) => p.presence_state === "active" || p.presence_state === "idle" || p.presence_state === "online");
  const loadingRoster = roster.loading && !roster.data;

  return (
    <div className="page">
      <section className="hero overview-hero">
        <EngosoftMark className="hero-mark" dot="rgba(255,255,255,.9)" />
        <div className="overview-hero-main">
          <p className="muted">{selected?.name}</p>
          <h2 className="overview-hero-title">
            {loadingRoster ? "…" : t("overview.heroTitle", { hours: fmtHours(totalActive) })}
          </h2>
          <p className="muted">{t("overview.heroSub", { count: workedPeople.length })}</p>
        </div>
        <div className="overview-hero-stats">
          <div className="hero-stat">
            <strong className="num">{counts.active}</strong>
            <span>
              <span className="dot dot-active" />
              {t("overview.activeNow")}
            </span>
          </div>
          <div className="hero-stat">
            <strong className="num">{counts.idle}</strong>
            <span>
              <span className="dot dot-idle" />
              {t("overview.idleNow")}
            </span>
          </div>
          <div className="hero-stat">
            <strong className="num">{counts.offline}</strong>
            <span>
              <span className="dot" />
              {t("overview.offlineNow")}
            </span>
          </div>
        </div>
      </section>

      <ErrorNote error={roster.error} onRetry={roster.reload} />

      <div className="grid grid-kpi">
        <Kpi
          icon="clock"
          label={t("overview.kpiAvgWorked")}
          value={fmtDuration(avgWorked)}
          foot={t("overview.kpiAvgWorkedFoot", { count: workedPeople.length })}
          loading={loadingRoster}
        />
        <Kpi
          icon="keyboard"
          label={t("overview.kpiKeystrokes")}
          value={fmtCompact(team.data?.input.keystrokes ?? people.reduce((s, p) => s + (p.keystrokes_today ?? 0), 0))}
          foot={t("overview.kpiKeystrokesFoot")}
          loading={team.loading && !team.data}
        />
        <Kpi
          icon="click"
          label={t("overview.kpiClicks")}
          value={fmtCompact(team.data?.input.clicks ?? people.reduce((s, p) => s + (p.clicks_today ?? 0), 0))}
          foot={team.data ? t("overview.kpiClicksFoot", { distance: fmtDistance(team.data.input.mouse_px) }) : undefined}
          accent
          loading={team.loading && !team.data}
        />
        <Kpi
          icon="target"
          label={t("overview.kpiFocus")}
          value={avgFocus === null ? "—" : `${avgFocus}%`}
          foot={t("overview.kpiFocusFoot")}
          loading={loadingRoster}
        />
      </div>

      <div className="grid grid-main-side">
        <Card title={t("overview.hoursTitle")} sub={t("overview.hoursSub")}>
          {team.error ? (
            <ErrorNote error={team.error} onRetry={team.reload} />
          ) : (
            <HourBars
              bars={hourBars}
              caption={t("overview.hoursTitle")}
              valueLabel={t("overview.activeTime")}
              format={(v) => fmtDuration(v)}
              height={190}
            />
          )}
        </Card>

        <Card
          title={t("overview.nowTitle")}
          sub={t("overview.nowSub", { count: workingNow.length })}
          actions={
            <Link to="/live" className="btn btn-sm">
              <Icon name="live" />
              {t("overview.watchLive")}
            </Link>
          }
        >
          {loadingRoster ? (
            <LoadingRows rows={4} />
          ) : workingNow.length === 0 ? (
            <Empty icon="coffee" title={t("overview.nobodyOnline")}>
              {t("overview.nobodyOnlineBody")}
            </Empty>
          ) : (
            <ul className="now-list">
              {workingNow.slice(0, 7).map((p) => (
                <li key={p.id}>
                  <Link to={`/employees/${p.id}`} className="now-row">
                    <Avatar name={p.display_name} status={p.presence_state} />
                    <span className="person-text">
                      <span className="person-name">{p.display_name}</span>
                      <span className="person-sub ltr-auto">{p.current_app || t("overview.noApp")}</span>
                    </span>
                    <span className="now-time num">{fmtDuration(p.active_today_s)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title={t("overview.appsTitle")} sub={t("overview.appsSub")}>
          {team.loading && !team.data ? (
            <LoadingRows rows={5} />
          ) : (
            <UsageList
              items={(team.data?.apps ?? []).map((a) => ({
                key: a.name,
                name: a.name,
                seconds: a.duration_s,
                meta: t("overview.people", { count: a.employees }),
              }))}
              total={(team.data?.apps ?? []).reduce((s, a) => s + a.duration_s, 0)}
              format={fmtDuration}
              emptyTitle={t("overview.noApps")}
            />
          )}
        </Card>
        <Card title={t("overview.sitesTitle")} sub={t("overview.sitesSub")}>
          {team.loading && !team.data ? (
            <LoadingRows rows={5} />
          ) : (
            <UsageList
              items={(team.data?.domains ?? []).map((d) => ({
                key: d.name,
                name: d.name,
                seconds: d.duration_s,
                glyph: "globe" as const,
                meta: t("overview.people", { count: d.employees }),
              }))}
              total={(team.data?.domains ?? []).reduce((s, d) => s + d.duration_s, 0)}
              format={fmtDuration}
              barColor="var(--chart-2)"
              emptyTitle={t("overview.noSites")}
            />
          )}
        </Card>
      </div>

      <Card
        title={t("overview.teamTitle")}
        sub={t("overview.teamSub", { count: people.length })}
        actions={
          <Link to="/employees" className="btn btn-sm">
            {t("overview.allEmployees")}
            <Icon name="chevronRight" className="flip-rtl" />
          </Link>
        }
      >
        {loadingRoster ? (
          <LoadingRows rows={5} />
        ) : people.length === 0 ? (
          <Empty icon="users" title={t("overview.noEmployees")}>
            {t("overview.noEmployeesBody")}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("table.employee")}</th>
                  <th>{t("table.status")}</th>
                  <th className="hide-sm">{t("table.now")}</th>
                  <th className="end">{t("table.worked")}</th>
                  <th className="end hide-sm">{t("table.keys")}</th>
                  <th className="end hide-sm">{t("table.clicks")}</th>
                  <th className="hide-sm">{t("table.focus")}</th>
                  <th className="end hide-sm">{t("table.lastSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr
                    key={p.id}
                    className="is-link"
                    onClick={() => navigate(`/employees/${p.id}`)}
                  >
                    <td>
                      <Link to={`/employees/${p.id}`} className="person" onClick={(e) => e.stopPropagation()}>
                        <Avatar name={p.display_name} size="sm" />
                        <span className="person-text">
                          <span className="person-name">
                            {p.display_name}
                            {p.role === "owner" ? <span className="badge badge-brand" style={{ marginInlineStart: 8 }}>{t("table.you")}</span> : null}
                          </span>
                          <span className="person-sub ltr">{p.email || p.username}</span>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <PresenceBadge state={p.presence_state} />
                    </td>
                    <td className="hide-sm">
                      <span className="truncate ltr-auto" style={{ display: "block", maxWidth: 220 }}>
                        {p.current_app ?? <span className="subtle">—</span>}
                      </span>
                    </td>
                    <td className="end num strong">{fmtDuration(p.active_today_s)}</td>
                    <td className="end num hide-sm">{fmtNumber(p.keystrokes_today ?? 0)}</td>
                    <td className="end num hide-sm">{fmtNumber(p.clicks_today ?? 0)}</td>
                    <td className="hide-sm">
                      {p.focus_pct_today === null ? (
                        <span className="subtle">—</span>
                      ) : (
                        <span className="focus-cell">
                          <span className="usage-bar" aria-hidden>
                            <span style={{ width: `${p.focus_pct_today}%` }} />
                          </span>
                          <span className="num">{p.focus_pct_today}%</span>
                        </span>
                      )}
                    </td>
                    <td className="end muted hide-sm">{fmtRelative(p.presence_seen_at ?? p.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {recordings.data ? (
        <Card title={t("overview.videoTitle")} sub={t("overview.videoSub", { days: recordings.data.window_days })}>
          <div className="chip-row">
            <span className="badge badge-ok">
              <Icon name="check" />
              {t("overview.videoReady", { count: recordings.data.summary.ready })}
            </span>
            <span className="badge badge-brand">
              <span className="dot dot-live" />
              {t("overview.videoRecording", { count: recordings.data.summary.recording })}
            </span>
            {recordings.data.summary.failed > 0 ? (
              <span className="badge badge-danger">
                <Icon name="alert" />
                {t("overview.videoFailed", { count: recordings.data.summary.failed })}
              </span>
            ) : null}
            {recordings.data.summary.last_ready_at ? (
              <span className="badge">
                <Icon name="clock" />
                {t("overview.videoLast", { when: fmtRelative(Date.parse(recordings.data.summary.last_ready_at) / 1000) })}
              </span>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
