// @ts-check
// Canvas right-click context menu (Issue #114): context-aware Element / Multi-Selection vs Empty Canvas menu,
// registered on the unified overlay stack (./a11y.js trapFocus) so Escape, Tab, Arrow keys, outside click,
// and hasActiveOverlay() all work seamlessly across real browsers and stub DOMs.

import { h } from "./dom.js";
import { icon } from "./icons.js";
import { trapFocus } from "./a11y.js";
import { isLabel, layerOf } from "../../../packages/core/model.js";

/**
 * Clamp a popup menu's (x, y) position so it never clips off the viewport edges.
 * @param {{ x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, margin?: number }} o
 * @returns {{ left: number, top: number }}
 */
export function clampMenuPosition({ x, y, width, height, viewportWidth, viewportHeight, margin = 8 }) {
  const vw = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1024;
  const vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 768;
  const mw = Number.isFinite(width) && width > 0 ? width : 220;
  const mh = Number.isFinite(height) && height > 0 ? height : 200;
  const maxLeft = Math.max(margin, vw - mw - margin);
  const maxTop = Math.max(margin, vh - mh - margin);
  return {
    left: Math.round(Math.max(margin, Math.min(x, maxLeft))),
    top: Math.round(Math.max(margin, Math.min(y, maxTop))),
  };
}

/**
 * @typedef {{
 *   type?: "item",
 *   id: string,
 *   label: string,
 *   icon?: string,
 *   shortcut?: string,
 *   danger?: boolean,
 *   disabled?: boolean,
 *   checked?: boolean,
 *   action?: () => void,
 *   submenu?: ContextMenuItem[],
 * } | { type: "sep" }} ContextMenuItem
 */

/**
 * Build the context-aware menu items for a right-click on the canvas.
 * @param {{
 *   mode: "element" | "canvas",
 *   may: boolean,
 *   canWrite?: boolean,
 *   canPaste?: boolean,
 *   canComment: boolean,
 *   canAnnotate: boolean,
 *   stream: "board" | "notes",
 *   selected: any[],
 *   layers: { id: string, name?: string }[],
 *   activeLayer: string | null,
 *   actions: {
 *     cut: () => void,
 *     copy: () => void,
 *     pasteHere: () => void,
 *     duplicate: () => void,
 *     del: () => void,
 *     group: () => void,
 *     ungroup: () => void,
 *     reorder: (how: "front" | "forward" | "backward" | "back") => void,
 *     moveToLayer: (layerId: string) => void,
 *     toggleLock: () => void,
 *     addComment: () => void,
 *     selectAll: () => void,
 *     addStickyNote: () => void,
 *     zoomToFit: () => void,
 *     resetZoom: () => void,
 *   },
 * }} ctx
 * @returns {ContextMenuItem[]}
 */
export function buildCanvasMenuItems(ctx) {
  const { mode, may, canWrite = may, canPaste = may, canComment, canAnnotate, stream, selected, layers, activeLayer, actions } = ctx;
  /** @type {ContextMenuItem[]} */
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== "sep") items.push({ type: "sep" }); };

  if (mode === "element") {
    const els = (selected ?? []).filter(e => e && !isLabel(e));
    const canGroup = canWrite && els.length >= 2;
    const canUngroup = canWrite && els.some(e => Array.isArray(e.groupIds) && e.groupIds.length > 0);
    const allLocked = els.length > 0 && els.every(e => Boolean(e.locked));
    const currentLayer = els.length === 1 ? layerOf(els[0]) : activeLayer;

    items.push(
      { id: "cut", label: "Cut", icon: "cut", shortcut: "⌘X", disabled: !canWrite, action: actions.cut },
      { id: "copy", label: "Copy", icon: "copy", shortcut: "⌘C", action: actions.copy },
      { id: "paste", label: "Paste here", icon: "paste", shortcut: "⌘V", disabled: !canPaste, action: actions.pasteHere },
      { id: "duplicate", label: "Duplicate", icon: "duplicate", shortcut: "⌘D", disabled: !canWrite, action: actions.duplicate },
      { id: "delete", label: "Delete", icon: "trash", shortcut: "⌫", danger: true, disabled: !canWrite, action: actions.del },
    );

    if (canGroup || canUngroup) {
      sep();
      if (canGroup) items.push({ id: "group", label: "Group", icon: "group", shortcut: "⌘G", action: actions.group });
      if (canUngroup) items.push({ id: "ungroup", label: "Ungroup", icon: "ungroup", shortcut: "⌘⇧G", action: actions.ungroup });
    }

    sep();
    items.push(
      { id: "bring-front", label: "Bring to Front", icon: "bringFront", shortcut: "]", disabled: !canWrite, action: () => actions.reorder("front") },
      { id: "bring-forward", label: "Bring Forward", icon: "bringForward", shortcut: "⌘]", disabled: !canWrite, action: () => actions.reorder("forward") },
      { id: "send-backward", label: "Send Backward", icon: "sendBackward", shortcut: "⌘[", disabled: !canWrite, action: () => actions.reorder("backward") },
      { id: "send-back", label: "Send to Back", icon: "sendBack", shortcut: "[", disabled: !canWrite, action: () => actions.reorder("back") },
    );

    sep();
    if (stream === "board" && Array.isArray(layers) && layers.length > 1) {
      items.push({
        id: "move-to-layer",
        label: "Move to Layer",
        icon: "layers",
        disabled: !canWrite,
        submenu: [...layers].reverse().map((l, idx) => ({
          id: `layer:${l.id}`,
          label: l.name || `Layer ${layers.length - idx}`,
          checked: currentLayer === l.id,
          disabled: !canWrite,
          action: () => actions.moveToLayer(l.id),
        })),
      });
    }
    items.push({
      id: "lock",
      label: allLocked ? "Unlock" : "Lock",
      icon: allLocked ? "unlock" : "lock",
      shortcut: "⌘⇧L",
      disabled: !canWrite,
      action: actions.toggleLock,
    });

    if (canComment) {
      sep();
      items.push({ id: "comment", label: "Add Comment here", icon: "comments", action: actions.addComment });
    }
    return items;
  }

  // Empty canvas menu
  items.push(
    { id: "paste", label: "Paste here", icon: "paste", shortcut: "⌘V", disabled: !canPaste, action: actions.pasteHere },
    { id: "select-all", label: "Select All", icon: "selectAll", shortcut: "⌘A", disabled: !canWrite, action: actions.selectAll },
  );
  if (canAnnotate) {
    items.push({ id: "sticky-note", label: "Add Sticky Note here", icon: "note", disabled: !canPaste, action: actions.addStickyNote });
  }
  if (canComment) {
    items.push({ id: "comment", label: "Add Comment here", icon: "comments", action: actions.addComment });
  }
  sep();
  items.push(
    { id: "zoom-fit", label: "Zoom to Fit", icon: "fit", shortcut: "⇧1", action: actions.zoomToFit },
    { id: "zoom-reset", label: "Reset Zoom (100%)", icon: "zoomReset", shortcut: "⌘0", action: actions.resetZoom },
  );
  return items;
}

/**
 * Create a single-instance canvas context menu controller.
 * @param {{ host?: HTMLElement | null, doc?: Document | null, onClose?: () => void }} [opts]
 */
export function createContextMenu({ host = null, doc = globalThis.document ?? null, onClose = null } = {}) {
  let menuEl = null;
  let trap = null;
  let openSubmenu = null;
  let openTrigger = null;
  let cleanupListeners = null;

  function enabledItemsOf(root) {
    if (!root) return [];
    const out = [];
    const visit = node => {
      for (const child of node?.children ?? []) {
        if (child.classList?.contains("ctx-submenu")) continue;
        if (child.getAttribute?.("role") === "menuitem" && !child.disabled && child.getAttribute?.("aria-disabled") !== "true") {
          out.push(child);
        } else {
          visit(child);
        }
      }
    };
    visit(root);
    return out;
  }

  function closeSubmenu({ focusTrigger = false } = {}) {
    if (openSubmenu) {
      openSubmenu.hidden = true;
      openSubmenu.classList?.remove("open");
    }
    if (openTrigger) {
      openTrigger.setAttribute?.("aria-expanded", "false");
      if (focusTrigger) openTrigger.focus?.();
    }
    openSubmenu = null;
    openTrigger = null;
  }

  function close({ restoreFocus = false } = {}) {
    if (!menuEl) return;
    closeSubmenu();
    cleanupListeners?.();
    cleanupListeners = null;
    const t = trap;
    trap = null;
    const el = menuEl;
    menuEl = null;
    t?.deactivate({ restoreFocus });
    el.remove?.();
    onClose?.();
  }

  function moveFocus(container, dir) {
    const list = enabledItemsOf(container);
    if (!list.length) return;
    const active = doc?.activeElement ?? null;
    const i = list.indexOf(active);
    let next;
    if (dir === "first") next = list[0];
    else if (dir === "last") next = list[list.length - 1];
    else if (dir === "next") next = i < 0 ? list[0] : list[(i + 1) % list.length];
    else next = i <= 0 ? list[list.length - 1] : list[i - 1];
    next?.focus?.();
  }

  function estimateHeight(items) {
    let hPx = 12;
    for (const it of items) hPx += it.type === "sep" ? 9 : 32;
    return hPx;
  }

  /**
   * Open the context menu at viewport coordinates `(x, y)`.
   * @param {{ x: number, y: number, items: ContextMenuItem[], opener?: { focus?: () => void, isConnected?: boolean } | null, label?: string }} o
   */
  function open({ x, y, items, opener = null, label = "Canvas context menu" }) {
    close({ restoreFocus: false });
    const container = host ?? doc?.body ?? null;
    if (!container || !items?.length) return null;

    const rows = [];
    for (const item of items) {
      if (item.type === "sep") {
        rows.push(h("div.ctx-sep", { role: "separator" }));
        continue;
      }
      if (Array.isArray(item.submenu) && item.submenu.length > 0) {
        let subEl = null;
        const trigger = h("button.ctx-item.ctx-has-sub", {
          type: "button",
          role: "menuitem",
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          "data-ctx-id": item.id,
          disabled: Boolean(item.disabled),
          ...(item.disabled ? { "aria-disabled": "true" } : {}),
          onclick: e => {
            e.stopPropagation?.();
            if (item.disabled || !subEl) return;
            const willOpen = openSubmenu !== subEl;
            closeSubmenu();
            if (willOpen) {
              subEl.hidden = false;
              subEl.classList?.add("open");
              trigger.setAttribute?.("aria-expanded", "true");
              openSubmenu = subEl;
              openTrigger = trigger;
              positionSubmenu(subEl, trigger);
              moveFocus(subEl, "first");
            }
          },
          onmouseenter: () => {
            if (item.disabled || !subEl) return;
            if (openSubmenu !== subEl) {
              closeSubmenu();
              subEl.hidden = false;
              subEl.classList?.add("open");
              trigger.setAttribute?.("aria-expanded", "true");
              openSubmenu = subEl;
              openTrigger = trigger;
              positionSubmenu(subEl, trigger);
            }
          },
          onkeydown: e => {
            if (e.key === "ArrowRight" && !item.disabled && subEl) {
              e.preventDefault?.();
              e.stopPropagation?.();
              closeSubmenu();
              subEl.hidden = false;
              subEl.classList?.add("open");
              trigger.setAttribute?.("aria-expanded", "true");
              openSubmenu = subEl;
              openTrigger = trigger;
              positionSubmenu(subEl, trigger);
              moveFocus(subEl, "first");
            }
          },
        },
        item.icon ? h("span.ctx-ic", {}, icon(item.icon, { size: 15 })) : null,
        h("span.ctx-lab", {}, item.label),
        h("span.ctx-chevron", { "aria-hidden": "true" }, icon("chevronRight", { size: 13 })));

        subEl = h("div.ctx-submenu", {
          role: "menu",
          "aria-label": item.label,
          hidden: true,
          onkeydown: e => {
            if (e.key === "ArrowLeft") {
              e.preventDefault?.();
              e.stopPropagation?.();
              closeSubmenu({ focusTrigger: true });
            } else if (e.key === "ArrowDown") {
              e.preventDefault?.();
              e.stopPropagation?.();
              moveFocus(subEl, "next");
            } else if (e.key === "ArrowUp") {
              e.preventDefault?.();
              e.stopPropagation?.();
              moveFocus(subEl, "prev");
            } else if (e.key === "Home") {
              e.preventDefault?.();
              e.stopPropagation?.();
              moveFocus(subEl, "first");
            } else if (e.key === "End") {
              e.preventDefault?.();
              e.stopPropagation?.();
              moveFocus(subEl, "last");
            }
          },
        }, item.submenu.map(sub => {
          if (sub.type === "sep") return h("div.ctx-sep", { role: "separator" });
          return h("button.ctx-item" + (sub.checked ? ".checked" : ""), {
            type: "button",
            role: "menuitem",
            "data-ctx-id": sub.id,
            disabled: Boolean(sub.disabled),
            ...(sub.disabled ? { "aria-disabled": "true" } : {}),
            onclick: e => {
              e.stopPropagation?.();
              if (sub.disabled) return;
              close({ restoreFocus: true });
              sub.action?.();
            },
          },
          h("span.ctx-ic", {}, sub.checked ? icon("check", { size: 14 }) : null),
          h("span.ctx-lab", {}, sub.label));
        }));

        rows.push(h("div.ctx-sub-wrap", {}, trigger, subEl));
        continue;
      }

      const cls = "button.ctx-item" + (item.danger ? ".danger" : "");
      rows.push(h(cls, {
        type: "button",
        role: "menuitem",
        "data-ctx-id": item.id,
        disabled: Boolean(item.disabled),
        ...(item.disabled ? { "aria-disabled": "true" } : {}),
        onclick: e => {
          e.stopPropagation?.();
          if (item.disabled) return;
          close({ restoreFocus: true });
          item.action?.();
        },
        onmouseenter: () => { if (openSubmenu) closeSubmenu(); },
      },
      item.icon ? h("span.ctx-ic", {}, icon(item.icon, { size: 15 })) : null,
      h("span.ctx-lab", {}, item.label),
      item.shortcut ? h("kbd.ctx-kbd", {}, item.shortcut) : null));
    }

    const el = h("div.ctx-menu", {
      role: "menu",
      "aria-label": label,
      tabindex: "-1",
      oncontextmenu: e => e.preventDefault?.(),
      onkeydown: e => {
        if (openSubmenu && openSubmenu.contains?.(e.target)) return;
        if (e.key === "ArrowDown") { e.preventDefault?.(); moveFocus(el, "next"); }
        else if (e.key === "ArrowUp") { e.preventDefault?.(); moveFocus(el, "prev"); }
        else if (e.key === "Home") { e.preventDefault?.(); moveFocus(el, "first"); }
        else if (e.key === "End") { e.preventDefault?.(); moveFocus(el, "last"); }
      },
    }, rows);

    container.append(el);
    menuEl = el;

    // Position and clamp to viewport edges
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const vw = (typeof globalThis.innerWidth === "number" && globalThis.innerWidth > 0)
      ? globalThis.innerWidth
      : (container.getBoundingClientRect?.().width || 1024);
    const vh = (typeof globalThis.innerHeight === "number" && globalThis.innerHeight > 0)
      ? globalThis.innerHeight
      : (container.getBoundingClientRect?.().height || 768);
    // In stub DOMs getBoundingClientRect returns the default 1200x800; use reasonable menu size when rect looks like a full-viewport stub.
    const measuredW = rect.width > 0 && rect.width < 600 ? rect.width : 224;
    const measuredH = rect.height > 0 && rect.height < 700 ? rect.height : estimateHeight(items);
    const pos = clampMenuPosition({ x, y, width: measuredW, height: measuredH, viewportWidth: vw, viewportHeight: vh });
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;

    // Register on the unified a11y overlay stack (handles Escape, Tab wrapping, hasActiveOverlay()).
    const firstEnabled = enabledItemsOf(el)[0] ?? el;
    trap = trapFocus(el, {
      onEscape: () => {
        if (openSubmenu) { closeSubmenu({ focusTrigger: true }); return; }
        close({ restoreFocus: true });
      },
      returnFocusTo: opener,
      initialFocus: firstEnabled,
      focusOnActivate: true,
      doc,
    });

    const onOutside = e => {
      if (!menuEl) return;
      if (e?.target && menuEl.contains?.(e.target)) return;
      close({ restoreFocus: false });
    };
    const onWinChange = () => close({ restoreFocus: false });
    doc?.addEventListener?.("pointerdown", onOutside, true);
    doc?.addEventListener?.("click", onOutside, true);
    doc?.addEventListener?.("wheel", onWinChange, true);
    globalThis.addEventListener?.("resize", onWinChange);
    globalThis.addEventListener?.("blur", onWinChange);
    cleanupListeners = () => {
      doc?.removeEventListener?.("pointerdown", onOutside, true);
      doc?.removeEventListener?.("click", onOutside, true);
      doc?.removeEventListener?.("wheel", onWinChange, true);
      globalThis.removeEventListener?.("resize", onWinChange);
      globalThis.removeEventListener?.("blur", onWinChange);
    };
    return el;
  }

  function positionSubmenu(subEl, trigger) {
    if (!subEl || !trigger || !menuEl) return;
    const vw = (typeof globalThis.innerWidth === "number" && globalThis.innerWidth > 0) ? globalThis.innerWidth : 1024;
    const menuRect = menuEl.getBoundingClientRect?.();
    const flipLeft = menuRect && menuRect.right > 0 && menuRect.right < vw && (menuRect.right + 190 > vw);
    subEl.classList?.toggle("flip-left", Boolean(flipLeft));
  }

  return {
    open,
    close,
    isOpen: () => Boolean(menuEl),
    element: () => menuEl,
  };
}
