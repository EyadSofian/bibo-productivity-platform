# ctracking browser extension

Manifest V3 extension (Chrome/Edge) that reports the active tab's URL + time-on-page
to the local ctracking desktop app. No build step — plain files.

## Load it (unpacked)

1. Make sure the **ctracking desktop app is running** (it hosts the local server).
2. Open **chrome://extensions** (or **edge://extensions**).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select this folder (`apps/extension`).
5. The toolbar icon's popup shows **● Connected** once it finds the app.

## Layout

The decisions live in `lib/`, which is pure and unit-tested. `background.js` is glue:
event wiring, storage, discovery and flushing.

```
lib/visit.js      when a visit opens, closes and checkpoints
lib/outbox.js     the durable queue of segments waiting to be sent
lib/browsers.js   which browser this actually is
background.js     Chrome + network glue
test/             drives background.js against a fake Chrome and a fake app
```

Run the tests with `pnpm --filter @ctracking/extension test`.

## How it works

- **Discovery:** probes the candidate ports `47615, 48291, 49377, 50603, 51719, 52837`
  with `GET /whoami`, confirms `app == "employeetrack"`, and caches `{port, token}`.
- **Tracking:** a visit opens when a page takes focus and closes on a tab switch, URL
  change, tab close, window blur, or when the machine goes idle.
- **Checkpoints:** a 60-second alarm closes and reopens the running visit, so a tab left
  open all day reports its time as it accrues. Without this, a page nobody switched away
  from produced no rows at all.
- **Idle:** `chrome.idle` stops the clock after 60 seconds without input, so time in
  front of an untouched browser is not counted as browsing.
- **Outbox:** a closed visit is written to `storage.local` **before** any send is
  attempted, and removed only once the app accepts it. Visits recorded while the desktop
  app is down survive a browser restart. The queue is capped at 500 segments,
  oldest-evicted.
- **Recovery:** if the app restarts on a different port (or the token changes), a
  failed post triggers re-discovery automatically.
- **Privacy:** only the active tab's URL, domain, title, duration and browser name are
  sent — to 127.0.0.1.

## Notes

- The service worker is an ES module (`"type": "module"` in the manifest) because it
  imports from `lib/`. Dropping that breaks the extension silently at load; CI checks it.
- Requires the desktop app's local server. The token is read from `/whoami`; a web page
  can't read it (no CORS) and `/ingest` rejects web origins.
- Pause tracking from the popup toggle.
- Each segment carries a `client_uuid`. Nothing deduplicates on it yet — the desktop app
  assigns its own id on insert — so a send whose response is lost can still produce a
  duplicate row. Closing that needs a local `ON CONFLICT(client_uuid)` upsert; the field
  ships now so that fix does not also need a Web Store release.
