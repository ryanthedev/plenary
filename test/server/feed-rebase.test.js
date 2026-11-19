// server/feed.js re-bases its cached tail on the room's newer checkpoints (PROTOCOL.md § Bus, `cp`):
// - The room's heartbeat names its newest durable checkpoint (`cp`); a feed reads the Store only when that is above its
//   base and above what its last completed look already saw. Each checkpoint is read once; an idle board costs nothing
//   (e1-tests-v MEDIUM-1: a miss used to be retried with a full checkpoint read and parse on every heartbeat, forever).
// - A look that misses because the checkpoint isn't written yet (the room writes it just after it publishes the
//   entries) is made again when the heartbeat announces it (the first fix, e8880c4).
// - Heartbeats without `cp` (a host from before it) or only Store polls: a due look and at most 3 retries after a miss.
// - A Store error during a look keeps the look open (TECH-DEBT row 10).
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { boardFeed } from "../../server/feed.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { tempDir, cleanup, until, sleep } from "./helpers.js";
import { rig } from "./rig.js";

afterAll(cleanup);
const T = "t-feed", B = "b-feed";
const emptyBoard = () => ({ elements: [], appState: {} });
const entry = (n, text = "") => ({ seq: n, board: B, tenant: T, stream: "board", op: { elements: [{ id: "e" + n, type: "text", version: 1, versionNonce: 1, x: n, y: 0, width: 1, height: 1, isDeleted: false, text }] }, by: "u", id: `c:${n}`, at: 1000 + n, rv: 1 });

/**
 * A board in a real Store (entries 1..n), its feed, and a counter of the feed's checkpoint reads. `failNext()` makes the
 * next getCheckpoint throw (a Store error). `checkpoint(seq, board)` writes one at `seq` (its entry must exist).
 */
async function setup({ n, feedOpts = {}, entries = i => entry(i), before = async () => {} }) {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-feed", 60_000);
  for (let i = 1; i <= n; i += 500) await raw.append(T, B, Array.from({ length: Math.min(500, n - i + 1) }, (_, k) => entries(i + k)), i - 1, epoch);
  const io = { cpReads: 0, reads: 0, fail: 0, failEntryReads: false };
  const store = {
    ...raw,
    async getCheckpoint(...a) { io.cpReads++; if (io.fail > 0) { io.fail--; throw new Error("store down"); } return raw.getCheckpoint(...a); },
    // failEntryReads: the one-entry read a look makes to check a checkpoint fails (getCheckpoint itself answers).
    async read(...a) { io.reads++; if (io.failEntryReads && a[3] === 1) throw new Error("reads down"); return raw.read(...a); },
  };
  const checkpoint = async (seq, board = emptyBoard(), { badId = false } = {}) => {
    const [e] = await raw.read(T, B, seq, 1);
    await raw.putCheckpoint(T, B, { seq, id: badId ? "c:not-entry-" + seq : e.id, by: e.by, at: e.at, streams: { board, notes: emptyBoard() }, appSeq: { board: {}, notes: {} }, records: { threads: [] }, clients: { horizon: 0, list: [] } }, epoch);
  };
  await before(checkpoint);                                               // what exists before the feed starts
  const feed = boardFeed({ tenant: T, board: B, store, bus, onLive() {}, ...feedOpts });
  const settle = async () => { await bus.flush(); await feed.atomically(() => {}); };
  const beat = async (m = {}) => { await bus.publish(subjects.entries(T, B), { seq: n, epoch, ...m }); await settle(); };
  await feed.ready;
  const entries_ = async (from, to) => {   // append entries from..to and publish them as the room would
    const list = Array.from({ length: to - from + 1 }, (_, k) => entries(from + k));
    await raw.append(T, B, list, from - 1, epoch);
    await bus.publish(subjects.entries(T, B), { epoch, from, to, items: list.map(e => JSON.stringify(e)) }); await settle();
  };
  return { feed, io, beat, entries: entries_, checkpoint, failNext: () => { io.fail++; }, close: async () => { feed.close(); await raw.close(); await bus.close(); } };
}

test("production defaults, the verifier's probe (1.42 MB checkpoint, 1,000-entry tail): no read per heartbeat; one per new checkpoint", async () => {
  // The board's state is big next to its recent ops, so the room does not fold at 1,000 entries (its tail is under half
  // the state): heartbeats keep announcing the old checkpoint, and the feed must not read it again.
  const big = Array.from({ length: 1000 }, (_, i) => ({ id: "big" + i, type: "text", version: 1, versionNonce: 1, x: i, y: 0, width: 1, height: 1, isDeleted: false, text: "x".repeat(1_300) }));
  const s = await setup({ n: 1001, before: checkpoint => checkpoint(1, { elements: big, appState: {} }) });
  try {
    expect(s.io.cpReads).toBe(1);                                         // the feed's start: one read
    expect(s.feed.base.seq).toBe(1);
    expect(s.feed.tail.length).toBe(1000);                                // due by count (rebaseEvery 1,000)
    const atStart = s.io.cpReads;
    for (let i = 0; i < 30; i++) await s.beat({ cp: 1 });
    expect(s.io.cpReads - atStart).toBe(0);                               // 30 heartbeats, nothing new: no read
    await s.checkpoint(1001);
    await s.beat({ cp: 1001 });
    expect(s.io.cpReads - atStart).toBe(1);                               // announced: read once
    expect([s.feed.base.seq, s.feed.tail.length]).toEqual([1001, 0]);
    for (let i = 0; i < 10; i++) await s.beat({ cp: 1001 });
    expect(s.io.cpReads - atStart).toBe(1);
  } finally { await s.close(); }
}, 30_000);

test("a look that misses (the checkpoint isn't written yet) is made again when the heartbeat announces the checkpoint", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    const atStart = s.io.cpReads;
    for (let i = 0; i < 3; i++) await s.beat({ cp: 0 });                  // nothing durable yet: no look at all
    expect([s.feed.base.seq, s.io.cpReads - atStart]).toEqual([0, 0]);
    await s.checkpoint(3);
    await s.beat({ cp: 0 });                                              // written but not yet announced: still none
    expect(s.io.cpReads - atStart).toBe(0);
    await s.beat({ cp: 3 });
    expect([s.feed.base.seq, s.feed.tail.length, s.io.cpReads - atStart]).toEqual([3, 0, 1]);
  } finally { await s.close(); }
});

test("mixed versions, heartbeats without cp: a due look, then at most 3 retries after a miss, then none until due again", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    const atStart = s.io.cpReads;
    for (let i = 0; i < 10; i++) await s.beat();
    expect(s.io.cpReads - atStart).toBe(4);                               // the due look and 3 retries, of 10 heartbeats
    expect(s.feed.base.seq).toBe(0);
  } finally { await s.close(); }
  // A rolling upgrade back and forth: on a cp host's heartbeat a due tail is no look; the next heartbeat, from a host
  // from before cp, puts the feed back on the bounded rule, so the due tail is looked at.
  const u = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    const atStart = u.io.cpReads;
    await u.beat({ cp: 0 });
    expect(u.io.cpReads - atStart).toBe(0);
    await u.checkpoint(3);
    await u.beat();
    expect([u.io.cpReads - atStart, u.feed.base.seq]).toEqual([1, 3]);
  } finally { await u.close(); }
  // The checkpoint lands during the retries: found.
  const f = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    await f.beat(); await f.beat();                                       // the due look and one retry miss
    await f.checkpoint(3);
    await f.beat();
    expect([f.feed.base.seq, f.feed.tail.length]).toEqual([3, 0]);
  } finally { await f.close(); }
});

test("mixed versions, Store polls only (no room heartbeating): the same bound, counted against the polls", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2, pollMs: 100 } });
  try {
    const atStart = s.io.cpReads;
    await s.beat();                                                       // a heartbeat with no cp: the due look misses
    const polls = () => s.io.reads;                                       // each poll reads the Store once (nothing new)
    const at = polls();
    await until(() => polls() >= at + 10, "10 polls");
    await s.feed.atomically(() => {});
    expect(s.io.cpReads - atStart).toBe(4);
  } finally { await s.close(); }
});

test("a Store error during a look keeps it open: the next heartbeat looks again (TECH-DEBT row 10)", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    await s.checkpoint(3);
    s.failNext();
    await s.beat({ cp: 3 });
    expect(s.feed.base.seq).toBe(0);
    await s.beat({ cp: 3 });
    expect(s.feed.base.seq).toBe(3);
  } finally { await s.close(); }
  const l = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });     // without cp: the due look throws, a retry remains
  try {
    await l.checkpoint(3);
    l.failNext();
    await l.beat();
    expect(l.feed.base.seq).toBe(0);
    await l.beat();
    expect(l.feed.base.seq).toBe(3);
  } finally { await l.close(); }
});

test("an announced checkpoint that doesn't match the log is looked at once, not on every heartbeat", async () => {
  // The look steps back past it (§ Recovery, Rebuild) and finds nothing above the base: only the record of what the last
  // completed look saw (lookedAt) stops the next heartbeat, which still names it, from reading it again.
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    await s.checkpoint(3, emptyBoard(), { badId: true });
    for (let i = 0; i < 20; i++) await s.beat({ cp: 3 });
    expect([s.feed.looks, s.feed.base.seq]).toEqual([1, 0]);
    await s.checkpoint(3);                                                // a good one at the same seq: not announced anew
    await s.beat({ cp: 3 });
    expect(s.feed.looks).toBe(1);
  } finally { await s.close(); }
});

// The look backoff (PROTOCOL.md § Bus): after the n-th failure in a row, k of the next heartbeats are skipped, k from
// [ceil(b/2), b], b = min(31, 2^(n-1) - 1). `random: () => 0` takes k = b, so the look beats are exact.
const lookBeats = async (s, beats, m) => { const at = []; for (let i = 1; i <= beats; i++) { const n = s.feed.looks; await s.beat(m); if (s.feed.looks > n) at.push(i); } return at; };

test("a Store whose checkpoint reads answer but whose entry reads fail: looks back off to the cap, recover, and reset", async () => {
  const s = await setup({ n: 5, feedOpts: { rebaseEvery: 2, random: () => 0 } });
  try {
    await s.checkpoint(3);
    s.io.failEntryReads = true;
    // 110 heartbeats of outage: skips of 0, 1, 3, 7, 15, then the cap of 31 (not 63, 127 …).
    expect(await lookBeats(s, 110, { cp: 3 })).toEqual([1, 2, 4, 8, 16, 32, 64, 96]);
    expect(s.feed.base.seq).toBe(0);
    s.io.failEntryReads = false;                                          // recovered: found within the cap
    const after = await lookBeats(s, 32, { cp: 3 });
    expect([after.length, s.feed.base.seq]).toEqual([1, 3]);
    // A completed look resets the count: one new failure is retried on the very next heartbeat, not 32 later.
    await s.checkpoint(5);
    s.io.failEntryReads = true;
    expect(await lookBeats(s, 1, { cp: 5 })).toEqual([1]);
    s.io.failEntryReads = false;
    expect(await lookBeats(s, 1, { cp: 5 })).toEqual([1]);
    expect(s.feed.base.seq).toBe(5);
  } finally { await s.close(); }
});

test("the look backoff is jittered into [ceil(b/2), b] heartbeats, so gateways don't look in lockstep", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2, random: () => 0.999 } });   // the shortest skips: ceil(b/2)
  try {
    await s.checkpoint(3);
    s.io.failEntryReads = true;
    // Skips 0, 1, 2, 4, 8, then 16 at the cap (b 0, 1, 3, 7, 15, 31): never more often than one look per 17 heartbeats.
    expect(await lookBeats(s, 110, { cp: 3 })).toEqual([1, 2, 4, 7, 12, 21, 38, 55, 72, 89, 106]);
  } finally { await s.close(); }
});

test("the backoff's jitter defaults to Math.random (it can't silently be off)", async () => {
  const random = Math.random;
  let calls = 0;
  Math.random = () => { calls++; return 0.999; };
  try {
    const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });         // no random passed
    try {
      await s.checkpoint(3);
      s.io.failEntryReads = true;
      expect(await lookBeats(s, 21, { cp: 3 })).toEqual([1, 2, 4, 7, 12, 21]);   // the jittered sequence, as with 0.999
      expect(calls).toBeGreaterThanOrEqual(6);
    } finally { await s.close(); }
  } finally { Math.random = random; }
});

test("a heartbeat naming a newer checkpoint ends the backoff: the feed looks at once", async () => {
  const s = await setup({ n: 5, feedOpts: { rebaseEvery: 2, random: () => 0 } });
  try {
    await s.checkpoint(3);
    s.io.failEntryReads = true;
    expect(await lookBeats(s, 20, { cp: 3 })).toEqual([1, 2, 4, 8, 16]);   // now skipping 15
    s.io.failEntryReads = false;
    await s.checkpoint(5);
    expect(await lookBeats(s, 1, { cp: 5 })).toEqual([1]);
    expect(s.feed.base.seq).toBe(5);
  } finally { await s.close(); }
});

test("while backing off, a due tail (a host without cp) makes no look either", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2, random: () => 0 } });
  try {
    s.failNext(); s.failNext();
    await s.beat(); await s.beat();                                       // the due look and its retry fail: skip 1
    expect(s.feed.looks).toBe(2);
    await s.entries(4, 5);                                                // the tail is due again (5 >= 3 + 2) ...
    expect([s.feed.seq, s.feed.looks]).toEqual([5, 2]);                   // ... but no look while skipping
    await s.beat();                                                       // the skipped heartbeat
    expect(s.feed.looks).toBe(2);
    await s.beat();                                                       // then the look
    expect(s.feed.looks).toBe(3);
  } finally { await s.close(); }
});

test("a host's `released` message carries cp: the feed stays on the cp rule and reads the stop checkpoint it names", async () => {
  const s = await setup({ n: 3, feedOpts: { rebaseEvery: 2 } });
  try {
    await s.beat({ cp: 0 });
    await s.checkpoint(3);
    await s.beat({ cp: 3, released: true });
    expect([s.feed.looks, s.feed.base.seq, s.feed.cpHeard]).toEqual([1, 3, 3]);
  } finally { await s.close(); }
  // And the host sends it: a clean stop checkpoints, releases, then publishes { seq, epoch, cp, released }.
  const r = await rig();
  const seen = [];
  r.bus.subscribe(subjects.entries(r.ids.tenant, r.ids.board), m => { if (m?.released) seen.push(m); });
  const w = await r.sock(); w.send({ t: "hello", v: 1, token: "S3CR3T-editor-token", board: r.ids.board, since: 0, client: "editor" });
  await w.next(m => m.t === "welcome");
  w.send({ t: "op", id: "editor:1", sentAt: 0, stream: "board", op: { elements: [{ id: "a", type: "rectangle", version: 1, versionNonce: 1, x: 0, y: 0, width: 1, height: 1, isDeleted: false }] } });
  await w.next(m => m.t === "ack");
  await r.server.stop();
  await r.bus.flush();
  expect(seen).toEqual([{ seq: 1, epoch: 1, cp: 1, released: true }]);
  expect((await r.rawStore.getCheckpoint(r.ids.tenant, r.ids.board)).seq).toBe(1);
  await r.stop();
});

test("end to end on a room host: every heartbeat's cp is already in the Store, and the gateway's feed reads each checkpoint once", async () => {
  // tailFoldBytes 64 KB: each 50 KB rewrite after the first folds (room-host.js foldIfDue), so the room writes several.
  // Each checkpoint write lands 500 ms after it is asked for: past the next 200 ms heartbeat, so a heartbeat that named a
  // checkpoint as soon as the room took it would be caught here naming one the Store doesn't have yet.
  const r = await rig({ host: { tailFoldBytes: 64 * 1024 }, wrapStore: st => ({ ...st, putCheckpoint: async (...a) => { await sleep(500); return st.putCheckpoint(...a); } }) });
  const announced = [], lies = [];
  r.bus.subscribe(subjects.entries(r.ids.tenant, r.ids.board), async m => {
    if (Array.isArray(m?.items) || !Number.isSafeInteger(m?.cp)) return;
    announced.push(m.cp);
    const inStore = (await r.rawStore.getCheckpoint(r.ids.tenant, r.ids.board))?.seq ?? 0;
    if (inStore < m.cp) lies.push({ cp: m.cp, inStore });
    checked++;
  });
  let checked = 0;
  const w = await r.sock(); w.send({ t: "hello", v: 1, token: `S3CR3T-editor-token`, board: r.ids.board, since: 0, client: "editor" });
  await w.next(m => m.t === "welcome");
  const text = n => ({ id: "note", type: "text", version: n, versionNonce: n, x: 0, y: 0, width: 10, height: 10, isDeleted: false, text: String(n % 10).repeat(50_000) });
  for (let n = 1; n <= 6; n++) { w.send({ t: "op", id: `editor:${n}`, sentAt: 0, stream: "board", op: { elements: [text(n)] } }); await w.next(m => m.t === "ack" && m.id === `editor:${n}`); }
  await until(async () => (await r.room()).resolved === 6, "op 6 resolved");
  // The room's last fold may land after op 6 resolves, and two writes landing between heartbeats are announced as one
  // (cp is the newest): wait for a heartbeat naming the room's base as it is then, every heartbeat checked.
  let base = 0;
  await until(async () => { base = (await r.room()).base.seq; return base > 0 && announced.at(-1) === base && checked === announced.length; }, "a heartbeat naming the room's base, checked against the Store", 15_000);
  expect(lies).toEqual([]);
  const feed = () => r.server.gateway.feed(r.ids.tenant, r.ids.board);
  await until(() => feed()?.base === base, `the feed to rebase onto ${base}`, 15_000);
  await until(() => checked === announced.length, "every heartbeat checked");
  expect(lies).toEqual([]);
  const distinct = new Set(announced.filter(cp => cp > 0)).size;
  expect(feed().looks).toBeLessThanOrEqual(distinct);                     // at most one read per announced checkpoint
  await r.stop();
}, 20_000);
