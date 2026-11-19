// web/core/spaces.js: the Space / Group page model and the New board / New space dialog models, on a fake Spaces port.
import { test, expect } from "bun:test";
import { createPageModel, createNewBoardModel, createNewSpaceModel, createNewGroupModel, spaceEmpty, groupEmpty, generalText, errorText, GENERAL_CHOICES } from "../../../web/core/spaces.js";

const page = (o = {}) => ({ space: { id: "s-1", name: "Design", personal: false, general: "viewer", group: null }, can: { createBoard: true, rename: true, general: true },
  boards: [{ id: "b-1", title: "Roadmap", role: "editor", path: [], starred: false, can: { rename: true } }], more: false, ...o });
const gpage = (o = {}) => ({ group: { id: "g-1", name: "Product", general: null }, can: { createSpace: true, rename: true, general: true }, spaces: [{ id: "s-1", name: "A", general: null }], next: "s-1", ...o });
const mk = (over = {}) => {
  const calls = [];
  const api = new Proxy({}, { get: (_, name) => (...a) => { calls.push([name, ...a]); return Promise.resolve(over[name] ? over[name](...a) : { error: "unavailable" }); } });
  return { api, calls };
};

test("copy: general access, empty states (JOURNEY §5), errors", () => {
  expect([generalText("viewer"), generalText(null), generalText("editor"), generalText("zzz")]).toEqual(["Everyone can view", "Only people added", "Everyone can edit", "Only people added"]);
  expect(GENERAL_CHOICES.at(-1)).toEqual([null, "Only people added"]);
  expect(spaceEmpty(page()).title).toBe("No boards yet.");
  expect(spaceEmpty(page({ can: { createBoard: false } })).detail).toMatch(/ask an owner/);
  expect(spaceEmpty(page({ space: { personal: true }, can: { createBoard: true } })).title).toBe("Only you can see what's here until you share it.");
  expect(groupEmpty({ can: { createSpace: true } }, "Product").title).toBe("No Spaces in Product yet.");
  expect(groupEmpty({ can: { createSpace: false } }, "Product").detail).toMatch(/Group editors/);
  expect(errorText("forbidden")).toMatch(/can't/);
  expect(errorText("???")).toBe(errorText("unavailable"));
});

test("page: load -> ready; notfound and forbidden look the same; signed out; a failed refresh keeps the page", async () => {
  let r = { page: page() };
  const { api } = mk({ space: () => r });
  const m = createPageModel({ api, kind: "space", id: "s-1" });
  expect(m.state.status).toBe("loading");
  await m.load();
  expect([m.state.status, m.state.page.space.name]).toEqual(["ready", "Design"]);
  r = { error: "unavailable" }; await m.load();
  expect([m.state.status, m.state.notice]).toEqual(["ready", "Could not refresh this page."]);
  for (const e of ["notfound", "forbidden"]) { const x = createPageModel({ api: mk({ space: () => ({ error: e }) }).api, kind: "space", id: "s" }); await x.load(); expect([x.state.status, x.state.page]).toEqual(["notfound", null]); }
  const y = createPageModel({ api: mk({ space: () => ({ error: "auth" }) }).api, kind: "space", id: "s" }); await y.load(); expect(y.state.status).toBe("signed-out");
  const z = createPageModel({ api: mk({ space: () => ({ error: "network" }) }).api, kind: "space", id: "s" }); await z.load(); expect(z.state.status).toBe("error");
});

test("rename: blank and long names are refused before any request; an unchanged name makes none; a server refusal keeps the old name and says so", async () => {
  const { api, calls } = mk({ space: () => ({ page: page() }), updateSpace: (id, p) => (p.name === "no" ? { error: "forbidden" } : { space: { id, name: p.name, general: "viewer" } }) });
  const m = createPageModel({ api, kind: "space", id: "s-1" }); await m.load();
  expect(await m.rename("   ")).toBe(false); expect(m.state.notice).toMatch(/empty/);
  expect(await m.rename("x".repeat(201))).toBe(false);
  expect(await m.rename("Design")).toBe(true);
  expect(calls.filter(c => c[0] === "updateSpace")).toEqual([]);
  expect(await m.rename("  Brand ")).toBe(true);
  expect(calls.at(-1)).toEqual(["updateSpace", "s-1", { name: "Brand" }]);
  expect(m.state.page.space.name).toBe("Brand");
  expect(await m.rename("no")).toBe(false);
  expect([m.state.page.space.name, m.state.notice, m.state.busy]).toEqual(["Brand", "You can't do that here.", false]);
});

test("setGeneral and renameBoard update the page; a Group page renames its Group and pages its Spaces", async () => {
  const { api, calls } = mk({ space: () => ({ page: page() }), updateSpace: (id, p) => ({ space: { id, name: "Design", general: "general" in p ? p.general : "viewer" } }),
    renameBoard: (id, t) => ({ board: { id, title: t } }),
    group: (id, after) => ({ page: after ? gpage({ spaces: [{ id: "s-2", name: "B", general: null }], next: null }) : gpage() }), updateGroup: (id, p) => ({ group: { id, name: p.name ?? "Product", general: null } }) });
  const m = createPageModel({ api, kind: "space", id: "s-1" }); await m.load();
  expect(await m.setGeneral(null)).toBe(true);
  expect(calls.at(-1)).toEqual(["updateSpace", "s-1", { general: null }]);
  expect(m.state.page.space.general).toBe(null);
  expect(await m.renameBoard("b-1", " New ")).toBe(true);
  expect(m.state.page.boards[0].title).toBe("New");
  expect(await m.renameBoard("b-1", "x".repeat(201))).toBe(false);
  expect(await m.renameBoard("b-nope", "x")).toBe(false);
  const g = createPageModel({ api, kind: "group", id: "g-1" }); await g.load();
  await g.loadMore();
  expect(g.state.page.spaces.map(s => s.name)).toEqual(["A", "B"]);
  expect(g.state.page.next).toBe(null);
  await g.loadMore();
  expect(calls.filter(c => c[0] === "group").length).toBe(2);
  expect(await g.rename("P2")).toBe(true);
  expect(g.state.page.group.name).toBe("P2");
});

test("New board: personal space is the default; a preset Space is chosen when listed; submit sends no space for the personal one", async () => {
  const spaces = [{ id: "s-me", name: "ada's space", personal: true, general: null, group: null }, { id: "s-d", name: "Design", personal: false, general: "viewer", group: { id: "g", name: "Product" } }];
  const { api, calls } = mk({ boardSpaces: () => ({ spaces, more: false }), createBoard: () => ({ board: { id: "b-new" } }) });
  const m = createNewBoardModel({ api, space: "s-d" }); await m.load();
  expect(m.state.space).toBe("s-d");
  expect(m.hint()).toMatch(/inherit|gets the Space's access/i);
  m.choose("s-nope"); expect(m.state.space).toBe("s-d");
  m.choose("s-me"); expect(m.hint()).toBe("Only you will see it until you share it.");
  m.setTitle("  Offsite ideas ");
  expect(await m.submit()).toBe(true);
  expect(calls.at(-1)).toEqual(["createBoard", { title: "Offsite ideas" }]);
  expect(m.state.created).toEqual({ id: "b-new" });
  const n = createNewBoardModel({ api, space: "s-gone" }); await n.load();
  expect(n.state.space).toBe("s-me");                      // an unlisted preset falls back to the personal space
  n.choose("s-d"); await n.submit();
  expect(calls.at(-1)).toEqual(["createBoard", { title: "", space: "s-d" }]);
});

test("New board: a failed load shows an error and cannot submit; a refusal shows its text; double submit makes one request; long titles are refused early", async () => {
  const bad = createNewBoardModel({ api: mk({ boardSpaces: () => ({ error: "network" }) }).api }); await bad.load();
  expect([bad.state.status, await bad.submit()]).toEqual(["error", false]);
  let n = 0;
  const { api } = mk({ boardSpaces: () => ({ spaces: [{ id: "s-me", name: "me", personal: true, general: null, group: null }], more: true }), createBoard: async () => { n++; await new Promise(r => setTimeout(r, 5)); return { error: "forbidden" }; } });
  const m = createNewBoardModel({ api }); await m.load();
  expect(m.state.more).toBe(true);
  m.setTitle("x".repeat(201)); expect(await m.submit()).toBe(false); expect(m.state.error).toMatch(/at most/); expect(n).toBe(0);
  m.setTitle("ok");
  const [a, b] = await Promise.all([m.submit(), m.submit()]);
  expect([a, b, n]).toEqual([false, false, 1]);
  expect(m.state.error).toBe("You can't do that here.");
});

test("New group: name validation, general access, one submit at a time, server refusal text", async () => {
  const { api, calls } = mk({ createGroup: () => ({ group: { id: "g-new", name: "Org" } }) });
  const m = createNewGroupModel({ api });
  expect(await m.submit()).toBe(false); expect(m.state.error).toBe("Give the Group a name.");
  m.setName("x".repeat(201)); expect(await m.submit()).toBe(false); expect(m.state.error).toMatch(/at most/); expect(calls.length).toBe(0);
  m.setName("  Org "); m.setGeneral("viewer");
  const [a, b] = await Promise.all([m.submit(), m.submit()]);
  expect([a, b, calls.length]).toEqual([true, false, 1]);
  expect(calls[0]).toEqual(["createGroup", { name: "Org", general: "viewer" }]);
  expect(m.state.created.id).toBe("g-new");
  const bad = createNewGroupModel({ api: mk({ createGroup: () => ({ error: "forbidden" }) }).api }); bad.setName("x");
  expect(await bad.submit()).toBe(false); expect(bad.state.error).toBe("You can't do that here.");
});

test("New space: Group choices, root vs Group-only people, general access, name validation", async () => {
  const { api, calls } = mk({ spaceGroups: () => ({ root: true, groups: [{ id: "g-1", name: "Product" }], more: false }), createSpace: () => ({ space: { id: "s-new", name: "Q4", personal: false, general: null, group: null } }) });
  const m = createNewSpaceModel({ api, group: "g-1" }); await m.load();
  expect([m.state.group, m.canCreate()]).toEqual(["g-1", true]);
  expect(await m.submit()).toBe(false); expect(m.state.error).toBe("Give the Space a name.");
  m.setName("x".repeat(201)); expect(await m.submit()).toBe(false);
  m.setName(" Q4 "); m.setGeneral("none");
  expect(await m.submit()).toBe(true);
  expect(calls.at(-1)).toEqual(["createSpace", { name: "Q4", group: "g-1", general: null }]);
  expect(m.state.created.id).toBe("s-new");
  const r = createNewSpaceModel({ api, group: "g-nope" }); await r.load();
  expect(r.state.group).toBe(null);                          // unlisted preset: the root
  // no root: only a listed Group works, and nothing at all when there is none
  const only = createNewSpaceModel({ api: mk({ spaceGroups: () => ({ root: false, groups: [{ id: "g-1", name: "P" }], more: false }) }).api }); await only.load();
  expect(only.state.group).toBe("g-1");
  only.setGroup(""); only.setName("x");
  expect(await only.submit()).toBe(false); expect(only.state.error).toMatch(/Pick a Group/);
  const none = createNewSpaceModel({ api: mk({ spaceGroups: () => ({ root: false, groups: [], more: false }) }).api }); await none.load();
  expect(none.canCreate()).toBe(false);
});
