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
const keyOf = el => el.getAttribute?.("data-fk") ?? null;
/** The kind of control a key names, for the fallback when its row is gone: `thread:<id>` -> "thread", `note:<id>:delete` -> "note:delete". Anything else has no kind (no fallback). */
const ACTIONS = new Set(["delete", "edit", "jump", "lock", "visible"]);
const kindOf = k => { const p = String(k).split(":"); return p.length === 2 ? p[0] : p.length === 3 && ACTIONS.has(p[2]) ? `${p[0]}:${p[2]}` : null; };
const CONTROL = /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/;
const sayText = el => (el.textContent ?? "").trim().slice(0, 40);

/**
 * Give an unmarked control a key from what it says (`auto:<tag>:<label>`), but only when that label is unique in its root: the key must name ONE
 * control. A control whose label repeats (a Lock button on every layer, a delete on every note) gets no automatic key; the page must mark it with
 * a key made of its own ids (`layer:<id>:lock`), or focus is simply not restored for it. Automatic keys are exact-match only (never a fallback).
 */
function autoKey(root) {
  const all = walk(root).filter(e => CONTROL.test(e.tagName) && keyOf(e) === null);
  const label = e => e.getAttribute?.("aria-label") || e.getAttribute?.("title") || sayText(e);
  const count = new Map();
  for (const e of all) { const k = `${e.tagName}\n${label(e)}`; count.set(k, (count.get(k) ?? 0) + 1); }
  for (const e of all) { const l = label(e), k = `${e.tagName}\n${l}`; if (l && count.get(k) === 1) e.setAttribute("data-fk", `auto:${e.tagName}:${l}`); }
}

/** Where focus is, if on a keyed control inside one of `roots`: its key, and the keys of its root in order (for the fallback). */
export function captureFocus(roots) {
  const a = doc()?.activeElement;
  if (!a || a === doc().body) return null;
  const root = roots.find(r => r?.contains?.(a));
  if (!root) return null;
  autoKey(root);
  const key = keyOf(a);
  if (key === null) return null;
  return { root, el: a, key, order: walk(root).map(keyOf).filter(k => k !== null) };
}

/**
 * Put focus back on the control with the SAME KEY in the rebuilt root (exact match only; never by label, text or position). If that key is gone
 * (its row was deleted), go to the next control of the same kind that still exists, then the previous one, then the root's "heading". Automatic
 * keys have no neighbours: a control that only had a label has nothing to fall back to.
 */
export function restoreFocus(held) {
  if (!held) return false;
  const a = doc()?.activeElement, now = walk(held.root);
  // Nothing to do if focus moved somewhere on purpose, or the very element still sits in its root (it was not rebuilt).
  if (a && a !== doc().body && a.isConnected !== false && (a !== held.el || now.includes(a))) return false;
  autoKey(held.root);
  const keyed = walk(held.root).filter(e => keyOf(e) !== null), byKey = k => keyed.find(e => keyOf(e) === k);
  let to = byKey(held.key);
  if (!to && !held.key.startsWith("auto:")) {
    const kind = kindOf(held.key), i = held.order.indexOf(held.key), same = kind === null ? [] : held.order.map((k, j) => [k, j]).filter(([k]) => kindOf(k) === kind);
    to = [...same.filter(([, j]) => j > i), ...same.filter(([, j]) => j < i).reverse()].map(([k]) => byKey(k)).find(Boolean) ?? byKey("heading");
  }
  to?.focus?.();
  return !!to;
}
