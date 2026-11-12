// The side panel: core's SECTIONS (panel.js) in stack or tabs mode through applyPanel, styled as the mock.
// The model (what's on, what's available) is pure and tested; render() builds DOM with ./dom.js.
// Every write goes through session.act(stream, fn): the role and connection gate it, not the disabled look.

import { STROKES, FILLS, WIDTHS, STYLES } from "../../packages/core/editor.js";
import { panelSections, applyPanel } from "../../packages/core/panel.js";
import { PRESET_NAMES } from "../../packages/core/anim.js";
import { FONT_FAMILY, fontClass } from "../../packages/core/style.js";
import { isShape, isLabel, layerOf } from "../../packages/core/model.js";
import { parseLibrary, mergeLibrary } from "../../packages/core/library.js";

export const HEADS = [["none", null, null], ["→", null, "arrow"], ["↔", "arrow", "arrow"], ["▶", null, "triangle"], ["▷", null, "triangle_outline"], ["●", null, "dot"], ["◆", null, "diamond"], ["⊣", null, "bar"]];
export const OPACITIES = [100, 75, 50, 25];
export const SIZES = [16, 20, 28, 36];

/** What the Properties section shows as on: the first selected element's values, else the next-shape style. */
export function propsModel(ed) {
  const sel = ed.selected().filter(e => !isLabel(e)), e = sel[0], st = ed.style;
  const label = e && isShape(e) ? ed.doc.labelOf(e) : null;
  const txt = e?.type === "text" ? e : label;
  const v = k => (e && e[k] !== undefined ? e[k] : st[k]);
  const arrow = sel.find(x => x.type === "arrow" || x.type === "line");
  return {
    count: sel.length,
    strokeColor: v("strokeColor"), backgroundColor: v("backgroundColor"), strokeWidth: v("strokeWidth"), strokeStyle: v("strokeStyle"),
    roughness: v("roughness"), opacity: v("opacity"), fillStyle: v("fillStyle"), round: !!v("roundness"),
    font: fontClass(txt?.fontFamily ?? st.fontFamily), fontSize: txt?.fontSize ?? st.fontSize,
    arrowType: arrow ? (arrow.elbowed ? "elbow" : arrow.roundness ? "curve" : "sharp") : st.elbowed ? "elbow" : st.roundness ? "curve" : "sharp",
    heads: arrow ? [arrow.startArrowhead ?? null, arrow.endArrowhead ?? null] : [null, "arrow"],
  };
}

/** Sections with something to say (core's panelSections `available`). */
export function availableFor(session) {
  const b = session.eds.board;
  return id => {
    if (id === "arrange") return b.sel.size > 0 || session.eds.notes.sel.size > 0;
    if (id === "frames") return b.frames().length > 0;
    return true;
  };
}

/** The style patches each Properties control sends (core setStyle). */
export const STYLE_ROWS = [
  ["Stroke", "C", "strokeColor", STROKES.map(c => [c, c])],
  ["Fill", "B", "backgroundColor", FILLS.map(c => [c, c])],
  ["Width", "W", "strokeWidth", WIDTHS.map((w, i) => [["thin", "bold", "extra"][i], w])],
  ["Style", "S", "strokeStyle", STYLES.map((s, i) => [["—", "- -", "···"][i], s])],
  ["Sketch", "G", "roughness", [["clean", 0], ["sketch", 1], ["loose", 2]]],
  ["Opacity", "", "opacity", OPACITIES.map(o => [String(o), o])],
  ["Pattern", "", "fillStyle", [["solid", "solid"], ["////", "hachure"], ["xxxx", "cross-hatch"]]],
  ["Edges", "", "roundness", [["sharp", null], ["round", { type: 3 }]]],
  ["Font", "", "fontFamily", Object.entries(FONT_FAMILY).map(([k, v]) => [k, v])],
  ["Text", "= -", "fontSize", SIZES.map(s => [String(s), s])],
];
const NOTE_ROWS = new Set(["strokeColor", "backgroundColor", "strokeWidth", "strokeStyle", "opacity", "fontFamily", "fontSize"]);
const isOn = (m, key, val) => {
  if (key === "roundness") return m.round === !!val;
  if (key === "fontFamily") return m.font === fontClass(val);
  return m[key] === val;
};

// ── library (per browser, localStorage; .excalidrawlib in and out) ──
const LIB_KEY = "plenary.library";
export function loadLibrary(store) { try { return parseLibrary(store?.getItem(LIB_KEY) ?? "") ; } catch { return []; } }
export function saveLibrary(store, items) { try { store?.setItem(LIB_KEY, JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: items })); } catch {} }
export function addToLibrary(items, incoming) { return mergeLibrary(items, incoming); }

/**
 * Build the panel into `root`. ctx: { session, state, setState(op), h, inSheet, library, setLibrary, onChange }.
 */
export function renderPanel(root, ctx) {
  const { session: S, state, h } = ctx;
  const may = S.may(), role = S.role;
  const notesOnly = role === "annotator";
  const stream = notesOnly ? "notes" : S.active;
  const ed = S.eds[stream];
  const m = propsModel(ed);
  const dis = !may;
  const chip = (txt, on, onclick, title, view = false) => h("button.c" + (on ? ".on" : ""), { title, disabled: !view && dis, onclick: () => onclick?.() }, txt);
  const act = fn => S.act(stream, fn);
  const style = patch => act(e => e.setStyle(patch));
  const row = (lab, key, ...opts) => h("div.row", {}, h("span.lab", {}, lab, key ? h("i", {}, key) : null), h("span.opts", {}, ...opts));

  function properties() {
    const out = [];
    for (const [lab, key, prop, opts] of STYLE_ROWS) {
      if (notesOnly && !NOTE_ROWS.has(prop)) continue;
      const ctrls = opts.map(([t, val]) => {
        if (prop === "strokeColor" || prop === "backgroundColor") {
          const on = m[prop] === val;
          return h("button.sw" + (val === "transparent" ? ".none" : "") + (on ? ".on" : ""), { title: val === "transparent" ? "No fill" : val, "aria-label": val, disabled: dis, style: val === "transparent" ? {} : { background: val }, onclick: () => style({ [prop]: val }) });
        }
        return chip(t, isOn(m, prop, val), () => style({ [prop]: val }), `${prop} ${JSON.stringify(val)}`);
      });
      out.push(row(lab, key, ctrls));
    }
    if (!notesOnly) {
      out.push(h("div.hint", { style: { margin: "8px 0 4px" } }, "With an arrow selected (or the Arrow tool):"));
      out.push(row("Arrow", "", chip("╱ sharp", m.arrowType === "sharp", () => style({ elbowed: false, roundness: null })), chip("◠ curve", m.arrowType === "curve", () => style({ elbowed: false, roundness: { type: 2 } })), chip("┐ elbow", m.arrowType === "elbow", () => style({ elbowed: true }), "elbowed: routed around shapes")));
      out.push(row("Heads", "", HEADS.map(([t, s0, e0]) => chip(t, m.heads[0] === s0 && m.heads[1] === e0, () => style({ startArrowhead: s0, endArrowhead: e0 })))));
      out.push(row("Bends", "", chip("+ bend", false, () => act(e => e.addBend())), chip("straighten", false, () => act(e => e.straighten()))));
    }
    return out;
  }
  const B = S.eds.board;
  const bodies = {
    properties,
    arrange: () => [
      h("div.row", {}, h("span.opts", {}, [["⇤ ⌥A", "left"], ["⇥ ⌥D", "right"], ["⤒ ⌥W", "top"], ["⤓ ⌥S", "bottom"], ["↔ ⌥H", "hcenter"], ["↕ ⌥V", "vcenter"]].map(([t, w]) => chip(t, false, () => act(e => e.align(w)), `align ${w}`)))),
      h("div.row", {}, h("span.opts", {}, chip("⇹ ⇧H", false, () => act(e => e.distribute("h"))), chip("⇳ ⇧V", false, () => act(e => e.distribute("v"))),
        [["⤒ ⌘]", "front"], ["↑ ]", "forward"], ["↓ [", "backward"], ["⤓ ⌘[", "back"]].map(([t, w]) => chip(t, false, () => act(e => e.reorder(w)), w)))),
      h("div.row", {}, h("span.opts", {}, chip("group ⌘G", false, () => act(e => e.group())), chip("ungroup ⌘⇧G", false, () => act(e => e.ungroup())), chip("dup ⌘D", false, () => act(e => e.cloneSelection(20, 20))), chip("lock ⌘⇧L", false, () => act(e => e.toggleLock())))),
      h("div.row", {}, h("span.opts", {}, chip("⟲ 15° <", false, () => act(e => e.rotateBy(-15))), chip("⟳ 15° >", false, () => act(e => e.rotateBy(15))), chip("⟳ 90°", false, () => act(e => e.rotateBy(90))), chip("0°", false, () => act(e => e.resetRotation())))),
    ],
    frames: () => {
      const fs = B.frames();
      return [
        ...fs.map((f, i) => h("button.list-row" + (B.frameAt === f.id ? ".on" : ""), { onclick: () => { S.goToFrame(f.id); ctx.onChange(); } }, h("span.dim", {}, String(i + 1)), " ", f.name || `Frame ${i + 1}`)),
        h("div.row", { style: { marginTop: "6px" } }, h("span.opts", {}, chip("‹ prev", false, () => S.stepFrame(-1), "PgUp", true), chip("next ›", false, () => S.stepFrame(1), "PgDn", true), chip("all", false, () => S.fit(), "Fit everything (⇧1)", true))),
      ];
    },
    animate: () => {
      const cur = B.selected()[0]?.customData?.anim?.preset;
      return [
        h("div.row", {}, h("span.opts", {}, PRESET_NAMES.map(p => chip(p, cur === p, () => S.act("board", e => e.animate(p)))), chip("none", false, () => S.act("board", e => e.clearAnimation()), "clearAnimation"))),
        h("div.row", {}, h("span.opts", {}, chip(B.play ? "❚❚ pause" : "▶ play", !!B.play, () => { B.playToggle(); ctx.onChange(); }, "⇧Space", true))),
        h("div.hint", {}, "Select shapes, pick an effect: they join the timeline in order (start + 150 ms stagger)."),
      ];
    },
    layers: () => {
      const ls = [...B.doc.layers].reverse(), count = id => B.doc.live().filter(e => layerOf(e) === id && !isLabel(e)).length;
      const lact = fn => S.act("board", fn, { settings: true });
      return [
        ...ls.map(l => h("div.list-row" + (B.activeLayer === l.id ? ".on" : ""), { onclick: () => { B.activeLayer = l.id; B.changed(); ctx.onChange(); } },
          h("button", { title: l.visible ? "Hide" : "Show", disabled: dis, onclick: ev => { ev.stopPropagation(); lact(e => e.updateLayer(l.id, { visible: !l.visible })); } }, l.visible ? "◉" : "○"),
          h("button", { title: l.locked ? "Unlock" : "Lock", disabled: dis, onclick: ev => { ev.stopPropagation(); lact(e => e.updateLayer(l.id, { locked: !l.locked })); } }, l.locked ? "🔒" : "·"),
          h("span", { title: "Double-click to rename", ondblclick: ev => {
            ev.stopPropagation(); if (dis) return;
            const input = h("input.rename", { value: l.name ?? "", maxLength: 80, onkeydown: k => { k.stopPropagation(); if (k.key === "Enter") input.blur(); if (k.key === "Escape") { input.value = l.name ?? ""; input.blur(); } },
              onblur: () => { const n = input.value.trim(); if (n && n !== l.name) lact(e => e.updateLayer(l.id, { name: n })); ctx.onChange(); } });
            ev.currentTarget.replaceWith(input); input.focus(); input.select();
          } }, l.name || "Layer"),
          h("span.n", {}, String(count(l.id))))),
        h("div.row", { style: { marginTop: "6px" } }, h("span.opts", {},
          chip("+", false, () => lact(e => e.addLayer()), "New layer"),
          chip("↑", false, () => lact(e => e.moveLayer(B.activeLayer, 1)), "Move up"),
          chip("↓", false, () => lact(e => e.moveLayer(B.activeLayer, -1)), "Move down"),
          chip("⇢", false, () => S.act("board", e => e.moveToLayer(B.activeLayer)), "Move the selection to this layer"),
          chip("✕", false, () => lact(e => e.deleteLayer(B.activeLayer)), "Delete layer (its shapes move down)"))),
      ];
    },
    library: () => {
      const items = ctx.library ?? [];
      return [
        h("div.lib", {}, items.map(it => h("button.item", { title: `Insert ${it.name ?? "item"}`, disabled: dis, onclick: () => S.act("board", e => e.insertLibraryItem(it)) }, h("b", {}, String(it.elements.filter(e => !isLabel(e)).length)), h("span", {}, it.name ?? "item")))),
        h("div.row", { style: { marginTop: "8px" } }, h("span.opts", {}, chip("+ save selection", false, () => { const it = B.libraryItem(); if (it) ctx.setLibrary(addToLibrary(items, [it])); }, "libraryItem(name)"))),
        h("div.hint", {}, items.length ? "Click an item to insert it. Drop a .excalidrawlib to add." : "Empty. Select shapes and save them, or drop a .excalidrawlib."),
      ];
    },
  };

  if (notesOnly) {
    return [h("div.sec", {}, h("h4", {}, "Properties ", h("span", {}, "· your note")), properties(),
      h("div.hint", {}, "The board is the presenters'. You change only notes you made; others' notes are locked to you."))];
  }
  const tabs = state.mode === "tabs" || ctx.inSheet;
  const st = tabs ? { ...state, mode: "tabs" } : state;
  const secs = panelSections(st, availableFor(S));
  const sub = { properties: m.count ? `· ${m.count} selected` : "· next shape", frames: `· ${B.frames().length}`, library: `· ${(ctx.library ?? []).length}` };
  const out = [];
  if (!ctx.inSheet) out.push(h("div.panel-head", {},
    h("button.tb" + (state.mode === "stack" ? ".on" : ""), { title: "Stack", onclick: () => ctx.setState({ type: "mode", mode: "stack" }) }, "▤"),
    h("button.tb" + (state.mode === "tabs" ? ".on" : ""), { title: "Tabs", onclick: () => ctx.setState({ type: "mode", mode: "tabs" }) }, "▭"),
    h("button.tb", { title: "Fold all / unfold all", onclick: () => ctx.setState({ type: "foldAll", folded: state.folded.length < 6 }) }, "⊟"),
    h("button.tb", { title: "Reset the panel layout", onclick: () => ctx.setState({ type: "reset" }) }, "⚙")));
  if (tabs) out.push(h("div.tabs", {}, secs.map(s => h("button" + (s.active ? ".on" : ""), { onclick: () => ctx.setState({ type: "tab", id: s.id }) }, s.title))));
  for (const s of secs) {
    if (!s.active) continue;
    out.push(h("div.sec" + (s.folded ? ".folded" : ""), { "data-sec": s.id },
      h("h4", { onclick: () => !tabs && ctx.setState({ type: "fold", id: s.id }) }, s.title, sub[s.id] ? h("span", {}, sub[s.id]) : null),
      s.folded ? null : bodies[s.id]()));
  }
  return out;
}

export { applyPanel };
