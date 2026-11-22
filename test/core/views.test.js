// Pure model tests for Named Jump-to-Frame, Local Solo Layer & Named Presentation Views (#115).
import { describe, test, expect } from "bun:test";
import { Doc } from "../../packages/core/doc.js";
import { emptyScene, makeElement, BASE_LAYER } from "../../packages/core/model.js";
import { spatialIndex } from "../../packages/core/spatial.js";
import {
  MAX_VIEWS,
  normalizeView,
  listNamedFrames,
  filterFramesAndViews,
  viewsOf,
  addView,
  deleteView,
  reorderViews,
  resolveLocalLayers,
  captureCurrentView,
  stepViewIndex,
} from "../../packages/core/views.js";

function makeBoardDoc() {
  const scene = emptyScene();
  scene.appState.herdr.layers = [
    { id: BASE_LAYER, name: "Base Network", visible: true, locked: false, opacity: 100 },
    { id: "auth", name: "Auth Overlay", visible: true, locked: false, opacity: 100 },
    { id: "failover", name: "Failover Path", visible: false, locked: false, opacity: 100 },
  ];
  const doc = new Doc(scene);
  doc.apply({
    elements: [
      makeElement("frame", { id: "f-b", x: 500, y: 10, width: 400, height: 300, name: "Auth Flow" }),
      makeElement("frame", { id: "f-a", x: 20, y: 25, width: 400, height: 300, name: "Overview" }),
      makeElement("frame", { id: "f-c", x: 20, y: 400, width: 400, height: 300, name: null }),
      makeElement("frame", { id: "f-del", x: 0, y: 0, width: 100, height: 100, name: "Deleted", isDeleted: true }),
      makeElement("rectangle", { id: "r-base", x: 40, y: 40, width: 80, height: 50, customData: { layer: BASE_LAYER, z: 1 } }),
      makeElement("rectangle", { id: "r-auth", x: 60, y: 60, width: 80, height: 50, customData: { layer: "auth", z: 1 } }),
      makeElement("rectangle", { id: "r-fail", x: 80, y: 80, width: 80, height: 50, customData: { layer: "failover", z: 1 } }),
    ],
  }, { force: true });
  return doc;
}

describe("listNamedFrames", () => {
  test("returns live frames in reading order with friendly fallback names and bounds", () => {
    const doc = makeBoardDoc();
    const frames = listNamedFrames(doc);
    expect(frames.map(f => [f.id, f.name, f.index])).toEqual([
      ["f-a", "Overview", 0],
      ["f-b", "Auth Flow", 1],
      ["f-c", "Untitled frame", 2],
    ]);
    expect(frames[0].bounds).toEqual({ x: 20, y: 25, w: 400, h: 300 });
    expect(frames[0].layerId).toBe(BASE_LAYER);
  });

  test("keeps frames discoverable even when their layer is locally hidden", () => {
    const doc = makeBoardDoc();
    doc.setLocalLayerFilter(id => id === "auth");
    expect(listNamedFrames(doc).map(f => f.id)).toEqual(["f-a", "f-b", "f-c"]);
  });
});

describe("filterFramesAndViews", () => {
  const frames = [
    { id: "f1", name: "Edge Auth Gateway", rawName: "Edge Auth Gateway", index: 0, layerId: BASE_LAYER, bounds: { x: 0, y: 0, w: 100, h: 100 } },
    { id: "f2", name: "Auth Overview", rawName: "Auth Overview", index: 1, layerId: BASE_LAYER, bounds: { x: 0, y: 0, w: 100, h: 100 } },
    { id: "f3", name: "Billing", rawName: "Billing", index: 2, layerId: BASE_LAYER, bounds: { x: 0, y: 0, w: 100, h: 100 } },
  ];
  const views = [
    { id: "v1", name: "Base + Auth Overlay", frameId: "f1", visibleLayers: [BASE_LAYER, "auth"] },
    { id: "v2", name: "Auth Deep Dive", frameId: "f2", visibleLayers: ["auth"] },
    { id: "v3", name: "Failover Drill", frameId: null, visibleLayers: [BASE_LAYER, "failover"] },
  ];

  test("empty query returns all frames and views in order", () => {
    const res = filterFramesAndViews("   ", { frames, views });
    expect(res.frames.map(f => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(res.views.map(v => v.id)).toEqual(["v1", "v2", "v3"]);
  });

  test("case-insensitive search ranks prefix matches ahead of inner substring matches", () => {
    const res = filterFramesAndViews("AUTH", { frames, views });
    expect(res.frames.map(f => f.id)).toEqual(["f2", "f1"]);
    expect(res.views.map(v => v.id)).toEqual(["v2", "v1"]);
  });
});

describe("viewsOf / addView / deleteView / reorderViews", () => {
  test("purely manages views in appState.herdr.views without mutating doc", () => {
    const doc = makeBoardDoc();
    expect(viewsOf(doc)).toEqual([]);

    const after1 = addView(doc, { id: "v1", name: "Base + Auth", frameId: "f-a", visibleLayers: [BASE_LAYER, "auth"] });
    expect(viewsOf(doc)).toEqual([]); // doc not mutated!
    expect(after1).toEqual([{ id: "v1", name: "Base + Auth", frameId: "f-a", visibleLayers: [BASE_LAYER, "auth"] }]);

    doc.apply({ appState: { views: after1 } });
    const after2 = addView(doc, { id: "v2", name: "Failover", frameId: "f-b", visibleLayerIds: [BASE_LAYER, "failover"] });
    doc.apply({ appState: { views: after2 } });
    expect(viewsOf(doc).map(v => v.id)).toEqual(["v1", "v2"]);
    expect(viewsOf(doc)[1].visibleLayers).toEqual([BASE_LAYER, "failover"]);

    const reordered = reorderViews(doc, ["v2", "unknown", "v1"]);
    expect(reordered.map(v => v.id)).toEqual(["v2", "v1"]);
    // Omitted views are preserved at the end
    expect(reorderViews(doc, ["v2"]).map(v => v.id)).toEqual(["v2", "v1"]);

    const deleted = deleteView(doc, "v1");
    expect(deleted.map(v => v.id)).toEqual(["v2"]);
    expect(viewsOf(doc).map(v => v.id)).toEqual(["v1", "v2"]); // doc still untouched
  });

  test("normalizes control chars, deduplicates visibleLayers, and bounds MAX_VIEWS", () => {
    const clean = normalizeView({ id: "v1", name: "  Hello\u202EWorld\n  ", frameId: "", visibleLayers: ["a", "a", "", "b"] });
    expect(clean).toEqual({ id: "v1", name: "HelloWorld", frameId: null, visibleLayers: ["a", "b"] });

    const doc = makeBoardDoc();
    const many = Array.from({ length: MAX_VIEWS + 15 }, (_, i) => ({ id: `v${i}`, name: `View ${i}`, frameId: null, visibleLayers: null }));
    doc.apply({ appState: { views: many } });
    expect(viewsOf(doc).length).toBe(MAX_VIEWS);
  });
});

describe("resolveLocalLayers & Doc local layer filter guardrail", () => {
  test("NEVER mutates boardLayers (verified with Object.freeze) across solo and view modes", () => {
    const boardLayers = Object.freeze([
      Object.freeze({ id: BASE_LAYER, name: "Base", visible: true, locked: false, opacity: 100 }),
      Object.freeze({ id: "auth", name: "Auth", visible: true, locked: false, opacity: 100 }),
      Object.freeze({ id: "failover", name: "Failover", visible: false, locked: false, opacity: 100 }),
    ]);
    const views = [
      { id: "v-fail", name: "Base + Failover", frameId: null, visibleLayers: [BASE_LAYER, "failover"] },
      { id: "v-frame", name: "Frame Only", frameId: "f-a", visibleLayers: null },
    ];

    // Default board mode
    const def = resolveLocalLayers(boardLayers, null, views);
    expect(def.active).toBe(false);
    expect(def.mode).toBe("board");
    expect(def.filter).toBeNull();
    expect([...def.visibleIds]).toEqual([BASE_LAYER, "auth"]);

    // Solo a hidden layer: locally visible, shared boardLayers untouched!
    const solo = resolveLocalLayers(boardLayers, { soloLayerId: "failover" }, views);
    expect(solo.active).toBe(true);
    expect(solo.mode).toBe("solo");
    expect(solo.soloLayerId).toBe("failover");
    expect([...solo.visibleIds]).toEqual(["failover"]);
    expect(solo.filter("failover")).toBe(true);
    expect(solo.filter(BASE_LAYER)).toBe(false);
    expect(boardLayers[2].visible).toBe(false); // unchanged!

    // Deleted solo layer falls back cleanly to board default
    const staleSolo = resolveLocalLayers(boardLayers, { soloLayerId: "gone" }, views);
    expect(staleSolo.active).toBe(false);
    expect(staleSolo.filter).toBeNull();

    // Named View with explicit visibleLayers
    const viewRes = resolveLocalLayers(boardLayers, { activeViewId: "v-fail" }, views);
    expect(viewRes.active).toBe(true);
    expect(viewRes.mode).toBe("view");
    expect(viewRes.activeViewName).toBe("Base + Failover");
    expect([...viewRes.visibleIds]).toEqual([BASE_LAYER, "failover"]);
    expect(viewRes.filter("auth")).toBe(false);
    expect(viewRes.filter("failover")).toBe(true);

    // Named View with visibleLayers: null preserves default board layers
    const frameOnly = resolveLocalLayers(boardLayers, { activeViewId: "v-frame" }, views);
    expect(frameOnly.active).toBe(false);
    expect(frameOnly.activeViewId).toBe("v-frame");
    expect(frameOnly.filter).toBeNull();
  });

  test("Doc.setLocalLayerFilter filters visible(), editable(), and spatialIndex without mutating appState.herdr.layers or toScene()", () => {
    const doc = makeBoardDoc();
    const layersBefore = JSON.stringify(doc.appState.herdr.layers);

    expect(doc.visible().map(e => e.id)).toContain("r-base");
    expect(doc.visible().map(e => e.id)).toContain("r-auth");
    expect(doc.visible().map(e => e.id)).not.toContain("r-fail");

    // Prime spatialIndex at current rev
    const idxBefore = spatialIndex(doc);
    expect(idxBefore.elements.map(e => e.id)).toContain("r-base");

    // Apply local solo filter for "failover"
    const solo = resolveLocalLayers(doc.layers, { soloLayerId: "failover" });
    doc.setLocalLayerFilter(solo.filter);

    expect(doc.visible().map(e => e.id)).toEqual(["r-fail"]);
    expect(doc.editable(doc.get("r-fail"))).toBe(true);
    expect(doc.editable(doc.get("r-base"))).toBe(false);

    // Spatial index invalidated automatically by rev bump
    const idxAfter = spatialIndex(doc);
    expect(idxAfter).not.toBe(idxBefore);
    expect(idxAfter.elements.map(e => e.id)).toEqual(["r-fail"]);

    // Shared appState.herdr.layers and serialized scene are 100% untouched!
    expect(JSON.stringify(doc.appState.herdr.layers)).toBe(layersBefore);
    expect(JSON.stringify(doc.toScene().appState.herdr.layers)).toBe(layersBefore);

    // Clear filter restores default board visibility
    doc.setLocalLayerFilter(null);
    expect(doc.visible().map(e => e.id)).toContain("r-base");
    expect(doc.visible().map(e => e.id)).not.toContain("r-fail");
  });
});

describe("captureCurrentView & stepViewIndex", () => {
  test("captures effective visible layers (including local override) and frameId", () => {
    const doc = makeBoardDoc();
    const captured = captureCurrentView(doc, { soloLayerId: "failover" }, { name: "Failover Focus", frameId: "f-b" });
    expect(captured.name).toBe("Failover Focus");
    expect(captured.frameId).toBe("f-b");
    expect(captured.visibleLayers).toEqual(["failover"]);
  });

  test("stepViewIndex wraps cleanly in both directions", () => {
    const views = [
      { id: "v1", name: "One", frameId: null, visibleLayers: null },
      { id: "v2", name: "Two", frameId: null, visibleLayers: null },
      { id: "v3", name: "Three", frameId: null, visibleLayers: null },
    ];
    expect(stepViewIndex(views, null, 1)?.id).toBe("v1");
    expect(stepViewIndex(views, null, -1)?.id).toBe("v3");
    expect(stepViewIndex(views, "v1", 1)?.id).toBe("v2");
    expect(stepViewIndex(views, "v3", 1)?.id).toBe("v1");
    expect(stepViewIndex(views, "v1", -1)?.id).toBe("v3");
    expect(stepViewIndex([], null, 1)).toBeNull();
  });
});
