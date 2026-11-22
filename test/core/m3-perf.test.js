// M3 Phase 1 gate: deterministic spatial culling, world-geometry cache, spatial hitTest parity,
// smooth camera damping/inertia, and canvas DPR memory cap.
import { test, expect } from "bun:test";
import { Doc } from "../../packages/core/doc.js";
import { makeElement, clone } from "../../packages/core/model.js";
import { paintScene } from "../../packages/core/render.js";
import { hitTest, hits, outlineDistance, bbox } from "../../packages/core/geometry.js";
import { Editor } from "../../packages/core/editor.js";
import { cappedDpr, MAX_CANVAS_PIXELS, THEMES } from "../../web/adapters/dom/paint.js";

/** Build a deterministic 100×100 grid of 10,000 shapes spaced 200 world units apart. */
function makeGridDoc(n = 100) {
  const elements = [];
  let k = 0;
  for (let gx = 0; gx < n; gx++) {
    for (let gy = 0; gy < n; gy++) {
      const el = makeElement(k % 3 === 0 ? "rectangle" : k % 3 === 1 ? "ellipse" : "diamond", {
        id: `el-${gx}-${gy}`,
        x: gx * 200,
        y: gy * 200,
        width: 80,
        height: 60,
        seed: k + 1,
        backgroundColor: k % 2 === 0 ? "#a5d8ff" : "transparent",
      });
      el.version = 1;
      el.versionNonce = k + 1;
      elements.push(el);
      k++;
    }
  }
  return new Doc({ elements });
}

test("spatial culling: 10,000-element board visits only the visible viewport slice", () => {
  const doc = makeGridDoc(100);   // 10,000 elements spanning [0..20000, 0..20000]
  const view = { x: -2000, y: -2000, scale: 1 };
  const clip = { w: 1000, h: 800 };   // ~5×4 = ~20 visible elements

  const stats1 = {};
  const items1 = paintScene(doc, view, THEMES.light, { clip, stats: stats1 });
  expect(items1.length).toBeGreaterThan(20);
  expect(stats1.visited).toBeLessThan(200);       // ≪ 10,000
  expect(stats1.cacheMisses).toBeGreaterThan(0);

  // Warm re-paint after panning slightly or zooming: already-seen elements hit the world-geometry cache (0 misses).
  const stats2 = {};
  paintScene(doc, { x: -2010, y: -2010, scale: 1.5 }, THEMES.light, { clip, stats: stats2 });
  expect(stats2.cacheHits).toBeGreaterThan(0);
  expect(stats2.cacheMisses ?? 0).toBe(0);

  // Updating 1 visible element invalidates only that element.
  const target = clone(doc.get("el-12-12"));
  target.x += 5; target.version = 2; target.versionNonce = 999999;
  doc.apply({ elements: [target] });
  const stats3 = {};
  paintScene(doc, { x: -2010, y: -2010, scale: 1.5 }, THEMES.light, { clip, stats: stats3 });
  expect(stats3.cacheMisses).toBe(1);
  expect(stats3.cacheHits).toBeGreaterThan(10);
});

test("geoCache invalidation: in-place point coordinate mutation on a linear element invalidates cachedLinear", () => {
  const line = makeElement("line", { id: "l1", x: 10, y: 20, width: 100, height: 0, points: [[0, 0], [100, 0]], roughness: 0, seed: 7 });
  const doc = new Doc({ elements: [line] });
  const view = { x: 0, y: 0, scale: 1 };

  const s1 = {};
  const out1 = paintScene(doc, view, THEMES.light, { stats: s1 });
  expect(s1.cacheMisses).toBe(1);
  expect(out1[0].cmds[1]).toEqual(["L", 110, 20]);

  // Warm hit with no mutation.
  const s2 = {};
  paintScene(doc, view, THEMES.light, { stats: s2 });
  expect(s2.cacheHits).toBe(1);
  expect(s2.cacheMisses ?? 0).toBe(0);

  // Mutate a point coordinate in place (same points.length, version, versionNonce).
  line.points[1][0] = 250;
  line.points[1][1] = 45;
  const s3 = {};
  const out3 = paintScene(doc, view, THEMES.light, { stats: s3 });
  expect(s3.cacheMisses).toBe(1);
  expect(s3.cacheHits ?? 0).toBe(0);
  expect(out3[0].cmds[1]).toEqual(["L", 260, 65]);
});

test("display-list parity: culled spatial paint matches unculled paint for shapes, rotated shapes, labels, frames, arrows, bound arrows, images, and animated elements", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 100, y: 100, width: 120, height: 80, angle: 0.6, seed: 10 });
  const rect2 = makeElement("rectangle", { id: "r2", x: 420, y: 260, width: 100, height: 70, seed: 15 });
  const label = makeElement("text", { id: "t1", x: 100, y: 100, width: 120, height: 80, text: "Hello", containerId: "r1", seed: 11 });
  const frame = makeElement("frame", { id: "f1", x: 300, y: 80, width: 200, height: 150, name: "Stage", seed: 12 });
  const arrow = makeElement("arrow", { id: "a1", x: 220, y: 140, width: 80, height: 0, points: [[0, 0], [80, 0]], endArrowhead: "arrow", seed: 13 });
  const boundArrow = makeElement("arrow", {
    id: "ba1", x: 220, y: 140, width: 200, height: 120, points: [[0, 0], [200, 120]],
    startBinding: { elementId: "r1", focus: 0, gap: 6 },
    endBinding: { elementId: "r2", focus: 0, gap: 6 },
    endArrowhead: "arrow", seed: 16,
  });
  const img = makeElement("image", { id: "img1", x: 50, y: 320, width: 140, height: 90, fileId: "file-1", seed: 17 });
  const animRect = makeElement("rectangle", {
    id: "anim1", x: 540, y: 120, width: 90, height: 60, seed: 18,
    customData: { anim: { effect: "slide", at: 0, dur: 600, from: "left" } },
  });
  const far = makeElement("rectangle", { id: "far", x: 9000, y: 9000, width: 100, height: 100, seed: 14 });
  const files = { "file-1": { id: "file-1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } };
  const doc = new Doc({ elements: [rect, rect2, label, frame, arrow, boundArrow, img, animRect, far], files });

  const view = { x: 0, y: 0, scale: 1 };
  const culled = paintScene(doc, view, THEMES.light, { clip: { w: 800, h: 600 } });
  const full = paintScene(doc, view, THEMES.light);

  // Every visible item (excluding `far`) matches in exact paint order and coordinates.
  expect(culled).toEqual(full.filter(it => it.id !== "far"));
  expect(culled.some(it => it.t === "image" && it.id === "img1")).toBe(true);
  expect(culled.some(it => it.id === "ba1")).toBe(true);
  expect(culled.some(it => it.id === "anim1")).toBe(true);

  // During timeline playback (`time != null`), culled and unculled match identically including animated offsets.
  const culledPlay = paintScene(doc, view, THEMES.light, { clip: { w: 800, h: 600 }, time: 300 });
  const fullPlay = paintScene(doc, view, THEMES.light, { time: 300 });
  expect(culledPlay).toEqual(fullPlay);
});

test("spatial hitTest: checks < 1% of 10,000 elements and matches linear scan identically", () => {
  const doc = makeGridDoc(100);
  // Add an overlapping top element to test z-order preservation.
  const top = makeElement("rectangle", { id: "top-overlap", x: 1000, y: 1000, width: 90, height: 70, backgroundColor: "#ffc9c9", seed: 42 });
  doc.apply({ elements: [top] });

  const linearHitTest = (d, p, tol = 6) => {
    const els = d.visible();
    for (let i = els.length - 1; i >= 0; i--) if (hits(d, els[i], p, tol)) return els[i];
    let best = null, area = Infinity;
    for (const el of els) {
      if (el.type === "frame" || !["rectangle", "diamond", "ellipse"].includes(el.type) || outlineDistance(el, p) > 0) continue;
      const b = bbox(el), a = b.w * b.h;
      if (a < area) { best = el; area = a; }
    }
    return best;
  };

  let maxChecked = 0;
  for (let i = 0; i < 40; i++) {
    const p = { x: (i * 497) % 19900 + 20, y: (i * 733) % 19900 + 20 };
    const stats = {};
    const got = hitTest(doc, p, 6, { stats });
    const want = linearHitTest(doc, p, 6);
    expect(got?.id ?? null).toBe(want?.id ?? null);
    if (stats.checked > maxChecked) maxChecked = stats.checked;
  }
  expect(maxChecked).toBeLessThan(100);   // < 1% of 10,000
  expect(hitTest(doc, { x: 1020, y: 1020 }, 6)?.id).toBe("top-overlap");
});

test("Editor camera: animateViewTo converges monotonically, flingCamera decelerates to rest, pointerDown cancels", () => {
  let t = 1000;
  const ed = new Editor({ clock: () => t });
  ed.view = { x: 0, y: 0, scale: 1 };

  ed.animateViewTo({ x: -200, y: -100, scale: 2 }, { durationMs: 200 });
  let prevScale = ed.view.scale;
  let steps = 0;
  while (ed.stepCamera(16)) {
    expect(ed.view.scale).toBeGreaterThanOrEqual(prevScale);
    prevScale = ed.view.scale;
    steps++;
  }
  expect(steps).toBeGreaterThanOrEqual(10);
  expect(ed.view.x).toBeCloseTo(-200, 5);
  expect(ed.view.y).toBeCloseTo(-100, 5);
  expect(ed.view.scale).toBeCloseTo(2, 5);
  expect(ed.stepCamera(16)).toBe(false);

  // Pan inertia: flicking decelerates smoothly and settles to idle.
  ed.flingCamera(1000, -500);
  const startX = ed.view.x;
  let frames = 0;
  while (ed.stepCamera(16) && frames < 200) frames++;
  expect(ed.view.x).toBeGreaterThan(startX);
  expect(ed.camVel).toBeNull();
  expect(frames).toBeLessThan(200);

  // Cancels cleanly on wheel / zoomAt and pointerDown.
  ed.flingCamera(1000, 0);
  ed.wheel({ x: 0, y: 10 }, { x: 100, y: 100 });
  expect(ed.camVel).toBeNull();
  ed.animateViewTo({ x: 50, y: 50, scale: 1.5 }, { durationMs: 200 });
  ed.pointerDown({ x: 100, y: 100 });
  expect(ed.camAnim).toBeNull();

  // fit and frame navigation animate by default and support { animate: false } for synchronous snap.
  const f1 = makeElement("frame", { id: "fr1", x: 500, y: 400, width: 300, height: 200, name: "F1", seed: 1 });
  const f2 = makeElement("frame", { id: "fr2", x: 1500, y: 400, width: 300, height: 200, name: "F2", seed: 2 });
  ed.doc.apply({ elements: [f1, f2] });
  ed.fit(undefined, 40, { animate: false });
  expect(ed.hasCameraMotion()).toBe(false);
  const snappedView = { ...ed.view };

  ed.goToFrame("fr2");
  expect(ed.hasCameraMotion()).toBe(true);
  expect(ed.view).toEqual(snappedView);
  while (ed.stepCamera(16));
  expect(ed.hasCameraMotion()).toBe(false);
  expect(ed.view.x).not.toBeCloseTo(snappedView.x, 1);

  ed.stepFrame(-1, { animate: false });
  expect(ed.hasCameraMotion()).toBe(false);
  expect(ed.frameAt).toBe("fr1");
});

test("cappedDpr: keeps 3x iPhone crisp and caps giant viewports within MAX_CANVAS_PIXELS", () => {
  // iPhone 15 Pro (393x852 @ 3x = 3.01 MP) stays full 3x.
  expect(cappedDpr(393, 852, 3)).toBe(3);
  // Desktop 4K window at 3x (2560x1440 @ 3x = 33.1 MP) caps cleanly under 8 MP.
  const d = cappedDpr(2560, 1440, 3);
  expect(d).toBeLessThan(3);
  expect(d).toBeGreaterThanOrEqual(1);
  expect(2560 * 1440 * d * d).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
});
