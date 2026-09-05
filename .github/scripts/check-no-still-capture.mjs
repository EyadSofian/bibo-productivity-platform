#!/usr/bin/env node
/**
 * Video-first guard (docs/adr/0002-video-first-media-plane.md).
 *
 * Screen monitoring is video. Still images are no longer a monitoring artifact,
 * and the decision has to be enforced by the build rather than by memory: the
 * failure mode it protects against is somebody re-adding an image path months
 * from now, in good faith, because nothing said no.
 *
 * Three checks, each narrow enough to be actionable:
 *
 *   1. LEGACY_STILL_CAPTURE_ENABLED is never committed as true. It is a
 *      short-lived migration switch set on a deployment, never in the repo.
 *   2. Image content types appear only in the legacy files that slice V12
 *      deletes. Anywhere else means a new still-image path was introduced.
 *   3. The live/session/moments components render <video>, never <img>. Those
 *      files do not all exist yet; the guard is deliberately forward-looking so
 *      it fires the first time one of them is written the wrong way.
 *
 * This guard is about the monitoring data plane. Static UI assets -- the logo,
 * icons, the marketing site -- are not monitoring artifacts and are not checked.
 *
 * Usage: node .github/scripts/check-no-still-capture.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** Directories that never contain product source. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "target", "dist", "build", "gen", "icons", "assets",
  "public", "site", "logs", "storage", ".vscode",
]);

const SOURCE_EXT = /\.(go|rs|ts|tsx|js|mjs|jsx|sql|toml|yml|yaml|env|example)$/;

/**
 * Files that legitimately still mention image content types: the retired
 * pipeline itself, plus the audit and decision documents that describe it.
 * Every entry here is deleted or rewritten in slice V12; the list must only
 * ever shrink.
 */
const LEGACY_IMAGE_PATHS = new Set([
  "apps/backend/internal/handlers/screenshot.go",
  "apps/backend/internal/handlers/live_view.go",
  "apps/backend/internal/handlers/remote_assist.go",
  "apps/backend/internal/handlers/reports.go",
  "apps/backend/internal/filestore/filestore.go",
  "apps/backend/internal/db/migrations/00018_remote_assist.sql",
  "apps/desktop/src-tauri/src/sync/client.rs",
  "apps/web-admin/src/pages/EmployeeDetail.tsx",
  "apps/web-admin/src/api/client.ts",
  "apps/web-admin/src/api/liveFrames.test.ts",
  "apps/backend/internal/handlers/legacy_capture_test.go",
  // The ADR 0001 measurement harness. It reproduces the old bytea frame path in
  // order to measure it, and is retired with that path in V12.
  "scripts/measure-live-frame-cost.go",
]);

/**
 * Components that present live or recorded screen media. They must bind a
 * MediaStream or a video source to <video>; an <img> here is the exact
 * regression this project spent V01 measuring.
 */
const VIDEO_ONLY_COMPONENTS = [
  "apps/web-admin/src/components/LivePlayer",
  "apps/web-admin/src/components/SessionPlayer",
  "apps/web-admin/src/components/VideoMoments",
  "apps/web-admin/src/pages/LiveMonitor",
  "apps/web-admin/src/pages/SessionRecordings",
  "apps/web-admin/src/pages/VideoMoments",
  // The transport layer produces MediaStreams. An image anywhere in it means
  // something is being reconstructed from pictures again.
  "apps/web-admin/src/media",
];

const IMAGE_CONTENT_TYPE = /image\/(jpeg|jpg|png|webp)/;
const IMG_TAG = /<img[\s>]/;

/**
 * Lines that are entirely a comment.
 *
 * Documenting the rule is not breaking it: the files this guard protects
 * explain, in prose, that they must not use <img>, and a naive scan flags that
 * explanation as the violation it warns against. Skipping comment lines is what
 * lets the code say why the rule exists.
 */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|<!--|--\s|#)/;
const LEGACY_FLAG_TRUE = /LEGACY_STILL_CAPTURE_ENABLED\s*[:=]\s*["']?(true|1|yes|on)["']?/i;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // a symlink that dangles is not our problem
    }
    // Dot-DIRECTORIES are tooling (.git, .github is walked explicitly below via
    // its own files). Dot-FILES are not skipped: .env.example is exactly the
    // kind of committed file that could carry the migration flag.
    if (st.isDirectory()) {
      if (entry.startsWith(".") && entry !== ".github") continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

const failures = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (!SOURCE_EXT.test(rel)) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  // 1. The migration switch must never ship enabled.
  //    The guard script itself names the pattern, so skip it.
  if (!rel.endsWith("check-no-still-capture.mjs")) {
    for (const [i, line] of text.split("\n").entries()) {
      if (LEGACY_FLAG_TRUE.test(line)) {
        failures.push(
          `${rel}:${i + 1}: LEGACY_STILL_CAPTURE_ENABLED is committed as enabled.\n` +
            `    It is a deployment-only migration switch. Set it on the deployment, never in the repo.`,
        );
      }
    }
  }

  // 2. Image content types only in the retired pipeline.
  if (!LEGACY_IMAGE_PATHS.has(rel)) {
    for (const [i, line] of text.split("\n").entries()) {
      if (COMMENT_LINE.test(line)) continue;
      if (IMAGE_CONTENT_TYPE.test(line)) {
        failures.push(
          `${rel}:${i + 1}: image content type on a non-legacy path.\n` +
            `    ${line.trim()}\n` +
            `    Screen monitoring is video (docs/adr/0002-video-first-media-plane.md).`,
        );
      }
    }
  }

  // 3. Media components render <video>, not <img>.
  if (VIDEO_ONLY_COMPONENTS.some((prefix) => rel.startsWith(prefix))) {
    for (const [i, line] of text.split("\n").entries()) {
      if (COMMENT_LINE.test(line)) continue;
      if (IMG_TAG.test(line)) {
        failures.push(
          `${rel}:${i + 1}: <img> in a screen-media component.\n` +
            `    Bind a MediaStream or a signed video source to <video> instead.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("✗ video-first guard failed:\n");
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    `${failures.length} violation(s). See docs/adr/0002-video-first-media-plane.md.`,
  );
  process.exit(1);
}

console.log(
  `✓ video-first guard: no committed legacy flag, no new image paths, ` +
    `${VIDEO_ONLY_COMPONENTS.length} media components checked`,
);
