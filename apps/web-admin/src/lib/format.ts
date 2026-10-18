import i18n from "../i18n";

/**
 * Locale for Intl. Arabic keeps Arabic month and day names but Latin digits:
 * a dashboard is read as figures, and charts, tables and times line up only
 * when every number uses the same digits.
 */
export function intlLocale(): string {
  const lang = i18n.resolvedLanguage || i18n.language || "en";
  return lang.startsWith("ar") ? "ar-u-nu-latn" : "en";
}

const unit = (key: "h" | "m" | "s") => i18n.t(`units.${key}`, { ns: "common" });

/** "3h 20m", "45m", "12s" — or "3س 20د" in Arabic. Never "0.4s". */
export function fmtDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s === 0) return `0${unit("m")}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}${unit("h")} ${m}${unit("m")}` : `${h}${unit("h")}`;
  if (m > 0) return `${m}${unit("m")}`;
  return `${s}${unit("s")}`;
}

/** Hours with one decimal for headline figures: 7.4. */
export function fmtHours(seconds: number): string {
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 0 }).format(
    Math.max(0, seconds) / 3600,
  );
}

export function fmtNumber(n: number | null | undefined): string {
  return new Intl.NumberFormat(intlLocale()).format(Math.round(n ?? 0));
}

/** 12.4K style for large counts in tight spaces. */
export function fmtCompact(n: number | null | undefined): string {
  return new Intl.NumberFormat(intlLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n ?? 0);
}

export function fmtPercent(fraction: number): string {
  return new Intl.NumberFormat(intlLocale(), { style: "percent", maximumFractionDigits: 0 }).format(
    Number.isFinite(fraction) ? fraction : 0,
  );
}

/** Pointer travel as a physical distance. ~96 px per inch on a typical display. */
export function fmtDistance(px: number): string {
  const meters = (px / 96) * 0.0254;
  const nf = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: meters < 10 ? 1 : 0 });
  return `${nf.format(meters)} ${i18n.t("units.meters", { ns: "common" })}`;
}

export function fmtClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });
}

export function fmtDay(date: Date): string {
  return date.toLocaleDateString(intlLocale(), { weekday: "short", day: "numeric", month: "short" });
}

export function fmtLongDay(date: Date): string {
  return date.toLocaleDateString(intlLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function fmtDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(intlLocale(), {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "just now", "5 min ago" — through Intl so Arabic gets real phrasing. */
export function fmtRelative(unixSeconds: number | null | undefined, now = Date.now() / 1000): string {
  if (!unixSeconds) return i18n.t("time.never", { ns: "common" });
  const diff = Math.round(unixSeconds - now);
  const abs = Math.abs(diff);
  if (abs < 45) return i18n.t("time.justNow", { ns: "common" });
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(unixSeconds * 1000).toLocaleDateString(intlLocale());
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const e = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** e;
  return `${v.toFixed(e === 0 || v >= 100 ? 0 : 1)} ${units[e]}`;
}

export function usagePercent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** Two initials for an avatar: "Amina Farouk" → "AF", "أحمد علي" → "أع". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? "" : "";
  return (first + last).toUpperCase();
}
