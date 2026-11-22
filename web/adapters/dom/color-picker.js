// @ts-check
// Custom Color Picker (Issue #105): pure color conversions, saved custom swatches via storage port,
// 2D SV pad, Hue + Opacity sliders, Hex/RGB/HSL mode inputs, and EyeDropper with canvas pixel-sampling fallback.

import { h as defaultH } from "./dom.js";
import { icon } from "./icons.js";

export const SWATCHES_KEY = "plenary.customSwatches";
export const MAX_CUSTOM_SWATCHES = 16;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const byteHex = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

/**
 * Parse a hex color (#rgb, #rgba, #rrggbb, #rrggbbaa, optional leading #) to { r, g, b, a }.
 * Returns null on invalid input.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function hexToRgba(hex) {
  if (typeof hex !== "string") return null;
  const raw = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  let r, g, b, a = 255;
  if (raw.length === 3 || raw.length === 4) {
    r = parseInt(raw[0] + raw[0], 16);
    g = parseInt(raw[1] + raw[1], 16);
    b = parseInt(raw[2] + raw[2], 16);
    if (raw.length === 4) a = parseInt(raw[3] + raw[3], 16);
  } else if (raw.length === 6 || raw.length === 8) {
    r = parseInt(raw.slice(0, 2), 16);
    g = parseInt(raw.slice(2, 4), 16);
    b = parseInt(raw.slice(4, 6), 16);
    if (raw.length === 8) a = parseInt(raw.slice(6, 8), 16);
  } else {
    return null;
  }
  return { r, g, b, a: Math.round((a / 255) * 1000) / 1000 };
}

/**
 * Format { r, g, b, a? } as #rrggbb (or #rrggbbaa when includeAlpha is true or a < 1).
 * @param {{ r: number, g: number, b: number, a?: number }} rgba
 * @param {boolean} [includeAlpha]
 * @returns {string}
 */
export function rgbaToHex(rgba, includeAlpha = false) {
  const r = clamp(Number(rgba?.r) || 0, 0, 255);
  const g = clamp(Number(rgba?.g) || 0, 0, 255);
  const b = clamp(Number(rgba?.b) || 0, 0, 255);
  const a = rgba?.a == null ? 1 : clamp(Number(rgba.a), 0, 1);
  const base = `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
  if (includeAlpha || a < 0.999) return `${base}${byteHex(a * 255)}`;
  return base;
}

/**
 * Convert RGB (0..255) to HSL ({ h: 0..360, s: 0..100, l: 0..100 }).
 */
export function rgbToHsl(r, g, b) {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    if (h < 0) h += 360;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Convert HSL (h: 0..360, s: 0..100, l: 0..100) to RGB ({ r, g, b } in 0..255).
 */
export function hslToRgb(h, s, l) {
  const hn = ((Number(h) || 0) % 360 + 360) % 360;
  const sn = clamp(Number(s) || 0, 0, 100) / 100;
  const ln = clamp(Number(l) || 0, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if (hn < 60) { rp = c; gp = x; }
  else if (hn < 120) { rp = x; gp = c; }
  else if (hn < 180) { gp = c; bp = x; }
  else if (hn < 240) { gp = x; bp = c; }
  else if (hn < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

/**
 * Convert RGB (0..255) to HSV ({ h: 0..360, s: 0..100, v: 0..100 }).
 */
export function rgbToHsv(r, g, b) {
  const rn = clamp(r, 0, 255) / 255;
  const gn = clamp(g, 0, 255) / 255;
  const bn = clamp(b, 0, 255) / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
    if (h < 0) h += 360;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), v: Math.round(v * 100) };
}

/**
 * Convert HSV (h: 0..360, s: 0..100, v: 0..100) to RGB ({ r, g, b } in 0..255).
 */
export function hsvToRgb(h, s, v) {
  const hn = ((Number(h) || 0) % 360 + 360) % 360;
  const sn = clamp(Number(s) || 0, 0, 100) / 100;
  const vn = clamp(Number(v) || 0, 0, 100) / 100;
  const c = vn * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = vn - c;
  let rp = 0, gp = 0, bp = 0;
  if (hn < 60) { rp = c; gp = x; }
  else if (hn < 120) { rp = x; gp = c; }
  else if (hn < 180) { gp = c; bp = x; }
  else if (hn < 240) { gp = x; bp = c; }
  else if (hn < 300) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

function parseAlpha(tok) {
  if (tok == null || tok === "") return 1;
  const s = tok.trim();
  if (s.endsWith("%")) {
    const p = Number(s.slice(0, -1));
    if (!Number.isFinite(p) || p < 0 || p > 100) return null;
    return Math.round((p / 100) * 1000) / 1000;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 1000) / 1000;
}

/**
 * Parse Hex, rgb()/rgba(), hsl()/hsla(), or "transparent" into { r, g, b, a }.
 * Returns null on invalid input.
 * @param {string} str
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function parseColor(str) {
  if (typeof str !== "string") return null;
  const s = str.trim().toLowerCase();
  if (!s) return null;
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith("#") || /^[0-9a-f]{3,8}$/i.test(s)) return hexToRgba(s);

  const rgbMatch = /^rgba?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(s);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]), g = Number(rgbMatch[2]), b = Number(rgbMatch[3]);
    const a = parseAlpha(rgbMatch[4]);
    if (![r, g, b].every(n => Number.isFinite(n) && n >= 0 && n <= 255) || a == null) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }

  const hslMatch = /^hsla?\(\s*(-?[0-9.]+)(?:deg)?\s*[,\s]\s*([0-9.]+)%\s*[,\s]\s*([0-9.]+)%(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/.exec(s);
  if (hslMatch) {
    const h = Number(hslMatch[1]), sat = Number(hslMatch[2]), lit = Number(hslMatch[3]);
    const a = parseAlpha(hslMatch[4]);
    if (!Number.isFinite(h) || !Number.isFinite(sat) || sat < 0 || sat > 100 || !Number.isFinite(lit) || lit < 0 || lit > 100 || a == null) return null;
    return { ...hslToRgb(h, sat, lit), a };
  }

  return null;
}

/** Format { r, g, b, a? } as rgb(...) or rgba(...). */
export function formatRgba(rgba) {
  const r = clamp(Math.round(Number(rgba?.r) || 0), 0, 255);
  const g = clamp(Math.round(Number(rgba?.g) || 0), 0, 255);
  const b = clamp(Math.round(Number(rgba?.b) || 0), 0, 255);
  const a = rgba?.a == null ? 1 : clamp(Number(rgba.a), 0, 1);
  if (a >= 0.995) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
}

/** Format { h, s, l, a? } as hsl(...) or hsla(...). */
export function formatHsla(hsla) {
  const h = ((Math.round(Number(hsla?.h) || 0) % 360) + 360) % 360;
  const s = clamp(Math.round(Number(hsla?.s) || 0), 0, 100);
  const l = clamp(Math.round(Number(hsla?.l) || 0), 0, 100);
  const a = hsla?.a == null ? 1 : clamp(Number(hsla.a), 0, 1);
  if (a >= 0.995) return `hsl(${h}, ${s}%, ${l}%)`;
  return `hsla(${h}, ${s}%, ${l}%, ${Number(a.toFixed(2))})`;
}

// ── Saved custom swatches (via storage port) ──

/** Load saved custom swatches from the storage port. Safe on missing/corrupt/unavailable storage. */
export function loadCustomSwatches(prefs) {
  try {
    const raw = prefs?.get?.(SWATCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const item of parsed) {
      const rgba = hexToRgba(item);
      if (!rgba) continue;
      const norm = rgbaToHex(rgba);
      if (!out.includes(norm)) out.push(norm);
      if (out.length >= MAX_CUSTOM_SWATCHES) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist custom swatches (deduped, bounded to MAX_CUSTOM_SWATCHES) via storage port. */
export function saveCustomSwatches(prefs, list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const rgba = hexToRgba(item);
    if (!rgba) continue;
    const norm = rgbaToHex(rgba);
    if (!out.includes(norm)) out.push(norm);
    if (out.length >= MAX_CUSTOM_SWATCHES) break;
  }
  try { prefs?.set?.(SWATCHES_KEY, JSON.stringify(out)); } catch {}
  return out;
}

/** Add a custom swatch (most recent first, bounded to MAX_CUSTOM_SWATCHES). */
export function addCustomSwatch(prefs, colorStr) {
  const rgba = parseColor(colorStr);
  if (!rgba) return loadCustomSwatches(prefs);
  const norm = rgbaToHex(rgba);
  const cur = loadCustomSwatches(prefs).filter(c => c !== norm);
  return saveCustomSwatches(prefs, [norm, ...cur].slice(0, MAX_CUSTOM_SWATCHES));
}

/** Remove a custom swatch by hex color. */
export function removeCustomSwatch(prefs, colorStr) {
  const rgba = parseColor(colorStr);
  const norm = rgba ? rgbaToHex(rgba) : String(colorStr || "").toLowerCase();
  const cur = loadCustomSwatches(prefs).filter(c => c !== norm);
  return saveCustomSwatches(prefs, cur);
}

/**
 * Sample a single pixel from a 2D canvas at client coordinates (fallback for browsers without EyeDropper).
 * @param {HTMLCanvasElement} canvas
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string | null}
 */
export function sampleCanvasPixel(canvas, clientX, clientY) {
  if (!canvas || typeof canvas.getContext !== "function") return null;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.getImageData !== "function") return null;
  const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: canvas.width || 1, height: canvas.height || 1 };
  const scaleX = (canvas.width || 1) / Math.max(1, rect.width || 1);
  const scaleY = (canvas.height || 1) / Math.max(1, rect.height || 1);
  const px = clamp(Math.floor((clientX - rect.left) * scaleX), 0, Math.max(0, (canvas.width || 1) - 1));
  const py = clamp(Math.floor((clientY - rect.top) * scaleY), 0, Math.max(0, (canvas.height || 1) - 1));
  try {
    const data = ctx.getImageData(px, py, 1, 1)?.data;
    if (!data || data.length < 3) return null;
    return rgbaToHex({ r: data[0], g: data[1], b: data[2], a: 1 });
  } catch {
    return null;
  }
}

// Module-level active canvas sampler cleanup so panel rebuilds or picker switches never leak listeners.
let activeSamplerCleanup = null;

/** Cancel any in-flight canvas eyedropper sampling session and clean up its listeners. */
export function cancelActiveSampler() {
  if (activeSamplerCleanup) {
    const fn = activeSamplerCleanup;
    activeSamplerCleanup = null;
    fn();
  }
}

/**
 * Build an interactive Custom Color Picker DOM subtree.
 * Works inline inside desktop inspector popovers and mobile bottom sheets.
 * @param {{
 *   value?: string,
 *   disabled?: boolean,
 *   prefs?: { get(k: string): string | null, set(k: string, v: string): void } | null,
 *   canvas?: HTMLCanvasElement | null,
 *   pickerState?: { h?: number | null, mode?: string } | null,
 *   onChange: (hex: string) => void,
 *   onClose?: () => void,
 *   h?: typeof defaultH,
 * }} opts
 */
export function createColorPicker({ value = "#3b48e8", disabled = false, prefs = null, canvas = null, pickerState = null, onChange, onClose = null, h = defaultH }) {
  const initial = parseColor(value) ?? { r: 59, g: 72, b: 232, a: 1 };
  const hsv0 = rgbToHsv(initial.r, initial.g, initial.b);
  const achromatic0 = hsv0.s === 0 || hsv0.v === 0;
  const preservedH = achromatic0 && Number.isFinite(pickerState?.h) ? pickerState.h : hsv0.h;
  const preservedMode = pickerState?.mode && ["hex", "rgb", "hsl"].includes(pickerState.mode) ? pickerState.mode : "hex";
  const state = {
    h: preservedH,
    s: hsv0.s,
    v: hsv0.v,
    r: initial.r,
    g: initial.g,
    b: initial.b,
    a: value === "transparent" ? 1 : initial.a,
    mode: preservedMode,
    sampling: false,
    swatches: loadCustomSwatches(prefs),
  };
  if (pickerState) {
    pickerState.h = state.h;
    pickerState.mode = state.mode;
  }

  const syncRgbFromHsv = () => {
    const rgb = hsvToRgb(state.h, state.s, state.v);
    state.r = rgb.r; state.g = rgb.g; state.b = rgb.b;
  };
  const currentRgba = () => ({ r: state.r, g: state.g, b: state.b, a: state.a });
  const currentHex = () => rgbaToHex(currentRgba());
  const formatForMode = () => {
    const rgba = currentRgba();
    if (state.mode === "rgb") return formatRgba(rgba);
    if (state.mode === "hsl") return formatHsla({ ...rgbToHsl(rgba.r, rgba.g, rgba.b), a: rgba.a });
    return rgbaToHex(rgba);
  };

  let stopSampling = null;
  const cancelSampling = () => {
    if (stopSampling) {
      const fn = stopSampling;
      stopSampling = null;
      if (activeSamplerCleanup === fn) activeSamplerCleanup = null;
      fn();
    }
    state.sampling = false;
    eyedropBtn.classList.remove("on");
  };

  // 2D Saturation / Value pad (preview live on pointerdown/move; commit once on pointerup)
  const thumb = h("div.cp-sv-thumb");
  const svBox = h("div.cp-sv-box", { role: "slider", "aria-label": "Saturation and brightness" }, thumb);

  const updateSvFromPointer = e => {
    if (disabled) return;
    const rect = svBox.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 200, height: 120 };
    const x = clamp(((e.clientX ?? 0) - rect.left) / Math.max(1, rect.width), 0, 1);
    const y = clamp(((e.clientY ?? 0) - rect.top) / Math.max(1, rect.height), 0, 1);
    state.s = Math.round(x * 100);
    state.v = Math.round((1 - y) * 100);
    syncRgbFromHsv();
    syncUi();
  };

  let draggingSv = false;
  svBox.addEventListener("pointerdown", e => {
    if (disabled) return;
    draggingSv = true;
    svBox.setPointerCapture?.(e.pointerId);
    e.preventDefault?.();
    updateSvFromPointer(e);
  });
  svBox.addEventListener("pointermove", e => {
    if (!draggingSv) return;
    updateSvFromPointer(e);
  });
  svBox.addEventListener("pointerup", e => {
    if (!draggingSv) return;
    draggingSv = false;
    if (e && (e.clientX != null || e.clientY != null)) updateSvFromPointer(e);
    onChange?.(currentHex());
  });
  svBox.addEventListener("pointercancel", () => { draggingSv = false; });

  // Hue & Opacity sliders (preview live on input; commit once on change)
  const hueInput = h("input.cp-range.cp-hue", {
    type: "range", min: "0", max: "360", value: String(state.h), disabled, "aria-label": "Hue",
    oninput: e => {
      if (disabled) return;
      state.h = clamp(Number(e.target.value) || 0, 0, 360);
      if (pickerState) pickerState.h = state.h;
      syncRgbFromHsv();
      syncUi();
    },
    onchange: e => {
      if (disabled) return;
      state.h = clamp(Number(e.target.value) || 0, 0, 360);
      if (pickerState) pickerState.h = state.h;
      syncRgbFromHsv();
      syncUi();
      onChange?.(currentHex());
    },
  });
  const alphaInput = h("input.cp-range.cp-alpha", {
    type: "range", min: "0", max: "100", value: String(Math.round(state.a * 100)), disabled, "aria-label": "Opacity",
    oninput: e => {
      if (disabled) return;
      state.a = clamp(Number(e.target.value) || 0, 0, 100) / 100;
      syncUi();
    },
    onchange: e => {
      if (disabled) return;
      state.a = clamp(Number(e.target.value) || 0, 0, 100) / 100;
      syncUi();
      onChange?.(currentHex());
    },
  });

  // EyeDropper button (native EyeDropper API with canvas pixel-sampling fallback)
  const applyParsed = colorStr => {
    const parsed = parseColor(colorStr);
    if (!parsed) return false;
    const hsv = rgbToHsv(parsed.r, parsed.g, parsed.b);
    if (hsv.s > 0 && hsv.v > 0) {
      state.h = hsv.h;
      if (pickerState) pickerState.h = state.h;
    }
    state.s = hsv.s; state.v = hsv.v;
    state.r = parsed.r; state.g = parsed.g; state.b = parsed.b; state.a = parsed.a;
    syncUi();
    onChange?.(currentHex());
    return true;
  };

  const eyedropBtn = h("button.cp-eyedrop", {
    type: "button", title: "Pick color from screen or canvas", "aria-label": "Eyedropper", disabled,
    onclick: async () => {
      if (disabled) return;
      if (state.sampling) { cancelSampling(); return; }
      if (typeof globalThis.EyeDropper === "function") {
        try {
          const dropper = new globalThis.EyeDropper();
          const res = await dropper.open();
          if (res?.sRGBHex) applyParsed(res.sRGBHex);
        } catch {}
        return;
      }
      // Fallback: sample pixel directly from the board canvas on next pointerdown
      // Attach on document in capture phase so it intercepts BEFORE canvas's own pointerdown/pointerup listeners.
      if (!canvas) return;
      cancelActiveSampler();
      state.sampling = true;
      eyedropBtn.classList.add("on");
      const prevCursor = canvas.style?.cursor ?? "";
      if (canvas.style) canvas.style.cursor = "crosshair";
      let swallowUp = null;
      const removeSwallowUp = () => {
        if (swallowUp) {
          document.removeEventListener("pointerup", swallowUp, true);
          swallowUp = null;
        }
      };
      const cleanup = () => {
        document.removeEventListener("pointerdown", onPick, true);
        document.removeEventListener("keydown", onKey, true);
        if (canvas.style) canvas.style.cursor = prevCursor;
        state.sampling = false;
        eyedropBtn.classList.remove("on");
      };
      const onPick = ev => {
        if (ev.target && ev.target !== canvas && !canvas.contains?.(ev.target)) return;
        ev.preventDefault?.();
        ev.stopPropagation?.();
        ev.stopImmediatePropagation?.();
        const hex = sampleCanvasPixel(canvas, ev.clientX ?? 0, ev.clientY ?? 0);
        // Swallow the matching pointerup so canvas never processes a stray release
        swallowUp = upEv => {
          upEv.preventDefault?.();
          upEv.stopPropagation?.();
          upEv.stopImmediatePropagation?.();
          removeSwallowUp();
        };
        document.addEventListener("pointerup", swallowUp, true);
        cancelSampling();
        if (hex) applyParsed(hex);
      };
      const onKey = ev => {
        if (ev.key === "Escape") {
          ev.preventDefault?.();
          ev.stopPropagation?.();
          ev.stopImmediatePropagation?.();
          removeSwallowUp();
          cancelSampling();
        }
      };
      document.addEventListener("pointerdown", onPick, true);
      document.addEventListener("keydown", onKey, true);
      stopSampling = cleanup;
      activeSamplerCleanup = () => { removeSwallowUp(); cleanup(); };
    },
  }, icon("eyedropper", { size: 16 }));

  // Format selector (HEX / RGB / HSL) + editable input + alpha readout
  const modeBtns = ["hex", "rgb", "hsl"].map(m => h("button.cp-mode-btn" + (state.mode === m ? ".on" : ""), {
    type: "button", "data-mode": m,
    onclick: () => {
      state.mode = m;
      if (pickerState) pickerState.mode = m;
      for (const b of modeBtns) b.classList.toggle("on", b.getAttribute("data-mode") === m);
      textInput.classList.remove("cp-invalid");
      textInput.value = formatForMode();
    },
  }, m.toUpperCase()));

  const textInput = h("input.cp-input", {
    type: "text", value: formatForMode(), disabled, "aria-label": "Color value", spellcheck: false,
    onkeydown: e => {
      e.stopPropagation?.();
      if (e.key === "Enter") commitText();
    },
    onchange: () => commitText(),
  });
  const alphaReadout = h("span.cp-alpha-val", {}, `${Math.round(state.a * 100)}%`);

  function commitText() {
    if (disabled) return;
    const ok = applyParsed(textInput.value);
    textInput.classList.toggle("cp-invalid", !ok);
  }

  // Saved custom swatches row
  const swatchesWrap = h("div.cp-saved-swatches");
  function renderSwatches() {
    const cur = currentHex();
    const nodes = state.swatches.map(hex => h("div.cp-saved-item", {},
      h("button.sw.cp-saved-sw" + (hex === cur ? ".on" : ""), {
        type: "button", title: hex, "aria-label": `Select saved color ${hex}`, disabled,
        style: { background: hex },
        onclick: () => applyParsed(hex),
      }),
      !disabled ? h("button.cp-saved-del", {
        type: "button", title: `Remove ${hex}`, "aria-label": `Remove ${hex}`,
        onclick: ev => {
          ev.stopPropagation?.();
          state.swatches = removeCustomSwatch(prefs, hex);
          renderSwatches();
        },
      }, icon("close", { size: 10 })) : null,
    ));
    if (!disabled) {
      nodes.push(h("button.cp-swatch-add", {
        type: "button", title: "Save current color", "aria-label": "Save custom color",
        onclick: () => {
          state.swatches = addCustomSwatch(prefs, currentHex());
          renderSwatches();
        },
      }, icon("plus", { size: 14 })));
    }
    swatchesWrap.replaceChildren(...nodes);
  }

  function syncUi() {
    const solid = rgbaToHex({ ...hsvToRgb(state.h, state.s, state.v), a: 1 });
    svBox.style.backgroundColor = `hsl(${state.h}, 100%, 50%)`;
    thumb.style.left = `${state.s}%`;
    thumb.style.top = `${100 - state.v}%`;
    hueInput.value = String(state.h);
    alphaInput.value = String(Math.round(state.a * 100));
    alphaInput.style.setProperty("--picker-solid", solid);
    alphaReadout.textContent = `${Math.round(state.a * 100)}%`;
    textInput.value = formatForMode();
    textInput.classList.remove("cp-invalid");
  }

  syncUi();
  renderSwatches();

  const header = onClose
    ? h("div.cp-head", {},
        h("span.cp-title", {}, "Custom color"),
        h("button.tb.cp-close", { type: "button", title: "Close color picker", "aria-label": "Close color picker", onclick: () => { cancelSampling(); onClose(); } }, icon("close", { size: 14 })))
    : null;

  return h("div.color-picker", { "data-component": "color-picker" },
    header,
    svBox,
    h("div.cp-slider-row", {},
      eyedropBtn,
      h("div.cp-sliders-col", {}, hueInput, alphaInput),
    ),
    h("div.cp-format-row", {},
      h("div.cp-format-seg", {}, ...modeBtns),
      textInput,
      alphaReadout,
    ),
    h("div.cp-saved-sec", {},
      h("span.cp-saved-lab", {}, "Saved"),
      swatchesWrap,
    ),
  );
}
