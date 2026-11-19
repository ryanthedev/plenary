// server/feed.js, compressed catch-up (PROTOCOL.md § Joining): a text is compressed once, on first need, and shared; a
// client that didn't ask, a text that isn't ready, one not worth compressing, or a compressor that fails gets plain text.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { boardFeed } from "../../server/feed.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { zlibDeflate } from "../../server/compress/zlib.js";
import { tempDir, cleanup, until } from "./helpers.js";

afterAll(cleanup);
const T = "t-z", B = "b-z";
const entry = n => ({ seq: n, board: B, tenant: T, stream: "board", op: { elements: [{ id: "e" + n, type: "text", version: 1, versionNonce: 1, x: n, y: 0, width: 1, height: 1, isDeleted: false, text: "hello ".repeat(40) }] }, by: "u", id: `c:${n}`, at: 1000 + n, rv: 1 });

async function setup({ n = 300, deflate, log }) {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-z", 60_000);
  for (let i = 1; i <= n; i += 100) await raw.append(T, B, Array.from({ length: Math.min(100, n - i + 1) }, (_, k) => entry(i + k)), i - 1, epoch);
  const feed = boardFeed({ tenant: T, board: B, store: raw, bus, onLive() {}, deflate, chunkBytes: 32 * 1024, ...(log ? { log } : {}) });
  await feed.ready;
  return { feed, close: async () => { feed.close(); await raw.close(); await bus.close(); } };
}
const text = f => (f.z ? inflateSync(f.data).toString("utf8") : f.data);

test("DW-43.2: a text is compressed once and shared; before it is ready, and for a client that didn't ask, it goes plain", async () => {
  let calls = 0;
  const real = zlibDeflate(), s = await setup({ deflate: async d => { calls++; return real(d); } });
  const plain = s.feed.catchUp(0);
  expect(plain.length).toBeGreaterThan(3);                                  // 300 entries of ~0.4 KB in 32 KB chunks
  expect(s.feed.catchUp(0, true)).toEqual(plain);                           // asked, but nothing prepared yet: plain
  await s.feed.prepare(0); await s.feed.prepare(0);
  const z = s.feed.catchUp(0, true);
  expect(z.map(text)).toEqual(plain.map(f => f.data));                      // the same texts, inflated
  expect(z.every(f => f.z && f.data instanceof Uint8Array && f.shared.endsWith("/z") && f.bytes === f.data.byteLength)).toBe(true);
  expect(z.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(plain.reduce((n, f) => n + f.bytes, 0) / 5);
  expect(s.feed.catchUp(0)).toEqual(plain);                                 // not asked: still plain
  s.feed.catchUp(0, true); await s.feed.prepare(0);
  expect(calls).toBe(plain.length);                                         // once per text, however many joins
  await s.close();
});

test("a client starting inside a chunk gets its own plain cut; whole chunks after it are compressed", async () => {
  const s = await setup({ deflate: zlibDeflate() });
  const all = s.feed.catchUp(0);
  const firstTo = (() => { let n = 0; for (const f of all) { n += JSON.parse(f.data).entries.length; break; } return n; })();
  await s.feed.prepare(firstTo + 3);
  const frames = s.feed.catchUp(firstTo + 3, true);
  expect(frames[0].shared).toBe(false);                                     // the rest of its chunk, cut for it
  expect(frames[0].z).toBeUndefined();
  expect(frames.slice(1).every(f => f.z)).toBe(true);
  expect(JSON.parse(frames[0].data).entries[0].seq).toBe(firstTo + 4);
  await s.close();
});

test("a compressor that says no (null), throws, or is absent: plain text, and a throw is logged", async () => {
  const warns = [];
  const log = { warn: (m, f) => warns.push([m, f]), error() {}, info() {}, debug() {}, child() { return this; } };
  for (const deflate of [async () => null, async () => { throw new Error("zlib broke"); }, undefined]) {
    const s = await setup({ deflate, log });
    const plain = s.feed.catchUp(0);
    await s.feed.prepare(0);
    expect(s.feed.catchUp(0, true)).toEqual(plain);
    await s.close();
  }
  expect(warns.length).toBeGreaterThan(0);
  expect(warns[0][0]).toContain("compression failed");
});

test("zlibDeflate: small or dense input is not worth compressing (null); text is, and inflates to itself", async () => {
  const d = zlibDeflate();
  expect(await d("short")).toBeNull();
  expect(await d(crypto.getRandomValues(new Uint8Array(8192)))).toBeNull();
  const t = JSON.stringify({ t: "entries", entries: Array.from({ length: 200 }, (_, i) => entry(i)) });
  const z = await d(t);
  expect(inflateSync(z).toString("utf8")).toBe(t);
  expect(z.byteLength).toBeLessThan(t.length / 5);
});

// F1 (review): on a busy board a new entry lands during every deflate of the open last chunk. The compressed form is a prefix of
// that chunk (entries up to the seq the deflate started at) plus a small plain cut of the entries after it, so it is never stale.
async function busy({ n = 40, deflate: wrap, zSlack }) {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-zb", 60_000);
  await raw.append(T, B, Array.from({ length: n }, (_, k) => entry(k + 1)), 0, epoch);
  let seq = n, calls = 0, landing = true;
  const real = zlibDeflate(), land = async () => {
    const e = entry(++seq);
    await raw.append(T, B, [e], seq - 1, epoch);
    await bus.publish(subjects.entries(T, B), { epoch, from: seq, to: seq, items: [JSON.stringify(e)] });
    await bus.flush();
  };
  const feed = boardFeed({ tenant: T, board: B, store: raw, bus, onLive() {}, ...(zSlack ? { zSlack } : {}),
    deflate: async d => { calls++; if (landing) await land(); return real(d); } });
  await feed.ready;
  return { feed, land, calls: () => calls, stop: () => { landing = false; }, close: async () => { feed.close(); await raw.close(); await bus.close(); } };
}
const seqs = frames => frames.flatMap(f => JSON.parse(text(f)).entries.map(e => e.seq));

test("DW-43.F1: an entry landing during every deflate never makes the big frame plain: compressed prefix + plain cut, one deflate", async () => {
  const s = await busy({});
  await s.feed.prepare(0);
  await s.feed.atomically(() => {});
  const startSeq = s.feed.seq;
  expect(startSeq).toBeGreaterThan(40);                                     // the op landed during the deflate
  const frames = s.feed.catchUp(0, true);
  expect(frames[0].z).toBe(true);                                           // the big frame went compressed
  expect(frames.slice(1).every(f => !f.z && f.shared === false)).toBe(true); // only the small cut after it is plain
  expect(frames.length).toBe(2);
  expect(frames[1].bytes).toBeLessThan(frames[0].bytes);
  expect(seqs(frames)).toEqual(Array.from({ length: startSeq }, (_, k) => k + 1));   // contiguous, in order, up to the feed's seq
  expect(s.calls()).toBe(1);                                                // no retry loop
  // many more joins while entries keep landing (each join's deflate would land one, if it deflated): bounded work
  s.stop();
  for (let i = 0; i < 20; i++) { await s.feed.prepare(0); expect(seqs(s.feed.catchUp(0, true))).toEqual(Array.from({ length: s.feed.seq }, (_, k) => k + 1)); }
  expect(s.calls()).toBe(1);
  await s.close();
});

test("F1: the open chunk's prefix is made again only after zSlack bytes of new entries, and the join stays contiguous", async () => {
  const s = await busy({ zSlack: 2048 });
  await s.feed.prepare(0); await s.feed.atomically(() => {});
  expect(s.calls()).toBe(1);
  await s.feed.prepare(0);                                                  // 1 entry (~0.4 KB) since: under the slack
  expect(s.calls()).toBe(1);
  s.stop();
  for (let i = 0; i < 8; i++) await s.land();                               // ~3 KB of entries: over the slack
  await s.feed.atomically(() => {});
  await s.feed.prepare(0);
  expect(s.calls()).toBe(2);                                                // made again, once
  expect(seqs(s.feed.catchUp(0, true))).toEqual(Array.from({ length: s.feed.seq }, (_, k) => k + 1));
  await s.close();
});

test("F1: a chunk that closes after its prefix was compressed still goes as prefix + plain cut, never as a whole plain chunk", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-zc", 60_000);
  await raw.append(T, B, Array.from({ length: 20 }, (_, k) => entry(k + 1)), 0, epoch);
  const real = zlibDeflate();
  const feed = boardFeed({ tenant: T, board: B, store: raw, bus, onLive() {}, deflate: real, chunkBytes: 12 * 1024 });
  await feed.ready;
  await feed.prepare(0);                                                    // chunk still open: prefix to seq 20
  const add = async (from, to) => {
    const items = Array.from({ length: to - from + 1 }, (_, k) => entry(from + k));
    await raw.append(T, B, items, from - 1, epoch);
    await bus.publish(subjects.entries(T, B), { epoch, from, to, items: items.map(x => JSON.stringify(x)) });
    await bus.flush(); await feed.atomically(() => {});
  };
  await add(21, 60);                                                        // the first chunk closes; later ones open
  const frames = feed.catchUp(0, true);
  expect(frames.length).toBeGreaterThan(2);
  expect(frames[0].z).toBe(true);                                           // the closed chunk: its compressed prefix
  expect(seqs(frames)).toEqual(Array.from({ length: 60 }, (_, k) => k + 1));
  await feed.prepare(0);
  expect(feed.catchUp(0, true).filter(f => f.z).length).toBeGreaterThanOrEqual(2);
  expect(seqs(feed.catchUp(0, true))).toEqual(Array.from({ length: 60 }, (_, k) => k + 1));
  feed.close(); await raw.close(); await bus.close();
});

// Re-review of F1: a newer attempt in flight must never hide the settled prefix a waiting join counted on (a join A that
// awaited a settled prefix, then B replaced it with an unsettled one, used to send the whole open chunk plain).
async function held({ n }) {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-zh", 60_000);
  await raw.append(T, B, Array.from({ length: n }, (_, k) => entry(k + 1)), 0, epoch);
  const real = zlibDeflate(), holds = [], manual = []; let hold = () => null, nHeld = 0;
  const feed = boardFeed({ tenant: T, board: B, store: raw, bus, onLive() {}, chunkBytes: 32 * 1024, zSlack: 2048,
    deflate: async d => { const h = hold(d); if (h) { nHeld++; await h; } return real(d); } });
  await feed.ready;
  let seq = n;
  const add = async k => {
    const items = Array.from({ length: k }, (_, i) => entry(seq + 1 + i)), from = seq + 1; seq += k;
    await raw.append(T, B, items, from - 1, epoch);
    await bus.publish(subjects.entries(T, B), { epoch, from, to: seq, items: items.map(x => JSON.stringify(x)) });
    await bus.flush(); await feed.atomically(() => {});
  };
  const gate = pred => { let open; const g = new Promise(r => { open = r; }); hold = d => (pred(d) ? g : null); holds.push(open); return open; };
  const manualGate = () => { hold = () => new Promise(r => manual.push(r)); };
  return { feed, add, gate, manualGate, manual, held: () => nHeld, free: () => { hold = () => null; for (const o of holds) o(); }, seq: () => seq,
    close: async () => { feed.close(); await raw.close(); await bus.close(); } };
}
const upTo = (frames, n) => expect(seqs(frames)).toEqual(Array.from({ length: n }, (_, k) => k + 1));

test("F1 re-review, probe 1: A's settled open prefix survives B's newer, unsettled one; A still sends compressed", async () => {
  const s = await held({ n: 50 });
  await s.feed.prepare(0);                                                  // a settled prefix of 1-50
  await s.add(40);                                                          // chunk 1 closes; a new one opens
  const closedOpen = s.gate(d => d.includes('"seq":1,'));                   // only the closed chunk's deflate is held
  const a = s.feed.prepare(0);                                              // A: closed chunk (held), open chunk's prefix settles
  await until(() => s.held() >= 1 && s.feed.catchUp(0, true).filter(f => f.z).length >= 2, "the closed chunk held, the open prefix settled", 5000);
  await s.add(10);                                                          // over zSlack of new entries
  s.gate(() => true);                                                       // B: every new deflate held
  void s.feed.prepare(0);
  closedOpen(); await a;                                                    // A is released
  const frames = s.feed.catchUp(0, true), plain = s.feed.catchUp(0);
  upTo(frames, s.seq());
  expect(frames.slice(0, -1).every(f => f.z)).toBe(true);                   // every big frame compressed
  expect(frames.at(-1).z).toBeUndefined();                                  // only the small plain cut is not
  expect(frames.length).toBe(3);                                            // closed chunk, open prefix, cut
  expect(seqs([frames.at(-1)])).toEqual(Array.from({ length: 10 }, (_, k) => 91 + k));   // exactly the entries after the prefix
  expect(frames.at(-1).bytes).toBeLessThan(plain.at(-1).bytes / 2);        // far less than the whole open chunk
  s.free(); await s.close();
});

test("F1 re-review, probe 2: a settled prefix of X survives X closing and B's deflates being held: prefix + small cut, not X whole", async () => {
  const s = await held({ n: 50 });
  await s.feed.prepare(0);
  const plainX = s.feed.catchUp(0)[0].bytes;                                // X while it is still the whole open chunk
  await s.add(40);                                                          // X closes at ~70, Y opens
  s.gate(() => true);                                                       // B's X-whole and Y-prefix deflates are held
  void s.feed.prepare(0);
  await until(() => s.held() >= 2, "X-whole and Y-prefix held", 5000);
  const frames = s.feed.catchUp(0, true);                                   // A sends now
  upTo(frames, s.seq());
  expect(frames[0].z).toBe(true);                                           // X's settled prefix
  expect(frames[0].shared).toMatch(/\.1-50\/z$/);
  expect(seqs([frames[1]])).toEqual(Array.from({ length: 19 }, (_, k) => 51 + k));   // the rest of X: 51..69
  expect(frames.slice(1).filter(f => !f.z).reduce((n, f) => n + f.bytes, 0)).toBeLessThanOrEqual(plainX);   // nothing but the new entries is plain
  expect(frames[1].z).toBeUndefined(); expect(frames[1].bytes).toBeLessThan(s.feed.catchUp(0)[0].bytes / 2);   // the rest of X: a small plain cut, not X whole
  s.free(); await s.close();
});

test("F1 re-review: a late-settling older attempt never replaces a newer settled prefix; a closed chunk's whole form frees its prefix entry", async () => {
  const s = await held({ n: 50 });
  s.manualGate();
  const p1 = s.feed.prepare(0);                                             // attempt 1: prefix to 50, held
  await until(() => s.held() >= 1, "attempt 1 held", 5000);
  await s.add(10);                                                          // over the slack
  const p2 = s.feed.prepare(0);                                             // attempt 2: prefix to 60, held
  await until(() => s.held() >= 2, "attempt 2 held", 5000);
  s.manual[1](); await p2;                                                  // the newer settles first
  s.manual[0](); await p1;                                                  // then the older, last
  await s.add(5);
  const frames = s.feed.catchUp(0, true);
  expect(frames[0].z).toBe(true);
  expect(frames[0].shared).toMatch(/\.1-60\/z$/);                           // still attempt 2's prefix
  expect(seqs([frames[1]])).toEqual([61, 62, 63, 64, 65]);                  // the plain cut starts right after it
  upTo(frames, 65);
  // The chunk closes and is compressed whole: its prefix entry is freed, the whole form is used.
  expect(s.feed.zTails.has(1)).toBe(true);
  await s.add(40);
  s.free(); s.manualGate = null;
  await s.feed.prepare(0);
  expect(s.feed.zTails.has(1)).toBe(false);
  const after = s.feed.catchUp(0, true);
  upTo(after, s.seq());
  expect(after.slice(0, 1).every(f => f.z && f.shared.endsWith("/z"))).toBe(true);
  await s.close();
});
