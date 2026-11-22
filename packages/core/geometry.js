// Geometry on scene coordinates: boxes, hit testing, arrow binding, transforms.

import { isShape, isLinear, isLabel, isMedia, textSize } from "./model.js";
import { elbowRoute } from "./elbow.js";
import { labelLines } from "./text.js";
import { spatialIndex } from "./spatial.js";

export function bbox(el) {
  if (isLinear(el)) {
    const xs = el.points.map(p => p[0] + el.x), ys = el.points.map(p => p[1] + el.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (el.type === "text" && !el.containerId) {
    const s = textSize(el.text, el.fontSize, el.lineHeight, el.fontFamily);
    return { x: el.x, y: el.y, w: Math.max(el.width, s.w), h: Math.max(el.height, s.h) };
  }
  const x = Math.min(el.x, el.x + el.width), y = Math.min(el.y, el.y + el.height);
  return { x, y, w: Math.abs(el.width), h: Math.abs(el.height) };
}

export function unionBox(boxes) {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y));
  const x1 = Math.max(...boxes.map(b => b.x + b.w)), y1 = Math.max(...boxes.map(b => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const inBox = (p, b, pad = 0) => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
export const boxInBox = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
export const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// ── rotation ──────────────────────────────────────────────────────────────
// Shapes and text keep Excalidraw's `angle` (radians, clockwise, about the
// center of their unrotated box). Lines, arrows and pen strokes have their
// rotation baked into their points instead, so arrow binding stays simple.

export function rotate(p, c, a) {
  if (!a) return { x: p.x, y: p.y };
  const s = Math.sin(a), k = Math.cos(a), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * k - dy * s, y: c.y + dx * s + dy * k };
}
export const angleOf = el => (isLinear(el) ? 0 : el.angle || 0);
export const centerOf = el => center(bbox(el));
// A scene point in the element's own unrotated frame.
export const toLocal = (el, p) => rotate(p, centerOf(el), -angleOf(el));
export const toWorld = (el, p) => rotate(p, centerOf(el), angleOf(el));

// The four corners of the element's box, rotated.
export function corners(el) {
  const b = bbox(el);
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => toWorld(el, { x, y }));
}

// The axis-aligned box around the element as drawn (rotation included; for linear elements
// when `doc` is passed, uses live `drawnPoints(doc, el)` so bound arrows track moved targets).
export function bounds(el, doc = null) {
  if (doc && typeof doc.get === "function" && isLinear(el)) {
    const pts = drawnPoints(doc, el);
    if (pts.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }
  if (!angleOf(el)) return bbox(el);
  const cs = corners(el), xs = cs.map(c => c.x), ys = cs.map(c => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Turn an element by `da` about point `c` (a group's center): shapes move their
// center and add to their angle; linear elements rotate their points.
export function rotateAbout(el, orig, c, da) {
  if (isLinear(orig)) {
    const pts = orig.points.map(p => rotate({ x: orig.x + p[0], y: orig.y + p[1] }, c, da));
    el.x = pts[0].x; el.y = pts[0].y;
    el.points = pts.map(p => [p.x - pts[0].x, p.y - pts[0].y]);
    const b = bbox(el); el.width = b.w; el.height = b.h;
    return;
  }
  const oc = centerOf(orig), nc = rotate(oc, c, da), b = bbox(orig);
  el.x = nc.x - b.w / 2; el.y = nc.y - b.h / 2;
  el.angle = normAngle((orig.angle || 0) + da);
}
export function normAngle(a) { const t = Math.PI * 2; a %= t; if (a < 0) a += t; return Math.abs(a) < 1e-9 || Math.abs(a - t) < 1e-9 ? 0 : a; }

// Make width/height positive and linear boxes match their points.
export function normalize(el) {
  if (isShape(el) || el.type === "text" || isMedia(el)) {
    if (el.width < 0) { el.x += el.width; el.width = -el.width; }
    if (el.height < 0) { el.y += el.height; el.height = -el.height; }
  }
  if (isLinear(el)) {
    // Keep (x, y) at the first point, as Excalidraw does.
    const [fx, fy] = el.points[0];
    if (fx || fy) { el.x += fx; el.y += fy; el.points = el.points.map(p => [p[0] - fx, p[1] - fy]); }
    const b = bbox(el); el.width = b.w; el.height = b.h;
  }
  return el;
}

export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance from p to a shape's outline, negative inside.
export function outlineDistance(el, p) {
  p = toLocal(el, p);
  const b = bbox(el), c = center(b), rx = b.w / 2 || 1, ry = b.h / 2 || 1;
  const dx = p.x - c.x, dy = p.y - c.y;
  if (el.type === "ellipse") return (Math.hypot(dx / rx, dy / ry) - 1) * Math.min(rx, ry);
  if (el.type === "diamond") return (Math.abs(dx) / rx + Math.abs(dy) / ry - 1) * Math.min(rx, ry) * 0.7;
  const ox = Math.abs(dx) - rx, oy = Math.abs(dy) - ry;
  return ox > 0 || oy > 0 ? Math.hypot(Math.max(ox, 0), Math.max(oy, 0)) : Math.max(ox, oy);
}

// Is p on this element? Transparent shapes are hit on their outline (or label),
// filled ones anywhere inside — as on a whiteboard.
export function hits(doc, el, p, tol) {
  if (isLabel(el)) return false;
  if (isLinear(el)) {
    const pts = drawnPoints(doc, el);
    if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= tol + el.strokeWidth;
    for (let j = 1; j < pts.length; j++) if (distToSeg(p.x, p.y, pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]) <= tol + el.strokeWidth) return true;
    return false;
  }
  if (el.type === "text" || isMedia(el)) return inBox(toLocal(el, p), bbox(el), tol);   // media is opaque: hit anywhere on it
  if (el.type === "frame") { const b = bbox(el); return inBox(toLocal(el, p), { x: b.x, y: b.y - 24, w: b.w, h: 24 }) || Math.abs(outlineDistance(el, p)) <= tol; }
  const d = outlineDistance(el, p);
  if (Math.abs(d) <= tol + el.strokeWidth) return true;
  if (d < 0 && (el.backgroundColor !== "transparent" || doc.labelOf(el))) return true;
  return false;
}

// Topmost precise hit (an outline, a filled shape, text, a line). Failing that, the
// smallest unfilled shape the point is inside: empty boxes are selectable from
// anywhere inside, but a big one drawn on top doesn't block the shapes under it.
// Frames stay click-through inside so a marquee can start within them.
export function hitTest(doc, p, tol = 6, opts) {
  const els = spatialIndex(doc).queryPoint(p.x, p.y, tol + 24);
  if (opts?.stats) opts.stats.checked = (opts.stats.checked ?? 0) + els.length;
  for (let i = els.length - 1; i >= 0; i--) if (hits(doc, els[i], p, tol)) return els[i];
  let best = null, area = Infinity;
  for (const el of els) {
    if (!isShape(el) || el.type === "frame" || outlineDistance(el, p) > 0) continue;
    const b = bbox(el), a = b.w * b.h;
    if (a < area) { best = el; area = a; }
  }
  return best;
}

// The topmost shape whose box contains p (arrow binding targets).
export function shapeAt(doc, p, except) {
  const els = doc.visible();
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (!isShape(el) || el.type === "frame" || el.id === except) continue;
    if (inBox(toLocal(el, p), bbox(el), 4)) return el;
  }
  return null;
}

// What an arrow end can bind to: shapes (including frames), images and videos. Topmost first.
export const bindable = el => isShape(el) || isMedia(el);
// On the shape itself (inside, or within `pad` of its outline): a diamond's or an ellipse's
// empty box corners don't count; frames are hollow containers so only their outline binds.
export function bindTargetAt(doc, p, except, pad = 4) {
  const els = doc.visible();
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (!bindable(el) || el.id === except) continue;
    if (el.type === "frame") { if (Math.abs(outlineDistance(el, p)) <= pad) return el; }
    else if (isMedia(el) ? inBox(toLocal(el, p), bbox(el), pad) : outlineDistance(el, p) <= pad) return el;
  }
  return null;
}

// A shape's connection points: the middle of each side (a diamond's corners, an ellipse's
// ends), on the outline (`at`) and `gap` out from it (`bind`), with the Excalidraw
// `fixedPoint` an arrow end stores to stay there.
const SIDES = [["top", 0.5, 0, 0, -1], ["right", 1, 0.5, 1, 0], ["bottom", 0.5, 1, 0, 1], ["left", 0, 0.5, -1, 0]];
const BOX_CORNERS = [[0, 0, -Math.SQRT1_2, -Math.SQRT1_2], [1, 0, Math.SQRT1_2, -Math.SQRT1_2], [1, 1, Math.SQRT1_2, Math.SQRT1_2], [0, 1, -Math.SQRT1_2, Math.SQRT1_2]];
const SIDE_VEC = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const clamp01 = v => Math.max(0, Math.min(1, v));

function vecToSide(vx, vy) {
  return Math.abs(vx) >= Math.abs(vy) ? (vx >= 0 ? "right" : "left") : (vy >= 0 ? "bottom" : "top");
}
function rotVec(vx, vy, a) {
  if (!a) return [vx, vy];
  const s = Math.sin(a), k = Math.cos(a);
  return [vx * k - vy * s, vx * s + vy * k];
}
function worldSide(el, side) {
  if (!side || !SIDE_VEC[side]) return undefined;
  const a = angleOf(el);
  if (!a) return side;
  const [vx, vy] = SIDE_VEC[side];
  const [wx, wy] = rotVec(vx, vy, a);
  return vecToSide(wx, wy);
}

// Closest point on `el`'s outline to world point `p`, computed in `el`'s local unrotated frame.
// Returns { at: [wx, wy], normal: [wnx, wny], localNormal: [lnx, lny], fixedPoint: [fx, fy], side, d }.
export function closestPerimeterPoint(el, p) {
  const b = bbox({ ...el, angle: 0 });
  const q = toLocal(el, p);
  const a = angleOf(el);
  if (b.w < 1e-6 && b.h < 1e-6) {
    const at = toWorld(el, { x: b.x, y: b.y });
    const normal = rotVec(0, -1, a);
    return { at: [at.x, at.y], normal, localNormal: [0, -1], fixedPoint: [0.5, 0.5], side: "top", d: Math.hypot(at.x - p.x, at.y - p.y) };
  }
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const rx = b.w / 2 || 1e-6, ry = b.h / 2 || 1e-6;
  let lx, ly, lnx, lny, side;

  if (el.type === "ellipse") {
    const dx = q.x - cx, dy = q.y - cy;
    const px = Math.abs(dx), py = Math.abs(dy);
    if (px < 1e-9 && py < 1e-9) {
      if (rx <= ry) { lx = cx + rx; ly = cy; lnx = 1; lny = 0; side = "right"; }
      else { lx = cx; ly = cy - ry; lnx = 0; lny = -1; side = "top"; }
    } else {
      // Exact closest point on ellipse in the first quadrant via evolute projection.
      let tx = Math.SQRT1_2, ty = Math.SQRT1_2;
      for (let i = 0; i < 8; i++) {
        const x = rx * tx, y = ry * ty;
        const ex = (rx * rx - ry * ry) * tx * tx * tx / rx;
        const ey = (ry * ry - rx * rx) * ty * ty * ty / ry;
        const rx0 = x - ex, ry0 = y - ey;
        const qx = px - ex, qy = py - ey;
        const r = Math.hypot(rx0, ry0);
        const ql = Math.hypot(qx, qy);
        tx = Math.min(1, Math.max(0, (qx * r / (ql || 1) + ex) / rx));
        ty = Math.min(1, Math.max(0, (qy * r / (ql || 1) + ey) / ry));
        const l = Math.hypot(tx, ty) || 1;
        tx /= l; ty /= l;
      }
      lx = cx + (dx < 0 ? -1 : 1) * rx * tx;
      ly = cy + (dy < 0 ? -1 : 1) * ry * ty;
      const gx = (lx - cx) / (rx * rx), gy = (ly - cy) / (ry * ry);
      const gl = Math.hypot(gx, gy) || 1;
      lnx = gx / gl; lny = gy / gl;
      side = vecToSide((lx - cx) / rx, (ly - cy) / ry);
    }
  } else if (el.type === "diamond") {
    const verts = [[cx, b.y, 0, -1], [b.x + b.w, cy, 1, 0], [cx, b.y + b.h, 0, 1], [b.x, cy, -1, 0]];
    const segs = [
      [verts[0], verts[1], ry, -rx],
      [verts[1], verts[2], ry, rx],
      [verts[2], verts[3], -ry, rx],
      [verts[3], verts[0], -ry, -rx],
    ];
    let bestD = Infinity;
    for (const [v0, v1, enx, eny] of segs) {
      const sdx = v1[0] - v0[0], sdy = v1[1] - v0[1], l2 = sdx * sdx + sdy * sdy;
      const t = l2 ? clamp01(((q.x - v0[0]) * sdx + (q.y - v0[1]) * sdy) / l2) : 0;
      const sx = v0[0] + t * sdx, sy = v0[1] + t * sdy;
      const d = Math.hypot(q.x - sx, q.y - sy);
      if (d < bestD) {
        bestD = d;
        lx = sx; ly = sy;
        if (t < 1e-4) { lnx = v0[2]; lny = v0[3]; }
        else if (t > 1 - 1e-4) { lnx = v1[2]; lny = v1[3]; }
        else { const nl = Math.hypot(enx, eny) || 1; lnx = enx / nl; lny = eny / nl; }
      }
    }
    side = vecToSide((lx - cx) / rx, (ly - cy) / ry);
  } else {
    // Rectangle, frame, image, video: axis-aligned box in local space.
    const x0 = b.x, x1 = b.x + b.w, y0 = b.y, y1 = b.y + b.h;
    const cxp = Math.max(x0, Math.min(x1, q.x)), cyp = Math.max(y0, Math.min(y1, q.y));
    const cands = [
      [cxp, y0, 0, -1, "top"],
      [x1, cyp, 1, 0, "right"],
      [cxp, y1, 0, 1, "bottom"],
      [x0, cyp, -1, 0, "left"],
    ];
    let bestD = Infinity;
    for (const [ex, ey, enx, eny, es] of cands) {
      const d = Math.hypot(q.x - ex, q.y - ey);
      if (d < bestD) { bestD = d; lx = ex; ly = ey; lnx = enx; lny = eny; side = es; }
    }
    // At exact box corners, bisect the outward normal cleanly.
    const atL = Math.abs(lx - x0) < 1e-4, atR = Math.abs(lx - x1) < 1e-4;
    const atT = Math.abs(ly - y0) < 1e-4, atB = Math.abs(ly - y1) < 1e-4;
    if ((atL || atR) && (atT || atB)) {
      lnx = (atR ? 1 : -1) * Math.SQRT1_2;
      lny = (atB ? 1 : -1) * Math.SQRT1_2;
      side = vecToSide((q.x - cx) / rx, (q.y - cy) / ry);
    }
  }

  const at = toWorld(el, { x: lx, y: ly });
  const normal = rotVec(lnx, lny, a);
  const fixedPoint = [clamp01((lx - b.x) / (b.w || 1)), clamp01((ly - b.y) / (b.h || 1))];
  return {
    at: [at.x, at.y],
    normal,
    localNormal: [lnx, lny],
    fixedPoint,
    side,
    d: Math.hypot(at.x - p.x, at.y - p.y),
  };
}

export function portsOf(el, gap = 6) {
  const b = bbox({ ...el, angle: 0 });
  return SIDES.map(([side, fx, fy, nx, ny]) => {
    const on = { x: b.x + fx * b.w, y: b.y + fy * b.h }, out = { x: on.x + nx * gap, y: on.y + ny * gap };
    const at = toWorld(el, on), bind = toWorld(el, out);
    return { side, at: [at.x, at.y], bind: [bind.x, bind.y], fixedPoint: [fx, fy] };
  });
}
// The connection point within `tol` of p, on any bindable shape but `except`.
export function portAt(doc, p, tol, except) {
  let best = null;
  for (const el of doc.visible()) {
    if (!bindable(el) || el.id === except) continue;
    for (const port of portsOf(el)) {
      const d = Math.hypot(port.at[0] - p.x, port.at[1] - p.y);
      if (d <= tol && (!best || d < best.d)) best = { el, port, d };
    }
  }
  return best;
}

// Closest perimeter point within `tol` of `p` on any bindable target (except `except`),
// with gentle magnetic pull to cardinal ports (and corners on box shapes) within tight thresholds.
export function perimeterAt(doc, p, tol, except = null, { portTol, cornerTol } = {}) {
  let best = null;
  for (const el of doc.visible()) {
    if (!bindable(el) || el.id === except) continue;
    const hit = closestPerimeterPoint(el, p);
    if (hit.d <= tol && (!best || hit.d <= best.d + 1e-6)) best = { el, ...hit };
  }
  if (!best) return null;
  const { el } = best;
  const b = bbox({ ...el, angle: 0 });
  const minDim = Math.min(b.w, b.h);
  const pTol = Math.min(portTol ?? tol * 0.6, minDim * 0.25);
  const cTol = Math.min(cornerTol ?? tol * 0.45, minDim * 0.2);
  // Gentle magnetic pull to cardinal ports (N/S/E/W midpoints).
  let bestPort = null;
  for (const port of portsOf(el)) {
    const pd = Math.hypot(best.at[0] - port.at[0], best.at[1] - port.at[1]);
    if (pd <= pTol && (!bestPort || pd < bestPort.pd)) bestPort = { port, pd };
  }
  if (bestPort) {
    const port = bestPort.port;
    const [lnx, lny] = SIDE_VEC[port.side];
    return {
      el,
      at: port.at,
      normal: rotVec(lnx, lny, angleOf(el)),
      localNormal: [lnx, lny],
      fixedPoint: port.fixedPoint,
      side: port.side,
      edgeSide: port.side,
      d: best.d,
      snapped: "port",
    };
  }
  // Gentle magnetic pull to corners on box-shaped targets (rectangle, frame, image, video).
  if (el.type !== "ellipse" && el.type !== "diamond") {
    let bestCorner = null;
    for (const [fx, fy, lnx, lny] of BOX_CORNERS) {
      const w = toWorld(el, { x: b.x + fx * b.w, y: b.y + fy * b.h });
      const cd = Math.hypot(best.at[0] - w.x, best.at[1] - w.y);
      if (cd <= cTol && (!bestCorner || cd < bestCorner.cd)) bestCorner = { at: [w.x, w.y], fixedPoint: [fx, fy], lnx, lny, cd };
    }
    if (bestCorner) {
      return {
        el,
        at: bestCorner.at,
        normal: rotVec(bestCorner.lnx, bestCorner.lny, angleOf(el)),
        localNormal: [bestCorner.lnx, bestCorner.lny],
        fixedPoint: bestCorner.fixedPoint,
        side: null,
        edgeSide: best.side,
        d: best.d,
        snapped: "corner",
      };
    }
  }
  return {
    el,
    at: best.at,
    normal: best.normal,
    localNormal: best.localNormal,
    fixedPoint: best.fixedPoint,
    side: null,
    edgeSide: best.side,
    d: best.d,
    snapped: "edge",
  };
}

// Resolve the binding at world point `p`: perimeter snap (with cardinal/corner magnet) first,
// else interior body binding (aimed at the other end) for shapes & media.
export function bindingAt(doc, p, { tol = 12, portTol, cornerTol, pad = 8, except = null, gap = 6 } = {}) {
  const perim = perimeterAt(doc, p, tol, except, { portTol, cornerTol });
  if (perim) {
    const binding = perim.side != null
      ? { elementId: perim.el.id, focus: 0, gap, fixedPoint: perim.fixedPoint, side: perim.side }
      : { elementId: perim.el.id, focus: 0, gap, fixedPoint: perim.fixedPoint };
    return { ...perim, binding };
  }
  const s = bindTargetAt(doc, p, except, pad);
  if (!s) return null;
  return {
    el: s,
    at: null,
    normal: null,
    localNormal: null,
    fixedPoint: null,
    side: null,
    edgeSide: null,
    d: 0,
    snapped: "body",
    binding: { elementId: s.id, focus: 0, gap },
  };
}

function resolveBindingDetails(shape, b) {
  if (!b || !bindable(shape)) return null;
  const gap = b.gap ?? 6;
  if (Array.isArray(b.fixedPoint) && b.fixedPoint.length >= 2 && Number.isFinite(b.fixedPoint[0]) && Number.isFinite(b.fixedPoint[1])) {
    const box = bbox({ ...shape, angle: 0 });
    const localW = { x: box.x + b.fixedPoint[0] * box.w, y: box.y + b.fixedPoint[1] * box.h };
    const w = toWorld(shape, localW);
    const degenerate = box.w < 1e-6 || box.h < 1e-6;
    const inside = !degenerate && (isMedia(shape) ? inBox(localW, box, -0.5) : outlineDistance(shape, w) < -0.5);
    if (inside) return null;
    const hit = closestPerimeterPoint(shape, w);
    return {
      at: hit.at,
      normal: hit.normal,
      point: [hit.at[0] + hit.normal[0] * gap, hit.at[1] + hit.normal[1] * gap],
      worldSide: b.side ? worldSide(shape, b.side) : vecToSide(hit.normal[0], hit.normal[1]),
    };
  }
  if (b.side) {
    const port = portsOf(shape, gap).find(p => p.side === b.side);
    if (port) {
      const [lnx, lny] = SIDE_VEC[b.side];
      const normal = rotVec(lnx, lny, angleOf(shape));
      return { at: port.at, normal, point: port.bind, worldSide: worldSide(shape, b.side) };
    }
  }
  return null;
}

// Resolve a binding's exact world endpoint `[x, y]` (on the shape's outline + gap along its outward normal),
// or `null` if the binding aims dynamically at the opposite end.
export function resolveBindingPoint(shape, b) {
  return resolveBindingDetails(shape, b)?.point ?? null;
}

function fixedEnd(shape, b) {
  return resolveBindingPoint(shape, b);
}

// Where a ray from a shape's center toward (tx, ty) leaves its outline, plus gap.
export function edgePoint(el, tx, ty, gap = 6) {
  const a = angleOf(el);
  if (a) {   // work in the shape's own frame, then turn the answer back
    const t = toLocal(el, { x: tx, y: ty }), q = edgePoint({ ...el, angle: 0 }, t.x, t.y, gap), w = toWorld(el, { x: q[0], y: q[1] });
    return [w.x, w.y];
  }
  const b = bbox(el), c = center(b), rx = b.w / 2 || 1, ry = b.h / 2 || 1;
  const dx = tx - c.x, dy = ty - c.y, len = Math.hypot(dx, dy) || 1;
  let t;
  if (el.type === "ellipse") t = 1 / (Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2) || 1);
  else if (el.type === "diamond") t = 1 / ((Math.abs(dx) / rx + Math.abs(dy) / ry) || 1);
  else t = 1 / (Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry) || 1);
  return [c.x + dx * t + (dx / len) * gap, c.y + dy * t + (dy / len) * gap];
}

// Absolute points of a linear element, with bound ends snapped to their
// shapes' outlines. Agents set only startBinding/endBinding; this does the rest.
export function resolvedPoints(doc, el) {
  const pts = el.points.map(p => [p[0] + el.x, p[1] + el.y]);
  if (el.type === "freedraw" || pts.length < 2) return pts;
  const s = el.startBinding && doc.get(el.startBinding.elementId), e = el.endBinding && doc.get(el.endBinding.elementId);
  if (el.elbowed) {   // right angles, routed from the ends (bound shapes, or the first/last points), around other shapes
    const key = `${doc.rev}|${el.id}|${el.version}`;
    const memo = (doc._elbow ??= new Map());
    if (memo.get(el.id)?.key === key) return memo.get(el.id).pts.map(p => [...p]);
    const end = p => ({ point: { x: p[0], y: p[1] } });
    const elbowEnd = (shape, binding, fallbackPt) => {
      if (!shape) return end(fallbackPt);
      const box = bounds(shape);
      const det = resolveBindingDetails(shape, binding);
      if (det) return { box, side: det.worldSide, anchor: { x: det.point[0], y: det.point[1] } };
      const side = worldSide(shape, binding?.side);
      return side ? { box, side } : { box };
    };
    const obstacles = doc.visible().filter(o => bindable(o) && o.type !== "frame" && o !== s && o !== e).map(bounds);
    const fromEnd = elbowEnd(s, el.startBinding, pts[0]);
    const toEnd = elbowEnd(e, el.endBinding, pts[pts.length - 1]);
    const r = elbowRoute(fromEnd, toEnd, el.startBinding?.gap ?? el.endBinding?.gap ?? 6, obstacles);
    const out = r.points.map(p => [p.x, p.y]);
    memo.set(el.id, { key, pts: out });
    return out.map(p => [...p]);
  }
  const cOf = x => { const c = center(bbox(x)); return [c.x, c.y]; };
  // Ends on a connection point stay there; the others aim at the far end (pinned, a shape's
  // center, or the next point) and sit on their outline.
  const fs = s && fixedEnd(s, el.startBinding), fe = e && fixedEnd(e, el.endBinding), last = pts.length - 1;
  if (fs) pts[0] = fs;
  if (fe) pts[last] = fe;
  if (s && !fs) { const to = pts.length === 2 ? (fe ?? (e ? cOf(e) : pts[1])) : pts[1]; pts[0] = edgePoint(s, to[0], to[1], el.startBinding.gap ?? 6); }
  if (e && !fe) { const from = pts.length === 2 ? (fs ?? (s ? cOf(s) : pts[0])) : pts[last - 1]; pts[last] = edgePoint(e, from[0], from[1], el.endBinding.gap ?? 6); }
  return pts;
}

// A Catmull-Rom curve through every point, as short straight steps: how a curved line
// (roundness set) is drawn, hit and labelled. excalidraw.com draws the same kind of curve
// (rough.js's curve through the points). Never stored: the file keeps only the points.
export function curveThrough(pts, steps = 12) {
  if (pts.length < 3) return pts.map(p => [...p]);
  const out = [[...pts[0]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? pts[i + 1];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

// The line as drawn: bound ends resolved, curved through its points when it's a curve.
export function drawnPoints(doc, el) {
  const pts = resolvedPoints(doc, el);
  return el.roundness && !el.elbowed && el.type !== "freedraw" ? curveThrough(pts) : pts;
}

// Excalidraw's `fixedPoint` for an elbow end at world point p: where it sits on the bound
// shape, as a fraction of the shape's unrotated box (past 0..1 when the end keeps a gap off
// the outline). excalidraw.com re-routes elbows from it; an elbow binding without one gets
// pinned to the shape's center there. Exactly 0.5 is nudged to 0.5001, as excalidraw.com does.
export function fixedPointOf(shape, p) {
  const b = bbox({ ...shape, angle: 0 }), q = toLocal(shape, { x: p[0], y: p[1] });
  const f = v => (Math.abs(v - 0.5) < 0.0001 ? 0.5001 : v);
  return [f((q.x - b.x) / (b.w || 1)), f((q.y - b.y) / (b.h || 1))];
}

// An elbow's bindings with fixedPoints for its resolved ends `pts`; other arrows' without.
// During live `settle`, keep user-pinned fixedPoints intact and leave auto-sided elbows unpinned
// so they continue detouring freely; `auto: true` (fileScene export) derives fixedPoints for excalidraw.com.
function withFixedPoints(doc, el, pts, { auto = false } = {}) {
  const out = {};
  for (const [k, p] of [["startBinding", pts[0]], ["endBinding", pts[pts.length - 1]]]) {
    const b = el[k], shape = b && doc.get(b.elementId);
    if (!b) continue;
    if (el.elbowed && shape) {
      if (auto && !b.fixedPoint) out[k] = { ...b, fixedPoint: fixedPointOf(shape, p) };
    } else if (b.fixedPoint && !(shape && fixedEnd(shape, b))) {
      const { fixedPoint, ...rest } = b; out[k] = rest;   // a connection point keeps its fixedPoint
    }
  }
  return out;
}
const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Bake resolved arrow geometry into the element, so other tools see it right.
export function settle(doc, el) {
  if ((el.type !== "arrow" && el.type !== "line") || (!el.startBinding && !el.endBinding && !el.elbowed)) return false;
  const pts = resolvedPoints(doc, el);
  const next = pts.map(p => [p[0] - pts[0][0], p[1] - pts[0][1]]);
  const bindings = withFixedPoints(doc, el, pts);
  if (el.x === pts[0][0] && el.y === pts[0][1] && JSON.stringify(next) === JSON.stringify(el.points) &&
      Object.entries(bindings).every(([k, b]) => sameBinding(el[k], b))) return false;
  el.x = pts[0][0]; el.y = pts[0][1]; el.points = next;
  Object.assign(el, bindings);
  const b = bbox(el); el.width = b.w; el.height = b.h;
  return true;
}

// The scene as written to the file, for tools that read the geometry as stored (excalidraw.com):
// - elbows never settled since fixedPoints existed (older boards) get theirs;
// - labels get the box Excalidraw paints them in: centered in their shape (wrapped as we wrap
//   them), or halfway along their arrow. We derive labels' places when drawing, so these
//   fields are derived too, and change no versions.
export function fileScene(doc, scene) {
  const elements = scene.elements.map(e => {
    if (e.isDeleted) return e;
    if (e.elbowed && (e.startBinding && !e.startBinding.fixedPoint || e.endBinding && !e.endBinding.fixedPoint))
      return { ...e, ...withFixedPoints(doc, e, resolvedPoints(doc, e), { auto: true }) };
    if (e.type === "text" && e.containerId) {
      const host = doc.get(e.containerId), b = host && labelBox(doc, e, host);
      if (b && (b.x !== e.x || b.y !== e.y || b.width !== e.width || b.height !== e.height)) return { ...e, ...b };
    }
    return e;
  });
  return { ...scene, elements };
}

function labelBox(doc, label, host) {
  const lh = label.lineHeight ?? 1.25;
  let c, lines;
  if (isLinear(host)) {
    const m = labelAnchor(doc, host); if (!m) return null;
    c = { x: m[0], y: m[1] }; lines = String(label.text ?? "").split("\n");
  } else { c = center(bbox({ ...host, angle: 0 })); lines = labelLines(label, host); }
  const width = Math.max(1, ...lines.map(l => textSize(l, label.fontSize, lh, label.fontFamily).w)), height = lines.length * label.fontSize * lh;
  return { x: c.x - width / 2, y: c.y - height / 2, width, height };
}

// Map an element from box `from` into box `to` (resizing a selection).
export function mapIntoBox(el, orig, from, to) {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const mx = x => to.x + (x - from.x) * sx, my = y => to.y + (y - from.y) * sy;
  if (isLinear(orig)) {
    el.x = mx(orig.x); el.y = my(orig.y);
    el.points = orig.points.map(p => [p[0] * sx, p[1] * sy]);
    const b = bbox(el); el.width = b.w; el.height = b.h;
  } else {
    el.x = mx(orig.x); el.y = my(orig.y); el.width = orig.width * sx; el.height = orig.height * sy;
    if (el.type === "text" && !el.containerId) el.fontSize = Math.max(6, orig.fontSize * Math.min(Math.abs(sx), Math.abs(sy)));
  }
}

// Where an arrow's label sits, as excalidraw.com puts it (probed 2026-11-11 by editing labels there):
// an odd number of points, the middle point; an even number, halfway along the middle stretch, on the
// curve when the arrow is curved. Not halfway along the length: on a bent arrow that differs.
export function labelAnchor(doc, el) {
  const pts = resolvedPoints(doc, el), n = pts.length;
  if (n < 2) return null;
  if (n % 2) return [...pts[(n - 1) / 2]];
  const i = n / 2 - 1, p1 = pts[i], p2 = pts[i + 1];
  if (!(el.roundness && !el.elbowed) || n < 3) return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const p0 = pts[i - 1] ?? p1, p3 = pts[i + 2] ?? p2;   // curveThrough at t = 0.5 on that stretch
  const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * 0.5 + (2 * a - 5 * b + 4 * c - d) * 0.25 + (3 * b - a - 3 * c + d) * 0.125);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

// The point a fraction of the way along a polyline (by length).
export function alongPath(pts, f = 0.5) {
  let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let left = total * f;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (seg >= left) { const k = seg ? left / seg : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
    left -= seg;
  }
  return pts[pts.length - 1];
}

export function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
