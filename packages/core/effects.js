// @ts-check
// Pure visual effects model: WebKit/iOS-safe blend modes (Canvas globalCompositeOperation / SVG mix-blend-mode)
// and vector shape clipping masks (Canvas ctx.clip() / SVG <clipPath>). Zero ctx.filter usage.

/** @typedef {"normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "difference"} BlendMode */
/** @typedef {"none" | "rect" | "rounded" | "ellipse" | "diamond"} ClipShape */
/** @typedef {{ blendMode: BlendMode, clipShape: ClipShape, clipRadius?: number }} ElementEffects */
/** @typedef {["M", number, number] | ["L", number, number] | ["Q", number, number, number, number]} PathCmd */

/** Allowlisted blend modes supported consistently across Canvas 2D (WebKit/iOS) and SVG. */
export const BLEND_MODES = Object.freeze(
  /** @type {readonly BlendMode[]} */ (["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference"]),
);

/** Allowlisted vector clipping mask shapes. */
export const CLIP_SHAPES = Object.freeze(
  /** @type {readonly ClipShape[]} */ (["none", "rect", "rounded", "ellipse", "diamond"]),
);

const BLEND_MODE_SET = new Set(/** @type {readonly string[]} */ (BLEND_MODES));
const CLIP_SHAPE_SET = new Set(/** @type {readonly string[]} */ (CLIP_SHAPES));

/**
 * Validate and normalize a blend mode against the strict allowlist.
 * @param {unknown} mode
 * @returns {BlendMode}
 */
export function normalizeBlendMode(mode) {
  if (typeof mode !== "string") return "normal";
  const m = mode.trim().toLowerCase();
  return BLEND_MODE_SET.has(m) ? /** @type {BlendMode} */ (m) : "normal";
}

/**
 * Validate and normalize a clip shape against the strict allowlist.
 * @param {unknown} shape
 * @returns {ClipShape}
 */
export function normalizeClipShape(shape) {
  if (typeof shape !== "string") return "none";
  const s = shape.trim().toLowerCase();
  return CLIP_SHAPE_SET.has(s) ? /** @type {ClipShape} */ (s) : "none";
}

/**
 * Map a blend mode to a Canvas 2D `globalCompositeOperation` value ("normal" → "source-over").
 * Strictly allowlisted; invalid values fall back to "source-over".
 * @param {unknown} mode
 * @returns {GlobalCompositeOperation}
 */
export function toCanvasComposite(mode) {
  const m = normalizeBlendMode(mode);
  return /** @type {GlobalCompositeOperation} */ (m === "normal" ? "source-over" : m);
}

/**
 * Map a blend mode to a CSS/SVG `mix-blend-mode` value, or `null` for "normal" / invalid values.
 * Strictly allowlisted to prevent CSS injection in exported SVGs.
 * @param {unknown} mode
 * @returns {Exclude<BlendMode, "normal"> | null}
 */
export function toSvgBlendMode(mode) {
  const m = normalizeBlendMode(mode);
  return m === "normal" ? null : m;
}

/**
 * Normalize raw effects metadata into a validated `{ blendMode, clipShape, clipRadius? }` object.
 * @param {any} raw
 * @returns {ElementEffects}
 */
export function normalizeEffects(raw) {
  if (!raw || typeof raw !== "object") {
    return { blendMode: "normal", clipShape: "none" };
  }
  const blendMode = normalizeBlendMode(raw.blendMode);
  const clipShape = normalizeClipShape(raw.clipShape);
  /** @type {ElementEffects} */
  const out = { blendMode, clipShape };
  if (typeof raw.clipRadius === "number" && Number.isFinite(raw.clipRadius) && raw.clipRadius >= 0) {
    out.clipRadius = raw.clipRadius;
  }
  return out;
}

/**
 * Safely read and normalize `el.customData?.effects`.
 * @param {any} el
 * @returns {ElementEffects}
 */
export function effectsOf(el) {
  return normalizeEffects(el?.customData?.effects);
}

/**
 * Generate pure normalized path commands (`["M",x,y]`, `["L",x,y]`, `["Q",x,y,cx,cy]`)
 * for a closed clipping shape inside `(x, y, w, h)`.
 * Shared by Canvas 2D `ctx.clip()` and SVG `<clipPath>` for pixel-identical parity.
 * @param {unknown} shape
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} [radius]
 * @returns {PathCmd[]}
 */
export function clipPathCommands(shape, x, y, w, h, radius) {
  const s = normalizeClipShape(shape);
  if (s === "none") return [];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return [];
  if (!(w > 0 && h > 0)) return [];

  if (s === "rect") {
    return [
      ["M", x, y],
      ["L", x + w, y],
      ["L", x + w, y + h],
      ["L", x, y + h],
    ];
  }

  if (s === "diamond") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    return [
      ["M", cx, y],
      ["L", x + w, cy],
      ["L", cx, y + h],
      ["L", x, cy],
    ];
  }

  if (s === "rounded") {
    const rawR = typeof radius === "number" && Number.isFinite(radius) ? radius : Math.min(w, h) * 0.2;
    const r = Math.max(0, Math.min(rawR, w / 2, h / 2));
    if (r <= 0) {
      return [
        ["M", x, y],
        ["L", x + w, y],
        ["L", x + w, y + h],
        ["L", x, y + h],
      ];
    }
    return [
      ["M", x + r, y],
      ["L", x + w - r, y],
      ["Q", x + w, y + r, x + w, y],
      ["L", x + w, y + h - r],
      ["Q", x + w - r, y + h, x + w, y + h],
      ["L", x + r, y + h],
      ["Q", x, y + h - r, x, y + h],
      ["L", x, y + r],
      ["Q", x + r, y, x, y],
    ];
  }

  // "ellipse": 16 tangent-aligned quadratic Bezier segments (< 0.01% radial error)
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const N = 16;
  const step = (Math.PI * 2) / N;
  const invCos = 1 / Math.cos(step / 2);
  /** @type {PathCmd[]} */
  const cmds = [["M", cx + rx, cy]];
  for (let i = 0; i < N; i++) {
    const a0 = i * step;
    const a1 = (i + 1) * step;
    const am = (a0 + a1) / 2;
    const ctrlX = cx + rx * Math.cos(am) * invCos;
    const ctrlY = cy + ry * Math.sin(am) * invCos;
    const endX = cx + rx * Math.cos(a1);
    const endY = cy + ry * Math.sin(a1);
    cmds.push(["Q", endX, endY, ctrlX, ctrlY]);
  }
  return cmds;
}
