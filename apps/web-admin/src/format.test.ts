import { describe, expect, it } from "vitest";
import { fmtByteRate, fmtBytes, usagePercent } from "./format";

describe("resource value formatting", () => {
  it("scales bytes through gigabytes and terabytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1_536)).toBe("1.5 KB");
    expect(fmtBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(fmtBytes(2 * 1024 ** 4)).toBe("2.0 TB");
  });

  it("does not leak invalid numeric values into the UI", () => {
    expect(fmtBytes(Number.NaN)).toBe("0 B");
    expect(fmtBytes(-1)).toBe("0 B");
  });

  it("formats network throughput per second", () => {
    expect(fmtByteRate(1024 ** 2)).toBe("1.0 MB/s");
  });

  it("bounds resource percentages and rejects invalid totals", () => {
    expect(usagePercent(1, 4)).toBe(25);
    expect(usagePercent(5, 4)).toBe(100);
    expect(usagePercent(-1, 4)).toBe(0);
    expect(usagePercent(Number.NaN, 4)).toBe(0);
    expect(usagePercent(1, 0)).toBe(0);
  });
});
