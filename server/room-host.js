// The room host: runs one packages/protocol Room (v1.1) per open board and joins it to the Store and the Bus.
// Core code: it depends on the Store and Bus ports only (main.js picks the adapters).
//
// What it does around the Room (PROTOCOL.md § Recovery, § Bus, rule 6):
//   - The lease (p4-host; one path for a single node and a cluster): a room is built only under the board's Store
//     lease. `acquire` (holder = this host instance) gives the epoch; renewing starts at once, before the rebuild,
//     every ttl/3. Only the holder subscribes to the board's inbox (p-audit F5). Losing the lease (renew null, a
//     `fenced` write, or no successful renew by the host deadline) stops the room without `release`. A clean
//     close() checkpoints, settles the writes, then releases, so a restart takes the board at once.
//   - Held by another host: open() resolves with no local room (the holder serves the inbox over the bus). This
//     host watches the board: one takeover attempt armed for after the lease could have expired (it asks the
//     Store; it never compares the Store's clock with its own), and, while the holder is silent (no `.entries`
//     message for 2 heartbeats), it answers inbox hellos with `unavailable` so a writer isn't left waiting.
//   - Build: then the latest checkpoint that matches the log (stepping back past a bad one) and the log after it,
//     into Room.rebuild. A failed room is thrown away and the next open builds a new one (a new lease epoch).
//   - Log adapter: { append(entries, expectSeq), putCheckpoint(cp) } over the Store, both fenced with the lease
//     epoch. The Room holds every ack, refusal and dedupe wait until the append resolves (group commit: one append
//     in flight). When an append resolves, its entries are published on `.entries` (split under the bus cap)
//     before the Room acks them.
//   - Append timeout (4 s): the append's promise rejects, and the Room fails itself (nothing unresolved is acked).
//   - Only `welcome`, `ack` and `error` go back to a gateway (`.gw.<gateway>`). The Room's own catch-up and live
//     broadcasts are not sent: gateways serve catch-up from the Store and fan out from `.entries` (rules 3, 8).
//   - Every `unavailable` the Room says ends that connection (a gap, an unknown connection, a stopped room): the
//     gateway is told to close it, and the client reconnects and is welcomed afresh.
//   - Timers: room.sweep() (gateway silence, by the room's clock), the `{ seq, epoch }` heartbeat every 2 s, and
//     the lease's renew and deadline (by performance.now(), never the rooms' injected clock).

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

/** The longest lease ttl the Store takes (§ Store: a positive integer up to 10 min). */
const MAX_TTL_MS = 10 * 60_000;

/**
 * A holder id for one room-host instance: `<host>-<pid>-<random>`. Unique per instance (two in one process differ by
 * the random part), and an id the Store accepts ([a-z0-9-], at most 64 chars), so ":" can't be the separator.
 * @param {string} [hostname]
 */
export function newHolder(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "host";
  const pid = Number.isSafeInteger(globalThis.process?.pid) ? globalThis.process.pid : 0;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");
  return `${host}-${pid}-${rand}`;
}

/**
 * @param {{ store: object, bus: object, log?: object, codec?: object, now?: () => number, appendTimeoutMs?: number,
 *   sweepMs?: number, heartbeatMs?: number, pageSize?: number, pageBytes?: number, rules?: object, maxBusBytes?: number,
 *   holder?: string, hostname?: string, leaseTtlMs?: number, watchIdleMs?: number, monotonic?: () => number }} o
 *   now: the rooms' clock (entries' `at`, the 30 s gateway silence). rules: per rules version { W, H, every } (tests).
 *   holder: this instance's lease holder id (tests); default newHolder(hostname). leaseTtlMs: the Store lease's ttl
 *   (default 10 s), renewed every ttl/3. watchIdleMs: a board held elsewhere is watched (for a takeover) while some
 *   open() or inbox message for it came in this long (default 60 s). monotonic: the lease's clock (default
 *   performance.now(); tests move it to fake a stall). Never the rooms' `now`.
 */
export function roomHost({ store, bus, log = quietLogger, codec = jsonCodec, now = Date.now, appendTimeoutMs = 4_000, sweepMs = 1_000,
  heartbeatMs = 2_000, pageSize = 1_000, pageBytes = 4 * 1024 * 1024, rules, maxBusBytes = bus.maxBytes ?? MAX_BUS_BYTES, tailFoldBytes = 8 * 1024 * 1024,
  holder, hostname = globalThis.process?.env?.HOSTNAME, leaseTtlMs = 10_000, watchIdleMs = 60_000, monotonic = performance.now.bind(performance) }) {
  // tailFoldBytes: besides the Room's own rule (every 1,000 entries, once the log since the last checkpoint is half
  //   its size), the host checkpoints once that log reaches this many chars AND half the state's size, so a board
  //   rewritten in a few huge ops still gets a bounded catch-up, and a rewrite never costs more than 2× the log.
  //   (An extension of § Recovery "When": a byte trigger, asked for since the scaffold; see the p2-swap report.)
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 3 || leaseTtlMs > MAX_TTL_MS) throw new RangeError(`leaseTtlMs must be an integer from 3 to ${MAX_TTL_MS}`);
  const perf = monotonic;   // the lease's clock: elapsed time on this host only (tests fake a stall with it)
  const me = holder ?? newHolder(hostname);
  const renewEvery = Math.floor(leaseTtlMs / 3);
  const renewTimeout = Math.max(1, Math.floor(renewEvery / 2)), renewRetry = Math.max(1, Math.floor(renewEvery / 4));
  // A takeover attempt waits a whole ttl (plus a little) after it read the lease: the lease can't outlive that unless
  // it was renewed, and this host never compares the Store's clock (`expiresAt`) with its own.
  // A takeover attempt is armed for the Store's own `remainingMs` on the lease (+ a small margin): this host never
  // compares the Store's clock (`expiresAt`) with its own. While it still loses, it tries again every ttl/3.
  const margin = Math.max(20, Math.floor(leaseTtlMs / 50));
  const silentAfter = 2 * heartbeatMs;
  /** @type {Map<string, Promise<object>>} key "tenant/board" → the slot, once built */
  const slots = new Map();
  /** key → an acquire (and the build it starts) under way, shared by concurrent opens and a takeover attempt */
  const claims = new Map();
  /** key → the latest slot whose lease this host acquired (close() releases them) */
  const held = new Map();
  /** key → a board held by another host, watched for a takeover */
  /** The host deadline has passed: this slot can't know it still holds the lease (HIGH-1). By performance.now(). */
  const expired = slot => perf() >= slot.okAt + leaseTtlMs - renewEvery;
  const watches = new Map();
  let closed = false;
  const closedError = () => new PortError("closed", "the room host is closed");

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

  /** The Room's log: the Store, bound to one board and fenced with this slot's lease epoch (every write, L5). */
  function logOf(slot) {
    const { tenant, board } = slot;
    const fenced = (what, err) => { if (err?.code === "fenced") lost(slot, `${what} fenced: another host took the board`, err); };
    return {
      append(entries, expectSeq) {
        const w = Promise.resolve().then(() => store.append(tenant, board, entries, expectSeq, slot.epoch));
        slot.writes.add(w); w.finally(() => slot.writes.delete(w)).catch(() => {});   // close() settles it before release (L4)
        return withTimeout(w).then(() => {
          // Durable, but past the host deadline nothing is acked or broadcast from here (HIGH-1): the room stops, the
          // entries stay unacked, and the client's resend is deduplicated by the next holder.
          if (slot.leaseLost) return;
          if (expired(slot)) return lost(slot, "the host deadline passed before an append's result");
          slot.durable = entries[entries.length - 1].seq; publishEntries(slot, entries);
          setTimeout(() => foldIfDue(slot), 0);   // after the Room has moved these entries to resolved
        }, err => { fenced("append", err); throw err; });
      },
      putCheckpoint(cp) {
        const p = store.putCheckpoint(tenant, board, cp, slot.epoch);
        slot.writes.add(p); p.finally(() => slot.writes.delete(p)).catch(() => {});
        p.catch(err => fenced("checkpoint", err));
        return p;
      },
    };
  }

  /** The byte trigger (tailFoldBytes, above). Only when nothing is unresolved, so the fold is of resolved state. */
  function foldIfDue(slot) {
    if (slot.dead) return;
    const st = slot.room.status();
    if (st.stopped || st.inflight || st.queued || st.seq !== st.resolved) return;
    if (st.tailChars < tailFoldBytes || st.tailChars * 2 < st.stateChars) return;
    try { slot.room.checkpoint(); } catch (err) { log.error("checkpoint failed", { board: slot.board, err }); }
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

  // ---- the lease ----

  /** Renew every ttl/3 from now; the host deadline runs from `sentAt` (the acquire's send time). */
  function startLease(slot, sentAt) {
    slot.okAt = sentAt;
    armDeadline(slot);
    slot.renewTimer = setInterval(() => renewTick(slot), renewEvery);
    slot.renewTimer.unref?.();
  }
  /**
   * The host deadline: the send time of the last successful renew (or the acquire) + ttl − one renew interval, by
   * performance.now(). The Store stamped that lease no earlier than it was sent, so the room stops at least one
   * interval before the lease can lapse there. A success re-arms it; firing means none came in time.
   */
  function armDeadline(slot) {
    clearTimeout(slot.deadlineTimer);
    slot.deadlineTimer = setTimeout(() => lost(slot, "no lease renew succeeded by the host deadline"), Math.max(0, slot.okAt + leaseTtlMs - renewEvery - perf()));
    slot.deadlineTimer.unref?.();
  }
  function stopLease(slot) { clearInterval(slot.renewTimer); clearTimeout(slot.deadlineTimer); clearTimeout(slot.retryTimer); }
  /**
   * One renew at a time, each bounded by half a renew interval (MEDIUM-3); a timed-out renew's late result is ignored
   * (it never moves `okAt`). An error or a timeout is retried a quarter interval later, not at the next tick: the
   * deadline is only 2 intervals after the last good send, so a renew that hung for a whole interval would leave no
   * retry before it. Past the deadline nothing is sent, and a result that comes back after it doesn't revive the
   * slot (L3): it stays lost.
   */
  function renewTick(slot) {
    if (slot.dead || slot.renewing) return;
    if (expired(slot)) return lost(slot, "no lease renew succeeded by the host deadline");
    slot.renewing = true;
    const sent = perf();
    let p, timer;
    try { p = Promise.resolve(store.renew(slot.tenant, slot.board, me, slot.epoch, leaseTtlMs)); } catch (err) { p = Promise.reject(err); }
    const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new PortError("timeout", "the lease renew did not answer in time")), renewTimeout); timer.unref?.(); });
    Promise.race([p, late]).then(l => {
      if (slot.dead) return;
      if (expired(slot)) return lost(slot, "no lease renew succeeded by the host deadline");
      if (!l) return lost(slot, "lease renew refused: the lease is gone");
      if (sent > slot.okAt) { slot.okAt = sent; armDeadline(slot); }
    }, err => {
      if (slot.dead) return;
      log.warn("lease renew failed; retrying", { tenant: slot.tenant, board: slot.board, epoch: slot.epoch, err });
      slot.retry = true;
    }).finally(() => {
      clearTimeout(timer); slot.renewing = false;
      if (!slot.retry || slot.dead) return;
      slot.retry = false;
      clearTimeout(slot.retryTimer);
      slot.retryTimer = setTimeout(() => renewTick(slot), renewRetry);
      slot.retryTimer.unref?.();
    });
  }
  /** The lease is gone (or may be): stop the room. Never `release` (someone else may hold the board now). */
  function lost(slot, why, err) {
    if (slot.dead) return;
    slot.leaseLost = true;
    log.error("room stopped: lease lost", { tenant: slot.tenant, board: slot.board, epoch: slot.epoch, why, err });
    fail(slot);
  }

  /**
   * Take the board's lease and build its room (resolves to the slot), or `{ held: lease }` if another host holds it
   * live. A lease that reads free right after a refused acquire was a race: try again (a few times; then the watch's
   * attempt does).
   */
  async function claim(tenant, board, key) {
    for (let tries = 0; tries < 3; tries++) {
      const sent = perf();
      const l = await store.acquire(tenant, board, me, leaseTtlMs);
      if (closed) {
        if (l) await Promise.resolve(store.release(tenant, board, me, l.epoch)).catch(() => {});
        throw closedError();
      }
      if (l) return start(tenant, board, key, l, sent);
      const info = await store.lease(tenant, board);
      if (closed) throw closedError();
      if (info?.live) return { held: info };
    }
    return { held: null };
  }
  function claimOnce(tenant, board, key) {
    let c = claims.get(key);
    if (!c) {
      c = claim(tenant, board, key).finally(() => { if (claims.get(key) === c) claims.delete(key); });
      claims.set(key, c);
    }
    return c;
  }

  /** The lease is ours: renew at once (a long rebuild may outlast the ttl), then build. */
  function start(tenant, board, key, lease, sentAt) {
    const slot = { key, tenant, board, room: null, epoch: lease.epoch, dead: false, leaseLost: false, unsub: () => {}, conns: new Map(),
      writes: new Set(), durable: 0, okAt: 0, renewTimer: null, deadlineTimer: null, renewing: false, promise: null, welcomed: new Set() };
    startLease(slot, sentAt);
    held.set(key, slot);
    const p = build(slot).catch(err => {
      stopLease(slot); unwatch(key, true);
      // L5: a build that failed for a reason other than the lease gives the board back at once, so another host
      // (or this one's next open) needn't wait out the ttl. A lost lease is never released.
      if (!slot.leaseLost) Promise.resolve().then(() => store.release(tenant, board, me, slot.epoch)).catch(e => log.warn("lease release after a failed build failed", { tenant, board, err: e }));
      throw err;
    });
    slot.promise = p;
    slots.set(key, p);
    p.catch(err => { if (slots.get(key) === p) slots.delete(key); log.error("room failed to open", { tenant, board, err }); });
    return p;
  }

  async function build(slot) {
    const { tenant, board } = slot;
    const report = (what, detail) => {
      if (what === "stopped") { log.error("room stopped", { tenant, board, seq: detail?.seq, err: detail?.err }); fail(slot); }
      else log.error(`room: ${what}`, { tenant, board, ...detail });
    };
    // § Recovery, Room identity: the epoch is the lease's (acquire bumps it durably), so two builds never share one.
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
    if (closed) throw closedError();
    if (slot.dead) throw new PortError("unavailable", "the board's lease was lost while its room was being built");
    slot.durable = slot.room.status().resolved;
    // Gateways (and any host watching this board) learn the new epoch now, before the inbox is served. `opened`: a
    // watcher answers the hellos it held, which this room never saw (MEDIUM-2).
    bus.publish(subjects.entries(tenant, board), { ...slot.room.heartbeat(), opened: true })?.catch?.(() => {});
    unwatch(slot.key, true);
    // Holder-only inbox (p-audit F5): only the lease holder's room hears the board's gateways.
    slot.unsub = bus.subscribe(subjects.inbox(tenant, board), m => {
      try { onInbox(slot, m); } catch (err) { log.error("room host: inbox handler failed", { tenant, board, err }); }
    });
    log.info("room opened", { tenant, board, seq: slot.durable, epoch: slot.epoch, holder: me });
    return slot;
  }

  // ---- a board held by another host ----

  /**
   * Watch a board another host holds (`lease`: what the Store said). Its `.entries` tell this host the holder is alive,
   * that a new one opened, or that it released; its inbox brings hellos, answered only while the holder is silent.
   */
  function watch(tenant, board, key, lease) {
    if (closed || watches.has(key)) return;
    const t = perf();
    const w = { key, tenant, board, heardAt: t, wanted: t, epoch: null, timer: null, silence: null, attempting: false, pending: [],
      unsubEntries: () => {}, unsubInbox: () => {} };
    watches.set(key, w);
    w.unsubEntries = bus.subscribe(subjects.entries(tenant, board), m => {
      try { watchEntries(w, m); } catch (err) { log.error("room host: watch handler failed", { tenant, board, err }); }
    });
    w.unsubInbox = bus.subscribe(subjects.inbox(tenant, board), m => {
      try { watchInbox(w, m); } catch (err) { log.error("room host: watch handler failed", { tenant, board, err }); }
    });
    log.info("board held by another host: watching it", { tenant, board });
    armSilence(w);
    arm(w, lease?.live ? lease.remainingMs + margin : 0);
  }
  /** Stop watching. `answer`: tell the hellos held here `unavailable` (nobody else will answer them). */
  function unwatch(key, answer = false) {
    const w = watches.get(key);
    if (!w) return;
    watches.delete(key); clearTimeout(w.timer); clearTimeout(w.silence); w.unsubEntries(); w.unsubInbox();
    if (answer) answerHeld(w);
  }
  function answerHeld(w) { for (const h of w.pending.splice(0)) reply(h.gateway, h.conn, UNAVAILABLE, 1013); }
  /**
   * The holder's `.entries`: it is alive. A heartbeat from a holder that just opened (`opened`, or an epoch above the
   * last one heard) means the hellos held here reached nobody (its room subscribed after them): answer them
   * `unavailable` so the clients retry (MEDIUM-2). Otherwise the holder answered them: drop them. A `released` one: the
   * holder let the board go; answer the held hellos and try to take it at once (L2).
   */
  function watchEntries(w, m) {
    w.heardAt = perf();
    const ep = Number.isSafeInteger(m?.epoch) ? m.epoch : null;
    const fresh = m?.opened === true || (ep !== null && w.epoch !== null && ep > w.epoch);
    if (ep !== null && (w.epoch === null || ep > w.epoch)) w.epoch = ep;
    if (m?.released === true) { answerHeld(w); clearTimeout(w.silence); attemptNow(w); return; }
    if (fresh) answerHeld(w); else w.pending.length = 0;
    armSilence(w);
  }
  /**
   * The dead-holder window: a writer's hello reaches an inbox nobody serves (the gateway would wait out its 10 s hello
   * timeout). This host answers `unavailable` (close 1013, the client retries) only once the holder is silent: no
   * `.entries` message for 2 heartbeats (every host runs the same heartbeatMs). A hello before that is held (up to
   * 1,000; past that it is answered at once, L7) until the silence, a new holder, or the holder's next heartbeat
   * (then it answered them, and they are dropped). A live holder's board is never answered here.
   */
  function watchInbox(w, m) {
    if (!m || typeof m.gateway !== "string") return;
    w.wanted = perf();   // some gateway has writers on this board: keep watching it
    if (typeof m.conn !== "string" || m.closed || m.msg?.t !== "hello") return;
    if (perf() - w.heardAt > silentAfter || w.pending.length >= 1_000) return reply(m.gateway, m.conn, UNAVAILABLE, 1013);
    w.pending.push({ gateway: m.gateway, conn: m.conn });
  }
  /** 2 heartbeats with nothing heard: the holder is silent. Answer the held hellos and try to take the board now. */
  function armSilence(w) {
    clearTimeout(w.silence);
    w.silence = setTimeout(() => {
      if (watches.get(w.key) !== w) return;
      if (perf() - w.heardAt <= silentAfter) return armSilence(w);
      answerHeld(w);
      attemptNow(w);
    }, Math.max(1, w.heardAt + silentAfter + 1 - perf()));
    w.silence.unref?.();
  }
  function arm(w, ms) {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => attemptNow(w), Math.max(0, ms));
    w.timer.unref?.();
  }
  function attemptNow(w) {
    if (w.attempting || closed || watches.get(w.key) !== w) return;
    clearTimeout(w.timer);
    w.attempting = true;
    attempt(w).catch(err => log.error("takeover attempt failed", { tenant: w.tenant, board: w.board, err })).finally(() => { w.attempting = false; });
  }
  /**
   * One takeover attempt: ask the Store whether the lease is still live; if not, acquire it and build the room. Still
   * held: try again at its remaining time (on the Store's clock) + a margin, and at least every ttl/3.
   */
  async function attempt(w) {
    const mine = () => !closed && watches.get(w.key) === w;
    if (!mine()) return;
    if (perf() - w.wanted > watchIdleMs) { unwatch(w.key, true); log.info("stopped watching an idle board", { tenant: w.tenant, board: w.board }); return; }
    const again = info => { if (mine()) arm(w, Math.min(renewEvery, info?.live ? info.remainingMs + margin : renewEvery)); };
    let info;
    try { info = await store.lease(w.tenant, w.board); }
    catch (err) { log.warn("lease read failed; trying again later", { tenant: w.tenant, board: w.board, err }); return again(null); }
    if (!mine()) return;
    if (info?.live && info.holder !== me) return again(info);
    let r;
    try { r = await claimOnce(w.tenant, w.board, w.key); }
    catch (err) { log.warn("takeover failed", { tenant: w.tenant, board: w.board, err }); return again(null); }
    if (r?.held !== undefined) again(r.held);
  }

  /** Throw the room away: its connections are told `unavailable` and closed; the next open builds a new one. No release. */
  function fail(slot) {
    if (slot.dead) return;
    slot.dead = true; slot.unsub(); stopLease(slot);
    if (slots.get(slot.key) === slot.promise) slots.delete(slot.key);
    try { slot.room?.fail(new PortError("stopped", "the room host stopped this room")); } catch { /* already stopped */ }
    // A lost lease tells only the connections this slot welcomed (HIGH-1): any other hello on the board is the new
    // holder's or a watcher's to answer.
    for (const [ck, c] of slot.conns) if (!slot.leaseLost || slot.welcomed.has(ck)) reply(c.gateway, c.id, UNAVAILABLE, 1013);
    slot.conns.clear();
  }

  /** A Room connection whose replies go to its gateway; only welcome/ack/error travel (catch-up is the gateway's). */
  function connect(slot, gateway, conn) {
    const ck = `${gateway}/${conn}`;
    const c = slot.room.connect(msg => {
      if (!msg || !REPLIES.has(msg.t)) return;
      // Past the host deadline this slot answers nothing (HIGH-1): it stops, and the new holder or a watcher answers.
      if (slot.leaseLost) return;
      if (expired(slot)) return lost(slot, "the host deadline passed before a reply");
      if (msg.t === "welcome") slot.welcomed.add(ck);
      const end = msg.t === "error" && msg.code === "unavailable";   // every unavailable ends the connection
      reply(gateway, conn, codec.encode(msg), end ? 1013 : undefined);
      if (end) { slot.conns.delete(ck); slot.welcomed.delete(ck); if (!c.closed) slot.room.disconnect(c); }
    }, { gateway, id: conn });
    slot.conns.set(ck, c);
    return c;
  }

  /** One inbox message (§ Bus): hello/op `{ n, conn, gateway, user, name, role, client, msg }`, a close notice, or a list. */
  function onInbox(slot, m) {
    if (!m || typeof m.gateway !== "string") return;
    // HIGH-1: a slot woken from a stall past its host deadline must not serve what queued meanwhile. It stops, and
    // drops the message unanswered: the new holder (or a watcher) answers it.
    if (slot.leaseLost) return;
    if (expired(slot)) return lost(slot, "the host deadline passed (a stall?) before an inbox message");
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
    const mark = () => { const st = room.status(); return st.seq + st.unresolvedCount; };
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
      if (slot.dead) return;
      if (expired(slot)) return lost(slot, "no lease renew succeeded by the host deadline");
      bus.publish(subjects.entries(slot.tenant, slot.board), slot.room.heartbeat())?.catch?.(() => {});
    }, () => {});
  }, heartbeatMs);
  beat.unref?.();

  return {
    /** This instance's lease holder id. */
    holder: me,
    /**
     * Make sure this board is served: its room running here under the board's Store lease (built from the Store and
     * listening on its inbox), or, when another host holds the lease live, resolves with no room here (that host
     * serves the inbox over the bus) and watches the board for a takeover.
     */
    async open(tenant, board) {
      if (closed) throw closedError();
      const key = `${tenant}/${board}`;
      const p = slots.get(key);
      if (p) { await p; return; }
      const w = watches.get(key);
      if (w) { w.wanted = perf(); return; }
      const r = await claimOnce(tenant, board, key);
      if (r?.held !== undefined) watch(tenant, board, key, r.held);
    },
    /** Resolves when the board's bus traffic is delivered and its room has nothing in flight (tests, shutdown). */
    async idle(tenant, board) {
      for (let i = 0; i < 10_000; i++) {
        await bus.flush();
        const slot = await slots.get(`${tenant}/${board}`)?.catch(() => null);
        const st = slot && !slot.dead ? slot.room.status() : null;
        if (!st || (!st.inflight && !st.queued && !st.held)) { await bus.flush(); return; }
        await new Promise(r => setTimeout(r, 1));
      }
    },
    /** The running room for a board, or null (tests and /health only). */
    async peek(tenant, board) {
      const slot = await slots.get(`${tenant}/${board}`)?.catch(() => null);
      return slot ? { room: slot.room, epoch: slot.epoch, durable: slot.durable, conns: slot.conns.size, tailBytes: slot.room.status().tailChars } : null;
    },
    /** rooms: built or being built here; waiting: boards held by another host and watched for a takeover. */
    stats: () => ({ rooms: slots.size, waiting: watches.size }),
    /**
     * Stop every room: a checkpoint of each (§ Recovery, "When": on a clean stop), then stop listening, settle the
     * writes, and only then release each lease this host still holds, so another host (or a restart) takes the
     * board at once instead of waiting out the ttl.
     */
    async close() {
      closed = true; clearInterval(sweep); clearInterval(beat);
      for (const key of [...watches.keys()]) unwatch(key);
      await Promise.all([...claims.values()].map(c => c.catch(() => null)));
      const all = await Promise.all([...slots.values()].map(p => p.catch(() => null)));
      for (const slot of all) {
        if (!slot || slot.dead) continue;
        slot.unsub();
        try { const st = slot.room.status(); if (st.resolved > st.baseSeq && !st.inflight && !st.queued) slot.room.checkpoint(); }
        catch (err) { log.error("checkpoint on stop failed", { board: slot.board, err }); }
        slot.dead = true;
        await Promise.allSettled([...slot.writes]);
      }
      for (const slot of held.values()) {
        stopLease(slot);
        if (slot.leaseLost) continue;
        try {
          await store.release(slot.tenant, slot.board, me, slot.epoch);
          // A host watching this board takes it at once (L2), not when it next asks the Store.
          bus.publish(subjects.entries(slot.tenant, slot.board), { seq: slot.durable, epoch: slot.epoch, released: true })?.catch?.(() => {});
        } catch (err) { log.warn("lease release failed; it lapses within its ttl", { tenant: slot.tenant, board: slot.board, err }); }
      }
      held.clear(); slots.clear();
    },
  };
}
