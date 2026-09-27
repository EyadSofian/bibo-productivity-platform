import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mintPlaybackToken, type RecordingAsset } from "../../api/media";
import type { ActivityResponse } from "../../api/types";
import { isPlayable, nextPlayable, recordingSpan, resolveMoment, sortRecordings } from "./dayModel";

export type SeekRequest = { ts: number; n: number; label?: string | null };

const SPEEDS = [1, 2, 4, 8] as const;

const clock = (ts: number, lang: string) =>
  new Date(ts * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The recorded-video screen. It plays a moment when asked (an app or website
 * click), otherwise the day from its first recording, and runs straight on
 * into the next recording so the day watches as one video.
 */
export function RecordingStage({
  recordings,
  request,
  activity,
  onTime,
}: {
  recordings: RecordingAsset[] | null;
  request: SeekRequest | null;
  activity: ActivityResponse | null;
  onTime?: (ts: number) => void;
}) {
  const { t, i18n } = useTranslation("reports");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState<RecordingAsset | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [missed, setMissed] = useState<{ asked: number; shown: number } | null>(null);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const pendingAt = useRef<number | null>(null);
  const currentRef = useRef<RecordingAsset | null>(null);
  currentRef.current = current;

  const playAt = (recording: RecordingAsset, at: number) => {
    pendingAt.current = at;
    setNow(at);
    const video = videoRef.current;
    if (currentRef.current?.id === recording.id && video && video.readyState > 0) {
      video.currentTime = Math.max(0, at - recordingSpan(recording).start);
      void video.play().catch(() => {});
      pendingAt.current = null;
      return;
    }
    setCurrent(recording);
  };

  // A request (or a new day of recordings) decides what plays.
  useEffect(() => {
    if (!recordings) return;
    if (request) {
      const target = resolveMoment(recordings, request.ts);
      if (!target) {
        setCurrent(null);
        setMissed(null);
        return;
      }
      setMissed(target.exact ? null : { asked: request.ts, shown: target.at });
      playAt(target.recording, target.at);
      return;
    }
    const first = sortRecordings(recordings).find(isPlayable);
    setMissed(null);
    if (first) playAt(first, recordingSpan(first).start);
    else setCurrent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordings, request?.n]);

  // Each recording needs its own short-lived playback URL.
  useEffect(() => {
    if (!current) {
      setUrl(null);
      return;
    }
    let alive = true;
    setUrl(null);
    setError(null);
    mintPlaybackToken(current.id)
      .then((token) => { if (alive) setUrl(token.url); })
      .catch(() => { if (alive) setError(t("employee.video.unavailable")); });
    return () => { alive = false; };
  }, [current, t]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, url]);

  const sample = now == null || !activity
    ? null
    : activity.samples.find((s) => s.ts <= now && s.ts + s.duration_s >= now) ?? null;

  if (recordings == null) {
    return <div className="ev-stage__empty"><span className="ev-spinner" aria-hidden />{t("employee.video.loading")}</div>;
  }
  const playable = recordings.filter(isPlayable);
  if (playable.length === 0) {
    const inProgress = recordings.some((r) => r.status === "recording" || r.status === "processing" || r.status === "pending");
    return (
      <div className="ev-stage__empty">
        <strong>{inProgress ? t("employee.video.inProgress") : t("employee.video.empty")}</strong>
        <p>{t("employee.video.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="ev-rec">
      <div className="ev-rec__frame">
        {url && current ? (
          <video
            key={current.id}
            ref={videoRef}
            src={url}
            controls
            autoPlay
            playsInline
            muted
            onLoadedMetadata={(event) => {
              const at = pendingAt.current ?? recordingSpan(current).start;
              event.currentTarget.currentTime = Math.max(0, at - recordingSpan(current).start);
              event.currentTarget.playbackRate = speed;
              pendingAt.current = null;
            }}
            onTimeUpdate={(event) => {
              const ts = recordingSpan(current).start + event.currentTarget.currentTime;
              setNow(ts);
              onTime?.(ts);
            }}
            onEnded={() => {
              const next = nextPlayable(recordings, current);
              if (next) playAt(next, recordingSpan(next).start);
            }}
            onError={() => setError(t("employee.video.unavailable"))}
          />
        ) : error ? (
          <div className="ev-stage__empty"><strong>{error}</strong></div>
        ) : (
          <div className="ev-stage__empty"><span className="ev-spinner" aria-hidden />{t("employee.video.loading")}</div>
        )}
        {now != null ? (
          <div className="ev-rec__hud">
            <span className="ev-rec__clock"><bdi>{clock(now, i18n.language)}</bdi></span>
            {request?.label ? <span className="ev-rec__label">{request.label}</span> : null}
            {sample ? <span className="ev-rec__app" title={sample.window_title}>{sample.app_name}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="ev-rec__bar">
        <div className="ev-seg" role="group" aria-label={t("employee.video.speed")}>
          {SPEEDS.map((value) => (
            <button type="button" key={value} aria-pressed={speed === value} onClick={() => setSpeed(value)}>
              <bdi dir="ltr">{value}×</bdi>
            </button>
          ))}
        </div>
        {missed ? (
          <p className="ev-rec__notice" role="status">
            {t("employee.video.noVideoAt", {
              time: clock(missed.asked, i18n.language),
              nearest: clock(missed.shown, i18n.language),
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
