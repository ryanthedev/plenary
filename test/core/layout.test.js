import { describe, test, expect } from "bun:test";
import { makeElement } from "../../packages/core/model.js";
import { bounds } from "../../packages/core/geometry.js";
import { Editor } from "../../packages/core/editor.js";
import {
  alignElements,
  distributeElements,
  tidyElements,
  computeSmartGuides,
} from "../../packages/core/layout.js";

function rect(id, x, y, width = 100, height = 60, extra = {}) {
  return makeElement("rectangle", { id, x, y, width, height, ...extra });
}

function applyShifts(elements, shifts) {
  const byId = new Map(shifts.map(s => [s.id, s]));
  return elements.map(el => {
    const s = byId.get(el.id);
    return s ? { ...el, x: el.x + s.dx, y: el.y + s.dy } : el;
  });
}

describe("alignElements", () => {
  test("supports left, center-x, right, top, center-y, bottom and legacy aliases", () => {
    const base = [
      rect("a", 10, 20, 80, 40),   // x: [10..90] cx=50, y: [20..60] cy=40
      rect("b", 120, 100, 40, 80), // x: [120..160] cx=140, y: [100..180] cy=140
      rect("c", 200, 50, 100, 60), // x: [200..300] cx=250, y: [50..110] cy=80
    ];
    // Union box: x=[10..300] (cx=155), y=[20..180] (cy=100)

    const left = applyShifts(base, alignElements(base, "left"));
    expect(left.map(e => e.x)).toEqual([10, 10, 10]);

    const cx = applyShifts(base, alignElements(base, "center-x"));
    expect(cx.map(e => e.x + e.width / 2)).toEqual([155, 155, 155]);

    const hcenter = applyShifts(base, alignElements(base, "hcenter"));
    expect(hcenter.map(e => e.x + e.width / 2)).toEqual([155, 155, 155]);

    const right = applyShifts(base, alignElements(base, "right"));
    expect(right.map(e => e.x + e.width)).toEqual([300, 300, 300]);

    const top = applyShifts(base, alignElements(base, "top"));
    expect(top.map(e => e.y)).toEqual([20, 20, 20]);

    const cy = applyShifts(base, alignElements(base, "center-y"));
    expect(cy.map(e => e.y + e.height / 2)).toEqual([100, 100, 100]);

    const vcenter = applyShifts(base, alignElements(base, "vcenter"));
    expect(vcenter.map(e => e.y + e.height / 2)).toEqual([100, 100, 100]);

    const bottom = applyShifts(base, alignElements(base, "bottom"));
    expect(bottom.map(e => e.y + e.height)).toEqual([180, 180, 180]);

    expect(alignElements(base, /** @type {any} */ ("invalid"))).toEqual([]);
  });

  test("respects groups as atomic units and skips single-group selections", () => {
    const g1a = rect("g1a", 100, 0, 50, 40, { groupIds: ["g1"] });
    const g1b = rect("g1b", 180, 20, 50, 40, { groupIds: ["g1"] }); // group x: [100..230]
    const solo = rect("s", 10, 100, 40, 40);                        // solo x: [10..50]

    const shifts = alignElements([g1a, g1b, solo], "left");
    const moved = applyShifts([g1a, g1b, solo], shifts);
    // Group shifts left by -90 together, keeping relative offset (80px) intact.
    expect(moved[0].x).toBe(10);
    expect(moved[1].x).toBe(90);
    expect(moved[2].x).toBe(10);

    // Selecting only one group is a no-op.
    expect(alignElements([g1a, g1b], "left")).toEqual([]);
  });

  test("uses rotated bounding boxes accurately", () => {
    // 100x40 centered at (150, 120), rotated 90 deg -> visual bounds x=[130..170], y=[70..170]
    const rot = rect("r", 100, 100, 100, 40, { angle: Math.PI / 2 });
    const plain = rect("p", 50, 200, 60, 40); // x=[50..110], y=[200..240]

    const shifts = alignElements([rot, plain], "left");
    const moved = applyShifts([rot, plain], shifts);
    const rb = bounds(moved[0]);
    const pb = bounds(moved[1]);
    expect(rb.x).toBeCloseTo(50, 4);
    expect(pb.x).toBeCloseTo(50, 4);
  });

  test("skips locked elements, labels, and groups with a locked member", () => {
    const a = rect("a", 100, 0, 50, 40);
    const b = rect("b", 200, 0, 50, 40);
    const locked = rect("l", 0, 0, 50, 40, { locked: true });
    const label = makeElement("text", { id: "lbl", x: 0, y: 0, width: 30, height: 20, containerId: "a", text: "hi" });

    const shifts = alignElements([locked, a, b, label], "left");
    expect(shifts.map(s => s.id)).toEqual(["b"]);
    expect(shifts[0].dx).toBe(-100);

    // Group with one locked member is skipped entirely.
    const ga = rect("ga", 300, 0, 50, 40, { groupIds: ["g1"], locked: true });
    const gb = rect("gb", 360, 0, 50, 40, { groupIds: ["g1"] });
    const shifts2 = alignElements([ga, gb, a, b], "right");
    expect(shifts2.map(s => s.id)).toEqual(["a"]);
    expect(shifts2[0].dx).toBe(100);
  });
});

describe("distributeElements", () => {
  test("distributes horizontally and vertically with equal gaps while preserving outer bounds", () => {
    const els = [
      rect("a", 0, 0, 40, 20),
      rect("b", 50, 30, 60, 40),
      rect("c", 300, 200, 40, 20),
    ];
    // Horizontal: outer bounds [0..340], widths = 40+60+40=140, remaining=200 -> gap=100
    // Positions: a=0..40, b=140..200, c=300..340
    const hMoved = applyShifts(els, distributeElements(els, "horizontal"));
    expect(hMoved[0].x).toBeCloseTo(0, 5);
    expect(hMoved[1].x).toBeCloseTo(140, 5);
    expect(hMoved[2].x).toBeCloseTo(300, 5);
    expect(hMoved[1].x - (hMoved[0].x + hMoved[0].width)).toBeCloseTo(100, 5);
    expect(hMoved[2].x - (hMoved[1].x + hMoved[1].width)).toBeCloseTo(100, 5);

    // Vertical: outer bounds [0..220], heights = 20+40+20=80, remaining=140 -> gap=70
    // Positions: a=0..20, b=90..130, c=200..220
    const vMoved = applyShifts(els, distributeElements(els, "vertical"));
    expect(vMoved[0].y).toBeCloseTo(0, 5);
    expect(vMoved[1].y).toBeCloseTo(90, 5);
    expect(vMoved[2].y).toBeCloseTo(200, 5);
  });

  test("requires at least 3 unlocked non-label units", () => {
    const a = rect("a", 0, 0, 40, 40);
    const b = rect("b", 100, 0, 40, 40);
    const locked = rect("l", 200, 0, 40, 40, { locked: true });
    const label = makeElement("text", { id: "t", x: 10, y: 10, containerId: "a", text: "A" });

    expect(distributeElements([a, b], "horizontal")).toEqual([]);
    expect(distributeElements([a, b, locked], "horizontal")).toEqual([]);
    expect(distributeElements([a, b, label], "horizontal")).toEqual([]);
  });

  test("respects groups during distribution", () => {
    const a = rect("a", 0, 0, 40, 40);
    const g1 = rect("g1", 50, 0, 20, 40, { groupIds: ["g"] });
    const g2 = rect("g2", 80, 0, 30, 40, { groupIds: ["g"] }); // group width = 60 (50..110)
    const c = rect("c", 260, 0, 40, 40); // outer [0..300], total width = 40+60+40=140, gap=80

    const moved = applyShifts([a, g1, g2, c], distributeElements([a, g1, g2, c], "horizontal"));
    expect(moved[0].x).toBeCloseTo(0, 5);
    expect(moved[1].x).toBeCloseTo(120, 5); // 40 + 80
    expect(moved[2].x).toBeCloseTo(150, 5); // preserved 30px internal offset
    expect(moved[3].x).toBeCloseTo(260, 5);
  });
});

describe("tidyElements", () => {
  test("tidies a mostly horizontal selection into a neat row", () => {
    const els = [
      rect("a", 10, 25, 80, 40),
      rect("b", 140, 5, 100, 60),
      rect("c", 310, 15, 60, 40),
    ];
    const moved = applyShifts(els, tidyElements(els, { gap: 20 }));
    expect(moved[0].x).toBeCloseTo(10, 5);
    expect(moved[1].x).toBeCloseTo(110, 5); // 10 + 80 + 20
    expect(moved[2].x).toBeCloseTo(230, 5); // 110 + 100 + 20
    // Vertically centered to the same centerY (union.y + maxH / 2 = 5 + 30 = 35)
    expect(moved[0].y + moved[0].height / 2).toBeCloseTo(35, 5);
    expect(moved[1].y + moved[1].height / 2).toBeCloseTo(35, 5);
    expect(moved[2].y + moved[2].height / 2).toBeCloseTo(35, 5);
  });

  test("tidies a mostly vertical selection into a neat column", () => {
    const els = [
      rect("a", 30, 10, 80, 40),
      rect("b", 5, 95, 120, 60),
      rect("c", 20, 210, 60, 50),
    ];
    const moved = applyShifts(els, tidyElements(els, { gap: 16 }));
    expect(moved[0].y).toBeCloseTo(10, 5);
    expect(moved[1].y).toBeCloseTo(66, 5);  // 10 + 40 + 16
    expect(moved[2].y).toBeCloseTo(142, 5); // 66 + 60 + 16
    // Horizontally centered to the same centerX (union.x + maxW / 2 = 5 + 60 = 65)
    expect(moved[0].x + moved[0].width / 2).toBeCloseTo(65, 5);
    expect(moved[1].x + moved[1].width / 2).toBeCloseTo(65, 5);
    expect(moved[2].x + moved[2].width / 2).toBeCloseTo(65, 5);
  });

  test("tidies a 2D selection into a clean aligned grid with consistent gap", () => {
    const els = [
      rect("r0c0", 10, 15, 100, 60),
      rect("r0c1", 150, 5, 100, 60),
      rect("r1c0", 25, 130, 100, 60),
      rect("r1c1", 175, 115, 100, 60),
    ];
    const moved = applyShifts(els, tidyElements(els, { gap: 24 }));
    // union.x = 10, union.y = 5
    expect(moved[0]).toMatchObject({ x: 10, y: 5 });
    expect(moved[1]).toMatchObject({ x: 134, y: 5 });  // 10 + 100 + 24
    expect(moved[2]).toMatchObject({ x: 10, y: 89 });  // 5 + 60 + 24
    expect(moved[3]).toMatchObject({ x: 134, y: 89 });
  });

  test("tidies 2 elements into row or column based on dominant axis", () => {
    const row2 = [rect("a", 0, 10, 80, 40), rect("b", 120, 20, 80, 40)];
    const rMoved = applyShifts(row2, tidyElements(row2, { gap: 24 }));
    expect(rMoved[1].x).toBeCloseTo(104, 5);
    expect(rMoved[0].y).toBeCloseTo(rMoved[1].y, 5);

    const col2 = [rect("a", 10, 0, 80, 40), rect("b", 25, 100, 80, 40)];
    const cMoved = applyShifts(col2, tidyElements(col2, { gap: 24 }));
    expect(cMoved[1].y).toBeCloseTo(64, 5);
    expect(cMoved[0].x).toBeCloseTo(cMoved[1].x, 5);
  });
});

describe("computeSmartGuides", () => {
  test("snaps edges and centers and returns { axis, at, from, to } guides", () => {
    const staticBoxes = [
      { x: 100, y: 50, w: 100, h: 60 }, // x: 100, 150, 200; y: 50, 80, 110
    ];
    // Moving box left edge at 103 (within tol=6 of 100) and top at 200 (no Y snap)
    const resX = computeSmartGuides({ x: 103, y: 200, w: 80, h: 40 }, staticBoxes, 6);
    expect(resX.dx).toBeCloseTo(-3, 5);
    expect(resX.dy).toBe(0);
    expect(resX.guides).toEqual([{ axis: "x", at: 100, from: 50, to: 240 }]);

    // Center-Y alignment: static centerY = 80; moving centerY = 84 -> dy = -4
    const resY = computeSmartGuides({ x: 300, y: 64, w: 80, h: 40 }, staticBoxes, 6);
    expect(resY.dx).toBe(0);
    expect(resY.dy).toBeCloseTo(-4, 5);
    expect(resY.guides).toEqual([{ axis: "y", at: 80, from: 100, to: 380 }]);

    // Out of tolerance -> no snap, no guides
    const none = computeSmartGuides({ x: 250, y: 300, w: 40, h: 40 }, staticBoxes, 6);
    expect(none).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  test("merges collinear guides across multiple aligned static boxes and stays fast on large scenes", () => {
    const staticBoxes = [
      { x: 100, y: 0, w: 80, h: 40 },
      { x: 100, y: 300, w: 80, h: 40 },
    ];
    const res = computeSmartGuides({ x: 102, y: 150, w: 80, h: 40 }, staticBoxes, 6);
    expect(res.dx).toBe(-2);
    // Left, center, and right edges all align with both static boxes, spanning y=[0..340].
    expect(res.guides.length).toBeGreaterThanOrEqual(1);
    const leftGuide = res.guides.find(g => g.axis === "x" && Math.abs(g.at - 100) < 1e-4);
    expect(leftGuide).toEqual({ axis: "x", at: 100, from: 0, to: 340 });

    // O(N) scan with 2,500 static boxes
    const many = [];
    for (let i = 0; i < 2500; i++) {
      many.push({ x: (i % 50) * 200, y: Math.floor(i / 50) * 150, w: 80, h: 50 });
    }
    const t0 = performance.now();
    const bigRes = computeSmartGuides({ x: 402, y: 303, w: 80, h: 50 }, many, 6);
    const elapsed = performance.now() - t0;
    expect(bigRes.dx).toBe(-2);
    expect(bigRes.dy).toBe(-3);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("Editor layout integration", () => {
  test("alignSelection, distributeSelection, tidySelection shift shapes + bound labels in one undoable transact and settle bound arrows", () => {
    const a = rect("a", 0, 0, 100, 60);
    const lblA = makeElement("text", { id: "la", x: 40, y: 20, width: 20, height: 20, containerId: "a", text: "A" });
    a.boundElements = [{ id: "la", type: "text" }, { id: "arr", type: "arrow" }];
    const b = rect("b", 120, 40, 100, 60);
    b.boundElements = [{ id: "arr", type: "arrow" }];
    const c = rect("c", 400, 20, 100, 60);
    const arr = makeElement("arrow", {
      id: "arr",
      x: 106,
      y: 30,
      width: 8,
      height: 40,
      points: [[0, 0], [8, 40]],
      startBinding: { elementId: "a", focus: 0, gap: 6, fixedPoint: [1, 0.5], side: "right" },
      endBinding: { elementId: "b", focus: 0, gap: 6, fixedPoint: [0, 0.5], side: "left" },
    });

    const ed = new Editor({ scene: { elements: [a, lblA, b, c, arr] } });
    ed.select(["a", "b", "c"]);

    // 1. Align top in one undoable step
    expect(ed.alignSelection("top")).toBe(true);
    expect(ed.doc.get("a").y).toBe(0);
    expect(ed.doc.get("b").y).toBe(0);
    expect(ed.doc.get("c").y).toBe(0);
    // Arrow settled to match b's new y (center y = 30)
    const arrAfterAlign = ed.doc.get("arr");
    expect(arrAfterAlign.y).toBeCloseTo(30, 1);
    expect(arrAfterAlign.y + arrAfterAlign.points[arrAfterAlign.points.length - 1][1]).toBeCloseTo(30, 1);
    expect(ed.undoStack.length).toBe(1);

    // 2. Distribute horizontally
    expect(ed.distributeSelection("horizontal")).toBe(true);
    expect(ed.doc.get("a").x).toBeCloseTo(0, 5);
    expect(ed.doc.get("b").x).toBeCloseTo(200, 5);
    expect(ed.doc.get("c").x).toBeCloseTo(400, 5);
    // Arrow settled to span from a.right+6 (106) to b.left-6 (194)
    const arrAfterDist = ed.doc.get("arr");
    expect(arrAfterDist.x).toBeCloseTo(106, 1);
    expect(arrAfterDist.x + arrAfterDist.points[arrAfterDist.points.length - 1][0]).toBeCloseTo(194, 1);
    expect(ed.undoStack.length).toBe(2);

    // 3. Tidy row with custom gap=30 and shift label along with shape
    expect(ed.tidySelection({ gap: 30 })).toBe(true);
    expect(ed.doc.get("a").x).toBeCloseTo(0, 5);
    expect(ed.doc.get("b").x).toBeCloseTo(130, 5);
    expect(ed.doc.get("c").x).toBeCloseTo(260, 5);
    expect(ed.undoStack.length).toBe(3);

    // Undo tidy restores distributed positions in 1 step
    ed.undo();
    expect(ed.doc.get("b").x).toBeCloseTo(200, 5);
    expect(ed.doc.get("c").x).toBeCloseTo(400, 5);

    // Move "a" via alignSelection("right") and verify bound label shifts with it
    ed.alignSelection("right");
    expect(ed.doc.get("a").x).toBeCloseTo(400, 5);
    expect(ed.doc.get("la").x).toBeCloseTo(440, 5);
  });

  test("respects locked elements and readOnly mode", () => {
    const a = rect("a", 0, 0, 80, 40, { locked: true });
    const b = rect("b", 100, 50, 80, 40);
    const c = rect("c", 200, 100, 80, 40);
    const ed = new Editor({ scene: { elements: [a, b, c] } });
    ed.select(["a", "b", "c"]);

    expect(ed.alignSelection("left")).toBe(true);
    expect(ed.doc.get("a").x).toBe(0);   // locked: untouched
    expect(ed.doc.get("b").x).toBe(100); // aligned to unlocked min (100)
    expect(ed.doc.get("c").x).toBe(100);

    // Locked bound label is never mutated even when its host shape moves
    const host = rect("h", 0, 200, 80, 40);
    const lockedLabel = makeElement("text", { id: "hl", x: 30, y: 210, width: 20, height: 20, containerId: "h", text: "H", locked: true });
    const other = rect("o", 150, 200, 80, 40);
    const ed2 = new Editor({ scene: { elements: [host, lockedLabel, other] } });
    ed2.select(["h", "o"]);
    expect(ed2.alignSelection("right")).toBe(true);
    expect(ed2.doc.get("h").x).toBe(150);
    expect(ed2.doc.get("hl").x).toBe(30); // locked label untouched

    // Read-only editor rejects layout commands
    const ro = new Editor({ scene: { elements: [b, c] }, readOnly: true });
    ro.select(["b", "c"]);
    expect(ro.alignSelection("left")).toBe(false);
    expect(ro.tidySelection()).toBe(false);
    expect(ro.doc.get("c").x).toBe(200);
  });

  test("live drag snapping uses computeSmartGuides and populates editor.guides", () => {
    const anchor = rect("anchor", 200, 100, 100, 60);
    const mover = rect("mover", 50, 220, 100, 60);
    const ed = new Editor({ scene: { elements: [anchor, mover] } });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.select(["mover"]);

    // Drag mover from (100, 250) to (248, 250) -> dx=148, mover.x = 198 -> snaps to 200 (+2)
    ed.pointerDown({ x: 100, y: 250 });
    ed.pointerMove({ x: 248, y: 250 });
    expect(ed.doc.get("mover").x).toBeCloseTo(200, 4);
    expect(ed.guides.length).toBeGreaterThanOrEqual(1);
    expect(ed.guides.some(g => g.axis === "x" && Math.abs(g.at - 200) < 1e-4 && Math.abs(g.x - 200) < 1e-4)).toBe(true);

    // Guides clear on pointerUp
    ed.pointerUp({ x: 248, y: 250 });
    expect(ed.guides).toEqual([]);
    expect(ed.doc.get("mover").x).toBeCloseTo(200, 4);
  });
});
