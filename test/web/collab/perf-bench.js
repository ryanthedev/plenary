// p7-perf bench: per-frame cost of the collab UI on a busy board. Run: bun test/web/collab/perf-bench.js
// Pure parts are timed (median of runs, ms on this machine); DOM work is counted with the stub DOM (writes per frame),
// because bun has no layout engine. Drives only mountCollab's public API and collabFrame.
import { busyBoard, cursorBatch, countingDom, panView, frameState, createFakePort } from "./perf-fixture.js";
import { fakeClock } from "./clock.js";
import { mountCollab } from "../../../web/adapters/dom/collab/ui.js";
import { collabFrame } from "../../../web/adapters/dom/collab/frame.js";
import { recordsView } from "../../../web/core/collab/records-model.js";
import { notesView } from "../../../web/core/collab/notes-model.js";
import { createPresence } from "../../../web/core/collab/presence-model.js";

const median = (fn, runs = 15) => {
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b); return ts[Math.floor(ts.length / 2)];
};
const ms = x => x.toFixed(3);
const rows = [];
const row = (what, value, note = "") => rows.push([what, value, note]);

const board = busyBoard();
const me = { user: "me", name: "Me", client: "me-1" };

// ── pure parts ──
const port0 = createFakePort({ role: "editor", me, threads: board.threads, elements: board.elements, notes: board.notes, noteAuthors: board.noteAuthors });
const rec = port0.records();
row("recordsView, 10k threads × 3 (ms)", ms(median(() => recordsView(rec, { me, role: "editor", element: port0.element }))));
const notes = port0.notes();
row("notesView, 50k notes (ms)", ms(median(() => notesView(notes, { me, role: "editor", noteAuthor: port0.noteAuthor, nameOf: () => null }))));
const sel = new Set(Array.from({ length: 100_000 }, (_, i) => `el${i}`));
row("selection key, 100k selected (ms)", ms(median(() => `board|${[...sel].join(",")}`)), "the old per-frame key");
const presence = createPresence({ now: () => 0, me, role: "editor" });
presence.ingest(cursorBatch(50));
row("presence view(), 50 cursors (ms)", ms(median(() => presence.view(), 51)));

// ── the mounted UI ──
function mounted() {
  const dom = countingDom(), clock = fakeClock(), view = panView();
  const port = createFakePort({ role: "editor", me, now: clock.now, threads: board.threads, elements: board.elements, notes: board.notes, noteAuthors: board.noteAuthors });
  const collab = mountCollab({ root: dom.root, port, view, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) } });
  return { dom, clock, view, port, collab };
}
const m = mounted();
const pinsInDom = () => m.dom.root.findAll(e => e.hasClass("pin") || e.hasClass("pin-cluster")).length;
row("pins in the DOM after mount", pinsInDom(), "10k threads, 1200×800 view at 100%");
const S = frameState(m.view, new Set()), tick = collabFrame(S, m.collab);
tick();
// Pan: 60 frames of 3 px.
let w0 = m.dom.writes.n;
const panMs = median(() => { m.view.v.x -= 3; tick(); }, 60);
row("DOM writes per pan frame, 100% zoom (stub)", Math.round((m.dom.writes.n - w0) / 60));
row("pan frame, 100% zoom (ms, fake DOM)", ms(panMs), "includes the stub DOM's own cost");
// Zoomed out to see the whole board: every pin is in view.
m.view.v.scale = 0.05; m.view.v.x = 0; m.view.v.y = 0; tick();
row("pins in the DOM, zoomed out to 5%", pinsInDom());
w0 = m.dom.writes.n;
const panOutMs = median(() => { m.view.v.x -= 20; tick(); }, 30);
row("DOM writes per pan frame, 5% zoom (stub)", Math.round((m.dom.writes.n - w0) / 30));
row("pan frame, 5% zoom (ms, fake DOM)", ms(panOutMs));
// The worst frames: a zoom frame (scale changes: a full re-place), a frame that leaves the placed region, and a
// board op (anchors re-resolved).
m.view.v.scale = 1; m.view.v.x = 0; m.view.v.y = 0; tick();
w0 = m.dom.writes.n;
let zoomFrames = 0;
const zoomMs = median(() => { m.view.v.scale *= 0.98; zoomFrames++; tick(); }, 30);
row("zoom frame, 100% → 55% (ms, fake DOM)", ms(zoomMs), `${Math.round((m.dom.writes.n - w0) / zoomFrames)} writes a frame: a full re-place`);
m.view.v.scale = 1; tick();
let exits = 0; w0 = m.dom.writes.n;
const exitMs = median(() => { m.view.v.x -= 3000; exits++; tick(); }, 15);
row("pan frame leaving the placed region (ms, fake DOM)", ms(exitMs), `${Math.round((m.dom.writes.n - w0) / exits)} writes a frame`);
const opMs = median(() => { S.v++; tick(); }, 15);
row("board-op frame: reanchor 5k anchored threads (ms, fake DOM)", ms(opMs));
// A records change (someone reacts) while the comments drawer is open.
m.view.v.scale = 1; tick();
let n = 0;
const recMs = median(() => { m.port.remote({ do: "react", id: `c${2 * (n++ % 5000)}_0`, emoji: "🎉", on: true }, "u3", "User 3", "editor"); }, 15);
row("records change, comments tab (ms, fake DOM)", ms(recMs), "onRecords: view + pins + popover + drawer");
const portOnly = createFakePort({ role: "editor", me, threads: board.threads, elements: board.elements });
row("  of which: the fake port's own records() rebuild (ms)", ms(median(() => { portOnly.remote({ do: "react", id: `c${2 * (n++ % 5000)}_0`, emoji: "🎉", on: true }, "u3", "User 3", "editor"); portOnly.records(); })), "a test double's cost; production's is the Replica's (E-3)");
// A `here` (1/s): today it re-renders the drawer, notesView included.
const hereMs = median(() => m.port.here({ writers: [{ user: "u1", name: "User 1", role: "editor" }], writerCount: 1, viewers: 10 }), 15);
row("here, comments tab (ms, fake DOM)", ms(hereMs));
// Presence: 50 cursors, then the overlay paint (no canvas here: model + previews only).
const presMs = median(() => m.port.presence(cursorBatch(50, n++)), 31);
row("presence batch of 50 (ms)", ms(presMs));

// The selection check per pan frame with 100k selected, Editor-like: a pan replaces the view object and bumps
// `version`; the doc's rev stays. OLD_FRAME=<path to a pre-p7-perf frame.js> runs that one too, for the table.
async function selectionPan(path, label) {
  const { collabFrame: cf } = await import(path);
  const sel = new Set(Array.from({ length: 100_000 }, (_, i) => `el${i}`));
  const ed = { sel, view: { x: 0, y: 0, scale: 1 }, version: 0, doc: { rev: 1 } };
  const S2 = { active: "board", eds: { board: ed, notes: { sel: new Set(), view: ed.view, version: 0, doc: { rev: 1 } } }, version: () => ed.version };
  let sends = 0;
  const t = cf(S2, { selection: () => { sends++; return true; }, layout() {} });
  t();
  const each = [];
  const frameMs = median(() => { const t0 = performance.now(); ed.view = { ...ed.view, x: ed.view.x - 3 }; ed.version++; t(); each.push(performance.now() - t0); }, 60);
  row(`selection check per pan frame, 100k selected (ms, ${label})`, ms(frameMs), `max ${ms(Math.max(...each))}; ${sends} send(s)`);
}
if (process.env.OLD_FRAME) await selectionPan(process.env.OLD_FRAME, "before");
await selectionPan("../../../web/adapters/dom/collab/frame.js", "this tree");
// The notes tab open: a `here` (1/s) rebuilds its rows.
m.collab.showDrawer("notes");
row("here, notes tab open (ms, fake DOM)", ms(median(() => m.port.here({ writers: [{ user: "u2", name: `User ${n++}`, role: "editor" }], writerCount: 1, viewers: 10 }), 15)), "notesView + the 200 rows");

console.log("| what | value | note |\n|---|---|---|");
for (const [a, b, c] of rows) console.log(`| ${a} | ${b} | ${c} |`);
m.collab.destroy();
