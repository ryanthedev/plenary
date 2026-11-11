// The reference room: the one sequencer for a board (PROTOCOL.md). In memory; storage and auth come in
// through ports. It never runs layout. M2's server hosts these behind a transport; M4 splits the fan-out
// into gateways, but what a room decides stays here.

import { Doc } from "../core/doc.js";
import { emptyScene, clone } from "../core/model.js";
import { STREAMS, canWrite, opProblem, mergeAppState } from "./envelope.js";

export class Room {
  /** @param {{ board: string, auth: import("./ports.js").Auth, log: import("./ports.js").Log }} o */
  constructor({ board, auth, log }) {
    this.board = board; this.auth = auth; this.log = log;
    this.seq = 0;
    this.streams = {};
    this.appSeq = {};
    for (const s of STREAMS) { this.streams[s] = new Doc(emptyScene()); this.appSeq[s] = {}; }
    this.tail = [];                     // entries after `base` (the log kept for catch-up)
    this.base = { seq: 0, snapshot: this.snapshot() };
    this.opSeq = new Map();             // op id → seq it got (repeats get the same ack). TODO: bound per client.
    this.conns = new Set();
  }

  /** A client connects; `send` delivers a message to it. Returns the connection to pass to receive(). */
  connect(send) { const c = { send, user: null, role: null }; this.conns.add(c); return c; }
  disconnect(c) { this.conns.delete(c); }

  receive(c, msg) {
    if (msg.t === "hello") return this.hello(c, msg);
    if (!c.user) return c.send({ t: "error", code: "auth", message: "say hello first" });
    if (msg.t === "op") return this.op(c, msg);
    c.send({ t: "error", code: "bad-op", message: `unknown message ${JSON.stringify(msg.t)}` });
  }

  hello(c, msg) {
    const who = this.auth.check(msg.token, this.board);
    if (!who) return c.send({ t: "error", code: "auth", message: "token refused" });
    Object.assign(c, { user: who.user, role: who.role, client: msg.client });
    c.send({ t: "welcome", seq: this.seq, role: who.role, user: who.user });
    const since = Number(msg.since) || 0;
    if (since < this.base.seq) {   // the log no longer reaches back that far: the snapshot, then what came after
      c.send({ t: "snapshot", seq: this.base.seq, ...clone(this.base.snapshot) });
      if (this.tail.length) c.send({ t: "entries", entries: this.tail });
    } else {
      const after = this.tail.filter(e => e.seq > since);
      if (after.length) c.send({ t: "entries", entries: after });
    }
  }

  op(c, msg) {
    const problem = opProblem(msg);
    if (problem) return c.send({ t: "error", id: msg.id, ...problem });
    if (!canWrite(c.role, msg.stream)) return c.send({ t: "error", id: msg.id, code: "forbidden", message: `${c.role} can't write to ${msg.stream}` });
    if (this.opSeq.has(msg.id)) return c.send({ t: "ack", id: msg.id, seq: this.opSeq.get(msg.id) });   // a resend
    if (msg.transient) {   // relayed, never logged or applied
      for (const o of this.conns) if (o !== c && o.user) o.send({ t: "transient", stream: msg.stream, op: msg.op, by: c.user });
      return;
    }
    const entry = { seq: this.seq + 1, stream: msg.stream, op: msg.op, by: c.user, id: msg.id };
    this.log.append(entry);   // durable before anything else (rule 1)
    this.seq = entry.seq;
    this.apply(entry);
    this.tail.push(entry);
    this.opSeq.set(msg.id, entry.seq);
    c.send({ t: "ack", id: msg.id, seq: entry.seq });
    for (const o of this.conns) if (o.user) o.send({ t: "entries", entries: [entry] });
  }

  apply(entry) {
    const doc = this.streams[entry.stream];
    if (entry.op.elements) doc.apply({ elements: entry.op.elements });
    if (entry.op.appState) {
      const next = { ...doc.appState.herdr };
      mergeAppState(next, this.appSeq[entry.stream], entry.op.appState, entry.seq);
      doc.appState.herdr = next; doc.rev++; doc._sorted = null;
    }
  }

  snapshot() {
    const streams = {};
    for (const s of STREAMS) { const sc = this.streams[s].toScene(); streams[s] = { elements: sc.elements, appState: sc.appState }; }
    return { streams, appSeq: clone(this.appSeq) };
  }

  /** Fold the log into a snapshot: clients older than now get the snapshot instead of every entry. */
  compact() { this.base = { seq: this.seq, snapshot: this.snapshot() }; this.tail = []; }
}
