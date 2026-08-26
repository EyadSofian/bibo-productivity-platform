import { beforeEach, describe, expect, it } from "vitest";
import i18n, {
  LOCALES,
  RTL_LOCALES,
  applyDocumentDirection,
  directionOf,
  isRtl,
} from "./index";

describe("isRtl", () => {
  it("recognizes Arabic", () => {
    expect(isRtl("ar")).toBe(true);
  });

  it("recognizes a region-qualified RTL tag", () => {
    // The browser sends e.g. "ar-EG"; i18next collapses it, but direction is
    // decided before that in some call sites, so the raw tag must work too.
    expect(isRtl("ar-EG")).toBe(true);
    expect(isRtl("AR-SA")).toBe(true);
  });

  it("treats every other shipped locale as LTR", () => {
    for (const l of LOCALES) {
      if (l.code === "ar") continue;
      expect(isRtl(l.code), l.code).toBe(false);
    }
  });

  it("does not fall over on absent input", () => {
    expect(isRtl(undefined)).toBe(false);
    expect(isRtl(null)).toBe(false);
    expect(isRtl("")).toBe(false);
  });

  it("covers the other RTL scripts, so adding one needs no new plumbing", () => {
    expect([...RTL_LOCALES].sort()).toEqual(["ar", "fa", "he", "ur"]);
  });
});

describe("directionOf", () => {
  it("maps to dir attribute values", () => {
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
    expect(directionOf(undefined)).toBe("ltr");
  });
});

describe("applyDocumentDirection", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("dir");
    document.documentElement.removeAttribute("lang");
  });

  it("marks the document RTL for Arabic", () => {
    applyDocumentDirection("ar");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
  });

  it("sets lang as well as dir", () => {
    // lang is not decoration: it drives font selection and screen-reader voice.
    applyDocumentDirection("ar");
    expect(document.documentElement.getAttribute("lang")).toBe("ar");
  });

  it("returns the document to LTR when switching away", () => {
    applyDocumentDirection("ar");
    applyDocumentDirection("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
    expect(document.documentElement.getAttribute("lang")).toBe("en");
  });
});

describe("language changes drive the document direction", () => {
  it("flips dir when i18next switches to Arabic and back", async () => {
    await i18n.changeLanguage("ar");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");

    await i18n.changeLanguage("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
  });
});

describe("the Arabic catalog", () => {
  it("is registered and reachable", async () => {
    await i18n.changeLanguage("ar");
    expect(i18n.resolvedLanguage).toBe("ar");
    // A key from each namespace, to catch a namespace that was never wired in.
    expect(i18n.t("nav.dashboard")).toBe("لوحة التحكم");
    expect(i18n.t("settings:title")).toBe("الإعدادات");
    expect(i18n.t("reports:browser.title")).toBe("المواقع التي تمت زيارتها");
    expect(i18n.t("dashboard:dashboard.title")).toBe("لوحة التحكم");
    expect(i18n.t("auth:signIn.title")).toBe("تسجيل الدخول");
    expect(i18n.t("signup:account.title")).toBe("أنشئ حسابك");
    expect(i18n.t("ui:businessLabel")).toBe("المؤسسة");
    await i18n.changeLanguage("en");
  });

  it("is offered in the language switcher", () => {
    expect(LOCALES.map((l) => l.code)).toContain("ar");
  });
});
