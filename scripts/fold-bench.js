// How long a checkpoint of an N MB board holds the event loop: the longest single block, in ms of wall clock
// (PROTOCOL.md § Recovery, "Incremental fold"). A report, not a gate (the gate counts steps: test/fold.test.js).
//   bun scripts/fold-bench.js [--root <repo>] [--mb 10,27,50]
// --root points at another checkout (e.g. `git archive <sha> packages server | tar -x -C <dir>`) to measure the old
// whole-state fold against this one: the script uses whichever checkpoint API that tree has.
import { resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = resolve(arg("--root", new URL("..", import.meta.url).pathname));
const sizes = arg("--mb", "10,27,50").split(",").map(Number);
const { Room } = await import(`${root}/packages/protocol/room.js`);
const { makeElement } = await import(`${root}/packages/core/model.js`);
const encodePath = `${root}/server/encode/sliced.js`;
const encodeSliced = existsSync(encodePath) ? (await import(encodePath)).encodeSliced : null;
const rect = (id, f = {}) => makeElement("rectangle", { id, x: 0, y: 0, width: 10, height: 10, ...f });
const ms = t0 => performance.now() - t0;

for (const mb of sizes) {
  // Elements of about `per` chars each (bigger for a bigger board: a board holds at most 100,000 ids).
  const per = Math.max(480, Math.ceil(mb * 1024 * 1024 / 90_000)), pad = "x".repeat(per - 220), elements = [];
  for (let n = 0, i = 0; n < mb * 1024 * 1024; i++) { const el = rect(`big${i}`, { x: i, text: pad }); n += JSON.stringify(el).length; elements.push(el); }
  const entry = { seq: 1, id: "a:1", by: "ua", at: 1, rv: 1, tenant: "t1", board: "b1", stream: "board", op: { elements: [rect("first")] } };
  const empty = Room.rebuild({ entries: [entry], board: "b1", tenant: "t1", auto: false });
  const cp = empty.checkpoint(); cp.streams.board.elements.push(...elements);
  const log = { append() {}, putCheckpoint() {} };
  const room = Room.rebuild({ checkpoint: cp, entries: [entry], board: "b1", tenant: "t1", log, auto: false });
  const b = room.connect(() => {});
  room.receive(b, { t: "hello", v: 1, board: "b1", since: 0, client: "w" }, { n: 1, user: "ua", role: "editor" });
  room.receive(b, { t: "op", id: "w:1", sentAt: 0, stream: "board", op: { elements: [rect("second")] } }, { n: 2 });
  const out = { mb, elements: elements.length };
  let made;
  if (typeof room.startCheckpoint === "function") {   // incremental: one block = one step
    const q = []; room.schedule = fn => q.push(fn); room.startCheckpoint();
    let worst = 0, steps = 0;
    while (q.length) { const t0 = performance.now(); q.shift()(); worst = Math.max(worst, ms(t0)); steps++; }
    Object.assign(out, { foldMaxBlockMs: +worst.toFixed(2), steps }); made = room.base;
  } else { const t0 = performance.now(); made = room.checkpoint(); Object.assign(out, { foldMaxBlockMs: +ms(t0).toFixed(2), steps: 1 }); }
  if (encodeSliced) {   // the adapter's encode: one block = the time between two yields
    let last = performance.now(), worst = 0;
    const text = await encodeSliced(made, { yieldNow: async () => { worst = Math.max(worst, ms(last)); await new Promise(r => setImmediate(r)); last = performance.now(); } });
    worst = Math.max(worst, ms(last)); out.encodeMaxBlockMs = +worst.toFixed(2); out.encodedMB = +(text.length / 1048576).toFixed(1);
  } else { const t0 = performance.now(); const text = JSON.stringify(made); out.encodeMaxBlockMs = +ms(t0).toFixed(2); out.encodedMB = +(text.length / 1048576).toFixed(1); }
  // End to end: the longest the loop stalled while the SQLite Store took the checkpoint (encode + the synchronous write).
  const dir = mkdtempSync(join(tmpdir(), "fold-bench-"));
  try {
    const { sqliteStore } = await import(`${root}/server/store/sqlite.js`);
    const store = sqliteStore({ path: join(dir, "p.db") });
    const epoch = await store.openEpoch("t-aaa", "b-one");
    let last = performance.now(), worst = 0, run = true;
    const tick = () => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; if (run) setImmediate(tick); };
    setImmediate(tick); last = performance.now();
    await store.putCheckpoint("t-aaa", "b-one", made, epoch);
    run = false; await new Promise(r => setImmediate(r));
    out.sqlitePutMaxStallMs = +worst.toFixed(2);
    await store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(JSON.stringify(out));
}
