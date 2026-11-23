// @ts-check
// Display list → Canvas2D. Paints what core's render.js / Editor.displayList emits, already in screen
// pixels (logical, zoom 1), so the board's own view is never applied here:
//   { t: "path", cmds, stroke, width, dash?, opacity? }   cmds: ["M",x,y] ["L",x,y] ["Q",x,y,cx,cy]
//   { t: "path", cmds, fill, opacity? }                    closed polygon
//   { t: "text", x, y, text, size, color, align, box?, lineHeight, font?, angle?, cx?, cy?, opacity?, reveal? }
//   { t: "image", fileId, x, y, w, h, angle, cx, cy, opacity? }
// Matches herdr-draw's SVG adapter (adapters/svg/svg.js): text baselines at lineHeight·(i + 0.75), labels
// centred in their box, rotation about (cx, cy), `reveal` as a typewriter.
//
// Pure: paint(ctx, items, view) touches only ctx. Pictures come in through view.image(fileId), which returns
// something drawImage takes, or null while it loads (the page owns loading; see imageCache).

import { toCanvasComposite, clipPathCommands } from "../../../packages/core/effects.js";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
// Board content is untrusted: only hex colors reach the context (as in the SVG adapter).
export const color = c => (HEX.test(c ?? "") ? c : "#888888");

export const FACES = {
  hand: "Excalifont, Virgil, 'Chalkboard SE', 'Comic Sans MS', cursive",
  mono: "'Cascadia Code', Menlo, Consolas, monospace",
  sans: "Helvetica, Arial, sans-serif",
};

/** Maximum canvas backing-store pixel area (≈ 8 MP): keeps 3× iPhones crisp within WKWebView GPU limits. */
export const MAX_CANVAS_PIXELS = 8_388_608;

/** Compute effective DPR capped so `cssW * cssH * dpr^2 <= maxPixels`. */
export function cappedDpr(cssW, cssH, dpr = 1, maxPixels = MAX_CANVAS_PIXELS) {
  const w = Math.max(1, num(cssW, 1)), h = Math.max(1, num(cssH, 1));
  const raw = num(dpr, 1) > 0 ? num(dpr, 1) : 1;
  const area = w * h * raw * raw;
  if (area <= maxPixels) return raw;
  return Math.max(1, Math.sqrt(maxPixels / (w * h)));
}

/** Light and dark themes in core's shape ({ fg, bg, accent, dim }), synced with Warm Studio Paper / Obsidian Studio tokens. */
export const THEMES = {
  light: { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" },
  dark: { fg: "#F4F4F5", bg: "#111113", accent: "#818CF8", dim: "#91919E" },
};

function trace(ctx, cmds) {
  ctx.beginPath();
  for (const c of cmds) {
    if (c[0] === "M") ctx.moveTo(num(c[1]), num(c[2]));
    else if (c[0] === "L") ctx.lineTo(num(c[1]), num(c[2]));
    else if (c[0] === "Q") ctx.quadraticCurveTo(num(c[3]), num(c[4]), num(c[1]), num(c[2]));   // [Q, x, y, cx, cy]
  }
}

function rotated(ctx, it, draw) {
  const a = num(it.angle);
  if (!a) return draw();
  ctx.save();
  ctx.translate(num(it.cx), num(it.cy)); ctx.rotate(a); ctx.translate(-num(it.cx), -num(it.cy));
  draw();
  ctx.restore();
}

function clipped(ctx, clip, draw) {
  if (!clip) return draw();
  const x = num(clip.x), y = num(clip.y), w = num(clip.w), h = num(clip.h);
  if (!(w > 0 && h > 0)) return;
  ctx.save();
  const a = num(clip.angle);
  if (a) {
    const cx = num(clip.cx), cy = num(clip.cy);
    ctx.translate(cx, cy); ctx.rotate(a); ctx.translate(-cx, -cy);
  }
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (a) {
    const cx = num(clip.cx), cy = num(clip.cy);
    ctx.translate(cx, cy); ctx.rotate(-a); ctx.translate(-cx, -cy);
  }
  draw();
  ctx.restore();
}

function resolveClipShape(it) {
  const cs = it?.clipShape;
  if (!cs) return null;
  if (typeof cs === "string") {
    if (cs === "none") return null;
    const box = it.box ?? it;
    const x = num(box.x), y = num(box.y), w = num(box.w), h = num(box.h);
    return { shape: cs, x, y, w, h, radius: undefined, angle: num(it.angle), cx: num(it.cx, x + w / 2), cy: num(it.cy, y + h / 2) };
  }
  if (typeof cs === "object" && cs.shape && cs.shape !== "none") {
    const x = num(cs.x), y = num(cs.y), w = num(cs.w), h = num(cs.h);
    return {
      shape: cs.shape, x, y, w, h,
      radius: cs.radius,
      cmds: Array.isArray(cs.cmds) && cs.cmds.length ? cs.cmds : null,
      angle: num(cs.angle), cx: num(cs.cx, x + w / 2), cy: num(cs.cy, y + h / 2),
    };
  }
  return null;
}

function withClipShape(ctx, cs, draw) {
  if (!cs) return draw();
  const cmds = cs.cmds ?? clipPathCommands(cs.shape, cs.x, cs.y, cs.w, cs.h, cs.radius);
  if (!cmds.length) return;
  ctx.save();
  const a = num(cs.angle);
  if (a) {
    const cx = num(cs.cx), cy = num(cs.cy);
    ctx.translate(cx, cy); ctx.rotate(a); ctx.translate(-cx, -cy);
  }
  trace(ctx, cmds);
  ctx.closePath();
  ctx.clip();
  if (a) {
    const cx = num(cs.cx), cy = num(cs.cy);
    ctx.translate(cx, cy); ctx.rotate(-a); ctx.translate(-cx, -cy);
  }
  draw();
  ctx.restore();
}

function withBlendMode(ctx, blendMode, draw) {
  const op = toCanvasComposite(blendMode);
  if (op === "source-over") return draw();
  ctx.save();
  ctx.globalCompositeOperation = op;
  draw();
  ctx.restore();
}

function resolveCropSource(crop, src) {
  if (!crop || typeof crop !== "object") return null;
  const cx = num(crop.x, 0), cy = num(crop.y, 0);
  const cw = num(crop.width, 0), ch = num(crop.height, 0);
  if (!(cw > 0 && ch > 0)) return null;
  const cNatW = num(crop.naturalWidth, 0), cNatH = num(crop.naturalHeight, 0);
  const srcW = num(src?.naturalWidth ?? src?.width, 0);
  const srcH = num(src?.naturalHeight ?? src?.height, 0);
  let sx = cx, sy = cy, sw = cw, sh = ch;
  let maxW = cNatW > 0 ? cNatW : srcW;
  let maxH = cNatH > 0 ? cNatH : srcH;
  if (srcW > 0 && cNatW > 0 && srcW !== cNatW) {
    const rx = srcW / cNatW;
    sx *= rx; sw *= rx; maxW = srcW;
  }
  if (srcH > 0 && cNatH > 0 && srcH !== cNatH) {
    const ry = srcH / cNatH;
    sy *= ry; sh *= ry; maxH = srcH;
  }
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  if (maxW > 0) {
    if (sx >= maxW) return null;
    sw = Math.min(sw, maxW - sx);
  }
  if (maxH > 0) {
    if (sy >= maxH) return null;
    sh = Math.min(sh, maxH - sy);
  }
  if (!(sw > 0 && sh > 0)) return null;
  return { sx, sy, sw, sh };
}

/**
 * Paint a display list.
 * @param {CanvasRenderingContext2D} ctx
 * @param {any[]} items  editor.displayList(theme)
 * @param {{ width: number, height: number, dpr?: number, background?: string,
 *           image?: (fileId: string) => CanvasImageSource | null, faces?: Record<string, string> }} view
 */
export function paint(ctx, items, view) {
  const dpr = num(view.dpr, 1) > 0 ? num(view.dpr, 1) : 1, faces = view.faces ?? FACES;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  if (view.background) { ctx.fillStyle = color(view.background); ctx.fillRect(0, 0, num(view.width), num(view.height)); }
  else ctx.clearRect(0, 0, num(view.width), num(view.height));
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const it of items) {
    const op = Math.max(0, Math.min(1, num(it.opacity, 1)));
    if (op <= 0) continue;
    ctx.globalAlpha = op;
    withBlendMode(ctx, it.blendMode, () => {
      clipped(ctx, it.clip, () => {
        withClipShape(ctx, resolveClipShape(it), () => {
          if (it.t === "path") {
            if (!Array.isArray(it.cmds) || !it.cmds.length) return;
            trace(ctx, it.cmds);
            if (it.fill) { ctx.closePath(); ctx.fillStyle = color(it.fill); ctx.fill(); }
            else {
              const w = num(it.width, 1);
              if (!(w > 0)) return;   // canvas ignores a width of 0 or less and would keep the previous one
              ctx.strokeStyle = color(it.stroke); ctx.lineWidth = w;
              ctx.setLineDash(Array.isArray(it.dash) ? it.dash.map(v => num(v)) : []);
              ctx.stroke();
            }
          } else if (it.t === "text") {
            let text = String(it.text ?? "");
            if (it.reveal != null && it.reveal < 1) text = text.slice(0, Math.round(text.length * Math.max(0, it.reveal)));
            if (!text) return;
            const size = num(it.size, 16);
            if (!(size > 0)) return;
            const lh = size * num(it.lineHeight, 1.25), lines = text.split("\n");
            const face = Object.prototype.hasOwnProperty.call(faces, it.font) ? faces[it.font] : faces.sans;   // own keys only
            ctx.font = `${size.toFixed(1)}px ${face}`;
            ctx.fillStyle = color(it.color);
            ctx.textBaseline = "alphabetic";
            rotated(ctx, it, () => {
              if (it.box) {
                const cx = num(it.box.x) + num(it.box.w) / 2, top = num(it.box.y) + num(it.box.h) / 2 - (lines.length * lh) / 2;
                ctx.textAlign = "center";
                lines.forEach((l, i) => ctx.fillText(l, cx, top + lh * (i + 0.75)));
              } else {
                ctx.textAlign = "left";
                lines.forEach((l, i) => ctx.fillText(l, num(it.x), num(it.y) + lh * (i + 0.75)));
              }
            });
          } else if (it.t === "image") {
            const src = view.image?.(it.fileId);
            const w = num(it.w), h = num(it.h);
            if (!src || !(w > 0 && h > 0)) return;   // skip zero/negative dimensions during scale or flip animations
            const dx = num(it.x), dy = num(it.y);
            if (it.crop) {
              const c = resolveCropSource(it.crop, src);
              if (!c) return;
              rotated(ctx, it, () => ctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, dx, dy, w, h));
            } else {
              rotated(ctx, it, () => ctx.drawImage(src, dx, dy, w, h));
            }
          } else if (it.t === "video") {
            const x = num(it.x), y = num(it.y), w = num(it.w), h = num(it.h);
            if (!(w > 0 && h > 0)) return;
            rotated(ctx, it, () => {
              ctx.fillStyle = "#18181b";
              ctx.fillRect(x, y, w, h);
              ctx.strokeStyle = "#52525b";
              ctx.lineWidth = 1;
              ctx.setLineDash(it.status === "pending" ? [6, 4] : []);
              ctx.strokeRect(x, y, w, h);
              ctx.setLineDash([]);
              // Centered play-icon badge for canvas fallback / PNG exports / thumbnails
              const r = Math.min(24, Math.max(8, Math.min(w, h) * 0.16));
              const cx = x + w / 2, cy = y + h / 2;
              if (w >= 24 && h >= 24) {
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(255,255,255,0.22)";
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(cx - r * 0.32, cy - r * 0.45);
                ctx.lineTo(cx + r * 0.5, cy);
                ctx.lineTo(cx - r * 0.32, cy + r * 0.45);
                ctx.closePath();
                ctx.fillStyle = "#ffffff";
                ctx.fill();
              }
            });
          }
        });
      });
    });
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// Only base64 raster data URLs become pictures: a board's files are untrusted. SVG is left out (unlike the
// SVG adapter): some browsers taint a canvas that drew one, which would break PNG export.
export const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * A browser-side picture cache for view.image: decodes each file once, calls onLoad when one is ready.
 * @param {() => Record<string, { dataURL?: string }>} files  the Editor's doc.files (read each time)
 * @param {(fileId: string) => void} [onLoad]
 * @param {() => HTMLImageElement} [make]
 */
export function imageCache(files, onLoad = () => {}, make = () => new Image()) {
  const cache = new Map();
  return fileId => {
    if (cache.has(fileId)) { const c = cache.get(fileId); return c.ready ? c.img : null; }
    const url = files()?.[fileId]?.dataURL;
    if (typeof url !== "string" || !DATA_URL.test(url)) return null;
    const c = { img: make(), ready: false };
    cache.set(fileId, c);
    c.img.onload = () => { c.ready = true; onLoad(fileId); };
    c.img.src = url;
    return null;
  };
}
