// @ts-check
// DOM adapter for localisation (i18n/RTL) and keyboard skip-link creation (Issues #35, #38).

import { resolveLocale, textDirection, t } from "../../core/i18n.js";

/**
 * Apply a locale to a Document: sets `documentElement.lang` and `documentElement.dir` (`"ltr"` | `"rtl"`),
 * and hydrates `[data-i18n]` text content and `[data-i18n-aria]` `aria-label` attributes.
 * @param {Document} doc
 * @param {string | readonly string[] | null | undefined} locale
 * @returns {{ locale: string, dir: "ltr" | "rtl", updatedCount: number }}
 */
export function applyLocaleToDocument(doc, locale) {
  const resolved = resolveLocale(locale);
  const dir = textDirection(resolved);

  const root = doc?.documentElement;
  if (root) {
    root.lang = resolved;
    root.dir = dir;
    if (typeof root.setAttribute === "function") {
      root.setAttribute("lang", resolved);
      root.setAttribute("dir", dir);
    }
  }

  let updatedCount = 0;

  if (typeof doc?.querySelectorAll === "function") {
    const textNodes = doc.querySelectorAll("[data-i18n]");
    for (const el of textNodes) {
      const key = typeof el.getAttribute === "function" ? el.getAttribute("data-i18n") : null;
      if (!key) continue;
      el.textContent = t(key, {}, resolved);
      updatedCount++;
    }

    const ariaNodes = doc.querySelectorAll("[data-i18n-aria]");
    for (const el of ariaNodes) {
      const key = typeof el.getAttribute === "function" ? el.getAttribute("data-i18n-aria") : null;
      if (!key) continue;
      if (typeof el.setAttribute === "function") {
        el.setAttribute("aria-label", t(key, {}, resolved));
        updatedCount++;
      }
    }
  }

  return { locale: resolved, dir, updatedCount };
}

/**
 * Create an accessible skip-to-canvas anchor (`a.skip-link`) visible on keyboard focus.
 * @param {string} targetId
 * @param {string | null | undefined} [locale]
 * @param {Document} [doc]
 * @returns {HTMLAnchorElement}
 */
export function createSkipLink(targetId, locale = "en", doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("createSkipLink requires a Document with createElement");
  }
  const resolved = resolveLocale(locale);
  const cleanId = String(targetId ?? "board").replace(/^#/, "");
  const link = doc.createElement("a");
  link.className = "skip-link";
  link.href = `#${cleanId}`;
  link.textContent = t("a11y.skipToCanvas", {}, resolved);
  if (typeof link.setAttribute === "function") {
    link.setAttribute("data-i18n", "a11y.skipToCanvas");
  }
  return link;
}
