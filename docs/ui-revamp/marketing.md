# BiBoTracking — Marketing Home Page UI revamp brief

Static landing page served at `/` (bibotracker.com). Generated from
`marketing/src/template.html` + per-locale JSON (do not hand-edit `marketing/site`).
Light theme primary; consider dark accents. Must tolerate 7 locales (en, zh, ja, vi, id,
fr, es) — flexible text lengths, no fixed-width labels. Brand word "BiBoTracking" stays
verbatim in all locales.

Positioning: privacy-first, local-first, self-hostable, open-source **Hubstaff
alternative** for Solo / Team / Family. Tone: trustworthy and calm, not surveillance-creepy.

---

## Visual direction (apply across the whole page)

Inspired by a soft, premium **glassmorphism** crypto-dashboard look. Same language as the
admin and desktop surfaces so the product feels like one family. The hero/showcase
mockups should literally echo this dashboard aesthetic.

- **Background:** subtle blue-grey gradient, not flat white. Frosted/translucent panels
  and cards appear to float above it.
- **Cards:** large rounded corners (~20px radius), soft diffuse drop shadows, generous
  whitespace between sections.
- **Hero accent:** one **near-black dark card/mockup** as the focal element against the
  light layout; gradient-accented headline text.
- **Palette:** light lavender-white surfaces + pastel accents — lavender, mint green,
  coral/red, sky blue. Green = positive, coral/red = negative, used only on data
  (stats, comparison checks, mini-charts).
- **Data viz in mockups:** smooth curved line charts with glowing nodes + dark tooltip
  bubbles, thin gradient progress bars, multi-color donut rings with a big centered
  number, tiny inline **sparklines** on stat cards. Use these in the hero dashboard
  screenshot and the showcase gallery.
- **Controls:** pill **segmented toggles** (the Demo/Showcase tabs), rounded pill buttons,
  soft circular icon buttons, pill language switcher.
- **Typography:** bold near-black headlines with light grey muted body, prominent numbers,
  small muted labels. Clean sans-serif. Color reserved for data only.

---

## Sections (in order)

### 1. Navigation header
- Brand logo + site name (→ #top).
- Nav links: Personas, Features, Demo, How it works, Compare, Pricing.
- Language switcher.
- Buttons: Sign in (→ /admin), Sign up (→ /admin/signup), GitHub link.

### 2. Hero
- Headline with gradient accent + lede copy.
- CTAs: Download macOS DMG, Download Windows MSI, Add Chrome Extension, Sign up.
- Hero badge: "Active today" stat (example time).
- Dashboard screenshot mockup.

### 3. Stats strip
Four stat cards: **4 signals**, **100% local**, **<50KB screenshots**,
**0 keystrokes tracked**.

### 4. Personas
Three cards: **Solo** (🧍), **Team** (👥), **Family** (👨‍👩‍👧). Each with use-case
description + tag.

### 5. Features
Six feature cards with icons: Time tracking, Keyboard activity, Screenshots, Browser
history, Privacy-first, Menu bar.

### 6. Demo
Tabbed demo videos: **Desktop app** tab and **Web admin** tab (video + caption each).

### 7. How it works
Three numbered steps: (1) Download & install desktop app, (2) Get Chrome extension (with
link), (3) View reports in web admin.

### 8. Showcase / screenshots
Tabbed gallery of real UI screenshots with lightbox/zoom:
- **Desktop tab**: Activity, Screenshots, Browser, Settings.
- **Web tab**: Dashboard, Employee roster, Keystrokes report, Screenshots report.

### 9. Comparison table
**BiBoTracking vs Hubstaff** — rows: Price, OSS, Self-host, Local mode, App time,
Screenshots, Activity, Browser, Dashboard, Per-seat pricing. Checkmarks / X's.

### 10. Privacy
Four benefit cards: No keystroke logging, Local processing, Domain-only URLs, Retention
controls.

### 11. Pricing
Two tiers: **Free** ($0/mo, local-only app) and **Paid** ($1/mo, team/family accounts).

### 12. Open source
Three benefit cards: Self-hostable, Inspect the code, No vendor lock-in. CTA: View on
GitHub.

### 13. Final CTA
"Get started" section with download + extension + sign-up buttons.

### 14. Footer
Links: Downloads (macOS / Windows), Chrome, Sign in, Pricing, OSS, GitHub, Privacy,
Telegram, Contact email.

---

## Interactive elements
- Tab switching: Demo videos (desktop/web) and Showcase screenshots (desktop/web).
- Image lightbox/zoom on screenshot cards.
- Scroll-reveal animations.
- Language switcher in header.

## Shared components to design
Nav bar + language switcher, gradient hero, stat cards, persona cards, feature cards,
tabbed video/screenshot galleries with lightbox, numbered step list, comparison table,
pricing cards, CTA buttons, footer.
