// Visit state machine.
//
// Pure by design: no Chrome APIs, no clock, no I/O. Every entry point takes the
// current time and the current state, and returns the next state plus any visit
// segment that just closed. That makes it unit-testable (the whole reason it
// lives outside background.js) and safe across service-worker suspension, since
// the state is plain JSON the caller persists.
//
// A segment is only ever produced by *closing* an open visit. Nothing here
// sends anything — the caller queues what it gets back.

/** Visits shorter than this are noise (a tab passed through while switching). */
export const MIN_VISIT_S = 1;

/**
 * A URL worth recording. Everything else — chrome://, about:, file://, the new
 * tab page, extension pages — is deliberately ignored.
 */
export function trackable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * Hostname of a URL, lowercased, or null when it has none.
 *
 * The full hostname is kept rather than a registrable domain: reducing
 * "docs.google.com" to "google.com" needs a public-suffix list, which is a lot
 * of weight for a service worker, and the distinction matters for
 * classification. The backend can narrow it later; it cannot recover detail
 * that was thrown away here.
 */
export function domainOf(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

/**
 * Close the open visit, if there is one worth keeping.
 * Returns the segment, or null when there was nothing (or nothing valid).
 */
function close(state, ts) {
  if (!state) return null;
  const duration = ts - state.startTs;
  // A negative duration means the system clock moved backwards mid-visit. The
  // elapsed time is unknowable, so the segment is dropped rather than guessed.
  if (duration < MIN_VISIT_S) return null;
  return {
    // Stable natural key for the segment, carried so a resend after a lost
    // response can be recognised as the same visit rather than becoming a
    // second row. Nothing downstream deduplicates on it yet; it ships now
    // because extension updates roll out through the Web Store on their own
    // schedule, and adding the field later would gate the fix on that.
    client_uuid: state.id,
    url: state.url,
    domain: domainOf(state.url),
    page_title: state.title || null,
    browser: state.browser,
    ts: state.startTs,
    duration_s: duration,
  };
}

function open({ url, title, browser, ts, id }) {
  return { url, title: title || "", browser, startTs: ts, id };
}

/**
 * The focused page changed. Closes the current visit and opens one for `url`.
 *
 * Re-focusing the same URL does not restart the visit: tabs.onUpdated fires
 * repeatedly for one page load, and treating each as a new visit would shred a
 * single page view into fragments.
 */
export function onFocus(state, { url, title, browser, ts, id }) {
  if (!trackable(url)) return onBlur(state, ts);

  if (state && state.url === url) {
    // Same page — keep the visit running, but take a title if we only now have
    // one (onUpdated often fires with an empty title before the page settles).
    const next = title && !state.title ? { ...state, title } : state;
    return { state: next, segment: null };
  }

  return { state: open({ url, title, browser, ts, id }), segment: close(state, ts) };
}

/**
 * Browsing stopped — the window lost focus, the tab closed, the machine went
 * idle, or the user paused tracking. Closes the visit and opens nothing.
 */
export function onBlur(state, ts) {
  return { state: null, segment: close(state, ts) };
}

/**
 * Periodic tick. Closes the open visit and immediately reopens it at the same
 * instant, so a page left open for hours still reports time as it accrues.
 *
 * This is the fix for the reported `"browser_visit": []`: without it a visit is
 * only ever written when the user switches away, so a single tab watched all
 * day produced no rows at all.
 *
 * Splitting mirrors how the desktop already chunks foreground activity on a
 * 60-second cap, so the two data sources stay shaped the same way.
 */
export function onCheckpoint(state, ts, id) {
  if (!state) return { state: null, segment: null };

  const segment = close(state, ts);
  // Nothing closed (clock skew, or less than a second has passed): leave the
  // visit running untouched rather than silently resetting its start time.
  if (!segment) return { state, segment: null };

  return {
    state: open({ url: state.url, title: state.title, browser: state.browser, ts, id }),
    segment,
  };
}
