// A simulated network for protocol tests: a room and some clients. Client→room is ordered (a WebSocket);
// room→client arrives in any order and sometimes twice. Every message goes through the codec.
import { Room } from "../packages/protocol/room.js";
import { Replica } from "../packages/protocol/replica.js";
import { tableAuth, MemoryLog } from "../packages/protocol/ports.js";
import { jsonCodec } from "../packages/protocol/codec.js";

const rngOf = seed => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export function world(roles, seed = 1) {
  const rng = rngOf(seed), log = new MemoryLog();
  const table = Object.fromEntries(roles.map((role, i) => [`tok${i}`, { user: `u${i}`, role }]));
  const room = new Room({ board: "b1", tenant: "t1", auth: tableAuth(table), log });
  const wire = m => jsonCodec.decode(jsonCodec.encode(m));
  const clients = roles.map((role, i) => ({ i, role, token: `tok${i}`, r: new Replica({ client: `c${i}` }), inbox: [], outbox: [], conn: null }));
  const connect = c => {
    c.inbox = []; c.outbox = [];
    c.conn = room.connect(m => c.inbox.push(wire(m)));
    c.outbox.push(...c.r.connectMessages(c.token, "b1"));
  };
  const drop = c => { room.disconnect(c.conn); c.conn = null; c.inbox = []; c.outbox = []; };
  clients.forEach(connect);
  const step = () => {
    const live = clients.filter(c => c.conn && (c.inbox.length || c.outbox.length));
    if (!live.length) return false;
    const c = live[Math.floor(rng() * live.length)];
    if (c.outbox.length && (rng() < 0.5 || !c.inbox.length)) room.receive(c.conn, wire(c.outbox.shift()));
    else {
      const k = Math.floor(rng() * c.inbox.length), m = c.inbox[k];
      if (rng() < 0.85) c.inbox.splice(k, 1);   // otherwise it stays, and arrives again later
      c.r.receive(m);
      if (c.r.resync) { drop(c); connect(c); }   // a refused op: start over from the room's copy
    }
    return true;
  };
  const settle = () => { let n = 0; while (step()) if (++n > 200000) throw new Error("network never settled"); for (const c of clients) if (c.conn && c.r.pending.size) { drop(c); connect(c); settle(); } };
  const send = (c, stream, op, o) => { const m = c.r.local(stream, op, o); if (c.conn) c.outbox.push(m); return m; };
  return { rng, room, log, clients, connect, drop, step, settle, send };
}

