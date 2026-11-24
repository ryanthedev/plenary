// @ts-check
// Accessible In-App Help & Shortcuts modal dialog (M3).
// Registered on the unified a11y.js overlay stack (trapFocus, Escape, Tab wrap, focus restoration).
// Uses only h(), replace(), classList.toggle(), setAttribute(), getAttribute(), and textContent
// so it works identically in real browsers, test/web/stub-page.js, and test/web/collab/fake-dom.js.

import {
  ACTION_CATALOG,
  FRAME_BIND_SLOTS,
  effectiveKeybinds,
  formatCombo,
} from "../../core/settings.js";
import { TOOLS } from "../../../packages/core/editor.js";
import { EXTRAS } from "../../core/roles.js";
import { h, replace } from "./dom.js";
import { icon } from "./icons.js";
import { trapFocus } from "./a11y.js";
import { isPhoneTouchViewport } from "./settings-dialog.js";

/** @typedef {"all" | "tools" | "shortcuts" | "gestures" | "views" | "roles"} HelpSectionId */

/** @type {readonly { id: HelpSectionId, label: string }[]} */
const HELP_NAV = Object.freeze([
  Object.freeze({ id: "all", label: "All" }),
  Object.freeze({ id: "tools", label: "Drawing tools" }),
  Object.freeze({ id: "shortcuts", label: "Keyboard shortcuts" }),
  Object.freeze({ id: "gestures", label: "Touch & trackpad" }),
  Object.freeze({ id: "views", label: "Layers, frames & views" }),
  Object.freeze({ id: "roles", label: "Roles" }),
]);

/** Tool descriptions matching Plenary's actual editor and role capabilities. */
/** @type {Readonly<Record<string, string>>} */
const TOOL_DETAILS = Object.freeze({
  select: "Select, move, resize, rotate, and multi-select elements",
  hand: "Pan the canvas without editing (also Space + drag)",
  rectangle: "Draw boxes and containers (double-click to add label)",
  diamond: "Draw decision diamonds and flowchart nodes",
  ellipse: "Draw circles and ovals",
  arrow: "Draw connectors that snap and bind to shape perimeters",
  line: "Draw straight or multi-point lines (Esc or Enter finishes)",
  freedraw: "Freehand pen with stylus pressure sensitivity",
  text: "Place standalone text blocks (⌘Enter commits)",
  eraser: "Erase strokes, shapes, or notes on click/drag",
  frame: "Create presentation pages and export regions",
  laser: "Live ephemeral pointer visible to peers (Owner/Editor)",
  image: "Insert Photo / Video (PNG, JPEG, GIF, WebP, MP4, WebM, MOV; Crop & Splice 2×1 / 2×2)",
  note: "Place sticky notes on the personal Notes overlay",
  highlighter: "Draw translucent highlights on the Notes overlay",
});

/** @type {WeakMap<object, ReturnType<typeof createHelpDialog>>} */
const activeByDoc = new WeakMap();
/** @type {ReturnType<typeof createHelpDialog> | null} */
let fallbackActive = null;

function isMacPlatform() {
  try {
    const nav = globalThis.navigator;
    if (!nav) return true;
    const plat = String(nav.platform || nav.userAgent || "");
    if (!plat) return true;
    return /Mac|iPhone|iPad|iPod/i.test(plat);
  } catch {
    return true;
  }
}

/**
 * Format a combo for display, returning `"Unbound"` when an action shortcut is cleared (`""`).
 * @param {string | undefined | null} combo
 * @param {boolean} mac
 * @returns {string}
 */
function fmtKey(combo, mac) {
  if (!combo) return "Unbound";
  return formatCombo(combo, { mac }) || "Unbound";
}

/**
 * Render a keycap or `"Unbound"` badge.
 * @param {string} combo
 * @param {boolean} mac
 */
function kbdBadge(combo, mac) {
  const text = fmtKey(combo, mac);
  return h("kbd.help-kbd" + (text === "Unbound" ? ".unbound" : ""), {}, text);
}

/**
 * Render a fixed display keycap (for built-in shortcuts that do not go through ACTION_CATALOG).
 * @param {string} label
 */
function rawKbd(label) {
  return h("kbd.help-kbd", {}, label);
}

/**
 * Create a single-instance Help & Shortcuts modal controller.
 * @param {{
 *   host?: HTMLElement | null,
 *   doc?: Document | null,
 *   win?: { matchMedia?: (query: string) => { matches?: boolean } | null } | null,
 *   getSettings?: (() => Partial<import("../../core/settings.js").UserSettings> | null | undefined) | null,
 *   onRestoreFocus?: ((opener: any) => void) | null,
 *   onClose?: (() => void) | null,
 * }} [opts]
 */
export function createHelpDialog({
  host = null,
  doc = globalThis.document ?? null,
  win = null,
  getSettings = () => null,
  onRestoreFocus = null,
  onClose = null,
} = {}) {
  let openState = false;
  let phoneTouch = false;
  /** @type {HelpSectionId} */
  let activeSection = "all";
  let veil = null;
  let dialog = null;
  let navHost = null;
  /** @type {any[]} */
  let navButtons = [];
  let bodyHost = null;
  let trap = null;
  let openerRef = null;
  let closeBtn = null;
  let currentSettings = null;
  let currentOnRestoreFocus = onRestoreFocus;
  let currentOnClose = onClose;

  const isPhone = () => isPhoneTouchViewport(win ?? doc?.defaultView ?? globalThis);

  function cleanupDomState() {
    openState = false;
    openerRef = null;
    trap?.deactivate({ restoreFocus: false });
    trap = null;
    veil?.remove?.();
    veil = null;
    dialog = null;
    navHost = null;
    navButtons = [];
    bodyHost = null;
    closeBtn = null;
    if (doc && typeof doc === "object") {
      if (activeByDoc.get(doc) === controller) activeByDoc.delete(doc);
    } else if (fallbackActive === controller) {
      fallbackActive = null;
    }
  }

  function isOpen() {
    if (!openState) return false;
    if (veil && (veil.isConnected === false || !veil.parentNode)) {
      cleanupDomState();
      return false;
    }
    return true;
  }

  function close({ restoreFocus = true } = {}) {
    if (!openState) return;
    const prevOpener = openerRef;
    const restoreFn = currentOnRestoreFocus;
    const closeCb = currentOnClose;
    cleanupDomState();
    if (restoreFocus) {
      if (typeof restoreFn === "function") restoreFn(prevOpener);
      else if (prevOpener && prevOpener.isConnected !== false) prevOpener.focus?.();
    }
    closeCb?.();
  }

  function sectionCard(id, title, subtitle, content) {
    return h("section.help-section", {
      id: `help-sec-${id}`,
      "data-help-section": id,
      "aria-labelledby": `help-sec-title-${id}`,
    },
    h("div.help-sec-head", {},
      h("h3.help-sec-title", { id: `help-sec-title-${id}` }, title),
      subtitle ? h("span.help-sec-sub", {}, subtitle) : null),
    content);
  }

  function helpRow(label, desc, ...badges) {
    return h("div.help-row", {},
      h("div.help-row-text", {},
        h("span.help-row-label", {}, label),
        desc ? h("span.help-row-desc", {}, desc) : null),
      badges.length ? h("div.help-row-keys", {}, badges) : null);
  }

  function renderToolsSection(eff, mac) {
    const allTools = [...TOOLS, ...EXTRAS];
    const toolRows = allTools.map(t => {
      const actionId = `tool.${t.id}`;
      const isCustomizable = ACTION_CATALOG.some(a => a.id === actionId);
      const displayName = t.id === "image" ? "Image / Photo & Video" : t.id === "note" ? "Sticky note (Note)" : t.name;
      const badge = isCustomizable
        ? kbdBadge(eff[actionId] ?? "", mac)
        : rawKbd("Drop / Paste");
      return helpRow(displayName, TOOL_DETAILS[t.id] ?? "", badge);
    });

    const insertRows = [
      helpRow("Tool lock", "Keep the active drawing tool selected after placing a shape", kbdBadge(eff["action.toolLock"] ?? "", mac)),
      helpRow("Mermaid", "Insert or paste Mermaid flowchart/graph syntax into editable shapes", rawKbd("Board menu")),
      helpRow("Swimlane", "Insert a 3-lane collaborative frame group", rawKbd("Board menu")),
      helpRow("Table", "Insert a 3×3 grouped grid table", rawKbd("Board menu")),
      helpRow("Embed URL & link cards", "Embed YouTube, HTTPS video/image media, or Jira/Linear/GitHub links", rawKbd("Paste URL")),
      helpRow("Shape Library & imports", "Reuse saved shape packs and import .excalidraw, .drawio, or .excalidrawlib files", rawKbd("Side panel")),
    ];

    return sectionCard("tools", "Drawing tools", "Core canvas tools, notes, inserts & imports",
      h("div.help-grid", {},
        h("div.help-group", {},
          h("div.help-group-title", {}, "Canvas & Note tools"),
          h("div.help-list", {}, toolRows)),
        h("div.help-group", {},
          h("div.help-group-title", {}, "Inserts, media & imports"),
          h("div.help-list", {}, insertRows))));
  }

  function renderShortcutsSection(eff, mac, settings) {
    const viewActions = ACTION_CATALOG.filter(a => a.category === "View");
    const boardActions = ACTION_CATALOG.filter(a => a.category === "Board");

    const viewRows = [
      ...viewActions.map(a => helpRow(a.label, null, kbdBadge(eff[a.id] ?? "", mac))),
      helpRow("Zoom to selection", null, rawKbd(formatCombo("Shift+2", { mac }))),
      helpRow("Previous / next saved view", null, rawKbd("["), rawKbd("]")),
      helpRow("Help & shortcuts", null, rawKbd("?")),
      helpRow("Home search (Home page)", null, rawKbd("/"), rawKbd(formatCombo("Mod+K", { mac }))),
      helpRow("Cancel, deselect, or exit Present", null, rawKbd("Esc")),
    ];

    const frameBinds = settings?.frameBinds && typeof settings.frameBinds === "object" ? settings.frameBinds : {};
    const boundSlots = FRAME_BIND_SLOTS.filter(slot => Boolean(frameBinds[slot]));
    const frameBindRows = boundSlots.length
      ? boundSlots.map(slot => helpRow(`Quick-jump: ${frameBinds[slot]}`, "Configured in Settings", rawKbd(formatCombo(slot, { mac }))))
      : [helpRow("Quick-jump frame/view slots", "Assign specific frames or views in Settings → Keybindings", rawKbd(`${formatCombo("Alt+1", { mac })}–${formatCombo("Alt+9", { mac })}`))];

    const boardRows = [
      ...boardActions.map(a => helpRow(a.label, null, kbdBadge(eff[a.id] ?? "", mac))),
      ...frameBindRows,
    ];

    const editRows = [
      helpRow("Undo / Redo", null, rawKbd(formatCombo("Mod+Z", { mac })), rawKbd(formatCombo("Mod+Shift+Z", { mac }))),
      helpRow("Copy / Cut / Paste / Duplicate", null, rawKbd(formatCombo("Mod+C", { mac })), rawKbd(formatCombo("Mod+X", { mac })), rawKbd(formatCombo("Mod+V", { mac })), rawKbd(formatCombo("Mod+D", { mac }))),
      helpRow("Alt-drag duplicate", "Hold Option/Alt while dragging selection", rawKbd(mac ? "⌥+Drag" : "Alt+Drag")),
      helpRow("Select all / Delete", null, rawKbd(formatCombo("Mod+A", { mac })), rawKbd("⌫ / Del")),
      helpRow("Edit label / Commit text", null, rawKbd("Enter"), rawKbd(formatCombo("Mod+Enter", { mac }))),
      helpRow("Nudge 2px / 20px", null, rawKbd("Arrows"), rawKbd("⇧+Arrows")),
      helpRow("Style cycle (Stroke, Fill, Style, Width, Roughness)", null, rawKbd("C / B / S / W / G")),
      helpRow("Font size larger / smaller", null, rawKbd("="), rawKbd("-")),
      helpRow("Group / Ungroup / Lock", null, rawKbd(formatCombo("Mod+G", { mac })), rawKbd(formatCombo("Mod+Shift+G", { mac })), rawKbd(formatCombo("Mod+Shift+L", { mac }))),
      helpRow("Z-order (Front / Back / Forward / Backward)", null, rawKbd(formatCombo("Mod+]", { mac })), rawKbd(formatCombo("Mod+[", { mac })), rawKbd("] / [")),
      helpRow("Rotate ±15°", null, rawKbd("<"), rawKbd(">")),
      helpRow("Align (L / R / T / B / H / V) & Distribute", null, rawKbd(mac ? "⌥A/D/W/S/H/V" : "Alt+A/D/W/S/H/V"), rawKbd("⇧H / ⇧V")),
      helpRow("Play / pause timeline animation", null, rawKbd(formatCombo("Shift+Space", { mac }))),
    ];

    return sectionCard("shortcuts", "Keyboard shortcuts", "Live customized bindings + built-in editor commands",
      h("div.help-grid", {},
        h("div.help-group", {},
          h("div.help-group-title", {}, "View & Navigation"),
          h("div.help-list", {}, viewRows),
          h("div.help-group-title.help-group-gap", {}, "Board & Quick-Jump"),
          h("div.help-list", {}, boardRows)),
        h("div.help-group", {},
          h("div.help-group-title", {}, "Edit, Style, Arrange & Animation"),
          h("div.help-list", {}, editRows))));
  }

  function renderGesturesSection(mac) {
    const modScroll = mac ? "⌘+Scroll" : "Ctrl+Scroll";
    const rows = [
      helpRow("Pinch zoom & pan", "Two-finger pinch zooms and pans together with release inertia", rawKbd("2-finger pinch")),
      helpRow("Two-finger scroll pan", "Scroll on trackpad (or hold Space + drag) to pan the board", rawKbd("2-finger scroll")),
      helpRow("Zoom at cursor", "Hold modifier while scrolling or trackpad pinch", rawKbd(modScroll)),
      helpRow("Two-finger tap — Undo", "Tap quickly with two fingers on touch screens to undo", rawKbd("2-finger tap")),
      helpRow("Three-finger tap — Redo", "Tap quickly with three fingers on touch screens to redo", rawKbd("3-finger tap")),
      helpRow("Long-press element — Selection Action Sheet", "Press and hold an element on touch screens for Duplicate, Delete, Group, Tidy, Splice, Order, Lock, Copy link, or Comment", rawKbd("Long-press")),
      helpRow("Apple Pencil & stylus", "Pressure-sensitive strokes with palm rejection and a 300ms palm grace window after pen lift (2-finger pan/zoom stays active)", rawKbd("Stylus")),
      helpRow("Swipe-down bottom sheet", "Drag the sheet handle downward or tap the backdrop to dismiss mobile sheets", rawKbd("Swipe down")),
    ];
    return sectionCard("gestures", "Touch & trackpad gestures", "Multi-touch, Apple Pencil, and trackpad controls",
      h("div.help-list", {}, rows));
  }

  function renderViewsSection(eff, mac) {
    const rows = [
      helpRow("Shared Layers", "Create, rename, reorder, hide, or lock shared board layers in the Side Panel; move selected elements between layers", kbdBadge(eff["action.panel"] ?? "", mac)),
      helpRow("Local Solo Layer", "Isolate one layer locally via the Layers panel S button (or Views) without affecting peers; clear with Show all layers", h("span.help-hint", {}, "Layers · S btn")),
      helpRow("Frames as pages", "Organize board sections in reading order as presentation slides, export scopes, and shareable deep links", kbdBadge(eff["tool.frame"] ?? "", mac), rawKbd("PgUp / PgDn")),
      helpRow("Saved Views", "Capture a frame plus visible-layer filter in Views, search and jump locally, or assign ⌥1–⌥9 quick-jump slots", kbdBadge(eff["action.views"] ?? "", mac), rawKbd("[ / ]")),
      helpRow("Workspace Modes (Draw · Animate · Present)", "Switch between Draw, Animate (multi-swimlane NLE timeline, ⇧Space), and Present (distraction-free Presenter Bar; Esc exits Present)", rawKbd("Esc")),
    ];
    return sectionCard("views", "Layers, frames & views", "Organize shared boards and navigate locally",
      h("div.help-list", {}, rows));
  }

  function renderRolesSection() {
    const roles = [
      {
        name: "Owner",
        uiMode: "Presenter UI",
        badgeCls: ".role-pill-accent",
        desc: "Full access to board elements, layers, notes, comments, Animate & Present modes, audience edit lock, Version History, Export, Share, and ownership/role management.",
      },
      {
        name: "Editor",
        uiMode: "Presenter UI",
        badgeCls: ".role-pill-accent",
        desc: "Full access to board elements, layers, notes, comments, Animate & Present modes, audience edit lock, Version History, and Export.",
      },
      {
        name: "Annotator",
        uiMode: "Annotator UI",
        badgeCls: ".role-pill-ok",
        desc: "Draws on the separate Notes overlay (Select, Hand, Arrow, Pen, Text, Eraser, Image, Sticky note, Highlighter — edits own notes only) plus comments and emotes.",
      },
      {
        name: "Commenter",
        uiMode: "Viewer canvas UI",
        badgeCls: ".role-pill-warn",
        desc: "Pans and zooms, jumps frames/views, toggles local Solo Layer, reads notes, creates/replies/resolves/reacts on comment threads, and sends emotes; cannot draw on board or notes.",
      },
      {
        name: "Viewer",
        uiMode: "Viewer canvas UI",
        badgeCls: "",
        desc: "Read-only canvas access: pan/zoom (Hand), frames & saved views, local Solo Layer, read notes & comments, and send counted emotes.",
      },
    ];
    return sectionCard("roles", "Roles", "Board permissions and Presenter / Annotator / Viewer workspace modes",
      h("div.help-role-list", {}, roles.map(r =>
        h("div.help-role-card", {},
          h("div.help-role-head", {},
            h("span.help-role-name", {}, r.name),
            h("span.role-pill" + r.badgeCls, {}, r.uiMode)),
          h("p.help-role-desc", {}, r.desc)))));
  }

  function renderNav() {
    if (!navHost) return;
    if (navButtons.length !== HELP_NAV.length) {
      navButtons = HELP_NAV.map(item => h("button.help-nav-btn", {
        type: "button",
        "data-help-nav": item.id,
        onclick: () => {
          if (activeSection === item.id) return;
          activeSection = item.id;
          renderNav();
          renderBody();
        },
      }, item.label));
      replace(navHost, navButtons);
    }
    for (let i = 0; i < HELP_NAV.length; i++) {
      const btn = navButtons[i];
      const active = activeSection === HELP_NAV[i].id;
      btn.classList.toggle("on", active);
      btn.setAttribute("aria-pressed", String(active));
      if (btn.style) {
        if (phoneTouch) {
          btn.style.minHeight = "44px";
          btn.style.fontSize = "14px";
        } else {
          btn.style.minHeight = "";
          btn.style.fontSize = "";
        }
      }
    }
  }

  function renderBody() {
    if (!openState || !bodyHost) return;
    const settings = currentSettings ?? getSettings?.() ?? null;
    const eff = effectiveKeybinds(settings);
    const mac = isMacPlatform();
    const sections = [];
    if (activeSection === "all" || activeSection === "tools") sections.push(renderToolsSection(eff, mac));
    if (activeSection === "all" || activeSection === "shortcuts") sections.push(renderShortcutsSection(eff, mac, settings));
    if (activeSection === "all" || activeSection === "gestures") sections.push(renderGesturesSection(mac));
    if (activeSection === "all" || activeSection === "views") sections.push(renderViewsSection(eff, mac));
    if (activeSection === "all" || activeSection === "roles") sections.push(renderRolesSection());
    replace(bodyHost, sections);
  }

  /**
   * Open the Help & Shortcuts modal.
   * @param {{
   *   opener?: any,
   *   host?: HTMLElement | null,
   *   userSettings?: Partial<import("../../core/settings.js").UserSettings> | null,
   *   initialSection?: HelpSectionId,
   *   onRestoreFocus?: ((opener: any) => void) | null,
   *   onClose?: (() => void) | null,
   * }} [opts]
   */
  function open({
    opener = null,
    host: overrideHost = null,
    userSettings = null,
    initialSection = "all",
    onRestoreFocus: overrideRestore = null,
    onClose: overrideClose = null,
  } = {}) {
    if (openState) close({ restoreFocus: false });
    const mountHost = overrideHost ?? host ?? doc?.body ?? opener?.ownerDocument?.body ?? null;
    if (!mountHost) return null;

    openState = true;
    phoneTouch = isPhone();
    activeSection = HELP_NAV.some(n => n.id === initialSection) ? initialSection : "all";
    openerRef = opener ?? doc?.activeElement ?? null;
    currentSettings = userSettings;
    currentOnRestoreFocus = overrideRestore ?? onRestoreFocus;
    currentOnClose = overrideClose ?? onClose;

    const touchBtnStyle = phoneTouch ? { minHeight: "44px", fontSize: "16px" } : undefined;
    const touchIconStyle = phoneTouch ? { minWidth: "44px", minHeight: "44px" } : undefined;

    closeBtn = h("button.tb", {
      type: "button",
      title: "Close (Esc)",
      "aria-label": "Close help",
      "data-action": "close-help",
      style: touchIconStyle,
      onclick: () => close({ restoreFocus: true }),
    }, icon("close", { size: 16 }));

    navHost = h("div.help-nav", { role: "group", "aria-label": "Help sections" });
    bodyHost = h("div.dbody.help-body");

    dialog = h("div.dialog.help-modal.help-dialog", {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "help-dialog-title",
      "data-mobile-sheet": "1",
      ...(phoneTouch ? { "data-phone-touch": "1" } : {}),
      tabindex: "-1",
    },
    h("h2", { id: "help-dialog-title" },
      icon("help", { size: 17 }),
      " Help & shortcuts",
      h("span.spacer"),
      phoneTouch ? null : h("kbd.help-kbd", { "aria-hidden": "true" }, "?"),
      closeBtn),
    navHost,
    bodyHost,
    h("footer.help-footer", {},
      h("span.hint.help-hint", {}, phoneTouch ? "Tap outside or Done to close" : "Press ? or Esc to close"),
      h("button.btn.primary", {
        type: "button",
        "aria-label": "Done",
        "data-action": "done-help",
        style: touchBtnStyle,
        onclick: () => close({ restoreFocus: true }),
      }, "Done")));

    veil = h("div.dialog-veil.help-veil", {
      onclick: e => { if (e.target === e.currentTarget) close({ restoreFocus: true }); },
      onkeydown: e => trap?.handleKeyDown(e),
    }, dialog);

    mountHost.append(veil);
    renderNav();
    renderBody();

    trap = trapFocus(dialog, {
      onEscape: () => close({ restoreFocus: true }),
      returnFocusTo: null,
      initialFocus: closeBtn,
      focusOnActivate: true,
      doc,
    });

    if (doc && typeof doc === "object") activeByDoc.set(doc, controller);
    else fallbackActive = controller;
    return dialog;
  }

  function toggle(opts = {}) {
    if (isOpen()) close({ restoreFocus: true });
    else return open(opts);
    return null;
  }

  function refresh() {
    if (!isOpen()) return;
    phoneTouch = isPhone();
    renderNav();
    renderBody();
  }

  const controller = {
    open,
    close,
    toggle,
    isOpen,
    refresh,
    destroy: () => close({ restoreFocus: false }),
  };
  return controller;
}

/**
 * Open the shared Help & Shortcuts modal for `doc` (single instance per Document).
 * @param {{
 *   opener?: any,
 *   doc?: Document | null,
 *   host?: HTMLElement | null,
 *   win?: { matchMedia?: (query: string) => { matches?: boolean } | null } | null,
 *   userSettings?: Partial<import("../../core/settings.js").UserSettings> | null,
 *   initialSection?: HelpSectionId,
 *   onRestoreFocus?: ((opener: any) => void) | null,
 *   onClose?: (() => void) | null,
 * }} [opts]
 */
export function openHelpDialog({
  opener = null,
  doc = globalThis.document ?? null,
  host = null,
  win = null,
  userSettings = null,
  initialSection = "all",
  onRestoreFocus = null,
  onClose = null,
} = {}) {
  const prev = doc && typeof doc === "object" ? activeByDoc.get(doc) : fallbackActive;
  if (prev?.isOpen()) prev.close({ restoreFocus: false });
  const resolvedHost = host ?? doc?.body ?? opener?.ownerDocument?.body ?? null;
  const ctrl = createHelpDialog({
    host: resolvedHost,
    doc,
    win,
    getSettings: () => userSettings,
    onRestoreFocus,
    onClose,
  });
  return ctrl.open({ opener, host: resolvedHost, userSettings, initialSection, onRestoreFocus, onClose });
}

/**
 * Close any open Help & Shortcuts modal on `doc`.
 * @param {{ doc?: Document | null, restoreFocus?: boolean }} [opts]
 */
export function closeHelpDialog({ doc = globalThis.document ?? null, restoreFocus = true } = {}) {
  const active = doc && typeof doc === "object" ? activeByDoc.get(doc) : fallbackActive;
  if (!active) return false;
  if (!active.isOpen()) return false;
  active.close({ restoreFocus });
  return true;
}

/**
 * Return true if a Help & Shortcuts modal is currently open and connected on `doc`.
 * Prunes any detached instance automatically.
 * @param {Document | null} [doc]
 * @returns {boolean}
 */
export function isHelpDialogOpen(doc = globalThis.document ?? null) {
  const active = doc && typeof doc === "object" ? activeByDoc.get(doc) : fallbackActive;
  if (!active) return false;
  return active.isOpen();
}

/**
 * Toggle the shared Help & Shortcuts modal for `doc`.
 * @param {Parameters<typeof openHelpDialog>[0]} [opts]
 */
export function toggleHelpDialog(opts = {}) {
  const doc = opts?.doc ?? globalThis.document ?? null;
  if (isHelpDialogOpen(doc)) {
    closeHelpDialog({ doc, restoreFocus: true });
    return null;
  }
  return openHelpDialog(opts);
}
