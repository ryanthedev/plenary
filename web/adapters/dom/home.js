// @ts-check
/**
 * @module web/adapters/dom/home
 * Home screen DOM adapter rendering `web/core/home.js` (Recent, Starred, Shared with me,
 * starter templates, the Area/Space tree, search, and self-serve Workspace Admin panels).
 *
 * Invariants:
 * - User-authored names and titles go through `textContent` only.
 * - `/` or `⌘K` focuses search, `Escape` clears it, `?` toggles Help, and every card is a link + star/menu control.
 */

import { h, replace } from "./dom.js";
import { keeper } from "./focus.js";
import { icon } from "./icons.js";
import { hasActiveOverlay } from "./a11y.js";
import { openHelpDialog, closeHelpDialog, isHelpDialogOpen } from "./help-dialog.js";
import { overflowMenu, svgEl, brandMark } from "./spaces.js";
import { createThemeToggle } from "./theme.js";
import { startMove } from "./move.js";
import { pathText, whenText } from "../../core/home.js";
import { TEMPLATES } from "../../../packages/core/templates.js";

/**
 * SessionStorage key holding a selected template seed across the navigation from Home (`openTemplate`)
 * to the newly created board (`app.js` `consumePendingTemplate`).
 */
export const PENDING_TEMPLATE_KEY = "plenary:pending-template";
// Why: a 60s TTL ensures an abandoned or cancelled navigation never seeds an unrelated empty board later.
const PENDING_TEMPLATE_TTL_MS = 60_000;

function resolveStorage(storage) {
  if (storage) return storage;
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/**
 * Persist (or clear, when `templateId` is null/`"blank"`) the pending template seed before opening a new board.
 * @param {any} storage
 * @param {string | null | undefined} templateId
 * @param {number} now
 */
function setPendingTemplate(storage, templateId, now) {
  try {
    const store = resolveStorage(storage);
    if (!store) return;
    if (templateId && templateId !== "blank") {
      const payload = JSON.stringify({ templateId, createdAt: Number.isFinite(now) ? now : 0 });
      if (typeof store.set === "function") store.set(PENDING_TEMPLATE_KEY, payload);
      else if (typeof store.setItem === "function") store.setItem(PENDING_TEMPLATE_KEY, payload);
    } else {
      if (typeof store.remove === "function") store.remove(PENDING_TEMPLATE_KEY);
      else if (typeof store.removeItem === "function") store.removeItem(PENDING_TEMPLATE_KEY);
    }
  } catch {
    // Ignore storage errors (private browsing / restricted iframes / test stubs).
  }
}

/**
 * Read and immediately clear a pending template handoff (returns null if missing, malformed, or expired).
 * Supports both Plenary's Storage port (`get`/`remove`) and Web Storage (`getItem`/`removeItem`).
 * @param {any} storage
 * @param {number} [now]
 * @param {number} [maxAgeMs]
 * @returns {string | null}
 */
export function consumePendingTemplate(storage, now = Date.now(), maxAgeMs = PENDING_TEMPLATE_TTL_MS) {
  try {
    const store = resolveStorage(storage);
    if (!store) return null;
    const raw = typeof store.get === "function" ? store.get(PENDING_TEMPLATE_KEY) : store.getItem?.(PENDING_TEMPLATE_KEY);
    if (typeof store.remove === "function") store.remove(PENDING_TEMPLATE_KEY);
    else store.removeItem?.(PENDING_TEMPLATE_KEY);
    if (!raw || typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.templateId !== "string" || !parsed.templateId) return null;
    if (Number.isFinite(parsed.createdAt) && Number.isFinite(now) && now - parsed.createdAt > maxAgeMs) return null;
    return parsed.templateId;
  } catch {
    return null;
  }
}

/** Featured template ids exposed in the Home starter strip (paired with Blank Board). */
const HOME_TEMPLATE_IDS = ["plenary-tour", "architecture", "presentation", "retro"];

/** Starter presets shown in the Home template strip (non-guest users with board creation). */
export const HOME_TEMPLATES = Object.freeze([
  Object.freeze({ id: "blank", title: "Blank Board", boardTitle: "", desc: "Start an open canvas" }),
  ...HOME_TEMPLATE_IDS.map(id => TEMPLATES.find(t => t.id === id)).filter(Boolean),
]);

function templatePreviewSvg(id) {
  if (id === "plenary-tour") {
    return svgEl("svg", { viewBox: "0 0 160 66", class: "home-tpl-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("rect", { x: "12", y: "10", width: "62", height: "21", rx: "4", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--accent-soft)" }),
      svgEl("rect", { x: "86", y: "10", width: "62", height: "21", rx: "4", stroke: "var(--border-strong)", "stroke-width": "1.4", fill: "var(--surface)" }),
      svgEl("rect", { x: "12", y: "37", width: "62", height: "21", rx: "4", stroke: "var(--border-strong)", "stroke-width": "1.4", fill: "var(--surface)" }),
      svgEl("rect", { x: "86", y: "37", width: "62", height: "21", rx: "4", stroke: "var(--ok)", "stroke-width": "1.4", fill: "var(--ok-bg)" }),
      svgEl("path", { d: "M74 20h12M117 31v6", stroke: "var(--fg-dim)", "stroke-width": "1.4", "stroke-linecap": "round" }),
    ]);
  }
  if (id === "architecture") {
    return svgEl("svg", { viewBox: "0 0 160 66", class: "home-tpl-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("rect", { x: "10", y: "18", width: "42", height: "28", rx: "6", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
      svgEl("rect", { x: "66", y: "10", width: "36", height: "20", rx: "5", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--accent-soft)" }),
      svgEl("rect", { x: "112", y: "26", width: "38", height: "26", rx: "6", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
      svgEl("path", { d: "M52 28 C 58 28, 60 20, 66 20", stroke: "var(--fg-dim)", "stroke-width": "1.4", "stroke-linecap": "round" }),
      svgEl("path", { d: "M102 20 C 107 20, 108 38, 112 38", stroke: "var(--fg-dim)", "stroke-width": "1.4", "stroke-linecap": "round" }),
    ]);
  }
  if (id === "presentation" || id === "deck") {
    return svgEl("svg", { viewBox: "0 0 160 66", class: "home-tpl-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("rect", { x: "12", y: "12", width: "62", height: "42", rx: "6", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--surface)" }),
      svgEl("path", { d: "M22 24h28M22 33h40M22 40h24", stroke: "var(--fg-dim)", "stroke-width": "1.6", "stroke-linecap": "round" }),
      svgEl("rect", { x: "86", y: "12", width: "62", height: "42", rx: "6", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
      svgEl("rect", { x: "96", y: "22", width: "20", height: "20", rx: "4", stroke: "var(--accent)", "stroke-width": "1.3", fill: "var(--accent-soft)" }),
      svgEl("path", { d: "M122 26h16M122 34h12", stroke: "var(--fg-dim)", "stroke-width": "1.5", "stroke-linecap": "round" }),
    ]);
  }
  if (id === "retro") {
    return svgEl("svg", { viewBox: "0 0 160 66", class: "home-tpl-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("rect", { x: "14", y: "12", width: "38", height: "42", rx: "5", stroke: "var(--border)", "stroke-width": "1.2", fill: "var(--surface)" }),
      svgEl("rect", { x: "61", y: "12", width: "38", height: "42", rx: "5", stroke: "var(--border)", "stroke-width": "1.2", fill: "var(--surface)" }),
      svgEl("rect", { x: "108", y: "12", width: "38", height: "42", rx: "5", stroke: "var(--border)", "stroke-width": "1.2", fill: "var(--surface)" }),
      svgEl("rect", { x: "20", y: "20", width: "26", height: "14", rx: "3", fill: "var(--warn-bg)", stroke: "var(--warn)", "stroke-width": "1.2" }),
      svgEl("rect", { x: "67", y: "20", width: "26", height: "14", rx: "3", fill: "var(--accent-soft)", stroke: "var(--accent)", "stroke-width": "1.2" }),
      svgEl("rect", { x: "114", y: "20", width: "26", height: "14", rx: "3", fill: "var(--ok-bg)", stroke: "var(--ok)", "stroke-width": "1.2" }),
    ]);
  }
  return svgEl("svg", { viewBox: "0 0 160 66", class: "home-tpl-svg", "aria-hidden": "true", fill: "none" }, [
    svgEl("rect", { x: "52", y: "12", width: "56", height: "42", rx: "8", stroke: "var(--border-strong)", "stroke-width": "1.4", "stroke-dasharray": "4 3", fill: "var(--surface)" }),
    svgEl("path", { d: "M80 25v16M72 33h16", stroke: "var(--accent)", "stroke-width": "1.8", "stroke-linecap": "round" }),
  ]);
}

function previewVariant(id) {
  let hash = 0;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return Math.abs(hash) % 4;
}

function boardPreviewSvg(id) {
  const v = previewVariant(id);
  if (v === 1) {
    return svgEl("svg", { viewBox: "0 0 200 88", class: "card-preview-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("rect", { x: "16", y: "14", width: "74", height: "58", rx: "7", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
      svgEl("path", { d: "M28 30h34M28 40h48M28 50h30", stroke: "var(--fg-dim)", "stroke-width": "1.6", "stroke-linecap": "round" }),
      svgEl("rect", { x: "108", y: "14", width: "74", height: "58", rx: "7", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--accent-soft)" }),
      svgEl("circle", { cx: "145", cy: "43", r: "14", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--surface)" }),
    ]);
  }
  if (v === 2) {
    return svgEl("svg", { viewBox: "0 0 200 88", class: "card-preview-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("rect", { x: "20", y: "18", width: "44", height: "44", rx: "6", stroke: "var(--warn)", "stroke-width": "1.4", fill: "var(--warn-bg)" }),
      svgEl("rect", { x: "78", y: "24", width: "44", height: "44", rx: "6", stroke: "var(--accent)", "stroke-width": "1.4", fill: "var(--accent-soft)" }),
      svgEl("rect", { x: "136", y: "16", width: "44", height: "44", rx: "6", stroke: "var(--ok)", "stroke-width": "1.4", fill: "var(--ok-bg)" }),
    ]);
  }
  if (v === 3) {
    return svgEl("svg", { viewBox: "0 0 200 88", class: "card-preview-svg", "aria-hidden": "true", fill: "none" }, [
      svgEl("circle", { cx: "44", cy: "44", r: "18", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
      svgEl("path", { d: "M62 44h28", stroke: "var(--fg-dim)", "stroke-width": "1.5", "stroke-linecap": "round" }),
      svgEl("rect", { x: "90", y: "24", width: "42", height: "40", rx: "7", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--accent-soft)" }),
      svgEl("path", { d: "M132 44h22", stroke: "var(--fg-dim)", "stroke-width": "1.5", "stroke-linecap": "round" }),
      svgEl("rect", { x: "154", y: "28", width: "30", height: "32", rx: "6", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
    ]);
  }
  return svgEl("svg", { viewBox: "0 0 200 88", class: "card-preview-svg", "aria-hidden": "true", fill: "none" }, [
    svgEl("rect", { x: "16", y: "18", width: "56", height: "34", rx: "6", stroke: "var(--border-strong)", "stroke-width": "1.5", fill: "var(--surface)" }),
    svgEl("rect", { x: "124", y: "34", width: "58", height: "34", rx: "6", stroke: "var(--accent)", "stroke-width": "1.5", fill: "var(--accent-soft)" }),
    svgEl("path", { d: "M72 35 C 96 35, 98 51, 124 51", stroke: "var(--fg-dim)", "stroke-width": "1.5", "stroke-linecap": "round" }),
  ]);
}

/** Prefill the New board dialog's Title input when opened from a template card. */
function prefillNewBoardTitle(dlg, boardTitle) {
  if (!boardTitle || !dlg) return;
  const host = dlg.dialog ?? dlg.el;
  if (!host) return;
  const input = typeof host.querySelector === "function"
    ? host.querySelector('input[aria-label="Title"]')
    : (typeof host.find === "function" ? host.find(e => e.tagName === "INPUT" && e.getAttribute?.("aria-label") === "Title") : null);
  if (!input) return;
  input.value = boardTitle;
  if (typeof input.dispatchEvent === "function" && typeof Event === "function") {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (typeof input.dispatch === "function") {
    input.dispatch("input", { target: { value: boardTitle } });
  }
}

/**
 * @param {{ root: HTMLElement, model: ReturnType<typeof import("../../core/home.js").createHomeModel>, clock: import("../../ports/clock.js").Clock,
 *   boardHref: (id: string) => string, spaceHref: (id: string) => string, groupHref: (id: string) => string,
 *   teamsHref?: string | null, trashHref?: string | null, rolesHref?: string | null, offboardHref?: string | null, unitAccessHref?: ((id: string) => string) | null, adminHref?: string | null,
 *   move?: { port: import("../../ports/move.js").MovePort, clock: import("../../ports/clock.js").Clock, newKey?: (() => string)|null }|null,
 *   org?: Pick<import("../../ports/admin.js").AdminPort, "createTenant"> | null,
 *   storage?: import("../../ports/storage.js").Storage | null,
 *   themeCtrl?: import("./theme.js").ThemeController | null,
 *   onLogout?: (() => void) | null,
 *   dialogs: Pick<ReturnType<typeof import("./dialogs.js").createDialogs>, "newBoard"|"newSpace"|"newGroup">, homeHref?: string, signIn?: { href: string, text?: string, links?: Array<{ href: string, text?: string }> } | null }} o
 * @returns {{ destroy(): void }}
 */
export function mountHome({ root, model, clock, boardHref, spaceHref, groupHref, teamsHref = null, trashHref = null, rolesHref = null, offboardHref = null, unitAccessHref = null, adminHref = null, dialogs, homeHref = "./", signIn = null, move = null, org = null, storage = null, themeCtrl = null, onLogout = null }) {
  const S = model.state, keys = keeper(), mark = keys.mark;
  let destroyed = false;
  let drawerOpen = false;
  let orgBusy = false;
  /** @type {null | { close: () => void }} */ let activeCardSheet = null;

  const status = h("div.home-status", { role: "status", "aria-live": "polite" });
  const search = h("input.home-search", { type: "search", placeholder: "Search boards and Spaces", "aria-label": "Search boards and Spaces", autocomplete: "off", maxlength: "100", spellcheck: "false",
    oninput: e => { model.setQuery(e.target.value); },
    onkeydown: e => { if (e.key === "Escape" && search.value) { search.value = ""; model.setQuery(""); e.preventDefault(); } } });
  const drawerToggle = h("button.btn.ghost.home-drawer-toggle", {
    type: "button",
    "aria-label": "Open navigation",
    "aria-expanded": "false",
    "aria-controls": "home-side",
    "data-mobile-drawer-toggle": "true",
    onclick: () => setDrawer(!drawerOpen),
  }, "☰");
  const drawerBackdrop = h("div.home-drawer-backdrop", {
    "aria-hidden": "true",
    hidden: true,
    onclick: () => setDrawer(false, true),
  });
  const side = h("nav.home-side", { id: "home-side", "aria-label": "Home navigation", "data-drawer-open": "false" });
  const mobileTabs = h("nav.home-mobile-tabs", { role: "tablist", "aria-label": "Board views" });
  const main = h("main.home-main", { id: "home-main", tabindex: "-1" });
  const fabHost = h("div.home-fab-host");
  const who = h("span.home-who");
  const helpBtn = mark(h("button.btn.ghost.home-help-btn", {
    type: "button",
    "data-action": "open-help",
    "aria-label": "Help & shortcuts",
    title: "Help & shortcuts (?)",
    onclick: e => openHelp(e?.currentTarget ?? helpBtn),
  }, icon("help", { size: 16 })), "help");
  const themeToggle = createThemeToggle({ themeCtrl, mark });
  const logoutBtn = onLogout
    ? mark(h("button.btn.ghost.home-logout", { type: "button", "data-action": "logout", "aria-label": "Sign out", onclick: () => onLogout() }, "Sign out"), "logout")
    : null;
  const orgBadge = h("span.home-org-badge");
  const top = h("header.home-top", {},
    drawerToggle,
    h("a.logo", { href: homeHref, "aria-label": "Plenary home" }, brandMark(), "Plenary"),
    orgBadge,
    h("div.home-searchbox", { role: "search" }, search, h("kbd", { "aria-hidden": "true" }, "/ or ⌘K")),
    h("span.spacer"), helpBtn, themeToggle.el, who, logoutBtn);
  const home = h("div.home.home-page", { id: "home" }, top, status, mobileTabs, drawerBackdrop, h("div.home-body", {}, side, main), fabHost);
  root.replaceChildren(home);

  function setDrawer(open, refocus = false) {
    drawerOpen = Boolean(open);
    side.setAttribute("data-drawer-open", drawerOpen ? "true" : "false");
    drawerToggle.setAttribute("aria-expanded", drawerOpen ? "true" : "false");
    drawerToggle.setAttribute("aria-label", drawerOpen ? "Close navigation" : "Open navigation");
    drawerBackdrop.hidden = !drawerOpen;
    if (S.data) renderSide();
    if (!drawerOpen && refocus) drawerToggle.focus?.();
  }

  function closeCardSheet() {
    if (!activeCardSheet) return;
    const s = activeCardSheet;
    activeCardSheet = null;
    s.close();
  }

  function openHelp(opener = null) {
    if (isHelpDialogOpen(document)) {
      closeHelpDialog({ doc: document, restoreFocus: true });
      return;
    }
    closeCardSheet();
    if (drawerOpen) setDrawer(false, false);
    openHelpDialog({
      opener: opener ?? document.activeElement ?? helpBtn,
      doc: document,
      host: document.body ?? root,
    });
  }

  function openCardActionsSheet(c, opener) {
    closeCardSheet();
    const label = c.title || "Untitled";
    const href = boardHref(c.id);
    const backdrop = h("div.mobile-board-actions-backdrop", { "aria-hidden": "true", onclick: () => close(true) });
    const rows = [
      h("a.sheet-action-row", { href, "data-card-sheet-action": "open" }, "Open board"),
      !guest() ? h("button.sheet-action-row", {
        type: "button",
        "data-card-sheet-action": "star",
        onclick: () => { close(true); model.toggleStar(c.id); },
      }, c.starred ? "Unstar board" : "Star board") : null,
      h("button.sheet-action-row", {
        type: "button",
        "data-card-sheet-action": "copy-link",
        onclick: async () => {
          close(true);
          try {
            const fullUrl = typeof globalThis.location?.origin === "string" && !/^https?:\/\//.test(href)
              ? `${globalThis.location.origin}/${href.replace(/^\.?\//, "")}`
              : href;
            await globalThis.navigator?.clipboard?.writeText?.(fullUrl);
            model.notify("Board link copied.");
          } catch {
            model.notify("Could not copy board link.");
          }
        },
      }, "Copy board link"),
      move && c.can?.move ? h("button.sheet-action-row", {
        type: "button",
        "data-card-sheet-action": "move",
        onclick: () => {
          close(false);
          startMove({ host: root, move, board: c.id, opener, reload: () => model.load(), restoreFocus: () => main.focus?.() });
        },
      }, "Move to…") : null,
      h("button.sheet-action-row", {
        type: "button",
        "data-card-sheet-action": "cancel",
        onclick: () => close(true),
      }, "Cancel"),
    ].filter(Boolean);
    const sheet = h("div.mobile-board-actions-sheet", {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": `Actions for ${label}`,
      "data-mobile-board-sheet": c.id,
      tabindex: "-1",
      onkeydown: e => { if (e.key === "Escape") { e.preventDefault?.(); close(true); } },
    },
    h("div.sheet-grabber", { "aria-hidden": "true" }),
    h("div.mobile-sheet-header", {}, h("h3.mobile-sheet-title", {}, label)),
    h("div.mobile-action-list", { role: "group", "aria-label": `Actions for ${label}` }, rows));
    let closed = false;
    function close(refocus = false) {
      if (closed) return;
      closed = true;
      backdrop.remove();
      sheet.remove();
      if (activeCardSheet?.close === close) activeCardSheet = null;
      if (refocus) opener?.focus?.();
    }
    activeCardSheet = { close };
    root.append(backdrop, sheet);
    sheet.focus?.();
  }

  // Why: allocated once outside `draw()` so async member/audit reloads never replace these inputs
  // mid-typing, preserving focus, caret position, and active IME composition.
  const orgNameInput = h("input.field.home-org-input", { type: "text", maxlength: "80", autocomplete: "off", placeholder: "Workspace name (e.g. My Studio)", "aria-label": "Workspace name" });
  const orgCreateBtn = h("button.btn.primary.home-org-btn", { type: "submit" }, "Create Workspace");
  const orgCreateErr = h("p.sp-error", { role: "alert" });
  const orgCreateCard = h("section.home-org-card", { "aria-label": "Create your own Workspace" },
    h("h2", {}, "Create your own Workspace"),
    h("p.muted", {}, "Start a personal workspace to create boards, Spaces, and invite collaborators by email."),
    h("form.home-org-form", { onsubmit: e => { e.preventDefault?.(); submitCreateOrg(); } }, orgNameInput, orgCreateBtn),
    orgCreateErr);

  async function submitCreateOrg() {
    if (!org || orgBusy) return;
    const name = String(orgNameInput.value ?? "").trim();
    if (!name) { orgCreateErr.textContent = "Enter a workspace name."; orgNameInput.focus?.(); return; }
    orgBusy = true; orgCreateErr.textContent = ""; orgCreateBtn.disabled = true; orgCreateBtn.textContent = "Creating…";
    try {
      const res = await org.createTenant({ name });
      if (destroyed) return;
      orgNameInput.value = "";
      model.notify(`Workspace "${res?.tenant?.name || name}" created.`);
      await model.load();
    } catch (e) {
      if (destroyed) return;
      orgCreateErr.textContent = e?.message || "Could not create workspace.";
    } finally {
      orgBusy = false;
      orgCreateBtn.disabled = false;
      orgCreateBtn.textContent = "Create Workspace";
    }
  }

  const guest = () => !!S.data?.guest;
  // Every control that can hold focus is marked with a stable key, so a redraw (a star toggled, a view picked, a load, a notice) puts focus back.
  const newBoard = () => mark(h("button.btn.primary.home-new-board", { type: "button", onclick: e => { setPendingTemplate(storage, null, clock.now()); dialogs.newBoard({ opener: e.currentTarget }); } }, "＋ New board"), "new-board");
  const newSpace = () => mark(h("button.btn.home-side-add", { type: "button", title: "New space", "aria-label": "New space", onclick: e => dialogs.newSpace({ opener: e.currentTarget }) }, "＋", h("span.sr-only", {}, " New space")), "new-space");
  const newGroup = () => (S.data?.can?.createGroup ? mark(h("button.btn.home-side-add", { type: "button", title: "New area", "aria-label": "New area", onclick: e => dialogs.newGroup({ opener: e.currentTarget }) }, "＋", h("span.sr-only", {}, " New area")), "new-group") : null);
  const navBtn = (view, label, count) => mark(h("button.nav", { type: "button", "aria-current": S.view === view && !S.query.trim() ? "page" : null,
    onclick: () => { search.value = ""; model.setQuery(""); model.setView(view); setDrawer(false); } }, label, count != null ? h("span.n", {}, String(count)) : null), `nav:${view}`);

  function openTemplate(tpl, opener) {
    if (guest() || typeof dialogs?.newBoard !== "function") return;
    const templateId = tpl.id && tpl.id !== "blank" ? tpl.id : null;
    setPendingTemplate(storage, templateId, clock.now());
    const dlg = dialogs.newBoard(/** @type {any} */ ({ opener, ...(templateId ? { templateId } : {}) }));
    prefillNewBoardTitle(dlg, tpl.boardTitle);
    // If the user cancels/closes the dialog without submitting, clear the pending template seed immediately.
    if (templateId && dlg && typeof dlg.close === "function") {
      let submitted = false;
      const host = dlg.dialog ?? dlg.el;
      const form = typeof host?.querySelector === "function"
        ? host.querySelector("form")
        : (typeof host?.find === "function" ? host.find(e => e.tagName === "FORM") : null);
      if (form && typeof form.addEventListener === "function") {
        form.addEventListener("submit", () => { submitted = true; }, true);
      } else if (form && typeof form.onsubmit === "function") {
        const prevSubmit = form.onsubmit;
        form.onsubmit = e => { submitted = true; return prevSubmit.call(form, e); };
      }
      const origClose = dlg.close;
      dlg.close = () => {
        if (!submitted) setPendingTemplate(storage, null, clock.now());
        return origClose();
      };
    }
  }

  function renderTemplates() {
    if (guest() || S.view !== "home" || S.query.trim() || typeof dialogs?.newBoard !== "function") return null;
    return h("section.home-templates", { "aria-label": "Start from a template", "data-home-templates": "true" },
      h("p.home-tpl-heading", {}, "Start from a template"),
      h("div.home-tpl-grid", {}, HOME_TEMPLATES.map(tpl => mark(
        h("button.home-tpl-card", { type: "button", "data-template": tpl.id, onclick: e => openTemplate(tpl, e.currentTarget) },
          h("div.home-tpl-thumb", { "aria-hidden": "true" }, templatePreviewSvg(tpl.id)),
          h("div.home-tpl-meta", {},
            h("span.home-tpl-title", {}, tpl.title),
            h("span.home-tpl-desc", {}, tpl.desc))),
        `tpl:${tpl.id}`))));
  }

  function star(c, sec) {
    return mark(h("button.star", { type: "button", "aria-pressed": c.starred ? "true" : "false", "aria-label": `${c.starred ? "Unstar" : "Star"} ${c.title || "Untitled"}`,
      title: c.starred ? "Unstar" : "Star", onclick: () => model.toggleStar(c.id) }, c.starred ? "★" : "☆"), `star:${sec}:${c.id}`);
  }
  function card(c, sec) {
    const when = c.at != null ? whenText(c.at, clock.now()) : "";
    const where = pathText(c.path);
    // ⋯ menu: Move to… only for a card whose `can.move` is true (PROTOCOL.md § Move board, "Where it appears"); the menu is kept across redraws so an open one survives a star toggle.
    const label = c.title || "Untitled";
    const menuCfg = { label: `More for ${label}`, items: [{ text: "Move to…", hidden: !move || !c.can?.move, onSelect: opener => startMove({ host: root, move, board: c.id, opener, reload: () => model.load(), restoreFocus: () => main.focus?.() }) }] };
    const menu = move && c.can?.move ? keys.keep(`menu:${sec}:${c.id}`, () => overflowMenu(menuCfg)) : null;
    menu?.update(menuCfg);
    if (menu) mark(menu.button, `menu:${sec}:${c.id}`);
    const prefix = [where, c.role].filter(Boolean).join(" · ");
    const fullMeta = [where, c.role, when].filter(Boolean).join(" · ");
    const meta = when
      ? h("span.p", { title: fullMeta },
        prefix ? h("span.card-meta-prefix", {}, prefix) : null,
        prefix ? h("span.card-meta-sep", {}, " · ") : null,
        h("span.card-when", {}, when))
      : h("span.p", { title: fullMeta }, h("span.card-meta-prefix", {}, prefix));
    const roleKey = c.role ? String(c.role).toLowerCase().replace(/[^a-z0-9-]/g, "") : "";
    const mobileActionsBtn = h("button.btn.ghost.card-mobile-actions", {
      type: "button",
      "aria-label": `Actions for ${label}`,
      "aria-haspopup": "dialog",
      "data-mobile-card-actions": c.id,
      onclick: e => openCardActionsSheet(c, e.currentTarget),
    }, "⋯");
    return h(`li.card${menu ? ".has-menu" : ""}`, {},
      mark(h("a.card-open", { href: boardHref(c.id) },
        h("div.card-preview", { "aria-hidden": "true", "data-preview-variant": String(previewVariant(c.id)) }, boardPreviewSvg(c.id)),
        h("div.card-body", {}, h("span.t", { title: label }, label), meta)), `card:${sec}:${c.id}`),
      c.role ? h("span", { class: `card-role${roleKey ? ` card-role-${roleKey}` : ""}`, "aria-hidden": "true" }, c.role) : null,
      menu ? h("span.card-menu.home-menu", {}, menu.el) : null,
      mobileActionsBtn,
      guest() ? null : star(c, sec));
  }
  const cardList = (cards, label) => h("ul.cards", { "aria-label": label }, cards.map(c => card(c, label)));
  const empty = e => h("div.home-empty", {}, h("h2", {}, e.title), e.detail ? h("p", {}, e.detail) : null);

  function renderSide() {
    const d = S.data;
    if (!d) return replace(side);
    // A Space opens its own page (?space=<id>), a Group its (?group=<id>).
    const node = s => mark(h("a.nav.sub", { href: spaceHref(s.id), title: `Open ${s.name}`, "aria-label": `Open ${s.name}` }, s.personal ? "◐ " : "▢ ", s.name), `space:${s.id}`);
    const t = d.tree;
    const dailyLinks = d.guest ? [] : [
      teamsHref ? mark(h("a.nav", { href: teamsHref }, "Teams"), "link:teams") : null,
      trashHref ? mark(h("a.nav", { href: trashHref }, "Trash"), "link:trash") : null,
    ].filter(Boolean);
    const hasAdminAccess = !d.guest && (d.unit?.isAdmin === true || d.can?.manageAccess === true || d.can?.manageRoles === true);
    const resolvedAdminHref = adminHref ?? ((org || rolesHref || offboardHref || unitAccessHref) ? "?admin=people" : null);
    const spaceActions = d.guest ? [] : [newSpace(), newGroup()].filter(Boolean);
    const spacesSec = (t || spaceActions.length)
      ? h("div.home-spaces-sec", {},
        h("div.home-side-head", {},
          h("span.home-side-label", {}, "Spaces"),
          spaceActions.length ? h("div.home-side-acts", {}, spaceActions) : null),
        t && h("div.tree", { role: "group", "aria-label": "Areas and Spaces" },
          t.groups.map(g => h("div.grp", {}, h("h4", {}, mark(h("a", { href: groupHref(g.id) }, g.name), `group:${g.id}`)), g.spaces.map(node))),
          t.spaces.length ? h("div.grp", {}, t.groups.length ? h("h4", {}, "Other spaces") : null, t.spaces.map(node)) : null,
          t.more ? h("p.muted", {}, "Some Spaces or boards are not listed. Use search.") : null))
      : null;
    const adminSec = hasAdminAccess && resolvedAdminHref
      ? h("div.home-admin-footer", { "data-home-admin": "true" },
        mark(h("a.nav.home-admin-link", { href: resolvedAdminHref, "data-admin-entry": "true" }, "Workspace Admin"), "link:admin"))
      : null;
    const orgName = !d.guest && d.unit ? (d.unit.name || "Your workspace") : "";
    const drawerHead = drawerOpen
      ? h("div.home-drawer-head", {},
        h("div.home-drawer-org", {},
          h("strong", {}, orgName || "Navigation"),
          orgName ? h("span.home-drawer-org-pill", { "data-drawer-org-badge": "true" }, d.unit?.personal ? "Personal workspace" : "Organization") : null),
        h("button.btn.ghost.home-drawer-close", { type: "button", "aria-label": "Close navigation", onclick: () => setDrawer(false, true) }, "✕"))
      : null;
    const isDarkTheme = themeToggle.el.getAttribute?.("aria-pressed") === "true";
    const drawerFoot = drawerOpen
      ? h("div.home-drawer-foot", { "data-drawer-footer": "true" },
        h("button.nav", {
          type: "button",
          "data-drawer-action": "help",
          "aria-label": "Help & shortcuts",
          onclick: e => openHelp(e?.currentTarget ?? drawerToggle),
        }, icon("help", { size: 16 }), "Help & shortcuts"),
        h("button.nav", {
          type: "button",
          "data-drawer-action": "theme",
          "aria-label": isDarkTheme ? "Switch to light mode" : "Switch to dark mode",
          "aria-pressed": String(isDarkTheme),
          onclick: () => { themeToggle.el.click?.(); renderSide(); },
        }, icon(isDarkTheme ? "sun" : "moon", { size: 16 }), isDarkTheme ? "Light mode" : "Dark mode"),
        onLogout && S.status !== "signed-out"
          ? h("button.nav", {
            type: "button",
            "data-drawer-action": "logout",
            "aria-label": "Sign out",
            onclick: () => { setDrawer(false, false); onLogout(); },
          }, icon("logout", { size: 16 }), "Sign out")
          : null)
      : null;
    replace(side,
      drawerHead,
      d.guest ? null : newBoard(),
      h("div.home-nav-group", {}, navBtn("home", "Home"), d.guest ? null : navBtn("starred", "Starred", d.starred.length), navBtn("shared", "Shared with me", d.shared.length), dailyLinks),
      spacesSec,
      adminSec,
      drawerFoot);
  }

  function renderMobileChrome() {
    const d = S.data;
    if (!d) {
      replace(mobileTabs);
      replace(fabHost);
      return;
    }
    const tab = (view, label, count) => h("button.home-mobile-tab", {
      type: "button",
      role: "tab",
      "data-mobile-tab": view,
      "aria-selected": S.view === view && !S.query.trim() ? "true" : "false",
      onclick: () => { search.value = ""; model.setQuery(""); model.setView(view); },
    }, label, count != null ? h("span.n", {}, String(count)) : null);
    replace(mobileTabs,
      tab("home", "Recent", null),
      d.guest ? null : tab("starred", "Starred", d.starred.length),
      tab("shared", "Shared", d.shared.length));

    const showFab = !d.guest && typeof dialogs?.newBoard === "function";
    replace(fabHost, showFab
      ? h("button.btn.primary.home-fab", {
        type: "button",
        "aria-label": "New board",
        "data-mobile-fab": "new-board",
        onclick: e => { setPendingTemplate(storage, null, clock.now()); dialogs.newBoard({ opener: e.currentTarget }); },
      }, "＋ New board")
      : null);
  }

  function renderMain() {
    if (S.status === "loading" && !S.data) return replace(main, h("p.muted", {}, "Loading…"));
    if (S.status === "error") return replace(main, empty({ title: "Could not load Home.", detail: "The server did not answer. Check your connection and try again." }), mark(h("button.btn", { type: "button", onclick: () => model.load() }, "Try again"), "retry"));
    if (S.status === "signed-out") {
      const signInButtons = signIn
        ? (Array.isArray(signIn.links) && signIn.links.length
          ? h("div.gate-links", {}, signIn.links.map((l, i) => h(i === 0 ? "a.btn.primary" : "a.btn", { href: l.href }, l.text ?? "Sign in")))
          : h("a.btn.primary", { href: signIn.href }, signIn.text ?? "Sign in"))
        : null;
      return replace(main, empty({ title: "You are signed out.", detail: "Sign in again to see your boards." }), signInButtons);
    }
    const m = model.main();
    if (!m) return replace(main);
    if (m.kind === "search") {
      return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), m.status === "loading" && !m.cards.length ? h("p.muted", {}, "Searching…")
        : m.status === "error" ? empty({ title: "Search failed.", detail: "Try again in a moment." })
          : m.cards.length ? cardList(m.cards, "Search results") : empty(m.empty),
      m.more ? h("p.muted", {}, "More boards match. Narrow the search.") : null);
    }
    const guestCreate = guest() && org ? orgCreateCard : null;
    const templates = renderTemplates();
    if (m.sections) {
      const shown = m.sections.filter(s => s.cards.length);
      return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), templates, shown.length ? shown.map(s => h("section", { "aria-label": s.title }, h("h2.sec", {}, s.title), cardList(s.cards, s.title))) : empty(m.empty), guestCreate);
    }
    return replace(main, mark(h("h1", { tabindex: "-1" }, m.title), "heading"), templates, m.cards.length ? cardList(m.cards, m.title) : empty(m.empty), guestCreate);
  }

  function render() { keys.around(draw); }
  function draw() {
    renderSide();
    renderMobileChrome();
    renderMain();
    who.textContent = S.data ? S.data.user.name : "";
    if (logoutBtn) logoutBtn.hidden = S.status === "signed-out";
    const orgName = S.data && !S.data.guest && S.data.unit ? (S.data.unit.name || "Your workspace") : "";
    orgBadge.textContent = orgName;
    orgBadge.title = orgName ? `Workspace: ${orgName}` : "";
    status.textContent = S.notice ?? "";
    status.hidden = !S.notice;
    if (S.notice) status.append(" ", mark(h("button.btn.ghost", { type: "button", onclick: () => model.dismissNotice() }, "Dismiss"), "dismiss"));
  }
  const unsub = model.subscribe(render);
  const isTypingTarget = el => {
    for (let x = el; x; x = x.parentNode ?? null) {
      const tag = typeof x.tagName === "string" ? x.tagName : "";
      if (/^(input|textarea|select)$/i.test(tag) || x.isContentEditable === true) return true;
      const ce = x.getAttribute?.("contenteditable");
      if (ce != null && String(ce).toLowerCase() !== "false") return true;
    }
    return false;
  };
  const onKey = e => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && drawerOpen) { e.preventDefault?.(); setDrawer(false, true); return; }
    const typing = isTypingTarget(e.target);
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
      if (isHelpDialogOpen(document)) {
        e.preventDefault?.();
        e.stopPropagation?.();
        closeHelpDialog({ doc: document, restoreFocus: true });
        return;
      }
      if (!hasActiveOverlay(document) && !activeCardSheet) {
        e.preventDefault?.();
        e.stopPropagation?.();
        openHelp(document.activeElement ?? helpBtn);
        return;
      }
    }
    if ((e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) || ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey)) {
      if (hasActiveOverlay(document) || activeCardSheet) return;
      e.preventDefault();
      search.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  render();
  return { destroy() { destroyed = true; closeHelpDialog({ doc: document, restoreFocus: false }); themeToggle.destroy(); closeCardSheet(); unsub(); document.removeEventListener("keydown", onKey); root.replaceChildren(); } };
}
