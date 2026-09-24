// Auto-update via Tauri's updater plugin. Checks our signed manifest
// (our production server's /download/latest.json); on a newer version it downloads
// and installs the signed artifact, then restarts the app. Signature is verified
// against the public key baked into tauri.conf.json — an unsigned/tampered
// artifact is rejected.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { log } from "./log";

export type UpdateProgress =
  | { state: "checking" }
  | { state: "uptodate" }
  | { state: "available"; version: string }
  | { state: "downloading"; pct: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

// We check on launch, on focus, and periodically (App.tsx). These guards skip
// overlapping checks and rate-limit the network call.
let inFlight = false;
let stagedVersion: string | null = null;
let lastCheckAt = 0;
export const CHECK_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Download + stage an update, reporting progress.
 *
 * Keep download and install separate so progress and errors are observable.
 */
async function downloadUpdate(update: Update, onProgress?: (p: UpdateProgress) => void): Promise<void> {
  let total = 0;
  let got = 0;
  onProgress?.({ state: "downloading", pct: 0 });
  await update.download((ev) => {
    switch (ev.event) {
      case "Started":
        total = ev.data.contentLength ?? 0;
        break;
      case "Progress":
        got += ev.data.chunkLength;
        onProgress?.({ state: "downloading", pct: total ? Math.round((got / total) * 100) : 0 });
        break;
      case "Finished":
        onProgress?.({ state: "ready", version: update.version });
        break;
    }
  });
  stagedVersion = update.version;
  log.info("update downloaded; installing", { version: update.version });
}

async function installUpdate(update: Update): Promise<void> {
  log.info("installing signed update", { version: update.version });
  // On Windows the configured quiet NSIS installer replaces the app and its
  // sidecar; on macOS install unpacks the app before the explicit relaunch.
  await update.install();
  await relaunch();
}

/**
 * Manual "Check for updates" (Settings). Reports each phase via onProgress; on a newer
 * version it downloads, installs, and restarts. Returns true if installed.
 */
export async function checkForUpdates(onProgress?: (p: UpdateProgress) => void): Promise<boolean> {
  if (inFlight) return false;
  inFlight = true;
  try {
    onProgress?.({ state: "checking" });
    const update = await check();
    if (!update) {
      onProgress?.({ state: "uptodate" });
      return false;
    }
    onProgress?.({ state: "available", version: update.version });
    await downloadUpdate(update, onProgress);
    await installUpdate(update);
    return true;
  } catch (e) {
    stagedVersion = null;
    log.warn("update check failed", { err: String(e) });
    onProgress?.({ state: "error", message: String(e) });
    return false;
  } finally {
    inFlight = false;
  }
}

/**
 * Background check used on launch, focus, and the periodic timer. The signed
 * update is installed directly, so each employee does not need to operate the
 * updater on their own machine.
 */
export async function autoCheckAndInstall(): Promise<void> {
  if (inFlight || stagedVersion) return;
  const now = Date.now();
  if (now - lastCheckAt < CHECK_THROTTLE_MS) return;
  lastCheckAt = now;
  await checkForUpdates();
}
