# 142 — BiBoTracker rename: Windows installer duplicate-install risk

**Status:** OPEN — must be resolved before the next Windows release.
**Context:** App display name is being renamed `employeetrack` → `BiBoTracker`
(`productName` in `apps/desktop/src-tauri/tauri.conf.json`; bundle id
`com.briannguyen.bibotracking` stays the same). macOS side is done and safe
(1.5.0 renamed DMG already live on the website; OTA replaces app contents in
place, so existing mac users are unaffected). **Windows has NOT been built with
the new name yet** — 1.5.0 Windows (MSI + NSIS OTA) shipped under the old name.

## The problem

Both Windows bundle types identify "the same app" via `productName`:

1. **MSI (WiX):** Tauri generates the MSI *upgrade code* (the GUID that tells
   Windows "this is the same product, do an upgrade") by **hashing
   `productName`**. Rename → new GUID → Windows treats the new MSI as an
   unrelated program → installs alongside the old one. User gets two entries in
   Add/Remove Programs, two install dirs, two tray apps.

2. **NSIS (the silent OTA channel):** the updater installer finds the previous
   install via a registry uninstall key + default install dir derived from
   `productName`. After the rename it looks for "BiBoTracker", finds nothing,
   and fresh-installs to a new folder. The old `employeetrack` app stays
   installed, keeps running, AND — because it is still an old version — keeps
   seeing "update available" and re-runs the installer on every launch. Never
   cleans itself up. Both apps may track and double-report.

New users are fine in all cases; only existing installs are at risk.

## The fix (before next Windows build)

1. **Pin the MSI upgrade code:** set `bundle > windows > wix > upgradeCode` in
   `tauri.conf.json` to the GUID the *current* name ("employeetrack") hashes
   to, so it stays constant across the rename. Recover the current GUID from an
   existing MSI (e.g. `msiinfo` / PowerShell `Get-MSIProperty` on
   `employeetrack_1.5.0_x64_en-US.msi`) or from Tauri's hash function.
2. **NSIS caveat:** the upgradeCode pin is MSI-only — NSIS still keys off the
   product-name registry entry. The OTA duplicate risk may remain even with the
   pin. **Smoke test on winbuild:** install old-name 1.5.0, point it at a
   renamed test build, observe whether the update replaces or duplicates.
3. If NSIS duplicates: add a migration step to the renamed installer (NSIS
   hook) that finds and uninstalls the old "employeetrack" uninstall entry
   first.
4. Only then ship the renamed Windows release (both MSI website download and
   NSIS OTA), same version bump as the mac rename release.

## Related state (as of 2026-07-11)

- `productName: "BiBoTracker"` change is **uncommitted** on `release/v1.5.0`.
- Website mac DMG = renamed 1.5.0 (notarized, BiBoTracker.app inside, still
  served as `EmployeeTracker-macOS.dmg`). mac OTA tarball = old-name 1.5.0.
- Public download filenames (`EmployeeTracker-*`) + `latest.json` URLs +
  marketing links rename is a separate, optional step of the rebrand.
- mac quirk (cosmetic only): existing users keep folder name
  `/Applications/employeetrack.app` after OTA; display name changes to
  BiBoTracker once they receive a renamed build.
