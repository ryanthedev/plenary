// Personal @gmail.com / self-host mode tests (Issue #98):
// - bootstrapTenant({ personal: true, admins: ["you@gmail.com"] }) & CLI --personal / --domain personal
// - tenancy.tenantOf(identity) resolves for verified @gmail.com admin & invited collaborator, returns null for strangers
// - HTTP E2E: POST /boards, GET /boards, GET /admin/audit succeed for personal admin and reject strangers with 403
// - Workspace hd tenant isolation stays intact
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRegistry } from "../../server/auth/registry.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { sessions as createSessions } from "../../server/auth/session.js";
import { httpRoutes } from "../../server/auth/http.js";
import { bootstrapTenant, normAdmin } from "../../server/admin/tenants.js";
import { run as bootstrapCli, parseArgs } from "../../scripts/admin-bootstrap.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-personal-"));
let seq = 0;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const ADAPTERS = [
  ["memory", async () => memoryRegistry()],
  ["sqlite", async () => sqliteRegistry({ path: join(dir, `reg-${++seq}.db`), fullfsync: false })],
];

const KEY = "personal-tenant-test-secret-key-32-bytes-minimum!!";
const CONFIG = {
  postLoginUrl: "https://plenary.example/",
  boardUrl: "https://plenary.example/?board={board}",
  publicUrl: "https://plenary.example",
  cookieKey: KEY,
};

for (const [name, makeRegistry] of ADAPTERS) {
  describe(`Personal @gmail.com self-host mode (${name})`, () => {
    const withReg = fn => async () => {
      const r = await makeRegistry();
      try { await fn(r); } finally { await r.close?.(); }
    };

    test("bootstrapTenant({ personal: true }) creates domain:null tenant idempotently and adds admins", withReg(async registry => {
      const first = await bootstrapTenant({ registry, personal: true, admins: ["You@Gmail.com"] });
      expect(first.created).toBe(true);
      expect(first.tenant.domain).toBe(null);
      expect(first.tenant.admins).toEqual(["email:you@gmail.com"]);
      expect(first.added).toEqual(["email:you@gmail.com"]);

      // Re-running is idempotent
      const second = await bootstrapTenant({ registry, personal: true, admins: ["you@gmail.com"] });
      expect(second.created).toBe(false);
      expect(second.tenant.id).toBe(first.tenant.id);
      expect(second.added).toEqual([]);

      // Adding another admin reuses the same personal tenant
      const third = await bootstrapTenant({ registry, personal: true, admins: ["partner@gmail.com"] });
      expect(third.created).toBe(false);
      expect(third.tenant.id).toBe(first.tenant.id);
      expect(third.tenant.admins.sort()).toEqual(["email:partner@gmail.com", "email:you@gmail.com"]);

      // Non-@gmail.com consumer emails are rejected for personal tenants (use google:<sub> instead)
      expect(() => normAdmin("user@yahoo.com", null)).toThrow(/@gmail\.com/);
      await expect(bootstrapTenant({ registry, personal: true, admins: ["user@outlook.com"] })).rejects.toMatchObject({ code: "bad-request" });
      expect(normAdmin("google:999", null)).toBe("google:999");
    }));

    test("tenantOf resolves verified @gmail.com admin, returns null for strangers & unverified/spoofed callers, and preserves Workspace hd isolation", withReg(async registry => {
      const { tenant: personal } = await bootstrapTenant({ registry, personal: true, admins: ["owner@gmail.com"] });
      const { tenant: ws } = await bootstrapTenant({ registry, domain: "acme.com", admins: ["alice@acme.com"] });
      const ten = tenancy({ registry });

      // Verified @gmail.com admin resolves personal tenant
      expect((await ten.tenantOf({ user: "google:100", email: "owner@gmail.com", domain: null }))?.id).toBe(personal.id);
      expect((await ten.tenantOf({ user: "google:100", email: "OWNER@GMAIL.COM", domain: null }))?.id).toBe(personal.id);

      // Unrelated @gmail.com stranger returns null
      expect(await ten.tenantOf({ user: "google:999", email: "stranger@gmail.com", domain: null })).toBe(null);

      // Unverified email (email: null) returns null
      expect(await ten.tenantOf({ user: "google:100", email: null, domain: null })).toBe(null);

      // Dev token spoofing the personal admin's email returns null (never matches email: entry)
      expect(await ten.tenantOf({ user: "dev:spoof", email: "owner@gmail.com", domain: null })).toBe(null);

      // Workspace user still resolves their Workspace tenant, never the personal tenant
      expect((await ten.tenantOf({ user: "google:200", email: "alice@acme.com", domain: "acme.com" }))?.id).toBe(ws.id);

      // Consumer guest claiming a Workspace admin's email without hd never resolves the Workspace tenant
      expect(await ten.tenantOf({ user: "google:300", email: "alice@acme.com", domain: null })).toBe(null);
    }));

    test("HTTP E2E: personal admin can POST /boards, GET /boards, GET /admin/audit; stranger gets 403; invited collaborator sees only invited board", withReg(async registry => {
      await bootstrapTenant({ registry, personal: true, admins: ["you@gmail.com"] });
      const sessions = await createSessions({ key: KEY });
      const ten = tenancy({ registry });
      const handle = httpRoutes({ registry, sessions, tenancy: ten, config: CONFIG });

      const adminId = { user: "google:1", name: "Owner", email: "you@gmail.com", domain: null };
      const strangerId = { user: "google:2", name: "Stranger", email: "stranger@gmail.com", domain: null };
      const guestId = { user: "google:3", name: "Friend", email: "friend@gmail.com", domain: null };

      const adminTok = await sessions.issue(adminId);
      const strangerTok = await sessions.issue(strangerId);
      const guestTok = await sessions.issue(guestId);

      const api = (method, path, token, body) => handle(new Request("https://plenary.example" + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }));

      // Personal admin creates a board -> 201
      const created = await api("POST", "/boards", adminTok, { title: "Home Studio", memberRole: "viewer" });
      expect(created.status).toBe(201);
      const { board } = await created.json();
      expect(board.title).toBe("Home Studio");

      // Personal admin lists boards -> 200 with isAdmin: true
      const listAdmin = await api("GET", "/boards", adminTok);
      expect(listAdmin.status).toBe(200);
      const listAdminBody = await listAdmin.json();
      expect(listAdminBody.isAdmin).toBe(true);
      expect(listAdminBody.boards.map(b => b.id)).toEqual([board.id]);
      expect(listAdminBody.boards[0].role).toBe("owner");

      // Personal admin reads tenant audit -> 200 with board.create event
      const auditAdmin = await api("GET", "/admin/audit", adminTok);
      expect(auditAdmin.status).toBe(200);
      const auditBody = await auditAdmin.json();
      expect(auditBody.events.some(e => e.action === "board.create" && e.board === board.id)).toBe(true);

      // Stranger gets 403 on POST /boards and GET /admin/audit, empty list on GET /boards
      expect((await api("POST", "/boards", strangerTok, { title: "Hack" })).status).toBe(403);
      expect((await api("GET", "/admin/audit", strangerTok)).status).toBe(403);
      const listStranger = await api("GET", "/boards", strangerTok);
      expect(listStranger.status).toBe(200);
      expect(await listStranger.json()).toEqual({ boards: [], isAdmin: false });

      // Admin invites friend@gmail.com to the board
      const inv = await api("POST", `/boards/${board.id}/invites`, adminTok, { email: "friend@gmail.com", role: "editor" });
      expect(inv.status).toBe(201);

      // Friend sees the invited board on GET /boards with isAdmin: false, but cannot POST /boards or read /admin/audit
      const listGuest = await api("GET", "/boards", guestTok);
      expect(listGuest.status).toBe(200);
      const guestBody = await listGuest.json();
      expect(guestBody.isAdmin).toBe(false);
      expect(guestBody.boards.map(b => ({ id: b.id, role: b.role }))).toEqual([{ id: board.id, role: "editor" }]);
      expect((await api("POST", "/boards", guestTok, { title: "Nope" })).status).toBe(403);
      expect((await api("GET", "/admin/audit", guestTok)).status).toBe(403);
    }));
  });
}

describe("scripts/admin-bootstrap.js --personal CLI", () => {
  const mkIo = () => { const o = { out: [], err: [] }; return { o, io: { out: s => o.out.push(s), err: s => o.err.push(s) } }; };

  test("--personal --admin you@gmail.com and --domain personal create and reuse a domain:null tenant on SQLite", async () => {
    const cliDir = mkdtempSync(join(tmpdir(), "plenary-personal-cli-"));
    try {
      expect(parseArgs(["--personal", "--admin", "you@gmail.com"])).toEqual({ personal: true, admins: ["you@gmail.com"] });
      expect(parseArgs(["--domain", "personal", "--admin", "you@gmail.com"])).toEqual({ personal: true, admins: ["you@gmail.com"] });

      const a = mkIo();
      expect(await bootstrapCli(["--personal", "--admin", "you@gmail.com", "--data-dir", cliDir], {}, a.io)).toBe(0);
      const first = JSON.parse(a.o.out[0]);
      expect(first).toMatchObject({ ok: true, registry: "sqlite", domain: null, created: true, added: ["email:you@gmail.com"] });

      // Re-run with --domain personal and a second admin
      const b = mkIo();
      expect(await bootstrapCli(["--domain", "personal", "--admin", "cohost@gmail.com", "--data-dir", cliDir], {}, b.io)).toBe(0);
      const second = JSON.parse(b.o.out[0]);
      expect(second).toMatchObject({ ok: true, tenant: first.tenant, domain: null, created: false, added: ["email:cohost@gmail.com"] });
      expect(second.admins.sort()).toEqual(["email:cohost@gmail.com", "email:you@gmail.com"]);

      // Using both --personal and --domain acme.com exits 2
      const bad = mkIo();
      expect(await bootstrapCli(["--personal", "--domain", "acme.com", "--admin", "a@acme.com"], {}, bad.io)).toBe(2);
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
    }
  });
});
