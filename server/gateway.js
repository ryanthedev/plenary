// The gateway: holds the sockets. It decodes frames, proves who is there, and passes verified messages to the
// board's room over the bus; what the room answers comes back over the bus, already encoded, addressed to a conn.
//
// Rule 8 (auth before the room): the first frame must be a hello (`v: 1`). The gateway awaits Auth.verify(token),
// the Registry's board lookup and Auth.role(identity, board), in that order. Any refusal answers `auth` and closes;
// an unknown board and a board without a role get the same answer (rule 7). Then it subscribes to the board (its
// feed: catch-up and live entries, rules 3 and 8) and, for a writer only, publishes the hello WITHOUT the token as
// { n, conn, gateway, user, name, role, client, msg }. A viewer's hello never leaves the gateway: it is welcomed here.
//
// After welcome: ops are paced per connection (20/s, burst 100, queued in order) and numbered `n` toward the room
// (rule 6); a close notice and a 5 s list of open writer connections keep the room's `n` state bounded. Presence is
// checked, rate-limited, relayed over the bus and coalesced every 50 ms: it never reaches the room or the log.
// A `grants` message re-checks every connection's role on the board (revocation); a token's expiry closes it.
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
import { ROLES, MAX_CLIENT_CHARS, PROTOCOL_VERSION, RULES_VERSION, opProblem, parseOpId } from "../packages/protocol/envelope.js";
import { presenceProblem, presenceLimiter, presenceCoalescer, EMOTES } from "../packages/protocol/presence.js";
import { subjects, busBytes, MAX_BUS_BYTES } from "./bus/port.js";
import { boardFeed } from "./feed.js";
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
  // § Pacing and § Limits (v1.1).
  opRate: 20, opBurst: 100,                 // durable ops per connection: a token bucket; over-rate ops wait in order
  maxOpQueue: 500,                          // ops waiting for a token, per connection…
  maxOpQueueBytes: 8 * 1024 * 1024,         // …or their bytes: past either, `unavailable` and close
  maxLiveQueuedBytes: 8 * 1024 * 1024,      // frames read from a live socket and not yet handled
  maxWritersPerUserBoard: 8,                // writer connections per (user, board) on this gateway; a ninth gets `limit`
  idleTimeoutSec: 30,                       // heard nothing (no frame, no pong) for this long: closed
  presenceMs: 50,                           // coalesced presence goes out this often
  emoteWindowMs: 500,                       // viewers' emotes are summed per window
  connListMs: 5_000,                        // open writer connections are listed to each room this often
  roleRecheckMs: 60_000,                    // every live connection's role is computed again this often (a link or invite expiring is not a `grants` message)
  feed: {},                                 // options for each board's feed (pollMs, chunkBytes, …; tests)
};

const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
/** How long to wait before looking at a token's expiry again: 0 once it has passed, never more than setTimeout's cap. */
export const expiryWait = (expSec, nowMs) => Math.max(0, Math.min(2 ** 31 - 1, expSec * 1000 - nowMs));
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
 *   store: { read: Function, getCheckpoint: Function, epoch: Function },
 *   bus: object,
 *   rooms: { open(tenant: string, board: string): Promise<void> },
 *   log?: object, codec?: object, id?: string, limits?: Partial<typeof LIMITS>, now?: () => number,
 * }} o
 */
export function gateway({ auth, registry, store, bus, rooms, log = quietLogger, codec = jsonCodec, id = mintId("gw"), limits = {}, now = Date.now, feedOf = boardFeed }) {
  const lim = { ...LIMITS, ...limits };
  const maxBusBytes = bus.maxBytes ?? MAX_BUS_BYTES;
  /** @type {Map<string, number>} "user|board" → open writer connections (§ Pacing) */
  const writersBy = new Map();
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
    c.state = "closed"; clearTimeout(c.timer); clearTimeout(c.expTimer); clearTimeout(c.opTimer); conns.delete(c.id);
    unwatchGrants(c);
    if (c.q) { queuedTotal -= c.qBytes; c.q.length = 0; c.qBytes = 0; }   // frames still waiting are dropped with the socket, not held
    if (wasLive) {
      owedTotal -= c.owed; bump(owedByUser, c.user, -c.owed); bump(connsByUser, c.user, -1);
      if (c.wkey) bump(writersBy, c.wkey, -1);
      socketTotal -= c.buffered; bump(socketByUser, c.user, -c.buffered); c.buffered = 0;
      c.owed = 0; dropQueue(c); waiters.delete(ws); c.opq.length = 0;
      // § Bus: the close notice (rule 6), for a connection the room heard of.
      if (c.forwarded) bus.publish(subjects.inbox(c.tenant, c.board), { n: ++c.n, conn: c.id, gateway: id, closed: true })?.catch?.(() => {});
      // § Presence: `leave`, so everyone drops this connection's cursor now rather than in 30 s.
      if (c.welcomed) bus.publish(subjects.presence(c.tenant, c.board), { gateway: id, user: c.user, client: c.client, leave: true })?.catch?.(() => {});
    }
    leaveBoard(ws);   // also a connection that joined its board and closed during the rest of its hello
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

  /**
   * Queue a catch-up frame `{ data, bytes, shared }`. Shared text (a snapshot, a whole chunk) is encode-once text
   * many joiners hold: it is counted once however many queues hold it, and pulled into each socket as it drains.
   */
  function pushShared(ws, f) {
    const c = ws.data;
    if (c.state !== "live") return;
    if (!f.shared) return push(ws, f.data);
    const len = sharedText.get(f.shared)?.len ?? (Number.isSafeInteger(f.bytes) && f.bytes >= 0 ? f.bytes : bytesOf(f.data));
    // New text that would take the distinct queued catch-up text over its bound: the joiners who have waited the
    // longest (they hold the oldest text) are told to come back, then, if that isn't enough, this one.
    if (!sharedText.has(f.shared) && sharedBytes + len > lim.maxSharedQueuedBytes) {
      const waiting = [...waiters].filter(w => w !== ws && w.data.state === "live").sort((x, y) => x.data.waitSince - y.data.waitSince);
      for (const w of waiting) { if (sharedBytes + len <= lim.maxSharedQueuedBytes) break; turnAway(w, "too much superseded catch-up text held by waiting joiners"); }
      // One text bigger than the whole bound is still held when it is the only one (`sharedBytes > 0`): otherwise
      // a board that size could never be joined. So the bound is max(maxSharedQueuedBytes, the largest one text).
      if (sharedBytes + len > lim.maxSharedQueuedBytes && sharedBytes > 0) return turnAway(ws, "too much catch-up text queued");
    }
    hold(f.shared, len);
    c.out.push({ data: f.data, len, shared: f.shared }); flush(ws);
  }

  // Room → gateway: { conn, data?, close? }: `welcome`, `ack`, `error` only (§ Bus), encoded once by the room host.
  const unsub = bus.subscribe(subjects.gateway(id), m => {
    const ws = conns.get(m?.conn);
    if (!ws || ws.data.state !== "live") return;
    const c = ws.data;
    if (m.data !== undefined && typeof m.data !== "string" && !(m.data instanceof Uint8Array)) return;
    if (!c.welcomed && !c.welcoming && m.data !== undefined) {
      let msg = null;
      try { msg = codec.decode(m.data); } catch { msg = null; }
      if (msg?.t === "welcome") { welcomed(ws, m.data, Number.isSafeInteger(msg.seq) ? msg.seq : 0); if (m.close) end(ws, m.close, "closed by the room"); return; }
    }
    if (m.close) {
      // The room is sending this connection away: what was queued for it is dropped, not delivered first.
      dropQueue(c);
      if (m.data !== undefined) { try { ws.send(m.data); } catch { /* gone */ } }
      return end(ws, m.close, m.close === 1008 ? "refused by the room" : "closed by the room");
    }
    if (m.data !== undefined) push(ws, m.data);
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

  // ---- boards: one feed, presence relay and emote sums per board this gateway serves ----

  /** @type {Map<string, any>} "tenant/board" → board state */
  const boards = new Map();
  const welcomedOn = b => [...b.conns].filter(ws => ws.data.state === "live" && ws.data.welcomed);

  function onLive(b, { from, to, data }) {
    for (const ws of b.conns) {
      const c = ws.data;
      if (c.state !== "live" || c.next === undefined || to < c.next) continue;
      // The feed hands every resolved entry once, in order, and a connection joins it at the feed's seq: no cut needed.
      if (from > c.next) { log.error("feed skipped entries for a connection", { conn: c.id, next: c.next, from }); cut(ws, "missed entries"); continue; }
      push(ws, data); c.next = to + 1;
    }
  }

  /** Join a board (subscribe its subjects before anything is forwarded or served: § Bus). Resolves once its feed is ready. */
  async function joinBoard(ws, tenant, board) {
    const key = `${tenant}/${board}`;
    let b = boards.get(key);
    if (!b) {
      b = { key, tenant, board, conns: new Set(), refs: 0, coalescer: presenceCoalescer(), mine: {}, sums: new Map(), unsubs: [] };
      b.feed = feedOf({ tenant, board, store, bus, log, codec, onLive: e => onLive(b, e), ...lim.feed });
      b.unsubs.push(bus.subscribe(subjects.presence(tenant, board), m => {
        if (!m || typeof m.user !== "string" || typeof m.client !== "string") return;
        if (m.leave) b.coalescer.leave(m.user, m.client); else if (m.msg && typeof m.msg === "object") b.coalescer.add(m.user, m.client, m.msg);
      }));
      b.unsubs.push(bus.subscribe(subjects.emotes(tenant, board), m => {
        if (!m || !Number.isSafeInteger(m.window) || !m.counts || typeof m.counts !== "object") return;
        const sum = b.sums.get(m.window) ?? {};
        for (const e of EMOTES) if (Number.isSafeInteger(m.counts[e]) && m.counts[e] > 0) sum[e] = (sum[e] ?? 0) + m.counts[e];
        b.sums.set(m.window, sum);
      }));
      boards.set(key, b);
    }
    b.refs++; ws.data.b = b;
    await b.feed.ready;
    return b;
  }
  function leaveBoard(ws) {
    const c = ws.data, b = c.b;
    if (!b) return;
    c.b = null; b.conns.delete(ws);
    if (--b.refs > 0) return;
    boards.delete(b.key); b.feed.close(); for (const u of b.unsubs) u();
  }

  // ---- revocation: a board's `grants` subject, watched from before a hello's role check until its socket closes ----
  /** @type {Map<string, { gen: number, refs: number, unsub: () => void }>} "tenant/board" → its grants watch */
  const grantWatches = new Map();
  /**
   * Watch a board's `grants` for this connection. Every message bumps `gen` and re-checks the board's live
   * connections; a hello compares `gen` before its role check with `gen` just before it goes live, so a change
   * that lands while it waits (on the feed, on a room rebuild) is never lost, even for a board's first connection.
   */
  function watchGrants(c, tenant, board) {
    const key = `${tenant}/${board}`;
    let w = grantWatches.get(key);
    if (!w) {
      w = { gen: 0, refs: 0, unsub: () => {} };
      const self = w;
      w.unsub = bus.subscribe(subjects.grants(tenant, board), () => {
        self.gen++;
        const b = boards.get(key);
        if (b) recheck(b).catch(err => log.error("gateway: grants re-check failed", { board, err }));
      });
      grantWatches.set(key, w);
    }
    w.refs++; c.watch = { key, w };
    return w;
  }
  function unwatchGrants(c) {
    if (!c.watch) return;
    const { key, w } = c.watch; c.watch = null;
    if (--w.refs > 0) return;
    w.unsub(); if (grantWatches.get(key) === w) grantWatches.delete(key);
  }

  /** Grants, invites or links changed on this board (or the slow timer fired): every connection's role is computed again. */
  async function recheck(b) {
    for (const ws of [...b.conns]) {
      const c = ws.data;
      if (c.state !== "live") continue;
      let role;
      // Fail closed: a Registry that can't answer now can't vouch for the old role. `unavailable`, so the client
      // reconnects and its hello does the check (§ Errors: the client keeps its pending ops).
      try { role = await auth.role(c.identity, b.board); }
      catch (err) { if (c.state === "live") { log.warn("role re-check failed: connection closed", { conn: c.id, err }); refuse(ws, "unavailable", "could not re-check your access: reconnect", 1013, "role re-check failed"); } continue; }
      if (c.state !== "live") continue;
      if (!ROLES.includes(role)) { log.info("access removed: connection closed", { conn: c.id, board: b.board, user: c.user }); refuse(ws, "auth", "your access to this board was removed", 1008, "auth"); }
      else if (role !== c.role) { log.info("role changed: connection closed to rejoin", { conn: c.id, board: b.board, user: c.user, from: c.role, to: role }); refuse(ws, "unavailable", "your role on this board changed: reconnect", 1012, "role changed"); }
    }
  }

  /** Send the welcome, then the catch-up up to at least `upTo`; live entries follow from where it ends. */
  function welcomed(ws, welcomeData, upTo) {
    const c = ws.data;
    // `welcomed` turns on only as the welcome frame is queued, so no presence, emote or op answer can reach the
    // socket before it; `welcoming` stops a second welcome being taken meanwhile.
    c.welcoming = true; c.answered = true; clearTimeout(c.timer);
    const b = c.b, since = c.since;
    b.feed.reach(upTo).then(() => b.feed.atomically(() => {
      if (c.state !== "live") return;
      push(ws, typeof welcomeData === "function" ? welcomeData() : welcomeData);
      c.welcomed = true;
      for (const f of b.feed.catchUp(since)) pushShared(ws, f);
      c.next = b.feed.seq + 1;
    })).catch(err => { log.error("catch-up failed", { conn: c.id, err }); if (c.state === "live") refuse(ws, "unavailable", "try again shortly", 1013, "unavailable"); });
  }

  // Presence out: every 50 ms, each board's coalesced batch to its welcomed connections, without their own.
  const presenceTimer = setInterval(() => {
    try {
      for (const b of boards.values()) {
        if (!b.coalescer.size) continue;
        const batch = b.coalescer.flush(), full = codec.encode({ t: "presence", batch });
        for (const ws of welcomedOn(b)) {
          const c = ws.data;
          if (c.outBytes > lim.maxConnQueuedBytes / 2) continue;   // presence may drop: a reader this far behind skips it
          const mine = x => x.user === c.user && x.client === c.client;
          if (!batch.some(mine)) { push(ws, full); continue; }
          const rest = batch.filter(x => !mine(x));
          if (rest.length) push(ws, codec.encode({ t: "presence", batch: rest }));
        }
      }
    } catch (err) { log.error("gateway: presence flush failed", { err }); }
  }, lim.presenceMs);
  presenceTimer.unref?.();

  // Emotes: viewers' counts per 500 ms window are published on `.emotes`; every gateway sums all gateways' counts
  // for a window and sends the total once the window is a full window old (late counts from other gateways land).
  const emoteTimer = setInterval(() => {
    try {
      const w = Math.floor(now() / lim.emoteWindowMs);
      for (const b of boards.values()) {
        for (const [win, counts] of Object.entries(b.mine)) {
          if (Number(win) >= w) continue;
          delete b.mine[win];
          bus.publish(subjects.emotes(b.tenant, b.board), { gateway: id, window: Number(win), counts })?.catch?.(() => {});
        }
        for (const [win, counts] of b.sums) {
          if (win > w - 2) continue;
          b.sums.delete(win);
          const data = codec.encode({ t: "emotes", counts });
          for (const ws of welcomedOn(b)) push(ws, data);
        }
      }
    } catch (err) { log.error("gateway: emote tick failed", { err }); }
  }, lim.emoteWindowMs);
  emoteTimer.unref?.();

  // Rule 6: every 5 s, each board's open writer connections, so a room drops the ones whose close notice was lost.
  const listTimer = setInterval(() => {
    for (const b of boards.values()) {
      const list = [...b.conns].filter(ws => ws.data.state === "live" && ws.data.forwarded).map(ws => ws.data.id);
      if (list.length) bus.publish(subjects.inbox(b.tenant, b.board), { gateway: id, conns: list })?.catch?.(() => {});
    }
  }, lim.connListMs);
  listTimer.unref?.();
  // Time-based loss of access (a share link or an invite passing its `expiresAt`) sends no `grants` message.
  const roleTimer = setInterval(() => { for (const b of boards.values()) recheck(b).catch(err => log.error("gateway: timed role re-check failed", { board: b.board, err })); }, lim.roleRecheckMs);
  roleTimer.unref?.();

  async function hello(ws, msg) {
    const c = ws.data;
    if (msg.v !== PROTOCOL_VERSION) return badFrame(ws, "hello-version", `this server speaks protocol v${PROTOCOL_VERSION}`, "version");
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
    // A token past its expiry is refused now; a live connection is closed when it passes (below).
    if (Number.isFinite(identity.exp) && identity.exp * 1000 <= now()) return deny("expired");
    // The board id is only a lookup key here; subjects and store keys are built from the registry's own record.
    if (!isId(msg.board)) return deny("board");
    try { board = await registry.board(msg.board); } catch (err) { return down("board", err); }
    if (c.state !== "auth") return;
    if (!board || board.id !== msg.board || !isId(board.id) || !isId(board.tenant)) return deny("board");
    const watch = watchGrants(c, board.tenant, board.id);   // before the role check (released when the socket closes)
    let gen = watch.gen;
    try { role = await auth.role(identity, board.id); } catch (err) { return down("role", err); }
    if (c.state !== "auth") return;
    if (!ROLES.includes(role)) return deny("role");
    const writer = role !== "viewer", wkey = `${identity.user}|${board.id}`;
    // My choice (no spec cap across boards): one account can't hold every socket of the process. Configurable.
    if ((connsByUser.get(identity.user) ?? 0) >= lim.maxConnsPerUser) { log.warn("hello refused: too many connections for one user", { conn: c.id, user: identity.user }); return refuse(ws, "unavailable", "too many connections for this user", 1013, "user connection cap"); }
    // § Pacing: at most 8 writer connections per (user, board) on this gateway; a ninth gets `limit` (no id), closed.
    const tooMany = () => writer && (writersBy.get(wkey) ?? 0) >= lim.maxWritersPerUserBoard;
    if (tooMany()) { log.warn("hello refused: writer connection cap", { conn: c.id, user: identity.user, board: board.id }); return refuse(ws, "limit", `at most ${lim.maxWritersPerUserBoard} open writer connections per user on a board`, 1008, "writer cap"); }
    // Subscribe to the board before anything is forwarded or served (§ Bus), then make sure its room runs (writers only:
    // rule 8, viewers never reach the room).
    try { await joinBoard(ws, board.tenant, board.id); } catch (err) { return down("feed", err); }
    if (c.state !== "auth") return;
    if (writer) { try { await rooms.open(board.tenant, board.id); } catch (err) { return down("room", err); } }
    if (c.state !== "auth") return;
    // Grants changed while this hello waited: ask again. A different role (writer ↔ viewer changes the path above)
    // is told to reconnect; no role is refused. Nothing is awaited between the last check and going live below.
    while (watch.gen !== gen) {
      gen = watch.gen;
      let again;
      try { again = await auth.role(identity, board.id); } catch (err) { return down("role", err); }
      if (c.state !== "auth") return;
      if (!ROLES.includes(again)) return deny("role");
      if (again !== role) { log.info("hello: role changed while it waited", { conn: c.id, from: role, to: again }); return refuse(ws, "unavailable", "your role on this board changed: reconnect", 1012, "role changed"); }
    }
    if (c.b?.feed.gapAt) { log.error("hello refused: the board's log has a gap", { conn: c.id, board: board.id, at: c.b.feed.gapAt }); return refuse(ws, "unavailable", "this board can't be served right now", 1013, "log gap"); }
    // The caps again, in the same step that counts this connection: hellos that waited together all passed the first check.
    if ((connsByUser.get(identity.user) ?? 0) >= lim.maxConnsPerUser) { log.warn("hello refused: too many connections for one user", { conn: c.id, user: identity.user }); return refuse(ws, "unavailable", "too many connections for this user", 1013, "user connection cap"); }
    if (tooMany()) { log.warn("hello refused: writer connection cap", { conn: c.id, user: identity.user, board: board.id }); return refuse(ws, "limit", `at most ${lim.maxWritersPerUserBoard} open writer connections per user on a board`, 1008, "writer cap"); }

    Object.assign(c, { state: "live", tenant: board.tenant, board: board.id, user: identity.user, identity, name: typeof identity.name === "string" ? identity.name.slice(0, 200) : null, role, client: msg.client,
      since: msg.since ?? 0, welcomed: false, next: undefined, wkey: writer ? wkey : null,
      out: [], outBytes: 0, buffered: 0, owed: 0, blocked: false, flushing: false, waitSince: 0, progressAt: now(), winStart: now(), winDrained: 0,
      opq: [], opqBytes: 0, tokens: lim.opBurst, tokenAt: now(), opTimer: null, limiter: presenceLimiter(now) });
    c.b.conns.add(ws);
    bump(connsByUser, c.user, 1);
    if (writer) bump(writersBy, wkey, 1);
    counts.accepted++;
    if (Number.isFinite(identity.exp)) {
      // setTimeout can't wait past 2^31-1 ms (24.8 days): a later expiry re-arms when that fires.
      const arm = () => {
        const wait = expiryWait(identity.exp, now());
        if (wait > 0) { c.expTimer = setTimeout(() => { if (c.state === "live") arm(); }, wait); c.expTimer.unref?.(); return; }
        if (c.state === "live") { log.info("token expired: connection closed", { conn: c.id }); refuse(ws, "auth", "your sign-in expired", 1008, "auth"); }
      };
      arm();
    }
    log.info("hello accepted", { conn: c.id, tenant: c.tenant, board: c.board, user: c.user, role });
    if (!writer) {
      // Rule 8: a viewer's hello never leaves the gateway. Its welcome carries the feed's seq and latest known epoch.
      return welcomed(ws, () => codec.encode({ t: "welcome", seq: c.b.feed.seq, role, user: c.user, horizon: 0, rv: RULES_VERSION, room: { board: c.board, epoch: c.b.feed.epoch } }), 0);
    }
    // The hello timer keeps running until the room's welcome arrives (the bus may drop a hello).
    c.forwarded = true;
    forward(ws, { t: "hello", v: PROTOCOL_VERSION, board: board.id, client: msg.client });   // no token past this line
  }

  // § Bus: gateway → room as { n, conn, gateway, user, name, role, client, msg }, numbered per connection (rule 6).
  // The size is checked BEFORE a number is used, so a message the bus can't carry never makes a gap.
  function forward(ws, msg) {
    const c = ws.data;
    const env = { n: c.n + 1, conn: c.id, gateway: id, user: c.user, name: c.name, role: c.role, client: c.client, msg };
    if (busBytes(env) > maxBusBytes) return false;
    c.n++;
    bus.publish(subjects.inbox(c.tenant, c.board), env)?.catch?.(err => log.error("inbox publish refused", { conn: c.id, err }));
    return true;
  }

  /** § Pacing: the gateway's own bucket per connection (20/s, burst 100). Over-rate ops wait in order; never refused. */
  function pumpOps(ws) {
    const c = ws.data;
    if (c.state !== "live") return;
    const t = now();
    c.tokens = Math.min(lim.opBurst, c.tokens + Math.max(0, t - c.tokenAt) * lim.opRate / 1000); c.tokenAt = t;
    while (c.opq.length && c.tokens >= 1) {
      const { msg, size } = c.opq.shift();
      c.opqBytes -= size; c.tokens -= 1;
      // § Limits: an op the bus can't carry is answered `too-large` with its id, never left unanswered.
      if (!forward(ws, msg)) push(ws, codec.encode({ t: "error", id: msg.id, code: "too-large", message: "that op is too large to forward" }));
    }
    if (c.opq.length && !c.opTimer) {
      c.opTimer = setTimeout(() => { c.opTimer = null; pumpOps(ws); }, Math.max(1, Math.ceil((1 - c.tokens) * 1000 / lim.opRate)));
    }
  }

  function op(ws, msg, size) {
    const c = ws.data;
    const id_ = typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {};
    const answer = (code, message) => push(ws, codec.encode({ t: "error", ...id_, code, message }));
    // Rule 11: before `welcome`, ops get `auth`.
    if (!c.welcomed) return answer("auth", "wait for welcome");
    // Rule 8: viewers write nothing durable and never reach the room. Answered in the room's order of checks
    // (§ Limits): shape, then id, then role.
    if (c.role === "viewer") {
      const why = opProblem(msg);
      if (why) return answer(why.code, why.message);
      if (parseOpId(msg.id)?.client !== c.client) return answer("bad-op", "op ids start with your client id");
      return answer("forbidden", "viewers can't write");
    }
    // v0's `transient: true` was removed in v1 (previews are presence). Refused rather than stripped: stripped, a
    // preview would be logged as a durable op. No strike: an old client sends many while dragging.
    if (msg.transient !== undefined) return answer("bad-op", "transient ops were removed in protocol v1");
    // § Pacing, queue cap: 500 ops or 8 MB; past it `unavailable` and close (the client keeps its ops and resends).
    if (c.opq.length >= lim.maxOpQueue || c.opqBytes + size > lim.maxOpQueueBytes) { log.warn("op queue full", { conn: c.id, ops: c.opq.length }); return refuse(ws, "unavailable", "too many ops queued: slow down and reconnect", 1013, "op queue full"); }
    // Only the fields an op has travel on.
    c.opq.push({ msg: { t: "op", id: msg.id, sentAt: msg.sentAt, stream: msg.stream, op: msg.op }, size }); c.opqBytes += size;
    pumpOps(ws);
  }

  /** Presence (§ Presence): checked, rate-limited, relayed over the bus; it never touches the room or the log. */
  function presence(ws, msg) {
    const c = ws.data;
    if (!c.welcomed) return;                                       // rule 11: dropped before welcome
    if (presenceProblem(msg, c.role) || !c.limiter.allow(msg.k)) return;   // bad or over the rate: dropped, no error
    if (msg.k === "emote" && c.role === "viewer") {                // viewers' emotes only as summed counts
      const w = Math.floor(now() / lim.emoteWindowMs), counts = c.b.mine[w] ?? (c.b.mine[w] = {});
      counts[msg.e] = (counts[msg.e] ?? 0) + 1;
      return;
    }
    const pick = { cursor: ["x", "y"], select: ["stream", "ids"], laser: ["pts"], preview: ["stream", "elements"], emote: ["e"] }[msg.k];
    const clean = { k: msg.k }; for (const f of pick) clean[f] = msg[f];
    bus.publish(subjects.presence(c.tenant, c.board), { gateway: id, user: c.user, client: c.client, msg: clean })?.catch?.(() => {});
  }

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
    if (msg.t === "op") return op(ws, msg, data.length);
    if (msg.t === "presence") return presence(ws, msg);
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
      // § Pacing: a connection heard from not at all (no frame, no pong) for 30 s is closed; Bun pings idle ones.
      idleTimeout: lim.idleTimeoutSec,
      sendPings: true,
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
          // What waits to be read is bounded in bytes in every state, so one socket can't pin gigabytes: before
          // welcome behind a slow port (small cap), and once live behind the frame pump (§ Pacing's 8 MB).
          const cap = c.state === "live" ? lim.maxLiveQueuedBytes : lim.maxQueuedBytes;
          if (c.qBytes + size + lim.frameOverheadBytes > cap) { log.warn("frame queue overflow", { conn: c.id, state: c.state }); return refuse(ws, "unavailable", "too much sent at once", 1013, "queue overflow"); }
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
      return { conns: conns.size, ...counts, owedBytes: owed, owedTracked: owedTotal, queuedBytes: queuedTotal, users: connsByUser.size, waitingJoiners: waiters.size, sharedBytes, sharedTexts: sharedText.size, boards: boards.size };
    },
    /** A board's feed as this gateway holds it (null if it serves no one there): its base checkpoint, seq and tail. */
    feed: (tenant, board) => { const f = boards.get(`${tenant}/${board}`)?.feed; return f ? { base: f.base.seq, seq: f.seq, tail: f.tail.length, tailBytes: f.tailBytes } : null; },
    /** Re-check every connection's role on a board now (what a `grants` message does). */
    recheck: async board => { for (const b of boards.values()) if (b.board === board) await recheck(b); },
    async close() {
      clearInterval(sweep); clearInterval(presenceTimer); clearInterval(emoteTimer); clearInterval(listTimer); clearInterval(roleTimer); unsub();
      for (const ws of [...conns.values()]) end(ws, 1001, "server closing");
    },
  };
}
