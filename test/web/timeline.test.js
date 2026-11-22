import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Editor } from "../../packages/core/editor.js";
import { timelineSpans, PRESET_CATEGORIES, EASING_NAMES } from "../../packages/core/anim.js";
import { buildTimeline, updateTimelineInPlace } from "../../web/adapters/dom/timeline.js";
import { renderPanel } from "../../web/adapters/dom/panel.js";
import { defaultPanel } from "../../packages/core/panel.js";

class StubNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.style = {};
    this.attrs = {};
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this.value = "";
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, ev = {}) {
    let prevented = false, stopped = false;
    const e = {
      currentTarget: this,
      target: this,
      get defaultPrevented() { return prevented; },
      get propagationStopped() { return stopped; },
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
      ...ev,
    };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
  closest(sel) {
    if (sel === ".span" && this.className.split(" ").includes("span")) return this;
    return this.parentNode?.closest?.(sel) ?? null;
  }
  contains(node) {
    for (let p = node; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  focus() { if (globalThis.document) globalThis.document.activeElement = this; }
  append(...nodes) { for (const n of nodes) { if (n instanceof StubNode) n.parentNode = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 22 }; }
  all(out = []) {
    out.push(this);
    for (const c of this.children) if (c instanceof StubNode) c.all(out);
    return out;
  }
}

let prevDoc, prevNode;
beforeEach(() => {
  prevDoc = globalThis.document;
  prevNode = globalThis.Node;
  globalThis.Node = StubNode;
  globalThis.document = {
    createElement: tag => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag),
    createTextNode: txt => { const n = new StubNode("#text"); n.textContent = String(txt); return n; },
  };
});
afterEach(() => {
  globalThis.document = prevDoc;
  globalThis.Node = prevNode;
});

const h = (tag, attrs = {}, ...kids) => {
  const [name, ...cls] = tag.split(".");
  const el = document.createElement(name || "div");
  if (cls.length) el.className = cls.filter(Boolean).join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") el.value = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof StubNode ? k : document.createTextNode(String(k)));
  return el;
};
const replace = (el, ...kids) => {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false).map(k => (k instanceof StubNode ? k : document.createTextNode(String(k)))));
  return el;
};

describe("timeline DOM adapter", () => {
  test("renders controls, spans, mm:ss.t readout, loop toggle, speed selector, and reduced motion badge", () => {
    let now = 0;
    const B = new Editor({
      scene: {
        elements: [
          { id: "r1", type: "rectangle", x: 0, y: 0, width: 100, height: 60, customData: { anim: { preset: "fade", start: 0, duration: 600 } } },
          { id: "r2", type: "rectangle", x: 150, y: 0, width: 100, height: 60, customData: { anim: { preset: "draw", start: 400, duration: 800 } } },
        ],
      },
      clock: () => now,
    });
    const root = new StubNode("footer");
    const tl = { fill: null, head: null, text: null, track: null, sig: "" };
    let changes = 0;
    const spans = timelineSpans(B.doc.live());
    buildTimeline(root, {
      board: B,
      dur: B.duration(),
      marks: [0, 400],
      spans,
      tl,
      h,
      replace,
      onChange: () => { changes++; },
      reducedMotion: true,
    });

    const nodes = root.all();
    expect(tl.text.textContent).toBe("00:00.0 / 00:01.2");
    expect(nodes.filter(n => n.className.startsWith("span ")).length).toBe(2);
    expect(nodes.filter(n => n.className === "mark").length).toBe(2);
    expect(nodes.some(n => n.className === "tl-rm")).toBe(true);

    // Loop toggle
    const loopBtn = nodes.find(n => n.className.includes("tl-loop"));
    expect(loopBtn.attrs["data-loop"]).toBe("off");
    loopBtn.fire("click");
    expect(B.playLoop).toBe(true);

    // Speed selector
    const speedSel = nodes.find(n => n.className === "tl-speed");
    expect(speedSel.children.length).toBe(4);
    speedSel.value = "1.5";
    speedSel.fire("change");
    expect(B.playSpeed).toBe(1.5);

    // Click scrubber at 50% (clientX = 100 on 200px track -> 600ms)
    tl.track.fire("click", { clientX: 100 });
    expect(B.time()).toBe(600);
    updateTimelineInPlace(tl, B, B.duration());
    expect(tl.text.textContent).toBe("00:00.6 / 00:01.2");
    expect(tl.head.style.left).toBe("50%");

    // Keyboard scrubbing on track
    tl.track.fire("keydown", { key: "ArrowRight" });
    expect(B.time()).toBe(700);
    tl.track.fire("keydown", { key: "Home" });
    expect(B.time()).toBe(0);
    tl.track.fire("keydown", { key: "End" });
    expect(B.time()).toBe(1200);

    // Clicking a span selects the element and seeks to its start
    const span2 = nodes.find(n => n.attrs["data-anim-id"] === "r2");
    span2.fire("click");
    expect(B.sel.has("r2")).toBe(true);
    expect(B.time()).toBe(400);
    expect(changes).toBeGreaterThan(0);
  });

  test("Animate panel renders grouped preset categories and timing controls for selected animated shape", () => {
    const B = new Editor({
      scene: {
        elements: [
          { id: "r1", type: "rectangle", x: 0, y: 0, width: 100, height: 60, customData: { anim: { preset: "zoom-in", start: 150, duration: 700, easing: "spring" } } },
        ],
      },
    });
    B.select(["r1"]);
    const session = {
      role: "presenter",
      active: "board",
      may: () => true,
      eds: { board: B, notes: new Editor() },
      act: (_stream, fn) => fn(B),
    };
    const root = new StubNode("aside");
    const out = renderPanel(root, {
      session,
      state: defaultPanel(),
      setState: () => {},
      h,
      onChange: () => {},
    });
    replace(root, out);
    const all = root.all();
    const groups = all.filter(n => n.className === "anim-group");
    expect(groups.map(g => g.attrs["data-category"])).toEqual(PRESET_CATEGORIES.map(c => c.id));

    const easingSel = all.find(n => n.className === "anim-sel");
    expect(easingSel).toBeDefined();
    expect(easingSel.children.length).toBe(EASING_NAMES.length);
    easingSel.value = "bounce";
    easingSel.fire("change");
    expect(B.doc.get("r1").customData.anim.easing).toBe("bounce");
  });

  test("H1/H2/M4/L1: track keyboard scrubbing stops propagation, keeps focus, and pointerdown on span selects without capture", () => {
    const B = new Editor({
      scene: {
        elements: [
          { id: "r1", type: "rectangle", x: 50, y: 50, width: 100, height: 60, customData: { anim: { preset: "fade", start: 0, duration: 600 } } },
          { id: "r2", type: "rectangle", x: 200, y: 50, width: 100, height: 60, customData: { anim: { preset: "draw", start: 500, duration: 500 } } },
        ],
      },
    });
    B.select(["r1"]);
    const root = new StubNode("footer");
    const tl = { fill: null, head: null, text: null, track: null, sig: "" };
    let structuralRebuilds = 0;
    const render = () => {
      structuralRebuilds++;
      buildTimeline(root, {
        board: B,
        dur: B.duration(),
        marks: [0, 500],
        spans: timelineSpans(B.doc.live()),
        tl,
        h,
        replace,
        onChange: render,
      });
    };
    render();
    expect(structuralRebuilds).toBe(1);

    // Focus track and press ArrowRight twice: stays focused, 0 rebuilds, stops propagation, shape x unchanged
    const track0 = tl.track;
    track0.focus();
    const ev1 = track0.fire("keydown", { key: "ArrowRight" });
    const ev2 = track0.fire("keydown", { key: "ArrowRight" });
    expect(ev1.defaultPrevented).toBe(true);
    expect(ev1.propagationStopped).toBe(true);
    expect(ev2.propagationStopped).toBe(true);
    expect(B.time()).toBe(200);
    expect(structuralRebuilds).toBe(1);
    expect(tl.track).toBe(track0);
    expect(document.activeElement).toBe(track0);
    expect(B.doc.get("r1").x).toBe(50);

    // Space on track rebuilds (play icon) AND restores focus to the new track node
    const evSpace = track0.fire("keydown", { key: " " });
    expect(evSpace.propagationStopped).toBe(true);
    expect(structuralRebuilds).toBe(2);
    expect(document.activeElement).toBe(tl.track);

    // M4: pointerdown on a .span selects & seeks without calling setPointerCapture on track
    let captured = false;
    tl.track.setPointerCapture = () => { captured = true; };
    const span2 = root.all().find(n => n.attrs["data-anim-id"] === "r2");
    tl.track.fire("pointerdown", { target: span2, button: 0, pointerId: 1, clientX: 150 });
    expect(captured).toBe(false);
    expect(B.sel.has("r2")).toBe(true);
    expect(B.time()).toBe(500);

    // L1: lostpointercapture clears dragging cleanly
    tl.track.fire("pointerdown", { target: tl.track, button: 0, pointerId: 2, clientX: 40 });
    expect(B.time()).toBe(200);
    tl.track.fire("lostpointercapture", { pointerId: 2 });
    tl.track.fire("pointermove", { pointerId: 2, clientX: 180 });
    expect(B.time()).toBe(200); // did not move after lostpointercapture
  });
});
