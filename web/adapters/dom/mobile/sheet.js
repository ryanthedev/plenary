// @ts-check
// Standardized 2-detent mobile bottom sheets ("half" / "full") + <640px comment sheet router.
// Part of the dom adapter group:
// - Grabber drag to resize between "half" and "full" detents or swipe down to dismiss
// - Keyboard-safe sticky footer that tracks visualViewport height/offset
// - Focus capture, Tab/Shift+Tab trapping, Escape/backdrop dismissal, and focus restoration via ../a11y.js
// - Helper to route <640px comment thread views & composers into a Full Sheet.

import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { createFocusTrap } from "../a11y.js";

export const MOBILE_BREAKPOINT_PX = 640;
export const SHEET_DETENTS = Object.freeze({ half: 0.5, full: 0.94 });
const DRAG_SNAP_PX = 56;
const DRAG_DISMISS_PX = 96;

let sheetSeq = 0;

/**
 * @typedef {"half" | "full"} SheetDetent
 */

/**
 * Return true when the active viewport is narrow mobile (`< 640px`).
 * @param {any} [win]
 * @returns {boolean}
 */
export function isMobileViewport(win = globalThis.window ?? globalThis) {
  if (typeof win?.matchMedia === "function") {
    try {
      const m = win.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
      if (m && typeof m.matches === "boolean") return m.matches;
    } catch {
      // fall through to innerWidth check
    }
  }
  if (typeof win?.innerWidth === "number") return win.innerWidth < MOBILE_BREAKPOINT_PX;
  return false;
}

/**
 * Create a standardized 2-detent bottom sheet (`half` / `full`).
 *
 * @param {{
 *   host: HTMLElement,
 *   title: string,
 *   subtitle?: string | null,
 *   kind?: string,
 *   initialDetent?: SheetDetent,
 *   allowDetents?: SheetDetent[],
 *   body?: any,
 *   footer?: any,
 *   onClose?: (info: { reason: string }) => void,
 *   onDetentChange?: (detent: SheetDetent) => void,
 *   returnFocusTo?: any,
 *   doc?: Document | null,
 *   win?: any,
 *   id?: string,
 * }} opts
 */
export function createBottomSheet({
  host,
  title,
  subtitle = null,
  kind = "sheet",
  initialDetent = "half",
  allowDetents = ["half", "full"],
  body = null,
  footer = null,
  onClose = null,
  onDetentChange = null,
  returnFocusTo = undefined,
  doc = globalThis.document ?? null,
  win = globalThis.window ?? globalThis,
  id = `mp2-sheet-${++sheetSeq}`,
}) {
  const allowed = allowDetents.length ? [...new Set(allowDetents)] : /** @type {SheetDetent[]} */ (["half", "full"]);
  /** @type {SheetDetent} */
  let detent = allowed.includes(initialDetent) ? initialDetent : allowed[0];
  let opened = false;
  let destroyed = false;
  /** @type {ReturnType<typeof createFocusTrap> | null} */
  let trap = null;
  /** @type {{ pointerId: number, startY: number, lastY: number } | null} */
  let drag = null;

  const titleId = `${id}-title`;
  const titleEl = h("h2.mp2-sheet-title", { id: titleId }, title);
  const subtitleEl = h("p.mp2-sheet-subtitle", { hidden: !subtitle }, subtitle ?? "");

  const grabber = h("button.mp2-sheet-grabber", {
    type: "button",
    "aria-label": detent === "full" ? "Collapse sheet to half height" : "Expand sheet to full height",
    "aria-expanded": String(detent === "full"),
    "data-sheet-grabber": "",
    onclick: () => {
      if (allowed.length < 2) return;
      setDetent(detent === "full" ? "half" : "full");
    },
    onpointerdown: e => {
      if (e.button && e.button !== 0) return;
      drag = {
        pointerId: typeof e.pointerId === "number" ? e.pointerId : 0,
        startY: typeof e.clientY === "number" ? e.clientY : 0,
        lastY: typeof e.clientY === "number" ? e.clientY : 0,
      };
      grabber.setPointerCapture?.(drag.pointerId);
      el.classList.add("dragging");
    },
    onpointermove: e => {
      if (!drag) return;
      const pid = typeof e.pointerId === "number" ? e.pointerId : 0;
      if (pid !== drag.pointerId) return;
      drag.lastY = typeof e.clientY === "number" ? e.clientY : drag.lastY;
      const dy = drag.lastY - drag.startY;
      el.style.setProperty("--sheet-drag-y", `${Math.max(-80, dy)}px`);
    },
    onpointerup: e => finishDrag(e),
    onpointercancel: () => cancelDrag(),
  }, h("span.mp2-sheet-grabber-pill", { "aria-hidden": "true" }));

  const closeBtn = h("button.mp2-sheet-close", {
    type: "button",
    "aria-label": `Close ${title}`,
    "data-sheet-close": "",
    onclick: () => close("close-button"),
  }, icon("close", { size: 18 }));

  const headerEl = h("div.mp2-sheet-header", {},
    h("div.mp2-sheet-heading", {}, titleEl, subtitleEl),
    closeBtn);

  const bodyEl = h("div.mp2-sheet-body", {}, body);
  const footerEl = h("div.mp2-sheet-footer", { hidden: footer == null }, footer);

  const backdrop = h("div.mp2-sheet-backdrop", {
    hidden: true,
    "aria-hidden": "true",
    "data-sheet-backdrop": kind,
    onclick: () => close("backdrop"),
  });

  const el = h("div.mp2-sheet", {
    id,
    hidden: true,
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": titleId,
    "data-sheet-kind": kind,
    "data-detent": detent,
    tabindex: "-1",
  }, grabber, headerEl, bodyEl, footerEl);

  function cancelDrag() {
    if (!drag) return;
    drag = null;
    el.classList.remove("dragging");
    el.style.setProperty("--sheet-drag-y", "0px");
  }

  function finishDrag(e) {
    if (!drag) return;
    const pid = typeof e?.pointerId === "number" ? e.pointerId : drag.pointerId;
    if (pid !== drag.pointerId) return;
    const endY = typeof e?.clientY === "number" ? e.clientY : drag.lastY;
    const dy = endY - drag.startY;
    cancelDrag();

    if (dy <= -DRAG_SNAP_PX && allowed.includes("full")) {
      setDetent("full");
    } else if (dy >= DRAG_DISMISS_PX && (detent === "half" || !allowed.includes("half"))) {
      close("drag");
    } else if (dy >= DRAG_SNAP_PX && detent === "full" && allowed.includes("half")) {
      setDetent("half");
    }
  }

  function syncKeyboardInset() {
    const vv = win?.visualViewport;
    if (!vv || typeof vv.height !== "number") {
      el.style.setProperty("--kb-inset", "0px");
      return;
    }
    const layoutH = typeof win?.innerHeight === "number" && win.innerHeight > 0 ? win.innerHeight : vv.height;
    const offsetTop = typeof vv.offsetTop === "number" ? vv.offsetTop : 0;
    const inset = Math.max(0, Math.round(layoutH - vv.height - offsetTop));
    el.style.setProperty("--kb-inset", `${inset}px`);
    el.classList.toggle("kb-open", inset > 80);
  }

  function attachViewportListener() {
    const vv = win?.visualViewport;
    if (!vv || typeof vv.addEventListener !== "function") return;
    vv.addEventListener("resize", syncKeyboardInset);
    vv.addEventListener("scroll", syncKeyboardInset);
    syncKeyboardInset();
  }

  function detachViewportListener() {
    const vv = win?.visualViewport;
    if (!vv || typeof vv.removeEventListener !== "function") return;
    vv.removeEventListener("resize", syncKeyboardInset);
    vv.removeEventListener("scroll", syncKeyboardInset);
  }

  /** @param {SheetDetent} next */
  function setDetent(next) {
    if (!allowed.includes(next)) return detent;
    if (detent === next) return detent;
    detent = next;
    el.setAttribute("data-detent", detent);
    el.style.setProperty("--sheet-height", `${Math.round(SHEET_DETENTS[detent] * 100)}dvh`);
    grabber.setAttribute("aria-expanded", String(detent === "full"));
    grabber.setAttribute("aria-label", detent === "full" ? "Collapse sheet to half height" : "Expand sheet to full height");
    onDetentChange?.(detent);
    return detent;
  }

  /** @param {{ detent?: SheetDetent, returnFocusTo?: any, initialFocus?: any }} [openOpts] */
  function open(openOpts = {}) {
    if (destroyed) return;
    if (openOpts.detent && allowed.includes(openOpts.detent)) {
      detent = openOpts.detent;
    }
    el.setAttribute("data-detent", detent);
    el.style.setProperty("--sheet-height", `${Math.round(SHEET_DETENTS[detent] * 100)}dvh`);
    grabber.setAttribute("aria-expanded", String(detent === "full"));
    grabber.setAttribute("aria-label", detent === "full" ? "Collapse sheet to half height" : "Expand sheet to full height");

    if (backdrop.parentNode !== host) host.append(backdrop);
    if (el.parentNode !== host) host.append(el);
    backdrop.hidden = false;
    el.hidden = false;
    opened = true;
    attachViewportListener();

    trap?.deactivate({ restoreFocus: false });
    trap = createFocusTrap(el, {
      doc,
      returnFocusTo: openOpts.returnFocusTo !== undefined ? openOpts.returnFocusTo : returnFocusTo,
      initialFocus: openOpts.initialFocus ?? null,
      onEscape: () => close("escape"),
    });
    trap.activate();
  }

  /** @param {string} [reason] */
  function close(reason = "programmatic") {
    if (!opened) return;
    opened = false;
    cancelDrag();
    detachViewportListener();
    backdrop.hidden = true;
    el.hidden = true;
    const activeTrap = trap;
    trap = null;
    activeTrap?.deactivate({ restoreFocus: true });
    onClose?.({ reason });
  }

  function destroy() {
    if (destroyed) return;
    close("destroy");
    destroyed = true;
    backdrop.remove();
    el.remove();
  }

  return {
    open,
    close,
    destroy,
    setDetent,
    getDetent: () => detent,
    isOpen: () => opened,
    setTitle(nextTitle, nextSubtitle = undefined) {
      titleEl.textContent = nextTitle;
      closeBtn.setAttribute("aria-label", `Close ${nextTitle}`);
      if (nextSubtitle !== undefined) {
        subtitleEl.textContent = nextSubtitle ?? "";
        subtitleEl.hidden = !nextSubtitle;
      }
    },
    setBody(...nodes) {
      replace(bodyEl, ...nodes);
    },
    setFooter(...nodes) {
      const flat = nodes.flat(Infinity).filter(n => n != null && n !== false);
      footerEl.hidden = flat.length === 0;
      replace(footerEl, ...flat);
    },
    el,
    backdrop,
    grabber,
    closeBtn,
    bodyEl,
    footerEl,
  };
}

/**
 * Route `<640px` comment thread views & composers into a standardized Full Sheet (`data-detent="full"`),
 * with the reply/new-comment composer pinned in the keyboard-safe footer.
 * On `>=640px` viewports, delegates directly to the desktop handlers.
 *
 * @param {{
 *   host: HTMLElement,
 *   isMobile?: () => boolean,
 *   openDesktopThread?: (thread: any, opts?: any) => any,
 *   openDesktopComposer?: (anchor: any, opts?: any) => any,
 *   renderThread?: (thread: any, ctx: { close: () => void }) => { title?: string, subtitle?: string, body: any, footer?: any },
 *   renderComposer?: (anchor: any, ctx: { close: () => void }) => { title?: string, subtitle?: string, body: any, footer?: any },
 *   onClose?: (info: { reason: string, kind: "comment-thread" | "comment-composer" }) => void,
 *   doc?: Document | null,
 *   win?: any,
 * }} opts
 */
export function createMobileCommentSheetRouter({
  host,
  isMobile = () => isMobileViewport(win),
  openDesktopThread = () => null,
  openDesktopComposer = () => null,
  renderThread = null,
  renderComposer = null,
  onClose = null,
  doc = globalThis.document ?? null,
  win = globalThis.window ?? globalThis,
}) {
  /** @type {ReturnType<typeof createBottomSheet> | null} */
  let activeSheet = null;
  /** @type {"comment-thread" | "comment-composer" | null} */
  let activeKind = null;

  function close() {
    if (!activeSheet) return;
    const s = activeSheet;
    activeSheet = null;
    activeKind = null;
    s.destroy();
  }

  function defaultThreadView(thread) {
    const msgs = Array.isArray(thread?.messages) ? thread.messages : [];
    const list = h("div.mp2-comment-messages", { role: "list", "aria-label": "Comment messages" },
      msgs.map(m => h("article.mp2-comment-msg", { role: "listitem" },
        h("div.mp2-comment-meta", {}, h("strong", {}, m.author ?? m.user ?? "Someone")),
        h("p.mp2-comment-text", {}, m.text ?? m.body ?? ""))));
    const input = h("textarea.mp2-comment-input", {
      rows: 2,
      "aria-label": "Reply to comment thread",
      placeholder: "Write a reply…",
      style: { fontSize: "16px" },
    });
    const sendBtn = h("button.btn.primary.mp2-comment-send", {
      type: "button",
      "aria-label": "Send reply",
    }, "Reply");
    return {
      title: thread?.title ?? "Comment thread",
      subtitle: `${msgs.length} ${msgs.length === 1 ? "message" : "messages"}`,
      body: list,
      footer: h("div.mp2-comment-composer", {}, input, sendBtn),
    };
  }

  function defaultComposerView(anchor) {
    const input = h("textarea.mp2-comment-input", {
      rows: 3,
      "aria-label": "New comment",
      placeholder: "Add a comment…",
      style: { fontSize: "16px" },
    });
    const postBtn = h("button.btn.primary.mp2-comment-send", {
      type: "button",
      "aria-label": "Post comment",
    }, "Post");
    return {
      title: "New comment",
      subtitle: anchor?.label ?? null,
      body: h("div.mp2-comment-anchor-note", {}, anchor?.label ? `Anchored to ${anchor.label}` : "Anchored on board"),
      footer: h("div.mp2-comment-composer", {}, input, postBtn),
    };
  }

  /**
   * @param {any} thread
   * @param {{ returnFocusTo?: any }} [opts]
   */
  function openThread(thread, opts = {}) {
    if (!isMobile()) return openDesktopThread(thread, opts);
    close();
    const kind = "comment-thread";
    const view = renderThread ? renderThread(thread, { close }) : defaultThreadView(thread);
    const sheet = createBottomSheet({
      host,
      title: view.title ?? "Comment thread",
      subtitle: view.subtitle ?? null,
      kind,
      initialDetent: "full",
      allowDetents: ["half", "full"],
      body: view.body,
      footer: view.footer ?? null,
      returnFocusTo: opts.returnFocusTo,
      doc,
      win,
      onClose: info => {
        if (activeSheet === sheet) {
          activeSheet = null;
          activeKind = null;
        }
        if (info.reason !== "destroy") {
          sheet.destroy();
          onClose?.({ reason: info.reason, kind });
        }
      },
    });
    activeSheet = sheet;
    activeKind = kind;
    sheet.open({ detent: "full", returnFocusTo: opts.returnFocusTo });
    return sheet;
  }

  /**
   * @param {any} anchor
   * @param {{ returnFocusTo?: any }} [opts]
   */
  function openComposer(anchor, opts = {}) {
    if (!isMobile()) return openDesktopComposer(anchor, opts);
    close();
    const kind = "comment-composer";
    const view = renderComposer ? renderComposer(anchor, { close }) : defaultComposerView(anchor);
    const sheet = createBottomSheet({
      host,
      title: view.title ?? "New comment",
      subtitle: view.subtitle ?? null,
      kind,
      initialDetent: "full",
      allowDetents: ["half", "full"],
      body: view.body,
      footer: view.footer ?? null,
      returnFocusTo: opts.returnFocusTo,
      doc,
      win,
      onClose: info => {
        if (activeSheet === sheet) {
          activeSheet = null;
          activeKind = null;
        }
        if (info.reason !== "destroy") {
          sheet.destroy();
          onClose?.({ reason: info.reason, kind });
        }
      },
    });
    activeSheet = sheet;
    activeKind = kind;
    sheet.open({ detent: "full", returnFocusTo: opts.returnFocusTo });
    return sheet;
  }

  return {
    openThread,
    openComposer,
    close,
    isOpen: () => Boolean(activeSheet?.isOpen()),
    currentSheet: () => activeSheet,
    currentKind: () => activeKind,
  };
}
