// Editor ⇄ Replica binding over the in-process reference room (web/sync.js).
// Phase-6 gate: a refused op + resync leaves Editor == Replica. "==" here is strict: every byId
// entry (tombstones, version, versionNonce, content) and appState.herdr, in the Editor, the Replica and
// the room. Every network run is seeded (localRoom's `seed`, or an explicit rng).
import { test, expect } from "bun:test";
import { Editor, TOOLS } from "../../packages/core/editor.js";
import { bindEditor, editorState, seeded } from "../../web/core/sync.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { browserClock } from "../../web/adapters/clock/browser.js";
import { PRESENCE_BACKLOG_BYTES } from "../../web/ports/transport.js";
import { BACKOFF } from "../../packages/protocol/envelope.js";

/** Polls (real timers) until `fn()` is truthy; a failing test stops waiting at `ms`, a passing one never waits for it. */
async function until(fn, what, ms = 15_000) {
  for (const end = Date.now() + ms; !fn(); await new Promise(r => setTimeout(r, 5))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

const USERS = {
  owner: { user: "u0", role: "owner" }, ed: { user: "u1", role: "editor" }, view: { user: "u2", role: "viewer" },
  ann: { user: "u3", role: "annotator" }, ann2: { user: "u4", role: "annotator" },
};

// The network's virtual clock for a binding: the Replica's deadlines and backoff run on it, and settle() fires them.
const clocked = net => ({ clock: net.clock });

function setup(tokens = ["owner", "ed"], { seed = 1, stream = "board" } = {}) {
  const net = localRoom({ users: USERS, seed, clock: true });
  const peers = tokens.map((token, i) => {
    const editor = new Editor(), transport = net.join();
    const sync = bindEditor(editor, { transport, token, board: "b1", client: `p${i}`, stream, ...clocked(net) });
    return { editor, sync, transport };
  });
  net.settle();
  return { net, peers };
}

// Strict: Editor == Replica == room for every peer, nothing outstanding.
function expectConverged(net, peers, stream = "board") {
  const room = net.full(stream);
  for (const { sync } of peers) {
    expect(sync.status).toBe("live");
    expect(sync.pending).toBe(0);
    expect(sync.diff()).toEqual([]);
    expect(sync.full()).toEqual(room);
  }
}

function drag(ed, tool, from, to, moves = 6, up = true) {
  if (tool) ed.setTool(tool);
  ed.pointerDown(from, {});
  for (let i = 1; i <= moves; i++) ed.pointerMove({ x: from.x + ((to.x - from.x) * i) / moves, y: from.y + ((to.y - from.y) * i) / moves }, {});
  if (up) ed.pointerUp(to, {});
}
const centre = (ed, id) => { const r = ed.doc.get(id); return ed.toScreen({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); };
function box(peer, net, at = { x: 100, y: 100 }) {
  drag(peer.editor, "rectangle", at, { x: at.x + 160, y: at.y + 100 }); peer.editor.key("escape"); net.settle();
  return peer.editor.doc.live().filter(e => e.type === "rectangle").at(-1).id;
}
// Deliver until the refusal has reset the Replica, stopping before catch-up ends (the resync window).
function intoResyncWindow(net, sync) { let n = 0; while (sync.status === "live" && n++ < 200) net.step(() => 0); expect(sync.status).not.toBe("live"); }

// Tools that make elements (core's DRAWING_TOOLS), driven the way a page drives them.
const MAKERS = TOOLS.map(t => t.id).filter(id => ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"].includes(id));
function make(ed, tool, at) {
  if (tool === "text") { ed.setTool("text"); ed.pointerDown(at, {}); ed.setText(`note ${at.x}`); ed.commitText(); return; }
  drag(ed, tool, at, { x: at.x + 70, y: at.y + 50 });
  ed.key("escape");
}

test("every element-making tool in TOOLS is covered", () => {
  expect(MAKERS.sort()).toEqual(["arrow", "diamond", "ellipse", "frame", "freedraw", "line", "rectangle", "text"]);
});

test("the handle never exposes the Replica; role and peek are read-only views", () => {
  const { net, peers } = setup();
  const s = peers[0].sync;
  expect("replica" in s).toBe(false);
  expect(s.role).toBe("owner");
  const id = box(peers[0], net);
  const copy = s.peek(id); copy.x = 9999;
  expect(s.peek(id).x).not.toBe(9999);
  expect(s.peek("nope")).toBeNull();
});

for (const seed of [1, 2, 3, 4, 5]) test(`two Editors converge after interleaved edits with every tool (seed ${seed})`, () => {
  const { net, peers } = setup(["owner", "ed"], { seed });
  const rng = seeded(seed * 101);
  for (let round = 0; round < 60; round++) {
    const { editor } = peers[Math.floor(rng() * 2)];
    const roll = rng(), at = { x: Math.floor(rng() * 600), y: Math.floor(rng() * 400) };
    const live = editor.doc.live().filter(e => !e.containerId);
    if (roll < 0.5 || !live.length) make(editor, MAKERS[Math.floor(rng() * MAKERS.length)], at);
    else if (roll < 0.62) { const el = live[Math.floor(rng() * live.length)]; editor.setTool("select"); editor.select([el.id]); editor.nudge(Math.floor(rng() * 40) - 20, 5); }
    else if (roll < 0.72) { const el = live[Math.floor(rng() * live.length)]; editor.setTool("select"); editor.select([el.id]); const c = editor.toScreen({ x: el.x + (el.width || 1) / 2, y: el.y + (el.height || 1) / 2 }); drag(editor, null, c, { x: c.x + 30, y: c.y - 20 }, 1 + Math.floor(rng() * 20)); }
    else if (roll < 0.8) { editor.select([live[Math.floor(rng() * live.length)].id]); editor.key("backspace"); }
    else if (roll < 0.88) rng() < 0.6 ? editor.undo() : editor.redo();
    else if (roll < 0.94) editor.setAppState({ grid: Math.floor(rng() * 40) });
    else drag(editor, "eraser", at, { x: at.x + 80, y: at.y + 80 });
    for (let k = Math.floor(rng() * 6); k > 0; k--) net.step(rng);   // deliveries interleave with edits
  }
  net.settle(rng);
  for (const p of peers) expect(p.sync.resets).toBe(1);             // nothing was refused
  expect(net.state("board").elements.length).toBeGreaterThan(10);
  expectConverged(net, peers);
});

// ── The gate ────────────────────────────────────────────────────────────────

// A board with edited (version > 1) and deleted elements, so a reload that drops tombstones or versions shows.
function busyBoard(net, a, b) {
  const r = box(a, net, { x: 10, y: 10 }), e = box(a, net, { x: 210, y: 10 }), d = box(b, net, { x: 410, y: 10 });
  for (let i = 0; i < 4; i++) { a.editor.select([r]); a.editor.nudge(1, 0); }
  a.editor.select([e]); a.editor.key("backspace");
  b.editor.select([d]); b.editor.nudge(0, 3);
  a.editor.setAppState({ grid: 20 });
  net.settle();
  expect(net.full().elements[r].version).toBeGreaterThan(4);
  expect(net.full().elements[e].isDeleted).toBe(true);
  return { r, e, d };
}

const REFUSALS = {
  "an unknown board setting (appState)": ({ a }) => a.editor.setAppState({ bogus: 1 }),
  "a bad setting value (appState)": ({ a }) => a.editor.setAppState({ grid: -5 }),
  "an element op (a viewer draws)": ({ v }) => drag(v.editor, "rectangle", { x: 300, y: 300 }, { x: 360, y: 340 }),
  "an element op (a viewer moves an existing shape)": ({ v, ids }) => { v.editor.setTool("select"); v.editor.select([ids.r]); v.editor.nudge(50, 0); },
};

for (const compacted of [false, true]) for (const [name, refuse] of Object.entries(REFUSALS)) for (const seed of [1, 2, 3]) {
  test(`GATE: refusal of ${name} + resync leaves Editor == Replica == room (catch-up by ${compacted ? "snapshot" : "entries"}, seed ${seed})`, () => {
    const { net, peers } = setup(["owner", "ed", "view"], { seed });
    const [a, b, v] = peers;
    const ids = busyBoard(net, a, b);
    if (compacted) net.compact();               // a since-0 hello now gets a snapshot, not entries
    const who = name.includes("viewer") ? v : a;
    drag(a.editor, "diamond", { x: 10, y: 300 }, { x: 80, y: 360 });   // a's valid op, still pending
    refuse({ a, v, ids });
    net.settle(seeded(seed));
    expect(who.sync.resets).toBe(2);           // initial load + the resync
    expect(a.editor.doc.appState.herdr.bogus).toBeUndefined();
    expect(a.editor.doc.live().filter(e => e.type === "diamond").length).toBe(1);   // the valid op survived
    expect(v.editor.doc.get(ids.r).x).toBe(a.editor.doc.get(ids.r).x);               // a viewer's move is undone
    expectConverged(net, peers);
  });
}

for (const seed of [1, 2, 3, 4]) test(`GATE (verifier H1): an edit to an existing element inside the resync window is acked and alive (seed ${seed})`, () => {
  const { net, peers } = setup(["owner", "ed"], { seed });
  const [a, b] = peers;
  const { r } = busyBoard(net, a, b);
  const roomV = net.full().elements[r].version, x0 = net.full().elements[r].x;
  a.editor.setAppState({ bogus: 1 });
  intoResyncWindow(net, a.sync);
  a.editor.select([r]); a.editor.nudge(500, 0);   // the user's edit in the window
  net.settle(seeded(seed));
  const entry = net.log.entries.filter(e => e.op.elements?.some(el => el.id === r)).at(-1);
  expect(entry.op.elements.find(el => el.id === r).version).toBeGreaterThan(roomV);
  for (const p of peers) expect(p.editor.doc.get(r).x).toBe(x0 + 500);
  expect(net.full().elements[r].x).toBe(x0 + 500);
  expectConverged(net, peers);
});

test("GATE: a refusal while a gesture and a text edit are open keeps both (M2) and converges", () => {
  const { net, peers } = setup();
  const [a] = peers, ed = a.editor;
  const id = box(a, net);
  ed.setTool("select"); ed.select([id]);
  const c = centre(ed, id);
  ed.setAppState({ bogus: 1 });
  drag(ed, null, c, { x: c.x + 100, y: c.y + 40 }, 10, false);   // drag open
  net.settle();                                                     // refusal + resync land mid-drag
  expect(a.sync.resets).toBe(2);
  expect(ed.g?.kind).toBe("move");
  for (let i = 0; i < 5; i++) ed.pointerMove({ x: c.x + 110 + i, y: c.y + 40 }, {});
  ed.pointerUp({ x: c.x + 115, y: c.y + 40 }, {});
  net.settle();
  expect(net.full().elements[id].x).toBe(ed.doc.get(id).x);
  expectConverged(net, peers);
  // A text edit open across a refusal: the typing survives and commits.
  ed.setTool("text"); ed.pointerDown({ x: 400, y: 300 }, {}); ed.setText("typing");
  ed.setAppState({ bogus: 2 }); net.settle();
  expect(a.sync.resets).toBe(3);
  expect(ed.text?.value).toBe("typing");
  ed.setText("typing more"); ed.commitText(); net.settle();
  for (const p of peers) expect(p.editor.doc.live().filter(e => e.type === "text").map(e => e.text)).toEqual(["typing more"]);
  expectConverged(net, peers);
});

test("a refused op is undone in the Editor (a viewer draws); undo after it sends nothing", () => {
  const { net, peers } = setup(["owner", "view"]);
  drag(peers[0].editor, "diamond", { x: 0, y: 0 }, { x: 50, y: 50 });
  net.settle();
  const v = peers[1].editor;
  drag(v, "rectangle", { x: 100, y: 100 }, { x: 200, y: 200 });
  expect(v.doc.live().length).toBe(2);        // shown at once
  net.settle();
  expect(v.doc.live().map(e => e.type)).toEqual(["diamond"]);
  const n = net.log.entries.length;
  const r = peers[1].sync.resets;
  v.undo(); net.settle();                     // the refused create's history step was pruned
  expect(net.log.entries.length).toBe(n);
  expect(peers[1].sync.resets).toBe(r);       // no id-less element went out and got refused
  expectConverged(net, peers);
});

test("notes stream: an annotator moving another's note is refused (an element op) and resyncs strictly", () => {
  const { net, peers } = setup(["owner", "ann", "ann2"], { stream: "notes" });
  const [o, n1, n2] = peers;
  const id = box(n1, net, { x: 10, y: 10 });
  n2.editor.setTool("select"); n2.editor.select([id]);
  const c = centre(n2.editor, id);
  drag(n2.editor, null, c, { x: c.x + 100, y: c.y }, 10);
  net.settle();
  expect(n2.sync.resets).toBe(2);
  expect(n2.editor.doc.get(id).x).toBe(n1.editor.doc.get(id).x);
  o.editor.select([id]); o.editor.key("backspace"); net.settle();   // the owner moderates
  expectConverged(net, peers, "notes");
});

// ── Gestures that end without a commit (verifier H2) ──────────────────────────

const ENDS = {
  "up (normal)": (ed, p) => ed.pointerUp(p, {}),
  "escape, then up": (ed, p) => { ed.key("escape"); ed.pointerUp(p, {}); },
  "tool key (r), then up": (ed, p) => { ed.key("r"); ed.pointerUp(p, {}); },
  "setTool(select), then up": (ed, p) => { ed.setTool("select"); ed.pointerUp(p, {}); },
  "undo key mid-drag, then up": (ed, p) => { ed.key("z", { cmd: true }); ed.pointerUp(p, {}); },
  "delete key mid-drag, then up": (ed, p) => { ed.key("backspace"); ed.pointerUp(p, {}); },
  "pointercancel": (ed, p, sync) => sync.cancelGesture(),
  "a second pointer goes down": ed => { ed.pointerDown({ x: 5, y: 5 }, {}); ed.pointerUp({ x: 5, y: 5 }, {}); },
};
const STARTS = {
  move: (ed, id) => { ed.setTool("select"); ed.select([id]); return centre(ed, id); },
  resize: (ed, id) => { ed.setTool("select"); ed.select([id]); const h = ed.handles().find(h => h.kind === "resize" && h.dir === "se"); return { x: h.x, y: h.y }; },
  rotate: (ed, id) => { ed.setTool("select"); ed.select([id]); const h = ed.handles().find(h => h.kind === "rotate"); return { x: h.x, y: h.y }; },
  eraser: (ed, id) => { ed.setTool("eraser"); const c = centre(ed, id); return { x: c.x - 120, y: c.y }; },
  "create rectangle": ed => { ed.setTool("rectangle"); return { x: 700, y: 500 }; },
  "create arrow": ed => { ed.setTool("arrow"); return { x: 700, y: 300 }; },
  "create freedraw": ed => { ed.setTool("freedraw"); return { x: 650, y: 350 }; },
};

test(`every gesture × every ending (${Object.keys(STARTS).length} × ${Object.keys(ENDS).length}): strict equality once it ends, and a peer's later edit lands`, () => {
  const bad = [];
  let seed = 0;
  for (const [sname, start] of Object.entries(STARTS)) for (const [ename, end] of Object.entries(ENDS)) {
    const { net, peers } = setup(["owner", "ed"], { seed: ++seed });
    const [a, b] = peers, ed = a.editor;
    const id = box(a, net);
    const from = start(ed, id), to = { x: from.x + 240, y: from.y + 30 };
    drag(ed, null, from, to, 25, false);
    end(ed, to, a.sync);
    if (ed.g) bad.push(`${sname} | ${ename} | gesture still open`);
    net.settle();
    const d1 = a.sync.diff();
    if (b.editor.doc.get(id)) { b.editor.setTool("select"); b.editor.select([id]); b.editor.nudge(0, 77); net.settle(); }
    const d2 = a.sync.diff(), room = JSON.stringify(net.full());
    const same = JSON.stringify(a.sync.full()) === room && JSON.stringify(b.sync.full()) === room;
    if (d1.length || d2.length || !same || b.sync.diff().length) bad.push(`${sname} | ${ename} | ${[...d1, ...d2][0] ?? "room differs"}`);
  }
  expect(bad).toEqual([]);
});

test("while a gesture is open the Editor may run ahead; the release reconciles it (peer deleted the shape meanwhile)", () => {
  const { net, peers } = setup();
  const [a, b] = peers, ed = a.editor;
  const id = box(a, net);
  ed.setTool("select"); ed.select([id]);
  const c = centre(ed, id);
  drag(ed, null, c, { x: c.x + 200, y: c.y + 50 }, 30, false);
  b.editor.select([id]); b.editor.key("backspace"); net.settle();
  ed.key("escape");                           // core keeps the gesture open until the release
  expect(ed.g?.kind).toBe("move");
  ed.pointerUp({ x: c.x + 200, y: c.y + 50 }, {}); net.settle();
  expect(ed.doc.get(id)).toBeNull();          // the peer's delete shows: the abandoned drag left nothing
  expectConverged(net, peers);
});

test("pointercancel mid-create sends nothing and leaves no element or tombstone (M4, L1)", () => {
  const { net, peers } = setup();
  const ed = peers[0].editor, n = net.log.entries.length;
  drag(ed, "rectangle", { x: 10, y: 10 }, { x: 200, y: 200 }, 20, false);
  expect(ed.doc.live().length).toBe(1);
  peers[0].sync.cancelGesture(); net.settle();
  expect(ed.doc.byId.size).toBe(0);
  expect(net.log.entries.length).toBe(n);
  expectConverged(net, peers);
});

test("bare clicks with every shape tool leave no Editor-only tombstones (L1)", () => {
  const { net, peers } = setup();
  const ed = peers[0].editor;
  for (const tool of MAKERS.filter(t => t !== "text")) { ed.setTool(tool); ed.pointerDown({ x: 600, y: 400 }, {}); ed.pointerUp({ x: 600, y: 400 }, {}); ed.key("escape"); }
  net.settle();
  expectConverged(net, peers);
});

// ── Versions ─────────────────────────────────────────────────────────────────

test("a drag of 1500 moves is acked (core's livePut raises the version per move; sync sends one step)", () => {
  const { net, peers } = setup();
  const ed = peers[0].editor;
  drag(ed, "freedraw", { x: 0, y: 0 }, { x: 300, y: 200 }, 1500);
  net.settle();
  const id = ed.doc.live()[0].id;
  ed.setTool("select"); ed.select([id]);
  const b0 = ed.toScreen({ x: ed.doc.get(id).x, y: ed.doc.get(id).y });
  drag(ed, "select", { x: b0.x + 150, y: b0.y + 100 }, { x: b0.x + 400, y: b0.y + 300 }, 1500);
  net.settle();
  expect(peers[0].sync.resets).toBe(1);
  expect(ed.doc.get(id).version).toBeLessThan(10);
  expectConverged(net, peers);
});

test("pointer move, resize and rotate of a labelled shape with a bound arrow; no duplicate ids reach the room", () => {
  const { net, peers } = setup();
  const [a, b] = peers, ed = a.editor;
  const ops = []; const inner = ed.onOp; ed.onOp = op => { ops.push(op); inner(op); };
  drag(ed, "rectangle", { x: 100, y: 100 }, { x: 260, y: 200 }, 40);
  const shape = ed.doc.live().find(e => e.type === "rectangle");
  ed.setTool("select"); ed.select([shape.id]); ed.key("enter"); ed.setText("label"); ed.commitText();
  drag(ed, "arrow", { x: 500, y: 150 }, { x: 262, y: 150 }, 60);
  ed.key("escape"); net.settle();
  const arrow = ed.doc.live().find(e => e.type === "arrow");
  expect(arrow.endBinding?.elementId).toBe(shape.id);
  ed.setTool("select"); ed.select([shape.id]);
  const c = centre(ed, shape.id);
  drag(ed, "select", c, { x: c.x + 30, y: c.y + 90 }, 1200);
  net.settle();
  for (const kind of ["resize", "rotate"]) {
    ed.setTool("select"); ed.select([shape.id]);
    const h = ed.handles().find(h => (kind === "rotate" ? h.kind === "rotate" : h.kind === "resize" && h.dir === "se"));
    drag(ed, "select", { x: h.x, y: h.y }, { x: h.x + 60, y: h.y + 40 }, 1100);
    net.settle();
  }
  // Core does list an element twice in one op (settleArrows); none of those duplicates reach the room.
  expect(ops.some(o => !o.transient && o.elements && new Set(o.elements.map(e => e.id)).size < o.elements.length)).toBe(true);
  for (const e of net.log.entries) if (e.op.elements) expect(new Set(e.op.elements.map(x => x.id)).size).toBe(e.op.elements.length);
  expect(a.sync.resets).toBe(1);
  expect(b.editor.doc.get(arrow.id).endBinding?.elementId).toBe(shape.id);
  expectConverged(net, peers);
});

test("pictures stay out of ops (the room refuses files) but stay in the Editor across a resync", () => {
  const { net, peers } = setup();
  const ed = peers[0].editor;
  ed.addImage({ mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=" }, { x: 50, y: 50 });
  net.settle();
  expect(peers[0].sync.resets).toBe(1);
  expect(net.log.entries.every(e => !e.op.files)).toBe(true);
  expect(peers[1].editor.doc.live().map(e => e.type)).toEqual(["image"]);
  ed.setAppState({ bogus: 1 }); net.settle();
  expect(peers[0].sync.resets).toBe(2);
  expect(Object.keys(ed.doc.files).length).toBe(1);
  expectConverged(net, peers);
});

// ── Connecting (rule 2), timeouts (M3) ─────────────────────────────────────────

test("rule 2: the hello goes alone; unacked ops are resent after welcome, never-sent ones after catch-up (M1)", () => {
  const sent = []; let deliver;
  const tr = { send: m => sent.push(JSON.parse(JSON.stringify(m))), onMessage: fn => { deliver = fn; }, reopen: () => {} };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0, clock: virtualClock() });
  expect(sent.map(m => m.t)).toEqual(["hello"]);
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 });           // before welcome: held
  expect(sent.filter(m => m.t === "op")).toEqual([]);
  deliver({ t: "welcome", seq: 1, role: "editor", user: "u1" });
  expect(sent.filter(m => m.t === "op")).toEqual([]);               // still catching up (seq 1 not applied)
  const peerEl = { ...JSON.parse(JSON.stringify(ed.doc.live()[0])), id: "peer1", version: 1, versionNonce: 7 };
  deliver({ t: "entries", entries: [{ seq: 1, board: "b1", tenant: "t1", stream: "board", op: { elements: [peerEl] }, by: "u0", id: "o:1" }] });
  const op = sent.filter(m => m.t === "op");
  expect(op.length).toBe(1);
  expect(s.status).toBe("live");
  s.reconnect();                                                    // the link drops before the ack
  expect(sent.at(-1).t).toBe("hello");                              // no op rides with the hello
  deliver({ t: "welcome", seq: 1, role: "editor", user: "u1" });
  expect(sent.at(-1).id).toBe(op[0].id);                            // resent after welcome, same id
});

// Deliver everything queued, firing no timer (the virtual clock stands still).
const drain = net => { while (net.step()); };

test("a lost welcome: the Replica's connect watchdog starts over and the board loads (M3)", () => {
  const net = localRoom({ users: USERS, clock: true }), t = net.join();
  let dropped = false;
  const tr = { ...t, onMessage: fn => t.onMessage(m => { if (m.t === "welcome" && !dropped) { dropped = true; return; } fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  drain(net);
  expect(s.status).toBe("connecting");
  net.settle();
  expect(net.now()).toBeGreaterThanOrEqual(10_000);                 // it waited for the 10 s watchdog
  expect(s.status).toBe("live");
  expect(net.pendingTimers).toBe(0);                                // nothing outstanding: no timer left
});

test("a lost ack and entry: the op times out, a new connection resends it, logged once (M3, rule 2)", () => {
  const net = localRoom({ users: USERS, clock: true });
  const t = net.join(); let lose = false;
  const tr = { ...t, onMessage: fn => t.onMessage(m => { if (lose && (m.t === "ack" || m.t === "entries")) return; fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  net.settle();
  lose = true; drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 }); drain(net); lose = false;
  expect(s.pending).toBe(1);
  net.settle();
  expect(s.pending).toBe(0);
  expect(s.resets).toBe(2);
  expect(net.log.entries.length).toBe(1);
  expect(s.diff()).toEqual([]);
});

test("M1 (p6-basev): a lost ack on a busy board still reconnects about 10 s after the send", () => {
  const net = localRoom({ users: USERS, clock: true });
  const peer = new Editor(), sp = bindEditor(peer, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  const t = net.join(); let lose = false;
  const tr = { ...t, onMessage: fn => t.onMessage(m => { if (lose && (m.t === "ack" || m.t === "entries")) return; fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  net.settle();
  lose = true; drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 }); drain(net); lose = false;
  const sentAt = net.now();
  let reconnectedAt = null;
  for (let i = 0; i < 8 && reconnectedAt === null; i++) {          // the peer draws every 2.5 s: messages keep coming
    drag(peer, "ellipse", { x: 100 + i * 30, y: 100 }, { x: 120 + i * 30, y: 130 }); drain(net);
    net.advance(2500); drain(net);
    if (s.resets === 2) reconnectedAt = net.now();
  }
  expect(reconnectedAt).not.toBeNull();
  expect(reconnectedAt - sentAt).toBeLessThanOrEqual(12_500);       // 10 s op timeout + at most 0.5 s backoff, on a 2.5 s grid
  net.settle();
  expect(net.log.entries.filter(e => e.by === "u0").length).toBe(1);
  expectConverged(net, [{ editor: ed, sync: s }, { editor: peer, sync: sp }]);
});

test("M2 (p6-basev): repeated failed connections back off (rule 12), capped at 30 s", () => {
  const net = localRoom({ users: USERS, clock: true }), t = net.join();
  const hellos = [];
  const tr = { ...t, send: m => { if (m.t === "hello") hellos.push(net.now()); t.send(m); }, onMessage: fn => t.onMessage(m => { if (m.t !== "welcome") fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net), random: () => 0.999 });
  for (let i = 0; i < 400; i++) { drain(net); net.advance(1000); }
  expect(s.status).toBe("connecting");
  const waits = hellos.slice(1).map((at, i) => at - hellos[i] - 10_000);   // each try: 10 s connect watchdog, then the backoff
  expect(waits.length).toBeGreaterThan(8);
  for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
  expect(waits[0]).toBeLessThan(2000);
  expect(Math.max(...waits)).toBeGreaterThan(20_000);
  expect(Math.max(...waits)).toBeLessThanOrEqual(30_000);
});

test("ops made before welcome or during catch-up are sent once caught up, in order", () => {
  const net = localRoom({ users: USERS, clock: true });
  const first = new Editor(), s0 = bindEditor(first, { transport: net.join(), token: "owner", board: "b1", ...clocked(net) });
  net.settle();
  for (let i = 0; i < 5; i++) drag(first, "rectangle", { x: i * 60, y: 0 }, { x: i * 60 + 50, y: 40 });
  net.settle();
  const late = new Editor(), s1 = bindEditor(late, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  drag(late, "ellipse", { x: 0, y: 200 }, { x: 50, y: 250 });      // before welcome
  expect(s1.status).toBe("connecting");
  expect(s1.pending).toBe(1);
  net.settle();
  expect(s1.resets).toBe(1);
  expect(late.doc.live().length).toBe(6);
  expectConverged(net, [{ editor: first, sync: s0 }, { editor: late, sync: s1 }]);
});

test("a dropped connection resends pending ops on reconnect; the room dedupes", () => {
  const { net, peers } = setup();
  const t = net.join();
  const ed = new Editor(), sync = bindEditor(ed, { transport: t, token: "ed", board: "b1", ...clocked(net) });
  net.settle();
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 });
  net.step(() => 0.99);                       // some deliveries, then the link drops
  sync.reconnect();
  net.settle();
  expect(net.state("board").elements.length).toBe(1);
  expect(net.log.entries.length).toBe(1);
  expectConverged(net, [...peers, { editor: ed, sync }]);
});

test("a refused token: status refused, nothing sent", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ed = new Editor(), sync = bindEditor(ed, { transport: net.join(), token: "nope", board: "b1", ...clocked(net) });
  net.settle();
  expect(sync.status).toBe("refused");
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 }); net.settle();
  expect(net.log.entries.length).toBe(0);
});

test("editorState stays exported (web/ui uses it)", () => {
  const { peers } = setup();
  expect(editorState(peers[0].editor)).toEqual(peers[0].sync.state());
});

test("verifier's 'no up at all' ending: the Editor runs ahead while open; a release or a next press reconciles", () => {
  for (const finish of ["release", "next press"]) for (const [sname, start] of Object.entries(STARTS)) {
    const { net, peers } = setup();
    const [a, b] = peers, ed = a.editor;
    const id = box(a, net);
    const from = start(ed, id), to = { x: from.x + 240, y: from.y + 30 };
    drag(ed, null, from, to, 25, false);
    net.settle();
    expect(ed.g).not.toBeNull();                       // still open: the user's own drag shows
    if (finish === "release") ed.pointerUp(to, {}); else { ed.pointerDown({ x: 5, y: 5 }, {}); ed.pointerUp({ x: 5, y: 5 }, {}); }
    net.settle();
    expect([sname, finish, a.sync.diff()]).toEqual([sname, finish, []]);
    if (b.editor.doc.get(id)) { b.editor.setTool("select"); b.editor.select([id]); b.editor.nudge(0, 77); net.settle(); expect(ed.doc.get(id)?.y).toBe(b.editor.doc.get(id).y); }
    expectConverged(net, peers);
  }
});

test("a refusal lands mid-gesture, for every gesture kind, ended at once or after more moves", () => {
  for (const more of [0, 5]) for (const [sname, start] of Object.entries(STARTS)) {
    const { net, peers } = setup();
    const [a] = peers, ed = a.editor;
    const id = box(a, net);
    const from = start(ed, id), to = { x: from.x + 120, y: from.y + 30 };
    ed.setAppState({ bogus: 1 });
    drag(ed, null, from, to, 10, false);
    net.settle();
    expect(a.sync.resets).toBe(2);
    for (let i = 1; i <= more; i++) ed.pointerMove({ x: to.x + i * 3, y: to.y }, {});
    ed.pointerUp({ x: to.x + more * 3, y: to.y }, {});
    net.settle();
    expect([sname, more, a.sync.diff()]).toEqual([sname, more, []]);
    expectConverged(net, peers);
  }
});

test("a viewer drags its own refused shape while the refusal lands: no throw, strict equality", () => {
  const { net, peers } = setup(["owner", "view"]);
  const v = peers[1].editor;
  drag(v, "rectangle", { x: 100, y: 100 }, { x: 200, y: 200 });
  const id = v.doc.live()[0].id;
  v.setTool("select"); v.select([id]);
  const c = centre(v, id);
  drag(v, null, c, { x: c.x + 50, y: c.y }, 5, false);
  net.settle();                                        // the refusal lands: the shape is gone mid-drag
  for (let i = 0; i < 3; i++) v.pointerMove({ x: c.x + 60 + i, y: c.y }, {});
  v.pointerUp({ x: c.x + 63, y: c.y }, {});
  net.settle();
  expect(v.doc.live().length).toBe(0);
  expectConverged(net, peers);
});

test("cancelGesture mid-erase clears the pending erase: the next stroke elsewhere deletes nothing", () => {
  const { net, peers } = setup();
  const [a] = peers, ed = a.editor;
  const id = box(a, net);
  ed.setTool("eraser");
  const c = centre(ed, id);
  drag(ed, null, { x: c.x - 120, y: c.y }, { x: c.x + 120, y: c.y }, 20, false);
  a.sync.cancelGesture();
  expect(ed.erasing.size).toBe(0);
  drag(ed, "eraser", { x: 700, y: 700 }, { x: 720, y: 720 }, 5);
  net.settle();
  expect(ed.doc.get(id)).not.toBeNull();
  expectConverged(net, peers);
});

test("settings: own patch unacked across a reconnect, a peer's later patch, then a late ack", () => {
  const sent = []; let deliver;
  const tr = { send: m => sent.push(JSON.parse(JSON.stringify(m))), onMessage: fn => { deliver = fn; }, reopen: () => {} };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0, clock: virtualClock() });
  deliver({ t: "welcome", seq: 0, role: "editor", user: "u1" });
  ed.setAppState({ grid: 10 });
  const mine = sent.filter(m => m.t === "op").at(-1);
  s.reconnect();
  deliver({ t: "welcome", seq: 2, role: "editor", user: "u1" });
  const entry = (seq, op, by, id) => ({ seq, board: "b1", tenant: "t1", stream: "board", op, by, id });
  deliver({ t: "entries", entries: [entry(1, { appState: { grid: 10 } }, "u1", mine.id), entry(2, { appState: { grid: 20 } }, "u0", "o:1")] });
  deliver({ t: "entries", entries: [entry(3, { appState: { snap: true } }, "u0", "o:2")] });
  deliver({ t: "ack", id: mine.id, seq: 1 });
  expect(ed.doc.appState.herdr.grid).toBe(20);
  expect(s.diff()).toEqual([]);
});

// ── Phase 2 (p6-sync2): previews as presence, resends, re-stamps, status ───────────

// A transport that records what the client wrote (as JSON text, i.e. the bytes) and passes it on.
function recorded(t) { const out = []; return { out, tr: { ...t, send: m => { out.push(JSON.stringify(m)); t.send(m); } } }; }

test("a drag in flight goes out as preview presence, never as an op; the peer sees it until the final entry", () => {
  const net = localRoom({ users: USERS, clock: true });
  const { out, tr } = recorded(net.join());
  const a = new Editor(), sa = bindEditor(a, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  const b = new Editor(), sb = bindEditor(b, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  net.settle();
  const id = box({ editor: a }, net);
  const seq = net.seq, sent = out.length;
  a.setTool("select"); a.select([id]);
  const c = centre(a, id);
  drag(a, null, c, { x: c.x + 200, y: c.y }, 5, false);             // open: nothing committed yet
  drain(net);
  const msgs = out.slice(sent).map(m => JSON.parse(m));
  expect(msgs.length).toBeGreaterThan(0);
  expect(msgs.every(m => m.t === "presence" && m.k === "preview" && m.stream === "board")).toBe(true);
  expect(net.seq).toBe(seq);                                        // nothing logged
  expect(net.presence.length).toBeGreaterThan(0);
  expect(net.presence.every(p => p.ok)).toBe(true);                  // every preview passed the gateway's checks
  const seen = sb.previews().find(el => el.id === id);
  expect(seen.x).toBe(a.doc.get(id).x);                              // the peer sees the drag in flight…
  expect(b.doc.get(id).x).not.toBe(seen.x);                          // …over the board, never merged into it
  a.pointerUp({ x: c.x + 200, y: c.y }, {}); net.settle();
  expect(sb.previews().find(el => el.id === id)).toBeUndefined();    // the final op's entry clears it
  expectConverged(net, [{ editor: a, sync: sa }, { editor: b, sync: sb }]);
});

test("a preview of more than 50 elements goes out in pieces the gateway accepts", () => {
  const net = localRoom({ users: USERS, clock: true });
  const a = new Editor(), sa = bindEditor(a, { transport: net.join(), token: "owner", board: "b1", ...clocked(net) });
  const b = new Editor(), sb = bindEditor(b, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  net.settle();
  for (let i = 0; i < 60; i++) { drag(a, "rectangle", { x: (i % 10) * 30, y: Math.floor(i / 10) * 30 }, { x: (i % 10) * 30 + 20, y: Math.floor(i / 10) * 30 + 20 }, 2); a.key("escape"); }
  net.settle();
  a.setTool("select"); a.select(a.doc.live().map(e => e.id));
  const c = centre(a, a.doc.live()[0].id), mark = net.presence.length;
  net.advance(2000);                                                // the preview rate bucket refills
  drag(a, null, c, { x: c.x + 50, y: c.y }, 1, false); drain(net);
  const mine = net.presence.slice(mark);
  expect(mine.map(p => p.msg.elements.length)).toEqual([50, 10]);
  expect(mine.every(p => p.ok)).toBe(true);
  expect(sb.previews().length).toBe(60);
  a.pointerUp({ x: c.x + 50, y: c.y }, {}); net.settle();
  expectConverged(net, [{ editor: a, sync: sa }, { editor: b, sync: sb }]);
});

test("a resend after a resync keeps its bytes, though a peer moved the same shape meanwhile", () => {
  const net = localRoom({ users: USERS, clock: true });
  const peer = new Editor(), sp = bindEditor(peer, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  const t = net.join(); let lose = false;
  const { out, tr } = recorded({ ...t, onMessage: fn => t.onMessage(m => { if (lose && (m.t === "ack" || m.t === "entries")) return; fn(m); }) });
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  net.settle();
  const id = box({ editor: ed }, net);
  lose = true; ed.setTool("select"); ed.select([id]); ed.nudge(30, 0); drain(net); lose = false;
  const first = out.filter(m => JSON.parse(m).t === "op").at(-1);
  peer.setTool("select"); peer.select([id]); peer.nudge(0, 50); drain(net);
  ed.setAppState({ bogus: 1 }); drain(net);                         // refused: the copy is reset (a since-0 resync)
  expect(s.status).not.toBe("live");
  net.compact();                                                    // so catch-up is a snapshot holding the peer's newer copy
  net.settle();
  const again = out.filter(m => m === first);
  expect(again.length).toBe(2);                                     // the same bytes, twice
  expect(s.resets).toBe(2);
  expect(net.log.entries.filter(e => e.by === "u0" && e.op.elements?.some(el => el.id === id)).length).toBe(2);   // the box, the nudge: once
  expectConverged(net, [{ editor: ed, sync: s }, { editor: peer, sync: sp }]);
});

test("a never-sent op made mid-resync is re-stamped past the room's copy when it first goes", () => {
  const { net, peers } = setup(["owner", "ed"]);
  const [a, b] = peers;
  const { out, tr } = recorded(net.join());
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", client: "late", ...clocked(net) });
  net.settle();
  const { r } = busyBoard(net, a, b);
  const roomV = net.full().elements[r].version;
  ed.setAppState({ bogus: 1 });
  intoResyncWindow(net, s);                                         // the Replica is empty now
  ed.select([r]); ed.nudge(5, 0);                                   // stamped against nothing: version 1
  expect(out.filter(m => JSON.parse(m).op?.elements?.some(el => el.id === r))).toEqual([]);   // not sent mid-resync
  net.settle();
  const sent = out.map(m => JSON.parse(m)).filter(m => m.op?.elements?.some(el => el.id === r));
  expect(sent.length).toBe(1);
  expect(sent[0].op.elements.find(el => el.id === r).version).toBe(roomV + 1);
  expectConverged(net, [...peers, { editor: ed, sync: s }]);
});

test("M3 (p6-basev): ops made before welcome survive a reconnect before welcome, and land", () => {
  const net = localRoom({ users: USERS, clock: true });
  const t = net.join(); let mute = true;
  const tr = { ...t, onMessage: fn => t.onMessage(m => { if (!mute) fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 }); ed.key("escape");
  ed.setAppState({ grid: 15 });
  drain(net);
  expect(s.pending).toBe(2);
  s.reconnect(); mute = false;
  drag(ed, "ellipse", { x: 100, y: 0 }, { x: 140, y: 40 }); ed.key("escape");
  net.settle();
  expect(net.log.entries.length).toBe(3);
  expect(net.state().elements.map(e => e.type).sort()).toEqual(["ellipse", "rectangle"]);
  expect(net.state().appState.grid).toBe(15);
  expectConverged(net, [{ editor: ed, sync: s }]);
});

test("L1 (p6-basev): a 1500-move drag committed before welcome is logged, not refused", () => {
  const net = localRoom({ users: USERS, clock: true });
  const first = new Editor(), s0 = bindEditor(first, { transport: net.join(), token: "owner", board: "b1", ...clocked(net) });
  net.settle();
  const id = box({ editor: first }, net);
  const late = new Editor(), s1 = bindEditor(late, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  late.load({ elements: [JSON.parse(JSON.stringify(first.doc.get(id)))] });   // what the user saw before (a reload)
  late.setTool("select"); late.select([id]);
  const c = centre(late, id);
  drag(late, null, c, { x: c.x + 300, y: c.y }, 1500);
  expect(s1.status).toBe("connecting");
  net.settle();
  expect(s1.resets).toBe(1);                                        // never refused
  expect(net.full().elements[id].version).toBeLessThan(10);
  expectConverged(net, [{ editor: first, sync: s0 }, { editor: late, sync: s1 }]);
});

test("L1 (p6-basev): close() leaves no timer, though an op is unanswered", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ed = new Editor(), s = bindEditor(ed, { transport: net.join(), token: "owner", board: "b1", ...clocked(net) });
  net.settle();
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 });
  expect(net.pendingTimers).toBe(1);                                // the op's 10 s timeout
  s.close();
  expect(net.pendingTimers).toBe(0);
});

test("a drag abandoned on a shape whose last commit is still unacked goes back at once (reconcile with a pending op)", () => {
  const { net, peers } = setup();
  const [a, b] = peers, ed = a.editor;
  const id = box(a, net);
  ed.setTool("select"); ed.select([id]); ed.nudge(10, 0);           // committed, not yet acked
  expect(a.sync.pending).toBe(1);
  const c = centre(ed, id);
  drag(ed, null, c, { x: c.x + 200, y: c.y }, 10, false);
  ed.key("escape"); ed.pointerUp({ x: c.x + 200, y: c.y }, {});
  expect(a.sync.diff()).toEqual([]);                                // before any delivery
  net.settle();
  b.editor.setTool("select"); b.editor.select([id]); b.editor.nudge(0, 9); net.settle();
  expect(ed.doc.get(id).y).toBe(b.editor.doc.get(id).y);
  expectConverged(net, peers);
});

test("status: an unknown rules version stops (stopped); a later auth error asks to sign in (refused)", () => {
  for (const [msg, want] of [[{ t: "welcome", seq: 0, role: "editor", user: "u1", rv: 999 }, "stopped"], [{ t: "error", code: "auth", message: "expired" }, "refused"]]) {
    const sent = []; let deliver; const seen = [];
    const tr = { send: m => sent.push(m), onMessage: fn => { deliver = fn; }, reopen: () => {} };
    const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0, clock: virtualClock(), onStatus: st => seen.push(st) });
    if (want === "refused") { deliver({ t: "welcome", seq: 0, role: "editor", user: "u1" }); expect(s.status).toBe("live"); }
    deliver(msg);
    expect(s.status).toBe(want);
    expect(seen.at(-1)).toBe(want);
    drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 });
    expect(sent.filter(m => m.t === "op")).toEqual([]);             // nothing goes out until the app updates / signs in
    expect(s.pending).toBe(1);                                      // kept
  }
});

test("status: another user signing in on this client discards the old user's ops (rule 13), counted", () => {
  const sent = []; let deliver;
  const tr = { send: m => sent.push(m), onMessage: fn => { deliver = fn; }, reopen: () => {} };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0, clock: virtualClock() });
  deliver({ t: "welcome", seq: 0, role: "editor", user: "u1" });
  ed.setAppState({ grid: 10 });
  s.reconnect();
  deliver({ t: "welcome", seq: 0, role: "editor", user: "u9" });
  expect(s.discarded).toBe(1);
  expect(s.pending).toBe(0);
  expect(s.unconfirmed).toBe(0);
});

test("previews: at most the published rate leaves the client; a viewer sends none; a peer's expires after 5 s", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ra = recorded(net.join()), rv = recorded(net.join());
  const a = new Editor(), sa = bindEditor(a, { transport: ra.tr, token: "owner", board: "b1", ...clocked(net) });
  const v = new Editor(), sv = bindEditor(v, { transport: rv.tr, token: "view", board: "b1", ...clocked(net) });
  net.settle();
  const id = box({ editor: a }, net);
  net.advance(2000);
  const sent = ra.out.length;
  a.setTool("select"); a.select([id]);
  const c = centre(a, id);
  drag(a, null, c, { x: c.x + 300, y: c.y }, 100, false);            // 100 moves at one instant
  const previews = ra.out.slice(sent).map(m => JSON.parse(m)).filter(m => m.t === "presence");
  expect(previews.length).toBe(20);                                  // PRESENCE.preview.rate
  drain(net);
  expect(sv.previews().map(el => el.id)).toEqual([id]);
  net.advance(5000);
  expect(sv.previews()).toEqual([]);                                 // expired: no final op came
  a.pointerUp({ x: c.x + 300, y: c.y }, {}); net.settle();
  drag(v, "rectangle", { x: 10, y: 10 }, { x: 90, y: 90 }, 20, false);   // a viewer may not write the board
  expect(rv.out.map(m => JSON.parse(m)).filter(m => m.t === "presence")).toEqual([]);
  v.pointerUp({ x: 90, y: 90 }, {}); net.settle();
  expectConverged(net, [{ editor: a, sync: sa }, { editor: v, sync: sv }]);
});

test("status: a stale answer counts the op as unconfirmed", () => {
  const sent = []; let deliver;
  const tr = { send: m => sent.push(m), onMessage: fn => { deliver = fn; }, reopen: () => {} };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0, clock: virtualClock() });
  deliver({ t: "welcome", seq: 0, role: "editor", user: "u1" });
  ed.setAppState({ grid: 10 });
  const op = sent.filter(m => m.t === "op").at(-1);
  deliver({ t: "error", id: op.id, code: "stale", message: "forgotten" });
  expect(s.unconfirmed).toBe(1);
  expect(s.pending).toBe(0);
});

test("real timers (the page's clock, browserClock): a refusal resyncs after the backoff and converges", async () => {
  const net = localRoom({ users: USERS, auto: true });
  const o = new Editor(), so = bindEditor(o, { transport: net.join(), token: "owner", board: "b1", clock: browserClock() });
  const vt = net.join(), reopen = vt.reopen;
  let reopens = 0;
  vt.reopen = (...a) => { reopens++; return reopen.apply(vt, a); };
  const v = new Editor(), sv = bindEditor(v, { transport: vt, token: "view", board: "b1", clock: browserClock() });
  await until(() => so.status === "live" && sv.status === "live", "both bindings live");
  drag(o, "diamond", { x: 0, y: 0 }, { x: 50, y: 50 });
  drag(v, "rectangle", { x: 100, y: 100 }, { x: 200, y: 200 });
  // The refusal's backoff runs on real timers (~0.25-0.5 s): wait for the outcome, not for a guessed time. Not on the
  // reset count: the refusal makes the viewer "connecting" at once (goDown) and the local room delivers in microtasks,
  // so once both are live with nothing pending every message-driven resync has happened; a timer-driven one is waited out below.
  await until(() => sv.status === "live" && sv.pending === 0 && so.pending === 0, "the refused viewer to resync and both to settle");
  expect([sv.resets, reopens]).toEqual([2, 1]);                          // the first welcome, then exactly one resync
  // A resync a timer brings later (a backoff armed twice, say) would come within one backoff window, at most
  // BACKOFF.baseMs × 2^1 = 1 s after a single refusal: wait out twice that (a settle only lengthens the test) and look again.
  await new Promise(res => setTimeout(res, 2 * BACKOFF.baseMs * 2));
  expect([sv.resets, reopens, sv.status]).toEqual([2, 1, "live"]);
  expectConverged(net, [{ editor: o, sync: so }, { editor: v, sync: sv }]);
  so.close(); sv.close();
});

// ── p6-land: the transport contract (web/sync.js header), drops, per-stream previews, signing in again ──

test("contract: reopen() is required; a resync never calls close(); only the handle's close() does, once", () => {
  expect(() => bindEditor(new Editor(), { transport: { send() {}, onMessage() {} }, token: "x", board: "b1" })).toThrow(/reopen/);
  const net = localRoom({ users: USERS, clock: true });
  const calls = [];
  const spy = t => ({ ...t, reopen: () => { calls.push("reopen"); t.reopen(); }, close: () => { calls.push("close"); t.close(); } });
  const o = new Editor(), so = bindEditor(o, { transport: spy(net.join()), token: "owner", board: "b1", ...clocked(net) });
  const v = new Editor(), sv = bindEditor(v, { transport: spy(net.join()), token: "view", board: "b1", ...clocked(net) });
  net.settle();
  drag(v, "rectangle", { x: 0, y: 0 }, { x: 50, y: 50 });            // refused: rule 5, resync
  net.settle();
  expect(sv.resets).toBe(2);
  expect(calls).toEqual(["reopen"]);
  drag(o, "ellipse", { x: 0, y: 0 }, { x: 50, y: 50 }); net.settle();
  expectConverged(net, [{ editor: o, sync: so }, { editor: v, sync: sv }]);
  sv.close(); sv.close();
  expect(calls).toEqual(["reopen", "close"]);
  expect(net.pendingTimers).toBe(0);                                 // nothing outstanding, and the closed one arms nothing
});

test("contract: nothing of the old connection is delivered after reopen() (localRoom's generation)", () => {
  const net = localRoom({ users: USERS, clock: true });
  const t = net.join(), got = [];
  t.onMessage(m => got.push(m.t));
  t.send({ t: "hello", v: 1, token: "owner", board: "b1", since: 0, client: "c" });
  while (net.step()) if (got.length) break;                         // the welcome is out; more is queued
  t.reopen();
  const before = got.length;
  net.settle();
  expect(got.length).toBe(before);                                  // the old connection's snapshot/entries: gone
});

test("drops before welcome back off (rule 12: 500, 1000, 2000, 4000 ms with the jitter fixed), keep the ops, then land", () => {
  const net = localRoom({ users: USERS, clock: true });
  const t = net.join(), hellos = [];
  const tr = { ...t, send: m => { if (m.t === "hello") hellos.push(net.now()); t.send(m); } };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net), random: () => 0 });
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 });           // made before any welcome
  for (let i = 0; i < 4; i++) {
    t.fail();                                                        // the socket closes before welcome
    expect(s.status).toBe("connecting");
    const n = hellos.length;
    while (hellos.length === n) expect(net.tick()).toBe(true);       // the backoff timer reopens (no deliveries)
  }
  const gaps = hellos.slice(1).map((at, i) => at - hellos[i]);
  expect(gaps).toEqual([500, 1000, 2000, 4000]);
  expect(s.pending).toBe(1);
  net.settle();
  expect(s.status).toBe("live");
  expect(net.state().elements.map(e => e.type)).toEqual(["rectangle"]);
  expect(s.diff()).toEqual([]);
});

test("a drop on a live connection reconnects after the backoff and converges", () => {
  const { net, peers } = setup();
  const [a, b] = peers;
  box(a, net);
  a.transport.fail();
  expect(a.sync.status).toBe("connecting");
  expect(net.pendingTimers).toBeGreaterThan(0);
  a.transport.fail();                                                // already down: the transport has no connection, so no report
  drag(a.editor, "ellipse", { x: 300, y: 300 }, { x: 360, y: 340 }); // made while down: held
  drag(b.editor, "diamond", { x: 500, y: 100 }, { x: 560, y: 160 });
  net.settle();
  expect(a.sync.resets).toBe(2);
  expect(net.state().elements.length).toBe(3);
  expectConverged(net, peers);
});

test("reconnect() and Retry work after a resync, and a refused sign-in can sign in again with a new token", () => {
  const net = localRoom({ users: USERS, clock: true });
  const t = net.join(), hello = [];
  const tr = { ...t, send: m => { if (m.t === "hello") hello.push(m.token); t.send(m); } };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "nobody", board: "b1", ...clocked(net) });
  net.settle();
  expect(s.status).toBe("refused");
  t.fail(); net.settle();                                            // the server closing after `auth`: no retry loop
  expect(s.status).toBe("refused");
  expect(hello).toEqual(["nobody"]);                                 // no second hello with the refused token
  drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 });
  expect(s.pending).toBe(1);
  s.reconnect("owner"); net.settle();
  expect(hello).toEqual(["nobody", "owner"]);
  expect(s.status).toBe("live");
  expect(net.state().elements.length).toBe(1);
  ed.setAppState({ bogus: 1 }); net.settle();                        // refused: resync
  expect(s.resets).toBe(2);                                          // live once after sign-in, once after the resync
  s.reconnect(); net.settle();
  drag(ed, "ellipse", { x: 100, y: 100 }, { x: 150, y: 150 }); net.settle();
  expect(s.status).toBe("live");
  expect(net.state().elements.length).toBe(2);
  expect(s.diff()).toEqual([]);
});

test("previews are per stream: a notes-bound handle never lists a board drag, and the other way round", () => {
  const net = localRoom({ users: USERS, clock: true });
  const a = new Editor(), sa = bindEditor(a, { transport: net.join(), token: "owner", board: "b1", ...clocked(net) });
  const bn = new Editor(), sbn = bindEditor(bn, { transport: net.join(), token: "ed", board: "b1", stream: "notes", ...clocked(net) });
  const bb = new Editor(), sbb = bindEditor(bb, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  net.settle();
  const id = box({ editor: a }, net);
  net.advance(2000);
  a.setTool("select"); a.select([id]);
  const c = centre(a, id);
  drag(a, null, c, { x: c.x + 100, y: c.y }, 5, false);
  drain(net);
  expect(sbb.previews().map(el => el.id)).toEqual([id]);
  expect(sbn.previews()).toEqual([]);
  a.pointerUp({ x: c.x + 100, y: c.y }, {}); net.settle();
  expect(sbb.previews()).toEqual([]);
  expect(sa.status).toBe("live");
});

test("a drop report is ignored while down, after stopped, and after close: no extra hello, no extra wait", () => {
  for (const when of ["down", "stopped", "closed"]) {
    const sent = []; let deliver, drop;
    const tr = { send: m => sent.push(m), onMessage: fn => { deliver = fn; }, onDrop: fn => { drop = fn; }, reopen() {}, close() {} };
    const timers = new Map(); let h = 0, t = 0;
    const clock = { set: (fn, ms) => { timers.set(++h, { fn, at: t + ms }); return h; }, clear: k => timers.delete(k) };
    const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timers: clock, now: () => t, random: () => 0 });
    deliver({ t: "welcome", seq: 0, role: "editor", user: "u1" });
    expect(s.status).toBe("live");
    if (when === "down") drop();                                     // the first drop: down, one backoff timer
    if (when === "stopped") deliver({ t: "error", code: "version", message: "too new" });
    if (when === "closed") s.close();
    const before = { timers: [...timers.values()].map(x => x.at), hellos: sent.filter(m => m.t === "hello").length, status: s.status };
    drop(); drop();
    expect([...timers.values()].map(x => x.at)).toEqual(before.timers);
    expect(sent.filter(m => m.t === "hello").length).toBe(before.hellos);
    expect(s.status).toBe(before.status);
    if (when === "down") { expect(before.timers).toEqual([500]); for (const x of [...timers.values()]) x.fn(); expect(sent.filter(m => m.t === "hello").length).toBe(2); }
  }
});

test("no global fallback: bindEditor without a clock (or now, random, timers) throws; timeoutMs 0 needs no timers", () => {
  const net = localRoom({ users: USERS, clock: true });
  const bind = o => bindEditor(new Editor(), { transport: net.join(), token: "owner", board: "b1", ...o });
  expect(() => bind({})).toThrow(TypeError);
  expect(() => bind({ now: net.now, timers: net.timers })).toThrow(TypeError);            // no random
  expect(() => bind({ now: net.now, random: net.random })).toThrow(TypeError);            // no timers
  expect(() => bind({ now: net.now, random: net.random, timeoutMs: 0 })).not.toThrow();
  expect(() => bind({ clock: net.clock })).not.toThrow();
});

// Presence gate (manager decision, p6-edge2v M1): a drag preview (presence k: "preview") goes out only while the
// transport's backlog is <= PRESENCE_BACKLOG_BYTES; hello and real ops are never gated.
test("presence gate: over 16 KB of backlog no preview is sent, but the commit and a reconnect's hello are", () => {
  const net = localRoom({ users: USERS, clock: true });
  let backlog = 0;
  const sent = [];
  const inner = net.join();
  const tr = { ...inner, send: m => { sent.push(m); inner.send(m); }, backlogBytes: () => backlog };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", ...clocked(net) });
  const peer = new Editor(), sp = bindEditor(peer, { transport: net.join(), token: "ed", board: "b1", ...clocked(net) });
  net.settle();
  drag(ed, "rectangle", { x: 10, y: 10 }, { x: 110, y: 90 });
  net.settle();
  const id = ed.doc.live()[0].id;
  const previews = () => sent.filter(m => m.t === "presence" && m.k === "preview").length;
  const ops = () => sent.filter(m => m.t === "op").length;

  // Under the gate (exactly at it counts as under): a move sends previews.
  backlog = PRESENCE_BACKLOG_BYTES;
  let p0 = previews();
  ed.setTool("select"); ed.select([id]);
  drag(ed, null, centre(ed, id), { x: 300, y: 300 }, 6, false);
  expect(previews()).toBeGreaterThan(p0);
  ed.pointerUp({ x: 300, y: 300 }, {});
  net.settle();

  // Over the gate: the move sends no preview at all; the commit (a real op) still goes out and lands.
  backlog = PRESENCE_BACKLOG_BYTES + 1;
  p0 = previews();
  const o0 = ops();
  ed.select([id]);
  drag(ed, null, centre(ed, id), { x: 500, y: 400 }, 6, false);
  expect(previews()).toBe(p0);
  ed.pointerUp({ x: 500, y: 400 }, {});
  expect(ops()).toBeGreaterThan(o0);
  net.settle();
  expect(s.pending).toBe(0);
  expect(sp.peek(id).x).toBe(s.peek(id).x);

  // A reconnect while congested: the hello is never gated.
  const h0 = sent.filter(m => m.t === "hello").length;
  s.reconnect();
  expect(sent.filter(m => m.t === "hello").length).toBe(h0 + 1);
  net.settle();
  expect(s.status).toBe("live");
  s.close(); sp.close();
});
