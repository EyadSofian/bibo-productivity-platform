import type { ActivitySample, BrowserVisit, KeystrokeBucket } from "../api/types";
import { domainOf } from "./rollup";

export type InputMetric = "keys" | "clicks" | "scrolls" | "mouse";

export type InputTotals = { keys: number; clicks: number; scrolls: number; mousePx: number; activeMinutes: number };

/** Sums every input bucket. A bucket from an agent that predates mouse
 *  counting has no mouse fields; it contributes its keystrokes only. */
export function inputTotals(buckets: KeystrokeBucket[]): InputTotals {
  const t = { keys: 0, clicks: 0, scrolls: 0, mousePx: 0, activeMinutes: 0 };
  const minutes = new Set<number>();
  for (const b of buckets) {
    t.keys += b.count;
    t.clicks += b.clicks ?? 0;
    t.scrolls += b.scrolls ?? 0;
    t.mousePx += b.mouse_px ?? 0;
    if (b.count > 0 || (b.clicks ?? 0) > 0 || (b.scrolls ?? 0) > 0 || (b.mouse_px ?? 0) > 0) {
      minutes.add(Math.floor(b.ts_bucket / 60));
    }
  }
  t.activeMinutes = minutes.size;
  return t;
}

function metricOf(b: KeystrokeBucket, metric: InputMetric): number {
  switch (metric) {
    case "keys":
      return b.count;
    case "clicks":
      return b.clicks ?? 0;
    case "scrolls":
      return b.scrolls ?? 0;
    case "mouse":
      return b.mouse_px ?? 0;
  }
}

/** One value per hour of the day starting at `dayStart`, summed across devices. */
export function inputByHour(buckets: KeystrokeBucket[], dayStart: number, metric: InputMetric, hours = 24): number[] {
  const out = new Array<number>(hours).fill(0);
  for (const b of buckets) {
    const h = Math.floor((b.ts_bucket - dayStart) / 3600);
    if (h >= 0 && h < hours) out[h] += metricOf(b, metric);
  }
  return out;
}

/** Whether any bucket carries mouse counts — false for agents older than the
 *  mouse counter, so the page can say "not reported" instead of "0". */
export function hasMouseData(buckets: KeystrokeBucket[]): boolean {
  return buckets.some((b) => b.clicks !== undefined || b.mouse_px !== undefined || b.scrolls !== undefined);
}

/** Window titles used inside one app, most time first. */
export function windowTitles(samples: ActivitySample[], app: string, limit = 12): Array<{ title: string; seconds: number }> {
  const byTitle = new Map<string, number>();
  for (const s of samples) {
    if (s.app_name !== app) continue;
    const title = (s.window_title || "").trim();
    byTitle.set(title, (byTitle.get(title) ?? 0) + s.duration_s);
  }
  return [...byTitle.entries()]
    .map(([title, seconds]) => ({ title, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

export type LogEntry = {
  key: string;
  kind: "app" | "site";
  ts: number;
  duration: number;
  name: string;
  detail: string;
  url: string | null;
};

/** Stretches of the same thing closer than this are one row in the log. */
const LOG_MERGE_GAP_S = 90;

/**
 * The day as a readable log: app stretches and website visits in time order.
 * The agent writes an app sample at most every minute and the extension
 * checkpoints a page every minute, so an hour in one window arrives as ~60
 * rows; consecutive rows of the same window or page are merged into one.
 */
export function activityLog(samples: ActivitySample[], visits: BrowserVisit[]): LogEntry[] {
  const raw: LogEntry[] = [
    ...samples
      .filter((s) => s.duration_s > 0)
      .map((s) => ({
        key: `a${s.ts}${s.app_name}`,
        kind: "app" as const,
        ts: s.ts,
        duration: s.duration_s,
        name: s.app_name,
        detail: s.window_title || "",
        url: null,
      })),
    ...visits
      .filter((v) => v.duration_s > 0 && domainOf(v))
      .map((v) => ({
        key: `s${v.ts}${v.url}`,
        kind: "site" as const,
        ts: v.ts,
        duration: v.duration_s,
        name: domainOf(v)!,
        detail: v.page_title || "",
        url: v.url,
      })),
  ].sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? 0 : a.kind === "app" ? -1 : 1));

  // Apps and sites run side by side (Chrome in front while a page is open), so
  // each kind merges only with its own previous row. Switching to another app
  // and back is two rows, not one stretched across the interruption.
  const merged: LogEntry[] = [];
  const last: Partial<Record<LogEntry["kind"], LogEntry>> = {};
  for (const e of raw) {
    const prev = last[e.kind];
    const same = prev && prev.name === e.name && (e.kind === "site" ? prev.url === e.url : prev.detail === e.detail);
    if (prev && same && e.ts - (prev.ts + prev.duration) <= LOG_MERGE_GAP_S) {
      prev.duration = Math.max(prev.duration, e.ts + e.duration - prev.ts);
      continue;
    }
    const entry = { ...e };
    merged.push(entry);
    last[e.kind] = entry;
  }
  return merged;
}
