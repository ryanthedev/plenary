// The dev menu adapter (web/adapters/auth/devconfig.js) over a fake fetch: a good menu, and null for everything else.
import { test, expect } from "bun:test";
import { httpDevConfig } from "../../../web/adapters/auth/devconfig.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const menu = (fetch, o = {}) => httpDevConfig({ fetch, ...o }).get();
const GOOD = { board: "b-1", users: [{ name: "ada", token: "dev-ada", role: "owner" }, { name: "bo", token: "dev-bo", role: "editor" }] };

test("a good answer is the menu, asked with GET /auth/dev, never cached", async () => {
  let seen;
  const r = await menu(async (url, init) => { seen = [url, init]; return answer(200, GOOD)(); });
  expect(r).toEqual(GOOD);
  expect(seen[0]).toBe("/auth/dev");
  expect(seen[1]).toMatchObject({ method: "GET", cache: "no-store", credentials: "same-origin" });
});

test("every other answer is null: 404 (dev off), 5xx, not JSON, wrong shape, no users, fetch throws", async () => {
  for (const f of [answer(404, { error: "not-found" }), answer(503, GOOD), answer(200, "<html>captive</html>"), answer(200, []), answer(200, { board: "b-1" }),
    answer(200, { board: "../x", users: GOOD.users }), answer(200, { board: "b-1", users: [] }), async () => { throw new Error("offline"); }, async () => null])
    expect(await menu(f)).toBeNull();
});

test("bad users are dropped, good ones kept: odd names, blank or spaced tokens, duplicates, an unknown role shape", async () => {
  const r = await menu(answer(200, { board: "b-1", users: [
    { name: "a b", token: "t" }, { name: "x", token: "" }, { name: "y", token: "has space" }, { name: "ok", token: "t1", role: "Owner!" },
    { name: "ok", token: "t2", role: "viewer" }, null, "str", { name: "z" },
  ] }));
  expect(r).toEqual({ board: "b-1", users: [{ name: "ok", token: "t1", role: "editor" }] });
});

test("no answer in time is null, and the timer is cleared", async () => {
  const cleared = [];
  const timers = { set: (fn, ms) => { setTimeout(fn, 5); return ms; }, clear: h => cleared.push(h) };
  expect(await menu(() => new Promise(() => {}), { timers, timeoutMs: 1234 })).toBeNull();
  expect(cleared).toEqual([1234]);
});

test("fetch is required", () => { expect(() => httpDevConfig({})).toThrow(TypeError); });
