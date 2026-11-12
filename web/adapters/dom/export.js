// Export: the board stream as SVG or PNG. Core's exportScene says what to paint, cropped (export.js);
// writing pixels or markup is the adapter's job. The SVG writer is herdr-draw's adapters/svg/svg.js, ported
// with its sanitising intact (board content is untrusted: an exported SVG opened in a browser must not run
// anything). PNG paints the same items through ./paint.js onto a canvas, so it matches the screen.
// Notes, selection, cursors and comments never show: only the board Editor's doc goes in.

import { exportScene, boardTheme, LIGHT, DARK } from "../../../packages/core/export.js";
import { paint, imageCache, FACES } from "./paint.js";

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

// #rrggbbaa → color + opacity, since not every SVG renderer reads 8-digit hex.
function color(c, opacity = 1) {
  if (!HEX.test(c ?? "")) return ["#888888", opacity];
  if (c.length === 9) return [c.slice(0, 7), (parseInt(c.slice(7), 16) / 255) * opacity];
  return [c, opacity];
}
function d(cmds) {
  const f = v => num(v).toFixed(1);
  return cmds.map(c => (c[0] === "Q" ? `Q${f(c[3])} ${f(c[4])} ${f(c[1])} ${f(c[2])}` : `${c[0] === "L" ? "L" : "M"}${f(c[1])} ${f(c[2])}`)).join("");
}

/** Display list → SVG text. `scale`: pixels per unit; the viewBox stays in drawing units. */
export function toSvg(items, { width, height, background, files = {}, scale = 1, faces = FACES } = {}) {
  width = num(width, 800); height = num(height, 600); scale = num(scale, 1) > 0 ? num(scale, 1) : 1;
  const px = v => +(v * scale).toFixed(2), face = k => esc(faces[k] ?? faces.sans);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="0 0 ${width} ${height}">`];
  if (background) out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${color(background)[0]}"/>`);
  for (const it of items) {
    const op = Math.max(0, Math.min(1, num(it.opacity, 1)));
    if (it.t === "path") {
      if (!Array.isArray(it.cmds) || !it.cmds.length) continue;
      if (it.fill) { const [c, o] = color(it.fill, op); out.push(`<path d="${d(it.cmds)}Z" fill="${c}" fill-opacity="${o.toFixed(3)}"/>`); }
      else { const [c, o] = color(it.stroke, op); out.push(`<path d="${d(it.cmds)}" fill="none" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="${num(it.width, 1)}" stroke-linecap="round" stroke-linejoin="round"${Array.isArray(it.dash) ? ` stroke-dasharray="${it.dash.map(v => num(v)).join(" ")}"` : ""}/>`); }
    } else if (it.t === "image") {
      const url = files?.[it.fileId]?.dataURL;
      if (typeof url !== "string" || !DATA_URL.test(url)) continue;
      const deg = num(it.angle) * 180 / Math.PI;
      const turn = deg ? ` transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})"` : "";
      out.push(`<image href="${url}" x="${num(it.x).toFixed(1)}" y="${num(it.y).toFixed(1)}" width="${Math.max(0, num(it.w)).toFixed(1)}" height="${Math.max(0, num(it.h)).toFixed(1)}" preserveAspectRatio="none" opacity="${op.toFixed(3)}"${turn}/>`);
    } else if (it.t === "text") {
      const text = String(it.text ?? ""); if (!text) continue;
      const deg = num(it.angle) * 180 / Math.PI;
      if (deg) out.push(`<g transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})">`);
      const size = num(it.size, 16), lines = text.split("\n"), lh = size * num(it.lineHeight, 1.25), [c, o] = color(it.color, op);
      const attrs = `font-family="${face(it.font)}" font-size="${size.toFixed(1)}" fill="${c}" fill-opacity="${o.toFixed(3)}"`;
      if (it.box) {
        const cx = num(it.box.x) + num(it.box.w) / 2, top = num(it.box.y) + num(it.box.h) / 2 - (lines.length * lh) / 2;
        lines.forEach((l, i) => out.push(`<text x="${cx.toFixed(1)}" y="${(top + lh * (i + 0.75)).toFixed(1)}" ${attrs} text-anchor="middle">${esc(l)}</text>`));
      } else lines.forEach((l, i) => out.push(`<text x="${num(it.x).toFixed(1)}" y="${(num(it.y) + lh * (i + 0.75)).toFixed(1)}" ${attrs}>${esc(l)}</text>`));
      if (deg) out.push("</g>");
    }
  }
  out.push("</svg>");
  return out.join("\n");
}

/**
 * What an export paints. `page`: "board" (the board's own page color, ink that reads on it) or "white".
 * `theme`: "light" | "dark" (used for a board with no page color of its own, when page is "board").
 */
export function exportOptions(doc, { page = "board", theme = "light", scale = 2 } = {}) {
  const own = /^#[0-9a-f]{6}$/i.test(doc.appState?.viewBackgroundColor ?? "");
  const t = page === "white" ? LIGHT : own ? boardTheme(doc.appState) : theme === "dark" ? DARK : LIGHT;
  return exportScene(doc, t, { scale, padding: 32 });
}

/** The board as an SVG string. */
export function exportSvg(doc, opts = {}) {
  const s = exportOptions(doc, opts);
  return toSvg(s.items, s);
}

/**
 * The board as PNG pixels: paints into `canvas` (a browser canvas, or anything with width/height/getContext).
 * `loadImage(fileId)` returns a decoded image or null (pictures still loading are skipped).
 * Returns the canvas, sized width·scale × height·scale.
 */
export function paintPng(doc, canvas, { loadImage = () => null, ...opts } = {}) {
  const s = exportOptions(doc, opts);
  canvas.width = Math.max(1, Math.round(s.width * s.scale)); canvas.height = Math.max(1, Math.round(s.height * s.scale));
  paint(canvas.getContext("2d"), s.items, { width: s.width, height: s.height, dpr: s.scale, background: s.background, image: loadImage });
  return canvas;
}

/** Decode every picture the board uses, then resolve (so a PNG export doesn't miss any). Browser only. */
export async function loadPictures(files) {
  const map = new Map();
  await Promise.all(Object.values(files ?? {}).map(f => new Promise(res => {
    if (typeof f?.dataURL !== "string" || !DATA_URL.test(f.dataURL)) return res();
    const img = new Image(); img.onload = () => { map.set(f.id, img); res(); }; img.onerror = () => res(); img.src = f.dataURL;
  })));
  return id => map.get(id) ?? null;
}
export { imageCache };
