// The canvas session (web/ui/session.js): two Editors per person through the in-process reference Room,
// role gating counted at the transport (no forbidden op ever leaves), and annotators' note ownership.
import { test, expect } from "bun:test";
import { editorState } from "../../web/core/sync.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { TOOLS } from "../../packages/core/editor.js";
import { browserClock } from "../../web/adapters/clock/browser.js";

const USERS = {
  "t-ada": { user: "ada", role: "owner" }, "t-bo": { user: "bo", role: "editor" },
  "t-cy": { user: "cy", role: "annotator" }, "t-di": { user: "di", role: "annotator" },
  "t-ed": { user: "ed", role: "viewer" }, "t-fi": { user: "fi", role: "commenter" },
};

// A person: a session whose transports count every op message they send, by stream.
function person(net, token, o = {}) {
  const sent = { board: 0, notes: 0, errors: 0 };
  const join = () => {
    const t = net.join();
    const send = t.send, on = t.onMessage;
    t.send = m => { if (m.t === "op" && !m.transient) sent[m.stream]++; send(m); };
    t.onMessage = fn => on(m => { if (m.t === "error") sent.errors++; if (m.t === "welcome" && o.role?.()) m = { ...m, role: o.role() }; fn(m); });
    return t;
  };
  const s = createSession({ join, token, board: "b1", client: token, user: USERS[token].user, clock: browserClock() });
  s.setSize(1000, 700);
  s.sent_ = sent;
  return s;
}
const resets = s => s.binds.board.resets + s.binds.notes.resets;

function drag(s, a, b, m = {}) { s.pointerDown(a, m); for (let i = 1; i <= 6; i++) s.pointerMove({ x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }, m); s.pointerUp(b, m); }

test("roles map to chrome; commenter reads like a viewer", () => {
  const net = localRoom({ users: USERS });
  const [ada, cy, ed, fi] = ["t-ada", "t-cy", "t-ed", "t-fi"].map(t => person(net, t));
  net.settle();
  expect([ada.role, cy.role, ed.role, fi.role]).toEqual(["presenter", "annotator", "viewer", "viewer"]);
  expect(ada.status).toBe("live");
  expect(ed.tool).toBe("hand");
});

test("presenter draws on the board with every tool; a second person sees it all", () => {
  const net = localRoom({ users: USERS });
  const ada = person(net, "t-ada"), bo = person(net, "t-bo");
  net.settle();
  const r0 = resets(ada) + resets(bo);
  let x = 40;
  for (const t of TOOLS) {
    expect(ada.setTool(t.id)).toBe(true);
    if (t.id === "text") { ada.pointerDown({ x, y: 400 }); ada.eds.board.setText("hi"); ada.eds.board.commitText(); }
    else drag(ada, { x, y: 100 }, { x: x + 50, y: 160 });
    net.settle(); x += 70;
  }
  ada.setTool("note"); ada.pointerDown({ x: 500, y: 500 }); ada.eds.notes.setText("a note"); ada.eds.notes.commitText();
  ada.setTool("highlighter"); drag(ada, { x: 100, y: 600 }, { x: 300, y: 600 });
  net.settle();
  for (const st of ["board", "notes"]) expect(editorState(bo.eds[st])).toEqual(editorState(ada.eds[st]));
  const types = new Set(editorState(bo.eds.board).elements.map(e => e.type));
  for (const t of ["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"]) expect(types.has(t)).toBe(true);
  const hl = editorState(bo.eds.notes).elements.find(e => e.type === "freedraw");
  expect(hl.strokeWidth).toBe(16); expect(hl.opacity).toBe(40);
  // The highlighter's style doesn't leak into the pen.
  ada.setTool("freedraw"); expect(ada.eds.notes.style.strokeWidth).not.toBe(16);
  expect(resets(ada) + resets(bo)).toBe(r0);   // no resync after the first catch-up
  expect(ada.blocked + bo.blocked).toBe(0);
});

test("a viewer never sends an op, whatever it presses or clicks", () => {
  const net = localRoom({ users: USERS });
  const ada = person(net, "t-ada"), ed = person(net, "t-ed");
  net.settle();
  ada.setTool("rectangle"); drag(ada, { x: 100, y: 100 }, { x: 200, y: 200 }); net.settle();
  const r0 = resets(ed);
  for (const t of [...TOOLS.map(t => t.id), "note", "highlighter", "image"]) { ed.setTool(t); drag(ed, { x: 120, y: 120 }, { x: 300, y: 300 }); }
  for (const k of ["a", "v", "delete", "backspace", "c", "b", "s", "w", "g", "q", "]", "[", "enter", "escape", "left", "=", "-"]) ed.key(k, {});
  for (const k of ["z", "y", "d", "a", "g", "'", "l", "]"]) { ed.key(k, { cmd: true }); ed.key(k, { cmd: true, shift: true }); }
  ed.key("a", { alt: true }); ed.key("h", { shift: true }); ed.key(">", {});
  ed.paste("flowchart LR\n A --> B"); ed.paste("hello");
  ed.placeNote({ x: 10, y: 10 }, "x");
  ed.addPicture({ id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=", width: 10, height: 10 });
  for (const st of ["board", "notes"]) ed.act(st, e => e.addLayer("x"));
  net.settle();
  expect(ed.sent_).toEqual({ board: 0, notes: 0, errors: 0 });
  expect(ed.pending).toBe(0);
  expect(resets(ed)).toBe(r0);
  expect(ed.blocked).toBe(0);
  expect(ed.tool).toBe("hand");
  // It can still look around.
  const v = { ...ed.eds.board.view }; drag(ed, { x: 100, y: 100 }, { x: 200, y: 150 });
  expect(ed.eds.board.view.x).not.toBe(v.x);
  expect(ed.eds.notes.view).toEqual(ed.eds.board.view);
});

test("an annotator writes only notes, and only its own", () => {
  const net = localRoom({ users: USERS });
  const ada = person(net, "t-ada"), cy = person(net, "t-cy"), di = person(net, "t-di");
  net.settle();
  ada.setTool("rectangle"); drag(ada, { x: 600, y: 100 }, { x: 700, y: 200 }); net.settle();
  di.setTool("note"); di.pointerDown({ x: 200, y: 400 }); di.eds.notes.setText("di's"); di.eds.notes.commitText(); net.settle();
  cy.setTool("note"); cy.pointerDown({ x: 600, y: 450 }); cy.eds.notes.setText("cy's"); cy.eds.notes.commitText(); net.settle();
  const r0 = resets(cy), before = { ...cy.sent_ };
  // Board tools aren't theirs.
  expect(cy.setTool("rectangle")).toBe(false);
  expect(cy.setTool("frame")).toBe(false);
  // Try to touch di's note: click, drag, delete, erase, double-click to edit, select all + delete, nudge.
  cy.setTool("select");
  drag(cy, { x: 200, y: 400 }, { x: 260, y: 460 });
  cy.key("delete"); cy.key("left");
  cy.key("a", { cmd: true }); cy.key("delete");
  cy.setTool("eraser"); drag(cy, { x: 150, y: 400 }, { x: 260, y: 400 });
  cy.setTool("select"); cy.pointerDown({ x: 200, y: 400 }, { clickCount: 2 }); cy.pointerUp({ x: 200, y: 400 });
  cy.key("'", { cmd: true });                           // grid is a stream setting: moderators only
  expect(cy.act("notes", e => e.addLayer("mine"), { settings: true })).toBe(false);   // so is a layer
  // ...and the board, which an annotator can't write at all.
  cy.act("board", e => e.addLayer("nope"));
  net.settle();
  expect(cy.sent_.errors).toBe(0);
  expect(cy.sent_.board).toBe(0);
  expect(resets(cy)).toBe(r0);
  expect(cy.blocked).toBe(0);
  const diNote = editorState(ada.eds.notes).elements.find(e => e.type === "text" && e.text === "di's");
  expect(diNote).toBeTruthy();
  // cy's own note was deleted by select-all + delete (its own), di's survived.
  expect(editorState(ada.eds.notes).elements.some(e => e.text === "cy's")).toBe(false);
  expect(cy.sent_.notes).toBeGreaterThan(before.notes);
  for (const st of ["board", "notes"]) expect(editorState(cy.eds[st])).toEqual(editorState(ada.eds[st]));
});

test("presenter's Select reaches notes; the view stays shared", () => {
  const net = localRoom({ users: USERS });
  const ada = person(net, "t-ada"), cy = person(net, "t-cy");
  net.settle();
  cy.setTool("note"); cy.pointerDown({ x: 300, y: 300 }); cy.eds.notes.setText("move me"); cy.eds.notes.commitText(); net.settle();
  ada.setTool("select");
  drag(ada, { x: 300, y: 300 }, { x: 400, y: 340 });
  net.settle();
  expect(ada.active).toBe("notes");
  const host = editorState(cy.eds.notes).elements.find(e => e.type === "rectangle");
  expect(Math.round(host.x)).toBe(300 - 95 + 100 - 40);
  ada.key("1", { shift: true });
  expect(ada.eds.notes.view).toEqual(ada.eds.board.view);
  expect(ada.blocked + cy.blocked + cy.sent_.errors + ada.sent_.errors).toBe(0);
});

test("the backstop drops a write that slipped past the chrome and reloads the stream", () => {
  const net = localRoom({ users: USERS });
  const ada = person(net, "t-ada"), cy = person(net, "t-cy");
  net.settle();
  cy.act("notes", e => e.addLayer("sneaky"));           // no settings flag: the chrome let it through
  net.settle();
  expect(cy.blocked).toBe(1);
  expect(cy.sent_).toEqual({ board: 0, notes: 0, errors: 0 });
  expect(cy.eds.notes.doc.layers.some(l => l.name === "sneaky")).toBe(false);
  expect(editorState(cy.eds.notes)).toEqual(editorState(ada.eds.notes));
});

test("an annotator's highlighter keeps its style after switching to the pen", () => {
  const net = localRoom({ users: USERS });
  const cy = person(net, "t-cy"), ada = person(net, "t-ada");
  net.settle();
  cy.setTool("highlighter"); drag(cy, { x: 100, y: 100 }, { x: 300, y: 100 });
  cy.setTool("freedraw"); drag(cy, { x: 100, y: 300 }, { x: 300, y: 320 });
  net.settle();
  const strokes = editorState(ada.eds.notes).elements.filter(e => e.type === "freedraw").sort((a, b) => a.y - b.y);
  expect(strokes.map(e => [e.strokeWidth, e.opacity])).toEqual([[16, 40], [2, 100]]);
});

test("a downgrade to viewer keeps the chrome, greys it, and sends nothing", () => {
  const net = localRoom({ users: USERS });
  let role = null;
  const ada = person(net, "t-ada", { role: () => role });
  net.settle();
  expect([ada.role, ada.readOnly, ada.may()]).toEqual(["presenter", false, true]);
  role = "viewer"; ada.reconnect(); net.settle();
  expect([ada.role, ada.effective, ada.readOnly, ada.may()]).toEqual(["presenter", "viewer", true, false]);
  const before = { ...ada.sent_ };
  expect(ada.setTool("rectangle")).toBe(false);
  expect(ada.setTool("note")).toBe(false);
  expect(ada.act("board", e => e.addLayer("x"))).toBe(false);
  expect(ada.act("notes", e => e.addLayer("x"))).toBe(false);
  drag(ada, { x: 100, y: 100 }, { x: 200, y: 200 });
  for (const k of ["r", "delete", "c", "q"]) ada.key(k);
  ada.key("z", { cmd: true }); ada.paste("hi"); ada.placeNote({ x: 0, y: 0 }, "x");
  net.settle();
  expect(ada.sent_).toEqual(before);
  expect(ada.blocked).toBe(0);
  expect(ada.pending).toBe(0);
});

// p6-landv L5: the note lock compares a note's author with the user the ROOM named in welcome, never the page's
// display identity (which comes from sign-in and is display-only).
test("note lock: the author is checked against welcome.user, not the display identity passed in", () => {
  const net = localRoom({ users: USERS, clock: true });
  const s = createSession({ join: () => net.join(), token: "t-cy", board: "b1", client: "cy", user: "not-cy", noteAuthor: () => "cy", clock: net.clock });
  expect(s.isMine("n1")).toBe(false);                 // before welcome: only the display identity, which isn't cy
  net.settle();
  expect(s.effective).toBe("annotator");
  expect(s.isMine("n1")).toBe(true);                  // the room says this connection is cy
  const other = createSession({ join: () => net.join(), token: "t-di", board: "b1", client: "di", user: "cy", noteAuthor: () => "cy", clock: net.clock });
  net.settle();
  expect(other.isMine("n1")).toBe(false);             // claiming "cy" for display doesn't make di the author
});
