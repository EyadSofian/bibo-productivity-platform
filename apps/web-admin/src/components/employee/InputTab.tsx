import { useTranslation } from "react-i18next";
import type { KeystrokeBucket, OsStateReport } from "../../api/types";
import { fmtDuration } from "../../format";
import { workingWindow, type Span } from "./dayModel";

const HOUR = 3600;

const hourLabel = (ts: number, lang: string) =>
  new Date(ts * 1000).toLocaleTimeString(lang, { hour: "numeric" });

/**
 * Tab 3 -- how hard the keyboard and mouse were used. Keypresses by hour, and
 * the share of the day that was active (any keyboard or mouse input), idle or
 * away. Counts only: what was typed is never recorded.
 */
export function InputTab({
  day,
  buckets,
  states,
}: {
  day: Span;
  buckets: KeystrokeBucket[];
  states: OsStateReport | null;
}) {
  const { t, i18n } = useTranslation("reports");
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const activeS = states?.totals.active_s ?? 0;
  const perMinute = activeS > 0 ? Math.round(total / (activeS / 60)) : null;

  const byHour = new Map<number, number>();
  for (const b of buckets) {
    const hour = b.ts_bucket - (b.ts_bucket % HOUR);
    byHour.set(hour, (byHour.get(hour) ?? 0) + b.count);
  }
  const frame = workingWindow(day, [
    ...buckets.map((b) => b.ts_bucket),
    ...(states?.intervals ?? []).filter((i) => i.state === "active").flatMap((i) => [i.ts, i.ts + i.duration_s]),
  ]);
  const hours: number[] = [];
  for (let h = frame.start; h < frame.end; h += HOUR) hours.push(h);
  const peak = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const maxHour = Math.max(1, ...hours.map((h) => byHour.get(h) ?? 0));

  const totals = states?.totals;
  const parts = totals
    ? [
        { key: "active", s: totals.active_s },
        { key: "idle", s: totals.idle_s },
        { key: "away", s: totals.suspended_s },
        { key: "offline", s: totals.offline_s },
      ]
    : [];
  const partsTotal = Math.max(1, parts.reduce((sum, p) => sum + p.s, 0));

  return (
    <div className="ev-input">
      <div className="ev-input__stats">
        <div><span>{t("employee.input.keys")}</span><strong>{total.toLocaleString(i18n.language)}</strong></div>
        <div><span>{t("employee.input.perMinute")}</span><strong>{perMinute === null ? "—" : perMinute.toLocaleString(i18n.language)}</strong></div>
        <div>
          <span>{t("employee.input.peak")}</span>
          <strong>{peak ? <bdi dir="ltr">{hourLabel(peak[0], i18n.language)}</bdi> : "—"}</strong>
        </div>
      </div>

      <section className="ev-card">
        <h3>{t("employee.input.byHour")}</h3>
        {total === 0 ? (
          <div className="ev-empty">{t("employee.input.empty")}</div>
        ) : (
          <div className="ev-bars" dir="ltr">
            {hours.map((h) => {
              const count = byHour.get(h) ?? 0;
              return (
                <div key={h} className="ev-bars__col" title={`${hourLabel(h, i18n.language)} · ${count.toLocaleString(i18n.language)}`}>
                  <span className="ev-bars__value">{count > 0 ? count.toLocaleString(i18n.language) : ""}</span>
                  <i style={{ height: `${Math.max(count > 0 ? 3 : 0, (count / maxHour) * 100)}%` }} />
                  <span className="ev-bars__label">{hourLabel(h, i18n.language)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="ev-card">
        <h3>{t("employee.input.presence")}</h3>
        {totals && totals.covered_s > 0 ? (
          <>
            <div className="ev-stack" dir="ltr">
              {parts.filter((p) => p.s > 0).map((p) => (
                <i key={p.key} className={`ev-stack--${p.key}`} style={{ width: `${(p.s / partsTotal) * 100}%` }} />
              ))}
            </div>
            <ul className="ev-stack__legend">
              {parts.map((p) => (
                <li key={p.key}>
                  <i className={`ev-stack--${p.key}`} />
                  <span>{t(`employee.input.${p.key}`)}</span>
                  <strong><bdi dir="ltr">{fmtDuration(p.s)}</bdi></strong>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="ev-empty">{t("employee.input.noPresence")}</div>
        )}
      </section>

      <p className="ev-privacy">{t("employee.input.privacy")}</p>
    </div>
  );
}
