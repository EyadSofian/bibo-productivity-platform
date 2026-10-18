import { describe, expect, it } from "vitest";
import type { ActivitySample, BrowserVisit, KeystrokeBucket } from "../api/types";
import { activityLog, hasMouseData, inputByHour, inputTotals, windowTitles } from "./employeeDay";

const DAY = 1_700_000_000;

describe("inputTotals", () => {
  it("sums keys and mouse counts and counts distinct active minutes", () => {
    const buckets: KeystrokeBucket[] = [
      { ts_bucket: DAY, count: 10, clicks: 2, scrolls: 1, mouse_px: 500 },
      // A second device reporting the same minute is still one active minute.
      { ts_bucket: DAY, count: 5, clicks: 0, scrolls: 0, mouse_px: 0 },
      { ts_bucket: DAY + 60, count: 0, clicks: 3, scrolls: 0, mouse_px: 100 },
      { ts_bucket: DAY + 120, count: 0, clicks: 0, scrolls: 0, mouse_px: 0 },
    ];
    expect(inputTotals(buckets)).toEqual({ keys: 15, clicks: 5, scrolls: 1, mousePx: 600, activeMinutes: 2 });
  });

  it("treats buckets from older agents as keystrokes only", () => {
    expect(inputTotals([{ ts_bucket: DAY, count: 7 }])).toMatchObject({ keys: 7, clicks: 0, mousePx: 0 });
    expect(hasMouseData([{ ts_bucket: DAY, count: 7 }])).toBe(false);
    expect(hasMouseData([{ ts_bucket: DAY, count: 7, clicks: 0 }])).toBe(true);
  });
});

describe("inputByHour", () => {
  it("files each bucket under its hour and ignores other days", () => {
    const buckets: KeystrokeBucket[] = [
      { ts_bucket: DAY + 60, count: 4, clicks: 1 },
      { ts_bucket: DAY + 3599, count: 6, clicks: 2 },
      { ts_bucket: DAY + 3 * 3600, count: 9, clicks: 5 },
      { ts_bucket: DAY - 60, count: 100, clicks: 100 },
      { ts_bucket: DAY + 86400, count: 100, clicks: 100 },
    ];
    const keys = inputByHour(buckets, DAY, "keys");
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe(10);
    expect(keys[3]).toBe(9);
    expect(keys.reduce((a, b) => a + b, 0)).toBe(19);
    expect(inputByHour(buckets, DAY, "clicks")[3]).toBe(5);
  });
});

describe("windowTitles", () => {
  it("totals time per window title inside one app", () => {
    const samples: ActivitySample[] = [
      { ts: DAY, app_name: "Chrome", window_title: "Inbox", duration_s: 60 },
      { ts: DAY + 60, app_name: "Chrome", window_title: "Docs", duration_s: 30 },
      { ts: DAY + 90, app_name: "Chrome", window_title: "Inbox", duration_s: 45 },
      { ts: DAY + 200, app_name: "Code", window_title: "Inbox", duration_s: 999 },
    ];
    expect(windowTitles(samples, "Chrome")).toEqual([
      { title: "Inbox", seconds: 105 },
      { title: "Docs", seconds: 30 },
    ]);
  });
});

describe("activityLog", () => {
  it("merges minute checkpoints of the same window and page, but not across a switch", () => {
    const samples: ActivitySample[] = [
      { ts: DAY, app_name: "Code", window_title: "main.go", duration_s: 60 },
      { ts: DAY + 60, app_name: "Code", window_title: "main.go", duration_s: 60 },
      { ts: DAY + 120, app_name: "Slack", window_title: "general", duration_s: 30 },
      { ts: DAY + 150, app_name: "Code", window_title: "main.go", duration_s: 60 },
    ];
    const visits: BrowserVisit[] = [
      { ts: DAY + 300, url: "https://www.github.com/acme", domain: "www.github.com", page_title: "acme", browser: "chrome", duration_s: 60 },
      { ts: DAY + 360, url: "https://www.github.com/acme", domain: "www.github.com", page_title: "acme", browser: "chrome", duration_s: 60 },
      // The extension's on/off marker is not a site.
      { ts: DAY + 400, url: "user_turn_off_in_browser", domain: null, page_title: "", browser: "chrome", duration_s: 5 },
    ];
    const log = activityLog(samples, visits);
    expect(log.map((e) => [e.kind, e.name, e.duration])).toEqual([
      ["app", "Code", 120],
      ["app", "Slack", 30],
      ["app", "Code", 60],
      ["site", "github.com", 120],
    ]);
  });
});
