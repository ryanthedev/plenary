// The collab UI over the fake port, in a fake DOM where every HTML sink throws.
import { test, expect, beforeEach } from "bun:test";
import { installDom, byClass, button } from "./fake-dom.js";
import { mountCollab } from "../../../web/adapters/dom/collab/ui.js";
import { createFakePort } from "../../../web/adapters/collab/fake.js";
import { fakeClock } from "./clock.js";

const EVIL = `<img src=x onerror="alert(1)">`, EVIL2 = `</p><script>alert(2)</script>`;
const ALLOWED = new Set(["DIV", "SPAN", "BUTTON", "B", "P", "HEADER", "H3", "TEXTAREA"]);
const view = { toScreen: p => ({ x: p.x, y: p.y }), toWorld: p => p, scale: 1 };
let dom;
beforeEach(() => { dom = installDom(); });

function setup(role = "annotator", o = {}) {
  const clock = fakeClock();
  const port = createFakePort({ role, me: { user: "me", name: "Jordan P.", client: "me-1" }, now: clock.now, elements: { "board:ship": { x: 100, y: 100, width: 80, height: 40 } }, ...o });
  let n = 0;
  const collab = mountCollab({ root: dom.root, port, view, clock: { ...clock, raf: fn => clock.setTimer(fn, 16) }, idGen: () => `id${++n}` });
  return { clock, port, collab };
}

test("hostile names, comment text and note text never reach the DOM as HTML", () => {
  const { port, collab } = setup("editor", {
    notes: [{ id: "n1", type: "rectangle", x: 0, y: 0, width: 10, height: 10, backgroundColor: "url(http://evil/x)", strokeColor: "#000" }, { id: "l1", type: "text", containerId: "n1", text: EVIL2, x: 0, y: 0 }],
    noteAuthors: { n1: "mal" },
  });
  port.here({ writers: [{ user: "mal", name: EVIL, role: "annotator" }], writerCount: 1, viewers: 3 });
  port.remote({ do: "thread", id: "t", anchor: { point: { x: 5, y: 5 } }, text: EVIL2 }, "mal", EVIL, "annotator");
  port.remote({ do: "react", id: "t", emoji: EVIL.slice(0, 30), on: true }, "mal", EVIL, "annotator");
  collab.openThread("t"); collab.showDrawer("notes");
  const all = [dom.root, collab.parts.avatars, collab.parts.drawer, collab.parts.emotes].flatMap(r => r.all());
  for (const el of all) expect(ALLOWED.has(el.tagName)).toBe(true);
  const text = all.map(e => e.textContent).join("\n");
  expect(text).toContain(EVIL2);                         // shown, as text
  expect(collab.parts.drawer.textContent).toContain(EVIL);
  expect(dom.root.textContent).toContain(EVIL.slice(0, 30));
  // Titles hold names as attribute text; no event-handler attribute was ever set (the fake throws on one).
  expect(collab.parts.avatars.find(e => e.getAttribute("title") === EVIL)).toBeTruthy();
  // A note color that isn't plain hex never reaches a style.
  const sw = collab.parts.drawer.find(e => e.hasClass("sw"));
  expect(sw.style.getPropertyValue("background")).toBe("#adb5bd");
  collab.destroy();
});

test("the count beside the avatars is VIEWERS only: two writers and no viewers read 0 viewers, one reads 1 viewer", () => {
  const { port, collab } = setup();
  const two = [{ user: "dev:ada", name: "ada", role: "owner" }, { user: "dev:bo", name: "bo", role: "editor" }];
  port.here({ writers: two, writerCount: 2, viewers: 0 });
  const w = () => byClass(collab.parts.avatars, "watching")[0];
  expect(w().textContent).toBe("👁 0 viewers");
  expect(byClass(collab.parts.avatars, "av").length).toBe(2);
  port.here({ writers: two, writerCount: 2, viewers: 1 });
  expect(w().textContent).toBe("👁 1 viewer");
  collab.destroy();
});

test("avatar row: ≤ 5 avatars, +N for the rest, viewers counted; stale when not live", () => {
  const { port, collab } = setup();
  port.here({ writers: [...Array(12).keys()].map(i => ({ user: `u${i}`, name: `User ${i}`, role: i < 2 ? "editor" : "annotator" })), writerCount: 42, viewers: 12408 });
  const a = collab.parts.avatars;
  expect(byClass(a, "av").filter(e => !e.hasClass("more")).length).toBe(5);
  expect(byClass(a, "more")[0].textContent).toBe("+37");
  expect(byClass(a, "watching")[0].textContent).toBe("👁 12,408 viewers");
  port.setStatus("connecting");
  expect(a.hasClass("stale")).toBe(true);
  collab.destroy();
});

test("emote bar: viewers send but never float; writers float; disabled when not live", () => {
  const v = setup("viewer");
  button(v.collab.parts.emotes, "👍").click();
  expect(v.port.sent.map(m => [m.k, m.e])).toEqual([["emote", "👍"]]);
  expect(byClass(v.collab.layer, "collab-float")).toEqual([]);
  v.port.emotes({ counts: { "👍": 1200, "👏": 3 } });
  expect(button(v.collab.parts.emotes, "👍").textContent).toBe("👍1.2k");
  v.port.setStatus("connecting");
  expect(v.collab.parts.emotes.findAll(e => e.tagName === "BUTTON").every(b => b.disabled)).toBe(true);
  v.collab.destroy();
  dom = installDom();
  const w = setup("annotator");
  button(w.collab.parts.emotes, "🎉").click();
  expect(byClass(w.collab.layer, "collab-float").map(e => e.textContent)).toEqual(["🎉"]);
  w.clock.advance(3000);
  expect(byClass(w.collab.layer, "collab-float")).toEqual([]);
  // ✨ opens the full fixed set
  button(w.collab.parts.emotes, "✨").click();
  expect([...byClass(w.collab.layer, "collab-picker")[0].children].map(b => b.textContent)).toEqual(["👍", "❤️", "😂", "🎉", "👏", "😮", "🙏", "🔥"]);
  w.collab.destroy();
});

test("comment on an element: compose, send, pending pin, ack, reply and react through the port", () => {
  const { port, collab } = setup("commenter");
  expect(collab.startComment({ x: 0, y: 0 }, { stream: "board", element: "ship" })).toBe(true);
  const field = dom.root.find(e => e.tagName === "TEXTAREA");
  field.value = "Is Jan 14 locked?";
  button(dom.root, "Comment").click();
  expect(port.log.map(l => l.op)).toEqual([{ do: "thread", id: "id1", anchor: { stream: "board", element: "ship", x: 180, y: 100 }, text: "Is Jan 14 locked?" }]);
  let pin = byClass(dom.root, "pin")[0];
  expect(pin.hasClass("pending")).toBe(true);
  expect([pin.style.getPropertyValue("left"), pin.style.getPropertyValue("top")]).toEqual(["180px", "72px"]);
  port.ackAll();
  pin = byClass(dom.root, "pin")[0];
  expect(pin.hasClass("pending")).toBe(false);
  // The element moves: the pin follows on layout.
  port.setElement("board", "ship", { x: 300, y: 300, width: 80, height: 40 }); collab.layout();
  expect(byClass(dom.root, "pin")[0].style.getPropertyValue("left")).toBe("380px");
  // Reply with Enter, react, resolve.
  const reply = dom.root.find(e => e.tagName === "TEXTAREA" && e.getAttribute("aria-label") === "Reply");
  reply.value = "second"; reply.dispatch("keydown", { key: "Enter" });
  button(dom.root, "＋").click(); button(byClass(dom.root, "collab-reactrow")[0], "🔥").click();
  button(dom.root, "✓ Resolve").click();
  expect(port.log.slice(1).map(l => l.op)).toEqual([
    { do: "reply", id: "id2", thread: "id1", text: "second" },
    { do: "react", id: "id1", emoji: "🔥", on: true },
    { do: "resolve", id: "id1" },
  ]);
  expect(byClass(dom.root, "pin")[0].textContent).toBe("✓");
  // Deleting the element detaches the thread.
  port.setElement("board", "ship", null); collab.layout();
  expect(byClass(dom.root, "pin")[0].hasClass("detached")).toBe(true);
  collab.destroy();
});

test("viewers read threads but get no reply box, no resolve, no reactions, and can't start one", () => {
  const { port, collab } = setup("viewer");
  port.remote({ do: "thread", id: "t", anchor: { point: { x: 1, y: 1 } }, text: "hello" }, "maya", "Maya");
  port.remote({ do: "react", id: "t", emoji: "👍", on: true }, "maya", "Maya");
  collab.openThread("t");
  const pop = byClass(dom.root, "collab-pop")[0];
  expect(pop.textContent).toContain("hello");
  expect(button(pop, "✓ Resolve")).toBeUndefined();
  expect(byClass(pop, "reply").find(e => !e.hasClass("hint")).hidden).toBe(true);
  expect(byClass(pop, "hint").find(e => !e.hidden).textContent).toBe("Viewers read comments; they can't reply or react.");
  expect(byClass(pop, "chip-r").every(c => c.disabled)).toBe(true);
  expect(collab.startComment({ x: 0, y: 0 })).toBe(false);
  expect(port.log).toEqual([]);
  collab.destroy();
});

test("phone popovers clamp above the bottom sheet inset", () => {
  dom.root.clientHeight = 469;
  const { port, collab } = setup();
  port.remote({ do: "thread", id: "t", anchor: { point: { x: 600, y: 650 } }, text: "hello" }, "maya", "Maya");
  collab.openThread("t");
  collab.setBottomInset(260);
  const pop = byClass(dom.root, "collab-pop")[0];
  expect(byClass(dom.root, "collab-pophost")[0].style.getPropertyValue("bottom")).toBe("260px");
  expect(Number.parseFloat(pop.style.getPropertyValue("top"))).toBeLessThanOrEqual(152);
  collab.setBottomInset(0);
  expect(byClass(dom.root, "collab-pophost")[0].style.getPropertyValue("bottom")).toBe("0px");
  collab.destroy();
});

test("popover stays within a narrow root when its anchor is near the right edge", () => {
  dom.root.clientWidth = 220;
  const { port, collab } = setup();
  port.remote({ do: "thread", id: "edge", anchor: { point: { x: 215, y: 150 } }, text: "edge" }, "maya", "Maya");
  collab.openThread("edge");
  const pop = byClass(dom.root, "collab-pop")[0];
  const left = Number.parseFloat(pop.style.getPropertyValue("left"));
  const width = Number.parseFloat(pop.style.getPropertyValue("width"));
  expect(left + width).toBeLessThanOrEqual(220 - 8);
  expect(width).toBeLessThanOrEqual(220 - 16);
  collab.destroy();
});

test("a refused comment leaves the overlay and says why; an empty one is never sent", () => {
  const { port, collab } = setup("annotator");
  collab.startComment({ x: 5, y: 5 });
  button(dom.root, "Comment").click();
  expect(port.log).toEqual([]);
  expect(collab.state.toast).toBe("write something first");
  dom.root.find(e => e.tagName === "TEXTAREA").value = "hi";
  button(dom.root, "Comment").click();
  expect(byClass(dom.root, "pin").length).toBe(1);
  port.refuseNext("limit", "the board's comments are full");
  expect(byClass(dom.root, "pin").length).toBe(0);
  expect(collab.state.toast).toBe("Not saved: the board's comments are full");
  collab.destroy();
});

test("comments drawer lists open and resolved threads; notes drawer shows authors and locks", () => {
  const { port, collab } = setup("annotator", {
    notes: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10, backgroundColor: "#ffec99", updated: 2 }, { id: "b", type: "rectangle", x: 0, y: 0, width: 10, height: 10, backgroundColor: "#ffec99", updated: 1 }],
    noteAuthors: { a: "me", b: "pri" },
  });
  port.editNote = () => {}; port.deleteNote = () => {};
  port.here({ writers: [{ user: "pri", name: "Priya", role: "annotator" }], writerCount: 1, viewers: 0 });
  port.remote({ do: "thread", id: "t1", anchor: { point: { x: 1, y: 1 } }, text: "open one" }, "pri", "Priya");
  port.remote({ do: "thread", id: "t2", anchor: { point: { x: 2, y: 2 } }, text: "done one" }, "pri", "Priya");
  port.remote({ do: "resolve", id: "t2" }, "pri", "Priya");
  const d = collab.parts.drawer;
  collab.showDrawer("comments");
  expect(byClass(d, "thread-row").map(r => r.getAttribute("data-thread"))).toEqual(["t1"]);
  button(d, "Resolved").click();
  expect(byClass(d, "thread-row").map(r => r.getAttribute("data-thread"))).toEqual(["t2"]);
  byClass(d, "thread-row")[0].click();
  expect(collab.state.open).toBe("t2");
  expect(port.jumps).toEqual([{ x: 2, y: 2 }]);
  collab.showDrawer("notes");
  const rows = byClass(d, "note-row");
  expect(rows.map(r => r.find(e => e.hasClass("author")).textContent)).toEqual(["You", "Priya"]);
  expect(rows[0].textContent).toContain("edit"); expect(rows[0].textContent).toContain("delete");
  expect(rows[1].textContent).toContain("🔒 Priya's"); expect(rows[1].textContent).not.toContain("delete");
  collab.destroy();
});

test("focus survives a drawer rebuild: a focused thread row is found again after the list changes", () => {
  const { port, collab } = setup("annotator");
  port.here({ writers: [{ user: "pri", name: "Priya", role: "annotator" }], writerCount: 1, viewers: 0 });
  port.remote({ do: "thread", id: "t1", anchor: { point: { x: 1, y: 1 } }, text: "first one" }, "pri", "Priya");
  const d = collab.parts.drawer, doc = globalThis.document, body = {};
  collab.showDrawer("comments");
  doc.body = body; const orig = Object.getPrototypeOf(d).focus;
  Object.getPrototypeOf(d).focus = function () { doc.activeElement = this; };
  try {
    const row = byClass(d, "thread-row")[0]; doc.activeElement = row;
    port.remote({ do: "thread", id: "t2", anchor: { point: { x: 2, y: 2 } }, text: "second one" }, "pri", "Priya");   // the list is rebuilt
    const rows = byClass(d, "thread-row");
    expect(rows.length).toBe(2);
    const now = doc.activeElement;
    expect(rows.includes(now)).toBe(true);                         // focus is on a row of the new list, not lost
    expect(now.textContent).toContain("first one");                // the same thread's row
  } finally { Object.getPrototypeOf(d).focus = orig; collab.destroy(); }
});

test("presence in: cursors are drawn on the overlay with names; going offline clears them", () => {
  const { port, collab, clock } = setup("viewer");
  port.here({ writers: [{ user: "maya", name: "Maya", role: "owner" }, { user: "pri", name: "Priya", role: "annotator" }], writerCount: 2, viewers: 1 });
  port.presence([{ user: "maya", client: "m", k: "cursor", x: 10, y: 20 }, { user: "pri", client: "p", k: "cursor", x: 1, y: 1 }]);
  const texts = [];
  const ctx = new Proxy({ measureText: t => ({ width: t.length * 6 }), fillText: t => texts.push(t) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  collab.draw(ctx);
  expect(texts).toEqual(["Maya"]);           // viewers see presenters' cursors only (flag)
  port.setPreviews("board", [{ el: { id: "x", x: 0, y: 0, width: 5, height: 5 }, user: "maya", client: "m" }, { el: { id: "y", x: 0, y: 0, width: 5, height: 5 }, user: "pri", client: "p" }]);
  texts.length = 0; collab.draw(ctx);
  expect(texts).toEqual(["Maya · drawing", "Maya"]);   // previews too: presenters' only, for a viewer
  port.setStatus("connecting");
  texts.length = 0; collab.draw(ctx);
  expect(texts).toEqual([]);
  port.presence([{ user: "maya", client: "m", k: "cursor", x: 10, y: 20 }]);   // a straggler while down
  collab.draw(ctx); expect(texts).toEqual([]);
  port.setStatus("live"); port.presence([{ user: "maya", client: "m", k: "cursor", x: 10, y: 20 }]);
  collab.draw(ctx); expect(texts).toEqual(["Maya · drawing", "Maya"]);
  clock.advance(1000);
  collab.destroy();
  expect(clock.pending).toBe(0);
});

test("live controls survive events: same buttons, same textareas with their text, same list element", () => {
  const { port, collab, clock } = setup("editor", { notes: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 1, height: 1, backgroundColor: "#ffec99" }], noteAuthors: { a: "pri" } });
  port.remote({ do: "thread", id: "t", anchor: { point: { x: 1, y: 1 } }, text: "first" }, "maya", "Maya");
  const thumbs = button(collab.parts.emotes, "👍");
  port.emotes({ counts: { "👍": 5 } }); clock.advance(1000);
  expect(thumbs.textContent).toBe("👍5");
  port.setStatus("connecting"); port.setStatus("live");
  expect(button(collab.parts.emotes, "👍")).toBe(thumbs);
  expect(thumbs.textContent).toBe("👍");          // counts are presence: dropped with the connection
  // The open thread's reply box keeps its node and its text through others' entries and a pan.
  collab.openThread("t");
  const reply = dom.root.find(e => e.getAttribute?.("aria-label") === "Reply");
  reply.value = "half typed";
  port.remote({ do: "reply", id: "r", thread: "t", text: "someone else" }, "dev", "Dev");
  port.remote({ do: "thread", id: "t2", anchor: { point: { x: 9, y: 9 } }, text: "elsewhere" }, "dev", "Dev");
  collab.layout(); port.here({ writers: [], writerCount: 0, viewers: 4 });
  expect(dom.root.find(e => e.getAttribute?.("aria-label") === "Reply")).toBe(reply);
  expect(reply.value).toBe("half typed");
  expect(byClass(dom.root, "collab-pop")[0].textContent).toContain("someone else");
  // The compose box too.
  collab.startComment({ x: 3, y: 3 });
  const compose = dom.root.find(e => e.getAttribute?.("aria-label") === "Comment");
  compose.value = "drafting";
  port.remote({ do: "reply", id: "r2", thread: "t", text: "more" }, "dev", "Dev");
  collab.layout(); port.here({ writers: [{ user: "x", name: "X", role: "editor" }], writerCount: 1, viewers: 4 }); clock.advance(2000);
  expect(dom.root.find(e => e.getAttribute?.("aria-label") === "Comment")).toBe(compose);
  expect(compose.value).toBe("drafting");
  // The drawer's scroller and its rows stay put when nothing they show changed.
  collab.showDrawer("notes");
  const list = collab.parts.drawer.find(e => e.hasClass("notes-list")), row = list.children[0];
  port.here({ writers: [{ user: "pri", name: "Priya", role: "annotator" }], writerCount: 1, viewers: 9 });
  expect(collab.parts.drawer.find(e => e.hasClass("notes-list"))).toBe(list);
  expect(row.textContent).toContain("Someone");
  expect(list.children[0].textContent).toContain("Priya");   // the author's name arrived: rows rebuilt inside the same scroller
  const row2 = list.children[0];
  port.here({ writers: [{ user: "pri", name: "Priya", role: "annotator" }], writerCount: 1, viewers: 10 });
  expect(list.children[0]).toBe(row2);
  // Pins are kept per thread.
  const pin = byClass(dom.root, "pin").find(p => p.getAttribute("data-thread") === "t");
  port.remote({ do: "reply", id: "r3", thread: "t", text: "again" }, "dev", "Dev");
  expect(byClass(dom.root, "pin").find(p => p.getAttribute("data-thread") === "t")).toBe(pin);
  expect(pin.textContent).toBe("4");
  collab.destroy();
});
