// Roles (p4-wire): createServer({ roles }) as a gateway only, a host only, or both, in process, several nodes sharing
// one memory bus and one SQLite file (the cluster's shape without Postgres or NATS). A gateway-only node opens a board
// by asking the hosts over the bus (`plen-hosts.open`, room-host.js remoteRooms).
import { test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { createServer } from "../../server/adapters/driving/server.js";
import { createLogger } from "../../server/core/log.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { remoteRooms } from "../../server/core/room-host.js";
import { authPort } from "../../server/ports/auth.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { tenancy } from "../../server/core/auth/tenancy.js";
import { makeElement } from "../../packages/core/model.js";
import { sock } from "./rig.js";
import { tempDir, cleanup, sleep, until } from "./helpers.js";
import { mkBoard } from "../auth/fixtures.js";

afterAll(cleanup);

const TTL = 3_000;   // a node drops its room after a stall of 2/3 of it: 2 s of event-loop stall is tolerated
const tok = name => `S3CR3T-roles-${name}`;
const rect = (id, x) => makeElement("rectangle", { id, x, y: 0, width: 10, height: 10 });
const op = (client, k) => ({ t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [rect(`${client}-${k}`, k)] } });

/** A cluster in one process: one bus, one registry, one SQLite file; nodes added with node(roles). */
async function cluster() {
  const dir = tempDir(), bus = memoryBus(), registry = memoryRegistry();
  const tenant = await registry.createTenant({ domain: "acme.test" });
  const board = await mkBoard(registry, { tenant: tenant.id, title: "roles", memberRole: null });
  const names = ["ed1", "ed2", "ed3", "ed4", "ed5"];
  for (const n of names) await registry.setGrant(board.id, "dev:" + n, "editor");
  const dev = devAuth({ enabled: true, tokens: Object.fromEntries(names.map(n => [tok(n), { name: n }])) });
  const auth = authPort({ dev, tenancy: tenancy({ registry }) });
  const nodes = [], stores = [];
  const c = {
    bus, registry, tenant: tenant.id, board: board.id, nodes,
    node(roles, name = `n${nodes.length + 1}`, { ttl = TTL } = {}) {
      const lines = [];
      const store = sqliteStore({ path: join(dir, "plenary.db") });
      stores.push(store);
      const server = createServer({ auth, registry, store, bus, log: createLogger({ write: l => lines.push(l), level: "debug" }), port: 0, static: false,
        roles, node: name, limits: { opRate: 1e6, opBurst: 1e6 }, host: { hostname: name, leaseTtlMs: ttl, heartbeatMs: 100 } });
      const n = { server, lines, name, stopped: false, async stop() { if (!n.stopped) { n.stopped = true; await server.stop(); } } };
      nodes.push(n);
      return n;
    },
    async stop() { for (const n of nodes) await n.stop(); await bus.close(); for (const s of stores) await s.close(); },
  };
  return c;
}

const hello = (s, c, name, client = name) => s.send({ t: "hello", v: 1, token: tok(name), board: c.board, since: 0, client });

/**
 * A writer's hello, retried on `unavailable` (1013) the way a real client retries: on a cold board two hosts race
 * for the lease, and a watcher may answer the open first; the hello then waits on the watcher and is answered
 * 1013 when the holder's room opens (room-host MEDIUM-2). Returns the welcomed socket and how many tries it took.
 */
async function welcomed(node, c, name, ms = TTL + 30_000) {
  const end = Date.now() + ms;
  for (let tries = 1; ; tries++) {
    const s = await sock(node.server.wsUrl);
    hello(s, c, name);
    const got = await until(() => s.msgs.find(m => m.t === "welcome") ?? (s.closed ? "closed" : null), "a welcome or a close", Math.max(1, end - Date.now())).catch(() => "timeout");
    if (got !== "closed" && got !== "timeout") return { s, tries };
    if (got === "closed") { expect(s.closed.code).toBe(1013); expect(s.msgs.filter(m => m.t === "error").map(m => m.code)).toEqual(["unavailable"]); }
    else s.close();
    if (Date.now() >= end) throw new Error(`${name}: no welcome within ${ms} ms`);
  }
}

test("gateway, gateway, host: writers on the two gateways converge on one board; the host-only node answers 404 on /ws", async () => {
  const c = await cluster();
  try {
    const g1 = c.node({ gateway: true, host: false }), g2 = c.node({ gateway: true, host: false }), h = c.node({ gateway: false, host: true });
    // The host-only node: /health yes, /ws and every other route no; no gateway made.
    const health = await (await fetch(h.server.url + "/health")).json();
    expect(health).toMatchObject({ ok: true, roles: { gateway: false, host: true }, gateway: null });
    expect((await fetch(h.server.url + "/ws")).status).toBe(404);
    expect((await fetch(h.server.url + "/ws", { headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })).status).toBe(404);
    expect((await fetch(h.server.url + "/boards", { method: "POST" })).status).toBe(404);
    expect((await fetch(h.server.url + "/")).status).toBe(404);
    expect(h.server.gateway).toBe(null);
    // A gateway-only node holds no room and never takes a lease.
    expect((await (await fetch(g1.server.url + "/health")).json()).roles).toEqual({ gateway: true, host: false });

    const a = await welcomed(g1, c, "ed1"), b = await welcomed(g2, c, "ed2");
    expect([a.tries, b.tries]).toEqual([1, 1]);   // one host: no race, no retry
    for (let k = 1; k <= 20; k++) { a.s.send(op("ed1", k)); b.s.send(op("ed2", k)); }
    for (const [s, n] of [[a.s, "ed1"], [b.s, "ed2"]]) await s.next(m => m.t === "ack" && m.id === `${n}:20`, "last ack", 10000);
    const logOf = s => new Map(s.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).map(e => [e.seq, e.id]));
    await until(() => logOf(a.s).size === 40 && logOf(b.s).size === 40, "40 entries on both sockets", 10000);
    expect([...logOf(a.s)].sort((x, y) => x[0] - y[0])).toEqual([...logOf(b.s)].sort((x, y) => x[0] - y[0]));
    expect([...logOf(a.s).keys()].sort((x, y) => x - y)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (const [s, n] of [[a.s, "ed1"], [b.s, "ed2"]]) {
      expect(s.msgs.filter(m => m.t === "ack").map(m => m.id)).toEqual(Array.from({ length: 20 }, (_, k) => `${n}:${k + 1}`));
      expect(s.msgs.filter(m => m.t === "error")).toEqual([]);
    }
    // One sequencer, on the host; the gateways hold none.
    expect([g1, g2, h].map(n => n.server.rooms.stats().rooms)).toEqual([0, 0, 1]);
  } finally { await c.stop(); }
}, 30000);

test("a gateway-only node with no host answers a writer's hello `unavailable` once the ttl passes without a host", async () => {
  const c = await cluster();
  try {
    const g = c.node({ gateway: true, host: false });
    const s = await sock(g.server.wsUrl);
    hello(s, c, "ed1");
    const closed = await s.whenClosed(30_000);   // the bound itself (the open rejects at the ttl) is counted on fake timers below
    expect(closed.code).toBe(1013);
    expect(s.msgs.filter(m => m.t === "error").map(m => m.code)).toEqual(["unavailable"]);
    expect(g.lines.map(l => JSON.parse(l)).find(l => l.msg === "hello failed")).toMatchObject({ what: "room" });
  } finally { await c.stop(); }
}, 45000);   // above the 30 s wait for the close; the real wait is the 3 s ttl

test("gateway-only plus two hosts: one welcome and one ack per op; after the holder stops, the next writer is welcomed by the other", async () => {
  const c = await cluster();
  try {
    const g = c.node({ gateway: true, host: false }), h1 = c.node({ gateway: false, host: true }), h2 = c.node({ gateway: false, host: true });
    const { s } = await welcomed(g, c, "ed1");
    // Both hosts heard the broadcast: one holds the board, the other watches it.
    await until(() => [h1, h2].map(n => n.server.rooms.stats()).every(x => x.rooms + x.waiting === 1), "one holder and one watcher", 3000);
    for (let k = 1; k <= 15; k++) { s.send(op("ed1", k)); await sleep(5); }
    await s.next(m => m.t === "ack" && m.id === "ed1:15", "last ack", 10000);
    await sleep(300);   // room for a duplicate to show up
    expect(s.msgs.filter(m => m.t === "welcome").length).toBe(1);
    expect(s.msgs.filter(m => m.t === "ack").map(m => m.id)).toEqual(Array.from({ length: 15 }, (_, k) => `ed1:${k + 1}`));
    expect(s.msgs.filter(m => m.t === "error")).toEqual([]);
    // A second writer while both hosts run (the board is warm now): welcomed at once, through the same broadcast.
    const second = await welcomed(g, c, "ed2");
    expect(second.tries).toBe(1);
    second.s.send(op("ed2", 1));
    await second.s.next(m => m.t === "ack" && m.id === "ed2:1");
    expect(second.s.msgs.filter(m => m.t === "ack").length).toBe(1);

    const holder = [h1, h2].find(n => n.server.rooms.stats().rooms === 1), other = holder === h1 ? h2 : h1;
    await holder.stop();
    await until(() => other.server.rooms.stats().rooms === 1, "the other host takes the board", TTL + 30_000);
    const next = await sock(g.server.wsUrl);
    hello(next, c, "ed3");
    const w = await next.next(m => m.t === "welcome", "a welcome from the other host", TTL + 30_000);
    expect(w.seq).toBe(16);   // everything the first holder acked is there
    next.send(op("ed3", 1));
    expect(await next.next(m => m.t === "ack")).toEqual({ t: "ack", id: "ed3:1", seq: 17 });
    expect(next.msgs.filter(m => m.t === "welcome").length).toBe(1);
  } finally { await c.stop(); }
}, 30000);

test("remote open: one request in flight per board per gateway; never cached (every hello asks again)", async () => {
  const c = await cluster();
  try {
    const g = c.node({ gateway: true, host: false });
    c.node({ gateway: false, host: true });
    const asks = [];
    c.bus.subscribe("plen-hosts.open", m => asks.push(m));
    const rooms = g.server.rooms;
    const [x, y, z] = await Promise.all([rooms.open(c.tenant, c.board), rooms.open(c.tenant, c.board), rooms.open(c.tenant, c.board)]);
    expect([x, y, z]).toEqual(["held", "held", "held"]);
    await c.bus.flush();
    expect(asks.length).toBe(1);
    expect(await rooms.open(c.tenant, c.board)).toBe("held");
    await c.bus.flush();
    expect(asks.length).toBe(2);
    expect(asks[0]).toMatchObject({ tenant: c.tenant, board: c.board, gateway: rooms.requester, n: 1 });
    expect(rooms.requester).toMatch(/^r-n1-[0-9a-f]{8}$/);
  } finally { await c.stop(); }
}, 10000);

// ---- round 2: "held" wins at once; "watching" waits out a grace of min(1000, ttl / 4); no reply rejects at the ttl ----

/** Timers that run only when the test advances them: the ttl and the grace are counted, never waited for. */
function fakeTimers() {
  let now = 0, id = 0; const q = new Map();
  return {
    setTimeout: (fn, ms) => { const h = ++id; q.set(h, { at: now + ms, fn }); return h; },
    clearTimeout: h => { q.delete(h); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
/** A fake host on the bus that answers every open with `state` after `ms` of the fake clock (it never opens anything). */
const fakeAnswer = (bus, timers, state, ms = 0) => bus.subscribe("plen-hosts.open", m => {
  const send = () => bus.publish(`plen-hosts.opened.${m.gateway}`, { n: m.n, board: m.board, state });
  if (ms) timers.setTimeout(send, ms); else send();
});
/** A gateway's remote rooms on a bus and fake timers, and a way to see whether an open has settled. */
function remote(ttl) {
  const bus = memoryBus(), timers = fakeTimers();
  const rooms = remoteRooms({ bus, node: "g1", timeoutMs: ttl, timers });
  const track = p => { const o = { state: "pending" }; p.then(v => { o.state = v; }, e => { o.state = e.code; }); return o; };
  const flush = async () => { await bus.flush(); await bus.flush(); await Promise.resolve(); };
  return { bus, timers, rooms, track, flush };
}

test("round 2: with two hosts on a cold board a `held` reply resolves the open well before the grace ends", async () => {
  const c = await cluster();
  try {
    const g = c.node({ gateway: true, host: false }, "g1", { ttl: 4000 });
    const h = [c.node({ gateway: false, host: true }, "h1", { ttl: 4000 }), c.node({ gateway: false, host: true }, "h2", { ttl: 4000 })];
    const replies = [];
    c.bus.subscribe(`plen-hosts.opened.${g.server.rooms.requester}`, m => replies.push(m.state));
    expect(g.server.rooms.graceMs).toBe(1000);
    expect(await g.server.rooms.open(c.tenant, c.board)).toBe("held");   // (that it beats the grace is counted on fake timers below)
    await until(() => replies.length === 2, "both hosts' replies");
    expect(replies.sort()).toEqual(["held", "watching"]);   // the watcher answered too, and did not decide it
    expect(h.map(n => n.server.rooms.stats().rooms).sort()).toEqual([0, 1]);
  } finally { await c.stop(); }
}, 10000);

test("round 2: watcher-only replies resolve at the grace, not before; a `held` during the grace resolves at once", async () => {
  const { bus, timers, rooms, track, flush } = remote(4000);
  const unsub = fakeAnswer(bus, timers, "watching");
  const first = track(rooms.open("t", "b")); await flush();
  timers.advance(rooms.graceMs - 1); await flush();
  expect(first.state).toBe("pending");                                    // the grace has not ended
  timers.advance(1); await flush();
  expect(first.state).toBe("watching");
  unsub();
  // "watching" at once, "held" 200 ms later: resolved by the held reply, long before the grace.
  const u1 = fakeAnswer(bus, timers, "watching"), u2 = fakeAnswer(bus, timers, "held", 200);
  const second = track(rooms.open("t", "b")); await flush();
  timers.advance(199); await flush();
  expect(second.state).toBe("pending");
  timers.advance(1); await flush();
  expect(second.state).toBe("held");
  u1(); u2(); await rooms.close(); await bus.close();
});

test("round 2: a `held` reply resolves the open with no timer run at all, not at the grace", async () => {
  const { bus, timers, rooms, track, flush } = remote(4000);
  fakeAnswer(bus, timers, "held");
  const o = track(rooms.open("t", "b")); await flush();
  expect(o.state).toBe("held");                                           // the fake clock never moved
  await rooms.close(); await bus.close();
});

test("round 2: no reply at all rejects at the ttl (grace min(1000, ttl / 4) never fires without a reply)", async () => {
  const { bus, timers, rooms, track, flush } = remote(800);
  expect(rooms.graceMs).toBe(200);
  const o = track(rooms.open("t", "b")); await flush();
  timers.advance(799); await flush();
  expect(o.state).toBe("pending");
  timers.advance(1); await flush();
  expect(o.state).toBe("unavailable");
  await rooms.close(); await bus.close();
});
