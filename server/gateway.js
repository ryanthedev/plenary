// The gateway: holds the sockets. It decodes frames, proves who is there, and passes verified messages to the
// board's room over the bus; what the room answers comes back over the bus, already encoded, addressed to a conn.
//
// Rule 8 (auth before the room): the first frame must be a hello. The gateway awaits Auth.verify(token), the
// Registry's board lookup and Auth.role(identity, board), in that order, and only then publishes the hello,
// WITHOUT the token, as { n, conn, gateway, user, role, client, msg }. Any refusal answers `auth` and closes; an
// unknown board and a board without a role get the same answer (rule 7).
//
// Bad frames never reach a room and never throw out of here: binary, nested too deep, not JSON, not an object,
// no `t`, a second hello, an unknown `t`. Before hello: `error` and close. After: `error`, and a close after a few
// of them in a short time (a second hello closes at once: rule 11).
// Never logged: frames, hellos, tokens, decode error text (JSON.parse echoes its input).
//
// Outbound: every frame for a connection goes through its own queue, handed to the socket only as fast as the
// socket takes it (Bun's `drain`). What the process owes its readers is budgeted per user and in total; a joiner
// there is no room for is told `unavailable`, a reader that drains nothing for stallMs is cut, whatever it sends.

import { jsonCodec } from "../packages/protocol/codec.js";
import { ROLES, MAX_CLIENT_CHARS } from "../packages/protocol/envelope.js";
import { subjects } from "./bus/memory.js";
import { isId } from "./ids.js";
import { quietLogger } from "./log.js";
import { breathe } from "./breather.js";

export const LIMITS = {
  maxFrameBytes: 4 * 1024 * 1024,   // transport cap: an op is ≤ 1,000,000 chars (≤ 3 bytes each); above this Bun closes with 1009
  maxHelloChars: 16 * 1024,         // the first frame: before auth nobody gets to make us hold or parse megabytes
  maxTokenChars: 8 * 1024,
  maxDepth: 64,                     // § Limits, nesting depth: checked on the raw text, before any parsing
  helloTimeoutMs: 10_000,           // a socket that never says hello, or never gets its welcome
  maxStrikes: 8,                    // bad frames after hello before the socket is closed…
  strikeDecayMs: 10_000,            // …one is forgiven per this much time
  // Inbound, before welcome. Sizes are in characters of text (UTF-16 units): up to 2 bytes of memory each.
  maxQueuedBytes: 2 * 1024 * 1024,        // frames waiting behind an await (auth, room open), per connection
  maxTotalQueuedBytes: 64 * 1024 * 1024,  // …and over every connection of the process: past it the newest sender is refused
  frameOverheadBytes: 256,                // what an empty queued frame is counted as
  // Outbound. "Owed" to a connection = the bytes in its socket buffer + the bytes of its own queued frames (live
  // traffic, errors). Queued catch-up frames are shared text and count nothing until they enter a socket (flush).
  // Every outbound size is in UTF-8 bytes, the unit Bun's getBufferedAmount reports.
  // The largest snapshot the spec's caps allow (PROTOCOL.md § Limits: `board` 50 MB + `notes` 50 MB + `records`
  // 20 MB of JSON). § Limits doesn't say chars or bytes, so the worst case is taken: 3 UTF-8 bytes per char, and
  // +25% for what a snapshot holds besides the streams (noteAuthor, appSeq, the envelope). 120 M × 3 × 1.25 = 450 MB.
  // It sets Bun's backpressureLimit (a threshold, not an allocation); nothing here holds that much per socket.
  maxSnapshotBytes: 450_000_000,
  // Bun's WebSocket CLIENT refuses one message over 128 MiB (it closes 1006; measured on Bun 1.4.4, the server
  // side sends it fine). A frame over this is logged as a warning: a server can't see that refusal.
  maxClientMessageBytes: 128 * 1024 * 1024,
  maxUserBufferedBytes: 64 * 1024 * 1024,   // owed to all of one user's connections: no account holds the whole budget
  maxTotalBufferedBytes: 256 * 1024 * 1024, // owed to every connection of the process
  maxConnsPerUser: 64,                      // open connections per user on this gateway (my choice: the spec has no cap yet)
  stallMs: 15_000,                          // owed bytes and not one drained for this long: closed, whatever the socket sends
  stallGraceMs: 2_000,                      // …and after only this long, when a joiner needs the room it is holding
  maxCatchUpWaitMs: 30_000,                 // a joiner waiting this long for room is told `unavailable` (it retries)
  slowEtaMs: 60_000,                        // when a joiner needs room: a reader that, at its measured pace, needs longer than this to drain what its socket holds makes way
  maxConnQueuedBytes: 16 * 1024 * 1024,     // a connection's own queued frames (live traffic behind a slow socket or a catch-up)
  maxSharedQueuedBytes: 256 * 1024 * 1024,  // distinct catch-up text that queues still reference (text the room has since replaced stays alive through them)
  sweepMs: 1_000,                           // how often stalls and budgets are re-read from the sockets
};

const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
let counter = 0;
const mintId = prefix => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 6).toString(36)}-${(++counter).toString(36)}`;

/**
 * Is this JSON text nested deeper than `max` levels of arrays and objects? One linear pass, no parsing, no
 * recursion: a 30,000-deep frame costs the same as a flat one of that length. Brackets inside strings don't count.
 * (Text that isn't JSON gets some answer here and is refused by the decoder next.)
 */
export function nestedDeeperThan(text, max) {
  let depth = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 92) i++;                       // backslash: skip the escaped character
      else if (ch === 34) inString = false;     // closing quote
    } else if (ch === 34) inString = true;
    else if (ch === 123 || ch === 91) { if (++depth > max) return true; }   // { [
    else if (ch === 125 || ch === 93) depth--;                               // } ]
  }
  return false;
}

// Best effort, so a refused deep op can still name itself and the client can undo it (rule 5): today's Replica
// writes `{"t":"op","id":"…"` first. Any other layout gets the error without an id.
const OP_ID = /^\s*\{\s*"t"\s*:\s*"op"\s*,\s*"id"\s*:\s*"([^"\\]{1,256})"/;

/**
 * @param {{
 *   auth: { verify(token: string): Promise<object|null>, role(identity: object, board: string): Promise<string|null> },
 *   registry: { board(id: string): Promise<{ id: string, tenant: string }|null> },
 *   bus: object,
 *   rooms: { open(tenant: string, board: string): Promise<void> },
 *   log?: object, codec?: object, id?: string, limits?: Partial<typeof LIMITS>, now?: () => number,
 * }} o
 */
export function gateway({ auth, registry, bus, rooms, log = quietLogger, codec = jsonCodec, id = mintId("gw"), limits = {}, now = Date.now }) {
  const lim = { ...LIMITS, ...limits };
  /** @type {Map<string, any>} conn id → ws */
  const conns = new Map();
  const counts = { accepted: 0, refusedAuth: 0, badFrames: 0, cut: 0, turnedAway: 0 };
  const sizeOf = data => (typeof data === "string" ? data.length : data?.byteLength ?? 0);   // inbound: chars
  const bytesOf = data => (typeof data === "string" ? Buffer.byteLength(data, "utf8") : data?.byteLength ?? 0);   // outbound: UTF-8 bytes
  // Bun drops a frame (send returns 0) when its socket already holds more than this. flush() never hands it one
  // then (it waits for the next drain), so a frame behind a big snapshot is delayed, never lost.
  const backpressureLimit = lim.maxSnapshotBytes + lim.maxUserBufferedBytes;

  const send = (ws, msg) => { try { if (ws.data.state !== "closed") ws.send(codec.encode(msg)); } catch { /* socket already gone */ } };
  // ---- outbound accounting: what every connection is owed, per user and in all ----
  let owedTotal = 0, queuedTotal = 0, socketTotal = 0;   // socketTotal: the part of owedTotal that sits in socket buffers
  /** @type {Map<string, number>} */ const socketByUser = new Map();
  /** @type {Map<string, number>} */ const owedByUser = new Map();
  /** @type {Map<string, number>} */ const connsByUser = new Map();
  const bump = (map, key, by) => { const v = (map.get(key) ?? 0) + by; if (v > 0) map.set(key, v); else map.delete(key); };
  /** Re-read one socket's buffer and bring the totals up to date. Returns what it is owed now. */
  const observe = ws => {
    const c = ws.data;
    if (c.state !== "live") return 0;
    let buffered = 0;
    try { buffered = ws.getBufferedAmount(); } catch { buffered = 0; }
    const t = now();
    // "Reading" is judged on the socket alone: its buffer went down. (Frames waiting in the queue say nothing
    // about the reader: a joiner waiting for room has a full queue and an empty socket.)
    if (buffered < c.buffered) { c.progressAt = t; c.winDrained += c.buffered - buffered; }
    if (c.buffered === 0 && buffered > 0) { c.progressAt = t; c.winStart = t; c.winDrained = 0; }   // the socket starts holding bytes: the clocks start
    const owed = buffered + c.outBytes, delta = owed - c.owed, inSocket = buffered - c.buffered;
    c.buffered = buffered; c.owed = owed;
    if (delta) { owedTotal += delta; bump(owedByUser, c.user, delta); }
    if (inSocket) { socketTotal += inSocket; bump(socketByUser, c.user, inSocket); }
    return owed;
  };

  // Catch-up text is shared: the room host encodes a snapshot or a chunk once and names it (`catchup: "<key>"`);
  // every queue that holds it holds the same string. So it is counted once, here, however many joiners wait on it.
  // What this bounds is text the room has already replaced (after a fold, or when the tail grew) that waiting
  // joiners still reference: without a count, joiners parked across many folds would each pin a board's worth.
  /** @type {Map<string, { len: number, refs: number }>} */ const sharedText = new Map();
  let sharedBytes = 0;
  const hold = (key, len) => { const e = sharedText.get(key); if (e) e.refs++; else { sharedText.set(key, { len, refs: 1 }); sharedBytes += len; } };
  /**
   * Say so, once per text, when a frame is larger than the transport is known to handle. Neither is a silent drop
   * any more: the frame is still sent (Bun's server takes any frame into an empty socket), but a client may refuse it.
   */
  const warned = new Set();   // names of shared texts already reported (bounded: cleared at 1,000)
  const warnSize = (c, item) => {
    if (item.len <= lim.maxClientMessageBytes && item.len <= backpressureLimit) return;
    if (item.shared) { if (warned.has(item.shared)) return; if (warned.size >= 1000) warned.clear(); warned.add(item.shared); }
    const fields = { conn: c.id, board: c.board, bytes: item.len, key: item.shared || undefined };
    if (item.len > backpressureLimit) log.error("outbound frame over the socket's backpressureLimit: the board is past the spec's caps (PROTOCOL.md § Limits); frames behind it wait for the socket to empty", { ...fields, backpressureLimit });
    else log.warn("outbound frame over 128 MiB: Bun's WebSocket client refuses it (closes 1006); browsers are untested", { ...fields, maxClientMessageBytes: lim.maxClientMessageBytes });
  };
  const release = key => { const e = sharedText.get(key); if (e && --e.refs <= 0) { sharedText.delete(key); sharedBytes -= e.len; } };
  /** Forget everything queued for a connection. */
  const dropQueue = c => { if (!c.out) return; for (const item of c.out) if (item.shared) release(item.shared); c.out.length = 0; c.outBytes = 0; c.waitSince = 0; };

  const end = (ws, code, reason) => {
    const c = ws.data;
    if (c.state === "closed") return;
    const wasLive = c.state === "live";
    c.state = "closed"; clearTimeout(c.timer); conns.delete(c.id);
    if (c.q) { queuedTotal -= c.qBytes; c.q.length = 0; c.qBytes = 0; }   // frames still waiting are dropped with the socket, not held
    if (wasLive) {
      owedTotal -= c.owed; bump(owedByUser, c.user, -c.owed); bump(connsByUser, c.user, -1);
      socketTotal -= c.buffered; bump(socketByUser, c.user, -c.buffered); c.buffered = 0;
      c.owed = 0; dropQueue(c); waiters.delete(ws);
      // § Bus: the close notice.
      bus.publish(subjects.inbox(c.tenant, c.board), { n: ++c.n, conn: c.id, gateway: id, closed: true });
    }
    try { ws.close(code, reason); } catch { /* already closed */ }
    if (wasLive && waiters.size) queueMicrotask(wake);   // the room it held is free
  };
  /** Close a reader that isn't reading: nothing more can be told to it, and its buffer is freed now, not after a graceful close. */
  const cut = (ws, why) => {
    const c = ws.data;
    log.warn("reader closed", { conn: c.id, board: c.board, user: c.user, why, owed: c.owed });
    counts.cut++;
    try { ws.terminate?.(); } catch { /* already gone */ }
    end(ws, 1013, why);
  };
  const refuse = (ws, code, message, closeCode, reason) => { send(ws, { t: "error", code, message }); end(ws, closeCode, reason); };

  // ---- outbound delivery: paced by the socket, bounded by budgets ----
  // Every frame for a connection goes through its queue; flush() hands frames to the socket until the socket says
  // it is backed up (send returns -1), then stops until Bun's `drain`.
  //
  // What counts against the budgets is what a connection really costs:
  //   - bytes in its socket buffer (copies), and
  //   - queued frames that are its own (live traffic, errors).
  // A queued CATCH-UP frame costs nothing: it is the room's encode-once text, one immutable string shared by every
  // joiner, and the queue holds only a reference. So a catch-up of any size can wait in the queue; it is PULLED
  // into the socket one frame at a time, as the socket drains and only while that fits the budgets. A joiner's
  // memory is then its socket buffer, never the board. (If catch-up frames counted while queued, a board bigger
  // than a user's share could never be joined at all, whoever asked and however fast they read.)
  function flush(ws) {
    const c = ws.data;
    if (c.flushing) return;
    c.flushing = true;
    try {
      while (c.state === "live" && c.out.length && !c.blocked) {
        const item = c.out[0];
        if (item.shared) {
          const scope = noRoom(c, item.len);
          if (scope) {
            // No room in the budgets for this frame's copy yet. Room held by a reader that isn't reading is taken
            // back first (whoever has drained nothing the longest, at least stallGraceMs); otherwise this joiner
            // waits its turn, at no cost, and is woken when anyone drains. Nobody who is draining is cut for it.
            const idle = laggard(scope === "user" ? c.user : undefined);
            if (idle && idle !== ws) { cut(idle, "making room for a joiner: its socket is full and it reads too slowly to empty it"); continue; }
            if (!c.waitSince) c.waitSince = now();
            waiters.add(ws);
            break;
          }
        }
        // Bun drops a frame handed to a socket that holds more than backpressureLimit. Behind a big snapshot, `drain`
        // fires while the socket still holds most of it: wait for more to drain rather than hand it a frame it drops.
        // (Into an empty socket any frame goes, however large: there is nothing to wait for.)
        if (c.buffered > 0 && c.buffered + item.len > backpressureLimit) { c.blocked = true; break; }
        warnSize(c, item);
        let sent;
        try { sent = ws.send(item.data); } catch { cut(ws, "send failed"); return; }
        if (sent === 0) { log.error("outbound frame dropped by the transport", { conn: c.id, board: c.board, bytes: item.len, buffered: c.buffered, backpressureLimit }); cut(ws, "frame dropped by the transport"); return; }   // never a silent gap: it reconnects and catches up
        c.out.shift();
        if (item.shared) release(item.shared); else c.outBytes -= item.len;
        if (sent === -1) c.blocked = true;
        observe(ws);                                     // the next frame is judged against what this one left behind
      }
      if (c.state === "live") {
        if (!c.out.length || !c.out[0].shared || c.blocked) { c.waitSince = 0; waiters.delete(ws); }
        observe(ws);
      }
    } finally { c.flushing = false; }
  }
  /** Joiners whose next catch-up frame is waiting for room. Woken whenever someone drains or leaves. */
  const waiters = new Set();
  const wake = () => { for (const ws of [...waiters]) { if (ws.data.state !== "live") waiters.delete(ws); else flush(ws); } };

  /** The connection owed the most among `user`'s (or among all): the slowest reader. */
  function slowest(user) {
    let worst = null;
    for (const ws of conns.values()) { const c = ws.data; if (c.state === "live" && (user === undefined || c.user === user) && c.owed > (worst?.data.owed ?? 0)) worst = ws; }
    return worst;
  }
  /**
   * Among `user`'s connections (or all): the reader to move aside when a joiner needs room. Its socket holds bytes,
   * it has been watched for at least stallGraceMs, and at the pace it drained in that time it needs longer than
   * slowEtaMs to empty the socket (a reader that drained nothing needs for ever). The worst such reader, or null.
   * So a socket that never reads, and one that reads a trickle to look alive, both make way; a reader that is
   * getting through its catch-up does not.
   */
  function laggard(user) {
    const t = now(); let worst = null, worstEta = lim.slowEtaMs;
    for (const ws of conns.values()) {
      const c = ws.data;
      if (c.state !== "live" || !(c.buffered > 0) || (user !== undefined && c.user !== user)) continue;
      const watched = t - c.winStart;
      if (watched < lim.stallGraceMs) continue;
      const eta = c.winDrained > 0 ? c.buffered / (c.winDrained / watched) : Infinity;
      if (eta > worstEta) { worst = ws; worstEta = eta; }
    }
    return worst;
  }
  const over = (c, len) => (owedByUser.get(c.user) ?? 0) + len > lim.maxUserBufferedBytes ? "user" : owedTotal + len > lim.maxTotalBufferedBytes ? "total" : null;
  /** Like over(), for handing one shared frame to a socket: a frame bigger than a whole budget goes when that budget is empty, or it never could. */
  // Judged on what is in sockets: that is where this frame's copy will go. (Queued live frames don't block it: a
  // waiting joiner's own queue would otherwise keep it waiting for ever.)
  const noRoom = (c, len) => {
    const mine = socketByUser.get(c.user) ?? 0;
    if (mine > 0 && mine + len > lim.maxUserBufferedBytes) return "user";
    if (socketTotal > 0 && socketTotal + len > lim.maxTotalBufferedBytes) return "total";
    return null;
  };

  /**
   * May `len` more of its own frames (live traffic, errors) queue for this connection? Judged on its own queue only:
   * what sits in sockets is governed where it is put there (noRoom) and by the stall rules, and counting it here
   * would cut a joiner whose socket holds a snapshot the moment a live entry arrived for it or for its other tab.
   */
  function admit(ws, len) {
    const c = ws.data;
    if (c.outBytes + len <= lim.maxConnQueuedBytes) return true;
    // Too far behind. A joiner still waiting for room hasn't done anything wrong (and can hear us): it is told to
    // come back. Anyone else isn't reading: it is cut, and catches up when it reconnects.
    if (c.waitSince) { counts.turnedAway++; log.warn("joiner turned away: too much live traffic queued while it waited", { conn: c.id, board: c.board }); dropQueue(c); refuse(ws, "unavailable", "the server is busy: try again shortly", 1013, "over budget"); }
    else cut(ws, "too far behind on live traffic");
    return false;
  }
  /** Tell a joiner there is no room for it now. Its socket is empty or nearly, so the error can arrive. */
  function turnAway(ws, why) {
    const c = ws.data;
    counts.turnedAway++;
    log.warn("joiner turned away", { conn: c.id, board: c.board, user: c.user, why, owedTotal, sharedBytes });
    dropQueue(c);
    refuse(ws, "unavailable", "the server is busy: try again shortly", 1013, "over budget");
  }
  /** Queue one of this connection's own frames (live traffic, an error) behind whatever it is already owed. */
  function push(ws, data) {
    const c = ws.data;
    if (c.state !== "live") return;
    const len = bytesOf(data);
    if (!admit(ws, len)) return;
    c.out.push({ data, len, shared: false }); c.outBytes += len;
    flush(ws);
  }

  // Room → gateway: { conn, data, catchup?, close? }. `data` is an encoded frame; the room host encoded it once.
  // `catchup` marks the shared catch-up text (the snapshot and the whole-tail chunks).
  const unsub = bus.subscribe(subjects.gateway(id), m => {
    const ws = conns.get(m?.conn);
    if (!ws || ws.data.state !== "live") return;
    const c = ws.data;
    if (!c.answered) { c.answered = true; clearTimeout(c.timer); }
    if (m.close) {
      // The room is sending this connection away: what was queued for it is dropped, not delivered first.
      dropQueue(c);
      if (m.data !== undefined) { try { ws.send(m.data); } catch { /* gone */ } }
      return end(ws, m.close, "closed by the room");
    }
    if (typeof m.data !== "string" && !(m.data instanceof Uint8Array)) return;
    if (typeof m.catchup === "string" && m.catchup) {
      // UTF-8 bytes, measured once per text: the room host sends `bytes` with it (a board's snapshot is one string of
      // up to hundreds of MB); otherwise the count already held for this name, else it is measured here.
      const len = sharedText.get(m.catchup)?.len ?? (Number.isSafeInteger(m.bytes) && m.bytes >= 0 ? m.bytes : bytesOf(m.data));
      // New text that would take the distinct queued catch-up text over its bound: the joiners who have waited the
      // longest (they hold the oldest text) are told to come back, then, if that isn't enough, this one.
      if (!sharedText.has(m.catchup) && sharedBytes + len > lim.maxSharedQueuedBytes) {
        const waiting = [...waiters].filter(w => w !== ws && w.data.state === "live").sort((a, b) => a.data.waitSince - b.data.waitSince);
        for (const w of waiting) { if (sharedBytes + len <= lim.maxSharedQueuedBytes) break; turnAway(w, "too much superseded catch-up text held by waiting joiners"); }
        // One text bigger than the whole bound is still held when it is the only one (`sharedBytes > 0`): otherwise
        // a board that size could never be joined. So the bound is max(maxSharedQueuedBytes, the largest one text).
        if (sharedBytes + len > lim.maxSharedQueuedBytes && sharedBytes > 0) return turnAway(ws, "too much catch-up text queued");
      }
      hold(m.catchup, len);
      c.out.push({ data: m.data, len, shared: m.catchup }); flush(ws);
    } else push(ws, m.data);
  });

  // The sweep: re-reads every socket (drain events are the fast path; this is the safety net), restarts queues
  // whose socket emptied, and closes readers that are owed bytes and have drained none for stallMs. What a
  // socket SENDS is irrelevant to that: a client that keeps sending presence but never reads is still stalled.
  // SEAM(p4): real backpressure (thin presence, serve catch-up from the Store on demand) replaces most of this.
  const sweep = setInterval(() => {
    try {
      const t = now();
      for (const ws of [...conns.values()]) {
        const c = ws.data;
        if (c.state !== "live") continue;
        observe(ws);
        if (c.buffered === 0 && c.blocked) c.blocked = false;
        if (c.out.length && !c.blocked) flush(ws);
        if (c.state !== "live") continue;
        if (c.buffered > 0 && t - c.progressAt > lim.stallMs) { cut(ws, "stalled: owed bytes, none read"); continue; }
        // The pace is measured over a recent window, so a reader that picked up speed isn't judged on its past.
        if (c.winDrained > 0 && t - c.winStart > 4 * lim.stallGraceMs) { c.winStart = t; c.winDrained = 0; }
        // A joiner that has waited this long for room is told to come back later rather than wait for ever.
        if (c.waitSince && t - c.waitSince > lim.maxCatchUpWaitMs) turnAway(ws, "no room for its catch-up in time");
      }
      // Slow readers of live traffic can add up without any one of them stalling yet.
      // (A joiner still waiting for room is owed only what queued behind its catch-up: it is told, not reset.)
      for (let worst; owedTotal > lim.maxTotalBufferedBytes && (worst = slowest()) && worst.data.owed > 0;) { if (worst.data.waitSince) turnAway(worst, "over the total outbound budget while it waited"); else cut(worst, "over the total outbound budget"); }
      wake();
    } catch (err) { log.error("gateway: sweep failed", { err }); }
  }, lim.sweepMs);
  sweep.unref?.();

  function badFrame(ws, why, message, code = "bad-op", opId) {
    const c = ws.data; counts.badFrames++;
    log.warn("frame refused", { conn: c.id, why, state: c.state });
    if (c.state !== "live") return refuse(ws, code, message, 1008, "bad frame");
    push(ws, codec.encode({ t: "error", ...(opId ? { id: opId } : {}), code, message }));   // through the queue: counted and paced like anything else
    // Strikes fade: a long-lived connection isn't closed for a handful of mistakes spread over hours.
    const t = now(), forgiven = Math.floor((t - c.strikeAt) / lim.strikeDecayMs);
    if (forgiven > 0) { c.strikes = Math.max(0, c.strikes - forgiven); c.strikeAt = t; }
    if (++c.strikes >= lim.maxStrikes) end(ws, 1008, "too many bad frames");
  }

  async function hello(ws, msg) {
    const c = ws.data;
    // SEAM(p2): `v: 1` becomes required once Replica sends it (today's Replica sends no `v`).
    if (msg.v !== undefined && msg.v !== 1) return badFrame(ws, "hello-version", "this server speaks protocol v1", "version");
    if (typeof msg.client !== "string" || !msg.client || msg.client.length > MAX_CLIENT_CHARS || msg.client.includes(":"))
      return badFrame(ws, "hello-client", "hello needs a client id (no colon)");
    if (msg.since !== undefined && (!Number.isSafeInteger(msg.since) || msg.since < 0)) return badFrame(ws, "hello-since", "since must be a non-negative integer");
    c.state = "auth";
    const deny = why => { counts.refusedAuth++; log.info("hello refused", { conn: c.id, why }); refuse(ws, "auth", "not allowed", 1008, "auth"); };
    const down = (what, err) => { log.error("hello failed", { conn: c.id, what, err }); refuse(ws, "unavailable", "try again shortly", 1013, "unavailable"); };

    if (typeof msg.token !== "string" || !msg.token || msg.token.length > lim.maxTokenChars) return deny("no-token");
    let identity, board, role;
    // verify() was handed the token, so its error text may quote it: log the error's name and code only.
    try { identity = await auth.verify(msg.token); } catch (err) { return down("verify", { name: String(err?.name ?? "Error").slice(0, 60), code: typeof err?.code === "string" ? err.code.slice(0, 60) : undefined }); }
    if (c.state !== "auth") return;                       // the socket closed while we waited
    if (!identity || typeof identity.user !== "string" || !identity.user) return deny("token");
    // The board id is only a lookup key here; subjects and store keys are built from the registry's own record.
    if (!isId(msg.board)) return deny("board");
    try { board = await registry.board(msg.board); } catch (err) { return down("board", err); }
    if (c.state !== "auth") return;
    if (!board || board.id !== msg.board || !isId(board.id) || !isId(board.tenant)) return deny("board");
    try { role = await auth.role(identity, board.id); } catch (err) { return down("role", err); }
    if (c.state !== "auth") return;
    if (!ROLES.includes(role)) return deny("role");
    // My choice (PROTOCOL.md § Known limits: "no cap on connections per user"): one account can't hold every
    // socket of the process. Configurable, because load tests share a few dev tokens.
    if ((connsByUser.get(identity.user) ?? 0) >= lim.maxConnsPerUser) { log.warn("hello refused: too many connections for one user", { conn: c.id, user: identity.user }); return refuse(ws, "unavailable", "too many connections for this user", 1013, "user connection cap"); }
    // SEAM(p4): rule 8, viewers never reach the room. Today every role, viewers too, is forwarded and becomes a
    // Room connection; the 100k-viewer design needs the gateway to serve a viewer's catch-up and live entries
    // itself (from the Store and the entries subject, subscribed BEFORE the hello is forwarded).
    try { await rooms.open(board.tenant, board.id); } catch (err) { return down("room", err); }
    if (c.state !== "auth") return;
    // The cap again, in the same step that counts this connection: hellos that were waiting together on the
    // awaits above all passed the first check.
    if ((connsByUser.get(identity.user) ?? 0) >= lim.maxConnsPerUser) { log.warn("hello refused: too many connections for one user", { conn: c.id, user: identity.user }); return refuse(ws, "unavailable", "too many connections for this user", 1013, "user connection cap"); }

    Object.assign(c, { state: "live", tenant: board.tenant, board: board.id, user: identity.user, name: typeof identity.name === "string" ? identity.name.slice(0, 200) : null, role, client: msg.client,
      out: [], outBytes: 0, buffered: 0, owed: 0, blocked: false, flushing: false, waitSince: 0, progressAt: now(), winStart: now(), winDrained: 0 });
    bump(connsByUser, c.user, 1);
    counts.accepted++;   // the hello timer keeps running until the room's first frame arrives (the bus may drop a hello)
    log.info("hello accepted", { conn: c.id, tenant: c.tenant, board: c.board, user: c.user, role });
    forward(c, { t: "hello", board: board.id, since: msg.since ?? 0, client: msg.client });   // no token past this line
  }

  // § Bus: gateway → room as { n, conn, gateway, user, name, role, client, msg }, numbered per connection (rule 6).
  // SEAM(p2): rule 11 says an op that arrives before `welcome` gets `auth`. Today's v0 Replica sends its unacked
  // ops right behind its hello, so frames queued behind the hello are forwarded as soon as the hello is (the room
  // handles them in `n` order, hello first). v1's Replica resends after `welcome`; then this becomes a refusal.
  const forward = (c, msg) => bus.publish(subjects.inbox(c.tenant, c.board), { n: ++c.n, conn: c.id, gateway: id, user: c.user, name: c.name, role: c.role, client: c.client, msg });

  async function frame(ws, data) {
    const c = ws.data;
    if (c.state === "closed") return;
    if (typeof data !== "string") return badFrame(ws, "binary", "send text frames");
    // Until the hello has been read, no frame may be bigger than a hello: nothing larger is scanned or parsed for
    // someone who hasn't said who they are (presence before hello is dropped, so this is not only the first frame).
    if (c.state === "new" && data.length > lim.maxHelloChars) return badFrame(ws, "hello-too-large", "hello is too large", "too-large");
    // § Limits, nesting depth, before decoding: a deeply nested frame is cheap to parse and ruinous to re-encode.
    if (nestedDeeperThan(data, lim.maxDepth)) return badFrame(ws, "too-deep", `nested deeper than ${lim.maxDepth} levels`, "bad-op", c.state === "live" ? OP_ID.exec(data.slice(0, 512))?.[1] : undefined);
    let msg;
    try { msg = codec.decode(data); } catch { return badFrame(ws, "undecodable", "that frame could not be decoded"); }
    if (!isObj(msg) || typeof msg.t !== "string") return badFrame(ws, "shape", "a message is an object with a type `t`");
    if (c.state === "new") {
      if (msg.t === "hello") return hello(ws, msg);
      if (msg.t === "presence") return;                   // rule 11: presence before welcome is dropped
      return badFrame(ws, "no-hello", "say hello first", "auth");
    }
    // SEAM(p2): § Limits, durable ops per connection (20/s, burst 100: queue, then refuse with `limit`). Not enforced yet.
    if (msg.t === "op") {
      // v0's `transient: true` (an unlogged, unthrottled relay that today's Room still implements) was removed in
      // v1 (previews are presence). It is refused here rather than stripped: stripped, a preview would be logged
      // as a durable op. No strike: an old client sends many while dragging. SEAM(p2): goes when the Room drops it.
      if (msg.transient !== undefined) return push(ws, codec.encode({ t: "error", ...(typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {}), code: "bad-op", message: "transient ops were removed in protocol v1" }));
      // Only the fields an op has travel on.
      return void forward(c, { t: "op", id: msg.id, stream: msg.stream, op: msg.op });
    }
    // SEAM(p2): presence (packages/protocol/presence.js: shapes, rates, coalescing), relayed over
    // subjects.presence without touching the room. Until then it is dropped, silently, as the spec allows.
    if (msg.t === "presence") return;
    // Rule 11: one board per connection. A second hello gets `bad-op` and the connection is closed.
    if (msg.t === "hello") { counts.badFrames++; log.warn("frame refused", { conn: c.id, why: "second-hello", state: c.state }); return refuse(ws, "bad-op", "already said hello", 1008, "second hello"); }
    // SEAM(p3): `blob` (signed URLs) is not served yet; it is refused like an unknown type.
    badFrame(ws, "unknown-type", "unknown message type");
  }

  // One frame at a time per connection, in arrival order, even across the awaits in hello (rule 6). An explicit
  // queue, not a promise chain, so end() can drop what is waiting.
  async function pump(ws) {
    const c = ws.data;
    c.busy = true;
    try {
      while (c.q.length && c.state !== "closed") {
        const data = c.q.shift(), cost = sizeOf(data) + lim.frameOverheadBytes;
        c.qBytes -= cost; queuedTotal -= cost;
        await breathe();   // a burst of thousands of frames from one socket must not hold the loop either
        if (c.state === "closed") return;
        try { await frame(ws, data); } catch (err) { log.error("gateway: frame handler failed", { conn: c.id, err }); }
      }
    } finally { c.busy = false; }
  }

  return {
    id,
    /** Bun.serve({ websocket }) handlers. Nothing in them throws. */
    websocket: {
      maxPayloadLength: lim.maxFrameBytes,
      // Bun drops a frame handed to a socket already holding more than this. flush() never does (see there); it is set
      // above the largest snapshot § Limits allows plus a user's budget, so live traffic behind a snapshot rarely waits.
      backpressureLimit,
      idleTimeout: 120,
      open(ws) {
        try {
          const c = ws.data;
          Object.assign(c, { id: mintId("c"), state: "new", strikes: 0, strikeAt: now(), n: 0, answered: false, q: [], qBytes: 0, busy: false, first: true });
          conns.set(c.id, ws);
          c.timer = setTimeout(() => {
            // Never said hello: `auth`. Said hello and a port (sign-in, registry, store) or the room is slow or lost
            // the message (the bus is at-most-once): `unavailable`, so the client keeps its ops and retries.
            if (c.state === "new") { log.info("no hello in time", { conn: c.id }); refuse(ws, "auth", "say hello first", 1008, "hello timeout"); }
            else if (c.state === "auth" || (c.state === "live" && !c.answered)) { log.warn("no welcome in time", { conn: c.id, state: c.state }); refuse(ws, "unavailable", "try again shortly", 1013, "unavailable"); }
          }, lim.helloTimeoutMs);
        } catch (err) { log.error("gateway: open failed", { err }); }
      },
      message(ws, data) {
        try {
          const c = ws.data;
          if (!c.q || c.state === "closed") return;
          const size = sizeOf(data);
          // The first frame is the hello: refused here, before it is held, if it is too large to be one.
          if (c.first) { c.first = false; if (size > lim.maxHelloChars) return badFrame(ws, "hello-too-large", "hello is too large", "too-large"); }
          // What waits behind the hello's awaits is bounded in bytes, so one socket can't pin gigabytes while a
          // port is slow. SEAM(p2): today's Replica sends its unacked ops right behind the hello; a client holding
          // more than this must wait for v1 (resend after `welcome`) or for fast auth. It is told `unavailable`.
          // (Once live nothing awaits, so the queue only ever holds what one burst from the socket delivered.)
          if (c.state !== "live") {
            if (c.qBytes + size + lim.frameOverheadBytes > lim.maxQueuedBytes) { log.warn("frame queue overflow", { conn: c.id, state: c.state }); return refuse(ws, "unavailable", "too much sent before welcome", 1013, "queue overflow"); }
          }
          // …and over the whole process, so many sockets behind one slow port can't add up without bound.
          if (c.state !== "live" && queuedTotal + size + lim.frameOverheadBytes > lim.maxTotalQueuedBytes) { log.warn("frame queue overflow: process", { conn: c.id, state: c.state }); return refuse(ws, "unavailable", "the server is busy: try again shortly", 1013, "queue overflow"); }
          c.q.push(data); c.qBytes += size + lim.frameOverheadBytes; queuedTotal += size + lim.frameOverheadBytes;
          if (!c.busy) pump(ws).catch(err => { log.error("gateway: pump failed", { conn: c.id, err }); });
        } catch (err) { log.error("gateway: message failed", { err }); }
      },
      drain(ws) {
        try { const c = ws.data; if (c.state !== "live") return; observe(ws); c.blocked = false; flush(ws); if (waiters.size) wake(); }
        catch (err) { log.error("gateway: drain failed", { err }); }
      },
      close(ws) {
        try { end(ws, 1000, ""); } catch (err) { log.error("gateway: close failed", { err }); }
      },
    },
    /** `owedBytes` is read from the sockets now (not the running total), so a leak in the accounting would show. */
    stats: () => {
      let owed = 0;
      for (const ws of conns.values()) { const c = ws.data; if (c.state === "live") { try { owed += ws.getBufferedAmount(); } catch { /* gone */ } owed += c.outBytes; } }
      return { conns: conns.size, ...counts, owedBytes: owed, owedTracked: owedTotal, queuedBytes: queuedTotal, users: connsByUser.size, waitingJoiners: waiters.size, sharedBytes, sharedTexts: sharedText.size };
    },
    async close() { clearInterval(sweep); unsub(); for (const ws of [...conns.values()]) end(ws, 1001, "server closing"); },
  };
}
