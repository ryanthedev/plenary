// p7-wire round 2 (p7-wirev): the writer cap retries on rule 12's backoff (PROTOCOL.md § Pacing), one test per rule the
// verifier's mutants found untested (MEDIUM-2), the capped tab's banner and pill (LOW-1), and destroy (LOW-2).
import { test, expect, beforeEach } from "bun:test";
import { bindEditor } from "../../../web/core/sync.js";
import { createSession } from "../../../web/core/session.js";
import { Editor } from "../../../packages/core/editor.js";
import { pillFor, connectionBanner, pillTitleFor } from "../../../web/core/roles.js";
import { collabFrame } from "../../../web/adapters/dom/collab/frame.js";
import { mountCollab } from "../../../web/adapters/dom/collab/ui.js";
import { syncCollabPort } from "../../../web/adapters/collab/sync.js";
import { syncRig } from "../adapters/collab-rig.js";
import { installDom } from "./fake-dom.js";
import { fakeClock } from "./clock.js";

const CAP = "at most 8 open writer connections per user on a board";
const WELCOME = (o = {}) => ({ t: "welcome", seq: 0, role: "editor", user: "me", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 }, ...o });

/** A virtual clock (random fixed at 0.5: every backoff factor is 0.75) and one scripted transport per join. */
function scripted() {
  let t = 0; const q = [];
  const clock = { now: () => t, mono: () => t, random: () => 0.5,
    set: (fn, ms) => { const h = { at: t + ms, fn }; q.push(h); return h; }, clear: h => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } };
  const advance = ms => { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const h = q[0]; if (!h || h.at > end) break; q.shift(); t = h.at; h.fn(); } t = end; };
  const links = [];
  const join = () => {
    const l = { sent: [], on: () => {}, dropped: () => {}, backlog: 0, congested: false };
    links.push(l);
    return { send: m => l.sent.push({ at: t, m }), onMessage: fn => { l.on = fn; }, onDrop: fn => { l.dropped = fn; }, reopen: () => {}, close: () => {},
      congested: () => l.congested, backlogBytes: () => l.backlog };
  };
  const hellos = l => l.sent.filter(x => x.m.t === "hello");
  return { clock, advance, join, links, hellos, now: () => t };
}
/** One bind on a scripted link. */
function bound() {
  const sc = scripted(), events = [];
  const b = bindEditor(new Editor(), { transport: sc.join(), token: "tk", board: "b1", clock: sc.clock, onRoom: ev => events.push(ev) });
  const l = sc.links[0];
  const refuse = () => { l.on({ t: "error", code: "limit", message: CAP }); l.dropped(); };
  return { ...sc, b, l, events, refuse };
}

// ── MEDIUM-1: the cap retries on rule 12's backoff ──
test("cap: refused, the tab stays limited and tries again on the backoff, with no click", () => {
  const r = bound();
  r.refuse();
  expect(r.b.status).toBe("limited");
  expect(r.b.limited).toBe(CAP);
  expect(r.events.filter(e => e.type === "limit").length).toBe(1);
  // First wait: min(30 s, 0.5 s × 2^1) × 0.75 = 750 ms.
  expect(r.b.nextTryAt).toBe(750);
  r.advance(749);
  expect(r.hellos(r.l).length).toBe(1);
  r.advance(1);
  expect(r.hellos(r.l).length).toBe(2);
  expect(r.b.status).toBe("limited");              // still the cap's state while the retry waits for an answer
  expect(r.b.limited).toBe(CAP);
});

test("cap: a slot frees: the next automatic try gets in (live, limited cleared), no Retry pressed", () => {
  const r = bound();
  r.refuse(); r.advance(750);                       // second hello
  r.refuse(); r.advance(1500);                      // third hello (1.5 s later)
  expect(r.hellos(r.l).length).toBe(3);
  r.l.on(WELCOME());                                // another tab closed: this one is let in
  expect(r.b.limited).toBe(null);
  expect(r.b.nextTryAt).toBe(null);
  expect(r.b.status).toBe("live");
});

test("cap: a tab that stays capped never tries more often than rule 12 allows, and settles at one try per 15–30 s", () => {
  const r = bound();
  const waits = [];
  for (let k = 0; k < 12; k++) {
    r.refuse();                                       // the refusal answers the hello just sent
    const w = r.b.nextTryAt - r.now(), n = r.hellos(r.l).length;
    waits.push(w);
    r.advance(w - 1);
    expect(r.hellos(r.l).length).toBe(n);             // nothing early
    r.advance(1);
    expect(r.hellos(r.l).length).toBe(n + 1);         // exactly one try when the backoff says
    expect(w).toBeGreaterThanOrEqual(Math.min(30_000, 500 * 2 ** (k + 1)) * 0.5);
  }
  expect(waits.slice(0, 4)).toEqual([750, 1500, 3000, 6000]);
  expect(waits.slice(-3).every(w => w >= 15_000 && w < 30_000)).toBe(true);
});

test("cap: the refusal itself is the failed attempt: a close that never comes (half-open) doesn't hold the retry to the 10 s watchdog", () => {
  const r = bound();
  r.l.on({ t: "error", code: "limit", message: CAP });   // no close follows
  expect(r.b.status).toBe("limited");
  expect(r.b.nextTryAt).toBe(750);
  r.advance(750);
  expect(r.hellos(r.l).length).toBe(2);
});

test("cap: an error with an id before any welcome (a late answer on this connection) never trips the cap", () => {
  const r = bound();
  r.l.on({ t: "error", id: "web.x:1", code: "limit", message: "a board holds at most 10,000 threads" });
  expect(r.b.limited).toBe(null);
  expect(r.b.status).toBe("connecting");
});

test("cap: Retry still tries at once", () => {
  const r = bound();
  r.refuse();
  r.b.reconnect();
  expect(r.hellos(r.l).length).toBe(2);
  expect(r.b.status).toBe("connecting");
});

test("cap: an id-less limit AFTER welcome (a blob refusal) never stops the tab", () => {
  const r = bound();
  r.l.on(WELCOME());
  expect(r.b.status).toBe("live");
  r.l.on({ t: "error", code: "limit", message: "blob requests: too many" });
  expect(r.b.status).toBe("live");
  expect(r.b.limited).toBe(null);
  r.advance(120_000);
  expect(r.hellos(r.l).length).toBe(1);
});

test("cap: a limit WITH an id (a rule-5 refusal of one records op) never stops the tab; onRefused says it", () => {
  const r = bound();
  r.l.on(WELCOME());
  r.b.record({ do: "thread", id: "c1", anchor: { point: { x: 0, y: 0 } }, text: "x" });
  const op = r.l.sent.find(x => x.m.t === "op").m;
  r.l.on({ t: "error", id: op.id, code: "limit", message: "a board holds at most 10,000 threads" });
  expect(r.b.status).toBe("live");
  expect(r.b.limited).toBe(null);
  expect(r.events.filter(e => e.type === "refused").map(e => e.code)).toEqual(["limit"]);
  expect(r.events.filter(e => e.type === "limit")).toEqual([]);
});

// ── MEDIUM-2: the verifier's untested rules ──
test("records ops are never dropped by the presence gate (backlog far over 16 KB)", () => {
  const r = bound();
  r.l.on(WELCOME());
  r.l.backlog = 10 * 1024 * 1024;
  expect(r.b.sendPresence("cursor", { x: 1, y: 1 })).toBe(false);   // presence is gated...
  r.b.record({ do: "thread", id: "c1", anchor: { point: { x: 0, y: 0 } }, text: "x" });
  expect(r.l.sent.filter(x => x.m.t === "op" && x.m.stream === "records").length).toBe(1);   // ...records are not
  expect(r.b.pendingRecords().length).toBe(1);
});

test("stale-setting: no retry before ready; ready lands on the refused change whose key moved, not another", () => {
  const sc = scripted(), events = [];
  const ed = new Editor();
  const b = bindEditor(ed, { transport: sc.join(), token: "tk", board: "b1", clock: sc.clock, onRoom: ev => events.push(ev) });
  const l = sc.links[0];
  l.on(WELCOME());
  ed.onOp({ appState: { timeline: { duration: 5000 } } });
  ed.onOp({ appState: { grid: 20 } });
  const ops = l.sent.filter(x => x.m.t === "op").map(x => x.m);
  expect(ops.length).toBe(2);
  for (const o of ops) l.on({ t: "error", id: o.id, code: "stale-setting", message: "base moved" });
  expect(b.settingsRefused.map(e => [e.keys[0], e.ready])).toEqual([["timeline", false], ["grid", false]]);
  expect(b.retrySetting(0)).toBe(false);           // not ready: a retry now would be built on the old base
  expect(b.retrySetting(1)).toBe(false);
  expect(l.sent.filter(x => x.m.t === "op").length).toBe(2);
  // The change that beat the timeline (the FIRST refusal) arrives: only the timeline's refusal becomes ready.
  l.on({ t: "entries", entries: [{ seq: 1, board: "b1", tenant: "t1", stream: "board", op: { appState: { timeline: { duration: 9000 } }, appBase: { timeline: 0 } }, by: "bo", id: "bo:1", at: 1, rv: 1 }] });
  expect(b.settingsRefused.map(e => [e.keys[0], e.ready])).toEqual([["timeline", true], ["grid", false]]);
  expect(b.retrySetting(1)).toBe(false);
  expect(b.retrySetting(0)).toBe(true);
  expect(l.sent.filter(x => x.m.t === "op").length).toBe(3);
  expect(l.sent.filter(x => x.m.t === "op").at(-1).m.op.appState).toEqual({ timeline: { duration: 5000 } });
});

test("frame: my selection goes out whenever it changed (Escape, select-all), not on every frame; pins follow pan, zoom and edits", () => {
  const sel = { board: new Set(), notes: new Set() };
  const S = { active: "board", eds: { board: { sel: sel.board, view: { x: 0, y: 0, scale: 1 } }, notes: { sel: sel.notes } }, v: 1, version() { return this.v; } };
  const calls = { sel: [], layout: 0 };
  const collab = { selection: (s, ids) => { calls.sel.push([s, ids]); return true; }, layout: () => { calls.layout++; } };
  const tick = collabFrame(S, collab);
  tick(); tick();
  expect(calls.sel).toEqual([["board", []]]);
  expect(calls.layout).toBe(1);
  sel.board.add("a"); sel.board.add("b"); tick(); tick();
  expect(calls.sel.at(-1)).toEqual(["board", ["a", "b"]]);
  sel.board.clear(); tick();                         // Escape: peers must drop it
  expect(calls.sel.at(-1)).toEqual(["board", []]);
  expect(calls.sel.length).toBe(3);
  S.eds.board.view = { x: 5, y: 0, scale: 1 }; tick();
  S.eds.board.view = { x: 5, y: 0, scale: 2 }; tick();
  S.v = 2; tick(); tick();
  expect(calls.layout).toBe(4);
  // A send the outbox refused (not live) is tried again on the next frame.
  let ok = false; const c2 = { selection: (s, ids) => { calls.sel.push(["2", ids]); return ok; }, layout() {} };
  const t2 = collabFrame(S, c2);
  t2(); t2(); ok = true; t2(); t2();
  expect(calls.sel.filter(x => x[0] === "2").length).toBe(3);
});

test("congested: the link's backlog shows on the pill, and a viewer's pill says slow link too", () => {
  const sc = scripted();
  const s = createSession({ join: sc.join, token: "tk", board: "b1", client: "me", user: "me", clock: sc.clock });
  expect(s.congested).toBe(false);
  expect(sc.links.length).toBe(1);                    // p8-one-link: one link per tab
  sc.links[0].congested = true;
  expect(s.congested).toBe(true);
  sc.links[0].congested = false;
  expect(s.congested).toBe(false);
  sc.links[0].congested = true;
  expect(s.congested).toBe(true);
  expect(pillFor({ status: "live", role: "viewer", congested: true })).toMatchObject({ cls: "readonly", sub: "slow link" });
  expect(pillFor({ status: "live", role: "viewer" }).sub).toBe("");
});

test("me.user follows welcome.user (rule 13), not the root's display-only user", async () => {
  const sc = scripted();
  const s = createSession({ join: sc.join, token: "tk", board: "b1", client: "me", user: "shown-name", clock: sc.clock });
  const port = syncCollabPort(s, { name: "Me", frame: fn => fn() });
  expect(port.me.user).toBe("shown-name");             // before any welcome: the root's
  const me = port.me;
  sc.links[0].on(WELCOME({ user: "room-user" }));
  expect(port.me).toBe(me);                            // one stable object...
  expect(port.me.user).toBe("room-user");              // ...whose user the room set
});

test("notes() and noteAuthor come from the notes connection: my own unacked note shows at once", async () => {
  const d = await syncRig("annotator");
  d.me.placeNote({ x: 10, y: 10 }, "mine, not acked yet");
  const id = d.me.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  expect(d.port.notes().some(e => e.id === id)).toBe(true);           // before any delivery
  expect(d.port.element("notes", id)).not.toBe(null);
  await d.settle();
  expect(d.port.noteAuthor(id)).toBe("me");
  // The peer's note: its author comes from the notes connection too (the board connection's copy is not asked first).
  d.me.binds.board.noteAuthor = () => "wrong";
  d.bo.placeNote({ x: 400, y: 400 }, "the peer's");
  await d.settle();
  const pid = d.bo.eds.notes.doc.live().find(e => e.type === "rectangle" && e.id !== id).id;
  expect(d.port.noteAuthor(pid)).toBe("bo");
});

// ── LOW-1: a capped tab shows only the cap ──
test("LOW-1: limited shows only the cap banner (no Connecting…), with the next try; the pill tooltip says the cap", () => {
  const b = connectionBanner({ status: "limited", viewer: true, limited: CAP, nextTryIn: 12_300 });
  expect(b.text).toContain("too many of your tabs");
  expect(b.text).toContain(CAP);
  expect(b.text).toContain("in 13 s");
  expect(b.text).not.toMatch(/Connecting/);
  expect(b.action).toBe("retry");
  expect(connectionBanner({ status: "limited", limited: CAP, nextTryIn: 200 }).text).toContain("Trying again now");
  expect(connectionBanner({ status: "connecting", viewer: true }).text).toMatch(/Connecting/);
  expect(connectionBanner({ status: "live" })).toBe(null);
  // Before any welcome a capped tab's chrome is the viewer's: the cap still wins the tooltip.
  expect(pillTitleFor({ cls: "offline", status: "limited", viewer: true })).toMatch(/too many of your tabs/);
  expect(pillTitleFor({ cls: "offline", status: "connecting", viewer: true })).toMatch(/No live connection/);
});

test("LOW-1: the session's limitedNextTry is the bind's armed retry", () => {
  const sc = scripted();
  const s = createSession({ join: sc.join, token: "tk", board: "b1", client: "me", user: "me", clock: sc.clock });
  // p8-one-link: the one link is capped before its welcome (the cap answers a hello, never a welcomed link).
  expect(sc.links.length).toBe(1);
  sc.links[0].on({ t: "error", code: "limit", message: CAP }); sc.links[0].dropped();
  expect(s.status).toBe("limited");
  expect(s.limitedNextTry).toBe(750);
  sc.advance(750);
  expect(s.limitedNextTry).toBe(null);                 // the retry went out; no new one armed until it's answered
  expect(s.status).toBe("limited");
});

// ── LOW-2: destroy releases the port; a queued frame does nothing ──
let dom;
beforeEach(() => { dom = installDom(); });
test("LOW-2: mountCollab's destroy() calls port.destroy(), and a records frame queued before it never fires", async () => {
  const d = await syncRig("viewer");
  const frames = d.frames;
  const clock = fakeClock();
  const c = mountCollab({ root: dom.root, port: d.port, view: { toScreen: p => p, toWorld: p => p, scale: 1 }, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) } });
  let fired = 0;
  d.port.onRecords(() => fired++);
  d.bo.binds.board.record({ do: "thread", id: "x1", anchor: { point: { x: 0, y: 0 } }, text: "late" });
  d.net.settle();
  expect(frames.length).toBe(1);                       // a records frame is queued
  let released = 0; const inner = d.port.destroy; d.port.destroy = () => { released++; inner(); };
  c.destroy();
  expect(released).toBe(1);
  for (const fn of frames.splice(0)) fn();
  expect(fired).toBe(0);
});

// ── Round 3 (p7-wirev R2-M1): a refusal wins over the cap ──
test("cap, then `auth` on the automatic retry: refused (not limited), the refused banner, and no more hellos", () => {
  const r = bound();
  r.refuse();
  expect(r.b.status).toBe("limited");
  r.advance(750);                                    // the backoff's retry
  expect(r.hellos(r.l).length).toBe(2);
  r.l.on({ t: "error", code: "auth", message: "token refused" }); r.l.dropped();
  expect(r.b.status).toBe("refused");
  expect(r.b.limited).toBe(null);
  expect(r.b.nextTryAt).toBe(null);
  expect(connectionBanner({ status: r.b.status, limited: r.b.limited }).text).toMatch(/refused this sign-in/);
  r.advance(10 * 60_000);                            // ten minutes: nothing tries again until the user signs in
  expect(r.hellos(r.l).length).toBe(2);
  expect(r.b.status).toBe("refused");
});
