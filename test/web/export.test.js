// Issue #117 Phase 1: SVG & PNG export fidelity for cropped images, spliced grids, and wipe clip rects.
import { describe, test, expect } from "bun:test";
import { toSvg, exportSvg, paintPng, exportBounds, buildPrintHtml } from "../../web/adapters/dom/export.js";
import { Editor } from "../../packages/core/editor.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement } from "../../packages/core/model.js";

const SHA1 = "b".repeat(40);
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function fakeCanvas() {
  const calls = [];
  const state = {};
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k === "calls") return calls;
      if (k in t) return t[k];
      return (...args) => calls.push([k, ...args]);
    },
    set(t, k, v) { t[k] = v; calls.push(["=" + String(k), v]); return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx, ctx };
}

describe("SVG & PNG export with image crop and wipe clip", () => {
  test("uncropped image exports plain <image> with no <defs>", () => {
    const svg = toSvg(
      [{ t: "image", fileId: SHA1, x: 10, y: 20, w: 100, h: 80, angle: 0, cx: 60, cy: 60, opacity: 1 }],
      { width: 200, height: 200, files: { [SHA1]: { dataURL: DATA_URL } } },
    );
    expect(svg).not.toContain("<defs>");
    expect(svg).toContain('<image href="data:image/png;base64,iVBORw0KGgo=" x="10.0" y="20.0" width="100.0" height="80.0"');
  });

  test("cropped image exports <clipPath> and shifted full-size <image> matching Canvas2D crop math", () => {
    // Source 400x200, crop right half (x=200, y=0, w=200, h=200) into destination box (50, 40, 100, 100)
    // => scaleX = 0.5, scaleY = 0.5 => fullW = 200, fullH = 100, imgX = 50 - 200*0.5 = -50, imgY = 40
    const svg = toSvg(
      [{
        t: "image", fileId: SHA1, x: 50, y: 40, w: 100, h: 100, angle: 0, cx: 100, cy: 90, opacity: 1,
        crop: { x: 200, y: 0, width: 200, height: 200, naturalWidth: 400, naturalHeight: 200 },
      }],
      { width: 300, height: 200, files: { [SHA1]: { dataURL: DATA_URL } } },
    );
    expect(svg).toContain('<defs><clipPath id="pl-clip-1"><rect x="50.0" y="40.0" width="100.0" height="100.0"/></clipPath></defs>');
    expect(svg).toContain('clip-path="url(#pl-clip-1)"');
    expect(svg).toContain('x="-50.0" y="40.0" width="200.0" height="100.0"');
  });

  test("spliced image exports distinct clipPaths for every tile in SVG and 9-arg drawImage in 2x PNG", () => {
    const ed = new Editor();
    ed.setSize(800, 600);
    const id = ed.addImage({ id: SHA1, mimeType: "image/png", dataURL: DATA_URL, width: 200, height: 100 }, { x: 200, y: 150 });
    ed.spliceImage(id, { cols: 2, rows: 1, gap: 10 });

    const svg = exportSvg(ed.doc);
    expect(svg).toContain("pl-clip-1");
    expect(svg).toContain("pl-clip-2");
    expect((svg.match(/<image /g) ?? []).length).toBe(2);

    const canvas = fakeCanvas();
    const img = { naturalWidth: 200, naturalHeight: 100 };
    paintPng(ed.doc, canvas, { loadImage: () => img, scale: 2 });
    expect(canvas.ctx.calls[0]).toEqual(["setTransform", 2, 0, 0, 2, 0, 0]);
    const draws = canvas.ctx.calls.filter(c => c[0] === "drawImage");
    expect(draws.length).toBe(2);
    // 9-arg drawImage: ["drawImage", img, sx, sy, sw, sh, dx, dy, dw, dh] -> length 10
    expect(draws[0].length).toBe(10);
    expect(draws[1].length).toBe(10);
    expect(draws[0].slice(2, 6)).toEqual([0, 0, 100, 100]);
    expect(draws[1].slice(2, 6)).toEqual([100, 0, 100, 100]);
  });

  test("animated wipe clip rect exports via <clipPath> in toSvg", () => {
    const svg = toSvg(
      [{
        t: "path",
        cmds: [["M", 0, 0], ["L", 100, 0], ["L", 100, 50]],
        fill: "#0078d4",
        opacity: 1,
        clip: { x: 0, y: 0, w: 50, h: 50 },
      }],
      { width: 200, height: 100 },
    );
    expect(svg).toContain('<defs><clipPath id="pl-clip-1"><rect x="0.0" y="0.0" width="50.0" height="50.0"/></clipPath></defs>');
    expect(svg).toContain('<g clip-path="url(#pl-clip-1)"><path');
  });
});

describe("Issue #20: Single-frame SVG/PNG export & Print-to-PDF HTML", () => {
  function makeFramedDoc(extra = []) {
    const f1 = makeElement("frame", { id: "f1", x: 100, y: 50, width: 400, height: 300, name: "Intro Slide" });
    const f2 = makeElement("frame", { id: "f2", x: 700, y: 50, width: 500, height: 350, name: "Architecture" });
    const inside1 = makeElement("text", { id: "t1", x: 140, y: 100, width: 120, height: 25, text: "Hello Frame 1", frameId: "f1" });
    const inside2 = makeElement("text", { id: "t2", x: 740, y: 100, width: 120, height: 25, text: "Hello Frame 2", frameId: "f2" });
    const outside = makeElement("text", { id: "t3", x: 2000, y: 2000, width: 120, height: 25, text: "Outside Everything" });
    return new Doc({ elements: [f1, f2, inside1, inside2, outside, ...extra] });
  }

  test("exportBounds returns tight frame rect for valid frameId and null for missing/non-frame IDs", () => {
    const doc = makeFramedDoc();
    expect(exportBounds(doc, { frameId: "f1" })).toEqual({ x: 100, y: 50, w: 400, h: 300, frameId: "f1", name: "Intro Slide" });
    expect(exportBounds(doc, { frameId: "missing" })).toBeNull();
    expect(exportBounds(doc, { frameId: "t1" })).toBeNull();
    const whole = exportBounds(doc);
    expect(whole.w).toBeGreaterThan(1000);
  });

  test("exportSvg and paintPng with { frameId } crop tightly to that frame and exclude outside elements", () => {
    const doc = makeFramedDoc();
    const svg = exportSvg(doc, { frameId: "f1", scale: 1 });
    expect(svg).toContain('width="400" height="300" viewBox="0 0 400 300"');
    expect(svg).toContain("Hello Frame 1");
    expect(svg).not.toContain("Hello Frame 2");
    expect(svg).not.toContain("Outside Everything");
    expect(svg).not.toContain("Intro Slide"); // frame label itself is excluded
    expect(svg).toContain("<clipPath");

    const canvas = fakeCanvas();
    paintPng(doc, canvas, { frameId: "f2", scale: 2 });
    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(700);
  });

  test("toSvg accepts { frameId, doc } to crop viewBox directly to frame bounds", () => {
    const doc = makeFramedDoc();
    const svg = toSvg(
      [{ t: "text", x: 140, y: 100, text: "In Frame", size: 16, color: "#18181B", opacity: 1 }],
      { frameId: "f1", doc, scale: 1 },
    );
    expect(svg).toContain('width="400" height="300" viewBox="100 50 400 300"');
    expect(svg).toContain("<clipPath");
  });

  test("buildPrintHtml outputs landscape @page rules, one crisp SVG per frame, and is XSS-safe", () => {
    // Inject XSS payloads into frame name and text element
    const xssFrame = makeElement("frame", {
      id: "fx",
      x: 100,
      y: 500,
      width: 320,
      height: 240,
      name: 'Evil"><script>alert(1)</script>',
    });
    const xssText = makeElement("text", {
      id: "tx",
      x: 120,
      y: 540,
      width: 200,
      height: 30,
      text: "<img src=x onerror=alert(1)>",
      frameId: "fx",
    });
    const doc = makeFramedDoc([xssFrame, xssText]);

    const html = buildPrintHtml(doc, {
      theme: "light",
      frameIds: ["f2", "fx"],
      title: "</title><script>alert(2)</script>",
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("@page { size: landscape; margin: 0; }");
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect((html.match(/<section class="print-page"/g) ?? []).length).toBe(2);
    expect((html.match(/<svg /g) ?? []).length).toBe(2);
    // Order matches frameIds: f2 before fx
    expect(html.indexOf("Hello Frame 2")).toBeGreaterThan(-1);
    expect(html.indexOf("Hello Frame 1")).toBe(-1);
    // Strict XSS safety: zero raw <script> tags or unescaped HTML injection
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("buildPrintHtml falls back to a single board page when board has no frames", () => {
    const doc = new Doc({
      elements: [makeElement("text", { id: "t0", x: 20, y: 20, width: 100, height: 24, text: "Solo Note" })],
    });
    const html = buildPrintHtml(doc, { theme: "dark" });
    expect((html.match(/<section class="print-page"/g) ?? []).length).toBe(1);
    expect(html).toContain("Solo Note");
  });
});

describe("Issue #117 Phase 2: Shape clipping masks & blend modes export parity (SVG & PNG)", () => {
  test("toSvg emits <clipPath> for clipShape (with rotation) and mix-blend-mode for allowlisted blendMode", () => {
    const svg = toSvg(
      [{
        t: "image",
        fileId: SHA1,
        x: 10, y: 20, w: 100, h: 60,
        angle: Math.PI / 4, cx: 60, cy: 50, opacity: 1,
        blendMode: "multiply",
        clipShape: { shape: "diamond", x: 10, y: 20, w: 100, h: 60, angle: Math.PI / 4, cx: 60, cy: 50 },
      }],
      { width: 200, height: 200, files: { [SHA1]: { dataURL: DATA_URL } } },
    );
    expect(svg).toContain('<clipPath id="pl-clip-1"><path d="M60.0 20.0L110.0 50.0L60.0 80.0L10.0 50.0Z" transform="rotate(45.00 60.0 50.0)"/></clipPath>');
    expect(svg).toContain('<g style="mix-blend-mode: multiply"><g clip-path="url(#pl-clip-1)"><image');
  });

  test("toSvg rejects untrusted/CSS-injection blendMode values and omits mix-blend-mode for normal", () => {
    const svg = toSvg(
      [
        { t: "path", cmds: [["M", 0, 0], ["L", 40, 0], ["L", 40, 40]], fill: "#ff0000", opacity: 1, blendMode: "normal" },
        { t: "path", cmds: [["M", 0, 0], ["L", 40, 0], ["L", 40, 40]], fill: "#00ff00", opacity: 1, blendMode: 'multiply; background:url(javascript:alert(1))' },
        { t: "path", cmds: [["M", 0, 0], ["L", 40, 0], ["L", 40, 40]], fill: "#0000ff", opacity: 1, blendMode: 'overlay" onload="alert(1)' },
      ],
      { width: 100, height: 100 },
    );
    expect(svg).not.toContain("mix-blend-mode");
    expect(svg).not.toContain("javascript:");
    expect(svg).not.toContain("onload");
  });

  test("exportSvg and paintPng achieve full parity for Doc elements with customData.effects", () => {
    const imgEl = makeElement("image", {
      id: "img1",
      x: 20, y: 20, width: 120, height: 80,
      fileId: SHA1,
      customData: { effects: { blendMode: "overlay", clipShape: "ellipse" } },
    });
    const rectEl = makeElement("rectangle", {
      id: "rect1",
      x: 40, y: 40, width: 100, height: 60,
      backgroundColor: "#3B48E8",
      customData: { effects: { blendMode: "difference", clipShape: "rounded", clipRadius: 10 } },
    });
    const doc = new Doc({
      elements: [imgEl, rectEl],
      files: { [SHA1]: { id: SHA1, mimeType: "image/png", dataURL: DATA_URL } },
    });

    const svg = exportSvg(doc, { scale: 1 });
    expect(svg).toContain('style="mix-blend-mode: overlay"');
    expect(svg).toContain('style="mix-blend-mode: difference"');
    expect(svg).toContain("<clipPath id=\"pl-clip-1\"><path d=\"");
    expect(svg).toContain("<clipPath id=\"pl-clip-2\"><path d=\"");

    const canvas = fakeCanvas();
    const img = { naturalWidth: 120, naturalHeight: 80 };
    paintPng(doc, canvas, { loadImage: () => img, scale: 2 });
    const gcos = canvas.ctx.calls.filter(c => c[0] === "=globalCompositeOperation").map(c => c[1]);
    expect(gcos).toContain("overlay");
    expect(gcos).toContain("difference");
    expect(canvas.ctx.calls.filter(c => c[0] === "clip").length).toBeGreaterThanOrEqual(2);
    expect(canvas.ctx.calls.some(c => c[0] === "=filter")).toBe(false);
  });
});
