// The editor: tools, selection, gestures, history, layers, commands.
//
// Platform-free. An adapter feeds it pointer/key events in screen pixels
// (logical, zoom-1) and paints editor.displayList(theme). Every change leaves
// as an op through `onOp` (to the file store today; to a server later), and
// remote/agent ops come in through editor.receive(op).

import {
  DEFAULT_STROKE, makeElement, clone, touch, isShape, isLinear, isLabel, layerOf, zOf, defaultLayer, newId, textSize, clampPressure,
} from "./model.js";
import { Doc } from "./doc.js";
import {
  bbox, unionBox, inBox, boxInBox, center, normalize, hits, hitTest, shapeAt, bindTargetAt, resolvedPoints, drawnPoints, curveThrough, settle, fileScene, portAt, mapIntoBox, segmentsIntersect,
  bounds, corners, rotate, rotateAbout, angleOf, centerOf, toLocal, toWorld as elToWorld, normAngle,
} from "./geometry.js";
import { paintScene, project, rectCmds, withAlpha, paintSnapIndicator } from "./render.js";
import { getPreset, getEasing, timelineEnd, stepTimeline, effectiveAnimTime } from "./anim.js";
import { labelHostHeight, labelHostWidth } from "./text.js";
import { isMermaid, mermaidToElements } from "./mermaid.js";
import { itemFromElements } from "./library.js";

export const TOOLS = [
  { id: "select", keys: ["v", "1"], icon: "↖", name: "Select" },
  { id: "hand", keys: ["h"], icon: "✋", name: "Hand" },
  { id: "rectangle", keys: ["r", "2"], icon: "▭", name: "Rectangle" },
  { id: "diamond", keys: ["d", "3"], icon: "◇", name: "Diamond" },
  { id: "ellipse", keys: ["o", "4"], icon: "◯", name: "Ellipse" },
  { id: "arrow", keys: ["a", "5"], icon: "→", name: "Arrow" },
  { id: "line", keys: ["l", "6"], icon: "╱", name: "Line" },
  { id: "freedraw", keys: ["p", "7"], icon: "✎", name: "Pen" },
  { id: "text", keys: ["t", "8"], icon: "T", name: "Text" },
  { id: "eraser", keys: ["e", "0"], icon: "⌫", name: "Eraser" },
  { id: "frame", keys: ["f"], icon: "#", name: "Frame" },
  { id: "laser", keys: ["k"], icon: "✦", name: "Laser" },
];

export const STROKES = [DEFAULT_STROKE, "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5", "#0c8599"];
export const FILLS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#eebefa", "#99e9f2"];
export const WIDTHS = [1, 2, 4];
export const STYLES = ["solid", "dashed", "dotted"];

const HANDLE = 5;          // how close a press must be to a handle, screen px
const SNAP = 6;            // object snap distance, screen px
const DRAG_SLOP = 3;       // px before a press becomes a drag
const ROT_GAP = 24;        // the rotate handle sits this far above the selection, screen px
const ROT_SNAP = Math.PI / 12;   // shift snaps rotation to 15°
const PORT_SNAP = 12;      // how close an arrow end must come to a connection point to take it, screen px
const BIND_PAD = 8;        // how far outside a shape an arrow end still binds to it, screen px
const TOUCH_SLOP_MULT = 2.5;   // M5: adaptive touch slop multiplier for coarse pointers
const STRAY_DOT_MS = 80;       // M5: cancel 1-finger stroke if 2nd finger lands within this window
const STRAY_DOT_PX = 8;        // M5: ...and within this travel distance
const MT_TAP_MS = 250;         // M5: max duration for 2-finger Undo / 3-finger Redo tap
const MT_TAP_SLOP = 12;        // M5: max per-finger movement for multi-touch tap
const PALM_GRACE_MS = 300;     // M5: suppress single-finger touch this long after pen up
const STALE_POINTER_MS = 15_000; // M5: prune orphaned pointers from missed pointerup/cancel
const DRAWING_TOOLS = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"]);
const RESIZE_CURSOR = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" };

export class Editor {
  constructor({ scene, onOp = () => {}, clock = () => Date.now(), readOnly = false } = {}) {
    this.doc = new Doc(scene ?? { elements: [] });
    this.onOp = onOp; this.clock = clock;
    this.readOnly = !!readOnly;
    this.tool = "select"; this.toolLock = false;
    this.sel = new Set();
    this.view = { x: 40, y: 40, scale: 1 }; this.size = { w: 800, h: 600 };
    this.style = { strokeColor: DEFAULT_STROKE, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, fontSize: 20, fontFamily: 2, roundness: null, elbowed: false };
    this.activeLayer = this.doc.layers[this.doc.layers.length - 1].id;
    this.undoStack = []; this.redoStack = [];
    this.g = null;               // the gesture in progress
    this.pointers = new Map();   // M5: active pointers: pointerId → { x, y, type, pressure, t }
    this.mt = null;              // M5: multi-touch tap/pinch session state
    this.lastPointerType = "mouse";
    this.lastPenUpAt = -Infinity;
    this.hover = null; this.guides = []; this.laser = []; this.erasing = new Set();
    this.hint = null; this.hintKey = ""; this.snapPreview = null;
    this.text = null;            // { id, value, isNew } while typing
    this.clipboard = null;
    this.peers = new Map();      // presence: id → { name, color, cursor, sel } (networking comes later)
    this.play = null;            // { t0, from } while the timeline plays
    this.scrub = null;           // a paused timeline time, or null for the editing view
    this.playLoop = false;       // repeat timeline playback on end
    this.playSpeed = 1;          // playback speed multiplier (0.5, 1, 1.5, 2)
    this.reducedMotion = false;  // prefers-reduced-motion: settle animations to timeline end
    this.flash = null;
    this.camAnim = null;         // M3: smooth camera animation { from, to, elapsed, duration }
    this.camVel = null;          // M3: pan inertia velocity { vx, vy } in screen px/s
    this.version = 0;            // bumps on any visible change; adapters may diff on it
  }

  // ── ports ──────────────────────────────────────────────────────────────

  load(scene) { this.doc.load(scene); this.clearSnapPreview(); this.pruneSel(); this.fixLayer(); this.changed(); }
  receive(op) { const ch = this.doc.apply(op); if (ch.length) { this.pruneSnapPreview(); this.pruneSel(); this.fixLayer(); this.changed(); } return ch; }
  scene() { return fileScene(this.doc, this.doc.toScene()); }
  changed() { this.version++; }
  setSize(w, h) { this.size = { w, h }; }

  pruneSel() { for (const id of this.sel) if (!this.doc.get(id)) this.sel.delete(id); }
  fixLayer() { if (!this.doc.layers.some(l => l.id === this.activeLayer)) this.activeLayer = this.doc.layers[this.doc.layers.length - 1].id; }

  toWorld(p) { return { x: p.x / this.view.scale - this.view.x, y: p.y / this.view.scale - this.view.y }; }
  toScreen(p) { return { x: (p.x + this.view.x) * this.view.scale, y: (p.y + this.view.y) * this.view.scale }; }

  // ── changing the board ─────────────────────────────────────────────────

  // Run fn(tx) and commit its edits as one undoable step.
  transact(fn, { history = true, files } = {}) {
    const tx = new Tx(this.doc);
    const result = fn(tx);
    this.commit(tx.before, tx.dirty, history, files);
    return result;
  }

  // `files`: image blobs that ride along in the same op (so no replica sees the element without its file).
  commit(before, dirty, history = true, files) {
    if (!dirty.size) return;
    const elements = [];
    for (const [id, el] of dirty) {
      // Arrows bound to anything that moved get their baked geometry refreshed.
      elements.push(touch(el));
    }
    this.doc.apply({ elements }, { force: true });
    const settled = this.settleArrows(new Set(dirty.keys()), before);
    if (settled.length) elements.push(...settled);
    if (files) { this.doc.apply({ files }); this.onOp({ elements, files }); }
    else this.onOp({ elements });
    if (history) { this.undoStack.push(before); this.redoStack = []; if (this.undoStack.length > 200) this.undoStack.shift(); }
    this.changed();
  }

  settleArrows(ids, before) {
    const out = [];
    for (const el of this.doc.live()) {
      if (el.type !== "arrow" && el.type !== "line") continue;
      const s = el.startBinding?.elementId, e = el.endBinding?.elementId;
      if (!ids.has(el.id) && !ids.has(s) && !ids.has(e)) continue;
      const c = clone(el);
      if (settle(this.doc, c)) { if (!before.has(el.id)) before.set(el.id, clone(el)); touch(c); this.doc.apply({ elements: [c] }, { force: true }); out.push(c); }
    }
    return out;
  }

  // Undo applies the saved "before" copies as new versions, so it travels like any edit.
  undo() { this.swapHistory(this.undoStack, this.redoStack); }
  redo() { this.swapHistory(this.redoStack, this.undoStack); }
  swapHistory(from, to) {
    const before = from.pop(); if (!before) return;
    const back = new Map(), elements = [];
    for (const [id, old] of before) {
      const cur = this.doc.getAny(id);
      back.set(id, cur ? clone(cur) : null);
      const next = old ? clone(old) : { ...clone(cur), isDeleted: true };
      next.version = Math.max(cur?.version ?? 0, old?.version ?? 0); touch(next);
      elements.push(next);
    }
    to.push(back);
    this.doc.apply({ elements }, { force: true });
    this.onOp({ elements });
    this.pruneSnapPreview(); this.pruneSel(); this.changed();
  }

  setAppState(patch, history = false) {
    this.doc.apply({ appState: patch });
    this.onOp({ appState: patch });
    this.changed();
  }

  newEl(type, fields) {
    return makeElement(type, { ...fields, customData: { layer: this.activeLayer, z: this.doc.maxZ(this.activeLayer) + 1, ...(fields.customData ?? {}) } });
  }

  // ── selection ──────────────────────────────────────────────────────────

  selected() { return [...this.sel].map(id => this.doc.get(id)).filter(Boolean); }
  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) this.sel.add(id);
    this.changed();
  }
  // Clicking one member of a group picks the whole (outermost) group.
  withGroup(el) {
    const g = el.groupIds?.[el.groupIds.length - 1];
    return g ? this.doc.live().filter(e => e.groupIds?.includes(g)).map(e => e.id) : [el.id];
  }
  selBox() { const els = this.selected().filter(e => !isLabel(e)); return els.length ? unionBox(els.map(bounds)) : null; }

  // One rotated shape is resized and outlined in its own frame; anything else uses the axis-aligned box.
  soloRotated() { const els = this.selected().filter(e => !isLabel(e)); return els.length === 1 && angleOf(els[0]) ? els[0] : null; }

  // The selection frame as 4 screen corners (nw, ne, se, sw), padded.
  selFrame(padPx = 8) {
    const s = this.view.scale, pad = padPx / s, el = this.soloRotated();
    if (el) {
      const b = bbox(el);
      return [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]]
        .map(([x, y]) => this.toScreen(elToWorld(el, { x, y })));
    }
    const b = this.selBox(); if (!b) return null;
    return [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => this.toScreen({ x, y }));
  }
  selCenter() { const el = this.soloRotated(); if (el) return centerOf(el); const b = this.selBox(); return b && center(b); }

  // Screen-space handles of the selection: 8 resize handles, or a linear element's points.
  handles() {
    const els = this.selected().filter(e => this.doc.editable(e));
    if (els.length === 1 && isLinear(els[0]) && els[0].type !== "freedraw") {
      const pts = resolvedPoints(this.doc, els[0]);
      // An elbow's bends are routed, not placed: only its two ends have handles.
      if (els[0].elbowed) return [[0, pts[0]], [els[0].points.length - 1, pts[pts.length - 1]]].map(([i, p]) => ({ kind: "point", i, ...this.toScreen({ x: p[0], y: p[1] }) }));
      // Points, then a bend handle in the middle of each stretch (on the curve, for a curve): drag one to bend there.
      const el = els[0], curved = !!el.roundness && pts.length > 2, drawn = curved ? curveThrough(pts) : null;
      const mids = pts.slice(1).map((p, i) => {
        const m = curved ? drawn[i * 12 + 6] : [(pts[i][0] + p[0]) / 2, (pts[i][1] + p[1]) / 2];
        return { kind: "mid", i, ...this.toScreen({ x: m[0], y: m[1] }) };
      }).filter(h => { const a = this.toScreen({ x: pts[h.i][0], y: pts[h.i][1] }); return Math.hypot(h.x - a.x, h.y - a.y) > HANDLE * 3; });   // too short a stretch: no room
      return [...pts.map((p, i) => ({ kind: "point", i, ...this.toScreen({ x: p[0], y: p[1] }) })), ...mids];
    }
    const f = this.selFrame(); if (!f || !els.length) return [];
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const [nw, ne, se, sw] = f, n = mid(nw, ne);
    // The rotate handle: out from the top edge's middle, away from the center.
    const c = mid(nw, se), len = Math.hypot(n.x - c.x, n.y - c.y) || 1;
    const rot = { kind: "rotate", x: n.x + (n.x - c.x) / len * ROT_GAP, y: n.y + (n.y - c.y) / len * ROT_GAP };
    if (els.length === 1 && els[0].type === "text") return [rot];
    return [["nw", nw], ["n", n], ["ne", ne], ["e", mid(ne, se)], ["se", se], ["s", mid(se, sw)], ["sw", sw], ["w", mid(sw, nw)]]
      .map(([dir, p]) => ({ kind: "resize", dir, x: p.x, y: p.y })).concat([rot]);
  }
  slopScale(pointerType = this.lastPointerType) { return pointerType === "touch" ? TOUCH_SLOP_MULT : 1; }
  handleAt(p, pointerType = this.lastPointerType) {
    const r = HANDLE * this.slopScale(pointerType);
    return this.handles().find(h => Math.abs(h.x - p.x) <= r && Math.abs(h.y - p.y) <= r) ?? null;
  }

  // ── pointer input (screen px) ──────────────────────────────────────────

  isPenActive() {
    for (const pt of this.pointers.values()) if (pt.type === "pen") return true;
    return false;
  }
  isPalmWindow(now = this.clock()) { return this.isPenActive() || (now - this.lastPenUpAt < PALM_GRACE_MS); }
  touchPointers() {
    const out = [];
    for (const entry of this.pointers.entries()) if (entry[1].type === "touch") out.push(entry);
    return out;
  }

  beginPinch(pair, now) {
    const [, a] = pair[0], [, b] = pair[1];
    this.g = {
      kind: "pinch",
      prevMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      prevDist: Math.hypot(b.x - a.x, b.y - a.y),
      prevT: now,
      vx: undefined,
      vy: undefined,
    };
  }

  updatePinch(pair, now) {
    const g = this.g;
    if (!g || g.kind !== "pinch") return;
    const [, a] = pair[0], [, b] = pair[1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const w = this.toWorld(g.prevMid);
    const nextScale = g.prevDist > 1 && dist > 1
      ? Math.max(0.1, Math.min(8, this.view.scale * (dist / g.prevDist)))
      : this.view.scale;
    this.view = { scale: nextScale, x: mid.x / nextScale - w.x, y: mid.y / nextScale - w.y };
    if (now > g.prevT) {
      const dt = (now - g.prevT) / 1000;
      if (dt > 0 && dt < 0.25) {
        const ivx = (mid.x - g.prevMid.x) / dt, ivy = (mid.y - g.prevMid.y) / dt;
        g.vx = g.vx === undefined ? ivx : g.vx * 0.4 + ivx * 0.6;
        g.vy = g.vy === undefined ? ivy : g.vy * 0.4 + ivy * 0.6;
      }
    }
    g.prevMid = mid;
    g.prevDist = dist;
    g.prevT = now;
    this.changed();
  }

  /** Roll back an in-progress gesture cleanly without committing or polluting undo history. */
  cancelGesture() {
    const g = this.g;
    if (!g) return;
    this.g = null;
    this.guides = [];
    this.clearSnapPreview();
    if (g.before) {
      let mutated = false;
      for (const [id, prev] of g.before) {
        if (prev === null) {
          if (this.doc.byId.delete(id)) mutated = true;
        } else {
          this.doc.byId.set(id, clone(prev));
          mutated = true;
        }
      }
      if (mutated) {
        this.doc.rev++;
        this.doc._sorted = null;
        this.onOp({ elements: [], transient: true });
      }
    }
    if (g.kind === "marquee" && g.base) this.sel = new Set(g.base);
    if (g.kind === "erase") this.erasing.clear();
    if (g.kind === "laser" && g.laserStart != null) this.laser.length = Math.min(this.laser.length, g.laserStart);
    this.pruneSel();
    this.changed();
  }

  pruneStalePointers(now, incomingType, isPrimary) {
    let removed = false;
    for (const [id, pt] of this.pointers) {
      if (now - (pt.lastT ?? pt.t) >= STALE_POINTER_MS) { this.pointers.delete(id); removed = true; }
    }
    // A primary pointer down (or mouse press after a stuck touch) recovers from missed pointerup/cancel,
    // without disturbing an active pen when a palm touch arrives (handled right after time-pruning).
    if (!(incomingType === "touch" && this.isPenActive())) {
      if (isPrimary === true || incomingType === "mouse") {
        for (const [id, pt] of this.pointers) {
          if (isPrimary === true || pt.type !== "mouse") { this.pointers.delete(id); removed = true; }
        }
      }
    }
    if (removed && this.mt && this.pointers.size < 2) {
      this.mt = null;
      if (this.g?.kind === "pinch" || this.g?.kind === "pinch-tail") this.g = null;
    }
  }

  pointerDown(p, m = {}) {
    const now = this.clock();
    const pid = m.pointerId ?? 0;
    const type = m.pointerType ?? "mouse";
    const pressure = typeof m.pressure === "number" && Number.isFinite(m.pressure) ? m.pressure : null;

    this.pruneStalePointers(now, type, m.isPrimary);

    // Palm rejection (strict): while a pen is actively down, ignore ALL touch contacts (even 2+ palm contacts)
    // so they never interrupt, cancel, or zoom an active pen stroke.
    if (type === "touch" && this.isPenActive()) return;

    this.pointers.set(pid, { x: p.x, y: p.y, type, pressure, t: now, lastT: now });

    // Palm rejection (grace window): for 300 ms after pen up, suppress single-finger touch
    // while still allowing 2-finger touch pan/zoom.
    const touches = this.touchPointers();
    if (type === "touch" && touches.length === 1 && this.isPalmWindow(now)) return;

    const mtPointers = touches.length >= 2 ? touches : (!this.isPenActive() && this.pointers.size >= 2 ? [...this.pointers.entries()] : null);
    if (mtPointers) {
      this.cancelCamera();
      if (this.text) this.commitText();
      let committedPrev = false;
      if (this.g && this.g.kind !== "pinch" && this.g.kind !== "pinch-tail") {
        const dt = now - (this.downAt?.t ?? 0);
        const moved = this.g.maxMove ?? Math.hypot((this.g.last?.x ?? p.x) - (this.downAt?.p.x ?? p.x), (this.g.last?.y ?? p.y) - (this.downAt?.p.y ?? p.y));
        if (this.g.kind === "pan") { this.g = null; this.clearSnapPreview(); if (moved >= MT_TAP_SLOP) committedPrev = true; }
        else if (dt < STRAY_DOT_MS && moved < STRAY_DOT_PX) { this.cancelGesture(); }
        else if (this.g.kind !== "poly") { const prev = this.g; this.g = null; this.guides = []; this.clearSnapPreview(); this.finishSingleGesture(prev, prev.last ?? p, {}); committedPrev = true; }
      }
      if (!this.mt) {
        const starts = new Map();
        let t0 = now;
        for (const [id, pt] of mtPointers) { starts.set(id, { x: pt.x, y: pt.y }); if (pt.t < t0) t0 = pt.t; }
        this.mt = { t0, maxFingers: mtPointers.length, moved: committedPrev, starts };
      } else {
        this.mt.maxFingers = Math.max(this.mt.maxFingers, mtPointers.length);
        if (committedPrev) this.mt.moved = true;
        if (!this.mt.starts.has(pid)) this.mt.starts.set(pid, { x: p.x, y: p.y });
      }
      if (mtPointers.length === 2) { this.clearSnapPreview(); this.beginPinch(mtPointers, now); }
      return;
    }

    this.lastPointerType = type;
    this.cancelCamera();
    if (this.text) this.commitText();
    // A press that arrives mid-gesture means we missed a release (outside the pane): finish it first.
    if (this.g && this.g.kind !== "poly") { const prev = this.g; this.g = null; this.guides = []; this.clearSnapPreview(); this.finishSingleGesture(prev, prev.last ?? p, {}); }
    const w = this.toWorld(p);
    this.downAt = { p, t: now };

    if (this.g?.kind === "poly") {   // adding points to a click-by-click line
      if (m.clickCount >= 2) return this.finishPoly();
      const el = this.g.el; el.points[el.points.length - 1] = [w.x - el.x, w.y - el.y]; el.points.push([w.x - el.x, w.y - el.y]);
      el.endBinding = null;   // a bend, not an end: the end binds where the line finishes
      return this.livePut(el);
    }
    if (this.readOnly || m.button === "middle" || this.tool === "hand" || m.space) {
      this.g = { kind: "pan", start: p, view: { ...this.view }, pointerId: pid, pointerType: type, maxMove: 0 };
      return;
    }

    if (m.clickCount >= 2 && this.tool === "select") {   // double-click a bend: straighten it out
      const h = this.handleAt(p, type), el = this.selected()[0];
      if (h?.kind === "point" && el && isLinear(el) && h.i > 0 && h.i < el.points.length - 1) return this.removeBend(el.id, h.i);
    }
    if (m.clickCount >= 2 && (this.tool === "select" || this.tool === "text")) {
      const hit = hitTest(this.doc, w, this.tol(type)) ?? shapeAt(this.doc, w);
      if (hit && (isShape(hit) || hit.type === "text" || isLinear(hit)) && this.doc.editable(hit)) return this.beginText(hit, w);
      if (!hit) return this.beginText(null, w);
    }

    switch (this.tool) {
      case "select": this.downSelect(p, w, m); break;
      case "text": return this.beginText(null, w);
      case "laser": {
        const laserStart = this.laser.length;
        this.laser.push({ x: w.x, y: w.y, t: now, start: true });
        this.g = { kind: "laser", laserStart, pointerId: pid, pointerType: type, maxMove: 0 };
        return this.changed();
      }
      case "eraser": this.g = { kind: "erase", last: p, pointerId: pid, pointerType: type, maxMove: 0 }; this.eraseAt(w, w); return;
      default: this.downCreate(p, w, m); break;
    }
    if (this.g) { this.g.pointerId = pid; this.g.pointerType = type; this.g.maxMove = 0; }
  }

  tol(pointerType = this.lastPointerType) { return (SNAP * this.slopScale(pointerType)) / this.view.scale; }

  downSelect(p, w, m) {
    const h = this.handleAt(p);
    if (h) {
      const els = [...this.selected()];
      for (const e of this.selected()) { const l = isShape(e) && this.doc.labelOf(e); if (l && !els.includes(l)) els.push(l); }
      const orig = new Map(els.map(e => [e.id, clone(e)])), before = new Map(els.map(e => [e.id, clone(e)]));
      if (h.kind === "rotate") {
        const c = this.selCenter();
        this.g = { kind: "rotate", c, a0: Math.atan2(w.y - c.y, w.x - c.x), solo: this.soloRotated() ?? (els.filter(e => !isLabel(e)).length === 1 ? els[0] : null), orig, before };
        return;
      }
      if (h.kind === "mid") {   // a new bend where the handle was, dragged from there
        const el = els[0], c = clone(el), at = this.toWorld(h);
        c.points.splice(h.i + 1, 0, [at.x - c.x, at.y - c.y]);
        this.livePut(c);
        this.g = { kind: "point", h: { kind: "point", i: h.i + 1 }, start: w, orig: new Map([[c.id, clone(c)]]), before: new Map([[el.id, before.get(el.id)]]) };
        return;
      }
      this.g = { kind: h.kind === "point" ? "point" : "resize", h, start: w, box: this.selBox(), solo: this.soloRotated(), orig, before };
      if (h.kind === "point") {
        const el = els[0];
        if (el && (h.i === 0 || h.i === el.points.length - 1)) {
          const otherId = h.i === 0 ? el.endBinding?.elementId : el.startBinding?.elementId;
          const endIndex = h.i === 0 ? 0 : -1;
          this.setSnapPreview(this.snapAt(w, otherId, m, el.elbowed, { lineId: el.id, endIndex }));
        }
      }
      return;
    }
    let hit = hitTest(this.doc, w, this.tol());
    // Inside the current selection's box, a press grabs the selection, even in the
    // empty middle of an unfilled shape, unless it lands on some other element.
    if ((!hit || this.sel.has(hit.id)) && !m.shift && this.sel.size) {
      const b = this.selBox();
      if (b && inBox(w, b, this.tol())) hit = this.selected().find(e => !isLabel(e) && this.doc.editable(e)) ?? hit;
    }
    if (hit) {
      const ids = this.withGroup(hit);
      if (m.shift) { if (this.sel.has(hit.id)) ids.forEach(id => this.sel.delete(id)); else ids.forEach(id => this.sel.add(id)); this.changed(); }
      else if (!this.sel.has(hit.id)) this.select(ids);
      if (!this.doc.editable(hit)) return;
      this.g = { kind: "move", start: w, p, alt: !!m.alt, moved: false };
      return;
    }
    if (!m.shift) this.select([]);
    this.g = { kind: "marquee", start: w, end: w, base: new Set(this.sel) };
  }

  downCreate(p, w, m) {
    const at = this.snapPoint(w);
    const s = this.style;
    const fields = { x: at.x, y: at.y, strokeColor: s.strokeColor, backgroundColor: isShape({ type: this.tool }) ? s.backgroundColor : "transparent", fillStyle: s.fillStyle, strokeWidth: s.strokeWidth, strokeStyle: s.strokeStyle, roughness: s.roughness, opacity: s.opacity, roundness: this.tool === "rectangle" || this.tool === "diamond" || this.tool === "line" || this.tool === "arrow" ? s.roundness : null };
    let startSnap = null;
    if (this.tool === "arrow" || this.tool === "line") {
      fields.points = [[0, 0], [0, 0]];
      if (this.tool === "arrow" && s.elbowed) { fields.elbowed = true; fields.roundness = null; }
      startSnap = this.snapAt(w, null, m, fields.elbowed);
      fields.startBinding = startSnap?.binding ?? null;
    }
    if (this.tool === "freedraw" && typeof m.pressure === "number" && Number.isFinite(m.pressure) && (m.pointerType === "pen" || (m.pressure !== 0.5 && m.pressure !== 0))) {
      fields.pressures = [clampPressure(m.pressure)];
      if (m.pointerType === "pen") fields.simulatePressure = false;
    }
    if (this.tool === "frame") Object.assign(fields, { backgroundColor: "transparent", strokeWidth: 1, name: `Frame ${this.doc.live().filter(e => e.type === "frame").length + 1}`, customData: { z: this.doc.minZ(this.activeLayer) - 1 } });
    const el = this.newEl(this.tool, fields);
    if (this.tool === "arrow" || this.tool === "line") {
      this.setSnapPreview(startSnap ? { ...startSnap, lineId: el.id, endIndex: 0 } : null);
    }
    this.g = { kind: "create", start: at, el, p, before: new Map([[el.id, null]]) };
    this.livePut(el);
  }

  pointerMove(p, m = {}) {
    const now = this.clock();
    const pid = m.pointerId ?? 0;
    const tracked = this.pointers.get(pid);
    const type = m.pointerType ?? tracked?.type ?? this.lastPointerType;
    if (type === "touch" && this.isPenActive()) return;
    const pressure = typeof m.pressure === "number" && Number.isFinite(m.pressure) ? m.pressure : null;
    if (tracked) { tracked.x = p.x; tracked.y = p.y; tracked.lastT = now; if (pressure != null) tracked.pressure = pressure; }

    if (this.mt) {
      const st = this.mt.starts.get(pid);
      if (st && Math.hypot(p.x - st.x, p.y - st.y) > MT_TAP_SLOP) this.mt.moved = true;
      if (this.g?.kind === "pinch") {
        const touches = this.touchPointers();
        const mtPointers = touches.length >= 2 ? touches : (!this.isPenActive() && this.pointers.size >= 2 ? [...this.pointers.entries()] : null);
        if (mtPointers && mtPointers.length === 2) this.updatePinch(mtPointers, now);
      }
      return;
    }

    const g = this.g;
    if (!g) {
      if (type === "touch") return;
      this.lastPointerType = type;
      this.updateHover(p, m);
      return;
    }
    if (g.pointerId != null && m.pointerId != null && g.pointerId !== pid) return;
    g.last = p;
    if (this.downAt) g.maxMove = Math.max(g.maxMove ?? 0, Math.hypot(p.x - this.downAt.p.x, p.y - this.downAt.p.y));
    const w = this.toWorld(p);
    switch (g.kind) {
      case "pan": {
        const t = now;
        if (g.prev && t > g.prev.t) {
          const dt = (t - g.prev.t) / 1000;
          if (dt > 0 && dt < 0.25) {
            const ivx = (p.x - g.prev.x) / dt, ivy = (p.y - g.prev.y) / dt;
            g.vx = g.vx === undefined ? ivx : g.vx * 0.4 + ivx * 0.6;
            g.vy = g.vy === undefined ? ivy : g.vy * 0.4 + ivy * 0.6;
          }
        }
        g.prev = { x: p.x, y: p.y, t };
        this.view = { ...g.view, x: g.view.x + (p.x - g.start.x) / this.view.scale, y: g.view.y + (p.y - g.start.y) / this.view.scale };
        return this.changed();
      }
      case "marquee": {
        g.end = w;
        const box = normBox(g.start, w);
        this.sel = new Set(g.base);
        for (const el of this.doc.visible()) if (!isLabel(el) && boxInBox(bounds(el), box)) this.withGroup(el).forEach(id => this.sel.add(id));
        return this.changed();
      }
      case "move": return this.moveSel(g, p, w, m);
      case "resize": return g.solo ? this.resizeRotated(g, w, m) : this.resizeSel(g, w, m);
      case "rotate": return this.rotateSel(g, w, m);
      case "point": return this.movePoint(g, w, m);
      case "create": return this.dragCreate(g, w, m);
      case "poly": {
        const el = g.el;
        el.points[el.points.length - 1] = [w.x - el.x, w.y - el.y];
        const snap = this.snapAt(w, el.startBinding?.elementId, m, el.elbowed, { lineId: el.id, endIndex: -1 });
        el.endBinding = snap?.binding ?? null;
        this.setSnapPreview(snap);
        return this.livePut(el);
      }
      case "erase": { const from = this.toWorld(g.lastE ?? p); g.lastE = p; this.eraseAt(from, w); return; }
      case "laser": this.laser.push({ x: w.x, y: w.y, t: now }); return this.changed();
    }
  }

  pointerUp(p, m = {}) {
    const now = this.clock();
    const pid = m.pointerId ?? 0;
    const tracked = this.pointers.get(pid);
    const type = m.pointerType ?? tracked?.type ?? this.lastPointerType;
    if (type === "touch" && this.isPenActive()) { this.pointers.delete(pid); return; }
    if (type === "pen") this.lastPenUpAt = now;
    this.pointers.delete(pid);

    if (this.mt) {
      const st = this.mt.starts.get(pid);
      if (st && Math.hypot(p.x - st.x, p.y - st.y) > MT_TAP_SLOP) this.mt.moved = true;
      const remList = [...this.pointers.entries()];
      if (remList.length === 2) {
        // Re-anchor pinch to the remaining 2 pointers (e.g. after a 3rd finger lifts) so there is no view jump.
        this.beginPinch(remList, now);
      } else if (remList.length === 1 && this.g?.kind === "pinch") {
        this.g.kind = "pinch-tail";
      } else if (remList.length === 0) {
        const mt = this.mt, g = this.g;
        this.mt = null; this.g = null; this.guides = []; this.clearSnapPreview();
        if (!mt.moved && (now - mt.t0) < MT_TAP_MS) {
          if (!this.readOnly && mt.maxFingers === 2) this.undo();
          else if (!this.readOnly && mt.maxFingers === 3) this.redo();
        } else if (g && (g.kind === "pinch" || g.kind === "pinch-tail")) {
          if (g.prevT != null && (now - g.prevT) <= 80 && Math.hypot(g.vx ?? 0, g.vy ?? 0) > 120) this.flingCamera(g.vx, g.vy);
        }
        this.changed();
      }
      return;
    }

    const g = this.g; if (!g || g.kind === "poly") return;   // a click-by-click line keeps going
    if (g.pointerId != null && m.pointerId != null && g.pointerId !== pid) return;
    this.g = null; this.guides = []; this.clearSnapPreview();
    return this.finishSingleGesture(g, p, m);
  }

  pointerCancel(p, m = {}) {
    const now = this.clock();
    const pid = m.pointerId ?? 0;
    const tracked = this.pointers.get(pid);
    const type = m.pointerType ?? tracked?.type ?? this.lastPointerType;
    if (type === "touch" && this.isPenActive()) { this.pointers.delete(pid); return; }
    if (type === "pen") this.lastPenUpAt = now;
    this.pointers.delete(pid);

    if (this.mt) {
      const remList = [...this.pointers.entries()];
      if (remList.length === 0) { this.mt = null; this.g = null; this.guides = []; this.clearSnapPreview(); this.changed(); }
      else if (remList.length === 2) { this.beginPinch(remList, now); }
      else if (remList.length === 1 && this.g?.kind === "pinch") { this.g.kind = "pinch-tail"; }
      return;
    }
    if (this.g && (this.g.pointerId == null || m.pointerId == null || this.g.pointerId === pid)) this.cancelGesture();
  }

  finishSingleGesture(g, p, m = {}) {
    switch (g.kind) {
      case "move": {
        if (!g.moved) return this.changed();
        const dirty = new Map(this.selected().map(e => [e.id, clone(e)]));
        for (const id of g.extra ?? []) { const e = this.doc.get(id); if (e) dirty.set(id, clone(e)); }
        return this.commitGesture(g.before, dirty);
      }
      case "resize": case "point": case "rotate": {
        const dirty = new Map([...g.orig.keys()].map(id => [id, clone(this.doc.get(id))]).filter(([, e]) => e));
        if (g.kind === "point") this.linkBound(dirty.values().next().value, g.before, dirty);
        return this.commitGesture(g.before, dirty);
      }
      case "create": return this.finishCreate(g, p);
      case "erase": return this.finishErase();
      case "laser": return;
      case "pan": {
        if (g.prev && this.clock() - g.prev.t <= 80 && Math.hypot(g.vx ?? 0, g.vy ?? 0) > 120) this.flingCamera(g.vx, g.vy);
        return this.changed();
      }
      default: return this.changed();
    }
  }

  /** Cancel any in-flight camera animation or pan inertia. */
  cancelCamera() { this.camAnim = null; this.camVel = null; }

  /** Whether a camera animation or inertia fling is currently active. */
  hasCameraMotion() { return !!(this.camAnim || this.camVel); }

  /** Smoothly animate `this.view` to `target` ({ x, y, scale }) over `durationMs`. Pure & deterministic via `stepCamera(dtMs)`. */
  animateViewTo(target, { durationMs = 220 } = {}) {
    const scale = Math.max(0.1, Math.min(8, Number.isFinite(target?.scale) ? target.scale : this.view.scale));
    const x = Number.isFinite(target?.x) ? target.x : this.view.x;
    const y = Number.isFinite(target?.y) ? target.y : this.view.y;
    this.camVel = null;
    if (!(durationMs > 0)) { this.camAnim = null; this.view = { x, y, scale }; return this.changed(); }
    this.camAnim = { from: { ...this.view }, to: { x, y, scale }, elapsed: 0, duration: durationMs };
    this.changed();
  }

  /** Start pan inertia with screen-space velocity `(vx, vy)` px/s. */
  flingCamera(vx, vy) {
    this.camAnim = null;
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || Math.hypot(vx, vy) < 8) { this.camVel = null; return; }
    this.camVel = { vx, vy };
  }

  /** Advance active camera animation or inertia by `dtMs`. Returns `true` if another frame is needed. */
  stepCamera(dtMs) {
    if (!(dtMs > 0)) return !!(this.camAnim || this.camVel);
    if (this.camAnim) {
      const a = this.camAnim;
      a.elapsed += dtMs;
      const t = Math.min(1, a.elapsed / a.duration);
      if (t >= 1) {
        this.view = { ...a.to };
        this.camAnim = null;
      } else {
        const e = 1 - (1 - t) ** 3;   // cubic ease-out
        const scale = a.from.scale * (a.to.scale / a.from.scale) ** e;
        this.view = {
          x: a.from.x + (a.to.x - a.from.x) * e,
          y: a.from.y + (a.to.y - a.from.y) * e,
          scale,
        };
      }
      this.changed();
      return !!this.camAnim;
    }
    if (this.camVel) {
      const dt = Math.min(dtMs, 100) / 1000;
      const decay = Math.exp(-Math.min(dtMs, 100) / 180);
      this.view = {
        ...this.view,
        x: this.view.x + (this.camVel.vx * dt) / this.view.scale,
        y: this.view.y + (this.camVel.vy * dt) / this.view.scale,
      };
      this.camVel.vx *= decay;
      this.camVel.vy *= decay;
      if (Math.hypot(this.camVel.vx, this.camVel.vy) < 8) this.camVel = null;
      this.changed();
      return !!this.camVel;
    }
    return false;
  }

  wheel(delta, p, m = {}) {
    this.cancelCamera();
    if (m.ctrl || m.cmd) {
      const f = Math.exp(-delta.y * 0.01);
      return this.zoomAt(this.view.scale * f, p);
    }
    this.view = { ...this.view, x: this.view.x - delta.x / this.view.scale, y: this.view.y - delta.y / this.view.scale };
    this.changed();
  }

  zoomAt(next, p = { x: this.size.w / 2, y: this.size.h / 2 }) {
    this.cancelCamera();
    next = Math.max(0.1, Math.min(8, next));
    const w = this.toWorld(p);
    this.view = { scale: next, x: p.x / next - w.x, y: p.y / next - w.y };
    this.changed();
  }

  clearSnapPreview() {
    if (!this.snapPreview && !this.hint && !this.hintKey) return false;
    this.snapPreview = null;
    this.hint = null;
    this.hintKey = "";
    return true;
  }

  pruneSnapPreview() {
    if (this.snapPreview && !this.doc.get(this.snapPreview.targetId)) this.clearSnapPreview();
  }

  setSnapPreview(snap) {
    const hk = snap ? `${snap.targetId}|${snap.side ?? ""}|${snap.lineId ?? ""}|${snap.endIndex ?? ""}` : "";
    if (hk === (this.hintKey ?? "") && !!snap === !!this.snapPreview) return false;
    this.hintKey = hk;
    this.hint = snap?.binding ?? null;
    this.snapPreview = snap ?? null;
    return true;
  }

  updateHover(p, m = {}) {
    this.pointer = p;
    const w = this.toWorld(p), linking = this.tool === "arrow" || this.tool === "line";
    // With the arrow or line tool: the shape an arrow started here would attach to, and its connection point.
    const snap = linking ? this.snapAt(w, null, m, this.tool === "arrow" && this.style.elbowed) : null;
    if (this.setSnapPreview(snap)) this.changed();
    const hit = this.tool === "select" ? hitTest(this.doc, w, this.tol()) : null;
    const id = hit?.id ?? null;
    if (id !== this.hover) { this.hover = id; this.changed(); }
    // The cursor depends on what's under the pointer (handles, elements): the adapter asks cursor() on change.
    const c = this.cursor();
    if (c !== this.lastCursor) { this.lastCursor = c; this.changed(); }
  }

  // Resolve binding + lightweight snap preview at world point `w`: a connection point near it (pinned there),
  // else the bindable target under it (aimed at the other end), else null. ⌘/Ctrl held: null.
  snapAt(w, except = null, m = {}, elbowed = false, ref = null) {
    if (m.cmd || m.ctrl) return null;
    const pointerType = m.pointerType ?? this.g?.pointerType ?? this.lastPointerType;
    const scale = this.slopScale(pointerType);
    const port = portAt(this.doc, w, (PORT_SNAP * scale) / this.view.scale, except);
    if (port) {
      const binding = { elementId: port.el.id, focus: 0, gap: 6, fixedPoint: port.port.fixedPoint, side: port.port.side };
      return {
        targetId: port.el.id,
        side: port.port.side,
        binding,
        elbowed: !!elbowed,
        ...(ref ? { lineId: ref.lineId, endIndex: ref.endIndex } : {}),
      };
    }
    const s = bindTargetAt(this.doc, w, except, (BIND_PAD * scale) / this.view.scale);
    if (!s) return null;
    return {
      targetId: s.id,
      side: null,
      binding: { elementId: s.id, focus: 0, gap: 6 },
      elbowed: !!elbowed,
      ...(ref ? { lineId: ref.lineId, endIndex: ref.endIndex } : {}),
    };
  }

  // What an arrow end at world point w attaches to: a connection point near it (pinned there),
  // else the shape under it (aimed at the other end), else nothing. ⌘ held: nothing.
  bindingAt(w, except, m = {}, elbowed = false) {
    return this.snapAt(w, except, m, elbowed)?.binding ?? null;
  }

  // The pointer's cursor, by tool and what's under it (adapters map the names to their own):
  // default, crosshair, pointer, move, grab, grabbing, text, ns-resize, ew-resize, nwse-resize, nesw-resize.
  cursor() {
    const g = this.g;
    if (g?.kind === "pan" || g?.kind === "pinch" || g?.kind === "pinch-tail") return "grabbing";
    if (g?.kind === "rotate") return "grabbing";
    if (g?.kind === "move" || g?.kind === "point") return g.kind === "point" ? "pointer" : "move";
    if (g?.kind === "resize") return RESIZE_CURSOR[g.h.dir] ?? "default";
    if (g?.kind === "create" || g?.kind === "poly") return this.snapPreview || this.hint || this.endHint() ? "pointer" : "crosshair";
    if (this.readOnly || this.tool === "hand") return "grab";
    if (this.tool === "text") return "text";
    if (this.tool === "arrow" || this.tool === "line") return this.snapPreview || this.hint ? "pointer" : "crosshair";
    if (this.tool !== "select") return "crosshair";
    const p = this.pointer; if (!p) return "default";
    const h = this.handleAt(p);
    if (h) return h.kind === "rotate" ? "grab" : h.kind === "resize" ? RESIZE_CURSOR[h.dir] : "pointer";
    return this.hover && this.doc.editable(this.doc.get(this.hover) ?? {}) ? "move" : "default";
  }
  // The binding the arrow being drawn or dragged would end with (shown while dragging).
  endHint() {
    const g = this.g;
    if (g?.kind === "create" && (g.el.type === "arrow" || g.el.type === "line")) return this.doc.get(g.el.id)?.endBinding ?? null;
    if (g?.kind === "poly") return this.doc.get(g.el.id)?.endBinding ?? null;
    if (g?.kind === "point") { const el = this.doc.get(g.orig.keys().next().value); return el && (g.h.i === 0 ? el.startBinding : g.h.i === el.points.length - 1 ? el.endBinding : null); }
    return null;
  }

  // Put a working copy into the board without history (live drag), and tell the store.
  livePut(...els) {
    const out = els.map(e => { const c = clone(e); c.version = (this.doc.getAny(e.id)?.version ?? 0) + 1; return c; });
    this.doc.apply({ elements: out }, { force: true });
    this.onOp({ elements: out, transient: true });
    this.changed();
  }

  commitGesture(before, dirty) {
    for (const [id, el] of dirty) { if (isLinear(el) || isShape(el)) normalize(el); }
    // dirty copies are fresh; bump them past the live versions
    for (const el of dirty.values()) el.version = this.doc.getAny(el.id)?.version ?? el.version;
    this.commit(before, dirty);
  }

  moveSel(g, p, w, m) {
    const dragSlop = DRAG_SLOP * this.slopScale(g.pointerType ?? m.pointerType);
    if (!g.moved && Math.hypot(p.x - g.p.x, p.y - g.p.y) < dragSlop) return;
    if (!g.moved) {
      g.moved = true;
      // Alt-drag leaves copies behind (the originals move).
      if (g.alt) this.duplicateInPlace();
      const ids = new Set(this.sel);
      for (const id of [...ids]) { const el = this.doc.get(id); const l = el && isShape(el) && this.doc.labelOf(el); if (l) ids.add(l.id); }
      g.extra = [...ids].filter(id => !this.sel.has(id));
      g.orig = new Map([...ids].map(id => [id, clone(this.doc.get(id))]).filter(([, e]) => e && this.doc.editable(e)));
      g.before = new Map([...g.orig].map(([id, e]) => [id, clone(e)]));
      g.box = unionBox([...g.orig.values()].filter(e => !isLabel(e)).map(bounds));
    }
    let dx = w.x - g.start.x, dy = w.y - g.start.y;
    if (m.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    ({ dx, dy } = this.snapMove(g.box, dx, dy, new Set(g.orig.keys())));
    const els = [];
    for (const [, o] of g.orig) { const c = clone(o); c.x = o.x + dx; c.y = o.y + dy; els.push(c); }
    this.livePut(...els);
  }

  resizeSel(g, w, m) {
    const b = g.box, d = g.h.dir;
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    // Move the grabbed edges by how far the pointer moved, not to the pointer.
    const at = this.snapPoint({ x: w.x - g.start.x, y: w.y - g.start.y });
    if (d.includes("w")) x0 += at.x; if (d.includes("e")) x1 += at.x;
    if (d.includes("n")) y0 += at.y; if (d.includes("s")) y1 += at.y;
    if (this.keepAspect(m) && b.w && b.h) {   // keep proportions
      const r = b.w / b.h, nw = x1 - x0, nh = y1 - y0;
      if (d === "e" || d === "w") y1 = y0 + Math.abs(nw) / r;
      if (d === "n" || d === "s") x1 = x0 + Math.abs(nh) * r;
      if (d.length === 2) { if (Math.abs(nw / r) > Math.abs(nh)) { const h = nw / r * Math.sign(nh || 1) * Math.sign(nw || 1); if (d.includes("n")) y0 = y1 - Math.abs(h) * Math.sign(nh || 1); else y1 = y0 + Math.abs(h) * Math.sign(nh || 1); } else { const ww = Math.abs(nh * r) * Math.sign(nw || 1); if (d.includes("w")) x0 = x1 - ww; else x1 = x0 + ww; } }
    }
    const to = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    const els = [];
    for (const [, o] of g.orig) {
      const c = clone(o); mapIntoBox(c, o, b, to);
      // A shape never gets shorter than its wrapped label (it grows as it narrows).
      const l = isShape(c) && this.doc.labelOf(c); if (l) this.fitHost(c, l, "left");
      els.push(c);
    }
    this.livePut(...els);
  }

  // Turn the selection about its center; shift snaps the angle to 15°.
  rotateSel(g, w, m) {
    let da = Math.atan2(w.y - g.c.y, w.x - g.c.x) - g.a0;
    if (m.shift) {
      const base = g.solo && !isLinear(g.solo) ? g.solo.angle || 0 : 0;
      da = Math.round((base + da) / ROT_SNAP) * ROT_SNAP - base;
    }
    const els = [];
    for (const [, o] of g.orig) {
      const c = clone(o);
      if (isLabel(o)) { const host = g.orig.get(o.containerId); c.angle = host ? normAngle((host.angle || 0) + da) : o.angle; }
      else rotateAbout(c, o, g.c, da);
      els.push(c);
    }
    this.livePut(...els);
  }

  // Shift keeps proportions; for media (photos, screenshots, videos) it's the other way round, as in Excalidraw.
  keepAspect(m) {
    const els = this.selected().filter(e => !isLabel(e));
    const media = els.length > 0 && els.every(e => e.type === "image" || e.type === "video");
    return !!m.shift !== media;
  }

  // Resize one rotated shape in its own frame, keeping the opposite handle fixed on screen.
  resizeRotated(g, w, m) {
    const o = g.solo, orig = g.orig.get(o.id), b = bbox(orig), a = angleOf(orig), d = g.h.dir;
    const p = toLocal(orig, w), s = toLocal(orig, g.start);
    let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
    const dx = p.x - s.x, dy = p.y - s.y;
    if (d.includes("w")) x0 += dx; if (d.includes("e")) x1 += dx;
    if (d.includes("n")) y0 += dy; if (d.includes("s")) y1 += dy;
    if (this.keepAspect(m) && b.w && b.h && d.length === 1) {
      const r = b.w / b.h;
      if (d === "e" || d === "w") y1 = y0 + Math.abs(x1 - x0) / r; else x1 = x0 + Math.abs(y1 - y0) * r;
    }
    if (this.keepAspect(m) && b.w && b.h && d.length === 2) {
      const r = b.w / b.h, nw = Math.abs(x1 - x0), nh = Math.abs(y1 - y0);
      if (nw / r > nh) { const h = nw / r; if (d.includes("n")) y0 = y1 - h; else y1 = y0 + h; } else { const ww = nh * r; if (d.includes("w")) x0 = x1 - ww; else x1 = x0 + ww; }
    }
    const nb = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    // Never narrower than the label's longest word: the dragged side stops there.
    const lab = isShape(orig) && this.doc.labelOf(orig), minW = lab?.text ? labelHostWidth(lab, orig.type) : 0;
    if (nb.w < minW) { if (d.includes("w") && x0 <= x1) nb.x = x1 - minW; else if (d.includes("e") && x1 < x0) nb.x = x0 - minW; nb.w = minW; }
    // The new box's center, from the old frame back to the scene.
    const c = rotate({ x: nb.x + nb.w / 2, y: nb.y + nb.h / 2 }, center(b), a);
    const el = clone(orig);
    el.width = nb.w; el.height = nb.h; el.x = c.x - nb.w / 2; el.y = c.y - nb.h / 2;
    const l = isShape(el) && this.doc.labelOf(el); if (l) this.fitHost(el, l);
    this.livePut(el);
  }

  rotateBy(deg) {
    const els = this.selected().filter(e => !isLabel(e) && this.doc.editable(e)); if (!els.length) return;
    const c = this.selCenter(), da = deg * Math.PI / 180;
    this.transact(tx => {
      for (const e of els) {
        rotateAbout(tx.get(e.id), clone(e), c, da);
        const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).angle = tx.get(e.id).angle;
      }
    });
  }
  resetRotation() {
    const els = this.selected().filter(e => !isLinear(e) && angleOf(e)); if (!els.length) return;
    this.transact(tx => { for (const e of els) { tx.get(e.id).angle = 0; const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).angle = 0; } });
  }

  // Grow a shape until its label fits: wide enough for its longest word (from its center, or
  // keeping its left edge when keep is "left"), then down for its wrapped lines (as Excalidraw does).
  fitHost(host, label, keep = "center") {
    if (!label?.text) return;
    const minW = labelHostWidth(label, host.type), w = Math.abs(host.width);
    if (w < minW) { const s = Math.sign(host.width) || 1; if (keep === "center") host.x -= s * (minW - w) / 2; host.width = s * minW; }
    const need = labelHostHeight(label, host);
    if (Math.abs(host.height) < need) host.height = need;
  }

  movePoint(g, w, m = {}) {
    const o = g.orig.values().next().value, c = clone(o), at = this.snapPoint(w);
    c.points[g.h.i] = [at.x - o.x, at.y - o.y];
    // An end binds as it moves (to a connection point or a shape), so what you see is what you get on release.
    if (g.h.i === 0) {
      const snap = this.snapAt(w, c.endBinding?.elementId, m, c.elbowed, { lineId: c.id, endIndex: 0 });
      c.startBinding = snap?.binding ?? null;
      this.setSnapPreview(snap);
    } else if (g.h.i === c.points.length - 1) {
      const snap = this.snapAt(w, c.startBinding?.elementId, m, c.elbowed, { lineId: c.id, endIndex: -1 });
      c.endBinding = snap?.binding ?? null;
      this.setSnapPreview(snap);
    } else {
      this.clearSnapPreview();
    }
    this.livePut(c);
  }



  dragCreate(g, w, m) {
    const el = g.el, at = this.snapPoint(w);
    if (isShape(el) || el.type === "frame") {
      el.width = at.x - g.start.x; el.height = at.y - g.start.y;
      if (m.shift) { const s = Math.max(Math.abs(el.width), Math.abs(el.height)); el.width = Math.sign(el.width || 1) * s; el.height = Math.sign(el.height || 1) * s; }
    } else if (el.type === "freedraw") {
      const last = el.points[el.points.length - 1], q = [w.x - el.x, w.y - el.y];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) * this.view.scale < 1.5) return;
      el.points.push(q);
      const hasPressure = typeof m.pressure === "number" && Number.isFinite(m.pressure);
      const trackPressure = g.pointerType === "pen" || m.pointerType === "pen" || (Array.isArray(el.pressures) && el.pressures.length > 0) || (hasPressure && m.pressure !== 0.5 && m.pressure !== 0);
      if (trackPressure && hasPressure) {
        if (!Array.isArray(el.pressures)) el.pressures = [];
        while (el.pressures.length < el.points.length - 1) el.pressures.push(el.pressures[el.pressures.length - 1] ?? 0.5);
        el.pressures.push(clampPressure(m.pressure));
      } else if (Array.isArray(el.pressures) && el.pressures.length > 0) {
        el.pressures.push(el.pressures[el.pressures.length - 1]);
      }
    } else {
      let q = [at.x - el.x, at.y - el.y];
      if (m.shift) { const a = Math.round(Math.atan2(q[1], q[0]) / (Math.PI / 12)) * (Math.PI / 12), r = Math.hypot(q[0], q[1]); q = [Math.cos(a) * r, Math.sin(a) * r]; }
      el.points[el.points.length - 1] = q;
      // Bind as it's drawn: the end snaps to the shape (or connection point) under it now, not on release.
      const snap = this.snapAt({ x: el.x + q[0], y: el.y + q[1] }, el.startBinding?.elementId, m, el.elbowed, { lineId: el.id, endIndex: -1 });
      el.endBinding = snap?.binding ?? null;
      this.setSnapPreview(snap);
    }
    this.livePut(el);
  }

  finishCreate(g, p) {
    const el = g.el;
    const dragged = Math.hypot(p.x - g.p.x, p.y - g.p.y) >= DRAG_SLOP * this.slopScale(g.pointerType);
    if (isShape(el) || el.type === "frame") {
      if (!dragged || (Math.abs(el.width) < 4 && Math.abs(el.height) < 4)) {   // a click: default size
        const d = el.type === "frame" ? [320, 240] : [140, 80];
        el.width = d[0]; el.height = d[1]; el.x -= d[0] / 2; el.y -= d[1] / 2;
      }
    } else if (el.type === "arrow" || el.type === "line") {
      if (!dragged) {   // a click: keep adding points until double-click / Enter
        this.g = { kind: "poly", el, before: g.before };
        el.points[1] = [0, 0];
        return this.changed();
      }
    } else if (el.type === "freedraw" && el.points.length < 2) {
      el.points.push([0.5, 0.5]);
      if (Array.isArray(el.pressures) && el.pressures.length === 1) el.pressures.push(el.pressures[0]);
    }
    this.endCreate(el, g.before);
  }



  finishPoly() {
    const g = this.g; if (!g || g.kind !== "poly") return;
    this.g = null;
    this.clearSnapPreview();
    const el = g.el;
    // Drop the trailing rubber-band point and any zero-length tail.
    while (el.points.length > 2 && dist(el.points[el.points.length - 1], el.points[el.points.length - 2]) < 4) el.points.pop();
    if (el.points.length < 2 || dist(el.points[0], el.points[el.points.length - 1]) < 4 && el.points.length === 2) {
      const dead = { ...clone(el), isDeleted: true }; this.livePut(dead); return this.changed();
    }
    const end = el.points[el.points.length - 1];   // the double-click's first click made a bend here: bind the end again
    el.endBinding = this.bindingAt({ x: el.x + end[0], y: el.y + end[1] }, el.startBinding?.elementId, {}, el.elbowed);
    this.endCreate(el, g.before);
  }

  // A dragged arrow end changed shapes: the shapes' boundElements follow (Excalidraw keeps both sides).
  linkBound(el, before, dirty) {
    if (!el) return;
    const now = new Set([el.startBinding?.elementId, el.endBinding?.elementId].filter(Boolean));
    for (const s of this.doc.live()) {
      const has = (s.boundElements ?? []).some(x => x.id === el.id && x.type === "arrow");
      if (has === now.has(s.id) || isLinear(s) || isLabel(s)) continue;
      if (!before.has(s.id)) before.set(s.id, clone(s));
      const c = clone(s);
      c.boundElements = has ? c.boundElements.filter(x => x.id !== el.id) : [...(c.boundElements ?? []), { id: el.id, type: "arrow" }];
      dirty.set(s.id, c);
    }
  }

  endCreate(el, before) {
    normalize(el);
    const dirty = new Map([[el.id, clone(el)]]);
    // Bound shapes learn about the arrow (Excalidraw's boundElements).
    for (const b of [el.startBinding, el.endBinding]) {
      const t = b && this.doc.get(b.elementId); if (!t) continue;
      if (!before.has(t.id)) before.set(t.id, clone(t));
      const c = dirty.get(t.id) ?? clone(t);
      c.boundElements = (c.boundElements ?? []).filter(x => x.id !== el.id).concat([{ id: el.id, type: "arrow" }]);
      dirty.set(t.id, c);
    }
    this.commitGesture(before, dirty);
    this.select([el.id]);
    if (!this.toolLock && el.type !== "freedraw") this.tool = "select";
  }

  eraseAt(from, to) {
    for (const el of this.doc.visible()) {
      if (this.erasing.has(el.id) || isLabel(el) || !this.doc.editable(el)) continue;
      let hit = hits(this.doc, el, to, this.tol() * 1.5);
      if (!hit && isLinear(el)) { const pts = drawnPoints(this.doc, el); for (let i = 1; i < pts.length && !hit; i++) hit = segmentsIntersect([from.x, from.y], [to.x, to.y], pts[i - 1], pts[i]); }
      if (hit) this.erasing.add(el.id);
    }
    this.changed();
  }

  finishErase() {
    const ids = [...this.erasing]; this.erasing.clear();
    if (ids.length) this.deleteIds(ids);
    this.changed();
  }

  // ── snapping ───────────────────────────────────────────────────────────

  get grid() { return this.doc.appState.herdr.grid ?? 0; }
  get snapOn() { return this.doc.appState.herdr.snap !== false; }

  snapPoint(w) {
    if (!this.grid) return w;
    const g = this.grid; return { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g };
  }

  // Snap a moving box to the grid, or to other elements' edges and centers (with guides).
  snapMove(box, dx, dy, skip) {
    this.guides = [];
    if (!box) return { dx, dy };
    if (this.grid) { const g = this.grid; return { dx: Math.round((box.x + dx) / g) * g - box.x, dy: Math.round((box.y + dy) / g) * g - box.y }; }
    if (!this.snapOn) return { dx, dy };
    const tol = (SNAP * this.slopScale()) / this.view.scale;
    const xs = [box.x, box.x + box.w / 2, box.x + box.w].map(v => v + dx), ys = [box.y, box.y + box.h / 2, box.y + box.h].map(v => v + dy);
    let bx = null, by = null;
    for (const el of this.doc.visible()) {
      if (skip.has(el.id) || isLabel(el)) continue;
      const b = bounds(el), tx = [b.x, b.x + b.w / 2, b.x + b.w], ty = [b.y, b.y + b.h / 2, b.y + b.h];
      for (const a of xs) for (const t of tx) { const d = t - a; if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: t, b }; }
      for (const a of ys) for (const t of ty) { const d = t - a; if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: t, b }; }
    }
    if (bx) { dx += bx.d; this.guides.push({ x: bx.at, y0: Math.min(box.y + dy, bx.b.y), y1: Math.max(box.y + dy + box.h, bx.b.y + bx.b.h) }); }
    if (by) { dy += by.d; this.guides.push({ y: by.at, x0: Math.min(box.x + dx, by.b.x), x1: Math.max(box.x + dx + box.w, by.b.x + by.b.w) }); }
    return { dx, dy };
  }

  // ── text ───────────────────────────────────────────────────────────────

  beginText(target, w) {
    let el, isNew = false;
    if (target && (isShape(target) || isLinear(target)) && target.type !== "freedraw" && target.type !== "frame") {
      el = this.doc.labelOf(target);
      if (!el) {
        isNew = true;
        const c = center(bbox(target));
        el = this.newEl("text", { x: c.x, y: c.y, containerId: target.id, textAlign: "center", verticalAlign: "middle", strokeColor: target.strokeColor, fontSize: this.style.fontSize, fontFamily: this.style.fontFamily });
      }
    } else if (target?.type === "frame") {
      this.text = { id: target.id, value: target.name ?? "", isNew: false, frame: true }; this.select([target.id]); return this.changed();
    } else if (target?.type === "text") el = target;
    else { isNew = true; el = this.newEl("text", { x: w.x, y: w.y - this.style.fontSize * 0.6, strokeColor: this.style.strokeColor, fontSize: this.style.fontSize, fontFamily: this.style.fontFamily, opacity: this.style.opacity }); }
    this.text = { id: el.id, value: el.text ?? "", isNew, draft: isNew ? el : null };
    if (!this.toolLock) this.tool = "select";
    this.changed();
  }

  // Where the adapter should put its text input (screen px).
  textBox() {
    const t = this.text; if (!t) return null;
    const el = t.draft ?? this.doc.get(t.id); if (!el) return null;
    const host = el.containerId ? this.doc.get(el.containerId) : t.frame ? el : null;
    const b = host ? bbox(host) : { x: el.x, y: el.y, w: Math.max(200, textSize(t.value || "M", el.fontSize, 1.25, el.fontFamily).w), h: el.fontSize * 1.4 };
    const a = this.toScreen(b), s = this.view.scale;
    if (t.frame) return { x: a.x, y: a.y - 26, w: Math.max(160, b.w * s), h: 24, size: 13, align: "left" };
    const lines = Math.max(1, String(t.value).split("\n").length), h = Math.max(36, lines * el.fontSize * s * 1.3 + 14);
    return { x: a.x, y: host ? a.y + (b.h * s) / 2 - h / 2 : a.y, w: Math.max(160, b.w * s), h, size: Math.max(12, el.fontSize * s), align: host ? "center" : "left", lines };
  }

  setText(v) { if (this.text) { this.text.value = v; this.changed(); } }

  commitText() {
    const t = this.text; if (!t) return;
    this.text = null;
    const value = t.value.replace(/\s+$/, "");
    if (t.frame) { this.transact(tx => { tx.get(t.id).name = value || null; }); return; }
    if (!value) {
      if (!t.isNew) this.deleteIds([t.id]);
      return this.changed();
    }
    this.transact(tx => {
      const el = t.isNew ? tx.add(t.draft) : tx.get(t.id);
      if (!el) return;
      el.text = el.originalText = value;
      const s = textSize(value, el.fontSize, el.lineHeight, el.fontFamily); el.width = s.w; el.height = s.h;
      if (el.containerId) {
        const host = tx.get(el.containerId);
        if (host && t.isNew) host.boundElements = (host.boundElements ?? []).concat([{ id: el.id, type: "text" }]);
        if (host && isShape(host)) this.fitHost(host, el);
      }
    });
    this.select([this.text?.id ?? (this.doc.get(t.id)?.containerId ?? t.id)]);
  }

  cancelText() { this.text = null; this.changed(); }

  // ── commands (keys, toolbars, panels, agents) ──────────────────────────

  deleteIds(ids) {
    this.transact(tx => {
      for (const id of ids) {
        const el = tx.get(id); if (!el) continue;
        el.isDeleted = true;
        if (isShape(el)) { const l = this.doc.labelOf(el); if (l) tx.get(l.id).isDeleted = true; }
        for (const a of this.doc.live()) {
          if (a.startBinding?.elementId === id) tx.get(a.id).startBinding = null;
          if (a.endBinding?.elementId === id) tx.get(a.id).endBinding = null;
          if (isLabel(a) && a.containerId === id) tx.get(a.id).isDeleted = true;
        }
      }
    });
    this.pruneSel(); this.changed();
  }

  // Copies of the selection right where they are (alt-drag), selected instead of the originals.
  duplicateInPlace() { const ids = this.cloneSelection(0, 0, false); this.sel = new Set(this.sel); return ids; }

  cloneSelection(dx, dy, selectCopies = true) {
    const els = this.selected(); if (!els.length) return [];
    const map = new Map(), groupMap = new Map(), out = [];
    const all = this.withLabels(els);
    for (const el of all) map.set(el.id, newId());
    this.transact(tx => {
      for (const el of all) {
        const c = clone(el); c.id = map.get(el.id); c.x += dx; c.y += dy; c.seed = Math.floor(Math.random() * 2 ** 31); c.version = 0;
        c.groupIds = (c.groupIds ?? []).map(g => { if (!groupMap.has(g)) groupMap.set(g, newId()); return groupMap.get(g); });
        if (c.containerId) c.containerId = map.get(c.containerId) ?? null;
        c.boundElements = (c.boundElements ?? []).filter(b => map.has(b.id)).map(b => ({ ...b, id: map.get(b.id) }));
        for (const k of ["startBinding", "endBinding"]) if (c[k]) c[k] = map.has(c[k].elementId) ? { ...c[k], elementId: map.get(c[k].elementId) } : null;
        c.customData = { ...c.customData, z: (c.customData?.z ?? 0) + 0.5 };
        tx.add(c); out.push(c.id);
      }
    });
    if (selectCopies) this.select(out.filter(id => !isLabel(this.doc.get(id))));
    return out;
  }

  // Elements plus the labels of the shapes and arrows among them (a label goes where its host goes).
  withLabels(els) {
    const all = [...els], ids = new Set(els.map(e => e.id));
    for (const el of els) { const l = (isShape(el) || isLinear(el)) && this.doc.labelOf(el); if (l && !ids.has(l.id)) { all.push(l); ids.add(l.id); } }
    return all;
  }

  copy() {
    const els = this.selected(); if (!els.length) return null;
    const all = fileScene(this.doc, { elements: this.withLabels(els) }).elements;
    // Excalidraw's clipboard format (label boxes as the file has them), so pasting into excalidraw.com works too.
    const files = {};
    for (const el of all) {
      const f = (el.type === "image" || el.type === "video") && this.doc.files[el.fileId];
      if (!f) continue;
      files[el.fileId] = el.type === "video"
        ? { id: f.id ?? el.fileId, mimeType: f.mimeType ?? el.mimeType ?? "video/mp4" }
        : f;
    }
    this.clipboard = JSON.stringify({ type: "excalidraw/clipboard", elements: all.map(clone), files });
    return this.clipboard;
  }

  // Image/video blobs by file id ({ id, mimeType, dataURL?, url?, created }). Add-only, outside undo:
  // undoing an insert deletes the element and leaves its file, as Excalidraw does.
  addFiles(files) {
    const op = { files };
    if (this.doc.apply(op).length) this.onOp(op);
  }

  // Put an image on the board, centered at `at` (scene coords), scaled down to fit
  // 60% of the view. `file`: { id, mimeType, dataURL, width, height } (natural px).
  // Returns the new element's id.
  addImage(file, at = this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 })) {
    const { id, mimeType, dataURL } = file;
    const files = this.doc.files[id] ? undefined : { [id]: { id, mimeType, dataURL, created: this.clock() } };
    let w = Math.max(1, +file.width || 200), h = Math.max(1, +file.height || 150);
    const k = Math.min(1, (this.size.w * 0.6) / this.view.scale / w, (this.size.h * 0.6) / this.view.scale / h);
    w *= k; h *= k;
    const el = this.newEl("image", { fileId: id, x: at.x - w / 2, y: at.y - h / 2, width: w, height: h, opacity: 100 });
    this.transact(tx => tx.add(el), { files });
    this.select([el.id]);
    return el.id;
  }

  // Put a video on the board, centered at `at` (scene coords), scaled down to fit
  // 60% of the view. `file`: { id, mimeType, dataURL?, url?, bytes?, posterDataUrl?, width, height, loop?, muted?, autoplay? }.
  // Returns the new element's id.
  addVideo(file, at = this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 })) {
    const { id, mimeType = "video/mp4", dataURL, url, bytes, posterDataUrl = null, loop = false, muted = true, autoplay = false } = file;
    const entry = { id, mimeType, created: this.clock() };
    if (dataURL != null) entry.dataURL = dataURL;
    if (url != null) entry.url = url;
    if (bytes != null) entry.bytes = bytes;
    const files = this.doc.files[id] ? undefined : { [id]: entry };
    let w = Math.max(1, +file.width || 480), h = Math.max(1, +file.height || 270);
    const k = Math.min(1, (this.size.w * 0.6) / this.view.scale / w, (this.size.h * 0.6) / this.view.scale / h);
    w *= k; h *= k;
    const el = this.newEl("video", {
      fileId: id, mimeType, posterDataUrl, loop: !!loop, muted: !!muted, autoplay: !!autoplay,
      x: at.x - w / 2, y: at.y - h / 2, width: w, height: h, opacity: 100,
    });
    this.transact(tx => tx.add(el), { files });
    this.select([el.id]);
    return el.id;
  }

  // A Mermaid flowchart becomes editable shapes, laid out, centered at `at`; returns the new ids.
  importMermaid(src, at = this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 }), { elbow = this.style.elbowed } = {}) {
    const { elements } = mermaidToElements(src, { layer: this.activeLayer, z: this.doc.maxZ(this.activeLayer), elbow });
    const box = unionBox(elements.filter(e => e.type !== "text").map(bbox));
    const dx = at.x - (box.x + box.w / 2), dy = at.y - (box.y + box.h / 2);
    this.transact(tx => { for (const e of elements) { e.x += dx; e.y += dy; tx.add(e); } });
    const ids = elements.filter(e => !isLabel(e)).map(e => e.id);
    this.select(ids);
    // Bring it all into view if it doesn't fit (Excalidraw zooms to imported content too).
    const nb = unionBox(this.selected().map(bounds)), a = this.toScreen(nb), z = this.toScreen({ x: nb.x + nb.w, y: nb.y + nb.h });
    if (a.x < 0 || a.y < 0 || z.x > this.size.w || z.y > this.size.h) this.fit(this.selected());
    return ids;
  }

  paste(text = this.clipboard, at) {
    if (isMermaid(text)) { try { this.importMermaid(text, at); this.flash = "imported Mermaid"; } catch (e) { this.flash = String(e.message ?? e); } return; }
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!data?.elements?.length) {
      if (text && typeof text === "string") { const c = at ?? this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 }); this.beginText(null, c); this.text.value = text; this.commitText(); }
      return;
    }
    this.insertElements(data.elements, data.files, at);
  }

  // Elements from elsewhere (a clipboard, a library item) as new ones, centered at `at`, as one
  // undo step: fresh ids, groups and bindings that point inside the set (others dropped), layer and z here.
  // Returns the new ids, labels included; selects the new top-level elements.
  insertElements(elements, files, at) {
    const els = (elements ?? []).filter(e => e && !e.isDeleted); if (!els.length) return [];
    if (files && typeof files === "object") this.addFiles(files);
    const box = unionBox(els.filter(e => !isLabel(e)).map(bbox)) ?? unionBox(els.map(bbox));
    const target = at ?? this.toWorld({ x: this.size.w / 2, y: this.size.h / 2 });
    const dx = target.x - (box.x + box.w / 2), dy = target.y - (box.y + box.h / 2);
    const idMap = new Map(els.map(e => [e.id, newId()])), groups = new Map(), z = this.doc.maxZ(this.activeLayer);
    const out = [];
    this.transact(tx => {
      els.forEach((e, i) => {
        const c = clone(e); c.id = idMap.get(e.id); c.x += dx; c.y += dy; c.version = 0; c.isDeleted = false;
        if (c.containerId) c.containerId = idMap.get(c.containerId) ?? null;
        c.groupIds = (c.groupIds ?? []).map(g => groups.get(g) ?? groups.set(g, newId()).get(g));
        c.boundElements = (c.boundElements ?? []).filter(b => idMap.has(b.id)).map(b => ({ ...b, id: idMap.get(b.id) }));
        for (const k of ["startBinding", "endBinding"]) if (c[k]) c[k] = idMap.has(c[k].elementId) ? { ...c[k], elementId: idMap.get(c[k].elementId) } : null;
        c.customData = { ...(c.customData ?? {}), layer: this.activeLayer, z: z + 1 + i };
        tx.add(c); out.push(c);
      });
    });
    this.select(out.filter(e => !isLabel(e)).map(e => e.id));
    return out.map(e => e.id);
  }

  // The selection as a library item (labels and picture files included); null if nothing is selected.
  libraryItem(name) {
    const els = this.selected().filter(e => !isLabel(e)); if (!els.length) return null;
    const all = this.withLabels(els);
    // As the file has them (label boxes, elbow fixedPoints), so the item opens right in excalidraw.com too.
    return itemFromElements(fileScene(this.doc, { elements: all }).elements, { name, files: this.doc.files, now: this.clock() });
  }
  insertLibraryItem(item, at) { return this.insertElements(item?.elements, item?.files, at); }

  group() {
    const els = this.selected(); if (els.length < 2) return;
    const g = newId();
    this.transact(tx => { for (const e of els) tx.get(e.id).groupIds = [...(e.groupIds ?? []), g]; });
  }
  ungroup() {
    this.transact(tx => { for (const e of this.selected()) if (e.groupIds?.length) tx.get(e.id).groupIds = e.groupIds.slice(0, -1); });
  }

  // Z-order within each element's layer.
  reorder(how) {
    const els = this.selected(); if (!els.length) return;
    this.transact(tx => {
      for (const e of els) {
        const layer = layerOf(e), peers = this.doc.live().filter(x => layerOf(x) === layer && !isLabel(x));
        const i = peers.findIndex(x => x.id === e.id), z = zOf(e);
        let nz = z;
        if (how === "front") nz = this.doc.maxZ(layer) + 1;
        if (how === "back") nz = this.doc.minZ(layer) - 1;
        if (how === "forward" && i < peers.length - 1) nz = zOf(peers[i + 1]) + 0.5;
        if (how === "backward" && i > 0) nz = zOf(peers[i - 1]) - 0.5;
        tx.get(e.id).customData = { ...e.customData, z: nz };
      }
    });
  }

  align(how) {
    const els = this.selected().filter(e => !isLabel(e)); if (els.length < 2) return;
    const B = unionBox(els.map(bounds));
    this.transact(tx => {
      for (const e of els) {
        const b = bounds(e); let dx = 0, dy = 0;
        if (how === "left") dx = B.x - b.x; if (how === "right") dx = B.x + B.w - (b.x + b.w); if (how === "hcenter") dx = B.x + B.w / 2 - (b.x + b.w / 2);
        if (how === "top") dy = B.y - b.y; if (how === "bottom") dy = B.y + B.h - (b.y + b.h); if (how === "vcenter") dy = B.y + B.h / 2 - (b.y + b.h / 2);
        this.shift(tx, e, dx, dy);
      }
    });
  }

  distribute(axis) {
    const els = this.selected().filter(e => !isLabel(e)); if (els.length < 3) return;
    const k = axis === "h" ? ["x", "w"] : ["y", "h"];
    const items = els.map(e => ({ e, b: bounds(e) })).sort((a, b) => a.b[k[0]] - b.b[k[0]]);
    const span = items[items.length - 1].b[k[0]] + items[items.length - 1].b[k[1]] - items[0].b[k[0]];
    const gap = (span - items.reduce((s, i) => s + i.b[k[1]], 0)) / (items.length - 1);
    this.transact(tx => {
      let at = items[0].b[k[0]];
      for (const { e, b } of items) { const d = at - b[k[0]]; this.shift(tx, e, axis === "h" ? d : 0, axis === "v" ? d : 0); at += b[k[1]] + gap; }
    });
  }

  shift(tx, e, dx, dy) {
    if (!dx && !dy) return;
    const c = tx.get(e.id); c.x += dx; c.y += dy;
    const l = isShape(e) && this.doc.labelOf(e); if (l) { const cl = tx.get(l.id); cl.x += dx; cl.y += dy; }
  }

  nudge(dx, dy) { const els = this.selected().filter(e => this.doc.editable(e)); if (els.length) this.transact(tx => els.forEach(e => this.shift(tx, e, dx, dy))); }

  // Style the selection, and remember it for the next element drawn.
  setStyle(patch) {
    Object.assign(this.style, patch);
    const els = this.selected(); if (!els.length) return this.changed();
    this.transact(tx => {
      for (const e of els) {
        const c = tx.get(e.id);
        for (const [k, v] of Object.entries(patch)) {
          if (k === "fontSize" || k === "fontFamily") {   // text takes its new size; a shape grows to fit its label
            if (c.type === "text") {
              c[k] = v;
              const host = c.containerId && tx.get(c.containerId);
              if (host && isShape(host)) this.fitHost(host, c);
              else if (!c.containerId) { const sz = textSize(c.text, c.fontSize, c.lineHeight, c.fontFamily); c.width = sz.w; c.height = sz.h; }
            }
            const l = isShape(e) && this.doc.labelOf(e);
            if (l) { const cl = tx.get(l.id); cl[k] = v; this.fitHost(c, cl); }
            continue;
          }
          if ((k === "backgroundColor" || k === "fillStyle") && !isShape(c)) continue;
          if (k === "roundness" && !["rectangle", "diamond", "arrow", "line"].includes(c.type)) continue;
          if (k === "elbowed") {   // arrow type: elbow arrows are routed; turning it off keeps the current bends
            if (c.type !== "arrow") continue;
            if (!v && c.elbowed) {
              const pts = resolvedPoints(this.doc, e); c.x = pts[0][0]; c.y = pts[0][1]; c.points = pts.map(p => [p[0] - c.x, p[1] - c.y]);
              // An elbow's auto-routed fixedPoints aren't user-chosen ports; keep explicit side-pinned ones.
              for (const k of ["startBinding", "endBinding"]) if (c[k]?.fixedPoint && !c[k]?.side) { const { fixedPoint, ...rest } = c[k]; c[k] = rest; }
            }
            c.elbowed = v; if (v) c.roundness = null;
            continue;
          }
          if (k === "endArrowhead" || k === "startArrowhead") { if (c.type === "arrow" || c.type === "line") c[k] = v; continue; }
          c[k] = v;
          if (k === "roundness" && v && isLinear(c) && !c.elbowed && c.points.length === 2) bow(c);   // a straight line made a curve: show it
          if (k === "strokeColor") { const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).strokeColor = v; }
        }
      }
    });
  }
  // Bends: one in the middle of each straight selected line, all of them gone, or one gone.
  addBend() {
    const els = this.selected().filter(e => isLinear(e) && e.type !== "freedraw" && !e.elbowed && e.points.length === 2);
    if (!els.length) { this.flash = "select a straight arrow or line to bend (or drag its ○)"; return this.changed(); }
    this.transact(tx => els.forEach(e => bow(tx.get(e.id))));
  }
  straighten() {
    const els = this.selected().filter(e => isLinear(e) && e.type !== "freedraw" && !e.elbowed && e.points.length > 2);
    this.transact(tx => els.forEach(e => { const c = tx.get(e.id); c.points = [c.points[0], c.points[c.points.length - 1]]; normalize(c); }));
  }
  removeBend(id, i) {
    this.transact(tx => { const c = tx.get(id); c.points.splice(i, 1); normalize(c); });
  }

  cycle(key, list) { const cur = this.selected()[0]?.[key] ?? this.style[key]; this.setStyle({ [key]: list[(list.indexOf(cur) + 1) % list.length] }); }

  toggleLock() { const els = this.selected(); if (els.length) { const v = !els.every(e => e.locked); this.transact(tx => els.forEach(e => { tx.get(e.id).locked = v; })); } }

  // ── layers (Photoshop-style: order, visibility, lock, opacity) ─────────

  layerOps(layers) { this.setAppState({ layers }); }
  addLayer(name) {
    const id = newId(), layers = [...this.doc.layers, { ...defaultLayer(this.doc.layers.length + 1, id), name: name ?? `Layer ${this.doc.layers.length + 1}` }];
    this.layerOps(layers); this.activeLayer = id; this.changed(); return id;
  }
  updateLayer(id, patch) { this.layerOps(this.doc.layers.map(l => (l.id === id ? { ...l, ...patch } : l))); if (patch.visible === false || patch.locked) { for (const e of this.selected()) if (layerOf(e) === id) this.sel.delete(e.id); } }
  moveLayer(id, dir) {
    const ls = [...this.doc.layers], i = ls.findIndex(l => l.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= ls.length) return;
    [ls[i], ls[j]] = [ls[j], ls[i]]; this.layerOps(ls);
  }
  deleteLayer(id) {
    if (this.doc.layers.length < 2) return;
    const ls = this.doc.layers.filter(l => l.id !== id), into = ls[Math.max(0, this.doc.layers.findIndex(l => l.id === id) - 1)].id;
    const els = this.doc.live().filter(e => layerOf(e) === id);
    if (els.length) this.transact(tx => els.forEach(e => { tx.get(e.id).customData = { ...e.customData, layer: into }; }));
    this.layerOps(ls); this.fixLayer();
  }
  moveToLayer(id) {
    const els = this.selected(); if (!els.length) return;
    let z = this.doc.maxZ(id);
    this.transact(tx => { for (const e of els) { tx.get(e.id).customData = { ...e.customData, layer: id, z: ++z }; const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).customData = { ...l.customData, layer: id, z }; } });
  }

  // ── animation ──────────────────────────────────────────────────────────

  // Give the selection a preset, staggered in selection order after what's already animated.
  animate(preset, { duration, stagger = 150, start, easing, loop } = {}) {
    const els = this.selected(), meta = getPreset(preset); if (!els.length || !meta) return;
    const dur = Math.max(50, Math.round(Number.isFinite(duration) ? duration : (meta.duration ?? 600)));
    let t = start != null && Number.isFinite(start) ? Math.max(0, Math.round(start)) : timelineEnd(this.doc.live().filter(e => !this.sel.has(e.id)));
    this.transact(tx => {
      for (const e of els) {
        const anim = { preset, start: t, duration: dur };
        if (easing && getEasing(easing)) anim.easing = easing;
        if (typeof loop === "boolean") anim.loop = loop;
        tx.get(e.id).customData = { ...e.customData, anim };
        const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).customData = { ...l.customData, anim };
        t += stagger;
      }
    });
  }
  updateAnimation(patch = {}) {
    const els = this.selected().filter(e => e.customData?.anim);
    if (!els.length) return;
    this.transact(tx => {
      for (const e of els) {
        const cur = e.customData.anim;
        const next = { ...cur };
        if (patch.preset && getPreset(patch.preset)) next.preset = patch.preset;
        if (patch.easing && getEasing(patch.easing)) next.easing = patch.easing;
        if (patch.start != null && Number.isFinite(+patch.start)) next.start = Math.max(0, Math.round(+patch.start));
        if (patch.duration != null && Number.isFinite(+patch.duration)) next.duration = Math.max(50, Math.round(+patch.duration));
        if (typeof patch.loop === "boolean") next.loop = patch.loop;
        tx.get(e.id).customData = { ...e.customData, anim: next };
        const l = isShape(e) && this.doc.labelOf(e); if (l) tx.get(l.id).customData = { ...l.customData, anim: next };
      }
    });
  }
  clearAnimation() {
    const els = this.selected();
    this.transact(tx => els.forEach(e => {
      const c = tx.get(e.id); const { anim, ...rest } = c.customData ?? {}; c.customData = rest;
      const l = isShape(e) && this.doc.labelOf(e);
      if (l) { const lc = tx.get(l.id); const { anim: _la, ...lrest } = lc.customData ?? {}; lc.customData = lrest; }
    }));
  }
  duration() { return Math.max(timelineEnd(this.doc.live()), 1); }
  playToggle() {
    if (this.play) { this.scrub = this.time(); this.play = null; }
    else { const from = this.scrub != null && this.scrub < this.duration() ? this.scrub : 0; this.play = { t0: this.clock(), from }; }
    this.changed();
  }
  stopPlay() { this.play = null; this.scrub = null; this.changed(); }
  seekTo(ms) {
    const t = Math.max(0, Math.min(this.duration(), Number.isFinite(ms) ? ms : 0));
    this.play = null; this.scrub = t; this.changed();
  }
  stepToStart() { this.seekTo(0); }
  stepToEnd() { this.seekTo(this.duration()); }
  restartPlay() { this.scrub = 0; this.play = { t0: this.clock(), from: 0 }; this.changed(); }
  setPlayLoop(on) { this.playLoop = !!on; this.changed(); }
  setReducedMotion(on) { const v = !!on; if (this.reducedMotion !== v) { this.reducedMotion = v; this.changed(); } }
  setPlaySpeed(speed) {
    const s = Number(speed);
    if (!Number.isFinite(s) || s <= 0) return;
    const t = this.play ? this.time() : null;
    if (this.play && t != null) this.play = { t0: this.clock(), from: t };
    this.playSpeed = s;
    this.changed();
  }
  time() {
    if (this.play) {
      const res = stepTimeline({ from: this.play.from, elapsedMs: this.clock() - this.play.t0, duration: this.duration(), speed: this.playSpeed, loop: this.playLoop });
      if (res.ended) { this.play = null; this.scrub = null; return null; }
      return res.time;
    }
    return this.scrub;
  }

  // Adapters call this on a timer only while it says so (laser fading, playback).
  needsTick() { return !!this.play || this.laser.length > 0; }
  tick() {
    const now = this.clock();
    if (this.laser.length) this.laser = this.laser.filter(p => now - p.t < 900);
    this.changed();
  }

  // ── view ───────────────────────────────────────────────────────────────

  fit(els = this.doc.visible().filter(e => !isLabel(e)), pad = 40, { animate = true } = {}) {
    const target = !els.length
      ? { x: 40, y: 40, scale: 1 }
      : (() => {
        const b = unionBox(els.map(bounds));
        const scale = Math.max(0.1, Math.min(1, Math.min((this.size.w - pad * 2) / (b.w || 1), (this.size.h - pad * 2) / (b.h || 1))));
        return { scale, x: (this.size.w / scale - b.w) / 2 - b.x, y: (this.size.h / scale - b.h) / 2 - b.y };
      })();
    if (animate) this.animateViewTo(target);
    else { this.cancelCamera(); this.view = target; this.changed(); }
  }

  // ── frames as pages ────────────────────────────────────────────────────

  // The board's frames in reading order: rows top to bottom, left to right within a row.
  frames() {
    return this.doc.visible().filter(e => e.type === "frame")
      .sort((a, b) => (Math.abs(a.y - b.y) < 40 ? a.x - b.x : a.y - b.y));
  }
  // Show one frame filling the view (it becomes the current page).
  goToFrame(id, opts) {
    const fs = this.frames(), i = fs.findIndex(f => f.id === id); if (i < 0) return;
    this.frameAt = id; this.fit([fs[i]], 24, opts);
    this.flash = `${fs[i].name || "Frame"} · ${i + 1} of ${fs.length}`;
  }
  // The next (step 1) or previous (-1) frame after the current one, wrapping around.
  stepFrame(step, opts) {
    const fs = this.frames();
    if (!fs.length) { this.flash = "no frames yet: F draws one, then they're pages"; return this.changed(); }
    const i = fs.findIndex(f => f.id === this.frameAt);
    const next = i < 0 ? (step > 0 ? 0 : fs.length - 1) : (i + step + fs.length) % fs.length;
    this.goToFrame(fs[next].id, opts);
  }

  // ── keys ───────────────────────────────────────────────────────────────

  // `key` as GPUI names it ("a", "backspace", "left", "[", ...); m = { shift, alt, cmd, ctrl }.
  // Returns true when the editor used the key.
  key(key, m = {}) {
    if (this.text) {
      if (key === "escape") { this.commitText(); return true; }
      return false;   // the adapter's text input owns typing
    }
    const k = key.toLowerCase(), mod = m.cmd || m.ctrl;
    if (mod) {
      const act = {
        z: () => (m.shift ? this.redo() : this.undo()), y: () => this.redo(),
        a: () => this.select(this.doc.visible().filter(e => !isLabel(e)).map(e => e.id)),
        d: () => this.cloneSelection(20, 20), c: () => this.copy(), x: () => { if (this.copy()) this.deleteIds([...this.sel]); },
        v: () => this.paste(), g: () => (m.shift ? this.ungroup() : this.group()),
        "]": () => this.reorder("front"), "[": () => this.reorder("back"),
        "=": () => this.zoomAt(this.view.scale * 1.2), "-": () => this.zoomAt(this.view.scale / 1.2), 0: () => this.zoomAt(1),
        l: () => m.shift && this.toggleLock(), "'": () => this.setAppState({ grid: this.grid ? 0 : 20 }),
      }[k];
      if (!act) return false;
      act(); return true;
    }
    if (m.shift && k === "1") { this.fit(); return true; }
    if (m.shift && k === "2") { this.fit(this.selected()); return true; }
    if (m.alt) {
      const a = { a: () => this.align("left"), d: () => this.align("right"), w: () => this.align("top"), s: () => this.align("bottom"), h: () => this.align("hcenter"), v: () => this.align("vcenter") }[k];
      if (a) { a(); return true; }
    }
    if (k === "<" || (m.shift && k === ",")) { this.rotateBy(-15); return true; }
    if (k === ">" || (m.shift && k === ".")) { this.rotateBy(15); return true; }
    if (m.shift && k === "h") { this.distribute("h"); return true; }
    if (m.shift && k === "v") { this.distribute("v"); return true; }
    const tool = TOOLS.find(t => t.keys.includes(k));
    if (tool && !m.shift) { this.setTool(tool.id); return true; }
    const arrows = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[k];
    if (arrows) { const s = m.shift ? 20 : this.grid || 2; this.nudge(arrows[0] * s, arrows[1] * s); return true; }
    switch (k) {
      case "backspace": case "delete": this.deleteIds([...this.sel]); return true;
      case "escape": if (this.g?.kind === "poly") this.finishPoly(); else { this.select([]); this.setTool("select"); this.stopPlay(); } return true;
      case "enter": {
        if (this.g?.kind === "poly") { this.finishPoly(); return true; }
        const el = this.selected()[0]; if (el) { this.beginText(el, center(bbox(el))); return true; } return false;
      }
      case "q": this.toolLock = !this.toolLock; this.flash = this.toolLock ? "tool locked" : "tool unlocked"; this.changed(); return true;
      case "c": this.cycle("strokeColor", STROKES); return true;
      case "b": this.cycle("backgroundColor", FILLS); return true;
      case "s": this.cycle("strokeStyle", STYLES); return true;
      case "w": this.cycle("strokeWidth", WIDTHS); return true;
      case "g": this.setStyle({ roughness: (this.selected()[0]?.roughness ?? this.style.roughness) ? 0 : 1 }); return true;
      case "]": this.reorder("forward"); return true;
      case "[": this.reorder("backward"); return true;
      case "space": if (!m.shift) return false; this.playToggle(); return true;   // shift-space plays the timeline
      case "pagedown": this.stepFrame(1); return true;   // frames as pages
      case "pageup": this.stepFrame(-1); return true;
      case "=": this.setStyle({ fontSize: Math.min(96, (this.selectedFont() ?? this.style.fontSize) + 4) }); return true;
      case "-": this.setStyle({ fontSize: Math.max(8, (this.selectedFont() ?? this.style.fontSize) - 4) }); return true;
    }
    return false;
  }
  selectedFont() { const e = this.selected()[0]; if (!e) return null; if (e.type === "text") return e.fontSize; const l = isShape(e) && this.doc.labelOf(e); return l?.fontSize ?? null; }

  // Picking a drawing tool clears the selection (as in Excalidraw): its handles would cover the
  // connection points an arrow aims at, and style changes then go to the next shape.
  setTool(id) {
    if (this.g?.kind === "poly") this.finishPoly();
    this.tool = id; if (id !== "select") this.hover = null;
    this.clearSnapPreview();
    if (DRAWING_TOOLS.has(id) && this.sel.size) this.select([]);
    this.changed();
  }

  // ── what to paint ──────────────────────────────────────────────────────

  // An element's drawn outline (rotation included), padded, in screen px.
  outlineCmds(el, padPx) {
    const pad = padPx / this.view.scale;
    let pts;
    if (angleOf(el)) {
      const b = bbox(el);
      pts = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => this.toScreen(elToWorld(el, { x, y })));
    } else {
      const b = bbox(el);
      pts = [[b.x - pad, b.y - pad], [b.x + b.w + pad, b.y - pad], [b.x + b.w + pad, b.y + b.h + pad], [b.x - pad, b.y + b.h + pad]].map(([x, y]) => this.toScreen({ x, y }));
    }
    return [...pts.map((p, i) => [i ? "L" : "M", p.x, p.y]), ["L", pts[0].x, pts[0].y]];
  }

  displayList(theme) {
    const rawTime = this.time();
    const time = effectiveAnimTime(rawTime, this.duration(), this.reducedMotion);
    const items = paintScene(this.doc, this.view, theme, { time: time ?? undefined, clip: this.size ? { w: this.size.w, h: this.size.h } : null });
    if (this.text) { const hide = this.text.id; for (let i = items.length - 1; i >= 0; i--) if (items[i].id === hide && items[i].t === "text") items.splice(i, 1); }
    if (this.erasing.size) for (const it of items) if (this.erasing.has(it.id)) it.opacity = (it.opacity ?? 1) * 0.25;
    if (rawTime != null) return items;   // playback: the board only
    const P = project(this.view), acc = theme.accent;
    if (this.hover && !this.sel.has(this.hover)) {
      const el = this.doc.get(this.hover);
      if (el) items.push({ t: "path", cmds: this.outlineCmds(el, 4), stroke: withAlpha(acc, 0.45), width: 1, dash: null });
    }
    if (this.snapPreview) paintSnapIndicator(this.doc, this.snapPreview, this.view, theme, items);
    const els = this.selected();
    if (els.length) {
      if (els.length > 1) for (const e of els) { if (isLabel(e)) continue; items.push({ t: "path", cmds: this.outlineCmds(e, 3), stroke: withAlpha(acc, 0.5), width: 1, dash: [3, 3] }); }
      const hs = this.handles();
      if (!hs.length || hs[0].kind !== "point") {
        const f = this.selFrame(6);
        if (f) items.push({ t: "path", cmds: [["M", f[0].x, f[0].y], ["L", f[1].x, f[1].y], ["L", f[2].x, f[2].y], ["L", f[3].x, f[3].y], ["L", f[0].x, f[0].y]], stroke: acc, width: 1, dash: els.some(e => e.locked) ? [4, 4] : null });
      }
      for (const h of hs) {
        if (h.kind === "rotate") {   // a small circle
          const r = 5, ring = [];
          for (let i = 0; i <= 16; i++) { const t = i / 16 * Math.PI * 2; ring.push([i ? "L" : "M", h.x + Math.cos(t) * r, h.y + Math.sin(t) * r]); }
          items.push({ t: "path", cmds: ring.slice(0, 16), fill: theme.bg });
          items.push({ t: "path", cmds: ring, stroke: acc, width: 1.5, dash: null });
          continue;
        }
        if (h.kind === "mid") {   // a bend handle: a small ring, quieter than the points
          const ring = []; for (let i = 0; i <= 16; i++) { const t = i / 16 * Math.PI * 2; ring.push([i ? "L" : "M", h.x + Math.cos(t) * 3.5, h.y + Math.sin(t) * 3.5]); }
          items.push({ t: "path", cmds: ring.slice(0, 16), fill: theme.bg });
          items.push({ t: "path", cmds: ring, stroke: withAlpha(acc, 0.7), width: 1.5, dash: null });
          continue;
        }
        const r = h.kind === "point" ? 5 : 4;
        items.push({ t: "path", cmds: rectCmds(h.x - r, h.y - r, r * 2, r * 2).slice(0, 4), fill: theme.bg });
        items.push({ t: "path", cmds: rectCmds(h.x - r, h.y - r, r * 2, r * 2), stroke: acc, width: 1.5, dash: null });
      }
    }
    if (this.g?.kind === "marquee") {
      const a = P(this.g.start.x, this.g.start.y), z = P(this.g.end.x, this.g.end.y), b = normBox({ x: a[0], y: a[1] }, { x: z[0], y: z[1] });
      items.push({ t: "path", cmds: rectCmds(b.x, b.y, b.w, b.h).slice(0, 4), fill: withAlpha(acc, 0.1) });
      items.push({ t: "path", cmds: rectCmds(b.x, b.y, b.w, b.h), stroke: acc, width: 1, dash: null });
    }
    for (const g of this.guides) {
      const cmds = g.x != null ? [["M", ...P(g.x, g.y0)], ["L", ...P(g.x, g.y1)]] : [["M", ...P(g.x0, g.y)], ["L", ...P(g.x1, g.y)]];
      items.push({ t: "path", cmds, stroke: "#e64980", width: 1, dash: null });
    }
    if (this.laser.length > 1) {
      const now = this.clock();
      for (let i = 1; i < this.laser.length; i++) {
        const a = this.laser[i - 1], b = this.laser[i]; if (b.start) continue;
        const age = Math.min(1, (now - b.t) / 900);
        items.push({ t: "path", cmds: [["M", ...P(a.x, a.y)], ["L", ...P(b.x, b.y)]], stroke: withAlpha("#ff3b30", 1 - age), width: 4 * (1 - age) + 1, dash: null });
      }
    }
    for (const [, peer] of this.peers) {
      if (!peer.cursor) continue;
      const [x, y] = P(peer.cursor.x, peer.cursor.y);
      items.push({ t: "path", cmds: [["M", x, y], ["L", x, y + 16], ["L", x + 4.5, y + 12], ["L", x + 11, y + 12]], fill: peer.color ?? acc });
      items.push({ t: "text", x: x + 10, y: y + 14, text: peer.name ?? "?", size: 11, color: peer.color ?? acc, align: "left", lineHeight: 1.2 });
    }
    return items;
  }
}

// Give a straight two-point line a bend in its middle, a fifth of its length to the side:
// with a curve type that's a gentle arc, otherwise a corner.
function bow(c) {
  const [a, b] = [c.points[0], c.points[c.points.length - 1]], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 8) return;
  c.points = [a, [(a[0] + b[0]) / 2 + dy / len * len * 0.2, (a[1] + b[1]) / 2 - dx / len * len * 0.2], b];
  normalize(c);
}

// A transaction: copies of elements to change, and what they were before.
class Tx {
  constructor(doc) { this.doc = doc; this.before = new Map(); this.dirty = new Map(); }
  get(id) {
    if (this.dirty.has(id)) return this.dirty.get(id);
    const el = this.doc.getAny(id); if (!el) return null;
    this.before.set(id, clone(el));
    const c = clone(el); this.dirty.set(id, c); return c;
  }
  add(el) { const c = clone(el); this.before.set(c.id, null); this.dirty.set(c.id, c); return c; }
}

function normBox(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
