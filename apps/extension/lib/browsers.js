// Browser identification.
//
// Every Chromium fork ships a user agent that says "Chrome", so the old
// `userAgent.includes("Edg") ? "edge" : "chrome"` check reported Brave, Opera,
// Vivaldi and Arc all as plain Chrome. Reports then attributed a company's
// entire browser usage to a browser half of them were not running.
//
// Pure so it can be tested against real user-agent strings.

/**
 * Identify the host browser.
 *
 * `brands` (navigator.userAgentData.brands) is preferred where present: it is
 * structured, and forks declare themselves there rather than hiding behind
 * Chrome's UA string. The user agent is the fallback for older browsers.
 *
 * `isBrave` comes from the caller because detecting Brave requires awaiting
 * `navigator.brave.isBrave()`, which this function cannot do and stay pure.
 * Brave is otherwise indistinguishable from Chrome by design.
 */
export function detectBrowser({ userAgent = "", brands = [], isBrave = false } = {}) {
  if (isBrave) return "brave";

  const named = brands.map((b) => (b && b.brand ? b.brand : "")).join(" ");
  const fromBrands = matchName(named);
  if (fromBrands) return fromBrands;

  // Order matters: forks keep "Chrome" in their UA, so the fork markers have to
  // be tested first. Edge additionally keeps "Safari" for the same reason.
  if (/\bOPR\//.test(userAgent) || /\bOpera\b/.test(userAgent)) return "opera";
  if (/\bVivaldi\b/.test(userAgent)) return "vivaldi";
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/\bFirefox\//.test(userAgent)) return "firefox";
  if (/\bChrome\//.test(userAgent)) return "chrome";
  if (/\bSafari\//.test(userAgent)) return "safari";

  return "unknown";
}

function matchName(names) {
  if (/Brave/i.test(names)) return "brave";
  if (/Opera/i.test(names)) return "opera";
  if (/Vivaldi/i.test(names)) return "vivaldi";
  if (/Microsoft Edge/i.test(names)) return "edge";
  // "Google Chrome" only — bare "Chromium" is what every fork also reports, so
  // it says nothing and should fall through to the user-agent checks.
  if (/Google Chrome/i.test(names)) return "chrome";
  return null;
}
