import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getRecordingSummary, type RecordingSummary } from "../api/media";
import { reportEmployees } from "../api/endpoints";
import type { ReportEmployee } from "../api/types";
import { fmtRelative } from "../format";
import { useBusinesses } from "../useBusinesses";

type Status = "active" | "idle" | "offline";

function rosterStatus(employee: ReportEmployee): Status {
  if (employee.presence_state === "offline") return "offline";
  if (employee.presence_state === "idle") return "idle";
  if (employee.presence_state === "active" || employee.presence_state === "online") return "active";
  return "offline";
}

function duration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(safe / 3600)}:${String(Math.floor((safe % 3600) / 60)).padStart(2, "0")}`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function failureReason(code: string, reason?: string): string {
  if (reason === "recording_quota") return "quotaExceeded";
  if (code === "ENCODER_FAILED") return "encoderFailed";
  if (code === "CAPTURE_FAILED") return "captureFailed";
  if (code === "ROOM_FAILED" || code === "PROVIDER_UNAVAILABLE") return "providerFailed";
  return "unknownFailed";
}

/**
 * Home: who is working right now, and whether today's video is being saved.
 * Everything links straight into the employee's day.
 */
export function Dashboard() {
  const { t, i18n } = useTranslation("dashboard");
  const { businesses, selected, selectedId, loading: businessLoading } = useBusinesses();
  const [employees, setEmployees] = useState<ReportEmployee[]>([]);
  const [recordings, setRecordings] = useState<RecordingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [rosterError, setRosterError] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setEmployees([]); setRecordings(null); setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      const [rosterResult, recordingResult] = await Promise.allSettled([
        reportEmployees(selectedId), getRecordingSummary(selectedId),
      ]);
      if (cancelled) return;
      if (rosterResult.status === "fulfilled") {
        setEmployees(rosterResult.value.employees); setRosterError(false);
      } else setRosterError(true);
      if (recordingResult.status === "fulfilled") {
        setRecordings(recordingResult.value.summary); setVideoError(false);
      } else setVideoError(true);
      setLastRefresh(new Date()); setLoading(false);
      timer = window.setTimeout(refresh, 30_000);
    };
    setLoading(true); setEmployees([]); setRecordings(null);
    void refresh();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [selectedId]);

  const sorted = useMemo(() => {
    const order: Record<Status, number> = { active: 0, idle: 1, offline: 2 };
    return [...employees].sort((a, b) => order[rosterStatus(a)] - order[rosterStatus(b)] || a.display_name.localeCompare(b.display_name));
  }, [employees]);
  const online = employees.filter((employee) => rosterStatus(employee) !== "offline").length;
  const activeTime = employees.reduce((sum, employee) => sum + employee.active_today_s, 0);
  const needsReview = (recordings?.failed ?? 0) + (recordings?.stale ?? 0);
  const lastReadyAt = recordings?.last_ready_at ? Date.parse(recordings.last_ready_at) : NaN;
  const noRecentVideo = online > 0 && !videoError && recordings != null &&
    (!Number.isFinite(lastReadyAt) || lastReadyAt < Date.now() - 24 * 60 * 60 * 1000);
  // The recording service refused for lack of minutes: nothing on the
  // device can fix that, so say it plainly and at the top.
  const quotaExhausted = recordings?.recent.some((item) => item.failure_reason === "recording_quota") ?? false;
  const employeeLink = (id: string) => `/employees/${id}?business=${selectedId}`;

  return (
    <main className="e-page">
      <header className="e-head">
        <div>
          <h1>{t("dashboard.simple.title")}</h1>
          <p>{t("dashboard.simple.subtitle", { name: selected?.name ?? "Engosoft" })}</p>
        </div>
        <div className="e-actions">
          <span className="e-muted-sm">
            {lastRefresh
              ? t("dashboard.simple.updated", { time: lastRefresh.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" }) })
              : t("dashboard.loadingRoster")}
          </span>
          <Link className="e-btn" to="/employees">{t("dashboard.simple.allEmployees")}</Link>
        </div>
      </header>

      {!businessLoading && businesses.length === 0 ? (
        <div className="e-card"><div className="e-empty"><strong>{t("dashboard.simple.noBusiness")}</strong></div></div>
      ) : null}
      {rosterError ? <div className="e-notice" role="alert">{t("dashboard.errorRoster")}</div> : null}

      {selectedId ? (
        <>
          <section className="e-kpis" aria-label={t("dashboard.simple.overview")}>
            <div className="e-kpi">
              <span>{t("dashboard.simple.online")}</span>
              <strong className="num">{loading ? "—" : online}<small className="e-kpi__of"> / {employees.length}</small></strong>
              <small>{t("dashboard.simple.onlineHelp")}</small>
            </div>
            <div className="e-kpi">
              <span>{t("dashboard.simple.activeTime")}</span>
              <strong className="num" dir="ltr">{loading ? "—" : duration(activeTime)}</strong>
              <small>{t("dashboard.simple.activeTimeHelp")}</small>
            </div>
            <div className="e-kpi">
              <span>{t("dashboard.simple.videosReady")}</span>
              <strong className="num">{videoError || !recordings ? "—" : recordings.ready}</strong>
              <small>{t("dashboard.simple.lastSevenDays")}</small>
            </div>
            <div className={`e-kpi${needsReview ? " e-kpi--alert" : ""}`}>
              <span>{t("dashboard.simple.needsReview")}</span>
              <strong className="num">{videoError || !recordings ? "—" : needsReview}</strong>
              <small>{t("dashboard.simple.lastSevenDays")}</small>
            </div>
          </section>

          {quotaExhausted ? (
            <div className="e-notice e-notice--bad" role="alert">
              <div>
                <strong>{t("dashboard.video.quotaTitle")}</strong>
                <div>{t("dashboard.video.quotaBody")}</div>
              </div>
            </div>
          ) : null}

          {noRecentVideo && !quotaExhausted ? (
            <div className="e-notice" role="status">
              <div>
                <strong>{t("dashboard.video.noRecentTitle")}</strong>
                <div>{t("dashboard.video.guideBody")}</div>
              </div>
              <Link className="e-link e-notice__action" to="/monitoring">{t("dashboard.video.openPolicy")}</Link>
            </div>
          ) : null}

          <div className="e-home">
            <section className="e-card">
              <div className="e-card__head">
                <div>
                  <h2>{t("dashboard.simple.teamTitle")}</h2>
                  <p>{t("dashboard.simple.teamHelp")}</p>
                </div>
                <Link className="e-link" to="/employees">{t("dashboard.ops.viewAll")}</Link>
              </div>
              {loading ? (
                <div className="e-empty">{t("dashboard.loadingRoster")}</div>
              ) : sorted.length === 0 && !rosterError ? (
                <div className="e-empty"><strong>{t("dashboard.simple.noEmployees")}</strong></div>
              ) : (
                <div className="e-scroll">
                  <table className="e-table">
                    <thead>
                      <tr>
                        <th>{t("dashboard.table.name")}</th>
                        <th>{t("dashboard.table.currentNow")}</th>
                        <th>{t("dashboard.table.activeToday")}</th>
                        <th aria-hidden />
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((employee) => {
                        const status = rosterStatus(employee);
                        return (
                          <tr key={employee.id}>
                            <td>
                              <Link className="e-person" to={employeeLink(employee.id)}>
                                <span className={`e-av e-av--${status}`}>{initials(employee.display_name)}<i aria-hidden /></span>
                                <span>
                                  <strong>{employee.display_name}</strong>
                                  <small>
                                    <span className={`e-pill e-pill--${status} e-pill--xs`}>{t(`dashboard.states.${status}`)}</span>
                                  </small>
                                </span>
                              </Link>
                            </td>
                            <td className="e-home__app">
                              {status === "offline"
                                ? <span className="e-dim">{t("dashboard.simple.lastSeen", { time: fmtRelative(employee.last_seen) })}</span>
                                : employee.current_app || <span className="e-dim">{t("dashboard.noCurrentApp")}</span>}
                            </td>
                            <td className="num" dir="ltr">{duration(employee.active_today_s)}</td>
                            <td className="e-home__go">
                              <Link className="e-btn e-btn--sm" to={employeeLink(employee.id)}>{t("dashboard.view")}</Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="e-card">
              <div className="e-card__head">
                <div>
                  <h2>{t("dashboard.video.title")}</h2>
                  <p>{t("dashboard.video.subtitle")}</p>
                </div>
              </div>
              {videoError ? <div className="e-card__body"><div className="e-notice">{t("dashboard.video.error")}</div></div> : null}
              {recordings ? (
                <>
                  <div className="e-home__totals">
                    <div><span>{t("dashboard.video.ready")}</span><strong className="num">{recordings.ready}</strong></div>
                    <div><span>{t("dashboard.video.inProgress")}</span><strong className="num">{recordings.recording + recordings.processing}</strong></div>
                    <div className={recordings.failed ? "is-bad" : ""}><span>{t("dashboard.video.failed")}</span><strong className="num">{recordings.failed}</strong></div>
                  </div>
                  {recordings.stale > 0 ? <p className="e-home__alert">{t("dashboard.video.stale", { count: recordings.stale })}</p> : null}
                  {recordings.recent.length === 0 ? (
                    <div className="e-empty"><p>{t("dashboard.video.empty")}</p></div>
                  ) : (
                    <ul className="e-home__videos">
                      {recordings.recent.map((item) => {
                        const seek = Math.floor(Date.parse(item.started_at) / 1000);
                        const size = item.status === "ready" ? ` · ${(item.byte_size / (1024 * 1024)).toFixed(1)} MB` : "";
                        const body = (
                          <>
                            <span className="e-home__vtext">
                              <strong>{item.employee_name || t("dashboard.video.unknownEmployee")}</strong>
                              <small>
                                {new Date(item.started_at).toLocaleString(i18n.language, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                                {size}
                                {item.status === "failed" ? ` · ${t(`dashboard.video.failure.${failureReason(item.failure_code, item.failure_reason)}`)}` : ""}
                              </small>
                            </span>
                            <span className={`e-pill ${item.status === "ready" ? "e-pill--ok" : item.status === "failed" ? "e-pill--bad" : "e-pill--warn"}`}>
                              {t(`dashboard.video.status.${item.status}`)}
                            </span>
                          </>
                        );
                        return (
                          <li key={item.id}>
                            {item.status === "ready" && item.employee_id ? (
                              <Link to={`/employees/${item.employee_id}?business=${selectedId}&tab=playback&at=${seek}`}>{body}</Link>
                            ) : (
                              <div>{body}</div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <p className="e-home__foot">{t("dashboard.video.retention")}</p>
                </>
              ) : null}
            </section>
          </div>
        </>
      ) : null}
    </main>
  );
}
