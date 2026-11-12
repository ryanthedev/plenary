// The Store contract (PROTOCOL.md § Store), as reusable bun tests. Every Store adapter runs the same suite:
//
//   import { storeContract } from "./store-contract.js";
//   storeContract("postgres", async () => { ...; return { store, another, cleanup } });
//
// `make()` is an async factory for a FRESH, empty store. It returns:
//   store            the store under test
//   another()        opens a second handle on the SAME data (a reopen after close, or a second host)
//   cleanup()        optional; runs after the test (drop the schema, remove the file)
// The adapter is expected to keep the newest 3 checkpoints per board (the adapters' default `keepCheckpoints`).
// Refusals are matched by `err.code` (PortError codes: conflict, bad-entry, bad-id, closed).
// Adapter-specific checks (pragmas, settings) stay in the adapter's own test file.

import { describe, test, expect, afterEach } from "bun:test";

const T = "t-aaa", B = "b-one";
export const entry = (seq, o = {}) => ({ seq, board: B, tenant: T, stream: "board", op: { appState: { grid: seq } }, by: "u1", id: `c:${seq}`, ...o });
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
      return { store: h.store, another };
    };
    afterEach(async () => {
      for (const s of handles.splice(0)) await s.close();
      for (const c of cleanups.splice(0)) await c();
    });

    test("append is conditional on expectSeq; a stale one throws conflict and writes nothing", async () => {
      const { store } = await fresh();
      expect(await store.lastSeq(T, B)).toBe(0);
      await store.append(T, B, [entry(1), entry(2)], 0);
      expect(await store.lastSeq(T, B)).toBe(2);
      expect(await code(store.append(T, B, [entry(1)], 0))).toBe("conflict");      // behind
      expect(await code(store.append(T, B, [entry(2)], 1))).toBe("conflict");      // that seq is taken
      expect(await code(store.append(T, B, [entry(4)], 3))).toBe("conflict");      // ahead: would leave a gap
      await store.append(T, B, [entry(3)], 2);
      expect((await store.read(T, B, 1, 100)).map(e => e.seq)).toEqual([1, 2, 3]);
    });

    test("append is atomic: one bad entry in a batch writes none of it", async () => {
      const { store } = await fresh();
      await store.append(T, B, [entry(1)], 0);
      const circular = entry(3); circular.op.self = circular;
      for (const batch of [
        [entry(2), entry(4)],                               // not contiguous
        [entry(2), entry(3, { board: "b-two" })],           // another board's entry
        [entry(2), entry(3, { tenant: "t-bbb" })],          // another tenant's entry
        [entry(2), circular],                               // can't be serialised
        [entry(2), null],
      ]) expect(await code(store.append(T, B, batch, 1))).toBe("bad-entry");
      expect(await code(store.append(T, B, [], 1))).toBe("bad-entry");
      expect(await code(store.append(T, B, [entry(2)], -1))).toBe("bad-entry");
      expect(await code(store.append(T, B, [entry(2)], 1.5))).toBe("bad-entry");
      expect(await store.lastSeq(T, B)).toBe(1);
      expect(await store.read(T, B, 1, 100)).toEqual([entry(1)]);
    });

    test("read is ascending from fromSeq (inclusive), limited, and returns what was appended", async () => {
      const { store } = await fresh();
      const all = Array.from({ length: 25 }, (_, i) => entry(i + 1));
      await store.append(T, B, all.slice(0, 10), 0);
      await store.append(T, B, all.slice(10), 10);
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
      const odd = [
        entry(1, { op: { text: `"quoted" \\back\\slash {braces} [a,b] 'single' \t tab \n newline` } }),
        entry(2, { op: { text: "héllo wörld — 日本語 🎉👩‍👩‍👧", n: 2 ** 53 - 1, f: -0.125, z: null, b: false, arr: [[], {}, ""] } }),
        entry(3, { op: { text: "\u0000 NUL inside a string,   line sep" } }),
      ];
      await store.append(T, B, odd, 0);
      expect(await store.read(T, B, 1, 10)).toEqual(odd);
    });

    test("read with maxBytes: stops near the budget, always returns >= 1 entry, and reports bytes", async () => {
      const { store } = await fresh();
      const big = n => entry(n, { op: { text: "x".repeat(1000) } });
      await store.append(T, B, [big(1), big(2), big(3), big(4)], 0);
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
      await store.append(T, B, [entry(1)], 0);
      await store.append(T, "b-two", [entry(1, { board: "b-two" })], 0);
      await store.append("t-bbb", B, [entry(1, { tenant: "t-bbb" }), entry(2, { tenant: "t-bbb" })], 0);
      expect(await store.lastSeq(T, B)).toBe(1);
      expect(await store.lastSeq("t-bbb", B)).toBe(2);
      expect((await store.read("t-bbb", B, 1, 10)).every(e => e.tenant === "t-bbb")).toBe(true);
      expect(await store.read(T, "b-none", 1, 10)).toEqual([]);
    });

    test("ids that aren't server ids are refused at the port", async () => {
      const { store } = await fresh();
      for (const bad of ["", "a.b", "*", ">", "../x", "A", 7, null, "x".repeat(65), "a\u0000b"]) {
        expect(await code(store.append(bad, B, [entry(1, { tenant: bad })], 0))).toBe("bad-id");
        expect(await code(store.read(T, bad, 1, 10))).toBe("bad-id");
        expect(await code(store.lastSeq(bad, B))).toBe("bad-id");
        expect(await code(store.putCheckpoint(T, bad, { seq: 1 }))).toBe("bad-id");
        expect(await code(store.getCheckpoint(bad, B))).toBe("bad-id");
      }
    });

    test("checkpoints: the highest seq wins, never the last write", async () => {
      const { store } = await fresh();
      expect(await store.getCheckpoint(T, B)).toBe(null);
      await store.putCheckpoint(T, B, { seq: 10, streams: { board: "ten" } });
      await store.putCheckpoint(T, B, { seq: 30, streams: { board: "thirty" } });
      await store.putCheckpoint(T, B, { seq: 20, streams: { board: "twenty" } });   // a slow, older write lands last
      expect(await store.getCheckpoint(T, B)).toEqual({ seq: 30, streams: { board: "thirty" } });
      await store.putCheckpoint(T, B, { seq: 30, streams: { board: "again" } });    // equal seq doesn't replace
      expect((await store.getCheckpoint(T, B)).streams.board).toBe("thirty");
      expect(await store.getCheckpoint(T, "b-two")).toBe(null);
      expect(await code(store.putCheckpoint(T, B, { streams: {} }))).toBe("bad-entry");
      expect(await code(store.putCheckpoint(T, B, null))).toBe("bad-entry");
    });

    test("checkpoints: beforeSeq steps back past a bad one; only the newest 3 are kept", async () => {
      const { store } = await fresh();
      for (const seq of [1000, 3000, 2000]) await store.putCheckpoint(T, B, { seq });
      expect((await store.getCheckpoint(T, B)).seq).toBe(3000);
      expect((await store.getCheckpoint(T, B, 3000)).seq).toBe(2000);
      expect((await store.getCheckpoint(T, B, 2000)).seq).toBe(1000);
      expect(await store.getCheckpoint(T, B, 1000)).toBe(null);
      expect(await code(store.getCheckpoint(T, B, -1))).toBe("bad-entry");
      await store.putCheckpoint(T, B, { seq: 4000 });                               // the fourth: the oldest goes
      expect((await store.getCheckpoint(T, B, 3000)).seq).toBe(2000);
      expect(await store.getCheckpoint(T, B, 2000)).toBe(null);
      await store.putCheckpoint(T, B, { seq: 500 });                                // older than everything kept: not kept
      expect(await store.getCheckpoint(T, B, 2000)).toBe(null);
      await store.putCheckpoint(T, "b-two", { seq: 7 });                            // another board is untouched by pruning
      expect((await store.getCheckpoint(T, "b-two")).seq).toBe(7);
      expect((await store.getCheckpoint(T, B)).seq).toBe(4000);
    });

    test("data survives close and reopen; a closed store throws closed", async () => {
      const { store, another } = await fresh();
      await store.append(T, B, [entry(1), entry(2), entry(3)], 0);
      await store.putCheckpoint(T, B, { seq: 2, note: "cp" });
      await store.close();
      await store.close();                                                          // closing twice is fine
      expect(await code(store.lastSeq(T, B))).toBe("closed");
      expect(await code(store.append(T, B, [entry(4)], 3))).toBe("closed");
      const again = await another();
      expect(await again.read(T, B, 1, 10)).toEqual([entry(1), entry(2), entry(3)]);
      expect(await again.getCheckpoint(T, B)).toEqual({ seq: 2, note: "cp" });
      await again.append(T, B, [entry(4)], 3);                                      // carries on where it stopped
      expect(await code(again.append(T, B, [entry(1)], 0))).toBe("conflict");
    });

    test("two handles (two hosts): one append wins, the other gets conflict; never a gap or a duplicate", async () => {
      const { store: a, another } = await fresh();
      const b = await another();
      await a.append(T, B, [entry(1)], 0);
      for (let round = 0; round < 20; round++) {
        const at = await a.lastSeq(T, B);
        const results = await Promise.all([
          code(a.append(T, B, [entry(at + 1, { by: "a" })], at)),
          code(b.append(T, B, [entry(at + 1, { by: "b" }), entry(at + 2, { by: "b" })], at)),
        ]);
        expect(results.sort()).toEqual(["conflict", "resolved"]);
        const last = await b.lastSeq(T, B);
        const log = await a.read(T, B, 1, 1000);
        expect(log.map(e => e.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
        // The winner's batch is whole: one writer's entries, never a mix.
        expect(new Set(log.filter(e => e.seq > at).map(e => e.by)).size).toBe(1);
        expect(await code(a.append(T, B, [entry(at + 1)], at))).toBe("conflict");    // the fenced host stays fenced
      }
    });
  });
}
