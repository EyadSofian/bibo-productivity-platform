import { describe, expect, it } from "vitest";
import type { RecordingAsset } from "../../api/media";
import type { ActivityResponse, BrowserVisit } from "../../api/types";
import {
  firstRecordedMoment,
  nextPlayable,
  resolveMoment,
  safeHref,
  workItems,
  workingWindow,
} from "./dayModel";

function rec(id: string, start: number, end: number, status: RecordingAsset["status"] = "ready"): RecordingAsset {
  return {
    id,
    business_id: "b",
    media_session_id: "s",
    employee_id: "e",
    device_id: "d",
    status,
    format: "mp4",
    duration_ms: (end - start) * 1000,
    byte_size: 1,
    started_at: new Date(start * 1000).toISOString(),
    ended_at: new Date(end * 1000).toISOString(),
  };
}

function visit(ts: number, duration_s: number, url: string, page_title = ""): BrowserVisit {
  return { ts, duration_s, url, domain: null, page_title, browser: "chrome" };
}

describe("resolveMoment", () => {
  const recordings = [rec("b", 2_000, 2_300), rec("a", 1_000, 1_300), rec("x", 1_500, 1_800, "failed")];

  it("plays the recording that covers the moment", () => {
    expect(resolveMoment(recordings, 1_100)).toMatchObject({ recording: { id: "a" }, at: 1_100, exact: true });
  });

  it("falls back to the nearest playable recording and says so", () => {
    // 1600 sits inside the failed clip; the ready clip starting at 2000 is nearer than the one ending at 1300.
    expect(resolveMoment(recordings, 1_700)).toMatchObject({ recording: { id: "b" }, at: 2_000, exact: false });
    expect(resolveMoment(recordings, 1_400)).toMatchObject({ recording: { id: "a" }, at: 1_240, exact: false });
  });

  it("returns nothing when no recording can be played", () => {
    expect(resolveMoment([rec("p", 0, 10, "processing")], 5)).toBeNull();
  });
});

describe("nextPlayable", () => {
  it("skips unplayable clips in order", () => {
    const list = [rec("c", 3_000, 3_100), rec("a", 1_000, 1_100), rec("f", 2_000, 2_100, "failed")];
    expect(nextPlayable(list, list[1])?.id).toBe("c");
    expect(nextPlayable(list, list[0])).toBeNull();
  });
});

describe("firstRecordedMoment", () => {
  it("finds the first recorded second inside a stretch", () => {
    expect(firstRecordedMoment({ app: "Claude", ts: 1_000, dur: 600 }, [rec("a", 1_200, 1_900)])).toBe(1_200);
    expect(firstRecordedMoment({ app: "Claude", ts: 1_000, dur: 60 }, [rec("a", 5_000, 5_100)])).toBeNull();
  });
});

describe("workItems", () => {
  it("lists apps and websites together, most time first, with pages per site", () => {
    const activity: ActivityResponse = {
      samples: [
        { ts: 1_000, duration_s: 300, app_name: "Claude", window_title: "" },
        { ts: 1_300, duration_s: 100, app_name: "Chrome", window_title: "" },
      ],
      breakdown: [
        { app_name: "Claude", duration_s: 300 },
        { app_name: "Chrome", duration_s: 100 },
      ],
    } as ActivityResponse;
    const visits = [
      visit(1_300, 200, "https://www.github.com/a", "Repo A"),
      visit(1_520, 250, "https://github.com/b"),
      visit(9_000, 50, "https://mail.example.com/"),
    ];
    const items = workItems(activity, visits);
    expect(items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "site:github.com",
      "app:Claude",
      "app:Chrome",
      "site:mail.example.com",
    ]);
    const github = items[0];
    expect(github.totalS).toBe(450);
    // Two visits 20s apart are one stretch.
    expect(github.segments).toEqual([{ app: "github.com", ts: 1_300, dur: 470 }]);
    expect(github.pages[0]).toMatchObject({ url: "https://github.com/b", totalS: 250 });
  });
});

describe("duplicate visits", () => {
  it("counts a visit delivered twice only once and merges www", () => {
    const activity = { samples: [], breakdown: [] } as unknown as ActivityResponse;
    const items = workItems(activity, [
      visit(100, 30, "https://www.youtube.com/"),
      visit(100, 30, "https://www.youtube.com/"),
      visit(100, 30, "https://www.youtube.com/"),
      visit(200, 20, "https://youtube.com/watch?v=1"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "youtube.com", totalS: 50 });
  });
});

describe("safeHref", () => {
  it("opens only web addresses", () => {
    expect(safeHref("https://github.com/x")).toBe("https://github.com/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});

describe("workingWindow", () => {
  const day = { start: 0, end: 86_400 };
  it("frames the worked hours with an hour of margin", () => {
    expect(workingWindow(day, [9 * 3600 + 600, 16 * 3600 + 100])).toEqual({ start: 8 * 3600, end: 18 * 3600 });
  });
  it("shows a normal office day when nothing happened", () => {
    expect(workingWindow(day, [])).toEqual({ start: 8 * 3600, end: 18 * 3600 });
  });
});
