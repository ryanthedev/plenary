import { describe, test, expect } from "bun:test";
import { makeElement, defaultLayer, BASE_LAYER } from "../../packages/core/model.js";
import { bbox, corners, inBox, toLocal } from "../../packages/core/geometry.js";
import { Doc } from "../../packages/core/doc.js";
import { Editor } from "../../packages/core/editor.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import {
  isContainer,
  childrenOfContainer,
  findContainingFrame,
  expandContainerBounds,
  buildSwimlane,
} from "../../packages/core/containers.js";

function frame(id, x, y, width, height, extra = {}) {
  return makeElement("frame", {
    id,
    x,
    y,
    width,
    height,
    name: extra.name ?? id,
    ...extra,
  });
}

function rect(id, x, y, width = 80, height = 50, extra = {}) {
  return makeElement("rectangle", { id, x, y, width, height, ...extra });
}

function labelFor(id, containerId, x, y, text = "Label", extra = {}) {
  return makeElement("text", {
    id,
    containerId,
    x,
    y,
    width: 40,
    height: 20,
    text,
    originalText: text,
    ...extra,
  });
}

function dragScreen(ed, from, to) {
  ed.pointerDown(from);
  ed.pointerMove({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  ed.pointerMove(to);
  ed.pointerUp(to);
}

describe("isContainer", () => {
  test("recognizes plain frames and swimlane frames, rejects other types and nullish", () => {
    expect(isContainer(frame("f1", 0, 0, 200, 150))).toBe(true);
    expect(isContainer(frame("sw1", 0, 0, 400, 180, { customData: { swimlane: { id: "s1", index: 0 } } }))).toBe(true);
    expect(isContainer(rect("r1", 0, 0))).toBe(false);
    expect(isContainer(makeElement("text", { id: "t1", text: "hi" }))).toBe(false);
    expect(isContainer(null)).toBe(false);
    expect(isContainer(undefined)).toBe(false);
  });
});

describe("childrenOfContainer", () => {
  test("returns live non-deleted children and their bound labels without duplicates", () => {
    const f1 = frame("f1", 0, 0, 400, 300);
    const r1 = rect("r1", 20, 40, 80, 50, { frameId: "f1" });
    // Bound label without explicit frameId still belongs to r1 -> included
    const l1 = labelFor("l1", "r1", 40, 55, "Box 1", { frameId: null });
    // Bound label WITH explicit frameId -> included once (no duplicate)
    const r2 = rect("r2", 140, 40, 80, 50, { frameId: "f1" });
    const l2 = labelFor("l2", "r2", 160, 55, "Box 2", { frameId: "f1" });
    const deleted = rect("r-del", 50, 50, 40, 40, { frameId: "f1", isDeleted: true });
    const delLabel = labelFor("l-del", "r1", 40, 55, "Gone", { isDeleted: true });
    const outside = rect("r-out", 600, 50, 80, 50, { frameId: null });

    const doc = new Doc({ elements: [f1, r1, l1, r2, l2, deleted, delLabel, outside] });
    const kids = childrenOfContainer(doc, "f1");
    const ids = kids.map(e => e.id);

    expect(ids).toEqual(["r1", "l1", "r2", "l2"]);
    expect(childrenOfContainer(doc, "missing")).toEqual([]);
    expect(childrenOfContainer(doc, null)).toEqual([]);
  });

  test("never includes the container itself even if frameId is self-referential", () => {
    const f1 = frame("f1", 0, 0, 300, 200, { frameId: "f1" });
    const doc = new Doc({ elements: [f1] });
    expect(childrenOfContainer(doc, "f1")).toEqual([]);
  });
});

describe("findContainingFrame", () => {
  test("returns topmost visible unlocked container enclosing element center", () => {
    const back = frame("f-back", 0, 0, 400, 300, { customData: { layer: BASE_LAYER, z: 1 } });
    const front = frame("f-front", 50, 50, 200, 150, { customData: { layer: BASE_LAYER, z: 5 } });
    const insideBoth = rect("r1", 80, 80, 60, 40); // center (110, 100)
    const insideBackOnly = rect("r2", 300, 220, 60, 40); // center (330, 240)
    const outside = rect("r3", 500, 500, 60, 40);

    const doc = new Doc({ elements: [back, front, insideBoth, insideBackOnly, outside] });
    expect(findContainingFrame(doc, insideBoth)?.id).toBe("f-front");
    expect(findContainingFrame(doc, insideBackOnly)?.id).toBe("f-back");
    expect(findContainingFrame(doc, outside)).toBeNull();
  });

  test("never matches itself, locked containers, or containers on hidden/locked layers", () => {
    const hiddenLayer = { ...defaultLayer(2, "hidden"), visible: false };
    const lockedLayer = { ...defaultLayer(3, "locked-layer"), locked: true };
    const baseFrame = frame("f-base", 0, 0, 400, 300, { customData: { layer: BASE_LAYER, z: 1 } });
    const lockedFrame = frame("f-locked", 0, 0, 400, 300, { locked: true, customData: { layer: BASE_LAYER, z: 10 } });
    const hiddenFrame = frame("f-hidden", 0, 0, 400, 300, { customData: { layer: "hidden", z: 20 } });
    const lockedLayerFrame = frame("f-ll", 0, 0, 400, 300, { customData: { layer: "locked-layer", z: 30 } });
    const shape = rect("r1", 100, 100, 60, 40);

    const doc = new Doc({
      elements: [baseFrame, lockedFrame, hiddenFrame, lockedLayerFrame, shape],
      appState: { herdr: { layers: [defaultLayer(1, BASE_LAYER), hiddenLayer, lockedLayer] } },
    });

    expect(findContainingFrame(doc, shape)?.id).toBe("f-base");
    expect(findContainingFrame(doc, baseFrame)).toBeNull();
  });
});

describe("expandContainerBounds", () => {
  test("computes padded bounding box with header space around children (ignoring bound labels)", () => {
    const f = frame("f1", 0, 0, 100, 100);
    const a = rect("a", 100, 200, 80, 40); // [100..180] x [200..240]
    const b = rect("b", 220, 260, 100, 60); // [220..320] x [260..320]
    // Stale bound label far away should be ignored
    const lbl = labelFor("l1", "a", -500, -500, "Stale");

    const res = expandContainerBounds(f, [a, b, lbl]);
    expect(res).toEqual({
      x: 100 - 24,
      y: 200 - 24 - 32,
      width: (320 - 100) + 48,
      height: (320 - 200) + 48 + 32,
    });

    const custom = expandContainerBounds(f, [a, b], { pad: 10, header: 0 });
    expect(custom).toEqual({ x: 90, y: 190, width: 240, height: 140 });
  });

  test("falls back to container bounds when no valid children exist", () => {
    const f = frame("f1", 10, 20, 300, 200);
    expect(expandContainerBounds(f, [])).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(expandContainerBounds(null, [])).toBeNull();
  });
});

describe("buildSwimlane", () => {
  test("builds horizontal and vertical Protocol v1.1-valid swimlane frames", () => {
    const horiz = buildSwimlane({
      title: "Checkout",
      lanes: ["Client", "API", "Payments"],
      x: 100,
      y: 50,
      width: 800,
      laneHeight: 160,
      layer: BASE_LAYER,
      z: -10,
    });

    expect(horiz).toHaveLength(3);
    expect(horiz.every(isContainer)).toBe(true);
    expect(horiz.map(f => f.name)).toEqual([
      "Checkout — Client",
      "Checkout — API",
      "Checkout — Payments",
    ]);
    expect(horiz.map(f => [f.x, f.y, f.width, f.height])).toEqual([
      [100, 50, 800, 160],
      [100, 210, 800, 160],
      [100, 370, 800, 160],
    ]);
    expect(new Set(horiz.map(f => f.customData.swimlane.id)).size).toBe(1);
    expect(new Set(horiz.map(f => f.groupIds[0])).size).toBe(1);

    // Validate against Protocol v1.1 envelope rules
    const hProblem = opProblem({
      stream: "board",
      id: "c1:1",
      sentAt: 0,
      op: { elements: horiz },
    });
    expect(hProblem).toBeNull();

    const vert = buildSwimlane({
      title: "Sprint",
      lanes: ["Todo", "Doing", "Done"],
      orientation: "vertical",
      x: 0,
      y: 0,
      width: 600,
      laneHeight: 400,
    });

    expect(vert).toHaveLength(3);
    expect(vert.map(f => [f.x, f.y, f.width, f.height])).toEqual([
      [0, 0, 200, 400],
      [200, 0, 200, 400],
      [400, 0, 200, 400],
    ]);
    expect(vert[0].customData.swimlane.orientation).toBe("vertical");
    expect(opProblem({ stream: "board", id: "c1:2", sentAt: 0, op: { elements: vert } })).toBeNull();
  });
});

describe("Editor container & swimlane integration", () => {
  test("moving and nudging a container moves editable children & labels, avoids double-shift, and settles bound arrows", () => {
    const f = frame("f1", 0, 0, 300, 200, { customData: { layer: BASE_LAYER, z: -5 } });
    const child = rect("c1", 40, 40, 80, 50, {
      frameId: "f1",
      boundElements: [{ id: "l1", type: "text" }, { id: "a1", type: "arrow" }],
      customData: { layer: BASE_LAYER, z: 1 },
    });
    const lbl = labelFor("l1", "c1", 60, 55, "Inside", { customData: { layer: BASE_LAYER, z: 2 } });
    const lockedChild = rect("c-lock", 160, 40, 60, 40, {
      frameId: "f1",
      locked: true,
      customData: { layer: BASE_LAYER, z: 3 },
    });
    const external = rect("ext", 420, 40, 80, 50, {
      boundElements: [{ id: "a1", type: "arrow" }],
      customData: { layer: BASE_LAYER, z: 4 },
    });
    const arrow = makeElement("arrow", {
      id: "a1",
      x: 120,
      y: 65,
      points: [[0, 0], [300, 0]],
      startBinding: { elementId: "c1", focus: 0, gap: 6 },
      endBinding: { elementId: "ext", focus: 0, gap: 6 },
      customData: { layer: BASE_LAYER, z: 5 },
    });

    const ed = new Editor({ scene: { elements: [f, child, lbl, lockedChild, external, arrow] } });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.setAppState({ snap: false });

    // 1. Nudge container alone: child + label follow, locked child stays put, arrow re-settles
    ed.select(["f1"]);
    ed.nudge(50, 30);

    expect(ed.doc.get("f1").x).toBe(50);
    expect(ed.doc.get("f1").y).toBe(30);
    expect(ed.doc.get("c1").x).toBe(90);
    expect(ed.doc.get("c1").y).toBe(70);
    expect(ed.doc.get("l1").x).toBe(110);
    expect(ed.doc.get("l1").y).toBe(85);
    expect(ed.doc.get("c-lock").x).toBe(160);
    expect(ed.doc.get("c-lock").y).toBe(40);
    // Arrow start should have followed moved child c1
    const settledAfterNudge = ed.doc.get("a1");
    expect(settledAfterNudge.x).toBeGreaterThan(150);
    expect(settledAfterNudge.y).toBeGreaterThan(80);

    // 2. Select BOTH container and child, nudge again: NO double-shifting!
    ed.select(["f1", "c1"]);
    ed.nudge(20, 10);
    expect(ed.doc.get("f1").x).toBe(70);
    expect(ed.doc.get("f1").y).toBe(40);
    expect(ed.doc.get("c1").x).toBe(110); // 90 + 20, NOT 90 + 40
    expect(ed.doc.get("c1").y).toBe(80);  // 70 + 10, NOT 70 + 20
    expect(ed.doc.get("l1").x).toBe(130);
    expect(ed.doc.get("l1").y).toBe(95);

    // 3. Drag container via pointer (hit its top border at x=120, y=40): children follow & undoable in one step
    ed.select(["f1"]);
    dragScreen(ed, { x: 120, y: 40 }, { x: 170, y: 90 });
    expect(ed.doc.get("f1").x).toBe(120);
    expect(ed.doc.get("f1").y).toBe(90);
    expect(ed.doc.get("c1").x).toBe(160);
    expect(ed.doc.get("c1").y).toBe(130);
    expect(ed.doc.get("l1").x).toBe(180);
    expect(ed.doc.get("l1").y).toBe(145);

    // Single undo restores container and children together
    ed.undo();
    expect(ed.doc.get("f1").x).toBe(70);
    expect(ed.doc.get("c1").x).toBe(110);
    expect(ed.doc.get("l1").x).toBe(130);
  });

  test("dragging a non-frame element into, between, and out of containers updates frameId (undoable)", () => {
    const f1 = frame("f1", 0, 0, 240, 200, { customData: { layer: BASE_LAYER, z: -5 } });
    const f2 = frame("f2", 300, 0, 240, 200, { customData: { layer: BASE_LAYER, z: -4 } });
    const box = rect("b1", 600, 60, 60, 40, {
      backgroundColor: "#a5d8ff",
      boundElements: [{ id: "bl1", type: "text" }],
      customData: { layer: BASE_LAYER, z: 1 },
    });
    const lbl = labelFor("bl1", "b1", 610, 70, "Card", { customData: { layer: BASE_LAYER, z: 2 } });

    const ed = new Editor({ scene: { elements: [f1, f2, box, lbl] } });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.setAppState({ snap: false });

    // Drag box into f1 (center starts at (630, 80) -> move to (100, 100))
    dragScreen(ed, { x: 630, y: 80 }, { x: 100, y: 100 });
    expect(ed.doc.get("b1").frameId).toBe("f1");
    expect(ed.doc.get("bl1").frameId).toBe("f1");

    // Drag box from f1 into f2
    dragScreen(ed, { x: 100, y: 100 }, { x: 420, y: 100 });
    expect(ed.doc.get("b1").frameId).toBe("f2");
    expect(ed.doc.get("bl1").frameId).toBe("f2");

    // Drag box out of f2 onto empty canvas
    dragScreen(ed, { x: 420, y: 100 }, { x: 420, y: 350 });
    expect(ed.doc.get("b1").frameId).toBeNull();
    expect(ed.doc.get("bl1").frameId).toBeNull();

    // Undo restores previous frameId ("f2")
    ed.undo();
    expect(ed.doc.get("b1").frameId).toBe("f2");
    expect(ed.doc.get("bl1").frameId).toBe("f2");
  });

  test("dragging a container over another container does not re-parent its children", () => {
    const f1 = frame("f1", 0, 0, 200, 160, { customData: { layer: BASE_LAYER, z: -5 } });
    const f2 = frame("f2", 260, 0, 220, 180, { customData: { layer: BASE_LAYER, z: -1 } });
    const child = rect("c1", 40, 40, 60, 40, { frameId: "f1", customData: { layer: BASE_LAYER, z: 2 } });

    const ed = new Editor({ scene: { elements: [f1, f2, child] } });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.setAppState({ snap: false });

    // Select both f1 and c1 and drag f1 right on top of higher-z f2
    ed.select(["f1", "c1"]);
    dragScreen(ed, { x: 100, y: 0 }, { x: 360, y: 0 });
    expect(ed.doc.get("c1").frameId).toBe("f1");
  });

  test("editor.fitContainerToChildren resizes container cleanly and is undoable", () => {
    const f1 = frame("f1", 0, 0, 500, 500);
    const c1 = rect("c1", 100, 120, 80, 40, { frameId: "f1" });
    const c2 = rect("c2", 240, 200, 60, 50, { frameId: "f1" });
    const ed = new Editor({ scene: { elements: [f1, c1, c2] } });

    expect(ed.fitContainerToChildren("f1")).toBe(true);
    const fitted = ed.doc.get("f1");
    expect(fitted.x).toBe(100 - 24);
    expect(fitted.y).toBe(120 - 24 - 32);
    expect(fitted.width).toBe((300 - 100) + 48);
    expect(fitted.height).toBe((250 - 120) + 48 + 32);

    // Calling again is a no-op
    expect(ed.fitContainerToChildren("f1")).toBe(false);

    // Undo restores original container size
    ed.undo();
    const restored = ed.doc.get("f1");
    expect(restored.x).toBe(0);
    expect(restored.y).toBe(0);
    expect(restored.width).toBe(500);
    expect(restored.height).toBe(500);

    // Empty container or non-container returns false
    const empty = frame("f-empty", 0, 0, 200, 200);
    ed.doc.apply({ elements: [empty] }, { force: true });
    expect(ed.fitContainerToChildren("f-empty")).toBe(false);
    expect(ed.fitContainerToChildren("c1")).toBe(false);
  });

  test("editor.addSwimlane adds Protocol v1.1-valid frames in one undoable step", () => {
    const ops = [];
    const ed = new Editor({ onOp: op => ops.push(op) });
    ed.view = { x: 0, y: 0, scale: 1 };

    const ids = ed.addSwimlane({
      title: "Incident Response",
      lanes: ["Triage", "Mitigate", "Postmortem"],
      x: 50,
      y: 80,
      width: 600,
      laneHeight: 150,
    });

    expect(ids).toHaveLength(3);
    expect([...ed.sel]).toEqual(ids);
    const frames = ids.map(id => ed.doc.get(id));
    expect(frames.every(isContainer)).toBe(true);
    expect(opProblem({ stream: "board", id: "c1:1", sentAt: 0, op: ops[ops.length - 1] })).toBeNull();

    // Single undo removes all 3 lanes
    ed.undo();
    expect(ids.every(id => ed.doc.get(id) === null)).toBe(true);
  });

  test("alt-dragging a container clones its children and remaps frameId on the copies", () => {
    const f1 = frame("f1", 0, 0, 240, 180, { customData: { layer: BASE_LAYER, z: -5 } });
    const c1 = rect("c1", 40, 40, 80, 50, {
      frameId: "f1",
      boundElements: [{ id: "l1", type: "text" }],
      customData: { layer: BASE_LAYER, z: 1 },
    });
    const l1 = labelFor("l1", "c1", 60, 55, "Node", { frameId: "f1", customData: { layer: BASE_LAYER, z: 2 } });

    const ed = new Editor({ scene: { elements: [f1, c1, l1] } });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.setAppState({ snap: false });

    ed.select(["f1"]);
    // Alt-drag frame by (+300, +100)
    ed.pointerDown({ x: 100, y: 0 }, { alt: true });
    ed.pointerMove({ x: 250, y: 50 }, { alt: true });
    ed.pointerMove({ x: 400, y: 100 }, { alt: true });
    ed.pointerUp({ x: 400, y: 100 }, { alt: true });

    const frames = ed.doc.live().filter(isContainer);
    expect(frames).toHaveLength(2);
    const copyFrame = frames.find(f => f.id !== "f1");
    expect(copyFrame).toBeDefined();
    // Original moved to (300, 100) with its original child + label
    expect(ed.doc.get("f1").x).toBe(300);
    expect(ed.doc.get("c1").x).toBe(340);
    expect(ed.doc.get("c1").frameId).toBe("f1");
    // Copy stayed at (0, 0) WITH its own cloned child + cloned label remapped to copyFrame.id
    expect(copyFrame.x).toBe(0);
    const copyKids = childrenOfContainer(ed.doc, copyFrame.id);
    const copyRect = copyKids.find(e => e.type === "rectangle");
    const copyLabel = copyKids.find(e => e.type === "text");
    expect(copyRect).toBeDefined();
    expect(copyRect.x).toBe(40);
    expect(copyRect.frameId).toBe(copyFrame.id);
    expect(copyLabel).toBeDefined();
    expect(copyLabel.containerId).toBe(copyRect.id);
  });

  test("fitContainerToChildren wraps all child corners inside a rotated frame", () => {
    const f1 = frame("f1", 0, 0, 200, 200, { angle: Math.PI / 4 });
    const c1 = rect("c1", 60, 40, 120, 40, { frameId: "f1" });
    const c2 = rect("c2", 140, 130, 80, 60, { frameId: "f1" });
    const ed = new Editor({ scene: { elements: [f1, c1, c2] } });

    expect(ed.fitContainerToChildren("f1", { pad: 20, header: 24 })).toBe(true);
    const fitted = ed.doc.get("f1");
    expect(fitted.angle).toBeCloseTo(Math.PI / 4, 8);

    const fb = bbox(fitted);
    for (const child of [ed.doc.get("c1"), ed.doc.get("c2")]) {
      for (const pt of corners(child)) {
        expect(inBox(toLocal(fitted, pt), fb)).toBe(true);
      }
    }
  });
});
