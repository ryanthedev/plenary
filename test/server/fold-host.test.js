// The room host's incremental checkpoint (PROTOCOL.md § Recovery, "Incremental fold") against a real Store: a fold still
// in progress when the board is taken over, or the room stops, writes nothing. Steps are driven by hand through the
// host's `schedule` port, so the takeover lands at a chosen point of the fold (no timers, no sleeps as sync points).
// Postgres cases run when DATABASE_URL is set (bun run test:cluster); the rest use SQLite files.
import { test, expect, afterAll, describe } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import { roomHost } from "../../server/room-host.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { postgresStore } from "../../server/store/postgres.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";
import { cleanup, tempDir, until } from "./helpers.js";
import { createLogger } from "../../server/log.js";

afterAll(cleanup);
const T = "t-aaa", B = "b-one";
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });

function gateway(bus) {
  const got = []; let n = 0;
  bus.subscribe(subjects.gateway("g-1"), m => got.push(m.data ? JSON.parse(m.data) : m));
  const send = msg => bus.publish(subjects.inbox(T, B), { n: ++n, conn: "c1", gateway: "g-1", user: "dev:ed", name: "ed", role: "editor", client: "a", msg });
  return {
    hello: () => send({ t: "hello", v: PROTOCOL_VERSION, board: B, client: "a" }),
    op: k => send({ t: "op", id: `a:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${k}`, k)] } }),
    ack: k => until(() => got.find(m => m.t === "ack" && m.id === `a:${k}`), `ack a:${k}`, 10_000),
    welcome: () => until(() => got.find(m => m.t === "welcome"), "welcome", 10_000),
  };
}

const sqliteMaker = () => { const path = join(tempDir(), "plenary.db"); return { open: async () => sqliteStore({ path }), drop: async () => {} }; };
const pgUrl = process.env.DATABASE_URL;
let pgN = 0;
const pgMaker = () => {
  const schema = `pl_test_fold_${process.pid}_${Date.now().toString(36)}_${++pgN}`;
  return { open: () => postgresStore({ url: pgUrl, schema, max: 2 }), drop: async () => { const a = new SQL({ url: pgUrl, max: 1 }); await a.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await a.close(); } };
};

for (const [name, maker] of [["sqlite", sqliteMaker], ["postgres", pgMaker]]) describe.skipIf(name === "postgres" && !pgUrl)(`incremental fold on the host (${name})`, () => {
  /** A host whose fold steps wait in `q` for the test, a board with 6 acked ops, and one fold begun but not run. */
  async function started() {
    const m = maker(), store = await m.open(), bus = memoryBus(), q = [], lines = [];
    const log = createLogger({ write: l => lines.push(JSON.parse(l)), level: "debug" });
    const host = roomHost({ store, bus, log, holder: "h-a", leaseTtlMs: 30_000, tailFoldBytes: 1, foldUnits: 4, schedule: fn => q.push(fn) });
    await host.open(T, B);
    const g = gateway(bus);
    await g.hello(); await g.welcome();
    for (let k = 1; k <= 6; k++) { await g.op(k); await g.ack(k); }
    expect(q.length).toBe(1);                                    // one fold begun at the first resolve; the rest found it running
    const done = async () => { await host.close(); await store.close(); await bus.close(); await m.drop(); };
    return { store, host, q, lines, g, done };
  }
  const drain = q => { while (q.length) q.shift()(); };

  test("takeover mid-fold: the old holder's fold finishes, its write is fenced, the room stops, and no checkpoint of it is kept", async () => {
    const { store, host, q, lines, done } = await started();
    try {
      q.shift()();                                               // a step or two of the fold run, then...
      const eA = (await host.peek(T, B)).epoch;
      expect(await store.openEpoch(T, B)).toBeGreaterThan(eA);   // ...another host takes the board
      drain(q);                                                  // the rest of the fold runs on the old holder and ends in its write
      await until(() => lines.some(l => /room stopped: lease lost/.test(l.msg) && /fenced/.test(l.why)), "the fenced write stops the room", 10_000);
      expect(await store.getCheckpoint(T, B)).toBe(null);
      expect(await host.peek(T, B)).toBe(null);
    } finally { await done(); }
  }, 30_000);

  test("the room stops mid-fold (its lease is lost to a fenced append): the remaining steps write nothing", async () => {
    const { store, host, q, g, done } = await started();
    try {
      q.shift()();
      await store.openEpoch(T, B);
      await g.op(7);                                             // the old holder's append is fenced: its room stops
      await until(async () => (await host.peek(T, B)) === null, "the room stopped", 10_000);
      drain(q);                                                  // the abandoned fold's steps find a dead slot and do nothing
      expect(await store.getCheckpoint(T, B)).toBe(null);
    } finally { await done(); }
  }, 30_000);

  test("the fold lands: the checkpoint is the state at one seq, durable, and a rebuilt room starts from it", async () => {
    const { store, host, q, g, done } = await started();
    try {
      drain(q);
      await until(async () => (await store.getCheckpoint(T, B)) !== null, "the checkpoint is written", 10_000);
      const cp = await store.getCheckpoint(T, B);
      expect(cp.streams.board.elements.length).toBe(cp.seq);     // one rectangle per entry: exactly the state at its seq
      expect(cp.streams.board.elements.map(e => e.id).sort()).toEqual(Array.from({ length: cp.seq }, (_, i) => `e${i + 1}`).sort());
      await g.op(7); await g.ack(7);                             // the board keeps going
      expect((await host.peek(T, B)).room.status().baseSeq).toBe(cp.seq);
    } finally { await done(); }
  }, 30_000);
});
