// @ts-check
// Shared Plenary HTTP Admin API + Protocol v1.1 WebSocket client for AI agents (CLI & MCP).
// Zero extra dependencies: only Bun/Node built-ins and workspace packages.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Replica } from "../packages/protocol/replica.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { ELEMENT_STREAMS, MAX_ID_CHARS, MAX_OP_BYTES, utf8Bytes } from "../packages/protocol/envelope.js";
import { moderationOf, moderationProblem } from "../packages/protocol/moderation.js";
import { BASE_LAYER, clone, isLabel, isShape, layerOf, layersOf, makeElement, newId, touch } from "../packages/core/model.js";
import { mermaidToElements } from "../packages/core/mermaid.js";
import { getEasing, getPreset } from "../packages/core/anim.js";
import { buildLinkCard, parseLinkCardUrl } from "../packages/core/link-card.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_PLENARY_URL = "https://p5y.omni.ooo";
/** Maximum UTF-8 JSON byte size of a single outgoing element op (half of MAX_OP_BYTES = 1 MB). */
export const MAX_CHUNK_BYTES = 512 * 1024;
const OP_WRAPPER_BYTES = utf8Bytes('{"elements":[]}');
const MAX_LAYER_NAME_CHARS = 200;
const MAX_LAYERS = 100;
const MAX_VIEWS = 100;
const MAX_ANIM_MS = 3_600_000;
const PASSCODE_MIN_LEN = 4;
const PASSCODE_MAX_LEN = 128;
const MAX_VERSION_LABEL_CHARS = 120;

const NOTE_DEFAULTS = { width: 200, height: 140, backgroundColor: "#fef08a", strokeColor: "#1e1e1e" };
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALLOWED_ELEMENT_TYPES = new Set([
  "rectangle", "ellipse", "diamond", "frame", "arrow", "line", "freedraw", "text",
]);
const BOXY_TYPES = new Set(["rectangle", "ellipse", "diamond", "frame"]);
const LINEAR_TYPES = new Set(["arrow", "line", "freedraw"]);
const BINDING_SIDES = new Set(["top", "right", "bottom", "left"]);
const LAYER_ACTIONS = new Set(["list", "create", "rename", "toggle_visible", "toggle_locked", "reorder"]);
const VIEW_ACTIONS = new Set(["list", "create", "delete"]);
const VERSION_ACTIONS = new Set(["list", "create", "get", "delete"]);
const SPACE_ACTIONS = new Set(["list_home", "create_area", "create_space", "trash_board", "restore_board"]);
const ORG_ACTIONS = new Set(["list_members", "add_member", "remove_member", "list_roles"]);
const GENERAL_ROLES = new Set(["editor", "annotator", "commenter", "viewer"]);

export class PlenaryError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, details?: unknown }} [opts]
   */
  constructor(message, { code = "plenary-error", status, details } = {}) {
    super(message);
    this.name = "PlenaryError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** Redact credentials, query strings, and fragments from a URL before placing it in an error message. */
export function redactUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    return String(rawUrl).replace(/\/\/[^/@\s]+@/g, "//<redacted>@");
  }
}

/** Validate a board ID (alphanumeric, `_`, `-`, 1..64 chars; rejects `.` and `..`). */
export function assertBoardId(board) {
  if (typeof board !== "string" || !BOARD_ID_RE.test(board.trim())) {
    throw new PlenaryError("board id must match /^[A-Za-z0-9_-]{1,64}$/", { code: "bad-request" });
  }
  return board.trim();
}

/** Normalize base HTTP(S) URL (strips query, hash, and trailing slashes). */
export function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new PlenaryError("PLENARY_URL (or --url) is required", { code: "config-error" });
  }
  let u;
  try { u = new URL(rawUrl.trim()); }
  catch { throw new PlenaryError(`invalid PLENARY_URL: ${redactUrl(rawUrl)}`, { code: "config-error" }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new PlenaryError(`PLENARY_URL must use http:// or https:// (got ${u.protocol})`, { code: "config-error" });
  }
  u.search = "";
  u.hash = "";
  return u.href.replace(/\/+$/, "");
}

/** Derive the Protocol v1.1 WebSocket URL (`/ws`) from an HTTP(S) base URL. */
export function toWsUrl(baseUrl) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/ws";
  u.search = "";
  u.hash = "";
  return u.href;
}

function assertFiniteNum(val, name) {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new PlenaryError(`${name} must be a finite number`, { code: "bad-request" });
  }
  return val;
}

function assertNonNegInt(val, name) {
  if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 0) {
    throw new PlenaryError(`${name} must be a non-negative integer`, { code: "bad-request" });
  }
  return val;
}

function assertString(val, name, { allowNull = false } = {}) {
  if (allowNull && val === null) return null;
  if (typeof val !== "string") {
    throw new PlenaryError(`${name} must be a string`, { code: "bad-request" });
  }
  return val;
}

function assertId(val, name = "id") {
  const id = assertString(val, name);
  if (!id.length || id.length > MAX_ID_CHARS) {
    throw new PlenaryError(`${name} must be 1..${MAX_ID_CHARS} characters`, { code: "bad-request" });
  }
  return id;
}

function assertPathId(val, name = "id", maxLen = 128) {
  const raw = assertString(val, name).trim();
  if (!raw.length || raw.length > maxLen || raw === "." || raw === ".." || /[/\\?#\0\r\n]/.test(raw)) {
    throw new PlenaryError(`${name} must be a valid identifier (1..${maxLen} chars, no path separators)`, { code: "bad-request" });
  }
  return raw;
}

function assertEmail(val, name = "email") {
  const raw = assertString(val, name).trim().toLowerCase();
  if (!raw.length || raw.length > 320 || /[\p{Cc}\p{Cf}]/u.test(raw) || !EMAIL_RE.test(raw)) {
    throw new PlenaryError(`${name} must be a valid email address`, { code: "bad-request" });
  }
  return raw;
}

function assertBoolean(val, name) {
  if (typeof val !== "boolean") {
    throw new PlenaryError(`${name} must be a boolean`, { code: "bad-request" });
  }
  return val;
}

function assertPoints(val, name = "points") {
  if (!Array.isArray(val) || val.length === 0) {
    throw new PlenaryError(`${name} must be a non-empty array of [x, y] pairs`, { code: "bad-request" });
  }
  return val.map((pt, idx) => {
    if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== "number" || typeof pt[1] !== "number"
      || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
      throw new PlenaryError(`${name}[${idx}] must be a [finiteNumber, finiteNumber] pair`, { code: "bad-request" });
    }
    return [pt[0], pt[1]];
  });
}

function assertRoundness(val, name = "roundness") {
  if (val === null) return null;
  if (val && typeof val === "object" && !Array.isArray(val)
    && typeof val.type === "number" && Number.isFinite(val.type)) {
    return {
      type: val.type,
      ...(val.value !== undefined ? { value: assertFiniteNum(val.value, `${name}.value`) } : {}),
    };
  }
  throw new PlenaryError(`${name} must be null or { type: number }`, { code: "bad-request" });
}

/**
 * Validate an animation spec `{ preset, start, duration, easing?, loop? }`.
 * When `allowNull` is true, `null` is returned as-is (used to clear an animation).
 */
export function validateAnim(val, { allowNull = false } = {}) {
  if (allowNull && val === null) return null;
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new PlenaryError(
      allowNull ? "anim must be an object { preset, start, duration, easing?, loop? } or null" : "anim must be an object { preset, start, duration, easing?, loop? }",
      { code: "bad-request" },
    );
  }
  if (typeof val.preset !== "string" || !getPreset(val.preset)) {
    throw new PlenaryError(`invalid anim.preset: ${String(val.preset)}`, { code: "bad-request" });
  }
  const presetMeta = getPreset(val.preset);
  const start = val.start !== undefined ? assertFiniteNum(val.start, "anim.start") : 0;
  if (start < 0 || start > MAX_ANIM_MS) {
    throw new PlenaryError(`anim.start must be in [0, ${MAX_ANIM_MS}]`, { code: "bad-request" });
  }
  const duration = val.duration !== undefined ? assertFiniteNum(val.duration, "anim.duration") : (presetMeta?.duration ?? 600);
  if (duration <= 0 || duration > MAX_ANIM_MS) {
    throw new PlenaryError(`anim.duration must be in (0, ${MAX_ANIM_MS}]`, { code: "bad-request" });
  }
  /** @type {{ preset: string, start: number, duration: number, easing?: string, loop?: boolean }} */
  const out = { preset: val.preset, start, duration };
  if (val.easing !== undefined) {
    if (typeof val.easing !== "string" || !getEasing(val.easing)) {
      throw new PlenaryError(`invalid anim.easing: ${String(val.easing)}`, { code: "bad-request" });
    }
    out.easing = val.easing;
  }
  if (val.loop !== undefined) {
    out.loop = assertBoolean(val.loop, "anim.loop");
  }
  return out;
}

/** Validate an arrow/line endpoint binding `{ elementId, focus?, gap?, fixedPoint?: [fx, fy], side? }` or `null`. */
export function validateBinding(val, name = "binding") {
  if (val === null) return null;
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new PlenaryError(`${name} must be null or an object { elementId, focus?, gap?, fixedPoint? }`, { code: "bad-request" });
  }
  const elementId = assertId(val.elementId, `${name}.elementId`);
  const focus = val.focus !== undefined ? assertFiniteNum(val.focus, `${name}.focus`) : 0;
  if (focus < -100 || focus > 100) {
    throw new PlenaryError(`${name}.focus must be in [-100, 100]`, { code: "bad-request" });
  }
  const gap = val.gap !== undefined ? assertFiniteNum(val.gap, `${name}.gap`) : 6;
  if (gap < 0 || gap > 1000) {
    throw new PlenaryError(`${name}.gap must be in [0, 1000]`, { code: "bad-request" });
  }
  /** @type {{ elementId: string, focus: number, gap: number, fixedPoint?: [number, number] | null, side?: string }} */
  const out = { elementId, focus, gap };
  if (val.fixedPoint !== undefined) {
    if (val.fixedPoint === null) {
      out.fixedPoint = null;
    } else if (Array.isArray(val.fixedPoint) && val.fixedPoint.length === 2
      && typeof val.fixedPoint[0] === "number" && Number.isFinite(val.fixedPoint[0])
      && typeof val.fixedPoint[1] === "number" && Number.isFinite(val.fixedPoint[1])) {
      out.fixedPoint = [val.fixedPoint[0], val.fixedPoint[1]];
    } else {
      throw new PlenaryError(`${name}.fixedPoint must be null or [finiteNumber, finiteNumber]`, { code: "bad-request" });
    }
  }
  if (val.side !== undefined) {
    if (typeof val.side !== "string" || !BINDING_SIDES.has(val.side)) {
      throw new PlenaryError(`${name}.side must be one of: top, right, bottom, left`, { code: "bad-request" });
    }
    out.side = val.side;
  }
  return out;
}

/** Validate a crop rectangle `{ x, y, width, height, naturalWidth?, naturalHeight? }` or `null`. */
export function validateCrop(val, name = "crop") {
  if (val === null) return null;
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new PlenaryError(`${name} must be null or an object { x, y, width, height, naturalWidth?, naturalHeight? }`, { code: "bad-request" });
  }
  const x = assertFiniteNum(val.x, `${name}.x`);
  const y = assertFiniteNum(val.y, `${name}.y`);
  const width = assertFiniteNum(val.width, `${name}.width`);
  const height = assertFiniteNum(val.height, `${name}.height`);
  if (x < 0 || y < 0) {
    throw new PlenaryError(`${name}.x and ${name}.y must be non-negative`, { code: "bad-request" });
  }
  if (width <= 0 || height <= 0) {
    throw new PlenaryError(`${name}.width and ${name}.height must be positive`, { code: "bad-request" });
  }
  /** @type {{ x: number, y: number, width: number, height: number, naturalWidth?: number, naturalHeight?: number }} */
  const out = { x, y, width, height };
  if (val.naturalWidth !== undefined) {
    const nw = assertFiniteNum(val.naturalWidth, `${name}.naturalWidth`);
    if (nw <= 0) throw new PlenaryError(`${name}.naturalWidth must be positive`, { code: "bad-request" });
    out.naturalWidth = nw;
  }
  if (val.naturalHeight !== undefined) {
    const nh = assertFiniteNum(val.naturalHeight, `${name}.naturalHeight`);
    if (nh <= 0) throw new PlenaryError(`${name}.naturalHeight must be positive`, { code: "bad-request" });
    out.naturalHeight = nh;
  }
  return out;
}

/**
 * Chunk an array of elements into op-sized batches whose UTF-8 JSON `{ elements }` payload
 * is strictly `<= maxBytes` (default 512 KB, well under `MAX_OP_BYTES = 1 MB`).
 * Rejects any single element that alone exceeds `maxBytes` with `PlenaryError(..., { code: "too-large" })`.
 * @param {any[]} elements
 * @param {number} [maxBytes]
 * @returns {any[][]}
 */
export function chunkElementsForOps(elements, maxBytes = MAX_CHUNK_BYTES) {
  if (!Array.isArray(elements)) {
    throw new PlenaryError("elements must be an array", { code: "bad-request" });
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < OP_WRAPPER_BYTES + 2 || maxBytes > MAX_OP_BYTES) {
    throw new PlenaryError(`maxBytes must be an integer in [${OP_WRAPPER_BYTES + 2}, ${MAX_OP_BYTES}]`, { code: "bad-request" });
  }
  if (elements.length === 0) return [];

  /** @type {any[][]} */
  const chunks = [];
  /** @type {any[]} */
  let current = [];
  let currentBytes = OP_WRAPPER_BYTES;

  for (const el of elements) {
    const elBytes = utf8Bytes(JSON.stringify(el));
    const singleOpBytes = OP_WRAPPER_BYTES + elBytes;
    if (singleOpBytes > maxBytes) {
      throw new PlenaryError(
        `element ${el?.id ?? "(unnamed)"} exceeds max op size (${singleOpBytes} > ${maxBytes} bytes)`,
        { code: "too-large", details: { id: el?.id ?? null, bytes: singleOpBytes, maxBytes } },
      );
    }
    const extra = (current.length > 0 ? 1 : 0) + elBytes;
    if (current.length > 0 && currentBytes + extra > maxBytes) {
      chunks.push(current);
      current = [el];
      currentBytes = singleOpBytes;
    } else {
      current.push(el);
      currentBytes += extra;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Validate and normalize a caller-supplied element spec into a complete Plenary element.
 * Copies only allowlisted fields per element type and strips protocol-internal fields
 * (`isDeleted`, `version`, `versionNonce`, `customData`, `boundElements`, etc.).
 */
export function normalizeElement(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlenaryError("each element must be an object", { code: "bad-request" });
  }
  let type = "rectangle";
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !ALLOWED_ELEMENT_TYPES.has(raw.type)) {
      throw new PlenaryError(`unsupported element type: ${String(raw.type)}`, { code: "bad-request" });
    }
    type = raw.type;
  }

  /** @type {Record<string, any>} */
  const fields = {};

  // Optional caller-supplied id (validated against MAX_ID_CHARS)
  if (raw.id !== undefined) {
    fields.id = assertId(raw.id, "id");
  }

  // Common numeric fields
  for (const k of ["x", "y", "width", "height", "angle", "strokeWidth", "roughness", "opacity"]) {
    if (raw[k] !== undefined) fields[k] = assertFiniteNum(raw[k], k);
  }
  // Common string fields
  for (const k of ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle"]) {
    if (raw[k] !== undefined) fields[k] = assertString(raw[k], k);
  }
  if (raw.link !== undefined) fields.link = assertString(raw.link, "link", { allowNull: true });
  if (raw.locked !== undefined) fields.locked = assertBoolean(raw.locked, "locked");
  if (raw.roundness !== undefined) fields.roundness = assertRoundness(raw.roundness, "roundness");
  if (raw.crop !== undefined) fields.crop = validateCrop(raw.crop, "crop");

  // Allowlisted customData shortcuts (raw.customData itself is always stripped)
  if (raw.layer !== undefined || raw.anim !== undefined) {
    /** @type {Record<string, any>} */
    const customData = { layer: BASE_LAYER, z: 0 };
    if (raw.layer !== undefined) customData.layer = assertId(raw.layer, "layer");
    if (raw.anim !== undefined) customData.anim = validateAnim(raw.anim);
    fields.customData = customData;
  }

  // Type-specific allowlisted fields
  if (type === "text") {
    if (raw.text !== undefined) fields.text = assertString(raw.text, "text");
    if (raw.originalText !== undefined) fields.originalText = assertString(raw.originalText, "originalText");
    else if (fields.text !== undefined) fields.originalText = fields.text;
    if (raw.fontSize !== undefined) fields.fontSize = assertFiniteNum(raw.fontSize, "fontSize");
    if (raw.lineHeight !== undefined) fields.lineHeight = assertFiniteNum(raw.lineHeight, "lineHeight");
    if (raw.fontFamily !== undefined) {
      if (typeof raw.fontFamily === "number" && Number.isFinite(raw.fontFamily)) fields.fontFamily = raw.fontFamily;
      else if (typeof raw.fontFamily === "string" && raw.fontFamily.length) fields.fontFamily = raw.fontFamily;
      else throw new PlenaryError("fontFamily must be a finite number or non-empty string", { code: "bad-request" });
    }
    if (raw.textAlign !== undefined) fields.textAlign = assertString(raw.textAlign, "textAlign");
    if (raw.verticalAlign !== undefined) fields.verticalAlign = assertString(raw.verticalAlign, "verticalAlign");
    if (raw.autoResize !== undefined) fields.autoResize = assertBoolean(raw.autoResize, "autoResize");
  }

  if (type === "frame" && raw.name !== undefined) {
    fields.name = assertString(raw.name, "name", { allowNull: true });
  }

  if (LINEAR_TYPES.has(type)) {
    if (raw.points !== undefined) fields.points = assertPoints(raw.points, "points");
    if (type === "arrow" || type === "line") {
      if (raw.startArrowhead !== undefined) fields.startArrowhead = assertString(raw.startArrowhead, "startArrowhead", { allowNull: true });
      if (raw.endArrowhead !== undefined) fields.endArrowhead = assertString(raw.endArrowhead, "endArrowhead", { allowNull: true });
      if (raw.elbowed !== undefined) fields.elbowed = assertBoolean(raw.elbowed, "elbowed");
      if (raw.startBinding !== undefined) fields.startBinding = validateBinding(raw.startBinding, "startBinding");
      if (raw.endBinding !== undefined) fields.endBinding = validateBinding(raw.endBinding, "endBinding");
    }
    if (type === "freedraw") {
      if (raw.pressures !== undefined) {
        if (!Array.isArray(raw.pressures) || !raw.pressures.every(p => typeof p === "number" && Number.isFinite(p))) {
          throw new PlenaryError("pressures must be an array of finite numbers", { code: "bad-request" });
        }
        fields.pressures = [...raw.pressures];
      }
      if (raw.simulatePressure !== undefined) fields.simulatePressure = assertBoolean(raw.simulatePressure, "simulatePressure");
    }
  }

  if (BOXY_TYPES.has(type)) {
    if (fields.width === undefined) fields.width = 160;
    if (fields.height === undefined) fields.height = 80;
  }

  return makeElement(type, fields);
}

/**
 * Validate and apply a caller-supplied patch onto a cloned existing element.
 * Strips protocol-internal fields (`isDeleted`, `version`, `versionNonce`, `customData`, `boundElements`, `fileId`, `type`).
 * Throws `bad-request` if any field is invalid, incompatible with the element's type, or if no mutable field is present.
 */
function applyElementPatch(existing, rawPatch) {
  const next = clone(existing);
  let mutated = false;

  // Common numeric fields
  for (const k of ["x", "y", "width", "height", "angle", "strokeWidth", "roughness", "opacity"]) {
    if (rawPatch[k] !== undefined) {
      next[k] = assertFiniteNum(rawPatch[k], k);
      mutated = true;
    }
  }
  // Common string fields
  for (const k of ["strokeColor", "backgroundColor", "fillStyle", "strokeStyle"]) {
    if (rawPatch[k] !== undefined) {
      next[k] = assertString(rawPatch[k], k);
      mutated = true;
    }
  }
  if (rawPatch.link !== undefined) {
    next.link = assertString(rawPatch.link, "link", { allowNull: true });
    mutated = true;
  }
  if (rawPatch.locked !== undefined) {
    next.locked = assertBoolean(rawPatch.locked, "locked");
    mutated = true;
  }
  if (rawPatch.roundness !== undefined) {
    next.roundness = assertRoundness(rawPatch.roundness, "roundness");
    mutated = true;
  }
  if (rawPatch.frameId !== undefined) {
    next.frameId = rawPatch.frameId === null ? null : assertId(rawPatch.frameId, "frameId");
    mutated = true;
  }
  if (rawPatch.crop !== undefined) {
    next.crop = validateCrop(rawPatch.crop, "crop");
    mutated = true;
  }

  // Allowlisted customData shortcuts (preserve existing customData keys like linkCard)
  if (rawPatch.layer !== undefined || rawPatch.z !== undefined || rawPatch.anim !== undefined) {
    next.customData = { layer: BASE_LAYER, z: 0, ...(next.customData ?? {}) };
    if (rawPatch.layer !== undefined) {
      next.customData.layer = assertId(rawPatch.layer, "layer");
      mutated = true;
    }
    if (rawPatch.z !== undefined) {
      next.customData.z = assertFiniteNum(rawPatch.z, "z");
      mutated = true;
    }
    if (rawPatch.anim !== undefined) {
      const anim = validateAnim(rawPatch.anim, { allowNull: true });
      if (anim === null) delete next.customData.anim;
      else next.customData.anim = anim;
      mutated = true;
    }
  }

  // Type-specific fields
  const textKeys = ["text", "originalText", "fontSize", "lineHeight", "fontFamily", "textAlign", "verticalAlign", "autoResize"];
  if (textKeys.some(k => rawPatch[k] !== undefined)) {
    if (existing.type !== "text") {
      throw new PlenaryError(`text fields cannot be patched on element ${existing.id} of type ${existing.type}`, { code: "bad-request" });
    }
    if (rawPatch.text !== undefined) {
      next.text = assertString(rawPatch.text, "text");
      if (rawPatch.originalText === undefined) next.originalText = next.text;
      mutated = true;
    }
    if (rawPatch.originalText !== undefined) {
      next.originalText = assertString(rawPatch.originalText, "originalText");
      mutated = true;
    }
    if (rawPatch.fontSize !== undefined) { next.fontSize = assertFiniteNum(rawPatch.fontSize, "fontSize"); mutated = true; }
    if (rawPatch.lineHeight !== undefined) { next.lineHeight = assertFiniteNum(rawPatch.lineHeight, "lineHeight"); mutated = true; }
    if (rawPatch.fontFamily !== undefined) {
      if (typeof rawPatch.fontFamily === "number" && Number.isFinite(rawPatch.fontFamily)) next.fontFamily = rawPatch.fontFamily;
      else if (typeof rawPatch.fontFamily === "string" && rawPatch.fontFamily.length) next.fontFamily = rawPatch.fontFamily;
      else throw new PlenaryError("fontFamily must be a finite number or non-empty string", { code: "bad-request" });
      mutated = true;
    }
    if (rawPatch.textAlign !== undefined) { next.textAlign = assertString(rawPatch.textAlign, "textAlign"); mutated = true; }
    if (rawPatch.verticalAlign !== undefined) { next.verticalAlign = assertString(rawPatch.verticalAlign, "verticalAlign"); mutated = true; }
    if (rawPatch.autoResize !== undefined) { next.autoResize = assertBoolean(rawPatch.autoResize, "autoResize"); mutated = true; }
  }

  if (rawPatch.name !== undefined) {
    if (existing.type !== "frame") {
      throw new PlenaryError(`name can only be patched on frame elements (got ${existing.type})`, { code: "bad-request" });
    }
    next.name = assertString(rawPatch.name, "name", { allowNull: true });
    mutated = true;
  }

  if (rawPatch.points !== undefined) {
    if (!LINEAR_TYPES.has(existing.type)) {
      throw new PlenaryError(`points can only be patched on linear elements (got ${existing.type})`, { code: "bad-request" });
    }
    next.points = assertPoints(rawPatch.points, "points");
    mutated = true;
  }

  const arrowKeys = ["startArrowhead", "endArrowhead", "elbowed", "startBinding", "endBinding"];
  if (arrowKeys.some(k => rawPatch[k] !== undefined)) {
    if (existing.type !== "arrow" && existing.type !== "line") {
      throw new PlenaryError(`arrow/line fields cannot be patched on element ${existing.id} of type ${existing.type}`, { code: "bad-request" });
    }
    if (rawPatch.startArrowhead !== undefined) { next.startArrowhead = assertString(rawPatch.startArrowhead, "startArrowhead", { allowNull: true }); mutated = true; }
    if (rawPatch.endArrowhead !== undefined) { next.endArrowhead = assertString(rawPatch.endArrowhead, "endArrowhead", { allowNull: true }); mutated = true; }
    if (rawPatch.elbowed !== undefined) { next.elbowed = assertBoolean(rawPatch.elbowed, "elbowed"); mutated = true; }
    if (rawPatch.startBinding !== undefined) { next.startBinding = validateBinding(rawPatch.startBinding, "startBinding"); mutated = true; }
    if (rawPatch.endBinding !== undefined) { next.endBinding = validateBinding(rawPatch.endBinding, "endBinding"); mutated = true; }
  }

  if (rawPatch.pressures !== undefined || rawPatch.simulatePressure !== undefined) {
    if (existing.type !== "freedraw") {
      throw new PlenaryError(`freedraw fields cannot be patched on element ${existing.id} of type ${existing.type}`, { code: "bad-request" });
    }
    if (rawPatch.pressures !== undefined) {
      if (!Array.isArray(rawPatch.pressures) || !rawPatch.pressures.every(p => typeof p === "number" && Number.isFinite(p))) {
        throw new PlenaryError("pressures must be an array of finite numbers", { code: "bad-request" });
      }
      next.pressures = [...rawPatch.pressures];
      mutated = true;
    }
    if (rawPatch.simulatePressure !== undefined) {
      next.simulatePressure = assertBoolean(rawPatch.simulatePressure, "simulatePressure");
      mutated = true;
    }
  }

  if (!mutated) {
    throw new PlenaryError(`update for ${existing.id} must include at least one patchable field`, { code: "bad-request" });
  }

  return touch(next);
}

/**
 * Normalize `baseVersions` optional map `{ [id]: version }`.
 * @param {Record<string, number> | undefined} baseVersions
 * @returns {Map<string, number>}
 */
function parseBaseVersionsMap(baseVersions) {
  /** @type {Map<string, number>} */
  const map = new Map();
  if (baseVersions === undefined) return map;
  if (!baseVersions || typeof baseVersions !== "object" || Array.isArray(baseVersions)) {
    throw new PlenaryError("baseVersions must be an object mapping element id to non-negative integer version", { code: "bad-request" });
  }
  for (const [k, v] of Object.entries(baseVersions)) {
    const id = assertId(k, "baseVersions key");
    map.set(id, assertNonNegInt(v, `baseVersions[${id}]`));
  }
  return map;
}

/**
 * Create a Plenary client speaking both the HTTP Admin API and Protocol v1.1 WebSockets.
 * @param {{ url?: string, token?: string, timeoutMs?: number, clientName?: string }} opts
 */
export function createPlenaryClient({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS, clientName = "plenary-agent" } = {}) {
  const baseUrl = normalizeBaseUrl(url);
  if (typeof token !== "string" || !token.trim()) {
    throw new PlenaryError("PLENARY_TOKEN (or --token) is required", { code: "config-error" });
  }
  const authToken = token.trim();
  const wsUrl = toWsUrl(baseUrl);
  const safeWsUrl = redactUrl(wsUrl);

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, any>, body?: any, signal?: AbortSignal }} [opts]
   */
  async function requestJson(method, path, { query, body, signal } = {}) {
    if (signal?.aborted) {
      throw new PlenaryError("request cancelled", { code: "cancelled" });
    }
    const target = new URL(baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") target.searchParams.set(k, String(v));
      }
    }
    const headers = { authorization: `Bearer ${authToken}` };
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSig, signal]) : timeoutSig;
    const init = { method, headers, signal: combinedSignal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(target.href, init);
    } catch (err) {
      if (signal?.aborted) {
        throw new PlenaryError("request cancelled", { code: "cancelled" });
      }
      throw new PlenaryError(`HTTP ${method} ${path} failed: ${err?.message ?? err}`, { code: "network-error" });
    }
    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    if (!res.ok) {
      const code = typeof parsed?.error === "string" ? parsed.error : `http-${res.status}`;
      const msg = typeof parsed?.message === "string"
        ? `${code}: ${parsed.message}`
        : `HTTP ${res.status} ${method} ${path} (${code})`;
      throw new PlenaryError(msg, { code, status: res.status, details: parsed });
    }
    return parsed;
  }

  /**
   * Open a short-lived Protocol v1.1 WebSocket session on `board`, catch up via Replica,
   * run `fn(session)`, and always close the socket and clear timers cleanly.
   * @param {string} board
   * @param {(session: { replica: Replica, commitOp: (stream: string, op: any) => Promise<{ opId: string, seq: number }>, commitElements: (stream: string, elements: any[]) => Promise<{ opId: string, opIds: string[], seq: number, chunks: number }>, board: string }) => Promise<any>} fn
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function withBoardSession(board, fn, { signal } = {}) {
    const boardId = assertBoardId(board);
    if (signal?.aborted) {
      throw new PlenaryError("request cancelled", { code: "cancelled" });
    }

    const replica = new Replica({ client: clientName, tab: "agent" });
    const ws = new WebSocket(wsUrl);

    let closed = false;
    let pumpTimer = null;
    let deadlineTimer = null;
    let connectSettled = false;
    let resolveReady, rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

    /** @type {Map<string, { resolve: Function, reject: Function, ackSeq: number | null }>} */
    const waiters = new Map();

    const failAll = err => {
      if (!connectSettled) {
        connectSettled = true;
        rejectReady(err);
      }
      for (const [id, w] of waiters) {
        waiters.delete(id);
        w.reject(err);
      }
    };

    const onAbort = () => {
      failAll(new PlenaryError("request cancelled", { code: "cancelled" }));
      cleanup();
    };

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      if (!closed) {
        closed = true;
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "done");
          }
        } catch { /* already closed */ }
      }
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const sendFrame = msg => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(/** @type {string | ArrayBufferView<ArrayBuffer>} */ (jsonCodec.encode(msg)));
    };

    const pump = () => {
      if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
      if (closed) return;
      if (replica.stopped) {
        failAll(new PlenaryError(`protocol stopped: ${replica.stopped}`, { code: replica.stopped }));
        return;
      }
      if (replica.needAuth) {
        failAll(new PlenaryError("authentication failed", { code: "auth" }));
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const m of replica.outgoing()) sendFrame(m);
      if (replica.resync) {
        failAll(new PlenaryError("connection requires resync", { code: "resync" }));
        return;
      }
      const w = replica.wait();
      if (w !== null) {
        pumpTimer = setTimeout(pump, Math.max(1, w));
        pumpTimer.unref?.();
      }
    };

    const checkReady = () => {
      if (connectSettled) return;
      if (replica.welcomed && !replica.awaitingSnapshot && replica.applied >= replica.target) {
        connectSettled = true;
        resolveReady();
      }
    };

    deadlineTimer = setTimeout(() => {
      failAll(new PlenaryError(`timed out after ${timeoutMs}ms waiting for board ${boardId}`, { code: "timeout" }));
      cleanup();
    }, timeoutMs);
    deadlineTimer.unref?.();

    const closeDone = new Promise(resolve => {
      ws.onclose = e => {
        closed = true;
        if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
        failAll(new PlenaryError(`WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`, { code: "ws-closed" }));
        resolve(undefined);
      };
    });

    ws.onerror = () => {
      failAll(new PlenaryError(`WebSocket error connecting to ${safeWsUrl}`, { code: "ws-error" }));
    };

    ws.onopen = () => {
      for (const m of replica.connectMessages(authToken, boardId)) sendFrame(m);
      pump();
    };

    ws.onmessage = e => {
      let msg;
      try { msg = jsonCodec.decode(e.data); }
      catch { return; }

      if (msg.t === "error") {
        const err = new PlenaryError(msg.message ?? msg.code ?? "server error", { code: msg.code ?? "server-error" });
        if (msg.id && waiters.has(msg.id)) {
          const w = waiters.get(msg.id);
          waiters.delete(msg.id);
          replica.receive(msg);
          w.reject(err);
          pump();
          return;
        }
        replica.receive(msg);
        failAll(err);
        return;
      }

      if (msg.t === "ack" && msg.id && waiters.has(msg.id)) {
        waiters.get(msg.id).ackSeq = msg.seq;
      }

      const did = replica.receive(msg);
      checkReady();

      for (const settledId of did.settled) {
        const w = waiters.get(settledId);
        if (w) {
          waiters.delete(settledId);
          const entrySeq = did.entries.find(entry => entry.id === settledId)?.seq;
          w.resolve({ opId: settledId, seq: entrySeq ?? w.ackSeq ?? replica.applied });
        }
      }
      for (const droppedId of did.dropped) {
        const w = waiters.get(droppedId);
        if (w) {
          waiters.delete(droppedId);
          w.reject(new PlenaryError(`op ${droppedId} was dropped by server`, { code: "op-dropped" }));
        }
      }
      pump();
    };

    const commitOp = (stream, op) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PlenaryError("request cancelled", { code: "cancelled" }));
        return;
      }
      let msg;
      try { msg = replica.local(stream, op); }
      catch (err) { reject(new PlenaryError(err?.message ?? String(err), { code: "bad-op" })); return; }
      if (!msg?.id) {
        reject(new PlenaryError("op was held instead of queued", { code: "op-held" }));
        return;
      }
      waiters.set(msg.id, { resolve, reject, ackSeq: null });
      pump();
    });

    /** H1: Chunk bulk element writes into ≤512 KB UTF-8 JSON ops before committing. */
    const commitElements = async (stream, elements) => {
      const chunks = chunkElementsForOps(elements);
      /** @type {string[]} */
      const opIds = [];
      /** @type {string[]} */
      const committedIds = [];
      let lastSeq = replica.applied;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          const res = await commitOp(stream, { elements: chunk });
          opIds.push(res.opId);
          for (const el of chunk) committedIds.push(el.id);
          lastSeq = res.seq;
        } catch (err) {
          if (opIds.length > 0) {
            const prevDetails = err?.details && typeof err.details === "object" ? err.details : {};
            throw new PlenaryError(
              `chunk ${i + 1}/${chunks.length} failed after ${opIds.length} committed op(s): ${err?.message ?? err}`,
              {
                code: err?.code ?? "partial-write",
                status: err?.status,
                details: {
                  ...prevDetails,
                  committedOpIds: opIds,
                  committedIds,
                  failedChunkIndex: i,
                  totalChunks: chunks.length,
                },
              },
            );
          }
          throw err;
        }
      }
      return {
        opId: opIds[opIds.length - 1],
        opIds,
        seq: lastSeq,
        chunks: chunks.length,
      };
    };

    try {
      await readyPromise;
      return await fn({ replica, commitOp, commitElements, board: boardId });
    } finally {
      cleanup();
      await Promise.race([closeDone, new Promise(r => { const t = setTimeout(r, 200); t.unref?.(); })]);
    }
  }

  const client = {
    baseUrl,
    wsUrl,

    /**
     * GET /boards
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async listBoards(opts = {}) {
      return requestJson("GET", "/boards", { signal: opts.signal });
    },

    /**
     * POST /boards
     * @param {{ title?: string, memberRole?: string | null, space?: string, tenant?: string, signal?: AbortSignal }} [opts]
     */
    async createBoard({ title, memberRole, space, tenant, signal } = {}) {
      /** @type {Record<string, any>} */
      const body = {};
      if (title !== undefined) body.title = title;
      if (memberRole !== undefined) body.memberRole = memberRole;
      if (space !== undefined) body.space = assertPathId(space, "space", 64);
      if (tenant !== undefined) body.tenant = assertPathId(tenant, "tenant");
      return requestJson("POST", "/boards", { body, signal });
    },

    /**
     * POST /boards/:board/links
     * @param {{ board?: string, role?: string, expiresAt?: string | number | null, passcode?: string | null, noDownload?: boolean, signal?: AbortSignal }} [opts]
     */
    async createShareLink({ board, role = "viewer", expiresAt, passcode, noDownload, signal } = {}) {
      const boardId = assertBoardId(board);
      /** @type {Record<string, any>} */
      const body = { role };
      if (expiresAt !== undefined && expiresAt !== null) body.expiresAt = expiresAt;
      if (passcode !== undefined && passcode !== null) {
        if (typeof passcode !== "string" || passcode.length < PASSCODE_MIN_LEN || passcode.length > PASSCODE_MAX_LEN) {
          throw new PlenaryError(`passcode must be a string of ${PASSCODE_MIN_LEN}..${PASSCODE_MAX_LEN} characters`, { code: "bad-request" });
        }
        body.passcode = passcode;
      }
      if (noDownload !== undefined) {
        body.noDownload = assertBoolean(noDownload, "noDownload");
      }
      return requestJson("POST", `/boards/${encodeURIComponent(boardId)}/links`, { body, signal });
    },

    /**
     * GET /boards/:board/audit (board-scoped) or GET /admin/audit (tenant-scoped)
     * @param {{ board?: string, limit?: number, before?: string | number, scope?: "board" | "tenant" | string, signal?: AbortSignal }} [opts]
     */
    async getAudit({ board, limit, before, scope, signal } = {}) {
      if (scope !== undefined && scope !== "board" && scope !== "tenant") {
        throw new PlenaryError("scope must be 'board' or 'tenant'", { code: "bad-request" });
      }
      if (scope === "board" && !board) {
        throw new PlenaryError("board is required when scope is 'board'", { code: "bad-request" });
      }
      const boardId = board ? assertBoardId(board) : undefined;
      const useTenant = scope === "tenant" || !boardId;
      if (useTenant) {
        return requestJson("GET", "/admin/audit", { query: { board: boardId, limit, before }, signal });
      }
      return requestJson("GET", `/boards/${encodeURIComponent(boardId)}/audit`, { query: { limit, before }, signal });
    },

    /**
     * Connect via Protocol v1.1 WS, catch up via Replica, return full board state.
     * @param {{ board?: string, signal?: AbortSignal }} [opts]
     */
    async readBoard({ board, signal } = {}) {
      return withBoardSession(board, async ({ replica, board: boardId }) => {
        const elements = [...replica.streams.board.byId.values()]
          .filter(el => !el.isDeleted)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const notes = [...replica.streams.notes.byId.values()]
          .filter(el => !el.isDeleted)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const comments = replica.recordsState().threads;
        return {
          board: boardId,
          seq: replica.applied,
          role: replica.role,
          user: replica.user,
          elements,
          notes,
          comments,
          appState: replica.streams.board.appState.herdr,
        };
      }, { signal });
    },

    /**
     * Connect via Protocol v1.1 WS, push element ops (chunked ≤512 KB), wait for ack/commit.
     * @param {{ board?: string, elements?: any[], stream?: string, signal?: AbortSignal }} [opts]
     */
    async addElements({ board, elements, stream = "board", signal } = {}) {
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      if (!Array.isArray(elements) || elements.length === 0) {
        throw new PlenaryError("elements must be a non-empty array", { code: "bad-request" });
      }
      const built = elements.map(normalizeElement);
      const seenIds = new Set();
      for (const el of built) {
        if (seenIds.has(el.id)) {
          throw new PlenaryError(`duplicate element id in batch: ${el.id}`, { code: "conflict" });
        }
        seenIds.add(el.id);
      }
      // Pre-validate op chunking before opening a WS session (fail fast on oversized single element)
      chunkElementsForOps(built);

      return withBoardSession(board, async ({ replica, commitElements, board: boardId }) => {
        const doc = replica.streams[stream];
        for (const el of built) {
          if (doc.getAny(el.id)) {
            throw new PlenaryError(`element id already exists: ${el.id}`, { code: "conflict" });
          }
        }
        const { opId, seq, chunks } = await commitElements(stream, built);
        return {
          board: boardId,
          stream,
          seq,
          opId,
          ids: built.map(e => e.id),
          count: built.length,
          chunks,
        };
      }, { signal });
    },

    /**
     * Patch existing elements by `id` with optional per-element `baseVersion` optimistic concurrency check (H2).
     * @param {{ board?: string, updates?: any[], stream?: string, signal?: AbortSignal }} [opts]
     */
    async updateElements({ board, updates, stream = "board", signal } = {}) {
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      if (!Array.isArray(updates) || updates.length === 0) {
        throw new PlenaryError("updates must be a non-empty array", { code: "bad-request" });
      }
      const seenIds = new Set();
      const validatedSpecs = updates.map((u, idx) => {
        if (!u || typeof u !== "object" || Array.isArray(u)) {
          throw new PlenaryError(`updates[${idx}] must be an object`, { code: "bad-request" });
        }
        const id = assertId(u.id, `updates[${idx}].id`);
        if (seenIds.has(id)) {
          throw new PlenaryError(`duplicate element id in updates batch: ${id}`, { code: "conflict" });
        }
        seenIds.add(id);
        const baseVersion = u.baseVersion !== undefined ? assertNonNegInt(u.baseVersion, `updates[${idx}].baseVersion`) : undefined;
        return { id, baseVersion, raw: u };
      });

      return withBoardSession(board, async ({ replica, commitElements, board: boardId }) => {
        const doc = replica.streams[stream];
        /** @type {Array<{ id: string, expectedVersion: number, actualVersion: number }>} */
        const conflicts = [];
        /** @type {any[]} */
        const existingList = [];

        for (const spec of validatedSpecs) {
          const existing = doc.get(spec.id);
          if (!existing) {
            throw new PlenaryError(`element not found: ${spec.id}`, { code: "not-found", details: { id: spec.id } });
          }
          if (spec.baseVersion !== undefined && existing.version !== spec.baseVersion) {
            conflicts.push({ id: spec.id, expectedVersion: spec.baseVersion, actualVersion: existing.version });
          }
          existingList.push({ existing, raw: spec.raw });
        }

        if (conflicts.length > 0) {
          const first = conflicts[0];
          throw new PlenaryError(
            `version conflict on ${conflicts.length === 1 ? `element ${first.id}` : `${conflicts.length} elements`} (expected ${first.expectedVersion}, actual ${first.actualVersion})`,
            { code: "version-conflict", details: { conflicts } },
          );
        }

        const patched = existingList.map(({ existing, raw }) => applyElementPatch(existing, raw));
        /** @type {Map<string, any>} */
        const byId = new Map(patched.map(el => [el.id, el]));

        // Keep bound text labels in sync when their host shape moves or changes layer (matching Editor.shift / moveToLayer).
        for (let i = 0; i < existingList.length; i++) {
          const { existing } = existingList[i];
          const next = patched[i];
          if (!isShape(existing)) continue;
          const label = doc.labelOf(existing);
          if (!label || byId.has(label.id)) continue;
          const dx = (next.x ?? 0) - (existing.x ?? 0);
          const dy = (next.y ?? 0) - (existing.y ?? 0);
          const oldLayer = layerOf(existing);
          const newLayer = layerOf(next);
          if (dx === 0 && dy === 0 && oldLayer === newLayer) continue;
          const nextLabel = clone(label);
          if (dx !== 0 || dy !== 0) {
            nextLabel.x = (nextLabel.x ?? 0) + dx;
            nextLabel.y = (nextLabel.y ?? 0) + dy;
          }
          if (oldLayer !== newLayer) {
            nextLabel.customData = { z: 0, ...(nextLabel.customData ?? {}), layer: newLayer };
          }
          byId.set(nextLabel.id, touch(nextLabel));
        }

        const toCommit = [...byId.values()];
        // Validate chunk limits before committing any op
        chunkElementsForOps(toCommit);
        const { opId, seq, chunks } = await commitElements(stream, toCommit);
        /** @type {Record<string, number>} */
        const versions = {};
        for (const el of patched) {
          versions[el.id] = doc.getAny(el.id)?.version ?? el.version;
        }
        return {
          board: boardId,
          stream,
          seq,
          opId,
          ids: patched.map(e => e.id),
          versions,
          count: patched.length,
          chunks,
        };
      }, { signal });
    },

    /**
     * Soft-delete (`isDeleted: true`) elements by `id` with optional per-element `baseVersion` check (H2).
     * Accepts `ids` as strings or `{ id, baseVersion? }` objects, plus an optional `baseVersions` map.
     * @param {{ board?: string, ids?: Array<string | { id: string, baseVersion?: number }>, baseVersions?: Record<string, number>, stream?: string, signal?: AbortSignal }} [opts]
     */
    async deleteElements({ board, ids, baseVersions, stream = "board", signal } = {}) {
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new PlenaryError("ids must be a non-empty array", { code: "bad-request" });
      }
      const bvMap = parseBaseVersionsMap(baseVersions);
      const seenIds = new Set();
      const targets = ids.map((item, idx) => {
        let id;
        let baseVersion;
        if (typeof item === "string") {
          id = assertId(item, `ids[${idx}]`);
        } else if (item && typeof item === "object" && !Array.isArray(item)) {
          id = assertId(item.id, `ids[${idx}].id`);
          if (item.baseVersion !== undefined) {
            baseVersion = assertNonNegInt(item.baseVersion, `ids[${idx}].baseVersion`);
          }
        } else {
          throw new PlenaryError(`ids[${idx}] must be a string or { id, baseVersion? }`, { code: "bad-request" });
        }
        if (seenIds.has(id)) {
          throw new PlenaryError(`duplicate element id in delete batch: ${id}`, { code: "conflict" });
        }
        seenIds.add(id);
        if (bvMap.has(id)) {
          const mapped = bvMap.get(id);
          if (baseVersion !== undefined && baseVersion !== mapped) {
            throw new PlenaryError(`conflicting baseVersion specified for ${id}`, { code: "bad-request" });
          }
          baseVersion = mapped;
        }
        return { id, baseVersion };
      });

      return withBoardSession(board, async ({ replica, commitElements, board: boardId }) => {
        const doc = replica.streams[stream];
        /** @type {Array<{ id: string, expectedVersion: number, actualVersion: number }>} */
        const conflicts = [];
        /** @type {any[]} */
        const existingList = [];

        for (const t of targets) {
          const existing = doc.get(t.id);
          if (!existing) {
            throw new PlenaryError(`element not found: ${t.id}`, { code: "not-found", details: { id: t.id } });
          }
          if (t.baseVersion !== undefined && existing.version !== t.baseVersion) {
            conflicts.push({ id: t.id, expectedVersion: t.baseVersion, actualVersion: existing.version });
          }
          existingList.push(existing);
        }

        if (conflicts.length > 0) {
          const first = conflicts[0];
          throw new PlenaryError(
            `version conflict on ${conflicts.length === 1 ? `element ${first.id}` : `${conflicts.length} elements`} (expected ${first.expectedVersion}, actual ${first.actualVersion})`,
            { code: "version-conflict", details: { conflicts } },
          );
        }

        // Match Editor.deleteIds: soft-delete target elements + their bound labels, and unbind arrows pointing at deleted ids.
        /** @type {Map<string, any>} */
        const mutations = new Map();
        const deletedIds = new Set();
        for (const existing of existingList) {
          const next = clone(existing);
          next.isDeleted = true;
          mutations.set(next.id, touch(next));
          deletedIds.add(next.id);
        }

        /** @type {string[]} */
        const unboundArrowIds = [];
        for (const live of doc.live()) {
          if (deletedIds.has(live.id)) continue;
          if (isLabel(live) && live.containerId && deletedIds.has(live.containerId)) {
            const nextLabel = clone(live);
            nextLabel.isDeleted = true;
            mutations.set(nextLabel.id, touch(nextLabel));
            deletedIds.add(nextLabel.id);
            continue;
          }
          const unbindStart = live.startBinding?.elementId && deletedIds.has(live.startBinding.elementId);
          const unbindEnd = live.endBinding?.elementId && deletedIds.has(live.endBinding.elementId);
          if (unbindStart || unbindEnd) {
            const nextArrow = clone(live);
            if (unbindStart) nextArrow.startBinding = null;
            if (unbindEnd) nextArrow.endBinding = null;
            mutations.set(nextArrow.id, touch(nextArrow));
            unboundArrowIds.push(nextArrow.id);
          }
        }

        const toCommit = [...mutations.values()];
        chunkElementsForOps(toCommit);
        const { opId, seq, chunks } = await commitElements(stream, toCommit);
        return {
          board: boardId,
          stream,
          seq,
          opId,
          ids: targets.map(t => t.id),
          deletedIds: [...deletedIds],
          ...(unboundArrowIds.length ? { unboundArrowIds } : {}),
          count: targets.length,
          chunks,
        };
      }, { signal });
    },

    /**
     * Set or clear `customData.anim` on one or more element IDs.
     * @param {{ board?: string, ids?: string[], id?: string, anim?: any, baseVersions?: Record<string, number>, stream?: string, signal?: AbortSignal }} [opts]
     */
    async setAnimation({ board, ids, id, anim, baseVersions, stream = "board", signal } = {}) {
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      const idList = ids !== undefined ? ids : (id !== undefined ? [id] : null);
      if (!Array.isArray(idList) || idList.length === 0) {
        throw new PlenaryError("ids must be a non-empty array of element ids", { code: "bad-request" });
      }
      const seenIds = new Set();
      const cleanIds = idList.map((rawId, idx) => {
        const clean = assertId(rawId, `ids[${idx}]`);
        if (seenIds.has(clean)) {
          throw new PlenaryError(`duplicate element id in set_animation batch: ${clean}`, { code: "conflict" });
        }
        seenIds.add(clean);
        return clean;
      });
      if (anim === undefined) {
        throw new PlenaryError("anim is required (pass { preset, start?, duration?, easing?, loop? } or null to clear)", { code: "bad-request" });
      }
      const validatedAnim = validateAnim(anim, { allowNull: true });
      const bvMap = parseBaseVersionsMap(baseVersions);

      return withBoardSession(board, async ({ replica, commitElements, board: boardId }) => {
        const doc = replica.streams[stream];
        /** @type {Array<{ id: string, expectedVersion: number, actualVersion: number }>} */
        const conflicts = [];
        /** @type {any[]} */
        const existingList = [];

        for (const elId of cleanIds) {
          const existing = doc.get(elId);
          if (!existing) {
            throw new PlenaryError(`element not found: ${elId}`, { code: "not-found", details: { id: elId } });
          }
          if (bvMap.has(elId) && existing.version !== bvMap.get(elId)) {
            conflicts.push({ id: elId, expectedVersion: bvMap.get(elId), actualVersion: existing.version });
          }
          existingList.push(existing);
        }

        if (conflicts.length > 0) {
          const first = conflicts[0];
          throw new PlenaryError(
            `version conflict on ${conflicts.length === 1 ? `element ${first.id}` : `${conflicts.length} elements`} (expected ${first.expectedVersion}, actual ${first.actualVersion})`,
            { code: "version-conflict", details: { conflicts } },
          );
        }

        const updated = existingList.map(existing => {
          const next = clone(existing);
          next.customData = { layer: BASE_LAYER, z: 0, ...(next.customData ?? {}) };
          if (validatedAnim === null) delete next.customData.anim;
          else next.customData.anim = validatedAnim;
          return touch(next);
        });
        chunkElementsForOps(updated);
        const { opId, seq, chunks } = await commitElements(stream, updated);
        return {
          board: boardId,
          stream,
          seq,
          opId,
          ids: updated.map(e => e.id),
          anim: validatedAnim,
          count: updated.length,
          chunks,
        };
      }, { signal });
    },

    /**
     * Manage layers in `appState.herdr.layers`: list, create, rename, toggle_visible, toggle_locked, reorder.
     * @param {{ board?: string, action?: string, id?: string, name?: string, visible?: boolean, locked?: boolean, opacity?: number, order?: string[], signal?: AbortSignal }} [opts]
     */
    async manageLayers({ board, action, id, name, visible, locked, opacity, order, signal } = {}) {
      if (typeof action !== "string" || !LAYER_ACTIONS.has(action)) {
        throw new PlenaryError(`action must be one of: ${[...LAYER_ACTIONS].join(", ")}`, { code: "bad-request" });
      }
      if (action === "create") {
        const cleanName = assertString(name, "name").trim();
        if (!cleanName.length || cleanName.length > MAX_LAYER_NAME_CHARS) {
          throw new PlenaryError(`name must be 1..${MAX_LAYER_NAME_CHARS} characters`, { code: "bad-request" });
        }
        if (id !== undefined) assertId(id, "id");
        if (visible !== undefined) assertBoolean(visible, "visible");
        if (locked !== undefined) assertBoolean(locked, "locked");
        if (opacity !== undefined) {
          const opVal = assertFiniteNum(opacity, "opacity");
          if (opVal < 0 || opVal > 100) throw new PlenaryError("opacity must be in [0, 100]", { code: "bad-request" });
        }
      } else if (action === "rename") {
        assertId(id, "id");
        const cleanName = assertString(name, "name").trim();
        if (!cleanName.length || cleanName.length > MAX_LAYER_NAME_CHARS) {
          throw new PlenaryError(`name must be 1..${MAX_LAYER_NAME_CHARS} characters`, { code: "bad-request" });
        }
      } else if (action === "toggle_visible") {
        assertId(id, "id");
        if (visible !== undefined) assertBoolean(visible, "visible");
      } else if (action === "toggle_locked") {
        assertId(id, "id");
        if (locked !== undefined) assertBoolean(locked, "locked");
      } else if (action === "reorder") {
        if (!Array.isArray(order) || order.length === 0 || !order.every(x => typeof x === "string" && x.length > 0 && x.length <= MAX_ID_CHARS)) {
          throw new PlenaryError("order must be a non-empty array of layer ids", { code: "bad-request" });
        }
      }

      return withBoardSession(board, async ({ replica, commitOp, board: boardId }) => {
        const current = layersOf(replica.streams.board.appState).map(l => ({ ...l }));

        if (action === "list") {
          return { board: boardId, seq: replica.applied, layers: current, count: current.length };
        }

        let nextLayers = current;
        let targetLayer = null;

        if (action === "create") {
          if (current.length >= MAX_LAYERS) {
            throw new PlenaryError(`cannot create layer: maximum of ${MAX_LAYERS} layers reached`, { code: "limit" });
          }
          const layerId = id ?? newId();
          if (current.some(l => l.id === layerId)) {
            throw new PlenaryError(`layer id already exists: ${layerId}`, { code: "conflict" });
          }
          targetLayer = {
            id: layerId,
            name: name.trim(),
            visible: visible ?? true,
            locked: locked ?? false,
            opacity: opacity ?? 100,
          };
          nextLayers = [...current, targetLayer];
        } else if (action === "rename") {
          const idx = current.findIndex(l => l.id === id);
          if (idx < 0) throw new PlenaryError(`layer not found: ${id}`, { code: "not-found", details: { id } });
          targetLayer = { ...current[idx], name: name.trim() };
          nextLayers = current.map((l, i) => (i === idx ? targetLayer : l));
        } else if (action === "toggle_visible") {
          const idx = current.findIndex(l => l.id === id);
          if (idx < 0) throw new PlenaryError(`layer not found: ${id}`, { code: "not-found", details: { id } });
          targetLayer = { ...current[idx], visible: visible !== undefined ? visible : !current[idx].visible };
          nextLayers = current.map((l, i) => (i === idx ? targetLayer : l));
        } else if (action === "toggle_locked") {
          const idx = current.findIndex(l => l.id === id);
          if (idx < 0) throw new PlenaryError(`layer not found: ${id}`, { code: "not-found", details: { id } });
          targetLayer = { ...current[idx], locked: locked !== undefined ? locked : !current[idx].locked };
          nextLayers = current.map((l, i) => (i === idx ? targetLayer : l));
        } else if (action === "reorder") {
          const byId = new Map(current.map(l => [l.id, l]));
          const seen = new Set();
          const reordered = [];
          for (const lid of order) {
            if (seen.has(lid)) {
              throw new PlenaryError(`duplicate layer id in order: ${lid}`, { code: "bad-request" });
            }
            const found = byId.get(lid);
            if (!found) {
              throw new PlenaryError(`unknown layer id in order: ${lid}`, { code: "bad-request" });
            }
            seen.add(lid);
            reordered.push(found);
          }
          if (reordered.length !== current.length) {
            throw new PlenaryError("order must include every existing layer id exactly once", { code: "bad-request" });
          }
          nextLayers = reordered;
        }

        const { opId, seq } = await commitOp("board", { appState: { layers: nextLayers } });
        return {
          board: boardId,
          action,
          seq,
          opId,
          ...(targetLayer ? { layer: targetLayer } : {}),
          layers: nextLayers,
        };
      }, { signal });
    },

    /**
     * Parse and add a validated GitHub, Linear, or Jira (or ADO if supported by core) rich link card.
     * @param {{ board?: string, url?: string, x?: number, y?: number, width?: number, height?: number, title?: string, layer?: string, id?: string, signal?: AbortSignal }} [opts]
     */
    async addLinkCard({ board, url, x = 0, y = 0, width, height, title, layer, id, signal } = {}) {
      if (typeof url !== "string" || !url.trim()) {
        throw new PlenaryError("url is required for add_link_card", { code: "bad-request" });
      }
      const parsed = parseLinkCardUrl(url);
      if (!parsed) {
        throw new PlenaryError("unsupported or invalid link card URL (expected https:// GitHub, Linear, or Jira URL)", { code: "bad-request" });
      }
      const nx = assertFiniteNum(x, "x");
      const ny = assertFiniteNum(y, "y");
      /** @type {Record<string, any>} */
      const opts = { x: nx, y: ny };
      if (width !== undefined) {
        const nw = assertFiniteNum(width, "width");
        if (nw <= 0) throw new PlenaryError("width must be positive", { code: "bad-request" });
        opts.width = nw;
      }
      if (height !== undefined) {
        const nh = assertFiniteNum(height, "height");
        if (nh <= 0) throw new PlenaryError("height must be positive", { code: "bad-request" });
        opts.height = nh;
      }
      if (title !== undefined) opts.title = assertString(title, "title");
      if (layer !== undefined) opts.layer = assertId(layer, "layer");
      if (id !== undefined) opts.id = assertId(id, "id");

      const card = buildLinkCard(parsed, opts);
      if (!card) {
        throw new PlenaryError("failed to build link card element", { code: "bad-request" });
      }

      return withBoardSession(board, async ({ replica, commitOp, board: boardId }) => {
        if (replica.streams.board.getAny(card.id)) {
          throw new PlenaryError(`element id already exists: ${card.id}`, { code: "conflict" });
        }
        const { opId, seq } = await commitOp("board", { elements: [card] });
        return {
          board: boardId,
          seq,
          opId,
          id: card.id,
          provider: parsed.provider,
          kind: parsed.kind,
          key: parsed.key,
          title: card.customData.linkCard.title,
          url: parsed.url,
        };
      }, { signal });
    },

    /**
     * List all live frames on a board with `{ id, name, x, y, width, height, layer }`.
     * @param {{ board?: string, signal?: AbortSignal }} [opts]
     */
    async listFrames({ board, signal } = {}) {
      return withBoardSession(board, async ({ replica, board: boardId }) => {
        const frames = [...replica.streams.board.byId.values()]
          .filter(el => !el.isDeleted && el.type === "frame")
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map(el => ({
            id: el.id,
            name: el.name ?? null,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            layer: layerOf(el),
          }));
        return {
          board: boardId,
          seq: replica.applied,
          frames,
          count: frames.length,
        };
      }, { signal });
    },

    /**
     * Manage Named Presentation Views (`{ id, name, frameId, visibleLayers }`) in `appState.herdr.views`.
     * @param {{ board?: string, action?: string, id?: string, name?: string, frameId?: string | null, visibleLayers?: string[], signal?: AbortSignal }} [opts]
     */
    async manageViews({ board, action, id, name, frameId, visibleLayers, signal } = {}) {
      if (typeof action !== "string" || !VIEW_ACTIONS.has(action)) {
        throw new PlenaryError(`action must be one of: ${[...VIEW_ACTIONS].join(", ")}`, { code: "bad-request" });
      }
      if (action === "create") {
        const cleanName = assertString(name, "name").trim();
        if (!cleanName.length || cleanName.length > MAX_LAYER_NAME_CHARS) {
          throw new PlenaryError(`name must be 1..${MAX_LAYER_NAME_CHARS} characters`, { code: "bad-request" });
        }
        if (id !== undefined) assertId(id, "id");
        if (frameId !== undefined && frameId !== null) assertId(frameId, "frameId");
        if (visibleLayers !== undefined) {
          if (!Array.isArray(visibleLayers) || !visibleLayers.every(l => typeof l === "string" && l.length > 0 && l.length <= MAX_ID_CHARS)) {
            throw new PlenaryError("visibleLayers must be an array of layer id strings", { code: "bad-request" });
          }
        }
      } else if (action === "delete") {
        assertId(id, "id");
      }

      return withBoardSession(board, async ({ replica, commitOp, board: boardId }) => {
        const rawViews = replica.streams.board.appState.herdr?.views;
        const current = Array.isArray(rawViews) ? rawViews.map(v => ({ ...v, visibleLayers: Array.isArray(v.visibleLayers) ? [...v.visibleLayers] : [] })) : [];

        if (action === "list") {
          return { board: boardId, seq: replica.applied, views: current, count: current.length };
        }

        if (action === "create") {
          if (current.length >= MAX_VIEWS) {
            throw new PlenaryError(`cannot create view: maximum of ${MAX_VIEWS} views reached`, { code: "limit" });
          }
          const viewId = id ?? newId();
          if (current.some(v => v.id === viewId)) {
            throw new PlenaryError(`view id already exists: ${viewId}`, { code: "conflict" });
          }
          const resolvedVisibleLayers = visibleLayers !== undefined
            ? [...new Set(visibleLayers)]
            : layersOf(replica.streams.board.appState).filter(l => l.visible).map(l => l.id);
          const newView = {
            id: viewId,
            name: name.trim(),
            frameId: frameId ?? null,
            visibleLayers: resolvedVisibleLayers,
          };
          const nextViews = [...current, newView];
          const { opId, seq } = await commitOp("board", { appState: { views: nextViews } });
          return {
            board: boardId,
            action: "create",
            seq,
            opId,
            view: newView,
            views: nextViews,
          };
        }

        // action === "delete"
        const idx = current.findIndex(v => v.id === id);
        if (idx < 0) {
          throw new PlenaryError(`view not found: ${id}`, { code: "not-found", details: { id } });
        }
        const nextViews = current.filter(v => v.id !== id);
        const { opId, seq } = await commitOp("board", { appState: { views: nextViews } });
        return {
          board: boardId,
          action: "delete",
          seq,
          opId,
          id,
          views: nextViews,
        };
      }, { signal });
    },

    /**
     * Parse Mermaid flowchart via packages/core/mermaid.js and push resulting elements over WS (chunked ≤512 KB).
     * @param {{ board?: string, source?: string, origin?: { x?: number, y?: number }, layer?: string, elbow?: boolean, signal?: AbortSignal }} [opts]
     */
    async addMermaid({ board, source, origin, layer, elbow = false, signal } = {}) {
      if (typeof source !== "string" || !source.trim()) {
        throw new PlenaryError("source (Mermaid flowchart text) is required", { code: "bad-request" });
      }
      let normOrigin;
      if (origin !== undefined) {
        if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
          throw new PlenaryError("origin must be an object { x, y }", { code: "bad-request" });
        }
        normOrigin = {
          x: origin.x !== undefined ? assertFiniteNum(origin.x, "origin.x") : 0,
          y: origin.y !== undefined ? assertFiniteNum(origin.y, "origin.y") : 0,
        };
      }
      if (layer !== undefined) assertString(layer, "layer");

      let built;
      try {
        built = mermaidToElements(source, {
          ...(normOrigin ? { origin: normOrigin } : {}),
          ...(layer ? { layer } : {}),
          elbow: Boolean(elbow),
        });
      } catch (err) {
        throw new PlenaryError(`Mermaid parse error: ${err?.message ?? err}`, { code: "bad-mermaid" });
      }
      if (!built.elements.length) {
        throw new PlenaryError("Mermaid diagram produced no elements", { code: "bad-mermaid" });
      }
      chunkElementsForOps(built.elements);
      return withBoardSession(board, async ({ commitElements, board: boardId }) => {
        const { opId, seq, chunks } = await commitElements("board", built.elements);
        return {
          board: boardId,
          seq,
          opId,
          ids: built.elements.map(e => e.id),
          count: built.elements.length,
          nodes: built.graph.nodes.size,
          edges: built.graph.edges.length,
          chunks,
        };
      }, { signal });
    },

    /**
     * Push a sticky note (rectangle + bound text) on the `notes` stream over WS.
     * @param {{ board?: string, text?: string, x?: number, y?: number, width?: number, height?: number, backgroundColor?: string, strokeColor?: string, signal?: AbortSignal }} [opts]
     */
    async addNote({
      board,
      text,
      x = 0,
      y = 0,
      width = NOTE_DEFAULTS.width,
      height = NOTE_DEFAULTS.height,
      backgroundColor = NOTE_DEFAULTS.backgroundColor,
      strokeColor = NOTE_DEFAULTS.strokeColor,
      signal,
    } = {}) {
      if (typeof text !== "string" || !text.trim()) {
        throw new PlenaryError("text is required for add_note", { code: "bad-request" });
      }
      const nx = assertFiniteNum(x, "x");
      const ny = assertFiniteNum(y, "y");
      const nw = assertFiniteNum(width, "width");
      const nh = assertFiniteNum(height, "height");
      if (nw <= 0 || nh <= 0) {
        throw new PlenaryError("width and height must be positive finite numbers", { code: "bad-request" });
      }
      const bg = assertString(backgroundColor, "backgroundColor");
      const sc = assertString(strokeColor, "strokeColor");

      const rect = makeElement("rectangle", {
        x: nx,
        y: ny,
        width: nw,
        height: nh,
        backgroundColor: bg,
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 0,
        strokeColor: sc,
      });
      const label = makeElement("text", {
        x: rect.x,
        y: rect.y,
        text,
        originalText: text,
        fontSize: 20,
        fontFamily: 2,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: rect.id,
      });
      rect.boundElements = [{ id: label.id, type: "text" }];

      return withBoardSession(board, async ({ commitOp, board: boardId }) => {
        const { opId, seq } = await commitOp("notes", { elements: [rect, label] });
        return {
          board: boardId,
          seq,
          opId,
          id: rect.id,
          textId: label.id,
          ids: [rect.id, label.id],
        };
      }, { signal });
    },

    /**
     * Push a comment thread (or reply to an existing thread) on the `records` stream over WS.
     * @param {{ board?: string, text?: string, x?: number, y?: number, thread?: string, element?: string, stream?: string, signal?: AbortSignal }} [opts]
     */
    async addComment({ board, text, x = 0, y = 0, thread, element, stream = "board", signal } = {}) {
      if (typeof text !== "string" || !text.length) {
        throw new PlenaryError("text is required for add_comment", { code: "bad-request" });
      }
      const nx = assertFiniteNum(x, "x");
      const ny = assertFiniteNum(y, "y");
      if (!ELEMENT_STREAMS.includes(stream)) {
        throw new PlenaryError(`stream must be one of: ${ELEMENT_STREAMS.join(", ")}`, { code: "bad-request" });
      }
      const id = newId();
      let op;
      if (typeof thread === "string" && thread.trim()) {
        op = { do: "reply", id, thread: thread.trim(), text };
      } else {
        const anchor = typeof element === "string" && element.trim()
          ? { stream, element: element.trim(), x: nx, y: ny }
          : { point: { x: nx, y: ny } };
        op = { do: "thread", id, anchor, text };
      }

      return withBoardSession(board, async ({ commitOp, board: boardId }) => {
        const { opId, seq } = await commitOp("records", op);
        return {
          board: boardId,
          seq,
          opId,
          id,
          thread: op.do === "reply" ? op.thread : id,
          action: op.do,
        };
      }, { signal });
    },

    /**
     * All-Hands Moderation (#33): set `{ locked?, mutedUsers? }` in `appState.herdr.moderation` over Protocol v1.1 WS.
     * @param {{ board?: string, locked?: boolean, mutedUsers?: string[], signal?: AbortSignal }} [opts]
     */
    async setModeration({ board, locked, mutedUsers, signal } = {}) {
      if (locked === undefined && mutedUsers === undefined) {
        throw new PlenaryError("at least one of locked or mutedUsers is required", { code: "bad-request" });
      }
      if (locked !== undefined) assertBoolean(locked, "locked");
      if (mutedUsers !== undefined) {
        const why = moderationProblem({ locked: false, mutedUsers });
        if (why) throw new PlenaryError(why, { code: "bad-request" });
      }

      return withBoardSession(board, async ({ replica, commitOp, board: boardId }) => {
        const current = moderationOf(replica.streams.board.appState);
        const next = {
          locked: locked !== undefined ? locked : current.locked,
          mutedUsers: mutedUsers !== undefined ? [...mutedUsers] : [...current.mutedUsers],
        };
        const why = moderationProblem(next);
        if (why) throw new PlenaryError(why, { code: "bad-request" });
        const { opId, seq } = await commitOp("board", { appState: { moderation: next } });
        return {
          board: boardId,
          seq,
          opId,
          moderation: next,
        };
      }, { signal });
    },

    /**
     * Version History (#19): list, create (captures synced board scene + label), get, or delete named snapshots.
     * @param {{ board?: string, action?: string, label?: string, versionId?: string, id?: string, snapshot?: Record<string, any>, signal?: AbortSignal }} [opts]
     */
    async manageVersions({ board, action, label, versionId, id, snapshot, signal } = {}) {
      const boardId = assertBoardId(board);
      if (typeof action !== "string" || !VERSION_ACTIONS.has(action)) {
        throw new PlenaryError(`action must be one of: ${[...VERSION_ACTIONS].join(", ")}`, { code: "bad-request" });
      }
      if (action === "list") {
        return requestJson("GET", `/boards/${encodeURIComponent(boardId)}/versions`, { signal });
      }
      if (action === "create") {
        const cleanLabel = assertString(label, "label").trim();
        if (!cleanLabel.length || cleanLabel.length > MAX_VERSION_LABEL_CHARS) {
          throw new PlenaryError(`label must be 1..${MAX_VERSION_LABEL_CHARS} characters`, { code: "bad-request" });
        }
        let snap = snapshot;
        if (snap === undefined) {
          const state = await client.readBoard({ board: boardId, signal });
          snap = {
            elements: state.elements,
            notes: state.notes,
            appState: state.appState,
          };
        } else if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
          throw new PlenaryError("snapshot must be a JSON object", { code: "bad-request" });
        }
        return requestJson("POST", `/boards/${encodeURIComponent(boardId)}/versions`, {
          body: { label: cleanLabel, snapshot: snap },
          signal,
        });
      }
      const vid = assertPathId(versionId ?? id, "versionId");
      if (action === "get") {
        return requestJson("GET", `/boards/${encodeURIComponent(boardId)}/versions/${encodeURIComponent(vid)}`, { signal });
      }
      // action === "delete"
      await requestJson("DELETE", `/boards/${encodeURIComponent(boardId)}/versions/${encodeURIComponent(vid)}`, { signal });
      return { ok: true, board: boardId, versionId: vid, deleted: true };
    },

    /**
     * Areas, Spaces & Board Lifecycle: list_home, create_area, create_space, trash_board, restore_board.
     * @param {{ action?: string, name?: string, group?: string | null, general?: string | null, board?: string, from?: string, signal?: AbortSignal }} [opts]
     */
    async manageSpaces({ action, name, group, general, board, from, signal } = {}) {
      if (typeof action !== "string" || !SPACE_ACTIONS.has(action)) {
        throw new PlenaryError(`action must be one of: ${[...SPACE_ACTIONS].join(", ")}`, { code: "bad-request" });
      }
      if (action === "list_home") {
        return requestJson("GET", "/home", { signal });
      }
      if (action === "create_area" || action === "create_space") {
        const cleanName = assertString(name, "name").trim();
        if (!cleanName.length || cleanName.length > 200 || cleanName.includes("\0")) {
          throw new PlenaryError("name must be 1..200 characters", { code: "bad-request" });
        }
        if (general !== undefined && general !== null && (typeof general !== "string" || !GENERAL_ROLES.has(general))) {
          throw new PlenaryError("general must be null or one of: editor, annotator, commenter, viewer", { code: "bad-request" });
        }
        /** @type {Record<string, any>} */
        const body = { name: cleanName };
        if (general !== undefined) body.general = general;
        if (action === "create_area") {
          return requestJson("POST", "/groups", { body, signal });
        }
        if (group !== undefined) {
          body.group = group === null ? null : assertPathId(group, "group", 64);
        }
        return requestJson("POST", "/spaces", { body, signal });
      }
      const boardId = assertBoardId(board);
      if (action === "trash_board") {
        let fromSpace = from !== undefined && from !== null ? assertPathId(from, "from", 64) : null;
        if (!fromSpace) {
          const listed = await requestJson("GET", "/boards", { signal });
          const found = Array.isArray(listed?.boards) ? listed.boards.find(b => b?.id === boardId) : null;
          if (typeof found?.space === "string" && found.space) {
            fromSpace = found.space;
          }
        }
        if (!fromSpace) {
          throw new PlenaryError("from (current space id) is required to trash a board", { code: "bad-request" });
        }
        return requestJson("POST", `/boards/${encodeURIComponent(boardId)}/trash`, {
          body: { from: fromSpace },
          signal,
        });
      }
      // action === "restore_board"
      return requestJson("POST", `/boards/${encodeURIComponent(boardId)}/restore`, {
        body: {},
        signal,
      });
    },

    /**
     * Members & Roles: list_members, add_member, remove_member, list_roles.
     * @param {{ action?: string, tenant?: string, email?: string, signal?: AbortSignal }} [opts]
     */
    async manageOrg({ action, tenant, email, signal } = {}) {
      if (typeof action !== "string" || !ORG_ACTIONS.has(action)) {
        throw new PlenaryError(`action must be one of: ${[...ORG_ACTIONS].join(", ")}`, { code: "bad-request" });
      }
      if (action === "list_roles") {
        return requestJson("GET", "/roles", { signal });
      }
      let tenantId = tenant !== undefined && tenant !== null && tenant !== "" ? assertPathId(tenant, "tenant") : null;
      if (!tenantId) {
        const res = await requestJson("GET", "/tenants", { signal });
        const tenants = Array.isArray(res?.tenants) ? res.tenants : [];
        const picked = tenants.find(t => t?.isAdmin) ?? tenants[0];
        if (typeof picked?.id === "string" && picked.id) tenantId = picked.id;
      }
      if (!tenantId) {
        throw new PlenaryError("tenant is required (no accessible tenant found)", { code: "bad-request" });
      }
      if (action === "list_members") {
        return requestJson("GET", `/tenants/${encodeURIComponent(tenantId)}/members`, { signal });
      }
      const cleanEmail = assertEmail(email, "email");
      if (action === "add_member") {
        return requestJson("POST", `/tenants/${encodeURIComponent(tenantId)}/members`, {
          body: { email: cleanEmail },
          signal,
        });
      }
      // action === "remove_member"
      await requestJson("DELETE", `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(cleanEmail)}`, { signal });
      return { ok: true, tenant: tenantId, email: cleanEmail, removed: true };
    },

    /**
     * Compliance Data Export (#34): scope "board" (GET /boards/:board/export-data) or "tenant" (GET /admin/export-data).
     * @param {{ scope?: "board" | "tenant" | string, board?: string, tenant?: string, signal?: AbortSignal }} [opts]
     */
    async exportComplianceData({ scope, board, tenant, signal } = {}) {
      if (scope !== undefined && scope !== "board" && scope !== "tenant") {
        throw new PlenaryError("scope must be 'board' or 'tenant'", { code: "bad-request" });
      }
      const resolvedScope = scope ?? (board ? "board" : "tenant");
      const tenantId = tenant !== undefined && tenant !== null && tenant !== "" ? assertPathId(tenant, "tenant") : undefined;
      if (resolvedScope === "board") {
        if (!board) {
          throw new PlenaryError("board is required when scope is 'board'", { code: "bad-request" });
        }
        const boardId = assertBoardId(board);
        return requestJson("GET", `/boards/${encodeURIComponent(boardId)}/export-data`, {
          query: tenantId ? { tenant: tenantId } : undefined,
          signal,
        });
      }
      return requestJson("GET", "/admin/export-data", {
        query: tenantId ? { tenant: tenantId } : undefined,
        signal,
      });
    },

    /**
     * GDPR User Erasure (#34): POST /admin/gdpr/erase. Requires explicit `confirm: true` boolean.
     * @param {{ userId?: string, tenant?: string, confirm?: boolean, signal?: AbortSignal }} [opts]
     */
    async gdprEraseUser({ userId, tenant, confirm, signal } = {}) {
      if (confirm !== true) {
        throw new PlenaryError(
          "gdpr_erase_user requires explicit confirm: true to proceed with irreversible GDPR erasure",
          { code: "confirm-required" },
        );
      }
      const cleanUserId = assertString(userId, "userId").trim();
      if (!cleanUserId.length || cleanUserId.length > 200 || /[\0\n]/.test(cleanUserId) || cleanUserId.startsWith("email:")) {
        throw new PlenaryError("userId must be a valid non-email user identifier (1..200 chars)", { code: "bad-request" });
      }
      const tenantId = tenant !== undefined && tenant !== null && tenant !== "" ? assertPathId(tenant, "tenant") : undefined;
      /** @type {Record<string, any>} */
      const body = { userId: cleanUserId };
      if (tenantId) body.tenant = tenantId;
      return requestJson("POST", "/admin/gdpr/erase", { body, signal });
    },
  };

  return client;
}

/**
 * Resolve the path to the Plenary credentials file (`~/.config/plenary/credentials.json` by default,
 * overridable via `credPath` or `env.PLENARY_CREDENTIALS_PATH`).
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [credPath]
 * @returns {string}
 */
export function getCredentialsPath(env = process.env, credPath) {
  if (typeof credPath === "string" && credPath.trim()) return credPath.trim();
  if (typeof env?.PLENARY_CREDENTIALS_PATH === "string" && env.PLENARY_CREDENTIALS_PATH.trim()) {
    return env.PLENARY_CREDENTIALS_PATH.trim();
  }
  return join(homedir(), ".config", "plenary", "credentials.json");
}

/**
 * Read saved Plenary credentials from disk. Returns `{ defaultUrl: null, servers: {} }` if missing or unreadable.
 * @param {{ env?: Record<string, string | undefined>, credPath?: string }} [opts]
 * @returns {{ defaultUrl: string | null, servers: Record<string, { token: string, expiresAt: number | null, user: { id: string, name: string | null, email: string | null } | null }> }}
 */
export function readCredentials({ env = process.env, credPath } = {}) {
  const path = getCredentialsPath(env, credPath);
  if (!existsSync(path)) return { defaultUrl: null, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { defaultUrl: null, servers: {} };
    }
    const defaultUrl = typeof parsed.defaultUrl === "string" && parsed.defaultUrl.trim()
      ? parsed.defaultUrl.trim()
      : null;
    const servers = parsed.servers && typeof parsed.servers === "object" && !Array.isArray(parsed.servers)
      ? parsed.servers
      : {};
    return { defaultUrl, servers };
  } catch {
    return { defaultUrl: null, servers: {} };
  }
}

/**
 * Atomically write Plenary credentials to disk with `0700` directory and `0600` file permissions.
 * @param {{ defaultUrl: string | null, servers: Record<string, any> }} creds
 * @param {{ env?: Record<string, string | undefined>, credPath?: string }} [opts]
 * @returns {string} written file path
 */
export function writeCredentials(creds, { env = process.env, credPath } = {}) {
  const path = getCredentialsPath(env, credPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on non-POSIX filesystems */ }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const body = JSON.stringify({
    defaultUrl: creds.defaultUrl ?? null,
    servers: creds.servers ?? {},
  }, null, 2) + "\n";
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return path;
}

/**
 * Save a server's CLI session token to `credentials.json` (0600, atomic write).
 * @param {{ url: string, token: string, expiresAt?: number | null, user?: { id: string, name: string | null, email: string | null } | null, setDefault?: boolean }} entry
 * @param {{ env?: Record<string, string | undefined>, credPath?: string }} [opts]
 */
export function saveServerCredentials({ url, token, expiresAt = null, user = null, setDefault = true }, { env = process.env, credPath } = {}) {
  const normalizedUrl = normalizeBaseUrl(url);
  if (typeof token !== "string" || !token.trim()) {
    throw new PlenaryError("token is required", { code: "bad-request" });
  }
  const creds = readCredentials({ env, credPath });
  creds.servers[normalizedUrl] = {
    token: token.trim(),
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null,
    user: user && typeof user === "object"
      ? { id: String(user.id ?? ""), name: user.name ?? null, email: user.email ?? null }
      : null,
  };
  if (setDefault || !creds.defaultUrl) {
    creds.defaultUrl = normalizedUrl;
  }
  const path = writeCredentials(creds, { env, credPath });
  return { path, url: normalizedUrl, creds };
}

/**
 * Remove saved credentials for a single server URL (or all servers when `all: true`).
 * @param {{ url?: string | null, all?: boolean }} [target]
 * @param {{ env?: Record<string, string | undefined>, credPath?: string }} [opts]
 */
export function removeServerCredentials({ url = null, all = false } = {}, { env = process.env, credPath } = {}) {
  const creds = readCredentials({ env, credPath });
  if (all) {
    const hadAny = Object.keys(creds.servers).length > 0 || creds.defaultUrl !== null;
    writeCredentials({ defaultUrl: null, servers: {} }, { env, credPath });
    return { removed: hadAny, url: null, all: true };
  }
  const rawUrl = (typeof url === "string" && url.trim())
    ? url.trim()
    : (typeof env?.PLENARY_URL === "string" && env.PLENARY_URL.trim())
      ? env.PLENARY_URL.trim()
      : creds.defaultUrl;
  if (!rawUrl) return { removed: false, url: null, all: false };
  const normalizedUrl = normalizeBaseUrl(rawUrl);
  const existed = Object.prototype.hasOwnProperty.call(creds.servers, normalizedUrl);
  if (existed) delete creds.servers[normalizedUrl];
  if (creds.defaultUrl === normalizedUrl) {
    creds.defaultUrl = Object.keys(creds.servers)[0] ?? null;
  }
  if (existed || existsSync(getCredentialsPath(env, credPath))) {
    writeCredentials(creds, { env, credPath });
  }
  return { removed: existed, url: normalizedUrl, all: false };
}

/**
 * Resolve `{ url, token, source, user, expiresAt }` using precedence:
 *   1. Explicit `token` or `env.PLENARY_TOKEN` wins (source: `"env"`).
 *   2. Otherwise reads `credentials.json`: resolves `url` from explicit `url` -> `env.PLENARY_URL` -> `creds.defaultUrl`,
 *      and `token` from `creds.servers[normalizedUrl]` (source: `"credentials"`).
 *   3. Otherwise returns `token: null, source: "none"`.
 * @param {{ url?: string | null, token?: string | null, env?: Record<string, string | undefined>, credPath?: string }} [opts]
 * @returns {{ url: string | null, token: string | null, source: "env" | "credentials" | "none", user: { id: string, name: string | null, email: string | null } | null, expiresAt: number | null }}
 */
export function resolveCredentials({ url = null, token = null, env = process.env, credPath } = {}) {
  const explicitToken = typeof token === "string" && token.trim() ? token.trim() : null;
  const envToken = typeof env?.PLENARY_TOKEN === "string" && env.PLENARY_TOKEN.trim() ? env.PLENARY_TOKEN.trim() : null;
  const creds = readCredentials({ env, credPath });
  const rawUrl = (typeof url === "string" && url.trim())
    ? url.trim()
    : (typeof env?.PLENARY_URL === "string" && env.PLENARY_URL.trim())
      ? env.PLENARY_URL.trim()
      : creds.defaultUrl;
  const normalizedUrl = rawUrl ? normalizeBaseUrl(rawUrl) : null;
  const saved = normalizedUrl && Object.prototype.hasOwnProperty.call(creds.servers, normalizedUrl)
    ? creds.servers[normalizedUrl]
    : null;

  if (explicitToken || envToken) {
    return {
      url: normalizedUrl,
      token: explicitToken ?? envToken,
      source: "env",
      user: null,
      expiresAt: null,
    };
  }
  if (saved && typeof saved.token === "string" && saved.token.trim()) {
    return {
      url: normalizedUrl,
      token: saved.token.trim(),
      source: "credentials",
      user: saved.user ?? null,
      expiresAt: typeof saved.expiresAt === "number" ? saved.expiresAt : null,
    };
  }
  return {
    url: normalizedUrl,
    token: null,
    source: "none",
    user: null,
    expiresAt: null,
  };
}
