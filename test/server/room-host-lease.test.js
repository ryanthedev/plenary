// The room host on the Store lease (p4-host): one path for a single node and a cluster. acquire/renew/release, the
// holder-only inbox, the takeover, the dead-holder window, the host deadline and the clean release.
// Postgres cases run when DATABASE_URL is set; the rest use SQLite files.
import { test, expect, afterAll, describe, jest } from "bun:test";
import { join } from "node:path";
import { SQL } from "bun";
import { roomHost, newHolder } from "../../server/room-host.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { postgresStore } from "../../server/store/postgres.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, tempDir, sleep, until, deferred } from "./helpers.js";
import { code } from "./store-contract.js";

afterAll(cleanup);

const T = "t-aaa", B = "b-one";
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const never = () => new Promise(() => {});
const CEILING_MS = 30_000;   // fires only when an awaited event never comes; the real waits are ~0.3 s
/** `p`, or a rejection after CEILING_MS; the timer is cleared either way. */
async function withCeiling(p, what) {
  let timer;
  try { return await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), CEILING_MS); })]); }
  finally { clearTimeout(timer); }
}

/** A gateway as the room host sees it over the bus: inbox messages out, `{ conn, data, close }` replies in. */
function fakeGateway(bus, id = "g-1") {
  const got = [], n = new Map();
  bus.subscribe(subjects.gateway(id), m => got.push({ conn: m.conn, close: m.close, msg: m.data ? JSON.parse(m.data) : null }));
  const send = (conn, client, msg) => { const k = (n.get(conn) ?? 0) + 1; n.set(conn, k); return bus.publish(subjects.inbox(T, B), { n: k, conn, gateway: id, user: "dev:ed", name: "ed", role: "editor", client, msg }); };
  return {
    got,
    of: conn => got.filter(m => m.conn === conn),
    hello: (conn, client) => send(conn, client, { t: "hello", v: PROTOCOL_VERSION, board: B, client }),
    op: (conn, client, k) => send(conn, client, { t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${k}`, k)] } }),
    welcome: conn => until(() => got.find(m => m.conn === conn && m.msg?.t === "welcome")?.msg, `${conn}'s welcome`, 5000),
    answer: (conn, ms) => until(() => got.find(m => m.conn === conn && (m.msg?.t === "welcome" || m.close))?.msg, `${conn}'s answer`, ms),
    ack: (conn, id) => until(() => got.find(m => m.conn === conn && m.msg?.t === "ack" && m.msg.id === id)?.msg, `ack ${id}`, 5000),
  };
}

/** A store whose lease and writes a test can stall: renew "ok" | "hang" | "null"; append "ok" | "hold" (kept in `held`). */
function stallable(store, timers) {
  // build: "hang" stalls getCheckpoint and read; reads: "hang" stalls read only; acquire and lease: "hang" never answer (acquires counts calls);
  // cpDelay and appendDelay (virtual ms, need `timers`) make getCheckpoint / append answer late.
  const s = { renew: "ok", append: "ok", held: [], renews: 0, build: "ok", reads: "ok", acquire: "ok", acquires: 0, lease: "ok", cpDelay: 0, appendDelay: 0, leaseDelay: 0 };
  const late = (ms, f) => new Promise(r => timers.setTimeout(r, ms)).then(f);
  s.store = {
    ...store,
    getCheckpoint: (...a) => (s.build === "hang" ? never() : s.cpDelay ? late(s.cpDelay, () => store.getCheckpoint(...a)) : store.getCheckpoint(...a)),
    read: (...a) => (s.build === "hang" || s.reads === "hang" ? never() : store.read(...a)),
    acquire: (...a) => { s.acquires++; return s.acquire === "hang" ? never() : store.acquire(...a); },
    lease: (...a) => (s.lease === "hang" ? never() : s.leaseDelay ? late(s.leaseDelay, () => store.lease(...a)) : store.lease(...a)),
    renew: (...a) => { s.renews++; return s.renew === "hang" ? never() : s.renew === "null" ? Promise.resolve(null) : store.renew(...a); },
    append: (...a) => { if (s.append === "hold") { s.held.push(a); return never(); } return s.appendDelay ? late(s.appendDelay, () => store.append(...a)) : store.append(...a); },
  };
  return s;
}

const sqliteMaker = () => {
  const path = join(tempDir(), "plenary.db");
  return { open: async () => sqliteStore({ path }), drop: async () => {} };
};
const pgUrl = process.env.DATABASE_URL;
let pgN = 0;
const pgMaker = () => {
  const schema = `pl_test_host_${process.pid}_${Date.now().toString(36)}_${++pgN}`;
  return { open: () => postgresStore({ url: pgUrl, schema, max: 2 }), drop: async () => { const a = new SQL({ url: pgUrl, max: 1 }); await a.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await a.close(); } };
};

import { virtualTime, settleWith } from "./virtual.js";
import { createLogger } from "../../server/log.js";

/**
 * A bus, a virtual clock and a SQLite Store that reads it, so the Store's lease expiry, the host's timers and its lease
 * clock agree and a test moves them all with V.advance(ms): a ttl costs no real milliseconds and no test measures the
 * machine. `store()` opens another handle on the same file (another host's).
 */
function vworld() {
  const bus = memoryBus(), V = virtualTime({ settle: settleWith(bus) });
  const path = join(tempDir(), "plenary.db");
  const store = () => sqliteStore({ path, now: V.now });
  const raw = store();
  const lines = [], log = createLogger({ write: l => lines.push(l), level: "debug" });
  const host = o => roomHost({ bus, log, timers: V.timers, monotonic: V.now, ...o });
  /** Why the host stopped a room ("room stopped: lease lost"), as it logged it. */
  const lostWhy = () => lines.map(l => JSON.parse(l)).filter(l => l.msg === "room stopped: lease lost").map(l => l.why);
  const vsleep = ms => new Promise(res => V.timers.setTimeout(res, ms));
  return { bus, V, raw, path, store, host, lostWhy, vsleep };
}

test("holder ids: unique per instance, an id the Store accepts, overridable", () => {
  const a = newHolder("Ryans-MacBook.local"), b = newHolder("Ryans-MacBook.local");
  expect(a).not.toBe(b);
  for (const h of [a, newHolder(""), newHolder(undefined), newHolder("x".repeat(200) + "!!")]) expect(h).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  expect(a.startsWith(`ryans-macbook-local-${process.pid}-`)).toBe(true);
  const bus = memoryBus();
  const h1 = roomHost({ store: {}, bus }), h2 = roomHost({ store: {}, bus }), h3 = roomHost({ store: {}, bus, holder: "h-test" });
  expect(h1.holder).not.toBe(h2.holder);
  expect(h3.holder).toBe("h-test");
  for (const h of [h1, h2, h3]) h.close();
});

test("two room hosts on one Store and one bus, writers on both gateways: one welcome per hello, no duplicate acks, one sequencer", async () => {
  // The p-audit F5 repro. heartbeatMs 100: the waiting host's silence rule (2 heartbeats) is exercised for ~1.5 s.
  const a = await rig({ host: { heartbeatMs: 100 } });
  const b = await rig({ dir: a.dir, registry: a.registry, ids: a.ids, wrapBus: () => a.bus, host: { heartbeatMs: 100 } });
  try {
    const socks = [];
    for (let i = 0; i < 4; i++) {
      const r = i % 2 ? b : a, s = await r.sock();
      s.send({ t: "hello", v: 1, token: tokenOf("editor" + i), board: a.ids.board, since: 0, client: "w" + i });
      await s.next(m => m.t === "welcome", "welcome", 5000);
      socks.push(s);
    }
    for (let k = 1; k <= 15; k++) {
      for (const [i, s] of socks.entries()) s.send({ t: "op", id: `w${i}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`w${i}-${k}`, k)] } });
      await sleep(100);
    }
    for (const [i, s] of socks.entries()) await s.next(m => m.t === "ack" && m.id === `w${i}:15`, "last ack", 5000);
    await sleep(300);
    for (const [i, s] of socks.entries()) {
      expect(s.msgs.filter(m => m.t === "welcome").length).toBe(1);
      const acks = s.msgs.filter(m => m.t === "ack").map(m => m.id);
      expect(acks).toEqual(Array.from({ length: 15 }, (_, k) => `w${i}:${k + 1}`));   // each once, in order
      expect(s.msgs.filter(m => m.t === "error")).toEqual([]);
      expect(s.closed).toBe(null);
    }
    // One sequencer: one host built the room; the other waits on the lease (and never served the inbox).
    const rooms = [a, b].map(r => r.server.rooms.stats());
    expect(rooms.map(x => x.rooms).sort()).toEqual([0, 1]);
    expect(rooms.map(x => x.waiting).sort()).toEqual([0, 1]);
    for (const r of [a, b]) expect(r.logs().filter(l => /room stopped/.test(l.msg))).toEqual([]);
    const log = await a.rawStore.read(a.ids.tenant, a.ids.board, 1, 1000);
    expect(log.map(e => e.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(new Set(log.map(e => e.id)).size).toBe(60);
  } finally { await b.stop(); await a.stop(); }
}, 20000);

for (const [name, maker] of [["sqlite", sqliteMaker], ["postgres", pgMaker]]) describe.skipIf(name === "postgres" && !pgUrl)(`takeover (${name})`, () => {
  test("holder A stops renewing (no release); B takes over after expiry; A's late append is fenced; every op A acked is in the log", async () => {
    const m = maker(), raw = await m.open(), rawB = await m.open(), bus = memoryBus();
    const sa = stallable(raw);
    // A's ttl (3 s) only sets how long B waits for the takeover; B's (30 s) keeps B's room alive through an event-loop stall (a host drops its room when
    // a stall outlasts 2/3 of its ttl), so a loaded machine can't take B's room away between its takeover and the c2 checks.
    const A = roomHost({ store: sa.store, bus, holder: "h-a", leaseTtlMs: 3_000, heartbeatMs: 100, appendTimeoutMs: 300 });
    const Bh = roomHost({ store: rawB, bus, holder: "h-b", leaseTtlMs: 30_000, heartbeatMs: 100 });
    try {
      await A.open(T, B);
      const eA = (await A.peek(T, B)).epoch;
      // B's takeover is awaited as an event, not polled against a budget: the room's build() publishes `{ ...heartbeat, opened: true }`
      // on the board's entries subject, so the first one with an epoch above A's is B's. The lease expires on the store's real clock
      // (~0.3 s after A's last renew, measured), so the ceilings only fire when the event never comes.
      const bOpened = deferred();
      const unsubOpened = bus.subscribe(subjects.entries(T, B), m => { if (m.opened && m.epoch > eA) bOpened.resolve(m); });
      await Bh.open(T, B);                                                   // held live by A: no room here
      expect(await Bh.peek(T, B)).toBe(null);
      expect(Bh.stats()).toEqual({ rooms: 0, waiting: 1 });
      const g = fakeGateway(bus);
      g.hello("c1", "a");
      expect(await g.welcome("c1")).toMatchObject({ seq: 0, room: { epoch: eA } });
      for (let k = 1; k <= 3; k++) { g.op("c1", "a", k); await g.ack("c1", `a:${k}`); }
      // A stalls: its renews hang and its next append is held (past the 4 s-style timeout, here 300 ms).
      sa.renew = "hang"; sa.append = "hold";
      g.op("c1", "a", 4);
      await until(() => g.of("c1").some(x => x.close === 1013), "c1 told unavailable", CEILING_MS);
      await withCeiling(bOpened.promise, "B's takeover");
      unsubOpened?.();
      expect(await Bh.peek(T, B)).not.toBe(null);
      const eB = (await Bh.peek(T, B)).epoch;
      expect(eB).toBeGreaterThan(eA);
      expect(await A.peek(T, B)).toBe(null);                                 // A stopped its room
      // A's write lands only now, after B acquired: fenced, and nothing of it is in the log.
      expect(sa.held.length).toBe(1);
      expect(await code(raw.append(...sa.held[0]))).toBe("fenced");
      const acked = g.got.filter(x => x.msg?.t === "ack").map(x => x.msg.id);
      expect(acked).toEqual(["a:1", "a:2", "a:3"]);
      expect((await rawB.read(T, B, 1, 100)).map(e => e.id)).toEqual(acked);
      // The client reconnects: B welcomes it with every acked op, and sequences on.
      g.hello("c2", "a");
      expect(await g.welcome("c2")).toMatchObject({ seq: 3, room: { epoch: eB } });
      g.op("c2", "a", 4);
      expect(await g.ack("c2", "a:4")).toEqual({ t: "ack", id: "a:4", seq: 4 });
      expect(g.got.filter(x => x.msg?.t === "welcome").length).toBe(2);     // one per hello, never one from each host
    } finally { await A.close(); await Bh.close(); await raw.close(); await rawB.close(); await bus.close(); await m.drop(); }
  }, 45000);

  test("clean restart: close checkpoints, settles its writes, releases; a new host opens the board with no wait", async () => {
    const m = maker(), raw = await m.open(), bus = memoryBus();
    const A = roomHost({ store: raw, bus, holder: "h-a", leaseTtlMs: 30_000 });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      for (let k = 1; k <= 3; k++) { g.op("c1", "a", k); await g.ack("c1", `a:${k}`); }
      await A.close();
      expect(await raw.lease(T, B)).toMatchObject({ holder: null, live: false });   // released
      expect((await raw.getCheckpoint(T, B))?.seq).toBe(3);                          // checkpointed before the release
      const C = roomHost({ store: raw, bus, leaseTtlMs: 30_000 });
      try {
        await C.open(T, B);                                                          // not after the 30 s ttl: the test's own 20 s limit fails a wait for it
        expect((await C.peek(T, B))?.durable).toBe(3);
        expect(C.stats()).toEqual({ rooms: 1, waiting: 0 });
      } finally { await C.close(); }
    } finally { await A.close(); await raw.close(); await bus.close(); await m.drop(); }
  }, 20000);
});

test("the dead-holder window: a writer's hello gets an answer within ttl + 3 s, and a reconnect after takeover is welcomed with every acked op", async () => {
  // A dies without a release (kill -9): its bus traffic and its renews stop. B starts after, and sees A's live lease.
  // Virtual time: "within ttl + 3 s" is counted on the clock the test moves.
  const { bus, V, raw, path, store, host } = vworld(), rawB = store();
  let dead = false;
  const deadBus = { ...bus, publish: (s, x) => (dead ? Promise.resolve() : bus.publish(s, x)), subscribe: (s, fn) => bus.subscribe(s, x => { if (!dead) fn(x); }) };
  const sa = stallable(raw);
  const ttl = 1_000;
  const A = host({ store: sa.store, bus: deadBus, holder: "h-a", leaseTtlMs: ttl, heartbeatMs: 200 });
  const Bh = host({ store: rawB, holder: "h-b", leaseTtlMs: ttl, heartbeatMs: 200 });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    for (let k = 1; k <= 3; k++) { g.op("c1", "a", k); await g.ack("c1", `a:${k}`); }
    dead = true; sa.renew = "hang";
    await Bh.open(T, B);
    expect(Bh.stats().waiting).toBe(1);                                      // A's lease is still live
    // The client's first hello in the window: answered (welcome or unavailable) within ttl + 3 s, never left hanging.
    const t0 = V.now();
    g.hello("c2", "a");
    const answered = c => g.got.find(m => m.conn === c && (m.msg?.t === "welcome" || m.close))?.msg;
    expect(await V.until(() => answered("c2"), ttl + 3_000)).not.toBe(null);
    const first = answered("c2");
    expect(first.t === "welcome" || (first.t === "error" && first.code === "unavailable")).toBe(true);
    // It reconnects (open again, as the gateway does, then hello) until welcomed: every acked op is there.
    let welcome = first.t === "welcome" ? first : null;
    for (let i = 3; !welcome; i++) {
      expect(V.now() - t0).toBeLessThanOrEqual(ttl + 3_000);
      await V.advance(100);
      await Bh.open(T, B);
      g.hello(`c${i}`, "a");
      expect(await V.until(() => answered(`c${i}`), ttl + 3_000)).not.toBe(null);
      const got = answered(`c${i}`);
      if (got.t === "welcome") welcome = got;
      else expect(got).toMatchObject({ t: "error", code: "unavailable" });
    }
    expect(V.now() - t0).toBeLessThanOrEqual(ttl + 3_000);
    expect(welcome.seq).toBe(3);
    expect(welcome.room.epoch).toBeGreaterThan((await rawB.lease(T, B)).epoch - 1);
    expect((await rawB.read(T, B, 1, 100)).map(e => e.id)).toEqual(["a:1", "a:2", "a:3"]);
  } finally { dead = false; await A.close(); await Bh.close(); await raw.close(); await rawB.close(); await bus.close(); }
}, 20000);

test("a live remote holder's board is never answered by the waiting host, however long it waits", async () => {
  const { bus, V, raw, host } = vworld();
  const A = host({ store: raw, holder: "h-a", leaseTtlMs: 600, heartbeatMs: 100 });
  const Bh = host({ store: raw, holder: "h-b", leaseTtlMs: 600, heartbeatMs: 100 });
  try {
    await A.open(T, B); await Bh.open(T, B);
    const g = fakeGateway(bus);
    for (let i = 0; i < 10; i++) { g.hello(`c${i}`, `x${i}`); await V.advance(150); }   // 1.5 s of virtual time: past 2 heartbeats many times, and two ttls
    await bus.flush(); await V.advance(100);
    expect(g.got.filter(x => x.msg?.t === "welcome").length).toBe(10);
    expect(g.got.filter(x => x.close || x.msg?.t === "error")).toEqual([]);
    expect(Bh.stats()).toEqual({ rooms: 0, waiting: 1 });                             // its attempts found A live each time
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 10000);

test("losing the lease stops the room without a release: a null renew, and a fenced write", async () => {
  for (const how of ["renew null", "fenced checkpoint"]) {
    const { bus, V, raw, host, lostWhy } = vworld();
    const sa = stallable(raw);
    // ttl 3 s: the host deadline is 2 s away, so a stop within 1 s is the null renew / the fence, not the deadline (and
    // the reason it logs says which).
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000 });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      g.op("c1", "a", 1); await g.ack("c1", "a:1");
      if (how === "renew null") sa.renew = "null";
      else {   // renews hang (the deadline is 2 s off), the board moves on, and the next write is fenced
        sa.renew = "hang";
        await raw.openEpoch(T, B); (await A.peek(T, B)).room.checkpoint();
      }
      const took = await V.until(() => g.of("c1").some(x => x.close === 1013), 1_000);
      expect(took).not.toBe(null);                                         // within 1 s of the 2 s deadline
      expect(lostWhy()).toEqual([how === "renew null" ? expect.stringMatching(/refused: the lease is gone/) : expect.stringMatching(/fenced/)]);
      expect(await A.peek(T, B)).toBe(null);
      const l = await raw.lease(T, B);
      if (how === "renew null") expect(l).toMatchObject({ holder: "h-a", live: true });    // never released on a fail
      await A.close();                                                                     // a lost lease isn't released at close either
      if (how === "renew null") expect((await raw.lease(T, B)).holder).toBe("h-a");
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }
}, 20000);

test("the host deadline: renews that never answer stop the room before the lease can lapse, by the lease clock (monotonic), not the rooms' clock", async () => {
  const { bus, V, raw, host, lostWhy } = vworld();
  const sa = stallable(raw);
  // The rooms' clock runs backwards a minute per call: a deadline judged on it would never come.
  let fake = 1e13;
  const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 900, now: () => (fake -= 60_000) });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    await V.advance(700);                                                  // two renews went through
    expect(sa.renews).toBeGreaterThanOrEqual(2);
    expect(await A.peek(T, B)).not.toBe(null);
    sa.renew = "hang";
    // Deadline = the last good renew's send time + ttl - ttl/3 (600 ms): the room stops, on the lease clock, before the
    // Store's lease (900 ms from that renew) lapses.
    const took = await V.until(() => g.of("c1").some(x => x.close === 1013), 900, 1);
    expect(took).not.toBe(null);
    expect(took).toBeLessThanOrEqual(600);
    expect(lostWhy()).toEqual([expect.stringMatching(/host deadline/)]);
    expect((await raw.lease(T, B)).live).toBe(true);                       // stopped before the lease lapsed
    expect(await A.peek(T, B)).toBe(null);
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10000);

test("renew starts before the rebuild: a rebuild longer than the ttl keeps the lease", async () => {
  const m = sqliteMaker(), raw = await m.open(), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-seed", 60_000);
  await raw.append(T, B, [{ seq: 1, board: B, tenant: T, stream: "board", op: { elements: [rect("x")] }, by: "u", id: "c:1", at: 0, rv: 1 }], 0, epoch);
  await raw.release(T, B, "h-seed", epoch);
  // The rebuild is held until the test lets it go; the host renews every ttl/3 (500 ms), so four renews (counted, not timed)
  // are 2 s of rebuild against a ttl of 1.5 s.
  let slow = true, renews = 0; const gate = deferred(), renewed = deferred();
  const store = { ...raw, renew: (...a) => { if (++renews >= 4) renewed.resolve(); return raw.renew(...a); }, read: async (...a) => { if (slow) { slow = false; await gate.promise; } return raw.read(...a); } };
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: 1_500 });   // renews every 500 ms; tolerates a 1 s event-loop stall
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: 1_500 });
  try {
    const opening = A.open(T, B);
    await withCeiling(renewed.promise, "four renews during the rebuild");                                                 // four renews in, still mid-rebuild: past the whole ttl
    expect(await raw.acquire(T, B, "h-b", 600)).toBe(null);               // still A's: it renewed while building
    gate.resolve(); await opening;
    expect((await A.peek(T, B))?.durable).toBe(1);
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 45000);   // above the 30 s CEILING_MS wait for the renews

// ---- Round 2 (p4-hostv): each verifier repro as a test ----

test("HIGH-1: a holder woken from a stall past its deadline serves nothing that queued meanwhile; the new holder's connections hear only it", async () => {
  // In-process stall: A's inbound bus traffic is queued and its lease clock (and the Store's) jumps past the ttl, while
  // its real timers (renew every 10 s, heartbeat 10 s) don't run: exactly what a SIGSTOP leaves behind.
  let off = 0, frozen = false;
  const queued = [], fromA = [];
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db"), now: () => Date.now() + off });
  const bus = memoryBus();
  const busA = {
    ...bus,
    publish: (s, m) => { if (s.startsWith("plen-gw.")) fromA.push(m); return bus.publish(s, m); },
    subscribe: (s, fn) => bus.subscribe(s, m => (frozen ? queued.push(() => fn(m)) : fn(m))),
  };
  const sa = stallable(raw);
  const opts = { leaseTtlMs: 30_000, heartbeatMs: 10_000, sweepMs: 10_000 };
  const A = roomHost({ store: sa.store, bus: busA, holder: "h-a", monotonic: () => performance.now() + off, ...opts });
  const Bh = roomHost({ store: raw, bus, holder: "h-b", ...opts });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    for (let k = 1; k <= 3; k++) { g.op("c1", "a", k); await g.ack("c1", `a:${k}`); }
    // The stall: A hears nothing and runs nothing; 40 s pass on every lease clock.
    frozen = true; sa.renew = "hang"; off += 40_000;
    await Bh.open(T, B);                                                     // the lease lapsed: B takes the board
    expect((await Bh.peek(T, B))?.epoch).toBe(2);
    // The first message A will see on waking is an op from a connection it never welcomed: only the inbox deadline check (onInbox) keeps A from
    // answering it (the Room would reply unavailable + 1013 to it); the reply-time check and the welcomed guard come too late for it.
    g.op("z9", "z", 1);
    g.hello("c2", "a"); expect(await g.welcome("c2")).toMatchObject({ seq: 3, room: { epoch: 2 } });
    g.hello("x1", "x"); await g.welcome("x1");
    g.op("x1", "x", 1); await g.ack("x1", "x:1");
    g.op("c2", "a", 4); await g.ack("c2", "a:4");
    const before = fromA.length;
    // A wakes: what queued is delivered before any of its timers run.
    frozen = false;
    for (const f of queued.splice(0)) f();
    // Positive control, then drain: A does answer its own welcomed connection (1013), and only then is "nothing else" asserted. (A.idle is a no-op
    // once A's slot is gone, so the c1 reply is the real barrier: a stray reply would be sent before or with it, in the same delivery.)
    await until(() => fromA.slice(before).some(m => m.conn === "c1" && m.close === 1013), "A telling its own c1 1013 once it woke");
    await A.idle(T, B); await Bh.idle(T, B); await bus.flush();
    const late = fromA.slice(before);
    expect(late.filter(m => m.conn === "c2" || m.conn === "x1" || m.conn === "z9")).toEqual([]);   // no welcome, ack or 1013 from the dead epoch
    expect(late.every(m => m.conn === "c1" && m.close === 1013)).toBe(true);    // only its own welcomed connection is told
    expect(await A.peek(T, B)).toBe(null);
    expect((await Bh.peek(T, B))?.conns).toBe(2);                                // B still serves c2 and x1
    expect(g.of("c2").filter(m => m.msg?.t === "welcome").length).toBe(1);
    expect(g.of("x1").filter(m => m.msg?.t === "welcome").length).toBe(1);
    expect((await raw.read(T, B, 1, 100)).map(e => e.id)).toEqual(["a:1", "a:2", "a:3", "x:1", "a:4"]);
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 15000);

test("HIGH-1 guard: a hello the host deadline catches between its inbox check and its welcome leaves a dead slot that tells only its welcomed connections 1013", async () => {
  // The lease clock is read once by the inbox check and once before the welcome is sent: it is made to jump past the deadline between those two reads,
  // so c2 is a connection the slot holds but never welcomed. fail() must tell c1 (welcomed) and leave c2 to the new holder.
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  let calls = 0, tripAt = Infinity;
  const lines = [], log = createLogger({ write: l => lines.push(l), level: "debug" });
  const A = roomHost({ store: raw, bus, log, holder: "h-a", leaseTtlMs: 30_000, monotonic: () => { calls++; return performance.now() + (calls >= tripAt ? 60_000 : 0); } });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    tripAt = calls + 2;                                 // the next hello: its inbox check reads clean, its welcome reads past the deadline
    g.hello("c2", "b");
    await until(() => g.of("c1").some(x => x.close === 1013), "the dead slot telling its welcomed c1 1013");
    await bus.flush();
    // The jump must have landed on the reply-time read, not on the inbox check (which would drop the hello before c2 is ever held, leaving the
    // welcomed guard unexercised): a refactor that adds or removes a clock read between the two fails here, loudly, instead of silently dropping coverage.
    expect(lines.map(l => JSON.parse(l)).filter(l => l.msg === "room stopped: lease lost").map(l => l.why)).toEqual(["the host deadline passed before a reply"]);
    expect(g.of("c1").filter(x => x.close === 1013).length).toBe(1);
    expect(g.of("c2")).toEqual([]);                                          // not welcomed, not told: the new holder (or a watcher) answers it
    expect(await A.peek(T, B)).toBe(null);
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10000);

test("MEDIUM-1 (repro C): the holder dies right after a renew; a watcher takes over within ttl + ttl/3 + 500 ms, not 2 ttl", async () => {
  const { V, raw, host, bus } = vworld();
  const ttl = 2_000;
  await raw.acquire(T, B, "h-dead", ttl);
  const Bh = host({ store: raw, holder: "h-b", leaseTtlMs: ttl, heartbeatMs: 100 });
  try {
    await Bh.open(T, B);
    expect(Bh.stats().waiting).toBe(1);
    // Nothing heartbeats, so B goes "silent" at ~200 ms and attempts then: the lease is live. The holder's last renew
    // lands at 300 ms, so it expires just after the next attempt a whole ttl would bring (200 + ttl + margin): only
    // an attempt armed for the Store's remainingMs (then every ttl/3) takes the board near its expiry. All virtual.
    await V.advance(300);
    const l = await raw.lease(T, B);
    expect(await raw.renew(T, B, "h-dead", l.epoch, ttl)).not.toBe(null);
    const took = await V.until(async () => (await Bh.peek(T, B)) !== null, 4 * ttl, 5);
    expect(took).not.toBe(null);
    expect(took).toBeLessThanOrEqual(ttl + ttl / 3 + 500);
  } finally { await Bh.close(); await raw.close(); await bus.close(); }
}, 15000);

test("L2 (repro B): a clean release is taken by a watcher already in place within one ttl/3 (here: at once, on the release)", async () => {
  // ttl 9 s, heartbeat 2 s: the silence rule (4 s) and the ttl/3 retry (3 s) are both too slow to pass this; only
  // the holder's `released` message is. Counted in virtual time: no timer runs between the close and the takeover.
  const { V, raw, host, bus } = vworld();
  const ttl = 9_000;
  const A = host({ store: raw, holder: "h-a", leaseTtlMs: ttl });
  const Bh = host({ store: raw, holder: "h-b", leaseTtlMs: ttl });
  try {
    await A.open(T, B); await Bh.open(T, B);
    await V.advance(300);
    const closing = A.close();                                               // a rolling deploy: clean, released
    const took = await V.until(async () => (await Bh.peek(T, B)) !== null, 1_000, 5);
    await closing;
    expect(took).not.toBe(null);                                             // within 1 s of virtual time, far short of ttl/3 = 3 s
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 15000);

test("MEDIUM-2 (repro A): a hello forwarded while the holder is still building is answered (1013), and the retry is welcomed", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  // The build is held by a gate the test opens once the hello is in: no guessed build time.
  let slow = true; const gate = deferred();
  const slowStore = { ...raw, read: async (...a) => { if (slow) { slow = false; await gate.promise; } return raw.read(...a); } };
  const A = roomHost({ store: slowStore, bus, holder: "h-a", leaseTtlMs: 10_000 });   // default heartbeat 2 s
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: 10_000 });
  try {
    const opening = A.open(T, B);
    await until(() => !slow, "A's build to be under way", 5_000);
    await Bh.open(T, B);
    expect(Bh.stats().waiting).toBe(1);
    const g = fakeGateway(bus);
    g.hello("c1", "a");                                                      // mid-build: A's inbox isn't served yet
    await bus.flush();
    expect(g.of("c1")).toEqual([]);                                          // nobody answers while the build is held
    gate.resolve(); await opening;
    const first = await g.answer("c1", 10_000);                              // answered by A's build finishing (1013), not left to the gateway's own 10 s
    expect(first).toMatchObject({ t: "error", code: "unavailable" });
    g.hello("c2", "a");
    expect(await g.welcome("c2")).toMatchObject({ seq: 0 });
    expect(g.of("c2").filter(m => m.close).length).toBe(0);
  } finally { await A.close(); await Bh.close(); await raw.close(); await bus.close(); }
}, 15000);

test("MEDIUM-3 (repro F): a renew that never settles is timed out and retried; a Store that stays hung stops the room at the deadline", async () => {
  const { bus, V, raw, host } = vworld();
  let hang = "no", renews = 0;
  const store = { ...raw, renew: (...a) => { renews++; if (hang === "once") { hang = "no"; return never(); } if (hang === "always") return never(); return raw.renew(...a); } };
  const A = host({ store, holder: "h-a", leaseTtlMs: 900 });
  try {
    await A.open(T, B);
    await V.advance(400);
    hang = "once"; const r0 = renews;
    await V.advance(1_500);
    expect(renews - r0).toBeGreaterThanOrEqual(3);                          // the hung one, then fresh ones each tick
    expect(await A.peek(T, B)).not.toBe(null);                               // never past the deadline
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    hang = "always"; const r1 = renews;
    const took = await V.until(() => g.of("c1").some(x => x.close === 1013), 900, 1);
    expect(took).not.toBe(null);                                             // stopped at the deadline (600 ms of the 900 ms ttl)
    expect(took).toBeLessThanOrEqual(600);
    expect((await raw.lease(T, B)).live).toBe(true);                         // before the Store's lease lapsed
    expect(renews - r1).toBeGreaterThanOrEqual(1);
    expect((await raw.lease(T, B)).holder).toBe("h-a");                     // not released
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10000);

test("L1 (repro G): the host deadline counts from the renew's send time (slow renews, then they hang)", async () => {
  const { bus, V, raw, host, vsleep } = vworld();
  let mode = "slow", lastSend = 0;
  const store = { ...raw, renew: async (...a) => {
    if (mode === "hang") return never();
    lastSend = V.now(); await vsleep(250); return raw.renew(...a);
  } };
  // ttl 1.8 s: renew every 600 ms, each bounded at 300 ms (so these 250 ms renews succeed); deadline = last good
  // send + 1,200. Judged from the receive time it would be 250 ms later.
  const ttl = 1_800;
  const A = host({ store, holder: "h-a", leaseTtlMs: ttl });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    await V.advance(1_500);
    await V.until(() => V.now() - lastSend > 260, 2_000, 5);                 // the in-flight renew landed
    const sendOfLastGood = lastSend;
    mode = "hang";
    expect(await V.until(() => g.of("c1").some(x => x.close === 1013), 4_000, 1)).not.toBe(null);
    expect(V.now() - sendOfLastGood).toBeLessThanOrEqual(ttl - 600 + 5);     // 1,200 from the send, not 1,450 from the receipt
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10000);

test("L3 (repro H): an event-loop stall past the deadline stops the room; a renew after that doesn't revive it", async () => {
  // The stall is on the lease's own clock (`monotonic` jumps `ms`, as it would over a blocked loop, without blocking
  // this process for 2 s): the overdue renew tick finds the deadline (ttl - ttl/3 = 600 ms after the last good renew) gone.
  for (const ms of [700, 1500]) {
    const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
    let off = 0;
    const A = roomHost({ store: raw, bus, holder: "h-a", leaseTtlMs: 900, monotonic: () => performance.now() + off });
    try {
      await A.open(T, B); await sleep(350);
      off += ms;
      await until(async () => (await A.peek(T, B)) === null, "the overdue tick to stop the room", 5_000);
      expect(await A.peek(T, B)).toBe(null);
      await A.open(T, B);                                                    // only a new acquire reopens it
      expect((await A.peek(T, B))?.epoch).toBe(2);
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }
}, 10000);

test("L4: close() settles an append in flight before it releases the lease", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  let gate = null, order = [], inAppend = false;
  const store = { ...raw,
    append: async (...a) => { if (gate) { inAppend = true; await gate; } const r = await raw.append(...a); order.push("append landed"); return r; },
    release: async (...a) => { order.push("release"); return raw.release(...a); } };
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: 30_000 });
  try {
    await A.open(T, B);
    const g = fakeGateway(bus);
    g.hello("c1", "a"); await g.welcome("c1");
    let open; gate = new Promise(r => { open = r; });
    g.op("c1", "a", 1); await bus.flush();
    await until(() => inAppend, "the op's append to be in flight");
    // close() is suspended at its wait on the append once it has stopped listening (unsub, then dead = true, then it waits on the writes): a state,
    // not a delay. Fake timers make "no timer cuts the wait short" checkable: a close() that skipped the wait, or gave up after any timeout
    // (30 ms, a minute), has released by the time a day of timers has run. Bun.sleep(0) hangs under fake timers, so the polls use microtasks.
    let closing;
    jest.useFakeTimers();
    try {
      closing = A.close();
      for (let i = 0; i < 10_000 && bus.subscriberCount(subjects.inbox(T, B)) !== 0; i++) await null;
      expect(bus.subscriberCount(subjects.inbox(T, B))).toBe(0);               // close() reached its wait
      jest.advanceTimersByTime(24 * 3_600_000);
      for (let i = 0; i < 100; i++) await null;
      expect(order).toEqual([]);                                               // still waiting on the append
    } finally { jest.useRealTimers(); }
    open();
    await until(() => order.includes("release"), "the release after the append settled");
    await closing;
    expect(order).toEqual(["append landed", "release"]);
    expect((await raw.read(T, B, 1, 10)).map(e => e.id)).toEqual(["a:1"]);
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10000);

test("L5: a build that fails for a reason other than the lease stops renewing and releases the lease", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  let broken = true;
  const store = { ...raw, getCheckpoint: async (...a) => { if (broken) throw new Error("disk read error"); return raw.getCheckpoint(...a); } };
  const A = roomHost({ store, bus, holder: "h-a", leaseTtlMs: 30_000 });
  try {
    expect(await code(A.open(T, B))).not.toBe("resolved");
    await until(async () => (await raw.lease(T, B))?.holder === null, "released", 2_000);
    expect((await raw.acquire(T, B, "h-b", 1_000))?.epoch).toBe(2);       // another host takes it with no wait
  } finally { await A.close(); await raw.close(); await bus.close(); }
}, 10000);

test("L7: past 1,000 held hellos on a watched board, the extra ones are answered unavailable at once", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  await raw.acquire(T, B, "h-dead", 30_000);                               // a holder that is gone: nothing heartbeats
  const Bh = roomHost({ store: raw, bus, holder: "h-b", leaseTtlMs: 30_000, heartbeatMs: 200 });   // the silence rule is 2 heartbeats
  try {
    await Bh.open(T, B);
    const g = fakeGateway(bus);
    for (let i = 0; i < 1_005; i++) g.hello(`c${i}`, `x${i}`);
    await bus.flush();
    await until(() => g.got.filter(m => m.close === 1013).length === 1_005, "the held ones at the silence", 15_000);
    // The five over the cap are answered at once, the held ones only at the silence: so they come first, in the order sent (an order, not a delay).
    const order = g.got.filter(m => m.close === 1013).map(m => m.conn);
    expect(order.slice(0, 5)).toEqual(["c1000", "c1001", "c1002", "c1003", "c1004"]);
  } finally { await Bh.close(); await raw.close(); await bus.close(); }
}, 30000);   // exceeds the inner waits (15 s) so the named failure surfaces, not bun's generic timeout

test("R2-L1: `welcomed` shrinks with `conns` (close notices, a listing, the sweep); a lost lease still tells only welcomed live connections", async () => {
  const bus = memoryBus(), st = stallable(sqliteStore({ path: join(tempDir(), "plenary.db") }));
  const host = roomHost({ store: st.store, bus, leaseTtlMs: 6_000, sweepMs: 50 });   // renews every 2 s, deadline 4 s: the 2,000-hello loops can't stall it out
  const g = fakeGateway(bus);
  try {
    await host.open(T, B);
    const conns = Array.from({ length: 2000 }, (_, i) => `c-${i}`);
    for (const c of conns) g.hello(c, "k" + c);
    await until(() => new Set(g.got.filter(m => m.msg?.t === "welcome").map(m => m.conn)).size === 2000, "2,000 welcomes", 20000);
    // 1,000 close notices, then a listing that names only 500 of the other 1,000 (the rest are closed by it).
    for (const c of conns.slice(0, 1000)) await bus.publish(subjects.inbox(T, B), { n: 2, conn: c, gateway: "g-1", closed: true });
    const live = conns.slice(1000, 1500);
    await bus.publish(subjects.inbox(T, B), { gateway: "g-1", conns: live });
    await host.idle(T, B);
    await until(async () => { const p = await host.peek(T, B); return p.conns === 500 && p.welcomed === 500; }, "the sweep to drop the closed connections", 15_000);
    const p = await host.peek(T, B);
    expect([p.conns, p.welcomed]).toEqual([500, 500]);
    // The lease is lost: 1013 goes to exactly the 500 welcomed live connections, nobody else.
    const before = g.got.length;
    st.renew = "null";
    await until(() => g.got.slice(before).filter(m => m.close === 1013).length >= 500, "the 1013s", 10_000);   // the next renew tick (<= 2 s) finds the null renew
    await host.idle(T, B); await bus.flush();   // everything the lost lease sends is delivered before the exact-set check
    expect(g.got.slice(before).filter(m => m.close === 1013).map(m => m.conn).sort()).toEqual([...live].sort());
  } finally { await host.close(); }
}, 60000);   // exceeds the inner waits (20 s + 15 s + 5 s) so the named failure surfaces, not bun's generic timeout

// ---- e1-tests-v3 MEDIUM-1: close() after a failed build ----

test("N1 close() while a failed build's release is still in flight announces `released` once", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const gate = deferred(), seen = [];
  const store = { ...raw, async getCheckpoint() { throw new Error("store down"); }, release: async (...a) => { await gate.promise; return raw.release(...a); } };
  bus.subscribe(subjects.entries("t-cf", "b-cf"), m => { if (m?.released) seen.push(m); });
  const h = roomHost({ store, bus, leaseTtlMs: 60_000, heartbeatMs: 60_000 });
  try {
    await expect(h.open("t-cf", "b-cf")).rejects.toThrow("store down");     // its release is parked on the gate
    const closing = h.close();
    gate.resolve();
    await closing; await bus.flush();
    expect(seen).toEqual([{ seq: 0, epoch: 1, cp: 0, released: true }]);
  } finally { await bus.close(); await raw.close(); }
});

test("N1b a failed build whose release itself failed: close() releases again and announces `released` once", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus(), seen = [];
  let releases = 0;
  const store = { ...raw, async getCheckpoint() { throw new Error("store down"); }, release: async (...a) => { if (releases++ === 0) throw new Error("release down"); return raw.release(...a); } };
  bus.subscribe(subjects.entries("t-cf", "b-cf"), m => { if (m?.released) seen.push(m); });
  const h = roomHost({ store, bus, leaseTtlMs: 60_000, heartbeatMs: 60_000 });
  try {
    await expect(h.open("t-cf", "b-cf")).rejects.toThrow("store down");     // its own release fails: nothing announced yet
    await bus.flush();
    expect(seen).toEqual([]);
    await h.close(); await bus.flush();
    expect(releases).toBe(2);
    expect(seen).toEqual([{ seq: 0, epoch: 1, cp: 0, released: true }]);
    expect((await raw.lease("t-cf", "b-cf"))?.live).toBe(false);
  } finally { await bus.close(); await raw.close(); }
});

test("close() after a board's build failed: the lease is released once, `released` is published (cp 0), and nothing is logged as a failed release", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus(), lines = [];
  const log = createLogger({ write: l => lines.push(JSON.parse(l)), level: "debug" });
  // The build reads the latest checkpoint first: a Store error there fails the build before any Room exists.
  const store = { ...raw, async getCheckpoint() { throw new Error("store down"); } };
  const seen = [];
  bus.subscribe(subjects.entries("t-cf", "b-cf"), m => { if (m?.released) seen.push(m); });
  const h = roomHost({ store, bus, log, leaseTtlMs: 60_000, heartbeatMs: 60_000 });
  try {
    await expect(h.open("t-cf", "b-cf")).rejects.toThrow("store down");
    await h.close();
    await bus.flush();
    expect(seen).toEqual([{ seq: 0, epoch: 1, cp: 0, released: true }]);
    expect(lines.filter(l => l.level === "warn" || l.level === "error").map(l => l.msg)).toEqual(["room failed to open"]);   // the build's own error only
    expect((await raw.lease("t-cf", "b-cf"))?.live).toBe(false);
  } finally { await bus.close(); await raw.close(); }
});

// ---- the stuck-host watchdog (#65, PROTOCOL.md § Recovery "Stuck host") ----

describe("stuck host (#65)", () => {
  const opened = (V, p) => { let r; p.then(v => (r = { v }), e => (r = { e })); return async ms => { await V.advance(ms); return r; }; };

  test("DW-65.1/.2/.3 (c) sequencing stalled while renews succeed: the progress watchdog stops the room within stuckMs + heartbeat, B takes over, nothing acked is lost, A's late writes are fenced", async () => {
    const { bus, V, raw, store, host, lostWhy } = vworld(), rawB = store();
    const sa = stallable(raw);
    // appendTimeoutMs is huge and the rooms' `now` is frozen: only the watchdog can end this (the append's own 4 s timeout is out of play).
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, heartbeatMs: 200, appendTimeoutMs: 600_000, stuckMs: 3_000, now: () => 5 });
    const Bh = host({ store: rawB, holder: "h-b", leaseTtlMs: 3_000, heartbeatMs: 200 });
    try {
      await A.open(T, B); await Bh.open(T, B);
      expect(Bh.stats().waiting).toBe(1);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      for (let k = 1; k <= 2; k++) { g.op("c1", "a", k); await g.ack("c1", `a:${k}`); }
      const epochA = (await rawB.lease(T, B)).epoch;
      sa.append = "hold";
      const t0 = V.now();
      g.op("c1", "a", 3);                                                      // accepted, appended nowhere: never acked
      await bus.flush();
      const renewsBefore = sa.renews;
      expect(await V.until(() => lostWhy().length > 0, 10_000, 50)).not.toBe(null);
      const stoppedAt = V.now() - t0;
      expect(stoppedAt).toBeGreaterThanOrEqual(3_000 - 200);                   // not before stuckMs less one stale heartbeat
      expect(stoppedAt).toBeLessThanOrEqual(3_000 + 200 + 50);                 // the documented bound: stuckMs + heartbeatMs
      expect(lostWhy()[0]).toMatch(/^no progress/);
      expect(sa.renews).toBeGreaterThan(renewsBefore);                         // the lease was being renewed all along: only the watchdog could end it
      expect(g.of("c1").some(m => m.close === 1013)).toBe(true);               // its welcomed writer is told to reconnect
      expect(g.of("c1").some(m => m.msg?.t === "ack" && m.msg.id === "a:3")).toBe(false);
      // B takes the board once the lease lapses (renewing stopped with the room): at most ttl after the stop.
      const took = await V.until(async () => (await rawB.lease(T, B)).holder === "h-b", 3_000 + 600, 50);
      expect(took).not.toBe(null);
      expect((await rawB.lease(T, B)).epoch).toBeGreaterThan(epochA);
      // The client reconnects and resends the unacked op: acked once, no duplicate in the log.
      let rooms = null;
      await V.until(async () => (rooms = await Bh.peek(T, B)) !== null, 2_000, 50);
      g.hello("c2", "a"); expect(await g.welcome("c2")).toMatchObject({ seq: 2 });
      g.op("c2", "a", 3); expect(await g.ack("c2", "a:3")).toMatchObject({ seq: 3 });
      // A wakes and its hung writes finally reach the Store: both are fenced, nothing is written.
      const [entries, expectSeq, epoch] = [sa.held[0][2], sa.held[0][3], sa.held[0][4]];
      expect(epoch).toBe(epochA);
      expect(await raw.append(T, B, entries, expectSeq, epoch).catch(e => e.code)).toBe("fenced");
      expect(await raw.putCheckpoint(T, B, { seq: 2, board: B, tenant: T, state: {} }, epoch).catch(e => e.code)).toBe("fenced");
      expect((await rawB.read(T, B, 1, 100)).map(e => e.id)).toEqual(["a:1", "a:2", "a:3"]);
    } finally { await A.close(); await Bh.close(); await raw.close(); await rawB.close(); await bus.close(); }
  }, 20000);

  test("an idle room and a room whose appends land are never stuck (no false positive), however long they live", async () => {
    const { bus, V, raw, host, lostWhy } = vworld();
    const A = host({ store: raw, holder: "h-a", leaseTtlMs: 3_000, heartbeatMs: 200, stuckMs: 1_000 });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      await V.advance(30_000);                                                  // idle: 30 virtual seconds, 30 stuckMs
      for (let k = 1; k <= 5; k++) { g.op("c1", "a", k); await g.ack("c1", `a:${k}`); await V.advance(900); }
      expect(lostWhy()).toEqual([]);
      expect((await A.peek(T, B)).durable).toBe(5);
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("DW-65.1 (b2) a Store read of the build never answers while renews succeed: open fails within storeTimeoutMs and the lease is released at once, so a waiting host takes it", async () => {
    const { bus, V, raw, store, host } = vworld(), rawB = store();
    const sa = stallable(raw);
    sa.build = "hang";
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, storeTimeoutMs: 2_000 });
    const Bh = host({ store: rawB, holder: "h-b", leaseTtlMs: 3_000 });
    try {
      const wait = opened(V, A.open(T, B));
      expect(await wait(0)).toBeUndefined(); expect(await wait(1_500)).toBeUndefined();                                // still waiting, and renewing meanwhile
      expect(sa.renews).toBeGreaterThan(0);
      expect((await rawB.lease(T, B)).holder).toBe("h-a");
      const r = await wait(600);                                                 // 2.1 s: the bound has passed
      expect(r.e?.code).toBe("timeout");
      await V.advance(10);
      expect((await rawB.lease(T, B)).live).toBe(false);                        // released, not waiting out the ttl
      expect(await Bh.open(T, B)).toBe("held");
      expect(sa.renews).toBeGreaterThan(0);
    } finally { await A.close(); await Bh.close(); await raw.close(); await rawB.close(); await bus.close(); }
  }, 20000);

  test("DW-65.1 (b2) an acquire that never answers fails the open within storeTimeoutMs; the next open works", async () => {
    const { bus, V, raw, host } = vworld();
    const sa = stallable(raw);
    sa.acquire = "hang";
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, storeTimeoutMs: 1_000 });
    try {
      const wait = opened(V, A.open(T, B));
      expect(await wait(900)).toBeUndefined();
      expect((await wait(200)).e?.code).toBe("timeout");
      sa.acquire = "ok";
      const p = A.open(T, B); await V.advance(10);
      expect(await p).toBe("held");
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("H1 a stuck host does not retake its own board: A reopens on every writer hello during the cooldown and never re-acquires; B holds the lease within the bound at epoch + 1", async () => {
    const { bus, V, raw, store, host, lostWhy } = vworld(), rawB = store();
    const sa = stallable(raw, V.timers);
    const ttl = 3_000, margin = 60, renewEvery = 1_000;
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: ttl, heartbeatMs: 200, appendTimeoutMs: 600_000, stuckMs: 3_000, now: () => 5 });
    const Bh = host({ store: rawB, holder: "h-b", leaseTtlMs: ttl, heartbeatMs: 200 });
    try {
      await A.open(T, B); await Bh.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      g.op("c1", "a", 1); await g.ack("c1", "a:1");
      const epochA = (await rawB.lease(T, B)).epoch;
      sa.append = "hold"; g.op("c1", "a", 2); await bus.flush();
      expect(await V.until(() => lostWhy().length > 0, 10_000, 50)).not.toBe(null);
      const stopAt = V.now(), acquires = sa.acquires;
      let took = null;
      for (; V.now() - stopAt <= ttl + margin + renewEvery + 100 && took === null; await V.advance(100)) {
        expect(await A.open(T, B)).toBe("watching");                              // the gateway's open on a writer's reconnect
        expect(sa.acquires).toBe(acquires);                                      // never a claim: not even once the lease lapsed
        if ((await rawB.lease(T, B)).holder === "h-b") took = V.now() - stopAt;
      }
      expect(took).not.toBe(null);
      expect(took).toBeLessThanOrEqual(ttl + margin + renewEvery);               // the documented bound
      expect((await rawB.lease(T, B)).epoch).toBe(epochA + 1);                  // one takeover, no ping-pong
      await V.advance(200);
      expect(await A.open(T, B)).toBe("watching");
      expect(sa.acquires).toBe(acquires);
      expect(await Bh.peek(T, B)).not.toBe(null);
    } finally { await A.close(); await Bh.close(); await raw.close(); await rawB.close(); await bus.close(); }
  }, 20000);

  test("H1 an append timeout starts the same cooldown (the pre-existing b1 path)", async () => {
    const { bus, V, raw, host } = vworld();
    const sa = stallable(raw, V.timers);
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, heartbeatMs: 200, appendTimeoutMs: 500 });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      sa.append = "hold"; g.op("c1", "a", 1); await bus.flush();
      await V.advance(600);
      const acquires = sa.acquires;
      expect(await A.open(T, B)).toBe("watching");
      expect(sa.acquires).toBe(acquires);
      sa.append = "ok";
      await V.advance(3_100);                                                    // the cooldown (ttl + margin) is over: the lease lapsed and nobody took it
      await V.advance(1_000);
      expect(await A.open(T, B)).toBe("held");
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("H1 a build that timed out starts the cooldown too: the next open watches instead of claiming", async () => {
    const { bus, V, raw, host } = vworld();
    const sa = stallable(raw, V.timers);
    sa.build = "hang";
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, storeTimeoutMs: 500 });
    try {
      const wait = opened(V, A.open(T, B));
      await wait(0);
      expect((await wait(600)).e?.code).toBe("timeout");
      sa.build = "ok";
      const acquires = sa.acquires;
      expect(await A.open(T, B)).toBe("watching");
      expect(sa.acquires).toBe(acquires);
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("M1 a failed build publishes released: a host already watching takes the board at once, not at its next poll", async () => {
    const { bus, V, raw, store, host } = vworld(), rawB = store();
    const sa = stallable(raw, V.timers);
    sa.build = "hang";
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, storeTimeoutMs: 1_500, heartbeatMs: 400 });
    const Bh = host({ store: rawB, holder: "h-b", leaseTtlMs: 3_000, heartbeatMs: 400 });
    try {
      const wait = opened(V, A.open(T, B));
      await wait(0);
      expect(await Bh.open(T, B)).toBe("watching");                              // B watches A's live lease; its polls are at 1,000 and 2,000
      const t0 = V.now();
      const took = await V.until(async () => (await rawB.lease(T, B)).holder === "h-b", 3_000, 10);
      expect(took).not.toBe(null);
      expect(took).toBeLessThanOrEqual(1_500 + 100);                             // the build's bound + a Store round trip, not the 2,000 poll
      expect(V.now() - t0).toBeLessThan(2_000);
    } finally { await A.close(); await Bh.close(); await raw.close(); await rawB.close(); await bus.close(); }
  }, 20000);

  test("M2 close() settles while an append hangs (the timed promise is tracked), then releases", async () => {
    const { bus, V, raw, host } = vworld();
    const sa = stallable(raw, V.timers);
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, appendTimeoutMs: 1_000 });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      sa.append = "hold"; g.op("c1", "a", 1); await bus.flush();
      let done = false; const c = A.close().then(() => { done = true; });
      await V.advance(500); expect(done).toBe(false);                            // still waiting on the write, within its bound
      expect(await V.until(() => done, 3_000, 100)).not.toBe(null);
      await c;
    } finally { await raw.close(); await bus.close(); }
  }, 20000);

  test("L1 a read page that never answers (the checkpoint answered) fails the open within storeTimeoutMs", async () => {
    const { bus, V, raw, host } = vworld();
    const sa = stallable(raw, V.timers);
    sa.reads = "hang";
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, storeTimeoutMs: 1_000 });
    try {
      const wait = opened(V, A.open(T, B));
      await wait(0);
      expect(await wait(900)).toBeUndefined();
      expect((await wait(200)).e?.code).toBe("timeout");
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("L1 a lease read that never answers fails the claim within storeTimeoutMs, and a waiting host's attempt retries after it", async () => {
    const { bus, V, raw, store, host } = vworld(), rawX = store();
    const sa = stallable(raw, V.timers);
    await rawX.acquire(T, B, "h-x", 3_000);                                       // someone else's live lease: A's acquire is refused and it reads the lease
    sa.lease = "hang";
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, storeTimeoutMs: 500 });
    try {
      const wait = opened(V, A.open(T, B));
      await wait(0);
      expect(await wait(400)).toBeUndefined();
      expect((await wait(200)).e?.code).toBe("timeout");
      sa.lease = "ok";
      expect(await A.open(T, B)).toBe("watching");                               // now it watches h-x's lease
      sa.lease = "hang";                                                          // the watch's attempt (at the lease's end) reads and hangs
      await V.advance(3_300);
      sa.lease = "ok";                                                            // h-x never renewed: the lease lapsed; the next attempt takes the board
      expect(await V.until(() => A.stats().rooms === 1, 3_000, 50)).not.toBe(null);
    } finally { await A.close(); await raw.close(); await rawX.close(); await bus.close(); }
  }, 20000);

  test("L3 an op in flight right after a slow build is not a stall: the watchdog's clock starts when the room does", async () => {
    const { bus, V, raw, host, lostWhy } = vworld();
    const sa = stallable(raw, V.timers);
    sa.cpDelay = 3_050;                                                           // an empty board whose build takes 3 x stuckMs, ending between two beats (every 200 ms)
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: 3_000, heartbeatMs: 200, stuckMs: 1_000 });
    try {
      const wait = opened(V, A.open(T, B));
      await wait(0);
      let r; for (let i = 0; i < 400 && !r; i++) r = await wait(10);                 // 10 ms steps: stop right when the open resolves, before the next beat
      expect(r.v).toBe("held");
      sa.cpDelay = 0;
      const g = fakeGateway(bus);
      g.hello("c1", "a"); await g.welcome("c1");
      sa.appendDelay = 300;                                                      // slower than a beat, faster than stuckMs
      g.op("c1", "a", 1); await bus.flush();
      await V.advance(1_000);
      await g.ack("c1", "a:1");
      expect(lostWhy()).toEqual([]);
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("a cooldown that ends while the watch's own attempt is running: that attempt reruns once when it finishes, so the retake is not left to the ttl/3 poll", async () => {
    const { bus, V, raw, host, lostWhy } = vworld();
    const sa = stallable(raw, V.timers);
    const ttl = 9_000;
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: ttl, heartbeatMs: 200, appendTimeoutMs: 600_000, stuckMs: 3_000, now: () => 5 });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c0", "a"); await g.welcome("c0");
      sa.append = "hold"; g.op("c0", "a", 1); await bus.flush();
      expect(await V.until(() => lostWhy().length > 0, 10_000, 50)).not.toBe(null);
      sa.append = "ok";
      const stopAt = V.now(), epoch = (await raw.lease(T, B)).epoch;
      expect(await A.open(T, B)).toBe("watching");                               // the cooldown (9,180 ms) is on: a watch starts
      await V.advance(9_100 - (V.now() - stopAt));
      sa.leaseDelay = 400;                                                        // the next attempt's lease read is slow: it is still running when the cooldown ends
      await bus.publish(subjects.entries(T, B), { seq: 0, epoch: epoch + 1, cp: 0, released: true });   // wakes the watch's attempt (the Store still decides)
      await V.advance(100);                                                       // 9,200 ms: the cooldown is over, the attempt is mid-read
      expect(A.stats().rooms).toBe(0);
      expect(await A.open(T, B)).toBe("watching");                                // finds the cooldown over and the attempt running: marks a rerun
      sa.leaseDelay = 0;
      expect(await V.until(() => A.stats().rooms === 1, 1_000, 50)).not.toBe(null);   // well inside the ttl/3 (3,000 ms) poll
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  for (const how of ["the progress watchdog", "an append timeout"]) test(`L1 single node, ${how} stops the room: a writer's hello every 500 ms is served within the cooldown (ttl + margin) + two hello intervals`, async () => {
    const { bus, V, raw, host, lostWhy } = vworld();
    const sa = stallable(raw, V.timers);
    const ttl = 9_000, margin = 180, watchdog = how === "the progress watchdog";   // renewEvery 3,000: the watch's own poll would add up to 3 s
    const A = host({ store: sa.store, holder: "h-a", leaseTtlMs: ttl, heartbeatMs: 200, ...(watchdog ? { appendTimeoutMs: 600_000, stuckMs: 3_000, now: () => 5 } : { appendTimeoutMs: 500 }) });
    try {
      await A.open(T, B);
      const g = fakeGateway(bus);
      g.hello("c0", "a"); await g.welcome("c0");
      g.op("c0", "a", 1); await g.ack("c0", "a:1");
      sa.append = "hold"; g.op("c0", "a", 2); await bus.flush();
      expect(await V.until(() => (watchdog ? lostWhy().length > 0 : A.stats().rooms === 0), 10_000, 50)).not.toBe(null);
      sa.append = "ok";
      const stopAt = V.now();
      let served = null;
      for (let i = 1; served === null && V.now() - stopAt < 40_000; i++) {   // the gateway: open, then the hello, on each writer reconnect
        const sentAt = V.now() - stopAt;
        await A.open(T, B); g.hello(`r${i}`, "a");
        await V.advance(500);
        if (g.of(`r${i}`).some(m => m.msg?.t === "welcome")) served = sentAt;
      }
      expect(served).not.toBe(null);
      expect(served).toBeGreaterThanOrEqual(ttl + margin);                     // never during the cooldown
      expect(served).toBeLessThanOrEqual(ttl + margin + 2 * 500);              // the first open after the cooldown starts the retake; the next hello is served (not up to renewEvery later)
    } finally { await A.close(); await raw.close(); await bus.close(); }
  }, 20000);

  test("stuckMs and storeTimeoutMs must be positive integers", () => {
    const bus = memoryBus();
    for (const o of [{ stuckMs: 0 }, { stuckMs: 1.5 }, { storeTimeoutMs: -1 }, { storeTimeoutMs: "x" }]) expect(() => roomHost({ store: {}, bus, ...o })).toThrow(RangeError);
  });
});
