import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { OsStateReport } from "../api/types";
import { buildAxisTicks, buildStateBand, maxTicksFor, positionIn, type TimelineState } from "../lib/timeline";
import { fmtClock, fmtDuration, intlLocale } from "../lib/format";

/**
 * Charts are hand-built SVG/CSS: three forms, no library.
 * - DayRibbon: when in the day the device was active / idle / away / offline.
 * - HourBars: one measure per hour (single series, so no legend).
 * - SplitBar: how a total divides, with a legend that carries the numbers.
 * Every chart ships a visually hidden table so the figures are not colour-only
 * or pointer-only.
 */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const FILL: Record<TimelineState, string> = {
  active: "fill-active",
  idle: "fill-idle",
  suspended: "fill-away",
  offline: "fill-offline",
};

type Tip = { pct: number; title: string; body: string } | null;

function ChartTip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ insetInlineStart: `${tip.pct}%` } as CSSProperties} role="presentation">
      <strong>{tip.title}</strong>
      <span>{tip.body}</span>
    </div>
  );
}

/* ---------- day ribbon ---------- */

export function DayRibbon({
  report,
  from,
  to,
  now,
  compact = false,
}: {
  report: OsStateReport | null | undefined;
  from: number;
  to: number;
  now: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const blocks = buildStateBand(report ?? null, from, to, now);
  const ticks = buildAxisTicks(from, to, intlLocale(), maxTicksFor(width || 600));
  const nowPct = now >= from && now <= to ? positionIn(from, to, now) * 100 : null;

  return (
    <figure className={`ribbon${compact ? " ribbon-compact" : ""}`}>
      <div className="ribbon-track" ref={ref} onPointerLeave={() => setTip(null)}>
        {blocks.map((b) => {
          const start = positionIn(from, to, b.start) * 100;
          const w = positionIn(from, to, b.end) * 100 - start;
          return (
            <span
              key={`${b.state}-${b.start}`}
              className={`ribbon-seg ${FILL[b.state]}`}
              style={{ insetInlineStart: `${start}%`, width: `${w}%` } as CSSProperties}
              onPointerEnter={() =>
                setTip({
                  pct: start + w / 2,
                  title: t(`state.${b.state}`),
                  body: `${fmtClock(b.start)} – ${fmtClock(b.end)} · ${fmtDuration(b.end - b.start)}`,
                })
              }
            />
          );
        })}
        {nowPct !== null ? <span className="ribbon-now" style={{ insetInlineStart: `${nowPct}%` } as CSSProperties} /> : null}
        <ChartTip tip={tip} />
      </div>
      {!compact ? (
        <div className="ribbon-axis" aria-hidden>
          {ticks.map((tick) => (
            <span key={tick.ts} style={{ insetInlineStart: `${positionIn(from, to, tick.ts) * 100}%` } as CSSProperties}>
              {tick.label}
            </span>
          ))}
        </div>
      ) : null}
      <table className="sr-only">
        <caption>{t("charts.ribbonCaption")}</caption>
        <thead>
          <tr>
            <th>{t("charts.state")}</th>
            <th>{t("charts.from")}</th>
            <th>{t("charts.to")}</th>
            <th>{t("charts.duration")}</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={`${b.state}-${b.start}`}>
              <td>{t(`state.${b.state}`)}</td>
              <td>{fmtClock(b.start)}</td>
              <td>{fmtClock(b.end)}</td>
              <td>{fmtDuration(b.end - b.start)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* ---------- hour bars ---------- */

export type HourBar = { key: string | number; label: string; value: number; tip: string };

export function HourBars({
  bars,
  caption,
  valueLabel,
  format,
  color = "var(--chart-1)",
  height = 160,
}: {
  bars: HourBar[];
  caption: string;
  valueLabel: string;
  format: (v: number) => string;
  color?: string;
  height?: number;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  // Label every bar when there is room, otherwise every third: a 24-label axis
  // overprints itself on anything narrower than a desktop.
  const every = bars.length > 14 ? 3 : 1;
  return (
    <figure className="bars" style={{ "--bars-h": `${height}px`, "--bar-color": color } as CSSProperties}>
      <div className="bars-plot" onPointerLeave={() => setTip(null)}>
        <span className="bars-max num" aria-hidden>
          {format(max)}
        </span>
        <span className="bars-grid" aria-hidden />
        {bars.map((b, i) => {
          const pct = (b.value / max) * 100;
          return (
            <span
              key={b.key}
              className="bars-col"
              onPointerEnter={() => setTip({ pct: ((i + 0.5) / bars.length) * 100, title: b.label, body: b.tip })}
            >
              <span className={`bars-bar${b.value === 0 ? " is-zero" : ""}`} style={{ height: `${Math.max(pct, b.value > 0 ? 3 : 0)}%` }} />
            </span>
          );
        })}
        <ChartTip tip={tip} />
      </div>
      <div className="bars-axis" aria-hidden>
        {bars.map((b, i) => (
          <span key={b.key}>{i % every === 0 ? b.label : ""}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>{caption}</th>
            <th>{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b) => (
            <tr key={b.key}>
              <td>{b.label}</td>
              <td>{format(b.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* ---------- split bar ---------- */

export type SplitPart = { key: string; label: string; value: number; className: string; display: ReactNode };

export function SplitBar({ parts, caption }: { parts: SplitPart[]; caption: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <figure className="split" style={{ margin: 0, display: "grid", gap: 12 }}>
      <div className="split-bar" role="img" aria-label={caption}>
        {total > 0
          ? parts
              .filter((p) => p.value > 0)
              .map((p) => <span key={p.key} className={p.className} style={{ flexGrow: p.value }} />)
          : null}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className={`swatch ${p.className}`} aria-hidden />
            {p.label}
            <strong>{p.display}</strong>
          </li>
        ))}
      </ul>
    </figure>
  );
}
