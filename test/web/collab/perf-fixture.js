// Shared fixture for the collab per-frame cost bench and tests (p7-perf): a busy board, a DOM-write counter and a
// pan driver. Uses only mountCollab's public options and collabFrame, so the same bench ran before and after p7-perf.
import { installDom } from "./fake-dom.js";
import { createFakePort } from "../../../web/adapters/collab/fake.js";

/** A seeded PRNG (mulberry32), so every run builds the same board. */
export function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * `threads` threads × `comments` comments over a `world`-wide square: half on a point, half on a board element.
 * 20 authors; every comment signed. `notes` notes elements (a label on every 4th).
 */
export function busyBoard({ threads = 10_000, comments = 3, world = 20_000, notes = 50_000, seed = 7 } = {}) {
  const r = seeded(seed), T = [], elements = {}, N = [], authors = {};
  for (let i = 0; i < threads; i++) {
    const x = Math.floor(r() * world), y = Math.floor(r() * world), by = `u${i % 20}`;
    let anchor;
    if (i % 2) { elements[`board:e${i}`] = { x, y, width: 80, height: 40 }; anchor = { stream: "board", element: `e${i}`, x: x + 80, y }; }
    else anchor = { point: { x, y } };
    const cs = [];
    for (let j = 0; j < comments; j++) cs.push({ id: `c${i}_${j}`, by: `u${(i + j) % 20}`, name: `User ${(i + j) % 20}`, at: 1_000_000 + i, text: `comment ${j} on ${i}`, reactions: j === 1 ? { "👍": [`u${j}`] } : {} });
    T.push({ id: `t${i}`, by, name: `User ${i % 20}`, at: 1_000_000 + i, anchor, comments: cs });
  }
  for (let i = 0; i < notes; i++) {
    const id = `n${i}`;
    N.push({ id, type: "rectangle", x: Math.floor(r() * world), y: Math.floor(r() * world), width: 120, height: 80, backgroundColor: "#ffd43b", strokeColor: "#000", updated: i });
    if (i % 4 === 0) N.push({ id: `l${i}`, type: "text", containerId: id, text: `note ${i}`, x: 0, y: 0, updated: i });
    authors[id] = `u${i % 20}`;
  }
  return { threads: T, elements, notes: N, noteAuthors: authors };
}

/** 50 peers' cursors and selections, as one presence batch. */
export function cursorBatch(n = 50, t = 0) {
  return Array.from({ length: n }, (_, i) => ({ user: `p${i}`, client: `p${i}-1`, k: "cursor", x: 100 + i * 10 + t, y: 200 + i }));
}

/**
 * A fake DOM whose every element counts its writes: style.setProperty, setAttribute, classList.toggle, child-list
 * changes (append, replaceChildren, remove) and textContent sets. `writes.n` is the running total.
 */
export function countingDom() {
  const dom = installDom(), writes = { n: 0 }, make = globalThis.document.createElement;
  const count = (obj, k) => { const f = obj[k]; obj[k] = function (...a) { writes.n++; return f.apply(this, a); }; };
  const wrap = el => {
    count(el.style, "setProperty"); count(el, "setAttribute"); count(el.classList, "toggle");
    for (const k of ["append", "replaceChildren", "remove"]) count(el, k);
    return el;
  };
  globalThis.document.createElement = tag => wrap(make(tag));
  wrap(dom.root);
  return { ...dom, writes };
}

/** A board view the pan driver moves (Editor-shaped: { x, y, scale }, toScreen = (p + xy) × scale). */
export function panView(w = 1200, h = 800) {
  const v = { x: 0, y: 0, scale: 1 };
  return {
    v, w, h,
    toScreen: p => ({ x: (p.x + v.x) * v.scale, y: (p.y + v.y) * v.scale }),
    toWorld: p => ({ x: p.x / v.scale - v.x, y: p.y / v.scale - v.y }),
    get scale() { return v.scale; },
  };
}

/** A collabFrame-shaped page state over that view: S.eds.board.view is the view's own object. */
export function frameState(view, sel = new Set()) {
  return { active: "board", eds: { board: { sel, view: view.v, version: 0 }, notes: { sel: new Set(), view: { x: 0, y: 0, scale: 1 }, version: 0 } }, v: 1, version() { return this.v; } };
}

export { createFakePort };
