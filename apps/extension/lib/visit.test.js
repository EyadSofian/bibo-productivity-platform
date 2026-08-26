import { describe, expect, it } from "vitest";
import { domainOf, MIN_VISIT_S, onBlur, onCheckpoint, onFocus, trackable } from "./visit.js";

const GITHUB = "https://github.com/anthropics/claude-code";
const DOCS = "https://docs.google.com/document/d/abc";

function focus(state, url, ts, extra = {}) {
  return onFocus(state, { url, title: "T", browser: "chrome", ts, id: `id-${ts}`, ...extra });
}

/** Open a visit at `ts` and return just the state. */
function opened(url, ts) {
  return focus(null, url, ts).state;
}

describe("trackable", () => {
  it("accepts http and https", () => {
    expect(trackable("https://example.com")).toBe(true);
    expect(trackable("http://example.com")).toBe(true);
  });

  it("rejects browser-internal and non-web URLs", () => {
    for (const url of [
      "chrome://extensions",
      "about:blank",
      "file:///Users/me/notes.txt",
      "chrome-extension://abc/popup.html",
      "edge://settings",
      "",
      null,
      undefined,
    ]) {
      expect(trackable(url), `${url} should not be trackable`).toBe(false);
    }
  });
});

describe("domainOf", () => {
  it("returns the lowercased hostname", () => {
    expect(domainOf("https://GitHub.com/a/b?c=1")).toBe("github.com");
    expect(domainOf("https://docs.google.com/x")).toBe("docs.google.com");
  });

  it("drops the port but keeps the host", () => {
    expect(domainOf("http://localhost:3000/app")).toBe("localhost");
    expect(domainOf("https://192.168.1.5:8443/")).toBe("192.168.1.5");
  });

  it("normalizes internationalized hosts to punycode", () => {
    expect(domainOf("https://münchen.de/")).toBe("xn--mnchen-3ya.de");
  });

  it("returns null for a malformed URL", () => {
    expect(domainOf("notaurl")).toBeNull();
  });
});

describe("onFocus", () => {
  it("opens a visit without emitting anything", () => {
    const { state, segment } = focus(null, GITHUB, 100);

    expect(segment).toBeNull();
    expect(state).toMatchObject({ url: GITHUB, startTs: 100, browser: "chrome" });
  });

  it("closes the previous visit when the page changes", () => {
    const { state, segment } = focus(opened(GITHUB, 100), DOCS, 160);

    expect(segment).toMatchObject({
      url: GITHUB,
      domain: "github.com",
      ts: 100,
      duration_s: 60,
      browser: "chrome",
    });
    expect(state.url).toBe(DOCS);
    expect(state.startTs).toBe(160);
  });

  // tabs.onUpdated fires several times for one page load. Restarting the visit
  // on each would shred a single page view into fragments.
  it("does not restart when the same URL is refocused", () => {
    const { state, segment } = focus(opened(GITHUB, 100), GITHUB, 160);

    expect(segment).toBeNull();
    expect(state.startTs).toBe(100);
  });

  it("picks up a title that arrives after the page settles", () => {
    const first = focus(null, GITHUB, 100, { title: "" }).state;

    const { state } = focus(first, GITHUB, 102, { title: "GitHub" });

    expect(state.title).toBe("GitHub");
  });

  it("does not overwrite a known title with a later empty one", () => {
    const first = focus(null, GITHUB, 100, { title: "GitHub" }).state;

    const { state } = focus(first, GITHUB, 102, { title: "" });

    expect(state.title).toBe("GitHub");
  });

  it("closes the visit when focus moves to an untrackable page", () => {
    const { state, segment } = focus(opened(GITHUB, 100), "chrome://extensions", 160);

    expect(segment).toMatchObject({ url: GITHUB, duration_s: 60 });
    expect(state).toBeNull();
  });

  it("drops a visit shorter than the minimum", () => {
    const { segment } = focus(opened(GITHUB, 100), DOCS, 100 + MIN_VISIT_S - 1);

    expect(segment).toBeNull();
  });

  it("keeps a visit of exactly the minimum", () => {
    const { segment } = focus(opened(GITHUB, 100), DOCS, 100 + MIN_VISIT_S);

    expect(segment).toMatchObject({ duration_s: MIN_VISIT_S });
  });
});

describe("onBlur", () => {
  it("closes the open visit", () => {
    const { state, segment } = onBlur(opened(GITHUB, 100), 190);

    expect(segment).toMatchObject({ url: GITHUB, duration_s: 90 });
    expect(state).toBeNull();
  });

  it("is a no-op when nothing is open", () => {
    expect(onBlur(null, 190)).toEqual({ state: null, segment: null });
  });
});

describe("onCheckpoint", () => {
  // The regression that produced `"browser_visit": []`: a tab watched without
  // switching away never triggered a transition, so nothing was ever recorded.
  it("reports time for a tab nobody switches away from", () => {
    let state = opened(GITHUB, 0);
    const segments = [];

    for (let minute = 1; minute <= 30; minute++) {
      const step = onCheckpoint(state, minute * 60, `cp-${minute}`);
      state = step.state;
      if (step.segment) segments.push(step.segment);
    }

    expect(segments).toHaveLength(30);
    expect(segments.every((s) => s.url === GITHUB)).toBe(true);
    expect(segments.reduce((total, s) => total + s.duration_s, 0)).toBe(30 * 60);
  });

  it("reopens the visit so no time falls between segments", () => {
    const first = onCheckpoint(opened(GITHUB, 100), 160, "cp-1");
    const second = onCheckpoint(first.state, 220, "cp-2");

    expect(first.segment.ts + first.segment.duration_s).toBe(second.segment.ts);
  });

  it("gives each segment its own key", () => {
    const first = onCheckpoint(opened(GITHUB, 100), 160, "cp-1");
    const second = onCheckpoint(first.state, 220, "cp-2");

    expect(first.segment.client_uuid).not.toBe(second.segment.client_uuid);
  });

  it("is a no-op when nothing is open", () => {
    expect(onCheckpoint(null, 160, "cp-1")).toEqual({ state: null, segment: null });
  });

  // Leaving the visit running matters: resetting startTs on every early tick
  // would mean a visit could never accumulate past the checkpoint interval.
  it("leaves the visit running when too little time has passed", () => {
    const state = opened(GITHUB, 100);

    const { state: next, segment } = onCheckpoint(state, 100, "cp-1");

    expect(segment).toBeNull();
    expect(next.startTs).toBe(100);
  });
});

describe("clock moving backwards", () => {
  it("drops the segment rather than reporting negative time", () => {
    const { segment } = focus(opened(GITHUB, 1000), DOCS, 400);

    expect(segment).toBeNull();
  });

  it("keeps the checkpointed visit running", () => {
    const { state, segment } = onCheckpoint(opened(GITHUB, 1000), 400, "cp-1");

    expect(segment).toBeNull();
    expect(state.startTs).toBe(1000);
  });
});
