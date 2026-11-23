// Compliance domain service & HTTP route tests (#34): per-board/tenant export & GDPR erasure.
import { test, expect, beforeEach } from "bun:test";
import { ComplianceError, EXPORT_SCHEMA_VERSION, exportBoardData, exportTenantData, eraseUserData } from "../../server/core/auth/compliance.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";

const ORIGIN = "https://plenary.test";
const HTTP_CONFIG = {
  cookieKey: "k".repeat(32),
  postLoginUrl: ORIGIN + "/",
  boardUrl: ORIGIN + "/b/{board}",
  publicUrl: ORIGIN,
};

const clock = { t: Date.UTC(2026, 10, 20, 12, 0, 0) };
const now = () => clock.t;

const ADMIN = { user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com", emailVerified: true };
const ADMIN2 = { user: "google:1002", name: "Ben", email: "ben@acme.com", domain: "acme.com", emailVerified: true };
const OWNER = { user: "google:1003", name: "Cara", email: "cara@acme.com", domain: "acme.com", emailVerified: true };
const EDITOR = { user: "google:1004", name: "Dan", email: "dan@acme.com", domain: "acme.com", emailVerified: true };
const OUTSIDER = { user: "google:2001", name: "Eve", email: "eve@globex.com", domain: "globex.com", emailVerified: true };

let registry, acme, globex, acmeSpace, acmeGroup, board, otherBoard;

beforeEach(async () => {
  clock.t = Date.UTC(2026, 10, 20, 12, 0, 0);
  registry = memoryRegistry({ now });
  acme = await registry.createTenant({ name: "Acme", domain: "acme.com", admins: [ADMIN.user] });
  globex = await registry.createTenant({ name: "Globex", domain: "globex.com", admins: [OUTSIDER.user] });

  for (const u of [ADMIN, OWNER, EDITOR]) {
    await registry.touchMember(acme.id, { user: u.user, name: u.name, email: u.email });
  }
  await registry.touchMember(globex.id, { user: OUTSIDER.user, name: OUTSIDER.name, email: OUTSIDER.email });

  acmeGroup = await registry.createGroup({ tenant: acme.id, name: "Engineering", owner: ADMIN.user });
  acmeSpace = await registry.createSpace({ tenant: acme.id, name: "Product", group: acmeGroup.id, owner: ADMIN.user });
  const globexSpace = await registry.createSpace({ tenant: globex.id, name: "Globex Secret", owner: OUTSIDER.user });

  board = await registry.createBoard({ tenant: acme.id, title: "Roadmap", space: acmeSpace.id, owner: OWNER.user });
  await registry.setGrant(board.id, EDITOR.user, "editor");
  otherBoard = await registry.createBoard({ tenant: globex.id, title: "Globex Board", space: globexSpace.id, owner: OUTSIDER.user });
});

// ---- exportBoardData ----

test("exportBoardData: board owner exports structured archive with secrets redacted and audit recorded", async () => {
  const link = await registry.createLink({ board: board.id, role: "viewer", by: OWNER.user });
  await registry.createBoardVersion({
    tenantId: acme.id,
    boardId: board.id,
    label: "v1.0",
    createdBy: OWNER.user,
    createdByName: OWNER.name,
    elementCount: 3,
    snapshotJson: JSON.stringify({ elements: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] }),
    at: now(),
  });
  await registry.appendAudit({
    tenant: acme.id,
    board: board.id,
    actor: OWNER.user,
    action: "link.create",
    target: link.id,
    detail: { role: "viewer", secretToken: "super-secret-value" },
    at: now(),
  });

  const archive = await exportBoardData({ registry, tenant: acme.id, board: board.id, actor: OWNER, now });

  expect(archive.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
  expect(archive.exportedAt).toBe(new Date(clock.t).toISOString());
  expect(archive.tenant).toMatchObject({ id: acme.id, name: "Acme", domain: "acme.com" });
  expect(archive.board).toMatchObject({ id: board.id, tenant: acme.id, title: "Roadmap", space: acmeSpace.id });
  expect(archive.grants).toEqual(expect.arrayContaining([
    { user: OWNER.user, role: "owner" },
    { user: EDITOR.user, role: "editor" },
  ]));
  expect(archive.shareLinks).toHaveLength(1);
  expect(archive.shareLinks[0]).toEqual({
    redacted: true,
    role: "viewer",
    expiresAt: null,
    revoked: false,
    by: OWNER.user,
    createdAt: clock.t,
  });
  expect(archive.versions).toHaveLength(1);
  expect(archive.versions[0]).toMatchObject({ label: "v1.0", createdBy: OWNER.user, elementCount: 3 });
  expect("snapshotJson" in archive.versions[0]).toBe(false);

  // Zero secret leakage across the entire serialized JSON payload.
  const raw = JSON.stringify(archive);
  expect(raw).not.toContain(link.id);
  expect(raw).not.toContain("super-secret-value");
  expect(archive.audit.some(e => e.action === "link.create" && e.target === "[redacted]" && e.detail.secretToken === "[redacted]")).toBe(true);

  // Immutable audit entry recorded.
  const { events } = await registry.listAudit({ tenant: acme.id, board: board.id });
  expect(events.some(e => e.action === "board.exported" && e.actor === OWNER.user && e.target === board.id)).toBe(true);
});

test("exportBoardData: tenant admin (non-owner) may export; editor, outsider and cross-tenant mismatch are 403", async () => {
  const archive = await exportBoardData({ registry, tenant: acme.id, board: board.id, actor: ADMIN, now });
  expect(archive.board.id).toBe(board.id);

  await expect(exportBoardData({ registry, tenant: acme.id, board: board.id, actor: EDITOR, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(exportBoardData({ registry, tenant: acme.id, board: board.id, actor: OUTSIDER, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(exportBoardData({ registry, tenant: globex.id, board: board.id, actor: ADMIN, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(exportBoardData({ registry, tenant: acme.id, board: "b-missing", actor: ADMIN, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });
});

// ---- exportTenantData ----

test("exportTenantData: tenant admin exports isolated tenant archive and records tenant.exported audit", async () => {
  await registry.addTenantMember(acme.id, "contractor@external.io");
  const acmeLink = await registry.createLink({ board: board.id, role: "editor", by: OWNER.user });
  await registry.appendAudit({ tenant: acme.id, board: board.id, actor: OWNER.user, action: "link.create", target: acmeLink.id, at: now() });
  await registry.appendAudit({ tenant: globex.id, board: otherBoard.id, actor: OUTSIDER.user, action: "board.create", target: otherBoard.id, at: now() });

  const archive = await exportTenantData({ registry, tenant: acme.id, actor: ADMIN, now });

  expect(archive.schemaVersion).toBe(1);
  expect(archive.exportedAt).toBe(new Date(clock.t).toISOString());
  expect(archive.tenant.id).toBe(acme.id);
  expect(archive.groups.map(g => g.id)).toEqual([acmeGroup.id]);
  expect(archive.spaces.map(s => s.id)).toEqual([acmeSpace.id]);
  expect(archive.boards.map(b => b.id)).toEqual([board.id]);
  expect(archive.admins).toEqual([ADMIN.user]);
  expect(archive.members.some(m => m.user === OWNER.user)).toBe(true);
  expect(archive.members.some(m => m.email === "contractor@external.io")).toBe(true);
  expect(archive.grants).toEqual(expect.arrayContaining([
    { boardId: board.id, user: OWNER.user, role: "owner" },
    { boardId: board.id, user: EDITOR.user, role: "editor" },
  ]));
  expect(archive.shareLinks).toHaveLength(1);
  expect(archive.shareLinks[0]).toMatchObject({ boardId: board.id, redacted: true, role: "editor" });
  expect(archive.truncated).toEqual({ audit: false, members: false });

  const raw = JSON.stringify(archive);
  expect(raw).not.toContain(acmeLink.id);
  expect(raw).not.toContain(globex.id);
  expect(raw).not.toContain(otherBoard.id);
  expect(raw).not.toContain("Globex Secret");

  const { events } = await registry.listAudit({ tenant: acme.id });
  expect(events.some(e => e.action === "tenant.exported" && e.actor === ADMIN.user && e.target === acme.id)).toBe(true);
});

test("exportTenantData: non-admin and other-tenant admin are refused with 403", async () => {
  await expect(exportTenantData({ registry, tenant: acme.id, actor: OWNER, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(exportTenantData({ registry, tenant: acme.id, actor: OUTSIDER, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });
});

// ---- eraseUserData ----

test("eraseUserData: tenant admin erases member grants, scoped grants, teams, invites, and records gdpr.erased", async () => {
  const team = await registry.createTeam({ tenant: acme.id, name: "Design" });
  await registry.setTeamMember(team.id, EDITOR.user, true);
  await registry.setScopedGrant({ scope: { type: "space", id: acmeSpace.id }, subject: { type: "user", id: EDITOR.user }, role: "editor" });
  await registry.setScopedGrant({ scope: { type: "group", id: acmeGroup.id }, subject: { type: "user", id: EDITOR.user }, role: "viewer" });
  const invite = await registry.createInvite({ board: board.id, email: EDITOR.email, role: "editor", by: OWNER.user });
  await registry.addTenantMember(acme.id, EDITOR.email);

  // Also give EDITOR a grant in another tenant to verify strict tenant isolation.
  await registry.setGrant(otherBoard.id, EDITOR.user, "viewer");

  const res = await eraseUserData({ registry, tenant: acme.id, targetUserId: EDITOR.user, actor: ADMIN, now });

  expect(res.erased).toBe(true);
  expect(res.tenant).toBe(acme.id);
  expect(res.targetUserId).toBe(EDITOR.user);
  expect(res.selfErasure).toBe(false);
  expect(res.revoked.grants).toBeGreaterThanOrEqual(1);
  expect(res.revoked.scopedGrants).toBeGreaterThanOrEqual(2);
  expect(res.revoked.teams).toBeGreaterThanOrEqual(1);
  expect(res.revoked.invites).toBeGreaterThanOrEqual(1);
  expect(res.revoked.memberRemoved).toBe(true);
  expect(res.revoked.tenantMemberRemoved).toBe(true);

  // Everything in acme is revoked.
  expect(await registry.grant(board.id, EDITOR.user)).toBeNull();
  expect(await registry.scopedGrant({ type: "space", id: acmeSpace.id }, { type: "user", id: EDITOR.user })).toBeNull();
  expect(await registry.scopedGrant({ type: "group", id: acmeGroup.id }, { type: "user", id: EDITOR.user })).toBeNull();
  expect(await registry.teamMembers(team.id)).toEqual([]);
  expect((await registry.invite(invite.id))?.revoked).toBe(true);
  expect((await registry.memberState(acme.id, EDITOR.user))?.removed).toBe(true);
  expect(await registry.isTenantMember(acme.id, EDITOR.email)).toBe(false);

  // Other tenant's grant is untouched.
  expect(await registry.grant(otherBoard.id, EDITOR.user)).toBe("viewer");

  // Audit event recorded without leaking email PII.
  const { events } = await registry.listAudit({ tenant: acme.id });
  const ev = events.find(e => e.action === "gdpr.erased" && e.target === EDITOR.user);
  expect(ev).toBeTruthy();
  expect(ev.actor).toBe(ADMIN.user);
  expect(JSON.stringify(ev.detail)).not.toContain(EDITOR.email);
});

test("eraseUserData: refuses to erase last remaining tenant admin (409 last-admin)", async () => {
  await expect(eraseUserData({ registry, tenant: acme.id, targetUserId: ADMIN.user, actor: ADMIN, now }))
    .rejects.toMatchObject({ code: "last-admin", status: 409 });
});

test("eraseUserData: allows self-erasure for regular member and for non-sole admin; blocks non-admin erasing others", async () => {
  // Non-admin cannot erase someone else.
  await expect(eraseUserData({ registry, tenant: acme.id, targetUserId: OWNER.user, actor: EDITOR, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });

  // Cross-tenant outsider cannot self-erase in acme.
  await expect(eraseUserData({ registry, tenant: acme.id, targetUserId: OUTSIDER.user, actor: OUTSIDER, now }))
    .rejects.toMatchObject({ code: "forbidden", status: 403 });

  // Regular member self-erasure succeeds.
  const selfRes = await eraseUserData({ registry, tenant: acme.id, targetUserId: EDITOR.user, actor: EDITOR, now });
  expect(selfRes.erased).toBe(true);
  expect(selfRes.selfErasure).toBe(true);
  expect(await registry.grant(board.id, EDITOR.user)).toBeNull();

  // Add second admin: without `removeTenantAdmin` on the adapter, erasing a non-sole admin fails closed (409 is-admin)
  // rather than falsely reporting `erased: true` while leaving admin privileges intact.
  await registry.addTenantAdmin(acme.id, ADMIN2.user);
  await registry.touchMember(acme.id, { user: ADMIN2.user, name: ADMIN2.name, email: ADMIN2.email });
  await registry.setGrant(board.id, ADMIN.user, "editor");
  await expect(eraseUserData({ registry, tenant: acme.id, targetUserId: ADMIN.user, actor: ADMIN, now }))
    .rejects.toMatchObject({ code: "is-admin", status: 409 });

  // When an adapter supports `removeTenantAdmin`, erasing a non-sole admin revokes admin status and completes erasure.
  let removedAdmins = [];
  const extRegistry = Object.assign(Object.create(registry), {
    async removeTenantAdmin(_tenantId, entry) { removedAdmins.push(entry); },
    async removeMember(o) { return { removed: true, grants: 0, scopedGrants: 0, teams: 0, invites: 0, handedOver: false }; },
  });
  const adminRes = await eraseUserData({ registry: extRegistry, tenant: acme.id, targetUserId: ADMIN.user, actor: ADMIN, now });
  expect(adminRes.erased).toBe(true);
  expect(adminRes.revoked.adminRevoked).toBe(true);
  expect(removedAdmins).toEqual([ADMIN.user, "email:" + ADMIN.email]);
  expect(await registry.grant(board.id, ADMIN.user)).toBeNull();
});

test("eraseUserData: fails closed (409 still-owns) when sole ownership cannot be handed off", async () => {
  // Create a sole-owned personal space for EDITOR and remove ADMIN from directory so no live recipient exists.
  const soloTenant = await registry.createTenant({ name: "Solo", domain: "solo.test", admins: ["google:9999"] });
  await registry.touchMember(soloTenant.id, { user: EDITOR.user, name: EDITOR.name, email: EDITOR.email });
  await registry.ensurePersonalSpace(soloTenant.id, EDITOR.user, { name: EDITOR.name, email: EDITOR.email });

  await expect(eraseUserData({ registry, tenant: soloTenant.id, targetUserId: EDITOR.user, actor: EDITOR, now }))
    .rejects.toMatchObject({ code: "still-owns", status: 409 });
});

test("eraseUserData: validates targetUserId (400 bad-request)", async () => {
  for (const bad of ["", null, 123, "email:foo@acme.com", "bad\nid"]) {
    await expect(eraseUserData({ registry, tenant: acme.id, targetUserId: /** @type {any} */ (bad), actor: ADMIN, now }))
      .rejects.toBeInstanceOf(ComplianceError);
  }
});

// ---- HTTP Routes ----

test("HTTP compliance routes: GET /boards/:board/export-data, GET /admin/export-data, POST /admin/gdpr/erase", async () => {
  const dev = devAuth({
    enabled: true,
    tokens: {
      ann: { name: "ann", email: "ann@acme.com", domain: "acme.com" },
      cara: { name: "cara", email: "cara@acme.com", domain: "acme.com" },
      dan: { name: "dan", email: "dan@acme.com", domain: "acme.com" },
    },
  });
  const httpReg = memoryRegistry({ now });
  const t = await httpReg.createTenant({ name: "Acme", domain: "acme.com", admins: ["dev:ann"] });
  await httpReg.touchMember(t.id, { user: "dev:ann", name: "Ann", email: "ann@acme.com" });
  await httpReg.touchMember(t.id, { user: "dev:cara", name: "Cara", email: "cara@acme.com" });
  await httpReg.touchMember(t.id, { user: "dev:dan", name: "Dan", email: "dan@acme.com" });
  const sp = await httpReg.createSpace({ tenant: t.id, name: "Shared", owner: "dev:ann" });
  const b = await httpReg.createBoard({ tenant: t.id, title: "Q4 Plan", space: sp.id, owner: "dev:cara" });
  await httpReg.setGrant(b.id, "dev:dan", "editor");
  const secretLink = await httpReg.createLink({ board: b.id, role: "viewer", by: "dev:cara" });

  const routes = httpRoutes({
    registry: httpReg,
    sessions: await makeSessions({ key: "s".repeat(32), now }),
    tenancy: makeTenancy({ registry: httpReg, now }),
    dev,
    now,
    config: HTTP_CONFIG,
  });

  const req = (path, token, method = "GET", body) => routes(new Request(ORIGIN + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));

  // 401 when unauthenticated
  expect((await req(`/boards/${b.id}/export-data`, null)).status).toBe(401);
  expect((await req("/admin/export-data", null)).status).toBe(401);
  expect((await req("/admin/gdpr/erase", null, "POST", { userId: "dev:dan" })).status).toBe(401);

  // GET /boards/:board/export-data: owner 200, editor 403, no secret leak
  const boardRes = await req(`/boards/${b.id}/export-data`, "cara");
  expect(boardRes.status).toBe(200);
  expect(boardRes.headers.get("cache-control")).toBe("no-store");
  const boardJson = await boardRes.json();
  expect(boardJson.schemaVersion).toBe(1);
  expect(boardJson.board.id).toBe(b.id);
  expect(JSON.stringify(boardJson)).not.toContain(secretLink.id);
  expect((await req(`/boards/${b.id}/export-data`, "dan")).status).toBe(403);

  // GET /admin/export-data: admin 200, non-admin 403
  const tenantRes = await req("/admin/export-data", "ann");
  expect(tenantRes.status).toBe(200);
  const tenantJson = await tenantRes.json();
  expect(tenantJson.schemaVersion).toBe(1);
  expect(tenantJson.tenant.id).toBe(t.id);
  expect(tenantJson.boards.map(x => x.id)).toEqual([b.id]);
  expect((await req("/admin/export-data", "cara")).status).toBe(403);

  // POST /admin/gdpr/erase: sole admin -> 409 last-admin
  const lastAdminRes = await req("/admin/gdpr/erase", "ann", "POST", { userId: "dev:ann" });
  expect(lastAdminRes.status).toBe(409);
  expect(await lastAdminRes.json()).toEqual({ error: "last-admin" });

  // POST /admin/gdpr/erase: non-admin erasing another user -> 403
  expect((await req("/admin/gdpr/erase", "dan", "POST", { userId: "dev:cara" })).status).toBe(403);

  // POST /admin/gdpr/erase: bad userId -> 400
  expect((await req("/admin/gdpr/erase", "ann", "POST", { userId: "" })).status).toBe(400);

  // POST /admin/gdpr/erase: admin erases member -> 200
  const eraseRes = await req("/admin/gdpr/erase", "ann", "POST", { userId: "dev:dan" });
  expect(eraseRes.status).toBe(200);
  const eraseJson = await eraseRes.json();
  expect(eraseJson.erased).toBe(true);
  expect(eraseJson.targetUserId).toBe("dev:dan");
  expect(await httpReg.grant(b.id, "dev:dan")).toBeNull();
});
