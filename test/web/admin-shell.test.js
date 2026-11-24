// Phase 3: Unified Enterprise Workspace Admin Shell & Multi-Level Admin UX tests.
import { describe, test, expect, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import {
  ADMIN_SECTIONS,
  normalizeAdminSection,
  adminShell,
  mountAdminPeople,
  mountAdminSpaces,
  mountAdminAudit,
} from "../../web/adapters/dom/admin-shell.js";
import { mountRolesPage } from "../../web/adapters/dom/roles.js";
import { mountOffboardPage } from "../../web/adapters/dom/offboard.js";
import { createRolesModel } from "../../web/core/role-admin.js";
import { createOffboardModel } from "../../web/core/offboard.js";
import { httpAdmin, AdminHttpError } from "../../web/adapters/admin/http.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const HREFS = {
  home: "/",
  board: id => `?board=${id}`,
  space: id => `?space=${id}`,
  group: id => `?group=${id}`,
  team: id => `?team=${id}`,
  teams: "?admin=teams",
  roles: "?admin=roles",
  offboard: "?admin=offboard",
  people: "?admin=people",
  spaces: "?admin=spaces",
  audit: "?admin=audit",
  access: (t, id) => `?access=${t}:${id}`,
  admin: (sec, extra) => {
    const sp = new URLSearchParams({ admin: sec, ...(extra ?? {}) });
    return `?${sp.toString()}`;
  },
};

function setupDom() {
  const dom = installDom();
  const listeners = {};
  globalThis.document.addEventListener = (t, fn) => { listeners[t] = fn; };
  globalThis.document.removeEventListener = t => { delete listeners[t]; };
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  return { root: dom.root, listeners };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.Node;
});

describe("adminShell chrome & navigation", () => {
  test("renders 6 persistent nav sections, explicit Back to Workspace button, logo staying on ?admin=people, no Home search bar, and mobile drawer toggle", () => {
    const { root, listeners } = setupDom();
    let loggedOut = 0;
    const chrome = adminShell({
      root,
      section: "spaces",
      hrefs: HREFS,
      workspaceName: "Acme Corp",
      onLogout: () => { loggedOut++; },
    });

    expect(ADMIN_SECTIONS.map(s => s.label)).toEqual([
      "People",
      "Teams",
      "Areas & Spaces",
      "Roles & Permissions",
      "Offboarding",
      "Audit & Compliance",
    ]);
    expect(normalizeAdminSection("bogus")).toBe("people");
    expect(normalizeAdminSection("audit")).toBe("audit");

    // Topbar: logo stays in admin (?admin=people), explicit Back to Workspace exits to Home, zero board search bar
    const logo = root.find(e => e.hasClass("logo"));
    expect(logo.getAttribute("href")).toBe("?admin=people");
    const back = root.find(e => e.getAttribute("data-admin-back") === "true");
    expect(back).toBeTruthy();
    expect(back.getAttribute("href")).toBe("/");
    expect(textOf(back)).toBe("← Back to Workspace");
    expect(root.find(e => e.hasClass("home-search"))).toBeUndefined();

    // Sign out works
    const logoutBtn = root.find(e => e.getAttribute("data-action") === "logout");
    expect(logoutBtn).toBeTruthy();
    logoutBtn.click();
    expect(loggedOut).toBe(1);

    // 6 nav items in rail, active section has aria-current="page"
    const navItems = chrome.rail.findAll(e => e.hasClass("admin-nav-item"));
    expect(navItems.length).toBe(6);
    expect(navItems.find(a => a.getAttribute("aria-current") === "page")?.getAttribute("data-admin-nav")).toBe("spaces");

    // Mobile drawer toggle opens and Escape closes
    const toggle = root.find(e => e.getAttribute("data-admin-drawer-toggle") === "true");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(chrome.rail.getAttribute("data-drawer-open")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    listeners.keydown?.({ key: "Escape", preventDefault() {} });
    expect(chrome.rail.getAttribute("data-drawer-open")).toBe("false");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    chrome.destroy();
  });
});

describe("People section (?admin=people)", () => {
  test("debounced search, role filter chips, cursor Load more, Add Admin by email, Pending Admins Revoke, inline Make/Remove Admin with 409 last-admin guard, and User Detail Drawer", async () => {
    const { root } = setupDom();
    const chrome = adminShell({ root, section: "people", hrefs: HREFS, workspaceName: "Acme Corp" });

    const calls = [];
    let failLastAdmin = false;
    const org = /** @type {any} */ ({
      listTenantMembers: async (tid, opts) => {
        calls.push(["list", tid, opts]);
        if (opts?.after === "c1") {
          return {
            members: [],
            admins: ["alice@acme.com"],
            pendingAdmins: ["future@acme.com"],
            directory: [{ user: "google:carol", name: "Carol", email: "carol@acme.com", isAdmin: false, contentTier: "shared", removed: false }],
            nextCursor: null,
          };
        }
        return {
          members: [],
          admins: ["alice@acme.com"],
          pendingAdmins: ["future@acme.com"],
          directory: [
            { user: "google:alice", name: "Alice Chen", email: "alice@acme.com", isAdmin: true, contentTier: "none", removed: false },
            { user: "google:bob", name: "Bob Ortiz", email: "bob@acme.com", isAdmin: false, contentTier: "none", removed: false },
          ],
          nextCursor: "c1",
        };
      },
      addTenantAdmin: async (tid, payload) => {
        calls.push(["addAdmin", tid, payload]);
        return { member: payload.userId ?? `email:${payload.email}`, email: payload.email, pending: Boolean(payload.email) };
      },
      removeTenantAdmin: async (tid, member) => {
        calls.push(["removeAdmin", tid, member]);
        if (failLastAdmin) throw new AdminHttpError(409, "last-admin", "cannot remove the last live tenant admin");
      },
      getTenantMemberSummary: async (tid, user) => {
        calls.push(["summary", tid, user]);
        return {
          user,
          name: "Bob Ortiz",
          email: "bob@acme.com",
          isAdmin: false,
          contentTier: "shared",
          removed: false,
          teams: [{ id: "tm-1", name: "Engineering" }],
          grants: [{ scopeType: "space", scopeId: "sp-1", scopeName: "Design", role: "editor" }],
        };
      },
    });

    const timers = [];
    const view = mountAdminPeople({
      root,
      chrome,
      org,
      tenant: { id: "t-1", name: "Acme Corp", domain: "acme.com", personal: false },
      hrefs: HREFS,
      setTimer: fn => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });
    await settle();

    // Renders directory + Pending Admins strip
    expect(textOf(chrome.main)).toContain("Alice Chen");
    expect(textOf(chrome.main)).toContain("Bob Ortiz");
    const pendingStrip = chrome.main.find(e => e.getAttribute("data-pending-admins") === "true");
    expect(pendingStrip).toBeTruthy();
    expect(textOf(pendingStrip)).toContain("future@acme.com");

    // Revoke pending admin
    pendingStrip.find(e => e.getAttribute("aria-label") === "Revoke pending admin future@acme.com").click();
    await settle();
    expect(calls.some(c => c[0] === "removeAdmin" && c[2] === "email:future@acme.com")).toBe(true);

    // Load more cursor pagination
    chrome.main.find(e => e.getAttribute("data-action") === "load-more").click();
    await settle();
    expect(textOf(chrome.main)).toContain("Carol");

    // Role chip filter calls server with role=admin
    chrome.main.find(e => e.getAttribute("data-chip") === "admin").click();
    await settle();
    expect(calls.at(-1)).toEqual(["list", "t-1", { q: null, role: "admin", after: null, limit: 50 }]);

    // Debounced search
    const searchIn = chrome.main.find(e => e.getAttribute("aria-label") === "Search people");
    searchIn.value = "bob";
    searchIn.dispatch("input", { target: searchIn });
    expect(timers.length).toBe(1);
    timers.pop()();
    await settle();
    expect(calls.at(-1)[2].q).toBe("bob");

    // + Add Admin by email form
    chrome.main.find(e => e.getAttribute("data-action") === "toggle-add-admin").click();
    const emailIn = chrome.main.find(e => e.getAttribute("aria-label") === "Admin email");
    emailIn.value = "newadmin@acme.com";
    chrome.main.find(e => e.tagName === "FORM").dispatch("submit", { preventDefault() {} });
    await settle();
    expect(calls.some(c => c[0] === "addAdmin" && c[2].email === "newadmin@acme.com")).toBe(true);
    expect(textOf(chrome.main)).toContain("Pre-provisioned newadmin@acme.com");

    // Inline Make Workspace Admin opens confirm dialog explaining management-only scope
    const promoteBtn = chrome.main.find(e => e.getAttribute("data-admin-action") === "promote" && e.getAttribute("data-user-id") === "google:bob");
    promoteBtn.click();
    const dlg = root.find(e => e.getAttribute("role") === "dialog");
    expect(dlg).toBeTruthy();
    expect(textOf(dlg)).toContain("management-only scope");
    dlg.find(e => e.tagName === "FORM").dispatch("submit", { preventDefault() {} });
    await settle();
    expect(calls.some(c => c[0] === "addAdmin" && c[2].userId === "google:bob")).toBe(true);

    // Inline Remove Admin handles 409 last-admin gracefully
    failLastAdmin = true;
    const demoteBtn = chrome.main.find(e => e.getAttribute("data-admin-action") === "demote" && e.getAttribute("data-user-id") === "google:alice");
    demoteBtn.click();
    root.find(e => e.getAttribute("role") === "dialog").find(e => e.tagName === "FORM").dispatch("submit", { preventDefault() {} });
    await settle();
    expect(textOf(chrome.main)).toContain("Cannot remove the last Workspace Admin");

    // Click member row opens User Detail Drawer with Teams, Grants, Content tier, and Offboard link
    chrome.main.find(e => e.getAttribute("data-user-row") === "google:bob").click();
    await settle();
    const drawer = chrome.main.find(e => e.getAttribute("data-user-drawer") === "google:bob");
    expect(drawer).toBeTruthy();
    expect(textOf(drawer)).toContain("Engineering");
    expect(textOf(drawer)).toContain("Design");
    expect(textOf(drawer)).toContain("Content Admin");
    const offLink = drawer.find(e => e.getAttribute("data-drawer-offboard") === "true");
    expect(offLink.getAttribute("href")).toBe("?admin=offboard&user=google%3Abob");

    view.destroy();
    chrome.destroy();
  });
});

describe("Areas & Spaces section (?admin=spaces)", () => {
  test("lists areas and spaces with owners, filters (sole-owner, open, private, trash), search, and 2-click Manage access links", async () => {
    const { root } = setupDom();
    const chrome = adminShell({ root, section: "spaces", hrefs: HREFS, workspaceName: "Acme Corp" });
    const org = /** @type {any} */ ({
      listTenantSpacesOverview: async () => ({
        areas: [
          { id: "g-1", name: "Product", generalAccess: "viewer", ownerCount: 1, owners: [{ user: "google:alice", name: "Alice", email: "alice@acme.com" }] },
        ],
        spaces: [
          { id: "s-1", name: "Design", kind: "shared", areaId: "g-1", areaName: "Product", ownerCount: 2, owners: [{ user: "google:alice", name: "Alice" }, { user: "google:bob", name: "Bob" }], generalAccess: "editor", boardCount: 4, trashed: false },
          { id: "s-2", name: "Secret Lab", kind: "shared", areaId: null, areaName: null, ownerCount: 1, owners: [{ user: "google:bob", name: "Bob" }], generalAccess: null, boardCount: 1, trashed: false },
          { id: "s-3", name: "Old Archive", kind: "shared", areaId: null, areaName: null, ownerCount: 1, owners: [{ user: "google:alice", name: "Alice" }], generalAccess: null, boardCount: 0, trashed: true },
        ],
      }),
    });

    const view = mountAdminSpaces({ chrome, org, tenant: { id: "t-1", name: "Acme Corp" }, hrefs: HREFS });
    await settle();

    expect(textOf(chrome.main)).toContain("Product");
    expect(textOf(chrome.main)).toContain("Design");
    expect(textOf(chrome.main)).toContain("Secret Lab");
    expect(textOf(chrome.main)).not.toContain("Old Archive");
    expect(chrome.main.find(e => e.getAttribute("data-manage-access") === "group:g-1").getAttribute("href")).toBe("?access=group:g-1");
    expect(chrome.main.find(e => e.getAttribute("data-manage-access") === "space:s-1").getAttribute("href")).toBe("?access=space:s-1");

    // Sole-owner filter shows Product & Secret Lab, hides Design (2 owners)
    chrome.main.find(e => e.getAttribute("data-chip") === "sole").click();
    expect(textOf(chrome.main)).toContain("Product");
    expect(textOf(chrome.main)).toContain("Secret Lab");
    expect(textOf(chrome.main)).not.toContain("Design");

    // Trash filter shows Old Archive
    chrome.main.find(e => e.getAttribute("data-chip") === "trash").click();
    expect(textOf(chrome.main)).toContain("Old Archive");
    expect(textOf(chrome.main)).not.toContain("Secret Lab");

    view.destroy();
    chrome.destroy();
  });
});

describe("Roles hierarchy + Offboarding inline demote inside adminShell", () => {
  test("Roles renders 3-card Admin & Role Hierarchy explainer and Workspace-wide role grants link inside adminShell", async () => {
    const { root } = setupDom();
    const chrome = adminShell({ root, section: "roles", hrefs: HREFS, workspaceName: "Acme Corp" });
    const model = createRolesModel({
      api: /** @type {any} */ ({
        roles: async () => ({
          page: {
            roles: [],
            matrix: { scopes: [], ladders: [], permissions: [] },
            can: { admin: true },
            limits: { custom: 50, many: { places: 10, people: 50 } },
          },
        }),
      }),
    });
    const view = mountRolesPage({ root, chrome, model, hrefs: HREFS, unitId: "t-1" });
    await model.load();
    await settle();

    const hierarchy = chrome.main.find(e => e.getAttribute("data-role-hierarchy") === "true");
    expect(hierarchy).toBeTruthy();
    expect(textOf(hierarchy)).toContain("Workspace Admins");
    expect(textOf(hierarchy)).toContain("Content Admins");
    expect(textOf(hierarchy)).toContain("Area & Space Owners");
    const unitLink = chrome.main.find(e => e.getAttribute("data-unit-access-link") === "true");
    expect(unitLink.getAttribute("href")).toBe("?access=unit:t-1");

    view.destroy();
    chrome.destroy();
  });

  test("Offboarding honors start user and offers inline 'Remove Workspace Admin first' when blocked === 'admin'", async () => {
    const { root } = setupDom();
    const chrome = adminShell({ root, section: "offboard", hrefs: HREFS, workspaceName: "Acme Corp" });
    let blocked = "admin";
    const demoted = [];
    const api = /** @type {any} */ ({
      list: async id => ({
        page: {
          member: { id, name: "Alice Chen", email: "alice@acme.com", removed: false },
          blocked,
          canRemove: blocked === null,
          defaults: { recipient: { id: "google:me", name: "Me" }, reason: "self" },
          items: [],
          next: null,
        },
      }),
      search: async () => ({ people: [] }),
    });
    const model = createOffboardModel({ api });
    const view = mountOffboardPage({
      root,
      chrome,
      model,
      hrefs: HREFS,
      start: "google:alice",
      onDemoteAdmin: async uid => { demoted.push(uid); blocked = null; },
    });
    await settle(6);

    const demoteBtn = chrome.main.find(e => e.getAttribute("data-fk") === "demote-admin");
    expect(demoteBtn).toBeTruthy();
    expect(textOf(demoteBtn)).toBe("Remove Workspace Admin first");
    demoteBtn.click();
    await settle(6);

    expect(demoted).toEqual(["google:alice"]);
    expect(chrome.main.find(e => e.getAttribute("data-fk") === "demote-admin")).toBeUndefined();
    expect(textOf(chrome.main)).toContain("Alice Chen solely owns nothing.");

    view.destroy();
    chrome.destroy();
  });
});

describe("Audit & Compliance section (?admin=audit) & httpAdmin Phase 2 methods", () => {
  test("renders filterable audit log, Export Workspace Data, and GDPR User Erasure requiring typed ERASE", async () => {
    const { root } = setupDom();
    const chrome = adminShell({ root, section: "audit", hrefs: HREFS, workspaceName: "Acme Corp" });
    const clock = virtualClock({ t0: 1_000_000 });
    const calls = [];
    const org = /** @type {any} */ ({
      adminAudit: async opts => {
        calls.push(["audit", opts]);
        return {
          events: [
            { id: 1, action: "tenant.admin.add", actor: "google:alice", target: "google:bob", board: null, at: 990_000 },
            { id: 2, action: "board.create", actor: "google:bob", target: null, board: "b-1", at: 980_000 },
          ],
          nextBefore: null,
        };
      },
      exportTenantData: async opts => { calls.push(["export", opts]); return { tenant: "t-1", exportedAt: 1_000_000 }; },
      gdprErase: async opts => { calls.push(["erase", opts]); return { erased: true }; },
    });

    const view = mountAdminAudit({ chrome, org, tenant: { id: "t-1", name: "Acme Corp" }, clock });
    await settle();

    expect(textOf(chrome.main)).toContain("tenant.admin.add");
    expect(textOf(chrome.main)).toContain("board.create");

    // Category filter narrows to Admin & Access
    chrome.main.find(e => e.getAttribute("data-chip") === "admin").click();
    expect(textOf(chrome.main)).toContain("tenant.admin.add");
    expect(textOf(chrome.main)).not.toContain("board.create");

    // Export Workspace Data
    chrome.main.find(e => e.getAttribute("data-action") === "export-data").click();
    await settle();
    expect(calls.some(c => c[0] === "export" && c[1].tenant === "t-1")).toBe(true);
    expect(textOf(chrome.main)).toContain("Workspace data exported successfully.");

    // GDPR Erase requires both userId and typed ERASE
    const eraseBtn = chrome.main.find(e => e.getAttribute("data-action") === "gdpr-erase");
    expect(eraseBtn.getAttribute("aria-disabled")).toBe("true");
    const uidIn = chrome.main.find(e => e.getAttribute("aria-label") === "User ID to erase");
    const confIn = chrome.main.find(e => e.getAttribute("aria-label") === "Type ERASE to confirm");
    uidIn.value = "google:bob";
    uidIn.dispatch("input", { target: uidIn });
    expect(eraseBtn.getAttribute("aria-disabled")).toBe("true");
    confIn.value = "ERASE";
    confIn.dispatch("input", { target: confIn });
    expect(eraseBtn.getAttribute("aria-disabled")).toBe("false");
    eraseBtn.click();
    await settle();
    expect(calls.some(c => c[0] === "erase" && c[1].userId === "google:bob" && c[1].tenant === "t-1")).toBe(true);

    view.destroy();
    chrome.destroy();
  });

  test("httpAdmin covers Phase 2 & compliance endpoints", async () => {
    const seen = [];
    const fetchStub = /** @type {any} */ (async (url, init) => {
      seen.push([init.method, url, init.body ? JSON.parse(init.body) : null]);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = httpAdmin({ token: "tok", fetch: fetchStub });
    await api.listTenantMembers("t-1", { q: "al", role: "admin", after: "c1", limit: 25 });
    await api.addTenantAdmin("t-1", { email: "a@acme.com" });
    await api.removeTenantAdmin("t-1", "google:bob");
    await api.getTenantMemberSummary("t-1", "google:bob");
    await api.listTenantSpacesOverview("t-1");
    await api.exportTenantData({ tenant: "t-1" });
    await api.gdprErase({ userId: "google:bob", tenant: "t-1" });

    expect(seen).toEqual([
      ["GET", "/tenants/t-1/members?q=al&role=admin&after=c1&limit=25", null],
      ["POST", "/tenants/t-1/admins", { email: "a@acme.com" }],
      ["DELETE", "/tenants/t-1/admins/google%3Abob", null],
      ["GET", "/tenants/t-1/members/google%3Abob/summary", null],
      ["GET", "/tenants/t-1/spaces-overview", null],
      ["GET", "/admin/export-data?tenant=t-1", null],
      ["POST", "/admin/gdpr/erase", { userId: "google:bob", tenant: "t-1" }],
    ]);
  });
});
