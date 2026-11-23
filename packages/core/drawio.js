// @ts-check
// Safe, zero-dependency .drawio / mxGraph XML importer (#21).
// Strictly pure: no DOM, DOMParser, Node, Bun, or host globals; zero eval; zero XXE.
// Runs identically in Bun, browsers, and QuickJS.

import {
  DEFAULT_STROKE, BASE_LAYER, makeElement, newId, textSize, utf8Bytes,
} from "./model.js";
import { Doc } from "./doc.js";
import { normalize, normAngle, settle, labelAnchor } from "./geometry.js";

export const MAX_DRAWIO_BYTES = 10 * 1024 * 1024;
export const MAX_DRAWIO_ELEMENTS = 5_000;
export const MAX_DRAWIO_OP_BYTES = 900_000;
const MAX_XML_DEPTH = 128;
const MAX_XML_NODES = 100_000;
const MAX_COORD = 1e7;
const MAX_DIM = 1e6;
const MAX_POINTS_PER_EDGE = 512;
const MAX_LABEL_CHARS = 10_000;

const FORBIDDEN_DECL_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i;
const NAMED_COLORS = new Set([
  "transparent", "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
  "pink", "brown", "gray", "grey", "cyan", "magenta", "silver", "maroon", "olive", "lime",
  "aqua", "teal", "navy", "fuchsia", "indigo", "violet", "gold", "coral", "crimson",
  "darkblue", "darkgreen", "darkred", "darkgray", "darkgrey", "lightblue", "lightgreen",
  "lightgray", "lightgrey", "skyblue", "slategray", "slategrey", "steelblue", "tomato",
]);

const BINDABLE_TYPES = new Set(["rectangle", "diamond", "ellipse", "frame"]);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function parseFinite(raw, fallback = 0, lo = -MAX_COORD, hi = MAX_COORD) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

function sanitizeColor(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s || s.length > 48 || /[\x00-\x1f\x7f]/.test(s)) return fallback;
  const lower = s.toLowerCase();
  if (lower === "none" || lower === "transparent") return "transparent";
  if (lower === "default") return fallback;
  if (HEX_COLOR_RE.test(s)) return s;
  if (RGB_COLOR_RE.test(s)) return s;
  if (NAMED_COLORS.has(lower)) return lower;
  return fallback;
}

function decodeEntities(str) {
  if (!str || !str.includes("&")) return str;
  return str.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,10});/g, (m, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
      try { return String.fromCodePoint(code); } catch { return ""; }
    }
    switch (ent.toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      case "nbsp": return " ";
      default: return m;
    }
  });
}

function cleanLabelHtml(raw) {
  if (typeof raw !== "string" || !raw) return "";
  let s = raw;
  // Remove script/style blocks completely before stripping tags.
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // Convert HTML line/block breaks into newlines.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:div|p|li|tr|h[1-6])\s*>\s*<(?:div|p|li|tr|h[1-6])\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(?:div|p|li|tr|h[1-6])\s*>/gi, "\n");
  // Strip all remaining HTML tags.
  s = s.replace(/<[^>]*>/g, "");
  // Decode HTML entities left inside the label text.
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  // Trim trailing blank lines created by closing block tags while preserving internal newlines.
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > MAX_LABEL_CHARS) s = s.slice(0, MAX_LABEL_CHARS);
  return s;
}

// ── Zero-dependency safe XML parser ─────────────────────────────────────────

/**
 * @typedef {{
 *   tag: string,
 *   attrs: Record<string, string>,
 *   children: XmlNode[],
 *   text: string,
 * }} XmlNode
 */

function parseAttrs(src, start, end) {
  /** @type {Record<string, string>} */
  const attrs = Object.create(null);
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(src[i])) i++;
    if (i >= end) break;
    const nameStart = i;
    while (i < end && !/[\s=/>]/.test(src[i])) i++;
    const name = src.slice(nameStart, i);
    if (!name) { i++; continue; }
    while (i < end && /\s/.test(src[i])) i++;
    if (i < end && src[i] === "=") {
      i++;
      while (i < end && /\s/.test(src[i])) i++;
      let val = "";
      if (i < end && (src[i] === "\"" || src[i] === "'")) {
        const q = src[i++];
        const valStart = i;
        while (i < end && src[i] !== q) i++;
        val = decodeEntities(src.slice(valStart, i));
        if (i < end && src[i] === q) i++;
      } else {
        const valStart = i;
        while (i < end && !/[\s/>]/.test(src[i])) i++;
        val = decodeEntities(src.slice(valStart, i));
      }
      if (name !== "__proto__" && name !== "constructor" && name !== "prototype") {
        attrs[name] = val;
      }
    } else if (name !== "__proto__" && name !== "constructor" && name !== "prototype") {
      attrs[name] = "";
    }
  }
  return attrs;
}

/**
 * Find the closing `>` of a tag starting at `start`, ignoring `>` inside quoted attribute values.
 */
function findTagEnd(src, start) {
  let quote = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Parse XML into a lightweight node tree without DOMParser.
 * @param {string} src
 * @returns {{ ok: boolean, root?: XmlNode, error?: string }}
 */
function parseXml(src) {
  /** @type {XmlNode} */
  const docRoot = { tag: "#root", attrs: Object.create(null), children: [], text: "" };
  /** @type {XmlNode[]} */
  const stack = [docRoot];
  let i = 0;
  let nodeCount = 0;
  const len = src.length;

  while (i < len) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (i < len) stack[stack.length - 1].text += src.slice(i);
      break;
    }
    if (lt > i) {
      stack[stack.length - 1].text += src.slice(i, lt);
    }

    // Comment <!-- ... -->
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) return { ok: false, error: "Unclosed XML comment" };
      i = end + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) return { ok: false, error: "Unclosed CDATA section" };
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }

    // Processing instruction <? ... ?>
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) return { ok: false, error: "Unclosed processing instruction" };
      i = end + 2;
      continue;
    }

    // Declarations <! ... > (DOCTYPE/ENTITY already rejected before parsing)
    if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) return { ok: false, error: "Unclosed XML declaration" };
      i = end + 1;
      continue;
    }

    // Closing tag </tag>
    if (src.startsWith("</", lt)) {
      const gt = src.indexOf(">", lt + 2);
      if (gt < 0) return { ok: false, error: "Unclosed closing tag" };
      const closeTag = src.slice(lt + 2, gt).trim();
      // Pop matching tag if on stack (tolerant of minor mismatches in hand-edited XML).
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === closeTag) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    // Opening or self-closing tag <tag ...>
    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) return { ok: false, error: "Unclosed XML tag" };

    let innerEnd = gt;
    let selfClosing = false;
    if (innerEnd > lt + 1 && src[innerEnd - 1] === "/") {
      selfClosing = true;
      innerEnd--;
    }

    let p = lt + 1;
    while (p < innerEnd && /\s/.test(src[p])) p++;
    const tagStart = p;
    while (p < innerEnd && !/[\s/>]/.test(src[p])) p++;
    const tag = src.slice(tagStart, p);
    if (!tag) {
      i = gt + 1;
      continue;
    }

    nodeCount++;
    if (nodeCount > MAX_XML_NODES) {
      return { ok: false, error: `XML exceeds maximum node limit (${MAX_XML_NODES})` };
    }

    const attrs = parseAttrs(src, p, innerEnd);
    /** @type {XmlNode} */
    const node = { tag, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);

    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        return { ok: false, error: `XML nesting exceeds maximum depth (${MAX_XML_DEPTH})` };
      }
      stack.push(node);
    }
    i = gt + 1;
  }

  return { ok: true, root: docRoot };
}

function findFirst(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const found = findFirst(child, tag);
    if (found) return found;
  }
  return null;
}

function findAllDirect(node, tag) {
  return node ? node.children.filter(c => c.tag === tag) : [];
}

// ── Draw.io style & geometry helpers ────────────────────────────────────────

/**
 * Parse semicolon-delimited Draw.io style string into `{ props, tokens }`.
 * @param {string} styleStr
 */
function parseStyle(styleStr) {
  /** @type {Record<string, string>} */
  const props = Object.create(null);
  /** @type {Set<string>} */
  const tokens = new Set();
  if (typeof styleStr !== "string" || !styleStr) return { props, tokens };
  for (const part of styleStr.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      tokens.add(trimmed.toLowerCase());
    } else {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k && k !== "__proto__" && k !== "constructor" && k !== "prototype") {
        props[k] = v;
      }
    }
  }
  return { props, tokens };
}

function mapVertexType(style) {
  const { props, tokens } = style;
  const shape = (props.shape ?? "").toLowerCase();
  if (tokens.has("ellipse") || shape === "ellipse" || shape === "doubleellipse") return "ellipse";
  if (tokens.has("rhombus") || shape === "rhombus" || shape === "mxgraph.flowchart.decision") return "diamond";
  if (tokens.has("text") || shape === "text") return "text";
  if (tokens.has("swimlane") || tokens.has("group") || shape === "swimlane" || shape === "group") return "frame";
  return "rectangle";
}

function mapArrowhead(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  const v = raw.toLowerCase();
  if (v === "none") return null;
  if (v === "classic" || v === "classicthin" || v === "open" || v === "openthin" || v === "async" || v === "asyncthin") return "arrow";
  if (v === "block" || v === "blockthin") return "triangle";
  if (v === "oval" || v === "circle") return "dot";
  if (v === "diamond" || v === "diamondthin") return "diamond";
  if (v === "dash" || v === "cross") return "bar";
  if (v === "erone" || v === "ermandone") return "crowfoot_one";
  if (v === "ermany" || v === "erzerotomany") return "crowfoot_many";
  if (v === "eronetomany") return "crowfoot_one_or_many";
  return fallback;
}

function mapStrokeStyle(props) {
  if (props.dashed !== "1" && props.dashed !== "true") return "solid";
  const pattern = (props.dashPattern ?? "").trim();
  if (pattern && /^1\s+[1-4]\b/.test(pattern)) return "dotted";
  return "dashed";
}

function extractGeometry(cellNode) {
  const geo = cellNode.children.find(c => c.tag === "mxGeometry");
  if (!geo) return null;
  const x = parseFinite(geo.attrs.x, 0, -MAX_COORD, MAX_COORD);
  const y = parseFinite(geo.attrs.y, 0, -MAX_COORD, MAX_COORD);
  const width = parseFinite(geo.attrs.width, 0, 0, MAX_DIM);
  const height = parseFinite(geo.attrs.height, 0, 0, MAX_DIM);
  const relative = geo.attrs.relative === "1" || geo.attrs.relative === "true";

  /** @type {[number, number] | null} */
  let sourcePoint = null;
  /** @type {[number, number] | null} */
  let targetPoint = null;
  /** @type {[number, number][]} */
  const waypoints = [];

  for (const child of geo.children) {
    if (child.tag === "mxPoint") {
      const px = parseFinite(child.attrs.x, 0, -MAX_COORD, MAX_COORD);
      const py = parseFinite(child.attrs.y, 0, -MAX_COORD, MAX_COORD);
      if (child.attrs.as === "sourcePoint") sourcePoint = [px, py];
      else if (child.attrs.as === "targetPoint") targetPoint = [px, py];
    } else if (child.tag === "Array" && child.attrs.as === "points") {
      for (const pt of child.children) {
        if (pt.tag !== "mxPoint") continue;
        if (waypoints.length >= MAX_POINTS_PER_EDGE) break;
        waypoints.push([
          parseFinite(pt.attrs.x, 0, -MAX_COORD, MAX_COORD),
          parseFinite(pt.attrs.y, 0, -MAX_COORD, MAX_COORD),
        ]);
      }
    }
  }
  return { x, y, width, height, relative, sourcePoint, targetPoint, waypoints };
}

function attachBoundRef(host, ref) {
  if (!Array.isArray(host.boundElements)) host.boundElements = [];
  if (!host.boundElements.some(b => b.id === ref.id && b.type === ref.type)) {
    host.boundElements.push(ref);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fast, safe check for whether a string looks like a .drawio / mxGraph XML payload.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isDrawio(text) {
  if (typeof text !== "string" || !text) return false;
  // Inspect a bounded prefix (up to 4 KB) so huge non-XML strings return immediately.
  const head = text.slice(0, 4096).replace(/^\uFEFF/, "").trimStart();
  if (!head.startsWith("<")) return false;
  return /<(?:mxfile|mxGraphModel|mxCell)\b/.test(head);
}

/**
 * Parse a .drawio / mxGraph XML document into Protocol v1.1-valid Plenary elements.
 * @param {unknown} xmlText
 * @param {{ now?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   elements: any[],
 *   files: Record<string, any>,
 *   warnings: string[],
 *   pageName: string | null,
 *   error?: string,
 * }}
 */
export function parseDrawio(xmlText, { now = Date.now() } = {}) {
  /** @type {string[]} */
  const warnings = [];
  const fail = (error, pageName = null) => ({ ok: false, error, elements: [], files: {}, warnings, pageName });

  if (typeof xmlText !== "string") return fail("Draw.io input must be a string");
  const trimmed = xmlText.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return fail("Draw.io input is empty");

  if (utf8Bytes(trimmed) > MAX_DRAWIO_BYTES) {
    return fail(`Draw.io input exceeds maximum size of ${MAX_DRAWIO_BYTES} bytes`);
  }
  if (FORBIDDEN_DECL_RE.test(trimmed)) {
    return fail("Draw.io XML with DOCTYPE or ENTITY declarations is not permitted");
  }

  const parsed = parseXml(trimmed);
  if (!parsed.ok) return fail(parsed.error);

  // Locate <mxGraphModel> either directly or inside <mxfile>/<diagram>.
  /** @type {string | null} */
  let pageName = null;
  let graphModel = null;

  const mxfile = findFirst(parsed.root, "mxfile");
  if (mxfile) {
    const diagrams = findAllDirect(mxfile, "diagram");
    if (diagrams.length > 1) {
      warnings.push(`Draw.io file has ${diagrams.length} pages; importing the first uncompressed page`);
    }
    for (const diag of diagrams) {
      const model = findFirst(diag, "mxGraphModel");
      if (model) {
        graphModel = model;
        pageName = diag.attrs.name ? diag.attrs.name.slice(0, 200) : null;
        break;
      }
      if (!pageName && diag.attrs.name) pageName = diag.attrs.name.slice(0, 200);
    }
    if (!graphModel) {
      const hasCompressed = diagrams.some(d => d.text.trim().length > 0);
      if (hasCompressed) {
        return fail("Compressed <diagram> data is not supported; export uncompressed XML from draw.io", pageName);
      }
      return fail("No <mxGraphModel> found in <mxfile>", pageName);
    }
  } else {
    graphModel = findFirst(parsed.root, "mxGraphModel");
    if (!graphModel) {
      // Allow bare <root> containing <mxCell> elements.
      const bareRoot = findFirst(parsed.root, "root");
      if (bareRoot) graphModel = { tag: "mxGraphModel", attrs: Object.create(null), children: [bareRoot], text: "" };
    }
    if (!graphModel) return fail("No <mxGraphModel> found in XML");
  }

  const rootNode = findFirst(graphModel, "root");
  if (!rootNode) return fail("No <root> element found in <mxGraphModel>", pageName);

  // Collect raw cell records from <mxCell>, <object>, and <UserObject>.
  /**
   * @typedef {{
   *   id: string,
   *   value: string,
   *   styleStr: string,
   *   style: ReturnType<typeof parseStyle>,
   *   vertex: boolean,
   *   edge: boolean,
   *   parent: string,
   *   source: string,
   *   target: string,
   *   link: string | null,
   *   geo: ReturnType<typeof extractGeometry>,
   * }} RawCell
   */
  /** @type {RawCell[]} */
  const rawCells = [];
  /** @type {Map<string, RawCell>} */
  const cellById = new Map();

  for (const child of rootNode.children) {
    let cellNode = null;
    /** @type {Record<string, string> | null} */
    let wrapperAttrs = null;

    if (child.tag === "mxCell") {
      cellNode = child;
    } else if (child.tag === "object" || child.tag === "UserObject") {
      wrapperAttrs = child.attrs;
      cellNode = child.children.find(c => c.tag === "mxCell") ?? null;
    }
    if (!cellNode) continue;

    const id = (wrapperAttrs?.id || cellNode.attrs.id || "").trim();
    if (!id) continue;
    const rawValue = wrapperAttrs?.label ?? cellNode.attrs.value ?? "";
    const styleStr = cellNode.attrs.style ?? "";
    const rawLink = wrapperAttrs?.link ?? null;
    const link = typeof rawLink === "string" && /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i.test(rawLink.trim())
      ? rawLink.trim()
      : null;

    /** @type {RawCell} */
    const rec = {
      id,
      value: cleanLabelHtml(rawValue),
      styleStr,
      style: parseStyle(styleStr),
      vertex: cellNode.attrs.vertex === "1" || cellNode.attrs.vertex === "true",
      edge: cellNode.attrs.edge === "1" || cellNode.attrs.edge === "true",
      parent: (cellNode.attrs.parent ?? "").trim(),
      source: (cellNode.attrs.source ?? "").trim(),
      target: (cellNode.attrs.target ?? "").trim(),
      link,
      geo: extractGeometry(cellNode),
    };
    rawCells.push(rec);
    cellById.set(id, rec);
  }

  // Resolve absolute (x, y) offset for any cell by walking its parent chain (cycle-safe).
  /** @type {Map<string, { x: number, y: number }>} */
  const absPosCache = new Map();
  function absOffsetOf(cellId) {
    if (!cellId) return { x: 0, y: 0 };
    const cached = absPosCache.get(cellId);
    if (cached) return cached;
    let x = 0, y = 0;
    let curId = cellId;
    const seen = new Set();
    while (curId && !seen.has(curId)) {
      seen.add(curId);
      const cell = cellById.get(curId);
      if (!cell) break;
      if (cell.geo && !cell.geo.relative) {
        x = clamp(x + cell.geo.x, -MAX_COORD, MAX_COORD);
        y = clamp(y + cell.geo.y, -MAX_COORD, MAX_COORD);
      }
      curId = cell.parent;
    }
    const pos = { x, y };
    absPosCache.set(cellId, pos);
    return pos;
  }

  // Separate edge-label child cells (vertex with relative geometry whose parent is an edge).
  /** @type {Map<string, RawCell>} */
  const edgeLabelsByParent = new Map();
  for (const cell of rawCells) {
    if (!cell.vertex || !cell.parent) continue;
    const parentCell = cellById.get(cell.parent);
    if (parentCell?.edge && (cell.style.tokens.has("edgelabel") || cell.geo?.relative)) {
      if (cell.value && !edgeLabelsByParent.has(cell.parent)) {
        edgeLabelsByParent.set(cell.parent, cell);
      }
    }
  }

  /** @type {any[]} */
  const elements = [];
  /** @type {Map<string, any>} */
  const shapeByCellId = new Map();
  let capped = false;

  const pushEl = el => {
    if (elements.length >= MAX_DRAWIO_ELEMENTS) {
      if (!capped) {
        warnings.push(`Draw.io diagram exceeded ${MAX_DRAWIO_ELEMENTS} elements; remaining elements were truncated`);
        capped = true;
      }
      return false;
    }
    elements.push(el);
    return true;
  };

  // Pass 1: Vertices (shapes, frames, standalone text).
  for (const cell of rawCells) {
    if (!cell.vertex) continue;
    // Skip edge-label child cells (handled in Pass 2 on their parent edge).
    if (cell.parent && edgeLabelsByParent.get(cell.parent) === cell) continue;
    if (capped) break;

    const geo = cell.geo;
    const parentOff = absOffsetOf(cell.parent);
    const x = clamp((geo ? geo.x : 0) + parentOff.x, -MAX_COORD, MAX_COORD);
    const y = clamp((geo ? geo.y : 0) + parentOff.y, -MAX_COORD, MAX_COORD);
    const width = geo && geo.width > 0 ? geo.width : 120;
    const height = geo && geo.height > 0 ? geo.height : 60;

    const { props } = cell.style;
    const type = mapVertexType(cell.style);
    const opacity = parseFinite(props.opacity, 100, 0, 100);
    const rotationDeg = parseFinite(props.rotation, 0, -3600, 3600);
    const angle = rotationDeg ? normAngle((rotationDeg * Math.PI) / 180) : 0;
    const strokeStyle = mapStrokeStyle(props);
    const fontSize = parseFinite(props.fontSize, type === "text" ? 16 : 16, 8, 120);
    const fontColor = sanitizeColor(props.fontColor, DEFAULT_STROKE);
    const textAlign = props.align === "left" || props.align === "right" ? props.align : (type === "text" ? "left" : "center");
    const verticalAlign = props.verticalAlign === "top" || props.verticalAlign === "bottom" ? props.verticalAlign : "middle";

    if (type === "text") {
      const text = cell.value;
      const sz = textSize(text || " ", fontSize, 1.25, 2);
      const textEl = makeElement("text", {
        id: newId(),
        x,
        y,
        width: Math.max(1, Math.min(MAX_DIM, geo?.width > 0 ? geo.width : Math.ceil(sz.w))),
        height: Math.max(1, Math.min(MAX_DIM, geo?.height > 0 ? geo.height : Math.ceil(sz.h))),
        angle,
        text,
        originalText: text,
        fontSize,
        fontFamily: 2,
        textAlign,
        verticalAlign: props.verticalAlign === "middle" || props.verticalAlign === "bottom" ? props.verticalAlign : "top",
        strokeColor: fontColor,
        opacity,
        updated: now,
        link: cell.link,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(textEl)) shapeByCellId.set(cell.id, textEl);
      continue;
    }

    if (type === "frame") {
      const strokeColor = sanitizeColor(props.strokeColor, "#868e96");
      const backgroundColor = sanitizeColor(props.fillColor, "transparent");
      const strokeWidth = parseFinite(props.strokeWidth, 1, 0.5, 40);
      const frameEl = makeElement("frame", {
        id: newId(),
        x,
        y,
        width,
        height,
        angle,
        name: cell.value ? cell.value.slice(0, 200) : null,
        strokeColor,
        backgroundColor,
        strokeWidth,
        strokeStyle,
        roughness: 0,
        opacity,
        updated: now,
        link: cell.link,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(frameEl)) shapeByCellId.set(cell.id, frameEl);
      continue;
    }

    // Standard shapes: rectangle, ellipse, diamond
    const strokeColor = sanitizeColor(props.strokeColor, DEFAULT_STROKE);
    const backgroundColor = sanitizeColor(props.fillColor, "transparent");
    const strokeWidth = parseFinite(props.strokeWidth, 2, 0.5, 40);
    const rounded = props.rounded === "1" || props.rounded === "true";

    const shapeEl = makeElement(type, {
      id: newId(),
      x,
      y,
      width,
      height,
      angle,
      strokeColor,
      backgroundColor,
      fillStyle: "solid",
      strokeWidth,
      strokeStyle,
      roughness: 0,
      opacity,
      roundness: type === "rectangle" && rounded ? { type: 3 } : null,
      updated: now,
      link: cell.link,
      customData: { layer: BASE_LAYER, z: 0 },
    });

    if (!pushEl(shapeEl)) break;
    shapeByCellId.set(cell.id, shapeEl);

    if (cell.value) {
      const sz = textSize(cell.value, fontSize, 1.25, 2);
      const lw = Math.max(1, Math.min(Math.max(1, width - 16), Math.ceil(sz.w)));
      const lh = Math.max(1, Math.ceil(sz.h));
      const labelEl = makeElement("text", {
        id: newId(),
        x: x + (width - lw) / 2,
        y: y + (height - lh) / 2,
        width: lw,
        height: lh,
        text: cell.value,
        originalText: cell.value,
        fontSize,
        fontFamily: 2,
        textAlign,
        verticalAlign,
        strokeColor: fontColor,
        opacity,
        containerId: shapeEl.id,
        updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(labelEl)) {
        attachBoundRef(shapeEl, { id: labelEl.id, type: "text" });
      }
    }
  }

  // Wire frameId for shapes whose parent is a mapped frame.
  for (const cell of rawCells) {
    if (!cell.vertex || !cell.parent) continue;
    const el = shapeByCellId.get(cell.id);
    const parentEl = shapeByCellId.get(cell.parent);
    if (el && parentEl && parentEl.type === "frame" && el.id !== parentEl.id) {
      el.frameId = parentEl.id;
    }
  }

  // Pass 2: Edges (arrows and lines).
  /** @type {{ edgeEl: any, labelEl: any | null }[]} */
  const edgesToSettle = [];

  for (const cell of rawCells) {
    if (!cell.edge) continue;
    if (capped) break;

    const { props } = cell.style;
    const startArrowhead = mapArrowhead(props.startArrow, null);
    const endArrowhead = mapArrowhead(props.endArrow, "arrow");
    const type = !startArrowhead && !endArrowhead ? "line" : "arrow";

    const strokeColor = sanitizeColor(props.strokeColor, DEFAULT_STROKE);
    const strokeWidth = parseFinite(props.strokeWidth, 2, 0.5, 40);
    const strokeStyle = mapStrokeStyle(props);
    const opacity = parseFinite(props.opacity, 100, 0, 100);
    const rounded = props.rounded === "1" || props.rounded === "true";

    const srcEl = cell.source ? shapeByCellId.get(cell.source) : null;
    const tgtEl = cell.target ? shapeByCellId.get(cell.target) : null;
    const srcBindable = srcEl && BINDABLE_TYPES.has(srcEl.type) ? srcEl : null;
    const tgtBindable = tgtEl && BINDABLE_TYPES.has(tgtEl.type) ? tgtEl : null;

    const parentOff = absOffsetOf(cell.parent);
    const geo = cell.geo;

    /** @type {(el: any) => [number, number]} */
    const centerOf = el => [el.x + el.width / 2, el.y + el.height / 2];

    /** @type {[number, number]} */
    const startPt = geo?.sourcePoint
      ? [clamp(geo.sourcePoint[0] + parentOff.x, -MAX_COORD, MAX_COORD), clamp(geo.sourcePoint[1] + parentOff.y, -MAX_COORD, MAX_COORD)]
      : srcEl ? centerOf(srcEl) : [0, 0];

    /** @type {[number, number]} */
    const endPt = geo?.targetPoint
      ? [clamp(geo.targetPoint[0] + parentOff.x, -MAX_COORD, MAX_COORD), clamp(geo.targetPoint[1] + parentOff.y, -MAX_COORD, MAX_COORD)]
      : tgtEl ? centerOf(tgtEl) : [startPt[0] + 100, startPt[1]];

    /** @type {[number, number][]} */
    const waypoints = (geo?.waypoints ?? []).map(([wx, wy]) => [
      clamp(wx + parentOff.x, -MAX_COORD, MAX_COORD),
      clamp(wy + parentOff.y, -MAX_COORD, MAX_COORD),
    ]);

    const absPts = [startPt, ...waypoints, endPt];
    const origin = absPts[0];
    const relPts = absPts.map(([px, py]) => [px - origin[0], py - origin[1]]);

    let startBinding = null;
    if (srcBindable) {
      startBinding = { elementId: srcBindable.id, focus: 0, gap: 6 };
      if (props.exitX != null && props.exitY != null) {
        const fx = parseFinite(props.exitX, NaN, 0, 1);
        const fy = parseFinite(props.exitY, NaN, 0, 1);
        if (Number.isFinite(fx) && Number.isFinite(fy)) startBinding.fixedPoint = [fx, fy];
      }
    }

    let endBinding = null;
    if (tgtBindable) {
      endBinding = { elementId: tgtBindable.id, focus: 0, gap: 6 };
      if (props.entryX != null && props.entryY != null) {
        const fx = parseFinite(props.entryX, NaN, 0, 1);
        const fy = parseFinite(props.entryY, NaN, 0, 1);
        if (Number.isFinite(fx) && Number.isFinite(fy)) endBinding.fixedPoint = [fx, fy];
      }
    }

    const edgeEl = makeElement(type, {
      id: newId(),
      x: origin[0],
      y: origin[1],
      points: relPts,
      strokeColor,
      strokeWidth,
      strokeStyle,
      roughness: 0,
      opacity,
      roundness: rounded && waypoints.length > 0 ? { type: 2 } : null,
      startBinding,
      endBinding,
      startArrowhead,
      endArrowhead,
      updated: now,
      link: cell.link,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    normalize(edgeEl);

    if (!pushEl(edgeEl)) break;

    if (srcBindable) attachBoundRef(srcBindable, { id: edgeEl.id, type });
    if (tgtBindable) attachBoundRef(tgtBindable, { id: edgeEl.id, type });

    const edgeLabelChild = edgeLabelsByParent.get(cell.id);
    const labelText = cell.value || edgeLabelChild?.value || "";
    let labelEl = null;

    if (labelText) {
      const labelProps = edgeLabelChild ? edgeLabelChild.style.props : props;
      const fontSize = parseFinite(labelProps.fontSize, 14, 8, 120);
      const fontColor = sanitizeColor(labelProps.fontColor, strokeColor);
      const sz = textSize(labelText, fontSize, 1.25, 2);
      const mid = absPts[Math.floor(absPts.length / 2)];
      labelEl = makeElement("text", {
        id: newId(),
        x: mid[0] - sz.w / 2,
        y: mid[1] - sz.h / 2,
        width: Math.max(1, Math.ceil(sz.w)),
        height: Math.max(1, Math.ceil(sz.h)),
        text: labelText,
        originalText: labelText,
        fontSize,
        fontFamily: 2,
        textAlign: "center",
        verticalAlign: "middle",
        strokeColor: fontColor,
        opacity,
        containerId: edgeEl.id,
        updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(labelEl)) {
        attachBoundRef(edgeEl, { id: labelEl.id, type: "text" });
      } else {
        labelEl = null;
      }
    }

    edgesToSettle.push({ edgeEl, labelEl });
  }

  // Assign deterministic paint order (frames first, then shapes, then edges, then labels).
  elements.forEach((el, idx) => {
    el.customData = { layer: BASE_LAYER, z: idx + 1 };
  });

  // Settle bound edges against a Doc so endpoints sit cleanly on shape perimeters.
  if (edgesToSettle.length > 0) {
    const doc = new Doc({ elements, appState: {}, files: {} });
    for (const { edgeEl, labelEl } of edgesToSettle) {
      if (edgeEl.startBinding || edgeEl.endBinding) {
        settle(doc, edgeEl);
      }
      if (labelEl) {
        const anchor = labelAnchor(doc, edgeEl);
        if (anchor) {
          labelEl.x = anchor[0] - labelEl.width / 2;
          labelEl.y = anchor[1] - labelEl.height / 2;
        }
      }
    }
  }

  return {
    ok: true,
    elements,
    files: {},
    warnings,
    pageName,
  };
}

/**
 * Partition imported elements into Protocol v1.1-safe op batches whose serialized `{ elements }`
 * UTF-8 JSON size stays under `maxBytes` (default 900 KB, safely below `MAX_OP_BYTES = 1_000_000`).
 * @param {any[]} elements
 * @param {{ maxBytes?: number }} [opts]
 * @returns {any[][]}
 */
export function chunkDrawioOps(elements, { maxBytes = MAX_DRAWIO_OP_BYTES } = {}) {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const limit = Math.max(4096, Math.min(990_000, Number.isFinite(maxBytes) ? maxBytes : MAX_DRAWIO_OP_BYTES));
  const WRAPPER_OVERHEAD = 16; // `{"elements":[]}`
  /** @type {any[][]} */
  const batches = [];
  /** @type {any[]} */
  let cur = [];
  let curBytes = WRAPPER_OVERHEAD;

  for (const el of elements) {
    const elBytes = utf8Bytes(JSON.stringify(el)) + 1; // +1 for comma separator
    if (cur.length > 0 && curBytes + elBytes > limit) {
      batches.push(cur);
      cur = [];
      curBytes = WRAPPER_OVERHEAD;
    }
    cur.push(el);
    curBytes += elBytes;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}
