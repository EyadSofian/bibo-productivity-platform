// A minimal fake of the Chrome extension APIs background.js uses, so the real
// service worker can be imported and driven in a test.
//
// It is deliberately small: enough to exercise the wiring (events in, fetches
// out, storage in between) without pretending to be Chrome. Anything the tests
// do not drive is simply absent, so a missing piece fails loudly.

export function makeChrome() {
  const areas = { local: new Map(), session: new Map() };
  const listeners = new Map();

  const on = (name) => ({
    addListener: (fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
  });

  function area(name) {
    const store = areas[name];
    return {
      async get(keys) {
        const wanted = typeof keys === "string" ? [keys] : keys;
        const out = {};
        for (const k of wanted) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store.get(k), newValue: v };
          store.set(k, v);
        }
        for (const fn of listeners.get("storage.onChanged") ?? []) {
          await fn(changes, name);
        }
      },
    };
  }

  const tabs = { byId: new Map(), active: null };

  const chrome = {
    storage: { local: area("local"), session: area("session"), onChanged: on("storage.onChanged") },
    tabs: {
      onActivated: on("tabs.onActivated"),
      onUpdated: on("tabs.onUpdated"),
      onRemoved: on("tabs.onRemoved"),
      async get(id) {
        const tab = tabs.byId.get(id);
        if (!tab) throw new Error(`no tab ${id}`);
        return tab;
      },
      async query() {
        return tabs.active ? [tabs.active] : [];
      },
    },
    windows: { onFocusChanged: on("windows.onFocusChanged"), WINDOW_ID_NONE: -1 },
    alarms: { created: [], create: (name, opts) => chrome.alarms.created.push({ name, ...opts }), onAlarm: on("alarms.onAlarm") },
    idle: {
      detectionInterval: null,
      setDetectionInterval: (s) => (chrome.idle.detectionInterval = s),
      onStateChanged: on("idle.onStateChanged"),
    },
    runtime: { onInstalled: on("runtime.onInstalled"), onStartup: on("runtime.onStartup") },
  };

  /** Fire every listener registered for `name`, awaiting each. */
  async function fire(name, ...args) {
    for (const fn of listeners.get(name) ?? []) await fn(...args);
  }

  return {
    chrome,
    fire,
    tabs,
    /** Read a storage key directly, bypassing the extension. */
    stored: (name, key) => areas[name].get(key),
    setActiveTab: (tab) => {
      tabs.active = tab;
      if (tab) tabs.byId.set(tab.id ?? 1, tab);
    },
  };
}

/**
 * A fake desktop app on loopback. `up` controls whether it answers, so a test
 * can take it away mid-session and bring it back.
 */
export function makeApp({ up = true, port = 47615, token = "tok" } = {}) {
  const app = {
    up,
    /** Every visit received, flattened out of whatever shape it arrived in. */
    visits: [],
    /** Raw request bodies, so a test can check batching rather than just totals. */
    requests: [],
    /** Requests that never reached a listening port. */
    refused: 0,
    fetch: async (url, init) => {
      if (!app.up) {
        app.refused++;
        throw new TypeError("Failed to fetch");
      }
      if (url === `http://127.0.0.1:${port}/whoami`) {
        return jsonResponse({ app: "employeetrack", version: "test", token });
      }
      if (url === `http://127.0.0.1:${port}/ingest`) {
        // The real endpoint takes a single visit or an array; record what
        // arrived either way, and remember the shape so a test can assert it.
        const body = JSON.parse(init.body);
        app.requests.push(body);
        app.visits.push(...(Array.isArray(body) ? body : [body]));
        return new Response("", { status: 200 });
      }
      if (url === `http://127.0.0.1:${port}/report-error`) {
        return new Response("", { status: 200 });
      }
      // Any other candidate port is closed.
      throw new TypeError("Failed to fetch");
    },
  };
  return app;
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
