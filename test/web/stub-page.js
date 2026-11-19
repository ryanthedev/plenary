// A stub page: just enough DOM for web/adapters/dom/app.js (text only; no layout). Shared by test/web/ui-app.test.js and
// the end-to-end picture tests. installPage() replaces the browser globals the app reads; restoreGlobals() puts them back.
// ── a stub page: just enough DOM for app.js (text only; no layout) ──
export class N {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) { for (const n of ns) { const x = n instanceof N ? n : new T(String(n)); x.parentNode?.removeChild(x); x.parentNode = this; this.childNodes.push(x); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { this.replaced = (this.replaced ?? 0) + 1; for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(new T(String(v))); }
}
class T extends N { constructor(t) { super(3); this.data = t; } get textContent() { return this.data; } }
const CTX = { measureText: t => ({ width: String(t).length * 7 }), getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop() {} }), createPattern: () => null };
export class E extends N {
  constructor(tag) {
    super(1); this.tagName = tag.toUpperCase(); this.className = ""; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this._hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 300; this.height = 150;
    const self = this;
    this.classList = { contains: c => self.className.split(/\s+/).includes(c), add: c => self.classList.toggle(c, true), remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(" "); } };
  }
  // Like a browser: hiding the focused element blurs it, and the focusout (relatedTarget null) bubbles up the tree.
  get hidden() { return this._hidden; }
  set hidden(v) {
    this._hidden = !!v;
    const d = globalThis.document;
    if (v && d && d.activeElement === this) {
      d.activeElement = d.body ?? null;
      for (let n = this, ev = { target: this, relatedTarget: null }; n; n = n.parentNode) for (const fn of n.listeners?.focusout ?? []) fn({ ...ev, currentTarget: n });
    }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) { const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev }; for (const fn of this.listeners[t] ?? []) fn(e); return e; }
  click() { if (!this.disabled) this.fire("click"); }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; } blur() {} setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { const p = this.parentNode; p.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); n.parentNode?.removeChild(n); n.parentNode = p; p.childNodes.splice(i, 0, n); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}
const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];

/** The stub page's mutable state, shared with whoever installed it: `frames` (queued animation frames), `winL` (window listeners), `page`. */
export const stub = { frames: [], winL: {}, page: null, media: new Map(), resizeCallbacks: [] };
// The globals this file stubs, put back afterwards so later files' fallbacks never see the stub page.
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
/** Put the stubbed globals back (call in afterAll). */
export const restoreGlobals = () => { for (const k of GLOBALS) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } };
export function installPage() {
  stub.frames = []; stub.winL = {}; stub.media = new Map(); stub.resizeCallbacks = [];
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const docL = {};
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
    fire(t, ev = {}) { for (const fn of docL[t] ?? []) fn({ target: board, preventDefault() {}, stopPropagation() {}, ...ev }); },
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 1,
    matchMedia: query => {
      if (!stub.media.has(query)) stub.media.set(query, { matches: false, listeners: [] });
      const m = stub.media.get(query);
      return { get matches() { return m.matches; }, addEventListener: (type, fn) => { if (type === "change") m.listeners.push(fn); } };
    },
    ResizeObserver: class { constructor(fn) { this.fn = fn; stub.resizeCallbacks.push(fn); } observe() { this.fn([]); } },
    requestAnimationFrame: fn => stub.frames.push(fn),
    addEventListener: (t, fn) => { (stub.winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { stub.winL[t] = (stub.winL[t] ?? []).filter(f => f !== fn); },
  });
  stub.page = { doc, byId, board, media: stub.media };
  return stub.page;
}
export const fireWin = (t, ev = {}) => { for (const fn of stub.winL[t] ?? []) fn({ preventDefault() {}, ...ev }); };

