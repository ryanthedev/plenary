// § Pacing: what waits to be handled is capped in bytes per live connection (maxLiveQueuedBytes). Driven in-process with a
// fake socket: Bun hands a gateway every frame of one read back to back, and this calls message() the same way, so the
// burst is one synchronous run the pump cannot interleave with, on any OS and at any load. (A real socket's chunking is
// the kernel's: 16 KB at a time on macOS loopback, 64 KB on Linux, and under load anything: a test through one hung 20 s.)
import { test, expect } from "bun:test";
import { gateway } from "../../server/core/gateway.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { until } from "./helpers.js";

const TENANT = "t-pacing0000000000", BOARD = "b-pacing0000000000";
const store = { epoch: async () => 0, read: async () => [], getCheckpoint: async () => null, lastSeq: async () => 0 };
const registry = { board: async id => (id === BOARD ? { id: BOARD, tenant: TENANT } : null) };
const auth = { verify: async t => ({ user: t }), role: async () => "viewer" };

async function liveSocket(limits) {
  const logs = [];
  const log = { debug() {}, info: (msg, f) => logs.push({ msg, ...f }), error: (msg, f) => logs.push({ msg, ...f }), warn: (msg, f) => logs.push({ msg, ...f }) };
  const gw = gateway({ auth, registry, store, bus: memoryBus(), rooms: { open: async () => {} }, log, now: () => Date.now(), limits: { maxConnsPerUser: 1e9, sweepMs: 1e9, roleRecheckMs: 1e9, connListMs: 1e9, ...limits } });
  const ws = { data: {}, got: [], closed: null, send(d) { this.got.push(d); return d.length; }, getBufferedAmount: () => 0, close(code) { this.closed = code ?? 1000; }, ping() {}, terminate() {}, subscribe() {}, unsubscribe() {} };
  gw.websocket.open(ws);
  gw.websocket.message(ws, JSON.stringify({ t: "hello", v: 1, token: "u1", board: BOARD, since: 0, client: "c1" }));
  await until(() => ws.got.some(f => f.startsWith('{"t":"welcome"')), "the welcome");
  return { gw, ws, logs };
}
const burst = n => Array.from({ length: n }, (_, i) => JSON.stringify({ t: "presence", k: "cursor", x: i, y: 0, pad: "x".repeat(1000) }));

test("§ Pacing: frames handed over faster than they are handled are capped in bytes: past maxLiveQueuedBytes, `unavailable` and close", async () => {
  const { gw, ws, logs } = await liveSocket({ maxLiveQueuedBytes: 32 * 1024 });
  for (const f of burst(300)) gw.websocket.message(ws, f);        // 300 KB in one synchronous run, before the pump handles one
  expect(ws.closed).toBe(1013);
  expect(ws.got.map(f => JSON.parse(f)).filter(m => m.t === "error")).toEqual([{ t: "error", code: "unavailable", message: "too much sent at once" }]);
  expect(logs.some(l => l.msg === "frame queue overflow" && l.state === "live")).toBe(true);
  await gw.close();
});

test("§ Pacing: the same burst under the cap is all handled: nothing is refused, the connection stays", async () => {
  const { gw, ws, logs } = await liveSocket({ maxLiveQueuedBytes: 1024 * 1024 });
  for (const f of burst(300)) gw.websocket.message(ws, f);
  await until(() => gw.stats().queuedBytes === 0, "the queue to drain");
  expect(ws.closed).toBe(null);
  expect(ws.got.some(f => f.includes('"error"'))).toBe(false);
  expect(logs.some(l => l.msg === "frame queue overflow")).toBe(false);
  await gw.close();
});
