// @ts-check
// Tests for #2 Built-In 1-Click Cloud & Kubernetes Vector Icon Packs (packages/core/icon-packs.js).

import { describe, test, expect } from "bun:test";
import {
  ICON_PACKS,
  ICON_PACK_IDS,
  getIconPack,
  buildIconItem,
  buildIconLibraryItems,
} from "../../packages/core/icon-packs.js";
import { itemFromElements, serializeLibrary, parseLibrary } from "../../packages/core/library.js";
import { exportToExcalidraw } from "../../packages/core/excalidraw.js";
import { bbox } from "../../packages/core/geometry.js";
import { opProblem } from "../../packages/protocol/envelope.js";
import { emptyScene, layerOf, zOf } from "../../packages/core/model.js";

const EXPECTED_K8S = [
  "Pod", "Deployment", "Service", "Ingress",
  "ConfigMap", "Secret", "Node", "PersistentVolume",
];

const EXPECTED_CLOUD = [
  "Load Balancer", "API Gateway", "Serverless Function", "Database",
  "Message Queue", "Object Storage", "Cache", "CDN",
];

describe("packages/core/icon-packs.js — registry and aliases", () => {
  test("exports Kubernetes (8 icons) and Cloud (8 icons) packs", () => {
    expect(ICON_PACK_IDS).toEqual(["kubernetes", "cloud"]);
    expect(ICON_PACKS.length).toBe(2);

    const k8s = getIconPack("kubernetes");
    expect(k8s).toBeTruthy();
    expect(k8s?.icons.map(i => i.name)).toEqual(EXPECTED_K8S);
    expect(getIconPack("k8s")).toEqual(k8s);

    const cloud = getIconPack("cloud");
    expect(cloud).toBeTruthy();
    expect(cloud?.icons.map(i => i.name)).toEqual(EXPECTED_CLOUD);
    expect(getIconPack("cloud-aws")).toEqual(cloud);
    expect(getIconPack("CLOUD-AWS")).toEqual(cloud);

    expect(getIconPack("nonexistent")).toBeNull();
    expect(getIconPack("")).toBeNull();
  });
});

describe("packages/core/icon-packs.js — vector icon generation & compatibility", () => {
  for (const pack of ICON_PACKS) {
    for (const icon of pack.icons) {
      test(`${pack.id}/${icon.id} (${icon.name}) produces Protocol v1.1-valid grouped vector elements`, () => {
        const els = buildIconItem(pack.id, icon.id, {
          x: 120,
          y: 240,
          layer: "infra",
          z: 10,
          now: 1700000000000,
        });
        expect(Array.isArray(els)).toBe(true);
        expect(els && els.length).toBeGreaterThanOrEqual(4);

        // Protocol v1.1 validation
        const problem = opProblem({
          t: "op",
          stream: "board",
          id: "c1:1",
          sentAt: 0,
          op: { elements: els },
        });
        expect(problem).toBeNull();

        // Shared single groupId, unique element IDs, zero external URLs or raster images
        const groupId = els[0].groupIds[0];
        expect(typeof groupId).toBe("string");
        expect(groupId.length).toBeGreaterThan(0);

        const seenIds = new Set();
        let prevZ = 9;
        for (const el of els) {
          expect(seenIds.has(el.id)).toBe(false);
          seenIds.add(el.id);
          expect(el.groupIds).toEqual([groupId]);
          expect(layerOf(el)).toBe("infra");
          expect(zOf(el)).toBeGreaterThan(prevZ);
          prevZ = zOf(el);
          expect(el.type).not.toBe("image");
          expect(el.type).not.toBe("video");
          expect(el.link).toBeNull();
          expect(JSON.stringify(el)).not.toMatch(/https?:\/\/|data:/i);
        }

        // Includes expected label text
        const textEl = els.find(e => e.type === "text");
        expect(textEl?.text).toBe(icon.name);

        // Bounding box starts at (120, 240) and matches declared icon size
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const el of els) {
          const b = bbox(el);
          minX = Math.min(minX, b.x);
          minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.w);
          maxY = Math.max(maxY, b.y + b.h);
        }
        expect(minX).toBeCloseTo(120, 1);
        expect(minY).toBeCloseTo(240, 1);
        expect(maxX - minX).toBeCloseTo(icon.width, 1);
        expect(maxY - minY).toBeCloseTo(icon.height, 1);

        // Compatible with library.js itemFromElements and .excalidrawlib round-trip
        const libItem = itemFromElements(els, { name: icon.name, now: 1700000000000 });
        expect(libItem.name).toBe(icon.name);
        expect(libItem.elements.length).toBe(els.length);
        expect(libItem.files).toBeUndefined();
        const parsedLib = parseLibrary(serializeLibrary([libItem]));
        expect(parsedLib.length).toBe(1);
        expect(parsedLib[0].elements.length).toBe(els.length);
      });
    }
  }

  test("buildIconItem works with pack aliases and produces fresh IDs per call", () => {
    const a = buildIconItem("cloud-aws", "database", { x: 0, y: 0 });
    const b = buildIconItem("cloud", "database", { x: 200, y: 0 });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].groupIds[0]).not.toBe(b[0].groupIds[0]);

    // Excalidraw export compatibility
    const scene = emptyScene();
    scene.elements = [...a, ...b];
    const exported = exportToExcalidraw(scene);
    expect(exported.type).toBe("excalidraw");
    expect(exported.elements.length).toBe(a.length + b.length);
  });

  test("buildIconLibraryItems builds full pack library items and rejects unknown/unsafe ids", () => {
    const k8sItems = buildIconLibraryItems("kubernetes", { now: 1700000000000 });
    const cloudItems = buildIconLibraryItems("cloud-aws", { now: 1700000000000 });
    expect(k8sItems?.length).toBe(8);
    expect(cloudItems?.length).toBe(8);

    expect(buildIconItem("unknown", "pod")).toBeNull();
    expect(buildIconItem("kubernetes", "unknown")).toBeNull();
    expect(buildIconItem("kubernetes", "__proto__")).toBeNull();
    expect(buildIconItem("cloud", "constructor")).toBeNull();
    expect(buildIconLibraryItems("nope")).toBeNull();
  });
});
