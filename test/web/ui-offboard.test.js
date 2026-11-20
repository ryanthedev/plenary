// The leaver screen over the DOM (web/adapters/dom/offboard.js over web/core/offboard.js) on the collab tests' fake DOM: finding a person, the table of what they solely own with a labelled
// picker per row, the confirm dialog that lists exactly what moves where, the one-at-a-time apply, the removal that stays locked until the list is empty, and failures that are kept and said.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { mountOffboardPage } from "../../web/adapters/dom/offboard.js";
import { createOffboardModel, planLine, failText } from "../../web/core/offboard.js";
import { announced } from "../../web/adapters/dom/focus.js";

let root, calls;
const settle = () => new Promise(r => setTimeout(r, 20));
const all = (pred, from = root) => from.findAll(pred);
const btn = text => all(e => e.tagName === "BUTTON" && textOf(e).trim() === text)[0];
const ROOT = { id: "google:root", name: "Root" }, ADA = { id: "google:ada", name: "Ada" };
const item = (o = {}) => ({ type: "space", id: "s-1", name: "Sam's space", personal: true, archived: false, trashed: false, boards: 14, boardsCapped: false, can: { reassign: false, handover: true, why: "Goes with the removal" }, ...o });
const ITEMS = [item(), item({ id: "s-2", name: "Field <i>notes</i>", personal: false, boards: 1, can: { reassign: true } }), item({ type: "group", id: "g-1", name: "Research", personal: false, boards: undefined, can: { reassign: false, why: "Needs a Unit admin" } })];

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  globalThis.document.body = new FakeElement("body");
  calls = [];
  FakeElement.prototype.focus = function () { globalThis.document.activeElement = this; };
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });

const page = (items = ITEMS, o = {}) => ({ page: { member: { id: "google:sam", name: "Sam", email: "sam@acme.com", removed: false }, defaults: { recipient: ROOT, reason: "remover" }, items, next: null, blocked: null, canRemove: items.length === 0, ...o } });
const mount = async (o = {}) => {
  let items = o.items ?? ITEMS, n = 0, gone = false;
  const api = {
    list: async user => { calls.push(["list", user]); const p = page(items, o.page); if (gone) { p.page.member.removed = true; p.page.canRemove = false; } return p; },
    reassign: async (user, it, key) => { calls.push(["reassign", user, it, key]); if (o.fail?.(it)) return o.fail(it); items = items.filter(i => i.id !== it.id); return { result: { item: { type: it.type, id: it.id, name: it.id, archived: it.id === "s-1" }, to: it.to === ADA.id ? ADA : ROOT, done: true } }; },
    remove: async (user, to, key) => { calls.push(["remove", user, to, key]); if (!o.removeOut) gone = true; return o.removeOut ?? { result: { removed: true, grants: 1, scopedGrants: 0, teams: 0 } }; },
    people: async q => { calls.push(["people", q]); return { people: [ADA] }; },
  };
  const model = createOffboardModel({ api, newKey: () => `k${++n}` });
  mountOffboardPage({ root, model, hrefs: { home: "./" }, signIn: { href: "/auth/login" }, start: "google:sam" });
  await settle();
  return { model, api };
};

test("the table names each item with its board count, a labelled picker defaulting to the remover, and says why a row can't be handed on; text only", async () => {
  await mount();
  expect(textOf(all(e => e.tagName === "H1")[0])).toBe("Offboard a member");
  const t = textOf(root);
  expect(t).toContain("Sam's space (14 boards)"); expect(t).toContain("Field <i>notes</i> (1 board)"); expect(t).toContain("Needs a Unit admin");
  expect(all(e => e.tagName === "I")).toEqual([]);
  const sel = all(e => e.tagName === "SELECT");
  expect(sel.map(s => s.getAttribute("aria-label"))).toEqual(["New owner of Sam's space", "New owner of Field <i>notes</i>"]);
  expect(textOf(root)).toContain("Root (you)");
  expect(all(e => e.tagName === "TABLE")[0].findAll(e => e.tagName === "CAPTION").length).toBe(1);
  expect(btn("Remove Sam…").getAttribute("aria-disabled")).toBe("true");
});
test("Review lists exactly what moves where in a dialog; Cancel changes nothing; Reassign applies one item at a time under their own keys and says the result", async () => {
  const { model } = await mount();
  btn("Review and reassign…").click(); await settle();
  const d = all(e => e.getAttribute("role") === "dialog")[0];
  expect(d.getAttribute("aria-modal")).toBe("true");
  expect(textOf(d)).not.toContain("Sam's space");                                  // a personal space is never reassigned on its own: it goes with the removal
  expect(textOf(d)).toContain("Field <i>notes</i> (1 board) will be owned by Root.");
  expect(textOf(d)).toContain("Not included, needs a Unit admin: Research");
  all(e => e.tagName === "BUTTON" && textOf(e) === "Cancel", d)[0].click(); await settle();
  expect(all(e => e.getAttribute("role") === "dialog")).toEqual([]);
  expect(calls.filter(c => c[0] === "reassign")).toEqual([]);
  btn("Review and reassign…").click(); await settle();
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  const re = calls.filter(c => c[0] === "reassign");
  expect(re.map(c => [c[2].id, c[2].to])).toEqual([["s-2", ROOT.id]]);
  expect(all(e => e.getAttribute("role") === "dialog")).toEqual([]);
  expect(announced()).toContain("1 item reassigned");
  expect(model.state.items.map(i => i.id)).toEqual(["s-1", "g-1"]);
});
test("another new owner: search, add, then pick it in a row; the plan names them", async () => {
  const { model } = await mount();
  const form = all(e => e.tagName === "FORM" && e.getAttribute("aria-label") === "Find a new owner")[0];
  all(e => e.tagName === "INPUT", form)[0].value = "ad"; form.dispatch("submit"); await settle();
  expect(calls.at(-1)).toEqual(["people", "ad"]);
  all(e => e.tagName === "BUTTON" && textOf(e) === "Ada")[0].click(); await settle();
  const sel = all(e => e.tagName === "SELECT")[1];                                  // [0] is the personal space's (hand-over) picker
  expect(all(e => e.tagName === "OPTION", sel).map(o => textOf(o))).toEqual(["Root (you)", "Ada"]);
  sel.value = ADA.id; sel.dispatch("change", { target: sel }); await settle();
  expect(model.recipientOf(model.state.items[1])).toEqual(ADA);
  expect(model.recipientOf(model.state.items[0])).toEqual(ROOT);
  expect(all(e => e.tagName === "SELECT").map(s => s.getAttribute("aria-disabled"))).toEqual(["false", "false"]);
  expect(planLine(model.state.items[1], ADA)).toBe("Field <i>notes</i> (1 board) will be owned by Ada.");
});
test("a failed item keeps its sentence in its row and the rest are still tried; nothing is hidden", async () => {
  await mount({ fail: it => (it.id === "s-2" ? { error: "forbidden" } : null) });
  btn("Review and reassign…").click(); await settle();
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "reassign").length).toBe(1);
  expect(textOf(root)).toContain("Not done. You can't do that.");
  expect(announced()).toContain("1 failed");
});
test("removal stays locked while items remain; once the list is empty its dialog says what happens and Remove runs under one key", async () => {
  const { model } = await mount({ items: [] });
  expect(textOf(root)).toContain("Sam solely owns nothing.");
  expect(btn("Remove Sam…").getAttribute("aria-disabled")).toBe("false");
  btn("Remove Sam…").click(); await settle();
  const d = all(e => e.getAttribute("role") === "dialog")[0];
  expect(textOf(d)).toContain("Boards, their addresses, and guests' access stay.");
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "remove")).toEqual([["remove", "google:sam", null, "k1"]]);
  expect(announced()).toContain("Sam was removed from the Unit.");
  expect(model.state.status).toBe("ready");
});
test("a still-owns refusal on removal is said and the list is reloaded", async () => {
  const { model } = await mount({ items: [], removeOut: { error: "conflict", code: "still-owns" } });
  btn("Remove Sam…").click(); await settle();
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  expect(model.state.notice).toBe(failText("conflict", "still-owns"));
  expect(calls.filter(c => c[0] === "list").length).toBe(2);
});
test("a person the Unit never saw, a caller who may not, and a signed-out page each say so", async () => {
  for (const [error, text] of [["notfound", "This person is not available."], ["forbidden", "This is not available."], ["auth", "You are signed out."]]) {
    const dom = installDom(); root = dom.root;
    const model = createOffboardModel({ api: { list: async () => ({ error }), people: async () => ({ people: [] }) } });
    mountOffboardPage({ root, model, hrefs: { home: "./" }, signIn: { href: "/auth/login" }, start: "google:sam" });
    await settle();
    expect(textOf(root)).toContain(text);
  }
});
test("an admin leaver is shown as not removable and offers no Remove", async () => {
  await mount({ items: [], page: { blocked: "admin", canRemove: false } });
  expect(textOf(root)).toContain("is a Unit admin and can't be removed here.");
  expect(btn("Remove Sam…")).toBeUndefined();
});

test("HIGH-2: the personal space goes with the removal to the chosen person; the dialog says so and the call carries the new owner under one key", async () => {
  const { model } = await mount({ items: [item()], page: { canRemove: true } });
  expect(textOf(root)).toContain("Goes with the removal");
  const sel = all(e => e.tagName === "SELECT")[0];
  sel.value = ADA.id; model.addKnown(ADA); await settle();
  const sel2 = all(e => e.tagName === "SELECT")[0];
  sel2.value = ADA.id; sel2.dispatch("change", { target: sel2 }); await settle();
  btn("Remove Sam…").click(); await settle();
  expect(textOf(all(e => e.getAttribute("role") === "dialog")[0])).toContain("Sam's space (14 boards) will be owned by Ada, as an archived Space.");
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  expect(calls.filter(c => c[0] === "remove")).toEqual([["remove", "google:sam", ADA.id, "k1"]]);
});
test("HIGH-2: a manage-only admin sees why the personal space is not theirs to hand over, no default recipient is promised, and Remove is locked", async () => {
  const hidden = item({ can: { reassign: false, handover: false, why: "Private to its owner: needs board-content access" } });
  await mount({ items: [hidden], page: { canRemove: false } });
  const t = textOf(root);
  expect(t).toContain("Private to its owner: needs board-content access");
  expect(t).toContain("You can't hand on any of their items.");
  expect(t).not.toContain("unless you pick someone else");
  expect(all(e => e.tagName === "SELECT")).toEqual([]);
  expect(btn("Remove Sam…").getAttribute("aria-disabled")).toBe("true");
  expect(btn("Review and reassign…").getAttribute("aria-disabled")).toBe("true");
});
test("MED-1: focus lands on a live control of the current page after Reassign, a recipient change and Remove (never on a node a redraw replaced)", async () => {
  const live = () => { const a = globalThis.document.activeElement; return !!a && root.contains(a); };
  const { model } = await mount({ items: [item({ can: { reassign: true } }), item({ type: "group", id: "g-1", name: "Research", personal: false, can: { reassign: false, why: "x" } })], page: { canRemove: false } });
  model.addKnown(ADA); await settle();
  const sel = all(e => e.tagName === "SELECT")[0];
  sel.value = ADA.id; sel.dispatch("change", { target: sel }); await settle();
  expect(live()).toBe(true);
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("pick:space:s-1");
  btn("Review and reassign…").click(); await settle();
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  expect(live()).toBe(true);
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("review");
});
test("MED-1: after Remove succeeds the Remove button is gone and focus falls back to the page heading, inside the page", async () => {
  await mount({ items: [] });
  btn("Remove Sam…").click(); await settle();
  all(e => e.tagName === "FORM", all(e => e.getAttribute("role") === "dialog")[0])[0].dispatch("submit"); await settle();
  const a = globalThis.document.activeElement;
  expect(root.contains(a)).toBe(true);
  expect(a.tagName).toBe("H1");
});
test("MED-1b: Enter in a search box and Enter on a match keep focus on a live, keyed control of the current page (the owner search keeps it; picking a person lands on the heading)", async () => {
  const fk = () => globalThis.document.activeElement?.getAttribute?.("data-fk");
  const live = () => !!globalThis.document.activeElement && root.contains(globalThis.document.activeElement);
  // "Find a new owner": submit with focus in the input, then press a match
  await mount();
  let form = all(e => e.tagName === "FORM" && e.getAttribute("aria-label") === "Find a new owner")[0];
  let input = all(e => e.tagName === "INPUT", form)[0];
  input.value = "ad"; input.focus(); form.dispatch("submit"); await settle();
  expect([live(), fk()]).toEqual([true, "find:offboard-owner"]);
  const match = all(e => e.tagName === "BUTTON" && textOf(e) === "Ada")[0];
  expect(match.getAttribute("data-fk")).toBe("match:offboard-owner:google:ada");
  match.focus(); match.click(); await settle();
  expect([live(), fk()]).toEqual([true, "find:offboard-owner"]);                    // the picked match is offered in every row now; focus returns to the box
  // "Find a person": submit keeps the box, picking a match opens the person and lands on the heading
  const dom = installDom(); root = dom.root;
  const model = createOffboardModel({ api: { list: async () => page(ITEMS), people: async () => ({ people: [{ id: "google:sam", name: "Sam" }] }) } });
  mountOffboardPage({ root, model, hrefs: { home: "./" }, signIn: null });
  form = all(e => e.tagName === "FORM" && e.getAttribute("aria-label") === "Find a person")[0];
  input = all(e => e.tagName === "INPUT", form)[0];
  input.value = "sa"; input.focus(); form.dispatch("submit"); await settle();
  expect([live(), fk()]).toEqual([true, "find:offboard-find"]);
  const sam = all(e => e.tagName === "BUTTON" && textOf(e) === "Sam")[0];
  sam.focus(); sam.click(); await settle();
  expect([live(), fk()]).toEqual([true, "heading"]);
  expect(globalThis.document.activeElement.tagName).toBe("H1");
});
