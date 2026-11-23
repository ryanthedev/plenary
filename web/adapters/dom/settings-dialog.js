// @ts-check
// Accessible User Settings & Keybindings modal dialog (#116).
// Registered on the unified a11y.js overlay stack (trapFocus, Escape, Tab wrap, focus restoration).
// Two tabs: Preferences (Theme default, Grid default, Stroke style) and Keybindings
// (searchable action list, click-to-capture shortcuts, inline conflict warning, Alt+1..9 frame/view binds, Reset to defaults).

import {
  ACTION_CATALOG,
  DEFAULT_KEYBINDS,
  FRAME_BIND_SLOTS,
  normalizeCombo,
  formatCombo,
  effectiveKeybinds,
  detectKeybindConflict,
} from "../../core/settings.js";
import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { trapFocus } from "./a11y.js";

/**
 * Create a single-instance Settings & Keybindings modal controller.
 * @param {{
 *   host: HTMLElement,
 *   doc?: Document,
 *   getSettings: () => import("../../core/settings.js").UserSettings,
 *   getTargets?: () => { frames: { id: string, name: string }[], views: { id: string, name: string }[] },
 *   onChange: (next: import("../../core/settings.js").UserSettings) => void,
 *   onReset: () => import("../../core/settings.js").UserSettings,
 *   onRestoreFocus?: (opener: any) => void,
 *   onClose?: () => void,
 * }} opts
 */
export function createSettingsDialog({
  host,
  doc = globalThis.document,
  getSettings,
  getTargets = () => ({ frames: [], views: [] }),
  onChange,
  onReset,
  onRestoreFocus = null,
  onClose = null,
}) {
  let openState = false;
  /** @type {"preferences" | "keybindings"} */
  let activeTab = "preferences";
  let query = "";
  /** @type {string | null} */
  let capturingAction = null;
  /** @type {{ action: string, combo: string, conflict: import("../../core/settings.js").KeybindConflict } | null} */
  let pendingConflict = null;
  let veil = null;
  let dialog = null;
  let bodyHost = null;
  let tabsHost = null;
  let trap = null;
  let openerRef = null;
  let captureCleanup = null;

  function stopCapture() {
    capturingAction = null;
    captureCleanup?.();
    captureCleanup = null;
  }

  function isOpen() {
    return openState;
  }

  function close({ restoreFocus = true } = {}) {
    if (!openState) return;
    stopCapture();
    pendingConflict = null;
    openState = false;
    const prevOpener = openerRef;
    openerRef = null;
    trap?.deactivate({ restoreFocus: false });
    trap = null;
    veil?.remove?.();
    veil = null;
    dialog = null;
    bodyHost = null;
    tabsHost = null;
    if (restoreFocus) {
      if (typeof onRestoreFocus === "function") onRestoreFocus(prevOpener);
      else if (prevOpener && prevOpener.isConnected !== false) prevOpener.focus?.();
    }
    onClose?.();
  }

  function commitKeybind(actionId, combo, { force = false } = {}) {
    const cur = getSettings();
    const conflict = detectKeybindConflict(cur.keybinds, actionId, combo, { frameBinds: cur.frameBinds });
    if (conflict && (conflict.kind === "reserved" && conflict.hard || !force)) {
      pendingConflict = { action: actionId, combo, conflict };
      renderBody();
      return;
    }
    const nextKeybinds = { ...cur.keybinds };
    const nextFrameBinds = { ...cur.frameBinds };
    if (conflict && force) {
      if (conflict.kind === "action") {
        // Clear the conflicting action's binding so there are no duplicate triggers.
        nextKeybinds[conflict.action] = "";
      } else if (conflict.kind === "frame") {
        delete nextFrameBinds[conflict.combo];
      }
    }
    if (combo === DEFAULT_KEYBINDS[actionId]) delete nextKeybinds[actionId];
    else nextKeybinds[actionId] = combo;
    pendingConflict = null;
    onChange({ ...cur, keybinds: nextKeybinds, frameBinds: nextFrameBinds });
    renderBody();
  }

  function startCapture(actionId) {
    stopCapture();
    pendingConflict = null;
    capturingAction = actionId;
    const onCaptureKey = e => {
      if (!openState || !capturingAction) return;
      e.preventDefault?.();
      e.stopPropagation?.();
      if (e.key === "Escape") {
        stopCapture();
        renderBody();
        return;
      }
      const combo = normalizeCombo(e);
      if (!combo) return; // Ignore bare modifier presses
      const targetAction = capturingAction;
      stopCapture();
      commitKeybind(targetAction, combo);
    };
    doc?.addEventListener?.("keydown", onCaptureKey, true);
    captureCleanup = () => {
      doc?.removeEventListener?.("keydown", onCaptureKey, true);
    };
    renderBody();
  }

  function switchTab(nextTab) {
    if (activeTab === nextTab) return;
    stopCapture();
    pendingConflict = null;
    activeTab = nextTab;
    renderTabs();
    renderBody();
  }

  function renderTabs() {
    if (!tabsHost) return;
    const tabBtn = (id, label) => {
      const selected = activeTab === id;
      return h("button.settings-tab" + (selected ? ".on" : ""), {
        type: "button",
        id: `settings-tab-${id}`,
        role: "tab",
        "aria-selected": String(selected),
        "aria-controls": `settings-panel-${id}`,
        tabindex: selected ? "0" : "-1",
        "data-settings-tab": id,
        onclick: () => switchTab(id),
        onkeydown: e => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault?.();
            const next = activeTab === "preferences" ? "keybindings" : "preferences";
            switchTab(next);
            const nextBtn = tabsHost?.querySelector?.(`[data-settings-tab="${next}"]`);
            nextBtn?.focus?.();
          }
        },
      }, label);
    };
    replace(tabsHost, tabBtn("preferences", "Preferences"), tabBtn("keybindings", "Keybindings"));
  }

  function renderPreferencesPanel() {
    const cur = getSettings();
    const themeChip = (val, label) => h("button.c" + (cur.defaultTheme === val ? ".on" : ""), {
      type: "button",
      "aria-pressed": String(cur.defaultTheme === val),
      "data-pref-theme": val,
      onclick: () => { onChange({ ...cur, defaultTheme: val }); renderBody(); },
    }, label);

    const roughChip = (val, label) => h("button.c" + (cur.roughDefault === val ? ".on" : ""), {
      type: "button",
      "aria-pressed": String(cur.roughDefault === val),
      "data-pref-rough": String(val),
      onclick: () => { onChange({ ...cur, roughDefault: val }); renderBody(); },
    }, label);

    return h("div.settings-panel", {
      id: "settings-panel-preferences",
      role: "tabpanel",
      "aria-labelledby": "settings-tab-preferences",
    },
    h("div.settings-row", {},
      h("div.settings-row-info", {},
        h("div.settings-row-title", {}, "Default theme"),
        h("div.settings-row-desc", {}, "Choose how Plenary picks light or dark mode when opening a board.")),
      h("div.opts", { role: "group", "aria-label": "Default theme" },
        themeChip("auto", "Auto"),
        themeChip("light", "Light"),
        themeChip("dark", "Dark"))),
    h("div.settings-row", {},
      h("div.settings-row-info", {},
        h("div.settings-row-title", {}, "Snap to grid by default"),
        h("div.settings-row-desc", {}, "Prefer the 20px alignment grid enabled on new boards you create.")),
      h("button.c" + (cur.gridDefault ? ".on" : ""), {
        type: "button",
        role: "switch",
        "aria-checked": String(Boolean(cur.gridDefault)),
        "data-pref-grid": "1",
        onclick: () => { onChange({ ...cur, gridDefault: !cur.gridDefault }); renderBody(); },
      }, cur.gridDefault ? "On" : "Off")),
    h("div.settings-row", {},
      h("div.settings-row-info", {},
        h("div.settings-row-title", {}, "Default stroke style"),
        h("div.settings-row-desc", {}, "Set the default sloppiness for new shapes and connectors.")),
      h("div.opts", { role: "group", "aria-label": "Default stroke style" },
        roughChip(0, "Clean"),
        roughChip(1, "Artist"),
        roughChip(2, "Bold"))));
  }

  function renderKeybindingsPanel() {
    const cur = getSettings();
    const eff = effectiveKeybinds(cur);
    const q = query.trim().toLowerCase();
    const filtered = ACTION_CATALOG.filter(a => {
      if (!q) return true;
      const combo = eff[a.id] ?? "";
      return a.label.toLowerCase().includes(q)
        || a.category.toLowerCase().includes(q)
        || a.id.toLowerCase().includes(q)
        || combo.toLowerCase().includes(q)
        || formatCombo(combo).toLowerCase().includes(q);
    });

    const searchInput = h("input.settings-search", {
      type: "search",
      placeholder: "Filter shortcuts by action or key…",
      "aria-label": "Filter keybindings",
      value: query,
      oninput: e => {
        query = e.target.value;
        renderKeybindList();
      },
      onkeydown: e => {
        if (e.key !== "Escape") e.stopPropagation?.();
      },
    });

    const listHost = h("div.settings-kb-list");
    const conflictHost = h("div.settings-conflict-host");

    function renderConflictBanner() {
      if (!pendingConflict) {
        replace(conflictHost);
        conflictHost.hidden = true;
        return;
      }
      const { action, combo, conflict } = pendingConflict;
      const isHard = conflict.kind === "reserved" && conflict.hard;
      const msg = conflict.kind === "reserved"
        ? isHard
          ? `${formatCombo(combo)} (${combo}) is reserved for "${conflict.label}" and cannot be reassigned.`
          : `${formatCombo(combo)} (${combo}) is a built-in shortcut for "${conflict.label}".`
        : conflict.kind === "action"
          ? `${formatCombo(combo)} (${combo}) is already assigned to "${conflict.label}".`
          : `${formatCombo(combo)} (${combo}) is already bound to a quick-jump frame/view.`;
      replace(conflictHost,
        h("div.settings-conflict", { role: "alert", "data-conflict-action": action },
          h("span.settings-conflict-msg", {}, msg),
          h("div.settings-conflict-acts", {},
            !isHard ? h("button.btn.primary", {
              type: "button",
              "data-action": "force-reassign",
              onclick: () => {
                if (action.startsWith("frameBind:")) {
                  const slot = action.slice("frameBind:".length);
                  const latest = getSettings();
                  const nextKb = { ...latest.keybinds };
                  if (conflict.kind === "action") nextKb[conflict.action] = "";
                  const nextFb = { ...latest.frameBinds, [slot]: combo };
                  pendingConflict = null;
                  onChange({ ...latest, keybinds: nextKb, frameBinds: nextFb });
                  renderBody();
                  return;
                }
                commitKeybind(action, combo, { force: true });
              },
            }, "Reassign anyway") : null,
            h("button.btn", {
              type: "button",
              "data-action": "cancel-conflict",
              onclick: () => { pendingConflict = null; renderConflictBanner(); },
            }, isHard ? "Dismiss" : "Cancel"))));
      conflictHost.hidden = false;
    }

    function renderKeybindList() {
      const latest = getSettings();
      const latestEff = effectiveKeybinds(latest);
      const qNow = query.trim().toLowerCase();
      const items = ACTION_CATALOG.filter(a => {
        if (!qNow) return true;
        const c = latestEff[a.id] ?? "";
        return a.label.toLowerCase().includes(qNow)
          || a.category.toLowerCase().includes(qNow)
          || a.id.toLowerCase().includes(qNow)
          || c.toLowerCase().includes(qNow)
          || formatCombo(c).toLowerCase().includes(qNow);
      });

      if (!items.length) {
        replace(listHost, h("div.hint.settings-empty", {}, "No matching shortcuts."));
        return;
      }

      const rows = items.map(a => {
        const combo = latestEff[a.id] ?? "";
        const isCapturing = capturingAction === a.id;
        const isModified = combo !== a.defaultCombo;
        return h("div.settings-kb-row" + (isCapturing ? ".capturing" : ""), { "data-action-id": a.id },
          h("div.settings-kb-meta", {},
            h("span.settings-kb-label", {}, a.label),
            h("span.settings-kb-cat", {}, a.category)),
          h("div.settings-kb-controls", {},
            h("button.settings-kb-btn" + (isCapturing ? ".on" : ""), {
              type: "button",
              "data-capture-action": a.id,
              "aria-label": isCapturing ? `Press new shortcut for ${a.label}` : `Change shortcut for ${a.label}`,
              onclick: () => {
                if (isCapturing) { stopCapture(); renderBody(); }
                else startCapture(a.id);
              },
            }, isCapturing ? "Press keys…" : (combo ? formatCombo(combo) : "Unbound")),
            isModified ? h("button.tb.settings-kb-reset", {
              type: "button",
              title: `Reset to ${formatCombo(a.defaultCombo)}`,
              "aria-label": `Reset ${a.label} to default`,
              "data-reset-action": a.id,
              onclick: () => {
                stopCapture();
                pendingConflict = null;
                commitKeybind(a.id, a.defaultCombo);
              },
            }, icon("close", { size: 13 })) : null));
      });
      replace(listHost, rows);
    }

    renderConflictBanner();
    renderKeybindList();

    // Frame / View quick-jump slots (Alt+1 .. Alt+9)
    const { frames = [], views = [] } = getTargets() ?? {};
    const knownValues = new Set([
      ...frames.map(f => `frame:${f.id}`),
      ...views.map(v => `view:${v.id}`),
    ]);
    const hasAnyBound = FRAME_BIND_SLOTS.some(slot => Boolean(cur.frameBinds?.[slot]));
    const hasTargets = frames.length > 0 || views.length > 0 || hasAnyBound;
    const frameBindSection = h("div.settings-frame-binds", {},
      h("div.settings-sec-head", {}, "Quick-jump frame & view shortcuts (Alt+1 – Alt+9)"),
      hasTargets
        ? h("div.settings-fb-list", {}, FRAME_BIND_SLOTS.map(slot => {
            const bound = cur.frameBinds?.[slot] ?? "";
            const isForeign = Boolean(bound) && !knownValues.has(bound);
            const sel = h("select.settings-fb-select", {
              "aria-label": `Target for ${slot}`,
              "data-frame-bind-slot": slot,
              onchange: e => {
                const val = e.target.value;
                const latest = getSettings();
                if (val) {
                  const conflict = detectKeybindConflict(latest.keybinds, `frameBind:${slot}`, slot, { frameBinds: latest.frameBinds });
                  if (conflict) {
                    pendingConflict = { action: `frameBind:${slot}`, combo: val, conflict };
                    renderBody();
                    return;
                  }
                }
                const nextFb = { ...latest.frameBinds };
                if (val) nextFb[slot] = val;
                else delete nextFb[slot];
                pendingConflict = null;
                onChange({ ...latest, frameBinds: nextFb });
                renderBody();
              },
            },
            h("option", { value: "", selected: !bound }, "— None —"),
            isForeign ? h("option", { value: bound, selected: true }, `(Other board: ${bound})`) : null,
            ...frames.map(f => h("option", { value: `frame:${f.id}`, selected: bound === `frame:${f.id}` }, `Frame: ${f.name}`)),
            ...views.map(v => h("option", { value: `view:${v.id}`, selected: bound === `view:${v.id}` }, `View: ${v.name}`)));
            return h("div.settings-fb-row", {},
              h("kbd.settings-kbd", {}, formatCombo(slot)),
              sel);
          }))
        : h("div.hint", {}, "Add a named frame or saved view on this board to assign Alt+1 – Alt+9 quick-jump shortcuts."));

    return h("div.settings-panel", {
      id: "settings-panel-keybindings",
      role: "tabpanel",
      "aria-labelledby": "settings-tab-keybindings",
    },
    h("div.settings-search-wrap", {}, searchInput),
    conflictHost,
    listHost,
    frameBindSection);
  }

  const FOCUS_ATTRS = ["data-pref-theme", "data-pref-grid", "data-pref-rough", "data-capture-action", "data-reset-action", "data-frame-bind-slot", "data-action"];

  function captureBodyFocus() {
    const active = doc?.activeElement;
    if (!active || !bodyHost?.contains?.(active)) return null;
    for (const attr of FOCUS_ATTRS) {
      const val = active.getAttribute?.(attr);
      if (val != null) return { attr, val };
    }
    return null;
  }

  function findByAttr(root, attr, val) {
    if (!root) return null;
    if (typeof root.all === "function") return root.all().find(e => e.getAttribute?.(attr) === val) ?? null;
    const visit = node => {
      for (const child of node?.children ?? []) {
        if (child.getAttribute?.(attr) === val) return child;
        const hit = visit(child);
        if (hit) return hit;
      }
      return null;
    };
    return visit(root);
  }

  function renderBody() {
    if (!openState || !bodyHost) return;
    const saved = captureBodyFocus();
    replace(bodyHost, activeTab === "preferences" ? renderPreferencesPanel() : renderKeybindingsPanel());
    if (saved) {
      const twin = findByAttr(bodyHost, saved.attr, saved.val);
      if (twin) twin.focus?.();
      else dialog?.focus?.();
    }
  }

  /**
   * Open the Settings & Keybindings modal.
   * @param {{ opener?: any, tab?: "preferences" | "keybindings" }} [opts]
   */
  function open({ opener = null, tab = "preferences" } = {}) {
    if (openState) close({ restoreFocus: false });
    openState = true;
    activeTab = tab === "keybindings" ? "keybindings" : "preferences";
    query = "";
    pendingConflict = null;
    stopCapture();
    openerRef = opener;

    tabsHost = h("div.settings-tabs", { role: "tablist", "aria-label": "Settings sections" });
    bodyHost = h("div.dbody.settings-body");

    dialog = h("div.dialog.settings-modal", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "settings-dialog-title",
      tabindex: "-1",
    },
    h("h2", { id: "settings-dialog-title" },
      icon("settings", { size: 17 }),
      " Settings & keybindings",
      h("span.spacer"),
      h("button.tb", {
        type: "button",
        title: "Close (Esc)",
        "aria-label": "Close settings",
        onclick: () => close({ restoreFocus: true }),
      }, icon("close", { size: 16 }))),
    tabsHost,
    bodyHost,
    h("footer.settings-footer", {},
      h("button.btn", {
        type: "button",
        "data-action": "reset-settings",
        onclick: () => {
          stopCapture();
          pendingConflict = null;
          onReset();
          renderBody();
        },
      }, "Reset to defaults"),
      h("button.btn.primary", {
        type: "button",
        "data-action": "close-settings",
        onclick: () => close({ restoreFocus: true }),
      }, "Done")));

    veil = h("div.dialog-veil.settings-veil", {
      onclick: e => { if (e.target === e.currentTarget) close({ restoreFocus: true }); },
    }, dialog);

    host.append(veil);
    renderTabs();
    renderBody();

    const initialTab = tabsHost.querySelector?.(`[data-settings-tab="${activeTab}"]`) ?? dialog;
    trap = trapFocus(dialog, {
      onEscape: () => {
        if (capturingAction) {
          stopCapture();
          renderBody();
          return;
        }
        close({ restoreFocus: true });
      },
      returnFocusTo: null,
      initialFocus: initialTab,
      focusOnActivate: true,
      doc,
    });
    return dialog;
  }

  function refresh() {
    if (!openState) return;
    renderBody();
  }

  return { open, close, isOpen, refresh };
}
