import type { ActivityResponse, BrowserVisit } from "../../api/types";
import type { RecordingAsset } from "../../api/media";
import { appSegments, type AppSegment } from "../reports/appSegments";

/** Stretches closer than this are one visit, not two. */
const MERGE_GAP_S = 60;

export type Span = { start: number; end: number };

/** Start and end of a recording, in unix seconds. */
export function recordingSpan(r: RecordingAsset): Span {
  const start = Date.parse(r.started_at) / 1000;
  const end = r.ended_at ? Date.parse(r.ended_at) / 1000 : start + r.duration_ms / 1000;
  return { start, end: Math.max(start, end) };
}

/** Only finished recordings can be played; the rest are shown with a status. */
export const isPlayable = (r: RecordingAsset) => r.status === "ready";

/** Recordings of the day, oldest first. */
export function sortRecordings(recordings: RecordingAsset[]): RecordingAsset[] {
  return [...recordings].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

/**
 * Where to play for a requested moment: the playable recording that covers it,
 * or else the nearest playable one, and the exact second to start at. `exact`
 * is false when the moment itself was not recorded, so the UI can say so
 * instead of silently showing some other part of the day.
 */
export function resolveMoment(
  recordings: RecordingAsset[],
  ts: number,
): { recording: RecordingAsset; at: number; exact: boolean } | null {
  const playable = sortRecordings(recordings).filter(isPlayable);
  if (playable.length === 0) return null;
  for (const r of playable) {
    const { start, end } = recordingSpan(r);
    if (ts >= start && ts <= end) return { recording: r, at: ts, exact: true };
  }
  let best = playable[0];
  let bestDistance = Infinity;
  for (const r of playable) {
    const { start, end } = recordingSpan(r);
    const distance = ts < start ? start - ts : ts - end;
    if (distance < bestDistance) {
      best = r;
      bestDistance = distance;
    }
  }
  const span = recordingSpan(best);
  // After the recording ended: show its last minute, not a useless final frame.
  return { recording: best, at: ts < span.start ? span.start : Math.max(span.start, span.end - 60), exact: false };
}

/** The next playable recording after `current`, for continuous day playback. */
export function nextPlayable(recordings: RecordingAsset[], current: RecordingAsset): RecordingAsset | null {
  const playable = sortRecordings(recordings).filter(isPlayable);
  const index = playable.findIndex((r) => r.id === current.id);
  return index >= 0 ? playable[index + 1] ?? null : null;
}

/** Whether any playable recording overlaps a stretch, and where it starts. */
export function firstRecordedMoment(segment: AppSegment, recordings: RecordingAsset[]): number | null {
  const segEnd = segment.ts + segment.dur;
  let best: number | null = null;
  for (const r of recordings) {
    if (!isPlayable(r)) continue;
    const { start, end } = recordingSpan(r);
    if (end < segment.ts || start > segEnd) continue;
    const moment = Math.max(segment.ts, start);
    if (best === null || moment < best) best = moment;
  }
  return best;
}

export const domainOfVisit = (visit: BrowserVisit): string | null => {
  if (visit.domain) return visit.domain;
  try {
    return new URL(visit.url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
};

/** One thing the employee worked in: an app or a website, with its stretches. */
export type WorkItem = {
  key: string;
  kind: "app" | "site";
  name: string;
  totalS: number;
  segments: AppSegment[];
  /** Pages of a website, most-used first. Empty for apps. */
  pages: Array<{ url: string; title: string; totalS: number }>;
};

function siteSegments(visits: BrowserVisit[]): AppSegment[] {
  const segments: AppSegment[] = [];
  for (const v of [...visits].filter((v) => v.duration_s > 0).sort((a, b) => a.ts - b.ts)) {
    const prev = segments[segments.length - 1];
    if (prev && v.ts - (prev.ts + prev.dur) < MERGE_GAP_S) {
      prev.dur = Math.max(prev.dur, v.ts + v.duration_s - prev.ts);
    } else {
      segments.push({ app: "", ts: v.ts, dur: v.duration_s });
    }
  }
  return segments;
}

/**
 * Everything the employee worked in during the day -- apps from the activity
 * report and websites from browser visits -- as one list, most time first.
 */
export function workItems(activity: ActivityResponse, visits: BrowserVisit[]): WorkItem[] {
  const apps: WorkItem[] = activity.breakdown
    .filter((b) => b.duration_s > 0)
    .map((b) => ({
      key: `app:${b.app_name}`,
      kind: "app",
      name: b.app_name,
      totalS: b.duration_s,
      segments: appSegments(activity.samples, b.app_name),
      pages: [],
    }));

  const byDomain = new Map<string, BrowserVisit[]>();
  for (const v of visits) {
    const domain = domainOfVisit(v);
    if (!domain || v.duration_s <= 0) continue;
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), v]);
  }
  const sites: WorkItem[] = [...byDomain.entries()].map(([domain, list]) => {
    const pages = new Map<string, { url: string; title: string; totalS: number }>();
    for (const v of list) {
      const page = pages.get(v.url) ?? { url: v.url, title: v.page_title || "", totalS: 0 };
      page.totalS += v.duration_s;
      if (!page.title && v.page_title) page.title = v.page_title;
      pages.set(v.url, page);
    }
    return {
      key: `site:${domain}`,
      kind: "site",
      name: domain,
      totalS: list.reduce((sum, v) => sum + v.duration_s, 0),
      segments: siteSegments(list).map((s) => ({ ...s, app: domain })),
      pages: [...pages.values()].sort((a, b) => b.totalS - a.totalS),
    };
  });

  return [...apps, ...sites].sort((a, b) => b.totalS - a.totalS || a.name.localeCompare(b.name));
}

/** A link is opened only when it is a real web address, never javascript: or file:. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The part of the day worth drawing: from the first to the last thing that
 * happened (activity or recording), padded to whole hours. A 24-hour ribbon
 * with eight hours of work squeezed into a third of it is unreadable.
 */
export function workingWindow(day: Span, marks: number[]): Span {
  const inDay = marks.filter((m) => m >= day.start && m <= day.end);
  if (inDay.length === 0) {
    return { start: day.start + 8 * 3600, end: Math.min(day.end, day.start + 18 * 3600) };
  }
  const hour = 3600;
  const start = Math.max(day.start, Math.floor(Math.min(...inDay) / hour) * hour - hour);
  const end = Math.min(day.end, Math.ceil(Math.max(...inDay) / hour) * hour + hour);
  return { start, end: Math.max(end, start + 2 * hour) };
}
