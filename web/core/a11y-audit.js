// @ts-check
// Pure WCAG 2.1 Accessibility & Contrast Audit core (Issue #35).
// Zero browser globals.

/**
 * @typedef {{ r: number, g: number, b: number }} RgbColor
 */

/**
 * @typedef {Object} ContrastCheckResult
 * @property {string} name
 * @property {string} fg
 * @property {string} bg
 * @property {string} fgHex
 * @property {string} bgHex
 * @property {number} ratio
 * @property {boolean} largeText
 * @property {number} minRatio
 * @property {boolean} passAA
 * @property {boolean} passAAA
 */

/**
 * @typedef {Object} ThemeContrastAudit
 * @property {boolean} pass
 * @property {ContrastCheckResult[]} results
 * @property {ContrastCheckResult[]} failures
 */

/**
 * @typedef {Object} A11yNode
 * @property {string} tag
 * @property {string} [id]
 * @property {string} [role]
 * @property {string} [href]
 * @property {string} [className]
 * @property {string} [text]
 * @property {string} [ariaLabel]
 * @property {string} [ariaLabelledBy]
 * @property {string} [ariaLive]
 * @property {boolean} [hidden]
 */

/**
 * @typedef {Object} AriaLandmarkAudit
 * @property {boolean} pass
 * @property {{
 *   skipLink: boolean,
 *   headerLandmark: boolean,
 *   mainLandmark: boolean,
 *   buttonNames: boolean,
 *   liveRegion: boolean
 * }} checks
 * @property {string[]} issues
 */

/**
 * Parse a 3-digit or 6-digit hex color string (`#RGB`, `#RRGGBB`, or without `#`) into RGB channels (0-255).
 * @param {string} hex
 * @returns {RgbColor}
 */
export function parseHexColor(hex) {
  if (typeof hex !== "string") {
    throw new TypeError("Hex color must be a string");
  }
  const raw = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return {
      r: parseInt(raw[0] + raw[0], 16),
      g: parseInt(raw[1] + raw[1], 16),
      b: parseInt(raw[2] + raw[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }
  throw new RangeError(`Invalid hex color: ${hex}`);
}

/**
 * Check whether a string is a valid 3-digit or 6-digit hex color.
 * @param {unknown} value
 * @returns {value is string}
 */
function isHexColor(value) {
  return typeof value === "string" && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/**
 * Linearize a single 8-bit sRGB channel according to WCAG 2.1 / IEC 61966-2-1.
 * @param {number} channel
 * @returns {number}
 */
function linearizeChannel(channel) {
  const s = Math.min(255, Math.max(0, channel)) / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * Compute WCAG 2.1 relative luminance for an sRGB color in `[0, 1]`.
 * @param {RgbColor} rgb
 * @returns {number}
 */
export function relativeLuminance(rgb) {
  const r = linearizeChannel(rgb.r);
  const g = linearizeChannel(rgb.g);
  const b = linearizeChannel(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Compute WCAG 2.1 contrast ratio (`1` to `21`) between two hex colors.
 * @param {string} fgHex
 * @param {string} bgHex
 * @returns {number}
 */
export function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(parseHexColor(fgHex));
  const l2 = relativeLuminance(parseHexColor(bgHex));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Return true if a contrast ratio meets WCAG 2.1 Level AA (`>= 4.5` normal text, `>= 3.0` large text / UI).
 * @param {number} ratio
 * @param {{ largeText?: boolean }} [options]
 * @returns {boolean}
 */
export function meetsWcagAA(ratio, options = {}) {
  const largeText = Boolean(options?.largeText);
  return Number.isFinite(ratio) && ratio >= (largeText ? 3.0 : 4.5);
}

/**
 * Return true if a contrast ratio meets WCAG 2.1 Level AAA (`>= 7.0` normal text, `>= 4.5` large text).
 * @param {number} ratio
 * @param {{ largeText?: boolean }} [options]
 * @returns {boolean}
 */
export function meetsWcagAAA(ratio, options = {}) {
  const largeText = Boolean(options?.largeText);
  return Number.isFinite(ratio) && ratio >= (largeText ? 4.5 : 7.0);
}

/**
 * Look up a token value from a theme token map, accepting both `"--fg"` and `"fg"` keys.
 * @param {Record<string, string>} tokens
 * @param {readonly string[]} aliases
 * @returns {string | null}
 */
function getToken(tokens, aliases) {
  for (const name of aliases) {
    const bare = name.replace(/^--/, "");
    const cssVar = `--${bare}`;
    if (isHexColor(tokens[cssVar])) return tokens[cssVar].trim();
    if (isHexColor(tokens[bare])) return tokens[bare].trim();
  }
  return null;
}

/**
 * Pairs of theme tokens to audit for WCAG 2.1 AA contrast compliance.
 * @type {readonly { name: string, fg: readonly string[], bg: readonly string[], largeText: boolean }[]}
 */
const DEFAULT_THEME_PAIRS = Object.freeze([
  { name: "fg on surface", fg: ["fg"], bg: ["surface"], largeText: false },
  { name: "fg on canvas-bg", fg: ["fg"], bg: ["canvas-bg"], largeText: false },
  { name: "fg on surface-subtle", fg: ["fg"], bg: ["surface-subtle"], largeText: false },
  { name: "fg-muted on surface", fg: ["fg-muted", "muted"], bg: ["surface"], largeText: false },
  { name: "fg-muted on canvas-bg", fg: ["fg-muted", "muted"], bg: ["canvas-bg"], largeText: false },
  { name: "fg-dim on surface", fg: ["fg-dim", "dim"], bg: ["surface"], largeText: false },
  { name: "accent-fg on accent", fg: ["accent-fg"], bg: ["accent"], largeText: false },
  { name: "accent-fg on accent-hover", fg: ["accent-fg"], bg: ["accent-hover"], largeText: false },
  { name: "accent on surface", fg: ["accent"], bg: ["surface"], largeText: false },
  { name: "ok on surface", fg: ["ok"], bg: ["surface"], largeText: false },
  { name: "ok on ok-bg", fg: ["ok"], bg: ["ok-bg"], largeText: false },
  { name: "warn on surface", fg: ["warn"], bg: ["surface"], largeText: false },
  { name: "warn on warn-bg", fg: ["warn"], bg: ["warn-bg"], largeText: false },
  { name: "danger on surface", fg: ["bad", "danger"], bg: ["surface"], largeText: false },
  { name: "danger on danger-bg", fg: ["bad", "danger"], bg: ["bad-bg", "danger-bg"], largeText: false },
  { name: "border-strong on surface (UI)", fg: ["border-strong"], bg: ["surface"], largeText: true },
  { name: "border-strong on canvas-bg (UI)", fg: ["border-strong"], bg: ["canvas-bg"], largeText: true },
]);

/**
 * Audit all foreground/surface/accent/danger/ok/border pairs in a theme token dictionary
 * against WCAG 2.1 AA thresholds (`>= 4.5:1` normal text, `>= 3.0:1` large text / UI).
 * @param {Record<string, string>} themeTokens
 * @returns {ThemeContrastAudit}
 */
export function auditThemeContrast(themeTokens) {
  const tokens = themeTokens && typeof themeTokens === "object" ? themeTokens : {};
  /** @type {ContrastCheckResult[]} */
  const results = [];

  for (const pair of DEFAULT_THEME_PAIRS) {
    const fgHex = getToken(tokens, pair.fg);
    const bgHex = getToken(tokens, pair.bg);
    if (!fgHex || !bgHex) continue;

    const ratio = contrastRatio(fgHex, bgHex);
    const passAA = meetsWcagAA(ratio, { largeText: pair.largeText });
    const passAAA = meetsWcagAAA(ratio, { largeText: pair.largeText });
    results.push({
      name: pair.name,
      fg: pair.fg[0],
      bg: pair.bg[0],
      fgHex,
      bgHex,
      ratio,
      largeText: pair.largeText,
      minRatio: pair.largeText ? 3.0 : 4.5,
      passAA,
      passAAA,
    });
  }

  const failures = results.filter(r => !r.passAA);
  return {
    pass: results.length > 0 && failures.length === 0,
    results,
    failures,
  };
}

/**
 * Audit a list of structural node descriptors for baseline ARIA landmark & keyboard accessibility:
 * - Skip link (`a.skip-link` with `#target` href)
 * - Header landmark (`<header>` or `role="banner"`)
 * - Main landmark (`<main>` or `role="main"`)
 * - Non-empty accessible names on all visible buttons (`<button>` or `role="button"`)
 * - Live status region (`aria-live="polite"|"assertive"` or `role="status"|"alert"`)
 * @param {readonly A11yNode[]} nodes
 * @returns {AriaLandmarkAudit}
 */
export function auditAriaLandmarks(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  /** @type {string[]} */
  const issues = [];

  const ids = new Set(list.map(n => n?.id).filter(Boolean));

  const skipLinks = list.filter(n => {
    if (!n || n.hidden) return false;
    const tag = String(n.tag ?? "").toLowerCase();
    const classes = String(n.className ?? "").split(/\s+/);
    const href = String(n.href ?? "");
    return tag === "a" && classes.includes("skip-link") && href.startsWith("#") && href.length > 1;
  });

  let skipLink = skipLinks.length > 0;
  if (!skipLink) {
    issues.push("Missing skip-link anchor (a.skip-link with #target href)");
  } else {
    const validTarget = skipLinks.some(link => {
      const target = String(link.href).slice(1);
      return ids.size === 0 || ids.has(target);
    });
    if (!validTarget) {
      skipLink = false;
      issues.push("Skip-link target id does not match any node in document");
    }
  }

  const headerLandmark = list.some(n => {
    if (!n || n.hidden) return false;
    const tag = String(n.tag ?? "").toLowerCase();
    const role = String(n.role ?? "").toLowerCase();
    return tag === "header" || role === "banner";
  });
  if (!headerLandmark) {
    issues.push("Missing header/banner landmark");
  }

  const mainLandmark = list.some(n => {
    if (!n || n.hidden) return false;
    const tag = String(n.tag ?? "").toLowerCase();
    const role = String(n.role ?? "").toLowerCase();
    return tag === "main" || role === "main";
  });
  if (!mainLandmark) {
    issues.push("Missing main landmark");
  }

  const buttons = list.filter(n => {
    if (!n || n.hidden) return false;
    const tag = String(n.tag ?? "").toLowerCase();
    const role = String(n.role ?? "").toLowerCase();
    return tag === "button" || role === "button";
  });

  let buttonNames = true;
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    const hasName = Boolean(
      (typeof btn.text === "string" && btn.text.trim().length > 0) ||
      (typeof btn.ariaLabel === "string" && btn.ariaLabel.trim().length > 0) ||
      (typeof btn.ariaLabelledBy === "string" && btn.ariaLabelledBy.trim().length > 0)
    );
    if (!hasName) {
      buttonNames = false;
      issues.push(`Button ${btn.id ? `#${btn.id}` : `[index ${i}]`} is missing an accessible name`);
    }
  }

  const liveRegion = list.some(n => {
    if (!n) return false;
    const live = String(n.ariaLive ?? "").toLowerCase();
    const role = String(n.role ?? "").toLowerCase();
    return live === "polite" || live === "assertive" || role === "status" || role === "alert";
  });
  if (!liveRegion) {
    issues.push("Missing aria-live status region");
  }

  const checks = {
    skipLink,
    headerLandmark,
    mainLandmark,
    buttonNames,
    liveRegion,
  };

  return {
    pass: issues.length === 0,
    checks,
    issues,
  };
}
