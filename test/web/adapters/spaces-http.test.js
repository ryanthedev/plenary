// web/adapters/spaces/http.js over a fake fetch: the requests it makes, the shapes it accepts, and that no call ever rejects (web/ports/spaces.js).
import { test, expect } from "bun:test";
import { httpSpaces, normalizeSpacePage, normalizeGroupPage } from "../../../web/adapters/spaces/http.js";
import { SPACES_ERRORS } from "../../../web/ports/spaces.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const SPACE = { space: { id: "s-1", name: "Design", personal: false, general: "viewer", group: { id: "g-1", name: "Product" } }, can: { createBoard: true, rename: true, general: false },
  boards: [{ id: "b-1", title: "Roadmap", role: "editor", path: [{ type: "space", id: "s-1", name: "Design" }], starred: false, can: { rename: true } }], more: false };
const GROUP = { group: { id: "g-1", name: "Product", general: null }, can: { createSpace: true, rename: false, general: false }, spaces: [{ id: "s-1", name: "Design", general: "viewer" }], next: null };
const api = (fetch, o = {}) => httpSpaces({ fetch, token: "tok", ...o });
const seen = () => { const calls = []; return { calls, fetch: async (url, init) => { calls.push([url, init]); return answer(200, { board: { id: "b-9", title: "T" }, space: SPACE.space, group: GROUP.group, spaces: [], groups: [], root: true })(); } }; };

test("space and group: GET with the Bearer token, no cookies, never cached; bodies come back normalised", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push([u, i]); return answer(200, u.startsWith("/spaces") ? SPACE : GROUP)(); };
  expect((await api(f).space("s-1")).page).toEqual(SPACE);
  expect(calls[0][0]).toBe("/spaces/s-1");
  expect(calls[0][1]).toMatchObject({ method: "GET", headers: { authorization: "Bearer tok" }, credentials: "omit", cache: "no-store" });
  expect((await api(f).group("g-1")).page).toEqual(GROUP);
  await api(f).group("g-1", "s-0");
  expect(calls.at(-1)[0]).toBe("/groups/g-1?after=s-0");
});

test("pickers, create, update and rename: the routes, methods and bodies of PROTOCOL § Spaces and Groups", async () => {
  const s = seen(), a = api(s.fetch);
  await a.boardSpaces(); await a.spaceGroups();
  await a.createBoard({ title: "Offsite", space: "s-1" }); await a.createBoard({ title: "Mine" });
  await a.createSpace({ name: "Q4", group: "g-1", general: null }); await a.createSpace({ name: "Q5" });
  await a.createGroup({ name: "Org", general: "viewer" }); await a.createGroup({ name: "Org2" });
  await a.updateSpace("s-1", { name: "N" }); await a.updateGroup("g-1", { general: "viewer" }); await a.renameBoard("b-9", "T");
  expect(s.calls.map(([u, i]) => [i.method, u, i.body ? JSON.parse(i.body) : undefined])).toEqual([
    ["GET", "/spaces?can=board.create", undefined], ["GET", "/groups?can=space.create", undefined],
    ["POST", "/boards", { title: "Offsite", space: "s-1" }], ["POST", "/boards", { title: "Mine" }],
    ["POST", "/spaces", { name: "Q4", group: "g-1", general: null }], ["POST", "/spaces", { name: "Q5" }],
    ["POST", "/groups", { name: "Org", general: "viewer" }], ["POST", "/groups", { name: "Org2" }],
    ["PATCH", "/spaces/s-1", { name: "N" }], ["PATCH", "/groups/g-1", { general: "viewer" }], ["PATCH", "/boards/b-9", { title: "T" }]]);
  expect(s.calls[2][1].headers["content-type"]).toBe("application/json");
});

test("every failure is a value from SPACES_ERRORS, never a throw", async () => {
  const bad = [[answer(400, {}), "invalid"], [answer(401, {}), "auth"], [answer(403, {}), "forbidden"], [answer(404, {}), "notfound"], [answer(503, {}), "unavailable"],
    [answer(200, "<html>"), "unavailable"], [answer(200, { nope: 1 }), "unavailable"], [async () => { throw new Error("offline"); }, "network"], [async () => null, "unavailable"]];
  for (const [f, want] of bad) for (const call of [a => a.space("s-1"), a => a.group("g-1"), a => a.boardSpaces(), a => a.spaceGroups(), a => a.createBoard({ title: "x" }),
    a => a.createSpace({ name: "x" }), a => a.updateSpace("s-1", { name: "x" }), a => a.updateGroup("g-1", { name: "x" }), a => a.renameBoard("b-1", "x")]) {
    const r = await call(api(f));
    expect(r).toEqual({ error: want });
    expect(SPACES_ERRORS).toContain(r.error);
  }
  const timers = { set: fn => setTimeout(fn, 5), clear: h => clearTimeout(h) };
  expect(await api(() => new Promise(() => {}), { timers, timeoutMs: 5 }).space("s-1")).toEqual({ error: "unavailable" });
});

test("bad ids make no request; ids and strings are checked and capped", async () => {
  let n = 0;
  const a = api(async () => { n++; return answer(200, {})(); });
  expect(await a.space("../x")).toEqual({ error: "notfound" });
  expect(await a.group("g-1", "a b")).toEqual({ error: "notfound" });
  expect(await a.updateSpace("a/b", { name: "x" })).toEqual({ error: "forbidden" });
  expect(await a.renameBoard("a b", "x")).toEqual({ error: "forbidden" });
  expect(n).toBe(0);
  expect(normalizeSpacePage({ ...SPACE, space: { ...SPACE.space, id: "bad id" } })).toBe(null);
  const long = normalizeSpacePage({ ...SPACE, space: { ...SPACE.space, name: "x".repeat(500), group: { id: "bad id", name: "g" } } });
  expect(long.space.name.length).toBe(200);
  expect(long.space.group).toBe(null);
  expect(normalizeSpacePage({ ...SPACE, can: undefined }).can).toEqual({ createBoard: false, rename: false, general: false });      // permissions default to no
  expect(normalizeGroupPage({ ...GROUP, next: "bad id" }).next).toBe(null);
  expect(normalizeGroupPage({ ...GROUP, spaces: [{ id: "x y", name: "n" }, GROUP.spaces[0]] }).spaces).toEqual(GROUP.spaces);
});

test("a create sends its Idempotency-Key header when given one, and none otherwise; 422 is refused input, 409 in-progress is unavailable", async () => {
  const s = seen(), a = api(s.fetch);
  await a.createBoard({ title: "T", key: "key-0001-abcd" }); await a.createSpace({ name: "S", key: "key-0002-abcd" }); await a.createGroup({ name: "G", key: "key-0003-abcd" });
  await a.createBoard({ title: "T" });
  expect(s.calls.map(c => c[1].headers["idempotency-key"])).toEqual(["key-0001-abcd", "key-0002-abcd", "key-0003-abcd", undefined]);
  expect(await api(answer(422, { error: "idempotency-key-reused" })).createBoard({ title: "T", key: "key-0001-abcd" })).toEqual({ error: "invalid" });
  expect(await api(answer(409, { error: "in-progress" })).createBoard({ title: "T", key: "key-0001-abcd" })).toEqual({ error: "unavailable" });
});
