// Keyboard shortcut focus handling & clipboard guards for web/adapters/dom/app.js.
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
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 300; this.height = 150;
    const self = this;
    this.classList = { contains: c => self.className.split(/\s+/).includes(c), add: c => self.classList.toggle(c, true), remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(" "); } };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) { const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...ev }; for (const fn of this.listeners[t] ?? []) fn(e); return e; }
  click() { if (!this.disabled) this.fire("click"); }
  focus() {} blur() {} setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { const p = this.parentNode; p.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}
const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "getSelection"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => { for (const k of GLOBALS) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } });

const USERS = { "t-ada": { user: "ada", role: "owner" } };

function setup() {
  let frames = [];
  let selectionText = "";
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const docL = {};
  const doc = {
    body, documentElement: new E("html"), activeElement: board, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    fire(t, ev = {}) {
      const e = {
        target: board,
        shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
        defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...ev,
      };
      for (const fn of docL[t] ?? []) fn(e);
      return e;
    },
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => ({ toString: () => selectionText }),
  });

  const net = localRoom({ users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(), token: "t-ada", board: "b1", client: "ada", user: "ada", mine, onChange, clock: net.clock,
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
      const q = frames; frames = [];
      for (const fn of q) fn();
    }
  };
  step(3);
  return {
    app, S: app.S, doc, byId, board, step,
    setSelection: s => { selectionText = s; },
  };
}

const find = (root, pred) => root.all().find(pred);

test("shortcuts fire and call preventDefault + stopPropagation when a toolbar button has focus", () => {
  const { S, doc, byId, app } = setup();
  const themeBtn = find(byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("theme-btn"));
  expect(themeBtn).toBeTruthy();
  doc.activeElement = themeBtn;

  expect(S.tool).toBe("select");
  const ev = doc.fire("keydown", { target: themeBtn, key: "r", code: "KeyR" });
  expect(S.tool).toBe("rectangle");
  expect(ev.defaultPrevented).toBe(true);
  expect(ev.propagationStopped).toBe(true);

  // Also works when target is a child span inside a toolbar button.
  const iconSpan = themeBtn.children[0];
  const ev2 = doc.fire("keydown", { target: iconSpan, key: "v", code: "KeyV" });
  expect(S.tool).toBe("select");
  expect(ev2.defaultPrevented).toBe(true);
  expect(ev2.propagationStopped).toBe(true);

  // Panel toggle ('i') and export dialog (Cmd+Shift+E) also stop propagation.
  const openBefore = app.ui.panel.open;
  const evI = doc.fire("keydown", { target: themeBtn, key: "i", code: "KeyI" });
  expect(app.ui.panel.open).toBe(!openBefore);
  expect(evI.defaultPrevented).toBe(true);
  expect(evI.propagationStopped).toBe(true);

  const evE = doc.fire("keydown", { target: themeBtn, key: "e", code: "KeyE", metaKey: true, shiftKey: true });
  expect(app.ui.dialog).toBe("export");
  expect(evE.defaultPrevented).toBe(true);
  expect(evE.propagationStopped).toBe(true);
});

test("shortcuts do NOT fire when focus is on input, textarea, select, contenteditable, or inside a dialog", () => {
  const { S, doc, byId, app, step } = setup();
  expect(S.tool).toBe("select");

  const input = new E("input");
  const textarea = new E("textarea");
  const select = new E("select");
  const ceAttr = new E("div");
  ceAttr.setAttribute("contenteditable", "true");
  const ceChild = new E("span");
  ceAttr.append(ceChild);
  const ceProp = new E("div");
  ceProp.isContentEditable = true;

  const dialogByClass = new E("div");
  dialogByClass.className = "dialog";
  const btnInClassDialog = new E("button");
  dialogByClass.append(btnInClassDialog);

  const dialogByRole = new E("div");
  dialogByRole.setAttribute("role", "dialog");
  const btnInRoleDialog = new E("button");
  dialogByRole.append(btnInRoleDialog);

  for (const target of [input, textarea, select, ceAttr, ceChild, ceProp, btnInClassDialog, btnInRoleDialog]) {
    doc.activeElement = target;
    const ev = doc.fire("keydown", { target, key: "r", code: "KeyR" });
    expect(S.tool).toBe("select");
    expect(ev.defaultPrevented).toBe(false);
    expect(ev.propagationStopped).toBe(false);
  }

  // Also blocked while an app modal dialog is rendered in #dialogs (even if target is body).
  app.openDialog("export");
  step(2);
  const evOpen = doc.fire("keydown", { target: doc.body, key: "r", code: "KeyR" });
  expect(S.tool).toBe("select");
  expect(evOpen.defaultPrevented).toBe(false);
  expect(evOpen.propagationStopped).toBe(false);
  expect(byId.dialogs.children.length).toBeGreaterThan(0);

  // If #dialogs is empty (e.g. stale ui.dialog with no rendered dialog), shortcuts still work.
  byId.dialogs.replaceChildren();
  const evStale = doc.fire("keydown", { target: doc.body, key: "r", code: "KeyR" });
  expect(S.tool).toBe("rectangle");
  expect(evStale.defaultPrevented).toBe(true);
  expect(evStale.propagationStopped).toBe(true);
});

test("Enter and Space on a focused interactive control are NOT hijacked", () => {
  const { S, doc, byId } = setup();
  // Create and select a rectangle so Enter would normally start label editing on the canvas.
  S.setTool("rectangle");
  S.pointerDown({ x: 100, y: 100 });
  S.pointerMove({ x: 200, y: 160 });
  S.pointerUp({ x: 200, y: 160 });
  expect(S.eds.board.selected().length).toBe(1);

  const btn = find(byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("theme-btn"));
  const link = new E("a");
  const summary = new E("summary");
  const roleBtn = new E("div");
  roleBtn.setAttribute("role", "button");

  for (const target of [btn, link, summary, roleBtn]) {
    doc.activeElement = target;
    const evEnter = doc.fire("keydown", { target, key: "Enter", code: "Enter" });
    expect(evEnter.defaultPrevented).toBe(false);
    expect(evEnter.propagationStopped).toBe(false);
    expect(S.textEditor()).toBeFalsy();

    const evSpace = doc.fire("keydown", { target, key: " ", code: "Space" });
    expect(evSpace.defaultPrevented).toBe(false);
    expect(evSpace.propagationStopped).toBe(false);

    const evShiftSpace = doc.fire("keydown", { target, key: " ", code: "Space", shiftKey: true });
    expect(evShiftSpace.defaultPrevented).toBe(false);
    expect(evShiftSpace.propagationStopped).toBe(false);
    expect(S.eds.board.play).toBeFalsy();
  }
});

test("clipboard copy/paste works on a focused toolbar button, handles stale selections properly, and does not hijack inputs", () => {
  const { S, doc, byId, board, setSelection } = setup();
  S.setTool("rectangle");
  S.pointerDown({ x: 100, y: 100 });
  S.pointerMove({ x: 200, y: 160 });
  S.pointerUp({ x: 200, y: 160 });

  const btn = find(byId.topbar, e => e.tagName === "BUTTON" && e.classList.contains("theme-btn"));
  doc.activeElement = btn;

  let copied = "";
  const evCopy = doc.fire("copy", {
    target: btn,
    clipboardData: { setData: (_t, v) => { copied = v; } },
  });
  expect(evCopy.defaultPrevented).toBe(true);
  expect(copied.length).toBeGreaterThan(0);

  // With a DOM text selection (e.g. inside drawer/panel) while focus is not on canvas, copy is NOT hijacked.
  setSelection("selected note text");
  let copied2 = "";
  const evSelCopy = doc.fire("copy", {
    target: btn,
    clipboardData: { setData: (_t, v) => { copied2 = v; } },
  });
  expect(evSelCopy.defaultPrevented).toBe(false);
  expect(copied2).toBe("");

  // Paste still succeeds on a focused toolbar button or canvas even when a text selection exists.
  const countBefore = S.eds.board.doc.live().length;
  const evBtnPaste = doc.fire("paste", {
    target: btn,
    clipboardData: { files: [], getData: () => copied },
  });
  expect(evBtnPaste.defaultPrevented).toBe(true);
  expect(S.eds.board.doc.live().length).toBeGreaterThan(countBefore);

  // When document.activeElement === canvas, copy succeeds even with a stale text selection.
  doc.activeElement = board;
  let copiedOnCanvas = "";
  const evCanvasCopy = doc.fire("copy", {
    target: board,
    clipboardData: { setData: (_t, v) => { copiedOnCanvas = v; } },
  });
  expect(evCanvasCopy.defaultPrevented).toBe(true);
  expect(copiedOnCanvas.length).toBeGreaterThan(0);

  const countBeforeCanvasPaste = S.eds.board.doc.live().length;
  const evCanvasPaste = doc.fire("paste", {
    target: board,
    clipboardData: { files: [], getData: () => copiedOnCanvas },
  });
  expect(evCanvasPaste.defaultPrevented).toBe(true);
  expect(S.eds.board.doc.live().length).toBeGreaterThan(countBeforeCanvasPaste);
  setSelection("");

  // Inside an input, copy is NOT hijacked.
  const input = new E("input");
  doc.activeElement = input;
  const evInputCopy = doc.fire("copy", {
    target: input,
    clipboardData: { setData: (_t, v) => { copied2 = v; } },
  });
  expect(evInputCopy.defaultPrevented).toBe(false);
  expect(copied2).toBe("");
});
