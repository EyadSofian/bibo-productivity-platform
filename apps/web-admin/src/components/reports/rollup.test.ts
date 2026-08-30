import { describe, expect, it } from "vitest";
import type { BrowserVisit } from "../../api/types";
import { domainOf, rollupByDomain, rollupByPage } from "./rollup";

function visit(over: Partial<BrowserVisit> = {}): BrowserVisit {
  return {
    ts: 1_700_000_000,
    url: "https://github.com/a",
    domain: "github.com",
    page_title: "GitHub",
    browser: "chrome",
    duration_s: 60,
    ...over,
  };
}

describe("domainOf", () => {
  it("prefers the domain the backend derived", () => {
    expect(domainOf({ url: "https://github.com/a/b", domain: "github.com" })).toBe("github.com");
  });

  // Rows synced before the backend had a domain column must still group, rather
  // than all collapsing into one bucket.
  it("falls back to parsing the URL when the domain is missing", () => {
    expect(domainOf({ url: "https://docs.google.com/x", domain: null })).toBe("docs.google.com");
  });

  it("merges www with the bare host", () => {
    expect(domainOf({ url: "https://www.github.com/a", domain: "www.github.com" })).toBe("github.com");
  });

  it("lowercases", () => {
    expect(domainOf({ url: "https://GitHub.com", domain: "GitHub.com" })).toBe("github.com");
  });

  // The on/off toggle events are control signals, not sites.
  it("rejects the marker URLs", () => {
    expect(domainOf({ url: "user_turn_off_in_browser", domain: null })).toBeNull();
    expect(domainOf({ url: "user_turn_on_in_browser", domain: null })).toBeNull();
  });

  it("rejects an unparseable URL with no domain", () => {
    expect(domainOf({ url: "notaurl", domain: null })).toBeNull();
  });
});

describe("rollupByDomain", () => {
  // The checkpointing extension reports one row per minute for an open tab, so
  // an hour on one page arrives as ~60 rows. Collapsing them is the point.
  it("collapses many checkpoints of one page into a single row", () => {
    const visits = Array.from({ length: 60 }, (_, i) =>
      visit({ ts: 1_700_000_000 + i * 60, duration_s: 60 }),
    );

    const rows = rollupByDomain(visits);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "github.com", visits: 60, totalS: 3600 });
  });

  it("orders by total time spent", () => {
    const rows = rollupByDomain([
      visit({ url: "https://a.com", domain: "a.com", duration_s: 30 }),
      visit({ url: "https://b.com", domain: "b.com", duration_s: 300 }),
      visit({ url: "https://c.com", domain: "c.com", duration_s: 120 }),
    ]);

    expect(rows.map((r) => r.domain)).toEqual(["b.com", "c.com", "a.com"]);
  });

  it("breaks ties by name so equal rows do not reshuffle", () => {
    const rows = rollupByDomain([
      visit({ url: "https://z.com", domain: "z.com", duration_s: 60 }),
      visit({ url: "https://a.com", domain: "a.com", duration_s: 60 }),
    ]);

    expect(rows.map((r) => r.domain)).toEqual(["a.com", "z.com"]);
  });

  it("keeps the earliest timestamp for the row", () => {
    const rows = rollupByDomain([
      visit({ ts: 2000 }),
      visit({ ts: 1000 }),
      visit({ ts: 3000 }),
    ]);

    expect(rows[0].firstTs).toBe(1000);
  });

  it("collects the distinct browsers a site was opened in", () => {
    const rows = rollupByDomain([
      visit({ browser: "edge" }),
      visit({ browser: "brave" }),
      visit({ browser: "edge" }),
    ]);

    expect(rows[0].browsers).toEqual(["brave", "edge"]);
  });

  // The longest visit is the one most likely to describe what the person was
  // actually doing there.
  it("shows the title of the longest visit", () => {
    const rows = rollupByDomain([
      visit({ page_title: "Short stop", duration_s: 5 }),
      visit({ page_title: "The real work", duration_s: 600 }),
      visit({ page_title: "Another glance", duration_s: 10 }),
    ]);

    expect(rows[0].title).toBe("The real work");
  });

  it("excludes the on/off markers", () => {
    const rows = rollupByDomain([
      visit(),
      visit({ url: "user_turn_off_in_browser", domain: null, page_title: "off", duration_s: 0 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe("github.com");
  });

  it("returns nothing for an empty range", () => {
    expect(rollupByDomain([])).toEqual([]);
  });

  it("does not let a negative duration subtract from a total", () => {
    const rows = rollupByDomain([visit({ duration_s: 60 }), visit({ duration_s: -100 })]);

    expect(rows[0].totalS).toBe(60);
  });
});

describe("rollupByPage", () => {
  it("keeps exact URLs while collapsing minute checkpoints", () => {
    const rows = rollupByPage(
      [
        visit({ ts: 1000, url: "https://github.com/org/repo?tab=readme", duration_s: 60 }),
        visit({ ts: 1060, url: "https://github.com/org/repo?tab=readme", duration_s: 60 }),
        visit({
          ts: 1120,
          url: "https://github.com/org/issues",
          page_title: "Issues",
          duration_s: 30,
        }),
      ],
      "github.com",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      url: "https://github.com/org/repo?tab=readme",
      totalS: 120,
      checkpoints: 2,
      firstTs: 1000,
      lastTs: 1120,
    });
    expect(rows[1].title).toBe("Issues");
  });

  it("returns only the selected domain", () => {
    const rows = rollupByPage(
      [
        visit(),
        visit({ url: "https://docs.google.com/document/1", domain: "docs.google.com" }),
      ],
      "github.com",
    );

    expect(rows.map((row) => row.url)).toEqual(["https://github.com/a"]);
  });
});
