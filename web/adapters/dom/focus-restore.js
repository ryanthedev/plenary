// @ts-check
/**
 * @module web/adapters/dom/focus-restore
 * Dialog and sheet opener capture and cross-viewport restoration.
 *
 * Kept intentionally separate from `web/adapters/dom/focus.js` (which is source-guarded against
 * `aria-label` matching for `data-fk` list controls): dialog openers legitimately move between
 * desktop `#topbar` and mobile `#dock` across viewport resizes and need `aria-label` twin lookup.
 */

/**
 * Return true if `el` is currently visible, enabled, and active at the current viewport size.
 * @param {any} el
 * @param {{ isPhone?: () => boolean }} [o]
 * @returns {boolean}
 */
export function isVisibleControl(el, { isPhone = () => false } = {}) {
  if (!el || el.hidden || el.disabled) return false;
  if (el.getAttribute?.("aria-hidden") === "true") return false;
  if (el.style?.display === "none" || el.style?.visibility === "hidden") return false;
  if ("offsetParent" in el && el.offsetParent === null) return false;
  if (isPhone() && (el.classList?.contains("header-more") || el.classList?.contains("desk-only"))) return false;
  if (!isPhone() && el.classList?.contains("phone-only")) return false;
  return true;
}

/**
 * Capture a dialog/sheet opener element along with its `aria-label` and host region so focus
 * can return across chrome rebuilds or responsive desktop/mobile transitions.
 * @param {any} [el]
 * @param {{ doc?: Document | null }} [o]
 * @returns {{ el: any, label: string | null, rootId: "dock" | "topbar" | "hudBL" | null, dockMore: boolean } | null}
 */
export function captureOpener(el = null, { doc = null } = {}) {
  const d = doc ?? globalThis.document;
  const target = el ?? d?.activeElement ?? null;
  if (!target || target === d?.body || target === d?.documentElement || target.isConnected === false) return null;
  if (d?.body?.contains && !d.body.contains(target)) return null;
  const q = sel => d?.querySelector?.(sel) ?? null;
  const rootId = q("#dock")?.contains?.(target) ? "dock"
    : q("#topbar")?.contains?.(target) ? "topbar"
    : q("#hudBL")?.contains?.(target) ? "hudBL"
    : null;
  return {
    el: target,
    label: target.getAttribute?.("aria-label") ?? null,
    rootId,
    dockMore: Boolean(target.getAttribute?.("data-dock-more")),
  };
}

/**
 * Search visible controls by `aria-label`, preferring `preferredRootId` then current viewport order.
 * @param {string | null | undefined} label
 * @param {string | null} [preferredRootId]
 * @param {{ doc?: Document | null, isPhone?: () => boolean }} [o]
 * @returns {any}
 */
export function findByAriaLabel(label, preferredRootId = null, { doc = null, isPhone = () => false } = {}) {
  if (!label) return null;
  const d = doc ?? globalThis.document;
  const q = sel => d?.querySelector?.(sel) ?? null;
  const visit = node => {
    for (const child of node?.children ?? []) {
      if (child.getAttribute?.("aria-label") === label && isVisibleControl(child, { isPhone })) return child;
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const roots = [];
  if (preferredRootId) roots.push(q(`#${preferredRootId}`));
  if (isPhone()) roots.push(q("#dock"), q("#topbar"), d?.body ?? null);
  else roots.push(q("#topbar"), q("#dock"), d?.body ?? null);
  for (const r of roots) {
    if (!r) continue;
    const hit = visit(r);
    if (hit) return hit;
  }
  return null;
}

/**
 * Restore focus to a previously captured opener, falling back through `[data-dock-more]`,
 * `aria-label` twin lookup, and finally `fallback` (e.g. `#board`).
 * @param {{ el?: any, label?: string | null, rootId?: string | null, dockMore?: boolean } | null | undefined} saved
 * @param {any} [fallback]
 * @param {{ doc?: Document | null, isPhone?: () => boolean }} [o]
 */
export function restoreOpener(saved, fallback = null, { doc = null, isPhone = () => false } = {}) {
  const d = doc ?? globalThis.document;
  if (saved?.el && saved.el.isConnected !== false && (!d?.body?.contains || d.body.contains(saved.el)) && isVisibleControl(saved.el, { isPhone })) {
    saved.el.focus?.();
    return;
  }
  if (saved?.dockMore) {
    const dockMore = /** @type {HTMLElement | null} */ (d?.querySelector?.("[data-dock-more]") ?? null);
    if (dockMore && isVisibleControl(dockMore, { isPhone })) {
      dockMore.focus?.();
      return;
    }
  }
  const twin = findByAriaLabel(saved?.label, saved?.rootId ?? null, { doc: d, isPhone });
  if (twin) {
    twin.focus?.();
    return;
  }
  fallback?.focus?.();
}

/**
 * Pick the first visible control matching `selectors`, or the first existing match if none are visible.
 * @param {string[]} selectors
 * @param {{ doc?: Document | null, isPhone?: () => boolean }} [o]
 * @returns {any}
 */
export function visibleControl(selectors, { doc = null, isPhone = () => false } = {}) {
  const d = doc ?? globalThis.document;
  const c = selectors.map(q => d?.querySelector?.(q) ?? null);
  return c.find(e => e && isVisibleControl(e, { isPhone })) ?? c.find(Boolean) ?? null;
}

/**
 * Bind `isPhone`, `doc`, and `defaultFallback` for `app.js` opener capture/restore call sites.
 * @param {{ isPhone?: () => boolean, doc?: Document | null, defaultFallback?: any }} [o]
 */
export function createFocusRestorer({ isPhone = () => false, doc = null, defaultFallback = null } = {}) {
  return {
    isVisibleControl: el => isVisibleControl(el, { isPhone }),
    captureOpener: (el = null) => captureOpener(el, { doc }),
    findByAriaLabel: (label, preferredRootId = null) => findByAriaLabel(label, preferredRootId, { doc, isPhone }),
    restoreOpener: (saved, fallback = defaultFallback) => restoreOpener(saved, fallback, { doc, isPhone }),
    visibleControl: selectors => visibleControl(selectors, { doc, isPhone }),
  };
}
