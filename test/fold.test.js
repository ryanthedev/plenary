// The incremental checkpoint (PROTOCOL.md § Recovery, "Incremental fold"; packages/protocol/fold.js): a fold taken in
// small steps while ops keep landing is still exactly the state at one seq, never blocks for more than a bounded step,
// and is abandoned safely. Steps are driven by hand through the room's `schedule` port: no timers, no sleeps.
import { test, expect } from "bun:test";
import { world, direct, slowLog } from "./world.js";
import { Room } from "../packages/protocol/room.js";
import { MemoryLog } from "../packages/protocol/ports.js";
import { FOLD_STEP_UNITS } from "../packages/protocol/fold.js";
import { canWrite } from "../packages/protocol/envelope.js";
import { makeElement, touch, clone } from "../packages/core/model.js";

const rect = (id, fields = {}) => makeElement("rectangle", { id, x: 0, y: 0, width: 10, height: 10, ...fields });
/** A schedule port the test drains: `run()` takes one turn, `drain()` takes them all. */
const manual = () => { const q = []; return { q, schedule: fn => q.push(fn), run: () => q.shift()?.(), drain: () => { while (q.length) q.shift()(); } }; };
/** What a checkpoint must equal: a room rebuilt from the log's first `seq` entries, folded whole by the same code. */
const stateAt = (log, seq, opts) => Room.rebuild({ entries: log.read(1).filter(e => e.seq <= seq), ...opts, log: null, auto: false }).state();
const fromCp = (log, cp, opts) => Room.rebuild({ checkpoint: cp, entries: log.read(cp.seq), ...opts, log: null, auto: false }).state();

function edit(w, c) {   // one random edit a client may make (as test/convergence.test.js)
  const stream = canWrite(c.role, "board") && w.rng() < 0.7 ? "board" : "notes";
  if (!canWrite(c.role, stream)) return;
  const doc = c.r.streams[stream], live = [...doc.byId.values()].filter(e => !e.isDeleted), roll = w.rng();
  if (stream === "board" && roll < 0.1) return w.send(c, stream, { appState: { grid: Math.floor(w.rng() * 40) } });
  if (!live.length || roll < 0.4) return w.send(c, stream, { elements: [makeElement("rectangle", { x: Math.floor(w.rng() * 500), y: 0, width: 80, height: 60 })] });
  const el = clone(live[Math.floor(w.rng() * live.length)]);
  if (roll < 0.55) el.isDeleted = true; else el.x += Math.floor(w.rng() * 50) - 25;
  w.send(c, stream, { elements: [touch(el)] });
}

// DW: a checkpoint taken in steps while ops keep landing is the state at ONE seq, on many seeds.
for (let seed = 1; seed <= 24; seed++) test(`a fold stepped between ops equals the log replayed to its seq, and rebuilds the live state (seed ${seed})`, () => {
  const m = manual();
  const w = world(["owner", "editor", "editor", "annotator", "viewer"], seed, { foldBytes: 600, foldUnits: 6, schedule: m.schedule });
  const opts = { board: "b1", tenant: "t1" };
  for (let round = 0; round < 260; round++) {
    const c = w.clients[Math.floor(w.rng() * w.clients.length)];
    if (w.rng() < 0.7) edit(w, c);
    for (let k = 0; k < 3; k++) w.step();
    if (m.q.length && w.rng() < 0.6) m.run();            // a fold step lands between ops, never at a fixed point
    if (round === 130) { m.q.length = 0; w.rebuild(); }  // the room dies (its fold with it); the new one has the old log and checkpoints
  }
  for (const c of w.clients) if (!c.conn) w.connect(c);
  w.settle(); m.drain();
  const cps = w.log.checkpoints;
  expect(cps.length).toBeGreaterThan(2);
  for (const cp of cps) {
    expect(fromCp(w.log, cp, opts)).toEqual(stateAt(w.log, w.log.end, opts));   // checkpoint + tail = the whole
    expect(stateAt(w.log, cp.seq, opts)).toEqual(Room.rebuild({ checkpoint: cp, entries: w.log.read(cp.seq).slice(0, 1), ...opts, log: null }).state());   // and it IS the state at its seq
  }
  expect(w.room.status().stopped).toBe(false);
  expect(w.rebuild({ keep: true }).state()).toEqual(w.room.state());
  for (const c of w.clients) expect(c.r.pending.size).toBe(0);
});

test("DW: ops resolved while the fold is mid-copy are not in it, are in the tail, and the room keeps serving catch-up from the old base until it lands", () => {
  const m = manual(), d = direct(undefined, { foldBytes: 1, foldUnits: 4, schedule: m.schedule });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 30; i++) a.op(i, "board", { elements: [rect(`e${i}`)] });   // folds are due all along: one job, begun at the first resolve
  expect(d.room.folder.active).toBe(true);
  expect(d.room.base.seq).toBe(0);                          // nothing landed yet: catch-up still serves the empty base + the whole tail
  const joiner = d.join("ub", "viewer", "b", 0);
  expect(joiner.of("entries").flatMap(m => m.entries).length + joiner.of("snapshot").length).toBeGreaterThan(0);
  const begunAt = d.room.folder.gen && d.room.resolved;
  m.run();                                                  // one step
  a.op(31, "board", { elements: [rect("late")] });
  m.drain();
  const cp = d.log.checkpoints[0];
  expect(cp.seq).toBeLessThan(d.room.resolved);             // taken at the seq it began at, not at the end
  expect(cp.streams.board.elements.map(e => e.id)).not.toContain("late");
  expect(d.room.base.seq).toBe(cp.seq);
  expect(d.room.tail.map(e => e.seq)).toEqual(Array.from({ length: d.room.resolved - cp.seq }, (_, i) => cp.seq + 1 + i));
  expect(d.room.tailChars).toBe(d.room.tail.reduce((n, e) => n + JSON.stringify(e.op).length, 0));
  expect(begunAt).toBeGreaterThan(0);
});

test("DW: a fold begun while entries are still unresolved holds only resolved state", async () => {
  const m = manual(), slow = slowLog(), d = direct(slow, { foldBytes: 1, foldUnits: 4, schedule: m.schedule });
  const a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("one")] });
  slow.waiting.shift().land(); await Promise.resolve();      // entry 1 resolves: a fold begins at seq 1
  a.op(2, "board", { elements: [rect("two")] });             // accepted into the live state, unresolved
  a.op(3, "board", { elements: [rect("three")] });
  expect(d.room.seq).toBeGreaterThan(d.room.resolved);
  m.drain();
  const cp = slow.log.checkpoints[0];
  expect(cp.seq).toBe(1);
  expect(cp.streams.board.elements.map(e => e.id)).toEqual(["one"]);
});

test("backpressure: no second fold starts while one runs or its write is unsettled", async () => {
  const m = manual(); let release; const writes = [];
  const log = new MemoryLog(); log.putCheckpoint = cp => new Promise(r => writes.push({ cp, r }));
  const d = direct(log, { foldBytes: 1, foldUnits: 1e9, schedule: m.schedule });
  const a = d.join("ua", "editor", "a");
  a.op(1, "board", { elements: [rect("a")] });
  expect(m.q.length).toBe(1);
  a.op(2, "board", { elements: [rect("b")] }); a.op(3, "board", { elements: [rect("c")] });
  expect(m.q.length).toBe(1);                                // the second and third resolves scheduled nothing: a job is active
  m.drain();
  expect(writes.length).toBe(1);
  a.op(4, "board", { elements: [rect("d")] });
  expect(m.q.length).toBe(0);                                // the write is unsettled: not ahead of it
  writes[0].r(); await Promise.resolve(); await Promise.resolve();
  expect(d.room.heartbeat().cp).toBe(writes[0].cp.seq);
  a.op(5, "board", { elements: [rect("e")] });
  expect(m.q.length).toBe(1);                                // settled: the next fold may begin
  release = null; expect(release).toBe(null);
});

test("DW: a fold in progress when the room stops is abandoned: no checkpoint is written and no step runs it", () => {
  const m = manual(), d = direct(undefined, { foldBytes: 1, foldUnits: 4, schedule: m.schedule });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 20; i++) a.op(i, "board", { elements: [rect(`e${i}`)] });
  m.run();
  d.room.fail(new Error("fenced"));
  m.drain();
  expect(d.log.checkpoints).toEqual([]);
  expect(d.room.folder.active).toBe(false);
  expect(d.room.checkpoint()).toBe(null);
});

test("checkpoint() finishes a fold in progress, then folds to the room's current seq, and the scheduled steps become no-ops", () => {
  const m = manual(), d = direct(undefined, { foldBytes: 1, foldUnits: 4, schedule: m.schedule });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 10; i++) a.op(i, "board", { elements: [rect(`e${i}`)] });
  m.run();
  const cp = d.room.checkpoint();
  expect(cp.seq).toBe(10);
  const written = d.log.checkpoints.length;
  m.drain();
  expect(d.log.checkpoints.length).toBe(written);
  expect(d.room.folder.active).toBe(false);
});

test("a fold that throws is reported, dropped, and the next one rebuilds its shadow from the checkpoint", () => {
  const m = manual(), reports = [], d = direct(undefined, { auto: false, foldUnits: 4, schedule: m.schedule, report: (w, x) => reports.push(w) });
  const a = d.join("ua", "editor", "a");
  for (let i = 1; i <= 5; i++) a.op(i, "board", { elements: [rect(`e${i}`)] });
  expect(d.room.folder.shadow).toBe(null);   // the shadow is built by the first job's first step
  d.room.startCheckpoint(); m.run();
  d.room.folder.shadow.applyEntry = () => { throw new Error("boom"); };
  m.drain();
  expect(reports).toContain("checkpoint-failed");
  expect(d.room.folder.shadow).toBe(null);
  expect(d.room.folder.active).toBe(false);
  a.op(6, "board", { elements: [rect("e6")] });
  d.room.startCheckpoint(); m.drain();
  expect(d.log.checkpoints.at(-1).seq).toBe(6);
  expect(fromCp(d.log, d.log.checkpoints.at(-1), { board: "b1", tenant: "t1" })).toEqual(stateAt(d.log, d.log.end, { board: "b1", tenant: "t1" }));
});

// DW: the block is bounded. Measured in work units (a step count), not wall time: the step cap is what the host's
// schedule enforces, and the wall-clock figure is printed as a report (scripts/fold-bench.js has the before/after).
function bigRoom(bytes, opts = {}) {
  const elements = [], pad = "x".repeat(400);
  for (let n = 0, i = 0; n < bytes; i++) { const el = rect(`big${i}`, { x: i, text: pad }); n += JSON.stringify(el).length; elements.push(el); }
  const entry = { seq: 1, id: "a:1", by: "ua", at: 1, rv: 1, tenant: "t1", board: "b1", stream: "board", op: { elements: [rect("first")] } };
  const cp = Room.rebuild({ entries: [entry], board: "b1", tenant: "t1", log: null, auto: false }).checkpoint();
  cp.streams.board.elements.push(...elements);
  const log = new MemoryLog(); log.entries.push(entry);
  log.putCheckpoint = () => {};   // MemoryLog deep-copies what it keeps: that copy is the test double's cost, not the fold's
  const room = Room.rebuild({ checkpoint: cp, entries: [entry], board: "b1", tenant: "t1", log, auto: false, ...opts });
  return { room, elements: elements.length + 1 };
}
for (const mb of [10, 30]) test(`DW: a ${mb} MB board's fold takes bounded steps (units), whatever the state's size, and equals the state at its seq`, () => {
  const { room, elements } = bigRoom(mb * 1024 * 1024);
  const m = manual(); room.schedule = m.schedule;
  room.auto = false;
  const got = [], b = room.connect(m => got.push(m));
  room.receive(b, { t: "hello", v: 1, board: "b1", since: 0, client: "w" }, { n: 1, user: "ua", role: "editor" });
  for (let i = 1; i <= 40; i++) room.receive(b, { t: "op", id: `w:${i}`, sentAt: 0, stream: "board", op: { elements: [rect(`new${i}`)] } }, { n: 1 + i });
  expect(got.filter(x => x.t === "error")).toEqual([]);
  room.startCheckpoint();
  let steps = 0, worst = 0;
  while (m.q.length) { const t0 = performance.now(); m.run(); worst = Math.max(worst, performance.now() - t0); steps++; if (steps === 3) room.receive(b, { t: "op", id: "w:99", sentAt: 0, stream: "board", op: { elements: [rect("mid")] } }, { n: 99 }); }
  const cp = room.base;
  expect(cp.seq).toBe(41);                                   // the seq the job began at (hello is not an entry)
  expect(cp.streams.board.elements.length).toBe(elements + 40);
  expect(cp.streams.board.elements.map(e => e.id)).not.toContain("mid");
  // 2 passes (adopt, emit) over the elements, a little per entry: the step cap bounds each, so the step count is the size / cap.
  expect(room.folder.maxUnits).toBeLessThan(FOLD_STEP_UNITS + 200);
  expect(steps).toBeGreaterThanOrEqual(Math.floor((2 * elements) / FOLD_STEP_UNITS));
  expect(steps).toBeLessThan((2 * elements) / FOLD_STEP_UNITS + 40);
  console.log(`fold of ${mb} MB (${elements} elements): ${steps} steps, max step ${worst.toFixed(2)} ms wall (cap ${FOLD_STEP_UNITS} units)`);
});

test("a fold carries records, note authors, the op-id table and appState, across two jobs (the shadow advances, never restarts)", () => {
  const m = manual(), d = direct(undefined, { auto: false, foldUnits: 3, schedule: m.schedule });
  const opts = { board: "b1", tenant: "t1" };
  const a = d.join("ua", "editor", "a"), n = d.join("ub", "annotator", "b");
  const anchor = { stream: "board", element: "el9", x: 1, y: 2 };
  a.op(1, "records", { do: "thread", id: "t1", anchor, text: "hello" });
  a.op(2, "board", { elements: [rect("r1")] });
  n.op(1, "notes", { elements: [rect("note1")] });
  a.op(3, "board", { appState: { grid: 20 }, appBase: { grid: 0 } });
  d.room.startCheckpoint(); m.drain();
  const first = d.log.checkpoints.at(-1);
  expect(first.seq).toBe(4);
  expect(first.records.threads.map(t => t.id)).toEqual(["t1"]);
  expect(first.noteAuthor).toEqual([["note1", "ub"]]);
  expect(fromCp(d.log, first, opts)).toEqual(stateAt(d.log, 4, opts));
  const shadow = d.room.folder.shadow;
  a.op(4, "records", { do: "reply", id: "c2", thread: "t1", text: "again" });
  a.op(5, "records", { do: "react", id: "c2", emoji: "+1", on: true });
  a.op(6, "board", { elements: [rect("r1", { version: 9, x: 5 })] });
  n.op(2, "notes", { elements: [rect("note2")] });
  d.room.startCheckpoint(); m.drain();
  const second = d.log.checkpoints.at(-1);
  expect(d.room.folder.shadow).toBe(shadow);                  // advanced by the tail, not rebuilt
  expect(second.seq).toBe(8);
  expect(second.records.threads[0].comments.map(c => c.id)).toEqual(["t1", "c2"]);
  expect(fromCp(d.log, second, opts)).toEqual(stateAt(d.log, 8, opts));
  expect(d.room.base).toEqual(second);   // the log keeps a copy
  expect(d.room.tail).toEqual([]);
  expect(d.room.tailChars).toBe(0);
});
