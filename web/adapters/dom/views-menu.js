// @ts-check
// Quick Frame & Presentation View Navigator modal (#115).
// Mounts on the unified a11y.js overlay stack (trapFocus, Escape, Tab wrap, ArrowDown/Up + Enter).
// Uses WAI-ARIA combobox + listbox (`aria-activedescendant`, `role="option"`, `aria-selected`) so
// screen readers track arrow-key selection while focus stays in the search input.
// Jumping to frames and switching Views are strictly viewer-local; saving/deleting Views is gated by `canSave`.

import { filterFramesAndViews } from "../../../packages/core/views.js";
import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { trapFocus } from "./a11y.js";
import { isPhoneTouchViewport } from "./settings-dialog.js";

const LISTBOX_ID = "views-nav-listbox";

/**
 * Create a reusable Quick Frame / View Navigator modal controller.
 * @param {{
 *   host: HTMLElement,
 *   doc?: Document,
 *   win?: { matchMedia?: (query: string) => { matches?: boolean } | null } | null,
 *   getState: () => {
 *     frames: import("../../../packages/core/views.js").NamedFrame[],
 *     views: import("../../../packages/core/views.js").NamedView[],
 *     activeFrameId: string | null,
 *     localView: import("../../../packages/core/views.js").ResolvedLocalLayers,
 *     canSave: boolean,
 *   },
 *   onJumpFrame: (frameId: string) => void,
 *   onSelectView: (viewId: string) => void,
 *   onStepView: (delta: number) => void,
 *   onSaveView: (name: string) => any,
 *   onDeleteView: (viewId: string) => void,
 *   onResetLocalView: () => void,
 *   onSoloLayer?: ((layerId: string) => void) | null,
 *   onRestoreFocus?: (opener: any) => void,
 *   onClose?: () => void,
 * }} opts
 */
export function createViewsMenu({
  host,
  doc = globalThis.document,
  win = null,
  getState,
  onJumpFrame,
  onSelectView,
  onStepView,
  onSaveView,
  onDeleteView,
  onResetLocalView,
  onSoloLayer = null,
  onRestoreFocus = null,
  onClose = null,
}) {
  const isPhone = () => isPhoneTouchViewport(win ?? doc?.defaultView ?? globalThis);
  let openState = false;
  let query = "";
  let activeIndex = 0;
  let veil = null;
  let dialog = null;
  let searchInput = null;
  let listHost = null;
  let statusHost = null;
  let soloHost = null;
  let saveInput = null;
  let trap = null;
  let openerRef = null;
  /** @type {Array<{ kind: "view" | "frame", id: string, optId: string, el?: HTMLElement }>} */
  let entries = [];

  function isOpen() {
    return openState;
  }

  function close({ restoreFocus = true } = {}) {
    if (!openState) return;
    openState = false;
    const prevOpener = openerRef;
    openerRef = null;
    trap?.deactivate({ restoreFocus: false });
    trap = null;
    veil?.remove?.();
    veil = null;
    dialog = null;
    searchInput = null;
    listHost = null;
    statusHost = null;
    soloHost = null;
    saveInput = null;
    entries = [];
    if (restoreFocus) {
      if (typeof onRestoreFocus === "function") onRestoreFocus(prevOpener);
      else if (prevOpener && prevOpener.isConnected !== false) prevOpener.focus?.();
    }
    onClose?.();
  }

  function activateEntry(entry) {
    if (!entry) return;
    if (entry.kind === "view") {
      close({ restoreFocus: true });
      onSelectView(entry.id);
    } else if (entry.kind === "frame") {
      close({ restoreFocus: true });
      onJumpFrame(entry.id);
    }
  }

  function updateActiveHighlight() {
    let activeOptId = "";
    for (let i = 0; i < entries.length; i++) {
      const el = entries[i].el;
      if (!el) continue;
      const isAct = i === activeIndex;
      el.classList.toggle("active", isAct);
      el.setAttribute("aria-selected", String(isAct));
      if (isAct) {
        activeOptId = entries[i].optId;
        el.scrollIntoView?.({ block: "nearest" });
      }
    }
    if (searchInput) {
      if (activeOptId) searchInput.setAttribute("aria-activedescendant", activeOptId);
      else searchInput.removeAttribute("aria-activedescendant");
    }
  }

  function findInDialog(pred) {
    if (!dialog) return null;
    if (typeof dialog.all === "function") return dialog.all().find(pred) ?? null;
    const visit = node => {
      for (const child of node?.children ?? []) {
        if (pred(child)) return child;
        const hit = visit(child);
        if (hit) return hit;
      }
      return null;
    };
    return visit(dialog);
  }

  function restoreInsideModal(preferredPred = null) {
    if (!openState || !dialog) return;
    const target = preferredPred ? findInDialog(preferredPred) : null;
    (target ?? searchInput ?? dialog)?.focus?.();
  }

  function renderBody() {
    if (!openState || !listHost || !statusHost) return;
    const phoneTouch = isPhone();
    const touchBtnStyle = phoneTouch ? { minHeight: "44px", minWidth: "44px" } : undefined;
    const touchRowStyle = phoneTouch ? { minHeight: "44px" } : undefined;
    const state = getState();
    const { frames, views } = filterFramesAndViews(query, {
      frames: state.frames,
      views: state.views,
    });
    const frameById = new Map(state.frames.map(f => [f.id, f]));
    const local = state.localView;

    // Active local filter banner (solo layer or view layer filter)
    if (local?.active) {
      const soloLayer = local.soloLayerId
        ? local.layers.find(l => l.id === local.soloLayerId)
        : null;
      const label = local.mode === "solo"
        ? `Solo layer: ${soloLayer?.name || "Layer"}`
        : `View filter: ${local.activeViewName || "Custom layers"}`;
      replace(statusHost,
        h("div.views-filter-banner", { role: "status" },
          h("span.views-filter-label", {}, label),
          h("button.c.on", {
            type: "button",
            "aria-label": "Show all layers",
            "data-action": "reset-local-layers",
            style: touchBtnStyle,
            onclick: () => {
              onResetLocalView();
              renderBody();
              restoreInsideModal();
            },
          }, "Show all layers")));
      statusHost.hidden = false;
    } else {
      replace(statusHost);
      statusHost.hidden = true;
    }

    entries = [];
    const sections = [];

    // Saved Presentation Views section
    if (views.length || state.views.length) {
      const viewRows = views.map(v => {
        const idx = entries.length;
        const optId = `views-opt-${idx}`;
        const linkedFrame = v.frameId ? frameById.get(v.frameId) : null;
        const isCurrent = local?.activeViewId === v.id;
        const metaParts = [];
        if (linkedFrame) metaParts.push(linkedFrame.name);
        if (Array.isArray(v.visibleLayers)) {
          metaParts.push(`${v.visibleLayers.length} ${v.visibleLayers.length === 1 ? "layer" : "layers"}`);
        }
        const entry = { kind: /** @type {const} */ ("view"), id: v.id, optId, el: /** @type {HTMLElement | undefined} */ (undefined) };
        const row = h("div.views-row" + (isCurrent ? ".on" : ""), {
          id: optId,
          role: "option",
          "aria-selected": "false",
          "data-view-id": v.id,
        },
        h("button.views-row-btn", {
          type: "button",
          "aria-label": `Switch to view ${v.name}`,
          "data-views-item": `view:${v.id}`,
          style: touchRowStyle,
          onclick: () => activateEntry(entry),
          onmouseenter: () => { activeIndex = idx; updateActiveHighlight(); },
        },
        h("span.views-row-ic", {}, icon("layers", { size: 14 })),
        h("span.views-row-name", {}, v.name),
        metaParts.length ? h("span.views-row-meta", {}, metaParts.join(" · ")) : null),
        state.canSave
          ? h("button.tb.views-del-btn", {
            type: "button",
            title: `Delete view ${v.name}`,
            "aria-label": `Delete view ${v.name}`,
            "data-delete-view": v.id,
            style: touchBtnStyle,
            onclick: ev => {
              ev.stopPropagation();
              onDeleteView(v.id);
              renderBody();
              restoreInsideModal(el => el.hasAttribute?.("data-delete-view"));
            },
          }, icon("trash", { size: 13 }))
          : null);
        entry.el = row;
        entries.push(entry);
        return row;
      });

      const stepBtns = state.views.length > 1
        ? h("span.views-sec-acts", {},
          h("button.tb", {
            type: "button",
            title: "Previous view ([)",
            "aria-label": "Previous view",
            "data-step-view": "-1",
            style: touchBtnStyle,
            onclick: () => {
              onStepView(-1);
              renderBody();
              restoreInsideModal(el => el.getAttribute?.("data-step-view") === "-1");
            },
          }, icon("chevronLeft", { size: 14 })),
          h("button.tb", {
            type: "button",
            title: "Next view (])",
            "aria-label": "Next view",
            "data-step-view": "1",
            style: touchBtnStyle,
            onclick: () => {
              onStepView(1);
              renderBody();
              restoreInsideModal(el => el.getAttribute?.("data-step-view") === "1");
            },
          }, icon("chevronRight", { size: 14 })))
        : null;

      sections.push(h("div.views-section", { role: "group", "aria-label": "Saved views" },
        h("div.views-sec-head", {},
          h("span", {}, `Views · ${views.length}`),
          stepBtns),
        viewRows.length
          ? h("div.views-list", {}, viewRows)
          : h("div.hint.views-empty", {}, "No matching views.")));
    }

    // Named Frames section
    const frameRows = frames.map(f => {
      const idx = entries.length;
      const optId = `views-opt-${idx}`;
      const isCurrent = state.activeFrameId === f.id;
      const entry = { kind: /** @type {const} */ ("frame"), id: f.id, optId, el: /** @type {HTMLElement | undefined} */ (undefined) };
      const row = h("div.views-row" + (isCurrent ? ".on" : ""), {
        id: optId,
        role: "option",
        "aria-selected": "false",
        "data-frame-id": f.id,
      },
      h("button.views-row-btn", {
        type: "button",
        "aria-label": `Jump to frame ${f.name}`,
        "data-views-item": `frame:${f.id}`,
        style: touchRowStyle,
        onclick: () => activateEntry(entry),
        onmouseenter: () => { activeIndex = idx; updateActiveHighlight(); },
      },
      h("span.views-row-idx", {}, String(f.index + 1)),
      h("span.views-row-name", {}, f.name),
      h("span.views-row-meta", {}, `${Math.round(f.bounds.w)}×${Math.round(f.bounds.h)}`)));
      entry.el = row;
      entries.push(entry);
      return row;
    });

    sections.push(h("div.views-section", { role: "group", "aria-label": "Frames" },
      h("div.views-sec-head", {}, h("span", {}, `Frames · ${frames.length}`)),
      frameRows.length
        ? h("div.views-list", {}, frameRows)
        : h("div.hint.views-empty", {}, state.frames.length ? "No matching frames." : "No frames on this board yet. Press F to draw a frame.")));

    replace(listHost, sections);

    // Quick Solo Layer controls live in a sibling region outside role="listbox" so combobox semantics stay pure.
    if (soloHost) {
      if (typeof onSoloLayer === "function" && Array.isArray(local?.layers) && local.layers.length > 0) {
        replace(soloHost,
          h("div.views-section", {},
            h("div.views-sec-head", {}, h("span", {}, `Solo layer · ${local.layers.length}`)),
            h("div.opts", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } }, local.layers.map(l => {
              const isSolo = Boolean(l.solo || (local.mode === "solo" && local.soloLayerId === l.id));
              return h("button.c.views-solo-chip" + (isSolo ? ".on" : ""), {
                type: "button",
                title: isSolo ? `Exit solo for ${l.name || "Layer"}` : `Solo ${l.name || "Layer"}`,
                "aria-label": isSolo ? `Exit solo for ${l.name || "Layer"}` : `Solo ${l.name || "Layer"}`,
                "aria-pressed": String(isSolo),
                "data-action": "solo-layer",
                "data-solo-layer": l.id,
                style: touchBtnStyle,
                onclick: () => {
                  onSoloLayer(l.id);
                  renderBody();
                  restoreInsideModal(el => el.getAttribute?.("data-solo-layer") === l.id);
                },
              }, isSolo ? `Solo: ${l.name || "Layer"}` : (l.name || "Layer"));
            }))));
        soloHost.hidden = false;
      } else {
        replace(soloHost);
        soloHost.hidden = true;
      }
    }
    if (entries.length) {
      activeIndex = Math.max(0, Math.min(activeIndex, entries.length - 1));
      updateActiveHighlight();
    } else {
      activeIndex = 0;
      searchInput?.removeAttribute?.("aria-activedescendant");
    }
  }

  function handleSaveSubmit() {
    const state = getState();
    if (!state.canSave) return;
    const raw = saveInput ? saveInput.value : "";
    onSaveView(raw);
    if (saveInput) saveInput.value = "";
    renderBody();
  }

  function isToggleShortcut(e) {
    return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "j";
  }

  function open({ opener = null } = {}) {
    if (openState) {
      renderBody();
      searchInput?.focus?.();
      return;
    }
    openState = true;
    query = "";
    activeIndex = 0;
    openerRef = opener ?? doc?.activeElement ?? null;

    const phoneTouch = isPhone();
    const touchInputStyle = phoneTouch ? { minHeight: "44px", fontSize: "16px" } : undefined;
    const touchBtnStyle = phoneTouch ? { minHeight: "44px", minWidth: "44px" } : undefined;
    const state = getState();
    searchInput = h("input.field.views-search", {
      type: "search",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": "true",
      "aria-controls": LISTBOX_ID,
      placeholder: "Search frames & views…",
      "aria-label": "Search frames and views",
      value: "",
      style: touchInputStyle,
      oninput: e => {
        query = e.currentTarget.value ?? "";
        activeIndex = 0;
        renderBody();
      },
      onkeydown: e => {
        if (isToggleShortcut(e)) {
          e.preventDefault();
          e.stopPropagation();
          close({ restoreFocus: true });
          return;
        }
        if (e.key === "ArrowDown") {
          if (entries.length) {
            e.preventDefault();
            activeIndex = (activeIndex + 1) % entries.length;
            updateActiveHighlight();
          }
          return;
        }
        if (e.key === "ArrowUp") {
          if (entries.length) {
            e.preventDefault();
            activeIndex = (activeIndex - 1 + entries.length) % entries.length;
            updateActiveHighlight();
          }
          return;
        }
        if (e.key === "Enter") {
          if (entries.length) {
            e.preventDefault();
            activateEntry(entries[activeIndex] ?? entries[0]);
          }
          return;
        }
        if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
      },
    });

    statusHost = h("div.views-status-host", { hidden: true });
    listHost = h("div.views-results", { id: LISTBOX_ID, role: "listbox", "aria-label": "Frames and views" });
    soloHost = h("div.views-solo-host", { role: "region", "aria-label": "Solo layers", hidden: true });

    let footer = null;
    if (state.canSave) {
      saveInput = h("input.field.views-save-input", {
        type: "text",
        maxLength: 200,
        placeholder: "New view name (optional)…",
        "aria-label": "New view name",
        style: touchInputStyle,
        onkeydown: e => {
          if (isToggleShortcut(e)) {
            e.preventDefault();
            e.stopPropagation();
            close({ restoreFocus: true });
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            handleSaveSubmit();
            return;
          }
          if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
        },
      });
      footer = h("footer.views-footer", { style: phoneTouch ? { flexWrap: "wrap" } : undefined },
        saveInput,
        h("button.btn.primary", {
          type: "button",
          "aria-label": "Save current view",
          "data-action": "save-view",
          style: touchBtnStyle,
          onclick: () => handleSaveSubmit(),
        }, icon("plus", { size: 14 }), " Save current view"));
    } else {
      footer = h("footer.views-footer.views-footer-hint", {},
        h("span.dim", {}, phoneTouch
          ? "Tap a frame or view to jump · Switching views is local to you."
          : "Use ↑↓ and Enter to jump · [ / ] to step views · Switching views is local to you."));
    }

    dialog = h("div.dialog.views-modal", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "views-nav-title",
      "aria-label": "Jump to frame or view",
      "data-mobile-sheet": "1",
      ...(phoneTouch ? { "data-phone-touch": "1" } : {}),
      tabindex: "-1",
    },
    h("h2", { id: "views-nav-title" },
      icon("frame", { size: 16 }),
      " Jump to frame or view",
      h("span.spacer"),
      phoneTouch ? null : h("kbd.views-kbd", {}, "⌘J"),
      h("button.tb", {
        type: "button",
        title: "Close",
        "aria-label": "Close views navigator",
        style: touchBtnStyle,
        onclick: () => close({ restoreFocus: true }),
      }, icon("close", { size: 16 }))),
    h("div.dbody.views-body", {},
      h("div.views-search-wrap", {}, searchInput),
      statusHost,
      listHost,
      soloHost),
    footer);

    veil = h("div.dialog-veil.views-veil", {
      onclick: e => { if (e.target === e.currentTarget) close({ restoreFocus: true }); },
      onkeydown: e => trap?.handleKeyDown(e),
    }, dialog);

    host.append(veil);
    renderBody();
    trap = trapFocus(dialog, {
      onEscape: () => close({ restoreFocus: true }),
      returnFocusTo: openerRef,
      initialFocus: searchInput,
      doc,
    });
  }

  function toggle(opts) {
    if (openState) close({ restoreFocus: true });
    else open(opts);
  }

  function refresh() {
    if (openState) renderBody();
  }

  return {
    open,
    close,
    toggle,
    refresh,
    isOpen,
    destroy: () => close({ restoreFocus: false }),
  };
}
