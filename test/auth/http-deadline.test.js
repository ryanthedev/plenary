// The request deadline (PROTOCOL.md "HTTP request deadline", #73, TECH-DEBT row 16): every route in server/auth/http.js answers 503
// `unavailable` within config.requestDeadlineMs when the Registry (or Sessions, or the IdP) is slow, on VIRTUAL time, and a late result
// is dropped. The guard test enumerates the route table, so a route added later has to be classified here or the suite fails.
import { test, expect, beforeEach } from "bun:test";
import { httpRoutes, LOGIN_COOKIE, EXCHANGE_COOKIE } from "../../server/auth/http.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { homeService } from "../../server/auth/home.js";
import { googleOidc } from "../../server/auth/oidc.js";
import { devAuth } from "../../server/auth/dev.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

const ORIGIN = "https://plenary.test";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}", publicUrl: ORIGIN };
const DEADLINE = 8000;

/** Virtual timers: nothing fires until advance(). */
function virtualTimers() {
  let t = 0, id = 0; const q = new Map();
  return {
    set: (fn, ms) => { q.set(++id, { fn, at: t + ms }); return id; },
    clear: h => { q.delete(h); },
    advance(ms) { t += ms; for (const [h, e] of [...q]) if (e.at <= t) { q.delete(h); e.fn(); } },
    pending: () => q.size,
  };
}

/** Wrap an object's methods: while `gate.hung`, a call never answers until gate.release(), which runs it for real and settles the late promise. */
function gated(target, gate) {
  return new Proxy(target, { get(o, k) {
    const v = o[k];
    if (typeof v !== "function") return v;
    return (...a) => gate.hung ? new Promise((res, rej) => gate.late.push(() => Promise.resolve(v.apply(o, a)).then(res, rej))) : v.apply(o, a);
  } });
}
const flush = () => new Promise(r => setImmediate(r));
const as = tok => ({ authorization: `Bearer ${tok}` });
const json = body => ({ "content-type": "application/json", ...as("ada") });

let gate, vt, registry, mem, routes, hungOidc, table, acme, idp, realOidc;
beforeEach(async () => {
  gate = { hung: false, late: [], release() { const l = gate.late.splice(0); gate.hung = false; for (const f of l) f(); } };
  vt = virtualTimers();
  mem = memoryRegistry();
  registry = gated(mem, gate);
  const tenancy = gated(makeTenancy({ registry }), gate);
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" } } });
  idp = await fakeIdp({ now: Date.now }); await idp.addKey("k1");
  realOidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: ORIGIN + "/auth/callback", fetch: idp.fetch, now: Date.now });
  // begin hangs (GET /auth/login); finish hangs once gate.idp is set (GET /auth/callback with a valid state).
  hungOidc = { begin: () => (gate.idpBegin ? new Promise(() => {}) : realOidc.begin()), finish: a => (gate.idp ? new Promise(() => {}) : realOidc.finish(a)) };
  acme = await mem.createTenant({ domain: "acme.com" });
  // Every optional dependency on: home, oidc, the dev sign-in menu. The guard enumerates what this builds.
  routes = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy, home: gated(homeService({ registry, tenancy }), gate), oidc: hungOidc, dev,
    config: { ...config, devSignIn: { board: "b-dev", users: [{ name: "ada", token: "ada", role: "editor" }], hosts: ["localhost"] } },
    timers: vt, log: { warn() {} }, testHooks: { routes: t => { table = t; } } });
});

/** Run `p`; it must still be pending until the virtual deadline, then answer 503 unavailable. */
async function expect503AtDeadline(p, at = DEADLINE) {
  let res = null; p.then(r => { res = r; });
  await flush();
  expect(res).toBeNull();
  vt.advance(at - 1); await flush();
  expect(res).toBeNull();
  vt.advance(1); await flush();
  expect(res?.status).toBe(503);
  expect(await res.json()).toEqual({ error: "unavailable" });
  expect(res.headers.get("cache-control")).toBe("no-store");
}

// Every route, by "METHOD pattern": the request that reaches the slow dependency. `fast` = answers without touching Registry/IdP,
// so it needs no deadline to answer (its status is pinned).
const B = "board-1";
const ROUTES = {
  "GET /auth/dev": { path: "/auth/dev", headers: { host: "localhost" }, at: 3000 },   // its own tighter wait, on the same timers
  "GET /auth/login": { path: "/auth/login", idpBegin: true },   // the IdP hangs
  "GET /auth/callback": { path: "/auth/callback", fast: 400 },
  "POST /auth/exchange": { path: "/auth/exchange", init: { method: "POST" }, fast: 403 },   // its slow-Sessions case is its own test below
  "GET /auth/logout": { path: "/auth/logout", fast: 302 },
  "POST /boards": { path: "/boards", body: { title: "t" } },
  "PATCH /boards/:board": { path: `/boards/${B}`, body: { title: "t" } },
  "GET /spaces": { path: "/spaces?can=board.create" },
  "POST /spaces": { path: "/spaces", body: { name: "s" } },
  "GET /groups": { path: "/groups?can=space.create" },
  "POST /groups": { path: "/groups", body: { name: "g" } },
  "GET /spaces/:id": { path: "/spaces/sp1" },
  "PATCH /spaces/:id": { path: "/spaces/sp1", body: { name: "n" } },
  "GET /groups/:id": { path: "/groups/g1" },
  "PATCH /groups/:id": { path: "/groups/g1", body: { name: "n" } },
  "GET /boards/:board/invites": { path: `/boards/${B}/invites` },
  "POST /boards/:board/invites": { path: `/boards/${B}/invites`, body: { email: "x@y.com", role: "viewer" } },
  "DELETE /boards/:board/invites/:id": { path: `/boards/${B}/invites/i1` },
  "GET /boards/:board/links": { path: `/boards/${B}/links` },
  "POST /boards/:board/links": { path: `/boards/${B}/links`, body: { role: "viewer" } },
  "DELETE /boards/:board/links/:id": { path: `/boards/${B}/links/l1` },
  "PUT /boards/:board/grants/:user": { path: `/boards/${B}/grants/google:2`, body: { role: "viewer" } },
  "GET /home": { path: "/home" },
  "GET /home/search": { path: "/home/search?q=road" },
  "PUT /home/stars/:board": { path: `/home/stars/${B}` },
  "DELETE /home/stars/:board": { path: `/home/stars/${B}` },
  "GET /links/:id": { path: "/links/abc" },
  "GET /teams": { path: "/teams" },
  "POST /teams": { path: "/teams", body: { name: "T" } },
  "GET /teams/:id": { path: "/teams/t1" },
  "PATCH /teams/:id": { path: "/teams/t1", body: { name: "T2" } },
  "DELETE /teams/:id": { path: "/teams/t1" },
  "PUT /teams/:id/members/:user": { path: "/teams/t1/members/dev:bo" },
  "DELETE /teams/:id/members/:user": { path: "/teams/t1/members/dev:bo" },
  "GET /roles": { path: "/roles" },
  "POST /roles": { path: "/roles", body: { name: "R", boardRole: "viewer", permissions: [] } },
  "PATCH /roles/:id": { path: "/roles/r-abc", body: { name: "R2" } },
  "DELETE /roles/:id": { path: "/roles/r-abc" },
  "GET /directory": { path: "/directory?q=a" },
  "GET /access/:type/:id": { path: "/access/space/sp1" },
  "POST /access/:type/:id/requests": { path: "/access/space/sp1/requests", body: { role: "editor" } },
  "DELETE /access/:type/:id/requests/:user": { path: "/access/space/sp1/requests/dev:bo" },
  "GET /boards/:board/explain": { path: `/boards/${B}/explain` },
  "PUT /access/:type/:id/grants/:subjectType/:subject": { path: "/access/space/sp1/grants/user/dev:bo", body: { role: "viewer" } },
  "DELETE /access/:type/:id/grants/:subjectType/:subject": { path: "/access/space/sp1/grants/user/dev:bo" },
};
const request = (key) => {
  const [method, ...rest] = key.split(" ");
  const f = ROUTES[key];
  const init = { method, ...(f.init ?? {}) };
  init.headers = f.headers ?? (f.body ? json(f.body) : (f.path.startsWith("/auth/") ? {} : as("ada")));
  if (f.body) init.body = JSON.stringify(f.body);
  return new Request(ORIGIN + f.path, init);
};

test("guard: every route in the table is classified here; the ones that reach a slow dependency answer 503 at the deadline", async () => {
  const keys = table.flatMap(r => r.methods.map(m => `${m} ${r.pattern}`));
  expect(keys.filter(k => !(k in ROUTES))).toEqual([]);   // a new route: add its request above
  expect(Object.keys(ROUTES).filter(k => !keys.includes(k))).toEqual([]);   // a stale entry
  gate.hung = true; gate.idpBegin = true;
  for (const key of keys) {
    const f = ROUTES[key];
    if (f.fast) { const r = await routes(request(key)); expect([key, r.status]).toEqual([key, f.fast]); continue; }
    await expect503AtDeadline(routes(request(key)), f.at);
  }
  expect(vt.pending()).toBe(0);   // no timer left behind
});

test("POST /auth/exchange: a slow Sessions.issue answers 503 at the deadline", async () => {
  const idp = await fakeIdp({ now: Date.now }); await idp.addKey("k1");
  const oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: ORIGIN + "/auth/callback", fetch: idp.fetch, now: Date.now });
  const real = await makeSessions({ key: "s".repeat(32) });
  const sessions = { issue: id => (gate.hung ? new Promise(() => {}) : real.issue(id)), verify: t => real.verify(t) };
  const reg = memoryRegistry();
  const r = httpRoutes({ registry: reg, sessions, tenancy: makeTenancy({ registry: reg }), oidc, config, timers: vt, log: { warn() {} } });
  await reg.createTenant({ domain: "acme.com", admins: ["google:1001"] });
  const start = await r(new Request(ORIGIN + "/auth/login"));
  const loc = new URL(start.headers.get("location"));
  idp.codes.set("g1", await idp.mint({ sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann", nonce: loc.searchParams.get("nonce") }));
  const cb = await r(new Request(ORIGIN + "/auth/callback?" + new URLSearchParams({ code: "g1", state: loc.searchParams.get("state") }), { headers: { cookie: start.headers.getSetCookie().find(c => c.startsWith(LOGIN_COOKIE)).split(";")[0] } }));
  const code = new URLSearchParams(new URL(cb.headers.get("location")).hash.slice(1)).get("code");
  const cookie = cb.headers.getSetCookie().find(c => c.startsWith(EXCHANGE_COOKIE)).split(";")[0];
  gate.hung = true;
  await expect503AtDeadline(r(new Request(ORIGIN + "/auth/exchange", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie }, body: JSON.stringify({ code }) })));
});

test("GET /auth/callback: a slow IdP (valid state, hanging finish) answers 503 at the deadline", async () => {
  const start = await routes(new Request(ORIGIN + "/auth/login"));
  const loc = new URL(start.headers.get("location"));
  idp.codes.set("g1", await idp.mint({ sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann", nonce: loc.searchParams.get("nonce") }));
  const login = start.headers.getSetCookie().find(c => c.startsWith(LOGIN_COOKIE)).split(";")[0];
  gate.idp = true;
  await expect503AtDeadline(routes(new Request(ORIGIN + "/auth/callback?" + new URLSearchParams({ code: "g1", state: loc.searchParams.get("state") }), { headers: { cookie: login } })));
});

test("a late write lands after the 503: its board exists, and a retry with the same key returns that board (no duplicate)", async () => {
  let unhandled = 0; const on = () => { unhandled++; }; process.on("unhandledRejection", on);
  try {
    gate.hung = true;
    const mk = () => new Request(ORIGIN + "/boards", { method: "POST", headers: { ...json(), "idempotency-key": "retry-key-0001" }, body: JSON.stringify({ title: "late" }) });
    await expect503AtDeadline(routes(mk()));
    gate.release(); await flush(); await flush(); await flush();
    const found = await mem.searchBoards(acme.id, { q: "late" });
    expect(found.ids).toHaveLength(1);   // the late create happened
    const retry = await routes(mk());
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect((await retry.json()).board.id).toBe(found.ids[0]);
    expect((await mem.searchBoards(acme.id, { q: "late" })).ids).toHaveLength(1);   // still one
    expect(unhandled).toBe(0);
  } finally { process.off("unhandledRejection", on); }
});

test("a late result and a late rejection are handled (no unhandledRejection), counted and logged; stats count deadline hits per route", async () => {
  let unhandled = 0; const on = () => { unhandled++; }; process.on("unhandledRejection", on);
  const lines = [], pend = [];
  const home = { home: () => new Promise((res, rej) => pend.push({ res, rej })) };
  const r = httpRoutes({ registry: mem, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry: mem }), home,
    dev: devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" } } }), config, timers: vt, log: { warn: m => lines.push(m) } });
  try {
    const a = r(new Request(ORIGIN + "/home", { headers: as("ada") })), b = r(new Request(ORIGIN + "/home", { headers: as("ada") }));
    await flush(); vt.advance(DEADLINE);
    expect([(await a).status, (await b).status]).toEqual([503, 503]);
    expect(r.stats()).toMatchObject({ deadlineMs: DEADLINE, deadline: { "GET /home": 2 }, late: { applied: 0, failed: 0 } });
    pend[0].res({ guest: false }); pend[1].rej(new Error("db down"));
    await flush(); await flush();
    expect(r.stats().late).toEqual({ applied: 1, failed: 1 });
    expect(lines.filter(l => /request deadline/.test(l))).toHaveLength(1);        // at most one line per 10 s
    expect(lines.filter(l => /finished after its 503/.test(l))).toHaveLength(1);
    expect(unhandled).toBe(0);
  } finally { process.off("unhandledRejection", on); }
});

test("a route that answers in time clears its timer and is untouched by the deadline", async () => {
  const res = await routes(new Request(ORIGIN + "/home", { headers: as("ada") }));
  expect(res.status).toBe(200);
  expect(vt.pending()).toBe(0);
  vt.advance(DEADLINE * 2);   // nothing fires late
});

test("config.requestDeadlineMs is validated and honoured", async () => {
  const mk = ms => httpRoutes({ registry, sessions: {}, tenancy: makeTenancy({ registry }), config: { ...config, requestDeadlineMs: ms }, timers: vt });
  for (const bad of [0, -1, 1.5, "8000", NaN]) expect(() => mk(bad)).toThrow(/requestDeadlineMs/);
  const dev = devAuth({ enabled: true, tokens: { ada: { name: "ada", domain: "acme.com", email: "ada@acme.com" } } });
  const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry }), config: { ...config, requestDeadlineMs: 50 }, dev, timers: vt, log: { warn() {} } });
  gate.hung = true;
  let res = null; r(new Request(ORIGIN + "/spaces?can=board.create", { headers: as("ada") })).then(x => { res = x; });
  await flush(); vt.advance(49); await flush(); expect(res).toBeNull();
  vt.advance(1); await flush(); expect(res?.status).toBe(503);
});
