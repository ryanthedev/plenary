// The purge of Trash (server/trash-sweep.js, PROTOCOL.md § Trash and restore, "Purge"): off an injected clock, claim first, content through the Store port, then the Registry's rows;
// idempotent, safe beside another node, and a partial purge resumes. Real SQLite Registry and Store; no test waits for a timer or 30 real days.
import { test, expect, beforeEach, describe } from "bun:test";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { trashSweeper } from "../../server/trash-sweep.js";
import { TRASH } from "../../server/auth/registry-port.js";

const DAY = 24 * 3600_000;
const U = "google:ada";
let clock, reg, store, sweeper, tenant, sp, b1, b2, warned;
const code = p => p.then(() => null, e => e.code ?? e.message);
const entry = (tenantId, board, seq) => ({ seq, board, tenant: tenantId, stream: "board", op: { appState: { grid: seq } }, by: "u1", id: `c:${seq}` });
/** Writes a board's content into the Store the way a room would. */
async function fill(b, n = 2) {
  const epoch = (await store.acquire(b.tenant, b.id, "h-test", 60_000)).epoch;
  await store.append(b.tenant, b.id, Array.from({ length: n }, (_, i) => entry(b.tenant, b.id, i + 1)), 0, epoch);
  await store.putCheckpoint(b.tenant, b.id, { seq: n, tenant: b.tenant, board: b.id, state: {} }, epoch);
}
const content = async b => ({ seq: await store.lastSeq(b.tenant, b.id), cp: await store.getCheckpoint(b.tenant, b.id), lease: await store.lease(b.tenant, b.id) });

for (const [name, make] of [["sqlite registry", () => sqliteRegistry({ path: ":memory:", now: () => clock.t })], ["memory registry", () => memoryRegistry({ now: () => clock.t })]]) {
  describe(`trash sweep (${name})`, () => {
    beforeEach(async () => {
      clock = { t: Date.UTC(2026, 10, 11) };
      reg = await make();
      store = sqliteStore({ path: ":memory:" });
      warned = [];
      sweeper = trashSweeper({ registry: reg, store, clock: { now: () => clock.t }, log: { warn: (m, f) => warned.push([m, f]) } });
      tenant = await reg.createTenant({ domain: "acme.com" });
      sp = await reg.createSpace({ tenant: tenant.id, name: "S", owner: U });
      b1 = await reg.createBoard({ tenant: tenant.id, title: "one", space: sp.id, owner: U });
      b2 = await reg.createBoard({ tenant: tenant.id, title: "two", space: sp.id, owner: U });
      await fill(b1); await fill(b2);
    });

    test("nothing is purged before its 30 days are over, to the millisecond; then the board's content and rows are gone and the neighbour's are not", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs - 1;
      expect(await sweeper.sweep()).toMatchObject({ boards: 0, spaces: 0, failed: 0 });
      expect((await content(b1)).seq).toBe(2);
      expect((await reg.board(b1.id)).trashedAt).not.toBe(null);
      clock.t += 1;
      expect(await sweeper.sweep()).toMatchObject({ boards: 1, spaces: 0, failed: 0 });
      expect(await content(b1)).toEqual({ seq: 0, cp: null, lease: null });
      expect(await reg.board(b1.id)).toBe(null);
      expect(await reg.grants(b1.id)).toEqual([]);
      expect((await content(b2)).seq).toBe(2);                  // never trashed: untouched
      expect(await reg.board(b2.id)).not.toBe(null);
    });
    test("a restored board is never purged, whatever the clock says", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs - DAY;
      await reg.restoreBoard({ board: b1.id });
      clock.t += 5 * DAY;
      expect(await sweeper.sweep()).toMatchObject({ boards: 0 });
      expect((await content(b1)).seq).toBe(2);
    });
    test("a restore that lands after the sweep read its list but before the claim wins: the board is kept (the claim is conditional)", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs + 1;
      const racy = { ...reg, trashDue: async o => { const due = await reg.trashDue(o); await reg.restoreBoard({ board: b1.id }); return due; }, purgeClaim: o => reg.purgeClaim(o), purgeBoard: id => reg.purgeBoard(id), purgeSpace: id => reg.purgeSpace(id) };
      const s = trashSweeper({ registry: racy, store, clock: { now: () => clock.t } });
      expect(await s.sweep()).toMatchObject({ boards: 0 });
      expect((await content(b1)).seq).toBe(2);
      expect(await reg.board(b1.id)).toMatchObject({ trashedAt: null });
    });
    test("a restore after the claim is refused (purged), so a claimed board is never half restored", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs;
      await reg.purgeClaim({ type: "board", id: b1.id, before: clock.t - TRASH.ttlMs });
      expect(await code(reg.restoreBoard({ board: b1.id }))).toBe("purged");
    });
    test("a partial purge resumes: the Store fails once, the claimed row stays listed and unrestorable, the next sweep finishes", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs;
      let fail = 1;
      const flaky = { purgeBoard: async (t, b) => { if (fail-- > 0) throw new Error("store is down"); return store.purgeBoard(t, b); } };
      const s = trashSweeper({ registry: reg, store: flaky, clock: { now: () => clock.t }, log: { warn: (m, f) => warned.push([m, f]) } });
      expect(await s.sweep()).toMatchObject({ boards: 0, failed: 1 });
      expect(warned.length).toBe(1);
      expect((await content(b1)).seq).toBe(2);                    // the content is still there
      expect(await reg.board(b1.id)).not.toBe(null);              // so is the row (the order: content first, then rows)
      expect(await code(reg.restoreBoard({ board: b1.id }))).toBe("purged");
      expect((await reg.trashDue({ before: 0 })).boards.map(b => b.id)).toEqual([b1.id]);   // listed whatever the clock
      expect(await s.sweep()).toMatchObject({ boards: 1, failed: 0 });
      expect(await content(b1)).toEqual({ seq: 0, cp: null, lease: null });
      expect(await reg.board(b1.id)).toBe(null);
    });
    test("a crash between the content delete and the row delete resumes: the content is already gone, the rows follow", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs;
      await reg.purgeClaim({ type: "board", id: b1.id, before: clock.t });
      await store.purgeBoard(tenant.id, b1.id);                 // the first node died here
      expect(await sweeper.sweep()).toMatchObject({ boards: 1, failed: 0 });
      expect(await reg.board(b1.id)).toBe(null);
    });
    test("idempotent: a second sweep, and two sweeps at once, purge each board once and fail nothing", async () => {
      await reg.trashBoard({ board: b1.id, from: sp.id, by: U });
      await reg.trashBoard({ board: b2.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs;
      const other = trashSweeper({ registry: reg, store, clock: { now: () => clock.t } });      // another node
      const out = await Promise.all([sweeper.sweep(), other.sweep(), sweeper.sweep()]);
      expect(out.map(o => o.failed)).toEqual([0, 0, 0]);
      expect(out[0].boards + out[1].boards).toBeGreaterThanOrEqual(2);
      expect(await reg.board(b1.id)).toBe(null); expect(await reg.board(b2.id)).toBe(null);
      expect(await sweeper.sweep()).toMatchObject({ boards: 0, spaces: 0, failed: 0 });
    });
    test("a Space in Trash goes with its boards after the same 30 days; a board trashed on its own earlier goes on its own clock", async () => {
      await reg.trashBoard({ board: b2.id, from: sp.id, by: U });
      clock.t += 10 * DAY;
      await reg.trashSpace({ space: sp.id, by: U });
      clock.t += 20 * DAY;                                       // b2: 30 days; the Space and b1: 20 days
      expect(await sweeper.sweep()).toMatchObject({ boards: 1, spaces: 0, failed: 0 });
      expect(await reg.board(b2.id)).toBe(null);
      expect((await content(b1)).seq).toBe(2);
      expect(await reg.space(sp.id)).not.toBe(null);
      clock.t += 10 * DAY;
      expect(await sweeper.sweep()).toMatchObject({ boards: 1, spaces: 1, failed: 0 });
      expect(await reg.board(b1.id)).toBe(null);
      expect(await reg.space(sp.id)).toBe(null);
      expect((await content(b1)).seq).toBe(0);
    });
    test("a restored Space is not purged; a Space claimed but with a board the Store failed on is kept until the board is gone", async () => {
      await reg.trashSpace({ space: sp.id, by: U });
      clock.t += 5 * DAY;
      await reg.restoreSpace({ space: sp.id });
      clock.t += 40 * DAY;
      expect(await sweeper.sweep()).toMatchObject({ boards: 0, spaces: 0 });
      await reg.trashSpace({ space: sp.id, by: U });
      clock.t += TRASH.ttlMs;
      let fail = 1;
      const flaky = { purgeBoard: async (t, b) => { if (b === b1.id && fail-- > 0) throw new Error("down"); return store.purgeBoard(t, b); } };
      const s = trashSweeper({ registry: reg, store: flaky, clock: { now: () => clock.t } });
      expect(await s.sweep()).toMatchObject({ boards: 1, spaces: 0, failed: 1 });
      expect(await reg.space(sp.id)).not.toBe(null);              // b1 still references it
      expect(await s.sweep()).toMatchObject({ boards: 1, spaces: 1, failed: 0 });
      expect(await reg.space(sp.id)).toBe(null);
    });
    test("a sweep never rejects: a Registry that throws is a counted failure, and a sweep in flight is joined, not doubled", async () => {
      const broken = { trashDue: async () => { throw new Error("registry down"); } };
      const s = trashSweeper({ registry: broken, store, clock: { now: () => clock.t }, log: { warn: (m, f) => warned.push([m, f]) } });
      expect(await s.sweep()).toMatchObject({ failed: 1 });
      expect(warned.length).toBe(1);
      let calls = 0;
      const slow = { ...reg, trashDue: async o => { calls++; await Bun.sleep(10); return reg.trashDue(o); } };
      const s2 = trashSweeper({ registry: slow, store, clock: { now: () => clock.t } });
      const [a, c] = await Promise.all([s2.sweep(), s2.sweep()]);
      expect(a).toBe(c); expect(calls).toBe(1);
    });
    test("a big Trash drains over passes (limit per read) and reports more when the passes run out", async () => {
      const many = [];
      for (let i = 0; i < 7; i++) many.push(await reg.createBoard({ tenant: tenant.id, title: `m${i}`, space: sp.id, owner: U }));
      for (const b of many) await reg.trashBoard({ board: b.id, from: sp.id, by: U });
      clock.t += TRASH.ttlMs;
      const small = trashSweeper({ registry: reg, store, clock: { now: () => clock.t }, limit: 3, passes: 2 });
      const first = await small.sweep();
      expect(first).toMatchObject({ boards: 6, more: true });
      expect(await small.sweep()).toMatchObject({ boards: 1, more: false });
      for (const b of many) expect(await reg.board(b.id)).toBe(null);
    });
  });
}
