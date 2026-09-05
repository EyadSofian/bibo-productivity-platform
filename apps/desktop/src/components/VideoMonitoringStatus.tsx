import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call } from "../api";
type Status = { active: boolean; paused: boolean };
export function VideoMonitoringStatus() {
  const { t } = useTranslation("media");
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => call<Status>("media_status").then(s => { if (alive) setStatus(s); }).catch(() => {});
    void refresh(); const timer = setInterval(refresh, 250);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  if (!status || (!status.active && !status.paused)) return null;
  return <aside className="video-monitoring-status" role="status">
    <span>{t(status.paused ? "livePaused" : "liveActive")}</span>
    <button type="button" onClick={() => void call("set_video_paused", { paused: !status.paused }).catch(() => {})}>
      {t(status.paused ? "liveResume" : "liveStop")}
    </button>
  </aside>;
}
