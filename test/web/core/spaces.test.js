// web/core/spaces.js: the Space / Group page model and the New board / New space dialog models, on a fake Spaces port.
import { test, expect } from "bun:test";
import { createPageModel, createNewBoardModel, createNewSpaceModel, createNewGroupModel, spaceEmpty, groupEmpty, generalText, errorText, createErrorText, GENERAL_CHOICES } from "../../../web/core/spaces.js";

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
  const why = (role, held) => ({ mine: { role: { id: role.toLowerCase(), name: role }, sources: [] }, guest: false, owners: [], needs: { "board.create": { role: "editor", roleName: "Editor", held } } });
  expect(spaceEmpty(page({ can: { createBoard: false }, why: why("Editor", false) })).detail).toBe("You're an Editor here; owners can add you as an Editor.");   // "an", not "a Editor"
  expect(spaceEmpty(page({ can: { createBoard: false }, why: why("Viewer", false) })).detail).toBe("You're a Viewer here; owners can add you as an Editor.");
  expect(spaceEmpty(page({ can: { createBoard: false }, why: why("Editor", true) })).detail).toBe("You're an Editor here through a role, which does not allow creating boards. Owners can add you as an Editor.");
  const named = { ...why("Editor", true) }; named.mine = { ...named.mine, sources: [{ kind: "direct", scope: { type: "space", id: "s-1", name: "P" }, role: "r-ce", roleName: "Content editor", ladder: "editor", strongest: true }] };
  expect(spaceEmpty(page({ can: { createBoard: false }, why: named })).detail).toBe("You're an Editor here through the Content editor role, which does not allow creating boards. Owners can add you as an Editor.");
  expect(spaceEmpty(page({ space: { personal: true }, can: { createBoard: true } })).title).toBe("Only you can see what's here until you share it.");
  expect(groupEmpty({ can: { createSpace: true } }, "Product").title).toBe("No Spaces in Product yet.");
  expect(groupEmpty({ can: { createSpace: false } }, "Product").detail).toMatch(/Area editors/);
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
  const m = createNewBoardModel({ api, space: "s-d", newKey: () => "k-board-001" }); await m.load();
  expect(m.state.space).toBe("s-d");
  expect(m.hint()).toMatch(/inherit|gets the Space's access/i);
  m.choose("s-nope"); expect(m.state.space).toBe("s-d");
  m.choose("s-me"); expect(m.hint()).toBe("Only you will see it until you share it.");
  m.setTitle("  Offsite ideas ");
  expect(await m.submit()).toBe(true);
  expect(calls.at(-1)).toEqual(["createBoard", { title: "Offsite ideas", key: "k-board-001" }]);
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
  expect(await m.submit()).toBe(false); expect(m.state.error).toBe("Give the Area a name.");
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
  expect(await only.submit()).toBe(false); expect(only.state.error).toMatch(/Pick an Area/);
  const none = createNewSpaceModel({ api: mk({ spaceGroups: () => ({ root: false, groups: [], more: false }) }).api }); await none.load();
  expect(none.canCreate()).toBe(false);
});

test("a create keeps ONE Idempotency-Key across retries of a submit, and takes a new one after a success or a changed input (all three dialogs)", async () => {
  let n = 0; const newKey = () => `key-${++n}-0000`;
  const sent = [];
  const { api } = mk({ boardSpaces: () => ({ spaces: [{ id: "s-me", name: "me", personal: true, general: null, group: null }], more: false }),
    spaceGroups: () => ({ root: true, groups: [], more: false }),
    createBoard: o => { sent.push(o.key); return sent.length < 3 ? { error: "unavailable" } : { board: { id: "b1" } }; },
    createSpace: o => { sent.push(o.key); return sent.length < 7 ? { error: "network" } : { space: { id: "s1", name: "S" } }; },
    createGroup: o => { sent.push(o.key); return sent.length < 10 ? { error: "unavailable" } : { group: { id: "g1", name: "G" } }; } });
  const b = createNewBoardModel({ api, newKey }); await b.load();
  await b.submit(); await b.submit();                    // the same submit, retried
  expect(sent).toEqual(["key-1-0000", "key-1-0000"]);
  b.setTitle("changed"); await b.submit();               // a changed input is a new request
  expect(sent.at(-1)).toBe("key-2-0000");
  expect(b.state.created).toEqual({ id: "b1" });
  const s = createNewSpaceModel({ api, newKey }); await s.load(); s.setName("S");
  await s.submit(); await s.submit(); s.setGeneral("editor"); await s.submit();
  expect(sent.slice(3, 6)).toEqual(["key-3-0000", "key-3-0000", "key-4-0000"]);
  await s.submit();
  expect(s.state.created).toEqual({ id: "s1", name: "S" });
  const g = createNewGroupModel({ api, newKey }); g.setName("G");
  await g.submit(); await g.submit(); await g.submit();
  expect(sent.slice(7)).toEqual(["key-5-0000", "key-5-0000", "key-5-0000"]);   // one key for the three tries of the group's submit
  // a success ends the key: the next submit is a new one
  g.setName("H"); await g.submit();
  expect(sent.at(-1)).toBe("key-6-0000");
});

test("a create with no key maker sends no key; an unclear failure of a create says it may have been created and that trying again is safe", async () => {
  const { api, calls } = mk({ boardSpaces: () => ({ spaces: [{ id: "s-me", name: "me", personal: true, general: null, group: null }], more: false }), createBoard: () => ({ error: "unavailable" }) });
  const m = createNewBoardModel({ api }); await m.load(); await m.submit();
  expect(calls.at(-1)).toEqual(["createBoard", { title: "" }]);
  expect(m.state.error).toMatch(/may have been created/i);
  expect(m.state.error).toMatch(/trying again unchanged is safe/i);
  expect(createErrorText("network")).toMatch(/may have been created/i);
  expect(createErrorText("forbidden")).toBe(errorText("forbidden"));   // a clear refusal keeps its own text
  expect(errorText("unavailable")).not.toMatch(/may have been created/i);   // reads and renames are not creates
});

test("L6 a key that cannot be made leaves no stuck dialog (busy stays false, an error shows, nothing is sent); a rejecting port clears busy too", async () => {
  const { api, calls } = mk({ boardSpaces: () => ({ spaces: [{ id: "s-me", name: "me", personal: true, general: null, group: null }], more: false }), spaceGroups: () => ({ root: true, groups: [], more: false }) });
  const boom = () => { throw new Error("crypto.randomUUID is not a function"); };
  const b = createNewBoardModel({ api, newKey: boom }); await b.load();
  expect(await b.submit()).toBe(false);
  expect(b.state.busy).toBe(false);
  expect(b.state.error).toMatch(/could not start/i);
  const g = createNewGroupModel({ api, newKey: boom }); g.setName("G");
  expect(await g.submit()).toBe(false);
  const s = createNewSpaceModel({ api, newKey: boom }); await s.load(); s.setName("S");
  expect(await s.submit()).toBe(false);
  expect([g.state.busy, s.state.busy]).toEqual([false, false]);
  expect(calls.some(c => c[0].startsWith("create"))).toBe(false);
  const rej = createNewGroupModel({ api: { createGroup: async () => { throw new Error("port bug"); } }, newKey: () => "k-0000-aaaa" }); rej.setName("G");
  await expect(rej.submit()).rejects.toThrow("port bug");
  expect(rej.state.busy).toBe(false);
  expect(errorText("in-progress")).toBe(errorText("unavailable"));   // the server has no such answer any more
});
