// The incremental checkpoint (PROTOCOL.md § Recovery, "Incremental fold"): a checkpoint as a job of small steps, so
// a big board never holds the event loop for the whole copy. Pure and synchronous: it never schedules itself; the
// room (or a test) calls step() and the host decides when (the room's `schedule`).
//
// How it stays exactly "the state at one seq": the job never reads the live state. It keeps a *shadow* room that
// only ever applies RESOLVED entries (the room's kept tail), through the same applyEntry as live ops and rebuilds,
// and it advances only inside a job. A job picks its seq S (the room's resolved seq) at the start, catches the
// shadow up to S, then copies the shadow, which nothing else touches, so ops landing mid-job change nothing the job
// reads. (Cloning the live state instead would need an undo log for the unresolved entries merged into it.)
//
// Cost model: the unit is one element reference copied (1), or an entry applied (ENTRY_UNITS + per element). Element
// objects are never mutated once stored (Doc.apply replaces by id), so the checkpoint SHARES them with the shadow
// instead of cloning: a fold copies references, not the board. Memory is about what the old fold held (live + base).

import { ELEMENT_STREAMS, RULES_VERSION, keyOf } from "./envelope.js";
import { Records } from "./records.js";
import { clone } from "../core/model.js";

/** Work units per step: a step is a fraction of a millisecond to a few ms (test/fold-bench measures it). */
export const FOLD_STEP_UNITS = 8192;
const ENTRY_UNITS = 16, ELEMENT_UNITS = 8;
const entryUnits = e => ENTRY_UNITS + ELEMENT_UNITS * (e.op.elements?.length ?? 0);

export class Folder {
  /** @param {{ blank: () => object, base: () => object, tail: () => object[] }} room  blank(): an empty log-less Room for the shadow;
   *   base()/tail(): the room's current checkpoint and resolved entries after it. */
  constructor(room) {
    this.room = room; this.shadow = null;
    this.gen = null; this.steps = 0; this.maxUnits = 0;   // stats: steps taken, the most units any one step spent
    this.left = 0;
  }

  get active() { return this.gen !== null; }

  /** Begin a job for the state at resolved seq `S` (a job already running is left alone). */
  begin(S) { if (!this.gen) this.gen = this.run(S); }
  /** Drop the running job (the shadow stays valid: it holds only resolved entries up to wherever it got). */
  abort() { this.gen = null; }

  /**
   * Run one step of at most about `units` work (an entry bigger than that is one step). Returns the checkpoint
   * when the job is done, else null. Never throws past a failed job: it is dropped and the error rethrown once.
   */
  step(units = FOLD_STEP_UNITS) {
    if (!this.gen) return null;
    this.left = units; this.steps++;
    let r;
    try { r = this.gen.next(); } catch (err) { this.gen = null; this.shadow = null; throw err; }   // a shadow that threw mid-apply is not trusted
    this.maxUnits = Math.max(this.maxUnits, units - this.left);
    if (!r.done) return null;
    this.gen = null;
    return r.value;
  }

  /** Spend `n` units; true when the step's budget is gone (the job should `yield`). */
  spend(n) { this.left -= n; return this.left <= 0; }

  *run(S) {
    const { room } = this, base = room.base();
    let sh = this.shadow;
    if (!sh) { sh = this.shadow = room.blank(); yield* this.adopt(sh, base); }
    // Catch the shadow up to S with the resolved entries after the checkpoint: tail[0] is base.seq + 1.
    const tail = room.tail();
    for (let i = sh.seq - base.seq; i < tail.length && tail[i].seq <= S; i++) {
      sh.applyEntry(tail[i]);
      if (this.spend(entryUnits(tail[i]))) yield;
    }
    if (sh.seq !== S) throw new Error(`fold: the shadow is at ${sh.seq}, not ${S}`);
    const streams = {};
    for (const s of ELEMENT_STREAMS) {
      const doc = sh.streams[s], elements = [];
      for (const el of doc.byId.values()) { elements.push(el); if (this.spend(1)) yield; }
      streams[s] = { elements, appState: clone(doc.appState) };
    }
    const threads = [];
    for (const t of sh.records.threads.values()) { threads.push(Records.threadJSON(t)); if (this.spend(1 + t.comments.length)) yield; }
    const list = [];
    for (const r of sh.clients.values()) {
      list.push({ user: r.user, client: r.client, high: r.high, last: r.last, recent: r.recent.map(p => [p[0], p[1]]) });
      if (this.spend(1 + r.recent.length)) yield;
    }
    const noteAuthor = [];
    for (const p of sh.noteAuthor) { noteAuthor.push(p); if (this.spend(1)) yield; }
    return {
      seq: sh.seq, id: sh.last.id, by: sh.last.by, at: sh.last.at, rv: RULES_VERSION,
      streams, appSeq: clone(sh.appSeq), records: { threads },
      clients: { horizon: sh.horizon, list }, noteAuthor,
    };
  }

  /** Fill an empty shadow from the room's current checkpoint, sharing its element objects (first job, or after a rebuild). */
  *adopt(sh, cp) {
    for (const s of ELEMENT_STREAMS) {
      const doc = sh.streams[s], sc = cp.streams?.[s];
      doc.load({ elements: [], appState: clone(sc?.appState ?? {}) });   // normalises layers, as a Doc built from the checkpoint does
      for (const el of sc?.elements ?? []) { doc.byId.set(el.id, el); if (this.spend(1)) yield; }
      sh.appSeq[s] = { ...(cp.appSeq?.[s] ?? {}) };
    }
    for (const raw of cp.records?.threads ?? []) { sh.records.addRaw(raw); if (this.spend(1 + (raw.comments?.length ?? 0))) yield; }
    for (const r of cp.clients?.list ?? []) sh.clients.set(keyOf(r.user, r.client), { user: r.user, client: r.client, high: r.high, last: r.last, recent: r.recent.map(p => [p[0], p[1]]) });
    sh.horizon = sh.resolvedHorizon = cp.clients?.horizon ?? 0;
    for (const [k, v] of cp.noteAuthor ?? []) { sh.noteAuthor.set(k, v); if (this.spend(1)) yield; }
    sh.seq = sh.resolved = cp.seq ?? 0;
    sh.last = { id: cp.id ?? null, by: cp.by ?? null, at: cp.at ?? null };
  }
}
