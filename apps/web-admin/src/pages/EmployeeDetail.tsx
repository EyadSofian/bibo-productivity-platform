import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  createRemoteAssist,
  endRemoteAssist,
  getRemoteAssist,
  reportActivity,
  reportBrowser,
  reportEmployees,
  reportKeystrokes,
  reportPresence,
  reportScreenshots,
  reportStates,
  sendRemoteAssistAction,
} from "../api/endpoints";
import { subscribeDeviceLiveFrames, subscribeRemoteAssistFrames } from "../api/client";
import type {
  ActivityResponse,
  BrowserVisit,
  DeviceResourceSnapshot,
  EmployeePresence,
  KeystrokeBucket,
  OsStateReport,
  ReportEmployee,
  RemoteAssistSession,
  ScreenshotMeta,
} from "../api/types";
import { ActivityPanel } from "../components/reports/ActivityPanel";
import { BrowserPanel } from "../components/reports/BrowserPanel";
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

type Tab = "activity" | "communications" | "keystrokes" | "browser" | "screenshots" | "playback";
const TABS: Tab[] = [
  "activity",
  "communications",
  "keystrokes",
  "browser",
  "screenshots",
  "playback",
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
const IconKeyboard = svg(<><path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" /></>);
const IconCamera = svg(<><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" /></>);
const IconPause = svg(<><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>);
const IconMonitor = svg(<><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>);
const IconSunrise = svg(<><path d="M12 2v6" /><path d="m4.93 8.93 1.41 1.41" /><path d="M2 18h2" /><path d="M20 18h2" /><path d="m17.66 10.34 1.41-1.41" /><path d="M22 22H2" /><path d="m8 6 4-4 4 4" /><path d="M16 18a4 4 0 0 0-8 0" /></>);
const IconGlobe = svg(<><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>);
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
  presence,
}: {
  presence: EmployeePresence | null;
}) {
  const { t, i18n } = useTranslation("dashboard");
  const [enabled, setEnabled] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [frameAt, setFrameAt] = useState<Date | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteSession, setRemoteSession] = useState<RemoteAssistSession | null>(null);
  const [remoteFrameUrl, setRemoteFrameUrl] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [keyboardEnabled, setKeyboardEnabled] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const consecutiveFailures = useRef(0);
  const deviceId = presence?.device_id ?? null;
  const online = Boolean(deviceId && presence && presence.state !== "offline");
  const remoteOpen = remoteSession?.status === "pending" || remoteSession?.status === "active";
  const remoteActive = remoteSession?.status === "active";

  // The live screen is a pushed stream, not a poll. Holding it open is also what
  // keeps the agent capturing: the backend renews the agent's authorization while
  // a viewer is attached, and the agent stops on its own when renewals stop. That
  // replaces a 20s frame request + 3s discovery poll that together capped the
  // live view at one frame per 20 seconds (FULL_SYSTEM_AUDIT P0-1).
  //
  // These frames are ephemeral and are never stored; scheduled screenshots stay
  // on their own policy schedule and are unaffected by watching.
  useEffect(() => {
    if (!enabled || !deviceId || !online || remoteOpen) {
      setWaiting(false);
      return;
    }
    let alive = true;
    setWaiting(true);
    setFallbackActive(false);
    setError(null);
    consecutiveFailures.current = 0;

    const unsubscribe = subscribeDeviceLiveFrames(deviceId, {
      onFrame: (frame) => {
        if (!alive) return;
        setImageUrl(`data:image/webp;base64,${frame.image}`);
        setFrameAt(new Date(frame.received_at));
        consecutiveFailures.current = 0;
        setFallbackActive(false);
        setWaiting(false);
        setError(null);
      },
      onEnd: () => {
        if (alive) setWaiting(false);
      },
      onAgentUnreachable: () => {
        // The desktop now has an authenticated HTTPS status fallback for this
        // exact condition. Keep waiting instead of presenting an offline error:
        // the first frame should arrive after its next low-rate status check.
        if (alive) setFallbackActive(true);
      },
      onError: () => {
        if (!alive) return;
        consecutiveFailures.current += 1;
        // A laptop can miss a beat while sleeping or switching networks. Keep the
        // last good frame visible and only surface a persistent issue.
        if (consecutiveFailures.current >= 2) {
          setError(t("detail.presence.liveView.requestError"));
        }
      },
    });

    return () => {
      alive = false;
      unsubscribe();
      setWaiting(false);
      setFallbackActive(false);
    };
  }, [deviceId, enabled, online, remoteOpen, t]);

  useEffect(() => {
    if (!remoteOpen || !remoteSession) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await getRemoteAssist(remoteSession.id);
        if (!alive) return;
        setRemoteSession(result.session);
        setRemoteError(null);
        if (result.session.status !== "active") setKeyboardEnabled(false);
      } catch {
        if (alive) setRemoteError(t("detail.presence.liveView.remoteError"));
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [remoteOpen, remoteSession?.id, t]);

  // Live frames arrive over a pushed stream rather than a 900ms poll, so a
  // frame renders as soon as the agent uploads it. Frames come through as
  // base64 data URLs, which also removes the object-URL lifecycle (and the leak
  // that came with it) from this path entirely.
  useEffect(() => {
    if (!remoteActive || !remoteSession) {
      setRemoteFrameUrl(null);
      return;
    }
    let alive = true;
    const unsubscribe = subscribeRemoteAssistFrames(remoteSession.id, {
      onFrame: (frame) => {
        if (!alive) return;
        setRemoteFrameUrl(`data:image/webp;base64,${frame.image}`);
        setRemoteError(null);
      },
      onEnd: () => {
        if (!alive) return;
        setRemoteFrameUrl(null);
      },
      onError: () => {
        if (!alive) return;
        setRemoteError(t("detail.presence.liveView.remoteError"));
      },
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [remoteActive, remoteSession?.id, t]);

  useEffect(() => {
    if (!online) {
      setEnabled(false);
      setWaiting(false);
      setFallbackActive(false);
    }
  }, [online]);

  async function startRemoteAssist() {
    if (!deviceId || remoteBusy) return;
    setRemoteBusy(true);
    setEnabled(false);
    setRemoteError(null);
    try {
      const result = await createRemoteAssist(deviceId);
      setRemoteSession(result.session);
    } catch {
      setRemoteError(t("detail.presence.liveView.remoteError"));
    } finally {
      setRemoteBusy(false);
    }
  }

  async function stopRemoteAssist() {
    if (!remoteSession || remoteBusy) return;
    setRemoteBusy(true);
    try {
      const result = await endRemoteAssist(remoteSession.id);
      setRemoteSession(result.session);
      setKeyboardEnabled(false);
    } catch {
      setRemoteError(t("detail.presence.liveView.remoteError"));
    } finally {
      setRemoteBusy(false);
    }
  }

  function sendRemoteInput(action: Parameters<typeof sendRemoteAssistAction>[1]) {
    if (!remoteActive || !remoteSession) return;
    void sendRemoteAssistAction(remoteSession.id, action).catch(() => {
      setRemoteError(t("detail.presence.liveView.remoteError"));
    });
  }

  function clickRemoteFrame(event: React.MouseEvent<HTMLDivElement>) {
    if (!remoteActive || !remoteFrameUrl) return;
    const image = event.currentTarget.querySelector("img");
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    sendRemoteInput({ kind: "click", payload: { x, y, button: "left" } });
    if (keyboardEnabled) stageRef.current?.focus();
  }

  function typeOnRemote(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!remoteActive || !keyboardEnabled) return;
    const supported = new Set([
      "Enter", "Tab", "Escape", "Backspace", "Delete",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    ]);
    if (supported.has(event.key)) {
      event.preventDefault();
      sendRemoteInput({ kind: "key", payload: { key: event.key } });
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      sendRemoteInput({ kind: "text", payload: { text: event.key } });
    }
  }

  const frameTime = frameAt
    ? frameAt.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const displayedImage = remoteActive ? remoteFrameUrl : imageUrl;

  return (
    <section className={`ad-live-screen${enabled || remoteActive ? " ad-live-screen--on" : ""}${remoteActive ? " ad-live-screen--remote" : ""}`}>
      <div className="ad-live-screen__head">
        <div>
          <span className="ad-live-screen__eyebrow">
            <i aria-hidden />
            {remoteActive
              ? t("detail.presence.liveView.remoteActive")
              : remoteSession?.status === "pending"
                ? t("detail.presence.liveView.remotePending")
                : enabled
                  ? t("detail.presence.liveView.live")
                  : t("detail.presence.liveView.ready")}
          </span>
          <h2>{t("detail.presence.liveView.title")}</h2>
          <p>{t("detail.presence.liveView.description")}</p>
        </div>
        <div className="ad-live-screen__actions">
          {displayedImage ? (
            <button
              type="button"
              className="ad-live-screen__expand"
              aria-label={t("detail.presence.liveView.expand")}
              title={t("detail.presence.liveView.expand")}
              onClick={() => void stageRef.current?.requestFullscreen?.()}
            >
              <span aria-hidden>↗</span>
            </button>
          ) : null}
          {remoteActive ? (
            <button
              type="button"
              className={`bibo-btn ${keyboardEnabled ? "bibo-btn--primary" : "bibo-btn--ghost"}`}
              onClick={() => {
                setKeyboardEnabled((value) => !value);
                window.setTimeout(() => stageRef.current?.focus(), 0);
              }}
            >
              {keyboardEnabled
                ? t("detail.presence.liveView.remoteKeyboardOn")
                : t("detail.presence.liveView.remoteKeyboard")}
            </button>
          ) : null}
          {remoteOpen ? (
            <button type="button" className="bibo-btn bibo-btn--danger" disabled={remoteBusy} onClick={() => void stopRemoteAssist()}>
              {t("detail.presence.liveView.remoteStop")}
            </button>
          ) : (
            <>
              <button type="button" className="bibo-btn bibo-btn--ghost" disabled={!online || remoteBusy} onClick={() => void startRemoteAssist()}>
                {remoteBusy ? t("detail.presence.liveView.remotePending") : t("detail.presence.liveView.remoteStart")}
              </button>
              <button
                type="button"
                className={`bibo-btn ${enabled ? "bibo-btn--ghost" : "bibo-btn--primary"}`}
                disabled={!online}
                onClick={() => {
                  setError(null);
                  setFallbackActive(false);
                  consecutiveFailures.current = 0;
                  setEnabled((value) => !value);
                }}
              >
                {enabled ? t("detail.presence.liveView.stop") : t("detail.presence.liveView.start")}
              </button>
            </>
          )}
        </div>
      </div>

      {remoteOpen ? <p className="ad-live-screen__consent">{t("detail.presence.liveView.remoteConsent")}</p> : null}
      {fallbackActive && !displayedImage ? <p className="ad-live-screen__notice" role="status">{t("detail.presence.liveView.fallback")}</p> : null}

      <div
        className="ad-live-screen__stage"
        ref={stageRef}
        role={remoteActive ? "application" : undefined}
        aria-label={remoteActive ? t("detail.presence.liveView.remoteClickHint") : undefined}
        tabIndex={remoteActive && keyboardEnabled ? 0 : -1}
        onClick={clickRemoteFrame}
        onKeyDown={typeOnRemote}
      >
        {displayedImage ? (
          <img src={displayedImage} alt={t("detail.presence.liveView.frameAlt")} decoding="async" />
        ) : (
          <div className="ad-live-screen__empty">
            {remoteSession?.status === "pending" ? (
              <Spinner label={t("detail.presence.liveView.remotePending")} />
            ) : remoteActive ? (
              <Spinner label={t("detail.presence.liveView.remoteWaitingFrame")} />
            ) : waiting ? (
              <Spinner label={t("detail.presence.liveView.waiting")} />
            ) : (
              <span>{online ? t("detail.presence.liveView.startHint") : t("detail.presence.liveView.offline")}</span>
            )}
          </div>
        )}
        {(enabled && imageUrl) || (remoteActive && remoteFrameUrl) ? (
          <span className="ad-live-screen__badge">
            {remoteActive ? t("detail.presence.liveView.remoteActive") : waiting ? t("detail.presence.liveView.refreshing") : t("detail.presence.liveView.live")}
          </span>
        ) : null}
      </div>

      <div className="ad-live-screen__foot">
        <span>
          {remoteActive
            ? t("detail.presence.liveView.remoteApproved")
            : frameTime
              ? t("detail.presence.liveView.lastFrame", { time: frameTime })
              : t("detail.presence.liveView.noFrame")}
        </span>
        <span>{remoteActive ? t("detail.presence.liveView.remoteClickHint") : t("detail.presence.liveView.readOnly")}</span>
      </div>
      {remoteSession && !remoteOpen ? <p className="ad-live-screen__warning" role="status">{t("detail.presence.liveView.remoteEnded")}</p> : null}
      {remoteError || error ? <p className="ad-live-screen__warning" role="status">{remoteError || error}</p> : null}
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
  const [day, setDay] = useState(() => isoDate(new Date()));
  const [from, setFrom] = useState(() => isoDate(new Date()));
  const [to, setTo] = useState(() => isoDate(new Date()));

  const [tab, setTab] = useState<Tab>("activity");
  // Set by a timeline click: switches to the player and points it at a moment.
  const [seekTo, setSeekTo] = useState<number | null>(null);

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
  // The timeline is authoritative for the time budget when it has data, so the
  // cards cannot contradict each other. It measures active time device-wide,
  // whereas activity_samples only accrues while a foreground window is
  // identifiable — two honest numbers that would otherwise disagree on screen.
  //
  // Agents older than the timeline report nothing here; falling back to the
  // activity sum keeps their dashboards working instead of showing a bare zero.
  const hasTimeline = !!totals && totals.covered_s > 0;
  const budgetActiveS = hasTimeline ? totals.active_s : activeS;
  // "Device time" is the time the machine was powered and reporting: active +
  // idle. Suspended and offline are deliberately excluded.
  const deviceS = hasTimeline ? totals.active_s + totals.idle_s : null;
  const coverage = totals && totals.elapsed_s > 0 && totals.covered_s > 0
    ? Math.round((totals.covered_s / totals.elapsed_s) * 100)
    : null;

  const clockTime = (unix: number | null | undefined) =>
    unix == null
      ? null
      : new Date(unix * 1000).toLocaleTimeString(i18n.language, {
          hour: "2-digit",
          minute: "2-digit",
        });

  // Most-visited site for the window, by summed real visit duration.
  const topSite = (() => {
    if (!visits || visits.length === 0) return null;
    const byDomain = new Map<string, number>();
    for (const v of visits) {
      const key = v.domain || v.url;
      if (!key) continue;
      byDomain.set(key, (byDomain.get(key) ?? 0) + v.duration_s);
    }
    let best: [string, number] | null = null;
    for (const entry of byDomain) if (!best || entry[1] > best[1]) best = entry;
    return best;
  })();

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

      <div className="ad-command-deck">
        <LiveScreen presence={presence} />
        <div className="ad-command-deck__telemetry">
          <LivePresence presence={presence} />
          <LiveResources resources={presence?.resources} />
        </div>
      </div>

      {!businessId && <Notice kind="info">{t("detail.noBusinessContext")}</Notice>}
      {error && <Notice kind="danger">{error}</Notice>}

      {/* summary stat cards */}
      <div className="ad-stats">
        <StatCard
          focal
          icon={IconClock}
          label={mode === "day" ? t("detail.summary.activeTime") : t("detail.summary.activeTimeRange")}
          value={fmtDuration(budgetActiveS)}
          sub={mode === "day" ? t("detail.singleDay") : t("detail.dateRange")}
        />
        <StatCard
          icon={IconPause}
          label={t("detail.summary.idleTime")}
          value={hasTimeline ? fmtDuration(totals.idle_s) : "—"}
          sub={hasTimeline ? `${t("detail.summary.offlineTime")} ${fmtDuration(totals.offline_s)}` : undefined}
        />
        <StatCard
          icon={IconMonitor}
          label={t("detail.summary.deviceTime")}
          value={deviceS === null ? "—" : fmtDuration(deviceS)}
          sub={coverage === null ? undefined : `${coverage}% ${t("detail.summary.coverage")}`}
        />
        <StatCard
          icon={IconSunrise}
          label={t("detail.summary.firstActivity")}
          value={clockTime(states?.first_activity) ?? "—"}
          sub={
            states && states.last_activity
              ? `${t("detail.summary.lastActivity")} ${clockTime(states.last_activity)}`
              : t("detail.summary.noActivity")
          }
        />
        <StatCard
          icon={IconAppWindow}
          label={t("detail.summary.topApp")}
          value={topApp}
          delta={`${topShare}%`}
          sub={t("dashboard.statFocus")}
        />
        <StatCard
          icon={IconGlobe}
          label={t("detail.summary.topSite")}
          value={topSite ? topSite[0] : "—"}
          sub={topSite ? fmtDuration(topSite[1]) : undefined}
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
            onSeek={(ts) => {
              setSeekTo(ts);
              setTab("playback");
            }}
          />
        )}
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
                {tab === "playback" && activity && keystrokes && visits && shots ? (
                  <PlaybackPanel
                    shots={shots}
                    activity={activity}
                    visits={visits}
                    buckets={keystrokes}
                    seekTo={seekTo}
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
