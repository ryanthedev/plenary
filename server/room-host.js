// The room host: runs one packages/protocol Room (v1.1) per open board and joins it to the Store and the Bus.
// Core code: it depends on the Store and Bus ports only (main.js picks the adapters).
//
// What it does around the Room (PROTOCOL.md § Recovery, § Bus, rule 6):
//   - Build: Store.openEpoch first (welcomes nobody before it resolves), then the latest checkpoint that matches the
//     log (stepping back past a bad one) and the log after it, into Room.rebuild. A failed room is thrown away and
//     the next open builds a new one (a new epoch).
//   - Log adapter: { append(entries, expectSeq), putCheckpoint(cp) } over the Store. The Room holds every ack,
//     refusal and dedupe wait until the append resolves (group commit: one append in flight). When an append
//     resolves, its entries are published on `.entries` (split under the bus cap) before the Room acks them.
//   - Append timeout (4 s): the append's promise rejects, and the Room fails itself (nothing unresolved is acked).
//   - Only `welcome`, `ack` and `error` go back to a gateway (`.gw.<gateway>`). The Room's own catch-up and live
//     broadcasts are not sent: gateways serve catch-up from the Store and fan out from `.entries` (rules 3, 8).
//   - Every `unavailable` the Room says ends that connection (a gap, an unknown connection, a stopped room): the
//     gateway is told to close it, and the client reconnects and is welcomed afresh.
//   - Timers: room.sweep() (gateway silence, by the room's clock) and the `{ seq, epoch }` heartbeat every 2 s.

import { Room } from "../packages/protocol/room.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { subjects, MAX_BUS_BYTES, utf8Length } from "./bus/port.js";
import { quietLogger } from "./log.js";
import { PortError } from "./ids.js";
import { breathe } from "./breather.js";

const REPLIES = new Set(["welcome", "ack", "error"]);
// A hello's catch-up is the gateway's (rule 8): the Room is told the client is at the end of time, so it builds none.
const NO_CATCH_UP = Number.MAX_SAFE_INTEGER;

/**
 * Split encoded entries into `.entries` messages under the bus cap, in seq order (§ Bus). One entry always goes,
 * even alone over the cap (the bus then refuses it, and gateways repair from the Store).
 * @param {{ seq: number }[]} entries @param {string[]} items their encoded text, same order
 * @returns {{ from: number, to: number, items: string[] }[]}
 */
export function splitEntries(entries, items, maxBytes) {
  const out = [], room = maxBytes - 64;   // the envelope: {"from":…,"to":…,"items":[…]}
  let cur = null, bytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const n = utf8Length(JSON.stringify(items[i])) + 1;   // as a JSON string inside the array (escapes count)
    if (cur && bytes + n > room) { out.push(cur); cur = null; }
    if (!cur) { cur = { from: entries[i].seq, to: entries[i].seq, items: [] }; bytes = 0; }
    cur.items.push(items[i]); cur.to = entries[i].seq; bytes += n;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * @param {{ store: object, bus: object, log?: object, codec?: object, now?: () => number, appendTimeoutMs?: number,
 *   sweepMs?: number, heartbeatMs?: number, pageSize?: number, pageBytes?: number, rules?: object, maxBusBytes?: number }} o
 *   now: the rooms' clock (entries' `at`, the 30 s gateway silence). rules: per rules version { W, H, every } (tests).
 */
export function roomHost({ store, bus, log = quietLogger, codec = jsonCodec, now = Date.now, appendTimeoutMs = 4_000, sweepMs = 1_000,
  heartbeatMs = 2_000, pageSize = 1_000, pageBytes = 4 * 1024 * 1024, rules, maxBusBytes = bus.maxBytes ?? MAX_BUS_BYTES, tailFoldBytes = 8 * 1024 * 1024 }) {
  // tailFoldBytes: besides the Room's own rule (every 1,000 entries, once the log since the last checkpoint is half
  //   its size), the host checkpoints once that log reaches this many chars AND half the state's size, so a board
  //   rewritten in a few huge ops still gets a bounded catch-up, and a rewrite never costs more than 2× the log.
  //   (An extension of § Recovery "When": a byte trigger, asked for since the scaffold; see the p2-swap report.)
  /** @type {Map<string, Promise<object>>} key "tenant/board" → the slot, once built */
  const slots = new Map();
  let closed = false;

  const reply = (gateway, conn, data, close) => {
    try { bus.publish(subjects.gateway(gateway), { conn, ...(data !== undefined ? { data } : {}), ...(close ? { close } : {}) })?.catch?.(() => {}); }
    catch { /* a bad gateway id: nobody to tell */ }
  };
  const UNAVAILABLE = codec.encode({ t: "error", code: "unavailable", message: "the board is restarting: reconnect" });

  /** Publish resolved entries on `.entries`, once, encoded once, split under the cap. Never throws. */
  function publishEntries(slot, entries) {
    try {
      const items = entries.map(e => codec.encode(e));
      for (const m of splitEntries(entries, items, maxBusBytes)) {
        const p = bus.publish(subjects.entries(slot.tenant, slot.board), m);
        // Refused (over the cap, a bus outage): gateways repair from the Store (heartbeat gap, 5 s silence poll).
        p?.catch?.(err => log.error("entries publish refused; gateways repair from the Store", { tenant: slot.tenant, board: slot.board, from: m.from, to: m.to, err }));
      }
    } catch (err) { log.error("entries publish failed", { tenant: slot.tenant, board: slot.board, err }); }
  }

  function withTimeout(p) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new PortError("timeout", "the store did not answer in time")), appendTimeoutMs); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  /** The Room's log: the Store, bound to one board. */
  function logOf(slot) {
    const { tenant, board } = slot;
    return {
      append(entries, expectSeq) {
        return withTimeout(store.append(tenant, board, entries, expectSeq)).then(() => {
          slot.durable = entries[entries.length - 1].seq; publishEntries(slot, entries);
          setTimeout(() => foldIfDue(slot), 0);   // after the Room has moved these entries to resolved
        });
      },
      putCheckpoint(cp) {
        const p = store.putCheckpoint(tenant, board, cp);
        slot.writes.add(p); p.finally(() => slot.writes.delete(p)).catch(() => {});
        return p;
      },
    };
  }

  /** The byte trigger (tailFoldBytes, above). Only when nothing is unresolved, so the fold is of resolved state. */
  function foldIfDue(slot) {
    const room = slot.room;
    if (slot.dead || room.stopped || room.inflight || room.queue.length || room.seq !== room.resolved) return;
    if (room.tailChars < tailFoldBytes || room.tailChars * 2 < room.chars.board + room.chars.notes + room.records.chars) return;
    try { room.checkpoint(); } catch (err) { log.error("checkpoint failed", { board: slot.board, err }); }
  }

  /** Read every entry from `from` to the log's end, in bounded pages. */
  async function readFrom(tenant, board, from) {
    const all = [];
    for (let next = from; ;) {
      const page = await store.read(tenant, board, next, pageSize, pageBytes);
      if (!page.length) break;
      for (const e of page) all.push(e);
      next = page[page.length - 1].seq + 1;
      await breathe();   // a long log must not hold the event loop for the whole rebuild
    }
    return all;
  }

  async function load(tenant, board, key) {
    const slot = { key, tenant, board, room: null, epoch: 0, dead: false, unsub: () => {}, conns: new Map(), writes: new Set(), durable: 0 };
    // § Recovery, Room identity: the epoch is opened (durably) before anything else, so two builds never share one.
    slot.epoch = await store.openEpoch(tenant, board);
    const report = (what, detail) => {
      if (what === "stopped") { log.error("room stopped", { tenant, board, seq: detail?.seq, err: detail?.err }); fail(slot); }
      else log.error(`room: ${what}`, { tenant, board, ...detail });
    };
    const opts = { board, tenant, log: logOf(slot), now, epoch: slot.epoch, report, ...(rules ? { rules } : {}) };
    for (let before; ;) {
      const cp = await store.getCheckpoint(tenant, board, before);
      const entries = await readFrom(tenant, board, cp && cp.seq > 0 ? cp.seq : 1);
      try { slot.room = Room.rebuild({ ...opts, checkpoint: cp, entries }); break; }
      catch (err) {
        if (err?.code !== "bad-checkpoint" || !cp) throw new PortError(err?.code ?? "corrupt-log", err?.message ?? String(err));
        log.error("bad checkpoint: stepping back", { tenant, board, seq: cp.seq, message: err.message });
        before = cp.seq;
      }
    }
    slot.durable = slot.room.resolved;
    if (closed) throw new PortError("closed", "the room host is closed");
    slot.unsub = bus.subscribe(subjects.inbox(tenant, board), m => {
      try { onInbox(slot, m); } catch (err) { log.error("room host: inbox handler failed", { tenant, board, err }); }
    });
    // Gateways learn the new epoch now (viewers' welcomes), not 2 s from now.
    bus.publish(subjects.entries(tenant, board), slot.room.heartbeat())?.catch?.(() => {});
    log.info("room opened", { tenant, board, seq: slot.durable, epoch: slot.epoch });
    return slot;
  }

  /** Throw the room away: its connections are told `unavailable` and closed; the next open builds a new one. */
  function fail(slot) {
    if (slot.dead) return;
    slot.dead = true; slot.unsub();
    if (slots.get(slot.key) === slot.promise) slots.delete(slot.key);
    try { slot.room.fail(new PortError("stopped", "the room host stopped this room")); } catch { /* already stopped */ }
    for (const c of slot.conns.values()) reply(c.gateway, c.id, UNAVAILABLE, 1013);
    slot.conns.clear();
  }

  /** A Room connection whose replies go to its gateway; only welcome/ack/error travel (catch-up is the gateway's). */
  function connect(slot, gateway, conn) {
    const ck = `${gateway}/${conn}`;
    const c = slot.room.connect(msg => {
      if (!msg || !REPLIES.has(msg.t)) return;
      const end = msg.t === "error" && msg.code === "unavailable";   // every unavailable ends the connection
      reply(gateway, conn, codec.encode(msg), end ? 1013 : undefined);
      if (end) { slot.conns.delete(ck); if (!c.closed) slot.room.disconnect(c); }
    }, { gateway, id: conn });
    slot.conns.set(ck, c);
    return c;
  }

  /** One inbox message (§ Bus): hello/op `{ n, conn, gateway, user, name, role, client, msg }`, a close notice, or a list. */
  function onInbox(slot, m) {
    if (!m || typeof m.gateway !== "string") return;
    const room = slot.room;
    // Every 5 s, a gateway's open writer connections on this board: the rest are closed (a lost close notice).
    if (Array.isArray(m.conns)) {
      room.listed(m.gateway, m.conns);
      for (const [ck, c] of slot.conns) if (c.closed) slot.conns.delete(ck);
      return;
    }
    if (typeof m.conn !== "string") return;
    const ck = `${m.gateway}/${m.conn}`;
    if (slot.dead) { if (!m.closed) reply(m.gateway, m.conn, UNAVAILABLE, 1013); return; }
    let c = slot.conns.get(ck);
    if (m.closed) { if (c) { room.disconnect(c); slot.conns.delete(ck); } return; }
    const msg = m.msg;
    if (!msg || typeof msg !== "object") return;
    if (!c && msg.t === "hello") c = connect(slot, m.gateway, m.conn);
    // Not a hello and not known: a connection this room never welcomed (rule 6). The Room answers `unavailable`
    // (with the op's id) to a connection it doesn't hold; the reply carries the close.
    if (!c) c = { send: out => reply(m.gateway, m.conn, codec.encode(out), 1013), gateway: m.gateway, id: m.conn, closed: true };
    // What "accepted something" looks like from outside: a new seq, or an op counted as unresolved (the Room counts
    // it just before it applies the entry, so a throw mid-apply shows here even though seq hasn't moved).
    const mark = () => { let n = room.seq; for (const w of room.unresolved.values()) n += w.n; return n; };
    const isHello = msg.t === "hello", before = mark();
    try {
      room.receive(c, isHello ? { ...msg, since: NO_CATCH_UP } : msg, { n: m.n, user: m.user, role: m.role, name: m.name });
    } catch (err) {
      log.error("room threw on a message", { tenant: slot.tenant, board: slot.board, kind: typeof msg.t === "string" ? msg.t.slice(0, 20) : null, err });
      // It accepted something and then threw: its speculative state may be half-applied. Start over from the Store.
      if (mark() !== before) return fail(slot);
      // Nothing was accepted: only the sender hears. The message counts as received (rule 6), so the connection's
      // next one is no gap. A hello that blew up leaves no half-open connection.
      if (Number.isSafeInteger(m.n) && Number.isSafeInteger(c.n) && m.n > c.n) c.n = m.n;
      if (isHello) { room.disconnect(c); slot.conns.delete(ck); return reply(m.gateway, m.conn, UNAVAILABLE, 1013); }
      return reply(m.gateway, m.conn, codec.encode({ t: "error", ...(typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {}), code: "bad-op", message: "that message could not be handled" }));
    }
    // A refused hello (version, board, client id): the Room dropped it; the gateway closes the socket after the error.
    if (isHello && c.closed && slot.conns.get(ck) === c) { slot.conns.delete(ck); reply(m.gateway, m.conn, undefined, 1008); }
  }

  const sweep = setInterval(() => {
    for (const p of slots.values()) p.then(slot => {
      if (slot.dead) return;
      try { slot.room.sweep(); } catch (err) { log.error("room sweep failed", { board: slot.board, err }); }
      for (const [ck, c] of slot.conns) if (c.closed) slot.conns.delete(ck);
    }, () => {});
  }, sweepMs);
  sweep.unref?.();
  // § Bus: the heartbeat repairs a lost last entry and tells gateways the epoch (for viewers' welcomes).
  const beat = setInterval(() => {
    for (const p of slots.values()) p.then(slot => {
      if (!slot.dead) bus.publish(subjects.entries(slot.tenant, slot.board), slot.room.heartbeat())?.catch?.(() => {});
    }, () => {});
  }, heartbeatMs);
  beat.unref?.();

  return {
    /**
     * Make sure this board's room is running here (built from the Store) and listening on its inbox.
     * SEAM(p4): placement. On one node the gateway calls this directly; in a cluster a lease decides which host opens a board.
     */
    async open(tenant, board) {
      if (closed) throw new PortError("closed", "the room host is closed");
      const key = `${tenant}/${board}`;
      let p = slots.get(key);
      if (!p) {
        p = load(tenant, board, key).then(slot => { slot.promise = p; if (slot.dead) slots.delete(key); return slot; });
        slots.set(key, p);
        p.catch(err => { if (slots.get(key) === p) slots.delete(key); log.error("room failed to open", { tenant, board, err }); });
      }
      await p;
    },
    /** Resolves when the board's bus traffic is delivered and its room has nothing in flight (tests, shutdown). */
    async idle(tenant, board) {
      for (let i = 0; i < 10_000; i++) {
        await bus.flush?.();
        const slot = await slots.get(`${tenant}/${board}`)?.catch(() => null);
        if (!slot || slot.dead || (!slot.room.inflight && !slot.room.queue.length && !slot.room.held.length)) { await bus.flush?.(); return; }
        await new Promise(r => setTimeout(r, 1));
      }
    },
    /** The running room for a board, or null (tests and /health only). */
    async peek(tenant, board) {
      const slot = await slots.get(`${tenant}/${board}`)?.catch(() => null);
      return slot ? { room: slot.room, epoch: slot.epoch, durable: slot.durable, conns: slot.conns.size, tailBytes: slot.room.tailChars } : null;
    },
    stats: () => ({ rooms: slots.size }),
    /** Stop every room: a checkpoint of each (§ Recovery, "When": on a clean stop), then stop listening. */
    async close() {
      closed = true; clearInterval(sweep); clearInterval(beat);
      const all = await Promise.all([...slots.values()].map(p => p.catch(() => null)));
      for (const slot of all) {
        if (!slot || slot.dead) continue;
        slot.unsub();
        try { if (slot.room.resolved > slot.room.base.seq && !slot.room.inflight && !slot.room.queue.length) slot.room.checkpoint(); }
        catch (err) { log.error("checkpoint on stop failed", { board: slot.board, err }); }
        slot.dead = true;
        await Promise.allSettled([...slot.writes]);
      }
      slots.clear();
    },
  };
}
