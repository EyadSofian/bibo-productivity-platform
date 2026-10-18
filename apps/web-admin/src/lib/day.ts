/** A local calendar day as unix seconds: [start, end). DST-safe, because the
 *  end is the next local midnight rather than start + 86400. */
export type DayRange = { start: number; end: number; date: Date };

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dayRange(d: Date): DayRange {
  const start = startOfDay(d);
  const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: Math.floor(start.getTime() / 1000), end: Math.floor(next.getTime() / 1000), date: start };
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** YYYY-MM-DD in LOCAL time (toISOString would give the UTC date). */
export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Parses a YYYY-MM-DD value as a local date; falls back to today. */
export function parseIsoDate(value: string | null | undefined): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return startOfDay(new Date());
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(d.getTime()) ? startOfDay(new Date()) : d;
}

/** The part of the day that has happened: the whole day for the past, up to
 *  now for today, nothing for the future. */
export function elapsedEnd(range: DayRange, nowSec = Date.now() / 1000): number {
  return Math.max(range.start, Math.min(range.end, Math.floor(nowSec)));
}

/** The viewer's current local day as the roster's `{from, to}` window. */
export function localDayWindow(now = new Date()): { from: number; to: number } {
  const r = dayRange(now);
  return { from: r.start, to: r.end };
}
