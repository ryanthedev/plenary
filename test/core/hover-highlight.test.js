import { describe, test, expect } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { makeElement } from "../../packages/core/model.js";
import { bbox, bounds, toWorld } from "../../packages/core/geometry.js";
import { hoverPadWorld, paintHoverHighlight, project } from "../../packages/core/render.js";
import { buildLinkCard, parseLinkCardUrl } from "../../packages/core/link-card.js";
import { LIGHT, DARK } from "../../packages/core/export.js";

function cmdPoints(cmds) {
  return cmds.map(c => [c[1], c[2]]);
}

function alphaOf(hex) {
  if (typeof hex !== "string" || hex.length !== 9) return 1;
  return parseInt(hex.slice(7, 9), 16) / 255;
}

describe("hover highlight (#111): crisp outward border for all shapes in dark & light mode", () => {
  test("rough white rectangle on dark mode gets crisp high-contrast outward halo + outline beyond stroke & roughness", () => {
    const rect = makeElement("rectangle", {
      id: "r1",
      x: 100,
      y: 80,
      width: 140,
      height: 90,
      strokeColor: "#F4F4F5",
      strokeWidth: 4,
      roughness: 2,
    });
    const ed = new Editor({ scene: { elements: [rect] } });
    ed.view = { x: 0, y: 0, scale: 1 };
    ed.pointerMove({ x: 100, y: 80 }); // hover top-left edge of rectangle
    expect(ed.hover).toBe("r1");

    for (const [name, theme] of [["dark", DARK], ["light", LIGHT]]) {
      const items = ed.displayList(theme);
      const halo = items.find(it => it.id === "hover:halo");
      const outline = items.find(it => it.id === "hover:outline");
      expect(halo).toBeDefined();
      expect(outline).toBeDefined();

      // High-contrast crisp accent stroke + softer halo
      expect(outline.width).toBeGreaterThanOrEqual(1.5);
      expect(halo.width).toBeGreaterThan(outline.width);
      expect(alphaOf(outline.stroke)).toBeGreaterThanOrEqual(0.85);
      expect(alphaOf(halo.stroke)).toBeGreaterThan(0.15);
      expect(alphaOf(halo.stroke)).toBeLessThan(alphaOf(outline.stroke));
      expect(outline.stroke.slice(0, 7).toLowerCase()).toBe(theme.accent.toLowerCase());
      if (name === "dark") expect(alphaOf(outline.stroke)).toBeGreaterThan(0.9);

      // Outward clearance strictly outside bbox + strokeWidth/2 + roughness
      const pts = cmdPoints(outline.cmds);
      expect(pts.length).toBe(5);
      expect(pts[0]).toEqual(pts[4]); // closed polygon
      const xs = pts.map(p => p[0]);
      const ys = pts.map(p => p[1]);
      const pad = hoverPadWorld(rect, 1);
      expect(pad).toBeGreaterThanOrEqual(5 + rect.strokeWidth / 2);
      expect(Math.min(...xs)).toBeCloseTo(100 - pad, 5);
      expect(Math.max(...xs)).toBeCloseTo(240 + pad, 5);
      expect(Math.min(...ys)).toBeCloseTo(80 - pad, 5);
      expect(Math.max(...ys)).toBeCloseTo(170 + pad, 5);
    }
  });

  test("outward offset scales cleanly with zoom (0.5x, 1x, 2x)", () => {
    const rect = makeElement("rectangle", {
      id: "r1",
      x: 50,
      y: 50,
      width: 100,
      height: 60,
      strokeWidth: 2,
      roughness: 0,
    });
    const ed = new Editor({ scene: { elements: [rect] } });
    for (const scale of [0.5, 1, 2]) {
      ed.view = { x: 0, y: 0, scale };
      ed.hover = "r1";
      const outline = ed.displayList(DARK).find(it => it.id === "hover:outline");
      const pts = cmdPoints(outline.cmds);
      const minX = Math.min(...pts.map(p => p[0]));
      const shapeScreenMinX = 50 * scale;
      // Screen-space clearance outside stroke edge is at least 5 screen px at every zoom
      const strokeHalfScreen = (rect.strokeWidth / 2) * scale;
      expect(shapeScreenMinX - minX).toBeCloseTo(5 + strokeHalfScreen, 4);
    }
  });

  test("rotated shapes (rectangle, diamond, ellipse, image, text) rotate their hover border cleanly around center", () => {
    const angle = Math.PI / 4; // 45 degrees
    const shapes = [
      makeElement("rectangle", { id: "rot-r", x: 100, y: 100, width: 120, height: 60, angle, strokeWidth: 2, roughness: 1 }),
      makeElement("diamond", { id: "rot-d", x: 300, y: 100, width: 100, height: 80, angle: Math.PI / 6, strokeWidth: 2, roughness: 1 }),
      makeElement("ellipse", { id: "rot-e", x: 500, y: 100, width: 110, height: 70, angle: -Math.PI / 3, strokeWidth: 2, roughness: 1 }),
      makeElement("image", { id: "rot-i", x: 100, y: 300, width: 100, height: 80, angle, fileId: "f1" }),
      makeElement("text", { id: "rot-t", x: 300, y: 300, width: 90, height: 28, text: "Hello", fontSize: 20, angle: Math.PI / 5 }),
    ];
    const ed = new Editor({ scene: { elements: shapes } });
    ed.view = { x: 10, y: 20, scale: 1.5 };
    const P = project(ed.view);

    for (const el of shapes) {
      ed.hover = el.id;
      const outline = ed.displayList(DARK).find(it => it.id === "hover:outline");
      expect(outline).toBeDefined();

      const pts = cmdPoints(outline.cmds);
      expect(pts.length).toBe(5);
      expect(pts[0][0]).toBeCloseTo(pts[4][0], 5);
      expect(pts[0][1]).toBeCloseTo(pts[4][1], 5);

      const b = bbox(el);
      const pad = hoverPadWorld(el, ed.view.scale);
      const expected = [
        [b.x - pad, b.y - pad],
        [b.x + b.w + pad, b.y - pad],
        [b.x + b.w + pad, b.y + b.h + pad],
        [b.x - pad, b.y + b.h + pad],
      ].map(([x, y]) => {
        const w = toWorld(el, { x, y });
        return P(w.x, w.y);
      });

      for (let i = 0; i < 4; i++) {
        expect(pts[i][0]).toBeCloseTo(expected[i][0], 4);
        expect(pts[i][1]).toBeCloseTo(expected[i][1], 4);
      }

      // Adjacent edges must remain orthogonal and have exact padded lengths
      const v1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
      const v2 = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]];
      expect(v1[0] * v2[0] + v1[1] * v2[1]).toBeCloseTo(0, 3);
      expect(Math.hypot(v1[0], v1[1])).toBeCloseTo((b.w + 2 * pad) * ed.view.scale, 3);
      expect(Math.hypot(v2[0], v2[1])).toBeCloseTo((b.h + 2 * pad) * ed.view.scale, 3);
    }
  });

  test("works for diamonds, ellipses, frames, images, link cards, text, and curved arrows", () => {
    const linkCard = buildLinkCard(parseLinkCardUrl("https://github.com/acme/plenary/issues/111"), { x: 400, y: 260 });
    const elements = [
      makeElement("diamond", { id: "d1", x: 10, y: 10, width: 100, height: 80 }),
      makeElement("ellipse", { id: "e1", x: 140, y: 10, width: 100, height: 70 }),
      makeElement("frame", { id: "f1", x: 260, y: 10, width: 200, height: 140, name: "Slide" }),
      makeElement("image", { id: "i1", x: 10, y: 140, width: 120, height: 90, fileId: "img1" }),
      makeElement("text", { id: "t1", x: 160, y: 140, width: 80, height: 24, text: "Note", fontSize: 20 }),
      makeElement("arrow", { id: "a1", x: 10, y: 260, points: [[0, 0], [80, -35], [160, 0]], roundness: { type: 2 }, endArrowhead: "arrow" }),
      linkCard,
    ];
    const ed = new Editor({ scene: { elements } });
    ed.view = { x: 0, y: 0, scale: 1 };

    for (const el of elements) {
      ed.hover = el.id;
      const out = [];
      paintHoverHighlight(ed.doc, el, ed.view, DARK, out);
      expect(out.map(i => i.id)).toEqual(["hover:halo", "hover:outline"]);
      const pts = cmdPoints(out[1].cmds);
      const b = bounds(el, ed.doc);
      const pad = hoverPadWorld(el, 1);
      expect(Math.min(...pts.map(p => p[0]))).toBeCloseTo(b.x - pad, 4);
      expect(Math.max(...pts.map(p => p[0]))).toBeCloseTo(b.x + b.w + pad, 4);
      expect(Math.min(...pts.map(p => p[1]))).toBeCloseTo(b.y - pad, 4);
      expect(Math.max(...pts.map(p => p[1]))).toBeCloseTo(b.y + b.h + pad, 4);
    }
  });

  test("selected elements and playback mode suppress hover highlight", () => {
    const rect = makeElement("rectangle", {
      id: "r1",
      x: 50,
      y: 50,
      width: 100,
      height: 60,
      customData: { anim: { preset: "fade", start: 0, duration: 600 } },
    });
    const ed = new Editor({ scene: { elements: [rect] } });
    ed.hover = "r1";
    expect(ed.displayList(DARK).some(it => it.id === "hover:outline")).toBe(true);

    // Selected: no hover outline
    ed.select(["r1"]);
    expect(ed.displayList(DARK).some(it => it.id === "hover:outline")).toBe(false);

    // Unselected during playback: no hover outline
    ed.select([]);
    ed.playToggle();
    expect(ed.displayList(DARK).some(it => it.id === "hover:outline")).toBe(false);
  });
});
