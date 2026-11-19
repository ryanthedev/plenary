// web/adapters/trash/http.js over a fake fetch: the requests it makes, the shapes it accepts, and that no call ever rejects (web/ports/trash.js).
import { test, expect } from "bun:test";
import { httpTrash } from "../../../web/adapters/trash/http.js";

const answer = (status, body) => async () => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const TRASHED = { board: { id: "b-1", title: "Roadmap", space: { id: "s-1", name: "Design" } }, trashed: true, trashedAt: 10, expiresAt: 20, undo: { restore: true } };
const RESTORED = { board: { id: "b-1", title: "Roadmap", space: { id: "s-1", name: "Design" } }, restored: true };
const SPACE = { space: { id: "s-1", name: "Design" }, trashed: true, boards: 3, undo: { restore: true } };
const NOTICE = { board: { id: "b-1", title: "Roadmap" }, trashedAt: 10, expiresAt: 20, daysLeft: 28, canRestore: true, by: { id: "google:ada", name: "Ada" },
  from: { space: { id: "s-1", name: "Design", personal: false }, group: { id: "g-1", name: "Product" } } };
const LIST = { items: [
  { type: "board", id: "b-1", title: "Roadmap", from: { space: { id: "s-1", name: "Design", personal: false }, group: null }, by: { id: "google:ada", name: "Ada" }, trashedAt: 1, expiresAt: 2, daysLeft: 27 },
  { type: "space", id: "s-2", name: "Old", group: { id: "g-1", name: "Product" }, boards: 4, by: null, trashedAt: 1, expiresAt: 2, daysLeft: 0 }], more: false };
const api = (fetch, o = {}) => httpTrash({ fetch, token: "tok", ...o });

test("trash, restore, the Space calls, notice and list: Bearer token, no cookies, never cached, bodies and keys as the protocol says", async () => {
  const calls = [];
  const f = async (u, i) => { calls.push([u, i]); return answer(200, u === "/trash" ? LIST : u.endsWith("/trash") && i.method === "GET" ? NOTICE : u.startsWith("/spaces") ? SPACE : u.endsWith("/restore") ? RESTORED : TRASHED)(); };
  expect((await api(f).trash("b-1", { from: "s-1" }, "key-1")).result).toEqual(TRASHED);
  expect((await api(f).restore("b-1", "key-2")).result).toEqual(RESTORED);
  expect((await api(f).trashSpace("s-1", "key-3")).result).toMatchObject({ space: { id: "s-1" }, trashed: true, boards: 3 });
  expect((await api(f).restoreSpace("s-1")).result.space.id).toBe("s-1");
  expect((await api(f).notice("b-1")).notice).toEqual(NOTICE);
  expect((await api(f).list()).list.items.map(i => [i.type, i.id])).toEqual([["board", "b-1"], ["space", "s-2"]]);
  expect(calls.map(c => `${c[1].method} ${c[0]}`)).toEqual(["POST /boards/b-1/trash", "POST /boards/b-1/restore", "POST /spaces/s-1/trash", "POST /spaces/s-1/restore", "GET /boards/b-1/trash", "GET /trash"]);
  for (const [, i] of calls) { expect(i.headers.authorization).toBe("Bearer tok"); expect(i).toMatchObject({ credentials: "omit", cache: "no-store" }); }
  expect(calls[0][1].headers["idempotency-key"]).toBe("key-1");
  expect(JSON.parse(calls[0][1].body)).toEqual({ from: "s-1" });
  expect(calls[3][1].headers["idempotency-key"]).toBeUndefined();
  expect(calls[4][1].body).toBeUndefined();
});
test("statuses map to errors, and a 409 is told apart by the server's own code", async () => {
  for (const [status, error] of [[401, "auth"], [403, "forbidden"], [404, "notfound"], [400, "invalid"], [422, "invalid"], [503, "unavailable"], [201, "unavailable"]]) expect(await api(answer(status, {})).restore("b-1")).toEqual({ error });
  for (const code of ["moved", "with-space", "space-in-trash", "purged"]) expect(await api(answer(409, { error: code })).restore("b-1")).toEqual({ error: code });
  expect(await api(answer(409, "junk")).restore("b-1")).toEqual({ error: "moved" });
  expect(await api(answer(200, "not json")).list()).toEqual({ error: "unavailable" });
  expect(await api(answer(200, { board: { id: "b-1" } })).trash("b-1", { from: "s-1" })).toEqual({ error: "unavailable" });
  expect(await api(async () => { throw new Error("x"); }).list()).toEqual({ error: "network" });
});
test("bad ids never reach the network; a missing `from` is refused", async () => {
  let n = 0; const f = async () => { n++; return answer(200, TRASHED)(); };
  for (const r of [await api(f).trash("a b", { from: "s-1" }), await api(f).trash("b-1", { from: "../" }), await api(f).restore("x/y"), await api(f).notice("a b"), await api(f).trashSpace("a b"), await api(f).restoreSpace("")]) expect(r).toEqual({ error: "forbidden" });
  expect(n).toBe(0);
});
test("a request with no answer in time is unavailable", async () => {
  const timers = { set: (fn) => { fn(); return 1; }, clear() {} };
  expect(await api(() => new Promise(() => {}), { timers }).list()).toEqual({ error: "unavailable" });
});
test("shapes are checked: a list drops items it cannot read and caps text; a notice with no days left is refused", async () => {
  const f = answer(200, { items: [{ type: "alien", id: "x-1", daysLeft: 1 }, { type: "board", id: "b 1", daysLeft: 1 }, { type: "board", id: "b-2", title: "t".repeat(900), from: {}, by: { id: "u", name: "n".repeat(900) }, daysLeft: -1 }, { type: "board", id: "b-3", title: "ok", from: {}, daysLeft: 5 }], more: true });
  const r = (await api(f).list()).list;
  expect(r.items.map(i => i.id)).toEqual(["b-3"]);
  expect(r.more).toBe(true);
  const g = (await api(answer(200, { items: [{ type: "board", id: "b-9", title: "t".repeat(900), from: {}, by: { id: "u", name: "n".repeat(900) }, daysLeft: 3 }] })).list()).list.items[0];
  expect([g.title.length, g.by.name.length]).toEqual([200, 200]);
  expect(await api(answer(200, { ...NOTICE, daysLeft: "soon" })).notice("b-1")).toEqual({ error: "unavailable" });
});

test("a restore into the personal space carries movedTo; a notice carries `into`; the escalation refusal is its own error", async () => {
  const MOVED = { ...RESTORED, movedTo: { id: "s-9", name: "ada's space", personal: true } };
  expect((await api(answer(200, MOVED)).restore("b-1")).result.movedTo).toEqual({ id: "s-9", name: "ada's space", personal: true });
  expect((await api(answer(200, RESTORED)).restore("b-1")).result.movedTo).toBeUndefined();
  expect((await api(answer(200, { ...NOTICE, into: { id: "s-9", name: "mine", personal: true } })).notice("b-1")).notice.into).toEqual({ id: "s-9", name: "mine", personal: true });
  expect(await api(answer(409, { error: "would-escalate" })).restore("b-1")).toEqual({ error: "would-escalate" });
});

test("a notice's `into` may have no id yet (the personal space is created on restore); a bad one is dropped", async () => {
  const ok = await api(answer(200, { ...NOTICE, into: { id: null, name: null, personal: true } })).notice("b-1");
  expect(ok.notice.into).toEqual({ id: null, name: null, personal: true });
  expect((await api(answer(200, { ...NOTICE, into: { id: "bad id", name: "x", personal: true } })).notice("b-1")).notice.into).toBeUndefined();
  expect((await api(answer(200, { ...NOTICE, into: { id: "s-1", name: "x", personal: false } })).notice("b-1")).notice.into).toBeUndefined();
});
