import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { call as invoke } from "../api";
import { dragWindow } from "./dragWindow";

type RemoteAssistStatus = {
  active: boolean;
  session_id: string;
  owner_name: string;
  expires_at: string;
};

export function RemoteAssistIndicator() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteAssistStatus | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      invoke<RemoteAssistStatus | null>("remote_assist_status")
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  async function stop() {
    setStopping(true);
    try {
      await invoke("stop_remote_assist");
    } catch {
      setStopping(false);
    }
  }

  return (
    <main className="remote-assist-indicator" onMouseDown={dragWindow}>
      <span className="remote-assist-indicator__pulse" aria-hidden />
      <span className="remote-assist-indicator__copy">
        <strong>{t("remoteAssist.title")}</strong>
        <small>{t("remoteAssist.subtitle", { owner: status?.owner_name || "BiBoTracking" })}</small>
      </span>
      <button
        type="button"
        className="remote-assist-indicator__stop"
        disabled={!status || stopping}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => void stop()}
      >
        {stopping ? t("remoteAssist.stopping") : t("remoteAssist.stop")}
      </button>
    </main>
  );
}
