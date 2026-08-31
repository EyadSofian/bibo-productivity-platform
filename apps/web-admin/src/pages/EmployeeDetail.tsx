import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  reportActivity,
  reportBrowser,
  reportEmployees,
  reportKeystrokes,
  reportPresence,
  reportScreenshots,
  requestLiveCapture,
} from "../api/endpoints";
import { fetchImageObjectUrl } from "../api/client";
import type {
  ActivityResponse,
  BrowserVisit,
  DeviceResourceSnapshot,
  EmployeePresence,
  KeystrokeBucket,
  ReportEmployee,
  ScreenshotMeta,
} from "../api/types";
import { ActivityPanel } from "../components/reports/ActivityPanel";
import { BrowserPanel } from "../components/reports/BrowserPanel";
import { KeystrokePanel } from "../components/reports/KeystrokePanel";
import { PlaybackPanel } from "../components/reports/PlaybackPanel";
import { ScreenshotGallery } from "../components/reports/ScreenshotGallery";
import { Notice, Spinner } from "../components/ui";
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

type Tab = "activity" | "keystrokes" | "browser" | "screenshots" | "playback";
const TABS: Tab[] = ["activity", "keystrokes", "browser", "screenshots", "playback"];

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
const IconKeyboard = svg(<><path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" /></>);
const IconCamera = svg(<><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" /></>);
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

function LiveScreen({
  employeeId,
  presence,
}: {
  employeeId: string;
  presence: EmployeePresence | null;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const [enabled, setEnabled] = useState(false);
  const [frame, setFrame] = useState<ScreenshotMeta | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<string | null>(null);
  const deviceId = presence?.device_id ?? null;
  const online = Boolean(deviceId && presence && presence.state !== "offline");

  useEffect(() => {
    let alive = true;
    setImageUrl(null);
    if (!frame) return () => {};

    fetchImageObjectUrl(frame.client_uuid)
      .then((url) => {
        if (imageRef.current) URL.revokeObjectURL(imageRef.current);
        imageRef.current = url;
        if (alive) setImageUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (alive) setError(t("detail.presence.liveView.imageError"));
      });

    return () => {
      alive = false;
    };
  }, [frame, t]);

  useEffect(() => () => {
    if (imageRef.current) URL.revokeObjectURL(imageRef.current);
  }, []);

  useEffect(() => {
    if (!enabled || !deviceId || !online) return;
    let alive = true;
    let requestedAt = 0;

    const requestFrame = async () => {
      try {
        const result = await requestLiveCapture(deviceId);
        if (!alive) return;
        requestedAt = result.requested_at;
        setWaiting(true);
        setError(null);
      } catch {
        if (alive) {
          setWaiting(false);
          setError(t("detail.presence.liveView.requestError"));
        }
      }
    };

    const pollFrame = async () => {
      // Do not label an older periodic screenshot as a live frame while the
      // one-shot request is still in flight.
      if (!requestedAt) return;
      try {
        const today = isoDate(new Date());
        const range = dayRangeToUnix(today, today);
        const result = await reportScreenshots(employeeId, range.from, range.to, 10);
        if (!alive || result.screenshots.length === 0) return;
        const fresh = result.screenshots.filter((shot) =>
          (!shot.device_id || shot.device_id === deviceId)
          && (shot.received_at ?? shot.ts) >= requestedAt - 5,
        );
        if (fresh.length === 0) return;
        const latest = fresh.reduce((a, b) =>
          (a.received_at ?? a.ts) >= (b.received_at ?? b.ts) ? a : b,
        );
        setFrame((current) => current?.client_uuid === latest.client_uuid ? current : latest);
        setWaiting(false);
        setError(null);
      } catch {
        if (alive) setError(t("detail.presence.liveView.imageError"));
      }
    };

    void requestFrame();
    void pollFrame();
    const requestTimer = window.setInterval(requestFrame, 20_000);
    const pollTimer = window.setInterval(pollFrame, 3_000);
    return () => {
      alive = false;
      window.clearInterval(requestTimer);
      window.clearInterval(pollTimer);
    };
  }, [deviceId, employeeId, enabled, online, t]);

  useEffect(() => {
    if (!online) {
      setEnabled(false);
      setWaiting(false);
    }
  }, [online]);

  const frameTime = frame
    ? new Date(frame.ts * 1000).toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <section className={`ad-live-screen${enabled ? " ad-live-screen--on" : ""}`}>
      <div className="ad-live-screen__head">
        <div>
          <span className="ad-live-screen__eyebrow">
            <i aria-hidden />
            {enabled ? t("detail.presence.liveView.live") : t("detail.presence.liveView.ready")}
          </span>
          <h2>{t("detail.presence.liveView.title")}</h2>
          <p>{t("detail.presence.liveView.description")}</p>
        </div>
        <button
          type="button"
          className={`bibo-btn ${enabled ? "bibo-btn--ghost" : "bibo-btn--primary"}`}
          disabled={!online}
          onClick={() => {
            setError(null);
            setEnabled((value) => !value);
          }}
        >
          {enabled ? t("detail.presence.liveView.stop") : t("detail.presence.liveView.start")}
        </button>
      </div>

      <div className="ad-live-screen__stage">
        {imageUrl ? (
          <img src={imageUrl} alt={t("detail.presence.liveView.frameAlt")} />
        ) : (
          <div className="ad-live-screen__empty">
            {waiting ? <Spinner label={t("detail.presence.liveView.waiting")} /> : <span>{online ? t("detail.presence.liveView.startHint") : t("detail.presence.liveView.offline")}</span>}
          </div>
        )}
        {enabled && imageUrl ? <span className="ad-live-screen__badge">{waiting ? t("detail.presence.liveView.refreshing") : t("detail.presence.liveView.live")}</span> : null}
      </div>

      <div className="ad-live-screen__foot">
        <span>{frameTime ? t("detail.presence.liveView.lastFrame", { time: frameTime }) : t("detail.presence.liveView.noFrame")}</span>
        <span>{t("detail.presence.liveView.readOnly")}</span>
      </div>
      {error ? <Notice kind="danger">{error}</Notice> : null}
    </section>
  );
}

function ResourceMeter({
  label,
  value,
  detail,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  percent: number;
}) {
  return (
    <div className="ad-resource-card">
      <div className="ad-resource-card__head">
        <span>{label}</span>
        <strong dir="ltr">{value}</strong>
      </div>
      <div
        className="ad-resource-meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <small dir="ltr">{detail}</small>
    </div>
  );
}

function LiveResources({ resources }: { resources: DeviceResourceSnapshot | null | undefined }) {
  const { t } = useTranslation("dashboard");
  if (!resources) return null;

  const cpu = usagePercent(resources.cpu_pct, 100);
  const memory = usagePercent(resources.memory_used_bytes, resources.memory_total_bytes);
  const disk = usagePercent(resources.disk_used_bytes, resources.disk_total_bytes);

  return (
    <section className="ad-resources" aria-labelledby="device-resource-title">
      <div className="ad-resources__intro">
        <h2 id="device-resource-title">{t("detail.presence.resources.title")}</h2>
        <p>{t("detail.presence.resources.wholeDevice")}</p>
      </div>
      <div className="ad-resources__grid">
        <ResourceMeter
          label={t("detail.presence.resources.cpu")}
          value={`${cpu}%`}
          detail={t("detail.presence.resources.current")}
          percent={cpu}
        />
        <ResourceMeter
          label={t("detail.presence.resources.memory")}
          value={`${memory}%`}
          detail={t("detail.presence.resources.of", {
            used: fmtBytes(resources.memory_used_bytes),
            total: fmtBytes(resources.memory_total_bytes),
          })}
          percent={memory}
        />
        <ResourceMeter
          label={t("detail.presence.resources.disk")}
          value={`${disk}%`}
          detail={t("detail.presence.resources.of", {
            used: fmtBytes(resources.disk_used_bytes),
            total: fmtBytes(resources.disk_total_bytes),
          })}
          percent={disk}
        />
        <div className="ad-resource-card ad-resource-card--network">
          <div className="ad-resource-card__head">
            <span>{t("detail.presence.resources.network")}</span>
          </div>
          <div className="ad-resource-network">
            <span>
              <small>{t("detail.presence.resources.download")}</small>
              <strong dir="ltr">↓ {fmtByteRate(resources.network_rx_bps)}</strong>
            </span>
            <span>
              <small>{t("detail.presence.resources.upload")}</small>
              <strong dir="ltr">↑ {fmtByteRate(resources.network_tx_bps)}</strong>
            </span>
          </div>
        </div>
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
  const { t } = useTranslation("dashboard");
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const businessId = params.get("business");
  const { businesses } = useBusinesses();
  const { user } = useAuth();
  const { setTitle } = useDetailHeader();
  const terms = memberTerms(businesses.find((b) => b.id === businessId)?.kind);

  // Single-day view by default; switch to "range" for a custom span.
  const [mode, setMode] = useState<"day" | "range">("day");
  const [day, setDay] = useState(() => isoDate(new Date()));
  const [from, setFrom] = useState(() => isoDate(new Date()));
  const [to, setTo] = useState(() => isoDate(new Date()));

  const [tab, setTab] = useState<Tab>("activity");

  const [employee, setEmployee] = useState<ReportEmployee | null>(null);
  const [presence, setPresence] = useState<EmployeePresence | null>(null);
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [keystrokes, setKeystrokes] = useState<KeystrokeBucket[] | null>(null);
  const [visits, setVisits] = useState<BrowserVisit[] | null>(null);
  const [shots, setShots] = useState<ScreenshotMeta[] | null>(null);

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

  const load = useCallback(async () => {
    if (!id) return;
    const [fromDate, toDate] = mode === "day" ? [day, day] : [from, to];
    const { from: f, to: to2 } = dayRangeToUnix(fromDate, toDate);
    if (f > to2) {
      setError(t("detail.errorStartAfterEnd"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [a, k, b, s] = await Promise.all([
        reportActivity(id, f, to2),
        reportKeystrokes(id, f, to2),
        reportBrowser(id, f, to2),
        reportScreenshots(id, f, to2),
      ]);
      setActivity(a);
      setKeystrokes(k.buckets);
      setVisits(b.visits);
      setShots(s.screenshots);
    } catch {
      setError(t("detail.errorRange"));
    } finally {
      setLoading(false);
    }
  }, [id, mode, day, from, to, t]);

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

      <LivePresence presence={presence} />
      <LiveResources resources={presence?.resources} />
      <LiveScreen employeeId={id} presence={presence} />

      {!businessId && <Notice kind="info">{t("detail.noBusinessContext")}</Notice>}
      {error && <Notice kind="danger">{error}</Notice>}

      {/* summary stat cards */}
      <div className="ad-stats">
        <StatCard
          focal
          icon={IconClock}
          label={mode === "day" ? t("detail.summary.activeTime") : t("detail.summary.activeTimeRange")}
          value={fmtDuration(activeS)}
          sub={mode === "day" ? t("detail.singleDay") : t("detail.dateRange")}
        />
        <StatCard
          icon={IconAppWindow}
          label={t("detail.summary.topApp")}
          value={topApp}
          delta={`${topShare}%`}
          sub={t("dashboard.statFocus")}
        />
        <StatCard
          icon={IconKeyboard}
          label={t("detail.summary.keypresses")}
          value={keypresses.toLocaleString()}
          sub={mode === "day" ? t("detail.singleDay") : t("detail.dateRange")}
        />
        <StatCard
          icon={IconCamera}
          label={t("detail.summary.screenshots")}
          value={(shots?.length ?? 0).toLocaleString()}
          sub={mode === "day" ? t("detail.singleDay") : t("detail.dateRange")}
        />
      </div>

      {/* tabs + panel */}
      <div className="ad-tabwrap">
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
                  (activity ? <ActivityPanel data={activity} /> : <Spinner />)}
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
                {tab === "playback" && activity && keystrokes && visits && shots ? (
                  <PlaybackPanel
                    shots={shots}
                    activity={activity}
                    visits={visits}
                    buckets={keystrokes}
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
