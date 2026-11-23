// The room-host heartbeat (PROTOCOL.md § Bus, "The heartbeat, exactly"): its payload and cadence, what a missed, late,
// stale or duplicate one does to a waiting host (never a wrong takeover: the Store's lease decides) and to a gateway feed
// (never a stale or wrong feed), and what it costs per hosted board. All on virtual time (test/server/virtual.js): no sleeps.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { roomHost } from "../../server/core/room-host.js";
import { boardFeed } from "../../server/core/feed.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { memoryBus, subjects } from "../../server/adapters/driven/bus/memory.js";
import { busBytes } from "../../server/ports/bus.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { makeElement } from "../../packages/core/model.js";
import { tempDir, cleanup } from "./helpers.js";
import { virtualTime, settleWith } from "./virtual.js";

afterAll(cleanup);
const T = "t-aaa", B = "b-one", HB = 2_000;
const rect = (id, x = 0) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });

/** A bus that records every `.entries` message, a virtual clock, and Stores (one file) that read it. */
function world() {
  const inner = memoryBus(), V = virtualTime({ settle: settleWith(inner) });
  const beats = [];   // heartbeats published, { subject, msg }
  const bus = { ...inner, publish: (s, m) => { if (s.endsWith(".entries") && !m?.items) beats.push({ s, m }); return inner.publish(s, m); } };
  const path = join(tempDir(), "plenary.db");
  const store = () => sqliteStore({ path, now: V.now });
  const host = o => roomHost({ bus, timers: V.timers, monotonic: V.now, ...o });
  return { bus, inner, V, beats, store, host };
}

/** A gateway as the host sees it: hellos in, replies out. */
function gateway(bus, id = "g-1") {
  const got = [], n = new Map();
  bus.subscribe(subjects.gateway(T, B, id), m => got.push({ conn: m.conn, close: m.close, msg: m.data ? JSON.parse(m.data) : null }));
  const send = (conn, client, msg) => bus.publish(subjects.inbox(T, B), { n: n.set(conn, (n.get(conn) ?? 0) + 1).get(conn), conn, gateway: id, user: "dev:ed", name: "ed", role: "editor", client, msg });
  return {
    got,
    hello: (conn, client) => send(conn, client, { t: "hello", v: PROTOCOL_VERSION, board: B, client }),
    op: (conn, client, k) => send(conn, client, { t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`e${k}`, k)] } }),
    answered: conn => got.find(m => m.conn === conn && (m.msg?.t === "welcome" || m.close)),
  };
}

test("DW-1 payload and cadence: { seq, epoch, cp } every 2 s per hosted board, seq is the resolved one; opened once at build, released once at a clean stop", async () => {
  const { bus, V, beats, store, host } = world();
  const raw = store(), A = host({ store: raw, holder: "h-a", leaseTtlMs: 60_000, sweepMs: 1e9 });
  try {
    await A.open(T, B);
    expect(beats).toHaveLength(1);
    expect(beats[0].m).toEqual({ seq: 0, epoch: 1, cp: 0, opened: true });
    const g = gateway(bus);
    g.hello("c1", "a"); await V.advance(1);
    g.op("c1", "a", 1); g.op("c1", "a", 2); await V.advance(1);
    beats.length = 0;
    await V.advance(60_000 - 2);
    const plain = beats.map(b => b.m);
    expect(plain.length).toBe(30);                                       // 60 s / 2 s
    for (const m of plain) expect(m).toEqual({ seq: 2, epoch: 1, cp: 0 });   // exactly these three fields
    expect(new Set(beats.map(b => b.s)).size).toBe(1);
    beats.length = 0;
    await A.close();
    expect(beats.map(b => b.m)).toEqual([{ seq: 2, epoch: 1, cp: 2, released: true }]);   // the stop checkpoint is announced
  } finally { await A.close(); await raw.close(); await bus.close(); }
});

test("DW-2 missed: a holder whose heartbeats never arrive but whose lease renews is never taken from; the waiting host asks the Store, is refused, and the epoch does not move", async () => {
  const { bus, inner, V, store, host } = world();
  const rawA = store(), rawB = store();
  let leaseReads = 0;
  const storeB = { ...rawB, lease: (...a) => (leaseReads++, rawB.lease(...a)) };
  const mute = { ...inner, publish: (s, m) => (s.endsWith(".entries") ? Promise.resolve() : inner.publish(s, m)) };   // A's bus: its entries and heartbeats are lost
  const A = host({ store: rawA, bus: mute, holder: "h-a", leaseTtlMs: 3_000 });
  const Bh = host({ store: storeB, holder: "h-b", leaseTtlMs: 3_000 });
  try {
    await A.open(T, B);
    await Bh.open(T, B);
    expect(Bh.stats()).toEqual({ rooms: 0, waiting: 1 });
    const g = gateway(bus);
    await V.advance(30_000);                                             // ten ttls, 15 silent beat periods: B tries over and over
    expect(leaseReads).toBeGreaterThan(5);                               // it did ask (the silence rule and the ttl/3 retry)...
    expect(Bh.stats()).toEqual({ rooms: 0, waiting: 1 });               // ...and was refused every time
    expect(await A.peek(T, B)).not.toBe(null);
    expect(await rawA.lease(T, B)).toMatchObject({ holder: "h-a", epoch: 1, live: true });
    g.hello("c1", "x"); await V.advance(10);
    expect(g.answered("c1")?.msg?.t).toBe("welcome");                    // A, the live holder, served it; B (waiting) never answered it
  } finally { await A.close(); await Bh.close(); await rawA.close(); await rawB.close(); await bus.close(); }
});

/** A dead holder (lease live, nothing publishing) with a waiting host B, a stale-epoch injector, and a counter of B's lease reads. */
async function deadHolder() {
  const w = world(), { V, store, host, bus } = w;
  const rawA = store(), rawB = store();
  await rawA.acquire(T, B, "h-old", 5_000); await rawA.release(T, B, "h-old", 1);   // epoch 1 is spent
  const { epoch } = await rawA.acquire(T, B, "h-dead", 600_000);                      // the dead holder: epoch 2, lease live far past the test
  let leaseReads = 0;
  const Bh = host({ store: { ...rawB, lease: (...a) => (leaseReads++, rawB.lease(...a)) }, holder: "h-b", leaseTtlMs: 600_000, heartbeatMs: 200 });
  await Bh.open(T, B);
  expect(Bh.stats()).toEqual({ rooms: 0, waiting: 1 });
  const publish = m => bus.publish(subjects.entries(T, B), m);
  return { ...w, epoch, Bh, rawA, rawB, publish, reads: () => leaseReads, close: async () => { await Bh.close(); await rawA.close(); await rawB.close(); await bus.close(); } };
}

test("DW-3 late: stale-epoch or epoch-less messages (heartbeats and entries batches) from a dead incarnation do not keep a waiting host believing the holder lives", async () => {
  for (const msg of [{ seq: 0, epoch: 1, cp: 0 }, { seq: 0, cp: 0 }, { from: 1, to: 1, items: ["{}"], epoch: 1 }, { from: 1, to: 1, items: ["{}"] }]) {
    const d = await deadHolder(), g = gateway(d.bus);
    try {
      await d.V.advance(10);
      g.hello("c1", "a");
      for (let i = 0; i < 10; i++) { await d.publish(msg); await d.V.advance(100); }   // every 100 ms (inside the 400 ms silence rule) for a second
      expect(g.answered("c1")?.msg).toMatchObject({ code: "unavailable" });             // answered once the real holder had been silent 2 beats
    } finally { await d.close(); }
  }
});

test("DW-3 same epoch: a late beat of the dead holder is indistinguishable from a live one (it delays, never loses): held hellos stay and are answered at the silence; a stream of them for a second answers nothing", async () => {
  let d = await deadHolder(), g = gateway(d.bus);
  try {
    await d.V.advance(10);
    g.hello("c1", "a"); await d.V.advance(10);
    for (let i = 0; i < 3; i++) { await d.publish({ seq: 0, epoch: d.epoch, cp: 0 }); await d.V.advance(100); }   // three late beats, then nothing
    expect(g.answered("c1")).toBeUndefined();                           // still held: the holder may be alive
    await d.V.advance(500);
    expect(g.answered("c1")?.msg).toMatchObject({ code: "unavailable" });   // the hello was not eaten by the beats: answered at the silence
  } finally { await d.close(); }
  d = await deadHolder(); g = gateway(d.bus);
  try {
    await d.V.advance(10);
    g.hello("c1", "a");
    for (let i = 0; i < 10; i++) { await d.publish({ seq: 0, epoch: d.epoch, cp: 0 }); await d.V.advance(100); }   // 1 s of same-epoch beats: a live holder as far as anyone can tell
    expect(g.answered("c1")).toBeUndefined();
  } finally { await d.close(); }
});

test("DW-3 late/duplicate released: a stale-epoch `released` triggers no attempt; a current one, duplicated, triggers exactly one attempt, and the lease still decides", async () => {
  const d = await deadHolder();
  try {
    await d.V.advance(1);
    const base = d.reads();
    for (let i = 0; i < 5; i++) await d.publish({ seq: 0, epoch: d.epoch - 1, cp: 0, released: true });   // a late one, duplicated
    await d.V.advance(1);
    expect(d.reads()).toBe(base);
    for (let i = 0; i < 3; i++) await d.publish({ seq: 0, epoch: d.epoch, cp: 0, released: true });       // current, duplicated: one attempt at a time
    await d.V.advance(1);
    expect(d.reads() - base).toBe(1);                                                                          // three messages in one tick, one attempt at a time
    expect(d.Bh.stats()).toEqual({ rooms: 0, waiting: 1 });                                                  // lease live: refused, no takeover
    expect(await d.rawA.lease(T, B)).toMatchObject({ holder: "h-dead", epoch: d.epoch, live: true });
  } finally { await d.close(); }
});

test("DW-3 fencing: a forged or late `released` for a live lease never takes the board; a real release is taken at once, one epoch higher", async () => {
  const { bus, V, store, host } = world();
  const rawA = store(), rawB = store();
  const A = host({ store: rawA, holder: "h-a", leaseTtlMs: 30_000 });
  const Bh = host({ store: rawB, holder: "h-b", leaseTtlMs: 30_000 });
  try {
    await A.open(T, B); await Bh.open(T, B);
    for (let i = 0; i < 4; i++) { await bus.publish(subjects.entries(T, B), { seq: 0, epoch: 1, cp: 0, released: true }); await V.advance(50); }
    expect(Bh.stats()).toEqual({ rooms: 0, waiting: 1 });
    expect(await rawB.lease(T, B)).toMatchObject({ holder: "h-a", epoch: 1 });
    await A.close();                                                     // a real release
    await V.advance(50);
    expect(Bh.stats()).toEqual({ rooms: 1, waiting: 0 });
    expect(await rawB.lease(T, B)).toMatchObject({ holder: "h-b", epoch: 2 });
  } finally { await A.close(); await Bh.close(); await rawA.close(); await rawB.close(); await bus.close(); }
});

// ---- the gateway feed ----
const entry = n => ({ seq: n, board: B, tenant: T, stream: "board", op: { elements: [{ id: "e" + n, type: "text", version: 1, versionNonce: 1, x: n, y: 0, width: 1, height: 1, isDeleted: false, text: "" }] }, by: "u", id: `c:${n}`, at: 1000 + n, rv: 1 });

async function feedWorld(n) {
  const w = world(), { V, bus, inner } = w;
  const raw = w.store(), { epoch } = await raw.acquire(T, B, "h-feed", 600_000);
  await raw.append(T, B, Array.from({ length: n }, (_, k) => entry(k + 1)), 0, epoch);
  const io = { reads: 0, cpReads: 0 };
  const store = { ...raw, read: (...a) => (io.reads++, raw.read(...a)), getCheckpoint: (...a) => (io.cpReads++, raw.getCheckpoint(...a)) };
  const live = [];
  const feed = boardFeed({ tenant: T, board: B, store, bus: inner, onLive: f => live.push(f), now: V.now, timers: V.timers, pollMs: 5_000 });
  await feed.ready;
  const settle = async () => { await inner.flush(); await feed.atomically(() => {}); };
  const items = (from, to) => ({ epoch, from, to, items: Array.from({ length: to - from + 1 }, (_, k) => JSON.stringify(entry(from + k))) });
  return { V, feed, io, live, epoch, settle, raw, pub: async m => { await inner.publish(subjects.entries(T, B), m); await settle(); }, items, close: async () => { feed.close(); await raw.close(); await bus.close(); } };
}

test("DW-2 feed, a missed last entry and no heartbeat: the Store is read once the silence reaches 5 s, checked every 2.5 s: repaired in [5 s, 7.5 s) after the last live message", async () => {
  for (const [offset, exact] of [[0, 5_000], [1, 7_499]]) {   // the last live message just before / just after a poll tick
    const f = await feedWorld(3);
    try {
      await f.V.advance(2_500 + offset); await f.settle();               // a poll tick passes (it found nothing), then the last message `offset` ms after it
      await f.pub({ seq: 3, epoch: f.epoch, cp: 0 });
      await f.raw.append(T, B, [entry(4)], 3, f.epoch);                  // the room's entry 4 never reached the bus
      let took = null;
      for (let t = 1; t <= 8_000 && took === null; t++) { await f.V.advance(1); await f.settle(); if (f.feed.seq === 4) took = t; }
      expect(took).toBe(exact);                                          // not before 5 s of silence, and under 7.5 s at worst
    } finally { await f.close(); }
  }
}, 30_000);

test("DW-2 feed, a silence poll repeats only once pollMs has passed again (5 to 7.5 s), not every tick", async () => {
  const f = await feedWorld(3);
  try {
    await f.V.advance(5_000); await f.settle();                          // the first silence poll (5 s)
    const first = f.io.reads;
    await f.V.advance(2_500); await f.settle();
    expect(f.io.reads).toBe(first);                                      // 2.5 s after a poll: no read
    await f.V.advance(2_500); await f.settle();
    expect(f.io.reads).toBeGreaterThan(first);                           // 5 s after it: the next
  } finally { await f.close(); }
}, 30_000);

test("F1 feed, a lost entry plus stale-epoch heartbeats and batches every 2 s: the Store is still read within the poll bound (stale traffic is not liveness)", async () => {
  const f = await feedWorld(3);
  try {
    await f.pub({ seq: 3, epoch: f.epoch + 1, cp: 0 });                  // the new incarnation was heard: feed epoch = epoch + 1
    await f.raw.append(T, B, [entry(4)], 3, f.epoch);                    // entry 4 never reached the bus
    let at = null;
    for (let t = 0; t < 8_000 && at === null; t += 500) {
      if (t % 2_000 === 0) { await f.pub({ seq: 3, epoch: f.epoch, cp: 0 }); await f.pub({ epoch: f.epoch, from: 1, to: 3, items: f.items(1, 3).items }); }   // a dead holder's late traffic
      await f.V.advance(500); await f.settle();
      if (f.feed.seq === 4) at = t + 500;
    }
    expect(at).not.toBe(null);
    expect(at).toBeLessThanOrEqual(7_500);
    // Positive control: current-epoch traffic does keep the silence poll off.
    const g = await feedWorld(3);
    try {
      await g.raw.append(T, B, [entry(4)], 3, g.epoch);
      for (let t = 0; t < 8_000; t += 500) { if (t % 2_000 === 0) await g.pub({ seq: 3, epoch: g.epoch, cp: 0 }); await g.V.advance(500); await g.settle(); }
      expect(g.feed.seq).toBe(3);                                       // no poll while beats say seq 3... (a heartbeat with seq 3 claims nothing newer)
    } finally { await g.close(); }
  } finally { await f.close(); }
}, 30_000);

test("DW-2 feed, a heartbeat with a higher seq repairs a lost last entry at once; a heartbeat past the Store invents nothing", async () => {
  const f = await feedWorld(3);
  try {
    await f.raw.append(T, B, [entry(4)], 3, f.epoch);
    await f.pub({ seq: 4, epoch: f.epoch, cp: 0 });
    expect(f.feed.seq).toBe(4);
    await f.pub({ seq: 9, epoch: f.epoch, cp: 0 });                      // the Store has nothing past 4
    expect(f.feed.seq).toBe(4);
    expect(f.feed.tail.map(x => x.seq)).toEqual([1, 2, 3, 4]);
  } finally { await f.close(); }
});

test("DW-3 feed, late and duplicate heartbeats (lower seq, lower epoch, lower cp, repeated) change nothing and read nothing", async () => {
  const f = await feedWorld(5);
  try {
    await f.pub({ seq: 5, epoch: f.epoch + 3, cp: 2 });                  // a newer incarnation's beat
    const at = { seq: f.feed.seq, epoch: f.feed.epoch, tail: f.feed.tail.length, reads: f.io.reads, live: f.live.length, cpHeard: f.feed.cpHeard };
    expect(at.epoch).toBe(f.epoch + 3);
    for (const m of [{ seq: 5, epoch: f.epoch + 3, cp: 2 }, { seq: 5, epoch: f.epoch + 3, cp: 2 }, { seq: 2, epoch: f.epoch, cp: 0 }, { seq: 0, epoch: 0, cp: 0 }]) await f.pub(m);
    expect({ seq: f.feed.seq, epoch: f.feed.epoch, tail: f.feed.tail.length, reads: f.io.reads, live: f.live.length, cpHeard: f.feed.cpHeard }).toEqual(at);
    // A late entry batch already delivered is dropped by seq, not applied twice.
    await f.pub(f.items(2, 4));
    expect([f.feed.seq, f.feed.tail.length, f.live.length]).toEqual([5, 5, at.live]);
  } finally { await f.close(); }
});

// ---- cost ----
async function cost(boards) {
  const { bus, V, beats, store, host } = world();
  const raw = store();
  const A = host({ store: raw, holder: "h-a", leaseTtlMs: 600_000, sweepMs: 1e9 });
  try {
    for (let i = 0; i < boards; i++) await A.open(T, `b-${i}`);
    await V.advance(1);
    beats.length = 0;
    const t0 = performance.now();
    await V.advance(60_000 - 1);                                         // a minute of virtual time
    const ms = performance.now() - t0;
    const bytes = beats.reduce((n, b) => n + busBytes(b.m), 0);
    return { boards, msgs: beats.length, bytes, perBoardMsgs: beats.length / boards, perBoardBytes: bytes / boards, msPerTick: ms / 30, distinct: new Set(beats.map(b => b.s)).size };
  } finally { await A.close(); await raw.close(); await bus.close(); }
}

test("DW-4 cost: per hosted board, one message of 26 bytes (small numbers) every 2 s, 30 a minute; the total is linear in boards", async () => {
  const rows = [];
  for (const n of [1, 100, 1000]) rows.push(await cost(n));
  console.log("heartbeat cost per minute (virtual), CPU is the tick incl. virtual-bus settle:\n" + rows.map(r => `  ${String(r.boards).padStart(4)} boards: ${r.msgs} msgs, ${r.bytes} B (${r.perBoardMsgs} msgs, ${r.perBoardBytes} B per board), ${r.msPerTick.toFixed(2)} ms/tick`).join("\n"));
  for (const r of rows) {
    expect(r.perBoardMsgs).toBe(30);
    expect(r.distinct).toBe(r.boards);
    expect(r.perBoardBytes / 30).toBeLessThan(48);                       // {"seq":0,"epoch":1,"cp":0} is 26 bytes; room for 7-digit seqs
  }
}, 60_000);
