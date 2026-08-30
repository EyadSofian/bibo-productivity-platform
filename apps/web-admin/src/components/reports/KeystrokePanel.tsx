import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeystrokeBucket } from "../../api/types";
import { Empty } from "../ui";

// chart geometry
const BW = 24;
const STEP = 40;
const PAD = 20;
const H = 240;
const TOP = 14;
const BOT = 210;
const CHART_H = BOT - TOP;

// Counts only — never the keys themselves (privacy). The caption keeps that
// explicit. Bar chart across the day; click a bar/chip to inspect a bucket.
export function KeystrokePanel({ buckets }: { buckets: KeystrokeBucket[] }) {
  const { t } = useTranslation("reports");
  const [sel, setSel] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Default = the latest bucket. Selecting an hour shows the running total up to
  // that hour; later bars are dimmed ("shown up to that time").
  const active = sel ?? buckets.length - 1;

  // Keep the selected bar in view (scroll to it — e.g. the latest one on open).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || buckets.length === 0) return;
    const barCenter = PAD + active * STEP + BW / 2;
    el.scrollTo({ left: Math.max(0, barCenter - el.clientWidth / 2), behavior: "smooth" });
  }, [active, buckets.length]);

  if (buckets.length === 0) return <Empty>{t("keystrokes.empty")}</Empty>;

  const max = Math.max(...buckets.map((b) => b.count), 1);
  const shownTotal = buckets.slice(0, active + 1).reduce((s, b) => s + b.count, 0);
  const chartH = CHART_H;
  const svgW = PAD + buckets.length * STEP;

  const hh = (ts: number) => String(new Date(ts * 1000).getHours()).padStart(2, "0");
  const hhmm = (ts: number) => {
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div>
      <div className="ad-panelhead">
        <div className="ad-paneltitle">{t("keystrokes.title")}</div>
      </div>

      <div className="ad-act-total">
        <span className="ad-act-num">{shownTotal.toLocaleString()}</span>
        <span className="ad-act-lbl">{t("keystrokes.keypresses")}</span>
      </div>

      <div className="ad-chartscroll" ref={scrollRef}>
        <svg width={svgW} height={H} viewBox={`0 0 ${svgW} ${H}`} style={{ overflow: "visible" }}>
          {buckets.map((b, i) => {
            const h = (b.count / max) * chartH;
            const x = PAD + i * STEP;
            const y = BOT - h;
            const cx = x + BW / 2;
            const on = i === active;
            return (
              <g key={b.ts_bucket}>
                <rect
                  x={x}
                  y={y}
                  width={BW}
                  height={h}
                  rx={7}
                  fill={on ? "var(--brand-500)" : "var(--data-sky)"}
                  opacity={i > active ? 0.18 : 1}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSel(i)}
                />
                {i % 3 === 0 && (
                  <text
                    x={cx}
                    y={238}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill="var(--text-muted)"
                    fontFamily="var(--font-sans)"
                  >
                    {hh(b.ts_bucket)}
                  </text>
                )}
                {on && (
                  <g transform={`translate(${cx}, ${y})`}>
                    <rect x={-27} y={-30} width={54} height={24} rx={8} fill="var(--ink)" />
                    <text
                      x={0}
                      y={-13}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight={700}
                      fill="#fff"
                      fontFamily="var(--font-sans)"
                    >
                      {b.count.toLocaleString()}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="ad-timechips">
        {buckets.map((b, i) => (
          <button
            key={b.ts_bucket}
            className={`ad-timechip${i === active ? " ad-timechip--on" : ""}`}
            onClick={() => setSel(i)}
          >
            {hhmm(b.ts_bucket)}
          </button>
        ))}
      </div>

      <div className="ad-signal-note">
        <strong>{t("keystrokes.minuteBuckets")}</strong>
        <span>{t("keystrokes.activityMeaning")}</span>
        <small>{t("keystrokes.privacyNote")}</small>
      </div>
    </div>
  );
}
