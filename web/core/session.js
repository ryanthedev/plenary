// One person's canvas: two core Editors (the `board` and `notes` streams of one board), one shared view,
// input routed by tool and role, and one write chokepoint. No DOM: app.js feeds it events, and the tests
// drive it headless.
//
// Design choice (brief's "known design question"): two Editors, one per stream. Core's Editor edits one
// Doc, and each stream has its own settings (layers live in appState per stream), so merging both into one
// Doc would need sync.js to split ops by element and keep two appStates apart. bindEditor already takes a
// `stream`, so two Editors need no sync.js change. Cost today: two links (two hellos) per person, because
// each bindEditor makes its own Replica. Wanted in sync.js (report): bindEditors sharing one Replica and
// one connection.
//
// Write gating has two layers: (1) input never reaches an Editor's write paths when the role or the
// connection forbids it (tools, keys, panel actions all pass `act`/`may`); (2) a backstop around each
// Editor's onOp drops anything that still slips through (counted in `blocked`, then the stream reloads
// from the Replica so the Editor never shows an edit the room will refuse).

import { Editor, TOOLS } from "../../packages/core/editor.js";
import { makeElement, isLabel } from "../../packages/core/model.js";
import { hitTest, shapeAt } from "../../packages/core/geometry.js";
import { bindEditor } from "./sync.js";
import { uiRole, mayUseTool, streamFor, canEdit, viewKey, clipboardKey, settingsKey, EXTRAS } from "./roles.js";

export const NOTE = { width: 190, height: 96, fill: "#ffec99" };
export const HIGHLIGHT = { strokeColor: "#fab005", strokeWidth: 16, opacity: 40, roughness: 0, strokeStyle: "solid" };
const ORDER = { viewer: 0, annotator: 1, presenter: 2 };

/**
 * @param {{ join: () => object, token: string, board: string, client?: string, mine?: Iterable<string>,
 *           noteAuthor?: (id: string) => string | null, user?: string, onChange?: () => void,
 *           clock?: import("../ports/clock.js").Clock, timers?: object, now?: () => number, random?: () => number }} o
 *   join: a fresh transport per stream (sync.js's transport port). mine: note ids this person made (kept by the
 *   page across reloads). noteAuthor: the v1 snapshot's table when it exists (SEAM(v1): null in v0).
 *   clock: the clock port (the root passes browserClock()); the Editors' clock is its now(). timers / now / random:
 *   handed to bindEditor over the clock's (tests). No global fallback: bindEditor throws without a clock.
 */
export function createSession({ join, token, board, client = "web", mine = [], noteAuthor = () => null, user = null, onChange = () => {}, clock, timers, now, random } = {}) {
  const wall = now ?? clock?.now;
  const edClock = typeof wall === "function" ? () => wall() : undefined;
  const eds = { board: new Editor({ clock: edClock }), notes: new Editor({ clock: edClock }) };
  const binds = {};
  const s = {
    eds, binds, active: "board", tool: "hand", roleSeen: null, chrome: null, blocked: 0, sent: 0,
    mine: new Set(mine), penStyle: null, online: true, gesture: null, flash: null,
  };

  // What the room has said, read off our own transports (bindEditor's handle exposes no role or ids):
  // the role from welcome, note ids the room has sequenced (so a write to one is a change, not a create),
  // and the v1 snapshot's noteAuthor table when it comes (SEAM(v1): absent in v0).
  const known = new Set(), authors = new Map();
  let lastRole = null;
  // Who the room says this connection is (welcome.user, checked by the gateway): the note lock uses it, never the
  // sign-in identity, which is display-only (p6-landv L5). `user` (the root's) is only a fallback before welcome.
  let roomUser = null;
  function sniff(m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "welcome" && m.role) lastRole = m.role;
    if (m.t === "welcome" && typeof m.user === "string" && m.user) roomUser = m.user;
    if (m.t === "entries") for (const e of m.entries ?? []) if (e.stream === "notes") for (const el of e.op?.elements ?? []) known.add(el.id);
    if (m.t === "snapshot") {
      for (const el of m.streams?.notes?.elements ?? []) known.add(el.id);
      if (m.noteAuthor && typeof m.noteAuthor === "object") for (const [id, u] of Object.entries(m.noteAuthor)) authors.set(id, u);
    }
  }
  // The transport as sync.js gets it (its contract: web/ports/transport.js), with the room's messages read on
  // the way in. Kept in s.links for the dev hook dropConnection().
  const links = {};
  const watched = stream => {
    const t = join(stream);
    return links[stream] = { ...t, send: m => t.send(m), onMessage: fn => t.onMessage(m => { sniff(m); fn(m); }), reopen: () => t.reopen() };
  };
  const clocked = Object.fromEntries(Object.entries({ clock, timers, now, random }).filter(([, v]) => v != null));

  // Room events of each connection (bindEditor's onRoom: presence, here, emotes, records, refused, role, settings,
  // limit) for the collab port (web/adapters/collab/sync.js) and the chrome. A listener gets (stream, event).
  const roomFns = new Set();
  s.onRoom = fn => { roomFns.add(fn); return () => roomFns.delete(fn); };
  const statusFns = new Set();
  /** fn(stream, status) on every status change of either connection. */
  s.onStatus = fn => { statusFns.add(fn); return () => statusFns.delete(fn); };

  for (const stream of ["board", "notes"]) {
    const ed = eds[stream];
    binds[stream] = bindEditor(ed, { transport: watched(stream), token, board, client: `${client}-${stream}`, stream,
      onStatus: st => { s.refreshRole(); for (const fn of [...statusFns]) fn(stream, st); onChange(); },
      onRoom: ev => { if (ev.type === "settings" || ev.type === "limit") onChange(); for (const fn of [...roomFns]) fn(stream, ev); },
      ...clocked });
    const inner = ed.onOp;
    ed.onOp = op => {
      if (!allowed(stream, op)) {
        s.blocked++;
        // p6-uiv L2: say so; a draft or drag dropped silently looks like a bug.
        s.flash = s.readOnly || s.effective === "viewer" ? "Not sent: the room now gives you view-only access" : "Not sent: your role can't make that change";
        binds[stream].reconnect(); onChange(); return;
      }
      if (stream === "notes") for (const el of op.elements ?? []) if (!known.has(el.id)) s.mine.add(el.id);
      if (op.elements?.length || op.appState) s.sent++;
      inner(op);
    };
  }

  // ── role ──
  // Replica.reset() clears its role, so the last one seen is kept. The chrome is set by the first role seen;
  // a lower role later (a downgrade on reconnect) keeps that chrome, greyed (readOnly).
  s.refreshRole = () => {
    const r = lastRole;
    if (!r) return;
    s.roleSeen = r;
    const ui = uiRole(r);
    if (!s.chrome) { s.chrome = ui; s.tool = ui === "viewer" ? "hand" : "select"; applyTool(); }
  };
  Object.defineProperties(s, {
    role: { get: () => s.chrome ?? "viewer" },
    effective: { get: () => uiRole(s.roleSeen) },
    readOnly: { get: () => !!s.chrome && ORDER[uiRole(s.roleSeen)] < ORDER[s.chrome] },
    // The worse of the two streams: stopped (update the app) > refused (sign in) > connecting > catching-up > live.
    status: { get: () => { const a = binds.board.status, b = binds.notes.status; for (const w of ["stopped", "refused", "limited"]) if (a === w || b === w) return w; return a === b ? a : a === "live" ? b : a; } },
    // Either connection's outbound backlog over CONGESTED_BYTES (web/ports/transport.js): the pill says "slow link".
    congested: { get: () => binds.board.congested() || binds.notes.congested() },
    /** The writer-connection cap's message while either connection is stopped by it, else null. */
    limited: { get: () => binds.board.limited ?? binds.notes.limited ?? null },
    /** Refused settings changes of both streams: [{ stream, i, code, keys, values, ready }] (i: the bind's index). */
    settingsRefused: { get: () => ["board", "notes"].flatMap(st => binds[st].settingsRefused.map((e, i) => ({ ...e, stream: st, i }))) },
    pending: { get: () => binds.board.pending + binds.notes.pending },
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

  // Is this note element one the person may change? Presenters moderate every note.
  s.isMine = id => {
    if (s.effective === "presenter") return true;
    const a = authors.get(id) ?? noteAuthor(id);
    if (a != null) return a === (roomUser ?? user);
    return s.mine.has(id);
  };

  function allowed(stream, op) {
    if (!op.elements?.length && !op.appState) return true;          // files only: never sent (sync.js strips them)
    if (!roleMay() || !streamOk(stream)) return false;
    if (stream === "notes" && s.effective !== "presenter") {
      if (op.appState) return false;                                 // a stream's settings are the moderators'
      for (const el of op.elements ?? []) if (known.has(el.id) && !s.isMine(el.id)) return false;
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
    s.act(stream, ed => { id = ed.addImage(file, at); });
    return id;
  };
  /** Picture bytes from elsewhere (the blob relay): shown in both Editors, never sent as an op. */
  s.receiveFiles = files => { for (const ed of Object.values(eds)) { ed.doc.apply({ files }); ed.changed(); } };

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
  s.roomUser = () => roomUser ?? user;

  /** Reconnect both streams now; `token` signs in again after `refused`. */
  s.reconnect = token => { binds.board.reconnect(token); binds.notes.reconnect(token); };
  /** Dev/test hook: both connections drop without asking (the transport's fail(), where it has one). */
  s.dropConnection = () => { for (const t of Object.values(links)) t.fail?.(); };
  /** Test hook: the transports as bindEditor holds them (board, notes). */
  s.links = links;
  return s;
}

const CORE_KEYS = TOOLS, EXTRA_KEYS = EXTRAS;
