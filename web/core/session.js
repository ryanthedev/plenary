// One person's canvas: two core Editors (the `board` and `notes` streams of one board), one shared view,
// input routed by tool and role, and one write chokepoint. No DOM: app.js feeds it events, and the tests
// drive it headless.
//
// Design choice (brief's "known design question"): two Editors, one per stream. Core's Editor edits one
// Doc, and each stream has its own settings (layers live in appState per stream), so merging both into one
// Doc would need sync.js to split ops by element and keep two appStates apart.
// One link per tab (p8-one-link, C-3): both Editors bind to streams of ONE sync.js link (one transport, one
// Replica, one hello, one snapshot), since the Replica holds every stream. `binds.board` and `binds.notes` are the
// two binds' handles; the link's own members (status, role, pending, presence, records) are the same on both, and
// `connection` is the link alone (the collab port reads it).
//
// Write gating has two layers: (1) input never reaches an Editor's write paths when the role or the
// connection forbids it (tools, keys, panel actions all pass `act`/`may`); (2) a backstop around each
// Editor's onOp drops anything that still slips through (counted in `blocked`, then the stream reloads
// from the Replica so the Editor never shows an edit the room will refuse).

import { Editor, TOOLS } from "../../packages/core/editor.js";
import { makeElement, isLabel } from "../../packages/core/model.js";
import { hitTest, shapeAt } from "../../packages/core/geometry.js";
import { openLink, BLOB_PENDING_MS } from "./sync.js";
import { uiRole, mayUseTool, streamFor, canEdit, viewKey, clipboardKey, settingsKey, EXTRAS } from "./roles.js";

export const NOTE = { width: 190, height: 96, fill: "#ffec99" };
export const HIGHLIGHT = { strokeColor: "#fab005", strokeWidth: 16, opacity: 40, roughness: 0, strokeStyle: "solid" };
const ORDER = { viewer: 0, annotator: 1, presenter: 2 };

/**
 * The transport as sync.js gets it: every member of the port (web/ports/transport.js) the adapter has, wrapped
 * explicitly, so a class-based adapter (members on its prototype, or getters) keeps them all (p7-audit C-5: `{ ...t }`
 * copied only own enumerable members). A member the adapter lacks stays absent (p8-one-linkv L3), so sync.js's own
 * checks (a transport without reopen() is refused) still fire through createSession. `fail` is the dev hook's
 * unasked drop, kept where the adapter has one.
 * @param {import("../ports/transport.js").Transport & { fail?: () => void }} t
 */
export function wrapTransport(t) {
  const w = {};
  for (const k of ["send", "onMessage", "reopen", "close", "congested", "backlogBytes", "onDrop", "fail"]) {
    if (typeof t?.[k] === "function") w[k] = (...a) => t[k](...a);
  }
  return w;
}

/**
 * A browser tab's id (sent as hello.tab): 16 base-36 characters from the clock port's random. Minted once per page load
 * and kept in memory only: sessionStorage would be copied by the browser's "Duplicate tab", and two tabs sharing an id
 * would trip the gateway's 2-connections-per-tab cap.
 */
export function mintTab(random) {
  let id = "";
  while (id.length < 16) id += Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0");
  return id.slice(0, 16);
}

/**
 * @param {{ join: () => object, token: string, board: string, client?: string, tab?: string, mine?: Iterable<string>,
 *           noteAuthor?: (id: string) => string | null, user?: string, onChange?: () => void,
 *           clock?: import("../ports/clock.js").Clock, timers?: object, now?: () => number, random?: () => number }} o
 *   join: the tab's one transport (sync.js's transport port), called once. mine: note ids this person made (kept by
 *   the page across reloads). noteAuthor: the v1 snapshot's table when it exists (SEAM(v1): null in v0).
 *   tab: this browser tab's id; minted once from `random` (or the clock's) when not given. Kept in s.tab and handed
 *   to sync.js, which sends it in every hello of the link (reconnects and resyncs keep it). No random: no tab.
 *   clock: the clock port (the root passes browserClock()); the Editors' clock is its now(). timers / now / random:
 *   handed to sync.js over the clock's (tests). No global fallback: sync.js throws without a clock.
 */
export function createSession({ join, token, board, client = "web", tab = null, mine = [], noteAuthor = () => null, user = null, onChange = () => {}, clock, timers, now, random } = {}) {
  const wall = now ?? clock?.now;
  const edClock = typeof wall === "function" ? () => wall() : undefined;
  const eds = { board: new Editor({ clock: edClock }), notes: new Editor({ clock: edClock }) };
  const stamp = () => edClock?.() ?? 0;   // the clock port's now (no clock: 0, so a picture is offered once)
  const binds = {};
  const draw = random ?? clock?.random;
  const s = {
    eds, binds, active: "board", tool: "hand", roleSeen: null, canShare: false, canMove: false, welcomes: 0, chrome: null, blocked: 0, sent: 0,
    penStyle: null, online: true, gesture: null, flash: null,
    tab: tab ?? (typeof draw === "function" ? mintTab(draw) : null),
  };

  // The tab's one transport, as sync.js holds it (kept in s.link for the dev hook dropConnection()).
  const link = wrapTransport(join());
  const clocked = Object.fromEntries(Object.entries({ clock, timers, now, random }).filter(([, v]) => v != null));

  // Room events of the link (sync.js's onRoom: presence, here, emotes, records, refused, role, settings, limit) for
  // the collab port (web/core/collab/port.js) and the chrome. A listener gets (stream, event): `stream` is the
  // settings event's stream, and "board" for the link's other events (the name they had when the board link carried
  // them). Each event comes once.
  const roomFns = new Set();
  s.onRoom = fn => { roomFns.add(fn); return () => roomFns.delete(fn); };
  const heardFns = new Set();
  /** fn() on every message from the room on the link (never a local action): the page's "is the link alive" signal. */
  s.onHeard = fn => { heardFns.add(fn); return () => heardFns.delete(fn); };
  const statusFns = new Set();
  /** fn(status) on every status change of the link. */
  s.onStatus = fn => { statusFns.add(fn); return () => statusFns.delete(fn); };

  const wire = openLink({ transport: link, token, board, client, tab: s.tab,
    onStatus: st => { s.refreshRole(); for (const fn of [...statusFns]) fn(st); onChange(); },
    onHeard: () => { for (const fn of [...heardFns]) fn(); },
    onRoom: ev => { if (ev.type === "settings" || ev.type === "limit") onChange(); for (const fn of [...roomFns]) fn(ev.type === "settings" ? ev.stream : "board", ev); },
    ...clocked });
  /** The link alone (sync.js's link members: status, role, user, client, presence, records, notes reads). */
  s.connection = wire.api;
  const C = wire.api;
  // Note ids the room has sequenced (so a write to one is a change, not a create), and who the room says this
  // connection is (welcome.user, checked by the gateway): the note lock uses it, never the sign-in identity, which is
  // display-only (p6-landv L5). `user` (the root's) is only a fallback before welcome.
  const known = id => C.sequenced("notes", id);
  const roomUser = () => C.lastUser;
  // The notes this person made (s.mine) belong to one room user: when the room says this tab is now someone else
  // (rule 13: the same tab signed in again as another user), forget them, so the reset window's fallback to s.mine
  // can't hand the old user's notes to the new one (p8-one-linkv L1).
  // Every read of s.mine goes through this (a getter), so no reader sees the old user's set after a switch (L8).
  const mineSet = new Set(mine);
  let mineUser = null;
  const mineNow = () => {
    const u = C.lastUser;
    if (u != null) { if (mineUser != null && u !== mineUser) mineSet.clear(); mineUser = u; }
    return mineSet;
  };
  Object.defineProperty(s, "mine", { get: mineNow, enumerable: true });

  for (const stream of ["board", "notes"]) {
    const ed = eds[stream];
    binds[stream] = wire.bind(ed, stream);
    const inner = ed.onOp;
    ed.onOp = op => {
      if (!allowed(stream, op)) {
        s.blocked++;
        // p6-uiv L2: say so; a draft or drag dropped silently looks like a bug.
        s.flash = s.readOnly || s.effective === "viewer" ? "Not sent: the room now gives you view-only access" : "Not sent: your role can't make that change";
        binds[stream].reconnect(); onChange(); return;
      }
      if (stream === "notes") for (const el of op.elements ?? []) if (!known(el.id)) mineNow().add(el.id);
      if (op.elements?.length || op.appState) s.sent++;
      if (!op.transient) offerPlaced(stream, ed, op);
      inner(op);
    };
  }
  wire.start();

  // ── role ──
  // Replica.reset() clears its role, so the last one seen is kept. The chrome is set by the first role seen;
  // a lower role later (a downgrade on reconnect) keeps that chrome, greyed (readOnly).
  s.refreshRole = () => {
    const r = C.lastRole;
    if (!r) return;
    s.roleSeen = r; s.canShare = C.canShare === true; s.canMove = C.canMove === true; s.welcomes = C.welcomes ?? 0;
    const ui = uiRole(r);
    if (!s.chrome) { s.chrome = ui; s.tool = ui === "viewer" ? "hand" : "select"; applyTool(); }
  };
  Object.defineProperties(s, {
    role: { get: () => s.chrome ?? "viewer" },
    effective: { get: () => uiRole(s.roleSeen) },
    readOnly: { get: () => !!s.chrome && ORDER[uiRole(s.roleSeen)] < ORDER[s.chrome] },
    // The link's (p8-one-link: both binds share it, so a merge of the two compared the link with itself, L2).
    status: { get: () => C.status },
    // The link's outbound backlog over CONGESTED_BYTES (web/ports/transport.js): the pill says "slow link".
    congested: { get: () => C.congested() },
    /** The writer-connection cap's message while the link is stopped by it, else null. */
    limited: { get: () => C.limited ?? null },
    /** While limited: when the link's backoff tries again (the clock's now() ms), or null. */
    limitedNextTry: { get: () => C.nextTryAt ?? null },
    /** Refused settings changes of both streams: [{ stream, i, code, keys, values, ready }] (i: the bind's index). */
    settingsRefused: { get: () => ["board", "notes"].flatMap(st => binds[st].settingsRefused.map((e, i) => ({ ...e, stream: st, i }))) },
    // The link's: one Replica's pending ops, every stream.
    pending: { get: () => C.pending },
    ed: { get: () => eds[s.active] },
  });

  // Two questions (p6-uiv M1). `may`: can a NEW gesture, tool or command start (needs the role and the browser
  // online). The backstop asks only the role: a text box or drag already open when the connection drops
  // still commits, and sync.js holds the op until the room is back (an acked op is never lost; an unsent
  // one waits). Going offline never drops a draft.
  const roleMay = () => canEdit(s.effective, s.readOnly) && canEdit(s.role);
  const may = () => s.online !== false && roleMay();
  const streamOk = stream => (stream === "notes" ? s.effective !== "viewer" : s.effective === "presenter");
  s.may = may;
  s.canWriteStream = stream => may() && streamOk(stream);

  // Is this note element one the user may change? Presenters moderate every note.
  s.isMine = id => {
    if (s.effective === "presenter") return true;
    const a = C.noteAuthor(id) ?? noteAuthor(id);
    if (a != null) return a === (roomUser() ?? user);
    return mineNow().has(id);
  };

  function allowed(stream, op) {
    if (!op.elements?.length && !op.appState) return true;          // files only: never sent (sync.js strips them)
    if (!roleMay() || !streamOk(stream)) return false;
    if (stream === "notes" && s.effective !== "presenter") {
      if (op.appState) return false;                                 // a stream's settings are the moderators'
      for (const el of op.elements ?? []) if (known(el.id) && !s.isMine(el.id)) return false;
    }
    return true;
  }

  // Annotators: drop others' notes from the selection, the eraser and the text box, so no command can
  // touch them (each attempt would be a refused op and a resync).
  function prune() {
    if (s.effective === "presenter") return;
    const n = eds.notes;
    for (const id of [...n.sel]) if (!s.isMine(id)) n.sel.delete(id);
    for (const id of [...n.erasing]) if (!s.isMine(id)) n.erasing.delete(id);
    if (n.text && !n.text.isNew && !s.isMine(n.text.id)) n.cancelText();
  }

  // ── view: one view for both Editors ──
  s.syncView = (from = s.active) => {
    const a = eds[from], b = eds[from === "board" ? "notes" : "board"];
    if (b.view.x !== a.view.x || b.view.y !== a.view.y || b.view.scale !== a.view.scale) { b.view = { ...a.view }; b.changed(); }
  };
  s.setSize = (w, h) => { for (const e of Object.values(eds)) { e.setSize(w, h); e.changed(); } };

  // ── tools ──
  function applyTool() {
    const t = s.tool, stream = streamFor(s.role, t);
    const other = eds[stream === "board" ? "notes" : "board"];
    if (s.active !== stream) { other.select([]); if (other.text) other.commitText(); }
    s.active = stream;
    const ed = eds[stream];
    const core = t === "highlighter" ? "freedraw" : t === "note" || t === "image" ? "select" : t;
    // The highlighter is the pen with a wide, translucent style; leaving it restores the pen's style.
    if (s.penStyle && (t !== "highlighter" || s.penStyle.ed !== ed)) { const { ed: was, style } = s.penStyle; s.penStyle = null; was.setTool("select"); was.select([]); was.setStyle({ ...style }); }
    if (t === "highlighter") { if (!s.penStyle) s.penStyle = { ed, style: { ...ed.style } }; ed.setTool(core); ed.setStyle({ ...HIGHLIGHT }); }
    else ed.setTool(core);
  }
  s.setTool = id => {
    if (!mayUseTool(s.role, id)) return false;
    if (id !== "hand" && !may()) return false;
    s.tool = id; applyTool(); onChange(); return true;
  };
  s.toolLock = () => eds.board.toolLock;
  s.toggleLock = () => { if (!may()) return; const v = !eds.board.toolLock; eds.board.toolLock = eds.notes.toolLock = v; eds.board.changed(); };

  /** Run a write command on an Editor, if this session may write to that stream. Returns false if refused. */
  s.act = (stream, fn, { settings = false } = {}) => {
    if (!s.canWriteStream(stream)) return false;
    if (settings && s.effective !== "presenter") return false;     // layers, grid: the moderators' (the room refuses others)
    if (stream === "notes" && s.effective !== "presenter") prune();
    fn(eds[stream]);
    prune(); s.syncView(stream);
    return true;
  };

  // ── pointer ──
  const world = p => eds.board.toWorld(p);
  function noteHit(p) {
    const w = world(p), n = eds.notes;
    return hitTest(n.doc, w, n.tol()) ?? shapeAt(n.doc, w);
  }
  s.pointerDown = (p, m = {}) => {
    const pan = m.button === "middle" || m.space || s.tool === "hand" || !may();
    if (pan) { s.gesture = s.active; const ed = eds[s.active]; const t = ed.tool; ed.tool = "hand"; ed.pointerDown(p, m); ed.tool = t; return; }
    if (s.tool === "note") { s.gesture = null; s.placeNote(world(p)); return; }
    if (s.tool === "image") { s.gesture = null; return; }
    // Presenters' Select reaches notes too (notes paint on top, so they win the hit).
    if (s.role === "presenter" && s.tool === "select" && !eds.notes.text && !eds.board.text) {
      const into = eds.notes.sel.size && eds.notes.handleAt(p) ? "notes" : noteHit(p) ? "notes" : "board";
      if (into !== s.active) { eds[s.active].select([]); s.active = into; }
    }
    const ed = eds[s.active];
    if (s.active === "notes" && s.effective !== "presenter") {
      const hit = noteHit(p);
      if (hit && (s.tool === "select" || s.tool === "text") && !s.isMine(isLabel(hit) && hit.containerId ? hit.containerId : hit.id) && !s.isMine(hit.id)) { s.flash = "That note is someone else's: locked"; s.gesture = null; onChange(); return; }
      if (s.tool === "arrow") m = { ...m, cmd: true };             // never bind: binding writes the target's boundElements
    }
    s.gesture = s.active;
    ed.pointerDown(p, m);
    prune(); s.syncView();
  };
  s.pointerMove = (p, m = {}) => {
    const ed = eds[s.gesture ?? s.active];
    if (s.gesture === "notes" && s.tool === "arrow" && s.effective !== "presenter") m = { ...m, cmd: true };
    ed.pointerMove(p, m); prune(); s.syncView(s.gesture ?? s.active);
  };
  s.pointerUp = (p, m = {}) => {
    const ed = eds[s.gesture ?? s.active];
    if (s.gesture === "notes" && s.tool === "arrow" && s.effective !== "presenter") m = { ...m, cmd: true };
    prune(); ed.pointerUp(p, m); prune(); s.syncView(s.gesture ?? s.active); s.gesture = null;
    if (ed.tool === "select" && s.tool !== "select" && s.tool !== "highlighter" && !ed.toolLock && !["note", "image", "hand"].includes(s.tool)) { s.tool = "select"; onChange(); }
  };
  s.wheel = (d, p, m = {}) => { eds[s.active].wheel(d, p, m); s.syncView(); };
  s.zoomAt = (scale, p) => { eds.board.zoomAt(scale, p); s.syncView("board"); };
  s.fit = () => { const els = [...eds.board.doc.visible(), ...eds.notes.doc.visible()].filter(e => !isLabel(e)); eds.board.fit(els); s.syncView("board"); };
  s.goToFrame = id => { eds.board.goToFrame(id); s.syncView("board"); };
  s.stepFrame = n => { eds.board.stepFrame(n); s.syncView("board"); };

  /** A sticky note at a world point: a filled rectangle, then type its label. */
  s.placeNote = (at, text) => s.act("notes", n => {
    const el = makeElement("rectangle", { x: at.x - NOTE.width / 2, y: at.y - NOTE.height / 2, width: NOTE.width, height: NOTE.height, backgroundColor: NOTE.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0, strokeColor: n.style.strokeColor });
    const ids = n.insertElements([el], null, at);
    const host = n.doc.get(ids[0]);
    if (!host) return;
    n.beginText(host, at);
    if (text != null) { n.setText(text); n.commitText(); }
    if (!n.toolLock) { s.tool = "select"; n.setTool("select"); }
    s.active = "notes";
  });

  /** A picture: on the board for presenters, in notes for annotators. `file` as core's addImage takes it. */
  s.addPicture = (file, at) => {
    const stream = s.role === "presenter" ? "board" : "notes";
    let id = null;
    stored.set(file.id, stamp());                                     // the caller uploads it (not offered a second time)
    s.act(stream, ed => { id = ed.addImage(file, at); });
    return id;
  };
  /** fileId → ms of this client's last put or fetch of that picture. */
  const stored = new Map();
  /** Pictures waiting for the app to upload them (see `unsavedFiles`): fileId → file. */
  const offers = new Map();
  /** Image elements this client placed whose op may not be acknowledged yet: elementId → { stream, fileId } (see `unsavedFiles`). */
  const awaiting = new Map();
  /** Offers `fileId`'s bytes for upload unless this client put or fetched it within BLOB_PENDING_MS. */
  const offerFile = (ed, fileId, t) => {
    const file = ed.doc.files?.[fileId];
    if (!file || t - (stored.get(fileId) ?? -Infinity) < BLOB_PENDING_MS) return;
    stored.set(fileId, t); offers.set(fileId, file);
  };
  /**
   * A committed op of this client that PLACES an image (a new element, or one whose fileId changed; never a move, resize or restyle of a picture that
   * is already there): offer its picture for upload unless this client put or fetched it within BLOB_PENDING_MS. The server may have deleted a picture
   * no board used for a while (PROTOCOL.md § Blobs, "References and purge"), and the bytes of a pasted selection or a library item never travel in
   * ops, so the client that places them puts them again. The element is remembered until the room sequences it: an op sent offline is resent on
   * reconnect without passing here, so its acknowledgement offers the picture again (same age rule; see `unsavedFiles`).
   */
  const offerPlaced = (stream, ed, op) => {
    const t = stamp();
    for (const el of op.elements ?? []) {
      if (el.type !== "image" || el.isDeleted || typeof el.fileId !== "string") continue;
      if (C.element(stream, el.id)?.fileId === el.fileId) continue;   // already placed with this picture: a move, resize or restyle
      awaiting.set(el.id, { stream, fileId: el.fileId });
      offerFile(ed, el.fileId, t);
    }
    if (awaiting.size > 500) for (const [id, w] of awaiting) if (!stillAwaited(id, w)) awaiting.delete(id);
  };
  /** Is this placed picture still waiting for its op to be sequenced? No when the room did, when it refused the op (the link's copy of the element is gone), or when the Editor no longer shows the element. */
  const stillAwaited = (id, w) => {
    if (C.sequenced(w.stream, id)) return false;
    const mine = eds[w.stream].doc.get(id);
    return !!mine && !mine.isDeleted && mine.fileId === w.fileId && C.element(w.stream, id)?.fileId === w.fileId;
  };
  /**
   * Pictures the app should put now: each placed by this client's own op (a pasted selection, a library item, a duplicate), bytes held, not put
   * or fetched by this client for BLOB_PENDING_MS. Asked every frame; empty when nothing was placed (nothing walks the documents).
   * @returns {object[]} files as `net.put` takes them
   */
  s.unsavedFiles = () => {
    // The pictures this client placed wait for their ops to be sequenced (acknowledged, also after a reconnect that resent them without passing the Editor):
    // then the same age rule applies. A refused op is never sequenced and its element leaves the link's copy: dropped, never offered.
    if (awaiting.size) {
      const t = stamp();
      for (const [id, w] of awaiting) {
        if (C.sequenced(w.stream, id)) { awaiting.delete(id); offerFile(eds[w.stream], w.fileId, t); }
        else if (!stillAwaited(id, w)) awaiting.delete(id);
      }
    }
    if (!offers.size) return [];
    const out = [...offers.values()]; offers.clear(); return out;
  };
  /**
   * Live image elements, in either Editor, whose bytes neither Editor holds: Map fileId → stamp. The stamp names what the
   * documents say about that file (its elements and their versions), so a net can tell "a change touched this picture"
   * from "nothing new". Memoised on the two documents' revisions: a frame that changed nothing costs two comparisons,
   * not a scan of every element.
   * @returns {Map<string, string>}
   */
  let missingKey = null, missingMap = new Map();
  s.missing = () => {
    const key = Object.values(eds).map(ed => ed.doc.rev ?? 0).join("|");
    if (key === missingKey) return missingMap;
    const have = id => Object.values(eds).some(ed => ed.doc.files?.[id]), out = new Map();
    for (const ed of Object.values(eds)) for (const el of ed.doc.byId.values())
      if (el.type === "image" && !el.isDeleted && typeof el.fileId === "string" && !have(el.fileId)) out.set(el.fileId, `${out.get(el.fileId) ?? ""}${el.id}:${el.version ?? 0};`);
    missingKey = key; missingMap = out;
    return out;
  };
  /** The `fileId`s of s.missing(). */
  s.missingFiles = () => [...s.missing().keys()];
  /** Picture bytes fetched for a placeholder (net.want → onFile; PROTOCOL.md § Blobs): shown in both Editors, never sent as an op. */
  s.receiveFiles = files => { for (const id of Object.keys(files)) stored.set(id, stamp()); for (const ed of Object.values(eds)) { ed.doc.apply({ files }); ed.changed(); } };

  // ── keys ──
  s.key = (key, m = {}) => {
    const ed = eds[s.active];
    if (ed.text) return ed.key(key, m);
    if (clipboardKey(key, m)) return false;
    const k = String(key).toLowerCase();
    if (!may()) {
      if (!viewKey(k, m)) return k === "escape";                     // swallowed: nothing a viewer presses writes
      if (k === "h") return s.setTool("hand");
    }
    if (m.shift && k === "1") { s.fit(); return true; }
    if (k === "pagedown" || k === "pageup") { s.stepFrame(k === "pagedown" ? 1 : -1); return true; }
    if ((m.cmd || m.ctrl) && ["=", "-", "0"].includes(k)) { const r = eds.board.key(k, m); s.syncView("board"); return r; }
    if (!may()) return false;
    if (settingsKey(key, m) && s.effective !== "presenter") return true;
    if (k === "q" && !m.cmd && !m.ctrl) { s.toggleLock(); return true; }
    if (m.shift && k === "space" && s.role === "presenter") { eds.board.playToggle(); return true; }
    // Tool keys go through setTool so they route to the right stream and stay inside the role.
    if (!m.cmd && !m.ctrl && !m.alt && !m.shift) {
      const id = toolKey(k);
      if (id) { s.setTool(id); return true; }
      if (s.role !== "presenter" && /^[0-9a-z]$/.test(k) && !["c", "b", "s", "w", "g"].includes(k)) return true;   // others' tool keys: nothing
    }
    if (s.active === "notes" && s.effective !== "presenter") prune();
    const r = ed.key(key, m);
    prune(); s.syncView();
    if (k === "escape" && s.tool !== "hand") { s.tool = "select"; applyTool(); onChange(); }
    return r;
  };
  function toolKey(k) {
    for (const t of [...EXTRA_KEYS, ...CORE_KEYS]) if (t.keys.includes(k)) return t.id;
    return null;
  }

  // ── clipboard (the page's copy/cut/paste events) ──
  s.copy = () => eds[s.active].copy();
  s.cut = () => { const t = eds[s.active].copy(); if (t) s.act(s.active, ed => ed.deleteIds([...ed.sel])); return t; };
  s.paste = (text, at) => s.act(s.role === "presenter" ? s.active : "notes", ed => ed.paste(text, at));

  // ── painting ──
  /** Board items, then notes on top (hidden while the timeline plays). */
  s.displayList = theme => {
    s.tick();
    const items = eds.board.displayList(theme);
    if (eds.board.time() == null) items.push(...eds.notes.displayList(theme));
    return items;
  };
  s.tick = () => { if (eds.board.needsTick()) eds.board.tick(); if (eds.notes.needsTick()) eds.notes.tick(); };
  s.version = () => eds.board.version * 1e6 + eds.notes.version;
  s.textEditor = () => (eds.board.text ? eds.board : eds.notes.text ? eds.notes : null);
  s.takeFlash = () => { const f = s.flash ?? eds.board.flash ?? eds.notes.flash; s.flash = eds.board.flash = eds.notes.flash = null; return f; };

  /** Apply a refused settings change again (only when it is `ready`), or forget it. */
  s.retrySetting = (stream, i) => { const r = binds[stream]?.retrySetting(i) ?? false; onChange(); return r; };
  s.dismissSetting = (stream, i) => { binds[stream]?.dismissSetting(i); onChange(); };
  /** Who the room says this person is (welcome.user), else the root's display-only user. */
  s.roomUser = () => roomUser() ?? user;

  /** Reconnect the link now (one reopen, one hello); `token` signs in again after `refused`. */
  s.reconnect = token => C.reconnect(token);
  /** Dev/test hook: the link drops without asking (the transport's fail(), where it has one). */
  s.dropConnection = () => { link.fail?.(); };
  /** Test hook: the tab's one transport as sync.js holds it. */
  s.link = link;
  return s;
}

const CORE_KEYS = TOOLS, EXTRA_KEYS = EXTRAS;
