// @ts-check
// Transport adapter: an in-process reference room (packages/protocol's Room behind a gateway stand-in), for the dev
// page, the no-SharedWorker fallback and the tests. Implements web/ports/transport.js (one transport per join()) and
// web/ports/net.js (localNet). The one adapter allowed to import packages/protocol's Room, ports and presence rules
// (ws.js imports only the codec); core/sync.js is the core's only importer (the protocol seam).
//
// Bufferless: delivery is an in-memory queue with no uplink, so congested() is always false and backlogBytes() 0.
// Generation: every connection of a link has its own generation (link.gen); whatever an older one queued or the
// room still answers on it is never delivered (the transport contract), checked where the room's send lands.

import { Room } from "../../../packages/protocol/room.js";
import { tableAuth, MemoryLog } from "../../../packages/protocol/ports.js";
import { presenceProblem, presenceLimiter } from "../../../packages/protocol/presence.js";
import { jsonCodec } from "../../../packages/protocol/codec.js";
import { streamState, fullState, seeded } from "../../core/sync.js";

const RANK = { owner: 0, editor: 1, annotator: 2, commenter: 3, viewer: 4 };

/**
 * An in-process reference room behind a gateway stand-in, with its own little network, for the dev page and
 * tests. Every message crosses the JSON codec; each link keeps its order (a WebSocket). The stand-in does
 * what a gateway does (rule 8): checks the token (refusing with `auth` itself), hands the room only
 * `{ user, role }` and `n`, and relays presence to the other links (rate-limited, checked; never to the room).
 * Delivery is queued, never synchronous: the room answers inside Editor.commit otherwise. `auto: true`
 * delivers on a microtask (the page); tests call `settle()` (or `step()` to interleave links). Which link
 * goes next is drawn from `seed`.
 * `clock: true` gives a virtual clock: pass `net.now` and `net.timers` to bindEditor, and `settle()` fires
 * due timers (advancing the clock) whenever the network is idle; `advance(ms)` moves it by hand.
 * Timers and deadlines: only with `clock: true` does the network have a virtual clock (net.clock, net.timers; settle()
 * fires due timers). With the default `clock: false` it uses the wall clock (Date.now) and its timers are never fired
 * by settle(), so a test of anything time-based (watchdogs, backoff, presence expiry) must pass `clock: true` and
 * hand `net.clock` to bindEditor / createSession (p6-hexv).
 * `makeRoom` (tests): replaces the Room with any far side of the same shape ({ connect(send) → conn, receive(conn, msg,
 * meta), disconnect(conn) }), so the transport contract can drive the link logic itself (test/web/adapters/transport-local).
 * @param {{ board?: string, tenant?: string, users: Record<string, { user: string, role: string, name?: string }>, auto?: boolean, seed?: number, clock?: boolean,
 *           makeRoom?: (o: { board: string, tenant: string, log: Record<string, any>, now: () => number }) => Record<string, any> }} o
 */
export function localRoom({ board = "b1", tenant = "t1", users, auto = false, seed = 1, clock = false, makeRoom = null }) {
  const time = { t: 0, q: [], n: 0 };
  const now = clock ? () => time.t : Date.now;
  const timers = {
    set: (fn, ms) => { const h = ++time.n; time.q.push({ h, at: time.t + Math.max(0, ms), fn }); return h; },
    clear: h => { time.q = time.q.filter(x => x.h !== h); },
  };
  const log = new MemoryLog();
  const room = makeRoom ? makeRoom({ board, tenant, log, now }) : new Room({ board, tenant, log, now });
  const auth = tableAuth(users);
  const wire = m => jsonCodec.decode(jsonCodec.encode(m));
  const links = [], own = seeded(seed), presence = [];
  // The clients' jitter source (a stream apart from delivery order, so handing it out changes no delivery).
  const random = seeded(seed + 0x9e37);
  /** The clock port's shape over this network's time (virtual with `clock: true`), for bindEditor / createSession. */
  const clockPort = { now, mono: now, set: timers.set, clear: timers.clear, random };
  let scheduled = false;
  const kick = () => { if (auto && !scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; settle(); }); } };

  // Presence to every other welcomed link, as one gateway batch.
  function relay(from, m) {
    for (const l of links) if (l !== from && l.conn?.user) { l.down.push(wire({ t: "presence", batch: [m] })); kick(); }
  }
  function leave(link) { if (link.conn?.user) relay(link, { user: link.conn.user, client: link.conn.client, k: "leave" }); }

  // `here` and `emotes` as a gateway sends them (PROTOCOL.md § Presence), simplified for one in-page gateway: no
  // pacing. Writers = users with a writer connection (a user's tabs count once), viewers = viewer connections. On a
  // change every welcomed link gets `here`: with the writer list when it changed, else count-only (no `writers`);
  // a joiner always gets the list. Viewers' emotes are summed per 500 ms window into `emotes`, never relayed.
  let hereLast = null;
  function hereNow() {
    const by = new Map(); let viewers = 0;
    for (const l of links) {
      if (!l.who) continue;
      if (l.who.role === "viewer") { viewers++; continue; }
      const w = by.get(l.who.user);
      if (!w || RANK[l.who.role] < RANK[w.role]) by.set(l.who.user, { user: l.who.user, name: l.who.name ?? l.who.user, role: l.who.role });
    }
    const writers = [...by.values()].sort((a, b) => RANK[a.role] - RANK[b.role] || (a.user < b.user ? -1 : 1)).slice(0, 50);
    return { writers, writerCount: by.size, viewers };
  }
  function hereSend(joiner = null) {
    const h = hereNow(), list = JSON.stringify(h.writers), was = hereLast;
    hereLast = { list, writerCount: h.writerCount, viewers: h.viewers };
    const listChanged = !was || was.list !== list, changed = listChanged || was.writerCount !== h.writerCount || was.viewers !== h.viewers;
    for (const l of links) {
      if (!l.who || !l.conn) continue;
      if (l === joiner || listChanged) l.down.push(wire({ t: "here", ...h }));
      else if (changed) l.down.push(wire({ t: "here", writerCount: h.writerCount, viewers: h.viewers }));
      else continue;
      kick();
    }
  }
  const later = (fn, ms) => (clock ? timers.set(fn, ms) : setTimeout(fn, ms));
  let emoteWindow = null;
  function countEmote(e) {
    if (!emoteWindow) {
      emoteWindow = {};
      later(() => {
        const counts = emoteWindow; emoteWindow = null;
        for (const l of links) if (l.who && l.conn) { l.down.push(wire({ t: "emotes", counts })); kick(); }
      }, 500);
    }
    emoteWindow[e] = (emoteWindow[e] ?? 0) + 1;
  }

  // A message from a client, as the gateway hands it on.
  function up(link, msg) {
    if (msg.t === "hello") {
      const who = auth.check(msg.token, msg.board);
      if (!who) { link.down.push(wire({ t: "error", code: "auth", message: "token refused" })); kick(); return; }
      const { token, ...hello } = msg;
      const r = room.receive(link.conn, hello, { n: ++link.n, ...who });
      link.who = { user: who.user, role: who.role, name: users[msg.token]?.name ?? /** @type {{ name?: string }} */ (who).name ?? who.user };
      hereSend(link);
      return r;
    }
    if (msg.t === "presence") {
      const c = link.conn, ok = !!c.user && presenceProblem(msg, c.role) === null && link.limiter.allow(msg.k);
      presence.push({ user: c.user, msg, ok });
      if (ok && msg.k === "emote" && c.role === "viewer") countEmote(msg.e);
      else if (ok) { const { t, ...rest } = msg; relay(link, { user: c.user, client: c.client, ...rest }); }
      return;
    }
    room.receive(link.conn, msg, { n: ++link.n });
  }

  function join() {
    const link = { up: [], down: [], handler: () => {}, dropped: () => {}, conn: null, gen: 0, n: 0, limiter: presenceLimiter(now), done: false, who: null };
    // Every connection has its own generation: whatever the old one queued or still answers is never
    // delivered once it is dropped (the transport contract in this file's header).
    const drop = () => {
      if (link.conn) { leave(link); room.disconnect(link.conn); }
      link.conn = null; link.gen++; link.up = []; link.down = [];
      if (link.who) { link.who = null; hereSend(); }
    };
    const open = () => {
      if (link.done) return;
      drop();
      const gen = link.gen;
      link.n = 0; link.limiter = presenceLimiter(now);
      link.conn = room.connect(m => { if (link.gen === gen) { link.down.push(wire(m)); kick(); } });
    };
    open();
    links.push(link);
    return {
      send: m => { if (link.conn) { link.up.push(wire(m)); kick(); } },
      onMessage: fn => { link.handler = fn; },
      onDrop: fn => { link.dropped = fn; },
      reopen: open,
      /** Bufferless (an in-memory queue, no uplink): never congested, no backlog. */
      congested: () => false,
      backlogBytes: () => 0,
      /** Finished for good: the link leaves the network. */
      close: () => { drop(); link.done = true; const i = links.indexOf(link); if (i >= 0) links.splice(i, 1); },
      /** Test hook: drop whatever is queued toward the client (a lost message). */
      lose: () => { link.down = []; },
      /** Test hook: the connection drops without the client asking (a socket closing); the client is told. */
      fail: () => { if (!link.conn) return; drop(); link.dropped(); },
    };
  }

  // One delivery on one link (client → room or room → client). False when nothing is queued.
  function step(rng = own) {
    const busy = links.filter(l => l.conn && (l.up.length || l.down.length));
    if (!busy.length) return false;
    const l = busy[Math.floor(rng() * busy.length)];
    if (l.up.length && (!l.down.length || rng() < 0.5)) up(l, l.up.shift());
    else l.handler(l.down.shift());
    return true;
  }
  // The earliest due timer (virtual clock), the clock moved to it. False when none is set.
  function tick(until = Infinity) {
    if (!time.q.length) return false;
    const next = time.q.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.h < a.h) ? b : a));
    if (next.at > until) return false;
    time.q = time.q.filter(x => x !== next);
    time.t = Math.max(time.t, next.at);
    next.fn();
    return true;
  }
  function settle(rng = own) {
    let n = 0;
    for (;;) {
      while (step(rng)) if (++n > 1_000_000) throw new Error("network never settled");
      if (!clock || !tick()) return;
      if (++n > 1_000_000) throw new Error("timers never settled");
    }
  }
  /** Test hook: hand the room every queued client → room message (links in join order), delivering nothing toward
   *  the clients: what the room answers stays queued until step()/settle(). */
  function deliverUp() { for (const l of links) while (l.conn && l.up.length) up(l, l.up.shift()); }
  /** Move the virtual clock by `ms`, firing the timers due on the way (no deliveries). */
  function advance(ms) { const until = time.t + ms; while (tick(until)); time.t = until; }

  /** Test hook: a server message to every welcomed link (a gateway's `here`, `emotes`, ...). */
  function broadcast(m) { for (const l of links) if (l.who && l.conn) { l.down.push(wire(m)); kick(); } }

  return {
    join, step, settle, broadcast, advance, deliverUp, tick: () => tick(), log, presence, now, timers, random, clock: clockPort,
    get seq() { return room.seq; }, get pendingTimers() { return time.q.length; },
    compact: () => room.checkpoint(),
    state: stream => streamState(room.streams[stream ?? "board"]),
    full: stream => fullState(room.streams[stream ?? "board"]),
  };
}

/**
 * The net (web/ports/net.js) over one in-page localRoom: the no-SharedWorker fallback. One tab only; no blob path
 * (put does nothing, onFile never fires).
 * @param {{ board: string, users: Record<string, { user: string, role: string }> }} o  users: the dev token table.
 * @returns {import("../../ports/net.js").Net}
 */
export function localNet({ board, users }) {
  const net = localRoom({ board, users, auto: true });
  return { kind: "local", join: () => net.join(), put: () => {}, onFile: () => {} };
}
