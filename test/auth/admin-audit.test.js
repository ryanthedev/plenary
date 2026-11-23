// Board listing (GET /boards) and durable audit log API (GET /boards/:board/audit, GET /admin/audit).
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";

const ORIGIN = "https://plenary.test";
const config = {
  cookieKey: "k".repeat(32),
  postLoginUrl: ORIGIN + "/",
  postLogoutUrl: ORIGIN + "/bye",
  boardUrl: ORIGIN + "/b/{board}",
  publicUrl: ORIGIN,
};

const ADMIN = { user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" };
const OWNER = { user: "google:1002", name: "Ben", email: "ben@acme.com", domain: "acme.com" };
const EDITOR = { user: "google:1003", name: "Cal", email: "cal@acme.com", domain: "acme.com" };
const VIEWER = { user: "google:1004", name: "Dee", email: "dee@acme.com", domain: "acme.com" };
const GUEST = { user: "google:2001", name: "Eve", email: "eve@gmail.com", domain: null };
const OTHER_ADMIN = { user: "google:3001", name: "Fay", email: "fay@globex.com", domain: "globex.com" };

describe("boards listing & audit log HTTP API", () => {
  let clock, registry, sessions, tenancy, routes, acme, acmeSpace, globex;
  const now = () => clock.t;

  const call = (path, token, method = "GET", body) =>
    routes(new Request(ORIGIN + path, {
      method,
      headers: {
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  const tok = id => sessions.issue(id);

  beforeEach(async () => {
    clock = { t: Date.UTC(2026, 10, 22, 12) };
    registry = memoryRegistry({ now });
    sessions = await makeSessions({ key: "s".repeat(32), now });
    tenancy = makeTenancy({ registry, now });
    acme = await registry.createTenant({ domain: "acme.com", admins: [ADMIN.user] });
    await registry.setScopedGrant({ scope: { type: "unit", id: acme.id }, subject: { type: "user", id: ADMIN.user }, role: "content-admin-personal" });
    acmeSpace = await registry.createSpace({ tenant: acme.id, name: "Shared", generalRole: null });
    for (const m of [OWNER, EDITOR, VIEWER]) await registry.touchMember(acme.id, m);
    globex = await registry.createTenant({ domain: "globex.com", admins: [OTHER_ADMIN.user] });
    routes = httpRoutes({ registry, sessions, oidc: null, tenancy, now, config });
  });

  test("GET /boards: 401 unauthenticated; returns accessible boards with effective roles and isAdmin; tenant-isolated", async () => {
    expect((await call("/boards")).status).toBe(401);

    const adminTok = await tok(ADMIN);
    const viewerTok = await tok(VIEWER);
    const guestTok = await tok(GUEST);
    const otherTok = await tok(OTHER_ADMIN);

    const { board: bPublic } = await (await call("/boards", adminTok, "POST", { title: "Town Hall", memberRole: "annotator" })).json();
    clock.t += 1000;
    const { board: bPrivate } = await (await call("/boards", adminTok, "POST", { title: "Exec", memberRole: null })).json();
    clock.t += 1000;
    const { board: bGranted } = await (await call("/boards", adminTok, "POST", { title: "Design", memberRole: null })).json();
    await call(`/boards/${bGranted.id}/grants/${encodeURIComponent(VIEWER.user)}`, adminTok, "PUT", { role: "editor" });
    clock.t += 1000;
    const { board: bInvited } = await (await call("/boards", adminTok, "POST", { title: "Roadmap", memberRole: null })).json();
    await call(`/boards/${bInvited.id}/invites`, adminTok, "POST", { email: VIEWER.email, role: "commenter" });
    clock.t += 1000;
    await call("/boards", otherTok, "POST", { title: "Globex Board", memberRole: "editor" });

    // Admin sees all 4 acme boards as owner (and isAdmin: true), none from globex.
    const adminRes = await call("/boards", adminTok);
    expect(adminRes.status).toBe(200);
    const adminBody = await adminRes.json();
    expect(adminBody.isAdmin).toBe(true);
    expect(adminBody.boards.map(b => [b.id, b.title, b.role])).toEqual([
      [bInvited.id, "Roadmap", "owner"],
      [bGranted.id, "Design", "owner"],
      [bPrivate.id, "Exec", "owner"],
      [bPublic.id, "Town Hall", "owner"],
    ]);

    // Non-admin member sees memberRole + granted + invited boards, excludes bPrivate, isAdmin: false.
    const viewerRes = await call("/boards", viewerTok);
    expect(viewerRes.status).toBe(200);
    const viewerBody = await viewerRes.json();
    expect(viewerBody.isAdmin).toBe(false);
    expect(viewerBody.boards.map(b => [b.id, b.role])).toEqual([
      [bInvited.id, "commenter"],
      [bGranted.id, "editor"],
      [bPublic.id, "annotator"],
    ]);

    // Tenantless guest gets empty list + isAdmin: false.
    const guestRes = await call("/boards", guestTok);
    expect(guestRes.status).toBe(200);
    expect(await guestRes.json()).toEqual({ boards: [], isAdmin: false });
  });

  test("automatic audit recording on all 6 admin mutations; refused last-owner does not record", async () => {
    const adminTok = await tok(ADMIN);
    const { board } = await (await call("/boards", adminTok, "POST", { title: "Audit Board", memberRole: "viewer" })).json();

    clock.t += 100;
    const { invite } = await (await call(`/boards/${board.id}/invites`, adminTok, "POST", { email: "bob@partner.io", role: "editor", expiresAt: null })).json();

    clock.t += 100;
    expect((await call(`/boards/${board.id}/invites/${invite.id}`, adminTok, "DELETE")).status).toBe(204);

    clock.t += 100;
    const { link } = await (await call(`/boards/${board.id}/links`, adminTok, "POST", { role: "annotator" })).json();

    clock.t += 100;
    expect((await call(`/boards/${board.id}/links/${link.id}`, adminTok, "DELETE")).status).toBe(204);

    clock.t += 100;
    expect((await call(`/boards/${board.id}/grants/${encodeURIComponent(EDITOR.user)}`, adminTok, "PUT", { role: "editor" })).status).toBe(204);

    // Refused last-owner demotion must NOT create an audit event.
    clock.t += 100;
    expect((await call(`/boards/${board.id}/grants/${encodeURIComponent(ADMIN.user)}`, adminTok, "PUT", { role: "viewer" })).status).toBe(409);

    const res = await call(`/boards/${board.id}/audit`, adminTok);
    expect(res.status).toBe(200);
    const { events, nextBefore } = await res.json();
    expect(nextBefore).toBe(null);
    expect(events.map(e => ({ action: e.action, actor: e.actor, target: e.target, detail: e.detail }))).toEqual([
      { action: "grant.set", actor: ADMIN.user, target: EDITOR.user, detail: { role: "editor", previousRole: null } },
      { action: "link.revoke", actor: ADMIN.user, target: link.id, detail: { role: "annotator" } },
      { action: "link.create", actor: ADMIN.user, target: link.id, detail: { role: "annotator", expiresAt: null } },
      { action: "invite.revoke", actor: ADMIN.user, target: invite.id, detail: { email: "bob@partner.io", role: "editor" } },
      { action: "invite.create", actor: ADMIN.user, target: invite.id, detail: { email: "bob@partner.io", role: "editor", expiresAt: null } },
      { action: "board.create", actor: ADMIN.user, target: board.id, detail: { title: "Audit Board", memberRole: "viewer" } },
    ]);
  });

  test("GET /boards/:board/audit: owner & tenant admin allowed; editor/viewer/cross-tenant/unknown 403; pagination & validation", async () => {
    const adminTok = await tok(ADMIN);
    const ownerTok = await tok(OWNER);
    const editorTok = await tok(EDITOR);
    const viewerTok = await tok(VIEWER);
    const otherAdminTok = await tok(OTHER_ADMIN);

    const { board } = await (await call("/boards", adminTok, "POST", { title: "Scoped", memberRole: "viewer", space: acmeSpace.id })).json();
    clock.t += 10;
    await call(`/boards/${board.id}/grants/${encodeURIComponent(OWNER.user)}`, adminTok, "PUT", { role: "owner" });
    clock.t += 10;
    await call(`/boards/${board.id}/grants/${encodeURIComponent(EDITOR.user)}`, adminTok, "PUT", { role: "editor" });
    clock.t += 10;
    await call(`/boards/${board.id}/links`, ownerTok, "POST", { role: "viewer" });

    // Authz checks.
    expect((await call(`/boards/${board.id}/audit`)).status).toBe(401);
    expect((await call(`/boards/${board.id}/audit`, editorTok)).status).toBe(403);
    expect((await call(`/boards/${board.id}/audit`, viewerTok)).status).toBe(403);
    expect((await call(`/boards/${board.id}/audit`, otherAdminTok)).status).toBe(403);
    expect((await call("/boards/b-nope000000000000/audit", adminTok)).status).toBe(403);

    // Query validation.
    expect((await call(`/boards/${board.id}/audit?limit=0`, ownerTok)).status).toBe(400);
    expect((await call(`/boards/${board.id}/audit?limit=abc`, ownerTok)).status).toBe(400);
    expect((await call(`/boards/${board.id}/audit?before=bad`, ownerTok)).status).toBe(400);

    // Board owner (non-tenant-admin) can paginate through all 4 events.
    const p1 = await (await call(`/boards/${board.id}/audit?limit=2`, ownerTok)).json();
    expect(p1.events.map(e => e.action)).toEqual(["link.create", "grant.set"]);
    expect(typeof p1.nextBefore).toBe("string");

    const p2 = await (await call(`/boards/${board.id}/audit?limit=2&before=${encodeURIComponent(p1.nextBefore)}`, ownerTok)).json();
    expect(p2.events.map(e => e.action)).toEqual(["grant.set", "board.create"]);
    expect(p2.nextBefore).toBe(null);
  });

  test("GET /admin/audit: tenant admin only, pagination, board filter, tenant isolation", async () => {
    const adminTok = await tok(ADMIN);
    const ownerTok = await tok(OWNER);
    const viewerTok = await tok(VIEWER);
    const guestTok = await tok(GUEST);
    const otherAdminTok = await tok(OTHER_ADMIN);

    const { board: b1 } = await (await call("/boards", adminTok, "POST", { title: "B1", space: acmeSpace.id })).json();
    clock.t += 10;
    await call(`/boards/${b1.id}/grants/${encodeURIComponent(OWNER.user)}`, adminTok, "PUT", { role: "owner" });
    clock.t += 10;
    const { board: b2 } = await (await call("/boards", adminTok, "POST", { title: "B2" })).json();
    clock.t += 10;
    const { board: bOther } = await (await call("/boards", otherAdminTok, "POST", { title: "Globex" })).json();

    // Authz checks: non-admins (including board owner!) and tenantless guests get 403; unauthenticated gets 401.
    expect((await call("/admin/audit")).status).toBe(401);
    expect((await call("/admin/audit", ownerTok)).status).toBe(403);
    expect((await call("/admin/audit", viewerTok)).status).toBe(403);
    expect((await call("/admin/audit", guestTok)).status).toBe(403);

    // Tenant-wide audit returns all 3 acme events, never globex's.
    const all = await (await call("/admin/audit", adminTok)).json();
    expect(all.events.map(e => [e.board, e.action])).toEqual([
      [b2.id, "board.create"],
      [b1.id, "grant.set"],
      [b1.id, "board.create"],
    ]);
    expect(all.nextBefore).toBe(null);

    // Pagination.
    const page1 = await (await call("/admin/audit?limit=2", adminTok)).json();
    expect(page1.events).toHaveLength(2);
    expect(page1.nextBefore).not.toBe(null);
    const page2 = await (await call(`/admin/audit?limit=2&before=${encodeURIComponent(page1.nextBefore)}`, adminTok)).json();
    expect(page2.events.map(e => [e.board, e.action])).toEqual([[b1.id, "board.create"]]);
    expect(page2.nextBefore).toBe(null);

    // Optional board filter.
    const onlyB1 = await (await call(`/admin/audit?board=${encodeURIComponent(b1.id)}`, adminTok)).json();
    expect(onlyB1.events.map(e => e.action)).toEqual(["grant.set", "board.create"]);

    // Cross-tenant board filter never leaks other tenant's events.
    const cross = await (await call(`/admin/audit?board=${encodeURIComponent(bOther.id)}`, adminTok)).json();
    expect(cross).toEqual({ events: [], nextBefore: null });
  });

  test("SQLite durability: boards and audit log recorded via HTTP survive close and reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plenary-audit-"));
    const dbPath = join(dir, "reg.db");
    try {
      let reg = sqliteRegistry({ path: dbPath, now, fullfsync: false });
      const t = await reg.createTenant({ domain: "acme.com", admins: [ADMIN.user] });
      let r = httpRoutes({ registry: reg, sessions, oidc: null, tenancy: makeTenancy({ registry: reg, now }), now, config });
      const adminTok = await tok(ADMIN);
      const res = await r(new Request(ORIGIN + "/boards", {
        method: "POST",
        headers: { authorization: "Bearer " + adminTok, "content-type": "application/json" },
        body: JSON.stringify({ title: "Durable Board", memberRole: "viewer" }),
      }));
      expect(res.status).toBe(201);
      const { board } = await res.json();
      await reg.close();

      // Reopen on same file.
      reg = sqliteRegistry({ path: dbPath, now, fullfsync: false });
      r = httpRoutes({ registry: reg, sessions, oidc: null, tenancy: makeTenancy({ registry: reg, now }), now, config });
      const boardsRes = await r(new Request(ORIGIN + "/boards", { headers: { authorization: "Bearer " + adminTok } }));
      expect(boardsRes.status).toBe(200);
      expect((await boardsRes.json()).boards.map(b => b.id)).toEqual([board.id]);

      const auditRes = await r(new Request(ORIGIN + "/admin/audit", { headers: { authorization: "Bearer " + adminTok } }));
      expect(auditRes.status).toBe(200);
      const auditBody = await auditRes.json();
      expect(auditBody.events).toHaveLength(1);
      expect(auditBody.events[0]).toMatchObject({ tenant: t.id, board: board.id, actor: ADMIN.user, action: "board.create", target: board.id });
      await reg.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
