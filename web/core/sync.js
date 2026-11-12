// Editor ⇄ Replica binding: one link (transport + Replica + hello) per board, and on it one core Editor per element
// stream, each kept in step with its stream (PROTOCOL.md v1; p8-one-link: one connection per tab).
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
 * Bind an Editor to a board stream over a transport: one link (openLink) with this one Editor on it. Takes over
 * `editor.onOp` (a caller may wrap it after). The handle is the link's members plus the bind's (see openLink).
 * @param {import("../../packages/core/editor.js").Editor} editor
 * @param {Parameters<typeof openLink>[0] & { stream?: string }} o   stream: the element stream (default "board").
 */
export function bindEditor(editor, { stream = "board", ...o }) {
  const link = openLink(o);
  const handle = link.bind(editor, stream);
  link.start();
  return handle;
}

/**
 * One link to a board (p8-one-link, C-3): one transport, one Replica, one hello. Every element stream of the board
 * arrives on it (the Replica holds them all: replica.streams[s]), so a tab binds each of its Editors to a stream of
 * this one link with bind(editor, stream), then calls start() (the hello). Bind before start: delivery may be
 * synchronous, and a live link loads every bound Editor.
 * @param {{ transport: import("../ports/transport.js").Transport,
 *           token: string, board: string, client?: string, tab?: string | null, onStatus?: (s: string) => void,
 *           onRoom?: (ev: object) => void,
 *           timeoutMs?: number, clock?: import("../ports/clock.js").Clock,
 *           timers?: { set(fn: () => void, ms: number): any, clear(h: any): void },
 *           now?: () => number, random?: () => number }} o
 *   clock: the clock port (the root passes browserClock()). timers / now / random: the same three separately (tests
 *   pass a virtual network's); each one given wins over the clock's. Required: now and random, and timers unless
 *   timeoutMs is 0. There is no global fallback.
 *   timeoutMs: kept for compatibility. The Replica now owns every deadline (rule 2's 10 s, rule 12's backoff);
 *   only 0 means something: no timers at all (a resync reconnects at once; nothing times out). Tests use it.
 *   now / random: the clock (ms) and jitter source handed to the Replica; tests pass a virtual clock.
 *   tab: this browser tab's id (createSession mints it). Kept, NOT sent yet: engine's `new Replica({ tab })` (hello.tab)
 *   is not in PROTOCOL.md. Turning it on is the one marked line below.
 *   onRoom(ev): what the room said, once per link: presence, here, emotes, records, refused, role, limit, and
 *   settings ({ type: "settings", stream }).
 */
export function openLink({ transport, token: firstToken, board, client = "web", tab = null, onStatus = () => {}, onRoom = () => {},
  timeoutMs = 10_000, clock = null, timers = clock ? { set: clock.set, clear: clock.clear } : null, now = clock?.now, random = clock?.random }) {
  if (typeof transport?.reopen !== "function") throw new TypeError("bindEditor: the transport must have reopen() (web/ports/transport.js)");
  if (typeof now !== "function" || typeof random !== "function" || (timeoutMs !== 0 && typeof timers?.set !== "function"))
    throw new TypeError("bindEditor: pass the clock port (clock) or timers, now and random");
  // hello.tab (engine's Replica option): add `tab` to this call when PROTOCOL.md has it. Until then it is not sent.
  const replica = new Replica({ client, now, random });
  let token = firstToken;
  const timed = timeoutMs !== 0;
  // Rate limits measure intervals: monotonic time when the clock port is given (p6-portsv R2-L4), else `now`.
  // One limiter per link: the gateway's presence limits are per connection, and a tab now has one.
  const limiter = presenceLimiter(clock?.mono ?? now);
  // connecting → catching-up → live; "refused" (sign in again), "stopped" (the app must update)
  let status = "connecting";
  let timer = null, closed = false, started = false;
  let down = false;               // resync asked for: the connection is closed, the backoff runs, input is ignored
  // The writer-connection cap (PROTOCOL.md § Pacing: a ninth writer connection gets an id-less `limit` before its
  // welcome, then is closed). It counts as a failed attempt under rule 12 and reconnects on the Replica's backoff
  // (min(30 s, 0.5 s × 2^k) × [0.5, 1): about one try per 15–30 s once settled, never a loop), so a tab gets in
  // by itself once a slot frees. `limited` stays set (the UI's banner) until a welcome; reconnect() tries at once.
  let limited = null;             // the room's message, from the cap's refusal until the next welcome
  let nextTryAt = null;           // when the backoff reopens (now()-based), while one is armed
  let roleSeen = null;            // the last non-null welcome.role: kept across resyncs (set before status fires)
  let roleTold = null;            // the last role reported through onRoom
  let userSeen = null;            // the last non-null welcome.user: kept across resyncs
  // Element ids the room has sequenced, per stream (entries and snapshots of this link; never cleared, as the old
  // per-session reader kept them): a write to one is a change, not a create.
  const sequenced = new Map();
  let recordsRev = replica.recordsRev;
  /** The Editors on this link: one bind per stream. */
  const binds = [];
  const setStatus = s => { if (s !== status) { status = s; onStatus(s); } };
  const send = m => transport.send(m);

  // ── the one timer: the Replica's wait(), or the backoff before reconnecting ──
  function arm() {
    if (timer != null) { timers.clear(timer); timer = null; }
    if (closed) return;
    nextTryAt = null;
    if (down) {
      const ms = replica.reconnectWait();
      if (!timed) return reopen();
      nextTryAt = now() + ms;
      timer = timers.set(() => { timer = null; nextTryAt = null; reopen(); }, ms);
      return;
    }
    if (!timed) return;
    const ms = replica.wait();
    if (ms !== null) timer = timers.set(() => { timer = null; pump(); }, ms);
  }

  function connect() {
    const [hello] = replica.connectMessages(token, board);
    setStatus(limited ? "limited" : "connecting");
    send(hello);
    pump();
  }
  function reopen() { if (closed) return; down = false; transport.reopen(); connect(); }
  // The Replica asked for a fresh connection. The old one stays as it is (its messages are ignored from
  // now on) until reopen() replaces it: close() is for good, never part of a resync.
  function goDown() { down = true; setStatus(limited ? "limited" : "connecting"); arm(); }

  // Status from the Replica's state. Entering `live` loads every bound Editor from the caught-up Replica.
  function refreshStatus() {
    if (replica.stopped) return setStatus("stopped");
    if (replica.needAuth) return setStatus("refused");   // a refusal wins over the cap (p7-wirev R2-M1)
    if (limited) return setStatus("limited");
    if (down || !replica.welcomed) return setStatus("connecting");
    if (replica.applied < replica.target) return setStatus("catching-up");
    if (status !== "live") { for (const b of binds) b.load(); setStatus("live"); }
  }

  // After every receive, local change and timer: send what the Replica lets go, then one timer.
  function pump() {
    if (closed || down || !started) return;
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

  const seqOf = s => { let set = sequenced.get(s); if (!set) sequenced.set(s, set = new Set()); return set; };
  function noteSequenced(did) {
    for (const e of did.entries) for (const el of e.op?.elements ?? []) seqOf(e.stream).add(el.id);
    if (did.snapshot) for (const [s, ids] of Object.entries(replica.confirmedVersion ?? {})) for (const id of ids.keys()) seqOf(s).add(id);
  }

  transport.onMessage(msg => {
    if (closed || down) return;
    if (msg?.t === "error" && msg.code === "limit" && msg.id === undefined && !replica.welcomed) {
      limited = typeof msg.message === "string" ? msg.message : "too many open connections";
      replica.connectionFailed();          // rule 12: a failed attempt (its close that follows is then ignored: `down`)
      pump(); onRoom({ type: "limit", message: limited }); return;
    }
    if (msg?.t === "here" || msg?.t === "emotes") { onRoom({ type: msg.t, msg }); return; }
    // A rule-5 refusal of one of my records ops: look it up before receive() drops it from pending.
    const was = msg?.t === "error" && msg.id !== undefined ? replica.pending.get(msg.id) : null;
    const refusedRecord = was?.stream === "records" && !["stale", "unavailable", "auth", "version", "stale-setting"].includes(msg.code)
      ? { op: clone(was.op), code: msg.code, message: typeof msg.message === "string" ? msg.message : "" } : null;
    const did = replica.receive(msg);
    noteSequenced(did);
    // Who and what the room says this link is, before any status change reports it (the session reads them then).
    if (replica.role) roleSeen = replica.role;
    if (replica.user) userSeen = replica.user;
    if (limited && replica.welcomed) limited = null;   // in: the cap let this connection through
    if (status === "live" && !did.reset && !replica.resync) {
      if (did.snapshot) for (const b of binds) b.load();
      else {
        const ids = new Map();
        for (const e of did.entries) {
          if (!ids.has(e.stream)) ids.set(e.stream, new Set());
          for (const el of e.op.elements ?? []) ids.get(e.stream).add(el.id);
        }
        for (const b of binds) { b.feed(ids.get(b.stream) ?? new Set()); b.syncSettings(); }
      }
    }
    pump();
    afterReceive(msg, did, refusedRecord);
  });

  // What the collab port and the app hear from this link, after the Replica took the message.
  function afterReceive(msg, did, refusedRecord) {
    if (msg?.t === "presence" && Array.isArray(msg.batch)) onRoom({ type: "presence", batch: msg.batch });
    if (refusedRecord && did.dropped.includes(msg.id)) onRoom({ type: "refused", ...refusedRecord });
    if (roleSeen && roleSeen !== roleTold) { roleTold = roleSeen; onRoom({ type: "role", role: roleSeen }); }
    if (did.refusedSettings.length || did.retryReady.length) {
      const touched = new Set();
      for (const r of did.refusedSettings) {
        const b = bindOf(r.stream);
        if (!b) continue;
        const values = { ...(r.appState ?? {}), ...(r.held ?? {}) };
        b.settingsRefused.push({ id: r.id, stream: r.stream, code: r.code, keys: Object.keys(values), values, ready: false });
        touched.add(b.stream);
      }
      for (const r of did.retryReady) {
        const b = bindOf(r.stream);
        const e = b && [...b.settingsRefused].reverse().find(x => x.id === r.id && x.stream === r.stream && !x.ready);
        if (e) { e.ready = true; touched.add(b.stream); }
      }
      for (const s of touched) onRoom({ type: "settings", stream: s });
    }
    recordsChanged();
  }
  function recordsChanged() { if (replica.recordsRev !== recordsRev) { recordsRev = replica.recordsRev; onRoom({ type: "records" }); } }
  // A refused settings change goes to its stream's bind (one bind alone keeps them all, as one stream's link did).
  const bindOf = s => binds.find(b => b.stream === s) ?? (binds.length === 1 ? binds[0] : null);

  // The connection dropped without our asking: one failed attempt toward the backoff (rule 12), then the
  // usual resync. Ignored while already down (a reopen is coming), closed, or waiting on sign-in / an update
  // (reconnecting with the same token or app would only be refused again).
  transport.onDrop?.(() => {
    if (closed || down || replica.stopped || replica.needAuth) return;
    replica.connectionFailed();
    pump();
  });

  /** The link's own members: the same for every bind on it (and the session's `connection`). */
  const api = {
    /** connecting | catching-up | live | limited | refused (sign in again) | stopped (protocol too new: update the app) */
    get status() { return status; },
    /** Unacknowledged ops of every stream of this link, including ones not yet sent (for a status pill). */
    get pending() { return replica.pending.size; },
    /** The role the room gave this connection (from welcome), or null. */
    get role() { return replica.role ?? null; },
    /** The last role the room gave (welcome.role), kept through a resync, when `role` is null. */
    get lastRole() { return roleSeen; },
    /** This link's wire client id (hello.client = the name plus the Replica's session part): presence names it. */
    get client() { return replica.client; },
    /** Who the room says this connection is (welcome.user), or null before the first welcome. */
    get user() { return replica.user ?? null; },
    /** The last welcome.user, kept through a resync. */
    get lastUser() { return userSeen; },
    /** Refused by the writer-connection cap: the room's message until a welcome, else null. It retries on the backoff by itself; reconnect() tries at once. */
    get limited() { return replica.needAuth ? null : limited; },   // refused (`auth`) wins over the cap: no stale cap shown
    /** While limited: when the backoff tries again (ms, the clock's now()), or null when no try is armed. */
    get nextTryAt() { return limited ? nextTryAt : null; },
    /** Is the transport's outbound backlog over CONGESTED_BYTES (the status pill's "slow link")? */
    congested: () => !closed && !!transport.congested?.(),
    /**
     * One presence message (PROTOCOL.md § Presence) on this link: { t: "presence", k, ...fields }. Sent only
     * while live, within the role's kinds and rates, and while backlogBytes() <= PRESENCE_BACKLOG_BYTES (the presence
     * gate: skipped, never queued). True if it went out.
     */
    sendPresence(k, fields) {
      if (closed || status !== "live") return false;
      if ((transport.backlogBytes?.() ?? 0) > PRESENCE_BACKLOG_BYTES) return false;
      const m = { ...clone(fields ?? {}), t: "presence", k };
      if (presenceProblem(m, replica.role) !== null || !limiter.allow(k)) return false;
      send(m); return true;
    },
    /** One `records` action (§ Records): shown at once, sent through the Replica's pacing, kept until acked. */
    record(op) { if (closed) return null; const m = replica.local("records", op); pump(); recordsChanged(); return m?.id ?? null; },
    /** Comments as shown (the room's, my unacked actions on top; snapshot shape). Cached per change by the Replica. */
    recordsState: () => replica.recordsState(),
    /** A number that changes whenever recordsState() may have. */
    get recordsRev() { return replica.recordsRev; },
    /** My unacknowledged records actions, oldest first: [{ op }]. */
    pendingRecords: () => replica.pendingOf("records").map(({ op }) => ({ op })),
    /** Others' previews on a stream, with the sender: [{ el, user, client }] (expired ones dropped). */
    previewEntries: s => replica.previewEntries(s).map(p => ({ el: p.element, user: p.user, client: p.client })),
    /** Who made a notes element (the v1 snapshot's noteAuthor, then entries), or null. */
    noteAuthor: id => replica.noteAuthor.get(id) ?? null,
    /** Has the room sequenced this element of this stream (in an entry or a snapshot this link received)? */
    sequenced: (s, id) => sequenced.get(s)?.has(id) ?? false,
    /** An element of a stream as this copy shows it (pending ops on top), or null when absent or deleted. Not a clone: read only. */
    element: (s, id) => { const el = replica.streams[s]?.getAny(id); return el && !el.isDeleted ? el : null; },
    /** The live elements of a stream (not deleted). Not clones: read only. */
    elements: s => [...(replica.streams[s]?.byId.values() ?? [])].filter(e => !e.isDeleted),
    /** Ops dropped without knowing whether they landed (forgotten client, `stale`): a count for the UI. */
    get unconfirmed() { return replica.unconfirmed; },
    /** Ops dropped because another user signed in on this client (rule 13): a count for the UI. */
    get discarded() { return replica.discarded ?? 0; },
    /** Start over on a fresh connection now (no backoff). Pending ops are kept. `newToken`: sign in again
     *  after `refused` (the hello carries it from now on). */
    reconnect(newToken) {
      if (typeof newToken === "string" && newToken) token = newToken;
      if (timer != null) { timers.clear(timer); timer = null; }
      limited = null;
      reopen();
    },
    /** Finished for good: no more sends, no timer, and the transport is closed (the only caller of its close()). */
    close() { if (closed) return; closed = true; arm(); transport.close(); },
  };

  return {
    api,
    /** Bind one Editor to one element stream of this link (once per stream), before start(). Returns its handle. */
    bind(editor, stream = "board") {
      if (started) throw new Error("openLink: bind every Editor before start()");
      if (binds.some(b => b.stream === stream)) throw new Error(`openLink: stream ${stream} is already bound`);
      const b = bindStream(editor, stream);
      binds.push(b);
      return b.handle;
    },
    /** Send the hello (once). */
    start() { if (started) return; started = true; connect(); },
  };

  // ── one Editor on one stream of the link ──
  function bindStream(editor, stream) {
    const doc = () => replica.streams[stream];
    let resets = 0;
    // Settings ops the room refused on this stream (did.refusedSettings), for the app to show; `ready` once
    // did.retryReady says a retry would be built on the value that beat it (§ Settings, "stale-setting is soft").
    const settingsRefused = [];

    // The Editor shows exactly the Replica's copy. Kept: pictures (they don't travel in ops), the open
    // gesture and text edit (M2), and undo history except steps that would recreate an element the room
    // never had (undo of a refused create would send an element with no id).
    function load() {
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

    // The handle: the link's members (own getters, so a test may redefine one), then this stream's.
    const handle = Object.defineProperties({}, Object.getOwnPropertyDescriptors(api));
    Object.defineProperties(handle, Object.getOwnPropertyDescriptors({
      /** This bind's element stream. */
      stream,
      /** How many times this Editor was loaded from the Replica (going live, a snapshot while live). */
      get resets() { return resets; },
      /** Settings ops the room refused on this stream: [{ id, stream, code, keys, values, ready }]. */
      get settingsRefused() { return settingsRefused.map(e => ({ ...e, keys: [...e.keys], values: { ...e.values } })); },
      /** Apply a refused settings change again on the current base (only once it is `ready`). False if not ready or gone. */
      retrySetting(i) {
        const e = settingsRefused[i];
        if (!e || !e.ready || closed) return false;
        settingsRefused.splice(i, 1);
        const pick = {};
        for (const k of e.keys) if (k in e.values) pick[k] = e.values[k];
        if (e.stream === stream) { replica.local(stream, { appState: pick }); syncSettings(); pump(); }
        onRoom({ type: "settings", stream });
        return true;
      },
      /** Forget a refused settings change (the user accepts the board's value). */
      dismissSetting(i) { if (settingsRefused[i]) { settingsRefused.splice(i, 1); onRoom({ type: "settings", stream }); } },
      /** The room-ordered copy of one element (a clone), or null. */
      peek: id => { const el = doc().getAny(id); return el ? clone(el) : null; },
      /** Others' drags in flight on this handle's stream (clones; display only, never merged; expire after 5 s). */
      previews: () => replica.previewsOf(stream).map(clone),
      /** End a gesture without committing it (pointercancel): what it previewed goes back to the room's copy. */
      cancelGesture() { editor.g = null; editor.guides = []; editor.erasing = new Set(); reconcile(); editor.changed(); },
      /** Live elements and settings of the bound stream, as plain data. */
      state: () => streamState(doc()),
      /** Every element (tombstones, versions, nonces) and settings of the bound stream, as plain data. */
      full: () => fullState(doc()),
      /** Editor vs Replica, strictly: every byId entry and appState.herdr. [] when equal. */
      diff: () => docDiff(editor.doc, doc()),
    }));
    return { stream, handle, settingsRefused, load, feed, syncSettings };
  }
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

