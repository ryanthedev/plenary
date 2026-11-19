// Focus that survives a redraw (part of the dom group; imports nothing). A page that rebuilds its controls would otherwise drop focus to
// <body> whenever the person Tabs, clicks or activates something that redraws. Two tools:
//   keeper()            for pages that mark their controls with stable keys (Home, Space, Group): `keep` hands back the same element every
//                       render, `mark` labels what may hold focus, `around(fn)` runs a render and puts focus back on the marked element that
//                       had it. If that element is gone (its card left the list), focus goes to the next marked element of the same kind, then
//                       the previous one, then the element marked "heading".
//   captureFocus/restoreFocus   for chrome that is rebuilt wholesale (the board's panels, dock, timeline, dialogs): remember where focus was by
//                       what the control says (aria-label, title, text, position) and find its twin in the rebuilt root.

const doc = () => globalThis.document ?? null;
const lost = () => { const a = doc()?.activeElement; return !a || a === doc().body || a.isConnected === false; };

export function keeper() {
  const kept = new Map(); let marks = new Map(), used = new Set();
  const fk = () => doc()?.activeElement?.getAttribute?.("data-fk") ?? null;
  const kind = k => String(k).split(":")[0];
  return {
    keep(key, make) { let v = kept.get(key); if (!v) kept.set(key, v = make()); used.add(key); return v; },
    mark(el, key) { el.setAttribute("data-fk", key); marks.set(key, el); return el; },
    /** Focus the marked element with this key (after a render). */
    focusKey(key) { marks.get(key)?.focus?.(); },
    around(fn) {
      const had = fk(), prev = doc()?.activeElement ?? null, before = [...marks.keys()];
      used = new Set(); marks = new Map();
      fn();
      for (const k of [...kept.keys()]) if (!used.has(k)) kept.delete(k);
      if (!had) { if (prev?.isConnected && doc()?.activeElement !== prev) prev.focus?.(); return; }   // an unmarked element that was moved (an open menu's item)
      let to = marks.get(had);
      if (!to) {
        const i = before.indexOf(had), same = before.map((k, j) => [k, j]).filter(([k]) => kind(k) === kind(had));
        const order = [...same.filter(([, j]) => j > i), ...same.filter(([, j]) => j < i).reverse()];
        to = order.map(([k]) => marks.get(k)).find(Boolean) ?? marks.get("heading");
      }
      to?.focus?.();
    },
  };
}

const kids = el => [...(el.children ?? [])];
const walk = root => { const out = []; const visit = e => { for (const c of kids(e)) { out.push(c); visit(c); } }; visit(root); return out; };
const attr = (el, k) => el.getAttribute?.(k) ?? null;
const sayText = el => (el.textContent ?? "").trim().slice(0, 40);

/** Where focus is, if inside one of `roots`: what the control says, and its position among same-tag controls. */
export function captureFocus(roots) {
  const a = doc()?.activeElement;
  if (!a || a === doc().body) return null;
  const root = roots.find(r => r?.contains?.(a));
  if (!root) return null;
  const same = walk(root).filter(e => e.tagName === a.tagName);
  return { root, el: a, tag: a.tagName, aria: attr(a, "aria-label"), title: attr(a, "title"), role: attr(a, "role"), text: sayText(a), nth: same.indexOf(a) };
}

/** Put focus back on the twin of a captured control in its (rebuilt) root, unless focus is already somewhere sensible. */
export function restoreFocus(held) {
  if (!held) return false;
  const all = walk(held.root), a = doc()?.activeElement;
  // Nothing to do if focus moved somewhere on purpose, or the very element still sits in its root (it was not rebuilt).
  if (a && a !== doc().body && a.isConnected !== false && (a !== held.el || all.includes(a))) return false;
  const tagged = all.filter(e => e.tagName === held.tag);
  const hit = (held.aria && all.find(e => attr(e, "aria-label") === held.aria))
    || (held.title && all.find(e => attr(e, "title") === held.title))
    || (held.text && tagged.find(e => sayText(e) === held.text))
    || tagged[held.nth] || null;
  hit?.focus?.();
  return !!hit;
}
