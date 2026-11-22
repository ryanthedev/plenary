// Wave 2 Track A tests: Inline SVG iconography (#103), Custom Color Picker (#105),
// and Phone Undo/Redo + Contextual Selection Action Pill UX.
import { test, expect, afterAll } from "bun:test";
import { localRoom } from "../../web/adapters/transport/local.js";
import { createSession } from "../../web/core/session.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { mountApp } from "../../web/adapters/dom/app.js";
import { icon, ICONS } from "../../web/adapters/dom/icons.js";
import {
  hexToRgba, rgbaToHex, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb,
  parseColor, formatRgba, formatHsla,
  loadCustomSwatches, saveCustomSwatches, addCustomSwatch, removeCustomSwatch,
  MAX_CUSTOM_SWATCHES, createColorPicker, sampleCanvasPixel, cancelActiveSampler,
} from "../../web/adapters/dom/color-picker.js";

// ── Minimal stub DOM (mirrors ui-app.test.js / m5-mobile-ui.test.js) ──
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

class E extends N {
  constructor(tag, pixel = [21, 127, 61, 255]) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollTop = 0;
    this.width = 390;
    this.height = 844;
    this._pixel = pixel;
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: c => self.classList.toggle(c, true),
      remove: c => self.classList.toggle(c, false),
      toggle: (c, on) => {
        const s = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on ?? !s.has(c)) s.add(c); else s.delete(c);
        self.className = [...s].join(" ");
      },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] ?? []).filter(f => f !== fn); }
  fire(t, ev = {}) {
    const e = { target: this, currentTarget: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...ev };
    for (const fn of [...(this.listeners[t] ?? [])]) fn(e);
    return e;
  }
  click() { if (!this.disabled) return this.fire("click"); }
  focus() {} blur() {} setPointerCapture() {} setSelectionRange() {} select() {}
  after(n) { this.parentNode.append(n); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest() { return null; }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.removeChild(this); n.parentNode?.removeChild(n); n.parentNode = p; p.childNodes.splice(i, 0, n); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height }; }
  getContext() {
    const pixel = this._pixel;
    const CTX = {
      measureText: t => ({ width: String(t).length * 7 }),
      getImageData: () => ({ data: new Uint8ClampedArray(pixel) }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
    };
    return new Proxy({}, { get: (_, k) => (k in CTX ? CTX[k] : () => {}), set: () => true });
  }
  get children() { return this.childNodes.filter(c => c.nodeType === 1); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
}

const IDS = ["topbar", "panel", "drawer", "timeline", "hudBL", "hudBC", "hudBR", "dock", "sheet", "dialogs", "overlays", "veil", "toast", "picker"];
const GLOBALS = ["document", "Node", "devicePixelRatio", "matchMedia", "ResizeObserver", "requestAnimationFrame", "addEventListener", "removeEventListener", "EyeDropper"];
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

function setupApp({ token = "t-ada", phone = false, withNS = false, prefs = memoryStore() } = {}) {
  let frames = [];
  const winL = {}, docL = {};
  const body = new E("body"), main = new E("div"), canvasBox = new E("div"), board = new E("canvas"), ink = new E("textarea");
  main.className = "main"; body.append(main); main.append(canvasBox); canvasBox.append(board, ink);
  const byId = { canvas: canvasBox, board, ink };
  for (const id of IDS) { byId[id] = new E(id === "picker" ? "input" : "div"); body.append(byId[id]); }
  const doc = {
    body, documentElement: new E("html"), activeElement: null, visibilityState: "visible",
    createElement: t => new E(t),
    createTextNode: t => new T(t),
    ...(withNS ? { createElementNS: (ns, t) => { const el = new E(t); el.namespaceURI = ns; return el; } } : {}),
    querySelector: s => (s === ".main" ? main : s.startsWith("#") ? byId[s.slice(1)] ?? null : null),
    addEventListener: (t, fn) => { (docL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { docL[t] = (docL[t] ?? []).filter(f => f !== fn); },
    fire(t, ev = {}) {
      const e = {
        target: board,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() { this.immediatePropagationStopped = true; },
        ...ev,
      };
      for (const fn of [...(docL[t] ?? [])]) fn(e);
      return e;
    },
  };
  Object.assign(globalThis, {
    document: doc, Node: N, devicePixelRatio: 2,
    matchMedia: q => ({ matches: q.includes("max-width: 640px") ? phone : q.includes("pointer: coarse") ? phone : false, addEventListener() {} }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn([]); } },
    requestAnimationFrame: fn => frames.push(fn),
    addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
    removeEventListener: (t, fn) => { winL[t] = (winL[t] ?? []).filter(f => f !== fn); },
  });
  delete globalThis.EyeDropper;

  const net = localRoom({ board: "b-redesign", users: USERS, clock: true });
  const app = mountApp({
    startSession: ({ mine, onChange }) => createSession({ join: () => net.join(), token, board: "b-redesign", client: USERS[token].user, user: USERS[token].user, mine, onChange, clock: net.clock }),
    net: { kind: "local", put() {}, onFile() {} },
    board: "b-redesign",
    me: { user: USERS[token].user, name: "Ada", role: null },
    prefs,
    theme: "light",
    clock: net.clock,
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
  return { doc, byId, board, app, S: app.S, net, step, prefs };
}

const find = (root, pred) => root.all().find(pred);
const findAll = (root, pred) => root.all().filter(pred);
const RAW_UNICODE_GLYPHS = /[▭◇○◯↗—✎▢🖼📝✦↖✋☀☾↩↪↶↷✕❏⊡▰◧⋯⤓⤢🔒🔓◉▤⊟⚙⌫💬]/;

// ── 1. Inline SVG Iconography (#103) ──

test("SVG icons: every desktop toolbar and mobile dock/sheet tool renders an <svg> with zero raw Unicode tool glyphs", () => {
  const { byId } = setupApp({ phone: false, withNS: true });

  // Every tool button in #topbar renders an <svg> with standard 24x24 stroke spec
  const topbarButtons = findAll(byId.topbar, e => e.tagName === "BUTTON");
  expect(topbarButtons.length).toBeGreaterThan(15);
  for (const btn of topbarButtons) {
    const svg = find(btn, e => e.tagName === "SVG");
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(RAW_UNICODE_GLYPHS.test(btn.textContent)).toBe(false);
  }

  // Mobile dock + tools sheet also render <svg> icons with zero raw Unicode glyphs
  const mobile = setupApp({ phone: true, withNS: false });
  const dockButtons = findAll(mobile.byId.dock, e => e.tagName === "BUTTON");
  expect(dockButtons.length).toBeGreaterThan(4);
  for (const btn of dockButtons) {
    const svg = find(btn, e => e.tagName === "SVG");
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(RAW_UNICODE_GLYPHS.test(btn.textContent)).toBe(false);
  }

  // Open mobile tools sheet and verify every tool button uses <svg>
  const overflow = find(mobile.byId.topbar, e => e.className.includes("overflow-btn"));
  overflow.click();
  mobile.step(2);
  const sheetButtons = findAll(mobile.byId.sheet, e => e.tagName === "BUTTON");
  expect(sheetButtons.length).toBeGreaterThan(10);
  for (const btn of sheetButtons) {
    const svg = find(btn, e => e.tagName === "SVG");
    expect(svg).toBeTruthy();
    expect(RAW_UNICODE_GLYPHS.test(btn.textContent)).toBe(false);
  }

  // Verify every declared icon key builds cleanly with stub fallback, and prototype keys fall back safely
  for (const name of Object.keys(ICONS)) {
    const el = icon(name);
    expect(el.tagName).toBe("SVG");
    expect(el.getAttribute("data-icon")).toBe(name);
    expect(el.children.length).toBeGreaterThan(0);
  }
  for (const protoKey of ["toString", "constructor", "__proto__"]) {
    const el = icon(protoKey);
    expect(el.tagName).toBe("SVG");
    expect(el.children.length).toBeGreaterThan(0);
  }
});

// ── 2. Custom Color Picker (#105) ──

test("Color conversions: exact Hex <-> RGB <-> HSL <-> HSV and invalid input handling", () => {
  // Hex <-> RGBA
  expect(hexToRgba("#3B48E8")).toEqual({ r: 59, g: 72, b: 232, a: 1 });
  expect(hexToRgba("#f0a")).toEqual({ r: 255, g: 0, b: 170, a: 1 });
  expect(hexToRgba("#3b48e880")).toEqual({ r: 59, g: 72, b: 232, a: 0.502 });
  expect(hexToRgba("18181b")).toEqual({ r: 24, g: 24, b: 27, a: 1 });
  expect(rgbaToHex({ r: 59, g: 72, b: 232, a: 1 })).toBe("#3b48e8");
  expect(rgbaToHex({ r: 59, g: 72, b: 232, a: 0.5 })).toBe("#3b48e880");
  expect(rgbaToHex({ r: 255, g: 255, b: 255, a: 1 }, true)).toBe("#ffffffff");

  // RGB <-> HSL
  expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });
  expect(rgbToHsl(0, 255, 0)).toEqual({ h: 120, s: 100, l: 50 });
  expect(rgbToHsl(0, 0, 255)).toEqual({ h: 240, s: 100, l: 50 });
  expect(rgbToHsl(59, 72, 232)).toEqual({ h: 235, s: 79, l: 57 });
  expect(hslToRgb(0, 100, 50)).toEqual({ r: 255, g: 0, b: 0 });
  expect(hslToRgb(120, 100, 50)).toEqual({ r: 0, g: 255, b: 0 });
  expect(hslToRgb(240, 100, 50)).toEqual({ r: 0, g: 0, b: 255 });
  expect(hslToRgb(360, 100, 50)).toEqual({ r: 255, g: 0, b: 0 });

  // RGB <-> HSV
  expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 100, v: 100 });
  expect(rgbToHsv(59, 72, 232)).toEqual({ h: 235, s: 75, v: 91 });
  expect(hsvToRgb(0, 100, 100)).toEqual({ r: 255, g: 0, b: 0 });
  expect(hsvToRgb(235, 75, 91)).toEqual({ r: 58, g: 73, b: 232 });
  expect(hsvToRgb(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });

  // parseColor + formatRgba + formatHsla
  expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  expect(parseColor("rgb(59, 72, 232)")).toEqual({ r: 59, g: 72, b: 232, a: 1 });
  expect(parseColor("rgba(59, 72, 232, 0.5)")).toEqual({ r: 59, g: 72, b: 232, a: 0.5 });
  expect(parseColor("hsl(120, 100%, 50%)")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
  expect(parseColor("hsla(240, 100%, 50%, 50%)")).toEqual({ r: 0, g: 0, b: 255, a: 0.5 });
  expect(formatRgba({ r: 59, g: 72, b: 232, a: 1 })).toBe("rgb(59, 72, 232)");
  expect(formatRgba({ r: 59, g: 72, b: 232, a: 0.5 })).toBe("rgba(59, 72, 232, 0.5)");
  expect(formatHsla({ h: 235, s: 79, l: 57, a: 1 })).toBe("hsl(235, 79%, 57%)");
  expect(formatHsla({ h: 235, s: 79, l: 57, a: 0.25 })).toBe("hsla(235, 79%, 57%, 0.25)");

  // Invalid inputs return null cleanly
  for (const bad of ["", "not-a-color", "#12", "#zzzzzz", "rgb(300, 0, 0)", "rgb(1, 2)", "hsl(10, 150%, 50%)", null, undefined, 42]) {
    expect(parseColor(bad)).toBe(null);
  }
  expect(hexToRgba("#12345")).toBe(null);
});

test("Custom Color Picker: saved custom swatches persist via memoryStore, dedupe, bound to max 16, and survive unavailable storage", () => {
  const store = memoryStore();
  expect(loadCustomSwatches(store)).toEqual([]);

  addCustomSwatch(store, "#3B48E8");
  addCustomSwatch(store, "#157F3D");
  addCustomSwatch(store, "#3b48e8"); // deduped & moved to front
  expect(loadCustomSwatches(store)).toEqual(["#3b48e8", "#157f3d"]);

  removeCustomSwatch(store, "#157F3D");
  expect(loadCustomSwatches(store)).toEqual(["#3b48e8"]);

  // Bounding to MAX_CUSTOM_SWATCHES (16)
  for (let i = 0; i < 24; i++) {
    addCustomSwatch(store, `#${i.toString(16).padStart(2, "0")}4488`);
  }
  expect(loadCustomSwatches(store).length).toBe(MAX_CUSTOM_SWATCHES);

  // Unavailable storage never throws
  const broken = memoryStore({ unavailable: true });
  expect(() => saveCustomSwatches(broken, ["#112233"])).not.toThrow();
  expect(loadCustomSwatches(broken)).toEqual([]);
});

test("Custom Color Picker: EyeDropper API path AND canvas pixel-sampling fallback with capture/stopImmediatePropagation + pointerup swallow", async () => {
  const { doc, board, prefs } = setupApp({ phone: false });
  const emitted = [];

  // 1) Native EyeDropper API path
  globalThis.EyeDropper = class {
    async open() { return { sRGBHex: "#ea580c" }; }
  };
  const pickerNative = createColorPicker({
    value: "#3b48e8",
    prefs,
    canvas: board,
    onChange: c => emitted.push(c),
  });
  const dropBtn1 = find(pickerNative, e => e.classList.contains("cp-eyedrop"));
  await dropBtn1.click();
  expect(emitted).toEqual(["#ea580c"]);

  // 2) Canvas pixel-sampling fallback when EyeDropper is unavailable (iOS Chrome / Safari)
  delete globalThis.EyeDropper;
  board._pixel = [21, 127, 61, 255]; // #157f3d
  expect(sampleCanvasPixel(board, 100, 100)).toBe("#157f3d");

  const pickerFallback = createColorPicker({
    value: "#3b48e8",
    prefs,
    canvas: board,
    onChange: c => emitted.push(c),
  });
  const dropBtn2 = find(pickerFallback, e => e.classList.contains("cp-eyedrop"));
  await dropBtn2.click();
  expect(dropBtn2.classList.contains("on")).toBe(true);

  const pickEv = doc.fire("pointerdown", { target: board, clientX: 50, clientY: 60 });
  expect(pickEv.defaultPrevented).toBe(true);
  expect(pickEv.propagationStopped).toBe(true);
  expect(pickEv.immediatePropagationStopped).toBe(true);
  expect(dropBtn2.classList.contains("on")).toBe(false);
  expect(emitted[emitted.length - 1]).toBe("#157f3d");

  // Matching pointerup is also swallowed so canvas never sees a stray release
  const upEv = doc.fire("pointerup", { target: board, clientX: 50, clientY: 60 });
  expect(upEv.defaultPrevented).toBe(true);
  expect(upEv.immediatePropagationStopped).toBe(true);

  // Subsequent pointerup after swallow is NOT intercepted
  const nextUp = doc.fire("pointerup", { target: board, clientX: 50, clientY: 60 });
  expect(nextUp.immediatePropagationStopped).toBeUndefined();

  // Escape cancels sampling and calls stopImmediatePropagation
  await dropBtn2.click();
  expect(dropBtn2.classList.contains("on")).toBe(true);
  const escEv = doc.fire("keydown", { key: "Escape" });
  expect(escEv.immediatePropagationStopped).toBe(true);
  expect(dropBtn2.classList.contains("on")).toBe(false);

  // cancelActiveSampler cleans up active sampling listeners on rebuild/close
  await dropBtn2.click();
  expect(dropBtn2.classList.contains("on")).toBe(true);
  cancelActiveSampler();
  expect(dropBtn2.classList.contains("on")).toBe(false);
  const afterCancel = doc.fire("pointerdown", { target: board, clientX: 50, clientY: 60 });
  expect(afterCancel.immediatePropagationStopped).toBeUndefined();

  // 3) Interactive format toggle (HEX -> RGB -> HSL) and saved swatch UI
  const rgbBtn = find(pickerFallback, e => e.getAttribute("data-mode") === "rgb");
  const hslBtn = find(pickerFallback, e => e.getAttribute("data-mode") === "hsl");
  const input = find(pickerFallback, e => e.classList.contains("cp-input"));
  rgbBtn.click();
  expect(input.value).toBe("rgb(21, 127, 61)");
  hslBtn.click();
  expect(input.value).toMatch(/^hsl\(/);

  // Invalid text flags .cp-invalid without emitting garbage
  const beforeLen = emitted.length;
  input.value = "not-valid";
  input.fire("change");
  expect(input.classList.contains("cp-invalid")).toBe(true);
  expect(emitted.length).toBe(beforeLen);

  // Save custom swatch button persists into prefs
  const addBtn = find(pickerFallback, e => e.classList.contains("cp-swatch-add"));
  addBtn.click();
  expect(loadCustomSwatches(prefs)).toContain("#157f3d");
});

test("Custom Color Picker: SV pad drag & sliders commit ONCE on release/change (no undo flood) and preserve Hue + mode across rebuilds", () => {
  const { prefs, board } = setupApp({ phone: false });
  const commits = [];
  const pickerState = { h: null, mode: "hex" };

  const picker1 = createColorPicker({
    value: "#3b48e8",
    prefs,
    canvas: board,
    pickerState,
    onChange: c => commits.push(c),
  });

  // Switch to RGB mode and adjust Hue to 210 via input (preview only, 0 commits)
  find(picker1, e => e.getAttribute("data-mode") === "rgb").click();
  expect(pickerState.mode).toBe("rgb");

  const hueSlider = find(picker1, e => e.classList.contains("cp-hue"));
  hueSlider.value = "210";
  hueSlider.fire("input");
  expect(commits.length).toBe(0);
  expect(pickerState.h).toBe(210);
  hueSlider.fire("change");
  expect(commits.length).toBe(1);

  // Multi-step SV pad drag: pointerdown + 5 pointermoves + pointerup => exactly 1 commit!
  const svBox = find(picker1, e => e.classList.contains("cp-sv-box"));
  svBox.width = 200;
  svBox.height = 100;
  svBox.fire("pointerdown", { pointerId: 1, clientX: 100, clientY: 50 });
  for (let i = 1; i <= 5; i++) {
    svBox.fire("pointermove", { pointerId: 1, clientX: 100 - i * 20, clientY: 50 + i * 10 });
  }
  expect(commits.length).toBe(1); // still only the hue commit; 0 commits during drag
  svBox.fire("pointerup", { pointerId: 1, clientX: 0, clientY: 100 }); // bottom-left = black (#000000)
  expect(commits.length).toBe(2);
  expect(commits[1]).toBe("#000000");

  // Rebuild picker with the new achromatic value (#000000) and shared pickerState:
  // Hue stays 210 (not snapped to 0/red) and mode stays "rgb" (not reset to "hex")!
  const picker2 = createColorPicker({
    value: "#000000",
    prefs,
    canvas: board,
    pickerState,
    onChange: c => commits.push(c),
  });
  expect(find(picker2, e => e.classList.contains("cp-hue")).value).toBe("210");
  expect(find(picker2, e => e.getAttribute("data-mode") === "rgb").classList.contains("on")).toBe(true);
  expect(find(picker2, e => e.classList.contains("cp-input")).value).toBe("rgb(0, 0, 0)");
});

// ── 3. Phone UX: Always-visible Undo/Redo Pill & Contextual Selection Action Pill ──

test("Phone UX: always-visible Undo/Redo pill for presenter & annotator (hidden for viewer) reflects canUndo/canRedo and executes undo/redo", () => {
  // Presenter: pill present, disabled initially, enables after drawing, undo & redo work
  {
    const { byId, S, step } = setupApp({ token: "t-ada", phone: true });
    const getPill = () => find(byId.hudBL, e => e.classList.contains("phone-undo-pill"));
    const getUndo = () => find(getPill(), e => e.getAttribute("data-action") === "undo");
    const getRedo = () => find(getPill(), e => e.getAttribute("data-action") === "redo");

    expect(getPill()).toBeTruthy();
    expect(getUndo().disabled).toBe(true);
    expect(getRedo().disabled).toBe(true);

    // Draw a rectangle -> Undo enables, Redo stays disabled
    S.setTool("rectangle");
    S.pointerDown({ x: 60, y: 80 });
    S.pointerMove({ x: 180, y: 160 });
    S.pointerUp({ x: 180, y: 160 });
    step(20);
    expect(S.eds.board.doc.live().length).toBe(1);
    expect(getUndo().disabled).toBe(false);
    expect(getRedo().disabled).toBe(true);

    // Tap Undo -> shape disappears, Undo disables, Redo enables
    getUndo().click();
    step(20);
    expect(S.eds.board.doc.live().length).toBe(0);
    expect(getUndo().disabled).toBe(true);
    expect(getRedo().disabled).toBe(false);

    // Tap Redo -> shape returns
    getRedo().click();
    step(20);
    expect(S.eds.board.doc.live().length).toBe(1);
    expect(getUndo().disabled).toBe(false);
    expect(getRedo().disabled).toBe(true);
  }

  // Annotator: pill present & works on notes stream
  {
    const { byId, S, step } = setupApp({ token: "t-cy", phone: true });
    const pill = find(byId.hudBL, e => e.classList.contains("phone-undo-pill"));
    expect(pill).toBeTruthy();
    S.placeNote({ x: 100, y: 100 }, "mobile note");
    step(20);
    const before = S.eds.notes.doc.live().length;
    expect(before).toBeGreaterThan(0);
    const undo = find(byId.hudBL, e => e.getAttribute("data-action") === "undo");
    expect(undo.disabled).toBe(false);
    undo.click();
    step(20);
    expect(S.eds.notes.doc.live().length).toBeLessThan(before);
    const redo = find(byId.hudBL, e => e.getAttribute("data-action") === "redo");
    expect(redo.disabled).toBe(false);
    redo.click();
    step(20);
    expect(S.eds.notes.doc.live().length).toBe(before);
  }

  // Viewer: NO Undo/Redo pill rendered
  {
    const { byId } = setupApp({ token: "t-vi", phone: true });
    expect(find(byId.hudBL, e => e.classList.contains("phone-undo-pill"))).toBeFalsy();
  }
});

test("Phone UX: contextual selection pill appears on selection and Color / Duplicate / Delete actions work", () => {
  const { byId, S, app, step } = setupApp({ token: "t-ada", phone: true });
  const getSelPill = () => find(byId.hudBL, e => e.classList.contains("phone-sel-pill"));

  // Hidden when nothing is selected
  expect(getSelPill()).toBeFalsy();

  // Draw & select a rectangle -> contextual selection pill appears
  S.setTool("rectangle");
  S.pointerDown({ x: 40, y: 60 });
  S.pointerMove({ x: 160, y: 140 });
  S.pointerUp({ x: 160, y: 140 });
  step(20);

  const selPill = getSelPill();
  expect(selPill).toBeTruthy();
  const colorBtn = find(selPill, e => e.getAttribute("data-action") === "color");
  const dupBtn = find(selPill, e => e.getAttribute("data-action") === "duplicate");
  const delBtn = find(selPill, e => e.getAttribute("data-action") === "delete");
  expect(colorBtn).toBeTruthy();
  expect(dupBtn).toBeTruthy();
  expect(delBtn).toBeTruthy();

  // 1) Color opens Style sheet with Custom Color Picker mounted
  colorBtn.click();
  step(2);
  expect(app.ui.sheet).toBe("panel");
  expect(app.ui.colorPicker).toBe("strokeColor");
  expect(find(byId.sheet, e => e.getAttribute("data-component") === "color-picker")).toBeTruthy();

  // 2) Duplicate clones selected shape
  const beforeCount = S.eds.board.doc.live().length;
  dupBtn.click();
  step(20);
  expect(S.eds.board.doc.live().length).toBe(beforeCount + 1);

  // 3) Delete removes the selected duplicate
  const delBtn2 = find(getSelPill(), e => e.getAttribute("data-action") === "delete");
  delBtn2.click();
  step(20);
  expect(S.eds.board.doc.live().length).toBe(beforeCount);
  expect(getSelPill()).toBeFalsy(); // selection cleared -> pill hides
});
