import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  reportActivity,
  reportBrowser,
  reportEmployees,
  reportKeystrokes,
  reportPresence,
  reportStates,
} from "../api/endpoints";
import { listEmployeeRecordings, type RecordingAsset } from "../api/media";
import type { ActivityResponse, BrowserVisit, KeystrokeBucket, OsStateReport } from "../api/types";
import { usePageHeader } from "../app/AppShell";
import { useBusinesses } from "../app/useBusinesses";
import { SessionPlayer, type SeekRequest } from "../components/SessionPlayer/SessionPlayer";
import { ScreenshotsPanel } from "../components/ScreenshotsPanel";
import { deriveCommunicationSessions } from "../lib/communicationEvidence";
import { dayRange, elapsedEnd, isoDate, isSameDay, localDayWindow, parseIsoDate } from "../lib/day";
import { firstRecordedMoment, safeHref, uniqueVisits, workingWindow } from "../lib/dayModel";
import { activityLog, hasMouseData, inputByHour, inputTotals, windowTitles, type InputMetric } from "../lib/employeeDay";
import {
  fmtBytes,
  fmtClock,
  fmtCompact,
  fmtDistance,
  fmtDuration,
  fmtNumber,
  fmtRelative,
  usagePercent,
} from "../lib/format";
import { rollupByDomain, rollupByPage } from "../lib/rollup";
import { useAsync } from "../lib/useAsync";
import { DayRibbon, HourBars, SplitBar, type HourBar } from "../ui/charts";
import { Icon } from "../ui/Icon";
import {
  Avatar,
  Card,
  DayNav,
  Dialog,
  Empty,
  ErrorNote,
  Kpi,
  LoadingRows,
  PresenceBadge,
  Segmented,
  Tabs,
  UsageList,
} from "../ui/kit";

const DeviceLiveVideo = lazy(() => import("../components/LivePlayer/DeviceLiveVideo"));

type Tab = "apps" | "sites" | "input" | "log" | "screenshots" | "video";

type DayData = {
  activity: ActivityResponse;
  visits: BrowserVisit[];
  buckets: KeystrokeBucket[];
  states: OsStateReport | null;
  recordings: RecordingAsset[];
};

const EMPTY_DAY: DayData = { activity: { samples: [], breakdown: [] }, visits: [], buckets: [], states: null, recordings: [] };

export default function EmployeeDay() {
  const { id = "" } = useParams();
  const { t } = useTranslation("app");
  const { selectedId } = useBusinesses();
  const [params, setParams] = useSearchParams();
  const day = parseIsoDate(params.get("day"));
  const range = useMemo(() => dayRange(day), [day.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const isToday = isSameDay(day, new Date());
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "apps");
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);

  const setDay = (d: Date) => {
    const next = new URLSearchParams(params);
    if (isSameDay(d, new Date())) next.delete("day");
    else next.set("day", isoDate(d));
    setParams(next, { replace: true });
  };
  const selectTab = (v: Tab) => {
    setTab(v);
    const next = new URLSearchParams(params);
    next.set("tab", v);
    setParams(next, { replace: true });
  };

  const roster = useAsync(
    () => (selectedId ? reportEmployees(selectedId, localDayWindow()) : Promise.resolve({ employees: [] })),
    [selectedId],
    30_000,
  );
  const person = roster.data?.employees.find((e) => e.id === id) ?? null;

  const presence = useAsync(() => reportPresence(id).then((r) => r.presence).catch(() => null), [id], 20_000);

  const data = useAsync<DayData>(
    async () => {
      const to = elapsedEnd(range) || range.end;
      const end = Math.max(range.start + 1, to);
      const [activity, browser, keys, states, recordings] = await Promise.all([
        reportActivity(id, range.start, end),
        reportBrowser(id, range.start, end),
        reportKeystrokes(id, range.start, end),
        reportStates(id, range.start, end).catch(() => null),
        listEmployeeRecordings(id, range.start, range.end).catch(() => ({ recordings: [] as RecordingAsset[] })),
      ]);
      return {
        activity,
        visits: uniqueVisits(browser.visits),
        buckets: keys.buckets,
        states,
        recordings: recordings.recordings,
      };
    },
    [id, range.start],
    isToday ? 60_000 : undefined,
  );

  const d = data.data ?? EMPTY_DAY;
  const name = person?.display_name ?? t("employee.unknown");
  const live = presence.data ?? null;
  const online = live ? live.state !== "offline" : person ? person.presence_state !== "offline" : false;
  const deviceId = live?.device_id ?? person?.device_id ?? null;

  usePageHeader(
    name,
    person ? (person.email || person.username || undefined) : undefined,
  );

  const input = useMemo(() => inputTotals(d.buckets), [d.buckets]);
  const mouseReported = hasMouseData(d.buckets);
  const appSeconds = d.activity.breakdown.reduce((s, b) => s + b.duration_s, 0);
  const totals = d.states?.totals;
  const worked = totals && totals.active_s > 0 ? totals.active_s : appSeconds;
  const first = d.states?.first_activity ?? d.activity.samples[0]?.ts ?? null;
  const lastSample = d.activity.samples[d.activity.samples.length - 1];
  const last = d.states?.last_activity ?? (lastSample ? lastSample.ts + lastSample.duration_s : null);
  const nowSec = Math.floor(Date.now() / 1000);
  // Draw the part of the day that has anything in it, padded to whole hours:
  // eight working hours squeezed into a third of a 24-hour axis are unreadable.
  const view = workingWindow(
    { start: range.start, end: range.end },
    [first, last, isToday ? nowSec : null, ...d.recordings.map((r) => Date.parse(r.started_at) / 1000)].filter(
      (m): m is number => typeof m === "number" && Number.isFinite(m),
    ),
  );
  // "No data" only counts inside the working span; the night before the first
  // activity is not missing data, it is the night.
  const accounted = (totals?.active_s ?? worked) + (totals?.idle_s ?? 0) + (totals?.suspended_s ?? 0);
  const gapInSpan = first && last ? Math.max(0, last - first - accounted) : 0;

  const loading = data.loading && !data.data;

  return (
    <div className="page">
      {/* ---------- identity ---------- */}
      <section className="glass card profile-head">
        <Link to="/employees" className="btn btn-ghost btn-sm profile-back">
          <Icon name="chevronLeft" className="flip-rtl" />
          {t("employee.back")}
        </Link>
        <div className="profile-id">
          <Avatar name={name} size="xl" status={live?.state ?? person?.presence_state} />
          <div className="profile-text">
            <div className="profile-name-row">
              <h2 className="profile-name">{name}</h2>
              <PresenceBadge state={live?.state ?? person?.presence_state} />
            </div>
            {online && (live?.app || person?.current_app) ? (
              <p className="profile-now">
                <Icon name="app" />
                <span className="ltr-auto strong">{live?.app ?? person?.current_app}</span>
                {live?.window_title || person?.current_window_title ? (
                  <span className="muted truncate ltr-auto">— {live?.window_title ?? person?.current_window_title}</span>
                ) : null}
              </p>
            ) : (
              <p className="muted">{t("employee.lastSeen", { when: fmtRelative(live?.seen_at ?? person?.last_seen ?? null) })}</p>
            )}
            {live?.resources ? (
              <div className="chip-row profile-resources">
                <span className="badge">
                  <Icon name="cpu" />
                  CPU {Math.round(live.resources.cpu_pct)}%
                </span>
                <span className="badge">
                  RAM {usagePercent(live.resources.memory_used_bytes, live.resources.memory_total_bytes)}%
                </span>
                <span className="badge">
                  {t("employee.disk")} {usagePercent(live.resources.disk_used_bytes, live.resources.disk_total_bytes)}%
                </span>
                <span className="badge ltr">
                  ↓ {fmtBytes(live.resources.network_rx_bps)}/s · ↑ {fmtBytes(live.resources.network_tx_bps)}/s
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="profile-actions">
          <DayNav value={day} onChange={setDay} />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!deviceId || !online}
            onClick={() => setLiveOpen(true)}
            title={!online ? t("employee.liveOffline") : undefined}
          >
            <Icon name="live" />
            {t("employee.watchLive")}
          </button>
        </div>
      </section>

      <ErrorNote error={data.error} onRetry={data.reload} />

      {/* ---------- headline figures ---------- */}
      <div className="grid grid-kpi">
        <Kpi
          icon="clock"
          label={t("employee.worked")}
          value={fmtDuration(worked)}
          foot={first && last ? t("employee.span", { from: fmtClock(first), to: fmtClock(last) }) : t("employee.noActivity")}
          loading={loading}
        />
        <Kpi
          icon="coffee"
          label={t("employee.idle")}
          value={fmtDuration(totals?.idle_s ?? 0)}
          foot={totals ? t("employee.away", { time: fmtDuration(totals.suspended_s) }) : undefined}
          accent
          loading={loading}
        />
        <Kpi
          icon="keyboard"
          label={t("employee.keystrokes")}
          value={fmtCompact(input.keys)}
          foot={t("employee.activeMinutes", { count: input.activeMinutes })}
          loading={loading}
        />
        <Kpi
          icon="click"
          label={t("employee.clicks")}
          value={mouseReported ? fmtCompact(input.clicks) : "—"}
          foot={mouseReported ? t("employee.mouseFoot", { distance: fmtDistance(input.mousePx), scrolls: fmtNumber(input.scrolls) }) : t("employee.mouseNotReported")}
          loading={loading}
        />
      </div>

      {/* ---------- the day at a glance ---------- */}
      <Card title={t("employee.dayTitle")} sub={t("employee.daySub")}>
        {loading ? (
          <LoadingRows rows={2} />
        ) : (
          <div className="day-glance">
            <SplitBar
              caption={t("employee.dayTitle")}
              parts={[
                { key: "active", label: t("state.active"), value: totals?.active_s ?? worked, className: "fill-active", display: fmtDuration(totals?.active_s ?? worked) },
                { key: "idle", label: t("state.idle"), value: totals?.idle_s ?? 0, className: "fill-idle", display: fmtDuration(totals?.idle_s ?? 0) },
                { key: "away", label: t("state.suspended"), value: totals?.suspended_s ?? 0, className: "fill-away", display: fmtDuration(totals?.suspended_s ?? 0) },
                { key: "offline", label: t("employee.gap"), value: gapInSpan, className: "fill-offline", display: fmtDuration(gapInSpan) },
              ]}
            />
            <DayRibbon report={d.states} from={view.start} to={view.end} now={nowSec} />
          </div>
        )}
      </Card>

      {/* ---------- detail ---------- */}
      <section className="glass card">
        <Tabs<Tab>
          value={tab}
          onChange={selectTab}
          label={t("employee.sections")}
          tabs={[
            { value: "apps", label: t("employee.tabApps", { count: d.activity.breakdown.length }), icon: "app" },
            { value: "sites", label: t("employee.tabSites"), icon: "globe" },
            { value: "input", label: t("employee.tabInput"), icon: "keyboard" },
            { value: "log", label: t("employee.tabLog"), icon: "activity" },
            { value: "screenshots", label: t("employee.tabScreenshots"), icon: "monitor" },
            { value: "video", label: t("employee.tabVideo"), icon: "live" },
          ]}
        />
        {loading ? (
          <LoadingRows rows={6} />
        ) : tab === "apps" ? (
          <AppsPanel data={d} onWatch={(ts) => { setSeek({ ts, n: Date.now() }); selectTab("video"); }} />
        ) : tab === "sites" ? (
          <SitesPanel visits={d.visits} />
        ) : tab === "input" ? (
          <InputPanel buckets={d.buckets} dayStart={range.start} mouseReported={mouseReported} />
        ) : tab === "log" ? (
          <LogPanel data={d} />
        ) : tab === "screenshots" ? (
          <ScreenshotsPanel key={`${id}:${range.start}`} employeeId={id} from={range.start} to={range.end} today={isToday} />
        ) : (
          <SessionPlayer recordings={d.recordings} seek={seek} samples={d.activity.samples} />
        )}
      </section>

      <Dialog open={liveOpen} onClose={() => setLiveOpen(false)} title={t("employee.liveTitle", { name })} wide>
        {liveOpen && deviceId ? (
          <Suspense fallback={<span className="spinner" />}>
            <DeviceLiveVideo deviceId={deviceId} online={online} autoStart />
          </Suspense>
        ) : null}
      </Dialog>
    </div>
  );
}

/* ---------- apps ---------- */

function AppsPanel({ data, onWatch }: { data: DayData; onWatch: (ts: number) => void }) {
  const { t } = useTranslation("app");
  const total = data.activity.breakdown.reduce((s, b) => s + b.duration_s, 0);
  const items = data.activity.breakdown.map((b) => {
    const titles = windowTitles(data.activity.samples, b.app_name);
    return {
      key: b.app_name,
      name: b.app_name,
      seconds: b.duration_s,
      detail: titles.map((w) => ({
        key: w.title || "—",
        primary: w.title || t("employee.untitled"),
        value: fmtDuration(w.seconds),
      })),
    };
  });
  const firstRecorded = useMemo(() => {
    const seg = data.activity.samples[0];
    return seg ? firstRecordedMoment({ app: seg.app_name, ts: seg.ts, dur: 86400 }, data.recordings) : null;
  }, [data]);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="muted">{t("employee.appsHint")}</p>
      <UsageList items={items} total={total} format={fmtDuration} limit={12} emptyTitle={t("employee.noApps")} />
      {firstRecorded ? (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => onWatch(firstRecorded)}>
            <Icon name="play" />
            {t("employee.watchDay")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- websites ---------- */

function SitesPanel({ visits }: { visits: BrowserVisit[] }) {
  const { t } = useTranslation("app");
  const domains = rollupByDomain(visits);
  const total = domains.reduce((s, x) => s + x.totalS, 0);
  const items = domains.map((dmn) => ({
    key: dmn.domain,
    name: dmn.domain,
    seconds: dmn.totalS,
    glyph: "globe" as const,
    meta: dmn.browsers.join(", "),
    detail: rollupByPage(visits, dmn.domain).map((p) => ({
      key: p.url,
      primary: p.title || p.url,
      secondary: p.url,
      href: safeHref(p.url),
      value: `${fmtClock(p.firstTs)} · ${fmtDuration(p.totalS)}`,
    })),
  }));
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p className="muted">{t("employee.sitesHint", { count: visits.length })}</p>
      <UsageList
        items={items}
        total={total}
        format={fmtDuration}
        limit={12}
        barColor="var(--chart-2)"
        emptyTitle={t("employee.noSites")}
      />
    </div>
  );
}

/* ---------- keyboard & mouse ---------- */

function InputPanel({ buckets, dayStart, mouseReported }: { buckets: KeystrokeBucket[]; dayStart: number; mouseReported: boolean }) {
  const { t } = useTranslation("app");
  const [metric, setMetric] = useState<InputMetric>("keys");
  const totals = inputTotals(buckets);
  const values = inputByHour(buckets, dayStart, metric);
  const used = values.map((v, h) => (v > 0 ? h : -1)).filter((h) => h >= 0);
  const firstH = Math.min(8, ...used);
  const lastH = Math.max(18, ...used);
  const format = (v: number) => (metric === "mouse" ? fmtDistance(v) : fmtNumber(v));
  const bars: HourBar[] = [];
  for (let h = Math.max(0, firstH); h <= Math.min(23, lastH); h++) {
    bars.push({ key: h, label: fmtClock(dayStart + h * 3600), value: values[h], tip: format(values[h]) });
  }
  const peak = values.indexOf(Math.max(...values));
  const label = t(`input.${metric}`);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="input-summary">
        <div>
          <span className="muted">{t("input.keys")}</span>
          <strong className="num">{fmtNumber(totals.keys)}</strong>
        </div>
        <div>
          <span className="muted">{t("input.clicks")}</span>
          <strong className="num">{mouseReported ? fmtNumber(totals.clicks) : "—"}</strong>
        </div>
        <div>
          <span className="muted">{t("input.scrolls")}</span>
          <strong className="num">{mouseReported ? fmtNumber(totals.scrolls) : "—"}</strong>
        </div>
        <div>
          <span className="muted">{t("input.mouse")}</span>
          <strong className="num">{mouseReported ? fmtDistance(totals.mousePx) : "—"}</strong>
        </div>
      </div>
      {!mouseReported && buckets.length > 0 ? (
        <div className="alert alert-brand">
          <Icon name="info" />
          <span>{t("input.oldAgent")}</span>
        </div>
      ) : null}
      <div className="toolbar">
        <Segmented<InputMetric>
          value={metric}
          onChange={setMetric}
          label={t("input.metric")}
          options={[
            { value: "keys", label: t("input.keys") },
            { value: "clicks", label: t("input.clicks") },
            { value: "scrolls", label: t("input.scrolls") },
            { value: "mouse", label: t("input.mouse") },
          ]}
        />
        {values[peak] > 0 ? (
          <span className="muted">{t("input.peak", { time: fmtClock(dayStart + peak * 3600) })}</span>
        ) : null}
      </div>
      {buckets.length === 0 ? (
        <Empty icon="keyboard" title={t("input.none")}>
          {t("input.noneHint")}
        </Empty>
      ) : (
        <HourBars
          bars={bars}
          caption={t("input.perHour", { metric: label })}
          valueLabel={label}
          format={format}
          color={metric === "keys" ? "var(--chart-1)" : "var(--chart-2)"}
          height={200}
        />
      )}
      <p className="field-hint">
        <Icon name="shield" style={{ width: 14, height: 14, display: "inline", verticalAlign: "-2px" }} /> {t("input.privacy")}
      </p>
    </div>
  );
}

/* ---------- activity log ---------- */

function LogPanel({ data }: { data: DayData }) {
  const { t } = useTranslation("app");
  const [limit, setLimit] = useState(80);
  const log = useMemo(() => activityLog(data.activity.samples, data.visits), [data]);
  const calls = useMemo(
    () => deriveCommunicationSessions(data.activity.samples, data.visits, data.buckets),
    [data],
  );
  if (log.length === 0) {
    return <Empty icon="activity" title={t("log.none")}>{t("log.noneHint")}</Empty>;
  }
  return (
    <div className="grid grid-main-side" style={{ alignItems: "start" }}>
      <div>
        <ol className="log">
          {log.slice(0, limit).map((e) => {
            const href = e.url ? safeHref(e.url) : null;
            return (
              <li key={e.key} className={`log-row log-${e.kind}`}>
                <time className="log-time num">{fmtClock(e.ts)}</time>
                <span className="log-icon">
                  <Icon name={e.kind === "app" ? "app" : "globe"} />
                </span>
                <span className="log-main">
                  <span className="log-name ltr-auto">{e.name}</span>
                  {e.detail || e.url ? (
                    <span className="log-detail truncate ltr-auto">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer noopener">
                          {e.detail || e.url}
                        </a>
                      ) : (
                        e.detail
                      )}
                    </span>
                  ) : null}
                </span>
                <span className="log-dur num">{fmtDuration(e.duration)}</span>
              </li>
            );
          })}
        </ol>
        {log.length > limit ? (
          <button type="button" className="btn btn-sm" onClick={() => setLimit(limit + 120)} style={{ marginBlockStart: 12 }}>
            {t("log.more", { count: log.length - limit })}
          </button>
        ) : null}
      </div>
      <div className="glass card" style={{ boxShadow: "none" }}>
        <h3 className="card-title" style={{ marginBlockEnd: 4 }}>{t("log.callsTitle")}</h3>
        <p className="card-sub" style={{ marginBlockEnd: 14 }}>{t("log.callsSub")}</p>
        {calls.length === 0 ? (
          <p className="muted">{t("log.noCalls")}</p>
        ) : (
          <ul className="calls">
            {calls.slice(0, 12).map((c) => (
              <li key={`${c.ts}-${c.platform}`}>
                <span className={`badge ${c.evidence === "possible_call" ? "badge-warn" : c.evidence === "interacting" ? "badge-ok" : ""}`}>
                  <Icon name={c.evidence === "possible_call" ? "phone" : "activity"} />
                  {t(`log.evidence.${c.evidence}`)}
                </span>
                <span className="strong ltr-auto">{c.platform}</span>
                <span className="muted num">
                  {fmtClock(c.ts)} · {fmtDuration(c.duration_s)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
