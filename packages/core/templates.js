// @ts-check
// Interactive Example Boards & Templates Gallery (#25).
// Strictly pure: no DOM, Node, or host globals. Every generated scene is a Protocol v1.1-valid
// Excalidraw v2 document whose elements and appState pass `opProblem` validation.

import { BASE_LAYER, emptyScene, makeElement, textSize } from "./model.js";
import { Doc } from "./doc.js";
import { settle } from "./geometry.js";
import { timelineEnd } from "./anim.js";
import { buildLinkCard } from "./link-card.js";

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   boardTitle: string,
 *   desc: string,
 *   category: "tour" | "diagram" | "presentation" | "workshop" | "animation",
 * }} TemplateMeta
 */

/** @type {readonly TemplateMeta[]} */
export const TEMPLATES = Object.freeze([
  Object.freeze({
    id: "plenary-tour",
    title: "Plenary Interactive Tour",
    boardTitle: "Plenary Interactive Tour",
    desc: "4-frame guided tour with views, layers, animations & link cards",
    category: "tour",
  }),
  Object.freeze({
    id: "architecture",
    title: "System Architecture",
    boardTitle: "System Architecture",
    desc: "Multi-tier animated flow with progressive-reveal layers",
    category: "diagram",
  }),
  Object.freeze({
    id: "presentation",
    title: "Presentation Deck",
    boardTitle: "Presentation Deck",
    desc: "3 clean 16:9 slides with Named Views for Presentation Mode",
    category: "presentation",
  }),
  Object.freeze({
    id: "retro",
    title: "Team Retro",
    boardTitle: "Team Retro",
    desc: "3-column framed retro board with starter sticky notes",
    category: "workshop",
  }),
  Object.freeze({
    id: "animation-playground",
    title: "Animation Playground",
    boardTitle: "Animation Playground",
    desc: "Side-by-side showcase of pop, fade, draw, dissolve & wipe presets",
    category: "animation",
  }),
]);

export const TEMPLATE_IDS = Object.freeze(TEMPLATES.map(t => t.id));

/** Look up template metadata by id (also resolves legacy "deck" alias to "presentation"). */
export function getTemplate(id) {
  const key = id === "deck" ? "presentation" : id;
  return TEMPLATES.find(t => t.id === key) ?? null;
}

// ── Pure scene-building helpers ────────────────────────────────────────────

/** @type {Record<string, [number, number]>} */
const SIDE_FIXED = {
  top: [0.5, 0],
  right: [1, 0.5],
  bottom: [0.5, 1],
  left: [0, 0.5],
};

function animSpec(preset, start, duration = 600, extra = {}) {
  return { preset, start, duration, ...extra };
}

function makeLayer(id, name, { visible = true, locked = false, opacity = 100 } = {}) {
  return { id, name, visible, locked, opacity };
}

function makeFrame({ id = null, x, y, w, h, name, layer = BASE_LAYER, stroke = "#adb5bd" }) {
  return makeElement("frame", {
    ...(id ? { id } : {}),
    x,
    y,
    width: w,
    height: h,
    name,
    strokeColor: stroke,
    backgroundColor: "transparent",
    strokeWidth: 1,
    roughness: 0,
    customData: { layer, z: 0 },
  });
}

function makeText({ x, y, text, fontSize = 20, fontFamily = 2, color = "#1e1e1e", layer = BASE_LAYER, textAlign = "left", anim = null }) {
  const sz = textSize(text, fontSize, 1.25, fontFamily);
  return makeElement("text", {
    x,
    y,
    width: Math.ceil(sz.w),
    height: Math.ceil(sz.h),
    text,
    originalText: text,
    fontSize,
    fontFamily,
    textAlign,
    verticalAlign: "top",
    strokeColor: color,
    customData: { layer, z: 0, ...(anim ? { anim } : {}) },
  });
}

function makeBox({
  type = "rectangle",
  x,
  y,
  w,
  h,
  label = "",
  fill = "#f8f9fa",
  stroke = "#1e1e1e",
  textColor = "#1e1e1e",
  fontSize = 18,
  fontFamily = 2,
  strokeWidth = 2,
  strokeStyle = "solid",
  roughness = 1,
  roundness = { type: 3 },
  layer = BASE_LAYER,
  anim = null,
}) {
  const shape = makeElement(type, {
    x,
    y,
    width: w,
    height: h,
    backgroundColor: fill,
    strokeColor: stroke,
    strokeWidth,
    strokeStyle,
    roughness,
    roundness: type === "rectangle" ? roundness : null,
    customData: { layer, z: 0, ...(anim ? { anim } : {}) },
  });
  if (!label) return { shape, labelEl: null, elements: [shape] };
  const sz = textSize(label, fontSize, 1.25, fontFamily);
  const labelEl = makeElement("text", {
    x: x + Math.max(8, (w - sz.w) / 2),
    y: y + Math.max(8, (h - sz.h) / 2),
    width: Math.min(w - 16, Math.ceil(sz.w)),
    height: Math.ceil(sz.h),
    text: label,
    originalText: label,
    fontSize,
    fontFamily,
    textAlign: "center",
    verticalAlign: "middle",
    strokeColor: textColor,
    containerId: shape.id,
    customData: { layer, z: 0, ...(anim ? { anim: { ...anim } } : {}) },
  });
  shape.boundElements = [{ id: labelEl.id, type: "text" }];
  return { shape, labelEl, elements: [shape, labelEl] };
}

function attachBoundRef(shape, ref) {
  if (!Array.isArray(shape.boundElements)) shape.boundElements = [];
  shape.boundElements.push(ref);
}

function makeBoundArrow({
  from,
  to,
  fromSide = "right",
  toSide = "left",
  label = "",
  stroke = "#495057",
  strokeWidth = 2,
  strokeStyle = "solid",
  elbowed = false,
  layer = BASE_LAYER,
  anim = null,
}) {
  const startFixed = SIDE_FIXED[fromSide] ?? SIDE_FIXED.right;
  const endFixed = SIDE_FIXED[toSide] ?? SIDE_FIXED.left;
  const sx = from.x + startFixed[0] * from.width;
  const sy = from.y + startFixed[1] * from.height;
  const ex = to.x + endFixed[0] * to.width;
  const ey = to.y + endFixed[1] * to.height;
  const arrow = makeElement("arrow", {
    x: sx,
    y: sy,
    width: Math.abs(ex - sx),
    height: Math.abs(ey - sy),
    points: [[0, 0], [ex - sx, ey - sy]],
    strokeColor: stroke,
    strokeWidth,
    strokeStyle,
    roughness: 1,
    ...(elbowed ? { elbowed: true } : {}),
    startBinding: { elementId: from.id, focus: 0, gap: 6, fixedPoint: [...startFixed], side: fromSide },
    endBinding: { elementId: to.id, focus: 0, gap: 6, fixedPoint: [...endFixed], side: toSide },
    customData: { layer, z: 0, ...(anim ? { anim } : {}) },
  });
  attachBoundRef(from, { id: arrow.id, type: "arrow" });
  attachBoundRef(to, { id: arrow.id, type: "arrow" });
  if (!label) return { arrow, labelEl: null, elements: [arrow] };
  const sz = textSize(label, 14, 1.25, 2);
  const labelEl = makeElement("text", {
    x: (sx + ex) / 2 - sz.w / 2,
    y: (sy + ey) / 2 - sz.h / 2,
    width: Math.ceil(sz.w),
    height: Math.ceil(sz.h),
    text: label,
    originalText: label,
    fontSize: 14,
    fontFamily: 2,
    textAlign: "center",
    verticalAlign: "middle",
    strokeColor: stroke,
    containerId: arrow.id,
    customData: { layer, z: 0, ...(anim ? { anim: { ...anim } } : {}) },
  });
  arrow.boundElements = [{ id: labelEl.id, type: "text" }];
  return { arrow, labelEl, elements: [arrow, labelEl] };
}

function makeCard({ url, title, x, y, w = 360, h = 112, layer = BASE_LAYER, anim = null }) {
  const card = buildLinkCard(url, { x, y, width: w, height: h, title, layer });
  if (!card) throw new Error(`Invalid template link card URL: ${url}`);
  if (anim) card.customData = { ...card.customData, anim };
  return card;
}

function finalizeScene({ elements, layers, views = [], minDuration = 3000, viewBackgroundColor = "#ffffff" }) {
  elements.forEach((el, i) => {
    el.customData = { ...el.customData, z: i + 1 };
  });
  const scene = emptyScene();
  scene.source = "plenary";
  scene.elements = elements;
  scene.appState.viewBackgroundColor = viewBackgroundColor;
  scene.appState.herdr = {
    layers,
    views,
    timeline: { duration: Math.min(3_600_000, Math.max(minDuration, timelineEnd(elements) + 600)) },
  };
  // Settle bound arrow geometry against the Doc so endpoints match shape perimeters exactly.
  const doc = new Doc(scene);
  for (const el of elements) {
    if (el.type === "arrow" && (el.startBinding || el.endBinding)) settle(doc, el);
  }
  return scene;
}

// ── 1. Plenary Interactive Tour ────────────────────────────────────────────

function buildPlenaryTour() {
  // Base Canvas is last so Editor's default active layer is always visible across every Named View.
  const layers = [
    makeLayer("callouts", "Callouts & Links"),
    makeLayer("annotations", "Annotations"),
    makeLayer(BASE_LAYER, "Base Canvas"),
  ];
  const els = [];

  // 4 frames in a 2x2 presentation grid (960x540 each, 120px gap).
  const f1 = makeFrame({ x: 0, y: 0, w: 960, h: 540, name: "1. Welcome" });
  const f2 = makeFrame({ x: 1080, y: 0, w: 960, h: 540, name: "2. Perimeter Bindings" });
  const f3 = makeFrame({ x: 0, y: 660, w: 960, h: 540, name: "3. Layers & Views" });
  const f4 = makeFrame({ x: 1080, y: 660, w: 960, h: 540, name: "4. Animations & Collab" });
  els.push(f1, f2, f3, f4);

  // Frame 1: Welcome
  els.push(
    makeText({ x: 48, y: 40, text: "Welcome to Plenary", fontSize: 34, fontFamily: 2, color: "#1e1e1e", anim: animSpec("pop", 0, 550) }),
    makeText({ x: 48, y: 92, text: "Multiplayer canvas for system diagrams, decks, and live workshops", fontSize: 18, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 220, 600) }),
  );
  const p1 = makeBox({ x: 48, y: 164, w: 256, h: 136, label: "1. Sketch & Bind\nShapes + smart arrows", fill: "#dbe4ff", stroke: "#3b5bdb", anim: animSpec("pop", 420, 550) });
  const p2 = makeBox({ x: 352, y: 164, w: 256, h: 136, label: "2. Layer & Present\nFrames + Named Views", fill: "#d3f9d8", stroke: "#2b8a3e", anim: animSpec("wipe-right", 680, 600) });
  const p3 = makeBox({ x: 656, y: 164, w: 256, h: 136, label: "3. Animate & Link\nTimelines + rich cards", fill: "#fff3bf", stroke: "#e67700", anim: animSpec("pop", 940, 550) });
  const a12 = makeBoundArrow({ from: p1.shape, to: p2.shape, fromSide: "right", toSide: "left", stroke: "#3b5bdb", anim: animSpec("draw", 560, 400) });
  const a23 = makeBoundArrow({ from: p2.shape, to: p3.shape, fromSide: "right", toSide: "left", stroke: "#2b8a3e", anim: animSpec("draw", 820, 400) });
  const tip1 = makeBox({
    x: 48, y: 356, w: 864, h: 118,
    label: "Tip: Open Presentation Mode or pick a Named View to step through all 4 frames.\nPress Shift+Space anytime to replay the staggered animations.",
    fill: "#f3f0ff", stroke: "#7048e8", fontSize: 17, layer: "callouts",
    anim: animSpec("dissolve-in", 1140, 600),
  });
  els.push(...p1.elements, ...p2.elements, ...p3.elements, ...a12.elements, ...a23.elements, ...tip1.elements);

  // Frame 2: Perimeter Bindings
  els.push(
    makeText({ x: 1128, y: 40, text: "Perimeter Arrow Bindings", fontSize: 30, fontFamily: 2, anim: animSpec("pop", 1400, 550) }),
    makeText({ x: 1128, y: 88, text: "Arrows lock to exact edges & ports and track shapes as you move them", fontSize: 17, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 1560, 550) }),
  );
  const bClient = makeBox({ x: 1136, y: 196, w: 190, h: 96, label: "Client App", fill: "#d0ebff", stroke: "#1971c2", anim: animSpec("pop", 1720, 500) });
  const bRouter = makeBox({ type: "diamond", x: 1456, y: 174, w: 168, h: 140, label: "Edge\nRouter", fill: "#fff3bf", stroke: "#f08c00", anim: animSpec("pop", 1960, 500) });
  const bCluster = makeBox({ type: "ellipse", x: 1756, y: 196, w: 196, h: 96, label: "Sync Cluster", fill: "#d3f9d8", stroke: "#2b8a3e", anim: animSpec("pop", 2200, 500) });
  const ba1 = makeBoundArrow({ from: bClient.shape, to: bRouter.shape, fromSide: "right", toSide: "left", label: "WS", stroke: "#1971c2", anim: animSpec("draw", 1840, 420) });
  const ba2 = makeBoundArrow({ from: bRouter.shape, to: bCluster.shape, fromSide: "right", toSide: "left", label: "ops", stroke: "#2b8a3e", anim: animSpec("draw", 2080, 420) });
  const bNote = makeBox({
    x: 1136, y: 374, w: 816, h: 102,
    label: "Try dragging Edge Router — both perimeter-bound arrows stay cleanly attached.",
    fill: "#f8f9fa", stroke: "#868e96", fontSize: 17, layer: "annotations",
    anim: animSpec("wipe-right", 2420, 600),
  });
  els.push(...bClient.elements, ...bRouter.elements, ...bCluster.elements, ...ba1.elements, ...ba2.elements, ...bNote.elements);

  // Frame 3: Layers & Views
  els.push(
    makeText({ x: 48, y: 700, text: "Layers & Named Views", fontSize: 30, fontFamily: 2, anim: animSpec("pop", 2680, 550) }),
    makeText({ x: 48, y: 748, text: "Solo or filter layers locally without changing what collaborators see", fontSize: 17, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 2820, 550) }),
  );
  const l1 = makeBox({ x: 48, y: 806, w: 410, h: 92, label: "Base Canvas Layer\nFrames, core shapes & connectors", fill: "#e7f5ff", stroke: "#1c7ed6", fontSize: 16, layer: BASE_LAYER, anim: animSpec("wipe-right", 2960, 550) });
  const l2 = makeBox({ x: 48, y: 922, w: 410, h: 92, label: "Annotations Layer\nReview notes & diagram callouts", fill: "#fff4e6", stroke: "#d9480f", fontSize: 16, layer: "annotations", anim: animSpec("wipe-right", 3180, 550) });
  const l3 = makeBox({ x: 48, y: 1038, w: 410, h: 92, label: "Callouts & Links Layer\nEmbedded GitHub, Linear & ADO cards", fill: "#f3f0ff", stroke: "#7950f2", fontSize: 16, layer: "callouts", anim: animSpec("wipe-right", 3400, 550) });
  const lSummary = makeBox({
    x: 504, y: 806, w: 408, h: 324,
    label: "Saved Views in This Board\n\n• 1. Welcome (all layers)\n• 2. Perimeter Bindings\n• 3. Layers & Views (all layers)\n• 3b. Base Layer Only\n• 4. Animations & Collab",
    fill: "#f8f9fa", stroke: "#495057", fontSize: 16, layer: "annotations",
    anim: animSpec("dissolve-in", 3580, 600),
  });
  els.push(...l1.elements, ...l2.elements, ...l3.elements, ...lSummary.elements);

  // Frame 4: Animations & Collab + Rich Link Cards
  els.push(
    makeText({ x: 1128, y: 700, text: "Animations & Rich Link Cards", fontSize: 30, fontFamily: 2, anim: animSpec("pop", 3840, 550) }),
    makeText({ x: 1128, y: 748, text: "Paste GitHub, Linear, Jira, or Azure DevOps links for live cards", fontSize: 17, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 3980, 550) }),
  );
  const ghCard = makeCard({
    url: "https://github.com/ryanthedev/plenary/pull/42",
    title: "PR #42 · Interactive templates & tour",
    x: 1128, y: 814, w: 380, h: 112, layer: "callouts",
    anim: animSpec("pop", 4140, 550),
  });
  const linCard = makeCard({
    url: "https://linear.app/plenary/issue/PLN-128/presentation-mode-views",
    title: "Presentation mode named views",
    x: 1560, y: 814, w: 380, h: 112, layer: "callouts",
    anim: animSpec("pop", 4340, 550),
  });
  const adoCard = makeCard({
    url: "https://dev.azure.com/plenary/core/_workitems/edit/305",
    title: "Work Item #305 · Realtime sync v1.1",
    x: 1128, y: 960, w: 380, h: 112, layer: "callouts",
    anim: animSpec("pop", 4540, 550),
  });
  const playCue = makeBox({
    x: 1560, y: 960, w: 380, h: 112,
    label: "Ready to explore?\nHit Shift+Space or edit any card!",
    fill: "#e6fcf5", stroke: "#0ca678", fontSize: 17, layer: "annotations",
    anim: animSpec("wipe-right", 4740, 600),
  });
  els.push(ghCard, linCard, adoCard, ...playCue.elements);

  const views = [
    { id: "tour-welcome", name: "1. Welcome", frameId: f1.id, visibleLayers: [BASE_LAYER, "annotations", "callouts"] },
    { id: "tour-bindings", name: "2. Perimeter Bindings", frameId: f2.id, visibleLayers: [BASE_LAYER, "annotations"] },
    { id: "tour-layers", name: "3. Layers & Views", frameId: f3.id, visibleLayers: [BASE_LAYER, "annotations", "callouts"] },
    { id: "tour-layers-base", name: "3b. Base Layer Only", frameId: f3.id, visibleLayers: [BASE_LAYER] },
    { id: "tour-collab", name: "4. Animations & Collab", frameId: f4.id, visibleLayers: [BASE_LAYER, "annotations", "callouts"] },
  ];

  return finalizeScene({ elements: els, layers, views, minDuration: 5800 });
}

// ── 2. System Architecture ─────────────────────────────────────────────────

function buildArchitecture() {
  // Overview is last so Editor's default active layer is visible in every progressive-reveal view.
  const layers = [
    makeLayer("observability", "Observability"),
    makeLayer("infra", "Infra Details"),
    makeLayer("overview", "Overview"),
  ];
  const els = [];

  const frame = makeFrame({ x: 0, y: 0, w: 1280, h: 760, name: "System Architecture", layer: "overview" });
  els.push(
    frame,
    makeText({ x: 48, y: 36, text: "System Architecture", fontSize: 32, fontFamily: 2, layer: "overview", anim: animSpec("pop", 0, 500) }),
    makeText({ x: 48, y: 82, text: "Request path across Client, Edge, API, Storage & Async Queue", fontSize: 17, fontFamily: 2, color: "#495057", layer: "overview", anim: animSpec("dissolve-in", 180, 500) }),
  );

  // Overview tier (100px horizontal gaps so arrow labels sit cleanly with visible shaft & arrowhead)
  const client = makeBox({ x: 48, y: 220, w: 184, h: 108, label: "Web & Mobile\nClient", fill: "#d0ebff", stroke: "#1971c2", layer: "overview", anim: animSpec("pop", 320, 500) });
  const edge = makeBox({ x: 332, y: 220, w: 184, h: 108, label: "Edge CDN\n& WAF", fill: "#e5dbff", stroke: "#6741d9", layer: "overview", anim: animSpec("pop", 580, 500) });
  const api = makeBox({ x: 616, y: 220, w: 192, h: 108, label: "API Gateway\n& Services", fill: "#d3f9d8", stroke: "#2b8a3e", layer: "overview", anim: animSpec("pop", 840, 500) });
  const db = makeBox({ x: 912, y: 120, w: 216, h: 96, label: "Primary DB\n(Postgres)", fill: "#fff3bf", stroke: "#e67700", layer: "overview", anim: animSpec("pop", 1100, 500) });
  const queue = makeBox({ x: 912, y: 292, w: 216, h: 96, label: "Event Queue\n(NATS)", fill: "#ffe3e3", stroke: "#c92a2a", layer: "overview", anim: animSpec("pop", 1280, 500) });

  const e1 = makeBoundArrow({ from: client.shape, to: edge.shape, fromSide: "right", toSide: "left", label: "HTTPS", stroke: "#1971c2", layer: "overview", anim: animSpec("draw", 450, 420) });
  const e2 = makeBoundArrow({ from: edge.shape, to: api.shape, fromSide: "right", toSide: "left", label: "mTLS", stroke: "#6741d9", layer: "overview", anim: animSpec("draw", 710, 420) });
  const e3 = makeBoundArrow({ from: api.shape, to: db.shape, fromSide: "right", toSide: "left", label: "SQL", stroke: "#e67700", layer: "overview", anim: animSpec("draw", 970, 420) });
  const e4 = makeBoundArrow({ from: api.shape, to: queue.shape, fromSide: "right", toSide: "left", label: "Pub", stroke: "#c92a2a", layer: "overview", anim: animSpec("draw", 1150, 420) });
  els.push(...client.elements, ...edge.elements, ...api.elements, ...db.elements, ...queue.elements, ...e1.elements, ...e2.elements, ...e3.elements, ...e4.elements);

  // Infra Details layer (80px vertical gap from Queue so "Jobs" label never covers arrowhead)
  const cache = makeBox({ x: 332, y: 468, w: 184, h: 92, label: "Redis Cache\nTTL 60s", fill: "#e7f5ff", stroke: "#1c7ed6", fontSize: 16, layer: "infra", anim: animSpec("wipe-right", 1480, 550) });
  const worker = makeBox({ x: 912, y: 468, w: 216, h: 92, label: "Async Workers\nJobs & Webhooks", fill: "#fff0f6", stroke: "#a61e4d", fontSize: 16, layer: "infra", anim: animSpec("wipe-right", 1660, 550) });
  const eCache = makeBoundArrow({ from: api.shape, to: cache.shape, fromSide: "bottom", toSide: "top", label: "Cache", stroke: "#1c7ed6", strokeStyle: "dashed", layer: "infra", anim: animSpec("draw", 1560, 400) });
  const eWork = makeBoundArrow({ from: queue.shape, to: worker.shape, fromSide: "bottom", toSide: "top", label: "Jobs", stroke: "#a61e4d", layer: "infra", anim: animSpec("draw", 1740, 400) });
  els.push(...cache.elements, ...worker.elements, ...eCache.elements, ...eWork.elements);

  // Observability layer
  const telemetry = makeBox({
    x: 48, y: 604, w: 364, h: 112,
    label: "Observability & SLOs\nPrometheus · OTel Traces · P99 < 80ms",
    fill: "#f8f9fa", stroke: "#495057", fontSize: 16, layer: "observability",
    anim: animSpec("dissolve-in", 1920, 550),
  });
  const ghCard = makeCard({
    url: "https://github.com/ryanthedev/plenary/issues/88",
    title: "Issue #88 · Multi-region failover runbook",
    x: 458, y: 604, w: 364, h: 112, layer: "observability",
    anim: animSpec("pop", 2120, 550),
  });
  const linCard = makeCard({
    url: "https://linear.app/plenary/issue/INF-42/zero-downtime-migrations",
    title: "Zero-downtime schema migrations",
    x: 868, y: 604, w: 364, h: 112, layer: "observability",
    anim: animSpec("pop", 2320, 550),
  });
  els.push(...telemetry.elements, ghCard, linCard);

  const views = [
    { id: "arch-overview", name: "1. Overview", frameId: frame.id, visibleLayers: ["overview"] },
    { id: "arch-infra", name: "2. Overview + Infra", frameId: frame.id, visibleLayers: ["overview", "infra"] },
    { id: "arch-full", name: "3. Full Stack + Observability", frameId: frame.id, visibleLayers: ["overview", "infra", "observability"] },
  ];

  return finalizeScene({ elements: els, layers, views, minDuration: 3400 });
}

// ── 3. Presentation Deck ───────────────────────────────────────────────────

function buildPresentation() {
  // Slides is last so Editor's default active layer is visible in every slide view.
  const layers = [
    makeLayer("notes", "Speaker Notes"),
    makeLayer(BASE_LAYER, "Slides"),
  ];
  const els = [];

  // 3 clean 16:9 frames (960x540, 100px horizontal gap)
  const s1 = makeFrame({ x: 0, y: 0, w: 960, h: 540, name: "Title" });
  const s2 = makeFrame({ x: 1060, y: 0, w: 960, h: 540, name: "Problem & Architecture" });
  const s3 = makeFrame({ x: 2120, y: 0, w: 960, h: 540, name: "Next Steps" });
  els.push(s1, s2, s3);

  // Slide 1: Title
  const badge = makeBox({ x: 64, y: 72, w: 236, h: 42, label: "Q3 PRODUCT REVIEW", fill: "#dbe4ff", stroke: "#3b5bdb", fontSize: 14, anim: animSpec("fade", 0, 450) });
  els.push(
    ...badge.elements,
    makeText({ x: 64, y: 156, text: "Scaling Collaborative\nWhiteboards", fontSize: 44, fontFamily: 2, color: "#1e1e1e", anim: animSpec("pop", 180, 550) }),
    makeText({ x: 64, y: 292, text: "Architecture, milestones, and rollout plan for the quarter", fontSize: 20, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 420, 550) }),
    makeText({ x: 64, y: 452, text: "Prepared by Platform & Design · Press Present to step through slides", fontSize: 15, fontFamily: 2, color: "#868e96", anim: animSpec("fade", 620, 450) }),
  );

  // Slide 2: Problem & Architecture
  els.push(
    makeText({ x: 1120, y: 44, text: "Problem & Architecture", fontSize: 30, fontFamily: 2, anim: animSpec("pop", 820, 500) }),
    makeText({ x: 1120, y: 92, text: "Moving from disconnected docs to one multiplayer source of truth", fontSize: 17, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 980, 500) }),
  );
  const prob = makeBox({
    x: 1120, y: 154, w: 380, h: 210,
    label: "Current Pain Points\n\n• Static exports drift out of date\n• Feedback split across 4 tools\n• No live presentation views",
    fill: "#fff4e6", stroke: "#e8590c", fontSize: 16,
    anim: animSpec("wipe-right", 1120, 550),
  });
  const arch = makeBox({
    x: 1580, y: 154, w: 380, h: 210,
    label: "Target Solution\n\n• Realtime CRDT board sync\n• Framed Named Views for decks\n• Embedded issue & PR cards",
    fill: "#d3f9d8", stroke: "#2b8a3e", fontSize: 16,
    anim: animSpec("wipe-right", 1420, 550),
  });
  const s2Arrow = makeBoundArrow({ from: prob.shape, to: arch.shape, fromSide: "right", toSide: "left", stroke: "#495057", anim: animSpec("draw", 1300, 400) });
  const s2Note = makeBox({
    x: 1120, y: 412, w: 840, h: 82,
    label: "Speaker Note: Demo switching Named Views live to highlight layer filtering.",
    fill: "#f8f9fa", stroke: "#868e96", fontSize: 15, layer: "notes",
    anim: animSpec("fade", 1620, 450),
  });
  els.push(...prob.elements, ...arch.elements, ...s2Arrow.elements, ...s2Note.elements);

  // Slide 3: Next Steps
  els.push(
    makeText({ x: 2180, y: 44, text: "Next Steps", fontSize: 30, fontFamily: 2, anim: animSpec("pop", 1820, 500) }),
    makeText({ x: 2180, y: 92, text: "Three concrete milestones to reach general availability", fontSize: 17, fontFamily: 2, color: "#495057", anim: animSpec("dissolve-in", 1960, 500) }),
  );
  const m1 = makeBox({ x: 2180, y: 176, w: 248, h: 216, label: "Phase 1 · Weeks 1–2\n\nDesign Review\n& Template Polish", fill: "#dbe4ff", stroke: "#3b5bdb", fontSize: 16, anim: animSpec("pop", 2100, 500) });
  const m2 = makeBox({ x: 2476, y: 176, w: 248, h: 216, label: "Phase 2 · Weeks 3–4\n\nInternal Beta\n& Load Testing", fill: "#fff3bf", stroke: "#e67700", fontSize: 16, anim: animSpec("pop", 2360, 500) });
  const m3 = makeBox({ x: 2772, y: 176, w: 248, h: 216, label: "Phase 3 · Week 5\n\nGA Launch\n& Customer Docs", fill: "#d3f9d8", stroke: "#2b8a3e", fontSize: 16, anim: animSpec("pop", 2620, 500) });
  const ma1 = makeBoundArrow({ from: m1.shape, to: m2.shape, fromSide: "right", toSide: "left", stroke: "#3b5bdb", anim: animSpec("draw", 2240, 380) });
  const ma2 = makeBoundArrow({ from: m2.shape, to: m3.shape, fromSide: "right", toSide: "left", stroke: "#e67700", anim: animSpec("draw", 2500, 380) });
  els.push(...m1.elements, ...m2.elements, ...m3.elements, ...ma1.elements, ...ma2.elements);

  const views = [
    { id: "deck-title", name: "1. Title", frameId: s1.id, visibleLayers: [BASE_LAYER] },
    { id: "deck-arch", name: "2. Problem & Architecture", frameId: s2.id, visibleLayers: [BASE_LAYER] },
    { id: "deck-next", name: "3. Next Steps", frameId: s3.id, visibleLayers: [BASE_LAYER] },
    { id: "deck-arch-notes", name: "2b. Architecture + Notes", frameId: s2.id, visibleLayers: [BASE_LAYER, "notes"] },
  ];

  return finalizeScene({ elements: els, layers, views, minDuration: 3600 });
}

// ── 4. Team Retro ──────────────────────────────────────────────────────────

function buildRetro() {
  const layers = [
    makeLayer(BASE_LAYER, "Columns"),
    makeLayer("stickies", "Sticky Notes"),
  ];
  const els = [];

  const c1 = makeFrame({ x: 0, y: 0, w: 380, h: 640, name: "What went well", stroke: "#2b8a3e" });
  const c2 = makeFrame({ x: 420, y: 0, w: 380, h: 640, name: "What to improve", stroke: "#e67700" });
  const c3 = makeFrame({ x: 840, y: 0, w: 380, h: 640, name: "Action items", stroke: "#3b5bdb" });
  els.push(c1, c2, c3);

  const columns = [
    {
      x: 30,
      header: "What went well",
      headerColor: "#2b8a3e",
      fill: "#d3f9d8",
      stroke: "#2b8a3e",
      notes: [
        "Shipped multiplayer presence ahead of schedule",
        "Zero P0 regressions during v1.1 protocol rollout",
        "Fast async design & engineering reviews",
      ],
    },
    {
      x: 450,
      header: "What to improve",
      headerColor: "#d9480f",
      fill: "#fff3bf",
      stroke: "#e67700",
      notes: [
        "CI flakiness slowed down Friday merges",
        "Clearer ownership for starter templates",
        "Error states could link directly to docs",
      ],
    },
    {
      x: 870,
      header: "Action items",
      headerColor: "#3b5bdb",
      fill: "#dbe4ff",
      stroke: "#3b5bdb",
      notes: [
        "[ ] Quarantine flaky CI specs (Alex)",
        "[ ] Publish interactive templates (Sam)",
        "[ ] Add recovery hints to API errors (Jo)",
      ],
    },
  ];

  let start = 0;
  for (const col of columns) {
    els.push(makeText({ x: col.x, y: 28, text: col.header, fontSize: 22, fontFamily: 2, color: col.headerColor, layer: BASE_LAYER }));
    col.notes.forEach((note, idx) => {
      const card = makeBox({
        x: col.x,
        y: 88 + idx * 172,
        w: 320,
        h: 140,
        label: note,
        fill: col.fill,
        stroke: col.stroke,
        fontSize: 16,
        fontFamily: 1,
        strokeWidth: 1,
        layer: "stickies",
        anim: animSpec("pop", start, 480),
      });
      els.push(...card.elements);
      start += 180;
    });
  }

  const views = [
    { id: "retro-well", name: "What went well", frameId: c1.id, visibleLayers: [BASE_LAYER, "stickies"] },
    { id: "retro-improve", name: "What to improve", frameId: c2.id, visibleLayers: [BASE_LAYER, "stickies"] },
    { id: "retro-actions", name: "Action items", frameId: c3.id, visibleLayers: [BASE_LAYER, "stickies"] },
  ];

  return finalizeScene({ elements: els, layers, views, minDuration: 2600 });
}

// ── 5. Animation Playground ────────────────────────────────────────────────

function buildAnimationPlayground() {
  const layers = [makeLayer(BASE_LAYER, "Stage")];
  const els = [];

  const stage = makeFrame({ x: 0, y: 0, w: 1120, h: 680, name: "Animation Playground" });
  els.push(
    stage,
    makeText({ x: 48, y: 36, text: "Animation Playground", fontSize: 32, fontFamily: 2 }),
    makeText({ x: 48, y: 82, text: "Press Shift+Space or hit Play in the timeline to inspect all 6 presets", fontSize: 17, fontFamily: 2, color: "#495057" }),
  );

  // 2x3 grid of preset cards (w: 310, h: 210, gapX: 47, gapY: 44)
  const popTile = makeBox({
    x: 48, y: 148, w: 310, h: 210,
    label: "pop\n\nSpring back-out entrance\n(0.0s – 0.6s)",
    fill: "#dbe4ff", stroke: "#3b5bdb", fontSize: 18,
    anim: animSpec("pop", 0, 600),
  });
  const fadeTile = makeBox({
    x: 405, y: 148, w: 310, h: 210,
    label: "fade\n\nSmooth opacity ramp\n(0.4s – 1.1s)",
    fill: "#d3f9d8", stroke: "#2b8a3e", fontSize: 18,
    anim: animSpec("fade", 400, 700),
  });

  // Draw tile: container label + animated freedraw stroke with clear vertical separation
  const drawBox = makeBox({
    x: 762, y: 148, w: 310, h: 210,
    label: "draw\n\n\n\nProgressive path stroke\n(0.8s – 1.7s)",
    fill: "#fff4e6", stroke: "#d9480f", fontSize: 16,
    anim: animSpec("fade", 800, 400),
  });
  const wavePts = [];
  for (let i = 0; i <= 32; i++) wavePts.push([i * 7, Math.sin(i / 3.2) * 12]);
  const drawWave = makeElement("freedraw", {
    x: 805,
    y: 244,
    width: 224,
    height: 24,
    points: wavePts,
    strokeColor: "#d9480f",
    strokeWidth: 3,
    customData: { layer: BASE_LAYER, z: 0, anim: animSpec("draw", 850, 850) },
  });

  const dissolveTile = makeBox({
    x: 48, y: 402, w: 310, h: 210,
    label: "dissolve-in\n\nSubtle scale + opacity\n(1.3s – 2.0s)",
    fill: "#f3f0ff", stroke: "#7048e8", fontSize: 18,
    anim: animSpec("dissolve-in", 1300, 700),
  });
  const wipeRightTile = makeBox({
    x: 405, y: 402, w: 310, h: 210,
    label: "wipe-right\n\nHorizontal clip reveal\n(1.8s – 2.5s)",
    fill: "#fff3bf", stroke: "#e67700", fontSize: 18,
    anim: animSpec("wipe-right", 1800, 700),
  });
  const wipeDownTile = makeBox({
    x: 762, y: 402, w: 310, h: 210,
    label: "wipe-down\n\nVertical clip reveal\n(2.3s – 3.0s)",
    fill: "#ffe3e3", stroke: "#c92a2a", fontSize: 18,
    anim: animSpec("wipe-down", 2300, 700),
  });

  els.push(
    ...popTile.elements,
    ...fadeTile.elements,
    ...drawBox.elements,
    drawWave,
    ...dissolveTile.elements,
    ...wipeRightTile.elements,
    ...wipeDownTile.elements,
  );

  const views = [
    { id: "anim-stage", name: "Animation Stage", frameId: stage.id, visibleLayers: [BASE_LAYER] },
  ];

  return finalizeScene({ elements: els, layers, views, minDuration: 3600 });
}

/**
 * Build a fresh, Protocol v1.1-valid scene for a template id.
 * Returns an empty scene for `"blank"`, or `null` for an unknown template id.
 * @param {string} id
 */
export function buildTemplateScene(id) {
  if (id === "blank") return emptyScene();
  if (id === "plenary-tour") return buildPlenaryTour();
  if (id === "architecture") return buildArchitecture();
  if (id === "presentation" || id === "deck") return buildPresentation();
  if (id === "retro") return buildRetro();
  if (id === "animation-playground") return buildAnimationPlayground();
  return null;
}
