// A board's feed, as one gateway sees it: the resolved log, served to clients (PROTOCOL.md rules 3 and 8, § Bus).
// Core code: depends on the Store and Bus ports only.
//
// - Subscribes to `.entries` BEFORE it reads anything, so nothing between catch-up and live is missed.
// - Holds a base (the latest checkpoint that matches the log, checked as § Recovery, Rebuild says; or the empty
//   board) and the entries after it, contiguous, each encoded once. Catch-up = the base's snapshot (when the
//   client is older than it) + the entries after, as shared, encode-once frames of at most `chunkBytes`. A client that
//   asked for deflate gets each shared text as its compressed form, made once on first need and shared (§ Joining).
// - Live: `.entries` messages `{ from, to, items }` are applied in seq order; duplicates are dropped by seq; a gap
//   is read from the Store. The heartbeat `{ seq, epoch, cp }` gives the epoch and reveals a lost last entry. After
//   `pollMs` with no message the Store is read from the last seq + 1, and again every `pollMs` while it is quiet,
//   so delivery needs no room (§ Bus: "a lost last entry is repaired two ways").
// - The tail is re-based on a newer checkpoint from the Store (the room writes one every 1,000 entries or 64 KiB of ops, and
//   not before the tail is a quarter of the state: § Recovery, "When"), so a joiner's catch-up is the board's state plus a short tail. The heartbeat's `cp` (the room's newest durable
//   checkpoint) says when there is one to read: each checkpoint is read at most once (PROTOCOL.md § Bus, `cp`).
// Never throws to its caller: Store errors are logged and retried by the next message or poll.

import { snapshotOf } from "../packages/protocol/room.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { subjects, utf8Length } from "./bus/port.js";
import { quietLogger } from "./log.js";
import { breathe } from "./breather.js";

const EMPTY = { seq: 0, id: null, by: null, at: null, streams: { board: { elements: [], appState: {} }, notes: { elements: [], appState: {} } }, appSeq: { board: {}, notes: {} }, records: { threads: [] }, noteAuthor: [] };

/**
 * @param {{ tenant: string, board: string, store: object, bus: object, onLive: (e: { from: number, to: number, at?: number, data: string }) => void,
 *   log?: object, codec?: object, deflate?: (data: string | Uint8Array) => Promise<Uint8Array | null>, pollMs?: number, chunkBytes?: number, pageSize?: number, pageBytes?: number, rebaseEvery?: number, rebaseBytes?: number, zSlack?: number, random?: () => number }} o
 *   deflate: compresses one catch-up text once (PROTOCOL.md § Joining); absent, or answering null for a frame, joiners get it plain.
 *   zSlack: bytes of new entries after which the open last chunk's compressed prefix is made again (default 16 KiB).
 *   random: the backoff's jitter source, [0, 1) (tests pass a fixed one).
 *   now, timers: the clock and the `setInterval`/`clearInterval` of the silence poll (tests pass a virtual clock).
 *   onLive: called for every run of new resolved entries, in seq order, with the encoded `entries` frame.
 */
export function boardFeed({ tenant, board, store, bus, onLive, log = quietLogger, codec = jsonCodec, deflate = null, pollMs = 5_000, chunkBytes = 1024 * 1024,
  pageSize = 1_000, pageBytes = 4 * 1024 * 1024, rebaseEvery = 1_000, rebaseBytes = 4 * 1024 * 1024, zSlack = 16 * 1024, random = Math.random, now = Date.now, timers = globalThis }) {
  const { setInterval, clearInterval } = timers;
  const key = `${tenant}/${board}`;
  const self = {
    tenant, board, seq: 0, epoch: 0, ready: /** @type {Promise<void> | null} */ (null), close: /** @type {() => void} */ (() => {}), closed: false, gapAt: 0,
    base: EMPTY, tail: [],   // tail: [{ seq, id, by, at, text }], seq = base.seq + 1 …
    snap: null, zTails: new Map(), chunks: [], chunksLen: 0, lastHeard: now(), nextRebase: rebaseEvery, tailBytes: 0, nextRebaseBytes: rebaseBytes,
    cpHeard: null, lookedAt: 0, retries: 0, looks: 0, failures: 0, skip: 0, failedFor: 0,   // the checkpoint look (rebase, below)
  };
  const frameOf = list => (codec === jsonCodec ? `{"t":"entries","entries":[${list.map(x => x.text).join(",")}]}` : codec.encode({ t: "entries", entries: list.map(x => JSON.parse(x.text)) }));

  // Everything that changes the feed runs one at a time, in arrival order (an explicit queue: most steps are sync).
  let pending = [], running = false;
  const run = step => new Promise((res, rej) => { pending.push({ step, res, rej }); if (!running) drain(); });
  async function drain() {
    running = true;
    while (pending.length) {
      const { step, res, rej } = pending.shift();
      try { res(await step()); } catch (err) { rej(err); }
    }
    running = false;
  }

  /** New entries (parsed, with their text), applied if they continue the feed. Returns how many were applied. */
  /** False until the first load is done: what a joiner is caught up on is old by nature, not fan-out lag (PROTOCOL.md § Metrics). */
  let live = false;
  function apply(list) {
    const fresh = [];
    for (const x of list) {
      if (x.seq === -1) break;                // a corrupt entry: stop here (logged)
      if (x.seq <= self.seq) continue;        // a duplicate (bus and Store both delivered it)
      if (x.seq !== self.seq + 1) break;      // a gap: the caller repairs from the Store
      self.tail.push(x); self.seq = x.seq; self.tailBytes += x.text.length; fresh.push(x);
    }
    if (fresh.length) onLive({ from: fresh[0].seq, to: fresh[fresh.length - 1].seq, at: live ? fresh[0].at : undefined, data: frameOf(fresh) });   // at: when the room sequenced the first one (fan-out lag, PROTOCOL.md § Metrics)
    return fresh.length;
  }
  const fromStore = e => {
    // Another board's entry in this board's log is corruption: never served (the room refuses to start on it too).
    if (!e || e.board !== board || e.tenant !== tenant) { log.error("feed: the Store returned another board's entry", { tenant, board, seq: e?.seq }); return { seq: -1 }; }
    return { seq: e.seq, id: e.id, by: e.by, at: e.at, text: codec.encode(e) };
  };
  const fromBus = (text, seq) => { const e = JSON.parse(text); return { seq: e.seq ?? seq, id: e.id, by: e.by, at: e.at, text }; };

  /**
   * Read the Store from seq + 1 up to `upTo` (or its end) and apply it. A page that doesn't start at seq + 1 is a gap
   * in the log itself: corruption (§ Recovery: a room refuses to start on it). The feed stops there, says so loudly
   * once per gap, and sets `gapAt` so the gateway refuses new joins (`unavailable`) instead of welcoming them at the
   * seq before the gap, where they would silently never get anything newer. Cleared if the Store later fills it.
   * An entry at seq + 1 that belongs to another board is treated the same way (it is never served).
   */
  async function repair(upTo = Infinity) {
    while (self.seq < upTo && !self.closed) {
      const page = await store.read(tenant, board, self.seq + 1, pageSize, pageBytes);
      if (!page.length) break;
      if (apply(page.map(fromStore)) === 0) {
        // Nothing in a non-empty page continues the feed: a gap, or an entry at seq + 1 that can't be served
        // (another board's). Either way joins are refused until it is fixed (R4: a foreign entry used to stop the
        // feed without `gapAt`, so joiners were welcomed short).
        const at = self.seq + 1;
        if (self.gapAt !== at) {
          self.gapAt = at;
          if (page[0]?.seq !== at) log.error("feed: the Store log has a gap: entries after it are not served", { tenant, board, missing: at, next: page[0]?.seq ?? null });
          else log.error("feed: the Store log has an entry it can't serve: entries from it on are not served", { tenant, board, at });
        }
        break;
      }
      if (self.gapAt && self.seq >= self.gapAt) { log.warn("feed: the log gap is filled", { tenant, board, at: self.gapAt }); self.gapAt = 0; }
      await breathe();
    }
  }

  /** A checkpoint that matches the log (its entry S has the same id, by and at), or the empty board. */
  async function validBase() {
    for (let before; ;) {
      const cp = await store.getCheckpoint(tenant, board, before);
      if (!cp || !(cp.seq > 0)) return EMPTY;
      const [e] = await store.read(tenant, board, cp.seq, 1);
      if (e && e.seq === cp.seq && e.id === cp.id && e.by === cp.by && e.at === cp.at) return cp;
      log.error("feed: a checkpoint doesn't match the log; stepping back", { tenant, board, seq: cp.seq });
      before = cp.seq;
    }
  }

  // When to read the Store for a newer checkpoint (PROTOCOL.md § Bus, `cp`):
  // - The room announces its newest durable checkpoint in every heartbeat (`cp`, only once its write is acknowledged).
  //   A feed that has heard one looks only on a heartbeat or poll, and only when the largest `cp` heard is above its
  //   base and above the `cp` of its last completed look: one read per checkpoint, none on an idle board or while
  //   the room hasn't folded. A look that throws (a Store error) is not completed, so the next heartbeat tries again.
  // - A feed that has heard no `cp` yet (it joined between heartbeats, or only Store polls reached it) looks once its tail reaches
  //   `rebaseEvery` entries or `rebaseBytes` chars since the last look, and after a miss (the room writes its
  //   checkpoint just after publishing the entries that trigger it) on at most MISS_RETRIES later heartbeats or
  //   polls; a look that throws keeps at least one retry.
  // - A look that throws backs off: after the n-th failure in a row, with b = min(MAX_SKIP, 2^(n-1) - 1), the next
  //   k heartbeats or polls are skipped, k from [ceil(b/2), b] by `random` (jitter: gateways don't look in lockstep).
  //   While skipping no look is made, not even a due one on entries, so a Store that answers getCheckpoint but fails
  //   the entry check costs at most one full checkpoint read per 17 heartbeats, plus one per newly announced checkpoint. A heartbeat naming a cp above the one
  //   the failing look was for ends the skip; a look that completes resets n.
  const MISS_RETRIES = 3, MAX_SKIP = 31;
  const rebaseDue = () => self.tail.length >= self.nextRebase || self.tailBytes >= self.nextRebaseBytes;
  async function maybeRebase(beat) {
    if (self.skip > 0 && self.cpHeard !== null && self.cpHeard > self.failedFor) self.skip = 0;   // a newer checkpoint
    if (self.skip > 0) { if (beat) self.skip--; return; }
    if (self.cpHeard !== null) {
      if (beat && self.cpHeard > Math.max(self.base.seq, self.lookedAt) && self.cpHeard <= self.seq) await rebase(false);
    } else if (rebaseDue()) await rebase(true);
    else if (beat && self.retries > 0) await rebase(false);
  }
  async function rebase(due) {
    const heard = self.cpHeard, before = self.retries;
    if (due) { again(); self.retries = Math.max(before, 1); }
    self.looks++;
    let cp;
    try { cp = await validBase(); }   // a Store error skips the bookkeeping below: the look is tried again, on a backoff
    catch (err) {
      self.failures++; self.failedFor = heard ?? 0;
      const b = Math.min(MAX_SKIP, 2 ** (self.failures - 1) - 1);
      self.skip = b - Math.floor(random() * (Math.floor(b / 2) + 1));   // in [ceil(b/2), b]; random() < 1
      throw err;
    }
    self.failures = 0;
    if (heard !== null) self.lookedAt = Math.max(self.lookedAt, heard);
    if (cp.seq <= self.base.seq || cp.seq > self.seq) { self.retries = due ? MISS_RETRIES : Math.max(0, before - 1); return; }
    const cut = self.tail.slice(0, cp.seq - self.base.seq);
    self.tail = self.tail.slice(cp.seq - self.base.seq);
    for (const x of cut) self.tailBytes -= x.text.length;
    self.base = cp; self.snap = null; self.zTails = new Map(); self.chunks = []; self.chunksLen = 0; self.retries = 0;
    again();
  }
  function again() { self.nextRebase = self.tail.length + rebaseEvery; self.nextRebaseBytes = self.tailBytes + rebaseBytes; }

  async function onMessage(m) {
    // Traffic from a lower epoch (a dead incarnation's, late on the bus) is not "the room is alive": the silence poll must still run.
    // `released` is a host leaving (a clean stop, or a build that failed and gave the board back): no room is alive behind it, and a
    // failed build's epoch belongs to a room that never served. It neither counts as liveness nor raises the epoch (it still carries a `cp`).
    const left = m?.released === true;
    if (!left && Number.isSafeInteger(m?.epoch) && m.epoch >= self.epoch) self.lastHeard = now();
    if (!left && Number.isSafeInteger(m?.epoch) && m.epoch > self.epoch) self.epoch = m.epoch;
    if (Array.isArray(m?.items) && Number.isSafeInteger(m.from)) {
      if (m.to <= self.seq) return;
      if (m.from > self.seq + 1) await repair(m.from - 1);
      apply(m.items.map((t, i) => fromBus(t, m.from + i)));
      if (m.to > self.seq) await repair(m.to);   // still short (the repair raced the room): the Store has it
    } else if (Number.isSafeInteger(m?.seq) && m.seq > self.seq) await repair(m.seq);
    const beat = !Array.isArray(m?.items);
    if (beat && Number.isSafeInteger(m?.cp) && m.cp >= 0) self.cpHeard = Math.max(self.cpHeard ?? 0, m.cp);   // every heartbeat and `released` carries `cp`
    await maybeRebase(beat);
    live = true;   // a feed whose first load failed is live again once a later step succeeds (what that step applied was catch-up, not observed)
  }

  const unsub = bus.subscribe(subjects.entries(tenant, board), m => { run(() => onMessage(m)).catch(err => log.error("feed: message failed", { tenant, board, err })); });
  const poll = setInterval(() => {
    if (now() - self.lastHeard < pollMs || running) return;
    self.lastHeard = now();   // the next look is a full pollMs away
    run(async () => { await repair(); await maybeRebase(true); live = true; }).catch(err => log.warn("feed: Store poll failed", { tenant, board, err }));
  }, Math.max(50, Math.floor(pollMs / 2)));
  poll.unref?.();

  self.ready = run(async () => {
    self.epoch = Math.max(self.epoch, await store.epoch(tenant, board));
    self.base = await validBase(); self.seq = self.base.seq;
    await repair();
    live = true;
  });

  /** The tail as bounded `entries` frames, built once per (base, tail) and shared: only the open last one is rebuilt. */
  function tailChunks() {
    const tail = self.tail;
    if (self.chunksLen === tail.length) return self.chunks;
    const chunks = self.chunks;
    if (chunks.length && !chunks[chunks.length - 1].closed) chunks.pop();
    let i = chunks.length ? chunks[chunks.length - 1].to - self.base.seq : 0, cur = [], bytes = 0;
    const emit = closed => { const data = frameOf(cur); chunks.push({ from: cur[0].seq, to: cur[cur.length - 1].seq, closed, data, bytes: utf8Length(data), key: `${key}/c${self.base.seq}.${cur[0].seq}-${cur[cur.length - 1].seq}` }); cur = []; bytes = 0; };
    for (; i < tail.length; i++) {
      const n = tail[i].text.length;
      if (cur.length && bytes + n > chunkBytes) emit(true);
      cur.push(tail[i]); bytes += n;
    }
    if (cur.length) emit(bytes >= chunkBytes);
    self.chunksLen = tail.length;
    return chunks;
  }

  /** The shared catch-up texts that bring a client at `since` up to the feed's seq, in order: { part, key, own? }. A client
   *  starting inside a chunk gets its own cut of it (`own`: not shared, never compressed). */
  function parts(since) {
    const out = [];
    if (since < self.base.seq) {
      self.snap ??= (() => { const data = codec.encode(snapshotOf(self.base)); return { data, bytes: utf8Length(data), shared: `${key}/s${self.base.seq}` }; })();
      out.push({ part: self.snap, key: self.snap.shared });
      since = self.base.seq;
    }
    for (const ch of tailChunks()) {
      if (ch.to <= since) continue;
      if (ch.from > since) out.push({ part: ch, key: ch.key });
      else out.push({ own: frameOf(self.tail.slice(since - self.base.seq, ch.to - self.base.seq)) });
    }
    return out;
  }

  /** Compress a text once; every joiner who wants it shares the result (`z`: the bytes, or null = not worth it). */
  const squeeze = part => (part.zp ??= Promise.resolve(deflate(part.data)).then(z => { part.z = z ?? null; }, err => { part.z = null; log.warn("feed: compression failed; joiners get plain text", { tenant, board, err }); }));

  // The tail's last chunk grows with every entry, so its text is never the same twice: compressing "the chunk" would go stale
  // before it could be sent. Instead its compressed form is a PREFIX (the chunk's entries up to seq `to`, fixed when the
  // deflate started) and a join sends it followed by the entries after `to` as a plain cut of its own. Always valid, however
  // many entries land during the deflate; re-made only after `zSlack` bytes of new entries (bounded work). Kept per chunk start
  // (`self.zTails`: from -> { good: newest SETTLED prefix { to, z }, tried: `to` of the newest attempt, p: its promise }), so a
  // newer attempt in flight never hides the settled one a waiting join counted on, and a chunk that closes keeps its prefix.
  const zTailOf = ch => { const g = self.zTails.get(ch.from)?.good; return g && g.to <= ch.to ? g : null; };
  const slackBytes = (to, ch) => { let n = 0; for (let i = to - self.base.seq; i < ch.to - self.base.seq; i++) n += self.tail[i].text.length; return n; };
  function squeezeTail(ch) {
    let e = self.zTails.get(ch.from);
    if (!e) self.zTails.set(ch.from, e = { good: null, tried: -1, p: null });
    if (e.p && slackBytes(e.tried, ch) < zSlack) return e.p;
    const to = ch.to;
    e.tried = to;
    return e.p = Promise.resolve(deflate(ch.data)).then(z => { if (z && (!e.good || to > e.good.to)) e.good = { to, z }; },
      err => log.warn("feed: compression failed; joiners get plain text", { tenant, board, err }));
  }

  /**
   * Rule 3: the frames that bring a client at `since` up to the feed's seq, as `{ data, bytes, shared }` (`shared`
   * names encode-once text many joiners hold; a client starting inside a chunk gets its own cut of it). With `z`
   * (the client asked for deflate, § Joining) a text whose compressed form is ready goes as that form (binary, shared
   * under its own name); one that isn't ready, or isn't worth compressing, goes plain: `prepare(since)` first makes them ready.
   * A chunk with only a compressed prefix goes as that prefix, then its newer entries as a plain cut: same entries, same order.
   */
  self.catchUp = (since, z = false) => parts(since).flatMap(({ part, key: shared, own }) => {
    if (own !== undefined) return [{ data: own, bytes: utf8Length(own), shared: false }];
    if (z && part.z) return [{ data: part.z, bytes: part.z.byteLength, shared: shared + "/z", z: true }];
    const pre = z && part.from !== undefined && !part.z ? zTailOf(part) : null;
    if (pre) {
      const out = [{ data: pre.z, bytes: pre.z.byteLength, shared: `${key}/c${self.base.seq}.${part.from}-${pre.to}/z`, z: true }];
      if (part.to > pre.to) {
        const cut = frameOf(self.tail.slice(pre.to - self.base.seq, part.to - self.base.seq));
        out.push({ data: cut, bytes: utf8Length(cut), shared: false });
      }
      return out;
    }
    return [{ data: part.data, bytes: part.bytes, shared }];
  });
  /**
   * Have the compressed form of every text a join at `since` would send, so catchUp(since, true) can use it. Waits for the
   * feed's start (a join may ask before it has read the Store). One deflate per text; the open last chunk gets a prefix form
   * (above), re-made only after `zSlack` bytes of new entries. Entries landing while this runs never make the result stale.
   */
  self.prepare = async since => {
    if (!deflate) return;
    await self.ready;
    await Promise.all(parts(since).filter(p => p.part).map(({ part }) => part.from === undefined ? squeeze(part) : part.closed ? squeeze(part).then(() => { if (part.z) self.zTails.delete(part.from); }) : squeezeTail(part)));   // a closed chunk with its whole compressed form needs no prefix
  };
  /** Make sure the feed has every entry up to `seq` (a writer's welcome may name entries the bus hasn't brought yet). */
  self.reach = seq => (seq > self.seq ? run(() => repair(seq)) : Promise.resolve());
  /** Run `f` when no feed step is running, so what it reads (seq, tail) and what is delivered next agree. */
  self.atomically = f => run(async () => f());
  self.close = () => { self.closed = true; unsub(); clearInterval(poll); };
  return self;
}
