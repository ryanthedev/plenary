// server/registry/sqlite.js: several processes opening one brand-new registry file at the same moment all start.
// Before the fix, `PRAGMA journal_mode=WAL` on a new file failed with "database is locked" (sqlite.js:38) when another
// process held a write lock on it: SQLite returns BUSY for that switch without calling the busy handler. The 12-process
// race hits that only sometimes (machine and timing dependent), so the first test forces it: a child holds a write
// lock on the new, still rollback-mode file while this process opens the registry; the old code failed it every time. Real processes (Bun.spawn) because
// that is how nodes and bootstrap scripts meet, and because the fix's retry sleeps synchronously.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const MOD = new URL("../../server/registry/sqlite.js", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "pl-reg-open-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("open while another process holds the new file's write lock: waits for it instead of failing", async () => {
  const db = join(dir, "held.db");
  const holder = Bun.spawn(["bun", "-e", `
const { Database } = require("bun:sqlite");
const d = new Database(process.env.DB);
d.run("BEGIN IMMEDIATE");                                   // a write lock on the still rollback-mode file (a concurrent opener)
console.log("held");
await Bun.sleep(300);
d.run("COMMIT"); d.close();`], { env: { ...process.env, DB: db }, stdout: "pipe", stderr: "inherit" });
  const reader = holder.stdout.getReader();
  await reader.read();                                       // "held": the lock is taken
  reader.releaseLock();
  const { sqliteRegistry } = await import(MOD);
  const r = sqliteRegistry({ path: db, fullfsync: false });
  try {
    expect((await r.createTenant({ domain: null })).id).toBeString();
  } finally { await r.close(); }
  expect(await holder.exited).toBe(0);
  const check = new Database(db, { readonly: true });
  try { expect(check.query("PRAGMA journal_mode").get().journal_mode).toBe("wal"); } finally { check.close(); }
}, 20_000);

// Each child waits for a shared start time, opens the registry, creates a tenant (a real write), and prints its id.
const CHILD = `
const { sqliteRegistry } = await import(process.env.MOD);
await Bun.sleep(Math.max(0, Number(process.env.AT) - Date.now()));
try {
  const r = sqliteRegistry({ path: process.env.DB, fullfsync: false });
  const t = await r.createTenant({ domain: null });
  await r.close();
  console.log("ok " + t.id);
} catch (e) { console.log("ERR " + e.message); }`;

test("12 processes open the same new registry.db at once, three rounds: every one starts and writes", async () => {
  const N = 12;
  for (let round = 0; round < 3; round++) {
    const db = join(dir, `registry-${round}.db`);
    const AT = String(Date.now() + 500);                     // after every child has loaded
    const ps = Array.from({ length: N }, () =>
      Bun.spawn(["bun", "-e", CHILD], { env: { ...process.env, MOD, DB: db, AT }, stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(ps.map(async p => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      return (out + err).trim();
    }));
    expect(outs.filter(o => !o.startsWith("ok "))).toEqual([]);
    const check = new Database(db, { readonly: true });
    try {
      expect(check.query("PRAGMA journal_mode").get().journal_mode).toBe("wal");
      expect(check.query("SELECT count(*) AS c FROM reg_tenants").get().c).toBe(N);
    } finally { check.close(); }
  }
}, 60_000);
