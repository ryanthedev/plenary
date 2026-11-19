// The Home routes in server/auth/http.js (PROTOCOL.md § Home): authentication like every other route, the answers, and the refusals.
import { test, expect, beforeEach } from "bun:test";
import { httpRoutes } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { homeService } from "../../server/auth/home.js";
import { devAuth } from "../../server/auth/dev.js";

const ORIGIN = "https://plenary.test";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
let registry, routes, acme, open, closed, tenancy;
const as = tok => ({ authorization: `Bearer ${tok}` });
const call = (path, init = {}) => routes(new Request(ORIGIN + path, init));

beforeEach(async () => {
  registry = memoryRegistry();
  tenancy = makeTenancy({ registry });
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" }, kim: { name: "kim", email: "kim@partner.io" } } });
  routes = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy, home: homeService({ registry, tenancy }), config, dev });
  acme = await registry.createTenant({ domain: "acme.com" });
  const sp = await registry.createSpace({ tenant: acme.id, name: "Design" });
  const secret = await registry.createSpace({ tenant: acme.id, name: "Secret", generalRole: null });
  open = await registry.createBoard({ tenant: acme.id, title: "Roadmap", space: sp.id });
  closed = await registry.createBoard({ tenant: acme.id, title: "Roadmap secret", space: secret.id, memberRole: null });
});

test("GET /home: 401 without a token, then the member's Home; the closed board is nowhere in it", async () => {
  const none = await call("/home");
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toBe("Bearer");
  await registry.markOpened("dev:ada", open.id); await registry.markOpened("dev:ada", closed.id);
  const res = await call("/home", { headers: as("ada") });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const h = await res.json();
  expect(h).toMatchObject({ guest: false, user: { user: "dev:ada" }, unit: { id: acme.id } });
  expect(h.recent.map(c => c.id)).toEqual([open.id]);
  expect(JSON.stringify(h)).not.toContain(closed.id);
  expect(h.limits.recent).toBe(12);
});

test("GET /home for a guest: Shared with me only", async () => {
  await registry.createInvite({ board: closed.id, email: "kim@partner.io", role: "viewer", by: "x" });
  const h = await (await call("/home", { headers: as("kim") })).json();
  expect(h).toMatchObject({ guest: true, unit: null, recent: [], starred: [], tree: null });
  expect(h.shared.map(c => c.id)).toEqual([closed.id]);
});

test("GET /home/search: q validated (400), results scoped to what can be opened, path included", async () => {
  const res = await (await call("/home/search?q=roadmap", { headers: as("ada") })).json();
  expect(res.results.map(c => [c.id, c.path.map(p => p.name)])).toEqual([[open.id, ["Design"]]]);
  for (const q of ["", "%20%20", "x".repeat(101), "a%00b"]) expect((await call(`/home/search?q=${q}`, { headers: as("ada") })).status).toBe(400);
  expect((await call("/home/search")).status).toBe(401);
  expect((await call("/home/search", { headers: as("ada"), method: "POST" })).status).toBe(405);
});

test("PUT / DELETE /home/stars/:board: 204; 403 for a board with no role or an unknown one (same answer); un-star is idempotent", async () => {
  expect((await call(`/home/stars/${open.id}`, { method: "PUT", headers: as("ada") })).status).toBe(204);
  expect((await registry.starred("dev:ada")).map(x => x.board)).toEqual([open.id]);
  const a = await call(`/home/stars/${closed.id}`, { method: "PUT", headers: as("ada") });
  const b = await call("/home/stars/b-nope000000000000", { method: "PUT", headers: as("ada") });
  expect([a.status, b.status]).toEqual([403, 403]);
  expect(await a.json()).toEqual(await b.json());
  expect(await registry.starred("dev:ada")).toHaveLength(1);
  expect((await call(`/home/stars/${open.id}`, { method: "DELETE", headers: as("ada") })).status).toBe(204);
  expect((await call(`/home/stars/${open.id}`, { method: "DELETE", headers: as("ada") })).status).toBe(204);
  expect(await registry.starred("dev:ada")).toEqual([]);
  expect((await call(`/home/stars/${open.id}`, { method: "PUT" })).status).toBe(401);
});

test("a Registry outage is a 503, not an empty Home", async () => {
  const broken = { ...registry, recents: async () => { throw new Error("db down"); } };
  const t = makeTenancy({ registry: broken });
  const r = httpRoutes({ registry: broken, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: t, home: homeService({ registry: broken, tenancy: t }), config,
    dev: devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com" } } }) });
  expect((await r(new Request(ORIGIN + "/home", { headers: as("ada") }))).status).toBe(503);
});

test("without a `home` dependency there are no Home routes", async () => {
  const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy, config });
  expect(await r(new Request(ORIGIN + "/home"))).toBe(null);
});
