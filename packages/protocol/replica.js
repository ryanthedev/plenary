// A client's copy of a board (PROTOCOL.md v1): applies the room's entries in seq order, whatever order they
// arrive in, and shows its own ops at once (optimistic) until the room acknowledges them.
// Runs in a browser, a phone, Node or a Herdr pane: imports only the core's model and merge rules.
//
// How a caller drives it (the Replica never touches a socket or a timer; the clock is passed in):
//   1. On every new connection: send connectMessages(token, board) (the hello, nothing else).
//   2. Give every message from the server to receive(msg). It returns what it applied.
//   3. A local change: local(stream, op). Do NOT send what it returns yourself.
//   4. After each of 1–3, and when a timer set from wait() fires: send everything outgoing() returns.
//      outgoing() holds ops back until `welcome`, holds new ops until catch-up is done, sends each op once
//      per connection and paces them to the published rate (rule 2, § Limits).
//   5. When `resync` is set: close the connection, wait reconnectWait() ms, open a new one, start again
//      at 1. It is set by a refused op (the copy was reset: since 0), by `unavailable`, and by the
//      timeouts of rules 2 and 12 (no welcome, no catch-up progress, or no answer to an op for 10 s).
//      `stopped` ("version"): the app must update. `needAuth`: sign in again first.

import { Doc } from "../core/doc.js";
import { emptyScene, clone, randomInt } from "../core/model.js";
import { ELEMENT_STREAMS, PROTOCOL_VERSION, RULES, OP_RATE, OP_TIMEOUT_MS, CONNECT_TIMEOUT_MS, BACKOFF, mergeAppState } from "./envelope.js";
import { Records } from "./records.js";
import { PREVIEW_TTL_MS } from "./presence.js";

export class Replica {
  /** @param {{ client: string, now?: () => number, random?: () => number }} o — a name for this client (each
   *  Replica adds its own session part, so a reloaded page reusing the name never collides with its old op
   *  ids), a clock in ms, and a random source in [0, 1) for the backoff's jitter. */
  constructor({ client, now = Date.now, random = Math.random }) {
    this.client = `${client}.${Math.floor(Math.random() * 2 ** 31).toString(36)}`; this.counter = 0;
    this.now = now; this.random = random;
    this.fails = 0;             // failed connections in a row (rule 12); back to 0 once caught up
    this.helloAt = null; this.progressAt = null;
    this.pending = new Map();   // op id → { stream, op, msg, ackSeq?, wrote, answered, resend }: kept across resets and connections
    this.tokens = OP_RATE.burst; this.tokensAt = now();   // the send pace: a bucket of OP_RATE
    this.unconfirmed = 0;       // ops dropped without knowing whether they landed (the UI says so after the resync)
    this.user = null; this.role = null;
    this.stopped = null; this.needAuth = false; this.resync = false;
    this.welcomed = false; this.target = null; this.horizon = 0; this.staleSeen = false;
    this.reset();
  }

  /** Forget the room's copy (a resync follows). Pending ops are kept, and stay shown on top of the empty copy. */
  reset() {
    this.applied = 0;                    // the highest seq applied; everything up to it is in
    this.streams = {}; this.confirmed = {}; this.appSeq = {};
    for (const s of ELEMENT_STREAMS) {
      this.streams[s] = new Doc(emptyScene());
      this.confirmed[s] = { ...this.streams[s].appState.herdr };   // appState as the room ordered it
      this.appSeq[s] = {};
    }
    this.confirmedRecords = new Records();   // comments and reactions as the room ordered them
    this.noteAuthor = new Map();         // notes element id → who made it (which notes an annotator may change)
    this.buffer = new Map();             // seq → entry, arrived ahead of a gap
    this.previews = new Map();           // element id → others' in-flight preview (display only)
    this.previewOf = new Map();          // element id → { user, client, at }
    this.overlay();
  }

  // Pending ops on top of the room's copy.
  overlay() {
    this.restampAll();
    for (const s of ELEMENT_STREAMS) this.showAppState(s);
    this.recordsRev = (this.recordsRev ?? 0) + 1;
  }

  /** The hello for a new connection. Unacknowledged ops follow through outgoing(), once welcomed. */
  connectMessages(token, board) {
    // A stale op was dropped but the copy still shows it (the connection ended before the resync): start from 0.
    if (this.staleSeen) { this.staleSeen = false; this.reset(); }
    this.resync = false; this.needAuth = false; this.welcomed = false; this.target = null;
    this.helloAt = this.now(); this.progressAt = null;
    for (const p of this.pending.values()) { p.wrote = null; p.answered = false; p.resend = p.msg.sentAt !== undefined; }
    return [{ t: "hello", v: PROTOCOL_VERSION, token, board, since: this.applied, client: this.client }];
  }

  /**
   * A local change: shown now, queued for the room (send it with outgoing()). On an element stream every
   * element goes out one version past the highest this replica knows for its id (confirmed or pending),
   * with a fresh versionNonce, so an editor's per-move version bumps never reach the wire. The returned
   * message holds the elements as sent.
   */
  local(stream, op) {
    const records = stream === "records";
    if (!records && !ELEMENT_STREAMS.includes(stream)) throw new Error(`unknown stream ${stream}`);
    const mine = clone(op);
    if (!records) {
      const doc = this.streams[stream];
      for (const el of mine.elements ?? []) {
        el.version = (doc.getAny(el.id)?.version ?? 0) + 1; el.versionNonce = randomInt();
        doc.apply({ elements: [el] });
      }
    }
    const msg = { t: "op", id: `${this.client}:${++this.counter}`, stream, op: mine };
    this.pending.set(msg.id, { stream, op: mine, msg, wrote: null, answered: false, resend: false });
    if (records) this.recordsRev++; else this.showAppState(stream);
    return msg;
  }

  // The last pending element per stream and id: the one this replica's own edits end on.
  tops() {
    const tops = new Map();
    for (const p of this.pending.values()) if (p.stream !== "records") for (const el of p.op.elements ?? []) tops.set(`${p.stream}\n${el.id}`, el);
    return tops;
  }

  // Put a pending element op on top of the copy as it is now. Where someone else's copy leads instead of
  // this replica's own pending edits, an op that has never been sent is stamped again: one version past
  // the copy, fresh nonce (the pending edits after it follow, in order). So an edit made while the copy was
  // empty (mid-resync) or behind never goes out at a stale version and gets acked dead. An op already sent
  // keeps its bytes (a resend is the same op: rule 2).
  restamp(p, tops = this.tops()) {
    if (p.stream === "records" || !p.op.elements) return;
    const doc = this.streams[p.stream], unsent = p.msg.sentAt === undefined;
    for (const el of p.op.elements) {
      const cur = doc.getAny(el.id), top = tops.get(`${p.stream}\n${el.id}`);
      if (cur && top && cur.version === top.version && cur.versionNonce === top.versionNonce) continue;   // my edits lead already
      if (unsent && cur && cur.version >= el.version) { el.version = cur.version + 1; el.versionNonce = randomInt(); }
      doc.apply({ elements: [el] });
    }
  }

  restampAll(only = () => true) {
    const tops = this.tops();
    for (const p of this.pending.values()) if (only(p)) this.restamp(p, tops);
  }

  /** Does this replica hold an unacknowledged op for that element? */
  hasPending(stream, id) {
    for (const p of this.pending.values()) if (p.stream === stream && p.op.elements?.some(el => el.id === id)) return true;
    return false;
  }

  /**
   * For an editor that keeps its own copy of a stream: which of its elements must give way to this
   * replica's? An element whose version is ahead of the replica's with no pending op for it was never
   * sent (a cancelled drag bumped it), so the replica's copy wins, or peers' edits would stop applying.
   * Returns, per such element, the replica's copy to put back (a clone), or `{ id, gone: true }` when the
   * replica has none.
   */
  reconcile(stream, elements) {
    const doc = this.streams[stream], out = [];
    for (const el of elements) {
      const mine = doc.getAny(el.id);
      if ((el.version ?? 0) <= (mine?.version ?? 0) || this.hasPending(stream, el.id)) continue;
      out.push(mine ? clone(mine) : { id: el.id, gone: true });
    }
    return out;
  }

  /** A drag or resize in flight, for others to see: presence, never an op (no counter used, never logged). */
  preview(stream, elements) { return { t: "presence", k: "preview", stream, elements: clone(elements) }; }

  refill(t) {
    if (t > this.tokensAt) this.tokens = Math.min(OP_RATE.burst, this.tokens + (t - this.tokensAt) * OP_RATE.perSecond / 1000);
    this.tokensAt = t;
  }

  // The first op not yet written on this connection, if it may go now (a resend, or caught up).
  nextToSend() {
    for (const p of this.pending.values()) {
      if (p.wrote !== null) continue;
      return p.msg.sentAt !== undefined || this.applied >= this.target ? p : null;
    }
    return null;
  }

  /**
   * The ops to write to the connection now, oldest first. Resends go right after `welcome`; an op never
   * sent waits until this copy has applied `welcome.seq` (its `sentAt` is the seq applied when it first
   * goes). Each op is written once per connection; if one gets no answer for 10 s, `resync` is set.
   */
  outgoing() {
    if (this.stopped || this.resync || this.needAuth || this.helloAt === null) return [];   // after `auth`: nothing until signed in again
    const t = this.now(), out = [];
    if (this.overdue(t)) { this.fails++; this.resync = true; return []; }
    if (!this.welcomed) return [];
    this.refill(t);
    for (let p; this.tokens >= 1 && (p = this.nextToSend());) {
      this.tokens -= 1;
      if (p.msg.sentAt === undefined) { this.restamp(p); p.msg.sentAt = this.applied; }
      p.wrote = t; out.push(p.msg);
    }
    return out;
  }

  // Rules 2 and 12: no welcome, no catch-up progress, or no answer to a written op, for 10 s.
  overdue(t) { const left = this.timeLeft(t); return left !== null && left <= 0; }
  timeLeft(t) {
    if (!this.welcomed) return this.helloAt + CONNECT_TIMEOUT_MS - t;
    let left = this.applied < this.target ? this.progressAt + CONNECT_TIMEOUT_MS - t : null;
    for (const p of this.pending.values()) if (p.wrote !== null && !p.answered) { const mine = p.wrote + OP_TIMEOUT_MS - t; left = left === null ? mine : Math.min(left, mine); }
    return left;
  }

  /** ms to wait before opening the next connection (rule 12): min(30 s, 0.5 s × 2^k) × a random factor in [0.5, 1). */
  reconnectWait() { return Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.min(this.fails, 16)) * (0.5 + this.random() / 2); }

  /** ms until the pace lets the next waiting op go (0 = now), or null if none is waiting on the pace. */
  paceWait() {
    if (this.stopped || !this.welcomed || this.resync || this.needAuth || !this.nextToSend()) return null;
    this.refill(this.now());
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * 1000 / OP_RATE.perSecond);
  }

  /** ms until outgoing() is worth calling again (the pace, or the 10 s answer timeout), or null. */
  wait() {
    if (this.stopped || this.resync || this.needAuth || this.helloAt === null) return null;
    const pace = this.paceWait(), left = this.timeLeft(this.now());
    if (left === null) return pace;
    return pace === null ? Math.max(0, left) : Math.min(pace, Math.max(0, left));
  }

  /**
   * A message from the server. Returns what it did to this copy:
   * `entries` applied (in seq order), `snapshot` loaded, `reset` (the copy was discarded: reconnect),
   * `settled` op ids (confirmed) and `dropped` op ids (refused, stale or unconfirmable).
   */
  receive(msg) {
    const did = { entries: [], snapshot: false, reset: false, settled: [], dropped: [] };
    if (!msg || this.stopped) return did;
    if (msg.t === "snapshot" || msg.t === "entries") this.progressAt = this.now();
    if (msg.t === "welcome") this.welcome(msg, did);
    else if (msg.t === "snapshot") this.snapshot(msg, did);
    else if (msg.t === "entries") {
      for (const e of msg.entries ?? []) if (e.seq > this.applied && !this.buffer.has(e.seq)) this.buffer.set(e.seq, e);
      this.drain(did);
    } else if (msg.t === "ack") {
      const p = this.pending.get(msg.id);
      if (p) { p.ackSeq = msg.seq; p.answered = true; this.settle(did); this.afterAnswers(did); }
    } else if (msg.t === "presence") this.presence(msg);
    else if (msg.t === "error") this.error(msg, did);
    return did;
  }

  welcome(msg, did) {
    if (this.welcomed) return;   // one welcome per connection; a repeat changes nothing
    if (msg.rv !== undefined && !RULES[msg.rv]) { this.stopped = "version"; return; }
    // Rule 13: pending ops belong to the user who made them. Someone else signed in: drop them, say how many.
    const other = this.user !== null && this.user !== msg.user;
    if (other) for (const id of [...this.pending.keys()]) { this.pending.delete(id); did.dropped.push(id); }
    this.welcomed = true; this.role = msg.role; this.user = msg.user; this.target = msg.seq; this.horizon = msg.horizon ?? 0;
    this.progressAt = this.now();
    if (this.applied >= this.target) this.fails = 0;
    if (other) { if (did.dropped.length) { this.discarded = (this.discarded ?? 0) + did.dropped.length; this.discard(did); } return; }
    // The room has forgotten this client (§ Op ids): ops sent before its horizon may or may not have been
    // logged, and the room would answer `stale`. Drop them now, and start over from the room's copy.
    if (msg.high === 0) for (const [id, p] of this.pending) if (p.msg.sentAt !== undefined && p.msg.sentAt < this.horizon) { this.pending.delete(id); did.dropped.push(id); }
    if (did.dropped.length) this.discard(did, did.dropped.length);
  }

  // Rule 5: throw the copy away and ask for a fresh connection with since 0.
  discard(did, unconfirmed = 0) { this.unconfirmed += unconfirmed; this.reset(); did.reset = true; this.resync = true; }

  snapshot(msg, did) {
    if (msg.seq <= this.applied) return;
    for (const s of ELEMENT_STREAMS) {
      const sc = msg.streams[s], doc = this.streams[s];
      doc.load({ elements: clone(sc.elements), appState: clone(sc.appState) });
      this.confirmed[s] = { ...doc.appState.herdr };
      this.appSeq[s] = { ...(msg.appSeq?.[s] ?? {}) };
    }
    this.confirmedRecords = new Records(msg.records);
    this.noteAuthor = new Map(msg.noteAuthor ?? []);
    this.applied = msg.seq; did.snapshot = true;
    for (const k of [...this.buffer.keys()]) if (k <= this.applied) this.buffer.delete(k);
    this.overlay();
    this.drain(did);
  }

  drain(did) {
    while (this.buffer.has(this.applied + 1)) {
      const e = this.buffer.get(this.applied + 1); this.buffer.delete(e.seq);
      if (e.rv !== undefined && !RULES[e.rv]) { this.stopped = "version"; return; }   // rules this app doesn't know
      if (e.stream === "records") { this.confirmedRecords.apply(e.op, e.by, e.at, e.name ?? null); this.recordsRev++; }
      else if (this.streams[e.stream]) {
        for (const el of e.op.elements ?? []) {
          this.previews.delete(el.id); this.previewOf.delete(el.id);
          if (e.stream === "notes" && !this.noteAuthor.has(el.id)) this.noteAuthor.set(el.id, e.by);
        }
        if (e.op.elements) this.streams[e.stream].apply({ elements: e.op.elements });
        if (e.op.appState) mergeAppState(this.confirmed[e.stream], this.appSeq[e.stream], e.op.appState, e.seq);
      }
      this.applied = e.seq;
      // Rule 4: an applied entry with one of my pending ids, made by me, settles that op, ack or not.
      if (e.by === this.user && this.pending.delete(e.id)) { did.settled.push(e.id); this.recordsRev++; }
      if (this.streams[e.stream]) this.showAppState(e.stream);
      did.entries.push(e);
    }
    if (did.entries.length && this.pending.size) this.restampAll(p => p.msg.sentAt === undefined);
    if (this.welcomed && this.applied >= this.target) this.fails = 0;   // caught up: the connection is good
    this.settle(did);
    this.afterAnswers(did);   // an applied entry answers a resend as well as an ack does
  }

  // An acknowledged op whose entry is applied (or covered by a snapshot) is no longer pending.
  settle(did) {
    let any = false;
    for (const [id, p] of this.pending) if (p.ackSeq && p.ackSeq <= this.applied) { this.pending.delete(id); did.settled.push(id); any = true; }
    if (any) { for (const s of ELEMENT_STREAMS) this.showAppState(s); this.recordsRev++; }
  }

  error(msg, did) {
    if (msg.code === "version") { this.stopped = "version"; return; }
    if (msg.code === "unavailable") { if (!this.resync) this.fails++; this.resync = true; return; }   // not a refusal: every pending op is kept
    if (msg.code === "auth") { this.needAuth = true; return; }        // kept too; sign in again, then reconnect
    const p = msg.id !== undefined ? this.pending.get(msg.id) : null;
    if (!p) return;
    this.pending.delete(msg.id); did.dropped.push(msg.id);
    if (msg.code === "stale") { this.staleSeen = true; this.unconfirmed++; this.afterAnswers(did); }
    // Records apply in seq order, so the confirmed copy is already right: the op just leaves the overlay.
    else if (p.stream === "records") { this.recordsRev++; this.afterAnswers(did); }
    else this.discard(did);       // rule 5: a refused element op was already shown here
  }

  // § Op ids, "Client on stale": once every resend is answered, if any was stale, resync once.
  afterAnswers(did) {
    if (!this.staleSeen || this.resync) return;
    for (const p of this.pending.values()) if (p.resend && !p.answered) return;
    this.staleSeen = false; this.discard(did);
  }

  // Previews are shown over the board, never merged into it: a preview may tie with the final op on
  // version and win on the tie-break.
  presence(msg) {
    const t = this.now();
    for (const m of msg.batch ?? []) {
      if (m.k === "preview") for (const el of m.elements ?? []) { this.previews.set(el.id, el); this.previewOf.set(el.id, { user: m.user, client: m.client, at: t }); }
      else if (m.k === "leave") for (const [id, o] of this.previewOf) if (o.user === m.user && o.client === m.client) { this.previews.delete(id); this.previewOf.delete(id); }
    }
  }

  /** Drop previews not updated for 5 s (§ Presence). Call it from the render loop. */
  prunePreviews() {
    const t = this.now();
    for (const [id, o] of this.previewOf) if (t - o.at >= PREVIEW_TTL_MS) { this.previews.delete(id); this.previewOf.delete(id); }
  }

  // Shown appState = the room's order, with this client's unacknowledged patches on top.
  showAppState(stream) {
    const doc = this.streams[stream], next = { ...this.confirmed[stream] };
    for (const p of this.pending.values()) if (p.stream === stream && p.op.appState) Object.assign(next, p.op.appState);
    doc.appState.herdr = next; doc.rev++; doc._sorted = null;
  }

  /** Comments and reactions to show: the room's, with this client's unacknowledged actions on top (snapshot shape). */
  recordsState() {
    if (this.recordsShown?.rev === this.recordsRev) return this.recordsShown.data;
    const shown = new Records(this.confirmedRecords.toJSON()), t = this.now();
    for (const p of this.pending.values()) if (p.stream === "records") shown.apply(p.op, this.user, t, null);
    this.recordsShown = { rev: this.recordsRev, data: shown.toJSON() };
    return this.recordsShown.data;
  }

  /** The board as data, for comparing copies: elements by id, appState, the seq it's at. */
  state() {
    const out = { applied: this.applied };
    for (const s of ELEMENT_STREAMS) { const d = this.streams[s]; out[s] = { elements: [...d.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), appState: d.appState.herdr }; }
    return out;
  }
}
