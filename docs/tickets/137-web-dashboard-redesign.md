# 137 — web-admin Dashboard (Overview) redesign

**Status:** Done (UI); backend metrics pending (see Follow-up)
**Type:** Implementation (UI-only)

## Goal
Restyle the web-admin **Dashboard** (`/admin`, Overview) to match the offline design
reference: a page head, a 2×2 grid of stat cards (with sparklines + deltas), and a redesigned
roster table with avatars, presence dots, per-member focus sparkline, and a "View" action.
Continues the app-shell/auth redesign (icon-rail sidebar + topbar) from the prior commits.

## Change
- `apps/web-admin/src/pages/Dashboard.tsx` — rebuilt the presentation. **All existing logic
  preserved**: `reportEmployees` fetch, loading/error/empty/no-business states, self detection
  (`role === "owner" || id === user.id`), i18n, member terminology, navigation to
  `/employees/:id`. New markup: `.ad-pagehead`, `.ad-stats` (4 stat cards), `.ad-tablecard`
  roster table.
- `apps/web-admin/src/components/Sparkline.tsx` — **new** presentational SVG sparkline
  (Catmull-Rom → cubic bézier, soft gradient fill, end dot).
- `apps/web-admin/src/theme/theme.css` — added semantic + data-viz tokens
  (`--positive/-soft`, `--negative/-soft`, `--info/-soft`, `--data-sky/mint/amber/rose`) for
  both light & dark; presence-dot variants `--idle`/`--offline`; and the dashboard component
  styles (`.ad-h1/.ad-sub`, `.bibo-card(--focal)`, `.bibo-stat*`, `.ad-table` + row bits).
- i18n: added `statRecorded/statActive/statFocus/statScreenshots/vsYesterday/ofMembers/
  todayLabel` and `table.focus` to the `dashboard` namespace across **all 7 locales**
  (en, vi, zh, ja, id, fr, es).

Display-only helper `fmtClock` (`H:MM`, e.g. `7:27`) is local to the page — the shared
`fmtDuration` (`7h 27m`) is untouched.

## Real vs placeholder data
The design shows metrics the report API (`ReportEmployee`) does not yet expose. Per product
decision ("build full UI now, wire real API later"):
- **Real:** recorded-today total (Σ `active_today_s`), active N/M (presence from `last_seen`),
  roster name/login/last-seen/active-today, presence dot.
- **PLACEHOLDER** (deterministic, seeded from id — marked in code): per-member focus %,
  avg-focus card, screenshots card, sparkline series, and the +Δ deltas.

## Follow-up (separate backend ticket)
Extend `/v1/reports/employees` (or a new dashboard summary endpoint) to return: per-member
focus %, activity trend series, today's screenshot count, and day-over-day deltas — then
replace the placeholders in `Dashboard.tsx`.

## Verify
- `tsc --noEmit` clean; `vite build` succeeds.
- Visual review (interactive): `./scripts/dev-webadmin.sh` → http://localhost:5174/admin,
  light & dark.
