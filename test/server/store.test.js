// The SQLite Store (server/store/sqlite.js): the shared Store contract (test/server/store-contract.js, F12 of
// p-audit), plus what only SQLite has (pragmas, the injected lease clock, upgrading a file made before the lease).
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { sqliteStore } from "../../server/store/sqlite.js";
import { storeContract, entry, code } from "./store-contract.js";
import { tempDir, cleanup } from "./helpers.js";

afterAll(cleanup);
const T = "t-aaa", B = "b-one";

// Every handle on one file shares one injected clock, as two processes on one machine share the machine's.
storeContract("sqlite", async opts => {
  const path = join(tempDir(), "plenary.db");
  let t = 1_000_000;
  const now = () => t;
  const raw = new Database(path, { create: true }), one = (sql, ...a) => raw.query(sql).run(...a);
  return { store: sqliteStore({ path, now, ...opts }), another: async () => sqliteStore({ path, now, ...opts }), advance: ms => { t += ms; },
    raw: {
      putCheckpointRow: async (t, b, seq, data) => one("INSERT INTO checkpoints (tenant, board, seq, data) VALUES (?, ?, ?, ?)", t, b, seq, data),
      putPartRow: async (t, b, seq, wid, n, data) => one("INSERT INTO checkpoint_parts (tenant, board, seq, wid, n, data) VALUES (?, ?, ?, ?, ?, ?)", t, b, seq, wid, n, data),
      partRows: async (t, b) => raw.query("SELECT count(*) AS c FROM checkpoint_parts WHERE tenant = ? AND board = ?").get(t, b).c,
    } };
});

test("opened with WAL, synchronous=FULL and fullfsync", async () => {
  const store = sqliteStore({ path: join(tempDir(), "plenary.db") });
  expect(store.pragmas()).toEqual({ journal_mode: "wal", synchronous: 2, fullfsync: 1 });
  await store.close();
});

test("lease expiry is judged on the injected clock alone, to the millisecond", async () => {
  let t = 5_000;
  const store = sqliteStore({ path: join(tempDir(), "plenary.db"), now: () => t });
  expect(await store.acquire(T, B, "h-a", 100)).toEqual({ epoch: 1, expiresAt: 5_100 });
  t = 5_099;
  expect(await store.acquire(T, B, "h-b", 100)).toBe(null);                       // 1 ms left
  expect((await store.lease(T, B)).live).toBe(true);
  t = 5_100;
  expect((await store.lease(T, B)).live).toBe(false);                             // expiresAt itself is expired
  expect(await store.acquire(T, B, "h-b", 100)).toEqual({ epoch: 2, expiresAt: 5_200 });
  expect(await store.renew(T, B, "h-b", 2, 1_000)).toEqual({ epoch: 2, expiresAt: 6_100 });
  t = 1.5;
  expect(await code(store.acquire(T, B, "h-c", 100))).toBe("bad-clock");          // a broken clock grants nothing
  await store.close();
});

test("a file made before the lease (epoch-only leases table) is an old-format store: refused with code old-format, and left as it was", () => {
  const path = join(tempDir(), "plenary.db");
  const old = new Database(path, { create: true });
  old.run("CREATE TABLE leases (tenant TEXT NOT NULL, board TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (tenant, board)) WITHOUT ROWID");
  old.run("INSERT INTO leases (tenant, board, epoch) VALUES (?, ?, 5)", [T, B]);
  old.close();
  let err;
  try { sqliteStore({ path }); } catch (e) { err = e; }
  expect(err?.code).toBe("old-format");
  expect(err.message).toMatch(/Reset the store/);
  const after = new Database(path, { readonly: true });
  expect(after.query("PRAGMA table_info(leases)").all().map(c => c.name)).toEqual(["tenant", "board", "epoch"]);   // never ALTERed
  expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name)).toEqual(["leases"]);   // no entries/checkpoints/parts were created
  expect(after.query("PRAGMA journal_mode").get().journal_mode).toBe("delete");                                         // the WAL switch never happened
  after.close();
  rmSync(path);                                                                                                         // no handle was left open: the file can go
});

test("the old-format rule is general: a changed column set in any Store table refuses the file; a reopen of a good file does not", async () => {
  const good = join(tempDir(), "plenary.db"), s = sqliteStore({ path: good }); await s.close();
  sqliteStore({ path: good }).close();
  for (const table of ["entries", "checkpoints", "checkpoint_parts"]) {
    const path = join(tempDir(), "plenary.db"), db = new Database(path);
    db.run(`CREATE TABLE ${table} (tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL)`);   // `data` missing
    db.close();
    let err; try { sqliteStore({ path }); } catch (e) { err = e; }
    expect([table, err?.code]).toEqual([table, "old-format"]);
  }
});

test("a checkpoint stored as one plain JSON row (no header, no parts: what a small checkpoint is) reads, and parts sit beside it", async () => {
  const path = join(tempDir(), "plenary.db");
  const old = new Database(path, { create: true });
  old.run("CREATE TABLE checkpoints (tenant TEXT NOT NULL, board TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tenant, board, seq)) WITHOUT ROWID");
  const cp = { seq: 7, streams: { board: { elements: Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, text: "😀".repeat(20) })) } } };
  old.run("INSERT INTO checkpoints (tenant, board, seq, data) VALUES (?, ?, 7, ?)", [T, B, JSON.stringify(cp)]);
  old.close();
  const store = sqliteStore({ path, partChars: 1000 });
  expect(await store.getCheckpoint(T, B)).toEqual(cp);
  const epoch = await store.openEpoch(T, B);
  await store.putCheckpoint(T, B, { ...cp, seq: 8 }, epoch);
  expect((await store.getCheckpoint(T, B)).seq).toBe(8);
  expect(await store.getCheckpoint(T, B, 8)).toEqual(cp);
  await store.close();
});

test("a header whose parts hold the wrong number of chars is refused as corrupt, never parsed", async () => {
  const path = join(tempDir(), "plenary.db");
  const store = sqliteStore({ path, partChars: 100 });
  const epoch = await store.openEpoch(T, B);
  await store.putCheckpoint(T, B, { seq: 3, pad: "x".repeat(450) }, epoch);
  const raw = new Database(path);
  raw.run("UPDATE checkpoint_parts SET data = substr(data, 2) WHERE n = 1");        // a part lost a char
  expect(await code(store.getCheckpoint(T, B))).toBe("corrupt");
  raw.run("UPDATE checkpoint_parts SET data = '' || data || substr('x', 1, 1) WHERE n = 1");   // restore its length: fine again
  expect((await store.getCheckpoint(T, B)).seq).toBe(3);
  raw.run("DELETE FROM checkpoint_parts WHERE n = 2");                                // a part is gone: a bad checkpoint, skipped like one (no older: null)
  expect(await store.getCheckpoint(T, B)).toBe(null);
  await store.putCheckpoint(T, B, { seq: 2, small: true }, epoch);                   // an older, readable one is what a caller steps back to
  expect(await store.getCheckpoint(T, B)).toEqual({ seq: 2, small: true });
  raw.close(); await store.close();
});
