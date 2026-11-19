// The Move dialog and the Undo toast (web/adapters/dom/move.js over web/core/move.js) on the collab tests' fake DOM: a real modal, a radio group of destinations, the diff as
// headed lists said once, Move off until the diff has loaded, focus to the toast's Undo after a move, the toast's keyboard, expiry, undo outcomes and text safety.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { openMove, showMoveToast } from "../../web/adapters/dom/move.js";
import { createMoveModel } from "../../web/core/move.js";
import { announced } from "../../web/adapters/dom/focus.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";

const R = (id, name) => ({ id, name });
const OPTIONS = { board: { id: "b-1", title: "Roadmap <i>x</i>" }, from: { id: "s-1", name: "Mine", personal: true }, destinations: [{ id: "s-2", name: "Design", personal: false, general: "viewer", group: { id: "g-1", name: "Product" } }, { id: "s-3", name: "<b>Plat</b>", personal: false, general: null, group: null }], more: false };
const DIFF = to => ({ board: { id: "b-1", title: "Roadmap" }, from: OPTIONS.from, to: { id: to, name: "x", personal: false },
  gains: [{ subject: { type: "team", name: "Design team <u>" }, before: null, after: R("editor", "Editor") }], keeps: [{ subject: { type: "user", name: "Ada" }, self: true, before: R("owner", "Owner"), after: R("owner", "Owner") }], loses: [], invites: 1, links: null, hidden: true, more: false });
const RESULT = { board: { id: "b-1", title: "Roadmap", space: { id: "s-2", name: "Design" } }, moved: true, undo: { space: { id: "s-1", name: "Mine", personal: true } } };
let root, focused, calls, moveOut, clock;
const settle = () => new Promise(r => setTimeout(r, 0));
const all = pred => root.findAll(pred);
const btn = text => all(e => e.tagName === "BUTTON").find(b => textOf(b).trim() === text || b.getAttribute("aria-label") === text);

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  globalThis.document.body = new FakeElement("body");
  calls = []; focused = []; moveOut = { result: RESULT }; clock = virtualClock();
  FakeElement.prototype.focus = function () { focused.push(this); globalThis.document.activeElement = this; };
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

const port = () => ({ options: async () => ({ options: OPTIONS }), preview: async (b, to) => { calls.push(["preview", to]); return { diff: DIFF(to) }; },
  move: async (b, body, key) => { calls.push(["move", body, key]); return moveOut; } });
async function open() {
  const p = port(), moved = [], opener = { focus: () => focused.push("opener") };
  const model = createMoveModel({ move: p, board: "b-1", newKey: () => "key-1" });
  const d = openMove({ host: root, model, opener, onMoved: r => moved.push(r) });
  await settle(); await settle();
  return { d, model, moved, p };
}
const radio = id => all(e => e.tagName === "INPUT" && e.getAttribute("type") === "radio").find(r => r.value === id);
const choose = async id => { const r = radio(id); r.checked = true; r.dispatch("change", { target: r }); await settle(); };

test("a real modal: role, aria-modal, labelled; Escape closes and focus returns to the opener; the destinations are a labelled radio group", async () => {
  const { d } = await open();
  const dlg = all(e => e.getAttribute("role") === "dialog")[0];
  expect(dlg.getAttribute("aria-modal")).toBe("true");
  expect(textOf(all(e => e.getAttribute("id") === dlg.getAttribute("aria-labelledby"))[0])).toBe("Move board");
  expect(all(e => e.getAttribute("role") === "radiogroup" && e.getAttribute("aria-label") === "Move to").length).toBe(1);
  expect(all(e => e.getAttribute("type") === "radio").length).toBe(2);
  expect(textOf(root)).toContain("Product / Design");
  d.el.dispatch("keydown", { key: "Escape" });
  expect(all(e => e.getAttribute("role") === "dialog")).toEqual([]);
  expect(focused.at(-1)).toBe("opener");
});
test("Move stays off until the diff has loaded; choosing shows three headed lists, invites under keeps, the hidden note, and says it once", async () => {
  await open();
  const go = btn("Move");
  expect(go.getAttribute("aria-disabled")).toBe("true");
  await choose("s-2");
  expect(go.getAttribute("aria-disabled")).toBe("false");
  for (const h of ["Gains access", "Keeps access", "Loses access"]) expect(all(e => e.tagName === "SECTION" && e.getAttribute("aria-label") === h).length).toBe(1);
  const t = textOf(root);
  expect(t).toContain("Design team <u>"); expect(t).toContain("Editor"); expect(t).toContain("You · Owner"); expect(t).toContain("1 invite keep working."); expect(t).toContain("Some access comes from places you can't open.");
  expect(all(e => e.tagName === "U")).toEqual([]);                                  // names are text
  expect(announced()).toContain("Gains access: Design team <u> (Editor).");
});
test("submit moves under one key, closes the dialog and reports the result; the opener is not refocused (its card is gone)", async () => {
  const { moved } = await open();
  await choose("s-2");
  all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "move")).toEqual([["move", { from: "s-1", to: "s-2" }, "key-1"]]);
  expect(moved).toEqual([RESULT]);
  expect(all(e => e.getAttribute("role") === "dialog")).toEqual([]);
  expect(focused.includes("opener")).toBe(false);
});
test("submitting before a diff loads does nothing; a refused move shows its sentence and keeps the dialog", async () => {
  await open();
  all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "move")).toEqual([]);
  moveOut = { error: "forbidden" };
  await choose("s-3");
  all(e => e.tagName === "FORM")[0].dispatch("submit"); await settle();
  expect(textOf(root)).toContain("You can't move this board there.");
  expect(all(e => e.getAttribute("role") === "dialog").length).toBe(1);
});
test("a forbidden mover is told so and has no controls to reach", async () => {
  const model = createMoveModel({ move: { options: async () => ({ error: "forbidden" }) }, board: "b-1" });
  openMove({ host: root, model, onMoved() {} }); await settle(); await settle();
  expect(textOf(root)).toContain("Only people who can move this board can do it.");
  expect(all(e => e.getAttribute("type") === "radio")).toEqual([]);
});

const toast = async (result = RESULT, o = {}) => {
  const restored = [], changes = [];
  const mv = { move: async (b, body, key) => { calls.push(["undo", body, key]); return o.out ?? { result: RESULT }; } };
  const t = showMoveToast({ host: globalThis.document.body, move: mv, board: "b-1", result, clock, newKey: () => "undo-key", onChange: () => changes.push(1), restoreFocus: () => restored.push(1) });
  return { t, restored, changes };
};
const toastEl = () => globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Board moved")[0];

test("the toast: announced once, not a live region itself, Undo gets focus, lasts 10 seconds, then goes and returns focus to the page", async () => {
  const { restored } = await toast();
  expect(toastEl().getAttribute("role")).toBe("group");
  expect(announced()).toContain("Moved Roadmap to Design.");
  expect(focused.at(-1).getAttribute("data-fk")).toBe("move-undo");
  clock.advance(9_999); expect(toastEl()).toBeDefined();
  clock.advance(1);
  expect(globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Board moved")).toEqual([]);
  expect(restored.length).toBe(1);
});
test("Escape dismisses the toast and returns focus; focus elsewhere is left alone", async () => {
  const { restored } = await toast();
  toastEl().dispatch("keydown", { key: "Escape" });
  expect(globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Board moved")).toEqual([]);
  expect(restored.length).toBe(1);
  const again = await toast(); globalThis.document.activeElement = null;
  again.t.dismiss(); expect(again.restored.length).toBe(0);
});
test("Undo moves back under its own key, says so, refreshes the page and goes after 4 seconds; the 10 s timer does not cut a running undo", async () => {
  const { changes } = await toast(RESULT, { out: { result: { ...RESULT, board: { ...RESULT.board, space: { id: "s-1", name: "Mine" } } } } });
  clock.advance(9_000);
  globalThis.document.body.findAll(e => e.getAttribute("data-fk") === "move-undo")[0].dispatch("click"); await settle();
  expect(calls.filter(c => c[0] === "undo")).toEqual([["undo", { from: "s-2", to: "s-1" }, "undo-key"]]);
  expect(textOf(toastEl())).toContain("Moved Roadmap back to Mine.");
  expect(changes.length).toBe(1);
  clock.advance(1_500); expect(toastEl()).toBeDefined();
  clock.advance(4_000); expect(globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Board moved")).toEqual([]);
});
test("Undo outcomes: moved again, no longer allowed", async () => {
  await toast(RESULT, { out: { error: "moved" } });
  globalThis.document.body.findAll(e => e.getAttribute("data-fk") === "move-undo")[0].dispatch("click"); await settle();
  expect(textOf(toastEl())).toContain("Can't undo: the board has been moved again.");
  expect(announced()).toContain("Can't undo");
});
test("no undo offered: a plain notice with only Dismiss", async () => {
  await toast({ ...RESULT, undo: null });
  expect(globalThis.document.body.findAll(e => e.getAttribute("data-fk") === "move-undo")).toEqual([]);
  expect(announced()).not.toContain("Undo is available");
});

const gone = () => globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Board moved").length === 0;
test("MED-2: the 10 s countdown pauses while the pointer is over the toast and resumes with what was left", async () => {
  await toast();
  clock.advance(6_000);
  toastEl().dispatch("mouseenter");
  clock.advance(60_000); expect(gone()).toBe(false);
  toastEl().dispatch("mouseleave");
  clock.advance(3_999); expect(gone()).toBe(false);
  clock.advance(1); expect(gone()).toBe(true);
});
test("MED-2: focus the person moves within the toast holds it; focus lost to nowhere resumes it; focus moved out dismisses it without pulling focus back", async () => {
  const { restored } = await toast();
  clock.advance(2_000);
  toastEl().dispatch("focusin");                                          // the person Tabs to Dismiss / clicks in
  clock.advance(60_000); expect(gone()).toBe(false);
  const dismiss = globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Dismiss")[0];
  toastEl().dispatch("focusout", { relatedTarget: dismiss });             // within the toast: still held after focusin again
  toastEl().dispatch("focusin");
  clock.advance(60_000); expect(gone()).toBe(false);
  toastEl().dispatch("focusout", { relatedTarget: null });                // a click on the page or a window switch: the countdown resumes with the 8 s left
  clock.advance(7_999); expect(gone()).toBe(false);
  clock.advance(1); expect(gone()).toBe(true);
  expect(restored.length).toBe(1);                                         // it went by the clock while focus was inside, so focus returns to the page
  const again = await toast(); const outside = new FakeElement("button");
  toastEl().dispatch("focusin");
  toastEl().dispatch("focusout", { relatedTarget: outside });
  expect(gone()).toBe(true); expect(again.restored.length).toBe(0);        // Tab out: dismissed, focus stays where the person put it
});
test("MED-2: the page's own focus on Undo does not hold the countdown (a person who does nothing still sees it go)", async () => {
  await toast();
  expect(focused.at(-1).getAttribute("data-fk")).toBe("move-undo");
  clock.advance(10_000); expect(gone()).toBe(true);
});
test("MED-2: a running Undo is not cut by the countdown, even while the pointer is away", async () => {
  await toast(RESULT, { out: { result: RESULT } });
  clock.advance(9_000);
  globalThis.document.body.findAll(e => e.getAttribute("data-fk") === "move-undo")[0].dispatch("click"); await settle();
  clock.advance(3_999); expect(gone()).toBe(false);
  clock.advance(1); expect(gone()).toBe(true);
});
test("MED-2: Tab off the last button, or Shift+Tab off the first, dismisses the toast and leaves focus to the browser", async () => {
  const a = await toast();
  const [undoB, dismissB] = [globalThis.document.body.findAll(e => e.getAttribute("data-fk") === "move-undo")[0], globalThis.document.body.findAll(e => e.getAttribute("aria-label") === "Dismiss")[0]];
  globalThis.document.activeElement = undoB; toastEl().dispatch("keydown", { key: "Tab" }); expect(gone()).toBe(false);          // inside: Tab goes on to Dismiss
  globalThis.document.activeElement = dismissB; toastEl().dispatch("keydown", { key: "Tab", shiftKey: true }); expect(gone()).toBe(false);
  toastEl().dispatch("keydown", { key: "Tab" });
  expect(gone()).toBe(true); expect(a.restored.length).toBe(0);
  await toast(); globalThis.document.activeElement = globalThis.document.body.findAll(e => e.getAttribute("data-fk") === "move-undo")[0];
  toastEl().dispatch("keydown", { key: "Tab", shiftKey: true });
  expect(gone()).toBe(true);
});
