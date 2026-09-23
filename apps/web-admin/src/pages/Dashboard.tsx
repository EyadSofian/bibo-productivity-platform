import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getRecordingSummary, type RecordingSummary } from "../api/media";
import { reportEmployees } from "../api/endpoints";
import type { ReportEmployee } from "../api/types";
import { Empty, Notice, Spinner } from "../components/ui";
import { fmtRelative } from "../format";
import { useBusinesses } from "../useBusinesses";
import "./Dashboard.css";

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

function failureReason(code: string): string {
  if (code === "ENCODER_FAILED") return "encoderFailed";
  if (code === "CAPTURE_FAILED") return "captureFailed";
  if (code === "ROOM_FAILED" || code === "PROVIDER_UNAVAILABLE") return "providerFailed";
  return "unknownFailed";
}

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

  return <main className="ad-wrap ops-lite">
    <header className="ops-lite__header">
      <div><span className="ops-lite__eyebrow">{t("dashboard.simple.eyebrow")}</span><h1>{t("dashboard.simple.title")}</h1><p>{t("dashboard.simple.subtitle", { name: selected?.name ?? "Engosoft" })}</p></div>
      <div className="ops-lite__header-actions">
        <span className="ops-lite__refresh">{lastRefresh ? t("dashboard.simple.updated", { time: lastRefresh.toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" }) }) : t("dashboard.loadingRoster")}</span>
        <Link className="ops-lite__button" to="/employees">{t("dashboard.simple.allEmployees")} <span aria-hidden>→</span></Link>
      </div>
    </header>

    {businessLoading || loading ? <Spinner label={t("dashboard.loadingRoster")} /> : null}
    {!businessLoading && businesses.length === 0 ? <Empty>{t("dashboard.simple.noBusiness")}</Empty> : null}
    {rosterError ? <Notice kind="danger">{t("dashboard.errorRoster")}</Notice> : null}

    {selectedId ? <>
      <section className="ops-lite__metrics" aria-label={t("dashboard.simple.overview")}>
        <div className="ops-lite__metric"><span>{t("dashboard.simple.online")}</span><strong>{online}<small> / {employees.length}</small></strong><p>{t("dashboard.simple.onlineHelp")}</p></div>
        <div className="ops-lite__metric"><span>{t("dashboard.simple.activeTime")}</span><strong dir="ltr">{duration(activeTime)}</strong><p>{t("dashboard.simple.activeTimeHelp")}</p></div>
        <div className="ops-lite__metric"><span>{t("dashboard.simple.videosReady")}</span><strong>{videoError ? "—" : recordings?.ready ?? 0}</strong><p>{t("dashboard.simple.lastSevenDays")}</p></div>
        <div className={`ops-lite__metric${needsReview ? " ops-lite__metric--alert" : ""}`}><span>{t("dashboard.simple.needsReview")}</span><strong>{videoError ? "—" : needsReview}</strong><p>{t("dashboard.simple.lastSevenDays")}</p></div>
      </section>

      <div className="ops-lite__columns">
        <section className="ops-lite__panel ops-lite__team">
          <div className="ops-lite__panel-head"><div><h2>{t("dashboard.simple.teamTitle")}</h2><p>{t("dashboard.simple.teamHelp")}</p></div><Link to="/employees">{t("dashboard.ops.viewAll")}</Link></div>
          {sorted.length === 0 && !loading && !rosterError ? <div className="ops-lite__empty">{t("dashboard.simple.noEmployees")}</div> : null}
          <div className="ops-lite__people">{sorted.map((employee) => {
            const status = rosterStatus(employee);
            return <Link className="ops-lite__person" key={employee.id} to={`/employees/${employee.id}?business=${selectedId}`}>
              <span className={`ops-lite__avatar ops-lite__avatar--${status}`}>{initials(employee.display_name)}</span>
              <span className="ops-lite__person-name"><strong>{employee.display_name}</strong><small>{status === "offline" ? t("dashboard.simple.lastSeen", { time: fmtRelative(employee.last_seen) }) : employee.current_app || t("dashboard.noCurrentApp")}</small></span>
              <span className={`ops-lite__status ops-lite__status--${status}`}>{t(`dashboard.states.${status}`)}</span>
              <span className="ops-lite__time" dir="ltr">{duration(employee.active_today_s)}</span>
            </Link>;
          })}</div>
        </section>

        <section className="ops-lite__panel ops-lite__videos">
          <div className="ops-lite__panel-head"><div><h2>{t("dashboard.video.title")}</h2><p>{t("dashboard.video.subtitle")}</p></div></div>
          {videoError ? <Notice kind="danger">{t("dashboard.video.error")}</Notice> : null}
          {recordings ? <>
            <div className="ops-lite__video-totals">
              <span>{t("dashboard.video.ready")}: <strong>{recordings.ready}</strong></span>
              <span>{t("dashboard.video.inProgress")}: <strong>{recordings.recording + recordings.processing}</strong></span>
              <span className={recordings.failed ? "ops-lite__danger" : ""}>{t("dashboard.video.failed")}: <strong>{recordings.failed}</strong></span>
            </div>
            {recordings.stale > 0 ? <p className="ops-lite__video-alert">{t("dashboard.video.stale", { count: recordings.stale })}</p> : null}
            <div className="ops-lite__video-list">{recordings.recent.length === 0 ? <p className="ops-lite__empty">{t("dashboard.video.empty")}</p> : recordings.recent.map((item) => {
              const seek = Math.floor(Date.parse(item.started_at) / 1000);
              const size = item.status === "ready" ? ` · ${(item.byte_size / (1024 * 1024)).toFixed(1)} MB` : "";
              const contents = <>
                <span className={`ops-lite__video-dot ops-lite__video-dot--${item.status}`} aria-hidden />
                <span className="ops-lite__video-copy"><strong>{item.employee_name || t("dashboard.video.unknownEmployee")}</strong><small>{new Date(item.started_at).toLocaleString(i18n.language, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}{size}{item.status === "failed" ? ` · ${t(`dashboard.video.failure.${failureReason(item.failure_code)}`)}` : ""}</small></span>
                <span className={`ops-lite__video-state ops-lite__video-state--${item.status}`}>{t(`dashboard.video.status.${item.status}`)}</span>
              </>;
              return item.status === "ready" && item.employee_id
                ? <Link key={item.id} className="ops-lite__video-item" to={`/employees/${item.employee_id}?business=${selectedId}&tab=playback&at=${seek}`}>{contents}</Link>
                : <div key={item.id} className="ops-lite__video-item">{contents}</div>;
            })}</div>
            <p className="ops-lite__retention">{t("dashboard.video.retention")}</p>
          </> : null}
        </section>
      </div>
    </> : null}
  </main>;
}
