// web/core/role-admin.js: the Roles screen's state with a fake port. Every permission is the server's word (tickable, ladders, 409s); the model only asks.
import { test, expect, beforeEach } from "bun:test";
import { createRolesModel, usedText, impactText, failText, permLabel } from "../../../web/core/role-admin.js";

const SC = ["unit", "group", "space", "board"];
const MATRIX = (o = {}) => ({ scopes: SC, permissions: [
  { id: "board.view", group: "content", scopes: SC }, { id: "board.comment", group: "content", scopes: SC }, { id: "board.annotate", group: "content", scopes: SC }, { id: "board.edit", group: "content", scopes: SC },
  { id: "board.create", group: "management", scopes: ["unit", "group", "space"] }, { id: "space.create", group: "management", scopes: ["unit", "group"] }, { id: "move", group: "management", scopes: SC }, { id: "roles.manage", group: "management", scopes: ["unit"] }],
  content: { viewer: ["board.view"], commenter: ["board.view", "board.comment"], annotator: ["board.view", "board.comment", "board.annotate"], editor: ["board.view", "board.comment", "board.annotate", "board.edit"] },
  ladders: ["viewer", "commenter", "annotator", "editor"], tickable: ["board.create", "space.create", "move", "roles.manage"], ...o });
const role = (id, name, kind, o = {}) => ({ id, name, kind, editable: kind !== "builtin", ladder: null, permissions: [], scopes: { unit: [], group: [], space: [], board: [] }, used: null, ...o });
const PAGE = () => ({ roles: [role("viewer", "Viewer", "builtin", { ladder: "viewer" }), role("owner", "Owner", "builtin", { ladder: "owner", permissions: ["board.create", "move"] }), role("admin", "Unit admin", "builtin"),
  role("member", "Unit member", "member", { permissions: ["space.create"], used: { members: 12, capped: false } }),
  role("r-fac", "Facilitator", "custom", { ladder: "annotator", permissions: ["board.create"], used: { places: 4, capped: false } }), role("r-ops", "Ops", "custom", { ladder: "viewer", permissions: [], used: { places: 0, capped: false } })],
  matrix: MATRIX(), can: { admin: true }, limits: { custom: 50, many: { places: 10, people: 50 } } });
let api, calls, page, model, keyN;
const mk = (o = {}) => createRolesModel({ api, newKey: () => `key-${++keyN}`, ...o });
beforeEach(() => {
  calls = []; page = PAGE(); keyN = 0;
  api = { answers: {}, roles: async () => ({ page: structuredClone(page) }),
    createRole: async a => { calls.push(["createRole", a]); return api.answers.createRole?.(a) ?? { role: role("r-new", a.name, "custom", { ladder: a.boardRole, permissions: a.permissions, base: a.base, used: { places: 0, capped: false } }) }; },
    updateRole: async (id, p) => { calls.push(["updateRole", id, p]); return api.answers.updateRole?.(id, p) ?? { role: { ...structuredClone(page.roles.find(r => r.id === id)), ...(p.name ? { name: p.name } : {}), ...(p.boardRole ? { ladder: p.boardRole } : {}), ...(p.permissions ? { permissions: p.permissions } : {}) } }; },
    removeRole: async id => { calls.push(["removeRole", id]); return api.answers.removeRole?.(id) ?? {}; } };
});
const ready = async o => { model = mk(o); await model.load(); return model; };

test("load: the first custom role is selected with a draft; a built-in has none; select drops unsaved edits and says so", async () => {
  await ready();
  expect(model.state.selected).toBe("r-fac");
  expect(model.state.draft).toMatchObject({ id: "r-fac", name: "Facilitator", ladder: "annotator", permissions: ["board.create"] });
  model.toggle("move");
  expect(model.dirty()).toBe(true);
  model.select("viewer");
  expect(model.state.draft).toBe(null);
  expect(model.state.said).toContain("Unsaved changes");
  model.select("member");
  expect(model.state.draft).toMatchObject({ id: "member", permissions: ["space.create"] });
  expect(model.select("nope")).toBe(false);
});

test("load failures: signed out, no access (notfound), an error that keeps what is shown", async () => {
  api.roles = async () => ({ error: "auth" }); const a = mk(); await a.load(); expect(a.state.status).toBe("signed-out");
  api.roles = async () => ({ error: "notfound" }); const b = mk(); await b.load(); expect([b.state.status, b.state.page]).toEqual(["notfound", null]);
  const c = mk(); api.roles = async () => ({ page: PAGE() }); await c.load();
  api.roles = async () => ({ error: "unavailable" }); await c.load();
  expect([c.state.status, c.state.notice]).toEqual(["ready", "Could not refresh this page."]);
  api.roles = async () => ({ error: "unavailable" }); const d = mk(); await d.load(); expect(d.state.status).toBe("error");
});

test("rows: management cells come from the server's scopes; content rows follow the board step; only tickable permissions are tickable", async () => {
  await ready();
  const rows = Object.fromEntries(model.rows().map(r => [r.id, r]));
  expect(rows["board.create"]).toMatchObject({ ticked: true, tickable: true, group: "management" });
  expect(rows["board.create"].cells.map(c => c.state)).toEqual(["yes", "yes", "yes", "na"]);       // not at a board: the server's list, not ours
  expect(rows["roles.manage"].cells.map(c => c.state)).toEqual(["no", "na", "na", "na"]);
  expect(rows["board.annotate"]).toMatchObject({ ticked: true, tickable: false, group: "content" });
  expect(rows["board.edit"].ticked).toBe(false);
  model.setLadder("editor");
  expect(model.rows().find(r => r.id === "board.edit").ticked).toBe(true);
  model.select("viewer");                                                                              // a built-in: nothing tickable
  expect(model.rows().every(r => !r.tickable)).toBe(true);
  expect(model.rows().find(r => r.id === "board.view").ticked).toBe(true);
});

test("toggle: only what the server lists as tickable; setLadder: only a step it lists; setName is quiet", async () => {
  api.roles = async () => ({ page: { ...PAGE(), matrix: MATRIX({ tickable: ["move"], ladders: ["viewer"] }) } });
  await ready();
  const seen = []; model.subscribe(() => seen.push(1));
  expect(model.toggle("roles.manage")).toBe(false);
  expect(model.toggle("move")).toBe(true);
  expect(model.state.draft.permissions).toEqual(["board.create", "move"]);
  expect(model.toggle("move")).toBe(true);
  expect(model.state.draft.permissions).toEqual(["board.create"]);
  model.setLadder("editor"); expect(model.state.draft.ladder).toBe("annotator");
  const n = seen.length; model.setName("Renamed"); expect(seen.length).toBe(n);
  expect(model.state.draft.name).toBe("Renamed");
  model.select("viewer"); expect(model.toggle("move")).toBe(false);                                   // no draft on a built-in
});

test("save patches only what changed; the answer replaces the role; announced; the member role sends permissions only", async () => {
  await ready();
  model.setName("Host"); model.toggle("move");
  expect(await model.save()).toBe(true);
  expect(calls.at(-1)).toEqual(["updateRole", "r-fac", { name: "Host", permissions: ["board.create", "move"] }]);
  expect(model.state.page.roles.find(r => r.id === "r-fac")).toMatchObject({ name: "Host", permissions: ["board.create", "move"] });
  expect(model.state.said).toBe("Saved Host");
  expect(model.dirty()).toBe(false);
  expect(await model.save()).toBe(true);                                                                // nothing changed: no request
  expect(calls.length).toBe(1);
  model.select("member"); model.toggle("move"); model.setName("Everyone");
  await model.save();
  expect(calls.at(-1)).toEqual(["updateRole", "member", { permissions: ["space.create", "move"] }]);   // never name or board step for member
});

test("a blank or too-long name is refused before any request", async () => {
  await ready();
  model.setName("   "); expect(await model.save()).toBe(false);
  expect(model.state.notice).toBe("Give the role a name.");
  model.setName("x".repeat(220)); expect(await model.save()).toBe(false);
  expect(model.state.notice).toContain("at most 200");
  expect(calls).toEqual([]);
});

test("a many-people edit stops at the server's confirmation with its counts; Save anyway sends confirm; Cancel keeps the draft", async () => {
  await ready();
  api.answers.updateRole = (id, p) => (p.confirm ? undefined : { error: "conflict", code: "confirm-required", impact: { places: 11, people: 60, capped: false } });
  model.toggle("move");
  expect(await model.save()).toBe(false);
  expect(model.state.confirm).toEqual({ impact: { places: 11, people: 60, capped: false } });
  expect(model.state.notice).toBe(null);
  expect(impactText(model.current(), model.state.confirm.impact)).toBe("This change reaches about 60 people in 11 places.");
  model.cancelConfirm();
  expect([model.state.confirm, model.dirty()]).toEqual([null, true]);
  await model.save();
  expect(await model.confirmSave()).toBe(true);
  expect(calls.at(-1)[2]).toEqual({ permissions: ["board.create", "move"], confirm: true });
  expect(model.state.confirm).toBe(null);
  expect(model.dirty()).toBe(false);
});

test("duplicate: a built-in or a custom role becomes an unsaved copy; owner's step becomes the highest allowed; create sends the base and ONE key, kept across a retry", async () => {
  await ready();
  model.duplicate("owner");
  expect(model.state.draft).toEqual({ isNew: true, id: null, name: "Owner copy", ladder: "editor", permissions: ["board.create", "move"], base: "owner" });
  expect(model.current()).toBe(null);
  api.answers.createRole = () => ({ error: "unavailable" });
  expect(await model.save()).toBe(false);
  api.answers.createRole = undefined;
  expect(await model.save()).toBe(true);
  expect(calls.map(c => [c[1].base, c[1].key])).toEqual([["owner", "key-1"], ["owner", "key-1"]]);    // the same submit, the same key
  expect(model.state.selected).toBe("r-new");
  expect(model.state.page.roles.find(r => r.id === "r-new")).toMatchObject({ name: "Owner copy", kind: "custom" });
  model.duplicate("r-fac");
  await model.save();
  expect(calls.at(-1)[1].key).toBe("key-2");                                                          // a new copy is a new submit
  model.duplicate("admin"); expect(model.state.draft).toMatchObject({ ladder: "viewer", permissions: [] });
});

test("duplicate by a non-admin: permissions and board step the person does not hold are left out, and it says so", async () => {
  api.roles = async () => ({ page: { ...PAGE(), can: { admin: false }, matrix: MATRIX({ tickable: ["board.create"], ladders: ["viewer", "commenter"] }) } });
  await ready();
  model.select("owner"); model.duplicate("owner");
  expect(model.state.draft).toMatchObject({ ladder: "commenter", permissions: ["board.create"] });
  expect(model.state.said).toContain("Permissions you do not hold were left out");
  model.duplicate("r-fac");
  expect(model.state.draft.ladder).toBe("commenter");
});

test("discard drops a copy or edits; remove: custom only, the next role is selected; in use says where and keeps the role; too-large says the limit", async () => {
  await ready();
  model.duplicate("owner"); model.discard();
  expect([model.state.draft?.id, model.state.selected]).toEqual(["r-fac", "r-fac"]);
  api.answers.removeRole = () => ({ error: "conflict", code: "in-use", used: { places: 4, capped: false } });
  expect(await model.remove()).toBe(false);
  expect(model.state.notice).toBe("Facilitator is used in 4 places. Remove it from those places first.");
  expect(model.state.page.roles.some(r => r.id === "r-fac")).toBe(true);
  api.answers.removeRole = undefined;
  expect(await model.remove()).toBe(true);
  expect(model.state.selected).toBe("r-ops");
  expect(model.state.said).toBe("Deleted role Facilitator");
  model.select("member"); expect(await model.remove()).toBe(false);
  model.select("viewer"); expect(await model.remove()).toBe(false);
  expect(calls.filter(c => c[0] === "removeRole").length).toBe(2);
  api.answers.createRole = () => ({ error: "conflict", code: "too-large" });
  model.duplicate("viewer"); await model.save();
  expect(model.state.notice).toBe("This organization has the most custom roles it can (50). Delete one first.");
});

test("a write while another is in flight is ignored; auth failure signs out", async () => {
  await ready();
  let release; api.answers.updateRole = () => new Promise(r => { release = () => r({ role: { ...model.state.page.roles.find(x => x.id === "r-fac"), name: "Z" } }); });
  model.setName("Z");
  const first = model.save(); const second = await model.save();
  expect(second).toBe(false);
  release(); await first;
  expect(calls.filter(c => c[0] === "updateRole").length).toBe(1);
  api.answers.updateRole = () => ({ error: "auth" }); model.setName("Y"); await model.save();
  expect(model.state.status).toBe("signed-out");
});

test("copy helpers", () => {
  expect(usedText(role("a", "A", "custom", { used: { places: 1, capped: false } }))).toBe("Used in 1 place");
  expect(usedText(role("a", "A", "custom", { used: { places: 100, capped: true } }))).toBe("Used in 100+ places");
  expect(usedText(role("a", "A", "custom", { used: { places: 0, capped: false } }))).toBe("Not used yet");
  expect(usedText(role("member", "M", "member", { used: { members: 50, capped: true } }))).toBe("Everyone in the organization (50+ people)");
  expect(usedText(role("viewer", "V", "builtin"))).toBe(null);
  expect(impactText(role("member", "M", "member"), { places: 0, people: 51, capped: true })).toBe("This change reaches everyone in the organization (51+ people).");
  expect(failText({ error: "forbidden" })).toContain("You can't change that role");
  expect(failText({ error: "conflict", code: "too-large" }, { custom: 50 })).toContain("50");
  expect(permLabel("roles.manage")).toBe("Manage roles");
  expect(permLabel("x.y")).toBe("x.y");
});

test("after a save the built-ins and the member role keep the server's order; only custom roles sort by name", async () => {
  await ready();
  const order = () => model.state.page.roles.map(r => r.id);
  const before = order();
  expect(before).toEqual(["viewer", "owner", "admin", "member", "r-fac", "r-ops"]);
  model.toggle("move"); await model.save();
  expect(order()).toEqual(before);
  model.select("r-ops"); model.setName("Aardvark"); await model.save();
  expect(order()).toEqual(["viewer", "owner", "admin", "member", "r-ops", "r-fac"]);          // Aardvark before Facilitator; the built-ins did not move
});
