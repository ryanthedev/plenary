// The reference room: the one sequencer for a board (PROTOCOL.md v1.1). Its state is a pure function of the
// log, so it can be rebuilt from a checkpoint plus the entries after it (§ Recovery). Storage comes in
// through the Log port; identity comes with the hello, already verified by a gateway (rule 8): a room
// never sees a token. It never runs layout, and it never sees presence.
//
// Two states (§ Recovery): the live one here is *speculative* (every accepted entry, appended or not);
// `resolved` is the seq up to which the log has confirmed. Welcome, catch-up, snapshots, checkpoints, acks
// and broadcasts only ever show resolved entries. With a synchronous log the two are always equal.

import { Doc, wins } from "../core/doc.js";
import { emptyScene, clone } from "../core/model.js";
import {
  ELEMENT_STREAMS, ROLES, RULES, RULES_VERSION, PROTOCOL_VERSION, CAPS, CHECKPOINT_EVERY, MAX_VERSION_JUMP, MAX_CLIENT_CHARS,
  MAX_NAME_CHARS, APPEND_TIMEOUT_MS, GATEWAY_SILENCE_MS,
  canWrite, canModerate, opProblem, parseOpId, mergeAppState,
} from "./envelope.js";
import { Records } from "./records.js";

const fail = (code, message) => Object.assign(new Error(message), { code });
const keyOf = (user, client) => `${client}:${user}`;   // a client id holds no colon, so this can't collide
const chars = v => JSON.stringify(v).length;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A checkpoint as a client may see it (§ Recovery, "Snapshot"): no op-id table, tombstones kept. */
export function snapshotOf(cp) {
  return { t: "snapshot", seq: cp.seq, streams: clone(cp.streams), appSeq: clone(cp.appSeq), records: clone(cp.records), noteAuthor: clone(cp.noteAuthor) };
}

/**
 * Rule 3, as a pure function a gateway can call too: the messages that bring a client at `since` up to
 * date, from a checkpoint (`base`) and the resolved entries after it (`tail`, ascending, starting at
 * base.seq + 1). A snapshot first when the tail no longer reaches back to `since`.
 */
export function catchUp(base, tail, since) {
  const out = [];
  if (since < base.seq) out.push(snapshotOf(base));
  const rest = since > base.seq ? tail.slice(since - base.seq) : tail.slice();
  if (rest.length) out.push({ t: "entries", entries: rest });
  return out;
}

export class Room {
  /**
   * A new, empty room. To bring a board back, use Room.rebuild or Room.fromLog.
   * @param {{ board: string, tenant: string, log: import("./ports.js").Log, now?: () => number, epoch?: number,
   *           rules?: object, auto?: boolean, report?: (what: string, detail: object) => void }} o
   *   `now`: the room's clock in ms (entries carry it as `at`). `epoch`: this incarnation's number from
   *   Store.openEpoch, which the host calls before building the room (§ Recovery, Room identity); every
   *   welcome carries it. Omitted: the log's openEpoch() if it has one, else 1. `rules`: per rules version { W, H, every }; only tests pass it. `auto`: checkpoint
   *   by itself (§ Recovery, "When"). `report`: errors worth logging.
   */
  constructor({ board, tenant, log, now = Date.now, epoch, rules = RULES, auto = true, report = () => {} }) {
    // A host passes the epoch it opened; without one, open the log's next (so two builds never share one), else 1.
    if (epoch === undefined) epoch = typeof log?.openEpoch === "function" ? log.openEpoch() : 1;
    Object.assign(this, { board, tenant, log, now, epoch, rules, auto, report });
    this.conns = new Set();
    this.queue = [];          // accepted, not yet handed to an append: [{ entry, c, key, counter, horizon }]
    this.inflight = null;     // the batch in the one append in flight
    this.held = [];           // answers that depend on unresolved entries: [{ c, m, until }]
    this.unresolved = new Map();   // "client:user" → { n, high }: its entries not yet resolved, and its high before them
    this.heard = new Map();   // gateway → when the room last heard from it (rule 6)
    this.stopped = false;
    this.load(null);
    this.base = this.fold();  // the checkpoint the kept tail starts from
    this.tail = [];           // resolved entries after `base` (the log kept for catch-up)
    this.tailChars = 0;
  }

  // ---- state: load, fold, apply ----

  /** Replace the whole state with a checkpoint's (null = an empty board). */
  load(cp) {
    this.streams = {}; this.appSeq = {}; this.chars = {};
    for (const s of ELEMENT_STREAMS) {
      const sc = cp?.streams?.[s];
      const doc = new Doc(sc ? { elements: clone(sc.elements), appState: clone(sc.appState) } : emptyScene());
      this.streams[s] = doc; this.appSeq[s] = { ...(cp?.appSeq?.[s] ?? {}) };
      let n = 0; for (const el of doc.byId.values()) n += chars(el);
      this.chars[s] = n;      // JSON size of the stream's elements, tombstones included (§ Limits)
    }
    this.records = new Records(cp?.records);
    this.clients = new Map();   // the op-id table: "client:user" → { user, client, high, last, recent: [[counter, seq]…] }
    for (const r of cp?.clients?.list ?? []) this.clients.set(keyOf(r.user, r.client), { user: r.user, client: r.client, high: r.high, last: r.last, recent: r.recent.map(p => [p[0], p[1]]) });
    this.horizon = this.resolvedHorizon = cp?.clients?.horizon ?? 0;
    this.noteAuthor = new Map(cp?.noteAuthor ?? []);   // notes element id → the user who first wrote it
    this.seq = this.resolved = cp?.seq ?? 0;
    this.last = { id: cp?.id ?? null, by: cp?.by ?? null, at: cp?.at ?? null };
  }

  /** The live state as a checkpoint (§ Recovery). Only meaningful when nothing is unresolved. */
  fold() {
    const streams = {};
    for (const s of ELEMENT_STREAMS) { const sc = this.streams[s].toScene(); streams[s] = { elements: clone(sc.elements), appState: clone(sc.appState) }; }
    return {
      seq: this.seq, id: this.last.id, by: this.last.by, at: this.last.at, rv: RULES_VERSION,
      streams, appSeq: clone(this.appSeq), records: this.records.toJSON(),
      clients: { horizon: this.horizon, list: [...this.clients.values()].map(r => ({ user: r.user, client: r.client, high: r.high, last: r.last, recent: r.recent.map(p => [p[0], p[1]]) })) },
      noteAuthor: [...this.noteAuthor],
    };
  }

  /**
   * The one step live ops and replay share (§ Recovery, "One step"): merge into the stream or the records,
   * record the op id, record note authors, run eviction. No role or limit checks: the entry was accepted.
   */
  applyEntry(e) {
    const rules = this.rules[e.rv], id = parseOpId(e.id);
    if (!rules) throw fail("unknown-rules", `entry ${e.seq} was accepted under rules version ${e.rv}, which this room doesn't know`);
    if (!id) throw fail("corrupt-log", `entry ${e.seq} has no op id`);
    if (e.stream === "records") this.records.apply(e.op, e.by, e.at, e.name ?? null);
    else {
      const doc = this.streams[e.stream];
      if (!doc) throw fail("corrupt-log", `entry ${e.seq} names an unknown stream`);
      for (const el of e.op.elements ?? []) {
        const cur = doc.getAny(el.id);
        if (wins(el, cur)) { this.chars[e.stream] += chars(el) - (cur ? chars(cur) : 0); doc.apply({ elements: [el] }); }
        // An author outlives its note's tombstone, so no one can revive and claim another's note.
        if (e.stream === "notes" && !this.noteAuthor.has(el.id)) this.noteAuthor.set(el.id, e.by);
      }
      if (e.op.appState) {
        const next = { ...doc.appState.herdr };
        mergeAppState(next, this.appSeq[e.stream], e.op.appState, e.seq);
        doc.appState.herdr = next; doc.rev++; doc._sorted = null;
      }
    }
    const key = keyOf(e.by, id.client);
    let rec = this.clients.get(key);
    if (!rec) this.clients.set(key, rec = { user: e.by, client: id.client, high: 0, last: 0, recent: [] });
    rec.high = Math.max(rec.high, id.counter); rec.last = e.seq;
    rec.recent.push([id.counter, e.seq]);
    if (rec.recent.length > rules.W) rec.recent.shift();   // counters rise, so the first pair has the lowest
    this.seq = e.seq; this.last = { id: e.id, by: e.by, at: e.at };
    // An eviction tick depends only on seq, so replay evicts alike (§ Op ids).
    if (e.seq % rules.every === 0) {
      const floor = e.seq - rules.H;
      for (const [k, r] of this.clients) {
        if (r.last < floor) { this.clients.delete(k); this.horizon = Math.max(this.horizon, r.last); }
        else if (r.recent[0][1] < floor) r.recent = r.recent.filter(p => p[1] >= floor);
      }
    }
  }

  /** Everything a rebuilt room must equal, as plain sorted data (tests compare this). */
  state() {
    const streams = {};
    for (const s of ELEMENT_STREAMS) { const d = this.streams[s]; streams[s] = { elements: [...d.byId.values()].sort(byId), appState: d.appState.herdr }; }
    return {
      seq: this.seq, streams, appSeq: this.appSeq, records: this.records.toJSON(), horizon: this.horizon,
      clients: [...this.clients.values()].sort((a, b) => (keyOf(a.user, a.client) < keyOf(b.user, b.client) ? -1 : 1)),
      noteAuthor: [...this.noteAuthor].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    };
  }

  // ---- recovery ----

  /**
   * Bring a room back from a checkpoint and the log (§ Recovery, "Rebuild"). `entries` are the log's,
   * ascending, from the checkpoint's own entry S (needed to check it) to the end; without a checkpoint,
   * from seq 1. Throws `bad-checkpoint` if entry S doesn't match (the caller steps back to the checkpoint
   * before it), and `corrupt-log` on a gap, a repeated seq or another board's entry.
   */
  static rebuild({ checkpoint = null, entries = [], ...opts }) {
    const room = new Room(opts);
    let S = 0;
    if (checkpoint && checkpoint.seq > 0) {
      S = checkpoint.seq;
      const at = entries.length ? S - entries[0].seq : -1, e = at >= 0 ? entries[at] : null;
      if (!room.rules[checkpoint.rv] || !e || e.seq !== S || e.id !== checkpoint.id || e.by !== checkpoint.by || e.at !== checkpoint.at)
        throw fail("bad-checkpoint", `the checkpoint at ${S} doesn't match the log`);
      room.load(checkpoint);
      room.base = checkpoint;
    }
    let next = S + 1;
    for (const e of entries) {
      if (e && e.seq <= S && next === S + 1) continue;   // the checkpoint already covers it
      if (!e) throw fail("corrupt-log", `the log of ${room.board} holds an empty entry`);
      if (e.seq !== next || e.board !== room.board || e.tenant !== room.tenant) throw fail("corrupt-log", `the log of ${room.board} breaks at seq ${next}`);
      room.applyEntry(e); room.tail.push(e); room.tailChars += chars(e.op);
      next++;
    }
    room.resolved = room.seq; room.resolvedHorizon = room.horizon;
    return room;
  }

  /**
   * Rebuild from a synchronous log (MemoryLog): the latest checkpoint that matches the log, then the
   * entries after it. A server with async ports reads the same things itself and calls Room.rebuild.
   * Without an `epoch` it opens the log's next one (MemoryLog.openEpoch), as a host would before building.
   */
  static fromLog(opts) {
    const report = opts.report ?? (() => {});
    if (opts.epoch === undefined && typeof opts.log.openEpoch === "function") opts = { ...opts, epoch: opts.log.openEpoch() };
    for (let before = Infinity; ;) {
      const cp = opts.log.getCheckpoint?.(before) ?? null;
      try { return Room.rebuild({ ...opts, checkpoint: cp, entries: opts.log.read(cp && cp.seq > 0 ? cp.seq : 1) }); }
      catch (err) {
        if (err.code !== "bad-checkpoint" || !cp) throw err;
        report("bad-checkpoint", { board: opts.board, seq: cp.seq, message: err.message });
        before = cp.seq;
      }
    }
  }

  /**
   * Fold the resolved state into a checkpoint: it becomes the base of the kept tail (clients older than
   * it get a snapshot instead of every entry) and is handed to the log to keep. The copy is taken now;
   * the write may finish later. Returns the checkpoint.
   */
  checkpoint() {
    if (this.stopped) return null;
    let cp;
    if (this.seq === this.resolved) cp = this.fold();
    else {   // unresolved entries are merged into the live state: replay the resolved ones apart from it
      const r = new Room({ board: this.board, tenant: this.tenant, log: null, now: this.now, epoch: this.epoch, rules: this.rules, auto: false });
      r.load(this.base);
      for (const e of this.tail) r.applyEntry(e);
      cp = r.fold();
    }
    this.base = cp; this.tail = []; this.tailChars = 0;
    try {
      const put = this.log?.putCheckpoint?.(cp);
      if (put && typeof put.then === "function") put.then(null, err => this.report("checkpoint-failed", { board: this.board, seq: cp.seq, err }));
    } catch (err) { this.report("checkpoint-failed", { board: this.board, seq: cp.seq, err }); }
    return cp;
  }

  // ---- connections ----

  /**
   * A connection opens; `send` delivers a message to it. Returns the connection to pass to receive().
   * A host with gateways names each one (`gateway`) and the connection's id on it (`id`), for listed() and sweep().
   */
  connect(send, { gateway = null, id = null } = {}) {
    const c = { send, gateway, id, user: null, role: null, client: null, name: null, n: 0, closed: false };
    this.conns.add(c);
    if (gateway !== null) this.heard.set(gateway, this.now());
    return c;
  }
  /**
   * The `.entries` heartbeat (§ Bus): the resolved seq and this incarnation's epoch. A room host publishes it
   * every 2 s; gateways use the epoch for viewers' welcomes.
   */
  heartbeat() { return { seq: this.resolved, epoch: this.epoch }; }

  /** The close notice (rule 6): the connection is gone, and so is what the room kept for it. */
  disconnect(c) { if (c) { c.closed = true; this.conns.delete(c); } }

  /** A gateway's list of its open writer connections on this board: its other connections are closed (a lost close notice). */
  listed(gateway, ids) {
    this.heard.set(gateway, this.now());
    const open = new Set(ids);
    for (const c of this.conns) if (c.gateway === gateway && !open.has(c.id)) this.disconnect(c);
  }

  /**
   * Timed rules, by the injected clock (a host calls this now and then; the room starts no timer):
   * a gateway silent for 30 s loses all its connections, and an append in flight for 4 s has failed.
   */
  sweep() {
    const t = this.now();
    for (const [gateway, at] of this.heard) if (t - at >= GATEWAY_SILENCE_MS) {
      this.heard.delete(gateway);
      for (const c of this.conns) if (c.gateway === gateway) this.disconnect(c);
    }
    if (this.inflight && t - this.inflightAt >= APPEND_TIMEOUT_MS) this.fail(fail("timeout", "the store did not answer in time"));
  }

  /**
   * One message from a connection. `meta` is what the gateway adds: `n`, the message's number on that
   * connection (1, 2, …; a gap means one was lost, rule 6), and for a hello the verified `{ user, role, name? }`.
   */
  receive(c, msg, meta = {}) {
    const id = msg && typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {};
    const unavailable = message => c.send({ t: "error", ...id, code: "unavailable", message });
    // After a rebuild or a takeover a room knows no connection, whatever `n` says: never accept its ops.
    if (!this.conns.has(c)) return unavailable("this room has not welcomed that connection: reconnect");
    if (c.gateway !== null) this.heard.set(c.gateway, this.now());
    if (meta.n !== undefined) {
      if (meta.n !== c.n + 1) { unavailable("a message was lost on the way in: reconnect"); return this.disconnect(c); }
      c.n = meta.n;
    }
    if (this.stopped) return unavailable("the board is restarting: reconnect");
    if (!msg || typeof msg !== "object") return c.send({ t: "error", code: "bad-op", message: "a message is an object" });
    if (msg.t === "hello") return this.hello(c, msg, meta);
    if (!c.user) { if (msg.t !== "presence") c.send({ t: "error", ...id, code: "auth", message: "say hello first" }); return; }
    if (msg.t === "op") return this.op(c, msg);
    if (msg.t === "presence") return c.send({ t: "error", code: "bad-op", message: "presence goes through the gateway, never the room" });
    c.send({ t: "error", ...id, code: "bad-op", message: `unknown message ${JSON.stringify(String(msg.t).slice(0, 32))}` });
  }

  hello(c, msg, who) {
    const refuse = (code, message) => { c.send({ t: "error", code, message }); this.disconnect(c); };
    if (c.user) return refuse("bad-op", "one hello per connection");
    if (msg.v !== PROTOCOL_VERSION) return refuse("version", `this room speaks protocol ${PROTOCOL_VERSION}`);
    if (msg.board !== this.board) return refuse("auth", "this is another board");
    if (!who || typeof who.user !== "string" || !who.user || !ROLES.includes(who.role)) return refuse("auth", "not signed in to this board");
    if (typeof msg.client !== "string" || !msg.client || msg.client.length > MAX_CLIENT_CHARS || msg.client.includes(":"))
      return refuse("bad-op", "hello needs a client id (no colon)");
    Object.assign(c, { user: who.user, role: who.role, client: msg.client, name: typeof who.name === "string" ? who.name.slice(0, MAX_NAME_CHARS) : null });
    const key = keyOf(c.user, c.client), waiting = this.unresolved.get(key);
    c.send({
      t: "welcome", seq: this.resolved, role: c.role, user: c.user,
      ...(c.role === "viewer" ? {} : { high: waiting ? waiting.high : this.clients.get(key)?.high ?? 0 }),
      horizon: this.resolvedHorizon, rv: RULES_VERSION, room: { board: this.board, epoch: this.epoch },
    });
    for (const m of this.catchUp(Number.isSafeInteger(msg.since) && msg.since > 0 ? msg.since : 0)) c.send(m);
  }

  /** Rule 3: the entries after `since`, or a snapshot first when the kept tail no longer reaches back that far. */
  catchUp(since) { return catchUp(this.base, this.tail, since); }

  // ---- ops ----

  // Send now, or once every entry the answer depended on has resolved (§ Recovery): `until` is a seq.
  answer(c, m, until = 0) {
    if (until > this.resolved) this.held.push({ c, m, until });
    else if (!c.closed) c.send(m);
  }

  op(c, msg) {
    const id = typeof msg.id === "string" ? { id: msg.id.slice(0, 256) } : {};
    // A refusal that read the board's state waits for the unresolved entries it may have read (`this.seq`).
    const refuse = (why, until = 0) => this.answer(c, { t: "error", ...id, code: why.code, message: why.message }, until);
    const no = (code, message) => ({ code, message });

    const problem = opProblem(msg);
    if (problem) return refuse(problem);
    // Op ids are "client:counter" under this connection's own client id, and dedupe is per user, so no one
    // can suppress another person's op by sending its id first.
    const { client, counter } = parseOpId(msg.id);
    if (client !== c.client) return refuse(no("bad-op", "op ids start with your client id"));
    if (!canWrite(c.role, msg.stream)) return refuse(no("forbidden", `${c.role} can't write to ${msg.stream}`));

    // The op-id table (§ Op ids): a resend is answered here, before content checks and limits.
    const key = keyOf(c.user, client), rec = this.clients.get(key);
    const stale = no("stale", "that op is older than this room remembers; it was not logged now");
    if (!rec && msg.sentAt < this.horizon) return refuse(stale, this.seq);
    if (rec) {
      const pair = rec.recent.find(p => p[0] === counter);
      if (pair) return this.answer(c, { t: "ack", id: msg.id, seq: pair[1] }, pair[1]);   // never acks early
      if (counter <= rec.high) return refuse(stale, this.seq);
    }

    const mod = canModerate(c.role);
    if (msg.stream === "records") {
      const why = this.records.check(msg.op, c.user, c.role);
      if (why) return refuse(why, this.seq);
    } else {
      // A stream's settings (its layers) are the moderators': annotators add notes only.
      if (msg.op.appState && !mod) return refuse(no("forbidden", "only owners and editors change settings"));
      // § Settings (compare-and-set), after the op-id table: every key's base must be its appSeq in the
      // speculative state, or the whole op is refused and nothing is logged. A soft refusal, held like the others.
      if (msg.op.appState) {
        const seqs = this.appSeq[msg.stream];
        for (const k of Object.keys(msg.op.appState)) if (msg.op.appBase[k] !== (seqs[k] ?? 0))
          return refuse(no("stale-setting", `${k} changed since your copy (appSeq ${seqs[k] ?? 0}, your base ${msg.op.appBase[k]}): re-read it`), this.seq);
      }
      const doc = this.streams[msg.stream], cap = CAPS[msg.stream], fresh = new Set();
      let size = this.chars[msg.stream];
      for (const el of msg.op.elements ?? []) {
        const cur = doc.getAny(el.id);
        if (el.version > (cur?.version ?? 0) + MAX_VERSION_JUMP) return refuse(no("bad-op", `version of ${el.id} jumps too far`), this.seq);
        // Annotators change only the notes they made; owners and editors moderate everyone's.
        const author = msg.stream === "notes" && this.noteAuthor.get(el.id);
        if (author && author !== c.user && !mod) return refuse(no("forbidden", "that note is someone else's"), this.seq);
        if (!cur) fresh.add(el.id);
        if (wins(el, cur)) size += chars(el) - (cur ? chars(cur) : 0);
      }
      if (fresh.size && doc.byId.size + fresh.size > cap.ids) return refuse(no("limit", `${msg.stream} holds at most ${cap.ids} elements`), this.seq);
      if (size > this.chars[msg.stream] && size > cap.chars) return refuse(no("limit", `${msg.stream} is full`), this.seq);
    }

    const entry = { seq: this.seq + 1, board: this.board, tenant: this.tenant, stream: msg.stream, op: msg.op, by: c.user, id: msg.id, at: this.now(), rv: RULES_VERSION };
    if (msg.stream === "records") entry.name = c.name;   // the author's name when it was written (§ Records)
    const waiting = this.unresolved.get(key) ?? { n: 0, high: rec ? rec.high : 0 };
    waiting.n++; this.unresolved.set(key, waiting);
    this.applyEntry(entry);
    this.queue.push({ entry, c, key, counter, horizon: this.horizon });
    this.pump();
  }

  // One append in flight at a time; what was accepted meanwhile goes in the next one (a group commit).
  // The log may answer at once (MemoryLog) or with a promise (a real store): the same path either way.
  pump() {
    if (this.inflight || !this.queue.length || this.stopped) return;
    const batch = this.inflight = this.queue; this.queue = [];
    this.inflightAt = this.now();
    let done;
    try { done = this.log.append(batch.map(b => b.entry), this.resolved); }
    catch (err) { return this.fail(err); }
    if (done && typeof done.then === "function") done.then(() => this.landed(batch), err => this.fail(err));
    else this.landed(batch);
  }

  // The append resolved: its entries are durable. They move to resolved, are acked and broadcast, in seq order.
  landed(batch) {
    if (this.stopped || this.inflight !== batch) return;
    this.inflight = null;
    const entries = [];
    for (const b of batch) {
      this.resolved = b.entry.seq; this.resolvedHorizon = b.horizon;
      this.tail.push(b.entry); this.tailChars += chars(b.entry.op); entries.push(b.entry);
      const waiting = this.unresolved.get(b.key);
      if (--waiting.n === 0) this.unresolved.delete(b.key); else waiting.high = b.counter;
      if (!b.c.closed) b.c.send({ t: "ack", id: b.entry.id, seq: b.entry.seq });
    }
    const live = { t: "entries", entries };
    for (const o of this.conns) if (o.user) o.send(live);
    if (this.held.length) {
      const held = this.held; this.held = [];
      for (const h of held) this.answer(h.c, h.m, h.until);
    }
    // § Recovery, "When": every 1,000 entries, but not before the log since the last checkpoint is half its size.
    if (this.auto && this.resolved - this.base.seq >= CHECKPOINT_EVERY && this.tailChars * 2 >= this.chars.board + this.chars.notes + this.records.chars) this.checkpoint();
    this.pump();
  }

  /**
   * An append failed, conflicted or timed out (the host calls this for a timeout): stop sequencing. Nothing
   * unresolved is acked; everyone waiting hears `unavailable` and keeps their ops. The host then rebuilds a
   * new room from the Store, which settles whether the entries landed. A room never reuses a seq.
   */
  fail(err) {
    if (this.stopped) return;
    this.stopped = true; this.failure = err;
    const tell = (c, id) => { if (!c.closed) c.send({ t: "error", ...(id !== undefined ? { id } : {}), code: "unavailable", message: "the board is restarting: reconnect" }); };
    for (const b of [...(this.inflight ?? []), ...this.queue]) tell(b.c, b.entry.id);
    for (const h of this.held) tell(h.c, h.m.id);
    this.inflight = null; this.queue = []; this.held = [];
    this.report("stopped", { board: this.board, seq: this.resolved, err });
  }
}
