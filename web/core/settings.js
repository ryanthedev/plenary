// @ts-check
// Customizable user settings, keybindings, frame/view quick-jump binds, and pure deep-link URL parsing (#116, #22).
// Strictly pure: zero browser globals. Persistence goes through the injected Storage port (web/ports/storage.js).

export const SETTINGS_KEY = "plenary.settings.v1";

/** @typedef {"auto" | "light" | "dark"} ThemePreference */
/** @typedef {{ id: string, label: string, category: "Tools" | "View" | "Board", defaultCombo: string }} ActionSpec */
/**
 * @typedef {{
 *   defaultTheme: ThemePreference,
 *   gridDefault: boolean,
 *   roughDefault: number,
 *   keybinds: Record<string, string>,
 *   frameBinds: Record<string, string>,
 * }} UserSettings
 */
/**
 * @typedef {{ kind: "action", action: string, label: string, combo: string }
 *   | { kind: "frame", target: string, combo: string }
 *   | { kind: "reserved", label: string, combo: string, hard: boolean }} KeybindConflict
 */
/**
 * @typedef {{ kind: "frame" | "el" | "view", id: string }} DeepLinkTarget
 */

/** @type {readonly ActionSpec[]} */
export const ACTION_CATALOG = Object.freeze([
  // Tools
  Object.freeze({ id: "tool.select", label: "Select tool", category: "Tools", defaultCombo: "V" }),
  Object.freeze({ id: "tool.hand", label: "Hand / pan tool", category: "Tools", defaultCombo: "H" }),
  Object.freeze({ id: "tool.rectangle", label: "Rectangle tool", category: "Tools", defaultCombo: "R" }),
  Object.freeze({ id: "tool.diamond", label: "Diamond tool", category: "Tools", defaultCombo: "D" }),
  Object.freeze({ id: "tool.ellipse", label: "Ellipse tool", category: "Tools", defaultCombo: "O" }),
  Object.freeze({ id: "tool.arrow", label: "Arrow tool", category: "Tools", defaultCombo: "A" }),
  Object.freeze({ id: "tool.line", label: "Line tool", category: "Tools", defaultCombo: "L" }),
  Object.freeze({ id: "tool.freedraw", label: "Pen tool", category: "Tools", defaultCombo: "P" }),
  Object.freeze({ id: "tool.text", label: "Text tool", category: "Tools", defaultCombo: "T" }),
  Object.freeze({ id: "tool.eraser", label: "Eraser tool", category: "Tools", defaultCombo: "E" }),
  Object.freeze({ id: "tool.frame", label: "Frame tool", category: "Tools", defaultCombo: "F" }),
  Object.freeze({ id: "tool.laser", label: "Laser pointer", category: "Tools", defaultCombo: "K" }),
  Object.freeze({ id: "tool.note", label: "Sticky note", category: "Tools", defaultCombo: "N" }),
  Object.freeze({ id: "tool.highlighter", label: "Highlighter", category: "Tools", defaultCombo: "M" }),
  // View & Navigation
  Object.freeze({ id: "action.views", label: "Jump to frame / view", category: "View", defaultCombo: "Mod+J" }),
  Object.freeze({ id: "action.panel", label: "Toggle side panel", category: "View", defaultCombo: "I" }),
  Object.freeze({ id: "action.fit", label: "Zoom to fit", category: "View", defaultCombo: "Shift+1" }),
  Object.freeze({ id: "action.zoomReset", label: "Reset zoom (100%)", category: "View", defaultCombo: "Mod+0" }),
  Object.freeze({ id: "action.zoomIn", label: "Zoom in", category: "View", defaultCombo: "Mod+=" }),
  Object.freeze({ id: "action.zoomOut", label: "Zoom out", category: "View", defaultCombo: "Mod+-" }),
  Object.freeze({ id: "action.nextFrame", label: "Next frame", category: "View", defaultCombo: "PageDown" }),
  Object.freeze({ id: "action.prevFrame", label: "Previous frame", category: "View", defaultCombo: "PageUp" }),
  // Board
  Object.freeze({ id: "action.toolLock", label: "Keep tool active (lock)", category: "Board", defaultCombo: "Q" }),
  Object.freeze({ id: "action.grid", label: "Toggle snap to grid", category: "Board", defaultCombo: "Mod+'" }),
  Object.freeze({ id: "action.export", label: "Export board", category: "Board", defaultCombo: "Mod+Shift+E" }),
  Object.freeze({ id: "action.settings", label: "Settings & keybindings", category: "Board", defaultCombo: "Mod+," }),
]);

/** @type {Readonly<Record<string, string>>} */
export const DEFAULT_KEYBINDS = Object.freeze(
  Object.fromEntries(ACTION_CATALOG.map(a => [a.id, a.defaultCombo]))
);

const ACTION_BY_ID = new Map(ACTION_CATALOG.map(a => [a.id, a]));

/** @type {Readonly<UserSettings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  defaultTheme: "auto",
  gridDefault: false,
  roughDefault: 1,
  keybinds: Object.freeze({}),
  frameBinds: Object.freeze({}),
});

export const FRAME_BIND_SLOTS = Object.freeze([
  "Alt+1", "Alt+2", "Alt+3", "Alt+4", "Alt+5", "Alt+6", "Alt+7", "Alt+8", "Alt+9",
]);
const FRAME_BIND_SLOT_SET = new Set(FRAME_BIND_SLOTS);

/** Built-in editor, clipboard, and accessibility shortcuts that must not be silently shadowed. */
/** @type {Readonly<Record<string, { label: string, hard: boolean }>>} */
export const RESERVED_COMBOS = Object.freeze({
  Tab: { label: "Keyboard focus navigation", hard: true },
  "Shift+Tab": { label: "Reverse keyboard focus navigation", hard: true },
  Escape: { label: "Cancel / dismiss", hard: true },
  Enter: { label: "Confirm / edit text", hard: true },
  Space: { label: "Hold to pan", hard: true },
  Backspace: { label: "Delete selection", hard: true },
  Delete: { label: "Delete selection", hard: true },
  "Mod+Z": { label: "Undo", hard: true },
  "Mod+Shift+Z": { label: "Redo", hard: true },
  "Mod+Y": { label: "Redo", hard: true },
  "Mod+C": { label: "Copy", hard: true },
  "Mod+X": { label: "Cut", hard: true },
  "Mod+V": { label: "Paste", hard: true },
  "Mod+A": { label: "Select all", hard: true },
  "Mod+D": { label: "Duplicate", hard: false },
  "Mod+G": { label: "Group selection", hard: false },
  "Mod+Shift+G": { label: "Ungroup selection", hard: false },
  "Mod+Shift+L": { label: "Lock / unlock selection", hard: false },
  "Mod+[": { label: "Send backward", hard: false },
  "Mod+]": { label: "Bring forward", hard: false },
  "[": { label: "Send to back / previous view", hard: false },
  "]": { label: "Bring to front / next view", hard: false },
  C: { label: "Next stroke color", hard: false },
  B: { label: "Next fill color", hard: false },
  S: { label: "Cycle stroke style", hard: false },
  W: { label: "Cycle stroke width", hard: false },
  G: { label: "Toggle roughness", hard: false },
});

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BARE_MODIFIERS = new Set(["shift", "control", "ctrl", "meta", "cmd", "command", "alt", "option", "altgraph", "os"]);

/** @type {Record<string, string>} */
const SPECIAL_KEYS = {
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  plus: "+",
  minus: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  quote: "'",
  bracketleft: "[",
  bracketright: "]",
};

/**
 * Normalize a single non-modifier key token.
 * Respects keyboard layout (`rawKey`) for letters so AZERTY/Dvorak work as typed,
 * while using physical `code` for `Digit0-9` (so Shift+1 "!" and macOS Alt+1 "¡" normalize to "1")
 * and for `Alt`+letter (so macOS Option+letter dead/symbol chars normalize cleanly).
 * @param {string} rawKey
 * @param {string} [code]
 * @param {{ alt?: boolean }} [opts]
 * @returns {string}
 */
function normalizeKeyToken(rawKey, code = "", { alt = false } = {}) {
  const k = typeof rawKey === "string" ? rawKey : "";
  const c = typeof code === "string" ? code : "";
  const lower = k.toLowerCase();
  if (BARE_MODIFIERS.has(lower)) return "";

  const digitMatch = /^Digit(\d)$/.exec(c);
  if (digitMatch) return digitMatch[1];
  if (alt) {
    const letterMatch = /^Key([A-Za-z])$/.exec(c);
    if (letterMatch) return letterMatch[1].toUpperCase();
  }

  if (k === " ") return "Space";
  const trimmed = k.trim();
  if (!trimmed) return "";
  const trimmedLower = trimmed.toLowerCase();
  if (BARE_MODIFIERS.has(trimmedLower)) return "";
  if (Object.hasOwn(SPECIAL_KEYS, trimmedLower)) return SPECIAL_KEYS[trimmedLower];
  if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
  if (trimmed.length === 1) {
    return /^[a-z]$/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }
  return "";
}

/**
 * Normalize a KeyboardEvent-like object or shortcut string into a canonical combo string
 * (e.g. `"Mod+Shift+E"`, `"Alt+1"`, `"V"`, `"PageDown"`). Returns `""` for bare modifiers or invalid input.
 * @param {string | {
 *   key?: string,
 *   code?: string,
 *   ctrlKey?: boolean,
 *   metaKey?: boolean,
 *   altKey?: boolean,
 *   shiftKey?: boolean,
 *   cmd?: boolean,
 *   ctrl?: boolean,
 *   alt?: boolean,
 *   shift?: boolean,
 * } | null | undefined} input
 * @returns {string}
 */
export function normalizeCombo(input) {
  if (!input) return "";
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return "";
    // Support trailing literal "+" such as "Mod++"
    let mod = false, alt = false, shift = false;
    let keyPart = "";
    const tokens = raw.split("+");
    for (let i = 0; i < tokens.length; i++) {
      const part = tokens[i].trim();
      const isLast = i === tokens.length - 1;
      if (!part) {
        // Trailing "+" in e.g. "Mod++" produces empty trailing token
        if (isLast && i > 0 && tokens[i - 1] === "") keyPart = "+";
        continue;
      }
      const low = part.toLowerCase();
      if (!isLast && (low === "mod" || low === "cmd" || low === "meta" || low === "ctrl" || low === "control" || low === "command" || low === "⌘")) {
        mod = true;
      } else if (!isLast && (low === "alt" || low === "option" || low === "opt" || low === "⌥")) {
        alt = true;
      } else if (!isLast && (low === "shift" || low === "⇧")) {
        shift = true;
      } else if (isLast) {
        keyPart = normalizeKeyToken(part);
      } else {
        return "";
      }
    }
    if (!keyPart) return "";
    const parts = [];
    if (mod) parts.push("Mod");
    if (alt) parts.push("Alt");
    if (shift) parts.push("Shift");
    parts.push(keyPart);
    return parts.join("+");
  }

  if (typeof input === "object") {
    const mod = Boolean(input.metaKey || input.ctrlKey || input.cmd || input.ctrl);
    const alt = Boolean(input.altKey || input.alt);
    const shift = Boolean(input.shiftKey || input.shift);
    const keyPart = normalizeKeyToken(input.key ?? "", input.code ?? "", { alt });
    if (!keyPart) return "";
    const parts = [];
    if (mod) parts.push("Mod");
    if (alt) parts.push("Alt");
    if (shift) parts.push("Shift");
    parts.push(keyPart);
    return parts.join("+");
  }
  return "";
}

/**
 * Format a canonical combo string for compact UI display (e.g. `"Mod+Shift+E"` -> `"⌘⇧E"`).
 * @param {string} combo
 * @param {{ mac?: boolean }} [opts]
 * @returns {string}
 */
export function formatCombo(combo, { mac = true } = {}) {
  const norm = normalizeCombo(combo);
  if (!norm) return "";
  const parts = norm.split("+");
  const key = parts.pop() ?? "";
  const keyDisp = key === "PageDown" ? "PgDn" : key === "PageUp" ? "PgUp" : key === "Space" ? "Space" : key;
  if (!parts.length) return keyDisp;
  if (mac) {
    const syms = parts.map(p => (p === "Mod" ? "⌘" : p === "Alt" ? "⌥" : p === "Shift" ? "⇧" : p));
    return `${syms.join("")}${keyDisp}`;
  }
  const labels = parts.map(p => (p === "Mod" ? "Ctrl" : p));
  return `${labels.join("+")}+${keyDisp}`;
}

/**
 * Return the merged map of every action ID to its effective normalized combo.
 * @param {Partial<UserSettings> | null | undefined} settings
 * @returns {Record<string, string>}
 */
export function effectiveKeybinds(settings) {
  /** @type {Record<string, string>} */
  const out = { ...DEFAULT_KEYBINDS };
  const overrides = settings?.keybinds;
  if (overrides && typeof overrides === "object") {
    for (const [action, raw] of Object.entries(overrides)) {
      if (FORBIDDEN_KEYS.has(action)) continue;
      if (raw === "") {
        out[action] = "";
      } else {
        const norm = normalizeCombo(raw);
        if (norm) out[action] = norm;
      }
    }
  }
  return out;
}

/**
 * Check whether binding `action` to `combo` conflicts with any other action's effective keybind
 * or with any configured `frameBinds` slot.
 * @param {Record<string, string> | null | undefined} keybinds
 * @param {string} action
 * @param {string | object} combo
 * @param {{ defaults?: Readonly<Record<string, string>>, frameBinds?: Record<string, string> }} [opts]
 * @returns {KeybindConflict | null}
 */
export function detectKeybindConflict(keybinds, action, combo, { defaults = DEFAULT_KEYBINDS, frameBinds = {} } = {}) {
  const norm = normalizeCombo(combo);
  if (!norm) return null;

  if (Object.hasOwn(RESERVED_COMBOS, norm)) {
    const r = RESERVED_COMBOS[norm];
    return { kind: "reserved", label: r.label, combo: norm, hard: r.hard };
  }

  /** @type {Record<string, string>} */
  const merged = {};
  for (const [k, v] of Object.entries(defaults ?? {})) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const n = normalizeCombo(v);
    if (n) merged[k] = n;
  }
  if (keybinds && typeof keybinds === "object") {
    for (const [k, v] of Object.entries(keybinds)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      merged[k] = v === "" ? "" : normalizeCombo(v);
    }
  }

  for (const [otherAction, otherCombo] of Object.entries(merged)) {
    if (otherAction === action) continue;
    if (otherCombo && otherCombo === norm) {
      const spec = ACTION_BY_ID.get(otherAction);
      return { kind: "action", action: otherAction, label: spec?.label ?? otherAction, combo: norm };
    }
  }

  if (frameBinds && typeof frameBinds === "object") {
    for (const [slotCombo, target] of Object.entries(frameBinds)) {
      if (FORBIDDEN_KEYS.has(slotCombo) || !target) continue;
      const slotNorm = normalizeCombo(slotCombo);
      if (slotNorm && slotNorm === norm && action !== `frameBind:${slotNorm}`) {
        return { kind: "frame", target: String(target), combo: norm };
      }
    }
  }

  return null;
}

/**
 * Resolve a keyboard event (or combo string) against the user's effective keybindings and frameBinds.
 * Returns:
 * - `{ kind: "frameBind", combo, target }` when a frame/view quick-jump bind matches
 * - `{ kind: "action", action, combo }` when an action matches
 * - `{ kind: "unbound", action, combo }` when the combo was an action's default that has been rebound elsewhere
 * - `null` when nothing matches (caller may fall through to built-in shortcuts)
 * @param {UserSettings} settings
 * @param {string | object} input
 * @returns {{ kind: "frameBind", combo: string, target: string } | { kind: "action", action: string, combo: string } | { kind: "unbound", action: string, combo: string } | null}
 */
export function resolveKeybind(settings, input) {
  const norm = normalizeCombo(input);
  if (!norm) return null;

  const fbs = settings?.frameBinds;
  if (fbs && typeof fbs === "object" && Object.hasOwn(fbs, norm) && typeof fbs[norm] === "string" && fbs[norm]) {
    return { kind: "frameBind", combo: norm, target: fbs[norm] };
  }

  const eff = effectiveKeybinds(settings);
  for (const [action, combo] of Object.entries(eff)) {
    if (combo === norm) return { kind: "action", action, combo: norm };
  }

  // If this combo is the default of an action the user rebound elsewhere, suppress the old default.
  for (const [action, defCombo] of Object.entries(DEFAULT_KEYBINDS)) {
    if (defCombo === norm && eff[action] !== defCombo) {
      return { kind: "unbound", action, combo: norm };
    }
  }

  return null;
}

/**
 * Resolve effective theme (`"light" | "dark"`) from user's `defaultTheme` preference and system dark-mode flag.
 * @param {ThemePreference | string | null | undefined} defaultTheme
 * @param {boolean} prefersDark
 * @returns {"light" | "dark"}
 */
export function resolveTheme(defaultTheme, prefersDark) {
  if (defaultTheme === "dark") return "dark";
  if (defaultTheme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

/**
 * Sanitize untrusted/stored settings JSON into a clean, bounded `UserSettings` object.
 * @param {any} raw
 * @returns {UserSettings}
 */
export function sanitizeSettings(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  /** @type {ThemePreference} */
  const defaultTheme = obj.defaultTheme === "light" || obj.defaultTheme === "dark" || obj.defaultTheme === "auto"
    ? obj.defaultTheme
    : DEFAULT_SETTINGS.defaultTheme;
  const gridDefault = Boolean(obj.gridDefault);
  const rawRough = Number(obj.roughDefault);
  const roughDefault = Number.isFinite(rawRough)
    ? Math.max(0, Math.min(2, Math.round(rawRough)))
    : DEFAULT_SETTINGS.roughDefault;

  /** @type {Record<string, string>} */
  const keybinds = {};
  if (obj.keybinds && typeof obj.keybinds === "object" && !Array.isArray(obj.keybinds)) {
    let count = 0;
    for (const [action, val] of Object.entries(obj.keybinds)) {
      if (count >= 64) break;
      if (FORBIDDEN_KEYS.has(action) || typeof action !== "string" || !ACTION_BY_ID.has(action)) continue;
      if (val === "") {
        keybinds[action] = "";
        count++;
        continue;
      }
      if (typeof val !== "string" || val.length > 32) continue;
      const norm = normalizeCombo(val);
      if (!norm) continue;
      if (Object.hasOwn(RESERVED_COMBOS, norm) && RESERVED_COMBOS[norm].hard) continue;
      if (norm !== DEFAULT_KEYBINDS[action]) {
        keybinds[action] = norm;
        count++;
      }
    }
  }

  /** @type {Record<string, string>} */
  const frameBinds = {};
  if (obj.frameBinds && typeof obj.frameBinds === "object" && !Array.isArray(obj.frameBinds)) {
    let count = 0;
    for (const [slot, target] of Object.entries(obj.frameBinds)) {
      if (count >= 32) break;
      if (FORBIDDEN_KEYS.has(slot) || typeof slot !== "string" || slot.length > 32) continue;
      if (typeof target !== "string") continue;
      const norm = normalizeCombo(slot);
      const cleanTarget = target.trim().slice(0, 128);
      if (!norm || !FRAME_BIND_SLOT_SET.has(norm) || !cleanTarget || !/^[A-Za-z0-9._:-]{1,128}$/.test(cleanTarget)) continue;
      frameBinds[norm] = cleanTarget;
      count++;
    }
  }

  return { defaultTheme, gridDefault, roughDefault, keybinds, frameBinds };
}

/**
 * Load user settings from the injected Storage port. Never throws on missing/corrupt/unavailable storage.
 * @param {import("../ports/storage.js").Storage | null | undefined} storage
 * @returns {UserSettings}
 */
export function loadSettings(storage) {
  let raw = null;
  try {
    raw = storage?.get?.(SETTINGS_KEY) ?? null;
  } catch {
    return sanitizeSettings(null);
  }
  if (typeof raw !== "string" || !raw) return sanitizeSettings(null);
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return sanitizeSettings(null);
  }
}

/**
 * Persist sanitized user settings to the injected Storage port. Never throws if storage is unavailable.
 * @param {import("../ports/storage.js").Storage | null | undefined} storage
 * @param {Partial<UserSettings>} settings
 * @returns {UserSettings}
 */
export function saveSettings(storage, settings) {
  const clean = sanitizeSettings(settings);
  try {
    storage?.set?.(SETTINGS_KEY, JSON.stringify(clean));
  } catch {
    // Storage unavailable or full: carry on in memory.
  }
  return clean;
}

/**
 * Reset user settings to defaults and remove the stored entry. Never throws if storage is unavailable.
 * @param {import("../ports/storage.js").Storage | null | undefined} [storage]
 * @returns {UserSettings}
 */
export function resetSettings(storage = null) {
  try {
    storage?.remove?.(SETTINGS_KEY);
  } catch {
    // Ignore storage removal errors.
  }
  return sanitizeSettings(null);
}

// ── Pure Deep-Link URL parsing & building (#22) ──

const SAFE_TARGET_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** @type {readonly ("frame" | "el" | "view")[]} */
const DEEP_LINK_KINDS = Object.freeze(["frame", "el", "view"]);

/**
 * Parse a query or hash parameter string (`"frame=f1&foo=bar"`) into a key -> decoded value map.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function parseParamString(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof raw !== "string" || !raw) return out;
  for (const part of raw.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || FORBIDDEN_KEYS.has(k)) continue;
    let v = part.slice(eq + 1);
    try {
      v = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      continue;
    }
    if (!Object.hasOwn(out, k)) out[k] = v;
  }
  return out;
}

/**
 * Extract and sanitize a deep-link target (`#frame=`, `#el=`, `#view=` or `?frame=`, `?el=`, `?view=`)
 * from a location-like `{ hash, search }`. Hash takes precedence over query. Ignores OAuth `#code=` fragments.
 * @param {{ hash?: string | null, search?: string | null } | null | undefined} loc
 * @returns {DeepLinkTarget | null}
 */
export function parseDeepLink(loc) {
  if (!loc || typeof loc !== "object") return null;
  const hashRaw = typeof loc.hash === "string" ? loc.hash.replace(/^#/, "") : "";
  const searchRaw = typeof loc.search === "string" ? loc.search.replace(/^\?/, "") : "";
  const hashParams = parseParamString(hashRaw);
  const searchParams = parseParamString(searchRaw);

  for (const source of [hashParams, searchParams]) {
    for (const kind of DEEP_LINK_KINDS) {
      if (!Object.hasOwn(source, kind)) continue;
      const id = source[kind].trim();
      if (SAFE_TARGET_ID_RE.test(id)) return { kind, id };
    }
  }
  return null;
}

/**
 * Build a sanitized deep-link URL for a frame, element, or view.
 * Preserves existing board/theme query params while stripping stale deep-link query params (`frame`/`el`/`view`).
 * When `search` is empty (or has only stale deep-link params), produces `${origin}${pathname}#${kind}=${encodedId}`.
 * @param {{ origin?: string, pathname?: string, search?: string, kind: "frame" | "el" | "view", id: string }} o
 * @returns {string | null}
 */
export function buildDeepLink({ origin = "", pathname = "/", search = "", kind, id }) {
  if (!DEEP_LINK_KINDS.includes(kind)) return null;
  const cleanId = typeof id === "string" ? id.trim() : "";
  if (!SAFE_TARGET_ID_RE.test(cleanId)) return null;
  const rawSearch = typeof search === "string" ? search.replace(/^\?/, "") : "";
  const kept = [];
  if (rawSearch) {
    for (const part of rawSearch.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const k = (eq >= 0 ? part.slice(0, eq) : part).trim();
      if (k === "frame" || k === "el" || k === "view") continue;
      kept.push(part);
    }
  }
  const encodedId = encodeURIComponent(cleanId);
  // When a query string is already present (e.g. `?board=<id>`), also include the deep-link param in the query
  // so it survives sign-in's hash-stripping (`takeSignIn` -> `replaceFragment`) while still carrying `#<kind>=<id>`.
  const hasQuery = kept.length > 0;
  const cleanSearch = hasQuery ? `?${kept.join("&")}&${kind}=${encodedId}` : "";
  const baseOrigin = typeof origin === "string" ? origin : "";
  const basePath = typeof pathname === "string" && pathname ? pathname : "/";
  return `${baseOrigin}${basePath}${cleanSearch}#${kind}=${encodedId}`;
}
