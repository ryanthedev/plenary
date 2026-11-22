// Unit tests for httpAdmin (web/adapters/admin/http.js), mountBoardsHome, and mountShareDialog (web/adapters/dom/admin.js).
import { describe, test, expect, afterAll } from "bun:test";
import { httpAdmin, AdminHttpError } from "../../web/adapters/admin/http.js";
import { mountBoardsHome, mountShareDialog } from "../../web/adapters/dom/admin.js";

// ── Minimal stub DOM for admin.js unit tests (restored in afterAll) ──
class StubNode {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) {
    for (const n of ns) {
      const x = n instanceof StubNode ? n : new StubText(String(n));
      x.parentNode?.removeChild(x);
      x.parentNode = this;
      this.childNodes.push(x);
    }
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(new StubText(String(v))); }
}
class StubText extends StubNode { constructor(t) { super(3); this.data = t; } get textContent() { return this.data; } }
class StubElement extends StubNode {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.selected = false;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k) { return k === "class" ? this.className : (this.attrs[k] ?? null); }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) {
    const e = { target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
    for (const fn of [...(this.listeners[t] ?? [])]) fn(e);
    return e;
  }
  click() { if (!this.disabled) this.fire("click"); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  find(pred) { return this.all().find(pred) ?? null; }
  findAll(pred) { return this.all().filter(pred); }
}

const GLOBALS = ["document", "Node", "navigator"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
});

function installStubDom() {
  const docListeners = {};
  const head = new StubElement("head");
  const body = new StubElement("body");
  const documentElement = new StubElement("html");
  documentElement.dataset.theme = "light";
  const copied = [];
  globalThis.Node = StubNode;
  globalThis.document = {
    head,
    body,
    documentElement,
    createElement: tag => new StubElement(tag),
    createTextNode: t => new StubText(t),
    getElementById: id => head.find(e => e.id === id) ?? body.find(e => e.id === id),
    addEventListener: (t, fn) => { (docListeners[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] ?? []).filter(f => f !== fn); },
    fire: (t, ev = {}) => { for (const fn of [...(docListeners[t] ?? [])]) fn({ preventDefault() {}, ...ev }); },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async text => { copied.push(text); } } },
  });
  const root = new StubElement("div");
  body.append(root);
  return { root, copied, doc: globalThis.document };
}

const flush = () => new Promise(r => setTimeout(r, 0));

// ── 1. httpAdmin adapter tests ──

describe("httpAdmin (web/adapters/admin/http.js)", () => {
  test("sends Authorization: Bearer header and covers every AdminPort method", async () => {
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === "DELETE" || init.method === "PUT") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const api = httpAdmin({ origin: "https://plenary.example/", token: "tok-secret-123", fetch: fakeFetch });

    await api.listTenants();
    await api.createTenant({ name: "Design Lab" });
    await api.listTenantMembers("t-1");
    await api.addTenantMember("t-1", "friend@gmail.com");
    await api.removeTenantMember("t-1", "friend@gmail.com");
    await api.listBoards();
    await api.createBoard({ title: "Roadmap", memberRole: "editor", tenant: "t-1" });
    await api.updateBoard("b-1", { title: "Roadmap v2", memberRole: "viewer" });
    await api.deleteBoard("b-1");
    await api.listLinks("b-1");
    await api.createLink("b-1", { role: "viewer", expiresAt: 999999 });
    await api.revokeLink("b-1", "lnk-1");
    await api.listInvites("b-1");
    await api.createInvite("b-1", { email: "a@b.com", role: "annotator", expiresAt: null });
    await api.revokeInvite("b-1", "inv-1");
    await api.setGrant("b-1", "google:123", "editor");
    await api.boardAudit("b-1", { limit: 25, before: "1000:5" });
    await api.adminAudit({ tenant: "t-1", board: "b-1", limit: 10, before: "2000:9" });

    expect(calls.every(c => c.headers.Authorization === "Bearer tok-secret-123")).toBe(true);
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      "GET https://plenary.example/tenants",
      "POST https://plenary.example/tenants",
      "GET https://plenary.example/tenants/t-1/members",
      "POST https://plenary.example/tenants/t-1/members",
      "DELETE https://plenary.example/tenants/t-1/members/friend%40gmail.com",
      "GET https://plenary.example/boards",
      "POST https://plenary.example/boards",
      "PATCH https://plenary.example/boards/b-1",
      "DELETE https://plenary.example/boards/b-1",
      "GET https://plenary.example/boards/b-1/links",
      "POST https://plenary.example/boards/b-1/links",
      "DELETE https://plenary.example/boards/b-1/links/lnk-1",
      "GET https://plenary.example/boards/b-1/invites",
      "POST https://plenary.example/boards/b-1/invites",
      "DELETE https://plenary.example/boards/b-1/invites/inv-1",
      "PUT https://plenary.example/boards/b-1/grants/google%3A123",
      "GET https://plenary.example/boards/b-1/audit?limit=25&before=1000%3A5",
      "GET https://plenary.example/admin/audit?tenant=t-1&board=b-1&limit=10&before=2000%3A9",
    ]);
    expect(calls[1].body).toEqual({ name: "Design Lab" });
    expect(calls[3].body).toEqual({ email: "friend@gmail.com" });
    expect(calls[6].body).toEqual({ title: "Roadmap", memberRole: "editor", tenant: "t-1" });
    expect(calls[7].body).toEqual({ title: "Roadmap v2", memberRole: "viewer" });
    expect(calls[15].body).toEqual({ role: "editor" });
  });

  test("throws structured { status, code, message } errors on HTTP failure, malformed JSON, and network failure", async () => {
    const api403 = httpAdmin({
      origin: "https://x.test",
      token: "t",
      fetch: async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    await expect(api403.listBoards()).rejects.toMatchObject({ status: 403, code: "forbidden", message: "forbidden" });

    const api400 = httpAdmin({
      origin: "https://x.test",
      token: "t",
      fetch: async () => new Response(JSON.stringify({ error: "bad-request", message: "bad title" }), { status: 400 }),
    });
    await expect(api400.createBoard({ title: "x" })).rejects.toMatchObject({ status: 400, code: "bad-request", message: "bad title" });

    const apiBadJson = httpAdmin({
      origin: "https://x.test",
      token: "t",
      fetch: async () => new Response("<html>proxy</html>", { status: 200 }),
    });
    await expect(apiBadJson.listBoards()).rejects.toMatchObject({ status: 200, code: "malformed" });

    const apiNet = httpAdmin({
      origin: "https://x.test",
      token: "t",
      fetch: async () => { throw new Error("ECONNREFUSED"); },
    });
    try {
      await apiNet.listBoards();
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AdminHttpError);
      expect(e).toMatchObject({ status: 0, code: "network", message: "ECONNREFUSED" });
    }
  });
});

// ── 2. mountBoardsHome tests ──

describe("mountBoardsHome (web/adapters/dom/admin.js)", () => {
  test("lists boards, filters via search, opens board, creates new board via modal, and paginates Tenant Audit tab", async () => {
    const { root } = installStubDom();
    const opened = [];
    const createdCalls = [];
    const auditCalls = [];
    const admin = {
      listBoards: async () => ({
        isAdmin: true,
        boards: [
          { id: "b-alpha", tenant: "t-1", title: "Architecture Plan", memberRole: "viewer", role: "owner", createdAt: Date.UTC(2026, 5, 1) },
          { id: "b-beta", tenant: "t-1", title: "Sprint Retro", memberRole: "editor", role: "editor", createdAt: Date.UTC(2026, 5, 2) },
        ],
      }),
      createBoard: async o => {
        createdCalls.push(o);
        return { board: { id: "b-new", tenant: "t-1", title: o.title, memberRole: o.memberRole, createdAt: Date.UTC(2026, 5, 3) } };
      },
      adminAudit: async o => {
        auditCalls.push(o);
        if (!o.before) {
          return {
            events: [{ id: 10, tenant: "t-1", board: "b-alpha", actor: "google:1", action: "board.create", target: "b-alpha", detail: { title: "Architecture Plan" }, at: 1000 }],
            nextBefore: "1000:10",
          };
        }
        return {
          events: [{ id: 9, tenant: "t-1", board: "b-beta", actor: "google:1", action: "link.create", target: "lnk-1", detail: { role: "viewer" }, at: 900 }],
          nextBefore: null,
        };
      },
    };

    const view = mountBoardsHome({
      root,
      admin,
      me: { user: "google:1", name: "Alice", email: "alice@acme.com", domain: "acme.com" },
      onOpenBoard: id => opened.push(id),
    });
    await view.ready;

    // Board cards rendered
    expect(root.findAll(e => e.getAttribute("data-board-id") != null).map(e => e.getAttribute("data-board-id"))).toEqual(["b-alpha", "b-beta"]);

    // Search filters boards live
    const search = root.find(e => e.getAttribute("data-admin-search") != null);
    search.value = "retro";
    search.fire("input");
    expect(root.findAll(e => e.getAttribute("data-board-id") != null).map(e => e.getAttribute("data-board-id"))).toEqual(["b-beta"]);
    search.value = "";
    search.fire("input");
    expect(root.findAll(e => e.getAttribute("data-board-id") != null).length).toBe(2);

    // Clicking Open opens the board
    const openBtn = root.find(e => e.getAttribute("data-board-id") === "b-alpha").find(e => e.getAttribute("data-action") === "open-board");
    openBtn.click();
    expect(opened).toEqual(["b-alpha"]);

    // New Board modal
    root.find(e => e.getAttribute("data-action") === "new-board").click();
    const form = root.find(e => e.tagName === "FORM");
    const titleInput = form.find(e => e.getAttribute("name") === "title");
    const roleSelect = form.find(e => e.getAttribute("name") === "memberRole");
    titleInput.value = "Q4 Design";
    titleInput.fire("input");
    roleSelect.value = "";
    roleSelect.fire("change");
    form.fire("submit");
    await flush();

    expect(createdCalls).toEqual([{ title: "Q4 Design", memberRole: null }]);
    expect(opened).toEqual(["b-alpha", "b-new"]);
    expect(root.findAll(e => e.getAttribute("data-board-id") != null).map(e => e.getAttribute("data-board-id"))).toContain("b-new");

    // Tenant Audit Log tab + Load more pagination
    root.find(e => e.getAttribute("data-tab") === "audit").click();
    await flush();
    expect(auditCalls).toEqual([{ limit: 50, before: null }]);
    expect(root.findAll(e => e.getAttribute("data-audit-id") != null).map(e => e.getAttribute("data-audit-id"))).toEqual(["10"]);

    root.find(e => e.getAttribute("data-action") === "load-more").click();
    await flush();
    expect(auditCalls).toEqual([{ limit: 50, before: null }, { limit: 50, before: "1000:10" }]);
    expect(root.findAll(e => e.getAttribute("data-audit-id") != null).map(e => e.getAttribute("data-audit-id"))).toEqual(["10", "9"]);
    expect(root.find(e => e.getAttribute("data-action") === "load-more")).toBe(null);

    view.destroy();
  });

  test("shows empty state, hides admin controls for non-admins, and shows error banner with retry", async () => {
    const { root } = installStubDom();
    let fail = true;
    const admin = {
      listBoards: async () => {
        if (fail) throw new AdminHttpError(503, "unavailable", "Service down");
        return { isAdmin: false, boards: [] };
      },
    };
    const view = mountBoardsHome({ root, admin, me: { name: "Bob" }, onOpenBoard: () => {} });
    await view.ready;

    expect(root.find(e => e.getAttribute("role") === "alert")?.textContent).toContain("Service down");
    fail = false;
    root.find(e => e.getAttribute("data-action") === "retry").click();
    await flush();

    expect(root.find(e => e.getAttribute("role") === "alert")).toBe(null);
    expect(root.textContent).toContain("No boards yet");
    expect(root.find(e => e.getAttribute("data-action") === "new-board")).toBe(null);
    expect(root.find(e => e.getAttribute("data-tab") === "audit")).toBe(null);
    view.destroy();
  });
  test("shows notice banner and Sign in again button on 401 expired session", async () => {
    const { root } = installStubDom();
    let relogged = false;
    const admin = {
      listBoards: async () => { throw new AdminHttpError(401, "auth", "auth"); },
    };
    const view = mountBoardsHome({
      root,
      admin,
      me: { name: "Bob" },
      notice: "That share link is no longer valid.",
      onOpenBoard: () => {},
      onRelogin: () => { relogged = true; },
    });
    await view.ready;

    expect(root.find(e => e.getAttribute("role") === "status")?.textContent).toContain("That share link is no longer valid.");
    expect(root.find(e => e.getAttribute("role") === "alert")?.textContent).toContain("expired");
    const reloginBtn = root.find(e => e.getAttribute("data-action") === "relogin");
    expect(reloginBtn).not.toBe(null);
    reloginBtn.click();
    expect(relogged).toBe(true);
    view.destroy();
  });

  test("fresh @gmail.com user sees Create Org card, creates org to unlock New Board + Org & Members, manages members, and switches orgs", async () => {
    const { root } = installStubDom();
    const tenants = [];
    const membersBy = {};
    const createdBoards = [];
    let orgSeq = 0;

    const admin = {
      listBoards: async () => ({ isAdmin: tenants.some(t => t.isAdmin), boards: [] }),
      listTenants: async () => ({ tenants: [...tenants] }),
      createTenant: async ({ name }) => {
        const t = { id: `t-org${++orgSeq}`, name, domain: null, isAdmin: true };
        tenants.push(t);
        membersBy[t.id] = [];
        return { tenant: t };
      },
      listTenantMembers: async tid => ({ members: [...(membersBy[tid] ?? [])], admins: ["google:1", "email:you@gmail.com"] }),
      addTenantMember: async (tid, email) => {
        const e = email.trim().toLowerCase();
        membersBy[tid] = [...(membersBy[tid] ?? []), e];
        return { email: e };
      },
      removeTenantMember: async (tid, email) => {
        membersBy[tid] = (membersBy[tid] ?? []).filter(m => m !== email);
      },
      createBoard: async o => {
        createdBoards.push(o);
        return { board: { id: "b-1", tenant: o.tenant ?? tenants[0].id, title: o.title, memberRole: o.memberRole, createdAt: 1000 } };
      },
      adminAudit: async () => ({ events: [], nextBefore: null }),
    };

    const view = mountBoardsHome({
      root,
      admin,
      me: { user: "google:1", name: "You", email: "you@gmail.com", domain: null },
      onOpenBoard: () => {},
    });
    await view.ready;

    // Fresh user sees Create Org card and does NOT yet see New Board or Org & Members tab
    const card = root.find(e => e.getAttribute("data-create-org-card") != null);
    expect(card).not.toBe(null);
    expect(root.find(e => e.getAttribute("data-action") === "new-board")).toBe(null);
    expect(root.find(e => e.getAttribute("data-tab") === "org")).toBe(null);

    // Create first org from the welcoming card
    const orgForm = card.find(e => e.getAttribute("data-form") === "create-org");
    const orgInput = orgForm.find(e => e.getAttribute("name") === "orgName");
    orgInput.value = "Home Studio";
    orgInput.fire("input");
    orgForm.fire("submit");
    await flush();

    // Immediately unlocks New Board, Org & Members tab, and hides the onboarding card
    expect(root.find(e => e.getAttribute("data-create-org-card") != null)).toBe(null);
    expect(root.find(e => e.getAttribute("data-action") === "new-board")).not.toBe(null);
    const orgTab = root.find(e => e.getAttribute("data-tab") === "org");
    expect(orgTab).not.toBe(null);

    // Switch to Org & Members tab, add a member, verify rendered, then remove
    orgTab.click();
    await flush();
    const addForm = root.find(e => e.getAttribute("data-form") === "add-member");
    const emailInput = addForm.find(e => e.getAttribute("name") === "memberEmail");
    emailInput.value = "Friend@Gmail.com";
    emailInput.fire("input");
    addForm.fire("submit");
    await flush();

    const memberRow = root.find(e => e.getAttribute("data-member-email") === "friend@gmail.com");
    expect(memberRow).not.toBe(null);
    memberRow.find(e => e.getAttribute("data-action") === "remove-member").click();
    await flush();
    expect(root.find(e => e.getAttribute("data-member-email") === "friend@gmail.com")).toBe(null);

    // Create a second org from the Org & Members tab and switch between them
    const createAnother = root.find(e => e.getAttribute("data-form") === "create-org");
    const secondInput = createAnother.find(e => e.getAttribute("name") === "orgName");
    secondInput.value = "Side Project";
    secondInput.fire("input");
    createAnother.fire("submit");
    await flush();

    expect(root.findAll(e => e.getAttribute("data-tenant-id") != null).map(e => e.getAttribute("data-tenant-id"))).toEqual(["t-org1", "t-org2"]);

    // Switch back to t-org1, open New Board modal, select t-org2, and submit
    root.find(e => e.getAttribute("data-tenant-id") === "t-org1").click();
    await flush();
    root.find(e => e.getAttribute("data-action") === "new-board").click();
    const modalForm = root.find(e => e.getAttribute("aria-label") === "New Board");
    const tenantSel = modalForm.find(e => e.getAttribute("name") === "tenant");
    expect(tenantSel).not.toBe(null);
    tenantSel.value = "t-org2";
    tenantSel.fire("change");
    const titleIn = modalForm.find(e => e.getAttribute("name") === "title");
    titleIn.value = "Board in Org 2";
    titleIn.fire("input");
    modalForm.fire("submit");
    await flush();

    expect(createdBoards).toEqual([{ title: "Board in Org 2", memberRole: "viewer", tenant: "t-org2" }]);
    view.destroy();
  });

  test("owner cards support inline rename and styled delete confirmation; non-owner cards hide rename/delete", async () => {
    const { root } = installStubDom();
    const opened = [];
    const updatedCalls = [];
    const deletedCalls = [];
    const admin = {
      listBoards: async () => ({
        isAdmin: true,
        boards: [
          { id: "b-own", tenant: "t-1", title: "Owner Board", memberRole: "viewer", role: "owner", createdAt: Date.UTC(2026, 5, 1) },
          { id: "b-ed", tenant: "t-1", title: "Shared Editor Board", memberRole: "editor", role: "editor", createdAt: Date.UTC(2026, 5, 2) },
        ],
      }),
      updateBoard: async (id, patch) => {
        updatedCalls.push([id, patch]);
        return { board: { id, tenant: "t-1", title: patch.title, memberRole: "viewer", createdAt: Date.UTC(2026, 5, 1) } };
      },
      deleteBoard: async id => {
        deletedCalls.push(id);
      },
      adminAudit: async () => ({
        events: [
          { id: 2, tenant: "t-1", board: "b-own", actor: "google:1", action: "board.delete", target: "b-own", detail: { title: "Renamed Board" }, at: 2000 },
          { id: 1, tenant: "t-1", board: "b-own", actor: "google:1", action: "board.update", target: "b-own", detail: { title: "Renamed Board" }, at: 1000 },
        ],
        nextBefore: null,
      }),
    };

    const view = mountBoardsHome({
      root,
      admin,
      me: { user: "google:1", name: "Alice" },
      onOpenBoard: id => opened.push(id),
    });
    await view.ready;

    const ownerCard = () => root.find(e => e.getAttribute("data-board-id") === "b-own");
    const editorCard = () => root.find(e => e.getAttribute("data-board-id") === "b-ed");

    // Non-owner card hides Rename and Delete
    expect(editorCard().find(e => e.getAttribute("data-action") === "rename-board")).toBe(null);
    expect(editorCard().find(e => e.getAttribute("data-action") === "delete-board")).toBe(null);

    // Owner card shows Rename and Delete
    const renameBtn = ownerCard().find(e => e.getAttribute("data-action") === "rename-board");
    expect(renameBtn).not.toBe(null);
    expect(ownerCard().find(e => e.getAttribute("data-action") === "delete-board")).not.toBe(null);

    // Inline rename updates card title immediately without opening the board
    renameBtn.click();
    expect(opened).toEqual([]);
    const renameForm = ownerCard().find(e => e.getAttribute("data-form") === "rename-board");
    expect(renameForm).not.toBe(null);
    const renameInput = renameForm.find(e => e.getAttribute("name") === "renameTitle");
    renameInput.value = "  Renamed Board  ";
    renameInput.fire("input");
    renameForm.fire("submit");
    await flush();

    expect(updatedCalls).toEqual([["b-own", { title: "Renamed Board" }]]);
    expect(ownerCard().find(e => e.className === "adm-card-title").textContent).toBe("Renamed Board");
    expect(opened).toEqual([]);

    // Delete opens styled confirmation dialog (cancel does nothing, confirm deletes and removes card)
    ownerCard().find(e => e.getAttribute("data-action") === "delete-board").click();
    expect(opened).toEqual([]);
    const dlg = root.find(e => e.getAttribute("data-dialog") === "delete-board");
    expect(dlg).not.toBe(null);
    expect(dlg.textContent).toContain("Renamed Board");

    dlg.findAll(e => e.getAttribute("data-action") === "cancel-delete")[1].click();
    expect(root.find(e => e.getAttribute("data-dialog") === "delete-board")).toBe(null);
    expect(deletedCalls).toEqual([]);
    expect(ownerCard()).not.toBe(null);

    ownerCard().find(e => e.getAttribute("data-action") === "delete-board").click();
    root.find(e => e.getAttribute("data-action") === "confirm-delete").click();
    await flush();

    expect(deletedCalls).toEqual(["b-own"]);
    expect(ownerCard()).toBe(null);
    expect(editorCard()).not.toBe(null);

    // Audit tab shows human-friendly labels for board.update and board.delete
    root.find(e => e.getAttribute("data-tab") === "audit").click();
    await flush();
    expect(root.textContent).toContain('Updated board "Renamed Board"');
    expect(root.textContent).toContain('Deleted board "Renamed Board"');

    view.destroy();
  });
});

// ── 3. mountShareDialog tests ──

describe("mountShareDialog (web/adapters/dom/admin.js)", () => {
  test("creates, copies, and revokes share links; sends and revokes invites; sets grants; paginates board audit", async () => {
    const { root, copied } = installStubDom();
    let closed = false;
    const calls = [];
    const admin = {
      listLinks: async b => {
        calls.push(["listLinks", b]);
        return { links: [{ id: "lnk-existing", board: b, role: "viewer", expiresAt: null, revoked: false, by: "google:1", createdAt: 100 }] };
      },
      createLink: async (b, o) => {
        calls.push(["createLink", b, o]);
        return {
          link: { id: "lnk-new", board: b, role: o.role, expiresAt: o.expiresAt ?? null, revoked: false, by: "google:1", createdAt: 200 },
          url: "https://plenary.example/links/lnk-new",
        };
      },
      revokeLink: async (b, id) => { calls.push(["revokeLink", b, id]); },
      listInvites: async b => {
        calls.push(["listInvites", b]);
        return { invites: [] };
      },
      createInvite: async (b, o) => {
        calls.push(["createInvite", b, o]);
        return { invite: { id: "inv-1", board: b, email: o.email, role: o.role, expiresAt: null, revoked: false, by: "google:1", createdAt: 300 } };
      },
      revokeInvite: async (b, id) => { calls.push(["revokeInvite", b, id]); },
      setGrant: async (b, u, r) => { calls.push(["setGrant", b, u, r]); },
      boardAudit: async (b, o) => {
        calls.push(["boardAudit", b, o]);
        if (!o.before) {
          return {
            events: [{ id: 2, tenant: "t-1", board: b, actor: "google:1", action: "invite.create", target: "inv-1", detail: { email: "bob@acme.com", role: "editor" }, at: 500 }],
            nextBefore: "500:2",
          };
        }
        return {
          events: [{ id: 1, tenant: "t-1", board: b, actor: "google:1", action: "board.create", target: b, detail: { title: "Demo" }, at: 400 }],
          nextBefore: null,
        };
      },
    };

    const dlg = mountShareDialog({
      root,
      board: "b-demo",
      boardTitle: "Demo Board",
      role: "owner",
      isAdmin: true,
      admin,
      origin: "https://plenary.example",
      onClose: () => { closed = true; },
    });
    await dlg.ready;

    // Copy existing link -> redeems via /links/:id
    const existingRow = root.find(e => e.getAttribute("data-link-id") === "lnk-existing");
    existingRow.find(e => e.getAttribute("data-action") === "copy-link").click();
    await flush();
    expect(copied).toEqual(["https://plenary.example/links/lnk-existing"]);

    // Create new editor link (uses server-returned url)
    const linkForm = root.find(e => e.tagName === "FORM");
    const roleSel = linkForm.find(e => e.getAttribute("name") === "role");
    roleSel.value = "editor";
    roleSel.fire("change");
    linkForm.fire("submit");
    await flush();
    expect(calls).toContainEqual(["createLink", "b-demo", { role: "editor", expiresAt: null }]);
    const newRow = root.find(e => e.getAttribute("data-link-id") === "lnk-new");
    expect(newRow).not.toBe(null);
    newRow.find(e => e.getAttribute("data-action") === "copy-link").click();
    await flush();
    expect(copied).toEqual(["https://plenary.example/links/lnk-existing", "https://plenary.example/links/lnk-new"]);

    // Revoke new link
    root.find(e => e.getAttribute("data-link-id") === "lnk-new").find(e => e.getAttribute("data-action") === "revoke-link").click();
    await flush();
    expect(calls).toContainEqual(["revokeLink", "b-demo", "lnk-new"]);
    expect(root.find(e => e.getAttribute("data-link-id") === "lnk-new").getAttribute("data-revoked")).toBe("true");

    // Switch to People & Invites tab
    root.find(e => e.getAttribute("data-tab") === "people").click();
    await flush();
    const forms = root.findAll(e => e.tagName === "FORM");
    const emailInput = forms[0].find(e => e.getAttribute("name") === "email");
    emailInput.value = "bob@acme.com";
    emailInput.fire("input");
    forms[0].fire("submit");
    await flush();
    expect(calls).toContainEqual(["createInvite", "b-demo", { email: "bob@acme.com", role: "editor" }]);

    // Revoke invite
    root.find(e => e.getAttribute("data-invite-id") === "inv-1").find(e => e.getAttribute("data-action") === "revoke-invite").click();
    await flush();
    expect(calls).toContainEqual(["revokeInvite", "b-demo", "inv-1"]);

    // Set member grant
    const grantForm = root.findAll(e => e.tagName === "FORM")[1];
    const userInput = grantForm.find(e => e.getAttribute("name") === "user");
    userInput.value = "google:42";
    userInput.fire("input");
    grantForm.fire("submit");
    await flush();
    expect(calls).toContainEqual(["setGrant", "b-demo", "google:42", "editor"]);

    // Switch to Activity / Audit tab + Load more
    root.find(e => e.getAttribute("data-tab") === "audit").click();
    await flush();
    expect(root.findAll(e => e.getAttribute("data-audit-id") != null).map(e => e.getAttribute("data-audit-id"))).toEqual(["2"]);
    root.find(e => e.getAttribute("data-action") === "load-more-audit").click();
    await flush();
    expect(root.findAll(e => e.getAttribute("data-audit-id") != null).map(e => e.getAttribute("data-audit-id"))).toEqual(["2", "1"]);

    // Close dialog
    root.find(e => e.getAttribute("data-action") === "close").click();
    expect(closed).toBe(true);
    expect(root.children.length).toBe(0);
  });
});
