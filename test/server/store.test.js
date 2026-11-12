// The Store contract (PROTOCOL.md § Store) against the SQLite adapter.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { sqliteStore } from "../../server/store/sqlite.js";
import { tempDir, cleanup } from "./helpers.js";

afterAll(cleanup);
const T = "t-aaa", B = "b-one";
const entry = (seq, o = {}) => ({ seq, board: B, tenant: T, stream: "board", op: { appState: { grid: seq } }, by: "u1", id: `c:${seq}`, ...o });
const fresh = () => { const path = join(tempDir(), "plenary.db"); return { path, store: sqliteStore({ path }) }; };
const code = async p => { try { await p; return "resolved"; } catch (e) { return e.code ?? `threw ${e.message}`; } };

test("opened with WAL, synchronous=FULL and fullfsync", async () => {
  const { store } = fresh();
  expect(store.pragmas()).toEqual({ journal_mode: "wal", synchronous: 2, fullfsync: 1 });
  await store.close();
});

test("append is conditional on expectSeq; a stale one throws conflict and writes nothing", async () => {
  const { store } = fresh();
  expect(await store.lastSeq(T, B)).toBe(0);
  await store.append(T, B, [entry(1), entry(2)], 0);
  expect(await store.lastSeq(T, B)).toBe(2);
  expect(await code(store.append(T, B, [entry(1)], 0))).toBe("conflict");      // behind
  expect(await code(store.append(T, B, [entry(2)], 1))).toBe("conflict");      // that seq is taken
  expect(await code(store.append(T, B, [entry(4)], 3))).toBe("conflict");      // ahead: would leave a gap
  await store.append(T, B, [entry(3)], 2);
  expect((await store.read(T, B, 1, 100)).map(e => e.seq)).toEqual([1, 2, 3]);
  await store.close();
});

test("append is atomic: one bad entry in a batch writes none of it", async () => {
  const { store } = fresh();
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
  expect(await store.lastSeq(T, B)).toBe(1);
  expect(await store.read(T, B, 1, 100)).toEqual([entry(1)]);
  await store.close();
});

test("read is ascending from fromSeq (inclusive), limited, and returns what was appended", async () => {
  const { store } = fresh();
  const all = Array.from({ length: 25 }, (_, i) => entry(i + 1));
  await store.append(T, B, all.slice(0, 10), 0);
  await store.append(T, B, all.slice(10), 10);
  expect(await store.read(T, B, 1, 1000)).toEqual(all);
  expect((await store.read(T, B, 20, 1000)).map(e => e.seq)).toEqual([20, 21, 22, 23, 24, 25]);
  expect((await store.read(T, B, 5, 3)).map(e => e.seq)).toEqual([5, 6, 7]);
  expect(await store.read(T, B, 26, 10)).toEqual([]);
  expect(await code(store.read(T, B, 1, 0))).toBe("bad-entry");
  await store.close();
});

test("boards and tenants are separate logs", async () => {
  const { store } = fresh();
  await store.append(T, B, [entry(1)], 0);
  await store.append(T, "b-two", [entry(1, { board: "b-two" })], 0);
  await store.append("t-bbb", B, [entry(1, { tenant: "t-bbb" }), entry(2, { tenant: "t-bbb" })], 0);
  expect(await store.lastSeq(T, B)).toBe(1);
  expect(await store.lastSeq("t-bbb", B)).toBe(2);
  expect((await store.read("t-bbb", B, 1, 10)).every(e => e.tenant === "t-bbb")).toBe(true);
  expect(await store.read(T, "b-none", 1, 10)).toEqual([]);
  await store.close();
});

test("ids that aren't server ids are refused at the port", async () => {
  const { store } = fresh();
  for (const bad of ["", "a.b", "*", ">", "../x", "A", 7, null, "x".repeat(65)]) {
    expect(await code(store.append(bad, B, [entry(1, { tenant: bad })], 0))).toBe("bad-id");
    expect(await code(store.read(T, bad, 1, 10))).toBe("bad-id");
    expect(await code(store.getCheckpoint(bad, B))).toBe("bad-id");
  }
  await store.close();
});

test("checkpoints: the highest seq wins, never the last write", async () => {
  const { store } = fresh();
  expect(await store.getCheckpoint(T, B)).toBe(null);
  await store.putCheckpoint(T, B, { seq: 10, streams: { board: "ten" } });
  await store.putCheckpoint(T, B, { seq: 30, streams: { board: "thirty" } });
  await store.putCheckpoint(T, B, { seq: 20, streams: { board: "twenty" } });   // a slow, older write lands last
  expect(await store.getCheckpoint(T, B)).toEqual({ seq: 30, streams: { board: "thirty" } });
  await store.putCheckpoint(T, B, { seq: 30, streams: { board: "again" } });    // equal seq doesn't replace
  expect((await store.getCheckpoint(T, B)).streams.board).toBe("thirty");
  expect(await store.getCheckpoint(T, "b-two")).toBe(null);
  expect(await code(store.putCheckpoint(T, B, { streams: {} }))).toBe("bad-entry");
  await store.close();
});

test("checkpoints: beforeSeq steps back past a bad one; only the newest few are kept", async () => {
  const { store } = fresh();
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
  await store.close();
});

test("data survives close and reopen", async () => {
  const { path, store } = fresh();
  await store.append(T, B, [entry(1), entry(2), entry(3)], 0);
  await store.putCheckpoint(T, B, { seq: 2, note: "cp" });
  await store.close();
  expect(await code(store.lastSeq(T, B))).toBe("closed");
  const again = sqliteStore({ path });
  expect(await again.read(T, B, 1, 10)).toEqual([entry(1), entry(2), entry(3)]);
  expect(await again.getCheckpoint(T, B)).toEqual({ seq: 2, note: "cp" });
  await again.append(T, B, [entry(4)], 3);                                      // carries on where it stopped
  expect(await code(again.append(T, B, [entry(1)], 0))).toBe("conflict");
  await again.close();
});

test("two handles on one file (two hosts): one append wins, the other gets conflict", async () => {
  const { path, store: a } = fresh();
  const b = sqliteStore({ path });
  await a.append(T, B, [entry(1)], 0);
  const results = await Promise.all([code(a.append(T, B, [entry(2, { by: "a" })], 1)), code(b.append(T, B, [entry(2, { by: "b" })], 1))]);
  expect(results.sort()).toEqual(["conflict", "resolved"]);
  expect(await b.lastSeq(T, B)).toBe(2);
  expect(await code(b.append(T, B, [entry(2)], 1))).toBe("conflict");            // the fenced host stays fenced
  await a.append(T, B, [entry(3)], 2);
  expect((await b.read(T, B, 1, 10)).map(e => e.seq)).toEqual([1, 2, 3]);
  await a.close(); await b.close();
});
