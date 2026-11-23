// #66 fan-out: one live frame is encoded once and measured once, and every viewer gets exactly the bytes the per-viewer path produced.
import { test, expect } from "bun:test";
import { gateway } from "../../server/core/gateway.js";
import { memoryBus, subjects } from "../../server/adapters/driven/bus/memory.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { until } from "./helpers.js";

const TENANT = "t-fanout00000000000", BOARD = "b-fanout00000000000";
const store = { epoch: async () => 0, read: async () => [], getCheckpoint: async () => null, lastSeq: async () => 0 };
const registry = { board: async id => (id === BOARD ? { id: BOARD, tenant: TENANT } : null) };
const auth = { verify: async t => ({ user: t }), role: async () => "viewer" };
// Non-ASCII on purpose: a frame's UTF-8 byte length differs from its character count.
const entry = seq => ({ seq, id: `w:${seq}`, by: "writer", at: 1, rv: 1, tenant: TENANT, board: BOARD, stream: "board", op: { elements: [{ id: "e" + seq, type: "text", version: seq, versionNonce: seq, x: 0, y: 0, width: 1, height: 1, isDeleted: false, text: "héllo wörld ✓ 😀".repeat(5) }] } });

/** N viewers on one board; `buffering`: sockets that hold what they are sent (getBufferedAmount counts everything sent; a live frame answers -1) so the gateway's accounting is visible. */
const TICKS = { presence: 7001, here: 7002, emotes: 7003 };   // periods only these timers have: the harness holds them and calls them by hand
async function viewers(n, { buffering = false, blockAll = false, limits = {} } = {}) {
  const ticks = {}, clock = { t: Date.now() };
  const timers = { setTimeout, clearTimeout, clearInterval, setInterval: (fn, ms) => { const k = Object.keys(TICKS).find(k => TICKS[k] === ms); if (k) { ticks[k] = fn; return 0; } return setInterval(fn, ms); } };
  const bus = memoryBus();
  const gw = gateway({ auth, registry, store, bus, timers, now: () => clock.t, rooms: { open: async () => {} }, limits: { maxConnsPerUser: 1e9, hereMs: TICKS.here, herePublishMs: TICKS.here, hereBigMs: TICKS.here, presenceMs: TICKS.presence, emoteWindowMs: TICKS.emotes, sweepMs: 1e9, roleRecheckMs: 1e9, connListMs: 1e9, ...limits } });
  const sockets = [];
  for (let i = 0; i < n; i++) {
    const got = [];
    let held = 0;
    const ws = { data: {}, got, send(d) { got.push(d); if (buffering || blockAll) held += Buffer.byteLength(d); return blockAll || (buffering && d.startsWith('{"t":"entries"')) ? -1 : d.length; }, getBufferedAmount: () => held, close() { this.closed = true; }, ping() {}, terminate() {}, subscribe() {}, unsubscribe() {} };
    sockets.push(ws);
    gw.websocket.open(ws);
    gw.websocket.message(ws, JSON.stringify({ t: "hello", v: 1, token: "u" + i, board: BOARD, since: 0, client: "c" + i }));
  }
  await until(() => gw.stats().accepted === n, "viewers joined");
  await until(() => sockets.every(s => s.got.some(f => f.startsWith('{"t":"welcome"'))), "welcomes");
  const live = ws => ws.got.filter(f => f.startsWith('{"t":"entries"'));
  return { gw, bus, sockets, live, ticks, clock, stop: async () => { for (const ws of sockets) gw.websocket.close(ws); await gw.close(); } };
}

test("DW-66: every viewer gets the byte-identical frame the per-viewer encoding gives, as one shared string", async () => {
  const v = await viewers(50);
  const e = entry(1);
  v.bus.publish(subjects.entries(TENANT, BOARD), { from: 1, to: 1, items: [JSON.stringify(e)], epoch: 1 });
  await until(() => v.sockets.every(s => v.live(s).length === 1), "every viewer got the frame");
  const perViewer = jsonCodec.encode({ t: "entries", entries: [e] });   // the old path: encode for this viewer alone
  for (const s of v.sockets) expect(v.live(s)).toEqual([perViewer]);
  await v.stop();
});

test("DW-66: the frame's UTF-8 length is counted once and is right: owed bytes equal the bytes in the sockets", async () => {
  const v = await viewers(20, { buffering: true });
  const e = entry(1);
  v.bus.publish(subjects.entries(TENANT, BOARD), { from: 1, to: 1, items: [JSON.stringify(e)], epoch: 1 });
  await until(() => v.sockets.every(s => v.live(s).length === 1), "every viewer got the frame");
  const frame = v.live(v.sockets[0])[0];
  expect(Buffer.byteLength(frame)).toBeGreaterThan(frame.length);   // the fixture really is multi-byte
  // Everything every viewer holds (welcome + frame), as the sockets count it, is what the gateway says is owed in sockets.
  const held = v.sockets.reduce((n, s) => n + s.getBufferedAmount(), 0);
  expect(v.gw.stats().owedBytes).toBe(held);
  expect(v.gw.stats().owedTracked).toBe(held);
  await v.stop();
});

test("DW-66: a viewer that is backed up still gets frames in order, none lost, while the rest are served at once", async () => {
  const v = await viewers(3);
  const slow = v.sockets[0];
  slow.send = function (d) { this.got.push(d); return this.got.length % 2 ? -1 : d.length; };   // every other send asks the gateway to wait for `drain`
  for (let s = 1; s <= 4; s++) v.bus.publish(subjects.entries(TENANT, BOARD), { from: s, to: s, items: [JSON.stringify(entry(s))], epoch: 1 });
  await until(() => v.live(v.sockets[1]).length === 4 && v.live(v.sockets[2]).length === 4, "the others got all four");
  for (let i = 0; i < 6; i++) v.gw.websocket.drain(slow);
  await until(() => v.live(slow).length === 4, "the backed-up viewer got all four after drains");
  const seqs = ws => v.live(ws).map(f => JSON.parse(f).entries[0].seq);
  expect(seqs(slow)).toEqual([1, 2, 3, 4]);
  expect(seqs(v.sockets[1])).toEqual([1, 2, 3, 4]);
  await v.stop();
});

test("DW-66: the per-connection queue bound is judged on the frame's UTF-8 bytes, not its characters", async () => {
  const v = await viewers(2, { limits: { maxConnQueuedBytes: 2000 } });
  const e = entry(1); e.op.elements[0].text = "✓".repeat(1000);   // ~1.1k characters, ~3.1k bytes
  v.bus.publish(subjects.entries(TENANT, BOARD), { from: 1, to: 1, items: [JSON.stringify(e)], epoch: 1 });
  await until(() => v.sockets.every(s => s.closed), "both viewers cut for being over the bound");
  expect(v.sockets.flatMap(v.live)).toEqual([]);   // nothing over the bound was handed to a socket
  await v.stop();
});

// The other fan-out paths (presence batch, `here`, emotes) pass their frame's length to push() too. The sockets here never drain, so every
// frame a tick queues stays in the connection's own queue and counts as owed: `owedBytes` (sockets' buffers + queues) must grow by exactly
// the UTF-8 bytes of the frame each viewer is going to be sent. A length of 0, or of characters, makes it differ.
const owedAbove = v => v.gw.stats().owedBytes - v.sockets.reduce((n, s) => n + s.getBufferedAmount(), 0);
/** Let every blocked socket take what is queued for it; returns the frames that start with `prefix`, per socket. */
const drained = (v, prefix) => { for (const ws of v.sockets) for (let i = 0; i < 20; i++) v.gw.websocket.drain(ws); return v.sockets.map(s => s.got.filter(f => f.startsWith(prefix))); };
const settle = () => new Promise(r => setTimeout(r, 20));

test("DW-66: the presence batch's length is counted once and in UTF-8 bytes", async () => {
  const v = await viewers(2, { blockAll: true });
  await settle();
  const before = owedAbove(v);
  v.bus.publish(subjects.presence(TENANT, BOARD), { gateway: "g-other00000000000", user: "✓".repeat(400), client: "w", role: "editor", msg: { k: "cursor", x: 1, y: 2 } });
  await settle();
  v.clock.t += 100;
  v.ticks.presence();
  const queued = owedAbove(v) - before;
  const frames = drained(v, '{"t":"presence"');
  expect(frames.map(f => f.length)).toEqual([1, 1]);
  expect(Buffer.byteLength(frames[0][0])).toBeGreaterThan(frames[0][0].length);   // multi-byte, so chars and bytes differ
  expect(queued).toBe(2 * Buffer.byteLength(frames[0][0]));
  await v.stop();
});

/** Publish a `.here` from another gateway, run the `here` tick, and say what each viewer was queued (the sockets never drain until `drained`). */
async function hereTick(writers, viewerCount = 5) {
  const v = await viewers(2, { blockAll: true });
  await settle();
  const before = owedAbove(v);
  v.clock.t += 60_000;
  v.bus.publish(subjects.here(TENANT, BOARD), { gateway: "g-other00000000000", writers, writerCount: writers.length, viewers: viewerCount });
  await settle();
  v.ticks.here();
  await settle();
  return { v, queued: owedAbove(v) - before, frames: () => drained(v, '{"t":"here"').map(f => f.at(-1)) };
}

test("DW-66: `here` with a changed list (the full message) is counted in UTF-8 bytes", async () => {
  const { v, queued, frames } = await hereTick([{ user: "writer1", name: "✓".repeat(150), role: "editor", active: 1 }]);
  const [full] = frames();
  expect(full).toContain("writers");
  expect(Buffer.byteLength(full)).toBeGreaterThan(full.length);
  expect(queued).toBe(2 * Buffer.byteLength(full));
  await v.stop();
});

test("DW-66: `here` with only a count change (the small message) is counted in UTF-8 bytes", async () => {
  const { v, queued, frames } = await hereTick([]);
  const [count] = frames();
  expect(count).not.toContain("writers");
  expect(queued).toBe(2 * Buffer.byteLength(count));
  await v.stop();
});

test("DW-66: the emote total's length is counted once", async () => {
  const v = await viewers(2, { blockAll: true });
  await settle();
  const before = owedAbove(v);
  v.bus.publish(subjects.emotes(TENANT, BOARD), { gateway: "g-other00000000000", window: 1, counts: { "👍": 3 } });
  await settle();
  v.ticks.emotes();
  const queued = owedAbove(v) - before;
  const frames = drained(v, '{"t":"emotes"');
  expect(frames.map(f => f.length)).toEqual([1, 1]);
  expect(queued).toBe(2 * Buffer.byteLength(frames[0][0]));
  await v.stop();
});
