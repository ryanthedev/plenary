// Web adapter Excalidraw interoperability tests:
// - .excalidraw export (exportExcalidraw + Export dialog chip & download)
// - .excalidraw file import via #picker and drag-and-drop (with image SHA-1 re-hash & S.uploadBlob)
// - Direct clipboard interop (desktop copy/paste + mobile Paste button) for excalidraw/clipboard & excalidraw v2 JSON.
import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { exportExcalidraw } from "../../web/adapters/dom/export.js";
import { Doc } from "../../packages/core/doc.js";
import { makeElement } from "../../packages/core/model.js";
import { isSha1 } from "../../packages/protocol/envelope.js";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG.split(",")[1], "base64"));
const TINY_PNG_SHA1 = new Bun.CryptoHasher("sha1").update(TINY_PNG_BYTES).digest("hex");

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
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 1280; this.height = 800;
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
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport", "navigator", "Image"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
const origCreateObjectURL = URL.createObjectURL;
const origRevokeObjectURL = URL.revokeObjectURL;

class StubImage {
  constructor() { this.naturalWidth = 100; this.naturalHeight = 100; this.complete = true; }
  set src(v) { this._src = v; queueMicrotask(() => this.onload?.()); }
  get src() { return this._src; }
}

afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
});

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-vi": { user: "vi", role: "viewer" },
};

async function waitUntil(pred, step, maxMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    step?.(1);
    if (pred()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  step?.(1);
}

function setupApp({ token = "t-ada", clipboard = undefined } = {}) {
  let frames = [];
  const docL = {};
  const downloads = [];
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const doc = {
    body, documentElement: new E("html"), activeElement: board, visibilityState: "visible",
    createElement: t => {
      const el = new E(t);
      if (t === "a") {
        const origClick = el.click.bind(el);
        el.click = () => { downloads.push({ href: el.href ?? el.attrs.href, download: el.download ?? el.attrs.download }); origClick(); };
      }
      return el;
    },
    createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 1, Image: StubImage,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    addEventListener: () => {},
    removeEventListener: () => {},
    visualViewport: undefined,
  });

  const blobUrls = new Map();
  URL.createObjectURL = blob => { const u = `blob:test/${blobUrls.size + 1}`; blobUrls.set(u, blob); return u; };
  URL.revokeObjectURL = () => {};

  const room = localRoom({ board: "demo-board", users: USERS, clock: true });
  const uploaded = [];
  const uploadBlob = async (url, bytes, mimeType) => { uploaded.push({ url, bytes, mimeType }); };
  const appNet = {
    kind: "ws",
    onFile() {},
    put() {},
    want() {},
    uploadBlob,
  };
  const app = mountApp({
    startSession: ({ mine, onChange }) => {
      const s = createSession({
        join: () => room.join(),
        uploadBlob,
        token, board: "demo-board",
        client: USERS[token].user, user: USERS[token].user,
        mine, onChange, clock: room.clock,
      });
      s.connection.requestBlobUrl = async sha1 => `https://blobs.test/put/${sha1}`;
      return s;
    },
    net: appNet, board: "demo-board", me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(), theme: "light", clock: room.clock,
  });

  const step = (n = 5) => {
    for (let i = 0; i < n; i++) {
      while (room.step());
      room.advance(16);
      while (room.step());
      const fns = frames; frames = [];
      for (const fn of fns) fn();
    }
  };
  step(5);

  const fireDoc = (type, ev = {}) => {
    const e = { target: board, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
    for (const fn of docL[type] ?? []) fn(e);
    return e;
  };
  return { app, byId, step, fireDoc, uploaded, downloads, blobUrls };
}

test("web/index.html #picker accepts .excalidraw files", () => {
  const html = readFileSync(join(import.meta.dir, "../../web/index.html"), "utf8");
  const m = html.match(/id="picker"[^>]*accept="([^"]+)"/);
  expect(m).toBeTruthy();
  expect(m[1]).toContain(".excalidraw");
  expect(m[1]).toContain(".excalidrawlib");
});

test("exportExcalidraw produces valid Excalidraw v2 JSON with embedded image files and page color", () => {
  const rect = makeElement("rectangle", { id: "r1", x: 10, y: 20, width: 100, height: 60 });
  const img = makeElement("image", { id: "i1", x: 150, y: 20, width: 80, height: 80, fileId: TINY_PNG_SHA1 });
  const doc = new Doc({
    elements: [rect, img],
    appState: { viewBackgroundColor: "#111113" },
    files: { [TINY_PNG_SHA1]: { id: TINY_PNG_SHA1, mimeType: "image/png", dataURL: TINY_PNG, created: 100 } },
  });

  const boardJson = JSON.parse(exportExcalidraw(doc, { page: "board", theme: "dark" }));
  expect(boardJson.type).toBe("excalidraw");
  expect(boardJson.version).toBe(2);
  expect(boardJson.appState.viewBackgroundColor).toBe("#111113");
  expect(boardJson.elements.length).toBe(2);
  expect(boardJson.files[TINY_PNG_SHA1].dataURL).toBe(TINY_PNG);

  const whiteJson = JSON.parse(exportExcalidraw(doc, { page: "white", theme: "dark" }));
  expect(whiteJson.appState.viewBackgroundColor).toBe("#ffffff");
});

test("Export dialog offers .excalidraw format chip and downloads valid .excalidraw JSON", async () => {
  const { app, byId, step, downloads, blobUrls } = setupApp();
  app.S.act("board", ed => ed.insertElements([makeElement("rectangle", { id: "r1", x: 10, y: 10, width: 120, height: 80 })]));
  step(5);

  app.openDialog("export");
  step(5);

  const exChip = byId.dialogs.all().find(el => el.tagName === "BUTTON" && el.textContent === ".excalidraw");
  expect(exChip).toBeTruthy();
  exChip.click();
  step(5);

  expect(app.ui.export.format).toBe("excalidraw");
  // Scale row is hidden for .excalidraw format
  expect(byId.dialogs.textContent).not.toContain("2×");

  const dlBtn = byId.dialogs.all().find(el => el.tagName === "BUTTON" && el.textContent === "Download");
  expect(dlBtn).toBeTruthy();
  dlBtn.click();
  await waitUntil(() => downloads.length > 0, step);

  expect(downloads.length).toBe(1);
  expect(downloads[0].download).toBe("demo-board.excalidraw");
  const blob = blobUrls.get(downloads[0].href);
  expect(blob).toBeTruthy();
  const parsed = JSON.parse(await blob.text());
  expect(parsed.type).toBe("excalidraw");
  expect(parsed.version).toBe(2);
  expect(parsed.elements.length).toBe(1);
});

test("#picker and canvas drag-and-drop import .excalidraw files, re-hash & upload embedded images via S.uploadBlob", async () => {
  const { app, byId, step, uploaded } = setupApp();
  const payload = JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "orig-rect", type: "rectangle", x: 10, y: 20, width: 120, height: 80, version: 5000, versionNonce: 1 },
      { id: "orig-img", type: "image", x: 160, y: 20, width: 100, height: 100, fileId: "ex-file-key", version: 5000, versionNonce: 2 },
    ],
    files: {
      "ex-file-key": { id: "ex-file-key", mimeType: "image/png", dataURL: TINY_PNG, created: 1000 },
    },
  });

  // 1. Import via #picker
  byId.picker.files = [{ name: "diagram.excalidraw", type: "application/json", text: async () => payload }];
  byId.picker.fire("change");
  await waitUntil(() => app.S.eds.board.doc.live().length === 2, step);

  expect(uploaded.length).toBe(1);
  expect(uploaded[0].url).toBe(`https://blobs.test/put/${TINY_PNG_SHA1}`);
  expect(uploaded[0].mimeType).toBe("image/png");
  const imgEl = app.S.eds.board.doc.live().find(e => e.type === "image");
  expect(imgEl.fileId).toBe(TINY_PNG_SHA1);
  expect(isSha1(imgEl.fileId)).toBe(true);
  expect(app.S.eds.board.doc.files[TINY_PNG_SHA1].dataURL).toBe(TINY_PNG);
  expect(byId.toast.textContent).toContain("Imported 2 elements from diagram.excalidraw");

  // 2. Import again via drag-and-drop onto #canvas (IDs must remap with zero collisions)
  byId.canvas.fire("drop", {
    clientX: 400, clientY: 300,
    dataTransfer: {
      files: [{ name: "drop.excalidraw", type: "application/json", text: async () => payload }],
    },
  });
  await waitUntil(() => app.S.eds.board.doc.live().length === 4, step);
  expect(new Set(app.S.eds.board.doc.live().map(e => e.id)).size).toBe(4);
});

test("desktop copy/paste and mobile pasteFromClipboard round-trip excalidraw/clipboard with images", async () => {
  const clipPayload = JSON.stringify({
    type: "excalidraw/clipboard",
    elements: [
      { id: "c-rect", type: "rectangle", x: 0, y: 0, width: 140, height: 70, boundElements: [{ id: "c-lbl", type: "text" }] },
      { id: "c-lbl", type: "text", x: 10, y: 20, width: 120, height: 24, text: "From Excalidraw", containerId: "c-rect" },
      { id: "c-img", type: "image", x: 200, y: 0, width: 80, height: 80, fileId: "clip-img-1" },
    ],
    files: {
      "clip-img-1": { id: "clip-img-1", mimeType: "image/png", dataURL: TINY_PNG, created: 1000 },
    },
  });

  const { app, step, fireDoc, uploaded } = setupApp();

  // Desktop paste event with excalidraw/clipboard JSON containing an image
  fireDoc("paste", {
    clipboardData: {
      files: [],
      getData: type => (type === "text/plain" ? clipPayload : ""),
    },
  });
  await waitUntil(() => app.S.eds.board.doc.live().length === 3, step);

  expect(uploaded.length).toBe(1);
  const pastedImg = app.S.eds.board.doc.live().find(e => e.type === "image");
  expect(pastedImg.fileId).toBe(TINY_PNG_SHA1);

  // Desktop copy event writes valid excalidraw/clipboard JSON
  let copied = null;
  fireDoc("copy", {
    clipboardData: { setData: (type, val) => { if (type === "text/plain") copied = val; } },
  });
  expect(copied).toBeTruthy();
  const parsedCopy = JSON.parse(copied);
  expect(parsedCopy.type).toBe("excalidraw/clipboard");
  expect(parsedCopy.elements.length).toBe(3); // rect + bound label + image
  expect(parsedCopy.files[TINY_PNG_SHA1].dataURL).toBe(TINY_PNG);
});
