import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { call as invoke } from "../api";
import { listen } from "@tauri-apps/api/event";
import { LanguageSwitcher } from "./LanguageSwitcher";

/**
 * TrayMenu — a top-right popover on the welcome surface that mirrors the desktop
 * app's system-tray menu (status · language · Open / Start / Stop / Quit). The
 * status reflects the app's REAL tracking state (read from `tracking_state` and
 * kept in sync via the "tracking-state" broadcast), and Start/Stop drive the real
 * `set_paused` command — no longer a purely-visual toggle (BRI-22).
 */

type TrackStatus = "tracking" | "idle" | "paused";

const OpenIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5" y="5" width="14" height="14" rx="2" />
  </svg>
);
const PowerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    <line x1="12" y1="2" x2="12" y2="12" />
  </svg>
);

export function TrayMenu() {
  const { t } = useTranslation("welcome");
  const [status, setStatus] = useState<TrackStatus>("paused");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Reflect the app's real tracking state: read it once, then follow the tray's
  // "tracking-state" broadcast (same source the main-window pill uses).
  useEffect(() => {
    invoke<TrackStatus>("tracking_state").then(setStatus).catch(() => {});
    const unlisten = listen<TrackStatus>("tracking-state", (e) => setStatus(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tracking = status !== "paused"; // "tracking" or "idle" both count as on
  const stateLabel = tracking ? t("tray.tracking") : t("tray.paused");
  const stateColor = tracking ? "#10b981" : "#ef4444"; // red round dot when not tracking

  return (
    <div className="tray" ref={ref}>
      <button
        type="button"
        className="tray-trigger"
        style={{ color: stateColor }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("tray.status")}: ${stateLabel}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`tray-livedot ${tracking ? "tray-livedot--on" : "tray-livedot--off"}`} aria-hidden />
      </button>

      {open && (
        <div className="tray-menu" role="menu">
          <div className="tray-head">
            <span className="tray-status">
              <span className="tray-dot" style={{ background: stateColor }} />
              {t("tray.status")} : {stateLabel}
            </span>
            <LanguageSwitcher compact align="right" />
          </div>
          <div className="tray-sep" />
          <button type="button" className="tray-item" onClick={() => setOpen(false)}>
            <OpenIcon />
            {t("tray.open")}
          </button>
          {/* This popup only shows on the pre-auth screens (welcome / sign-in /
              onboarding). Tracking must not start before the user logs in or picks
              "just me", so Start is disabled here. BRI-22 */}
          <button type="button" className="tray-item" disabled aria-disabled>
            <PlayIcon />
            {t("tray.start")}
          </button>
          <button
            type="button"
            className="tray-item"
            disabled={!tracking}
            onClick={() => {
              invoke("set_paused", { paused: true }).catch(() => {});
              setOpen(false);
            }}
          >
            <StopIcon />
            {t("tray.stop")}
          </button>
          <div className="tray-sep" />
          <button type="button" className="tray-item danger" onClick={() => setOpen(false)}>
            <PowerIcon />
            {t("tray.quit")}
          </button>
        </div>
      )}
    </div>
  );
}
