# BiBoTracking — Design System brief

Prompt for generating the shared design system that all three surfaces
([marketing](marketing.md), [admin](admin.md), [desktop](desktop.md)) adopt.

---

Create a complete **design system** for **BiBoTracking** — a privacy-first, local-first,
self-hostable time & activity tracking product (an open-source Hubstaff alternative). It
spans three surfaces that must feel like one family: a **marketing landing page**, a
**React web-admin dashboard**, and a **Tauri desktop app**. It serves Solo, Team
(employees), and Family (kids) personas, supports **light and dark modes**, and must work
in 7 locales (en, zh, ja, vi, id, fr, es) — so nothing can depend on fixed text lengths.

## Aesthetic to target — soft, premium glassmorphism
- Subtle blue-grey gradient background; frosted/translucent panels that float above it.
- Large rounded corners (~20px), soft diffuse drop shadows, generous whitespace.
- One **near-black focal card** to mark the active/selected item amid light cards (use
  sparingly).
- Light lavender-white surfaces with **pastel data accents** — lavender, mint green,
  coral/red, sky blue. Green = positive, coral/red = negative, applied to **data only**,
  never to chrome.
- Smooth curved line/area charts with glowing node dots and small dark tooltip bubbles;
  thin gradient progress bars; multi-color donut/radial rings with a big centered number;
  tiny inline **sparklines**.
- Pill **segmented toggles**, rounded pill search/fields, soft circular icon buttons, slim
  icon-only left nav rail.
- Bold near-black headlines, light grey muted secondary text, prominent numbers with small
  muted labels. Clean sans-serif. Color reserved for data.

## Tone
Transparent, calm, trustworthy — the product watches people's screens/keystrokes/browsing,
so it must feel honest, not surveillance-creepy.

## Deliver the system as a style guide, not just screens. Define:

1. **Color** — full palette with hex for light + dark mode: backgrounds/gradients,
   surface/glass layers, text (primary/secondary/muted), borders, the dark focal card, and
   a semantic scale (success/positive-green, danger/negative-coral, warning-amber,
   info-blue) plus the pastel data-viz palette. Note contrast/accessibility (WCAG AA).
2. **Typography** — font family choice, type scale (display → caption) with
   size/weight/line-height, and usage rules.
3. **Spacing, radius, elevation** — spacing scale, corner-radius tokens, and a shadow/blur
   scale for the frosted/glass elevation system.
4. **Components** — designed in all relevant states (default/hover/active/disabled/focus,
   plus loading/empty/error where applicable): buttons (primary/secondary/ghost/icon),
   inputs/search, switches/toggles (incl. a **locked/org-managed** state), segmented
   controls, dropdowns/selects, cards (incl. stat card + the dark focal variant), data
   tables, badges/status pills (green/amber/coral tracking states), tabs, modals/confirm
   dialogs, nav rail + sidebar, top header bar, language switcher, theme toggle, and the
   chart family (line/area, bar, donut, progress bar, sparkline) with tooltip styling.
5. **Design tokens** — express everything as named tokens (Tailwind-style) so it maps
   cleanly to React + Tailwind code; include the light/dark token mapping.

## Presentation
Present it as: a foundations page (color/type/spacing/elevation), then a component sheet,
then 1–2 example screens (a dashboard + a settings page) showing the system composed
together — in **both light and dark**. Use realistic placeholder data (durations, app
names, percentages).
