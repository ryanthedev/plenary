// Mobile paste & media insertion (Chrome on iOS / WKWebView):
// explicit Paste button via navigator.clipboard.read(), text/plain fallback,
// error/empty/role handling, Photo / Video picker trigger, and icons.
import { test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { ICONS } from "../../web/adapters/dom/icons.js";

// ── minimal DOM stub ──
class N {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) { for (const n of ns) { const x = n instanceof N ? n : new T(String(n)); x.parentNode?.removeChild(x); x.parentNode = this; this.childNodes.push(x); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(new T(String(v))); }
}
class T extends N { constructor(t) { super(3); this.data = t; } get textContent() { return this.data; } }
const CTX = { measureText: t => ({ width: String(t).length * 7 }), getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop() {} }), createPattern: () => null };
class E extends N {
  constructor(tag) {
    super(1); this.tagName = tag.toUpperCase(); this.className = ""; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 390; this.height = 844;
    this.clicks = 0;
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: c => self.classList.toggle(c, true),
      remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(" "); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) { const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev }; for (const fn of this.listeners[t] ?? []) fn(e); return e; }
  click() { if (!this.disabled) { this.clicks++; this.fire("click"); } }
  focus() {} blur() {} setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { this.parentNode.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); n.parentNode?.removeChild(n); n.parentNode = p; p.childNodes.splice(i, 0, n); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport", "navigator", "FileReader", "Image"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
});

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

// Stub FileReader & Image for Blob -> dataURL -> naturalWidth/Height in Bun's headless test env.
class StubFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(buf => {
      const b64 = Buffer.from(buf).toString("base64");
      this.result = `data:${blob.type || "application/octet-stream"};base64,${b64}`;
      this.onload?.();
    }).catch(() => this.onerror?.());
  }
}
class StubImage {
  constructor() { this.naturalWidth = 320; this.naturalHeight = 200; }
  set src(v) {
    this._src = v;
    queueMicrotask(() => this.onload?.());
  }
  get src() { return this._src; }
}

async function waitUntil(pred, step, maxMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    step?.(1);
    if (pred()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  step?.(1);
}
const find = (root, pred) => root.all().find(pred);

function setupMobilePaste({ token = "t-ada", clipboard = undefined, withUploadBlob = true } = {}) {
  let frames = [];
  const winL = {}, docL = {};
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 3,
    FileReader: StubFileReader, Image: StubImage,
    matchMedia: q => ({
      matches: q.includes("max-width: 640px") || q.includes("pointer: coarse"),
      addEventListener() {},
    }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { winL[t] = (winL[t] ?? []).filter(f => f !== fn); },
    visualViewport: undefined,
  });

  const uploaded = [];
  const relayed = [];
  const uploadBlob = withUploadBlob ? async (url, bytes, mimeType) => { uploaded.push({ url, len: bytes.length, mimeType }); } : null;
  const net = localRoom({ board: "mobile-paste-board", users: USERS, clock: true });
  const appNet = {
    kind: withUploadBlob ? "ws" : "local",
    put(f) { relayed.push(f); },
    onFile() {},
    ...(withUploadBlob ? { uploadBlob } : {}),
  };
  const app = mountApp({
    startSession: ({ mine, onChange }) => {
      const s = createSession({
        join: () => net.join(),
        uploadBlob,
        token, board: "mobile-paste-board",
        client: USERS[token].user, user: USERS[token].user,
        mine, onChange, clock: net.clock,
      });
      if (withUploadBlob) {
        // localRoom doesn't implement blob-url signing; stub requestBlobUrl on the link so S.uploadBlob exercises the signed PUT path.
        s.connection.requestBlobUrl = async sha1 => `https://blobs.test/blobs/${sha1}?sig=ok`;
      }
      return s;
    },
    net: appNet,
    board: "mobile-paste-board",
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      while (net.step());
      net.advance(16);
      while (net.step());
      const q = frames; frames = [];
      for (const fn of q) fn();
    }
  };
  step(3);
  const fireWin = (t, ev = {}) => { for (const fn of winL[t] ?? []) fn(ev); };
  return { doc, byId, app, S: app.S, net, step, uploaded, relayed, fireWin };
}

test("icons.js defines paste and image SVG icons and index.html #picker accepts photos & videos", async () => {
  expect(Array.isArray(ICONS.paste)).toBe(true);
  expect(ICONS.paste.length).toBeGreaterThan(0);
  expect(Array.isArray(ICONS.image)).toBe(true);
  const html = await Bun.file(new URL("../../web/index.html", import.meta.url)).text();
  expect(html).toContain('id="picker" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime,.excalidrawlib"');
});

test("Paste button click with image/png ClipboardItem calls clipboard.read() synchronously, inserts image, and uploads blob", async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  let readCalls = 0;
  let textRequested = false;
  const clipboard = {
    read() {
      readCalls++;
      return Promise.resolve([{
        types: ["text/plain", "image/png"],
        async getType(t) {
          if (t === "text/plain") { textRequested = true; return new Blob(["should not paste"], { type: "text/plain" }); }
          expect(t).toBe("image/png");
          // Verify empty blob.type (a WebKit quirk) is normalized from ClipboardItem type.
          return new Blob([pngBytes], { type: "" });
        },
      }]);
    },
  };
  const { byId, S, step, uploaded } = setupMobilePaste({ token: "t-ada", clipboard, withUploadBlob: true });

  // 1-tap Paste button in mobile topbar
  const topPaste = find(byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "paste");
  expect(topPaste).toBeTruthy();
  expect(topPaste.disabled).toBe(false);
  topPaste.click();
  // Synchronous user-gesture requirement for iOS WKWebView: clipboard.read() must have started before click() returned.
  expect(readCalls).toBe(1);
  // Re-entrancy guard: a rapid second click while in-flight must not start a duplicate read.
  topPaste.click();
  expect(readCalls).toBe(1);

  await waitUntil(() => S.eds.board.doc.live().some(e => e.type === "image"), step);

  expect(textRequested).toBe(false);
  expect(uploaded.length).toBe(1);
  expect(uploaded[0].mimeType).toBe("image/png");
  expect(uploaded[0].len).toBe(pngBytes.length);
  const imgs = S.eds.board.doc.live().filter(e => e.type === "image");
  expect(imgs.length).toBe(1);
  expect(imgs[0].fileId).toMatch(/^[0-9a-f]{40}$/);
  expect(S.eds.board.doc.files[imgs[0].fileId]?.mimeType).toBe("image/png");
});

test("Tools bottom sheet Paste button with text/plain ClipboardItem calls S.paste and inserts shapes", async () => {
  const payload = JSON.stringify({
    type: "excalidraw/clipboard",
    elements: [{ id: "el-1", type: "rectangle", x: 10, y: 10, width: 100, height: 60, angle: 0, strokeColor: "#18181B", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], boundElements: null, updated: 1, version: 1, versionNonce: 1, isDeleted: false }],
    files: {},
  });
  const clipboard = {
    async read() {
      return [{
        types: ["text/plain"],
        async getType(t) {
          expect(t).toBe("text/plain");
          return new Blob([payload], { type: "text/plain" });
        },
      }];
    },
  };
  const { byId, app, S, step } = setupMobilePaste({ token: "t-ada", clipboard });

  // Open Tools bottom sheet via More button in dock
  const moreBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("More"));
  moreBtn.click();
  step(2);
  expect(app.ui.sheet).toBe("tools");
  // Tools sheet wraps actions + grid in .scroll so 20+ items don't clip on 390px iPhone.
  expect(find(byId.sheet, e => e.classList.contains("scroll"))).toBeTruthy();

  const sheetPaste = find(byId.sheet, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "paste");
  const sheetMedia = find(byId.sheet, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "media");
  expect(sheetPaste).toBeTruthy();
  expect(sheetMedia).toBeTruthy();

  // Photo / Video triggers #picker.click()
  sheetMedia.click();
  expect(byId.picker.clicks).toBe(1);

  // Re-open Tools sheet and tap Paste
  moreBtn.click();
  step(2);
  const sheetPaste2 = find(byId.sheet, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "paste");
  sheetPaste2.click();
  await waitUntil(() => app.ui.sheet === null && S.eds.board.doc.live().some(e => e.type === "rectangle"), step);

  expect(app.ui.sheet).toBe(null);
  const rects = S.eds.board.doc.live().filter(e => e.type === "rectangle");
  expect(rects.length).toBe(1);
});

test("NotAllowedError shows friendly cancellation toast without crashing", async () => {
  const clipboard = {
    async read() {
      const err = new Error("User dismissed iOS paste prompt");
      err.name = "NotAllowedError";
      throw err;
    },
  };
  const { byId, S, step } = setupMobilePaste({ token: "t-ada", clipboard });
  const topPaste = find(byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "paste");
  topPaste.click();
  await waitUntil(() => !byId.toast.hidden, step);

  expect(byId.toast.hidden).toBe(false);
  expect(byId.toast.textContent).toBe("Clipboard paste was cancelled");
  expect(S.eds.board.doc.live().length).toBe(0);
});

test("Empty clipboard or unsupported MIME type shows friendly empty toast", async () => {
  // Empty array
  {
    const clipboard = { async read() { return []; } };
    const { byId, step } = setupMobilePaste({ token: "t-ada", clipboard });
    find(byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "paste").click();
    await waitUntil(() => !byId.toast.hidden, step);
    expect(byId.toast.hidden).toBe(false);
    expect(byId.toast.textContent).toBe("Nothing to paste from clipboard");
  }
  // Unsupported format only (text/html)
  {
    const clipboard = {
      async read() {
        return [{ types: ["text/html"], async getType() { return new Blob(["<b>hi</b>"], { type: "text/html" }); } }];
      },
    };
    const { byId, step } = setupMobilePaste({ token: "t-ada", clipboard });
    find(byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "paste").click();
    await waitUntil(() => !byId.toast.hidden, step);
    expect(byId.toast.hidden).toBe(false);
    expect(byId.toast.textContent).toBe("Nothing to paste from clipboard");
  }
});

test("Going offline while awaiting clipboard.read() toasts View only and inserts nothing", async () => {
  let resolveRead;
  const clipboard = { read: () => new Promise(r => { resolveRead = r; }) };
  const { byId, S, step, fireWin, uploaded } = setupMobilePaste({ token: "t-ada", clipboard });
  find(byId.topbar, e => e.getAttribute("data-action") === "paste").click();
  fireWin("offline");
  resolveRead([{ types: ["image/png"], async getType() { return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }); } }]);
  await waitUntil(() => !byId.toast.hidden, step);

  expect(byId.toast.textContent).toBe("View only: nothing is pasted");
  expect(uploaded.length).toBe(0);
  expect(S.eds.board.doc.live().length).toBe(0);
});

test("Viewer role hides Paste and Photo / Video controls; offline writer disables them", () => {
  // Viewer
  {
    const { byId, step } = setupMobilePaste({ token: "t-vi", clipboard: { async read() { return []; } } });
    expect(find(byId.topbar, e => e.getAttribute("data-action") === "paste")).toBeFalsy();
    const overflow = find(byId.topbar, e => e.className.includes("overflow-btn"));
    overflow.click();
    step(2);
    expect(find(byId.sheet, e => e.getAttribute("data-action") === "paste")).toBeFalsy();
    expect(find(byId.sheet, e => e.getAttribute("data-action") === "media")).toBeFalsy();
  }
  // Offline writer (read-only state)
  {
    const { byId, fireWin, step } = setupMobilePaste({ token: "t-cy", clipboard: { async read() { return []; } } });
    fireWin("offline");
    step(2);
    const topPaste = find(byId.topbar, e => e.getAttribute("data-action") === "paste");
    expect(topPaste).toBeTruthy();
    expect(topPaste.disabled).toBe(true);
    const overflow = find(byId.topbar, e => e.className.includes("overflow-btn"));
    overflow.click();
    step(2);
    expect(find(byId.sheet, e => e.getAttribute("data-action") === "paste")?.disabled).toBe(true);
    expect(find(byId.sheet, e => e.getAttribute("data-action") === "media")?.disabled).toBe(true);
  }
});

test("Missing clipboard.read falls back to readText for text, or toasts pointing to Photo / Video", async () => {
  // readText fallback works for Mermaid / text
  {
    const clipboard = {
      async readText() { return "flowchart LR\n  A[Start] --> B[End]"; },
    };
    const { byId, S, step } = setupMobilePaste({ token: "t-ada", clipboard });
    find(byId.topbar, e => e.getAttribute("data-action") === "paste").click();
    await waitUntil(() => S.eds.board.doc.live().length > 0, step);
    expect(S.eds.board.doc.live().length).toBeGreaterThan(0);
  }
  // No clipboard API at all -> friendly toast pointing to Photo / Video
  {
    const { byId, step } = setupMobilePaste({ token: "t-ada", clipboard: undefined });
    find(byId.topbar, e => e.getAttribute("data-action") === "paste").click();
    await waitUntil(() => !byId.toast.hidden, step);
    expect(byId.toast.hidden).toBe(false);
    expect(byId.toast.textContent).toContain("Photo / Video");
  }
});
