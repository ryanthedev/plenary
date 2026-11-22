// @ts-check
// Export: the board stream as SVG or PNG. Core's exportScene says what to paint, cropped (export.js);
// writing pixels or markup is the adapter's job. The SVG writer is herdr-draw's adapters/svg/svg.js, ported
// with its sanitising intact (board content is untrusted: an exported SVG opened in a browser must not run
// anything). PNG paints the same items through ./paint.js onto a canvas, so it matches the screen.
// Notes, selection, cursors and comments never show: only the board Editor's doc goes in.

import { exportScene, paintedBox, boardTheme, LIGHT, DARK, exportToExcalidraw } from "../../../packages/core/export.js";
import { paintElement, project } from "../../../packages/core/render.js";
import { bounds } from "../../../packages/core/geometry.js";
import { paint, imageCache, FACES } from "./paint.js";

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function findFrame(doc, frameId) {
  if (!doc || typeof frameId !== "string" || !frameId) return null;
  const direct = typeof doc.get === "function" ? doc.get(frameId) : null;
  if (direct && !direct.isDeleted && direct.type === "frame") return direct;
  const list = typeof doc.visible === "function" ? doc.visible() : (Array.isArray(doc.elements) ? doc.elements : []);
  return list.find(el => el && !el.isDeleted && el.type === "frame" && el.id === frameId) ?? null;
}

function frameRect(frame) {
  const x = Math.min(num(frame.x), num(frame.x) + num(frame.width));
  const y = Math.min(num(frame.y), num(frame.y) + num(frame.height));
  const w = Math.abs(num(frame.width));
  const h = Math.abs(num(frame.height));
  return { x, y, w, h };
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Compute tight export bounds for either the whole board or a single frame (`{ frameId }`).
 * Returns `null` when `frameId` is specified but no matching live frame exists.
 * @param {any} doc
 * @param {{ frameId?: string, theme?: any }} [opts]
 */
export function exportBounds(doc, { frameId, theme = LIGHT } = {}) {
  if (frameId != null) {
    const frame = findFrame(doc, frameId);
    if (!frame) return null;
    const r = frameRect(frame);
    return { ...r, frameId: frame.id, name: frame.name || "Frame" };
  }
  const box = paintedBox(doc, theme) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/** Collect visible non-frame elements belonging to or overlapping `frame`. */
function elementsInFrame(doc, frame, box) {
  const all = typeof doc.visible === "function" ? doc.visible() : (Array.isArray(doc.elements) ? doc.elements.filter(e => e && !e.isDeleted) : []);
  const includedIds = new Set();
  for (const el of all) {
    if (!el || el.isDeleted || el.type === "frame") continue;
    if (el.frameId === frame.id) {
      includedIds.add(el.id);
      continue;
    }
    if (el.type === "text" && el.containerId) continue; // resolved in second pass with container
    const eb = bounds(el, doc);
    if (eb && boxesIntersect(eb, box)) includedIds.add(el.id);
  }
  const out = [];
  for (const el of all) {
    if (!el || el.isDeleted || el.type === "frame") continue;
    if (includedIds.has(el.id) || (el.type === "text" && el.containerId && includedIds.has(el.containerId))) {
      out.push(el);
    }
  }
  return out;
}

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

/**
 * Display list → SVG text. `scale`: pixels per unit; the viewBox stays in drawing units.
 * Supports optional `{ frameId, doc }` (or `{ clipToViewBox: true }`) to crop tightly to a frame.
 * @param {any[]} items
 * @param {{ width?: number, height?: number, background?: string, files?: Record<string, any>, scale?: number, faces?: Record<string, string>, frameId?: string, doc?: any, clipToViewBox?: boolean }} [opts]
 */
export function toSvg(items, { width, height, background, files = {}, scale = 1, faces = FACES, frameId, doc, clipToViewBox = false } = {}) {
  let vbX = 0, vbY = 0;
  let cropToFrame = !!clipToViewBox;
  if (frameId != null && doc) {
    const fb = exportBounds(doc, { frameId });
    if (fb) {
      vbX = fb.x;
      vbY = fb.y;
      width = Math.max(1, Math.ceil(fb.w));
      height = Math.max(1, Math.ceil(fb.h));
      cropToFrame = true;
    }
  } else if (frameId != null) {
    cropToFrame = true;
  }
  width = num(width, 800); height = num(height, 600); scale = num(scale, 1) > 0 ? num(scale, 1) : 1;
  const px = v => +(v * scale).toFixed(2), face = k => esc(faces[k] ?? faces.sans);
  const defs = [];
  let clipSeq = 0;
  const addClip = (x, y, w, h, angle = 0, cx = 0, cy = 0) => {
    const id = `pl-clip-${++clipSeq}`;
    const deg = num(angle) * 180 / Math.PI;
    const turn = deg ? ` transform="rotate(${deg.toFixed(2)} ${num(cx).toFixed(1)} ${num(cy).toFixed(1)})"` : "";
    defs.push(`<clipPath id="${id}"><rect x="${num(x).toFixed(1)}" y="${num(y).toFixed(1)}" width="${Math.max(0, num(w)).toFixed(1)}" height="${Math.max(0, num(h)).toFixed(1)}"${turn}/></clipPath>`);
    return id;
  };
  const body = [];
  const bgRect = background ? `<rect x="${vbX}" y="${vbY}" width="${width}" height="${height}" fill="${color(background)[0]}"/>` : null;
  for (const it of items) {
    const op = Math.max(0, Math.min(1, num(it.opacity, 1)));
    if (op <= 0) continue;
    let itemClipId = null;
    if (it.clip && typeof it.clip === "object") {
      const cw = num(it.clip.w), ch = num(it.clip.h);
      if (!(cw > 0 && ch > 0)) continue;
      itemClipId = addClip(it.clip.x, it.clip.y, cw, ch, it.clip.angle, it.clip.cx, it.clip.cy);
    }
    const seg = [];
    if (it.t === "path") {
      if (!Array.isArray(it.cmds) || !it.cmds.length) continue;
      if (it.fill) { const [c, o] = color(it.fill, op); seg.push(`<path d="${d(it.cmds)}Z" fill="${c}" fill-opacity="${o.toFixed(3)}"/>`); }
      else { const [c, o] = color(it.stroke, op); seg.push(`<path d="${d(it.cmds)}" fill="none" stroke="${c}" stroke-opacity="${o.toFixed(3)}" stroke-width="${num(it.width, 1)}" stroke-linecap="round" stroke-linejoin="round"${Array.isArray(it.dash) ? ` stroke-dasharray="${it.dash.map(v => num(v)).join(" ")}"` : ""}/>`); }
    } else if (it.t === "image") {
      const url = files?.[it.fileId]?.dataURL;
      if (typeof url !== "string" || !DATA_URL.test(url)) continue;
      const x = num(it.x), y = num(it.y), w = Math.max(0, num(it.w)), h = Math.max(0, num(it.h));
      if (!(w > 0 && h > 0)) continue;
      const deg = num(it.angle) * 180 / Math.PI;
      const turn = deg ? ` transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})"` : "";
      if (it.crop && typeof it.crop === "object") {
        const cx0 = Math.max(0, num(it.crop.x, 0)), cy0 = Math.max(0, num(it.crop.y, 0));
        let cw = num(it.crop.width, 0), ch = num(it.crop.height, 0);
        const rawNatW = num(it.crop.naturalWidth, 0) || num(files?.[it.fileId]?.width, 0);
        const rawNatH = num(it.crop.naturalHeight, 0) || num(files?.[it.fileId]?.height, 0);
        const natW = rawNatW > 0 ? rawNatW : (cx0 + cw);
        const natH = rawNatH > 0 ? rawNatH : (cy0 + ch);
        if (cx0 >= natW || cy0 >= natH) continue;
        cw = Math.min(cw, natW - cx0);
        ch = Math.min(ch, natH - cy0);
        if (!(cw > 0 && ch > 0)) continue;
        const scaleX = w / cw, scaleY = h / ch;
        const fullW = natW * scaleX, fullH = natH * scaleY;
        const imgX = x - cx0 * scaleX, imgY = y - cy0 * scaleY;
        const cropClipId = addClip(x, y, w, h);
        seg.push(`<g opacity="${op.toFixed(3)}"${turn}><g clip-path="url(#${cropClipId})"><image href="${url}" x="${imgX.toFixed(1)}" y="${imgY.toFixed(1)}" width="${fullW.toFixed(1)}" height="${fullH.toFixed(1)}" preserveAspectRatio="none"/></g></g>`);
      } else {
        seg.push(`<image href="${url}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" preserveAspectRatio="none" opacity="${op.toFixed(3)}"${turn}/>`);
      }
    } else if (it.t === "video") {
      const x = num(it.x), y = num(it.y), w = Math.max(0, num(it.w)), h = Math.max(0, num(it.h));
      const deg = num(it.angle) * 180 / Math.PI;
      const turn = deg ? ` transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})"` : "";
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(24, Math.max(8, Math.min(w, h) * 0.16));
      const p1 = `${(cx - r * 0.32).toFixed(1)},${(cy - r * 0.45).toFixed(1)}`;
      const p2 = `${(cx + r * 0.5).toFixed(1)},${cy.toFixed(1)}`;
      const p3 = `${(cx - r * 0.32).toFixed(1)},${(cy + r * 0.45).toFixed(1)}`;
      seg.push(`<g opacity="${op.toFixed(3)}"${turn}><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#18181b" stroke="#52525b" stroke-width="1"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#ffffff" fill-opacity="0.22"/><polygon points="${p1} ${p2} ${p3}" fill="#ffffff"/></g>`);
    } else if (it.t === "text") {
      const text = String(it.text ?? ""); if (!text) continue;
      const deg = num(it.angle) * 180 / Math.PI;
      if (deg) seg.push(`<g transform="rotate(${deg.toFixed(2)} ${num(it.cx).toFixed(1)} ${num(it.cy).toFixed(1)})">`);
      const size = num(it.size, 16), lines = text.split("\n"), lh = size * num(it.lineHeight, 1.25), [c, o] = color(it.color, op);
      const attrs = `font-family="${face(it.font)}" font-size="${size.toFixed(1)}" fill="${c}" fill-opacity="${o.toFixed(3)}"`;
      if (it.box) {
        const cx = num(it.box.x) + num(it.box.w) / 2, top = num(it.box.y) + num(it.box.h) / 2 - (lines.length * lh) / 2;
        lines.forEach((l, i) => seg.push(`<text x="${cx.toFixed(1)}" y="${(top + lh * (i + 0.75)).toFixed(1)}" ${attrs} text-anchor="middle">${esc(l)}</text>`));
      } else lines.forEach((l, i) => seg.push(`<text x="${num(it.x).toFixed(1)}" y="${(num(it.y) + lh * (i + 0.75)).toFixed(1)}" ${attrs}>${esc(l)}</text>`));
      if (deg) seg.push("</g>");
    }
    if (!seg.length) continue;
    if (itemClipId) body.push(`<g clip-path="url(#${itemClipId})">${seg.join("")}</g>`);
    else body.push(...seg);
  }
  const frameClipId = cropToFrame && body.length ? addClip(vbX, vbY, width, height) : null;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${px(height)}" viewBox="${vbX} ${vbY} ${width} ${height}">`];
  if (defs.length) out.push(`<defs>${defs.join("")}</defs>`);
  if (bgRect) out.push(bgRect);
  if (frameClipId) {
    out.push(`<g clip-path="url(#${frameClipId})">`);
    out.push(...body);
    out.push("</g>");
  } else {
    out.push(...body);
  }
  out.push("</svg>");
  return out.join("\n");
}

/**
 * What an export paints. `page`: "board" (the board's own page color, ink that reads on it) or "white".
 * `theme`: "light" | "dark" (used for a board with no page color of its own, when page is "board").
 * `frameId`: optional frame element ID to crop tightly to that frame's bounds and contained elements.
 * @param {any} doc
 * @param {{ page?: string, theme?: string, scale?: number, frameId?: string, padding?: number, maxPixels?: number }} [opts]
 */
export function exportOptions(doc, { page = "board", theme = "light", scale = 2, frameId, padding, maxPixels = 8192 } = {}) {
  const own = /^#[0-9a-f]{6}$/i.test(doc.appState?.viewBackgroundColor ?? "");
  const t = page === "white" ? LIGHT : own ? boardTheme(doc.appState) : theme === "dark" ? DARK : LIGHT;
  const background = page === "white" ? "#ffffff" : t.bg;
  if (frameId != null) {
    const frame = findFrame(doc, frameId);
    if (frame) {
      const box = frameRect(frame);
      const pad = Number.isFinite(padding) && padding >= 0 ? padding : 0;
      const view = { x: pad - box.x, y: pad - box.y, scale: 1 };
      const width = Math.max(1, Math.ceil(box.w + pad * 2));
      const height = Math.max(1, Math.ceil(box.h + pad * 2));
      const items = [];
      const P = project(view);
      for (const el of elementsInFrame(doc, frame, box)) {
        paintElement(doc, el, P, view, t, items, { allText: true });
      }
      return {
        items,
        width,
        height,
        scale: Math.min(scale, maxPixels / Math.max(width, height)),
        background,
        files: doc.files,
        clipToViewBox: true,
        frameId: frame.id,
      };
    }
  }
  return exportScene(doc, t, { scale, padding: Number.isFinite(padding) && padding >= 0 ? padding : 32, maxPixels, background });
}

/**
 * The board (or a single frame when `{ frameId }` is set) as an SVG string.
 * @param {any} doc
 * @param {{ page?: string, theme?: string, scale?: number, frameId?: string, padding?: number }} [opts]
 */
export function exportSvg(doc, opts = {}) {
  const s = exportOptions(doc, opts);
  return toSvg(s.items, s);
}

/**
 * Build a self-contained, XSS-safe, script-free print-ready HTML document with `@page` landscape rules
 * and one crisp `<svg>` page per frame (for one-click browser Print / Save as PDF).
 * @param {any} doc
 * @param {{ theme?: string, page?: string, frameIds?: string[] | null, title?: string }} [opts]
 */
export function buildPrintHtml(doc, { theme = "light", page = "board", frameIds = null, title = "Plenary Export" } = {}) {
  const all = typeof doc?.visible === "function" ? doc.visible() : (Array.isArray(doc?.elements) ? doc.elements.filter(e => e && !e.isDeleted) : []);
  const liveFrames = all.filter(el => el && !el.isDeleted && el.type === "frame");

  let selectedFrames;
  if (Array.isArray(frameIds)) {
    const byId = new Map(liveFrames.map(f => [f.id, f]));
    selectedFrames = frameIds.map(id => byId.get(id)).filter(Boolean);
  } else {
    selectedFrames = [...liveFrames].sort((a, b) => (num(a.y) - num(b.y)) || (num(a.x) - num(b.x)));
  }

  const pages = [];
  if (selectedFrames.length > 0) {
    for (const frame of selectedFrames) {
      const svg = exportSvg(doc, { theme, page, scale: 1, frameId: frame.id });
      const label = esc(frame.name || "Frame");
      pages.push(`<section class="print-page" aria-label="${label}">${svg}</section>`);
    }
  } else if (!Array.isArray(frameIds)) {
    const svg = exportSvg(doc, { theme, page, scale: 1 });
    pages.push(`<section class="print-page" aria-label="Board">${svg}</section>`);
  }

  const safeTitle = esc(title || "Plenary Export");
  const bg = page === "white" ? "#ffffff" : (theme === "dark" ? DARK.bg : LIGHT.bg);
  const safeBg = color(bg)[0];

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\';">',
    `<title>${safeTitle}</title>`,
    "<style>",
    "@page { size: landscape; margin: 0; }",
    "* { box-sizing: border-box; }",
    `html, body { margin: 0; padding: 0; background: ${safeBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
    ".print-page { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 16px; break-inside: avoid; page-break-inside: avoid; }",
    ".print-page:not(:last-child) { break-after: page; page-break-after: always; }",
    ".print-page svg { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; }",
    "@media print { .print-page { padding: 0; } }",
    "</style>",
    "</head>",
    "<body>",
    ...pages,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * The board as a valid Excalidraw v2 JSON string (`.excalidraw`), with embedded image `files`.
 * @param {any} doc
 * @param {{ page?: string, theme?: string, source?: string }} [opts]
 */
export function exportExcalidraw(doc, { page = "board", theme = "light", source } = {}) {
  const own = /^#[0-9a-f]{6}$/i.test(doc.appState?.viewBackgroundColor ?? "");
  const viewBackgroundColor = page === "white"
    ? "#ffffff"
    : own ? doc.appState.viewBackgroundColor : (theme === "dark" ? DARK.bg : LIGHT.bg);
  return JSON.stringify(exportToExcalidraw(doc, /** @type {any} */ ({ viewBackgroundColor, ...(source ? { source } : {}) })), null, 2);
}

/**
 * The board (or a single frame when `{ frameId }` is set) as PNG pixels: paints into `canvas`
 * (a browser canvas, or anything with width/height/getContext).
 * `loadImage(fileId)` returns a decoded image or null (pictures still loading are skipped).
 * Returns the canvas, sized width·scale × height·scale.
 * @param {any} doc
 * @param {any} canvas
 * @param {{ loadImage?: (fileId: string) => any, page?: string, theme?: string, scale?: number, frameId?: string, padding?: number }} [opts]
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
    if (typeof f?.dataURL !== "string" || !DATA_URL.test(f.dataURL)) return res(undefined);
    const img = new Image(); img.onload = () => { map.set(f.id, img); res(undefined); }; img.onerror = () => res(undefined); img.src = f.dataURL;
  })));
  return id => map.get(id) ?? null;
}
export { imageCache };
