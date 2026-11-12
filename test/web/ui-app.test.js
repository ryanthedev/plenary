// The canvas page itself (web/adapters/dom/app.js) mounted on a stub DOM over the in-page room and its virtual clock
// (p7-chrome): the chrome is rebuilt only when what a part shows changes (C-2, C-8), the zoom % and pill update in
// place, `online` / a long-hidden tab reconnects (C-4), the collab UI gets the clock port (C-6), a refused or
// expiring sign-in offers "Sign in again" (C-9), and the cap's countdown reads the clock port (C-17).
import { test, expect, beforeEach, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { expiryNotice, shouldProbe, takeReturnBoard, rememberBoard, connectionBanner, RETURN_KEY, EXPIRY_WARN_MS } from "../../web/core/roles.js";

// ── a stub page: just enough DOM for app.js (text only; no layout) ──
class N {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) { for (const n of ns) { const x = n instanceof N ? n : new T(String(n)); x.parentNode?.removeChild(x); x.parentNode = this; this.childNodes.push(x); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { this.replaced = (this.replaced ?? 0) + 1; for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
  remove() { this.parentNode?.removeChild(this); }
  get textContent() { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(new T(String(v))); }
}
class T extends N { constructor(t) { super(3); this.data = t; } get textContent() { return this.data; } }
const CTX = { measureText: t => ({ width: String(t).length * 7 }), getImageData: () => ({ data: [] }), createLinearGradient: () => ({ addColorStop() {} }), createPattern: () => null };
class E extends N {
  constructor(tag) {
    super(1); this.tagName = tag.toUpperCase(); this.className = ""; this.listeners = {}; this.attrs = {}; this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 300; this.height = 150;
    const self = this;
    this.classList = { contains: c => self.className.split(/\s+/).includes(c), add: c => self.classList.toggle(c, true), remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(" "); } };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) { const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev }; for (const fn of this.listeners[t] ?? []) fn(e); return e; }
  click() { if (!this.disabled) this.fire("click"); }
  focus() {} blur() {} setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { const p = this.parentNode; p.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); n.parentNode?.removeChild(n); n.parentNode = p; p.childNodes.splice(i, 0, n); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}
const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];

let frames, winL, page;
// The globals this file stubs, put back afterwards so later files' fallbacks never see the stub page.
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => { for (const k of GLOBALS) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } });
function installPage() {
  frames = []; winL = {};
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const docL = {};
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    fire(t, ev = {}) { for (const fn of docL[t] ?? []) fn({ target: board, preventDefault() {}, ...ev }); },
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { winL[t] = (winL[t] ?? []).filter(f => f !== fn); },
  });
  page = { doc, byId, board };
  return page;
}
const fireWin = (t, ev = {}) => { for (const fn of winL[t] ?? []) fn({ preventDefault() {}, ...ev }); };

const USERS = { "t-ada": { user: "ada", role: "owner" }, "t-bo": { user: "bo", role: "editor" }, "t-cy": { user: "cy", role: "annotator" } };

/** ada's page over a room with bo (a second presenter, headless) on the same virtual clock. */
function setup({ expAt = null, relogin = null, collab = false, role = null } = {}) {
  installPage();
  const net = localRoom({ users: USERS, clock: true });
  const joins = [], hooks = {};
  const bo = createSession({ join: () => net.join(), token: "t-bo", board: "b1", client: "bo", user: "bo", clock: net.clock });
  bo.setSize(1200, 800);
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({ join: () => { const t = net.join(); joins.push(t); return t; }, token: "t-ada", board: "b1", client: "ada", user: "ada", mine, onChange, clock: net.clock }),
    net: { kind: "local", put() {}, onFile() {} }, board: "b1", me: { user: "ada", name: "Ada", role }, prefs: memoryStore(), theme: "light",
    clock: net.clock, expAt, relogin,
    collab: collab ? (S, o) => { hooks.jumpTo = o.jumpTo; return syncCollabPort(S, { name: "Ada", frame: fn => net.clock.set(fn, 16), ...o }); } : null,
  });
  /** n animation frames, 16 ms of virtual time each, the room settled in between. */
  // Deliveries until quiet, then 16 ms of timers (never settle(): the collab UI's frame loop re-arms forever).
  const step = (n = 1) => { for (let i = 0; i < n; i++) { while (net.step()); net.advance(16); while (net.step()); const q = frames; frames = []; for (const fn of q) fn(); } };
  step(3);
  return { net, app, S: app.S, bo, step, joins, hooks };
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
  expect(text(notesBtn())).toBe("❏ Notes 0");
  c0 = counts();
  bo.placeNote({ x: 300, y: 300 }, "from bo"); step(20);                     // incoming note: topbar count + drawer row
  expect(text(notesBtn())).toBe("❏ Notes 1");
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
  for (const b of [S.binds.board, S.binds.notes]) {
    Object.defineProperty(b, "nextTryAt", { get: () => at, configurable: true });
    Object.defineProperty(b, "limited", { get: () => "8 writer connections", configurable: true });
    Object.defineProperty(b, "status", { get: () => "limited", configurable: true });
  }
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
  hooks.jumpTo({ x: 400, y: 250 }); step();
  expect(B.view.scale).toBe(s0);
  expect(centre()).toEqual({ x: 400, y: 250 });
  hooks.jumpTo({ x: -100, y: 30, scale: 2.5 }); step();
  expect(B.view.scale).toBe(2.5);
  expect(centre().x).toBeCloseTo(-100); expect(centre().y).toBeCloseTo(30);
  expect(S.eds.notes.view).toEqual(B.view);                   // both Editors share the view
  hooks.jumpTo({ x: 0, y: 0, scale: 50 }); step(); expect(B.view.scale).toBe(8);
  hooks.jumpTo({ x: 0, y: 0, scale: 0.001 }); step(); expect(B.view.scale).toBe(0.1);
  expect(centre().x).toBeCloseTo(0);
  hooks.jumpTo({ x: 0, y: 0, scale: NaN }); step(); expect(B.view.scale).toBe(0.1);
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
  expect(find(page.byId.timeline, e => e.className === "t").textContent).toMatch(/^\d+\.\ds \/ /);
});

// ── verifier (p7-chromev) cases ──
const panelText = () => text(page.byId.panel);
function drawFrame(s, x, y) { s.setTool("frame"); s.pointerDown({ x, y }); s.pointerMove({ x: x + 200, y: y + 150 }); s.pointerUp({ x: x + 200, y: y + 150 }); s.setTool("select"); }

test("V1 remote note deleted: topbar count and drawer drop", () => {
  rig = setup(); const { bo, step, app } = rig;
  app.ui.drawer = "notes"; app.setPanel({ type: "noop" }); step(20);
  bo.placeNote({ x: 300, y: 300 }, "n1"); bo.placeNote({ x: 400, y: 300 }, "n2"); step(20);
  const btn = () => find(page.byId.topbar, e => e.tagName === "BUTTON" && e.attrs.title === "Notes");
  expect(text(btn())).toBe("❏ Notes 2");
  const id = bo.eds.notes.doc.live().find(e => e.type === "text" ? e.text === "n1" : bo.eds.notes.doc.labelOf(e)?.text === "n1")?.id ?? bo.eds.notes.doc.live()[0].id;
  bo.act("notes", n => n.deleteIds([id])); step(20);
  expect(text(btn())).toBe("❏ Notes 1");
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
  expect(find(page.byId.timeline, e => e.tagName === "BUTTON" && e.attrs?.title?.startsWith("Play")).textContent).toBe("▶");
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
  for (const b of [S.binds.board, S.binds.notes]) Object.defineProperty(b, "status", { get: () => "limited", configurable: true });
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

test("K3 main.js: the token goes only into createSession; sign-in leaves for the fixed href; the return board only via takeReturnBoard", async () => {
  const src = await Bun.file(new URL("../../web/main.js", import.meta.url)).text();
  const code = src.replace(/\/\/.*$/gm, "");
  expect(code.match(/signIn\.token/g).length).toBe(2);                         // the gate check and createSession's token
  expect(code).toMatch(/if \(!signIn\.token\)/);
  expect(code).toMatch(/createSession\(\{[^}]*token: signIn\.token,/);
  expect(code.match(/location\.assign\(([^)]*)\)/g)).toEqual(["location.assign(signInLink.href)"]);
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
