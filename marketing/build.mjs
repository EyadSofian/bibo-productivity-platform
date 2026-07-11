#!/usr/bin/env node
// Static i18n generator for the marketing site.
// Renders template.html + i18n/<code>.json into per-locale pages with hreflang/SEO,
// targeting one of the deploy environments (absolute URLs + analytics differ per env):
//   en  -> <out>/index.html        (root)
//   xx  -> <out>/<seg>/index.html  (e.g. /zh/, /ja/)
//
// Run:
//   node marketing/build.mjs                 # staging (default) -> marketing/site/
//   node marketing/build.mjs staging         # same as above
//   node marketing/build.mjs production       # production       -> marketing/site-prod/
//
// Env overrides (rarely needed): SITE_ENV, SITE_BASE_URL, SITE_GA_ID, SITE_OUT.
//
// Note: the in-page language switcher uses ROOT-RELATIVE links (/, /zh/, …) so it works
// on whatever host serves the files. Only SEO-facing URLs (canonical, og:url, hreflang,
// JSON-LD, sitemap) are absolute and therefore environment-specific.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src"); // template + i18n sources (not served)

// Per-environment build config. `out` is the generated, servable output dir.
//  - default keeps the committed marketing/site/ (no analytics — avoids polluting GA).
//  - production renders to marketing/site-prod/ (gitignored, built at deploy time).
// For a private pre-prod host, don't hard-code it here — override at build time:
//   SITE_BASE_URL=https://your-host SITE_OUT=site node marketing/build.mjs
const ENVS = {
  default: {
    base: "https://bibotracker.com",
    ga: "", // no Google Analytics on the committed default build
    out: "site",
  },
  production: {
    base: "https://bibotracker.com",
    ga: "G-EKVNL0JY98",
    out: "site-prod",
  },
  staging: {
    base: "https://employeetracking.namnguyen.pro",
    ga: "",
    out: "site-staging",
    noindex: true, // staging must never be crawled/indexed
  },
};

const ENV_NAME = (process.argv[2] || process.env.SITE_ENV || "default").toLowerCase();
if (!ENVS[ENV_NAME]) {
  throw new Error(`unknown env "${ENV_NAME}" — expected one of: ${Object.keys(ENVS).join(", ")}`);
}
const ENV = ENVS[ENV_NAME];
const BASE = process.env.SITE_BASE_URL || ENV.base;
const GA_ID = process.env.SITE_GA_ID ?? ENV.ga;
const SITE = join(ROOT, process.env.SITE_OUT || ENV.out);
const HOST = BASE.replace(/^https?:\/\//, ""); // bare host for the demo browser-bar mockup

// locale code -> { seg: URL path segment ("" = root), bcp47: <html lang>, og: og:locale,
//                  label: native name, flag: emoji shown in the language switcher }
const LOCALES = {
  en: { seg: "", bcp47: "en", og: "en_US", label: "English", flag: "🇺🇸" },
  zh: { seg: "zh", bcp47: "zh-Hans", og: "zh_CN", label: "中文", flag: "🇨🇳" },
  ja: { seg: "ja", bcp47: "ja", og: "ja_JP", label: "日本語", flag: "🇯🇵" },
  vi: { seg: "vi", bcp47: "vi", og: "vi_VN", label: "Tiếng Việt", flag: "🇻🇳" },
  id: { seg: "id", bcp47: "id", og: "id_ID", label: "Bahasa Indonesia", flag: "🇮🇩" },
  fr: { seg: "fr", bcp47: "fr", og: "fr_FR", label: "Français", flag: "🇫🇷" },
  es: { seg: "es", bcp47: "es", og: "es_ES", label: "Español", flag: "🇪🇸" },
};

// Absolute URL (SEO: canonical, og, hreflang, sitemap).
const urlFor = (code) => `${BASE}/${LOCALES[code].seg ? LOCALES[code].seg + "/" : ""}`;
// Root-relative URL (in-page language switcher — host-agnostic).
const relUrlFor = (code) => `/${LOCALES[code].seg ? LOCALES[code].seg + "/" : ""}`;

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

// hreflang alternates + x-default, for the <head>. Absolute by spec. (Canonical is the
// template's own line, rewritten per-locale in step 3 — so we don't emit a duplicate here.)
function headAlts() {
  const lines = [];
  for (const c of Object.keys(LOCALES)) {
    lines.push(`<link rel="alternate" hreflang="${LOCALES[c].bcp47}" href="${urlFor(c)}" />`);
  }
  lines.push(`<link rel="alternate" hreflang="x-default" href="${urlFor("en")}" />`);
  return lines.join("\n  ");
}

// Language switcher: the trigger shows the CURRENT locale's flag + native name; the dropdown
// lists every locale with its flag. Plain ROOT-RELATIVE links — no JS, SEO-friendly, and
// host-agnostic so the same markup works on staging and production. Opens on hover or focus
// (keyboard / touch via tabindex + :focus-within in styles.css).
function langSwitcher(code) {
  const check = `<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  const items = Object.keys(LOCALES)
    .map((c) => {
      const cur = c === code ? ' aria-current="true"' : "";
      return `<a class="lang-opt" href="${relUrlFor(c)}" data-loc="${c}"${cur}>${LOCALES[c].label}${check}</a>`;
    })
    .join("");
  const globe = `<svg class="lang-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;
  return (
    `<div class="lang-switcher" aria-label="Language" tabindex="0">` +
    globe +
    `<span class="lang-label">${code.toUpperCase()}</span>` +
    `<svg class="lang-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>` +
    `<div class="lang-menu">${items}</div></div>`
  );
}

// Auto language detection. Emitted into <head> of the ENGLISH ROOT page only: on first
// visit (no stored choice) it matches the browser's preferred languages against the
// localized pages and redirects there; an explicit "en" preference (or any earlier "en"
// in the language list) stays on English. Localized pages get NO redirect — landing on
// /zh/ etc. is already an explicit choice and crawlers must not be bounced.
function autoDetect(code) {
  if (code !== "en") return "";
  const seg = Object.keys(LOCALES).filter((c) => c !== "en"); // redirect targets
  const set = JSON.stringify(Object.fromEntries(seg.map((c) => [c, 1])));
  return (
    `<script>(function(){try{` +
    `var S=${set},saved=localStorage.getItem('locale'),t=null;` +
    `if(saved){if(saved!=='en'&&S[saved])t=saved;}` +
    `else{var L=navigator.languages||[navigator.language||''];` +
    `for(var i=0;i<L.length;i++){var b=(L[i]||'').toLowerCase().split('-')[0];` +
    `if(b==='en')break;if(b==='in')b='id';if(S[b]){t=b;break;}}}` +
    `if(t)location.replace('/'+t+'/');}catch(e){}})();</script>`
  );
}

// Language switcher behaviour + locale hand-off (emitted on every page, baked with the
// page's own locale code):
//  - click/tap the trigger to toggle the menu open (CSS-only :hover broke on touch and
//    left a hover-gap on desktop where the menu closed before you could reach an option);
//  - clicking outside closes it;
//  - clicking a language option stores the pick so the root-page auto-detect honours it;
//  - clicking through to the admin app (sign in / sign up) writes the current page's
//    language to localStorage so web-admin (same origin, same 'locale' key) opens in it.
const localeJs = (code) =>
  `<script>(function(){try{var P=${JSON.stringify(code)};` +
  `document.addEventListener('click',function(e){var a=e.target.closest('a[href^="/admin"]');` +
  `if(a){try{localStorage.setItem('locale',P);}catch(_){}}});` +
  `var sw=document.querySelector('.lang-switcher');if(!sw)return;` +
  `sw.addEventListener('click',function(e){var o=e.target.closest('.lang-opt');` +
  `if(o){try{localStorage.setItem('locale',o.getAttribute('data-loc'));}catch(_){}return;}` +
  `e.preventDefault();sw.classList.toggle('open');});` +
  `document.addEventListener('click',function(e){if(!sw.contains(e.target))sw.classList.remove('open');});` +
  `}catch(e){}})();</script>`;

// Analytics block injected into <head> (empty when no GA id is configured, e.g. staging).
function analytics() {
  if (!GA_ID) return "";
  return `
  <link rel="preconnect" href="https://www.googletagmanager.com" />
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());

    gtag('config', '${GA_ID}');
  </script>`;
}

const template = readFileSync(join(SRC, "template.html"), "utf8");

// Cache-buster for the stylesheet: use its mtime so every edit forces browsers to
// reload styles.css instead of serving a stale cached copy.
let cssV = "1";
try { cssV = String(Math.floor(statSync(join(SITE, "styles.css")).mtimeMs)); } catch (_) {}

for (const code of Object.keys(LOCALES)) {
  const strings = flatten(JSON.parse(readFileSync(join(SRC, "i18n", `${code}.json`), "utf8")));
  let html = template;

  // 1) content placeholders
  for (const [key, val] of Object.entries(strings)) {
    html = html.split(`{{${key}}}`).join(val);
  }
  // Staging: swap the indexing meta for noindex so crawlers never index this host.
  if (ENV.noindex) {
    html = html.replace('content="index, follow, max-image-preview:large"', 'content="noindex, nofollow"');
  }
  // 2) build placeholders
  html = html
    .split("{{__lang}}").join(LOCALES[code].bcp47)
    .split("{{__base}}").join(BASE)
    .split("{{__host}}").join(HOST)
    .split("{{__analytics}}").join(analytics())
    .split("{{__autodetect}}").join(autoDetect(code))
    .split("{{__locale_js}}").join(localeJs(code))
    .split("{{__head_alts}}").join(headAlts())
    .split("{{__lang_switcher}}").join(langSwitcher(code))
    .split('href="/styles.css"').join(`href="/styles.css?v=${cssV}"`);

  // 3) per-locale canonical/og:url/JSON-LD url + og:locale. Targeted replacements
  // (NOT a blanket BASE-url swap, which would also clobber the hreflang alternates).
  if (code !== "en") {
    const u = urlFor(code);
    html = html
      .replace(`<link rel="canonical" href="${BASE}/" />`, `<link rel="canonical" href="${u}" />`)
      .replace(`property="og:url" content="${BASE}/"`, `property="og:url" content="${u}"`)
      .replace(`"url": "${BASE}/"`, `"url": "${u}"`)
      .split('content="en_US"').join(`content="${LOCALES[code].og}"`);
  }

  // 4) safety: no unresolved placeholders
  const leftover = html.match(/\{\{[^}]+\}\}/g);
  if (leftover) throw new Error(`[${code}] unresolved placeholders: ${[...new Set(leftover)].join(", ")}`);

  const outPath = code === "en" ? join(SITE, "index.html") : join(SITE, code, "index.html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  console.log(`✓ ${code.padEnd(3)} → ${outPath.replace(SITE + "/", ENV.out + "/")}`);
}

// sitemap.xml with hreflang alternates for every locale URL.
const lastmod = new Date().toISOString().slice(0, 10);
const altLinks = [...Object.keys(LOCALES), "x-default"]
  .map((c) => {
    const hl = c === "x-default" ? "x-default" : LOCALES[c].bcp47;
    const href = c === "x-default" ? urlFor("en") : urlFor(c);
    return `      <xhtml:link rel="alternate" hreflang="${hl}" href="${href}" />`;
  })
  .join("\n");
const urls = Object.keys(LOCALES)
  .map(
    (c) => `  <url>
    <loc>${urlFor(c)}</loc>
${altLinks}
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${c === "en" ? "1.0" : "0.9"}</priority>
  </url>`,
  )
  .join("\n");
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
writeFileSync(join(SITE, "sitemap.xml"), sitemap, "utf8");
console.log("✓ sitemap.xml");

// robots.txt — welcomes search + AI crawlers on prod; staging blocks everything.
const robots = ENV.noindex
  ? `# Staging environment — do not crawl or index.
User-agent: *
Disallow: /
`
  : `# Search engines and AI / answer-engine crawlers are welcome to crawl and cite
# this site. (Note: if Cloudflare "Block AI bots" / AI Crawl Control is enabled,
# it overrides this file and blocks AI crawlers at the edge — disable it there.)
User-agent: *
Allow: /
Disallow: /admin
Disallow: /download/

# Explicitly welcome AI assistants / answer engines
User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: meta-externalagent
Allow: /

Sitemap: ${BASE}/sitemap.xml
`;
writeFileSync(join(SITE, "robots.txt"), robots, "utf8");
console.log("✓ robots.txt");

console.log(`done. (env=${ENV_NAME}, base=${BASE}, ga=${GA_ID || "none"}, out=${ENV.out}/)`);
