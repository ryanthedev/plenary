// The incremental checkpoint (PROTOCOL.md § Recovery, "Incremental fold"): a checkpoint as a job of small steps, so
// a big board never holds the event loop for the whole copy. Pure and synchronous: it never schedules itself; the
// room (or a test) calls step() and the host decides when (the room's `schedule`).
//
// How it stays exactly "the state at one seq": the job never reads the live state. It keeps a *shadow* room that
// only ever applies RESOLVED entries (the room's kept tail), through the same applyEntry as live ops and rebuilds,
// and lives only for one job (built from the room's checkpoint, dropped when the job ends or aborts: no resident third copy
// of the op-id table and the comment threads). A job picks its seq S (the room's resolved seq) at the start, catches the
// shadow up to S, then copies the shadow, which nothing else touches, so ops landing mid-job change nothing the job
// reads. (Cloning the live state instead would need an undo log for the unresolved entries merged into it.)
//
// Cost model: the unit is one element reference copied (1), or an entry applied (ENTRY_UNITS + its op's chars / CHARS_PER_UNIT:
// applying stringifies and clones what it carries, so bytes, not element counts, are the cost). Element
// objects are never mutated once stored (Doc.apply replaces by id), so the checkpoint SHARES them with the shadow
// instead of cloning: a fold copies references, not the board. Memory is about what the old fold held (live + base).

import { ELEMENT_STREAMS, RULES_VERSION, keyOf } from "./envelope.js";
import { Records } from "./records.js";
import { clone } from "../core/model.js";

/** Work units per step: a step is a fraction of a millisecond to a few ms (test/fold-bench measures it). */
export const FOLD_STEP_UNITS = 8192;
const ENTRY_UNITS = 16, CHARS_PER_UNIT = 32;

export class Folder {
  /** @param {{ blank: () => object, base: () => object, tail: () => object[], sizes: () => number[] }} room  blank(): an empty log-less Room for the shadow;
   *   base()/tail()/sizes(): the room's current checkpoint, the resolved entries after it and each one's op chars. */
  constructor(room) {
    this.room = room; this.shadow = null;
    this.gen = null; this.steps = 0; this.maxUnits = 0;   // stats: steps taken, the most units any one step spent
    this.left = 0;
  }

  get active() { return this.gen !== null; }

  /** Begin a job for the state at resolved seq `S` (a job already running is left alone). */
  begin(S) { if (!this.gen) this.gen = this.run(S); }
  /** Drop the running job and its shadow (the next job starts from the room's checkpoint). */
  abort() { this.gen = null; this.shadow = null; }

  /**
   * Run one step of at most about `units` work (an entry bigger than that is one step). Returns the checkpoint
   * when the job is done, else null. Never throws past a failed job: it is dropped and the error rethrown once.
   */
  step(units = FOLD_STEP_UNITS) {
    if (!this.gen) return null;
    this.left = units; this.steps++;
    let r;
    try { r = this.gen.next(); } catch (err) { this.abort(); throw err; }   // a shadow that threw mid-apply is not trusted
    if (units !== Infinity) this.maxUnits = Math.max(this.maxUnits, units - this.left);   // (a whole-job step has no cap to measure)
    if (!r.done) return null;
    this.gen = null; this.shadow = null;
    return r.value;
  }

  /** Spend `n` units; true when the step's budget is gone (the job should `yield`). */
  spend(n) { this.left -= n; return this.left <= 0; }

  *run(S) {
    const { room } = this, base = room.base();
    const sh = this.shadow = room.blank();
    yield* this.adopt(sh, base);
    // Catch the shadow up to S with the resolved entries after the checkpoint: tail[0] is base.seq + 1.
    const tail = room.tail(), sizes = room.sizes();
    for (let i = 0; i < tail.length && tail[i].seq <= S; i++) {
      sh.applyEntry(tail[i]);
      if (this.spend(ENTRY_UNITS + sizes[i] / CHARS_PER_UNIT)) yield;
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
      list.push({ user: r.user, client: r.client, high: r.high, last: r.last, recent: r.recent });   // the shadow dies with the job: its arrays are the checkpoint's
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

  /** Fill an empty shadow from the room's current checkpoint, sharing its element objects (every job). */
  *adopt(sh, cp) {
    for (const s of ELEMENT_STREAMS) {
      const doc = sh.streams[s], sc = cp.streams?.[s];
      doc.load({ elements: [], appState: clone(sc?.appState ?? {}) });   // normalises layers, as a Doc built from the checkpoint does
      for (const el of sc?.elements ?? []) { doc.byId.set(el.id, el); if (this.spend(1)) yield; }
      sh.appSeq[s] = { ...(cp.appSeq?.[s] ?? {}) };
    }
    for (const raw of cp.records?.threads ?? []) { sh.records.addRaw(raw); if (this.spend(1 + (raw.comments?.length ?? 0))) yield; }
    for (const r of cp.clients?.list ?? []) {
      sh.clients.set(keyOf(r.user, r.client), { user: r.user, client: r.client, high: r.high, last: r.last, recent: r.recent.map(p => [p[0], p[1]]) });   // a copy: applyEntry mutates it
      if (this.spend(1 + r.recent.length)) yield;
    }
    sh.horizon = sh.resolvedHorizon = cp.clients?.horizon ?? 0;
    for (const [k, v] of cp.noteAuthor ?? []) { sh.noteAuthor.set(k, v); if (this.spend(1)) yield; }
    sh.seq = sh.resolved = cp.seq ?? 0;
    sh.last = { id: cp.id ?? null, by: cp.by ?? null, at: cp.at ?? null };
  }
}
