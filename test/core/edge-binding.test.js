// Wave 4 Track 1 — Arbitrary Perimeter Edge Binding ("Connect to whatever line on the box")
// + Production regressions:
//   Bug A: remote & local selection boxes on bound arrows follow live drawnPoints(doc, el)
//   Bug B: rotated rectangle/diamond corner & edge binding sits dead-on in world coordinates
import { test, expect } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement } from "../../packages/core/model.js";
import {
  bbox, bounds, toWorld, outlineDistance,
  closestPerimeterPoint, perimeterAt, bindingAt, resolveBindingPoint, resolvedPoints, drawnPoints,
} from "../../packages/core/geometry.js";
import { elbowRoute, crossings } from "../../packages/core/elbow.js";
import { collabPort } from "../../web/core/collab/port.js";
import { drawSelections } from "../../web/adapters/dom/collab/draw.js";

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
  return { ed, ops };
}

test("arbitrary perimeter snapping on rectangle, diamond, ellipse, frame, and image", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 200, height: 100 });
  const diamond = makeElement("diamond", { id: "d1", x: 400, y: 100, width: 160, height: 120 });
  const ellipse = makeElement("ellipse", { id: "e1", x: 700, y: 100, width: 160, height: 100 });
  const frame = makeElement("frame", { id: "f1", x: 100, y: 320, width: 240, height: 140, name: "F" });
  const image = makeElement("image", { id: "i1", x: 440, y: 320, width: 160, height: 100, fileId: "a".repeat(40) });
  const doc = new Doc({ elements: [rect, diamond, ellipse, frame, image] });

  // Rectangle: non-midpoint points on all 4 edges (well outside cardinal port & corner magnet).
  const rectProbes = [
    { p: { x: 150, y: 97 }, at: [150, 100], fp: [0.25, 0] },     // top edge, 25%
    { p: { x: 304, y: 125 }, at: [300, 125], fp: [1, 0.25] },    // right edge, 25%
    { p: { x: 250, y: 203 }, at: [250, 200], fp: [0.75, 1] },    // bottom edge, 75%
    { p: { x: 96, y: 175 }, at: [100, 175], fp: [0, 0.75] },     // left edge, 75%
  ];
  for (const { p, at, fp } of rectProbes) {
    const hit = bindingAt(doc, p, { tol: 12, portTol: 7, cornerTol: 5 });
    expect(hit).not.toBeNull();
    expect(hit.el.id).toBe("r1");
    expect(hit.snapped).toBe("edge");
    expect(hit.side).toBeNull();
    expect(hit.at[0]).toBeCloseTo(at[0], 4);
    expect(hit.at[1]).toBeCloseTo(at[1], 4);
    expect(hit.fixedPoint[0]).toBeCloseTo(fp[0], 4);
    expect(hit.fixedPoint[1]).toBeCloseTo(fp[1], 4);
    expect(hit.binding.fixedPoint).toEqual(hit.fixedPoint);
  }

  // Diamond: midpoint of top-right diagonal edge -> local (480 + 40, 100 + 30) = (520, 130), fixedPoint = [0.75, 0.25].
  const dHit = bindingAt(doc, { x: 522, y: 128 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(dHit.el.id).toBe("d1");
  expect(dHit.snapped).toBe("edge");
  expect(dHit.at[0]).toBeCloseTo(520, 0);
  expect(dHit.at[1]).toBeCloseTo(130, 0);
  expect(dHit.fixedPoint[0]).toBeCloseTo(0.75, 1);
  expect(dHit.fixedPoint[1]).toBeCloseTo(0.25, 1);
  expect(Math.abs(outlineDistance(diamond, { x: dHit.at[0], y: dHit.at[1] }))).toBeLessThan(1e-4);

  // Ellipse: 45-degree arc point -> (780 + 80*cos(45°), 150 + 50*sin(45°))
  const eTarget = { x: 780 + 80 * Math.SQRT1_2, y: 150 + 50 * Math.SQRT1_2 };
  const eHit = bindingAt(doc, { x: eTarget.x + 3, y: eTarget.y + 3 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(eHit.el.id).toBe("e1");
  expect(eHit.snapped).toBe("edge");
  expect(Math.abs(outlineDistance(ellipse, { x: eHit.at[0], y: eHit.at[1] }))).toBeLessThan(1e-3);
  expect(eHit.fixedPoint[0]).toBeGreaterThan(0.5);
  expect(eHit.fixedPoint[0]).toBeLessThan(1);
  expect(eHit.fixedPoint[1]).toBeGreaterThan(0.5);
  expect(eHit.fixedPoint[1]).toBeLessThan(1);

  // Frame: arbitrary bottom edge point binds; hollow interior does NOT bind.
  const fHit = bindingAt(doc, { x: 160, y: 462 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(fHit.el.id).toBe("f1");
  expect(fHit.snapped).toBe("edge");
  expect(fHit.at).toEqual([160, 460]);
  expect(fHit.fixedPoint[0]).toBeCloseTo(60 / 240, 4);
  expect(fHit.fixedPoint[1]).toBeCloseTo(1, 4);
  expect(bindingAt(doc, { x: 220, y: 390 }, { tol: 12, portTol: 7, cornerTol: 5 })).toBeNull();

  // Image: arbitrary left edge point binds with normalized fixedPoint.
  const iHit = bindingAt(doc, { x: 438, y: 350 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(iHit.el.id).toBe("i1");
  expect(iHit.snapped).toBe("edge");
  expect(iHit.at).toEqual([440, 350]);
  expect(iHit.fixedPoint[0]).toBeCloseTo(0, 4);
  expect(iHit.fixedPoint[1]).toBeCloseTo(0.3, 4);
});

test("gentle magnetic pull to cardinal ports and corners vs arbitrary edge outside tight threshold", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 200, height: 100 });
  const doc = new Doc({ elements: [rect] });

  // Within portTol (7 px) of top midpoint (200, 100): pulls magnetically to exact top cardinal port.
  const nearMid = bindingAt(doc, { x: 205, y: 100 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(nearMid.snapped).toBe("port");
  expect(nearMid.side).toBe("top");
  expect(nearMid.at).toEqual([200, 100]);
  expect(nearMid.fixedPoint).toEqual([0.5, 0]);

  // Outside portTol (10 px away from top midpoint): stays at exact arbitrary edge point (210, 100).
  const awayFromMid = bindingAt(doc, { x: 210, y: 100 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(awayFromMid.snapped).toBe("edge");
  expect(awayFromMid.side).toBeNull();
  expect(awayFromMid.at).toEqual([210, 100]);
  expect(awayFromMid.fixedPoint[0]).toBeCloseTo(0.55, 4);
  expect(awayFromMid.fixedPoint[1]).toBeCloseTo(0, 4);

  // Within cornerTol (5 px) of top-right corner (300, 100): pulls magnetically to exact corner [1, 0].
  const nearCorner = bindingAt(doc, { x: 297, y: 100 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(nearCorner.snapped).toBe("corner");
  expect(nearCorner.side).toBeNull();
  expect(nearCorner.at).toEqual([300, 100]);
  expect(nearCorner.fixedPoint).toEqual([1, 0]);
});

test("Bug B regression: 45°-rotated rectangle and diamond exact corner & edge binding", () => {
  const angle = Math.PI / 4;
  const rect = makeElement("rectangle", { id: "r45", x: 100, y: 100, width: 120, height: 80, angle });
  const diamond = makeElement("diamond", { id: "d45", x: 360, y: 100, width: 120, height: 80, angle });
  const doc = new Doc({ elements: [rect, diamond] });

  // 1. 45°-rotated rectangle: all 4 corners snap dead-on with zero world offset.
  const rb = bbox({ ...rect, angle: 0 });
  const rectCorners = [
    { local: { x: rb.x, y: rb.y }, fp: [0, 0] },
    { local: { x: rb.x + rb.w, y: rb.y }, fp: [1, 0] },
    { local: { x: rb.x + rb.w, y: rb.y + rb.h }, fp: [1, 1] },
    { local: { x: rb.x, y: rb.y + rb.h }, fp: [0, 1] },
  ];
  for (const { local, fp } of rectCorners) {
    const worldCorner = toWorld(rect, local);
    // Probe 2 px off the rotated corner -> must pull cleanly onto exact worldCorner.
    const hit = bindingAt(doc, { x: worldCorner.x + 1.5, y: worldCorner.y - 1.5 }, { tol: 12, portTol: 7, cornerTol: 5 });
    expect(hit.el.id).toBe("r45");
    expect(hit.snapped).toBe("corner");
    expect(hit.at[0]).toBeCloseTo(worldCorner.x, 5);
    expect(hit.at[1]).toBeCloseTo(worldCorner.y, 5);
    expect(hit.fixedPoint).toEqual(fp);

    // Resolving with gap: 0 must land DEAD-ON the rotated corner (no offset!).
    const ptZero = resolveBindingPoint(rect, { ...hit.binding, gap: 0 });
    expect(ptZero[0]).toBeCloseTo(worldCorner.x, 5);
    expect(ptZero[1]).toBeCloseTo(worldCorner.y, 5);

    // Resolving with gap: 6 sits cleanly 6 px outward from the rotated corner.
    const ptGap = resolveBindingPoint(rect, { ...hit.binding, gap: 6 });
    expect(Math.hypot(ptGap[0] - worldCorner.x, ptGap[1] - worldCorner.y)).toBeCloseTo(6, 4);
  }

  // 2. 45°-rotated rectangle: arbitrary edge point (25% along top edge).
  const rectEdgeWorld = toWorld(rect, { x: rb.x + 0.25 * rb.w, y: rb.y });
  const rectEdgeHit = bindingAt(doc, rectEdgeWorld, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(rectEdgeHit.el.id).toBe("r45");
  expect(rectEdgeHit.snapped).toBe("edge");
  expect(rectEdgeHit.at[0]).toBeCloseTo(rectEdgeWorld.x, 5);
  expect(rectEdgeHit.at[1]).toBeCloseTo(rectEdgeWorld.y, 5);
  expect(rectEdgeHit.fixedPoint[0]).toBeCloseTo(0.25, 5);
  expect(rectEdgeHit.fixedPoint[1]).toBeCloseTo(0, 5);
  const rectEdgeZero = resolveBindingPoint(rect, { ...rectEdgeHit.binding, gap: 0 });
  expect(rectEdgeZero[0]).toBeCloseTo(rectEdgeWorld.x, 5);
  expect(rectEdgeZero[1]).toBeCloseTo(rectEdgeWorld.y, 5);

  // 3. 45°-rotated diamond: vertices (cardinal ports) AND diagonal edge midpoint sit dead-on.
  const db = bbox({ ...diamond, angle: 0 });
  const topVertexWorld = toWorld(diamond, { x: db.x + db.w / 2, y: db.y });
  const dVertHit = bindingAt(doc, { x: topVertexWorld.x + 1, y: topVertexWorld.y - 1 }, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(dVertHit.el.id).toBe("d45");
  expect(dVertHit.snapped).toBe("port");
  expect(dVertHit.side).toBe("top");
  expect(dVertHit.at[0]).toBeCloseTo(topVertexWorld.x, 5);
  expect(dVertHit.at[1]).toBeCloseTo(topVertexWorld.y, 5);
  const dVertZero = resolveBindingPoint(diamond, { ...dVertHit.binding, gap: 0 });
  expect(dVertZero[0]).toBeCloseTo(topVertexWorld.x, 5);
  expect(dVertZero[1]).toBeCloseTo(topVertexWorld.y, 5);

  const dEdgeWorld = toWorld(diamond, { x: db.x + 0.75 * db.w, y: db.y + 0.25 * db.h });
  const dEdgeHit = bindingAt(doc, dEdgeWorld, { tol: 12, portTol: 7, cornerTol: 5 });
  expect(dEdgeHit.el.id).toBe("d45");
  expect(dEdgeHit.snapped).toBe("edge");
  expect(dEdgeHit.at[0]).toBeCloseTo(dEdgeWorld.x, 5);
  expect(dEdgeHit.at[1]).toBeCloseTo(dEdgeWorld.y, 5);
  expect(dEdgeHit.fixedPoint[0]).toBeCloseTo(0.75, 5);
  expect(dEdgeHit.fixedPoint[1]).toBeCloseTo(0.25, 5);
  const dEdgeZero = resolveBindingPoint(diamond, { ...dEdgeHit.binding, gap: 0 });
  expect(dEdgeZero[0]).toBeCloseTo(dEdgeWorld.x, 5);
  expect(dEdgeZero[1]).toBeCloseTo(dEdgeWorld.y, 5);
});

test("bound endpoint tracks arbitrary fixedPoint on move, resize, and rotation, and preserves backward compatibility", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 200, height: 100 });
  const arr = makeElement("arrow", {
    id: "a1",
    x: 150,
    y: 94,
    points: [[0, 0], [0, -80]],
    startBinding: { elementId: "r1", focus: 0, gap: 6, fixedPoint: [0.25, 0] },
    endBinding: null,
  });
  const { ed } = makeEditor([rect, arr]);

  // Initial: 25% along top edge -> (150, 100) + gap [0, -6] = (150, 94).
  expect(resolvedPoints(ed.doc, ed.doc.get("a1"))[0]).toEqual([150, 94]);

  // Move by (+40, +20): (190, 114).
  ed.select(["r1"]);
  ed.nudge(40, 20);
  expect(resolvedPoints(ed.doc, ed.doc.get("a1"))[0][0]).toBeCloseTo(190, 3);
  expect(resolvedPoints(ed.doc, ed.doc.get("a1"))[0][1]).toBeCloseTo(114, 3);

  // Resize width from 200 -> 300 (east handle +100): x stays 140, 25% of 300 = 75 -> x = 215, y = 114.
  const eHandle = ed.handles().find(h => h.kind === "resize" && h.dir === "e");
  ed.pointerDown({ x: eHandle.x, y: eHandle.y }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerMove({ x: eHandle.x + 100, y: eHandle.y }, { pointerId: 1, pointerType: "mouse" });
  ed.pointerUp({ x: eHandle.x + 100, y: eHandle.y }, { pointerId: 1, pointerType: "mouse" });
  expect(resolvedPoints(ed.doc, ed.doc.get("a1"))[0][0]).toBeCloseTo(215, 2);
  expect(resolvedPoints(ed.doc, ed.doc.get("a1"))[0][1]).toBeCloseTo(114, 2);

  // Rotate 90° clockwise about center (290, 170):
  // Local (215, 120) is (-75, -50) from center -> rotated (+50, -75) -> (340, 95); normal [0, -1] -> [1, 0] -> (346, 95).
  ed.rotateBy(90);
  const afterRot = resolvedPoints(ed.doc, ed.doc.get("a1"))[0];
  expect(afterRot[0]).toBeCloseTo(346, 2);
  expect(afterRot[1]).toBeCloseTo(95, 2);
  expect(drawnPoints(ed.doc, ed.doc.get("a1"))[0][0]).toBeCloseTo(346, 2);
  expect(drawnPoints(ed.doc, ed.doc.get("a1"))[0][1]).toBeCloseTo(95, 2);

  // Backward compatibility: legacy Excalidraw fixedPoint outside [0, 1] and interior aim point [0.5, 0.5].
  const plain = makeElement("rectangle", { id: "p1", x: 0, y: 0, width: 100, height: 80 });
  const legacyRight = resolveBindingPoint(plain, { elementId: "p1", gap: 6, fixedPoint: [1.06, 0.5001] });
  expect(legacyRight[0]).toBeCloseTo(106, 2);
  expect(legacyRight[1]).toBeCloseTo(40, 1);
  expect(resolveBindingPoint(plain, { elementId: "p1", gap: 6, fixedPoint: [0.5, 0.5] })).toBeNull();
  expect(resolveBindingPoint(plain, { elementId: "p1", gap: 6, side: "bottom" })).toEqual([50, 86]);
});

test("elbowRoute and resolvedPoints honor arbitrary fixedPoint on all 4 sides cleanly", () => {
  const boxA = { x: 100, y: 200, w: 120, h: 80 };
  const boxB = { x: 420, y: 200, w: 120, h: 80 };

  // Test all 4 sides with non-midpoint fixedPoints via direct elbowRoute:
  const cases = [
    { fpA: [0.25, 0], fpB: [0.75, 0], expectA: [130, 194], expectB: [510, 194], sideA: "top", sideB: "top" },
    { fpA: [1, 0.25], fpB: [0, 0.75], expectA: [226, 220], expectB: [414, 260], sideA: "right", sideB: "left" },
    { fpA: [0.8, 1], fpB: [0.2, 1], expectA: [196, 286], expectB: [444, 286], sideA: "bottom", sideB: "bottom" },
    { fpA: [0, 0.2], fpB: [1, 0.8], expectA: [94, 216], expectB: [546, 264], sideA: "left", sideB: "right" },
  ];
  for (const c of cases) {
    const r = elbowRoute({ box: boxA, fixedPoint: c.fpA }, { box: boxB, fixedPoint: c.fpB }, 6);
    expect(r.sides).toEqual([c.sideA, c.sideB]);
    expect(r.points[0].x).toBeCloseTo(c.expectA[0], 3);
    expect(r.points[0].y).toBeCloseTo(c.expectA[1], 3);
    expect(r.points[r.points.length - 1].x).toBeCloseTo(c.expectB[0], 3);
    expect(r.points[r.points.length - 1].y).toBeCloseTo(c.expectB[1], 3);
    // Every segment must be strictly orthogonal, and no segment may cut through boxA or boxB.
    for (let i = 1; i < r.points.length; i++) {
      const dx = Math.abs(r.points[i].x - r.points[i - 1].x);
      const dy = Math.abs(r.points[i].y - r.points[i - 1].y);
      expect(Math.min(dx, dy)).toBeLessThan(0.05);
    }
    expect(crossings(r.points, [boxA, boxB])).toBe(0);
  }

  // Via Doc + resolvedPoints on an elbow arrow with arbitrary fixedPoint:
  const a = makeElement("rectangle", { id: "a", x: 100, y: 200, width: 120, height: 80 });
  const b = makeElement("rectangle", { id: "b", x: 420, y: 200, width: 120, height: 80 });
  const elbow = makeElement("arrow", {
    id: "el1",
    elbowed: true,
    x: 226,
    y: 220,
    points: [[0, 0], [188, 40]],
    startBinding: { elementId: "a", focus: 0, gap: 6, fixedPoint: [1, 0.25] },
    endBinding: { elementId: "b", focus: 0, gap: 6, fixedPoint: [0, 0.75] },
  });
  const doc = new Doc({ elements: [a, b, elbow] });
  const pts = resolvedPoints(doc, elbow);
  expect(pts[0][0]).toBeCloseTo(226, 2);
  expect(pts[0][1]).toBeCloseTo(220, 2);
  expect(pts[pts.length - 1][0]).toBeCloseTo(414, 2);
  expect(pts[pts.length - 1][1]).toBeCloseTo(260, 2);
  // First segment must exit straight right from (226, 220), never cutting back across shape `a`.
  expect(pts[1][0]).toBeGreaterThan(226);
  expect(pts[1][1]).toBeCloseTo(220, 2);
});

test("editor live snap indicator tracks arbitrary edge contact point during drag and commits fixedPoint", () => {
  const a = makeElement("rectangle", { id: "a", x: 100, y: 100, width: 200, height: 100 });
  const b = makeElement("rectangle", { id: "b", x: 420, y: 100, width: 200, height: 100 });
  const { ed } = makeEditor([a, b]);

  ed.setTool("arrow");
  // Start dragging from an arbitrary point on A's right edge (300, 125 -> fixedPoint [1, 0.25]).
  ed.pointerDown({ x: 300, y: 125 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "a", side: null, snapped: "edge", at: [300, 125] });

  // Drag onto B's left edge at (420, 175 -> fixedPoint [0, 0.75]).
  ed.pointerMove({ x: 420, y: 175 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toMatchObject({ targetId: "b", side: null, snapped: "edge", at: [420, 175] });
  const dl1 = ed.displayList(THEME);
  expect(dl1.some(it => it.id === "snap:outline")).toBe(true);
  const dot1 = dl1.find(it => it.id === "snap:active" && it.fill);
  expect(dot1).toBeTruthy();
  const cx1 = dot1.cmds.reduce((s, c) => s + c[1], 0) / dot1.cmds.length;
  const cy1 = dot1.cmds.reduce((s, c) => s + c[2], 0) / dot1.cmds.length;
  expect(cx1).toBeCloseTo(420, 0);
  expect(cy1).toBeCloseTo(175, 0);

  // Slide along B's left edge to (420, 182): snap indicator moves smoothly and bumps version.
  const vBefore = ed.version;
  ed.pointerMove({ x: 420, y: 182 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.version).toBeGreaterThan(vBefore);
  expect(ed.snapPreview.at).toEqual([420, 182]);

  // Release -> arrow committed with exact normalized fixedPoints on both ends, snapPreview cleared.
  ed.pointerUp({ x: 420, y: 182 }, { pointerId: 1, pointerType: "mouse" });
  expect(ed.snapPreview).toBeNull();
  const arr = ed.doc.live().find(e => e.type === "arrow");
  expect(arr.startBinding.fixedPoint[0]).toBeCloseTo(1, 4);
  expect(arr.startBinding.fixedPoint[1]).toBeCloseTo(0.25, 4);
  expect(arr.endBinding.fixedPoint[0]).toBeCloseTo(0, 4);
  expect(arr.endBinding.fixedPoint[1]).toBeCloseTo(0.82, 4);
});

test("Bug A regression: remote peer and local selection boxes follow live drawnPoints when a bound arrow's target moves", () => {
  const boxA = makeElement("rectangle", { id: "a", x: 100, y: 100, width: 100, height: 80 });
  const boxB = makeElement("rectangle", { id: "b", x: 300, y: 100, width: 100, height: 80 });
  const arrow = makeElement("arrow", {
    id: "arr1",
    x: 206,
    y: 140,
    width: 88,
    height: 0,
    points: [[0, 0], [88, 0]],
    startBinding: { elementId: "a", focus: 0, gap: 6, fixedPoint: [1, 0.5], side: "right" },
    endBinding: { elementId: "b", focus: 0, gap: 6, fixedPoint: [0, 0.5], side: "left" },
  });

  // Simulate boxB having moved far away to (500, 360) while arrow's stored `points` are still stale (e.g. during drag or remote op).
  const movedB = { ...boxB, x: 500, y: 360 };
  const doc = new Doc({ elements: [boxA, movedB, arrow] });

  // Live rendered arrow runs from (206, 140) to (494, 400).
  const pts = drawnPoints(doc, arrow);
  expect(pts[0]).toEqual([206, 140]);
  expect(pts[1]).toEqual([494, 400]);

  // 1. Local Editor selection box uses drawnPoints(doc, el), NOT stale arrow.points (width 88, height 0).
  const { ed } = makeEditor([boxA, movedB, arrow]);
  ed.select(["arr1"]);
  const localBox = ed.selBox();
  expect(localBox.x).toBeCloseTo(206, 2);
  expect(localBox.y).toBeCloseTo(140, 2);
  expect(localBox.w).toBeCloseTo(288, 2);
  expect(localBox.h).toBeCloseTo(260, 2);

  // 2. Remote collab port + drawSelections ("<name> selected") uses live drawnPoints bounds, NOT stale arrow.points!
  const elements = new Map([["a", boxA], ["b", movedB], ["arr1", arrow]]);
  const fakeSession = {
    connection: {
      client: "me",
      user: "u-me",
      status: "live",
      role: "editor",
      lastRole: "editor",
      recordsRev: 0,
      recordsState: () => ({ threads: [] }),
      pendingRecords: () => [],
      previewEntries: () => [],
      elements: () => [...elements.values()],
      element: (_stream, id) => elements.get(id) ?? null,
      noteAuthor: () => null,
      sendPresence: () => {},
      record: () => {},
    },
    roomUser: () => "u-me",
    onStatus: () => () => {},
    onRoom: () => () => {},
  };
  const port = collabPort(fakeSession, { name: "Me", frame: fn => fn() });
  const peerBox = port.element("board", "arr1");
  expect(peerBox.x).toBeCloseTo(206, 2);
  expect(peerBox.y).toBeCloseTo(140, 2);
  expect(peerBox.width).toBeCloseTo(288, 2);
  expect(peerBox.height).toBeCloseTo(260, 2);

  // Verify drawSelections strokes the dashed box around the live resolved arrow bounds.
  const rects = [];
  const texts = [];
  const ctx = {
    save() {}, restore() {}, setLineDash() {}, beginPath() {}, rect() {}, fill() {},
    measureText: s => ({ width: s.length * 6 }),
    strokeRect: (x, y, w, h) => rects.push({ x, y, w, h }),
    fillText: (text, x, y) => texts.push({ text, x, y }),
  };
  const view = { scale: 1, toScreen: p => ({ x: p.x, y: p.y }) };
  drawSelections(ctx, [{ user: "u-peer", client: "c2", name: "Ada", color: "#1971c2", stream: "board", ids: ["arr1"] }], view, port.element);
  expect(rects.length).toBe(1);
  // drawSelections pads by 4 px on each side.
  expect(rects[0].x).toBeCloseTo(206 - 4, 2);
  expect(rects[0].y).toBeCloseTo(140 - 4, 2);
  expect(rects[0].w).toBeCloseTo(288 + 8, 2);
  expect(rects[0].h).toBeCloseTo(260 + 8, 2);
  expect(texts[0].text).toBe("Ada selected");
  port.destroy();
});
