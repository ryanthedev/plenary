// A client's copy of a board (PROTOCOL.md v1.1): applies the room's entries in seq order, whatever order they
// arrive in, and shows its own ops at once (optimistic) until the room acknowledges them.
// Runs in a browser, a phone, Node or a Herdr pane: imports only the core's model and merge rules.
//
// How a caller drives it (the Replica never touches a socket or a timer; the clock is passed in):
//   1. On every new connection: send connectMessages(token, board) (the hello, nothing else).
//   2. Give every message from the server to receive(msg). It returns what it applied.
//   3. A local change: local(stream, op). Do NOT send what it returns yourself. A change with both elements
//      and settings goes out as two ops (elements first). Settings carry `appBase` and are sent one op per
//      (stream, key) at a time; later changes wait (`held`) and show at once. receive() reports refused
//      settings in `did.refusedSettings` and, once a refused key's conflict is applied here, `did.retryReady`.
//   4. After each of 1–3, and when a timer set from wait() fires: send everything outgoing() returns.
//      outgoing() holds ops back until `welcome`, holds new ops until catch-up is done, sends each op once
//      per connection and paces them to the published rate (rule 2, § Limits).
//   5. When `resync` is set: close the connection, wait reconnectWait() ms, open a new one, start again
//      at 1. It is set by a refused op (the copy was reset: since 0), by `unavailable`, and by the
//      timeouts of rules 2 and 12 (no welcome, no catch-up progress, or no answer to an op for 10 s).
//      `stopped` ("version"): the app must update. `needAuth`: sign in again first.

import { Doc } from "../core/doc.js";
import { emptyScene, clone, randomInt } from "../core/model.js";
import { ELEMENT_STREAMS, PROTOCOL_VERSION, RULES, OP_RATE, OP_TIMEOUT_MS, CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS, BACKOFF, mergeAppState, appBaseProblem, isTab } from "./envelope.js";
import { Records } from "./records.js";
import { PREVIEW_TTL_MS } from "./presence.js";

export class Replica {
  /** @param {{ client: string, tab?: string, session?: string, now?: () => number, random?: () => number, idleTimeoutMs?: number | null }} o — a name for this client (each
   *  Replica adds its own session part, so a reloaded page reusing the name never collides with its old op
   *  ids; pass `session` to supply one deterministically without Math.random), the browser tab it belongs to
   *  (sent as hello.tab, § Messages; omitted when not given), a clock in ms, and a random source in [0, 1) for
   *  the backoff's jitter. */
  constructor({ client, tab, session, now = Date.now, random = Math.random, idleTimeoutMs = null }) {
    if (tab !== undefined && !isTab(tab)) throw new Error("tab must match /^[A-Za-z0-9_-]{1,32}$/");
    if (session !== undefined && (typeof session !== "string" || !session || session.includes(":"))) throw new Error("session must be a non-empty string without ':'");
    this.tab = tab;
    this.client = `${client}.${session ?? Math.floor(Math.random() * 2 ** 31).toString(36)}`; this.counter = 0;
    this.now = now; this.random = random;
    this.idleTimeoutMs = idleTimeoutMs;   // explicit override (ms), or null to use ceil(2.5 * welcome.hb)
    this.hbTimeoutMs = 0;
    this.fails = 0;             // failed connections in a row (rule 12); back to 0 only after a proven connection
    this.goodAt = null;         // when this connection caught up to welcome.seq (null: not yet)
    this.wasProven = false;     // true when the connection that just ended proved itself (full jitter U(0, 5 s) on first retry)
    this.helloAt = null; this.progressAt = null; this.heardAt = null;
    this.pending = new Map();   // op id → { stream, op, msg, ackSeq?, wrote, answered, resend }: kept across resets and connections
    this.tokens = OP_RATE.burst; this.tokensAt = now();   // the send pace: a bucket of OP_RATE
    this.unconfirmed = 0;       // ops dropped without knowing whether they landed (the UI says so after the resync)
    this.user = null; this.role = null;
    this.stopped = null; this.needAuth = false; this.resync = false;
    this.welcomed = false; this.target = null; this.horizon = 0; this.staleSeen = false;
    this.board = null;          // the board of the current hello (welcome.room.board must match)
    this.early = [];            // entries and snapshots of this connection that arrived before its welcome
    this.epoch = null;          // the last welcome.room.epoch seen (viewers only record it)
    this.epochSeen = 0;         // the highest epoch seen in a writer's welcome (rule 12; kept across resets)
    // § Settings. Kept across resets and connections, like pending ops:
    this.held = {};             // stream → { key: value }: settings changes waiting for a key's op in flight (or its retry gate)
    this.floor = {};            // stream → { key: seq }: the seq of my latest acknowledged settings op per key
    this.gates = [];            // refused (stale-setting) ops: [{ id, stream, appBase }] until a key's confirmed appSeq passes its base
    this.seen = {};             // stream → { key: appSeq }: the newest confirmed appSeq per key, kept across resets (what the user saw)
    this.heldBase = {};         // stream → { key: base }: each held key's base, fixed when its latest change was made
    for (const s of ELEMENT_STREAMS) { this.held[s] = null; this.floor[s] = {}; this.seen[s] = {}; this.heldBase[s] = {}; }
    this.reset();
  }

  /** Forget the room's copy (a resync follows). Pending ops are kept, and stay shown on top of the empty copy. */
  reset() {
    // § Settings: a resync doesn't lower a key's base. Keep what this copy had confirmed before it goes.
    if (this.appSeq) for (const s of ELEMENT_STREAMS) for (const [k, v] of Object.entries(this.appSeq[s] ?? {})) if (v > (this.seen[s][k] ?? 0)) this.seen[s][k] = v;
    this.applied = 0;                    // the highest seq applied; everything up to it is in
    this.streams = {}; this.confirmed = {}; this.appSeq = {}; this.confirmedVersion = {};
    for (const s of ELEMENT_STREAMS) {
      this.confirmedVersion[s] = new Map();   // element id → the version of the room's copy (pending ops not counted)
      this.streams[s] = new Doc(emptyScene());
      this.confirmed[s] = { ...this.streams[s].appState.herdr };   // appState as the room ordered it
      this.appSeq[s] = {};
    }
    this.confirmedRecords = new Records();   // comments and reactions as the room ordered them
    this.noteAuthor = new Map();         // notes element id → who made it (which notes an annotator may change)
    this.buffer = new Map();             // seq → entry, arrived ahead of a gap
    this.previewBy = new Map();          // "stream\nid" → { stream, el, user, client, at }: others' in-flight previews (display only)
    this.previews = new Map();           // element id → element, every stream together (kept for callers that predate previewsOf)
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
    this.resync = false; this.needAuth = false; this.welcomed = false; this.target = null; this.board = board;
    this.early = [];   // entries and snapshots of this connection that arrived before its welcome
    this.proven();
    this.helloAt = this.now(); this.progressAt = null; this.heardAt = null; this.hbTimeoutMs = 0; this.wasProven = false; this.counted = false;
    for (const p of this.pending.values()) { p.wrote = null; p.answered = false; p.resend = p.msg.sentAt !== undefined; }
    const hello = { t: "hello", v: PROTOCOL_VERSION, token, board, since: this.applied, client: this.client };
    if (this.tab !== undefined) hello.tab = this.tab;
    return [hello];
  }

  /**
   * A local change: shown now, queued for the room (send it with outgoing()). On an element stream every
   * element goes out one version past the highest this replica knows for its id (confirmed or pending),
   * with a fresh versionNonce, so an editor's per-move version bumps never reach the wire.
   *
   * `keepVersions` (an import, drawh's seeding): elements go out with their own version and nonce, and are
   * never re-stamped, not even on a resync. Deciding which to renumber or hold back is the importer's job
   * (PROTOCOL.md § The element op, seeding; roomVersion() gives the confirmed copy's version).
   *
   * Settings (`appState`) never travel with elements: a mixed change becomes two ops, elements first. A
   * settings op carries `appBase` (each key's confirmed appSeq now, or my last acknowledged op's seq for it,
   * whichever is higher); any `appBase` passed in is ignored. While a key has an op in flight (sent or not,
   * no ack yet) or is waiting on a retry gate, changes to it are held, shown, and sent as one op later.
   *
   * Returns the elements op's message when there is one, else the settings op's; a held settings change
   * returns a stand-in `{ t: "op", id: null, held: true, stream, op }` (nothing to send).
   */
  local(stream, op, { keepVersions = false } = {}) {
    const records = stream === "records";
    if (!records && !ELEMENT_STREAMS.includes(stream)) throw new Error(`unknown stream ${stream}`);
    const mine = clone(op);
    if (records) { const msg = this.push(stream, mine); this.recordsRev++; return msg; }
    const { appState, appBase, ...rest } = mine;
    let out = null;
    if (rest.elements?.length || appState === undefined) {
      const doc = this.streams[stream];
      for (const el of rest.elements ?? []) {
        if (!keepVersions) { el.version = (doc.getAny(el.id)?.version ?? 0) + 1; el.versionNonce = randomInt(); }
        doc.apply({ elements: [el] });
      }
      out = this.push(stream, rest, keepVersions);
    }
    if (appState !== undefined) { const m = this.setting(stream, appState); out = out ?? m; }
    this.showAppState(stream);
    return out;
  }

  // A new op with the next counter, pending (outgoing() sends it). Counters rise in the order ops are made
  // and sent, so a held settings change gets its id only when it is released.
  push(stream, op, keep = false) {
    // A settings op always names a base for every key it sets (§ Settings); anything else is a bug here.
    if (op.appState !== undefined) { const why = appBaseProblem(op.appState, op.appBase); if (why) throw new Error(`replica built a bad settings op: ${why}`); }
    const msg = { t: "op", id: `${this.client}:${++this.counter}`, stream, op };
    this.pending.set(msg.id, { stream, op, msg, wrote: null, answered: false, resend: false, keep });
    return msg;
  }

  // A settings change: an op now, or held behind a busy key (one op in flight per (stream, key)). One
  // held patch per stream: a change that touches any busy key waits whole, and so does everything after it.
  setting(stream, patch) {
    const keys = Object.keys(patch);
    if (this.held[stream] || keys.some(k => this.busy(stream, k))) {
      this.held[stream] = { ...(this.held[stream] ?? {}), ...patch };
      // Fixed by the key's first held change: while held, the screen shows the held value, so a peer's entry
      // confirmed meanwhile was never seen and must not raise the base (§ Settings, "One in flight per key").
      for (const k of keys) if (!Object.prototype.hasOwnProperty.call(this.heldBase[stream], k)) this.heldBase[stream][k] = this.basesOf(stream, [k])[k];
      return { t: "op", id: null, held: true, stream, op: { appState: { ...patch } } };
    }
    return this.push(stream, { appState: patch, appBase: this.basesOf(stream, keys) });
  }

  /**
   * The appSeq a new settings op for these keys is based on: the newest this replica confirmed (kept across
   * resyncs), or my last acknowledged op's seq, whichever is higher.
   */
  basesOf(stream, keys) {
    const out = {};
    for (const k of keys) out[k] = Math.max(this.appSeq[stream][k] ?? 0, this.seen[stream][k] ?? 0, this.floor[stream][k] ?? 0);
    return out;
  }

  /** Is a settings key busy: an op of mine for it not yet acknowledged, or a refusal still waiting for its conflict? */
  busy(stream, key) {
    for (const p of this.pending.values()) if (p.stream === stream && p.op.appState && p.ackSeq === undefined && Object.prototype.hasOwnProperty.call(p.op.appState, key)) return true;
    return this.gates.some(g => g.stream === stream && Object.prototype.hasOwnProperty.call(g.appBase, key));
  }

  // Forget what this replica knew of the room's settings history (rule 13: another user; or the Store lost
  // entries). Held changes lose their base with it: they are dropped and reported (the app may retry), never
  // sent on a base they weren't made on (§ Settings, "Forgetting").
  forgetSettings(did, code) {
    for (const s of ELEMENT_STREAMS) {
      const h = this.held[s];
      if (h) {
        did.refusedSettings.push({ id: null, stream: s, code, appState: h, appBase: null, held: { ...h } });
        did.retryReady.push({ id: null, stream: s, keys: Object.keys(h) });
        this.held[s] = null; this.showAppState(s);
      }
      this.floor[s] = {}; this.seen[s] = {}; this.heldBase[s] = {};
    }
  }

  /** Held settings changes, per stream (null when none). */
  heldSettings() { const out = {}; for (const s of ELEMENT_STREAMS) out[s] = this.held[s] ? { ...this.held[s] } : null; return out; }

  // § Settings, "stale-setting is soft": a refused op's gate opens once the confirmed appSeq of any of its
  // keys has passed (is greater than) the refused base, so a retry never runs against an entry not yet applied.
  openGates(did) {
    for (let i = 0; i < this.gates.length; i++) {
      const g = this.gates[i], seqs = this.appSeq[g.stream];
      if (!Object.keys(g.appBase).some(k => (seqs[k] ?? 0) > g.appBase[k])) continue;
      this.gates.splice(i--, 1);
      did.retryReady.push({ id: g.id, stream: g.stream, keys: Object.keys(g.appBase) });
    }
  }

  // Held changes go out as one op once none of their keys is busy, and only on a connection that has
  // caught up (after a `stale`, only after the resync), so their base comes from the current copy.
  release() {
    if (this.stopped || this.resync || this.staleSeen || !this.welcomed || this.applied < this.target) return;
    for (const s of ELEMENT_STREAMS) {
      const h = this.held[s];
      if (!h || Object.keys(h).some(k => this.busy(s, k))) continue;
      this.held[s] = null;
      // The base was fixed when the value was made, raised only by my own preceding op on the key once it
      // settled (floor). Never the confirmed appSeq now: an entry applied since was hidden by the held value,
      // so the user never saw it, and overwriting it must be refused (§ Settings, "One in flight per key").
      const base = {};
      for (const k of Object.keys(h)) base[k] = Math.max(this.heldBase[s][k], this.floor[s][k] ?? 0);
      this.heldBase[s] = {};
      this.push(s, { appState: h, appBase: base });
      this.showAppState(s);
    }
  }

  // Put the pending element ops on top of the copy as it is now, and stamp again every op that has never
  // been sent: per element, with the room's version r (as this replica has confirmed it; 0 if it has none,
  // and never below a pending op of mine that was already sent), the unsent ops get r + 1, r + 2, … in send
  // order, each with a fresh nonce when its version changes. So an edit made while the copy was empty
  // (mid-resync) or behind never goes out at a version the room already passed, to be acked dead or lose
  // a tie a live client would win. An op already sent keeps its bytes (a resend is the same op: rule 2).
  restampAll() {
    const next = new Map();   // "stream\nid" → the highest version so far: the room's, then my pending ops in order
    for (const p of this.pending.values()) {
      if (p.stream === "records" || !p.op.elements) continue;
      // A kept-version op (an import) is never re-stamped: it is counted like one already sent.
      const doc = this.streams[p.stream], unsent = p.msg.sentAt === undefined && !p.keep;
      for (const el of p.op.elements) {
        const key = `${p.stream}\n${el.id}`, base = next.get(key) ?? this.roomVersion(p.stream, el.id);
        if (!unsent) { next.set(key, Math.max(base, el.version)); doc.apply({ elements: [el] }); continue; }
        if (el.version !== base + 1) { el.version = base + 1; el.versionNonce = randomInt(); }
        next.set(key, el.version);
        // It leads everything this replica knows; `force` only ever replaces an older stamp of my own.
        const cur = doc.getAny(el.id);
        if (!cur || cur.version !== el.version || cur.versionNonce !== el.versionNonce) doc.apply({ elements: [el] }, { force: true });
      }
    }
  }

  /** The version of the room's copy of an element as this replica has confirmed it (no pending ops counted); 0 if none. */
  roomVersion(stream, id) { return this.confirmedVersion[stream]?.get(id) ?? 0; }

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
    // A timeout means the server was silent for the timeout stretch: that stretch doesn't count as staying up.
    if (this.overdue(t)) {
      const idleDue = this.welcomed && this.applied >= this.target && this.hbTimeoutMs > 0 && this.heardAt !== null && this.heardAt + this.hbTimeoutMs <= t;
      this.failed(idleDue ? this.heardAt : t - CONNECT_TIMEOUT_MS);
      return [];
    }
    if (!this.welcomed) return [];
    this.refill(t);
    let stamped = false;
    for (let p; this.tokens >= 1 && (p = this.nextToSend());) {
      this.tokens -= 1;
      if (p.msg.sentAt === undefined) { if (!stamped) { this.restampAll(); stamped = true; } p.msg.sentAt = this.applied; }
      p.wrote = t; out.push(p.msg);
    }
    return out;
  }

  // Rules 2 and 12: no welcome, no catch-up progress, or no answer to a written op for 10 s; or live & idle for 25 s.
  overdue(t) { const left = this.timeLeft(t); return left !== null && left <= 0; }
  timeLeft(t) {
    if (!this.welcomed) return this.helloAt + CONNECT_TIMEOUT_MS - t;
    let left = this.applied < this.target
      ? this.progressAt + CONNECT_TIMEOUT_MS - t
      : (this.hbTimeoutMs > 0 && this.heardAt !== null ? this.heardAt + this.hbTimeoutMs - t : null);
    for (const p of this.pending.values()) if (p.wrote !== null && !p.answered) { const mine = p.wrote + OP_TIMEOUT_MS - t; left = left === null ? mine : Math.min(left, mine); }
    return left;
  }

  // This connection failed: one more toward the backoff (once per connection), and a new one is wanted.
  failed(upTo = this.now()) { if (!this.counted) { this.proven(upTo); this.counted = true; this.fails++; } this.resync = true; }

  // Rule 12: the count goes back to 0 only for a connection that proved itself: caught up to welcome.seq
  // and still connected 10 s later (`upTo`: when it stopped being good). Looked at when the next wait is
  // worked out, once per connection.
  proven(upTo = this.now()) {
    if (this.goodAt !== null && upTo - this.goodAt >= CONNECT_TIMEOUT_MS) { this.fails = 0; this.wasProven = true; }
    this.goodAt = null;
  }

  /**
   * The caller's socket closed or errored without the replica asking for it (`resync` was not set): a drop
   * before `welcome`, mid catch-up, or later. Counts toward the rule-12 backoff like a timeout does, once
   * per connection, and sets `resync`. Pending ops and the copy are kept. A close never resets the count,
   * clean or not, and neither does a welcome: only a connection that caught up and then stayed up 10 s
   * does, so a server that welcomes and then drops still meets growing waits. Don't call it for a close
   * the caller started itself.
   */
  connectionFailed() { if (this.helloAt !== null && !this.resync) this.failed(); this.helloAt = null; }

  /** ms to wait before opening the next connection (rule 12): U(0, 5 s) on the first retry after a proven link
   *  drops (spreads a gateway-restart herd); else min(30 s, 0.5 s × 2^k) × a random factor in [0.5, 1). */
  reconnectWait() {
    this.proven();
    if (this.wasProven && this.fails === 1) return this.random() * BACKOFF.firstJitterMs;
    return Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.min(this.fails, 16)) * (0.5 + this.random() / 2);
  }

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
    const did = { entries: [], snapshot: false, reset: false, settled: [], dropped: [], refusedSettings: [], retryReady: [] };
    if (!msg || this.stopped) return did;
    this.heardAt = this.now();
    if (msg.t === "snapshot" || msg.t === "entries") this.progressAt = this.heardAt;
    if ((msg.t === "snapshot" || msg.t === "entries") && !this.welcomed && this.helloAt !== null) { this.early.push(msg); return did; }
    if (msg.t === "welcome") {
      this.welcome(msg, did);
      // Entries that beat the welcome here (§ Recovery, Room identity) apply only now, after its checks.
      const early = this.early; this.early = [];
      if (this.welcomed && !this.resync && !this.stopped) for (const m of early) {
        if (m.t === "snapshot") this.snapshot(m, did);
        else { for (const e of m.entries ?? []) if (e.seq > this.applied && !this.buffer.has(e.seq)) this.buffer.set(e.seq, e); this.drain(did); }
      }
    }
    else if (msg.t === "snapshot") this.snapshot(msg, did);
    else if (msg.t === "entries") {
      for (const e of msg.entries ?? []) if (e.seq > this.applied && !this.buffer.has(e.seq)) this.buffer.set(e.seq, e);
      this.drain(did);
    } else if (msg.t === "ack") {
      const p = this.pending.get(msg.id);
      if (p) {
        p.ackSeq = msg.seq; p.answered = true;
        // The next op for these keys is based on this one (§ Settings, "One in flight per key").
        if (p.op.appState) for (const k of Object.keys(p.op.appState)) this.floor[p.stream][k] = Math.max(this.floor[p.stream][k] ?? 0, msg.seq);
        this.settle(did); this.afterAnswers(did); this.release();
      }
    } else if (msg.t === "presence") this.presence(msg);
    else if (msg.t === "error") this.error(msg, did);
    return did;
  }

  welcome(msg, did) {
    if (this.welcomed) return;   // one welcome per connection; a repeat changes nothing
    if (msg.rv !== undefined && !RULES[msg.rv]) { this.stopped = "version"; return; }
    this.hbTimeoutMs = this.idleTimeoutMs !== null ? this.idleTimeoutMs : (Number.isSafeInteger(msg.hb) && msg.hb > 0 ? Math.ceil(msg.hb * 2.5) : 0);
    // Rule 12 and § Recovery, Room identity. (A welcome with no `room` is from a pre-v1.1 server: not checked.)
    const room = msg.room;
    if (room && typeof room === "object") {
      if (room.board !== this.board) { this.failed(); return; }          // another board: close, reconnect
      if (msg.high !== undefined && Number.isSafeInteger(room.epoch)) {  // a writer's welcome, built by the room
        if (room.epoch < this.epochSeen) { this.failed(); return; }      // a stale host: close, reconnect
        const lost = room.epoch > this.epochSeen && msg.seq < this.applied;
        this.epochSeen = room.epoch;
        if (lost) {                                                     // the Store lost acked entries: resync from 0
          // My acked seqs, the appSeqs I saw and refused bases may name entries the room no longer has: forget
          // them, or a base could stay above the room's appSeq (always refused) and a gate never open. A
          // settings op stamped before the loss opens no gate if it is refused (§ Settings, "After a Store loss").
          for (const p of this.pending.values()) if (p.op.appState) p.lost = true;
          this.gates = [];
          this.epoch = room.epoch; this.discard(did);
          this.forgetSettings(did, "store-lost");
          return;
        }
      }
      this.epoch = room.epoch;   // a viewer's (gateway-built) welcome may lag: only recorded
    }
    // Rule 13: pending ops belong to the user who made them. Someone else signed in: drop them, say how many.
    const other = this.user !== null && this.user !== msg.user;
    if (other) {
      for (const id of [...this.pending.keys()]) { this.pending.delete(id); did.dropped.push(id); }
      this.gates = [];   // held changes are dropped and reported by forgetSettings() below
    }
    this.welcomed = true; this.role = msg.role; this.user = msg.user; this.target = msg.seq; this.horizon = msg.horizon ?? 0;
    this.progressAt = this.now();
    if (this.applied >= this.target) this.goodAt = this.now();
    if (other) { if (did.dropped.length) { this.discarded = (this.discarded ?? 0) + did.dropped.length; this.discard(did); } this.forgetSettings(did, "user-changed"); return; }
    // The room has forgotten this client (§ Op ids): ops sent before its horizon may or may not have been
    // logged, and the room would answer `stale`. Drop them now, and start over from the room's copy.
    if (msg.high === 0) for (const [id, p] of this.pending) if (p.msg.sentAt !== undefined && p.msg.sentAt < this.horizon) { this.pending.delete(id); did.dropped.push(id); }
    if (did.dropped.length) this.discard(did, did.dropped.length);
    this.release();
  }

  // Rule 5: throw the copy away and ask for a fresh connection with since 0.
  discard(did, unconfirmed = 0) { this.unconfirmed += unconfirmed; this.reset(); did.reset = true; this.resync = true; }

  snapshot(msg, did) {
    if (msg.seq <= this.applied) return;
    for (const s of ELEMENT_STREAMS) {
      const sc = msg.streams[s], doc = this.streams[s];
      doc.load({ elements: clone(sc.elements), appState: clone(sc.appState) });
      this.confirmedVersion[s] = new Map(sc.elements.map(el => [el.id, el.version ?? 0]));
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
          this.dropPreview(e.stream, el.id);
          if (e.stream === "notes" && !this.noteAuthor.has(el.id)) this.noteAuthor.set(el.id, e.by);
          const seen = this.confirmedVersion[e.stream];
          if ((el.version ?? 0) > (seen.get(el.id) ?? 0)) seen.set(el.id, el.version);
        }
        if (e.op.elements) this.streams[e.stream].apply({ elements: e.op.elements });
        if (e.op.appState) mergeAppState(this.confirmed[e.stream], this.appSeq[e.stream], e.op.appState, e.seq);
      }
      this.applied = e.seq;
      // Rule 4: an applied entry with one of my pending ids, made by me, settles that op, ack or not.
      if (e.by === this.user && this.pending.has(e.id)) {
        const p = this.pending.get(e.id); this.pending.delete(e.id);
        // Settled by its entry, ack or not: the next held change to these keys is based on it (§ Settings).
        if (p.op.appState) for (const k of Object.keys(p.op.appState)) this.floor[p.stream][k] = Math.max(this.floor[p.stream][k] ?? 0, e.seq);
        did.settled.push(e.id); this.recordsRev++;
      }
      if (this.streams[e.stream]) this.showAppState(e.stream);
      did.entries.push(e);
    }
    if (did.entries.length && this.pending.size) this.restampAll();
    if (this.welcomed && this.applied >= this.target && this.goodAt === null) this.goodAt = this.now();   // caught up; proven 10 s from now
    this.settle(did);
    this.afterAnswers(did);   // an applied entry answers a resend as well as an ack does
    this.openGates(did);
    this.release();
  }

  // An acknowledged op whose entry is applied (or covered by a snapshot) is no longer pending.
  settle(did) {
    let any = false;
    for (const [id, p] of this.pending) if (p.ackSeq && p.ackSeq <= this.applied) { this.pending.delete(id); did.settled.push(id); any = true; }
    if (any) { for (const s of ELEMENT_STREAMS) this.showAppState(s); this.recordsRev++; }
  }

  error(msg, did) {
    if (msg.code === "version") { this.stopped = "version"; return; }
    if (msg.code === "unavailable") { this.failed(); return; }   // not a refusal: every pending op is kept
    if (msg.code === "auth") { this.needAuth = true; return; }        // kept too; sign in again, then reconnect
    const p = msg.id !== undefined ? this.pending.get(msg.id) : null;
    if (!p) return;
    this.pending.delete(msg.id); did.dropped.push(msg.id);
    if (p.op.appState && msg.code !== "stale") {
      // A refused settings op takes the held changes to its keys with it: they were built on its value.
      const keys = Object.keys(p.op.appState), h = this.held[p.stream];
      let held = null;
      if (h) for (const k of keys) if (Object.prototype.hasOwnProperty.call(h, k)) { (held = held ?? {})[k] = h[k]; delete h[k]; delete this.heldBase[p.stream][k]; }
      if (h && !Object.keys(h).length) this.held[p.stream] = null;
      did.refusedSettings.push({ id: msg.id, stream: p.stream, code: msg.code, appState: p.op.appState, appBase: p.op.appBase, held });
      if (msg.code === "stale-setting") {
        // Soft (§ Settings): only the overlay changes. No reset, no resync; the confirmed copy is right.
        // Stamped before a Store loss: its base may be one the room no longer has, so no gate (retry at once).
        if (p.lost) did.retryReady.push({ id: msg.id, stream: p.stream, keys });
        else this.gates.push({ id: msg.id, stream: p.stream, appBase: { ...p.op.appBase } });
        this.showAppState(p.stream);
        this.openGates(did); this.afterAnswers(did); this.release();
        return;
      }
    }
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
      if (m.k === "preview" && ELEMENT_STREAMS.includes(m.stream)) for (const el of m.elements ?? []) {
        this.previewBy.set(`${m.stream}\n${el.id}`, { stream: m.stream, el, user: m.user, client: m.client, at: t });
        this.previews.set(el.id, el);
      } else if (m.k === "leave") for (const o of [...this.previewBy.values()]) if (o.user === m.user && o.client === m.client) this.dropPreview(o.stream, o.el.id);
    }
  }

  dropPreview(stream, id) {
    if (!this.previewBy.delete(`${stream}\n${id}`)) return;
    // The all-streams view keeps the id while another stream still previews an element with it.
    const other = ELEMENT_STREAMS.map(s => this.previewBy.get(`${s}\n${id}`)).find(Boolean);
    if (other) this.previews.set(id, other.el); else this.previews.delete(id);
  }

  /** Drop previews not updated for 5 s (§ Presence). Call it from the render loop. */
  prunePreviews() {
    const t = this.now();
    for (const o of [...this.previewBy.values()]) if (t - o.at >= PREVIEW_TTL_MS) this.dropPreview(o.stream, o.el.id);
  }

  /** Others' live previews on one stream with who sent them: [{ element, user, client, at }] (expired ones dropped first, as previewsOf). */
  previewEntries(stream) {
    this.prunePreviews();
    const out = [];
    for (const o of this.previewBy.values()) if (o.stream === stream) out.push({ element: o.el, user: o.user, client: o.client, at: o.at });
    return out;
  }

  /**
   * This client's unacknowledged ops on one stream, in send order: [{ id, op, sent }], `sent` = written to a
   * socket at least once. Held settings changes aren't ops yet (heldSettings()). `op` is a copy.
   */
  pendingOf(stream) {
    const out = [];
    for (const [id, p] of this.pending) if (p.stream === stream && p.ackSeq === undefined) out.push({ id, op: clone(p.op), sent: p.msg.sentAt !== undefined });
    return out;
  }

  /** Others' live previews on one stream (expired ones dropped first): what a view bound to that stream draws. */
  previewsOf(stream) {
    this.prunePreviews();
    const out = [];
    for (const o of this.previewBy.values()) if (o.stream === stream) out.push(o.el);
    return out;
  }

  // Shown appState = the room's order, with this client's unacknowledged patches on top.
  showAppState(stream) {
    const doc = this.streams[stream], next = { ...this.confirmed[stream] };
    for (const p of this.pending.values()) if (p.stream === stream && p.op.appState) Object.assign(next, p.op.appState);
    if (this.held[stream]) Object.assign(next, this.held[stream]);
    doc.appState.herdr = next; doc.rev++; doc._sorted = null;
  }

  /** Comments and reactions to show: the room's, with this client's unacknowledged actions on top (snapshot shape).
   *  Incremental (E-3): reuses cached per-thread JSON for untouched threads and overlays only threads touched by
   *  pending records ops. */
  recordsState() {
    if (this.recordsShown?.rev === this.recordsRev) return this.recordsShown.data;
    const pending = [];
    for (const p of this.pending.values()) if (p.stream === "records") pending.push(p);
    let data;
    if (!pending.length) {
      data = this.confirmedRecords.toJSON();
    } else {
      const touched = new Set();
      for (const { op } of pending) {
        if (!op) continue;
        if (op.do === "thread" || op.do === "resolve" || op.do === "reopen" || op.do === "move") {
          if (this.confirmedRecords.threads.has(op.id)) touched.add(op.id);
        } else if (op.do === "reply") {
          if (this.confirmedRecords.threads.has(op.thread)) touched.add(op.thread);
        } else {
          const tid = this.confirmedRecords.comments.get(op.id)?.thread.id;
          if (tid) touched.add(tid);
        }
      }
      const seed = [];
      for (const tid of touched) seed.push(this.confirmedRecords.threadJSON(tid));
      const overlay = new Records({ threads: seed }), t = this.now();
      for (const p of pending) overlay.apply(p.op, this.user, t, null);
      const threads = [];
      for (const tid of this.confirmedRecords.threads.keys()) {
        threads.push(touched.has(tid) ? overlay.threadJSON(tid) : this.confirmedRecords.threadJSON(tid));
      }
      for (const tid of overlay.threads.keys()) if (!touched.has(tid)) threads.push(overlay.threadJSON(tid));
      data = { threads };
    }
    this.recordsShown = { rev: this.recordsRev, data };
    return data;
  }

  /** The board as data, for comparing copies: elements by id, appState, the seq it's at. */
  state() {
    const out = { applied: this.applied };
    for (const s of ELEMENT_STREAMS) { const d = this.streams[s]; out[s] = { elements: [...d.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), appState: d.appState.herdr }; }
    return out;
  }
}
