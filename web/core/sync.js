// Editor ⇄ Replica binding: one core Editor kept in step with one stream of a board (PROTOCOL.md v1).
//
// The seam (docs/m2/briefs/p6-base.md): Replica, Room and the codec belong to the engine track, so every
// call into them lives in this file and nowhere else in web/. The page and the tests use only what this
// file exports; the returned handle never hands out the Replica itself.
//
// The Replica owns the protocol's timing and versions (phase 2); this file only drives it:
//   Editor.onOp (commit) → replica.local (versions set there; the Editor's copy takes them) → pump
//   Editor.onOp (transient: a drag in flight) → replica.preview → presence (never an op, never logged)
//   transport → replica.receive → copy what it applied into the Editor → pump
//   pump = send replica.outgoing(); if replica.resync: go down (ignore input), wait reconnectWait(),
//          reopen(), hello; else arm ONE timer from replica.wait() (pace, connect/catch-up watchdog, 10 s per-op timeout)
//   caught up (applied ≥ welcome.seq) → the Editor is loaded from the Replica → live
//   a gesture ends without a commit (Escape, a tool key, cancel) → replica.reconcile puts back the
//   Replica's copy of what it only previewed
//
// Transport: web/ports/transport.js (its header is the contract this file relies on: reopen required, close final,
// onDrop for unasked drops, backlogBytes for the presence gate). Clock: web/ports/clock.js, passed in by the root;
// this file never reads the global clock, timers or random (core rule, test/web/architecture.test.js).
// Presence gate (manager decision, p6-edge2v M1): a drag preview (presence k: "preview") goes out only
// while transport.backlogBytes() <= PRESENCE_BACKLOG_BYTES (16 KB, about one frame in flight); above it the preview
// is skipped, never queued: the next move or the commit supersedes it. Hello and real ops are never gated.

import { Replica } from "../../packages/protocol/replica.js";
import { presenceProblem, presenceLimiter, MAX_PREVIEW_ELEMENTS } from "../../packages/protocol/presence.js";
import { clone } from "../../packages/core/model.js";
import { PRESENCE_BACKLOG_BYTES } from "../ports/transport.js";

// Editor calls after which a gesture may have ended (sync.js reconciles then). Wrapped on the instance;
// core is untouched.
const GESTURE_ENDS = ["pointerDown", "pointerUp", "key", "setTool"];

/**
 * Bind an Editor to a board stream over a transport. Takes over `editor.onOp` (a caller may wrap it after).
 * @param {import("../../packages/core/editor.js").Editor} editor
 * @param {{ transport: import("../ports/transport.js").Transport,
 *           token: string, board: string, client?: string, stream?: string, onStatus?: (s: string) => void,
 *           timeoutMs?: number, clock?: import("../ports/clock.js").Clock,
 *           timers?: { set(fn: () => void, ms: number): any, clear(h: any): void },
 *           now?: () => number, random?: () => number }} o
 *   clock: the clock port (the root passes browserClock()). timers / now / random: the same three separately (tests
 *   pass a virtual network's); each one given wins over the clock's. Required: now and random, and timers unless
 *   timeoutMs is 0. There is no global fallback.
 *   timeoutMs: kept for compatibility. The Replica now owns every deadline (rule 2's 10 s, rule 12's backoff);
 *   only 0 means something: no timers at all (a resync reconnects at once; nothing times out). Tests use it.
 *   now / random: the clock (ms) and jitter source handed to the Replica; tests pass a virtual clock.
 */
export function bindEditor(editor, { transport, token: firstToken, board, client = "web", stream = "board", onStatus = () => {},
  timeoutMs = 10_000, clock = null, timers = clock ? { set: clock.set, clear: clock.clear } : null, now = clock?.now, random = clock?.random }) {
  if (typeof transport?.reopen !== "function") throw new TypeError("bindEditor: the transport must have reopen() (web/ports/transport.js)");
  if (typeof now !== "function" || typeof random !== "function" || (timeoutMs !== 0 && typeof timers?.set !== "function"))
    throw new TypeError("bindEditor: pass the clock port (clock) or timers, now and random");
  const replica = new Replica({ client, now, random });
  let token = firstToken;
  const doc = () => replica.streams[stream];
  const timed = timeoutMs !== 0;
  // Rate limits measure intervals: monotonic time when the clock port is given (p6-portsv R2-L4), else `now`.
  const limiter = presenceLimiter(clock?.mono ?? now);
  // connecting → catching-up → live; "refused" (sign in again), "stopped" (the app must update)
  let status = "connecting";
  let resets = 0, timer = null, closed = false;
  let down = false;               // resync asked for: the connection is closed, the backoff runs, input is ignored
  const setStatus = s => { if (s !== status) { status = s; onStatus(s); } };
  const send = m => transport.send(m);

  // ── the one timer: the Replica's wait(), or the backoff before reconnecting ──
  function arm() {
    if (timer != null) { timers.clear(timer); timer = null; }
    if (closed) return;
    if (down) {
      const ms = replica.reconnectWait();
      if (!timed) return reopen();
      timer = timers.set(() => { timer = null; reopen(); }, ms);
      return;
    }
    if (!timed) return;
    const ms = replica.wait();
    if (ms !== null) timer = timers.set(() => { timer = null; pump(); }, ms);
  }

  function connect() {
    const [hello] = replica.connectMessages(token, board);
    setStatus("connecting");
    send(hello);
    pump();
  }
  function reopen() { if (closed) return; down = false; transport.reopen(); connect(); }
  // The Replica asked for a fresh connection. The old one stays as it is (its messages are ignored from
  // now on) until reopen() replaces it: close() is for good, never part of a resync.
  function goDown() { down = true; setStatus("connecting"); arm(); }

  // Status from the Replica's state. Entering `live` loads the Editor from the caught-up Replica.
  function refreshStatus() {
    if (replica.stopped) return setStatus("stopped");
    if (replica.needAuth) return setStatus("refused");
    if (down || !replica.welcomed) return setStatus("connecting");
    if (replica.applied < replica.target) return setStatus("catching-up");
    if (status !== "live") { loadEditor(); setStatus("live"); }
  }

  // After every receive, local change and timer: send what the Replica lets go, then one timer.
  function pump() {
    if (closed || down) return;
    if (!replica.resync) {
      refreshStatus();
      // A never-sent op is re-stamped when an entry overtakes it (that entry's ids are fed to the Editor) or
      // on a snapshot (the Editor is reloaded), so what goes out here already matches the Editor.
      for (const m of replica.outgoing()) send(m);
    }
    if (replica.resync) return goDown();
    refreshStatus();
    arm();
  }

  // The Editor shows exactly the Replica's copy. Kept: pictures (they don't travel in ops), the open
  // gesture and text edit (M2), and undo history except steps that would recreate an element the room
  // never had (undo of a refused create would send an element with no id).
  function loadEditor() {
    const d = doc(), files = editor.doc.files;
    const prune = stack => stack.map(m => new Map([...m].filter(([id, old]) => old !== null || d.getAny(id)))).filter(m => m.size);
    editor.undoStack = prune(editor.undoStack); editor.redoStack = prune(editor.redoStack);
    editor.load({ elements: [...d.byId.values()].map(clone), appState: clone(d.appState), files });
    resets++;
  }

  // Copy the Replica's elements for these ids into the Editor. Merge rules are the same `wins` on both
  // sides, so an element the Editor holds ahead (an open drag) keeps its local copy until the gesture ends.
  function feed(ids) {
    if (!ids.size) return;
    const d = doc();
    editor.receive({ elements: [...ids].map(id => d.getAny(id)).filter(Boolean).map(clone) });
  }
  // Settings shown = the Replica's (room order, own unacked patches on top). They change on entries and
  // also on an ack (an own patch stops covering a later one), so compare every time, and replace rather
  // than merge so a key the room never accepted goes away.
  function syncSettings() {
    const want = doc().appState.herdr;
    if (JSON.stringify(editor.doc.appState.herdr) === JSON.stringify(want)) return;
    editor.doc.appState.herdr = clone(want); editor.doc.rev++; editor.doc._sorted = null; editor.fixLayer(); editor.changed();
  }

  // A gesture ended (or was cancelled) without committing what it previewed: back to the Replica's copy.
  // replica.reconcile covers ids with no pending op (an element the Replica never had leaves the Editor,
  // tombstone and all). It skips ids with a pending op; the Editor's copy of those equals the pending
  // op as sent (onOp aligns it), so a higher Editor version there is preview-only too: put it back as well.
  function reconcile() {
    if (editor.g || status !== "live") return;
    const d = doc(), mine = [...editor.doc.byId.values()];
    const fix = replica.reconcile(stream, mine);
    for (const el of mine) {
      const r = d.getAny(el.id);
      if (r && (el.version ?? 0) > r.version && replica.hasPending(stream, el.id)) fix.push(clone(r));
    }
    if (!fix.length) return;
    const back = [];
    for (const r of fix) {
      if (!r.gone) back.push(r);
      else if (editor.doc.byId.delete(r.id)) { editor.doc.rev++; editor.doc._sorted = null; }
    }
    if (back.length) editor.doc.apply({ elements: back }, { force: true });
    editor.pruneSel(); editor.changed();
  }
  for (const name of GESTURE_ENDS) {
    const inner = editor[name];
    editor[name] = function (...args) { const r = inner.apply(this, args); reconcile(); return r; };
  }

  transport.onMessage(msg => {
    if (closed || down) return;
    const did = replica.receive(msg);
    if (status === "live" && !did.reset && !replica.resync) {
      if (did.snapshot) loadEditor();
      else {
        const ids = new Set();
        for (const e of did.entries) if (e.stream === stream) for (const el of e.op.elements ?? []) ids.add(el.id);
        feed(ids);
        syncSettings();
      }
    }
    pump();
  });

  // The connection dropped without our asking: one failed attempt toward the backoff (rule 12), then the
  // usual resync. Ignored while already down (a reopen is coming), closed, or waiting on sign-in / an update
  // (reconnecting with the same token or app would only be refused again).
  transport.onDrop?.(() => {
    if (closed || down || replica.stopped || replica.needAuth) return;
    replica.connectionFailed();
    pump();
  });

  // A drag in flight goes out as presence, at most PRESENCE.preview.rate a second (the gateway drops the
  // rest anyway), in pieces of at most 50 elements; a piece the gateway would refuse is not sent.
  function sendPreview(elements) {
    if (status !== "live") return;
    for (let i = 0; i < elements.length; i += MAX_PREVIEW_ELEMENTS) {
      if ((transport.backlogBytes?.() ?? 0) > PRESENCE_BACKLOG_BYTES) return;   // presence gate: skip, never queue
      const m = replica.preview(stream, elements.slice(i, i + MAX_PREVIEW_ELEMENTS));
      if (presenceProblem(m, replica.role) === null && limiter.allow("preview")) send(m);
    }
  }

  editor.onOp = op => {
    if (closed) return;
    // One copy per id, the last: Editor.commit can list an arrow twice (its edit, then settleArrows'
    // re-route one version up), and the Editor keeps the last.
    const elements = op.elements?.length ? [...new Map(op.elements.map(el => [el.id, el])).values()] : null;
    if (op.transient) { if (elements) sendPreview(elements); return; }
    if (!elements && !op.appState) return;         // files only: pictures go through the blob port, never in ops
    const out = {};
    if (elements) out.elements = elements;
    if (op.appState) out.appState = op.appState;
    const msg = replica.local(stream, out);         // versions: one past what the Replica knows, fresh nonce
    for (const [i, el] of (msg.op.elements ?? []).entries()) {
      const was = elements[i], mine = editor.doc.getAny(el.id);
      if (mine && mine.version === was.version && mine.versionNonce === was.versionNonce) { mine.version = el.version; mine.versionNonce = el.versionNonce; }
    }
    pump();
  };

  connect();
  return {
    /** connecting | catching-up | live | refused (sign in again) | stopped (protocol too new: update the app) */
    get status() { return status; },
    get resets() { return resets; },
    /** Unacknowledged ops, including ones not yet sent (for a status pill). */
    get pending() { return replica.pending.size; },
    /** The role the room gave this connection (from welcome), or null. */
    get role() { return replica.role ?? null; },
    /** Ops dropped without knowing whether they landed (forgotten client, `stale`): a count for the UI. */
    get unconfirmed() { return replica.unconfirmed; },
    /** Ops dropped because another user signed in on this client (rule 13): a count for the UI. */
    get discarded() { return replica.discarded ?? 0; },
    /** The room-ordered copy of one element (a clone), or null. */
    peek: id => { const el = doc().getAny(id); return el ? clone(el) : null; },
    /** Others' drags in flight on this handle's stream (clones; display only, never merged; expire after 5 s). */
    previews: () => replica.previewsOf(stream).map(clone),
    /** Start over on a fresh connection now (no backoff). Pending ops are kept. `newToken`: sign in again
     *  after `refused` (the hello carries it from now on). */
    reconnect(newToken) {
      if (typeof newToken === "string" && newToken) token = newToken;
      if (timer != null) { timers.clear(timer); timer = null; }
      reopen();
    },
    /** End a gesture without committing it (pointercancel): what it previewed goes back to the room's copy. */
    cancelGesture() { editor.g = null; editor.guides = []; editor.erasing = new Set(); reconcile(); editor.changed(); },
    /** Finished for good: no more sends, no timer, and the transport is closed (the only caller of its close()). */
    close() { if (closed) return; closed = true; arm(); transport.close(); },
    /** Live elements and settings of the bound stream, as plain data. */
    state: () => streamState(doc()),
    /** Every element (tombstones, versions, nonces) and settings of the bound stream, as plain data. */
    full: () => fullState(doc()),
    /** Editor vs Replica, strictly: every byId entry and appState.herdr. [] when equal. */
    diff: () => docDiff(editor.doc, doc()),
  };
}

/** Live elements (sorted by id) and appState.herdr of a Doc. */
export function streamState(d) {
  return { elements: [...d.byId.values()].filter(e => !e.isDeleted).sort((a, b) => (a.id < b.id ? -1 : 1)).map(clone), appState: clone(d.appState.herdr) };
}
/** The Editor's side of streamState. */
export const editorState = editor => streamState(editor.doc);

/** Every byId entry (tombstones included) by id, and appState.herdr, as plain JSON data. */
export function fullState(d) {
  const plain = v => JSON.parse(JSON.stringify(v));
  return { elements: Object.fromEntries([...d.byId.values()].map(plain).sort((a, b) => (a.id < b.id ? -1 : 1)).map(e => [e.id, e])), appState: plain(d.appState.herdr) };
}
/** Strict differences between two Docs, readable. [] when every element and the settings match exactly. */
export function docDiff(a, b) {
  const x = fullState(a), y = fullState(b), out = [];
  const tag = e => `${e.type} v${e.version}/${e.versionNonce}${e.isDeleted ? " deleted" : ""}`;
  for (const id of new Set([...Object.keys(x.elements), ...Object.keys(y.elements)])) {
    const p = x.elements[id], q = y.elements[id];
    if (!q) out.push(`${id}: only in the first (${tag(p)})`);
    else if (!p) out.push(`${id}: only in the second (${tag(q)})`);
    else if (p.version !== q.version || p.versionNonce !== q.versionNonce || !!p.isDeleted !== !!q.isDeleted) out.push(`${id}: ${tag(p)} vs ${tag(q)}`);
    else if (JSON.stringify(p) !== JSON.stringify(q)) out.push(`${id}: same version, different content`);
  }
  if (JSON.stringify(x.appState) !== JSON.stringify(y.appState)) out.push(`appState: ${JSON.stringify(x.appState)} vs ${JSON.stringify(y.appState)}`);
  return out;
}

/** A small seeded random (mulberry32): the network's default, so a run is repeatable. */
export function seeded(seed = 1) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

