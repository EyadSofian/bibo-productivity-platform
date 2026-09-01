#!/usr/bin/env node
/**
 * Ticket 144 — stop still capture.
 *
 * Static guard that fails CI when *new* still-image capture is introduced.
 *
 * The video-first media plane forbids screenshots, JPEG/WebP/PNG frames and
 * SSE image streams. Live view must be WebRTC into a <video> element, and
 * history must be HLS/fMP4 segments — never stored images.
 *
 * This guard is intentionally allow-listed rather than absolute: per V12 the
 * legacy screenshot pipeline is NOT deleted automatically. Existing offenders
 * are pinned in LEGACY below with the ticket that removes them. Anything not
 * pinned is a new violation and fails the build.
 *
 * Usage:
 *   node .github/scripts/check-no-still-capture.mjs
 *   node .github/scripts/check-no-still-capture.mjs --json
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const JSON_OUT = process.argv.includes("--json");

/** Directories never scanned. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "out", ".next",
  "coverage", ".turbo", ".vite", "gen", "vendor",
]);

/** Only these extensions carry logic worth scanning. */
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".sql", ".cpp", ".h"]);

/**
 * Rules. `scope` optionally restricts a rule to paths matching a regex, which
 * keeps asset imports (logos, tray icons, marketing art) out of the results.
 */
const RULES = [
  {
    id: "image-encode",
    why: "encodes a still frame to an image codec; frames must be encoded as H.264/HLS video instead",
    pattern:
      /\bwebp::Encoder\b|\bimage::codecs::(?:jpeg|png|webp)\b|\bcompress_to_webp\b|\bjpeg\.Encode\b|\bpng\.Encode\b|\bwebp\.Encode\b|\bWebPEncode\w*\s*\(/,
  },
  {
    id: "canvas-frame-grab",
    why: "extracts a still frame from a canvas/video; the player must render live WebRTC into <video>",
    pattern: /\.toDataURL\s*\(|\.toBlob\s*\(|getImageData\s*\(\s*0\s*,\s*0/,
  },
  {
    id: "still-api-contract",
    why: "exposes a still-image field in an API contract; moments must return metadata + preview_at only",
    pattern: /\bpreview_image_url\b|\bpreviewImageUrl\b|\bscreenshot_url\b|\bscreenshotUrl\b|\bthumbnail_url\b/,
  },
  {
    id: "image-in-media-path",
    why: "writes an image extension inside the media/recording plane; only .m3u8/.m4s/.mp4 are allowed there",
    // Scoped: only new media/recording/live code, so legacy screenshot storage
    // and ordinary static assets elsewhere are not swept up.
    scope: /(^|\/)(media|recording|recordings|live|moments)(\/|$)/,
    pattern: /["'`][^"'`]*\.(?:jpe?g|png|webp|gif|bmp)["'`]/i,
  },
  {
    id: "still-object-key",
    why: "builds an object-storage key ending in an image extension; media storage may only hold .m3u8/.m4s/.mp4",
    // Deliberately narrow: only filename construction (`uuid + ".webp"`) and an
    // explicit screenshot storage prefix passed to a path-join. Bare "screenshot"
    // strings are log tags, table names and UI labels — not storage keys.
    pattern:
      /\+\s*["'`]\.(?:jpe?g|png|webp|gif)["'`]|(?:filepath\.Join|path\.join|PathBuf::from|Path::new)\s*\(\s*["'`]screenshots?["'`]/i,
  },
  {
    id: "sse-image-stream",
    why: "streams image frames over SSE/multipart; live view must use WebRTC",
    pattern: /multipart\/x-mixed-replace|text\/event-stream[\s\S]{0,200}?(?:image\/|base64,)/,
  },
  {
    id: "data-uri-image",
    why: "builds a base64 image data URI for display; live pixels must arrive as a WebRTC track",
    pattern: /data:image\/(?:webp|jpe?g|png|gif);base64/i,
  },
  {
    id: "image-frame-contract",
    why: "an API contract that carries still-image bytes; the media plane must exchange video tracks and HLS segments",
    pattern: /["'`]image\/(?:webp|jpe?g|png)["'`]|Content-Type["'`]?\s*[,:)]\s*["'`]image\//i,
  },
  {
    id: "img-frame-render",
    why: "renders a captured frame into <img>; the live player must render into <video autoplay playsInline muted>",
    // Only an <img> whose src is a frame/image variable — static logo and avatar
    // imports (src={logoDark}) do not match.
    pattern: /<img[^>]*\ssrc=\{[^}]*(?:frame|Frame|image|Image|snapshot|Snapshot|preview|Preview)[^}]*\}/,
  },
];

/**
 * Pre-existing offenders, pinned deliberately. Each entry must name the ticket
 * that removes it. Adding to this list requires review — it is the only way to
 * land still-capture code.
 */
const LEGACY = [
  // --- retained screenshot pipeline (monitoring evidence, ADR 0001 §Part 2) ---
  {
    file: "apps/desktop/src-tauri/src/trackers/mod.rs",
    rules: ["image-encode"],
    reason: "retained WebP screenshot pipeline (xcap + webp::Encoder); removed by ticket 144 once the media sidecar publishes video",
  },
  {
    file: "apps/backend/internal/filestore/filestore.go",
    rules: ["still-object-key"],
    reason: "screenshots/<business>/<user>/<date>/<uuid>.webp object path; removed by ticket 144 after the V12 inventory",
  },
  {
    file: "apps/backend/internal/handlers/reports.go",
    rules: ["image-frame-contract"],
    reason: "serves retained screenshots to the gallery; replaced by HLS/fMP4 moments in V09",
  },

  // --- ephemeral live-frame path (ADR 0001) — the direct migration target ---
  {
    file: "apps/backend/internal/handlers/live_view.go",
    rules: ["image-frame-contract"],
    reason: "ADR 0001 SSE live frames; superseded by the WebRTC media plane in V05/V06 (ADR 0002)",
  },
  {
    file: "apps/backend/internal/db/migrations/00018_remote_assist.sql",
    rules: ["image-frame-contract"],
    reason: "remote_assist_frames.mime_type CHECK; ADR 0001 already left this table empty, dropped in a later release",
  },
  {
    file: "apps/backend/internal/handlers/remote_assist.go",
    rules: ["image-frame-contract"],
    reason: "remote-assist frame upload/serve; becomes a WebRTC track + DataChannel in V07",
  },
  {
    file: "apps/desktop/src-tauri/src/sync/client.rs",
    rules: ["image-frame-contract"],
    reason: "agent uploads WebP frames over HTTP; replaced by the native media sidecar publishing to the SFU in V04",
  },

  {
    file: "scripts/measure-live-frame-cost.go",
    rules: ["image-frame-contract"],
    reason: "ADR 0001 WAL/TOAST measurement harness; retired with the frame path it measures",
  },

  // --- dashboard rendering — must become <video> ---
  {
    file: "apps/web-admin/src/pages/EmployeeDetail.tsx",
    rules: ["data-uri-image", "img-frame-render"],
    reason: "live view and remote assist render base64 WebP into <img>; replaced by the LivePlayer <video> element in V06",
  },
  {
    file: "apps/web-admin/src/components/reports/PlaybackPanel.tsx",
    rules: ["img-frame-render"],
    reason: "session playback renders stills into <img>; replaced by the HLS Session Player in V09",
  },
];

const legacyIndex = new Map(LEGACY.map((e) => [e.file, new Set(e.rules)]));

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot !== -1 && SCAN_EXT.has(entry.name.slice(dot))) acc.push(full);
    }
  }
  return acc;
}

const violations = [];
const usedLegacy = new Set();

for (const absolute of walk(ROOT)) {
  const rel = relative(ROOT, absolute).split(sep).join("/");
  if (rel.startsWith(".github/scripts/")) continue; // this guard names the patterns it bans

  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    continue;
  }

  for (const rule of RULES) {
    if (rule.scope && !rule.scope.test(rel)) continue;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!rule.pattern.test(lines[i])) continue;

      const pinned = legacyIndex.get(rel);
      if (pinned && pinned.has(rule.id)) {
        usedLegacy.add(`${rel}::${rule.id}`);
        continue;
      }
      violations.push({
        file: rel,
        line: i + 1,
        rule: rule.id,
        why: rule.why,
        snippet: lines[i].trim().slice(0, 160),
      });
    }
  }
}

// Allowlist entries that no longer match are stale — surface them so the list
// shrinks as the legacy pipeline is removed, instead of silently rotting.
const stale = [];
for (const entry of LEGACY) {
  for (const ruleId of entry.rules) {
    if (!usedLegacy.has(`${entry.file}::${ruleId}`)) {
      stale.push({ file: entry.file, rule: ruleId });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ violations, stale, ok: violations.length === 0 }, null, 2));
} else if (violations.length > 0) {
  console.error(`\n✖ still-capture guard: ${violations.length} new violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.why}`);
    console.error(`    > ${v.snippet}\n`);
  }
  console.error("Live view must be WebRTC into <video>; history must be HLS/fMP4 segments.");
  console.error("If this is pre-existing legacy code, pin it in LEGACY with the removing ticket.\n");
} else {
  console.log(`✔ still-capture guard: no new still capture (${LEGACY.length} legacy path(s) pinned)`);
  for (const entry of LEGACY) {
    console.log(`  · ${entry.file} — ${entry.rules.join(", ")}`);
  }
}

if (stale.length > 0) {
  console.warn("\n⚠ stale LEGACY entries (no longer match — remove them from the allowlist):");
  for (const s of stale) console.warn(`  · ${s.file} [${s.rule}]`);
}

process.exit(violations.length > 0 ? 1 : 0);
