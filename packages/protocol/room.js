// The reference room: the one sequencer for a board (PROTOCOL.md). In memory; storage and auth come in
// through ports. It never runs layout. M2's server hosts these behind a transport; M4 splits the fan-out
// into gateways, but what a room decides stays here.

import { Doc } from "../core/doc.js";
import { emptyScene, clone } from "../core/model.js";
import { STREAMS, canWrite, opProblem, mergeAppState, MAX_VERSION_JUMP, MAX_CLIENT_CHARS } from "./envelope.js";

export class Room {
  /** @param {{ board: string, tenant: string, auth: import("./ports.js").Auth, log: import("./ports.js").Log }} o */
  constructor({ board, tenant, auth, log }) {
    this.board = board; this.tenant = tenant; this.auth = auth; this.log = log;
    this.seq = 0;
    this.streams = {};
    this.appSeq = {};
    for (const s of STREAMS) { this.streams[s] = new Doc(emptyScene()); this.appSeq[s] = {}; }
    this.tail = [];                     // entries after `base` (the log kept for catch-up)
    this.base = { seq: 0, snapshot: this.snapshot() };
    this.opSeq = new Map();             // "user|op id" → seq it got (repeats get the same ack). TODO: bound per client.
    this.noteAuthor = new Map();        // notes element id → the user who made it
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
    if (msg.board !== this.board) return c.send({ t: "error", code: "auth", message: "this is another board" });
    if (typeof msg.client !== "string" || !msg.client || msg.client.length > MAX_CLIENT_CHARS || msg.client.includes(":"))
      return c.send({ t: "error", code: "bad-op", message: "hello needs a client id (no colon)" });
    const who = this.auth.check(msg.token, this.board);
    // The tenant comes from the board, on the server: a token from another tenant gets nothing here.
    if (!who || who.tenant !== this.tenant) return c.send({ t: "error", code: "auth", message: "token refused" });
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
    // Op ids are "client:counter" under this connection's own client id, and dedupe is per user, so no one
    // can suppress another person's op by sending its id first.
    if (!msg.id.startsWith(c.client + ":")) return c.send({ t: "error", id: msg.id, code: "bad-op", message: "op ids start with your client id" });
    if (!canWrite(c.role, msg.stream)) return c.send({ t: "error", id: msg.id, code: "forbidden", message: `${c.role} can't write to ${msg.stream}` });
    const key = `${c.user}|${msg.id}`;
    if (this.opSeq.has(key)) return c.send({ t: "ack", id: msg.id, seq: this.opSeq.get(key) });   // a resend
    // The notes stream's settings (its layers) are the moderators': annotators and commenters add notes only.
    if (msg.op.appState && !canWrite(c.role, "board")) return c.send({ t: "error", id: msg.id, code: "forbidden", message: "only owners and editors change settings" });
    const doc = this.streams[msg.stream];
    for (const el of msg.op.elements ?? []) {
      if (el.version > (doc.getAny(el.id)?.version ?? 0) + MAX_VERSION_JUMP) return c.send({ t: "error", id: msg.id, code: "bad-op", message: `version of ${el.id} jumps too far` });
      // Annotators and commenters change only their own notes; owners and editors moderate everyone's.
      const author = msg.stream === "notes" && this.noteAuthor.get(el.id);
      if (author && author !== c.user && !canWrite(c.role, "board")) return c.send({ t: "error", id: msg.id, code: "forbidden", message: "that note is someone else's" });
    }
    if (msg.transient) {   // relayed, never logged or applied
      for (const o of this.conns) if (o !== c && o.user) o.send({ t: "transient", stream: msg.stream, op: msg.op, by: c.user });
      return;
    }
    const entry = { seq: this.seq + 1, board: this.board, tenant: this.tenant, stream: msg.stream, op: msg.op, by: c.user, id: msg.id };
    this.log.append(entry);   // durable before anything else (rule 1)
    this.seq = entry.seq;
    this.apply(entry);
    this.tail.push(entry);
    this.opSeq.set(key, entry.seq);
    if (msg.stream === "notes") for (const el of msg.op.elements ?? []) if (!this.noteAuthor.has(el.id)) this.noteAuthor.set(el.id, c.user);
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
