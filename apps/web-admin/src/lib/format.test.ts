import { afterAll, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { fmtDistance, fmtDuration, fmtNumber, initials, intlLocale } from "./format";

afterAll(() => i18n.changeLanguage("en"));

describe("fmtDuration", () => {
  it("reads as hours and minutes in English", async () => {
    await i18n.changeLanguage("en");
    expect(fmtDuration(0)).toBe("0m");
    expect(fmtDuration(42)).toBe("42s");
    expect(fmtDuration(0.4)).toBe("0m");
    expect(fmtDuration(3600)).toBe("1h");
    expect(fmtDuration(4 * 3600 + 57 * 60 + 20)).toBe("4h 57m");
  });

  it("uses Arabic units in Arabic", async () => {
    await i18n.changeLanguage("ar");
    expect(fmtDuration(4 * 3600 + 57 * 60)).toBe("4س 57د");
  });
});

describe("numbers in Arabic", () => {
  it("keep Latin digits so tables and charts line up", async () => {
    await i18n.changeLanguage("ar");
    expect(intlLocale()).toBe("ar-u-nu-latn");
    expect(fmtNumber(12345)).toMatch(/12.?345/);
    expect(fmtNumber(12345)).not.toMatch(/[٠-٩]/);
  });
});

describe("fmtDistance", () => {
  it("turns pointer pixels into metres at 96 px per inch", async () => {
    await i18n.changeLanguage("en");
    // 96 px = 1 inch = 0.0254 m, so 3780 px ≈ 1 m.
    expect(fmtDistance(3780)).toBe("1 m");
  });
});

describe("initials", () => {
  it("takes the first and last name, in any script", () => {
    expect(initials("Amina Farouk")).toBe("AF");
    expect(initials("أحمد محمد علي")).toBe("أع");
    expect(initials("Omar")).toBe("O");
    expect(initials("  ")).toBe("?");
  });
});
