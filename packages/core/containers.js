// @ts-check
// Pure containers & swimlanes engine: frame membership, auto-parent hit testing,
// fit-to-children bounds calculation, and Protocol v1.1-valid swimlane builders.
//
// No imports from Herdr, the DOM, or Node: this module runs everywhere.

import { BASE_LAYER, isLabel, isLinear, makeElement, newId } from "./model.js";
import { angleOf, bbox, bounds, center, centerOf, corners, inBox, rotate, toLocal, unionBox } from "./geometry.js";

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} RectBounds
 * @typedef {string | { name?: string, backgroundColor?: string, strokeColor?: string }} SwimlaneLaneInput
 * @typedef {{
 *   title?: string,
 *   lanes?: SwimlaneLaneInput[],
 *   orientation?: "horizontal" | "vertical",
 *   x?: number,
 *   y?: number,
 *   width?: number,
 *   height?: number,
 *   laneHeight?: number,
 *   laneWidth?: number,
 *   gap?: number,
 *   layer?: string,
 *   z?: number,
 *   grouped?: boolean,
 * }} SwimlaneOptions
 */

const DEFAULT_LANES = ["Lane 1", "Lane 2", "Lane 3"];
const DEFAULT_HORIZONTAL_WIDTH = 720;
const DEFAULT_HORIZONTAL_LANE_HEIGHT = 200;
const DEFAULT_VERTICAL_LANE_WIDTH = 240;
const DEFAULT_VERTICAL_LANE_HEIGHT = 480;

/**
 * Return true if `el` is a container (`frame`, including swimlane frames).
 * @param {any} el
 * @returns {boolean}
 */
export function isContainer(el) {
  return !!el && el.type === "frame";
}

/**
 * Return all live non-deleted elements whose `frameId === containerId`,
 * plus any live bound labels of those children (deduplicated, in paint order).
 * @param {any} doc
 * @param {string | null | undefined} containerId
 * @returns {any[]}
 */
export function childrenOfContainer(doc, containerId) {
  if (!doc || !containerId || typeof doc.live !== "function") return [];
  const live = doc.live();
  /** @type {Set<string>} */
  const childIds = new Set();
  for (const el of live) {
    if (!el || el.isDeleted || el.id === containerId) continue;
    if (el.frameId === containerId) childIds.add(el.id);
  }
  if (!childIds.size) return [];

  /** @type {any[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const el of live) {
    if (!el || el.isDeleted || seen.has(el.id)) continue;
    if (childIds.has(el.id) || (isLabel(el) && el.containerId && childIds.has(el.containerId))) {
      seen.add(el.id);
      out.push(el);
    }
  }
  return out;
}

/**
 * Return the topmost visible, unlocked live container whose bounds enclose `el`'s center.
 * Respects layer visibility, and never matches `el` itself or locked containers.
 * @param {any} doc
 * @param {any} el
 * @returns {any | null}
 */
export function findContainingFrame(doc, el) {
  if (!doc || !el || el.isDeleted || typeof doc.visible !== "function") return null;
  const b = bounds(el, doc) ?? bbox(el);
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) {
    return null;
  }
  const c = center(b);
  const visible = doc.visible();
  const canCheckEditable = typeof doc.editable === "function";

  for (let i = visible.length - 1; i >= 0; i--) {
    const candidate = visible[i];
    if (!isContainer(candidate) || candidate.isDeleted) continue;
    if (candidate.id === el.id) continue;
    if (candidate.locked) continue;
    if (canCheckEditable && !doc.editable(candidate)) continue;
    const fb = bbox(candidate);
    if (!fb || !(fb.w > 0 && fb.h > 0)) continue;
    if (inBox(toLocal(candidate, c), fb)) return candidate;
  }
  return null;
}

/**
 * Compute minimum `{ x, y, width, height }` so a container cleanly wraps all its children
 * with outer padding `pad` and top header space `header`.
 * Returns the container's normalized bounds if `children` has no valid non-label elements,
 * or `null` if neither children nor a container are provided.
 * @param {any} container
 * @param {any[]} children
 * @param {{ pad?: number, header?: number, doc?: any }} [opts]
 * @returns {RectBounds | null}
 */
export function expandContainerBounds(container, children, { pad = 24, header = 32, doc = null } = {}) {
  const p = Number.isFinite(pad) ? Math.max(0, pad) : 24;
  const h = Number.isFinite(header) ? Math.max(0, header) : 32;
  /** @type {any[]} */
  const validChildren = [];

  if (Array.isArray(children)) {
    for (const child of children) {
      if (!child || child.isDeleted || isLabel(child)) continue;
      if (container && child.id === container.id) continue;
      const b = bounds(child, doc) ?? bbox(child);
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.w) || !Number.isFinite(b.h)) {
        continue;
      }
      validChildren.push({ el: child, box: b });
    }
  }

  if (!validChildren.length) {
    if (!container) return null;
    const cb = bbox(container);
    return { x: cb.x, y: cb.y, width: cb.w, height: cb.h };
  }

  const angle = container ? angleOf(container) : 0;
  if (angle) {
    const origin = centerOf(container);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { el, box } of validChildren) {
      const pts = !isLinear(el) && angleOf(el)
        ? corners(el)
        : [
            { x: box.x, y: box.y },
            { x: box.x + box.w, y: box.y },
            { x: box.x + box.w, y: box.y + box.h },
            { x: box.x, y: box.y + box.h },
          ];
      for (const pt of pts) {
        const lp = rotate(pt, origin, -angle);
        if (lp.x < minX) minX = lp.x;
        if (lp.x > maxX) maxX = lp.x;
        if (lp.y < minY) minY = lp.y;
        if (lp.y > maxY) maxY = lp.y;
      }
    }
    const lx0 = minX - p;
    const lx1 = maxX + p;
    const ly0 = minY - p - h;
    const ly1 = maxY + p;
    const width = Math.max(1, lx1 - lx0);
    const height = Math.max(1, ly1 - ly0);
    const wc = rotate({ x: (lx0 + lx1) / 2, y: (ly0 + ly1) / 2 }, origin, angle);
    return {
      x: wc.x - width / 2,
      y: wc.y - height / 2,
      width,
      height,
    };
  }

  const u = unionBox(validChildren.map(v => v.box));
  if (!u) return null;

  return {
    x: u.x - p,
    y: u.y - p - h,
    width: Math.max(1, u.w + p * 2),
    height: Math.max(1, u.h + p * 2 + h),
  };
}

/**
 * Build a clean horizontal or vertical multi-lane swimlane group of labeled frames.
 * Every returned element is a 100% Protocol v1.1-valid `frame` element with
 * swimlane metadata in `customData.swimlane`.
 * @param {SwimlaneOptions} [opts]
 * @returns {any[]}
 */
export function buildSwimlane({
  title = "",
  lanes = DEFAULT_LANES,
  orientation = "horizontal",
  x = 0,
  y = 0,
  width,
  height,
  laneHeight,
  laneWidth,
  gap = 0,
  layer = BASE_LAYER,
  z = 0,
  grouped = true,
} = {}) {
  const rawLanes = Array.isArray(lanes) && lanes.length > 0 ? lanes : DEFAULT_LANES;
  const count = rawLanes.length;
  const orient = orientation === "vertical" ? "vertical" : "horizontal";
  const baseX = Number.isFinite(x) ? x : 0;
  const baseY = Number.isFinite(y) ? y : 0;
  const laneGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const targetLayer = typeof layer === "string" && layer.length > 0 ? layer : BASE_LAYER;
  const baseZ = Number.isFinite(z) ? z : 0;
  const cleanTitle = typeof title === "string" ? title.trim() : "";

  const swimlaneId = newId();
  const groupIds = grouped !== false ? [newId()] : [];

  const horizW = Number.isFinite(width) && width > 0 ? width : DEFAULT_HORIZONTAL_WIDTH;
  const horizH = Number.isFinite(laneHeight) && laneHeight > 0 ? laneHeight : DEFAULT_HORIZONTAL_LANE_HEIGHT;

  const vertW = Number.isFinite(laneWidth) && laneWidth > 0
    ? laneWidth
    : (Number.isFinite(width) && width > 0 ? Math.max(120, (width - laneGap * (count - 1)) / count) : DEFAULT_VERTICAL_LANE_WIDTH);
  const vertH = Number.isFinite(height) && height > 0
    ? height
    : (Number.isFinite(laneHeight) && laneHeight > 0 ? laneHeight : DEFAULT_VERTICAL_LANE_HEIGHT);

  return rawLanes.map((entry, i) => {
    const spec = typeof entry === "string" ? { name: entry } : (entry && typeof entry === "object" ? entry : {});
    const laneLabel = typeof spec.name === "string" && spec.name.trim() ? spec.name.trim() : `Lane ${i + 1}`;
    const frameName = cleanTitle ? `${cleanTitle} — ${laneLabel}` : laneLabel;
    const fx = orient === "horizontal" ? baseX : baseX + i * (vertW + laneGap);
    const fy = orient === "horizontal" ? baseY + i * (horizH + laneGap) : baseY;
    const fw = orient === "horizontal" ? horizW : vertW;
    const fh = orient === "horizontal" ? horizH : vertH;

    return makeElement("frame", {
      x: fx,
      y: fy,
      width: fw,
      height: fh,
      name: frameName,
      groupIds: [...groupIds],
      ...(typeof spec.backgroundColor === "string" ? { backgroundColor: spec.backgroundColor } : {}),
      ...(typeof spec.strokeColor === "string" ? { strokeColor: spec.strokeColor } : {}),
      customData: {
        layer: targetLayer,
        z: baseZ + i,
        swimlane: {
          id: swimlaneId,
          title: cleanTitle || null,
          orientation: orient,
          index: i,
          count,
          lane: laneLabel,
        },
      },
    });
  });
}
