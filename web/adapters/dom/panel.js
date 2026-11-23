// @ts-check
// The side panel: core's SECTIONS (panel.js) in stack or tabs mode through applyPanel, styled as the mock.
// The model (what's on, what's available) is pure and tested; render() builds DOM with ./dom.js.
// Every write goes through session.act(stream, fn): the role and connection gate it, not the disabled look.

import { STROKES, FILLS, WIDTHS, STYLES } from "../../../packages/core/editor.js";
import { panelSections, applyPanel } from "../../../packages/core/panel.js";
import { getPreset, EASING_META, canonicalEasing, presetsByCategory, timelineSpans, formatTime } from "../../../packages/core/anim.js";
import { FONT_FAMILY, fontClass } from "../../../packages/core/style.js";
import { isShape, isLabel, layerOf } from "../../../packages/core/model.js";
import { listNamedFrames } from "../../../packages/core/views.js";
import { parseLibrary, mergeLibrary } from "../../../packages/core/library.js";
import { BLEND_MODES, CLIP_SHAPES, effectsOf, normalizeEffects } from "../../../packages/core/effects.js";
import { buildIconLibraryItems, getIconPack } from "../../../packages/core/icon-packs.js";
import { icon } from "./icons.js";
import { createColorPicker } from "./color-picker.js";
import { isPhoneTouchViewport } from "./settings-dialog.js";

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
  const fx = effectsOf(e);
  return {
    count: sel.length,
    strokeColor: v("strokeColor"), backgroundColor: v("backgroundColor"), strokeWidth: v("strokeWidth"), strokeStyle: v("strokeStyle"),
    roughness: v("roughness"), opacity: v("opacity"), fillStyle: v("fillStyle"), round: !!v("roundness"),
    font: fontClass(txt?.fontFamily ?? st.fontFamily), fontSize: txt?.fontSize ?? st.fontSize,
    arrowType: arrow ? (arrow.elbowed ? "elbow" : arrow.roundness ? "curve" : "sharp") : st.elbowed ? "elbow" : st.roundness ? "curve" : "sharp",
    heads: arrow ? [arrow.startArrowhead ?? null, arrow.endArrowhead ?? null] : [null, "arrow"],
    blendMode: fx.blendMode,
    clipShape: fx.clipShape,
  };
}

/** Sections with something to say (core's panelSections `available`). */
export function availableFor(session) {
  const b = session.eds.board;
  return id => {
    if (id === "arrange") return b.sel.size > 0 || session.eds.notes.sel.size > 0;
    if (id === "frames") return listNamedFrames(b.doc).length > 0;
    return true;
  };
}

/**
 * The style patches each Properties control sends (core setStyle).
 * @type {[string, string, string, [string, any][]][]}
 */
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
/** The per-browser library from the storage port (web/ports/storage.js); a missing, junk or unavailable store reads as empty. */
export function loadLibrary(store) { try { return parseLibrary(store?.get(LIB_KEY) ?? ""); } catch { return []; } }
/** Save the library; a full or unavailable store (STORAGE_UNAVAILABLE) is survived: the library stays in memory. */
export function saveLibrary(store, items) { try { store?.set(LIB_KEY, JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: items })); } catch {} }
export function addToLibrary(items, incoming) { return mergeLibrary(items, incoming); }

/**
 * Build deterministic-ID icon pack items so repeated installs never duplicate existing icons.
 * @param {string} packId
 * @param {number} [now]
 */
export function iconPackLibraryItems(packId, now) {
  const pack = getIconPack(packId);
  if (!pack) return [];
  const raw = buildIconLibraryItems(pack.id, now != null ? { now } : undefined) ?? [];
  return raw.map((item, idx) => ({
    ...item,
    id: `icon-pack:${pack.id}:${pack.icons[idx]?.id ?? idx}`,
  }));
}

/** Return true if every icon in `packId` is already present in `items`. */
export function isIconPackInstalled(items, packId) {
  const pack = getIconPack(packId);
  if (!pack || !Array.isArray(items) || !items.length) return false;
  const ids = new Set(items.map(it => it?.id));
  return pack.icons.every(ic => ids.has(`icon-pack:${pack.id}:${ic.id}`));
}

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
  const touchSheet = Boolean(ctx.inSheet || isPhoneTouchViewport(ctx.win ?? globalThis));
  const touchBtnStyle = touchSheet ? { minHeight: "44px", minWidth: "44px", maxWidth: "100%" } : undefined;
  const touchSelectStyle = touchSheet ? { minHeight: "44px", fontSize: "16px", maxWidth: "100%", minWidth: "0", flex: "1 1 140px" } : undefined;
  // `fk` is the control's focus key (web/adapters/dom/focus.js): made of what it changes, never of what it says, so a redraw restores focus to the SAME control.
  const chip = (txt, on, onclick, title, view = false, fk = null) => {
    const iconOnly = typeof txt !== "string" && !Array.isArray(txt);
    return h("button.c" + (on ? ".on" : ""), { type: "button", title, ...(iconOnly && title ? { "aria-label": title } : {}), disabled: !view && dis, "data-fk": fk, onclick: () => onclick?.() }, txt);
  };
  const act = fn => S.act(stream, fn);
  const style = patch => act(e => e.setStyle(patch));
  const row = (lab, key, ...opts) => h("div.row", touchSheet ? { style: { minWidth: "0", maxWidth: "100%" } } : {}, h("span.lab", {}, lab, key ? h("i", {}, key) : null), h("span.opts", touchSheet ? { style: { minWidth: "0", maxWidth: "100%" } } : {}, ...opts));

  function properties() {
    const out = [];
    for (const [lab, key, prop, opts] of STYLE_ROWS) {
      if (notesOnly && !NOTE_ROWS.has(prop)) continue;
      const isColor = prop === "strokeColor" || prop === "backgroundColor";
      const ctrls = opts.map(([t, val]) => {
        if (isColor) {
          const on = m[prop] === val;
          return h("button.sw" + (val === "transparent" ? ".none" : "") + (on ? ".on" : ""), { title: val === "transparent" ? "No fill" : val, "aria-label": val, disabled: dis, "data-fk": `chip:${prop}:${val}`, style: val === "transparent" ? {} : { background: val }, onclick: () => style({ [prop]: val }) });
        }
        return chip(t, isOn(m, prop, val), () => style({ [prop]: val }), `${prop} ${JSON.stringify(val)}`, false, `chip:${prop}:${JSON.stringify(val)}`);
      });
      if (isColor) {
        const pickerOpen = ctx.colorPicker === prop;
        const customBtn = h("button.sw.sw-custom" + (pickerOpen ? ".on" : ""), {
          type: "button",
          title: `Custom ${lab.toLowerCase()} color`,
          "aria-label": `Custom ${lab.toLowerCase()} color`,
          "aria-expanded": String(pickerOpen),
          "data-custom-color": prop,
          disabled: dis,
          onclick: () => ctx.setColorPicker?.(pickerOpen ? null : prop),
        }, icon("palette", { size: 13 }));
        ctrls.push(customBtn);
      }
      out.push(row(lab, key, ctrls));
      if (isColor && ctx.colorPicker === prop) {
        out.push(createColorPicker({
          value: m[prop] && m[prop] !== "transparent" ? m[prop] : "#3b48e8",
          disabled: dis,
          prefs: ctx.prefs ?? null,
          canvas: ctx.canvas ?? null,
          pickerState: ctx.colorPickerState ?? null,
          onChange: hex => style({ [prop]: hex }),
          onClose: () => ctx.setColorPicker?.(null),
          h,
        }));
      }
    }
    if (!notesOnly) {
      if (m.count >= 1) {
        const applyEffects = patch => act(e => {
          const els = e.selected().filter(x => !isLabel(x) && e.doc.editable(x));
          if (!els.length) return;
          e.transact(tx => {
            for (const el of els) {
              const cur = tx.get(el.id);
              if (!cur) continue;
              const next = normalizeEffects({ ...effectsOf(cur), ...patch });
              cur.customData = { ...(cur.customData ?? {}), effects: next };
            }
            return true;
          });
        });
        const blendSel = h("select.field.anim-sel", {
          "aria-label": "Blend mode",
          "data-effect": "blendMode",
          "data-fk": "effects:blendMode",
          disabled: dis,
          value: m.blendMode,
          style: touchSelectStyle,
          onchange: e => applyEffects({ blendMode: e.currentTarget.value }),
          onkeydown: k => k.stopPropagation(),
        }, BLEND_MODES.map(mode => h("option", { value: mode, selected: m.blendMode === mode }, mode)));
        const clipSel = h("select.field.anim-sel", {
          "aria-label": "Mask / Clip",
          "data-effect": "clipShape",
          "data-fk": "effects:clipShape",
          disabled: dis,
          value: m.clipShape,
          style: touchSelectStyle,
          onchange: e => applyEffects({ clipShape: e.currentTarget.value }),
          onkeydown: k => k.stopPropagation(),
        }, CLIP_SHAPES.map(shape => h("option", { value: shape, selected: m.clipShape === shape }, shape)));
        out.push(
          h("div.effects-sec", { "data-effects": "1" },
            h("div.hint", { style: { margin: "8px 0 4px" } }, "Effects"),
            row("Blend", "", blendSel),
            row("Mask", "", clipSel)),
        );
      }
      out.push(h("div.hint", { style: { margin: "8px 0 4px" } }, "With an arrow selected (or the Arrow tool):"));
      out.push(row("Arrow", "", chip("sharp", m.arrowType === "sharp", () => style({ elbowed: false, roundness: null })), chip("curve", m.arrowType === "curve", () => style({ elbowed: false, roundness: { type: 2 } })), chip("elbow", m.arrowType === "elbow", () => style({ elbowed: true }), "elbowed: routed around shapes")));
      out.push(row("Heads", "", HEADS.map(([t, s0, e0]) => chip(t, m.heads[0] === s0 && m.heads[1] === e0, () => style({ startArrowhead: s0, endArrowhead: e0 })))));
      out.push(row("Bends", "", chip("+ bend", false, () => act(e => e.addBend())), chip("straighten", false, () => act(e => e.straighten()))));
    }
    return out;
  }
  const B = S.eds.board;
  const bodies = {
    properties,
    arrange: () => {
      const rows = [];
      if (m.count >= 2) {
        rows.push(
          row("Align", "", [["Left", "left"], ["Center X", "hcenter"], ["Right", "right"], ["Top", "top"], ["Center Y", "vcenter"], ["Bottom", "bottom"]].map(([t, w]) =>
            h("button.c", {
              type: "button",
              title: `Align ${t}`,
              "aria-label": `Align ${t}`,
              "data-align": w,
              "data-fk": `arrange:align:${w}`,
              disabled: dis,
              style: touchBtnStyle,
              onclick: () => act(e => e.alignSelection(w)),
            }, t))),
        );
        if (m.count >= 3) {
          rows.push(
            row("Distribute", "",
              h("button.c", {
                type: "button",
                title: "Distribute horizontally",
                "aria-label": "Distribute horizontally",
                "data-distribute": "h",
                "data-fk": "arrange:dist:h",
                disabled: dis,
                style: touchBtnStyle,
                onclick: () => act(e => e.distributeSelection("h")),
              }, "Horizontal"),
              h("button.c", {
                type: "button",
                title: "Distribute vertically",
                "aria-label": "Distribute vertically",
                "data-distribute": "v",
                "data-fk": "arrange:dist:v",
                disabled: dis,
                style: touchBtnStyle,
                onclick: () => act(e => e.distributeSelection("v")),
              }, "Vertical")),
          );
        }
        rows.push(
          row("Layout", "",
            h("button.c", {
              type: "button",
              title: "Tidy selection into neat row, column, or grid",
              "aria-label": "Tidy selection",
              "data-action": "tidy",
              "data-fk": "arrange:tidy",
              disabled: dis,
              style: touchBtnStyle,
              onclick: () => act(e => e.tidySelection()),
            }, "Tidy")),
        );
      }
      rows.push(
        h("div.row", {}, h("span.opts", {},
          [["Front", "front"], ["Forward", "forward"], ["Backward", "backward"], ["Back", "back"]].map(([t, w]) => chip(t, false, () => act(e => e.reorder(w)), w)))),
        h("div.row", {}, h("span.opts", {}, chip("group", false, () => act(e => e.group()), "Group (⌘G)"), chip("ungroup", false, () => act(e => e.ungroup()), "Ungroup (⌘⇧G)"), chip("dup", false, () => act(e => e.cloneSelection(20, 20)), "Duplicate (⌘D)"), chip("lock", false, () => act(e => e.toggleLock()), "Lock (⌘⇧L)"))),
        h("div.row", {}, h("span.opts", {}, chip("-15°", false, () => act(e => e.rotateBy(-15)), "Rotate -15°"), chip("+15°", false, () => act(e => e.rotateBy(15)), "Rotate +15°"), chip("+90°", false, () => act(e => e.rotateBy(90)), "Rotate +90°"), chip("0°", false, () => act(e => e.resetRotation()), "Reset rotation"))),
      );
      return rows;
    },
    frames: () => {
      const fs = listNamedFrames(B.doc);
      const goFrame = id => { if (ctx.onJumpFrame) ctx.onJumpFrame(id); else S.goToFrame(id); ctx.onChange(); };
      const stepFrame = d => { if (ctx.onStepFrame) ctx.onStepFrame(d); else S.stepFrame(d); };
      return [
        ...fs.map((f, i) => h("button.list-row" + (B.frameAt === f.id ? ".on" : ""), { "data-fk": `frame:${f.id}`, onclick: () => goFrame(f.id) }, h("span.dim", {}, String(i + 1)), " ", f.rawName || `Frame ${i + 1}`)),
        h("div.row", { style: { marginTop: "6px" } }, h("span.opts", {}, chip([icon("chevronLeft", { size: 14 }), " prev"], false, () => stepFrame(-1), "PgUp", true), chip(["next ", icon("chevronRight", { size: 14 })], false, () => stepFrame(1), "PgDn", true), chip("all", false, () => S.fit(), "Fit everything (⇧1)", true))),
      ];
    },
    animate: () => {
      const selEl = B.selected().filter(e => !isLabel(e))[0];
      const anim = selEl?.customData?.anim ?? null;
      const cur = anim?.preset ?? null;
      const curMeta = cur ? getPreset(cur) : null;
      const curEasing = canonicalEasing(anim?.easing ?? curMeta?.easing ?? "ease-out");
      const curStart = anim?.start ?? 0;
      const curDur = anim?.duration ?? curMeta?.duration ?? 600;
      const curLoop = anim ? (anim.loop ?? curMeta?.loop ?? false) : false;
      const groups = presetsByCategory();
      const spans = timelineSpans(B.doc.live());

      const out = [
        ...groups.map(g => h("div.anim-group", { "data-category": g.id },
          h("div.anim-cat", {}, g.label),
          h("span.opts", {}, g.presets.map(p => chip(p.id, cur === p.id, () => S.act("board", e => e.animate(p.id)), `${g.label}: ${p.label} (${p.duration} ms, ${p.easing})`))))),
        h("div.row", { style: { marginTop: "4px" } }, h("span.opts", {},
          chip("none", !cur && !!selEl, () => S.act("board", e => e.clearAnimation()), "Clear animation"))),
      ];

      if (anim && !anim.keys) {
        const easingSel = h("select.anim-sel", {
          "aria-label": "Easing curve",
          disabled: dis,
          value: curEasing,
          onchange: e => S.act("board", ed => ed.updateAnimation({ easing: e.currentTarget.value })),
        }, EASING_META.map(ea => h("option", { value: ea.id, selected: curEasing === ea.id }, ea.label)));

        const numField = (label, val, step, min, prop) => h("label.anim-num", {},
          h("span", {}, label),
          h("input", {
            type: "number",
            min: String(min),
            step: String(step),
            value: String(val),
            disabled: dis,
            onchange: e => S.act("board", ed => ed.updateAnimation({ [prop]: Number(e.currentTarget.value) })),
            onkeydown: k => k.stopPropagation(),
          }));

        out.push(
          row("Easing", "", easingSel),
          h("div.anim-fields", {},
            numField("Delay ms", curStart, 50, 0, "start"),
            numField("Dur ms", curDur, 50, 50, "duration")),
          row("Repeat", "", chip(curLoop ? "Loop on" : "Loop off", curLoop, () => S.act("board", ed => ed.updateAnimation({ loop: !curLoop })), "Toggle per-element loop")),
        );
      }

      out.push(
        h("div.row", { style: { marginTop: "6px" } }, h("span.opts", {},
          chip([icon(B.play ? "pause" : "play", { size: 14 }), B.play ? " pause" : " play"], !!B.play, () => { B.playToggle(); ctx.onChange(); }, "⇧Space", true),
          chip([icon("skipBack", { size: 13 }), " restart"], false, () => { B.restartPlay(); ctx.onChange(); }, "Restart playback", true),
          chip([icon("stop", { size: 13 }), " stop"], false, () => { B.stopPlay(); ctx.onChange(); }, "Stop (Esc)", true))),
      );

      if (spans.length) {
        out.push(h("div.anim-steps", {},
          spans.slice(0, 20).map((sp, i) => h("button.list-row" + (B.sel.has(sp.id) ? ".on" : ""), {
            onclick: () => { B.select([sp.id]); B.seekTo(sp.start); ctx.onChange(); },
          }, h("span.dim", {}, String(i + 1)), " ", sp.label, h("span.n", {}, formatTime(sp.start))))));
      } else {
        out.push(h("div.hint", {}, "Select shapes, pick an effect: they join the timeline in order (start + 150 ms stagger)."));
      }
      return out;
    },
    layers: () => {
      const ls = [...B.doc.layers].reverse(), count = id => B.doc.live().filter(e => layerOf(e) === id && !isLabel(e)).length;
      const lact = fn => S.act("board", fn, { settings: true });
      const localView = ctx.localView ?? null;
      const localById = localView?.layers ? new Map(localView.layers.map(l => [l.id, l])) : null;
      const soloLayer = localView?.soloLayerId ? B.doc.layers.find(l => l.id === localView.soloLayerId) : null;
      const resetBanner = localView?.active
        ? h("div.local-layer-banner", { role: "status" },
          h("span.local-layer-label", {},
            localView.mode === "solo"
              ? `Solo: ${soloLayer?.name || "Layer"}`
              : `View: ${localView.activeViewName || "Filtered"}`),
          h("button.c.on", {
            type: "button",
            title: "Clear local layer filter and show board layers",
            "aria-label": "Show all layers",
            "data-action": "reset-local-layers",
            "data-fk": "layers:reset-local",
            style: touchBtnStyle,
            onclick: () => ctx.onResetLocalView?.(),
          }, "Show all layers"))
        : null;
      return [
        resetBanner,
        h("div", { role: "list", "aria-label": "Layers" }, ls.map(l => {
          const eff = localById?.get(l.id);
          const isSolo = Boolean(eff?.solo);
          const locallyHidden = Boolean(localView?.active && eff && !eff.effectiveVisible);
          return h("div.list-row" + (B.activeLayer === l.id ? ".on" : "") + (locallyHidden ? ".local-hidden" : ""), { role: "listitem", "aria-label": `Layer: ${l.name || "Layer"}`, "data-fk": `layer:${l.id}:row`, tabindex: "-1", onclick: () => { B.activeLayer = l.id; B.changed(); ctx.onChange(); } },
            h("button.tb", { title: l.visible ? "Hide" : "Show", "aria-label": l.visible ? "Hide layer" : "Show layer", disabled: dis, "data-fk": `layer:${l.id}:visible`, onclick: ev => { ev.stopPropagation(); lact(e => e.updateLayer(l.id, { visible: !l.visible })); } }, icon(l.visible ? "eye" : "eyeOff", { size: 14 })),
            h("button.tb", { title: l.locked ? "Unlock" : "Lock", "aria-label": l.locked ? "Unlock layer" : "Lock layer", disabled: dis, "data-fk": `layer:${l.id}:lock`, onclick: ev => { ev.stopPropagation(); lact(e => e.updateLayer(l.id, { locked: !l.locked })); } }, icon(l.locked ? "lock" : "unlock", { size: 14 })),
            h("button.tb.solo-btn" + (isSolo ? ".on" : ""), { type: "button", title: isSolo ? "Exit solo layer (local)" : "Solo layer (local only)", "aria-label": isSolo ? `Exit solo for ${l.name || "Layer"}` : `Solo ${l.name || "Layer"}`, "aria-pressed": String(isSolo), "data-fk": `layer:${l.id}:solo`, "data-solo-layer": l.id, onclick: ev => { ev.stopPropagation(); ctx.onSoloLayer?.(l.id); } }, "S"),
            h("span", { title: "Double-click to rename", ondblclick: ev => {
              ev.stopPropagation(); if (dis) return;
              const input = h("input.rename", { value: l.name ?? "", maxLength: 80, onkeydown: k => { k.stopPropagation(); if (k.key === "Enter") input.blur(); if (k.key === "Escape") { input.value = l.name ?? ""; input.blur(); } },
                onblur: () => { const n = input.value.trim(); if (n && n !== l.name) lact(e => e.updateLayer(l.id, { name: n })); ctx.onChange(); } });
              ev.currentTarget.replaceWith(input); input.focus(); input.select();
            } }, l.name || "Layer"),
            h("span.n", {}, String(count(l.id))));
        })),
        h("div.row", { style: { marginTop: "6px" } }, h("span.opts", {},
          chip(icon("plus", { size: 14 }), false, () => lact(e => e.addLayer()), "New layer"),
          chip(icon("arrowUp", { size: 14 }), false, () => lact(e => e.moveLayer(B.activeLayer, 1)), "Move up"),
          chip(icon("arrowDown", { size: 14 }), false, () => lact(e => e.moveLayer(B.activeLayer, -1)), "Move down"),
          chip(icon("moveToLayer", { size: 14 }), false, () => S.act("board", e => e.moveToLayer(B.activeLayer)), "Move the selection to this layer"),
          chip(icon("trash", { size: 14 }), false, () => lact(e => e.deleteLayer(B.activeLayer)), "Delete layer (its shapes move down)"))),
      ];
    },
    library: () => {
      const items = ctx.library ?? [];
      const k8sInstalled = isIconPackInstalled(items, "kubernetes");
      const cloudInstalled = isIconPackInstalled(items, "cloud");
      const installPack = packId => {
        const packItems = iconPackLibraryItems(packId, ctx.clock?.now());
        if (!packItems.length) return;
        const next = addToLibrary(items, packItems);
        if (next.length !== items.length) ctx.setLibrary(next);
      };
      return [
        h("div.lib", {}, items.map((it, i) => h("button.item", { title: `Insert ${it.name ?? "item"}`, disabled: dis, "data-fk": `lib:${it.id ?? i}`, onclick: () => S.act("board", e => e.insertLibraryItem(it)) }, h("b", {}, String(it.elements.filter(e => !isLabel(e)).length)), h("span", {}, it.name ?? "item")))),
        h("div.row", { style: touchSheet ? { marginTop: "8px", minWidth: "0", maxWidth: "100%" } : { marginTop: "8px" } }, h("span.opts", touchSheet ? { style: { minWidth: "0", maxWidth: "100%" } } : {},
          chip("+ save selection", false, () => { const it = B.libraryItem(); if (it) ctx.setLibrary(addToLibrary(items, [it])); }, "libraryItem(name)"),
          h("button.c" + (k8sInstalled ? ".on" : ""), {
            type: "button",
            title: k8sInstalled ? "Kubernetes pack installed" : "Install Kubernetes vector icon pack",
            "aria-label": "Install Kubernetes pack",
            "data-icon-pack": "kubernetes",
            "data-fk": "lib:pack:kubernetes",
            style: touchBtnStyle,
            onclick: () => installPack("kubernetes"),
          }, "＋ Kubernetes pack"),
          h("button.c" + (cloudInstalled ? ".on" : ""), {
            type: "button",
            title: cloudInstalled ? "Cloud pack installed" : "Install Cloud & Architecture vector icon pack",
            "aria-label": "Install Cloud pack",
            "data-icon-pack": "cloud",
            "data-fk": "lib:pack:cloud",
            style: touchBtnStyle,
            onclick: () => installPack("cloud"),
          }, "＋ Cloud pack"))),
        h("div.hint", {}, items.length ? "Click an item to insert it. Drop a .excalidrawlib to add." : "Empty. Select shapes and save them, install an icon pack, or drop a .excalidrawlib."),
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
  const sub = { properties: m.count ? `· ${m.count} selected` : "· next shape", frames: `· ${listNamedFrames(B.doc).length}`, library: `· ${(ctx.library ?? []).length}` };
  const out = [];
  if (!ctx.inSheet) out.push(h("div.panel-head", {},
    h("button.tb" + (state.mode === "stack" ? ".on" : ""), { title: "Stack", "aria-label": "Stack layout", "aria-pressed": String(state.mode === "stack"), onclick: () => ctx.setState({ type: "mode", mode: "stack" }) }, icon("stack", { size: 15 })),
    h("button.tb" + (state.mode === "tabs" ? ".on" : ""), { title: "Tabs", "aria-label": "Tabs layout", "aria-pressed": String(state.mode === "tabs"), onclick: () => ctx.setState({ type: "mode", mode: "tabs" }) }, icon("tabs", { size: 15 })),
    h("button.tb", { title: "Fold all / unfold all", "aria-label": "Fold or unfold all", onclick: () => ctx.setState({ type: "foldAll", folded: state.folded.length < 6 }) }, icon("fold", { size: 15 })),
    h("button.tb", { title: "Reset the panel layout", "aria-label": "Reset panel layout", onclick: () => ctx.setState({ type: "reset" }) }, icon("settings", { size: 15 }))));
  if (tabs) out.push(h("div.tabs", { role: "tablist", "aria-label": "Inspector sections" }, secs.map(s => h("button" + (s.active ? ".on" : ""), {
    type: "button",
    role: "tab",
    "aria-selected": String(Boolean(s.active)),
    "aria-label": s.title,
    "data-fk": `panel-tab:${s.id}`,
    style: touchBtnStyle,
    onclick: () => ctx.setState({ type: "tab", id: s.id }),
  }, s.title))));
  for (const s of secs) {
    if (!s.active) continue;
    out.push(h("div.sec" + (s.folded ? ".folded" : ""), { "data-sec": s.id },
      h("h4", { onclick: () => !tabs && ctx.setState({ type: "fold", id: s.id }) }, s.title, sub[s.id] ? h("span", {}, sub[s.id]) : null),
      s.folded ? null : bodies[s.id]()));
  }
  return out;
}

export { applyPanel };
