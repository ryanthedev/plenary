// web/adapters/roles/http.js over a fake fetch: the requests it makes, the shapes it accepts, the error bodies it passes on, the keyed create's retry
// while the server says in progress, and that no call ever rejects.
import { test, expect } from "bun:test";
import { httpRoles, normalizeRolesPage, normalizeRole } from "../../../web/adapters/roles/http.js";

const answer = (status, body, headers = {}) => async () => ({ status, headers: { get: k => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const ROLE = { id: "r-fac", name: "Facilitator", kind: "custom", editable: true, base: "editor", ladder: "editor", permissions: ["members.manage"], scopes: { unit: ["board.view", "members.manage"], group: [], space: [], board: [] }, used: { places: 4, capped: false } };
const PAGE = { roles: [ROLE, { id: "member", name: "Unit member", kind: "member", editable: true, ladder: null, permissions: ["space.create"], scopes: { unit: ["space.create"], group: [], space: [], board: [] }, used: { members: 12, capped: false } }],
  matrix: { scopes: ["unit", "group", "space", "board"], permissions: [{ id: "board.view", group: "content", scopes: ["unit", "group", "space", "board"] }, { id: "roles.manage", group: "management", scopes: ["unit"] }],
    content: { viewer: ["board.view"] }, ladders: ["viewer"], tickable: ["roles.manage"] }, can: { admin: true }, limits: { custom: 50, many: { places: 10, people: 50 } } };
const seen = (status = 200, body = PAGE) => { const calls = []; return { calls, fetch: async (url, init) => { calls.push([url, init]); return answer(init.method === "DELETE" ? 204 : status, body)(); } }; };

test("the routes, methods and bodies of PROTOCOL § Roles; Bearer only, no cookies", async () => {
  const s = seen(), a = httpRoles({ fetch: s.fetch, token: "tok" });
  await a.roles(); await a.createRole({ name: "X", base: "editor", boardRole: "viewer", permissions: ["move"], key: "key-12345" }); await a.updateRole("r-fac", { name: "Y", confirm: true }); await a.removeRole("r-fac");
  expect(s.calls.map(([u, i]) => [i.method, u, i.body ? JSON.parse(i.body) : undefined, i.headers["idempotency-key"]])).toEqual([
    ["GET", "/roles", undefined, undefined], ["POST", "/roles", { name: "X", base: "editor", boardRole: "viewer", permissions: ["move"] }, "key-12345"],
    ["PATCH", "/roles/r-fac", { name: "Y", confirm: true }, undefined], ["DELETE", "/roles/r-fac", undefined, undefined]]);
  for (const [, i] of s.calls) expect(i).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer tok" }), credentials: "omit", cache: "no-store" });
});

test("bodies are normalised: unknown fields dropped, bad roles dropped, strings and lists capped", () => {
  expect(normalizeRolesPage(PAGE)).toEqual(PAGE);
  const junk = normalizeRolesPage({ ...PAGE, roles: [...PAGE.roles, null, { id: "bad id", kind: "custom" }, { id: "x", kind: "wizard" }, { ...ROLE, id: "r-2", name: "n".repeat(500), permissions: ["board.edit", "<script>", 5], extra: 1 }] });
  expect(junk.roles.map(r => r.id)).toEqual(["r-fac", "member", "r-2"]);
  expect(junk.roles[2].name).toHaveLength(200);
  expect(junk.roles[2].permissions).toEqual(["board.edit"]);
  expect("extra" in junk.roles[2]).toBe(false);
  expect(normalizeRolesPage({ roles: [] })).toBe(null);
  expect(normalizeRolesPage({ ...PAGE, matrix: null })).toBe(null);
  expect(normalizeRole({ ...ROLE, used: { places: "many" } }).used).toEqual({ places: 0, capped: false });
  expect(normalizeRole({ ...ROLE, used: null }).used).toBe(null);
});

test("errors: status to error, the 409 bodies carry their counts, a malformed 200 is unavailable", async () => {
  const a = (status, body) => httpRoles({ fetch: answer(status, body), token: "t" });
  expect(await a(401, {}).roles()).toEqual({ error: "auth" });
  expect(await a(404, { error: "not-found" }).roles()).toEqual({ error: "notfound" });
  expect(await a(403, { error: "forbidden" }).updateRole("r-1", {})).toEqual({ error: "forbidden" });
  expect(await a(400, { error: "bad-request" }).updateRole("r-1", {})).toEqual({ error: "invalid" });
  expect(await a(409, { error: "confirm-required", impact: { places: 11, people: 60, capped: true } }).updateRole("r-1", {})).toEqual({ error: "conflict", code: "confirm-required", impact: { places: 11, people: 60, capped: true } });
  expect(await a(409, { error: "in-use", places: 3, capped: false }).removeRole("r-1")).toEqual({ error: "conflict", code: "in-use", used: { places: 3, capped: false } });
  expect(await a(409, { error: "too-large" }).createRole({ name: "x", boardRole: "viewer", permissions: [] })).toEqual({ error: "conflict", code: "too-large" });
  expect(await a(503, { error: "unavailable" }).roles()).toEqual({ error: "unavailable" });
  expect(await a(200, "not json").roles()).toEqual({ error: "unavailable" });
  expect(await a(200, { roles: "x" }).roles()).toEqual({ error: "unavailable" });
  expect(await httpRoles({ fetch: async () => { throw new Error("down"); }, token: "t" }).roles()).toEqual({ error: "network" });
  expect(await a(200, PAGE).updateRole("bad id!", {})).toEqual({ error: "forbidden" });                 // an id that is no id never reaches the network
  expect(await a(200, PAGE).removeRole("../x")).toEqual({ error: "forbidden" });
});

test("a keyed create is retried with the SAME key while the server says in progress, then gives up as unavailable", async () => {
  let n = 0; const keys = []; const waits = [];
  const fetch = async (url, init) => { keys.push(init.headers["idempotency-key"]); return ++n < 3 ? answer(409, { error: "in-progress" }, { "retry-after": "1" })() : answer(201, { role: ROLE })(); };
  const timers = { set: (f, ms) => { if (ms === 1000) { waits.push(ms); f(); } return 1; }, clear() {} };
  const r = await httpRoles({ fetch, token: "t", timers }).createRole({ name: "x", boardRole: "viewer", permissions: [], key: "key-12345" });
  expect(r.role.id).toBe("r-fac");
  expect(keys).toEqual(["key-12345", "key-12345", "key-12345"]);
  expect(waits).toEqual([1000, 1000]);
  const never = async () => answer(409, { error: "in-progress" }, { "retry-after": "1" })();
  expect(await httpRoles({ fetch: never, token: "t", timers }).createRole({ name: "x", boardRole: "viewer", permissions: [], key: "key-12345" })).toEqual({ error: "unavailable" });
});

test("a request with no answer in time is unavailable and aborts", async () => {
  let fire; const timers = { set: f => { fire = f; return 1; }, clear() {} };
  const p = httpRoles({ fetch: () => new Promise(() => {}), token: "t", timers }).roles();
  await Promise.resolve(); fire();
  expect(await p).toEqual({ error: "unavailable" });
});
