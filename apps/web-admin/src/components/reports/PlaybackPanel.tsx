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

export function PlaybackPanel({
  employeeId,
  from,
  to,
  activity,
  visits,
  buckets,
  seekTo,
}: {
  employeeId: string;
  from: number;
  to: number;
  activity: ActivityResponse;
  visits: BrowserVisit[];
  buckets: KeystrokeBucket[];
  /** Unix seconds to open at; the nearest frame wins. */
  seekTo?: number | null;
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
    const target = recordingAt(recordings ?? [], ts);
    if (target) {
      if (target.id === selectedId && videoRef.current?.readyState) {
        videoRef.current.currentTime = Math.max(0, ts - Date.parse(target.started_at) / 1000);
      }
      setSelectedId(target.id);
    }
  };

  useEffect(() => {
    if (!recordings?.length) return;
    const target = recordingAt(recordings, seekTo ?? from) ?? recordings.find((item) => item.status !== "failed") ?? recordings[0];
    desiredTime.current = seekTo ?? Date.parse(target.started_at) / 1000;
    setSelectedId(target.id);
  }, [recordings, seekTo, from]);

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

  if (recordings == null) return <Spinner label={t("playback.loadingVideo")} />;
  if (recordings.length === 0) return <Empty>{t("playback.emptyVideo")}</Empty>;

  return (
    <div className="ad-playback">
      <div className="ad-playback__viewer">
        <div className="ad-playback__stage">
          {videoUrl && selected ? (
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              playsInline
              onLoadedMetadata={(event) => {
                const wanted = desiredTime.current;
                if (wanted != null) event.currentTarget.currentTime = Math.max(0, wanted - Date.parse(selected.started_at) / 1000);
              }}
              onTimeUpdate={(event) => setAbsoluteTime(Date.parse(selected.started_at) / 1000 + event.currentTarget.currentTime)}
              onError={() => setVideoError(t("playback.videoUnavailable"))}
            />
          ) : videoError ? (
            <span className="ad-playback__unavailable">{videoError}</span>
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
  );
}
