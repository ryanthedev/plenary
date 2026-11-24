// Phase 2: Backend Workspace Admin Primitives (promote/demote admins, searchable paginated directory,
// member summary drawer, and spaces overview). Runs against both memory and SQLite Registry adapters.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { spaceService } from "../../server/core/auth/spaces.js";

const ORIGIN = "https://plenary.test";
const config = {
  cookieKey: "k".repeat(32),
  postLoginUrl: ORIGIN + "/",
  boardUrl: ORIGIN + "/b/{board}",
  publicUrl: ORIGIN,
};

const tmpDirs = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const adapters = [
  ["memory", () => ({ reg: memoryRegistry(), close: async () => {} })],
  ["sqlite", () => {
    const dir = mkdtempSync(join(tmpdir(), "plenary-admins-"));
    tmpDirs.push(dir);
    const reg = sqliteRegistry({ path: join(dir, "reg.db") });
    return { reg, close: () => reg.close() };
  }],
];

for (const [label, makeReg] of adapters) {
  describe(`Workspace Admin Primitives (${label})`, () => {
    test("POST/DELETE /tenants/:id/admins, GET /tenants/:id/members, summary & spaces-overview", async () => {
      const { reg, close } = makeReg();
      try {
        let t = 1_700_000_000_000;
        const now = () => t;
        const announcements = [];
        const sessions = await makeSessions({ key: "s".repeat(32), now });
        const tenancy = makeTenancy({ registry: reg, now });
        const spaces = spaceService({
          registry: reg,
          tenancy,
          now,
          announce: (boardId, tenantId, o) => announcements.push({ boardId, tenantId, o }),
        });
        const routes = httpRoutes({ registry: reg, sessions, tenancy, spaces, now, config });

        const api = (method, path, token, body) => routes(new Request(ORIGIN + path, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }));

        const alice = { user: "google:alice", name: "Alice Admin", email: "alice@acme.com", domain: "acme.com" };
        const bob = { user: "google:bob", name: "Bob Member", email: "bob@acme.com", domain: "acme.com" };
        const carol = { user: "google:carol", name: "Carol Delegated", email: "carol@acme.com", domain: "acme.com" };
        const dave = { user: "google:dave", name: "Dave Offboarded", email: "dave@acme.com", domain: "acme.com" };
        const [aliceTok, bobTok, carolTok] = await Promise.all([
          sessions.issue(alice),
          sessions.issue(bob),
          sessions.issue(carol),
        ]);

        // Provision domain workspace with Alice as dual-entry admin
        const ws = await reg.createTenant({ domain: "acme.com", name: "Acme", admins: [alice.user, "email:alice@acme.com"] });
        await reg.touchMember(ws.id, alice);
        await reg.touchMember(ws.id, bob);
        await reg.touchMember(ws.id, carol);
        await reg.touchMember(ws.id, dave);
        await reg.removeMember({ tenant: ws.id, user: dave.user, by: alice.user });

        // Give Carol a custom Unit role with `members.manage` (must NOT be allowed to promote/demote Workspace Admins!)
        const customRole = await reg.createRole({
          tenant: ws.id,
          name: "User Manager",
          boardRole: "viewer",
          permissions: ["members.manage"],
        });
        await reg.setScopedGrant({ scope: { type: "unit", id: ws.id }, subject: { type: "user", id: carol.user }, role: customRole.id });

        // Give Bob content-admin tier on the unit
        await reg.setScopedGrant({ scope: { type: "unit", id: ws.id }, subject: { type: "user", id: bob.user }, role: "content-admin" });

        // Guardrail: non-admin Bob and custom-role Carol (with members.manage!) both get 403
        for (const tok of [bobTok, carolTok]) {
          expect((await api("POST", `/tenants/${ws.id}/admins`, tok, { userId: bob.user })).status).toBe(403);
          expect((await api("DELETE", `/tenants/${ws.id}/admins/${encodeURIComponent(alice.user)}`, tok)).status).toBe(403);
          expect((await api("GET", `/tenants/${ws.id}/members/${encodeURIComponent(bob.user)}/summary`, tok)).status).toBe(403);
          expect((await api("GET", `/tenants/${ws.id}/spaces-overview`, tok)).status).toBe(403);
        }

        // POST /tenants/:id/admins: reject external email (400) and offboarded user (409 removed)
        expect((await api("POST", `/tenants/${ws.id}/admins`, aliceTok, { email: "outsider@evil.com" })).status).toBe(400);
        const offboardedById = await api("POST", `/tenants/${ws.id}/admins`, aliceTok, { userId: dave.user });
        expect(offboardedById.status).toBe(409);
        expect(await offboardedById.json()).toEqual({ error: "removed" });
        const offboardedByEmail = await api("POST", `/tenants/${ws.id}/admins`, aliceTok, { email: dave.email });
        expect(offboardedByEmail.status).toBe(409);
        expect(await offboardedByEmail.json()).toEqual({ error: "removed" });

        // Pre-provision a pending @acme.com email admin before first sign-in
        const preRes = await api("POST", `/tenants/${ws.id}/admins`, aliceTok, { email: "Pending@Acme.com" });
        expect(preRes.status).toBe(201);
        expect(await preRes.json()).toEqual({ member: "email:pending@acme.com", email: "pending@acme.com", pending: true });

        // Cannot demote Alice while only a pending email admin remains (409 last-admin)
        const lastRes = await api("DELETE", `/tenants/${ws.id}/admins/${encodeURIComponent(alice.user)}`, aliceTok);
        expect(lastRes.status).toBe(409);
        expect(await lastRes.json()).toEqual({ error: "last-admin" });

        // GET /tenants/:id/members: searchable, role-filtered, paginated, includes contentTier + pendingAdmins
        const fullDir = await (await api("GET", `/tenants/${ws.id}/members?limit=2`, aliceTok)).json();
        expect(fullDir.pendingAdmins).toEqual(["pending@acme.com"]);
        expect(fullDir.directory).toEqual([
          { user: alice.user, name: "Alice Admin", email: "alice@acme.com", isAdmin: true, contentTier: "none", removed: false },
          { user: bob.user, name: "Bob Member", email: "bob@acme.com", isAdmin: false, contentTier: "shared", removed: false },
        ]);
        expect(fullDir.nextCursor).toBe(bob.user);

        const page2 = await (await api("GET", `/tenants/${ws.id}/members?after=${encodeURIComponent(fullDir.nextCursor)}&limit=2`, aliceTok)).json();
        expect(page2.directory.map(d => d.user)).toEqual([carol.user]);
        expect(page2.nextCursor).toBeNull();

        const removedDir = await (await api("GET", `/tenants/${ws.id}/members?role=removed`, aliceTok)).json();
        expect(removedDir.directory.map(d => [d.user, d.removed])).toEqual([[dave.user, true]]);

        const qDir = await (await api("GET", `/tenants/${ws.id}/members?q=bob`, aliceTok)).json();
        expect(qDir.directory.map(d => d.user)).toEqual([bob.user]);

        // Promote Bob by userId -> 201, then demote Alice -> 204 (removes BOTH google:alice & email:alice@acme.com)
        const promBob = await api("POST", `/tenants/${ws.id}/admins`, aliceTok, { userId: bob.user });
        expect(promBob.status).toBe(201);
        expect(await promBob.json()).toEqual({ member: bob.user, pending: false });

        // Create Area, Space, Board & Team to verify announcement + summary + spaces-overview
        const area = await reg.createGroup({ tenant: ws.id, name: "Engineering", generalRole: "viewer", owner: bob.user });
        const sp = await reg.createSpace({ tenant: ws.id, name: "Platform", group: area.id, generalRole: "editor", owner: bob.user });
        const trashedSp = await reg.createSpace({ tenant: ws.id, name: "Old Project", group: area.id, generalRole: null, owner: bob.user });
        await reg.createBoard({ tenant: ws.id, title: "Roadmap", space: sp.id, owner: bob.user });
        await reg.createBoard({ tenant: ws.id, title: "Legacy", space: trashedSp.id, owner: bob.user });
        await reg.trashSpace({ space: trashedSp.id, by: bob.user });
        const team = await reg.createTeam({ tenant: ws.id, name: "Core Infra" });
        await reg.setTeamMember(team.id, bob.user, true);

        // Demote Alice (now Bob is live admin): succeeds (204), announces unit revocation, writes audit
        const demAlice = await api("DELETE", `/tenants/${ws.id}/admins/${encodeURIComponent(alice.user)}`, bobTok);
        expect(demAlice.status).toBe(204);
        await spaces.settled();
        expect(announcements.length).toBeGreaterThan(0);
        expect((await reg.tenant(ws.id)).admins).toEqual(["email:pending@acme.com", bob.user]);

        // Pending email admin can still be removed even though Bob is the only live admin
        expect((await api("DELETE", `/tenants/${ws.id}/admins/${encodeURIComponent("email:pending@acme.com")}`, bobTok)).status).toBe(204);
        expect((await reg.tenant(ws.id)).admins).toEqual([bob.user]);

        // Bob is now the last live admin -> 409 last-admin
        expect((await api("DELETE", `/tenants/${ws.id}/admins/${encodeURIComponent(bob.user)}`, bobTok)).status).toBe(409);

        // GET /tenants/:id/members/:user/summary
        const sumRes = await api("GET", `/tenants/${ws.id}/members/${encodeURIComponent(bob.user)}/summary`, bobTok);
        expect(sumRes.status).toBe(200);
        const sum = await sumRes.json();
        expect(sum).toMatchObject({
          user: bob.user,
          name: "Bob Member",
          email: "bob@acme.com",
          isAdmin: true,
          contentTier: "shared",
          removed: false,
          teams: [{ id: team.id, name: "Core Infra" }],
        });
        expect(sum.grants).toEqual(expect.arrayContaining([
          { scopeType: "unit", scopeId: ws.id, scopeName: "Acme", role: "content-admin" },
          { scopeType: "group", scopeId: area.id, scopeName: "Engineering", role: "owner" },
          { scopeType: "space", scopeId: sp.id, scopeName: "Platform", role: "owner" },
        ]));

        // GET /tenants/:id/spaces-overview
        const ovRes = await api("GET", `/tenants/${ws.id}/spaces-overview`, bobTok);
        expect(ovRes.status).toBe(200);
        const ov = await ovRes.json();
        expect(ov.areas).toEqual([
          {
            id: area.id,
            name: "Engineering",
            generalAccess: "viewer",
            ownerCount: 1,
            owners: [{ user: bob.user, name: "Bob Member", email: "bob@acme.com" }],
          },
        ]);
        const liveOv = ov.spaces.find(s => s.id === sp.id);
        expect(liveOv).toEqual({
          id: sp.id,
          name: "Platform",
          kind: "shared",
          areaId: area.id,
          areaName: "Engineering",
          ownerCount: 1,
          owners: [{ user: bob.user, name: "Bob Member", email: "bob@acme.com" }],
          generalAccess: "editor",
          boardCount: 1,
          trashed: false,
        });
        const trashedOv = ov.spaces.find(s => s.id === trashedSp.id);
        expect(trashedOv).toMatchObject({ id: trashedSp.id, name: "Old Project", areaId: area.id, areaName: "Engineering", boardCount: 1, trashed: true });

        // Audit events recorded
        const audit = await reg.listAudit({ tenant: ws.id, limit: 20 });
        const actions = audit.events.map(e => e.action);
        expect(actions).toContain("tenant.admin.add");
        expect(actions).toContain("tenant.admin.remove");
      } finally {
        await close();
      }
    });
  });
}
