// A client's copy of a board (PROTOCOL.md): applies the room's entries in seq order, whatever order they
// arrive in, and shows its own ops at once (optimistic) until the room acknowledges them.
// Runs in a browser, a phone, Node or a Herdr pane: imports only the core's model and merge rules.

import { Doc } from "../core/doc.js";
import { emptyScene, clone } from "../core/model.js";
import { STREAMS, mergeAppState } from "./envelope.js";

export class Replica {
  /** @param {{ client: string }} o — a stable id for this client (op ids are `client:counter`) */
  constructor({ client }) {
    this.client = client; this.counter = 0;
    this.reset();
  }

  reset() {
    this.applied = 0;                    // the highest seq applied; everything up to it is in
    this.streams = {}; this.confirmed = {}; this.appSeq = {};
    for (const s of STREAMS) {
      this.streams[s] = new Doc(emptyScene());
      this.confirmed[s] = { ...this.streams[s].appState.herdr };   // appState as the room ordered it
      this.appSeq[s] = {};
    }
    this.buffer = new Map();             // seq → entry, arrived ahead of a gap
    this.previews = new Map();           // element id → others' in-flight preview (display only)
    this.pending = this.pending ?? new Map();   // op id → { stream, op, msg, ackSeq? }: kept across a reset, resent on hello
    this.role = null;
  }

  /** The hello to send on (re)connect, then every unacknowledged op again (same ids: the room dedupes). */
  connectMessages(token, board) {
    return [{ t: "hello", token, board, since: this.applied, client: this.client }, ...[...this.pending.values()].map(p => p.msg)];
  }

  /** A local change: shown now, sent to the room. Elements must already carry their new versions. */
  local(stream, op, { transient = false } = {}) {
    const msg = { t: "op", id: `${this.client}:${++this.counter}`, stream, op: clone(op), ...(transient ? { transient: true } : {}) };
    if (transient) return msg;
    if (op.elements) this.streams[stream].apply({ elements: op.elements });
    { this.pending.set(msg.id, { stream, op: msg.op, msg }); this.showAppState(stream); }
    return msg;
  }

  receive(msg) {
    if (msg.t === "welcome") { this.role = msg.role; return; }
    if (msg.t === "snapshot") return this.snapshot(msg);
    if (msg.t === "entries") { for (const e of msg.entries) if (e.seq > this.applied && !this.buffer.has(e.seq)) this.buffer.set(e.seq, e); return this.drain(); }
    if (msg.t === "ack") { const p = this.pending.get(msg.id); if (p) { p.ackSeq = msg.seq; this.settle(); } return; }
    // Previews (drags, cursors) are shown over the board, never merged into it: a preview may tie with the
    // final op on version and win on the tie-break, and the room never applies previews.
    if (msg.t === "transient") { for (const el of msg.op.elements ?? []) this.previews.set(el.id, el); return; }
    if (msg.t === "error" && msg.id && this.pending.has(msg.id)) { this.pending.delete(msg.id); this.refused = (this.refused ?? 0) + 1; }
  }

  snapshot(msg) {
    if (msg.seq <= this.applied) return;
    for (const s of STREAMS) {
      const sc = msg.streams[s];
      const doc = this.streams[s];
      doc.load({ elements: clone(sc.elements), appState: clone(sc.appState) });
      this.confirmed[s] = { ...doc.appState.herdr };
      this.appSeq[s] = { ...(msg.appSeq?.[s] ?? {}) };
    }
    this.applied = msg.seq;
    for (const k of [...this.buffer.keys()]) if (k <= this.applied) this.buffer.delete(k);
    for (const p of this.pending.values()) if (p.op.elements) this.streams[p.stream].apply({ elements: p.op.elements });
    for (const s of STREAMS) this.showAppState(s);
    this.drain();
  }

  drain() {
    while (this.buffer.has(this.applied + 1)) {
      const e = this.buffer.get(this.applied + 1); this.buffer.delete(e.seq);
      if (e.op.elements) { this.streams[e.stream].apply({ elements: e.op.elements }); for (const el of e.op.elements) this.previews.delete(el.id); }
      if (e.op.appState) mergeAppState(this.confirmed[e.stream], this.appSeq[e.stream], e.op.appState, e.seq);
      this.applied = e.seq;
      this.showAppState(e.stream);
    }
    this.settle();
  }

  // An acknowledged op whose entry is applied is no longer pending.
  settle() {
    let any = false;
    for (const [id, p] of this.pending) if (p.ackSeq && p.ackSeq <= this.applied) { this.pending.delete(id); any = true; }
    if (any) for (const s of STREAMS) this.showAppState(s);
  }

  // Shown appState = the room's order, with this client's unacknowledged patches on top.
  showAppState(stream) {
    const doc = this.streams[stream], next = { ...this.confirmed[stream] };
    for (const p of this.pending.values()) if (p.stream === stream && p.op.appState) Object.assign(next, p.op.appState);
    doc.appState.herdr = next; doc.rev++; doc._sorted = null;
  }

  /** The board as data, for comparing copies: elements by id, appState, the seq it's at. */
  state() {
    const out = { applied: this.applied };
    for (const s of STREAMS) { const d = this.streams[s]; out[s] = { elements: [...d.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), appState: d.appState.herdr }; }
    return out;
  }
}
