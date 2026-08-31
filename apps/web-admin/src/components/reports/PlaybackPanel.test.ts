import { describe, expect, it } from "vitest";
import type {
  ActivityResponse,
  BrowserVisit,
  KeystrokeBucket,
  ScreenshotMeta,
} from "../../api/types";
import { assemblePlaybackFrames, frameIndexAt, type PlaybackFrame } from "./PlaybackPanel";

function shot(ts: number, id = String(ts)): ScreenshotMeta {
  return {
    client_uuid: id,
    ts,
    byte_size: 100,
    width: 1920,
    height: 1080,
    display_id: 1,
  };
}

describe("assemblePlaybackFrames", () => {
  it("orders screenshots and attaches the activity around each frame", () => {
    const activity: ActivityResponse = {
      samples: [
        { ts: 1_000, duration_s: 120, app_name: "Chrome", window_title: "Work" },
      ],
      breakdown: [],
    };
    const visits: BrowserVisit[] = [
      {
        ts: 1_000,
        duration_s: 120,
        url: "https://example.com/work",
        domain: "example.com",
        page_title: "Work",
        browser: "chrome",
      },
    ];
    const keys: KeystrokeBucket[] = [{ ts_bucket: 1_020, count: 17 }];

    const frames = assemblePlaybackFrames(
      [shot(1_080, "second"), shot(1_030, "first")],
      activity,
      visits,
      keys,
    );

    expect(frames.map((frame) => frame.client_uuid)).toEqual(["first", "second"]);
    expect(frames[0]).toMatchObject({
      app: "Chrome",
      windowTitle: "Work",
      url: "https://example.com/work",
      domain: "example.com",
      keyCount: 17,
    });
  });

  it("marks a capture gap without inventing activity metadata", () => {
    const frames = assemblePlaybackFrames(
      [shot(1_000), shot(1_060), shot(1_120), shot(1_500)],
      { samples: [], breakdown: [] },
      [],
      [],
    );

    expect(frames[3].gapBeforeS).toBe(380);
    expect(frames[3]).toMatchObject({ app: null, url: null, keyCount: 0 });
  });
});

describe("frameIndexAt", () => {
  const frames = [100, 200, 300, 400].map((ts) => ({ ts })) as PlaybackFrame[];

  it("picks the nearest frame to the requested moment", () => {
    expect(frameIndexAt(frames, 200)).toBe(1);
    expect(frameIndexAt(frames, 240)).toBe(1);
    expect(frameIndexAt(frames, 260)).toBe(2);
  });

  // Clicking the state band at 06:00 on a day whose first screenshot is at
  // 09:00 must land on that first frame, not walk off the array.
  it("clamps to the ends of the day", () => {
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, 99999)).toBe(3);
  });

  it("survives an empty day", () => {
    expect(frameIndexAt([], 200)).toBe(0);
  });
});
