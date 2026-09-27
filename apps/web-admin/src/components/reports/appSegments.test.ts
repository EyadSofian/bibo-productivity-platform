import { describe, expect, it } from "vitest";
import type { RecordingAsset } from "../../api/media";
import { appSegments, playableMoment } from "./appSegments";

const sample = (ts: number, duration_s: number, app_name: string) => ({ ts, duration_s, app_name, window_title: "" });

function recording(startS: number, endS: number, status: RecordingAsset["status"] = "ready"): RecordingAsset {
  return {
    id: `r-${startS}`,
    media_session_id: "s",
    status,
    started_at: new Date(startS * 1000).toISOString(),
    ended_at: new Date(endS * 1000).toISOString(),
    duration_ms: (endS - startS) * 1000,
    byte_size: 1,
  } as RecordingAsset;
}

describe("appSegments", () => {
  it("merges back-to-back samples of one app and keeps others apart", () => {
    const segments = appSegments([
      sample(1_000, 15, "Claude"),
      sample(1_015, 15, "Claude"),
      sample(1_030, 30, "Chrome"),
      sample(1_060, 15, "Claude"),
    ]);
    expect(segments).toEqual([
      { app: "Claude", ts: 1_000, dur: 30 },
      { app: "Chrome", ts: 1_030, dur: 30 },
      { app: "Claude", ts: 1_060, dur: 15 },
    ]);
  });

  it("filters to one app and ignores empty samples", () => {
    const segments = appSegments([sample(10, 0, "Claude"), sample(20, 5, "Claude"), sample(30, 5, "Zoom")], "Claude");
    expect(segments).toEqual([{ app: "Claude", ts: 20, dur: 5 }]);
  });

  it("starts a new segment after a long gap", () => {
    expect(appSegments([sample(0, 10, "Claude"), sample(500, 10, "Claude")])).toHaveLength(2);
  });
});

describe("playableMoment", () => {
  it("lands inside the segment where a recording covers it", () => {
    expect(playableMoment({ app: "Claude", ts: 1_000, dur: 600 }, [recording(900, 1_200)])).toBe(1_000);
  });

  it("jumps to the recording's start when the segment began earlier", () => {
    expect(playableMoment({ app: "Claude", ts: 1_000, dur: 600 }, [recording(1_300, 1_900)])).toBe(1_300);
  });

  it("reports no video when nothing playable overlaps", () => {
    expect(playableMoment({ app: "Claude", ts: 1_000, dur: 60 }, [recording(2_000, 2_300)])).toBeNull();
    expect(playableMoment({ app: "Claude", ts: 1_000, dur: 60 }, [recording(900, 1_200, "failed")])).toBeNull();
  });
});
