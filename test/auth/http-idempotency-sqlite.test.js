// Exactly-once keyed creates over HTTP on a REAL durable Registry (#86): the DW-86b case end to end on SQLite, so the in-transaction key row is
// exercised through http.js -> spaces.js -> the adapter, not only on the memory adapter (http-idempotency.test.js).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { sqliteRegistry } from "../../server/registry/sqlite.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { homeService } from "../../server/auth/home.js";
import { devAuth } from "../../server/auth/dev.js";

const ORIGIN = "https://plenary.test";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
let dir, mem, reg, routes, acme, failAfter;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "plenary-keyed-"));
  mem = sqliteRegistry({ path: join(dir, "r.db"), fullfsync: false });
  failAfter = null;
  reg = new Proxy(mem, { get(o, k) { const v = o[k]; return typeof v === "function" ? async (...a) => { const out = await v.apply(o, a); await failAfter?.[k]?.(); return out; } : v; } });
  const tenancy = makeTenancy({ registry: reg });
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" } } });
  acme = await mem.createTenant({ domain: "acme.com", admins: ["dev:ada"] });
  routes = httpRoutes({ registry: reg, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy, home: homeService({ registry: reg, tenancy }), config, dev, log: { warn() {} } });
});
afterEach(async () => { await mem.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (path, body, key) => routes(new Request(ORIGIN + path, { method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer ada", "idempotency-key": key }, body: JSON.stringify(body) }));
const boardIds = async () => (await mem.boardsIn({ type: "unit", id: acme.id })).ids;

test("DW-86b on SQLite: a board create that commits and then fails unclearly: the retry returns the first board at once, with its owner, and makes no second", async () => {
  failAfter = { createBoard: () => { throw Object.assign(new Error("no answer"), { code: "client-timeout" }); } };
  expect((await post("/boards", { title: "Once" }, "key-sqlite-01")).status).toBe(503);
  failAfter = null;
  const [id] = await boardIds();
  expect(await boardIds()).toHaveLength(1);   // it did commit
  const retry = await post("/boards", { title: "Once" }, "key-sqlite-01");
  expect([retry.status, retry.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
  expect((await retry.json()).board.id).toBe(id);
  expect(await boardIds()).toEqual([id]);
  expect(await mem.grants(id)).toEqual([{ user: "dev:ada", role: "owner" }]);
});

test("on SQLite a link and a team behave the same: one object per key across retries and a changed body is 422", async () => {
  const board = (await (await post("/boards", { title: "B" }, "key-sqlite-02")).json()).board.id;
  const a = await (await post(`/boards/${board}/links`, { role: "viewer" }, "key-sqlite-03")).json();
  const b = await (await post(`/boards/${board}/links`, { role: "viewer" }, "key-sqlite-03")).json();
  expect(b.link.id).toBe(a.link.id);
  expect(await mem.links(board)).toHaveLength(1);
  const t1 = await (await post("/teams", { name: "Ops" }, "key-sqlite-04")).json();
  const t2 = await (await post("/teams", { name: "Ops" }, "key-sqlite-04")).json();
  expect(t2.team.id).toBe(t1.team.id);
  expect((await post("/teams", { name: "Other" }, "key-sqlite-04")).status).toBe(422);
  expect(await mem.teams(acme.id)).toHaveLength(1);
});
