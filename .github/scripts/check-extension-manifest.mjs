// Validates apps/extension/manifest.json. The extension has no build step, so a
// malformed or over-permissioned manifest would otherwise only surface at load
// time in a browser — or, worse, at Chrome Web Store review.
//
// Beyond "does it parse", this guards the extension's privacy posture: it may
// only ever talk to loopback, and may only hold the narrow permission set the
// visit tracker actually needs (see docs/SECURITY_REVIEW.md §3).

import { readFileSync } from "node:fs";

const PATH = "apps/extension/manifest.json";

// Exactly what background.js uses: tabs (visit tracking), storage (link +
// outbox), alarms (re-discovery / checkpoint). Anything else needs review.
const ALLOWED_PERMISSIONS = new Set(["tabs", "storage", "alarms"]);

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

let m;
try {
  m = JSON.parse(readFileSync(PATH, "utf8"));
} catch (e) {
  console.error(`✗ ${PATH}: ${e.message}`);
  process.exit(1);
}

check(m.manifest_version === 3, `manifest_version must be 3, got ${m.manifest_version}`);
check(typeof m.name === "string" && m.name.length > 0, "name is required");
check(/^\d+\.\d+(\.\d+)?(\.\d+)?$/.test(m.version ?? ""), `version must be dotted numeric, got ${JSON.stringify(m.version)}`);
check(typeof m.background?.service_worker === "string", "background.service_worker is required (MV3)");

// Privacy invariant: loopback only. A non-127.0.0.1 host permission would mean
// the extension could report browsing activity somewhere other than the local app.
const hosts = m.host_permissions ?? [];
check(hosts.length > 0, "host_permissions is required");
for (const h of hosts) {
  check(
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\*$/.test(h),
    `host_permissions must be loopback only — found ${JSON.stringify(h)}`,
  );
}

// Permission creep guard.
for (const p of m.permissions ?? []) {
  check(
    ALLOWED_PERMISSIONS.has(p),
    `unexpected permission ${JSON.stringify(p)} — if this is intentional, add it to ALLOWED_PERMISSIONS in ${import.meta.url.split("/").pop()} and note why in the PR`,
  );
}

// These would let the extension read page content, which it must never do.
for (const forbidden of ["content_scripts", "web_accessible_resources", "declarative_net_request"]) {
  check(!(forbidden in m), `${forbidden} must not be present — the extension must not read or modify page content`);
}

if (errors.length) {
  console.error(`✗ ${PATH} failed ${errors.length} check(s):`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}

console.log(`✓ ${PATH} OK — MV3, loopback-only, permissions [${(m.permissions ?? []).join(", ")}]`);
