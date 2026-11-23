// @ts-check
// Pure layout engine: align, distribute, tidy (row / column / 2D grid), and smart snap guides.

import { bbox, bounds, unionBox } from "./geometry.js";
import { isLabel } from "./model.js";

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Box
 * @typedef {{ id: string, dx: number, dy: number }} Shift
 * @typedef {{ axis: "x" | "y", at: number, from: number, to: number }} Guide
 * @typedef {"left" | "center-x" | "right" | "top" | "center-y" | "bottom" | "hcenter" | "vcenter"} AlignMode
 * @typedef {"horizontal" | "vertical" | "h" | "v"} DistributeAxis
 * @typedef {{ gap?: number, doc?: any }} TidyOptions
 */

const EPS = 1e-9;
const clean = v => (Math.abs(v) < EPS ? 0 : v);

/**
 * Compute axis-aligned bounds for an element (rotation-aware via `bounds`, with `bbox` fallback).
 * @param {any} el
 * @param {any} [doc]
 * @returns {Box | null}
 */
function elementBox(el, doc = null) {
  const b = bounds(el, doc) ?? bbox(el);
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) return null;
  return b;
}

/**
 * Group unlocked, non-label elements into atomic layout units.
 * Elements sharing an outermost groupId move together using their combined `unionBox`.
 * If any non-label member of a group is locked, the entire group unit is skipped.
 * @param {any[]} elements
 * @param {any} [doc]
 * @returns {{ members: any[], box: Box, index: number }[]}
 */
function buildUnits(elements, doc = null) {
  if (!Array.isArray(elements) || !elements.length) return [];
  /** @type {Map<string, { members: any[], locked: boolean, index: number }>} */
  const groups = new Map();
  /** @type {({ kind: "group", gid: string } | { kind: "single", el: any, index: number })[]} */
  const order = [];
  let idx = 0;

  for (const el of elements) {
    if (!el || el.isDeleted || isLabel(el)) continue;
    const gids = Array.isArray(el.groupIds) ? el.groupIds : null;
    const gid = gids && gids.length ? gids[gids.length - 1] : null;
    if (gid) {
      let g = groups.get(gid);
      if (!g) {
        g = { members: [], locked: false, index: idx++ };
        groups.set(gid, g);
        order.push({ kind: "group", gid });
      }
      if (el.locked) g.locked = true;
      g.members.push(el);
    } else {
      if (el.locked) continue;
      order.push({ kind: "single", el, index: idx++ });
    }
  }

  /** @type {{ members: any[], box: Box, index: number }[]} */
  const units = [];
  for (const entry of order) {
    if (entry.kind === "group") {
      const g = groups.get(entry.gid);
      if (!g || g.locked || !g.members.length) continue;
      const boxes = g.members.map(m => elementBox(m, doc)).filter(Boolean);
      const box = boxes.length ? unionBox(boxes) : null;
      if (box) units.push({ members: g.members, box, index: g.index });
    } else {
      const box = elementBox(entry.el, doc);
      if (box) units.push({ members: [entry.el], box, index: entry.index });
    }
  }
  return units;
}

/**
 * Emit non-zero shifts for all members of a layout unit.
 * @param {Shift[]} out
 * @param {{ members: any[] }} unit
 * @param {number} dx
 * @param {number} dy
 */
function pushUnitShift(out, unit, dx, dy) {
  const sx = clean(dx);
  const sy = clean(dy);
  if (!sx && !sy) return;
  for (const el of unit.members) out.push({ id: el.id, dx: sx, dy: sy });
}

/**
 * Normalize alignment mode aliases.
 * @param {string} mode
 * @returns {"left" | "center-x" | "right" | "top" | "center-y" | "bottom" | null}
 */
function normalizeAlignMode(mode) {
  if (mode === "hcenter") return "center-x";
  if (mode === "vcenter") return "center-y";
  if (mode === "left" || mode === "center-x" || mode === "right" || mode === "top" || mode === "center-y" || mode === "bottom") {
    return mode;
  }
  return null;
}

/**
 * Align unlocked non-label elements (respecting groups and rotated bounding boxes).
 * @param {any[]} elements
 * @param {AlignMode} mode
 * @param {{ doc?: any }} [opts]
 * @returns {Shift[]}
 */
export function alignElements(elements, mode, opts = {}) {
  const m = normalizeAlignMode(mode);
  if (!m) return [];
  const units = buildUnits(elements, opts?.doc ?? null);
  if (units.length < 2) return [];
  const target = unionBox(units.map(u => u.box));
  if (!target) return [];

  /** @type {Shift[]} */
  const shifts = [];
  for (const u of units) {
    const b = u.box;
    let dx = 0;
    let dy = 0;
    switch (m) {
      case "left": dx = target.x - b.x; break;
      case "center-x": dx = (target.x + target.w / 2) - (b.x + b.w / 2); break;
      case "right": dx = (target.x + target.w) - (b.x + b.w); break;
      case "top": dy = target.y - b.y; break;
      case "center-y": dy = (target.y + target.h / 2) - (b.y + b.h / 2); break;
      case "bottom": dy = (target.y + target.h) - (b.y + b.h); break;
    }
    pushUnitShift(shifts, u, dx, dy);
  }
  return shifts;
}

/**
 * Distribute unlocked non-label elements with equal gaps along an axis, preserving outer bounds.
 * Requires at least 3 unlocked non-label units.
 * @param {any[]} elements
 * @param {DistributeAxis} axis
 * @param {{ doc?: any }} [opts]
 * @returns {Shift[]}
 */
export function distributeElements(elements, axis, opts = {}) {
  const horiz = axis === "horizontal" || axis === "h";
  const vert = axis === "vertical" || axis === "v";
  if (!horiz && !vert) return [];
  const units = buildUnits(elements, opts?.doc ?? null);
  if (units.length < 3) return [];

  const pos = horiz ? "x" : "y";
  const size = horiz ? "w" : "h";
  const cross = horiz ? "y" : "x";

  const sorted = [...units].sort((a, b) =>
    (a.box[pos] - b.box[pos])
    || ((a.box[pos] + a.box[size] / 2) - (b.box[pos] + b.box[size] / 2))
    || (a.box[cross] - b.box[cross])
    || (a.index - b.index),
  );

  const minStart = sorted[0].box[pos];
  let maxEnd = -Infinity;
  let totalSize = 0;
  for (const u of sorted) {
    const end = u.box[pos] + u.box[size];
    if (end > maxEnd) maxEnd = end;
    totalSize += u.box[size];
  }

  const gap = (maxEnd - minStart - totalSize) / (sorted.length - 1);
  /** @type {Shift[]} */
  const shifts = [];
  let cursor = minStart;
  for (const u of sorted) {
    const delta = cursor - u.box[pos];
    pushUnitShift(shifts, u, horiz ? delta : 0, vert ? delta : 0);
    cursor += u.box[size] + gap;
  }
  return shifts;
}

/**
 * Cluster units along an axis ("y" for rows, "x" for columns) based on interval overlap or center proximity.
 * @param {{ members: any[], box: Box, index: number }[]} units
 * @param {"x" | "y"} axis
 * @returns {{ members: any[], box: Box, index: number }[][]}
 */
function clusterTracks(units, axis) {
  const pos = axis;
  const size = axis === "x" ? "w" : "h";
  const cross = axis === "x" ? "y" : "x";
  const sorted = [...units].sort((a, b) =>
    ((a.box[pos] + a.box[size] / 2) - (b.box[pos] + b.box[size] / 2))
    || (a.box[pos] - b.box[pos])
    || (a.box[cross] - b.box[cross])
    || (a.index - b.index),
  );

  /** @type {{ items: typeof units, min: number, max: number, centerSum: number, sizeSum: number }[]} */
  const tracks = [];
  for (const u of sorted) {
    const uMin = u.box[pos];
    const uMax = u.box[pos] + u.box[size];
    const uCenter = uMin + u.box[size] / 2;
    const cur = tracks[tracks.length - 1];
    if (cur) {
      const avgCenter = cur.centerSum / cur.items.length;
      const avgSize = cur.sizeSum / cur.items.length;
      const overlap = Math.min(cur.max, uMax) - Math.max(cur.min, uMin);
      const closeCenter = Math.abs(uCenter - avgCenter) <= Math.max(avgSize, u.box[size]) * 0.5;
      if (overlap > 0 || closeCenter) {
        cur.items.push(u);
        if (uMin < cur.min) cur.min = uMin;
        if (uMax > cur.max) cur.max = uMax;
        cur.centerSum += uCenter;
        cur.sizeSum += u.box[size];
        continue;
      }
    }
    tracks.push({ items: [u], min: uMin, max: uMax, centerSum: uCenter, sizeSum: u.box[size] });
  }
  return tracks.map(t => t.items);
}

/**
 * Auto-layout ("tidy") unlocked non-label elements into a neat row, column, or 2D grid with consistent `gap`.
 * @param {any[]} elements
 * @param {TidyOptions} [opts]
 * @returns {Shift[]}
 */
export function tidyElements(elements, { gap = 24, doc = null } = {}) {
  const units = buildUnits(elements, doc);
  if (units.length < 2) return [];
  const g = Number.isFinite(gap) ? Math.max(0, gap) : 24;
  const boundsAll = unionBox(units.map(u => u.box));
  if (!boundsAll) return [];

  /** @type {Shift[]} */
  const shifts = [];

  if (units.length === 2) {
    const a = units[0].box;
    const b = units[1].box;
    const dxCenter = Math.abs((b.x + b.w / 2) - (a.x + a.w / 2));
    const dyCenter = Math.abs((b.y + b.h / 2) - (a.y + a.h / 2));
    if (dxCenter >= dyCenter) {
      return layoutRow(units, boundsAll, g);
    }
    return layoutColumn(units, boundsAll, g);
  }

  const rows = clusterTracks(units, "y");
  if (rows.length === 1) {
    return layoutRow(units, boundsAll, g);
  }

  const cols = clusterTracks(units, "x");
  if (cols.length === 1) {
    return layoutColumn(units, boundsAll, g);
  }

  const hasMultiRow = rows.some(r => r.length > 1);
  const hasMultiCol = cols.some(c => c.length > 1);
  if (!hasMultiRow && !hasMultiCol) {
    // Diagonal / scattered 1D-like arrangement: pick dominant axis by center spread.
    let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;
    for (const u of units) {
      const cx = u.box.x + u.box.w / 2;
      const cy = u.box.y + u.box.h / 2;
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
    }
    return (maxCx - minCx) >= (maxCy - minCy)
      ? layoutRow(units, boundsAll, g)
      : layoutColumn(units, boundsAll, g);
  }

  // 2D grid layout: sort each row left-to-right, align into uniform column & row tracks.
  const orderedRows = rows.map(r =>
    [...r].sort((a, b) => (a.box.x - b.box.x) || (a.box.y - b.box.y) || (a.index - b.index)),
  );
  const numCols = Math.max(...orderedRows.map(r => r.length));
  const colWidths = new Array(numCols).fill(0);
  const rowHeights = orderedRows.map(r => {
    let mh = 0;
    for (let c = 0; c < r.length; c++) {
      if (r[c].box.w > colWidths[c]) colWidths[c] = r[c].box.w;
      if (r[c].box.h > mh) mh = r[c].box.h;
    }
    return mh;
  });

  const colX = new Array(numCols);
  let cx = boundsAll.x;
  for (let c = 0; c < numCols; c++) {
    colX[c] = cx;
    cx += colWidths[c] + g;
  }

  let ry = boundsAll.y;
  for (let r = 0; r < orderedRows.length; r++) {
    const row = orderedRows[r];
    const rh = rowHeights[r];
    for (let c = 0; c < row.length; c++) {
      const u = row[c];
      const tx = colX[c] + (colWidths[c] - u.box.w) / 2;
      const ty = ry + (rh - u.box.h) / 2;
      pushUnitShift(shifts, u, tx - u.box.x, ty - u.box.y);
    }
    ry += rh + g;
  }
  return shifts;
}

/**
 * @param {{ members: any[], box: Box, index: number }[]} units
 * @param {Box} boundsAll
 * @param {number} gap
 * @returns {Shift[]}
 */
function layoutRow(units, boundsAll, gap) {
  const sorted = [...units].sort((a, b) => (a.box.x - b.box.x) || (a.box.y - b.box.y) || (a.index - b.index));
  let maxH = 0;
  for (const u of sorted) if (u.box.h > maxH) maxH = u.box.h;
  const centerY = boundsAll.y + maxH / 2;

  /** @type {Shift[]} */
  const shifts = [];
  let x = boundsAll.x;
  for (const u of sorted) {
    const ty = centerY - u.box.h / 2;
    pushUnitShift(shifts, u, x - u.box.x, ty - u.box.y);
    x += u.box.w + gap;
  }
  return shifts;
}

/**
 * @param {{ members: any[], box: Box, index: number }[]} units
 * @param {Box} boundsAll
 * @param {number} gap
 * @returns {Shift[]}
 */
function layoutColumn(units, boundsAll, gap) {
  const sorted = [...units].sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x) || (a.index - b.index));
  let maxW = 0;
  for (const u of sorted) if (u.box.w > maxW) maxW = u.box.w;
  const centerX = boundsAll.x + maxW / 2;

  /** @type {Shift[]} */
  const shifts = [];
  let y = boundsAll.y;
  for (const u of sorted) {
    const tx = centerX - u.box.w / 2;
    pushUnitShift(shifts, u, tx - u.box.x, y - u.box.y);
    y += u.box.h + gap;
  }
  return shifts;
}

/**
 * Compute live edge & center alignment snap offsets and guide lines for a moving box
 * against static boxes in a single O(N) pass bounded to nearby candidates.
 * @param {Box | null} movingBox
 * @param {Box[]} staticBoxes
 * @param {number} [tol]
 * @returns {{ dx: number, dy: number, guides: Guide[] }}
 */
export function computeSmartGuides(movingBox, staticBoxes, tol = 6) {
  if (!movingBox || !Array.isArray(staticBoxes) || !staticBoxes.length || !(tol > 0)) {
    return { dx: 0, dy: 0, guides: [] };
  }

  const mx0 = movingBox.x;
  const mxc = movingBox.x + movingBox.w / 2;
  const mx1 = movingBox.x + movingBox.w;
  const my0 = movingBox.y;
  const myc = movingBox.y + movingBox.h / 2;
  const my1 = movingBox.y + movingBox.h;
  const mxs = [mx0, mxc, mx1];
  const mys = [my0, myc, my1];

  let bestDx = Infinity;
  let bestDxAbs = tol + 1;
  let bestDxDist = Infinity;
  let bestDy = Infinity;
  let bestDyAbs = tol + 1;
  let bestDyDist = Infinity;

  /** @type {Box[]} */
  const nearX = [];
  /** @type {Box[]} */
  const nearY = [];

  for (let i = 0; i < staticBoxes.length; i++) {
    const b = staticBoxes[i];
    if (!b) continue;
    const bx0 = b.x;
    const bx1 = b.x + b.w;
    const by0 = b.y;
    const by1 = b.y + b.h;

    // Fast O(1) AABB range rejection for X-axis candidates.
    if (bx1 >= mx0 - tol && bx0 <= mx1 + tol) {
      const bxc = bx0 + b.w / 2;
      const perpDist = by1 < my0 ? my0 - by1 : (by0 > my1 ? by0 - my1 : 0);
      let hitX = false;
      for (let j = 0; j < 3; j++) {
        const a = mxs[j];
        for (let k = 0; k < 3; k++) {
          const t = k === 0 ? bx0 : (k === 1 ? bxc : bx1);
          const d = t - a;
          const ad = Math.abs(d);
          if (ad <= tol) {
            hitX = true;
            if (ad < bestDxAbs - 1e-6 || (Math.abs(ad - bestDxAbs) <= 1e-6 && perpDist < bestDxDist)) {
              bestDxAbs = ad;
              bestDx = d;
              bestDxDist = perpDist;
            }
          }
        }
      }
      if (hitX) nearX.push(b);
    }

    // Fast O(1) AABB range rejection for Y-axis candidates.
    if (by1 >= my0 - tol && by0 <= my1 + tol) {
      const byc = by0 + b.h / 2;
      const perpDist = bx1 < mx0 ? mx0 - bx1 : (bx0 > mx1 ? bx0 - mx1 : 0);
      let hitY = false;
      for (let j = 0; j < 3; j++) {
        const a = mys[j];
        for (let k = 0; k < 3; k++) {
          const t = k === 0 ? by0 : (k === 1 ? byc : by1);
          const d = t - a;
          const ad = Math.abs(d);
          if (ad <= tol) {
            hitY = true;
            if (ad < bestDyAbs - 1e-6 || (Math.abs(ad - bestDyAbs) <= 1e-6 && perpDist < bestDyDist)) {
              bestDyAbs = ad;
              bestDy = d;
              bestDyDist = perpDist;
            }
          }
        }
      }
      if (hitY) nearY.push(b);
    }
  }

  const dx = bestDxAbs <= tol ? clean(bestDx) : 0;
  const dy = bestDyAbs <= tol ? clean(bestDy) : 0;
  const sx0 = mx0 + dx;
  const sxc = mxc + dx;
  const sx1 = mx1 + dx;
  const sy0 = my0 + dy;
  const syc = myc + dy;
  const sy1 = my1 + dy;

  /** @type {Guide[]} */
  const guides = [];

  if (bestDxAbs <= tol) {
    /** @type {{ at: number, from: number, to: number }[]} */
    const xLines = [];
    const sxs = [sx0, sxc, sx1];
    for (const b of nearX) {
      const txs = [b.x, b.x + b.w / 2, b.x + b.w];
      for (const a of sxs) {
        for (const t of txs) {
          if (Math.abs(t - a) <= 1e-4) {
            const from = Math.min(sy0, b.y);
            const to = Math.max(sy1, b.y + b.h);
            const prev = xLines.find(line => Math.abs(line.at - t) <= 1e-4);
            if (prev) {
              if (from < prev.from) prev.from = from;
              if (to > prev.to) prev.to = to;
            } else {
              xLines.push({ at: t, from, to });
            }
          }
        }
      }
    }
    for (const g of xLines) guides.push({ axis: "x", at: g.at, from: g.from, to: g.to });
  }

  if (bestDyAbs <= tol) {
    /** @type {{ at: number, from: number, to: number }[]} */
    const yLines = [];
    const sys = [sy0, syc, sy1];
    for (const b of nearY) {
      const tys = [b.y, b.y + b.h / 2, b.y + b.h];
      for (const a of sys) {
        for (const t of tys) {
          if (Math.abs(t - a) <= 1e-4) {
            const from = Math.min(sx0, b.x);
            const to = Math.max(sx1, b.x + b.w);
            const prev = yLines.find(line => Math.abs(line.at - t) <= 1e-4);
            if (prev) {
              if (from < prev.from) prev.from = from;
              if (to > prev.to) prev.to = to;
            } else {
              yLines.push({ at: t, from, to });
            }
          }
        }
      }
    }
    for (const g of yLines) guides.push({ axis: "y", at: g.at, from: g.from, to: g.to });
  }

  return { dx, dy, guides };
}
