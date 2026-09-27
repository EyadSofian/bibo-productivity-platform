import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listEmployeeRecordings, mintPlaybackToken, type RecordingAsset } from "../../api/media";
import type {
  ActivityResponse,
  BrowserVisit,
  KeystrokeBucket,
  ScreenshotMeta,
} from "../../api/types";
import { fmtTime } from "../../format";
import { Empty, Spinner } from "../ui";
import { UnifiedTimeline } from "./UnifiedTimeline";
import { appSegments, playableMoment } from "./appSegments";

export type PlaybackFrame = ScreenshotMeta & {
  app: string | null;
  windowTitle: string | null;
  url: string | null;
  domain: string | null;
  keyCount: number;
  gapBeforeS: number;
};

const SPEEDS = [1, 2, 5, 10] as const;

export function assemblePlaybackFrames(
  shots: ScreenshotMeta[],
  activity: ActivityResponse,
  visits: BrowserVisit[],
  buckets: KeystrokeBucket[],
): PlaybackFrame[] {
  const ordered = [...shots].sort((a, b) => a.ts - b.ts);
  const keyByMinute = new Map(buckets.map((bucket) => [bucket.ts_bucket, bucket.count]));
  const positiveDiffs = ordered
    .slice(1)
    .map((shot, index) => shot.ts - ordered[index].ts)
    .filter((diff) => diff > 0)
    .sort((a, b) => a - b);
  const typical = positiveDiffs.length
    ? positiveDiffs[Math.floor(positiveDiffs.length / 2)]
    : 300;

  return ordered.map((shot, index) => {
    const sample = activity.samples.find(
      (item) => item.ts <= shot.ts && item.ts + item.duration_s >= shot.ts,
    );
    const visit = visits.find(
      (item) => item.ts <= shot.ts && item.ts + Math.max(1, item.duration_s) >= shot.ts,
    );
    const minute = shot.ts - shot.ts % 60;
    const diff = index > 0 ? shot.ts - ordered[index - 1].ts : 0;
    return {
      ...shot,
      app: sample?.app_name ?? null,
      windowTitle: sample?.window_title ?? null,
      url: visit?.url ?? null,
      domain: visit?.domain ?? null,
      keyCount: keyByMinute.get(minute) ?? 0,
      gapBeforeS: diff > typical * 1.75 ? diff : 0,
    };
  });
}

/**
 * Index of the frame closest to `ts`. Exported for testing because "closest"
 * has to hold at the ends of the day too, where a naive search walks off.
 */
export function frameIndexAt(frames: PlaybackFrame[], ts: number): number {
  if (frames.length === 0) return 0;
  let best = 0;
  let bestDistance = Math.abs(frames[0].ts - ts);
  for (let i = 1; i < frames.length; i++) {
    const distance = Math.abs(frames[i].ts - ts);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

export function recordingAt(recordings: RecordingAsset[], ts: number): RecordingAsset | null {
  return recordings.find((item) => {
    const start = Date.parse(item.started_at) / 1000;
    const end = item.ended_at
      ? Date.parse(item.ended_at) / 1000
      : start + item.duration_ms / 1000;
    return ts >= start && ts <= end;
  }) ?? null;
}

/** First saved moment for a clicked app or exact URL, even if its first visit was not recorded. */
export function recordedMomentForTarget(
  recordings: RecordingAsset[], activity: ActivityResponse, visits: BrowserVisit[],
  ts: number, focusApp: string | null, focusUrl: string | null,
): number | null {
  const ready = recordings.filter((item) => item.status === "ready");
  if (focusApp) {
    for (const segment of appSegments(activity.samples, focusApp)) {
      if (segment.ts + segment.dur < ts) continue;
      const moment = playableMoment(segment, ready);
      if (moment !== null) return moment;
    }
    return null;
  }
  if (focusUrl) {
    for (const visit of visits.filter((item) => item.url === focusUrl && item.ts + Math.max(1, item.duration_s) >= ts).sort((a, b) => a.ts - b.ts)) {
      for (const recording of ready) {
        const start = Date.parse(recording.started_at) / 1000;
        const end = recording.ended_at ? Date.parse(recording.ended_at) / 1000 : start + recording.duration_ms / 1000;
        const moment = Math.max(visit.ts, start);
        if (moment <= Math.min(visit.ts + Math.max(1, visit.duration_s), end)) return moment;
      }
    }
    return null;
  }
  return recordingAt(ready, ts) ? ts : null;
}

export function PlaybackPanel({
  employeeId,
  from,
  to,
  activity,
  visits,
  buckets,
  seekTo,
  seekNonce,
  focusApp,
  focusUrl,
  onClearFocus,
}: {
  employeeId: string;
  from: number;
  to: number;
  activity: ActivityResponse;
  visits: BrowserVisit[];
  buckets: KeystrokeBucket[];
  /** Unix seconds to open at; the nearest frame wins. */
  seekTo?: number | null;
  /** Changes on every request, so asking for the same moment again rewinds. */
  seekNonce?: number;
  /** App whose stretches are listed under the player for quick jumping. */
  focusApp?: string | null;
  /** Exact page address selected from the activity list. */
  focusUrl?: string | null;
  onClearFocus?: () => void;
}) {
  const { t } = useTranslation("reports");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recordings, setRecordings] = useState<RecordingAsset[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [absoluteTime, setAbsoluteTime] = useState(seekTo ?? from);
  const desiredTime = useRef<number | null>(seekTo ?? null);
  const continueRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const readyRecordings = recordings?.filter((item) => item.status === "ready") ?? [];

  useEffect(() => {
    let alive = true;
    setRecordings(null);
    listEmployeeRecordings(employeeId, from, to)
      .then(({ recordings: found }) => {
        if (!alive) return;
        setRecordings([...found].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)));
      })
      .catch(() => { if (alive) { setRecordings([]); setVideoError(t("playback.videoUnavailable")); } });
    return () => { alive = false; };
  }, [employeeId, from, to, t]);

  const seekAbsolute = (ts: number) => {
    desiredTime.current = ts;
    setAbsoluteTime(ts);
    const target = recordingAt(readyRecordings, ts);
    if (target) {
      if (target.id === selectedId && videoRef.current?.readyState) {
        videoRef.current.currentTime = Math.max(0, ts - Date.parse(target.started_at) / 1000);
      }
      setSelectedId(target.id);
    }
  };

  // Opening at a moment. A jump inside the recording already loaded must seek
  // the element directly: re-selecting the same id changes nothing, so the
  // second click on an app segment used to leave the video where it was.
  useEffect(() => {
    if (!recordings?.length) return;
    const ready = recordings.filter((item) => item.status === "ready");
    if (!ready.length) return;
    const wanted = seekTo ?? from;
    const matched = recordedMomentForTarget(ready, activity, visits, wanted, focusApp ?? null, focusUrl ?? null);
    const target = recordingAt(ready, matched ?? wanted) ?? ready[0];
    const at = matched ?? Date.parse(target.started_at) / 1000;
    desiredTime.current = at;
    setAbsoluteTime(at);
    if (selectedRef.current === target.id && videoRef.current?.readyState) {
      videoRef.current.currentTime = Math.max(0, at - Date.parse(target.started_at) / 1000);
    }
    setSelectedId(target.id);
  }, [recordings, seekTo, seekNonce, from, activity, visits, focusApp, focusUrl]);

  const selected = recordings?.find((item) => item.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setVideoUrl(null);
    setVideoError(null);
    mintPlaybackToken(selected.id)
      .then((token) => { if (alive) setVideoUrl(token.url); })
      .catch(() => { if (alive) setVideoError(t(selected.status === "recording" || selected.status === "processing" ? "playback.processing" : "playback.videoUnavailable")); });
    return () => { alive = false; };
  }, [selected, t]);

  const currentSample = activity.samples.find((item) => item.ts <= absoluteTime && item.ts + item.duration_s >= absoluteTime);
  const currentVisit = visits.find((item) => item.ts <= absoluteTime && item.ts + Math.max(1, item.duration_s) >= absoluteTime);
  const keyMinute = absoluteTime - absoluteTime % 60;
  const currentKeys = buckets.find((item) => item.ts_bucket === keyMinute)?.count ?? 0;

  const segments = focusApp ? appSegments(activity.samples, focusApp) : [];
  // The admin asked for a specific moment and there is no footage for it:
  // say so instead of silently playing some other part of the day.
  const missedMoment = seekTo != null && readyRecordings.length > 0 && recordedMomentForTarget(readyRecordings, activity, visits, seekTo, focusApp ?? null, focusUrl ?? null) === null;

  const segmentList = focusApp ? (
    <div className="ad-segments">
      <div className="ad-segments__head">
        <span>{t("playback.segmentsFor", { app: focusApp, count: segments.length })}</span>
        {onClearFocus ? <button type="button" onClick={onClearFocus}>{t("playback.clearFocus")}</button> : null}
      </div>
      <div className="ad-segments__list">
        {segments.map((segment) => {
          const moment = playableMoment(segment, readyRecordings);
          const active = absoluteTime >= segment.ts && absoluteTime < segment.ts + segment.dur;
          return (
            <button
              type="button"
              key={segment.ts}
              className="ad-segment"
              aria-pressed={active}
              disabled={moment === null}
              title={moment === null ? t("playback.noVideoSegment") : undefined}
              onClick={() => moment !== null && seekAbsolute(moment)}
            >
              <bdi dir="ltr">{fmtTime(segment.ts)}</bdi>
              <small><bdi dir="ltr">{Math.max(1, Math.round(segment.dur / 60))}m</bdi></small>
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  if (recordings == null) return <Spinner label={t("playback.loadingVideo")} />;
  if (recordings.length === 0) {
    return (
      <>
        <Empty>{t("playback.emptyVideo")}</Empty>
        {seekTo != null && <p className="ad-playback__notice" role="status">{t("playback.noVideoForMoment", { time: fmtTime(seekTo) })}</p>}
        <p className="ad-playback__notice">{t("playback.emptyVideoHint")}</p>
        {segmentList}
      </>
    );
  }

  const playlist = (
    <section className="ad-recording-list" aria-label={t("playback.dayVideos")}>
      <div className="ad-recording-list__head"><h3>{t("playback.dayVideos")}</h3><span>{t("playback.videoCount", { count: readyRecordings.length })}</span></div>
      <div className="ad-recording-list__items">
        {recordings.map((item) => {
          const playable = item.status === "ready";
          const start = Date.parse(item.started_at) / 1000;
          return (
            <button type="button" key={item.id} disabled={!playable} aria-pressed={selectedId === item.id}
              onClick={() => { continueRef.current = false; desiredTime.current = start; setAbsoluteTime(start); setSelectedId(item.id); }}>
              <span className="ad-recording-list__play" aria-hidden="true">{playable ? "▶" : "·"}</span>
              <span>{fmtTime(start)}</span>
              <strong>{item.duration_ms > 0 ? Math.max(1, Math.round(item.duration_ms / 60000)) + "m" : t("playback.unknownDuration")}</strong>
              {!playable && <small>{t(`playback.status.${item.status}`)}</small>}
            </button>
          );
        })}
      </div>
    </section>
  );

  if (readyRecordings.length === 0) return <>{playlist}<Empty>{t("playback.emptyVideo")}</Empty>{seekTo != null && <p className="ad-playback__notice" role="status">{t("playback.noVideoForMoment", { time: fmtTime(seekTo) })}</p>}<p className="ad-playback__notice">{t("playback.emptyVideoHint")}</p>{segmentList}</>;

  return (
    <>
    {playlist}
    <div className="ad-playback">
      <div className="ad-playback__viewer">
        <div className="ad-playback__stage">
          {videoError ? (
            <span className="ad-playback__unavailable" role="alert">{videoError}</span>
          ) : videoUrl && selected ? (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              onLoadedMetadata={(event) => {
                event.currentTarget.playbackRate = speed;
                const wanted = desiredTime.current;
                if (wanted != null) event.currentTarget.currentTime = Math.max(0, wanted - Date.parse(selected.started_at) / 1000);
                if (continueRef.current) { continueRef.current = false; void event.currentTarget.play().catch(() => {}); }
              }}
              onTimeUpdate={(event) => setAbsoluteTime(Date.parse(selected.started_at) / 1000 + event.currentTarget.currentTime)}
              onEnded={() => {
                const index = readyRecordings.findIndex((item) => item.id === selected.id);
                const next = readyRecordings[index + 1];
                if (next) {
                  continueRef.current = true;
                  const start = Date.parse(next.started_at) / 1000;
                  desiredTime.current = start;
                  setAbsoluteTime(start);
                  setSelectedId(next.id);
                }
              }}
              onError={() => setVideoError(t("playback.videoUnavailable"))}
            />
          ) : (
            <Spinner label={t("playback.loadingVideo")} />
          )}
          {selected ? <span className="ad-playback__counter"><bdi dir="ltr">{fmtTime(absoluteTime)}</bdi></span> : null}
        </div>

        <div className="ad-playback__speeds" aria-label={t("playback.speed")}>
          {SPEEDS.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={speed === value}
              className={speed === value ? "on" : ""}
              onClick={() => { setSpeed(value); if (videoRef.current) videoRef.current.playbackRate = value; }}
            >
              {value}×
            </button>
          ))}
          <span>{t("playback.videoNotice")}</span>
        </div>
        {missedMoment ? (
          <p className="ad-playback__notice" role="status">
            {t("playback.noVideoAt", { time: fmtTime(seekTo as number) })}
          </p>
        ) : null}
        {segmentList}
        {focusUrl && <div className="ad-segments__head"><span title={focusUrl}>{t("playback.url")}: <bdi dir="ltr">{focusUrl}</bdi></span>{onClearFocus && <button type="button" onClick={onClearFocus}>{t("playback.clearFocus")}</button>}</div>}
        <UnifiedTimeline from={from} to={to} states={null} activity={activity} buckets={buckets} visits={visits} shots={null} onSeek={seekAbsolute} />
      </div>

      <aside className="ad-playback__meta">
        <h3>{t("playback.details")}</h3>
        <dl>
          <div>
            <dt>{t("playback.app")}</dt>
            <dd>{currentSample?.app_name || "—"}</dd>
          </div>
          <div>
            <dt>{t("playback.window")}</dt>
            <dd title={currentSample?.window_title}>{currentSample?.window_title || "—"}</dd>
          </div>
          <div>
            <dt>{t("playback.website")}</dt>
            <dd>{currentVisit?.domain || "—"}</dd>
          </div>
          <div>
            <dt>{t("playback.url")}</dt>
            <dd>
              <code dir="ltr" title={currentVisit?.url}>
                {currentVisit?.url || "—"}
              </code>
            </dd>
          </div>
          <div>
            <dt>{t("playback.keys")}</dt>
            <dd>{currentKeys.toLocaleString()}</dd>
          </div>
        </dl>
      </aside>
    </div>
    </>
  );
}
