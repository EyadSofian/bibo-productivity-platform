// ctracking browser extension — MV3 service worker.
//
// Glue only. The decisions live in ./lib, which is pure and unit-tested:
//   lib/visit.js    — when a visit opens, closes, and checkpoints
//   lib/outbox.js   — the durable queue of segments waiting to be sent
//   lib/browsers.js — which browser this actually is
//
// This file owns the parts that need Chrome and the network: event wiring,
// persistence, discovering the desktop app's loopback port, and flushing.
//
// Two ordering rules keep data from being lost:
//   1. A closed segment is written to the outbox before any send is attempted.
//   2. Segments leave the outbox only once the app has accepted them.
//
// See docs/04-browser-extension.md.

import { detectBrowser } from "./lib/browsers.js";
import { append, drop, head } from "./lib/outbox.js";
import { onBlur, onCheckpoint, onFocus } from "./lib/visit.js";

const CANDIDATE_PORTS = [47615, 48291, 49377, 50603, 51719, 52837];

const CHECKPOINT_ALARM = "checkpoint";
const REDISCOVER_ALARM = "rediscover";

/**
 * How often an open visit reports the time it has accrued. One minute is the
 * floor Chrome allows for alarms, and it matches the 60-second chunking the
 * desktop already applies to foreground activity.
 */
const CHECKPOINT_MINUTES = 1;

/** Seconds without input before browsing time stops accruing. */
const IDLE_THRESHOLD_S = 60;

/** Segments attempted per flush. Bounded so one pass cannot run unboundedly long. */
const FLUSH_BATCH = 50;

// Reserved URL markers emitted when the user flips the popup toggle. The desktop app
// records these even while tracking is paused (so an "off" event still lands).
const MARKER_OFF = "user_turn_off_in_browser";
const MARKER_ON = "user_turn_on_in_browser";

const now = () => Math.floor(Date.now() / 1000);
const newId = () => crypto.randomUUID();

// ---------- browser identity ----------

let browserName = null;

// Cached: the Brave probe is async, and this cannot change while running.
async function browserId() {
  if (browserName) return browserName;
  let isBrave = false;
  try {
    isBrave = Boolean(navigator.brave && (await navigator.brave.isBrave()));
  } catch (_) {
    /* not Brave */
  }
  browserName = detectBrowser({
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands ?? [],
    isBrave,
  });
  return browserName;
}

// ---------- persistence ----------
//
// Visit state lives in session storage: it is meaningless once the browser
// closes. The outbox lives in local storage, because unsent segments must
// survive a browser restart — that is the whole point of it.

async function loadVisit() {
  const { current } = await chrome.storage.session.get("current");
  return current ?? null;
}

async function loadQueue() {
  const { outbox } = await chrome.storage.local.get("outbox");
  return Array.isArray(outbox) ? outbox : [];
}

async function isPaused() {
  const { paused } = await chrome.storage.local.get("paused");
  return Boolean(paused);
}

// Every state change is a read-modify-write across two async storage calls, and
// Chrome delivers events concurrently. Without serializing them, two events
// interleaving would lose whichever segment was written first.
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Apply one state-machine step: read the visit, run `advance`, persist the new
 * state, and queue whatever segment closed.
 */
function step(advance) {
  return serialize(async () => {
    const { state, segment } = advance(await loadVisit());
    await chrome.storage.session.set({ current: state });
    if (segment) await enqueue(segment);
  });
}

async function enqueue(segment) {
  const { queue, dropped } = append(await loadQueue(), [segment]);
  // Durable before any send is attempted. A visit recorded while the desktop
  // app is restarting used to be posted once and then discarded.
  await chrome.storage.local.set({ outbox: queue });
  if (dropped > 0) {
    reportError(
      new Error(`outbox full, dropped ${dropped} oldest segment(s)`),
      "enqueue",
    );
  }
}

// ---------- link (port + token) discovery ----------

async function getLink() {
  const { link } = await chrome.storage.local.get("link");
  return link || null;
}

async function discover() {
  for (const port of CANDIDATE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/whoami`);
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.app === "employeetrack" && j.token) {
        const link = { port, token: j.token };
        await chrome.storage.local.set({ link });
        return link;
      }
    } catch (_) {
      /* port closed — keep probing */
    }
  }
  await chrome.storage.local.set({ link: null });
  return null;
}

async function ensureLink() {
  return (await getLink()) || (await discover());
}

async function postVisit(visit) {
  let link = await ensureLink();
  if (!link) return false;
  const send = (l) =>
    fetch(`http://127.0.0.1:${l.port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ctracking-token": l.token },
      body: JSON.stringify(visit),
    });
  try {
    let res = await send(link);
    if (res.status === 401 || res.status === 404) {
      // Token/port changed (app restarted) — re-discover once and retry.
      link = await discover();
      if (!link) return false;
      res = await send(link);
    }
    return res.status === 200;
  } catch (_) {
    // Connection refused — app moved/closed. Clear so we re-discover next time.
    await chrome.storage.local.set({ link: null });
    return false;
  }
}

// ---------- flushing ----------

let flushing = false;

/**
 * Send queued segments oldest-first, dropping only what the app accepted.
 *
 * Runs outside the state lock: appends land at the tail and this only ever
 * removes from the head, so a checkpoint firing mid-flush is safe. The
 * `flushing` guard keeps two passes from sending the same segments twice.
 */
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const queue = await loadQueue();
      const batch = head(queue, FLUSH_BATCH);
      if (batch.length === 0) return;

      let accepted = 0;
      for (const segment of batch) {
        // Stop at the first refusal: the app is unreachable, and the rest stay
        // queued in order for the next attempt.
        if (!(await postVisit(segment))) break;
        accepted++;
      }

      if (accepted > 0) {
        await serialize(async () =>
          chrome.storage.local.set({ outbox: drop(await loadQueue(), accepted) }),
        );
        await bumpCount(accepted);
      }
      // Stop when the app stopped accepting, or when nothing is left to try.
      if (accepted < batch.length || queue.length <= batch.length) return;
    }
  } catch (e) {
    reportError(e, "flush");
  } finally {
    flushing = false;
  }
}

async function bumpCount(delta) {
  const today = new Date().toDateString();
  const { countDay, count } = await chrome.storage.local.get(["countDay", "count"]);
  if (countDay === today) {
    await chrome.storage.local.set({ count: (count || 0) + delta });
  } else {
    await chrome.storage.local.set({ countDay: today, count: delta });
  }
}

// Forward an unexpected error to the local desktop app, which reports it to Sentry on
// our behalf (an MV3 service worker can't bundle the Sentry SDK cleanly). Best-effort:
// swallow its own failures and never recurse. "App closed" (connection refused) is a
// normal state, not an error to report.
async function reportError(err, context) {
  try {
    const link = await getLink();
    if (!link) return; // no app to report to; don't trigger discovery just for this
    await fetch(`http://127.0.0.1:${link.port}/report-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ctracking-token": link.token },
      body: JSON.stringify({
        message: String((err && err.message) || err),
        stack: err && err.stack ? String(err.stack) : null,
        context: context || null,
        url: await browserId(),
      }),
    });
  } catch (_) {
    /* desktop app unreachable — drop the report. */
  }
}

// ---------- transitions ----------

/** Point the tracker at `url`, or close the open visit when there is nothing to track. */
async function focusUrl(url, title) {
  if (await isPaused()) return blur();
  const browser = await browserId();
  const ts = now();
  const id = newId();
  await step((state) => onFocus(state, { url, title, browser, ts, id }));
}

/** Stop counting: focus left the browser, the machine went idle, or tracking paused. */
function blur() {
  const ts = now();
  return step((state) => onBlur(state, ts));
}

/** Follow whatever tab is active in the focused window, if any. */
async function followActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.url) {
    await focusUrl(tab.url, tab.title);
  } else {
    await blur();
  }
}

// ---------- events ----------

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await focusUrl(tab.url, tab.title);
  } catch (e) {
    // chrome.tabs.get rejects for closed/forbidden tabs — that's expected; only an
    // unexpected transition failure is worth reporting.
    reportError(e, "onActivated");
  }
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url || changeInfo.status === "complete") {
    try {
      await focusUrl(tab.url, tab.title);
    } catch (e) {
      reportError(e, "onUpdated");
    }
  }
});

// Closing the tracked tab used to lose its visit entirely: nothing closed the
// segment, and the next transition overwrote it.
chrome.tabs.onRemoved.addListener(async () => {
  try {
    await followActiveTab();
    // Closing a tab is often the last thing before closing the browser, so
    // send now rather than waiting for a checkpoint that may not come.
    await flush();
  } catch (e) {
    reportError(e, "onRemoved");
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  try {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      // Browser lost focus — finalize and stop counting.
      await blur();
      await flush();
    } else {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab) await focusUrl(tab.url, tab.title);
    }
  } catch (e) {
    reportError(e, "onFocusChanged");
  }
});

// Time in front of an untouched browser is not browsing time. Without this the
// extension kept accruing while the machine sat idle, contradicting the desktop
// tracker and double-counting the same minutes.
chrome.idle.setDetectionInterval(IDLE_THRESHOLD_S);
chrome.idle.onStateChanged.addListener(async (state) => {
  try {
    if (state === "active") {
      await followActiveTab();
    } else {
      await blur();
      await flush();
    }
  } catch (e) {
    reportError(e, "onIdleStateChanged");
  }
});

// Emit a marker browser-page when the user toggles tracking on/off in the popup.
// Driven from the service worker so port/token discovery (postVisit) is reused.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.paused) return;
  const paused = Boolean(changes.paused.newValue);
  // Close whatever was open before the toggle, so its time is not attributed to
  // the paused period.
  if (paused) await blur();
  await postVisit({
    url: paused ? MARKER_OFF : MARKER_ON,
    page_title: paused ? "Tracking turned off in browser" : "Tracking turned on in browser",
    ts: now(),
    browser: await browserId(),
    duration_s: 0,
  });
  if (!paused) await followActiveTab();
});

// Catch stray throws / rejections in the service worker itself.
self.addEventListener("error", (ev) => reportError(ev.error || ev.message, "worker.error"));
self.addEventListener("unhandledrejection", (ev) => reportError(ev.reason, "worker.unhandledrejection"));

// ---------- schedule ----------

chrome.runtime.onInstalled.addListener(() => discover());
chrome.runtime.onStartup.addListener(() => discover());

chrome.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: CHECKPOINT_MINUTES });
chrome.alarms.create(REDISCOVER_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (a) => {
  try {
    if (a.name === REDISCOVER_ALARM) {
      await ensureLink();
      return;
    }
    if (a.name !== CHECKPOINT_ALARM) return;

    // The reason a tab left open all day now produces rows at all: nothing else
    // closes a visit the user never switches away from.
    const ts = now();
    await step((state) => onCheckpoint(state, ts, newId()));
    await flush();
  } catch (e) {
    reportError(e, "onAlarm");
  }
});
