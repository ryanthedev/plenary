// web/adapters/move/http.js over a fake fetch: the requests it makes, the shapes it accepts, and that no call ever rejects (web/ports/move.js).
import { test, expect } from "bun:test";
import { httpMove } from "../../../web/adapters/move/http.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const OPTIONS = { board: { id: "b-1", title: "Roadmap" }, from: { id: "s-1", name: "Mine", personal: true }, destinations: [{ id: "s-2", name: "Design", personal: false, general: "viewer", group: { id: "g-1", name: "Product" } }], more: false };
const DIFF = { board: { id: "b-1", title: "Roadmap" }, from: { hidden: true }, to: { id: "s-2", name: "Design", personal: false },
  gains: [{ subject: { type: "team", id: "tm-1", name: "Design team" }, before: null, after: { id: "editor", name: "Editor" } }], keeps: [{ subject: { type: "user", id: "google:a", name: "Ada" }, self: true, before: { id: "owner", name: "Owner" }, after: { id: "owner", name: "Owner" } }],
  loses: [], invites: 1, links: null, hidden: true, more: false };
const RESULT = { board: { id: "b-1", title: "Roadmap", space: { id: "s-2", name: "Design" } }, moved: true, undo: { space: { id: "s-1", name: "Mine", personal: true } } };
const api = (fetch, o = {}) => httpMove({ fetch, token: "tok", ...o });

test("options, preview and move: Bearer token, no cookies, never cached, bodies normalised", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push([u, i]); return answer(200, u.includes("preview") ? DIFF : i.method === "POST" ? RESULT : OPTIONS)(); };
  expect((await api(f).options("b-1")).options).toEqual(OPTIONS);
  expect((await api(f).preview("b-1", "s-2")).diff).toEqual(DIFF);
  expect((await api(f).move("b-1", { from: "s-1", to: "s-2" }, "key-1")).result).toEqual(RESULT);
  expect(calls.map(c => c[0])).toEqual(["/boards/b-1/move", "/boards/b-1/move/preview?to=s-2", "/boards/b-1/move"]);
  expect(calls[0][1].headers.authorization).toBe("Bearer tok");
  expect(calls[0][1]).toMatchObject({ credentials: "omit", cache: "no-store" });
  expect(calls[2][1].headers["idempotency-key"]).toBe("key-1");
  expect(JSON.parse(calls[2][1].body)).toEqual({ from: "s-1", to: "s-2" });
});
test("a result with no undo is null; a move without a `from` Space id is refused before any request", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push(i); return answer(200, { ...RESULT, undo: null })(); };
  const r = await api(f).move("b-1", { from: "s-1", to: "s-2" });
  expect(JSON.parse(calls[0].body)).toEqual({ from: "s-1", to: "s-2" });
  expect(r.result.undo).toBeNull();
  expect(await api(f).move("b-1", { from: null, to: "s-2" })).toEqual({ error: "forbidden" });
  expect(calls).toHaveLength(1);
});
test("statuses map to errors: 401 auth, 403 forbidden, 404 notfound, 409 moved, 400/422 invalid, 5xx and junk unavailable, a throw network", async () => {
  for (const [status, error] of [[401, "auth"], [403, "forbidden"], [404, "notfound"], [409, "moved"], [400, "invalid"], [422, "invalid"], [503, "unavailable"], [201, "unavailable"]]) expect(await api(answer(status, {})).options("b-1")).toEqual({ error });
  expect(await api(answer(200, "not json")).options("b-1")).toEqual({ error: "unavailable" });
  expect(await api(answer(200, { board: { id: "b-1" } })).options("b-1")).toEqual({ error: "unavailable" });
  expect(await api(async () => { throw new Error("x"); }).options("b-1")).toEqual({ error: "network" });
});
test("bad ids never reach the network", async () => {
  let n = 0; const f = async () => { n++; return answer(200, OPTIONS)(); };
  for (const r of [await api(f).options("a b"), await api(f).preview("b-1", "x/y"), await api(f).move("b-1", { from: "../", to: "s-2" })]) expect(r).toEqual({ error: "forbidden" });
  expect(n).toBe(0);
});
test("a request with no answer in time is unavailable", async () => {
  const timers = { set: (fn) => { fn(); return 1; }, clear() {} };
  expect(await api(() => new Promise(() => {}), { timers }).options("b-1")).toEqual({ error: "unavailable" });
});
test("text fields are capped and unknown subject types dropped", async () => {
  const f = answer(200, { ...DIFF, gains: [{ subject: { type: "alien", name: "x" }, before: null, after: null }, { subject: { type: "user", id: "u", name: "n".repeat(900) }, before: null, after: { id: "viewer", name: "Viewer" } }] });
  const d = (await api(f).preview("b-1", "s-2")).diff;
  expect(d.gains.length).toBe(1);
  expect(d.gains[0].subject.name.length).toBe(200);
});
