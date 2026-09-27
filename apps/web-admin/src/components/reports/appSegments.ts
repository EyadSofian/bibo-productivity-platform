import type { ActivityResponse } from "../../api/types";
import type { RecordingAsset } from "../../api/media";

/** A continuous stretch of one app in the foreground. */
export type AppSegment = { app: string; ts: number; dur: number };

/** Samples closer than this are treated as one stretch of the same app. */
const MERGE_GAP_S = 60;

/**
 * Foreground stretches per app, oldest first. Back-to-back samples of the same
 * app merge into one segment so "Claude, 10:05–10:42" reads as one thing to
 * watch rather than dozens of 15-second slivers.
 */
export function appSegments(samples: ActivityResponse["samples"], app?: string): AppSegment[] {
  const ordered = samples.filter((s) => s.duration_s > 0).sort((a, b) => a.ts - b.ts);
  const segments: AppSegment[] = [];
  for (const s of ordered) {
    const prev = segments[segments.length - 1];
    if (prev && prev.app === s.app_name && s.ts - (prev.ts + prev.dur) < MERGE_GAP_S) {
      prev.dur = Math.max(prev.dur, s.ts + s.duration_s - prev.ts);
    } else {
      segments.push({ app: s.app_name, ts: s.ts, dur: s.duration_s });
    }
  }
  return app === undefined ? segments : segments.filter((s) => s.app === app);
}

const recordingBounds = (r: RecordingAsset) => {
  const start = Date.parse(r.started_at) / 1000;
  const end = r.ended_at ? Date.parse(r.ended_at) / 1000 : start + r.duration_ms / 1000;
  return { start, end };
};

/**
 * The first moment inside `segment` that a playable recording covers, or null.
 * A segment that starts before a recording began still has video from the
 * recording's start, so the jump lands on real footage instead of a gap.
 */
export function playableMoment(segment: AppSegment, recordings: RecordingAsset[]): number | null {
  const segEnd = segment.ts + segment.dur;
  let best: number | null = null;
  for (const r of recordings) {
    if (r.status === "failed") continue;
    const { start, end } = recordingBounds(r);
    if (end < segment.ts || start > segEnd) continue;
    const moment = Math.max(segment.ts, start);
    if (best === null || moment < best) best = moment;
  }
  return best;
}
