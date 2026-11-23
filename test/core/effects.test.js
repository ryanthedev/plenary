// Issue #117 Phase 2: Pure effects model (blend modes, shape clipping masks) and render/planBatches isolation.
import { describe, test, expect } from "bun:test";
import {
  BLEND_MODES,
  CLIP_SHAPES,
  normalizeBlendMode,
  normalizeClipShape,
  toCanvasComposite,
  toSvgBlendMode,
  normalizeEffects,
  effectsOf,
  clipPathCommands,
} from "../../packages/core/effects.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement } from "../../packages/core/model.js";
import { paintScene, planBatches } from "../../packages/core/render.js";
import { LIGHT } from "../../packages/core/export.js";

describe("packages/core/effects.js — blend modes & clip shapes", () => {
  test("BLEND_MODES and CLIP_SHAPES expose the exact WebKit-safe allowlists", () => {
    expect(BLEND_MODES).toEqual(["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference"]);
    expect(CLIP_SHAPES).toEqual(["none", "rect", "rounded", "ellipse", "diamond"]);
    expect(Object.isFrozen(BLEND_MODES)).toBe(true);
    expect(Object.isFrozen(CLIP_SHAPES)).toBe(true);
  });

  test("toCanvasComposite maps normal to source-over, preserves allowlisted modes, and rejects invalid/injection values", () => {
    expect(toCanvasComposite("normal")).toBe("source-over");
    expect(toCanvasComposite(undefined)).toBe("source-over");
    expect(toCanvasComposite(null)).toBe("source-over");
    expect(toCanvasComposite("  MULTIPLY ")).toBe("multiply");
    for (const m of BLEND_MODES) {
      expect(toCanvasComposite(m)).toBe(m === "normal" ? "source-over" : m);
    }
    expect(toCanvasComposite("color-burn")).toBe("source-over");
    expect(toCanvasComposite("multiply; background:url(x)")).toBe("source-over");
    expect(toCanvasComposite(123)).toBe("source-over");
  });

  test("toSvgBlendMode returns null for normal/untrusted values and allowlisted strings for active modes", () => {
    expect(toSvgBlendMode("normal")).toBeNull();
    expect(toSvgBlendMode(undefined)).toBeNull();
    expect(toSvgBlendMode("")).toBeNull();
    expect(toSvgBlendMode("multiply; background:url(javascript:alert(1))")).toBeNull();
    expect(toSvgBlendMode('overlay" onload="alert(1)')).toBeNull();
    expect(toSvgBlendMode("  Screen ")).toBe("screen");
    for (const m of BLEND_MODES) {
      expect(toSvgBlendMode(m)).toBe(m === "normal" ? null : m);
    }
  });

  test("normalizeEffects and effectsOf safely normalize missing, partial, and malicious inputs", () => {
    expect(normalizeEffects(null)).toEqual({ blendMode: "normal", clipShape: "none" });
    expect(normalizeEffects("bad")).toEqual({ blendMode: "normal", clipShape: "none" });
    expect(normalizeEffects({ blendMode: "multiply", clipShape: "ellipse" })).toEqual({
      blendMode: "multiply",
      clipShape: "ellipse",
    });
    expect(normalizeEffects({ blendMode: "evil", clipShape: "star", clipRadius: -5 })).toEqual({
      blendMode: "normal",
      clipShape: "none",
    });
    expect(normalizeEffects({ blendMode: "screen", clipShape: "rounded", clipRadius: 12 })).toEqual({
      blendMode: "screen",
      clipShape: "rounded",
      clipRadius: 12,
    });
    expect(effectsOf(null)).toEqual({ blendMode: "normal", clipShape: "none" });
    expect(effectsOf({ customData: { effects: { blendMode: "difference", clipShape: "diamond" } } })).toEqual({
      blendMode: "difference",
      clipShape: "diamond",
    });
    expect(normalizeBlendMode("DARKEN")).toBe("darken");
    expect(normalizeClipShape("ROUNDED")).toBe("rounded");
  });

  test("clipPathCommands generates valid normalized geometry for every shape and guards invalid bounds", () => {
    expect(clipPathCommands("none", 0, 0, 100, 50)).toEqual([]);
    expect(clipPathCommands("unknown", 0, 0, 100, 50)).toEqual([]);
    expect(clipPathCommands("rect", 0, 0, 0, 50)).toEqual([]);
    expect(clipPathCommands("rect", 0, 0, 100, -10)).toEqual([]);
    expect(clipPathCommands("rect", NaN, 0, 100, 50)).toEqual([]);

    expect(clipPathCommands("rect", 10, 20, 100, 50)).toEqual([
      ["M", 10, 20],
      ["L", 110, 20],
      ["L", 110, 70],
      ["L", 10, 70],
    ]);

    expect(clipPathCommands("diamond", 10, 20, 100, 60)).toEqual([
      ["M", 60, 20],
      ["L", 110, 50],
      ["L", 60, 80],
      ["L", 10, 50],
    ]);

    const rounded = clipPathCommands("rounded", 0, 0, 100, 60, 10);
    expect(rounded[0]).toEqual(["M", 10, 0]);
    expect(rounded.filter(c => c[0] === "Q").length).toBe(4);
    // Clamps oversized radius to min(w/2, h/2)
    const clamped = clipPathCommands("rounded", 0, 0, 100, 40, 999);
    expect(clamped[0]).toEqual(["M", 20, 0]);
    // Radius 0 degrades cleanly to sharp rect
    expect(clipPathCommands("rounded", 0, 0, 100, 40, 0)).toEqual(clipPathCommands("rect", 0, 0, 100, 40));

    const ellipse = clipPathCommands("ellipse", 10, 20, 100, 60);
    expect(ellipse[0]).toEqual(["M", 110, 50]);
    expect(ellipse.filter(c => c[0] === "Q").length).toBe(16);
    // Every point in ellipse commands stays finite
    for (const c of ellipse) {
      for (let i = 1; i < c.length; i++) expect(Number.isFinite(c[i])).toBe(true);
    }
  });
});

describe("render.js — effects attachment and planBatches isolation", () => {
  test("paintScene attaches validated blendMode and clipShape (with rotation) only when non-default", () => {
    const plain = makeElement("rectangle", { id: "r1", x: 0, y: 0, width: 100, height: 60, backgroundColor: "#ffc9c9" });
    const styled = makeElement("rectangle", {
      id: "r2",
      x: 20,
      y: 30,
      width: 100,
      height: 80,
      angle: 0.5,
      backgroundColor: "#a5d8ff",
      customData: { effects: { blendMode: "multiply", clipShape: "rounded", clipRadius: 12 } },
    });
    const doc = new Doc({ elements: [plain, styled] });
    const items = paintScene(doc, { x: 0, y: 0, scale: 2 }, LIGHT);

    const r1Items = items.filter(it => it.id === "r1");
    expect(r1Items.length).toBeGreaterThan(0);
    for (const it of r1Items) {
      expect(it.blendMode).toBeUndefined();
      expect(it.clipShape).toBeUndefined();
    }

    const r2Items = items.filter(it => it.id === "r2");
    expect(r2Items.length).toBeGreaterThan(0);
    for (const it of r2Items) {
      expect(it.blendMode).toBe("multiply");
      expect(it.clipShape).toEqual({
        shape: "rounded",
        x: 40,
        y: 60,
        w: 200,
        h: 160,
        radius: 24,
        angle: 0.5,
        cx: 140,
        cy: 140,
      });
    }
  });

  test("planBatches never merges items with non-normal blendMode, clipShape, or clip into shared batches", () => {
    const makePath = (id, x, extra = {}) => ({
      t: "path",
      id,
      cmds: [["M", x, 0], ["L", x + 50, 0], ["L", x + 50, 50]],
      fill: "#3B48E8",
      opacity: 1,
      ...extra,
    });
    const keyOf = it => `fill:${it.fill}`;

    // Two normal non-overlapping paths merge into 1 batch
    const normalRes = planBatches([makePath("a", 0), makePath("b", 100)], keyOf);
    expect(normalRes.layers.length).toBe(1);
    expect(normalRes.layers[0].items.map(i => i.id)).toEqual(["a", "b"]);

    // BlendMode isolates from both earlier and later normal paths, and from another blendMode path
    const blendRes = planBatches([
      makePath("n1", 0),
      makePath("m1", 100, { blendMode: "multiply" }),
      makePath("m2", 200, { blendMode: "multiply" }),
      makePath("n2", 300),
    ], keyOf);
    // n1 and n2 (non-overlapping) can share layer 0, while m1 and m2 each have their own isolated layer
    expect(blendRes.layers.length).toBe(3);
    expect(blendRes.layers[0].items.map(i => i.id)).toEqual(["n1", "n2"]);
    expect(blendRes.layers[1].isolated).toBe(true);
    expect(blendRes.layers[1].items.map(i => i.id)).toEqual(["m1"]);
    expect(blendRes.layers[2].isolated).toBe(true);
    expect(blendRes.layers[2].items.map(i => i.id)).toEqual(["m2"]);

    // Overlapping normal path after an isolated blend/clip path cannot reorder behind it
    const overlapRes = planBatches([
      makePath("n1", 0),
      makePath("c1", 20, { clipShape: { shape: "ellipse", x: 20, y: 0, w: 50, h: 50 } }),
      makePath("n2", 30), // overlaps c1 -> must NOT jump into n1's layer!
    ], keyOf);
    expect(overlapRes.layers.length).toBe(3);
    expect(overlapRes.layers[0].items.map(i => i.id)).toEqual(["n1"]);
    expect(overlapRes.layers[1].isolated).toBe(true);
    expect(overlapRes.layers[1].items.map(i => i.id)).toEqual(["c1"]);
    expect(overlapRes.layers[2].items.map(i => i.id)).toEqual(["n2"]);

    // Wipe clip also isolates cleanly
    const wipeRes = planBatches([
      makePath("w1", 0, { clip: { x: 0, y: 0, w: 25, h: 50 } }),
      makePath("n1", 200),
    ], keyOf);
    expect(wipeRes.layers.length).toBe(2);
    expect(wipeRes.layers[0].isolated).toBe(true);
  });

  test("rotated shape under nonuniform animation scaling transforms clipShape cmds in exact toWorld -> Q order", () => {
    const rect = makeElement("rectangle", {
      id: "rot1",
      x: 100,
      y: 100,
      width: 100,
      height: 60,
      angle: Math.PI / 4,
      roundness: null,
      backgroundColor: "#3B48E8",
      customData: {
        effects: { clipShape: "rect" },
        anim: {
          keys: [
            { t: 0, scaleX: 2, scaleY: 0.5, opacity: 1 },
            { t: 1000, scaleX: 2, scaleY: 0.5, opacity: 1 },
          ],
        },
      },
    });
    const doc = new Doc({ elements: [rect] });
    const items = paintScene(doc, { x: 0, y: 0, scale: 1 }, LIGHT, { time: 250 });
    const fillItem = items.find(it => it.id === "rot1" && it.fill);
    expect(fillItem).toBeDefined();
    expect(Array.isArray(fillItem.clipShape?.cmds)).toBe(true);
    expect(fillItem.clipShape.angle).toBeUndefined();
    // Rect clip mask vertices must exactly match the fill polygon vertices
    expect(fillItem.clipShape.cmds.length).toBe(fillItem.cmds.length);
    for (let i = 0; i < fillItem.cmds.length; i++) {
      expect(fillItem.clipShape.cmds[i][0]).toBe(fillItem.cmds[i][0]);
      expect(fillItem.clipShape.cmds[i][1]).toBeCloseTo(fillItem.cmds[i][1], 5);
      expect(fillItem.clipShape.cmds[i][2]).toBeCloseTo(fillItem.cmds[i][2], 5);
    }
  });
});
