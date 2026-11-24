// Unit and integration tests for the 4 DOM adapter sub-modules extracted from web/adapters/dom/app.js:
// - importers.js (decodeDataUrlBytes, addPicture, probeVideoMeta, addVideoFile, Excalidraw/Draw.io/Library/takeFiles)
// - board-dialogs.js (mermaidPreview, exportPreview, download, render, rebuildDialog, deactivate)
// - version-restore.js (parseSnapshotHerdr, restoreVersionSnapshot)
// - focus-restore.js (isVisibleControl, captureOpener, findByAriaLabel, restoreOpener, visibleControl, createFocusRestorer)

import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { Editor } from "../../packages/core/editor.js";
import { BASE_LAYER, makeElement } from "../../packages/core/model.js";
import { imageCache } from "../../web/adapters/dom/paint.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { isHelpDialogOpen } from "../../web/adapters/dom/help-dialog.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { RASTER, VIDEO_MIME, MAX_VIDEO_BYTES, decodeDataUrlBytes, createImporters } from "../../web/adapters/dom/importers.js";
import { createBoardDialogs } from "../../web/adapters/dom/board-dialogs.js";
import { parseSnapshotHerdr, restoreVersionSnapshot } from "../../web/adapters/dom/version-restore.js";
import {
  isVisibleControl,
  captureOpener,
  findByAriaLabel,
  restoreOpener,
  visibleControl,
  createFocusRestorer,
} from "../../web/adapters/dom/focus-restore.js";

const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TINY_PNG = `data:image/png;base64,${TINY_PNG_B64}`;
const TINY_PNG_BYTES = Uint8Array.from(Buffer.from(TINY_PNG_B64, "base64"));
const TINY_PNG_SHA1 = new Bun.CryptoHasher("sha1").update(TINY_PNG_BYTES).digest("hex");

const SAMPLE_DRAWIO = `<mxfile host="app.diagrams.net">
  <diagram id="d1" name="Flow">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="Service" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="20" y="20" width="120" height="60" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

// ── Minimal self-contained DOM stub ──
let activeDoc = null;

class StubNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof StubNode ? n : new StubText(String(n));
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    node.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get isConnected() {
    let cur = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur === activeDoc?.body || cur === activeDoc?.documentElement;
  }
  get textContent() {
    return this.childNodes.map(c => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(new StubText(String(v)));
  }
}

class StubText extends StubNode {
  constructor(data) {
    super(3);
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}

class StubElement extends StubNode {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.id = "";
    this.className = "";
    this.attrs = {};
    this.dataset = {};
    this.style = {
      setProperty(k, v) { this[k] = v; },
      getPropertyValue(k) { return this[k] ?? ""; },
    };
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this.width = 300;
    this.height = 180;
    this.offsetParent = {};
    this.clicks = 0;
    this.drawCalls = [];
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).filter(Boolean).includes(c),
      add: c => self.classList.toggle(c, true),
      remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on ?? !s.has(c)) s.add(c);
        else s.delete(c);
        self.className = [...s].join(" ");
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn);
  }
  fire(type, ev = {}) {
    const event = {
      target: this,
      currentTarget: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...ev,
    };
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
    return event;
  }
  click() {
    if (!this.disabled) {
      this.clicks++;
      this.fire("click");
    }
  }
  focus() {
    if (activeDoc) activeDoc.activeElement = this;
  }
  blur() {
    if (activeDoc && activeDoc.activeElement === this) activeDoc.activeElement = activeDoc.body;
  }
  setPointerCapture() {}
  setSelectionRange() {}
  select() {}
  after(node) {
    this.parentNode?.append(node);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };
  }
  contains(node) {
    for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true;
    return false;
  }
  closest(sel) {
    for (let cur = this; cur; cur = cur.parentNode) {
      if (sel.startsWith("#") && cur.id === sel.slice(1)) return cur;
      if (sel.startsWith(".") && cur.classList?.contains(sel.slice(1))) return cur;
    }
    return null;
  }
  get children() {
    return this.childNodes.filter(c => c.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get href() {
    return this.attrs.href;
  }
  set href(v) {
    this.attrs.href = String(v);
  }
  all() {
    return [this, ...this.children.flatMap(c => c.all())];
  }
  getContext() {
    const self = this;
    return new Proxy({}, {
      get: (_, prop) => {
        if (prop === "measureText") return t => ({ width: String(t).length * 7 });
        if (prop === "getImageData") return () => ({ data: [] });
        if (prop === "createLinearGradient") return () => ({ addColorStop() {} });
        if (prop === "createPattern") return () => null;
        return (...args) => {
          self.drawCalls.push({ op: String(prop), args });
        };
      },
      set: () => true,
    });
  }
  toBlob(cb, mime = "image/png") {
    cb(new Blob(["png-bytes"], { type: mime }));
  }
}

function makeStubDoc({ createVideo = null } = {}) {
  const body = new StubElement("body");
  const documentElement = new StubElement("html");
  documentElement.append(body);
  const topbar = new StubElement("div"); topbar.setAttribute("id", "topbar");
  const dock = new StubElement("div"); dock.setAttribute("id", "dock");
  const hudBL = new StubElement("div"); hudBL.setAttribute("id", "hudBL");
  const dialogs = new StubElement("div"); dialogs.setAttribute("id", "dialogs");
  const canvas = new StubElement("canvas"); canvas.setAttribute("id", "board");
  body.append(topbar, dock, hudBL, dialogs, canvas);
  const doc = {
    body,
    documentElement,
    activeElement: null,
    createElement(tag) {
      if (tag === "video" && createVideo) return createVideo();
      return new StubElement(tag);
    },
    createTextNode(t) {
      return new StubText(t);
    },
    querySelector(sel) {
      if (sel.startsWith("#")) {
        const id = sel.slice(1);
        return body.all().find(e => e.id === id) ?? null;
      }
      if (/^\[([^\]]+)\]$/.test(sel)) {
        const attr = sel.slice(1, -1);
        return body.all().find(e => e.hasAttribute(attr)) ?? null;
      }
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        return body.all().find(e => e.classList.contains(cls)) ?? null;
      }
      return null;
    },
  };
  activeDoc = doc;
  return { doc, body, topbar, dock, hudBL, dialogs, canvas };
}

const SAVED_GLOBALS = [
  "document", "Node", "FileReader", "Image", "navigator", "open", "window",
  "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame",
  "addEventListener", "removeEventListener", "getSelection",
];
const savedDescriptors = Object.fromEntries(SAVED_GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
const origCreateObjectURL = URL.createObjectURL;
const origRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  activeDoc = null;
  for (const k of SAVED_GLOBALS) {
    if (savedDescriptors[k]) Object.defineProperty(globalThis, k, savedDescriptors[k]);
    else delete globalThis[k];
  }
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
});

afterAll(() => {
  activeDoc = null;
  for (const k of SAVED_GLOBALS) {
    if (savedDescriptors[k]) Object.defineProperty(globalThis, k, savedDescriptors[k]);
    else delete globalThis[k];
  }
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
});

function makeFakeSession({ role = "presenter", may = true, withUploadBlob = true } = {}) {
  const boardEd = new Editor();
  const notesEd = new Editor();
  const uploads = [];
  const addedPictures = [];
  const addedVideos = [];
  const pastes = [];
  let canWrite = may;
  const S = {
    role,
    active: "board",
    eds: { board: boardEd, notes: notesEd },
    may: () => canWrite,
    setMay(v) { canWrite = v; },
    act(stream, fn) {
      if (!canWrite) return false;
      const ed = stream === "notes" ? notesEd : boardEd;
      fn(ed);
      return true;
    },
    ...(withUploadBlob ? {
      async uploadBlob(id, bytes, mime) {
        uploads.push({ id, bytes, mime });
      },
    } : {}),
    addPicture(f, at) {
      addedPictures.push({ f, at });
      return true;
    },
    addVideo(f, at) {
      addedVideos.push({ f, at });
      return true;
    },
    paste(text, at) {
      pastes.push({ text, at });
    },
  };
  return { S, boardEd, notesEd, uploads, addedPictures, addedVideos, pastes };
}

// ── 1. importers.js ──

describe("web/adapters/dom/importers.js", () => {
  test("decodeDataUrlBytes decodes valid/whitespace base64 and rejects malformed input", () => {
    expect(decodeDataUrlBytes(TINY_PNG)).toEqual(TINY_PNG_BYTES);
    const spaced = `data:image/png;base64, ${TINY_PNG_B64.slice(0, 12)}\n  ${TINY_PNG_B64.slice(12)} `;
    expect(decodeDataUrlBytes(spaced)).toEqual(TINY_PNG_BYTES);
    expect(decodeDataUrlBytes("not-a-data-url")).toBeNull();
    expect(decodeDataUrlBytes("data:image/png;base64,!!!invalid!!!")).toBeNull();
    expect(decodeDataUrlBytes(/** @type {any} */ (null))).toBeNull();
  });

  test("addPicture validates MIME/size, SHA-1 hashes, and uploads via uploadBlob or net.put", async () => {
    const clock = virtualClock({ t0: 1000 });
    const toasts = [];
    const { S, uploads, addedPictures } = makeFakeSession({ withUploadBlob: true });
    const putCalls = [];
    let library = [];
    let dirtyCount = 0;

    globalThis.FileReader = /** @type {any} */ (class {
      readAsDataURL() { queueMicrotask(() => { this.result = TINY_PNG; this.onload?.(); }); }
    });
    globalThis.Image = /** @type {any} */ (class {
      constructor() { this.naturalWidth = 64; this.naturalHeight = 32; }
      set src(_v) { queueMicrotask(() => this.onload?.()); }
    });

    const importers = createImporters({
      S,
      net: /** @type {any} */ ({ uploadBlob: async () => {}, put: f => putCalls.push(f) }),
      clock,
      toast: (msg, ms) => toasts.push({ msg, ms }),
      getLibrary: () => library,
      setLibrary: items => { library = items; },
      onDirty: () => { dirtyCount++; },
    });

    await importers.addPicture(new Blob(["<svg/>"], { type: "image/svg+xml" }));
    expect(toasts.at(-1).msg).toBe("Pictures: PNG, JPEG, GIF or WebP");

    await importers.addPicture({ type: "image/png", size: 10 * 1024 * 1024 + 1 });
    expect(toasts.at(-1).msg).toBe("Pictures are limited to 10 MB");

    const pngBlob = new Blob([TINY_PNG_BYTES], { type: "image/png" });
    await importers.addPicture(pngBlob, { x: 10, y: 20 });
    expect(uploads.length).toBe(1);
    expect(uploads[0].id).toBe(TINY_PNG_SHA1);
    expect(addedPictures.length).toBe(1);
    expect(addedPictures[0].f).toMatchObject({ id: TINY_PNG_SHA1, mimeType: "image/png", width: 64, height: 32 });
    expect(addedPictures[0].at).toEqual({ x: 10, y: 20 });
    expect(putCalls.length).toBe(0);
    expect(dirtyCount).toBe(1);

    // Without net.uploadBlob, falls back to net.put
    const fallback = makeFakeSession({ withUploadBlob: false });
    const fallbackImporters = createImporters({
      S: fallback.S,
      net: /** @type {any} */ ({ put: f => putCalls.push(f) }),
      clock,
      toast: (msg, ms) => toasts.push({ msg, ms }),
      getLibrary: () => library,
      setLibrary: () => {},
      onDirty: () => { dirtyCount++; },
    });
    await fallbackImporters.addPicture(pngBlob);
    expect(fallback.addedPictures.length).toBe(1);
    expect(putCalls.length).toBe(1);
    expect(putCalls[0].id).toBe(TINY_PNG_SHA1);

    // Upload failure shows toast and never calls S.addPicture
    const failSession = makeFakeSession({ withUploadBlob: true });
    failSession.S.uploadBlob = async () => { throw new Error("network"); };
    const failImporters = createImporters({
      S: failSession.S,
      net: /** @type {any} */ ({ uploadBlob: async () => {} }),
      clock,
      toast: (msg, ms) => toasts.push({ msg, ms }),
      getLibrary: () => library,
      setLibrary: () => {},
      onDirty: () => {},
    });
    await failImporters.addPicture(pngBlob);
    expect(toasts.at(-1).msg).toBe("Picture upload failed");
    expect(failSession.addedPictures.length).toBe(0);

    // Permission revoked mid-async aborts before adding
    const revokingSession = makeFakeSession({ withUploadBlob: true });
    globalThis.Image = /** @type {any} */ (class {
      constructor() { this.naturalWidth = 10; this.naturalHeight = 10; }
      set src(_v) {
        revokingSession.S.setMay(false);
        queueMicrotask(() => this.onload?.());
      }
    });
    const revokeImporters = createImporters({
      S: revokingSession.S,
      net: /** @type {any} */ ({ uploadBlob: async () => {} }),
      clock,
      toast: () => {},
      getLibrary: () => [],
      setLibrary: () => {},
      onDirty: () => {},
    });
    await revokeImporters.addPicture(pngBlob);
    expect(revokingSession.addedPictures.length).toBe(0);
  });

  test("probeVideoMeta & addVideoFile use virtual clock (loadedmetadata, onerror, 3s timeout, size/MIME limits)", async () => {
    const clock = virtualClock({ t0: 5000 });
    const toasts = [];
    const { S, uploads, addedVideos } = makeFakeSession({ withUploadBlob: true });
    let lastVideoEl = null;
    let onVideoCreated = null;
    const { doc } = makeStubDoc({
      createVideo: () => {
        lastVideoEl = {
          preload: "",
          muted: false,
          playsInline: false,
          videoWidth: 0,
          videoHeight: 0,
          onloadedmetadata: null,
          onerror: null,
          removeAttribute() {},
          set src(v) { this._src = v; },
          get src() { return this._src; },
        };
        onVideoCreated?.(lastVideoEl);
        return lastVideoEl;
      },
    });

    const importers = createImporters({
      S,
      net: /** @type {any} */ ({ uploadBlob: async () => {} }),
      clock,
      toast: (msg, ms) => toasts.push({ msg, ms }),
      getLibrary: () => [],
      setLibrary: () => {},
      onDirty: () => {},
      doc: /** @type {any} */ (doc),
    });

    // loadedmetadata path clears virtual clock timer
    const metaP = importers.probeVideoMeta("blob:ok");
    expect(clock.pending).toBe(1);
    lastVideoEl.videoWidth = 1280;
    lastVideoEl.videoHeight = 720;
    lastVideoEl.onloadedmetadata();
    expect(await metaP).toEqual({ width: 1280, height: 720 });
    expect(clock.pending).toBe(0);

    // onerror falls back to 480x270 and clears timer
    const errP = importers.probeVideoMeta("blob:err");
    expect(clock.pending).toBe(1);
    lastVideoEl.onerror();
    expect(await errP).toEqual({ width: 480, height: 270 });
    expect(clock.pending).toBe(0);

    // 3000ms virtual clock timeout falls back to 480x270
    const timeoutP = importers.probeVideoMeta("blob:hang");
    expect(clock.pending).toBe(1);
    clock.advance(3000);
    expect(await timeoutP).toEqual({ width: 480, height: 270 });
    expect(clock.pending).toBe(0);

    // Rejects non-video MIME and >50MB video
    expect(VIDEO_MIME.test("video/mp4")).toBe(true);
    expect(RASTER.test("image/png")).toBe(true);
    await importers.addVideoFile(new Blob(["nope"], { type: "video/x-msvideo" }));
    expect(toasts.at(-1).msg).toBe("Videos: MP4, WebM or QuickTime");
    await importers.addVideoFile({ type: "video/mp4", size: MAX_VIDEO_BYTES + 1 });
    expect(toasts.at(-1).msg).toBe("Videos are limited to 50 MB");

    // Valid video upload
    URL.createObjectURL = () => "blob:vid";
    URL.revokeObjectURL = () => {};
    lastVideoEl = null;
    const createdP = new Promise(r => { onVideoCreated = r; });
    const vidBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" });
    const addVidP = importers.addVideoFile(vidBlob, { x: 5, y: 6 });
    const v = await createdP;
    v.videoWidth = 640;
    v.videoHeight = 360;
    v.onloadedmetadata();
    await addVidP;
    expect(uploads.length).toBe(1);
    expect(addedVideos.length).toBe(1);
    expect(addedVideos[0].f).toMatchObject({ mimeType: "video/mp4", width: 640, height: 360 });
  });

  test("prepareExcalidrawFiles, importExcalidrawParsed, pasteText, addDrawioFile, addLibraryFile, and takeFiles", async () => {
    const clock = virtualClock({ t0: 2000 });
    const toasts = [];
    const { S, boardEd, uploads, pastes } = makeFakeSession({ withUploadBlob: true });
    let library = [];
    let dirtyCount = 0;

    const importers = createImporters({
      S,
      net: /** @type {any} */ ({ uploadBlob: async () => {}, put: () => {} }),
      clock,
      toast: (msg, ms) => toasts.push({ msg, ms }),
      getLibrary: () => library,
      setLibrary: next => { library = next; },
      onDirty: () => { dirtyCount++; },
    });

    const excalidrawJson = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "img-1", type: "image", x: 10, y: 20, width: 100, height: 80, fileId: "legacy-file-id" },
      ],
      files: {
        "legacy-file-id": { id: "legacy-file-id", mimeType: "image/png", dataURL: TINY_PNG },
      },
    });

    // pasteText detects excalidraw JSON with embedded image and re-hashes fileId -> SHA-1
    const pasted = await importers.pasteText(excalidrawJson, { x: 100, y: 100 });
    expect(pasted).toBe(true);
    expect(uploads.length).toBe(1);
    expect(uploads[0].id).toBe(TINY_PNG_SHA1);
    const liveImg = boardEd.doc.live().find(e => e.type === "image");
    expect(liveImg).toBeTruthy();
    expect(liveImg.fileId).toBe(TINY_PNG_SHA1);

    // Plain text falls back to S.paste
    expect(importers.pasteText("hello world", { x: 0, y: 0 })).toBe(true);
    expect(pastes.at(-1)).toEqual({ text: "hello world", at: { x: 0, y: 0 } });

    // Read-only session (!S.may()) returns false without calling onDirty()
    const dirtyBeforeNoMay = dirtyCount;
    const noImageExcalidraw = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [{ id: "r-nomay", type: "rectangle", x: 0, y: 0, width: 40, height: 30 }],
      files: {},
    });
    S.setMay(false);
    expect(importers.pasteText(noImageExcalidraw, { x: 10, y: 10 })).toBe(false);
    expect(importers.pasteText("blocked text", { x: 10, y: 10 })).toBe(false);
    expect(dirtyCount).toBe(dirtyBeforeNoMay);
    S.setMay(true);

    // addDrawioFile rejects invalid XML and imports valid Draw.io
    expect(await importers.addDrawioFile(/** @type {any} */ ({ name: "bad.drawio", size: 10, text: async () => "not xml" }))).toBe(false);
    expect(toasts.at(-1).msg).toBe("That isn't a valid .drawio file");

    const beforeCount = boardEd.doc.live().length;
    const okDrawio = await importers.addDrawioFile(/** @type {any} */ ({ name: "arch.drawio", size: SAMPLE_DRAWIO.length, text: async () => SAMPLE_DRAWIO }));
    expect(okDrawio).toBe(true);
    expect(boardEd.doc.live().length).toBeGreaterThan(beforeCount);
    expect(toasts.at(-1).msg).toContain("from arch.drawio");

    // addLibraryFile merges into library
    const libJson = JSON.stringify({
      type: "excalidrawlib",
      version: 2,
      libraryItems: [{ id: "lib-1", status: "published", name: "Box", elements: [{ id: "r1", type: "rectangle", x: 0, y: 0, width: 50, height: 50 }] }],
    });
    await importers.addLibraryFile(/** @type {any} */ ({ name: "shapes.excalidrawlib", text: async () => libJson }));
    expect(library.length).toBe(1);
    expect(toasts.at(-1).msg).toBe("Library: 1 added");

    // takeFiles dispatches by extension
    await importers.takeFiles([
      /** @type {any} */ ({ name: "more.excalidrawlib", text: async () => libJson }),
      /** @type {any} */ ({ name: "diagram.xml", size: SAMPLE_DRAWIO.length, text: async () => SAMPLE_DRAWIO }),
    ]);
    await Promise.resolve();
    expect(dirtyCount).toBeGreaterThan(0);
  });
});

// ── 2. board-dialogs.js ──

describe("web/adapters/dom/board-dialogs.js", () => {
  function setupBoardDialogs({ role = "presenter", may = true } = {}) {
    const clock = virtualClock({ t0: 1000 });
    const { doc, body, dialogs, canvas } = makeStubDoc();
    globalThis.document = /** @type {any} */ (doc);
    globalThis.Node = /** @type {any} */ (StubNode);
    const { S, boardEd } = makeFakeSession({ role, may });
    boardEd.transact(tx => {
      tx.add(makeElement("frame", { id: "fr-1", x: 0, y: 0, width: 400, height: 300, name: "Intro" }));
      tx.add(makeElement("rectangle", { x: 20, y: 20, width: 100, height: 60 }));
      return true;
    });
    const ui = {
      theme: "light",
      dialog: null,
      mermaid: { src: "flowchart LR\n  A-->B", elbow: true },
      embed: { url: "", error: "" },
      export: { format: "svg", scale: 2, page: "board", frameId: null },
    };
    const toasts = [];
    let opener = { el: canvas, label: "Board", rootId: null, dockMore: false };
    let pendingFocus = null;
    let dirty = 0;
    let shareOpen = false;
    const restored = [];
    const image = imageCache(() => ({}), () => {});
    const ctrl = createBoardDialogs({
      S,
      ui,
      board: "b-test-123",
      canvas: /** @type {any} */ (canvas),
      image,
      clock,
      toast: (msg, ms) => toasts.push({ msg, ms }),
      displayBoardTitle: () => "Demo Board",
      getDialogsContainer: () => /** @type {any} */ (dialogs),
      getChromeRoots: () => [/** @type {any} */ (dialogs)],
      isShareOpen: () => shareOpen,
      getOpener: () => opener,
      clearOpener: () => { opener = null; },
      restoreOpener: (saved, fallback) => restored.push({ saved, fallback }),
      setPendingFocus: held => { pendingFocus = held; },
      onDirty: () => { dirty++; },
      doc: /** @type {any} */ (doc),
    });
    return {
      clock,
      doc,
      body,
      dialogs,
      canvas,
      S,
      boardEd,
      ui,
      toasts,
      ctrl,
      restored,
      setShareOpen: v => { shareOpen = v; },
      getPendingFocus: () => pendingFocus,
      getDirty: () => dirty,
    };
  }

  test("mermaidPreview returns true on valid flowchart and false with error on invalid syntax", () => {
    const { ctrl, ui } = setupBoardDialogs();
    const cv1 = new StubElement("canvas");
    expect(ctrl.mermaidPreview(/** @type {any} */ (cv1))).toBe(true);
    expect(cv1.drawCalls.length).toBeGreaterThan(0);

    ui.mermaid.src = "not valid mermaid";
    const cv2 = new StubElement("canvas");
    expect(ctrl.mermaidPreview(/** @type {any} */ (cv2))).toBe(false);
    expect(cv2.drawCalls.some(c => c.op === "fillText")).toBe(true);
  });

  test("render clears dialogs for non-presenters and guards against activeElement inside #dialogs", () => {
    const { ctrl, ui, S, dialogs, doc, getPendingFocus } = setupBoardDialogs({ role: "viewer" });
    ui.dialog = "export";
    ctrl.render();
    expect(ui.dialog).toBeNull();
    expect(dialogs.childNodes.length).toBe(0);

    // Presenter opens export dialog
    S.role = "presenter";
    ui.dialog = "export";
    ctrl.render();
    expect(dialogs.childNodes.length).toBe(1);

    // Active element inside #dialogs skips rebuild
    const selectEl = dialogs.all().find(e => e.tagName === "SELECT" || e.tagName === "BUTTON");
    expect(selectEl).toBeTruthy();
    doc.activeElement = selectEl;
    const prevFirst = dialogs.firstChild;
    ctrl.render();
    expect(dialogs.firstChild).toBe(prevFirst);

    // Clicking a format chip calls rebuildDialog -> clears #dialogs and captures pendingFocus
    const pngChip = dialogs.all().find(e => e.tagName === "BUTTON" && e.textContent === "PNG");
    expect(pngChip).toBeTruthy();
    pngChip.click();
    expect(ui.export.format).toBe("png");
    expect(dialogs.childNodes.length).toBe(0);
    expect(getPendingFocus()).toBeTruthy();
    ctrl.render();
    expect(dialogs.childNodes.length).toBe(1);
    ctrl.deactivate();
  });

  test("embed dialog validates URLs, handles clipboard paste states, and submits valid embed", async () => {
    const { ctrl, ui, dialogs, boardEd, restored } = setupBoardDialogs();
    ui.dialog = "embed";
    ctrl.render();

    const submitBtn = dialogs.all().find(e => e.getAttribute("data-action") === "embed-submit");
    const pasteBtn = dialogs.all().find(e => e.getAttribute("data-action") === "embed-paste");
    const urlInput = dialogs.all().find(e => e.tagName === "INPUT");
    const errEl = dialogs.all().find(e => e.getAttribute("role") === "alert");

    // Invalid URL triggers alert error
    ui.embed.url = "http://insecure.example.com/pic.png";
    submitBtn.click();
    expect(ui.embed.error).toContain("HTTPS URL");
    expect(errEl.hidden).toBe(false);

    // Missing clipboard
    globalThis.navigator = /** @type {any} */ ({});
    await pasteBtn.fire("click");
    expect(ui.embed.error).toContain("Clipboard unavailable");

    // Empty clipboard
    globalThis.navigator = /** @type {any} */ ({ clipboard: { readText: async () => "   " } });
    await pasteBtn.fire("click");
    expect(ui.embed.error).toBe("Clipboard is empty.");

    // Denied clipboard
    globalThis.navigator = /** @type {any} */ ({ clipboard: { readText: async () => { throw new Error("denied"); } } });
    await pasteBtn.fire("click");
    expect(ui.embed.error).toContain("denied");

    // Valid clipboard URL + submit
    globalThis.navigator = /** @type {any} */ ({ clipboard: { readText: async () => "https://cdn.example.com/demo.png" } });
    await pasteBtn.fire("click");
    expect(urlInput.value).toBe("https://cdn.example.com/demo.png");
    expect(ui.embed.error).toBe("");

    submitBtn.click();
    expect(ui.dialog).toBeNull();
    expect(ui.embed.url).toBe("");
    expect(boardEd.doc.live().some(e => e.customData?.embed?.url === "https://cdn.example.com/demo.png")).toBe(true);
    expect(restored.length).toBe(1);
  });

  test("download exports svg/png/excalidraw and handles PDF popup vs popup-blocked fallback via virtual clock", async () => {
    const { ctrl, ui, clock, toasts, body } = setupBoardDialogs();
    const createdUrls = [];
    const revokedUrls = [];
    let seq = 0;
    URL.createObjectURL = () => {
      const u = `blob:export-${++seq}`;
      createdUrls.push(u);
      return u;
    };
    URL.revokeObjectURL = u => revokedUrls.push(u);

    // SVG download
    ui.export.format = "svg";
    await ctrl.download();
    expect(createdUrls.length).toBe(1);
    clock.advance(5000);
    expect(revokedUrls).toEqual(["blob:export-1"]);

    // Excalidraw download
    ui.export.format = "excalidraw";
    await ctrl.download();
    expect(createdUrls.length).toBe(2);

    // PNG download
    ui.export.format = "png";
    await ctrl.download();
    expect(createdUrls.length).toBe(3);

    // PDF with open popup
    let printed = 0;
    let writtenHtml = "";
    globalThis.open = /** @type {any} */ (() => ({
      document: { open() {}, write(h) { writtenHtml = h; }, close() {} },
      focus() {},
      print() { printed++; },
    }));
    ui.export.format = "pdf";
    await ctrl.download();
    expect(writtenHtml).toContain("Demo Board");
    expect(printed).toBe(0);
    clock.advance(150);
    expect(printed).toBe(1);

    // PDF popup blocked -> downloads HTML + toast
    globalThis.open = /** @type {any} */ (() => null);
    await ctrl.download();
    expect(toasts.at(-1).msg).toBe("Popup blocked — downloaded printable HTML");
    expect(body.all().filter(e => e.tagName === "A").length).toBe(0); // cleaned up after click
    clock.advance(5000);
    expect(revokedUrls).toEqual(["blob:export-1", "blob:export-2", "blob:export-3", "blob:export-4"]);
  });
});

// ── 3. version-restore.js ──

describe("web/adapters/dom/version-restore.js", () => {
  test("parseSnapshotHerdr validates malformed shapes and normalizes defaults", () => {
    expect(parseSnapshotHerdr(null)).toBeNull();
    expect(parseSnapshotHerdr(undefined)).toBeNull();
    expect(parseSnapshotHerdr("bad")).toBeNull();
    expect(parseSnapshotHerdr([])).toBeNull();
    expect(parseSnapshotHerdr({ appState: [] })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: "bad" } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { layers: [] } } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { layers: [null] } } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { layers: [{ id: "x".repeat(65) }] } } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { views: ["bad"] } } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { timeline: [] } } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { grid: -1 } } })).toBeNull();
    expect(parseSnapshotHerdr({ appState: { herdr: { grid: NaN } } })).toBeNull();

    expect(parseSnapshotHerdr({})).toEqual({
      layers: [{ id: BASE_LAYER, name: "Layer 1", visible: true, locked: false }],
      views: [],
      timeline: null,
      grid: 0,
    });

    const parsed = parseSnapshotHerdr({
      appState: {
        herdr: {
          layers: [
            { id: "l1", name: "A".repeat(100), visible: false, locked: 1 },
            { id: "l1", name: "duplicate" },
          ],
          views: [{ id: "v1", name: "Overview" }],
          timeline: { cues: [] },
          grid: 20,
        },
      },
    });
    expect(parsed.layers).toEqual([{ id: "l1", name: "A".repeat(80), visible: false, locked: true }]);
    expect(parsed.views).toEqual([{ id: "v1", name: "Overview" }]);
    expect(parsed.timeline).toEqual({ cues: [] });
    expect(parsed.grid).toBe(20);
  });

  test("restoreVersionSnapshot enforces role/may, soft-deletes absent live elements, restores with monotonic version", () => {
    const { S, boardEd } = makeFakeSession({ role: "presenter", may: true });
    const liveOnly = makeElement("rectangle", { id: "live-only", x: 0, y: 0, width: 40, height: 40, version: 2 });
    const existing = makeElement("ellipse", { id: "shared-1", x: 10, y: 10, width: 50, height: 50, version: 9 });
    boardEd.transact(tx => { tx.add(liveOnly); tx.add(existing); return true; });
    // Soft-delete `shared-1` on the live board so restore brings it back while keeping monotonic version >= 9
    boardEd.deleteIds(["shared-1"]);
    expect(boardEd.doc.get("shared-1")).toBeNull();
    boardEd.select(["live-only"]);

    const toasts = [];
    let dirty = 0;

    // Non-presenter rejected
    S.role = "viewer";
    expect(restoreVersionSnapshot({ label: "v1", snapshot: { elements: [] } }, { S, toast: m => toasts.push(m), onDirty: () => dirty++ })).toBe(false);

    // Malformed snapshot rejected
    S.role = "presenter";
    expect(restoreVersionSnapshot({ label: "v1", snapshot: { elements: "bad" } }, { S, toast: m => toasts.push(m), onDirty: () => dirty++ })).toBe(false);
    expect(restoreVersionSnapshot({ label: "v1", snapshot: { elements: [], appState: { herdr: { layers: [null] } } } }, { S, toast: m => toasts.push(m), onDirty: () => dirty++ })).toBe(false);

    // Valid restore
    const ok = restoreVersionSnapshot({
      label: "Milestone 1",
      snapshot: {
        elements: [
          { id: "shared-1", type: "ellipse", x: 200, y: 300, width: 80, height: 80, version: 3 },
          { id: "new-1", type: "rectangle", x: 50, y: 60, width: 90, height: 40, version: 1 },
        ],
        appState: { herdr: { grid: 20 } },
      },
    }, { S, toast: m => toasts.push(m), onDirty: () => dirty++ });

    expect(ok).toBe(true);
    expect(boardEd.doc.get("live-only")).toBeNull(); // soft-deleted
    const restoredShared = boardEd.doc.get("shared-1");
    expect(restoredShared).toBeTruthy();
    expect(restoredShared.isDeleted).toBe(false);
    expect(restoredShared.x).toBe(200);
    expect(restoredShared.version).toBeGreaterThanOrEqual(9);
    expect(boardEd.doc.get("new-1")?.x).toBe(50);
    expect(boardEd.grid).toBe(20);
    expect(boardEd.sel.size).toBe(0);
    expect(dirty).toBe(1);
    expect(toasts.at(-1)).toBe("Restored version: Milestone 1");
  });
});

// ── 4. focus-restore.js ──

describe("web/adapters/dom/focus-restore.js", () => {
  test("isVisibleControl checks hidden, disabled, aria-hidden, style, offsetParent, and viewport classes", () => {
    const mk = () => new StubElement("button");
    expect(isVisibleControl(null)).toBe(false);
    const hiddenEl = mk(); hiddenEl.hidden = true; expect(isVisibleControl(hiddenEl)).toBe(false);
    const disEl = mk(); disEl.disabled = true; expect(isVisibleControl(disEl)).toBe(false);
    const ariaHidden = mk(); ariaHidden.setAttribute("aria-hidden", "true"); expect(isVisibleControl(ariaHidden)).toBe(false);
    const dispNone = mk(); dispNone.style.display = "none"; expect(isVisibleControl(dispNone)).toBe(false);
    const visHidden = mk(); visHidden.style.visibility = "hidden"; expect(isVisibleControl(visHidden)).toBe(false);
    const offNull = mk(); offNull.offsetParent = null; expect(isVisibleControl(offNull)).toBe(false);

    const deskBtn = mk(); deskBtn.classList.add("desk-only");
    expect(isVisibleControl(deskBtn, { isPhone: () => false })).toBe(true);
    expect(isVisibleControl(deskBtn, { isPhone: () => true })).toBe(false);

    const moreBtn = mk(); moreBtn.classList.add("header-more");
    expect(isVisibleControl(moreBtn, { isPhone: () => true })).toBe(false);

    const phoneBtn = mk(); phoneBtn.classList.add("phone-only");
    expect(isVisibleControl(phoneBtn, { isPhone: () => false })).toBe(false);
    expect(isVisibleControl(phoneBtn, { isPhone: () => true })).toBe(true);
  });

  test("captureOpener, findByAriaLabel, restoreOpener, visibleControl, and createFocusRestorer handle cross-viewport restoration", () => {
    const { doc, topbar, dock, hudBL, canvas } = makeStubDoc();
    let phone = false;

    const topShare = new StubElement("button");
    topShare.classList.add("desk-only");
    topShare.setAttribute("aria-label", "Notes");
    topbar.append(topShare);

    const dockNotes = new StubElement("button");
    dockNotes.classList.add("phone-only");
    dockNotes.setAttribute("aria-label", "Notes");
    dock.append(dockNotes);

    const dockMore = new StubElement("button");
    dockMore.classList.add("phone-only");
    dockMore.setAttribute("data-dock-more", "1");
    dockMore.setAttribute("aria-label", "More");
    dock.append(dockMore);

    const hudBtn = new StubElement("button");
    hudBtn.setAttribute("aria-label", "Fit");
    hudBL.append(hudBtn);

    const restorer = createFocusRestorer({
      isPhone: () => phone,
      doc: /** @type {any} */ (doc),
      defaultFallback: canvas,
    });

    // captureOpener detects region and attributes
    const capTop = restorer.captureOpener(topShare);
    expect(capTop).toEqual({ el: topShare, label: "Notes", rootId: "topbar", dockMore: false });
    expect(restorer.captureOpener(hudBtn).rootId).toBe("hudBL");
    expect(restorer.captureOpener(dockMore)).toMatchObject({ rootId: "dock", dockMore: true });

    // 1) Still-connected visible opener gets focus directly
    doc.activeElement = null;
    restorer.restoreOpener(capTop);
    expect(doc.activeElement).toBe(topShare);

    // 2) After viewport switches to phone, topShare is hidden (.desk-only), so twin in #dock gets focus
    phone = true;
    doc.activeElement = null;
    restorer.restoreOpener(capTop);
    expect(doc.activeElement).toBe(dockNotes);

    // 3) dockMore flag prioritizes [data-dock-more] on phone when original node detached
    const capMore = captureOpener(dockMore, { doc: /** @type {any} */ (doc) });
    dockMore.remove();
    const newDockMore = new StubElement("button");
    newDockMore.classList.add("phone-only");
    newDockMore.setAttribute("data-dock-more", "1");
    dock.append(newDockMore);
    doc.activeElement = null;
    restoreOpener(capMore, canvas, { doc: /** @type {any} */ (doc), isPhone: () => phone });
    expect(doc.activeElement).toBe(newDockMore);

    // 4) Fallback to defaultFallback (#board) when nothing matches
    doc.activeElement = null;
    restorer.restoreOpener({ el: null, label: "Missing", rootId: null, dockMore: false });
    expect(doc.activeElement).toBe(canvas);

    // 5) findByAriaLabel & visibleControl return visible first, else first existing
    expect(findByAriaLabel("Notes", "topbar", { doc: /** @type {any} */ (doc), isPhone: () => true })).toBe(dockNotes);
    phone = false;
    expect(visibleControl([".phone-only", ".desk-only"], { doc: /** @type {any} */ (doc), isPhone: () => false })).toBe(topShare);
    expect(visibleControl([".phone-only"], { doc: /** @type {any} */ (doc), isPhone: () => false })).toBe(dockNotes);
    expect(visibleControl([".nonexistent"], { doc: /** @type {any} */ (doc), isPhone: () => false })).toBeNull();
  });
});

// ── 5. mountApp #dialogs / dismissOverlays() coexistence regression ──

describe("web/adapters/dom/app.js + board-dialogs.js coexistence", () => {
  test("external dismissOverlays() via Help or contextmenu clears #dialogs synchronously so shortcuts and focus are never wedged", () => {
    const body = new StubElement("body");
    const documentElement = new StubElement("html");
    documentElement.append(body);
    const main = new StubElement("div"); main.className = "main";
    const canvasBox = new StubElement("div"); canvasBox.setAttribute("id", "canvas");
    const board = new StubElement("canvas"); board.setAttribute("id", "board");
    const ink = new StubElement("textarea"); ink.setAttribute("id", "ink");
    main.append(canvasBox);
    canvasBox.append(board, ink);
    body.append(main);

    const byId = { canvas: canvasBox, board, ink };
    for (const id of ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"]) {
      const el = new StubElement(id === "picker" ? "input" : "div");
      el.setAttribute("id", id);
      body.append(el);
      byId[id] = el;
    }

    const docListeners = {};
    const doc = {
      body,
      documentElement,
      activeElement: board,
      visibilityState: "visible",
      createElement: tag => new StubElement(tag),
      createTextNode: text => new StubText(text),
      querySelector(sel) {
        if (sel === ".main") return main;
        if (sel.startsWith("#")) return byId[sel.slice(1)] ?? null;
        if (/^\[([^\]]+)\]$/.test(sel)) {
          const attr = sel.slice(1, -1);
          return body.all().find(e => e.hasAttribute(attr)) ?? null;
        }
        if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          return body.all().find(e => e.classList.contains(cls)) ?? null;
        }
        return null;
      },
      addEventListener(type, fn) { (docListeners[type] ??= []).push(fn); },
      removeEventListener(type, fn) { docListeners[type] = (docListeners[type] ?? []).filter(f => f !== fn); },
      fire(type, ev = {}) {
        const e = {
          target: doc.activeElement ?? board,
          shiftKey: false,
          altKey: false,
          metaKey: false,
          ctrlKey: false,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; },
          ...ev,
        };
        for (const fn of [...(docListeners[type] ?? [])]) fn(e);
        return e;
      },
    };
    activeDoc = doc;

    let frames = [];
    Object.assign(globalThis, {
      document: doc,
      Node: StubNode,
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
      requestAnimationFrame: fn => frames.push(fn),
      addEventListener() {},
      removeEventListener() {},
      getSelection: () => ({ toString: () => "" }),
    });

    const net = localRoom({ users: { "t-ada": { user: "ada", role: "owner" } }, clock: true });
    const app = mountApp({
      startSession: ({ mine, onChange }) => createSession({
        join: () => net.join(),
        token: "t-ada",
        board: "b1",
        client: "ada",
        user: "ada",
        mine,
        onChange,
        clock: net.clock,
      }),
      net: { kind: "local", put() {}, onFile() {} },
      board: "b1",
      me: { user: "ada", name: "Ada", role: null },
      prefs: memoryStore(),
      theme: "light",
      clock: net.clock,
    });

    const step = (n = 1) => {
      for (let i = 0; i < n; i++) {
        while (net.step());
        net.advance(16);
        while (net.step());
        const q = frames;
        frames = [];
        for (const fn of q) fn();
      }
    };
    step(3);

    // 1. Open Export modal in #dialogs -> #dialogs renders and holds active focus trap
    app.openDialog("export");
    step(2);
    expect(byId.dialogs.childNodes.length).toBe(1);
    expect(hasActiveOverlay(/** @type {any} */ (doc))).toBe(true);
    expect(doc.activeElement?.closest?.("#dialogs")).toBeTruthy();

    // 2. Trigger openHelp() via Board menu "Help & shortcuts" (invokes dismissOverlays() on quiet board)
    const helpItem = byId.topbar.all().find(e => e.getAttribute("role") === "menuitem" && e.getAttribute("aria-label") === "Help & shortcuts");
    expect(helpItem).toBeTruthy();
    helpItem.click();
    expect(app.ui.dialog).toBeNull();
    expect(byId.dialogs.childNodes.length).toBe(0);
    expect(isHelpDialogOpen(/** @type {any} */ (doc))).toBe(true);

    // Step frames on a quiet board where chrome() short-circuits unless chromeDirty is set
    step(5);
    expect(byId.dialogs.childNodes.length).toBe(0);

    // 3. Fire Escape to close Help -> #dialogs empty, no active overlay, focus NOT in #dialogs, 'r' works
    doc.fire("keydown", { key: "Escape", target: doc.activeElement });
    expect(isHelpDialogOpen(/** @type {any} */ (doc))).toBe(false);
    expect(byId.dialogs.childNodes.length).toBe(0);
    expect(hasActiveOverlay(/** @type {any} */ (doc))).toBe(false);
    expect(doc.activeElement?.closest?.("#dialogs")).toBeFalsy();

    expect(app.S.tool).toBe("select");
    const rEv = doc.fire("keydown", { key: "r", code: "KeyR", target: doc.activeElement ?? board });
    expect(rEv.defaultPrevented).toBe(true);
    expect(app.S.tool).toBe("rectangle");

    // 4. Contextmenu over an open #dialogs modal also clears #dialogs and restores shortcuts after Escape
    app.openDialog("export");
    step(2);
    expect(byId.dialogs.childNodes.length).toBe(1);
    board.fire("contextmenu", { clientX: 50, clientY: 50 });
    expect(app.ui.dialog).toBeNull();
    expect(byId.dialogs.childNodes.length).toBe(0);
    step(3);
    doc.fire("keydown", { key: "Escape", target: doc.activeElement });
    expect(hasActiveOverlay(/** @type {any} */ (doc))).toBe(false);
    expect(byId.dialogs.childNodes.length).toBe(0);
    doc.fire("keydown", { key: "v", code: "KeyV", target: doc.activeElement ?? board });
    expect(app.S.tool).toBe("select");
  });
});
