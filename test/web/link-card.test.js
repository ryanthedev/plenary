// Web integration for Jira, Linear & GitHub rich link cards:
// desktop paste, mobile clipboard paste, Canvas2D paint smoke test, and click-to-open (badge, Cmd+Click, HUD pill).
import { test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { paint, THEMES } from "../../web/adapters/dom/paint.js";
import { buildLinkCard, linkCardOpenBadgeRect, parseLinkCardFromElement } from "../../packages/core/link-card.js";
import { Editor } from "../../packages/core/editor.js";

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
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 1200; this.height = 800;
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
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "window", "open", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport", "navigator"];
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

function setupApp({ token = "t-ada", phone = false, clipboard = undefined } = {}) {
  let frames = [];
  const docL = {}, opened = [];
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const doc = {
    body, documentElement: new E("html"), activeElement: board, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
  };
  const winOpen = (url, target, features) => { opened.push({ url, target, features }); return null; };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true, writable: true });
  Object.assign(globalThis, {
    document: doc,
    window: { open: winOpen },
    open: winOpen,
    Node: N,
    devicePixelRatio: 2,
    matchMedia: q => ({
      matches: phone && (q.includes("max-width: 640px") || q.includes("pointer: coarse")),
      addEventListener() {},
    }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener() {},
    removeEventListener() {},
    visualViewport: undefined,
  });

  const net = localRoom({ board: "link-card-board", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(),
      token, board: "link-card-board",
      client: USERS[token].user, user: USERS[token].user,
      mine, onChange, clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "link-card-board",
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
  const fireDoc = (t, ev = {}) => {
    const e = { target: board, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of docL[t] ?? []) fn(e);
    return e;
  };
  return { app, doc, byId, board, ink, opened, step, fireDoc };
}

test("desktop paste creates a rich link card, toasts, and supports click-to-open via badge, Cmd+Click, and HUD pill", () => {
  const { app, byId, board, opened, step, fireDoc } = setupApp();

  fireDoc("paste", {
    clipboardData: {
      files: [],
      getData: type => (type === "text/plain" ? "https://github.com/acme/plenary/pull/30" : ""),
    },
  });
  step(2);

  const live = app.S.eds.board.doc.live();
  expect(live.length).toBe(1);
  expect(parseLinkCardFromElement(live[0])?.key).toBe("acme/plenary#30");
  expect(byId.toast.textContent).toBe("Added GitHub PR card");

  // Floating HUD open-link button appears when card is selected
  const openBtn = byId.hudBL.all().find(el => el.getAttribute("data-action") === "open-link");
  expect(openBtn).toBeDefined();
  openBtn.click();
  expect(opened).toEqual([{
    url: "https://github.com/acme/plenary/pull/30",
    target: "_blank",
    features: "noopener,noreferrer",
  }]);

  // Clicking the top-right ↗ badge on canvas opens safely
  const badge = linkCardOpenBadgeRect(live[0]);
  const pt = app.S.eds.board.toScreen({ x: badge.x + badge.w / 2, y: badge.y + badge.h / 2 });
  board.fire("pointerdown", { clientX: pt.x, clientY: pt.y, button: 0, pointerId: 1, pointerType: "mouse" });
  expect(opened.length).toBe(2);

  // Cmd+Click on card center opens safely
  const mid = app.S.eds.board.toScreen({ x: live[0].x + live[0].width / 2, y: live[0].y + live[0].height / 2 });
  board.fire("pointerdown", { clientX: mid.x, clientY: mid.y, button: 0, metaKey: true, pointerId: 2, pointerType: "mouse" });
  expect(opened.length).toBe(3);
  expect(opened[2]).toEqual({
    url: "https://github.com/acme/plenary/pull/30",
    target: "_blank",
    features: "noopener,noreferrer",
  });
});

test("paste while editing text inside #ink does not hijack into a link card", () => {
  const { app, doc, ink, step, fireDoc } = setupApp();
  doc.activeElement = ink;
  const ev = fireDoc("paste", {
    target: ink,
    clipboardData: {
      files: [],
      getData: () => "https://github.com/acme/plenary/issues/99",
    },
  });
  step(2);
  expect(ev.defaultPrevented).toBeUndefined();
  expect(app.S.eds.board.doc.live().length).toBe(0);
});

test("mobile clipboard paste button creates a Linear rich link card and toasts", async () => {
  const clipboard = {
    async read() {
      return [{
        types: ["text/plain"],
        async getType() {
          return { async text() { return "https://linear.app/plenary/issue/ENG-55/mobile-link-card"; } };
        },
      }];
    },
  };
  const { app, byId, step } = setupApp({ phone: true, clipboard });
  const pasteBtn = byId.topbar.all().find(el => el.getAttribute("data-action") === "paste");
  expect(pasteBtn).toBeDefined();
  pasteBtn.click();
  await new Promise(r => setTimeout(r, 20));
  step(2);

  const live = app.S.eds.board.doc.live();
  expect(live.length).toBe(1);
  expect(parseLinkCardFromElement(live[0])?.title).toBe("Mobile link card");
  expect(byId.toast.textContent).toBe("Added Linear Issue card");
});

test("Canvas2D paint() renders GitHub, Linear, and Jira cards cleanly in light & dark themes", () => {
  const ed = new Editor({
    scene: {
      elements: [
        buildLinkCard("https://github.com/acme/plenary/pull/30", { x: 0, y: 0 }),
        buildLinkCard("https://linear.app/plenary/issue/ENG-42/ship-link-cards", { x: 380, y: 0 }),
        buildLinkCard("https://plenary.atlassian.net/browse/DEV-7", { x: 760, y: 0 }),
      ],
    },
  });
  for (const theme of [THEMES.light, THEMES.dark]) {
    const calls = [];
    const ctx = new Proxy({}, {
      get: (_, k) => (k === "calls" ? calls : (...args) => { calls.push([k, ...args]); }),
      set: (_, k, v) => { calls.push(["=" + String(k), v]); return true; },
    });
    paint(ctx, ed.displayList(theme), { width: 1200, height: 600, dpr: 2, background: theme.bg });
    const drawnTexts = calls.filter(c => c[0] === "fillText").map(c => c[1]);
    expect(drawnTexts).toEqual(expect.arrayContaining(["PR #30", "ENG-42", "Ship link cards", "DEV-7"]));
    expect(calls.some(c => c[0] === "fill")).toBe(true);
    expect(calls.some(c => c[0] === "stroke")).toBe(true);
  }
});
