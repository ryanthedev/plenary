// p7-perf: the collab UI's per-frame cost stays flat on a busy board (C-1, C-7, C-15), and its time runs on the
// clock port (C-6). DOM work is counted with a stub DOM (perf-fixture.js), never timed.
import { test, expect } from "bun:test";
import { busyBoard, cursorBatch, countingDom, panView, frameState, createFakePort, seeded } from "./perf-fixture.js";
import { mountCollab, PIN_CAP, MAX_CLUSTERS } from "../../../web/adapters/dom/collab/ui.js";
import { collabFrame } from "../../../web/adapters/dom/collab/frame.js";
import { layoutPins, nameIndex, zoomToFit } from "../../../web/core/collab/records-model.js";
import { notesView } from "../../../web/core/collab/notes-model.js";
import { Editor } from "../../../packages/core/editor.js";

const me = { user: "me", name: "Me", client: "me-1" };

/** The clock port on virtual time, wall and mono apart: jumpWall moves only now(); advance moves both, firing timers. */
function portClock({ wall = 1_700_000_000_000, mono = 5_000, rand = 0.25 } = {}) {
  let w = wall, m = mono, seq = 0;
  const timers = new Map();
  return {
    now: () => w, mono: () => m, random: () => rand,
    set: (fn, ms) => { const id = ++seq; timers.set(id, { at: m + Math.max(0, Number.isFinite(ms) ? ms : 0), fn }); return id; },
    clear: id => { timers.delete(id); },
    jumpWall(ms) { w += ms; },
    advance(ms) {
      const end = m + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]); w += next[1].at - m; m = next[1].at; next[1].fn();
      }
      w += end - m; m = end;
    },
  };
}

function mount(o = {}) {
  const board = o.board ?? busyBoard({ threads: o.threads ?? 10_000, notes: o.notes ?? 0 });
  const dom = countingDom(), clock = portClock(), view = panView();
  const frames = [];
  const port = createFakePort({ role: o.role ?? "editor", me, now: clock.now, threads: board.threads, elements: board.elements, notes: board.notes, noteAuthors: board.noteAuthors });
  const calls = { element: 0, notes: 0, records: 0 };
  for (const k of ["element", "notes", "records"]) { const f = port[k]; port[k] = (...a) => { calls[k]++; return f(...a); }; }
  const collab = mountCollab({ root: dom.root, port, view, clock, frame: fn => frames.push(fn), pinCap: o.pinCap ?? PIN_CAP });
  const S = frameState(view), tick = collabFrame(S, collab);
  tick();
  const pins = () => dom.root.findAll(e => e.hasClass("pin") && !e.hasClass("cluster"));
  const clusters = () => dom.root.findAll(e => e.hasClass("cluster"));
  return { dom, clock, view, port, collab, S, tick, calls, pins, clusters, board };
}

/** DOM writes and port.element calls over `n` pan frames of `dx` px each. */
function pan(m, n, dx) {
  const w0 = m.dom.writes.n, e0 = m.calls.element;
  for (let i = 0; i < n; i++) { m.view.v.x -= dx / m.view.v.scale; m.tick(); }
  return { writes: (m.dom.writes.n - w0) / n, element: m.calls.element - e0 };
}

test("C-1: a pan frame is O(1) in pins: one layer transform, no anchor lookups, the same for 1k and 10k threads", () => {
  const per = [];
  for (const threads of [1000, 10_000]) {
    const m = mount({ threads });
    const r = pan(m, 60, 3);
    expect(r.writes).toBeLessThanOrEqual(1);            // the pin layer's transform, nothing per pin
    expect(r.element).toBe(0);                           // a pan never re-resolves element anchors
    const layer = m.dom.root.find(e => e.hasClass("collab-pins"));
    expect(layer.style.getPropertyValue("transform")).toBe("translate(-180px, 0px)");
    per.push(r.writes);
    m.collab.destroy();
  }
  expect(per[0]).toBe(per[1]);
});

test("C-1: leaving the placed region re-places only what is in view plus the margin, bounded by the cap", () => {
  const m = mount({ threads: 10_000 });
  const before = m.pins().map(p => p.getAttribute("data-thread"));
  const r = pan(m, 1, 5000);                             // far past the margin: one re-place
  const after = m.pins().map(p => p.getAttribute("data-thread"));
  expect(after).not.toEqual(before);
  expect(m.pins().length + m.clusters().length).toBeLessThanOrEqual(PIN_CAP + MAX_CLUSTERS);
  // ≤ 14 writes per placed pin or cluster (a new one: its attr, 4 classes, 4 styles/attrs, its label (2), append) plus a
  // remove per dropped one: O(cap), not O(threads).
  expect(r.writes).toBeLessThanOrEqual(14 * (after.length + m.clusters().length) + before.length + 2);
  expect(m.dom.root.find(e => e.hasClass("collab-pins")).style.getPropertyValue("transform")).toBe("");
  // Every placed pin is in the viewport plus the margin.
  const w = m.view.toWorld({ x: 0, y: 0 }), mx = 1200 * 0.5, my = 800 * 0.5;
  for (const id of after) {
    const t = m.board.threads[Number(id.slice(1))], a = t.anchor.point ?? { x: m.board.elements[`board:${t.anchor.element}`].x + 80, y: m.board.elements[`board:${t.anchor.element}`].y };
    expect(a.x >= w.x - mx && a.x <= w.x + 1200 + mx && a.y >= w.y - my && a.y <= w.y + 800 + my).toBe(true);
  }
  m.collab.destroy();
});

test("C-1: the pin cap holds zoomed out over 10k threads; the rest are clusters whose counts add up", () => {
  const m = mount({ threads: 10_000, pinCap: 50 });
  m.view.v.scale = 0.05; m.view.v.x = 0; m.view.v.y = 0; m.tick();
  expect(m.pins().length).toBeLessThanOrEqual(50);
  expect(m.clusters().length).toBeGreaterThan(0);
  expect(m.clusters().length).toBeLessThanOrEqual(MAX_CLUSTERS);
  const counted = m.clusters().reduce((n, c) => n + Number(c.textContent.replace("k", "e3")), 0) + m.pins().length;
  expect(counted).toBe(10_000);                          // every thread is a pin or counted in a cluster (all fit: < 1000 each)
  m.collab.destroy();
});

test("C-1: layoutPins keeps the open thread a pin past the cap, and coarsens the grid to stay under maxClusters", () => {
  const r = seeded(3), threads = Array.from({ length: 5000 }, (_, i) => ({ id: `t${i}`, x: r() * 1000, y: r() * 1000 }));
  const box = { x0: 0, y0: 0, x1: 1000, y1: 1000 };
  const out = layoutPins(threads, { box, cap: 10, cell: 10, keep: "t4321", maxClusters: 40 });
  expect(out.pins.map(t => t.id)).toContain("t4321");
  expect(out.pins.length).toBeLessThanOrEqual(10);
  expect(out.clusters.length).toBeLessThanOrEqual(40);
  expect(out.pins.length + out.clusters.reduce((n, c) => n + c.n, 0)).toBe(5000);
  expect(layoutPins(threads.slice(0, 5), { box, cap: 10, cell: 10 }).clusters).toEqual([]);
});

test("C-1: an anchored element that moves still moves its pin on a board change, and only then are anchors looked up", () => {
  const m = mount({ threads: 0, board: { threads: [{ id: "t", by: "u", name: "U", at: 1, anchor: { stream: "board", element: "e", x: 80, y: 0 }, comments: [{ id: "c", by: "u", name: "U", at: 1, text: "x" }] }], elements: { "board:e": { x: 0, y: 0, width: 80, height: 40 } } } });
  const pin = m.pins()[0];
  expect(pin.style.getPropertyValue("left")).toBe("80px");
  const e0 = m.calls.element;
  m.port.setElement("board", "e", { x: 300, y: 10, width: 80, height: 40 });
  m.S.eds.board.doc = { rev: 2 }; m.S.v++; m.tick();      // an op: the doc's rev moved
  expect(m.calls.element).toBeGreaterThan(e0);
  expect(m.pins()[0].style.getPropertyValue("left")).toBe("380px");
  m.collab.destroy();
});

/** A Set that counts the ids read through its iterator. */
function countingSet(ids) {
  const c = { reads: 0 };
  class CountSet extends Set {
    [Symbol.iterator]() { const it = super[Symbol.iterator](); return { next: () => { const r = it.next(); if (!r.done) c.reads++; return r; }, [Symbol.iterator]() { return this; } }; }
  }
  return { sel: new CountSet(ids), c };
}
function selRig(ids, ok = () => true) {
  const { sel, c } = countingSet(ids);
  const ed = { sel, view: { x: 0, y: 0, scale: 1 }, version: 0, doc: { rev: 1 } };
  const S = { active: "board", eds: { board: ed, notes: { sel: new Set(), view: ed.view, version: 0, doc: { rev: 1 } } }, version: () => ed.version };
  const sent = [], collab = { statusRev: 0, selection: (s, x) => { sent.push(x); return ok(); }, layout() {} };
  return { sel, c, ed, S, sent, collab, tick: collabFrame(S, collab) };
}
const first = n => Array.from({ length: n }, (_, i) => `el${i}`);

test("C-15: a 100k selection is never walked: ≤ 500 ids read per check (MAX_SELECT_IDS), none on a still frame", () => {
  const r = selRig(first(100_000));
  r.tick();
  expect(r.sent).toEqual([first(500)]);                  // exactly what the outbox would send
  r.c.reads = 0;
  for (let i = 0; i < 60; i++) { r.ed.view = { ...r.ed.view, x: r.ed.view.x - 3 }; r.ed.version++; r.tick(); }
  expect(r.c.reads).toBeLessThanOrEqual(60 * 500);       // O(500) a pan frame, never O(100k)
  expect(r.sent.length).toBe(1);                         // nothing changed: nothing re-sent
  r.c.reads = 0; r.tick(); r.tick();
  expect(r.c.reads).toBe(0);                             // still frames: not read at all
});

test("C-15: an in-place same-size change is sent with its contents; one past the first 500 changes nothing on the wire", () => {
  const r = selRig(first(1000));
  r.tick();
  r.sel.delete("el999"); r.sel.add("past"); r.ed.version++; r.tick();
  expect(r.sent.length).toBe(1);                         // only the first 500 go out, and they didn't change
  r.sel.delete("el5"); r.sel.add("new"); r.ed.version++;  // mid-pan, same size
  r.ed.view = { ...r.ed.view, x: 9 }; r.tick();
  expect(r.sent.length).toBe(2);
  expect(r.sent[1]).toEqual([...first(500).filter(x => x !== "el5"), "el500"]);
});

test("C-15 (L1): ids whose hashes collided are told apart (exact compare)", () => {
  const r = selRig(["id43zx"]);
  r.tick();
  r.sel.delete("id43zx"); r.sel.add("idbpad"); r.ed.version++; r.tick();
  expect(r.sent).toEqual([["id43zx"], ["idbpad"]]);
});

test("C-15 (M2): a refused selection is retried on a status change, not every frame, and never walks the Set meanwhile", () => {
  let ok = false;
  const r = selRig(first(100_000), () => ok);
  r.tick();
  expect(r.sent.length).toBe(1);
  r.c.reads = 0;
  for (let i = 0; i < 30; i++) r.tick();
  expect(r.sent.length).toBe(1);                         // no retry per frame
  expect(r.c.reads).toBe(0);
  ok = true; r.collab.statusRev++; r.tick();             // the port went live: one retry
  expect(r.sent.length).toBe(2);
  expect(r.sent[1]).toEqual(first(500));
  r.tick(); r.tick();
  expect(r.sent.length).toBe(2);
});

test("C-15 (M2): mountCollab's statusRev moves on every onStatus", () => {
  const m = mount({ threads: 0 });
  const before = m.collab.statusRev;
  m.port.setStatus("connecting"); m.port.setStatus("live");
  expect(m.collab.statusRev).toBe(before + 2);
  m.collab.destroy();
});

test("C-15: core's Editor bumps version on a selection change and replaces its view on a pan (the guard's assumptions)", () => {
  const e = new Editor();
  e.doc.apply({ elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1 }] }, { force: true });
  const v0 = e.version, rev = e.doc.rev, view = e.view;
  e.select(["a"]);
  expect(e.version).toBeGreaterThan(v0);
  e.wheel({ x: 10, y: 0 }, { x: 0, y: 0 });
  expect(e.view).not.toBe(view);
  expect(e.doc.rev).toBe(rev);
  // Every path that moves an element bumps doc.rev (the board hint's assumption): mid-drag, drop, undo, a remote op.
  e.size = { w: 800, h: 600 }; e.tool = "select";
  const at = p => e.toScreen(p), revs = [e.doc.rev];
  e.pointerDown(at({ x: 5, y: 5 }), {}); e.pointerMove(at({ x: 25, y: 5 }), {}); revs.push(e.doc.rev);
  e.pointerUp(at({ x: 25, y: 5 }), {}); revs.push(e.doc.rev);
  e.undo(); revs.push(e.doc.rev);
  e.receive({ elements: [{ ...e.doc.get("a"), x: 400, version: 99 }] }); revs.push(e.doc.rev);
  for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1]);
});

test("C-7: on the comments tab a here never builds the notes rows; the notes tab does, and the label count stays right", () => {
  const board = busyBoard({ threads: 10, notes: 900 });
  const m = mount({ board });
  const n0 = m.calls.notes;
  m.port.here({ writers: [{ user: "u1", name: "One", role: "editor" }], writerCount: 1, viewers: 2 });
  expect(m.calls.notes).toBe(n0);
  const drawer = m.collab.parts.drawer;
  const tabNotes = drawer.find(e => e.tagName === "BUTTON" && e.textContent.startsWith("Notes "));
  expect(tabNotes.textContent).toBe("Notes 900");
  m.collab.showDrawer("notes");
  expect(m.calls.notes).toBe(n0 + 1);
  expect(drawer.findAll(e => e.hasClass("note-row")).length).toBe(200);
  m.collab.showDrawer("comments");
  // A new note shows in the count within the 1 s tick.
  m.port.setElement("notes", "fresh", { id: "fresh", type: "rectangle", x: 0, y: 0, width: 1, height: 1, updated: 9e9 });
  m.clock.advance(1000);
  expect(tabNotes.textContent).toBe("Notes 901");
  m.collab.showDrawer("notes");
  expect(drawer.findAll(e => e.hasClass("note-row"))[0].getAttribute("data-note")).toBe("fresh");   // newest first
  m.collab.destroy();
});

test("C-7: notesView's bounded top-N equals a full stable sort, ties included", () => {
  const r = seeded(11), els = [];
  for (let i = 0; i < 3000; i++) {
    els.push({ id: `n${i}`, type: i % 7 ? "rectangle" : "text", text: `t${i}`, x: 0, y: 0, updated: Math.floor(r() * 400), isDeleted: i % 13 === 0 });
    if (i % 5 === 0) els.push({ id: `l${i}`, type: "text", containerId: `n${i}`, text: `label ${i}`, x: 0, y: 0, updated: 1e9 });
  }
  const o = { me, role: "editor", noteAuthor: () => null, nameOf: () => null, limit: 150 };
  const isLabel = e => e.type === "text" && !!e.containerId;
  const ref = els.filter(e => !e.isDeleted && !isLabel(e)).sort((a, b) => b.updated - a.updated);
  const v = notesView(els, o);
  expect(v.rows.map(x => x.id)).toEqual(ref.slice(0, 150).map(e => e.id));
  expect([v.total, v.more]).toEqual([ref.length, ref.length - 150]);
  const labelled = v.rows.find(x => Number(x.id.slice(1)) % 5 === 0 && Number(x.id.slice(1)) % 7);
  expect(labelled.text).toBe(`label ${labelled.id.slice(1)}`);
  expect(notesView(els, { ...o, limit: 0 }).rows).toEqual([]);
  // A tie at the cut: the earlier note stays (a stable sort keeps it).
  const tie = ["a", "b", "c"].map(id => ({ id, type: "rectangle", x: 0, y: 0, updated: 5 }));
  expect(notesView(tie, { ...o, limit: 2 }).rows.map(x => x.id)).toEqual(["a", "b"]);
});

test("C-7: nameOf is an index over the records, first match wins in scan order", () => {
  const names = nameIndex({ threads: [
    { by: "a", name: "A1", comments: [{ by: "b", name: "B1" }, { by: "a", name: "A2" }] },
    { by: "b", name: "B2", comments: [{ by: "c", name: null }, { by: "c", name: "C1" }] },
  ] });
  expect(Object.fromEntries(names)).toEqual({ a: "A1", b: "B1", c: "C1" });
});

test("C-6: presence expiry follows the clock port's mono, not the wall clock", () => {
  const m = mount({ threads: 0 });
  m.port.presence(cursorBatch(3));
  expect(m.collab.presence.view().cursors.length).toBe(3);
  m.clock.jumpWall(3_600_000);                            // NTP or a laptop wake: an hour of wall time, no mono
  m.clock.advance(1000);
  expect(m.collab.presence.view().cursors.length).toBe(3);
  m.clock.jumpWall(-7_200_000);                           // and back two hours
  m.clock.advance(28_000);
  expect(m.collab.presence.view().cursors.length).toBe(3);
  m.clock.advance(1000);                                  // 30 s of mono since the batch
  expect(m.collab.presence.view().cursors.length).toBe(0);
  m.collab.destroy();
});

test("C-6: outbox pacing runs on mono timers, record ids on the port's random, the overlay on the frame scheduler", () => {
  const m = mount({ threads: 0 });
  m.collab.pointer({ x: 1, y: 1 }); m.collab.pointer({ x: 2, y: 2 });
  const n = m.port.sent.filter(s => s.k === "cursor").length;
  m.clock.jumpWall(-60_000);                              // a backward wall step must not stall pacing
  m.clock.advance(100);
  expect(m.port.sent.filter(s => s.k === "cursor").length).toBe(n + 1);
  m.collab.startComment({ x: 5, y: 5 });
  const field = m.dom.root.find(e => e.tagName === "TEXTAREA");
  field.value = "hi";
  m.dom.root.find(e => e.tagName === "BUTTON" && e.textContent === "Comment").click();
  expect(m.port.log.at(-1).op.id).toBe(`c${"j".repeat(14)}`);   // random() = 0.25 → "j" every time
  m.collab.destroy();
});

test("C-6: ui.js reads no global time, timer, randomness or animation frame", async () => {
  const src = await Bun.file(new URL("../../../web/adapters/dom/collab/ui.js", import.meta.url)).text();
  const code = src.replace(/\/\/.*$/gm, "");
  for (const g of ["Date.now", "setTimeout", "clearTimeout", "Math.random", "requestAnimationFrame", "performance.now"]) expect(code.includes(g)).toBe(false);
});

test("M1: a cluster click zooms to fit its members (jumpTo with scale), and they open into pins", () => {
  const m = mount({ threads: 10_000, pinCap: 50 });
  // A port that honours jumpTo's scale, as app.js will: centre the point and zoom to it.
  m.port.jumpTo = ({ x, y, scale }) => { m.view.v.scale = scale ?? m.view.v.scale; m.view.v.x = 600 / m.view.v.scale - x; m.view.v.y = 400 / m.view.v.scale - y; };
  m.view.v.scale = 0.05; m.view.v.x = 0; m.view.v.y = 0; m.tick();
  expect(m.pins().length).toBeLessThanOrEqual(50);
  let clicks = 0;
  while (m.clusters().length && clicks < 6) {
    const c = m.clusters().reduce((a, b) => (Number(b.textContent) > Number(a.textContent) ? b : a));
    const n = Number(c.textContent), scale = m.view.v.scale;
    c.click(); m.tick(); clicks++;
    expect(m.view.v.scale).toBeGreaterThanOrEqual(scale * 2);        // each click zooms in
    if (n <= 50) break;
  }
  expect(clicks).toBeGreaterThan(0);
  expect(m.pins().length).toBeGreaterThan(0);                         // the cluster opened into pins
  m.collab.destroy();
});

test("M1: zoomToFit centres the members and fits them, zooming at least 2× and at most to 4", () => {
  expect(zoomToFit({ x0: 0, y0: 0, x1: 1000, y1: 500 }, { w: 1200, h: 800, scale: 0.05 })).toEqual({ x: 500, y: 250, scale: 0.96 });
  expect(zoomToFit({ x0: 10, y0: 10, x1: 10, y1: 10 }, { w: 1200, h: 800, scale: 0.5 }).scale).toBe(4);        // coincident: max
  expect(zoomToFit({ x0: 0, y0: 0, x1: 1e6, y1: 1e6 }, { w: 1200, h: 800, scale: 0.01 }).scale).toBe(0.02);    // at least 2×
});
