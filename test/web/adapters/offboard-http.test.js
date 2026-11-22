// web/adapters/offboard/http.js over a fake fetch: the requests it makes, the shapes it accepts, and that no call ever rejects (web/ports/offboard.js).
import { test, expect } from "bun:test";
import { httpOffboard } from "../../../web/adapters/offboard/http.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const PAGE = { member: { id: "google:sam", name: "Sam", email: "sam@acme.com", removed: false }, defaults: { recipient: { id: "google:root", name: "Root" }, reason: "remover" },
  items: [{ type: "space", id: "s-1", name: "Sam's space <b>", personal: true, archived: false, trashed: false, boards: 14, boardsCapped: false, can: { reassign: true } },
    { type: "group", id: "g-1", name: "Research", personal: false, archived: false, trashed: false, can: { reassign: false, why: "Needs a Unit admin" } }, { type: "board", id: "b-1" }], next: null, blocked: null, canRemove: false };
const api = (fetch, o = {}) => httpOffboard({ fetch, token: "tok", ...o });

test("list: Bearer token, no cookies, never cached, the user id URL-encoded, a cursor passed; the body is normalised (a board item is dropped)", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push([u, i]); return answer(200, PAGE)(); };
  const { page } = await api(f).list("google:sam", "space\ns-0");
  expect(page.items.map(i => i.id)).toEqual(["s-1", "g-1"]);
  expect(page.items[0]).toMatchObject({ boards: 14, can: { reassign: true } });
  expect(page.items[1].can).toEqual({ reassign: false, why: "Needs a Unit admin" });
  expect(calls[0][0]).toBe("/members/google%3Asam/offboarding?after=space%0As-0");
  expect(calls[0][1].headers.authorization).toBe("Bearer tok");
  expect(calls[0][1]).toMatchObject({ credentials: "omit", cache: "no-store" });
});
test("reassign and remove: a key header, the body, the answers", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push([u, i]); return answer(200, u.endsWith("/remove") ? { removed: true, grants: 2, scopedGrants: 1, teams: 0 } : { item: { type: "space", id: "s-1", name: "Sam's space (archived)", archived: true }, to: { id: "google:ada", name: "Ada" }, done: true })(); };
  const r = await api(f).reassign("google:sam", { type: "space", id: "s-1", to: "google:ada" }, "key-1");
  expect(r.result).toEqual({ item: { type: "space", id: "s-1", name: "Sam's space (archived)", archived: true }, to: { id: "google:ada", name: "Ada" }, done: true });
  expect(calls[0][1].headers["idempotency-key"]).toBe("key-1");
  expect(JSON.parse(calls[0][1].body)).toEqual({ type: "space", id: "s-1", to: "google:ada" });
  expect((await api(f).remove("google:sam", "google:ada", "key-2")).result).toEqual({ removed: true, grants: 2, scopedGrants: 1, teams: 0 });
  expect(calls[1][0]).toBe("/members/google%3Asam/remove");
  expect(JSON.parse(calls[1][1].body)).toEqual({ to: "google:ada" });                  // the new owner of their personal space goes with the removal
  expect(calls[1][1].headers["idempotency-key"]).toBe("key-2");
  await api(f).remove("google:sam", null, "key-3");
  expect(JSON.parse(calls[2][1].body)).toEqual({});
  expect(await api(f).remove("google:sam", "a\nb", "key-4")).toEqual({ error: "forbidden" });
});
test("statuses map to errors, with the server's code: 401 auth, 403 forbidden, 404 notfound, 400 bad-recipient, 409 still-owns, 5xx and junk unavailable, a throw network", async () => {
  for (const [status, body, want] of [[401, {}, { error: "auth" }], [403, {}, { error: "forbidden" }], [404, {}, { error: "notfound" }], [400, { error: "bad-recipient" }, { error: "invalid", code: "bad-recipient" }],
    [409, { error: "still-owns" }, { error: "conflict", code: "still-owns" }], [409, { error: "is-admin" }, { error: "conflict", code: "is-admin" }], [409, { error: "personal" }, { error: "conflict", code: "personal" }], [422, {}, { error: "invalid" }], [503, {}, { error: "unavailable" }]])
    expect(await api(answer(status, body)).remove("google:sam")).toEqual(want);
  expect(await api(answer(200, "not json")).list("google:sam")).toEqual({ error: "unavailable" });
  expect(await api(answer(200, { member: {} })).list("google:sam")).toEqual({ error: "unavailable" });
  expect(await api(async () => { throw new Error("x"); }).list("google:sam")).toEqual({ error: "network" });
});
test("bad input never reaches the network; people() asks the directory and keeps people only", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push(u); return answer(200, { people: [{ user: "google:ada", name: "Ada", email: "a@x" }, { id: "nope" }], teams: [{ id: "tm-1" }] })(); };
  expect(await api(f).list("")).toEqual({ error: "forbidden" });
  expect(await api(f).reassign("google:sam", { type: "board", id: "b-1", to: "google:ada" })).toEqual({ error: "forbidden" });
  expect(calls).toEqual([]);
  expect((await api(f).people("a d")).people).toEqual([{ id: "google:ada", name: "Ada" }]);
  expect(calls).toEqual(["/directory?q=a%20d"]);
});
