// @ts-check
// Mobile bottom sheets & touch long-press controller (Chrome on iOS / WKWebView):
// - Single-finger 450ms long-press tracker (< 8px movement, cancelled on move >= 8px, pinch, up, cancel)
// - Context-aware Mobile Selection Action Sheet (44x44px rows, role & stream write gating)
// - Mobile Rename Board Sheet (16px font input to prevent iOS auto-zoom, >= 44px Save/Cancel)

import { h } from "./dom.js";
import { icon } from "./icons.js";
import { isLabel } from "../../../packages/core/model.js";

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_TOLERANCE_PX = 8;

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   icon: string,
 *   danger?: boolean,
 *   action: () => void,
 * }} MobileSelectionAction
 */

/**
 * Track single-finger touch long-presses on the canvas.
 * Cancels immediately on movement >= `moveTolerancePx`, multi-touch pinch, pointerup, or pointercancel.
 * @param {{
 *   clock: import("../../ports/clock.js").Clock,
 *   delayMs?: number,
 *   moveTolerancePx?: number,
 *   onLongPress: (info: { point: { x: number, y: number }, pointerId: number }) => void,
 * }} opts
 */
export function createLongPressTracker({
  clock,
  delayMs = LONG_PRESS_MS,
  moveTolerancePx = LONG_PRESS_TOLERANCE_PX,
  onLongPress,
}) {
  /** @type {Set<number>} */
  const activeTouches = new Set();
  /** @type {{ pointerId: number, startX: number, startY: number, point: { x: number, y: number }, timer: any } | null} */
  let armed = null;

  function cancel() {
    if (!armed) return;
    if (armed.timer != null) clock.clear(armed.timer);
    armed = null;
  }

  /**
   * @param {{ pointerType?: string, pointerId?: number, button?: number, isPrimary?: boolean }} e
   * @param {{ x: number, y: number }} point
   */
  function onPointerDown(e, point) {
    if (!e || e.pointerType !== "touch") {
      cancel();
      return;
    }
    const id = typeof e.pointerId === "number" ? e.pointerId : 0;
    activeTouches.add(id);
    if (activeTouches.size > 1 || e.isPrimary === false || (typeof e.button === "number" && e.button !== 0)) {
      cancel();
      return;
    }
    cancel();
    const startX = point.x;
    const startY = point.y;
    const snap = { x: point.x, y: point.y };
    const timer = clock.set(() => {
      if (!armed || armed.pointerId !== id) return;
      const fired = armed;
      armed = null;
      if (activeTouches.size !== 1 || !activeTouches.has(id)) return;
      onLongPress({ point: fired.point, pointerId: id });
    }, delayMs);
    armed = { pointerId: id, startX, startY, point: snap, timer };
  }

  /**
   * @param {{ pointerType?: string, pointerId?: number }} e
   * @param {{ x: number, y: number }} point
   */
  function onPointerMove(e, point) {
    if (!armed) return;
    if (activeTouches.size > 1) {
      cancel();
      return;
    }
    const id = typeof e?.pointerId === "number" ? e.pointerId : 0;
    if (id !== armed.pointerId) return;
    if (Math.hypot(point.x - armed.startX, point.y - armed.startY) >= moveTolerancePx) {
      cancel();
    }
  }

  /** @param {{ pointerType?: string, pointerId?: number }} e */
  function onPointerEnd(e) {
    if (e?.pointerType === "touch") {
      const id = typeof e.pointerId === "number" ? e.pointerId : 0;
      activeTouches.delete(id);
    }
    cancel();
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    cancel,
    isArmed: () => armed !== null,
  };
}

/**
 * Build context-aware selection action items for the mobile bottom sheet.
 * Respects write gating: viewers / read-only users only see non-mutating items (Copy link, Add Comment).
 * @param {{
 *   canWrite: boolean,
 *   canComment: boolean,
 *   selected: any[],
 *   actions: {
 *     duplicate: () => void,
 *     del: () => void,
 *     copyLink: () => void,
 *     group: () => void,
 *     ungroup: () => void,
 *     reorder: (how: "front" | "back") => void,
 *     toggleLock: () => void,
 *     tidy: () => void,
 *     spliceImage: (cols: number, rows: number) => void,
 *     addComment: () => void,
 *   },
 * }} ctx
 * @returns {MobileSelectionAction[]}
 */
export function buildMobileSelectionActions({ canWrite, canComment, selected, actions }) {
  const els = (selected ?? []).filter(e => e && !isLabel(e));
  if (!els.length) return [];

  const canGroup = canWrite && els.length >= 2;
  const canUngroup = canWrite && els.some(e => Array.isArray(e.groupIds) && e.groupIds.length > 0);
  const unlockedCount = els.filter(e => !e.locked).length;
  const canTidy = canWrite && unlockedCount >= 2;
  const allLocked = els.every(e => Boolean(e.locked));
  const canSplice = canWrite && els.length === 1 && els[0].type === "image" && !els[0].locked;
  const isFrame = els.length === 1 && els[0].type === "frame";

  /** @type {MobileSelectionAction[]} */
  const items = [];

  if (canWrite) {
    items.push(
      { id: "duplicate", label: "Duplicate", icon: "duplicate", action: actions.duplicate },
      { id: "delete", label: "Delete", icon: "trash", danger: true, action: actions.del },
    );
    if (canGroup) items.push({ id: "group", label: "Group", icon: "group", action: actions.group });
    if (canUngroup) items.push({ id: "ungroup", label: "Ungroup", icon: "ungroup", action: actions.ungroup });
    if (canTidy) items.push({ id: "tidy", label: "Tidy", icon: "grid", action: actions.tidy });
    if (canSplice) {
      items.push(
        { id: "splice-2x1", label: "Splice 2×1", icon: "grid", action: () => actions.spliceImage(2, 1) },
        { id: "splice-2x2", label: "Splice 2×2", icon: "grid", action: () => actions.spliceImage(2, 2) },
      );
    }
    items.push(
      { id: "bring-front", label: "Bring to Front", icon: "bringFront", action: () => actions.reorder("front") },
      { id: "send-back", label: "Send to Back", icon: "sendBack", action: () => actions.reorder("back") },
      { id: "lock", label: allLocked ? "Unlock" : "Lock", icon: allLocked ? "unlock" : "lock", action: actions.toggleLock },
    );
  }

  items.push({
    id: "copy-link",
    label: isFrame ? "Copy link to frame" : "Copy link to selection",
    icon: "share",
    action: actions.copyLink,
  });

  if (canComment) {
    items.push({ id: "comment", label: "Add Comment", icon: "comments", action: actions.addComment });
  }

  return items;
}

/**
 * Render the Mobile Selection Action Sheet body (44×44px touch rows).
 * @param {{
 *   items: MobileSelectionAction[],
 *   count: number,
 *   onRun: (item: MobileSelectionAction) => void,
 * }} opts
 */
export function renderSelectionActionSheet({ items, count, onRun }) {
  const title = count > 1 ? `${count} elements selected` : "Selection actions";
  return h("div.scroll.mobile-action-sheet", {},
    h("div.mobile-sheet-header", {}, h("h3.mobile-sheet-title", {}, title)),
    h("div.mobile-action-list", { role: "group", "aria-label": title },
      items.map(item => h("button.sheet-action-row" + (item.danger ? ".danger" : ""), {
        type: "button",
        "data-sheet-action": item.id,
        "aria-label": item.label,
        onclick: () => onRun(item),
      },
      h("span.ic", {}, icon(item.icon, { size: 18 })),
      h("span.sheet-action-label", {}, item.label)))));
}

/**
 * Render the Mobile Rename Board Sheet body (16px font input + >= 44px Save/Cancel).
 * @param {{
 *   initialValue: string,
 *   onSave: (value: string) => void,
 *   onCancel: () => void,
 * }} opts
 * @returns {{ root: HTMLElement, input: HTMLInputElement }}
 */
export function renderRenameBoardSheet({ initialValue, onSave, onCancel }) {
  const input = /** @type {HTMLInputElement} */ (h("input.field.mobile-rename-input", {
    type: "text",
    "aria-label": "Board title",
    maxLength: 200,
    placeholder: "Untitled board",
    value: initialValue,
    style: { fontSize: "16px" },
    onkeydown: e => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        onSave(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
  }));

  const root = h("div.scroll.mobile-rename-sheet", {},
    h("div.mobile-sheet-header", {}, h("h3.mobile-sheet-title", {}, "Rename board")),
    h("div.mobile-rename-body", {}, input),
    h("div.mobile-rename-actions", {},
      h("button.btn.mobile-rename-cancel", {
        type: "button",
        "data-action": "rename-cancel",
        onclick: () => onCancel(),
      }, "Cancel"),
      h("button.btn.primary.mobile-rename-save", {
        type: "button",
        "data-action": "rename-save",
        onclick: () => onSave(input.value),
      }, "Save")));

  return { root, input };
}
