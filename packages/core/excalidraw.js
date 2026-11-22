// Excalidraw v2 interoperability: pure import, export, clipboard round-trip, and ID remapping.
//
// Strictly pure: no DOM, browser, or Node globals. Runs in browsers, servers, and QuickJS.
// Supports:
//   - Standard .excalidraw v2 files: { type: "excalidraw", version: 2, source, elements, appState, files }
//   - Excalidraw clipboard payloads: { type: "excalidraw/clipboard", elements, files }
//
// Guarantees:
//   - Prototype-pollution safe (never copies __proto__, constructor, or prototype).
//   - Numeric & geometric sanitization (finite coords, non-negative dims, normalized linear points).
//   - Bidirectional boundElements <-> containerId / startBinding / endBinding invariants.
//   - Protocol v1.1 version safety (resets version to 0 with fresh versionNonce so MAX_VERSION_JUMP is never tripped).

import {
  DEFAULT_STROKE, BASE_LAYER, makeElement, clone, newId, randomInt,
  clampPressure, textSize, isLinear,
} from "./model.js";
import { Doc } from "./doc.js";
import { normalize, normAngle, fileScene } from "./geometry.js";

export const EXCALIDRAW_SOURCE = "https://plenary.app";
export const EXCALIDRAW_TYPES = new Set([
  "rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "frame", "image",
]);
const CLIPBOARD_TYPES = new Set([...EXCALIDRAW_TYPES, "video"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const FILL_STYLES = new Set(["solid", "hachure", "cross-hatch", "zigzag"]);
const STROKE_STYLES = new Set(["solid", "dashed", "dotted"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const VERTICAL_ALIGNS = new Set(["top", "middle", "bottom"]);
const ARROWHEADS = new Set([
  "arrow", "bar", "dot", "triangle", "triangle_outline",
  "circle", "circle_outline", "diamond", "diamond_outline",
  "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many",
]);
const IMAGE_STATUSES = new Set(["saved", "pending", "error"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SHA1_RE = /^[0-9a-f]{40}$/;

const MAX_COORD = 1e7;
const MAX_DIM = 1e6;
const MAX_ID_LEN = 64;
const MAX_GROUP_IDS = 32;
const MAX_POINTS = 50_000;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const own = (o, k) => o != null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const isPlainObj = v => v != null && typeof v === "object" && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finiteNum = (v, def = 0, lo = -MAX_COORD, hi = MAX_COORD) =>
  (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : def);
const finiteInt = (v, def, lo = 0, hi = 2 ** 31 - 1) =>
  (typeof v === "number" && Number.isFinite(v) ? clamp(Math.trunc(v), lo, hi) : def);

function safeId(v, fallback = null) {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  if (!s || s.length > MAX_ID_LEN || FORBIDDEN_KEYS.has(s)) return fallback;
  return s;
}

function safeColor(v, def) {
  if (typeof v !== "string") return def;
  const s = v.trim();
  if (!s || s.length > 64 || /[\x00-\x1f\x7f]/.test(s)) return def;
  return s;
}

function safeRoundness(v) {
  if (!isPlainObj(v)) return null;
  const type = finiteInt(v.type, 0, 1, 3);
  if (!type) return null;
  const out = { type };
  if (own(v, "value") && typeof v.value === "number" && Number.isFinite(v.value) && v.value >= 0) {
    out.value = clamp(v.value, 0, MAX_DIM);
  }
  return out;
}

function safeBinding(v) {
  if (!isPlainObj(v)) return null;
  const elementId = safeId(v.elementId);
  if (!elementId) return null;
  const out = {
    elementId,
    focus: finiteNum(v.focus, 0, -100, 100),
    gap: finiteNum(v.gap, 6, 0, 1000),
  };
  if (Array.isArray(v.fixedPoint) && v.fixedPoint.length === 2 &&
      typeof v.fixedPoint[0] === "number" && Number.isFinite(v.fixedPoint[0]) &&
      typeof v.fixedPoint[1] === "number" && Number.isFinite(v.fixedPoint[1])) {
    out.fixedPoint = [clamp(v.fixedPoint[0], -100, 100), clamp(v.fixedPoint[1], -100, 100)];
  }
  if (typeof v.side === "string" && ["top", "right", "bottom", "left"].includes(v.side)) {
    out.side = v.side;
  }
  return out;
}

function exportBinding(v) {
  if (!isPlainObj(v)) return null;
  const elementId = safeId(v.elementId);
  if (!elementId) return null;
  const out = {
    elementId,
    focus: finiteNum(v.focus, 0, -100, 100),
    gap: finiteNum(v.gap, 6, 0, 1000),
    fixedPoint: Array.isArray(v.fixedPoint) && v.fixedPoint.length === 2 &&
      Number.isFinite(v.fixedPoint[0]) && Number.isFinite(v.fixedPoint[1])
      ? [v.fixedPoint[0], v.fixedPoint[1]]
      : null,
  };
  if (typeof v.side === "string" && ["top", "right", "bottom", "left"].includes(v.side)) {
    out.side = v.side;
  }
  return out;
}

function safePoints(raw, minLen = 1) {
  if (!Array.isArray(raw) || !raw.length) return minLen === 2 ? [[0, 0], [0, 0]] : [[0, 0]];
  const out = [];
  const cap = Math.min(raw.length, MAX_POINTS);
  for (let i = 0; i < cap; i++) {
    const p = raw[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    if (typeof p[0] !== "number" || !Number.isFinite(p[0]) || typeof p[1] !== "number" || !Number.isFinite(p[1])) continue;
    out.push([clamp(p[0], -MAX_COORD, MAX_COORD), clamp(p[1], -MAX_COORD, MAX_COORD)]);
  }
  if (!out.length) return minLen === 2 ? [[0, 0], [0, 0]] : [[0, 0]];
  if (minLen === 2 && out.length === 1) out.push([out[0][0], out[0][1]]);
  return out;
}

function safeCrop(v) {
  if (!isPlainObj(v)) return null;
  const x = finiteNum(v.x, 0, 0, MAX_DIM);
  const y = finiteNum(v.y, 0, 0, MAX_DIM);
  const width = finiteNum(v.width, 0, 0, MAX_DIM);
  const height = finiteNum(v.height, 0, 0, MAX_DIM);
  const naturalWidth = finiteNum(v.naturalWidth, 0, 0, MAX_DIM);
  const naturalHeight = finiteNum(v.naturalHeight, 0, 0, MAX_DIM);
  if (!width || !height || !naturalWidth || !naturalHeight) return null;
  return { x, y, width, height, naturalWidth, naturalHeight };
}

function sanitizeJsonValue(v, depth = 0) {
  if (depth > 8 || v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (Array.isArray(v)) {
    const arr = [];
    for (let i = 0; i < Math.min(v.length, 256); i++) {
      const sv = sanitizeJsonValue(v[i], depth + 1);
      if (sv !== undefined) arr.push(sv);
    }
    return arr;
  }
  if (isPlainObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const sv = sanitizeJsonValue(v[k], depth + 1);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return undefined;
}

function safeCustomData(raw) {
  const clean = isPlainObj(raw) ? sanitizeJsonValue(raw, 0) : {};
  const out = isPlainObj(clean) ? clean : {};
  if (typeof out.layer !== "string" || !out.layer || out.layer.length > MAX_ID_LEN) out.layer = BASE_LAYER;
  if (typeof out.z !== "number" || !Number.isFinite(out.z)) out.z = 0;
  return out;
}

/** Lexicographically ordered Excalidraw-style fractional index string for non-negative integer `i`. */
export function fractionalIndex(i) {
  const n = Math.max(0, Math.trunc(i));
  if (n < 62) return "a" + BASE62[n];
  let rem = n - 62, width = 2, span = 62 * 62;
  while (rem >= span && width < 6) { rem -= span; width++; span *= 62; }
  let s = "";
  for (let k = 0; k < width; k++) { s = BASE62[rem % 62] + s; rem = Math.floor(rem / 62); }
  return String.fromCharCode(97 + width - 1) + s;
}

/**
 * Reconciles bidirectional `boundElements` across an element array in place (on clones).
 * Ensures every bound text (`containerId`) and bound arrow/line (`startBinding`/`endBinding`)
 * is listed in its container's `boundElements`, and removes dangling references.
 */
export function reconcileBoundElements(elements) {
  const byId = new Map();
  for (const el of elements) {
    if (el && !el.isDeleted && typeof el.id === "string") byId.set(el.id, el);
  }
  const boundMap = new Map(); // containerId -> Map<childId, type>
  const addRef = (containerId, childId, type) => {
    if (!containerId || !childId || containerId === childId) return;
    if (!byId.has(containerId) || !byId.has(childId)) return;
    let m = boundMap.get(containerId);
    if (!m) { m = new Map(); boundMap.set(containerId, m); }
    if (!m.has(childId)) m.set(childId, type);
  };

  // Preserve valid existing boundElements order first.
  for (const el of elements) {
    if (!el || el.isDeleted || !Array.isArray(el.boundElements)) continue;
    for (const b of el.boundElements) {
      if (!isPlainObj(b)) continue;
      const target = byId.get(b.id);
      if (!target) continue;
      const t = b.type === "text" || target.type === "text"
        ? "text"
        : (target.type === "arrow" || target.type === "line" ? target.type : null);
      if (t) addRef(el.id, target.id, t);
    }
  }

  // Add missing inverse references from text.containerId and arrow/line bindings.
  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    if (el.type === "text" && el.containerId) {
      if (byId.has(el.containerId)) addRef(el.containerId, el.id, "text");
      else el.containerId = null;
    }
    if (el.type === "arrow" || el.type === "line") {
      if (el.startBinding?.elementId) {
        if (byId.has(el.startBinding.elementId)) addRef(el.startBinding.elementId, el.id, el.type);
        else el.startBinding = null;
      }
      if (el.endBinding?.elementId) {
        if (byId.has(el.endBinding.elementId)) addRef(el.endBinding.elementId, el.id, el.type);
        else el.endBinding = null;
      }
    }
  }

  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    const m = boundMap.get(el.id);
    el.boundElements = m && m.size ? [...m.entries()].map(([id, type]) => ({ id, type })) : null;
  }
  return elements;
}

/** True if `input` (JSON string or object) looks like an Excalidraw file or clipboard payload. */
export function isExcalidrawPayload(input) {
  let data = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{")) return false;
    try { data = JSON.parse(trimmed); } catch { return false; }
  }
  if (!isPlainObj(data)) return false;
  return (data.type === "excalidraw" || data.type === "excalidraw/clipboard") && Array.isArray(data.elements);
}

function sanitizeElement(raw, { allowVideo = false, now = Date.now() } = {}) {
  if (!isPlainObj(raw)) return null;
  if (raw.isDeleted === true) return null;
  const type = typeof raw.type === "string" ? raw.type : "";
  const allowed = allowVideo ? CLIPBOARD_TYPES : EXCALIDRAW_TYPES;
  if (!allowed.has(type)) return null;

  const id = safeId(raw.id) ?? newId();
  let x = finiteNum(raw.x, 0);
  let y = finiteNum(raw.y, 0);
  let width = finiteNum(raw.width, 0, -MAX_DIM, MAX_DIM);
  let height = finiteNum(raw.height, 0, -MAX_DIM, MAX_DIM);
  if (!isLinear({ type })) {
    if (width < 0) { x += width; width = -width; }
    if (height < 0) { y += height; height = -height; }
  }
  width = clamp(Math.abs(width), 0, MAX_DIM);
  height = clamp(Math.abs(height), 0, MAX_DIM);

  const groupIds = Array.isArray(raw.groupIds)
    ? raw.groupIds.map(g => safeId(g)).filter(Boolean).slice(0, MAX_GROUP_IDS)
    : [];
  const frameId = safeId(raw.frameId);
  const link = typeof raw.link === "string" && raw.link.length > 0 && raw.link.length <= 2048 ? raw.link : null;
  const boundElements = Array.isArray(raw.boundElements)
    ? raw.boundElements
      .filter(b => isPlainObj(b) && safeId(b.id) && (b.type === "text" || b.type === "arrow" || b.type === "line"))
      .map(b => ({ id: safeId(b.id), type: b.type }))
    : null;

  const fields = {
    id,
    x,
    y,
    width,
    height,
    angle: normAngle(finiteNum(raw.angle, 0, -1e6, 1e6)),
    strokeColor: safeColor(raw.strokeColor, type === "image" || type === "video" ? "transparent" : DEFAULT_STROKE),
    backgroundColor: safeColor(raw.backgroundColor, "transparent"),
    fillStyle: FILL_STYLES.has(raw.fillStyle) ? raw.fillStyle : "solid",
    strokeWidth: finiteNum(raw.strokeWidth, type === "frame" ? 1 : 2, 0.1, 64),
    strokeStyle: STROKE_STYLES.has(raw.strokeStyle) ? raw.strokeStyle : "solid",
    roughness: finiteNum(raw.roughness, type === "image" || type === "video" ? 0 : 1, 0, 3),
    opacity: finiteNum(raw.opacity, 100, 0, 100),
    groupIds,
    frameId,
    roundness: safeRoundness(raw.roundness),
    seed: finiteInt(raw.seed, randomInt(), 0, 2 ** 31 - 1),
    // Protocol v1.1 safety: always reset version so MAX_VERSION_JUMP is never exceeded on commit.
    version: 0,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: boundElements?.length ? boundElements : null,
    updated: finiteInt(raw.updated, now, 0, Number.MAX_SAFE_INTEGER),
    link,
    locked: raw.locked === true,
    customData: safeCustomData(raw.customData),
  };

  if (type === "arrow" || type === "line") {
    fields.points = safePoints(raw.points, 2);
    fields.lastCommittedPoint = Array.isArray(raw.lastCommittedPoint) && raw.lastCommittedPoint.length === 2 &&
      Number.isFinite(raw.lastCommittedPoint[0]) && Number.isFinite(raw.lastCommittedPoint[1])
      ? [clamp(raw.lastCommittedPoint[0], -MAX_COORD, MAX_COORD), clamp(raw.lastCommittedPoint[1], -MAX_COORD, MAX_COORD)]
      : null;
    fields.startBinding = safeBinding(raw.startBinding);
    fields.endBinding = safeBinding(raw.endBinding);
    fields.startArrowhead = ARROWHEADS.has(raw.startArrowhead) ? raw.startArrowhead : null;
    fields.endArrowhead = raw.endArrowhead === null
      ? null
      : (ARROWHEADS.has(raw.endArrowhead) ? raw.endArrowhead : (type === "arrow" ? "arrow" : null));
    if (raw.elbowed === true) fields.elbowed = true;
  } else if (type === "freedraw") {
    fields.points = safePoints(raw.points, 1);
    fields.pressures = Array.isArray(raw.pressures)
      ? raw.pressures.slice(0, fields.points.length).map(clampPressure)
      : [];
    fields.simulatePressure = typeof raw.simulatePressure === "boolean" ? raw.simulatePressure : fields.pressures.length === 0;
    fields.lastCommittedPoint = Array.isArray(raw.lastCommittedPoint) && raw.lastCommittedPoint.length === 2 &&
      Number.isFinite(raw.lastCommittedPoint[0]) && Number.isFinite(raw.lastCommittedPoint[1])
      ? [clamp(raw.lastCommittedPoint[0], -MAX_COORD, MAX_COORD), clamp(raw.lastCommittedPoint[1], -MAX_COORD, MAX_COORD)]
      : null;
  } else if (type === "text") {
    const text = typeof raw.text === "string" ? raw.text : "";
    const originalText = typeof raw.originalText === "string" ? raw.originalText : text;
    const containerId = safeId(raw.containerId);
    const fontSize = finiteNum(raw.fontSize, 20, 4, 512);
    const fontFamily = finiteInt(raw.fontFamily, 1, 1, 8);
    const lineHeight = finiteNum(raw.lineHeight, 1.25, 0.5, 4);
    fields.text = text;
    fields.originalText = originalText;
    fields.fontSize = fontSize;
    fields.fontFamily = fontFamily;
    fields.textAlign = TEXT_ALIGNS.has(raw.textAlign) ? raw.textAlign : (containerId ? "center" : "left");
    fields.verticalAlign = VERTICAL_ALIGNS.has(raw.verticalAlign) ? raw.verticalAlign : (containerId ? "middle" : "top");
    fields.containerId = containerId;
    fields.lineHeight = lineHeight;
    fields.autoResize = typeof raw.autoResize === "boolean" ? raw.autoResize : true;
    if (!containerId && (!fields.width || !fields.height)) {
      const sz = textSize(text, fontSize, lineHeight, fontFamily);
      if (!fields.width) fields.width = sz.w;
      if (!fields.height) fields.height = sz.h;
    }
  } else if (type === "frame") {
    fields.name = typeof raw.name === "string" && raw.name.length ? raw.name.slice(0, 200) : null;
  } else if (type === "image") {
    fields.fileId = safeId(raw.fileId);
    fields.status = IMAGE_STATUSES.has(raw.status) ? raw.status : "saved";
    fields.scale = Array.isArray(raw.scale) && raw.scale.length === 2
      ? [raw.scale[0] === -1 ? -1 : 1, raw.scale[1] === -1 ? -1 : 1]
      : [1, 1];
    fields.crop = safeCrop(raw.crop);
  } else if (type === "video") {
    fields.fileId = safeId(raw.fileId);
    fields.mimeType = VIDEO_MIMES.has(raw.mimeType) ? raw.mimeType : "video/mp4";
    fields.status = IMAGE_STATUSES.has(raw.status) ? raw.status : "saved";
    fields.scale = Array.isArray(raw.scale) && raw.scale.length === 2
      ? [raw.scale[0] === -1 ? -1 : 1, raw.scale[1] === -1 ? -1 : 1]
      : [1, 1];
    fields.posterDataUrl = typeof raw.posterDataUrl === "string" && IMAGE_DATA_URL_RE.test(raw.posterDataUrl) && raw.posterDataUrl.length <= 65536
      ? raw.posterDataUrl
      : null;
    fields.loop = raw.loop === true;
    fields.muted = raw.muted !== false;
    fields.autoplay = raw.autoplay === true;
  }

  const el = makeElement(type, fields);
  return normalize(el);
}

function sanitizeFiles(rawFiles, elements, { allowVideo = false, now = Date.now() } = {}) {
  const out = {};
  if (!isPlainObj(rawFiles)) return out;
  const usedImageIds = new Set();
  const usedVideoIds = new Set();
  for (const el of elements) {
    if (el.type === "image" && el.fileId) usedImageIds.add(el.fileId);
    else if (allowVideo && el.type === "video" && el.fileId) usedVideoIds.add(el.fileId);
  }
  for (const k of Object.keys(rawFiles)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const f = rawFiles[k];
    if (!isPlainObj(f)) continue;
    const id = safeId(k) ?? safeId(f.id);
    if (!id) continue;
    if (usedVideoIds.has(id) && !usedImageIds.has(id)) {
      out[id] = { id, mimeType: VIDEO_MIMES.has(f.mimeType) ? f.mimeType : "video/mp4" };
      continue;
    }
    if (typeof f.dataURL !== "string") continue;
    const m = IMAGE_DATA_URL_RE.exec(f.dataURL.trim());
    if (!m) continue;
    const mimeType = m[1];
    const cleanB64 = m[2].replace(/\s+/g, "");
    const dataURL = `data:${mimeType};base64,${cleanB64}`;
    const created = finiteInt(f.created, now, 0, Number.MAX_SAFE_INTEGER);
    const lastRetrieved = finiteInt(f.lastRetrieved, created, 0, Number.MAX_SAFE_INTEGER);
    out[id] = { id, mimeType, dataURL, created, lastRetrieved };
  }
  return out;
}

/**
 * Parses and sanitizes an Excalidraw v2 file (`type: "excalidraw"`) or clipboard payload
 * (`type: "excalidraw/clipboard"`). Never throws on malformed input.
 */
export function parseExcalidraw(input, { allowVideo, now = Date.now() } = {}) {
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); }
    catch { return { ok: false, error: "Invalid JSON", elements: [], files: {}, appState: {}, skipped: 0 }; }
  }
  if (!isPlainObj(data)) {
    return { ok: false, error: "Excalidraw payload must be an object", elements: [], files: {}, appState: {}, skipped: 0 };
  }
  if (data.type !== "excalidraw" && data.type !== "excalidraw/clipboard") {
    return { ok: false, error: `Unsupported payload type: ${String(data.type ?? "")}`, elements: [], files: {}, appState: {}, skipped: 0 };
  }
  if (!Array.isArray(data.elements)) {
    return { ok: false, error: "Missing elements array", elements: [], files: {}, appState: {}, skipped: 0 };
  }

  const videoOk = allowVideo ?? (data.type === "excalidraw/clipboard");
  const elements = [];
  const seenIds = new Set();
  let skipped = 0;

  for (const raw of data.elements) {
    const el = sanitizeElement(raw, { allowVideo: videoOk, now });
    if (!el) { skipped++; continue; }
    // Deduplicate colliding IDs within the same payload cleanly.
    if (seenIds.has(el.id)) el.id = newId();
    seenIds.add(el.id);
    elements.push(el);
  }

  // Drop dangling frameId references that don't point to a frame in this payload.
  const frameIds = new Set(elements.filter(e => e.type === "frame").map(e => e.id));
  for (const el of elements) {
    if (el.frameId && !frameIds.has(el.frameId)) el.frameId = null;
  }

  reconcileBoundElements(elements);

  const files = sanitizeFiles(data.files, elements, { allowVideo: videoOk, now });
  const rawApp = isPlainObj(data.appState) ? data.appState : {};
  const appState = {
    viewBackgroundColor: typeof rawApp.viewBackgroundColor === "string" && HEX_COLOR_RE.test(rawApp.viewBackgroundColor.trim())
      ? rawApp.viewBackgroundColor.trim()
      : null,
    gridSize: typeof rawApp.gridSize === "number" && Number.isFinite(rawApp.gridSize) && rawApp.gridSize >= 0
      ? clamp(rawApp.gridSize, 0, 1000)
      : null,
  };

  return { ok: true, kind: data.type, elements, files, appState, skipped };
}

/**
 * Remaps `fileId`s on image elements and `files` map using `fileIdMap` (Map or plain object).
 * If `dropNonSha1` is true, any image element whose resulting `fileId` is not a 40-char SHA-1
 * has its `fileId` set to `null` (so protocol v1.1 `opProblem` never rejects it).
 */
export function applyFileIdMap(elements, files = {}, fileIdMap = null, { dropNonSha1 = false } = {}) {
  const lookup = id => {
    if (!id || !fileIdMap) return id;
    if (fileIdMap instanceof Map) return fileIdMap.get(id) ?? id;
    return own(fileIdMap, id) ? fileIdMap[id] : id;
  };
  const nextFiles = {};
  for (const k of Object.keys(files ?? {})) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const f = files[k];
    if (!isPlainObj(f)) continue;
    const mapped = lookup(k);
    if (!mapped || FORBIDDEN_KEYS.has(mapped)) continue;
    nextFiles[mapped] = { ...f, id: mapped };
  }
  const nextElements = (elements ?? []).map(el => {
    const c = clone(el);
    if ((c.type === "image" || c.type === "video") && c.fileId) {
      const mapped = lookup(c.fileId);
      c.fileId = dropNonSha1 && !SHA1_RE.test(mapped) ? null : mapped;
    }
    return c;
  });
  return { elements: nextElements, files: nextFiles };
}

/**
 * Remaps all element IDs and groupIds to fresh IDs while preserving all internal references
 * (`containerId`, `boundElements`, `startBinding`, `endBinding`, `frameId`, `groupIds`) and
 * optionally remapping image `fileId`s via `fileIdMap`.
 */
export function remapExcalidrawIds(elements, files = {}, { fileIdMap = null, layer = BASE_LAYER, zStart = 0, dropNonSha1 = false } = {}) {
  const live = (elements ?? []).filter(e => e && !e.isDeleted);
  const idMap = new Map(live.map(e => [e.id, newId()]));
  const groupMap = new Map();
  const mapGroup = g => {
    let ng = groupMap.get(g);
    if (!ng) { ng = newId(); groupMap.set(g, ng); }
    return ng;
  };
  const lookupFile = id => {
    if (!id || !fileIdMap) return id;
    if (fileIdMap instanceof Map) return fileIdMap.get(id) ?? id;
    return own(fileIdMap, id) ? fileIdMap[id] : id;
  };

  const remapped = live.map((el, i) => {
    const c = clone(el);
    c.id = idMap.get(el.id);
    c.version = 0;
    c.versionNonce = randomInt();
    c.isDeleted = false;
    c.groupIds = (c.groupIds ?? []).map(mapGroup);
    c.frameId = c.frameId ? (idMap.get(c.frameId) ?? null) : null;
    if (c.containerId) c.containerId = idMap.get(c.containerId) ?? null;
    c.boundElements = Array.isArray(c.boundElements)
      ? c.boundElements.filter(b => idMap.has(b.id)).map(b => ({ ...b, id: idMap.get(b.id) }))
      : null;
    if (c.boundElements && !c.boundElements.length) c.boundElements = null;
    for (const k of ["startBinding", "endBinding"]) {
      if (c[k]) c[k] = idMap.has(c[k].elementId) ? { ...c[k], elementId: idMap.get(c[k].elementId) } : null;
    }
    if ((c.type === "image" || c.type === "video") && c.fileId) {
      const mapped = lookupFile(c.fileId);
      c.fileId = dropNonSha1 && !SHA1_RE.test(mapped) ? null : mapped;
    }
    c.customData = { ...(c.customData ?? {}), layer, z: zStart + 1 + i };
    return c;
  });

  reconcileBoundElements(remapped);

  const remappedFiles = {};
  for (const k of Object.keys(files ?? {})) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const f = files[k];
    if (!isPlainObj(f)) continue;
    const mapped = lookupFile(k);
    if (!mapped || FORBIDDEN_KEYS.has(mapped)) continue;
    remappedFiles[mapped] = { ...f, id: mapped };
  }

  return { elements: remapped, files: remappedFiles, idMap, groupMap };
}

/**
 * High-level import helper: parses an Excalidraw file or clipboard payload and optionally
 * remaps IDs + fileIds so the resulting elements can be committed safely via protocol v1.1 ops.
 */
export function importExcalidrawPayload(input, { remapIds = true, fileIdMap = null, layer = BASE_LAYER, zStart = 0, dropNonSha1 = false, allowVideo, now = Date.now() } = {}) {
  const parsed = parseExcalidraw(input, { allowVideo, now });
  if (!parsed.ok) return parsed;
  if (!remapIds) {
    const mapped = fileIdMap || dropNonSha1
      ? applyFileIdMap(parsed.elements, parsed.files, fileIdMap, { dropNonSha1 })
      : { elements: parsed.elements, files: parsed.files };
    return { ...parsed, elements: mapped.elements, files: mapped.files };
  }
  const remapped = remapExcalidrawIds(parsed.elements, parsed.files, { fileIdMap, layer, zStart, dropNonSha1 });
  return {
    ...parsed,
    elements: remapped.elements,
    files: remapped.files,
    idMap: remapped.idMap,
    groupMap: remapped.groupMap,
  };
}

/** Converts a single Plenary element into a 100% schema-complete Excalidraw v2 element. */
export function toExcalidrawElement(el, indexStr = "a0", now = Date.now()) {
  const base = {
    id: el.id,
    type: el.type,
    x: finiteNum(el.x, 0),
    y: finiteNum(el.y, 0),
    width: finiteNum(el.width, 0, 0, MAX_DIM),
    height: finiteNum(el.height, 0, 0, MAX_DIM),
    angle: finiteNum(el.angle, 0),
    strokeColor: el.strokeColor ?? DEFAULT_STROKE,
    backgroundColor: el.backgroundColor ?? "transparent",
    fillStyle: FILL_STYLES.has(el.fillStyle) ? el.fillStyle : "solid",
    strokeWidth: finiteNum(el.strokeWidth, el.type === "frame" ? 1 : 2, 0.1, 64),
    strokeStyle: STROKE_STYLES.has(el.strokeStyle) ? el.strokeStyle : "solid",
    roughness: finiteNum(el.roughness, el.type === "image" || el.type === "video" ? 0 : 1, 0, 3),
    opacity: finiteNum(el.opacity, 100, 0, 100),
    groupIds: Array.isArray(el.groupIds) ? [...el.groupIds] : [],
    frameId: el.frameId ?? null,
    index: typeof el.index === "string" && el.index ? el.index : indexStr,
    roundness: el.roundness ? { ...el.roundness } : null,
    seed: finiteInt(el.seed, randomInt(), 0, 2 ** 31 - 1),
    version: finiteInt(el.version, 1, 1, Number.MAX_SAFE_INTEGER),
    versionNonce: finiteInt(el.versionNonce, randomInt(), 0, 2 ** 31 - 1),
    isDeleted: false,
    boundElements: Array.isArray(el.boundElements) && el.boundElements.length
      ? el.boundElements.map(b => ({ id: b.id, type: b.type }))
      : null,
    updated: finiteInt(el.updated, now, 0, Number.MAX_SAFE_INTEGER),
    link: el.link ?? null,
    locked: el.locked === true,
  };

  if (el.type === "arrow" || el.type === "line") {
    base.points = safePoints(el.points, 2);
    base.lastCommittedPoint = el.lastCommittedPoint ?? null;
    base.startBinding = exportBinding(el.startBinding);
    base.endBinding = exportBinding(el.endBinding);
    base.startArrowhead = el.startArrowhead ?? null;
    base.endArrowhead = el.endArrowhead !== undefined ? el.endArrowhead : (el.type === "arrow" ? "arrow" : null);
    if (el.elbowed === true) base.elbowed = true;
  } else if (el.type === "freedraw") {
    base.points = safePoints(el.points, 1);
    base.pressures = Array.isArray(el.pressures) ? el.pressures.map(clampPressure) : [];
    base.simulatePressure = typeof el.simulatePressure === "boolean" ? el.simulatePressure : base.pressures.length === 0;
    base.lastCommittedPoint = el.lastCommittedPoint ?? null;
  } else if (el.type === "text") {
    base.text = String(el.text ?? "");
    base.originalText = String(el.originalText ?? el.text ?? "");
    base.fontSize = finiteNum(el.fontSize, 20, 4, 512);
    base.fontFamily = finiteInt(el.fontFamily, 1, 1, 8);
    base.textAlign = TEXT_ALIGNS.has(el.textAlign) ? el.textAlign : (el.containerId ? "center" : "left");
    base.verticalAlign = VERTICAL_ALIGNS.has(el.verticalAlign) ? el.verticalAlign : (el.containerId ? "middle" : "top");
    base.lineHeight = finiteNum(el.lineHeight, 1.25, 0.5, 4);
    base.containerId = el.containerId ?? null;
    base.autoResize = typeof el.autoResize === "boolean" ? el.autoResize : true;
  } else if (el.type === "frame") {
    base.name = el.name ?? null;
  } else if (el.type === "image") {
    base.fileId = el.fileId ?? null;
    base.status = IMAGE_STATUSES.has(el.status) ? el.status : "saved";
    base.scale = Array.isArray(el.scale) && el.scale.length === 2 ? [el.scale[0], el.scale[1]] : [1, 1];
    base.crop = el.crop ? { ...el.crop } : null;
  } else if (el.type === "video") {
    base.fileId = el.fileId ?? null;
    base.mimeType = VIDEO_MIMES.has(el.mimeType) ? el.mimeType : "video/mp4";
    base.status = IMAGE_STATUSES.has(el.status) ? el.status : "saved";
    base.scale = Array.isArray(el.scale) && el.scale.length === 2 ? [el.scale[0], el.scale[1]] : [1, 1];
    base.posterDataUrl = el.posterDataUrl ?? null;
    base.loop = el.loop === true;
    base.muted = el.muted !== false;
    base.autoplay = el.autoplay === true;
  }

  if (isPlainObj(el.customData)) base.customData = sanitizeJsonValue(el.customData, 0);
  return base;
}

function buildExportFiles(elements, docFiles, { includeVideo = false, now = Date.now() } = {}) {
  const out = {};
  for (const el of elements) {
    if (!el.fileId) continue;
    const f = docFiles?.[el.fileId];
    if (!f) continue;
    if (el.type === "video") {
      if (includeVideo) {
        out[el.fileId] = { id: f.id ?? el.fileId, mimeType: f.mimeType ?? el.mimeType ?? "video/mp4" };
      }
      continue;
    }
    if (el.type === "image" && typeof f.dataURL === "string" && IMAGE_DATA_URL_RE.test(f.dataURL.trim())) {
      const m = IMAGE_DATA_URL_RE.exec(f.dataURL.trim());
      const created = finiteInt(f.created, now, 0, Number.MAX_SAFE_INTEGER);
      out[el.fileId] = {
        mimeType: f.mimeType || m[1] || "image/png",
        id: el.fileId,
        dataURL: f.dataURL.trim(),
        created,
        lastRetrieved: finiteInt(f.lastRetrieved, created, 0, Number.MAX_SAFE_INTEGER),
      };
    }
  }
  return out;
}

/**
 * Exports a Plenary `Doc` or scene object to a 100% valid Excalidraw v2 JSON object
 * (`{ type: "excalidraw", version: 2, source, elements, appState, files }`).
 */
export function exportToExcalidraw(docOrScene, { source = EXCALIDRAW_SOURCE, viewBackgroundColor, now = Date.now() } = {}) {
  const doc = docOrScene instanceof Doc ? docOrScene : new Doc(docOrScene ?? { elements: [] });
  const baked = fileScene(doc, doc.toScene());
  const live = baked.elements
    .filter(e => e && !e.isDeleted && EXCALIDRAW_TYPES.has(e.type))
    .map(clone);

  reconcileBoundElements(live);

  const elements = live.map((el, i) => toExcalidrawElement(el, fractionalIndex(i), now));
  const files = buildExportFiles(elements, doc.files, { includeVideo: false, now });

  const rawBg = viewBackgroundColor ?? doc.appState?.viewBackgroundColor;
  const bg = typeof rawBg === "string" && HEX_COLOR_RE.test(rawBg.trim()) ? rawBg.trim() : "#ffffff";
  const grid = Number.isFinite(doc.appState?.herdr?.grid) && doc.appState.herdr.grid > 0
    ? doc.appState.herdr.grid
    : (Number.isFinite(doc.appState?.gridSize) && doc.appState.gridSize > 0 ? doc.appState.gridSize : null);

  return {
    type: "excalidraw",
    version: 2,
    source,
    elements,
    appState: {
      gridSize: grid,
      viewBackgroundColor: bg,
    },
    files,
  };
}

/**
 * Serializes a subset of Plenary elements into Excalidraw's clipboard format
 * (`{ type: "excalidraw/clipboard", elements, files }`), compatible with both
 * excalidraw.com paste and Plenary paste (including Plenary video elements).
 */
export function toExcalidrawClipboard(docOrScene, selectedElements, { now = Date.now() } = {}) {
  const doc = docOrScene instanceof Doc ? docOrScene : new Doc(docOrScene ?? { elements: selectedElements ?? [] });
  const src = Array.isArray(selectedElements) ? selectedElements : doc.live();
  const baked = fileScene(doc, { elements: src }).elements
    .filter(e => e && !e.isDeleted && CLIPBOARD_TYPES.has(e.type))
    .map(clone);

  reconcileBoundElements(baked);

  const elements = baked.map((el, i) => toExcalidrawElement(el, fractionalIndex(i), now));
  const files = buildExportFiles(elements, doc.files, { includeVideo: true, now });

  return {
    type: "excalidraw/clipboard",
    elements,
    files,
  };
}
