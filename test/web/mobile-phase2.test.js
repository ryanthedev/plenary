// Mobile Phase 2 (GitHub Issue #95):
// 1. Standardized 2-detent bottom sheets (half / full, grabber drag, keyboard-safe footer,
//    focus capture/restore, Escape/backdrop dismiss) + <640px comment thread/composer Full Sheet router.
// 2. Slide / Frame Reader Mode (10 frames, Canvas <-> Slides toggle, default rules, 24-32px edge-exclusion
//    swipe on 375x667 viewport, Prev/Next, 2-column Slide Index sheet, tap-to-hide Focus mode >90% canvas).
// 3. Participants & Follow Sheet (#11 fix: 5 presenters, presenters 3+ reachable via clickable +N chip,
//    "Stopped following · Re-follow" toast recovery).
// 4. First-class accessibility (non-pixel navigation of frames/elements/comments + aria-live announcements).

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EDGE_EXCLUSION_MIN_PX,
  EDGE_EXCLUSION_MAX_PX,
  DEFAULT_EDGE_EXCLUSION_PX,
  FOCUS_CANVAS_RATIO_MIN,
  isInEdgeExclusionZone,
  resolveInitialMode,
  createSlideReaderState,
  nextSlide,
  prevSlide,
  goToSlide,
  setFocusMode,
  canvasViewportCoverage,
  startSwipe,
  moveSwipe,
  endSwipe,
} from "../../web/core/mobile/slides.js";
import { createBottomSheet, createMobileCommentSheetRouter, isMobileViewport } from "../../web/adapters/dom/mobile/sheet.js";
import { createSlideReader } from "../../web/adapters/dom/mobile/slides.js";
import { createParticipantsController } from "../../web/adapters/dom/mobile/participants.js";
import { createAccessibleBoardNavigator, describeElement } from "../../web/adapters/dom/mobile/a11y-nav.js";
import { accessibleName } from "../../web/adapters/dom/a11y.js";
import { announced } from "../../web/adapters/dom/focus.js";

// ── Simulated 375×667 mobile DOM stub ──
let currentDoc = null;

class N {
  constructor(type) {
    this.nodeType = type;
    this.parentNode = null;
    this.childNodes = [];
  }
  append(...ns) {
    for (const n of ns) {
      const x = n instanceof N ? n : new T(String(n));
      x.parentNode?.removeChild(x);
      x.parentNode = this;
      this.childNodes.push(x);
    }
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
  }
  replaceChildren(...ns) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...ns);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get isConnected() {
    let x = this;
    while (x.parentNode) x = x.parentNode;
    return x === currentDoc?.body || x === currentDoc?.documentElement;
  }
  get textContent() {
    return this.childNodes.map(c => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(new T(String(v)));
  }
}

class T extends N {
  constructor(t) {
    super(3);
    this.data = t;
  }
  get textContent() {
    return this.data;
  }
}

class E extends N {
  constructor(tag) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = {
      setProperty(k, v) { this[k] = v; },
      getPropertyValue(k) { return this[k] ?? ""; },
    };
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.width = 375;
    this.height = 667;
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: c => self.classList.toggle(c, true),
      remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on ?? !s.has(c)) s.add(c);
        else s.delete(c);
        self.className = [...s].join(" ");
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(t, fn) {
    (this.listeners[t] ??= []).push(fn);
  }
  removeEventListener(t, fn) {
    this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn);
  }
  fire(t, ev = {}) {
    const e = {
      target: this,
      currentTarget: this,
      button: 0,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...ev,
    };
    for (const fn of [...(this.listeners[t] ?? [])]) fn(e);
    return e;
  }
  click() {
    if (!this.disabled) this.fire("click");
  }
  focus() {
    if (currentDoc) currentDoc.activeElement = this;
  }
  blur() {
    if (currentDoc && currentDoc.activeElement === this) currentDoc.activeElement = currentDoc.body;
  }
  setPointerCapture() {}
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height };
  }
  get children() {
    return this.childNodes.filter(c => c.nodeType === 1);
  }
  all() {
    return [this, ...this.children.flatMap(c => c.all())];
  }
}

function createMobileEnv({ width = 375, height = 667 } = {}) {
  const docL = {};
  const body = new E("body");
  const documentElement = new E("html");
  documentElement.append(body);

  const doc = {
    body,
    documentElement,
    activeElement: body,
    createElement: t => new E(t),
    createElementNS: (_ns, t) => new E(t),
    createTextNode: t => new T(t),
    getElementById: id => body.all().find(e => e.id === id) ?? null,
    querySelector: s => {
      if (s.startsWith("#")) return body.all().find(e => e.id === s.slice(1)) ?? null;
      if (s.startsWith(".")) return body.all().find(e => e.classList.contains(s.slice(1))) ?? null;
      return null;
    },
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
    fire: (t, ev = {}) => {
      const e = {
        target: doc.activeElement,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        ...ev,
      };
      for (const fn of [...(docL[t] ?? [])]) fn(e);
      return e;
    },
  };

  const vvListeners = {};
  const visualViewport = {
    width,
    height,
    offsetTop: 0,
    addEventListener: (t, fn) => { (vvListeners[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { vvListeners[t] = (vvListeners[t] ?? []).filter(f => f !== fn); },
    setKeyboardHeight(kbPx) {
      visualViewport.height = Math.max(200, height - kbPx);
      for (const fn of [...(vvListeners.resize ?? [])]) fn({});
    },
  };

  const win = {
    innerWidth: width,
    innerHeight: height,
    visualViewport,
    matchMedia: q => {
      const m = /\(max-width:\s*(\d+)px\)/.exec(q);
      const matches = m ? win.innerWidth <= Number(m[1]) : false;
      return { matches, addEventListener() {}, removeEventListener() {} };
    },
  };

  currentDoc = doc;
  globalThis.document = /** @type {any} */ (doc);
  globalThis.window = /** @type {any} */ (win);
  globalThis.Node = /** @type {any} */ (N);

  const host = new E("div");
  host.width = width;
  host.height = height;
  body.append(host);

  return { doc, win, host, visualViewport };
}

const GLOBALS = ["document", "window", "Node"];
const savedGlobals = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => {
  for (const k of GLOBALS) {
    if (savedGlobals[k]) Object.defineProperty(globalThis, k, savedGlobals[k]);
    else delete globalThis[k];
  }
});

const TEN_FRAMES = Array.from({ length: 10 }, (_, i) => ({
  id: `frame-${i + 1}`,
  name: `Slide ${i + 1}: Topic ${i + 1}`,
  x: i * 1000,
  y: 0,
  width: 800,
  height: 600,
}));

const FIVE_PRESENTERS = [
  { id: "u1", user: "u1", name: "Ada Lovelace", role: "owner", presenting: true },
  { id: "u2", user: "u2", name: "Grace Hopper", role: "editor", presenting: true },
  { id: "u3", user: "u3", name: "Alan Turing", role: "editor", presenting: true },
  { id: "u4", user: "u4", name: "Katherine Johnson", role: "presenter", presenting: true },
  { id: "u5", user: "u5", name: "Margaret Hamilton", role: "presenter", presenting: true },
];

function makeMemoryPrefs() {
  const map = new Map();
  return {
    get: k => map.get(k) ?? null,
    set: (k, v) => map.set(k, v),
  };
}

function makeFakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    set(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    flushAll() {
      for (const [id, t] of [...timers.entries()]) {
        timers.delete(id);
        t.fn();
      }
    },
    pendingCount: () => timers.size,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Standardized 2-detent bottom sheets + <640px comment sheet router
// ═══════════════════════════════════════════════════════════════════════════════
describe("Mobile Phase 2 — Area 1: Standardized 2-detent bottom sheets", () => {
  let env;
  beforeEach(() => { env = createMobileEnv({ width: 375, height: 667 }); });

  test("half/full detents, grabber drag resize/dismiss, focus capture/restore, Escape & backdrop dismiss", () => {
    const trigger = env.doc.createElement("button");
    trigger.textContent = "Open Sheet";
    env.host.append(trigger);
    trigger.focus();

    const bodyBtn = env.doc.createElement("button");
    bodyBtn.textContent = "Action";
    const footerInput = env.doc.createElement("textarea");
    footerInput.setAttribute("aria-label", "Reply");

    const detents = [];
    const closes = [];
    const sheet = createBottomSheet({
      host: env.host,
      title: "Inspector",
      initialDetent: "half",
      body: bodyBtn,
      footer: footerInput,
      onDetentChange: d => detents.push(d),
      onClose: info => closes.push(info.reason),
      doc: env.doc,
      win: env.win,
    });

    sheet.open();
    expect(sheet.isOpen()).toBe(true);
    expect(sheet.getDetent()).toBe("half");
    expect(sheet.el.getAttribute("role")).toBe("dialog");
    expect(sheet.el.getAttribute("aria-modal")).toBe("true");
    expect(sheet.el.getAttribute("data-detent")).toBe("half");
    expect(accessibleName(sheet.el, env.doc)).toBe("Inspector");
    expect(env.doc.activeElement).not.toBe(trigger);
    expect(sheet.el.contains(env.doc.activeElement)).toBe(true);

    // Grabber drag up snaps half -> full
    sheet.grabber.fire("pointerdown", { pointerId: 1, clientY: 400 });
    sheet.grabber.fire("pointermove", { pointerId: 1, clientY: 310 });
    sheet.grabber.fire("pointerup", { pointerId: 1, clientY: 310 });
    expect(sheet.getDetent()).toBe("full");
    expect(sheet.el.getAttribute("data-detent")).toBe("full");
    expect(detents).toEqual(["full"]);

    // Keyboard-safe footer tracks visualViewport shrink
    env.visualViewport.setKeyboardHeight(260);
    expect(sheet.el.style.getPropertyValue("--kb-inset")).toBe("260px");
    expect(sheet.el.classList.contains("kb-open")).toBe(true);
    env.visualViewport.setKeyboardHeight(0);
    expect(sheet.el.style.getPropertyValue("--kb-inset")).toBe("0px");

    // Grabber drag down snaps full -> half
    sheet.grabber.fire("pointerdown", { pointerId: 2, clientY: 100 });
    sheet.grabber.fire("pointerup", { pointerId: 2, clientY: 180 });
    expect(sheet.getDetent()).toBe("half");

    // Grabber drag far down from half dismisses and restores focus to trigger
    sheet.grabber.fire("pointerdown", { pointerId: 3, clientY: 350 });
    sheet.grabber.fire("pointerup", { pointerId: 3, clientY: 480 });
    expect(sheet.isOpen()).toBe(false);
    expect(closes).toEqual(["drag"]);
    expect(env.doc.activeElement).toBe(trigger);

    // Escape dismissal restores focus
    sheet.open({ detent: "half" });
    env.doc.fire("keydown", { key: "Escape" });
    expect(sheet.isOpen()).toBe(false);
    expect(closes).toEqual(["drag", "escape"]);
    expect(env.doc.activeElement).toBe(trigger);

    // Backdrop tap dismisses and restores focus
    sheet.open({ detent: "full" });
    sheet.backdrop.click();
    expect(sheet.isOpen()).toBe(false);
    expect(closes).toEqual(["drag", "escape", "backdrop"]);
    expect(env.doc.activeElement).toBe(trigger);

    sheet.destroy();
  });

  test("routes <640px comment thread views & composers into a Full Sheet, and delegates >=640px to desktop", () => {
    expect(isMobileViewport(env.win)).toBe(true);

    let desktopThreads = 0;
    let desktopComposers = 0;
    const router = createMobileCommentSheetRouter({
      host: env.host,
      openDesktopThread: () => { desktopThreads++; return "desktop-thread"; },
      openDesktopComposer: () => { desktopComposers++; return "desktop-composer"; },
      doc: env.doc,
      win: env.win,
    });

    const threadSheet = router.openThread({
      id: "t1",
      title: "API Review",
      messages: [
        { author: "Ada", text: "Looks great!" },
        { author: "Grace", text: "Ship it." },
      ],
    });
    expect(desktopThreads).toBe(0);
    expect(router.isOpen()).toBe(true);
    expect(router.currentKind()).toBe("comment-thread");
    expect(threadSheet.getDetent()).toBe("full");
    expect(threadSheet.el.getAttribute("data-detent")).toBe("full");
    expect(threadSheet.footerEl.hidden).toBe(false);
    expect(threadSheet.bodyEl.textContent).toContain("Looks great!");
    expect(threadSheet.bodyEl.textContent).toContain("Ship it.");

    const composerSheet = router.openComposer({ label: "Frame 2" });
    expect(desktopComposers).toBe(0);
    expect(router.currentKind()).toBe("comment-composer");
    expect(composerSheet.getDetent()).toBe("full");
    expect(composerSheet.footerEl.hidden).toBe(false);
    router.close();

    // Desktop (>=640px) delegates instead of opening mobile sheet
    env.win.innerWidth = 1024;
    expect(isMobileViewport(env.win)).toBe(false);
    expect(router.openThread({ id: "t2" })).toBe("desktop-thread");
    expect(router.openComposer({ label: "Canvas" })).toBe("desktop-composer");
    expect(desktopThreads).toBe(1);
    expect(desktopComposers).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Slide / Frame Reader Mode (10 frames, 375×667 viewport)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Mobile Phase 2 — Area 2: Slide / Frame Reader Mode", () => {
  let env;
  beforeEach(() => { env = createMobileEnv({ width: 375, height: 667 }); });

  test("pure state & edge-exclusion math: defaults, 24-32px edge exclusion, swipe axis, >90% focus coverage", () => {
    expect(EDGE_EXCLUSION_MIN_PX).toBe(24);
    expect(EDGE_EXCLUSION_MAX_PX).toBe(32);
    expect(DEFAULT_EDGE_EXCLUSION_PX).toBeGreaterThanOrEqual(24);
    expect(DEFAULT_EDGE_EXCLUSION_PX).toBeLessThanOrEqual(32);

    // Defaults to Canvas unless presenter is active or user saved "slides" for this board
    expect(resolveInitialMode({ hasActivePresenter: false, savedBoardMode: null, hasFrames: true })).toBe("canvas");
    expect(resolveInitialMode({ hasActivePresenter: true, savedBoardMode: null, hasFrames: true })).toBe("slides");
    expect(resolveInitialMode({ hasActivePresenter: true, savedBoardMode: "canvas", hasFrames: true })).toBe("canvas");
    expect(resolveInitialMode({ hasActivePresenter: false, savedBoardMode: "slides", hasFrames: true })).toBe("slides");

    // 375px viewport edge-exclusion zone
    expect(isInEdgeExclusionZone(12, 375, 28)).toBe(true);
    expect(isInEdgeExclusionZone(28, 375, 28)).toBe(true);
    expect(isInEdgeExclusionZone(347, 375, 28)).toBe(true);
    expect(isInEdgeExclusionZone(365, 375, 28)).toBe(true);
    expect(isInEdgeExclusionZone(180, 375, 28)).toBe(false);

    // Edge swipe is ignored
    const edgeSwipe = startSwipe({ x: 16, y: 300, t: 0, viewportWidth: 375, edgePx: 28 });
    expect(edgeSwipe.ignoredByEdge).toBe(true);
    expect(endSwipe(moveSwipe(edgeSwipe, { x: 220, y: 302, t: 120 })).action).toBe("none");

    // Safe center swipe left -> next, right -> prev
    const leftSwipe = moveSwipe(startSwipe({ x: 260, y: 300, t: 0, viewportWidth: 375 }), { x: 140, y: 305, t: 120 });
    expect(endSwipe(leftSwipe).action).toBe("next");
    const rightSwipe = moveSwipe(startSwipe({ x: 120, y: 300, t: 0, viewportWidth: 375 }), { x: 240, y: 304, t: 120 });
    expect(endSwipe(rightSwipe).action).toBe("prev");

    // Vertical scroll does not trigger horizontal slide change
    const vertSwipe = moveSwipe(startSwipe({ x: 180, y: 200, t: 0, viewportWidth: 375 }), { x: 210, y: 360, t: 120 });
    expect(endSwipe(vertSwipe).action).toBe("none");

    // Focus mode >90% canvas coverage
    const cov = canvasViewportCoverage({ viewportHeight: 667, focusMode: true });
    expect(cov).toBeGreaterThan(FOCUS_CANVAS_RATIO_MIN);

    // Pure state transitions across 10 frames
    let st = createSlideReaderState({ frames: TEN_FRAMES, hasActivePresenter: true });
    expect(st.mode).toBe("slides");
    st = nextSlide(st);
    expect(st.index).toBe(1);
    st = goToSlide(st, 9);
    expect(st.index).toBe(9);
    st = nextSlide(st); // clamped
    expect(st.index).toBe(9);
    st = prevSlide(st);
    expect(st.index).toBe(8);
    st = setFocusMode(st, true);
    expect(st.focusMode).toBe(true);
  });

  test("DOM reader with 10 frames: 1-tap toggle, per-board persistence, edge swipe, Prev/Next, 2-col Index sheet, Focus mode", () => {
    const prefs = makeMemoryPrefs();
    const viewport = env.doc.createElement("div");
    viewport.width = 375;
    viewport.height = 667;
    env.host.append(viewport);

    const jumped = [];
    const reader = createSlideReader({
      host: env.host,
      viewportEl: viewport,
      boardId: "board-95",
      frames: TEN_FRAMES,
      hasActivePresenter: false,
      prefs,
      onJumpToFrame: (frame, idx) => jumped.push(`${idx}:${frame.id}`),
      doc: env.doc,
      win: env.win,
    });

    // Defaults to Canvas when no presenter is active and no saved board pref
    expect(reader.getState().mode).toBe("canvas");

    // 1-tap Canvas -> Slides toggle persists preference for board-95
    const slidesBtn = reader.toggleEl.all().find(e => e.getAttribute("data-mode") === "slides");
    slidesBtn.click();
    expect(reader.getState().mode).toBe("slides");
    expect(prefs.get("plenary.mobile.reader.board-95")).toBe("slides");
    expect(jumped[0]).toBe("0:frame-1");

    // New reader instance on the same board defaults to Slides because user toggled it
    const reader2 = createSlideReader({
      host: env.host,
      boardId: "board-95",
      frames: TEN_FRAMES,
      hasActivePresenter: false,
      prefs,
      doc: env.doc,
      win: env.win,
    });
    expect(reader2.getState().mode).toBe("slides");
    reader2.destroy();

    // Always-visible Next / Prev buttons
    const nextBtn = reader.navEl.all().find(e => e.getAttribute("data-slide-action") === "next");
    const prevBtn = reader.navEl.all().find(e => e.getAttribute("data-slide-action") === "prev");
    const indexBtn = reader.navEl.all().find(e => e.getAttribute("data-slide-action") === "index");

    nextBtn.click();
    expect(reader.getState().index).toBe(1);
    expect(reader.liveEl.textContent).toContain("Slide 2 of 10");

    prevBtn.click();
    expect(reader.getState().index).toBe(0);
    expect(reader.liveEl.textContent).toContain("Slide 1 of 10");

    // Swipe starting in left edge-exclusion zone (x=14 on 375px viewport) is ignored
    viewport.fire("pointerdown", { pointerType: "touch", pointerId: 10, clientX: 14, clientY: 320, timeStamp: 0 });
    viewport.fire("pointermove", { pointerType: "touch", pointerId: 10, clientX: 220, clientY: 322, timeStamp: 90 });
    viewport.fire("pointerup", { pointerType: "touch", pointerId: 10, clientX: 220, clientY: 322, timeStamp: 100 });
    expect(reader.getState().index).toBe(0);

    // Swipe starting in right edge-exclusion zone (x=362 on 375px viewport) is ignored
    viewport.fire("pointerdown", { pointerType: "touch", pointerId: 11, clientX: 362, clientY: 320, timeStamp: 0 });
    viewport.fire("pointermove", { pointerType: "touch", pointerId: 11, clientX: 160, clientY: 320, timeStamp: 90 });
    viewport.fire("pointerup", { pointerType: "touch", pointerId: 11, clientX: 160, clientY: 320, timeStamp: 100 });
    expect(reader.getState().index).toBe(0);

    // Safe center swipe left advances to slide 2 (index 1)
    viewport.fire("pointerdown", { pointerType: "touch", pointerId: 12, clientX: 280, clientY: 320, timeStamp: 0 });
    viewport.fire("pointermove", { pointerType: "touch", pointerId: 12, clientX: 150, clientY: 324, timeStamp: 90 });
    viewport.fire("pointerup", { pointerType: "touch", pointerId: 12, clientX: 150, clientY: 324, timeStamp: 100 });
    expect(reader.getState().index).toBe(1);

    // Open 2-column Slide Index sheet and jump to slide 8 (index 7)
    indexBtn.click();
    expect(reader.indexSheet.isOpen()).toBe(true);
    const grid = reader.indexSheet.bodyEl.all().find(e => e.classList.contains("mp2-slide-index-grid"));
    expect(grid.getAttribute("data-columns")).toBe("2");
    const cards = grid.all().filter(e => e.classList.contains("mp2-slide-card"));
    expect(cards.length).toBe(10);
    cards[7].click();
    expect(reader.getState().index).toBe(7);
    expect(reader.indexSheet.isOpen()).toBe(false);
    expect(reader.liveEl.textContent).toContain("Slide 8 of 10");

    // Tap-to-hide Focus mode (>90% canvas)
    viewport.fire("pointerdown", { pointerType: "touch", pointerId: 13, clientX: 180, clientY: 300, timeStamp: 0 });
    viewport.fire("pointerup", { pointerType: "touch", pointerId: 13, clientX: 182, clientY: 301, timeStamp: 40 });
    expect(reader.getState().focusMode).toBe(true);
    expect(reader.el.classList.contains("mp2-focus-mode")).toBe(true);
    expect(reader.getCanvasCoverage()).toBeGreaterThan(0.9);

    // Tap again exits Focus mode
    viewport.fire("pointerdown", { pointerType: "touch", pointerId: 14, clientX: 180, clientY: 300, timeStamp: 0 });
    viewport.fire("pointerup", { pointerType: "touch", pointerId: 14, clientX: 180, clientY: 300, timeStamp: 40 });
    expect(reader.getState().focusMode).toBe(false);

    reader.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Participants & Follow Sheet (#11 fix: 5 presenters)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Mobile Phase 2 — Area 3: Participants & Follow Sheet (#11 fix)", () => {
  let env;
  beforeEach(() => { env = createMobileEnv({ width: 375, height: 667 }); });

  test("5 presenters: clickable +3 chip opens sheet exposing presenters 3-5, follow & Stopped following · Re-follow toast", () => {
    const clock = makeFakeClock();
    const followed = [];
    const unfollowed = [];

    const ctrl = createParticipantsController({
      host: env.host,
      participants: FIVE_PRESENTERS,
      clock,
      onFollow: p => followed.push(p.id),
      onUnfollow: (p, reason) => unfollowed.push(`${p.id}:${reason}`),
      doc: env.doc,
      win: env.win,
    });

    // Mobile strip shows 2 avatars + clickable "+3" chip
    expect(ctrl.chipEl.tagName).toBe("BUTTON");
    expect(ctrl.chipEl.textContent).toBe("+3");
    expect(ctrl.chipEl.getAttribute("aria-haspopup")).toBe("dialog");

    // Clicking "+3" opens the 2-detent Participants sheet with all 5 presenters
    ctrl.chipEl.click();
    expect(ctrl.isSheetOpen()).toBe(true);
    const rows = ctrl.sheet.bodyEl.all().filter(e => e.classList.contains("mp2-participant-row"));
    expect(rows.length).toBe(5);

    // Presenter #4 (Katherine Johnson) & Presenter #5 (Margaret Hamilton) are reachable & followable!
    const followBtn4 = ctrl.sheet.bodyEl.all().find(e => e.getAttribute("data-follow-id") === "u4");
    const followBtn5 = ctrl.sheet.bodyEl.all().find(e => e.getAttribute("data-follow-id") === "u5");
    expect(followBtn4).toBeDefined();
    expect(followBtn5).toBeDefined();

    followBtn4.click();
    expect(ctrl.getFollowing()?.id).toBe("u4");
    expect(followed).toEqual(["u4"]);
    expect(ctrl.liveEl.textContent).toBe("Following Katherine Johnson");

    // Manual pan stops following and shows "Stopped following Katherine Johnson · Re-follow" toast
    ctrl.stopFollowing({ reason: "pan" });
    expect(ctrl.getFollowing()).toBeNull();
    expect(unfollowed).toEqual(["u4:pan"]);
    expect(ctrl.liveEl.textContent).toBe("Stopped following Katherine Johnson");

    const toast = ctrl.getToastEl();
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain("Stopped following Katherine Johnson");
    expect(toast.textContent).toContain("Re-follow");

    // Clicking "Re-follow" immediately resumes following Katherine Johnson and clears toast
    const refollowBtn = toast.all().find(e => e.getAttribute("data-action") === "refollow");
    refollowBtn.click();
    expect(ctrl.getFollowing()?.id).toBe("u4");
    expect(ctrl.getToastEl()).toBeNull();
    expect(followed).toEqual(["u4", "u4"]);
    expect(ctrl.liveEl.textContent).toBe("Following Katherine Johnson");

    // Auto-dismiss via clock works cleanly
    ctrl.stopFollowing({ reason: "pan" });
    expect(ctrl.getToastEl()).not.toBeNull();
    expect(clock.pendingCount()).toBe(1);
    clock.flushAll();
    expect(ctrl.getToastEl()).toBeNull();

    ctrl.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. First-class accessibility & CSS ergonomics
// ═══════════════════════════════════════════════════════════════════════════════
describe("Mobile Phase 2 — Area 4: First-class accessibility & CSS", () => {
  let env;
  beforeEach(() => { env = createMobileEnv({ width: 375, height: 667 }); });

  test("accessible non-pixel navigation of frames, elements, and comments with keyboard & aria-live announcements", () => {
    const focusedFrames = [];
    const focusedElements = [];
    const openedComments = [];

    const nav = createAccessibleBoardNavigator({
      host: env.host,
      frames: TEN_FRAMES.slice(0, 3),
      elements: [
        { id: "e1", type: "rectangle", label: "API Gateway" },
        { id: "e2", type: "note", text: "Check mobile keyboard inset" },
      ],
      comments: [
        { id: "c1", author: "Ada", text: "Can we widen the edge zone?", replyCount: 2, resolved: false },
      ],
      onFocusFrame: f => focusedFrames.push(f.id),
      onFocusElement: e => focusedElements.push(e.id),
      onOpenComment: c => openedComments.push(c.id),
      doc: env.doc,
    });

    expect(nav.el.getAttribute("role")).toBe("region");
    expect(nav.liveEl.getAttribute("aria-live")).toBe("polite");
    expect(describeElement({ id: "e1", type: "rectangle", label: "API Gateway" }, 0)).toBe("Rectangle: API Gateway");

    // Frames section: keyboard ArrowDown navigates without touching pixels
    const frameBtns = nav.listEl.all().filter(e => e.getAttribute("data-nav-kind") === "frame");
    expect(frameBtns.length).toBe(3);
    frameBtns[0].focus();
    nav.listEl.fire("keydown", { key: "ArrowDown" });
    expect(env.doc.activeElement).toBe(frameBtns[1]);
    frameBtns[1].click();
    expect(focusedFrames).toEqual(["frame-2"]);
    expect(nav.liveEl.textContent).toContain("Focused frame 2 of 3");
    expect(announced()).toContain("Focused frame 2 of 3");

    // Switch to Elements tab
    nav.setSection("elements");
    const elBtns = nav.listEl.all().filter(e => e.getAttribute("data-nav-kind") === "element");
    expect(elBtns.length).toBe(2);
    elBtns[0].click();
    expect(focusedElements).toEqual(["e1"]);
    expect(nav.liveEl.textContent).toContain("Selected Rectangle: API Gateway");

    // Switch to Comments tab
    nav.setSection("comments");
    const commentBtns = nav.listEl.all().filter(e => e.getAttribute("data-nav-kind") === "comment");
    expect(commentBtns.length).toBe(1);
    commentBtns[0].click();
    expect(openedComments).toEqual(["c1"]);
    expect(nav.liveEl.textContent).toContain("Opened comment by Ada");

    nav.destroy();
  });

  test("web/styles/mobile-phase2.css covers detents, 2-col index, safe-area + keyboard inset, 44px touch targets, 16px inputs", () => {
    const css = readFileSync(join(process.cwd(), "web/styles/mobile-phase2.css"), "utf8");
    expect(css).toContain('[data-detent="half"]');
    expect(css).toContain('[data-detent="full"]');
    expect(css).toContain("var(--kb-inset");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("font-size: 16px");
    expect(css).toContain("100dvh".replace("100", "94"));
    expect(css).toContain(".mp2-focus-mode");
  });
});
