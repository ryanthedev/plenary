// Self-serve personal orgs + email-based org membership tests:
// - SQLite safe migration on an existing reg_tenants table without `name` column
// - Tenancy: resolve vs resolveMany parity for email-based org members, unverified email rejection, roleCache invalidation
// - announcingRegistry: addTenantMember / removeTenantMember announce { board } for all boards in the tenant
// - HTTP routes: POST/GET /tenants, GET/POST/DELETE /tenants/:tenant/members, POST /boards with explicit tenant,
//   GET /boards across multiple orgs, audit log entries, and live revocation.
import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRegistry } from "../../server/auth/registry.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { tenancy, roleCache, identityKey } from "../../server/auth/tenancy.js";
import { sessions as createSessions } from "../../server/auth/session.js";
import { httpRoutes } from "../../server/auth/http.js";
import { memoryBus } from "../../server/bus/memory.js";
import { subjects } from "../../server/bus/port.js";
import { announcingRegistry } from "../../server/main.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-orgs-"));
let seq = 0;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const KEY = "personal-orgs-test-secret-key-32-bytes-minimum!!!";
const CONFIG = {
  postLoginUrl: "https://plenary.example/",
  boardUrl: "https://plenary.example/?board={board}",
  publicUrl: "https://plenary.example",
  cookieKey: KEY,
};

const ADAPTERS = [
  ["memory", async now => memoryRegistry({ now })],
  ["sqlite", async now => sqliteRegistry({ path: join(dir, `reg-${++seq}.db`), fullfsync: false, now })],
];

test("SQLite migration: existing reg_tenants without `name` column upgrades safely and preserves rows", async () => {
  const path = join(dir, "legacy.db");
  // Seed a full schema DB, then downgrade it to the pre-personal-orgs shape (no reg_tenants.name, no reg_tenant_members, no reg_audit).
  const seed = sqliteRegistry({ path, fullfsync: false });
  await seed.close();
  const db = new Database(path);
  db.run("PRAGMA foreign_keys=OFF");
  db.run("DROP TABLE reg_tenant_members");
  db.run("DROP TABLE reg_audit");
  db.run("DROP TABLE reg_tenants");
  db.run("CREATE TABLE reg_tenants (id TEXT PRIMARY KEY, domain TEXT UNIQUE, created_at INTEGER NOT NULL)");
  db.run("INSERT INTO reg_tenants (id, domain, created_at) VALUES ('t-legacy000001', NULL, 1000)");
  db.run("INSERT INTO reg_tenants (id, domain, created_at) VALUES ('t-legacy000002', 'acme.com', 2000)");
  db.run("INSERT INTO reg_tenant_meta (tenant, kind) VALUES ('t-legacy000001', 'personal')");
  db.run("INSERT INTO reg_tenant_meta (tenant, kind) VALUES ('t-legacy000002', 'company')");
  db.run("INSERT INTO reg_tenant_admins (tenant, member, n) VALUES ('t-legacy000001', 'google:1', 1)");
  db.close();

  const reg = sqliteRegistry({ path, fullfsync: false });
  try {
    const t1 = await reg.tenant("t-legacy000001");
    expect(t1).toMatchObject({ id: "t-legacy000001", name: "Personal Workspace", domain: null, admins: ["google:1"], createdAt: 1000 });
    const t2 = await reg.tenant("t-legacy000002");
    expect(t2).toMatchObject({ id: "t-legacy000002", name: "acme.com", domain: "acme.com", admins: [], createdAt: 2000 });

    await reg.addTenantMember(t1.id, "Friend@Gmail.com");
    expect(await reg.tenantMembers(t1.id)).toEqual(["friend@gmail.com"]);
    expect((await reg.tenantsForMember("friend@gmail.com")).map(t => t.id)).toEqual([t1.id]);
  } finally {
    await reg.close();
  }
});

test("tenancy: resolve vs resolveMany 100% parity for email org members, unverified email rejection, and roleCache invalidation", async () => {
  let t = Date.UTC(2026, 10, 12);
  const now = () => t;
  const raw = memoryRegistry({ now });
  const bus = memoryBus();
  const reg = announcingRegistry(raw, bus, { warn: () => {} });
  const ten = tenancy({ registry: reg, now });
  const cache = roleCache({ registry: reg, now, ttlMs: 30_000 });

  const org = await reg.createTenant({ name: "Studio", domain: null, admins: ["google:owner", "email:owner@gmail.com"] });
  const space = await reg.createSpace({ tenant: org.id, name: "Studio", generalRole: null });
  const board = await reg.createBoard({ tenant: org.id, space: space.id, title: "Roadmap", memberRole: "editor" });
  await reg.setGrant(board.id, "google:owner", "owner");
  await reg.addTenantMember(org.id, "member@gmail.com");

  const announced = [];
  bus.subscribe(subjects.grants(org.id, board.id), m => {
    announced.push(m);
    cache.invalidate(m.board, m.user);
  });

  const owner = { user: "google:owner", name: "Owner", email: "owner@gmail.com", domain: null };
  const coAdmin = { user: "google:owner2", name: "CoAdmin", email: "owner@gmail.com", domain: null };
  const member = { user: "google:mem", name: "Member", email: "MEMBER@gmail.com", domain: null };
  const unverifiedFlag = { user: "google:mem", name: "Unverified", email: "member@gmail.com", emailVerified: false, domain: null };
  const unverifiedNull = { user: "google:mem2", name: "NoEmail", email: null, domain: null };
  const spoofDev = { user: "dev:spoof", name: "Spoof", email: "member@gmail.com", domain: null };
  const stranger = { user: "google:stranger", name: "Stranger", email: "stranger@gmail.com", domain: null };

  const people = [owner, coAdmin, member, unverifiedFlag, unverifiedNull, spoofDev, stranger];
  const expectedRoles = new Map([
    [identityKey(owner), "owner"],
    [identityKey(coAdmin), "editor"],      // tenant admin gets memberRole
    [identityKey(member), "editor"],       // verified email org member gets memberRole
    [identityKey(unverifiedFlag), null],   // emailVerified: false rejected
    [identityKey(unverifiedNull), null],   // null email rejected
    [identityKey(spoofDev), null],         // dev token without emailVerified: true rejected
    [identityKey(stranger), null],
  ]);

  const batch = await ten.rolesFor(board.id, people);
  for (const p of people) {
    const single = await ten.role(p, board.id);
    expect(single).toBe(expectedRoles.get(identityKey(p)));
    expect(batch.get(identityKey(p))).toBe(single);
    expect(await cache.role(p, board.id)).toBe(single);
  }

  // Warm cache hit for member
  expect(await cache.role(member, board.id)).toBe("editor");

  // Removing member from org announces { board } -> invalidates roleCache -> immediate revocation
  announced.length = 0;
  expect(await reg.removeTenantMember(org.id, "member@gmail.com")).toBe(true);
  await bus.flush();
  expect(announced).toEqual([{ board: board.id }]);
  expect(await cache.role(member, board.id)).toBe(null);
  expect((await ten.rolesFor(board.id, [member])).get(identityKey(member))).toBe(null);

  // Re-adding member announces { board } -> immediate access restored; no-op re-add does NOT announce again
  announced.length = 0;
  expect(await reg.addTenantMember(org.id, "member@gmail.com")).toEqual({ added: true });
  await bus.flush();
  expect(announced).toEqual([{ board: board.id }]);
  expect(await cache.role(member, board.id)).toBe("editor");

  announced.length = 0;
  expect(await reg.addTenantMember(org.id, "member@gmail.com")).toEqual({ added: false });
  await bus.flush();
  expect(announced).toEqual([]);
});

for (const [name, makeRegistry] of ADAPTERS) {
  describe(`Self-serve personal orgs & email membership HTTP E2E (${name})`, () => {
    const withReg = fn => async () => {
      let clock = Date.UTC(2026, 10, 12);
      const now = () => clock;
      const tick = (ms = 10) => { clock += ms; };
      const r = await makeRegistry(now);
      try { await fn(r, { now, tick }); } finally { await r.close?.(); }
    };

    test("POST/GET /tenants, GET/POST/DELETE /tenants/:id/members, POST /boards with explicit tenant, audit log & live revocation", withReg(async (rawRegistry, { now, tick }) => {
      const bus = memoryBus();
      const registry = announcingRegistry(rawRegistry, bus, { warn: () => {} });
      const sessions = await createSessions({ key: KEY, now });
      const ten = tenancy({ registry, now });
      const cache = roleCache({ registry, now });
      const handle = httpRoutes({ registry, sessions, tenancy: ten, now, config: CONFIG });

      const alice = { user: "google:alice", name: "Alice", email: "alice@gmail.com", domain: null };
      const bob = { user: "google:bob", name: "Bob", email: "bob@gmail.com", domain: null };
      const carol = { user: "google:carol", name: "Carol", email: "carol@gmail.com", domain: null };

      const aliceTok = await sessions.issue(alice);
      const bobTok = await sessions.issue(bob);
      const carolTok = await sessions.issue(carol);

      const api = (method, path, token, body) => handle(new Request("https://plenary.example" + path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }));

      // Fresh user has no tenants and cannot create boards yet
      expect((await (await api("GET", "/tenants", aliceTok)).json())).toEqual({ tenants: [] });
      expect((await api("POST", "/boards", aliceTok, { title: "Too early" })).status).toBe(403);
      expect((await api("POST", "/tenants", null, { name: "Anon" })).status).toBe(401);

      // Validation on POST /tenants
      expect((await api("POST", "/tenants", aliceTok, { name: "   " })).status).toBe(400);
      expect((await api("POST", "/tenants", aliceTok, { name: "a".repeat(81) })).status).toBe(400);

      // Alice creates two personal orgs (distinct timestamps via fake clock)
      const r1 = await api("POST", "/tenants", aliceTok, { name: "  Studio One  " });
      expect(r1.status).toBe(201);
      const { tenant: org1 } = await r1.json();
      expect(org1).toMatchObject({ name: "Studio One", domain: null, isAdmin: true });

      tick(10);
      const r2 = await api("POST", "/tenants", aliceTok, { name: "Studio Two" });
      expect(r2.status).toBe(201);
      const { tenant: org2 } = await r2.json();
      expect(org2).toMatchObject({ name: "Studio Two", domain: null, isAdmin: true });

      // GET /tenants lists both orgs for Alice in deterministic order
      const aliceTenants = await (await api("GET", "/tenants", aliceTok)).json();
      expect(aliceTenants.tenants.map(t => t.id)).toEqual([org1.id, org2.id]);

      // Alice creates a board in org1 (default) and explicitly in org2
      tick(10);
      const b1Res = await api("POST", "/boards", aliceTok, { title: "Org1 Board", memberRole: "editor" });
      expect(b1Res.status).toBe(201);
      const { board: b1 } = await b1Res.json();
      expect(b1.tenant).toBe(org1.id);

      tick(10);
      const b2Res = await api("POST", "/boards", aliceTok, { title: "Org2 Board", memberRole: "viewer", tenant: org2.id });
      expect(b2Res.status).toBe(201);
      const { board: b2 } = await b2Res.json();
      expect(b2.tenant).toBe(org2.id);

      // Non-admin Bob cannot create a board in org1 or manage org1 members
      expect((await api("POST", "/boards", bobTok, { title: "Hijack", tenant: org1.id })).status).toBe(403);
      expect((await api("GET", `/tenants/${org1.id}/members`, bobTok)).status).toBe(403);
      expect((await api("POST", `/tenants/${org1.id}/members`, bobTok, { email: "carol@gmail.com" })).status).toBe(403);
      expect((await api("DELETE", `/tenants/${org1.id}/members/bob%40gmail.com`, bobTok)).status).toBe(403);

      // Domain-backed Workspace tenants reject adding external email org members (M4)
      const ws = await registry.createTenant({ domain: "acme.com", admins: ["google:alice"] });
      expect((await api("POST", `/tenants/${ws.id}/members`, aliceTok, { email: "bob@gmail.com" })).status).toBe(400);

      // Unknown tenant returns 404 on members endpoints
      expect((await api("GET", "/tenants/t-nope00000000/members", aliceTok)).status).toBe(404);
      expect((await api("POST", "/tenants/t-nope00000000/members", aliceTok, { email: "bob@gmail.com" })).status).toBe(404);
      expect((await api("DELETE", "/tenants/t-nope00000000/members/bob%40gmail.com", aliceTok)).status).toBe(404);

      // Subscribe roleCache to grants for b1 so we verify live revocation through HTTP DELETE
      bus.subscribe(subjects.grants(org1.id, b1.id), m => cache.invalidate(m.board, m.user));

      // Alice validates bad email (400) and adds Bob to org1 (201)
      expect((await api("POST", `/tenants/${org1.id}/members`, aliceTok, { email: "not-an-email" })).status).toBe(400);
      const addRes = await api("POST", `/tenants/${org1.id}/members`, aliceTok, { email: "  Bob@Gmail.com " });
      expect(addRes.status).toBe(201);
      expect(await addRes.json()).toEqual({ email: "bob@gmail.com" });

      // Idempotent re-add succeeds (201) without writing a duplicate audit entry (M3)
      const addAgain = await api("POST", `/tenants/${org1.id}/members`, aliceTok, { email: "bob@gmail.com" });
      expect(addAgain.status).toBe(201);

      // GET /tenants/:id/members returns members and human-friendly admins (L3: no raw google:<sub> leak)
      const memList = await (await api("GET", `/tenants/${org1.id}/members`, aliceTok)).json();
      expect(memList.members).toEqual(["bob@gmail.com"]);
      expect(memList.admins).toEqual(["alice@gmail.com"]);

      // Bob sees org1 in GET /tenants (with isAdmin: false) and sees Org1 Board in GET /boards (with editor role)
      const bobTenants = await (await api("GET", "/tenants", bobTok)).json();
      expect(bobTenants.tenants).toEqual([{ id: org1.id, name: "Studio One", domain: null, isAdmin: false }]);

      const bobBoards = await (await api("GET", "/boards", bobTok)).json();
      expect(bobBoards.isAdmin).toBe(false);
      expect(bobBoards.boards.map(b => [b.id, b.role])).toEqual([[b1.id, "editor"]]);
      expect(await cache.role(bob, b1.id)).toBe("editor");

      // Carol is still a stranger
      expect((await (await api("GET", "/boards", carolTok)).json())).toEqual({ boards: [], isAdmin: false });

      // Alice removes Bob from org1 -> 204, live roleCache invalidated, Bob immediately loses access
      const delRes = await api("DELETE", `/tenants/${org1.id}/members/${encodeURIComponent("Bob@Gmail.com")}`, aliceTok);
      expect(delRes.status).toBe(204);
      await bus.flush();

      expect(await cache.role(bob, b1.id)).toBe(null);
      expect((await (await api("GET", "/boards", bobTok)).json())).toEqual({ boards: [], isAdmin: false });
      expect((await (await api("GET", "/tenants", bobTok)).json())).toEqual({ tenants: [] });

      // Removing Bob a second time returns 404
      expect((await api("DELETE", `/tenants/${org1.id}/members/bob%40gmail.com`, aliceTok)).status).toBe(404);

      // Audit log recorded tenant.create, board.create, single tenant.member.add (M3), tenant.member.remove
      const audit = await (await api("GET", `/admin/audit?tenant=${org1.id}`, aliceTok)).json();
      const actions = audit.events.map(e => e.action);
      expect(actions).toContain("tenant.create");
      expect(actions).toContain("board.create");
      expect(actions.filter(a => a === "tenant.member.add")).toHaveLength(1);
      expect(actions).toContain("tenant.member.remove");

      // Creator org cap (H1): creating past MAX_PERSONAL_ORGS_PER_USER (20) returns 429
      for (let i = 2; i < 20; i++) {
        tick(1);
        expect((await api("POST", "/tenants", aliceTok, { name: `Org ${i + 1}` })).status).toBe(201);
      }
      expect((await api("POST", "/tenants", aliceTok, { name: "Org 21" })).status).toBe(429);
    }));
  });
}
