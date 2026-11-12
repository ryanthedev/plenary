// p8-tidy: the link-level LOWs of p8-one-linkv (L3 a transport without reopen() is refused through createSession,
// L4 `sequenced` keeps streams apart, L5 a snapshot while live reloads every bind it holds, L6 dropConnection() works
// on the production ws transport). Hand transports and the ws bridge; no timers unless a test advances them.
import { test, expect } from "bun:test";
import { createSession } from "../../web/core/session.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import { wsTransport } from "../../web/adapters/transport/ws.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { wsBridge, WS_URL } from "./adapters/ws-rig.js";
import { makeElement } from "../../packages/core/model.js";

const el = (id, x = 0) => ({ ...makeElement("rectangle", { x, y: 0, width: 40, height: 30 }), id, version: 1, versionNonce: 7, updated: 1 });

/** A session over a hand transport: `deliver` plays the room, `sent` is what went out. */
function handSession(token = "t", o = {}) {
  const sent = []; let deliver = null;
  const tr = { send: m => sent.push(JSON.parse(JSON.stringify(m))), onMessage: fn => { deliver = fn; }, reopen() {}, close() {}, ...o.transport };
  const s = createSession({ join: () => tr, token, board: "b1", client: "c", user: "u1", clock: virtualClock(), ...o.session });
  return { s, sent, deliver: m => deliver(m) };
}

test("L3: an adapter without reopen() is refused through createSession, as sync.js says (no made-up member)", () => {
  const bare = { send() {}, onMessage() {}, close() {} };
  expect(() => createSession({ join: () => bare, token: "t", board: "b1", clock: virtualClock() })).toThrow(/reopen/);
  // With reopen it is accepted, and members it lacks stay absent on the link.
  const ok = createSession({ join: () => ({ ...bare, reopen() {} }), token: "t", board: "b1", clock: virtualClock() });
  expect(Object.keys(ok.link).sort()).toEqual(["close", "onMessage", "reopen", "send"]);
  expect(ok.congested).toBe(false);                     // sync.js reads congested() as optional
});

test("L4: an id the room sequenced on the board stream is not a known note (and the reverse), from entries and a snapshot", () => {
  const { s, deliver } = handSession();
  deliver({ t: "welcome", seq: 2, role: "annotator", user: "u1" });
  deliver({ t: "entries", entries: [
    { seq: 1, board: "b1", tenant: "t1", stream: "board", op: { elements: [el("same")] }, by: "u0", id: "o:1" },
    { seq: 2, board: "b1", tenant: "t1", stream: "notes", op: { elements: [el("n1")] }, by: "u0", id: "o:2" },
  ] });
  expect(s.status).toBe("live");
  expect(s.connection.sequenced("board", "same")).toBe(true);
  expect(s.connection.sequenced("notes", "same")).toBe(false);
  expect(s.connection.sequenced("notes", "n1")).toBe(true);
  expect(s.connection.sequenced("board", "n1")).toBe(false);
  // The annotator writes a note whose id equals the board element's: a create, so it is this person's note.
  s.eds.notes.onOp({ elements: [el("same", 500)] });
  expect(s.mine.has("same")).toBe(true);
  // Snapshot-fed ids keep their stream too.
  const b = handSession();
  b.deliver({ t: "welcome", seq: 5, role: "annotator", user: "u1" });
  b.deliver({ t: "snapshot", seq: 5, streams: { board: { elements: [el("sb")], appState: {} }, notes: { elements: [el("sn")], appState: {} } }, appSeq: {}, records: { threads: [] }, noteAuthor: [] });
  expect(b.s.status).toBe("live");
  expect(b.s.connection.sequenced("board", "sb")).toBe(true);
  expect(b.s.connection.sequenced("notes", "sb")).toBe(false);
  expect(b.s.connection.sequenced("notes", "sn")).toBe(true);
  expect(b.s.connection.sequenced("board", "sn")).toBe(false);
});

test("L5: a snapshot while live reloads every bind whose stream it holds (both Editors show it)", () => {
  const { s, deliver } = handSession();
  deliver({ t: "welcome", seq: 1, role: "owner", user: "u1" });
  deliver({ t: "entries", entries: [{ seq: 1, board: "b1", tenant: "t1", stream: "board", op: { elements: [el("b0")] }, by: "u0", id: "o:1" }] });
  expect(s.status).toBe("live");
  const r0 = [s.binds.board.resets, s.binds.notes.resets];
  deliver({ t: "snapshot", seq: 9, streams: { board: { elements: [el("b9", 10)], appState: {} }, notes: { elements: [el("n9", 20)], appState: {} } }, appSeq: {}, records: { threads: [] }, noteAuthor: [] });
  expect(s.status).toBe("live");
  expect([s.binds.board.resets - r0[0], s.binds.notes.resets - r0[1]]).toEqual([1, 1]);
  expect(s.eds.board.doc.live().map(e => e.id)).toEqual(["b9"]);
  expect(s.eds.notes.doc.live().map(e => e.id)).toEqual(["n9"]);
  expect(s.binds.board.diff()).toEqual([]);
  expect(s.binds.notes.diff()).toEqual([]);
});

test("L6: dropConnection() drops the production ws transport (onDrop once, a fresh socket) and the tab comes back live", async () => {
  const net = localRoom({ users: { "t-ada": { user: "ada", role: "owner" } }, clock: true });
  const bridge = wsBridge(net);
  const t = wsTransport({ url: WS_URL, WebSocket: bridge.WebSocket, clock: net.clock });
  // The adapter itself: fail() closes the current socket and reports onDrop once; never after close().
  expect(typeof t.fail).toBe("function");
  const s = createSession({ join: () => t, token: "t-ada", board: "b1", client: "ada", user: "ada", clock: net.clock });
  expect(typeof s.link.onDrop).toBe("function");       // the wrapper kept the adapter's onDrop and fail
  expect(typeof s.link.fail).toBe("function");
  const settle = async () => {
    for (let n = 0; n < 100_000; n++) {
      if (bridge.step(() => 0) || net.step(() => 0)) continue;
      await Promise.resolve();
      if (bridge.step(() => 0) || net.step(() => 0)) continue;
      if (!net.tick()) return;
    }
  };
  await settle();
  expect(s.status).toBe("live");
  const sock0 = bridge.live();
  expect(sock0.length).toBe(1);
  const statuses = [];
  s.onStatus(st => statuses.push(st));
  s.placeNote({ x: 10, y: 10 }, "before");
  s.dropConnection();
  expect(statuses.filter(x => x === "connecting").length).toBe(1);                                 // the drop reached sync.js (a failed attempt, resync)
  expect(sock0[0].readyState).toBeGreaterThanOrEqual(2); // the old socket is closed
  await settle();
  expect(s.status).toBe("live");
  expect(bridge.live().length).toBe(1);
  expect(bridge.live()[0]).not.toBe(sock0[0]);           // a fresh socket
  expect(s.pending).toBe(0);                             // the note made before the drop landed
  expect(net.state("notes").elements.length).toBeGreaterThan(0);
  s.connection.close();
  t.fail();                                              // after close(): nothing
  expect(bridge.live().length).toBe(0);
});
