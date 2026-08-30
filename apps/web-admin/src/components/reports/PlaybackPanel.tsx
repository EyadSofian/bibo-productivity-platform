import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchImageObjectUrl } from "../../api/client";
import type {
  ActivityResponse,
  BrowserVisit,
  KeystrokeBucket,
  ScreenshotMeta,
} from "../../api/types";
import { fmtDuration, fmtTime } from "../../format";
import { Empty, Spinner } from "../ui";

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

export function PlaybackPanel({
  shots,
  activity,
  visits,
  buckets,
}: {
  shots: ScreenshotMeta[];
  activity: ActivityResponse;
  visits: BrowserVisit[];
  buckets: KeystrokeBucket[];
}) {
  const { t } = useTranslation("reports");
  const frames = useMemo(
    () => assemblePlaybackFrames(shots, activity, visits, buckets),
    [shots, activity, visits, buckets],
  );
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const frame = frames[index];

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, frames.length - 1)));
  }, [frames.length]);

  useEffect(() => {
    if (!frame) return;
    let alive = true;
    let made: string | null = null;
    setImageUrl(null);
    setImageError(false);
    fetchImageObjectUrl(frame.client_uuid)
      .then((url) => {
        made = url;
        if (alive) setImageUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (alive) setImageError(true);
      });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [frame]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= frames.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, Math.max(100, 1000 / speed));
    return () => window.clearInterval(timer);
  }, [playing, speed, frames.length]);

  if (!frame) return <Empty>{t("playback.empty")}</Empty>;

  return (
    <div className="ad-playback">
      <div className="ad-playback__viewer">
        <div className="ad-playback__stage">
          {imageUrl ? (
            <img src={imageUrl} alt={t("playback.frameAlt", { time: fmtTime(frame.ts) })} />
          ) : imageError ? (
            <span className="ad-playback__unavailable">{t("screenshots.unavailable")}</span>
          ) : (
            <Spinner label={t("playback.loadingFrame")} />
          )}
          <span className="ad-playback__counter">
            <bdi dir="ltr">
              {index + 1} / {frames.length}
            </bdi>
          </span>
          {frame.gapBeforeS > 0 ? (
            <span className="ad-playback__gap">
              {t("playback.gap", { duration: fmtDuration(frame.gapBeforeS) })}
            </span>
          ) : null}
        </div>

        <div className="ad-playback__controls">
          <button
            type="button"
            className="ad-playback__play"
            onClick={() => setPlaying((value) => !value)}
          >
            <span aria-hidden>{playing ? "Ⅱ" : "▶"}</span>
            {playing ? t("playback.pause") : t("playback.play")}
          </button>
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={index}
            aria-label={t("playback.scrub")}
            onChange={(event) => {
              setPlaying(false);
              setIndex(Number(event.target.value));
            }}
          />
          <strong className="ad-playback__time">
            <bdi dir="ltr">{fmtTime(frame.ts)}</bdi>
          </strong>
        </div>

        <div className="ad-playback__speeds" aria-label={t("playback.speed")}>
          {SPEEDS.map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={speed === value}
              className={speed === value ? "on" : ""}
              onClick={() => setSpeed(value)}
            >
              {value}×
            </button>
          ))}
          <span>{t("playback.screenshotNotice")}</span>
        </div>
      </div>

      <aside className="ad-playback__meta">
        <h3>{t("playback.details")}</h3>
        <dl>
          <div>
            <dt>{t("playback.app")}</dt>
            <dd>{frame.app || "—"}</dd>
          </div>
          <div>
            <dt>{t("playback.window")}</dt>
            <dd title={frame.windowTitle ?? undefined}>{frame.windowTitle || "—"}</dd>
          </div>
          <div>
            <dt>{t("playback.website")}</dt>
            <dd>{frame.domain || "—"}</dd>
          </div>
          <div>
            <dt>{t("playback.url")}</dt>
            <dd>
              <code dir="ltr" title={frame.url ?? undefined}>
                {frame.url || "—"}
              </code>
            </dd>
          </div>
          <div>
            <dt>{t("playback.keys")}</dt>
            <dd>{frame.keyCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>{t("playback.resolution")}</dt>
            <dd>
              <bdi dir="ltr">
                {frame.width}×{frame.height}
              </bdi>
            </dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
