// @ts-check
// Diagram-as-Code importers & two-way code-sync contract (Issue #4).
//
// Supports:
//   - Mermaid: flowchart/graph (delegated to ./mermaid.js), sequenceDiagram,
//              erDiagram, classDiagram, stateDiagram / stateDiagram-v2
//   - D2: nodes, labels, shapes, styles, edges, chains, nested containers
//   - PlantUML: sequence, state, class & component diagrams
//   - Two-way code-sync: importDiagramCode() + reconcileDiagramCode()
//
// Strictly pure: zero DOM, Node, Bun, or bare package imports.

import {
  DEFAULT_STROKE, BASE_LAYER, makeElement, clone, newId, randomInt, textSize, utf8Bytes,
} from "./model.js";
import { mermaidToElements, layoutGraph } from "./mermaid.js";
import { Doc } from "./doc.js";
import { edgePoint, normalize, settle, labelAnchor } from "./geometry.js";
import { reconcileBoundElements } from "./excalidraw.js";
import { labelHostHeight, labelHostWidth, wrapLines, textWidth } from "./text.js";

export const MAX_DIAGRAM_SOURCE_BYTES = 512 * 1024;
export const MAX_DIAGRAM_ELEMENTS = 4_000;
const MAX_LABEL_CHARS = 4_000;
const ROOT_FRAME_PAD = 36;
const CHILD_FRAME_PAD = 28;
const FRAME_TITLE_H = 26;

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED_COLORS = new Set([
  "transparent", "black", "white", "red", "green", "blue", "yellow", "orange", "purple",
  "pink", "brown", "gray", "grey", "cyan", "magenta", "silver", "maroon", "olive", "lime",
  "aqua", "teal", "navy", "indigo", "violet", "gold", "coral", "crimson",
  "lightblue", "lightgreen", "lightgray", "lightgrey", "skyblue", "steelblue", "tomato",
]);

function sanitizeColor(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s || s.length > 32 || /[\x00-\x1f\x7f]/.test(s)) return fallback;
  const lower = s.toLowerCase();
  if (lower === "none" || lower === "transparent") return "transparent";
  if (HEX_COLOR_RE.test(s)) return s;
  if (NAMED_COLORS.has(lower)) return lower;
  return fallback;
}

function cleanText(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.replace(/\r\n?/g, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/\\n/g, "\n").trim();
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS) : s;
}

function attachBound(host, id, type) {
  if (!Array.isArray(host.boundElements)) host.boundElements = [];
  if (!host.boundElements.some(b => b.id === id && b.type === type)) {
    host.boundElements.push({ id, type });
  }
}

function makeLabeledShape(type, {
  x, y, width, height, text, fontSize = 18, strokeColor = DEFAULT_STROKE,
  backgroundColor = "transparent", strokeWidth = 2, strokeStyle = "solid",
  opacity = 100, roundness = null, layer = BASE_LAYER, z = 0, now = Date.now(),
  diagramKey = null, frameId = null, textAlign = "center", verticalAlign = "middle",
}) {
  const shape = makeElement(type, {
    id: newId(),
    x, y, width, height,
    strokeColor, backgroundColor, fillStyle: "solid",
    strokeWidth, strokeStyle, roughness: 0, opacity, roundness,
    frameId,
    version: 0, versionNonce: randomInt(), updated: now,
    customData: {
      layer, z,
      ...(diagramKey ? { diagramKey, diagramLayout: { x, y } } : {}),
    },
  });
  const out = [shape];
  if (text) {
    const clean = cleanText(text);
    const sz = textSize(clean, fontSize, 1.25, 2);
    const lw = Math.max(1, Math.min(Math.max(1, width - 16), Math.ceil(sz.w)));
    const lh = Math.max(1, Math.ceil(sz.h));
    const label = makeElement("text", {
      id: newId(),
      x: x + (width - lw) / 2,
      y: y + (height - lh) / 2,
      width: lw,
      height: lh,
      text: clean,
      originalText: clean,
      fontSize,
      fontFamily: 2,
      textAlign,
      verticalAlign,
      strokeColor: DEFAULT_STROKE,
      containerId: shape.id,
      frameId,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: {
        layer, z: z + 1,
        ...(diagramKey ? { diagramKey: `label:${diagramKey}` } : {}),
      },
    });
    attachBound(shape, label.id, "text");
    const needH = labelHostHeight(label, shape);
    if (shape.height < needH) shape.height = needH;
    out.push(label);
  }
  return out;
}

function computeBoxSize(label, type = "rectangle", fontSize = 18, minW = 130, minH = 56, maxW = 280) {
  const text = cleanText(label || " ");
  const lines = text.split("\n");
  const wrapped = lines.flatMap(l => wrapLines(l || " ", maxW - 32, fontSize, 2));
  const longest = Math.max(40, ...wrapped.map(l => textWidth(l, fontSize, 2)));
  let w = Math.max(minW, Math.min(maxW, Math.ceil(longest + 36)));
  if (type === "diamond") w = Math.max(w * 1.45, 140);
  else if (type === "ellipse") w = Math.max(w * 1.2, 140);
  const lbl = { text, fontSize, fontFamily: 2, lineHeight: 1.25 };
  w = Math.max(w, labelHostWidth(lbl, type));
  const h = Math.max(minH, Math.ceil(labelHostHeight(lbl, { type, width: w }) + (type === "rectangle" ? 16 : 8)));
  return { w, h };
}

function makeEdge({
  src, tgt, label = "", strokeStyle = "solid", strokeWidth = 2,
  startArrowhead = null, endArrowhead = "arrow", strokeColor = DEFAULT_STROKE,
  layer = BASE_LAYER, z = 0, now = Date.now(), diagramKey = null,
  points = null,
}) {
  const type = !startArrowhead && !endArrowhead ? "line" : "arrow";
  const sc = src ? [src.x + src.width / 2, src.y + src.height / 2] : [0, 0];
  const tc = tgt ? [tgt.x + tgt.width / 2, tgt.y + tgt.height / 2] : [120, 0];
  const absPts = points && points.length >= 2
    ? points
    : (src && tgt
      ? [edgePoint(src, tc[0], tc[1]), edgePoint(tgt, sc[0], sc[1])]
      : [sc, tc]);
  const p0 = absPts[0];
  const relPts = absPts.map(([px, py]) => [px - p0[0], py - p0[1]]);

  const edge = makeElement(type, {
    id: newId(),
    x: p0[0],
    y: p0[1],
    points: relPts,
    strokeColor,
    strokeWidth,
    strokeStyle,
    roughness: 0,
    startBinding: src ? { elementId: src.id, focus: 0, gap: 6 } : null,
    endBinding: tgt ? { elementId: tgt.id, focus: 0, gap: 6 } : null,
    startArrowhead,
    endArrowhead,
    version: 0, versionNonce: randomInt(), updated: now,
    customData: {
      layer, z,
      ...(diagramKey ? { diagramKey, diagramLayout: { x: p0[0], y: p0[1] } } : {}),
    },
  });
  normalize(edge);
  if (src) attachBound(src, edge.id, type);
  if (tgt) attachBound(tgt, edge.id, type);

  const out = [edge];
  const clean = cleanText(label);
  if (clean) {
    const fontSize = 15;
    const sz = textSize(clean, fontSize, 1.25, 2);
    const mid = absPts[Math.floor(absPts.length / 2)];
    const lbl = makeElement("text", {
      id: newId(),
      x: mid[0] - sz.w / 2,
      y: mid[1] - sz.h / 2,
      width: Math.max(1, Math.ceil(sz.w)),
      height: Math.max(1, Math.ceil(sz.h)),
      text: clean,
      originalText: clean,
      fontSize,
      fontFamily: 2,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor,
      containerId: edge.id,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: {
        layer, z: z + 1,
        ...(diagramKey ? { diagramKey: `label:${diagramKey}` } : {}),
      },
    });
    attachBound(edge, lbl.id, "text");
    out.push(lbl);
  }
  return out;
}

/**
 * Render a generic layered graph `{ dir, nodes: Map, edges: Array, groups: Array }`
 * into editable Plenary elements using `layoutGraph` from `./mermaid.js`.
 */
function renderLayeredGraph(g, { origin = { x: 0, y: 0 }, layer = BASE_LAYER, z = 0, now = Date.now() }) {
  /** @type {any[]} */
  const els = [];
  if (g.nodes.size === 0) return els;

  const place = layoutGraph({
    dir: g.dir || "TD",
    nodes: new Map([...g.nodes.entries()].map(([id, n]) => [id, {
      id,
      label: n.label || id,
      type: n.type || "rectangle",
      rounded: !!n.rounded,
    }])),
    edges: g.edges.map(e => ({ from: e.from, to: e.to, label: e.label || null })),
    groups: g.groups || [],
  });

  // Override computed box sizes when nodes specify custom min sizes (e.g. class/ER boxes, small start/end dots).
  for (const [id, n] of g.nodes) {
    const p = place.get(id);
    if (!p) continue;
    if (n.fixedSize) {
      p.w = n.fixedSize.w;
      p.h = n.fixedSize.h;
    } else if (n.minSize) {
      p.w = Math.max(p.w, n.minSize.w);
      p.h = Math.max(p.h, n.minSize.h);
    }
  }

  let zz = z;
  const frameByGroupId = new Map();

  // Render group frames first (underneath nodes).
  for (const grp of g.groups || []) {
    const ps = grp.nodes.map(id => place.get(id)).filter(Boolean);
    if (!ps.length) continue;
    const x0 = Math.min(...ps.map(p => p.x)) - CHILD_FRAME_PAD;
    const y0 = Math.min(...ps.map(p => p.y)) - CHILD_FRAME_PAD - FRAME_TITLE_H / 2;
    const x1 = Math.max(...ps.map(p => p.x + p.w)) + CHILD_FRAME_PAD;
    const y1 = Math.max(...ps.map(p => p.y + p.h)) + CHILD_FRAME_PAD;
    const fx = origin.x + x0;
    const fy = origin.y + y0;
    const frame = makeElement("frame", {
      id: newId(),
      x: fx, y: fy,
      width: Math.max(80, x1 - x0),
      height: Math.max(60, y1 - y0),
      name: (grp.title || grp.id).slice(0, 200),
      strokeColor: grp.strokeColor || "#868e96",
      backgroundColor: grp.backgroundColor || "transparent",
      strokeWidth: 1,
      roughness: 0,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: {
        layer, z: ++zz,
        diagramKey: `group:${grp.id}`,
        diagramLayout: { x: fx, y: fy },
      },
    });
    frameByGroupId.set(grp.id, frame);
    els.push(frame);
  }

  // Map each node to its innermost group frame (if any).
  const nodeFrame = new Map();
  for (const grp of g.groups || []) {
    const f = frameByGroupId.get(grp.id);
    if (!f) continue;
    for (const nid of grp.nodes) nodeFrame.set(nid, f.id);
  }

  const shapeById = new Map();
  for (const [id, n] of g.nodes) {
    const p = place.get(id);
    if (!p) continue;
    const nx = origin.x + p.x;
    const ny = origin.y + p.y;
    const created = makeLabeledShape(n.type || "rectangle", {
      x: nx, y: ny, width: p.w, height: p.h,
      text: n.hideLabel ? "" : (n.label ?? id),
      fontSize: n.fontSize ?? 16,
      strokeColor: n.strokeColor || DEFAULT_STROKE,
      backgroundColor: n.backgroundColor || "transparent",
      strokeWidth: n.strokeWidth ?? 2,
      strokeStyle: n.strokeStyle || "solid",
      opacity: n.opacity ?? 100,
      roundness: n.rounded && (n.type || "rectangle") === "rectangle" ? { type: 3 } : null,
      layer, z: ++zz, now,
      diagramKey: `node:${id}`,
      frameId: nodeFrame.get(id) ?? null,
      textAlign: n.textAlign || "center",
      verticalAlign: n.verticalAlign || "middle",
    });
    zz += created.length;
    shapeById.set(id, created[0]);
    els.push(...created);
  }

  const edgeCounts = new Map();
  for (const e of g.edges) {
    const src = shapeById.get(e.from);
    const tgt = shapeById.get(e.to);
    if (!src || !tgt) continue;
    const pairKey = `${e.from}->${e.to}`;
    const idx = edgeCounts.get(pairKey) ?? 0;
    edgeCounts.set(pairKey, idx + 1);
    let pts = null;
    if (src.id === tgt.id) {
      // Self-loop arrow
      const rx = src.x + src.width;
      const ry = src.y + src.height * 0.3;
      const ry2 = src.y + src.height * 0.7;
      pts = [[rx, ry], [rx + 42, ry], [rx + 42, ry2], [rx, ry2]];
    }
    const created = makeEdge({
      src, tgt,
      label: e.label || "",
      strokeStyle: e.strokeStyle || "solid",
      strokeWidth: e.strokeWidth ?? 2,
      startArrowhead: e.startArrowhead ?? null,
      endArrowhead: e.endArrowhead !== undefined ? e.endArrowhead : "arrow",
      strokeColor: e.strokeColor || DEFAULT_STROKE,
      layer, z: ++zz, now,
      diagramKey: `edge:${pairKey}#${idx}`,
      points: pts,
    });
    zz += created.length;
    els.push(...created);
  }

  return els;
}

// ── Language & Mermaid subtype detection ─────────────────────────────────────

/**
 * Detect diagram language from source text: `"mermaid" | "plantuml" | "d2" | null`.
 * @param {unknown} source
 * @returns {"mermaid" | "plantuml" | "d2" | null}
 */
export function detectDiagramLang(source) {
  if (typeof source !== "string") return null;
  const s = source.trim();
  if (!s) return null;
  if (/^@startuml\b/im.test(s) || /^@enduml\b/im.test(s)) return "plantuml";
  const noComments = s.replace(/^\s*%%[^\n]*\n/gm, "").trimStart();
  if (/^(graph|flowchart|sequenceDiagram|erDiagram|classDiagram|stateDiagram(?:-v2)?)\b/i.test(noComments)) {
    return "mermaid";
  }
  if (/^\s*(participant|actor|class|interface|component|package|state)\s+/m.test(s) && /--?>|<--?|--\|>|\*--|o--/.test(s)) {
    return "plantuml";
  }
  if (/^\s*(direction\s*:|[A-Za-z0-9_."'\s-]+\s*(?:<->|->|<-|--)\s*[A-Za-z0-9_."'\s-]+|[A-Za-z0-9_.-]+\s*:\s*[^:\n]+\{)/m.test(s)) {
    return "d2";
  }
  return null;
}

function detectMermaidSubtype(src) {
  const clean = src.replace(/\r/g, "").replace(/^\s*%%[^\n]*\n/gm, "").trimStart();
  if (/^(graph|flowchart)\b/i.test(clean)) return "flowchart";
  if (/^sequenceDiagram\b/i.test(clean)) return "sequence";
  if (/^erDiagram\b/i.test(clean)) return "er";
  if (/^classDiagram\b/i.test(clean)) return "class";
  if (/^stateDiagram(?:-v2)?\b/i.test(clean)) return "state";
  return null;
}

// ── Sequence diagram renderer (shared by Mermaid sequenceDiagram & PlantUML sequence) ──

function renderSequenceModel(model, { origin = { x: 0, y: 0 }, layer = BASE_LAYER, z = 0, now = Date.now() }) {
  /** @type {any[]} */
  const els = [];
  const participants = model.participants;
  if (!participants.length) return els;

  const COL_GAP = 190;
  const BOX_W = 140;
  const BOX_H = 52;
  const ROW_STEP = 64;
  const TOP_Y = origin.y + 20;
  const FIRST_MSG_Y = TOP_Y + BOX_H + 46;
  const totalSteps = Math.max(1, model.items.length);
  const LIFELINE_BOTTOM = FIRST_MSG_Y + totalSteps * ROW_STEP + 30;

  let zz = z;
  const centerXOf = new Map();
  const headerById = new Map();

  // Block frames first (underneath lifelines & arrows).
  for (let bi = 0; bi < model.blocks.length; bi++) {
    const blk = model.blocks[bi];
    const y0 = FIRST_MSG_Y + blk.startStep * ROW_STEP - 26;
    const y1 = FIRST_MSG_Y + Math.max(blk.startStep, blk.endStep) * ROW_STEP + 24;
    const x0 = origin.x - 16;
    const x1 = origin.x + (participants.length - 1) * COL_GAP + BOX_W + 16;
    const frame = makeElement("frame", {
      id: newId(),
      x: x0, y: y0,
      width: Math.max(160, x1 - x0),
      height: Math.max(60, y1 - y0),
      name: `${blk.kind}${blk.label ? `: ${blk.label}` : ""}`.slice(0, 200),
      strokeColor: "#868e96",
      backgroundColor: "transparent",
      strokeWidth: 1,
      roughness: 0,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: {
        layer, z: ++zz,
        diagramKey: `seq-block:${bi}:${blk.kind}`,
        diagramLayout: { x: x0, y: y0 },
      },
    });
    els.push(frame);
  }

  // Participant headers + vertical dashed lifelines.
  participants.forEach((p, idx) => {
    const x = origin.x + idx * COL_GAP;
    const cx = x + BOX_W / 2;
    centerXOf.set(p.id, cx);

    const isActor = p.kind === "actor";
    const shapeType = isActor ? "ellipse" : "rectangle";
    const created = makeLabeledShape(shapeType, {
      x, y: TOP_Y, width: BOX_W, height: BOX_H,
      text: p.label,
      fontSize: 16,
      backgroundColor: isActor ? "#fff3bf" : "#e7f5ff",
      strokeColor: isActor ? "#e67700" : "#1971c2",
      roundness: shapeType === "rectangle" ? { type: 3 } : null,
      layer, z: ++zz, now,
      diagramKey: `participant:${p.id}`,
    });
    zz += created.length;
    headerById.set(p.id, created[0]);
    els.push(...created);

    const line = makeElement("line", {
      id: newId(),
      x: cx,
      y: TOP_Y + BOX_H,
      points: [[0, 0], [0, LIFELINE_BOTTOM - (TOP_Y + BOX_H)]],
      strokeColor: "#adb5bd",
      strokeWidth: 1.5,
      strokeStyle: "dashed",
      roughness: 0,
      startArrowhead: null,
      endArrowhead: null,
      version: 0, versionNonce: randomInt(), updated: now,
      customData: {
        layer, z: ++zz,
        diagramKey: `lifeline:${p.id}`,
        diagramLayout: { x: cx, y: TOP_Y + BOX_H },
      },
    });
    normalize(line);
    els.push(line);
  });

  // Messages and notes along Y.
  model.items.forEach((item, stepIdx) => {
    const y = FIRST_MSG_Y + stepIdx * ROW_STEP;
    if (item.kind === "note") {
      const targetX = centerXOf.get(item.targets[0]) ?? origin.x + BOX_W / 2;
      const targetX2 = item.targets.length > 1 ? (centerXOf.get(item.targets[1]) ?? targetX) : targetX;
      const sz = computeBoxSize(item.text, "rectangle", 14, 120, 42, 220);
      let nx = (targetX + targetX2) / 2 - sz.w / 2;
      if (item.pos === "right") nx = targetX + 18;
      else if (item.pos === "left") nx = targetX - sz.w - 18;
      const created = makeLabeledShape("rectangle", {
        x: nx, y: y - sz.h / 2, width: sz.w, height: sz.h,
        text: item.text, fontSize: 14,
        backgroundColor: "#fff9db", strokeColor: "#f08c00",
        strokeWidth: 1.5, layer, z: ++zz, now,
        diagramKey: `note:${stepIdx}`,
      });
      zz += created.length;
      els.push(...created);
      return;
    }

    const sx = centerXOf.get(item.from);
    const tx = centerXOf.get(item.to);
    if (sx == null || tx == null) return;
    let pts;
    if (item.from === item.to) {
      pts = [[sx, y - 10], [sx + 56, y - 10], [sx + 56, y + 14], [sx, y + 14]];
    } else {
      pts = [[sx, y], [tx, y]];
    }
    const created = makeEdge({
      src: null, tgt: null,
      label: item.label || "",
      strokeStyle: item.dashed ? "dashed" : "solid",
      strokeWidth: 2,
      startArrowhead: item.startArrowhead ?? null,
      endArrowhead: item.endArrowhead !== undefined ? item.endArrowhead : "arrow",
      layer, z: ++zz, now,
      diagramKey: `msg:${stepIdx}:${item.from}->${item.to}`,
      points: pts,
    });
    zz += created.length;
    els.push(...created);
  });

  return els;
}

// ── Mermaid sequenceDiagram parser ──────────────────────────────────────────

function parseMermaidSequence(src) {
  const lines = src.replace(/\r/g, "").split("\n").map(l => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  lines.shift(); // remove `sequenceDiagram`

  /** @type {Array<{ id: string, label: string, kind: string }>} */
  const participants = [];
  const pMap = new Map();
  const ensureP = (id, label = null, kind = "participant") => {
    const cleanId = id.trim();
    if (!cleanId) return;
    let p = pMap.get(cleanId);
    if (!p) {
      p = { id: cleanId, label: label || cleanId, kind };
      pMap.set(cleanId, p);
      participants.push(p);
    } else {
      if (label) p.label = label;
      if (kind !== "participant") p.kind = kind;
    }
  };

  /** @type {any[]} */
  const items = [];
  /** @type {Array<{ kind: string, label: string, startStep: number, endStep: number }>} */
  const blocks = [];
  /** @type {Array<{ kind: string, label: string, startStep: number, endStep: number }>} */
  const blockStack = [];

  for (const line of lines) {
    if (/^(autonumber|activate|deactivate|title\b)/i.test(line)) continue;

    const pm = /^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (pm) {
      ensureP(pm[2], pm[3]?.trim() || pm[2], pm[1].toLowerCase());
      continue;
    }

    const bm = /^(alt|opt|loop|par|rect|critical|break)\b\s*(.*)$/i.exec(line);
    if (bm) {
      const blk = { kind: bm[1].toLowerCase(), label: bm[2].trim(), startStep: items.length, endStep: items.length };
      blocks.push(blk);
      blockStack.push(blk);
      continue;
    }
    if (/^(else|and)\b/i.test(line)) continue;
    if (/^end$/i.test(line)) {
      const blk = blockStack.pop();
      if (blk) blk.endStep = Math.max(blk.startStep, items.length - 1);
      continue;
    }

    const nm = /^Note\s+(right of|left of|over)\s+([^:]+):\s*(.+)$/i.exec(line);
    if (nm) {
      const pos = nm[1].toLowerCase().startsWith("right") ? "right" : nm[1].toLowerCase().startsWith("left") ? "left" : "over";
      const targets = nm[2].split(",").map(t => t.trim()).filter(Boolean);
      for (const t of targets) ensureP(t);
      items.push({ kind: "note", pos, targets, text: nm[3].trim() });
      continue;
    }

    const mm = /^([^\s:<-]+)\s*(<<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))\s*[+-]?([^\s:]+)\s*(?::\s*(.*))?$/.exec(line);
    if (mm) {
      const from = mm[1].trim(), op = mm[2], to = mm[3].trim(), label = (mm[4] ?? "").trim();
      ensureP(from);
      ensureP(to);
      const dashed = op.includes("--");
      const bidir = op.startsWith("<<");
      const endHead = op.endsWith("x") ? "bar" : (op.endsWith(">") || op.endsWith(")") ? "arrow" : "arrow");
      items.push({
        kind: "message", from, to, label, dashed,
        startArrowhead: bidir ? "arrow" : null,
        endArrowhead: endHead,
      });
    }
  }
  while (blockStack.length) {
    const blk = blockStack.pop();
    blk.endStep = Math.max(blk.startStep, items.length - 1);
  }
  return { participants, items, blocks };
}

// ── Mermaid erDiagram parser ────────────────────────────────────────────────

function mapErCardinality(sym) {
  if (!sym) return null;
  if (sym.includes("{") || sym.includes("}")) {
    return sym.includes("|") ? "crowfoot_one_or_many" : "crowfoot_many";
  }
  if (sym.includes("|")) return "crowfoot_one";
  return null;
}

function parseMermaidER(src) {
  const lines = src.replace(/\r/g, "").split("\n").map(l => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  lines.shift(); // remove `erDiagram`

  const entities = new Map();
  const ensureEntity = name => {
    const id = name.replace(/^"|"$/g, "").trim();
    if (!entities.has(id)) entities.set(id, { id, attrs: [] });
    return entities.get(id);
  };
  const edges = [];

  let activeEntity = null;
  for (const line of lines) {
    if (activeEntity) {
      if (line === "}") { activeEntity = null; continue; }
      activeEntity.attrs.push(line);
      continue;
    }
    const blockStart = /^([A-Za-z0-9_"-]+)\s*\{$/.exec(line);
    if (blockStart) {
      activeEntity = ensureEntity(blockStart[1]);
      continue;
    }
    // Relationship: ENTITY1 ||--o{ ENTITY2 : "label"
    const rel = /^([A-Za-z0-9_"-]+)\s+([|}o]{1,2})(--|\.\.)([|{o]{1,2})\s+([A-Za-z0-9_"-]+)(?:\s*:\s*(.*))?$/.exec(line);
    if (rel) {
      const a = ensureEntity(rel[1]);
      const b = ensureEntity(rel[5]);
      const leftCard = rel[2], lineStyle = rel[3], rightCard = rel[4];
      const label = (rel[6] ?? "").replace(/^"|"$/g, "").trim();
      edges.push({
        from: a.id,
        to: b.id,
        label,
        strokeStyle: lineStyle === ".." ? "dashed" : "solid",
        startArrowhead: mapErCardinality(leftCard),
        endArrowhead: mapErCardinality(rightCard),
      });
    }
  }

  const nodes = new Map();
  for (const [id, ent] of entities) {
    const label = ent.attrs.length
      ? `${id}\n──────────\n${ent.attrs.join("\n")}`
      : id;
    const sz = computeBoxSize(label, "rectangle", 15, 160, 56, 300);
    nodes.set(id, {
      id, label, type: "rectangle", rounded: false,
      backgroundColor: "#f8f9fa", strokeColor: "#495057",
      fontSize: 15, minSize: sz, textAlign: ent.attrs.length ? "left" : "center",
    });
  }
  return { dir: "LR", nodes, edges, groups: [] };
}

// ── Mermaid classDiagram parser ─────────────────────────────────────────────

function mapUmlRel(op) {
  const dashed = op.includes("..");
  let startArrowhead = null;
  let endArrowhead = null;
  if (op.startsWith("<|")) startArrowhead = "triangle";
  else if (op.startsWith("*")) startArrowhead = "diamond";
  else if (op.startsWith("o")) startArrowhead = "diamond_outline";
  else if (op.startsWith("<")) startArrowhead = "arrow";

  if (op.endsWith("|>")) endArrowhead = "triangle";
  else if (op.endsWith("*")) endArrowhead = "diamond";
  else if (op.endsWith("o")) endArrowhead = "diamond_outline";
  else if (op.endsWith(">")) endArrowhead = "arrow";

  return { strokeStyle: dashed ? "dashed" : "solid", startArrowhead, endArrowhead };
}

function parseMermaidClass(src) {
  const lines = src.replace(/\r/g, "").split("\n").map(l => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  lines.shift(); // remove `classDiagram`

  let dir = "TD";
  const classes = new Map();
  const groups = [];
  const nsStack = [];

  const ensureClass = rawName => {
    const id = rawName.replace(/[`"]/g, "").trim();
    if (!classes.has(id)) classes.set(id, { id, members: [], stereotype: null });
    for (const g of nsStack) if (!g.nodes.includes(id)) g.nodes.push(id);
    return classes.get(id);
  };

  const edges = [];
  let activeClass = null;

  for (const line of lines) {
    const dm = /^direction\s+(TD|TB|BT|LR|RL)$/i.exec(line);
    if (dm) { dir = dm[1].toUpperCase().replace("TB", "TD"); continue; }

    if (activeClass) {
      if (line === "}") { activeClass = null; continue; }
      if (/^<<.+>>$/.test(line)) activeClass.stereotype = line;
      else activeClass.members.push(line);
      continue;
    }

    const nsm = /^namespace\s+([^\s{]+)\s*\{$/.exec(line);
    if (nsm) {
      const g = { id: nsm[1], title: nsm[1], nodes: [] };
      groups.push(g);
      nsStack.push(g);
      continue;
    }
    if (line === "}") { nsStack.pop(); continue; }

    const cb = /^class\s+([^\s{]+)(?:\s*\{)?$/.exec(line);
    if (cb) {
      const c = ensureClass(cb[1]);
      if (line.endsWith("{")) activeClass = c;
      continue;
    }

    // Relationship: ClassA <|-- ClassB : label
    const rel = /^([A-Za-z0-9_~"-]+)(?:\s+"[^"]*")?\s+(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)\s+(?:"[^"]*"\s+)?([A-Za-z0-9_~"-]+)(?:\s*:\s*(.*))?$/.exec(line);
    if (rel) {
      const a = ensureClass(rel[1]);
      const b = ensureClass(rel[3]);
      const style = mapUmlRel(rel[2]);
      edges.push({ from: a.id, to: b.id, label: (rel[4] ?? "").trim(), ...style });
      continue;
    }

    // Inline member: ClassA : +String name
    const mem = /^([A-Za-z0-9_~"-]+)\s*:\s*(.+)$/.exec(line);
    if (mem) {
      const c = ensureClass(mem[1]);
      c.members.push(mem[2].trim());
    }
  }

  const nodes = new Map();
  for (const [id, c] of classes) {
    const header = c.stereotype ? `${c.stereotype}\n${id}` : id;
    const label = c.members.length ? `${header}\n──────────\n${c.members.join("\n")}` : header;
    const sz = computeBoxSize(label, "rectangle", 15, 150, 56, 300);
    nodes.set(id, {
      id, label, type: "rectangle", rounded: false,
      backgroundColor: "#f8f9fa", strokeColor: "#1e1e1e",
      fontSize: 15, minSize: sz, textAlign: c.members.length ? "left" : "center",
    });
  }
  return { dir, nodes, edges, groups };
}

// ── Mermaid stateDiagram / stateDiagram-v2 parser ───────────────────────────

function parseMermaidState(src) {
  const lines = src.replace(/\r/g, "").split("\n").map(l => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  lines.shift(); // remove `stateDiagram` / `stateDiagram-v2`

  let dir = "TD";
  const states = new Map();
  const groups = [];
  const stack = [];
  let startUsed = false;
  let endUsed = false;

  const ensureState = (id, label = null) => {
    if (!states.has(id)) {
      states.set(id, { id, label: label || id, isPseudo: false, desc: [] });
    } else if (label) {
      states.get(id).label = label;
    }
    for (const g of stack) if (!g.nodes.includes(id)) g.nodes.push(id);
    return states.get(id);
  };

  const resolveEndpoint = (raw, isTarget) => {
    const t = raw.trim();
    if (t === "[*]") {
      const pid = isTarget ? "__end__" : "__start__";
      if (isTarget) endUsed = true; else startUsed = true;
      if (!states.has(pid)) {
        states.set(pid, { id: pid, label: "", isPseudo: true, isEnd: isTarget, desc: [] });
      }
      for (const g of stack) if (!g.nodes.includes(pid)) g.nodes.push(pid);
      return pid;
    }
    return ensureState(t).id;
  };

  const edges = [];

  for (const line of lines) {
    const dm = /^direction\s+(TD|TB|BT|LR|RL)$/i.exec(line);
    if (dm) { dir = dm[1].toUpperCase().replace("TB", "TD"); continue; }

    const comp = /^state\s+(?:"([^"]+)"\s+as\s+)?([^\s{]+)\s*\{$/.exec(line);
    if (comp) {
      const gid = comp[2];
      const title = comp[1] || gid;
      const g = { id: gid, title, nodes: [] };
      groups.push(g);
      stack.push(g);
      continue;
    }
    if (line === "}") { stack.pop(); continue; }

    const alias = /^state\s+"([^"]+)"\s+as\s+([^\s]+)$/.exec(line);
    if (alias) { ensureState(alias[2], alias[1]); continue; }

    const tr = /^(\[\*\]|[A-Za-z0-9_.-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_.-]+)(?:\s*:\s*(.*))?$/.exec(line);
    if (tr) {
      const from = resolveEndpoint(tr[1], false);
      const to = resolveEndpoint(tr[2], true);
      edges.push({ from, to, label: (tr[3] ?? "").trim(), endArrowhead: "arrow" });
      continue;
    }

    const desc = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
    if (desc && !/^note\b/i.test(desc[1])) {
      const s = ensureState(desc[1]);
      s.desc.push(desc[2].trim());
    }
  }

  const nodes = new Map();
  for (const [id, st] of states) {
    if (st.isPseudo) {
      nodes.set(id, {
        id, label: "", hideLabel: true, type: "ellipse",
        backgroundColor: st.isEnd ? "#495057" : "#1e1e1e",
        strokeColor: "#1e1e1e", strokeWidth: st.isEnd ? 4 : 2,
        fixedSize: { w: 28, h: 28 },
      });
    } else {
      const label = st.desc.length ? `${st.label}\n${st.desc.join("\n")}` : st.label;
      const sz = computeBoxSize(label, "rectangle", 16, 120, 52, 260);
      nodes.set(id, {
        id, label, type: "rectangle", rounded: true,
        backgroundColor: "#f1f3f5", strokeColor: "#343a40",
        fontSize: 16, minSize: sz,
      });
    }
  }
  return { dir, nodes, edges, groups };
}

// ── D2 parser ───────────────────────────────────────────────────────────────

function mapD2Shape(shape) {
  const s = String(shape ?? "").toLowerCase();
  if (s === "circle" || s === "oval" || s === "cylinder" || s === "cloud" || s === "person") return "ellipse";
  if (s === "diamond" || s === "hexagon") return "diamond";
  return "rectangle";
}

function parseD2(src) {
  const cleanLines = src.replace(/\r/g, "").split("\n").map(line => {
    // Strip # comments outside quotes (preserving hex colors like #e7f5ff).
    let inQ = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === inQ && line[i - 1] !== "\\") inQ = ""; }
      else if (ch === "\"" || ch === "'") inQ = ch;
      else if (ch === "#") {
        if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})(?:\s|$|;)/i.test(line.slice(i))) continue;
        return line.slice(0, i).trim();
      }
    }
    return line.trim();
  }).filter(Boolean);

  let dir = "TD";
  const nodes = new Map();
  const edges = [];
  const groups = new Map(); // fullPath -> { id, title, nodes: [] }
  /** @type {string[]} */
  const scopeStack = [];

  const qual = rawId => {
    const clean = rawId.trim().replace(/^["']|["']$/g, "");
    if (!scopeStack.length || clean.includes(".")) return clean;
    return `${scopeStack.join(".")}.${clean}`;
  };

  const ensureNode = (id, label = null) => {
    let n = nodes.get(id);
    if (!n) {
      const short = id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
      n = {
        id, label: label || short, type: "rectangle", rounded: true,
        backgroundColor: "transparent", strokeColor: DEFAULT_STROKE,
        strokeStyle: "solid", opacity: 100,
      };
      nodes.set(id, n);
    } else if (label != null) {
      n.label = label;
    }
    // Register in any ancestor groups.
    for (let i = 0; i < scopeStack.length; i++) {
      const gKey = scopeStack.slice(0, i + 1).join(".");
      const g = groups.get(gKey);
      if (g && !g.nodes.includes(id)) g.nodes.push(id);
    }
    // Also register by dotted prefix if referenced outside block.
    if (id.includes(".")) {
      const parts = id.split(".");
      for (let i = 1; i < parts.length; i++) {
        const gKey = parts.slice(0, i).join(".");
        const g = groups.get(gKey);
        if (g && !g.nodes.includes(id)) g.nodes.push(id);
      }
    }
    return n;
  };

  for (const rawLine of cleanLines) {
    // Handle multiple `;` separated statements on one line.
    const stmts = rawLine.split(";").map(s => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      if (stmt === "}") {
        scopeStack.pop();
        continue;
      }

      const dirM = /^direction\s*:\s*(right|left|up|down)$/i.exec(stmt);
      if (dirM) {
        const d = dirM[1].toLowerCase();
        dir = d === "right" ? "LR" : d === "left" ? "RL" : d === "up" ? "BT" : "TD";
        continue;
      }

      // Container opening: `net: Network {` or `net {`
      const openM = /^([A-Za-z0-9_.-]+)(?:\s*:\s*([^{]+))?\s*\{$/.exec(stmt);
      if (openM) {
        const rawKey = openM[1].trim();
        const fullKey = scopeStack.length ? `${scopeStack.join(".")}.${rawKey}` : rawKey;
        const title = (openM[2] ?? rawKey).trim().replace(/^["']|["']$/g, "");
        if (!groups.has(fullKey)) groups.set(fullKey, { id: fullKey, title, nodes: [] });
        scopeStack.push(rawKey);
        continue;
      }

      // Property assignment: `a.shape: circle` or `a.style.fill: #eee`
      const propM = /^([A-Za-z0-9_.-]+)\.(shape|style\.fill|style\.stroke|style\.stroke-dash|style\.opacity)\s*:\s*(.+)$/.exec(stmt);
      if (propM) {
        const targetId = qual(propM[1]);
        const prop = propM[2];
        const val = propM[3].trim().replace(/^["']|["']$/g, "");
        const n = ensureNode(targetId);
        if (prop === "shape") n.type = mapD2Shape(val);
        else if (prop === "style.fill") n.backgroundColor = sanitizeColor(val, n.backgroundColor);
        else if (prop === "style.stroke") n.strokeColor = sanitizeColor(val, n.strokeColor);
        else if (prop === "style.stroke-dash") n.strokeStyle = Number(val) > 0 ? "dashed" : "solid";
        else if (prop === "style.opacity") {
          const op = Number(val);
          if (Number.isFinite(op)) n.opacity = Math.max(0, Math.min(100, op <= 1 ? Math.round(op * 100) : Math.round(op)));
        }
        continue;
      }

      // Edge(s): `a -> b -> c: label` or `a <-> b` or `a -- b` or `a <- b`
      if (/(?:<->|->|<-|--)/.test(stmt)) {
        // Split trailing `: label` (outside quotes)
        let edgePart = stmt;
        let label = "";
        const colonIdx = stmt.indexOf(":");
        if (colonIdx > 0) {
          edgePart = stmt.slice(0, colonIdx).trim();
          label = stmt.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
        }
        const tokens = edgePart.split(/\s*(<->|->|<-|--)\s*/).filter(Boolean);
        if (tokens.length >= 3) {
          for (let i = 0; i + 2 < tokens.length; i += 2) {
            const left = qual(tokens[i]);
            const op = tokens[i + 1];
            const right = qual(tokens[i + 2]);
            ensureNode(left);
            ensureNode(right);
            edges.push({
              from: left,
              to: right,
              label: i + 3 >= tokens.length ? label : "",
              startArrowhead: op === "<-" || op === "<->" ? "arrow" : null,
              endArrowhead: op === "->" || op === "<->" ? "arrow" : null,
            });
          }
          continue;
        }
      }

      // Node declaration: `a: My Label` or bare `a`
      const nodeM = /^([A-Za-z0-9_.-]+)(?:\s*:\s*(.+))?$/.exec(stmt);
      if (nodeM) {
        const id = qual(nodeM[1]);
        const lbl = nodeM[2] ? nodeM[2].trim().replace(/^["']|["']$/g, "") : null;
        ensureNode(id, lbl);
      }
    }
  }

  // Filter out empty groups (e.g., style-only blocks).
  const groupList = [...groups.values()].filter(g => g.nodes.length > 0);
  return { dir, nodes, edges, groups: groupList };
}

// ── PlantUML parser ─────────────────────────────────────────────────────────

function stripPlantUmlBoilerplate(src) {
  let s = src.replace(/\r/g, "");
  // Remove block comments /' ... '/
  s = s.replace(/\/'[\s\S]*?'\//g, "");
  const lines = s.split("\n")
    .map(l => l.replace(/^\s*'.*$/, "").trim())
    .filter(l => l && !/^@(?:startuml|enduml)\b/i.test(l) && !/^(?:skinparam|hide|show|title|autonumber|!include|!define)\b/i.test(l));
  return lines;
}

function detectPlantUmlSubtype(lines) {
  if (lines.some(l => /^\[\*\]\s*-+>|^-+>\s*\[\*\]|^state\s+/i.test(l))) return "state";
  if (lines.some(l => /^(class|interface|abstract\s+class|enum|component|package|node|cloud|database|folder)\b/i.test(l))) return "class-component";
  if (lines.some(l => /^(participant|actor|boundary|control|entity)\b/i.test(l) || /^[^\s:]+\s*(?:-->|->|->>|<<-|<-|<--|<->)\s*[^\s:]+\s*:/.test(l))) return "sequence";
  return "class-component";
}

function parsePlantUmlSequence(lines) {
  const participants = [];
  const pMap = new Map();
  const ensureP = (id, label = null, kind = "participant") => {
    const cleanId = id.replace(/^"|"$/g, "").trim();
    if (!cleanId) return;
    let p = pMap.get(cleanId);
    if (!p) {
      p = { id: cleanId, label: label || cleanId, kind };
      pMap.set(cleanId, p);
      participants.push(p);
    } else {
      if (label) p.label = label;
      if (kind !== "participant") p.kind = kind;
    }
  };
  const items = [];
  const blocks = [];
  const blockStack = [];

  for (const line of lines) {
    const pm = /^(participant|actor|boundary|control|entity|database)\s+(?:"([^"]+)"\s+as\s+)?([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (pm) {
      const kind = pm[1].toLowerCase() === "actor" ? "actor" : "participant";
      const id = pm[4] ? pm[4].trim() : pm[3].trim();
      const label = pm[2] || pm[3].replace(/^"|"$/g, "").trim();
      ensureP(id, label, kind);
      continue;
    }
    const bm = /^(alt|opt|loop|par|group|critical|break)\b\s*(.*)$/i.exec(line);
    if (bm) {
      const blk = { kind: bm[1].toLowerCase(), label: bm[2].trim(), startStep: items.length, endStep: items.length };
      blocks.push(blk);
      blockStack.push(blk);
      continue;
    }
    if (/^else\b/i.test(line)) continue;
    if (/^end$/i.test(line)) {
      const blk = blockStack.pop();
      if (blk) blk.endStep = Math.max(blk.startStep, items.length - 1);
      continue;
    }
    const nm = /^note\s+(left|right|over)\s+(?:of\s+)?([^:]+):\s*(.+)$/i.exec(line);
    if (nm) {
      const pos = nm[1].toLowerCase();
      const targets = nm[2].split(",").map(t => t.trim()).filter(Boolean);
      for (const t of targets) ensureP(t);
      items.push({ kind: "note", pos, targets, text: nm[3].trim() });
      continue;
    }
    const mm = /^("?[^"\s:<-]+"?)\s*(<->|<--|<--|<-|-->|->>|->)\s*("?[^"\s:]+"?)\s*(?::\s*(.*))?$/.exec(line);
    if (mm) {
      const left = mm[1].replace(/^"|"$/g, "").trim();
      const op = mm[2];
      const right = mm[3].replace(/^"|"$/g, "").trim();
      const label = (mm[4] ?? "").trim();
      ensureP(left);
      ensureP(right);
      const reversed = op === "<-" || op === "<--";
      items.push({
        kind: "message",
        from: reversed ? right : left,
        to: reversed ? left : right,
        label,
        dashed: op.includes("--"),
        startArrowhead: op === "<->" ? "arrow" : null,
        endArrowhead: "arrow",
      });
    }
  }
  while (blockStack.length) {
    const blk = blockStack.pop();
    blk.endStep = Math.max(blk.startStep, items.length - 1);
  }
  return { participants, items, blocks };
}

function parsePlantUmlClassOrComponent(lines) {
  const entities = new Map();
  const groups = [];
  const pkgStack = [];

  const ensureEnt = (rawId, opts = {}) => {
    const id = rawId.replace(/^["[\]]+|["[\]]+$/g, "").trim();
    if (!id) return null;
    let e = entities.get(id);
    if (!e) {
      e = { id, label: opts.label || id, kind: opts.kind || "class", members: [] };
      entities.set(id, e);
    } else {
      if (opts.label) e.label = opts.label;
      if (opts.kind && e.kind === "class") e.kind = opts.kind;
    }
    for (const g of pkgStack) if (!g.nodes.includes(id)) g.nodes.push(id);
    return e;
  };

  const edges = [];
  let activeClass = null;

  for (const line of lines) {
    if (activeClass) {
      if (line === "}") { activeClass = null; continue; }
      activeClass.members.push(line);
      continue;
    }

    // Container: package/node/folder/cloud/rectangle "Title" {
    const pkgM = /^(package|node|folder|cloud|frame|rectangle)\s+(?:"([^"]+)"|([^\s{]+))(?:\s+as\s+([^\s{]+))?\s*\{$/i.exec(line);
    if (pkgM) {
      const title = pkgM[2] || pkgM[3];
      const gid = pkgM[4] || title;
      const g = { id: gid, title, nodes: [] };
      groups.push(g);
      pkgStack.push(g);
      continue;
    }
    if (line === "}") { pkgStack.pop(); continue; }

    // Class / interface / enum declaration
    const clsM = /^(abstract\s+class|class|interface|enum)\s+(?:"([^"]+)"\s+as\s+)?([^\s{]+)(?:\s*\{)?$/i.exec(line);
    if (clsM) {
      const kind = clsM[1].toLowerCase();
      const e = ensureEnt(clsM[3], { label: clsM[2] || clsM[3], kind });
      if (e && line.endsWith("{")) activeClass = e;
      continue;
    }

    // Component / database / rectangle / actor declaration
    const compM = /^(component|database|rectangle|actor|cloud|node)\s+(?:\[([^\]]+)\]|"([^"]+)"|([^\s]+))(?:\s+as\s+([^\s]+))?$/i.exec(line);
    if (compM) {
      const kind = compM[1].toLowerCase();
      const label = compM[2] || compM[3] || compM[4];
      const id = compM[5] || label;
      ensureEnt(id, { label, kind });
      continue;
    }

    // Relationship
    const rel = /^(\[[^\]]+\]|"[^"]+"|[A-Za-z0-9_.-]+)\s+(<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|->|<-|--|\.\.)\s+(\[[^\]]+\]|"[^"]+"|[A-Za-z0-9_.-]+)(?:\s*:\s*(.*))?$/.exec(line);
    if (rel) {
      const a = ensureEnt(rel[1]);
      const b = ensureEnt(rel[3]);
      if (!a || !b) continue;
      const op = rel[2] === "->" ? "-->" : rel[2] === "<-" ? "<--" : rel[2];
      edges.push({ from: a.id, to: b.id, label: (rel[4] ?? "").trim(), ...mapUmlRel(op) });
    }
  }

  const nodes = new Map();
  for (const [id, e] of entities) {
    const isEllipse = e.kind === "database" || e.kind === "actor" || e.kind === "cloud";
    const prefix = e.kind === "interface" ? "<<interface>>\n" : e.kind === "abstract class" ? "<<abstract>>\n" : e.kind === "enum" ? "<<enum>>\n" : "";
    const label = e.members.length
      ? `${prefix}${e.label}\n──────────\n${e.members.join("\n")}`
      : `${prefix}${e.label}`;
    const type = isEllipse ? "ellipse" : "rectangle";
    const sz = computeBoxSize(label, type, 15, 140, 54, 280);
    nodes.set(id, {
      id, label, type, rounded: e.kind === "component",
      backgroundColor: e.kind === "interface" ? "#f3f0ff" : e.kind === "database" ? "#e7f5ff" : "#f8f9fa",
      strokeColor: DEFAULT_STROKE,
      fontSize: 15, minSize: sz, textAlign: e.members.length ? "left" : "center",
    });
  }
  return { dir: "TD", nodes, edges, groups: groups.filter(g => g.nodes.length > 0) };
}

// ── Bounding box & settling helpers ─────────────────────────────────────────

function computeBounds(elements) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    if (el.type === "arrow" || el.type === "line") {
      for (const [px, py] of el.points ?? [[0, 0]]) {
        const ax = el.x + px, ay = el.y + py;
        if (ax < minX) minX = ax;
        if (ay < minY) minY = ay;
        if (ax > maxX) maxX = ax;
        if (ay > maxY) maxY = ay;
      }
    } else {
      if (el.x < minX) minX = el.x;
      if (el.y < minY) minY = el.y;
      if (el.x + el.width > maxX) maxX = el.x + el.width;
      if (el.y + el.height > maxY) maxY = el.y + el.height;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 200, height: 120 };
  return { x: minX, y: minY, width: Math.max(80, maxX - minX), height: Math.max(60, maxY - minY) };
}

function settleDiagramEdges(elements) {
  if (!elements.length) return;
  const doc = new Doc({ elements, appState: {}, files: {} });
  const labelByContainer = new Map();
  for (const el of elements) {
    if (el.type === "text" && el.containerId) labelByContainer.set(el.containerId, el);
  }
  for (const el of elements) {
    if ((el.type === "arrow" || el.type === "line") && (el.startBinding || el.endBinding)) {
      // Preserve self-loop geometry (4-point loop) rather than collapsing it.
      if (el.startBinding?.elementId && el.startBinding.elementId === el.endBinding?.elementId) continue;
      settle(doc, el);
      const lbl = labelByContainer.get(el.id);
      if (lbl) {
        const anchor = labelAnchor(doc, el);
        if (anchor) {
          lbl.x = anchor[0] - lbl.width / 2;
          lbl.y = anchor[1] - lbl.height / 2;
        }
      }
    }
  }
}

// ── Public API: importDiagramCode & reconcileDiagramCode ────────────────────

/**
 * Import Diagram-as-Code (Mermaid, D2, or PlantUML) into editable Plenary elements
 * wrapped in a parent frame stamped with `customData.diagramCode`.
 *
 * @param {unknown} source
 * @param {{
 *   lang?: "auto" | "mermaid" | "d2" | "plantuml",
 *   origin?: { x: number, y: number },
 *   blockId?: string,
 *   layer?: string,
 *   z?: number,
 *   now?: number,
 *   version?: number,
 * }} [opts]
 */
export function importDiagramCode(source, {
  lang = "auto",
  origin = { x: 0, y: 0 },
  blockId = newId(),
  layer = BASE_LAYER,
  z = 0,
  now = Date.now(),
  version = 1,
} = {}) {
  /** @type {string[]} */
  const warnings = [];
  const fail = (error, resolvedLang = null) => ({
    ok: false,
    lang: resolvedLang,
    diagramType: null,
    blockId,
    elements: [],
    warnings,
    error,
  });

  if (typeof source !== "string") return fail("Diagram source must be a string");
  const trimmed = source.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return fail("Diagram source is empty");
  if (utf8Bytes(trimmed) > MAX_DIAGRAM_SOURCE_BYTES) {
    return fail(`Diagram source exceeds maximum size of ${MAX_DIAGRAM_SOURCE_BYTES} bytes`);
  }

  const resolvedLang = lang === "auto" || !lang ? detectDiagramLang(trimmed) : lang;
  if (resolvedLang !== "mermaid" && resolvedLang !== "d2" && resolvedLang !== "plantuml") {
    return fail(`Unsupported or unrecognized diagram language: ${String(lang)}`);
  }

  const ox = Number.isFinite(origin?.x) ? origin.x : 0;
  const oy = Number.isFinite(origin?.y) ? origin.y : 0;
  const innerOrigin = { x: ox + ROOT_FRAME_PAD, y: oy + ROOT_FRAME_PAD };

  /** @type {any[]} */
  let children = [];
  /** @type {string} */
  let diagramType = resolvedLang;

  try {
    if (resolvedLang === "mermaid") {
      const sub = detectMermaidSubtype(trimmed);
      if (!sub) return fail("Unrecognized Mermaid diagram type", "mermaid");
      diagramType = `mermaid:${sub}`;
      if (sub === "flowchart") {
        const res = mermaidToElements(trimmed, { origin: innerOrigin, layer, z: z + 2 });
        children = res.elements;
        // Stamp deterministic diagramKeys + reset version to 0 for Protocol v1.1 safety.
        let fi = 0, ni = 0, ei = 0;
        const nodeIdList = [...res.graph.nodes.keys()];
        const groupList = res.graph.groups;
        const edgeList = res.graph.edges;
        const keyByElId = new Map();
        for (const el of children) {
          el.version = 0;
          el.versionNonce = randomInt();
          el.updated = now;
          if (el.type === "frame") {
            const g = groupList[fi++];
            const key = `group:${g?.id ?? fi}`;
            el.customData = { ...(el.customData ?? {}), diagramKey: key, diagramLayout: { x: el.x, y: el.y } };
            keyByElId.set(el.id, key);
          } else if (el.type === "rectangle" || el.type === "diamond" || el.type === "ellipse") {
            const nid = nodeIdList[ni++];
            const key = `node:${nid ?? ni}`;
            el.customData = { ...(el.customData ?? {}), diagramKey: key, diagramLayout: { x: el.x, y: el.y } };
            keyByElId.set(el.id, key);
          } else if (el.type === "arrow" || el.type === "line") {
            const e = edgeList[ei++];
            const key = e ? `edge:${e.from}->${e.to}#${ei - 1}` : `edge:${ei}`;
            el.customData = { ...(el.customData ?? {}), diagramKey: key, diagramLayout: { x: el.x, y: el.y } };
            keyByElId.set(el.id, key);
          }
        }
        for (const el of children) {
          if (el.type === "text" && el.containerId) {
            const hostKey = keyByElId.get(el.containerId);
            if (hostKey) el.customData = { ...(el.customData ?? {}), diagramKey: `label:${hostKey}` };
          }
        }
      } else if (sub === "sequence") {
        const seq = parseMermaidSequence(trimmed);
        children = renderSequenceModel(seq, { origin: innerOrigin, layer, z: z + 2, now });
      } else if (sub === "er") {
        const er = parseMermaidER(trimmed);
        children = renderLayeredGraph(er, { origin: innerOrigin, layer, z: z + 2, now });
      } else if (sub === "class") {
        const cls = parseMermaidClass(trimmed);
        children = renderLayeredGraph(cls, { origin: innerOrigin, layer, z: z + 2, now });
      } else if (sub === "state") {
        const st = parseMermaidState(trimmed);
        children = renderLayeredGraph(st, { origin: innerOrigin, layer, z: z + 2, now });
      }
    } else if (resolvedLang === "d2") {
      diagramType = "d2";
      const g = parseD2(trimmed);
      children = renderLayeredGraph(g, { origin: innerOrigin, layer, z: z + 2, now });
    } else if (resolvedLang === "plantuml") {
      const lines = stripPlantUmlBoilerplate(trimmed);
      const sub = detectPlantUmlSubtype(lines);
      diagramType = `plantuml:${sub}`;
      if (sub === "sequence") {
        const seq = parsePlantUmlSequence(lines);
        children = renderSequenceModel(seq, { origin: innerOrigin, layer, z: z + 2, now });
      } else if (sub === "state") {
        const st = parseMermaidState(`stateDiagram-v2\n${lines.join("\n")}`);
        children = renderLayeredGraph(st, { origin: innerOrigin, layer, z: z + 2, now });
      } else {
        const g = parsePlantUmlClassOrComponent(lines);
        children = renderLayeredGraph(g, { origin: innerOrigin, layer, z: z + 2, now });
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), resolvedLang);
  }

  if (children.length === 0) {
    return fail(`No diagram elements could be parsed from ${resolvedLang} source`, resolvedLang);
  }

  if (children.length > MAX_DIAGRAM_ELEMENTS - 1) {
    warnings.push(`Diagram exceeded ${MAX_DIAGRAM_ELEMENTS - 1} child elements; remaining elements were truncated`);
    children = children.slice(0, MAX_DIAGRAM_ELEMENTS - 1);
  }

  settleDiagramEdges(children);

  const bounds = computeBounds(children);
  const rootFrame = makeElement("frame", {
    id: newId(),
    x: bounds.x - ROOT_FRAME_PAD,
    y: bounds.y - ROOT_FRAME_PAD,
    width: bounds.width + ROOT_FRAME_PAD * 2,
    height: bounds.height + ROOT_FRAME_PAD * 2,
    name: `${resolvedLang} diagram`,
    strokeColor: "#868e96",
    backgroundColor: "transparent",
    strokeWidth: 1,
    roughness: 0,
    version: 0,
    versionNonce: randomInt(),
    updated: now,
    customData: {
      layer,
      z: z + 1,
      diagramBlockId: blockId,
      diagramKey: "__root__",
      diagramLayout: { x: bounds.x - ROOT_FRAME_PAD, y: bounds.y - ROOT_FRAME_PAD },
      diagramCode: {
        lang: resolvedLang,
        source: trimmed,
        blockId,
        version,
      },
    },
  });

  // Stamp blockId on every child and attach top-level children to rootFrame.
  for (const el of children) {
    el.customData = {
      ...(el.customData ?? {}),
      layer,
      diagramBlockId: blockId,
    };
    if (!el.frameId) el.frameId = rootFrame.id;
  }

  const elements = [rootFrame, ...children];
  reconcileBoundElements(elements);

  return {
    ok: true,
    lang: resolvedLang,
    diagramType,
    blockId,
    elements,
    warnings,
  };
}

/**
 * Two-way code-sync reconciliation: diffs and replaces only the target diagram block
 * inside `existingElements`, preserving unrelated elements untouched and preserving
 * user layout offsets on matching `diagramKey` elements.
 *
 * @param {any[]} existingElements
 * @param {unknown} newSource
 * @param {{
 *   blockId?: string,
 *   lang?: "auto" | "mermaid" | "d2" | "plantuml",
 *   layer?: string,
 *   z?: number,
 *   now?: number,
 * }} [opts]
 */
export function reconcileDiagramCode(existingElements, newSource, {
  blockId,
  lang,
  layer = BASE_LAYER,
  z = 0,
  now = Date.now(),
} = {}) {
  const existing = Array.isArray(existingElements) ? existingElements : [];

  // Locate the target root frame.
  const prevRoot = existing.find(el =>
    el && !el.isDeleted && el.type === "frame" && el.customData?.diagramCode &&
    (!blockId || el.customData.diagramCode.blockId === blockId)
  ) ?? null;

  const targetBlockId = blockId || prevRoot?.customData?.diagramCode?.blockId || newId();
  const prevCode = prevRoot?.customData?.diagramCode ?? null;
  const resolvedLang = lang || prevCode?.lang || "auto";
  const nextVersion = (prevCode?.version ?? 0) + 1;

  // Partition existing elements into unrelated vs belonging to this diagram block.
  const unrelated = [];
  const prevBlockEls = [];
  for (const el of existing) {
    if (!el || el.isDeleted) continue;
    const belongs =
      el.customData?.diagramBlockId === targetBlockId ||
      el.customData?.diagramCode?.blockId === targetBlockId ||
      (prevRoot && el.id === prevRoot.id);
    if (belongs) prevBlockEls.push(el);
    else unrelated.push(clone(el));
  }

  const origin = prevRoot
    ? { x: prevRoot.x, y: prevRoot.y }
    : { x: 0, y: 0 };

  const imported = importDiagramCode(newSource, {
    lang: resolvedLang,
    origin,
    blockId: targetBlockId,
    layer: prevRoot?.customData?.layer ?? layer,
    z: prevRoot?.customData?.z ?? z,
    now,
    version: nextVersion,
  });

  if (!imported.ok) {
    return {
      ok: false,
      blockId: targetBlockId,
      version: prevCode?.version ?? 0,
      elements: existing.map(clone),
      addedIds: [],
      updatedIds: [],
      removedIds: [],
      warnings: imported.warnings,
      error: imported.error,
    };
  }

  // Index previous block elements by their stable `diagramKey`.
  const prevByKey = new Map();
  for (const el of prevBlockEls) {
    const key = el.customData?.diagramKey;
    if (key && !prevByKey.has(key)) prevByKey.set(key, el);
  }

  const newEls = imported.elements;
  const idRemap = new Map(); // freshId -> preservedPrevId
  const updatedIds = [];
  const addedIds = [];
  const matchedPrevIds = new Set();
  const deltaByNewId = new Map(); // newEl.id -> { dx, dy }

  // Pass 1: Match elements by diagramKey, preserve IDs + user layout offsets, bump versions.
  for (const el of newEls) {
    const key = el.customData?.diagramKey;
    const prev = key ? prevByKey.get(key) : null;
    if (prev && prev.type === el.type) {
      idRemap.set(el.id, prev.id);
      matchedPrevIds.add(prev.id);
      updatedIds.push(prev.id);

      // Compute user drag offset from previous auto-layout position.
      if (key !== "__root__" && el.type !== "arrow" && el.type !== "line" && el.type !== "text") {
        const prevLayout = prev.customData?.diagramLayout;
        if (prevLayout && Number.isFinite(prevLayout.x) && Number.isFinite(prevLayout.y)) {
          const dx = prev.x - prevLayout.x;
          const dy = prev.y - prevLayout.y;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            deltaByNewId.set(el.id, { dx, dy });
            el.x += dx;
            el.y += dy;
          }
        }
      }

      el.version = (prev.version ?? 0) + 1;
      el.versionNonce = randomInt();
      el.updated = now;
    } else {
      addedIds.push(el.id);
    }
  }

  // Move bound text labels along with their shifted host shapes.
  for (const el of newEls) {
    if (el.type === "text" && el.containerId && deltaByNewId.has(el.containerId)) {
      const { dx, dy } = deltaByNewId.get(el.containerId);
      el.x += dx;
      el.y += dy;
    }
  }

  // Pass 2: Remap all internal ID references to preserved IDs.
  for (const el of newEls) {
    if (idRemap.has(el.id)) el.id = idRemap.get(el.id);
    if (el.frameId && idRemap.has(el.frameId)) el.frameId = idRemap.get(el.frameId);
    if (el.containerId && idRemap.has(el.containerId)) el.containerId = idRemap.get(el.containerId);
    if (el.startBinding?.elementId && idRemap.has(el.startBinding.elementId)) {
      el.startBinding = { ...el.startBinding, elementId: idRemap.get(el.startBinding.elementId) };
    }
    if (el.endBinding?.elementId && idRemap.has(el.endBinding.elementId)) {
      el.endBinding = { ...el.endBinding, elementId: idRemap.get(el.endBinding.elementId) };
    }
    if (Array.isArray(el.boundElements)) {
      el.boundElements = el.boundElements.map(b => ({
        ...b,
        id: idRemap.get(b.id) ?? b.id,
      }));
    }
  }

  reconcileBoundElements(newEls);

  // Re-settle arrows against any user-shifted shapes.
  const newRoot = newEls[0];
  const newChildren = newEls.slice(1);
  settleDiagramEdges(newChildren);

  // Recompute root frame bounds to enclose all children (including user-shifted ones).
  if (newRoot && newChildren.length) {
    const b = computeBounds(newChildren);
    newRoot.x = b.x - ROOT_FRAME_PAD;
    newRoot.y = b.y - ROOT_FRAME_PAD;
    newRoot.width = b.width + ROOT_FRAME_PAD * 2;
    newRoot.height = b.height + ROOT_FRAME_PAD * 2;
  }

  const removedIds = prevBlockEls.filter(el => !matchedPrevIds.has(el.id)).map(el => el.id);

  return {
    ok: true,
    lang: imported.lang,
    diagramType: imported.diagramType,
    blockId: targetBlockId,
    version: nextVersion,
    elements: [...unrelated, ...newEls],
    addedIds,
    updatedIds,
    removedIds,
    warnings: imported.warnings,
  };
}
