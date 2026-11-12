// The Postgres Registry (server/registry/postgres.js): platform's shared contract, plus what only Postgres has:
// the last-owner check under real concurrency (two connections), a deterministic row-lock race, same answers as
// the in-memory adapter on edge cases (garbage ids, NUL), durability across a reopen, least privilege (PROTOCOL.md
// § Store, "Least privilege") and concurrent start-up on an empty schema.
// Skips unless DATABASE_URL is set. Each test gets its own schema, dropped after.
import { describe, test, expect, afterAll } from "bun:test";
import { SQL } from "bun";
import { postgresRegistry, registryTables, REGISTRY_INDEXES } from "../../server/registry/postgres.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { registryContract } from "../auth/registry-contract.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("postgres registry", () => {
  /** @type {SQL} */ let sql;
  const client = () => (sql ??= new SQL({ url, max: 4 }));
  afterAll(async () => {
    if (priv.app) { await priv.app.close(); await client().unsafe(`DROP ROLE IF EXISTS "${priv.role}"`); }
    if (sql) await sql.close();
  });
  let n = 0;
  const schemaName = () => `pl_test_reg_${process.pid}_${Date.now().toString(36)}_${++n}`;
  const drop = s => client().unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  const schemas = new Map();

  // Platform's contract. The pool runs concurrent calls on separate connections, so its concurrency cases are real.
  registryContract("postgres", async ({ now }) => {
    const schema = schemaName();
    const r = await postgresRegistry({ sql: client(), schema, now });
    schemas.set(r, schema);
    return r;
  }, { cleanup: async r => { await r.close(); await drop(schemas.get(r)); schemas.delete(r); } });

  // The same contract as a runtime role: USAGE on the schema and row rights on tables an owner created, nothing more
  // (PROTOCOL.md § Store, "Least privilege"). One role for the file; each test's schema is migrated by the owner
  // client, then granted. If the DATABASE_URL role can't create roles, the factory falls back to the owner (warned
  // once), as the least-privilege tests below skip.
  const priv = { role: `pl_test_regrt_${process.pid}`, pass: "pl-test-" + Date.now().toString(36), app: null, off: false };
  const runtime = async () => {
    if (priv.app || priv.off) return priv.app;
    const [{ ok }] = await client().unsafe("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
    if (!ok) { priv.off = true; console.warn("pg-registry: runtime-role contract runs as the owner (the DATABASE_URL role can't create roles)"); return null; }
    await client().unsafe(`CREATE ROLE "${priv.role}" LOGIN PASSWORD '${priv.pass}'`);
    const u = new URL(url); u.username = priv.role; u.password = priv.pass;
    return (priv.app = new SQL({ url: u.toString(), max: 4 }));
  };
  registryContract("postgres (runtime role: no CREATE, row rights only)", async ({ now }) => {
    const schema = schemaName();
    await (await postgresRegistry({ sql: client(), schema })).close();          // the owner migrates
    const app = await runtime();
    if (app) {
      await client().unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${priv.role}"`);
      await client().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${priv.role}"`);
    }
    const r = await postgresRegistry({ sql: app ?? client(), schema, now });
    schemas.set(r, schema);
    return r;
  }, { cleanup: async r => { await r.close(); await drop(schemas.get(r)); schemas.delete(r); } });

  test("a write transaction runs with synchronous_commit=on", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ sql: client(), schema });
    try { expect((await r.settings()).synchronous_commit).toBe("on"); }
    finally { await r.close(); await drop(schema); }
  });

  test("timestamps come from now(), not the database clock", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ sql: client(), schema, now: () => 42 });
    try {
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      const i = await r.createInvite({ board: b.id, email: "a@b.c", role: "viewer", by: "x" });
      const l = await r.createLink({ board: b.id, role: "viewer", by: "x" });
      expect([t.createdAt, b.createdAt, i.createdAt, l.createdAt]).toEqual([42, 42, 42, 42]);
    } finally { await r.close(); await drop(schema); }
  });

  test("two connections racing to demote the only two owners: exactly one wins, every round", async () => {
    const schema = schemaName();
    const a = await postgresRegistry({ url, schema, max: 2 });           // two pools: two connections for sure
    const b = await postgresRegistry({ url, schema, max: 2 });
    try {
      const t = await a.createTenant({ domain: null });
      const board = await a.createBoard({ tenant: t.id });
      for (let round = 0; round < 40; round++) {
        await a.setGrant(board.id, "x", "owner");
        await b.setGrant(board.id, "y", "owner");
        const res = await Promise.allSettled([a.setGrant(board.id, "x", null), b.setGrant(board.id, "y", round % 2 ? "viewer" : null)]);
        expect(res.filter(r => r.status === "fulfilled").length).toBe(1);
        expect(res.find(r => r.status === "rejected").reason.code).toBe("last-owner");
        for (const h of [a, b]) expect((await h.grants(board.id)).filter(g => g.role === "owner").length).toBe(1);
      }
    } finally { await a.close(); await b.close(); await drop(schema); }
  });

  test("a setGrant waits on another connection's board lock, then sees its commit (last-owner)", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 2 });
    const other = await client().reserve();
    try {
      const t = await r.createTenant({ domain: null });
      const board = await r.createBoard({ tenant: t.id });
      await r.setGrant(board.id, "x", "owner");
      await r.setGrant(board.id, "y", "owner");
      // Another connection takes the board lock and removes x, uncommitted (what a concurrent setGrant does).
      await other.unsafe("BEGIN");
      await other.unsafe(`SELECT id FROM "${schema}".reg_boards WHERE id = $1 FOR UPDATE`, [board.id]);
      await other.unsafe(`DELETE FROM "${schema}".reg_grants WHERE board = $1 AND member = 'x'`, [board.id]);
      let settled = false;
      const p = r.setGrant(board.id, "y", "editor").then(() => "ok", e => e.code).finally(() => { settled = true; });
      await Bun.sleep(200);
      expect(settled).toBe(false);                                // queued on the row lock
      await other.unsafe("COMMIT");
      expect(await p).toBe("last-owner");
      expect(await r.grants(board.id)).toEqual([{ user: "y", role: "owner" }]);
    } finally { other.release(); await r.close(); await drop(schema); }
  });

  test("two connections creating a tenant for one domain at once: one wins, the other gets the usual error", async () => {
    const schema = schemaName();
    const hs = await Promise.all(Array.from({ length: 6 }, () => postgresRegistry({ url, schema, max: 2 })));
    try {
      for (const d of ["a.com", "b.com", "c.com"]) {
        const res = await Promise.allSettled(hs.map(h => h.createTenant({ domain: d })));
        expect(res.filter(x => x.status === "fulfilled").length).toBe(1);
        for (const x of res.filter(x => x.status === "rejected")) expect(x.reason.message).toBe("registry: domain already has a tenant");
      }
    } finally { for (const h of hs) await h.close(); await drop(schema); }
  });

  test("same answers as the in-memory adapter: order, nulls, booleans, garbage ids (NUL too), error messages", async () => {
    const clock = { t: 1000 };
    const now = () => clock.t;
    const run = async r => {
      const out = [];
      const rec = async (label, f) => {
        try { out.push([label, "ok", await f()]); }
        catch (err) { out.push([label, "err", err.message, err.code ?? null]); }
      };
      const names = new Map();
      const name = v => (typeof v === "string" && names.has(v) ? names.get(v) : v);
      const scrub = x => JSON.parse(JSON.stringify(x ?? null, (k, v) => name(v)));
      const t = await r.createTenant({ domain: "Acme.com", admins: ["google:a", "google:b"] });
      names.set(t.id, "T");
      const t2 = await r.createTenant({ domain: null });
      names.set(t2.id, "T2");
      const b = await r.createBoard({ tenant: t.id, title: 42, memberRole: null });
      names.set(b.id, "B");
      const c = await r.createBoard({ tenant: t.id });
      names.set(c.id, "C");
      await rec("board B", () => r.board(b.id));
      await rec("board C", () => r.board(c.id));
      await rec("tenant", () => r.tenant(t.id));
      await rec("tenant null domain", () => r.tenant(t2.id));
      await rec("dup domain", () => r.createTenant({ domain: "ACME.COM" }));
      await rec("no tenant board", () => r.createBoard({ tenant: "t-nope" }));
      await rec("addAdmin unknown", () => r.addTenantAdmin("t-nope", "x"));
      await r.addTenantAdmin(t.id, "google:c");
      await r.addTenantAdmin(t.id, "google:a");
      await rec("admins order", async () => (await r.tenant(t.id)).admins);
      for (const [u, role] of [["u1", "owner"], ["u2", "editor"], ["u3", "viewer"], ["u2", "annotator"], ["u4", "owner"]]) await r.setGrant(b.id, u, role);
      await rec("grants order", () => r.grants(b.id));
      await rec("demote u1", () => r.setGrant(b.id, "u1", "editor"));
      await rec("remove u4 (last)", () => r.setGrant(b.id, "u4", null));
      await rec("grants after", () => r.grants(b.id));
      await rec("setGrant unknown board", () => r.setGrant("b-nope", "u", "viewer"));
      clock.t = 2000;
      const i1 = await r.createInvite({ board: b.id, email: " Ann@X.com ", role: "editor", by: "u4" });
      names.set(i1.id, "I1");
      const i2 = await r.createInvite({ board: b.id, email: "ann@x.com", role: "viewer", expiresAt: 5000, by: "u4" });
      names.set(i2.id, "I2");
      await rec("invites", () => r.invites(b.id));
      await rec("invitesFor", () => r.invitesFor(b.id, "ANN@x.com"));
      await rec("revoke i1", () => r.revokeInvite(i1.id));
      await rec("revoke i1 again", () => r.revokeInvite(i1.id));
      await rec("revoke unknown", () => r.revokeInvite("i-nope"));
      await rec("invite i1", () => r.invite(i1.id));
      await rec("invite unknown board", () => r.createInvite({ board: "b-nope", email: "a@b", role: "viewer", by: "x" }));
      const l1 = await r.createLink({ board: b.id, role: "viewer", by: "u4" });
      names.set(l1.id, "L1");
      const l2 = await r.createLink({ board: b.id, role: "editor", expiresAt: 9, by: "u4" });
      names.set(l2.id, "L2");
      await rec("links", () => r.links(b.id));
      await rec("revoke l2", () => r.revokeLink(l2.id));
      await rec("revoke l2 again", () => r.revokeLink(l2.id));
      await rec("link l2", () => r.link(l2.id));
      await r.addLinkUse(l2.id, "g");
      await r.addLinkUse(l1.id, "g");
      await r.addLinkUse(l2.id, "g");
      await rec("linkUses order", () => r.linkUses(b.id, "g"));
      await rec("addLinkUse unknown", () => r.addLinkUse("nope", "g"));
      for (const bad of [undefined, null, 7, "../x", "", "b-nope", { id: b.id }, "b-\u0000nul"]) {
        await rec(`board(${String(bad)})`, () => r.board(bad));
        await rec(`tenant(${String(bad)})`, () => r.tenant(bad));
        await rec(`tenantByDomain(${String(bad)})`, () => r.tenantByDomain(bad));
        await rec(`grant(${String(bad)})`, () => r.grant(bad, "u1"));
        await rec(`grant(B, ${String(bad)})`, () => r.grant(b.id, bad));
        await rec(`grants(${String(bad)})`, () => r.grants(bad));
        await rec(`invite(${String(bad)})`, () => r.invite(bad));
        await rec(`invites(${String(bad)})`, () => r.invites(bad));
        await rec(`invitesFor(${String(bad)})`, () => r.invitesFor(bad, "ann@x.com"));
        await rec(`link(${String(bad)})`, () => r.link(bad));
        await rec(`links(${String(bad)})`, () => r.links(bad));
        await rec(`linkUses(${String(bad)})`, () => r.linkUses(bad, "g"));
        await rec(`revokeLink(${String(bad)})`, () => r.revokeLink(bad));
        await rec(`revokeInvite(${String(bad)})`, () => r.revokeInvite(bad));
      }
      await rec("invitesFor bad email", () => r.invitesFor(b.id, 7));
      return scrub(out);
    };
    const schema = schemaName();
    const p = await postgresRegistry({ sql: client(), schema, now });
    let pg;
    try { pg = await run(p); } finally { await p.close(); await drop(schema); }
    clock.t = 1000;
    const mem = await run(memoryRegistry({ now }));
    for (let i = 0; i < mem.length; i++) expect([i, pg[i]]).toEqual([i, mem[i]]);
    expect(pg.length).toBe(mem.length);
  });

  test("least privilege: an owner migrates; a role with only USAGE and row grants starts the registry and passes the contract calls, and can't create anything", async () => {
    // Needs a DATABASE_URL role that may create roles (CI's and a local cluster's superuser can); skipped otherwise.
    const [{ ok }] = await client().unsafe("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user");
    if (!ok) { console.warn("pg-registry: skipping the least-privilege test (the DATABASE_URL role can't create roles)"); return; }
    const schema = schemaName(), bare = schemaName(), role = `pl_test_regapp_${process.pid}_${++n}`, pass = "pl-test-" + Date.now().toString(36);
    const owner = await postgresRegistry({ sql: client(), schema });              // the owner migrates (tables + indexes)
    await owner.close();
    await client().unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
    await client().unsafe(`CREATE SCHEMA "${bare}"`);                            // made for the app, never migrated
    for (const sch of [schema, bare]) await client().unsafe(`GRANT USAGE ON SCHEMA "${sch}" TO "${role}"`);
    await client().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    const u = new URL(url); u.username = role; u.password = pass;
    const app = new SQL({ url: u.toString(), max: 2 });
    try {
      const [{ can }] = await app.unsafe("SELECT has_schema_privilege($1, 'CREATE') AS can", [schema]);
      expect(can).toBe(false);                                                    // really not the owner
      const r = await postgresRegistry({ sql: app, schema });                     // starts: everything exists, no CREATE runs
      // Every kind of write (identity columns included: no sequence grant needed) and read, as the runtime role.
      const t = await r.createTenant({ domain: "acme.com", admins: ["google:a"] });
      await r.addTenantAdmin(t.id, "google:b");
      const b = await r.createBoard({ tenant: t.id, title: "x" });
      await r.setGrant(b.id, "google:a", "owner");
      await r.setGrant(b.id, "google:b", "editor");
      await r.setGrant(b.id, "google:b", null);
      await expect(r.setGrant(b.id, "google:a", null)).rejects.toMatchObject({ code: "last-owner" });
      const i = await r.createInvite({ board: b.id, email: "c@d.e", role: "viewer", by: "google:a" });
      expect(await r.revokeInvite(i.id)).toBe(true);
      const l = await r.createLink({ board: b.id, role: "viewer", by: "google:a" });
      await r.addLinkUse(l.id, "google:g");
      expect(await r.linkUses(b.id, "google:g")).toEqual([l.id]);
      expect((await r.tenant(t.id)).admins).toEqual(["google:a", "google:b"]);
      expect(await r.grants(b.id)).toEqual([{ user: "google:a", role: "owner" }]);
      await r.close();
      // The same role on a schema nobody migrated: refused loudly, with what to do (so the start above created nothing).
      const err = await postgresRegistry({ sql: app, schema: bare }).then(() => null, e => e);
      expect(err?.message).toMatch(/^postgres registry: start-up in schema "pl_test_reg_\w+" was refused for lack of a privilege \(permission denied.*run the migrate step as the schema owner/);
      expect(err.cause?.errno).toBe("42501");
      expect((await client().unsafe(`SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = $1`, [bare]))[0].c).toBe(0);
      await expect(app.unsafe(`CREATE TABLE "${schema}".reg_extra (x INT)`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.close();
      await drop(schema); await drop(bare);
      await client().unsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
  });

  test("start-up creates exactly the declared tables and indexes, and a second start changes nothing", async () => {
    const schema = schemaName();
    const catalog = async () => (await client().unsafe(
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 ORDER BY 1`, [schema]))
      .map(r => `${r.relkind}:${r.relname}`);
    try {
      await (await postgresRegistry({ sql: client(), schema })).close();
      const first = await catalog();
      for (const t of Object.keys(registryTables(schema))) expect(first).toContain(`r:${t}`);
      for (const i of Object.keys(REGISTRY_INDEXES)) expect(first).toContain(`i:${i}`);
      await (await postgresRegistry({ sql: client(), schema })).close();
      expect(await catalog()).toEqual(first);
    } finally { await drop(schema); }
  });

  test("eight nodes starting at once against an empty schema: all start, one set of tables, and they share data", async () => {
    const schema = schemaName();
    const hs = await Promise.all(Array.from({ length: 8 }, () => postgresRegistry({ url, schema, max: 1 })));
    try {
      const [{ c }] = await client().unsafe("SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = $1", [schema]);
      expect(c).toBe(Object.keys(registryTables(schema)).length);
      const t = await hs[0].createTenant({ domain: null });
      for (const h of hs) expect((await h.tenant(t.id))?.id).toBe(t.id);
    } finally { for (const h of hs) await h.close(); await drop(schema); }
  });

  test("durable: everything survives close and reopen (a fresh pool)", async () => {
    const schema = schemaName();
    let r = await postgresRegistry({ url, schema, max: 2, now: () => 7 });
    try {
      const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
      await r.addTenantAdmin(t.id, "google:ann");
      const b = await r.createBoard({ tenant: t.id, title: "All hands", memberRole: "annotator" });
      await r.setGrant(b.id, "google:root", "owner");
      await r.setGrant(b.id, "google:ann", "editor");
      const i = await r.createInvite({ board: b.id, email: "cfo@partner.example", role: "editor", expiresAt: 99, by: "google:root" });
      await r.revokeInvite(i.id);
      const l = await r.createLink({ board: b.id, role: "viewer", by: "google:root" });
      await r.addLinkUse(l.id, "google:guest");
      const snap = async () => ({
        tenant: await r.tenant(t.id), byDomain: await r.tenantByDomain("acme.com"), board: await r.board(b.id),
        grants: await r.grants(b.id), invite: await r.invite(i.id), invites: await r.invitesFor(b.id, "cfo@partner.example"),
        link: await r.link(l.id), links: await r.links(b.id), uses: await r.linkUses(b.id, "google:guest"),
      });
      const before = await snap();
      await r.close();
      await expect(r.board(b.id)).rejects.toThrow("closed");
      r = await postgresRegistry({ url, schema, max: 2 });
      expect(await snap()).toEqual(before);
      expect(before.invite).toMatchObject({ revoked: true, expiresAt: 99, createdAt: 7 });
      expect(before.uses).toEqual([l.id]);
      await expect(r.setGrant(b.id, "google:root", null)).rejects.toMatchObject({ code: "last-owner" });
      await expect(r.createTenant({ domain: "ACME.com" })).rejects.toThrow("domain already has a tenant");
    } finally { await r.close(); await drop(schema); }
  });
});
