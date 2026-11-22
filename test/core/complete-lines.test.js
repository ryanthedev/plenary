// Wave 3 Track 1 — Issue #106: Connecting Complete Lines
// Port snapping, visual snap indicators, reliable startBinding/endBinding attachment & detachment,
// mid-segment bend preservation, elbow re-routing, and forgiving touch snap radius.
import { test, expect } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { makeElement } from "../../packages/core/model.js";
import { bindable, bindTargetAt, portsOf, resolvedPoints } from "../../packages/core/geometry.js";
import { crossings } from "../../packages/core/elbow.js";
import { paintSnapIndicator } from "../../packages/core/render.js";

const THEME = { fg: "#18181B", bg: "#F8F7F4", accent: "#3B48E8", dim: "#625F57" };

function makeEditor(elements = []) {
  let t = 1000;
  const ops = [];
  const ed = new Editor({
    scene: { elements },
    clock: () => t,
    onOp: op => ops.push(op),
  });
  ed.setSize(1000, 800);
  ed.view = { x: 0, y: 0, scale: 1 };
  return { ed, ops, advance: ms => { t += ms; } };
}

test("port/anchor snap discovery on shapes, frames, and images with zoom scaling and forgiving touch radius", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 100, height: 80 });
  const ellipse = makeElement("ellipse", { id: "e1", x: 300, y: 100, width: 100, height: 80 });
  const diamond = makeElement("diamond", { id: "d1", x: 500, y: 100, width: 100, height: 80 });
  const frame = makeElement("frame", { id: "f1", x: 100, y: 300, width: 220, height: 140, name: "Frame 1" });
  const image = makeElement("image", { id: "i1", x: 420, y: 300, width: 120, height: 90, fileId: "a".repeat(40) });

  const { ed } = makeEditor([rect, ellipse, diamond, frame, image]);

  // All 5 target types are bindable.
  for (const el of [rect, ellipse, diamond, frame, image]) {
    expect(bindable(el)).toBe(true);
    expect(portsOf(el).map(p => p.side)).toEqual(["top", "right", "bottom", "left"]);
  }

  // Port snapping on rect right port (200, 140), ellipse top port (350, 100), diamond left port (500, 140).
  expect(ed.snapAt({ x: 204, y: 140 })).toMatchObject({ targetId: "r1", side: "right" });
  expect(ed.snapAt({ x: 350, y: 96 })).toMatchObject({ targetId: "e1", side: "top" });
  expect(ed.snapAt({ x: 496, y: 140 })).toMatchObject({ targetId: "d1", side: "left" });

  // Frame: ports and outline bind, but empty interior does NOT bind (frames stay hollow containers).
  expect(ed.snapAt({ x: 210, y: 300 })).toMatchObject({ targetId: "f1", side: "top" });
  expect(ed.snapAt({ x: 100, y: 340 })).toMatchObject({ targetId: "f1", side: null });
  expect(bindTargetAt(ed.doc, { x: 210, y: 370 }, null, 8)).toBeNull();
  expect(ed.snapAt({ x: 210, y: 370 })).toBeNull();

  // Image: ports and body both bind.
  expect(ed.snapAt({ x: 540, y: 345 })).toMatchObject({ targetId: "i1", side: "right" });
  expect(ed.snapAt({ x: 480, y: 345 })).toMatchObject({ targetId: "i1", side: null });

  // Zoom scaling: at scale = 2, screen 12 px = 6 world px; 9 world px is outside mouse snap,
  // but still well inside touch snap (12 * 2.5 / 2 = 15 world px).
  ed.view = { x: 0, y: 0, scale: 2 };
  const zoomProbe = { x: 209, y: 140 };   // 9 world px right of r1's right port (200, 140)
  expect(ed.snapAt(zoomProbe, null, { pointerType: "mouse" })).toBeNull();
  expect(ed.snapAt(zoomProbe, null, { pointerType: "pen" })).toBeNull();
  expect(ed.snapAt(zoomProbe, null, { pointerType: "touch" })).toMatchObject({ targetId: "r1", side: "right" });

  // Zoomed out (scale = 0.5): 12 screen px = 24 world px; 20 world px snaps even for mouse.
  ed.view = { x: 0, y: 0, scale: 0.5 };
  expect(ed.snapAt({ x: 220, y: 140 }, null, { pointerType: "mouse" })).toMatchObject({ targetId: "r1", side: "right" });

  // Cmd/Ctrl bypasses snapping cleanly.
  ed.view = { x: 0, y: 0, scale: 1 };
  expect(ed.snapAt({ x: 200, y: 140 }, null, { cmd: true })).toBeNull();
  expect(ed.snapAt({ x: 200, y: 140 }, null, { ctrl: true })).toBeNull();
});

test("visual snap indicator state & rendering during hover, creation drag, endpoint handle drag, and cleanup", () => {
  const a = makeElement("rectangle", { id: "a", x: 100, y: 100, width: 100, height: 80 });
  const b = makeElement("ellipse", { id: "b", x: 320, y: 100, width: 100, height: 80 });
  const { ed } = makeEditor([a, b]);

  // Hover with arrow tool over shape A's body (non-port): outline + 4 port dots, NO active dot, and no version spam on pixel moves.
  ed.setTool("arrow");
  ed.pointerMove({ x: 150, y: 140 }, { pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "a", side: null });
  const dlBody = ed.displayList(THEME);
  expect(dlBody.some(it => it.id === "snap:outline")).toBe(true);
  expect(dlBody.some(it => it.id === "snap:port:top")).toBe(true);
  expect(dlBody.some(it => it.id === "snap:port:right")).toBe(true);
  expect(dlBody.some(it => it.id === "snap:active")).toBe(false);

  const vBefore = ed.version;
  ed.pointerMove({ x: 152, y: 142 }, { pointerType: "mouse" });
  expect(ed.version).toBe(vBefore);   // no spurious repaint inside shape body

  // Hover over shape A's right port (200, 140): active halo & anchor ring on that port.
  ed.pointerMove({ x: 202, y: 140 }, { pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "a", side: "right" });
  expect(ed.cursor()).toBe("pointer");

  const dlHover = ed.displayList(THEME);
  expect(dlHover.some(it => it.id === "snap:outline")).toBe(true);
  expect(dlHover.some(it => it.id === "snap:halo")).toBe(true);
  expect(dlHover.some(it => it.id === "snap:active")).toBe(true);
  expect(dlHover.some(it => it.id === "snap:port:top")).toBe(true);
  expect(dlHover.some(it => it.id === "snap:port:left")).toBe(true);
  expect(dlHover.some(it => it.id === "snap:port:bottom")).toBe(true);

  // Pure render helper works standalone and recomputes geometry live from doc.
  const direct = [];
  paintSnapIndicator(ed.doc, ed.snapPreview, ed.view, THEME, direct);
  expect(direct.length).toBeGreaterThan(6);

  // Tool switch clears snap indicator cleanly.
  ed.setTool("select");
  expect(ed.snapPreview).toBeNull();
  expect(ed.hint).toBeNull();
  expect(ed.displayList(THEME).some(it => it.id?.startsWith("snap:"))).toBe(false);

  // Creation drag: press on A right port, drag to empty space (clears), drag onto B body (non-port active dot at live resolved endpoint), release (clears).
  ed.setTool("arrow");
  ed.pointerDown({ x: 200, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "a", side: "right", endIndex: 0 });

  ed.pointerMove({ x: 260, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toBeNull();

  // Drag into B's center (370, 140) — non-port binding places active dot at the arrow's resolved endpoint on B's outline.
  ed.pointerMove({ x: 370, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "b", side: null, endIndex: -1 });
  const liveArrow = ed.doc.get(ed.snapPreview.lineId);
  const resolvedEnd = resolvedPoints(ed.doc, liveArrow).at(-1);
  const dlDragBody = ed.displayList(THEME);
  const activeDot = dlDragBody.find(it => it.id === "snap:active" && it.fill);
  expect(activeDot).toBeTruthy();
  // Active dot center (average of circle cmds) matches the live resolved endpoint, not the raw cursor center (370, 140).
  const cx = activeDot.cmds.reduce((s, c) => s + c[1], 0) / activeDot.cmds.length;
  const cy = activeDot.cmds.reduce((s, c) => s + c[2], 0) / activeDot.cmds.length;
  expect(cx).toBeCloseTo(resolvedEnd[0], 0);
  expect(cy).toBeCloseTo(resolvedEnd[1], 0);

  // Move to B's left port (320, 140) and release.
  ed.pointerMove({ x: 322, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "b", side: "left" });

  ed.pointerUp({ x: 322, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toBeNull();
  expect(ed.displayList(THEME).some(it => it.id?.startsWith("snap:"))).toBe(false);

  // Endpoint handle drag + pointerCancel clears snap indicator cleanly.
  const arrow = ed.doc.live().find(e => e.type === "arrow");
  ed.select([arrow.id]);
  const endHandle = ed.handles().find(h => h.kind === "point" && h.i === arrow.points.length - 1);
  ed.pointerDown({ x: endHandle.x, y: endHandle.y }, { pointerId: 2, pointerType: "mouse" });
  expect(ed.snapPreview?.targetId).toBe("b");

  ed.pointerMove({ x: 370, y: 100 }, { pointerId: 2, pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "b", side: "top" });

  ed.pointerCancel({ x: 370, y: 100 }, { pointerId: 2, pointerType: "mouse" });
  expect(ed.snapPreview).toBeNull();
  expect(ed.displayList(THEME).some(it => it.id?.startsWith("snap:"))).toBe(false);
});

test("pinch interruption, remote delete, and undo clear stale snapPreview cleanly", () => {
  const a = makeElement("rectangle", { id: "a", x: 100, y: 100, width: 100, height: 80 });
  const b = makeElement("rectangle", { id: "b", x: 320, y: 100, width: 100, height: 80 });
  const { ed, advance } = makeEditor([a, b]);

  // 1. Pinch interruption during an intentional arrow drag clears snapPreview.
  ed.setTool("arrow");
  ed.pointerDown({ x: 200, y: 140 }, { pointerId: 1, pointerType: "touch" });
  advance(120);
  ed.pointerMove({ x: 320, y: 140 }, { pointerId: 1, pointerType: "touch" });
  expect(ed.snapPreview?.targetId).toBe("b");

  // Second finger lands -> transitions to pinch and must clear snapPreview immediately.
  ed.pointerDown({ x: 400, y: 200 }, { pointerId: 2, pointerType: "touch" });
  expect(ed.snapPreview).toBeNull();
  expect(ed.g?.kind).toBe("pinch");
  ed.pointerUp({ x: 320, y: 140 }, { pointerId: 1, pointerType: "touch" });
  ed.pointerUp({ x: 400, y: 200 }, { pointerId: 2, pointerType: "touch" });

  // 2. Remote delete via receive() clears stale snapPreview targeting the deleted shape.
  ed.setTool("arrow");
  ed.pointerMove({ x: 200, y: 140 }, { pointerType: "mouse" });
  expect(ed.snapPreview?.targetId).toBe("a");

  ed.receive({ elements: [{ ...ed.doc.get("a"), isDeleted: true, version: ed.doc.get("a").version + 1 }] });
  expect(ed.snapPreview).toBeNull();

  // 3. Undo that removes a newly created shape clears stale snapPreview targeting it.
  const c = makeElement("rectangle", { id: "c", x: 500, y: 100, width: 100, height: 80 });
  ed.transact(tx => tx.add(c));
  ed.setTool("arrow");
  ed.pointerMove({ x: 500, y: 140 }, { pointerType: "mouse" });
  expect(ed.snapPreview?.targetId).toBe("c");

  ed.undo();
  expect(ed.doc.get("c")).toBeNull();
  expect(ed.snapPreview).toBeNull();
});

test("reliable startBinding and endBinding attachment on creation (all combinations), handle drag attach/detach, and frame move", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 100, height: 80 });
  const frame = makeElement("frame", { id: "f1", x: 320, y: 80, width: 160, height: 120, name: "Frame" });
  const img = makeElement("image", { id: "i1", x: 320, y: 260, width: 120, height: 80, fileId: "b".repeat(40) });
  const { ed } = makeEditor([rect, frame, img]);

  // 1. Create arrow from rect right port (200, 140) to frame left port (320, 140).
  ed.setTool("arrow");
  ed.pointerDown({ x: 200, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerMove({ x: 320, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerUp({ x: 320, y: 140 }, { pointerId: 1, pointerType: "mouse" });

  const a1 = ed.doc.live().find(e => e.type === "arrow");
  expect(a1.startBinding).toMatchObject({ elementId: "r1", side: "right" });
  expect(a1.endBinding).toMatchObject({ elementId: "f1", side: "left" });
  expect(ed.doc.get("r1").boundElements.some(b => b.id === a1.id)).toBe(true);
  expect(ed.doc.get("f1").boundElements.some(b => b.id === a1.id)).toBe(true);

  // Moving the bound frame updates the arrow's end endpoint automatically.
  ed.select(["f1"]);
  ed.nudge(40, 20);   // f1 left port moves from (320, 140) to (360, 160) -> end point at (354, 160)
  const a1AfterFrameMove = ed.doc.get(a1.id);
  const a1End = resolvedPoints(ed.doc, a1AfterFrameMove).at(-1);
  expect(a1End[0]).toBeCloseTo(354, 1);
  expect(a1End[1]).toBeCloseTo(160, 1);
  expect(a1AfterFrameMove.x + a1AfterFrameMove.points[a1AfterFrameMove.points.length - 1][0]).toBeCloseTo(354, 1);
  expect(a1AfterFrameMove.y + a1AfterFrameMove.points[a1AfterFrameMove.points.length - 1][1]).toBeCloseTo(160, 1);

  // Move frame back for subsequent assertions.
  ed.nudge(-40, -20);

  // 2. Create line from empty canvas (50, 300) to image left port (320, 300).
  ed.setTool("line");
  ed.pointerDown({ x: 50, y: 300 }, { pointerId: 2, pointerType: "mouse" });
  ed.pointerMove({ x: 320, y: 300 }, { pointerId: 2, pointerType: "mouse" });
  ed.pointerUp({ x: 320, y: 300 }, { pointerId: 2, pointerType: "mouse" });

  const l1 = ed.doc.live().find(e => e.type === "line");
  expect(l1.startBinding).toBeNull();
  expect(l1.endBinding).toMatchObject({ elementId: "i1", side: "left" });
  expect(ed.doc.get("i1").boundElements.some(b => b.id === l1.id)).toBe(true);

  // 3. Create arrow from rect bottom port (150, 180) to empty canvas (150, 260).
  ed.setTool("arrow");
  ed.pointerDown({ x: 150, y: 180 }, { pointerId: 3, pointerType: "mouse" });
  ed.pointerMove({ x: 150, y: 260 }, { pointerId: 3, pointerType: "mouse" });
  ed.pointerUp({ x: 150, y: 260 }, { pointerId: 3, pointerType: "mouse" });

  const a2 = ed.doc.live().filter(e => e.type === "arrow")[1];
  expect(a2.startBinding).toMatchObject({ elementId: "r1", side: "bottom" });
  expect(a2.endBinding).toBeNull();

  // 4. Drag a1's end handle off frame f1 onto image i1's top port (380, 260).
  ed.select([a1.id]);
  const endH = ed.handles().find(h => h.kind === "point" && h.i === a1.points.length - 1);
  ed.pointerDown({ x: endH.x, y: endH.y }, { pointerId: 4, pointerType: "mouse" });
  ed.pointerMove({ x: 380, y: 260 }, { pointerId: 4, pointerType: "mouse" });
  ed.pointerUp({ x: 380, y: 260 }, { pointerId: 4, pointerType: "mouse" });

  const a1Moved = ed.doc.get(a1.id);
  expect(a1Moved.startBinding).toMatchObject({ elementId: "r1", side: "right" });
  expect(a1Moved.endBinding).toMatchObject({ elementId: "i1", side: "top" });
  expect(ed.doc.get("f1").boundElements.some(b => b.id === a1.id)).toBe(false);
  expect(ed.doc.get("i1").boundElements.some(b => b.id === a1.id)).toBe(true);

  // 5. Drag a1's start handle off rect r1 into empty canvas (40, 40) -> clean detachment.
  const startH = ed.handles().find(h => h.kind === "point" && h.i === 0);
  ed.pointerDown({ x: startH.x, y: startH.y }, { pointerId: 5, pointerType: "mouse" });
  ed.pointerMove({ x: 40, y: 40 }, { pointerId: 5, pointerType: "mouse" });
  ed.pointerUp({ x: 40, y: 40 }, { pointerId: 5, pointerType: "mouse" });

  const a1Detached = ed.doc.get(a1.id);
  expect(a1Detached.startBinding).toBeNull();
  expect(a1Detached.endBinding).toMatchObject({ elementId: "i1", side: "top" });
  expect(ed.doc.get("r1").boundElements.some(b => b.id === a1.id)).toBe(false);
  expect(a1Detached.x).toBeCloseTo(40, 1);
  expect(a1Detached.y).toBeCloseTo(40, 1);

  // 6. Touch drag creation attaches to port using forgiving touch radius (22 px outside right port).
  ed.setTool("arrow");
  ed.pointerDown({ x: 222, y: 140 }, { pointerId: 6, pointerType: "touch" });
  ed.pointerMove({ x: 320, y: 140 }, { pointerId: 6, pointerType: "touch" });
  ed.pointerUp({ x: 320, y: 140 }, { pointerId: 6, pointerType: "touch" });
  const touchArrow = ed.doc.live().filter(e => e.type === "arrow")[2];
  expect(touchArrow.startBinding).toMatchObject({ elementId: "r1", side: "right" });
  expect(touchArrow.endBinding).toMatchObject({ elementId: "f1", side: "left" });
});

test("mid-segment bends are preserved when bound shapes move, resize, or nudge", () => {
  const a = makeElement("rectangle", { id: "a", x: 100, y: 100, width: 100, height: 80 });
  const b = makeElement("rectangle", { id: "b", x: 400, y: 100, width: 100, height: 80 });
  const bent = makeElement("arrow", {
    id: "arr1",
    x: 206,
    y: 140,
    points: [[0, 0], [94, -80], [188, 0]],
    startBinding: { elementId: "a", focus: 0, gap: 6, side: "right", fixedPoint: portsOf(a)[1].fixedPoint },
    endBinding: { elementId: "b", focus: 0, gap: 6, side: "left", fixedPoint: portsOf(b)[3].fixedPoint },
  });
  const curved = makeElement("line", {
    id: "lin1",
    x: 206,
    y: 140,
    roundness: { type: 2 },
    points: [[0, 0], [94, 90], [188, 0]],
    startBinding: { elementId: "a", focus: 0, gap: 6 },
    endBinding: { elementId: "b", focus: 0, gap: 6 },
  });
  const { ed } = makeEditor([a, b, bent, curved]);

  const bendWorld = [206 + 94, 140 - 80];     // (300, 60)
  const curveWorld = [206 + 94, 140 + 90];    // (300, 230)

  // Move shape A by (+30, +40) via pointer drag.
  ed.select(["a"]);
  ed.pointerDown({ x: 150, y: 140 }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerMove({ x: 180, y: 180 }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerUp({ x: 180, y: 180 }, { pointerId: 1, pointerType: "mouse" });

  const bentAfterMove = ed.doc.get("arr1");
  expect(bentAfterMove.points.length).toBe(3);
  expect(bentAfterMove.x).toBeCloseTo(236, 1);
  expect(bentAfterMove.y).toBeCloseTo(180, 1);
  expect(bentAfterMove.x + bentAfterMove.points[1][0]).toBeCloseTo(bendWorld[0], 1);
  expect(bentAfterMove.y + bentAfterMove.points[1][1]).toBeCloseTo(bendWorld[1], 1);
  expect(bentAfterMove.x + bentAfterMove.points[2][0]).toBeCloseTo(394, 1);
  expect(bentAfterMove.y + bentAfterMove.points[2][1]).toBeCloseTo(140, 1);

  const curvedAfterMove = ed.doc.get("lin1");
  expect(curvedAfterMove.points.length).toBe(3);
  expect(curvedAfterMove.x + curvedAfterMove.points[1][0]).toBeCloseTo(curveWorld[0], 1);
  expect(curvedAfterMove.y + curvedAfterMove.points[1][1]).toBeCloseTo(curveWorld[1], 1);

  // Resize shape B via east handle (+40 width) and nudge shape A (+10, 0).
  ed.select(["b"]);
  const eHandle = ed.handles().find(h => h.kind === "resize" && h.dir === "e");
  ed.pointerDown({ x: eHandle.x, y: eHandle.y }, { pointerId: 2, pointerType: "mouse" });
  ed.pointerMove({ x: eHandle.x + 40, y: eHandle.y }, { pointerId: 2, pointerType: "mouse" });
  ed.pointerUp({ x: eHandle.x + 40, y: eHandle.y }, { pointerId: 2, pointerType: "mouse" });

  ed.select(["a"]);
  ed.nudge(10, 0);

  const bentAfterAll = ed.doc.get("arr1");
  expect(bentAfterAll.points.length).toBe(3);
  expect(bentAfterAll.x).toBeCloseTo(246, 1);
  expect(bentAfterAll.x + bentAfterAll.points[1][0]).toBeCloseTo(bendWorld[0], 1);
  expect(bentAfterAll.y + bentAfterAll.points[1][1]).toBeCloseTo(bendWorld[1], 1);
});

test("elbow arrows respect port/side, re-route on move/resize/rotate, and detour dynamically around moving obstacles without mutating unrelated arrows", () => {
  const a = makeElement("rectangle", { id: "a", x: 100, y: 200, width: 100, height: 80 });
  const b = makeElement("rectangle", { id: "b", x: 420, y: 200, width: 100, height: 80 });
  const obs = makeElement("rectangle", { id: "obs", x: 260, y: 40, width: 80, height: 80 });
  const { ed } = makeEditor([a, b, obs]);

  // Create an elbow arrow from A's top port (150, 200) to B's top port (470, 200).
  ed.setStyle({ elbowed: true });
  ed.setTool("arrow");
  ed.pointerDown({ x: 150, y: 200 }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerMove({ x: 470, y: 200 }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerUp({ x: 470, y: 200 }, { pointerId: 1, pointerType: "mouse" });

  const elbow = ed.doc.live().find(e => e.type === "arrow");
  expect(elbow.elbowed).toBe(true);
  expect(elbow.startBinding).toMatchObject({ elementId: "a", side: "top" });
  expect(elbow.endBinding).toMatchObject({ elementId: "b", side: "top" });

  // Route must leave A from its top side (x = 150, y = 194) and enter B from its top side (x = 470, y = 194).
  let pts = resolvedPoints(ed.doc, elbow);
  expect(pts[0][0]).toBeCloseTo(150, 1);
  expect(pts[0][1]).toBeCloseTo(194, 1);
  expect(pts[pts.length - 1][0]).toBeCloseTo(470, 1);
  expect(pts[pts.length - 1][1]).toBeCloseTo(194, 1);
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.abs(pts[i][0] - pts[i - 1][0]);
    const dy = Math.abs(pts[i][1] - pts[i - 1][1]);
    expect(Math.min(dx, dy)).toBeLessThan(0.05);
  }

  // Move B down by 100 px -> elbow automatically settles its baked points to B's new top side (470, 294).
  ed.select(["b"]);
  ed.nudge(0, 100);
  const elbowAfterNudge = ed.doc.get(elbow.id);
  pts = resolvedPoints(ed.doc, elbowAfterNudge);
  expect(pts[pts.length - 1][0]).toBeCloseTo(470, 1);
  expect(pts[pts.length - 1][1]).toBeCloseTo(294, 1);
  expect(elbowAfterNudge.x + elbowAfterNudge.points[elbowAfterNudge.points.length - 1][0]).toBeCloseTo(470, 1);
  expect(elbowAfterNudge.y + elbowAfterNudge.points[elbowAfterNudge.points.length - 1][1]).toBeCloseTo(294, 1);

  // Rotate shape A by 90 degrees -> A's pinned "top" side rotates to world "right", and elbow re-routes automatically.
  ed.select(["a"]);
  ed.rotateBy(90);
  const elbowAfterRot = ed.doc.get(elbow.id);
  pts = resolvedPoints(ed.doc, elbowAfterRot);
  expect(pts[0][0]).toBeCloseTo(196, 1);
  expect(pts[0][1]).toBeCloseTo(240, 1);

  // Reset rotation, add an auto-sided elbow arrow between A and B, then move obstacle `obs` directly between them.
  ed.resetRotation();
  const autoElbow = makeElement("arrow", {
    id: "auto1",
    elbowed: true,
    x: 206,
    y: 240,
    points: [[0, 0], [208, 0]],
    startBinding: { elementId: "a", focus: 0, gap: 6 },
    endBinding: { elementId: "b", focus: 0, gap: 6 },
  });
  ed.transact(tx => tx.add(autoElbow));
  const versionBeforeObsMove = ed.doc.get("auto1").version;
  const directRouteBefore = resolvedPoints(ed.doc, ed.doc.get("auto1"));

  // Move `obs` into the path between A and B: resolvedPoints detours live without mutating the unrelated arrow's stored version.
  ed.select(["obs"]);
  ed.nudge(0, 200);   // obs is now at x: 260..340, y: 240..320

  const autoAfterObsMove = ed.doc.get("auto1");
  expect(autoAfterObsMove.version).toBe(versionBeforeObsMove);
  const routePts = resolvedPoints(ed.doc, autoAfterObsMove).map(([x, y]) => ({ x, y }));
  const obsBox = { x: ed.doc.get("obs").x, y: ed.doc.get("obs").y, w: ed.doc.get("obs").width, h: ed.doc.get("obs").height };
  expect(crossings(routePts, [obsBox])).toBe(0);

  // Undo restores obs and returns resolvedPoints to the original direct route.
  ed.undo();
  expect(ed.doc.get("obs").y).toBe(40);
  expect(resolvedPoints(ed.doc, ed.doc.get("auto1"))).toEqual(directRouteBefore);
});
