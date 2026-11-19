// web/adapters/home/http.js over a fake fetch: the request it makes, the shape it accepts, and that no call ever rejects (web/ports/home.js).
import { test, expect } from "bun:test";
import { httpHome, normalizeHome } from "../../../web/adapters/home/http.js";
import { HOME_ERRORS } from "../../../web/ports/home.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const GOOD = { guest: false, user: { user: "dev:ada", name: "ada" }, unit: { id: "t-1", kind: "company" }, limits: { recent: 12 },
  recent: [{ id: "b-1", title: "Roadmap", role: "editor", path: [{ type: "space", id: "s-1", name: "Design" }], starred: true, at: 5 }],
  starred: [], shared: [], tree: { groups: [{ id: "g-1", name: "Product", spaces: [{ id: "s-1", name: "Design", personal: false }] }], spaces: [], other: { boards: [{ id: "b-2", title: "Old" }], more: false }, more: false } };
const home = (fetch, o = {}) => httpHome({ fetch, token: "tok", ...o });

test("load: GET /home with the Bearer token, no cookies, never cached; the body comes back normalised", async () => {
  let seen;
  const r = await home(async (url, init) => { seen = [url, init]; return answer(200, GOOD)(); }).load();
  expect(seen[0]).toBe("/home");
  expect(seen[1]).toMatchObject({ method: "GET", headers: { authorization: "Bearer tok" }, credentials: "omit", cache: "no-store" });
  expect(r.home.recent[0]).toEqual(GOOD.recent[0]);
  expect(r.home.tree.groups[0].spaces[0]).toEqual({ id: "s-1", name: "Design", personal: false });
  expect(r.home.limits).toEqual({ recent: 12 });
});

test("every failure is a value from HOME_ERRORS, never a throw: 401, 403, 5xx, bad JSON, wrong shape, offline, silence", async () => {
  const bad = [[answer(401, {}), "auth"], [answer(403, {}), "forbidden"], [answer(503, {}), "unavailable"], [answer(200, "<html>"), "unavailable"],
    [answer(200, { nope: 1 }), "unavailable"], [async () => { throw new Error("offline"); }, "network"], [async () => null, "unavailable"]];
  for (const [f, want] of bad) {
    const r = await home(f).load();
    expect(r).toEqual({ error: want });
    expect(HOME_ERRORS).toContain(r.error);
  }
  const timers = { set: fn => setTimeout(fn, 5), clear: h => clearTimeout(h) };
  expect(await home(() => new Promise(() => {}), { timers, timeoutMs: 1 }).load()).toEqual({ error: "unavailable" });
  expect(() => httpHome({ token: "t" })).toThrow(TypeError);
});

test("normalizeHome drops what the page must not render: bad ids, odd types, oversize lists and strings", () => {
  const n = normalizeHome({ ...GOOD, recent: [{ id: "../x", title: "t" }, null, "s", { id: "ok", title: "x".repeat(500), path: [{ type: "evil", name: "n" }, { type: "group", name: "G" }], starred: "yes" }, ...Array.from({ length: 80 }, (_, i) => ({ id: "c" + i }))] });
  expect(n.recent.length).toBe(47);   // the first 50 entries, minus the 3 bad ones
  expect(n.recent[0]).toEqual({ id: "ok", title: "x".repeat(200), role: "", path: [{ type: "group", name: "G" }], starred: false });
  expect(normalizeHome({ guest: "no" })).toBe(null);
  expect(normalizeHome(null)).toBe(null);
});

test("search: encodes q, returns normalised results and the more flag; a body without results is unavailable", async () => {
  let url;
  const r = await home(async u => { url = u; return answer(200, { q: "a b&c", results: [GOOD.recent[0]], more: true })(); }).search("a b&c");
  expect(url).toBe("/home/search?q=a%20b%26c");
  expect(r).toEqual({ q: "a b&c", results: [GOOD.recent[0]], more: true });
  expect(await home(answer(200, {})).search("x")).toEqual({ error: "unavailable" });
  expect(await home(answer(401, {})).search("x")).toEqual({ error: "auth" });
});

test("star: PUT to star, DELETE to unstar, 204 is ok, 403 forbidden; a bad id makes no request", async () => {
  const seen = [];
  const f = status => async (u, init) => { seen.push([u, init.method]); return { status, text: async () => "" }; };
  expect(await home(f(204)).star("b-1", true)).toEqual({ ok: true });
  expect(await home(f(204)).star("b-1", false)).toEqual({ ok: true });
  expect(await home(f(403)).star("b-1", true)).toEqual({ error: "forbidden" });
  expect(seen).toEqual([["/home/stars/b-1", "PUT"], ["/home/stars/b-1", "DELETE"], ["/home/stars/b-1", "PUT"]]);
  expect(await home(f(204)).star("../x", true)).toEqual({ error: "forbidden" });
  expect(seen.length).toBe(3);
});

test("owned and the 'shared' path part survive normalisation", () => {
  const n = normalizeHome({ ...GOOD, owned: [{ id: "o1", title: "Mine", role: "owner", path: [{ type: "shared", name: "Shared with you" }], starred: false }] });
  expect(n.owned).toEqual([{ id: "o1", title: "Mine", role: "owner", path: [{ type: "shared", name: "Shared with you" }], starred: false }]);
  expect(normalizeHome({ ...GOOD, owned: undefined }).owned).toEqual([]);
});

test("a card or node with no id is dropped (a missing id is not the id \"undefined\")", () => {
  const n = normalizeHome({ ...GOOD, recent: [{ title: "no id", role: "viewer", path: [], starred: false }, GOOD.recent[0]] });
  expect(n.recent.map(c => c.id)).toEqual(["b-1"]);
});
