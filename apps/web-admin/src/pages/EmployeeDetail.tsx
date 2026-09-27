import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  ApiError,
  type ActivityResponse,
  type BrowserVisit,
  type EmployeePresence,
  type KeystrokeBucket,
  type OsStateReport,
  type ReportEmployee,
} from "../api/types";
import { DayVideoTab } from "../components/employee/DayVideoTab";
import { InputTab } from "../components/employee/InputTab";
import { RecordingStage, type SeekRequest } from "../components/employee/RecordingStage";
import { WorkTab } from "../components/employee/WorkTab";
import { isPlayable, type WorkItem } from "../components/employee/dayModel";
import { Notice } from "../components/ui";
import { dayRangeToUnix, fmtDuration, fmtRelative, isoDate } from "../format";
import { useBusinesses } from "../useBusinesses";
import { memberTerms } from "../terms";
import { useAuth } from "../auth/AuthContext";
import { useDetailHeader } from "../detailHeader";
import "./EmployeeDetail.css";

const DeviceLiveVideo = lazy(() => import("../components/LivePlayer/DeviceLiveVideo"));

type Tab = "work" | "video" | "input";
const TABS: Tab[] = ["work", "video", "input"];
type Screen = "live" | "recordings";

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

function shiftDay(value: string, days: number): string {
  const [y, m, d] = value.split("-").map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}

/**
 * One employee, one day. A single screen at the top shows either the live
 * desktop or the day's recordings; the three tabs underneath answer the three
 * questions an admin asks: what did they work in, show me the day, and how
 * active were they.
 */
export function EmployeeDetail() {
  const { t, i18n } = useTranslation("reports");
  const { t: td } = useTranslation("dashboard");
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const businessId = params.get("business");
  const { businesses } = useBusinesses();
  const { user } = useAuth();
  const { setTitle } = useDetailHeader();
  const terms = memberTerms(businesses.find((b) => b.id === businessId)?.kind);

  const initialSeek = Number(params.get("at"));
  const hasInitialSeek = Number.isFinite(initialSeek) && initialSeek > 0;
  const today = isoDate(new Date());
  const [day, setDay] = useState(() => isoDate(hasInitialSeek ? new Date(initialSeek * 1000) : new Date()));
  const [tab, setTab] = useState<Tab>(params.get("tab") === "playback" ? "video" : "work");
  const [screen, setScreen] = useState<Screen>(hasInitialSeek || day !== today ? "recordings" : "live");
  const [request, setRequest] = useState<SeekRequest | null>(hasInitialSeek ? { ts: initialSeek, n: 1 } : null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const stageRef = useRef<HTMLElement>(null);

  const [employee, setEmployee] = useState<ReportEmployee | null>(null);
  const [presence, setPresence] = useState<EmployeePresence | null>(null);
  const [presenceDenied, setPresenceDenied] = useState(false);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [keystrokes, setKeystrokes] = useState<KeystrokeBucket[] | null>(null);
  const [visits, setVisits] = useState<BrowserVisit[] | null>(null);
  const [states, setStates] = useState<OsStateReport | null>(null);
  const [recordings, setRecordings] = useState<RecordingAsset[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => dayRangeToUnix(day, day), [day]);
  const daySpan = useMemo(() => ({ start: range.from, end: range.to }), [range]);

  useEffect(() => {
    if (!businessId) return;
    reportEmployees(businessId)
      .then((r) => setEmployee(r.employees.find((e) => e.id === id) ?? null))
      .catch(() => {});
  }, [businessId, id]);

  useEffect(() => {
    setTitle(employee?.display_name ?? null);
    return () => setTitle(null);
  }, [employee, setTitle]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setRecordings(null);
    try {
      const [a, k, b, st] = await Promise.all([
        reportActivity(id, range.from, range.to),
        reportKeystrokes(id, range.from, range.to),
        reportBrowser(id, range.from, range.to),
        reportStates(id, range.from, range.to),
      ]);
      setActivity(a);
      setKeystrokes(k.buckets);
      setVisits(b.visits);
      setStates(st);
    } catch {
      setError(t("employee.errors.load"));
    } finally {
      setLoading(false);
    }
    // Recordings load on their own: a video outage must not blank the reports.
    listEmployeeRecordings(id, range.from, range.to)
      .then(({ recordings: found }) => setRecordings(found))
      .catch(() => setRecordings([]));
  }, [id, range, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // The desktop posts presence every 15 seconds; this refreshes one small object.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const refresh = () => {
      reportPresence(id)
        .then((result) => {
          if (!alive) return;
          setPresence(result.presence);
          setPresenceDenied(false);
        })
        .catch((err) => {
          if (!alive) return;
          setPresence(null);
          setPresenceDenied(err instanceof ApiError && err.status === 403);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [id]);

  const play = useCallback((ts: number, item: WorkItem | null = null) => {
    setRequest((current) => ({ ts, n: (current?.n ?? 0) + 1, label: item?.name ?? null }));
    setSelectedKey(item?.key ?? null);
    setScreen("recordings");
    stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const changeDay = (next: string) => {
    if (next > today) return;
    setDay(next);
    setRequest(null);
    setSelectedKey(null);
    setPlayhead(null);
    if (next !== today) setScreen("recordings");
  };

  const name = employee?.display_name ?? terms.one;
  const isSelf = employee?.role === "owner" || (!!employee && employee.id === user?.id);
  const state = presence?.state === "active" || presence?.state === "idle" ? presence.state : "offline";
  const online = state !== "offline";
  const lastSeen = presence?.seen_at ?? employee?.last_seen ?? null;

  const totals = states?.totals;
  const activeS = totals && totals.covered_s > 0
    ? totals.active_s
    : activity?.breakdown.reduce((sum, b) => sum + b.duration_s, 0) ?? 0;
  const topApp = activity ? [...activity.breakdown].sort((a, b) => b.duration_s - a.duration_s)[0] : undefined;
  const keys = keystrokes?.reduce((sum, b) => sum + b.count, 0) ?? 0;
  const playableCount = recordings?.filter(isPlayable).length ?? 0;
  const clock = (ts: number | null | undefined) =>
    ts == null ? null : new Date(ts * 1000).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="ev">
      <nav className="ev-crumb" aria-label={td("detail.breadcrumbDashboard")}>
        <Link to="/employees">{terms.many}</Link>
        <span aria-hidden>/</span>
        <span>{name}</span>
      </nav>

      <header className="ev-head">
        <div className="ev-id">
          <span className={`ev-avatar ev-avatar--${state}`} aria-hidden>{initials(name)}</span>
          <div>
            <h1>
              {name}
              {isSelf ? <span className="ev-self">{td("dashboard.selfBadge")}</span> : null}
            </h1>
            <p>
              <span className={`ev-pill ev-pill--${state}`}>
                <i aria-hidden />
                {t(`employee.status.${state}`)}
              </span>
              {!online && lastSeen ? <span className="ev-muted">{t("employee.status.lastSeen", { time: fmtRelative(lastSeen) })}</span> : null}
              {online && presence?.app ? <span className="ev-muted">{t("employee.status.using", { app: presence.app })}</span> : null}
            </p>
          </div>
        </div>

        <div className="ev-daynav" role="group" aria-label={t("employee.day.label")}>
          <button type="button" onClick={() => changeDay(shiftDay(day, -1))} aria-label={t("employee.day.prev")}>
            <span aria-hidden>‹</span>
          </button>
          <input type="date" value={day} max={today} onChange={(e) => e.target.value && changeDay(e.target.value)} aria-label={t("employee.day.label")} />
          <button type="button" onClick={() => changeDay(shiftDay(day, 1))} disabled={day >= today} aria-label={t("employee.day.next")}>
            <span aria-hidden>›</span>
          </button>
          {day !== today ? (
            <button type="button" className="ev-daynav__today" onClick={() => changeDay(today)}>{t("employee.day.today")}</button>
          ) : null}
        </div>
      </header>

      {!businessId ? <Notice kind="info">{td("detail.noBusinessContext")}</Notice> : null}
      {error ? <Notice kind="danger">{error}</Notice> : null}

      <section className="ev-top" ref={stageRef}>
        <div className="ev-stage">
          <div className="ev-stage__switch" role="tablist" aria-label={t("employee.stage.label")}>
            <button
              type="button"
              role="tab"
              aria-selected={screen === "live"}
              className={`ev-switch ev-switch--live${screen === "live" ? " is-on" : ""}`}
              onClick={() => setScreen("live")}
            >
              <i aria-hidden />
              {t("employee.stage.live")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={screen === "recordings"}
              className={`ev-switch${screen === "recordings" ? " is-on" : ""}`}
              onClick={() => setScreen("recordings")}
            >
              ▶ {t("employee.stage.recordings")}
              {recordings ? <small>{playableCount}</small> : null}
            </button>
          </div>
          <div className="ev-stage__screen">
            {screen === "live" ? (
              presence?.device_id ? (
                <Suspense fallback={<div className="ev-stage__empty"><span className="ev-spinner" aria-hidden /></div>}>
                  <DeviceLiveVideo key={presence.device_id} deviceId={presence.device_id} online={online} />
                </Suspense>
              ) : (
                <div className="ev-stage__empty">
                  <strong>{presenceDenied ? t("employee.now.denied") : t("employee.stage.noDevice")}</strong>
                </div>
              )
            ) : (
              <RecordingStage recordings={recordings} request={request} activity={activity} onTime={setPlayhead} />
            )}
          </div>
        </div>

        <aside className="ev-side">
          <div className={`ev-now ev-now--${state}`}>
            <span className="ev-now__label">{t("employee.now.title")}</span>
            {presenceDenied ? (
              <p className="ev-muted">{t("employee.now.denied")}</p>
            ) : online ? (
              <>
                <strong title={presence?.app ?? undefined}>{presence?.app || t("employee.now.noApp")}</strong>
                {presence?.window_title ? <small title={presence.window_title}>{presence.window_title}</small> : null}
              </>
            ) : (
              <strong>{t("employee.status.offline")}</strong>
            )}
          </div>
          <dl className="ev-kpis">
            <div>
              <dt>{t("employee.stats.active")}</dt>
              <dd><bdi dir="ltr">{fmtDuration(activeS)}</bdi></dd>
              <small>
                {states?.first_activity
                  ? <><bdi>{clock(states.first_activity)}</bdi> – <bdi>{clock(states.last_activity) ?? "…"}</bdi></>
                  : t("employee.stats.none")}
              </small>
            </div>
            <div>
              <dt>{t("employee.stats.idle")}</dt>
              <dd><bdi dir="ltr">{totals && totals.covered_s > 0 ? fmtDuration(totals.idle_s) : "—"}</bdi></dd>
            </div>
            <div>
              <dt>{t("employee.stats.topApp")}</dt>
              <dd className="ev-kpis__text" title={topApp?.app_name}>{topApp?.app_name ?? "—"}</dd>
              {topApp ? <small><bdi dir="ltr">{fmtDuration(topApp.duration_s)}</bdi></small> : null}
            </div>
            <div>
              <dt>{t("employee.stats.keys")}</dt>
              <dd>{keys.toLocaleString(i18n.language)}</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className="ev-panel">
        <div className="ev-tabs" role="tablist" aria-label={t("employee.tabs.label")}>
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`ev-tab-${key}`}
              aria-selected={tab === key}
              aria-controls="ev-tabpanel"
              className={tab === key ? "is-on" : ""}
              onClick={() => setTab(key)}
            >
              <span className="ev-tabs__num" aria-hidden>{TABS.indexOf(key) + 1}</span>
              <span>
                <strong>{t(`employee.tabs.${key}`)}</strong>
                <small>{t(`employee.tabs.${key}Hint`)}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="ev-tabpanel" id="ev-tabpanel" role="tabpanel" aria-labelledby={`ev-tab-${tab}`}>
          {loading ? (
            <div className="ev-empty"><span className="ev-spinner" aria-hidden />{t("employee.loading")}</div>
          ) : error ? null : (
            <>
              {tab === "work" && activity && visits ? (
                <WorkTab
                  activity={activity}
                  visits={visits}
                  recordings={recordings ?? []}
                  selectedKey={selectedKey}
                  onPlay={(ts, item) => play(ts, item)}
                />
              ) : null}
              {tab === "video" ? (
                <DayVideoTab
                  day={daySpan}
                  recordings={recordings ?? []}
                  activity={activity}
                  playhead={screen === "recordings" ? playhead : null}
                  onPlay={(ts) => play(ts)}
                />
              ) : null}
              {tab === "input" && keystrokes ? (
                <InputTab day={daySpan} buckets={keystrokes} states={states} />
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
