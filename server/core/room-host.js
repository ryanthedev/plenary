// @ts-check
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
//   - Stuck host (#65, PROTOCOL.md § Recovery): every other Store call (build reads, acquire, lease) is bounded by
//     `storeTimeoutMs`, and a progress watchdog stops a room whose waiting ops have not moved `seq` for `stuckMs`.
//     Stopping = stop renewing; the Store lease lapses and a waiting host takes it. No second arbiter.
//   - Only `welcome`, `ack` and `error` go back to a gateway (`.gw.<gateway>`). The Room's own catch-up and live
//     broadcasts are not sent: gateways serve catch-up from the Store and fan out from `.entries` (rules 3, 8).
//   - Every `unavailable` the Room says ends that connection (a gap, an unknown connection, a stopped room): the
//     gateway is told to close it, and the client reconnects and is welcomed afresh.
//   - Timers: room.sweep() (gateway silence, by the room's clock), the `{ seq, epoch, cp }` heartbeat every 2 s, and
//     the lease's renew and deadline (by performance.now(), never the rooms' injected clock).

import { Room } from "../../packages/protocol/room.js";
import { CHECKPOINT_BYTES, blobRefsOf } from "../../packages/protocol/envelope.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { subjects, MAX_BUS_BYTES, utf8Length } from "../ports/bus.js";
import { quietLogger } from "./log.js";
import { PortError } from "./ids.js";
import { breathe } from "./breather.js";
import { noopMetrics } from "../ports/metrics.js";

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
  const out = [], room = maxBytes - 96;   // the envelope: {"from":…,"to":…,"items":[…],"epoch":…}
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

/** Throws RangeError unless `ms` is a lease ttl the room host takes (an integer from 3 ms to 10 min). Returns it. */
export function checkLeaseTtl(ms) {
  if (!Number.isSafeInteger(ms) || ms < 3 || ms > MAX_TTL_MS) throw new RangeError(`leaseTtlMs must be an integer from 3 to ${MAX_TTL_MS}`);
  return ms;
}

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
 * @param {{ store: Pick<import("../ports/store.js").Store, "append"|"read"|"lastSeq"|"putCheckpoint"|"getCheckpoint"|"openEpoch"|"epoch"|"acquire"|"renew"|"release"|"lease">,
 *   bus: import("../ports/bus.js").Bus,
 *   log?: { debug?(msg: string, f?: object): void, info(msg: string, f?: object): void, warn(msg: string, f?: object): void, error(msg: string, f?: object): void },
 *   codec?: { encode(v: any): any, decode(v: any): any }, now?: () => number, appendTimeoutMs?: number,
 *   sweepMs?: number, heartbeatMs?: number, pageSize?: number, pageBytes?: number, rules?: Record<string, any>, maxBusBytes?: number,
 *   tailFoldBytes?: number, foldUnits?: number, schedule?: (fn: () => void) => void, checkpointTimeoutMs?: number,
 *   holder?: string, hostname?: string, leaseTtlMs?: number, watchIdleMs?: number, storeTimeoutMs?: number, stuckMs?: number, monotonic?: () => number, timers?: Record<string, any>,
 *   metrics?: import("../ports/metrics.js").Metrics }} o   metrics: plenary_boards_hosted, plenary_ops_total, plenary_lease_changes_total (PROTOCOL.md § Metrics; default records nothing)
 *   now: the rooms' clock (entries' `at`, the 30 s gateway silence). rules: per rules version { W, H, every } (tests).
 *   holder: this instance's lease holder id (tests); default newHolder(hostname). leaseTtlMs: the Store lease's ttl
 *   (default 10 s), renewed every ttl/3. watchIdleMs: a board held elsewhere is watched (for a takeover) while some
 *   open() or inbox message for it came in this long (default 60 s). monotonic: the lease's clock (default
 *   performance.now(); tests move it to fake a stall). Never the rooms' `now`. storeTimeoutMs: bound on a Store call of a
 *   build, acquire or lease read (default 10 s). stuckMs: a room with ops waiting whose resolved seq has not moved this
 *   long is stopped (default 2 x appendTimeoutMs; checked every heartbeatMs).
 *   timers: { setTimeout, clearTimeout, setInterval, clearInterval } this host's timers (default the globals).
 */
export function roomHost({ store, bus, log = quietLogger, codec = jsonCodec, now = Date.now, appendTimeoutMs = 4_000, sweepMs = 1_000,
  heartbeatMs = 2_000, pageSize = 1_000, pageBytes = 4 * 1024 * 1024, rules, maxBusBytes = bus.maxBytes ?? MAX_BUS_BYTES, tailFoldBytes = CHECKPOINT_BYTES, foldUnits, schedule, checkpointTimeoutMs = 30_000,
  holder, hostname = globalThis.process?.env?.HOSTNAME, leaseTtlMs = 10_000, watchIdleMs = 60_000, storeTimeoutMs = 10_000, stuckMs = 2 * appendTimeoutMs, monotonic = performance.now.bind(performance), timers = globalThis, metrics = noopMetrics }) {
  // tailFoldBytes: the Room's byte trigger for a checkpoint (§ Recovery, "When"): the log since the last one reaches this
  //   many chars and a quarter of the state's size (so a rewrite never costs more than ~4x the log). Default CHECKPOINT_BYTES.
  // foldUnits: work per step of an incremental checkpoint (fold.js; default FOLD_STEP_UNITS). Each step is its own
  //   `schedule(fn)` turn (default the injected timers' setImmediate, else the global; tests pass a queue they drain). checkpointTimeoutMs: a checkpoint write unanswered this long is failed (reported; the room's next fold may start), so a checkpoint never holds the loop for more than one step (§ Recovery, "Incremental fold").
  checkLeaseTtl(leaseTtlMs);
  for (const [k, v] of Object.entries({ storeTimeoutMs, stuckMs })) if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${k} must be a positive integer`);
  log.info("room host: stuck-host bounds", { stuckMs, appendTimeoutMs, storeTimeoutMs, leaseTtlMs });   // stuckMs defaults to 2 x appendTimeoutMs
  const sched = schedule ?? (fn => (timers.setImmediate ?? globalThis.setImmediate)(fn));   // the injected timers' turn, else the global one
  // Every timer of this host runs on `timers` (tests pass fake ones and advance them, with `monotonic` and the Store's
  // clock moved in step); the names shadow the globals for this whole function.
  const { setTimeout, clearTimeout, setInterval, clearInterval } = timers;
  const perf = monotonic;   // the lease's clock: elapsed time on this host only (tests fake a stall with it)
  const me = holder ?? newHolder(hostname);
  const renewEvery = Math.floor(leaseTtlMs / 3);
  const renewTimeout = Math.max(1, Math.floor(renewEvery / 2)), renewRetry = Math.max(1, Math.floor(renewEvery / 4));
  // A takeover attempt is armed for the Store's own `remainingMs` on the lease (+ a small margin): this host never
  // compares the Store's clock (`expiresAt`) with its own. While it still loses, it tries again every ttl/3.
  const margin = Math.max(20, Math.floor(leaseTtlMs / 50));
  const silentAfter = 2 * heartbeatMs;
  /** @type {Map<string, Promise<Record<string, any>>>} key "tenant/board" → the slot, once built */
  const slots = new Map();
  // PROTOCOL.md § Metrics. `metrics` records only; a failure inside it never reaches this code (the port never throws).
  metrics.gauge("plenary_boards_hosted", "Rooms this host holds or is building.", () => slots.size);
  const opsTotal = metrics.counter("plenary_ops_total", "Ops this host sequenced and made durable.");
  const leaseChanges = metrics.counter("plenary_lease_changes_total", "Board lease changes on this host, by event (acquired, lost, released).", ["event"], ["acquired", "lost", "released"].map(event => ({ event })));
  /** key → an acquire (and the build it starts) under way, shared by concurrent opens and a takeover attempt */
  const claims = new Map();
  /** key → the latest slot whose lease this host acquired (close() releases them) */
  const held = new Map();
  /** key → a board held by another host, watched for a takeover */
  /** A connection leaves the slot: out of `conns` and out of `welcomed` together (R2-L1: the set only grew). */
  const drop = (slot, ck) => { slot.conns.delete(ck); slot.welcomed.delete(ck); };
  /** The host deadline has passed: this slot can't know it still holds the lease (HIGH-1). By performance.now(). */
  const expired = slot => perf() >= slot.okAt + leaseTtlMs - renewEvery;
  const watches = new Map();
  /** key → perf() time until which this host does not claim the board: it just stopped it stuck (#65), and its own lease is still live. */
  const cooling = new Map();
  /** Slots whose room is built and alive: what the heartbeat tick walks. */
  const running = new Set();
  const coolOff = key => cooling.set(key, perf() + leaseTtlMs + margin);
  const isCooling = key => perf() < (cooling.get(key) ?? 0);
  /** Cooldowns that ended long ago belong to boards nobody reopened (their watch is idle-dropped by then): forget them. */
  const pruneCooling = () => { for (const [key, until] of cooling) if (perf() >= until + watchIdleMs) cooling.delete(key); };
  let closed = false;
  const closedError = () => new PortError("closed", "the room host is closed");

  const reply = (tenant, board, gateway, conn, data, close) => {
    try { bus.publish(subjects.gateway(tenant, board, gateway), { conn, ...(data !== undefined ? { data } : {}), ...(close ? { close } : {}) })?.catch?.(() => {}); }
    catch { /* a bad id: nobody to tell */ }
  };
  const UNAVAILABLE = codec.encode({ t: "error", code: "unavailable", message: "the board is restarting: reconnect" });

  /** Publish resolved entries on `.entries`, once, encoded once, split under the cap. Never throws. */
  function publishEntries(slot, entries) {
    try {
      const items = entries.map(e => codec.encode(e));
      for (const part of splitEntries(entries, items, maxBusBytes)) {
        const m = { ...part, epoch: slot.epoch };
        const p = bus.publish(subjects.entries(slot.tenant, slot.board), m);
        // Refused (over the cap, a bus outage): gateways repair from the Store (heartbeat gap, 5 s silence poll).
        p?.catch?.(err => log.error("entries publish refused; gateways repair from the Store", { tenant: slot.tenant, board: slot.board, from: m.from, to: m.to, err }));
      }
    } catch (err) { log.error("entries publish failed", { tenant: slot.tenant, board: slot.board, err }); }
  }

  function withTimeout(p, ms = appendTimeoutMs) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new PortError("timeout", "the store did not answer in time")), ms); });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  /** The Room's log: the Store, bound to one board and fenced with this slot's lease epoch (every write, L5). */
  function logOf(slot) {
    const { tenant, board } = slot;
    const fenced = (what, err) => { if (err?.code === "fenced") lost(slot, `${what} fenced: another host took the board`, err); };
    return {
      append(entries, expectSeq) {
        const w = withTimeout(Promise.resolve().then(() => store.append(tenant, board, entries, expectSeq, slot.epoch, { blobRefs: blobRefsOf(entries) })));   // the pictures the entries name become this board's references, in the same transaction (§ Blobs)
        // close() settles it before release (L4). The timed promise: a hung append settles at the timeout, so close() never waits forever.
        slot.writes.add(w); w.finally(() => slot.writes.delete(w)).catch(() => {});
        return w.then(() => {
          opsTotal.inc(entries.length);   // counted once the Store has them, before any early return below
          // Durable, but past the host deadline nothing is acked or broadcast from here (HIGH-1): the room stops, the
          // entries stay unacked, and the client's resend is deduplicated by the next holder.
          if (slot.leaseLost) return;
          if (expired(slot)) return lost(slot, "the host deadline passed before an append's result");
          slot.durable = entries[entries.length - 1].seq; publishEntries(slot, entries);
        }, err => { fenced("append", err); throw err; });
      },
      putCheckpoint(cp) {
        const p = store.putCheckpoint(tenant, board, cp, slot.epoch);
        p.catch(err => fenced("checkpoint", err));
        // A write that never answers must still settle, or the room's `writing` never drops (no later fold starts) and
        // close() waits on it forever: the room and the slot track the timed one.
        const timed = withTimeout(p, checkpointTimeoutMs);
        slot.writes.add(timed); timed.finally(() => slot.writes.delete(timed)).catch(() => {});
        return timed;
      },
    };
  }

  /** Read every entry from `from` to the log's end, in bounded pages. */
  async function readFrom(tenant, board, from) {
    const all = [];
    for (let next = from; ;) {
      const page = await withTimeout(store.read(tenant, board, next, pageSize, pageBytes), storeTimeoutMs);
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
  /**
   * The progress watchdog (#65): ops are waiting (an append in flight, queued or held) and the resolved seq has not
   * moved for `stuckMs` (monotonic). An idle room, or one whose appends land, is never stuck. The record resets
   * whenever nothing waits or the seq moved, so it is at most one heartbeat stale when work first arrives.
   */
  function stalled(slot) {
    const st = slot.room.status(), t = perf();
    if (st.inflight + st.queued + st.held === 0 || st.resolved !== slot.progress.seq) { slot.progress = { seq: st.resolved, at: t }; return false; }
    return t - slot.progress.at >= stuckMs;
  }
  /** The lease is gone (or may be): stop the room. Never `release` (someone else may hold the board now). */
  function lost(slot, why, err) {
    if (slot.dead) return;
    slot.leaseLost = true; leaseChanges.inc(1, { event: "lost" });
    log.error("room stopped: lease lost", { tenant: slot.tenant, board: slot.board, epoch: slot.epoch, why, err });
    fail(slot);
  }

  /**
   * Take the board's lease and build its room (resolves to the slot), or `{ held: lease }` if another host holds it
   * live. A lease that reads free right after a refused acquire was a race: try again (a few times; then the watch's
   * attempt does).
   */
  async function claim(tenant, board, key) {
    if (!isCooling(key)) cooling.delete(key);
    else {   // a stuck stop's cooldown: never re-acquire our own live lease (acquire would grant it, epoch + 1); watch it instead
      const info = await withTimeout(store.lease(tenant, board), storeTimeoutMs);
      if (closed) throw closedError();
      return { held: info };
    }
    for (let tries = 0; tries < 3; tries++) {
      const sent = perf();
      const l = await withTimeout(store.acquire(tenant, board, me, leaseTtlMs), storeTimeoutMs);
      if (closed) {
        if (l) await withTimeout(Promise.resolve().then(() => store.release(tenant, board, me, l.epoch)), storeTimeoutMs).catch(() => {});
        throw closedError();
      }
      if (l) return start(tenant, board, key, l, sent);
      const info = await withTimeout(store.lease(tenant, board), storeTimeoutMs);
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
      writes: new Set(), durable: 0, progress: { seq: 0, at: sentAt }, okAt: 0, renewTimer: null, deadlineTimer: null, renewing: false, promise: null, welcomed: new Set() };
    startLease(slot, sentAt); leaseChanges.inc(1, { event: "acquired" });
    held.set(key, slot);
    const p = build(slot).catch(err => {
      stopLease(slot); unwatch(key, true);
      if (err?.code === "timeout") coolOff(key);
      // L5: a build that failed for a reason other than the lease gives the board back at once, so another host
      // (or this one's next open) needn't wait out the ttl. A lost lease is never released.
      // Then a host already watching the board is told (as after a clean stop), so it need not wait for its next poll.
      // `releaseP` never rejects: close() waits for it, then announces only if this did not (a failed release leaves the announcing to close()).
      if (!slot.leaseLost) slot.releaseP = withTimeout(Promise.resolve().then(() => store.release(tenant, board, me, slot.epoch)), storeTimeoutMs)   // a release that never answers: the lease lapses by its ttl
        .then(() => { slot.announced = true; slot.released = true; leaseChanges.inc(1, { event: "released" }); bus.publish(subjects.entries(tenant, board), { seq: 0, epoch: slot.epoch, cp: 0, released: true })?.catch?.(() => {}); })
        .catch(e => log.warn("lease release after a failed build failed", { tenant, board, err: e }));
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
      if (what === "stopped") {
        log.error("room stopped", { tenant, board, seq: detail?.seq, err: detail?.err });
        if (detail?.err?.code === "timeout") coolOff(slot.key);   // an append that never answered: stuck (§ Recovery, "Stuck host")
        fail(slot);
      }
      else log.error(`room: ${what}`, { tenant, board, ...detail });
    };
    // § Recovery, Room identity: the epoch is the lease's (acquire bumps it durably), so two builds never share one.
    const opts = { board, tenant, log: logOf(slot), now, epoch: slot.epoch, report, foldBytes: tailFoldBytes, ...(foldUnits ? { foldUnits } : {}),
      // A step runs only while this slot lives: a lost lease or a stopped host abandons a fold in progress, writing nothing.
      schedule: fn => sched(() => { if (!slot.dead) fn(); }), ...(rules ? { rules } : {}) };
    for (let before; ;) {
      const cp = await withTimeout(store.getCheckpoint(tenant, board, before), storeTimeoutMs);
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
    running.add(slot);
    slot.progress = { seq: slot.durable, at: perf() };   // the watchdog's clock starts when the room starts, not at the acquire (a slow build is not a stall)
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
    const w = { key, tenant, board, heardAt: t, wanted: t, epoch: Number.isSafeInteger(lease?.epoch) ? lease.epoch : null, timer: null, silence: null, attempting: false, pending: [],
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
  function answerHeld(w) { for (const h of w.pending.splice(0)) reply(w.tenant, w.board, h.gateway, h.conn, UNAVAILABLE, 1013); }
  /**
   * The holder's `.entries`: it is alive. A heartbeat from a holder that just opened (`opened`, or an epoch above the
   * last one heard) means the hellos held here reached nobody (its room subscribed after them): answer them
   * `unavailable` so the clients retry (MEDIUM-2). Otherwise the holder most likely answered them: those held longer than 2 heartbeats are dropped, younger ones stay (a late beat from a dead holder must not eat a hello). A `released` one: the
   * holder let the board go; answer the held hellos and try to take it at once (L2).
   */
  function watchEntries(w, m) {
    const ep = Number.isSafeInteger(m?.epoch) ? m.epoch : null;
    // A late message from an older incarnation (a dead holder's, delayed on the bus), or one with no epoch, proves nothing about the holder now.
    if (ep === null || (w.epoch !== null && ep < w.epoch)) return;
    w.heardAt = perf();
    const fresh = m?.opened === true || (w.epoch !== null && ep > w.epoch);
    if (w.epoch === null || ep > w.epoch) w.epoch = ep;
    if (m?.released === true) { answerHeld(w); clearTimeout(w.silence); attemptNow(w); return; }
    if (fresh) answerHeld(w);
    else w.pending = w.pending.filter(h => w.heardAt - h.at <= silentAfter);   // older ones: the live holder had its chance to answer; younger stay until it speaks or goes silent
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
    if (perf() - w.heardAt > silentAfter || w.pending.length >= 1_000) return reply(w.tenant, w.board, m.gateway, m.conn, UNAVAILABLE, 1013);
    w.pending.push({ gateway: m.gateway, conn: m.conn, at: perf() });
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
    attempt(w).catch(err => log.error("takeover attempt failed", { tenant: w.tenant, board: w.board, err })).finally(() => { w.attempting = false; if (w.rerun) { w.rerun = false; attemptNow(w); } });   // an open found the cooldown over mid-attempt: once more, now
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
    try { info = await withTimeout(store.lease(w.tenant, w.board), storeTimeoutMs); }
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
    slot.dead = true; slot.unsub(); stopLease(slot); running.delete(slot);
    if (slots.get(slot.key) === slot.promise) slots.delete(slot.key);
    try { slot.room?.fail(new PortError("stopped", "the room host stopped this room")); } catch { /* already stopped */ }
    // A lost lease tells only the connections this slot welcomed (HIGH-1): any other hello on the board is the new
    // holder's or a watcher's to answer.
    for (const [ck, c] of slot.conns) if (!slot.leaseLost || slot.welcomed.has(ck)) reply(slot.tenant, slot.board, c.gateway, c.id, UNAVAILABLE, 1013);
    slot.conns.clear(); slot.welcomed.clear();
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
      reply(slot.tenant, slot.board, gateway, conn, codec.encode(msg), end ? 1013 : undefined);
      if (end) { drop(slot, ck); if (!c.closed) slot.room.disconnect(c); }
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
      for (const [ck, c] of slot.conns) if (c.closed) drop(slot, ck);
      return;
    }
    if (typeof m.conn !== "string") return;
    const ck = `${m.gateway}/${m.conn}`;
    if (slot.dead) { if (!m.closed) reply(slot.tenant, slot.board, m.gateway, m.conn, UNAVAILABLE, 1013); return; }
    let c = slot.conns.get(ck);
    if (m.closed) { if (c) { room.disconnect(c); drop(slot, ck); } return; }
    const msg = m.msg;
    if (!msg || typeof msg !== "object") return;
    if (!c && msg.t === "hello") c = connect(slot, m.gateway, m.conn);
    // Not a hello and not known: a connection this room never welcomed (rule 6). The Room answers `unavailable`
    // (with the op's id) to a connection it doesn't hold; the reply carries the close.
    if (!c) c = { send: out => reply(slot.tenant, slot.board, m.gateway, m.conn, codec.encode(out), 1013), gateway: m.gateway, id: m.conn, closed: true };
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
      if (isHello) { room.disconnect(c); drop(slot, ck); return reply(slot.tenant, slot.board, m.gateway, m.conn, UNAVAILABLE, 1013); }
      return reply(slot.tenant, slot.board, m.gateway, m.conn, codec.encode({ t: "error", ...(typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {}), code: "bad-op", message: "that message could not be handled" }));
    }
    // A refused hello (version, board, client id): the Room dropped it; the gateway closes the socket after the error.
    if (isHello && c.closed && slot.conns.get(ck) === c) { drop(slot, ck); reply(slot.tenant, slot.board, m.gateway, m.conn, undefined, 1008); }
  }

  const sweep = setInterval(() => {
    for (const p of slots.values()) p.then(slot => {
      if (slot.dead) return;
      try { slot.room.sweep(); } catch (err) { log.error("room sweep failed", { board: slot.board, err }); }
      for (const [ck, c] of slot.conns) if (c.closed) drop(slot, ck);
    }, () => {});
  }, sweepMs);
  sweep.unref?.();
  // § Bus: the heartbeat repairs a lost last entry, tells gateways the epoch (for viewers' welcomes) and the newest durable checkpoint.
  const beat = setInterval(() => {
    pruneCooling();
    for (const slot of [...running]) {   // rooms built and alive: a board still building has no beat to give (and no backlog of beats to run when it ends)
      if (slot.dead) { running.delete(slot); continue; }
      if (expired(slot)) { lost(slot, "no lease renew succeeded by the host deadline"); continue; }
      if (stalled(slot)) { coolOff(slot.key); lost(slot, `no progress: ops waiting and the resolved seq unmoved for ${stuckMs} ms`); continue; }
      bus.publish(subjects.entries(slot.tenant, slot.board), slot.room.heartbeat())?.catch?.(() => {});
    }
  }, heartbeatMs);
  beat.unref?.();

  return {
    /** This instance's lease holder id. */
    holder: me,
    /**
     * Make sure this board is served: its room running here under the board's Store lease (built from the Store and
     * listening on its inbox), or, when another host holds the lease live, resolves with no room here (that host
     * serves the inbox over the bus) and watches the board for a takeover. Resolves "held" (the room runs here,
     * listening on its inbox) or "watching" (another host holds the lease).
     * @returns {Promise<"held"|"watching">}
     */
    async open(tenant, board) {
      if (closed) throw closedError();
      const key = `${tenant}/${board}`;
      const p = slots.get(key);
      if (p) { await p; return "held"; }
      const w = watches.get(key);
      if (w) { w.wanted = perf(); if (cooling.has(key) && !isCooling(key)) { cooling.delete(key); if (w.attempting) w.rerun = true; else attemptNow(w); } return "watching"; }   // the cooldown is over: this open is the retake, not the watch's next poll
      const r = await claimOnce(tenant, board, key);
      if (r?.held === undefined) return "held";
      watch(tenant, board, key, r.held);
      return "watching";
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
      return slot ? { room: slot.room, epoch: slot.epoch, durable: slot.durable, conns: slot.conns.size, welcomed: slot.welcomed.size, tailBytes: slot.room.status().tailChars } : null;
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
        await slot.releaseP;
        if (slot.leaseLost || slot.released) continue;   // released (and counted) already after a failed build
        try {
          await withTimeout(Promise.resolve().then(() => store.release(slot.tenant, slot.board, me, slot.epoch)), storeTimeoutMs);   // never answers: the lease lapses by its ttl (logged below)
          leaseChanges.inc(1, { event: "released" });
          // A host watching this board takes it at once (L2), not when it next asks the Store.
          if (!slot.announced) bus.publish(subjects.entries(slot.tenant, slot.board), { seq: slot.durable, epoch: slot.epoch, cp: slot.room?.heartbeat().cp ?? 0, released: true })?.catch?.(() => {});
        } catch (err) { log.warn("lease release failed; it lapses within its ttl", { tenant: slot.tenant, board: slot.board, err }); }
      }
      held.clear(); slots.clear(); running.clear();
    },
  };
}

// ---- remote open (p4-wire): a gateway-only node asks the cluster's room hosts over the bus ----

/**
 * Every room host serves `subjects.open`: each request `{ tenant, board, gateway, n }` runs this host's own
 * `open(tenant, board)` (idempotent: held, building or watched returns once settled; otherwise it acquires or starts
 * watching), then replies `{ n, board, state }` on `subjects.opened(gateway)`. A reply goes only after the local open
 * settled, so a "held" reply means the room already listens on the board's inbox. A local open that throws sends no
 * reply (logged): the requester times out. Returns the unsubscribe.
 * @param {{ bus: import("../ports/bus.js").Bus, rooms: { open(tenant: string, board: string): Promise<string> }, log?: { warn(msg: string, f?: object): void, error(msg: string, f?: object): void } }} o
 */
export function serveOpens({ bus, rooms, log = quietLogger }) {
  return bus.subscribe(subjects.open, m => {
    if (!m || typeof m !== "object") return;
    const { tenant, board, gateway, n } = m;
    let to;
    try { subjects.entries(tenant, board); to = subjects.opened(gateway); } catch { return; }   // bad ids: nobody to serve
    if (!Number.isSafeInteger(n)) return;
    Promise.resolve().then(() => rooms.open(tenant, board)).then(
      state => bus.publish(to, { n, board, state: state === "held" ? "held" : "watching" })?.catch?.(err => log.warn("open reply refused", { tenant, board, err })),
      err => log.error("remote open failed here; no reply", { tenant, board, err }),
    ).catch(err => log.error("remote open reply failed", { tenant, board, err }));
  });
}

/**
 * The `rooms` a gateway-only node hands its gateway (gateway.js needs `open(tenant, board)` only). `open` broadcasts
 * on `subjects.open`. A "held" reply resolves it at once (that host's room already listens on the inbox). A
 * "watching" reply starts a grace of min(1000, timeoutMs / 4) ms: a "held" reply within it still resolves at once,
 * and at its end the open resolves "watching" (some host watches the board, so the hello's inbox path still works).
 * The ttl timer stops when the grace starts (p4-wire2 L4): a `watching` answer late in the ttl still resolves at the
 * grace's end, so the slowest open takes timeoutMs + grace.
 * Why wait: on a cold board the watcher usually answers before the winner has built its room, and a hello sent then
 * is answered 1013 (or lost) instead of welcomed (p4-wire round 2). No reply at all rejects after `timeoutMs` (the
 * gateway then answers the hello `unavailable`). Never cached: every writer hello asks again, because a replaced
 * host has no room until someone asks. At most one request in flight per board; other opens share it.
 * @param {{ bus: import("../ports/bus.js").Bus, node: string, timeoutMs: number, log?: { warn(msg: string, f?: object): void, error?(msg: string, f?: object): void },
 *   timers?: { setTimeout: Function, clearTimeout: Function } }} o node: this node's id (the requester id is
 *   `r-<node>-<random>`, unique per instance). timers: the ttl and grace clock (tests pass a fake).
 */
export function remoteRooms({ bus, node, timeoutMs, log = quietLogger, timers = globalThis }) {
  const later = (fn, ms) => { const t = timers.setTimeout(fn, ms); t?.unref?.(); return t; };
  const cancel = t => { if (t !== undefined && t !== null) timers.clearTimeout(t); };
  checkLeaseTtl(timeoutMs);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
  const me = `r-${String(node ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32)}-${rand}`.replace(/-{2,}/g, "-");
  /** key → { n, board, promise, resolve, reject, timer } */
  const inflight = new Map();
  /** n → key */
  const byN = new Map();
  let next = 0, closed = false;
  const graceMs = Math.min(1000, Math.floor(timeoutMs / 4));
  const settle = (key, err, state) => {
    const r = inflight.get(key);
    if (!r) return;
    inflight.delete(key); byN.delete(r.n); cancel(r.timer); cancel(r.grace);
    if (err) r.reject(err); else r.resolve(state);
  };
  const unsub = bus.subscribe(subjects.opened(me), m => {
    const key = byN.get(m?.n);
    if (key === undefined) return;   // late (timed out) or someone else's
    const r = inflight.get(key);
    if (r?.board !== m.board) return;
    if (m.state === "held") return settle(key, null, "held");
    if (r.grace) return;   // already waiting out the grace from an earlier "watching"
    // A host answered: the ttl no longer applies (L4); the grace's end resolves it unless a "held" comes first.
    cancel(r.timer); r.timer = null;
    r.grace = later(() => settle(key, null, "watching"), graceMs);
  });
  return {
    requester: me,
    open(tenant, board) {
      if (closed) return Promise.reject(new PortError("closed", "the gateway is closed"));
      const key = `${tenant}/${board}`;
      const have = inflight.get(key);
      if (have) return have.promise;
      let msg;
      try { subjects.entries(tenant, board); msg = { tenant, board, gateway: me, n: ++next }; }
      catch (err) { return Promise.reject(err); }
      /** @type {Record<string, any>} */
      const r = { n: msg.n, board };
      r.promise = new Promise((res, rej) => { r.resolve = res; r.reject = rej; });
      r.timer = later(() => settle(key, new PortError("unavailable", "no room host answered the open: is a host node running?")), timeoutMs);
      inflight.set(key, r); byN.set(r.n, key);
      Promise.resolve().then(() => bus.publish(subjects.open, msg)).catch(err => {
        log.warn("remote open publish failed", { tenant, board, err });
        // Only this request (L5): a stale rejection must not settle a newer request for the same board.
        if (inflight.get(key) !== r) return;
        settle(key, err instanceof PortError ? err : new PortError("unavailable", "the open request could not be sent"));
      });
      return r.promise;
    },
    async idle() { await bus.flush(); },
    async peek() { return null; },
    graceMs,
    stats: () => ({ rooms: 0, waiting: 0, opening: inflight.size }),
    async close() {
      closed = true; unsub();
      for (const key of [...inflight.keys()]) settle(key, new PortError("closed", "the gateway is closed"));
    },
  };
}
