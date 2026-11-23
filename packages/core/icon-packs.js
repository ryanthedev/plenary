// @ts-check
// Built-In 1-Click Cloud & Kubernetes Vector Icon Packs (#2).
// Strictly pure: no DOM, Node, or external image URLs. Every icon is a crisp, grouped set of
// Protocol v1.1-valid vector Plenary elements compatible with `packages/core/library.js`
// `itemFromElements`, rendering identically on Canvas, PNG, SVG, and Excalidraw export.

import { BASE_LAYER, makeElement, newId, textSize } from "./model.js";
import { normalize } from "./geometry.js";
import { itemFromElements } from "./library.js";

const ICON_W = 128;
const ICON_H = 96;

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   category: string,
 *   color: string,
 *   width: number,
 *   height: number,
 * }} IconMeta
 *
 * @typedef {{
 *   id: string,
 *   aliases: readonly string[],
 *   name: string,
 *   description: string,
 *   icons: readonly IconMeta[],
 * }} IconPackMeta
 */

// ── Low-level crisp vector primitives (all coordinates relative to icon origin) ──

function makeCtx({ x = 0, y = 0, layer = BASE_LAYER, z = 0, now = Date.now() }) {
  const ox = Number.isFinite(x) ? x : 0;
  const oy = Number.isFinite(y) ? y : 0;
  const startZ = Number.isFinite(z) ? z : 0;
  const groupId = `ico-${newId()}`;
  /** @type {any[]} */
  const elements = [];

  const push = el => {
    el.groupIds = [groupId];
    el.updated = now;
    el.customData = { layer, z: startZ + elements.length };
    elements.push(el);
    return el;
  };

  const rect = (rx, ry, w, h, opts = {}) => push(makeElement("rectangle", {
    x: ox + rx,
    y: oy + ry,
    width: w,
    height: h,
    strokeColor: opts.stroke ?? "#326ce5",
    backgroundColor: opts.fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: opts.sw ?? 2,
    strokeStyle: opts.style ?? "solid",
    roughness: 0,
    opacity: opts.opacity ?? 100,
    roundness: opts.round === false ? null : { type: 3 },
  }));

  const ellipse = (rx, ry, w, h, opts = {}) => push(makeElement("ellipse", {
    x: ox + rx,
    y: oy + ry,
    width: w,
    height: h,
    strokeColor: opts.stroke ?? "#326ce5",
    backgroundColor: opts.fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: opts.sw ?? 2,
    strokeStyle: opts.style ?? "solid",
    roughness: 0,
    opacity: opts.opacity ?? 100,
  }));

  const diamond = (rx, ry, w, h, opts = {}) => push(makeElement("diamond", {
    x: ox + rx,
    y: oy + ry,
    width: w,
    height: h,
    strokeColor: opts.stroke ?? "#326ce5",
    backgroundColor: opts.fill ?? "transparent",
    fillStyle: "solid",
    strokeWidth: opts.sw ?? 2,
    strokeStyle: opts.style ?? "solid",
    roughness: 0,
    opacity: opts.opacity ?? 100,
  }));

  const polyline = (pts, opts = {}) => {
    const [p0x, p0y] = pts[0];
    const rel = pts.map(([px, py]) => [px - p0x, py - p0y]);
    const type = opts.arrow ? "arrow" : "line";
    const el = makeElement(type, {
      x: ox + p0x,
      y: oy + p0y,
      points: rel,
      strokeColor: opts.stroke ?? "#326ce5",
      backgroundColor: opts.fill ?? "transparent",
      fillStyle: "solid",
      strokeWidth: opts.sw ?? 2,
      strokeStyle: opts.style ?? "solid",
      roughness: 0,
      opacity: opts.opacity ?? 100,
      startArrowhead: opts.startArrow ?? null,
      endArrowhead: opts.arrow ? (opts.endArrow ?? "arrow") : null,
    });
    normalize(el);
    return push(el);
  };

  const label = (text, color = "#1e293b", fontSize = 12) => {
    const sz = textSize(text, fontSize, 1.2, 2);
    const w = Math.min(ICON_W - 10, Math.ceil(sz.w) + 4);
    const h = Math.ceil(sz.h);
    return push(makeElement("text", {
      x: ox + (ICON_W - w) / 2,
      y: oy + ICON_H - h - 7,
      width: w,
      height: h,
      text,
      originalText: text,
      fontSize,
      fontFamily: 2,
      textAlign: "center",
      verticalAlign: "middle",
      strokeColor: color,
      roughness: 0,
    }));
  };

  const card = (accent, tint) => {
    rect(0, 0, ICON_W, ICON_H, { stroke: accent, fill: "#ffffff", sw: 2 });
    rect(8, 8, ICON_W - 16, 58, { stroke: "transparent", fill: tint, sw: 1 });
  };

  return { elements, rect, ellipse, diamond, polyline, label, card };
}

// ── Kubernetes Pack (8 icons) ───────────────────────────────────────────────

const K8S_BLUE = "#326ce5";
const K8S_DARK = "#1d4ed8";
const K8S_TINT = "#eff6ff";
const K8S_MID = "#bfdbfe";

/** @type {Record<string, (c: ReturnType<typeof makeCtx>) => void>} */
const KUBERNETES_BUILDERS = {
  pod(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.diamond(41, 14, 46, 46, { stroke: K8S_BLUE, fill: "#ffffff", sw: 2 });
    c.rect(53, 26, 22, 22, { stroke: K8S_DARK, fill: K8S_MID, sw: 2 });
    c.ellipse(61, 34, 6, 6, { stroke: K8S_DARK, fill: K8S_BLUE, sw: 1 });
    c.label("Pod");
  },

  deployment(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.rect(38, 16, 28, 28, { stroke: "#93c5fd", fill: "#ffffff", sw: 2 });
    c.rect(50, 22, 28, 28, { stroke: K8S_BLUE, fill: K8S_MID, sw: 2 });
    c.rect(62, 28, 28, 28, { stroke: K8S_DARK, fill: K8S_BLUE, sw: 2 });
    c.polyline([[48, 30], [56, 30]], { stroke: K8S_BLUE, sw: 2 });
    c.label("Deployment");
  },

  service(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.polyline([[64, 37], [42, 22]], { stroke: K8S_BLUE, sw: 2 });
    c.polyline([[64, 37], [86, 22]], { stroke: K8S_BLUE, sw: 2 });
    c.polyline([[64, 37], [64, 56]], { stroke: K8S_BLUE, sw: 2 });
    c.ellipse(54, 27, 20, 20, { stroke: K8S_DARK, fill: K8S_BLUE, sw: 2 });
    c.ellipse(37, 17, 10, 10, { stroke: K8S_BLUE, fill: "#ffffff", sw: 2 });
    c.ellipse(81, 17, 10, 10, { stroke: K8S_BLUE, fill: "#ffffff", sw: 2 });
    c.ellipse(59, 51, 10, 10, { stroke: K8S_BLUE, fill: "#ffffff", sw: 2 });
    c.label("Service");
  },

  ingress(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.polyline([[24, 37], [52, 37]], { stroke: K8S_DARK, sw: 2, arrow: true });
    c.rect(56, 16, 10, 42, { stroke: K8S_DARK, fill: K8S_BLUE, sw: 2 });
    c.polyline([[68, 30], [100, 22]], { stroke: K8S_BLUE, sw: 2, arrow: true });
    c.polyline([[68, 44], [100, 52]], { stroke: K8S_BLUE, sw: 2, arrow: true });
    c.label("Ingress");
  },

  configmap(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.rect(42, 14, 44, 46, { stroke: K8S_BLUE, fill: "#ffffff", sw: 2 });
    c.polyline([[50, 25], [78, 25]], { stroke: K8S_DARK, sw: 2 });
    c.polyline([[50, 35], [74, 35]], { stroke: K8S_BLUE, sw: 2 });
    c.polyline([[50, 45], [78, 45]], { stroke: K8S_BLUE, sw: 2 });
    c.polyline([[50, 53], [66, 53]], { stroke: "#60a5fa", sw: 2 });
    c.label("ConfigMap");
  },

  secret(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.ellipse(50, 15, 28, 24, { stroke: K8S_DARK, fill: "transparent", sw: 2.5 });
    c.rect(44, 29, 40, 30, { stroke: K8S_DARK, fill: K8S_MID, sw: 2 });
    c.ellipse(60, 38, 8, 8, { stroke: K8S_DARK, fill: K8S_DARK, sw: 1 });
    c.polyline([[64, 46], [64, 53]], { stroke: K8S_DARK, sw: 2.5 });
    c.label("Secret");
  },

  node(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.rect(34, 15, 60, 44, { stroke: K8S_DARK, fill: "#ffffff", sw: 2 });
    c.rect(41, 22, 46, 12, { stroke: K8S_BLUE, fill: K8S_MID, sw: 1.5 });
    c.rect(41, 39, 46, 12, { stroke: K8S_BLUE, fill: K8S_MID, sw: 1.5 });
    c.ellipse(78, 26, 4, 4, { stroke: K8S_DARK, fill: K8S_DARK, sw: 1 });
    c.ellipse(78, 43, 4, 4, { stroke: K8S_DARK, fill: K8S_DARK, sw: 1 });
    c.label("Node");
  },

  "persistent-volume"(c) {
    c.card(K8S_BLUE, K8S_TINT);
    c.rect(40, 22, 48, 30, { stroke: K8S_BLUE, fill: K8S_MID, sw: 2, round: false });
    c.ellipse(40, 15, 48, 14, { stroke: K8S_DARK, fill: "#ffffff", sw: 2 });
    c.ellipse(40, 45, 48, 14, { stroke: K8S_DARK, fill: K8S_MID, sw: 2 });
    c.polyline([[46, 37], [82, 37]], { stroke: K8S_DARK, sw: 1.5, style: "dashed" });
    c.label("PersistentVolume", "#1e293b", 11);
  },
};

// ── Cloud / Architecture Pack (8 icons) ─────────────────────────────────────

/** @type {Record<string, (c: ReturnType<typeof makeCtx>) => void>} */
const CLOUD_BUILDERS = {
  "load-balancer"(c) {
    const accent = "#7c3aed";
    c.card(accent, "#f5f3ff");
    c.polyline([[24, 37], [46, 37]], { stroke: accent, sw: 2, arrow: true });
    c.diamond(48, 21, 32, 32, { stroke: accent, fill: "#ddd6fe", sw: 2 });
    c.polyline([[80, 31], [102, 22]], { stroke: accent, sw: 2, arrow: true });
    c.polyline([[80, 43], [102, 52]], { stroke: accent, sw: 2, arrow: true });
    c.label("Load Balancer");
  },

  "api-gateway"(c) {
    const accent = "#4f46e5";
    c.card(accent, "#eef2ff");
    c.rect(52, 15, 24, 44, { stroke: accent, fill: "#c7d2fe", sw: 2 });
    c.polyline([[24, 29], [50, 29]], { stroke: accent, sw: 2, arrow: true });
    c.polyline([[50, 45], [24, 45]], { stroke: accent, sw: 2, arrow: true });
    c.polyline([[78, 37], [104, 37]], { stroke: accent, sw: 2, arrow: true });
    c.label("API Gateway");
  },

  "serverless-function"(c) {
    const accent = "#d97706";
    c.card(accent, "#fffbeb");
    c.ellipse(42, 15, 44, 44, { stroke: accent, fill: "#fef3c7", sw: 2 });
    c.polyline([[68, 21], [55, 38], [66, 38], [58, 53]], { stroke: "#b45309", sw: 3 });
    c.label("Serverless Function", "#1e293b", 10.5);
  },

  database(c) {
    const accent = "#0284c7";
    c.card(accent, "#f0f9ff");
    c.rect(40, 21, 48, 32, { stroke: accent, fill: "#bae6fd", sw: 2, round: false });
    c.ellipse(40, 14, 48, 14, { stroke: "#0369a1", fill: "#ffffff", sw: 2 });
    c.ellipse(40, 46, 48, 14, { stroke: "#0369a1", fill: "#bae6fd", sw: 2 });
    c.polyline([[40, 34], [88, 34]], { stroke: "#0369a1", sw: 1.5 });
    c.label("Database");
  },

  "message-queue"(c) {
    const accent = "#e11d48";
    c.card(accent, "#fff1f2");
    c.polyline([[24, 22], [92, 22]], { stroke: accent, sw: 2 });
    c.polyline([[24, 52], [92, 52]], { stroke: accent, sw: 2 });
    c.rect(30, 28, 14, 18, { stroke: accent, fill: "#fecdd3", sw: 1.5 });
    c.rect(49, 28, 14, 18, { stroke: accent, fill: "#fda4af", sw: 1.5 });
    c.rect(68, 28, 14, 18, { stroke: accent, fill: "#fb7185", sw: 1.5 });
    c.polyline([[86, 37], [104, 37]], { stroke: accent, sw: 2, arrow: true });
    c.label("Message Queue");
  },

  "object-storage"(c) {
    const accent = "#059669";
    c.card(accent, "#ecfdf5");
    c.rect(42, 22, 44, 34, { stroke: accent, fill: "#a7f3d0", sw: 2 });
    c.ellipse(42, 16, 44, 12, { stroke: "#047857", fill: "#ffffff", sw: 2 });
    c.rect(54, 34, 20, 14, { stroke: "#047857", fill: "#ffffff", sw: 1.5 });
    c.label("Object Storage");
  },

  cache(c) {
    const accent = "#dc2626";
    c.card(accent, "#fef2f2");
    c.ellipse(42, 15, 44, 44, { stroke: accent, fill: "#fee2e2", sw: 2 });
    c.diamond(50, 23, 28, 28, { stroke: "#b91c1c", fill: "#ffffff", sw: 2 });
    c.ellipse(60, 33, 8, 8, { stroke: accent, fill: accent, sw: 1 });
    c.label("Cache");
  },

  cdn(c) {
    const accent = "#0891b2";
    c.card(accent, "#ecfeff");
    c.ellipse(43, 16, 42, 42, { stroke: accent, fill: "#cffafe", sw: 2 });
    c.ellipse(54, 16, 20, 42, { stroke: accent, fill: "transparent", sw: 1.5 });
    c.polyline([[43, 37], [85, 37]], { stroke: accent, sw: 1.5 });
    c.ellipse(30, 21, 8, 8, { stroke: "#0e7490", fill: accent, sw: 1 });
    c.ellipse(90, 45, 8, 8, { stroke: "#0e7490", fill: accent, sw: 1 });
    c.label("CDN");
  },
};

// ── Pack Registry ───────────────────────────────────────────────────────────

/** @type {readonly IconPackMeta[]} */
export const ICON_PACKS = Object.freeze([
  Object.freeze({
    id: "kubernetes",
    aliases: Object.freeze(["k8s"]),
    name: "Kubernetes",
    description: "Core Kubernetes workload, networking, config, and storage icons",
    icons: Object.freeze([
      Object.freeze({ id: "pod", name: "Pod", category: "workload", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "deployment", name: "Deployment", category: "workload", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "service", name: "Service", category: "network", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "ingress", name: "Ingress", category: "network", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "configmap", name: "ConfigMap", category: "config", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "secret", name: "Secret", category: "config", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "node", name: "Node", category: "cluster", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "persistent-volume", name: "PersistentVolume", category: "storage", color: K8S_BLUE, width: ICON_W, height: ICON_H }),
    ]),
  }),
  Object.freeze({
    id: "cloud",
    aliases: Object.freeze(["cloud-aws", "architecture"]),
    name: "Cloud & Architecture",
    description: "Vendor-neutral cloud infrastructure and distributed systems icons",
    icons: Object.freeze([
      Object.freeze({ id: "load-balancer", name: "Load Balancer", category: "network", color: "#7c3aed", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "api-gateway", name: "API Gateway", category: "network", color: "#4f46e5", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "serverless-function", name: "Serverless Function", category: "compute", color: "#d97706", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "database", name: "Database", category: "data", color: "#0284c7", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "message-queue", name: "Message Queue", category: "messaging", color: "#e11d48", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "object-storage", name: "Object Storage", category: "storage", color: "#059669", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "cache", name: "Cache", category: "data", color: "#dc2626", width: ICON_W, height: ICON_H }),
      Object.freeze({ id: "cdn", name: "CDN", category: "network", color: "#0891b2", width: ICON_W, height: ICON_H }),
    ]),
  }),
]);

export const ICON_PACK_IDS = Object.freeze(ICON_PACKS.map(p => p.id));

const BUILDERS_BY_PACK = {
  kubernetes: KUBERNETES_BUILDERS,
  cloud: CLOUD_BUILDERS,
};

/**
 * Look up an icon pack by id or alias (e.g. `"kubernetes"`, `"k8s"`, `"cloud"`, `"cloud-aws"`).
 * @param {string} packId
 * @returns {IconPackMeta | null}
 */
export function getIconPack(packId) {
  if (typeof packId !== "string" || !packId) return null;
  const key = packId.trim().toLowerCase();
  return ICON_PACKS.find(p => p.id === key || p.aliases.includes(key)) ?? null;
}

/**
 * Build Protocol v1.1-valid grouped vector Plenary elements for a single icon.
 * Compatible with `itemFromElements` from `packages/core/library.js`.
 * @param {string} packId
 * @param {string} iconId
 * @param {{ x?: number, y?: number, layer?: string, z?: number, now?: number }} [opts]
 * @returns {any[] | null}
 */
export function buildIconItem(packId, iconId, { x = 0, y = 0, layer = BASE_LAYER, z = 0, now = Date.now() } = {}) {
  const pack = getIconPack(packId);
  if (!pack || typeof iconId !== "string") return null;
  const builders = BUILDERS_BY_PACK[pack.id];
  const fn = builders && Object.prototype.hasOwnProperty.call(builders, iconId) ? builders[iconId] : null;
  if (!fn) return null;
  const ctx = makeCtx({ x, y, layer, z, now });
  fn(ctx);
  return ctx.elements;
}

/**
 * Build a full `.excalidrawlib`-compatible array of library items for every icon in a pack.
 * @param {string} packId
 * @param {{ now?: number }} [opts]
 * @returns {any[] | null}
 */
export function buildIconLibraryItems(packId, { now = Date.now() } = {}) {
  const pack = getIconPack(packId);
  if (!pack) return null;
  return pack.icons.map(icon => {
    const els = buildIconItem(pack.id, icon.id, { x: 0, y: 0, layer: BASE_LAYER, z: 0, now });
    return itemFromElements(els ?? [], { name: icon.name, now });
  });
}
