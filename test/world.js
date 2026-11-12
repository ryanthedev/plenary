// A simulated network for protocol tests: a room, a gateway stand-in and some clients. Client→room is
// ordered and numbered (`n`, rule 6); room→client arrives in any order and sometimes twice. Every message
// goes through the codec. Time is a counter the world moves, so pacing and timeouts are deterministic.
import { Room } from "../packages/protocol/room.js";
import { Replica } from "../packages/protocol/replica.js";
import { tableAuth, MemoryLog } from "../packages/protocol/ports.js";
import { jsonCodec } from "../packages/protocol/codec.js";

const rngOf = seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** @param {string[]} roles one client per role  @param {{ rules?: object, auto?: boolean }} [opts] passed to the room */
export function world(roles, seed = 1, opts = {}) {
  const rng = rngOf(seed), log = new MemoryLog();
  const table = Object.fromEntries(roles.map((role, i) => [`tok${i}`, { user: `u${i}`, role, name: `User ${i}` }]));
  const auth = tableAuth(table), reports = [];
  const w = { rng, log, reports, t: 1_000_000 };
  const now = () => w.t;
  const roomOpts = { board: "b1", tenant: "t1", log, now, report: (what, detail) => reports.push({ what, ...detail }), ...opts };
  w.room = new Room(roomOpts);
  const wire = m => jsonCodec.decode(jsonCodec.encode(m));
  const replica = name => new Replica({ client: name, now });
  const clients = roles.map((role, i) => ({ i, role, token: `tok${i}`, r: replica(`c${i}`), inbox: [], outbox: [], conn: null, n: 0 }));

  const connect = c => {
    c.inbox = []; c.outbox = []; c.n = 0;
    c.conn = w.room.connect(m => c.inbox.push(wire(m)));
    c.outbox.push(...c.r.connectMessages(c.token, "b1"));
  };
  const drop = c => { w.room.disconnect(c.conn); c.conn = null; c.inbox = []; c.outbox = []; };
  // The gateway stand-in (rule 8): it checks the token, and the room only ever sees { user, role }.
  const deliver = (c, msg) => {
    if (msg.t !== "hello") return w.room.receive(c.conn, msg, { n: ++c.n });
    const who = auth.check(msg.token, msg.board);
    if (!who) return c.inbox.push({ t: "error", code: "auth", message: "token refused" });
    const { token, ...hello } = msg;
    w.room.receive(c.conn, hello, { n: ++c.n, ...who });
  };
  /** Hand a message straight to the room, as this client's next one (for hand-made ops). */
  const raw = (c, msg) => deliver(c, wire(msg.t === "op" ? { sentAt: c.r.applied, ...msg } : msg));
  const again = c => { if (c.conn && c.r.resync) { drop(c); connect(c); } };   // the replica asked for a new connection
  const fill = () => { for (const c of clients) if (c.conn) { c.outbox.push(...c.r.outgoing()); again(c); } };
  /** Everything this client has to send reaches the room, in order (its answers stay in the inbox). */
  const flush = c => { c.outbox.push(...c.r.outgoing()); while (c.outbox.length) deliver(c, wire(c.outbox.shift())); };

  const step = () => {
    fill();
    const live = clients.filter(c => c.conn && (c.inbox.length || c.outbox.length));
    if (!live.length) {
      // Nothing in flight: if someone is only waiting for the send pace, let time pass.
      const waits = clients.filter(c => c.conn).map(c => c.r.paceWait()).filter(x => x !== null);
      if (!waits.length) return false;
      w.t += Math.max(1, Math.min(...waits));
      return true;
    }
    w.t += 5;
    const c = live[Math.floor(rng() * live.length)];
    if (c.outbox.length && (rng() < 0.5 || !c.inbox.length)) deliver(c, wire(c.outbox.shift()));
    else {
      const k = Math.floor(rng() * c.inbox.length), m = c.inbox[k];
      if (rng() < 0.85) c.inbox.splice(k, 1);   // otherwise it stays, and arrives again later
      c.r.receive(m);
      again(c);                                 // a refused op: start over from the room's copy
    }
    return true;
  };
  const settle = (depth = 0) => {
    let n = 0; while (step()) if (++n > 400000) throw new Error("network never settled");
    if (depth > 50) throw new Error("clients never settled");
    for (const c of clients) if (c.conn && c.r.pending.size) { drop(c); connect(c); settle(depth + 1); }
  };
  const send = (c, stream, op) => c.r.local(stream, op);
  clients.forEach(connect);

  /**
   * The room's process dies and a new one is rebuilt from the log (optionally checkpointing first).
   * Gateways close every connection of the old room, so the clients reconnect; `keep` leaves them as they are.
   */
  const rebuild = ({ checkpoint = false, keep = false } = {}) => {
    if (checkpoint) w.room.checkpoint();
    w.room = Room.fromLog(roomOpts);
    if (!keep) for (const c of clients) if (c.conn) { c.conn = null; connect(c); }
    return w.room;
  };
  return Object.assign(w, { clients, connect, drop, step, settle, send, raw, flush, rebuild, replica, now });
}

export const errors = c => c.inbox.filter(m => m.t === "error");

/**
 * A room driven by hand, no replicas and no shuffling: join(user, role, client) gives a connection whose
 * messages are numbered as a gateway would, and `op(counter, stream, op, sentAt)` to send one.
 */
export function direct(log = new MemoryLog(), opts = {}) {
  const d = { log, room: new Room({ board: "b1", tenant: "t1", log, now: () => 5, ...opts }) };
  d.join = (user, role, client, since = 0) => {
    const inbox = [], c = d.room.connect(m => inbox.push(m));
    let n = 0;
    const say = msg => d.room.receive(c, msg, { n: ++n });
    d.room.receive(c, { t: "hello", v: 1, board: "b1", since, client }, { n: ++n, user, role });
    return { c, inbox, say, op: (counter, stream, op, sentAt = 0) => say({ t: "op", id: `${client}:${counter}`, sentAt, stream, op }), of: t => inbox.filter(m => m.t === t) };
  };
  return d;
}

/** A log whose appends resolve only when the test says so (a slow store: group commit, failures). */
export function slowLog() {
  const log = new MemoryLog(), waiting = [];
  return {
    log, waiting,
    append: (entries, expectSeq) => new Promise((res, rej) => waiting.push({ entries, land: () => { try { log.append(entries, expectSeq); res(); } catch (err) { rej(err); } }, fail: err => rej(err) })),
    putCheckpoint: cp => log.putCheckpoint(cp),
  };
}
export const tick = () => new Promise(r => setTimeout(r, 0));
