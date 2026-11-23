// @ts-check
// Crisp 24×24 inline SVG icon set (docs/design/DESIGN.md § 4).
// Zero Unicode tool glyphs; works in real browsers (createElementNS) and stub DOMs (createElement fallback).

const SVG_NS = "http://www.w3.org/2000/svg";

/** @type {Record<string, Array<[string, Record<string, string | number>]>>} */
export const ICONS = Object.freeze({
  // ── Canvas tools ──
  select: [["path", { d: "M5 4l6.5 16 2.5-6 6-2.5L5 4z" }]],
  hand: [
    ["path", { d: "M18 11V6a2 2 0 0 0-4 0v4" }],
    ["path", { d: "M14 10V4a2 2 0 0 0-4 0v6" }],
    ["path", { d: "M10 10.5V6a2 2 0 0 0-4 0v8" }],
    ["path", { d: "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8v-2a2 2 0 0 1 4 0" }],
  ],
  rectangle: [["rect", { x: 4, y: 5, width: 16, height: 14, rx: 2.5 }]],
  diamond: [["path", { d: "M12 3.5l8.5 8.5-8.5 8.5L3.5 12 12 3.5z" }]],
  ellipse: [["circle", { cx: 12, cy: 12, r: 8 }]],
  arrow: [
    ["line", { x1: 5, y1: 19, x2: 19, y2: 5 }],
    ["polyline", { points: "10 5 19 5 19 14" }],
  ],
  line: [["line", { x1: 5, y1: 19, x2: 19, y2: 5 }]],
  freedraw: [["path", { d: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 3 21l.5-4.5L17 3z" }]],
  text: [
    ["path", { d: "M5 6V4h14v2" }],
    ["line", { x1: 12, y1: 4, x2: 12, y2: 20 }],
    ["line", { x1: 9, y1: 20, x2: 15, y2: 20 }],
  ],
  eraser: [
    ["path", { d: "M7 21h13" }],
    ["path", { d: "M18.4 9.6a2 2 0 0 0 0-2.8l-3.2-3.2a2 2 0 0 0-2.8 0L4.6 11.4a2 2 0 0 0 0 2.8l3.6 3.6a2 2 0 0 0 2.8 0l7.4-8.2z" }],
    ["line", { x1: 9.5, y1: 6.5, x2: 15.5, y2: 12.5 }],
  ],
  frame: [
    ["line", { x1: 4, y1: 8, x2: 20, y2: 8 }],
    ["line", { x1: 4, y1: 16, x2: 20, y2: 16 }],
    ["line", { x1: 8, y1: 4, x2: 8, y2: 20 }],
    ["line", { x1: 16, y1: 4, x2: 16, y2: 20 }],
  ],
  laser: [
    ["path", { d: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" }],
    ["path", { d: "M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" }],
  ],
  image: [
    ["rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }],
    ["circle", { cx: 8.5, cy: 9.5, r: 1.5 }],
    ["path", { d: "M20.5 15.5l-4.5-4.5-6.5 6.5" }],
    ["path", { d: "M12.5 15l-2.5-2.5-4.5 4.5" }],
  ],
  note: [
    ["path", { d: "M5 4h14a1 1 0 0 1 1 1v10l-5 5H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" }],
    ["path", { d: "M15 20v-5h5" }],
  ],
  highlighter: [
    ["path", { d: "M9 11l-6 6v3h9l3-3" }],
    ["path", { d: "M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" }],
  ],

  // ── History & chrome actions ──
  undo: [
    ["path", { d: "M9 14L4 9l5-5" }],
    ["path", { d: "M20 20v-7a4 4 0 0 0-4-4H4" }],
  ],
  redo: [
    ["path", { d: "M15 14l5-5-5-5" }],
    ["path", { d: "M4 20v-7a4 4 0 0 1 4-4h12" }],
  ],
  lock: [
    ["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }],
    ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }],
  ],
  unlock: [
    ["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }],
    ["path", { d: "M8 11V7a4 4 0 0 1 7.4-2.1" }],
  ],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["line", { x1: 12, y1: 3, x2: 12, y2: 5 }],
    ["line", { x1: 12, y1: 19, x2: 12, y2: 21 }],
    ["line", { x1: 4.9, y1: 4.9, x2: 6.3, y2: 6.3 }],
    ["line", { x1: 17.7, y1: 17.7, x2: 19.1, y2: 19.1 }],
    ["line", { x1: 3, y1: 12, x2: 5, y2: 12 }],
    ["line", { x1: 19, y1: 12, x2: 21, y2: 12 }],
    ["line", { x1: 4.9, y1: 19.1, x2: 6.3, y2: 17.7 }],
    ["line", { x1: 17.7, y1: 6.3, x2: 19.1, y2: 4.9 }],
  ],
  moon: [["path", { d: "M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" }]],
  mermaid: [
    ["rect", { x: 3, y: 4, width: 7, height: 6, rx: 1.5 }],
    ["rect", { x: 14, y: 14, width: 7, height: 6, rx: 1.5 }],
    ["path", { d: "M10 7h3a2 2 0 0 1 2 2v5" }],
    ["polyline", { points: "12.5 11.5 15 14 17.5 11.5" }],
  ],
  export: [
    ["path", { d: "M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" }],
    ["polyline", { points: "8 11 12 15 16 11" }],
    ["line", { x1: 12, y1: 4, x2: 12, y2: 15 }],
  ],
  share: [
    ["path", { d: "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" }],
    ["polyline", { points: "16 6 12 2 8 6" }],
    ["line", { x1: 12, y1: 2, x2: 12, y2: 15 }],
  ],
  comments: [["path", { d: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.7-.3-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z" }]],
  panel: [
    ["rect", { x: 3.5, y: 4, width: 17, height: 16, rx: 2 }],
    ["line", { x1: 14.5, y1: 4, x2: 14.5, y2: 20 }],
  ],
  more: [
    ["circle", { cx: 6, cy: 12, r: 1.4, fill: "currentColor" }],
    ["circle", { cx: 12, cy: 12, r: 1.4, fill: "currentColor" }],
    ["circle", { cx: 18, cy: 12, r: 1.4, fill: "currentColor" }],
  ],
  close: [
    ["line", { x1: 6, y1: 6, x2: 18, y2: 18 }],
    ["line", { x1: 18, y1: 6, x2: 6, y2: 18 }],
  ],
  logout: [
    ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }],
    ["polyline", { points: "16 17 21 12 16 7" }],
    ["line", { x1: 21, y1: 12, x2: 9, y2: 12 }],
  ],
  plus: [
    ["line", { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }],
  ],
  minus: [["line", { x1: 5, y1: 12, x2: 19, y2: 12 }]],
  fit: [
    ["polyline", { points: "15 4 20 4 20 9" }],
    ["polyline", { points: "9 20 4 20 4 15" }],
    ["line", { x1: 20, y1: 4, x2: 14, y2: 10 }],
    ["line", { x1: 4, y1: 20, x2: 10, y2: 14 }],
  ],
  chevronLeft: [["polyline", { points: "15 18 9 12 15 6" }]],
  chevronRight: [["polyline", { points: "9 18 15 12 9 6" }]],
  play: [["polygon", { points: "7 5 19 12 7 19 7 5" }]],
  pause: [
    ["rect", { x: 6, y: 5, width: 4, height: 14, rx: 1 }],
    ["rect", { x: 14, y: 5, width: 4, height: 14, rx: 1 }],
  ],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
  skipBack: [
    ["polygon", { points: "19 20 9 12 19 4 19 20" }],
    ["line", { x1: 5, y1: 5, x2: 5, y2: 19 }],
  ],
  skipForward: [
    ["polygon", { points: "5 4 15 12 5 20 5 4" }],
    ["line", { x1: 19, y1: 5, x2: 19, y2: 19 }],
  ],
  repeat: [
    ["polyline", { points: "17 2 21 6 17 10" }],
    ["path", { d: "M3 11V9a4 4 0 0 1 4-4h14" }],
    ["polyline", { points: "7 22 3 18 7 14" }],
    ["path", { d: "M21 13v2a4 4 0 0 1-4 4H3" }],
  ],
  eyedropper: [
    ["path", { d: "M19.5 4.5a2.12 2.12 0 0 0-3 0l-2.8 2.8-1.4-1.4-1.4 1.4 1.4 1.4-7.3 7.3V19h3l7.3-7.3 1.4 1.4 1.4-1.4-1.4-1.4 2.8-2.8a2.12 2.12 0 0 0 0-3z" }],
  ],
  duplicate: [
    ["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }],
  ],
  paste: [
    ["rect", { x: 8, y: 2.5, width: 8, height: 3.5, rx: 1 }],
    ["path", { d: "M16 4h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" }],
    ["line", { x1: 9, y1: 12, x2: 15, y2: 12 }],
    ["line", { x1: 9, y1: 16, x2: 13, y2: 16 }],
  ],
  trash: [
    ["polyline", { points: "3 6 5 6 21 6" }],
    ["path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }],
    ["path", { d: "M10 11v6M14 11v6" }],
    ["path", { d: "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }],
  ],
  eye: [
    ["path", { d: "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
  ],
  eyeOff: [
    ["path", { d: "M17.94 17.94A10.1 10.1 0 0 1 12 19c-6 0-9.5-7-9.5-7a18.5 18.5 0 0 1 5.06-5.94" }],
    ["path", { d: "M9.9 4.24A9.1 9.1 0 0 1 12 4c6 0 9.5 7 9.5 7a18.5 18.5 0 0 1-2.16 3.19" }],
    ["line", { x1: 3, y1: 3, x2: 21, y2: 21 }],
  ],
  stack: [
    ["rect", { x: 4, y: 4, width: 16, height: 6, rx: 1.5 }],
    ["rect", { x: 4, y: 14, width: 16, height: 6, rx: 1.5 }],
  ],
  tabs: [
    ["rect", { x: 4, y: 5, width: 16, height: 14, rx: 2 }],
    ["line", { x1: 4, y1: 10, x2: 20, y2: 10 }],
    ["line", { x1: 11, y1: 5, x2: 11, y2: 10 }],
  ],
  fold: [
    ["polyline", { points: "7 15 12 20 17 15" }],
    ["polyline", { points: "7 9 12 4 17 9" }],
  ],
  settings: [
    ["circle", { cx: 12, cy: 12, r: 3 }],
    ["path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" }],
  ],
  arrowUp: [
    ["line", { x1: 12, y1: 19, x2: 12, y2: 5 }],
    ["polyline", { points: "6 11 12 5 18 11" }],
  ],
  arrowDown: [
    ["line", { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ["polyline", { points: "6 13 12 19 18 13" }],
  ],
  moveToLayer: [
    ["polyline", { points: "14 7 19 12 14 17" }],
    ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }],
  ],
  brand: [
    ["rect", { x: 4, y: 4, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 13, y: 13, width: 7, height: 7, rx: 1.5 }],
    ["path", { d: "M11 7.5h4.5a1.5 1.5 0 0 1 1.5 1.5V13" }],
  ],
  check: [["polyline", { points: "5 12.5 10 17.5 19 7.5" }]],
  palette: [
    ["circle", { cx: 12, cy: 12, r: 8.5 }],
    ["circle", { cx: 9, cy: 10, r: 1, fill: "currentColor" }],
    ["circle", { cx: 13, cy: 8.5, r: 1, fill: "currentColor" }],
    ["circle", { cx: 16, cy: 11.5, r: 1, fill: "currentColor" }],
    ["circle", { cx: 11, cy: 15, r: 1, fill: "currentColor" }],
  ],
  menu: [
    ["line", { x1: 4, y1: 6.5, x2: 20, y2: 6.5 }],
    ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ["line", { x1: 4, y1: 17.5, x2: 20, y2: 17.5 }],
  ],
  edit: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" }],
  ],
  importFile: [
    ["path", { d: "M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" }],
    ["polyline", { points: "16 8 12 4 8 8" }],
    ["line", { x1: 12, y1: 4, x2: 12, y2: 15 }],
  ],
  grid: [
    ["rect", { x: 4, y: 4, width: 6.5, height: 6.5, rx: 1 }],
    ["rect", { x: 13.5, y: 4, width: 6.5, height: 6.5, rx: 1 }],
    ["rect", { x: 4, y: 13.5, width: 6.5, height: 6.5, rx: 1 }],
    ["rect", { x: 13.5, y: 13.5, width: 6.5, height: 6.5, rx: 1 }],
  ],
  cut: [
    ["circle", { cx: 6, cy: 6, r: 2.5 }],
    ["circle", { cx: 6, cy: 18, r: 2.5 }],
    ["line", { x1: 20, y1: 4, x2: 8.1, y2: 15.9 }],
    ["line", { x1: 14.5, y1: 14.5, x2: 20, y2: 20 }],
    ["line", { x1: 8.1, y1: 8.1, x2: 12, y2: 12 }],
  ],
  copy: [
    ["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
    ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }],
  ],
  group: [
    ["rect", { x: 3.5, y: 3.5, width: 17, height: 17, rx: 2, "stroke-dasharray": "3 2" }],
    ["rect", { x: 7, y: 7, width: 5, height: 5, rx: 1 }],
    ["rect", { x: 12, y: 12, width: 5, height: 5, rx: 1 }],
  ],
  ungroup: [
    ["rect", { x: 4, y: 4, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 13, y: 13, width: 7, height: 7, rx: 1.5 }],
    ["line", { x1: 14, y1: 6, x2: 18, y2: 6 }],
    ["line", { x1: 6, y1: 18, x2: 10, y2: 18 }],
  ],
  bringFront: [
    ["rect", { x: 4, y: 4, width: 10, height: 10, rx: 1.5 }],
    ["path", { d: "M14 10h4.5A1.5 1.5 0 0 1 20 11.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 10 18.5V14" }],
  ],
  bringForward: [
    ["polyline", { points: "7 13 12 8 17 13" }],
    ["line", { x1: 12, y1: 8, x2: 12, y2: 19 }],
    ["line", { x1: 5, y1: 5, x2: 19, y2: 5 }],
  ],
  sendBackward: [
    ["polyline", { points: "7 11 12 16 17 11" }],
    ["line", { x1: 12, y1: 16, x2: 12, y2: 5 }],
    ["line", { x1: 5, y1: 19, x2: 19, y2: 19 }],
  ],
  sendBack: [
    ["rect", { x: 10, y: 10, width: 10, height: 10, rx: 1.5 }],
    ["path", { d: "M10 14H5.5A1.5 1.5 0 0 1 4 12.5v-7A1.5 1.5 0 0 1 5.5 4h7A1.5 1.5 0 0 1 14 5.5V10" }],
  ],
  layers: [
    ["polygon", { points: "12 3 3 8 12 13 21 8 12 3" }],
    ["polyline", { points: "3 13 12 18 21 13" }],
    ["polyline", { points: "3 17.5 12 22 21 17.5" }],
  ],
  selectAll: [
    ["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2, "stroke-dasharray": "3 2.5" }],
    ["rect", { x: 8, y: 8, width: 8, height: 8, rx: 1 }],
  ],
  zoomReset: [
    ["circle", { cx: 12, cy: 12, r: 7 }],
    ["circle", { cx: 12, cy: 12, r: 2, fill: "currentColor" }],
  ],
  history: [
    ["path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }],
    ["polyline", { points: "3 3 3 8 8 8" }],
    ["polyline", { points: "12 7 12 12 15.5 14" }],
  ],
});

function createSvgNode(tag) {
  return typeof document.createElementNS === "function"
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
}

/**
 * Create a crisp 24×24 inline `<svg>` icon element.
 * @param {string} name  Icon key in `ICONS`
 * @param {{ size?: number, class?: string }} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const svg = createSvgNode("svg");
  const size = opts.size ?? 18;
  const cls = ["ico", opts.class].filter(Boolean).join(" ");
  svg.setAttribute("class", cls);
  if (typeof svg.className === "string") svg.className = cls;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", name);

  const shapes = Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.rectangle;
  for (const [tag, attrs] of shapes) {
    const child = createSvgNode(tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.append(child);
  }
  return svg;
}
