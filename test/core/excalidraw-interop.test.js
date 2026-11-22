import { describe, test, expect } from "bun:test";
import { makeElement, clone } from "../../packages/core/model.js";
import { Doc } from "../../packages/core/doc.js";
import { Editor } from "../../packages/core/editor.js";
import {
  EXCALIDRAW_SOURCE,
  fractionalIndex,
  isExcalidrawPayload,
  parseExcalidraw,
  remapExcalidrawIds,
  applyFileIdMap,
  importExcalidrawPayload,
  exportToExcalidraw,
  toExcalidrawClipboard,
  reconcileBoundElements,
} from "../../packages/core/excalidraw.js";
import { Replica } from "../../packages/protocol/replica.js";
import { opProblem, MAX_VERSION_JUMP, isSha1 } from "../../packages/protocol/envelope.js";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SHA1_IMG = "1".repeat(40);
const SHA1_VID = "2".repeat(40);

describe("core excalidraw: Plenary -> .excalidraw -> Plenary round-trip fidelity", () => {
  test("exports all supported types with full Excalidraw v2 fields, reconciled boundElements, and files, then round-trips cleanly", () => {
    const frame = makeElement("frame", {
      id: "frame-1", x: 0, y: 0, width: 900, height: 600, name: "Architecture",
    });
    const rect = makeElement("rectangle", {
      id: "rect-1", x: 40, y: 60, width: 180, height: 90,
      strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "hachure",
      strokeWidth: 4, strokeStyle: "dashed", roughness: 2, opacity: 85,
      angle: 0.25, roundness: { type: 3 }, groupIds: ["grp-1"], frameId: "frame-1",
      link: "https://plenary.app/docs", locked: true,
    });
    // Intentionally omit rect.boundElements to verify export reconstructs bidirectional invariants!
    const rectLabel = makeElement("text", {
      id: "lbl-1", x: 60, y: 90, width: 100, height: 25,
      text: "API Gateway", originalText: "API Gateway",
      fontSize: 22, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
      lineHeight: 1.3, containerId: "rect-1", groupIds: ["grp-1"], frameId: "frame-1",
    });
    const diamond = makeElement("diamond", {
      id: "dia-1", x: 320, y: 60, width: 120, height: 120,
      strokeColor: "#2f9e44", backgroundColor: "#b2f2bb", fillStyle: "cross-hatch",
      roundness: { type: 2 }, groupIds: ["grp-1"], frameId: "frame-1",
    });
    const ellipse = makeElement("ellipse", {
      id: "ell-1", x: 540, y: 80, width: 140, height: 80,
      strokeColor: "#9c36b5", backgroundColor: "#eebefa", strokeStyle: "dotted",
    });
    const arrow = makeElement("arrow", {
      id: "arr-1", x: 226, y: 105, width: 88, height: 10,
      points: [[0, 0], [88, 10]],
      startBinding: { elementId: "rect-1", focus: 0, gap: 6, fixedPoint: [1, 0.5] },
      endBinding: { elementId: "dia-1", focus: 0, gap: 6, fixedPoint: [0, 0.5] },
      startArrowhead: "dot", endArrowhead: "triangle", elbowed: true,
    });
    const line = makeElement("line", {
      id: "line-1", x: 40, y: 240, width: 200, height: 40,
      points: [[0, 0], [100, 40], [200, 0]], roundness: { type: 2 },
    });
    const freedraw = makeElement("freedraw", {
      id: "pen-1", x: 300, y: 250, width: 50, height: 30,
      points: [[0, 0], [25, 15], [50, 30]],
      pressures: [0.3, 0.7, 0.5], simulatePressure: false,
    });
    const standaloneText = makeElement("text", {
      id: "txt-1", x: 40, y: 340, width: 180, height: 30,
      text: "Standalone note", originalText: "Standalone note",
      fontSize: 18, fontFamily: 3, textAlign: "left", verticalAlign: "top",
    });
    const image = makeElement("image", {
      id: "img-1", x: 540, y: 220, width: 200, height: 120,
      fileId: SHA1_IMG, status: "saved", scale: [-1, 1],
    });
    const video = makeElement("video", {
      id: "vid-1", x: 540, y: 380, width: 200, height: 120,
      fileId: SHA1_VID, mimeType: "video/mp4",
    });

    const doc = new Doc({
      elements: [frame, rect, rectLabel, diamond, ellipse, arrow, line, freedraw, standaloneText, image, video],
      appState: { viewBackgroundColor: "#f8f7f4", herdr: { grid: 20 } },
      files: {
        [SHA1_IMG]: { id: SHA1_IMG, mimeType: "image/png", dataURL: TINY_PNG, created: 1700000000000 },
        [SHA1_VID]: { id: SHA1_VID, mimeType: "video/mp4", bytes: new Uint8Array([1, 2, 3]), created: 1700000000000 },
      },
    });

    const exported = exportToExcalidraw(doc, { now: 1700000001000 });
    expect(exported.type).toBe("excalidraw");
    expect(exported.version).toBe(2);
    expect(exported.source).toBe(EXCALIDRAW_SOURCE);
    expect(exported.appState).toEqual({ gridSize: 20, viewBackgroundColor: "#f8f7f4" });

    // Video is excluded from .excalidraw file export so excalidraw.com opens with zero warnings
    expect(exported.elements.some(e => e.type === "video")).toBe(false);
    expect(exported.elements.length).toBe(10);

    // Every exported element has required Excalidraw v2 fields and strictly ordered fractional index
    for (let i = 0; i < exported.elements.length; i++) {
      const el = exported.elements[i];
      for (const k of [
        "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
        "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds",
        "frameId", "index", "roundness", "seed", "version", "versionNonce", "isDeleted",
        "boundElements", "updated", "link", "locked",
      ]) {
        expect(Object.prototype.hasOwnProperty.call(el, k)).toBe(true);
      }
      expect(el.isDeleted).toBe(false);
      if (i > 0) expect(exported.elements[i - 1].index < el.index).toBe(true);
    }

    // Bidirectional boundElements invariant reconstructed on rect and diamond
    const expRect = exported.elements.find(e => e.id === "rect-1");
    expect(expRect.boundElements).toContainEqual({ id: "lbl-1", type: "text" });
    expect(expRect.boundElements).toContainEqual({ id: "arr-1", type: "arrow" });
    const expDia = exported.elements.find(e => e.id === "dia-1");
    expect(expDia.boundElements).toContainEqual({ id: "arr-1", type: "arrow" });

    // Files map has valid BinaryFileData for image only
    expect(Object.keys(exported.files)).toEqual([SHA1_IMG]);
    expect(exported.files[SHA1_IMG]).toEqual({
      mimeType: "image/png",
      id: SHA1_IMG,
      dataURL: TINY_PNG,
      created: 1700000000000,
      lastRetrieved: 1700000000000,
    });

    // Round-trip back into Plenary via parseExcalidraw
    const json = JSON.stringify(exported);
    expect(isExcalidrawPayload(json)).toBe(true);
    const parsed = parseExcalidraw(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("excalidraw");
    expect(parsed.skipped).toBe(0);
    expect(parsed.elements.length).toBe(10);
    expect(parsed.appState).toEqual({ viewBackgroundColor: "#f8f7f4", gridSize: 20 });

    const byId = new Map(parsed.elements.map(e => [e.id, e]));
    expect(byId.get("frame-1").name).toBe("Architecture");
    expect(byId.get("rect-1")).toMatchObject({
      strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "hachure",
      strokeWidth: 4, strokeStyle: "dashed", roughness: 2, opacity: 85,
      angle: 0.25, roundness: { type: 3 }, groupIds: ["grp-1"], frameId: "frame-1",
      link: "https://plenary.app/docs", locked: true,
    });
    expect(byId.get("lbl-1")).toMatchObject({
      text: "API Gateway", originalText: "API Gateway",
      fontSize: 22, fontFamily: 2, textAlign: "center", verticalAlign: "middle",
      lineHeight: 1.3, containerId: "rect-1",
    });
    expect(byId.get("arr-1")).toMatchObject({
      startArrowhead: "dot", endArrowhead: "triangle", elbowed: true,
    });
    expect(byId.get("arr-1").startBinding.elementId).toBe("rect-1");
    expect(byId.get("arr-1").startBinding.fixedPoint).toEqual([1, 0.5]);
    expect(byId.get("arr-1").endBinding.elementId).toBe("dia-1");
    expect(byId.get("pen-1").pressures).toEqual([0.3, 0.7, 0.5]);
    expect(byId.get("pen-1").simulatePressure).toBe(false);
    expect(byId.get("img-1")).toMatchObject({ fileId: SHA1_IMG, scale: [-1, 1], status: "saved" });
    expect(parsed.files[SHA1_IMG].dataURL).toBe(TINY_PNG);
  });

  test("fractionalIndex produces strictly sorted strings across bucket boundaries", () => {
    const indices = [];
    for (let i = 0; i < 200; i++) indices.push(fractionalIndex(i));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i - 1] < indices[i]).toBe(true);
    }
  });
});

describe("core excalidraw: realistic Excalidraw v2 fixture import & protocol v1.1 safety", () => {
  const EXCALIDRAW_V2_FIXTURE = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "ex-frame",
        type: "frame",
        x: 0, y: 0, width: 600, height: 400, angle: 0,
        strokeColor: "#bbb", backgroundColor: "transparent", fillStyle: "solid",
        strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100,
        groupIds: [], frameId: null, index: "a0", roundness: null,
        seed: 1001, version: 54321, versionNonce: 999999, isDeleted: false,
        boundElements: null, updated: 1700000000000, link: null, locked: false,
        name: "Flow",
      },
      {
        id: "ex-box",
        type: "rectangle",
        x: 50, y: 80, width: 160, height: 80, angle: 0,
        strokeColor: "#1e1e1e", backgroundColor: "#ffc9c9", fillStyle: "solid",
        strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
        groupIds: ["ex-g1"], frameId: "ex-frame", index: "a1", roundness: { type: 3 },
        seed: 1002, version: 12000, versionNonce: 888888, isDeleted: false,
        boundElements: [{ id: "ex-lbl", type: "text" }, { id: "ex-arrow", type: "arrow" }],
        updated: 1700000000000, link: null, locked: false,
      },
      {
        id: "ex-lbl",
        type: "text",
        x: 70, y: 108, width: 120, height: 24, angle: 0,
        strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
        strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
        groupIds: ["ex-g1"], frameId: "ex-frame", index: "a2", roundness: null,
        seed: 1003, version: 12001, versionNonce: 777777, isDeleted: false,
        boundElements: null, updated: 1700000000000, link: null, locked: false,
        text: "Start", fontSize: 20, fontFamily: 5, textAlign: "center",
        verticalAlign: "middle", containerId: "ex-box", originalText: "Start",
        autoResize: true, lineHeight: 1.25,
      },
      {
        id: "ex-arrow",
        type: "arrow",
        x: 216, y: 120, width: 100, height: 0, angle: 0,
        strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
        strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
        groupIds: [], frameId: "ex-frame", index: "a3", roundness: { type: 2 },
        seed: 1004, version: 99999, versionNonce: 666666, isDeleted: false,
        boundElements: null, updated: 1700000000000, link: null, locked: false,
        points: [[0, 0], [100, 0]], lastCommittedPoint: null,
        startBinding: { elementId: "ex-box", focus: 0, gap: 6, fixedPoint: [1, 0.5] },
        endBinding: null, startArrowhead: null, endArrowhead: "arrow",
      },
      {
        id: "ex-img",
        type: "image",
        x: 340, y: 80, width: 100, height: 100, angle: 0,
        strokeColor: "transparent", backgroundColor: "transparent", fillStyle: "solid",
        strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100,
        groupIds: [], frameId: "ex-frame", index: "a4", roundness: null,
        seed: 1005, version: 4200, versionNonce: 555555, isDeleted: false,
        boundElements: null, updated: 1700000000000, link: null, locked: false,
        fileId: "non-sha1-excalidraw-id", status: "saved", scale: [1, 1], crop: null,
      },
      {
        id: "ex-deleted",
        type: "rectangle",
        x: 0, y: 0, width: 50, height: 50, isDeleted: true, version: 5, versionNonce: 1,
      },
    ],
    appState: { gridSize: 16, viewBackgroundColor: "#ffffff" },
    files: {
      "non-sha1-excalidraw-id": {
        mimeType: "image/png",
        id: "non-sha1-excalidraw-id",
        dataURL: TINY_PNG,
        created: 1700000000000,
        lastRetrieved: 1700000000000,
      },
    },
  };

  test("imports fixture, remaps IDs + SHA-1 fileIds, normalizes versions, and passes protocol v1.1 Replica + opProblem", () => {
    const fileIdMap = new Map([["non-sha1-excalidraw-id", SHA1_IMG]]);
    const imported = importExcalidrawPayload(EXCALIDRAW_V2_FIXTURE, {
      remapIds: true,
      fileIdMap,
      dropNonSha1: true,
    });

    expect(imported.ok).toBe(true);
    expect(imported.skipped).toBe(1); // ex-deleted
    expect(imported.elements.length).toBe(5);

    const frameId = imported.idMap.get("ex-frame");
    const boxId = imported.idMap.get("ex-box");
    const lblId = imported.idMap.get("ex-lbl");
    const arrowId = imported.idMap.get("ex-arrow");
    const imgId = imported.idMap.get("ex-img");

    const byId = new Map(imported.elements.map(e => [e.id, e]));
    expect(byId.get(boxId).frameId).toBe(frameId);
    expect(byId.get(lblId).containerId).toBe(boxId);
    expect(byId.get(lblId).groupIds).toEqual(byId.get(boxId).groupIds);
    expect(byId.get(boxId).groupIds[0]).not.toBe("ex-g1");
    expect(byId.get(boxId).boundElements).toContainEqual({ id: lblId, type: "text" });
    expect(byId.get(boxId).boundElements).toContainEqual({ id: arrowId, type: "arrow" });
    expect(byId.get(arrowId).startBinding.elementId).toBe(boxId);
    expect(byId.get(imgId).fileId).toBe(SHA1_IMG);
    expect(isSha1(byId.get(imgId).fileId)).toBe(true);
    expect(imported.files[SHA1_IMG].dataURL).toBe(TINY_PNG);

    // Every imported element has version reset to 0 (well below MAX_VERSION_JUMP)
    for (const el of imported.elements) {
      expect(el.version).toBe(0);
      expect(el.version).toBeLessThan(MAX_VERSION_JUMP);
    }

    // Commit through protocol v1.1 Replica.local() and verify opProblem() accepts it cleanly
    const rep = new Replica({ client: "test", session: "s1" });
    const msg = rep.local("board", { elements: imported.elements });
    msg.sentAt = 0;
    expect(opProblem(msg)).toBeNull();
    for (const el of msg.op.elements) {
      expect(el.version).toBe(1);
    }
  });
});

describe("core excalidraw: clipboard copy/paste round-trip and duplicate-paste ID remapping", () => {
  test("Editor.copy() emits valid excalidraw/clipboard and pasting twice remaps all IDs, groups, frames, and bindings", () => {
    const ed = new Editor();
    ed.setSize(1000, 800);

    const frame = makeElement("frame", { id: "f1", x: 0, y: 0, width: 400, height: 300, name: "Group Frame" });
    const box = makeElement("rectangle", {
      id: "b1", x: 20, y: 40, width: 120, height: 60, frameId: "f1", groupIds: ["g1"],
    });
    const label = makeElement("text", {
      id: "t1", x: 30, y: 55, width: 100, height: 24, text: "Node A", containerId: "b1", frameId: "f1", groupIds: ["g1"],
    });
    const arrow = makeElement("arrow", {
      id: "a1", x: 146, y: 70, points: [[0, 0], [80, 0]],
      startBinding: { elementId: "b1", focus: 0, gap: 6 }, frameId: "f1",
    });
    ed.doc.apply({ elements: [frame, box, label, arrow] }, { force: true });
    ed.select(["f1", "b1", "a1"]);

    const clip = ed.copy();
    const parsedClip = JSON.parse(clip);
    expect(parsedClip.type).toBe("excalidraw/clipboard");
    expect(parsedClip.elements.length).toBe(4); // includes bound label t1 automatically
    const clipBox = parsedClip.elements.find(e => e.id === "b1");
    expect(clipBox.boundElements).toContainEqual({ id: "t1", type: "text" });
    expect(clipBox.boundElements).toContainEqual({ id: "a1", type: "arrow" });

    // Paste twice at different coordinates
    ed.paste(clip, { x: 600, y: 200 });
    ed.paste(clip, { x: 600, y: 600 });

    const live = ed.doc.live();
    expect(live.length).toBe(12); // 4 original + 4 paste 1 + 4 paste 2
    const ids = new Set(live.map(e => e.id));
    expect(ids.size).toBe(12);

    // Every pasted label's containerId and every pasted arrow's startBinding points to its own copy's box
    const boxes = live.filter(e => e.type === "rectangle");
    const labels = live.filter(e => e.type === "text");
    const arrows = live.filter(e => e.type === "arrow");
    const frames = live.filter(e => e.type === "frame");
    expect(boxes.length).toBe(3);
    expect(new Set(boxes.map(b => b.groupIds[0])).size).toBe(3);
    expect(new Set(boxes.map(b => b.frameId)).size).toBe(3);
    for (const f of frames) {
      const boxInFrame = boxes.find(b => b.frameId === f.id);
      const lblInFrame = labels.find(l => l.frameId === f.id);
      const arrInFrame = arrows.find(a => a.frameId === f.id);
      expect(boxInFrame).toBeTruthy();
      expect(lblInFrame.containerId).toBe(boxInFrame.id);
      expect(arrInFrame.startBinding.elementId).toBe(boxInFrame.id);
      if (f.id !== "f1") {
        // Both pasted copies have reconciled bidirectional boundElements (even though original b1 omitted them).
        expect(boxInFrame.boundElements).toContainEqual({ id: lblInFrame.id, type: "text" });
        expect(boxInFrame.boundElements).toContainEqual({ id: arrInFrame.id, type: "arrow" });
      }
    }
  });
});

describe("core excalidraw: malformed input safety & prototype pollution defense", () => {
  test("rejects invalid JSON, non-object payloads, wrong type, and missing elements safely without throwing", () => {
    for (const bad of [
      "not json at all",
      "",
      "null",
      "[]",
      "123",
      JSON.stringify({ type: "other", elements: [] }),
      JSON.stringify({ type: "excalidraw", elements: "nope" }),
      null,
      undefined,
    ]) {
      const r = parseExcalidraw(bad);
      expect(r.ok).toBe(false);
      expect(r.elements).toEqual([]);
    }
  });

  test("blocks prototype pollution, sanitizes NaN/Infinity/negative dimensions, skips unknown & deleted elements", () => {
    const hostile = `{
      "type": "excalidraw",
      "version": 2,
      "__proto__": { "pollutedRoot": true },
      "elements": [
        null,
        42,
        { "id": "del-1", "type": "rectangle", "isDeleted": true, "x": 0, "y": 0, "width": 10, "height": 10 },
        { "id": "unk-1", "type": "magic-widget", "x": 0, "y": 0, "width": 10, "height": 10 },
        {
          "id": "neg-rect",
          "type": "rectangle",
          "x": 100,
          "y": 200,
          "width": -50,
          "height": -80,
          "opacity": 500,
          "roughness": -3,
          "strokeWidth": 0,
          "angle": "bad",
          "customData": { "__proto__": { "pollutedCustom": true }, "constructor": { "bad": 1 }, "layer": "base", "z": 5 }
        },
        {
          "id": "huge-rect",
          "type": "rectangle",
          "x": 1e30,
          "y": -1e30,
          "width": 1e20,
          "height": 1e20
        },
        {
          "id": "bad-img",
          "type": "image",
          "x": 0, "y": 0, "width": 100, "height": 100,
          "fileId": "evil-file"
        }
      ],
      "files": {
        "__proto__": { "pollutedFile": true },
        "evil-file": { "id": "evil-file", "mimeType": "text/html", "dataURL": "data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=" }
      }
    }`;

    const res = parseExcalidraw(hostile);
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(5); // null, 42, del-1, unk-1, bad-img (rejected evil-file)
    expect(res.elements.length).toBe(2);

    // No prototype pollution occurred anywhere
    expect(({}).pollutedRoot).toBeUndefined();
    expect(({}).pollutedCustom).toBeUndefined();
    expect(({}).pollutedFile).toBeUndefined();

    const neg = res.elements.find(e => e.id === "neg-rect");
    expect(neg.x).toBe(50);
    expect(neg.y).toBe(120);
    expect(neg.width).toBe(50);
    expect(neg.height).toBe(80);
    expect(neg.opacity).toBe(100);
    expect(neg.roughness).toBe(0);
    expect(neg.strokeWidth).toBeGreaterThan(0);
    expect(neg.angle).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(neg.customData, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(neg.customData, "constructor")).toBe(false);

    const huge = res.elements.find(e => e.id === "huge-rect");
    expect(Number.isFinite(huge.x)).toBe(true);
    expect(Math.abs(huge.x)).toBeLessThanOrEqual(1e7);
    expect(huge.width).toBeLessThanOrEqual(1e6);

    // Non-image dataURL was rejected and its referencing image element dropped
    expect(res.files["evil-file"]).toBeUndefined();
    expect(res.elements.find(e => e.id === "bad-img")).toBeUndefined();

    // NaN / Infinity in object input
    const nanRes = parseExcalidraw({
      type: "excalidraw",
      elements: [{ id: "nan-1", type: "ellipse", x: NaN, y: Infinity, width: -Infinity, height: NaN }],
    });
    expect(nanRes.ok).toBe(true);
    expect(nanRes.elements[0]).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
  });

  test("regression M1: Editor.paste() and Editor.importExcalidraw() never emit non-SHA-1 fileId ops", () => {
    const ops = [];
    const ed = new Editor({ onOp: op => ops.push(op) });
    ed.setSize(800, 600);
    const clip = JSON.stringify({
      type: "excalidraw/clipboard",
      elements: [
        { id: "img-nonsha", type: "image", x: 10, y: 10, width: 100, height: 100, fileId: "not-a-sha1-id" },
      ],
      files: {
        "not-a-sha1-id": { id: "not-a-sha1-id", mimeType: "image/png", dataURL: TINY_PNG, created: 1 },
      },
    });

    ed.paste(clip);
    const img = ed.doc.live().find(e => e.type === "image");
    expect(img).toBeTruthy();
    expect(img.fileId).toBeNull();
    expect(ed.doc.files["not-a-sha1-id"]).toBeUndefined();

    const rep = new Replica({ client: "c1", session: "s1" });
    const elOp = ops.find(o => o.elements?.length);
    const msg = rep.local("board", { elements: elOp.elements });
    msg.sentAt = 0;
    expect(opProblem(msg)).toBeNull();
  });

  test("regression M2: image/svg+xml data URLs are rejected and referencing image elements are skipped", () => {
    const svgDataUrl = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=";
    const res = parseExcalidraw({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
        { id: "svg-img", type: "image", x: 120, y: 0, width: 100, height: 100, fileId: "svg-file-1" },
        { id: "png-img", type: "image", x: 240, y: 0, width: 100, height: 100, fileId: SHA1_IMG },
      ],
      files: {
        "svg-file-1": { id: "svg-file-1", mimeType: "image/svg+xml", dataURL: svgDataUrl, created: 1 },
        [SHA1_IMG]: { id: SHA1_IMG, mimeType: "image/png", dataURL: TINY_PNG, created: 1 },
      },
    });
    expect(res.ok).toBe(true);
    expect(res.files["svg-file-1"]).toBeUndefined();
    expect(res.elements.some(e => e.id === "svg-img")).toBe(false);
    expect(res.elements.some(e => e.id === "png-img")).toBe(true);
    expect(res.files[SHA1_IMG].dataURL).toBe(TINY_PNG);
    expect(res.skipped).toBe(1);
  });

  test("regression M3: malformed bindings to incompatible target types are stripped and reconciled cleanly", () => {
    const res = parseExcalidraw({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "t1", type: "text", x: 0, y: 0, width: 80, height: 24, text: "Host?", boundElements: [{ id: "t2", type: "text" }, { id: "a1", type: "arrow" }] },
        { id: "t2", type: "text", x: 10, y: 10, width: 60, height: 24, text: "Bad child", containerId: "t1", frameId: "t1" },
        { id: "f1", type: "frame", x: 0, y: 0, width: 300, height: 200, name: "F", frameId: "f1" },
        { id: "t3", type: "text", x: 20, y: 20, width: 60, height: 24, text: "Frame child", containerId: "f1", frameId: "f1" },
        { id: "p1", type: "freedraw", x: 0, y: 0, points: [[0, 0], [10, 10]] },
        {
          id: "a1", type: "arrow", x: 0, y: 0, points: [[0, 0], [50, 0]],
          startBinding: { elementId: "t1", focus: 0, gap: 6 },
          endBinding: { elementId: "p1", focus: 0, gap: 6 },
        },
      ],
    });
    expect(res.ok).toBe(true);
    const byId = new Map(res.elements.map(e => [e.id, e]));
    // Text cannot contain text; frame cannot be a text container; frameId cannot point to non-frame or self
    expect(byId.get("t2").containerId).toBeNull();
    expect(byId.get("t2").frameId).toBeNull();
    expect(byId.get("f1").frameId).toBeNull();
    expect(byId.get("t3").containerId).toBeNull();
    expect(byId.get("t3").frameId).toBe("f1");
    // Arrow cannot bind to text or freedraw
    expect(byId.get("a1").startBinding).toBeNull();
    expect(byId.get("a1").endBinding).toBeNull();
    // Invalid boundElements stripped
    expect(byId.get("t1").boundElements).toBeNull();
  });

  test("regression M4: enforces pre-parse input size cap, element cap, aggregate points cap, and aggregate file bytes cap", () => {
    const bigStr = JSON.stringify({ type: "excalidraw", elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] });
    expect(parseExcalidraw(bigStr, { maxInputBytes: 20 }).ok).toBe(false);
    expect(isExcalidrawPayload(bigStr, { maxInputBytes: 20 })).toBe(false);

    const manyEls = {
      type: "excalidraw",
      elements: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, type: "rectangle", x: i, y: 0, width: 10, height: 10 })),
    };
    expect(parseExcalidraw(manyEls, { maxElements: 5 }).ok).toBe(false);

    const manyPts = {
      type: "excalidraw",
      elements: [
        { id: "p1", type: "freedraw", x: 0, y: 0, points: [[0, 0], [1, 1], [2, 2], [3, 3]] },
        { id: "p2", type: "freedraw", x: 0, y: 0, points: [[0, 0], [1, 1], [2, 2], [3, 3]] },
      ],
    };
    expect(parseExcalidraw(manyPts, { maxTotalPoints: 6 }).ok).toBe(false);

    const bigFiles = {
      type: "excalidraw",
      elements: [
        { id: "i1", type: "image", x: 0, y: 0, width: 10, height: 10, fileId: "f1" },
        { id: "i2", type: "image", x: 20, y: 0, width: 10, height: 10, fileId: "f2" },
      ],
      files: {
        f1: { id: "f1", mimeType: "image/png", dataURL: TINY_PNG },
        f2: { id: "f2", mimeType: "image/png", dataURL: TINY_PNG },
      },
    };
    // Allow 1 image (~68 bytes) but reject the 2nd under aggregate cap of 100 bytes
    const capped = parseExcalidraw(bigFiles, { maxTotalFileBytes: 100 });
    expect(capped.ok).toBe(true);
    expect(Object.keys(capped.files)).toEqual(["f1"]);
    expect(capped.elements.map(e => e.id)).toEqual(["i1"]);
    expect(capped.skipped).toBe(1);
  });
});
