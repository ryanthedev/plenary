// The SQLite Registry (server/registry/sqlite.js): platform's shared contract, plus what only a durable adapter
// has: same answers as the in-memory one on edge cases, close/reopen, two handles on one file, and a real
// cross-process race on the last owner.
import { test, expect, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { registryContract } from "../auth/registry-contract.js";
import { accessEquivalence } from "../auth/access-equivalence.js";
import { Database } from "bun:sqlite";
import { accessRace } from "../auth/access-race.js";
import { mkBoard } from "../auth/fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "plenary-registry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `r${++n}.db`);

// Platform's contract, on a fresh file per test (a file, not :memory:, so WAL and fsync are in play).
registryContract("sqlite", async ({ now }) => sqliteRegistry({ path: file(), now, fullfsync: false }), { cleanup: r => r.close(), batch: true });
accessRace("sqlite", async () => { const path = file(), a = sqliteRegistry({ path, fullfsync: false }), b = sqliteRegistry({ path, fullfsync: false }); return { a, b, close: async () => { await a.close(); await b.close(); } }; });
accessEquivalence("sqlite", async ({ now }) => sqliteRegistry({ path: ":memory:", now, fullfsync: false }), { cleanup: r => r.close() });

// An old-format file: the seven tables from before board organization.
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
test("a file from before the organization (boards, no Spaces) is an old-format store: refused with code old-format, and left as it was", () => {
  const path = file();
  const db = new Database(path, { create: true, strict: true });
  for (const sql of LEGACY_DDL) db.run(sql);
  db.close();
  let err;
  try { sqliteRegistry({ path, fullfsync: false }); } catch (e) { err = e; }
  expect(err?.code).toBe("old-format");
  expect(err.message).toMatch(/Reset the store/);
  const after = new Database(path, { readonly: true });
  expect(after.query("SELECT name FROM sqlite_master WHERE name = 'reg_spaces'").get()).toBe(null);   // nothing was added
  after.close();
});

test("a file holding a board that is in no Space is an old-format store (pre-#90 unfiled board): refused with code old-format, and left as it was", async () => {
  const path = file();
  const r = sqliteRegistry({ path, fullfsync: false });
  const t = await r.createTenant({ domain: "acme.com" }), sp = await r.createSpace({ tenant: t.id, name: "S" });
  const kept = await r.createBoard({ tenant: t.id, space: sp.id }), unfiled = await r.createBoard({ tenant: t.id, space: sp.id });
  await r.close();
  const raw = new Database(path, { strict: true });
  raw.run("DELETE FROM reg_board_spaces WHERE board = ?", [unfiled.id]);   // what an older version left behind
  raw.close();
  let err;
  try { sqliteRegistry({ path, fullfsync: false }); } catch (e) { err = e; }
  expect(err?.code).toBe("old-format");
  expect(err.message).toMatch(/no Space.*Reset the store/);
  const after = new Database(path, { readonly: true });
  expect(after.query("SELECT board FROM reg_board_spaces").all()).toEqual([{ board: kept.id }]);   // nothing was repaired or added
  after.close();
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
      const sp = await r.createSpace({ tenant: t.id, name: "SP" });
      names.set(sp.id, "SP");
      const b = await r.createBoard({ tenant: t.id, space: sp.id, title: 42, memberRole: null });
      names.set(b.id, "B");
      const c = await r.createBoard({ tenant: t.id, space: sp.id });
      names.set(c.id, "C");
      await rec("board B", () => r.board(b.id));
      await rec("board C", () => r.board(c.id));
      await rec("tenant", () => r.tenant(t.id));
      await rec("tenant null domain", () => r.tenant(t2.id));
      await rec("dup domain", () => r.createTenant({ domain: "ACME.COM" }));
      await rec("no tenant board", () => r.createBoard({ tenant: "t-nope", space: sp.id }));
      await rec("no space board", () => r.createBoard({ tenant: t.id }));
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

  test("a store whose reg_idempotency has the old claim/result columns refuses to start with a clear error naming the table", () => {
    const path = file(), old = new Database(path);
    old.run("CREATE TABLE reg_idempotency (member TEXT NOT NULL, k TEXT NOT NULL, fp TEXT NOT NULL, claim TEXT NOT NULL, result TEXT, at INTEGER NOT NULL, PRIMARY KEY (member, k))");
    old.close();
    expect(() => sqliteRegistry({ path, fullfsync: false })).toThrow(/reg_idempotency.*older version.*Reset the store/i);
  });

  test("a store whose reg_access_requests lacks closed_at refuses to start with a clear error naming the table", () => {
    const path = file(), old = new Database(path);
    old.run("CREATE TABLE reg_access_requests (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, member TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (scope_type, scope_id, member))");
    old.close();
    expect(() => sqliteRegistry({ path, fullfsync: false })).toThrow(/reg_access_requests.*older version.*Reset the store/i);
  });

  test("the old-format rule is general: a column missing from ANY table refuses the file, which is left untouched and deletable; a fresh file and a reopen do not false-fire", async () => {
    const fresh = file(); const r = sqliteRegistry({ path: fresh, fullfsync: false }); await r.close();
    const again = sqliteRegistry({ path: fresh, fullfsync: false }); await again.close();   // a reopen: nothing refused
    for (const [table, drop] of [["reg_teams", "created_at"], ["reg_members", "email"], ["reg_scope_grants", "n"], ["reg_tenants", "created_at"]]) {
      const path = file(), db = new Database(path);
      db.run("PRAGMA journal_mode=DELETE");
      sqliteRegistry({ path: fresh, fullfsync: false }).close();      // (shape source) a good file
      const good = new Database(fresh, { readonly: true });
      const cols = good.query(`PRAGMA table_info(${table})`).all().map(c => c.name).filter(c => c !== drop);
      good.close();
      db.run(`CREATE TABLE ${table} (${cols.map(c => `${c} TEXT`).join(", ")})`);
      db.close();
      let err; Bun.gc(true); const fds = readdirSync("/dev/fd").length;   // collect an earlier test's handle first, or it could finalize between the two counts
      try { sqliteRegistry({ path, fullfsync: false }); } catch (e) { err = e; }
      expect([table, err?.code]).toEqual([table, "old-format"]);
      expect(readdirSync("/dev/fd").length).toBe(fds);                                                                      // the refused open left no handle (an rmSync would pass either way)
      expect(err.message).toContain(table);
      const after = new Database(path, { readonly: true });
      expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name)).toEqual([table]);   // nothing was created
      expect(after.query("PRAGMA journal_mode").get().journal_mode).toBe("delete");                                         // the WAL switch never happened
      after.close();
      rmSync(path);                                                                                                         // the handle was released: the file can go
    }
  });

  test("durable keyed create: the key survives close and reopen (a crash after the commit), so the retry gets the first object, not a second", async () => {
    const path = file(), idem = { user: "google:root", key: "key-0001-aaaa", fp: "f".repeat(64) };
    let r = sqliteRegistry({ path, fullfsync: false });
    const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
    const b = await mkBoard(r, { tenant: t.id, title: "Once", owner: "google:root", idem });
    await r.close();   // the process dies after the commit, before any answer was stored anywhere else
    r = sqliteRegistry({ path, fullfsync: false });
    expect(await r.idemGet(idem)).toEqual({ state: "done", ref: b.id });
    await expect(mkBoard(r, { tenant: t.id, title: "Once", owner: "google:root", idem })).rejects.toMatchObject({ code: "idem-replay", ref: b.id });
    expect((await r.boardsIn({ type: "unit", id: t.id })).ids).toEqual([b.id]);
    expect(await r.grants(b.id)).toEqual([{ user: "google:root", role: "owner" }]);
    await r.close();
  });

  test("durable: everything survives close and reopen", async () => {
    const path = file();
    let r = sqliteRegistry({ path, now: () => 7, fullfsync: false });
    const t = await r.createTenant({ domain: "acme.com", admins: ["google:root"] });
    await r.addTenantAdmin(t.id, "google:ann");
    const b = await mkBoard(r, { tenant: t.id, title: "All hands", memberRole: "annotator" });
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
    const board = await mkBoard(a, { tenant: t.id });
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
    const board = await mkBoard(r, { tenant: t.id });
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

  test("backwards-compatible additive migration: an existing SQLite registry without reg_board_versions opens seamlessly and persists versions", async () => {
    const path = file();
    // Create a current-format DB, then drop reg_board_versions to simulate a live pre-#19 registry.db.
    let r = sqliteRegistry({ path, fullfsync: false });
    const t = await r.createTenant({ domain: "acme.com", admins: ["dev:owner"] });
    const b = await mkBoard(r, { tenant: t.id, title: "Live board", owner: "dev:owner" });
    await r.close();

    const raw = new Database(path, { strict: true });
    raw.run("DROP TABLE reg_board_versions");
    raw.close();

    // Reopen: must NOT throw old-format; must recreate reg_board_versions and support full CRUD + survive reopen.
    r = sqliteRegistry({ path, fullfsync: false });
    const created = await r.createBoardVersion({
      tenantId: t.id,
      boardId: b.id,
      label: "Pre-release",
      createdBy: "dev:owner",
      createdByName: "Owner",
      elementCount: 2,
      snapshotJson: JSON.stringify({ elements: [{ id: "1" }, { id: "2" }] }),
    });
    expect(created.label).toBe("Pre-release");
    await r.close();

    r = sqliteRegistry({ path, fullfsync: false });
    const list = await r.listBoardVersions({ tenantId: t.id, boardId: b.id });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
    const full = await r.getBoardVersion({ tenantId: t.id, boardId: b.id, versionId: created.id });
    expect(full?.snapshotJson).toBe(JSON.stringify({ elements: [{ id: "1" }, { id: "2" }] }));
    // Deleting the board cleans up its versions without FK failure.
    expect(await r.deleteBoard(b.id)).toBe(true);
    expect(await r.listBoardVersions({ tenantId: t.id, boardId: b.id })).toEqual([]);
    await r.close();
  });

  test("backwards-compatible additive migration: an existing SQLite registry whose reg_links lacks passcode_hash/no_download upgrades seamlessly", async () => {
    const path = file();
    let r = sqliteRegistry({ path, now: () => 1000, fullfsync: false });
    const t = await r.createTenant({ domain: "acme.com", admins: ["dev:owner"] });
    const b = await mkBoard(r, { tenant: t.id, title: "Live board", owner: "dev:owner" });
    const legacyLink = await r.createLink({ board: b.id, role: "viewer", by: "dev:owner" });
    await r.close();

    // Rewrite reg_links to the pre-#37 8-column schema (without passcode_hash / no_download) while preserving existing rows.
    const raw = new Database(path, { strict: true });
    raw.run("PRAGMA foreign_keys=OFF");
    raw.run(`CREATE TABLE reg_links_old (
      n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, board TEXT NOT NULL REFERENCES reg_boards(id),
      role TEXT NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL, by_user TEXT, created_at INTEGER NOT NULL)`);
    raw.run(`INSERT INTO reg_links_old (n, id, board, role, expires_at, revoked, by_user, created_at)
      SELECT n, id, board, role, expires_at, revoked, by_user, created_at FROM reg_links`);
    raw.run("DROP TABLE reg_links");
    raw.run("ALTER TABLE reg_links_old RENAME TO reg_links");
    raw.run("CREATE INDEX reg_links_board ON reg_links (board)");
    raw.close();

    // Reopen: must NOT throw old-format; must add passcode_hash & no_download via ALTER TABLE.
    r = sqliteRegistry({ path, now: () => 2000, fullfsync: false });
    const readOld = await r.link(legacyLink.id);
    expect(readOld).toMatchObject({ id: legacyLink.id, board: b.id, role: "viewer", hasPasscode: false, noDownload: false });
    expect("passcode_hash" in readOld).toBe(false);
    expect(await r.linkPasscodeHash(legacyLink.id)).toBeNull();

    // New policy-protected link persists across close/reopen without ever returning passcode_hash on link()/links().
    const protectedLink = await r.createLink({
      board: b.id,
      role: "editor",
      passcodeHash: "scrypt$16384$8$1$" + "a".repeat(32) + "$" + "b".repeat(64),
      noDownload: true,
      by: "dev:owner",
    });
    expect(protectedLink).toMatchObject({ hasPasscode: true, noDownload: true });
    expect("passcodeHash" in protectedLink).toBe(false);
    await r.close();

    r = sqliteRegistry({ path, now: () => 3000, fullfsync: false });
    expect(await r.link(protectedLink.id)).toEqual(protectedLink);
    expect(await r.linkPasscodeHash(protectedLink.id)).toBe("scrypt$16384$8$1$" + "a".repeat(32) + "$" + "b".repeat(64));
    await r.close();
  });
});
