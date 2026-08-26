import { describe, expect, it } from "vitest";
import { detectBrowser } from "./browsers.js";

// Real user-agent strings. Every Chromium fork keeps "Chrome" in its UA, which
// is exactly why the old `includes("Edg") ? "edge" : "chrome"` check reported
// them all as Chrome.
const UA = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0",
  vivaldi:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Vivaldi/7.0.3495.29",
  brave:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
};

const brands = (...names) => names.map((brand) => ({ brand, version: "131" }));

describe("detectBrowser from the user agent", () => {
  it.each([
    ["chrome", UA.chrome],
    ["edge", UA.edge],
    ["opera", UA.opera],
    ["vivaldi", UA.vivaldi],
    ["firefox", UA.firefox],
    ["safari", UA.safari],
  ])("identifies %s", (expected, userAgent) => {
    expect(detectBrowser({ userAgent })).toBe(expected);
  });

  it("no longer reports every Chromium fork as chrome", () => {
    for (const ua of [UA.edge, UA.opera, UA.vivaldi]) {
      expect(detectBrowser({ userAgent: ua })).not.toBe("chrome");
    }
  });

  it("falls back to unknown rather than guessing", () => {
    expect(detectBrowser({ userAgent: "SomeBot/1.0" })).toBe("unknown");
    expect(detectBrowser()).toBe("unknown");
  });
});

describe("detectBrowser from userAgentData brands", () => {
  it("prefers a fork's own brand over the UA string", () => {
    expect(
      detectBrowser({
        userAgent: UA.edge,
        brands: brands("Chromium", "Microsoft Edge", "Not_A Brand"),
      }),
    ).toBe("edge");
  });

  it("identifies chrome by its full brand", () => {
    expect(
      detectBrowser({ userAgent: UA.chrome, brands: brands("Google Chrome", "Chromium", "Not_A Brand") }),
    ).toBe("chrome");
  });

  // Every fork reports bare "Chromium", so it identifies nothing and must not
  // short-circuit the user-agent checks that can still tell them apart.
  it("ignores a bare Chromium brand", () => {
    expect(detectBrowser({ userAgent: UA.opera, brands: brands("Chromium", "Not_A Brand") })).toBe("opera");
  });
});

describe("detectBrowser for Brave", () => {
  // Brave deliberately mimics Chrome's UA, so only the navigator.brave probe
  // the caller performs can tell them apart.
  it("needs the caller's probe, since its UA is Chrome's", () => {
    expect(detectBrowser({ userAgent: UA.brave })).toBe("chrome");
    expect(detectBrowser({ userAgent: UA.brave, isBrave: true })).toBe("brave");
  });

  it("wins over any other signal", () => {
    expect(detectBrowser({ userAgent: UA.edge, brands: brands("Microsoft Edge"), isBrave: true })).toBe("brave");
  });
});
