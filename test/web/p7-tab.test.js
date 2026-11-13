// p7-tab: the web client sends hello.tab (PROTOCOL.md § Messages, `hello.tab`), one id per page load, the same on every
// hello of that page (first, reconnect, resync, the cap's backoff), and one neutral refusal text for both writer caps
// (a ninth tab and a third connection of one tab look the same to the client: `limit`, no id, closed).
// Every transport the web client uses is checked on the hello it actually carries (ws.js frames, the shared worker's
// port, the in-page room), and once against the real gateway, the only place that acts on `tab`.
import { test, expect, afterAll } from "bun:test";
import { TAB_RE } from "../../packages/protocol/envelope.js";
import { Room } from "../../packages/protocol/room.js";
import { jsonCodec } from "../../packages/protocol/codec.js";
import { Editor } from "../../packages/core/editor.js";
import { createSession, mintTab } from "../../web/core/session.js";
import { bindEditor, openLink } from "../../web/core/sync.js";
import { pillFor, connectionBanner, pillTitleFor, LIMIT_TEXT } from "../../web/core/roles.js";
import { localRoom, localNet } from "../../web/adapters/transport/local.js";
import { roomHost } from "../../web/adapters/transport/shared-worker/host.js";
import { sharedNet } from "../../web/adapters/transport/shared-worker/client.js";
import { wsNet } from "../../web/adapters/transport/ws.js";
import { browserClock } from "../../web/adapters/clock/browser.js";
import { wsNetwork } from "./adapters/ws-rig.js";
import { rig, tokenOf } from "../server/rig.js";
import { cleanup, sleep } from "../server/helpers.js";

afterAll(cleanup);

const USERS = { "t-ada": { user: "ada", role: "owner" }, "t-bo": { user: "bo", role: "editor" }, "t-ed": { user: "ed", role: "viewer" } };
const CAP = "at most 8 open writer connections per user on a board";

/** A session over `net` whose hellos are collected as sent (c.hellos), across every connection of its link. */
function counted(net, token, o = {}) {
  const c = { hellos: [] };
  const join = () => {
    const t = net.join();
    const send = t.send;
    t.send = m => { if (m.t === "hello") c.hellos.push(m); send(m); };
    return t;
  };
  const s = createSession({ join, token, board: "b1", client: token, user: USERS[token]?.user ?? "x", clock: net.clock, ...o });
  s.setSize(1000, 700);
  return { s, c };
}

/** A virtual clock (random 0.5) and one scripted transport per join (as test/web/collab/wire2.test.js). */
function scripted() {
  let t = 0; const q = [];
  const clock = { now: () => t, mono: () => t, random: () => 0.5,
    set: (fn, ms) => { const h = { at: t + ms, fn }; q.push(h); return h; }, clear: h => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } };
  const advance = ms => { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const h = q[0]; if (!h || h.at > end) break; q.shift(); t = h.at; h.fn(); } t = end; };
  const links = [];
  const join = () => {
    const l = { sent: [], on: () => {}, dropped: () => {} };
    links.push(l);
    return { send: m => l.sent.push(m), onMessage: fn => { l.on = fn; }, onDrop: fn => { l.dropped = fn; }, reopen: () => {}, close: () => {},
      congested: () => false, backlogBytes: () => 0 };
  };
  return { clock, advance, join, links, hellos: () => links.flatMap(l => l.sent.filter(m => m.t === "hello")) };
}

/** A Room that records every message the in-page gateway stand-in hands it (localRoom's makeRoom). */
function capturing(seen) {
  return o => {
    const room = new Room(o);
    const receive = room.receive.bind(room);
    room.receive = (conn, msg, meta) => { seen.push(msg); return receive(conn, msg, meta); };
    return room;
  };
}

// ── the id ──
test("mintTab: 16 base-36 characters, always inside TAB_RE, at the ends of random's range too", () => {
  for (const r of [() => 0, () => 0.5, () => 0.999999999, Math.random]) {
    const id = mintTab(r);
    expect(id).toMatch(/^[0-9a-z]{16}$/);
    expect(TAB_RE.test(id)).toBe(true);
  }
});

test("two page loads (two sessions on the browser clock) mint different tabs", () => {
  const clock = browserClock();
  const net = localRoom({ users: USERS, clock: true });
  const a = createSession({ join: () => net.join(), token: "t-ada", board: "b1", client: "a", clock: { ...net.clock, random: clock.random } });
  const b = createSession({ join: () => net.join(), token: "t-ada", board: "b1", client: "b", clock: { ...net.clock, random: clock.random } });
  expect(a.tab).toMatch(TAB_RE);
  expect(b.tab).toMatch(TAB_RE);
  expect(a.tab).not.toBe(b.tab);
});

// ── the hello carries it, the same on every connection of one session ──
test("writer: every hello carries the session's tab: first, reconnect(), a dropped connection, a resync", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ada = counted(net, "t-ada"), bo = counted(net, "t-bo");
  net.settle();
  expect(ada.s.status).toBe("live");
  expect(ada.s.tab).toMatch(/^[0-9a-z]{16}$/);
  expect(ada.s.tab).not.toBe(bo.s.tab);                                 // one clock, two sessions: two draws
  expect(ada.c.hellos.length).toBe(1);
  ada.s.reconnect(); net.settle();
  expect(ada.c.hellos.length).toBe(2);
  ada.s.dropConnection(); net.settle();                                 // an unasked drop: rule 12's backoff
  expect(ada.c.hellos.length).toBe(3);
  const resets = ada.s.binds.board.resets;
  ada.s.eds.board.setAppState({ bogus: 1 }); net.settle();              // refused: the link resyncs
  expect(ada.s.binds.board.resets).toBeGreaterThan(resets);
  expect(ada.c.hellos.length).toBe(4);
  expect(ada.s.status).toBe("live");
  for (const h of ada.c.hellos) expect(h.tab).toBe(ada.s.tab);
  for (const h of bo.c.hellos) expect(h.tab).toBe(bo.s.tab);
});

test("viewer: its hello carries the tab too, and stays the same on reconnect", () => {
  const net = localRoom({ users: USERS, clock: true });
  const ed = counted(net, "t-ed");
  net.settle();
  expect(ed.s.role).toBe("viewer");
  ed.s.reconnect(); net.settle();
  expect(ed.c.hellos.length).toBe(2);
  for (const h of ed.c.hellos) expect(h.tab).toBe(ed.s.tab);
});

test("the cap's backoff retries and the Retry button send the same tab", () => {
  const sc = scripted();
  const s = createSession({ join: sc.join, token: "tk", board: "b1", client: "me", user: "me", clock: sc.clock });
  const l = sc.links[0];
  l.on({ t: "error", code: "limit", message: CAP }); l.dropped();
  expect(s.status).toBe("limited");
  sc.advance(60_000);                                                   // several backoff tries
  const tries = sc.hellos().length;
  expect(tries).toBeGreaterThanOrEqual(3);
  s.reconnect();                                                        // Retry
  const hs = sc.hellos();
  expect(hs.length).toBe(tries + 1);
  for (const h of hs) expect(h.tab).toBe(s.tab);
  expect(s.tab).toBe(mintTab(() => 0.5));                               // minted from the clock port's random
});

test("a given tab is sent as given", () => {
  const net = localRoom({ users: USERS, clock: true });
  const a = counted(net, "t-ada", { tab: "given_Tab-1" });
  net.settle();
  expect(a.c.hellos.map(h => h.tab)).toEqual(["given_Tab-1"]);
});

test("no tab: openLink/bindEditor without one send a hello with no `tab` key, and nothing throws", () => {
  const sc = scripted();
  const b = bindEditor(new Editor(), { transport: sc.join(), token: "tk", board: "b1", clock: sc.clock });
  const link = openLink({ transport: sc.join(), token: "tk", board: "b1", tab: null, clock: sc.clock });
  link.start();
  expect(sc.hellos().length).toBe(2);
  sc.links[0].dropped(); sc.advance(5_000);                             // a reconnect too
  const hs = sc.hellos();
  expect(hs.length).toBe(3);
  for (const h of hs) expect("tab" in h).toBe(false);
  expect(b.status).not.toBe("stopped");
});

test("createSession: tab null means mint one; with no random at all it throws loudly (never a silent tab-less hello)", () => {
  // createSession hands random to sync.js, which needs one: a tab-less hello comes only from openLink/bindEditor.
  const sc = scripted();
  const s = createSession({ join: sc.join, token: "tk", board: "b1", client: "me", user: "me", clock: sc.clock, tab: null });
  expect(s.tab).toBe(mintTab(() => 0.5));                               // null means "mint one"
  const rawClock = { ...sc.clock, random: undefined };
  expect(() => createSession({ join: sc.join, token: "tk", board: "b1", clock: rawClock })).toThrow(/clock port|random/);
});

// ── every transport delivers it ──
test("ws.js: the hello frame on the wire carries the tab, on the first socket and after a server close", async () => {
  const w = wsNetwork({ users: USERS, seed: 4 });
  const frames = [];
  const send = w.bridge.WebSocket.prototype.send;
  w.bridge.WebSocket.prototype.send = function (data) { frames.push(jsonCodec.decode(data)); return send.call(this, data); };
  const s = createSession({ join: () => w.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: w.clock });
  await w.settle();
  expect(s.status).toBe("live");
  s.dropConnection(); w.bridge.flushCloses(); await w.settle();
  expect(s.status).toBe("live");
  const hellos = frames.filter(m => m.t === "hello");
  expect(hellos.length).toBe(2);
  for (const h of hellos) expect(h.tab).toBe(s.tab);
});

test("shared worker: the hello crosses the port with its tab and reaches the room behind roomHost", () => {
  const seen = [];
  const toFar = [], toTab = [];
  const tabPort = { onmessage: null, start() {}, postMessage: d => toFar.push(structuredClone(d)) };
  const farPort = { onmessage: null, start() {}, postMessage: d => toTab.push(structuredClone(d)) };
  let room = null;
  const host = roomHost({ makeNet: board => (room = localRoom({ board, users: USERS, clock: true, makeRoom: capturing(seen) })) });
  host.connect(farPort);
  const net = sharedNet({ board: "b1", worker: { port: tabPort } });
  const s = createSession({ join: () => net.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: localRoom({ users: USERS, clock: true }).clock });
  const pump = () => { let moved = true; while (moved) { moved = false; while (toFar.length) { farPort.onmessage?.({ data: toFar.shift() }); moved = true; } if (room?.step()) moved = true; while (toTab.length) { tabPort.onmessage?.({ data: toTab.shift() }); moved = true; } } };
  pump();
  const portHello = seen.find(m => m.t === "hello");
  expect(portHello).toBeTruthy();
  expect(portHello.tab).toBe(s.tab);
  expect(s.status).toBe("live");
});

test("in-page room (localNet, the no-SharedWorker fallback): the room is handed the hello with its tab", () => {
  const seen = [];
  const net = localRoom({ users: USERS, clock: true, makeRoom: capturing(seen) });
  const s = createSession({ join: () => net.join(), token: "t-ada", board: "b1", client: "ada", user: "ada", clock: net.clock });
  net.settle();
  expect(s.status).toBe("live");
  expect(seen.filter(m => m.t === "hello").map(m => m.tab)).toEqual([s.tab]);
  expect(typeof localNet).toBe("function");                             // localNet is localRoom({ auto: true }).join
});

// ── the real gateway acts on it ──
async function until(fn, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10); }
}

test("real gateway: a session's tab counts as one tab: two sessions on one tab get in, a third is refused per tab", async () => {
  const r = await rig();
  const clock = browserClock();
  const net = wsNet({ url: r.server.wsUrl, WebSocket: globalThis.WebSocket, clock });
  const open = (tab, client) => createSession({ join: () => net.join(), token: tokenOf("editor"), board: r.ids.board, client, user: "editor", clock, tab });
  const all = [];
  try {
    // A minted tab: the gateway accepts it (format checked there: `bad-op` otherwise).
    const minted = open(undefined, "m"); all.push(minted);
    await until(() => minted.status === "live", "minted tab live");
    // One tab string on two sessions = two connections of one tab: both in. A third is refused by the per-tab cap,
    // which only a gateway that read the session's `tab` can apply (no tab would make it a tab of its own).
    const a = open("sharedTab", "a"), b = open("sharedTab", "b"); all.push(a, b);
    await until(() => a.status === "live" && b.status === "live", "two connections of one tab live");
    const c = open("sharedTab", "c"); all.push(c);
    await until(() => c.status === "limited", "third connection of the tab limited");
    expect(c.limited).toMatch(/per tab/);
    // Another tab of the same user still gets in.
    const d = open("otherTab", "d"); all.push(d);
    await until(() => d.status === "live", "another tab live");
  } finally {
    for (const s of all) s.connection.close();
    await r.stop();
  }
});

// ── the refusal text: true for both caps ──
test("limit texts: pill, banner and tooltip say both causes and claim neither", () => {
  expect(LIMIT_TEXT).toMatch(/too many of your tabs or windows/);
  expect(LIMIT_TEXT).toMatch(/reconnected too quickly/);
  const pill = pillFor({ status: "limited", role: "presenter" });
  expect(pill).toMatchObject({ cls: "offline", text: "Connection limit" });
  expect(pill.text).not.toMatch(/tabs/);                                // the pill's few words can't name one cause
  const b = connectionBanner({ status: "limited", limited: CAP, nextTryIn: 2_000 });
  expect(b.text).toContain(LIMIT_TEXT);
  expect(b.text).toContain(CAP);                                        // the server's own message, as sent
  expect(b.text).toContain("retries by itself");
  expect(b.action).toBe("retry");
  const title = pillTitleFor({ cls: "offline", status: "limited", viewer: true });
  expect(title).toContain(LIMIT_TEXT);
  expect(title).toContain("Retry");
});

test("sync.js fallback when the refusal has no message: says both caps, not just connections", () => {
  const sc = scripted();
  const b = bindEditor(new Editor(), { transport: sc.join(), token: "tk", board: "b1", clock: sc.clock });
  sc.links[0].on({ t: "error", code: "limit" }); sc.links[0].dropped();
  expect(b.status).toBe("limited");
  expect(b.limited).toBe("too many tabs, or too many connections of this tab");
  expect(connectionBanner({ status: "limited", limited: b.limited }).text).toContain(LIMIT_TEXT);
});
