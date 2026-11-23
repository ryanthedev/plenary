// The Canvas2D painter: every item kind core emits becomes the right context calls.
import { test, expect } from "bun:test";
import { paint, imageCache, THEMES, color } from "../../web/adapters/dom/paint.js";
import { Editor } from "../../packages/core/editor.js";
import { makeElement } from "../../packages/core/model.js";
import { LIGHT, DARK } from "../../packages/core/export.js";

// A recording CanvasRenderingContext2D: method calls and property sets, in order.
function fakeCtx() {
  const calls = [];
  const state = {};
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k === "calls") return calls;
      if (k in t) return t[k];
      return (...args) => { calls.push([k, ...args]); };
    },
    set(t, k, v) { t[k] = v; calls.push(["=" + String(k), v]); return true; },
  });
  return ctx;
}
const names = ctx => ctx.calls.map(c => c[0]);
const view = { width: 400, height: 300 };

test("themes match core's export themes", () => {
  expect(THEMES.light).toEqual(LIGHT);
  expect(THEMES.dark).toEqual(DARK);
});

test("background and devicePixelRatio come first", () => {
  const ctx = fakeCtx();
  paint(ctx, [], { width: 400, height: 300, dpr: 2, background: "#121212" });
  expect(ctx.calls[0]).toEqual(["setTransform", 2, 0, 0, 2, 0, 0]);
  expect(ctx.calls).toContainEqual(["=fillStyle", "#121212"]);
  expect(ctx.calls).toContainEqual(["fillRect", 0, 0, 400, 300]);
  const clear = fakeCtx(); paint(clear, [], view);
  expect(clear.calls[0]).toEqual(["setTransform", 1, 0, 0, 1, 0, 0]);
  expect(names(clear)).toContain("clearRect");
});

test("a stroked path: M, L and Q (Q is [x, y, cx, cy] → quadraticCurveTo(cx, cy, x, y)), width, dash, opacity", () => {
  const ctx = fakeCtx();
  paint(ctx, [{ t: "path", cmds: [["M", 1, 2], ["L", 3, 4], ["Q", 10, 20, 5, 6]], stroke: "#e03131", width: 3, dash: [8, 6], opacity: 0.5 }], view);
  const c = ctx.calls;
  const i = c.findIndex(x => x[0] === "beginPath");
  expect(c.slice(i, i + 4)).toEqual([["beginPath"], ["moveTo", 1, 2], ["lineTo", 3, 4], ["quadraticCurveTo", 5, 6, 10, 20]]);
  expect(c).toContainEqual(["=strokeStyle", "#e03131"]);
  expect(c).toContainEqual(["=lineWidth", 3]);
  expect(c).toContainEqual(["setLineDash", [8, 6]]);
  expect(c).toContainEqual(["=globalAlpha", 0.5]);
  expect(names(ctx)).toContain("stroke");
  expect(names(ctx)).not.toContain("fill");
});

test("a solid path resets the dash; a filled path closes and fills", () => {
  const ctx = fakeCtx();
  paint(ctx, [
    { t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "#000000", width: 1, dash: [1, 2] },
    { t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "#000000", width: 1, dash: null },
    { t: "path", cmds: [["M", 0, 0], ["L", 9, 0], ["L", 9, 9]], fill: "#a5d8ff80" },
  ], view);
  const dashes = ctx.calls.filter(c => c[0] === "setLineDash").map(c => c[1]);
  expect(dashes.slice(0, 2)).toEqual([[1, 2], []]);
  const n = names(ctx), f = n.indexOf("fill");
  expect(f).toBeGreaterThan(-1);
  expect(n[f - 2]).toBe("closePath");
  expect(ctx.calls).toContainEqual(["=fillStyle", "#a5d8ff80"]);
});

test("untrusted colors never reach the context", () => {
  expect(color("red; background:url(x)")).toBe("#888888");
  const ctx = fakeCtx();
  paint(ctx, [{ t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "url(evil)", width: 1 }], view);
  expect(ctx.calls).toContainEqual(["=strokeStyle", "#888888"]);
});

test("free text: left aligned, one fillText per line at lineHeight·(i + 0.75), font face by class", () => {
  const ctx = fakeCtx();
  paint(ctx, [{ t: "text", x: 10, y: 20, text: "ab\ncd", size: 20, color: "#1e1e1e", align: "left", lineHeight: 1.25, font: "mono" }], view);
  expect(ctx.calls).toContainEqual(["=textAlign", "left"]);
  expect(ctx.calls.filter(c => c[0] === "fillText")).toEqual([["fillText", "ab", 10, 20 + 25 * 0.75], ["fillText", "cd", 10, 20 + 25 * 1.75]]);
  expect(ctx.calls.find(c => c[0] === "=font")[1]).toMatch(/^20\.0px .*Menlo/);
});

test("a label is centred in its box; a rotated item turns about (cx, cy); reveal types it out", () => {
  const ctx = fakeCtx();
  paint(ctx, [{ t: "text", x: 0, y: 0, text: "hello", size: 10, color: "#000000", align: "center", box: { x: 0, y: 0, w: 100, h: 50 }, lineHeight: 1, angle: Math.PI / 2, cx: 50, cy: 25, reveal: 0.4 }], view);
  const c = ctx.calls, n = names(ctx);
  expect(c).toContainEqual(["=textAlign", "center"]);
  expect(c).toContainEqual(["fillText", "he", 50, 25 - 5 + 10 * 0.75]);
  expect(c).toContainEqual(["rotate", Math.PI / 2]);
  expect(c).toContainEqual(["translate", 50, 25]);
  expect(n.indexOf("save")).toBeLessThan(n.indexOf("fillText"));
  expect(n.lastIndexOf("restore")).toBeGreaterThan(n.indexOf("fillText"));
});

test("an image draws through view.image; nothing while it loads", () => {
  const img = { tag: "img" };
  const item = { t: "image", fileId: "f1", x: 1, y: 2, w: 30, h: 40, angle: 0, cx: 16, cy: 22, opacity: 1 };
  const ready = fakeCtx();
  paint(ready, [item], { ...view, image: id => (id === "f1" ? img : null) });
  expect(ready.calls).toContainEqual(["drawImage", img, 1, 2, 30, 40]);
  const loading = fakeCtx();
  paint(loading, [item], { ...view, image: () => null });
  expect(names(loading)).not.toContain("drawImage");
});

test("imageCache decodes only safe data URLs, once, and reports when ready", () => {
  const made = [], loaded = [];
  const files = { ok: { dataURL: "data:image/png;base64,iVBORw0KGgo=" }, bad: { dataURL: "javascript:alert(1)" } };
  const get = imageCache(() => files, id => loaded.push(id), () => { const i = {}; made.push(i); return i; });
  expect(get("bad")).toBeNull();
  expect(get("ok")).toBeNull();
  expect(get("ok")).toBeNull();
  expect(made.length).toBe(1);
  made[0].onload();
  expect(loaded).toEqual(["ok"]);
  expect(get("ok")).toBe(made[0]);
});

test("a whole Editor display list (shapes, fills, arrows, freedraw, text, labels, frame, image, selection) paints in both themes", () => {
  const els = [
    makeElement("rectangle", { id: "r", x: 0, y: 0, width: 100, height: 60, backgroundColor: "#ffc9c9" }),
    makeElement("ellipse", { id: "e", x: 150, y: 0, width: 80, height: 60, backgroundColor: "#b2f2bb", fillStyle: "hachure" }),
    makeElement("diamond", { id: "d", x: 300, y: 0, width: 80, height: 60, strokeStyle: "dashed" }),
    makeElement("arrow", { id: "a", x: 0, y: 100, points: [[0, 0], [120, 40]], endArrowhead: "triangle" }),
    makeElement("freedraw", { id: "p", x: 0, y: 200, points: [[0, 0], [10, 5], [20, 0], [30, 8]] }),
    makeElement("text", { id: "t", x: 200, y: 200, text: "hi\nthere", fontSize: 20 }),
    makeElement("text", { id: "l", x: 0, y: 0, text: "label", fontSize: 16, containerId: "r" }),
    makeElement("frame", { id: "f", x: -20, y: -40, width: 500, height: 300, name: "Slide" }),
    makeElement("image", { id: "i", x: 400, y: 150, width: 40, height: 40, fileId: "f1" }),
  ];
  els[0].boundElements = [{ id: "l", type: "text" }];
  const ed = new Editor({ scene: { elements: els, files: { f1: { mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=" } } } });
  ed.select(["r"]);
  for (const theme of [THEMES.light, THEMES.dark]) {
    const items = ed.displayList(theme);
    const kinds = new Set(items.map(i => i.t + (i.t === "path" ? (i.fill ? ":fill" : ":stroke") : "")));
    expect([...kinds].sort()).toEqual(["image", "path:fill", "path:stroke", "text"]);
    const ctx = fakeCtx(), img = {};
    paint(ctx, items, { ...view, dpr: 2, background: theme.bg, image: () => img });
    const n = names(ctx);
    expect(n.filter(x => x === "stroke").length).toBe(items.filter(i => i.t === "path" && !i.fill && i.cmds.length).length);
    expect(n.filter(x => x === "fill").length).toBe(items.filter(i => i.t === "path" && i.fill && i.cmds.length).length);
    expect(n.filter(x => x === "drawImage").length).toBe(1);
    expect(ctx.calls.filter(c => c[0] === "fillText").map(c => c[1])).toEqual(expect.arrayContaining(["hi", "there", "label", "Slide"]));
    expect(ctx.calls).toContainEqual(["=fillStyle", theme.bg]);
    // Default ink follows the theme.
    expect(ctx.calls).toContainEqual(["=strokeStyle", theme.fg]);
  }
});

test("a font class is looked up by own key only (L3)", () => {
  const ctx = fakeCtx();
  paint(ctx, [{ t: "text", x: 0, y: 0, text: "x", size: 10, color: "#000000", font: "constructor" }], view);
  expect(ctx.calls.find(c => c[0] === "=font")[1]).toMatch(/^10\.0px Helvetica/);
});

test("SVG data URLs never become pictures on the canvas (L4: they can taint it)", () => {
  const made = [];
  const get = imageCache(() => ({ s: { dataURL: "data:image/svg+xml;base64,PHN2Zz4=" } }), () => {}, () => { const i = {}; made.push(i); return i; });
  expect(get("s")).toBeNull();
  expect(made.length).toBe(0);
});

test("a stroke of width 0 or less is skipped, not drawn at the previous width (L6)", () => {
  const ctx = fakeCtx();
  paint(ctx, [
    { t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "#000000", width: 4 },
    { t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "#000000", width: 0 },
    { t: "path", cmds: [["M", 0, 0], ["L", 1, 1]], stroke: "#000000", width: -2 },
  ], view);
  expect(names(ctx).filter(n => n === "stroke").length).toBe(1);
});

test("#109: zero-dimension image/video/text items during scale/flip animations are skipped safely for WKWebView", () => {
  const ctx = fakeCtx();
  const img = { tag: "img" };
  paint(ctx, [
    { t: "image", fileId: "f1", x: 10, y: 10, w: 0, h: 40, angle: 0, cx: 10, cy: 30, opacity: 1 },
    { t: "image", fileId: "f1", x: 10, y: 10, w: 40, h: -5, angle: 0, cx: 30, cy: 10, opacity: 1 },
    { t: "video", fileId: "v1", x: 10, y: 10, w: 0, h: 40, angle: 0, cx: 10, cy: 30, opacity: 1 },
    { t: "text", x: 10, y: 10, text: "hi", size: 0, color: "#000000", align: "left", lineHeight: 1.25 },
  ], { ...view, image: () => img });
  expect(names(ctx)).not.toContain("drawImage");
  expect(names(ctx)).not.toContain("fillText");
  expect(names(ctx)).not.toContain("strokeRect");
});

test("#117: cropped image draws via 9-arg drawImage with natural-size scaling and safe clamping", () => {
  const ctx = fakeCtx();
  const img = { naturalWidth: 800, naturalHeight: 400 };
  paint(ctx, [{
    t: "image",
    fileId: "f1",
    x: 20, y: 30, w: 100, h: 50,
    angle: 0, cx: 70, cy: 55, opacity: 1,
    // Crop specified in 400x200 space -> scales 2x to actual 800x400 natural image
    crop: { x: 100, y: 50, width: 200, height: 100, naturalWidth: 400, naturalHeight: 200 },
  }], { ...view, image: () => img });
  expect(ctx.calls).toContainEqual(["drawImage", img, 200, 100, 400, 200, 20, 30, 100, 50]);
});

test("#117: clip rect uses pure save/beginPath/rect/clip/restore (WKWebView-safe, no ctx.filter)", () => {
  const ctx = fakeCtx();
  paint(ctx, [{
    t: "path",
    cmds: [["M", 10, 10], ["L", 110, 10], ["L", 110, 60]],
    fill: "#3B48E8",
    opacity: 1,
    clip: { x: 10, y: 10, w: 50, h: 50 },
  }], view);
  const c = ctx.calls;
  expect(c).toContainEqual(["rect", 10, 10, 50, 50]);
  expect(names(ctx)).toContain("clip");
  expect(names(ctx).indexOf("clip")).toBeLessThan(names(ctx).indexOf("fill"));
  expect(names(ctx).lastIndexOf("restore")).toBeGreaterThan(names(ctx).indexOf("fill"));
  expect(c.some(call => call[0] === "=filter")).toBe(false);

  // Rotated clip rect rotates, clips, then un-rotates before drawing so paths are not double-rotated
  const rctx = fakeCtx();
  paint(rctx, [{
    t: "path",
    cmds: [["M", 10, 10], ["L", 110, 10]],
    stroke: "#000000",
    width: 2,
    clip: { x: 10, y: 10, w: 50, h: 50, angle: 0.5, cx: 60, cy: 35 },
  }], view);
  const rots = rctx.calls.filter(call => call[0] === "rotate").map(call => call[1]);
  expect(rots).toEqual([0.5, -0.5]);
});

test("#117 Phase 2: blendMode scopes globalCompositeOperation inside save/restore with zero ctx.filter and no leak", () => {
  const ctx = fakeCtx();
  paint(ctx, [
    { t: "path", cmds: [["M", 0, 0], ["L", 50, 0], ["L", 50, 50]], fill: "#ff0000", opacity: 1, blendMode: "multiply" },
    { t: "path", cmds: [["M", 10, 10], ["L", 60, 10], ["L", 60, 60]], fill: "#00ff00", opacity: 1, blendMode: "normal" },
    { t: "path", cmds: [["M", 20, 20], ["L", 70, 20], ["L", 70, 70]], fill: "#0000ff", opacity: 1, blendMode: "evil; filter:blur(5px)" },
  ], view);
  const c = ctx.calls;
  const gcoCalls = c.filter(call => call[0] === "=globalCompositeOperation");
  expect(gcoCalls).toEqual([["=globalCompositeOperation", "multiply"]]);
  expect(c.some(call => call[0] === "=filter")).toBe(false);
  const n = names(ctx);
  const gcoIdx = n.indexOf("=globalCompositeOperation");
  const firstFill = n.indexOf("fill");
  const saveBefore = n.lastIndexOf("save", gcoIdx);
  const restoreAfter = n.indexOf("restore", firstFill);
  expect(saveBefore).toBeGreaterThan(-1);
  expect(saveBefore).toBeLessThan(gcoIdx);
  expect(restoreAfter).toBeGreaterThan(firstFill);
  expect(restoreAfter).toBeLessThan(n.indexOf("fill", firstFill + 1));
});

test("#117 Phase 2: clipShape traces vector mask via save/clip/restore, respects rotation and composes with wipe clip", () => {
  const img = { naturalWidth: 100, naturalHeight: 100 };
  const ctx = fakeCtx();
  paint(ctx, [{
    t: "image",
    fileId: "f1",
    x: 10, y: 20, w: 100, h: 80,
    angle: 0.4, cx: 60, cy: 60, opacity: 1,
    blendMode: "screen",
    clip: { x: 10, y: 20, w: 50, h: 80 },
    clipShape: { shape: "ellipse", x: 10, y: 20, w: 100, h: 80, angle: 0.4, cx: 60, cy: 60 },
  }], { ...view, image: () => img });
  const c = ctx.calls;
  const n = names(ctx);
  expect(c).toContainEqual(["=globalCompositeOperation", "screen"]);
  expect(n.filter(x => x === "clip").length).toBe(2); // wipe clip + shape clip
  expect(c.filter(call => call[0] === "quadraticCurveTo").length).toBe(16); // ellipse mask
  expect(c.filter(call => call[0] === "rotate").map(call => call[1])).toEqual([0.4, -0.4, 0.4]); // mask rot, unrot, image rot
  expect(n.filter(x => x === "save").length).toBe(n.filter(x => x === "restore").length);
  expect(n.indexOf("drawImage")).toBeGreaterThan(n.lastIndexOf("clip"));
  expect(c.some(call => call[0] === "=filter")).toBe(false);

  // Shorthand string clipShape on an image item also works
  const sctx = fakeCtx();
  paint(sctx, [{
    t: "image",
    fileId: "f1",
    x: 0, y: 0, w: 80, h: 60,
    angle: 0, cx: 40, cy: 30, opacity: 1,
    clipShape: "diamond",
  }], { ...view, image: () => img });
  expect(sctx.calls).toContainEqual(["moveTo", 40, 0]);
  expect(sctx.calls).toContainEqual(["lineTo", 80, 30]);
  expect(names(sctx)).toContain("clip");
});
