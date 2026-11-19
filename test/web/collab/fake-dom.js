// A minimal DOM for the collab UI tests. Every HTML sink throws, so any use of one fails the test.
class FakeNode {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) { for (const n of ns) { const node = typeof n === "object" ? n : new FakeText(String(n)); node.parentNode?.removeChild(node); node.parentNode = this; this.childNodes.push(node); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(new FakeText(String(v))); }
}
class FakeText extends FakeNode { constructor(t) { super(3); this.data = t; } get textContent() { return this.data; } }
const sink = name => ({ get() { throw new Error(`${name} read`); }, set() { throw new Error(`${name} set: HTML sink used`); } });
export class FakeElement extends FakeNode {
  constructor(tag) {
    super(1); this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.className = ""; this.listeners = {};
    const styles = new Map(); this.style = { setProperty: (k, v) => styles.set(k, v), getPropertyValue: k => styles.get(k) ?? "", _map: styles };
    this.classList = {
      contains: c => this.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); this.className = [...s].join(" "); },
    };
    this.clientWidth = 1200; this.clientHeight = 800; this.hidden = false; this.disabled = false; this.value = "";
  }
  setAttribute(k, v) { if (/^on/i.test(k)) throw new Error(`event attribute ${k}`); this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, ev = {}) { const e = { currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...ev }; for (const fn of this.listeners[type] ?? []) fn(e); }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() {}
  /** Like the real HTMLCollection: indexable, `length`, `item`, iterable, and NO array methods (so `children.indexOf` fails here as it does in Chrome). */
  get children() {
    const els = this.childNodes.filter(n => n.nodeType === 1), c = { length: els.length, item: i => els[i] ?? null, [Symbol.iterator]: () => els[Symbol.iterator]() };
    els.forEach((e, i) => { c[i] = e; });
    return c;
  }
  /** Every element under (and including) this one. */
  all() { return [this, ...this.childNodes.filter(n => n.nodeType === 1).flatMap(c => c.all())]; }
  find(pred) { return this.all().find(pred); }
  findAll(pred) { return this.all().filter(pred); }
  hasClass(c) { return this.classList.contains(c); }
}
for (const k of ["innerHTML", "outerHTML"]) Object.defineProperty(FakeElement.prototype, k, sink(k));
FakeElement.prototype.insertAdjacentHTML = () => { throw new Error("insertAdjacentHTML: HTML sink used"); };

export function installDom() {
  const created = [];
  globalThis.document = {
    createElement: tag => { const el = new FakeElement(tag); created.push(el.tagName); return el; },
    createTextNode: t => new FakeText(t),
  };
  return { created, root: new FakeElement("div") };
}
export const textOf = el => el.textContent;
export const byClass = (root, c) => root.findAll(e => e.hasClass(c));
export const button = (root, text) => root.find(e => e.tagName === "BUTTON" && e.textContent.trim().startsWith(text));
