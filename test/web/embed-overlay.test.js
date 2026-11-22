// Issue #112: Click-to-activate embed DOM overlay tests.
import { describe, test, expect } from "bun:test";
import { embedScreenRect, isEmbedVisible, createEmbedOverlay } from "../../web/adapters/dom/embed-overlay.js";
import { buildEmbedElement, YOUTUBE_EMBED_ORIGIN } from "../../packages/core/embed.js";

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
      preload: "",
      playsInline: false,
      controls: false,
      paused: false,
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
      pause() {
        el.pauseCalls++;
        el.paused = true;
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
  const root = makeEl("div");
  return { root, doc, win };
}

describe("embedScreenRect & isEmbedVisible", () => {
  test("computes world-to-screen transform and rotated viewport culling", () => {
    const r = embedScreenRect({ x: 50, y: 25, width: 480, height: 270, angle: 0.2 }, { x: 10, y: -5, scale: 2 });
    expect(r.left).toBe(120);
    expect(r.top).toBe(40);
    expect(r.w).toBe(960);
    expect(r.h).toBe(540);
    expect(r.transform).toBe("translate3d(120px, 40px, 0) rotate(0.2rad)");

    const vp = { w: 800, h: 600 };
    expect(isEmbedVisible(embedScreenRect({ x: 10, y: 10, width: 200, height: 100 }, { x: 0, y: 0, scale: 1 }), vp, 0)).toBe(true);
    expect(isEmbedVisible(embedScreenRect({ x: 950, y: 10, width: 200, height: 100 }, { x: 0, y: 0, scale: 1 }), vp, 0)).toBe(false);
    expect(isEmbedVisible(embedScreenRect({ x: 820, y: 200, width: 40, height: 300, angle: Math.PI / 2 }, { x: 0, y: 0, scale: 1 }), vp, 0)).toBe(true);
  });
});

describe("createEmbedOverlay — Click-to-Activate & Security", () => {
  test("mounts ZERO iframes until user clicks Play, then mounts sandboxed youtube-nocookie iframe, and unmounts on Close", () => {
    const env = makeFakeDom();
    const ov = createEmbedOverlay(env);
    const yt = buildEmbedElement("https://youtu.be/dQw4w9WgXcQ?t=90", { id: "emb1", x: 10, y: 20, width: 480, height: 270, title: "Demo" });

    // Initial sync: NO iframe mounted!
    ov.sync({ elements: [yt], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 1200, h: 800 } });
    expect(ov.mountedIds()).toEqual(["emb1"]);
    expect(ov.activeIds()).toEqual([]);
    const entry = ov.getEntry("emb1");
    expect(entry.media).toBeNull();
    expect(entry.mediaWrap.children.length).toBe(0);
    expect(entry.playBtn.style.display).toBe("block");
    expect(entry.closeBtn.style.display).toBe("none");

    // Click Play → mounts sandboxed youtube-nocookie iframe
    entry.playBtn.dispatchEvent("click", { stopPropagation() {} });
    expect(ov.activeIds()).toEqual(["emb1"]);
    expect(entry.media).not.toBeNull();
    expect(entry.media.tagName).toBe("IFRAME");
    expect(entry.media.src).toBe(`${YOUTUBE_EMBED_ORIGIN}/embed/dQw4w9WgXcQ?rel=0&start=90`);
    expect(entry.media.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation");
    expect(entry.media.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(entry.media.getAttribute("allow")).toContain("fullscreen");
    expect(entry.playBtn.style.display).toBe("none");
    expect(entry.closeBtn.style.display).toBe("block");

    // Pan/zoom syncs active iframe container without recreating iframe
    const prevIframe = entry.media;
    ov.sync({ elements: [yt], view: { x: 50, y: 30, scale: 1.5 }, viewport: { w: 1200, h: 800 }, dragging: true });
    expect(entry.media).toBe(prevIframe);
    expect(entry.wrap.style.transform).toBe("translate3d(90px, 75px, 0) rotate(0rad)");
    expect(entry.wrap.style.width).toBe("720px");
    expect(entry.mediaWrap.style.pointerEvents).toBe("none");
    expect(entry.closeBtn.style.pointerEvents).toBe("none");

    // Click Close → unmounts iframe and returns to poster play button
    entry.closeBtn.dispatchEvent("click", { stopPropagation() {} });
    expect(ov.activeIds()).toEqual([]);
    expect(entry.media).toBeNull();
    expect(entry.mediaWrap.children.length).toBe(0);
    expect(entry.playBtn.style.display).toBe("block");
    expect(entry.closeBtn.style.display).toBe("none");

    ov.destroy();
    expect(env.root.children.length).toBe(0);
  });

  test("mounts mobile-safe <video controls playsinline> for direct video URLs and pauses on backgrounding", () => {
    const env = makeFakeDom();
    const ov = createEmbedOverlay(env);
    const vid = buildEmbedElement("https://cdn.example.com/demo.mp4", { id: "embv", x: 0, y: 0 });

    ov.sync({ elements: [vid], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 1000, h: 800 } });
    expect(ov.getEntry("embv").media).toBeNull();

    expect(ov.activate("embv")).toBe(true);
    const entry = ov.getEntry("embv");
    expect(entry.media.tagName).toBe("VIDEO");
    expect(entry.media.controls).toBe(true);
    expect(entry.media.playsInline).toBe(true);
    expect(entry.media.getAttribute("playsinline")).toBe("");
    expect(entry.media.getAttribute("webkit-playsinline")).toBe("");
    expect(entry.media.src).toBe("https://cdn.example.com/demo.mp4");

    // Visibility hidden pauses playing <video>
    entry.media.paused = false;
    env.doc.hidden = true;
    env.doc.visibilityState = "hidden";
    env.doc.emit("visibilitychange");
    expect(entry.media.pauseCalls).toBe(1);

    // Pagehide pauses playing <video>
    entry.media.paused = false;
    env.win.emit("pagehide");
    expect(entry.media.pauseCalls).toBe(2);

    // Media load / CSP error falls back cleanly to a safe external link
    entry.media.dispatchEvent("error");
    expect(entry.media.className).toBe("embed-fallback");
    const link = entry.media.children.find(c => c.tagName === "A");
    expect(link.getAttribute("href")).toBe("https://cdn.example.com/demo.mp4");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    ov.destroy();
  });

  test("mounts <img> with no-referrer for direct image URLs, culls off-screen, and cleans up on delete", () => {
    const env = makeFakeDom();
    const ov = createEmbedOverlay(env);
    const img = buildEmbedElement("https://cdn.example.com/pic.webp", { id: "embi", x: 10, y: 10 });

    ov.sync({ elements: [img], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 1000, h: 800 } });
    ov.activate("embi");
    const entry = ov.getEntry("embi");
    expect(entry.media.tagName).toBe("IMG");
    expect(entry.media.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(entry.media.src).toBe("https://cdn.example.com/pic.webp");

    // Pan off-screen → unmounts DOM node
    ov.sync({ elements: [img], view: { x: -5000, y: 0, scale: 1 }, viewport: { w: 1000, h: 800 } });
    expect(ov.mountedIds()).toEqual([]);

    // Delete element → drops active state
    ov.sync({ elements: [{ ...img, isDeleted: true }], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 1000, h: 800 } });
    expect(ov.activeIds()).toEqual([]);

    ov.destroy();
  });

  test("rejects tampered embed elements with non-https or spoofed embedUrl", () => {
    const env = makeFakeDom();
    const ov = createEmbedOverlay(env);
    const bad = {
      id: "bad1",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      link: "javascript:alert(1)",
      customData: { embed: { provider: "youtube", url: "javascript:alert(1)", embedUrl: "https://evil.example/x" } },
    };
    ov.sync({ elements: [bad], view: { x: 0, y: 0, scale: 1 }, viewport: { w: 1000, h: 800 } });
    expect(ov.mountedIds()).toEqual([]);
    expect(ov.activate("bad1")).toBe(false);
    ov.destroy();
  });
});
