import { describe, expect, it } from "vitest";
import { addDays, dayRange, elapsedEnd, isoDate, localDayWindow, parseIsoDate } from "./day";

describe("day helpers", () => {
  it("bounds a local day from midnight to the next midnight", () => {
    const r = dayRange(new Date(2026, 9, 18, 15, 30));
    const start = new Date(r.start * 1000);
    const end = new Date(r.end * 1000);
    expect([start.getDate(), start.getHours(), start.getMinutes()]).toEqual([18, 0, 0]);
    expect([end.getDate(), end.getHours()]).toEqual([19, 0]);
  });

  it("gives the roster the same window as dayRange", () => {
    const now = new Date(2026, 9, 18, 9);
    const r = dayRange(now);
    expect(localDayWindow(now)).toEqual({ from: r.start, to: r.end });
  });

  it("round-trips a date input value in local time", () => {
    const d = new Date(2026, 0, 31);
    expect(isoDate(d)).toBe("2026-01-31");
    expect(isoDate(parseIsoDate("2026-01-31"))).toBe("2026-01-31");
    expect(isoDate(addDays(d, 1))).toBe("2026-02-01");
  });

  it("falls back to today for a malformed value", () => {
    expect(isoDate(parseIsoDate("31/01/2026"))).toBe(isoDate(new Date()));
  });

  it("stops the elapsed window at now for today and never runs past the day", () => {
    const r = dayRange(new Date(2026, 9, 18));
    expect(elapsedEnd(r, r.start + 3600)).toBe(r.start + 3600);
    expect(elapsedEnd(r, r.end + 999)).toBe(r.end);
    expect(elapsedEnd(r, r.start - 999)).toBe(r.start);
  });
});
