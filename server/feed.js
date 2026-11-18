// A board's feed, as one gateway sees it: the resolved log, served to clients (PROTOCOL.md rules 3 and 8, § Bus).
// Core code: depends on the Store and Bus ports only.
//
// - Subscribes to `.entries` BEFORE it reads anything, so nothing between catch-up and live is missed.
// - Holds a base (the latest checkpoint that matches the log, checked as § Recovery, Rebuild says; or the empty
//   board) and the entries after it, contiguous, each encoded once. Catch-up = the base's snapshot (when the
//   client is older than it) + the entries after, as shared, encode-once frames of at most `chunkBytes`.
// - Live: `.entries` messages `{ from, to, items }` are applied in seq order; duplicates are dropped by seq; a gap
//   is read from the Store. The heartbeat `{ seq, epoch }` gives the epoch and reveals a lost last entry. After
//   `pollMs` with no message the Store is read from the last seq + 1, and again every `pollMs` while it is quiet,
//   so delivery needs no room (§ Bus: "a lost last entry is repaired two ways").
// - The tail is re-based on a newer checkpoint from the Store once it is long (the room writes one every 1,000
//   entries or later), so a joiner's catch-up is the board's state plus a bounded tail.
// Never throws to its caller: Store errors are logged and retried by the next message or poll.

import { snapshotOf } from "../packages/protocol/room.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { subjects, utf8Length } from "./bus/port.js";
import { quietLogger } from "./log.js";
import { breathe } from "./breather.js";

const EMPTY = { seq: 0, id: null, by: null, at: null, streams: { board: { elements: [], appState: {} }, notes: { elements: [], appState: {} } }, appSeq: { board: {}, notes: {} }, records: { threads: [] }, noteAuthor: [] };

/**
 * @param {{ tenant: string, board: string, store: object, bus: object, onLive: (e: { from: number, to: number, data: string }) => void,
 *   log?: object, codec?: object, pollMs?: number, chunkBytes?: number, pageSize?: number, pageBytes?: number, rebaseEvery?: number }} o
 *   onLive: called for every run of new resolved entries, in seq order, with the encoded `entries` frame.
 */
export function boardFeed({ tenant, board, store, bus, onLive, log = quietLogger, codec = jsonCodec, pollMs = 5_000, chunkBytes = 1024 * 1024,
  pageSize = 1_000, pageBytes = 4 * 1024 * 1024, rebaseEvery = 1_000, rebaseBytes = 4 * 1024 * 1024 }) {
  const key = `${tenant}/${board}`;
  const self = {
    tenant, board, seq: 0, epoch: 0, ready: null, closed: false, gapAt: 0,
    base: EMPTY, tail: [],   // tail: [{ seq, id, by, at, text }], seq = base.seq + 1 …
    snap: null, chunks: [], chunksLen: 0, lastHeard: Date.now(), nextRebase: rebaseEvery, tailBytes: 0, nextRebaseBytes: rebaseBytes, missed: false,
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
  function apply(list) {
    const fresh = [];
    for (const x of list) {
      if (x.seq === -1) break;                // a corrupt entry: stop here (logged)
      if (x.seq <= self.seq) continue;        // a duplicate (bus and Store both delivered it)
      if (x.seq !== self.seq + 1) break;      // a gap: the caller repairs from the Store
      self.tail.push(x); self.seq = x.seq; self.tailBytes += x.text.length; fresh.push(x);
    }
    if (fresh.length) onLive({ from: fresh[0].seq, to: fresh[fresh.length - 1].seq, data: frameOf(fresh) });
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

  // Looked for after every `rebaseEvery` entries or `rebaseBytes` chars of tail since the last look. The room writes
  // its checkpoint just AFTER it publishes the entries that triggered it, so the look those entries cause usually
  // misses it: after a miss the feed looks again on every heartbeat (every 2 s) or Store poll, and not on entries (a
  // burst can still be ahead of it), until the look finds the checkpoint. A heartbeat can land before the checkpoint is
  // written, so one retry is not enough; the cost of going on is one checkpoint read per heartbeat while a miss is
  // open, and a miss closes as soon as a checkpoint ahead of the base exists (a room that never folds is read at
  // the heartbeat's pace, no faster).
  const rebaseDue = () => self.tail.length >= self.nextRebase || self.tailBytes >= self.nextRebaseBytes;
  async function rebase() {
    const again = () => { self.nextRebase = self.tail.length + rebaseEvery; self.nextRebaseBytes = self.tailBytes + rebaseBytes; };
    again(); self.missed = false;
    const cp = await validBase();
    if (cp.seq <= self.base.seq || cp.seq > self.seq) { self.missed = true; return; }
    const cut = self.tail.slice(0, cp.seq - self.base.seq);
    self.tail = self.tail.slice(cp.seq - self.base.seq);
    for (const x of cut) self.tailBytes -= x.text.length;
    self.base = cp; self.snap = null; self.chunks = []; self.chunksLen = 0;
    again();
  }

  async function onMessage(m) {
    self.lastHeard = Date.now();
    if (Number.isSafeInteger(m?.epoch) && m.epoch > self.epoch) self.epoch = m.epoch;
    if (Array.isArray(m?.items) && Number.isSafeInteger(m.from)) {
      if (m.to <= self.seq) return;
      if (m.from > self.seq + 1) await repair(m.from - 1);
      apply(m.items.map((t, i) => fromBus(t, m.from + i)));
      if (m.to > self.seq) await repair(m.to);   // still short (the repair raced the room): the Store has it
    } else if (Number.isSafeInteger(m?.seq) && m.seq > self.seq) await repair(m.seq);
    if (rebaseDue()) await rebase();
    else if (self.missed && !Array.isArray(m?.items)) await rebase();   // a heartbeat: the retry after a miss
  }

  const unsub = bus.subscribe(subjects.entries(tenant, board), m => { run(() => onMessage(m)).catch(err => log.error("feed: message failed", { tenant, board, err })); });
  const poll = setInterval(() => {
    if (Date.now() - self.lastHeard < pollMs || running) return;
    run(async () => { await repair(); if (rebaseDue()) await rebase(); else if (self.missed) await rebase(); }).catch(err => log.warn("feed: Store poll failed", { tenant, board, err }));
  }, Math.max(50, Math.floor(pollMs / 2)));
  poll.unref?.();

  self.ready = run(async () => {
    self.epoch = Math.max(self.epoch, await store.epoch(tenant, board));
    self.base = await validBase(); self.seq = self.base.seq;
    await repair();
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

  /**
   * Rule 3: the frames that bring a client at `since` up to the feed's seq, as `{ data, bytes, shared }` (`shared`
   * names encode-once text many joiners hold; a client starting inside a chunk gets its own cut of it).
   */
  self.catchUp = since => {
    const frames = [];
    if (since < self.base.seq) {
      if (!self.snap) { const data = codec.encode(snapshotOf(self.base)); self.snap = { data, bytes: utf8Length(data), shared: `${key}/s${self.base.seq}` }; }
      frames.push(self.snap);
      since = self.base.seq;
    }
    for (const ch of tailChunks()) {
      if (ch.to <= since) continue;
      if (ch.from > since) frames.push({ data: ch.data, bytes: ch.bytes, shared: ch.key });
      else { const data = frameOf(self.tail.slice(since - self.base.seq, ch.to - self.base.seq)); frames.push({ data, bytes: utf8Length(data), shared: false }); }
    }
    return frames;
  };
  /** Make sure the feed has every entry up to `seq` (a writer's welcome may name entries the bus hasn't brought yet). */
  self.reach = seq => (seq > self.seq ? run(() => repair(seq)) : Promise.resolve());
  /** Run `f` when no feed step is running, so what it reads (seq, tail) and what is delivered next agree. */
  self.atomically = f => run(async () => f());
  self.close = () => { self.closed = true; unsub(); clearInterval(poll); };
  return self;
}
