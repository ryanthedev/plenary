// Uniform-grid spatial index over Doc's visible elements (M3 Phase 1).
// Pure core module: no DOM or host globals. Invalidated automatically when `doc.rev` changes.
// Preserves exact `doc.visible()` paint order on every query.

import { isLinear, isLabel } from "./model.js";
import { bbox, bounds } from "./geometry.js";

export const DEFAULT_CELL_SIZE = 256;
const MAX_CELLS_PER_EL = 64;

/** @type {WeakMap<object, { rev: number, cellSize: number, index: SpatialIndex }>} */
const cache = new WeakMap();

/** Generous world-space AABB for indexing one element, or null if it must always be visited. */
function indexBox(doc, el) {
  let host = el;
  if (isLabel(el)) {
    host = doc.get(el.containerId);
    if (!host || isLinear(host)) return null;   // linear labels ride routed paths
  }
  if (isLinear(host)) {
    // Arrows bound to shapes can re-route when their targets move; keep them in `always`.
    if (host.startBinding?.elementId || host.endBinding?.elementId) return null;
    const b = bbox(host);
    const pad = (host.strokeWidth ?? 2) + 28;   // arrowheads + curve bow + roughness
    return { x0: b.x - pad, y0: b.y - pad, x1: b.x + b.w + pad, y1: b.y + b.h + pad };
  }
  const b = bounds(host);
  const pad = (host.strokeWidth ?? 2) + 12;
  const topPad = host.type === "frame" ? 28 : pad;   // frame title sits above its top edge
  return { x0: b.x - pad, y0: b.y - topPad, x1: b.x + b.w + pad, y1: b.y + b.h + pad };
}

export class SpatialIndex {
  /** @param {import("./doc.js").Doc} doc @param {number} [cellSize] */
  constructor(doc, cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
    this.elements = doc.visible();
    /** @type {Map<string, number[]>} "cx,cy" -> indices into this.elements */
    this.cells = new Map();
    /** Indices of elements too large for the grid or dynamically routed (always visited). */
    this.always = [];

    for (let i = 0; i < this.elements.length; i++) {
      const box = indexBox(doc, this.elements[i]);
      if (!box || !Number.isFinite(box.x0) || !Number.isFinite(box.y0) || !Number.isFinite(box.x1) || !Number.isFinite(box.y1)) {
        this.always.push(i);
        continue;
      }
      const c0x = Math.floor(box.x0 / cellSize), c1x = Math.floor(box.x1 / cellSize);
      const c0y = Math.floor(box.y0 / cellSize), c1y = Math.floor(box.y1 / cellSize);
      const span = (c1x - c0x + 1) * (c1y - c0y + 1);
      if (span <= 0 || span > MAX_CELLS_PER_EL) {
        this.always.push(i);
        continue;
      }
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const k = `${cx},${cy}`;
          let list = this.cells.get(k);
          if (!list) { list = []; this.cells.set(k, list); }
          list.push(i);
        }
      }
    }
  }

  /**
   * Elements whose indexed bounds intersect `[x0, y0, x1, y1]`, in exact `doc.visible()` paint order.
   * Deduplicated across cells.
   */
  queryRect(x0, y0, x1, y1) {
    const cs = this.cellSize;
    const c0x = Math.floor(x0 / cs), c1x = Math.floor(x1 / cs);
    const c0y = Math.floor(y0 / cs), c1y = Math.floor(y1 / cs);
    // If the query itself spans a huge number of cells, a linear scan is cheaper than cell hashing.
    if ((c1x - c0x + 1) * (c1y - c0y + 1) > 1024) return this.elements;
    const seen = new Set();
    const indices = [];
    for (let i = 0; i < this.always.length; i++) {
      const idx = this.always[i];
      seen.add(idx);
      indices.push(idx);
    }
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const list = this.cells.get(`${cx},${cy}`);
        if (!list) continue;
        for (let j = 0; j < list.length; j++) {
          const idx = list[j];
          if (!seen.has(idx)) { seen.add(idx); indices.push(idx); }
        }
      }
    }
    indices.sort((a, b) => a - b);
    const out = new Array(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = this.elements[indices[i]];
    return out;
  }

  /** Elements near `(x, y)` within `pad` world units, in exact `doc.visible()` paint order. */
  queryPoint(x, y, pad = 0) {
    return this.queryRect(x - pad, y - pad, x + pad, y + pad);
  }
}

/** Lazily build or reuse the spatial index for `doc` at its current `doc.rev`. */
export function spatialIndex(doc, cellSize = DEFAULT_CELL_SIZE) {
  const entry = cache.get(doc);
  if (entry && entry.rev === doc.rev && entry.cellSize === cellSize) return entry.index;
  const index = new SpatialIndex(doc, cellSize);
  cache.set(doc, { rev: doc.rev, cellSize, index });
  return index;
}
