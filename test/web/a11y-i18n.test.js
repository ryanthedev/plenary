// @ts-check
// Tests for GitHub Issues #35 (Accessibility baseline: keyboard, screen reader, WCAG contrast)
// and #38 (Localisation: UI strings and right-to-left text).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  SUPPORTED_LOCALES,
  RTL_LOCALES,
  isRtlLocale,
  textDirection,
  resolveLocale,
  MESSAGES,
  t,
} from "../../web/core/i18n.js";

import {
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  meetsWcagAA,
  meetsWcagAAA,
  auditThemeContrast,
  auditAriaLandmarks,
} from "../../web/core/a11y-audit.js";

import {
  applyLocaleToDocument,
  createSkipLink,
} from "../../web/adapters/dom/i18n-dom.js";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Extract CSS custom property declarations from a named selector block in `web/style.css`.
 * @param {string} css
 * @param {string} selector
 * @returns {Record<string, string>}
 */
function parseCssThemeTokens(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`Could not find selector block ${selector} in web/style.css`);
  /** @type {Record<string, string>} */
  const tokens = {};
  for (const [, name, value] of match[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[name.trim()] = value.trim();
  }
  return tokens;
}

/**
 * Build a minimal headless Document mock for testing DOM adapters without jsdom.
 * @param {{ i18n?: Array<{ key: string }>, aria?: Array<{ key: string }> }} [seed]
 */
function createMockDocument(seed = {}) {
  /** @type {Record<string, string>} */
  const rootAttrs = {};
  const documentElement = {
    lang: "en",
    dir: "ltr",
    setAttribute(name, value) {
      rootAttrs[name] = value;
      if (name === "lang") this.lang = value;
      if (name === "dir") this.dir = value;
    },
    getAttribute(name) {
      return rootAttrs[name] ?? null;
    },
  };

  const textEls = (seed.i18n ?? []).map(({ key }) => {
    /** @type {Record<string, string>} */
    const attrs = { "data-i18n": key };
    return {
      textContent: "",
      getAttribute: name => attrs[name] ?? null,
      setAttribute: (name, value) => { attrs[name] = value; },
    };
  });

  const ariaEls = (seed.aria ?? []).map(({ key }) => {
    /** @type {Record<string, string>} */
    const attrs = { "data-i18n-aria": key };
    return {
      getAttribute: name => attrs[name] ?? null,
      setAttribute: (name, value) => { attrs[name] = value; },
    };
  });

  return {
    documentElement,
    querySelectorAll(selector) {
      if (selector === "[data-i18n]") return textEls;
      if (selector === "[data-i18n-aria]") return ariaEls;
      return [];
    },
    createElement(tag) {
      /** @type {Record<string, string>} */
      const attrs = {};
      return {
        tagName: tag.toUpperCase(),
        className: "",
        href: "",
        textContent: "",
        setAttribute(name, value) { attrs[name] = value; },
        getAttribute(name) { return attrs[name] ?? null; },
      };
    },
    _textEls: textEls,
    _ariaEls: ariaEls,
  };
}

describe("Issue #38 — i18n & RTL core (web/core/i18n.js)", () => {
  test("exports supported locales and RTL locale set", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "es", "ar", "ja"]);
    expect(RTL_LOCALES.has("ar")).toBe(true);
    expect(RTL_LOCALES.has("he")).toBe(true);
    expect(RTL_LOCALES.has("fa")).toBe(true);
    expect(RTL_LOCALES.has("ur")).toBe(true);
    expect(RTL_LOCALES.has("en")).toBe(false);
  });

  test("isRtlLocale and textDirection handle BCP-47 tags accurately", () => {
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("ar-SA")).toBe(true);
    expect(isRtlLocale("ar_EG")).toBe(true);
    expect(isRtlLocale("he-IL")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
    expect(isRtlLocale("es-MX")).toBe(false);
    expect(isRtlLocale("ja-JP")).toBe(false);
    expect(isRtlLocale(null)).toBe(false);

    expect(textDirection("ar")).toBe("rtl");
    expect(textDirection("ar-EG")).toBe("rtl");
    expect(textDirection("en-US")).toBe("ltr");
    expect(textDirection("ja-JP")).toBe("ltr");
  });

  test("resolveLocale resolves BCP-47 regional tags, arrays, and unknown fallbacks", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("es-MX")).toBe("es");
    expect(resolveLocale("ar-EG")).toBe("ar");
    expect(resolveLocale("ar-SA")).toBe("ar");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("fr-FR")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(["fr-CA", "de-DE", "es-AR"])).toBe("es");
    expect(resolveLocale("fr-FR", ["es", "ar"])).toBe("es");
  });

  test("MESSAGES catalog has complete parity across en, es, ar, and ja", () => {
    const enKeys = Object.keys(MESSAGES.en).sort();
    expect(enKeys.length).toBeGreaterThan(40);
    for (const locale of SUPPORTED_LOCALES) {
      const keys = Object.keys(MESSAGES[locale]).sort();
      expect(keys).toEqual(enKeys);
      for (const k of keys) {
        expect(typeof MESSAGES[locale][k]).toBe("string");
        expect(MESSAGES[locale][k].trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("t() translates, interpolates {name} variables, and falls back to en then key", () => {
    expect(t("a11y.skipToCanvas", {}, "en")).toBe("Skip to canvas");
    expect(t("a11y.skipToCanvas", {}, "es-MX")).toBe("Saltar al lienzo");
    expect(t("a11y.skipToCanvas", {}, "ar-EG")).toBe("الانتقال إلى اللوحة");
    expect(t("a11y.skipToCanvas", {}, "ja-JP")).toBe("キャンバスへスキップ");

    expect(t("comments.count", { count: 4 }, "en")).toBe("4 comments");
    expect(t("comments.count", { count: 4 }, "es")).toBe("4 comentarios");
    expect(t("comments.count", { count: 4 }, "ar")).toBe("4 تعليقات");
    expect(t("comments.count", { count: 4 }, "ja")).toBe("4件のコメント");
    expect(t("a11y.zoomLevel", { percent: 125 }, "en")).toBe("Zoom 125%");

    // Unprovided placeholder stays intact
    expect(t("replay.speed", {}, "en")).toBe("{speed}x speed");

    // Unknown locale falls back to en
    expect(t("share.copyLink", {}, "zz-ZZ")).toBe("Copy link");

    // Unknown key falls back to the raw key
    expect(t("nonexistent.ui.key", {}, "es")).toBe("nonexistent.ui.key");
  });
});

describe("Issue #35 — WCAG 2.1 contrast & ARIA audit (web/core/a11y-audit.js)", () => {
  test("parseHexColor, relativeLuminance, contrastRatio, meetsWcagAA/AAA", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor("3B48E8")).toEqual({ r: 59, g: 72, b: 232 });
    expect(() => parseHexColor("not-a-hex")).toThrow();

    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBe(1);

    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);

    expect(meetsWcagAA(4.5)).toBe(true);
    expect(meetsWcagAA(4.49)).toBe(false);
    expect(meetsWcagAA(3.0, { largeText: true })).toBe(true);
    expect(meetsWcagAA(2.99, { largeText: true })).toBe(false);

    expect(meetsWcagAAA(7.0)).toBe(true);
    expect(meetsWcagAAA(6.99)).toBe(false);
    expect(meetsWcagAAA(4.5, { largeText: true })).toBe(true);
    expect(meetsWcagAAA(4.49, { largeText: true })).toBe(false);
  });

  test("Plenary's actual Light & Dark theme tokens from web/style.css pass WCAG 2.1 AA", () => {
    const css = readFileSync(join(ROOT, "web/style.css"), "utf8");
    const lightTokens = parseCssThemeTokens(css, ":root");
    const darkTokens = parseCssThemeTokens(css, ':root[data-theme="dark"]');

    const lightAudit = auditThemeContrast(lightTokens);
    const darkAudit = auditThemeContrast(darkTokens);

    expect(lightAudit.results.length).toBeGreaterThanOrEqual(12);
    expect(lightAudit.failures).toEqual([]);
    expect(lightAudit.pass).toBe(true);

    expect(darkAudit.results.length).toBeGreaterThanOrEqual(12);
    expect(darkAudit.failures).toEqual([]);
    expect(darkAudit.pass).toBe(true);
  });

  test("auditThemeContrast catches low-contrast theme regressions", () => {
    const badTheme = {
      "--fg": "#999999",
      "--surface": "#AAAAAA",
      "--accent": "#CCCCCC",
      "--accent-fg": "#FFFFFF",
    };
    const audit = auditThemeContrast(badTheme);
    expect(audit.pass).toBe(false);
    expect(audit.failures.length).toBeGreaterThanOrEqual(2);
  });

  test("auditAriaLandmarks validates compliant and non-compliant landmark trees", () => {
    const validNodes = [
      { tag: "a", className: "skip-link", href: "#board", text: "Skip to canvas" },
      { tag: "header", id: "topbar", ariaLabel: "Top toolbar" },
      { tag: "main", id: "board", ariaLabel: "Interactive whiteboard canvas" },
      { tag: "button", id: "btn-share", text: "Share" },
      { tag: "button", id: "btn-theme", ariaLabel: "Switch to dark theme" },
      { tag: "div", id: "toast", role: "status", ariaLive: "polite" },
    ];
    const ok = auditAriaLandmarks(validNodes);
    expect(ok.pass).toBe(true);
    expect(ok.issues).toEqual([]);
    expect(ok.checks).toEqual({
      skipLink: true,
      headerLandmark: true,
      mainLandmark: true,
      buttonNames: true,
      liveRegion: true,
    });

    const brokenNodes = [
      { tag: "div", id: "wrapper" },
      { tag: "button", id: "unnamed-btn", text: "   " },
    ];
    const fail = auditAriaLandmarks(brokenNodes);
    expect(fail.pass).toBe(false);
    expect(fail.checks.skipLink).toBe(false);
    expect(fail.checks.headerLandmark).toBe(false);
    expect(fail.checks.mainLandmark).toBe(false);
    expect(fail.checks.buttonNames).toBe(false);
    expect(fail.checks.liveRegion).toBe(false);
    expect(fail.issues.length).toBeGreaterThanOrEqual(5);
  });
});

describe("DOM adapter & CSS (web/adapters/dom/i18n-dom.js, web/styles/i18n-a11y.css)", () => {
  test("applyLocaleToDocument sets lang, dir='rtl' for Arabic, and hydrates data-i18n attributes", () => {
    const doc = createMockDocument({
      i18n: [{ key: "share.title" }, { key: "tool.rectangle" }],
      aria: [{ key: "a11y.landmarkTopbar" }],
    });

    const ar = applyLocaleToDocument(/** @type {any} */ (doc), "ar-EG");
    expect(ar).toEqual({ locale: "ar", dir: "rtl", updatedCount: 3 });
    expect(doc.documentElement.lang).toBe("ar");
    expect(doc.documentElement.dir).toBe("rtl");
    expect(doc._textEls[0].textContent).toBe(MESSAGES.ar["share.title"]);
    expect(doc._textEls[1].textContent).toBe(MESSAGES.ar["tool.rectangle"]);
    expect(doc._ariaEls[0].getAttribute("aria-label")).toBe(MESSAGES.ar["a11y.landmarkTopbar"]);

    const ja = applyLocaleToDocument(/** @type {any} */ (doc), "ja-JP");
    expect(ja).toEqual({ locale: "ja", dir: "ltr", updatedCount: 3 });
    expect(doc.documentElement.lang).toBe("ja");
    expect(doc.documentElement.dir).toBe("ltr");
    expect(doc._textEls[0].textContent).toBe(MESSAGES.ja["share.title"]);
  });

  test("createSkipLink creates an accessible localized a.skip-link targeting the canvas", () => {
    const doc = createMockDocument();
    const link = createSkipLink("board", "es-MX", /** @type {any} */ (doc));
    expect(link.tagName).toBe("A");
    expect(link.className).toBe("skip-link");
    expect(link.href).toBe("#board");
    expect(link.textContent).toBe("Saltar al lienzo");
    expect(link.getAttribute("data-i18n")).toBe("a11y.skipToCanvas");
  });

  test("web/styles/i18n-a11y.css includes skip-link, focus-visible, RTL mirroring, high-contrast, and reduced-motion rules", () => {
    const css = readFileSync(join(ROOT, "web/styles/i18n-a11y.css"), "utf8");
    expect(css).toContain(".skip-link");
    expect(css).toContain(":focus-visible");
    expect(css).toContain('[dir="rtl"] .topbar');
    expect(css).toContain('[dir="rtl"] .panel');
    expect(css).toContain('[dir="rtl"] .drawer');
    expect(css).toContain('[dir="rtl"] .hud-rail');
    expect(css).toContain('[dir="rtl"] .radial-hub');
    expect(css).toContain("prefers-contrast: more");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
