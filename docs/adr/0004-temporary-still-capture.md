# ADR 0004 — Temporary periodic screenshots on Railway

- **Status:** Active temporary exception
- **Date:** 2026-10-18
- **Scope:** Railway channel only
- **Owner decision:** Periodic screenshots are required until continuous video recording credits are funded.

ADR 0002 remains the design for live video and eventual recorded history. This
decision temporarily reopens its retained still capture path for periodic history;
it does not turn live video into a sequence of images.

The existing desktop gate, upload endpoint, owner-scoped report and file store
are reused. The deployment must explicitly set `LEGACY_STILL_CAPTURE_ENABLED=true`;
the repository default remains false. An agent refreshes that gate on every
background sync pass, including while its window is closed to the tray. The
employee day view shows the images under **Screenshots**. Capture requires the
employee's Windows consent, screen permission, assigned monitoring rule and an
enabled local screenshot preference. The curated sensitive-app skip list remains
active in privacy mode.

For production, use a ten-minute capture interval while video recording is
paused. Keep the existing 90-day business retention policy so historical images
are not deleted by this release. At a 50 KiB image cap, a device running
continuously would upload at most about 7 MiB per day in single-window mode.
The backend's 200 KiB upload ceiling remains a separate defensive limit.

When continuous recording can resume, disable the deployment gate first, verify
`/healthz` reports `still_capture_enabled:false`, and let the agent sync once.
Then remove the Screenshots tab and legacy pipeline in a later release. Existing
images remain subject to retention and must not be silently deleted during the
transition.
