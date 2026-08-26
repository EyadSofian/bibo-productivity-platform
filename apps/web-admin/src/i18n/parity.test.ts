import { describe, expect, it } from "vitest";
import { LOCALES } from "./index";

// Vite gives us every catalog without naming 8 locales x 7 namespaces by hand,
// so a new locale directory is covered the moment it is added.
const catalogs = import.meta.glob<Record<string, unknown>>("./locales/*/*.json", {
  eager: true,
  import: "default",
});

/** i18next appends these to a key to select a plural form. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * Flatten to dotted paths, collapsing plural variants onto their stem. English
 * needs 2 forms and Arabic needs 6, so comparing raw keys would report drift
 * where the catalogs are in fact correct.
 */
function keysOf(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const nested of keysOf(v as Record<string, unknown>, path)) out.add(nested);
    } else {
      out.add(path.replace(PLURAL_SUFFIX, ""));
    }
  }
  return out;
}

function catalog(locale: string, ns: string): Record<string, unknown> | undefined {
  return catalogs[`./locales/${locale}/${ns}.json`];
}

const NAMESPACES = ["common", "auth", "signup", "dashboard", "settings", "ui", "reports"];
const NON_SOURCE = LOCALES.map((l) => l.code).filter((c) => c !== "en");

describe("translation catalogs", () => {
  it("ships every namespace for every locale", () => {
    const missing: string[] = [];
    for (const { code } of LOCALES) {
      for (const ns of NAMESPACES) {
        if (!catalog(code, ns)) missing.push(`${code}/${ns}.json`);
      }
    }
    expect(missing).toEqual([]);
  });

  describe.each(NON_SOURCE)("%s", (locale) => {
    it.each(NAMESPACES)("%s has the same keys as English", (ns) => {
      const en = catalog("en", ns);
      const other = catalog(locale, ns);
      expect(en, `en/${ns}.json missing`).toBeDefined();
      expect(other, `${locale}/${ns}.json missing`).toBeDefined();

      const enKeys = keysOf(en!);
      const otherKeys = keysOf(other!);

      // Untranslated keys fall back to English silently in the browser, so the
      // only place this is ever caught is here.
      expect([...enKeys].filter((k) => !otherKeys.has(k)).sort()).toEqual([]);
      // Extra keys are dead weight, and usually mean a key was renamed in en.
      expect([...otherKeys].filter((k) => !enKeys.has(k)).sort()).toEqual([]);
    });
  });
});
