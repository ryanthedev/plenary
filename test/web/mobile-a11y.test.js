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
import { createFocusTrap, trapFocus, hasActiveOverlay, getFocusableElements, accessibleName } from "../../web/adapters/dom/a11y.js";

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
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport", "history", "Image"];
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

function setupApp({ token = "t-ada", phone = true, coarse = true, admin = null, share = null, move = null, uploadBlob = null, history = undefined } = {}) {
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
    history,
    Image: class { set src(v) { this._src = v; this.complete = true; this.naturalWidth = 1; this.naturalHeight = 1; this.onload?.(); } get src() { return this._src; } },
  });

  const net = localRoom({ board: "a11y-board", users: USERS, clock: true });
  const appNet = { kind: "local", put() {}, onFile() {}, ...(uploadBlob ? { uploadBlob } : {}) };
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({
      join: () => net.join(), token, board: "a11y-board",
      client: USERS[token].user, user: USERS[token].user, mine, onChange, clock: net.clock,
      ...(uploadBlob ? { uploadBlob } : {}),
    }),
    net: appNet,
    board: "a11y-board",
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    admin,
    share,
    move,
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
  const fireWin = (t, ev = {}) => {
    const e = { defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; }, ...ev };
    for (const fn of [...(winL[t] ?? [])]) fn(e);
    return e;
  };
  step(3);
  return { doc, byId: doc._byId, app, S: app.S, net, step, fireWin };
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

  test("accessibleName handles malformed aria-labelledby IDs safely without throwing", () => {
    const doc = makeDoc();
    doc.querySelector = sel => {
      if (/[^\w#\-[\]="\\]/.test(sel)) throw new Error(`SyntaxError: invalid selector ${sel}`);
      return null;
    };
    const btn = new E("button");
    btn.setAttribute("aria-labelledby", 'foo:bar[baz] 123"bad] a>b');
    btn.textContent = "Fallback Label";
    expect(() => accessibleName(btn, doc)).not.toThrow();
    expect(accessibleName(btn, doc)).toBe("Fallback Label");

    // Also safe when getElementById is absent and querySelector throws on malformed input
    const stubDoc = {
      querySelector: () => { throw new Error("DOMException: SyntaxError"); },
    };
    const emptyBtn = new E("button");
    emptyBtn.setAttribute("aria-labelledby", 'bad]id"here');
    expect(() => accessibleName(emptyBtn, stubDoc)).not.toThrow();
    expect(accessibleName(emptyBtn, stubDoc)).toBe("");
  });

  test("unified overlay stack (bubbling DOM): only topmost overlay handles Tab & Escape, single document listener, closing top restores underlying overlay", () => {
    const doc = makeDoc();
    globalThis.document = doc;
    let docKeydownAdds = 0, docKeydownRemoves = 0;
    const origAdd = doc.addEventListener, origRem = doc.removeEventListener;
    doc.addEventListener = (t, fn) => { if (t === "keydown") docKeydownAdds++; origAdd(t, fn); };
    doc.removeEventListener = (t, fn) => { if (t === "keydown") docKeydownRemoves++; origRem(t, fn); };

    // Bubbling keydown dispatch from target -> ancestors -> document (matching real browser DOM)
    const dispatchBubblingKeydown = (target, init) => {
      const ev = {
        target,
        currentTarget: target,
        defaultPrevented: false,
        stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        ...init,
      };
      for (let node = target; node && !ev.stopped; node = node.parentNode) {
        ev.currentTarget = node;
        for (const fn of [...(node.listeners?.keydown ?? [])]) fn(ev);
      }
      if (!ev.stopped) return doc.fire("keydown", ev);
      return ev;
    };

    const trigger = new E("button"); trigger.textContent = "Open outer";
    const outer = new E("div"); outer.setAttribute("role", "dialog");
    const outerFirst = new E("button"); outerFirst.textContent = "Outer 1";
    const outerLast = new E("button"); outerLast.textContent = "Outer 2";
    const inner = new E("div"); inner.setAttribute("role", "dialog");
    const innerFirst = new E("button"); innerFirst.textContent = "Inner 1";
    const innerLast = new E("button"); innerLast.textContent = "Inner 2";
    inner.append(innerFirst, innerLast);
    outer.append(outerFirst, outerLast, inner);
    doc.body.append(trigger, outer);

    trigger.focus();
    expect(hasActiveOverlay(doc)).toBe(false);

    let outerEsc = 0, innerEsc = 0;
    const outerTrap = trapFocus(outer, {
      doc,
      onEscape: () => { outerEsc++; outerTrap.deactivate(); },
    });
    expect(hasActiveOverlay(doc)).toBe(true);
    expect(docKeydownAdds).toBe(1);
    expect(doc.activeElement).toBe(outerFirst);

    const innerTrap = trapFocus(inner, {
      doc,
      onEscape: () => { innerEsc++; innerTrap.deactivate(); },
    });
    // Still only ONE document-level keydown listener for the entire overlay stack
    expect(docKeydownAdds).toBe(1);
    expect(hasActiveOverlay(doc)).toBe(true);
    expect(doc.activeElement).toBe(innerFirst);

    // Tab wraps strictly inside inner overlay; outer does not interfere
    innerLast.focus();
    const tabInner = dispatchBubblingKeydown(innerLast, { key: "Tab", shiftKey: false });
    expect(tabInner.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(innerFirst);

    // Escape on inner closes ONLY inner (never bubbles to close outer)
    const escInner = dispatchBubblingKeydown(innerFirst, { key: "Escape" });
    expect(escInner.defaultPrevented).toBe(true);
    expect(innerEsc).toBe(1);
    expect(outerEsc).toBe(0);
    expect(innerTrap.isActive()).toBe(false);
    expect(outerTrap.isActive()).toBe(true);
    expect(hasActiveOverlay(doc)).toBe(true);
    expect(docKeydownRemoves).toBe(0);
    expect(doc.activeElement).toBe(outerFirst);

    // Now outer is back on top of the stack: Tab wraps inside outer
    outerFirst.focus();
    const shiftTabOuter = dispatchBubblingKeydown(outerFirst, { key: "Tab", shiftKey: true });
    expect(shiftTabOuter.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(innerLast); // inner is still in DOM as child of outer, so it's the last focusable

    // Escape from document.body (outside outer) closes outer via the single document listener
    doc.body.focus();
    const escOuter = dispatchBubblingKeydown(doc.body, { key: "Escape" });
    expect(escOuter.defaultPrevented).toBe(true);
    expect(outerEsc).toBe(1);
    expect(outerTrap.isActive()).toBe(false);
    expect(hasActiveOverlay(doc)).toBe(false);
    expect(docKeydownRemoves).toBe(1);
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

  test("admin mountShareDialog restores focus to the Share opener button on Escape, backdrop click, and Close button (not canvas)", () => {
    const stubAdmin = {
      listLinks: async () => ({ links: [] }),
      listInvites: async () => ({ invites: [] }),
      listAudit: async () => ({ events: [], nextCursor: null }),
    };
    const { doc, byId, step } = setupApp({ token: "t-ada", phone: false, coarse: false, admin: stubAdmin });

    const getShareBtn = () => find(byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("aria-label") === "Share board");

    // 1) Escape restores focus to Share board button
    let shareBtn = getShareBtn();
    expect(shareBtn).toBeTruthy();
    shareBtn.focus();
    shareBtn.click();
    step(2);
    let modal = find(byId.dialogs, e => e.getAttribute("role") === "dialog");
    expect(modal).toBeTruthy();
    modal.fire("keydown", { key: "Escape" });
    step(2);
    expect(byId.dialogs.children.length).toBe(0);
    expect(doc.activeElement?.getAttribute("aria-label")).toBe("Share board");
    expect(doc.activeElement).not.toBe(byId.board);

    // 2) Backdrop click restores focus to Share board button
    shareBtn = getShareBtn();
    shareBtn.focus();
    shareBtn.click();
    step(2);
    const veil = find(byId.dialogs, e => e.classList.contains("adm-veil"));
    expect(veil).toBeTruthy();
    veil.click();
    step(2);
    expect(byId.dialogs.children.length).toBe(0);
    expect(doc.activeElement?.getAttribute("aria-label")).toBe("Share board");

    // 3) Close button restores focus to Share board button
    shareBtn = getShareBtn();
    shareBtn.focus();
    shareBtn.click();
    step(2);
    const closeBtn = find(byId.dialogs, e => e.tagName === "BUTTON" && e.getAttribute("data-action") === "close");
    expect(closeBtn).toBeTruthy();
    closeBtn.click();
    step(2);
    expect(byId.dialogs.children.length).toBe(0);
    expect(doc.activeElement?.getAttribute("aria-label")).toBe("Share board");
  });

  test("M1: phone More sheet restores focus to visible dock More button (not hidden desktop .header-more)", () => {
    const { doc, byId, app, step } = setupApp({ token: "t-ada", phone: true, coarse: true });

    // Simulate real browser CSS: desktop .header-more is display:none !important on <= 1023px (offsetParent === null)
    const markDesktopMoreHidden = () => {
      const desktopMore = find(byId.topbar, e => e.classList.contains("header-more"));
      if (desktopMore) desktopMore.offsetParent = null;
    };
    markDesktopMoreHidden();

    const dockMore = find(byId.dock, e => e.hasAttribute("data-dock-more"));
    expect(dockMore).toBeTruthy();
    expect(dockMore.getAttribute("aria-label")).toBe("More");
    dockMore.focus();
    dockMore.click();
    step(2);
    markDesktopMoreHidden();
    expect(app.ui.sheet).toBe("tools");

    // Escape closes the sheet: focus must land on the visible dock [data-dock-more], NOT hidden .header-more
    byId.sheet.fire("keydown", { key: "Escape" });
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(doc.activeElement?.hasAttribute("data-dock-more")).toBe(true);
    expect(doc.activeElement?.classList.contains("header-more")).toBe(false);

    // Opening from topbar .overflow-btn restores focus back to .overflow-btn
    const overflowBtn = find(byId.topbar, e => e.classList.contains("overflow-btn"));
    expect(overflowBtn).toBeTruthy();
    overflowBtn.focus();
    overflowBtn.click();
    step(2);
    markDesktopMoreHidden();
    expect(app.ui.sheet).toBe("tools");
    byId.sheetBackdrop.click();
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(doc.activeElement?.classList.contains("overflow-btn")).toBe(true);
  });

  test("M3: document.body-mounted Share dialog blocks board shortcuts (Delete, Cmd+Shift+E) even when focus is on body", () => {
    const stubShare = {
      view: async () => ({ view: { board: { id: "a11y-board", title: "Test" }, unit: { domains: [] }, limits: { inviteRoles: [], linkRoles: [], inviteTtlMs: 0 }, invites: [], links: [], more: false } }),
    };
    const { doc, app, S, step } = setupApp({ token: "t-ada", phone: false, coarse: false, share: stubShare });

    // Place and select a rectangle on the board
    S.setTool("rectangle");
    S.pointerDown({ x: 40, y: 40 });
    S.pointerMove({ x: 140, y: 120 });
    S.pointerUp({ x: 140, y: 120 });
    step(2);
    expect(S.eds.board.doc.live().length).toBe(1);
    const rectId = S.eds.board.doc.live()[0].id;
    S.act("board", ed => ed.select([rectId]));

    // Open document.body-mounted Share dialog
    const dlg = app.openShare();
    expect(dlg).toBeTruthy();
    expect(hasActiveOverlay(doc)).toBe(true);

    // Move focus to document.body (outside the dialog) and fire Delete and Cmd+Shift+E
    doc.body.focus();
    expect(doc.activeElement).toBe(doc.body);
    doc.fire("keydown", { key: "Delete", target: doc.body });
    doc.fire("keydown", { key: "e", metaKey: true, shiftKey: true, target: doc.body });
    step(2);

    // Shape must NOT be deleted and Export dialog must NOT open while Share dialog is active
    expect(S.eds.board.doc.live().length).toBe(1);
    expect(app.ui.dialog).toBe(null);

    // Close Share dialog: board shortcuts resume working
    dlg.close();
    expect(hasActiveOverlay(doc)).toBe(false);
    doc.fire("keydown", { key: "Delete", target: doc.body });
    step(2);
    expect(S.eds.board.doc.live().length).toBe(0);
  });

  test("H4: mobile bottom sheet pushes history state, popstate dismisses cleanly without double-back, and beforeunload guards unsent ops", () => {
    const histStack = [{ page: "board" }];
    let backCalls = 0, pushCalls = 0, replaceCalls = 0;
    let triggerPopstate = null;
    const mockHistory = {
      get state() { return histStack[histStack.length - 1]; },
      pushState(s) { pushCalls++; histStack.push(s); },
      replaceState(s) { replaceCalls++; histStack[histStack.length - 1] = s; },
      back() {
        backCalls++;
        if (histStack.length > 1) histStack.pop();
        triggerPopstate?.();
      },
    };

    const { byId, app, S, net, step, fireWin } = setupApp({ token: "t-ada", phone: true, coarse: true, history: mockHistory });
    triggerPopstate = () => fireWin("popstate");

    // 1) Opening a sheet pushes one history entry
    const moreBtn = find(byId.dock, e => e.hasAttribute("data-dock-more"));
    moreBtn.click();
    step(2);
    expect(app.ui.sheet).toBe("tools");
    expect(pushCalls).toBe(1);
    expect(histStack.length).toBe(2);
    expect(mockHistory.state).toEqual({ plenarySheet: "tools" });

    // Switching sheets replaces state rather than pushing another entry
    const styleBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("Style"));
    styleBtn.click();
    step(2);
    expect(app.ui.sheet).toBe("panel");
    expect(pushCalls).toBe(1);
    expect(replaceCalls).toBe(1);
    expect(histStack.length).toBe(2);

    // 2) Simulated iOS back-swipe (popstate) dismisses sheet without calling history.back() again
    histStack.pop();
    fireWin("popstate");
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(byId.sheet.hidden).toBe(true);
    expect(backCalls).toBe(0);
    expect(histStack.length).toBe(1);

    // 3) Closing sheet via Escape pops the pushed entry once without double-navigating
    find(byId.dock, e => e.hasAttribute("data-dock-more")).click();
    step(2);
    expect(app.ui.sheet).toBe("tools");
    expect(histStack.length).toBe(2);
    byId.sheet.fire("keydown", { key: "Escape" });
    step(2);
    expect(app.ui.sheet).toBe(null);
    expect(backCalls).toBe(1);
    expect(histStack.length).toBe(1);

    // 4) beforeunload: clean board does NOT block unload; unsent pending ops DO block unload
    expect(S.pending).toBe(0);
    const cleanUnload = fireWin("beforeunload");
    expect(cleanUnload.defaultPrevented).toBe(false);

    // Draw a shape without stepping the transport so the op is still unacked (S.pending > 0)
    S.act("board", ed => {
      ed.setTool("rectangle");
      ed.pointerDown({ x: 10, y: 10 });
      ed.pointerMove({ x: 60, y: 60 });
      ed.pointerUp({ x: 60, y: 60 });
    });
    expect(S.pending).toBeGreaterThan(0);
    const dirtyUnload = fireWin("beforeunload");
    expect(dirtyUnload.defaultPrevented).toBe(true);
    expect(dirtyUnload.returnValue).toBe("");

    // Once the transport settles (acked), S.pending returns to 0 and beforeunload stops nagging
    step(3);
    expect(S.pending).toBe(0);
    const settledUnload = fireWin("beforeunload");
    expect(settledUnload.defaultPrevented).toBe(false);
    void net;
  });

  test("H5: Excalidraw import aborts and toasts error when any embedded image blob upload fails", async () => {
    let failUpload = true;
    let uploadAttempts = 0;
    const { byId, S, step } = setupApp({
      token: "t-ada",
      phone: false,
      coarse: false,
      uploadBlob: async () => {},
    });
    S.uploadBlob = async () => {
      uploadAttempts++;
      if (failUpload) throw new Error("network down");
    };

    const tinyPngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const excalidrawJson = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [{
        id: "img-1",
        type: "image",
        x: 10,
        y: 20,
        width: 100,
        height: 100,
        fileId: "orig-file-1",
        status: "saved",
      }],
      files: {
        "orig-file-1": { id: "orig-file-1", mimeType: "image/png", dataURL: tinyPngDataUrl, created: 1 },
      },
    });

    const makeFile = () => ({ name: "deck.excalidraw", size: excalidrawJson.length, type: "application/json", text: async () => excalidrawJson });

    // 1) Failing upload aborts the import — 0 elements committed, toast reports upload failure
    byId.picker.files = [makeFile()];
    byId.picker.fire("change");
    await new Promise(r => setTimeout(r, 20));
    step(2);
    expect(uploadAttempts).toBe(1);
    expect(S.eds.board.doc.live().length).toBe(0);
    expect(byId.toast.hidden).toBe(false);
    expect(byId.toast.textContent.toLowerCase()).toContain("upload failed");

    // 2) Succeeding upload commits the imported image element cleanly
    failUpload = false;
    byId.picker.files = [makeFile()];
    byId.picker.fire("change");
    await new Promise(r => setTimeout(r, 20));
    step(2);
    expect(uploadAttempts).toBe(2);
    expect(S.eds.board.doc.live().length).toBe(1);
    expect(S.eds.board.doc.live()[0].type).toBe("image");
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
