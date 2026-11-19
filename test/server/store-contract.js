// The Store contract (PROTOCOL.md § Store), as reusable bun tests. Every Store adapter runs the same suite:
//
//   import { storeContract } from "./store-contract.js";
//   storeContract("postgres", async () => { ...; return { store, another, cleanup } });
//
// `make()` is an async factory for a FRESH, empty store. It returns:
//   store            the store under test
//   another()        opens a second handle on the SAME data (a reopen after close, or a second host)
//   cleanup()        optional; runs after the test (drop the schema, remove the file)
//   advance(ms)      optional; moves the store's lease clock forward (an adapter with an injected clock, shared by
//                    `another()`). Without it, the lease cases wait out a short real ttl on the database's clock.
// The adapter is expected to keep the newest 3 checkpoints per board (the adapters' default `keepCheckpoints`).
// Refusals are matched by `err.code` (PortError codes: conflict, fenced, bad-entry, bad-id, closed).
// Optional, cluster adapters only: `clusterId(): Promise<string>` (PROTOCOL.md § Bus, Cluster id: "c-" + 16 of [a-z0-9],
// minted by the first caller, durable, the same for every handle on the same data). A single-node Store (SQLite)
// has none: its bus is in-process, so no other cluster can share it. The cases below run for an adapter that has it.
// Adapter-specific checks (pragmas, settings) stay in the adapter's own test file.

import { describe, test, expect, afterEach } from "bun:test";

const T = "t-aaa", B = "b-one";
/** Lease ttls: LONG never lapses inside a test; SHORT is waited out by `expire()`. */
const LONG = 60_000, SHORT = 300;
export const entry = (seq, o = {}) => ({ seq, board: B, tenant: T, stream: "board", op: { appState: { grid: seq } }, by: "u1", id: `c:${seq}`, ...o });
/** Take the board's lease as a test host and return its epoch: every append and checkpoint is fenced (§ Store). */
export const own = async (store, tenant = T, board = B) => (await store.acquire(tenant, board, "h-test", LONG)).epoch;
export const code = async p => { try { await p; return "resolved"; } catch (e) { return e.code ?? `threw ${e.message}`; } };

/**
 * @param {string} name
 * @param {() => Promise<{ store: any, another: () => Promise<any>, cleanup?: () => Promise<void>|void }>} make
 */
export function storeContract(name, make) {
  describe(`Store contract: ${name}`, () => {
    const handles = [];
    let cleanups = [];
    const fresh = async () => {
      const h = await make();
      handles.push(h.store);
      if (h.cleanup) cleanups.push(h.cleanup);
      const another = async () => { const s = await h.another(); handles.push(s); return s; };
      // Let a lease taken with SHORT lapse: on the injected clock, or by waiting on the database's.
      const expire = async () => { if (h.advance) h.advance(SHORT + 1); else await Bun.sleep(SHORT + 150); };
      return { store: h.store, another, expire };
    };
    afterEach(async () => {
      for (const s of handles.splice(0)) await s.close();
      for (const c of cleanups.splice(0)) await c();
    });

    test("clusterId (adapters that have it): c-+16, stable, the same through another handle, never changes, refused on a closed store", async () => {
      const { store, another } = await fresh();
      if (typeof store.clusterId !== "function") return;                    // single-node adapters declare none
      const id = await store.clusterId();
      expect(id).toMatch(/^c-[a-z0-9]{16}$/);
      expect(await store.clusterId()).toBe(id);
      const other = await another();
      expect(await other.clusterId()).toBe(id);
      expect(await code(other.close().then(() => other.clusterId()))).toBe("closed");
      expect(await store.clusterId()).toBe(id);                               // a closed sibling changes nothing
    });

    test("append is conditional on expectSeq; a stale one throws conflict and writes nothing", async () => {
      const { store } = await fresh();
      const e = await own(store);
      expect(await store.lastSeq(T, B)).toBe(0);
      await store.append(T, B, [entry(1), entry(2)], 0, e);
      expect(await store.lastSeq(T, B)).toBe(2);
      expect(await code(store.append(T, B, [entry(1)], 0, e))).toBe("conflict");      // behind
      expect(await code(store.append(T, B, [entry(2)], 1, e))).toBe("conflict");      // that seq is taken
      expect(await code(store.append(T, B, [entry(4)], 3, e))).toBe("conflict");      // ahead: would leave a gap
      await store.append(T, B, [entry(3)], 2, e);
      expect((await store.read(T, B, 1, 100)).map(e => e.seq)).toEqual([1, 2, 3]);
    });

    test("append is atomic: one bad entry in a batch writes none of it", async () => {
      const { store } = await fresh();
      const e = await own(store);
      await store.append(T, B, [entry(1)], 0, e);
      const circular = entry(3); circular.op.self = circular;
      for (const batch of [
        [entry(2), entry(4)],                               // not contiguous
        [entry(2), entry(3, { board: "b-two" })],           // another board's entry
        [entry(2), entry(3, { tenant: "t-bbb" })],          // another tenant's entry
        [entry(2), circular],                               // can't be serialised
        [entry(2), null],
      ]) expect(await code(store.append(T, B, batch, 1, e))).toBe("bad-entry");
      expect(await code(store.append(T, B, [], 1, e))).toBe("bad-entry");
      expect(await code(store.append(T, B, [entry(2)], -1, e))).toBe("bad-entry");
      expect(await code(store.append(T, B, [entry(2)], 1.5, e))).toBe("bad-entry");
      expect(await store.lastSeq(T, B)).toBe(1);
      expect(await store.read(T, B, 1, 100)).toEqual([entry(1)]);
    });

    test("read is ascending from fromSeq (inclusive), limited, and returns what was appended", async () => {
      const { store } = await fresh();
      const e = await own(store);
      const all = Array.from({ length: 25 }, (_, i) => entry(i + 1));
      await store.append(T, B, all.slice(0, 10), 0, e);
      await store.append(T, B, all.slice(10), 10, e);
      expect(await store.read(T, B, 1, 1000)).toEqual(all);
      expect(await store.read(T, B, 0, 1000)).toEqual(all);
      expect((await store.read(T, B, 20, 1000)).map(e => e.seq)).toEqual([20, 21, 22, 23, 24, 25]);
      expect((await store.read(T, B, 5, 3)).map(e => e.seq)).toEqual([5, 6, 7]);
      expect(await store.read(T, B, 26, 10)).toEqual([]);
      expect(await code(store.read(T, B, 1, 0))).toBe("bad-entry");
      expect(await code(store.read(T, B, -1, 10))).toBe("bad-entry");
    });

    test("entries round-trip exactly: quotes, backslashes, braces, unicode, emoji, big numbers, nulls", async () => {
      const { store } = await fresh();
      const e = await own(store);
      const odd = [
        entry(1, { op: { text: `"quoted" \\back\\slash {braces} [a,b] 'single' \t tab \n newline` } }),
        entry(2, { op: { text: "héllo wörld — 日本語 🎉👩‍👩‍👧", n: 2 ** 53 - 1, f: -0.125, z: null, b: false, arr: [[], {}, ""] } }),
        entry(3, { op: { text: "\u0000 NUL inside a string,   line sep" } }),
      ];
      await store.append(T, B, odd, 0, e);
      expect(await store.read(T, B, 1, 10)).toEqual(odd);
    });

    test("read with maxBytes: stops near the budget, always returns >= 1 entry, and reports bytes", async () => {
      const { store } = await fresh();
      const e = await own(store);
      const big = n => entry(n, { op: { text: "x".repeat(1000) } });
      await store.append(T, B, [big(1), big(2), big(3), big(4)], 0, e);
      const one = JSON.stringify(big(1)).length;
      const page = await store.read(T, B, 1, 100, one * 2 + 10);
      expect(page.map(e => e.seq)).toEqual([1, 2]);
      expect(page.bytes.length).toBe(2);
      expect(page.bytes[0]).toBe(one);
      const tiny = await store.read(T, B, 3, 100, 1);
      expect(tiny.map(e => e.seq)).toEqual([3]);
      const none = await store.read(T, B, 9, 100, 1);
      expect(none).toEqual([]);
      expect(none.bytes).toEqual([]);
      expect(await code(store.read(T, B, 1, 10, 0))).toBe("bad-entry");
    });

    test("boards and tenants are separate logs", async () => {
      const { store } = await fresh();
      const e = await own(store);
      const e2 = await own(store, T, "b-two");
      const e3 = await own(store, "t-bbb", B);
      await store.append(T, B, [entry(1)], 0, e);
      await store.append(T, "b-two", [entry(1, { board: "b-two" })], 0, e2);
      await store.append("t-bbb", B, [entry(1, { tenant: "t-bbb" }), entry(2, { tenant: "t-bbb" })], 0, e3);
      expect(await store.lastSeq(T, B)).toBe(1);
      expect(await store.lastSeq("t-bbb", B)).toBe(2);
      expect((await store.read("t-bbb", B, 1, 10)).every(e => e.tenant === "t-bbb")).toBe(true);
      expect(await store.read(T, "b-none", 1, 10)).toEqual([]);
    });

    test("ids that aren't server ids are refused at the port", async () => {
      const { store } = await fresh();
      for (const bad of ["", "a.b", "*", ">", "../x", "A", 7, null, "x".repeat(65), "a\u0000b"]) {
        expect(await code(store.append(bad, B, [entry(1, { tenant: bad })], 0, 1))).toBe("bad-id");
        expect(await code(store.read(T, bad, 1, 10))).toBe("bad-id");
        expect(await code(store.lastSeq(bad, B))).toBe("bad-id");
        expect(await code(store.putCheckpoint(T, bad, { seq: 1 }, 1))).toBe("bad-id");
        expect(await code(store.getCheckpoint(bad, B))).toBe("bad-id");
      }
    });

    test("checkpoints: the highest seq wins, never the last write", async () => {
      const { store } = await fresh();
      const e = await own(store);
      expect(await store.getCheckpoint(T, B)).toBe(null);
      await store.putCheckpoint(T, B, { seq: 10, streams: { board: "ten" } }, e);
      await store.putCheckpoint(T, B, { seq: 30, streams: { board: "thirty" } }, e);
      await store.putCheckpoint(T, B, { seq: 20, streams: { board: "twenty" } }, e);   // a slow, older write lands last
      expect(await store.getCheckpoint(T, B)).toEqual({ seq: 30, streams: { board: "thirty" } });
      await store.putCheckpoint(T, B, { seq: 30, streams: { board: "again" } }, e);    // equal seq doesn't replace
      expect((await store.getCheckpoint(T, B)).streams.board).toBe("thirty");
      expect(await store.getCheckpoint(T, "b-two")).toBe(null);
      expect(await code(store.putCheckpoint(T, B, { streams: {} }, e))).toBe("bad-entry");
      expect(await code(store.putCheckpoint(T, B, null, e))).toBe("bad-entry");
    });

    test("checkpoints: a big one (encoded in slices) reads back exactly, and a big one from a fenced holder writes nothing", async () => {
      const { store } = await fresh();
      const e = await own(store);
      const elements = Array.from({ length: 6000 }, (_, i) => ({ id: `e${i}`, type: "rectangle", x: i, text: "é😀\"\\".repeat(40), points: [[i, 1], [2, 3]], gone: undefined }));
      const cp = { seq: 9, streams: { board: { elements, appState: { herdr: { layers: [{ id: "base" }] } } } }, noteAuthor: [["a", "b"]] };
      expect(JSON.stringify(cp).length).toBeGreaterThan(1_000_000);
      await store.putCheckpoint(T, B, cp, e);
      expect(await store.getCheckpoint(T, B)).toEqual(JSON.parse(JSON.stringify(cp)));
      expect(await store.openEpoch(T, B)).toBeGreaterThan(e);           // the board moves on: e is stale
      expect(await code(store.putCheckpoint(T, B, { ...cp, seq: 12 }, e))).toBe("fenced");
      expect((await store.getCheckpoint(T, B)).seq).toBe(9);
    });

    test("checkpoints: beforeSeq steps back past a bad one; only the newest 3 are kept", async () => {
      const { store } = await fresh();
      const e = await own(store);
      const e2 = await own(store, T, "b-two");
      for (const seq of [1000, 3000, 2000]) await store.putCheckpoint(T, B, { seq }, e);
      expect((await store.getCheckpoint(T, B)).seq).toBe(3000);
      expect((await store.getCheckpoint(T, B, 3000)).seq).toBe(2000);
      expect((await store.getCheckpoint(T, B, 2000)).seq).toBe(1000);
      expect(await store.getCheckpoint(T, B, 1000)).toBe(null);
      expect(await code(store.getCheckpoint(T, B, -1))).toBe("bad-entry");
      await store.putCheckpoint(T, B, { seq: 4000 }, e);                               // the fourth: the oldest goes
      expect((await store.getCheckpoint(T, B, 3000)).seq).toBe(2000);
      expect(await store.getCheckpoint(T, B, 2000)).toBe(null);
      await store.putCheckpoint(T, B, { seq: 500 }, e);                                // older than everything kept: not kept
      expect(await store.getCheckpoint(T, B, 2000)).toBe(null);
      await store.putCheckpoint(T, "b-two", { seq: 7 }, e2);                            // another board is untouched by pruning
      expect((await store.getCheckpoint(T, "b-two")).seq).toBe(7);
      expect((await store.getCheckpoint(T, B)).seq).toBe(4000);
    });

    test("data survives close and reopen; a closed store throws closed", async () => {
      const { store, another } = await fresh();
      const e = await own(store);
      await store.append(T, B, [entry(1), entry(2), entry(3)], 0, e);
      await store.putCheckpoint(T, B, { seq: 2, note: "cp" }, e);
      await store.close();
      await store.close();                                                          // closing twice is fine
      expect(await code(store.lastSeq(T, B))).toBe("closed");
      expect(await code(store.append(T, B, [entry(4)], 3, e))).toBe("closed");
      const again = await another();
      expect(await again.read(T, B, 1, 10)).toEqual([entry(1), entry(2), entry(3)]);
      expect(await again.getCheckpoint(T, B)).toEqual({ seq: 2, note: "cp" });
      await again.append(T, B, [entry(4)], 3, e);                                      // carries on where it stopped
      expect(await code(again.append(T, B, [entry(1)], 0, e))).toBe("conflict");
    });

    test("two handles (two hosts): one append wins, the other gets conflict; never a gap or a duplicate", async () => {
      const { store: a, another } = await fresh();
      const e = await own(a);
      const b = await another();
      await a.append(T, B, [entry(1)], 0, e);
      for (let round = 0; round < 20; round++) {
        const at = await a.lastSeq(T, B);
        const results = await Promise.all([
          code(a.append(T, B, [entry(at + 1, { by: "a" })], at, e)),
          code(b.append(T, B, [entry(at + 1, { by: "b" }), entry(at + 2, { by: "b" })], at, e)),
        ]);
        expect(results.sort()).toEqual(["conflict", "resolved"]);
        const last = await b.lastSeq(T, B);
        const log = await a.read(T, B, 1, 1000);
        expect(log.map(e => e.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
        // The winner's batch is whole: one writer's entries, never a mix.
        expect(new Set(log.filter(e => e.seq > at).map(e => e.by)).size).toBe(1);
        expect(await code(a.append(T, B, [entry(at + 1)], at, e))).toBe("conflict");    // the fenced host stays fenced
      }
    });

    test("epoch: 0 before any room, +1 per openEpoch, durable, per board, and concurrent opens never share one", async () => {
      const { store, another } = await fresh();
      expect(await store.epoch(T, B)).toBe(0);
      expect(await store.openEpoch(T, B)).toBe(1);
      expect(await store.openEpoch(T, B)).toBe(2);
      expect(await store.epoch(T, B)).toBe(2);
      expect(await store.epoch(T, "b-two")).toBe(0);           // per board
      expect(await store.openEpoch(T, "b-two")).toBe(1);
      expect(await store.epoch("t-bbb", B)).toBe(0);           // per tenant
      // A second handle (a reopen, or another host) sees it, and its opens interleave without repeats.
      const b = await another();
      expect(await b.epoch(T, B)).toBe(2);
      const got = await Promise.all([store.openEpoch(T, B), b.openEpoch(T, B), store.openEpoch(T, B), b.openEpoch(T, B)]);
      expect(got.sort((x, y) => x - y)).toEqual([3, 4, 5, 6]);
      expect(await store.epoch(T, B)).toBe(6);
      // Ids are checked like every other call.
      expect(await code(store.openEpoch("../x", B))).toBe("bad-id");
      expect(await code(store.epoch(T, "B.*"))).toBe("bad-id");
    });

    // ---- Lease and epoch fence (PROTOCOL.md § Recovery, Room identity; phase 4) ----

    test("lease: acquire is exclusive; another holder gets it only after expiry, and every acquire bumps the epoch", async () => {
      const { store, expire } = await fresh();
      expect(await store.lease(T, B)).toBe(null);
      const a1 = await store.acquire(T, B, "h-a", LONG);
      expect(a1.epoch).toBe(1);
      expect(Number.isSafeInteger(a1.expiresAt)).toBe(true);
      expect(await store.acquire(T, B, "h-b", LONG)).toBe(null);                    // held: refused
      expect(await store.epoch(T, B)).toBe(1);                                       // a refusal bumps nothing
      expect(await store.lease(T, B)).toMatchObject({ holder: "h-a", epoch: 1, live: true });
      // The same holder again = a new room incarnation (a rebuild): a new epoch, so its old room is fenced off.
      expect((await store.acquire(T, B, "h-a", SHORT)).epoch).toBe(2);
      await expire();
      expect(await store.lease(T, B)).toMatchObject({ holder: "h-a", epoch: 2, live: false });
      expect((await store.acquire(T, B, "h-b", LONG)).epoch).toBe(3);                // takeover after expiry
      expect(await store.acquire(T, B, "h-a", LONG)).toBe(null);
      expect(await store.lease(T, B)).toMatchObject({ holder: "h-b", epoch: 3, live: true });
      expect(await store.epoch(T, B)).toBe(3);
      expect(await store.lease(T, "b-two")).toBe(null);                             // per board
      expect((await store.acquire(T, "b-two", "h-a", LONG)).epoch).toBe(1);
    });

    test("lease: remainingMs is the time left on the Store's own clock (0 unless live), so nobody compares clocks", async () => {
      const { store, expire } = await fresh();
      const a = await store.acquire(T, B, "h-a", SHORT);
      const l = await store.lease(T, B);
      expect(l.live).toBe(true);
      expect(l.remainingMs).toBeGreaterThan(0);
      expect(l.remainingMs).toBeLessThanOrEqual(SHORT);
      expect(l.expiresAt - l.remainingMs).toBeGreaterThanOrEqual(a.expiresAt - SHORT);   // "now" on the Store's clock, after the acquire
      await expire();
      expect(await store.lease(T, B)).toMatchObject({ live: false, remainingMs: 0 });
      const b = await store.acquire(T, B, "h-b", LONG);
      expect((await store.lease(T, B)).remainingMs).toBeGreaterThan(LONG - 5_000);
      await store.release(T, B, "h-b", b.epoch);
      expect(await store.lease(T, B)).toMatchObject({ holder: null, live: false, remainingMs: 0 });
    });

    test("lease: two holders on two handles race for a free lease; exactly one wins each round", async () => {
      const { store: a, another } = await fresh();
      const b = await another();
      for (let round = 1; round <= 10; round++) {
        const got = await Promise.all([a.acquire(T, B, "h-a", LONG), b.acquire(T, B, "h-b", LONG)]);
        const won = got.filter(Boolean);
        expect(won.length).toBe(1);
        expect(won[0].epoch).toBe(round);
        const holder = got[0] ? "h-a" : "h-b";
        expect((await b.lease(T, B)).holder).toBe(holder);
        await (got[0] ? a : b).release(T, B, holder, round);                         // free for the next round
      }
    });

    test("lease: renew only as the holder at its epoch; it keeps the lease past the first ttl", async () => {
      const { store, expire } = await fresh();
      const a = await store.acquire(T, B, "h-a", SHORT);
      const r = await store.renew(T, B, "h-a", a.epoch, LONG);
      expect(r.epoch).toBe(a.epoch);
      expect(r.expiresAt).toBeGreaterThan(a.expiresAt);
      await expire();                                                                 // the first ttl is over
      expect(await store.acquire(T, B, "h-b", LONG)).toBe(null);                    // still held, renewed
      expect(await store.renew(T, B, "h-b", a.epoch, LONG)).toBe(null);             // not the holder
      expect(await store.renew(T, B, "h-a", a.epoch + 1, LONG)).toBe(null);         // not its epoch
      // Lapsed, nobody took it: the holder may still renew (no one else has an epoch to be fenced by).
      await store.renew(T, B, "h-a", a.epoch, SHORT);
      await expire();
      expect((await store.renew(T, B, "h-a", a.epoch, LONG))?.epoch).toBe(a.epoch);
      // Taken over: the old holder's renew fails, and so does a renew at the old epoch by the new holder.
      await store.renew(T, B, "h-a", a.epoch, SHORT);
      await expire();
      const b = await store.acquire(T, B, "h-b", LONG);
      expect(b.epoch).toBe(a.epoch + 1);
      expect(await store.renew(T, B, "h-a", a.epoch, LONG)).toBe(null);
      expect(await store.renew(T, B, "h-b", a.epoch, LONG)).toBe(null);
      expect(await store.lease(T, B)).toMatchObject({ holder: "h-b", epoch: b.epoch, live: true });
    });

    test("lease: release frees it at once (idempotent, holder and epoch checked) and keeps the epoch", async () => {
      const { store } = await fresh();
      const a = await store.acquire(T, B, "h-a", LONG);
      await store.release(T, B, "h-b", a.epoch);                                    // not the holder: nothing
      await store.release(T, B, "h-a", a.epoch + 1);                                // not its epoch: nothing
      expect(await store.lease(T, B)).toMatchObject({ holder: "h-a", live: true });
      await store.release(T, B, "h-a", a.epoch);
      await store.release(T, B, "h-a", a.epoch);                                    // twice is fine
      expect(await store.lease(T, B)).toMatchObject({ holder: null, epoch: a.epoch, live: false });
      expect(await store.epoch(T, B)).toBe(a.epoch);
      expect((await store.acquire(T, B, "h-b", LONG)).epoch).toBe(a.epoch + 1);     // no wait for the ttl
      await store.release(T, B, "h-a", a.epoch);                                    // a stale release can't free b's lease
      expect((await store.lease(T, B)).holder).toBe("h-b");
    });

    test("fence: after a takeover the stale holder's append and checkpoint are refused as fenced and write nothing", async () => {
      const { store: a, another, expire } = await fresh();
      const b = await another();
      const la = await a.acquire(T, B, "h-a", SHORT);
      await a.append(T, B, [entry(1)], 0, la.epoch);
      await a.putCheckpoint(T, B, { seq: 1, by: "a" }, la.epoch);
      await expire();
      const lb = await b.acquire(T, B, "h-b", LONG);
      expect(lb.epoch).toBe(la.epoch + 1);
      expect(await code(a.append(T, B, [entry(2, { by: "a" })], 1, la.epoch))).toBe("fenced");
      expect(await code(a.putCheckpoint(T, B, { seq: 1000, by: "a" }, la.epoch))).toBe("fenced");
      // Stale on both counts: "fenced" (stop) wins over "conflict" (rebuild).
      expect(await code(a.append(T, B, [entry(1)], 0, la.epoch))).toBe("fenced");
      expect(await a.lastSeq(T, B)).toBe(1);
      expect((await a.getCheckpoint(T, B)).seq).toBe(1);
      await b.append(T, B, [entry(2, { by: "b" })], 1, lb.epoch);                   // the new holder writes
      await b.putCheckpoint(T, B, { seq: 2, by: "b" }, lb.epoch);
      expect((await a.read(T, B, 1, 10)).map(e => e.by)).toEqual(["u1", "b"]);
      expect((await a.getCheckpoint(T, B)).by).toBe("b");
      // A future epoch, or any epoch on a board nobody ever leased, is fenced too.
      expect(await code(b.append(T, B, [entry(3)], 2, lb.epoch + 1))).toBe("fenced");
      expect(await code(b.append(T, "b-two", [entry(1, { board: "b-two" })], 0, 1))).toBe("fenced");
      // Every write is fenced (p4-host, L5): no epoch is refused as bad-entry and writes nothing, on a held board
      // and on one nobody ever leased.
      expect(await code(a.append(T, B, [entry(3)], 2))).toBe("bad-entry");
      expect(await code(a.putCheckpoint(T, B, { seq: 3 }))).toBe("bad-entry");
      expect(await code(a.append(T, "b-three", [entry(1, { board: "b-three" })], 0))).toBe("bad-entry");
      expect(await code(a.putCheckpoint(T, "b-three", { seq: 1 }))).toBe("bad-entry");
      expect(await a.lastSeq(T, B)).toBe(2);
      expect((await a.getCheckpoint(T, B)).seq).toBe(2);
      expect(await a.lastSeq(T, "b-three")).toBe(0);
      expect(await a.getCheckpoint(T, "b-three")).toBe(null);
      for (const bad of [undefined, 0, -1, 1.5, "2", null]) {
        expect(await code(b.append(T, B, [entry(4)], 3, bad))).toBe("bad-entry");
        expect(await code(b.putCheckpoint(T, B, { seq: 4 }, bad))).toBe("bad-entry");
      }
    });

    test("fence: a released lease still fences its old epoch out once someone takes the board", async () => {
      const { store } = await fresh();
      const a = await store.acquire(T, B, "h-a", LONG);
      await store.release(T, B, "h-a", a.epoch);
      await store.append(T, B, [entry(1)], 0, a.epoch);                             // released, nobody else: still its epoch
      const b = await store.acquire(T, B, "h-b", LONG);
      expect(await code(store.append(T, B, [entry(2)], 1, a.epoch))).toBe("fenced");
      await store.append(T, B, [entry(2)], 1, b.epoch);
    });

    test("openEpoch and the lease share one record: openEpoch takes the board without a lease and fences the holder", async () => {
      const { store } = await fresh();
      const a = await store.acquire(T, B, "h-a", LONG);
      expect(await store.openEpoch(T, B)).toBe(a.epoch + 1);
      expect(await store.lease(T, B)).toMatchObject({ holder: null, epoch: a.epoch + 1, live: false });
      expect(await store.renew(T, B, "h-a", a.epoch, LONG)).toBe(null);
      expect(await code(store.append(T, B, [entry(1)], 0, a.epoch))).toBe("fenced");
      await store.append(T, B, [entry(1)], 0, a.epoch + 1);                         // the openEpoch room's epoch
      expect((await store.acquire(T, B, "h-b", LONG)).epoch).toBe(a.epoch + 2);     // unheld: no wait
    });

    test("lease calls check ids, holder, epoch and ttl", async () => {
      const { store } = await fresh();
      for (const bad of ["", "a.b", "*", "../x", "A", 7, null]) {
        expect(await code(store.acquire(bad, B, "h-a", LONG))).toBe("bad-id");
        expect(await code(store.acquire(T, B, bad, LONG))).toBe("bad-id");
        expect(await code(store.renew(T, bad, "h-a", 1, LONG))).toBe("bad-id");
        expect(await code(store.release(T, B, bad, 1))).toBe("bad-id");
        expect(await code(store.lease(bad, B))).toBe("bad-id");
      }
      for (const ttl of [0, -1, 1.5, "100", 10 * 60_000 + 1]) expect(await code(store.acquire(T, B, "h-a", ttl))).toBe("bad-entry");
      expect(await code(store.renew(T, B, "h-a", undefined, LONG))).toBe("bad-entry");
      expect(await code(store.renew(T, B, "h-a", 0, LONG))).toBe("bad-entry");
      expect(await code(store.release(T, B, "h-a", undefined))).toBe("bad-entry");
      expect(await store.lease(T, B)).toBe(null);                                   // nothing was written
    });
  });
}
