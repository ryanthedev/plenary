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
import { tenancy } from "../../server/auth/tenancy.js";
import { Replica } from "../../packages/protocol/replica.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { tempDir, sleep, until } from "./helpers.js";

export const ROLES = ["owner", "editor", "annotator", "commenter", "viewer"];
/** Every dev token contains this, so a test can assert no token ever reaches a log line. */
export const SECRET = "S3CR3T";
export const tokenOf = name => `${SECRET}-${name}-token`;

/**
 * @param {{ verifyDelayMs?: number, wrapStore?: (s: object) => object, wrapAuth?: (a: object) => object,
 *   wrapRegistry?: (r: object) => object, wrapBus?: (b: object) => object, limits?: object, host?: object, dir?: string, registry?: object, ids?: object }} [o]
 * Pass `dir`, `registry` and `ids` from an earlier rig to restart "the same server" on the same data.
 */
export async function rig(o = {}) {
  const dir = o.dir ?? tempDir();
  const lines = [];
  const log = createLogger({ write: l => lines.push(l), level: "debug" });
  const registry = o.registry ?? memoryRegistry();
  const ids = o.ids ?? {};
  if (!o.ids) {
    const tenant = await registry.createTenant({ domain: "acme.test" });
    const board = await registry.createBoard({ tenant: tenant.id, title: "all hands", memberRole: null });
    const other = await registry.createBoard({ tenant: tenant.id, title: "no grants here", memberRole: null });
    Object.assign(ids, { tenant: tenant.id, board: board.id, otherBoard: other.id });
    for (const role of ROLES) await registry.setGrant(board.id, "dev:" + role, role);
    for (let i = 0; i < 8; i++) await registry.setGrant(board.id, "dev:editor" + i, "editor");
  }
  // One dev user per role (named after it), spare editors, and a stranger with a valid token but no role anywhere.
  const names = [...ROLES, ...Array.from({ length: 8 }, (_, i) => "editor" + i), "stranger"];
  const dev = devAuth({ enabled: true, tokens: Object.fromEntries(names.map(n => [tokenOf(n), { name: n }])) });
  let auth = authPort({ dev, tenancy: tenancy({ registry }) });
  const calls = { verify: 0, role: 0, board: 0 };
  const inner = auth;
  auth = {
    async verify(t) { calls.verify++; if (o.verifyDelayMs) await sleep(o.verifyDelayMs); return inner.verify(t); },
    async role(id, b) { calls.role++; return inner.role(id, b); },
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
  const server = createServer({ auth, registry: reg, store, bus, blobs: diskBlobs({ dir: join(dir, "blobs") }), log, port: 0, limits: o.limits, host: o.host });

  const self = {
    dir, lines, log, registry, ids, store, rawStore, bus, server, inbox, calls,
    logs: () => lines.map(l => JSON.parse(l)),
    health: async () => { const res = await fetch(server.url + "/health"); return { status: res.status, body: await res.json() }; },
    /** The live Room for the test board (null if not open). */
    room: async () => (await server.rooms.peek(ids.tenant, ids.board))?.room ?? null,
    idle: () => server.rooms.idle(ids.tenant, ids.board),
    sock: () => sock(server.wsUrl),
    client: (name, cname) => client(self, name, cname),
    async stop({ keepStore = false } = {}) { await server.stop(); await bus.close(); if (!keepStore) await rawStore.close(); },
  };
  return self;
}

/** A raw WebSocket that records what it gets. */
export async function sock(url) {
  const ws = new WebSocket(url);
  const s = { ws, msgs: [], raw: [], closed: null, send: m => ws.send(typeof m === "string" || m instanceof Uint8Array ? m : JSON.stringify(m)) };
  ws.onmessage = e => { s.raw.push(e.data); try { s.msgs.push(JSON.parse(e.data)); } catch { s.msgs.push({ unparsable: true }); } };
  const done = new Promise(res => { ws.onclose = e => { s.closed = { code: e.code, reason: e.reason }; res(s.closed); }; });
  s.whenClosed = (ms = 30_000) => Promise.race([done, sleep(ms).then(() => { throw new Error("socket did not close"); })]);
  // Backstops, not expectations: generous so a loaded machine (other suites running) slows a test, not fails it.
  s.next = (pred, what = "a message", ms = 30_000) => until(() => s.msgs.find(pred), what, ms);
  s.close = () => { ws.close(); return done; };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("socket failed to open")); });
  ws.onerror = () => {};
  return s;
}

/** A Replica on a real socket: connects, resends, reconnects when the Replica asks for a resync. */
export function client(rig, name, cname = name) {
  const c = {
    name, r: new Replica({ client: cname }), s: null, msgs: [], errors: [], connects: 0, wantOpen: false,
    // connect() and reconnect() each share one in-flight promise: a test loop that calls connect() while a resync
    // is reconnecting gets that same socket, never a second one racing it.
    connect() {
      if (c.connecting) return c.connecting;
      c.connecting = c.open_().finally(() => { c.connecting = null; });
      return c.connecting;
    },
    async open_() {
      c.wantOpen = true; c.connects++;
      const s = await sock(rig.server.wsUrl); c.s = s;
      s.ws.onmessage = e => {
        if (c.s !== s) return;
        const m = jsonCodec.decode(e.data); c.msgs.push(m);
        if (m.t === "error") c.errors.push(m);
        c.r.receive(m);
        if (c.r.resync) c.reconnect().catch(() => {});
      };
      for (const m of c.r.connectMessages(tokenOf(name), rig.ids.board)) s.send(m);
      return c;
    },
    async drop() { c.wantOpen = false; const s = c.s; c.s = null; if (s) await s.close(); },
    reconnect() {
      if (c.reconnecting) return c.reconnecting;
      c.reconnecting = (async () => { await c.drop(); return c.connect(); })().finally(() => { c.reconnecting = null; });
      return c.reconnecting;
    },
    /** Between a drop and the new socket's hello: not open, but not done either. */
    get busy() { return !!(c.connecting || c.reconnecting); },
    get open() { return !!c.s && c.s.ws.readyState === WebSocket.OPEN; },
    /** A local change: shown at once, sent if connected (else resent on the next connect). */
    send(stream, op) { const m = c.r.local(stream, op); if (c.open) c.s.send(m); return m; },
  };
  return c;
}

/**
 * Wait until every connected client has nothing pending and has applied everything the room has. A client that is
 * reconnecting (a refused op makes its Replica start over with `since: 0`) is NOT settled: for a moment it has no
 * socket and an empty copy, and treating that as done was a race in this helper, not in the server.
 */
export async function settled(rig, clients, ms = 10000) {
  await until(async () => {
    await rig.idle();
    const room = await rig.room();
    if (!room) return false;
    return clients.every(c => !c.busy && !c.r.resync && (!c.open || (c.r.pending.size === 0 && c.r.applied === room.seq)));
  }, "clients to settle", ms);
}

/** The room's state in the shape of Replica.state(). */
export function roomState(room) {
  const out = { applied: room.seq };
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
    // size (Bun's own client refuses a message over 128 MiB). Only text frames are kept; others are skipped.
    s.texts = []; let parts = [], have = 0, need = -1, hdr = 0, op = 0;
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
