// @ts-check
// The Home page: a driving adapter over the DOM that renders web/core/home.js's model (Recent, Starred, Shared with me,
// the Group/Space tree, search). Part of the dom group; the composition root (web/main.js) mounts it when someone is signed in with no
// board in the link. All text goes in through textContent (titles and names are other people's words). Keyboard: "/"
// focuses search, Escape clears it, every card is a link plus a star button. Visuals are intentionally plain: #56 restyles.

import { h, replace } from "./dom.js";
import { keeper } from "./focus.js";
import { overflowMenu } from "./spaces.js";
import { startMove } from "./move.js";
import { pathText, whenText } from "../../core/home.js";
import { TEMPLATES } from "../../../packages/core/templates.js";

/** SessionStorage key holding a selected template seed while navigating to a newly created board. */
export const PENDING_TEMPLATE_KEY = "plenary:pending-template";
const PENDING_TEMPLATE_TTL_MS = 60_000;

function resolveStorage(storage) {
  if (storage) return storage;
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

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

/** Build a CSP-safe inline SVG node, falling back to an empty decorative span on minimal stub DOMs. */
function svgEl(tag, attrs = {}, kids = []) {
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") {
    return h("span", { class: attrs.class ?? "", "aria-hidden": "true" });
  }
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
}

function brandMark() {
  return h("span.home-brand-mark", { "aria-hidden": "true" },
    svgEl("svg", { viewBox: "0 0 24 24", class: "home-brand-ico", "aria-hidden": "true" }, [
      svgEl("path", { d: "M4 6a2 2 0 0 1 2-2h5v7H4V6z" }),
      svgEl("path", { d: "M13 4h5a2 2 0 0 1 2 2v5h-7V4z" }),
      svgEl("path", { d: "M4 13h7v7H6a2 2 0 0 1-2-2v-5z" }),
      svgEl("path", { d: "M13 13h7v5a2 2 0 0 1-2 2h-5v-7z" }),
    ]));
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
 *   teamsHref?: string | null, trashHref?: string | null, rolesHref?: string | null, offboardHref?: string | null, unitAccessHref?: ((id: string) => string) | null,
 *   move?: { port: import("../../ports/move.js").MovePort, clock: import("../../ports/clock.js").Clock, newKey?: (() => string)|null }|null,
 *   org?: Pick<import("../../ports/admin.js").AdminPort, "createTenant"|"listTenantMembers"|"addTenantMember"|"removeTenantMember"|"adminAudit"> | null,
 *   storage?: import("../../ports/storage.js").Storage | null,
 *   onLogout?: (() => void) | null,
 *   dialogs: Pick<ReturnType<typeof import("./dialogs.js").createDialogs>, "newBoard"|"newSpace"|"newGroup">, homeHref?: string, signIn?: { href: string, text?: string, links?: Array<{ href: string, text?: string }> } | null }} o
 * @returns {{ destroy(): void }}
 */
export function mountHome({ root, model, clock, boardHref, spaceHref, groupHref, teamsHref = null, trashHref = null, rolesHref = null, offboardHref = null, unitAccessHref = null, dialogs, homeHref = "./", signIn = null, move = null, org = null, storage = null, onLogout = null }) {
  const S = model.state, keys = keeper(), mark = keys.mark;
  let destroyed = false;
  /** @type {null|"members"|"audit"} */ let panel = null;
  let adminOpen = false;
  let drawerOpen = false;
  let orgBusy = false;
  /** @type {null | { close: () => void }} */ let activeCardSheet = null;
  const mem = { status: "idle", tenant: null, members: [], admins: [], directory: [], busy: false, removing: null, seq: 0 };
  const audit = { status: "idle", tenant: null, events: [], nextBefore: null, loadingMore: false, seq: 0 };

  const status = h("div.home-status", { role: "status", "aria-live": "polite" });
  const search = h("input.home-search", { type: "search", placeholder: "Search boards and Spaces", "aria-label": "Search boards and Spaces", autocomplete: "off", maxlength: "100", spellcheck: "false",
    oninput: e => { panel = null; model.setQuery(e.target.value); },
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
  const logoutBtn = onLogout
    ? mark(h("button.btn.ghost.home-logout", { type: "button", "data-action": "logout", "aria-label": "Sign out", onclick: () => onLogout() }, "Sign out"), "logout")
    : null;
  const orgBadge = h("span.home-org-badge");
  const top = h("header.home-top", {},
    drawerToggle,
    h("a.logo", { href: homeHref, "aria-label": "Plenary home" }, brandMark(), "Plenary"),
    orgBadge,
    h("div.home-searchbox", { role: "search" }, search, h("kbd", { "aria-hidden": "true" }, "/ or ⌘K")),
    h("span.spacer"), who, logoutBtn);
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

  // Persistent inputs for self-serve Workspace creation and Members add-by-email (kept across redraws so typing never loses focus).
  const orgNameInput = h("input.field.home-org-input", { type: "text", maxlength: "80", autocomplete: "off", placeholder: "Workspace name (e.g. My Studio)", "aria-label": "Workspace name" });
  const orgCreateBtn = h("button.btn.primary.home-org-btn", { type: "submit" }, "Create Workspace");
  const orgCreateErr = h("p.sp-error", { role: "alert" });
  const orgCreateCard = h("section.home-org-card", { "aria-label": "Create your own Workspace" },
    h("h2", {}, "Create your own Workspace"),
    h("p.muted", {}, "Start a personal workspace to create boards, Spaces, and invite collaborators by email."),
    h("form.home-org-form", { onsubmit: e => { e.preventDefault?.(); submitCreateOrg(); } }, orgNameInput, orgCreateBtn),
    orgCreateErr);

  const memEmailInput = h("input.field.home-org-input", { type: "email", maxlength: "320", autocomplete: "off", placeholder: "friend@gmail.com", "aria-label": "Collaborator email" });
  const memAddBtn = h("button.btn.primary.home-org-btn", { type: "submit" }, "Add by email");
  const memErr = h("p.sp-error", { role: "alert" });
  const memAddForm = h("form.home-org-form", { onsubmit: e => { e.preventDefault?.(); submitAddMember(); } }, memEmailInput, memAddBtn);

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

  async function loadMembers(tenantId) {
    if (!org || !tenantId) return;
    const seq = ++mem.seq;
    mem.tenant = tenantId;
    if (mem.status !== "ready") mem.status = "loading";
    render();
    try {
      const r = await org.listTenantMembers(tenantId);
      if (destroyed || seq !== mem.seq) return;
      mem.members = Array.isArray(r?.members) ? r.members : [];
      mem.admins = Array.isArray(r?.admins) ? r.admins : [];
      mem.directory = Array.isArray(r?.directory) ? r.directory : [];
      mem.status = "ready";
    } catch {
      if (destroyed || seq !== mem.seq) return;
      mem.status = "error";
    }
    render();
  }

  function openMembers() {
    const id = S.data?.unit?.id;
    if (!id || !org) return;
    panel = "members";
    memErr.textContent = "";
    loadMembers(id);
  }

  async function submitAddMember() {
    const tenantId = S.data?.unit?.id;
    if (!org || !tenantId || mem.busy) return;
    const email = String(memEmailInput.value ?? "").trim();
    if (!email) { memErr.textContent = "Enter an email address."; memEmailInput.focus?.(); return; }
    mem.busy = true; memErr.textContent = ""; memAddBtn.disabled = true; memAddBtn.textContent = "Adding…";
    try {
      const r = await org.addTenantMember(tenantId, email);
      if (destroyed) return;
      memEmailInput.value = "";
      model.notify(`Added ${r?.email || email}.`);
      await loadMembers(tenantId);
    } catch (e) {
      if (destroyed) return;
      memErr.textContent = e?.message || "Could not add member.";
    } finally {
      mem.busy = false; memAddBtn.disabled = false; memAddBtn.textContent = "Add by email";
    }
  }

  async function removeMember(email) {
    const tenantId = S.data?.unit?.id;
    if (!org || !tenantId || mem.removing) return;
    mem.removing = email; memErr.textContent = "";
    render();
    try {
      await org.removeTenantMember(tenantId, email);
      if (destroyed) return;
      model.notify(`Removed ${email}.`);
      await loadMembers(tenantId);
    } catch (e) {
      if (destroyed) return;
      memErr.textContent = e?.message || "Could not remove member.";
    } finally {
      mem.removing = null;
      if (!destroyed) render();
    }
  }

  async function loadAudit(tenantId, { before = null, append = false } = {}) {
    if (!org || typeof org.adminAudit !== "function" || !tenantId) return;
    const seq = ++audit.seq;
    audit.tenant = tenantId;
    if (append) audit.loadingMore = true;
    else audit.status = "loading";
    render();
    try {
      const r = await org.adminAudit({ tenant: tenantId, limit: 50, ...(before ? { before } : {}) });
      if (destroyed || seq !== audit.seq) return;
      const evs = Array.isArray(r?.events) ? r.events : [];
      audit.events = append ? [...audit.events, ...evs] : evs;
      audit.nextBefore = r?.nextBefore ?? null;
      audit.status = "ready";
    } catch {
      if (destroyed || seq !== audit.seq) return;
      if (!append) audit.status = "error";
      else model.notify("Could not load more audit events.");
    } finally {
      audit.loadingMore = false;
      if (!destroyed) render();
    }
  }

  function openAudit() {
    const id = S.data?.unit?.id;
    if (!id || !org || typeof org.adminAudit !== "function") return;
    panel = "audit";
    loadAudit(id);
  }

  const guest = () => !!S.data?.guest;
  // Every control that can hold focus is marked with a stable key, so a redraw (a star toggled, a view picked, a load, a notice) puts focus back.
  const newBoard = () => mark(h("button.btn.primary.home-new-board", { type: "button", onclick: e => { setPendingTemplate(storage, null, clock.now()); dialogs.newBoard({ opener: e.currentTarget }); } }, "＋ New board"), "new-board");
  const newSpace = () => mark(h("button.btn.home-side-add", { type: "button", title: "New space", "aria-label": "New space", onclick: e => dialogs.newSpace({ opener: e.currentTarget }) }, "＋", h("span.sr-only", {}, " New space")), "new-space");
  const newGroup = () => (S.data?.can?.createGroup ? mark(h("button.btn.home-side-add", { type: "button", title: "New area", "aria-label": "New area", onclick: e => dialogs.newGroup({ opener: e.currentTarget }) }, "＋", h("span.sr-only", {}, " New area")), "new-group") : null);
  const navBtn = (view, label, count) => mark(h("button.nav", { type: "button", "aria-current": S.view === view && !panel && !S.query.trim() ? "page" : null,
    onclick: () => { panel = null; search.value = ""; model.setQuery(""); model.setView(view); setDrawer(false); } }, label, count != null ? h("span.n", {}, String(count)) : null), `nav:${view}`);

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
    if (guest() || S.view !== "home" || panel || S.query.trim() || typeof dialogs?.newBoard !== "function") return null;
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
    const canMembers = !d.guest && !!org && d.unit?.isAdmin === true;
    const canAudit = !d.guest && !!org && typeof org.adminAudit === "function" && d.unit?.isAdmin === true;
    const membersBtn = canMembers
      ? mark(h("button.nav", { type: "button", "aria-current": panel === "members" && !S.query.trim() ? "page" : null,
        onclick: () => { search.value = ""; model.setQuery(""); openMembers(); } }, "Members"), "nav:members")
      : null;
    const auditBtn = canAudit
      ? mark(h("button.nav", { type: "button", "aria-current": panel === "audit" && !S.query.trim() ? "page" : null,
        onclick: () => { search.value = ""; model.setQuery(""); openAudit(); } }, "Audit log"), "nav:audit")
      : null;
    const dailyLinks = d.guest ? [] : [
      teamsHref ? mark(h("a.nav", { href: teamsHref }, "Teams"), "link:teams") : null,
      trashHref ? mark(h("a.nav", { href: trashHref }, "Trash"), "link:trash") : null,
    ].filter(Boolean);
    const adminLinks = d.guest ? [] : [
      membersBtn,
      unitAccessHref && d.unit && d.can?.manageAccess ? mark(h("a.nav", { href: unitAccessHref(d.unit.id) }, "Organization access"), "link:unit-access") : null,
      rolesHref && d.can?.manageRoles ? mark(h("a.nav", { href: rolesHref }, "Roles"), "link:roles") : null,
      auditBtn,
      offboardHref && d.can?.manageAccess ? mark(h("a.nav", { href: offboardHref }, "Offboard a member"), "link:offboard") : null,
    ].filter(Boolean);
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
    const adminSec = adminLinks.length
      ? h("details.home-admin", { "data-home-admin": "true", open: adminOpen || panel === "members" || panel === "audit",
        ontoggle: e => { adminOpen = Boolean(e.currentTarget?.open); } },
      h("summary.home-admin-summary", {}, "Workspace Admin"),
      h("div.home-admin-list", {}, adminLinks))
      : null;
    const drawerHead = drawerOpen
      ? h("div.home-drawer-head", {},
        h("strong", {}, d.unit?.name || "Navigation"),
        h("button.btn.ghost.home-drawer-close", { type: "button", "aria-label": "Close navigation", onclick: () => setDrawer(false, true) }, "✕"))
      : null;
    replace(side,
      drawerHead,
      d.guest ? null : newBoard(),
      h("div.home-nav-group", {}, navBtn("home", "Home"), d.guest ? null : navBtn("starred", "Starred", d.starred.length), navBtn("shared", "Shared with me", d.shared.length), dailyLinks),
      spacesSec,
      adminSec);
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
      "aria-selected": S.view === view && !panel && !S.query.trim() ? "true" : "false",
      onclick: () => { panel = null; search.value = ""; model.setQuery(""); model.setView(view); },
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

  function renderMembersPanel() {
    const d = S.data, isPersonal = d?.unit?.personal === true;
    const unitName = d?.unit?.name || (isPersonal ? "Personal Workspace" : "Your workspace");
    const hasLoaded = mem.members.length || mem.admins.length || mem.directory.length;
    const collaboratorsSec = (alwaysShow) => (alwaysShow || mem.members.length
      ? h("section", { "aria-label": "Collaborators" },
        h("h2.sec", {}, `Collaborators (${mem.members.length})`),
        mem.members.length
          ? h("ul.rows", {}, mem.members.map(email => h("li.row", {},
            h("span.who", {}, email),
            mark(h("button.btn.home-org-btn", { type: "button", disabled: mem.removing === email,
              "aria-label": `Remove ${email}`, onclick: () => removeMember(email) },
            mem.removing === email ? "Removing…" : "Remove"), `member-rm:${email}`))))
          : h("p.muted", {}, "No collaborators added yet."))
      : null);
    let body;
    if (mem.status === "loading" && !hasLoaded) {
      body = h("p.muted", {}, "Loading members…");
    } else if (mem.status === "error") {
      body = [empty({ title: "Could not load members.", detail: "Check your connection and try again." }),
        mark(h("button.btn.home-org-btn", { type: "button", onclick: () => loadMembers(d.unit.id) }, "Try again"), "members-retry")];
    } else if (isPersonal) {
      body = [
        mem.admins.length ? h("section", { "aria-label": "Admins" },
          h("h2.sec", {}, "Admins"),
          h("ul.rows", {}, mem.admins.map(a => h("li.row", {}, h("span.who", {}, a), h("span.badge", {}, "Admin"))))) : null,
        collaboratorsSec(true),
      ];
    } else {
      const dirEmails = new Set(mem.directory.map(p => (p.email ? String(p.email).toLowerCase() : null)).filter(Boolean));
      const pendingAdmins = mem.admins.filter(a => !dirEmails.has(String(a).toLowerCase()));
      body = [
        h("section", { "aria-label": "Organization members" },
          h("h2.sec", {}, `Members (${mem.directory.length})`),
          mem.directory.length
            ? h("ul.rows", {}, mem.directory.map(p => h("li.row", {},
              h("span.who", {}, p.name, p.email && p.email !== p.name ? [" ", h("span.muted", {}, p.email)] : null),
              p.isAdmin ? h("span.badge", {}, "Admin") : null)))
            : (!pendingAdmins.length ? h("p.muted", {}, "No members have signed in yet.") : null)),
        pendingAdmins.length ? h("section", { "aria-label": "Admins" },
          h("h2.sec", {}, "Admins"),
          h("ul.rows", {}, pendingAdmins.map(a => h("li.row", {}, h("span.who", {}, a), h("span.badge", {}, "Admin"))))) : null,
        collaboratorsSec(false),
      ];
    }
    const sub = isPersonal
      ? `${unitName} — add collaborators by email so they can open shared Spaces and boards.`
      : `${unitName} — organization members who have signed in with your workspace domain.`;
    return replace(main,
      mark(h("h1", { tabindex: "-1" }, "Workspace members"), "heading"),
      h("p.home-panel-sub", {}, sub),
      isPersonal ? memAddForm : null, memErr, body);
  }

  function renderAuditPanel() {
    const d = S.data, unitName = d?.unit?.name || "your workspace";
    const refresh = mark(h("button.btn.home-org-btn", { type: "button", disabled: audit.status === "loading",
      onclick: () => loadAudit(d.unit.id) }, "Refresh"), "audit-refresh");
    const body = audit.status === "loading" && !audit.events.length
      ? h("p.muted", {}, "Loading audit log…")
      : audit.status === "error"
        ? [empty({ title: "Could not load audit log.", detail: "Check your connection and try again." }),
          mark(h("button.btn.home-org-btn", { type: "button", onclick: () => loadAudit(d.unit.id) }, "Try again"), "audit-retry")]
        : audit.events.length
          ? [
            h("ul.rows.home-audit-list", { "aria-label": "Audit log events" }, audit.events.map(ev => h("li.row", {},
              h("span.badge", {}, String(ev.action ?? "")),
              h("span.who", {}, [ev.actor, ev.board ? `board ${ev.board}` : (ev.target ? `target ${ev.target}` : null)].filter(Boolean).join(" · ")),
              h("span.muted", {}, whenText(ev.at, clock.now()))))),
            audit.nextBefore ? mark(h("button.btn.home-org-btn", { type: "button", disabled: audit.loadingMore,
              onclick: () => loadAudit(d.unit.id, { before: audit.nextBefore, append: true }) },
            audit.loadingMore ? "Loading…" : "Load more"), "audit-more") : null,
          ]
          : h("p.muted", {}, "No audit events yet.");
    return replace(main,
      h("div.home-panel-head", {}, mark(h("h1", { tabindex: "-1" }, "Audit log"), "heading"), refresh),
      h("p.home-panel-sub", {}, `Recent activity in ${unitName}.`),
      body);
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
    if (!S.query.trim() && panel === "members" && S.data && !S.data.guest && S.data.unit?.isAdmin && org) return renderMembersPanel();
    if (!S.query.trim() && panel === "audit" && S.data && !S.data.guest && S.data.unit?.isAdmin && org && typeof org.adminAudit === "function") return renderAuditPanel();
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
  const onKey = e => {
    if (e.key === "Escape" && drawerOpen) { e.preventDefault?.(); setDrawer(false, true); return; }
    const typing = /^(input|textarea|select)$/i.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
    if ((e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) || ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey)) { e.preventDefault(); search.focus(); }
  };
  document.addEventListener("keydown", onKey);
  render();
  return { destroy() { destroyed = true; closeCardSheet(); unsub(); document.removeEventListener("keydown", onKey); root.replaceChildren(); } };
}
