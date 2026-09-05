# 147 — Integrate Windows live video into the current workforce app

Status: implemented locally; real Windows/LiveKit acceptance remains open.
Date: 2026-09-05.

The supplied Windows branch was based on an older application and had conflicting
migration numbers. Replacing the current checkout would discard newer device,
organization, monitoring-profile and interface work. The integration starts at
`96332fa`, preserves the local Video First work in checkpoint `cc851af`, then ports
the native publisher and adapts LiveKit to the current media contracts.

Implemented:

- Device/current-membership scoped agent demand and publisher credentials.
- Screen-only publisher tokens and subscribe-only viewer tokens; data publication disabled.
- Backend stop state persisted before an external SFU call can delay shutdown.
- Native Windows publisher with visible OS capture border and a local stop action.
- Bounded named-pipe handshake, fail-closed supervision and stale-reader isolation.
- LiveKit admin player with backend-session teardown, late-response protection,
  publisher-state polling and Arabic copy.
- Windows-only sidecar packaging, CI checks and installer freshness/error checks.

Validation and remaining work: [Arabic integration review](../WINDOWS_MEDIA_INTEGRATION_REVIEW_AR.md).
Do not close the Windows runtime acceptance on the basis of macOS unit tests,
a native local publishing counter, or an installer merely being present.
