// server/feed.js, compressed catch-up (PROTOCOL.md § Joining): a text is compressed once, on first need, and shared; a
// client that didn't ask, a text that isn't ready, one not worth compressing, or a compressor that fails gets plain text.
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { boardFeed } from "../../server/feed.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { zlibDeflate } from "../../server/compress/zlib.js";
import { tempDir, cleanup } from "./helpers.js";

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

test("prepared(): false until every shared text a join would send is settled; an entry landing makes the last frame new, and prepare() settles it again", async () => {
  const raw = sqliteStore({ path: join(tempDir(), "plenary.db") }), bus = memoryBus();
  const { epoch } = await raw.acquire(T, B, "h-z2", 60_000);
  await raw.append(T, B, Array.from({ length: 40 }, (_, k) => entry(k + 1)), 0, epoch);
  let release; const gate = new Promise(r => { release = r; });
  const real = zlibDeflate(), feed = boardFeed({ tenant: T, board: B, store: raw, bus, onLive() {}, deflate: async d => { await gate; return real(d); } });
  expect(feed.prepared(0)).toBe(true);                                      // nothing to send yet (cold: base empty, no tail)
  const cold = feed.prepare(0);                                             // before ready: waits for the feed's start, then compresses
  release(); await cold;
  expect(feed.seq).toBe(40);
  expect(feed.prepared(0)).toBe(true);
  expect(feed.catchUp(0, true).every(f => f.z)).toBe(true);
  await raw.append(T, B, [entry(41)], 40, epoch);
  await bus.publish(subjects.entries(T, B), { from: 41, to: 41, items: [JSON.stringify(entry(41))] });
  await bus.flush(); await feed.atomically(() => {});
  expect(feed.seq).toBe(41);
  expect(feed.prepared(0)).toBe(false);                                     // the open last frame is a new text
  expect(feed.catchUp(0, true).some(f => !f.z)).toBe(true);                 // sent plain rather than wrong
  await feed.prepare(0);
  expect(feed.prepared(0)).toBe(true);
  expect(feed.catchUp(0, true).every(f => f.z)).toBe(true);
  feed.close(); await raw.close(); await bus.close();
});
