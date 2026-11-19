// Gateway fan-out micro-benchmark (#66): what one live frame costs the gateway for N viewers. In-process, deterministic, no sockets:
// N fake viewer sockets (a sink that counts frames and bytes), a stub Store, the in-memory Bus. A frame is published on the board's
// `.entries` subject exactly as a room host does; the clock runs from the publish until the last viewer's socket has received it.
//   nice -n 19 timeout 60 bun scripts/fanout-bench.js [--root <repo>] [--n 1,100,1000,10000] [--frames 20] [--entry 300] [--json]
// --root measures another checkout (e.g. `git archive <sha> packages server | tar -x -C <dir>`) to compare before and after.
// A report, not a gate. Reports per frame: wall ms (publish -> every viewer has it), CPU ms (user+system of the process), CPU µs per viewer,
// bytes sent per viewer, heap growth per frame. Presence fan-out (the 50 ms batch) is measured the same way with --presence.
import { resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = resolve(arg("--root", new URL("..", import.meta.url).pathname));
const sizes = arg("--n", "1,100,1000,10000").split(",").map(Number), frames = +arg("--frames", 20), entryChars = +arg("--entry", 300), asJson = process.argv.includes("--json");
const presence = process.argv.includes("--presence"), prefix = presence ? '{"t":"presence"' : '{"t":"entries"';   // bytes below = chars of the (ASCII) text: the sink does no work of its own
const { gateway } = await import(`${root}/server/gateway.js`);
const { memoryBus, subjects } = await import(`${root}/server/bus/memory.js`);

const PRESENCE_MS = 7777;   // a period no other timer of the gateway has: the harness holds that one
const TENANT = "t-bench000000000000", BOARD = "b-bench000000000000";
const pad = "x".repeat(Math.max(0, entryChars - 160));
const entry = seq => JSON.stringify({ seq, id: `w:${seq}`, by: "writer", at: 1, rv: 1, tenant: TENANT, board: BOARD, stream: "board", op: { elements: [{ id: "e" + seq, type: "text", version: seq, versionNonce: seq, x: 0, y: 0, width: 1, height: 1, isDeleted: false, text: pad }] } });
const store = { epoch: async () => 0, read: async () => [], getCheckpoint: async () => null, lastSeq: async () => 0 };
const registry = { board: async id => (id === BOARD ? { id: BOARD, tenant: TENANT } : null) };
const auth = { verify: async t => ({ user: t }), role: async () => "viewer" };

async function scenario(n) {
  const bus = memoryBus();
  const timers = { setTimeout, clearTimeout, clearInterval, setInterval: (fn, ms) => { if (ms === PRESENCE_MS) { tick = fn; return 0; } return setInterval(fn, ms); } };
  let tick = null;
  const gw = gateway({ timers, auth, registry, store, bus, rooms: { open: async () => {} }, limits: { maxConnsPerUser: 1e9, presenceMs: presence ? PRESENCE_MS : 1e9, hereMs: 1e9, herePublishMs: 1e9, hereBigMs: 1e9, roleRecheckMs: 1e9, connListMs: 1e9, sweepMs: 1e9 } });
  let got = 0, bytes = 0, frameWaiter = null, want = 0;
  const sockets = [];
  for (let i = 0; i < n; i++) {
    const ws = { data: {}, send(d) { if (typeof d === "string" && d.startsWith(prefix)) { got++; bytes += d.length; if (got === want && frameWaiter) frameWaiter(); } return d.length || 1; }, getBufferedAmount: () => 0, close() {}, ping() {}, terminate() {}, subscribe() {}, unsubscribe() {} };
    sockets.push(ws);
    gw.websocket.open(ws);
    gw.websocket.message(ws, JSON.stringify({ t: "hello", v: 1, token: "u" + i, board: BOARD, since: 0, client: "c" + i }));
  }
  for (let i = 0; i < 2000 && gw.stats().accepted < n; i++) await new Promise(r => setTimeout(r, 5));
  if (gw.stats().accepted < n) throw new Error(`only ${gw.stats().accepted}/${n} viewers joined`);
  await new Promise(r => setTimeout(r, 20));
  got = 0; bytes = 0;
  // Warm up (JIT) with 3 frames, then measure.
  let seq = 0;
  const one = async () => {
    const s = ++seq; want = got + n;
    const done = presence ? null : new Promise(r => { frameWaiter = r; });
    if (presence) {
      bus.publish(subjects.presence(TENANT, BOARD), { gateway: "other", user: "writer", client: "w", msg: { k: "cursor", x: s, y: s } });
      await new Promise(r => setImmediate(r));   // the Bus delivers it to the board's coalescer
      const t0 = performance.now(), c0 = process.cpuUsage();
      tick();
      const c1 = process.cpuUsage(c0);
      return { wall: performance.now() - t0, cpu: (c1.user + c1.system) / 1000 };
    }
    const t0 = performance.now(), c0 = process.cpuUsage();
    bus.publish(subjects.entries(TENANT, BOARD), { from: s, to: s, items: [entry(s)], epoch: 1 });
    await done;
    const c1 = process.cpuUsage(c0);
    return { wall: performance.now() - t0, cpu: (c1.user + c1.system) / 1000 };
  };
  for (let i = 0; i < 3; i++) await one();
  Bun.gc(true); const heap0 = process.memoryUsage().heapUsed; got = 0; bytes = 0;
  const walls = [], cpus = [];
  for (let i = 0; i < frames; i++) { const r = await one(); walls.push(r.wall); cpus.push(r.cpu); }
  const heap1 = process.memoryUsage().heapUsed;
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = { n, frames, entryChars, wallMsMedian: +med(walls).toFixed(3), wallMsMax: +Math.max(...walls).toFixed(3), cpuMsPerFrame: +med(cpus).toFixed(3), cpuUsPerViewer: +((med(cpus) * 1000) / n).toFixed(2), bytesPerViewerFrame: Math.round(bytes / (n * frames)), heapGrowthKBPerFrame: +((heap1 - heap0) / 1024 / frames).toFixed(1), frameOk: got === n * frames };
  for (const ws of sockets) gw.websocket.close(ws);
  await gw.close(); await bus.close?.();
  return out;
}
const rows = [];
for (const n of sizes) { const r = await scenario(n); rows.push(r); if (!asJson) console.log(JSON.stringify(r)); }
if (asJson) console.log(JSON.stringify(rows));
process.exit(0);
