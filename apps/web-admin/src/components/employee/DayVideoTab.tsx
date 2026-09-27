import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { RecordingAsset } from "../../api/media";
import type { ActivityResponse } from "../../api/types";
import { fmtDuration } from "../../format";
import { appSegments } from "../reports/appSegments";
import { isPlayable, recordingSpan, sortRecordings, workingWindow, type Span } from "./dayModel";

const hm = (ts: number, lang: string) =>
  new Date(ts * 1000).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });

/**
 * Tab 2 -- the whole day as video. A ribbon of the working hours shows where
 * video exists and where the employee was active; a click anywhere plays that
 * minute. Below it, every recorded clip in order.
 */
export function DayVideoTab({
  day,
  recordings,
  activity,
  playhead,
  onPlay,
}: {
  day: Span;
  recordings: RecordingAsset[];
  activity: ActivityResponse | null;
  playhead: number | null;
  onPlay: (ts: number) => void;
}) {
  const { t, i18n } = useTranslation("reports");
  const clips = sortRecordings(recordings);
  const blocks = activity ? appSegments(activity.samples) : [];
  const frame = workingWindow(day, [
    ...clips.flatMap((r) => [recordingSpan(r).start, recordingSpan(r).end]),
    ...blocks.flatMap((b) => [b.ts, b.ts + b.dur]),
  ]);
  const span = frame.end - frame.start;
  const pct = (ts: number) => `${Math.min(100, Math.max(0, ((ts - frame.start) / span) * 100))}%`;
  const width = (a: number, b: number) => `${Math.max(0.3, ((Math.min(b, frame.end) - Math.max(a, frame.start)) / span) * 100)}%`;
  const hours: number[] = [];
  for (let h = frame.start; h <= frame.end; h += 3600) hours.push(h);
  const step = Math.max(1, Math.ceil(hours.length / 10));
  const recordedS = clips.filter(isPlayable).reduce((sum, r) => sum + (recordingSpan(r).end - recordingSpan(r).start), 0);

  const seekFromClick = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // The ribbon is always drawn left-to-right, even in Arabic: time reads that way on every clock.
    const ratio = (event.clientX - rect.left) / rect.width;
    onPlay(Math.round(frame.start + Math.min(1, Math.max(0, ratio)) * span));
  };

  return (
    <div className="ev-day">
      <div className="ev-day__summary">
        <div><span>{t("employee.video.recorded")}</span><strong><bdi dir="ltr">{fmtDuration(recordedS)}</bdi></strong></div>
        <div><span>{t("employee.video.clips")}</span><strong>{clips.filter(isPlayable).length}</strong></div>
        <p>{t("employee.video.ribbonHint")}</p>
      </div>

      <div className="ev-ribbon" dir="ltr">
        <div
          className="ev-ribbon__track"
          role="slider"
          tabIndex={0}
          aria-label={t("employee.video.ribbon")}
          aria-valuemin={frame.start}
          aria-valuemax={frame.end}
          aria-valuenow={playhead ?? frame.start}
          aria-valuetext={playhead ? hm(playhead, i18n.language) : undefined}
          onClick={seekFromClick}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const base = playhead ?? frame.start;
            onPlay(base + (event.key === "ArrowRight" ? 60 : -60));
          }}
        >
          <div className="ev-ribbon__lane ev-ribbon__lane--activity">
            {blocks.map((b) => (
              <i key={`a${b.ts}`} style={{ left: pct(b.ts), width: width(b.ts, b.ts + b.dur) }} title={`${b.app} · ${hm(b.ts, i18n.language)}`} />
            ))}
          </div>
          <div className="ev-ribbon__lane ev-ribbon__lane--video">
            {clips.map((r) => {
              const s = recordingSpan(r);
              return <i key={r.id} className={`is-${r.status}`} style={{ left: pct(s.start), width: width(s.start, s.end) }} />;
            })}
          </div>
          {playhead != null && playhead >= frame.start && playhead <= frame.end ? (
            <span className="ev-ribbon__head" style={{ left: pct(playhead) }} />
          ) : null}
        </div>
        <div className="ev-ribbon__axis">
          {hours.filter((_, i) => i % step === 0).map((h) => (
            <span key={h} style={{ left: pct(h) }}>{hm(h, i18n.language)}</span>
          ))}
        </div>
      </div>
      <div className="ev-legend">
        <span><i className="ev-legend__video" />{t("employee.video.legendVideo")}</span>
        <span><i className="ev-legend__activity" />{t("employee.video.legendActivity")}</span>
      </div>

      {clips.length === 0 ? (
        <div className="ev-empty">
          <strong>{t("employee.video.empty")}</strong>
          <p>{t("employee.video.emptyHint")}</p>
        </div>
      ) : (
        <ol className="ev-clips">
          {clips.map((r) => {
            const s = recordingSpan(r);
            const playing = playhead != null && playhead >= s.start && playhead <= s.end;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className={`ev-clip${playing ? " is-playing" : ""}`}
                  disabled={!isPlayable(r)}
                  onClick={() => onPlay(s.start)}
                >
                  <span className="ev-clip__time"><bdi>{hm(s.start, i18n.language)}</bdi> – <bdi>{hm(s.end, i18n.language)}</bdi></span>
                  <span className="ev-clip__len"><bdi dir="ltr">{fmtDuration(s.end - s.start)}</bdi></span>
                  <span className={`ev-status ev-status--${r.status}`}>{t(`employee.video.status_${r.status}`)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
