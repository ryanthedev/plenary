// Issues #43 and #68, "make joins small and quick": what a joining client is sent, in bytes and frames (never wall time),
// on boards built the way real use builds them (many ops, some of them edits), with and without compressed catch-up
// (PROTOCOL.md § Joining, § Recovery "When"). Set JOIN_REPORT=1 to print the table the issue asks for.
//
// BASELINE at 139fa3d (CHECKPOINT_EVERY 1,000 only, no compression), measured with this file's builder: a 2,000-shape
// board in 20 ops joined as welcome + one 864 KB `entries` frame + here (no checkpoint yet: 20 entries); 10,000 shapes in
// 100 ops as 4,340 KB in 7 frames (five 1 MB `entries` chunks); 2,000 shapes + 2,000 moves as 873 KB (an 861 KB snapshot
// and 12 KB of tail, because the 1,000-entry fold had just run: the tail can be up to ~1,000 entries longer).
import { test, expect, afterAll } from "bun:test";
import { buildBoard, measureJoin, rig, kb, zlibDeflate, shape } from "./join-measure.js";
import { cleanup, until } from "./helpers.js";
import { roomState, tokenOf } from "./rig.js";
import { Replica } from "../../packages/protocol/replica.js";
import { CHECKPOINT_BYTES, CHECKPOINT_STATE_RATIO } from "../../packages/protocol/envelope.js";

afterAll(cleanup);
const report = (label, j) => { if (process.env.JOIN_REPORT) console.log(`join ${label}: ${kb(j.bytes)} in ${j.frames} frames  ${j.kinds.map(k => `${k.t}${k.binary ? "(z)" : ""} ${kb(k.bytes)}`).join(", ")}`); };

/** A rig that counts what the Store is asked to write (checkpoints and log bytes) and has the real compressor. */
async function boardRig(o = {}) {
  const io = { checkpoints: 0, checkpointBytes: 0, logBytes: 0, deflates: 0 };
  const deflater = zlibDeflate();
  const r = await rig({
    wrapStore: st => ({ ...st,
      putCheckpoint: async (t, b, cp, e) => { io.checkpoints++; io.checkpointBytes += JSON.stringify(cp).length; return st.putCheckpoint(t, b, cp, e); },
      append: async (t, b, es, x, e) => { io.logBytes += JSON.stringify(es).length; return st.append(t, b, es, x, e); },
      ...(o.wrapStore?.(st) ?? {}) }),
    server: { deflate: o.deflate ?? (async d => { io.deflates++; return deflater(d); }) },
  });
  return { r, io };
}
const tailOf = j => j.kinds.filter(k => k.t === "entries").reduce((n, k) => n + k.bytes, 0);
const snapshotOf = j => j.kinds.find(k => k.t === "snapshot")?.bytes ?? 0;
const sameDoc = (replica, r) => expect(replica.state()).toEqual(roomState(r.room0));
/** The gateway drops a board's feed when its last connection is gone. */
const feedGone = r => until(() => !r.server.gateway.feed(r.ids.tenant, r.ids.board), "the feed to be released", 10_000);

const BOARDS = [
  ["2,000 shapes, 20 ops of 100", { shapes: 2000 }, 20],
  ["2,000 shapes, 20 ops + 2,000 moves", { shapes: 2000, edits: 2000 }, 2020],
  ["10,000 shapes, 100 ops of 100", { shapes: 10000 }, 100],
];

for (const [label, build, seq] of BOARDS) test(`DW-43.1 DW-68.2: ${label}: the join is a snapshot plus a short tail, and compressed it is a small fraction of today's`, async () => {
  const { r, io } = await boardRig();
  const b = await buildBoard(r, build);
  expect(b.seq).toBe(seq);
  r.room0 = await r.room();
  const plain = await measureJoin(r, { name: "plain" }), z = await measureJoin(r, { z: true, name: "zed" });
  report(label + " plain", plain); report(label + " compressed", z);
  if (process.env.JOIN_REPORT) console.log(`  store writes: ${io.checkpoints} checkpoints, ${kb(io.checkpointBytes)} against a ${kb(io.logBytes)} log (${(io.checkpointBytes / io.logBytes).toFixed(2)}x)`);
  // Snapshot + short tail: the room folded (checkpoint > 0), the join starts at it and the tail is at most the larger of
  // CHECKPOINT_BYTES and a quarter of the state (op bytes; the entry text adds its envelope, so allow 1.5x) ...
  expect(b.checkpoint).toBeGreaterThan(0);
  expect(plain.kinds.map(k => k.t)).toEqual(["welcome", "snapshot", ...plain.kinds.filter(k => k.t === "entries").map(() => "entries"), "here"]);
  expect(tailOf(plain)).toBeLessThanOrEqual(1.5 * Math.max(CHECKPOINT_BYTES, snapshotOf(plain) / CHECKPOINT_STATE_RATIO) + 70_000);   // + one op's worth of entries that raced the checkpoint
  expect(plain.replica.applied).toBe(seq);
  // ... compressed: the same messages, in one binary frame per big text, a small fraction of the bytes.
  expect(z.msgs).toEqual(plain.msgs);
  expect(z.kinds.filter(k => k.binary).length).toBeGreaterThanOrEqual(1);
  expect(z.kinds.filter(k => k.t === "welcome" || k.t === "here").every(k => !k.binary)).toBe(true);
  expect(z.bytes).toBeLessThan(plain.bytes / 10);
  expect(z.bytes).toBeLessThan(0.2 * 1024 * 1024 * (build.shapes / 2000));   // about 0.03 MB per 2,000 shapes, with room to spare
  // Both ends hold the room's board.
  for (const j of [plain, z]) sameDoc(j.replica, r);
  // The write side of the policy: checkpoints cost a few times the log, not per op.
  expect(io.checkpointBytes).toBeLessThan((CHECKPOINT_STATE_RATIO + 1) * io.logBytes);
  expect(io.checkpoints).toBeLessThan(seq / 2);
  plain.close(); z.close(); await r.stop();
}, 120_000);

test("DW-68.1: a board of many small ops folds by bytes long before 1,000 entries (the join tail stays short)", async () => {
  const { r } = await boardRig();
  const b = await buildBoard(r, { shapes: 20, perOp: 1, edits: 600 });   // 620 ops of one shape each: ~65 KB of ops, state ~9 KB
  expect(b.seq).toBe(620);
  expect(b.checkpoint).toBeGreaterThan(0);                                // 1,000 entries were never reached
  r.room0 = await r.room();
  const j = await measureJoin(r);
  expect(j.kinds.map(k => k.t)).toContain("snapshot");
  expect(tailOf(j)).toBeLessThan(1.5 * CHECKPOINT_BYTES + 5_000);
  sameDoc(j.replica, r);
  j.close(); await r.stop();
}, 60_000);

test("DW-68.3: joiners at any point converge: a replica that stopped listening at several seqs rejoins from some checkpoint and tail", async () => {
  const { r } = await boardRig();
  // The writer builds in phases; a viewer is connected from each point on, then drops at once (stale from there).
  const stale = [];
  const w = await r.sock();
  w.send({ t: "hello", v: 1, token: tokenOf("editor"), board: r.ids.board, since: 0, client: "phased" });
  await w.next(m => m.t === "welcome");
  let n = 0;
  const phase = async (from, to, per = 50) => {
    for (let i = from; i < to; i += per) w.send({ t: "op", id: `phased:${++n}`, sentAt: 0, stream: "board", op: { elements: Array.from({ length: Math.min(per, to - i) }, (_, k) => shape(i + k)) } });
    await until(() => w.msgs.filter(m => m.t === "ack").length === n, "acks", 30_000);
    await r.idle();
  };
  for (const [from, to] of [[0, 100], [100, 400], [400, 900], [900, 1200]]) {
    await phase(from, to);
    const j = await measureJoin(r, { z: stale.length % 2 === 1 });       // joins here, then goes away holding this much
    stale.push(j.replica); j.close();
  }
  for (let e = 0; e < 300; e++) { w.send({ t: "op", id: `phased:${++n}`, sentAt: 0, stream: "board", op: { elements: [{ ...shape(e * 3, 2), x: 7 + e }] } }); }
  await until(() => w.msgs.filter(m => m.t === "ack").length === n, "acks", 30_000);
  await r.idle();
  const room = await r.room();
  await until(() => room.savedSeq > 0 && r.server.gateway.feed(r.ids.tenant, r.ids.board)?.base === room.savedSeq, "the feed on the newest checkpoint");
  r.room0 = room;
  expect(stale.map(x => x.applied).every((a, i, all) => a > 0 && (i === 0 || a > all[i - 1]))).toBe(true);
  const bases = new Set();
  for (const [i, replica] of stale.entries()) {
    const j = await measureJoin(r, { z: i % 2 === 0, replica, name: "back" + i });   // since = what it had applied
    bases.add(j.kinds.some(k => k.t === "snapshot") ? "snapshot" : "entries");
    sameDoc(j.replica, r);
    j.close();
  }
  expect(bases.has("snapshot")).toBe(true);                               // some came back across a checkpoint, some within its tail
  await w.close(); await r.stop();
}, 60_000);

test("a missing or damaged checkpoint falls back to the one before it, or to the whole log: the join is longer, never short", async () => {
  const mode = { cp: x => x };
  const { r } = await boardRig({ wrapStore: st => ({ getCheckpoint: async (...a) => mode.cp(await st.getCheckpoint(...a), a) }) });
  await buildBoard(r, { shapes: 1000, perOp: 50 });
  r.room0 = await r.room();
  const good = await measureJoin(r, { name: "good" });
  expect(good.kinds.some(k => k.t === "snapshot")).toBe(true);
  good.close(); await feedGone(r);
  // Missing: the Store answers no checkpoint at all.
  mode.cp = () => null;
  await feedGone(r);                                                      // the next join builds a fresh feed, reading the Store again
  const missing = await measureJoin(r, { name: "missing" });
  sameDoc(missing.replica, r);
  expect(missing.kinds.filter(k => k.t === "entries").length).toBeGreaterThan(0);
  missing.close(); await feedGone(r);
  // Damaged: a checkpoint whose entry doesn't match the log is stepped past (the one before it, or none).
  mode.cp = cp => cp && { ...cp, id: "someone-else:1" };
  const damaged = await measureJoin(r, { name: "damaged", z: true });
  expect(damaged.kinds.some(k => k.t === "snapshot")).toBe(false);          // every checkpoint was wrong: none used, the whole log sent
  expect(damaged.kinds.filter(k => k.t === "entries").length).toBeGreaterThan(0);
  sameDoc(damaged.replica, r);
  damaged.close();
  await r.stop();
}, 60_000);

test("DW-43.2: an entry that lands while a join's catch-up is being compressed: the join is compressed anyway (the new last frame is compressed too) and still converges", async () => {
  const real = zlibDeflate();
  let hook = null, calls = 0;
  const { r } = await boardRig({ deflate: async d => { calls++; if (hook) { const h = hook; hook = null; await h(); } return real(d); } });
  const w = await r.sock();
  w.send({ t: "hello", v: 1, token: tokenOf("editor"), board: r.ids.board, since: 0, client: "live" });
  await w.next(m => m.t === "welcome");
  let n = 0;
  const op = els => { w.send({ t: "op", id: `live:${++n}`, sentAt: 0, stream: "board", op: { elements: els } }); return until(() => w.msgs.filter(m => m.t === "ack").length === n, "ack", 30_000); };
  for (let i = 0; i < 300; i += 50) await op(Array.from({ length: 50 }, (_, k) => shape(i + k)));
  hook = () => op([shape(1000)]);                                         // lands in the middle of the first deflate
  const j = await measureJoin(r, { z: true, name: "mid" });
  expect(calls).toBeGreaterThanOrEqual(2);                                // the tail's last frame was a new text: compressed again
  expect(j.kinds.filter(k => k.binary).length).toBe(j.kinds.filter(k => k.t === "entries" || k.t === "snapshot").length);   // none fell back to plain
  r.room0 = await r.room();
  await until(() => j.replica.applied === r.room0.resolved, "the live entry to reach the joiner", 10_000);   // and the entry that landed arrived once, after the catch-up
  sameDoc(j.replica, r);
  j.close(); await w.close(); await r.stop();
}, 60_000);

test("a join that asks for deflate on a cold gateway (its feed not yet started) still gets compressed frames", async () => {
  const { r } = await boardRig();
  await buildBoard(r, { shapes: 300, perOp: 50 });
  await feedGone(r);
  r.room0 = await r.room();
  const j = await measureJoin(r, { z: true, name: "cold" });
  expect(j.kinds.filter(k => k.binary).length).toBeGreaterThanOrEqual(1);
  sameDoc(j.replica, r);
  j.close(); await r.stop();
}, 60_000);
