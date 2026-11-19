// The Roles screen (web/adapters/dom/roles.js over web/core/role-admin.js) on the collab tests' fake DOM: what renders, the matrix's real checkboxes and
// their names, keys and focus (exact key only, a neutral name when it is gone), aria-disabled while pending, announcements, the many-people confirmation, delete,
// duplicate, and text safety.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { FakeElement, installDom, textOf } from "./collab/fake-dom.js";
import { mountRolesPage } from "../../web/adapters/dom/roles.js";
import { createRolesModel } from "../../web/core/role-admin.js";
import { announce, announced, keeper } from "../../web/adapters/dom/focus.js";

const SC = ["unit", "group", "space", "board"];
const MATRIX = { scopes: SC, permissions: [
  { id: "board.view", group: "content", scopes: SC }, { id: "board.comment", group: "content", scopes: SC }, { id: "board.annotate", group: "content", scopes: SC }, { id: "board.edit", group: "content", scopes: SC },
  { id: "board.create", group: "management", scopes: ["unit", "group", "space"] }, { id: "move", group: "management", scopes: SC }, { id: "roles.manage", group: "management", scopes: ["unit"] }],
  content: { viewer: ["board.view"], commenter: ["board.view", "board.comment"], annotator: ["board.view", "board.comment", "board.annotate"], editor: ["board.view", "board.comment", "board.annotate", "board.edit"] },
  ladders: ["viewer", "commenter", "annotator", "editor"], tickable: ["board.create", "move"] };
const role = (id, name, kind, o = {}) => ({ id, name, kind, editable: kind !== "builtin", ladder: null, permissions: [], scopes: { unit: [], group: [], space: [], board: [] }, used: null, ...o });
const PAGE = () => ({ roles: [role("viewer", "Viewer", "builtin", { ladder: "viewer" }), role("owner", "Owner", "builtin", { ladder: "owner", permissions: ["board.create", "move"] }),
  role("member", "Unit member", "member", { permissions: ["board.create"], used: { members: 12, capped: false } }),
  role("r-fac", "Facilitator", "custom", { ladder: "annotator", permissions: ["board.create"], used: { places: 4, capped: false } }), role("r-ops", "Ops", "custom", { ladder: "viewer", used: { places: 0, capped: false } })],
  matrix: MATRIX, can: { admin: true }, limits: { custom: 50, many: { places: 10, people: 50 } } });
const hrefs = { home: "./" };
let root, api, calls, focused, page, answers;
const settle = () => new Promise(r => setTimeout(r, 0));
const all = pred => root.findAll(pred);
const btn = text => all(e => e.tagName === "BUTTON" && (textOf(e).trim() === text || e.getAttribute("aria-label") === text))[0];
const byKey = k => all(e => e.getAttribute("data-fk") === k)[0];
const items = label => all(e => e.tagName === "UL" && e.getAttribute("aria-label") === label)[0]?.findAll(e => e.tagName === "LI") ?? [];
const on = e => e.checked === true || e.getAttribute("checked") === "";
const hold = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };

beforeEach(() => {
  const dom = installDom(); root = dom.root;
  globalThis.Node = Object.getPrototypeOf(FakeElement);
  globalThis.document.addEventListener = () => {}; globalThis.document.removeEventListener = () => {};
  globalThis.document.body = new FakeElement("body");
  announce("");                                                 // the live region outlives a test: start each from silence
  calls = []; focused = []; page = PAGE(); answers = {};
  FakeElement.prototype.focus = function () { focused.push(this); globalThis.document.activeElement = this; };
  api = {
    roles: async () => ({ page: structuredClone(page) }),
    createRole: async a => { calls.push(["createRole", a]); return answers.createRole?.(a) ?? { role: role("r-new", a.name, "custom", { ladder: a.boardRole, permissions: a.permissions, base: a.base, used: { places: 0, capped: false } }) }; },
    updateRole: async (id, p) => { calls.push(["updateRole", id, p]); return answers.updateRole?.(id, p) ?? { role: { ...structuredClone(page.roles.find(r => r.id === id)), ...(p.name ? { name: p.name } : {}), ...(p.permissions ? { permissions: p.permissions } : {}), ...(p.boardRole ? { ladder: p.boardRole } : {}) } }; },
    removeRole: async id => { calls.push(["removeRole", id]); return answers.removeRole?.(id) ?? {}; },
  };
});
afterEach(() => { delete globalThis.document; delete globalThis.Node; });
async function mount(o = {}) { const model = createRolesModel({ api, newKey: () => "key-12345" }); mountRolesPage({ root, model, hrefs, ...o }); await model.load(); await settle(); return model; }

test("the list: named list items with kind and use, custom first selected; a built-in's detail is read-only with every checkbox aria-disabled", async () => {
  await mount();
  expect(items("Roles").map(li => li.getAttribute("aria-label"))).toEqual(["Viewer, Built-in, read-only", "Owner, Built-in, read-only", "Unit member, Built-in, permissions editable, Everyone in the organization (12 people)",
    "Facilitator, Custom, Used in 4 places", "Ops, Custom, Not used yet"]);
  expect(textOf(byKey("heading-detail"))).toBe("Facilitator");
  btn("Owner").click(); await settle();
  expect(textOf(byKey("heading-detail"))).toBe("Owner");
  expect(textOf(root)).toContain("Built-in roles are read-only. Duplicate one to make your own.");
  const boxes = all(e => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox");
  expect(boxes.length).toBe(3);                                           // the management permissions; content ones are set by the board step
  for (const b of boxes) expect([b.getAttribute("aria-disabled"), b.disabled]).toEqual(["true", false]);
  expect(btn("Save role")).toBeUndefined();
  expect(btn("Duplicate")).toBeTruthy();
  expect(btn("Delete role…")).toBeUndefined();
});

test("the matrix: a scrollable named region, a table with column and row headers, a checkbox named by its permission, cells that say where it applies", async () => {
  await mount();
  const region = all(e => e.getAttribute("aria-label") === "Permission matrix")[0];
  expect([region.getAttribute("role"), region.getAttribute("tabindex")]).toEqual(["region", "0"]);
  const heads = all(e => e.tagName === "TH" && e.getAttribute("scope") === "col").map(textOf);
  expect(heads).toEqual(["Permission", "Granted", "Organization", "Group", "Space", "Board"]);
  const box = byKey("perm:board.create");
  expect([box.getAttribute("type"), box.getAttribute("aria-label"), on(box), box.getAttribute("aria-disabled")]).toEqual(["checkbox", "Create boards, board.create", true, "false"]);
  const row = box.parentNode.parentNode;
  expect(row.findAll(e => e.hasClass("sr-only")).map(textOf)).toEqual(["Organization: applies", "Group: applies", "Space: applies", "Board: not at this scope"]);
  const roles = byKey("perm:roles.manage");
  expect(roles.getAttribute("aria-disabled")).toBe("true");                // not in tickable: shown, not offered
  expect(roles.parentNode.parentNode.findAll(e => e.hasClass("sr-only")).map(textOf)).toEqual(["Organization: not granted", "Group: not at this scope", "Space: not at this scope", "Board: not at this scope"]);
  expect(all(e => e.tagName === "TH" && e.getAttribute("scope") === "row").length).toBe(7);
  expect(all(e => e.disabled === true)).toEqual([]);                        // aria-disabled, never disabled
});

test("tick, save: the patch is sent, announced, Save follows the draft, focus stays on the checkbox by its key", async () => {
  await mount();
  expect(btn("Save role").getAttribute("aria-disabled")).toBe("true");
  byKey("perm:move").focus();
  byKey("perm:move").click(); await settle();
  expect(on(byKey("perm:move"))).toBe(true);
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("perm:move");
  expect(btn("Save role").getAttribute("aria-disabled")).toBe("false");
  btn("Save role").click(); await settle(); await settle();
  expect(calls.at(-1)).toEqual(["updateRole", "r-fac", { permissions: ["board.create", "move"] }]);
  expect(announced()).toBe("Saved Facilitator");
  expect(btn("Save role").getAttribute("aria-disabled")).toBe("true");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("perm:move");
});

test("typing a name keeps the input (no redraw) and wakes Save and Discard; the board step select changes the content rows", async () => {
  await mount();
  const name = all(e => e.getAttribute("aria-label") === "Role name")[0];
  name.value = "Host"; name.dispatch("input", { target: name });
  expect(btn("Save role").getAttribute("aria-disabled")).toBe("false");
  expect(btn("Discard changes").getAttribute("aria-disabled")).toBe("false");
  expect(all(e => e.getAttribute("aria-label") === "Role name")[0]).toBe(name);
  const sel = byKey("ladder");
  sel.value = "editor"; sel.dispatch("change", { target: sel }); await settle();
  expect(textOf(byKey("perm:board.create").parentNode.parentNode)).toContain("Create boards");
  expect(textOf(all(e => e.tagName === "TR").find(r => textOf(r).startsWith("Edit"))).includes("Yes")).toBe(true);
  btn("Discard changes").click(); await settle();
  expect(announced()).toBe("Changes discarded");
  expect(all(e => e.getAttribute("aria-label") === "Role name")[0].value).toBe("Facilitator");
});

test("a not-tickable checkbox ignores a click; the Unit member role's name and board step are read-only", async () => {
  await mount();
  byKey("perm:roles.manage").click(); await settle();
  expect(calls).toEqual([]);
  btn("Unit member").click(); await settle();
  const name = all(e => e.getAttribute("aria-label") === "Role name")[0];
  expect([name.getAttribute("aria-readonly"), name.readOnly]).toEqual(["true", true]);
  expect(byKey("ladder").getAttribute("aria-disabled")).toBe("true");
  byKey("perm:board.create").click(); await settle();
  btn("Save role").click(); await settle(); await settle();
  expect(calls.at(-1)).toEqual(["updateRole", "member", { permissions: [] }]);
});

test("a many-people change asks first, with the server's count; Save anyway sends confirm; Cancel returns focus to Save", async () => {
  await mount();
  answers.updateRole = (id, p) => (p.confirm ? undefined : { error: "conflict", code: "confirm-required", impact: { places: 11, people: 60, capped: false } });
  byKey("perm:move").click(); await settle();
  btn("Save role").click(); await settle(); await settle();
  const alert = all(e => e.getAttribute("role") === "alert")[0];
  expect(textOf(alert)).toContain("This change reaches about 60 people in 11 places.");
  expect(calls.filter(c => c[0] === "updateRole").length).toBe(1);
  btn("Cancel").click(); await settle();
  expect(all(e => e.getAttribute("role") === "alert")).toEqual([]);
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("save");
  btn("Save role").click(); await settle(); await settle();
  btn("Save anyway").click(); await settle(); await settle();
  expect(calls.at(-1)).toEqual(["updateRole", "r-fac", { permissions: ["board.create", "move"], confirm: true }]);
  expect(announced()).toBe("Saved Facilitator");
  expect(all(e => e.getAttribute("role") === "alert")).toEqual([]);
});

test("duplicate a built-in role: an unsaved copy, named, then Create role keeps one key and selects the new role", async () => {
  await mount();
  btn("Owner").click(); await settle();
  btn("Duplicate").click(); await settle();
  expect(textOf(byKey("heading-detail"))).toBe("New role");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("heading-detail");
  expect(all(e => e.getAttribute("aria-label") === "Role name")[0].value).toBe("Owner copy");
  expect(announced()).toContain("Copy of Owner started. It is not saved yet.");
  expect(textOf(root)).toContain("Copy of Owner");
  btn("Create role").click(); await settle(); await settle();
  expect(calls.at(-1)).toEqual(["createRole", { name: "Owner copy", base: "owner", boardRole: "editor", permissions: ["board.create", "move"], key: "key-12345" }]);
  expect(textOf(byKey("heading-detail"))).toBe("Owner copy");
  expect(announced()).toBe("Created role Owner copy");
  expect(items("Roles").map(li => li.getAttribute("aria-label").split(",")[0])).toContain("Owner copy");
});

test("delete: a confirm step first; in use is said with the count and the role stays; deleting an unused one moves focus to the heading", async () => {
  await mount();
  btn("Delete role…").click(); await settle();
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("confirm-delete");
  answers.removeRole = () => ({ error: "conflict", code: "in-use", used: { places: 4, capped: false } });
  btn("Delete role").click(); await settle(); await settle();
  expect(textOf(all(e => e.hasClass("home-status"))[0])).toContain("Facilitator is used in 4 places");
  expect(items("Roles").length).toBe(5);
  answers.removeRole = undefined;
  btn("Delete role…").click(); await settle(); btn("Delete role").click(); await settle(); await settle();
  expect(items("Roles").length).toBe(4);
  expect(textOf(byKey("heading-detail"))).toBe("Ops");
  expect(announced()).toContain("Deleted role Facilitator");
});

test("pending is aria-disabled, never disabled: a second Save while one is in flight is ignored", async () => {
  await mount();
  const gate = hold(); const real = api.updateRole;
  api.updateRole = (id, p) => gate.p.then(() => real(id, p));
  byKey("perm:move").click(); await settle();
  const save = btn("Save role");
  save.click(); save.click(); await settle();
  expect(all(e => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox").every(b => b.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(all(e => e.disabled === true)).toEqual([]);
  gate.release(); await settle(); await settle();
  expect(calls.filter(c => c[0] === "updateRole").length).toBe(1);
  expect(all(e => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox").some(b => b.getAttribute("aria-disabled") === "false")).toBe(true);
});

test("names are other people's words: a hostile role name is text, never markup", async () => {
  page.roles.push(role("r-x", "<img src=x onerror=alert(1)>", "custom", { ladder: "viewer", used: { places: 1, capped: false } }));
  await mount();
  expect(items("Roles").some(li => li.getAttribute("aria-label").startsWith("<img"))).toBe(true);
  expect(all(e => e.tagName === "IMG")).toEqual([]);
});

test("no access: the same not-available page; signed out: a sign-in link", async () => {
  api.roles = async () => ({ error: "notfound" }); await mount();
  expect(textOf(root)).toContain("This page is not available.");
  root.replaceChildren();
  api.roles = async () => ({ error: "auth" }); await mount({ signIn: { href: "/auth/login", text: "Sign in" } });
  expect(all(e => e.tagName === "A").some(a => a.getAttribute("href") === "/auth/login")).toBe(true);
});

test("focus: a vanished checkbox falls back to a neutral role name (never to another action), and says so", () => {
  const keys = keeper();
  const el = (k, tag = "button") => { const e = globalThis.document.createElement(tag); return e; };
  let rp1, rp2, perm, del;
  keys.around(() => { rp1 = keys.mark(el(), "rolepick:a"); rp2 = keys.mark(el(), "rolepick:b"); perm = keys.mark(el(), "perm:move"); del = keys.mark(el(), "delete-role"); });
  perm.focus();
  keys.around(() => { keys.mark(el(), "heading"); rp1 = keys.mark(el(), "rolepick:a"); rp2 = keys.mark(el(), "rolepick:b"); del = keys.mark(el(), "delete-role"); });
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("rolepick:b");
  expect(announced()).toBe("That permission is no longer here; moved to the previous one.");
});

// Keyboard users focus a button, then activate it. The button leaves the DOM when the screen redraws, so focus moves on purpose (to a named key)
// and nothing may announce "That item is no longer here".
const focusThenClick = async text => { const b = btn(text); b.focus(); b.click(); await settle(); await settle(); };
const noStale = () => expect(announced()).not.toContain("no longer here");

test("keyboard: Delete role… then its Cancel and Delete role move focus on purpose, with no false 'no longer here' announcement", async () => {
  await mount();
  await focusThenClick("Delete role…");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("confirm-delete"); noStale();
  await focusThenClick("Cancel");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("delete-role"); noStale();
  await focusThenClick("Delete role…");
  await focusThenClick("Delete role");
  expect(announced()).toContain("Deleted role Facilitator"); noStale();
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("heading");
});

test("keyboard: the many-people Cancel and Save anyway put focus on Save and the live text is exactly the save result", async () => {
  await mount();
  answers.updateRole = (id, p) => (p.confirm ? undefined : { error: "conflict", code: "confirm-required", impact: { places: 11, people: 60, capped: false } });
  byKey("perm:move").click(); await settle();
  await focusThenClick("Save role");
  await focusThenClick("Cancel");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("save"); noStale();
  await focusThenClick("Save role");
  await focusThenClick("Save anyway");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("save");
  expect(announced()).toBe("Saved Facilitator");
  expect(all(e => e.getAttribute("data-fk") === "confirm-text")).toEqual([]);   // the alert announces itself; nothing is marked to focus
});

test("keyboard: Cancel copy, Duplicate and picking a role land on the detail heading without a stale announcement", async () => {
  await mount();
  await focusThenClick("Duplicate");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("heading-detail");
  await focusThenClick("Cancel copy");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("heading-detail"); noStale();
  await focusThenClick("Ops");
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("heading-detail"); noStale();
});

test("keeper.around with an intended target: a vanished control goes there silently; without it the old fallback still announces", () => {
  const keys = keeper();
  const el = () => globalThis.document.createElement("button");
  keys.around(() => { keys.mark(el(), "heading"); keys.mark(el(), "delete-role").focus(); });
  keys.around(() => { keys.mark(el(), "heading"); keys.mark(el(), "confirm-delete"); }, { to: "confirm-delete" });
  expect(globalThis.document.activeElement.getAttribute("data-fk")).toBe("confirm-delete");
  expect(announced()).not.toContain("no longer here");
  keys.around(() => { keys.mark(el(), "heading"); });
  expect(announced()).toContain("no longer here");
});

test("a row says what the role is: one-line summary, where it applies, use; a saved custom role shows what it was copied from", async () => {
  page.roles[3] = role("r-fac", "Facilitator", "custom", { ladder: "annotator", summary: "Annotator board access, plus 1 management permission", base: "owner", permissions: ["board.create"],
    scopes: { unit: ["board.create"], group: ["board.create"], space: ["board.create"], board: ["board.view"] }, used: { places: 4, capped: false } });
  await mount();
  expect(items("Roles")[3].getAttribute("aria-label")).toBe("Facilitator, Custom, Annotator board access, plus 1 management permission, Organization to Board, Used in 4 places");
  expect(textOf(items("Roles")[3])).toContain("Annotator board access, plus 1 management permission");
  expect(textOf(root)).toContain("Like Owner");
});

test("a role the caller may not edit shows no checkboxes to tick or Save, and says why (the member role, a custom role above the caller)", async () => {
  page.roles[2] = role("member", "Unit member", "member", { editable: false, permissions: ["board.create"], used: { members: 12, capped: false } });
  page.roles[3] = role("r-fac", "Facilitator", "custom", { editable: false, ladder: "annotator", permissions: ["board.create"], used: { places: 4, capped: false } });
  await mount();                                                     // the first custom role is selected, but there is no draft for a read-only one
  expect(btn("Save role")).toBeUndefined();
  expect(textOf(root)).toContain("This role gives more than you hold yourself, so you can't change it. Duplicate it to make your own.");
  expect(all(e => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox").every(b => b.getAttribute("aria-disabled") === "true")).toBe(true);
  btn("Unit member").click(); await settle();
  expect(btn("Save role")).toBeUndefined();
  expect(textOf(root)).toContain("Only a Unit admin can change what every member gets.");
  expect(btn("Duplicate")).toBeTruthy();
});
