// @ts-check
// Reusable accessibility helpers for dialogs and bottom sheets (part of the dom adapter group).
// Provides focusable-element discovery, modal focus trapping (Tab / Shift+Tab wrapping, Escape-to-close,
// and focus restoration to the triggering control), working in both real browsers and headless DOM stubs.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const FOCUSABLE_TAG = /^(BUTTON|INPUT|SELECT|TEXTAREA)$/;

function attrOf(el, name) {
  if (!el) return null;
  if (typeof el.getAttribute === "function") return el.getAttribute(name);
  return el.attrs?.[name] ?? null;
}

function isHiddenOrDisabled(el, root) {
  for (let x = el; x && x !== root; x = x.parentNode ?? null) {
    if (x.hidden) return true;
    if (attrOf(x, "hidden") !== null) return true;
    if (attrOf(x, "aria-hidden") === "true") return true;
    if (x.style?.display === "none" || x.style?.visibility === "hidden") return true;
  }
  if (el.disabled) return true;
  if (attrOf(el, "disabled") !== null) return true;
  if (el.tagName === "INPUT" && (el.type === "hidden" || attrOf(el, "type") === "hidden")) return true;
  const ti = attrOf(el, "tabindex");
  if (ti !== null && Number(ti) < 0) return true;
  return false;
}

function collectFallback(container) {
  const out = [];
  const visit = node => {
    for (const child of node?.children ?? []) {
      const tag = typeof child.tagName === "string" ? child.tagName.toUpperCase() : "";
      const ti = attrOf(child, "tabindex");
      const isLink = tag === "A" && attrOf(child, "href") !== null;
      const isTabbable = ti !== null && Number(ti) >= 0;
      if (FOCUSABLE_TAG.test(tag) || isLink || isTabbable) out.push(child);
      visit(child);
    }
  };
  visit(container);
  return out;
}

/**
 * Return all visible, enabled, tabbable elements inside `container` in DOM order.
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function getFocusableElements(container) {
  if (!container) return [];
  const raw = typeof container.querySelectorAll === "function"
    ? [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
    : collectFallback(container);
  return raw.filter(el => !isHiddenOrDisabled(el, container));
}

/**
 * Return the accessible name of an interactive element (`aria-label`, `aria-labelledby`, or textContent).
 * @param {HTMLElement} el
 * @param {Document} [doc]
 * @returns {string}
 */
export function accessibleName(el, doc = globalThis.document) {
  if (!el) return "";
  const ariaLabel = attrOf(el, "aria-label")?.trim();
  if (ariaLabel) return ariaLabel;
  const labelledBy = attrOf(el, "aria-labelledby")?.trim();
  if (labelledBy && doc) {
    const findById = id => {
      if (typeof doc.getElementById === "function") return doc.getElementById(id);
      if (typeof doc.querySelector === "function") {
        try {
          const escaped = typeof globalThis.CSS?.escape === "function"
            ? `#${globalThis.CSS.escape(id)}`
            : `[id="${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
          return doc.querySelector(escaped);
        } catch {
          return null;
        }
      }
      return null;
    };
    const text = labelledBy
      .split(/\s+/)
      .map(id => findById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  return (el.textContent ?? "").trim();
}

/**
 * Create a focus trap for a modal dialog or bottom sheet.
 * - Saves `previousFocus` on activation (or uses `returnFocusTo`).
 * - Moves focus into the container (unless `focusOnActivate` is false).
 * - Traps Tab and Shift+Tab inside `container`.
 * - Calls `onEscape()` when Escape is pressed.
 * - Restores focus to `previousFocus` on `deactivate()` (unless `restoreFocus: false`).
 *
 * @param {HTMLElement} container
 * @param {{
 *   onEscape?: () => void,
 *   returnFocusTo?: { focus?: () => void, isConnected?: boolean } | null,
 *   initialFocus?: { focus?: () => void } | null,
 *   focusOnActivate?: boolean,
 *   doc?: Document | null,
 * }} [options]
 */
export function createFocusTrap(container, {
  onEscape = null,
  returnFocusTo = undefined,
  initialFocus = null,
  focusOnActivate = true,
  doc = globalThis.document ?? null,
} = {}) {
  let active = false;
  let previousFocus = null;
  const handled = new WeakSet();

  const onKeyDown = e => {
    if (!active || !e) return;
    if (typeof e === "object" && handled.has(e)) return;
    if (typeof e === "object") handled.add(e);

    if (e.key === "Escape") {
      e.preventDefault?.();
      e.stopPropagation?.();
      onEscape?.();
      return;
    }
    if (e.key !== "Tab") return;

    const list = getFocusableElements(container);
    if (!list.length) {
      e.preventDefault?.();
      container?.focus?.();
      return;
    }
    const current = /** @type {HTMLElement | null} */ (doc?.activeElement ?? null);
    const index = list.indexOf(current);
    if (e.shiftKey) {
      if (index <= 0) {
        e.preventDefault?.();
        list[list.length - 1]?.focus?.();
      }
    } else if (index === list.length - 1 || index < 0) {
      e.preventDefault?.();
      list[0]?.focus?.();
    }
  };

  function activate() {
    if (active || !container) return;
    active = true;
    previousFocus = returnFocusTo !== undefined ? returnFocusTo : (doc?.activeElement ?? null);
    if (attrOf(container, "tabindex") === null) container.setAttribute?.("tabindex", "-1");
    container.addEventListener?.("keydown", onKeyDown);
    doc?.addEventListener?.("keydown", onKeyDown);
    if (focusOnActivate) {
      const target = initialFocus ?? getFocusableElements(container)[0] ?? container;
      target?.focus?.();
    }
  }

  function deactivate({ restoreFocus = true } = {}) {
    if (!active) return;
    active = false;
    container?.removeEventListener?.("keydown", onKeyDown);
    doc?.removeEventListener?.("keydown", onKeyDown);
    if (restoreFocus && previousFocus && previousFocus.isConnected !== false) {
      previousFocus.focus?.();
    }
    previousFocus = null;
  }

  return {
    activate,
    deactivate,
    handleKeyDown: onKeyDown,
    isActive: () => active,
    getFocusable: () => getFocusableElements(container),
  };
}

/**
 * Create and immediately activate a focus trap on `container`.
 * @param {HTMLElement} container
 * @param {Parameters<typeof createFocusTrap>[1]} [options]
 */
export function trapFocus(container, options = {}) {
  const trap = createFocusTrap(container, options);
  trap.activate();
  return trap;
}
