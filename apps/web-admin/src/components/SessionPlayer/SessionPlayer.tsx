import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mintPlaybackToken, type RecordingAsset } from "../../api/media";
import type { ActivitySample } from "../../api/types";
import { isPlayable, nextPlayable, recordingSpan, resolveMoment, sortRecordings } from "../../lib/dayModel";
import { fmtClock, fmtDuration } from "../../lib/format";
import { Icon } from "../../ui/Icon";

/**
 * Recorded screen video for one day. A <video> bound to a short-lived playback
 * URL — never stills (docs/adr/0002-video-first-media-plane.md; the CI guard
 * watches this directory). It plays the day from its first recording and runs
 * straight into the next one, so the day watches as one video. A seek request
 * (from "watch this moment" elsewhere on the page) jumps to that second, or to
 * the nearest recorded moment with a note saying so.
 */

export type SeekRequest = { ts: number; n: number };

const SPEEDS = [1, 2, 4, 8] as const;

export function SessionPlayer({
  recordings,
  seek,
  samples,
}: {
  recordings: RecordingAsset[];
  seek: SeekRequest | null;
  samples: ActivitySample[];
}) {
  const { t } = useTranslation("app");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState<RecordingAsset | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [missed, setMissed] = useState(false);
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

  // A seek request (or a new day of recordings) decides what plays.
  useEffect(() => {
    if (seek) {
      const target = resolveMoment(recordings, seek.ts);
      if (!target) {
        setCurrent(null);
        return;
      }
      setMissed(!target.exact);
      playAt(target.recording, target.at);
      return;
    }
    setMissed(false);
    const first = sortRecordings(recordings).find(isPlayable);
    if (first) playAt(first, recordingSpan(first).start);
    else setCurrent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordings, seek?.n]);

  // Each recording gets its own short-lived playback URL, fetched on demand.
  useEffect(() => {
    if (!current) {
      setUrl(null);
      return;
    }
    let alive = true;
    setUrl(null);
    setFailed(false);
    mintPlaybackToken(current.id)
      .then((token) => alive && setUrl(token.url))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [current]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, url]);

  const sample = now === null ? null : samples.find((s) => s.ts <= now && s.ts + s.duration_s >= now) ?? null;
  const playable = sortRecordings(recordings).filter(isPlayable);

  if (playable.length === 0) {
    const inProgress = recordings.some((r) => r.status === "recording" || r.status === "processing" || r.status === "pending");
    return (
      <div className="player-empty">
        <span className="empty-icon">
          <Icon name="live" />
        </span>
        <strong>{inProgress ? t("video.inProgress") : t("video.none")}</strong>
        <p className="muted">{t("video.noneHint")}</p>
      </div>
    );
  }

  return (
    <div className="player">
      <div className="player-frame">
        {url && current ? (
          <video
            key={current.id}
            ref={videoRef}
            src={url}
            controls
            autoPlay
            playsInline
            muted
            aria-label={t("video.label")}
            onLoadedMetadata={(e) => {
              const at = pendingAt.current ?? recordingSpan(current).start;
              e.currentTarget.currentTime = Math.max(0, at - recordingSpan(current).start);
              e.currentTarget.playbackRate = speed;
              pendingAt.current = null;
            }}
            onTimeUpdate={(e) => setNow(recordingSpan(current).start + e.currentTarget.currentTime)}
            onEnded={() => {
              const next = nextPlayable(recordings, current);
              if (next) playAt(next, recordingSpan(next).start);
            }}
            onError={() => setFailed(true)}
          />
        ) : failed ? (
          <div className="player-empty">
            <Icon name="alert" />
            <strong>{t("video.unavailable")}</strong>
          </div>
        ) : (
          <div className="player-empty">
            <span className="spinner" />
          </div>
        )}
        {now !== null ? (
          <div className="player-hud">
            <span className="player-clock num">
              <bdi>{fmtClock(Math.floor(now))}</bdi>
            </span>
            {sample ? (
              <span className="player-app ltr-auto" title={sample.window_title}>
                {sample.app_name}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {missed ? (
        <div className="alert alert-warn">
          <Icon name="info" />
          <span>{t("video.nearest")}</span>
        </div>
      ) : null}

      <div className="player-bar">
        <div className="segmented" role="group" aria-label={t("video.speed")}>
          {SPEEDS.map((v) => (
            <button key={v} type="button" aria-pressed={speed === v} onClick={() => setSpeed(v)}>
              <bdi dir="ltr">{v}×</bdi>
            </button>
          ))}
        </div>
        <div className="player-clips" role="list" aria-label={t("video.clips")}>
          {playable.map((r) => {
            const span = recordingSpan(r);
            return (
              <button
                key={r.id}
                type="button"
                role="listitem"
                className={`player-clip${current?.id === r.id ? " is-current" : ""}`}
                onClick={() => {
                  setMissed(false);
                  playAt(r, span.start);
                }}
                title={fmtDuration(span.end - span.start)}
              >
                <bdi className="num">{fmtClock(Math.floor(span.start))}</bdi>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
