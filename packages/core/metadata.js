// @ts-check
// Pure shape metadata (owner, service, runbook URL, tier, tags) normalization &
// Protocol v1.1-valid table element grid builder (#6).
// Strictly pure: no DOM, Node, or host globals.

import { BASE_LAYER, makeElement, newId, textSize } from "./model.js";
import { FONT_FAMILY } from "./style.js";

export const MAX_META_OWNER_LENGTH = 64;
export const MAX_META_SERVICE_LENGTH = 64;
export const MAX_META_TIER_LENGTH = 32;
export const MAX_META_TAG_LENGTH = 32;
export const MAX_META_TAGS = 8;
export const MAX_RUNBOOK_URL_LENGTH = 2048;

export const MIN_TABLE_ROWS = 1;
export const MAX_TABLE_ROWS = 20;
export const MIN_TABLE_COLS = 1;
export const MAX_TABLE_COLS = 12;
export const MIN_TABLE_CELL_WIDTH = 40;
export const MAX_TABLE_CELL_WIDTH = 600;
export const MIN_TABLE_CELL_HEIGHT = 24;
export const MAX_TABLE_CELL_HEIGHT = 240;
export const MAX_TABLE_CELL_TEXT = 256;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_CHAR_GLOBAL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const WHITESPACE_RE = /\s/;
const UNSAFE_URL_CHAR_RE = /["<>]/;
const ENCODED_CONTROL_RE = /%0[0-9a-f]|%1[0-9a-f]|%7f/i;
const HTTPS_URL_RE = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PORT_RE = /^[1-9][0-9]{0,4}$/;

/**
 * @typedef {{
 *   owner?: string,
 *   service?: string,
 *   runbookUrl?: string,
 *   tier?: string,
 *   tags?: string[],
 * }} ShapeMeta
 */

/**
 * Trim, strip ASCII control characters, collapse whitespace, and cap string length.
 * @param {unknown} raw
 * @param {number} maxLen
 * @returns {string}
 */
function cleanMetaString(raw, maxLen) {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(CONTROL_CHAR_GLOBAL_RE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trimEnd() : cleaned;
}

/**
 * Strictly validate an `https:`-only runbook URL without host-runtime dependencies.
 * Rejects non-`https:` schemes (`javascript:`, `data:`, `http:`, etc.), `"`, `<`, `>`,
 * backslashes, control characters, embedded whitespace, userinfo credentials, invalid hosts/ports,
 * and URLs longer than 2048 characters.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function validateRunbookUrl(raw) {
  if (typeof raw !== "string") return null;
  // Reject any C0/C1 control characters (including leading/trailing CR, LF, TAB, NUL) before trimming.
  if (CONTROL_CHAR_RE.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_RUNBOOK_URL_LENGTH) return null;
  if (
    WHITESPACE_RE.test(trimmed) ||
    UNSAFE_URL_CHAR_RE.test(trimmed) ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  const match = HTTPS_URL_RE.exec(trimmed);
  if (!match) return null;
  const authority = match[1];
  // Reject userinfo (`user:pass@host`).
  if (authority.includes("@")) return null;

  let host = authority;
  let portPart = "";
  const colonIdx = authority.indexOf(":");
  if (colonIdx !== -1) {
    // Reject multiple colons (malformed authority / IPv6 literal) or invalid port.
    if (authority.indexOf(":", colonIdx + 1) !== -1) return null;
    host = authority.slice(0, colonIdx);
    const portStr = authority.slice(colonIdx + 1);
    if (!PORT_RE.test(portStr)) return null;
    const portNum = Number(portStr);
    if (portNum < 1 || portNum > 65535) return null;
    portPart = `:${portNum}`;
  }

  host = host.toLowerCase();
  if (host.length > 253 || !HOSTNAME_RE.test(host)) return null;

  const path = match[2] ?? "";
  const query = match[3] ?? "";
  const hash = match[4] ?? "";
  if (ENCODED_CONTROL_RE.test(path + query + hash)) return null;

  return `https://${host}${portPart}${path}${query}${hash}`;
}

/**
 * Validate and normalize raw shape metadata (`el.customData.meta`).
 * Returns `null` when empty, non-object, or when an explicit non-empty `runbookUrl` is invalid.
 * @param {any} raw
 * @returns {ShapeMeta | null}
 */
export function normalizeShapeMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  /** @type {ShapeMeta} */
  const out = {};

  const owner = cleanMetaString(raw.owner, MAX_META_OWNER_LENGTH);
  if (owner) out.owner = owner;

  const service = cleanMetaString(raw.service, MAX_META_SERVICE_LENGTH);
  if (service) out.service = service;

  const tier = cleanMetaString(raw.tier, MAX_META_TIER_LENGTH);
  if (tier) out.tier = tier;

  if (raw.runbookUrl !== undefined && raw.runbookUrl !== null) {
    const isEmptyStr = typeof raw.runbookUrl === "string" && !CONTROL_CHAR_RE.test(raw.runbookUrl) && raw.runbookUrl.trim() === "";
    if (!isEmptyStr) {
      const validUrl = validateRunbookUrl(raw.runbookUrl);
      if (!validUrl) return null;
      out.runbookUrl = validUrl;
    }
  }

  if (Array.isArray(raw.tags)) {
    /** @type {string[]} */
    const tags = [];
    const seen = new Set();
    for (const item of raw.tags) {
      if (tags.length >= MAX_META_TAGS) break;
      const tag = cleanMetaString(item, MAX_META_TAG_LENGTH);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length) out.tags = tags;
  }

  return Object.keys(out).length ? out : null;
}

/**
 * Safely read and normalize shape metadata from `el.customData?.meta`.
 * Returns `null` when absent, empty, or invalid.
 * @param {any} el
 * @returns {ShapeMeta | null}
 */
export function metaOf(el) {
  if (!el || typeof el !== "object") return null;
  return normalizeShapeMeta(el.customData?.meta);
}

/**
 * Format compact display text for a shape's metadata badge pill.
 * @param {ShapeMeta | null} meta
 * @returns {string}
 */
export function formatMetaBadgeText(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.service) parts.push(meta.service);
  if (meta.owner) parts.push(meta.owner);
  if (!parts.length && meta.tier) parts.push(meta.tier);
  if (!parts.length && meta.tags?.length) parts.push(meta.tags[0]);
  const base = parts.join(" · ");
  if (meta.runbookUrl) {
    return base ? `${base} ↗` : "runbook ↗";
  }
  return base;
}

/**
 * Clamp an integer option into `[min, max]`, falling back to `fallback` when non-finite.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Clamp a finite number option into `[min, max]`, falling back to `fallback` when non-finite.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNum(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Sanitize cell label text for table elements.
 * @param {unknown} raw
 * @returns {string}
 */
function cleanCellText(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).replace(CONTROL_CHAR_GLOBAL_RE, " ").trim();
  return s.length > MAX_TABLE_CELL_TEXT ? s.slice(0, MAX_TABLE_CELL_TEXT).trimEnd() : s;
}

/**
 * Build a grouped (`groupIds`) Protocol v1.1-valid grid of `rectangle` + bound `text`
 * label elements with a styled header row.
 * @param {{
 *   rows?: number,
 *   cols?: number,
 *   x?: number,
 *   y?: number,
 *   cellWidth?: number,
 *   cellHeight?: number,
 *   headers?: string[],
 *   cells?: string[][],
 *   layer?: string,
 *   z?: number,
 * }} [opts]
 * @returns {Record<string, any>[]}
 */
export function buildTableElements({
  rows = 3,
  cols = 3,
  x = 0,
  y = 0,
  cellWidth = 140,
  cellHeight = 44,
  headers = [],
  cells = [],
  layer = BASE_LAYER,
  z = 1,
} = {}) {
  const rowCount = clampInt(rows, MIN_TABLE_ROWS, MAX_TABLE_ROWS, 3);
  const colCount = clampInt(cols, MIN_TABLE_COLS, MAX_TABLE_COLS, 3);
  const originX = typeof x === "number" && Number.isFinite(x) ? x : 0;
  const originY = typeof y === "number" && Number.isFinite(y) ? y : 0;
  const cw = clampNum(cellWidth, MIN_TABLE_CELL_WIDTH, MAX_TABLE_CELL_WIDTH, 140);
  const ch = clampNum(cellHeight, MIN_TABLE_CELL_HEIGHT, MAX_TABLE_CELL_HEIGHT, 44);
  const layerId = typeof layer === "string" && layer.length > 0 && layer.length <= 64 ? layer : BASE_LAYER;
  const baseZ = typeof z === "number" && Number.isFinite(z) ? z : 1;

  const headerArr = Array.isArray(headers) ? headers : [];
  const cellRows = Array.isArray(cells) ? cells : [];
  const cellsProvideHeader = headerArr.length === 0 && cellRows.length >= rowCount;

  const groupId = newId();
  /** @type {Record<string, any>[]} */
  const elements = [];

  for (let r = 0; r < rowCount; r++) {
    const isHeader = r === 0;
    const fill = isHeader ? "#e9ecef" : (r % 2 === 1 ? "#ffffff" : "#f8f9fa");
    const textColor = isHeader ? "#1e1e1e" : "#343a40";
    const fontSize = isHeader ? 14 : 13;

    for (let c = 0; c < colCount; c++) {
      const cellX = originX + c * cw;
      const cellY = originY + r * ch;

      let labelText = "";
      if (isHeader) {
        const rawHeader = cellsProvideHeader ? cellRows[0]?.[c] : headerArr[c];
        const cleaned = cleanCellText(rawHeader);
        labelText = cleaned || `Col ${c + 1}`;
      } else {
        const dataRow = cellsProvideHeader ? cellRows[r] : cellRows[r - 1];
        labelText = cleanCellText(Array.isArray(dataRow) ? dataRow[c] : "");
      }

      const cellZ = baseZ + (r * colCount + c) * 2;
      const rect = makeElement("rectangle", {
        x: cellX,
        y: cellY,
        width: cw,
        height: ch,
        strokeColor: isHeader ? "#adb5bd" : "#ced4da",
        backgroundColor: fill,
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        roundness: null,
        opacity: 100,
        groupIds: [groupId],
        customData: {
          layer: layerId,
          z: cellZ,
          table: {
            id: groupId,
            row: r,
            col: c,
            rows: rowCount,
            cols: colCount,
            header: isHeader,
          },
        },
      });

      const sz = textSize(labelText || " ", fontSize, 1.25, FONT_FAMILY.sans);
      const labelW = Math.max(8, Math.min(cw - 12, Math.ceil(sz.w)));
      const labelH = Math.min(ch - 6, Math.ceil(sz.h));
      const labelEl = makeElement("text", {
        x: cellX + Math.max(6, (cw - labelW) / 2),
        y: cellY + Math.max(3, (ch - labelH) / 2),
        width: labelW,
        height: labelH,
        text: labelText,
        originalText: labelText,
        fontSize,
        fontFamily: FONT_FAMILY.sans,
        textAlign: "center",
        verticalAlign: "middle",
        strokeColor: textColor,
        containerId: rect.id,
        groupIds: [groupId],
        customData: {
          layer: layerId,
          z: cellZ + 1,
        },
      });

      rect.boundElements = [{ id: labelEl.id, type: "text" }];
      elements.push(rect, labelEl);
    }
  }

  return elements;
}
