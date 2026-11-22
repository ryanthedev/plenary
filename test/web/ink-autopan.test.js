// Tests for mobile #ink keyboard auto-pan in web/adapters/dom/app.js (Chrome on iOS).
import { describe, test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";

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
    super(1);
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this.width = 390;
    this.height = 844;
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
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  blur() { if (globalThis.document?.activeElement === this) globalThis.document.activeElement = null; }
  setPointerCapture() {}
  setSelectionRange() {}
  select() {}
  after(n) { this.parentNode.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  getBoundingClientRect() {
    if (this._rectFn) return this._rectFn();
    return { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 };
  }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
});

function setupRig({ coarse = true, vvHeight = 844, vvOffsetTop = 0 } = {}) {
  let frames = [];
  const vvL = {};
  const vv = {
    height: vvHeight,
    offsetTop: vvOffsetTop,
    addEventListener(t, fn) { (vvL[t] ??= []).push(fn); },
    removeEventListener(t, fn) { vvL[t] = (vvL[t] ?? []).filter(f => f !== fn); },
    fire(t) { for (const fn of [...(vvL[t] ?? [])]) fn(); },
  };
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  // Dynamic rect for #ink based on its CSS left/top/width/height (like a real browser)
  ink._rectFn = () => {
    const left = parseFloat(ink.style.left) || 0;
    const top = parseFloat(ink.style.top) || 0;
    const width = parseFloat(ink.style.width) || 120;
    const height = parseFloat(ink.style.height) || 32;
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener() {},
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 1, visualViewport: vv,
    matchMedia: q => ({ matches: q.includes("pointer: coarse") ? coarse : false, addEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener() {},
    removeEventListener() {},
  });

  const net = localRoom({ users: { "t-ada": { user: "ada", role: "owner" } }, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({ join: () => net.join(), token: "t-ada", board: "b1", client: "ada", user: "ada", mine, onChange, clock: net.clock }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b1",
    me: { user: "ada", name: "Ada", role: "owner" },
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
  return { app, S: app.S, vv, doc, ink, step };
}

describe("Mobile #ink keyboard auto-pan", () => {
  test("triggers animateViewTo when visualViewport.height shrinks below #ink on coarse pointer and tracks #ink position during pan", () => {
    const { S, vv, doc, ink, step } = setupRig({ coarse: true, vvHeight: 844 });
    const animateCalls = [];
    const origAnimate = S.eds.board.animateViewTo.bind(S.eds.board);
    S.eds.board.animateViewTo = (target, opts) => {
      animateCalls.push({ ...target });
      return origAnimate(target, opts);
    };

    // Start text editing near the bottom of the screen (y = 600)
    S.act("board", e => e.beginText(null, { x: 100, y: 600 }));
    step(2);
    expect(ink.style.display).toBe("block");
    expect(doc.activeElement).toBe(ink);
    expect(animateCalls.length).toBe(0); // visible above full 844px viewport

    const beforeTop = parseFloat(ink.style.top);
    const beforeViewY = S.eds.board.view.y;

    // iOS software keyboard opens: visualViewport shrinks to 420px
    vv.height = 420;
    vv.fire("resize");

    expect(animateCalls.length).toBe(1);
    expect(animateCalls[0].y).toBeLessThan(beforeViewY);

    // Stepping frames smoothly pans view.y and updates #ink CSS top above keyboard
    step(20);
    const afterTop = parseFloat(ink.style.top);
    expect(afterTop).toBeLessThan(beforeTop);
    expect(ink.getBoundingClientRect().bottom).toBeLessThanOrEqual(420 - 24 + 1);
  });

  test("does nothing when #ink is already visible above the keyboard", () => {
    const { S, vv, ink, step } = setupRig({ coarse: true, vvHeight: 844 });
    let called = 0;
    const origAnimate = S.eds.board.animateViewTo.bind(S.eds.board);
    S.eds.board.animateViewTo = (target, opts) => { called++; return origAnimate(target, opts); };

    // Start text editing near the top of the screen (y = 100)
    S.act("board", e => e.beginText(null, { x: 80, y: 100 }));
    step(2);
    expect(ink.style.display).toBe("block");

    vv.height = 420;
    vv.fire("resize");
    expect(called).toBe(0);
  });

  test("does nothing when #ink is not focused or on fine desktop pointer", () => {
    const { S, vv, doc, step } = setupRig({ coarse: true, vvHeight: 844 });
    let called = 0;
    const origAnimate = S.eds.board.animateViewTo.bind(S.eds.board);
    S.eds.board.animateViewTo = (target, opts) => { called++; return origAnimate(target, opts); };

    S.act("board", e => e.beginText(null, { x: 100, y: 600 }));
    step(2);
    // Blur / unfocus #ink without committing (simulating focus elsewhere)
    doc.activeElement = doc.body;
    vv.height = 420;
    vv.fire("resize");
    expect(called).toBe(0);

    // Fine pointer (desktop) does not auto-pan either
    const desk = setupRig({ coarse: false, vvHeight: 844 });
    let deskCalled = 0;
    const origDesk = desk.S.eds.board.animateViewTo.bind(desk.S.eds.board);
    desk.S.eds.board.animateViewTo = (target, opts) => { deskCalled++; return origDesk(target, opts); };
    desk.S.act("board", e => e.beginText(null, { x: 100, y: 600 }));
    desk.step(2);
    desk.vv.height = 420;
    desk.vv.fire("resize");
    expect(deskCalled).toBe(0);
  });

  test("accounts for non-zero visualViewport.offsetTop and non-1 canvas scale (L6)", () => {
    const { S, vv, ink, step } = setupRig({ coarse: true, vvHeight: 844, vvOffsetTop: 0 });
    // Zoom canvas to 2x scale
    S.eds.board.view = { x: 0, y: 0, scale: 2 };
    S.eds.notes.view = { x: 0, y: 0, scale: 2 };

    const animateCalls = [];
    const origAnimate = S.eds.board.animateViewTo.bind(S.eds.board);
    S.eds.board.animateViewTo = (target, opts) => {
      animateCalls.push({ ...target });
      return origAnimate(target, opts);
    };

    // Place text at world y = 260 -> screen y = 520 at scale 2
    S.act("board", e => e.beginText(null, { x: 50, y: 260 }));
    step(2);
    expect(ink.style.display).toBe("block");

    // Keyboard opens with offsetTop = 50 and height = 380 -> visibleBottom = 50 + 380 - 24 = 406
    const beforeRect = ink.getBoundingClientRect();
    const expectedShiftPx = beforeRect.bottom - (50 + 380 - 24);
    expect(expectedShiftPx).toBeGreaterThan(100);

    vv.offsetTop = 50;
    vv.height = 380;
    vv.fire("resize");

    expect(animateCalls.length).toBe(1);
    expect(animateCalls[0].y).toBeCloseTo(-expectedShiftPx / 2, 1);

    step(20);
    expect(ink.getBoundingClientRect().bottom).toBeLessThanOrEqual(50 + 380 - 24 + 1);
  });
});
