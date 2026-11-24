// @ts-check
/**
 * @module web/adapters/dom/theme
 * Shared Light & Dark theme controller and toggle button for Plenary's DOM surfaces
 * (Sign-in gate, Home, Space/Area, Teams, Access, Roles, Offboard, Trash, and canvas editor).
 * Uses the exact same `plenary.settings.v1` persistence port (`web/core/settings.js`)
 * so Light/Dark stays in sync everywhere.
 */

import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { loadSettings, saveSettings, resolveTheme } from "../../core/settings.js";

export const THEME_COLORS = Object.freeze({
  light: "#F8F7F4",
  dark: "#111113",
});

/**
 * Safely query the OS/browser dark-mode preference.
 * @returns {boolean}
 */
export function prefersDarkScheme() {
  try {
    return typeof globalThis.matchMedia === "function"
      && Boolean(globalThis.matchMedia("(prefers-color-scheme: dark)")?.matches);
  } catch {
    return false;
  }
}

/**
 * Read the current theme from `document.documentElement` (defaults to `"light"`).
 * @returns {"light" | "dark"}
 */
export function readDomTheme() {
  const docEl = globalThis.document?.documentElement;
  const raw = docEl?.dataset?.theme ?? docEl?.getAttribute?.("data-theme");
  return raw === "dark" ? "dark" : "light";
}

/**
 * Apply `"light"` or `"dark"` to `document.documentElement.dataset.theme` and `<meta name="theme-color">`.
 * @param {string} theme
 * @returns {"light" | "dark"}
 */
export function applyThemeToDom(theme) {
  const t = theme === "dark" ? "dark" : "light";
  const doc = globalThis.document;
  if (doc?.documentElement) {
    if (doc.documentElement.dataset) {
      doc.documentElement.dataset.theme = t;
    } else {
      doc.documentElement.setAttribute?.("data-theme", t);
    }
  }
  const meta = doc?.querySelector?.('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[t] ?? THEME_COLORS.light);
  return t;
}

/**
 * @typedef {{
 *   getTheme(): "light" | "dark",
 *   setTheme(next: string, opts?: { persist?: boolean }): "light" | "dark",
 *   toggleTheme(): "light" | "dark",
 *   subscribe(fn: (theme: "light" | "dark") => void): () => void,
 * }} ThemeController
 */

/**
 * Initialize and manage theme state using the shared `UserSettings` storage port.
 * Honors an explicit `?theme=light|dark` URL override first, then persisted `defaultTheme`,
 * then `prefers-color-scheme: dark`.
 * @param {{
 *   prefs?: import("../../ports/storage.js").Storage | null,
 *   urlTheme?: string | null,
 *   prefersDark?: () => boolean,
 * }} [o]
 * @returns {ThemeController}
 */
export function initTheme({ prefs = null, urlTheme = null, prefersDark = prefersDarkScheme } = {}) {
  const settings = loadSettings(prefs);
  // Why: `?theme=light|dark` overrides persisted settings for the current visit (deep links,
  // embeds, screenshots) without overwriting the user's saved `defaultTheme` in storage.
  const initial = urlTheme === "dark" || urlTheme === "light"
    ? urlTheme
    : resolveTheme(settings.defaultTheme, Boolean(prefersDark()));
  /** @type {"light" | "dark"} */
  let current = applyThemeToDom(initial);
  /** @type {Set<(t: "light" | "dark") => void>} */
  const listeners = new Set();

  /** @param {string} next @param {{ persist?: boolean }} [opts] */
  function setTheme(next, { persist = true } = {}) {
    current = applyThemeToDom(next);
    if (persist && prefs) {
      const latest = loadSettings(prefs);
      saveSettings(prefs, { ...latest, defaultTheme: current });
    }
    for (const fn of listeners) fn(current);
    return current;
  }

  function toggleTheme() {
    return setTheme(current === "dark" ? "light" : "dark", { persist: true });
  }

  /** @param {(t: "light" | "dark") => void} fn */
  function subscribe(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  return {
    getTheme: () => current,
    setTheme,
    toggleTheme,
    subscribe,
  };
}

/**
 * Build a crisp, accessible Light/Dark mode toggle button (`sun` / `moon` icon).
 * Works with an injected `themeCtrl` (preferred) or standalone over the current DOM + optional `prefs`.
 * @param {{
 *   themeCtrl?: ThemeController | null,
 *   prefs?: import("../../ports/storage.js").Storage | null,
 *   mark?: ((el: any, key: string) => any) | null,
 * }} [o]
 * @returns {{ el: HTMLElement, sync: () => void, destroy: () => void }}
 */
export function createThemeToggle({ themeCtrl = null, prefs = null, mark = null } = {}) {
  const getCurrent = () => (themeCtrl ? themeCtrl.getTheme() : readDomTheme());

  const onToggle = () => {
    if (themeCtrl) {
      themeCtrl.toggleTheme();
    } else {
      const next = getCurrent() === "dark" ? "light" : "dark";
      applyThemeToDom(next);
      if (prefs) {
        const latest = loadSettings(prefs);
        saveSettings(prefs, { ...latest, defaultTheme: next });
      }
      sync();
    }
  };

  const btn = h("button.btn.ghost.theme-toggle", {
    type: "button",
    "data-action": "toggle-theme",
    onclick: onToggle,
  });
  if (mark) mark(btn, "theme-toggle");

  function sync() {
    const isDark = getCurrent() === "dark";
    const label = isDark ? "Switch to light mode" : "Switch to dark mode";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.setAttribute("aria-pressed", isDark ? "true" : "false");
    replace(btn, icon(isDark ? "sun" : "moon", { size: 16 }));
  }

  const unsub = themeCtrl?.subscribe ? themeCtrl.subscribe(sync) : () => {};
  sync();
  return { el: btn, sync, destroy: unsub };
}
