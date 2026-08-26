#!/usr/bin/env node
/**
 * Locale catalog parity guard.
 *
 * A key present in en/ but absent from another locale does not fail anything at
 * runtime — i18next silently falls back to English, so the string just quietly
 * ships untranslated. This script is the only place that catches it.
 *
 * It covers both apps that have catalogs. web-admin also asserts parity from
 * its own Vitest suite; the desktop app has no test runner yet, so for that one
 * this script is the sole guard.
 *
 * Usage: node .github/scripts/check-locale-parity.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APPS = [
  { name: "web-admin", root: "apps/web-admin/src/i18n/locales" },
  { name: "desktop", root: "apps/desktop/src/i18n/locales" },
];

/** i18next appends these to select a plural form. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * Flatten to dotted paths, collapsing plural variants onto their stem. English
 * needs two forms and Arabic needs six, so comparing raw keys would report
 * drift where the catalogs are in fact correct.
 */
function keysOf(obj, prefix = "", out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keysOf(v, path, out);
    else out.add(path.replace(PLURAL_SUFFIX, ""));
  }
  return out;
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const problems = [];

for (const app of APPS) {
  if (!existsSync(app.root)) {
    problems.push(`${app.name}: no locales directory at ${app.root}`);
    continue;
  }
  const locales = readdirSync(app.root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  if (!locales.includes("en")) {
    problems.push(`${app.name}: no en/ catalog to compare against`);
    continue;
  }

  const namespaces = readdirSync(join(app.root, "en"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();

  for (const locale of locales.filter((l) => l !== "en")) {
    for (const ns of namespaces) {
      const file = join(app.root, locale, `${ns}.json`);
      if (!existsSync(file)) {
        problems.push(`${app.name}: ${locale}/${ns}.json is missing entirely`);
        continue;
      }
      const en = keysOf(read(join(app.root, "en", `${ns}.json`)));
      const other = keysOf(read(file));
      const missing = [...en].filter((k) => !other.has(k)).sort();
      const extra = [...other].filter((k) => !en.has(k)).sort();
      if (missing.length)
        problems.push(
          `${app.name}: ${locale}/${ns}.json missing ${missing.length} key(s): ${missing.join(", ")}`
        );
      if (extra.length)
        problems.push(
          `${app.name}: ${locale}/${ns}.json has ${extra.length} key(s) not in en: ${extra.join(", ")}`
        );
    }
  }
  console.log(
    `✓ ${app.name}: ${locales.length} locales x ${namespaces.length} namespaces checked`
  );
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} locale parity problem(s):\n`);
  for (const p of problems) console.error("  " + p);
  console.error("\nEvery locale must carry exactly the keys en/ carries.");
  process.exit(1);
}
console.log("✓ all locale catalogs are in parity with en");
