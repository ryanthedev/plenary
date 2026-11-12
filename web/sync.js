// Editor ⇄ Replica binding: one core Editor kept in step with one stream of a board.
//
// The seam (docs/m2/briefs/p6-base.md): Replica, Room and the codec belong to the engine track and change
// for protocol v1, so every call into them lives in this file and nowhere else in web/. The page and the
// tests use only what this file exports; the returned handle never hands out the Replica itself.
//
// Flow:
//   Editor.onOp  → one copy per id, no files → (live) stepVersions → replica.local → transport.send
//                                            → (not live) held, unstepped, until caught up (rule 2)
//   transport    → replica.receive → copy the Replica's elements and appState into the Editor
//   (re)connect  → hello; unacked ops resent after welcome (rule 2); once the Replica has applied up to
//                  welcome.seq, held ops are stepped against it and the Editor is loaded from it
//   refused op   → the Replica resets; reconnect with since 0 (rule 5); same catch-up as above
//   gesture ends without a commit (Escape, a tool key, cancel) → the ids it only previewed go back to the
//                  Replica's copy, so preview-only versions never outlive the gesture
//
// Transport port: { send(msg), onMessage(fn), reopen?() }. Messages are objects; a wire transport runs them
// through the codec. `reopen()` starts a fresh connection; without it the hello goes again on the same one.

import { Replica } from "../packages/protocol/replica.js";
import { Room } from "../packages/protocol/room.js";
import { tableAuth, MemoryLog } from "../packages/protocol/ports.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { clone } from "../packages/core/model.js";

// Editor calls after which a gesture may have ended (sync.js reconciles then). Wrapped on the instance;
// core is untouched.
const GESTURE_ENDS = ["pointerDown", "pointerUp", "key", "setTool"];

/**
 * Bind an Editor to a board stream over a transport. Takes over `editor.onOp` (a caller may wrap it after).
 * @param {import("../packages/core/editor.js").Editor} editor
 * @param {{ transport: { send(m: object): void, onMessage(fn: (m: object) => void): void, reopen?(): void },
 *           token: string, board: string, client?: string, stream?: string, onStatus?: (s: string) => void,
 *           timeoutMs?: number, timers?: { set(fn: () => void, ms: number): any, clear(h: any): void } }} o
 *   timeoutMs: with something outstanding (no welcome, catch-up unfinished, an op unacked) and no message for
 *   this long, start over on a fresh connection (rule 2's no-ack timeout). 0 turns it off.
 */
export function bindEditor(editor, { transport, token, board, client = "web", stream = "board", onStatus = () => {},
  timeoutMs = 10_000, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h) } }) {
  const replica = new Replica({ client });
  const doc = () => replica.streams[stream];
  let status = "connecting";      // connecting → catching-up → live; "refused" when the token or board is refused
  let target = null;              // welcome.seq: the Editor is loaded once the Replica has applied this far
  let resend = [];                // unacked ops, resent after welcome (rule 2)
  let held = [];                  // Editor ops made while not live: unstepped, kept across reconnects
  let waiting = [];               // [seq, ids] from entries not yet copied into the Editor
  const previewed = new Set();    // ids a gesture changed only by preview (their Editor version is ahead)
  let resets = 0, timer = null, closed = false;
  const setStatus = s => { if (s !== status) { status = s; onStatus(s); } };
  const send = m => transport.send(m);

  // ── the watchdog (M3, rule 2's timeout) ─────────────────────────────────
  const outstanding = () => status === "connecting" || status === "catching-up" || (status === "live" && replica.pending.size > 0);
  function arm() {
    if (timer != null) { timers.clear(timer); timer = null; }
    if (!timeoutMs || closed || status === "refused" || !outstanding()) return;
    timer = timers.set(() => { timer = null; if (!closed && status !== "refused" && outstanding()) restart(); }, timeoutMs);
  }

  function connect() {
    target = null; waiting = []; setStatus("connecting");
    const [hello, ...rest] = replica.connectMessages(token, board);
    resend = rest;                // after welcome, not before (rule 2)
    send(hello);
    arm();
  }
  function restart() { transport.reopen?.(); connect(); }

  // ── versions: the one place that renumbers (Phase 2's Replica.local will set versions; drop this then) ──
  // Core's livePut raises an element's version on every pointer move, so a long drag ends thousands past the
  // room's copy and the room refuses it (MAX_VERSION_JUMP). Each outgoing element goes out one past the
  // Replica's copy; for a committed op the Editor's stored copy takes the same version, so both agree.
  // Only ever called while live, so the Replica holds the room's state (an empty Replica mid-resync would
  // make the edit lose: verifier H1).
  function stepVersions(elements, transient) {
    return elements.map(el => {
      const base = doc().getAny(el.id)?.version ?? 0;
      if (el.version === base + 1) return el;
      const out = { ...el, version: base + 1 };
      if (!transient) { const mine = editor.doc.getAny(el.id); if (mine && mine.versionNonce === el.versionNonce) mine.version = out.version; }
      return out;
    });
  }

  // The Editor shows exactly the Replica's copy. Kept: pictures (they don't travel in ops), the open
  // gesture and text edit (M2), and undo history except steps that would recreate an element the room
  // never had (undo of a refused create would send an element with no id).
  function loadEditor() {
    const d = doc(), files = editor.doc.files;
    const prune = stack => stack.map(m => new Map([...m].filter(([id, old]) => old !== null || d.getAny(id)))).filter(m => m.size);
    editor.undoStack = prune(editor.undoStack); editor.redoStack = prune(editor.redoStack);
    editor.load({ elements: [...d.byId.values()].map(clone), appState: clone(d.appState), files });
    previewed.clear();
    resets++;
  }

  // Copy what the Replica applied into the Editor. Merge rules are the same `wins` on both sides, so an
  // element the Editor holds ahead (an open drag) keeps its local copy until the gesture ends.
  function feed() {
    const ready = waiting.filter(w => w[0] <= replica.applied);
    waiting = waiting.filter(w => w[0] > replica.applied);
    const ids = new Set(), d = doc();
    for (const [, list] of ready) for (const id of list) ids.add(id);
    if (ids.size) editor.receive({ elements: [...ids].map(id => d.getAny(id)).filter(Boolean).map(clone) });
    syncSettings();
  }
  // Settings shown = the Replica's (room order, own unacked patches on top). They change on entries and
  // also on an ack (an own patch stops covering a later one), so compare every time, and replace rather
  // than merge so a key the room never accepted goes away.
  function syncSettings() {
    const want = doc().appState.herdr;
    if (JSON.stringify(editor.doc.appState.herdr) === JSON.stringify(want)) return;
    editor.doc.appState.herdr = clone(want); editor.doc.rev++; editor.doc._sorted = null; editor.fixLayer(); editor.changed();
  }

  function catchUp() {
    if (status !== "catching-up" || target == null || replica.applied < target) return;
    // Ops made while not live, stepped against the caught-up Replica, in the order they were made.
    const out = [];
    for (const op of held) {
      const o = {};
      if (op.elements) o.elements = stepVersions(op.elements, true);
      if (op.appState) o.appState = op.appState;
      out.push(replica.local(stream, o));
    }
    held = [];
    loadEditor();                 // the Replica now includes the held ops (shown optimistically)
    setStatus("live");
    for (const m of out) send(m);
    arm();
  }

  // A gesture ended (or was cancelled) without committing some ids it previewed: back to the Replica's copy.
  // An element the Replica never had (an abandoned create) leaves the Editor entirely, tombstone and all.
  function reconcile() {
    if (editor.g || !previewed.size || status !== "live") return;
    const d = doc(), back = [];
    for (const id of previewed) {
      const r = d.getAny(id);
      if (r) back.push(clone(r));
      else if (editor.doc.byId.delete(id)) { editor.doc.rev++; editor.doc._sorted = null; }
    }
    previewed.clear();
    if (back.length) editor.doc.apply({ elements: back }, { force: true });
    editor.pruneSel(); editor.changed();
  }
  for (const name of GESTURE_ENDS) {
    const inner = editor[name];
    editor[name] = function (...args) { const r = inner.apply(this, args); reconcile(); return r; };
  }

  transport.onMessage(msg => {
    if (closed) return;
    replica.receive(msg);
    if (msg.t === "error" && !msg.id && msg.code === "auth") { setStatus("refused"); return arm(); }
    if (replica.resync) return restart();          // a refused op: start over from the room's copy (rule 5)
    if (msg.t === "welcome") {
      target = msg.seq; setStatus("catching-up");
      const out = resend; resend = [];
      for (const m of out) send(m);
    }
    if (msg.t === "entries") for (const e of msg.entries) if (e.stream === stream) waiting.push([e.seq, (e.op.elements ?? []).map(el => el.id)]);
    if (status === "catching-up") catchUp();
    else if (msg.t === "snapshot") loadEditor();
    else if (msg.t === "entries" || msg.t === "ack") feed();
    arm();
  });

  editor.onOp = op => {
    if (closed) return;
    const transient = !!op.transient;
    // One copy per id, the last: Editor.commit can list an arrow twice (its edit, then settleArrows'
    // re-route one version up), and the Editor keeps the last.
    const elements = op.elements?.length ? [...new Map(op.elements.map(el => [el.id, el])).values()] : null;
    if (transient) {
      if (!elements) return;
      for (const el of elements) previewed.add(el.id);
      if (status === "live") send(replica.local(stream, { elements: stepVersions(elements, true) }, { transient: true }));
      return;
    }
    if (!elements && !op.appState) return;         // files only: pictures go through the blob port, never in ops
    for (const el of elements ?? []) previewed.delete(el.id);
    const out = {};
    if (elements) out.elements = elements;
    if (op.appState) out.appState = op.appState;
    if (status !== "live") { held.push(clone(out)); return; }
    if (out.elements) out.elements = stepVersions(out.elements, false);
    send(replica.local(stream, out));
    arm();
  };

  connect();
  return {
    get status() { return status; },
    get resets() { return resets; },
    /** Unacknowledged ops, plus ops held until caught up (for a status pill). */
    get pending() { return replica.pending.size + held.length; },
    /** The role the room gave this connection (from welcome), or null. */
    get role() { return replica.role ?? null; },
    /** The room-ordered copy of one element (a clone), or null. */
    peek: id => { const el = doc().getAny(id); return el ? clone(el) : null; },
    /** Start over on a fresh connection (after the transport dropped). Held ops stay held. */
    reconnect() { restart(); },
    /** End a gesture without committing it (pointercancel): what it previewed goes back to the room's copy. */
    cancelGesture() { editor.g = null; editor.guides = []; editor.erasing = new Set(); reconcile(); editor.changed(); },
    /** Stop: no more sends, no timer. */
    close() { closed = true; arm(); },
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

/**
 * An in-process reference room with its own little network, for the dev page and tests. Every message
 * crosses the JSON codec; each link keeps its order (a WebSocket). Delivery is queued, never synchronous:
 * the room answers inside Editor.commit otherwise. `auto: true` delivers on a microtask (the page);
 * tests call `settle()` (or `step()` to interleave links). Which link goes next is drawn from `seed`.
 * @param {{ board?: string, tenant?: string, users: Record<string, { user: string, role: string }>, auto?: boolean, seed?: number }} o
 */
export function localRoom({ board = "b1", tenant = "t1", users, auto = false, seed = 1 }) {
  const log = new MemoryLog();
  const room = new Room({ board, tenant, auth: tableAuth(users, tenant), log });
  const wire = m => jsonCodec.decode(jsonCodec.encode(m));
  const links = [], own = seeded(seed);
  let scheduled = false;
  const kick = () => { if (auto && !scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; settle(); }); } };

  function join() {
    const link = { up: [], down: [], handler: () => {}, conn: null, gen: 0 };
    const open = () => {
      if (link.conn) room.disconnect(link.conn);
      const gen = ++link.gen;
      link.up = []; link.down = [];
      link.conn = room.connect(m => { if (link.gen === gen) { link.down.push(wire(m)); kick(); } });
    };
    open();
    links.push(link);
    return {
      send: m => { link.up.push(wire(m)); kick(); },
      onMessage: fn => { link.handler = fn; },
      reopen: open,
      close: () => { room.disconnect(link.conn); link.conn = null; link.up = []; link.down = []; },
      /** Test hook: drop whatever is queued toward the client (a lost message). */
      lose: () => { link.down = []; },
    };
  }

  // One delivery on one link (client → room or room → client). False when nothing is queued.
  function step(rng = own) {
    const busy = links.filter(l => l.conn && (l.up.length || l.down.length));
    if (!busy.length) return false;
    const l = busy[Math.floor(rng() * busy.length)];
    if (l.up.length && (!l.down.length || rng() < 0.5)) room.receive(l.conn, l.up.shift());
    else l.handler(l.down.shift());
    return true;
  }
  function settle(rng = own) { let n = 0; while (step(rng)) if (++n > 1_000_000) throw new Error("network never settled"); }

  return {
    join, step, settle, log, get seq() { return room.seq; }, compact: () => room.compact(),
    state: stream => streamState(room.streams[stream ?? "board"]),
    full: stream => fullState(room.streams[stream ?? "board"]),
  };
}
