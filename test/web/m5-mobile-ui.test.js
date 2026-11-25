// Phase 4 Gate: M5 Chrome-on-iOS shell, visualViewport sync, safe-area insets,
// WebKit gesture lock, coarse-pointer 16px inputs & 44px touch targets,
// swipe-down-to-dismiss bottom sheets, and mobile layout invariants (<= 640px).
import { test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { syncCollabPort } from "../../web/adapters/collab/sync.js";
import { mountApp } from "../../web/adapters/dom/app.js";

// ── minimal DOM stub (same shape as ui-app.test.js, with visualViewport & media queries) ──
class N {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  append(...ns) { for (const n of ns) { const x = n instanceof N ? n : new T(String(n)); x.parentNode?.removeChild(x); x.parentNode = this; this.childNodes.push(x); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; }
  replaceChildren(...ns) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...ns); }
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
    this.hidden = false; this.disabled = false; this.value = ""; this.scrollTop = 0; this.width = 390; this.height = 844;
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: c => self.classList.toggle(c, true),
      remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on ?? !s.has(c)) s.add(c); else s.delete(c); self.className = [...s].join(" "); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) { const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev }; for (const fn of this.listeners[t] ?? []) fn(e); return e; }
  click() { if (!this.disabled) this.fire("click"); }
  focus() {} blur() {} setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { this.parentNode.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); n.parentNode?.removeChild(n); n.parentNode = p; p.childNodes.splice(i, 0, n); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }; }
  getContext() { return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true }); }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "visualViewport"];
const saved = Object.fromEntries(GLOBALS.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
afterAll(() => {
  for (const k of GLOBALS) {
    if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
    else delete globalThis[k];
  }
});

const USERS = {
  "t-ada": { user: "ada", role: "owner" },
  "t-cy": { user: "cy", role: "annotator" },
  "t-vi": { user: "vi", role: "viewer" },
};

function makeVisualViewport({ height = 844, offsetTop = 0 } = {}) {
  const listeners = {};
  return {
    height,
    offsetTop,
    addEventListener(t, fn) { (listeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] ?? []).filter(f => f !== fn); },
    fire(t) { for (const fn of listeners[t] ?? []) fn({}); },
  };
}

function setupMobile(opts = {}) {
  const { token = "t-ada", phone = true, coarse = true, collab = false } = opts;
  const visualViewport = "visualViewport" in opts ? opts.visualViewport : makeVisualViewport();
  let frames = [];
  const winL = {}, docL = {};
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t), createTextNode: t => new T(t),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 3,
    matchMedia: q => ({
      matches: q.includes("pointer: coarse") && q.includes("max-width: 768px")
        ? (phone && coarse)
        : q.includes("max-width: 640px")
          ? phone
          : q.includes("pointer: coarse")
            ? coarse
            : false,
      addEventListener() {},
    }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { winL[t] = (winL[t] ?? []).filter(f => f !== fn); },
    visualViewport,
  });

  const net = localRoom({ board: "mobile-board", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({ join: () => net.join(), token, board: "mobile-board", client: USERS[token].user, user: USERS[token].user, mine, onChange, clock: net.clock }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "mobile-board",
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs: memoryStore(),
    theme: "light",
    clock: net.clock,
    collab: collab ? (S, o) => syncCollabPort(S, { name: "Ada", frame: fn => net.clock.set(fn, 16), ...o }) : null,
  });
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      while (net.step());
      net.advance(16);
      while (net.step());
      const q = frames; frames = [];
      for (const fn of q) fn();
    }
  };
  step(3);
  return { doc, byId, board, canvasBox, ink, app, S: app.S, net, step, visualViewport };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);

test("visualViewport resize and scroll sync --vv-height and --vv-top, with clean fallback when absent", () => {
  const vv = makeVisualViewport({ height: 844, offsetTop: 0 });
  const { doc } = setupMobile({ visualViewport: vv });
  const rootStyle = doc.documentElement.style;
  expect(rootStyle.getPropertyValue("--vv-height")).toBe("844px");
  expect(rootStyle.getPropertyValue("--vv-top")).toBe("0px");

  // Software keyboard opens on Chrome iOS: viewport shrinks and shifts down.
  vv.height = 492.4;
  vv.offsetTop = 36;
  vv.fire("resize");
  expect(rootStyle.getPropertyValue("--vv-height")).toBe("492px");
  expect(rootStyle.getPropertyValue("--vv-top")).toBe("36px");

  // Scroll event updates --vv-top; negative rubber-band offset clamps to 0px.
  vv.offsetTop = -12;
  vv.fire("scroll");
  expect(rootStyle.getPropertyValue("--vv-top")).toBe("0px");

  // Clean fallback when window.visualViewport is absent.
  const fallback = setupMobile({ visualViewport: undefined });
  expect(fallback.doc.documentElement.style.getPropertyValue("--vv-height")).toBe("100dvh");
  expect(fallback.doc.documentElement.style.getPropertyValue("--vv-top")).toBe("0px");
});

test("HTML & CSS static rules: viewport-fit=cover, 100dvh/--vv-height, safe-area insets, gesture locks, 16px coarse inputs, 44px touch targets", async () => {
  const html = await Bun.file(new URL("../../web/index.html", import.meta.url)).text();
  const css = await Bun.file(new URL("../../web/style.css", import.meta.url)).text();
  const collabCss = await Bun.file(new URL("../../web/adapters/dom/collab/collab.css", import.meta.url)).text();

  // Viewport meta with viewport-fit=cover (and no user-scalable=no accessibility break)
  expect(html).toMatch(/<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1,\s*viewport-fit=cover">/);

  // 100dvh + --vv-height / --vv-top on .app
  expect(css).toMatch(/html,\s*body\s*\{[^}]*height:\s*100dvh[^}]*overscroll-behavior:\s*none/s);
  expect(css).toMatch(/\.app\s*\{[^}]*top:\s*var\(--vv-top,\s*0px\)[^}]*height:\s*100dvh[^}]*height:\s*var\(--vv-height,\s*100dvh\)/s);

  // Safe-area insets on .topbar, .dock, .hud-rail, and .sheet
  expect(css).toMatch(/\.topbar\s*\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/s);
  expect(css).toMatch(/\.dock\s*\{[^}]*env\(safe-area-inset-left\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-bottom\)/s);
  expect(css).toMatch(/\.hud-rail\s*\{[^}]*env\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/s);
  const touchBlock = css.match(/@media\s*\(max-width:\s*1023px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(touchBlock).toMatch(/\.hud-rail\s*\{[^}]*env\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/s);
  expect(css).toMatch(/\.sheet\s*\{[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-left\)/s);
  expect(collabCss).toMatch(/\.collab-picker\s*\{[^}]*env\(safe-area-inset-bottom\)/s);
  expect(collabCss).toMatch(/\.collab-pop\s*\{[^}]*env\(safe-area-inset-left\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-bottom\)/s);

  // Canvas touch-action: none
  expect(css).toMatch(/\.canvas\s*\{[^}]*touch-action:\s*none/s);
  expect(css).toMatch(/\.canvas\s+canvas\.board,\s*#board\s*\{[^}]*touch-action:\s*none/s);

  // @media (pointer: coarse): >= 16px input font-size and >= 44px touch targets
  const coarseBlock = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(coarseBlock).toContain("#ink");
  expect(coarseBlock).toContain("textarea.field");
  expect(coarseBlock).toContain("input.field");
  expect(coarseBlock).toMatch(/font-size:\s*16px/);
  expect(coarseBlock).toMatch(/min-width:\s*44px/);
  expect(coarseBlock).toMatch(/min-height:\s*44px/);
  expect(coarseBlock).toContain(".dock .tb");
  expect(coarseBlock).toContain(".reactions .tb");
  expect(coarseBlock).toContain(".sheet .tabs button");

  const collabCoarse = collabCss.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  expect(collabCoarse).toMatch(/\.collab-pop\s+textarea\.field[^}]*font-size:\s*16px/);
  expect(collabCoarse).toMatch(/\.collab-emotes\s+\.tb[^}]*min-width:\s*44px;\s*min-height:\s*44px/);

  // Phase 1 Unified --canvas-bottom Layout Contract & Breakpoint Standardization (all phone CSS unified on max-width: 640px)
  const homeCss = await Bun.file(new URL("../../web/home.css", import.meta.url)).text();
  const mp2Css = await Bun.file(new URL("../../web/styles/mobile-phase2.css", import.meta.url)).text();
  const mp34Css = await Bun.file(new URL("../../web/styles/mobile-phase3-4.css", import.meta.url)).text();
  expect(css).toContain("--safe-top:");
  expect(css).toContain("--safe-bottom:");
  expect(css).toContain("--dock-h:");
  expect(css).toContain("--hud-gap:");
  expect(css).toContain("--canvas-bottom:");
  expect(css).toMatch(/body\[data-workspace-mode="animate"\]\s*\{[^}]*--canvas-bottom:\s*var\(--hud-gap\)/s);
  expect(css).toMatch(/body\[data-workspace-mode="present"\]\s*\{[^}]*--canvas-bottom:\s*calc\(12px \+ var\(--safe-bottom\)\)/s);
  expect(css).toMatch(/body\[data-workspace-mode="present"\]\s*\.hud-bc\s*\{\s*display:\s*flex\s*!important;\s*\}/);
  expect(css).toContain("var(--canvas-bottom");
  expect(collabCss).toContain("var(--canvas-bottom");
  expect(mp2Css).toContain("var(--canvas-bottom");
  expect(css).not.toContain("@media (max-width: 639px)");
  expect(homeCss).not.toContain("@media (max-width: 639px)");
  expect(collabCss).not.toContain("@media (max-width: 639px)");
  expect(mp34Css).not.toContain("@media (max-width: 639px)");
  expect(mp34Css).toContain("@media (max-width: 640px)");
  // Editor topbar Chrome Diet on <640px + coarse pointer targets on timeline & clickable pill
  expect(css).toContain(".topbar .pill.connected { display: none; }");
  expect(css).toContain(".topbar .collab-avatars, .topbar .avatars { display: none; }");
  expect(css).toContain("body .topbar .phone-only.paste-btn { display: none !important; }");
  expect(coarseBlock).toContain(".timeline .c");
  expect(coarseBlock).toContain('.pill[role="button"]');
});

test("WebKit gesturestart, gesturechange, and gestureend call preventDefault() on board and canvas container", () => {
  const { board, canvasBox } = setupMobile();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    expect(board.fire(type).defaultPrevented).toBe(true);
    expect(canvasBox.fire(type).defaultPrevented).toBe(true);
  }
});

test("coarse pointer clamps #ink inline fontSize to at least 16px even when zoomed out", () => {
  const { S, ink, step } = setupMobile({ coarse: true });
  S.zoomAt(0.4, { x: 100, y: 100 });
  S.setTool("text");
  S.pointerDown({ x: 120, y: 120 });
  S.pointerUp({ x: 120, y: 120 });
  step(2);
  expect(ink.style.display).toBe("block");
  expect(parseFloat(ink.style.fontSize)).toBeGreaterThanOrEqual(16);
});

test("bottom sheet swipe-down-to-dismiss: past threshold & fast flick dismiss; short drag snaps back", () => {
  const { byId, app, net, step } = setupMobile({ token: "t-ada", phone: true, collab: true });
  const sheetEl = byId.sheet;

  // Open Notes/Comments sheet via combined Discuss dock button on narrow phone
  const discussBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("Discuss"));
  expect(discussBtn).toBeTruthy();
  discussBtn.click();
  step(2);
  expect(app.ui.sheet).toBe("notes");
  expect(sheetEl.hidden).toBe(false);

  // Grab handle exists inside .sheet
  const getHandle = () => find(sheetEl, e => e.className.split(/\s+/).includes("sheet-handle"));
  let handle = getHandle();
  expect(handle).toBeTruthy();
  expect(find(handle, e => e.className === "grab")).toBeTruthy();

  // 1) Short slow drag (30px over 200ms) -> snaps back, stays open
  handle.fire("pointerdown", { pointerId: 1, clientY: 400 });
  expect(sheetEl.classList.contains("dragging")).toBe(true);
  net.advance(200);
  handle.fire("pointermove", { pointerId: 1, clientY: 430 });
  expect(sheetEl.style.transform).toBe("translateY(30px)");
  handle.fire("pointerup", { pointerId: 1, clientY: 430 });
  expect(sheetEl.classList.contains("dragging")).toBe(false);
  expect(sheetEl.style.transform).toBe("");
  // A synthesized click right after a drag must not dismiss it
  handle.fire("click");
  step(2);
  expect(app.ui.sheet).toBe("notes");
  expect(sheetEl.hidden).toBe(false);

  // 2) Drag past threshold (> 72px -> 96px) -> dismisses
  handle = getHandle();
  handle.fire("pointerdown", { pointerId: 2, clientY: 400 });
  net.advance(150);
  handle.fire("pointermove", { pointerId: 2, clientY: 496 });
  expect(sheetEl.style.transform).toBe("translateY(96px)");
  handle.fire("pointerup", { pointerId: 2, clientY: 496 });
  step(2);
  expect(app.ui.sheet).toBe(null);
  expect(sheetEl.hidden).toBe(true);

  // 3) Fast downward flick (40px in 30ms -> 1.33 px/ms > 0.55) on Comments sheet -> dismisses
  discussBtn.click();
  step(2);
  const commentsTab = find(sheetEl, e => e.tagName === "BUTTON" && e.textContent.includes("Comments"));
  expect(commentsTab).toBeTruthy();
  commentsTab.click();
  step(2);
  expect(app.ui.sheet).toBe("comments");
  handle = getHandle();
  handle.fire("pointerdown", { pointerId: 3, clientY: 400 });
  net.advance(30);
  handle.fire("pointermove", { pointerId: 3, clientY: 440 });
  handle.fire("pointerup", { pointerId: 3, clientY: 440 });
  step(2);
  expect(app.ui.sheet).toBe(null);
  expect(sheetEl.hidden).toBe(true);

  // 4) pointercancel mid-drag snaps back cleanly without dismissing
  discussBtn.click();
  step(2);
  handle = getHandle();
  handle.fire("pointerdown", { pointerId: 4, clientY: 400 });
  handle.fire("pointermove", { pointerId: 4, clientY: 500 });
  handle.fire("pointercancel", { pointerId: 4, clientY: 500 });
  step(2);
  expect(app.ui.sheet).toBe("notes");
  expect(sheetEl.hidden).toBe(false);
  expect(sheetEl.style.transform).toBe("");
});

test("mobile layout invariants (<= 640px) for presenter, annotator, and viewer", () => {
  // Presenter
  {
    const { byId, app, S, step } = setupMobile({ token: "t-ada", phone: true, collab: true });
    expect(S.tool).toBe("hand");
    expect(find(byId.topbar, e => e.className === "board-name")?.textContent).toContain("mobile-board");
    expect(find(byId.topbar, e => /\bpill\b/.test(e.className))).toBeTruthy();
    expect(find(byId.topbar, e => /\bwatching\b/.test(e.className))).toBeTruthy();
    const overflow = find(byId.topbar, e => e.className.includes("overflow-btn") && e.className.includes("phone-only"));
    expect(overflow).toBeTruthy();
    const dockLabels = findAll(byId.dock, e => e.tagName === "BUTTON").map(b => b.textContent);
    expect(dockLabels.length).toBeLessThanOrEqual(7);
    expect(dockLabels.some(t => t.includes("Select"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Arrow"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Pen") || t.includes("Draw"))).toBe(false);
    expect(dockLabels.some(t => t.includes("More"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Discuss"))).toBe(true);
    overflow.click();
    step(2);
    expect(app.ui.sheet).toBe("tools");
    expect(byId.sheet.textContent).toContain("Mermaid");
    expect(byId.sheet.textContent).toContain("Export");
  }

  // Annotator
  {
    const { byId, app, S, step } = setupMobile({ token: "t-cy", phone: true, collab: true });
    expect(S.tool).toBe("hand");
    const dockLabels = findAll(byId.dock, e => e.tagName === "BUTTON").map(b => b.textContent);
    expect(dockLabels.some(t => t.includes("Note"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Highlight"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Arrow"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Style"))).toBe(true);
    const overflow = find(byId.topbar, e => e.className.includes("overflow-btn"));
    overflow.click();
    step(2);
    expect(app.ui.sheet).toBe("tools");
    expect(byId.sheet.textContent).not.toContain("Mermaid");
    expect(byId.sheet.textContent).toContain("Lock tool");
  }

  // Viewer
  {
    const { byId, app, step } = setupMobile({ token: "t-vi", phone: true, collab: true });
    expect(find(byId.topbar, e => e.className === "board-name")).toBeTruthy();
    expect(find(byId.topbar, e => /\bpill\b/.test(e.className))).toBeTruthy();
    expect(find(byId.topbar, e => /\bwatching\b/.test(e.className))).toBeTruthy();
    const overflow = find(byId.topbar, e => e.className.includes("overflow-btn"));
    expect(overflow).toBeTruthy();
    const dockLabels = findAll(byId.dock, e => e.tagName === "BUTTON").map(b => b.textContent);
    expect(dockLabels.some(t => t.includes("Prev"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Fit"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Next"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Notes"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Comments"))).toBe(true);
    expect(dockLabels.some(t => t.includes("Rect") || t.includes("Draw"))).toBe(false);
    overflow.click();
    step(2);
    expect(app.ui.sheet).toBe("tools");
    expect(byId.sheet.textContent).toContain("Hand");
    expect(byId.sheet.textContent).toContain("Dark");
    expect(byId.sheet.textContent).not.toContain("Lock tool");
    expect(byId.sheet.textContent).not.toContain("Mermaid");
  }
});

test("Wave 9B mobile shell integration: Settings hides Keybindings on phone, Views sheet has mobile attributes, Style sheet has touch-safe controls", () => {
  const { doc, byId, S, step } = setupMobile({ token: "t-ada", phone: true, coarse: true });

  // Open Settings from topbar menu on phone -> Keybindings tab is gated out, Preferences stay touch-friendly
  const settingsBtn = find(byId.topbar, e => e.attrs["aria-label"] === "Settings & keybindings");
  expect(settingsBtn).toBeTruthy();
  settingsBtn.click();
  step(2);
  const settingsModal = find(doc.body, e => e.classList.contains("settings-modal"));
  expect(settingsModal).toBeTruthy();
  expect(settingsModal.attrs["data-mobile-sheet"]).toBe("1");
  expect(find(settingsModal, e => e.attrs["data-settings-tab"] === "keybindings")).toBeUndefined();
  expect(find(settingsModal, e => e.attrs["data-pref-theme"] === "dark")).toBeTruthy();
  find(settingsModal, e => e.attrs["data-action"] === "close-settings").click();
  step(2);

  // Open Views navigator from topbar pill -> data-mobile-sheet="1" and 16px search input
  const viewsPill = find(byId.topbar, e => e.attrs["data-views-open"] === "1");
  expect(viewsPill).toBeTruthy();
  viewsPill.click();
  step(2);
  const viewsModal = find(doc.body, e => e.classList.contains("views-modal"));
  expect(viewsModal).toBeTruthy();
  expect(viewsModal.attrs["data-mobile-sheet"]).toBe("1");
  expect(parseFloat(find(viewsModal, e => e.classList.contains("views-search")).style.fontSize)).toBeGreaterThanOrEqual(16);
  find(viewsModal, e => e.attrs["aria-label"] === "Close views navigator").click();
  step(2);

  // Draw a rectangle, open Style sheet from dock -> Effects selects are 16px-safe & 44px touch targets
  S.setTool("rectangle");
  S.pointerDown({ x: 80, y: 80 });
  S.pointerMove({ x: 180, y: 150 });
  S.pointerUp({ x: 180, y: 150 });
  step(2);
  const styleBtn = find(byId.dock, e => e.tagName === "BUTTON" && e.textContent.includes("Style"));
  expect(styleBtn).toBeTruthy();
  styleBtn.click();
  step(2);
  const blendSel = find(byId.sheet, e => e.attrs["data-effect"] === "blendMode");
  expect(blendSel).toBeTruthy();
  expect(parseFloat(blendSel.style.fontSize)).toBeGreaterThanOrEqual(16);
  expect(parseFloat(blendSel.style.minHeight)).toBeGreaterThanOrEqual(44);
});
