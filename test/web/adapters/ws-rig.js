// A sync rig over the real WebSocket transport (web/adapters/transport/ws.js), p7-audit C-10. The core (bindEditor,
// createSession, the collab sync port) has only ever met ws.js in headless Chrome; the unit tests ran it over
// localRoom's stepped in-page delivery. Here every connection is a wsTransport over a fake browser WebSocket whose far
// end is one localRoom link (the reference Room behind a gateway stand-in), and every hop is asynchronous:
//
//   core ──send──▶ ws.js ──(pre-open queue | ws.send → bufferedAmount)──▶ FakeWS.up ──step──▶ localRoom link ──step──▶ Room
//   core ◀─onMessage── ws.js ◀──onmessage── FakeWS.down ◀──step── localRoom link ◀──step── Room
//
// - **Open is an event.** A socket starts CONNECTING; it opens only when a step delivers its open event, so the core's
//   hello sits in ws.js's pre-open queue until then (asserted in ws-sync.test.js).
// - **bufferedAmount is real.** ws.send adds the frame's UTF-8 bytes; they leave only when a step hands the frame to
//   the room. `hold(true)` stalls every uplink (a slow link), so ws.js's backlog, congested() and the core's presence
//   gate see it.
// - **Order:** per socket and direction, FIFO (a WebSocket). Across sockets, directions and the room's own queues,
//   the order is drawn from the seeded rng.
// - **Drops come from the server side:** `serverClose(ws)` closes the far link and queues a close event, so ws.js sees
//   an unasked close and reports onDrop. ws.js has no `fail()` hook (session.dropConnection uses one), so `join()`
//   below adds one that server-closes the transport's current socket.
// - **settle()** is async and owns time: it pumps the sockets and the room until both are empty, yields microtasks
//   (ws.js reports a send-time drop on a microtask), runs the collab frames, and only then fires the earliest due
//   virtual timer. localRoom's own settle() would advance time while frames are still in the sockets (it can't see
//   them), so it is never used here.
// Tests only; imports the adapters under test, which a test may do.
import { localRoom } from "../../../web/adapters/transport/local.js";
import { wsTransport, frameBytes } from "../../../web/adapters/transport/ws.js";
import { jsonCodec } from "../../../packages/protocol/codec.js";
import { seeded } from "../../../web/core/sync.js";
import { createSession } from "../../../web/core/session.js";
import { syncCollabPort } from "../../../web/adapters/collab/sync.js";

export const WS_URL = "ws://gateway.test/ws";

/** Fake browser WebSockets bridged to `net` (a localRoom with clock: true). */
export function wsBridge(net) {
  const sockets = [];
  let held = false;
  const stats = { opened: 0, upFrames: 0, downFrames: 0, maxBuffered: 0, sendsBeforeOpen: 0, sendsAfterClose: 0 };

  class FakeWS {
    constructor(url) {
      if (url !== WS_URL) throw new Error(`unexpected url ${url}`);
      this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.binaryType = "blob";
      this.up = []; this.down = []; this.far = null; this.closeQueued = false; this.closedByClient = false;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      sockets.push(this);
    }
    send(data) {
      // As a browser: CONNECTING throws; CLOSING/CLOSED drop the frame silently (p7-archtestv LOW 7).
      if (this.readyState === 0) { stats.sendsBeforeOpen++; throw new Error("InvalidStateError"); }
      if (this.readyState !== 1) { stats.sendsAfterClose++; return; }
      this.up.push(data);
      this.bufferedAmount += frameBytes(data);
      stats.maxBuffered = Math.max(stats.maxBuffered, this.bufferedAmount);
    }
    close() {
      if (this.readyState >= 2) return;
      this.closedByClient = true;
      this.shut();
    }
    /** Close the far side and queue the close event (both for the client's close and a server close). */
    shut() {
      this.far?.close(); this.far = null;
      this.up = []; this.down = []; this.bufferedAmount = 0;
      this.readyState = 2; this.closeQueued = true;
    }
  }

  /** The events one step may deliver now, as thunks. */
  function ready() {
    const out = [];
    for (const ws of sockets) {
      if (ws.readyState === 0) out.push(() => {
        ws.readyState = 1; stats.opened++;
        const far = ws.far = net.join();
        far.onMessage(m => { if (ws.far === far) ws.down.push(jsonCodec.encode(m)); });
        far.onDrop(() => { if (ws.far === far) ws.shut(); });
        ws.onopen?.({});
      });
      else if (ws.readyState === 1) {
        if (ws.up.length && !held) out.push(() => {
          const data = ws.up.shift();
          ws.bufferedAmount -= frameBytes(data); stats.upFrames++;
          ws.far.send(jsonCodec.decode(data));
        });
        if (ws.down.length) out.push(() => { stats.downFrames++; ws.onmessage?.({ data: ws.down.shift() }); });
      } else if (ws.readyState === 2 && ws.closeQueued) out.push(() => {
        ws.closeQueued = false; ws.readyState = 3;
        ws.onclose?.({ code: ws.closedByClient ? 1000 : 1006, wasClean: ws.closedByClient });
      });
    }
    return out;
  }

  return {
    WebSocket: FakeWS, sockets, stats,
    /** One socket event (open, an uplink frame, a downlink frame or a close). False when none is ready. */
    step(rng) { const r = ready(); if (!r.length) return false; r[Math.floor(rng() * r.length)](); return true; },
    /** Stall (true) or release (false) every uplink: frames stay in bufferedAmount. */
    hold(on) { held = on; },
    /** The server closes this socket (a gateway restart, a proxy timeout): an unasked close reaches ws.js. */
    serverClose(ws) { if (ws && ws.readyState <= 1) ws.shut(); },
    /** Deliver every queued close event now (the client sees the drops), nothing else. */
    flushCloses() { for (const ws of sockets) if (ws.readyState === 2 && ws.closeQueued) { ws.closeQueued = false; ws.readyState = 3; ws.onclose?.({ code: ws.closedByClient ? 1000 : 1006, wasClean: ws.closedByClient }); } },
    live: () => sockets.filter(ws => ws.readyState <= 1),
  };
}

/**
 * The network: a localRoom (virtual clock) plus the bridge, a seeded order, and an async settle. `frames` (optional)
 * is a list of coalesced callbacks (the collab port's) that settle runs once deliveries are idle.
 */
export function wsNetwork({ users, seed = 1, frames = null }) {
  const net = localRoom({ users, seed, clock: true });
  const bridge = wsBridge(net);
  const own = seeded(seed * 7919 + 13);

  /** One delivery anywhere (a socket event or a room-side hop), sync. False when nothing is ready. */
  function step(rng = own) {
    return rng() < 0.5 ? bridge.step(rng) || net.step(rng) : net.step(rng) || bridge.step(rng);
  }
  /** Deliver everything, then fire timers one at a time (each followed by its deliveries). Async: microtasks run. */
  // Bounded by virtual time as well: a link that never comes up retries forever on backoff timers, and an unbounded
  // settle would hang the test instead of failing it.
  async function settle(rng = own, { maxMs = 600_000 } = {}) {
    const t0 = net.now();
    for (let n = 0; ; n++) {
      if (n > 1_000_000) throw new Error("ws network never settled");
      if (net.now() - t0 > maxMs) throw new Error(`ws network not settled after ${maxMs} virtual ms`);
      if (step(rng)) continue;
      await Promise.resolve(); await Promise.resolve();      // ws.js's failLater, any promise in the core
      if (step(rng)) continue;
      if (frames?.length) { for (const fn of frames.splice(0)) fn(); continue; }
      if (!net.tick()) return;
    }
  }
  // Which transport opened a socket: ws.js opens synchronously inside wsTransport() and reopen(), so a socket belongs
  // to the transport whose constructor or reopen() was running when it was made.
  const owner = new Map();
  const Base = bridge.WebSocket;
  let opening = null;
  const WS = class extends Base { constructor(url) { super(url); owner.set(this, opening); } };
  /** A wsTransport (the production adapter) on this network, plus the fail() hook session.dropConnection uses and
   *  socket() (its current fake socket). */
  function join() {
    const entry = {};
    opening = entry;
    const t = wsTransport({ url: WS_URL, WebSocket: WS, clock: net.clock });
    opening = null;
    return {
      ...t,
      reopen: () => { opening = entry; try { t.reopen(); } finally { opening = null; } },
      fail: () => { for (const ws of bridge.live()) if (owner.get(ws) === entry) bridge.serverClose(ws); },
      socket: () => [...owner].filter(([, e]) => e === entry).map(([ws]) => ws).at(-1),
    };
  }
  return { net, bridge, step, settle, join, clock: net.clock };
}

/** The collab port contract's driver (test/web/contracts/collab-contract.js), as syncRig but every link over ws.js. */
export async function wsSyncRig(role, { users: extra = {}, seed = 1 } = {}) {
  const USERS = { "t-me": { user: "me", name: "Me", role }, "t-bo": { user: "bo", name: "Bo", role: "editor" }, ...extra };
  const frames = [];
  const w = wsNetwork({ users: USERS, seed, frames });
  const { net } = w;
  const frame = fn => frames.push(fn);
  const sent = [];
  const join = () => { const t = w.join(); return { ...t, send: m => { if (m.t === "presence") sent.push(m); t.send(m); } }; };
  const me = createSession({ join, token: "t-me", board: "b1", client: "me", user: "me", clock: net.clock });
  const bo = createSession({ join: () => w.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: net.clock });
  const port = syncCollabPort(me, { name: "Me", frame });
  const settle = () => w.settle();
  await settle();
  return {
    ...w, me, bo, port, frames, USERS, settle,
    peer: { user: "bo" },
    async peerPresence(m) { const { k, ...f } = m; if (!bo.binds.board.sendPresence(k, f)) throw new Error("peer presence not sent"); await settle(); },
    async peerRecord(op) { bo.binds.board.record(op); await settle(); },
    async peerNote() {
      bo.placeNote({ x: 100, y: 100 }, "peer note");
      await settle();
      return bo.eds.notes.doc.live().find(e => e.type === "rectangle").id;
    },
    async peerDeleteNote(id) { bo.act("notes", n => n.deleteIds([id])); await settle(); },
    async peerPreview(stream, el) { if (!bo.binds.board.sendPresence("preview", { stream, elements: [el] })) throw new Error("preview not sent"); await settle(); },
    async here(msg) { net.broadcast(msg); await settle(); },
    async emotes(msg) { net.broadcast(msg); await settle(); },
    async setRole(r) { USERS["t-me"].role = r; me.dropConnection(); await settle(); },
    // The contract's drop() means the client has seen it: over ws that is the close event, so it is delivered first.
    async drop(during = () => {}) { me.dropConnection(); w.bridge.flushCloses(); during(); await settle(); },
    sent: () => sent.map(({ t, ...m }) => m),
  };
}
