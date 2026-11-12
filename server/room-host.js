// The room host: runs one packages/protocol Room per open board and joins it to the Store and the Bus.
//
// THE ONLY FILE THAT TOUCHES Room'S INTERNALS. Today's Room is v0 (sync auth.check, sync log.append, no rebuild,
// no checkpoint). Everything here that bridges that to PROTOCOL.md v1 is marked SEAM(p2); when phase 2 lands
// (Room.rebuild, applyEntry, checkpoint(), {user, role} in the hello context) those blocks are replaced, and the
// gateway, Store, Bus and tests stay as they are.
//
// What the host guarantees, whatever the Room does inside:
//   - One message at a time per board, in inbox order (rule 6).
//   - Rule 1: nothing a message made the room say (ack, broadcast, catch-up) leaves before the entries that
//     message logged are durable in the Store. If the append fails or times out, none of it leaves, ever: the
//     room is thrown away, its connections get `unavailable` and are closed, and the next hello rebuilds it from
//     the Store (§ Recovery, "Append failure or timeout").
//   - Rule 8: the room gets {user, role} from the gateway. It never sees a token.

import { Room } from "../packages/protocol/room.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { subjects } from "./bus/memory.js";
import { quietLogger } from "./log.js";
import { PortError } from "./ids.js";
import { breathe } from "./breather.js";

/**
 * @param {{ store: object, bus: object, log?: object, codec?: object, pageSize?: number, compactEvery?: number, appendTimeoutMs?: number }} o
 */
export function roomHost({ store, bus, log = quietLogger, codec = jsonCodec, pageSize = 100, pageBytes = 4 * 1024 * 1024, compactEvery = 1000,
  tailFoldBytes = 8 * 1024 * 1024, chunkBytes = 1024 * 1024, appendTimeoutMs = 5_000 }) {
  // pageSize / pageBytes: one Store read during a rebuild holds at most this many entries and about this much text
  //   (an entry may be 1,000,000 chars). SEAM(p2): with checkpoints a rebuild reads only the tail after one.
  // compactEvery / tailFoldBytes: the kept tail is folded into the snapshot when it reaches this many entries OR
  //   this much text, so a board's catch-up is its real state plus at most tailFoldBytes, however often one
  //   element was rewritten. SEAM(p2): § Recovery checkpoints by entry count only; a byte trigger is a spec ask.
  // chunkBytes: no `entries` frame of a catch-up is bigger than this (one entry bigger than it travels alone).
  // appendTimeoutMs: § Recovery, "append 5 s".
  /** @type {Map<string, Promise<object>>} key "tenant/board" → the slot, once rebuilt */
  const slots = new Map();
  let closed = false;

  // SEAM(p2): Room.rebuild({ checkpoint, entries }). Until then: replay the whole log into a fresh v0 Room by hand,
  // mirroring what Room.op does after log.append. No checkpoint is read or written (their contents are still moving).
  function replay(room, e) {
    room.seq = e.seq;
    room.apply(e);
    room.tail.push(e);
    room.opSeq.set(`${e.by}|${e.id}`, e.seq);
    if (e.stream === "notes") for (const el of e.op.elements ?? []) if (!room.noteAuthor.has(el.id)) room.noteAuthor.set(el.id, e.by);
  }

  async function load(tenant, board, key) {
    const slot = {
      key, tenant, board, room: null, dead: false, unsub: () => {},
      ctx: null,            // the verified {user, role, tenant} of the message being handled
      batch: [],            // entries the room logged while handling it
      out: [],              // what the room said while handling it: [{ gateway, conn, data, close? }]
      durable: 0,           // the last seq known to be in the Store
      conns: new Map(),     // "gateway/conn" → { gateway, conn, rc }
      chain: Promise.resolve(),
      tailBytes: 0,         // text size of the kept tail (what a since-0 joiner is sent after the snapshot)
      snapOf: null, snapFrame: null,   // the encoded snapshot frame of room.base (one encode per base, not per joiner)
      chunksOf: null, chunksLen: 0, chunks: [],   // the tail as bounded `entries` frames, per (base, tail length)
    };
    // SEAM(p2): the Room takes {user, role} in the hello context instead of calling auth.check. Until then its
    // "auth" hands back what the gateway already verified; the token was stripped before the hello got here.
    // SEAM(p2): async Store + group commit. Until then the Room's sync log.append only collects; handle() awaits
    // the real append before releasing anything (so the room's memory is briefly ahead of the Store, and is
    // discarded if the append fails).
    slot.room = new Room({ board, tenant, auth: { check: () => slot.ctx }, log: { append: e => { slot.batch.push(e); } } });

    let next = 1;
    for (;;) {
      const page = await store.read(tenant, board, next, pageSize, pageBytes);
      for (let i = 0; i < page.length; i++) {
        const e = page[i];
        // A gap or a repeated seq is corruption: refuse to start (§ Recovery, Rebuild).
        if (!e || e.seq !== next || e.board !== board || e.tenant !== tenant) throw new PortError("corrupt-log", `log of ${board} breaks at seq ${next}`);
        replay(slot.room, e); next++;
        // Fold as the log is replayed, by the same rule as live, so a rebuilt room's tail is bounded too. Sizes
        // come from the Store (`page.bytes`) when it gives them, so nothing is encoded just to be measured.
        slot.tailBytes += page.bytes?.[i] ?? textOf(e).length;
        foldIfDue(slot);
      }
      if (!page.length) break;   // an empty page is the end; a short one may just be the store's own cap
      await breathe();           // a long log must not hold the event loop for the whole rebuild
    }
    slot.durable = next - 1;
    if (closed) throw new PortError("closed", "the room host is closed");
    slot.unsub = bus.subscribe(subjects.inbox(tenant, board), m => {
      slot.chain = slot.chain.then(() => handle(slot, m)).catch(err => { log.error("room host: handler failed", { tenant, board, err }); });
    });
    log.info("room opened", { tenant, board, seq: slot.durable });
    return slot;
  }

  // SEAM(p2): checkpoints. Until then the kept tail is folded in memory (Room.compact) so a late joiner gets a
  // snapshot, not the whole log. Only between messages, when everything in memory is durable.
  function foldIfDue(slot) {
    if (slot.room.tail.length < compactEvery && slot.tailBytes < tailFoldBytes) return;
    slot.room.compact(); slot.tailBytes = 0;
  }

  // SEAM(p4): § Bus also has the room publish a `{ seq }` heartbeat on `.entries` every 2 s, and a `.here` subject
  // (who is on the board). Neither is sent: on the in-memory bus an entry can't be lost, and `here` is p2's.
  // SEAM(p4): § Bus names the reply subject `plen.<tenant>.<board>.gw.<gateway>` (per board); here it is one subject
  // per gateway (subjects.gateway), which a single node can't tell apart. § Bus also says catch-up and snapshots
  // never travel on the bus (the gateway reads them from the Store); here they still do, in frames of at most
  // chunkBytes, except the snapshot, which is one frame however large the board is.
  const reply = (gateway, conn, msg, close) => bus.publish(subjects.gateway(gateway), { conn, data: codec.encode(msg), ...(close ? { close } : {}) });
  const UNAVAILABLE = { t: "error", code: "unavailable", message: "the board is restarting: reconnect" };

  /** Throw the room away. Nothing it said for the failed message is sent; everyone reconnects and it rebuilds. */
  function fail(slot, why) {
    if (slot.dead) return;
    slot.dead = true; slot.unsub();
    if (slots.get(slot.key) === slot.promise) slots.delete(slot.key);
    log.error("room stopped", { tenant: slot.tenant, board: slot.board, why, seq: slot.durable, conns: slot.conns.size });
    for (const c of slot.conns.values()) reply(c.gateway, c.conn, UNAVAILABLE, 1013);
    slot.conns.clear(); slot.batch = []; slot.out = [];
  }

  // Encoding is the expensive part of fan-out and of catch-up, so each entry is turned into text exactly once,
  // whoever it is sent to and however often: live broadcast, a late joiner's tail, the entries subject.
  const entryText = new WeakMap();
  const textOf = e => { let s = entryText.get(e); if (s === undefined) { s = codec.encode(e); entryText.set(e, s); } return s; };
  // An `entries` frame built from the cached pieces (JSON codec only; another codec encodes the frame whole).
  const entriesFrame = list => (codec === jsonCodec ? `{"t":"entries","entries":[${list.map(textOf).join(",")}]}` : codec.encode({ t: "entries", entries: list }));
  // The UTF-8 size of shared catch-up text, measured once when the text is built: the gateway budgets sockets in
  // bytes, and a snapshot can be hundreds of MB, so it is sent along (`bytes`) rather than measured per joiner.
  const utf8Bytes = s => (typeof s === "string" ? Buffer.byteLength(s, "utf8") : s?.byteLength ?? 0);
  const encode = msg => (msg.t === "entries" && Array.isArray(msg.entries) ? entriesFrame(msg.entries) : codec.encode(msg));

  // SEAM(p2): catch-up. Mirrors Room.hello's catch-up (room.js). The Room is asked for the welcome only (it is told
  // the client is up to date) and the host adds these frames after it:
  //   - the snapshot, encoded once per base (one frame: PROTOCOL.md has no chunked snapshot);
  //   - the tail as `entries` frames of at most chunkBytes each, built once per (base, tail) from cached entry text
  //     and shared by every joiner. The gateway paces them by the socket's backpressure.
  function tailChunks(slot) {
    const room = slot.room, tail = room.tail;
    if (slot.chunksOf !== room.base) { slot.chunksOf = room.base; slot.chunks = []; slot.chunksLen = 0; }
    if (slot.chunksLen === tail.length) return slot.chunks;
    // The tail only grows (until the next fold), so chunks already full never change: only the open last one is
    // rebuilt. Joiners queued an hour apart share every closed chunk; each can differ in at most the last.
    const chunks = slot.chunks;
    if (chunks.length && !chunks[chunks.length - 1].closed) chunks.pop();
    let i = chunks.length ? chunks[chunks.length - 1].to - room.base.seq : 0, cur = [], bytes = 0;
    const emit = closed => { const data = entriesFrame(cur); chunks.push({ from: cur[0].seq, to: cur[cur.length - 1].seq, closed, data, bytes: utf8Bytes(data), key: `${slot.key}/c${room.base.seq}.${cur[0].seq}-${cur[cur.length - 1].seq}` }); cur = []; bytes = 0; };
    for (; i < tail.length; i++) {
      const n = textOf(tail[i]).length;
      if (cur.length && bytes + n > chunkBytes) emit(true);
      cur.push(tail[i]); bytes += n;
    }
    if (cur.length) emit(bytes >= chunkBytes);
    slot.chunksLen = tail.length;
    return chunks;
  }
  function catchUp(slot, since) {
    const room = slot.room, frames = [];
    if (since < room.base.seq) {
      if (slot.snapOf !== room.base) { slot.snapFrame = codec.encode({ t: "snapshot", seq: room.base.seq, ...room.base.snapshot }); slot.snapBytes = utf8Bytes(slot.snapFrame); slot.snapOf = room.base; }
      frames.push({ data: slot.snapFrame, bytes: slot.snapBytes, shared: `${slot.key}/s${room.base.seq}` });
      since = room.base.seq;
    }
    for (const ch of tailChunks(slot)) {
      if (ch.to <= since) continue;
      // A reconnecting client that starts inside a chunk gets that one cut to what it lacks (the tail is ascending
      // and gapless from base.seq + 1, so entries sit at known indexes); every later chunk is the shared one.
      // Only shared text carries a key; the cut chunk is this joiner's own (at most one chunk).
      if (ch.from > since) frames.push({ data: ch.data, bytes: ch.bytes, shared: ch.key });
      else frames.push({ data: entriesFrame(room.tail.slice(since - room.base.seq, ch.to - room.base.seq)), shared: false });
    }
    return frames;
  }

  function appendWithTimeout(slot, batch) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new PortError("timeout", "the store did not answer in time")), appendTimeoutMs); });
    return Promise.race([store.append(slot.tenant, slot.board, batch, slot.durable), timeout]).finally(() => clearTimeout(timer));
  }

  /** One inbox message (§ Bus): { n, conn, gateway, user, name, role, client, msg } or { n, conn, gateway, closed: true }. */
  async function handle(slot, m) {
    // One writer's burst is thousands of these in a row, each a synchronous fsync: let the rest of the process run.
    await breathe();
    if (!m || typeof m.conn !== "string" || typeof m.gateway !== "string") return;
    const ck = `${m.gateway}/${m.conn}`;
    if (slot.dead) { if (!m.closed) reply(m.gateway, m.conn, UNAVAILABLE, 1013); return; }
    let c = slot.conns.get(ck);
    // SEAM(p4): § Bus also has a list of each gateway's open connections every 5 s, which repairs a lost close
    // notice. Not sent or read yet: on the in-memory bus a close notice can't be lost.
    if (m.closed) { if (c) { slot.room.disconnect(c.rc); slot.conns.delete(ck); } return; }
    const msg = m.msg;
    if (!msg || typeof msg !== "object") return;
    if (!c) {
      // Not a hello: a connection from before this room was rebuilt. It reconnects.
      if (msg.t !== "hello") { reply(m.gateway, m.conn, UNAVAILABLE, 1013); return; }
      c = { gateway: m.gateway, conn: m.conn, rc: null, n: 0 };
      // Serialised now, not when it is sent: what the Room hands out may change before the append resolves.
      c.rc = slot.room.connect(out => { slot.out.push({ gateway: c.gateway, conn: c.conn, data: encode(out) }); });
      slot.conns.set(ck, c);
    }
    // Rule 6: messages are numbered per connection. A gap means the bus lost one (it is at-most-once), so later ops
    // may depend on one the room never saw: the connection is closed and the client reconnects and resends.
    // (Never happens on the in-memory bus; it is here for NATS.)
    if (typeof m.n === "number") {
      if (c.n && m.n !== c.n + 1) {
        log.warn("inbox gap", { tenant: slot.tenant, board: slot.board, conn: c.conn, expected: c.n + 1, got: m.n });
        slot.room.disconnect(c.rc); slot.conns.delete(ck);
        reply(c.gateway, c.conn, UNAVAILABLE, 1013); return;
      }
      c.n = m.n;
    }
    const isHello = msg.t === "hello";
    const since = isHello && Number.isSafeInteger(msg.since) && msg.since > 0 ? msg.since : 0;

    slot.ctx = { user: m.user, role: m.role, tenant: slot.tenant }; slot.batch = []; slot.out = [];
    // A hello: the Room sends only the welcome (it is told `since` = its own seq); catch-up is ours, below.
    try { slot.room.receive(c.rc, isHello ? { ...msg, since: slot.room.seq } : msg); }
    catch (err) {
      log.error("room threw on a message", { tenant: slot.tenant, board: slot.board, kind: typeof msg.t === "string" ? msg.t.slice(0, 20) : null, err });
      // It logged something and then threw: its memory may be half-applied. Nothing was appended; start over.
      if (slot.batch.length) return fail(slot, "room threw after logging");
      slot.out = [];
      // A hello that blew up leaves no half-open connection: it is told to come back.
      if (isHello) { slot.room.disconnect(c.rc); slot.conns.delete(ck); reply(c.gateway, c.conn, UNAVAILABLE, 1013); return; }
      reply(c.gateway, c.conn, { t: "error", ...(typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {}), code: "bad-op", message: "that message could not be handled" });
      return;
    } finally { slot.ctx = null; }
    const batch = slot.batch, out = slot.out; slot.batch = []; slot.out = [];
    // Accepted hello: the catch-up, from resolved state only (nothing is in flight between messages).
    if (isHello && c.rc.user) for (const f of catchUp(slot, since)) out.push({ gateway: c.gateway, conn: c.conn, data: f.data, catchup: f.shared || undefined, bytes: f.shared ? f.bytes : undefined });

    if (batch.length) {
      try { await appendWithTimeout(slot, batch); }
      catch (err) { log.error("append failed", { tenant: slot.tenant, board: slot.board, expectSeq: slot.durable, err }); return fail(slot, `append: ${err?.code ?? "error"}`); }
      slot.durable = batch[batch.length - 1].seq;
      for (const e of batch) slot.tailBytes += textOf(e).length;
      // § Bus: the room publishes entries after the append resolves. SEAM(p4): gateways will fan out from this
      // subject (and repair gaps from the Store); today each connection still gets them from the Room itself.
      bus.publish(subjects.entries(slot.tenant, slot.board), { from: batch[0].seq, to: slot.durable, data: entriesFrame(batch) });
    }
    // The gateway refused nothing, yet the Room refused the hello: don't leave a half-open connection.
    const refusedHello = isHello && !c.rc.user;
    if (refusedHello) { slot.room.disconnect(c.rc); slot.conns.delete(ck); }
    for (let i = 0; i < out.length; i++) {
      const o = out[i], last = refusedHello && i === out.length - 1;
      // `catchup` names shared, encode-once catch-up text (a snapshot, a whole chunk): the gateway keeps only a
      // reference to it per joiner, counts each name once, and pulls it into each socket as that socket drains.
      bus.publish(subjects.gateway(o.gateway), { conn: o.conn, data: o.data, ...(o.catchup ? { catchup: o.catchup, bytes: o.bytes } : {}), ...(last ? { close: 1008 } : {}) });
    }
    foldIfDue(slot);
  }

  return {
    /**
     * Make sure this board's room is running here (rebuilt from the Store) and listening on its inbox.
     * SEAM(p4): placement. On one node the gateway calls this directly; in a cluster a lease decides which host opens a board.
     */
    async open(tenant, board) {
      if (closed) throw new PortError("closed", "the room host is closed");
      const key = `${tenant}/${board}`;
      let p = slots.get(key);
      if (!p) {
        p = load(tenant, board, key).then(slot => { slot.promise = p; return slot; });
        slots.set(key, p);
        p.catch(err => { if (slots.get(key) === p) slots.delete(key); log.error("room failed to open", { tenant, board, err }); });
      }
      await p;
    },
    /** Resolves when every message already in the board's inbox has been handled (tests, clean shutdown). */
    async idle(tenant, board) {
      const slot = await slots.get(`${tenant}/${board}`)?.catch(() => null);
      if (!slot) return;
      await bus.flush?.();
      let seen;
      do { seen = slot.chain; await seen; await bus.flush?.(); } while (seen !== slot.chain);
    },
    /** The running room for a board, or null (tests and /health only). */
    async peek(tenant, board) { const slot = await slots.get(`${tenant}/${board}`)?.catch(() => null); return slot ? { room: slot.room, durable: slot.durable, conns: slot.conns.size, tailBytes: slot.tailBytes } : null; },
    stats: () => ({ rooms: slots.size }),
    async close() {
      closed = true;
      const all = await Promise.all([...slots.values()].map(p => p.catch(() => null)));
      for (const slot of all) if (slot) { slot.dead = true; slot.unsub(); await slot.chain.catch(() => {}); }
      slots.clear();
    },
  };
}
