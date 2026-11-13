// p7-wire: what only the sync-side collab port (web/adapters/collab/sync.js) and web/core/sync.js do, beyond the
// shared contract (test/web/contracts/collab-contract.js): one connection for presence and records, my two client
// ids filtered, onRecords coalesced, the writer-connection cap, stale-setting retries, the count-only `here` in the
// model, +N on phones, and a mid-session role change through the mounted UI (p7-collabv M1–M4).
import { test, expect, beforeEach } from "bun:test";
import { syncRig } from "../adapters/collab-rig.js";
import { bindEditor } from "../../../web/core/sync.js";
import { createSession } from "../../../web/core/session.js";
import { Editor } from "../../../packages/core/editor.js";
import { createPresence } from "../../../web/core/collab/presence-model.js";
import { pillFor } from "../../../web/core/roles.js";
import { mountCollab } from "../../../web/adapters/dom/collab/ui.js";
import { createFakePort } from "../../../web/adapters/collab/fake.js";
import { installDom } from "./fake-dom.js";
import { fakeClock } from "./clock.js";

const EL = id => ({ id, type: "rectangle", x: 1, y: 2, width: 3, height: 4, version: 2, versionNonce: 5 });

test("me.client is the board connection's wire id: the peer sees my presence under it", async () => {
  const d = await syncRig("editor");
  expect(d.port.me.client).toBe(d.me.binds.board.client);
  expect(d.me.binds.notes.client).toBe(d.port.me.client);   // p8-one-link: one link, one wire id for both streams
  expect(d.port.me.user).toBe("me");
  const got = [];
  d.bo.onRoom((stream, ev) => { if (stream === "board" && ev.type === "presence") got.push(...ev.batch); });
  expect(d.port.send("cursor", { x: 1, y: 1 })).toBe(true);
  await d.settle();
  expect(got.filter(m => m.k === "cursor").map(m => m.client)).toEqual([d.port.me.client]);
});

test("my own notes connection's presence never shows as a peer (both my client ids are filtered)", async () => {
  const d = await syncRig("editor");
  const got = [];
  d.port.onPresence(b => got.push(...b));
  expect(d.me.binds.notes.sendPresence("preview", { stream: "notes", elements: [EL("n1")] })).toBe(true);
  expect(d.me.binds.notes.sendPresence("cursor", { x: 5, y: 5 })).toBe(true);
  await d.settle();
  expect(got).toEqual([]);
  expect(d.port.previews("notes")).toEqual([]);
  // ...while the peer does see them (so the filter, not the room, dropped them here).
  expect(d.bo.binds.board.previewEntries("notes").map(p => p.el.id)).toEqual(["n1"]);
});

test("presence and here come from the board connection only (the notes connection's copy is ignored)", async () => {
  const d = await syncRig("editor");
  const pres = [], heres = [];
  d.port.onPresence(b => pres.push(...b)); d.port.onHere(h => heres.push(h));
  await d.peerPresence({ k: "emote", e: "🎉" });
  expect(pres.filter(m => m.k === "emote").length).toBe(1);
  await d.here({ t: "here", writers: [], writerCount: 0, viewers: 3 });
  expect(heres.length).toBe(1);
});

test("the real room's here: names, a count-only here when only viewers change, avatars kept", async () => {
  const d = await syncRig("editor", { users: { "t-ed": { user: "ed", name: "Ed", role: "viewer" } } });
  const heres = [];
  d.port.onHere(h => heres.push(h));
  const raw = [];
  d.me.onRoom((s, ev) => { if (s === "board" && ev.type === "here") raw.push(ev.msg); });
  const t = d.net.join();
  t.send({ t: "hello", v: 1, token: "t-ed", board: "b1", since: 0, client: "ed.x" });
  await d.settle();
  expect(raw.at(-1).writers).toBeUndefined();                 // the stand-in sent it count-only
  expect(heres.at(-1).viewers).toBe(1);
  expect(heres.at(-1).writers.map(w => w.name).sort()).toEqual(["Bo", "Me"]);
  expect(heres.at(-1).writerCount).toBe(2);
});

test("M4: onRecords is coalesced: 40 entries in one delivery run make one call, and records() is cached", async () => {
  const d = await syncRig("viewer");
  let n = 0;
  d.port.onRecords(() => n++);
  for (let i = 0; i < 40; i++) d.bo.binds.board.record({ do: "thread", id: `t${i}`, anchor: { point: { x: i, y: 0 } }, text: `#${i}` });
  d.net.settle();
  expect(n).toBe(0);                                          // nothing until the frame
  expect(d.frames.length).toBe(1);                            // one frame asked for, not 40
  for (const fn of d.frames.splice(0)) fn();
  expect(n).toBe(1);
  const a = d.port.records(), b = d.port.records();
  expect(a).toBe(b);                                          // same object while nothing changed
  expect(a.threads.length).toBe(40);
});

test("the presence gate: nothing goes out over 16 KB of backlog, and nothing while not live", async () => {
  const d = await syncRig("editor");
  const B = d.me.binds.board;
  d.me.link.backlogBytes = () => 16 * 1024 + 1;
  // s.link is the session's wrapper; sync.js holds that same object, so this reaches its gate.
  expect(B.sendPresence("cursor", { x: 1, y: 1 })).toBe(false);
  d.me.link.backlogBytes = () => 16 * 1024;
  expect(B.sendPresence("cursor", { x: 2, y: 2 })).toBe(true);
  d.me.dropConnection();
  expect(B.sendPresence("select", { stream: "board", ids: [] })).toBe(false);
});

// ── the writer-connection cap: shown, not retried in a loop ──
function capRig() {
  let t = 0; const q = [];
  const clock = { now: () => t, mono: () => t, random: () => 0.5, set: (fn, ms) => { const h = { at: t + ms, fn }; q.push(h); return h; }, clear: h => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } };
  const advance = ms => { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const h = q[0]; if (!h || h.at > end) break; q.shift(); t = h.at; h.fn(); } t = end; };
  const sent = []; let handler = () => {}, dropped = () => {};
  const transport = { send: m => sent.push(m), onMessage: fn => { handler = fn; }, onDrop: fn => { dropped = fn; }, reopen: () => {}, close: () => {}, congested: () => false, backlogBytes: () => 0 };
  const events = [];
  const b = bindEditor(new Editor(), { transport, token: "tk", board: "b1", clock, onRoom: ev => events.push(ev) });
  return { b, sent, advance, events, refuse: () => { handler({ t: "error", code: "limit", message: "at most 8 open writer connections per user on a board" }); dropped(); } };
}

test("writer cap: the session's merged status is limited when its one link is (both streams' binds say so)", () => {
  const links = [];
  const join = () => { const l = { sent: [], on: () => {} }; links.push(l); return { send: m => l.sent.push(m), onMessage: fn => { l.on = fn; }, onDrop: () => {}, reopen: () => {}, close: () => {}, congested: () => false, backlogBytes: () => 0 }; };
  const clock = { now: () => 0, mono: () => 0, random: () => 0.5, set: () => 0, clear: () => {} };
  const s = createSession({ join, token: "tk", board: "b1", client: "me", user: "me", clock });
  // p8-one-link: one link carries both streams, so the cap's refusal reaches both binds at once.
  expect(links.length).toBe(1);
  const [link] = links;
  expect(s.status).not.toBe("limited");
  link.on({ t: "error", code: "limit", message: "at most 8 open writer connections per user on a board" });
  expect(s.status).toBe("limited");
  expect(s.binds.notes.limited).toMatch(/at most 8/);
  expect(s.binds.board.limited).toMatch(/at most 8/);
  expect(s.limited).toMatch(/at most 8/);
});

test("writer cap: the pill says so", () => {
  expect(pillFor({ status: "limited", role: "presenter" })).toMatchObject({ cls: "offline", text: "Connection limit" });
  expect(pillFor({ status: "live", role: "presenter", congested: true }).sub).toContain("slow link");
  expect(pillFor({ status: "live", role: "presenter" }).sub).toBe("");
});

// ── stale-setting: shown, retried on the current base when retryReady says so ──
test("stale-setting: the losing settings change is listed, becomes ready, and a retry lands it", async () => {
  const d = await syncRig("editor");
  d.me.eds.board.onOp({ appState: { timeline: { duration: 5000 } } });
  d.bo.eds.board.onOp({ appState: { timeline: { duration: 7000 } } });
  await d.settle();
  const lists = [d.me.settingsRefused, d.bo.settingsRefused];
  const loser = lists[0].length ? d.me : d.bo, winner = loser === d.me ? 7000 : 5000, mine = loser === d.me ? 5000 : 7000;
  expect(lists[0].length + lists[1].length).toBe(1);
  const [e] = loser.settingsRefused;
  expect(e).toMatchObject({ stream: "board", code: "stale-setting", keys: ["timeline"], ready: true });
  expect(loser.eds.board.doc.appState.herdr.timeline.duration).toBe(winner);   // the board's value shows meanwhile
  expect(loser.retrySetting("board", e.i)).toBe(true);
  await d.settle();
  expect(loser.settingsRefused).toEqual([]);
  for (const s of [d.me, d.bo]) expect(s.eds.board.doc.appState.herdr.timeline.duration).toBe(mine);
});

test("stale-setting: dismiss forgets it; an unready one can't be retried", async () => {
  const d = await syncRig("editor");
  d.me.eds.board.onOp({ appState: { timeline: { duration: 5000 } } });
  d.bo.eds.board.onOp({ appState: { timeline: { duration: 7000 } } });
  await d.settle();
  const loser = d.me.settingsRefused.length ? d.me : d.bo;
  loser.dismissSetting("board", 0);
  expect(loser.settingsRefused).toEqual([]);
  expect(loser.retrySetting("board", 0)).toBe(false);
});

// ── the model: a count-only here keeps the avatars (t14k addition) ──
test("presence model: a count-only here (no writers field) keeps the list and names; counts update", () => {
  const p = createPresence({ now: () => 0, me: { user: "me", client: "c" }, role: "viewer" });
  p.here({ writers: [{ user: "maya", name: "Maya", role: "owner" }, { user: "dev", name: "Dev", role: "annotator" }], writerCount: 2, viewers: 5 });
  p.here({ writerCount: 3, viewers: 9 });
  const h = p.view().here;
  expect(h.writers.map(w => w.user)).toEqual(["maya", "dev"]);
  expect(h).toMatchObject({ writerCount: 3, viewers: 9 });
  expect(p.nameOf("maya")).toBe("Maya");
  expect(p.shows("maya")).toBe(true);                         // roleOf kept: a viewer still sees the presenter
  p.here({ viewers: 4 });                                     // neither list nor writerCount: the count stays
  expect(p.view().here).toMatchObject({ writerCount: 3, viewers: 4 });
  p.here({ writers: [], writerCount: 0, viewers: 0 });        // an explicit empty list clears
  expect(p.view().here.writers).toEqual([]);
  expect(p.nameOf("maya")).toBe(null);
});

// ── UI over the ports ──
let dom;
beforeEach(() => { dom = installDom(); });
const view = { toScreen: p => p, toWorld: p => p, scale: 1 };

test("M3: +N counts against what phones show (2 avatars), and against 5 on desktop", () => {
  const clock = fakeClock();
  const port = createFakePort({ role: "editor", now: clock.now });
  const c = mountCollab({ root: dom.root, port, view, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) } });
  port.here({ writers: [...Array(8).keys()].map(i => ({ user: `u${i}`, name: `U ${i}`, role: "annotator" })), writerCount: 42, viewers: 0 });
  const more = c.parts.avatars.all().filter(e => e.hasClass("more"));
  const desk = more.find(e => e.hasClass("desk-more")), phone = more.find(e => e.hasClass("phone-more"));
  expect(desk.textContent).toBe("+37");
  expect(phone.textContent).toBe("+40");
});

test("M3: no phone +N when two or fewer write; a desktop +N only past five", () => {
  const clock = fakeClock();
  const port = createFakePort({ role: "editor", now: clock.now });
  const c = mountCollab({ root: dom.root, port, view, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) } });
  port.here({ writers: [{ user: "a", name: "A", role: "owner" }, { user: "b", name: "B", role: "owner" }], writerCount: 2, viewers: 0 });
  expect(c.parts.avatars.all().filter(e => e.hasClass("more"))).toEqual([]);
  port.here({ writers: [...Array(4).keys()].map(i => ({ user: `u${i}`, name: `U ${i}`, role: "owner" })), writerCount: 4, viewers: 0 });
  const more = c.parts.avatars.all().filter(e => e.hasClass("more"));
  expect(more.map(e => [e.hasClass("phone-more"), e.textContent])).toEqual([[true, "+2"]]);
});

test("count-only here through the UI never clears the avatar row", () => {
  const clock = fakeClock();
  const port = createFakePort({ role: "editor", now: clock.now });
  const c = mountCollab({ root: dom.root, port, view, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) } });
  port.here({ writers: [{ user: "maya", name: "Maya Q", role: "owner" }], writerCount: 1, viewers: 2 });
  port.here({ writerCount: 1, viewers: 50 });
  const avs = c.parts.avatars.all().filter(e => e.hasClass("av") && !e.hasClass("more"));
  expect(avs.map(e => e.getAttribute("title"))).toEqual(["Maya Q"]);
  expect(c.parts.avatars.textContent).toContain("50");
});

/** The UI mounted over the sync-side port of a live session. */
async function mounted(role) {
  const d = await syncRig(role, { users: { "t-cy": { user: "cy", name: "Cy", role: "annotator" } } });
  const clock = fakeClock();
  let n = 0;
  const c = mountCollab({ root: dom.root, port: d.port, view, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) }, idGen: () => `r${++n}` });
  return { d, c, clock };
}
const out = d => d.sent().map(m => m.k);

test("M2: a downgrade editor → viewer mid-session: cursor, laser and records stop; the viewer flag applies", async () => {
  const { d, c, clock } = await mounted("editor");
  // An annotator's cursor: an editor sees it.
  const cy = d.net.join();
  cy.send({ t: "hello", v: 1, token: "t-cy", board: "b1", since: 0, client: "cy.1" });
  await d.settle();
  cy.send({ t: "presence", k: "cursor", x: 9, y: 9 });
  await d.settle();
  expect(c.presence.view().cursors.map(x => x.user)).toContain("cy");
  expect(c.pointer({ x: 1, y: 1 })).toBe(true);
  expect(c.laser({ x: 1, y: 1 })).toBe(true);
  expect(c.startComment({ x: 0, y: 0 })).toBe(true);

  await d.setRole("viewer");
  clock.advance(2000);
  expect(d.port.role).toBe("viewer");
  const before = d.sent().length;
  expect(c.pointer({ x: 2, y: 2 })).toBe(false);
  expect(c.laser({ x: 2, y: 2 })).toBe(false);
  expect(c.selection("board", ["x"])).toBe(false);
  clock.advance(15_000);                                      // the 10 s cursor repeat must not go out either
  await d.settle();
  expect(d.sent().slice(before).filter(m => m.k !== "emote")).toEqual([]);
  expect(c.startComment({ x: 0, y: 0 })).toBe(false);
  // The viewer flag: an annotator's cursor is no longer drawn for me.
  cy.send({ t: "presence", k: "cursor", x: 10, y: 10 });
  await d.settle();
  expect(c.presence.view().cursors.map(x => x.user)).not.toContain("cy");
  // Records: a viewer's op is stopped before the port (no pending, a message instead).
  d.port.thread;                                              // (the port itself doesn't gate: the UI does)
  expect(d.port.records().pending).toEqual([]);
  expect(c.emote("👍")).toBe(true);                           // viewers still emote
});

test("M2: a downgrade editor → commenter: cursor and comments stay, laser stops", async () => {
  const { d, c, clock } = await mounted("editor");
  await d.setRole("commenter");
  clock.advance(2000);
  expect(d.port.role).toBe("commenter");
  expect(c.laser({ x: 2, y: 2 })).toBe(false);
  expect(c.pointer({ x: 3, y: 3 })).toBe(true);
  clock.advance(100);
  await d.settle();
  expect(out(d)).toContain("cursor");
  expect(out(d).filter(k => k === "laser").length).toBe(0);
  expect(c.startComment({ x: 0, y: 0 })).toBe(true);
  const ta = dom.root.all().find(e => e.tagName === "TEXTAREA");
  ta.value = "from a commenter";
  dom.root.all().find(e => e.tagName === "BUTTON" && e.textContent === "Comment").click();
  await d.settle();
  expect(d.port.records().threads.map(t => t.comments[0].text)).toEqual(["from a commenter"]);
});

test("M2: role stays the last one while reconnecting, so records still queue offline", async () => {
  const { d, c } = await mounted("annotator");
  d.me.dropConnection();
  expect(d.port.status).not.toBe("live");
  expect(d.port.role).toBe("annotator");                      // kept while down (the port falls back to the last one seen)
  expect(c.startComment({ x: 0, y: 0 })).toBe(true);
  const ta = dom.root.all().find(e => e.tagName === "TEXTAREA");
  ta.value = "offline";
  dom.root.all().find(e => e.tagName === "BUTTON" && e.textContent === "Comment").click();
  expect(d.port.records().pending.length).toBe(1);
  await d.settle();
  expect(d.port.records().pending).toEqual([]);
});

test("onRefused: only a rule-5 refusal of my records op; never stale, unavailable or an element op's", () => {
  let t = 0;
  const clock = { now: () => t, mono: () => t, random: () => 0.5, set: () => 0, clear: () => {} };
  const sent = []; let handler = () => {};
  const transport = { send: m => sent.push(m), onMessage: fn => { handler = fn; }, onDrop: () => {}, reopen: () => {}, close: () => {}, congested: () => false, backlogBytes: () => 0 };
  const events = [];
  const b = bindEditor(new Editor(), { transport, token: "tk", board: "b1", clock, timeoutMs: 0, onRoom: ev => events.push(ev) });
  handler({ t: "welcome", seq: 0, role: "editor", user: "me", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });
  b.record({ do: "thread", id: "a", anchor: { point: { x: 0, y: 0 } }, text: "one" });
  b.record({ do: "thread", id: "b", anchor: { point: { x: 0, y: 0 } }, text: "two" });
  const ops = sent.filter(m => m.t === "op");
  expect(ops.length).toBe(2);
  handler({ t: "error", id: ops[0].id, code: "stale", message: "maybe logged" });
  expect(events.filter(e => e.type === "refused")).toEqual([]);
  handler({ t: "error", id: ops[1].id, code: "forbidden", message: "no" });
  expect(events.filter(e => e.type === "refused")).toEqual([{ type: "refused", op: { do: "thread", id: "b", anchor: { point: { x: 0, y: 0 } }, text: "two" }, code: "forbidden", message: "no" }]);
});

test("M2: a compose box left open across a downgrade to viewer sends nothing (the role is read at send time)", async () => {
  const { d, c } = await mounted("editor");
  expect(c.startComment({ x: 0, y: 0 })).toBe(true);
  await d.setRole("viewer");
  const ta = dom.root.all().find(e => e.tagName === "TEXTAREA");
  ta.value = "too late";
  dom.root.all().find(e => e.tagName === "BUTTON" && e.textContent === "Comment").click();
  expect(d.port.records().pending).toEqual([]);
  expect(c.state.toast).toMatch(/viewer/);
  await d.settle();
  expect(d.port.records().threads).toEqual([]);
});
