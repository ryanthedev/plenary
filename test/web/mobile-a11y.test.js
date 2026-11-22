// Mobile Polish & Accessibility (#93 / #95 / #96 / #97):
// - Reusable focus trap (web/adapters/dom/a11y.js): focus-in, Tab/Shift+Tab wrap, Escape close, focus restore
// - Accessible names on all icon-only buttons in index.html and rendered DOM chrome (desktop & mobile)
// - role="dialog" / aria-modal="true" / aria-labelledby / aria-label on modals and mobile bottom sheets
// - Live status toast (role="status", aria-live="polite")
// - Single-overlay dismissal & backdrop tap-to-dismiss on mobile bottom sheets
// - Mobile CSS ergonomics: >= 44px touch targets, safe-area-inset-top/bottom, touch-action: manipulation,
//   100dvh with 100vh fallback, and >= 16px mobile inputs (preventing iOS auto-zoom).

import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { createFocusTrap, trapFocus, getFocusableElements, accessibleName } from "../../web/adapters/dom/a11y.js";

// ── minimal DOM stub with activeElement focus tracking ──
let currentDoc = null;

class N {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) { for (const n of ns) { const x = n instanceof N ? n : new T(String(n)); x.parentNode?.removeChild(x); x.parentNode = this; this.childNodes.push(x); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
  remove() { this.parentNode?.removeChild(this); }
  get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x === currentDoc?.body || x === currentDoc?.documentElement; }
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
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) {
    const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...ev };
    for (const fn of [...(this.listeners[t] ?? [])]) fn(e);
    return e;
  }
  click() { if (!this.disabled) this.fire("click"); }
  focus() { if (currentDoc) currentDoc.activeElement = this; }
  blur() { if (currentDoc && currentDoc.activeElement === this) currentDoc.activeElement = currentDoc.body; }
  setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { this.parentNode.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest(sel) {
    for (let x = this; x; x = x.parentNode) {
      if (sel.startsWith("#") && x.id === sel.slice(1)) return x;
      if (sel.startsWith(".") && x.classList?.contains(sel.slice(1))) return x;
    }
    return null;
  }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); n.parentNode?.removeChild(n); n.parentNode = p; p.childNodes.splice(i, 0, n); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheetBackdrop", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport"];
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

function makeDoc() {
  const docL = {};
  const body = new E("body");
  const documentElement = new E("html");
  documentElement.append(body);
  const byId = {};
  const doc = {
    body,
    documentElement,
    activeElement: body,
    visibilityState: "visible",
    createElement: t => new E(t),
    createTextNode: t => new T(t),
    getElementById: id => byId[id] ?? body.all().find(e => e.id === id) ?? null,
    querySelector: s => {
      if (s.startsWith("#")) return byId[s.slice(1)] ?? body.all().find(e => e.id === s.slice(1)) ?? null;
      if (s.startsWith(".")) return body.all().find(e => e.classList.contains(s.slice(1))) ?? null;
      const attrMatch = s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attrMatch) return body.all().find(e => attrMatch[2] ? e.getAttribute(attrMatch[1]) === attrMatch[2] : e.hasAttribute(attrMatch[1])) ?? null;
      return null;
    },
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
    fire: (t, ev = {}) => {
      const e = { target: doc.activeElement, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...ev };
      for (const fn of [...(docL[t] ?? [])]) fn(e);
      return e;
    },
    _byId: byId,
  };
  currentDoc = doc;
  return doc;
}

function setupApp({ token = "t-ada", phone = true, coarse = true } = {}) {
  let frames = [];
  const winL = {};
  const doc = makeDoc();
  const main = new E("div"); main.className = "main";
  const canvasBox = new E("div"); canvasBox.id = "canvas";
  const board = new E("canvas"); board.id = "board";
  const ink = new E("textarea"); ink.id = "ink";
  doc.body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  doc._byId.canvas = canvasBox; doc._byId.board = board; doc._byId.ink = ink;
  for (const id of IDS) {
    const el = new E(id === "picker" ? "input" : "div");
    el.id = id;
    if (id === "sheetBackdrop" || id === "sheet" || id === "toast") el.hidden = true;
    doc._byId[id] = el;
    doc.body.append(el);
  }
  Object.assign(globalThis, {
    document: doc,
    Node: N,
    devicePixelRatio: 2,
    matchMedia: q => ({
      matches: q.includes("max-width: 640px") || q.includes("max-width: 1023px") ? phone : q.includes("pointer: coarse") ? coarse : false,
      addEventListener() {},
    }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { winL[t] = (winL[t] ?? []).filter(f => f !== fn); },
    visualViewport: undefined,
  });

  const net = localRoom({ board: "a11y-board", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(), token, board: "a11y-board",
      client: USERS[token].user, user: USERS[token].user, mine, onChange, clock: net.clock,
    }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "a11y-board",
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
  return { doc, byId: doc._byId, app, S: app.S, step };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);

// ── 1. Focus Trap Unit Tests (web/adapters/dom/a11y.js) ──
describe("a11y focus trap (web/adapters/dom/a11y.js)", () => {
  test("activating moves focus inside, Tab wraps last->first, Shift+Tab wraps first->last, Escape closes and restores focus", () => {
    const doc = makeDoc();
    globalThis.document = doc;

    const trigger = new E("button"); trigger.textContent = "Open";
    const dialog = new E("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    const first = new E("button"); first.textContent = "First";
    const disabled = new E("button"); disabled.textContent = "Disabled"; disabled.disabled = true;
    const hidden = new E("button"); hidden.textContent = "Hidden"; hidden.hidden = true;
    const middle = new E("input"); middle.setAttribute("type", "text");
    const last = new E("button"); last.textContent = "Last";

    dialog.append(first, disabled, hidden, middle, last);
    doc.body.append(trigger, dialog);

    trigger.focus();
    expect(doc.activeElement).toBe(trigger);

    let escaped = 0;
    const trap = trapFocus(dialog, {
      doc,
      onEscape: () => {
        escaped++;
        trap.deactivate();
      },
    });

    // Moves focus to first enabled visible focusable element
    expect(doc.activeElement).toBe(first);
    expect(getFocusableElements(dialog)).toEqual([first, middle, last]);

    // Shift+Tab from first wraps to last
    const shiftTab = dialog.fire("keydown", { key: "Tab", shiftKey: true });
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(last);

    // Tab from last wraps to first
    const tab = dialog.fire("keydown", { key: "Tab", shiftKey: false });
    expect(tab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(first);

    // Escape closes and restores focus to trigger
    const esc = dialog.fire("keydown", { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(escaped).toBe(1);
    expect(trap.isActive()).toBe(false);
    expect(doc.activeElement).toBe(trigger);
  });

  test("focus trap falls back to container with tabindex=-1 when dialog has no focusable children", () => {
    const doc = makeDoc();
    globalThis.document = doc;

    const trigger = new E("button");
    const emptyDialog = new E("div");
    doc.body.append(trigger, emptyDialog);
    trigger.focus();

    const trap = createFocusTrap(emptyDialog, { doc });
    trap.activate();
    expect(emptyDialog.getAttribute("tabindex")).toBe("-1");
    expect(doc.activeElement).toBe(emptyDialog);

    const tab = emptyDialog.fire("keydown", { key: "Tab" });
    expect(tab.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(emptyDialog);

    trap.deactivate();
    expect(doc.activeElement).toBe(trigger);
  });
});

// ── 2. HTML & Rendered Chrome Accessible Names + Dialog/Toast Semantics ──
describe("ARIA labels, dialog semantics, and live status regions", () => {
  test("web/index.html has accessible toast live region, sheet dialog semantics, and no unlabeled buttons", () => {
    const html = readFileSync(join(import.meta.dir, "../../web/index.html"), "utf8");

    // Live status toast
    expect(html).toMatch(/id="toast"[^>]*role="status"/);
    expect(html).toMatch(/id="toast"[^>]*aria-live="polite"/);

    // Sheet backdrop & sheet dialog attributes
    expect(html).toContain('id="sheetBackdrop"');
    expect(html).toMatch(/id="sheet"[^>]*role="dialog"/);
    expect(html).toMatch(/id="sheet"[^>]*aria-modal="true"/);

    // Every <button> in web/index.html must have aria-label, aria-labelledby, or visible text
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
    for (const [, attrs, inner] of buttons) {
      const visibleText = inner.replace(/<[^>]+>/g, "").trim();
      const hasAria = /\baria-label(?:ledby)?\s*=\s*"[^"]+"/i.test(attrs);
      expect(Boolean(visibleText) || hasAria).toBe(true);
    }
  });

  test("every rendered <button> across desktop and mobile chrome has an accessible name", () => {
    // Desktop presenter (with panel open so panel buttons are audited too)
    {
      const { doc, app, step } = setupApp({ token: "t-ada", phone: false, coarse: false });
      app.setPanel({ type: "open" });
      step(2);
      const btns = findAll(doc.body, e => e.tagName === "BUTTON");
      expect(btns.length).toBeGreaterThan(15);
      for (const b of btns) {
        expect(accessibleName(b, doc).length).toBeGreaterThan(0);
      }
    }

    // Mobile presenter with Tools sheet open
    {
      const { doc, byId, step } = setupApp({ token: "t-ada", phone: true, coarse: true });
      const moreBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("More"));
      moreBtn.click();
      step(2);
      const btns = findAll(doc.body, e => e.tagName === "BUTTON");
      expect(btns.length).toBeGreaterThan(15);
      for (const b of btns) {
        expect(accessibleName(b, doc).length).toBeGreaterThan(0);
      }
    }
  });

  test("Export & Mermaid dialogs have role=dialog, aria-modal=true, aria-labelledby, trap Tab, close on Escape, and restore focus", () => {
    const { doc, byId, app, step } = setupApp({ token: "t-ada", phone: false, coarse: false });

    const exportBtn = find(byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "Export board");
    expect(exportBtn).toBeTruthy();
    exportBtn.focus();
    exportBtn.click();
    step(2);

    const dlg = find(byId.dialogs, e => e.getAttribute("role") === "dialog");
    expect(dlg).toBeTruthy();
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dlg.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(doc.getElementById(labelledBy)?.textContent).toContain("Export");

    // Focus moved inside the Export dialog
    const focusables = getFocusableElements(dlg);
    expect(focusables.length).toBeGreaterThan(2);
    expect(dlg.contains(doc.activeElement)).toBe(true);

    // Tab wraps from last to first
    focusables.at(-1).focus();
    dlg.fire("keydown", { key: "Tab", shiftKey: false });
    expect(doc.activeElement).toBe(focusables[0]);

    // Shift+Tab wraps from first to last
    dlg.fire("keydown", { key: "Tab", shiftKey: true });
    expect(doc.activeElement).toBe(focusables.at(-1));

    // Escape closes Export dialog and restores focus to the Export trigger button
    dlg.fire("keydown", { key: "Escape" });
    step(2);
    expect(app.ui.dialog).toBe(null);
    expect(byId.dialogs.children.length).toBe(0);
    expect(doc.activeElement?.getAttribute("aria-label")).toBe("Export board");

    // Mermaid dialog also has aria-modal & aria-labelledby
    app.openDialog("mermaid");
    step(2);
    const mdlg = find(byId.dialogs, e => e.getAttribute("role") === "dialog");
    expect(mdlg).toBeTruthy();
    expect(mdlg.getAttribute("aria-modal")).toBe("true");
    expect(mdlg.getAttribute("aria-labelledby")).toBe("mermaid-dialog-title");
  });

  test("mobile bottom sheet has dialog semantics, backdrop tap-to-dismiss, Escape-to-close, focus trap, and single-overlay dismissal", () => {
    const { doc, byId, app, step } = setupApp({ token: "t-ada", phone: true, coarse: true });

    const moreBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("More"));
    expect(moreBtn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(moreBtn.getAttribute("aria-expanded")).toBe("false");

    moreBtn.focus();
    moreBtn.click();
    step(2);

    expect(app.ui.sheet).toBe("tools");
    expect(byId.sheet.hidden).toBe(false);
    expect(byId.sheetBackdrop.hidden).toBe(false);
    expect(byId.sheet.getAttribute("role")).toBe("dialog");
    expect(byId.sheet.getAttribute("aria-modal")).toBe("true");
    expect(byId.sheet.getAttribute("aria-label")).toBe("More tools");

    // Sheet has a dedicated accessible close button
    const closeBtn = find(byId.sheet, e => e.tagName === "BUTTON" && e.classList.contains("sheet-close"));
    expect(closeBtn).toBeTruthy();
    expect(closeBtn.getAttribute("aria-label")).toBe("Close sheet");

    // Focus moved inside the sheet
    expect(byId.sheet.contains(doc.activeElement)).toBe(true);

    // Escape closes sheet & hides backdrop
    byId.sheet.fire("keydown", { key: "Escape" });
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(byId.sheet.hidden).toBe(true);
    expect(byId.sheetBackdrop.hidden).toBe(true);

    // Backdrop tap dismisses open sheet
    const styleBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("Style"));
    styleBtn.click();
    step(2);
    expect(app.ui.sheet).toBe("panel");
    expect(byId.sheetBackdrop.hidden).toBe(false);
    byId.sheetBackdrop.click();
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(byId.sheet.hidden).toBe(true);
    expect(byId.sheetBackdrop.hidden).toBe(true);

    // Opening a dialog cleanly dismisses an open sheet (no stacking)
    find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("More")).click();
    step(2);
    expect(app.ui.sheet).toBe("tools");
    app.openDialog("export");
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(byId.sheet.hidden).toBe(true);
    expect(byId.sheetBackdrop.hidden).toBe(true);
    expect(app.ui.dialog).toBe("export");
  });
});

// ── 3. Mobile CSS Ergonomics Assertions ──
describe("Mobile CSS ergonomics (web/style.css)", () => {
  const css = readFileSync(join(import.meta.dir, "../../web/style.css"), "utf8");

  test("defines >= 44px touch targets for coarse pointers and <= 768px / <= 640px mobile viewports", () => {
    const mobile768 = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(mobile768).toMatch(/min-width:\s*44px/);
    expect(mobile768).toMatch(/min-height:\s*44px/);
    expect(mobile768).toContain(".dock .tb");
    expect(mobile768).toContain(".sheet .sheet-close");
    expect(mobile768).toContain(".hud .grp .tb");

    const coarse = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(coarse).toMatch(/min-width:\s*44px/);
    expect(coarse).toMatch(/min-height:\s*44px/);
    expect(coarse).toContain(".sheet .sheet-close");
    expect(coarse).toContain(".dialog .tb");
  });

  test("applies env(safe-area-inset-top/bottom), touch-action: manipulation, and 100dvh with 100vh fallback", () => {
    expect(css).toContain("env(safe-area-inset-top)");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).toMatch(/touch-action:\s*manipulation/);
    expect(css).toMatch(/height:\s*100vh;\s*height:\s*100dvh/);
    expect(css).toContain(".sheet-backdrop");
  });

  test("enforces >= 16px font-size on mobile inputs (including email & search) to prevent iOS auto-zoom", () => {
    const mobile768 = css.match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(mobile768).toMatch(/font-size:\s*max\(16px,\s*1rem\)/);
    expect(mobile768).toContain('input[type="email"]');
    expect(mobile768).toContain('input[type="search"]');
    expect(mobile768).toContain(".home-search");
    expect(mobile768).toContain(".dialog .field");

    const coarse = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(coarse).toMatch(/font-size:\s*16px/);
    expect(coarse).toContain('input[type="email"]');
    expect(coarse).toContain(".home-search");
  });
});
