// @ts-check
// External diagram importers with explicit unsupported-feature reporting (Issue #21):
//   - Microsoft Visio (.vsdx ZIP Uint8Array/ArrayBuffer or extracted Visio XML)
//   - Miro (board JSON & CSV sticky/table exports)
//   - Lucidchart (JSON & CSV diagram exports)
//
// Strictly pure: zero Node, Bun, DOM, or bare package imports.
// Runs identically in Bun, browsers, and QuickJS.

import {
  DEFAULT_STROKE, BASE_LAYER, makeElement, newId, randomInt, textSize, utf8Bytes,
} from "./model.js";
import { Doc } from "./doc.js";
import { normalize, normAngle, settle, labelAnchor, edgePoint } from "./geometry.js";
import { reconcileBoundElements } from "./excalidraw.js";
import { layoutGraph } from "./mermaid.js";

export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
export const MAX_IMPORT_ELEMENTS = 5_000;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_XML_DEPTH = 128;
const MAX_XML_NODES = 100_000;
const MAX_COORD = 1e7;
const MAX_DIM = 1e6;
const MAX_LABEL_CHARS = 10_000;

const FORBIDDEN_DECL_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i;
const NAMED_COLORS = new Set([
  "transparent", "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
  "pink", "brown", "gray", "grey", "cyan", "magenta", "silver", "maroon", "olive", "lime",
  "aqua", "teal", "navy", "indigo", "violet", "gold", "coral", "crimson",
  "lightblue", "lightgreen", "lightgray", "lightgrey", "skyblue", "steelblue", "tomato",
]);
const BINDABLE_TYPES = new Set(["rectangle", "diamond", "ellipse", "frame"]);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** @param {unknown} v @returns {v is Record<string, any>} */
const isPlainObj = v => v != null && typeof v === "object" && !Array.isArray(v);

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

function cleanHtmlText(raw) {
  if (typeof raw !== "string" || !raw) return "";
  let s = raw;
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:div|p|li|tr|h[1-6])\s*>\s*<(?:div|p|li|tr|h[1-6])\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(?:div|p|li|tr|h[1-6])\s*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS) : s;
}

function attachBound(host, id, type) {
  if (!Array.isArray(host.boundElements)) host.boundElements = [];
  if (!host.boundElements.some(b => b.id === id && b.type === type)) {
    host.boundElements.push({ id, type });
  }
}

/**
 * Tracks unsupported features so importers never silently drop constructs.
 */
function createUnsupportedTracker() {
  /** @type {Map<string, { feature: string, count: number, reason: string }>} */
  const map = new Map();
  return {
    record(feature, reason, delta = 1) {
      if (!feature || delta <= 0) return;
      const prev = map.get(feature);
      if (prev) prev.count += delta;
      else map.set(feature, { feature, count: delta, reason });
    },
    list() {
      return [...map.values()];
    },
  };
}

// ── Pure UTF-8 decoder (zero TextDecoder dependency) ────────────────────────

function decodeUtf8(bytes) {
  const parts = [];
  let chunk = "";
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    const b0 = bytes[i];
    let cp;
    if (b0 < 0x80) {
      cp = b0;
    } else if ((b0 & 0xe0) === 0xc0 && i + 1 < n) {
      cp = ((b0 & 0x1f) << 6) | (bytes[++i] & 0x3f);
    } else if ((b0 & 0xf0) === 0xe0 && i + 2 < n) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
    } else if ((b0 & 0xf8) === 0xf0 && i + 3 < n) {
      cp = ((b0 & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
    } else {
      cp = 0xfffd;
    }
    if (cp <= 0xffff) {
      chunk += String.fromCharCode(cp);
    } else {
      cp -= 0x10000;
      chunk += String.fromCharCode(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
    }
    if (chunk.length >= 4096) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (chunk) parts.push(chunk);
  return parts.join("");
}

// ── Pure-JS RFC 1951 raw DEFLATE inflater (zero dependencies) ───────────────

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths) {
  let maxBits = 0;
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
  const counts = new Int32Array(maxBits + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) counts[lengths[i]]++;
  const offsets = new Int32Array(maxBits + 1);
  let total = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    offsets[bits] = total;
    total += counts[bits];
  }
  const symbols = new Int32Array(total);
  const nextOff = new Int32Array(offsets);
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym];
    if (l > 0) symbols[nextOff[l]++] = sym;
  }
  return { counts, symbols, maxBits };
}

function inflateRaw(src, maxOutBytes = MAX_ZIP_ENTRY_BYTES) {
  let bitPos = 0;
  const totalBits = src.length * 8;
  const readBits = n => {
    if (n === 0) return 0;
    if (bitPos + n > totalBits) throw new Error("Truncated DEFLATE stream");
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = bitPos >> 3;
      const bitIdx = bitPos & 7;
      val |= ((src[byteIdx] >> bitIdx) & 1) << i;
      bitPos++;
    }
    return val;
  };
  const decodeSym = tree => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= tree.maxBits; len++) {
      code |= readBits(1);
      const count = tree.counts[len];
      if (code - count < first) return tree.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("Invalid Huffman code in DEFLATE stream");
  };

  /** @type {number[]} */
  const out = [];
  let bfinal = 0;
  while (!bfinal) {
    bfinal = readBits(1);
    const btype = readBits(2);
    if (btype === 0) {
      // Stored block
      bitPos = (bitPos + 7) & ~7;
      const bytePos = bitPos >> 3;
      if (bytePos + 4 > src.length) throw new Error("Truncated stored DEFLATE block");
      const len = src[bytePos] | (src[bytePos + 1] << 8);
      const nlen = src[bytePos + 2] | (src[bytePos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error("Corrupt stored DEFLATE block length");
      const start = bytePos + 4;
      if (start + len > src.length) throw new Error("Truncated stored DEFLATE payload");
      if (out.length + len > maxOutBytes) throw new Error("ZIP entry exceeds uncompressed size limit");
      for (let i = 0; i < len; i++) out.push(src[start + i]);
      bitPos = (start + len) * 8;
    } else if (btype === 1 || btype === 2) {
      let litTree, distTree;
      if (btype === 1) {
        const litLen = new Int32Array(288);
        for (let i = 0; i <= 143; i++) litLen[i] = 8;
        for (let i = 144; i <= 255; i++) litLen[i] = 9;
        for (let i = 256; i <= 279; i++) litLen[i] = 7;
        for (let i = 280; i <= 287; i++) litLen[i] = 8;
        const distLen = new Int32Array(32);
        distLen.fill(5);
        litTree = buildHuffman(litLen);
        distTree = buildHuffman(distLen);
      } else {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const clLens = new Int32Array(19);
        for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = readBits(3);
        const clTree = buildHuffman(clLens);
        const allLens = new Int32Array(hlit + hdist);
        let idx = 0;
        while (idx < allLens.length) {
          const sym = decodeSym(clTree);
          if (sym < 16) {
            allLens[idx++] = sym;
          } else if (sym === 16) {
            const rep = readBits(2) + 3;
            const prev = idx > 0 ? allLens[idx - 1] : 0;
            for (let r = 0; r < rep && idx < allLens.length; r++) allLens[idx++] = prev;
          } else if (sym === 17) {
            const rep = readBits(3) + 3;
            for (let r = 0; r < rep && idx < allLens.length; r++) allLens[idx++] = 0;
          } else if (sym === 18) {
            const rep = readBits(7) + 11;
            for (let r = 0; r < rep && idx < allLens.length; r++) allLens[idx++] = 0;
          }
        }
        litTree = buildHuffman(allLens.subarray(0, hlit));
        distTree = buildHuffman(allLens.subarray(hlit));
      }

      for (;;) {
        const sym = decodeSym(litTree);
        if (sym < 256) {
          if (out.length + 1 > maxOutBytes) throw new Error("ZIP entry exceeds uncompressed size limit");
          out.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          if (lenIdx < 0 || lenIdx >= LEN_BASE.length) throw new Error("Invalid length symbol");
          const length = LEN_BASE[lenIdx] + readBits(LEN_EXTRA[lenIdx]);
          const distSym = decodeSym(distTree);
          if (distSym < 0 || distSym >= DIST_BASE.length) throw new Error("Invalid distance symbol");
          const dist = DIST_BASE[distSym] + readBits(DIST_EXTRA[distSym]);
          if (dist > out.length) throw new Error("Invalid back-reference distance");
          if (out.length + length > maxOutBytes) throw new Error("ZIP entry exceeds uncompressed size limit");
          for (let k = 0; k < length; k++) out.push(out[out.length - dist]);
        }
      }
    } else {
      throw new Error("Invalid DEFLATE block type");
    }
  }
  return new Uint8Array(out);
}

// ── Pure-JS ZIP reader (Stored + Deflate, Central Directory + Local Header) ──

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/**
 * Read a ZIP archive (`Uint8Array`) into a `Map<string, Uint8Array>`.
 * Supports compression method 0 (stored) and method 8 (DEFLATE).
 * @param {Uint8Array} bytes
 */
export function readZipEntries(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) {
    return { ok: false, error: "Invalid ZIP payload", entries: new Map() };
  }
  if (bytes.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: `ZIP exceeds maximum size of ${MAX_IMPORT_BYTES} bytes`, entries: new Map() };
  }

  /** @type {Map<string, Uint8Array>} */
  const entries = new Map();
  let totalOut = 0;

  // Locate End of Central Directory (EOCD) signature 0x06054b50 from the end.
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }

  const extractAtLocal = (lhOffset, name, method, compSize, uncompSize) => {
    if (lhOffset + 30 > bytes.length) throw new Error("Truncated ZIP local header");
    if (u32(bytes, lhOffset) !== 0x04034b50) throw new Error("Invalid ZIP local header signature");
    const fnLen = u16(bytes, lhOffset + 26);
    const exLen = u16(bytes, lhOffset + 28);
    const dataStart = lhOffset + 30 + fnLen + exLen;
    if (dataStart + compSize > bytes.length) throw new Error("Truncated ZIP entry data");
    if (uncompSize > MAX_ZIP_ENTRY_BYTES || totalOut + uncompSize > MAX_ZIP_TOTAL_BYTES) {
      throw new Error("ZIP archive exceeds uncompressed size limits");
    }
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = inflateRaw(raw, Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES - totalOut));
    } else {
      return; // Unsupported compression method skipped gracefully
    }
    totalOut += data.length;
    if (totalOut > MAX_ZIP_TOTAL_BYTES) throw new Error("ZIP archive exceeds total uncompressed limit");
    entries.set(name, data);
  };

  try {
    if (eocd >= 0) {
      const entryCount = u16(bytes, eocd + 10);
      if (entryCount > MAX_ZIP_ENTRIES) {
        return { ok: false, error: `ZIP exceeds maximum entry count (${MAX_ZIP_ENTRIES})`, entries };
      }
      const cdOffset = u32(bytes, eocd + 16);
      let pos = cdOffset;
      for (let i = 0; i < entryCount && pos + 46 <= bytes.length; i++) {
        if (u32(bytes, pos) !== 0x02014b50) break;
        const method = u16(bytes, pos + 10);
        const compSize = u32(bytes, pos + 20);
        const uncompSize = u32(bytes, pos + 24);
        const fnLen = u16(bytes, pos + 28);
        const exLen = u16(bytes, pos + 30);
        const cmtLen = u16(bytes, pos + 32);
        const lhOffset = u32(bytes, pos + 42);
        const name = decodeUtf8(bytes.subarray(pos + 46, pos + 46 + fnLen));
        pos += 46 + fnLen + exLen + cmtLen;
        if (!name || name.endsWith("/")) continue;
        extractAtLocal(lhOffset, name, method, compSize, uncompSize);
      }
    } else {
      // Fallback: walk sequential Local File Headers (e.g. minimal stored ZIP without EOCD).
      let pos = 0;
      let count = 0;
      while (pos + 30 <= bytes.length && u32(bytes, pos) === 0x04034b50) {
        count++;
        if (count > MAX_ZIP_ENTRIES) {
          return { ok: false, error: `ZIP exceeds maximum entry count (${MAX_ZIP_ENTRIES})`, entries };
        }
        const method = u16(bytes, pos + 8);
        const compSize = u32(bytes, pos + 18);
        const uncompSize = u32(bytes, pos + 22);
        const fnLen = u16(bytes, pos + 26);
        const exLen = u16(bytes, pos + 28);
        const name = decodeUtf8(bytes.subarray(pos + 30, pos + 30 + fnLen));
        if (name && !name.endsWith("/")) {
          extractAtLocal(pos, name, method, compSize, uncompSize);
        }
        pos += 30 + fnLen + exLen + compSize;
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), entries: new Map() };
  }

  return { ok: true, entries };
}

// ── Safe zero-dependency XML parser ─────────────────────────────────────────

function parseXmlAttrs(src, start, end) {
  /** @type {Record<string, string>} */
  const attrs = Object.create(null);
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(src[i])) i++;
    if (i >= end) break;
    const ns = i;
    while (i < end && !/[\s=/>]/.test(src[i])) i++;
    const name = src.slice(ns, i);
    if (!name) { i++; continue; }
    while (i < end && /\s/.test(src[i])) i++;
    if (i < end && src[i] === "=") {
      i++;
      while (i < end && /\s/.test(src[i])) i++;
      let val = "";
      if (i < end && (src[i] === "\"" || src[i] === "'")) {
        const q = src[i++];
        const vs = i;
        while (i < end && src[i] !== q) i++;
        val = decodeEntities(src.slice(vs, i));
        if (i < end && src[i] === q) i++;
      } else {
        const vs = i;
        while (i < end && !/[\s/>]/.test(src[i])) i++;
        val = decodeEntities(src.slice(vs, i));
      }
      if (!FORBIDDEN_KEYS.has(name)) attrs[name] = val;
    } else if (!FORBIDDEN_KEYS.has(name)) {
      attrs[name] = "";
    }
  }
  return attrs;
}

function findTagEnd(src, start) {
  let quote = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseXml(src) {
  const root = { tag: "#root", attrs: Object.create(null), children: [], text: "" };
  const stack = [root];
  let i = 0, nodeCount = 0;
  const len = src.length;

  while (i < len) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (i < len) stack[stack.length - 1].text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) return { ok: false, error: "Unclosed XML comment" };
      i = end + 3; continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) return { ok: false, error: "Unclosed CDATA section" };
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3; continue;
    }
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) return { ok: false, error: "Unclosed processing instruction" };
      i = end + 2; continue;
    }
    if (src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt + 2);
      if (end < 0) return { ok: false, error: "Unclosed XML declaration" };
      i = end + 1; continue;
    }
    if (src.startsWith("</", lt)) {
      const gt = src.indexOf(">", lt + 2);
      if (gt < 0) return { ok: false, error: "Unclosed closing tag" };
      const closeTag = src.slice(lt + 2, gt).trim().replace(/^[^:]+:/, "");
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === closeTag) { stack.length = s; break; }
      }
      i = gt + 1; continue;
    }
    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) return { ok: false, error: "Unclosed XML tag" };
    let innerEnd = gt, selfClosing = false;
    if (innerEnd > lt + 1 && src[innerEnd - 1] === "/") { selfClosing = true; innerEnd--; }
    let p = lt + 1;
    while (p < innerEnd && /\s/.test(src[p])) p++;
    const ts = p;
    while (p < innerEnd && !/[\s/>]/.test(src[p])) p++;
    const rawTag = src.slice(ts, p);
    if (!rawTag) { i = gt + 1; continue; }
    const tag = rawTag.replace(/^[^:]+:/, ""); // strip XML namespace prefix

    nodeCount++;
    if (nodeCount > MAX_XML_NODES) return { ok: false, error: `XML exceeds maximum node limit (${MAX_XML_NODES})` };

    const attrs = parseXmlAttrs(src, p, innerEnd);
    const node = { tag, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) return { ok: false, error: `XML nesting exceeds maximum depth (${MAX_XML_DEPTH})` };
      stack.push(node);
    }
    i = gt + 1;
  }
  return { ok: true, root };
}

function collectText(node) {
  if (!node) return "";
  let s = node.text || "";
  for (const c of node.children) s += collectText(c);
  return s;
}

function findFirstTag(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  for (const c of node.children) {
    const f = findFirstTag(c, tag);
    if (f) return f;
  }
  return null;
}

// ── RFC 4180 CSV parser ─────────────────────────────────────────────────────

function parseCsv(src) {
  const text = String(src ?? "").replace(/^\uFEFF/, "");
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some(c => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c.trim() !== "")) rows.push(row);
  return rows;
}

// ── Shared element creation & settling ──────────────────────────────────────

function makeShapeWithLabel({
  type = "rectangle", x, y, width, height, text = "",
  strokeColor = DEFAULT_STROKE, backgroundColor = "transparent",
  strokeWidth = 2, strokeStyle = "solid", opacity = 100,
  angle = 0, roundness = null, fontSize = 16, fontColor = DEFAULT_STROKE,
  frameId = null, now = Date.now(), pushEl,
}) {
  const shape = makeElement(type, {
    id: newId(),
    x: clamp(x, -MAX_COORD, MAX_COORD),
    y: clamp(y, -MAX_COORD, MAX_COORD),
    width: clamp(Math.max(1, width), 1, MAX_DIM),
    height: clamp(Math.max(1, height), 1, MAX_DIM),
    angle: normAngle(angle),
    strokeColor, backgroundColor, fillStyle: "solid",
    strokeWidth, strokeStyle, roughness: 0, opacity, roundness,
    frameId,
    version: 0, versionNonce: randomInt(), updated: now,
    customData: { layer: BASE_LAYER, z: 0 },
  });
  if (!pushEl(shape)) return null;
  const clean = cleanHtmlText(text);
  if (clean && type !== "frame") {
    const sz = textSize(clean, fontSize, 1.25, 2);
    const lw = Math.max(1, Math.min(Math.max(1, shape.width - 12), Math.ceil(sz.w)));
    const lh = Math.max(1, Math.ceil(sz.h));
    const lbl = makeElement("text", {
      id: newId(),
      x: shape.x + (shape.width - lw) / 2,
      y: shape.y + (shape.height - lh) / 2,
      width: lw, height: lh,
      text: clean, originalText: clean,
      fontSize, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
      strokeColor: fontColor, opacity,
      containerId: shape.id, frameId,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    if (pushEl(lbl)) attachBound(shape, lbl.id, "text");
  }
  return shape;
}

function finalizeElements(elements, edgesToSettle) {
  elements.forEach((el, idx) => {
    el.customData = { ...(el.customData ?? {}), layer: BASE_LAYER, z: idx + 1 };
  });
  reconcileBoundElements(elements);
  if (edgesToSettle.length > 0) {
    const doc = new Doc({ elements, appState: {}, files: {} });
    for (const { edgeEl, labelEl } of edgesToSettle) {
      if (edgeEl.startBinding || edgeEl.endBinding) settle(doc, edgeEl);
      if (labelEl) {
        const anchor = labelAnchor(doc, edgeEl);
        if (anchor) {
          labelEl.x = anchor[0] - labelEl.width / 2;
          labelEl.y = anchor[1] - labelEl.height / 2;
        }
      }
    }
  }
}

// ── 1. Visio (.vsdx / Visio XML) importer ───────────────────────────────────

const VISIO_PX_PER_INCH = 96;

/**
 * Fast check for whether input is a Visio `.vsdx` ZIP or Visio XML string.
 * @param {unknown} input
 * @returns {boolean}
 */
export function isVisio(input) {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  }
  if (typeof input === "string") {
    const head = input.slice(0, 4096).replace(/^\uFEFF/, "").trimStart();
    return head.startsWith("<") && /<(?:PageContents|VisioDocument)\b/.test(head);
  }
  return false;
}

function mapVisioShapeType(nameU, typeAttr) {
  const n = (nameU || "").toLowerCase();
  if (typeAttr === "Group" || n.includes("container") || n.includes("swimlane") || n.includes("frame")) return "frame";
  if (n.includes("decision") || n.includes("diamond") || n.includes("rhombus")) return "diamond";
  if (n.includes("ellipse") || n.includes("circle") || n.includes("oval") || n.includes("start/end") || n.includes("terminator")) return "ellipse";
  return "rectangle";
}

function mapVisioArrow(val, fallback) {
  if (val == null || val === "") return fallback;
  const n = Number(val);
  if (n === 0) return null;
  if (n === 10 || n === 20) return "dot";
  if (n === 11 || n === 22) return "diamond";
  if (n > 0) return "arrow";
  return fallback;
}

/**
 * Parse a Visio `.vsdx` (`Uint8Array` / `ArrayBuffer`) or extracted Visio XML string.
 * @param {unknown} input
 * @param {{ now?: number }} [opts]
 */
export function parseVisio(input, { now = Date.now() } = {}) {
  /** @type {string[]} */
  const warnings = [];
  const unsup = createUnsupportedTracker();
  const fail = error => ({
    ok: false, format: "visio", elements: [], warnings, unsupported: unsup.list(), error,
  });

  /** @type {string | null} */
  let pageXml = null;

  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const zip = readZipEntries(bytes);
    if (!zip.ok) return fail(zip.error);

    const pageKeys = [...zip.entries.keys()]
      .filter(k => /^visio\/pages\/page\d+\.xml$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (!pageKeys.length) {
      return fail("No visio/pages/page*.xml found in .vsdx archive");
    }
    if (pageKeys.length > 1) {
      warnings.push(`Visio archive has ${pageKeys.length} pages; importing ${pageKeys[0]}`);
      unsup.record("visio:multi-page", "Additional Visio pages beyond page 1 are not imported into a single board", pageKeys.length - 1);
    }

    // Track unsupported auxiliary archive parts (media, comments, layers/masters).
    for (const key of zip.entries.keys()) {
      if (/^visio\/media\//i.test(key)) {
        unsup.record("visio:embedded-media", "Embedded Visio media assets are not imported");
      } else if (/^visio\/comments\.xml$/i.test(key)) {
        unsup.record("visio:comments", "Visio document comments are not imported");
      }
    }

    pageXml = decodeUtf8(zip.entries.get(pageKeys[0]));
  } else if (typeof input === "string") {
    pageXml = input;
  } else {
    return fail("Visio input must be a .vsdx Uint8Array/ArrayBuffer or Visio XML string");
  }

  const trimmed = pageXml.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return fail("Visio XML is empty");
  if (utf8Bytes(trimmed) > MAX_IMPORT_BYTES) return fail(`Visio XML exceeds maximum size of ${MAX_IMPORT_BYTES} bytes`);
  if (FORBIDDEN_DECL_RE.test(trimmed)) return fail("Visio XML with DOCTYPE or ENTITY declarations is not permitted");

  const parsed = parseXml(trimmed);
  if (!parsed.ok) return fail(parsed.error);

  const pageContents = findFirstTag(parsed.root, "PageContents") || findFirstTag(parsed.root, "VisioDocument");
  if (!pageContents) return fail("No <PageContents> element found in Visio XML");

  // Check page-level unsupported sections (Layers, Comments).
  const pageSheet = pageContents.children.find(c => c.tag === "PageSheet");
  let pageHeightIn = 11;
  if (pageSheet) {
    for (const c of pageSheet.children) {
      if (c.tag === "Cell" && c.attrs.N === "PageHeight") {
        pageHeightIn = parseFinite(c.attrs.V, 11, 1, 1000);
      } else if (c.tag === "Section" && c.attrs.N === "Layer") {
        const layerRows = c.children.filter(r => r.tag === "Row").length;
        if (layerRows > 0) unsup.record("visio:layers", "Visio layer definitions are flattened onto base layer", layerRows);
      }
    }
  }
  const commentsNode = findFirstTag(pageContents, "Comments");
  if (commentsNode) {
    const cnt = Math.max(1, commentsNode.children.length);
    unsup.record("visio:comments", "Visio comments are not imported", cnt);
  }

  const shapesNode = findFirstTag(pageContents, "Shapes");
  const connectsNode = findFirstTag(pageContents, "Connects");

  /** @type {Map<string, { beginTo?: string, endTo?: string }>} */
  const connMap = new Map();
  if (connectsNode) {
    for (const c of connectsNode.children) {
      if (c.tag !== "Connect") continue;
      const fromSheet = (c.attrs.FromSheet || "").trim();
      const toSheet = (c.attrs.ToSheet || "").trim();
      const fromCell = (c.attrs.FromCell || "").trim();
      if (!fromSheet || !toSheet) continue;
      let rec = connMap.get(fromSheet);
      if (!rec) { rec = {}; connMap.set(fromSheet, rec); }
      if (fromCell === "BeginX" || fromCell === "BeginY") rec.beginTo = toSheet;
      else if (fromCell === "EndX" || fromCell === "EndY") rec.endTo = toSheet;
    }
  }

  /** @type {any[]} */
  const rawShapes = [];
  /** @type {any[]} */
  const rawConnectors = [];

  const collectShapes = (container, parentFrameVisioId = null) => {
    if (!container) return;
    for (const s of container.children) {
      if (s.tag !== "Shape") continue;
      const id = (s.attrs.ID || "").trim();
      const nameU = s.attrs.NameU || s.attrs.Name || "";
      const typeAttr = s.attrs.Type || "";
      const cells = Object.create(null);
      let hasFormulaOnly = false;
      for (const ch of s.children) {
        if (ch.tag === "Cell" && ch.attrs.N) {
          if (ch.attrs.V !== undefined && ch.attrs.V !== "") {
            cells[ch.attrs.N] = ch.attrs.V;
          } else if (ch.attrs.F) {
            hasFormulaOnly = true;
          }
        } else if (ch.tag === "ForeignData") {
          unsup.record("visio:foreign-data", "Embedded ForeignData/OLE objects are not imported");
        } else if (ch.tag === "Section" && ch.attrs.N === "LayerMem") {
          unsup.record("visio:layer-membership", "Visio shape layer memberships are flattened onto base layer");
        }
      }
      if (hasFormulaOnly) {
        unsup.record("visio:formula", "Visio ShapeSheet formulas without cached V values cannot be evaluated");
      }
      if (cells.FillPattern && Number(cells.FillPattern) > 1) {
        unsup.record("visio:fill-pattern", "Visio gradient/hatch fill patterns are simplified to solid fills");
      }
      if (cells.ShdwPattern && Number(cells.ShdwPattern) > 0) {
        unsup.record("visio:shadow", "Visio shape shadows are not supported");
      }

      const textNode = s.children.find(c => c.tag === "Text");
      const text = textNode ? cleanHtmlText(collectText(textNode)) : "";

      const isConnector =
        (cells.BeginX !== undefined && cells.EndX !== undefined) ||
        connMap.has(id) ||
        /connector/i.test(nameU);

      if (isConnector) {
        rawConnectors.push({ id, nameU, cells, text });
      } else {
        rawShapes.push({ id, nameU, typeAttr, cells, text, parentFrameVisioId });
        const subShapes = s.children.find(c => c.tag === "Shapes");
        if (subShapes) collectShapes(subShapes, id);
      }
    }
  };
  collectShapes(shapesNode, null);

  /** @type {any[]} */
  const elements = [];
  let capped = false;
  const pushEl = el => {
    if (elements.length >= MAX_IMPORT_ELEMENTS) {
      if (!capped) {
        warnings.push(`Visio diagram exceeded ${MAX_IMPORT_ELEMENTS} elements; remaining elements were truncated`);
        capped = true;
      }
      return false;
    }
    elements.push(el);
    return true;
  };

  const toSceneY = visioInchY => (pageHeightIn - visioInchY) * VISIO_PX_PER_INCH;
  const shapeByVisioId = new Map();

  for (const s of rawShapes) {
    if (capped) break;
    if (s.typeAttr === "Foreign") {
      unsup.record("visio:foreign-shape", "Visio Foreign image/OLE shapes are not imported");
      continue;
    }
    const w = parseFinite(s.cells.Width, 1.5, 0.05, 500) * VISIO_PX_PER_INCH;
    const h = parseFinite(s.cells.Height, 0.75, 0.05, 500) * VISIO_PX_PER_INCH;
    const pinX = parseFinite(s.cells.PinX, 2, -500, 500) * VISIO_PX_PER_INCH;
    const pinY = toSceneY(parseFinite(s.cells.PinY, pageHeightIn / 2, -500, 500));
    const x = pinX - w / 2;
    const y = pinY - h / 2;
    const type = mapVisioShapeType(s.nameU, s.typeAttr);
    const angle = -parseFinite(s.cells.Angle, 0, -100, 100);
    const fill = sanitizeColor(s.cells.FillForegnd, "transparent");
    const stroke = sanitizeColor(s.cells.LineColor, type === "frame" ? "#868e96" : DEFAULT_STROKE);
    const lineWeightIn = parseFinite(s.cells.LineWeight, 0.02, 0.005, 1);
    const strokeWidth = clamp(Math.round(lineWeightIn * VISIO_PX_PER_INCH * 10) / 10, 1, 20);
    const strokeStyle = Number(s.cells.LinePattern) === 2 ? "dashed" : Number(s.cells.LinePattern) === 3 ? "dotted" : "solid";
    const rounding = parseFinite(s.cells.Rounding, 0, 0, 10);
    const parentFrame = s.parentFrameVisioId ? shapeByVisioId.get(s.parentFrameVisioId) : null;
    const frameId = parentFrame?.type === "frame" ? parentFrame.id : null;

    if (type === "frame") {
      const frame = makeElement("frame", {
        id: newId(),
        x, y, width: w, height: h, angle: normAngle(angle),
        name: s.text ? s.text.slice(0, 200) : (s.nameU || null),
        strokeColor: stroke, backgroundColor: fill, strokeWidth: 1, strokeStyle,
        roughness: 0, frameId,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(frame)) shapeByVisioId.set(s.id, frame);
    } else {
      const el = makeShapeWithLabel({
        type, x, y, width: w, height: h, text: s.text,
        strokeColor: stroke, backgroundColor: fill,
        strokeWidth, strokeStyle, angle,
        roundness: type === "rectangle" && rounding > 0 ? { type: 3 } : null,
        frameId, now, pushEl,
      });
      if (el) shapeByVisioId.set(s.id, el);
    }
  }

  /** @type {{ edgeEl: any, labelEl: any | null }[]} */
  const edgesToSettle = [];

  for (const c of rawConnectors) {
    if (capped) break;
    const conn = connMap.get(c.id) || {};
    const srcEl = conn.beginTo ? shapeByVisioId.get(conn.beginTo) : null;
    const tgtEl = conn.endTo ? shapeByVisioId.get(conn.endTo) : null;
    const srcBind = srcEl && BINDABLE_TYPES.has(srcEl.type) ? srcEl : null;
    const tgtBind = tgtEl && BINDABLE_TYPES.has(tgtEl.type) ? tgtEl : null;

    const bx = c.cells.BeginX !== undefined
      ? parseFinite(c.cells.BeginX, 0, -500, 500) * VISIO_PX_PER_INCH
      : (srcEl ? srcEl.x + srcEl.width / 2 : 0);
    const by = c.cells.BeginY !== undefined
      ? toSceneY(parseFinite(c.cells.BeginY, 0, -500, 500))
      : (srcEl ? srcEl.y + srcEl.height / 2 : 0);
    const ex = c.cells.EndX !== undefined
      ? parseFinite(c.cells.EndX, 1, -500, 500) * VISIO_PX_PER_INCH
      : (tgtEl ? tgtEl.x + tgtEl.width / 2 : bx + 100);
    const ey = c.cells.EndY !== undefined
      ? toSceneY(parseFinite(c.cells.EndY, 0, -500, 500))
      : (tgtEl ? tgtEl.y + tgtEl.height / 2 : by);

    const startArrowhead = mapVisioArrow(c.cells.BeginArrow, null);
    const endArrowhead = mapVisioArrow(c.cells.EndArrow, "arrow");
    const type = !startArrowhead && !endArrowhead ? "line" : "arrow";
    const stroke = sanitizeColor(c.cells.LineColor, DEFAULT_STROKE);
    const strokeStyle = Number(c.cells.LinePattern) === 2 ? "dashed" : Number(c.cells.LinePattern) === 3 ? "dotted" : "solid";

    const edgeEl = makeElement(type, {
      id: newId(),
      x: bx, y: by,
      points: [[0, 0], [ex - bx, ey - by]],
      strokeColor: stroke, strokeWidth: 2, strokeStyle, roughness: 0,
      startBinding: srcBind ? { elementId: srcBind.id, focus: 0, gap: 6 } : null,
      endBinding: tgtBind ? { elementId: tgtBind.id, focus: 0, gap: 6 } : null,
      startArrowhead, endArrowhead,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    normalize(edgeEl);
    if (!pushEl(edgeEl)) break;
    if (srcBind) attachBound(srcBind, edgeEl.id, type);
    if (tgtBind) attachBound(tgtBind, edgeEl.id, type);

    let labelEl = null;
    if (c.text) {
      const sz = textSize(c.text, 14, 1.25, 2);
      labelEl = makeElement("text", {
        id: newId(),
        x: (bx + ex) / 2 - sz.w / 2,
        y: (by + ey) / 2 - sz.h / 2,
        width: Math.max(1, Math.ceil(sz.w)),
        height: Math.max(1, Math.ceil(sz.h)),
        text: c.text, originalText: c.text,
        fontSize: 14, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
        strokeColor: stroke, containerId: edgeEl.id,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(labelEl)) attachBound(edgeEl, labelEl.id, "text");
      else labelEl = null;
    }
    edgesToSettle.push({ edgeEl, labelEl });
  }

  finalizeElements(elements, edgesToSettle);
  return { ok: true, format: "visio", elements, warnings, unsupported: unsup.list() };
}

// ── 2. Miro importer (JSON + CSV) ───────────────────────────────────────────

const MIRO_STICKY_COLORS = {
  light_yellow: "#fff3bf", yellow: "#ffec99", orange: "#ffd8a8",
  light_green: "#b2f2bb", green: "#8ce99a", dark_green: "#69db7c",
  cyan: "#99e9f2", light_pink: "#fcc2d7", pink: "#faa2c1",
  violet: "#d0bfff", red: "#ffc9c9", light_blue: "#a5d8ff",
  blue: "#74c0fc", dark_blue: "#4dabf7", gray: "#e9ecef", black: "#343a40",
};

const MIRO_SUPPORTED_TYPES = new Set(["sticky_note", "shape", "text", "connector", "frame"]);

function mapMiroShape(shapeName) {
  const s = String(shapeName ?? "rectangle").toLowerCase();
  if (s === "circle" || s === "oval" || s === "ellipse" || s === "pill") return { type: "ellipse", rounded: false };
  if (s === "rhombus" || s === "diamond") return { type: "diamond", rounded: false };
  if (s === "round_rectangle" || s === "rounded_rectangle") return { type: "rectangle", rounded: true };
  return { type: "rectangle", rounded: false };
}

function mapMiroCap(cap, fallback) {
  if (cap == null || cap === "") return fallback;
  const c = String(cap).toLowerCase();
  if (c === "none") return null;
  if (c === "diamond" || c === "filled_diamond") return "diamond";
  if (c === "oval" || c === "filled_oval" || c === "dot") return "dot";
  if (c === "triangle" || c === "filled_triangle") return "triangle";
  return "arrow";
}

/**
 * Detect whether input looks like a Miro JSON or CSV export.
 * @param {unknown} input
 * @returns {boolean}
 */
export function isMiro(input) {
  let data = input;
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return false;
    if (t.startsWith("{") || t.startsWith("[")) {
      try { data = JSON.parse(t); } catch { return false; }
    } else {
      // Miro CSV check: header with Sticky / Content / Color (and not Lucidchart's Shape Library)
      const firstLine = t.split(/\r?\n/, 1)[0].toLowerCase();
      return firstLine.includes(",") && !firstLine.includes("shape library") &&
        (firstLine.includes("sticky") || (firstLine.includes("content") && firstLine.includes("color")));
    }
  }
  const items = Array.isArray(data) ? data : (isPlainObj(data) ? (data.items || data.widgets || data.data) : null);
  if (!Array.isArray(items) || !items.length) return false;
  return items.some(it => isPlainObj(it) && (
    it.type === "sticky_note" || it.type === "app_card" || it.type === "mindmap_node" ||
    (MIRO_SUPPORTED_TYPES.has(it.type) && (isPlainObj(it.geometry) || isPlainObj(it.position) || isPlainObj(it.data)))
  ));
}

/**
 * Parse a Miro board export (JSON object/string or CSV string).
 * @param {unknown} input
 * @param {{ now?: number }} [opts]
 */
export function parseMiro(input, { now = Date.now() } = {}) {
  /** @type {string[]} */
  const warnings = [];
  const unsup = createUnsupportedTracker();
  const fail = (error, format = "miro-json") => ({
    ok: false, format, elements: [], warnings, unsupported: unsup.list(), error,
  });

  if (typeof input === "string") {
    if (utf8Bytes(input) > MAX_IMPORT_BYTES) return fail(`Miro input exceeds maximum size of ${MAX_IMPORT_BYTES} bytes`);
    const trimmed = input.replace(/^\uFEFF/, "").trim();
    if (!trimmed) return fail("Miro input is empty");
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return parseMiroCsv(trimmed, { now });
    }
    try { input = JSON.parse(trimmed); }
    catch { return fail("Invalid Miro JSON"); }
  }

  let items = null;
  if (Array.isArray(input)) {
    items = input;
  } else if (isPlainObj(input)) {
    items = Array.isArray(input.items) ? input.items
      : Array.isArray(input.widgets) ? input.widgets
      : Array.isArray(input.data) ? input.data : null;
    if (Array.isArray(input.comments) && input.comments.length) {
      unsup.record("miro:comments", "Miro board comments are not imported", input.comments.length);
    }
    if (Array.isArray(input.layers) && input.layers.length) {
      unsup.record("miro:layers", "Miro layers are flattened onto base layer", input.layers.length);
    }
  }
  if (!Array.isArray(items)) return fail("Miro JSON must contain an items, widgets, or data array");

  /** @type {any[]} */
  const elements = [];
  let capped = false;
  const pushEl = el => {
    if (elements.length >= MAX_IMPORT_ELEMENTS) {
      if (!capped) {
        warnings.push(`Miro board exceeded ${MAX_IMPORT_ELEMENTS} elements; remaining elements were truncated`);
        capped = true;
      }
      return false;
    }
    elements.push(el);
    return true;
  };

  const elByMiroId = new Map();
  const connectors = [];
  const frames = [];
  const nonFrames = [];

  for (const item of items) {
    if (!isPlainObj(item)) continue;
    const t = String(item.type ?? "").toLowerCase();
    if (t === "connector") connectors.push(item);
    else if (t === "frame") frames.push(item);
    else if (t === "sticky_note" || t === "shape" || t === "text") nonFrames.push(item);
    else {
      unsup.record(`miro:${t || "unknown"}`, `Miro item type "${t || "unknown"}" is not supported`);
    }
  }

  // Pass 1: Frames first so children can reference frameId.
  for (const item of frames) {
    if (capped) break;
    const geo = isPlainObj(item.geometry) ? item.geometry : {};
    const pos = isPlainObj(item.position) ? item.position : {};
    const style = isPlainObj(item.style) ? item.style : {};
    const w = parseFinite(geo.width ?? item.width, 400, 20, MAX_DIM);
    const h = parseFinite(geo.height ?? item.height, 300, 20, MAX_DIM);
    // Miro positions are center-based by default.
    const cx = parseFinite(pos.x ?? item.x, w / 2);
    const cy = parseFinite(pos.y ?? item.y, h / 2);
    const title = cleanHtmlText(item.data?.title ?? item.title ?? "");
    const frame = makeElement("frame", {
      id: newId(),
      x: cx - w / 2, y: cy - h / 2, width: w, height: h,
      name: title ? title.slice(0, 200) : null,
      strokeColor: sanitizeColor(style.borderColor, "#868e96"),
      backgroundColor: sanitizeColor(style.fillColor, "transparent"),
      strokeWidth: 1, roughness: 0,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    if (pushEl(frame) && item.id != null) elByMiroId.set(String(item.id), frame);
  }

  // Pass 2: Sticky notes, shapes, standalone text.
  for (const item of nonFrames) {
    if (capped) break;
    const t = String(item.type).toLowerCase();
    const geo = isPlainObj(item.geometry) ? item.geometry : {};
    const pos = isPlainObj(item.position) ? item.position : {};
    const style = isPlainObj(item.style) ? item.style : {};
    const data = isPlainObj(item.data) ? item.data : {};

    if (style.shadow || style.gradient) {
      unsup.record("miro:custom-style", "Miro shadow/gradient styles are simplified");
    }
    if (Array.isArray(item.comments) && item.comments.length) {
      unsup.record("miro:comments", "Item comments are not imported", item.comments.length);
    }

    const parentId = item.parent?.id != null ? String(item.parent.id) : null;
    const parentFrame = parentId ? elByMiroId.get(parentId) : null;
    const frameId = parentFrame?.type === "frame" ? parentFrame.id : null;
    const parentOriginX = parentFrame && pos.origin === "center" ? parentFrame.x : 0;
    const parentOriginY = parentFrame && pos.origin === "center" ? parentFrame.y : 0;

    const w = parseFinite(geo.width ?? item.width, t === "sticky_note" ? 180 : 140, 10, MAX_DIM);
    const h = parseFinite(geo.height ?? item.height, t === "sticky_note" ? 180 : 80, 10, MAX_DIM);
    const cx = parseFinite(pos.x ?? item.x, 0) + parentOriginX;
    const cy = parseFinite(pos.y ?? item.y, 0) + parentOriginY;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const rotDeg = parseFinite(geo.rotation ?? item.rotation, 0, -3600, 3600);
    const angle = rotDeg ? (rotDeg * Math.PI) / 180 : 0;
    const text = cleanHtmlText(data.content ?? item.content ?? item.text ?? "");
    const fontSize = parseFinite(style.fontSize, 16, 8, 120);
    const fontColor = sanitizeColor(style.color, DEFAULT_STROKE);

    if (t === "text") {
      const sz = textSize(text || " ", fontSize, 1.25, 2);
      const txt = makeElement("text", {
        id: newId(),
        x, y,
        width: Math.max(1, Math.min(MAX_DIM, geo.width ? w : Math.ceil(sz.w))),
        height: Math.max(1, Math.min(MAX_DIM, geo.height ? h : Math.ceil(sz.h))),
        angle: normAngle(angle),
        text, originalText: text, fontSize, fontFamily: 2,
        textAlign: style.textAlign === "center" || style.textAlign === "right" ? style.textAlign : "left",
        verticalAlign: "top",
        strokeColor: fontColor, frameId,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(txt) && item.id != null) elByMiroId.set(String(item.id), txt);
      continue;
    }

    if (t === "sticky_note") {
      const fillKey = String(style.fillColor ?? "light_yellow").toLowerCase();
      const bg = MIRO_STICKY_COLORS[fillKey] ?? sanitizeColor(style.fillColor, "#fff3bf");
      const el = makeShapeWithLabel({
        type: "rectangle", x, y, width: w, height: h, text,
        strokeColor: "#e67700", backgroundColor: bg, strokeWidth: 1,
        angle, fontSize, fontColor, frameId, now, pushEl,
      });
      if (el && item.id != null) elByMiroId.set(String(item.id), el);
      continue;
    }

    // shape
    const mapped = mapMiroShape(data.shape ?? item.shape);
    const borderStyle = String(style.borderStyle ?? "normal").toLowerCase();
    const strokeStyle = borderStyle === "dashed" ? "dashed" : borderStyle === "dotted" ? "dotted" : "solid";
    const fillOpacity = parseFinite(style.fillOpacity, 1, 0, 1);
    const opacity = Math.round(fillOpacity * 100);
    const el = makeShapeWithLabel({
      type: mapped.type, x, y, width: w, height: h, text,
      strokeColor: sanitizeColor(style.borderColor, DEFAULT_STROKE),
      backgroundColor: sanitizeColor(style.fillColor, "transparent"),
      strokeWidth: parseFinite(style.borderWidth, 2, 0.5, 40),
      strokeStyle, opacity, angle,
      roundness: mapped.rounded ? { type: 3 } : null,
      fontSize, fontColor, frameId, now, pushEl,
    });
    if (el && item.id != null) elByMiroId.set(String(item.id), el);
  }

  // Pass 3: Connectors.
  /** @type {{ edgeEl: any, labelEl: any | null }[]} */
  const edgesToSettle = [];

  for (const conn of connectors) {
    if (capped) break;
    const style = isPlainObj(conn.style) ? conn.style : {};
    const startId = conn.startItem?.id != null ? String(conn.startItem.id) : null;
    const endId = conn.endItem?.id != null ? String(conn.endItem.id) : null;
    const srcEl = startId ? elByMiroId.get(startId) : null;
    const tgtEl = endId ? elByMiroId.get(endId) : null;
    const srcBind = srcEl && BINDABLE_TYPES.has(srcEl.type) ? srcEl : null;
    const tgtBind = tgtEl && BINDABLE_TYPES.has(tgtEl.type) ? tgtEl : null;

    const sp = srcEl ? [srcEl.x + srcEl.width / 2, srcEl.y + srcEl.height / 2] : [0, 0];
    const ep = tgtEl ? [tgtEl.x + tgtEl.width / 2, tgtEl.y + tgtEl.height / 2] : [sp[0] + 120, sp[1]];

    const startArrowhead = mapMiroCap(style.startStrokeCap, null);
    const endArrowhead = mapMiroCap(style.endStrokeCap, "arrow");
    const type = !startArrowhead && !endArrowhead ? "line" : "arrow";
    const strokeColor = sanitizeColor(style.strokeColor, DEFAULT_STROKE);
    const strokeStyle = style.strokeStyle === "dashed" ? "dashed" : style.strokeStyle === "dotted" ? "dotted" : "solid";

    const edgeEl = makeElement(type, {
      id: newId(),
      x: sp[0], y: sp[1],
      points: [[0, 0], [ep[0] - sp[0], ep[1] - sp[1]]],
      strokeColor,
      strokeWidth: parseFinite(style.strokeWidth, 2, 0.5, 40),
      strokeStyle, roughness: 0,
      startBinding: srcBind ? { elementId: srcBind.id, focus: 0, gap: 6 } : null,
      endBinding: tgtBind ? { elementId: tgtBind.id, focus: 0, gap: 6 } : null,
      startArrowhead, endArrowhead,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    normalize(edgeEl);
    if (!pushEl(edgeEl)) break;
    if (srcBind) attachBound(srcBind, edgeEl.id, type);
    if (tgtBind) attachBound(tgtBind, edgeEl.id, type);

    const captionText = Array.isArray(conn.captions) && conn.captions.length
      ? cleanHtmlText(conn.captions.map(c => c?.content ?? "").filter(Boolean).join(" "))
      : cleanHtmlText(conn.caption ?? "");
    let labelEl = null;
    if (captionText) {
      const sz = textSize(captionText, 14, 1.25, 2);
      labelEl = makeElement("text", {
        id: newId(),
        x: (sp[0] + ep[0]) / 2 - sz.w / 2,
        y: (sp[1] + ep[1]) / 2 - sz.h / 2,
        width: Math.max(1, Math.ceil(sz.w)),
        height: Math.max(1, Math.ceil(sz.h)),
        text: captionText, originalText: captionText,
        fontSize: 14, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
        strokeColor, containerId: edgeEl.id,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(labelEl)) attachBound(edgeEl, labelEl.id, "text");
      else labelEl = null;
    }
    edgesToSettle.push({ edgeEl, labelEl });
  }

  finalizeElements(elements, edgesToSettle);
  return { ok: true, format: "miro-json", elements, warnings, unsupported: unsup.list() };
}

function parseMiroCsv(csvText, { now = Date.now() } = {}) {
  const warnings = [];
  const unsup = createUnsupportedTracker();
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { ok: false, format: "miro-csv", elements: [], warnings, unsupported: unsup.list(), error: "Miro CSV has no data rows" };
  }

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => headers.findIndex(h => names.some(n => h === n || h.includes(n)));
  const textCol = col("content", "text", "sticky", "title", "note");
  const colorCol = col("color", "fill");
  const frameCol = col("frame", "group", "cluster");
  const typeCol = col("type");
  const xCol = col("x");
  const yCol = col("y");
  const commentCol = col("comment");
  const tagCol = col("tag");

  if (textCol < 0) {
    return { ok: false, format: "miro-csv", elements: [], warnings, unsupported: unsup.list(), error: "Miro CSV missing text/content column" };
  }

  /** @type {any[]} */
  const elements = [];
  let capped = false;
  const pushEl = el => {
    if (elements.length >= MAX_IMPORT_ELEMENTS) {
      if (!capped) { warnings.push(`Miro CSV exceeded ${MAX_IMPORT_ELEMENTS} elements`); capped = true; }
      return false;
    }
    elements.push(el);
    return true;
  };

  const CARD_W = 190, CARD_H = 140, GAP = 24, COLS = 4;
  const byFrame = new Map();
  const dataRows = rows.slice(1);

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    if (commentCol >= 0 && r[commentCol]?.trim()) {
      unsup.record("miro-csv:comments", "CSV comment column values are not imported");
    }
    if (tagCol >= 0 && r[tagCol]?.trim()) {
      unsup.record("miro-csv:tags", "CSV tag column values are not imported");
    }
    const rowType = typeCol >= 0 ? (r[typeCol] || "").trim().toLowerCase() : "sticky_note";
    if (rowType && rowType !== "sticky_note" && rowType !== "sticky" && rowType !== "shape" && rowType !== "text") {
      unsup.record(`miro-csv:${rowType}`, `Miro CSV item type "${rowType}" is not supported`);
      continue;
    }
    const fName = frameCol >= 0 ? (r[frameCol] || "").trim() : "";
    if (!byFrame.has(fName)) byFrame.set(fName, []);
    byFrame.get(fName).push(r);
  }

  let cursorY = 40;
  for (const [fName, groupRows] of byFrame) {
    if (capped) break;
    const rowsNeeded = Math.ceil(groupRows.length / COLS);
    const colsUsed = Math.min(COLS, groupRows.length);
    let frameEl = null;
    if (fName) {
      const fw = colsUsed * (CARD_W + GAP) + GAP;
      const fh = rowsNeeded * (CARD_H + GAP) + GAP + 24;
      frameEl = makeElement("frame", {
        id: newId(),
        x: 20, y: cursorY, width: fw, height: fh,
        name: fName.slice(0, 200),
        strokeColor: "#868e96", backgroundColor: "transparent",
        strokeWidth: 1, roughness: 0,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (!pushEl(frameEl)) break;
    }

    groupRows.forEach((r, idx) => {
      if (capped) return;
      const text = cleanHtmlText(r[textCol] || "");
      const rawColor = colorCol >= 0 ? (r[colorCol] || "").trim().toLowerCase() : "light_yellow";
      const bg = MIRO_STICKY_COLORS[rawColor] ?? sanitizeColor(rawColor, "#fff3bf");
      const hasXY = xCol >= 0 && yCol >= 0 && r[xCol] !== "" && r[yCol] !== "";
      const x = hasXY ? parseFinite(r[xCol], 0) : 20 + GAP + (idx % COLS) * (CARD_W + GAP);
      const y = hasXY ? parseFinite(r[yCol], 0) : cursorY + (fName ? 34 : 0) + Math.floor(idx / COLS) * (CARD_H + GAP);
      makeShapeWithLabel({
        type: "rectangle", x, y, width: CARD_W, height: CARD_H, text,
        strokeColor: "#e67700", backgroundColor: bg, strokeWidth: 1,
        frameId: frameEl?.id ?? null, now, pushEl,
      });
    });

    cursorY += rowsNeeded * (CARD_H + GAP) + (fName ? 80 : 40);
  }

  finalizeElements(elements, []);
  return { ok: true, format: "miro-csv", elements, warnings, unsupported: unsup.list() };
}

// ── 3. Lucidchart importer (JSON + CSV) ─────────────────────────────────────

function mapLucidShape(name) {
  const s = String(name ?? "").toLowerCase();
  if (s.includes("swimlane") || s.includes("container") || s.includes("group") || s.includes("frame")) return { type: "frame", rounded: false };
  if (s.includes("decision") || s.includes("diamond") || s.includes("rhombus")) return { type: "diamond", rounded: false };
  if (s.includes("circle") || s.includes("oval") || s.includes("ellipse") || s.includes("terminator") || s.includes("database")) return { type: "ellipse", rounded: false };
  if (s === "text" || s === "text block") return { type: "text", rounded: false };
  if (s.includes("process") || s.includes("rectangle") || s.includes("block") || s.includes("box") || s.includes("note") || s === "") {
    return { type: "rectangle", rounded: s.includes("round") };
  }
  return { type: "rectangle", rounded: false, approximated: true };
}

function mapLucidArrow(val, fallback) {
  if (val == null || val === "") return fallback;
  const v = String(val).toLowerCase();
  if (v === "none") return null;
  if (v === "crowfoot_one" || v === "one") return "crowfoot_one";
  if (v === "crowfoot_many" || v === "many") return "crowfoot_many";
  if (v === "diamond") return "diamond";
  if (v === "circle" || v === "dot") return "dot";
  if (v === "triangle") return "triangle";
  return "arrow";
}

/**
 * Detect whether input looks like a Lucidchart JSON or CSV export.
 * @param {unknown} input
 * @returns {boolean}
 */
export function isLucidchart(input) {
  let data = input;
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return false;
    if (t.startsWith("{")) {
      try { data = JSON.parse(t); } catch { return false; }
    } else {
      const firstLine = t.split(/\r?\n/, 1)[0].toLowerCase();
      return firstLine.includes("shape library") && (firstLine.includes("line source") || firstLine.includes("page id"));
    }
  }
  if (!isPlainObj(data)) return false;
  if (Array.isArray(data.pages) && data.pages.some(p => isPlainObj(p) && (Array.isArray(p.shapes) || Array.isArray(p.blocks) || Array.isArray(p.lines)))) return true;
  return (Array.isArray(data.shapes) || Array.isArray(data.blocks)) && (Array.isArray(data.lines) || Array.isArray(data.connectors));
}

/**
 * Parse a Lucidchart JSON or CSV diagram export.
 * @param {unknown} input
 * @param {{ now?: number }} [opts]
 */
export function parseLucidchart(input, { now = Date.now() } = {}) {
  /** @type {string[]} */
  const warnings = [];
  const unsup = createUnsupportedTracker();
  const fail = (error, format = "lucidchart-json") => ({
    ok: false, format, elements: [], warnings, unsupported: unsup.list(), error,
  });

  if (typeof input === "string") {
    if (utf8Bytes(input) > MAX_IMPORT_BYTES) return fail(`Lucidchart input exceeds maximum size of ${MAX_IMPORT_BYTES} bytes`);
    const trimmed = input.replace(/^\uFEFF/, "").trim();
    if (!trimmed) return fail("Lucidchart input is empty");
    if (!trimmed.startsWith("{")) {
      return parseLucidchartCsv(trimmed, { now });
    }
    try { input = JSON.parse(trimmed); }
    catch { return fail("Invalid Lucidchart JSON"); }
  }

  if (!isPlainObj(input)) return fail("Lucidchart JSON must be an object");

  let page = input;
  if (Array.isArray(input.pages)) {
    if (!input.pages.length) return fail("Lucidchart JSON has no pages");
    if (input.pages.length > 1) {
      warnings.push(`Lucidchart document has ${input.pages.length} pages; importing page 1`);
      unsup.record("lucidchart:multi-page", "Additional Lucidchart pages beyond page 1 are not imported", input.pages.length - 1);
    }
    page = input.pages[0];
  }

  if (Array.isArray(page.layers) && page.layers.length) {
    unsup.record("lucidchart:layers", "Lucidchart layers are flattened onto base layer", page.layers.length);
  }
  if (Array.isArray(page.comments) && page.comments.length) {
    unsup.record("lucidchart:comments", "Lucidchart comments are not imported", page.comments.length);
  }
  if (Array.isArray(page.embeds) && page.embeds.length) {
    unsup.record("lucidchart:embeds", "Lucidchart embedded widgets are not supported", page.embeds.length);
  }

  const rawContainers = Array.isArray(page.containers) ? page.containers : (Array.isArray(page.groups) ? page.groups : []);
  const rawShapes = Array.isArray(page.shapes) ? page.shapes : (Array.isArray(page.blocks) ? page.blocks : []);
  const rawLines = Array.isArray(page.lines) ? page.lines : (Array.isArray(page.connectors) ? page.connectors : []);

  /** @type {any[]} */
  const elements = [];
  let capped = false;
  const pushEl = el => {
    if (elements.length >= MAX_IMPORT_ELEMENTS) {
      if (!capped) { warnings.push(`Lucidchart diagram exceeded ${MAX_IMPORT_ELEMENTS} elements`); capped = true; }
      return false;
    }
    elements.push(el);
    return true;
  };

  const elById = new Map();

  // Pass 1: Explicit containers/frames.
  for (const c of rawContainers) {
    if (capped || !isPlainObj(c)) continue;
    const bb = isPlainObj(c.boundingBox) ? c.boundingBox : c;
    const style = isPlainObj(c.style) ? c.style : {};
    const frame = makeElement("frame", {
      id: newId(),
      x: parseFinite(bb.x, 0), y: parseFinite(bb.y, 0),
      width: parseFinite(bb.w ?? bb.width, 360, 20, MAX_DIM),
      height: parseFinite(bb.h ?? bb.height, 240, 20, MAX_DIM),
      name: cleanHtmlText(c.title ?? c.text ?? c.name ?? "").slice(0, 200) || null,
      strokeColor: sanitizeColor(style.strokeColor, "#868e96"),
      backgroundColor: sanitizeColor(style.fillColor, "transparent"),
      strokeWidth: 1, roughness: 0,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    if (pushEl(frame) && c.id != null) elById.set(String(c.id), frame);
  }

  // Pass 2: Shapes & text.
  for (const s of rawShapes) {
    if (capped || !isPlainObj(s)) continue;
    const rawType = String(s.type ?? s.class ?? s.shape ?? "rectangle");
    const lowerType = rawType.toLowerCase();
    if (lowerType === "image" || lowerType === "embed" || lowerType === "table" || lowerType === "video") {
      unsup.record(`lucidchart:${lowerType}`, `Lucidchart shape type "${rawType}" is not supported`);
      continue;
    }
    const bb = isPlainObj(s.boundingBox) ? s.boundingBox : s;
    const style = isPlainObj(s.style) ? s.style : {};
    if (style.gradient || style.shadow) {
      unsup.record("lucidchart:custom-style", "Lucidchart gradient/shadow styling is simplified");
    }

    const x = parseFinite(bb.x, 0);
    const y = parseFinite(bb.y, 0);
    const w = parseFinite(bb.w ?? bb.width, 140, 10, MAX_DIM);
    const h = parseFinite(bb.h ?? bb.height, 70, 10, MAX_DIM);
    const rotDeg = parseFinite(bb.rotation ?? s.rotation, 0, -3600, 3600);
    const angle = rotDeg ? (rotDeg * Math.PI) / 180 : 0;
    const text = cleanHtmlText(s.text ?? s.label ?? "");
    const parentId = s.containerId ?? s.parentId ?? s.containedBy ?? null;
    const parentFrame = parentId != null ? elById.get(String(parentId)) : null;
    const frameId = parentFrame?.type === "frame" ? parentFrame.id : null;

    const mapped = mapLucidShape(rawType);
    if (mapped.approximated) {
      unsup.record(`lucidchart:shape:${lowerType}`, `Lucidchart shape "${rawType}" approximated as rectangle`);
    }

    if (mapped.type === "frame") {
      const frame = makeElement("frame", {
        id: newId(),
        x, y, width: w, height: h, angle: normAngle(angle),
        name: text ? text.slice(0, 200) : null,
        strokeColor: sanitizeColor(style.strokeColor, "#868e96"),
        backgroundColor: sanitizeColor(style.fillColor, "transparent"),
        strokeWidth: 1, roughness: 0, frameId,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(frame) && s.id != null) elById.set(String(s.id), frame);
    } else if (mapped.type === "text") {
      const fontSize = parseFinite(style.fontSize, 16, 8, 120);
      const sz = textSize(text || " ", fontSize, 1.25, 2);
      const txt = makeElement("text", {
        id: newId(),
        x, y,
        width: Math.max(1, Math.min(MAX_DIM, bb.w ?? bb.width ? w : Math.ceil(sz.w))),
        height: Math.max(1, Math.min(MAX_DIM, bb.h ?? bb.height ? h : Math.ceil(sz.h))),
        angle: normAngle(angle),
        text, originalText: text, fontSize, fontFamily: 2,
        textAlign: "left", verticalAlign: "top",
        strokeColor: sanitizeColor(style.fontColor ?? style.color, DEFAULT_STROKE),
        frameId,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(txt) && s.id != null) elById.set(String(s.id), txt);
    } else {
      const strokeStyle = style.strokeStyle === "dashed" ? "dashed" : style.strokeStyle === "dotted" ? "dotted" : "solid";
      const el = makeShapeWithLabel({
        type: mapped.type, x, y, width: w, height: h, text,
        strokeColor: sanitizeColor(style.strokeColor, DEFAULT_STROKE),
        backgroundColor: sanitizeColor(style.fillColor, "transparent"),
        strokeWidth: parseFinite(style.strokeWidth, 2, 0.5, 40),
        strokeStyle, opacity: parseFinite(style.opacity, 100, 0, 100),
        angle, roundness: mapped.rounded ? { type: 3 } : null,
        fontSize: parseFinite(style.fontSize, 16, 8, 120),
        fontColor: sanitizeColor(style.fontColor, DEFAULT_STROKE),
        frameId, now, pushEl,
      });
      if (el && s.id != null) elById.set(String(s.id), el);
    }
  }

  // Pass 3: Lines / connectors.
  /** @type {{ edgeEl: any, labelEl: any | null }[]} */
  const edgesToSettle = [];

  for (const l of rawLines) {
    if (capped || !isPlainObj(l)) continue;
    const style = isPlainObj(l.style) ? l.style : {};
    const ep1 = isPlainObj(l.endpoint1) ? l.endpoint1 : {};
    const ep2 = isPlainObj(l.endpoint2) ? l.endpoint2 : {};
    const srcId = ep1.connectedTo ?? l.source ?? l.from ?? null;
    const tgtId = ep2.connectedTo ?? l.target ?? l.to ?? null;
    const srcEl = srcId != null ? elById.get(String(srcId)) : null;
    const tgtEl = tgtId != null ? elById.get(String(tgtId)) : null;
    const srcBind = srcEl && BINDABLE_TYPES.has(srcEl.type) ? srcEl : null;
    const tgtBind = tgtEl && BINDABLE_TYPES.has(tgtEl.type) ? tgtEl : null;

    const sp = ep1.x != null && ep1.y != null
      ? [parseFinite(ep1.x, 0), parseFinite(ep1.y, 0)]
      : srcEl ? [srcEl.x + srcEl.width / 2, srcEl.y + srcEl.height / 2] : [0, 0];
    const ep = ep2.x != null && ep2.y != null
      ? [parseFinite(ep2.x, 100), parseFinite(ep2.y, 0)]
      : tgtEl ? [tgtEl.x + tgtEl.width / 2, tgtEl.y + tgtEl.height / 2] : [sp[0] + 120, sp[1]];

    const startArrowhead = mapLucidArrow(ep1.style ?? l.sourceArrow, null);
    const endArrowhead = mapLucidArrow(ep2.style ?? l.destinationArrow ?? l.targetArrow, "arrow");
    const type = !startArrowhead && !endArrowhead ? "line" : "arrow";
    const strokeColor = sanitizeColor(style.strokeColor, DEFAULT_STROKE);
    const strokeStyle = style.strokeStyle === "dashed" ? "dashed" : style.strokeStyle === "dotted" ? "dotted" : "solid";

    const edgeEl = makeElement(type, {
      id: newId(),
      x: sp[0], y: sp[1],
      points: [[0, 0], [ep[0] - sp[0], ep[1] - sp[1]]],
      strokeColor,
      strokeWidth: parseFinite(style.strokeWidth, 2, 0.5, 40),
      strokeStyle, roughness: 0,
      startBinding: srcBind ? { elementId: srcBind.id, focus: 0, gap: 6 } : null,
      endBinding: tgtBind ? { elementId: tgtBind.id, focus: 0, gap: 6 } : null,
      startArrowhead, endArrowhead,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    normalize(edgeEl);
    if (!pushEl(edgeEl)) break;
    if (srcBind) attachBound(srcBind, edgeEl.id, type);
    if (tgtBind) attachBound(tgtBind, edgeEl.id, type);

    const text = cleanHtmlText(
      Array.isArray(l.text) ? l.text.map(t => t?.text ?? "").filter(Boolean).join(" ") : (l.text ?? l.label ?? "")
    );
    let labelEl = null;
    if (text) {
      const sz = textSize(text, 14, 1.25, 2);
      labelEl = makeElement("text", {
        id: newId(),
        x: (sp[0] + ep[0]) / 2 - sz.w / 2,
        y: (sp[1] + ep[1]) / 2 - sz.h / 2,
        width: Math.max(1, Math.ceil(sz.w)),
        height: Math.max(1, Math.ceil(sz.h)),
        text, originalText: text,
        fontSize: 14, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
        strokeColor, containerId: edgeEl.id,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(labelEl)) attachBound(edgeEl, labelEl.id, "text");
      else labelEl = null;
    }
    edgesToSettle.push({ edgeEl, labelEl });
  }

  finalizeElements(elements, edgesToSettle);
  return { ok: true, format: "lucidchart-json", elements, warnings, unsupported: unsup.list() };
}

function parseLucidchartCsv(csvText, { now = Date.now() } = {}) {
  const warnings = [];
  const unsup = createUnsupportedTracker();
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { ok: false, format: "lucidchart-csv", elements: [], warnings, unsupported: unsup.list(), error: "Lucidchart CSV has no data rows" };
  }

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idx = name => headers.indexOf(name);
  const idCol = idx("id");
  const nameCol = idx("name");
  const libCol = idx("shape library");
  const pageCol = idx("page id");
  const containedCol = idx("contained by");
  const srcCol = idx("line source");
  const dstCol = idx("line destination");
  const srcArrCol = idx("source arrow");
  const dstArrCol = idx("destination arrow");
  const textCol = headers.findIndex(h => h === "text area 1" || h === "text");
  const xCol = idx("x");
  const yCol = idx("y");
  const wCol = idx("width");
  const hCol = idx("height");

  if (idCol < 0 || nameCol < 0) {
    return { ok: false, format: "lucidchart-csv", elements: [], warnings, unsupported: unsup.list(), error: "Lucidchart CSV missing Id or Name column" };
  }

  // Filter to first Page ID if multiple pages exist.
  let firstPageId = null;
  const extraPages = new Set();
  const shapeRows = [];
  const lineRows = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = (r[idCol] || "").trim();
    const name = (r[nameCol] || "").trim();
    if (!id || !name) continue;
    const lowerName = name.toLowerCase();
    if (lowerName === "document" || lowerName === "page") continue;

    const pid = pageCol >= 0 ? (r[pageCol] || "").trim() : "";
    if (pid) {
      if (firstPageId === null) firstPageId = pid;
      else if (pid !== firstPageId) { extraPages.add(pid); continue; }
    }

    if (lowerName === "line" || (srcCol >= 0 && r[srcCol]?.trim()) || (dstCol >= 0 && r[dstCol]?.trim())) {
      lineRows.push(r);
    } else if (lowerName === "comment" || lowerName === "image" || lowerName === "table" || lowerName === "embed") {
      unsup.record(`lucidchart-csv:${lowerName}`, `Lucidchart CSV "${name}" rows are not supported`);
    } else {
      shapeRows.push(r);
    }
  }

  if (extraPages.size > 0) {
    warnings.push(`Lucidchart CSV has ${extraPages.size + 1} pages; importing page ${firstPageId}`);
    unsup.record("lucidchart-csv:multi-page", "Additional Lucidchart CSV pages are not imported", extraPages.size);
  }

  // Auto-layout shapes with layoutGraph if X/Y coordinates are absent.
  const nodesMap = new Map();
  const groupMap = new Map();
  const shapeMeta = new Map();

  for (const r of shapeRows) {
    const id = r[idCol].trim();
    const name = r[nameCol].trim();
    const lib = libCol >= 0 ? (r[libCol] || "").trim() : "";
    const text = textCol >= 0 ? cleanHtmlText(r[textCol] || "") : name;
    const containedBy = containedCol >= 0 ? (r[containedCol] || "").trim() : "";
    const mapped = mapLucidShape(name);
    if (mapped.approximated && lib) {
      unsup.record(`lucidchart-csv:shape:${name.toLowerCase()}`, `Shape "${name}" (${lib}) approximated as rectangle`);
    }
    shapeMeta.set(id, { id, name, text, containedBy, mapped, row: r });
    if (mapped.type === "frame") {
      groupMap.set(id, { id, title: text || name, nodes: [] });
    } else {
      nodesMap.set(id, { id, label: text || name, type: mapped.type === "text" ? "rectangle" : mapped.type, rounded: mapped.rounded });
    }
  }

  for (const meta of shapeMeta.values()) {
    if (meta.containedBy && groupMap.has(meta.containedBy) && nodesMap.has(meta.id)) {
      groupMap.get(meta.containedBy).nodes.push(meta.id);
    }
  }

  const graphEdges = [];
  for (const r of lineRows) {
    const from = srcCol >= 0 ? (r[srcCol] || "").trim() : "";
    const to = dstCol >= 0 ? (r[dstCol] || "").trim() : "";
    if (nodesMap.has(from) && nodesMap.has(to)) {
      graphEdges.push({ from, to, label: textCol >= 0 ? cleanHtmlText(r[textCol] || "") : null });
    }
  }

  const placed = nodesMap.size ? layoutGraph({
    dir: "TD",
    nodes: nodesMap,
    edges: graphEdges,
    groups: [...groupMap.values()].filter(g => g.nodes.length > 0),
  }) : new Map();

  /** @type {any[]} */
  const elements = [];
  let capped = false;
  const pushEl = el => {
    if (elements.length >= MAX_IMPORT_ELEMENTS) {
      if (!capped) { warnings.push(`Lucidchart CSV exceeded ${MAX_IMPORT_ELEMENTS} elements`); capped = true; }
      return false;
    }
    elements.push(el);
    return true;
  };

  const elById = new Map();

  // Pass 1: Container frames sized around their placed children.
  for (const grp of groupMap.values()) {
    if (capped) break;
    const ps = grp.nodes.map(nid => placed.get(nid)).filter(Boolean);
    const x0 = ps.length ? Math.min(...ps.map(p => p.x)) - 28 : 40;
    const y0 = ps.length ? Math.min(...ps.map(p => p.y)) - 36 : 40;
    const x1 = ps.length ? Math.max(...ps.map(p => p.x + p.w)) + 28 : 340;
    const y1 = ps.length ? Math.max(...ps.map(p => p.y + p.h)) + 28 : 240;
    const frame = makeElement("frame", {
      id: newId(),
      x: x0, y: y0, width: Math.max(100, x1 - x0), height: Math.max(80, y1 - y0),
      name: grp.title.slice(0, 200),
      strokeColor: "#868e96", backgroundColor: "transparent",
      strokeWidth: 1, roughness: 0,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    if (pushEl(frame)) elById.set(grp.id, frame);
  }

  // Pass 2: Shapes.
  for (const meta of shapeMeta.values()) {
    if (capped || meta.mapped.type === "frame") continue;
    const p = placed.get(meta.id) || { x: 40, y: 40, w: 140, h: 64 };
    const r = meta.row;
    const x = xCol >= 0 && r[xCol] !== "" ? parseFinite(r[xCol], p.x) : p.x;
    const y = yCol >= 0 && r[yCol] !== "" ? parseFinite(r[yCol], p.y) : p.y;
    const w = wCol >= 0 && r[wCol] !== "" ? parseFinite(r[wCol], p.w, 10, MAX_DIM) : p.w;
    const h = hCol >= 0 && r[hCol] !== "" ? parseFinite(r[hCol], p.h, 10, MAX_DIM) : p.h;
    const parentFrame = meta.containedBy ? elById.get(meta.containedBy) : null;

    if (meta.mapped.type === "text") {
      const sz = textSize(meta.text || " ", 16, 1.25, 2);
      const txt = makeElement("text", {
        id: newId(), x, y, width: Math.max(1, Math.ceil(sz.w)), height: Math.max(1, Math.ceil(sz.h)),
        text: meta.text, originalText: meta.text, fontSize: 16, fontFamily: 2,
        textAlign: "left", verticalAlign: "top",
        strokeColor: DEFAULT_STROKE, frameId: parentFrame?.id ?? null,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(txt)) elById.set(meta.id, txt);
    } else {
      const el = makeShapeWithLabel({
        type: meta.mapped.type, x, y, width: w, height: h, text: meta.text,
        roundness: meta.mapped.rounded ? { type: 3 } : null,
        frameId: parentFrame?.id ?? null, now, pushEl,
      });
      if (el) elById.set(meta.id, el);
    }
  }

  // Pass 3: Lines.
  /** @type {{ edgeEl: any, labelEl: any | null }[]} */
  const edgesToSettle = [];
  for (const r of lineRows) {
    if (capped) break;
    const srcId = srcCol >= 0 ? (r[srcCol] || "").trim() : "";
    const dstId = dstCol >= 0 ? (r[dstCol] || "").trim() : "";
    const srcEl = srcId ? elById.get(srcId) : null;
    const tgtEl = dstId ? elById.get(dstId) : null;
    const srcBind = srcEl && BINDABLE_TYPES.has(srcEl.type) ? srcEl : null;
    const tgtBind = tgtEl && BINDABLE_TYPES.has(tgtEl.type) ? tgtEl : null;
    const sp = srcEl ? [srcEl.x + srcEl.width / 2, srcEl.y + srcEl.height / 2] : [0, 0];
    const ep = tgtEl ? [tgtEl.x + tgtEl.width / 2, tgtEl.y + tgtEl.height / 2] : [sp[0] + 120, sp[1]];

    const startArrowhead = mapLucidArrow(srcArrCol >= 0 ? r[srcArrCol] : null, null);
    const endArrowhead = mapLucidArrow(dstArrCol >= 0 ? r[dstArrCol] : null, "arrow");
    const type = !startArrowhead && !endArrowhead ? "line" : "arrow";

    const edgeEl = makeElement(type, {
      id: newId(), x: sp[0], y: sp[1], points: [[0, 0], [ep[0] - sp[0], ep[1] - sp[1]]],
      strokeColor: DEFAULT_STROKE, strokeWidth: 2, strokeStyle: "solid", roughness: 0,
      startBinding: srcBind ? { elementId: srcBind.id, focus: 0, gap: 6 } : null,
      endBinding: tgtBind ? { elementId: tgtBind.id, focus: 0, gap: 6 } : null,
      startArrowhead, endArrowhead,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: { layer: BASE_LAYER, z: 0 },
    });
    normalize(edgeEl);
    if (!pushEl(edgeEl)) break;
    if (srcBind) attachBound(srcBind, edgeEl.id, type);
    if (tgtBind) attachBound(tgtBind, edgeEl.id, type);

    const text = textCol >= 0 ? cleanHtmlText(r[textCol] || "") : "";
    let labelEl = null;
    if (text) {
      const sz = textSize(text, 14, 1.25, 2);
      labelEl = makeElement("text", {
        id: newId(),
        x: (sp[0] + ep[0]) / 2 - sz.w / 2,
        y: (sp[1] + ep[1]) / 2 - sz.h / 2,
        width: Math.max(1, Math.ceil(sz.w)),
        height: Math.max(1, Math.ceil(sz.h)),
        text, originalText: text, fontSize: 14, fontFamily: 2,
        textAlign: "center", verticalAlign: "middle",
        strokeColor: DEFAULT_STROKE, containerId: edgeEl.id,
        version: 0, versionNonce: randomInt(), updated: now,
        customData: { layer: BASE_LAYER, z: 0 },
      });
      if (pushEl(labelEl)) attachBound(edgeEl, labelEl.id, "text");
      else labelEl = null;
    }
    edgesToSettle.push({ edgeEl, labelEl });
  }

  finalizeElements(elements, edgesToSettle);
  return { ok: true, format: "lucidchart-csv", elements, warnings, unsupported: unsup.list() };
}

// ── Unified entry point ─────────────────────────────────────────────────────

/**
 * Auto-detect and import an external diagram (Visio `.vsdx`/XML, Miro JSON/CSV, or Lucidchart JSON/CSV).
 * Always returns `{ ok, format, elements, warnings, unsupported, error? }`.
 * @param {unknown} input
 * @param {{ format?: "auto" | "visio" | "miro" | "lucidchart", now?: number }} [opts]
 */
export function importExternalDiagram(input, { format = "auto", now = Date.now() } = {}) {
  if (format === "visio") return parseVisio(input, { now });
  if (format === "miro") return parseMiro(input, { now });
  if (format === "lucidchart") return parseLucidchart(input, { now });
  if (isVisio(input)) return parseVisio(input, { now });
  if (isLucidchart(input)) return parseLucidchart(input, { now });
  if (isMiro(input)) return parseMiro(input, { now });
  return {
    ok: false,
    format: null,
    elements: [],
    warnings: [],
    unsupported: [],
    error: "Unrecognized external diagram format (expected Visio .vsdx/XML, Miro JSON/CSV, or Lucidchart JSON/CSV)",
  };
}
