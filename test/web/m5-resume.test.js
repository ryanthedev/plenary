// Phase 5 Gate: M5 mobile background/foreground resume (pageshow bfcache restore, coalescing with
// visibilitychange + online, recent-message guard, backoff invariants) and theme-color meta sync.
import { test, expect, afterAll } from "bun:test";
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
    super(1); this.tagName = tag.toUpperCase(); this.className = ""; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 390; this.height = 844;
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
  click() { if (!this.disabled) this.fire("click"); }
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
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
});

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-vi": { user: "vi", role: "viewer" },
};

function setup({ token = "t-ada", hasThemeMeta = true, wrap = null } = {}) {
  let frames = [];
  const winL = {}, docL = {};
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const themeMeta = hasThemeMeta ? new E("meta") : null;
  if (themeMeta) { themeMeta.setAttribute("name", "theme-color"); themeMeta.setAttribute("content", "#f6f6f8"); }
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => {
      if (s === ".main") return main;
      if (s === 'meta[name="theme-color"]') return themeMeta;
      if (s.startsWith("#")) return byId[s.slice(1)] ?? null;
      return null;
    },
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    fire(t, ev = {}) { for (const fn of docL[t] ?? []) fn({ target: board, preventDefault() {}, ...ev }); },
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 3,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { winL[t] = (winL[t] ?? []).filter(f => f !== fn); },
  });

  const net = localRoom({ board: "b1", users: USERS, clock: true });
  let reopens = 0, hellos = 0;
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => {
        const raw = net.join();
        const origReopen = raw.reopen.bind(raw), origSend = raw.send.bind(raw);
        const tr = {
          ...raw,
          reopen: () => { reopens++; return origReopen(); },
          send: m => { if (m?.t === "hello") hellos++; return origSend(m); },
        };
        return wrap ? wrap(tr) : tr;
      },
      token, board: "b1", client: USERS[token].user, user: USERS[token].user, mine, onChange, clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b1",
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
  const fireWin = (t, ev = {}) => { for (const fn of winL[t] ?? []) fn({ preventDefault() {}, ...ev }); };
  step(3);
  const resetCounters = () => { reopens = 0; hellos = 0; };
  resetCounters();
  return {
    app, S: app.S, net, doc, themeMeta, step, fireWin,
    reopens: () => reopens,
    hellos: () => hellos,
    resetCounters,
  };
}

test("pageshow with persisted: true triggers probe when stale; persisted: false does NOT trigger probe", () => {
  const r = setup();
  r.net.clock.random = () => 0.5;
  // Advance past HEARD_MS (10s) so the link is considered stale.
  r.net.advance(15_000); r.step(1);
  r.resetCounters();

  // Normal initial load (persisted: false) must not trigger a probe.
  r.fireWin("pageshow", { persisted: false });
  r.net.advance(20_000); r.step(2);
  expect(r.reopens()).toBe(0);
  expect(r.hellos()).toBe(0);

  // iOS bfcache restore (persisted: true) when stale triggers exactly one probe.
  r.fireWin("pageshow", { persisted: true });
  r.net.advance(2500); r.step(2);
  expect(r.reopens()).toBe(1);
  expect(r.hellos()).toBe(1);
});

test("pageshow (persisted: true) + visibilitychange + online firing together coalesce to at most ONE probe", () => {
  // Order 1: pageshow -> visibilitychange -> online (with non-zero jitter)
  {
    const r = setup({ token: "t-vi" });
    r.net.clock.random = () => 0.5;
    r.doc.visibilityState = "hidden"; r.doc.fire("visibilitychange");
    r.net.advance(35_000); r.step(1);
    r.resetCounters();

    r.fireWin("pageshow", { persisted: true });
    r.doc.visibilityState = "visible"; r.doc.fire("visibilitychange");
    r.fireWin("online");

    for (let i = 0; i < 16; i++) { r.net.advance(1000); r.step(1); }
    expect(r.reopens()).toBe(1);
    expect(r.hellos()).toBe(1);
  }

  // Order 2: visibilitychange -> pageshow -> online with 0ms jitter and 50ms spacing (first probe already fired)
  {
    const r = setup();
    r.net.clock.random = () => 0;
    r.doc.visibilityState = "hidden"; r.doc.fire("visibilitychange");
    r.net.advance(35_000); r.step(1);
    r.resetCounters();

    r.doc.visibilityState = "visible"; r.doc.fire("visibilitychange");
    r.net.advance(50); r.step(1);
    r.fireWin("pageshow", { persisted: true });
    r.net.advance(50); r.step(1);
    r.fireWin("online");
    r.net.advance(3000); r.step(2);
    expect(r.reopens()).toBe(1);
    expect(r.hellos()).toBe(1);
  }

  // Order 3: online -> pageshow -> visibilitychange
  {
    const r = setup();
    r.net.clock.random = () => 0.4;
    r.doc.visibilityState = "hidden"; r.doc.fire("visibilitychange");
    r.net.advance(35_000); r.step(1);
    r.resetCounters();

    r.fireWin("online");
    r.fireWin("pageshow", { persisted: true });
    r.doc.visibilityState = "visible"; r.doc.fire("visibilitychange");
    r.net.advance(3000); r.step(2);
    expect(r.reopens()).toBe(1);
    expect(r.hellos()).toBe(1);
  }
});

test("pageshow respects recent-message guard (no probe when recently heard from server)", () => {
  const r = setup();
  r.net.clock.random = () => 0.2;
  // Server just spoke (welcome at setup, and broadcast a room event 2s ago).
  r.net.advance(2000);
  r.net.broadcast({ t: "here", writerCount: 1, viewers: 2 });
  while (r.net.step());
  r.net.advance(3000); r.step(1);
  r.resetCounters();

  r.fireWin("pageshow", { persisted: true });
  r.net.advance(5000); r.step(2);
  expect(r.reopens()).toBe(0);
  expect(r.hellos()).toBe(0);
});

test("pageshow respects shouldProbe and Replica backoff invariants (refused, stopped, limited, mid-gesture, and in-flight backoff hello)", () => {
  for (const [status, gesture] of [["refused", null], ["stopped", null], ["limited", null], ["live", "board"]]) {
    const r = setup();
    r.net.clock.random = () => 0.1;
    r.net.advance(15_000); r.step(1);
    r.resetCounters();
    Object.defineProperty(r.S.connection, "status", { get: () => status, configurable: true });
    r.S.gesture = gesture;

    r.fireWin("pageshow", { persisted: true });
    r.net.advance(3000); r.step(2);
    expect([status, gesture, r.reopens(), r.hellos()]).toEqual([status, gesture, 0, 0]);
  }

  // In-flight Replica backoff: if a drop occurs while pageshow's jittered probe is waiting,
  // Replica's backoff sends a hello and the probe stands down without sending a duplicate hello.
  const hold = { on: false };
  const r = setup({
    token: "t-vi",
    wrap: tr => ({ ...tr, onMessage: fn => tr.onMessage(m => { if (!hold.on) fn(m); }) }),
  });
  r.net.clock.random = () => 0.5; // viewer jitter = 7.5s
  r.net.advance(15_000); r.step(1);
  r.resetCounters();

  r.fireWin("pageshow", { persisted: true });
  for (let i = 0; i < 4; i++) { r.net.advance(500); r.step(1); } // 2s in
  hold.on = true;
  r.S.dropConnection(); r.step(1); // Replica schedules backoff and sends 1 hello
  for (let i = 0; i < 13; i++) { r.net.advance(500); r.step(1); } // past 7.5s probe fire time, before watchdog
  expect(r.reopens()).toBe(1);
  expect(r.hellos()).toBe(1);
});

test("setTheme('dark') / setTheme('light') updates <meta name='theme-color'> and is safe when absent", () => {
  const r = setup({ hasThemeMeta: true });
  expect(r.themeMeta.getAttribute("content")).toBe("#F8F7F4");

  r.app.setTheme("dark");
  expect(r.doc.documentElement.dataset.theme).toBe("dark");
  expect(r.themeMeta.getAttribute("content")).toBe("#111113");

  r.app.setTheme("light");
  expect(r.doc.documentElement.dataset.theme).toBe("light");
  expect(r.themeMeta.getAttribute("content")).toBe("#F8F7F4");

  // Safe when <meta name="theme-color"> is absent (stub DOMs)
  const r2 = setup({ hasThemeMeta: false });
  expect(() => r2.app.setTheme("dark")).not.toThrow();
  expect(r2.doc.documentElement.dataset.theme).toBe("dark");
});
