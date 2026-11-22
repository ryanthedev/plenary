import { describe, test, expect } from "bun:test";
import { videoScreenRect, isVideoVisible, createVideoOverlay } from "../../web/adapters/dom/video-overlay.js";
import { paint } from "../../web/adapters/dom/paint.js";
import { toSvg } from "../../web/adapters/dom/export.js";

function makeFakeDom() {
  const listeners = new Map();
  const makeEl = tag => {
    const elListeners = new Map();
    const attrs = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      style: {},
      children: [],
      parentNode: null,
      textContent: "",
      type: "",
      src: "",
      poster: "",
      preload: "",
      playsInline: false,
      controls: false,
      muted: false,
      loop: false,
      paused: true,
      playCalls: 0,
      pauseCalls: 0,
      loadCalls: 0,
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      removeChild(child) {
        const i = el.children.indexOf(child);
        if (i >= 0) el.children.splice(i, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(ev, fn) {
        if (!elListeners.has(ev)) elListeners.set(ev, new Set());
        elListeners.get(ev).add(fn);
      },
      removeEventListener(ev, fn) { elListeners.get(ev)?.delete(fn); },
      dispatchEvent(ev, payload = {}) {
        for (const fn of [...(elListeners.get(ev) ?? [])]) fn(payload);
      },
      play() {
        el.playCalls++;
        el.paused = false;
        el.dispatchEvent("play");
        return Promise.resolve();
      },
      pause() {
        el.pauseCalls++;
        el.paused = true;
        el.dispatchEvent("pause");
      },
      load() { el.loadCalls++; },
    };
    return el;
  };

  const doc = {
    hidden: false,
    visibilityState: "visible",
    createElement: makeEl,
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) { listeners.get(ev)?.delete(fn); },
    emit(ev) { for (const fn of [...(listeners.get(ev) ?? [])]) fn(); },
  };
  const winListeners = new Map();
  const win = {
    addEventListener(ev, fn) {
      if (!winListeners.has(ev)) winListeners.set(ev, new Set());
      winListeners.get(ev).add(fn);
    },
    removeEventListener(ev, fn) { winListeners.get(ev)?.delete(fn); },
    emit(ev) { for (const fn of [...(winListeners.get(ev) ?? [])]) fn(); },
  };
  const createdUrls = [];
  const revokedUrls = [];
  let seq = 0;
  const urlApi = {
    createObjectURL() {
      const u = `blob:http://localhost/vid-${++seq}`;
      createdUrls.push(u);
      return u;
    },
    revokeObjectURL(u) { revokedUrls.push(u); },
  };
  class FakeBlob {
    constructor(parts, opts) { this.parts = parts; this.type = opts?.type ?? ""; }
  }
  const root = makeEl("div");
  return { root, doc, win, urlApi, BlobCtor: FakeBlob, createdUrls, revokedUrls };
}

describe("videoScreenRect & isVideoVisible", () => {
  test("computes exact world-to-screen transform for pan, zoom, rotation, and negative dimensions", () => {
    const r = videoScreenRect({ x: 100, y: 50, width: 200, height: 100, angle: 0.5 }, { x: 20, y: -10, scale: 2 });
    expect(r.left).toBe(240);
    expect(r.top).toBe(80);
    expect(r.w).toBe(400);
    expect(r.h).toBe(200);
    expect(r.cx).toBe(440);
    expect(r.cy).toBe(180);
    expect(r.transform).toBe("translate3d(240px, 80px, 0) rotate(0.5rad)");

    const neg = videoScreenRect({ x: 300, y: 150, width: -200, height: -100, angle: 0 }, { x: 0, y: 0, scale: 1 });
    expect(neg.left).toBe(100);
    expect(neg.top).toBe(50);
    expect(neg.w).toBe(200);
    expect(neg.h).toBe(100);
  });

  test("culls off-screen videos and keeps rotated corners that enter viewport", () => {
    const vp = { w: 800, h: 600 };
    expect(isVideoVisible(videoScreenRect({ x: 10, y: 10, width: 200, height: 100 }, { x: 0, y: 0, scale: 1 }), vp, 0)).toBe(true);
    expect(isVideoVisible(videoScreenRect({ x: 900, y: 10, width: 200, height: 100 }, { x: 0, y: 0, scale: 1 }), vp, 0)).toBe(false);
    expect(isVideoVisible(videoScreenRect({ x: 830, y: 10, width: 200, height: 100 }, { x: 0, y: 0, scale: 1 }), vp, 64)).toBe(true);
    expect(isVideoVisible(videoScreenRect({ x: 0, y: 0, width: 0, height: 100 }, { x: 0, y: 0, scale: 1 }), vp, 64)).toBe(false);

    // Tall thin box just outside right edge when unrotated, rotated 90deg so it extends into viewport
    const rotated = videoScreenRect({ x: 820, y: 200, width: 40, height: 300, angle: Math.PI / 2 }, { x: 0, y: 0, scale: 1 });
    expect(isVideoVisible(rotated, vp, 0)).toBe(true);
  });
});

describe("createVideoOverlay", () => {
  const FID1 = "1".repeat(40);
  const FID2 = "2".repeat(40);

  test("mounts mobile-safe <video> elements, aligns transforms, and gates pointer events while dragging", () => {
    const env = makeFakeDom();
    const ov = createVideoOverlay(env);
    const el = { id: "v1", type: "video", fileId: FID1, mimeType: "video/mp4", x: 10, y: 20, width: 320, height: 180, angle: 0.25, muted: true, loop: true, opacity: 80 };
    const files = { [FID1]: { id: FID1, mimeType: "video/mp4", bytes: new Uint8Array([1, 2, 3]) } };

    ov.sync({ elements: [el], files, view: { x: 5, y: 10, scale: 1.5 }, viewport: { w: 1000, h: 800 }, dragging: false });
    expect(ov.mountedIds()).toEqual(["v1"]);
    const entry = ov.getEntry("v1");
    expect(entry.video.playsInline).toBe(true);
    expect(entry.video.getAttribute("playsinline")).toBe("");
    expect(entry.video.getAttribute("webkit-playsinline")).toBe("");
    expect(entry.video.preload).toBe("metadata");
    expect(entry.video.muted).toBe(true);
    expect(entry.video.loop).toBe(true);
    expect(entry.video.src).toBe("blob:http://localhost/vid-1");
    expect(entry.wrap.style.pointerEvents).toBe("none");
    expect(entry.video.style.pointerEvents).toBe("none");
    expect(entry.controls.style.pointerEvents).toBe("auto");
    expect(entry.wrap.style.transform).toBe("translate3d(22.5px, 45px, 0) rotate(0.25rad)");
    expect(entry.wrap.style.width).toBe("480px");
    expect(entry.wrap.style.height).toBe("270px");
    expect(entry.wrap.style.opacity).toBe("0.8");

    // Dragging disables control pointer events so canvas drag/resize handles are never blocked
    ov.sync({ elements: [el], files, view: { x: 5, y: 10, scale: 1.5 }, viewport: { w: 1000, h: 800 }, dragging: true });
    expect(entry.controls.style.pointerEvents).toBe("none");
    ov.destroy();
  });

  test("pauses all playing videos on visibilitychange (hidden) and pagehide", () => {
    const env = makeFakeDom();
    const ov = createVideoOverlay(env);
    const v1 = { id: "v1", type: "video", fileId: FID1, x: 0, y: 0, width: 320, height: 180 };
    const v2 = { id: "v2", type: "video", fileId: FID2, x: 400, y: 0, width: 320, height: 180 };
    const files = {
      [FID1]: { id: FID1, mimeType: "video/mp4", bytes: new Uint8Array([1]) },
      [FID2]: { id: FID2, mimeType: "video/mp4", bytes: new Uint8Array([2]) },
    };
    ov.sync({ elements: [v1, v2], files, view: { x: 0, y: 0, scale: 1 }, viewport: { w: 1000, h: 800 } });

    const e1 = ov.getEntry("v1");
    const e2 = ov.getEntry("v2");
    e1.playBtn.dispatchEvent("click", { stopPropagation() {} });
    e2.playBtn.dispatchEvent("click", { stopPropagation() {} });
    expect(e1.video.paused).toBe(false);
    expect(e2.video.paused).toBe(false);

    // Backgrounding via visibilitychange
    env.doc.hidden = true;
    env.doc.visibilityState = "hidden";
    env.doc.emit("visibilitychange");
    expect(e1.video.paused).toBe(true);
    expect(e2.video.paused).toBe(true);

    // Resume one, then trigger pagehide
    env.doc.hidden = false;
    env.doc.visibilityState = "visible";
    e1.playBtn.dispatchEvent("click", { stopPropagation() {} });
    expect(e1.video.paused).toBe(false);

    env.win.emit("pagehide");
    expect(e1.video.paused).toBe(true);
    ov.destroy();
  });

  test("culls off-screen videos, revokes object URLs on delete, recreates fresh URL on undo/redo (H1/H2), and cleans up on destroy", () => {
    const env = makeFakeDom();
    const ov = createVideoOverlay(env);
    const v1 = { id: "v1", type: "video", fileId: FID1, x: 10, y: 10, width: 200, height: 120 };
    const files = { [FID1]: { id: FID1, mimeType: "video/mp4", bytes: new Uint8Array([9, 8, 7]) } };

    ov.sync({ elements: [v1], files, view: { x: 0, y: 0, scale: 1 }, viewport: { w: 800, h: 600 } });
    expect(ov.mountedIds()).toEqual(["v1"]);
    expect(env.createdUrls).toEqual(["blob:http://localhost/vid-1"]);
    expect(env.revokedUrls).toEqual([]);

    // Pan far off-screen: video DOM node is culled, but object URL is kept while element is still live
    ov.sync({ elements: [v1], files, view: { x: -5000, y: 0, scale: 1 }, viewport: { w: 800, h: 600 } });
    expect(ov.mountedIds()).toEqual([]);
    expect(ov.layer.children.length).toBe(0);
    expect(env.revokedUrls).toEqual([]);

    // Delete element: object URL is revoked
    ov.sync({ elements: [{ ...v1, isDeleted: true }], files, view: { x: 0, y: 0, scale: 1 }, viewport: { w: 800, h: 600 } });
    expect(env.revokedUrls).toEqual(["blob:http://localhost/vid-1"]);

    // H1/H2: Undo restores the element — overlay creates a fresh playable object URL from `bytes` (not the revoked vid-1)
    ov.sync({ elements: [v1], files, view: { x: 0, y: 0, scale: 1 }, viewport: { w: 800, h: 600 } });
    expect(ov.mountedIds()).toEqual(["v1"]);
    expect(env.createdUrls).toEqual(["blob:http://localhost/vid-1", "blob:http://localhost/vid-2"]);
    expect(ov.getEntry("v1").video.src).toBe("blob:http://localhost/vid-2");

    ov.destroy();
    expect(ov.mountedIds()).toEqual([]);
    expect(env.revokedUrls).toEqual(["blob:http://localhost/vid-1", "blob:http://localhost/vid-2"]);
    expect(env.root.children.length).toBe(0);
  });

  test("validates posterDataUrl strictly (H4), reflects selection state & handles (H5), and syncs from displayItems (M10)", () => {
    const env = makeFakeDom();
    const ov = createVideoOverlay(env);
    const files = { [FID1]: { id: FID1, mimeType: "video/mp4", bytes: new Uint8Array([1, 2]) } };

    // H4: reject https:, javascript:, svg, and >64KB posterDataUrl
    for (const badPoster of [
      "https://evil.example/p.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64," + "A".repeat(65536),
    ]) {
      const el = { id: "v1", type: "video", fileId: FID1, x: 0, y: 0, width: 200, height: 120, posterDataUrl: badPoster };
      ov.sync({ elements: [el], files, view: { x: 0, y: 0, scale: 1 }, viewport: { w: 800, h: 600 } });
      expect(ov.getEntry("v1").video.poster).toBe("");
    }

    // Valid base64 PNG posterDataUrl is accepted
    const goodPoster = "data:image/png;base64,iVBORw0KGgo=";
    const el = { id: "v1", type: "video", fileId: FID1, x: 0, y: 0, width: 200, height: 120, posterDataUrl: goodPoster };
    ov.sync({
      elements: [el],
      files,
      view: { x: 0, y: 0, scale: 1 },
      viewport: { w: 800, h: 600 },
      selectedIds: new Set(["v1"]),
    });
    const entry = ov.getEntry("v1");
    expect(entry.video.poster).toBe(goodPoster);

    // H5: selection class, attribute, and corner handle frame are visible when selected
    expect(entry.wrap.className).toBe("video-el selected");
    expect(entry.wrap.getAttribute("data-selected")).toBe("true");
    expect(entry.selFrame.style.display).toBe("block");

    // M10: displayItems drives projected screen rect and animated opacity directly
    const displayItems = [{
      t: "video", id: "v1", fileId: FID1, mimeType: "video/mp4", status: "saved",
      x: 120, y: 80, w: 300, h: 160, angle: 0.4, cx: 270, cy: 160, opacity: 0.5,
    }];
    ov.sync({
      displayItems,
      elements: [el],
      files,
      viewport: { w: 800, h: 600 },
      selectedIds: new Set(),
    });
    expect(entry.wrap.style.transform).toBe("translate3d(120px, 80px, 0) rotate(0.4rad)");
    expect(entry.wrap.style.width).toBe("300px");
    expect(entry.wrap.style.height).toBe("160px");
    expect(entry.wrap.style.opacity).toBe("0.5");
    expect(entry.wrap.className).toBe("video-el");
    expect(entry.selFrame.style.display).toBe("none");

    ov.destroy();
  });
});

describe("Canvas2D paint & SVG export fallback for video items", () => {
  test("paint() draws video frame + play icon and toSvg() emits video placeholder group", () => {
    const calls = [];
    const ctx = {
      setTransform() {}, clearRect() {}, fillRect(...a) { calls.push(["fillRect", ...a]); },
      strokeRect(...a) { calls.push(["strokeRect", ...a]); },
      setLineDash() {}, beginPath() {}, arc(...a) { calls.push(["arc", ...a]); },
      moveTo() {}, lineTo() {}, closePath() {}, fill() { calls.push(["fill"]); },
      save() {}, restore() {}, translate() {}, rotate() {},
    };
    const items = [{ t: "video", id: "v1", fileId: "a".repeat(40), status: "saved", x: 10, y: 20, w: 320, h: 180, angle: 0, cx: 170, cy: 110, opacity: 1 }];
    paint(ctx, items, { width: 800, height: 600, dpr: 1 });
    expect(calls.some(c => c[0] === "fillRect" && c[1] === 10 && c[2] === 20 && c[3] === 320 && c[4] === 180)).toBe(true);
    expect(calls.some(c => c[0] === "arc")).toBe(true);

    const svg = toSvg(items, { width: 800, height: 600 });
    expect(svg).toContain("<rect x=\"10.0\" y=\"20.0\" width=\"320.0\" height=\"180.0\"");
    expect(svg).toContain("<polygon points=");
  });
});
