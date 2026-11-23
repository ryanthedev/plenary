// #92 end to end below the HTTP edge: Trash -> purge (trash-sweep.js) -> condemn (Store) -> reap (blob-reaper.js) -> bytes gone, on real SQLite
// Registry and Store and the real disk Blobs, one injected clock. The restore-versus-reaper races are here.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { sqliteRegistry } from "../../server/adapters/driven/registry/sqlite.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { diskBlobs } from "../../server/adapters/driven/blobs/disk.js";
import { trashSweeper } from "../../server/core/trash-sweep.js";
import { blobReaper } from "../../server/core/blob-reaper.js";
import { TRASH } from "../../server/ports/registry.js";
import { BLOB_GRACE_MS } from "../../server/ports/blobs.js";
import { tempDir, cleanup, fakePng, sha1 } from "./helpers.js";

afterAll(cleanup);
const U = "google:ada", MIN = 60_000;
let clock, reg, store, blobs, sweeper, reaper, tenant, sp, b1, b2;
const png = n => { const b = fakePng(100 + n, n); return { bytes: b, id: sha1(b) }; };
const entry = (b, seq) => ({ seq, board: b.id, tenant: b.tenant, stream: "board", op: { appState: { grid: seq } }, by: "u1", id: `c:${seq}` });
async function fill(b, ...pics) {
  const epoch = (await store.acquire(b.tenant, b.id, "h-test", 10 * MIN)).epoch;
  for (const p of pics) await blobs.put(b.tenant, p.id, p.bytes);
  await store.append(b.tenant, b.id, [entry(b, 1)], 0, epoch, { blobRefs: pics.map(p => p.id) });
}
const has = async p => (await blobs.get(tenant.id, p.id)) !== null;
/** Both background jobs, as main.js's two timers would run them. */
const tick = async () => { await sweeper.sweep(); return reaper.sweep(); };

beforeEach(async () => {
  clock = { t: Date.UTC(2026, 10, 11) };
  reg = sqliteRegistry({ path: ":memory:", now: () => clock.t });
  store = sqliteStore({ path: ":memory:", now: () => clock.t });
  blobs = diskBlobs({ dir: join(tempDir(), "blobs") });
  const c = { now: () => clock.t };
  sweeper = trashSweeper({ registry: reg, store, clock: c });
  reaper = blobReaper({ store, blobs, clock: c });
  tenant = await reg.createTenant({ domain: "acme.com" });
  sp = await reg.createSpace({ tenant: tenant.id, name: "S", owner: U });
  b1 = await reg.createBoard({ tenant: tenant.id, title: "one", space: sp.id, owner: U });
  b2 = await reg.createBoard({ tenant: tenant.id, title: "two", space: sp.id, owner: U });
});

test("DW-92.1 a purged board's unshared pictures are deleted after the Trash's 30 days and the reaper's grace; the neighbour's and a shared one stay", async () => {
  const mine = png(1), shared = png(2), theirs = png(3);
  await fill(b1, mine, shared); await fill(b2, shared, theirs);
  await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
  clock.t += TRASH.ttlMs - 1;
  await tick();
  expect(await has(mine)).toBe(true);                                         // still in Trash: references survive it, nothing is condemned
  clock.t += 1;
  await tick();                                                                // purged now: condemned, but inside the grace
  expect(await reg.board(b1.id)).toBe(null);
  expect(await has(mine)).toBe(true);
  clock.t += BLOB_GRACE_MS;
  expect(await tick()).toMatchObject({ deleted: 1, failed: 0 });
  expect(await has(mine)).toBe(false);
  expect(await has(shared)).toBe(true); expect(await has(theirs)).toBe(true);
  expect(await blobs.usage(tenant.id)).toBe(shared.bytes.byteLength + theirs.bytes.byteLength);
});

test("DW-92.3 restore never misses a blob: a board in Trash for longer than the grace keeps its pictures, and restores with them", async () => {
  const p = png(4);
  await fill(b1, p);
  await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
  clock.t += TRASH.ttlMs - MIN;                                                // 30 days minus a minute: far past any grace
  expect(await tick()).toMatchObject({ deleted: 0 });
  expect(await has(p)).toBe(true);
  expect(await reg.restoreBoard({ board: b1.id })).toBeTruthy();
  clock.t += 3 * TRASH.ttlMs; await tick();                                    // long after: it is a live board, never purged
  expect(await has(p)).toBe(true);
  expect(await store.lastSeq(tenant.id, b1.id)).toBe(1);
});

test("DW-92.3 restore versus the purge claim: either the restore wins (board and picture stay) or the claim wins (restore refused, picture goes); never a restored board without its picture", async () => {
  const outcomes = new Set();
  for (let i = 0; i < 12; i++) {
    const p = png(20 + i), b = await reg.createBoard({ tenant: tenant.id, title: `r${i}`, space: sp.id, owner: U });
    await fill(b, p);
    await reg.trashBoard({ board: b.id, from: sp.id, by: U });
    clock.t += TRASH.ttlMs;
    let restored = false;
    const restore = () => reg.restoreBoard({ board: b.id }).then(r => { restored = !!r; }, () => {});
    if (i % 2) await Promise.all([restore(), sweeper.sweep()]);                                // together (the restore lands first: the sweep's reads are async)
    else { await sweeper.sweep(); await restore(); }                                           // the claim first: the restore is refused
    outcomes.add(restored);
    await sweeper.sweep();                                                     // whatever was left
    clock.t += BLOB_GRACE_MS; await reaper.sweep();
    const live = await reg.board(b.id);
    if (restored) { expect(live?.trashedAt ?? null).toBe(null); expect(await blobs.get(tenant.id, p.id)).not.toBe(null); expect(await store.lastSeq(tenant.id, b.id)).toBe(1); }
    else { expect(live).toBe(null); expect(await blobs.get(tenant.id, p.id)).toBe(null); }
  }
  expect([...outcomes].sort()).toEqual([false, true]);                          // the loop really saw both winners
});

test("DW-92.3 restore versus the reaper: a board restored after its siblings were purged and condemned keeps what it shares; a hash re-referenced before the delete is kept", async () => {
  const shared = png(5);
  await fill(b1, shared); await fill(b2, shared);
  await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
  await reg.trashBoard({ board: b2.id, from: sp.id, by: U });
  clock.t += TRASH.ttlMs - MIN;
  await reg.restoreBoard({ board: b2.id });                                    // b2 comes back; b1 follows its clock and is purged
  clock.t += MIN;
  await Promise.all([tick(), reg.restoreBoard({ board: b2.id }).catch(() => {})]);
  clock.t += BLOB_GRACE_MS; await tick();
  expect(await reg.board(b1.id)).toBe(null);
  expect(await has(shared)).toBe(true);                                        // b2 still references it
});

test("a Space purged with its boards condemns every picture it held once", async () => {
  const x = png(6), y = png(7);
  await fill(b1, x); await fill(b2, x, y);
  await reg.trashSpace({ space: sp.id, by: U });
  clock.t += TRASH.ttlMs;
  await tick();
  clock.t += BLOB_GRACE_MS;
  expect(await tick()).toMatchObject({ deleted: 2, failed: 0 });
  expect(await has(x)).toBe(false); expect(await has(y)).toBe(false);
});

test("the purge never touches the bytes itself: the Store's purge only condemns, so a failing Blobs adapter cannot fail or stall a purge", async () => {
  const p = png(8);
  await fill(b1, p);
  await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
  clock.t += TRASH.ttlMs;
  const broken = blobReaper({ store, blobs: { ...blobs, delete: async () => { throw new Error("S3 is down"); } }, clock: { now: () => clock.t } });
  expect(await sweeper.sweep()).toMatchObject({ boards: 1, failed: 0 });      // the board is gone
  clock.t += BLOB_GRACE_MS;
  expect(await broken.sweep()).toMatchObject({ deleted: 0, failed: 1 });
  expect(await has(p)).toBe(false);                                            // quarantined (out of reach), not yet destroyed: the row stays claimed
  clock.t += 3 * MIN;
  expect(await reaper.sweep()).toMatchObject({ deleted: 1 });                  // the adapter is back: the claim lapsed and the next sweep finishes it
  expect(await has(p)).toBe(false);
});
