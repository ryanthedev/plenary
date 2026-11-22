// The canvas page itself (web/adapters/dom/app.js) mounted on a stub DOM over the in-page room and its virtual clock
// (p7-chrome): the chrome is rebuilt only when what a part shows changes (C-2, C-8), the zoom % and pill update in
// place, `online` / a long-hidden tab reconnects (C-4), the collab UI gets the clock port (C-6), a refused or
// expiring sign-in offers "Sign in again" (C-9), and the cap's countdown reads the clock port (C-17).
import { BLOB_PENDING_MS } from "../../packages/protocol/envelope.js";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { announced } from "../../web/adapters/dom/focus.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { expiryNotice, shouldProbe, takeReturnBoard, rememberBoard, connectionBanner, RETURN_KEY, EXPIRY_WARN_MS } from "../../web/core/roles.js";

import { installPage as install, stub, fireWin, restoreGlobals } from "./stub-page.js";
let page;
const installPage = () => (page = install());
afterAll(restoreGlobals);

const USERS = { "t-ada": { user: "ada", role: "owner" }, "t-bo": { user: "bo", role: "editor" }, "t-cy": { user: "cy", role: "annotator" },
  "t-di": { user: "di", role: "annotator" }, "t-vi": { user: "vi", role: "viewer" } };

/** ada's page over a room with bo (a second presenter, headless) on the same virtual clock. */
function setup({ expAt = null, relogin = null, collab = false, role = null, token = "t-ada", prefs = memoryStore(), wrap = null, appNet = null, access = null, share = null, move = null, trashShown = undefined } = {}) {
  installPage();
  const net = localRoom({ users: USERS, clock: true });
  const joins = [], hooks = {};
  const bo = createSession({ join: () => net.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: net.clock });
  bo.setSize(1200, 800);
  const app = mountApp({
    startSession: ({ mine, onChange }) => { hooks.onChange = onChange; return createSession({ join: () => { const t = net.join(); joins.push(t); return wrap ? wrap(t) : t; }, token, board: "b1", client: USERS[token].user, user: USERS[token].user, mine, onChange, clock: net.clock }); },
    net: appNet ?? { kind: "local", put() {}, onFile() {} }, board: "b1", me: { user: USERS[token].user, name: "Ada", role }, prefs, theme: "light",
    clock: net.clock, expAt, relogin, access, share, ...(trashShown ? { trashShown } : {}), move: move && { clock: net.clock, ...move }, newKey: () => "key-pill-0001",
    collab: collab ? (S, o) => { hooks.jumpTo = o.jumpTo; return syncCollabPort(S, { name: "Ada", frame: fn => net.clock.set(fn, 16), ...o }); } : null,
  });
  /** n animation frames, 16 ms of virtual time each, the room settled in between. */
  // Deliveries until quiet, then 16 ms of timers (never settle(): the collab UI's frame loop re-arms forever).
  const step = (n = 1) => { for (let i = 0; i < n; i++) { while (net.step()); net.advance(16); while (net.step()); const q = stub.frames; stub.frames = []; for (const fn of q) fn(); } };
  step(3);
  return { net, app, S: app.S, bo, step, joins, hooks, prefs };
}
const counts = () => Object.fromEntries(["topbar", "panel", "drawer", "timeline"].map(id => [id, page.byId[id].replaced ?? 0]));
const delta = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, b[k] - a[k]]));
const zero = { topbar: 0, panel: 0, drawer: 0, timeline: 0 };
const text = el => el.textContent;
const find = (root, pred) => root.all().find(pred);

function drawRect(s, x, y) { s.setTool("rectangle"); s.pointerDown({ x, y }); s.pointerMove({ x: x + 60, y: y + 40 }); s.pointerUp({ x: x + 60, y: y + 40 }); }

let rig;
beforeEach(() => { rig = null; });

test("C-2/C-8: 60 frames of wheel panning and 100 incoming ops rebuild topbar, panel, drawer and timeline 0 times; a real change still does", () => {
  rig = setup();
  const { S, bo, step, app, net } = rig;
  expect(S.role).toBe("presenter");
  expect(page.byId.topbar.all().filter(e => e.tagName === "BUTTON" && /\btb\b/.test(e.className)).every(e => e.attrs["aria-label"] && e.attrs.title)).toBe(true);
  // A busy board: the other presenter has shapes; the notes drawer is open.
  drawRect(bo, 100, 100); step(2);
  app.ui.drawer = "notes"; app.setPanel({ type: "noop" }); step(2);
  expect(page.byId.drawer.hidden).toBe(false);
  expect(page.byId.timeline.hidden).toBe(false);
  expect(page.byId.panel.hidden).toBe(false);
  step(20);                                           // let the throttle window pass
  let c0 = counts(), r0 = { ...app.ui.rebuilds };
  // No scan of the board per frame either: frames(), the timeline's and panel's source, runs once per Doc revision.
  let scans = 0;
  const frames0 = S.eds.board.frames;
  S.eds.board.frames = function () { scans++; return frames0.call(this); };
  const zoom = () => find(page.byId.hudBL, e => e.className === "pct" && /%$/.test(e.textContent));
  const zoomNode = zoom();
  // Wheel pan (trackpad) for 60 frames.
  for (let i = 0; i < 60; i++) { page.board.fire("wheel", { deltaX: 3, deltaY: 5, clientX: 400, clientY: 300 }); step(); }
  // Pinch-zoom (ctrl+wheel) for a few frames: the zoom % changes in place, on the same node.
  for (let i = 0; i < 5; i++) { page.board.fire("wheel", { deltaX: 0, deltaY: -10, ctrlKey: true, clientX: 400, clientY: 300 }); step(); }
  expect(scans).toBe(0);
  // 100 incoming ops that change nothing the chrome shows: the other presenter nudges its shape.
  const id = [...bo.eds.board.doc.live()][0].id;
  for (let i = 0; i < 100; i++) { bo.act("board", e => { e.select([id]); e.key("right", {}); }); step(); }
  step(20);
  expect(S.eds.board.doc.get(id).x).toBe(bo.eds.board.doc.get(id).x);      // the ops did arrive
  expect(delta(c0, counts())).toEqual(zero);
  expect(app.ui.rebuilds.topbar - r0.topbar).toBe(0);
  expect(zoom()).toBe(zoomNode);                                            // never rebuilt...
  expect(zoomNode.textContent).toBe(`${Math.round(S.eds.board.view.scale * 100)}%`);   // ...and current
  expect(S.eds.board.view.scale).not.toBe(1);

  // A real change still updates each part.
  const notesBtn = () => find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs.title === "Notes");
  expect(text(notesBtn())).toBe("Notes 0");
  c0 = counts();
  bo.placeNote({ x: 300, y: 300 }, "from bo"); step(20);                     // incoming note: topbar count + drawer row
  expect(text(notesBtn())).toBe("Notes 1");
  expect(text(page.byId.drawer)).toContain("from bo");
  let d = delta(c0, counts());
  expect(d.topbar).toBe(1); expect(d.drawer).toBe(1);
  c0 = counts();
  bo.act("board", e => { e.select([id]); e.animate("fade"); }); step(20);  // an animation mark: the timeline
  expect(delta(c0, counts()).timeline).toBe(1);
  expect(page.byId.timeline.all().some(e => e.className === "mark")).toBe(true);
  c0 = counts();
  drawRect(bo, 500, 500); step(20);                                         // a new shape: the layer count in the panel
  expect(delta(c0, counts()).panel).toBe(1);
  void net;
});

test("More menu exposes header actions and closes with Escape or an outside click", () => {
  rig = setup({ collab: true });
  const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
  expect(more?.attrs["aria-haspopup"]).toBe("menu");
  expect(more?.attrs["aria-expanded"]).toBe("false");
  more.click();
  expect(more.attrs["aria-expanded"]).toBe("true");
  const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("header-more-menu"));
  expect(["Comments", "Notes", "Mermaid", "Export", "Side panel", "Light / dark"].every(label => menu.all().some(e => e.tagName === "BUTTON" && e.attrs["aria-label"] === label))).toBe(true);
  expect(menu.all().filter(e => e.tagName === "BUTTON").every(e => e.attrs.role === "menuitem")).toBe(true);
  menu.fire("keydown", { key: "Escape" });
  expect(more.attrs["aria-expanded"]).toBe("false");
  expect(page.doc.activeElement).toBe(more);
  more.click();
  page.doc.fire("click", { target: page.byId.panel });
  expect(more.attrs["aria-expanded"]).toBe("false");
});

test("More menu closes when the desktop width media query changes", () => {
  rig = setup();
  const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
  more.click();
  expect(more.attrs["aria-expanded"]).toBe("true");
  const query = "(min-width: 1024px) and (max-width: 1279px)";
  const m = page.media.get(query);
  m.matches = false;
  for (const fn of m.listeners) fn({ matches: false });
  rig.step();
  expect(find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More").attrs["aria-expanded"]).toBe("false");
});

test("More menu follows menu keyboard navigation and restores focus after activation", () => {
  rig = setup({ collab: true });
  const more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
  more.fire("keydown", { key: "ArrowDown" });
  const menu = find(page.byId.topbar, e => e.attrs.role === "menu" && e.classList.contains("header-more-menu"));
  const items = menu.all().filter(e => e.attrs.role === "menuitem");
  expect(page.doc.activeElement).toBe(items[0]);
  expect(items.length).toBeGreaterThan(2);
  items[0].focus(); menu.fire("keydown", { key: "ArrowDown" });
  expect(page.doc.activeElement).toBe(items[1]);
  items[1].focus(); menu.fire("keydown", { key: "End" });
  expect(page.doc.activeElement).toBe(items.at(-1));
  items.at(-1).focus(); menu.fire("keydown", { key: "Home" });
  expect(page.doc.activeElement).toBe(items[0]);
  items[0].focus(); menu.fire("keydown", { key: "ArrowUp" });
  expect(page.doc.activeElement).toBe(items.at(-1));
  items[0].focus(); menu.fire("keydown", { key: "Tab" });
  expect(more.attrs["aria-expanded"]).toBe("false");
  more.fire("keydown", { key: "Escape" });
  expect(more.attrs["aria-expanded"]).toBe("false");
  more.fire("keydown", { key: "ArrowDown" });
  const notes = menu.all().find(e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Notes");
  notes.click();
  rig.step(2);
  const rebuiltMore = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
  expect(rebuiltMore).not.toBe(more);
  expect(page.doc.activeElement).toBe(rebuiltMore);
  expect(more.attrs["aria-expanded"]).toBe("false");
  expect(rig.app.ui.drawer).toBe("notes");
});

test("More menu carries focus across resize-driven topbar rebuilds after keyboard activation", () => {
  rig = setup({ collab: true });
  let more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
  more.focus();
  more.fire("keydown", { key: "Enter" });
  more.click(); // native button Enter activation
  const comments = find(page.byId.topbar, e => e.attrs.role === "menuitem" && e.attrs["aria-label"] === "Comments");
  comments.focus(); comments.click();
  expect(rig.app.ui.drawer).toBe("comments");
  rig.step(1); // rebuild after drawer activation, before the observer's second dirty pass
  stub.resizeCallbacks[0]([]);
  rig.step(2);
  more = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "More");
  expect(page.doc.activeElement).toBe(more);
});

test("topbar rebuild does not steal focus from the canvas", () => {
  rig = setup({ collab: true });
  page.board.focus();
  rig.app.ui.drawer = "comments";
  rig.step(2);
  expect(page.doc.activeElement).toBe(page.board);
});

test("all collaboration emoji toolbar buttons have descriptive accessible labels", () => {
  rig = setup({ collab: true });
  const toolbarButtons = page.doc.body.all().filter(e => e.tagName === "BUTTON" && e.classList.contains("tb"));
  expect(toolbarButtons.every(e => e.attrs["aria-label"])).toBe(true);
  const emojiButtons = page.byId.hudBC.all().concat(page.byId.hudBR.all()).filter(e => e.tagName === "BUTTON" && e.classList.contains("tb"));
  expect(emojiButtons.map(e => e.attrs["aria-label"])).toEqual([
    "React with thumbs up", "React with heart", "React with laughing", "React with party popper",
    "React with clapping hands", "React with surprised face", "More emotes", "Emotes",
  ]);
  const picker = find(page.doc.body, e => e.classList.contains("collab-picker"));
  expect(picker.children.map(e => e.attrs["aria-label"])).toEqual([
    "React with thumbs up", "React with heart", "React with laughing", "React with party popper",
    "React with clapping hands", "React with surprised face", "React with folded hands", "React with fire",
  ]);
  const mermaid = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs?.title === "Insert a Mermaid flowchart");
  expect(mermaid.attrs["aria-label"]).toBe("Insert Mermaid flowchart");
});

test("header Notes closes an already open drawer", () => {
  rig = setup();
  let notes = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Notes");
  rig.app.ui.drawer = "comments";
  rig.step(2);
  notes = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Notes");
  notes.click();
  rig.step(2);
  expect(rig.app.ui.drawer).toBeNull();
  notes = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Notes");
  notes.click(); rig.step(2);
  expect(rig.app.ui.drawer).toBe("notes");
  notes = find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Notes");
  notes.click(); rig.step(2);
  expect(rig.app.ui.drawer).toBeNull();
});

test("six-digit viewer count remains available in the mounted header", () => {
  rig = setup({ collab: true });
  rig.net.broadcast({ t: "here", writerCount: 0, viewers: 100000 });
  while (rig.net.step());
  const watching = find(page.byId.topbar, e => e.classList.contains("watching"));
  expect(watching.textContent).toBe("👁 100,000 viewers");
  expect(page.byId.topbar.all().filter(e => e.classList.contains("av")).length).toBeGreaterThanOrEqual(2);
});

test("1280px header keeps its board name rule with a six-digit viewer count and three writers", () => {
  rig = setup({ collab: true });
  const cy = createSession({ join: () => rig.net.join(), token: "t-cy", board: "b1", client: "cy", user: "cy", clock: rig.net.clock });
  cy.setSize(1200, 800);
  rig.step(4);
  rig.net.broadcast({ t: "here", writerCount: 3, viewers: 999999 });
  while (rig.net.step());
  rig.step(2);
  const watching = find(page.byId.topbar, e => e.classList.contains("watching"));
  expect(watching.textContent).toBe("👁 999,999 viewers");
  expect(page.byId.topbar.all().filter(e => e.classList.contains("av")).length).toBeGreaterThanOrEqual(3);
});

test("phone dock uses visible Comments text in its accessible name", () => {
  rig = setup({ collab: true });
  const comments = find(page.byId.dock, e => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Comments");
  expect(comments.textContent).toBe("Comments");
  expect(comments.attrs.title).toBe("Comments");
  expect(page.byId.dock.all().filter(e => e.tagName === "BUTTON").every(e => e.attrs["aria-label"] && e.attrs.title === e.attrs["aria-label"])).toBe(true);
});

test("local drawing on an empty board does not move the view", () => {
  rig = setup();
  const { S, step } = rig;
  const before = { ...S.eds.board.view };
  S.setTool("freedraw");
  S.pointerDown({ x: 40, y: 40 });
  S.pointerMove({ x: 80, y: 60 });
  step(4);
  expect(S.eds.board.view).toEqual(before);
  S.pointerUp({ x: 90, y: 70 });
  step(4);
  expect(S.eds.board.view).toEqual(before);
  expect(S.eds.board.doc.live().length).toBeGreaterThan(0);
});

test("C-2: a local change that only bumps the Editor (undo, a panel style chip) still refreshes the part that shows it", () => {
  rig = setup();
  const { S, step } = rig;
  drawRect(S, 200, 200); step(20);
  const el = S.eds.board.selected()[0];
  expect(el).toBeTruthy();
  const chip = () => find(page.byId.panel, e => e.attrs?.title === 'strokeWidth 4');
  expect(chip().className).not.toContain("on");
  chip().click(); step(20);                                    // panel chips call S.act without marking the chrome
  expect(S.eds.board.doc.get(el.id).strokeWidth).toBe(4);
  expect(chip().className).toContain("on");
  const undo = find(page.byId.topbar, e => e.attrs?.title === "Undo (⌘Z)");
  undo.click(); step(20);
  expect(S.eds.board.doc.get(el.id).strokeWidth).not.toBe(4);
  expect(chip().className).not.toContain("on");
});

test("C-4: back online and back from a long hide reconnect (both jittered); a short hide, a refusal or the cap don't", () => {
  rig = setup();
  const { S, step, net, joins } = rig;
  expect(S.status).toBe("live");
  const n0 = joins.length;
  const reopens = () => joins.reduce((a, t) => a + (t.reopened ?? 0), 0);
  for (const t of joins) { const r = t.reopen; t.reopen = () => { t.reopened = (t.reopened ?? 0) + 1; r(); }; }
  fireWin("offline"); step();
  expect(S.online).toBe(false);
  const random = net.clock.random;
  net.clock.random = () => 0.75;                               // jitter: 0.75 × 2 s on the clock port
  fireWin("online");
  net.clock.random = random;
  expect(reopens()).toBe(0);                                   // not at once
  net.advance(1400); step();
  expect(reopens()).toBe(0);
  net.advance(200); step(5);
  expect(joins.length).toBe(1);                                // p8-one-link: one link per tab
  expect(reopens()).toBe(1);                                   // the one link, once
  expect(S.status).toBe("live");
  // Hidden 10 s: nothing. Hidden 31 s: reconnect.
  const hide = ms => { page.doc.visibilityState = "hidden"; page.doc.fire("visibilitychange"); net.advance(ms); page.doc.visibilityState = "visible"; page.doc.fire("visibilitychange"); net.advance(2001); step(5); };   // + the jitter
  hide(10_000); expect(reopens()).toBe(1);
  hide(31_000); expect(reopens()).toBe(2);
  expect(S.status).toBe("live");
  // Hidden 40 s, but the room spoke 6 s before it came back (a busy board's presence): the link is alive, no hello.
  page.doc.visibilityState = "hidden"; page.doc.fire("visibilitychange");
  net.advance(34_000); net.broadcast({ t: "here", writerCount: 1, viewers: 0 }); while (net.step());
  net.advance(6_000); page.doc.visibilityState = "visible"; page.doc.fire("visibilitychange"); net.advance(2001); step(5);
  expect(reopens()).toBe(2);
  // The same, heard 11 s before: silent long enough, reconnect.
  page.doc.visibilityState = "hidden"; page.doc.fire("visibilitychange");
  net.advance(29_000); net.broadcast({ t: "here", writerCount: 1, viewers: 0 }); while (net.step());
  net.advance(11_000); page.doc.visibilityState = "visible"; page.doc.fire("visibilitychange"); net.advance(2001); step(5);
  expect(reopens()).toBe(3);
  expect(joins.length).toBe(n0);
  // Never while refused, stopped or capped, nor under a gesture.
  for (const status of ["refused", "stopped", "limited"]) expect(shouldProbe({ status })).toBe(false);
  expect(shouldProbe({ status: "live", gesture: "board" })).toBe(false);
  expect(shouldProbe({ status: "connecting" })).toBe(true);
});

test("a refused hello shows no sign-in banner while the Trash notice stands (the board is in Trash), and does again if it goes", () => {
  let inTrash = true;
  rig = setup({ relogin: { href: "/auth/login", go() {} }, trashShown: () => inTrash });
  const { S, step } = rig;
  for (const t of rig.joins) { const send = t.send; t.send = m => send(m.t === "hello" ? { ...m, token: "dead" } : m); }
  S.reconnect(); step(10);
  expect(S.status).toBe("refused");
  expect(text(page.byId.overlays)).not.toMatch(/refused this sign-in|Sign in again/);
  inTrash = false; rig.hooks.onChange(); step(2);
  expect(text(page.byId.overlays)).toMatch(/The room refused this sign-in/);
});
test("C-9: a refused sign-in links to sign-in (remembering the board); expiry warns before exp, on the clock port", () => {
  let went = 0;
  const store = memoryStore();
  const relogin = { href: "/auth/login", go: () => { went++; rememberBoard(store, "b1"); } };
  rig = setup({ relogin, expAt: null });
  const { S, step, net } = rig;
  // The room refuses the next hello (the token died): Retry alone can't help, so the banner links to sign-in.
  for (const t of rig.joins) { const send = t.send; t.send = m => send(m.t === "hello" ? { ...m, token: "dead" } : m); }
  S.reconnect(); step(10);
  expect(S.status).toBe("refused");
  const link = find(page.byId.overlays, e => e.tagName === "A");
  expect(link.attrs.href).toBe("/auth/login");
  expect(text(page.byId.overlays)).toMatch(/Sign in again/);
  expect(find(page.byId.overlays, e => e.tagName === "BUTTON" && /Retry/.test(e.textContent))).toBeTruthy();
  const ev = link.fire("click");
  expect(ev.defaultPrevented).toBe(true);
  expect(went).toBe(1);
  expect(store.get(RETURN_KEY)).toBe("b1");
  // A modified click (new tab) is left to the browser.
  expect(link.fire("click", { metaKey: true }).defaultPrevented).toBeFalsy();
  expect(went).toBe(1);
  void net;
});

test("C-9: the expiry banner appears EXPIRY_WARN_MS before exp, counts down, then says it ended", () => {
  const relogin = { href: "/auth/login", go() {} };
  installPage();
  const net0 = localRoom({ users: USERS, clock: true });
  const expAt = net0.clock.now() + EXPIRY_WARN_MS + 60_000;
  rig = setup({ relogin, expAt });                 // its own room; same t0 (0), so expAt is 6 min ahead
  const { step, net } = rig;
  expect(text(page.byId.overlays)).toBe("");
  net.advance(61_000); step(70);
  expect(text(page.byId.overlays)).toMatch(/Your sign-in ends in 5 min/);
  expect(find(page.byId.overlays, e => e.tagName === "A")?.attrs.href).toBe("/auth/login");
  net.advance(4 * 60_000 + 30_000); step(70);
  expect(text(page.byId.overlays)).toMatch(/ends in 1 min/);
  net.advance(60_000); step(70);
  expect(text(page.byId.overlays)).toMatch(/Your sign-in has ended/);
  // Pure: the bucket changes only with the text; no exp, no notice.
  expect(expiryNotice({ expAt: null, now: 5 })).toBe(null);
  expect(expiryNotice({ expAt: 10 * 60_000, now: 0 })).toBe(null);
  expect(expiryNotice({ expAt: 90_000, now: 0 }).bucket).toBe(expiryNotice({ expAt: 90_000, now: 29_000 }).bucket);   // 2 min, rounded up
  expect(expiryNotice({ expAt: 90_000, now: 31_000 }).bucket).toBe("m1");
});

test("C-9: the return board is taken once, only after a fresh sign-in on a page without a board", () => {
  const s = memoryStore();
  rememberBoard(s, "b1");
  expect(takeReturnBoard(s, { outcome: "restored", board: null })).toBe(null);
  expect(s.get(RETURN_KEY)).toBe(null);                        // consumed anyway: a stale stash never lingers
  rememberBoard(s, "b1");
  expect(takeReturnBoard(s, { outcome: "signed-in", board: "other" })).toBe(null);
  rememberBoard(s, "b1");
  expect(takeReturnBoard(s, { outcome: "signed-in", board: null })).toBe("b1");
  expect(takeReturnBoard(s, { outcome: "signed-in", board: null })).toBe(null);
  s.set(RETURN_KEY, "../evil?x=1");
  expect(takeReturnBoard(s, { outcome: "signed-in", board: null })).toBe(null);
  rememberBoard(s, "bad board"); expect(s.get(RETURN_KEY)).toBe(null);
  const gone = memoryStore({ unavailable: true });
  expect(() => rememberBoard(gone, "b1")).not.toThrow();
  expect(takeReturnBoard(gone, { outcome: "signed-in", board: null })).toBe(null);
  // The refused banner offers sign-in only when the page has one.
  expect(connectionBanner({ status: "refused", relogin: true }).relogin).toBe(true);
  expect(connectionBanner({ status: "refused" }).relogin).toBe(false);
  expect(connectionBanner({ status: "refused", relogin: true, pending: 2 }).text).toMatch(/2 unsent edits/);
});

test("C-17: the cap's countdown reads the clock port, not Date.now", () => {
  rig = setup();
  const { S, step, net } = rig;
  // Fake the cap on the session: nextTryAt on the clock's now() scale (virtual: near 0, far from Date.now()).
  const at = net.clock.now() + 12_000;
  // p8-tidy L2: the session reads the link (S.connection) alone, so the cap is faked there.
  Object.defineProperty(S.connection, "nextTryAt", { get: () => at, configurable: true });
  Object.defineProperty(S.connection, "limited", { get: () => "8 writer connections", configurable: true });
  Object.defineProperty(S.connection, "status", { get: () => "limited", configurable: true });
  step(20);
  expect(text(page.byId.overlays)).toMatch(/Trying again in 12 s/);
  net.advance(5000); step(20);
  expect(text(page.byId.overlays)).toMatch(/Trying again in 7 s/);
});

test("C-6: the collab UI mounts with the root's clock port (and a frame scheduler) and runs on the virtual clock", () => {
  rig = setup({ collab: true });
  const { app, step, net } = rig;
  expect(app.collab).toBeTruthy();
  // The page's toast and the collab UI's timers are on the virtual clock: nothing here waits on real time.
  step(10); net.advance(60_000); step(10);
  expect(app.S.status).toBe("live");
});

test("jumpTo (the collab port's): centres a world point, at an optional scale clamped to the zoom limits", () => {
  rig = setup({ collab: true });
  const { S, hooks, step } = rig;
  const B = S.eds.board, centre = () => B.toWorld({ x: B.size.w / 2, y: B.size.h / 2 });
  const s0 = B.view.scale;
  hooks.jumpTo({ x: 400, y: 250 }); step(16);
  expect(B.view.scale).toBe(s0);
  expect(centre()).toEqual({ x: 400, y: 250 });
  hooks.jumpTo({ x: -100, y: 30, scale: 2.5 }); step(16);
  expect(B.view.scale).toBe(2.5);
  expect(centre().x).toBeCloseTo(-100); expect(centre().y).toBeCloseTo(30);
  expect(S.eds.notes.view).toEqual(B.view);                   // both Editors share the view (including final animation frame)
  hooks.jumpTo({ x: 0, y: 0, scale: 50 }); step(16); expect(B.view.scale).toBe(8);
  hooks.jumpTo({ x: 0, y: 0, scale: 0.001 }); step(16); expect(B.view.scale).toBe(0.1);
  expect(centre().x).toBeCloseTo(0);
  hooks.jumpTo({ x: 0, y: 0, scale: NaN }); step(16); expect(B.view.scale).toBe(0.1);
  expect(text(find(page.byId.hudBL, e => e.className === "pct" && /%$/.test(e.textContent)))).toBe("10%");
});

test("playback: the timeline head, fill and time move every frame in place, with no timeline rebuild", () => {
  rig = setup();
  const { S, step, app } = rig;
  drawRect(S, 200, 200); step(2);
  S.act("board", e => e.animate("fade")); step(20);
  const r0 = app.ui.rebuilds.timeline;
  page.doc.fire("keydown", { key: " ", code: "Space", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }); step(1);   // ⇧Space: play (one rebuild: ▶ → ❚❚)
  expect(S.eds.board.play).toBeTruthy();
  const r1 = app.ui.rebuilds.timeline;
  expect(r1 - r0).toBe(1);
  const head = () => find(page.byId.timeline, e => e.className === "head");
  const h0 = head(), seen = [];
  for (let i = 0; i < 10; i++) { step(); seen.push(h0.style.left); }
  expect(head()).toBe(h0);                                      // the same node
  expect(app.ui.rebuilds.timeline).toBe(r1);
  expect(new Set(seen).size).toBe(10);                          // it moved on every frame
  expect(find(page.byId.timeline, e => e.className === "t").textContent).toMatch(/^\d{2}:\d{2}\.\d \/ \d{2}:\d{2}\.\d$/);
});

// ── verifier (p7-chromev) cases ──
const panelText = () => text(page.byId.panel);
function drawFrame(s, x, y) { s.setTool("frame"); s.pointerDown({ x, y }); s.pointerMove({ x: x + 200, y: y + 150 }); s.pointerUp({ x: x + 200, y: y + 150 }); s.setTool("select"); }

test("V1 remote note deleted: topbar count and drawer drop", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.ui.drawer = "notes"; app.setPanel({ type: "noop" }); step(20);
  bo.placeNote({ x: 300, y: 300 }, "n1"); bo.placeNote({ x: 400, y: 300 }, "n2"); step(20);
  const btn = () => find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs.title === "Notes");
  expect(text(btn())).toBe("Notes 2");
  const id = bo.eds.notes.doc.live().find(e => e.type === "text" ? e.text === "n1" : bo.eds.notes.doc.labelOf(e)?.text === "n1")?.id ?? bo.eds.notes.doc.live()[0].id;
  bo.act("notes", n => n.deleteIds([id])); step(20);
  expect(text(btn())).toBe("Notes 1");
});

test("V2 remote note text edit updates the drawer row", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.ui.drawer = "notes"; app.setPanel({ type: "noop" }); step(20);
  bo.placeNote({ x: 300, y: 300 }, "before"); step(20);
  expect(text(page.byId.drawer)).toContain("before");
  const N = bo.eds.notes, e = N.doc.live().find(x => x.type === "text") ?? N.doc.live()[0];
  bo.act("notes", n => { n.select([e.id]); n.beginText(e, { x: e.x, y: e.y }); n.setText("after"); n.commitText(); }); step(20);
  expect(text(page.byId.drawer)).toContain("after");
});

test("V3 remote frame: hud count and panel frames list", () => {
  rig = setup(); const { bo, step } = rig;
  const hudPct = () => find(page.byId.hudBL, e => e.className === "pct" && / \/ /.test(e.textContent)).textContent;
  expect(hudPct()).toBe("0 / 0");
  drawFrame(bo, 100, 100); step(20);
  expect(hudPct()).toMatch(/ \/ 1$/);
  drawFrame(bo, 600, 100); step(20);
  expect(hudPct()).toMatch(/ \/ 2$/);
  expect(panelText()).toMatch(/Frame 2/);
});

test("V3b hud ‹ › click (no chromeDirty) updates the frame index", () => {
  rig = setup(); const { S, step } = rig;
  drawFrame(S, 100, 100); drawFrame(S, 600, 100); step(20);
  const next = find(page.byId.hudBL, e => e.attrs?.title === "Next frame (PgDn)");
  next.click(); step(20);
  const pct = () => find(page.byId.hudBL, e => e.className === "pct" && / \/ /.test(e.textContent)).textContent;
  const a = pct();
  find(page.byId.hudBL, e => e.attrs?.title === "Next frame (PgDn)").click(); step(20);
  expect(pct()).not.toBe(a);
  expect(pct()).toMatch(/^[12] \/ 2$/);
});

test("V4 remote change to the selected element's props flips the panel chip", () => {
  rig = setup(); const { S, bo, step } = rig;
  drawRect(bo, 100, 100); step(20);
  const id = bo.eds.board.doc.live()[0].id;
  S.act("board", e => e.select([id])); step(20);
  const chip = () => find(page.byId.panel, e => e.attrs?.title === "strokeWidth 4");
  expect(chip().className).not.toContain("on");
  bo.act("board", e => { e.select([id]); e.setStyle({ strokeWidth: 4 }); }); step(20);
  expect(S.eds.board.doc.get(id).strokeWidth).toBe(4);
  expect(chip().className).toContain("on");
});

test("V5 style chip with nothing selected (Editor.style only) shows", () => {
  rig = setup(); const { S, step } = rig;
  S.act("board", e => e.select([])); step(20);
  const chip = () => find(page.byId.panel, e => e.attrs?.title === "strokeWidth 4");
  chip().click(); step(20);
  expect(chip().className).toContain("on");
});

test("focus survives a chrome rebuild: a panel chip keeps focus after it is activated and the panel is redrawn", () => {
  rig = setup(); const { S, step } = rig;
  S.act("board", e => e.select([])); step(20);
  const chip = () => find(page.byId.panel, e => e.attrs?.title === "strokeWidth 4");
  const before = chip(); before.focus(); before.click(); step(20);
  expect(chip()).not.toBe(before);                                       // the panel was rebuilt
  expect(page.doc.activeElement).toBe(chip());                           // and focus is on the new chip, not lost
});

test("focus follows the control's own key, not its label: pressing Lock on any of three layers keeps focus on THAT layer's Lock", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.setPanel({ type: "noop" }); step(20);
  bo.act("board", e => e.addLayer("Two"), { settings: true }); bo.act("board", e => e.addLayer("Three"), { settings: true }); step(20);
  const lockBtns = () => page.byId.panel.all().filter(e => e.tagName === "BUTTON" && /^layer:.+:lock$/.test(e.attrs["data-fk"] ?? ""));
  expect(lockBtns().length).toBe(3);
  for (const which of [lockBtns().length - 1, 0, 1]) {
    const target = lockBtns()[which], key = target.attrs["data-fk"], title = target.attrs.title;
    target.focus(); target.click(); step(20);
    const now = lockBtns().find(e => e.attrs["data-fk"] === key);
    expect(now.attrs.title).not.toBe(title);                                // the layer's state flipped (Lock <-> Unlock) and its title changed ...
    expect(page.doc.activeElement).toBe(now);                               // ... and focus is on that same layer's toggle, not another layer's "Lock"
  }
});

test("dialog chips: activating a format chip rebuilds the dialog and focus stays on that same chip", () => {
  rig = setup(); const { step, app } = rig;
  app.ui.dialog = "export"; app.setPanel({ type: "noop" }); step(20);
  const chip = text => find(page.byId.dialogs, e => e.tagName === "BUTTON" && e.textContent === text);
  const before = chip("2×"); before.focus(); before.click(); step(20);
  const now = chip("2×");
  expect(now).not.toBe(before);                                          // rebuilt
  expect(now.className).toContain("on");
  expect(page.doc.activeElement).toBe(now);                              // focus on the same chip, not the body and not another chip
});

test("a layer removed from outside never hands focus to another layer's Lock: focus goes to a neutral layer row", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.setPanel({ type: "noop" }); step(20);
  bo.act("board", e => e.addLayer("Two"), { settings: true }); bo.act("board", e => e.addLayer("Three"), { settings: true }); step(20);
  const locks = () => page.byId.panel.all().filter(e => e.tagName === "BUTTON" && /^layer:.+:lock$/.test(e.attrs["data-fk"] ?? ""));
  const mid = locks()[1], midId = mid.attrs["data-fk"].split(":")[1];
  mid.focus();
  bo.act("board", e => e.deleteLayer(midId), { settings: true }); step(20);
  expect(locks().length).toBe(2);
  const now = page.doc.activeElement;
  expect(now.attrs["data-fk"]).toMatch(/^layer:[^:]+:row$/);              // a neutral row, not a Lock/Hide toggle
});

test("notes drawer: notes added from the compose box show in the list while the compose box keeps its focus and its text", () => {
  rig = setup(); const { step, app } = rig;
  app.ui.drawer = "notes"; app.setPanel({ type: "noop" }); step(20);
  const compose = () => find(page.byId.drawer, e => e.tagName === "TEXTAREA");
  const rows = () => page.byId.drawer.all().filter(e => e.className?.startsWith?.("note-row"));
  expect(rows().length).toBe(0);
  expect(page.byId.drawer.textContent).toContain("No notes yet.");
  const ta = compose(); ta.focus();
  for (const text of ["first note", "second note"]) {
    ta.value = text; ta.fire("keydown", { key: "Enter" }); step(20);
    expect(compose()).toBe(ta);                                         // the compose box itself was never rebuilt
    expect(page.doc.activeElement).toBe(ta);
  }
  expect(rows().length).toBe(2);                                          // the list shows both notes
  expect(page.byId.drawer.textContent).not.toContain("No notes yet.");
  ta.value = "half-typed"; step(20);
  expect(ta.value).toBe("half-typed");
});

test("layers: the list is role=list, each row a listitem named \"Layer: <name>\"; a layer removed under focus is announced", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.setPanel({ type: "noop" }); step(20);
  bo.act("board", e => e.addLayer("Two"), { settings: true }); bo.act("board", e => e.addLayer("Three"), { settings: true }); step(20);
  const list = find(page.byId.panel, e => e.attrs?.role === "list");
  expect(list.attrs["aria-label"]).toBe("Layers");
  const items = page.byId.panel.all().filter(e => e.attrs?.role === "listitem");
  expect(items.map(e => e.attrs["aria-label"]).sort()).toEqual(["Layer: Layer 1", "Layer: Three", "Layer: Two"].sort());
  expect(items.every(e => list.all().includes(e))).toBe(true);
  const locks = () => page.byId.panel.all().filter(e => e.tagName === "BUTTON" && /^layer:.+:lock$/.test(e.attrs["data-fk"] ?? ""));
  const mid = locks()[1], midId = mid.attrs["data-fk"].split(":")[1];
  mid.focus();
  bo.act("board", e => e.deleteLayer(midId), { settings: true }); step(20);
  expect(announced()).toMatch(/^That layer is no longer here; moved to the (next|previous) one\.$/);
});

test("notes drawer: rows are listitems named \"Note: <text>, by <author>\" inside a role=list", () => {
  rig = setup(); const { step, app } = rig;
  app.ui.drawer = "notes"; app.setPanel({ type: "noop" }); step(20);
  const ta = find(page.byId.drawer, e => e.tagName === "TEXTAREA"); ta.focus();
  ta.value = "alpha note"; ta.fire("keydown", { key: "Enter" }); step(20);
  const list = find(page.byId.drawer, e => e.attrs?.role === "list");
  expect(list.attrs["aria-label"]).toBe("Notes");
  const rows = page.byId.drawer.all().filter(e => e.attrs?.role === "listitem");
  expect(rows.map(e => e.attrs["aria-label"])).toEqual(["Note: alpha note, by you"]);
  expect(list.all().includes(rows[0])).toBe(true);
});

test("V6 remote layer add / rename and a shape on it: panel layers", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.setPanel({ type: "noop" }); step(20);
  bo.act("board", e => e.addLayer("Zeta"), { settings: true }); step(20);
  expect(panelText()).toContain("Zeta");
  const lid = bo.eds.board.doc.layers.find(l => l.name === "Zeta").id;
  bo.act("board", e => e.updateLayer(lid, { name: "Omega" }), { settings: true }); step(20);
  expect(panelText()).toContain("Omega");
  bo.eds.board.activeLayer = lid; drawRect(bo, 50, 50); step(20);
  const row = find(page.byId.panel, e => e.className?.startsWith?.("list-row") && e.textContent.includes("Omega"));
  expect(find(row, e => e.className === "n").textContent).toBe("1");
});

test("V7 undo of a style chip via ⌘Z key", () => {
  rig = setup(); const { S, step } = rig;
  drawRect(S, 200, 200); step(20);
  const chip = () => find(page.byId.panel, e => e.attrs?.title === "strokeWidth 4");
  chip().click(); step(20); expect(chip().className).toContain("on");
  page.doc.fire("keydown", { key: "z", code: "KeyZ", metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }); step(20);
  expect(chip().className).not.toContain("on");
});

test("V8 return board: hostile stored values never come back", () => {
  for (const v of ["javascript:alert(1)", "//evil.example", "https://evil.example", "b1?x=<script>", "b1#t", "b1/../x", "%2Fevil", "b1\n", "a".repeat(65), " b1", ""]) {
    const s = memoryStore(); s.set(RETURN_KEY, v);
    expect(takeReturnBoard(s, { outcome: "signed-in", board: null })).toBe(null);
    expect(s.get(RETURN_KEY)).toBe(null);
  }
});

test("V9 jumpTo: 0, negative, Infinity, string keep the scale; view stays finite", () => {
  rig = setup({ collab: true }); const { S, hooks, step } = rig;
  const B = S.eds.board; const s0 = B.view.scale;
  for (const scale of [0, -2, Infinity, -Infinity, "3", null, undefined]) { hooks.jumpTo({ x: 10, y: 20, scale }); step(); expect(B.view.scale).toBe(s0); }
  for (const k of ["x", "y", "scale"]) expect(Number.isFinite(B.view[k])).toBe(true);
});

test("V10 playback stops by itself: the timeline button returns to ▶", () => {
  rig = setup(); const { S, step, net } = rig;
  drawRect(S, 200, 200); step(2);
  S.act("board", e => e.animate("fade")); step(20);
  page.doc.fire("keydown", { key: " ", code: "Space", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }); step(1);
  expect(S.eds.board.play).toBeTruthy();
  for (let i = 0; i < 400 && S.eds.board.play; i++) step();
  expect(S.eds.board.play).toBeFalsy();
  step(20);
  const playBtn = find(page.byId.timeline, e => e.tagName === "BUTTON" && e.attrs?.title?.startsWith("Play"));
  expect(playBtn.attrs["data-state"]).toBe("paused");
  expect(find(playBtn, e => e.tagName === "SVG")?.attrs["data-icon"]).toBe("play");
});

// ── killers for the surviving mutants ──
const reopenCounter = joins => { for (const t of joins) { const r = t.reopen; t.reopen = () => { t.reopened = (t.reopened ?? 0) + 1; r(); }; } return () => joins.reduce((a, t) => a + (t.reopened ?? 0), 0); };

test("K1 the page's own probe honours shouldProbe: no reconnect while refused, capped or mid-gesture", () => {
  // refused
  rig = setup({ relogin: { href: "/auth/login", go() {} } });
  let { S, step, net, joins } = rig;
  for (const t of joins) { const send = t.send; t.send = m => send(m.t === "hello" ? { ...m, token: "dead" } : m); }
  S.reconnect(); step(10); expect(S.status).toBe("refused");
  let reopens = reopenCounter(joins);
  fireWin("online"); net.advance(2001); step(5);
  page.doc.visibilityState = "hidden"; page.doc.fire("visibilitychange"); net.advance(40_000);
  page.doc.visibilityState = "visible"; page.doc.fire("visibilitychange"); net.advance(2001); step(5);
  expect(reopens()).toBe(0);
  // mid-gesture (a drag in progress when the jitter ends)
  rig = setup(); ({ S, step, net, joins } = rig);
  reopens = reopenCounter(joins);
  S.setTool("rectangle"); S.pointerDown({ x: 10, y: 10 }); S.pointerMove({ x: 50, y: 50 });
  expect(S.gesture).toBeTruthy();
  fireWin("online"); net.advance(2001); while (net.step());
  expect(reopens()).toBe(0);
  S.pointerUp({ x: 50, y: 50 });
  // capped
  rig = setup(); ({ S, step, net, joins } = rig);
  reopens = reopenCounter(joins);
  Object.defineProperty(S.connection, "status", { get: () => "limited", configurable: true });   // p8-tidy L2: the link's
  fireWin("online"); net.advance(2001); step(5);
  expect(reopens()).toBe(0);
});

test("K2 app.js: no setTimeout/setInterval/performance.now/Date.now in the source; a page with the collab UI runs a minute without them", async () => {
  const src = await Bun.file(new URL("../../web/adapters/dom/app.js", import.meta.url)).text();
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(code.match(/\b(setTimeout|setInterval|clearTimeout|clearInterval|performance\.now|Date\.now)\b/g)).toBe(null);
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, now: performance.now, dnow: Date.now };
  let calls = [];
  globalThis.setTimeout = (...a) => { calls.push("setTimeout " + new Error().stack.split("\n")[2]); return real.setTimeout(...a); };
  globalThis.setInterval = (...a) => { calls.push("setInterval"); return real.setInterval(...a); };
  try {
    rig = setup({ collab: true });
    const { S, step, net, app } = rig;
    page.board.fire("pointerdown", { clientX: 10, clientY: 10, pointerId: 1 }); page.board.fire("pointerup", { clientX: 10, clientY: 10, pointerId: 1 });
    S.stepFrame(1); step(10);                                    // a flash: the toast
    app.collab && step(10); net.advance(60_000); step(10);
    expect(calls).toEqual([]);
  } finally { globalThis.setTimeout = real.setTimeout; globalThis.setInterval = real.setInterval; }
});

test("K3 main.js: the token goes only into createSession and the HTTP ports; sign-in leaves for the fixed href; the return board only via takeReturnBoard", async () => {
  const src = await Bun.file(new URL("../../web/main.js", import.meta.url)).text();
  const code = src.replace(/\/\/.*$/gm, "");
  expect(code.match(/signIn\.token/g).length).toBe(17);                         // the gate check, createSession's token, and the Home, Admin/Org, Spaces, Access and Roles ports' (their Bearer header), plus the Move port's, and the Trash port's (the Trash page, the Space page's Move to Trash, the board-URL notice), the Access port of the Space page (Ask for access) and of the canvas pill (why view-only), plus the Share port of the canvas (Share dialog), and the Move port's on Home cards and on the canvas (#91)
  expect(code).toMatch(/httpHome\(\{[^}]*token: signIn\.token,/);
  expect(code).toMatch(/if \(!signIn\.token\)/);
  expect(code).toMatch(/createSession\(\{[^}]*token: signIn\.token,/);
  expect(code.match(/location\.assign\(([^)]*)\)/g)).toEqual(["location.assign(href)", "location.assign(signInLink.href)"]);   // the first: after a create, to our own relative ?board= / ?space= link (hrefTo)
  expect(code).not.toMatch(/console\.|localStorage|sessionStorage|tabStore\.(set|get)/);
  expect(code).not.toMatch(/RETURN_KEY|plenary\.return/);                       // read only through takeReturnBoard
  expect(code).toMatch(/const back = takeReturnBoard\(tabStore, \{ outcome: signIn\.outcome, board: asked \}\);/);
});

test("K4 panel: a remote frame rename shows in the frames list; a remote preset change on my selection flips the chip", () => {
  rig = setup(); const { S, bo, step, app } = rig;
  drawFrame(bo, 100, 100); step(20);
  const fid = bo.eds.board.frames()[0].id;
  expect(panelText()).toMatch(/Frame 1/);
  bo.act("board", e => e.transact(tx => { tx.get(fid).name = "Agenda"; })); step(20);
  expect(S.eds.board.frames()[0].name).toBe("Agenda");
  expect(panelText()).toMatch(/Agenda/);
  drawRect(bo, 600, 600); step(20);
  const id = bo.eds.board.doc.live().find(e => e.type === "rectangle").id;
  bo.act("board", e => { e.select([id]); e.animate("fade"); }); step(20);
  S.act("board", e => e.select([id])); step(20);
  const on = p => find(page.byId.panel, e => e.tagName === "BUTTON" && e.textContent === p)?.className ?? "";
  expect(on("fade")).toContain("on");
  const other = ["zoom", "slide", "pop", "rise", "wipe"].find(p => find(page.byId.panel, e => e.tagName === "BUTTON" && e.textContent === p));
  bo.act("board", e => { e.select([id]); e.animate(other); }); step(20);
  expect(on(other)).toContain("on");
  expect(on("fade")).not.toContain("on");
});

test("K5 timeline: a remote change that moves a mark but not the duration redraws the marks", () => {
  rig = setup(); const { S, bo, step } = rig;
  drawRect(bo, 100, 100); drawRect(bo, 300, 100); step(20);
  const [a, b] = bo.eds.board.doc.live().filter(e => e.type === "rectangle").map(e => e.id);
  bo.act("board", e => { e.select([a, b]); e.animate("fade"); }); step(20);
  const marks = () => page.byId.timeline.all().filter(e => e.className === "mark").length;
  const dur0 = S.eds.board.duration(), m0 = marks();
  bo.act("board", e => { e.select([a]); e.clearAnimation(); }); step(20);
  expect(S.eds.board.duration()).toBe(dur0);                 // the case: a mark gone, the duration the same
  expect(marks()).toBe(m0 - 1);
});

test("K6 a mid-session role downgrade (new welcome) on a quiet page: topbar tools and panel follow, with no input", () => {
  const prev = USERS["t-ada"].role;
  try {
    rig = setup(); const { S, step, net } = rig;
    expect(S.effective).toBe("presenter");
    const rect = () => find(page.byId.topbar, e => e.attrs?.["data-tool"] === "rectangle");
    expect(rect().disabled).toBe(false);
    USERS["t-ada"].role = "viewer";
    S.reconnect(); step(30); net.advance(1000); step(30);
    expect(S.effective).toBe("viewer");
    expect(S.readOnly).toBe(true);
    expect(rect().disabled).toBe(true);
    expect(page.byId.panel.className).toContain("ro");
  } finally { USERS["t-ada"].role = prev; }
});

// ── p8-tidy ──
const reopenCount = joins => { for (const t of joins) { const r = t.reopen; t.reopen = () => { t.reopened = (t.reopened ?? 0) + 1; r(); }; } return () => joins.reduce((a, t) => a + (t.reopened ?? 0), 0); };
/** Fire `online` with the clock's random pinned to `r`; returns the page's reopen counter. */
function onlineAt(rig, r) {
  const { net, step, joins } = rig, reopens = reopenCount(joins);
  fireWin("offline"); step();
  const random = net.clock.random; net.clock.random = () => r; fireWin("online"); net.clock.random = random;
  return reopens;
}

test("p8-tidy MEDIUM-1: the resume jitter follows the role: editors 0–2 s, annotators and viewers 0–15 s", () => {
  // An editor (ada, owner → presenter) at the top of the window: within 2 s.
  rig = setup();
  expect(rig.S.effective).toBe("presenter");
  let reopens = onlineAt(rig, 0.99);
  rig.net.advance(1970); rig.step();
  expect(reopens()).toBe(1);
  // A viewer and an annotator at the same draw: nothing by 2 s (nor by 14.8 s), then once by 15 s.
  for (const token of ["t-vi", "t-cy"]) {
    rig = setup({ token });
    expect(rig.S.effective).toBe(token === "t-vi" ? "viewer" : "annotator");
    reopens = onlineAt(rig, 0.99);
    rig.net.advance(2500); rig.step();
    expect(reopens()).toBe(0);
    rig.net.advance(12_300); rig.step();
    expect(reopens()).toBe(0);                                   // 14.8 s < 0.99 × 15 s
    rig.net.advance(200); rig.step(5);
    expect(reopens()).toBe(1);
    expect(rig.S.status).toBe("live");
  }
  // A long hide comes back on the same windows.
  rig = setup({ token: "t-vi" });
  reopens = reopenCount(rig.joins);
  const random = rig.net.clock.random; rig.net.clock.random = () => 0.5;
  page.doc.visibilityState = "hidden"; page.doc.fire("visibilitychange"); rig.net.advance(31_000);
  page.doc.visibilityState = "visible"; page.doc.fire("visibilitychange"); rig.net.clock.random = random;
  rig.net.advance(7000); rig.step(); expect(reopens()).toBe(0);
  rig.net.advance(600); rig.step(5); expect(reopens()).toBe(1);   // 0.5 × 15 s = 7.5 s
});

test("p8-tidy MEDIUM-1: the user's own click (the pill, Retry) reconnects at once and cancels the waiting probe", () => {
  rig = setup({ token: "t-vi" });
  const { S, net, step } = rig;
  const reopens = onlineAt(rig, 0.99);                          // a probe armed for 14.85 s
  // Not live (forced on the link, the one thing the session reads): the pill click reconnects now.
  const real = Object.getOwnPropertyDescriptor(S.connection, "status");
  let forced = "connecting";
  Object.defineProperty(S.connection, "status", { get: () => forced ?? real.get.call(S.connection), configurable: true });
  step(2);
  const pill = find(page.byId.topbar, e => /^pill\b/.test(e.className));
  expect(pill.className).not.toMatch(/live/);
  pill.click();
  expect(reopens()).toBe(1);
  forced = null; step(5);
  expect(S.status).toBe("live");
  net.advance(16_000); step(5);
  expect(reopens()).toBe(1);                                    // the probe was cancelled: no second hello
  // While live the pill does nothing.
  find(page.byId.topbar, e => /^pill\b/.test(e.className)).click();
  expect(reopens()).toBe(1);
});

test("p8-tidy MEDIUM-1: Retry (offline banner) also cancels the waiting probe; a role not known yet takes the wide window", () => {
  rig = setup({ token: "t-vi" });
  const { S, net, step } = rig;
  const reopens = onlineAt(rig, 0.99);                          // a probe armed for 14.85 s
  fireWin("offline"); step(3);                                  // offline again: the banner offers Retry now
  const retry = find(page.byId.overlays, e => e.tagName === "BUTTON" && /^Retry/.test(e.textContent));
  expect(retry).toBeTruthy();
  retry.click();
  expect(reopens()).toBe(1);
  for (let k = 0; k < 16; k++) { net.advance(1000); step(1); }   // deliveries in between (one 16 s jump would starve the hello)
  expect(reopens()).toBe(1);                                    // the probe armed by `online` was cancelled
  void S;
  // Unknown role (no welcome seen): the wide window even on an editor's page.
  rig = setup();
  const r2 = reopenCount(rig.joins);
  rig.S.roleSeen = null;
  fireWin("offline"); rig.step();
  const random = rig.net.clock.random; rig.net.clock.random = () => 0.5; fireWin("online"); rig.net.clock.random = random;
  rig.net.advance(2500); rig.step();
  expect(r2()).toBe(0);                                         // not 0.5 × 2 s
  rig.net.advance(5100); rig.step(5);
  expect(r2()).toBe(1);                                         // 0.5 × 15 s
});

test("p8-tidy L8: after a same-tab switch to another user, the old user's stored notes survive; the new user's go under their own key", () => {
  const prefs = memoryStore();
  rig = setup({ token: "t-cy", prefs });
  const { S, net, step, app } = rig;
  app.ui.drawer = "notes"; step(3);                               // the notes list reads isMine (it used to clear lazily)
  S.placeNote({ x: 100, y: 100 }, "cy's"); step(10);
  const id = S.eds.notes.doc.live().find(e => e.type === "rectangle").id;
  expect(JSON.parse(prefs.get("plenary.mine.b1.cy"))).toContain(id);
  prefs.set("plenary.mine.b1.di", JSON.stringify(["di-old"]));    // di's own notes from an earlier visit
  S.reconnect("t-di");
  let n = 0; while (S.connection.lastUser !== "di" && n++ < 500) net.step(() => 0);
  step(10);
  expect(S.connection.lastUser).toBe("di");
  expect(JSON.parse(prefs.get("plenary.mine.b1.cy"))).toContain(id);   // cy's set is not overwritten by the empty one
  expect(S.mine.has(id)).toBe(false);                                 // and cy's note isn't di's
  expect(S.mine.has("di-old")).toBe(true);                            // di's stored set is read under di's key
  S.placeNote({ x: 300, y: 100 }, "di's"); step(10);
  const id2 = S.eds.notes.doc.live().find(e => e.type === "rectangle" && e.id !== id).id;
  expect(JSON.parse(prefs.get("plenary.mine.b1.di"))).toEqual(expect.arrayContaining(["di-old", id2]));
  expect(JSON.parse(prefs.get("plenary.mine.b1.cy"))).not.toContain(id2);
});

test("p8-tidy zoomToFit, wired: on the page a cluster zooms to 8× (the page's max, not 4), then one that can't split opens the comments drawer", () => {
  rig = setup({ collab: true });
  const { app, S, net, step } = rig;
  // 320 threads in a 30×20 spot: past the collab UI's pin cap (300), so they cluster.
  for (let i = 0; i < 320; i++) app.port.thread({ id: `p${i}`, anchor: { point: { x: 400 + (i % 30), y: 300 + (Math.floor(i / 30) % 20) } }, text: `t${i}` });
  for (let i = 0; i < 40; i++) { net.advance(1000); step(2); }
  expect(S.pending).toBe(0);
  app.ui.drawer = null; step(3);
  const clusters = () => app.collab.layer.all().filter(e => /\bcluster\b/.test(e.className));
  const big = () => clusters().reduce((a, b) => (Number(b.textContent) > Number(a.textContent) ? b : a));
  expect(clusters().length).toBeGreaterThan(0);
  big().click(); step(16);
  expect(S.eds.board.view.scale).toBe(8);                          // past the old cap of 4, clamped by jumpTo's 8
  expect(app.ui.drawer).toBe(null);
  expect(clusters().length).toBeGreaterThan(0);                    // 320 in 30×20 at 8×: still over the cap
  const n = Number(big().textContent);
  big().click(); step(3);
  expect(S.eds.board.view.scale).toBe(8);
  expect(app.ui.drawer).toBe("comments");                         // the page's drawer shows the list
  expect(page.byId.drawer.hidden).toBe(false);
  expect(text(page.byId.drawer)).toContain(`${n} threads here`);
});

// ── p8-tidy round 2 ──
test("p8-tidyv H3: a resume probe stands down when the link was heard after it was armed (the backoff already restored it)", () => {
  // The verifier's case: a viewer, random 0.99, `online` arms a probe for 14.85 s; the socket then really drops and
  // the Replica's backoff reconnects and goes live first. The probe must not replace that link: one hello per return.
  rig = setup({ token: "t-vi" });
  const { S, net, step } = rig;
  const hellos = [];
  for (const t of rig.joins) { const send = t.send; t.send = m => { if (m?.t === "hello") hellos.push(net.clock.now()); return send(m); }; }
  const reopens = onlineAt(rig, 0.99);
  S.dropConnection(); step(1);
  for (let k = 0; k < 20; k++) { net.advance(1000); step(1); }
  expect(S.status).toBe("live");
  expect(reopens()).toBe(1);                                    // the backoff's, not the probe's
  expect(hellos.length).toBe(1);
  // The control: nothing heard after arming (a silent link) → the probe reconnects.
  rig = setup({ token: "t-vi" });
  const r2 = onlineAt(rig, 0.99);
  for (let k = 0; k < 16; k++) { rig.net.advance(1000); rig.step(1); }
  expect(r2()).toBe(1);
  // A welcome alone (no room event reaches the page) after arming is enough to stand down.
  let quiet = false;
  const ROOM_EVENTS = new Set(["here", "emotes", "presence", "leave"]);
  rig = setup({ token: "t-vi", wrap: t => ({ ...t, reopen: () => t.reopen(), onMessage: fn => t.onMessage(m => { if (!(quiet && ROOM_EVENTS.has(m?.t))) fn(m); }) }) });
  let roomEvents = 0;
  rig.S.onRoom(() => { roomEvents++; });
  const r3 = onlineAt(rig, 0.99);
  quiet = true; const ev0 = roomEvents;
  rig.S.reconnect(); for (let k = 0; k < 16; k++) { rig.net.advance(1000); rig.step(1); }
  expect(roomEvents).toBe(ev0);                                 // nothing but the welcome and catch-up was heard
  expect(rig.S.status).toBe("live");
  expect(r3()).toBe(1);                                         // the reconnect's only
});

test("p8-tidyv H1: the pill click is refused while refused, capped, stopped or mid-gesture; it reconnects when connecting", () => {
  for (const [status, gesture, want] of [["refused", null, 0], ["limited", null, 0], ["stopped", null, 0], ["connecting", "board", 0], ["connecting", null, 1]]) {
    rig = setup({ token: "t-vi" });
    const { S, step, joins } = rig;
    const reopens = reopenCount(joins);
    Object.defineProperty(S.connection, "status", { get: () => status, configurable: true });
    S.gesture = gesture;
    step(2);
    find(page.byId.topbar, e => /^pill\b/.test(e.className)).click();
    expect([status, gesture, reopens()]).toEqual([status, gesture, want]);
    S.gesture = null;
  }
});

test("p8-tidyv L1: a double-click on the pill while a reconnect is in flight opens one socket", () => {
  rig = setup({ token: "t-vi" });
  const { S, net, step, joins } = rig;
  const reopens = reopenCount(joins);
  const real = Object.getOwnPropertyDescriptor(S.connection, "status");
  let forced = "connecting";
  Object.defineProperty(S.connection, "status", { get: () => forced ?? real.get.call(S.connection), configurable: true });
  step(2);
  const pill = () => find(page.byId.topbar, e => /^pill\b/.test(e.className));
  pill().click(); pill().click();
  expect(reopens()).toBe(1);
  // Once the link's status moves on (or after the in-flight window), a click works again.
  forced = null; for (let k = 0; k < 2; k++) { net.advance(500); step(1); }
  expect(S.status).toBe("live");                               // within the 5 s in-flight window: the status change ends it
  forced = "connecting"; step(2);
  pill().click();
  expect(reopens()).toBe(2);
});

// ── p8-tidy round 3 ──
/** setup() whose page transport can hold every message from the room (hold.on = true): a silent or dead link. */
function heldSetup(o = {}) {
  const hold = { on: false };
  const r = setup({ ...o, wrap: t => ({ ...t, reopen: () => t.reopen(), onMessage: fn => t.onMessage(m => { if (!hold.on) fn(m); }) }) });
  return { ...r, hold };
}
const tickTo = (rig, ms, by = 500) => { for (let t = 0; t < ms; t += by) { rig.net.advance(by); rig.step(1); } };

test("p8-tidyv R2-M2: a probe stands down while a hello it didn't send waits for its welcome (backoff after a real drop)", () => {
  // The verifier's case: a viewer, a probe armed for 7.5 s, a real drop at 2 s, the backoff reopens with every reply held.
  let rig2 = heldSetup({ token: "t-vi" });
  rig = rig2;
  let reopens = onlineAt(rig2, 0.5);
  tickTo(rig2, 2000);
  rig2.hold.on = true;
  rig2.S.dropConnection(); rig2.step(1);
  tickTo(rig2, 6500);                                            // to 8.5 s: past the probe (7.5 s), before the watchdog
  expect(reopens()).toBe(1);                                     // the backoff's only
  expect(rig2.S.status).toBe("connecting");
  // Control: nothing sent, nothing heard (a silent dead link): the probe reopens.
  rig2 = heldSetup({ token: "t-vi" }); rig = rig2;
  reopens = onlineAt(rig2, 0.5);
  rig2.hold.on = true;
  tickTo(rig2, 8500);
  expect(reopens()).toBe(1);
});

test("p8-tidyv R2-H1: a room event (here) on a live link after `online` stops the probe", () => {
  rig = setup({ token: "t-vi" });
  const reopens = onlineAt(rig, 0.99);
  tickTo(rig, 3000, 1000);
  rig.net.broadcast({ t: "here", writerCount: 1, viewers: 2 }); while (rig.net.step());
  tickTo(rig, 14_000, 1000);
  expect(reopens()).toBe(0);
});

test("p8-tidyv R2-H2: the L1 guard ends after 5 s even when the status never changes", () => {
  const r = heldSetup({ token: "t-vi" }); rig = r;
  const reopens = reopenCount(r.joins);
  Object.defineProperty(r.S.connection, "status", { get: () => "connecting", configurable: true });
  r.step(2);
  const pill = () => find(page.byId.topbar, e => /^pill\b/.test(e.className));
  r.hold.on = true;
  pill().click();
  expect(reopens()).toBe(1);
  tickTo(r, 4000);
  pill().click();
  expect(reopens()).toBe(1);                                     // still in flight at 4 s
  tickTo(r, 1500);                                               // 5.5 s, the hello still unanswered (watchdog at 10 s)
  pill().click();
  expect(reopens()).toBe(2);
});

test("p8-tidyv R2-H3: Retry goes through reconnectNow: a double-click reconnects once, and a held welcome isn't replaced by a probe", () => {
  const r = heldSetup({ token: "t-vi" }); rig = r;
  const reopens = onlineAt(r, 0.5);                              // a probe armed for 7.5 s
  fireWin("offline"); r.step(3);
  const retry = find(page.byId.overlays, e => e.tagName === "BUTTON" && /^Retry/.test(e.textContent));
  expect(retry).toBeTruthy();
  r.hold.on = true;                                              // the click's welcome is held
  retry.click(); retry.click();
  expect(reopens()).toBe(1);
  tickTo(r, 8500);                                               // past the probe's fire time, before the watchdog
  expect(reopens()).toBe(1);
});

test("p8-tidyv R2-L1: a local action inside the jitter window doesn't count as heard: the probe still reopens a silent link", () => {
  const r = heldSetup(); rig = r;                                // ada, an owner: the 2 s window
  const reopens = onlineAt(r, 0.99);                             // probe at 1.98 s
  r.hold.on = true;
  let roomEvents = 0; r.S.onRoom(() => { roomEvents++; });
  r.net.advance(500); r.step(1);
  r.S.connection.record({ do: "thread", id: "r3l1", anchor: { point: { x: 1, y: 1 } }, text: "local" });   // shown at once: a local onRoom
  expect(roomEvents).toBeGreaterThan(0);
  tickTo(r, 2000);
  expect(reopens()).toBe(1);
});

// ── p8-tidy round 4 ──
test("p8-tidyv R3-H1: a message on the old socket while the link is down (a resync's backoff) isn't heard: the probe still reopens", () => {
  let deliver = null;
  rig = setup({ token: "t-vi", wrap: t => ({ ...t, reopen: () => t.reopen(), onMessage: fn => { deliver = fn; t.onMessage(fn); } }) });
  const { S, net, step } = rig;
  deliver({ t: "error", code: "unavailable", message: "room moving" });   // resync: down, the backoff (≥ 500 ms) armed
  expect(S.status).toBe("connecting");
  const reopens = onlineAt(rig, 0.01);                           // then a probe, armed for 150 ms (viewer: 0.01 × 15 s)
  deliver({ t: "here", writerCount: 1, viewers: 3 });           // the old socket still delivers while down
  net.advance(200); step(1);                                     // the probe fires before the backoff
  expect(reopens()).toBe(1);
});

test("M3 camera: jumpTo / fit / flingCamera animate smoothly and sync board & notes views on the final frame", () => {
  rig = setup({ collab: true });
  const { S, hooks, step } = rig;
  const B = S.eds.board, N = S.eds.notes;
  const startScale = B.view.scale;
  hooks.jumpTo({ x: 300, y: 200, scale: 3 });
  step(2);   // mid-animation: moving toward 3, not yet settled
  expect(B.view.scale).toBeGreaterThan(startScale);
  expect(B.view.scale).toBeLessThan(3);
  expect(N.view).toEqual(B.view);

  // Step until the exact final frame settles; notes.view MUST match board.view on that final frame.
  let guard = 0;
  while (B.hasCameraMotion() && guard++ < 40) step(1);
  expect(B.hasCameraMotion()).toBe(false);
  expect(B.view.scale).toBe(3);
  expect(N.view).toEqual(B.view);

  // Inertia fling: final frame also syncs notes.view with board.view.
  B.flingCamera(600, -400);
  guard = 0;
  while (B.hasCameraMotion() && guard++ < 200) step(1);
  expect(B.hasCameraMotion()).toBe(false);
  expect(N.view).toEqual(B.view);

  // Escape hatch: animate: false snaps synchronously.
  hooks.jumpTo({ x: -50, y: 75, scale: 1.5 }, { animate: false });
  expect(B.hasCameraMotion()).toBe(false);
  expect(B.view.scale).toBe(1.5);
  expect(N.view).toEqual(B.view);
});

test("M3 camera: pointerDown, wheel, and zoomAt cancel camera motion on both board and notes editors", () => {
  rig = setup();
  const { S, step } = rig;
  const B = S.eds.board, N = S.eds.notes;
  drawRect(S, 100, 100);
  S.setTool("note");
  S.active = "notes";
  expect(S.active).toBe("notes");

  // pointerDown cancels active motion on both board (fit) and notes (fling)
  S.fit();
  N.flingCamera(300, -200);
  expect(B.hasCameraMotion()).toBe(true);
  expect(N.hasCameraMotion()).toBe(true);
  S.pointerDown({ x: 200, y: 200 }, { space: true });
  S.pointerUp({ x: 200, y: 200 });
  expect(B.hasCameraMotion()).toBe(false);
  expect(N.hasCameraMotion()).toBe(false);

  // wheel cancels active motion on both editors even when s.active === "notes"
  S.fit();
  N.flingCamera(300, -200);
  expect(B.hasCameraMotion()).toBe(true);
  expect(N.hasCameraMotion()).toBe(true);
  S.wheel({ x: 20, y: 10 }, { x: 400, y: 300 });
  expect(B.hasCameraMotion()).toBe(false);
  expect(N.hasCameraMotion()).toBe(false);
  const afterWheel = { ...B.view };
  step(5);
  expect(B.view).toEqual(afterWheel);
  expect(N.view).toEqual(afterWheel);

  // zoomAt cancels active motion on both editors
  S.fit();
  N.flingCamera(300, -200);
  expect(B.hasCameraMotion()).toBe(true);
  expect(N.hasCameraMotion()).toBe(true);
  S.zoomAt(1.5, { x: 400, y: 300 });
  expect(B.hasCameraMotion()).toBe(false);
  expect(N.hasCameraMotion()).toBe(false);
  const afterZoom = { ...B.view };
  step(5);
  expect(B.view).toEqual(afterZoom);
  expect(N.view).toEqual(afterZoom);
});

test("M5 input: app.js forwards coalesced pen events (with pressures) and cleans up on pointercancel", () => {
  rig = setup();
  const { S } = rig;
  S.setTool("freedraw");

  page.board.fire("pointerdown", { clientX: 50, clientY: 50, pointerId: 1, pointerType: "pen", pressure: 0.2, button: 0 });
  page.board.fire("pointermove", {
    clientX: 110, clientY: 80, pointerId: 1, pointerType: "pen", pressure: 0.9, button: 0, buttons: 1,
    getCoalescedEvents: () => [
      { clientX: 70, clientY: 60, pointerId: 1, pointerType: "pen", pressure: 0.4, buttons: 1 },
      { clientX: 90, clientY: 70, pointerId: 1, pointerType: "pen", pressure: 0.7, buttons: 1 },
      { clientX: 110, clientY: 80, pointerId: 1, pointerType: "pen", pressure: 0.9, buttons: 1 },
    ],
  });
  page.board.fire("pointerup", { clientX: 110, clientY: 80, pointerId: 1, pointerType: "pen", pressure: 0.9, button: 0 });

  const live = S.eds.board.doc.live();
  expect(live.length).toBe(1);
  expect(live[0].points.length).toBe(4);
  expect(live[0].pressures).toEqual([0.2, 0.4, 0.7, 0.9]);

  // pointercancel rolls back live preview and clears active pointers without jamming.
  page.board.fire("pointerdown", { clientX: 200, clientY: 200, pointerId: 2, pointerType: "touch", button: 0 });
  page.board.fire("pointermove", { clientX: 240, clientY: 220, pointerId: 2, pointerType: "touch", button: 0, buttons: 1 });
  page.board.fire("pointercancel", { clientX: 240, clientY: 220, pointerId: 2, pointerType: "touch", button: 0 });
  expect(S.eds.board.pointers.size).toBe(0);
  expect(S.gesture).toBeNull();
  expect(S.eds.board.doc.live().length).toBe(1);
});

// Issue #42: the app must ask its net for the bytes of every picture it shows without them. render.js draws such a picture
// as a dashed path (never an `image` item), so asking from the display list never fires: it asks from the documents.
const PIC = { id: "c".repeat(40), mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=", width: 100, height: 80 };
// A picture with bytes is painted through `new Image()`: a stub that never loads.
beforeEach(() => { globalThis.Image = class { set src(v) { this._src = v; } }; });
afterAll(() => { delete globalThis.Image; });
const spyNet = () => { const wants = [], files = [], stamps = [], puts = []; return { wants, files, puts, net: { kind: "local", put: f => { puts.push(f.id); }, onFile: fn => { files.push(fn); }, want: (id, stamp) => { wants.push(id); stamps.push(stamp); } }, stamps }; };

test("DW-42.3: a picture on the board whose bytes this client lacks is asked for through net.want, and not asked for once it has them", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step } = rig;
  expect(spy.wants).toEqual([]);
  bo.addPicture(PIC); step(4);                                  // bo's op carries the element, never the bytes
  expect(S.missingFiles()).toEqual([PIC.id]);
  expect(spy.wants.length).toBeGreaterThan(0);
  expect(new Set(spy.wants)).toEqual(new Set([PIC.id]));
  spy.files[0]({ id: PIC.id, mimeType: PIC.mimeType, dataURL: PIC.dataURL });   // the net delivers them (onFile → receiveFiles)
  expect(S.missingFiles()).toEqual([]);
  const before = spy.wants.length;
  S.eds.board.changed(); step(4);
  expect(spy.wants.length).toBe(before);
});

test("a picture this client placed itself, and a deleted one, are never asked for", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step } = rig;
  S.addPicture(PIC); step(3);
  expect(S.missingFiles()).toEqual([]);
  bo.addPicture({ ...PIC, id: "d".repeat(40) }); step(3);
  const id = [...bo.eds.board.doc.byId.values()].find(e => e.fileId === "d".repeat(40)).id;
  bo.eds.board.select([id]); bo.eds.board.key("Delete"); step(4);
  expect(S.missingFiles()).toEqual([]);
});

test("#92: a picture placed by this client's own op without being uploaded (a pasted selection) is uploaded by the frame loop; one put or fetched within BLOB_PENDING_MS is not offered again, an older one is", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step, net } = rig;
  const OTHER = { ...PIC, id: "e".repeat(40) };
  bo.addPicture(OTHER); step(3);
  const ed = bo.eds.board;
  ed.select([[...ed.doc.byId.values()].find(e => e.fileId === OTHER.id).id]);
  const text = ed.copy();                                                 // a clipboard that carries the element and its bytes
  expect(text).toContain(OTHER.id);
  S.paste(text); step(4);
  expect(spy.puts).toEqual([OTHER.id]);                                   // the frame loop put it
  S.paste(text); step(4);
  expect(spy.puts).toEqual([OTHER.id]);                                   // just put: not again for BLOB_PENDING_MS
  net.advance(BLOB_PENDING_MS + 1000); step(2);
  S.paste(text); step(4);
  expect(spy.puts).toEqual([OTHER.id, OTHER.id]);                         // the server may have deleted it since: offered again with the op that places it
  S.addPicture(PIC); step(3);
  spy.files[0]({ id: "f".repeat(40), mimeType: PIC.mimeType, dataURL: PIC.dataURL });   // fetched from the server
  step(3);
  expect(spy.puts).toEqual([OTHER.id, OTHER.id]);                         // placed through addPicture (the app uploads it itself) or fetched: never offered here
});

test("#92 MED-B: moving, resizing or restyling pictures that are already placed re-uploads nothing, however old their last put", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step, net } = rig;
  const ids = ["1", "2", "3"].map(k => k.repeat(40));
  for (const id of ids) { S.addPicture({ ...PIC, id }); step(3); }
  step(5);
  expect(spy.puts).toEqual([]);                                           // addPicture's own upload is the app's (the test calls S directly)
  net.advance(BLOB_PENDING_MS * 2); step(3);                              // every picture's last put is now older than the window
  const ed = S.eds.board;
  ed.select([...ed.doc.byId.values()].filter(e => e.type === "image").map(e => e.id));
  const sent = S.sent;
  S.act("board", e => e.nudge(10, 0)); step(4); S.act("board", e => e.nudge(0, 10)); step(4);   // move all of them (ops of image elements)
  expect(S.sent).toBeGreaterThan(sent);                                   // they really were sent
  expect(spy.puts).toEqual([]);
});

test("#92 MED-C: a picture placed offline (its op resent after the reconnect, which never passes the Editor) is offered again when its op is acknowledged, if its last put is older than BLOB_PENDING_MS", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step, net, joins } = rig;
  const OTHER = { ...PIC, id: "9".repeat(40) };
  bo.addPicture(OTHER); step(3);
  const ed = bo.eds.board;
  ed.select([[...ed.doc.byId.values()].find(e => e.fileId === OTHER.id).id]);
  const text = ed.copy();
  joins[0].fail(); step(2);                                               // ada goes offline
  S.paste(text); step(4);                                                 // placed offline: put once at placement (it would be lost with the connection)
  expect(spy.puts).toEqual([OTHER.id]);
  net.advance(80 * 60_000);                                               // 80 minutes: the picture is condemned and reaped meanwhile
  S.reconnect(); step(30); net.advance(1000); step(30);
  expect(S.status).toBe("live");
  expect(spy.puts).toEqual([OTHER.id, OTHER.id]);                         // the resend does not pass the Editor: the reconnect offers it again
});

test("#92: a picture whose op the room refused (the role was lowered while offline) is never offered (its op was never sequenced)", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step, net, joins } = rig;
  const P = { ...PIC, id: "7".repeat(40) };
  bo.addPicture(P); step(3);
  const ed = bo.eds.board;
  ed.select([[...ed.doc.byId.values()].find(e => e.fileId === P.id).id]);
  const text = ed.copy();
  const prev = USERS["t-ada"].role;
  try {
    joins[0].fail(); step(2);                                               // ada offline
    S.paste(text); step(4);                                                 // placed offline: put once
    expect(spy.puts).toEqual([P.id]);
    USERS["t-ada"].role = "viewer";                                         // and her role is lowered meanwhile: the room will refuse the resent op
    net.advance(80 * 60_000);
    S.reconnect(); step(30); net.advance(1000); step(30);
    expect(S.effective).toBe("viewer");
    expect(spy.puts).toEqual([P.id]);                                       // refused: nothing is offered again
  } finally { USERS["t-ada"].role = prev; }
});

test("L1/L2: S.missing() is memoised on the documents' revisions (no scan per frame) and its stamp changes when an element showing the picture does", () => {
  const spy = spyNet();
  rig = setup({ appNet: spy.net });
  const { S, bo, step } = rig;
  bo.addPicture(PIC); step(4);
  const first = S.missing();
  expect([...first.keys()]).toEqual([PIC.id]);
  expect(S.missing()).toBe(first);                              // same Map: nothing changed, nothing rescanned
  step(3);
  expect(S.missing()).toBe(first);                              // frames alone don't invalidate it
  expect(spy.stamps.at(-1)).toBe(first.get(PIC.id));            // the app passes the stamp to the net
  const el = [...bo.eds.board.doc.byId.values()].find(e => e.fileId === PIC.id);
  bo.act("board", ed => { ed.select([el.id]); ed.nudge(10, 0); }); step(4);   // a change touching that picture
  expect(S.missing()).not.toBe(first);
  expect(S.missing().get(PIC.id)).not.toBe(first.get(PIC.id));
});

// ---- the pill explains a view-only role (PROTOCOL.md § Access explanation and requests, #51) ----
const WHY = { mine: { role: { id: "viewer", name: "Viewer" }, sources: [{ kind: "team", scope: { type: "space", id: "s-1", name: "Platform" }, role: "viewer", roleName: "Viewer", ladder: "viewer", strongest: true, team: { id: "tm-1", name: "Infra" } }] },
  needs: { "board.edit": { role: "editor", roleName: "Editor" } }, owners: [{ type: "user", id: "google:pri", name: "Priya" }, { type: "user", id: "google:tom", name: "Tom" }],
  ask: { can: true, roles: [{ id: "annotator", name: "Annotator" }, { id: "editor", name: "Editor" }], pending: null, retryAfterMs: null } };
const accessStub = (over = {}) => { const calls = []; return { calls, explainBoard: async b => { calls.push(["explainBoard", b]); return over.explain ?? { why: WHY }; }, ask: async (...a) => { calls.push(["ask", ...a]); return over.ask ?? { request: { role: a[2], roleName: "Editor", at: 1, state: "pending" } }; } }; };
const pillOf = () => find(page.byId.topbar, e => /^pill\b/.test(e.className));
const settleP = () => new Promise(r => setTimeout(r, 0));

test("#51 a viewer's pill is a button that explains the role: keyboard, Escape returns focus, the text names the source and who to ask", async () => {
  const access = accessStub();
  rig = setup({ token: "t-vi", access });
  const pill = pillOf();
  expect(pill.className).toMatch(/readonly/);
  expect([pill.getAttribute("role"), pill.getAttribute("tabindex"), pill.getAttribute("aria-haspopup"), pill.getAttribute("aria-expanded")]).toEqual(["button", "0", "dialog", "false"]);
  expect(pill.title).toMatch(/Press to see why/);
  pill.fire("keydown", { key: "Enter" });
  await settleP();
  const pop = find(page.doc.body, e => /pill-pop/.test(e.className));
  expect(pill.getAttribute("aria-expanded")).toBe("true");
  expect(pop.getAttribute("role")).toBe("dialog");
  expect(pop.parentNode).toBe(pill.parentNode);                // beside the pill in DOM order, so Tab out of it lands on the next control
  expect(access.calls[0]).toEqual(["explainBoard", "b1"]);
  const t = pop.textContent;
  expect(t).toContain("Viewer via Space Platform · Infra team.");
  expect(t).toContain("Editing needs Editor. Owners: Priya, Tom.");
  expect(find(pop, e => e.tagName === "BUTTON" && e.textContent === "Ask for access")).toBeTruthy();
  pill.fire("keydown", { key: " " });                   // toggles closed
  expect(find(page.doc.body, e => /pill-pop/.test(e.className))).toBeUndefined();
  pill.fire("keydown", { key: "Enter" }); await settleP();
  page.doc.fire("keydown", { key: "Escape" });
  expect(find(page.doc.body, e => /pill-pop/.test(e.className))).toBeUndefined();
  expect(globalThis.document.activeElement).toBe(pill);
});

test("#51 Ask for access from the pill sends the role with one Idempotency-Key and moves focus to the confirmation", async () => {
  const access = accessStub();
  rig = setup({ token: "t-vi", access });
  pillOf().click(); await settleP();
  const pop = find(page.doc.body, e => /pill-pop/.test(e.className));
  const ask = find(pop, e => e.tagName === "BUTTON" && e.textContent === "Ask for access");
  ask.click(); await settleP();
  expect(access.calls.at(-1)).toEqual(["ask", "board", "b1", "editor", "key-pill-0001"]);
  const status = find(pop, e => e.getAttribute("data-fk") === "ask-status");
  expect(status.textContent).toContain("You asked for Editor");
  expect(globalThis.document.activeElement).toBe(status);
  expect(ask.hidden).toBe(true);
});

test("#51 the pill of an editor, and a viewer page with no access port, stays a plain pill; a failed lookup says so", async () => {
  rig = setup({ token: "t-ada", access: accessStub() });
  expect(pillOf().getAttribute("role")).toBeNull();
  rig = setup({ token: "t-vi" });
  expect(pillOf().getAttribute("role")).toBeNull();
  rig = setup({ token: "t-vi", access: accessStub({ explain: { error: "unavailable" } }) });
  pillOf().click(); await settleP();
  expect(find(page.doc.body, e => /pill-pop/.test(e.className)).textContent).toContain("Could not look that up");
});

test("#51 the non-modal pill popover closes when focus tabs out of it, but not when focus moves inside it or to the pill", async () => {
  rig = setup({ token: "t-vi", access: accessStub() });
  const pill = pillOf();
  pill.click(); await settleP();
  const pop = () => find(page.doc.body, e => /pill-pop/.test(e.className));
  const inside = find(pop(), e => e.tagName === "BUTTON");
  pop().fire("focusout", { relatedTarget: inside });             // within the popover
  expect(pop()).toBeTruthy();
  pop().fire("focusout", { relatedTarget: pill });               // back to the pill
  expect(pop()).toBeTruthy();
  const hasFocus = page.doc.hasFocus; page.doc.hasFocus = () => false;
  pop().fire("focusout", { relatedTarget: null });               // the window lost focus: stays
  expect(pop()).toBeTruthy();
  page.doc.hasFocus = () => true;
  pop().fire("focusout", { relatedTarget: null });               // tabbed past the last control onto nothing, page still focused: closes
  expect(pop()).toBeUndefined();
  page.doc.hasFocus = hasFocus;
  pill.click(); await settleP();
  pop().fire("focusout", { relatedTarget: page.byId.topbar });   // somewhere else on the page
  expect(pop()).toBeUndefined();
  expect(pill.getAttribute("aria-expanded")).toBe("false");
});

test("#51 a successful Ask from the pill keeps the popover open and puts focus on the confirmation (hiding the focused button is not tabbing out)", async () => {
  const access = accessStub();
  rig = setup({ token: "t-vi", access });
  pillOf().click(); await settleP();
  const pop = () => find(page.doc.body, e => /pill-pop/.test(e.className));
  const ask = find(pop(), e => e.tagName === "BUTTON" && e.textContent === "Ask for access");
  ask.focus();
  expect(globalThis.document.activeElement).toBe(ask);
  ask.fire("keydown", { key: "Enter" }); ask.click(); await settleP();
  expect(pop()).toBeTruthy();
  expect(pillOf().getAttribute("aria-expanded")).toBe("true");
  const status = find(pop(), e => e.getAttribute("data-fk") === "ask-status");
  expect(status.textContent).toContain("You asked for Editor");
  expect(globalThis.document.activeElement).toBe(status);
  expect(ask.hidden).toBe(true);
  pop().fire("focusout", { relatedTarget: page.byId.topbar });     // a real Tab-out still closes it
  expect(pop()).toBeUndefined();
});

test("DW-52.3e the Share button shows only when the welcome says can.share: a custom-role manager at an annotator step sees it, an owner whose welcome has no can.share and a viewer do not; no share port, no button", async () => {
  const said = can => t => ({ ...t, onMessage: fn => t.onMessage(m => fn(m?.t === "welcome" && can ? { ...m, can: { share: true } } : m)) });
  const shareStub = { view: async () => ({ error: "forbidden" }) };
  const button = () => find(page.byId.topbar, e => e.getAttribute?.("data-share-open") === "1");
  rig = setup({ token: "t-cy", share: shareStub, wrap: said(true) });
  expect(rig.S.effective).toBe("annotator");
  expect(button()).toBeTruthy();
  expect(find(page.byId.topbar, e => e.tagName === "BUTTON" && e.getAttribute("title") === "Share this board")).toBeTruthy();
  rig = setup({ token: "t-ada", share: shareStub, wrap: said(false) });                // an owner by the room, but this welcome did not say it
  expect(button()).toBeUndefined();
  rig = setup({ token: "t-vi", share: shareStub, wrap: said(false) });
  expect(button()).toBeUndefined();
  rig = setup({ token: "t-cy", wrap: said(true) });                                    // no share port wired: no button either
  expect(button()).toBeUndefined();
});

// #91: the board page offers Move to… (the shared startMove flow) only where the welcome says can.move; the Space name is read from the move route only for such a person.
function movePort(o = {}) {
  const st = { space: { id: "s1", name: "Design", personal: false }, calls: [], optionsError: null, ...o };
  const options = () => ({ board: { id: "b1", title: "B" }, from: st.space, destinations: [{ id: "s2", name: "Plat", personal: false, general: null, group: null }], more: false });
  const port = { options: async b => { st.calls.push(["options", b]); return st.optionsError ? { error: st.optionsError } : { options: options() }; },
    preview: async (b, to) => ({ diff: { board: { id: "b1", title: "B" }, from: st.space, to: { id: to, name: "Plat", personal: false }, gains: [], keeps: [], loses: [], invites: null, links: null, hidden: false, more: false } }),
    move: async (b, body, key) => { st.calls.push(["move", body, key]); const from = st.space; st.space = { id: body.to, name: body.to === "s2" ? "Plat" : "Design", personal: false };
      return { result: { board: { id: "b1", title: "B", space: { id: st.space.id, name: st.space.name } }, moved: true, undo: { space: { id: from.id, name: from.name, personal: false } } } }; } };
  return { st, move: { port, newKey: () => "mk" } };
}
const canMoveWelcome = can => t => ({ ...t, onMessage: fn => t.onMessage(m => fn(m?.t === "welcome" && can ? { ...m, can: { ...m.can, move: true } } : m)) });
const moveItem = () => find(page.byId.topbar, e => e.getAttribute?.("role") === "menuitem" && e.textContent === "Move to…");
const moveBtn = () => find(page.byId.topbar, e => e.getAttribute?.("data-move-open") === "1");
const spaceLabel = () => find(page.byId.topbar, e => /\bboard-space\b/.test(e.className ?? ""))?.textContent ?? null;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await settleP(); };
const doMove = async () => {
  moveBtn().click(); await flush();
  const dlg = find(globalThis.document.body, e => e.getAttribute?.("role") === "dialog");
  const radio = find(dlg, e => e.tagName === "INPUT" && e.getAttribute("type") === "radio");
  radio.checked = true; radio.fire("change", { target: radio }); await flush();
  find(dlg, e => e.tagName === "FORM").fire("submit", { preventDefault() {} }); await flush(8); rig.step(2);
};

test("#91 board page: the Move button, its menu item and the Space name need the welcome's can.move; without it no request is made at all", async () => {
  const ok = movePort();
  rig = setup({ move: ok.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  expect(ok.st.calls).toEqual([["options", "b1"]]);                       // the Space name, read once
  expect(moveBtn()).toBeTruthy(); expect(moveBtn().getAttribute("aria-haspopup")).toBe("dialog");
  expect(moveItem()).toBeTruthy();
  expect(spaceLabel()).toBe("in Design");
  const no = movePort();
  rig = setup({ move: no.move, wrap: canMoveWelcome(false) }); await flush(); rig.step(2);
  expect(no.st.calls).toEqual([]);                                         // a viewer-heavy board costs nothing: no probe for someone the welcome does not name
  expect(moveBtn()).toBeUndefined(); expect(moveItem()).toBeUndefined(); expect(spaceLabel()).toBeNull();
  rig = setup({ wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  expect(moveBtn()).toBeUndefined();                                       // no move port wired
});

test("#91 board page: a failed read of the Space name (5xx, network) leaves Move in place; only a refusal takes it away", async () => {
  for (const optionsError of ["unavailable", "network", "auth"]) {
    const mp = movePort({ optionsError });
    rig = setup({ move: mp.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
    expect(moveBtn()).toBeTruthy(); expect(spaceLabel()).toBeNull();
  }
  const mp = movePort({ optionsError: "forbidden" });
  rig = setup({ move: mp.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  expect(moveBtn()).toBeUndefined(); expect(moveItem()).toBeUndefined();
});

test("#91 board page: Move to… opens the shared dialog; after the move the Space name follows without a reload and the Undo toast moves it back", async () => {
  const mp = movePort();
  rig = setup({ move: mp.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  await doMove();
  expect(mp.st.calls.filter(c => c[0] === "move")).toEqual([["move", { from: "s1", to: "s2" }, "mk"]]);
  expect(spaceLabel()).toBe("in Plat");
  const toast = find(globalThis.document.body, e => e.getAttribute?.("aria-label") === "Board moved");
  expect(toast.textContent).toContain("Moved B to Plat.");
  find(toast, e => e.getAttribute?.("data-fk") === "move-undo").click(); await flush(8); rig.step(2);
  expect(mp.st.calls.filter(c => c[0] === "move").at(-1)[1]).toEqual({ from: "s2", to: "s1" });
  expect(spaceLabel()).toBe("in Design");
});

test("#91 board page: a move after which the route refuses the mover takes the Move button away", async () => {
  const mp = movePort();
  rig = setup({ move: mp.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  const orig = mp.move.port.move;
  mp.move.port.move = async (...a) => { const r = await orig(...a); mp.st.optionsError = "forbidden"; return r; };
  await doMove();
  expect(moveBtn()).toBeUndefined(); expect(moveItem()).toBeUndefined();
});

test("#91 board page: after a refusal hid Move, the next welcome that says can.move (a reconnect) offers it again", async () => {
  const mp = movePort();
  rig = setup({ move: mp.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  const orig = mp.move.port.move;
  mp.move.port.move = async (...a) => { const r = await orig(...a); mp.st.optionsError = "forbidden"; return r; };
  await doMove();
  expect(moveBtn()).toBeUndefined();
  mp.st.optionsError = null;
  rig.S.reconnect(); rig.step(30); await flush(); rig.step(2);
  expect(moveBtn()).toBeTruthy();
});

test("#91 board page: closing the dialog returns focus to a visible Move control", async () => {
  const mp = movePort();
  rig = setup({ move: mp.move, wrap: canMoveWelcome(true) }); await flush(); rig.step(2);
  moveBtn().click(); await flush();
  const dlg = find(globalThis.document.body, e => e.getAttribute?.("role") === "dialog");
  dlg.parentNode.fire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} }); await flush();
  expect(globalThis.document.activeElement?.getAttribute?.("data-move-open") ?? globalThis.document.activeElement?.tagName).toBe("1");
});

test("#91 mountApp validates the move wiring: a bare port (the shape main.js once passed) throws; main.js passes { port, clock, newKey } at every move: site", async () => {
  const mp = movePort();
  expect(() => setup({ move: mp.move.port })).toThrow(/move must be/);
  const code = (await Bun.file(new URL("../../web/main.js", import.meta.url)).text()).replace(/\/\/.*$/gm, "");
  const sites = code.match(/\bmove: \{?[^\n]*/g);
  expect(sites.length).toBe(3);
  for (const l of sites) expect(l).toMatch(/^move: \{ port: httpMove\(\{[^}]*\}\), clock, newKey: \(\) => randomKey\(\) \}/);
});
