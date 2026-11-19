// The Store contract (PROTOCOL.md § Store), as reusable bun tests. Every Store adapter runs the same suite:
//
//   import { storeContract } from "./store-contract.js";
//   storeContract("postgres", async () => { ...; return { store, another, cleanup } });
//
// `make()` is an async factory for a FRESH, empty store. It returns:
//   store            the store under test
//   another()        opens a second handle on the SAME data (a reopen after close, or a second host)
//   cleanup()        optional; runs after the test (drop the schema, remove the file)
//   raw              { putCheckpointRow(t, b, seq, data), putPartRow(t, b, seq, wid, n, data), partRows(t, b) }: the adapter's tables
//                    written and counted directly (old-format rows, the orphans a crash leaves)
//                    (blob references, #92) also putRefRow(t, b, sha1) (a reference written past append's cancel step: the race a purge loses to a
//                    new reference), refRows(t, b), pendingRows(t, b): counts. Contract cases that use them skip without `raw`.
//   advance(ms)      optional; moves the store's lease clock forward (an adapter with an injected clock, shared by
//                    `another()`). Without it, the lease cases wait out a short real ttl on the database's clock.
// `make(opts)` gets `{ partChars, onPart }` and must pass them to the adapter (checkpoint parts: the size of one part, and a
// hook awaited before each part "part:<n>" and before the header "header"; a throw aborts the write there).
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
 * @param {(opts?: { partChars?: number, onPart?: (step: string) => any }) => Promise<{ store: any, another: () => Promise<any>, cleanup?: () => Promise<void>|void, raw?: any }>} make
 */
export function storeContract(name, make) {
  describe(`Store contract: ${name}`, () => {
    const handles = [];
    let cleanups = [];
    const fresh = async opts => {
      const h = await make(opts);
      handles.push(h.store);
      if (h.cleanup) cleanups.push(h.cleanup);
      const another = async () => { const s = await h.another(); handles.push(s); return s; };
      // Let a lease taken with SHORT lapse: on the injected clock, or by waiting on the database's.
      const expire = async () => { if (h.advance) h.advance(SHORT + 1); else await Bun.sleep(SHORT + 150); };
      return { store: h.store, another, expire, raw: h.raw };
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

    // ---- Checkpoint parts (PROTOCOL.md § Recovery, "Checkpoint parts"): a big checkpoint is several fenced rows made visible by a header.
    const PART = 4000;
    /** A checkpoint of about `n` parts of text; `tag` tells two apart. Emoji straddle the part edges on purpose. */
    const big = (seq, tag, n = 5) => ({ seq, tag, streams: { board: { elements: Array.from({ length: n * 25 }, (_, i) => ({ id: `e${i}`, text: "é😀\"\\".repeat(18) + tag })) } } });
    const parts = cp => Math.ceil(JSON.stringify(cp).length / PART);

    test("parts: a multi-part checkpoint reads back exactly (surrogates, quotes), one row per part, and small ones stay single-row", async () => {
      const { store, raw } = await fresh({ partChars: PART });
      const e = await own(store);
      const cp = big(40, "x");
      expect(JSON.stringify(cp).length).toBeGreaterThan(PART * 4);
      await store.putCheckpoint(T, B, cp, e);
      expect(await store.getCheckpoint(T, B)).toEqual(JSON.parse(JSON.stringify(cp)));
      const n = await raw.partRows(T, B);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(parts(cp) + 1);
      await store.putCheckpoint(T, B, { seq: 50, small: true }, e);                       // fits one part: no part rows
      expect(await raw.partRows(T, B)).toBe(n);
      expect(await store.getCheckpoint(T, B)).toEqual({ seq: 50, small: true });
      expect((await store.getCheckpoint(T, B, 50)).tag).toBe("x");
    });

    test("parts: the checkpoint is invisible until the header lands; an abort between parts leaves the previous one and no orphan", async () => {
      const seen = [];
      let abortAt = null, store;
      const { store: s, raw } = await fresh({ partChars: PART, onPart: async step => {
        if (abortAt === null || step === "sweep") return;
        seen.push([step, (await store.getCheckpoint(T, B))?.seq]);
        if (step === abortAt) throw new Error("simulated crash");
      } });
      store = s;
      const e = await own(store);
      await store.putCheckpoint(T, B, big(10, "old"), e);
      const before = await raw.partRows(T, B);
      abortAt = "part:3";
      await expect(store.putCheckpoint(T, B, big(20, "new"), e)).rejects.toThrow("simulated crash");
      expect(seen.map(x => x[0])).toEqual(["part:0", "part:1", "part:2", "part:3"]);
      expect(seen.every(x => x[1] === 10)).toBe(true);                                    // the old one the whole time
      expect((await store.getCheckpoint(T, B)).tag).toBe("old");
      expect(await raw.partRows(T, B)).toBe(before);                                      // the aborted write cleaned up after itself
      abortAt = "header"; seen.length = 0;                                                // every part written, header not
      await expect(store.putCheckpoint(T, B, big(20, "new"), e)).rejects.toThrow("simulated crash");
      expect(seen.at(-1)).toEqual(["header", 10]);
      expect((await store.getCheckpoint(T, B)).tag).toBe("old");
      expect(await raw.partRows(T, B)).toBe(before);
      abortAt = null;
      await store.putCheckpoint(T, B, big(20, "new"), e);                                 // and a retry works
      expect((await store.getCheckpoint(T, B)).tag).toBe("new");
    });

    test("parts: the fence is checked on every part and on the header; a takeover mid-write is fenced, nothing becomes visible, nothing is left", async () => {
      for (const at of ["part:0", "part:2", "header"]) {
        let takeover = null;
        const steps = [];
        const { store, raw } = await fresh({ partChars: PART, onPart: async step => { if (step === "sweep") return; if (takeover) steps.push(step); if (step === at && takeover) await takeover(); } });
        const e = await own(store);
        await store.putCheckpoint(T, B, big(10, "old"), e);
        const before = await raw.partRows(T, B);
        takeover = () => store.openEpoch(T, B);
        expect(await code(store.putCheckpoint(T, B, big(20, "new"), e))).toBe("fenced");
        expect(steps.at(-1)).toBe(at);                                                      // it stopped at the part the takeover hit: no later part was tried
        expect((await store.getCheckpoint(T, B)).tag).toBe("old");
        expect(await raw.partRows(T, B)).toBe(before);
        // The new holder writes the same seq: it is not blocked by the fenced one's leftovers.
        const e2 = await own(store);
        takeover = null;
        await store.putCheckpoint(T, B, big(20, "new2"), e2);
        expect((await store.getCheckpoint(T, B)).tag).toBe("new2");
      }
    });

    test("parts: orphans (a crash's parts, a pruned checkpoint's) are swept by the next checkpoint; the newest 3 keep their parts", async () => {
      const { store, raw } = await fresh({ partChars: PART });
      const e = await own(store);
      for (const seq of [10, 20, 30]) await store.putCheckpoint(T, B, big(seq, `c${seq}`), e);
      const three = await raw.partRows(T, B);
      // What a crash between parts leaves: parts of a write that never got its header, below the newest seq.
      await raw.putPartRow(T, B, 25, "crashed-wid", 0, "x".repeat(100)); await raw.putPartRow(T, B, 25, "crashed-wid", 1, "y");
      await raw.putPartRow(T, B, 5, "other-wid", 0, "z");
      expect(await raw.partRows(T, B)).toBe(three + 3);
      expect((await store.getCheckpoint(T, B)).seq).toBe(30);                              // never readable
      await store.putCheckpoint(T, B, big(40, "c40"), e);                                  // the 4th: seq 10 is pruned, its parts go too
      expect(await store.getCheckpoint(T, B, 20)).toBe(null);
      expect(await raw.partRows(T, B)).toBe(three);                                        // three checkpoints' worth, no more
      expect((await store.getCheckpoint(T, B)).tag).toBe("c40");
      expect((await store.getCheckpoint(T, B, 40)).tag).toBe("c30");
      expect((await store.getCheckpoint(T, B, 30)).tag).toBe("c20");
    });

    test("parts: a stale write's header landing while a sweep is yielding keeps its parts; the checkpoint under the newest reads complete", async () => {
      let gateA = null, holdA = false, swept = false, slowDone = null;
      const { store, raw } = await fresh({ partChars: PART, onPart: async step => {
        if (holdA && step === "header") { holdA = false; await gateA.promise; return; }
        if (step === "sweep" && slowDone && !swept) { swept = true; gateA.resolve(); await slowDone; }   // seq 25's header commits between the sweep's steps
      } });
      const e = await own(store);
      await raw.putPartRow(T, B, 5, "crashed-wid", 0, "x");                              // a second orphan group, so the sweep has steps
      gateA = Promise.withResolvers(); holdA = true;
      slowDone = store.putCheckpoint(T, B, big(25, "late"), e);                          // every part written, header held back
      await Bun.sleep(30);
      await store.putCheckpoint(T, B, big(30, "newest"), e);                             // lands, and sweeps seq 25's group as an orphan
      expect(swept).toBe(true);
      await slowDone;                                                                    // its header is in
      expect((await store.getCheckpoint(T, B)).tag).toBe("newest");
      expect((await store.getCheckpoint(T, B, 30)).tag).toBe("late");                    // complete, never "unavailable"
      expect(await raw.partRows(T, B)).toBeGreaterThanOrEqual(parts(big(25, "late")) + parts(big(30, "newest")));
    });

    test("parts: a header whose parts are gone is skipped as a bad checkpoint, once, reported through onSkip, and the next one below is returned", async () => {
      const skipped = [];
      const { store, raw } = await fresh({ partChars: PART, onSkip: s => skipped.push(s) });
      const e = await own(store);
      await store.putCheckpoint(T, B, big(10, "ok"), e);
      await raw.putCheckpointRow(T, B, 20, "\u0001cp-parts 1 no-such-wid 3 9999");        // names parts that don't exist
      const got = await store.getCheckpoint(T, B);
      expect(got.tag).toBe("ok");
      expect(skipped).toEqual([{ tenant: T, board: B, seq: 20 }]);
      expect((await store.getCheckpoint(T, B, 20)).tag).toBe("ok");                       // a read that starts below it never sees it
      expect(skipped.length).toBe(1);
    });

    test("parts: a checkpoint stored as one plain row of JSON (no header) reads, alone and beside parts", async () => {
      const { store, raw } = await fresh({ partChars: PART });
      const e = await own(store);
      const plain = big(10, "plain");
      await raw.putCheckpointRow(T, B, 10, JSON.stringify(plain));
      expect(await store.getCheckpoint(T, B)).toEqual(JSON.parse(JSON.stringify(plain)));
      await store.putCheckpoint(T, B, big(20, "parts"), e);
      expect((await store.getCheckpoint(T, B)).tag).toBe("parts");
      expect((await store.getCheckpoint(T, B, 20)).tag).toBe("plain");
      for (const seq of [30, 40]) await store.putCheckpoint(T, B, big(seq, `p${seq}`), e);   // the plain row is pruned like any other
      expect(await store.getCheckpoint(T, B, 20)).toBe(null);
    });

    test("parts: a late write never hides a newer checkpoint; one overtaken mid-write may be refused as unavailable, and leaves nothing", async () => {
      let gate = null, hold = false;
      const { store, raw } = await fresh({ partChars: PART, onPart: async step => { if (hold && step === "part:1") { hold = false; await gate.promise; } } });
      const e = await own(store);
      // A slow write of seq 10 is still between its parts while seq 20 lands (and sweeps the parts nobody names).
      gate = Promise.withResolvers(); hold = true;
      const slow = code(store.putCheckpoint(T, B, big(10, "slow"), e));
      await Bun.sleep(30);
      await store.putCheckpoint(T, B, big(20, "fast"), e);
      const fastRows = await raw.partRows(T, B);
      gate.resolve();
      expect(await slow).toBe("unavailable");                                             // its first part was swept: the header's part count refuses it
      expect((await store.getCheckpoint(T, B)).tag).toBe("fast");
      for (const below of [21, 20, 11]) { const got = await store.getCheckpoint(T, B, below); expect(got === null || got.tag === (below > 20 ? "fast" : "slow")).toBe(true); }
      expect(await raw.partRows(T, B)).toBeLessThanOrEqual(fastRows + parts(big(10, "slow")) + 1);
      // The same seq twice, the first one slow: the first header wins and the loser leaves no part rows.
      gate = Promise.withResolvers(); hold = true;
      const a = code(store.putCheckpoint(T, B, big(30, "a"), e));
      await Bun.sleep(30);
      await store.putCheckpoint(T, B, big(30, "b"), e);
      gate.resolve();
      expect(["resolved", "unavailable"]).toContain(await a);
      expect((await store.getCheckpoint(T, B)).tag).toBe("b");
      expect(await raw.partRows(T, B)).toBeLessThanOrEqual(3 * (parts(big(30, "b")) + 1));
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

    test("purgeBoard (PROTOCOL.md § Trash and restore): deletes the board's log, checkpoints and lease, leaves every other board and tenant alone, is idempotent, and fences a stale host", async () => {
      const { store } = await fresh();
      const other = "b-two", T2 = "t-bbb";
      const epoch = await own(store);
      await store.append(T, B, [entry(1), entry(2)], 0, epoch);
      await store.putCheckpoint(T, B, { seq: 2, tenant: T, board: B, state: {} }, epoch);
      const e2 = await own(store, T, other);
      await store.append(T, other, [entry(1, { board: other })], 0, e2);
      const e3 = await own(store, T2, B);
      await store.append(T2, B, [entry(1, { tenant: T2 })], 0, e3);
      await store.purgeBoard(T, B);
      expect(await store.lastSeq(T, B)).toBe(0);
      expect(await store.read(T, B)).toEqual([]);
      expect(await store.getCheckpoint(T, B)).toBe(null);
      expect(await store.lease(T, B)).toBe(null);
      expect(await store.epoch(T, B)).toBe(0);
      expect(await store.lastSeq(T, other)).toBe(1);                                // the neighbour board
      expect(await store.lastSeq(T2, B)).toBe(1);                                   // the same board id in another tenant
      await store.purgeBoard(T, B);                                                 // idempotent
      await store.purgeBoard(T, "b-never-built");                                   // nothing there is not an error
      expect(await code(store.append(T, B, [entry(3)], 2, epoch))).toBe("fenced"); // the stale host writes nothing
      expect(await store.lastSeq(T, B)).toBe(0);
      expect(await code(store.purgeBoard("a.b", B))).toBe("bad-id");
    });

    test("purgeBoard removes a checkpoint stored as parts, header and parts together", async () => {
      const { store, raw } = await fresh({ partChars: 64 });
      const epoch = await own(store);
      await store.putCheckpoint(T, B, { seq: 1, tenant: T, board: B, state: { big: "x".repeat(600) } }, epoch);
      if (raw) expect(await raw.partRows(T, B)).toBeGreaterThan(0);
      await store.purgeBoard(T, B);
      expect(await store.getCheckpoint(T, B)).toBe(null);
      if (raw) expect(await raw.partRows(T, B)).toBe(0);
    });

    // ---- Blob references (PROTOCOL.md § Blobs, "References and purge", #92) ----
    describe("blob references", () => {
      const H1 = "1".repeat(40), H2 = "2".repeat(40), H3 = "3".repeat(40), B2 = "b-two", B3 = "b-three", T2 = "t-bbb";
      const GRACE = { graceMs: 0, limit: 100 };
      /** One board with its lease, and an append carrying `refs`. */
      const put = async (store, board, refs, tenant = T, seq = 1) => {
        const epoch = await own(store, tenant, board);
        await store.append(tenant, board, [entry(seq, { board, tenant })], seq - 1, epoch, { blobRefs: refs });
        return epoch;
      };
      const condemned = async (store, o = {}) => (await store.blobCondemned({ ...GRACE, ...o })).map(r => `${r.tenant}/${r.sha1}`);

      test("a purge condemns the hashes only that board used; a hash another board uses is kept, and goes with the last board", async () => {
        const { store } = await fresh();
        await put(store, B, [H1, H2]); await put(store, B2, [H2, H3]);
        await store.purgeBoard(T, B);
        expect(await condemned(store)).toEqual([`${T}/${H1}`]);                      // H2 is still B2's
        await store.purgeBoard(T, B2);
        expect(await condemned(store)).toEqual([`${T}/${H1}`, `${T}/${H2}`, `${T}/${H3}`]);
        await store.purgeBoard(T, B2);                                               // idempotent: nothing new, nothing lost
        expect((await condemned(store)).length).toBe(3);
      });

      test("references are per tenant, and nothing is condemned until a purge (a board in Trash keeps its references)", async () => {
        const { store } = await fresh();
        await put(store, B, [H1]); await put(store, B, [H1], T2);
        expect(await condemned(store)).toEqual([]);                                  // referenced, never purged
        await store.purgeBoard(T, B);
        expect(await condemned(store)).toEqual([`${T}/${H1}`]);                      // the other tenant's copy is its own
      });

      test("blobRefs are written in the entries' transaction: a refused append (conflict, fenced, bad entry, bad refs) leaves no reference", async () => {
        const { store } = await fresh();
        const e = await own(store);
        await store.append(T, B, [entry(1)], 0, e);
        expect(await code(store.append(T, B, [entry(1)], 0, e, { blobRefs: [H1] }))).toBe("conflict");
        expect(await code(store.append(T, B, [entry(2)], 1, e + 1, { blobRefs: [H1] }))).toBe("fenced");
        expect(await code(store.append(T, B, [entry(2)], 1, e, { blobRefs: [H1, "nope"] }))).toBe("bad-entry");
        expect(await code(store.append(T, B, [entry(2)], 1, e, { blobRefs: "x" }))).toBe("bad-entry");
        expect(await code(store.append(T, B, [entry(2)], 1, e, { blobRefs: ["A".repeat(40)] }))).toBe("bad-entry");
        expect(await store.lastSeq(T, B)).toBe(1);
        await put(store, B2, [H1]);                                                  // B2 is the only user of H1 if none of those left a reference
        await store.purgeBoard(T, B2);
        expect(await condemned(store)).toEqual([`${T}/${H1}`]);
      });

      test("an append with no blobRefs (or an empty list) works as before; duplicates in one list are one reference", async () => {
        const { store } = await fresh();
        const e = await own(store);
        await store.append(T, B, [entry(1)], 0, e);
        await store.append(T, B, [entry(2)], 1, e, {});
        await store.append(T, B, [entry(3)], 2, e, { blobRefs: [] });
        await store.append(T, B, [entry(4)], 3, e, { blobRefs: [H1, H1, H1] });
        await store.purgeBoard(T, B);
        expect(await condemned(store)).toEqual([`${T}/${H1}`]);
      });

      test("a new reference (append or pend) cancels a condemnation", async () => {
        const { store } = await fresh();
        await put(store, B, [H1, H2]); await store.purgeBoard(T, B);
        expect((await condemned(store)).length).toBe(2);
        await put(store, B2, [H1]);                                                  // H1 used again
        expect(await condemned(store)).toEqual([`${T}/${H2}`]);
        await store.blobPend(T, B3, H2, 60_000);                                     // H2 about to be uploaded again
        expect(await condemned(store)).toEqual([]);
      });

      test("a pending reference keeps a purge from condemning its hash; the append that follows replaces it", async () => {
        const { store, expire } = await fresh();
        await put(store, B, [H1]);
        await store.blobPend(T, B2, H1, SHORT);                                      // B2 is about to upload H1
        await store.purgeBoard(T, B);
        expect(await condemned(store)).toEqual([]);                                  // pending counts as a use
        await expire();
        await put(store, B2, [H1]);                                                  // its op lands (even after the pending lapsed)
        await store.purgeBoard(T, B2);
        expect(await condemned(store)).toEqual([`${T}/${H1}`]);
      });

      test("a purge condemns a hash that only the purged board's pending reference held; a longer pend never shortens an earlier one", async () => {
        const { store, expire } = await fresh();
        await store.blobPend(T, B, H1, LONG); await store.blobPend(T, B, H1, 1);      // the longer stays
        await store.blobPend(T, B2, H2, SHORT);
        await expire();
        await store.purgeBoard(T, B); await store.purgeBoard(T, B2);
        expect(await condemned(store)).toEqual([`${T}/${H1}`, `${T}/${H2}`]);
      });

      test("blobCondemned: only after the grace, oldest-key-first pages after a cursor, tenant by tenant, bad arguments refused", async () => {
        const { store, expire } = await fresh();
        await put(store, B, [H3, H1]); await put(store, B, [H2], T2, 1);
        await store.purgeBoard(T, B); await store.purgeBoard(T2, B);
        expect(await condemned(store, { graceMs: SHORT })).toEqual([]);              // not yet
        await expire();
        const all = await store.blobCondemned({ graceMs: SHORT, limit: 100 });
        expect(all).toEqual([{ tenant: T, sha1: H1 }, { tenant: T, sha1: H3 }, { tenant: T2, sha1: H2 }]);
        const p1 = await store.blobCondemned({ graceMs: SHORT, limit: 2 });
        expect(p1).toEqual(all.slice(0, 2));
        expect(await store.blobCondemned({ graceMs: SHORT, limit: 2, after: p1.at(-1) })).toEqual(all.slice(2));
        expect(await store.blobCondemned({ graceMs: SHORT, limit: 2, after: all.at(-1) })).toEqual([]);
        for (const bad of [{ graceMs: -1, limit: 1 }, { graceMs: 1.5, limit: 1 }, { graceMs: 0, limit: 0 }, { graceMs: 0, limit: 1001 }, { graceMs: 0 }]) expect(await code(store.blobCondemned(bad))).toBe("bad-entry");
        expect(await code(store.blobCondemned({ graceMs: 0, limit: 1, after: { tenant: "a.b", sha1: H1 } }))).toBe("bad-id");
      });

      test("blobClaim is conditional: once, not before the grace, not while claimed, again after the claim lapses; blobReaped ends it", async () => {
        const { store, expire } = await fresh();
        await put(store, B, [H1]); await store.purgeBoard(T, B);
        expect(await store.blobClaim(T, H1, { graceMs: SHORT, claimMs: SHORT })).toBe(false);   // too young
        await expire();
        expect(await store.blobClaim(T, H1, { graceMs: SHORT, claimMs: SHORT })).toBe(true);
        expect(await store.blobClaim(T, H1, { graceMs: SHORT, claimMs: SHORT })).toBe(false);   // held
        expect(await condemned(store, { graceMs: SHORT })).toEqual([]);              // a claimed hash is not offered
        await expire();
        expect(await condemned(store, { graceMs: SHORT })).toEqual([`${T}/${H1}`]);  // the claim lapsed (a node died mid-delete): back on the list
        expect(await store.blobClaim(T, H1, { graceMs: SHORT, claimMs: LONG })).toBe(true);
        expect(await store.blobReaped(T, H1)).toBe(true);                            // the verdict: nothing references it, delete the bytes ...
        expect(await store.blobReaped(T, H1)).toBe(true);                            // ... and the row stays until that is done (a failed delete is retried), so asking again says the same
        expect(await condemned(store)).toEqual([]);                                  // still claimed
        expect(await store.blobReaped(T, H1, { deleted: true })).toBe(true);         // the delete is done: the row goes
        expect(await store.blobReaped(T, H1)).toBe(false);                           // nothing left to settle
        expect(await store.blobReaped(T, H1, { deleted: true })).toBe(true);         // a missing row after a delete is clean (another node finished)
        expect(await condemned(store)).toEqual([]);
        expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: SHORT })).toBe(false);       // gone
        for (const bad of [{ graceMs: 0, claimMs: 0 }, { graceMs: -1, claimMs: 1 }, {}]) expect(await code(store.blobClaim(T, H1, bad))).toBe("bad-entry");
        expect(await code(store.blobClaim(T, "nope", { graceMs: 0, claimMs: 1 }))).toBe("bad-id");
        expect(await code(store.blobReaped("a.b", H1))).toBe("bad-id");
      });

      test("blobClaim refuses a hash that is referenced or pending again, and drops a condemnation a reference outlived", async () => {
        const { store, raw } = await fresh();
        await put(store, B, [H1, H2, H3]); await store.purgeBoard(T, B);
        if (raw) {
          await raw.putRefRow(T, B2, H1);                                            // a purge raced a new reference: both rows exist
          expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: SHORT })).toBe(false);   // STILL UNREFERENCED guard
          expect(await condemned(store)).toEqual([`${T}/${H2}`, `${T}/${H3}`]);       // and the stale condemnation is gone
        }
        await store.blobPend(T, B3, H3, LONG);                                       // pend cancels it as well
        expect(await store.blobClaim(T, H3, { graceMs: 0, claimMs: SHORT })).toBe(false);
        expect(await store.blobClaim(T, H2, { graceMs: 0, claimMs: SHORT })).toBe(true);
      });

      test("a hash a reaper holds a live claim on cannot be pended (unavailable: ask again); once the claim lapses a pend marks it revived, and the reaper that settles it puts the bytes back", async () => {
        const { store, expire } = await fresh();
        await put(store, B, [H1]); await store.purgeBoard(T, B);
        expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: SHORT })).toBe(true);
        expect(await code(store.blobPend(T, B2, H1, SHORT))).toBe("unavailable");
        await expire();
        await store.blobPend(T, B2, H1, LONG);                                       // the claim lapsed (its node died, the bytes may be quarantined): the row stays, revived
        expect(await condemned(store, { graceMs: SHORT })).toEqual([`${T}/${H1}`]);  // and is offered again, so a reaper settles it
        expect(await store.blobClaim(T, H1, { graceMs: SHORT, claimMs: LONG })).toBe(true);   // claimable although an upload is pending: it was claimed before
        expect(await store.blobReaped(T, H1)).toBe(false);                           // keep: put the bytes back
        expect(await condemned(store)).toEqual([]);
      });

      test("REVIVE: claim, then another board's append names the hash, then a pend: the pend is unavailable until the reaper settles, and the settle says keep", async () => {
        const { store } = await fresh();
        await put(store, B, [H1]); await store.purgeBoard(T, B);
        expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: LONG })).toBe(true);
        await put(store, B2, [H1]);                                                  // an op names the picture now: the row is NOT deleted
        expect(await code(store.blobPend(T, B3, H1, SHORT))).toBe("unavailable");    // a deleted row would let this through (and the PUT then find the old bytes)
        expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: LONG })).toBe(false);   // still held
        expect(await store.blobReaped(T, H1)).toBe(false);                           // revived: put the bytes back (and the row is dropped)
        await store.blobPend(T, B3, H1, SHORT);                                      // settled: asks go through again
        expect(await store.blobReaped(T, H1)).toBe(false);                           // nothing left to settle
      });

      test("the settle (blobReaped) says delete only when nothing references the hash: no revive mark, no reference, no live pending upload", async () => {
        const { store, raw } = await fresh();
        await put(store, B, [H1, H2, H3]); await store.purgeBoard(T, B);
        for (const h of [H1, H2, H3]) expect(await store.blobClaim(T, h, { graceMs: 0, claimMs: LONG })).toBe(true);
        if (raw) await raw.putRefRow(T, B2, H2);                                     // a reference that got in without the revive mark
        expect(await store.blobReaped(T, H1)).toBe(true);
        expect(await store.blobReaped(T, H2)).toBe(false);                           // the settle looks again
        expect(await store.blobReaped(T, H3)).toBe(true);
        expect(await store.blobReaped(T, H1, { deleted: true })).toBe(true);
        expect(await store.blobReaped(T, H1)).toBe(false);                           // settled: not ours any more
        expect(await store.blobReaped(T, H2, { deleted: true })).toBe(true);         // the row was dropped with the verdict
      });

      test("a reference that lands during a delete keeps the condemnation row under its claim (revived), never ends it", async () => {
        const { store } = await fresh();
        await put(store, B, [H1]); await store.purgeBoard(T, B);
        expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: LONG })).toBe(true);
        await put(store, B2, [H1]);
        expect(await store.blobReaped(T, H1)).toBe(false);
      });

      test("a reference that lands between the verdict and the end of the delete is reported: blobReaped({ deleted: true }) answers false (the client's re-upload heals it)", async () => {
        const { store } = await fresh();
        await put(store, B, [H1]); await store.purgeBoard(T, B);
        expect(await store.blobClaim(T, H1, { graceMs: 0, claimMs: LONG })).toBe(true);
        expect(await store.blobReaped(T, H1)).toBe(true);
        await put(store, B2, [H1]);
        expect(await store.blobReaped(T, H1, { deleted: true })).toBe(false);
        expect(await condemned(store)).toEqual([]);
      });

      test("an append is never refused over the NUMBER of its references: tens of thousands are written (in chunks) and a purge condemns each", async () => {
        const { store } = await fresh();
        const refs = Array.from({ length: 25_000 }, (_, i) => i.toString(16).padStart(40, "0"));
        await put(store, B, refs);
        await store.purgeBoard(T, B);
        let n = 0, after = null;
        for (;;) { const page = await store.blobCondemned({ graceMs: 0, after, limit: 1000 }); n += page.length; if (page.length < 1000) break; after = page.at(-1); }
        expect(n).toBe(25_000);
      }, 60_000);

      test("blobPrune deletes only expired pending references, at most `limit`, and a pending row of a purged board goes with it", async () => {
        const { store, expire, raw } = await fresh();
        await store.blobPend(T, B, H1, SHORT); await store.blobPend(T, B, H2, SHORT); await store.blobPend(T, B, H3, LONG);
        expect(await store.blobPrune(10)).toBe(0);                                    // none expired
        await expire();
        expect(await store.blobPrune(1)).toBe(1);
        expect(await store.blobPrune(10)).toBe(1);
        expect(await store.blobPrune(10)).toBe(0);
        if (raw) expect(await raw.pendingRows(T, B)).toBe(1);                         // H3's
        await store.purgeBoard(T, B);
        if (raw) expect(await raw.pendingRows(T, B)).toBe(0);
        for (const bad of [0, -1, 1.5, "x", undefined]) expect(await code(store.blobPrune(bad))).toBe("bad-entry");
      });

      test("blobPend's arguments are checked, and a closed store refuses every blob call", async () => {
        const { store } = await fresh();
        expect(await code(store.blobPend(T, B, "nope", 1000))).toBe("bad-id");
        expect(await code(store.blobPend("a.b", B, H1, 1000))).toBe("bad-id");
        for (const ttl of [0, -5, 1.5, 24 * 3_600_000 + 1, "5", undefined]) expect(await code(store.blobPend(T, B, H1, ttl))).toBe("bad-entry");
        await store.close();
        for (const f of [() => store.blobPend(T, B, H1, 1000), () => store.blobCondemned(GRACE), () => store.blobClaim(T, H1, { graceMs: 0, claimMs: 1 }), () => store.blobReaped(T, H1), () => store.blobPrune(1)])
          expect(await code(f())).toBe("closed");
      });

      test("purge, pend and a new reference racing on one hash never leave a condemned hash that is referenced AND claimable", async () => {
        const { store, raw } = await fresh();
        for (let i = 0; i < 8; i++) {
          const h = String(i).repeat(40);
          await put(store, `b-p${i}`, [h]);
          await Promise.all([store.purgeBoard(T, `b-p${i}`), put(store, `b-q${i}`, [h]), store.blobPend(T, `b-r${i}`, h, LONG).catch(() => {})]);
          // the new reference or pend won or lost the race; either way the reaper's claim must refuse a hash that is in use
          expect(await store.blobClaim(T, h, { graceMs: 0, claimMs: SHORT })).toBe(false);
        }
        expect(raw ? await raw.refRows(T, "b-q0") : 1).toBe(1);
      });
    });
  });
}
