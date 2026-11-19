// The room host's lease with a real holder process on Postgres + NATS (p4-hostv HIGH-1): kill -9 it, and SIGSTOP it
// past its ttl then wake it. Skips without DATABASE_URL and NATS_URL; room-host-lease.test.js has the in-process
// equivalent of the stall, which always runs.
import { test, expect, afterAll } from "bun:test";
import { SQL } from "bun";
import { roomHost } from "../../server/room-host.js";
import { postgresStore } from "../../server/store/postgres.js";
import { natsBus, subjects } from "../../server/bus/nats.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";
import { sleep, until, spawnTracked } from "./helpers.js";

const T = "t-aaa", B = "b-one", url = process.env.DATABASE_URL, nurl = process.env.NATS_URL;
const CHILD = new URL("./room-host-child.js", import.meta.url).pathname;
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const schemas = [];
afterAll(async () => {
  if (!url || !schemas.length) return;
  const a = new SQL({ url, max: 1 });
  for (const s of schemas) await a.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await a.close();
}, 30_000);   // DROP SCHEMA per test schema on real Postgres; failure-only ceiling for a loaded machine (TECH-DEBT row 36)

function gw(bus, id) {
  const got = [], n = new Map();
  bus.subscribe(subjects.gateway(id), m => got.push({ at: performance.now(), conn: m.conn, close: m.close, msg: m.data ? JSON.parse(m.data) : null }));
  const send = (conn, client, msg) => { const k = (n.get(conn) ?? 0) + 1; n.set(conn, k); return bus.publish(subjects.inbox(T, B), { n: k, conn, gateway: id, user: "dev:ed", name: "ed", role: "editor", client, msg }); };
  return {
    got, of: c => got.filter(m => m.conn === c),
    hello: (c, client) => send(c, client, { t: "hello", v: PROTOCOL_VERSION, board: B, client }),
    op: (c, client, k) => send(c, client, { t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${k}`, k)] } }),
    answer: c => got.find(m => m.conn === c && (m.msg?.t === "welcome" || m.close)),
  };
}
async function child(holder, ttl, schema) {
  const p = spawnTracked(["bun", CHILD, holder, String(ttl), schema], { stdout: "pipe", stderr: "pipe", env: process.env });
  // The child's log lines (stderr) are echoed and kept, so a test can wait for one as a barrier.
  const errLines = [];
  (async () => { let buf = ""; for await (const chunk of p.stderr) { const t = new TextDecoder().decode(chunk); process.stderr.write(t); buf += t; const parts = buf.split("\n"); buf = parts.pop(); errLines.push(...parts); } })().catch(() => {});
  const reader = p.stdout.getReader(); let out = "";
  while (!/OPEN/.test(out)) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
  return { p, errLines, epoch: Number(out.match(/OPEN (\d+)/)?.[1]) };
}

for (const how of ["kill -9", "SIGSTOP"]) test.skipIf(!url || !nurl)(`a real holder process on Postgres + NATS: ${how}`, async () => {
  const schema = `pl_test_hostproc_${process.pid}_${how === "kill -9" ? "k" : "s"}_${Date.now().toString(36)}`; schemas.push(schema);
  const ttl = 3_000;   // the child tolerates a 2 s event-loop stall (its host drops the room after 2/3 of the ttl)
  const { p, errLines, epoch: eA } = await child("h-child", ttl, schema);
  const store = await postgresStore({ url, schema, max: 3 }), bus = await natsBus({ url: nurl, cluster: null });
  const Bh = roomHost({ store, bus, holder: "h-b", leaseTtlMs: 30_000, heartbeatMs: 200 });   // only the child ttl sets the takeover wait; the long one keeps B room alive through an event-loop stall
  const g = gw(bus, `g-${how === "kill -9" ? "k" : "s"}${process.pid}`);
  try {
    g.hello("c1", "a"); await until(() => g.answer("c1")?.msg?.t === "welcome", "welcome from the child", 5000);
    for (let k = 1; k <= 5; k++) { g.op("c1", "a", k); await until(() => g.got.some(m => m.msg?.t === "ack" && m.msg.id === `a:${k}`), `ack ${k}`, 5000); }
    await Bh.open(T, B); expect(Bh.stats().waiting).toBe(1);
    const t0 = performance.now();
    if (how === "kill -9") p.kill(9); else process.kill(p.pid, "SIGSTOP");
    g.hello("c2", "a");                                                      // a hello in the window: answered (backstop ttl + 30 s)
    await until(() => g.answer("c2"), "c2 answered", ttl + 30_000);
    let w = null;
    for (let i = 3; !w && performance.now() - t0 < ttl + 30_000; i++) {
      await Bh.open(T, B); g.hello(`c${i}`, "a");
      await until(() => g.answer(`c${i}`), "answer", ttl + 30_000).catch(() => {});
      const a = g.answer(`c${i}`); if (a?.msg?.t === "welcome") w = { conn: `c${i}`, ...a }; else await sleep(100);
    }
    expect(w).not.toBe(null);
    expect(w.msg.seq).toBe(5); expect(w.msg.room.epoch).toBeGreaterThan(eA);
    if (how === "SIGSTOP") {
      // While A is frozen: a new writer and an op from each, on B. Then wake A: its socket delivers what queued.
      g.hello("x1", "x"); await until(() => g.answer("x1"), "x1", 5000);
      g.op("x1", "x", 1); g.op(w.conn, "a", 6);
      await until(() => g.got.some(m => m.msg?.id === "a:6") && g.got.some(m => m.msg?.id === "x:1"), "x:1 and a:6 acked", 5000);
      const seen = g.got.length;
      process.kill(p.pid, "SIGCONT");
      // Barrier, not a delay: the woken host finds its deadline gone and stops the room (it logs that), and a sentinel op on the new holder is then acked.
      // Anything the woken host sent before or with that stop is on the bus ahead of the ack (the sentinel goes through B, whose reply comes after).
      await until(() => errLines.some(l => /room stopped: lease lost/.test(l)), "the woken host to stop its room", 15_000);
      g.op(w.conn, "a", 7);
      await until(() => g.got.slice(seen).some(m => m.msg?.t === "ack" && m.msg.id === "a:7"), "the sentinel ack from the new holder", 10_000);
      // Nothing from the woken host reaches the new holder's connections: no welcome, no 1013 (the only acks are B's own: a:7).
      expect(g.got.slice(seen).filter(m => (m.conn === "x1" || m.conn === w.conn) && !(m.msg?.t === "ack" && m.msg.id === "a:7"))).toEqual([]);
      expect(g.of("x1").filter(m => m.msg?.t === "welcome").length).toBe(1);
      expect(g.of(w.conn).filter(m => m.msg?.t === "welcome").length).toBe(1);
      expect((await Bh.peek(T, B))?.conns).toBe(2);
      const full = await store.read(T, B, 1, 100);
      expect(full.map(e => e.id)).toEqual(["a:1", "a:2", "a:3", "a:4", "a:5", "x:1", "a:6", "a:7"]);
      expect(await store.lease(T, B)).toMatchObject({ holder: "h-b", live: true });
    }
    const log = await store.read(T, B, 1, 100);
    for (let k = 1; k <= 5; k++) expect(log.filter(e => e.id === `a:${k}`).length).toBe(1);
  } finally { try { p.kill(9); } catch { /* gone */ } await Bh.close(); await bus.close(); await store.close(); }
}, 90_000);
