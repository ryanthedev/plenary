// The Postgres Registry (server/registry/postgres.js): platform's shared contract, plus what only Postgres has:
// the last-owner check under real concurrency (two connections), a deterministic row-lock race, same answers as
// the in-memory adapter on edge cases (garbage ids, NUL), durability across a reopen, least privilege (PROTOCOL.md
// § Store, "Least privilege") and concurrent start-up on an empty schema; timeouts (a held lock makes a call reject
// near its limit, and the pool works after), the bounded start-up lock and the start-up privilege probe.
// Skips unless DATABASE_URL is set. Each test gets its own schema, dropped after.
import { describe, test, expect, afterAll } from "bun:test";
import { SQL } from "bun";
import { postgresRegistry, registryTables, REGISTRY_INDEXES } from "../../server/registry/postgres.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { registryContract } from "../auth/registry-contract.js";
import { tenancy } from "../../server/auth/tenancy.js";
import { legacyEquivalence } from "../auth/legacy-migration.js";
import { migrate } from "../../server/pg/schema.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("postgres registry", () => {
  /** @type {SQL} */ let sql;
  const client = () => (sql ??= new SQL({ url, max: 4 }));
  /** Drops a test role and whatever it was granted (a schema left by a failed test would otherwise block DROP ROLE). */
  const dropRole = async role => {
    const [{ c }] = await client().unsafe("SELECT count(*)::int AS c FROM pg_roles WHERE rolname = $1", [role]);
    if (c) { await client().unsafe(`DROP OWNED BY "${role}"`); await client().unsafe(`DROP ROLE "${role}"`); }
  };
  const canCreateRoles = async () =>
    (await client().unsafe("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user"))[0].ok;
  afterAll(async () => {
    try { if (priv.app) await priv.app.close(); if (priv.made) await dropRole(priv.role); if (legacySchema) await drop(legacySchema); }
    finally { if (sql) await sql.close(); }
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
  }, { cleanup: async r => { await r.close(); await drop(schemas.get(r)); schemas.delete(r); }, batch: true });

  // The same contract as a runtime role: USAGE on the schema and row rights on tables an owner created, nothing more
  // (PROTOCOL.md § Store, "Least privilege"). One role for the file; each test's schema is migrated by the owner
  // client, then granted. If the DATABASE_URL role can't create roles, the factory falls back to the owner (warned
  // once), as the least-privilege tests below skip.
  const priv = { role: `pl_test_regrt_${process.pid}`, pass: "pl-test-" + Date.now().toString(36), app: null, off: false, made: false };
  const runtime = async () => {
    if (priv.app || priv.off) return priv.app;
    if (!(await canCreateRoles())) { priv.off = true; console.warn("pg-registry: runtime-role contract runs as the owner (the DATABASE_URL role can't create roles)"); return null; }
    priv.made = true;
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
    try {
      const r = await postgresRegistry({ sql: app ?? client(), schema, now });
      schemas.set(r, schema);
      return r;
    } catch (err) { await drop(schema); throw err; }
  }, { cleanup: async r => { await r.close(); await drop(schemas.get(r)); schemas.delete(r); }, batch: true });

  // A schema from before board organization: only the seven original tables (same DDL, still the first seven of registryTables),
  // filled with a legacy state; the adapter's start-up then creates the rest and must change nobody's access.
  const LEGACY_TABLES = ["reg_tenants", "reg_tenant_admins", "reg_boards", "reg_grants", "reg_invites", "reg_links", "reg_link_uses"];
  let legacySchema = null;
  legacyEquivalence("postgres", {
    async install(st) {
      if (legacySchema) await drop(legacySchema);
      legacySchema = schemaName();
      const all = registryTables(legacySchema), old = Object.fromEntries(LEGACY_TABLES.map(t => [t, all[t]]));
      await client().begin(tx => migrate(tx, legacySchema, old));
      const S = `"${legacySchema}"`, q = (text, p) => client().unsafe(text, p);
      for (const t of st.tenants) { await q(`INSERT INTO ${S}.reg_tenants VALUES ($1, $2, 1)`, [t.id, t.domain]); for (const a of t.admins) await q(`INSERT INTO ${S}.reg_tenant_admins (tenant, member) VALUES ($1, $2)`, [t.id, a]); }
      for (const b of st.boards) await q(`INSERT INTO ${S}.reg_boards VALUES ($1, $2, $3, $4, 1)`, [b.id, b.tenant, b.title, b.memberRole]);
      for (const g of st.grants) await q(`INSERT INTO ${S}.reg_grants (board, member, role) VALUES ($1, $2, $3)`, [g.board, g.user, g.role]);
      for (const i of st.invites) await q(`INSERT INTO ${S}.reg_invites (id, board, email, role, expires_at, revoked, by_user, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'x', 1)`, [i.id, i.board, i.email, i.role, i.expiresAt, i.revoked]);
      for (const l of st.links) await q(`INSERT INTO ${S}.reg_links (id, board, role, expires_at, revoked, by_user, created_at) VALUES ($1, $2, $3, $4, $5, 'x', 1)`, [l.id, l.board, l.role, l.expiresAt, l.revoked]);
      for (const u of st.uses) await q(`INSERT INTO ${S}.reg_link_uses (board, member, link) VALUES ($1, $2, $3)`, [u.board, u.user, u.link]);
    },
    async open() { const registry = await postgresRegistry({ sql: client(), schema: legacySchema, now: () => 5_000_000 }); return { registry, close: () => registry.close() }; },
    async count() {
      const c = async t => Number((await client().unsafe(`SELECT count(*) AS c FROM "${legacySchema}".${t}`))[0].c);
      return { boards: await c("reg_boards"), grants: await c("reg_grants"), invites: await c("reg_invites"), links: await c("reg_links") };
    },
  });
  test("accessContext is ONE statement (one snapshot), cold or with a held chain; a cold hello is a handful", async () => {
    const schema = schemaName();
    let reads = 0;
    const counted = new Proxy(client(), { get: (t, p) => (p === "unsafe" ? (...a) => { reads++; return t.unsafe(...a); } : typeof t[p] === "function" ? t[p].bind(t) : t[p]) });
    const r = await postgresRegistry({ sql: counted, schema });
    try {
      const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
      const g = await r.createGroup({ tenant: t.id, name: "P" }), sp = await r.createSpace({ tenant: t.id, name: "D", group: g.id });
      const tm = await r.createTeam({ tenant: t.id, name: "T" });
      for (const u of ["google:a", "google:b"]) await r.setTeamMember(tm.id, u, true);
      await r.setScopedGrant({ scope: { type: "group", id: g.id }, subject: { type: "team", id: tm.id }, role: "editor" });
      await r.setScopedGrant({ scope: { type: "unit", id: t.id }, subject: { type: "user", id: "google:a" }, role: "member" });
      const b = await r.createBoard({ tenant: t.id, space: sp.id });
      const scope = { type: "board", id: b.id };
      reads = 0;
      const cold = await r.accessContext(scope, { users: ["google:a"] });
      expect(reads).toBe(1);
      expect(cold.teams).toEqual({ [tm.id]: ["google:a"] });
      expect([cold.board.id, cold.space.id, cold.group.id, cold.tenant.id]).toEqual([b.id, sp.id, g.id, t.id]);
      reads = 0;
      const warm = await r.accessContext(scope, { users: ["google:b"], chain: { tenant: cold.tenant, board: cold.board, space: cold.space, group: cold.group } });
      expect(reads).toBe(1);
      expect(warm.teams).toEqual({ [tm.id]: ["google:b"] });
      expect(warm.scoped).toEqual(cold.scoped);
      for (const type of ["space", "group", "unit"]) { reads = 0; expect(await r.accessContext({ type, id: { space: sp.id, group: g.id, unit: t.id }[type] })).not.toBe(null); expect(reads).toBe(1); }
      reads = 0;
      expect(await r.accessContext({ type: "board", id: "b-nope00000000" })).toBe(null);
      expect(reads).toBe(1);
      // a whole cold hello through tenancy: accessContext + grant + invitesFor + linkUses
      reads = 0;
      const ten = tenancy({ registry: r });
      expect(await ten.role({ user: "google:a", email: "a@acme.com", domain: "acme.com" }, b.id)).toBe("editor");
      expect(reads).toBe(4);
    } finally { await r.close(); await drop(schema); }
  });

  test("two connections racing to demote a Space's only two owners (and a Group's): exactly one wins, every round", async () => {
    const schema = schemaName();
    const a = await postgresRegistry({ url, schema, max: 2 });
    const b = await postgresRegistry({ url, schema, max: 2 });
    try {
      const t = await a.createTenant({ domain: null });
      const g = await a.createGroup({ tenant: t.id, name: "P" }), sp = await a.createSpace({ tenant: t.id, name: "D" });
      for (const scope of [{ type: "space", id: sp.id }, { type: "group", id: g.id }]) for (let round = 0; round < 25; round++) {
        await a.setScopedGrant({ scope, subject: { type: "user", id: "x" }, role: "owner" });
        await b.setScopedGrant({ scope, subject: { type: "user", id: "y" }, role: "owner" });
        const res = await Promise.allSettled([a.setScopedGrant({ scope, subject: { type: "user", id: "x" }, role: null }), b.setScopedGrant({ scope, subject: { type: "user", id: "y" }, role: round % 2 ? "viewer" : null })]);
        expect(res.filter(x => x.status === "fulfilled").length).toBe(1);
        expect(res.find(x => x.status === "rejected").reason.code).toBe("last-owner");
        for (const h of [a, b]) expect((await h.scopedGrants(scope)).filter(x => x.role === "owner").length).toBe(1);
        await a.setScopedGrant({ scope, subject: { type: "user", id: "x" }, role: "owner" });   // reset: x owner again, y whatever remains
        await a.setScopedGrant({ scope, subject: { type: "user", id: "y" }, role: null }).catch(() => {});
      }
    } finally { await a.close(); await b.close(); await drop(schema); }
  });

  test("a Team's last member leaving races an owner demotion: the container never ends with no counted owner", async () => {
    const schema = schemaName();
    const a = await postgresRegistry({ url, schema, max: 2 });
    const b = await postgresRegistry({ url, schema, max: 2 });
    try {
      const t = await a.createTenant({ domain: null });
      const sp = await a.createSpace({ tenant: t.id, name: "D", owner: "u" }), tm = await a.createTeam({ tenant: t.id, name: "T" });
      const scope = { type: "space", id: sp.id };
      for (let round = 0; round < 25; round++) {
        await a.setTeamMember(tm.id, "m", true);
        await a.setScopedGrant({ scope, subject: { type: "team", id: tm.id }, role: "owner" });
        const res = await Promise.allSettled([a.setScopedGrant({ scope, subject: { type: "user", id: "u" }, role: null }), b.setTeamMember(tm.id, "m", false)]);
        expect(res.filter(x => x.status === "fulfilled").length).toBe(1);
        const counted = (await a.scopedGrants(scope)).filter(g => g.role === "owner" && (g.subject.type === "user" || g.subject.id === tm.id));
        const has = (await a.teamMembers(tm.id)).length > 0;
        expect(counted.some(g => g.subject.type === "user") || (has && counted.some(g => g.subject.type === "team"))).toBe(true);
        await a.setTeamMember(tm.id, "m", true);
        await a.setScopedGrant({ scope, subject: { type: "user", id: "u" }, role: "owner" });
        await a.setScopedGrant({ scope, subject: { type: "team", id: tm.id }, role: null });
      }
    } finally { await a.close(); await b.close(); await drop(schema); }
  });

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

  /** Waits (up to 10 s) until at least `n` backends are blocked on a lock in a statement matching `like`; asserts they are, so a loaded machine fails cleanly. */
  const waitBlocked = async (like, n = 1) => {
    let c = 0;
    for (let i = 0; i < 500 && c < n; i++) {
      c = (await client().unsafe(`SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [like]))[0].c;
      if (c < n) await Bun.sleep(20);
    }
    expect(c).toBeGreaterThanOrEqual(n);
  };

  test("a Team's last member leaving, stalled on a container's lock, and a grant to the same Team on another container: serialised per tenant, nothing orphaned", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 2 }), r2 = await postgresRegistry({ url, schema, max: 2 });
    const other = await client().reserve();
    try {
      const t = await r.createTenant({ domain: null });
      const s1 = await r.createSpace({ tenant: t.id, name: "S1", owner: "ann" }), s2 = await r.createSpace({ tenant: t.id, name: "S2", owner: "ann" });
      const team = await r.createTeam({ tenant: t.id, name: "T" });
      await r.setTeamMember(team.id, "m", true);
      const T = { type: "team", id: team.id }, ann = { type: "user", id: "ann" }, S2 = { type: "space", id: s2.id };
      await r.setScopedGrant({ scope: { type: "space", id: s1.id }, subject: T, role: "owner" });          // T (one member) co-owns S1 with ann
      await other.unsafe("BEGIN");
      await other.unsafe(`SELECT id FROM "${schema}".reg_spaces WHERE id = $1 FOR UPDATE`, [s1.id]);       // S1's row lock is held elsewhere
      const removal = r.setTeamMember(team.id, "m", false).then(() => "ok", e => e.code ?? e.message);
      await waitBlocked(`%"${schema}".reg_spaces%FOR UPDATE%`);                                             // the removal holds the tenant lock and waits on S1
      // T becomes an owner of S2 and ann is demoted there: both calls queue behind the removal's tenant lock (they used to slip past it)
      let granted = false;
      const grant = r2.setScopedGrant({ scope: S2, subject: T, role: "owner" }).then(() => { granted = true; });
      await waitBlocked("%pg_advisory_xact_lock%");
      expect(granted).toBe(false);
      await other.unsafe("COMMIT");
      expect(await removal).toBe("ok");                                                                      // S1 still has ann
      await grant;
      expect((await r2.setScopedGrant({ scope: S2, subject: ann, role: null }).catch(e => e)).code).toBe("last-owner");   // T is empty now: ann is S2's only counted owner
      expect(await r.teamMembers(team.id)).toEqual([]);
      expect((await r.scopedGrants(S2)).map(g => g.subject.id).sort()).toEqual(["ann", team.id].sort());
    } finally { await other.unsafe("ROLLBACK").catch(() => {}); other.release(); await r.close(); await r2.close(); await drop(schema); }
  }, 30_000);

  test("two Teams losing their last members at once, one of them granted onto the other's container meanwhile: one removal is refused, every round", async () => {
    const schema = schemaName();
    const a = await postgresRegistry({ url, schema, max: 2 }), b = await postgresRegistry({ url, schema, max: 2 });
    const other = await client().reserve();
    try {
      const t = await a.createTenant({ domain: null });
      const s1 = await a.createSpace({ tenant: t.id, name: "S1", owner: "ann" }), s2 = await a.createSpace({ tenant: t.id, name: "S2" });
      const t1 = await a.createTeam({ tenant: t.id, name: "T1" }), t2 = await a.createTeam({ tenant: t.id, name: "T2" });
      const S1 = { type: "space", id: s1.id }, S2 = { type: "space", id: s2.id }, T1 = { type: "team", id: t1.id }, T2 = { type: "team", id: t2.id };
      const counted = async scope => {
        let n = 0;
        for (const g of (await a.scopedGrants(scope)).filter(g => g.role === "owner")) n += g.subject.type === "user" || (await a.teamMembers(g.subject.id)).length ? 1 : 0;
        return n;
      };
      await a.setScopedGrant({ scope: S1, subject: T1, role: "owner" });
      // 1. the exact interleaving, with S1's row lock held so removal A stalls after reading T1's containers {S1}
      await a.setTeamMember(t1.id, "m1", true); await a.setTeamMember(t2.id, "m2", true);
      await a.setScopedGrant({ scope: S2, subject: T2, role: "owner" });                                    // S2's only owner is T2 (one member)
      await other.unsafe("BEGIN");
      await other.unsafe(`SELECT id FROM "${schema}".reg_spaces WHERE id = $1 FOR UPDATE`, [s1.id]);
      const A = a.setTeamMember(t1.id, "m1", false).then(() => "ok", e => e.code ?? e.message);
      await waitBlocked(`%"${schema}".reg_spaces%FOR UPDATE%`);
      const grant = b.setScopedGrant({ scope: S2, subject: T1, role: "owner" }).then(() => "ok", e => e.code ?? e.message);   // T1 onto S2
      const B = b.setTeamMember(t2.id, "m2", false).then(() => "ok", e => e.code ?? e.message);
      await waitBlocked("%pg_advisory_xact_lock%", 2);
      await other.unsafe("COMMIT");
      const res = await Promise.all([A, grant, B]);
      expect(res.filter(x => x === "last-owner").length).toBeLessThanOrEqual(1);
      expect([await counted(S1), await counted(S2)].every(n => n >= 1)).toBe(true);
      // 2. then unstalled rounds of the same race (it failed 21 of 25 rounds before the tenant lock)
      for (let round = 0; round < 25; round++) {
        for (const [tm, m] of [[t1, "m1"], [t2, "m2"]]) await a.setTeamMember(tm.id, m, true);
        await a.setScopedGrant({ scope: S2, subject: T2, role: "owner" });
        await a.setScopedGrant({ scope: S2, subject: T1, role: null });
        const race = await Promise.all([a.setTeamMember(t1.id, "m1", false).then(() => "ok", e => e.code), b.setScopedGrant({ scope: S2, subject: T1, role: "owner" }).then(() => "ok", e => e.code), b.setTeamMember(t2.id, "m2", false).then(() => "ok", e => e.code)]);
        expect(race.some(x => x && x !== "ok" && x !== "last-owner")).toBe(false);
        expect([await counted(S1), await counted(S2)].every(n => n >= 1)).toBe(true);
      }
    } finally { await other.unsafe("ROLLBACK").catch(() => {}); other.release(); await a.close(); await b.close(); await drop(schema); }
  }, 30_000);

  test("two connections creating a tenant for one domain at once: one wins, the other gets the usual error", async () => {
    const schema = schemaName();
    const started = await Promise.allSettled(Array.from({ length: 6 }, () => postgresRegistry({ url, schema, max: 2 })));
    const hs = started.filter(x => x.status === "fulfilled").map(x => x.value);
    try {
      expect(hs.length).toBe(6);
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
    if (!(await canCreateRoles())) { console.warn("pg-registry: skipping the least-privilege test (the DATABASE_URL role can't create roles)"); return; }
    const schema = schemaName(), bare = schemaName(), role = `pl_test_regapp_${process.pid}_${++n}`, pass = "pl-test-" + Date.now().toString(36);
    let app = null;
    try {
      const owner = await postgresRegistry({ sql: client(), schema });            // the owner migrates (tables + indexes)
      await owner.close();
      await client().unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
      await client().unsafe(`CREATE SCHEMA "${bare}"`);                          // made for the app, never migrated
      for (const sch of [schema, bare]) await client().unsafe(`GRANT USAGE ON SCHEMA "${sch}" TO "${role}"`);
      await client().unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      const u = new URL(url); u.username = role; u.password = pass;
      app = new SQL({ url: u.toString(), max: 2 });
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
      if (app) await app.close();
      await drop(schema); await drop(bare);
      await dropRole(role);
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
    // allSettled: if one start fails, the others' pools still close and the schema is still dropped.
    const started = await Promise.allSettled(Array.from({ length: 8 }, () => postgresRegistry({ url, schema, max: 1 })));
    const hs = started.filter(x => x.status === "fulfilled").map(x => x.value);
    try {
      expect(started.filter(x => x.status === "rejected").map(x => x.reason?.message)).toEqual([]);
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
  }, 30_000);   // two cold start-ups on fresh pools (TECH-DEBT row 23): sized for a loaded machine, not for the 80 ms it takes alone
  // --- Timeouts (server/auth/registry-port.js: a timeout REJECTS; p2-tunev HIGH 1: a held lock kept grant() pending
  // past 15 s). Each case holds a real lock from another connection, and uses unequal limits so one code is certain.

  /** Runs `f` while `other` holds `lock` (SQL run in an open transaction); always rolls back and releases. */
  const whileLocked = async (lock, f) => {
    const other = await client().reserve();
    try { await other.unsafe("BEGIN"); await other.unsafe(lock); return await f(); }
    finally { await other.unsafe("ROLLBACK").catch(() => {}); other.release(); }
  };
  /** Waits until `f()` is true (polls every 10 ms, at most 5 s). */
  const until = async f => { for (let i = 0; i < 500 && !f(); i++) await Bun.sleep(10); expect(f()).toBe(true); };
  /** Settles `p`, returning [error or null, elapsed ms]. */
  const timed = async p => { const t0 = performance.now(); const e = await p.then(() => null, x => x); return [e, performance.now() - t0]; };

  test("a table lock held elsewhere: grant() rejects with lock-timeout near lockTimeoutMs, others still answer, and the pool works after", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 2, lockTimeoutMs: 400, statementTimeoutMs: 10_000 });
    try {
      expect(await r.readSettings()).toEqual({ lock_timeout: "400ms", statement_timeout: "10s" });
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await r.setGrant(b.id, "u", "editor");
      await whileLocked(`LOCK TABLE "${schema}".reg_grants IN ACCESS EXCLUSIVE MODE`, async () => {
        const [err, took] = await timed(r.grant(b.id, "u"));
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe("lock-timeout");
        expect(err.message).toMatch(/^postgres registry: grant waited over 400 ms for a lock/);
        expect(err.cause?.errno).toBe("55P03");
        expect(took).toBeGreaterThan(350);
        expect((await r.board(b.id))?.id).toBe(b.id);                 // an unlocked table answers meanwhile
        // Several at once on a two-connection pool: two are sent and wait the lock limit, the rest give up waiting
        // for a connection (queue-timeout, never sent); none hangs or stacks.
        const all = await Promise.all(Array.from({ length: 6 }, () => timed(r.grant(b.id, "u"))));
        expect(all.map(([e]) => e?.code).sort()).toEqual(["lock-timeout", "lock-timeout", "queue-timeout", "queue-timeout", "queue-timeout", "queue-timeout"]);
      });
      for (let i = 0; i < 4; i++) expect(await r.grant(b.id, "u")).toBe("editor"); // both connections usable again
      await r.setGrant(b.id, "u", "viewer");
      expect(await r.grant(b.id, "u")).toBe("viewer");
    } finally { await r.close(); await drop(schema); }
  });

  test("tenantAdminsAmong: right answer with a bound; a held table lock gives statement-timeout at the BOUND (not the session limit); the one-connection pool is clean after", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 1, lockTimeoutMs: 10_000, statementTimeoutMs: 10_000 });
    try {
      const t = await r.createTenant({ domain: null, admins: ["dev:a"] });
      expect(await r.tenantAdminsAmong(["dev:a", "dev:b"], { timeoutMs: 2000 })).toEqual(["dev:a"]);
      expect(await r.tenantAdminsAmong(["dev:b"], { timeoutMs: 2000 })).toEqual([]);
      await whileLocked(`LOCK TABLE "${schema}".reg_tenant_admins IN ACCESS EXCLUSIVE MODE`, async () => {
        const [err, took] = await timed(r.tenantAdminsAmong(["dev:a"], { timeoutMs: 300 }));
        expect(err?.code).toBe("statement-timeout");
        expect(err.message).toMatch(/^postgres registry: tenantAdminsAmong ran past 300 ms/);   // the limit that applied, not 10000
        expect(took).toBeGreaterThan(250);
        expect(took).toBeLessThan(2000);
      });
      // The bound was transaction-local: the only connection reads its session default again and still serves.
      expect(await r.readSettings()).toEqual({ lock_timeout: "10s", statement_timeout: "10s" });
      expect((await r.tenant(t.id))?.admins).toEqual(["dev:a"]);
      expect(await r.tenantAdminsAmong(["dev:a"])).toEqual(["dev:a"]);                          // no bound: still works
    } finally { await r.close(); await drop(schema); }
  });

  test("a row lock held elsewhere: setGrant rejects with statement-timeout near statementTimeoutMs and changes nothing", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 2, lockTimeoutMs: 10_000, statementTimeoutMs: 400 });
    try {
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await r.setGrant(b.id, "o", "owner");
      await whileLocked(`SELECT id FROM "${schema}".reg_boards WHERE id = '${b.id}' FOR UPDATE`, async () => {
        const [err, took] = await timed(r.setGrant(b.id, "u", "editor"));
        expect(err?.code).toBe("statement-timeout");
        expect(err.message).toMatch(/^postgres registry: setGrant ran past 400 ms/);
        expect(err.cause?.errno).toBe("57014");
        expect(took).toBeGreaterThan(350);
        expect(await r.grant(b.id, "o")).toBe("owner");              // plain reads don't wait on a row lock
      });
      expect(await r.grant(b.id, "u")).toBe(null);                    // the refused write left nothing behind
      await r.setGrant(b.id, "u", "editor");
      expect(await r.grants(b.id)).toEqual([{ user: "o", role: "owner" }, { user: "u", role: "editor" }]);
    } finally { await r.close(); await drop(schema); }
  });

  test("on a caller's sql, writes are still bounded (SET LOCAL per transaction)", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ sql: client(), schema, lockTimeoutMs: 300, statementTimeoutMs: 10_000 });
    try {
      expect(await r.settings()).toMatchObject({ synchronous_commit: "on", lock_timeout: "300ms", statement_timeout: "10s" });
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await r.setGrant(b.id, "o", "owner");
      await whileLocked(`SELECT id FROM "${schema}".reg_boards WHERE id = '${b.id}' FOR UPDATE`, async () => {
        const [err, took] = await timed(r.setGrant(b.id, "u", "editor"));
        expect(err?.code).toBe("lock-timeout");
      });
      await r.setGrant(b.id, "u", "editor");
      expect(await r.grant(b.id, "u")).toBe("editor");
    } finally { await r.close(); await drop(schema); }
  });

  test("start-up waits at most lockTimeoutMs for the schema's start-up lock, then fails with lock-timeout (url and sql)", async () => {
    const schema = schemaName();
    try {
      await whileLocked(`SELECT pg_advisory_xact_lock(hashtext('plenary-schema:${schema}'))`, async () => {
        for (const o of [{ url, max: 1 }, { sql: client() }]) {
          const [err, took] = await timed(postgresRegistry({ ...o, schema, lockTimeoutMs: 400 }));
          expect(err?.code).toBe("lock-timeout");
          expect(err.message).toMatch(/^postgres registry: start-up waited 400 ms for schema "pl_test_reg_\w+"'s start-up lock/);
          expect(took).toBeGreaterThan(350);
        }
      });
      await (await postgresRegistry({ url, schema, max: 1, lockTimeoutMs: 400 })).close();   // released: it starts
    } finally { await drop(schema); }
  });

  test("start-up probe: a role with USAGE but missing table rights fails start-up with code denied, naming what it lacks", async () => {
    if (!(await canCreateRoles())) { console.warn("pg-registry: skipping the start-up probe test (the DATABASE_URL role can't create roles)"); return; }
    const schema = schemaName(), role = `pl_test_regprobe_${process.pid}_${++n}`, pass = "pl-test-" + Date.now().toString(36);
    let app = null;
    try {
      await (await postgresRegistry({ sql: client(), schema })).close();          // the owner migrates
      await client().unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
      await client().unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      const u = new URL(url); u.username = role; u.password = pass;
      app = new SQL({ url: u.toString(), max: 1 });
      // No table grants at all (the PG15+ mistake): before the probe this started, then every call failed 42501.
      let err = await postgresRegistry({ sql: app, schema }).then(() => null, e => e);
      expect(err?.code).toBe("denied");
      expect(err.message).toMatch(/^postgres registry: start-up in schema "pl_test_reg_\w+" was refused for lack of a privilege \(permission denied: this role lacks SELECT on reg_tenants, INSERT on reg_tenants,/);
      expect(err.cause?.errno).toBe("42501");
      // SELECT only: a has_table_privilege list would pass this ("any of"); each right is probed on its own.
      await client().unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      err = await postgresRegistry({ sql: app, schema }).then(() => null, e => e);
      expect(err?.code).toBe("denied");
      expect(err.message).toContain("lacks INSERT on reg_tenants, UPDATE on reg_tenants, DELETE on reg_tenants");
      expect(err.message).not.toContain("SELECT on");
      // One table short: named alone.
      await client().unsafe(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      await client().unsafe(`REVOKE DELETE ON "${schema}".reg_link_uses FROM "${role}"`);
      err = await postgresRegistry({ sql: app, schema }).then(() => null, e => e);
      expect(err?.message).toContain("(permission denied: this role lacks DELETE on reg_link_uses)");
      await client().unsafe(`GRANT DELETE ON "${schema}".reg_link_uses TO "${role}"`);
      const r = await postgresRegistry({ sql: app, schema });                     // every right: it starts
      expect(await r.tenant("t-nope")).toBe(null);
      await r.close();
    } finally {
      if (app) await app.close();
      await drop(schema);
      await dropRole(role);
    }
  });
  // --- The client-side gate (p5-pgpriv2v H1, M1, L1). Statements are warmed (prepared) on every connection before
  // the lock, as on a running server: without the gate, Bun queued calls per connection and the k-th rejected at
  // about k x the limit, and an unrelated read waited behind them.

  /** `n` calls of `f` at once, so every connection of the pool runs (and prepares) it. */
  const warm = (n, f) => Promise.all(Array.from({ length: n }, f));

  for (const [max, stmt] of [[1, 800], [2, 800], [1, 8000], [2, 8000]]) {
    test(`warm statements, max ${max}, lock 800 / statement ${stmt} ms: 8 calls behind a table lock all settle under 1.5x the lock limit (none stacks)`, async () => {
      const schema = schemaName(), lim = 800;
      const r = await postgresRegistry({ url, schema, max, lockTimeoutMs: lim, statementTimeoutMs: stmt });
      try {
        const t = await r.createTenant({ domain: null });
        const b = await r.createBoard({ tenant: t.id });
        await r.setGrant(b.id, "u", "editor");
        await warm(max, () => r.grant(b.id, "u"));
        await whileLocked(`LOCK TABLE "${schema}".reg_grants IN ACCESS EXCLUSIVE MODE`, async () => {
          const all = await Promise.all(Array.from({ length: 8 }, () => timed(r.grant(b.id, "u"))));
          const codes = all.map(([e]) => e?.code);
          const sentCode = stmt === lim ? "statement-timeout" : "lock-timeout";       // equal limits: statement fires first
          for (const c of codes) expect([sentCode, "queue-timeout"]).toContain(c);
          expect(codes.filter(c => c === sentCode).length).toBe(max);                // the sent ones, one per connection
        });
        await until(() => r.gate().running === 0);
        expect(await r.grant(b.id, "u")).toBe("editor");                            // usable again
      } finally { await r.close(); await drop(schema); }
    });
  }

  test("queue-timeout means never sent: a write that timed out waiting is absent after the lock clears", async () => {
    const schema = schemaName(), lim = 800;
    const r = await postgresRegistry({ url, schema, max: 1, lockTimeoutMs: lim, statementTimeoutMs: lim });
    try {
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await r.setGrant(b.id, "o", "owner");
      const [first, second] = await whileLocked(`SELECT id FROM "${schema}".reg_boards WHERE id = '${b.id}' FOR UPDATE`, async () => {
        const p1 = r.setGrant(b.id, "u1", "editor").then(() => "ok", e => e.code);       // sent: waits on the row lock
        const p2 = r.setGrant(b.id, "u2", "editor").then(() => "ok", e => e.code);       // waits for the one connection
        expect(await p2).toBe("queue-timeout");                                          // at about 210 ms
        return [p1, "queue-timeout"];
      });                                                                                // lock released before 800 ms
      expect(await first).toBe("ok");                                                    // the sent one then committed
      expect(second).toBe("queue-timeout");
      expect(await r.grant(b.id, "u1")).toBe("editor");
      expect(await r.grant(b.id, "u2")).toBe(null);                                      // never sent, never committed
    } finally { await r.close(); await drop(schema); }
  });

  test("a saturated pool sheds an unrelated read at once with overloaded; with room it is bounded by queueTimeoutMs", async () => {
    const schema = schemaName(), lim = 1000;
    const r = await postgresRegistry({ url, schema, max: 2, maxQueued: 3, lockTimeoutMs: lim, statementTimeoutMs: lim });
    try {
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await warm(2, () => r.board(b.id));
      await warm(2, () => r.grant(b.id, "u"));
      expect(r.gate()).toEqual({ running: 0, waiting: 0, maxInFlight: 2, maxQueued: 3, queueTimeoutMs: 250 });
      await whileLocked(`LOCK TABLE "${schema}".reg_grants IN ACCESS EXCLUSIVE MODE`, async () => {
        const stuck = Array.from({ length: 5 }, () => r.grant(b.id, "u").catch(e => e.code)), timedOut = [];  // 2 sent, 3 waiting
        stuck.forEach(p => p.then(c => { if (c === "queue-timeout") timedOut.push(c); }));
        expect(r.gate()).toMatchObject({ running: 2, waiting: 3 });
        const [err, took] = await timed(r.board(b.id));
        expect(err?.code).toBe("overloaded");
        expect(timedOut).toEqual([]);                                                      // shed at once: before any queued read hit its queue timeout (not queued behind them)
        expect(await Promise.all(stuck.slice(2))).toEqual(["queue-timeout", "queue-timeout", "queue-timeout"]);
        // Room again, both connections still stuck: the read waits here, bounded, and is not sent.
        const [err2, took2] = await timed(r.board(b.id));
        expect(err2?.code).toBe("queue-timeout");
        await Promise.all(stuck);
      });
      expect((await r.board(b.id))?.id).toBe(b.id);
    } finally { await r.close(); await drop(schema); }
  });

  test("reads on a caller's sql without session limits are bounded for the caller (client-timeout)", async () => {
    const schema = schemaName(), lim = 300;
    const r = await postgresRegistry({ sql: client(), schema, lockTimeoutMs: lim, statementTimeoutMs: lim });
    try {
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await whileLocked(`LOCK TABLE "${schema}".reg_grants IN ACCESS EXCLUSIVE MODE`, async () => {
        const [err, took] = await timed(r.grant(b.id, "u"));
        expect(err?.code).toBe("client-timeout");                     // the caller's session has no lock_timeout
        expect(took).toBeGreaterThan(lim + 900);
        expect(r.gate().running).toBe(1);                             // its connection is still busy, and counted
      });
      await until(() => r.gate().running === 0);                      // the lock cleared: the stray read finished
    } finally { await r.close(); await drop(schema); }
  });

  test("close() rejects calls still waiting at the gate", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 1, lockTimeoutMs: 2000, statementTimeoutMs: 2000 });
    let closed = false;
    try {
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await whileLocked(`LOCK TABLE "${schema}".reg_grants IN ACCESS EXCLUSIVE MODE`, async () => {
        const sent = r.grant(b.id, "u").catch(e => e.code);
        const queued = r.grant(b.id, "u").catch(e => e.message);
        const c = r.close(); closed = true;
        expect(await queued).toBe("registry: closed");
        await sent; await c;
      });
    } finally { if (!closed) await r.close(); await drop(schema); }
  });
  // p5-pgpriv3v M1: after an event-loop stall the I/O that frees the connection (and the gate's pump, in its
  // microtasks) runs before B's overdue queue timer. B must still not be sent. The lock is released by the server
  // itself (pg_sleep, then COMMIT, in the holder's own session), independent of this loop, during the stall.
  test("a queued call whose deadline passed during an event-loop stall is not sent when the connection frees", async () => {
    const schema = schemaName();
    const r = await postgresRegistry({ url, schema, max: 1, lockTimeoutMs: 1000, statementTimeoutMs: 10_000 });
    const holder = await client().reserve();
    try {
      expect(r.gate().queueTimeoutMs).toBe(250);
      const t = await r.createTenant({ domain: null });
      const b = await r.createBoard({ tenant: t.id });
      await r.grant(b.id, "warm");                                      // prepared, as on a running server
      await holder.unsafe("BEGIN");
      await holder.unsafe(`LOCK TABLE "${schema}".reg_grants IN ACCESS EXCLUSIVE MODE`);
      // The server ends the lock at ~200 ms. `.then` now: a Bun SQL query is only sent once something subscribes.
      const released = holder.unsafe("SELECT pg_sleep(0.2); COMMIT").simple().then(() => "released");
      const a = r.grant(b.id, "u").then(() => "ok", e => e.code);      // sent: waits on the lock
      const bCall = r.setGrant(b.id, "late", "editor").then(() => "ok", e => e.code);   // queued (one connection)
      await Bun.sleep(10);
      expect(r.gate()).toMatchObject({ running: 1, waiting: 1 });
      Bun.sleepSync(600);                                               // the stall: past B's 250 ms deadline
      expect(await a).toBe("ok");                                       // the lock cleared during the stall
      expect(await bCall).toBe("queue-timeout");
      expect(await released).toBe("released");
      expect(await r.grant(b.id, "late")).toBe(null);                   // never sent, so never committed
      await until(() => r.gate().running === 0 && r.gate().waiting === 0);   // no slot leaked
    } finally { holder.release(); await r.close(); await drop(schema); }
  });
});
