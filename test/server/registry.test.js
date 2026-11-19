// The SQLite Registry (server/registry/sqlite.js): platform's shared contract, plus what only a durable adapter
// has: same answers as the in-memory one on edge cases, close/reopen, two handles on one file, and a real
// cross-process race on the last owner.
import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { registryContract } from "../auth/registry-contract.js";
import { legacyEquivalence } from "../auth/legacy-migration.js";
import { accessEquivalence } from "../auth/access-equivalence.js";
import { Database } from "bun:sqlite";

const dir = mkdtempSync(join(tmpdir(), "plenary-registry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `r${++n}.db`);

// Platform's contract, on a fresh file per test (a file, not :memory:, so WAL and fsync are in play).
registryContract("sqlite", async ({ now }) => sqliteRegistry({ path: file(), now, fullfsync: false }), { cleanup: r => r.close(), batch: true });
accessEquivalence("sqlite", async ({ now }) => sqliteRegistry({ path: ":memory:", now, fullfsync: false }), { cleanup: r => r.close() });

// A database from before board organization: the seven original tables (their DDL as of 1d0bcbe), filled with a legacy state.
const LEGACY_DDL = [
  "CREATE TABLE reg_tenants (id TEXT PRIMARY KEY, domain TEXT UNIQUE, created_at INTEGER NOT NULL)",
  "CREATE TABLE reg_tenant_admins (tenant TEXT NOT NULL REFERENCES reg_tenants(id), member TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tenant, member))",
  "CREATE TABLE reg_boards (id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES reg_tenants(id), title TEXT NOT NULL, member_role TEXT, created_at INTEGER NOT NULL)",
  "CREATE TABLE reg_grants (board TEXT NOT NULL REFERENCES reg_boards(id), member TEXT NOT NULL, role TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (board, member))",
  `CREATE TABLE reg_invites (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id), email TEXT NOT NULL, role TEXT NOT NULL,
    expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE reg_links (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id), role TEXT NOT NULL, expires_at INTEGER,
    revoked INTEGER NOT NULL, by_user TEXT, created_at INTEGER NOT NULL)`,
  "CREATE TABLE reg_link_uses (board TEXT NOT NULL, member TEXT NOT NULL, link TEXT NOT NULL REFERENCES reg_links(id), n INTEGER NOT NULL, PRIMARY KEY (board, member, link))",
];
let legacyFile;
legacyEquivalence("sqlite", {
  async install(st) {
    legacyFile = file();
    const db = new Database(legacyFile, { create: true, strict: true });
    db.run("PRAGMA journal_mode=WAL");
    for (const sql of LEGACY_DDL) db.run(sql);
    st.tenants.forEach(t => { db.run("INSERT INTO reg_tenants VALUES (?, ?, 1)", [t.id, t.domain]); t.admins.forEach((a, n) => db.run("INSERT INTO reg_tenant_admins VALUES (?, ?, ?)", [t.id, a, n + 1])); });
    st.boards.forEach(b => db.run("INSERT INTO reg_boards VALUES (?, ?, ?, ?, 1)", [b.id, b.tenant, b.title, b.memberRole]));
    st.grants.forEach((g, n) => db.run("INSERT INTO reg_grants VALUES (?, ?, ?, ?)", [g.board, g.user, g.role, n + 1]));
    st.invites.forEach(i => db.run("INSERT INTO reg_invites (id, board, email, role, expires_at, revoked, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, 'x', 1)", [i.id, i.board, i.email, i.role, i.expiresAt, i.revoked ? 1 : 0]));
    st.links.forEach(l => db.run("INSERT INTO reg_links (id, board, role, expires_at, revoked, by_user, created_at) VALUES (?, ?, ?, ?, ?, 'x', 1)", [l.id, l.board, l.role, l.expiresAt, l.revoked ? 1 : 0]));
    st.uses.forEach((u, n) => db.run("INSERT INTO reg_link_uses VALUES (?, ?, ?, ?)", [u.board, u.user, u.link, n + 1]));
    db.close();
  },
  async open() { const registry = sqliteRegistry({ path: legacyFile, now: () => 5_000_000, fullfsync: false }); return { registry, close: () => registry.close() }; },
  async count() {
    const db = new Database(legacyFile, { readonly: true });
    try { const c = t => db.query(`SELECT count(*) AS c FROM ${t}`).get().c; return { boards: c("reg_boards"), grants: c("reg_grants"), invites: c("reg_invites"), links: c("reg_links") }; }
    finally { db.close(); }
  },
});

describe("sqlite registry", () => {
  test("pragmas: WAL, synchronous=FULL, fullfsync on by default; start-up leaves the whole busy_timeout", async () => {
    const r = sqliteRegistry({ path: file() });
    expect(r.pragmas()).toEqual({ journal_mode: "wal", synchronous: 2, fullfsync: 1, busy_timeout: 5000 });
    await r.close();
  });

  test("same answers as the in-memory adapter: order, nulls, booleans, garbage ids, error messages", async () => {
    const clock = { t: 1000 };
    const now = () => clock.t;
    const run = async r => {
      const out = [];
      const rec = async (label, f) => {
        try { out.push([label, "ok", await f()]); }
        catch (err) { out.push([label, "err", err.message, err.code ?? null]); }
      };
      // Ids are random; replace them with stable names so the two runs compare.
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
      // Grants: insertion order, and an update keeps its place.
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
      // Garbage ids from the wire: lookups resolve to null / [] / false, never throw (throw = `unavailable`).
      for (const bad of [undefined, null, 7, "../x", "", "b-nope", { id: b.id }]) {
        await rec(`board(${String(bad)})`, () => r.board(bad));
        await rec(`tenant(${String(bad)})`, () => r.tenant(bad));
        await rec(`tenantByDomain(${String(bad)})`, () => r.tenantByDomain(bad));
        await rec(`grant(${String(bad)})`, () => r.grant(bad, "u1"));
        await rec(`grants(${String(bad)})`, () => r.grants(bad));
        await rec(`invite(${String(bad)})`, () => r.invite(bad));
        await rec(`invites(${String(bad)})`, () => r.invites(bad));
        await rec(`invitesFor(${String(bad)})`, () => r.invitesFor(bad, "ann@x.com"));
        await rec(`link(${String(bad)})`, () => r.link(bad));
        await rec(`links(${String(bad)})`, () => r.links(bad));
        await rec(`linkUses(${String(bad)})`, () => r.linkUses(bad, "g"));
        await rec(`revokeLink(${String(bad)})`, () => r.revokeLink(bad));
      }
      await rec("invitesFor bad email", () => r.invitesFor(b.id, 7));
      return scrub(out);
    };
    const s = sqliteRegistry({ path: file(), now, fullfsync: false });
    const sql = await run(s);
    await s.close();
    clock.t = 1000;
    const mem = await run(memoryRegistry({ now }));
    for (let i = 0; i < mem.length; i++) expect([i, sql[i]]).toEqual([i, mem[i]]);
    expect(sql.length).toBe(mem.length);
  });

  test("durable: everything survives close and reopen", async () => {
    const path = file();
    let r = sqliteRegistry({ path, now: () => 7, fullfsync: false });
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
    r = sqliteRegistry({ path, fullfsync: false });
    expect(await snap()).toEqual(before);
    expect(before.invite.revoked).toBe(true);
    expect(before.uses).toEqual([l.id]);
    // The last-owner rule holds on the reopened file too.
    await expect(r.setGrant(b.id, "google:root", null)).rejects.toMatchObject({ code: "last-owner" });
    // A domain stays taken across a reopen.
    await expect(r.createTenant({ domain: "ACME.com" })).rejects.toThrow("domain already has a tenant");
    await r.close();
  });

  test("two handles on one file: the last owner can't be removed through either", async () => {
    const path = file();
    const a = sqliteRegistry({ path, fullfsync: false });
    const b = sqliteRegistry({ path, fullfsync: false });
    const t = await a.createTenant({ domain: null });
    const board = await a.createBoard({ tenant: t.id });
    for (let round = 0; round < 20; round++) {
      await a.setGrant(board.id, "x", "owner");
      await b.setGrant(board.id, "y", "owner");
      const res = await Promise.allSettled([a.setGrant(board.id, "x", null), b.setGrant(board.id, "y", "viewer")]);
      expect(res.filter(r => r.status === "fulfilled").length).toBe(1);
      expect(res.find(r => r.status === "rejected").reason.code).toBe("last-owner");
      for (const h of [a, b]) expect((await h.grants(board.id)).filter(g => g.role === "owner").length).toBe(1);
    }
    await a.close(); await b.close();
  });

  // Two handles in one process can't interleave (each bun:sqlite call runs to completion), so the test above would
  // pass even without a transaction. This one races two processes on one file; each demotes a different owner.
  test("two processes racing to demote the only two owners: exactly one wins, every round", async () => {
    const path = file();
    const r = sqliteRegistry({ path, fullfsync: false });
    const t = await r.createTenant({ domain: null });
    const board = await r.createBoard({ tenant: t.id });
    const ROUNDS = 40;
    const mod = resolve(import.meta.dir, "../../server/registry/sqlite.js");
    const child = user => `
      import { sqliteRegistry } from ${JSON.stringify(mod)};
      const r = sqliteRegistry({ path: ${JSON.stringify(path)}, fullfsync: false, busyTimeoutMs: 20000 });
      const out = [];
      for (let i = 0; i < ${ROUNDS}; i++) {
        // Wait for the round's go file, then demote at once.
        while (!(await Bun.file(${JSON.stringify(path)} + ".go" + i).exists())) await Bun.sleep(1);
        try { await r.setGrant(${JSON.stringify(board.id)}, ${JSON.stringify(user)}, null); out.push("ok"); }
        catch (err) { out.push(err.code ?? String(err)); }
        await Bun.write(${JSON.stringify(path)} + ".done-" + ${JSON.stringify(user)} + i, "");
      }
      await r.close();
      console.log(JSON.stringify(out));`;
    const procs = ["x", "y"].map(u => Bun.spawn([process.execPath, "-e", child(u)], { stdout: "pipe", stderr: "pipe" }));
    try {
      for (let i = 0; i < ROUNDS; i++) {
        await r.setGrant(board.id, "x", "owner");
        await r.setGrant(board.id, "y", "owner");
        await Bun.write(path + ".go" + i, "");
        for (const u of ["x", "y"]) while (!(await Bun.file(path + ".done-" + u + i).exists())) await Bun.sleep(1);
        expect((await r.grants(board.id)).filter(g => g.role === "owner").length).toBe(1);
      }
      const outs = await Promise.all(procs.map(async p => {
        const [code, text, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
        if (code !== 0) throw new Error("child failed: " + err);
        return JSON.parse(text.trim().split("\n").pop());
      }));
      for (let i = 0; i < ROUNDS; i++) expect([outs[0][i], outs[1][i]].sort()).toEqual(["last-owner", "ok"]);
    } finally {
      for (const p of procs) if (p.exitCode == null) p.kill();
      await r.close();
    }
  }, 60_000);
});
