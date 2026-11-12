// p7-perfv: tests aimed at the surviving mutants. Each must pass on the builder's code.
import { test, expect } from "bun:test";
import { busyBoard, countingDom, panView, frameState, createFakePort } from "./perf-fixture.js";
import { mountCollab } from "../../../web/adapters/dom/collab/ui.js";
import { collabFrame } from "../../../web/adapters/dom/collab/frame.js";

const me = { user: "me", name: "Me", client: "me-1" };
const clk = () => { let m = 0; const q = []; return { now: () => m, mono: () => m, random: () => 0.3, set: (fn, ms) => { const h = { at: m + ms, fn }; q.push(h); return h; }, clear: h => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } }; };
const th = (id, anchor, text = "x") => ({ id, by: "u", name: "U", at: 1, anchor, comments: [{ id: `c${id}`, by: "u", name: "U", at: 1, text }] });
function mount(board, o = {}) {
  const dom = countingDom(), view = panView();
  let port = createFakePort({ role: o.role ?? "editor", me, threads: board.threads, elements: board.elements ?? {}, notes: board.notes ?? [] });
  if (o.wrap) port = o.wrap(port);
  const collab = mountCollab({ root: dom.root, port, view, clock: clk(), frame: () => {}, pinCap: o.pinCap });
  const S = frameState(view); S.eds.board.doc = { rev: 1 }; S.eds.notes.doc = { rev: 1 };
  const tick = collabFrame(S, collab); tick();
  const pins = () => dom.root.findAll(e => e.hasClass("pin") && !e.hasClass("cluster"));
  const pin = id => pins().find(p => p.getAttribute("data-thread") === id);
  return { dom, view, port, collab, S, tick, pins, pin };
}

test("K15 zoom in only: pins re-placed at the new scale", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  m.view.v.scale = 2; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("200px");
  expect(m.dom.root.find(e => e.hasClass("collab-pins")).style.getPropertyValue("transform")).toBe("");
});

test("K17 a port whose records() is one object mutated in place still shows a new thread (D2)", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] }, { wrap: p => {
    const stable = { threads: [], pending: [] }, orig = p.records.bind(p);
    p.records = () => { const r = orig(); stable.threads.length = 0; stable.threads.push(...r.threads); stable.pending = r.pending; return stable; };
    return p;
  } });
  m.port.remote({ do: "thread", id: "b", anchor: { point: { x: 200, y: 100 } }, text: "new" }, "u2", "U2");
  expect(!!m.pin("b")).toBe(true);
});

test("K19 a role change (editor to viewer) hides the open popover's reply box", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  m.collab.openThread("a");
  const field = () => m.dom.root.find(e => e.tagName === "TEXTAREA");
  expect(field().parentNode.hidden).toBe(false);
  m.port.setStatus("live", "viewer");
  expect(field().parentNode.hidden).toBe(true);
});

test("K22 notes tab, then back to comments with no records change: the comment rows come back", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })], notes: [{ id: "n1", type: "rectangle", x: 0, y: 0, width: 1, height: 1, updated: 1 }] });
  const rows = () => m.collab.parts.drawer.findAll(e => e.hasClass("thread-row")).length;
  expect(rows()).toBe(1);
  m.collab.showDrawer("notes"); m.collab.showDrawer("comments");
  expect(rows()).toBe(1);
});

test("K23 a thread on a NOTES element follows it when only the notes doc's rev moves", () => {
  const m = mount({ threads: [th("a", { stream: "notes", element: "n", x: 80, y: 0 })], elements: { "notes:n": { x: 0, y: 0, width: 80, height: 40 } } });
  expect(m.pin("a").style.getPropertyValue("left")).toBe("80px");
  m.port.setElement("notes", "n", { x: 300, y: 0, width: 80, height: 40 });
  m.S.eds.notes.doc.rev = 2; m.S.v++; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("380px");
});

test("K25 opening a clustered thread (no view change) makes it a pin", () => {
  const T = Array.from({ length: 50 }, (_, i) => th(`t${i}`, { point: { x: 100 + (i % 2), y: 100 } }));
  const m = mount({ threads: T }, { pinCap: 5 });
  expect(!!m.pin("t7")).toBe(false);
  m.collab.openThread("t7"); m.tick();
  expect(!!m.pin("t7")).toBe(true);
});

test("K32 the open thread deleted by its author: the popover goes", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  m.collab.openThread("a");
  expect(m.dom.root.find(e => e.tagName === "TEXTAREA")).toBeTruthy();
  m.port.remote({ do: "delete", id: "ca" }, "u", "U");
  expect(m.collab.state.open).toBe(null);
  expect(m.dom.root.find(e => e.tagName === "TEXTAREA")).toBeFalsy();
});

test("K36 a peer's new thread shows in the comments drawer", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  const rows = () => m.collab.parts.drawer.findAll(e => e.hasClass("thread-row")).length;
  expect(rows()).toBe(1);
  m.port.remote({ do: "thread", id: "b", anchor: { point: { x: 200, y: 100 } }, text: "new" }, "u2", "U2");
  expect(rows()).toBe(2);
});

test("K38 an element moved then deleted: the detached pin goes to the anchor's own point", () => {
  const m = mount({ threads: [th("a", { stream: "board", element: "e", x: 80, y: 0 })], elements: { "board:e": { x: 0, y: 0, width: 80, height: 40 } } });
  m.port.setElement("board", "e", { x: 300, y: 0, width: 80, height: 40 });
  m.S.eds.board.doc = { rev: 2 }; m.S.v++; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("380px");
  m.port.setElement("board", "e", null);
  m.S.eds.board.doc = { rev: 3 }; m.S.v++; m.tick();
  expect(m.pin("a").style.getPropertyValue("left")).toBe("80px");
  expect(m.pin("a").classList.contains("detached")).toBe(true);
});

test("K30 a re-place writes only what changed (an unchanged pin: 0 writes)", () => {
  const m = mount({ threads: [th("a", { point: { x: 100, y: 100 } })] });
  const el = m.pin("a"); let n = 0;
  for (const [o, k] of [[el.style, "setProperty"], [el, "setAttribute"], [el.classList, "toggle"], [el, "replaceChildren"], [el, "append"]]) { const f = o[k]; o[k] = function (...a) { n++; return f.apply(this, a); }; }
  m.port.remote({ do: "thread", id: "far", anchor: { point: { x: 99999, y: 99999 } }, text: "far" }, "u2", "U2");   // a records change: a re-place, a unchanged
  expect(n).toBe(0);
});
