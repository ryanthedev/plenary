// @ts-check
/**
 * @module web/adapters/dom/admin-shell
 * Unified Enterprise Workspace Admin Shell & multi-level admin section views:
 * - Persistent 240px left navigation rail (slide-out drawer <= 640px) with 6 sections:
 *   People, Teams, Areas & Spaces, Roles & Permissions, Offboarding, Audit & Compliance.
 * - Zero accidental exits to Home: explicit `← Back to Workspace` button is the only exit;
 *   Plenary logo stays on `?admin=people`; no Home board-search bar.
 * - People directory with debounced server search, role chips, cursor pagination,
 *   domain-validated Add Admin by email, Pending Admins strip with Revoke, inline
 *   Make/Remove Workspace Admin with confirmation & 409 last-admin guard, and User Detail Drawer.
 * - Areas & Spaces overview with filters and 2-click "Manage access" links.
 * - Audit & Compliance with filterable audit log, Export Workspace Data, and GDPR User Erasure.
 */

import { h, replace } from "./dom.js";
import { announce } from "./focus.js";
import { openDialog } from "./dialogs.js";
import { brandMark, avatarEl, roleTone, auditTone, message } from "./spaces.js";
import { createThemeToggle } from "./theme.js";
import { act, setOff } from "./access.js";
import { whenText } from "../../core/home.js";

/** Ordered navigation sections for the Workspace Admin rail. */
export const ADMIN_SECTIONS = Object.freeze([
  Object.freeze({ id: "people", label: "People" }),
  Object.freeze({ id: "teams", label: "Teams" }),
  Object.freeze({ id: "spaces", label: "Areas & Spaces" }),
  Object.freeze({ id: "roles", label: "Roles & Permissions" }),
  Object.freeze({ id: "offboard", label: "Offboarding" }),
  Object.freeze({ id: "audit", label: "Audit & Compliance" }),
]);

/** @type {Set<string>} */
const SECTION_IDS = new Set(ADMIN_SECTIONS.map(s => s.id));

/** Normalize any `?admin=` query value to a valid section id (default `"people"`). */
export function normalizeAdminSection(raw) {
  const k = String(raw ?? "").trim().toLowerCase();
  return SECTION_IDS.has(k) ? k : "people";
}

function adminLink(hrefs, section, extra = null) {
  if (typeof hrefs?.admin === "function") return hrefs.admin(section, extra ?? undefined);
  const sp = new URLSearchParams({ admin: section });
  if (extra) for (const [k, v] of Object.entries(extra)) if (v != null && v !== "") sp.set(k, String(v));
  return `?${sp.toString()}`;
}

/**
 * Render the shared Workspace Admin Shell (topbar + left nav rail + status + main).
 * @param {{
 *   root: HTMLElement,
 *   section: string,
 *   hrefs: { home: string, admin?: (sec: string, extra?: Record<string, string>) => string },
 *   workspaceName?: string | null,
 *   themeCtrl?: import("./theme.js").ThemeController | null,
 *   onLogout?: (() => void) | null,
 *   onNavigate?: ((section: string) => void) | null,
 * }} o
 */
export function adminShell({ root, section, hrefs, workspaceName = null, themeCtrl = null, onLogout = null, onNavigate = null }) {
  let active = normalizeAdminSection(section);
  let drawerOpen = false;

  const status = h("div.home-status", { role: "status", "aria-live": "polite", hidden: true });
  const main = h("main.home-main.sp-main.admin-main", { id: "admin-main", tabindex: "-1" });
  const wsBadge = h("span.admin-ws-badge", {}, workspaceName || "Workspace Admin");
  const drawerToggle = h("button.btn.ghost.admin-drawer-toggle", {
    type: "button",
    "aria-label": "Open admin navigation",
    "aria-expanded": "false",
    "aria-controls": "admin-rail",
    "data-admin-drawer-toggle": "true",
    onclick: () => setDrawer(!drawerOpen),
  }, "☰");
  const drawerBackdrop = h("div.admin-drawer-backdrop", {
    "aria-hidden": "true",
    hidden: true,
    onclick: () => setDrawer(false, true),
  });

  const navLinks = new Map();
  const railList = h("div.admin-rail-list", { role: "list" }, ADMIN_SECTIONS.map(sec => {
    const a = h("a.admin-nav-item", {
      role: "listitem",
      href: adminLink(hrefs, sec.id),
      "data-admin-nav": sec.id,
      "aria-current": sec.id === active ? "page" : null,
      onclick: e => {
        if (drawerOpen) setDrawer(false, false);
        if (typeof onNavigate === "function") {
          e.preventDefault?.();
          setActiveSection(sec.id);
          onNavigate(sec.id);
        }
      },
    }, sec.label);
    navLinks.set(sec.id, a);
    return a;
  }));

  const railHead = h("div.admin-rail-head", {},
    h("span.admin-rail-title", {}, "Workspace Admin"),
    h("button.btn.ghost.admin-rail-close", {
      type: "button",
      "aria-label": "Close admin navigation",
      onclick: () => setDrawer(false, true),
    }, "✕"));

  const rail = h("nav.admin-rail", {
    id: "admin-rail",
    "aria-label": "Workspace Admin navigation",
    "data-drawer-open": "false",
  }, railHead, railList);

  const themeToggle = createThemeToggle({ themeCtrl });
  const backBtn = h("a.btn.admin-back-btn", {
    href: hrefs.home,
    "data-admin-back": "true",
  }, "← Back to Workspace");
  const logoutBtn = typeof onLogout === "function"
    ? h("button.btn.ghost.home-logout", {
      type: "button",
      "data-action": "logout",
      "aria-label": "Sign out",
      onclick: () => onLogout(),
    }, "Sign out")
    : null;

  const top = h("header.home-top.admin-top", {},
    drawerToggle,
    h("a.logo", { href: adminLink(hrefs, "people"), "aria-label": "Plenary Workspace Admin" }, brandMark(), "Plenary"),
    wsBadge,
    h("span.spacer"),
    backBtn,
    themeToggle.el,
    logoutBtn);

  const page = h("div.home.sp-page.admin-shell-page", { "data-admin-shell": "true" },
    top,
    status,
    drawerBackdrop,
    h("div.admin-body", {}, rail, main));
  root.replaceChildren(page);

  function setDrawer(open, refocus = false) {
    drawerOpen = Boolean(open);
    rail.setAttribute("data-drawer-open", drawerOpen ? "true" : "false");
    drawerToggle.setAttribute("aria-expanded", drawerOpen ? "true" : "false");
    drawerToggle.setAttribute("aria-label", drawerOpen ? "Close admin navigation" : "Open admin navigation");
    drawerBackdrop.hidden = !drawerOpen;
    if (!drawerOpen && refocus) drawerToggle.focus?.();
  }

  function setActiveSection(next) {
    active = normalizeAdminSection(next);
    for (const [id, el] of navLinks) {
      if (id === active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
  }

  function setWorkspaceName(name) {
    wsBadge.textContent = name || "Workspace Admin";
  }

  function setNotice(text) {
    status.textContent = text ?? "";
    status.hidden = !text;
    if (text) {
      status.append(" ", h("button.btn.ghost", { type: "button", onclick: () => setNotice("") }, "Dismiss"));
    }
  }

  const onKey = e => {
    if (e.key === "Escape" && drawerOpen) {
      e.preventDefault?.();
      setDrawer(false, true);
    }
  };
  globalThis.document?.addEventListener?.("keydown", onKey);

  return {
    status,
    main,
    rail,
    setWorkspaceName,
    setActiveSection,
    setNotice,
    setDrawer,
    destroyTheme: themeToggle.destroy,
    destroy() {
      globalThis.document?.removeEventListener?.("keydown", onKey);
      themeToggle.destroy();
      root.replaceChildren();
    },
  };
}

function tierLabel(tier) {
  if (tier === "personal") return "Content Admin (Personal)";
  if (tier === "shared") return "Content Admin";
  return "None";
}

function errorMessage(err, fallback) {
  if (err?.code === "last-admin" || err?.status === 409 && /last/i.test(String(err?.message ?? ""))) {
    return "Cannot remove the last Workspace Admin. Promote another member first.";
  }
  if (err?.code === "removed") {
    return "Cannot promote an offboarded member.";
  }
  return err?.message || fallback;
}

/**
 * People section (`?admin=people`): directory with debounced search, role filter chips,
 * cursor pagination, Add Admin by email, Pending Admins with Revoke, inline Make/Remove
 * Workspace Admin with confirmation dialog, and User Detail Drawer.
 * @param {{
 *   root: HTMLElement,
 *   chrome: ReturnType<typeof adminShell>,
 *   org: import("../../ports/admin.js").AdminPort,
 *   tenant: { id: string, name?: string | null, domain?: string | null, personal?: boolean } | null,
 *   hrefs: { home: string, team?: (id: string) => string, access?: (type: string, id: string) => string, admin?: (sec: string, extra?: Record<string, string>) => string },
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 *   delayMs?: number,
 * }} o
 */
export function mountAdminPeople({ root, chrome, org, tenant, hrefs, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = id => clearTimeout(id), delayMs = 220 }) {
  const { main } = chrome;
  let destroyed = false;
  let status = "loading";
  let query = "";
  /** @type {"all" | "admin" | "content" | "member" | "removed"} */
  let chip = "all";
  let directory = [];
  let pendingAdmins = [];
  let collaborators = [];
  let nextCursor = null;
  let loadingMore = false;
  let busyUser = null;
  let revokingEmail = null;
  let showAddAdmin = false;
  let addAdminBusy = false;
  let addAdminError = "";
  let addAdminSuccess = "";
  let collabBusy = false;
  let collabError = "";
  let inlineError = "";
  let searchTimer = null;
  let seq = 0;

  // Drawer state
  let drawerUser = null;
  let drawerStatus = "idle";
  let drawerSummary = null;
  let drawerError = "";
  let drawerOpener = null;
  let drawerSeq = 0;

  // Persistent inputs (keep focus & caret across redraws)
  const searchInput = h("input.field.admin-search-input", {
    type: "search",
    "aria-label": "Search people",
    placeholder: "Search by name or email",
    autocomplete: "off",
    maxlength: "100",
    oninput: e => {
      query = e.target.value;
      if (searchTimer) clearTimer(searchTimer);
      searchTimer = setTimer(() => load({ reset: true }), delayMs);
    },
  });
  const addAdminEmailInput = h("input.field", {
    type: "email",
    "aria-label": "Admin email",
    placeholder: tenant?.domain ? `name@${tenant.domain}` : "name@example.com",
    autocomplete: "off",
    maxlength: "320",
  });
  const collabEmailInput = h("input.field", {
    type: "email",
    "aria-label": "Collaborator email",
    placeholder: "collaborator@gmail.com",
    autocomplete: "off",
    maxlength: "320",
  });

  const serverRoleForChip = c => (c === "content" ? "all" : c);

  async function load({ reset = true } = {}) {
    if (!tenant?.id) {
      status = "forbidden";
      render();
      return;
    }
    const mySeq = ++seq;
    if (reset) {
      if (status !== "ready") status = "loading";
      inlineError = "";
    } else {
      loadingMore = true;
    }
    render();
    try {
      const res = await org.listTenantMembers(tenant.id, {
        q: query.trim() || null,
        role: serverRoleForChip(chip),
        after: reset ? null : nextCursor,
        limit: 50,
      });
      if (destroyed || mySeq !== seq) return;
      const rows = Array.isArray(res?.directory) ? res.directory : [];
      directory = reset ? rows : [...directory, ...rows];
      pendingAdmins = Array.isArray(res?.pendingAdmins) ? res.pendingAdmins : [];
      collaborators = Array.isArray(res?.members) ? res.members : [];
      nextCursor = res?.nextCursor ?? null;
      status = "ready";
    } catch (e) {
      if (destroyed || mySeq !== seq) return;
      if (e?.status === 403 || e?.code === "forbidden") status = "forbidden";
      else if (reset) status = "error";
      else inlineError = errorMessage(e, "Could not load more people.");
    } finally {
      loadingMore = false;
      if (!destroyed) render();
    }
  }

  async function submitAddAdmin() {
    if (!tenant?.id || addAdminBusy) return;
    const email = String(addAdminEmailInput.value ?? "").trim();
    if (!email) {
      addAdminError = "Enter an email address.";
      render();
      addAdminEmailInput.focus?.();
      return;
    }
    addAdminBusy = true;
    addAdminError = "";
    addAdminSuccess = "";
    render();
    try {
      const res = await org.addTenantAdmin(tenant.id, { email });
      if (destroyed) return;
      addAdminEmailInput.value = "";
      addAdminSuccess = res?.pending
        ? `Pre-provisioned ${res.email || email} as a pending Workspace Admin.`
        : `Promoted ${res?.email || email} to Workspace Admin.`;
      chrome.setNotice(addAdminSuccess);
      announce(addAdminSuccess);
      await load({ reset: true });
    } catch (e) {
      if (destroyed) return;
      addAdminError = errorMessage(e, "Could not add Workspace Admin.");
    } finally {
      addAdminBusy = false;
      if (!destroyed) render();
    }
  }

  async function revokePendingAdmin(email) {
    if (!tenant?.id || revokingEmail) return;
    revokingEmail = email;
    inlineError = "";
    render();
    try {
      await org.removeTenantAdmin(tenant.id, `email:${email}`);
      if (destroyed) return;
      const msg = `Revoked pending Workspace Admin invite for ${email}.`;
      chrome.setNotice(msg);
      announce(msg);
      await load({ reset: true });
    } catch (e) {
      if (destroyed) return;
      inlineError = errorMessage(e, "Could not revoke pending admin.");
    } finally {
      revokingEmail = null;
      if (!destroyed) render();
    }
  }

  function confirmAdminToggle(person, promote, opener) {
    const name = person.name || person.email || person.user;
    const title = promote ? `Make ${name} a Workspace Admin?` : `Remove Workspace Admin from ${name}?`;
    const bodyText = promote
      ? "Workspace Admins can manage people, teams, roles, offboarding, and compliance across the Workspace. This is management-only scope: they do not automatically see private board contents."
      : "They will immediately lose Workspace Admin permissions and their active session will be revoked. Their direct Area, Space, and board access will remain unchanged.";
    const go = h("button.btn", { class: promote ? "primary" : "btn-danger", type: "submit" }, promote ? "Make Workspace Admin" : "Remove Admin");
    const cancel = h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel");
    const d = openDialog({
      host: root,
      title,
      opener,
      body: [h("p", {}, bodyText)],
      footer: [cancel, go],
      onSubmit: async () => {
        d.close();
        await runAdminToggle(person, promote);
      },
    });
  }

  async function runAdminToggle(person, promote) {
    if (!tenant?.id || busyUser) return;
    busyUser = person.user;
    inlineError = "";
    drawerError = "";
    render();
    try {
      if (promote) await org.addTenantAdmin(tenant.id, { userId: person.user });
      else await org.removeTenantAdmin(tenant.id, person.user);
      if (destroyed) return;
      const msg = promote
        ? `${person.name || person.email} is now a Workspace Admin.`
        : `Removed Workspace Admin from ${person.name || person.email}.`;
      chrome.setNotice(msg);
      announce(msg);
      await load({ reset: true });
      if (drawerUser === person.user) await openDrawer(person.user, drawerOpener);
    } catch (e) {
      if (destroyed) return;
      const msg = errorMessage(e, promote ? "Could not promote member." : "Could not remove Workspace Admin.");
      inlineError = msg;
      if (drawerUser === person.user) drawerError = msg;
      announce(msg);
    } finally {
      busyUser = null;
      if (!destroyed) render();
    }
  }

  async function openDrawer(userId, opener = null) {
    if (!tenant?.id) return;
    drawerUser = userId;
    drawerOpener = opener;
    drawerStatus = "loading";
    drawerError = "";
    drawerSummary = null;
    const mySeq = ++drawerSeq;
    render();
    try {
      const summary = await org.getTenantMemberSummary(tenant.id, userId);
      if (destroyed || mySeq !== drawerSeq) return;
      drawerSummary = summary;
      drawerStatus = "ready";
    } catch (e) {
      if (destroyed || mySeq !== drawerSeq) return;
      drawerStatus = "error";
      drawerError = errorMessage(e, "Could not load member details.");
    }
    if (!destroyed) render();
  }

  function closeDrawer(refocus = true) {
    const op = drawerOpener;
    drawerUser = null;
    drawerSummary = null;
    drawerStatus = "idle";
    drawerError = "";
    drawerOpener = null;
    render();
    if (refocus) op?.focus?.();
  }

  async function submitAddCollaborator() {
    if (!tenant?.id || collabBusy) return;
    const email = String(collabEmailInput.value ?? "").trim();
    if (!email) { collabError = "Enter an email address."; render(); return; }
    collabBusy = true; collabError = ""; render();
    try {
      const r = await org.addTenantMember(tenant.id, email);
      if (destroyed) return;
      collabEmailInput.value = "";
      chrome.setNotice(`Added collaborator ${r?.email || email}.`);
      await load({ reset: true });
    } catch (e) {
      if (destroyed) return;
      collabError = errorMessage(e, "Could not add collaborator.");
    } finally {
      collabBusy = false;
      if (!destroyed) render();
    }
  }

  async function removeCollaborator(email) {
    if (!tenant?.id || collabBusy) return;
    collabBusy = true; collabError = ""; render();
    try {
      await org.removeTenantMember(tenant.id, email);
      if (destroyed) return;
      chrome.setNotice(`Removed collaborator ${email}.`);
      await load({ reset: true });
    } catch (e) {
      if (destroyed) return;
      collabError = errorMessage(e, "Could not remove collaborator.");
    } finally {
      collabBusy = false;
      if (!destroyed) render();
    }
  }

  const onKey = e => {
    if (e.key === "Escape" && drawerUser) {
      e.preventDefault?.();
      closeDrawer(true);
    }
  };
  globalThis.document?.addEventListener?.("keydown", onKey);

  function renderDrawer() {
    if (!drawerUser) return null;
    const s = drawerSummary;
    let body;
    if (drawerStatus === "loading") {
      body = h("p.muted", {}, "Loading member details…");
    } else if (drawerStatus === "error") {
      body = [h("p.sp-error", { role: "alert" }, drawerError || "Could not load member details.")];
    } else if (s) {
      const toggleBtn = !s.removed
        ? act({
          class: s.isAdmin ? "btn-danger-ghost" : "primary",
          "data-drawer-admin-toggle": "true",
          "aria-disabled": busyUser === s.user ? "true" : "false",
        }, s.isAdmin ? "Remove Admin" : "Make Workspace Admin", e => confirmAdminToggle(s, !s.isAdmin, e.currentTarget), () => busyUser === s.user)
        : null;
      const offboardLink = !s.removed
        ? h("a.btn.btn-danger-ghost", {
          href: adminLink(hrefs, "offboard", { user: s.user }),
          "data-drawer-offboard": "true",
        }, "Offboard member →")
        : null;
      body = [
        h("div.admin-drawer-identity", {},
          avatarEl(s.name || s.email || s.user),
          h("div.admin-drawer-id-text", {},
            h("strong", {}, s.name || s.user),
            s.email ? h("span.muted", {}, s.email) : null,
            h("code.admin-user-id", {}, s.user))),
        h("div.admin-drawer-badges", {},
          s.isAdmin ? h("span.badge.badge-accent", {}, "Workspace Admin") : h("span.badge", {}, "Member"),
          h("span", { class: `badge${s.contentTier !== "none" ? " badge-warn" : ""}` }, `Content access: ${tierLabel(s.contentTier)}`),
          s.removed ? h("span.badge.badge-danger", {}, "Removed") : null),
        drawerError ? h("p.sp-error", { role: "alert" }, drawerError) : null,
        h("div.admin-drawer-actions", {}, toggleBtn, offboardLink),
        h("section.admin-drawer-sec", { "aria-label": "Teams" },
          h("h3", {}, `Teams (${s.teams?.length ?? 0})`),
          s.teams?.length
            ? h("ul.rows.adm-list", {}, s.teams.map(tm => h("li.row.adm-row", {},
              hrefs.team ? h("a.who", { href: hrefs.team(tm.id) }, tm.name) : h("span.who", {}, tm.name))))
            : h("p.muted", {}, "Not a member of any team.")),
        h("section.admin-drawer-sec", { "aria-label": "Direct Area and Space grants" },
          h("h3", {}, `Direct Area & Space grants (${s.grants?.length ?? 0})`),
          s.grants?.length
            ? h("ul.rows.adm-list", {}, s.grants.map(g => h("li.row.adm-row", {},
              h("span.badge", {}, g.scopeType === "group" ? "Area" : g.scopeType === "unit" ? "Workspace" : g.scopeType === "space" ? "Space" : "Board"),
              hrefs.access ? h("a.who", { href: hrefs.access(g.scopeType, g.scopeId) }, g.scopeName) : h("span.who", {}, g.scopeName),
              h("span", { class: `role-pill role-pill-${roleTone(g.role)}` }, g.role))))
            : h("p.muted", {}, "No direct scoped grants.")),
      ];
    }
    return [
      h("div.admin-detail-backdrop", { "aria-hidden": "true", onclick: () => closeDrawer(true) }),
      h("aside.admin-detail-drawer", {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": s ? `Member details for ${s.name}` : "Member details",
        "data-user-drawer": drawerUser,
        tabindex: "-1",
      },
      h("div.admin-drawer-head", {},
        h("h2", {}, "Member details"),
        h("button.btn.ghost", { type: "button", "aria-label": "Close member details", onclick: () => closeDrawer(true) }, "✕")),
      h("div.admin-drawer-body", {}, body)),
    ];
  }

  function render() {
    if (status === "loading" && !directory.length) {
      replace(main, h("p.muted", {}, "Loading people…"));
      return;
    }
    if (status === "forbidden") {
      replace(main, message("Workspace Admin access required.", "Only Workspace Admins can manage people in this Workspace."));
      return;
    }
    if (status === "error") {
      replace(main, message("Could not load people.", "Check your connection and try again."),
        h("button.btn", { type: "button", onclick: () => load({ reset: true }) }, "Try again"));
      return;
    }

    const visible = chip === "content"
      ? directory.filter(p => p.contentTier && p.contentTier !== "none")
      : directory;

    const chips = [
      ["all", "All"],
      ["admin", "Workspace Admins"],
      ["content", "Content Admins"],
      ["member", "Members"],
      ["removed", "Removed"],
    ];

    const addAdminCard = showAddAdmin
      ? h("section.sp-card.admin-add-card", { "aria-label": "Add Workspace Admin by email" },
        h("h2", {}, "Add Workspace Admin by email"),
        h("p.muted", {}, tenant?.domain
          ? `Pre-provision someone on @${tenant.domain} before their first sign-in, or promote an existing member.`
          : "Add an admin by email address."),
        h("form.pick-row", { onsubmit: e => { e.preventDefault?.(); submitAddAdmin(); } },
          addAdminEmailInput,
          act({ class: "primary", type: "submit", "aria-disabled": addAdminBusy ? "true" : "false" },
            addAdminBusy ? "Adding…" : "Add Workspace Admin", () => submitAddAdmin(), () => addAdminBusy),
          h("button.btn.ghost", { type: "button", onclick: () => { showAddAdmin = false; addAdminError = ""; render(); } }, "Cancel")),
        addAdminError ? h("p.sp-error", { role: "alert" }, addAdminError) : null,
        addAdminSuccess ? h("p.muted", { role: "status" }, addAdminSuccess) : null)
      : null;

    const pendingStrip = pendingAdmins.length
      ? h("section.sp-card.admin-pending-strip", { "aria-label": "Pending Admins", "data-pending-admins": "true" },
        h("h2", {}, `Pending Admins (${pendingAdmins.length})`),
        h("p.muted", {}, "Pre-provisioned by email. They will become Workspace Admins on their first sign-in."),
        h("ul.rows.adm-list", { "aria-label": "Pending Workspace Admins" }, pendingAdmins.map(em => h("li.row.adm-row", { "aria-label": `${em}, pending admin` },
          avatarEl(em),
          h("span.who.adm-who", {}, h("span.adm-name", {}, em), h("span.badge.badge-warn", {}, "Pending")),
          act({
            class: "btn-danger-ghost",
            "aria-label": `Revoke pending admin ${em}`,
            "aria-disabled": revokingEmail === em ? "true" : "false",
          }, revokingEmail === em ? "Revoking…" : "Revoke", () => revokePendingAdmin(em), () => revokingEmail === em)))))
      : null;

    const collabSec = tenant?.personal
      ? h("section.adm-sec", { "aria-label": "Collaborators" },
        h("h2", {}, `Collaborators (${collaborators.length})`),
        h("form.pick-row", { onsubmit: e => { e.preventDefault?.(); submitAddCollaborator(); } },
          collabEmailInput,
          act({ class: "primary", type: "submit", "aria-disabled": collabBusy ? "true" : "false" },
            collabBusy ? "Adding…" : "Add collaborator", () => submitAddCollaborator(), () => collabBusy)),
        collabError ? h("p.sp-error", { role: "alert" }, collabError) : null,
        collaborators.length
          ? h("ul.rows.adm-list", { "aria-label": "Collaborators" }, collaborators.map(em => h("li.row.adm-row", {},
            avatarEl(em),
            h("span.who.adm-who", {}, h("span.adm-name", {}, em)),
            act({ class: "btn-danger-ghost", "aria-label": `Remove ${em}`, "aria-disabled": collabBusy ? "true" : "false" },
              "Remove", () => removeCollaborator(em), () => collabBusy))))
          : h("p.muted", {}, "No collaborators added yet."))
      : null;

    const rowsEl = visible.length
      ? h("ul.rows.adm-list", { "aria-label": "Workspace people" }, visible.map(p => {
        const isBusy = busyUser === p.user;
        const actionBtn = !p.removed
          ? act({
            class: p.isAdmin ? "btn-danger-ghost" : "",
            "data-admin-action": p.isAdmin ? "demote" : "promote",
            "data-user-id": p.user,
            "aria-disabled": isBusy ? "true" : "false",
          },
          p.isAdmin ? (isBusy ? "Removing…" : "Remove Admin") : (isBusy ? "Promoting…" : "Make Workspace Admin"),
          e => confirmAdminToggle(p, !p.isAdmin, e.currentTarget),
          () => isBusy)
          : null;
        return h("li.row.adm-row.admin-person-row", { "aria-label": `${p.name}${p.isAdmin ? ", Workspace Admin" : ""}` },
          avatarEl(p.name || p.email || p.user),
          h("button.btn.ghost.who.adm-who.admin-person-btn", {
            type: "button",
            "data-user-row": p.user,
            onclick: e => openDrawer(p.user, e.currentTarget),
          },
          h("span.adm-name", {}, p.name || p.email || p.user),
          p.email && p.email !== p.name ? h("span.muted.adm-email", {}, p.email) : null),
          h("div.admin-row-badges", {},
            p.isAdmin ? h("span.badge.badge-accent", {}, "Workspace Admin") : null,
            p.contentTier && p.contentTier !== "none" ? h("span.badge.badge-warn", {}, tierLabel(p.contentTier)) : null,
            p.removed ? h("span.badge.badge-danger", {}, "Removed") : null),
          actionBtn);
      }))
      : message("No people match.", query.trim() ? "Try a different search or filter." : "People appear here once they sign in to this Workspace.");

    const loadMoreBtn = nextCursor
      ? h("div.admin-more-wrap", {}, act({
        "data-action": "load-more",
        "aria-disabled": loadingMore ? "true" : "false",
      }, loadingMore ? "Loading…" : "Load more", () => load({ reset: false }), () => loadingMore))
      : null;

    replace(main,
      h("div.sp-head", {},
        h("h1", { id: "page-title", tabindex: "-1" }, "People"),
        h("span.badge", {}, tenant?.name || "Workspace"),
        h("span.spacer"),
        h("button.btn.primary", {
          type: "button",
          "data-action": "toggle-add-admin",
          onclick: () => { showAddAdmin = !showAddAdmin; addAdminError = ""; addAdminSuccess = ""; render(); if (showAddAdmin) addAdminEmailInput.focus?.(); },
        }, "+ Add Admin by email")),
      h("p.muted", {}, "Manage Workspace Admins, inspect member access across Areas & Spaces, and pre-provision admins by email."),
      addAdminCard,
      inlineError ? h("p.sp-error", { role: "alert" }, inlineError) : null,
      pendingStrip,
      h("div.admin-toolbar", {},
        searchInput,
        h("div.admin-chips", { role: "group", "aria-label": "Filter people by role" }, chips.map(([id, label]) =>
          h("button.btn.admin-chip", {
            type: "button",
            "data-chip": id,
            "aria-pressed": chip === id ? "true" : "false",
            onclick: () => {
              if (chip === id) return;
              chip = /** @type {any} */ (id);
              load({ reset: true });
            },
          }, label)))),
      rowsEl,
      loadMoreBtn,
      collabSec,
      renderDrawer());
  }

  load({ reset: true });
  return {
    reload: () => load({ reset: true }),
    destroy() {
      destroyed = true;
      if (searchTimer) clearTimer(searchTimer);
      globalThis.document?.removeEventListener?.("keydown", onKey);
      replace(main);
    },
  };
}

/**
 * Areas & Spaces overview (`?admin=spaces`): lists all Areas and Spaces with owners,
 * general access, board count, sole-owner/trash filters, and direct "Manage access" links.
 * @param {{
 *   chrome: ReturnType<typeof adminShell>,
 *   org: import("../../ports/admin.js").AdminPort,
 *   tenant: { id: string, name?: string | null } | null,
 *   hrefs: { access: (type: string, id: string) => string },
 * }} o
 */
export function mountAdminSpaces({ chrome, org, tenant, hrefs }) {
  const { main } = chrome;
  let destroyed = false;
  let status = "loading";
  let areas = [];
  let spaces = [];
  let filter = "all";
  let query = "";

  const searchInput = h("input.field.admin-search-input", {
    type: "search",
    "aria-label": "Search areas and spaces",
    placeholder: "Search areas, spaces, or owners",
    autocomplete: "off",
    maxlength: "100",
    oninput: e => { query = e.target.value; render(); },
  });

  async function load() {
    if (!tenant?.id) { status = "forbidden"; render(); return; }
    status = "loading";
    render();
    try {
      const res = await org.listTenantSpacesOverview(tenant.id);
      if (destroyed) return;
      areas = Array.isArray(res?.areas) ? res.areas : [];
      spaces = Array.isArray(res?.spaces) ? res.spaces : [];
      status = "ready";
    } catch (e) {
      if (destroyed) return;
      status = e?.status === 403 || e?.code === "forbidden" ? "forbidden" : "error";
    }
    if (!destroyed) render();
  }

  const matchesQuery = (name, areaName, owners) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    if (String(name ?? "").toLowerCase().includes(needle)) return true;
    if (String(areaName ?? "").toLowerCase().includes(needle)) return true;
    return (owners ?? []).some(o => String(o.name ?? "").toLowerCase().includes(needle) || String(o.email ?? "").toLowerCase().includes(needle));
  };

  const ownersSummary = owners => {
    if (!owners?.length) return "No owners";
    return owners.map(o => o.name || o.email || o.user).join(", ");
  };

  function render() {
    if (status === "loading") { replace(main, h("p.muted", {}, "Loading Areas & Spaces…")); return; }
    if (status === "forbidden") { replace(main, message("Workspace Admin access required.", "Only Workspace Admins can inspect Areas & Spaces.")); return; }
    if (status === "error") {
      replace(main, message("Could not load Areas & Spaces.", "Check your connection and try again."),
        h("button.btn", { type: "button", onclick: load }, "Try again"));
      return;
    }

    const filterArea = a => {
      if (filter === "trash") return false;
      if (filter === "sole" && a.ownerCount !== 1) return false;
      if (filter === "open" && !a.generalAccess) return false;
      if (filter === "private" && a.generalAccess) return false;
      return matchesQuery(a.name, null, a.owners);
    };
    const filterSpace = s => {
      if (filter === "trash") return Boolean(s.trashed) && matchesQuery(s.name, s.areaName, s.owners);
      if (s.trashed) return false;
      if (filter === "sole" && s.ownerCount !== 1) return false;
      if (filter === "open" && !s.generalAccess) return false;
      if (filter === "private" && s.generalAccess) return false;
      return matchesQuery(s.name, s.areaName, s.owners);
    };

    const shownAreas = areas.filter(filterArea);
    const shownSpaces = spaces.filter(filterSpace);
    const chips = [
      ["all", "All"],
      ["sole", "Sole-owner"],
      ["open", "Open to Workspace"],
      ["private", "Private"],
      ["trash", "Trash"],
    ];

    const areaSec = shownAreas.length
      ? h("section.adm-sec", { "aria-label": "Areas" },
        h("h2", {}, `Areas (${shownAreas.length})`),
        h("ul.rows.adm-list", { "aria-label": "Areas" }, shownAreas.map(a => h("li.row.adm-row", { "aria-label": `${a.name}, Area` },
          h("div.who.adm-who", {},
            h("span.adm-name", {}, a.name),
            h("span.muted.adm-email", {}, `Owners: ${ownersSummary(a.owners)}`)),
          h("div.admin-row-badges", {},
            h("span.badge", {}, a.generalAccess ? `Open (${a.generalAccess})` : "Private"),
            a.ownerCount === 1 ? h("span.badge.badge-warn", {}, "Sole owner") : null),
          h("a.btn", { href: hrefs.access("group", a.id), "data-manage-access": `group:${a.id}` }, "Manage access")))))
      : null;

    const spaceSec = shownSpaces.length
      ? h("section.adm-sec", { "aria-label": "Spaces" },
        h("h2", {}, `Spaces (${shownSpaces.length})`),
        h("ul.rows.adm-list", { "aria-label": "Spaces" }, shownSpaces.map(s => h("li.row.adm-row", { "aria-label": `${s.name}, Space` },
          h("div.who.adm-who", {},
            h("span.adm-name", {}, s.name, s.areaName ? h("small.muted", {}, ` · ${s.areaName}`) : null),
            h("span.muted.adm-email", {}, `Owners: ${ownersSummary(s.owners)} · ${s.boardCount} ${s.boardCount === 1 ? "board" : "boards"}`)),
          h("div.admin-row-badges", {},
            s.trashed ? h("span.badge.badge-danger", {}, "Trash") : null,
            s.kind === "personal" ? h("span.badge", {}, "Personal") : null,
            h("span.badge", {}, s.generalAccess ? `Open (${s.generalAccess})` : "Private"),
            s.ownerCount === 1 && !s.trashed ? h("span.badge.badge-warn", {}, "Sole owner") : null),
          h("a.btn", { href: hrefs.access("space", s.id), "data-manage-access": `space:${s.id}` }, "Manage access")))))
      : null;

    replace(main,
      h("div.sp-head", {},
        h("h1", { id: "page-title", tabindex: "-1" }, "Areas & Spaces"),
        h("span.badge", {}, `${areas.length} Areas · ${spaces.filter(s => !s.trashed).length} Spaces`)),
      h("p.muted", {}, "Inspect ownership, general access, and board counts across your Workspace. Manage Area or Space owners in 2 clicks."),
      h("div.admin-toolbar", {},
        searchInput,
        h("div.admin-chips", { role: "group", "aria-label": "Filter Areas and Spaces" }, chips.map(([id, label]) =>
          h("button.btn.admin-chip", {
            type: "button",
            "data-chip": id,
            "aria-pressed": filter === id ? "true" : "false",
            onclick: () => { filter = id; render(); },
          }, label)))),
      areaSec,
      spaceSec,
      !areaSec && !spaceSec ? message("No Areas or Spaces match.", "Try another filter or search query.") : null);
  }

  load();
  return {
    destroy() {
      destroyed = true;
      replace(main);
    },
  };
}

/**
 * Audit & Compliance section (`?admin=audit`): filterable audit log,
 * Export Workspace Data button, and GDPR User Erasure form with typed confirmation.
 * @param {{
 *   chrome: ReturnType<typeof adminShell>,
 *   org: import("../../ports/admin.js").AdminPort,
 *   tenant: { id: string, name?: string | null } | null,
 *   clock?: { now(): number },
 * }} o
 */
export function mountAdminAudit({ chrome, org, tenant, clock = { now: () => Date.now() } }) {
  const { main } = chrome;
  let destroyed = false;
  let status = "loading";
  let events = [];
  let nextBefore = null;
  let loadingMore = false;
  let filterText = "";
  let category = "all";
  let exporting = false;
  let exportMsg = "";
  let exportErr = "";
  let erasing = false;
  let eraseMsg = "";
  let eraseErr = "";
  let seq = 0;

  const filterInput = h("input.field.admin-search-input", {
    type: "search",
    "aria-label": "Filter audit events",
    placeholder: "Filter by action, actor, or target",
    autocomplete: "off",
    maxlength: "100",
    oninput: e => { filterText = e.target.value; render(); },
  });
  const eraseUserInput = h("input.field", {
    type: "text",
    "aria-label": "User ID to erase",
    placeholder: "e.g. google:12345 or dev:alice",
    autocomplete: "off",
    maxlength: "200",
    oninput: () => syncEraseBtn(),
  });
  const eraseConfirmInput = h("input.field", {
    type: "text",
    "aria-label": "Type ERASE to confirm",
    placeholder: "Type ERASE to confirm",
    autocomplete: "off",
    maxlength: "20",
    oninput: () => syncEraseBtn(),
  });
  let eraseBtn = null;
  const canEraseNow = () => !erasing && String(eraseUserInput.value ?? "").trim().length > 0 && String(eraseConfirmInput.value ?? "").trim() === "ERASE";
  const syncEraseBtn = () => { if (eraseBtn) setOff(eraseBtn, !canEraseNow()); };

  async function load({ before = null, append = false } = {}) {
    if (!tenant?.id) { status = "forbidden"; render(); return; }
    const mySeq = ++seq;
    if (append) loadingMore = true;
    else status = "loading";
    render();
    try {
      const res = await org.adminAudit({ tenant: tenant.id, limit: 50, ...(before ? { before } : {}) });
      if (destroyed || mySeq !== seq) return;
      const list = Array.isArray(res?.events) ? res.events : [];
      events = append ? [...events, ...list] : list;
      nextBefore = res?.nextBefore ?? null;
      status = "ready";
    } catch (e) {
      if (destroyed || mySeq !== seq) return;
      if (e?.status === 403 || e?.code === "forbidden") status = "forbidden";
      else if (!append) status = "error";
      else chrome.setNotice("Could not load more audit events.");
    } finally {
      loadingMore = false;
      if (!destroyed) render();
    }
  }

  async function runExport() {
    if (!tenant?.id || exporting) return;
    exporting = true; exportMsg = ""; exportErr = ""; render();
    try {
      const payload = await org.exportTenantData({ tenant: tenant.id });
      if (destroyed) return;
      try {
        if (typeof Blob === "function" && typeof URL?.createObjectURL === "function" && typeof document?.createElement === "function") {
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `plenary-workspace-export-${tenant.id}.json`;
          a.click?.();
          URL.revokeObjectURL?.(url);
        }
      } catch {
        // Non-browser test environments skip download anchor.
      }
      exportMsg = "Workspace data exported successfully.";
      chrome.setNotice(exportMsg);
      announce(exportMsg);
    } catch (e) {
      if (destroyed) return;
      exportErr = errorMessage(e, "Could not export workspace data.");
    } finally {
      exporting = false;
      if (!destroyed) render();
    }
  }

  async function runErase() {
    if (!tenant?.id || !canEraseNow()) return;
    const userId = String(eraseUserInput.value ?? "").trim();
    erasing = true; eraseMsg = ""; eraseErr = ""; render();
    try {
      await org.gdprErase({ userId, tenant: tenant.id });
      if (destroyed) return;
      eraseUserInput.value = "";
      eraseConfirmInput.value = "";
      eraseMsg = `Erased personal data for ${userId}.`;
      chrome.setNotice(eraseMsg);
      announce(eraseMsg);
      await load();
    } catch (e) {
      if (destroyed) return;
      eraseErr = errorMessage(e, "Could not erase user data.");
    } finally {
      erasing = false;
      if (!destroyed) render();
    }
  }

  const matchesCategory = action => {
    const a = String(action ?? "").toLowerCase();
    if (category === "all") return true;
    if (category === "admin") return /(admin|role|grant|access|team)/.test(a);
    if (category === "members") return /(member|offboard|remove)/.test(a);
    if (category === "content") return /(board|space|group|area|trash)/.test(a);
    if (category === "compliance") return /(export|gdpr|erase|compliance)/.test(a);
    return true;
  };

  function render() {
    if (status === "forbidden") {
      replace(main, message("Workspace Admin access required.", "Only Workspace Admins can view audit logs and compliance tools."));
      return;
    }

    const needle = filterText.trim().toLowerCase();
    const filtered = events.filter(ev => {
      if (!matchesCategory(ev.action)) return false;
      if (!needle) return true;
      return String(ev.action ?? "").toLowerCase().includes(needle)
        || String(ev.actor ?? "").toLowerCase().includes(needle)
        || String(ev.target ?? "").toLowerCase().includes(needle)
        || String(ev.board ?? "").toLowerCase().includes(needle);
    });

    const cats = [
      ["all", "All"],
      ["admin", "Admin & Access"],
      ["members", "Members"],
      ["content", "Boards & Spaces"],
      ["compliance", "Compliance"],
    ];

    const exportBtn = act({
      class: "primary",
      "data-action": "export-data",
      "aria-disabled": exporting ? "true" : "false",
    }, exporting ? "Exporting…" : "Export Workspace Data", runExport, () => exporting);

    eraseBtn = act({
      class: "btn-danger",
      type: "submit",
      "data-action": "gdpr-erase",
      "aria-disabled": canEraseNow() ? "false" : "true",
    }, erasing ? "Erasing…" : "Erase User Data", runErase, () => !canEraseNow());

    const complianceGrid = h("section.admin-compliance-grid", { "aria-label": "Compliance actions" },
      h("div.sp-card.admin-compliance-card", {},
        h("h2", {}, "Export Workspace Data"),
        h("p.muted", {}, "Download a full JSON archive of this Workspace's metadata, directory, teams, spaces, boards, and audit log."),
        h("div.pick-row", {}, exportBtn),
        exportMsg ? h("p.muted", { role: "status" }, exportMsg) : null,
        exportErr ? h("p.sp-error", { role: "alert" }, exportErr) : null),
      h("div.sp-card.admin-compliance-card.danger", {},
        h("h2", {}, "GDPR User Erasure"),
        h("p.muted", {}, "Permanently redact a user's personal data in this Workspace. Type ERASE to confirm."),
        h("form.admin-erase-form", { onsubmit: e => { e.preventDefault?.(); runErase(); } },
          eraseUserInput,
          eraseConfirmInput,
          eraseBtn),
        eraseMsg ? h("p.muted", { role: "status" }, eraseMsg) : null,
        eraseErr ? h("p.sp-error", { role: "alert" }, eraseErr) : null));

    const logBody = status === "loading" && !events.length
      ? h("p.muted", {}, "Loading audit log…")
      : status === "error"
        ? [message("Could not load audit log.", "Check your connection and try again."), h("button.btn", { type: "button", onclick: () => load() }, "Try again")]
        : filtered.length
          ? [
            h("ul.rows.adm-list.home-audit-list", { "aria-label": "Audit log events" }, filtered.map(ev => {
              const target = ev.board ? `board ${ev.board}` : (ev.target ? `target ${ev.target}` : null);
              return h("li.row.adm-row.audit-row", {},
                h("span", { class: `badge badge-action badge-${auditTone(ev.action)}` }, String(ev.action ?? "")),
                h("span.who.audit-who", {},
                  ev.actor ? h("span.audit-actor", {}, ev.actor) : null,
                  ev.actor && target ? h("span.audit-sep", {}, " · ") : null,
                  target ? h("span.audit-target", {}, target) : null),
                h("span.muted.audit-when", {}, whenText(ev.at, clock.now())));
            })),
            nextBefore ? h("div.admin-more-wrap", {}, act({
              "data-action": "audit-more",
              "aria-disabled": loadingMore ? "true" : "false",
            }, loadingMore ? "Loading…" : "Load more", () => load({ before: nextBefore, append: true }), () => loadingMore)) : null,
          ]
          : message("No audit events match.", "Try clearing your filter or refreshing.");

    replace(main,
      h("div.sp-head", {},
        h("h1", { id: "page-title", tabindex: "-1" }, "Audit & Compliance"),
        h("span.badge", {}, tenant?.name || "Workspace"),
        h("span.spacer"),
        act({ "data-action": "audit-refresh", "aria-disabled": status === "loading" ? "true" : "false" },
          "Refresh", () => load(), () => status === "loading")),
      complianceGrid,
      h("h2", {}, "Audit log"),
      h("div.admin-toolbar", {},
        filterInput,
        h("div.admin-chips", { role: "group", "aria-label": "Filter audit events by category" }, cats.map(([id, label]) =>
          h("button.btn.admin-chip", {
            type: "button",
            "data-chip": id,
            "aria-pressed": category === id ? "true" : "false",
            onclick: () => { category = id; render(); },
          }, label)))),
      logBody);
  }

  load();
  return {
    destroy() {
      destroyed = true;
      replace(main);
    },
  };
}
