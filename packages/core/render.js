// Board → display list: what to paint, in screen coordinates, in order.
// Adapters (Herdr, SVG, a browser canvas) only paint these items:
//   { t: "path", cmds, stroke, width, dash?, opacity? }   cmds: ["M",x,y] ["L",x,y] ["Q",x,y,cx,cy]
//   { t: "path", cmds, fill, opacity? }                    (closed polygons)
//   { t: "text", x, y, text, size, color, align, box?, lineHeight, opacity? }
//   { t: "image", fileId, mimeType, x, y, w, h, angle, cx, cy, opacity? }   pixels: doc.files[fileId]
// Colors arrive as #rrggbb or #rrggbbaa; the theme decides what "default ink" is.

import { DEFAULT_STROKE, isShape, isLinear, isLabel, textSize, MIN_PRESSURE, MAX_PRESSURE } from "./model.js";
import { bbox, resolvedPoints, drawnPoints, toWorld, angleOf, centerOf, labelAnchor, portsOf } from "./geometry.js";
import { spatialIndex } from "./spatial.js";
import { animState } from "./anim.js";
import { labelLines, textWidth } from "./text.js";
import { cornerRadius, roundPolygon, fillLines, arrowheadCmds, fontClass, FONT_FAMILY } from "./style.js";
import { parseLinkCardFromElement, linkCardOpenBadgeRect } from "./link-card.js";

/** View-independent world-space geometry cache keyed by element object (auto-GC'd on doc edits). */
const geoCache = new WeakMap();
const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);
function pointsSig(pts) {
  if (!pts || !pts.length) return "";
  let h1 = 2166136261 >>> 0, h2 = 335903614 >>> 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _f64[0] = p[0] || 0;
    h1 = Math.imul(h1 ^ _u32[0], 16777619) >>> 0;
    h1 = Math.imul(h1 ^ _u32[1], 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (_u32[0] + i), 2246822519) >>> 0;
    _f64[0] = p[1] || 0;
    h1 = Math.imul(h1 ^ _u32[0], 16777619) >>> 0;
    h1 = Math.imul(h1 ^ _u32[1], 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (_u32[1] ^ (i << 5)), 3266489917) >>> 0;
  }
  return `${pts.length}:${h1.toString(36)}:${h2.toString(36)}`;
}
const geoSig = el => `${el.version ?? 0}:${el.versionNonce ?? 0}:${el.x}:${el.y}:${el.width}:${el.height}:${el.angle ?? 0}:${el.roundness?.type ?? ""}:${el.elbowed ? 1 : 0}:${pointsSig(el.points)}`;

function cachedOutline(el, stats) {
  const sig = geoSig(el);
  const hit = geoCache.get(el);
  if (hit && hit.sig === sig && hit.outline) {
    if (stats) stats.cacheHits = (stats.cacheHits ?? 0) + 1;
    return hit.outline;
  }
  if (stats) stats.cacheMisses = (stats.cacheMisses ?? 0) + 1;
  const pts = outlinePoints(el);
  geoCache.set(el, { ...(hit?.sig === sig ? hit : { sig }), outline: pts });
  return pts;
}

function cachedLinear(doc, el, stats) {
  // Bound arrows depend on their target shapes' positions, so never cache their routed points on `el` alone.
  if (el.startBinding?.elementId || el.endBinding?.elementId) {
    if (stats) stats.cacheMisses = (stats.cacheMisses ?? 0) + 1;
    return el.type === "freedraw" ? resolvedPoints(doc, el) : drawnPoints(doc, el);
  }
  const sig = geoSig(el);
  const hit = geoCache.get(el);
  if (hit && hit.sig === sig && hit.linear) {
    if (stats) stats.cacheHits = (stats.cacheHits ?? 0) + 1;
    return hit.linear;
  }
  if (stats) stats.cacheMisses = (stats.cacheMisses ?? 0) + 1;
  const pts = el.type === "freedraw" ? resolvedPoints(doc, el) : drawnPoints(doc, el);
  geoCache.set(el, { ...(hit?.sig === sig ? hit : { sig }), linear: pts });
  return pts;
}

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

const INK = new Set([DEFAULT_STROKE, "#000000", "#000", "black"]);
export function ink(c, theme) {
  if (!c || c === "transparent") return null;
  return INK.has(c) ? theme.fg : c;
}
export function withAlpha(c, a) {
  if (!c || a >= 1) return c;
  const base = c.length === 9 ? c.slice(0, 7) : c.length === 4 ? "#" + [...c.slice(1)].map(x => x + x).join("") : c;
  const prev = c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 1;
  return base + Math.round(Math.max(0, Math.min(1, a * prev)) * 255).toString(16).padStart(2, "0");
}

// Outline of a shape as points (scene coords), rotation included.
export function outlinePoints(el) {
  const pts = localOutline(el);
  return angleOf(el) ? pts.map(([x, y]) => { const w = toWorld(el, { x, y }); return [w.x, w.y]; }) : pts;
}
function localOutline(el) {
  const b = bbox(el);
  if (el.type === "rectangle" || el.type === "frame") {
    const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
    return roundPolygon(cs, el.type === "rectangle" ? cornerRadius(el, Math.min(b.w, b.h)) : 0);
  }
  if (el.type === "diamond") {
    const cs = [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]];
    return roundPolygon(cs, cornerRadius(el, Math.min(b.w, b.h)) * 0.6);
  }
  const n = 40, cx = b.x + b.w / 2, cy = b.y + b.h / 2, out = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; out.push([cx + Math.cos(a) * b.w / 2, cy + Math.sin(a) * b.h / 2]); }
  return out;
}

// The first `f` (0..1) of a polyline by length: the "draw on" animation.
export function trim(pts, f) {
  if (f >= 1 || pts.length < 2) return pts;
  if (f <= 0) return [pts[0]];
  let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * f; const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (seg >= left) { const k = seg ? left / seg : 0; out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]); return out; }
    out.push(pts[i]); left -= seg;
  }
  return out;
}

// Two slightly bowed passes per segment: the hand-drawn look. Deterministic per seed.
function sketch(cmds, pts, r, rough, closed) {
  if (pts.length < 2) return;
  if (rough <= 0) { cmds.push(["M", ...pts[0]]); for (let i = 1; i < pts.length; i++) cmds.push(["L", ...pts[i]]); return; }
  const j = () => (r() - 0.5) * 2 * rough;
  const curvy = pts.length > 8;   // ellipses and the like: jitter the whole loop instead of each edge
  for (let pass = 0; pass < 2; pass++) {
    if (curvy) {
      cmds.push(["M", pts[0][0] + j(), pts[0][1] + j()]);
      for (let i = 1; i < pts.length; i++) cmds.push(["L", pts[i][0] + j() * 0.5, pts[i][1] + j() * 0.5]);
      if (closed) cmds.push(["L", pts[1][0] + j(), pts[1][1] + j()]);
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], z = pts[i], dx = z[0] - a[0], dy = z[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const bow = (r() - 0.5) * Math.min(len * 0.04, 6) * rough, k = 0.45 + r() * 0.1;
      cmds.push(["M", a[0] + j(), a[1] + j()], ["Q", z[0] + j(), z[1] + j(), a[0] + dx * k - (dy / len) * bow, a[1] + dy * k + (dx / len) * bow]);
    }
  }
}

// Lines and arrows: one pass whose ends sit exactly on their points (so arrowheads meet the
// shaft), each straight run bowed a little; "loose" (roughness 2) adds a second pass.
// Curves arrive as many short steps (curveThrough) and are drawn clean.
function sketchLine(cmds, pts, r, rough, curved) {
  cmds.push(["M", ...pts[0]]);
  if (curved || rough <= 0) { for (let i = 1; i < pts.length; i++) cmds.push(["L", ...pts[i]]); return; }
  const passes = rough >= 1.5 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    if (pass) cmds.push(["M", ...pts[0]]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], z = pts[i], dx = z[0] - a[0], dy = z[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const bow = (r() - 0.5) * Math.min(len * 0.02, 3) * rough * (pass ? 1.6 : 1);
      cmds.push(["Q", z[0], z[1], a[0] + dx / 2 - (dy / len) * bow, a[1] + dy / 2 + (dx / len) * bow]);
    }
  }
}

// The point `d` back along a polyline from its last point: where an arrowhead aims from,
// so a head on a curve follows the curve, not its last tiny step.
export function pointBack(pts, d) {
  let left = d;
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], z = pts[i], seg = Math.hypot(z[0] - a[0], z[1] - a[1]);
    if (seg >= left) { const k = seg ? left / seg : 0; return [z[0] + (a[0] - z[0]) * k, z[1] + (a[1] - z[1]) * k]; }
    left -= seg;
  }
  return pts[0];
}
const pathLength = pts => { let n = 0; for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return n; };

function smooth(cmds, pts) {
  cmds.push(["M", ...pts[0]]);
  for (let i = 1; i < pts.length; i++) cmds.push(["Q", (pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2, pts[i - 1][0], pts[i - 1][1]]);
  cmds.push(["L", ...pts[pts.length - 1]]);
}

// Validate `el.pressures` against the untrimmed point count. Returns clamped pressures when valid & non-uniform, else null.
function validPressures(el, totalPts) {
  const raw = el.pressures;
  if (!Array.isArray(raw) || raw.length !== totalPts || totalPts < 2) return null;
  const out = new Array(totalPts);
  let minP = Infinity, maxP = -Infinity;
  for (let i = 0; i < totalPts; i++) {
    const v = raw[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const c = Math.max(MIN_PRESSURE, Math.min(MAX_PRESSURE, v));
    out[i] = c;
    if (c < minP) minP = c;
    if (c > maxP) maxP = c;
  }
  return maxP - minP > 1e-4 ? out : null;
}

// Emit variable-width smooth segments for a pressure-sensitive freedraw stroke, merging adjacent equal-width runs.
function emitVariableFreedraw(out, el, pts, pressures, baseW, stroke, opacity) {
  const widthFor = p => Math.max(0.5, Math.round(baseW * (0.35 + 1.15 * p) * 4) / 4);
  const segs = [];
  if (pts.length === 2) {
    segs.push({ w: widthFor((pressures[0] + pressures[1]) / 2), cmds: [["M", ...pts[0]], ["L", ...pts[1]]] });
  } else {
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const m0 = mid(pts[0], pts[1]);
    segs.push({ w: widthFor((pressures[0] + pressures[1]) / 2), cmds: [["M", ...pts[0]], ["L", ...m0]] });
    for (let i = 1; i < pts.length - 1; i++) {
      const mPrev = mid(pts[i - 1], pts[i]), mNext = mid(pts[i], pts[i + 1]);
      segs.push({ w: widthFor(pressures[i]), cmds: [["M", ...mPrev], ["Q", ...mNext, ...pts[i]]] });
    }
    const n = pts.length;
    const mLast = mid(pts[n - 2], pts[n - 1]);
    segs.push({ w: widthFor((pressures[n - 2] + pressures[n - 1]) / 2), cmds: [["M", ...mLast], ["L", ...pts[n - 1]]] });
  }
  let cur = null;
  for (const seg of segs) {
    if (cur && cur.width === seg.w) {
      cur.cmds.push(...seg.cmds.slice(1));
    } else {
      cur = { t: "path", id: el.id, cmds: seg.cmds, stroke, width: seg.w, dash: null, opacity };
      out.push(cur);
    }
  }
}


// Below this zoom shapes and lines are drawn clean, and text smaller than TEXT_MIN px is left out
// (a big board fitted to a pane: hundreds of 2 px labels cost a lot to lay out and say nothing).
export const CLEAN_BELOW = 0.3;
export const TEXT_MIN = 3;

export const project = view => (x, y) => [(x + view.x) * view.scale, (y + view.y) * view.scale];

// Paint one element into `out`. `P` maps scene → screen.
export function paintElement(doc, el, P, view, theme, out, opts = {}) {
  const a = opts.time == null ? null : animState(el, opts.time);
  if (a && a.opacity <= 0) return;
  const layer = doc.layer(el.customData?.layer);
  const opacity = (el.opacity / 100) * ((layer?.opacity ?? 100) / 100) * (a ? a.opacity : 1);
  const progress = a ? a.progress : 1;
  // Animation offsets, non-uniform scale, and rotation apply about the element's center.
  // QNoRot applies scale + translate only (for text/images whose rotation is applied via `angle` in paint.js).
  const sx = a ? (a.scale ?? 1) * (a.scaleX ?? 1) : 1;
  const sy = a ? (a.scale ?? 1) * (a.scaleY ?? 1) : 1;
  const aRot = a?.rotate ?? 0;
  const aScale = Math.max(Math.abs(sx), Math.abs(sy));
  let Q = P, QNoRot = P;
  if (a && (a.dx || a.dy || sx !== 1 || sy !== 1 || aRot)) {
    const b = bbox(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    QNoRot = (x, y) => P(cx + (x - cx) * sx + a.dx, cy + (y - cy) * sy + a.dy);
    if (aRot) {
      const cos = Math.cos(aRot), sin = Math.sin(aRot);
      Q = (x, y) => {
        const lx = (x - cx) * sx, ly = (y - cy) * sy;
        return P(cx + lx * cos - ly * sin + a.dx, cy + lx * sin + ly * cos + a.dy);
      };
    } else {
      Q = QNoRot;
    }
  }
  const glow = a?.glow ?? 0;
  // Zoomed far out the hand-drawn wobble is under a pixel: draw clean (a quarter of the commands).
  const s = view.scale, r = rng(el.seed), rough = s < CLEAN_BELOW ? 0 : (el.roughness ?? 1) * Math.min(1.5, s);
  const stroke = ink(el.strokeColor, theme), fill = ink(el.backgroundColor, theme);
  const width = Math.max(0.5, el.strokeWidth * s), dash = el.strokeStyle === "dashed" ? [8 * s, 6 * s] : el.strokeStyle === "dotted" ? [1.5 * s, 5 * s] : null;

  if (el.type === "text") {
    // Too small to read in the pane: skip it before wrapping it (and an arrow label's background patch with it).
    if (!opts.allText && el.fontSize * s * aScale < TEXT_MIN) return;
    if (isLabel(el)) {
      const box = doc.get(el.containerId); if (!box) return;
      let b = bbox(box);
      if (isLinear(box)) {   // a line's label sits halfway along its path (elbows included)
        const m = labelAnchor(doc, box) ?? [0, 0], lw = Math.max(40, textSize(el.text, el.fontSize, 1.25, el.fontFamily).w), lh = el.fontSize * 1.4;
        b = { x: m[0] - lw / 2, y: m[1] - lh / 2, w: lw, h: lh };
      }
      const [x0, y0] = QNoRot(b.x, b.y), [x1, y1] = QNoRot(b.x + b.w, b.y + b.h);
      const color = box.backgroundColor !== "transparent" && (!box.fillStyle || box.fillStyle === "solid") && INK.has(el.strokeColor) ? "#1e1e1e" : ink(el.strokeColor, theme);
      const text = isShape(box) ? labelLines(el, box).join("\n") : el.text;   // labels wrap to their shape
      if (isLinear(box)) {   // on a line: a patch of background behind the text, like Excalidraw's gap
        const lines = String(text).split("\n"), s2 = el.fontSize * s, w = Math.max(...lines.map(l => textWidth(l, s2, el.fontFamily))) + 10, h = lines.length * s2 * (el.lineHeight ?? 1.25) + 4;
        const [mx, my] = QNoRot(b.x + b.w / 2, b.y + b.h / 2);
        out.push({ t: "path", id: el.id + ":bg", cmds: [["M", mx - w / 2, my - h / 2], ["L", mx + w / 2, my - h / 2], ["L", mx + w / 2, my + h / 2], ["L", mx - w / 2, my + h / 2]], fill: theme.bg, opacity });
      }
      const [cx, cy] = QNoRot(b.x + b.w / 2, b.y + b.h / 2);
      out.push({ t: "text", id: el.id, font: fontClass(el.fontFamily), angle: angleOf(box) + aRot, cx, cy, x: x0, y: y0, text, size: el.fontSize * s * aScale, color, align: "center", box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, lineHeight: el.lineHeight ?? 1.25, opacity, reveal: progress });
    } else {
      const [x, y] = QNoRot(el.x, el.y), c = centerOf(el), [cx, cy] = QNoRot(c.x, c.y);
      out.push({ t: "text", id: el.id, font: fontClass(el.fontFamily), angle: angleOf(el) + aRot, cx, cy, x, y, text: el.text, size: el.fontSize * s * aScale, color: ink(el.strokeColor, theme), align: "left", lineHeight: el.lineHeight ?? 1.25, opacity, reveal: progress });
    }
    return;
  }

  if (el.type === "image") {
    const b = bbox(el), [x0, y0] = QNoRot(b.x, b.y), [x1, y1] = QNoRot(b.x + b.w, b.y + b.h), [cx, cy] = QNoRot(b.x + b.w / 2, b.y + b.h / 2);
    const file = doc.files?.[el.fileId];
    if (file && typeof file.dataURL === "string") {
      out.push({ t: "image", id: el.id, fileId: el.fileId, mimeType: file.mimeType, x: x0, y: y0, w: x1 - x0, h: y1 - y0, angle: angleOf(el) + aRot, cx, cy, opacity: opacity * progress });
    } else {   // the file hasn't arrived (or was lost): a dashed box where it goes
      const pts = outlinePoints({ ...el, type: "rectangle", roundness: null }).map(p => Q(p[0], p[1]));
      out.push({ t: "path", id: el.id, cmds: pts.map((p, i) => [i ? "L" : "M", ...p]), stroke: theme.dim, width: 1, dash: [6, 4], opacity });
    }
    return;
  }

  if (el.type === "video") {
    const b = bbox(el), [x0, y0] = Q(b.x, b.y), [x1, y1] = Q(b.x + b.w, b.y + b.h), [cx, cy] = Q(b.x + b.w / 2, b.y + b.h / 2);
    const file = doc.files?.[el.fileId];
    const ready = !!(file && (typeof file.dataURL === "string" || typeof file.url === "string" || file.bytes instanceof Uint8Array));
    out.push({
      t: "video",
      id: el.id,
      fileId: el.fileId,
      mimeType: file?.mimeType ?? el.mimeType ?? "video/mp4",
      posterDataUrl: el.posterDataUrl ?? null,
      status: ready ? (el.status ?? "saved") : "pending",
      x: x0, y: y0, w: x1 - x0, h: y1 - y0,
      angle: angleOf(el), cx, cy,
      opacity: opacity * progress,
    });
    return;
  }

  if (isShape(el)) {
    const card = el.type === "rectangle" ? parseLinkCardFromElement(el) : null;
    if (card) {
      paintLinkCard(el, card, Q, QNoRot, view, theme, out, { opacity, progress, aRot, aScale, glow, allText: opts.allText });
      return;
    }
    const pts = cachedOutline(el, opts.stats).map(p => Q(p[0], p[1]));
    if (el.type === "frame") {
      out.push({ t: "path", id: el.id, cmds: pts.map((p, i) => [i ? "L" : "M", ...p]), stroke: theme.dim, width: 1, dash: null, opacity });
      out.push({ t: "text", id: el.id + ":name", x: pts[0][0], y: pts[0][1] - 18 * Math.min(1, s), text: el.name || "Frame", size: 12 * Math.min(1, s) + 2, color: theme.dim, align: "left", lineHeight: 1.2, opacity });
      return;
    }
    if (glow > 0 && pts.length >= 2) {
      out.push({ t: "path", id: el.id + ":glow", cmds: pts.map((p, i) => [i ? "L" : "M", ...p]), stroke: theme.accent, width: width + 8 * s * glow, dash: null, opacity: opacity * 0.28 * glow });
    }
    if (fill && progress >= 1) {
      const poly = pts.slice(0, -1);
      if (!el.fillStyle || el.fillStyle === "solid") out.push({ t: "path", id: el.id, cmds: poly.map((p, i) => [i ? "L" : "M", ...p]), fill, opacity });
      else {   // hachure / cross-hatch / zigzag: lines in the fill color, slightly hand-drawn
        const cmds = [], jj = () => (r() - 0.5) * rough;
        for (const [a, b] of fillLines(el.fillStyle, poly, width)) cmds.push(["M", a[0] + jj(), a[1] + jj()], ["L", b[0] + jj(), b[1] + jj()]);
        if (cmds.length) out.push({ t: "path", id: el.id, cmds, stroke: fill, width: Math.max(0.5, width / 2), dash: null, opacity });
      }
    }
    if (stroke) { const cmds = []; sketch(cmds, trim(pts, progress), r, rough, progress >= 1); if (cmds.length) out.push({ t: "path", id: el.id, cmds, stroke, width, dash, opacity }); }
    return;
  }

  if (isLinear(el) && stroke) {
    if (progress <= 0) return;
    const rawPts = cachedLinear(doc, el, opts.stats);
    let pts = rawPts.map(p => Q(p[0], p[1]));
    pts = trim(pts, progress);
    const cmds = [];
    if (glow > 0 && pts.length >= 2) {
      out.push({ t: "path", id: el.id + ":glow", cmds: pts.map((p, i) => [i ? "L" : "M", ...p]), stroke: theme.accent, width: width + 8 * s * glow, dash: null, opacity: opacity * 0.28 * glow });
    }
    if (el.type === "freedraw") {
      const baseW = Math.max(1, width * 1.1);
      const pressures = validPressures(el, rawPts.length);
      if (pressures && pts.length >= 2) {
        emitVariableFreedraw(out, el, pts, pressures, baseW, stroke, opacity);
        return;
      }
      if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.5, pts[0][1] + 0.5]];
      smooth(cmds, pts);
      out.push({ t: "path", id: el.id, cmds, stroke, width: baseW, dash: null, opacity });
      return;
    }
    if (pts.length < 2) return;
    sketchLine(cmds, pts, r, rough, !!el.roundness && !el.elbowed);
    out.push({ t: "path", id: el.id, cmds, stroke, width, dash, opacity });
    if (progress >= 1) {
      const strokes = [], fills = [];
      // Heads grow with the stroke (as in Excalidraw) and never take more than a third of a short line.
      const size = Math.min((12 + 3 * el.strokeWidth) * s, pathLength(pts) / 3);
      for (const [type, line] of [[el.endArrowhead, pts], [el.startArrowhead, [...pts].reverse()]]) {
        if (!type || size < 1) continue;
        const to = line[line.length - 1], h = arrowheadCmds(type, pointBack(line, size), to, size); strokes.push(...h.strokes); fills.push(...h.fills);
      }
      if (fills.length) out.push({ t: "path", id: el.id, cmds: fills, fill: stroke, opacity });
      if (strokes.length) out.push({ t: "path", id: el.id, cmds: strokes, stroke, width, dash: null, opacity });
    }
  }
}

// The whole board. `opts.time` (ms) plays the timeline; omit it for the editing view.
export function paintScene(doc, view, theme, opts = {}) {
  const out = [], P = project(view), seen = clipTest(doc, view, opts);
  let candidates;
  if (opts.clip && opts.time === undefined) {
    const s = view.scale, x0 = -view.x, y0 = -view.y, x1 = x0 + opts.clip.w / s, y1 = y0 + opts.clip.h / s, m = 40 / s;
    candidates = spatialIndex(doc).queryRect(x0 - m, y0 - m, x1 + m, y1 + m);
  } else {
    candidates = doc.visible();
  }
  if (opts.stats) opts.stats.visited = (opts.stats.visited ?? 0) + candidates.length;
  for (const el of candidates) if (!seen || seen(el)) paintElement(doc, el, P, view, theme, out, opts);
  return opts.allText ? out : out.filter(it => it.t !== "text" || !(it.size < TEXT_MIN));
}

// Paths grouped into as few drawing calls as possible (each group is one path of one style).
// The display list is in paint order; a path may join an earlier group of its style only if
// nothing drawn after that group overlaps it, so what shows on top never changes. `keyOf(it)`
// names a style; `bboxOf(it)` its screen box. Text and images end no group (text draws above
// every path anyway; an image is its own layer). Returns { layers: [{ key, items, img? }], texts }.
export function planBatches(items, keyOf, { lookback = 48 } = {}) {
  const layers = [], texts = [];
  for (const it of items) {
    if (it.t === "text") { texts.push(it); continue; }
    if (it.t === "image" || it.t === "video") { const b = imgBox(it); layers.push({ img: it, items: [], box: b, boxes: [b] }); continue; }
    if (it.t !== "path") continue;
    const key = keyOf(it), box = cmdsBox(it.cmds, (it.width ?? 0) / 2 + 1);
    let into = null;
    for (let i = layers.length - 1, n = 0; i >= 0 && n < lookback; i--, n++) {
      const l = layers[i];
      if (!l.img && l.key === key) { into = l; break; }
      // Something above the candidates covers this spot: its union box first (cheap), then its pieces.
      if (overlaps(l.box, box) && l.boxes.some(b => overlaps(b, box))) break;
    }
    if (!into) { into = { key, items: [], box: null, boxes: [] }; layers.push(into); }
    into.items.push(it);
    into.boxes.push(box);
    into.box = union(into.box, box);
  }
  return { layers, texts };
}
const imgBox = it => ({ x0: Math.min(it.x, it.x + it.w), y0: Math.min(it.y, it.y + it.h), x1: Math.max(it.x, it.x + it.w), y1: Math.max(it.y, it.y + it.h) });
function cmdsBox(cmds, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of cmds) for (let i = 1; i + 1 < c.length; i += 2) {
    const x = c[i], y = c[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };   // a stroke's width spills past its points
}
const overlaps = (a, b) => !!a && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const union = (a, b) => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : b);

// Helpers for overlays (selection, handles, cursors, snap indicators).
export function rectCmds(x, y, w, h) { return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["L", x, y]]; }

function isDarkTheme(theme) {
  const bg = theme?.bg;
  if (typeof bg !== "string" || !/^#[0-9a-f]{6}/i.test(bg)) return false;
  const r = parseInt(bg.slice(1, 3), 16) / 255;
  const g = parseInt(bg.slice(3, 5), 16) / 255;
  const b = parseInt(bg.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

function fitCardText(str, maxW, fontSize, fontFamily = FONT_FAMILY.sans) {
  const s = String(str ?? "");
  if (!s || maxW <= 0) return "";
  if (textWidth(s, fontSize, fontFamily) <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, mid) + "…", fontSize, fontFamily) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo).trimEnd() + "…" : "…";
}

function cardMapPts(el, pts, Q) {
  const hasAngle = !!angleOf(el);
  return pts.map(([x, y]) => {
    const w = hasAngle ? toWorld(el, { x, y }) : { x, y };
    return Q(w.x, w.y);
  });
}

function cardPolyCmds(el, pts, Q, closed = false) {
  const mapped = cardMapPts(el, pts, Q);
  if (!mapped.length) return [];
  const cmds = mapped.map((p, i) => [i ? "L" : "M", p[0], p[1]]);
  if (closed && mapped.length > 2) cmds.push(["L", mapped[0][0], mapped[0][1]]);
  return cmds;
}

function cardRoundRectPts(x, y, w, h, r, steps = 4) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts = roundPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], rr, steps);
  return pts.slice(0, -1);
}

function cardCirclePts(cx, cy, r, steps = 14) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
  }
  return pts;
}

/** Crisp vector provider emblem drawn strictly with pure 2D path primitives. */
function paintProviderEmblem(el, provider, ix, iy, size, fg, Q, s, out, opacity) {
  const sw = Math.max(1, 1.6 * s);
  const pt = (fx, fy) => [ix + size * fx, iy + size * fy];
  if (provider === "github") {
    // Crisp git PR / issue branch glyph: left vertical stem with 2 nodes + right curved branch node
    out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.32, 0.30), pt(0.32, 0.70)], Q), stroke: fg, width: sw, dash: null, opacity });
    out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.32, 0.42), pt(0.56, 0.42), pt(0.68, 0.54), pt(0.68, 0.68)], Q), stroke: fg, width: sw, dash: null, opacity });
    for (const [fx, fy] of [[0.32, 0.28], [0.32, 0.72], [0.68, 0.72]]) {
      const [cx, cy] = pt(fx, fy);
      out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, cardCirclePts(cx, cy, size * 0.10, 10), Q), fill: fg, opacity });
    }
    return;
  }
  if (provider === "linear") {
    // Crisp Linear emblem: outer circle + three diagonal parallel stripes
    const [cx, cy] = pt(0.5, 0.5);
    out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, cardCirclePts(cx, cy, size * 0.34, 16), Q, true), stroke: fg, width: sw, dash: null, opacity });
    out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.24, 0.58), pt(0.42, 0.76)], Q), stroke: fg, width: sw, dash: null, opacity });
    out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.22, 0.40), pt(0.60, 0.78)], Q), stroke: fg, width: sw, dash: null, opacity });
    out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.30, 0.28), pt(0.72, 0.70)], Q), stroke: fg, width: sw, dash: null, opacity });
    return;
  }
  // Jira: crisp layered dual-chevron diamond mark
  out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.50, 0.20), pt(0.78, 0.48), pt(0.64, 0.62), pt(0.50, 0.48), pt(0.36, 0.62), pt(0.22, 0.48)], Q), fill: fg, opacity });
  out.push({ t: "path", id: el.id + ":ic", cmds: cardPolyCmds(el, [pt(0.50, 0.54), pt(0.68, 0.72), pt(0.50, 0.84), pt(0.32, 0.72)], Q), fill: fg, opacity });
}

/** Paint a Jira, Linear, or GitHub rich link card with pure vector display-list items. */
function paintLinkCard(el, card, Q, QNoRot, view, theme, out, { opacity, progress, aRot, aScale, glow, allText }) {
  const b = bbox(el);
  const s = view.scale;
  const dark = isDarkTheme(theme);
  const meta = card.meta;
  const accent = dark ? meta.accentDark : meta.accent;
  const surface = dark ? "#1C1C20" : "#FFFFFF";
  const border = dark ? "#2E2E36" : "#E4E4E7";
  const shadow = dark ? "#00000040" : "#00000014";
  const titleColor = dark ? "#F4F4F5" : "#18181B";
  const subColor = dark ? "#A1A1AA" : "#625F57";
  const urlColor = dark ? "#71717A" : "#868E96";
  const badgeBg = dark ? meta.badgeBgDark : meta.badgeBg;
  const pillBg = dark ? meta.pillBgDark : meta.pillBg;
  const pillFg = dark ? meta.pillFgDark : meta.pillFg;
  const openBg = dark ? "#27272E" : "#F4F4F5";
  const openFg = dark ? "#D4D4D8" : "#52525B";

  const radius = Math.min(10, Math.min(b.w, b.h) * 0.18);
  const cardPts = cardRoundRectPts(b.x, b.y, b.w, b.h, radius, 5);

  if (glow > 0) {
    out.push({ t: "path", id: el.id + ":glow", cmds: cardPolyCmds(el, cardPts, Q, true), stroke: theme.accent, width: Math.max(1, s) + 8 * s * glow, dash: null, opacity: opacity * 0.28 * glow });
  }

  // Subtle drop shadow
  if (progress >= 1) {
    const shPts = cardRoundRectPts(b.x, b.y + 2, b.w, b.h, radius, 4);
    out.push({ t: "path", id: el.id + ":shadow", cmds: cardPolyCmds(el, shPts, Q), fill: shadow, opacity });
  }

  // Card surface
  out.push({ t: "path", id: el.id, cmds: cardPolyCmds(el, cardPts, Q), fill: surface, opacity });

  // Left provider accent stripe (crisp 4px vertical bar inset inside left curve)
  const barW = Math.min(4, b.w * 0.04);
  const barInsetY = Math.min(radius * 0.45, b.h * 0.12);
  const barPts = cardRoundRectPts(b.x + 1, b.y + barInsetY, barW, Math.max(4, b.h - barInsetY * 2), barW / 2, 3);
  out.push({ t: "path", id: el.id + ":accent", cmds: cardPolyCmds(el, barPts, Q), fill: accent, opacity });

  // Card border
  out.push({ t: "path", id: el.id + ":border", cmds: cardPolyCmds(el, cardPts, Q, true), stroke: border, width: Math.max(0.75, 1 * s), dash: null, opacity });

  // Layout metrics in local scene coords
  const padX = Math.min(14, b.w * 0.06);
  const padY = Math.min(12, b.h * 0.12);
  const contentX = b.x + padX + barW + 4;
  const openRect = linkCardOpenBadgeRect(el);
  const contentRight = openRect.x - 8;
  const contentW = Math.max(20, contentRight - contentX);

  // Provider icon badge (top-left)
  const iconSize = Math.min(22, Math.max(14, b.h * 0.21));
  const iconX = contentX;
  const iconY = b.y + padY;
  const iconPts = cardRoundRectPts(iconX, iconY, iconSize, iconSize, Math.min(6, iconSize * 0.27), 3);
  out.push({ t: "path", id: el.id + ":badge", cmds: cardPolyCmds(el, iconPts, Q), fill: badgeBg, opacity });
  paintProviderEmblem(el, card.provider, iconX, iconY, iconSize, meta.badgeFg, Q, s, out, opacity);

  // External-link (`↗`) action button (top-right)
  const openPts = cardRoundRectPts(openRect.x, openRect.y, openRect.w, openRect.h, Math.min(6, openRect.w * 0.25), 3);
  out.push({ t: "path", id: el.id + ":openbg", cmds: cardPolyCmds(el, openPts, Q), fill: openBg, opacity });
  const ox = openRect.x, oy = openRect.y, ow = openRect.w, oh = openRect.h;
  const arrowSw = Math.max(1, 1.5 * s);
  out.push({ t: "path", id: el.id + ":open", cmds: cardPolyCmds(el, [[ox + ow * 0.32, oy + oh * 0.68], [ox + ow * 0.68, oy + oh * 0.32]], Q), stroke: openFg, width: arrowSw, dash: null, opacity });
  out.push({ t: "path", id: el.id + ":open", cmds: cardPolyCmds(el, [[ox + ow * 0.42, oy + oh * 0.32], [ox + ow * 0.68, oy + oh * 0.32], [ox + ow * 0.68, oy + oh * 0.58]], Q), stroke: openFg, width: arrowSw, dash: null, opacity });

  // Rotation center for text items
  const [cx, cy] = QNoRot(b.x + b.w / 2, b.y + b.h / 2);
  const angle = angleOf(el) + aRot;

  // Header row: monospace key pill + subtitle
  const pillFontSize = Math.min(11, Math.max(8, b.h * 0.105));
  const pillLabel = card.provider === "github" ? `${card.kind} ${card.shortKey}` : card.shortKey;
  const pillPadX = 6;
  const pillH = Math.min(20, Math.max(14, iconSize - 2));
  const pillTextW = textWidth(pillLabel, pillFontSize, FONT_FAMILY.mono);
  const pillW = Math.min(contentW - iconSize - 8, pillTextW + pillPadX * 2);
  const pillX = iconX + iconSize + 8;
  const pillY = iconY + (iconSize - pillH) / 2;

  if (pillW >= 24) {
    const pillPts = cardRoundRectPts(pillX, pillY, pillW, pillH, Math.min(5, pillH / 2), 3);
    out.push({ t: "path", id: el.id + ":pill", cmds: cardPolyCmds(el, pillPts, Q), fill: pillBg, opacity });
    if (allText || pillFontSize * s * aScale >= TEXT_MIN) {
      const [px0, py0] = QNoRot(pillX, pillY), [px1, py1] = QNoRot(pillX + pillW, pillY + pillH);
      out.push({
        t: "text", id: el.id + ":key", font: "mono", angle, cx, cy,
        x: px0, y: py0, text: fitCardText(pillLabel, pillW - 6, pillFontSize, FONT_FAMILY.mono),
        size: pillFontSize * s * aScale, color: pillFg, align: "center",
        box: { x: px0, y: py0, w: px1 - px0, h: py1 - py0 }, lineHeight: 1.15, opacity, reveal: progress,
      });
    }
  }

  // Subtitle (repo / workspace / host) to the right of key pill
  const subFontSize = Math.min(11.5, Math.max(8, b.h * 0.11));
  const subX = pillX + pillW + 7;
  const subMaxW = contentRight - subX;
  if (subMaxW >= 28 && (allText || subFontSize * s * aScale >= TEXT_MIN)) {
    const subText = fitCardText(card.subtitle, subMaxW, subFontSize, FONT_FAMILY.sans);
    const [sx0, sy0] = QNoRot(subX, iconY + (iconSize - subFontSize * 1.2) / 2);
    out.push({
      t: "text", id: el.id + ":sub", font: "sans", angle, cx, cy,
      x: sx0, y: sy0, text: subText, size: subFontSize * s * aScale,
      color: subColor, align: "left", lineHeight: 1.2, opacity, reveal: progress,
    });
  }

  // Main title line
  const titleFontSize = Math.min(14.5, Math.max(10, b.h * 0.135));
  const titleY = iconY + iconSize + Math.min(12, b.h * 0.10);
  const fullContentW = Math.max(24, b.x + b.w - padX - contentX);
  if (titleY + titleFontSize < b.y + b.h - 6 && (allText || titleFontSize * s * aScale >= TEXT_MIN)) {
    const titleText = fitCardText(card.title, fullContentW, titleFontSize, FONT_FAMILY.sans);
    const [tx0, ty0] = QNoRot(contentX, titleY);
    out.push({
      t: "text", id: el.id + ":title", font: "sans", angle, cx, cy,
      x: tx0, y: ty0, text: titleText, size: titleFontSize * s * aScale,
      color: titleColor, align: "left", lineHeight: 1.25, opacity, reveal: progress,
    });
  }

  // Footer display URL line (when card height has room)
  const urlFontSize = Math.min(10.5, Math.max(8, b.h * 0.095));
  const urlY = titleY + titleFontSize * 1.45;
  if (urlY + urlFontSize * 1.1 <= b.y + b.h - padY * 0.5 && (allText || urlFontSize * s * aScale >= TEXT_MIN)) {
    const urlText = fitCardText(card.displayUrl, fullContentW, urlFontSize, FONT_FAMILY.mono);
    const [ux0, uy0] = QNoRot(contentX, urlY);
    out.push({
      t: "text", id: el.id + ":url", font: "mono", angle, cx, cy,
      x: ux0, y: uy0, text: urlText, size: urlFontSize * s * aScale,
      color: urlColor, align: "left", lineHeight: 1.2, opacity, reveal: progress,
    });
  }
}

// Visual port / anchor snap indicators for line/arrow hover & endpoint drag preview.
export function paintSnapIndicator(doc, snap, view, theme, out) {
  if (!snap?.targetId) return;
  const shape = doc.get(snap.targetId);
  if (!shape) return;
  const P = project(view), acc = theme.accent;
  const circle = (x, y, r, steps = 20) => {
    const c = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      c.push([i ? "L" : "M", x + Math.cos(t) * r, y + Math.sin(t) * r]);
    }
    return c;
  };
  const outline = (shape.type === "image" || shape.type === "video"
    ? outlinePoints({ ...shape, type: "rectangle", roundness: null })
    : outlinePoints(shape)).map(([x, y]) => P(x, y));
  out.push({ t: "path", id: "snap:outline", cmds: outline.map((p, i) => [i ? "L" : "M", ...p]), stroke: withAlpha(acc, 0.85), width: 2, dash: null });
  const ports = portsOf(shape);
  let activePoint = null;
  for (const port of ports) {
    if (snap.side != null && snap.side === port.side) {
      activePoint = port.at;
      continue;
    }
    const [px, py] = P(port.at[0], port.at[1]);
    const ring = circle(px, py, 4);
    out.push({ t: "path", id: `snap:port:${port.side}`, cmds: ring.slice(0, 20), fill: theme.bg });
    out.push({ t: "path", id: `snap:port:${port.side}`, cmds: ring, stroke: withAlpha(acc, 0.75), width: 1.5, dash: null });
  }
  if (!activePoint && snap.lineId != null && snap.endIndex != null) {
    const line = doc.get(snap.lineId);
    if (line) {
      const pts = resolvedPoints(doc, line);
      if (pts.length) activePoint = snap.endIndex < 0 ? pts[pts.length - 1] : pts[snap.endIndex];
    }
  }
  if (activePoint) {
    const [ax, ay] = P(activePoint[0], activePoint[1]);
    const halo = circle(ax, ay, 8.5);
    out.push({ t: "path", id: "snap:halo", cmds: halo.slice(0, 20), fill: withAlpha(acc, 0.22) });
    const core = circle(ax, ay, 5.5);
    out.push({ t: "path", id: "snap:active", cmds: core.slice(0, 20), fill: acc });
    out.push({ t: "path", id: "snap:active", cmds: core, stroke: theme.bg, width: 1.5, dash: null });
  }
}

// `opts.clip` ({ w, h }, screen px): leave out what can't reach the screen. Generous on purpose:
// a rotated shape's corners pass its box (half its size each way), a label rides its container, and
// arrows bound to shapes are routed when drawn, so they're always kept. Never while the timeline
// plays (animations move things). Null: draw everything.
function clipTest(doc, view, opts) {
  const c = opts.clip;
  if (!c || opts.time !== undefined) return null;
  const s = view.scale, x0 = -view.x, y0 = -view.y, x1 = x0 + c.w / s, y1 = y0 + c.h / s, m = 40 / s;
  return el => {
    let host = el;
    if (el.type === "text" && el.containerId) { host = doc.get(el.containerId); if (!host) return true; }
    // Lines and arrows (routes, labels along them), frames (their names run past them) and images
    // are few and cheap: always drawn.
    if (isLinear(host) || host.type === "frame" || host.type === "image" || host.type === "video") return true;
    // Half the shape's size each way: room for a rotated corner or a label taller than its shape.
    const b = bbox(host), r = Math.max(b.w, b.h) / 2 + m;
    return b.x - r < x1 && b.x + b.w + r > x0 && b.y - r < y1 && b.y + b.h + r > y0;
  };
}
