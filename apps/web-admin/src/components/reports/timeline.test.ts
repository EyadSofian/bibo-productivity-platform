import { describe, expect, it } from "vitest";
import type { OsStateReport } from "../../api/types";
import {
  buildActivityBlocks,
  buildAxisTicks,
  buildInputBars,
  buildScreenshotMarkers,
  buildStateBand,
  buildTimeline,
  buildVisitBlocks,
  maxTicksFor,
  positionIn,
  TICK_LABEL_PX,
} from "./timeline";

// 2026-08-31 00:00:00 UTC and a full day after it.
const DAY_START = 1788134400;
const DAY_END = DAY_START + 86400;
const H = 3600;

function report(intervals: OsStateReport["intervals"]): OsStateReport {
  return {
    totals: {
      active_s: 0, idle_s: 0, suspended_s: 0, offline_s: 0, covered_s: 0, elapsed_s: 0,
    },
    first_activity: null,
    last_activity: null,
    intervals,
  };
}

describe("positionIn", () => {
  it("maps a timestamp to its fraction of the window", () => {
    expect(positionIn(0, 100, 25)).toBe(0.25);
    expect(positionIn(0, 100, 0)).toBe(0);
    expect(positionIn(0, 100, 100)).toBe(1);
  });

  it("clamps outside the window and survives a zero span", () => {
    expect(positionIn(0, 100, -50)).toBe(0);
    expect(positionIn(0, 100, 500)).toBe(1);
    expect(positionIn(50, 50, 50)).toBe(0);
  });
});

describe("buildStateBand", () => {
  // The invariant the whole timeline rests on: every instant of the elapsed
  // window belongs to exactly one block, with no gaps and no overlaps.
  it("covers the window exactly, with no gaps or overlaps", () => {
    const band = buildStateBand(
      report([
        { state: "active", ts: DAY_START + 9 * H, duration_s: 2 * H },
        { state: "idle", ts: DAY_START + 11 * H, duration_s: H },
      ]),
      DAY_START,
      DAY_END,
      DAY_END,
    );

    expect(band[0].start).toBe(DAY_START);
    expect(band[band.length - 1].end).toBe(DAY_END);
    for (let i = 1; i < band.length; i++) {
      expect(band[i].start).toBe(band[i - 1].end);
    }
    const covered = band.reduce((sum, b) => sum + (b.end - b.start), 0);
    expect(covered).toBe(DAY_END - DAY_START);
  });

  it("fills unreported stretches with offline", () => {
    const band = buildStateBand(
      report([{ state: "active", ts: DAY_START + 9 * H, duration_s: H }]),
      DAY_START,
      DAY_END,
      DAY_END,
    );
    expect(band.map((b) => b.state)).toEqual(["offline", "active", "offline"]);
    expect(band[1].start).toBe(DAY_START + 9 * H);
    expect(band[1].end).toBe(DAY_START + 10 * H);
  });

  // A day in progress must not be painted offline for hours that have not
  // happened yet.
  it("stops at now for a window that has not finished", () => {
    const now = DAY_START + 10 * H;
    const band = buildStateBand(
      report([{ state: "active", ts: DAY_START + 9 * H, duration_s: H }]),
      DAY_START,
      DAY_END,
      now,
    );
    expect(band[band.length - 1].end).toBe(now);
    expect(band.some((b) => b.start >= now)).toBe(false);
  });

  it("clips intervals that straddle the window edges", () => {
    const band = buildStateBand(
      report([
        { state: "suspended", ts: DAY_START - 4 * H, duration_s: 6 * H },
        { state: "active", ts: DAY_END - H, duration_s: 5 * H },
      ]),
      DAY_START,
      DAY_END,
      DAY_END,
    );
    expect(band[0]).toEqual({ state: "suspended", start: DAY_START, end: DAY_START + 2 * H });
    expect(band[band.length - 1]).toEqual({
      state: "active", start: DAY_END - H, end: DAY_END,
    });
  });

  it("merges abutting blocks of the same state", () => {
    const band = buildStateBand(
      report([
        { state: "active", ts: DAY_START, duration_s: H },
        { state: "active", ts: DAY_START + H, duration_s: H },
        { state: "active", ts: DAY_START + 2 * H, duration_s: H },
      ]),
      DAY_START,
      DAY_START + 3 * H,
      DAY_START + 3 * H,
    );
    expect(band).toEqual([{ state: "active", start: DAY_START, end: DAY_START + 3 * H }]);
  });

  // Two devices, or a resent batch, must not paint the same instant twice.
  it("does not double-draw overlapping reports", () => {
    const band = buildStateBand(
      report([
        { state: "active", ts: DAY_START, duration_s: 2 * H },
        { state: "idle", ts: DAY_START + H, duration_s: 2 * H },
      ]),
      DAY_START,
      DAY_START + 3 * H,
      DAY_START + 3 * H,
    );
    for (let i = 1; i < band.length; i++) {
      expect(band[i].start).toBeGreaterThanOrEqual(band[i - 1].end);
    }
    const covered = band.reduce((sum, b) => sum + (b.end - b.start), 0);
    expect(covered).toBe(3 * H);
  });

  it("treats no report at all as fully offline", () => {
    const band = buildStateBand(null, DAY_START, DAY_START + H, DAY_START + H);
    expect(band).toEqual([{ state: "offline", start: DAY_START, end: DAY_START + H }]);
  });

  it("returns nothing for a window entirely in the future", () => {
    expect(buildStateBand(null, DAY_END, DAY_END + H, DAY_START)).toEqual([]);
  });
});

describe("buildActivityBlocks", () => {
  it("clips to the window and orders by time", () => {
    const blocks = buildActivityBlocks(
      [
        { ts: DAY_START + 2 * H, app_name: "Chrome", window_title: "b", duration_s: H },
        { ts: DAY_START - H, app_name: "Code", window_title: "a", duration_s: 2 * H },
      ],
      DAY_START,
      DAY_END,
    );
    expect(blocks.map((b) => b.app)).toEqual(["Code", "Chrome"]);
    expect(blocks[0].start).toBe(DAY_START);
    expect(blocks[0].end).toBe(DAY_START + H);
  });

  it("drops samples with no width inside the window", () => {
    const blocks = buildActivityBlocks(
      [{ ts: DAY_END, app_name: "Late", window_title: "", duration_s: H }],
      DAY_START,
      DAY_END,
    );
    expect(blocks).toEqual([]);
  });
});

describe("buildInputBars", () => {
  // Intensity is relative to the window's own peak: there is no defensible
  // absolute "normal" keypress rate to compare against.
  it("scales against the busiest bucket in the window", () => {
    const bars = buildInputBars(
      [
        { ts_bucket: DAY_START, count: 20 },
        { ts_bucket: DAY_START + 60, count: 80 },
      ],
      DAY_START,
      DAY_END,
    );
    expect(bars.map((b) => b.intensity)).toEqual([0.25, 1]);
  });

  it("ignores empty buckets and anything outside the window", () => {
    const bars = buildInputBars(
      [
        { ts_bucket: DAY_START, count: 0 },
        { ts_bucket: DAY_START - 60, count: 99 },
        { ts_bucket: DAY_END, count: 99 },
        { ts_bucket: DAY_START + 120, count: 5 },
      ],
      DAY_START,
      DAY_END,
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].start).toBe(DAY_START + 120);
  });

  it("returns nothing when there was no input", () => {
    expect(buildInputBars([], DAY_START, DAY_END)).toEqual([]);
  });
});

describe("buildVisitBlocks", () => {
  const visit = (over: Partial<Parameters<typeof buildVisitBlocks>[0][number]>) => ({
    ts: DAY_START, url: "https://example.test/a", domain: "example.test",
    page_title: "A", browser: "chrome", duration_s: 60, ...over,
  });

  it("excludes the extension's own on/off marker rows", () => {
    const blocks = buildVisitBlocks(
      [
        visit({ url: "user_turn_off_in_browser", domain: null }),
        visit({ ts: DAY_START + 60 }),
      ],
      DAY_START,
      DAY_END,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].domain).toBe("example.test");
  });

  it("gives a zero-length visit a visible minimum width", () => {
    const blocks = buildVisitBlocks([visit({ duration_s: 0 })], DAY_START, DAY_END);
    expect(blocks[0].end).toBe(blocks[0].start + 1);
  });
});

describe("buildScreenshotMarkers", () => {
  it("keeps only shots inside the window, in order", () => {
    const shot = (ts: number, uuid: string) => ({
      client_uuid: uuid, ts, byte_size: 1, width: 1, height: 1, display_id: 0,
    });
    const markers = buildScreenshotMarkers(
      [shot(DAY_START + 100, "b"), shot(DAY_START - 1, "before"), shot(DAY_START + 10, "a")],
      DAY_START,
      DAY_END,
    );
    expect(markers.map((m) => m.clientUuid)).toEqual(["a", "b"]);
  });
});

describe("buildTimeline", () => {
  const base = {
    from: DAY_START, to: DAY_END, now: DAY_END,
    states: null, samples: [], buckets: [], visits: [], shots: [],
  };

  // An all-offline band is the absence of data, not data. The UI must be able
  // to tell them apart so it can say "nothing reported" instead of drawing a
  // confident grey bar.
  it("reports empty when every lane is empty", () => {
    const model = buildTimeline(base);
    expect(model.empty).toBe(true);
    expect(model.states.every((b) => b.state === "offline")).toBe(true);
  });

  it("is not empty once any lane has something", () => {
    expect(
      buildTimeline({
        ...base,
        states: report([{ state: "active", ts: DAY_START, duration_s: H }]),
      }).empty,
    ).toBe(false);

    expect(
      buildTimeline({ ...base, buckets: [{ ts_bucket: DAY_START, count: 3 }] }).empty,
    ).toBe(false);
  });
});

describe("buildAxisTicks", () => {
  // Every tick lands on a whole hour, so ":00" on each label is dead width.
  it("labels hours without redundant minutes", () => {
    const ticks = buildAxisTicks(DAY_START, DAY_END, "en-US");
    expect(ticks.every((tick) => !tick.label.includes(":"))).toBe(true);
  });

  it("labels a single day by time and stays inside the window", () => {
    const ticks = buildAxisTicks(DAY_START, DAY_END, "en-US");
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(12);
    for (const tick of ticks) {
      expect(tick.ts).toBeGreaterThanOrEqual(DAY_START);
      expect(tick.ts).toBeLessThan(DAY_END);
    }
  });

  it("keeps the label count readable as the span grows", () => {
    for (const days of [1, 3, 7, 30, 90]) {
      const ticks = buildAxisTicks(DAY_START, DAY_START + days * 86400, "en-US");
      expect(ticks.length).toBeLessThanOrEqual(12);
      expect(ticks.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing for an inverted or empty window", () => {
    expect(buildAxisTicks(DAY_END, DAY_START, "en-US")).toEqual([]);
    expect(buildAxisTicks(DAY_START, DAY_START, "en-US")).toEqual([]);
  });

  it("orders ticks ascending", () => {
    const ticks = buildAxisTicks(DAY_START, DAY_START + 3 * 86400, "en-US");
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].ts).toBeGreaterThan(ticks[i - 1].ts);
    }
  });
});

describe("maxTicksFor", () => {
  // A phone column cannot carry twelve hourly labels; they overprint into an
  // unreadable smear. Density has to follow the available width, not just the
  // time span.
  it("thins the axis as the column narrows", () => {
    expect(maxTicksFor(1000)).toBe(12);
    expect(maxTicksFor(400)).toBe(7);
    expect(maxTicksFor(200)).toBe(3);
  });

  it("never asks for fewer than two or more than twelve", () => {
    expect(maxTicksFor(10)).toBe(2);
    expect(maxTicksFor(100000)).toBe(12);
  });

  it("falls back to the full count before the width is measured", () => {
    expect(maxTicksFor(0)).toBe(12);
    expect(maxTicksFor(Number.NaN)).toBe(12);
  });

  it("keeps a day's axis within the width budget", () => {
    for (const width of [320, 420, 640, 1280]) {
      const ticks = buildAxisTicks(DAY_START, DAY_END, "en-US", maxTicksFor(width));
      // Each label needs roughly TICK_LABEL_PX; none may be crowded out.
      expect(ticks.length * TICK_LABEL_PX).toBeLessThanOrEqual(width + TICK_LABEL_PX);
    }
  });
});
