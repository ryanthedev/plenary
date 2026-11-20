// Trash over the DOM (web/adapters/dom/{toast,trash}.js over web/core/trash.js) on the collab tests' fake DOM: the Undo toast after Move to Trash (announced once, a countdown that holds while focus
// is inside and runs on clock.mono(), undo outcomes), the Trash page (a list with a Restore button per row, empty state, focus after a restore, failures) and the board-URL notice.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { showTrashToast } from "../../web/adapters/dom/toast.js";
import { mountTrashPage, mountTrashNotice } from "../../web/adapters/dom/trash.js";
import { createTrashModel, createNoticeModel, createTrashUndo, daysText, fromText, failText, restoredText, boardName } from "../../web/core/trash.js";
import { announced } from "../../web/adapters/dom/focus.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";

let root, focused, calls, clock;
const settle = () => new Promise(r => setTimeout(r, 0));
const all = (pred, from = root) => from.findAll(pred);
const btn = (text, from = root) => all(e => e.tagName === "BUTTON" && (textOf(e).trim() === text || e.getAttribute("aria-label") === text), from)[0];

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  globalThis.document.body = new FakeElement("body");
  calls = []; focused = []; clock = virtualClock();
  FakeElement.prototype.focus = function () { focused.push(this); globalThis.document.activeElement = this; };
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

// ---- the toast ----
const TRASHED = { board: { id: "b-1", title: "Roadmap <i>x</i>", space: { id: "s-1", name: "Design" } }, trashed: true, trashedAt: 1, expiresAt: 2, undo: { restore: true } };
const toast = async (result = TRASHED, o = {}) => {
  const restored = [], changes = [];
  const api = { restore: async (id, key) => { calls.push(["restore", id, key]); return o.out ?? { result: { board: result.board, restored: true } }; },
    restoreSpace: async (id, key) => { calls.push(["restoreSpace", id, key]); return o.out ?? { result: { space: result.space, restored: true, boards: 2 } }; } };
  const t = showTrashToast({ host: globalThis.document.body, api, kind: o.kind ?? "board", result, clock, newKey: () => "undo-key", onChange: () => changes.push(1), restoreFocus: () => restored.push(1) });
  return { t, restored, changes };
};
const toastEl = (label = "Board moved to Trash") => globalThis.document.body.findAll(e => e.getAttribute("aria-label") === label)[0];
const release = () => { globalThis.document.activeElement = null; toastEl()?.dispatch("focusout", { relatedTarget: null }); };

test("the toast: announced once with its Undo, a group not a live region, Undo gets focus, holds while focus is inside, lasts 10 seconds after, then goes", async () => {
  const { restored } = await toast();
  expect(toastEl().getAttribute("role")).toBe("group");
  expect(toastEl().getAttribute("aria-live")).toBeNull();
  expect(announced()).toContain("Moved Roadmap <i>x</i> to Trash. Undo is available for 10 seconds.");
  expect(textOf(toastEl())).toContain("Moved Roadmap <i>x</i> to Trash.");     // text only: never parsed as markup
  expect(toastEl().findAll(e => e.tagName === "I")).toEqual([]);
  expect(focused.at(-1).getAttribute("data-fk")).toBe("trash-undo");
  clock.advance(60_000); expect(toastEl()).toBeDefined();                       // focus is inside: the countdown holds
  release();
  clock.advance(9_999); expect(toastEl()).toBeDefined();
  clock.advance(1);
  expect(toastEl()).toBeUndefined();
  expect(restored.length).toBe(0);                                              // focus was already elsewhere
});
test("the countdown is counted on clock.mono(), not the wall clock", async () => {
  await toast(); release();
  const wall = clock.now; clock.now = () => 1e15;                              // the wall clock jumps; only mono() may count
  clock.advance(9_999); expect(toastEl()).toBeDefined();
  clock.advance(1); expect(toastEl()).toBeUndefined();
  clock.now = wall;
});
test("pointer over the toast and focus inside both hold the countdown; leaving resumes with what was left; Escape dismisses and returns focus", async () => {
  const { restored } = await toast(); release();
  clock.advance(2_000);
  toastEl().dispatch("mouseenter"); clock.advance(30_000); expect(toastEl()).toBeDefined();
  toastEl().dispatch("mouseleave"); clock.advance(7_999); expect(toastEl()).toBeDefined();
  toastEl().dispatch("focusin"); globalThis.document.activeElement = btn("Dismiss", toastEl()); clock.advance(30_000); expect(toastEl()).toBeDefined();
  toastEl().dispatch("keydown", { key: "Escape" });
  expect(toastEl()).toBeUndefined();
  expect(restored.length).toBe(1);
});
test("Undo restores under its own key, says so, calls onChange and goes after 4 s; a Space's Undo restores the Space", async () => {
  const { changes } = await toast();
  btn("Undo", toastEl()).click(); await settle();
  expect(calls).toEqual([["restore", "b-1", "undo-key"]]);
  expect(textOf(toastEl())).toContain("Restored Roadmap <i>x</i>.");
  expect(btn("Undo", toastEl())).toBeUndefined();
  expect(changes.length).toBe(1);
  release(); clock.advance(4_000); expect(toastEl()).toBeUndefined();
  calls.length = 0;
  const sp = { space: { id: "s-9", name: "Design" }, trashed: true, boards: 3, undo: { restore: true } };
  await toast(sp, { kind: "space" });
  expect(announced()).toContain("Moved Design to Trash with 3 boards.");
  btn("Undo", toastEl("Space moved to Trash")).click(); await settle();
  expect(calls).toEqual([["restoreSpace", "s-9", "undo-key"]]);
});
test("undo failures say why and keep the toast for 10 s: space in trash, deleted for good, not allowed; a result with no undo is a plain notice", async () => {
  for (const [error, text] of [["space-in-trash", "Space is in Trash"], ["purged", "deleted for good"], ["forbidden", "can't restore"]]) {
    await toast(TRASHED, { out: { error } });
    btn("Undo", toastEl()).click(); await settle();
    expect(textOf(toastEl())).toContain(text);
    toastEl().dispatch("keydown", { key: "Escape" });
  }
  await toast({ ...TRASHED, undo: null });
  expect(btn("Undo", toastEl())).toBeUndefined();
  expect(announced()).not.toContain("Undo is available");
});
test("a second click on Undo while the first is running restores once", async () => {
  await toast();
  const undo = btn("Undo", toastEl());
  undo.click(); undo.click(); await settle();
  expect(calls.length).toBe(1);
});

// ---- the Trash page ----
const BOARD = { type: "board", id: "b-1", title: "Roadmap <b>x</b>", from: { space: { id: "s-1", name: "Design", personal: false }, group: { id: "g-1", name: "Product" } }, by: { id: "google:ada", name: "Ada <u>" }, trashedAt: 1, expiresAt: 2, daysLeft: 27 };
const BOARD2 = { type: "board", id: "b-2", title: "Hush", from: { space: null, group: null }, by: null, trashedAt: 1, expiresAt: 2, daysLeft: 1 };
const SPACE = { type: "space", id: "s-2", name: "Old Space", group: { id: "g-1", name: "Product" }, boards: 4, by: { id: "google:ada", name: "Ada" }, trashedAt: 1, expiresAt: 2, daysLeft: 0 };
const page = async (list, o = {}) => {
  const api = { list: async () => (o.err ? { error: o.err } : { list: { items: list, more: o.more === true } }),
    restore: async (id, key) => { calls.push(["restore", id, key]); return o.out ?? { result: { restored: true } }; },
    restoreSpace: async (id, key) => { calls.push(["restoreSpace", id, key]); return o.out ?? { result: { restored: true } }; } };
  let n = 0;
  const model = createTrashModel({ api, newKey: () => `k${++n}` });
  const mounted = mountTrashPage({ root, model, hrefs: { home: "./" }, signIn: { href: "/auth/login" } });
  await model.load(); await settle();
  return { model, mounted };
};
const rows = () => all(e => e.tagName === "LI" && e.hasClass("trash-row"));

test("rows say what and where it was, who deleted it and the days left; each Restore names its row; text only", async () => {
  await page([BOARD, BOARD2, SPACE]);
  expect(textOf(all(e => e.tagName === "H1")[0])).toBe("Trash");
  expect(rows().length).toBe(3);
  const t = textOf(rows()[0]);
  expect(t).toContain("Roadmap <b>x</b>"); expect(t).toContain("Was in Product / Design"); expect(t).toContain("Deleted by Ada <u>"); expect(t).toContain("27 days left");
  expect(all(e => e.tagName === "B" || e.tagName === "U")).toEqual([]);
  expect(textOf(rows()[1])).toContain("Was in a Space you can't open"); expect(textOf(rows()[1])).toContain("1 day left");
  expect(textOf(rows()[2])).toContain("Old Space"); expect(textOf(rows()[2])).toContain("4 boards went with it"); expect(textOf(rows()[2])).toContain("Due to be deleted soon");
  expect(btn("Restore Roadmap <b>x</b>")).toBeDefined(); expect(btn("Restore Space Old Space")).toBeDefined();
  expect(all(e => e.getAttribute("aria-label") === "Trash" && e.tagName === "UL").length).toBe(1);
});
test("an empty Trash says so with the 30 days; more than listed says so", async () => {
  await page([]);
  expect(textOf(root)).toContain("Trash is empty."); expect(textOf(root)).toContain("Deleted boards stay here for 30 days.");
  expect(rows()).toEqual([]);
  root.replaceChildren();
  await page([BOARD], { more: true });
  expect(textOf(root)).toContain("More items are in the Trash than are listed here.");
});
test("Restore calls the API under a key, the row leaves, it is said once, and focus moves to the next row's Restore (the heading when it was the last)", async () => {
  const { model } = await page([BOARD, BOARD2, SPACE]);
  btn("Restore Roadmap <b>x</b>").click(); await settle(); await settle();
  expect(calls).toEqual([["restore", "b-1", "k1"]]);
  expect(rows().length).toBe(2);
  expect(announced()).toBe("Restored Roadmap <b>x</b>.");
  expect(focused.at(-1).getAttribute("aria-label")).toBe("Restore Hush");
  btn("Restore Space Old Space").click(); await settle(); await settle();
  expect(calls.at(-1)).toEqual(["restoreSpace", "s-2", "k2"]);
  expect(focused.at(-1).getAttribute("aria-label")).toBe("Restore Hush");
  btn("Restore Hush").click(); await settle(); await settle();
  expect(textOf(root)).toContain("Trash is empty.");
  expect(focused.at(-1).tagName).toBe("H1");
  expect(model.state.items).toEqual([]);
});
test("a failed Restore keeps the row, says why in the status line, and a retry reuses the same key", async () => {
  const { model } = await page([BOARD], { out: { error: "space-in-trash" } });
  btn("Restore Roadmap <b>x</b>").click(); await settle(); await settle();
  expect(rows().length).toBe(1);
  expect(textOf(all(e => e.hasClass("home-status"))[0])).toContain("Space is in Trash");
  expect(announced()).toContain("Space is in Trash");
  btn("Restore Roadmap <b>x</b>").click(); await settle(); await settle();
  expect(calls.map(c => c[2])).toEqual(["k1", "k1"]);
  expect(model.state.items.length).toBe(1);
});
test("a second click while a Restore is running restores once", async () => {
  let release;
  const api = { list: async () => ({ list: { items: [BOARD], more: false } }), restore: (id, key) => new Promise(r => { calls.push(["restore", id, key]); release = () => r({ result: { restored: true } }); }) };
  const model = createTrashModel({ api, newKey: () => "k" });
  mountTrashPage({ root, model, hrefs: { home: "./" } });
  await model.load();
  const b = btn("Restore Roadmap <b>x</b>");
  b.click(); b.click(); await settle();
  expect(calls.length).toBe(1);
  expect(b.getAttribute("aria-disabled") === "true" || textOf(btn("Restore Roadmap <b>x</b>")) === "Restoring…").toBe(true);
  release(); await settle(); await settle();
  expect(rows()).toEqual([]);
});
test("signed out, not available and a failed load each say so; Try again loads again", async () => {
  await page([], { err: "auth" }); expect(textOf(root)).toContain("You are signed out."); expect(all(e => e.tagName === "A" && e.getAttribute("href") === "/auth/login").length).toBe(1);
  root.replaceChildren(); await page([], { err: "forbidden" }); expect(textOf(root)).toContain("The Trash is not available.");
  root.replaceChildren(); const { model } = await page([], { err: "unavailable" }); expect(textOf(root)).toContain("Could not load the Trash.");
  expect(btn("Try again")).toBeDefined();
  void model;
});

// ---- the board-URL notice ----
const NOTICE = { board: { id: "b-1", title: "Roadmap" }, trashedAt: 1, expiresAt: 2, daysLeft: 28, canRestore: true, by: { id: "google:ada", name: "Ada" },
  from: { space: { id: "s-1", name: "Design", personal: false }, group: { id: "g-1", name: "Product" } } };
const notice = async (n, o = {}) => {
  const api = { notice: async () => (n === null ? { error: o.err ?? "forbidden" } : { notice: n }), restore: async (id, key) => { calls.push(["restore", id, key]); return o.out ?? { result: { restored: true } }; },
    restoreSpace: async (id, key) => { calls.push(["restoreSpace", id, key]); return o.out ?? { result: { restored: true } }; } };
  const model = createNoticeModel({ api, board: "b-1", newKey: () => "nk" });
  const opened = [];
  mountTrashNotice({ host: globalThis.document.body, model, homeHref: "./", onRestored: () => opened.push(1) });
  await model.load(); await settle();
  return { model, opened };
};
const gate = () => globalThis.document.body.findAll(e => e.getAttribute("id") === "trash-gate")[0];

test("the notice says the board is in Trash, who deleted it, where it was and the days left; focus is on its heading and it is said once", async () => {
  await notice(NOTICE);
  const t = textOf(gate());
  expect(t).toContain("This board is in Trash"); expect(t).toContain("28 days left"); expect(t).toContain("Deleted by Ada from Product / Design");
  expect(gate().getAttribute("role")).toBe("region");
  expect(focused.at(-1).tagName).toBe("H1");
  expect(announced()).toContain("This board is in Trash. Roadmap: 28 days left");
  expect(btn("Restore", gate())).toBeDefined();
  expect(all(e => e.tagName === "A" && e.getAttribute("href") === "./", gate()).length).toBe(1);
});
test("Restore calls restore under a key, then offers Open the board, which calls onRestored; a failure says why and keeps the button", async () => {
  const { opened } = await notice(NOTICE);
  btn("Restore", gate()).click(); await settle(); await settle();
  expect(calls).toEqual([["restore", "b-1", "nk"]]);
  expect(textOf(gate())).toContain("Board restored"); expect(textOf(gate())).toContain("Restored Roadmap.");
  expect(announced()).toContain("Restored Roadmap.");
  btn("Open the board", gate()).click();
  expect(opened.length).toBe(1);
  globalThis.document.body.replaceChildren(); calls.length = 0;
  await notice(NOTICE, { out: { error: "purged" } });
  btn("Restore", gate()).click(); await settle(); await settle();
  expect(textOf(gate())).toContain("deleted for good"); expect(btn("Restore", gate())).toBeDefined();
});
test("a person who could open it but may not restore it sees no who, no where and no Restore", async () => {
  await notice({ board: { id: "b-1", title: "Roadmap" }, trashedAt: 1, expiresAt: 2, daysLeft: 3, canRestore: false });
  const t = textOf(gate());
  expect(t).toContain("This board is in Trash"); expect(t).toContain("3 days left"); expect(t).toContain("Ask someone who can restore it.");
  expect(t).not.toContain("Deleted by");
  expect(btn("Restore", gate())).toBeUndefined();
});
test("a board that went with its Space restores the Space for those who may, and says so for those who may not", async () => {
  const via = { ...NOTICE, canRestore: false, via: { space: { id: "s-7", name: "Design", personal: false }, canRestore: true } };
  await notice(via);
  expect(textOf(gate())).toContain("It went to Trash with its Space, Design.");
  btn("Restore Design", gate()).click(); await settle(); await settle();
  expect(calls).toEqual([["restoreSpace", "s-7", "nk"]]);
  globalThis.document.body.replaceChildren(); calls.length = 0;
  await notice({ ...via, via: { space: null, canRestore: false } });
  expect(textOf(gate())).toContain("It went to Trash with its Space.");
  expect(all(e => e.tagName === "BUTTON", gate()).length).toBe(0);
});
test("any refusal or failure shows nothing: the page's own refusal stands", async () => {
  for (const err of ["forbidden", "notfound", "unavailable", "network", "auth"]) { globalThis.document.body.replaceChildren(); await notice(null, { err }); expect(gate()).toBeUndefined(); }
});
test("titles and names in the notice are text, never markup", async () => {
  await notice({ ...NOTICE, board: { id: "b-1", title: "<img src=x onerror=alert(1)>" }, by: { id: "u", name: "<script>x</script>" } });
  expect(gate().findAll(e => ["IMG", "SCRIPT"].includes(e.tagName))).toEqual([]);
  expect(textOf(gate())).toContain("<img src=x onerror=alert(1)>");
});

// ---- the words ----
test("daysText, fromText and failText", () => {
  expect([daysText(28), daysText(1), daysText(0)]).toEqual(["28 days left", "1 day left", "Due to be deleted soon"]);
  expect(fromText({ space: { name: "Design", personal: false }, group: { name: "Product" } })).toBe("Product / Design");
  expect(fromText({ space: { name: "ada's space", personal: true }, group: null })).toBe("Personal space");
  expect(fromText({ space: null, group: null })).toBe("a Space you can't open");
  expect(failText("with-space")).toContain("Restore the Space"); expect(failText("unavailable")).toContain("Trying again unchanged is safe"); expect(failText("weird")).toBe("Something went wrong.");
});
test("createTrashUndo with no undo offers nothing and runs nothing", async () => {
  const u = createTrashUndo({ api: { restore: async () => { throw new Error("no"); } }, kind: "board", id: "b-1", name: "x", undo: null });
  expect(u.available).toBe(false);
  expect(await u.run()).toEqual({ ok: false, text: "" });
});

test("#54 wording: a restore into the personal space says where it went (toast and Trash page), the escalation refusal explains itself", async () => {
  const to = { id: "s-9", name: "ada's space", personal: true };
  expect(restoredText("Roadmap", to)).toBe("Restored Roadmap to your personal space.");
  expect(restoredText("Roadmap")).toBe("Restored Roadmap.");
  const api = { restore: async () => ({ result: { board: { id: "b-1", title: "Roadmap", space: { id: "s-9", name: "x" } }, restored: true, movedTo: to } }) };
  expect(await createTrashUndo({ api, kind: "board", id: "b-1", name: "Roadmap", undo: { restore: true } }).run()).toEqual({ ok: true, text: "Restored Roadmap to your personal space." });
  expect(failText("would-escalate")).toContain("higher role");
  const notice = createNoticeModel({ api: { notice: async () => ({ notice: { board: { id: "b-1", title: "Roadmap" }, daysLeft: 3, canRestore: true, into: to } }), restore: api.restore }, board: "b-1" });
  await notice.load();
  await notice.restore();
  expect(notice.state.message).toBe("Restored Roadmap to your personal space.");
});

test("a hidden title shows the placeholder, never 'Untitled' or a blank, on the Trash page and in the notice; an empty title is still Untitled", async () => {
  const { title, ...hidden } = BOARD;
  await page([hidden]);
  expect(textOf(all(e => e.hasClass("t"), rows()[0])[0])).toBe("A board you can't open");   // a heading: capitalised
  expect(btn("Restore a board you can't open")).toBeDefined();
  expect(boardName(undefined)).toBe("a board you can't open"); expect(boardName(undefined, { start: true })).toBe("A board you can't open"); expect(boardName("roadmap", { start: true })).toBe("roadmap"); expect(boardName("")).toBe("Untitled"); expect(boardName("Roadmap")).toBe("Roadmap");
  expect(restoredText(boardName(undefined))).toBe("Restored a board you can't open.");
});

test("the notice opens a sentence with 'A board you can't open' (capitalised, said once) while a title stays as written", async () => {
  await notice({ ...NOTICE, board: { id: "b-1" } });
  expect(textOf(gate())).toContain("A board you can't open: 28 days left");
  expect(announced()).toContain("A board you can't open: 28 days left");
  expect(textOf(gate())).not.toContain("a board you can't open:");
});
