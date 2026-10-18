import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enApp from "./locales/en/app.json";
import enLive from "./locales/en/live.json";

import arCommon from "./locales/ar/common.json";
import arAuth from "./locales/ar/auth.json";
import arApp from "./locales/ar/app.json";
import arLive from "./locales/ar/live.json";

/**
 * Supported locales. The admin is for Engosoft management: Arabic and English.
 * en is the source catalog; ar is the default for a visitor with no saved
 * choice whose browser is not set to English.
 */
export const LOCALES = [
  { code: "ar", label: "العربية", short: "ع" },
  { code: "en", label: "English", short: "EN" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

const resources = {
  en: { common: enCommon, auth: enAuth, app: enApp, live: enLive },
  ar: { common: arCommon, auth: arAuth, app: arApp, live: arLive },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "ar",
    supportedLngs: LOCALES.map((l) => l.code),
    // Browser sends e.g. "en-GB" / "ar-EG"; collapse to the base language.
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    ns: ["common", "auth", "app", "live"],
    defaultNS: "common",
    // Shared words (states, actions, units) live once in common.
    fallbackNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      // Saved choice first, then the browser/OS language.
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "locale",
      caches: ["localStorage"],
    },
  });

/** The active locale, suitable for Intl APIs. */
export function activeLocale(): string {
  return i18n.resolvedLanguage || i18n.language || "ar";
}

/**
 * Locales written right-to-left. Arabic is the first; Hebrew/Farsi/Urdu would
 * join this set rather than needing any new plumbing.
 */
export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "he", "fa", "ur"]);

/** Whether `code` is written right-to-left. Accepts "ar" or "ar-EG". */
export function isRtl(code: string | undefined | null): boolean {
  if (!code) return false;
  return RTL_LOCALES.has(code.toLowerCase().split("-")[0]);
}

/** The writing direction of `code`, for a `dir` attribute. */
export function directionOf(code: string | undefined | null): "rtl" | "ltr" {
  return isRtl(code) ? "rtl" : "ltr";
}

/**
 * Mirror the active locale onto <html dir> and <html lang>.
 *
 * `dir` is what actually flips the layout: the stylesheet is written with CSS
 * logical properties (inline-start/end), so the browser does the mirroring and
 * no locale-specific stylesheet is needed. `lang` matters separately — it drives
 * font selection, hyphenation and screen-reader pronunciation, and without it a
 * screen reader would read Arabic with an English voice.
 *
 * Exported for tests; called automatically on load and on every language change.
 */
export function applyDocumentDirection(code: string = activeLocale()): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.setAttribute("dir", directionOf(code));
  el.setAttribute("lang", code);
}

applyDocumentDirection();
i18n.on("languageChanged", (lng) => applyDocumentDirection(lng));

export default i18n;
