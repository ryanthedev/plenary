// The cluster id's failure cases (PROTOCOL.md § Bus, Cluster id), with fake adapters, no Postgres or NATS needed:
// a missing or malformed id from the Store refuses the start (fail closed) and closes what opened; the id reaches
// the Bus adapter only through its `cluster` option; a bad one is refused before anything connects; a node from
// before the id (unscoped subjects) and a scoped one never exchange a message.
import { test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { start } from "../../server/main.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { natsBus } from "../../server/adapters/driven/bus/nats.js";
import { subjects } from "../../server/ports/bus.js";
import { tempDir, cleanup, until } from "./helpers.js";

// Failure-only ceiling for tests doing real NATS and start-up work: bun's 5 s default fails them under machine load (TECH-DEBT row 36). It fires only when
// something never completes; nothing asserts on how long a test took. Before the hooks: bun applies it only to hooks registered after it.
setDefaultTimeout(30_000);
afterAll(cleanup);

const ID = "c-0123456789abcdef";
const env = () => ({ PLENARY_DATA_DIR: tempDir(), PORT: "0", LOG_LEVEL: "info", DATABASE_URL: "postgres://u:pw@127.0.0.1:1/p", NATS_URL: "nats://127.0.0.1:1", COOKIE_KEY: "k".repeat(32), PLENARY_BLOBS: "local-disk" });

/** Fake cluster adapters on SQLite and the memory bus; `store` shapes what the Store says about its cluster id. */
function adapters(store, seen = {}) {
  const closed = [];
  return {
    closed, seen,
    postgresStore: async () => { const s = sqliteStore({ path: join(tempDir(), "p.db") }); return { ...s, ...store, close: async () => { closed.push("store"); await s.close(); } }; },
    postgresRegistry: async () => { const r = sqliteRegistry({ path: join(tempDir(), "r.db") }); return { ...r, close: async () => { closed.push("registry"); await r.close(); } }; },
    natsBus: async o => { seen.opts = o; seen.connected = true; return memoryBus({ onError: o.onError, cluster: o.cluster }); },
  };
}

test("DW-iso: a Store with no clusterId() refuses the start, closes what opened, and never opens the bus", async () => {
  const a = adapters({ clusterId: undefined });
  const lines = [];
  await expect(start(env(), { adapters: a, write: l => lines.push(l) })).rejects.toThrow(/^could not read the cluster id \(DATABASE_URL\): the store has no clusterId\(\)/);
  expect(a.closed.sort()).toEqual(["registry", "store"]);
  expect(a.seen.connected).toBeUndefined();
});

test("DW-iso: a malformed cluster id (wrong shape, wildcard, empty, non-string) refuses the start before any bus opens", async () => {
  for (const bad of ["plen", "c-short", "c-0123456789abcde*", "c-0123456789abcdef.x", "", null, 7]) {
    const a = adapters({ clusterId: async () => bad });
    await expect(start(env(), { adapters: a, write: () => {} })).rejects.toThrow(/^could not read the cluster id \(DATABASE_URL\): the store returned a malformed cluster id/);
    expect(a.closed.sort()).toEqual(["registry", "store"]);
    expect(a.seen.connected).toBeUndefined();
  }
});

test("DW-iso: a Store failure while reading the id refuses the start with the URL redacted", async () => {
  const a = adapters({ clusterId: async () => { throw new Error("connect failed to postgres://u:pw@127.0.0.1:1/p"); } });
  const err = await start(env(), { adapters: a, write: () => {} }).catch(e => e);
  expect(err.message).toMatch(/^could not read the cluster id \(DATABASE_URL\): connect failed to \*\*\*/);
  expect(err.message).not.toContain("pw");
  expect(a.closed.sort()).toEqual(["registry", "store"]);
});

test("DW-iso: the id reaches the Bus adapter through its `cluster` option, is logged, and is on the running node", async () => {
  const a = adapters({ clusterId: async () => ID });
  const lines = [];
  const app = await start(env(), { adapters: a, write: l => lines.push(l) });
  try {
    expect(a.seen.opts.cluster).toBe(ID);
    expect(app.clusterId).toBe(ID);
    expect(lines.map(l => JSON.parse(l)).find(l => l.msg === "cluster adapters open")?.cluster).toBe(ID);
  } finally { await app.stop(); }
});

test("DW-iso: natsBus and memoryBus refuse a bad cluster id before connecting; natsBus also refuses to be unscoped by omission", async () => {
  let connects = 0;
  const connect = async () => { connects++; throw new Error("should not connect"); };
  for (const bad of ["plen", "c-x", "", "c-0123456789abcde>", 7]) {
    await expect(natsBus({ url: "nats://127.0.0.1:1", cluster: bad, connect })).rejects.toMatchObject({ code: "bad-id" });
    expect(() => memoryBus({ cluster: bad })).toThrow(/bad cluster id/);
  }
  await expect(natsBus({ url: "nats://127.0.0.1:1", connect })).rejects.toThrow(/needs `cluster`/);   // omitted: not unscoped by default
  expect(connects).toBe(0);
  await expect(natsBus({ url: "nats://127.0.0.1:1", cluster: null, connect })).rejects.toThrow("should not connect");   // null is the explicit unscoped bus: it connects
  expect(connects).toBe(1);
});

test("DW-iso: onError of a scoped bus hears the subject without the cluster prefix, like a handler does", async () => {
  const heard = [];
  const bus = memoryBus({ cluster: ID, maxBytes: 10, onError: (err, subject) => heard.push(subject) });
  await bus.publish(subjects.entries("t-1", "b-1"), "x".repeat(50)).catch(() => {});
  expect(heard).toEqual([subjects.entries("t-1", "b-1")]);
});

test("DW-iso mixed version: a node without the id (unscoped) and one with it exchange nothing, in either direction, on any open or inbox subject", async () => {
  // One shared transport stands in for the NATS server: scoped and unscoped nodes are two views of it.
  const wire = memoryBus();
  const scoped = (await import("../../server/ports/bus.js")).scopeBus(wire, ID);
  const got = { scoped: [], old: [] };
  const names = [subjects.open, subjects.opened("gw-1"), subjects.inbox("t-1", "b-1"), subjects.entries("t-1", "b-1")];
  for (const n of names) { scoped.subscribe(n, m => got.scoped.push(m)); wire.subscribe(n, m => got.old.push(m)); }
  for (const n of names) { await wire.publish(n, "from-old"); await scoped.publish(n, "from-new"); }
  // Barrier: each listener's own sentinel, published from the other side's wire, queues behind everything above (one FIFO wire), so a leaked
  // message would sit ahead of it in the list. The sentinel is the only thing a listener may then hold besides its own side's messages.
  for (const n of names) { await wire.publish(n, "sentinel-old"); await wire.publish(`${ID}.${n}`, "sentinel-new"); }
  const sentinels = (list, v) => list.filter(m => m === v).length;   // wait for the sentinels themselves, so a stray message shows as a diff below, not a timeout
  await until(() => sentinels(got.scoped, "sentinel-new") === names.length && sentinels(got.old, "sentinel-old") === names.length, "both sentinels on every subject");
  expect(got.scoped).toEqual([...names.map(() => "from-new"), ...names.map(() => "sentinel-new")]);
  expect(got.old).toEqual([...names.map(() => "from-old"), ...names.map(() => "sentinel-old")]);
});
