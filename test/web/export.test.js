// Issue #117 Phase 1: SVG & PNG export fidelity for cropped images, spliced grids, and wipe clip rects.
import { describe, test, expect } from "bun:test";
import { toSvg, exportSvg, paintPng } from "../../web/adapters/dom/export.js";
import { Editor } from "../../packages/core/editor.js";

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
