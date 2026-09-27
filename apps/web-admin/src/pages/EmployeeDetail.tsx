import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  reportActivity,
  reportBrowser,
  reportEmployees,
  reportKeystrokes,
  reportPresence,
  reportScreenshots,
  reportStates,
} from "../api/endpoints";
import type {
  ActivityResponse,
  BrowserVisit,
  DeviceResourceSnapshot,
  EmployeePresence,
  KeystrokeBucket,
  OsStateReport,
  ReportEmployee,
  ScreenshotMeta,
} from "../api/types";
import { ActivityPanel } from "../components/reports/ActivityPanel";
import { BrowserPanel } from "../components/reports/BrowserPanel";
import { rollupByDomain } from "../components/reports/rollup";
import { CommunicationEvidencePanel } from "../components/reports/CommunicationEvidencePanel";
import { KeystrokePanel } from "../components/reports/KeystrokePanel";
import { PlaybackPanel } from "../components/reports/PlaybackPanel";
import { UnifiedTimeline } from "../components/reports/UnifiedTimeline";
import { ScreenshotGallery } from "../components/reports/ScreenshotGallery";
import { Notice, SectionTitle, Spinner } from "../components/ui";
import {
  dayRangeToUnix,
  fmtByteRate,
  fmtBytes,
  fmtDuration,
  isoDate,
  usagePercent,
} from "../format";
import { useBusinesses } from "../useBusinesses";
import { memberTerms } from "../terms";
import { useAuth } from "../auth/AuthContext";
import { useDetailHeader } from "../detailHeader";

const DeviceLiveVideo = lazy(() => import("../components/LivePlayer/DeviceLiveVideo"));

type Tab = "activity" | "communications" | "keystrokes" | "browser" | "screenshots" | "playback";
// Apps first, then their recordings: the admin's question is "what did they
// do, and show me". Historical screenshots stay reachable, last.
const TABS: Tab[] = [
  "activity",
  "playback",
  "browser",
  "keystrokes",
  "communications",
  "screenshots",
];

// ── inline icons (no icon dependency in web-admin) ───────────────────
const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IconChevron = svg(<path d="m9 18 6-6-6-6" />);
const IconCalendar = svg(<><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /></>);
const IconClock = svg(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>);
const IconAppWindow = svg(<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 4v4" /><path d="M2 8h20" /><path d="M6 4v4" /></>);
const IconPause = svg(<><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>);
const TrendUp = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

type Status = "active" | "idle" | "offline";
function memberStatus(lastSeen: number | null): Status {
  if (!lastSeen) return "offline";
  const ageS = Date.now() / 1000 - lastSeen;
  if (ageS < 5 * 60) return "active";
  if (ageS < 30 * 60) return "idle";
  return "offline";
}

function LivePresence({ presence }: { presence: EmployeePresence | null }) {
  const { t, i18n } = useTranslation("dashboard");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const state = presence?.state ?? "offline";
  const seen = presence?.seen_at
    ? new Date(presence.seen_at * 1000).toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;
  const onlineFor = presence?.session_started_at && state !== "offline"
    ? fmtDuration(Math.max(0, now - presence.session_started_at))
    : null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className={`ad-live-presence ad-live-presence--${state}`} aria-live="polite">
      <span className="ad-live-presence__dot" aria-hidden="true" />
      <div className="ad-live-presence__state">
        <strong>{t(`detail.presence.states.${state}`)}</strong>
        <span>
          {seen
            ? t("detail.presence.updated", { time: seen })
            : t("detail.presence.waiting")}
        </span>
      </div>
      <div className="ad-live-presence__now">
        <span>{t("detail.presence.openNow")}</span>
        <strong>{presence?.app || t("detail.presence.noCurrentApp")}</strong>
        {presence?.window_title ? (
          <small title={presence.window_title}>{presence.window_title}</small>
        ) : null}
      </div>
      {onlineFor ? (
        <div className="ad-live-presence__since">
          <span>{t("detail.presence.onlineFor")}</span>
          <strong>
            <bdi dir="ltr">{onlineFor}</bdi>
          </strong>
        </div>
      ) : null}
    </section>
  );
}

/** Device load as one compact list: useful for "why is it slow", never the
 *  headline of the page. */
function LiveResources({ resources }: { resources: DeviceResourceSnapshot | null | undefined }) {
  const { t } = useTranslation("dashboard");
  if (!resources) return null;

  const cpu = usagePercent(resources.cpu_pct, 100);
  const memory = usagePercent(resources.memory_used_bytes, resources.memory_total_bytes);
  const disk = usagePercent(resources.disk_used_bytes, resources.disk_total_bytes);
  const row = (label: string, percent: number, detail: string) => (
    <div className="ad-resource-row">
      <span>{label}</span>
      <span className="ad-resource-row__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </span>
      <strong dir="ltr" title={detail}>{percent}%</strong>
    </div>
  );

  return (
    <section className="ad-resources ad-resources--compact" aria-labelledby="device-resource-title">
      <h2 id="device-resource-title">{t("detail.presence.resources.title")}</h2>
      {row(t("detail.presence.resources.cpu"), cpu, t("detail.presence.resources.current"))}
      {row(t("detail.presence.resources.memory"), memory, t("detail.presence.resources.of", {
        used: fmtBytes(resources.memory_used_bytes),
        total: fmtBytes(resources.memory_total_bytes),
      }))}
      {row(t("detail.presence.resources.disk"), disk, t("detail.presence.resources.of", {
        used: fmtBytes(resources.disk_used_bytes),
        total: fmtBytes(resources.disk_total_bytes),
      }))}
      <div className="ad-resource-row ad-resource-row--net">
        <span>{t("detail.presence.resources.network")}</span>
        <strong dir="ltr">↓ {fmtByteRate(resources.network_rx_bps)} · ↑ {fmtByteRate(resources.network_tx_bps)}</strong>
      </div>
    </section>
  );
}

// ── detail stat card (no sparkline — matches the detail layout) ──────
function StatCard(props: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  focal?: boolean;
  delta?: string;
  sub?: string;
}) {
  const { icon, label, value, focal, delta, sub } = props;
  return (
    <div className={`bibo-card ${focal ? "bibo-card--focal" : "bibo-card--default"} ad-cardpad`}>
      <div className={`bibo-stat${focal ? " bibo-stat--focal" : ""}`}>
        <div className="bibo-stat__top">
          <div className="bibo-stat__icon">{icon}</div>
          <div className="bibo-stat__label">{label}</div>
        </div>
        <div className="bibo-stat__value">
          <bdi dir="ltr">{value}</bdi>
        </div>
        <div className="bibo-stat__foot">
          {delta && (
            <span className="bibo-stat__delta bibo-stat__delta--up">
              {TrendUp}
              <bdi dir="ltr">{delta}</bdi>
            </span>
          )}
          {sub && <span className="bibo-stat__sub">{sub}</span>}
        </div>
      </div>
    </div>
  );
}

export function EmployeeDetail() {
  const { t, i18n } = useTranslation("dashboard");
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const businessId = params.get("business");
  const { businesses } = useBusinesses();
  const { user } = useAuth();
  const { setTitle } = useDetailHeader();
  const terms = memberTerms(businesses.find((b) => b.id === businessId)?.kind);

  // Single-day view by default; switch to "range" for a custom span.
  const [mode, setMode] = useState<"day" | "range">("day");
  const initialSeek = Number(params.get("at"));
  const hasInitialSeek = Number.isFinite(initialSeek) && initialSeek > 0;
  const [day, setDay] = useState(() => isoDate(hasInitialSeek ? new Date(initialSeek * 1000) : new Date()));
  const [from, setFrom] = useState(() => isoDate(new Date()));
  const [to, setTo] = useState(() => isoDate(new Date()));

  const [tab, setTab] = useState<Tab>(params.get("tab") === "playback" ? "playback" : "activity");
  // Set by a timeline or app click: switches to the player and points it at a
  // moment. `n` changes on every request so asking again rewinds.
  const [seek, setSeek] = useState<{ ts: number; n: number } | null>(hasInitialSeek ? { ts: initialSeek, n: 0 } : null);
  const [focusApp, setFocusApp] = useState<string | null>(null);
  const play = useCallback((ts: number, app: string | null) => {
    setSeek((current) => ({ ts, n: (current?.n ?? 0) + 1 }));
    setFocusApp(app);
    setTab("playback");
  }, []);

  const [employee, setEmployee] = useState<ReportEmployee | null>(null);
  const [presence, setPresence] = useState<EmployeePresence | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [keystrokes, setKeystrokes] = useState<KeystrokeBucket[] | null>(null);
  const [visits, setVisits] = useState<BrowserVisit[] | null>(null);
  const [shots, setShots] = useState<ScreenshotMeta[] | null>(null);
  const [states, setStates] = useState<OsStateReport | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the employee's identity from the roster (for the header).
  useEffect(() => {
    if (!businessId) return;
    reportEmployees(businessId)
      .then((r) => setEmployee(r.employees.find((e) => e.id === id) ?? null))
      .catch(() => {});
  }, [businessId, id]);

  // Push the member's name into the app header (replaces the section label);
  // cleared on unmount so other pages keep their own title.
  useEffect(() => {
    setTitle(employee?.display_name ?? null);
    return () => setTitle(null);
  }, [employee, setTitle]);

  // The exact window the reports were loaded for. The timeline must lay blocks
  // out against this and not recompute it, or a block would drift from the
  // numbers in the cards above it.
  const rangeUnix = useMemo(() => {
    const [fromDate, toDate] = mode === "day" ? [day, day] : [from, to];
    return dayRangeToUnix(fromDate, toDate);
  }, [mode, day, from, to]);

  const load = useCallback(async () => {
    if (!id) return;
    const { from: f, to: to2 } = rangeUnix;
    if (f > to2) {
      setError(t("detail.errorStartAfterEnd"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [a, k, b, s, st] = await Promise.all([
        reportActivity(id, f, to2),
        reportKeystrokes(id, f, to2),
        reportBrowser(id, f, to2),
        reportScreenshots(id, f, to2),
        reportStates(id, f, to2),
      ]);
      setActivity(a);
      setKeystrokes(k.buckets);
      setVisits(b.visits);
      setShots(s.screenshots);
      setStates(st);
    } catch {
      setError(t("detail.errorRange"));
    } finally {
      setLoading(false);
    }
  }, [id, rangeUnix, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Presence is independent of historical reports. The desktop posts every
  // 15 seconds; this small poll refreshes only one lightweight JSON object.
  useEffect(() => {
    if (!id) return;
    let live = true;
    const refresh = () => {
      reportPresence(id)
        .then((result) => {
          if (live) setPresence(result.presence);
        })
        .catch(() => {
          if (live) setPresence(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [id]);

  const today = isoDate(new Date());

  // Summary stats for the selected day/range, derived from the loaded data.
  const activeS = activity?.breakdown.reduce((sum, b) => sum + b.duration_s, 0) ?? 0;
  const topApp = activity?.breakdown[0]?.app_name ?? "—";
  const topAppS = activity?.breakdown[0]?.duration_s ?? 0;
  const keypresses = keystrokes?.reduce((sum, b) => sum + b.count, 0) ?? 0;
  // Top app's share of active time (real) — shown as the "focus" chip.
  const topShare = activeS > 0 ? Math.round((topAppS / activeS) * 100) : 0;
  // NOTE: topShare stays relative to activity_samples' own total, because both
  // numerator and denominator come from that table. Mixing sources here would
  // produce a percentage that silently exceeds 100%.

  // Time budget from the device-state timeline. `activity_samples` only records
  // active foreground intervals, so idle, suspended and total device time can
  // only come from here. Null until loaded — never substituted with a guess.
  const totals = states?.totals ?? null;
  const sites = useMemo(() => rollupByDomain(visits ?? []), [visits]);
  const topSite = sites[0];
  const deviceS = totals ? totals.active_s + totals.idle_s + totals.suspended_s : null;
  // The timeline is authoritative for the time budget when it has data, so the
  // cards cannot contradict each other. It measures active time device-wide,
  // whereas activity_samples only accrues while a foreground window is
  // identifiable — two honest numbers that would otherwise disagree on screen.
  //
  // Agents older than the timeline report nothing here; falling back to the
  // activity sum keeps their dashboards working instead of showing a bare zero.
  const hasTimeline = !!totals && totals.covered_s > 0;
  const budgetActiveS = hasTimeline ? totals.active_s : activeS;

  const clockTime = (unix: number | null | undefined) =>
    unix == null
      ? null
      : new Date(unix * 1000).toLocaleTimeString(i18n.language, {
          hour: "2-digit",
          minute: "2-digit",
        });

  const name = employee?.display_name ?? terms.one;
  const isSelf = employee?.role === "owner" || (!!employee && employee.id === user?.id);
  const status: Status = presence?.state === "active" || presence?.state === "idle"
    ? presence.state
    : memberStatus(employee?.last_seen ?? null);

  const dateInput = (value: string, onChange: (v: string) => void, min?: string, max?: string) => (
    <input type="date" value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} />
  );

  return (
    <div className="ad-wrap" style={{ paddingBottom: 32 }}>
      {/* breadcrumb */}
      <div className="ad-crumb">
        <Link to="/">{t("detail.breadcrumbDashboard")}</Link>
        <span style={{ display: "inline-flex", lineHeight: 0 }}>{IconChevron}</span>
        <span>{terms.many}</span>
        <span style={{ display: "inline-flex", lineHeight: 0 }}>{IconChevron}</span>
        <span className="ad-crumb__here">{name}</span>
      </div>

      {/* detail header */}
      <div className="ad-detailhead">
        <span className="bibo-avatar" style={{ ["--_s" as string]: "48px" }}>
          <span
            className="bibo-avatar__img"
            aria-label={name}
            style={{ background: "var(--info-soft)", color: "var(--info)" }}
          >
            {initials(name)}
          </span>
          <span className={`bibo-avatar__dot bibo-avatar__dot--${status}`} />
        </span>
        <div className="ad-detailhead__id">
          <div className="ad-detailhead__name">
            {name}
            {isSelf && <span className="ad-self">{t("dashboard.selfBadge")}</span>}
          </div>
          {employee && (
            <div className="ad-detailhead__login">{employee.email || employee.username}</div>
          )}
        </div>

        <div className="ad-datemode">
          <div className="bibo-seg bibo-seg--sm" role="tablist" aria-label={t("detail.dateMode")}>
            <button
              role="tab"
              aria-selected={mode === "day"}
              className={`bibo-seg__opt${mode === "day" ? " bibo-seg__opt--on" : ""}`}
              onClick={() => setMode("day")}
            >
              {t("detail.singleDay")}
            </button>
            <button
              role="tab"
              aria-selected={mode === "range"}
              className={`bibo-seg__opt${mode === "range" ? " bibo-seg__opt--on" : ""}`}
              onClick={() => setMode("range")}
            >
              {t("detail.dateRange")}
            </button>
          </div>

          {mode === "day" ? (
            <span className="ad-datefield">
              <span style={{ display: "inline-flex", lineHeight: 0 }}>{IconCalendar}</span>
              {dateInput(day, setDay, undefined, today)}
            </span>
          ) : (
            <>
              <span className="ad-datefield">
                <span className="ad-datefield__lbl">{t("detail.from")}</span>
                {dateInput(from, setFrom, undefined, to)}
              </span>
              <span className="ad-datefield">
                <span className="ad-datefield__lbl">{t("detail.to")}</span>
                {dateInput(to, setTo, from, today)}
              </span>
            </>
          )}
        </div>
      </div>

      {!businessId && <Notice kind="info">{t("detail.noBusinessContext")}</Notice>}
      {error && <Notice kind="danger">{error}</Notice>}

      {/* summary: the four numbers an admin reads first */}
      <div className="ad-stats">
        <StatCard
          focal
          icon={IconClock}
          label={mode === "day" ? t("detail.summary.activeTime") : t("detail.summary.activeTimeRange")}
          value={fmtDuration(budgetActiveS)}
          sub={
            states?.first_activity
              ? `${clockTime(states.first_activity)} – ${clockTime(states.last_activity) ?? "…"}`
              : t("detail.summary.noActivity")
          }
        />
        <StatCard
          icon={IconPause}
          label={t("detail.summary.deviceTime")}
          value={hasTimeline && deviceS !== null ? fmtDuration(deviceS) : "—"}
          sub={hasTimeline ? `${t("detail.summary.idleTime")} ${fmtDuration(totals.idle_s)}` : undefined}
        />
        <StatCard
          icon={IconAppWindow}
          label={t("detail.summary.topApp")}
          value={topApp}
          sub={activeS > 0 ? `${fmtDuration(topAppS)} · ${topShare}%` : t("detail.summary.noActivity")}
        />
        <StatCard
          icon={IconAppWindow}
          label={t("detail.summary.topSite")}
          value={topSite?.domain ?? "—"}
          sub={topSite ? fmtDuration(topSite.totalS) : t("detail.insights.browserHint")}
        />
      </div>

      <section className="ad-insights" aria-label={t("detail.insights.title")}>
        <div className="ad-insights__head">
          <div><span className="ad-insights__eyebrow">{t("detail.insights.eyebrow")}</span><h2>{t("detail.insights.title")}</h2></div>
          <p>{t("detail.insights.description")}</p>
        </div>
        <div className="ad-insights__actions">
          <button type="button" onClick={() => { setTab("activity"); document.getElementById("employee-reports")?.scrollIntoView({ behavior: "smooth" }); }}>{t("detail.insights.appsAction")} <span aria-hidden="true">↗</span></button>
          <button type="button" onClick={() => { setTab("browser"); document.getElementById("employee-reports")?.scrollIntoView({ behavior: "smooth" }); }}>{t("detail.insights.sitesAction")} <span aria-hidden="true">↗</span></button>
          <span>{t("detail.summary.keypresses")}: {keypresses.toLocaleString(i18n.language)}</span>
        </div>
      </section>

      <details className="ad-live-details">
        <summary><span>{t("detail.insights.liveAction")}</span><span aria-hidden="true">⌄</span></summary>
        <div className="ad-command-deck">
          {presence?.device_id ? (
            <Suspense fallback={<Spinner />}>
              <DeviceLiveVideo key={presence.device_id} deviceId={presence.device_id} online={presence.state !== "offline"} />
            </Suspense>
          ) : <Notice kind="info">{t("detail.presence.waiting")}</Notice>}
          <div className="ad-command-deck__telemetry">
            <LivePresence presence={presence} />
            <LiveResources resources={presence?.resources} />
          </div>
        </div>
      </details>

      {/* Unified timeline: the five reports below share one axis here, so a
          vertical slice answers "what was happening at 14:20" without moving
          between tabs. Clicking anything opens the player at that moment. */}
      <div className="bibo-card bibo-card--default ad-cardpad" style={{ marginBottom: "var(--sp-4)" }}>
        <SectionTitle>{t("detail.timelineTitle")}</SectionTitle>
        {loading ? (
          <Spinner label={t("detail.loadingReports")} />
        ) : error ? null : (
          <UnifiedTimeline
            from={rangeUnix.from}
            to={rangeUnix.to}
            states={states}
            activity={activity}
            buckets={keystrokes}
            visits={visits}
            shots={shots}
            onSeek={(ts) => play(ts, null)}
          />
        )}
      </div>

      {/* tabs + panel */}
      <div className="ad-tabwrap" id="employee-reports">
        <div className="bibo-tabs bibo-tabs--pill" role="tablist">
          {TABS.map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              className={`bibo-tab${tab === key ? " bibo-tab--on" : ""}`}
              onClick={() => setTab(key)}
            >
              {t(`detail.tabs.${key}`)}
            </button>
          ))}
        </div>

        <div className="ad-panel">
          {loading ? (
            <Spinner label={t("detail.loadingReports")} />
          ) : (
            !error && (
              <>
                {tab === "activity" &&
                  (activity ? <ActivityPanel data={activity} onPlay={(ts, app) => play(ts, app)} /> : <Spinner />)}
                {tab === "communications" && activity && visits && keystrokes ? (
                  <CommunicationEvidencePanel
                    activity={activity}
                    visits={visits}
                    keystrokes={keystrokes}
                  />
                ) : null}
                {/* Browser panel renders its own table card */}
                {tab === "browser" && (visits ? <BrowserPanel visits={visits} /> : <Spinner />)}
                {(tab === "keystrokes" || tab === "screenshots") && (
                  <div className="bibo-card bibo-card--default ad-cardpad">
                    {tab === "keystrokes" &&
                      (keystrokes ? <KeystrokePanel buckets={keystrokes} /> : <Spinner />)}
                    {tab === "screenshots" &&
                      (shots ? <ScreenshotGallery shots={shots} /> : <Spinner />)}
                  </div>
                )}
                {tab === "playback" && activity && keystrokes && visits ? (
                  <PlaybackPanel
                    employeeId={id}
                    from={rangeUnix.from}
                    to={rangeUnix.to}
                    activity={activity}
                    visits={visits}
                    buckets={keystrokes}
                    seekTo={seek?.ts ?? null}
                    seekNonce={seek?.n}
                    focusApp={focusApp}
                    onClearFocus={() => setFocusApp(null)}
                  />
                ) : null}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
