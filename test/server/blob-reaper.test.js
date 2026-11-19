// The blob reaper (server/blob-reaper.js, PROTOCOL.md § Blobs, "References and purge", #92) over a real SQLite Store and the real disk Blobs,
// on one injected clock that drives the Store's lease/grace clock and the reaper's budget alike. Nothing waits for a timer or an hour.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { sqliteStore } from "../../server/store/sqlite.js";
import { diskBlobs } from "../../server/blobs/disk.js";
import { blobReaper } from "../../server/blob-reaper.js";
import { blobAccess, URL_TTL_MS } from "../../server/blob-access.js";
import { BLOB_GRACE_MS, BLOB_PENDING_MS } from "../../server/blobs/port.js";
import { tempDir, cleanup, fakePng, sha1, deferred } from "./helpers.js";

afterAll(cleanup);
const T = "t-aaa", MIN = 60_000;
let t, store, blobs, logs, deleted, reaper;
const entry = (board, seq) => ({ seq, board, tenant: T, stream: "board", op: { appState: { grid: seq } }, by: "u1", id: `c:${seq}` });
const png = n => { const b = fakePng(100 + n, n); return { bytes: b, id: sha1(b) }; };
/** Stores the bytes and appends an op that references them, as a room host would. */
async function place(board, ...pics) {
  const epoch = (await store.acquire(T, board, "h-test", 10 * MIN)).epoch;
  for (const p of pics) await blobs.put(T, p.id, p.bytes);
  await store.append(T, board, [entry(board, 1)], 0, epoch, { blobRefs: pics.map(p => p.id) });
}
const has = async p => (await blobs.get(T, p.id)) !== null;
const make = (o = {}) => blobReaper({ store, blobs: o.blobs ?? blobs, clock: { now: () => t.now }, log: { warn: (m, f) => logs.push(["warn", m, f]), error: (m, f) => logs.push(["error", m, f]) },
  onDeleted: tenant => deleted.push(tenant), ...o });
beforeEach(() => {
  t = { now: 1_000_000 }; logs = []; deleted = [];
  store = sqliteStore({ path: ":memory:", now: () => t.now });
  blobs = diskBlobs({ dir: join(tempDir(), "blobs") });
  reaper = make();
});

test("the grace is longer than the signed URL's life, and the reaper refuses a grace that is not", () => {
  expect(BLOB_GRACE_MS).toBeGreaterThan(URL_TTL_MS + BLOB_PENDING_MS);
  expect(() => make({ graceMs: URL_TTL_MS })).toThrow(RangeError);
  expect(() => make({ graceMs: URL_TTL_MS + 1 })).not.toThrow();
});

test("DW-92.1: a purged board's unshared blobs are deleted, but only once the grace has passed, to the millisecond; the quota hook hears of the tenant", async () => {
  const p = png(1);
  await place("b-one", p); await store.purgeBoard(T, "b-one");
  expect(await reaper.sweep()).toMatchObject({ deleted: 0, failed: 0 });
  t.now += BLOB_GRACE_MS - 1;
  expect(await reaper.sweep()).toMatchObject({ deleted: 0 });
  expect(await has(p)).toBe(true);
  t.now += 1;
  expect(await reaper.sweep()).toEqual({ deleted: 1, failed: 0, raced: 0, more: false });
  expect(await has(p)).toBe(false);
  expect(await blobs.usage(T)).toBe(0);
  expect(deleted).toEqual([T]);
  expect(await store.blobCondemned({ graceMs: 0, limit: 10 })).toEqual([]);          // the condemnation is gone too
  expect(await reaper.sweep()).toMatchObject({ deleted: 0 });                          // nothing left to do
});

test("DW-92.2: a hash two boards share survives the purge of one, and is deleted with the last", async () => {
  const shared = png(2), mine = png(3);
  await place("b-one", shared, mine); await place("b-two", shared);
  await store.purgeBoard(T, "b-one");
  t.now += BLOB_GRACE_MS;
  expect(await reaper.sweep()).toMatchObject({ deleted: 1 });
  expect(await has(shared)).toBe(true); expect(await has(mine)).toBe(false);
  await store.purgeBoard(T, "b-two");
  t.now += BLOB_GRACE_MS;
  await reaper.sweep();
  expect(await has(shared)).toBe(false);
});

test("DW-92.2: a hash referenced again during the grace is kept (a new op in another board, or an upload's pending reference)", async () => {
  const again = png(4), uploading = png(5);
  await place("b-one", again, uploading); await store.purgeBoard(T, "b-one");
  t.now += 10 * MIN;
  await place("b-two", again);                                                          // an op names it again
  await store.blobPend(T, "b-three", uploading.id, BLOB_PENDING_MS);                    // an upload for it was just asked for
  t.now += BLOB_GRACE_MS;
  expect(await reaper.sweep()).toMatchObject({ deleted: 0, failed: 0 });
  expect(await has(again)).toBe(true); expect(await has(uploading)).toBe(true);
});

test("DW-92.2 the guard: a hash a board references is never deleted even if its condemnation outlived the reference (a purge that raced an append)", async () => {
  const path = join(tempDir(), "plenary.db");
  store = sqliteStore({ path, now: () => t.now });
  const p = png(6);
  await place("b-one", p); await store.purgeBoard(T, "b-one");
  const raw = new Database(path);
  raw.query("INSERT INTO blob_refs (tenant, sha1, board) VALUES (?, ?, ?)").run(T, p.id, "b-two");   // the reference that committed after the purge read "no other use"
  raw.close();
  t.now += BLOB_GRACE_MS;
  expect(await make().sweep()).toMatchObject({ deleted: 0, failed: 0 });
  expect(await has(p)).toBe(true);
  expect(await store.blobCondemned({ graceMs: 0, limit: 10 })).toEqual([]);              // the stale condemnation is dropped too
});

test("a failing delete never stops the others, is counted, leaves the item for a later sweep, and the cursor keeps it from holding the head", async () => {
  const pics = [png(7), png(8), png(9), png(10)];
  for (const [i, p] of pics.entries()) { await place(`b-${i}`, p); await store.purgeBoard(T, `b-${i}`); }
  t.now += BLOB_GRACE_MS;
  const bad = new Set([pics[0].id, pics[1].id].sort().slice(0, 1));                     // the first hash in key order fails
  let calls = [];
  const flaky = { ...blobs, delete: async (tenant, id) => { calls.push(id); if (bad.has(id)) throw new Error("S3 is down"); return blobs.delete(tenant, id); } };
  const r1 = make({ blobs: flaky, limit: 2 });
  expect(await r1.sweep()).toMatchObject({ deleted: 3, failed: 1 });                    // limit 2: pages of two, and every page is reached
  expect(logs.some(([l, m]) => l === "warn" && /reap failed/.test(m))).toBe(true);
  const stuck = pics.find(p => bad.has(p.id));
  expect(await has(stuck)).toBe(true);
  bad.clear(); t.now += 3 * MIN;                                                        // the failed item's claim lapsed; the store is back
  expect(await r1.sweep()).toMatchObject({ deleted: 1, failed: 0 });
  expect(await has(stuck)).toBe(false);
});

test("a sweep stops at its time budget (on the injected clock), reports `more`, and the next sweep goes on from where it stopped", async () => {
  const pics = [png(11), png(12), png(13)];
  for (const [i, p] of pics.entries()) { await place(`b-${i}`, p); await store.purgeBoard(T, `b-${i}`); }
  t.now += BLOB_GRACE_MS;
  const slow = { ...blobs, delete: async (tenant, id) => { t.now += 1000; return blobs.delete(tenant, id); } };   // each delete "takes" a second
  const r = make({ blobs: slow, budgetMs: 1500 });
  expect(await r.sweep()).toMatchObject({ deleted: 2, more: true });
  expect(await r.sweep()).toMatchObject({ deleted: 1, more: false });
  for (const p of pics) expect(await has(p)).toBe(false);
});

test("a Store that fails never makes sweep reject; a sweep already running is joined, not doubled", async () => {
  const down = make({ store: { blobPrune: async () => 0, blobCondemned: async () => { throw new Error("db down"); }, blobClaim: async () => false, blobReaped: async () => true } });
  expect(await down.sweep()).toMatchObject({ failed: 1 });
  const p = png(14);
  await place("b-one", p); await store.purgeBoard(T, "b-one"); t.now += BLOB_GRACE_MS;
  const [a, b] = [reaper.sweep(), reaper.sweep()];
  expect(a).toBe(b);
  expect(await a).toMatchObject({ deleted: 1 });
});

test("two nodes sweeping at once delete a hash once: the second's claim fails while the first's delete is in flight", async () => {
  const p = png(15);
  await place("b-one", p); await store.purgeBoard(T, "b-one"); t.now += BLOB_GRACE_MS;
  const gate = deferred(); const calls = [];
  const slow = { ...blobs, delete: async (tenant, id) => { calls.push(id); await gate.promise; return blobs.delete(tenant, id); } };
  const a = make({ blobs: slow }), b = make({ blobs: slow });
  const ra = a.sweep();
  while (!calls.length) await Bun.sleep(1);
  expect(await b.sweep()).toMatchObject({ deleted: 0, failed: 0 });                      // held by a
  gate.resolve();
  expect(await ra).toMatchObject({ deleted: 1 });
  expect(calls).toEqual([p.id]);
});

test("a node that dies mid-delete costs one retry: its claim lapses and another node finishes", async () => {
  const p = png(16);
  await place("b-one", p); await store.purgeBoard(T, "b-one"); t.now += BLOB_GRACE_MS;
  expect(await store.blobClaim(T, p.id, { graceMs: BLOB_GRACE_MS, claimMs: 2 * MIN })).toBe(true);   // the dead node's claim, no delete
  expect(await reaper.sweep()).toMatchObject({ deleted: 0 });
  t.now += 2 * MIN;
  expect(await reaper.sweep()).toMatchObject({ deleted: 1 });
  expect(await has(p)).toBe(false);
});

test("DW-92.3 residual race: a reference that lands during the delete is not lost silently: the sweep counts it as raced and logs an error; the op's reference stays", async () => {
  const p = png(17);
  await place("b-one", p); await store.purgeBoard(T, "b-one"); t.now += BLOB_GRACE_MS;
  const gate = deferred(); const midDelete = deferred();
  const slow = { ...blobs, delete: async (tenant, id) => { midDelete.resolve(); await gate.promise; return blobs.delete(tenant, id); } };
  const run = make({ blobs: slow }).sweep();
  await midDelete.promise;
  expect(await store.blobClaim(T, p.id, { graceMs: 0, claimMs: MIN })).toBe(false);      // claimed: nobody else deletes it
  await place("b-two", p);                                                               // an op names the picture now
  gate.resolve();
  expect(await run).toMatchObject({ raced: 1 });
  expect(logs.find(([l]) => l === "error")?.[1]).toMatch(/reaped under a new reference/);
  await store.purgeBoard(T, "b-two");                                                    // the reference is real: its board's purge condemns it again
  expect(await store.blobCondemned({ graceMs: 0, limit: 10 })).toEqual([{ tenant: T, sha1: p.id }]);
});

test("a PUT URL for a hash being deleted is refused (the gateway answers unavailable), and a quota recount after deletes frees the space for the next put", async () => {
  const a = png(18), b = png(19);
  await place("b-one", a); await store.purgeBoard(T, "b-one"); t.now += BLOB_GRACE_MS;
  expect(await store.blobClaim(T, a.id, { graceMs: BLOB_GRACE_MS, claimMs: 2 * MIN })).toBe(true);
  expect(await store.blobPend(T, "b-two", a.id, MIN).catch(e => e.code)).toBe("unavailable");
  await store.blobReaped(T, a.id); await blobs.delete(T, a.id);
  // Quota: room for exactly one of them.
  const access = blobAccess({ blobs, key: new Uint8Array(32).fill(5), now: () => t.now, quotaBytes: a.bytes.byteLength + 10 });
  const tokenOf = u => u.slice(u.lastIndexOf("/") + 1);
  const put = async p => access.put(tokenOf(await access.url(T, "b-x", p.id, "PUT")), p.bytes);
  expect(await put(a)).toMatchObject({ ok: true, created: true });
  expect(await put(b)).toEqual({ ok: false, code: "quota" });
  await blobs.delete(T, a.id);                                                           // the reaper's delete
  expect(await put(b)).toEqual({ ok: false, code: "quota" });                            // the node still counts the old bytes ...
  access.recount(T);                                                                     // ... until it is told
  expect(await put(b)).toMatchObject({ ok: true, created: true });
});
