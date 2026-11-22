// @ts-check
// Pure Views, Frame Navigator & Local Layer Visibility model (#115).
//
// Architectural guardrail:
// - Named Presentation Views (`{ id, name, frameId, visibleLayers }`) are shared board state
//   stored in `doc.appState.herdr.views` (validated & bounded).
// - Solo Layer and active View layer filters are strictly VIEWER-LOCAL overrides: `resolveLocalLayers`
//   computes effective visibility without EVER mutating `boardLayers` or `appState.herdr.layers`.
//
// No DOM, no host globals: runs identically in browsers, servers, and headless tests.

import { layerOf, newId } from "./model.js";

export const MAX_VIEWS = 100;
export const MAX_VIEW_NAME = 200;
export const MAX_ID_LEN = 64;
export const MAX_VISIBLE_LAYERS = 100;

const CONTROL_BIDI_RE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

/**
 * @typedef {{ id: string, name: string, frameId: string | null, visibleLayers: string[] | null }} NamedView
 * @typedef {{ id: string, name: string, rawName: string, index: number, layerId: string, bounds: { x: number, y: number, w: number, h: number } }} NamedFrame
 * @typedef {{ id: string, name: string, visible: boolean, locked: boolean, opacity?: number }} BoardLayer
 * @typedef {{ soloLayerId?: string | null, activeViewId?: string | null, visibleLayers?: string[] | null }} LocalLayerOverride
 * @typedef {{
 *   active: boolean,
 *   mode: "board" | "solo" | "view",
 *   soloLayerId: string | null,
 *   activeViewId: string | null,
 *   activeViewName: string | null,
 *   layers: Array<BoardLayer & { effectiveVisible: boolean, solo: boolean }>,
 *   visibleIds: Set<string>,
 *   filter: ((layerId: string) => boolean) | null,
 * }} ResolvedLocalLayers
 */

/** Strip control/bidi characters, trim, and bound a display string. */
function cleanText(raw, maxLen = MAX_VIEW_NAME) {
  if (typeof raw !== "string") return "";
  return raw.replace(CONTROL_BIDI_RE, "").trim().slice(0, maxLen);
}

/**
 * Validate and normalize a raw Named View object.
 * Accepts `visibleLayers` or `visibleLayerIds` as input; always emits canonical `visibleLayers`.
 * @param {any} raw
 * @param {{ fallbackName?: string, generateId?: boolean }} [opts]
 * @returns {NamedView | null}
 */
export function normalizeView(raw, { fallbackName = "Untitled view", generateId = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let id = typeof raw.id === "string" ? raw.id.trim().slice(0, MAX_ID_LEN) : "";
  if (!id) {
    if (!generateId) return null;
    id = newId().slice(0, MAX_ID_LEN);
  }
  const name = cleanText(raw.name, MAX_VIEW_NAME) || cleanText(fallbackName, MAX_VIEW_NAME) || "Untitled view";
  const rawFrameId = typeof raw.frameId === "string" ? raw.frameId.trim().slice(0, MAX_ID_LEN) : "";
  const frameId = rawFrameId || null;

  const rawLayers = raw.visibleLayers !== undefined ? raw.visibleLayers : raw.visibleLayerIds;
  /** @type {string[] | null} */
  let visibleLayers = null;
  if (Array.isArray(rawLayers)) {
    const seen = new Set();
    const out = [];
    for (const item of rawLayers) {
      if (typeof item !== "string") continue;
      const lid = item.trim().slice(0, MAX_ID_LEN);
      if (!lid || seen.has(lid)) continue;
      seen.add(lid);
      out.push(lid);
      if (out.length >= MAX_VISIBLE_LAYERS) break;
    }
    visibleLayers = out;
  }

  return { id, name, frameId, visibleLayers };
}

/**
 * Return all live frames in reading order (rows top-to-bottom within 40px, left-to-right within a row)
 * with friendly names, 0-based index, layer id, and world bounds.
 * Reads `doc.live()` so frames on locally hidden layers remain discoverable in the Quick Navigator.
 * @param {import("./doc.js").Doc | { live?: () => any[] } | null | undefined} doc
 * @returns {NamedFrame[]}
 */
export function listNamedFrames(doc) {
  const live = typeof doc?.live === "function" ? doc.live() : [];
  const frames = live
    .filter(e => e && !e.isDeleted && e.type === "frame")
    .sort((a, b) => (Math.abs((a.y ?? 0) - (b.y ?? 0)) < 40 ? (a.x ?? 0) - (b.x ?? 0) : (a.y ?? 0) - (b.y ?? 0)));
  return frames.map((f, index) => {
    const rawName = cleanText(f.name, MAX_VIEW_NAME);
    return {
      id: f.id,
      name: rawName || "Untitled frame",
      rawName,
      index,
      layerId: layerOf(f),
      bounds: {
        x: Number.isFinite(f.x) ? f.x : 0,
        y: Number.isFinite(f.y) ? f.y : 0,
        w: Number.isFinite(f.width) ? f.width : 0,
        h: Number.isFinite(f.height) ? f.height : 0,
      },
    };
  });
}

/**
 * Return validated, bounded Named Presentation Views from `doc.appState.herdr.views`.
 * Never mutates `doc`.
 * @param {any} docOrAppState
 * @returns {NamedView[]}
 */
export function viewsOf(docOrAppState) {
  const raw = docOrAppState?.appState?.herdr?.views ?? docOrAppState?.herdr?.views;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  /** @type {NamedView[]} */
  const out = [];
  for (const item of raw) {
    const v = normalizeView(item);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

/**
 * Return the next views array with `view` added (or updated in place if `view.id` already exists).
 * Pure: never mutates `doc`. Enforces `MAX_VIEWS`.
 * @param {any} doc
 * @param {Partial<NamedView> & { visibleLayerIds?: string[] | null }} view
 * @returns {NamedView[]}
 */
export function addView(doc, view) {
  const current = viewsOf(doc);
  const fallbackName = `View ${current.length + 1}`;
  const normalized = normalizeView(view ?? {}, { fallbackName, generateId: true });
  if (!normalized) return current;
  const existingIdx = current.findIndex(v => v.id === normalized.id);
  if (existingIdx >= 0) {
    return current.map((v, i) => (i === existingIdx ? normalized : v));
  }
  if (current.length >= MAX_VIEWS) {
    return current;
  }
  return [...current, normalized];
}

/**
 * Return the next views array with `id` removed. Pure: never mutates `doc`.
 * @param {any} doc
 * @param {string} id
 * @returns {NamedView[]}
 */
export function deleteView(doc, id) {
  const current = viewsOf(doc);
  return current.filter(v => v.id !== id);
}

/**
 * Return the next views array reordered according to `ids`.
 * Unknown ids are ignored; any existing views omitted from `ids` are preserved in their relative order at the end.
 * Pure: never mutates `doc`.
 * @param {any} doc
 * @param {string[]} ids
 * @returns {NamedView[]}
 */
export function reorderViews(doc, ids) {
  const current = viewsOf(doc);
  if (!Array.isArray(ids) || !ids.length) return current;
  const byId = new Map(current.map(v => [v.id, v]));
  /** @type {NamedView[]} */
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const found = byId.get(id);
    if (found) {
      seen.add(id);
      out.push(found);
    }
  }
  for (const v of current) {
    if (!seen.has(v.id)) out.push(v);
  }
  return out;
}

/**
 * Fast case-insensitive name search across named frames and saved Views.
 * Prefix matches rank ahead of inner-substring matches, preserving relative order on ties.
 * @param {string} query
 * @param {{ frames?: NamedFrame[], views?: NamedView[] }} items
 * @returns {{ frames: NamedFrame[], views: NamedView[] }}
 */
export function filterFramesAndViews(query, { frames = [], views = [] } = {}) {
  const q = cleanText(query, MAX_VIEW_NAME).toLowerCase().replace(/\s+/g, " ");
  if (!q) return { frames: [...frames], views: [...views] };

  /** @template {{ name?: string }} T @param {T[]} list @returns {T[]} */
  const matchAndRank = list => {
    /** @type {T[]} */
    const prefix = [];
    /** @type {T[]} */
    const contains = [];
    for (const item of list) {
      const hay = String(item?.name ?? "").toLowerCase();
      if (hay.startsWith(q)) prefix.push(item);
      else if (hay.includes(q)) contains.push(item);
    }
    return [...prefix, ...contains];
  };

  return {
    frames: matchAndRank(frames),
    views: matchAndRank(views),
  };
}

/**
 * Compute effective viewer-local layer visibility without EVER mutating `boardLayers`.
 *
 * Precedence:
 * 1. `localOverride.soloLayerId` (if that layer exists in `boardLayers`) → only that layer is visible.
 * 2. `localOverride.activeViewId` (matched in `views`) or explicit `localOverride.visibleLayers` array →
 *    if `visibleLayers` is an array, only layers in that set are visible; if `null`, board defaults apply.
 * 3. Default → shared board layer visibility (`filter: null`).
 *
 * @param {BoardLayer[]} boardLayers
 * @param {LocalLayerOverride | null | undefined} localOverride
 * @param {NamedView[]} [views]
 * @returns {ResolvedLocalLayers}
 */
export function resolveLocalLayers(boardLayers, localOverride, views = []) {
  const list = Array.isArray(boardLayers) ? boardLayers : [];
  const layerIds = new Set(list.map(l => l.id));

  // 1. Solo layer mode
  const soloId = typeof localOverride?.soloLayerId === "string" && layerIds.has(localOverride.soloLayerId)
    ? localOverride.soloLayerId
    : null;
  if (soloId) {
    const visibleIds = new Set([soloId]);
    return {
      active: true,
      mode: "solo",
      soloLayerId: soloId,
      activeViewId: null,
      activeViewName: null,
      layers: list.map(l => ({ ...l, effectiveVisible: l.id === soloId, solo: l.id === soloId })),
      visibleIds,
      filter: id => visibleIds.has(id),
    };
  }

  // 2. Named View mode (or explicit local visibleLayers array)
  const activeView = typeof localOverride?.activeViewId === "string"
    ? (Array.isArray(views) ? views.find(v => v.id === localOverride.activeViewId) ?? null : null)
    : null;

  const overrideList = activeView
    ? activeView.visibleLayers
    : (Array.isArray(localOverride?.visibleLayers) ? localOverride.visibleLayers : null);

  if (Array.isArray(overrideList)) {
    const visibleIds = new Set(overrideList.filter(id => layerIds.has(id)));
    return {
      active: true,
      mode: "view",
      soloLayerId: null,
      activeViewId: activeView?.id ?? null,
      activeViewName: activeView?.name ?? null,
      layers: list.map(l => ({ ...l, effectiveVisible: visibleIds.has(l.id), solo: false })),
      visibleIds,
      filter: id => visibleIds.has(id),
    };
  }

  // 3. Default board layer visibility (also applies when a Named View has visibleLayers: null)
  const visibleIds = new Set(list.filter(l => Boolean(l.visible)).map(l => l.id));
  return {
    active: false,
    mode: activeView ? "view" : "board",
    soloLayerId: null,
    activeViewId: activeView?.id ?? null,
    activeViewName: activeView?.name ?? null,
    layers: list.map(l => ({ ...l, effectiveVisible: Boolean(l.visible), solo: false })),
    visibleIds,
    filter: null,
  };
}

/**
 * Capture the viewer's current effective visible layers and target frame into a ready-to-save Named View.
 * Pure: never mutates `doc`.
 * @param {any} doc
 * @param {LocalLayerOverride | null | undefined} localOverride
 * @param {{ name?: string, frameId?: string | null }} [opts]
 * @returns {NamedView}
 */
export function captureCurrentView(doc, localOverride, { name = "", frameId = null } = {}) {
  const existing = viewsOf(doc);
  const resolved = resolveLocalLayers(doc?.layers ?? [], localOverride, existing);
  const frames = listNamedFrames(doc);
  const validFrame = frameId ? frames.find(f => f.id === frameId) ?? null : null;
  const fallbackName = validFrame?.rawName || `View ${existing.length + 1}`;
  const visibleLayers = resolved.layers.filter(l => l.effectiveVisible).map(l => l.id);
  return /** @type {NamedView} */ (normalizeView(
    { name, frameId: validFrame?.id ?? null, visibleLayers },
    { fallbackName, generateId: true },
  ));
}

/**
 * Return the next or previous view when stepping through saved Views, wrapping cleanly.
 * @param {NamedView[]} views
 * @param {string | null | undefined} activeViewId
 * @param {number} delta
 * @returns {NamedView | null}
 */
export function stepViewIndex(views, activeViewId, delta = 1) {
  if (!Array.isArray(views) || !views.length) return null;
  const idx = activeViewId ? views.findIndex(v => v.id === activeViewId) : -1;
  const step = delta >= 0 ? 1 : -1;
  const next = idx < 0
    ? (step > 0 ? 0 : views.length - 1)
    : (idx + step + views.length) % views.length;
  return views[next] ?? null;
}
