// Building the unified timeline.
//
// The page loads four independent reports for the same window: device states,
// foreground activity, keystroke counts and screenshots. Each answers a
// different question and none of them alone says what a day looked like. This
// module folds them into one set of lanes laid out on a shared axis.
//
// Pure, so the arithmetic that decides where a block sits — and in particular
// how offline gaps are derived — can be tested without rendering anything.

import type {
  ActivitySample,
  BrowserVisit,
  KeystrokeBucket,
  OsStateReport,
  ScreenshotMeta,
} from "../../api/types";

/** Device states, plus the offline state the backend derives from gaps. */
export type TimelineState = "active" | "idle" | "suspended" | "offline";

export interface StateBlock {
  state: TimelineState;
  /** Unix seconds. */
  start: number;
  end: number;
}

export interface ActivityBlock {
  app: string;
  windowTitle: string;
  start: number;
  end: number;
}

export interface InputBar {
  start: number;
  count: number;
  /** 0..1, relative to the busiest bucket in the window. */
  intensity: number;
}

export interface ScreenshotMarker {
  clientUuid: string;
  ts: number;
}

export interface VisitBlock {
  domain: string;
  title: string;
  start: number;
  end: number;
}

export interface TimelineModel {
  from: number;
  to: number;
  states: StateBlock[];
  activity: ActivityBlock[];
  input: InputBar[];
  screenshots: ScreenshotMarker[];
  visits: VisitBlock[];
  /** True when no lane has anything to draw. */
  empty: boolean;
}

/** Fraction of the window [from, to) at which `ts` falls, clamped to 0..1. */
export function positionIn(from: number, to: number, ts: number): number {
  const span = to - from;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (ts - from) / span));
}

/**
 * Merges touching blocks of the same state.
 *
 * The agent closes and reopens a state segment on every transition it observes,
 * including ones that do not change the state (a device waking into the same
 * idle state it slept from). Without this, a quiet day renders as hundreds of
 * abutting slivers with hairline seams between them.
 */
function coalesce(blocks: StateBlock[]): StateBlock[] {
  const merged: StateBlock[] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.state === block.state && block.start <= last.end) {
      last.end = Math.max(last.end, block.end);
      continue;
    }
    merged.push({ ...block });
  }
  return merged;
}

/**
 * Turns reported state intervals into a gap-free band across [from, to).
 *
 * Anything the agent did not account for becomes `offline`, which is the only
 * honest reading: a disconnected agent cannot report its own disconnection, so
 * absence of data is the evidence. `now` bounds the band so a range ending
 * tonight does not paint the rest of the day as offline.
 */
export function buildStateBand(
  report: OsStateReport | null,
  from: number,
  to: number,
  now: number,
): StateBlock[] {
  const end = Math.min(to, now);
  if (end <= from) return [];

  const reported = (report?.intervals ?? [])
    .map((interval) => ({
      state: interval.state as TimelineState,
      start: Math.max(from, interval.ts),
      end: Math.min(end, interval.ts + interval.duration_s),
    }))
    .filter((block) => block.end > block.start)
    .sort((a, b) => a.start - b.start);

  const band: StateBlock[] = [];
  let cursor = from;
  for (const block of coalesce(reported)) {
    // Overlapping reports (two devices, or a resend) must not double-draw:
    // keep the first claim on any instant.
    if (block.end <= cursor) continue;
    const start = Math.max(block.start, cursor);
    if (start > cursor) {
      band.push({ state: "offline", start: cursor, end: start });
    }
    band.push({ ...block, start });
    cursor = block.end;
  }
  if (cursor < end) {
    band.push({ state: "offline", start: cursor, end });
  }
  return coalesce(band);
}

/** Clips foreground activity to the window and drops zero-width samples. */
export function buildActivityBlocks(
  samples: ActivitySample[],
  from: number,
  to: number,
): ActivityBlock[] {
  return samples
    .map((sample) => ({
      app: sample.app_name,
      windowTitle: sample.window_title,
      start: Math.max(from, sample.ts),
      end: Math.min(to, sample.ts + sample.duration_s),
    }))
    .filter((block) => block.end > block.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * Scales keystroke counts against the window's own busiest minute.
 *
 * Deliberately relative, not absolute: there is no meaningful "normal" number
 * of keypresses per minute, and inventing one would turn a shape into a
 * judgement. The lane shows when input happened, never how hard someone worked.
 */
export function buildInputBars(buckets: KeystrokeBucket[], from: number, to: number): InputBar[] {
  const inWindow = buckets.filter(
    (bucket) => bucket.ts_bucket >= from && bucket.ts_bucket < to && bucket.count > 0,
  );
  if (inWindow.length === 0) return [];
  const peak = inWindow.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  return inWindow
    .map((bucket) => ({
      start: bucket.ts_bucket,
      count: bucket.count,
      intensity: peak > 0 ? bucket.count / peak : 0,
    }))
    .sort((a, b) => a.start - b.start);
}

/** Reserved URLs the extension posts for its own on/off toggle, not sites. */
const VISIT_MARKERS = new Set(["user_turn_off_in_browser", "user_turn_on_in_browser"]);

export function buildVisitBlocks(
  visits: BrowserVisit[],
  from: number,
  to: number,
): VisitBlock[] {
  return visits
    .filter((visit) => !VISIT_MARKERS.has(visit.url))
    .map((visit) => ({
      domain: visit.domain || visit.url,
      title: visit.page_title,
      start: Math.max(from, visit.ts),
      end: Math.min(to, visit.ts + Math.max(1, visit.duration_s)),
    }))
    .filter((block) => block.end > block.start && block.domain)
    .sort((a, b) => a.start - b.start);
}

export function buildScreenshotMarkers(
  shots: ScreenshotMeta[],
  from: number,
  to: number,
): ScreenshotMarker[] {
  return shots
    .filter((shot) => shot.ts >= from && shot.ts < to)
    .map((shot) => ({ clientUuid: shot.client_uuid, ts: shot.ts }))
    .sort((a, b) => a.ts - b.ts);
}

export function buildTimeline(input: {
  from: number;
  to: number;
  now: number;
  states: OsStateReport | null;
  samples: ActivitySample[];
  buckets: KeystrokeBucket[];
  visits: BrowserVisit[];
  shots: ScreenshotMeta[];
}): TimelineModel {
  const { from, to, now } = input;
  const states = buildStateBand(input.states, from, to, now);
  const activity = buildActivityBlocks(input.samples, from, to);
  const inputBars = buildInputBars(input.buckets, from, to);
  const visits = buildVisitBlocks(input.visits, from, to);
  const screenshots = buildScreenshotMarkers(input.shots, from, to);

  // A band that is nothing but offline is not data — it is the absence of it,
  // and the UI says so rather than drawing a confident grey bar.
  const hasState = states.some((block) => block.state !== "offline");

  return {
    from,
    to,
    states,
    activity,
    input: inputBars,
    screenshots,
    visits,
    empty:
      !hasState &&
      activity.length === 0 &&
      inputBars.length === 0 &&
      visits.length === 0 &&
      screenshots.length === 0,
  };
}

export interface AxisTick {
  ts: number;
  label: string;
  /** Whether this tick starts a new day, which gets a stronger rule. */
  major: boolean;
}

/** Roughly the width one axis label needs before neighbours start colliding. */
export const TICK_LABEL_PX = 56;

/**
 * How many labels fit in `width` pixels. A narrow column gets fewer, which is
 * what stops a day's twelve hourly labels from overprinting each other on a
 * phone.
 */
export function maxTicksFor(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 12;
  return Math.max(2, Math.min(12, Math.floor(width / TICK_LABEL_PX)));
}

/**
 * Tick marks for the window.
 *
 * The step adapts to the span *and* to how much room there is, so a one-day
 * view is labelled by hour on a desktop, every few hours on a phone, and a
 * multi-week range by day — instead of any of them being unreadably dense.
 */
export function buildAxisTicks(
  from: number,
  to: number,
  locale: string,
  maxTicks = 12,
): AxisTick[] {
  const span = to - from;
  if (span <= 0) return [];

  const HOUR = 3600;
  const DAY = 86400;
  const limit = Math.max(2, maxTicks);
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
  const step = steps.find((candidate) => span / candidate <= limit) ?? steps[steps.length - 1];
  const byDay = step >= DAY;

  const ticks: AxisTick[] = [];
  // Start at the first step boundary at or after `from`, in local time: an axis
  // labelled 00:00, 03:00, ... is readable in a way that from+n*step is not.
  const first = new Date(from * 1000);
  first.setSeconds(0, 0);
  first.setMinutes(0);
  if (byDay) first.setHours(0);
  else first.setHours(Math.ceil(first.getHours() / (step / HOUR)) * (step / HOUR));

  for (let ts = Math.floor(first.getTime() / 1000); ts < to; ts += step) {
    if (ts < from) continue;
    const at = new Date(ts * 1000);
    const startsDay = at.getHours() === 0 && at.getMinutes() === 0;
    ticks.push({
      ts,
      // Ticks are always placed on a whole hour, so the minutes would read
      // ":00" on every label — noise that costs a third of the label width and
      // crowds the axis on narrow screens.
      label: byDay
        ? at.toLocaleDateString(locale, { month: "short", day: "numeric" })
        : at.toLocaleTimeString(locale, { hour: "numeric" }),
      major: byDay || startsDay,
    });
  }
  return ticks;
}
