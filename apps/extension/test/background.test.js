// Drives the real background.js against a fake Chrome and a fake desktop app.
//
// The unit tests in lib/ prove the decisions are right; these prove the wiring
// delivers them — that events reach the state machine, that segments reach the
// outbox, and that the outbox survives the app being unreachable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeChrome } from "./chrome-stub.js";

const GITHUB = { id: 1, url: "https://github.com/anthropics/claude-code", title: "GitHub", active: true };
const DOCS = { id: 2, url: "https://docs.google.com/document/d/abc", title: "Doc", active: true };

let clock = 1_000_000;
const advance = (seconds) => (clock += seconds);

/** Boot a fresh service worker with a fresh fake Chrome and app. */
async function boot({ appUp = true } = {}) {
  vi.resetModules();
  clock = 1_000_000;

  const env = makeChrome();
  const app = makeApp({ up: appUp });

  vi.stubGlobal("chrome", env.chrome);
  vi.stubGlobal("fetch", (url, init) => app.fetch(url, init));
  // `self` is the service worker's global scope; Node has no equivalent.
  const workerErrors = [];
  vi.stubGlobal("self", {
    addEventListener: (name, fn) => workerErrors.push({ name, fn }),
  });
  vi.stubGlobal("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    userAgentData: { brands: [{ brand: "Google Chrome" }] },
  });
  vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);

  await import("../background.js");
  return { ...env, app };
}

/** One checkpoint alarm tick. */
const checkpoint = (env) => env.fire("alarms.onAlarm", { name: "checkpoint" });

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("startup", () => {
  it("schedules a checkpoint alarm", async () => {
    const env = await boot();

    expect(env.chrome.alarms.created.map((a) => a.name)).toContain("checkpoint");
  });

  it("asks Chrome to report idle on the tracker's threshold", async () => {
    const env = await boot();

    expect(env.chrome.idle.detectionInterval).toBe(60);
  });
});

describe("a tab nobody switches away from", () => {
  // The reported defect: a single long-lived tab produced `"browser_visit": []`
  // because only a tab switch ever wrote a row.
  it("reports its time while it is still open", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });

    for (let i = 0; i < 30; i++) {
      advance(60);
      await checkpoint(env);
    }

    expect(env.app.visits.length).toBeGreaterThan(0);
    const total = env.app.visits.reduce((sum, v) => sum + v.duration_s, 0);
    expect(total).toBe(30 * 60);
    expect(env.app.visits.every((v) => v.url === GITHUB.url)).toBe(true);
  });

  it("sends the domain alongside the URL", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });
    advance(60);

    await checkpoint(env);

    expect(env.app.visits[0]).toMatchObject({ domain: "github.com", browser: "chrome" });
  });
});

describe("when the desktop app is unreachable", () => {
  // Visits used to be posted once and dropped on failure, so everything
  // recorded while the app restarted was lost for good.
  it("keeps the visits and sends them once it returns", async () => {
    const env = await boot({ appUp: false });
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });

    for (let i = 0; i < 3; i++) {
      advance(60);
      await checkpoint(env);
    }
    expect(env.app.visits).toHaveLength(0);
    expect(await env.stored("local", "outbox")).toHaveLength(3);

    env.app.up = true;
    advance(60);
    await checkpoint(env);

    expect(env.app.visits).toHaveLength(4);
    expect(await env.stored("local", "outbox")).toHaveLength(0);
  });

  it("queues the segment before attempting to send it", async () => {
    const env = await boot({ appUp: false });
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });
    advance(90);

    await env.fire("windows.onFocusChanged", env.chrome.windows.WINDOW_ID_NONE);

    const outbox = await env.stored("local", "outbox");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ url: GITHUB.url, duration_s: 90 });
  });
});

describe("idle", () => {
  // Time in front of an untouched browser is not browsing time; counting it
  // contradicted the desktop tracker and double-counted the same minutes.
  it("stops accruing when the machine goes idle", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });

    advance(60);
    await env.fire("idle.onStateChanged", "idle");
    const afterIdle = env.app.visits.reduce((sum, v) => sum + v.duration_s, 0);

    advance(600);
    await checkpoint(env);

    expect(afterIdle).toBe(60);
    expect(env.app.visits.reduce((sum, v) => sum + v.duration_s, 0)).toBe(60);
  });

  it("resumes on the active tab when the machine wakes", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });
    advance(60);
    await env.fire("idle.onStateChanged", "idle");

    advance(600);
    await env.fire("idle.onStateChanged", "active");
    advance(60);
    await checkpoint(env);

    const total = env.app.visits.reduce((sum, v) => sum + v.duration_s, 0);
    expect(total).toBe(120);
  });
});

describe("tab and window transitions", () => {
  it("closes the visit when the browser loses focus", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });
    advance(45);

    await env.fire("windows.onFocusChanged", env.chrome.windows.WINDOW_ID_NONE);

    expect(env.app.visits).toHaveLength(1);
    expect(env.app.visits[0]).toMatchObject({ url: GITHUB.url, duration_s: 45 });
  });

  it("attributes time to the right page across a switch", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });

    advance(30);
    env.setActiveTab(DOCS);
    await env.fire("tabs.onActivated", { tabId: DOCS.id });
    advance(90);
    await checkpoint(env);

    expect(env.app.visits[0]).toMatchObject({ url: GITHUB.url, duration_s: 30 });
    expect(env.app.visits[1]).toMatchObject({ url: DOCS.url, duration_s: 90 });
  });

  // Closing the tracked tab used to lose its visit: nothing closed the segment.
  it("closes the visit when the tracked tab is closed", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });
    advance(75);

    env.setActiveTab(null);
    await env.fire("tabs.onRemoved", GITHUB.id);

    expect(env.app.visits).toHaveLength(1);
    expect(env.app.visits[0]).toMatchObject({ url: GITHUB.url, duration_s: 75 });
  });

  it("does not fragment a visit across repeated onUpdated events", async () => {
    const env = await boot();
    env.setActiveTab(GITHUB);
    await env.fire("tabs.onActivated", { tabId: GITHUB.id });

    advance(10);
    await env.fire("tabs.onUpdated", GITHUB.id, { status: "complete" }, GITHUB);
    advance(50);
    await checkpoint(env);

    expect(env.app.visits).toHaveLength(1);
    expect(env.app.visits[0].duration_s).toBe(60);
  });

  it("rapid switching attributes every visit without losing one", async () => {
    const env = await boot();
    const pages = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      url: `https://example.com/page-${i}`,
      title: `Page ${i}`,
      active: true,
    }));

    for (const page of pages) {
      env.setActiveTab(page);
      await env.fire("tabs.onActivated", { tabId: page.id });
      advance(5);
    }
    await env.fire("windows.onFocusChanged", env.chrome.windows.WINDOW_ID_NONE);

    expect(env.app.visits).toHaveLength(pages.length);
    expect(env.app.visits.map((v) => v.url)).toEqual(pages.map((p) => p.url));
    expect(env.app.visits.every((v) => v.duration_s === 5)).toBe(true);
  });
});

describe("untrackable pages", () => {
  it("records nothing for browser-internal pages", async () => {
    const env = await boot();
    const settings = { id: 9, url: "chrome://settings", title: "Settings", active: true };
    env.setActiveTab(settings);
    await env.fire("tabs.onActivated", { tabId: settings.id });

    advance(300);
    await checkpoint(env);

    expect(env.app.visits).toHaveLength(0);
  });
});
