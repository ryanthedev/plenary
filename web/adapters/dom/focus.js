// Focus that survives a redraw (part of the dom group; imports nothing). A page that rebuilds its controls would otherwise drop focus to
// <body> whenever the person Tabs, clicks or activates something that redraws. Two tools:
//   keeper()            for pages that mark their controls with stable keys (Home, Space, Group): `keep` hands back the same element every
//                       render, `mark` labels what may hold focus, `around(fn)` runs a render and puts focus back on the marked element that
//                       had it. If that element is gone (its card left the list), focus goes to the next marked element of the same kind, then
//                       the previous one, then the element marked "heading".
//   captureFocus/restoreFocus   for chrome that is rebuilt wholesale (the board's panels, dock, timeline, dialogs): remember where focus was by
//                       what the control says (aria-label, title, text, position) and find its twin in the rebuilt root.

const doc = () => globalThis.document ?? null;

// ── announcements: when focus is moved because its row went away, say so (a polite live region) ──
const NOUN = { note: "note", layer: "layer", thread: "thread", msg: "comment", frame: "frame", "card-link": "board", card: "board", star: "board", "space-link": "Space", rolepick: "role", perm: "permission", who: "person or team", role: "person or team", remove: "person or team" };
let live = null;
/** Say `text` politely to screen readers (a visually hidden status region at the end of <body>). Returns the text that is now announced. */
export function announce(text) {
  const d = doc(); const body = d?.body;
  if (!body || typeof body.append !== "function") return null;
  if (!live || live.parentNode !== body) {
    live = d.createElement("div");
    live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite"); live.setAttribute("aria-atomic", "true"); live.setAttribute("data-live", "focus");
    Object.assign(live.style ?? {}, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" });
    body.append(live);
  }
  live.textContent = "";                                   // clear first so the same sentence twice is announced twice
  live.textContent = text;
  return text;
}
/** The text last announced (tests and debugging). */
export const announced = () => live?.textContent ?? "";
/** "That note is no longer here; moved to the next one." for a focus that moved from `key` to `toKey` (rows in `order`). */
export function fellBackText(key, toKey, order) {
  const noun = NOUN[String(key).split(":")[0]] ?? "item";
  const i = order.indexOf(key), j = order.indexOf(toKey);
  const where = toKey === "heading" ? "the top of the list" : j < 0 || i < 0 ? "a nearby one" : j > i ? "the next one" : "the previous one";
  return `That ${noun} is no longer here; moved to ${where}.`;
}
const CALM_KINDS = new Set(["card-link", "space-link", "card", "space", "group", "other", "who", "rolepick"]);
// A row's action (its role select, its remove button) falls back to a NEIGHBOURING row's neutral name ("who:"), never to the same action on another row.
const TO_ROW = { role: "who", remove: "who", "team-link": "who", perm: "rolepick" };
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
      let to = marks.get(had), toKey = had;
      if (!to) {
        // Only to a neutral control (a card's link, a Space link), never to a star or another row's action: a star on a neighbour is one Enter from acting on it.
        const parts = had.split(":"), sameKind = parts[0] === "star" ? k => k.startsWith(`card:${parts[1]}:`) : TO_ROW[parts[0]] ? k => kind(k) === TO_ROW[parts[0]] : k => kind(k) === kind(had);
        const i = before.indexOf(had), same = before.map((k, j) => [k, j]).filter(([k]) => CALM_KINDS.has(kind(k)) || k.startsWith("card:")).filter(([k]) => sameKind(k) && k !== had);
        const order = [...same.filter(([, j]) => j > i), ...same.filter(([, j]) => j < i).reverse()];
        const hit = order.find(([k]) => marks.get(k));
        toKey = hit ? hit[0] : "heading"; to = hit ? marks.get(hit[0]) : marks.get("heading");
      }
      to?.focus?.();
      if (to && toKey !== had) announce(fellBackText(had, toKey, before));
    },
  };
}

const kids = el => [...(el.children ?? [])];
const walk = root => { const out = []; const visit = e => { for (const c of kids(e)) { out.push(c); visit(c); } }; visit(root); return out; };
const keyOf = el => el.getAttribute?.("data-fk") ?? null;
/**
 * Where focus goes when its control's key is gone (the row was deleted, a toggle's control left): only to a NEUTRAL control, never to the same
 * action on another row (a delete, edit, lock, visibility or reaction on a neighbour would be one Enter from acting on something the person
 * did not choose). `row` is a row's own focusable (tabindex -1) element. Rows keyed `thread:<id>` and `frame:<id>` are themselves neutral.
 * Order: the same row's neutral key, the next row's, the previous row's, then the root's "heading".
 */
const NEUTRAL = [
  { from: /^(note):([^:]+):[a-z]+$/, to: m => `${m[1]}:${m[2]}:row`, rows: /^note:([^:]+):row$/ },
  { from: /^(layer):([^:]+):[a-z]+$/, to: m => `${m[1]}:${m[2]}:row`, rows: /^layer:([^:]+):row$/ },
  { from: /^(thread|frame):([^:]+)$/, to: m => `${m[1]}:${m[2]}`, rows: /^(?:thread|frame):[^:]+$/ },
];
const neutralFor = key => { for (const n of NEUTRAL) { const m = n.from.exec(key); if (m) return { same: n.to(m), rows: n.rows }; } return null; };
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
    const nb = neutralFor(held.key);
    if (nb) {
      const i = held.order.indexOf(held.key), rows = held.order.map((k, j) => [k, j]).filter(([k]) => nb.rows.test(k) && k !== held.key);
      to = [byKey(nb.same), ...[...rows.filter(([, j]) => j > i), ...rows.filter(([, j]) => j < i).reverse()].map(([k]) => byKey(k))].find(Boolean);
    }
    to ??= byKey("heading");
  }
  to?.focus?.();
  const toKey = to ? keyOf(to) : null;
  if (to && toKey !== held.key) announce(fellBackText(held.key, toKey, held.order));
  return !!to;
}
