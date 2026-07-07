import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityResponse } from "../../api/types";
import { Empty } from "../ui";

// Multi-hue app palette (offline design order). Each app keeps a stable color
// by its rank in the breakdown — display-only, the data is never reordered
// beyond the usual "most-used first" sort.
const APP_COLORS = [
  "var(--data-lavender)",
  "var(--data-mint)",
  "var(--data-sky)",
  "var(--data-amber)",
  "var(--data-rose)",
  "var(--data-teal)",
];
const colorAt = (i: number) => APP_COLORS[i % APP_COLORS.length];
// Vertical fill for a timeline block (top = color, bottom = darker) — offline look.
const segFill = (c: string) => `linear-gradient(180deg, ${c}, color-mix(in srgb, ${c} 78%, #000))`;
// Horizontal fill for an app bar (light → full) — offline look.
const barFill = (c: string) => `linear-gradient(90deg, color-mix(in srgb, ${c} 70%, #fff), ${c})`;

/** Local hour label ("14:00") for a unix-second timestamp. */
const hourLabel = (ts: number) => `${String(new Date(ts * 1000).getHours()).padStart(2, "0")}:00`;
/** "3h 42m" / "1h 00m" / "40m" — minutes are padded when hours show (offline look).
 *  Local to this panel so the shared fmtDuration stays untouched. */
const fmtHM = (s: number) => {
  const v = Math.max(0, s);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
};

export function ActivityPanel({ data }: { data: ActivityResponse }) {
  const { t } = useTranslation("reports");
  // Timeline hover tooltip (app/idle · duration). Lives outside the bar so it
  // isn't clipped by the bar's overflow:hidden.
  const [tip, setTip] = useState<{ label: string; left: number } | null>(null);
  const breakdown = [...data.breakdown].sort((a, b) => b.duration_s - a.duration_s);
  const total = breakdown.reduce((s, b) => s + b.duration_s, 0);

  if (breakdown.length === 0) return <Empty>{t("activity.empty")}</Empty>;

  const colorOf = new Map(breakdown.map((b, i) => [b.app_name, colorAt(i)]));
  const max = breakdown[0].duration_s || 1; // bars scale to the top app (offline look)

  // ── Time-of-day timeline, built from the real activity samples ──
  const HOUR = 3600;
  const samples = [...data.samples].filter((s) => s.duration_s > 0).sort((a, b) => a.ts - b.ts);
  // Merge back-to-back samples of the same app into one block (visual clarity;
  // the underlying data is unchanged).
  type Block = { app: string; ts: number; dur: number };
  const blocks: Block[] = [];
  for (const s of samples) {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.app === s.app_name && s.ts - (prev.ts + prev.dur) < 60) {
      prev.dur = s.ts + s.duration_s - prev.ts;
    } else {
      blocks.push({ app: s.app_name, ts: s.ts, dur: s.duration_s });
    }
  }

  const hasTimeline = blocks.length > 0;
  const last = hasTimeline ? Math.max(...blocks.map((b) => b.ts + b.dur)) : 0;
  const start = hasTimeline ? Math.floor(blocks[0].ts / HOUR) * HOUR : 0;
  const end = Math.max(start + HOUR, Math.ceil(last / HOUR) * HOUR);
  const span = end - start || 1;
  const pct = (ts: number) => ((ts - start) / span) * 100;

  // Active blocks, idle gaps between them, and the two ends (outside the
  // recorded range → solid, no stripes).
  type Seg = { kind: "app" | "idle" | "end"; app?: string; left: number; width: number; dur: number };
  const segs: Seg[] = [];
  let cursor = start;
  blocks.forEach((b, i) => {
    if (b.ts > cursor) {
      segs.push({
        kind: i === 0 ? "end" : "idle",
        left: pct(cursor),
        width: pct(b.ts) - pct(cursor),
        dur: b.ts - cursor,
      });
    }
    const bEnd = b.ts + b.dur;
    segs.push({ kind: "app", app: b.app, left: pct(b.ts), width: pct(bEnd) - pct(b.ts), dur: b.dur });
    cursor = Math.max(cursor, bEnd);
  });
  if (cursor < end) {
    segs.push({ kind: "end", left: pct(cursor), width: pct(end) - pct(cursor), dur: end - cursor });
  }
  // Longer blocks read denser — opacity scales with duration (0.55…1.0), a
  // real signal, not decoration. Matches the offline design's segment shading.
  const maxDur = Math.max(1, ...blocks.map((b) => b.dur));
  const intensity = (dur: number) => 0.55 + 0.45 * (dur / maxDur);

  // Axis ticks — aim for ~6 labels across the span.
  const hours = Math.max(1, Math.round(span / HOUR));
  const step = Math.max(1, Math.ceil(hours / 6));
  const ticks: number[] = [];
  for (let h = start; h <= end; h += step * HOUR) ticks.push(h);

  // ── Donut (share of total active time) ──
  const R = 57.5;
  const C = 2 * Math.PI * R;
  // Round caps + a ~1px visible gap. A round cap protrudes ~strokeWidth/2 (7.5px)
  // per end, so budget 15px for the two caps plus 1px of actual separation.
  const GAP = 16;
  let cum = 0;
  const arcs = breakdown.map((b, i) => {
    const frac = total > 0 ? b.duration_s / total : 0;
    const len = Math.max(0, frac * C - GAP);
    const arc = { color: colorAt(i), len, off: -cum };
    cum += frac * C;
    return arc;
  });

  return (
    <div className="ad-twocol">
      {/* Today's timeline */}
      <div className="bibo-card bibo-card--default ad-cardpad">
        <div className="ad-panelhead">
          <div className="ad-paneltitle">{t("activity.timeline")}</div>
        </div>
        {hasTimeline ? (
          <>
            <div className="ad-tlbox">
              <div className="ad-timeline">
                {segs.map((s, i) => {
                  const center = Math.min(96, Math.max(4, s.left + s.width / 2));
                  if (s.kind === "app") {
                    return (
                      <div
                        key={i}
                        className="ad-tlseg"
                        onMouseEnter={() => setTip({ label: `${s.app} · ${fmtHM(s.dur)}`, left: center })}
                        onMouseLeave={() => setTip(null)}
                        style={{
                          left: `${s.left}%`,
                          width: `${s.width}%`,
                          background: segFill(colorOf.get(s.app as string) as string),
                          opacity: intensity(s.dur),
                        }}
                      />
                    );
                  }
                  if (s.kind === "idle") {
                    return (
                      <div
                        key={i}
                        className="ad-tlseg idle"
                        onMouseEnter={() => setTip({ label: `${t("activity.idle")} · ${fmtHM(s.dur)}`, left: center })}
                        onMouseLeave={() => setTip(null)}
                        style={{ left: `${s.left}%`, width: `${s.width}%` }}
                      />
                    );
                  }
                  return <div key={i} className="ad-tlseg end" style={{ left: `${s.left}%`, width: `${s.width}%` }} />;
                })}
              </div>
              {tip && (
                <div className="ad-tltip" style={{ left: `${tip.left}%` }}>
                  {tip.label}
                </div>
              )}
            </div>
            <div className="ad-tlaxis">
              {ticks.map((h) => (
                <span key={h}>{hourLabel(h)}</span>
              ))}
            </div>
          </>
        ) : (
          <Empty>{t("activity.empty")}</Empty>
        )}
      </div>

      {/* App & window breakdown */}
      <div className="bibo-card bibo-card--default ad-cardpad">
        <div className="ad-panelhead">
          <div className="ad-paneltitle">{t("activity.breakdown")}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <div className="bibo-donut" style={{ position: "relative", width: 130, height: 130 }}>
            <svg width="130" height="130">
              {arcs.map((a, i) => (
                <circle
                  key={i}
                  cx="65"
                  cy="65"
                  r={R}
                  fill="none"
                  stroke={a.color}
                  strokeWidth="15"
                  strokeDasharray={`${a.len} ${C - a.len}`}
                  strokeDashoffset={a.off}
                  strokeLinecap="round"
                  transform="rotate(-90 65 65)"
                />
              ))}
            </svg>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontWeight: 800,
                  fontSize: 26,
                  letterSpacing: "-0.02em",
                  color: "var(--text-primary)",
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}
              >
                {fmtHM(total)}
              </div>
            </div>
          </div>
        </div>
        <div className="ad-appbars">
          {breakdown.map((b, i) => (
            <div className="ad-appbar" key={b.app_name}>
              <div className="ad-appbar__name">
                <span className="dot" style={{ background: colorAt(i) }} />
                <span className="txt" title={b.app_name}>
                  {b.app_name}
                </span>
              </div>
              <div className="ad-appbar__track">
                <div
                  className="ad-appbar__fill"
                  style={{ width: `${(b.duration_s / max) * 100}%`, background: barFill(colorAt(i)) }}
                />
              </div>
              <div className="ad-appbar__val">{fmtHM(b.duration_s)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
