// One simulated client: a real WebSocket driven by packages/protocol's Replica (used as a consumer, never
// changed), following replica.js's header exactly: hello on connect, every frame to receive(), local changes via
// local(), outgoing() after each step and when wait() says, close + reconnectWait() + new hello on `resync`.
//
// Roles (what each one does while the run generates load):
//   editor     element ops on `board` at opRate/s, re-versioning a fixed pool of its own elements (the board stays
//              bounded), plus cursor presence at cursorRate/s
//   annotator  notes ops on its own notes at noteRate/s, comments at commentRate/s (a thread, then replies in it,
//              a new thread every 400 replies: under the 500-per-thread cap), cursors at cursorRate/s
//   viewer     receives only
//
// Counted: opsMade when an op is made (local()), opsSent when it is first written to a socket, acks and echoes once
// per op. run.js judges the ops answered against opsMade.
// Measured, into the worker's shared `stats` (scripts/load/stats.js histograms, mergeable across processes):
//   join     hello sent → welcome (ms), per connection
//   ack      op first written to the socket → its ack (ms), per sender role
//   echo     op first written → its own entry applied here (ms), per sender role
//   delivery the op's write time (stamped into the op: element customData.lt, or a comment's text) → the entry
//            applied at ANOTHER client (ms), per receiver role; live entries only (not catch-up)
// The write time, not local(), is the start: the Replica's 20/s pacing queue is the client's, not the server's.

import { Replica } from "../../packages/protocol/replica.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { makeElement } from "../../packages/core/model.js";

/** The one place a Replica is made (engine may add an optional `{ tab }` option: add it here). */
export function makeReplica(clientName) {
  return new Replica({ client: clientName });
}

const now = () => Date.now();

// A writer role is due to make ops when a client generates for rate x seconds >= this: its first op comes within
// 1.5/rate s (ticks are jittered 0.5-1.5 x 1/rate). The clock starts at the client's first welcome (run.js dueRoles).
export const DUE_TICKS = 1.5;
// A client must be welcomed within this long of its first connect, or it counts as joined too late (a server that
// answers everyone in the last seconds of a run has not served the audience); and a client that dropped and is
// reconnecting when generation ends gets this long, in the drain, to come back before "connected at the end" is read.
export const JOIN_CEILING_MS = 10000;
export const REJOIN_GRACE_MS = 3000;
/** The op rate (ticks/s) a role generates at: editors on opRate, annotators on the faster of notes and comments. */
export function writerRate(role, cfg) {
  if (role === "editor") return cfg?.opRate ?? 0;
  if (role === "annotator") return Math.max(cfg?.noteRate ?? 0, cfg?.commentRate ?? 0);
  return 0;
}

export class LoadClient {
  /**
   * @param {{ url: string, board: string, token: string, role: string, name: string, cfg: object, stats: object }} o
   *   cfg: { opRate, noteRate, commentRate, cursorRate, pool }
   */
  constructor({ url, board, token, role, name, cfg, stats }) {
    this.url = url; this.board = board; this.token = token; this.role = role; this.name = name; this.cfg = cfg; this.stats = stats;
    this.replica = makeReplica(name);
    this.ws = null; this.ownClose = false; this.running = true; this.generating = false;
    this.armed = false; this.firstWelcomeAt = null; this.firstConnectAt = null;   // armed: generation starts at the first welcome (the due clock)
    this.helloAt = null; this.liveFrom = Infinity; this.welcomedOnce = false; this.welcomed = false;
    this.writeAt = new Map();   // op id → { t: first write time (ms), acked, echoed }; gone once both are seen
    this.timers = new Set(); this.flushTimer = null;
    this.seq = 0; this.thread = null; this.replies = 0;
    this.gone = null;           // why this client stopped for good: "version" | "auth"
  }

  // ---- timers (all tracked, so close() leaves nothing behind) ----
  later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, Math.max(0, ms)); this.timers.add(t); return t; }
  every(ms, fn) { const t = setInterval(fn, ms); this.timers.add(t); return t; }

  connect() {
    if (!this.running) return;
    this.ownClose = false; this.welcomed = false; this.firstConnectAt ??= now();
    let ws;
    try { ws = new WebSocket(this.url); } catch { this.stats.count("connectThrew"); this.retry(); return; }
    this.ws = ws;
    this.stats.count("connects");
    ws.onopen = () => {
      if (ws !== this.ws) return;
      for (const m of this.replica.connectMessages(this.token, this.board)) ws.send(jsonCodec.encode(m));
      this.helloAt = now(); this.stats.count("hellos");
      this.flush();
    };
    ws.onmessage = ev => { if (ws === this.ws) this.onFrame(ev.data); };
    ws.onerror = () => { if (ws === this.ws) this.stats.count("wsErrors"); };
    ws.onclose = ev => {
      this.stats.closeCode(ev.code);
      if (ws !== this.ws) return;
      this.ws = null; this.welcomed = false;
      if (!this.ownClose) this.replica.connectionFailed();
      this.retry();
    };
  }

  retry() {
    if (!this.running || this.gone) return;
    this.stats.count("reconnects");
    this.later(this.replica.reconnectWait(), () => this.connect());
  }

  onFrame(data) {
    let msg;
    try { msg = jsonCodec.decode(data); } catch { this.stats.count("badFrames"); return; }
    const t = now();
    if (msg.t === "welcome" && !this.welcomed) {
      this.welcomed = true;
      this.stats.join(t - this.helloAt, t, !this.welcomedOnce);
      this.welcomedOnce = true;
      if (this.firstWelcomeAt === null) { this.firstWelcomeAt = t; if (this.armed) this.startGenerating(); }
      this.liveFrom = msg.seq;   // entries after the welcome's seq are live; before it, catch-up
    } else if (msg.t === "ack") {
      const w = this.writeAt.get(msg.id);
      if (w && !w.acked) { w.acked = true; this.stats.hist("ack", this.role).add(t - w.t); this.stats.count("acks"); if (w.echoed) this.writeAt.delete(msg.id); }
    } else if (msg.t === "error") {
      this.stats.error(msg.code);
    }
    const did = this.replica.receive(msg);
    for (const e of did.entries) this.onEntry(e, t);
    for (const id of did.dropped) if (this.writeAt.has(id)) { this.stats.count("dropped"); this.writeAt.delete(id); }
    if (did.reset) this.stats.count("resets");
    this.afterStep();
  }

  onEntry(e, t) {
    const w = this.writeAt.get(e.id);
    if (w && e.by === this.replica.user) {
      if (!w.echoed) { w.echoed = true; this.stats.hist("echo", this.role).add(t - w.t); this.stats.count("echoes"); this.stats.count("echoes_" + this.role); }
      if (w.acked) this.writeAt.delete(e.id);
      return;
    }
    if (e.seq <= this.liveFrom) return;   // catch-up: not a delivery latency
    const lt = stampOf(e);
    if (lt !== null) this.stats.hist("delivery", this.role).add(t - lt);
  }

  // Replica step 4 and 5: send what's due, arm the timer, or reconnect.
  afterStep() {
    const r = this.replica;
    if (r.stopped || r.needAuth) {
      if (!this.gone) { this.gone = r.stopped ? "version" : "auth"; this.stats.count("gone_" + this.gone); }
      this.closeSocket(); return;
    }
    if (r.resync) { this.stats.count("resyncs"); this.closeSocket(); this.retry(); return; }
    this.flush();
  }

  flush() {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const r = this.replica, t = now();
    for (const m of r.outgoing()) {
      if (!m._stamped) {
        stamp(m, t); m._stamped = true; this.writeAt.set(m.id, { t, acked: false, echoed: false }); this.stats.count("opsSent"); this.stats.count("opsSent_" + this.role);
      }
      ws.send(jsonCodec.encode(stripLocal(m)));
    }
    if (r.resync) { this.afterStep(); return; }
    const wait = r.wait();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.timers.delete(this.flushTimer); this.flushTimer = null; }
    if (wait !== null) this.flushTimer = this.later(wait + 1, () => { this.flushTimer = null; this.flush(); });
  }

  closeSocket() {
    const ws = this.ws; this.ws = null; this.welcomed = false;
    if (ws) { this.ownClose = true; try { ws.close(1000, "load client"); } catch { /* closed */ } }
  }

  // ---- load ----
  startGenerating() {
    this.generating = true;
    const c = this.cfg, jitter = ms => ms * (0.5 + Math.random());
    const loop = (rate, fn) => { if (!(rate > 0)) return; const tick = () => { if (!this.generating) return; fn(); this.later(jitter(1000 / rate), tick); }; this.later(jitter(1000 / rate), tick); };
    if (this.role === "editor") { loop(c.opRate, () => this.draw("board")); loop(c.cursorRate, () => this.cursor()); }
    if (this.role === "annotator") { loop(c.noteRate, () => this.draw("notes")); loop(c.commentRate, () => this.comment()); loop(c.cursorRate, () => this.cursor()); }
  }
  stopGenerating() { this.generating = false; this.armed = false; }
  /** Generate load from this client's first welcome on (not from connect): a slow join does not eat its due window. */
  arm() { this.armed = true; if (this.firstWelcomeAt !== null && !this.generating) this.startGenerating(); }
  /** Whether this client had a whole due window: welcomed at least DUE_TICKS/rate s before `genEndAt`. */
  wasDue(genEndAt) { const r = writerRate(this.role, this.cfg); return r > 0 && this.firstWelcomeAt !== null && ((genEndAt - this.firstWelcomeAt) / 1000) * r >= DUE_TICKS; }

  // Only while connected, and never more than 50 ops waiting: a client that can't send skips (counted), so a
  // stalled server shows as skipped ops, not as an ever-growing queue on this side.
  canWrite() {
    if (!this.welcomed || !this.ws) { this.stats.count("skippedOffline"); return false; }
    if (this.replica.pending.size >= 50) { this.stats.count("skippedBacklog"); return false; }
    return true;
  }

  draw(stream) {
    if (!this.canWrite()) return;
    const i = this.seq++ % this.cfg.pool;
    const el = makeElement("rectangle", { id: `${this.name}-${stream[0]}${i}`, x: (this.seq * 7) % 2000, y: i * 40, width: 30, height: 30 });
    this.replica.local(stream, { elements: [el] }); this.made();
    this.flush();
  }

  comment() {
    if (!this.canWrite()) return;
    const id = `${this.name}-c${this.seq++}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    if (!this.thread || this.replies >= 400) {
      this.thread = id; this.replies = 0;
      this.replica.local("records", { do: "thread", id, anchor: { point: { x: this.seq, y: 0 } }, text: "load" });
    } else { this.replies++; this.replica.local("records", { do: "reply", id, thread: this.thread, text: "load" }); }
    this.made();
    this.flush();
  }

  cursor() {
    const ws = this.ws;
    if (!this.welcomed || !ws || ws.readyState !== 1) return;
    ws.send(jsonCodec.encode({ t: "presence", k: "cursor", x: Math.random() * 1000, y: Math.random() * 1000 }));
    this.stats.count("presenceSent");
  }

  // Counted when made (local()), not when first written: an op the Replica never gets to send (a welcome with no
  // catch-up after it, a connection that never comes back) is still an op the server did not answer.
  made() { this.stats.count("opsMade"); this.stats.count("opsMade_" + this.role); }

  pendingCount() { return this.replica.pending.size; }

  close() {
    this.running = false; this.generating = false;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
    this.closeSocket();
  }
}

// The write time travels in the op itself, so any client (in any worker process on this machine) can measure
// delivery: an element's customData.lt, or a comment's text "load <ms>".
function stamp(m, t) {
  if (m.stream === "records") { if (m.op.do === "thread" || m.op.do === "reply") m.op.text = `load ${t}`; return; }
  for (const el of m.op.elements ?? []) el.customData = { ...(el.customData ?? {}), lt: t };
}
function stampOf(e) {
  if (e.stream === "records") { const m = /^load (\d+)$/.exec(e.op?.text ?? ""); return m ? Number(m[1]) : null; }
  const lt = e.op?.elements?.[0]?.customData?.lt;
  return Number.isFinite(lt) ? lt : null;
}
// `_stamped` is this file's bookkeeping on the pending message; it never goes on the wire.
function stripLocal(m) { if (!m._stamped) return m; const { _stamped, ...rest } = m; return rest; }
