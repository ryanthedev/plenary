// web/adapters/access/http.js over a fake fetch: the requests it makes, the shapes it accepts, the error codes it passes on, and that no call ever rejects.
import { test, expect } from "bun:test";
import { httpAccess, normalizeAccessPage, normalizeTeamPage } from "../../../web/adapters/access/http.js";
import { ACCESS_ERRORS } from "../../../web/ports/access.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const ACCESS = { scope: { type: "space", id: "s-1", name: "Design" }, can: { manage: true }, general: [{ scope: { type: "space", id: "s-1", name: "Design" }, role: "viewer" }],
  rows: [{ subject: { type: "user", id: "google:ada", name: "ada", email: "ada@acme.com" }, role: "owner", roleName: "Owner", via: "direct", can: { change: true, remove: false } },
    { subject: { type: "team", id: "tm-1", name: "Infra", size: 3 }, role: "editor", roleName: "Editor", via: "team", can: { change: true, remove: true } }],
  next: null, inherited: [], roles: [{ id: "viewer", name: "Viewer", custom: false, summary: "Can view", ladder: "viewer", people: true }] };
const TEAM = { team: { id: "tm-1", name: "Infra", size: 2 }, can: { manage: true }, members: [{ user: "google:ada", name: "ada", email: "ada@acme.com" }], next: null };
const api = (fetch, o = {}) => httpAccess({ fetch, token: "tok", ...o });
const seen = () => { const calls = []; return { calls, fetch: async (url, init) => { calls.push([url, init]); return answer(init.method === "DELETE" || url.includes("/members/") ? 204 : 200, init.method === "DELETE" || url.includes("/members/") ? "" : { teams: [], people: [], team: TEAM.team, row: ACCESS.rows[0], ...ACCESS })(); } }; };

test("the routes, methods and bodies of PROTOCOL § Teams and access; user ids are URL-encoded; Bearer only", async () => {
  const s = seen(), a = api(s.fetch);
  await a.teams({ q: "in fra", after: "tm-0" }); await a.teams(); await a.team("tm-1"); await a.team("tm-1", "google:b"); await a.createTeam("Infra"); await a.renameTeam("tm-1", "Ops");
  await a.deleteTeam("tm-1"); await a.setMember("tm-1", "google:ada", true); await a.setMember("tm-1", "google:ada", false); await a.directory("ad"); await a.directory();
  await a.access("space", "s-1"); await a.access("board", "b-1", "team\ntm-1"); await a.setGrant("space", "s-1", { type: "user", id: "google:ada" }, "editor"); await a.removeGrant("space", "s-1", { type: "team", id: "tm-1" });
  expect(s.calls.map(([u, i]) => [i.method, u, i.body ? JSON.parse(i.body) : undefined])).toEqual([
    ["GET", "/teams?after=tm-0&q=in%20fra", undefined], ["GET", "/teams", undefined], ["GET", "/teams/tm-1", undefined], ["GET", "/teams/tm-1?after=google%3Ab", undefined],
    ["POST", "/teams", { name: "Infra" }], ["PATCH", "/teams/tm-1", { name: "Ops" }], ["DELETE", "/teams/tm-1", undefined],
    ["PUT", "/teams/tm-1/members/google%3Aada", undefined], ["DELETE", "/teams/tm-1/members/google%3Aada", undefined], ["GET", "/directory?q=ad", undefined], ["GET", "/directory", undefined],
    ["GET", "/access/space/s-1", undefined], ["GET", "/access/board/b-1?after=team%0Atm-1", undefined],
    ["PUT", "/access/space/s-1/grants/user/google%3Aada", { role: "editor" }], ["DELETE", "/access/space/s-1/grants/team/tm-1", undefined]]);
  for (const [, i] of s.calls) expect(i).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer tok" }), credentials: "omit", cache: "no-store" });
});

test("bodies are normalised: unknown fields dropped, bad rows dropped, lists and strings capped", async () => {
  expect(normalizeAccessPage(ACCESS)).toEqual(ACCESS);
  const junk = normalizeAccessPage({ ...ACCESS, rows: [...ACCESS.rows, { subject: { type: "robot", id: "x" }, role: "owner" }, null, { subject: { type: "user", id: "a\nb", name: "x" }, role: "viewer" }], roles: [{ id: 5 }, ...ACCESS.roles], extra: 1 });
  expect(junk.rows).toHaveLength(2);
  expect(junk.roles).toHaveLength(1);
  expect("extra" in junk).toBe(false);
  expect(normalizeAccessPage({ scope: { type: "planet", id: "x" }, rows: [] })).toBe(null);
  expect(normalizeAccessPage({ scope: { type: "space", id: "s-1" } })).toBe(null);
  expect(normalizeTeamPage(TEAM)).toEqual(TEAM);
  expect(normalizeTeamPage({ ...TEAM, members: [{ user: "" }, { user: "u", name: "n".repeat(500) }] }).members).toEqual([{ user: "u", name: "n".repeat(200), email: null }]);
  expect(normalizeTeamPage({ team: { id: "bad id" }, members: [] })).toBe(null);
});

test("every failure is a value from ACCESS_ERRORS (conflict and invalid carry the server's code), never a throw", async () => {
  const bad = [[answer(400, { error: "unknown-person" }), "invalid", "unknown-person"], [answer(400, { error: "bad-role" }), "invalid", "bad-role"], [answer(400, {}), "invalid"],
    [answer(401, {}), "auth"], [answer(403, {}), "forbidden"], [answer(404, {}), "notfound"], [answer(409, { error: "last-owner" }), "conflict", "last-owner"], [answer(409, { error: "too-large" }), "conflict", "too-large"],
    [answer(409, "<html>"), "conflict"], [answer(503, {}), "unavailable"], [answer(200, "<html>"), "unavailable"], [answer(200, { nope: 1 }), "unavailable", undefined, true], [async () => { throw new Error("offline"); }, "network"], [async () => null, "unavailable"]];
  const calls = [a => a.teams(), a => a.team("tm-1"), a => a.createTeam("x"), a => a.renameTeam("tm-1", "x"), a => a.deleteTeam("tm-1"), a => a.setMember("tm-1", "u", true), a => a.directory("x"),
    a => a.access("space", "s-1"), a => a.setGrant("space", "s-1", { type: "user", id: "u" }, "viewer"), a => a.removeGrant("space", "s-1", { type: "user", id: "u" })];
  const VOID = new Set([4, 5, 9]);                                   // deleteTeam, setMember, removeGrant: a 200 with any JSON body is a success (they read none)
  for (const [f, want, code, voidOk] of bad) for (const [i, call] of calls.entries()) {
    const r = await call(api(f));
    if (VOID.has(i) && voidOk) { expect(r).toEqual({}); continue; }
    expect(r).toEqual({ error: want, ...(code ? { code } : {}) });
    expect(ACCESS_ERRORS).toContain(r.error);
  }
  const timers = { set: fn => setTimeout(fn, 5), clear: h => clearTimeout(h) };
  expect(await api(() => new Promise(() => {}), { timers, timeoutMs: 5 }).teams()).toEqual({ error: "unavailable" });
  expect(() => httpAccess({ token: "t" })).toThrow(TypeError);
});

test("ids are checked before any request: a bad id or subject is refused without a fetch", async () => {
  const s = seen(), a = api(s.fetch);
  expect(await a.team("a b")).toEqual({ error: "notfound" });
  expect(await a.access("planet", "s-1")).toEqual({ error: "notfound" });
  expect(await a.access("space", "x/y")).toEqual({ error: "notfound" });
  expect(await a.setGrant("space", "s-1", { type: "robot", id: "u" }, "viewer")).toEqual({ error: "forbidden" });
  expect(await a.removeGrant("space", "s-1", { type: "user", id: "" })).toEqual({ error: "forbidden" });
  expect(await a.setMember("tm-1", "a\nb", true)).toEqual({ error: "forbidden" });
  expect(s.calls).toEqual([]);
});
