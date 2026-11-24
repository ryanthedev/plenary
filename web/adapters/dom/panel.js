// @ts-check
/**
 * @module web/adapters/dom/panel
 * Inspector panel / ribbon DOM adapter rendering `packages/core/panel.js` (`panelSections`, `applyPanel`)
 * across desktop ribbon mode, vertical tool bars (Layers/Frames/Library), and the mobile bottom sheet.
 * Every write goes through `session.act(stream, fn)` so role and connection state—not visual disabling—gate edits.
 */

import { STROKES, FILLS, WIDTHS, STYLES } from "../../../packages/core/editor.js";
import { panelSections, applyPanel } from "../../../packages/core/panel.js";
import { PRESETS, getPreset, EASING_META, canonicalEasing, presetsByCategory } from "../../../packages/core/anim.js";
import { FONT_FAMILY, fontClass } from "../../../packages/core/style.js";
import { isShape, isLabel, layerOf } from "../../../packages/core/model.js";
import { listNamedFrames } from "../../../packages/core/views.js";
import { parseLibrary, mergeLibrary } from "../../../packages/core/library.js";
import { BLEND_MODES, CLIP_SHAPES, effectsOf, normalizeEffects } from "../../../packages/core/effects.js";
import { buildIconLibraryItems, getIconPack } from "../../../packages/core/icon-packs.js";
import { parseLinkCardFromElement } from "../../../packages/core/link-card.js";
import { parseEmbedFromElement } from "../../../packages/core/embed.js";
import {
  metaOf,
  normalizeShapeMeta,
  validateRunbookUrl,
  MAX_META_OWNER_LENGTH,
  MAX_META_SERVICE_LENGTH,
  MAX_RUNBOOK_URL_LENGTH,
} from "../../../packages/core/metadata.js";
import { icon } from "./icons.js";
import { createColorPicker } from "./color-picker.js";
import { isPhoneTouchViewport } from "./settings-dialog.js";
import { ALL_PROP_KEYS, contextualPropKeys } from "../../core/ribbon.js";

export const HEADS = [["none", null, null], ["→", null, "arrow"], ["↔", "arrow", "arrow"], ["▶", null, "triangle"], ["▷", null, "triangle_outline"], ["●", null, "dot"], ["◆", null, "diamond"], ["⊣", null, "bar"]];
export const OPACITIES = [100, 75, 50, 25];
export const SIZES = [16, 20, 28, 36];

/**
 * Compute what the Properties section shows as active: the first selected element's values, else the next-shape style.
 * @param {any} ed
 * @returns {{ count: number, strokeColor: any, backgroundColor: any, strokeWidth: any, strokeStyle: any, roughness: any, opacity: any, fillStyle: any, round: boolean, font: string, fontSize: number, arrowType: string, heads: [any, any], blendMode: string, clipShape: string }}
 */
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

/**
 * Build the section-availability predicate passed to `panelSections`.
 * @param {any} session
 * @param {"draw" | "animate" | "present" | null} [workspaceMode]
 * @returns {(id: string) => boolean}
 */
export function availableFor(session, workspaceMode = null) {
  const b = session.eds.board;
  return id => {
    if (id === "animate" && workspaceMode === "draw") return false;
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
/**
 * Read the per-browser library from the storage port (`web/ports/storage.js`); a missing, junk or unavailable store reads as empty.
 * @param {import("../../ports/storage.js").Storage | null | undefined} store
 * @returns {any[]}
 */
export function loadLibrary(store) { try { return parseLibrary(store?.get(LIB_KEY) ?? ""); } catch { return []; } }
/**
 * Save the library; a full or unavailable store (`STORAGE_UNAVAILABLE`) is survived so the library stays in memory.
 * @param {import("../../ports/storage.js").Storage | null | undefined} store
 * @param {any[]} items
 */
export function saveLibrary(store, items) { try { store?.set(LIB_KEY, JSON.stringify({ type: "excalidrawlib", version: 2, libraryItems: items })); } catch {} }
/**
 * Merge incoming items into the existing library without mutating `items`.
 * @param {any[]} items
 * @param {any[]} incoming
 * @returns {any[]}
 */
export function addToLibrary(items, incoming) { return mergeLibrary(items, incoming); }

/**
 * Build deterministic-ID icon pack items so repeated installs never duplicate existing icons.
 * @param {string} packId
 * @param {number} [now]
 * @returns {any[]}
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

/**
 * Return true if every icon in `packId` is already present in `items`.
 * @param {any[]} items
 * @param {string} packId
 * @returns {boolean}
 */
export function isIconPackInstalled(items, packId) {
  const pack = getIconPack(packId);
  if (!pack || !Array.isArray(items) || !items.length) return false;
  const ids = new Set(items.map(it => it?.id));
  return pack.icons.every(ic => ids.has(`icon-pack:${pack.id}:${ic.id}`));
}

/**
 * Build the inspector panel DOM nodes for desktop ribbon or mobile sheet.
 * @param {any} _root Legacy container argument (unused; callers pass `null` or container and spread returned nodes).
 * @param {{
 *   session: any,
 *   state: any,
 *   setState: (op: any) => void,
 *   h: typeof import("./dom.js").h,
 *   inSheet?: boolean,
 *   workspaceMode?: "draw" | "animate" | "present" | null,
 *   ribbonExpanded?: boolean,
 *   ribbonShowAll?: boolean,
 *   colorPicker?: string | null,
 *   setColorPicker?: ((prop: string | null) => void) | null,
 *   colorPickerState?: { h: number | null, mode: string } | null,
 *   prefs?: import("../../ports/storage.js").Storage | null,
 *   canvas?: HTMLCanvasElement | null,
 *   win?: any,
 *   clock?: import("../../ports/clock.js").Clock | null,
 *   library?: any[],
 *   setLibrary: (items: any[]) => void,
 *   localView?: any,
 *   onResetLocalView?: (() => void) | null,
 *   onSoloLayer?: ((id: string) => void) | null,
 *   onJumpFrame?: ((id: string) => void) | null,
 *   onStepFrame?: ((delta: number) => void) | null,
 *   onRibbonTab?: ((id: string, activeTabId: string) => void) | null,
 *   onToggleRibbon?: (() => void) | null,
 *   onToggleRibbonAll?: (() => void) | null,
 *   onChange: () => void,
 * }} ctx
 * @returns {any[]}
 */
export function renderPanel(_root, ctx) {
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
  // Why: `fk` (`data-fk`) encodes stable action identity rather than mutable display text,
  // so `focus.js` restores focus to the exact same control across redraws.
  const chip = (txt, on, onclick, title, view = false, fk = null) => {
    const iconOnly = typeof txt !== "string" && !Array.isArray(txt);
    return h("button.c" + (on ? ".on" : ""), { type: "button", title, ...(iconOnly && title ? { "aria-label": title } : {}), disabled: !view && dis, "data-fk": fk, onclick: () => onclick?.() }, txt);
  };
  const act = fn => S.act(stream, fn);
  const style = patch => act(e => e.setStyle(patch));
  const row = (lab, key, ...opts) => h("div.row", touchSheet ? { style: { minWidth: "0", maxWidth: "100%" } } : {}, h("span.lab", {}, lab, key ? h("i", {}, key) : null), h("span.opts", touchSheet ? { style: { minWidth: "0", maxWidth: "100%" } } : {}, ...opts));

  // Why: Desktop presenters use the horizontal grouped ribbon; mobile sheets (`inSheet`) and
  // annotators (`notesOnly`) use the compact vertical stack with inline swatch rows instead.
  const ribbonMode = !ctx.inSheet && !notesOnly;
  const ribbonExpanded = ctx.ribbonExpanded !== undefined ? Boolean(ctx.ribbonExpanded) : true;
  const ribbonShowAll = Boolean(ctx.ribbonShowAll);
  // Why: `.panel .sec` sets `overflow-x: auto; overflow-y: hidden` for horizontal ribbon scrolling,
  // which would clip any vertical popover inside it; capture the open popover and portal it after `.sec`.
  /** @type {any} */
  let activeColorPopover = null;
  const ribbonRow = (lab, key, ...opts) => h("div.row.ribbon-row", {},
    lab ? h("span.lab", {}, lab, key ? h("i", {}, key) : null) : null,
    h("span.opts", {}, ...opts));
  const ribbonGroup = (id, label, rows, extraCls = "") => {
    const live = rows.filter(Boolean);
    if (!live.length) return null;
    return h("div.ribbon-group" + extraCls, { "data-ribbon-group": id },
      h("div.ribbon-group-rows", {}, live),
      h("div.ribbon-group-label", {}, label));
  };

  function properties() {
    const out = [];
    const selNonLabels = ed.selected().filter(e => e && !isLabel(e));
    const selTypes = selNonLabels.map(e => e.type);
    const allowed = ribbonMode
      ? new Set(contextualPropKeys({ selectionTypes: selTypes, tool: S.tool, showAll: ribbonShowAll }))
      : null;
    const hasHiddenProps = ribbonMode
      ? contextualPropKeys({ selectionTypes: selTypes, tool: S.tool, showAll: false }).length < ALL_PROP_KEYS.length
      : false;
    const styleRowByProp = new Map(STYLE_ROWS.map(entry => [entry[2], entry]));
    const buildColorPill = (lab, prop, opts) => {
      const curVal = m[prop];
      const isNone = !curVal || curVal === "transparent";
      const popOpen = ctx.colorPicker === prop;
      if (popOpen) {
        const swatches = opts.map(([, val]) => {
          const on = m[prop] === val;
          return h("button.sw" + (val === "transparent" ? ".none" : "") + (on ? ".on" : ""), {
            type: "button",
            title: val === "transparent" ? "No fill" : val,
            "aria-label": val,
            disabled: dis,
            "data-fk": `chip:${prop}:${val}`,
            style: val === "transparent" ? {} : { background: val },
            onclick: () => style({ [prop]: val }),
          });
        });
        activeColorPopover = h("div.color-popover", {
          role: "dialog",
          "aria-label": `${lab} color picker`,
          "data-color-popover-panel": prop,
          onclick: ev => ev?.stopPropagation?.(),
        },
          h("div.color-popover-swatches", {}, swatches),
          createColorPicker({
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
      return h("button.c.color-pill" + (popOpen ? ".on" : ""), {
        type: "button",
        title: `${lab} color (${isNone ? "none" : curVal})`,
        "aria-label": `${lab} color`,
        "aria-haspopup": "dialog",
        "aria-expanded": String(popOpen),
        "data-color-popover": prop,
        "data-fk": `color-popover:${prop}`,
        disabled: dis,
        onclick: ev => {
          ev?.stopPropagation?.();
          ctx.setColorPicker?.(popOpen ? null : prop);
        },
      },
        h("span.color-pill-lab", {}, lab),
        h("span.sw.color-pill-dot" + (isNone ? ".none" : ""), {
          "aria-hidden": "true",
          style: isNone ? {} : { background: curVal },
        }),
        h("span.color-pill-caret", { "aria-hidden": "true" }, "▾"));
    };
    const buildStyleRow = (prop, labelOverride = null) => {
      if (notesOnly && !NOTE_ROWS.has(prop)) return null;
      if (allowed && !allowed.has(prop)) return null;
      const entry = styleRowByProp.get(prop);
      if (!entry) return null;
      const [lab, key, , opts] = entry;
      const ctrls = opts.map(([t, val]) => chip(t, isOn(m, prop, val), () => style({ [prop]: val }), `${prop} ${JSON.stringify(val)}`, false, `chip:${prop}:${JSON.stringify(val)}`));
      return ribbonMode ? ribbonRow(labelOverride ?? lab, key, ctrls) : row(lab, key, ctrls);
    };

    if (ribbonMode) {
      // 1. Colors group: Stroke + Fill popovers (Row 1), Opacity (Row 2)
      const colorPills = [];
      for (const prop of ["strokeColor", "backgroundColor"]) {
        if (allowed && !allowed.has(prop)) continue;
        const entry = styleRowByProp.get(prop);
        if (entry) colorPills.push(buildColorPill(entry[0], prop, entry[3]));
      }
      const colorsGroup = ribbonGroup("colors", "Colors", [
        colorPills.length ? h("div.row.ribbon-row.ribbon-color-pair", {}, h("span.opts", {}, colorPills)) : null,
        buildStyleRow("opacity"),
      ]);
      if (colorsGroup) out.push(colorsGroup);

      // 2. Line group: Width (Row 1), Style (Row 2), Sketch (Row 3)
      const lineGroup = ribbonGroup("line", "Line", [
        buildStyleRow("strokeWidth"),
        buildStyleRow("strokeStyle"),
        buildStyleRow("roughness"),
      ]);
      if (lineGroup) out.push(lineGroup);

      // 3. Shape group: Pattern (Row 1), Edges (Row 2)
      const shapeGroup = ribbonGroup("shape", "Shape", [
        buildStyleRow("fillStyle"),
        buildStyleRow("roundness"),
      ]);
      if (shapeGroup) out.push(shapeGroup);

      // 4. Arrow group (when arrow/line selected or tool active or All): Arrow (Row 1), Heads (Row 2), Bends (Row 3)
      const showArrow = !allowed || allowed.has("arrow");
      const showHeads = !allowed || allowed.has("heads");
      const showBends = !allowed || allowed.has("bends");
      if (showArrow || showHeads || showBends) {
        const arrowGroup = ribbonGroup("arrow", "Arrow", [
          showArrow ? ribbonRow("Arrow", "", chip("sharp", m.arrowType === "sharp", () => style({ elbowed: false, roundness: null })), chip("curve", m.arrowType === "curve", () => style({ elbowed: false, roundness: { type: 2 } })), chip("elbow", m.arrowType === "elbow", () => style({ elbowed: true }), "elbowed: routed around shapes")) : null,
          showHeads ? ribbonRow("Heads", "", HEADS.map(([t, s0, e0]) => chip(t, m.heads[0] === s0 && m.heads[1] === e0, () => style({ startArrowhead: s0, endArrowhead: e0 })))) : null,
          showBends ? ribbonRow("Bends", "", chip("+ bend", false, () => act(e => e.addBend())), chip("straighten", false, () => act(e => e.straighten()))) : null,
        ]);
        if (arrowGroup) out.push(arrowGroup);
      }

      // 5. Text group: Font (Row 1), Size (Row 2)
      const textGroup = ribbonGroup("text", "Text", [
        buildStyleRow("fontFamily"),
        buildStyleRow("fontSize", "Size"),
      ]);
      if (textGroup) out.push(textGroup);
    } else {
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
    }
    if (!notesOnly) {
      if (m.count >= 1 && (!allowed || allowed.has("effects"))) {
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
        if (ribbonMode) {
          out.push(ribbonGroup("effects", "Effects", [
            h("div.effects-sec", { "data-effects": "1" },
              ribbonRow("Blend", "", blendSel),
              ribbonRow("Mask", "", clipSel)),
          ]));
        } else {
          out.push(
            h("div.effects-sec", { "data-effects": "1" },
              h("div.hint", { style: { margin: "8px 0 4px" } }, "Effects"),
              row("Blend", "", blendSel),
              row("Mask", "", clipSel)),
          );
        }
      }
      const singleEl = selNonLabels.length === 1 ? selNonLabels[0] : null;
      const showMeta = Boolean(
        (!allowed || allowed.has("meta")) &&
        singleEl &&
        (isShape(singleEl) || singleEl.type === "frame") &&
        !parseLinkCardFromElement(singleEl) &&
        !parseEmbedFromElement(singleEl),
      );
      if (showMeta && singleEl) {
        const curMeta = metaOf(singleEl);
        const metaEditable = !dis && ed.doc.editable(singleEl);
        const touchFieldStyle = touchSheet
          ? { minHeight: "44px", fontSize: "16px", maxWidth: "100%", minWidth: "0", flex: "1 1 140px" }
          : { width: "100%", minWidth: "0" };
        const errEl = h("div.hint", {
          role: "alert",
          "data-meta-error": "1",
          hidden: true,
          style: { color: "var(--danger, #e03131)", marginTop: "4px" },
        }, "");
        const setErr = msg => {
          errEl.textContent = msg;
          errEl.hidden = !msg;
        };
        const ownerInput = /** @type {HTMLInputElement} */ (h("input.field.meta-input", {
          type: "text",
          "aria-label": "Owner",
          "data-meta": "owner",
          "data-fk": "meta:owner",
          placeholder: "Team or owner",
          maxLength: MAX_META_OWNER_LENGTH,
          value: curMeta?.owner ?? "",
          disabled: !metaEditable,
          style: touchFieldStyle,
        }));
        const serviceInput = /** @type {HTMLInputElement} */ (h("input.field.meta-input", {
          type: "text",
          "aria-label": "Service",
          "data-meta": "service",
          "data-fk": "meta:service",
          placeholder: "Service name",
          maxLength: MAX_META_SERVICE_LENGTH,
          value: curMeta?.service ?? "",
          disabled: !metaEditable,
          style: touchFieldStyle,
        }));
        const runbookInput = /** @type {HTMLInputElement} */ (h("input.field.meta-input", {
          type: "url",
          "aria-label": "Runbook URL",
          "data-meta": "runbookUrl",
          "data-fk": "meta:runbookUrl",
          placeholder: "https://runbooks.example.com/...",
          maxLength: MAX_RUNBOOK_URL_LENGTH,
          value: curMeta?.runbookUrl ?? "",
          disabled: !metaEditable,
          style: touchFieldStyle,
        }));
        let initialOwner = curMeta?.owner ?? "";
        let initialService = curMeta?.service ?? "";
        let initialRunbook = curMeta?.runbookUrl ?? "";
        const commitMeta = () => {
          if (!metaEditable) return;
          const ownerVal = ownerInput.value ?? "";
          const serviceVal = serviceInput.value ?? "";
          const runbookVal = runbookInput.value ?? "";
          const ownerDirty = ownerVal !== initialOwner;
          const serviceDirty = serviceVal !== initialService;
          const runbookDirty = runbookVal !== initialRunbook;
          if (!ownerDirty && !serviceDirty && !runbookDirty) {
            setErr("");
            return;
          }
          if (runbookDirty && runbookVal.trim() !== "" && !validateRunbookUrl(runbookVal)) {
            setErr("Runbook URL must be a valid https:// URL");
            return;
          }
          setErr("");
          act(e => {
            const live = e.doc.get(singleEl.id);
            if (!live || !e.doc.editable(live)) return;
            const liveMeta = metaOf(live);
            const mergedRaw = {
              ...(liveMeta?.tier ? { tier: liveMeta.tier } : {}),
              ...(liveMeta?.tags?.length ? { tags: liveMeta.tags } : {}),
              owner: ownerDirty ? ownerVal : (liveMeta?.owner ?? ""),
              service: serviceDirty ? serviceVal : (liveMeta?.service ?? ""),
              runbookUrl: runbookDirty ? runbookVal : (liveMeta?.runbookUrl ?? ""),
            };
            const nextMeta = normalizeShapeMeta(mergedRaw);
            if (JSON.stringify(nextMeta ?? null) === JSON.stringify(liveMeta ?? null)) {
              initialOwner = ownerVal;
              initialService = serviceVal;
              initialRunbook = runbookVal;
              return;
            }
            const ok = e.transact(tx => {
              const cur = tx.get(live.id);
              if (!cur) return false;
              const nextCustom = { ...(cur.customData ?? {}) };
              if (nextMeta) nextCustom.meta = nextMeta;
              else delete nextCustom.meta;
              cur.customData = nextCustom;
              return true;
            });
            if (ok) {
              initialOwner = nextMeta?.owner ?? "";
              initialService = nextMeta?.service ?? "";
              initialRunbook = nextMeta?.runbookUrl ?? "";
            }
          });
        };
        const bindMetaInput = input => {
          input.addEventListener("blur", () => commitMeta());
          input.addEventListener("keydown", k => {
            k.stopPropagation();
            if (k.key === "Enter") {
              k.preventDefault?.();
              commitMeta();
            } else if (k.key === "Escape") {
              k.preventDefault?.();
              const latest = metaOf(ed.doc.get(singleEl.id)) ?? curMeta;
              ownerInput.value = latest?.owner ?? "";
              serviceInput.value = latest?.service ?? "";
              runbookInput.value = latest?.runbookUrl ?? "";
              initialOwner = ownerInput.value;
              initialService = serviceInput.value;
              initialRunbook = runbookInput.value;
              setErr("");
              input.blur?.();
            }
          });
        };
        bindMetaInput(ownerInput);
        bindMetaInput(serviceInput);
        bindMetaInput(runbookInput);
        const safeRunbookUrl = curMeta?.runbookUrl ? validateRunbookUrl(curMeta.runbookUrl) : null;
        const runbookLink = safeRunbookUrl
          ? h("a.c.meta-runbook-link", {
            href: safeRunbookUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            "data-meta-link": "runbook",
            "data-fk": "meta:open-runbook",
            title: `Open ${safeRunbookUrl}`,
            style: touchSheet ? { minHeight: "44px", display: "inline-flex", alignItems: "center" } : undefined,
          }, "Open runbook ↗")
          : null;
        if (ribbonMode) {
          out.push(ribbonGroup("meta", "Metadata", [
            h("div.meta-sec", { "data-meta-section": "1" },
              ribbonRow("Owner", "", ownerInput),
              ribbonRow("Service", "", serviceInput),
              ribbonRow("Runbook", "", runbookInput, runbookLink),
              errEl),
          ]));
        } else {
          out.push(
            h("div.meta-sec", { "data-meta-section": "1" },
              h("div.hint", { style: { margin: "8px 0 4px" } }, "Metadata"),
              row("Owner", "", ownerInput),
              row("Service", "", serviceInput),
              row("Runbook", "", runbookInput),
              runbookLink ? h("div.row", { style: { marginTop: "4px" } }, h("span.lab", {}, ""), h("span.opts", {}, runbookLink)) : null,
              errEl),
          );
        }
      }
      if (!ribbonMode) {
        out.push(h("div.hint", { style: { margin: "8px 0 4px" } }, "With an arrow selected (or the Arrow tool):"));
        out.push(row("Arrow", "", chip("sharp", m.arrowType === "sharp", () => style({ elbowed: false, roundness: null })), chip("curve", m.arrowType === "curve", () => style({ elbowed: false, roundness: { type: 2 } })), chip("elbow", m.arrowType === "elbow", () => style({ elbowed: true }), "elbowed: routed around shapes")));
        out.push(row("Heads", "", HEADS.map(([t, s0, e0]) => chip(t, m.heads[0] === s0 && m.heads[1] === e0, () => style({ startArrowhead: s0, endArrowhead: e0 })))));
        out.push(row("Bends", "", chip("+ bend", false, () => act(e => e.addBend())), chip("straighten", false, () => act(e => e.straighten()))));
      } else {
        // Actions group (when elements are selected)
        if (m.count >= 1) {
          const actionsGroup = ribbonGroup("actions", "Actions", [
            ribbonRow("", "", chip("Group", false, () => act(e => e.group()), "Group (⌘G)", false, "prop-act:group"), chip("Ungroup", false, () => act(e => e.ungroup()), "Ungroup (⌘⇧G)", false, "prop-act:ungroup")),
            ribbonRow("", "", chip("Duplicate", false, () => act(e => e.cloneSelection(20, 20)), "Duplicate (⌘D)", false, "prop-act:dup"), chip("Lock", false, () => act(e => e.toggleLock()), "Lock (⌘⇧L)", false, "prop-act:lock")),
            ribbonRow("", "", chip("Delete", false, () => act(e => e.deleteIds([...e.sel])), "Delete (⌫)", false, "prop-act:del")),
          ]);
          if (actionsGroup) out.push(actionsGroup);
        }
        if (hasHiddenProps || ribbonShowAll) {
          out.push(ribbonGroup("more", "More", [
            h("button.c.ribbon-all-btn" + (ribbonShowAll ? ".on" : ""), {
              type: "button",
              title: ribbonShowAll ? "Return to contextual properties" : "Show all properties",
              "aria-label": ribbonShowAll ? "Contextual properties" : "Show all properties",
              "aria-pressed": String(ribbonShowAll),
              "data-ribbon-all": "1",
              "data-fk": "ribbon:show-all",
              onclick: () => ctx.onToggleRibbonAll?.(),
            }, ribbonShowAll ? "Contextual" : "All ⋯"),
          ], ".ribbon-group-util"));
        }
      }
    }
    return out;
  }
  const B = S.eds.board;
  const bodies = {
    properties,
    arrange: () => {
      if (ribbonMode) {
        const groups = [];
        if (m.count >= 2) {
          const alignBtn = (t, w) => h("button.c", {
            type: "button",
            title: `Align ${t}`,
            "aria-label": `Align ${t}`,
            "data-align": w,
            "data-fk": `arrange:align:${w}`,
            disabled: dis,
            onclick: () => act(e => e.alignSelection(w)),
          }, t);
          groups.push(ribbonGroup("align", "Align", [
            ribbonRow("", "", alignBtn("Left", "left"), alignBtn("Center X", "hcenter"), alignBtn("Right", "right")),
            ribbonRow("", "", alignBtn("Top", "top"), alignBtn("Center Y", "vcenter"), alignBtn("Bottom", "bottom")),
          ]));
          groups.push(ribbonGroup("distribute", "Distribute", [
            m.count >= 3
              ? ribbonRow("", "",
                h("button.c", {
                  type: "button",
                  title: "Distribute horizontally",
                  "aria-label": "Distribute horizontally",
                  "data-distribute": "h",
                  "data-fk": "arrange:dist:h",
                  disabled: dis,
                  onclick: () => act(e => e.distributeSelection("h")),
                }, "Horizontal"),
                h("button.c", {
                  type: "button",
                  title: "Distribute vertically",
                  "aria-label": "Distribute vertically",
                  "data-distribute": "v",
                  "data-fk": "arrange:dist:v",
                  disabled: dis,
                  onclick: () => act(e => e.distributeSelection("v")),
                }, "Vertical"))
              : null,
            ribbonRow("", "",
              h("button.c", {
                type: "button",
                title: "Tidy selection into neat row, column, or grid",
                "aria-label": "Tidy selection",
                "data-action": "tidy",
                "data-fk": "arrange:tidy",
                disabled: dis,
                onclick: () => act(e => e.tidySelection()),
              }, "Tidy")),
          ]));
        }
        groups.push(ribbonGroup("order", "Order", [
          ribbonRow("", "", chip("Front", false, () => act(e => e.reorder("front")), "front"), chip("Forward", false, () => act(e => e.reorder("forward")), "forward")),
          ribbonRow("", "", chip("Backward", false, () => act(e => e.reorder("backward")), "backward"), chip("Back", false, () => act(e => e.reorder("back")), "back")),
        ]));
        groups.push(ribbonGroup("group", "Group", [
          ribbonRow("", "", chip("group", false, () => act(e => e.group()), "Group (⌘G)"), chip("ungroup", false, () => act(e => e.ungroup()), "Ungroup (⌘⇧G)")),
          ribbonRow("", "", chip("dup", false, () => act(e => e.cloneSelection(20, 20)), "Duplicate (⌘D)"), chip("lock", false, () => act(e => e.toggleLock()), "Lock (⌘⇧L)")),
        ]));
        groups.push(ribbonGroup("rotate", "Rotate", [
          ribbonRow("", "", chip("-15°", false, () => act(e => e.rotateBy(-15)), "Rotate -15°"), chip("+15°", false, () => act(e => e.rotateBy(15)), "Rotate +15°")),
          ribbonRow("", "", chip("+90°", false, () => act(e => e.rotateBy(90)), "Rotate +90°"), chip("0°", false, () => act(e => e.resetRotation()), "Reset rotation")),
        ]));
        return groups.filter(Boolean);
      }
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
      if (ribbonMode) {
        const header = h("div.vbar-head.frames-bar-head", {},
          h("div.vbar-head-left", {},
            h("span.vbar-title", {}, "Frames"),
            h("span.vbar-count.frames-bar-count", { "aria-label": `${fs.length} frames` }, String(fs.length))),
          h("div.vbar-head-acts", {},
            h("button.tb.vbar-close-btn", {
              type: "button",
              title: "Close Frames",
              "aria-label": "Close Frames",
              "data-fk": "frames:close",
              onclick: () => ctx.onToggleRibbon?.(),
            }, icon("close", { size: 14 }))));
        const list = h("div.vbar-list.frames-bar-list", { role: "list", "aria-label": "Frames" },
          fs.map((f, i) => h("button.list-row.vbar-row.frame-row" + (B.frameAt === f.id ? ".on" : ""), {
            type: "button",
            role: "listitem",
            "data-fk": `frame:${f.id}`,
            onclick: () => goFrame(f.id),
          },
            h("span.vbar-idx.dim", {}, String(i + 1)),
            h("span.vbar-name", {}, f.rawName || `Frame ${i + 1}`))));
        const footer = h("div.vbar-foot.frames-bar-foot", {},
          h("div.vbar-foot-grp", {},
            chip([icon("chevronLeft", { size: 14 }), " prev"], false, () => stepFrame(-1), "PgUp", true, "frames:prev"),
            chip(["next ", icon("chevronRight", { size: 14 })], false, () => stepFrame(1), "PgDn", true, "frames:next")),
          chip("Fit all", false, () => S.fit(), "Fit everything (⇧1)", true, "frames:fit"));
        return [header, list, footer];
      }
      return [
        ...fs.map((f, i) => h("button.list-row" + (B.frameAt === f.id ? ".on" : ""), { "data-fk": `frame:${f.id}`, onclick: () => goFrame(f.id) }, h("span.dim", {}, String(i + 1)), " ", f.rawName || `Frame ${i + 1}`)),
        h("div.row", { style: { marginTop: "6px" } }, h("span.opts", {}, chip([icon("chevronLeft", { size: 14 }), " prev"], false, () => stepFrame(-1), "PgUp", true), chip(["next ", icon("chevronRight", { size: 14 })], false, () => stepFrame(1), "PgDn", true), chip("all", false, () => S.fit(), "Fit everything (⇧1)", true))),
      ];
    },
    animate: () => {
      const selEl = B.selected().filter(e => !isLabel(e))[0] ?? null;
      if (!selEl) {
        const hint = h("div.hint", { "data-anim-empty": "1" }, "Select a shape or clip on the timeline to edit its effect and timing.");
        return ribbonMode ? [ribbonGroup("anim-empty", "Animation", [hint])] : [hint];
      }
      const anim = selEl.customData?.anim ?? null;
      const cur = anim?.preset ?? null;
      const curMeta = cur ? getPreset(cur) : null;
      const curEasing = canonicalEasing(anim?.easing ?? curMeta?.easing ?? "ease-out");
      const curStart = anim?.start ?? 0;
      const curDur = anim?.duration ?? curMeta?.duration ?? 600;
      const curLoop = anim ? (anim.loop ?? curMeta?.loop ?? false) : false;
      const groups = presetsByCategory();

      const presetNodes = [
        h("option", { value: "", selected: !cur }, "None"),
        ...groups.map(g =>
          h("optgroup", { label: g.label, "data-category": g.id },
            g.presets.map(p => h("option", { value: p.id, selected: cur === p.id }, p.label)))),
      ];
      if (cur && cur !== "keyframes" && Object.hasOwn(PRESETS, cur) && PRESETS[cur].legacy) {
        presetNodes.splice(1, 0, h("option", { value: cur, selected: true }, PRESETS[cur].label));
      }
      if (cur === "keyframes") {
        presetNodes.splice(1, 0, h("option", { value: "keyframes", selected: true }, "Keyframes"));
      }

      const presetSel = h("select.anim-sel", {
        "aria-label": "Animation effect",
        "data-anim-field": "preset",
        "data-fk": "anim:preset",
        disabled: dis,
        value: cur ?? "",
        style: touchSelectStyle,
        onchange: e => {
          const val = e.currentTarget.value;
          if (!val) S.act("board", ed => ed.clearAnimation());
          else S.act("board", ed => ed.animate(val));
        },
        onkeydown: k => k.stopPropagation(),
      }, presetNodes);

      const clearBtn = cur
        ? h("button.c.anim-clear", {
          type: "button",
          title: "Remove animation",
          "aria-label": "Remove animation",
          "data-anim-field": "clear",
          "data-fk": "anim:clear",
          disabled: dis,
          style: touchBtnStyle,
          onclick: () => S.act("board", ed => ed.clearAnimation()),
        }, "×")
        : null;

      if (ribbonMode) {
        const effectRows = [ribbonRow("Effect", "", h("div.anim-effect-row", {}, presetSel, clearBtn))];
        const timingRows = [];
        if (anim && !anim.keys) {
          const easingSel = h("select.anim-sel", {
            "aria-label": "Easing curve",
            "data-anim-field": "easing",
            "data-fk": "anim:easing",
            disabled: dis,
            value: curEasing,
            onchange: e => S.act("board", ed => ed.updateAnimation({ easing: e.currentTarget.value })),
            onkeydown: k => k.stopPropagation(),
          }, EASING_META.map(ea => h("option", { value: ea.id, selected: curEasing === ea.id }, ea.label)));
          const numField = (label, val, step, min, prop) => h("label.anim-num", {},
            h("span", {}, label),
            h("input", {
              type: "number",
              min: String(min),
              step: String(step),
              value: String(val),
              "data-anim-field": prop,
              "data-fk": `anim:${prop}`,
              disabled: dis,
              onchange: e => S.act("board", ed => ed.updateAnimation({ [prop]: Number(e.currentTarget.value) })),
              onkeydown: k => k.stopPropagation(),
            }));
          effectRows.push(ribbonRow("Easing", "", easingSel));
          timingRows.push(
            h("div.anim-fields", {},
              numField("Delay ms", curStart, 50, 0, "start"),
              numField("Dur ms", curDur, 50, 50, "duration")),
            ribbonRow("Repeat", "", chip(curLoop ? "Loop on" : "Loop off", curLoop, () => S.act("board", ed => ed.updateAnimation({ loop: !curLoop })), "Repeat inside clip duration (off = single cycle)", false, "anim:loop")),
          );
        } else if (anim?.keys) {
          timingRows.push(h("div.hint", {}, "Keyframed clip — adjust timing on the timeline."));
        }
        return [
          ribbonGroup("anim-effect", "Effect", effectRows),
          timingRows.length ? ribbonGroup("anim-timing", "Timing", timingRows) : null,
        ].filter(Boolean);
      }

      const out = [
        row("Effect", "", h("div.anim-effect-row", {}, presetSel, clearBtn)),
      ];

      if (anim && !anim.keys) {
        const easingSel = h("select.anim-sel", {
          "aria-label": "Easing curve",
          "data-anim-field": "easing",
          "data-fk": "anim:easing",
          disabled: dis,
          value: curEasing,
          style: touchSelectStyle,
          onchange: e => S.act("board", ed => ed.updateAnimation({ easing: e.currentTarget.value })),
          onkeydown: k => k.stopPropagation(),
        }, EASING_META.map(ea => h("option", { value: ea.id, selected: curEasing === ea.id }, ea.label)));

        const numField = (label, val, step, min, prop) => h("label.anim-num", {},
          h("span", {}, label),
          h("input", {
            type: "number",
            min: String(min),
            step: String(step),
            value: String(val),
            "data-anim-field": prop,
            "data-fk": `anim:${prop}`,
            disabled: dis,
            onchange: e => S.act("board", ed => ed.updateAnimation({ [prop]: Number(e.currentTarget.value) })),
            onkeydown: k => k.stopPropagation(),
          }));

        out.push(
          row("Easing", "", easingSel),
          h("div.anim-fields", {},
            numField("Delay ms", curStart, 50, 0, "start"),
            numField("Dur ms", curDur, 50, 50, "duration")),
          row("Repeat", "", chip(curLoop ? "Loop on" : "Loop off", curLoop, () => S.act("board", ed => ed.updateAnimation({ loop: !curLoop })), "Repeat inside clip duration (off = single cycle)", false, "anim:loop")),
        );
      } else if (anim?.keys) {
        out.push(h("div.hint", {}, "Keyframed clip — adjust timing on the timeline."));
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
      const buildLayerRow = (l, idx, vertical) => {
        const eff = localById?.get(l.id);
        const isSolo = Boolean(eff?.solo);
        const locallyHidden = Boolean(localView?.active && eff && !eff.effectiveVisible);
        const visBtn = h("button.tb" + (!l.visible ? ".active-state" : ""), { type: "button", title: l.visible ? "Hide" : "Show", "aria-label": l.visible ? "Hide layer" : "Show layer", disabled: dis, "data-fk": `layer:${l.id}:visible`, onclick: ev => { ev.stopPropagation(); lact(e => e.updateLayer(l.id, { visible: !l.visible })); } }, icon(l.visible ? "eye" : "eyeOff", { size: 14 }));
        const lockBtn = h("button.tb" + (l.locked ? ".active-state" : ""), { type: "button", title: l.locked ? "Unlock" : "Lock", "aria-label": l.locked ? "Unlock layer" : "Lock layer", disabled: dis, "data-fk": `layer:${l.id}:lock`, onclick: ev => { ev.stopPropagation(); lact(e => e.updateLayer(l.id, { locked: !l.locked })); } }, icon(l.locked ? "lock" : "unlock", { size: 14 }));
        const soloBtn = h("button.tb.solo-btn" + (isSolo ? ".on" : ""), { type: "button", title: isSolo ? "Exit solo layer (local)" : "Solo layer (local only)", "aria-label": isSolo ? `Exit solo for ${l.name || "Layer"}` : `Solo ${l.name || "Layer"}`, "aria-pressed": String(isSolo), "data-fk": `layer:${l.id}:solo`, "data-solo-layer": l.id, onclick: ev => { ev.stopPropagation(); ctx.onSoloLayer?.(l.id); } }, "S");
        const nameEl = h("span" + (vertical ? ".layer-name" : ""), { title: "Double-click to rename", ondblclick: ev => {
          ev.stopPropagation(); if (dis) return;
          const input = h("input.rename", { value: l.name ?? "", maxLength: 80, onkeydown: k => { k.stopPropagation(); if (k.key === "Enter") input.blur(); if (k.key === "Escape") { input.value = l.name ?? ""; input.blur(); } },
            onblur: () => { const n = input.value.trim(); if (n && n !== l.name) lact(e => e.updateLayer(l.id, { name: n })); ctx.onChange(); } });
          ev.currentTarget.replaceWith(input); input.focus(); input.select();
        } }, l.name || "Layer");
        const cntEl = h("span.n", {}, String(count(l.id)));
        const rowCls = "div.list-row" + (vertical ? ".layer-row" : "") + (B.activeLayer === l.id ? ".on" : "") + (locallyHidden ? ".local-hidden" : "") + (!l.visible ? ".layer-hidden" : "");
        const rowAttrs = { role: "listitem", "aria-label": `Layer: ${l.name || "Layer"}`, "data-fk": `layer:${l.id}:row`, tabindex: "-1", onclick: () => { B.activeLayer = l.id; B.changed(); ctx.onChange(); } };
        if (vertical) {
          return h(rowCls, rowAttrs,
            h("span.layer-z", { "aria-hidden": "true" }, String(ls.length - idx)),
            nameEl,
            cntEl,
            h("div.layer-row-acts", {}, visBtn, lockBtn, soloBtn));
        }
        return h(rowCls, rowAttrs, visBtn, lockBtn, soloBtn, nameEl, cntEl);
      };
      if (ribbonMode) {
        const activeIdx = B.doc.layers.findIndex(l => l.id === B.activeLayer);
        const canMoveUp = !dis && activeIdx >= 0 && activeIdx < B.doc.layers.length - 1;
        const canMoveDown = !dis && activeIdx > 0;
        const canMoveSel = !dis && B.sel.size > 0;
        const canDelete = !dis && B.doc.layers.length > 1;
        const header = h("div.layers-bar-head", {},
          h("div.layers-bar-head-left", {},
            h("span.layers-bar-title", {}, "Layers"),
            h("span.layers-bar-count", { "aria-label": `${ls.length} layers` }, String(ls.length))),
          h("div.layers-bar-head-acts", {},
            h("button.c.layers-add-btn", {
              type: "button",
              title: "New layer",
              "aria-label": "New layer",
              "data-fk": "layers:add",
              disabled: dis,
              onclick: () => lact(e => e.addLayer()),
            }, icon("plus", { size: 13 }), " New layer"),
            h("button.tb.layers-close-btn", {
              type: "button",
              title: "Close Layers",
              "aria-label": "Close Layers",
              "data-fk": "layers:close",
              onclick: () => ctx.onToggleRibbon?.(),
            }, icon("close", { size: 14 }))));
        const list = h("div.layers-bar-list", { role: "list", "aria-label": "Layers" }, ls.map((l, idx) => buildLayerRow(l, idx, true)));
        const footer = h("div.layers-bar-foot", {},
          h("div.layers-foot-grp", {},
            h("button.c", {
              type: "button",
              title: "Move layer up",
              "aria-label": "Move layer up",
              "data-fk": "layers:move-up",
              disabled: !canMoveUp,
              onclick: () => lact(e => e.moveLayer(B.activeLayer, 1)),
            }, icon("arrowUp", { size: 14 })),
            h("button.c", {
              type: "button",
              title: "Move layer down",
              "aria-label": "Move layer down",
              "data-fk": "layers:move-down",
              disabled: !canMoveDown,
              onclick: () => lact(e => e.moveLayer(B.activeLayer, -1)),
            }, icon("arrowDown", { size: 14 })),
            h("button.c", {
              type: "button",
              title: "Move selection to active layer",
              "aria-label": "Move selection to active layer",
              "data-fk": "layers:move-sel",
              disabled: !canMoveSel,
              onclick: () => S.act("board", e => e.moveToLayer(B.activeLayer)),
            }, icon("moveToLayer", { size: 14 }))),
          h("button.c.layers-del-btn", {
            type: "button",
            title: "Delete layer (its shapes move down)",
            "aria-label": "Delete layer",
            "data-fk": "layers:delete",
            disabled: !canDelete,
            onclick: () => lact(e => e.deleteLayer(B.activeLayer)),
          }, icon("trash", { size: 14 })));
        return [header, resetBanner, list, footer].filter(Boolean);
      }
      const layerItems = ls.map((l, idx) => buildLayerRow(l, idx, false));
      return [
        resetBanner,
        h("div", { role: "list", "aria-label": "Layers" }, layerItems),
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
      const k8sBtn = h("button.c" + (k8sInstalled ? ".on" : ""), {
        type: "button",
        title: k8sInstalled ? "Kubernetes pack installed" : "Install Kubernetes vector icon pack",
        "aria-label": "Install Kubernetes pack",
        "data-icon-pack": "kubernetes",
        "data-fk": "lib:pack:kubernetes",
        style: touchBtnStyle,
        onclick: () => installPack("kubernetes"),
      }, "＋ Kubernetes pack");
      const cloudBtn = h("button.c" + (cloudInstalled ? ".on" : ""), {
        type: "button",
        title: cloudInstalled ? "Cloud pack installed" : "Install Cloud & Architecture vector icon pack",
        "aria-label": "Install Cloud pack",
        "data-icon-pack": "cloud",
        "data-fk": "lib:pack:cloud",
        style: touchBtnStyle,
        onclick: () => installPack("cloud"),
      }, "＋ Cloud pack");
      const libNodes = items.map((it, i) => h("button.item", { title: `Insert ${it.name ?? "item"}`, disabled: dis, "data-fk": `lib:${it.id ?? i}`, onclick: () => S.act("board", e => e.insertLibraryItem(it)) }, h("b", {}, String(it.elements.filter(e => !isLabel(e)).length)), h("span", {}, it.name ?? "item")));
      if (ribbonMode) {
        const canSave = !dis && B.sel.size > 0;
        const header = h("div.vbar-head.library-bar-head", {},
          h("div.vbar-head-left", {},
            h("span.vbar-title", {}, "Library"),
            h("span.vbar-count.library-bar-count", { "aria-label": `${items.length} library items` }, String(items.length))),
          h("div.vbar-head-acts", {},
            h("button.c.vbar-add-btn", {
              type: "button",
              title: "Save selection to library",
              "aria-label": "Save selection to library",
              "data-fk": "lib:save",
              disabled: !canSave,
              onclick: () => { const it = B.libraryItem(); if (it) ctx.setLibrary(addToLibrary(items, [it])); },
            }, icon("plus", { size: 13 }), " Save"),
            h("button.tb.vbar-close-btn", {
              type: "button",
              title: "Close Library",
              "aria-label": "Close Library",
              "data-fk": "library:close",
              onclick: () => ctx.onToggleRibbon?.(),
            }, icon("close", { size: 14 }))));
        const body = h("div.vbar-list.library-bar-list", {},
          items.length
            ? h("div.lib.vbar-lib-grid", {}, libNodes)
            : h("div.vbar-empty.hint", {}, "Empty. Select shapes and save them, install an icon pack below, or drop a .excalidrawlib."));
        const footer = h("div.vbar-foot.library-bar-foot", {},
          h("div.vbar-pack-row", {}, k8sBtn, cloudBtn));
        return [header, body, footer];
      }
      return [
        h("div.lib", {}, libNodes),
        h("div.row", { style: touchSheet ? { marginTop: "8px", minWidth: "0", maxWidth: "100%" } : { marginTop: "8px" } }, h("span.opts", touchSheet ? { style: { minWidth: "0", maxWidth: "100%" } } : {},
          chip("+ save selection", false, () => { const it = B.libraryItem(); if (it) ctx.setLibrary(addToLibrary(items, [it])); }, "libraryItem(name)"),
          k8sBtn,
          cloudBtn)),
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
  const secs = panelSections(st, availableFor(S, ctx.workspaceMode ?? null));
  const sub = { properties: m.count ? `· ${m.count} selected` : "· next shape", frames: `· ${listNamedFrames(B.doc).length}`, library: `· ${(ctx.library ?? []).length}` };
  const out = [];
  const activeTabId = tabs
    ? (secs.find(s => s.active)?.id ?? secs[0]?.id)
    : (secs.some(s => s.id === state.tab) ? state.tab : secs[0]?.id);
  // In desktop ribbon mode, tabs + collapse chevron live in Bar 1 (#topbar) — NO middle tab bar in #panel.
  if (!ribbonMode) {
    out.push(h("div.tabs", { role: "tablist", "aria-label": "Inspector sections" },
      secs.map(s => {
        const isSel = s.id === activeTabId;
        return h("button" + (isSel ? ".on" : ""), {
          type: "button",
          role: "tab",
          "aria-selected": String(isSel),
          "aria-label": s.title,
          "data-tab": s.id,
          "data-fk": `panel-tab:${s.id}`,
          style: touchBtnStyle,
          onclick: () => ctx.setState({ type: "tab", id: s.id }),
        }, s.title);
      })));
  }
  for (const s of secs) {
    if (!s.active) continue;
    const ribbonHidden = ribbonMode && s.id !== activeTabId;
    out.push(h("div.sec" + (s.folded ? ".folded" : ""), {
      "data-sec": s.id,
      ...(ribbonHidden ? { "data-ribbon-hidden": "true" } : {}),
    },
      h("h4", { onclick: () => !tabs && ctx.setState({ type: "fold", id: s.id }) }, s.title, sub[s.id] ? h("span", {}, sub[s.id]) : null),
      s.folded ? null : bodies[s.id]()));
  }
  // Portal the active color popover outside `.panel .sec` so `overflow-y: hidden` does not clip it.
  if (activeColorPopover && ribbonExpanded && activeTabId === "properties") {
    out.push(activeColorPopover);
  }
  return out;
}

export { applyPanel };
