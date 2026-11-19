// A real server on an ephemeral port with a temp data dir, plus socket clients, for test/server.
import { join } from "node:path";
import { createServer } from "../../server/server.js";
import { createLogger } from "../../server/log.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus, subjects } from "../../server/bus/memory.js";
import { diskBlobs } from "../../server/blobs/disk.js";
import { authPort } from "../../server/auth/port.js";
import { devAuth } from "../../server/auth/dev.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy, roleCache } from "../../server/auth/tenancy.js";
import { Replica } from "../../packages/protocol/replica.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { tempDir, sleep, until, testNets } from "./helpers.js";
import { mkBoard } from "../auth/fixtures.js";

/**
 * The room host's heartbeat in tests (production default 2 s). Things a test waits for ride on it: the gateway's board feed
 * rebases onto a fold and catches up on the Store on the next heartbeat, and a waiting host's silence rule is 2 of them.
 * A test that depends on the production value passes its own `host.heartbeatMs`.
 */
export const HEARTBEAT_MS = 200;

/**
 * Every rig not yet stopped. A test that fails before its last line would leave a gateway and its sockets running:
 * test/preload.js stops them after every test, in every file.
 */
export const stopRigs = () => Promise.all([...testNets().rigs].map(r => r.stop()));

export const ROLES = ["owner", "editor", "annotator", "commenter", "viewer"];
/** Every dev token contains this, so a test can assert no token ever reaches a log line. */
export const SECRET = "S3CR3T";
export const tokenOf = name => `${SECRET}-${name}-token`;

/**
 * @param {{ verifyDelayMs?: number, cache?: object, wrapStore?: (s: object) => object, wrapAuth?: (a: object) => object,
 *   wrapRegistry?: (r: object) => object, wrapBus?: (b: object) => object, now?: () => number, timers?: object, limits?: object, host?: object, dir?: string, registry?: object, ids?: object }} [o]
 * `blobs`: the Blobs adapter (default: disk in `dir`; null: none). `server`: more createServer options (blobKey, quotaBytes, publicUrl).
 * Pass `dir`, `registry` and `ids` from an earlier rig to restart "the same server" on the same data.
 */
export async function rig(o = {}) {
  const live = testNets().rigs;
  const dir = o.dir ?? tempDir();
  const lines = [];
  const log = createLogger({ write: l => lines.push(l), level: "debug" });
  const registry = o.registry ?? memoryRegistry();
  const ids = o.ids ?? {};
  if (!o.ids) {
    const tenant = await registry.createTenant({ domain: "acme.test" });
    const board = await mkBoard(registry, { tenant: tenant.id, title: "all hands", memberRole: null });
    const other = await mkBoard(registry, { tenant: tenant.id, title: "no grants here", memberRole: null });
    Object.assign(ids, { tenant: tenant.id, board: board.id, otherBoard: other.id });
    for (const role of ROLES) await registry.setGrant(board.id, "dev:" + role, role);
    for (let i = 0; i < 8; i++) await registry.setGrant(board.id, "dev:editor" + i, "editor");
  }
  // One dev user per role (named after it), spare editors, and a stranger with a valid token but no role anywhere.
  const names = [...ROLES, ...Array.from({ length: 8 }, (_, i) => "editor" + i), "stranger"];
  const dev = devAuth({ enabled: true, tokens: Object.fromEntries(names.map(n => [tokenOf(n), { name: n }])) });
  // `o.cache`: roleCache options → hellos read through the role cache, as server/main.js wires it (p5-load).
  const clock = o.now ? { now: o.now } : {};   // the same clock reads links' and invites' expiry
  let auth = authPort({ dev, tenancy: o.cache ? roleCache({ registry, ...clock, ...o.cache }) : tenancy({ registry, ...clock }) });
  const calls = { verify: 0, role: 0, board: 0 };
  const cacheCalls = { rolesFor: 0, invalidate: 0 };
  const inner = auth;
  auth = {
    async verify(t) { calls.verify++; if (o.verifyDelayMs) await sleep(o.verifyDelayMs); return inner.verify(t); },
    async role(id, b) { calls.role++; return inner.role(id, b); },
    async access(id, b) { calls.role++; return inner.access(id, b); },
    ...(inner.rolesFor ? { async rolesFor(b, ids) { cacheCalls.rolesFor++; return inner.rolesFor(b, ids); } } : {}),
    ...(inner.invalidate ? { invalidate(b, u) { cacheCalls.invalidate++; return inner.invalidate(b, u); } } : {}),
  };
  if (o.wrapAuth) auth = o.wrapAuth(auth);
  let reg = { ...registry, async board(id) { calls.board++; return registry.board(id); } };
  if (o.wrapRegistry) reg = o.wrapRegistry(reg);
  const rawStore = sqliteStore({ path: join(dir, "plenary.db") });
  const store = o.wrapStore ? o.wrapStore(rawStore) : rawStore;
  const bus = (o.wrapBus ?? (b => b))(memoryBus({ onError: err => lines.push(JSON.stringify({ level: "error", msg: "bus", err: String(err) }) + "\n") }));
  // Everything a gateway hands to this board's room, seen from the room's side of the bus.
  const inbox = [];
  bus.subscribe(subjects.inbox(ids.tenant, ids.board), m => inbox.push(m));
  bus.subscribe(subjects.inbox(ids.tenant, ids.otherBoard), m => inbox.push(m));
  // Catch-up frames are the gateway's now (its board feed): the scaffold's room-host knobs map onto the feed's.
  const feed = { ...(o.host?.chunkBytes ? { chunkBytes: o.host.chunkBytes } : {}), ...(o.host?.tailFoldBytes ? { rebaseBytes: Math.max(1, Math.floor(o.host.tailFoldBytes / 4)) } : {}), ...(o.limits?.feed ?? {}) };
  const server = createServer({ auth, registry: reg, store, bus, ...(o.onWelcomed ? { onWelcomed: o.onWelcomed } : {}), blobs: o.blobs === undefined ? diskBlobs({ dir: join(dir, "blobs") }) : o.blobs, ...(o.server ?? {}), log, port: 0, limits: { opRate: 1e6, opBurst: 1e6, ...(o.limits ?? {}), feed }, host: { heartbeatMs: HEARTBEAT_MS, ...o.host }, ...(o.now ? { now: o.now } : {}), ...(o.timers ? { timers: o.timers } : {}) });   // the gateway's op pace is off unless a test sets it

  const self = {
    dir, lines, log, registry, ids, store, rawStore, bus, server, inbox, calls, cacheCalls,
    logs: () => lines.map(l => JSON.parse(l)),
    health: async () => { const res = await fetch(server.url + "/health"); return { status: res.status, body: await res.json() }; },
    /** The live Room for the test board (null if not open). */
    room: async () => (await server.rooms.peek(ids.tenant, ids.board))?.room ?? null,
    idle: () => server.rooms.idle(ids.tenant, ids.board),
    sock: () => sock(server.wsUrl),
    client: (name, cname) => client(self, name, cname),
    /** Idempotent: a test that stops its rig itself and the afterEach safety net both call it. */
    async stop({ keepStore = false } = {}) {
      if (!live.delete(self)) return;
      await server.stop(); await bus.close(); if (!keepStore) await rawStore.close();
    },
  };
  live.add(self);
  return self;
}

/** A raw WebSocket that records what it gets. */
export async function sock(url) {
  const ws = new WebSocket(url);
  const s = { ws, msgs: [], raw: [], closed: null, send: m => ws.send(typeof m === "string" || m instanceof Uint8Array ? m : JSON.stringify(m)) };
  ws.onmessage = e => { s.raw.push(e.data); try { s.msgs.push(JSON.parse(e.data)); } catch { s.msgs.push({ unparsable: true }); } };
  const done = new Promise(res => { ws.onclose = e => { s.closed = { code: e.code, reason: e.reason }; res(s.closed); }; });
  s.whenClosed = (ms = 30_000) => {
    let t;                                                   // cleared when the socket closes first, so no 30 s timer outlives the call
    const late = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("socket did not close")), ms); });
    return Promise.race([done, late]).finally(() => clearTimeout(t));
  };
  // Backstops, not expectations: generous so a loaded machine (other suites running) slows a test, not fails it.
  s.next = (pred, what = "a message", ms = 30_000) => until(() => s.msgs.find(pred), what, ms);
  s.close = () => { ws.close(); return done; };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("socket failed to open")); });
  ws.onerror = () => {};
  return s;
}

/**
 * A Replica on a real socket, driven the v1 way (packages/protocol/replica.js, "How to drive it"): after every
 * receive and local change, send what outgoing() returns; when wait() says so, call it again (the pace, the 10 s
 * answer timeout); when `resync` is set, close, wait reconnectWait() (capped by `maxWaitMs` so tests stay quick), and
 * open a new connection. `o.now`/`o.random` go to the Replica.
 */
export function client(rig, name, cname = name, o = {}) {
  const c = {
    name, r: new Replica({ client: cname, ...(o.now ? { now: o.now } : {}), ...(o.random ? { random: o.random } : {}) }),
    s: null, msgs: [], errors: [], connects: 0, wantOpen: false, timer: null, maxWaitMs: o.maxWaitMs ?? 50, board: o.board,
    drops: 0,   // bumped by every drop(): a socket that finishes opening after a drop is closed, never adopted (R6)
    // connect() and reconnect() each share one in-flight promise: a test loop that calls connect() while a resync
    // is reconnecting gets that same socket, never a second one racing it.
    connect() {
      if (c.connecting) return c.connecting;
      c.connecting = c.open_().finally(() => { c.connecting = null; });
      return c.connecting;
    },
    async open_() {
      c.wantOpen = true; c.connects++;
      const drops = c.drops;
      if (o.beforeOpen) await o.beforeOpen();
      const s = await sock(rig.server.wsUrl);
      // R6: a drop() while this socket was opening (the old one still looked open) set wantOpen false. Adopting this
      // socket anyway left an open socket nobody wanted, whose next resync was ignored. It is closed instead.
      if (c.drops !== drops) { s.close(); return c; }
      c.s = s;
      s.ws.onmessage = e => {
        if (c.s !== s) return;
        const m = jsonCodec.decode(e.data); c.msgs.push(m);
        if (m.t === "error") c.errors.push(m);
        c.r.receive(m);
        c.pump();
      };
      // A close the client didn't ask for counts as a failed attempt (rule 12); the test decides when to reconnect.
      const prev = s.ws.onclose;
      s.ws.onclose = e => { prev?.(e); if (c.s === s && !c.r.resync) c.r.connectionFailed(); };
      for (const m of c.r.connectMessages(tokenOf(name), c.board ?? rig.ids.board)) s.send(m);
      return c;
    },
    /** Send what the Replica wants sent now, and come back when it says to. Reconnects when it asks for a resync. */
    pump() {
      clearTimeout(c.timer); c.timer = null;
      if (c.r.resync) { if (c.wantOpen) c.reconnect().catch(() => {}); return; }
      if (!c.open) return;
      for (const m of c.r.outgoing()) c.s.send(m);
      if (c.r.resync) { if (c.wantOpen) c.reconnect().catch(() => {}); return; }
      const w = c.r.wait();
      if (w !== null) { c.timer = setTimeout(() => c.pump(), Math.max(1, w)); c.timer.unref?.(); }
    },
    async drop() { c.drops++; c.wantOpen = false; clearTimeout(c.timer); const s = c.s; c.s = null; if (s) await s.close(); },
    reconnect() {
      if (c.reconnecting) return c.reconnecting;
      c.reconnecting = (async () => { await c.drop(); await sleep(Math.min(c.r.reconnectWait(), c.maxWaitMs)); return c.connect(); })().finally(() => { c.reconnecting = null; });
      return c.reconnecting;
    },
    /** Between a drop and the new socket's hello: not open, but not done either. */
    get busy() { return !!(c.connecting || c.reconnecting); },
    get open() { return !!c.s && c.s.ws.readyState === WebSocket.OPEN; },
    /** A local change: shown at once, sent when the Replica's pace and catch-up allow. */
    send(stream, op) { const m = c.r.local(stream, op); c.pump(); return m; },
    /** A presence message (cursor, select, laser, emote; previews through Replica.preview). Sent as is when open. */
    presence(msg) { if (c.open) c.s.send({ t: "presence", ...msg }); },
  };
  return c;
}

/**
 * Wait until every connected client has nothing pending and has applied everything the room has. A client that is
 * reconnecting (a refused op makes its Replica start over with `since: 0`) is NOT settled: for a moment it has no
 * socket and an empty copy, and treating that as done was a race in this helper, not in the server.
 */
export async function settled(rig, clients, ms = 10000) {
  let end = 0;
  const done = c => !c.busy && !c.r.resync && (!c.open || (c.r.welcomed && c.r.pending.size === 0 && c.r.applied === end));
  try {
    await until(async () => {
      await rig.idle();
      // Viewers never open a room (rule 8): with none running, the Store's end is what everyone must reach.
      const room = await rig.room();
      end = room ? room.resolved : await rig.rawStore.lastSeq(rig.ids.tenant, rig.ids.board);
      return clients.every(done);
    }, "clients to settle", ms);
  } catch (err) {
    // Say who didn't settle and in what state, so a rare timeout can be diagnosed from one failure.
    const who = clients.filter(c => !done(c)).map(c => ({ name: c.r.client ?? c.name, busy: c.busy, resync: c.r.resync, open: c.open, welcomed: c.r.welcomed,
      pending: c.r.pending.size, applied: c.r.applied, end, connects: c.connects, wantOpen: c.wantOpen, wait: c.r.wait?.(), errors: c.errors.slice(-3), last: c.msgs.slice(-3).map(m => m.t) }));
    throw new Error(`${err.message}: ${JSON.stringify(who)}`);
  }
}

/** The room's state in the shape of Replica.state(). */
export function roomState(room) {
  const out = { applied: room.resolved };
  for (const s of ["board", "notes"]) { const d = room.streams[s]; out[s] = { elements: [...d.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), appState: d.appState.herdr }; }
  return out;
}

/**
 * A WebSocket client on a raw TCP socket that can stop reading (a browser or Bun WebSocket always reads). After
 * the handshake it is paused: the server's frames pile up in the kernel, then in the server. `send` writes one
 * masked text frame; `read()` starts reading and counts bytes; `closed` resolves when the server hangs up.
 * With `{ frames: true }` it also parses what it reads into `texts` (each text message, decoded).
 */
export async function rawSock(wsUrl, { frames = false } = {}) {
  const net = await import("node:net");
  const u = new URL(wsUrl);
  const socket = net.connect(Number(u.port), u.hostname);
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  socket.on("error", () => {});
  socket.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  // The 101 response, read whole; whatever came after it in the same chunks is the first frames: put back.
  let head = Buffer.alloc(0);
  while (head.indexOf("\r\n\r\n") < 0) head = Buffer.concat([head, await new Promise(res => socket.once("data", res))]);
  socket.pause();
  const rest = head.subarray(head.indexOf("\r\n\r\n") + 4);
  if (rest.length) socket.unshift(rest);
  const s = { socket, got: 0, ended: false };
  if (frames) {
    // Optional: parse the server's (unmasked) frames into `s.texts`, so a test can check what arrived, whatever its
    // size (Bun's own client refuses a message over 128 MiB). Only text frames are kept; pings are counted (`s.pings`).
    s.texts = []; s.pings = 0; let parts = [], have = 0, need = -1, hdr = 0, op = 0;
    const flat = () => { if (parts.length > 1) parts = [Buffer.concat(parts)]; return parts[0]; };
    s.parse = d => {
      parts.push(d); have += d.length;
      for (;;) {
        if (need < 0) {                                  // a frame header: 2, 4 or 10 bytes (server frames are unmasked)
          if (have < 2) return;
          const b = flat(), l7 = b[1] & 127;
          hdr = l7 < 126 ? 2 : l7 === 126 ? 4 : 10;
          if (have < hdr) return;
          op = b[0] & 15; need = l7 < 126 ? l7 : l7 === 126 ? b.readUInt16BE(2) : Number(b.readBigUInt64BE(2));
        }
        if (have < hdr + need) return;                   // the payload isn't all here yet (no concat until it is)
        const b = flat();
        if (op === 1) s.texts.push(b.toString("utf8", hdr, hdr + need));
        else if (op === 9) s.pings++;                    // the server's keep-alive ping (never answered: no pong is sent)
        const left = b.subarray(hdr + need); parts = left.length ? [left] : []; have = left.length; need = -1;
      }
    };
  }
  s.closed = new Promise(res => socket.once("close", () => { s.ended = true; res(); }));
  s.send = msg => {
    if (s.ended) return;
    const p = Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg)), mask = [7, 11, 13, 17];
    const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length, ...mask]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255, ...mask]);
    const body = Buffer.from(p); for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    socket.write(Buffer.concat([head, body]));
  };
  const take = d => { s.got += d.length; s.parse?.(d); };
  s.read = () => { clearInterval(s.trickling); socket.on("data", take); socket.resume(); };
  /** Read only `bytes` every `ms`: a reader that is alive but far too slow (the kernel's buffer stays full). */
  s.trickle = (bytes, ms) => { s.trickling = setInterval(() => { const d = socket.read(bytes) ?? socket.read(); if (d) take(d); }, ms); };
  s.destroy = () => { clearInterval(s.trickling); socket.destroy(); };
  return s;
}
