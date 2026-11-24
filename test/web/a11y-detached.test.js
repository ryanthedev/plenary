// Edge-case unit tests for web/adapters/dom/a11y.js detached overlay pruning:
// (a) nested traps where inner container is .remove()d on an isConnected DOM
// (b) stub DOM without isConnected where dialogs.replaceChildren() detaches the container
// (c) fake-dom-style detached mountRoot (with and without document.body)

import { describe, test, expect } from "bun:test";
import { trapFocus, hasActiveOverlay } from "../../web/adapters/dom/a11y.js";
import { FakeElement } from "./collab/fake-dom.js";

function makeConnectedDom() {
  let docRef = null;
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.parentNode = null;
      this.childNodes = [];
      this.attrs = {};
      this.listeners = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
    }
    append(...ns) {
      for (const n of ns) {
        n.parentNode?.removeChild(n);
        n.parentNode = this;
        this.childNodes.push(n);
      }
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) this.childNodes.splice(i, 1);
      n.parentNode = null;
    }
    replaceChildren(...ns) {
      for (const c of [...this.childNodes]) this.removeChild(c);
      this.append(...ns);
    }
    remove() { this.parentNode?.removeChild(this); }
    get children() { return this.childNodes; }
    get isConnected() {
      let x = this;
      while (x.parentNode) x = x.parentNode;
      return x === docRef?.body || x === docRef?.documentElement;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
    focus() { docRef.activeElement = this; }
  }

  const docL = {};
  let adds = 0, removes = 0;
  const body = new Node("body");
  const documentElement = new Node("html");
  documentElement.append(body);
  const doc = {
    body,
    documentElement,
    activeElement: body,
    addEventListener(t, fn) { if (t === "keydown") adds++; (docL[t] ??= []).push(fn); },
    removeEventListener(t, fn) { if (t === "keydown") removes++; docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
    fire(t, ev = {}) {
      const e = { target: doc.activeElement, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...ev };
      for (const fn of [...(docL[t] ?? [])]) fn(e);
      return e;
    },
    counts: () => ({ adds, removes, activeListeners: (docL.keydown ?? []).length }),
  };
  docRef = doc;
  return { doc, Node };
}

function makeStubDomWithoutIsConnected() {
  class StubNode {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.parentNode = null;
      this.childNodes = [];
      this.attrs = {};
      this.listeners = {};
      this.hidden = false;
      this.disabled = false;
    }
    append(...ns) {
      for (const n of ns) {
        n.parentNode?.removeChild(n);
        n.parentNode = this;
        this.childNodes.push(n);
      }
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) this.childNodes.splice(i, 1);
      n.parentNode = null;
    }
    replaceChildren(...ns) {
      for (const c of [...this.childNodes]) this.removeChild(c);
      this.append(...ns);
    }
    remove() { this.parentNode?.removeChild(this); }
    get children() { return this.childNodes; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
    focus() { doc.activeElement = this; }
  }

  const docL = {};
  let adds = 0, removes = 0;
  const body = new StubNode("body");
  const documentElement = new StubNode("html");
  const doc = {
    body,
    documentElement,
    activeElement: body,
    addEventListener(t, fn) { if (t === "keydown") adds++; (docL[t] ??= []).push(fn); },
    removeEventListener(t, fn) { if (t === "keydown") removes++; docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
    fire(t, ev = {}) {
      const e = { target: doc.activeElement, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...ev };
      for (const fn of [...(docL[t] ?? [])]) fn(e);
      return e;
    },
    counts: () => ({ adds, removes, activeListeners: (docL.keydown ?? []).length }),
  };
  return { doc, StubNode };
}

describe("a11y detached overlay pruning", () => {
  test("(a) nested traps with isConnected: .remove() on inner restores outer and Escape reaches outer; removing outer releases doc listener", () => {
    const { doc, Node } = makeConnectedDom();
    const opener = new Node("button");
    const outer = new Node("div");
    const outerBtn = new Node("button");
    outer.append(outerBtn);
    const inner = new Node("div");
    const innerBtn = new Node("button");
    inner.append(innerBtn);
    doc.body.append(opener, outer, inner);
    opener.focus();

    let outerEsc = 0, innerEsc = 0;
    const outerTrap = trapFocus(outer, { doc, onEscape: () => { outerEsc++; outerTrap.deactivate(); } });
    const innerTrap = trapFocus(inner, { doc, onEscape: () => { innerEsc++; innerTrap.deactivate(); } });

    expect(hasActiveOverlay(doc)).toBe(true);
    expect(doc.counts()).toEqual({ adds: 1, removes: 0, activeListeners: 1 });

    // Remove inner directly from DOM without calling innerTrap.deactivate().
    inner.remove();
    expect(inner.isConnected).toBe(false);
    expect(hasActiveOverlay(doc)).toBe(true);
    expect(innerTrap.isActive()).toBe(false);
    expect(outerTrap.isActive()).toBe(true);
    expect(doc.counts().activeListeners).toBe(1);

    // Escape now reaches outerTrap (and deactivates outer cleanly).
    const esc = doc.fire("keydown", { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(innerEsc).toBe(0);
    expect(outerEsc).toBe(1);
    expect(outerTrap.isActive()).toBe(false);
    expect(hasActiveOverlay(doc)).toBe(false);
    expect(doc.counts()).toEqual({ adds: 1, removes: 1, activeListeners: 0 });
    expect(doc.activeElement).toBe(opener);

    // Also verify direct outer.remove() without deactivate() releases the doc listener.
    doc.body.append(outer);
    const outerTrap2 = trapFocus(outer, { doc });
    expect(hasActiveOverlay(doc)).toBe(true);
    expect(doc.counts()).toEqual({ adds: 2, removes: 1, activeListeners: 1 });
    outer.remove();
    expect(hasActiveOverlay(doc)).toBe(false);
    expect(outerTrap2.isActive()).toBe(false);
    expect(doc.counts()).toEqual({ adds: 2, removes: 2, activeListeners: 0 });
    // Subsequent deactivate() is a safe no-op.
    expect(() => outerTrap2.deactivate()).not.toThrow();
  });

  test("(b) stub DOM without isConnected: dialogs.replaceChildren() prunes trap, updates isActive(), and removes doc listener without stealing focus", () => {
    const { doc, StubNode } = makeStubDomWithoutIsConnected();
    const dialogs = new StubNode("div");
    let openerFocusCount = 0;
    const opener = { focus() { openerFocusCount++; doc.activeElement = opener; } };
    const otherControl = new StubNode("button");
    doc.body.append(dialogs, otherControl);

    const veil = new StubNode("div");
    const dlg = new StubNode("div");
    const dlgBtn = new StubNode("button");
    dlg.append(dlgBtn);
    veil.append(dlg);
    dialogs.append(veil);

    const trap = trapFocus(dlg, { doc, returnFocusTo: opener });
    expect(dlg.isConnected).toBeUndefined();
    expect(hasActiveOverlay(doc)).toBe(true);
    expect(trap.isActive()).toBe(true);
    expect(doc.counts()).toEqual({ adds: 1, removes: 0, activeListeners: 1 });

    // Move focus elsewhere, then clear #dialogs without calling trap.deactivate().
    otherControl.focus();
    dialogs.replaceChildren();

    expect(hasActiveOverlay(doc)).toBe(false);
    expect(trap.isActive()).toBe(false);
    expect(doc.counts()).toEqual({ adds: 1, removes: 1, activeListeners: 0 });
    // Silent pruning must NOT steal focus back to opener.
    expect(openerFocusCount).toBe(0);
    expect(doc.activeElement).toBe(otherControl);
    // Container keydown listener was removed and deactivate() is a no-op.
    expect(dlg.listeners.keydown ?? []).toEqual([]);
    expect(() => trap.deactivate()).not.toThrow();
  });

  test("(c) fake-dom detached mountRoot stays active while mounted in mountRoot (with or without doc.body) and prunes once detached", () => {
    const origFocus = FakeElement.prototype.focus;
    try {
      for (const withBody of [false, true]) {
        const docL = {};
        let adds = 0, removes = 0;
        const doc = {
          ...(withBody ? { body: new FakeElement("body") } : {}),
          activeElement: null,
          addEventListener(t, fn) { if (t === "keydown") adds++; (docL[t] ??= []).push(fn); },
          removeEventListener(t, fn) { if (t === "keydown") removes++; docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
        };
        FakeElement.prototype.focus = function () { doc.activeElement = this; };

        const root = new FakeElement("div"); // detached host root (never appended to doc.body)
        const veil = new FakeElement("div");
        const dialog = new FakeElement("div");
        const btn = new FakeElement("button");
        dialog.append(btn);
        veil.append(dialog);
        root.append(veil);

        let escaped = 0;
        const trap = trapFocus(dialog, { doc: /** @type {any} */ (doc), onEscape: () => { escaped++; } });
        expect(hasActiveOverlay(/** @type {any} */ (doc))).toBe(true);
        expect(trap.isActive()).toBe(true);
        expect(adds).toBe(1);

        // While still mounted in mountRoot, Escape works via document listener.
        for (const fn of [...(docL.keydown ?? [])]) fn({ key: "Escape", preventDefault() {}, stopPropagation() {} });
        expect(escaped).toBe(1);
        expect(hasActiveOverlay(/** @type {any} */ (doc))).toBe(true);

        // Detaching veil from mountRoot prunes the entry.
        veil.remove();
        expect(hasActiveOverlay(/** @type {any} */ (doc))).toBe(false);
        expect(trap.isActive()).toBe(false);
        expect(removes).toBe(1);
      }
    } finally {
      FakeElement.prototype.focus = origFocus;
    }
  });
});
