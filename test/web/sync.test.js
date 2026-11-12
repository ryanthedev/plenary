// Editor ⇄ Replica binding over the in-process reference room (web/sync.js).
// PLAN.md phase-6 gate: a refused op + resync leaves Editor == Replica. "==" here is strict: every byId
// entry (tombstones, version, versionNonce, content) and appState.herdr, in the Editor, the Replica and
// the room. Every network run is seeded (localRoom's `seed`, or an explicit rng).
import { test, expect } from "bun:test";
import { Editor, TOOLS } from "../../packages/core/editor.js";
import { bindEditor, localRoom, editorState, seeded } from "../../web/sync.js";

const USERS = {
  owner: { user: "u0", role: "owner" }, ed: { user: "u1", role: "editor" }, view: { user: "u2", role: "viewer" },
  ann: { user: "u3", role: "annotator" }, ann2: { user: "u4", role: "annotator" },
};

function setup(tokens = ["owner", "ed"], { seed = 1, stream = "board" } = {}) {
  const net = localRoom({ users: USERS, seed });
  const peers = tokens.map((token, i) => {
    const editor = new Editor(), transport = net.join();
    const sync = bindEditor(editor, { transport, token, board: "b1", client: `p${i}`, stream });
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
  const tr = { send: m => sent.push(JSON.parse(JSON.stringify(m))), onMessage: fn => { deliver = fn; } };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0 });
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

function fakeTimers() {
  const q = new Map(); let n = 0;
  return { set: fn => { q.set(++n, fn); return n; }, clear: h => q.delete(h), fire() { const fns = [...q.values()]; q.clear(); fns.forEach(f => f()); }, get size() { return q.size; } };
}

test("a lost welcome: the watchdog starts over and the board loads (M3)", () => {
  const net = localRoom({ users: USERS }), t = net.join(), timers = fakeTimers();
  let dropped = false;
  const tr = { ...t, onMessage: fn => t.onMessage(m => { if (m.t === "welcome" && !dropped) { dropped = true; return; } fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", timers });
  net.settle();
  expect(s.status).toBe("connecting");
  timers.fire(); net.settle();
  expect(s.status).toBe("live");
  expect(timers.size).toBe(0);                                      // nothing outstanding: no timer left
});

test("a lost ack and entry: the op is resent on timeout, logged once (M3, rule 2)", () => {
  const net = localRoom({ users: USERS }), timers = fakeTimers();
  const t = net.join(); let lose = false;
  const tr = { ...t, onMessage: fn => t.onMessage(m => { if (lose && (m.t === "ack" || m.t === "entries")) return; fn(m); }) };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "owner", board: "b1", timers });
  net.settle();
  lose = true; drag(ed, "rectangle", { x: 0, y: 0 }, { x: 40, y: 40 }); net.settle(); lose = false;
  expect(s.pending).toBe(1);
  timers.fire(); net.settle();
  expect(s.pending).toBe(0);
  expect(net.log.entries.length).toBe(1);
  expect(s.diff()).toEqual([]);
});

test("ops made before welcome or during catch-up are sent once caught up, in order", () => {
  const net = localRoom({ users: USERS });
  const first = new Editor(), s0 = bindEditor(first, { transport: net.join(), token: "owner", board: "b1" });
  net.settle();
  for (let i = 0; i < 5; i++) drag(first, "rectangle", { x: i * 60, y: 0 }, { x: i * 60 + 50, y: 40 });
  net.settle();
  const late = new Editor(), s1 = bindEditor(late, { transport: net.join(), token: "ed", board: "b1" });
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
  const ed = new Editor(), sync = bindEditor(ed, { transport: t, token: "ed", board: "b1" });
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
  const net = localRoom({ users: USERS });
  const ed = new Editor(), sync = bindEditor(ed, { transport: net.join(), token: "nope", board: "b1" });
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
  const tr = { send: m => sent.push(JSON.parse(JSON.stringify(m))), onMessage: fn => { deliver = fn; } };
  const ed = new Editor(), s = bindEditor(ed, { transport: tr, token: "x", board: "b1", client: "c", timeoutMs: 0 });
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
