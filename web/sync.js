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
// ── Transport contract (one for every transport: web/ui/net.js shared and local, room-worker.js, localRoom,
//    and a future WebSocket one) ──
//   send(msg)        queue one message object on the current connection (a wire transport runs the codec).
//   onMessage(fn)    fn(msg) for each message of the CURRENT connection, in order.
//   reopen()         REQUIRED. Drop the current connection and open a new one. From the moment it is called,
//                    no message (and no onDrop) of an older connection is ever delivered: a transport keeps a
//                    generation per connection (localRoom: link.gen; net.js shared: a fresh link id each time)
//                    and drops anything tagged with an old one. The room refuses a second hello on one
//                    connection, so a transport without reopen() could never recover from a resync.
//   close()          Finished for good: no reopen follows. Only the handle's close() calls it; sync.js's own
//                    resync path never does (while down it ignores input, waits reconnectWait(), then reopen()).
//   onDrop?(fn)      Optional. fn() when the current connection closed or errored WITHOUT sync.js asking (a
//                    socket drop, before welcome or later). sync.js then counts it (replica.connectionFailed()),
//                    waits reconnectWait() and reopens. A transport never reports a close sync.js started
//                    (reopen, close) or one of an older connection.

import { Replica } from "../packages/protocol/replica.js";
import { Room } from "../packages/protocol/room.js";
import { tableAuth, MemoryLog } from "../packages/protocol/ports.js";
import { presenceProblem, presenceLimiter, MAX_PREVIEW_ELEMENTS } from "../packages/protocol/presence.js";
import { jsonCodec } from "../packages/protocol/codec.js";
import { clone } from "../packages/core/model.js";

// Editor calls after which a gesture may have ended (sync.js reconciles then). Wrapped on the instance;
// core is untouched.
const GESTURE_ENDS = ["pointerDown", "pointerUp", "key", "setTool"];
const REAL_TIMERS = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h) };

/**
 * Bind an Editor to a board stream over a transport. Takes over `editor.onOp` (a caller may wrap it after).
 * @param {import("../packages/core/editor.js").Editor} editor
 * @param {{ transport: { send(m: object): void, onMessage(fn: (m: object) => void): void, reopen(): void, close?(): void, onDrop?(fn: () => void): void },
 *           token: string, board: string, client?: string, stream?: string, onStatus?: (s: string) => void,
 *           timeoutMs?: number, timers?: { set(fn: () => void, ms: number): any, clear(h: any): void },
 *           now?: () => number, random?: () => number }} o
 *   timeoutMs: kept for compatibility. The Replica now owns every deadline (rule 2's 10 s, rule 12's backoff);
 *   only 0 means something: no timers at all (a resync reconnects at once; nothing times out). Tests use it.
 *   now / random: the clock (ms) and jitter source handed to the Replica; tests pass a virtual clock.
 */
export function bindEditor(editor, { transport, token: firstToken, board, client = "web", stream = "board", onStatus = () => {},
  timeoutMs = 10_000, timers = REAL_TIMERS, now = Date.now, random = Math.random }) {
  if (typeof transport?.reopen !== "function") throw new TypeError("bindEditor: the transport must have reopen() (see the transport contract in web/sync.js)");
  const replica = new Replica({ client, now, random });
  let token = firstToken;
  const doc = () => replica.streams[stream];
  const timed = timeoutMs !== 0;
  const limiter = presenceLimiter(now);
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
    close() { if (closed) return; closed = true; arm(); transport.close?.(); },
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
 * An in-process reference room behind a gateway stand-in, with its own little network, for the dev page and
 * tests. Every message crosses the JSON codec; each link keeps its order (a WebSocket). The stand-in does
 * what a gateway does (rule 8): checks the token (refusing with `auth` itself), hands the room only
 * `{ user, role }` and `n`, and relays presence to the other links (rate-limited, checked; never to the room).
 * Delivery is queued, never synchronous: the room answers inside Editor.commit otherwise. `auto: true`
 * delivers on a microtask (the page); tests call `settle()` (or `step()` to interleave links). Which link
 * goes next is drawn from `seed`.
 * `clock: true` gives a virtual clock: pass `net.now` and `net.timers` to bindEditor, and `settle()` fires
 * due timers (advancing the clock) whenever the network is idle; `advance(ms)` moves it by hand.
 * @param {{ board?: string, tenant?: string, users: Record<string, { user: string, role: string }>, auto?: boolean, seed?: number, clock?: boolean }} o
 */
export function localRoom({ board = "b1", tenant = "t1", users, auto = false, seed = 1, clock = false }) {
  const time = { t: 0, q: [], n: 0 };
  const now = clock ? () => time.t : Date.now;
  const timers = {
    set: (fn, ms) => { const h = ++time.n; time.q.push({ h, at: time.t + Math.max(0, ms), fn }); return h; },
    clear: h => { time.q = time.q.filter(x => x.h !== h); },
  };
  const log = new MemoryLog();
  const room = new Room({ board, tenant, log, now });
  const auth = tableAuth(users);
  const wire = m => jsonCodec.decode(jsonCodec.encode(m));
  const links = [], own = seeded(seed), presence = [];
  let scheduled = false;
  const kick = () => { if (auto && !scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; settle(); }); } };

  // Presence to every other welcomed link, as one gateway batch.
  function relay(from, m) {
    for (const l of links) if (l !== from && l.conn?.user) { l.down.push(wire({ t: "presence", batch: [m] })); kick(); }
  }
  function leave(link) { if (link.conn?.user) relay(link, { user: link.conn.user, client: link.conn.client, k: "leave" }); }

  // A message from a client, as the gateway hands it on.
  function up(link, msg) {
    if (msg.t === "hello") {
      const who = auth.check(msg.token, msg.board);
      if (!who) { link.down.push(wire({ t: "error", code: "auth", message: "token refused" })); kick(); return; }
      const { token, ...hello } = msg;
      return room.receive(link.conn, hello, { n: ++link.n, ...who });
    }
    if (msg.t === "presence") {
      const c = link.conn, ok = !!c.user && presenceProblem(msg, c.role) === null && link.limiter.allow(msg.k);
      presence.push({ user: c.user, msg, ok });
      if (ok) { const { t, ...rest } = msg; relay(link, { user: c.user, client: c.client, ...rest }); }
      return;
    }
    room.receive(link.conn, msg, { n: ++link.n });
  }

  function join() {
    const link = { up: [], down: [], handler: () => {}, dropped: () => {}, conn: null, gen: 0, n: 0, limiter: presenceLimiter(now), done: false };
    // Every connection has its own generation: whatever the old one queued or still answers is never
    // delivered once it is dropped (the transport contract in this file's header).
    const drop = () => { if (link.conn) { leave(link); room.disconnect(link.conn); } link.conn = null; link.gen++; link.up = []; link.down = []; };
    const open = () => {
      if (link.done) return;
      drop();
      const gen = link.gen;
      link.n = 0; link.limiter = presenceLimiter(now);
      link.conn = room.connect(m => { if (link.gen === gen) { link.down.push(wire(m)); kick(); } });
    };
    open();
    links.push(link);
    return {
      send: m => { if (link.conn) { link.up.push(wire(m)); kick(); } },
      onMessage: fn => { link.handler = fn; },
      onDrop: fn => { link.dropped = fn; },
      reopen: open,
      /** Finished for good: the link leaves the network. */
      close: () => { drop(); link.done = true; const i = links.indexOf(link); if (i >= 0) links.splice(i, 1); },
      /** Test hook: drop whatever is queued toward the client (a lost message). */
      lose: () => { link.down = []; },
      /** Test hook: the connection drops without the client asking (a socket closing); the client is told. */
      fail: () => { if (!link.conn) return; drop(); link.dropped(); },
    };
  }

  // One delivery on one link (client → room or room → client). False when nothing is queued.
  function step(rng = own) {
    const busy = links.filter(l => l.conn && (l.up.length || l.down.length));
    if (!busy.length) return false;
    const l = busy[Math.floor(rng() * busy.length)];
    if (l.up.length && (!l.down.length || rng() < 0.5)) up(l, l.up.shift());
    else l.handler(l.down.shift());
    return true;
  }
  // The earliest due timer (virtual clock), the clock moved to it. False when none is set.
  function tick(until = Infinity) {
    if (!time.q.length) return false;
    const next = time.q.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.h < a.h) ? b : a));
    if (next.at > until) return false;
    time.q = time.q.filter(x => x !== next);
    time.t = Math.max(time.t, next.at);
    next.fn();
    return true;
  }
  function settle(rng = own) {
    let n = 0;
    for (;;) {
      while (step(rng)) if (++n > 1_000_000) throw new Error("network never settled");
      if (!clock || !tick()) return;
      if (++n > 1_000_000) throw new Error("timers never settled");
    }
  }
  /** Move the virtual clock by `ms`, firing the timers due on the way (no deliveries). */
  function advance(ms) { const until = time.t + ms; while (tick(until)); time.t = until; }

  return {
    join, step, settle, advance, tick: () => tick(), log, presence, now, timers,
    get seq() { return room.seq; }, get pendingTimers() { return time.q.length; },
    compact: () => room.checkpoint(),
    state: stream => streamState(room.streams[stream ?? "board"]),
    full: stream => fullState(room.streams[stream ?? "board"]),
  };
}
