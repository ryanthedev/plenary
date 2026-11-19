// #66 fan-out: one live frame is encoded once and measured once, and every viewer gets exactly the bytes the per-viewer path produced.
import { test, expect } from "bun:test";
import { gateway } from "../../server/gateway.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { until } from "./helpers.js";

const TENANT = "t-fanout00000000000", BOARD = "b-fanout00000000000";
const store = { epoch: async () => 0, read: async () => [], getCheckpoint: async () => null, lastSeq: async () => 0 };
const registry = { board: async id => (id === BOARD ? { id: BOARD, tenant: TENANT } : null) };
const auth = { verify: async t => ({ user: t }), role: async () => "viewer" };
// Non-ASCII on purpose: a frame's UTF-8 byte length differs from its character count.
const entry = seq => ({ seq, id: `w:${seq}`, by: "writer", at: 1, rv: 1, tenant: TENANT, board: BOARD, stream: "board", op: { elements: [{ id: "e" + seq, type: "text", version: seq, versionNonce: seq, x: 0, y: 0, width: 1, height: 1, isDeleted: false, text: "héllo wörld ✓ 😀".repeat(5) }] } });

/** N viewers on one board; `buffering`: sockets that hold what they are sent (getBufferedAmount counts everything sent; a live frame answers -1) so the gateway's accounting is visible. */
async function viewers(n, { buffering = false, limits = {} } = {}) {
  const bus = memoryBus();
  const gw = gateway({ auth, registry, store, bus, rooms: { open: async () => {} }, limits: { maxConnsPerUser: 1e9, hereMs: 1e9, herePublishMs: 1e9, hereBigMs: 1e9, presenceMs: 1e9, emoteWindowMs: 1e9, sweepMs: 1e9, roleRecheckMs: 1e9, connListMs: 1e9, ...limits } });
  const sockets = [];
  for (let i = 0; i < n; i++) {
    const got = [];
    let held = 0;
    const ws = { data: {}, got, send(d) { got.push(d); if (buffering) held += Buffer.byteLength(d); return buffering && d.startsWith('{"t":"entries"') ? -1 : d.length; }, getBufferedAmount: () => held, close() { this.closed = true; }, ping() {}, terminate() {}, subscribe() {}, unsubscribe() {} };
    sockets.push(ws);
    gw.websocket.open(ws);
    gw.websocket.message(ws, JSON.stringify({ t: "hello", v: 1, token: "u" + i, board: BOARD, since: 0, client: "c" + i }));
  }
  await until(() => gw.stats().accepted === n, "viewers joined");
  await until(() => sockets.every(s => s.got.some(f => f.startsWith('{"t":"welcome"'))), "welcomes");
  const live = ws => ws.got.filter(f => f.startsWith('{"t":"entries"'));
  return { gw, bus, sockets, live, stop: async () => { for (const ws of sockets) gw.websocket.close(ws); await gw.close(); } };
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
