// p8-one-link (p7-audit C-3, C-12, and room for hello.tab): one transport, one Replica, one hello and one snapshot
// per tab; both Editors (board, notes) bound to their own streams of that one link.
import { test, expect } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession, mintTab } from "../../web/core/session.js";
import { editorState } from "../../web/core/sync.js";

const USERS = {
  "t-ada": { user: "ada", role: "owner" }, "t-bo": { user: "bo", role: "editor" },
  "t-cy": { user: "cy", role: "annotator" }, "t-ed": { user: "ed", role: "viewer" },
  "t-di": { user: "di", role: "annotator" },
};

/** A session over `net` whose transports are counted: joins, hellos sent, snapshots and bytes received. */
function counted(net, token, o = {}) {
  const c = { joins: 0, hellos: [], snapshots: 0, bytes: 0, ops: [], reopens: 0 };
  const join = () => {
    c.joins++;
    const t = net.join();
    const send = t.send, on = t.onMessage, reopen = t.reopen;
    t.send = m => { if (m.t === "hello") c.hellos.push(m); if (m.t === "op") c.ops.push(m); send(m); };
    t.onMessage = fn => on(m => { if (m.t === "snapshot") c.snapshots++; c.bytes += JSON.stringify(m).length; fn(m); });
    t.reopen = () => { c.reopens++; reopen(); };
    return t;
  };
  const s = createSession({ join, token, board: "b1", client: token, user: USERS[token].user, clock: net.clock, ...o });
  s.setSize(1000, 700);
  return { s, c };
}
/** p8-one-linkv H1: a session whose sent ops are collected (c.ops) and whose message handler is reachable
 *  (c.deliver), so a test can answer one of its ops as the room would. */
function tab(net, token) {
  const c = { ops: [], deliver: null };
  const join = () => {
    const t = net.join();
    const send = t.send, on = t.onMessage;
    t.send = m => { if (m.t === "op") c.ops.push(m); send(m); };
    t.onMessage = fn => { c.deliver = fn; on(fn); };
    return t;
  };
  const s = createSession({ join, token, board: "b1", client: token, user: USERS[token].user, clock: net.clock });
  s.setSize(1000, 700);
  return { s, c };
}
const drag = (s, a, b) => { s.pointerDown(a); for (let i = 1; i <= 4; i++) s.pointerMove({ x: a.x + (b.x - a.x) * i / 4, y: a.y + (b.y - a.y) * i / 4 }); s.pointerUp(b); };

/** A board with shapes and notes, made by ada; returns the room. */
function busyBoard() {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada").s;
  net.settle();
  for (let i = 0; i < 5; i++) { ada.setTool("rectangle"); drag(ada, { x: 20 + i * 60, y: 20 }, { x: 60 + i * 60, y: 60 }); }
  for (let i = 0; i < 3; i++) ada.placeNote({ x: 100 + i * 200, y: 300 }, `note ${i}`);
  net.settle();
  expect(ada.status).toBe("live");
  net.compact();                                   // a joiner gets a snapshot (not the whole log as entries)
  return { net, ada };
}

test("one link per tab: one join, one hello, one snapshot, and both Editors loaded from it", () => {
  const { net, ada } = busyBoard();
  for (const token of ["t-ed", "t-cy", "t-bo"]) {
    const { s, c } = counted(net, token);
    net.settle();
    expect(s.status).toBe("live");
    expect(c.joins).toBe(1);
    expect(c.hellos.length).toBe(1);
    expect(c.snapshots).toBe(1);
    expect(s.binds.board.client).toBe(s.binds.notes.client);           // one wire client id
    for (const st of ["board", "notes"]) expect(editorState(s.eds[st])).toEqual(editorState(ada.eds[st]));
    expect(s.eds.board.doc.live().length).toBe(5);
    expect(s.eds.notes.doc.live().length).toBe(6);                      // 3 notes: shape + label each
    expect(s.binds.board.resets).toBe(1);
    expect(s.binds.notes.resets).toBe(1);
  }
});

test("each Editor writes and reads only its own stream of the one link", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada"), bo = counted(net, "t-bo");
  net.settle();
  ada.s.setTool("rectangle"); drag(ada.s, { x: 10, y: 10 }, { x: 80, y: 80 });
  ada.s.placeNote({ x: 300, y: 300 }, "hello");
  net.settle();
  const streams = ada.c.ops.map(m => [m.stream, (m.op.elements ?? []).map(e => e.type).sort().join("+")]);
  expect(streams.filter(([st]) => st === "board").every(([, t]) => t === "rectangle")).toBe(true);
  expect(streams.some(([st, t]) => st === "notes" && t.includes("text"))).toBe(true);
  expect(bo.s.eds.board.doc.live().map(e => e.type)).toEqual(["rectangle"]);
  expect(bo.s.eds.notes.doc.live().map(e => e.type).sort()).toEqual(["rectangle", "text"]);
  for (const st of ["board", "notes"]) { expect(bo.s.binds[st].diff()).toEqual([]); expect(ada.s.binds[st].diff()).toEqual([]); }
});

test("reconnect and a drop: one reopen and one hello for the tab; ops of both streams kept and landed", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada"), bo = counted(net, "t-bo");
  net.settle();
  ada.s.reconnect();
  net.settle();
  expect(ada.c.reopens).toBe(1);
  expect(ada.c.hellos.length).toBe(2);
  // Offline edits on both streams, then the link drops: both are resent on the next connection.
  ada.s.dropConnection();
  ada.s.setTool("rectangle"); drag(ada.s, { x: 10, y: 10 }, { x: 80, y: 80 });
  ada.s.placeNote({ x: 300, y: 300 }, "while down");
  expect(ada.s.pending).toBeGreaterThan(0);
  net.settle();
  expect(ada.s.status).toBe("live");
  expect(ada.s.pending).toBe(0);
  expect(ada.c.joins).toBe(1);
  expect(ada.c.reopens).toBe(2);
  expect(ada.c.hellos.length).toBe(3);
  expect(bo.s.eds.board.doc.live().length).toBe(1);
  expect(bo.s.eds.notes.doc.live().length).toBe(2);
});

test("pending counts the one link once (not per bind)", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada");
  net.settle();
  ada.s.dropConnection();
  ada.s.setTool("rectangle"); drag(ada.s, { x: 10, y: 10 }, { x: 80, y: 80 });
  expect(ada.s.pending).toBe(ada.s.binds.board.pending);
  expect(ada.s.pending).toBe(1);
});

test("a refused settings change goes to its own stream's bind", () => {
  const sent = []; let deliver = () => {};
  const t = { send: m => sent.push(m), onMessage: fn => { deliver = fn; }, reopen() {}, close() {}, congested: () => false, backlogBytes: () => 0 };
  const clock = { now: () => 0, mono: () => 0, random: () => 0.5, set: () => 0, clear: () => {} };
  const s = createSession({ join: () => t, token: "tk", board: "b1", client: "me", user: "me", clock });
  deliver({ t: "welcome", seq: 0, role: "owner", user: "me", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });
  s.eds.board.onOp({ appState: { timeline: { duration: 5000 } } });
  s.eds.notes.onOp({ appState: { grid: 20 } });
  const ops = sent.filter(m => m.t === "op");
  expect(ops.map(m => m.stream)).toEqual(["board", "notes"]);
  for (const o of ops) deliver({ t: "error", id: o.id, code: "stale-setting", message: "base moved" });
  expect(s.binds.board.settingsRefused.map(e => e.keys)).toEqual([["timeline"]]);
  expect(s.binds.notes.settingsRefused.map(e => e.keys)).toEqual([["grid"]]);
  expect(s.settingsRefused.map(e => [e.stream, e.i, e.keys[0]])).toEqual([["board", 0, "timeline"], ["notes", 0, "grid"]]);
});

test("tab: minted once per session from the clock's random, kept in s.tab, and sent in every hello (p7-tab)", () => {
  const { net } = busyBoard();
  const a = counted(net, "t-ed"), b = counted(net, "t-cy");
  net.settle();
  expect(a.s.tab).toMatch(/^[0-9a-z]{16}$/);
  expect(b.s.tab).toMatch(/^[0-9a-z]{16}$/);
  expect(a.s.tab).not.toBe(b.s.tab);
  a.s.reconnect(); net.settle();
  expect(a.s.tab).toMatch(/^[0-9a-z]{16}$/);
  for (const h of a.c.hellos) expect(h.tab).toBe(a.s.tab);
  for (const h of b.c.hellos) expect(h.tab).toBe(b.s.tab);
  expect(a.c.hellos.length).toBe(2);
  // Given: kept as is. From the clock port's random only (a fixed random gives a fixed id).
  const c = counted(net, "t-bo", { tab: "given-tab" });
  expect(c.s.tab).toBe("given-tab");
  expect(mintTab(() => 0.5)).toBe(mintTab(() => 0.5));
  expect(mintTab(() => 0)).toBe("0000000000000000");
});

test("C-12: the session reads the room through the link (role, welcome.user, note authors), not a transport sniffer", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada"), cy = counted(net, "t-cy", { user: "shown-not-room" });
  net.settle();
  expect(cy.s.role).toBe("annotator");
  expect(cy.s.roomUser()).toBe("cy");                                  // welcome.user, not the root's display user
  ada.s.placeNote({ x: 100, y: 100 }, "ada's");
  net.settle();
  const id = cy.s.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  expect(cy.s.isMine(id)).toBe(false);
  // A write to someone else's sequenced note never leaves (the backstop), whatever the UI let through.
  const before = cy.c.ops.length;
  const el = { ...cy.s.eds.notes.doc.get(id), x: 999 };
  cy.s.eds.notes.onOp({ elements: [el] });
  expect(cy.c.ops.length).toBe(before);
  expect(cy.s.blocked).toBe(1);
});

test("collab port: a presence batch naming this tab's own client id is never shown as a peer", async () => {
  const { collabPort } = await import("../../web/core/collab/port.js");
  let deliver = () => {};
  const t = { send() {}, onMessage: fn => { deliver = fn; }, reopen() {}, close() {}, congested: () => false, backlogBytes: () => 0 };
  const clock = { now: () => 0, mono: () => 0, random: () => 0.5, set: () => 0, clear: () => {} };
  const s = createSession({ join: () => t, token: "tk", board: "b1", client: "me", user: "me", clock });
  const port = collabPort(s, { name: "Me", frame: fn => fn() });
  deliver({ t: "welcome", seq: 0, role: "editor", user: "me", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });
  const got = [];
  port.onPresence(b => got.push(...b));
  deliver({ t: "presence", batch: [{ user: "me", client: port.me.client, k: "cursor", x: 1, y: 1 }, { user: "bo", client: "bo.x", k: "cursor", x: 2, y: 2 }] });
  expect(port.me.client).toBe(s.connection.client);
  expect(got.map(m => m.client)).toEqual(["bo.x"]);
  expect(() => collabPort(s, { name: "Me" })).toThrow(/frame/);       // core reads no browser timer
});

test("over ws.js (async fake WebSocket, test/web/adapters/ws-rig.js): two tabs, one socket each; board and notes converge, through a server close", async () => {
  const { wsNetwork } = await import("./adapters/ws-rig.js");
  const w = wsNetwork({ users: USERS, seed: 3 });
  const tab = (token, user) => { let joins = 0; const s = createSession({ join: () => { joins++; return w.join(); }, token, board: "b1", client: user, user, clock: w.clock }); s.setSize(1000, 700); return { s, joins: () => joins }; };
  const ada = tab("t-ada", "ada"), cy = tab("t-cy", "cy");
  await w.settle();
  expect(w.bridge.live().length).toBe(2);                              // one socket per tab
  for (const t of [ada, cy]) { expect(t.joins()).toBe(1); expect(t.s.status).toBe("live"); }
  ada.s.setTool("rectangle"); drag(ada.s, { x: 10, y: 10 }, { x: 90, y: 90 });
  ada.s.placeNote({ x: 300, y: 300 }, "presenter's note");
  cy.s.placeNote({ x: 600, y: 300 }, "annotator's note");
  cy.s.dropConnection();                                               // a server-side close with an op in flight
  await w.settle();
  for (const t of [ada, cy]) expect(t.s.status).toBe("live");
  expect(w.bridge.live().length).toBe(2);
  for (const st of ["board", "notes"]) {
    const room = w.net.full(st);
    for (const t of [ada, cy]) { expect(t.s.binds[st].full()).toEqual(room); expect(t.s.binds[st].diff()).toEqual([]); }
  }
  expect(cy.s.eds.board.doc.live().length).toBe(1);
  expect(ada.s.eds.notes.doc.live().length).toBe(4);
  expect(ada.s.pending + cy.s.pending).toBe(0);
});

test("note lock from the room's author table (snapshot pairs, then entries): my note in a fresh tab is mine, another's stays locked across a drop", () => {
  const net = localRoom({ users: USERS, clock: true });
  const mk = token => { const s = createSession({ join: () => net.join(), token, board: "b1", client: token, user: USERS[token].user, clock: net.clock }); s.setSize(1000, 700); return s; };
  const cy1 = mk("t-cy");
  net.settle();
  cy1.placeNote({ x: 100, y: 100 }, "cy's");
  net.settle();
  net.compact();                                                       // the next tabs learn authors from the snapshot
  const id = cy1.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  const cy2 = mk("t-cy"), di = mk("t-di");                             // a fresh tab: the page's `mine` is empty
  net.settle();
  expect(cy2.isMine(id)).toBe(true);                                   // the room says cy made it
  expect(di.isMine(id)).toBe(false);
  const moved = s => ({ ...s.eds.notes.doc.get(id), x: 777 });
  di.eds.notes.onOp({ elements: [moved(di)] });
  expect(di.blocked).toBe(1);                                          // the backstop: never sent
  // A plain drop and reconnect: the lock stays shut. (A drop never calls Replica.reset(), so the author table is kept:
  // this is NOT the reset window; the next test enters that window through a refusal.)
  di.dropConnection();
  expect(di.status).not.toBe("live");
  expect(di.connection.noteAuthor(id)).toBe("cy");
  expect(di.isMine(id)).toBe(false);
  di.eds.notes.onOp({ elements: [moved(di)] });
  expect(di.blocked).toBe(2);
  net.settle();
  // cy's second tab edits its own note; it lands everywhere.
  cy2.eds.notes.onOp({ elements: [moved(cy2)] });
  expect(cy2.blocked).toBe(0);
  net.settle();
  expect(di.eds.notes.doc.get(id).x).toBe(777);
  expect(cy1.eds.notes.doc.get(id).x).toBe(777);
});

test("note lock: someone else's note stays locked in the reset window (a rule-5 refusal clears the author table)", () => {
  // p8-one-linkv H1 (the verifier's test).
  const net = localRoom({ users: USERS, clock: true });
  const cy = tab(net, "t-cy"), di = tab(net, "t-di");
  net.settle();
  cy.s.placeNote({ x: 100, y: 100 }, "cy's");
  net.settle();
  const id = di.s.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  expect(di.s.connection.noteAuthor(id)).toBe("cy");
  di.s.dropConnection();
  expect(di.s.connection.noteAuthor(id)).toBe("cy");   // a plain drop never clears it: not the window
  net.settle();
  di.s.placeNote({ x: 500, y: 100 }, "di's");            // di's own op, refused before its ack: Replica.discard -> reset()
  di.c.deliver({ t: "error", id: di.c.ops.at(-1).id, code: "forbidden", message: "probe" });
  expect(di.s.status).not.toBe("live");
  expect(di.s.connection.sequenced("notes", id)).toBe(true);
  expect(di.s.connection.noteAuthor(id)).toBe(null);   // IN the window
  expect(di.s.isMine(id)).toBe(false);
  const before = di.c.ops.length;
  di.s.eds.notes.onOp({ elements: [{ ...di.s.eds.notes.doc.get(id), x: 999 }] });
  expect(di.s.blocked).toBe(1);                        // the backstop
  expect(di.c.ops.length).toBe(before);
  di.s.setTool("select");
  const el = di.s.eds.notes.doc.get(id);
  const p = di.s.eds.notes.toScreen({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
  di.s.pointerDown(p);
  expect(di.s.takeFlash()).toMatch(/locked/);
  expect(di.s.eds.notes.sel.has(id)).toBe(false);
  di.s.pointerUp(p);
  net.settle();
  expect(di.s.status).toBe("live");
  expect(di.s.isMine(id)).toBe(false);
});

test("L1: the same tab signed in as another user forgets the old user's notes (s.mine), so the reset window can't unlock them", () => {
  const net = localRoom({ users: USERS, clock: true });
  const t = tab(net, "t-cy");
  net.settle();
  t.s.placeNote({ x: 100, y: 100 }, "cy's");
  net.settle();
  const id = t.s.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  expect(t.s.mine.has(id)).toBe(true);
  expect(t.s.isMine(id)).toBe(true);
  t.s.placeNote({ x: 500, y: 100 }, "cy's, unsent");      // a pending op: the user change discards it (rule 13) -> reset()
  t.s.reconnect("t-di");                                  // the same tab, now di
  let n = 0;
  while (t.s.connection.lastUser !== "di" && n++ < 500) net.step(() => 0);
  expect(t.s.connection.lastUser).toBe("di");
  expect(t.s.connection.noteAuthor(id)).toBe(null);       // in the reset window: no author table
  expect(t.s.isMine(id)).toBe(false);                     // cy's note is not di's
  expect(t.s.mine.has(id)).toBe(false);
  net.settle();
  expect(t.s.isMine(id)).toBe(false);
});

test("a link resync with a notes op pending keeps an open board drag; it commits after and both streams converge", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada"), bo = counted(net, "t-bo");
  net.settle();
  ada.s.setTool("rectangle"); drag(ada.s, { x: 10, y: 10 }, { x: 80, y: 80 });
  net.settle();
  const rid = ada.s.eds.board.doc.live().find(e => e.type === "rectangle").id;
  const r0 = ada.s.eds.board.doc.get(rid), x0 = r0.x;
  const c = ada.s.eds.board.toScreen({ x: r0.x + r0.width / 2, y: r0.y + r0.height / 2 });
  ada.s.placeNote({ x: 400, y: 400 }, "pending note");                         // a notes op, not yet acked
  ada.s.setTool("select");
  ada.s.pointerDown(c); ada.s.pointerMove({ x: c.x + 100, y: c.y }); ada.s.pointerMove({ x: c.x + 200, y: c.y });   // a board drag, still open
  expect(ada.s.pending).toBeGreaterThan(0);
  ada.s.dropConnection();
  net.settle();                                                                 // the whole link resyncs, both Editors reload
  expect(ada.s.status).toBe("live");
  expect(ada.s.binds.board.resets).toBe(2);
  expect(ada.s.binds.notes.resets).toBe(2);
  expect(ada.s.eds.board.g).toBeTruthy();                                       // the open drag survived the reload
  // The reload put the Replica's copy back (a drag's positions are previews until it commits, as with two links);
  // the gesture goes on from the next move.
  ada.s.pointerMove({ x: c.x + 250, y: c.y });
  ada.s.pointerUp({ x: c.x + 250, y: c.y });
  net.settle();
  expect(bo.s.eds.board.doc.get(rid).x).toBe(x0 + 250 / ada.s.eds.board.view.scale);   // the drag committed
  expect(bo.s.eds.notes.doc.live().length).toBe(2);
  for (const st of ["board", "notes"]) { expect(ada.s.binds[st].diff()).toEqual([]); expect(editorState(bo.s.eds[st])).toEqual(editorState(ada.s.eds[st])); }
  expect(ada.s.pending).toBe(0);
});
