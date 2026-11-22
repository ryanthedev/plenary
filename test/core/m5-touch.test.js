// M5 Phase 3 gate: multi-touch gesture recognizer, pinch midpoint invariance, stray-dot cancellation,
// 2/3-finger tap undo/redo, viewer 1-finger pan, palm rejection, adaptive touch slop, pointerCancel,
// and canonical pressure-sensitive freedraw recording, rendering & protocol round-trip.
import { test, expect } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement } from "../../packages/core/model.js";
import { paintScene } from "../../packages/core/render.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { THEMES } from "../../web/adapters/dom/paint.js";

function makeEditor(opts = {}) {
  let t = 1000;
  const ops = [];
  const ed = new Editor({
    clock: () => t,
    onOp: op => ops.push(op),
    ...opts,
  });
  ed.setSize(800, 600);
  return { ed, ops, now: () => t, advance: ms => { t += ms; } };
}

test("pinch midpoint invariance, scale clamping, and transition to camera inertia", () => {
  const { ed, advance } = makeEditor();
  ed.view = { x: 40, y: 60, scale: 1 };

  // Two fingers land around midpoint (300, 250) with separation 100 px.
  const f1 = { x: 250, y: 250 };
  const f2 = { x: 350, y: 250 };
  const mid0 = { x: 300, y: 250 };
  const worldUnderMid0 = ed.toWorld(mid0);

  ed.pointerDown(f1, { pointerId: 1, pointerType: "touch" });
  advance(10);
  ed.pointerDown(f2, { pointerId: 2, pointerType: "touch" });

  // Pure zoom-in (2x separation, midpoint stays at (300, 250)).
  advance(16);
  ed.pointerMove({ x: 200, y: 250 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 400, y: 250 }, { pointerId: 2, pointerType: "touch" });
  expect(ed.view.scale).toBeCloseTo(2, 5);
  const worldAfterZoomIn = ed.toWorld(mid0);
  expect(worldAfterZoomIn.x).toBeCloseTo(worldUnderMid0.x, 5);
  expect(worldAfterZoomIn.y).toBeCloseTo(worldUnderMid0.y, 5);

  // Simultaneous zoom-out + pan: midpoint shifts to (360, 290) and separation shrinks.
  advance(16);
  ed.pointerMove({ x: 310, y: 290 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 410, y: 290 }, { pointerId: 2, pointerType: "touch" });
  const mid1 = { x: 360, y: 290 };
  const worldAfterPanZoom = ed.toWorld(mid1);
  expect(worldAfterPanZoom.x).toBeCloseTo(worldUnderMid0.x, 5);
  expect(worldAfterPanZoom.y).toBeCloseTo(worldUnderMid0.y, 5);

  // Scale clamping at upper bound (8) and lower bound (0.1).
  advance(16);
  ed.pointerMove({ x: -1000, y: 290 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 2000, y: 290 }, { pointerId: 2, pointerType: "touch" });
  expect(ed.view.scale).toBe(8);

  advance(16);
  ed.pointerMove({ x: 359, y: 290 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 361, y: 290 }, { pointerId: 2, pointerType: "touch" });
  expect(ed.view.scale).toBe(0.1);

  // Fast 2-finger pan flick transitions into Phase 1 camera inertia on release.
  ed.pointerUp({ x: 359, y: 290 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerUp({ x: 361, y: 290 }, { pointerId: 2, pointerType: "touch" });
  ed.cancelCamera();
  ed.view = { x: 0, y: 0, scale: 1 };

  ed.pointerDown({ x: 200, y: 200 }, { pointerId: 3, pointerType: "touch" });
  advance(10);
  ed.pointerDown({ x: 300, y: 200 }, { pointerId: 4, pointerType: "touch" });
  advance(16);
  ed.pointerMove({ x: 230, y: 200 }, { pointerId: 3, pointerType: "touch" });
  ed.pointerMove({ x: 330, y: 200 }, { pointerId: 4, pointerType: "touch" });
  advance(16);
  ed.pointerMove({ x: 270, y: 200 }, { pointerId: 3, pointerType: "touch" });
  ed.pointerMove({ x: 370, y: 200 }, { pointerId: 4, pointerType: "touch" });
  advance(10);
  ed.pointerUp({ x: 270, y: 200 }, { pointerId: 3, pointerType: "touch" });
  ed.pointerUp({ x: 370, y: 200 }, { pointerId: 4, pointerType: "touch" });

  expect(ed.hasCameraMotion()).toBe(true);
  const xBeforeCoast = ed.view.x;
  ed.stepCamera(16);
  expect(ed.view.x).toBeGreaterThan(xBeforeCoast);
});

test("stray-dot cancellation on 2nd-finger land leaves no freedraw element and clean undo stack", () => {
  const { ed, ops, advance } = makeEditor();
  ed.setTool("freedraw");

  // Finger 1 lands, starts a live freedraw preview, then finger 2 lands 25 ms later (< 80 ms, < 8 px).
  ed.pointerDown({ x: 200, y: 200 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);   // live preview exists transiently
  advance(25);
  ed.pointerMove({ x: 202, y: 201 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerDown({ x: 300, y: 200 }, { pointerId: 2, pointerType: "touch" });

  // Preview must be rolled back completely, with zero committed ops and clean undo stack.
  expect(ed.doc.live().length).toBe(0);
  expect(ed.doc.byId.size).toBe(0);
  expect(ed.undoStack.length).toBe(0);
  expect(ops.filter(o => !o.transient).length).toBe(0);

  // Pinching and releasing leaves the board completely clean.
  advance(16);
  ed.pointerMove({ x: 180, y: 200 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 320, y: 200 }, { pointerId: 2, pointerType: "touch" });
  ed.pointerUp({ x: 180, y: 200 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerUp({ x: 320, y: 200 }, { pointerId: 2, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(0);
  expect(ed.undoStack.length).toBe(0);

  // Contrast: an intentional stroke (>= 80 ms or >= 8 px) before 2nd finger lands IS committed.
  ed.pointerDown({ x: 100, y: 100 }, { pointerId: 5, pointerType: "touch" });
  advance(100);
  ed.pointerMove({ x: 140, y: 120 }, { pointerId: 5, pointerType: "touch" });
  ed.pointerDown({ x: 240, y: 120 }, { pointerId: 6, pointerType: "touch" });
  ed.pointerUp({ x: 140, y: 120 }, { pointerId: 5, pointerType: "touch" });
  ed.pointerUp({ x: 240, y: 120 }, { pointerId: 6, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);
  expect(ed.undoStack.length).toBe(1);
});

test("2-finger tap Undo and 3-finger tap Redo (respecting slop, timeout, and readOnly)", () => {
  const { ed, advance } = makeEditor();
  ed.setTool("rectangle");
  ed.pointerDown({ x: 100, y: 100 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 200, y: 180 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerUp({ x: 200, y: 180 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);

  // 2-finger tap (< 250 ms, within slop) → Undo.
  advance(50);
  ed.pointerDown({ x: 300, y: 300 }, { pointerId: 10, pointerType: "touch" });
  advance(15);
  ed.pointerDown({ x: 360, y: 300 }, { pointerId: 11, pointerType: "touch" });
  advance(40);
  ed.pointerUp({ x: 302, y: 301 }, { pointerId: 10, pointerType: "touch" });
  advance(10);
  ed.pointerUp({ x: 359, y: 302 }, { pointerId: 11, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(0);

  // 3-finger tap (< 250 ms, within slop) → Redo.
  advance(50);
  ed.pointerDown({ x: 300, y: 300 }, { pointerId: 20, pointerType: "touch" });
  advance(10);
  ed.pointerDown({ x: 350, y: 300 }, { pointerId: 21, pointerType: "touch" });
  advance(10);
  ed.pointerDown({ x: 400, y: 300 }, { pointerId: 22, pointerType: "touch" });
  advance(40);
  ed.pointerUp({ x: 301, y: 300 }, { pointerId: 20, pointerType: "touch" });
  ed.pointerUp({ x: 351, y: 300 }, { pointerId: 21, pointerType: "touch" });
  ed.pointerUp({ x: 401, y: 300 }, { pointerId: 22, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);

  // Long press (>= 250 ms) with 2 fingers does NOT trigger undo.
  advance(50);
  ed.pointerDown({ x: 300, y: 300 }, { pointerId: 30, pointerType: "touch" });
  advance(10);
  ed.pointerDown({ x: 360, y: 300 }, { pointerId: 31, pointerType: "touch" });
  advance(260);
  ed.pointerUp({ x: 300, y: 300 }, { pointerId: 30, pointerType: "touch" });
  ed.pointerUp({ x: 360, y: 300 }, { pointerId: 31, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);

  // readOnly mode ignores 2-finger tap undo.
  ed.readOnly = true;
  advance(50);
  ed.pointerDown({ x: 300, y: 300 }, { pointerId: 40, pointerType: "touch" });
  advance(10);
  ed.pointerDown({ x: 360, y: 300 }, { pointerId: 41, pointerType: "touch" });
  advance(30);
  ed.pointerUp({ x: 300, y: 300 }, { pointerId: 40, pointerType: "touch" });
  ed.pointerUp({ x: 360, y: 300 }, { pointerId: 41, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);
});

test("viewer mode (readOnly): 1-finger drag pans immediately with no box-select", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 120, height: 80 });
  const { ed, ops } = makeEditor({ scene: { elements: [rect] }, readOnly: true });
  ed.setTool("select");
  const v0 = { ...ed.view };

  ed.pointerDown({ x: 20, y: 20 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.g?.kind).toBe("pan");
  ed.pointerMove({ x: 120, y: 90 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerUp({ x: 120, y: 90 }, { pointerId: 1, pointerType: "touch" });

  expect(ed.view.x).toBeCloseTo(v0.x + 100, 5);
  expect(ed.view.y).toBeCloseTo(v0.y + 70, 5);
  expect(ed.sel.size).toBe(0);
  expect(ops.length).toBe(0);
});

test("palm rejection suppresses single-finger touch during pen stroke and 300 ms grace window, while 2-finger touch pan/zoom still works", () => {
  const { ed, advance } = makeEditor();
  ed.setTool("freedraw");

  // Start pen stroke.
  ed.pointerDown({ x: 100, y: 100 }, { pointerId: 1, pointerType: "pen", pressure: 0.4 });
  advance(16);
  ed.pointerMove({ x: 130, y: 110 }, { pointerId: 1, pointerType: "pen", pressure: 0.6 });

  // Accidental single-finger palm touch lands, moves, and lifts while pen is down.
  ed.pointerDown({ x: 400, y: 400 }, { pointerId: 2, pointerType: "touch" });
  ed.pointerMove({ x: 420, y: 410 }, { pointerId: 2, pointerType: "touch" });
  ed.pointerUp({ x: 420, y: 410 }, { pointerId: 2, pointerType: "touch" });

  // Multi-contact palm (2+ simultaneous touch contacts while pen is actively down) must NOT
  // enter pinch, zoom, cancel, or interrupt the active pen stroke.
  const viewDuringPen = { ...ed.view };
  ed.pointerDown({ x: 350, y: 350 }, { pointerId: 20, pointerType: "touch", isPrimary: true });
  ed.pointerDown({ x: 450, y: 350 }, { pointerId: 21, pointerType: "touch", isPrimary: false });
  ed.pointerMove({ x: 300, y: 350 }, { pointerId: 20, pointerType: "touch" });
  ed.pointerMove({ x: 500, y: 350 }, { pointerId: 21, pointerType: "touch" });
  ed.pointerUp({ x: 300, y: 350 }, { pointerId: 20, pointerType: "touch" });
  ed.pointerUp({ x: 500, y: 350 }, { pointerId: 21, pointerType: "touch" });
  expect(ed.view).toEqual(viewDuringPen);
  expect(ed.mt).toBeNull();

  // Pen stroke continues uninterrupted and finishes cleanly.
  advance(16);
  ed.pointerMove({ x: 160, y: 120 }, { pointerId: 1, pointerType: "pen", pressure: 0.8 });
  ed.pointerUp({ x: 160, y: 120 }, { pointerId: 1, pointerType: "pen", pressure: 0.8 });
  expect(ed.doc.live().length).toBe(1);
  expect(ed.doc.live()[0].points.length).toBe(3);

  // Within 300 ms grace window (+120 ms): single-finger touch draw is suppressed.
  advance(120);
  ed.pointerDown({ x: 250, y: 250 }, { pointerId: 3, pointerType: "touch" });
  ed.pointerMove({ x: 290, y: 260 }, { pointerId: 3, pointerType: "touch" });
  ed.pointerUp({ x: 290, y: 260 }, { pointerId: 3, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);

  // Still within 300 ms grace window (+50 ms, total 170 ms): 2-finger touch pinch/pan DOES work!
  advance(50);
  const scale0 = ed.view.scale;
  ed.pointerDown({ x: 200, y: 200 }, { pointerId: 4, pointerType: "touch" });
  ed.pointerDown({ x: 300, y: 200 }, { pointerId: 5, pointerType: "touch" });
  advance(16);
  ed.pointerMove({ x: 150, y: 200 }, { pointerId: 4, pointerType: "touch" });
  ed.pointerMove({ x: 350, y: 200 }, { pointerId: 5, pointerType: "touch" });
  ed.pointerUp({ x: 150, y: 200 }, { pointerId: 4, pointerType: "touch" });
  ed.pointerUp({ x: 350, y: 200 }, { pointerId: 5, pointerType: "touch" });
  expect(ed.view.scale).toBeCloseTo(scale0 * 2, 4);
  expect(ed.doc.live().length).toBe(1);

  // After 300 ms grace window (+200 ms, total > 300 ms): single-finger touch draws again.
  advance(200);
  ed.pointerDown({ x: 100, y: 300 }, { pointerId: 6, pointerType: "touch" });
  ed.pointerMove({ x: 150, y: 320 }, { pointerId: 6, pointerType: "touch" });
  ed.pointerUp({ x: 150, y: 320 }, { pointerId: 6, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(2);
});

test("adaptive touch slop scales HANDLE, SNAP/tol, DRAG_SLOP, and PORT_SNAP by 2.5x for touch vs mouse/pen", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 100, height: 80 });
  const { ed } = makeEditor({ scene: { elements: [rect] } });
  ed.view = { x: 0, y: 0, scale: 1 };
  ed.select(["r1"]);

  // HANDLE: 5 px for mouse/pen, 12.5 px for touch.
  const nw = ed.handles().find(h => h.kind === "resize" && h.dir === "nw");
  const near = { x: nw.x + 10, y: nw.y };
  expect(ed.handleAt(near, "mouse")).toBeNull();
  expect(ed.handleAt(near, "pen")).toBeNull();
  expect(ed.handleAt(near, "touch")?.dir).toBe("nw");

  // tol / SNAP: 2.5x for touch.
  expect(ed.tol("touch")).toBeCloseTo(ed.tol("mouse") * 2.5, 5);
  expect(ed.tol("pen")).toBeCloseTo(ed.tol("mouse"), 5);

  // DRAG_SLOP: 5 px drag moves for mouse (>= 3) but NOT for touch (< 7.5); 10 px moves for touch.
  ed.pointerDown({ x: 150, y: 140 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 155, y: 140 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.g?.moved).toBe(false);
  ed.pointerMove({ x: 162, y: 140 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.g?.moved).toBe(true);
  ed.pointerUp({ x: 162, y: 140 }, { pointerId: 1, pointerType: "touch" });

  const xAfterTouch = ed.doc.get("r1").x;
  ed.pointerDown({ x: xAfterTouch + 50, y: 140 }, { pointerId: 2, pointerType: "mouse" });
  ed.pointerMove({ x: xAfterTouch + 55, y: 140 }, { pointerId: 2, pointerType: "mouse" });
  expect(ed.g?.moved).toBe(true);
  ed.pointerUp({ x: xAfterTouch + 55, y: 140 }, { pointerId: 2, pointerType: "mouse" });

  // PORT_SNAP: port on right edge is at (x + 100, 140). 20 px outside snaps for touch (<= 30), not for mouse/pen (> 12).
  const rx = ed.doc.get("r1").x;
  const portProbe = { x: rx + 120, y: 140 };
  expect(ed.bindingAt(portProbe, null, { pointerType: "mouse" })).toBeNull();
  expect(ed.bindingAt(portProbe, null, { pointerType: "pen" })).toBeNull();
  expect(ed.bindingAt(portProbe, null, { pointerType: "touch" })?.elementId).toBe("r1");
});

test("pointerCancel clears stuck pointers and rolls back in-progress preview cleanly", () => {
  const { ed } = makeEditor();
  ed.setTool("freedraw");

  ed.pointerDown({ x: 100, y: 100 }, { pointerId: 7, pointerType: "touch" });
  ed.pointerMove({ x: 130, y: 120 }, { pointerId: 7, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);

  ed.pointerCancel({ x: 130, y: 120 }, { pointerId: 7, pointerType: "touch" });
  expect(ed.pointers.size).toBe(0);
  expect(ed.g).toBeNull();
  expect(ed.doc.live().length).toBe(0);
  expect(ed.undoStack.length).toBe(0);

  // Subsequent stroke works cleanly with no jammed recognizer.
  ed.pointerDown({ x: 200, y: 200 }, { pointerId: 8, pointerType: "touch" });
  ed.pointerMove({ x: 250, y: 240 }, { pointerId: 8, pointerType: "touch" });
  ed.pointerUp({ x: 250, y: 240 }, { pointerId: 8, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(1);
});

test("pressures recording, variable-width rendering, legacy/malformed fallback, and protocol envelope round-trip", () => {
  const { ed } = makeEditor();
  ed.setTool("freedraw");
  ed.setStyle({ strokeWidth: 4 });

  // Record a pen stroke with varying pressure (including out-of-range values to verify clamping to [0.1, 1.0]).
  ed.pointerDown({ x: 50, y: 50 }, { pointerId: 1, pointerType: "pen", pressure: 0 });
  ed.pointerMove({ x: 80, y: 50 }, { pointerId: 1, pointerType: "pen", pressure: 0.35 });
  ed.pointerMove({ x: 120, y: 60 }, { pointerId: 1, pointerType: "pen", pressure: 0.75 });
  ed.pointerMove({ x: 160, y: 80 }, { pointerId: 1, pointerType: "pen", pressure: 2.5 });
  ed.pointerUp({ x: 160, y: 80 }, { pointerId: 1, pointerType: "pen", pressure: 2.5 });

  const stroke = ed.doc.live()[0];
  expect(stroke.type).toBe("freedraw");
  expect(stroke.points.length).toBe(4);
  expect(stroke.points.every(pt => Array.isArray(pt) && pt.length === 2)).toBe(true);   // tuples never mutated
  expect(stroke.pressures).toEqual([0.1, 0.35, 0.75, 1.0]);

  // Protocol envelope accepts valid pressures and rejects malformed pressures.
  const validOp = { stream: "board", id: "c1:1", sentAt: 0, op: { elements: [stroke] } };
  expect(opProblem(validOp)).toBeNull();

  const emptyPressuresOp = { stream: "board", id: "c1:2", sentAt: 0, op: { elements: [{ ...stroke, pressures: [] }] } };
  expect(opProblem(emptyPressuresOp)).toBeNull();

  const badPressuresOp = { stream: "board", id: "c1:3", sentAt: 0, op: { elements: [{ ...stroke, pressures: [0.2, "oops"] }] } };
  expect(opProblem(badPressuresOp)?.code).toBe("bad-op");

  // Variable-width rendering emits multiple path items with varying widths.
  const view = { x: 0, y: 0, scale: 1 };
  const items = paintScene(ed.doc, view, THEMES.light);
  const widths = new Set(items.filter(it => it.id === stroke.id).map(it => it.width));
  expect(widths.size).toBeGreaterThan(1);
  expect(Math.min(...widths)).toBeLessThan(Math.max(...widths));

  // Fallback cases: legacy (missing), empty, uniform, mismatched length, malformed (NaN / non-array).
  const basePts = [[0, 0], [30, 10], [60, 20], [90, 30]];
  const fallbacks = [
    undefined,
    [],
    [0.5, 0.5, 0.5, 0.5],
    [0.2, 0.9],
    [0.2, NaN, 0.7, 0.9],
    "not-an-array",
  ];
  for (const pressures of fallbacks) {
    const el = makeElement("freedraw", { id: "fd", x: 10, y: 10, strokeWidth: 4, points: basePts, pressures });
    const d = new Doc({ elements: [el] });
    const out = paintScene(d, view, THEMES.light);
    expect(out.length).toBe(1);
    expect(out[0].width).toBeCloseTo(4 * 1.1, 5);
  }

  // Mouse strokes with browser-default pressure (0.5) do not bloat `el.pressures`.
  const { ed: med } = makeEditor();
  med.setTool("freedraw");
  med.pointerDown({ x: 20, y: 20 }, { pointerId: 1, pointerType: "mouse", pressure: 0.5 });
  med.pointerMove({ x: 50, y: 30 }, { pointerId: 1, pointerType: "mouse", pressure: 0.5 });
  med.pointerMove({ x: 80, y: 40 }, { pointerId: 1, pointerType: "mouse", pressure: 0.5 });
  med.pointerUp({ x: 80, y: 40 }, { pointerId: 1, pointerType: "mouse", pressure: 0.5 });
  expect(med.doc.live()[0].pressures).toEqual([]);
});

test("3rd-finger land and lift during pinch re-anchors cleanly with no view jump", () => {
  const { ed, advance } = makeEditor();
  ed.view = { x: 20, y: 30, scale: 1 };

  // Start a 2-finger pinch.
  ed.pointerDown({ x: 200, y: 200 }, { pointerId: 1, pointerType: "touch", isPrimary: true });
  advance(10);
  ed.pointerDown({ x: 300, y: 200 }, { pointerId: 2, pointerType: "touch", isPrimary: false });
  advance(16);
  ed.pointerMove({ x: 180, y: 200 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerMove({ x: 320, y: 200 }, { pointerId: 2, pointerType: "touch" });

  // 3rd finger lands far away, then finger 1 lifts (leaving fingers 2 and 3 as the remaining pair).
  advance(16);
  ed.pointerDown({ x: 500, y: 400 }, { pointerId: 3, pointerType: "touch", isPrimary: false });
  const viewBeforeLift = { ...ed.view };
  advance(16);
  ed.pointerUp({ x: 180, y: 200 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.view).toEqual(viewBeforeLift);

  // Small 2 px pan of remaining pair (2 & 3) must move view by ~2 px / scale, NOT jump to the old pair's midpoint/distance!
  advance(16);
  ed.pointerMove({ x: 322, y: 200 }, { pointerId: 2, pointerType: "touch" });
  ed.pointerMove({ x: 502, y: 400 }, { pointerId: 3, pointerType: "touch" });
  expect(ed.view.scale).toBeCloseTo(viewBeforeLift.scale, 4);
  expect(ed.view.x).toBeCloseTo(viewBeforeLift.x + 2 / viewBeforeLift.scale, 4);
  expect(ed.view.y).toBeCloseTo(viewBeforeLift.y, 4);

  ed.pointerUp({ x: 322, y: 200 }, { pointerId: 2, pointerType: "touch" });
  ed.pointerUp({ x: 502, y: 400 }, { pointerId: 3, pointerType: "touch" });
});

test("stuck pointer (missed pointerUp) recovers cleanly on primary press, mouse press, or stale timeout", () => {
  const { ed, advance } = makeEditor();
  ed.setTool("freedraw");

  // Simulate a missed pointerUp on touch pointerId 1.
  ed.pointerDown({ x: 100, y: 100 }, { pointerId: 1, pointerType: "touch", isPrimary: true });
  ed.pointerMove({ x: 140, y: 110 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.pointers.size).toBe(1);

  // A subsequent primary touch press (pointerId 2, isPrimary: true) clears the stuck pointer instead of locking into pinch.
  advance(200);
  ed.pointerDown({ x: 200, y: 200 }, { pointerId: 2, pointerType: "touch", isPrimary: true });
  expect(ed.mt).toBeNull();
  expect(ed.pointers.size).toBe(1);
  ed.pointerMove({ x: 260, y: 230 }, { pointerId: 2, pointerType: "touch" });
  ed.pointerUp({ x: 260, y: 230 }, { pointerId: 2, pointerType: "touch" });
  expect(ed.doc.live().length).toBe(2);

  // Simulate another missed pointerUp on touch pointerId 3, then a mouse press arrives.
  ed.pointerDown({ x: 50, y: 50 }, { pointerId: 3, pointerType: "touch", isPrimary: true });
  ed.pointerMove({ x: 80, y: 60 }, { pointerId: 3, pointerType: "touch" });
  advance(100);
  ed.pointerDown({ x: 300, y: 300 }, { pointerId: 10, pointerType: "mouse" });
  expect(ed.mt).toBeNull();
  expect(ed.pointers.size).toBe(1);
  ed.pointerMove({ x: 340, y: 320 }, { pointerId: 10, pointerType: "mouse" });
  ed.pointerUp({ x: 340, y: 320 }, { pointerId: 10, pointerType: "mouse" });
  expect(ed.doc.live().length).toBe(4);

  // Stale timeout (>= 15_000 ms) also prunes an orphaned pointer even without isPrimary.
  ed.pointerDown({ x: 10, y: 10 }, { pointerId: 4, pointerType: "touch" });
  advance(16_000);
  ed.pointerDown({ x: 400, y: 400 }, { pointerId: 5, pointerType: "touch" });
  expect(ed.mt).toBeNull();
  expect(ed.pointers.size).toBe(1);
  ed.pointerUp({ x: 400, y: 400 }, { pointerId: 5, pointerType: "touch" });
});
