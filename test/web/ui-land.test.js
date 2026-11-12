// p6-land: the canvas session over the page's real transports. The SharedWorker one runs here as
// room-host.js behind a fake MessagePort pair whose deliveries queue (as a real port's do), so a message the
// host posted before it saw a reopen is still in flight when the tab has moved on. Also: ?net=local
// (localRoom), drafts kept across a drop (p6-uiv M1), the downgrade toast (L2), and `stopped` (p6-sync2v M2).
import { test, expect } from "bun:test";
import { editorState } from "../../web/core/sync.js";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { sharedNet } from "../../web/adapters/transport/shared-worker/client.js";
import { roomHost } from "../../web/adapters/transport/shared-worker/host.js";
import { pillFor } from "../../web/core/roles.js";
import { DEV_USERS } from "../../web/core/dev-users.js";

// Two ends of a port; postMessage queues a structured clone for the other end until flush().
function portPair() {
  const q = [];
  const end = () => ({ onmessage: null, other: null, start() {}, postMessage(d) { const to = this.other, data = structuredClone(d); q.push(() => to.onmessage?.({ data })); } });
  const tab = end(), host = end();
  tab.other = host; host.other = tab;
  return { tab, host, q, flush() { let n = 0; while (q.length) { q.shift()(); n++; } return n; } };
}

// Everything in flight (ports, then the room's own network) before the virtual clock may move.
function settleAll(net, pairs) {
  for (let i = 0; i < 100_000; i++) {
    let moved = 0;
    for (const p of pairs) moved += p.flush();
    while (net.step()) moved++;
    if (moved) continue;
    if (!net.tick()) return;
  }
  throw new Error("never settled");
}

// A browser with tabs on one SharedWorker room host (board b1, the dev users).
function browser() {
  const host = roomHost({ makeNet: board => localRoom({ board, users: DEV_USERS, clock: true }) });
  const net = host.room("b1").net, pairs = [];
  const tab = as => {
    const pair = portPair(); pairs.push(pair);
    host.connect(pair.host);
    const n = sharedNet({ board: "b1", worker: { port: pair.tab } });
    const s = createSession({ join: () => n.join(), token: `dev-${as}`, board: "b1", client: as, user: as, clock: net.clock });
    s.setSize(1000, 700);
    return s;
  };
  return { net, tab, settle: () => settleAll(net, pairs), pairs };
}

function drag(s, a, b, m = {}) { s.pointerDown(a, m); for (let i = 1; i <= 6; i++) s.pointerMove({ x: a.x + (b.x - a.x) * i / 6, y: a.y + (b.y - a.y) * i / 6 }, m); s.pointerUp(b, m); }
const resets = s => s.binds.board.resets + s.binds.notes.resets;
function converged(net, sessions) {
  for (const stream of ["board", "notes"]) {
    const room = net.full(stream);
    for (const s of sessions) {
      expect(s.binds[stream].status).toBe("live");
      expect(s.binds[stream].pending).toBe(0);
      expect(s.binds[stream].diff()).toEqual([]);
      expect(s.binds[stream].full()).toEqual(room);
    }
  }
}

test("p6-sync2v H1: a resync over the SharedWorker transport comes back live; the next drawing reaches all three tabs", () => {
  const b = browser();
  const ada = b.tab("ada"), cy = b.tab("cy"), ed = b.tab("ed");
  b.settle();
  expect([ada.status, cy.status, ed.status]).toEqual(["live", "live", "live"]);
  ada.setTool("rectangle"); drag(ada, { x: 100, y: 100 }, { x: 220, y: 180 }); b.settle();
  expect(editorState(ed.eds.board).elements.length).toBe(1);
  const before = resets(ada);
  ada.eds.board.setAppState({ bogus: 1 });                    // the room refuses it: rule 5, a resync
  b.settle();
  expect(resets(ada)).toBeGreaterThan(before);
  expect(ada.status).toBe("live");
  ada.setTool("ellipse"); drag(ada, { x: 400, y: 300 }, { x: 480, y: 360 });
  cy.setTool("note"); cy.pointerDown({ x: 600, y: 200 }); cy.eds.notes.setText("after"); cy.eds.notes.commitText();
  b.settle();
  expect(editorState(ed.eds.board).elements.map(e => e.type).sort()).toEqual(["ellipse", "rectangle"]);
  expect(ada.blocked + cy.blocked + ed.blocked).toBe(0);
  converged(b.net, [ada, cy, ed]);
  // Retry (reconnect) after the resync works too.
  ada.reconnect(); b.settle();
  ada.setTool("diamond"); drag(ada, { x: 100, y: 400 }, { x: 160, y: 460 }); b.settle();
  expect(editorState(cy.eds.board).elements.length).toBe(3);
  converged(b.net, [ada, cy, ed]);
});

test("shared transport: a message or drop report the host posted for the old connection is never delivered after reopen()", () => {
  const pair = portPair(), posted = [];
  const send = pair.tab.postMessage.bind(pair.tab);
  pair.tab.postMessage = d => { posted.push(d); send(d); };
  const n = sharedNet({ board: "b1", worker: { port: pair.tab } });
  const t = n.join(), got = [];
  let drops = 0;
  t.onMessage(m => got.push(m)); t.onDrop(() => drops++);
  const old = posted.find(d => d.t === "join").link;
  pair.host.postMessage({ t: "msg", link: old, m: { t: "welcome", seq: 9 } });   // in flight
  pair.host.postMessage({ t: "dropped", link: old });
  t.reopen();
  pair.flush();
  expect(got).toEqual([]);
  expect(drops).toBe(0);
  const now = posted.filter(d => d.t === "join").at(-1).link;
  expect(now).not.toBe(old);
  expect(posted.some(d => d.t === "close" && d.link === old)).toBe(true);
  pair.host.postMessage({ t: "msg", link: now, m: { t: "welcome", seq: 1 } }); pair.flush();
  expect(got).toEqual([{ t: "welcome", seq: 1 }]);
  t.close();
  pair.host.postMessage({ t: "msg", link: now, m: { t: "welcome", seq: 2 } }); pair.flush();
  expect(got.length).toBe(1);                                  // closed for good
});

test("?net=local (localRoom): a resync comes back live and the next drawing converges", () => {
  const net = localRoom({ board: "b1", users: DEV_USERS, clock: true });
  const mk = as => { const s = createSession({ join: () => net.join(), token: `dev-${as}`, board: "b1", client: as, user: as, clock: net.clock }); s.setSize(1000, 700); return s; };
  const ada = mk("ada"), bo = mk("bo");
  net.settle();
  ada.eds.board.setAppState({ bogus: 1 }); net.settle();
  expect(ada.status).toBe("live");
  ada.setTool("rectangle"); drag(ada, { x: 100, y: 100 }, { x: 200, y: 200 }); net.settle();
  expect(editorState(bo.eds.board).elements.length).toBe(1);
  converged(net, [ada, bo]);
});

test("p6-uiv M1: text typed while the connection drops is kept, held, and lands once live again; a drag in flight too", () => {
  const b = browser();
  const ada = b.tab("ada"), bo = b.tab("bo");
  b.settle();
  ada.setTool("text"); ada.pointerDown({ x: 300, y: 300 }); ada.pointerUp({ x: 300, y: 300 });
  expect(ada.eds.board.text).toBeTruthy();
  ada.eds.board.setText("draft typed through the drop");
  ada.online = false; ada.dropConnection(); b.pairs.forEach(p => p.flush());   // offline, and the socket drops
  expect(ada.status).toBe("connecting");
  expect(ada.setTool("rectangle")).toBe(false);                 // nothing new starts while offline
  ada.eds.board.setText("draft typed through the drop, more");
  ada.eds.board.commitText();                                   // Esc / blur / Cmd+Enter
  expect(ada.blocked).toBe(0);
  expect(ada.pending).toBe(1);
  expect(ada.eds.board.doc.live().some(e => e.text === "draft typed through the drop, more")).toBe(true);
  // A drag that started before the drop finishes too.
  ada.online = true; ada.setTool("rectangle"); ada.pointerDown({ x: 500, y: 100 }); ada.pointerMove({ x: 560, y: 160 });
  ada.online = false; ada.pointerMove({ x: 600, y: 200 }); ada.pointerUp({ x: 600, y: 200 });
  expect(ada.blocked).toBe(0);
  expect(ada.pending).toBe(2);
  ada.online = true;
  b.settle();
  expect(ada.status).toBe("live");
  const texts = editorState(bo.eds.board).elements.filter(e => e.type === "text").map(e => e.text);
  expect(texts).toEqual(["draft typed through the drop, more"]);
  expect(editorState(bo.eds.board).elements.filter(e => e.type === "rectangle").length).toBe(1);
  converged(b.net, [ada, bo]);
});

test("p6-uiv L2: a downgrade mid-typing drops the write and says so", () => {
  const net = localRoom({ board: "b1", users: DEV_USERS, clock: true });
  let role = null;
  const join = () => { const t = net.join(), on = t.onMessage; return { ...t, onMessage: fn => on(m => fn(m.t === "welcome" && role ? { ...m, role } : m)) }; };
  const ada = createSession({ join, token: "dev-ada", board: "b1", client: "ada", user: "ada", clock: net.clock });
  ada.setSize(1000, 700);
  net.settle();
  ada.setTool("text"); ada.pointerDown({ x: 300, y: 300 }); ada.pointerUp({ x: 300, y: 300 });
  ada.eds.board.setText("mine");
  role = "viewer"; ada.reconnect(); net.settle();
  expect(ada.readOnly).toBe(true);
  ada.eds.board.commitText();
  expect(ada.blocked).toBe(1);
  expect(ada.takeFlash()).toMatch(/view-only/);
  net.settle();
  expect(net.state().elements).toEqual([]);
});

test("p6-sync2v M2: `stopped` wins the combined status and has its own pill, never Connecting…", () => {
  const net = localRoom({ board: "b1", users: DEV_USERS, clock: true });
  let deliver = null;
  const stub = { send() {}, onMessage: fn => { deliver = fn; }, reopen() {}, close() {} };
  // p8-one-link: one link per tab, so both streams stop together; the merge rule is checked with the board bind
  // forced to "connecting" (as a second link used to be).
  let joined = 0;
  const s = createSession({ join: () => { joined++; return stub; }, token: "dev-ada", board: "b1", clock: net.clock });
  expect(joined).toBe(1);
  deliver({ t: "welcome", seq: 0, role: "owner", user: "ada", rv: 999 });  // rules this app doesn't know
  expect(s.binds.notes.status).toBe("stopped");
  expect(s.binds.board.status).toBe("stopped");
  expect(s.status).toBe("stopped");
  Object.defineProperty(s.binds.board, "status", { get: () => "connecting", configurable: true });
  expect(s.status).toBe("stopped");
  const pill = pillFor({ status: "stopped", pending: 2, role: "presenter" });
  expect(pill.text).toBe("Update needed");
  expect(pill.text).not.toMatch(/Connecting/);
  expect(pillFor({ status: "stopped", online: false, role: "presenter" }).text).toBe("Update needed");
});
