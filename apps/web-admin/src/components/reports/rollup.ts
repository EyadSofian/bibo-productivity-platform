import type { BrowserVisit } from "../../api/types";

// Grouping browser visits by domain.
//
// This became necessary rather than merely nicer when the extension started
// checkpointing an open tab every 60 seconds: a page left open for an hour now
// arrives as ~60 rows, so an ungrouped list is unreadable. Aggregating restores
// the question a manager actually asks — "where did the time go?".
//
// Pure, so it can be tested without rendering.

/**
 * Reserved URLs the extension posts when the user flips its on/off toggle.
 * They are control events, not sites, and are excluded from this report.
 */
const MARKERS = new Set(["user_turn_off_in_browser", "user_turn_on_in_browser"]);

export interface DomainRollup {
  domain: string;
  /** Total seconds across every visit to this domain. */
  totalS: number;
  visits: number;
  /** Distinct browsers this domain was opened in, alphabetical. */
  browsers: string[];
  /** Earliest visit, so the row can still answer "when". */
  firstTs: number;
  /** Title of the single longest visit — the most representative one. */
  title: string | null;
}

export interface PageRollup {
  url: string;
  title: string | null;
  totalS: number;
  checkpoints: number;
  firstTs: number;
  lastTs: number;
  browsers: string[];
}

/**
 * The domain a visit belongs to.
 *
 * Prefers the value the backend derived, and falls back to parsing the URL so
 * rows synced before that column existed still group correctly rather than
 * collapsing into one bucket.
 */
export function domainOf(visit: Pick<BrowserVisit, "url" | "domain">): string | null {
  if (MARKERS.has(visit.url)) return null;
  const raw =
    visit.domain ??
    (() => {
      try {
        return new URL(visit.url).hostname;
      } catch {
        return null;
      }
    })();
  if (!raw) return null;
  // "www." is noise for a report, and merging it means one row per site rather
  // than two that mean the same thing.
  return raw.toLowerCase().replace(/^www\./, "");
}

/** Group visits by domain, most time first. */
export function rollupByDomain(visits: BrowserVisit[]): DomainRollup[] {
  const byDomain = new Map<string, DomainRollup & { longestS: number }>();

  for (const v of visits) {
    const domain = domainOf(v);
    if (!domain) continue;

    const duration = Math.max(0, v.duration_s ?? 0);
    const existing = byDomain.get(domain);
    if (!existing) {
      byDomain.set(domain, {
        domain,
        totalS: duration,
        visits: 1,
        browsers: v.browser ? [v.browser] : [],
        firstTs: v.ts,
        title: v.page_title || null,
        longestS: duration,
      });
      continue;
    }

    existing.totalS += duration;
    existing.visits += 1;
    existing.firstTs = Math.min(existing.firstTs, v.ts);
    if (v.browser && !existing.browsers.includes(v.browser)) existing.browsers.push(v.browser);
    if (duration > existing.longestS) {
      existing.longestS = duration;
      existing.title = v.page_title || existing.title;
    }
  }

  return [...byDomain.values()]
    .map(({ longestS: _longestS, ...row }) => ({ ...row, browsers: row.browsers.sort() }))
    // Ties broken by name so the order is stable across renders of equal rows.
    .sort((a, b) => b.totalS - a.totalS || a.domain.localeCompare(b.domain));
}

/** Group extension checkpoints by exact URL for the drill-down report. */
export function rollupByPage(visits: BrowserVisit[], domain: string): PageRollup[] {
  const byUrl = new Map<string, PageRollup>();

  for (const visit of visits) {
    if (domainOf(visit) !== domain) continue;
    const duration = Math.max(0, visit.duration_s ?? 0);
    const current = byUrl.get(visit.url);
    if (current) {
      current.totalS += duration;
      current.checkpoints += 1;
      current.firstTs = Math.min(current.firstTs, visit.ts);
      current.lastTs = Math.max(current.lastTs, visit.ts + duration);
      if (visit.page_title) current.title = visit.page_title;
      if (visit.browser && !current.browsers.includes(visit.browser)) current.browsers.push(visit.browser);
    } else {
      byUrl.set(visit.url, {
        url: visit.url,
        title: visit.page_title || null,
        totalS: duration,
        checkpoints: 1,
        firstTs: visit.ts,
        lastTs: visit.ts + duration,
        browsers: visit.browser ? [visit.browser] : [],
      });
    }
  }

  return [...byUrl.values()]
    .map((row) => ({ ...row, browsers: row.browsers.sort() }))
    .sort((a, b) => a.firstTs - b.firstTs || b.totalS - a.totalS);
}
