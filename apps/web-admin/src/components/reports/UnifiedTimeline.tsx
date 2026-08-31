import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ActivityResponse,
  BrowserVisit,
  KeystrokeBucket,
  OsStateReport,
  ScreenshotMeta,
} from "../../api/types";
import { fmtDuration } from "../../format";
import { Empty } from "../ui";
import {
  buildAxisTicks,
  buildTimeline,
  maxTicksFor,
  positionIn,
  type ActivityBlock,
  type StateBlock,
  type TimelineState,
  type VisitBlock,
} from "./timeline";

// One band per question, stacked on a shared axis: what state the machine was
// in, what was in front, which site, when someone was typing, and where the
// screenshots are. Reading down a vertical slice answers "what was happening at
// 14:20" without cross-referencing five tabs.
//
// Incident markers are specified for this component but there are no incidents
// to draw yet (they arrive with the rule engine); the lane is deliberately
// absent rather than present and always empty.

// Offline is absent on purpose: it is drawn by the .ad-tl__block--offline hatch
// in the stylesheet, and an inline background here would override it.
const STATE_COLOR: Record<TimelineState, string | undefined> = {
  active: "var(--positive)",
  idle: "var(--data-amber)",
  suspended: "var(--data-lavender)",
  offline: undefined,
};

/** Stable per-app colour so the same app keeps its colour down the lane. */
const APP_COLORS = [
  "var(--data-sky)",
  "var(--data-mint)",
  "var(--data-lavender)",
  "var(--data-teal)",
  "var(--data-amber)",
  "var(--data-rose)",
];

function appColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return APP_COLORS[Math.abs(hash) % APP_COLORS.length];
}

type Hover = { xPct: number; ts: number; lines: string[] } | null;

export function UnifiedTimeline({
  from,
  to,
  states,
  activity,
  buckets,
  visits,
  shots,
  onSeek,
}: {
  from: number;
  to: number;
  states: OsStateReport | null;
  activity: ActivityResponse | null;
  buckets: KeystrokeBucket[] | null;
  visits: BrowserVisit[] | null;
  shots: ScreenshotMeta[] | null;
  /** Opens the player at a moment. Every block and marker is a way in. */
  onSeek?: (ts: number) => void;
}) {
  const { t, i18n } = useTranslation("reports");
  const [hover, setHover] = useState<Hover>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Label density follows the measured width, not the time span alone: twelve
  // hourly labels fit a desktop column and overprint each other on a phone.
  const [frameWidth, setFrameWidth] = useState(0);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    setFrameWidth(el.getBoundingClientRect().width);
    // Absent in jsdom and in older browsers. Without it the width is measured
    // once and the axis simply does not re-thin on resize, which degrades to
    // the previous behaviour rather than breaking.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setFrameWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(
    () =>
      buildTimeline({
        from,
        to,
        now: Math.floor(Date.now() / 1000),
        states,
        samples: activity?.samples ?? [],
        buckets: buckets ?? [],
        visits: visits ?? [],
        shots: shots ?? [],
      }),
    [from, to, states, activity, buckets, visits, shots],
  );

  const ticks = useMemo(
    () => buildAxisTicks(from, to, i18n.language, maxTicksFor(frameWidth)),
    [from, to, i18n.language, frameWidth],
  );

  const clock = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString(i18n.language, {
      hour: "2-digit",
      minute: "2-digit",
    });

  const pct = (ts: number) => positionIn(from, to, ts) * 100;
  const width = (start: number, end: number) => Math.max(pct(end) - pct(start), 0.12);

  if (model.empty) {
    return <Empty>{t("timeline.empty")}</Empty>;
  }

  const show = (event: { clientX: number }, ts: number, lines: string[]) => {
    const rect = trackRef.current?.getBoundingClientRect();
    const xPct = rect ? ((event.clientX - rect.left) / rect.width) * 100 : 0;
    setHover({ xPct: Math.min(98, Math.max(2, xPct)), ts, lines });
  };

  const seekProps = (ts: number, label: string) =>
    onSeek
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": label,
          onClick: () => onSeek(ts),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSeek(ts);
            }
          },
        }
      : {};

  const stateLabel = (state: TimelineState) => t(`timeline.states.${state}`);

  const lanes: { key: string; label: string; body: React.ReactNode }[] = [
    {
      key: "state",
      label: t("timeline.lanes.state"),
      body: model.states.map((block: StateBlock) => (
        <div
          key={`${block.state}-${block.start}`}
          className={`ad-tl__block${block.state === "offline" ? " ad-tl__block--offline" : ""}`}
          style={{
            insetInlineStart: `${pct(block.start)}%`,
            width: `${width(block.start, block.end)}%`,
            background: STATE_COLOR[block.state],
          }}
          onMouseEnter={(e) =>
            show(e, block.start, [
              stateLabel(block.state),
              `${clock(block.start)} – ${clock(block.end)}`,
              fmtDuration(block.end - block.start),
            ])
          }
          onMouseLeave={() => setHover(null)}
          {...seekProps(block.start, `${stateLabel(block.state)} ${clock(block.start)}`)}
        />
      )),
    },
  ];

  if (model.activity.length > 0) {
    lanes.push({
      key: "apps",
      label: t("timeline.lanes.applications"),
      body: model.activity.map((block: ActivityBlock) => (
        <div
          key={`${block.app}-${block.start}`}
          className="ad-tl__block"
          style={{
            insetInlineStart: `${pct(block.start)}%`,
            width: `${width(block.start, block.end)}%`,
            background: appColor(block.app),
          }}
          onMouseEnter={(e) =>
            show(e, block.start, [
              block.app,
              block.windowTitle,
              `${clock(block.start)} · ${fmtDuration(block.end - block.start)}`,
            ].filter(Boolean))
          }
          onMouseLeave={() => setHover(null)}
          {...seekProps(block.start, `${block.app} ${clock(block.start)}`)}
        />
      )),
    });
  }

  if (model.visits.length > 0) {
    lanes.push({
      key: "sites",
      label: t("timeline.lanes.websites"),
      body: model.visits.map((block: VisitBlock, index) => (
        <div
          key={`${block.domain}-${block.start}-${index}`}
          className="ad-tl__block"
          style={{
            insetInlineStart: `${pct(block.start)}%`,
            width: `${width(block.start, block.end)}%`,
            background: "var(--info)",
          }}
          onMouseEnter={(e) =>
            show(e, block.start, [
              block.domain,
              block.title,
              `${clock(block.start)} · ${fmtDuration(block.end - block.start)}`,
            ].filter(Boolean))
          }
          onMouseLeave={() => setHover(null)}
          {...seekProps(block.start, `${block.domain} ${clock(block.start)}`)}
        />
      )),
    });
  }

  if (model.input.length > 0) {
    lanes.push({
      key: "input",
      label: t("timeline.lanes.input"),
      body: model.input.map((bar) => (
        <div
          key={bar.start}
          className="ad-tl__block ad-tl__block--input"
          style={{
            insetInlineStart: `${pct(bar.start)}%`,
            width: `${width(bar.start, bar.start + 60)}%`,
            // Height, not colour, carries the value: a heat ramp would imply a
            // judgement about the count, which these are explicitly not for.
            height: `${20 + bar.intensity * 80}%`,
            background: "var(--brand-500)",
          }}
          onMouseEnter={(e) =>
            show(e, bar.start, [
              t("timeline.inputAt", { count: bar.count }),
              clock(bar.start),
            ])
          }
          onMouseLeave={() => setHover(null)}
          {...seekProps(bar.start, `${bar.count} ${clock(bar.start)}`)}
        />
      )),
    });
  }

  if (model.screenshots.length > 0) {
    lanes.push({
      key: "shots",
      label: t("timeline.lanes.screenshots"),
      body: model.screenshots.map((marker) => (
        <div
          key={marker.clientUuid}
          className="ad-tl__marker"
          style={{ insetInlineStart: `${pct(marker.ts)}%` }}
          onMouseEnter={(e) => show(e, marker.ts, [t("timeline.lanes.screenshots"), clock(marker.ts)])}
          onMouseLeave={() => setHover(null)}
          {...seekProps(marker.ts, `${t("timeline.lanes.screenshots")} ${clock(marker.ts)}`)}
        />
      )),
    });
  }

  return (
    <div className="ad-tl">
      <div className="ad-tl__legend">
        {(["active", "idle", "suspended", "offline"] as TimelineState[]).map((state) => (
          <span key={state} className="ad-tl__legenditem">
            <i
              className={state === "offline" ? "ad-tl__block--offline" : undefined}
              style={{ background: STATE_COLOR[state] }}
            />
            {stateLabel(state)}
          </span>
        ))}
      </div>

      {/* The axis and every lane share one LTR frame. Time reads earliest-first
          in both directions on purpose: mirroring a clock axis under RTL puts
          the end of the day on the left and misreads at a glance, even though
          the surrounding prose stays right-to-left. */}
      <div className="ad-tl__frame" dir="ltr" ref={trackRef}>
        <div className="ad-tl__axis">
          {ticks.map((tick) => (
            <span
              key={tick.ts}
              className={[
                "ad-tl__tick",
                tick.major ? "ad-tl__tick--major" : "",
                // Centring would hang the outermost labels off the frame.
                pct(tick.ts) < 4 ? "ad-tl__tick--first" : "",
                pct(tick.ts) > 96 ? "ad-tl__tick--last" : "",
              ].filter(Boolean).join(" ")}
              style={{ left: `${pct(tick.ts)}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>

        {lanes.map((lane) => (
          <div key={lane.key} className="ad-tl__lane">
            <span className="ad-tl__lanelabel">{lane.label}</span>
            <div className="ad-tl__track">
              {ticks.map((tick) => (
                <span
                  key={tick.ts}
                  className="ad-tl__grid"
                  style={{ left: `${pct(tick.ts)}%` }}
                  aria-hidden
                />
              ))}
              {lane.body}
            </div>
          </div>
        ))}

        {hover && (
          <div className="ad-tl__tip" style={{ left: `${hover.xPct}%` }} role="status">
            {hover.lines.map((line, index) => (
              <span key={index}>{line}</span>
            ))}
          </div>
        )}
      </div>

      <p className="ad-tl__note">{t("timeline.note")}</p>
    </div>
  );
}
