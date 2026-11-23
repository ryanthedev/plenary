// @ts-check
// Tests for #25 Interactive Example Boards, Templates Gallery (packages/core/templates.js),
// and the upgraded Plenary animated demo (packages/core/demo.js).

import { describe, test, expect } from "bun:test";
import { TEMPLATES, TEMPLATE_IDS, getTemplate, buildTemplateScene } from "../../packages/core/templates.js";
import { demoScene } from "../../packages/core/demo.js";
import { opProblem, utf8Bytes } from "../../packages/protocol/envelope.js";
import { Doc } from "../../packages/core/doc.js";
import { animState, getPreset, timelineEnd } from "../../packages/core/anim.js";
import { parseLinkCardFromElement } from "../../packages/core/link-card.js";
import { listNamedFrames, viewsOf } from "../../packages/core/views.js";
import { bbox } from "../../packages/core/geometry.js";
import { isLabel, isShape, layerOf } from "../../packages/core/model.js";

const MAX_TEMPLATE_JSON_BYTES = 100 * 1024;

function boxesOverlap(a, b, pad = 0) {
  return a.x + pad < b.x + b.w && a.x + a.w > b.x + pad && a.y + pad < b.y + b.h && a.y + a.h > b.y + pad;
}

describe("packages/core/templates.js", () => {
  test("exports all 5 required templates with valid metadata", () => {
    expect(TEMPLATE_IDS).toEqual([
      "plenary-tour",
      "architecture",
      "presentation",
      "retro",
      "animation-playground",
    ]);
    for (const meta of TEMPLATES) {
      expect(meta.id.length).toBeGreaterThan(0);
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.boardTitle.length).toBeGreaterThan(0);
      expect(meta.desc.length).toBeGreaterThan(0);
      expect(getTemplate(meta.id)).toEqual(meta);
    }
    // Legacy alias resolution
    expect(getTemplate("deck")?.id).toBe("presentation");
    expect(getTemplate("nonexistent")).toBeNull();
  });

  test("blank and unknown template ids behave cleanly", () => {
    const blank = buildTemplateScene("blank");
    expect(blank).toBeTruthy();
    expect(blank.elements).toEqual([]);
    expect(blank.files).toEqual({});
    expect(buildTemplateScene("does-not-exist")).toBeNull();
  });

  for (const id of TEMPLATE_IDS) {
    test(`template "${id}" passes Protocol v1.1 opProblem, size < 100 KB, referential integrity, and non-overlapping layout`, () => {
      const scene = buildTemplateScene(id);
      expect(scene).toBeTruthy();
      expect(scene.type).toBe("excalidraw");
      expect(scene.version).toBe(2);
      expect(Array.isArray(scene.elements)).toBe(true);
      expect(scene.elements.length).toBeGreaterThan(0);
      expect(scene.files).toEqual({});

      // JSON payload size well under 100 KB
      const jsonBytes = utf8Bytes(JSON.stringify(scene));
      expect(jsonBytes).toBeLessThan(MAX_TEMPLATE_JSON_BYTES);

      // Protocol v1.1 opProblem validation for elements op
      const elementsProblem = opProblem({
        t: "op",
        stream: "board",
        id: "c1:1",
        sentAt: 0,
        op: { elements: scene.elements },
      });
      expect(elementsProblem).toBeNull();

      // Protocol v1.1 opProblem validation for appState.herdr op
      const herdr = scene.appState.herdr;
      const appBase = Object.fromEntries(Object.keys(herdr).map(k => [k, 0]));
      const settingsProblem = opProblem({
        t: "op",
        stream: "board",
        id: "c1:2",
        sentAt: 0,
        op: { appState: herdr, appBase },
      });
      expect(settingsProblem).toBeNull();

      // Unique element ids & valid layer references
      const byId = new Map();
      const layerIds = new Set(herdr.layers.map(l => l.id));
      for (const el of scene.elements) {
        expect(byId.has(el.id)).toBe(false);
        byId.set(el.id, el);
        expect(layerIds.has(layerOf(el))).toBe(true);
        if (el.customData?.anim?.preset) {
          expect(getPreset(el.customData.anim.preset)).toBeTruthy();
          expect(animState(el, 0)).toBeTruthy();
        }
      }

      // Referential integrity for bindings, labels, and views
      for (const el of scene.elements) {
        if (el.containerId) {
          const host = byId.get(el.containerId);
          expect(host).toBeTruthy();
          expect(host.boundElements?.some(b => b.id === el.id && b.type === "text")).toBe(true);
        }
        if (el.startBinding) {
          const target = byId.get(el.startBinding.elementId);
          expect(target).toBeTruthy();
          expect(target.boundElements?.some(b => b.id === el.id && b.type === "arrow")).toBe(true);
        }
        if (el.endBinding) {
          const target = byId.get(el.endBinding.elementId);
          expect(target).toBeTruthy();
          expect(target.boundElements?.some(b => b.id === el.id && b.type === "arrow")).toBe(true);
        }
      }

      const doc = new Doc(scene);
      const frameIds = new Set(listNamedFrames(doc).map(f => f.id));
      const views = viewsOf(doc);
      expect(views.length).toBeGreaterThan(0);
      const defaultActiveLayerId = herdr.layers[herdr.layers.length - 1].id;
      for (const v of views) {
        if (v.frameId) expect(frameIds.has(v.frameId)).toBe(true);
        if (Array.isArray(v.visibleLayers)) {
          for (const lid of v.visibleLayers) expect(layerIds.has(lid)).toBe(true);
          // Default active layer (Editor uses layers.at(-1)) must remain visible in every view
          expect(v.visibleLayers).toContain(defaultActiveLayerId);
        }
      }

      // Layout check: no overlapping non-frame shapes or standalone text across ANY layer
      const layoutItems = scene.elements.filter(
        el => (isShape(el) && el.type !== "frame") || (el.type === "text" && !isLabel(el)),
      );
      for (let i = 0; i < layoutItems.length; i++) {
        for (let j = i + 1; j < layoutItems.length; j++) {
          expect(boxesOverlap(bbox(layoutItems[i]), bbox(layoutItems[j]))).toBe(false);
        }
      }

      // Frames never overlap each other
      const frames = scene.elements.filter(el => el.type === "frame");
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) {
          expect(boxesOverlap(bbox(frames[i]), bbox(frames[j]))).toBe(false);
        }
      }
    });
  }

  test("plenary-tour has 4 named frames, 3 layers, Named Views, animations, and GitHub/Linear/ADO link cards", () => {
    const scene = buildTemplateScene("plenary-tour");
    const doc = new Doc(scene);
    expect(listNamedFrames(doc).map(f => f.name)).toEqual([
      "1. Welcome",
      "2. Perimeter Bindings",
      "3. Layers & Views",
      "4. Animations & Collab",
    ]);
    expect(scene.appState.herdr.layers.map(l => l.id)).toEqual(["callouts", "annotations", "base"]);
    expect(viewsOf(doc).length).toBeGreaterThanOrEqual(4);

    const presets = new Set(scene.elements.map(e => e.customData?.anim?.preset).filter(Boolean));
    for (const p of ["pop", "draw", "dissolve-in", "wipe-right"]) expect(presets.has(p)).toBe(true);

    const providers = new Set(
      scene.elements.map(parseLinkCardFromElement).filter(Boolean).map(c => c.provider),
    );
    expect(providers).toEqual(new Set(["github", "linear", "ado"]));
  });

  test("architecture has Overview/Infra/Observability layers, progressive views, bound arrows, and link cards", () => {
    const scene = buildTemplateScene("architecture");
    expect(scene.appState.herdr.layers.map(l => l.name)).toEqual(["Observability", "Infra Details", "Overview"]);
    expect(scene.appState.herdr.views.length).toBe(3);
    const boundArrows = scene.elements.filter(e => e.type === "arrow" && e.startBinding && e.endBinding);
    expect(boundArrows.length).toBeGreaterThanOrEqual(5);
    const cards = scene.elements.map(parseLinkCardFromElement).filter(Boolean);
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  test("presentation has 3 16:9 frames and Named Views ready for Presentation Mode", () => {
    const scene = buildTemplateScene("presentation");
    const doc = new Doc(scene);
    const frames = listNamedFrames(doc);
    expect(frames.map(f => f.name)).toEqual(["Title", "Problem & Architecture", "Next Steps"]);
    for (const f of frames) {
      expect(Math.round((f.bounds.w / f.bounds.h) * 100)).toBe(Math.round((16 / 9) * 100));
    }
    expect(viewsOf(doc).length).toBeGreaterThanOrEqual(3);
  });

  test("retro has 3 framed columns and starter sticky cards", () => {
    const scene = buildTemplateScene("retro");
    const doc = new Doc(scene);
    expect(listNamedFrames(doc).map(f => f.name)).toEqual([
      "What went well",
      "What to improve",
      "Action items",
    ]);
    const stickies = scene.elements.filter(e => e.type === "rectangle" && layerOf(e) === "stickies");
    expect(stickies.length).toBe(9);
  });

  test("animation-playground showcases pop, fade, draw, dissolve-in, wipe-right, and wipe-down presets", () => {
    const scene = buildTemplateScene("animation-playground");
    const presets = new Set(scene.elements.map(e => e.customData?.anim?.preset).filter(Boolean));
    for (const p of ["pop", "fade", "draw", "dissolve-in", "wipe-right", "wipe-down"]) {
      expect(presets.has(p)).toBe(true);
    }
    expect(timelineEnd(scene.elements)).toBeGreaterThan(2000);
  });

  test("buildTemplateScene produces fresh unique element IDs on every call", () => {
    const a = buildTemplateScene("retro");
    const b = buildTemplateScene("retro");
    const aIds = new Set(a.elements.map(e => e.id));
    for (const el of b.elements) expect(aIds.has(el.id)).toBe(false);
  });
});

describe("packages/core/demo.js (upgraded Plenary tour)", () => {
  test("demoScene() returns a valid Plenary tour with zero herdr-draw branding and passes opProblem", () => {
    const scene = demoScene();
    expect(scene.type).toBe("excalidraw");
    expect(scene.source).toBe("plenary");
    expect(scene.elements.length).toBeGreaterThan(10);

    const allText = scene.elements.filter(e => e.type === "text").map(e => e.text).join("\n");
    expect(allText).toContain("Plenary");
    expect(allText.toLowerCase()).not.toContain("herdr-draw");

    const problem = opProblem({
      t: "op",
      stream: "board",
      id: "c1:1",
      sentAt: 0,
      op: { elements: scene.elements },
    });
    expect(problem).toBeNull();

    const herdr = scene.appState.herdr;
    const appBase = Object.fromEntries(Object.keys(herdr).map(k => [k, 0]));
    expect(opProblem({ t: "op", stream: "board", id: "c1:2", sentAt: 0, op: { appState: herdr, appBase } })).toBeNull();

    // Includes at least one rich link card and valid animations
    const cards = scene.elements.map(parseLinkCardFromElement).filter(Boolean);
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(timelineEnd(scene.elements)).toBeGreaterThan(3000);
  });
});
