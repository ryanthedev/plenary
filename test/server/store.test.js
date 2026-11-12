// The SQLite Store (server/store/sqlite.js): the shared Store contract (test/server/store-contract.js, F12 of
// p-audit), plus what only SQLite has (pragmas, the injected lease clock, upgrading a file made before the lease).
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { sqliteStore } from "../../server/store/sqlite.js";
import { storeContract, entry, code } from "./store-contract.js";
import { tempDir, cleanup } from "./helpers.js";

afterAll(cleanup);
const T = "t-aaa", B = "b-one";

// Every handle on one file shares one injected clock, as two processes on one machine share the machine's.
storeContract("sqlite", async () => {
  const path = join(tempDir(), "plenary.db");
  let t = 1_000_000;
  const now = () => t;
  return { store: sqliteStore({ path, now }), another: async () => sqliteStore({ path, now }), advance: ms => { t += ms; } };
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

test("a file made before the lease (epoch-only leases table) is upgraded in place and keeps its epochs", async () => {
  const path = join(tempDir(), "plenary.db");
  const old = new Database(path, { create: true });
  old.run("CREATE TABLE leases (tenant TEXT NOT NULL, board TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (tenant, board)) WITHOUT ROWID");
  old.run("INSERT INTO leases (tenant, board, epoch) VALUES (?, ?, 5)", [T, B]);
  old.close();
  const store = sqliteStore({ path });
  expect(await store.epoch(T, B)).toBe(5);
  expect(await store.lease(T, B)).toEqual({ holder: null, epoch: 5, expiresAt: null, live: false });
  expect((await store.acquire(T, B, "h-a", 1_000)).epoch).toBe(6);                // unheld: taken at once
  await store.append(T, B, [entry(1)], 0, 6);
  expect(await store.openEpoch(T, B)).toBe(7);
  await store.close();
  const again = sqliteStore({ path });                                            // a second open: no ALTER runs twice
  expect(await again.epoch(T, B)).toBe(7);
  await again.close();
});
