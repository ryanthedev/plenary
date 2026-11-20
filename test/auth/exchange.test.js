// Sign-in code exchange (brief p5-code): the callback puts a one-time code in the
// URL fragment and an HttpOnly exchange cookie in the browser; POST /auth/exchange turns the pair into the session
// token. No long-lived token in any URL.
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { httpRoutes, LOGIN_COOKIE, EXCHANGE_COOKIE } from "../../server/auth/http.js";
import { googleOidc } from "../../server/auth/oidc.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { createLink } from "../../server/admin/boards.js";
import { createBoard } from "./fixtures.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

const ORIGIN = "https://app.plenary.test";
const APP = ORIGIN + "/";
const config = { cookieKey: "k".repeat(32), postLoginUrl: APP, boardUrl: ORIGIN + "/b/{board}" };
const ADMIN = { sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann" };
const GUEST = { sub: "2001", email: "carol@gmail.com", hd: undefined, name: "Carol" };

const clock = { t: 0 };
const now = () => clock.t;
let idp, registry, sessions, oidc, tenancy, routes;
const failIssue = { on: false };

beforeAll(async () => { idp = await fakeIdp({ now }); await idp.addKey("k1"); });

/** A node: its own httpRoutes (own used-sets), sharing config, keys and the Registry with the others. */
const node = (over = {}) => httpRoutes({ registry, sessions: flaky, oidc, tenancy, now, config, ...over });
const flaky = {
  issue: id => (failIssue.on ? Promise.reject(new Error("down")) : sessions.issue(id)),
  verify: t => sessions.verify(t),
};
beforeEach(async () => {
  clock.t = Date.UTC(2026, 10, 11, 12);
  failIssue.on = false;
  registry = memoryRegistry({ now });
  sessions = await makeSessions({ key: "s".repeat(32), now });
  oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: ORIGIN + "/auth/callback", fetch: idp.fetch, now });
  tenancy = makeTenancy({ registry, now });
  await registry.createTenant({ domain: "acme.com", admins: ["google:1001"] });
  routes = node();
});

const setCookie = (res, name) => res.headers.getSetCookie().find(s => s.startsWith(name + "="));
const cookieOf = (res, name) => setCookie(res, name)?.split(";")[0] ?? null;
const frag = res => new URLSearchParams(new URL(res.headers.get("location")).hash.slice(1));
const cleared = res => (setCookie(res, EXCHANGE_COOKIE) ?? "").startsWith(EXCHANGE_COOKIE + "=;") && setCookie(res, EXCHANGE_COOKIE).includes("Max-Age=0");

/** Login + callback on `via`. Returns { res, code, cookie } (cookie = the exchange cookie, "name=value"). */
async function signIn(who, { startPath = "/auth/login", via = routes } = {}) {
  const start = await via(new Request(ORIGIN + startPath));
  const loc = new URL(start.headers.get("location"));
  const g = "g-" + Math.random().toString(36).slice(2);
  idp.codes.set(g, await idp.mint({ ...who, nonce: loc.searchParams.get("nonce") }));
  const q = new URLSearchParams({ code: g, state: loc.searchParams.get("state") });
  const res = await via(new Request(ORIGIN + "/auth/callback?" + q, { headers: { cookie: cookieOf(start, LOGIN_COOKIE) } }));
  expect(res.status).toBe(302);
  return { res, code: frag(res).get("code"), cookie: cookieOf(res, EXCHANGE_COOKIE) };
}
const exchange = (code, { cookie, origin = ORIGIN, via = routes, contentType = "application/json", body, method = "POST" } = {}) =>
  via(new Request(ORIGIN + "/auth/exchange", {
    method,
    headers: { ...(contentType ? { "content-type": contentType } : {}), ...(origin != null ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : body ?? JSON.stringify({ code }),
  }));
async function invalidCode(res) {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid-code" });
  expect(cleared(res)).toBe(true);
}

// ---------------------------------------------------------------------------------------------------------------

test("happy path: callback → #code + exchange cookie → POST /auth/exchange → a session token that verifies", async () => {
  const { res, code, cookie } = await signIn(ADMIN);
  const set = setCookie(res, EXCHANGE_COOKIE);
  for (const a of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=60"]) expect(set).toContain(a);
  expect(set).not.toContain("Domain");
  expect(res.headers.getSetCookie().some(c => c.startsWith(LOGIN_COOKIE + "=;") && c.includes("Max-Age=0"))).toBe(true);

  const ex = await exchange(code, { cookie });
  expect(ex.status).toBe(200);
  expect(ex.headers.get("cache-control")).toBe("no-store");
  expect(cleared(ex)).toBe(true);
  const body = await ex.json();
  expect(Object.keys(body).sort()).toEqual(["domain", "email", "exp", "name", "token", "user"]);
  expect(body).toMatchObject({ user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
  expect(body.exp).toBe(Math.floor(clock.t / 1000) + 12 * 3600);
  expect(await sessions.verify(body.token)).toMatchObject({ user: "google:1001", email: "ann@acme.com", domain: "acme.com" });
});

test("the callback's Location never holds the session token nor the identity: only an opaque code", async () => {
  for (const startPath of ["/auth/login", "/links/not-a-link"]) {
    const { res, code, cookie } = await signIn(ADMIN, { startPath });
    const loc = res.headers.get("location");
    expect(new URL(loc).search).toBe("");
    expect([...frag(res).keys()].filter(k => k !== "link")).toEqual(["code"]);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);                       // 32 random bytes
    const rest = loc.replace(code, "<code>");   // the random code itself could contain "Ann" or "1001" by chance
    for (const leak of ["s1.", "token", "ann@acme.com", "1001", "acme.com/", "Ann"]) expect(rest).not.toContain(leak);
    expect(await sessions.verify(code)).toBe(null);
    const tok = (await (await exchange(code, { cookie })).json()).token;
    expect(loc).not.toContain(tok);
    expect(loc).not.toContain(tok.split(".")[1]);
  }
});

test("a replayed code is refused (same node), with or without the cookie still present", async () => {
  const { code, cookie } = await signIn(ADMIN);
  expect((await exchange(code, { cookie })).status).toBe(200);
  await invalidCode(await exchange(code, { cookie }));   // a client that kept the cookie: the per-node used-set
  await invalidCode(await exchange(code));               // a browser that obeyed the clear
});

test("an expired code is refused (61 s); at 59 s it still works", async () => {
  const a = await signIn(ADMIN);
  clock.t += 61_000;
  await invalidCode(await exchange(a.code, { cookie: a.cookie }));
  const b = await signIn(ADMIN);
  clock.t += 59_000;
  expect((await exchange(b.code, { cookie: b.cookie })).status).toBe(200);
});

test("wrong Origin is refused 403 (missing, another origin, null, the API origin's sibling) and spends nothing", async () => {
  const { code, cookie } = await signIn(ADMIN);
  for (const origin of [null, "https://evil.example", "null", "https://plenary.test", ORIGIN + ":444", "http://app.plenary.test"]) {
    const r = await exchange(code, { cookie, origin });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "bad-origin" });
    expect(setCookie(r, EXCHANGE_COOKIE)).toBe(undefined);   // the cookie is not cleared
  }
  expect((await exchange(code, { cookie })).status).toBe(200);
});

test("a code without its cookie, with another login's cookie, tampered, or malformed is refused with one error", async () => {
  const a = await signIn(ADMIN);
  const b = await signIn(GUEST);
  await invalidCode(await exchange(a.code));                                  // no cookie
  await invalidCode(await exchange(a.code, { cookie: b.cookie }));            // another login's cookie
  await invalidCode(await exchange(b.code, { cookie: a.cookie }));            // and the other way round
  const flip = s => s.slice(0, 10) + (s[10] === "A" ? "B" : "A") + s.slice(11);
  await invalidCode(await exchange(flip(a.code), { cookie: a.cookie }));      // tampered code
  for (const bad of ["", "x", a.code + "A", a.code.slice(1), 42, null, ["x"]])
    await invalidCode(await exchange(bad, { cookie: a.cookie, body: JSON.stringify({ code: bad }) }));
  // Tampered cookie: the payload re-signed by nobody (another user, a later exp) keeps the old MAC.
  const [name, v] = [a.cookie.slice(0, a.cookie.indexOf("=")), a.cookie.slice(a.cookie.indexOf("=") + 1)];
  const [, p, mac] = v.split(".");
  const obj = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  const reb64 = o => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await invalidCode(await exchange(a.code, { cookie: `${name}=x1.${reb64({ ...obj, u: "google:1002" })}.${mac}` }));
  await invalidCode(await exchange(a.code, { cookie: `${name}=x1.${reb64({ ...obj, exp: obj.exp + 3600 })}.${mac}` }));
  // Other signed blobs can't stand in for the exchange cookie (domain separation by prefix).
  const tok = await sessions.issue({ user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
  await invalidCode(await exchange(a.code, { cookie: `${name}=${tok}` }));
  await invalidCode(await exchange(a.code, { cookie: `${name}=l1.${p}.${mac}` }));
  // None of that spent a's code: the real pair still works once.
  expect((await exchange(a.code, { cookie: a.cookie })).status).toBe(200);
});

test("the share-link path carries a code too, landing on the board", async () => {
  const s = await signIn(ADMIN);
  const who = await sessions.verify((await (await exchange(s.code, { cookie: s.cookie })).json()).token);
  const t = await tenancy.tenantOf(who);
  const board = await createBoard({ caller: who, tenant: t.id, title: "x" }, { registry, now });
  const link = await createLink({ caller: who, board: board.id, role: "viewer", expiresAt: null }, { registry, tenancy, now });
  const g = await signIn(GUEST, { startPath: `/links/${link.id}` });
  expect(g.res.headers.get("location").startsWith(`${ORIGIN}/b/${board.id}#code=`)).toBe(true);
  const ex = await exchange(g.code, { cookie: g.cookie });
  expect(ex.status).toBe(200);
  const body = await ex.json();
  expect(body.user).toBe("google:2001");
  expect(await tenancy.role(await sessions.verify(body.token), board.id)).toBe("viewer");
});

test("across nodes: a second node (fresh httpRoutes, same config and keys) exchanges a code minted by the first", async () => {
  const other = node();
  const { code, cookie } = await signIn(ADMIN);
  const ex = await exchange(code, { cookie, via: other });
  expect(ex.status).toBe(200);
  expect(cleared(ex)).toBe(true);
  expect(await sessions.verify((await ex.json()).token)).toMatchObject({ user: "google:1001" });
  // Same node again: refused by that node's used-set.
  await invalidCode(await exchange(code, { cookie, via: other }));
  // Documented limit (see http.js header): single use ACROSS nodes rests on the browser dropping the cleared
  // cookie. Someone who kept both the code and the HttpOnly cookie can replay once on another node within 60 s.
  expect((await exchange(code, { cookie, via: routes })).status).toBe(200);
  // A node with another cookie key can't open it.
  const foreign = node({ config: { ...config, cookieKey: "z".repeat(32) } });
  const s = await signIn(ADMIN);
  await invalidCode(await exchange(s.code, { cookie: s.cookie, via: foreign }));
});

test("bodies and methods: wrong content type 415, bad JSON or unknown field 400, GET 405", async () => {
  const { code, cookie } = await signIn(ADMIN);
  expect((await exchange(code, { cookie, contentType: "text/plain" })).status).toBe(415);
  expect((await exchange(code, { cookie, contentType: null })).status).toBe(415);
  expect((await exchange(code, { cookie, body: "{not json" })).status).toBe(400);
  expect((await exchange(code, { cookie, body: JSON.stringify({ code, extra: 1 }) })).status).toBe(400);
  expect((await exchange(code, { cookie, body: "[]" })).status).toBe(400);
  const g = await exchange(code, { cookie, method: "GET" });
  expect(g.status).toBe(405);
  expect(g.headers.get("allow")).toBe("POST");
  expect((await exchange(code, { cookie })).status).toBe(200);   // none of that spent the code
});

test("an outage issuing the token is 503 unavailable and does not spend the code", async () => {
  const { code, cookie } = await signIn(ADMIN);
  failIssue.on = true;
  const r = await exchange(code, { cookie });
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: "unavailable" });
  expect(setCookie(r, EXCHANGE_COOKIE)).toBe(undefined);
  failIssue.on = false;
  expect((await exchange(code, { cookie })).status).toBe(200);
});

test("no oidc configured: /auth/exchange answers 503 sign-in-unavailable", async () => {
  const r = await exchange("x".repeat(43), { via: node({ oidc: null }) });
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: "sign-in-unavailable" });
});

test("200 body types (contract): user non-empty string; name, email, domain string or null; exp integer seconds", async () => {
  const types = b => {
    expect(typeof b.token).toBe("string");
    expect(typeof b.user === "string" && b.user.length > 0).toBe(true);
    for (const k of ["name", "email", "domain"]) expect(b[k] === null || (typeof b[k] === "string" && b[k] !== "")).toBe(true);
    expect(Number.isInteger(b.exp)).toBe(true);
  };
  // A Workspace user: all strings.
  let s = await signIn(ADMIN);
  let b = await (await exchange(s.code, { cookie: s.cookie })).json();
  types(b);
  expect(b).toMatchObject({ name: "Ann", email: "ann@acme.com", domain: "acme.com" });
  // A consumer account with an empty name: domain null, name normalised to null (body and token agree).
  s = await signIn({ ...GUEST, name: "" });
  b = await (await exchange(s.code, { cookie: s.cookie })).json();
  types(b);
  expect(b).toMatchObject({ user: "google:2001", name: null, domain: null });
  expect(await sessions.verify(b.token)).toMatchObject({ name: null, domain: null });
  // No name at all.
  s = await signIn({ ...GUEST, name: undefined });
  b = await (await exchange(s.code, { cookie: s.cookie })).json();
  types(b);
  expect(b.name).toBe(null);
});

test("a sessions adapter whose token carries no integer exp: 503, the code not spent (the contract can't be met)", async () => {
  const odd = node({ sessions: { issue: async () => "opaque-token", verify: async () => null } });
  const { code, cookie } = await signIn(ADMIN);
  const r = await exchange(code, { cookie, via: odd });
  expect(r.status).toBe(503);
  expect((await exchange(code, { cookie })).status).toBe(200);
});

test("exp comes from the sessions adapter's verify(), not the token's format; no integer exp or a throw: 503, code not spent", async () => {
  // An opaque token (no s1. format to decode): the 200 carries whatever exp verify() gives.
  const fixed = node({ sessions: { issue: async () => "opaque-token", verify: async t => (t === "opaque-token" ? { user: "x:1", name: null, email: null, domain: null, exp: 4102444800 } : null) } });
  let s = await signIn(ADMIN);
  const r = await exchange(s.code, { cookie: s.cookie, via: fixed });
  expect(r.status).toBe(200);
  const b = await r.json();
  expect(b.exp).toBe(4102444800);
  expect(b.token).toBe("opaque-token");
  expect(Object.keys(b).sort()).toEqual(["domain", "email", "exp", "name", "token", "user"]);
  for (const verify of [async () => { throw new Error("down"); }, async () => ({ user: "x:1", name: null, email: null, domain: null }),
    async () => ({ user: "x:1", name: null, email: null, domain: null, exp: 4102444800.5 }), async () => ({ user: "x:1", exp: "4102444800" })]) {
    s = await signIn(ADMIN);
    expect((await exchange(s.code, { cookie: s.cookie, via: node({ sessions: { issue: async () => "opaque-token", verify } }) })).status).toBe(503);
    expect((await exchange(s.code, { cookie: s.cookie })).status).toBe(200);
  }
});

test("a Unit member's sign-in is recorded in the member directory (best effort); a guest's is not", async () => {
  const unit = (await registry.tenantByDomain("acme.com"));
  const a = await signIn(ADMIN);
  expect((await exchange(a.code, { cookie: a.cookie })).status).toBe(200);
  await new Promise(r => setTimeout(r, 0));
  expect(await registry.membersAmong(unit.id, ["google:1001"])).toEqual([{ user: "google:1001", name: "Ann", email: "ann@acme.com", removed: false }]);
  const g = await signIn(GUEST);
  expect((await exchange(g.code, { cookie: g.cookie })).status).toBe(200);
  await new Promise(r => setTimeout(r, 0));
  expect(await registry.membersAmong(unit.id, ["google:2001"])).toEqual([]);
  // a Registry that cannot record never fails the sign-in
  const broken = new Proxy(registry, { get: (t, k) => (k === "touchMember" ? async () => { throw new Error("down"); } : t[k]) });
  const via = node({ registry: broken });
  const b = await signIn({ ...ADMIN, sub: "1002", email: "bo@acme.com" }, { via });
  expect((await exchange(b.code, { cookie: b.cookie, via })).status).toBe(200);
});

test("the directory write after sign-in is bounded: 16 in flight, one per user, the rest dropped; failures log one rate-limited line", async () => {
  const unit = await registry.tenantByDomain("acme.com");
  let calls = 0, release; const gate = new Promise(r => { release = r; });
  const slow = new Proxy(registry, { get: (t, k) => (k === "touchMember" ? async (...a) => { calls++; await gate; return t.touchMember(...a); } : t[k]) });
  const via = node({ registry: slow });
  const signed = [];
  for (let i = 0; i < 20; i++) {
    const s = await signIn({ ...ADMIN, sub: `30${String(i).padStart(2, "0")}`, email: `u${i}@acme.com` }, { via });
    expect((await exchange(s.code, { cookie: s.cookie, via })).status).toBe(200);
    signed.push(`google:30${String(i).padStart(2, "0")}`);
  }
  await new Promise(r => setTimeout(r, 0));
  expect(calls).toBe(16);                                       // the other four were dropped, not queued
  release(); await new Promise(r => setTimeout(r, 5));
  expect((await registry.membersAmong(unit.id, signed)).length).toBe(16);
  // one in flight per user: a second sign-in of the same person while the first write runs adds none
  let again = 0, release2; const gate2 = new Promise(r => { release2 = r; });
  const once = new Proxy(registry, { get: (t, k) => (k === "touchMember" ? async () => { again++; await gate2; } : t[k]) });
  const v2 = node({ registry: once });
  for (let i = 0; i < 3; i++) { const s = await signIn(ADMIN, { via: v2 }); await exchange(s.code, { cookie: s.cookie, via: v2 }); }
  await new Promise(r => setTimeout(r, 0));
  expect(again).toBe(1);
  release2();
  // failures: one warn per minute, with nothing identifying in it
  const warns = [];
  const down = new Proxy(registry, { get: (t, k) => (k === "touchMember" ? async () => { throw new Error("secret-detail google:1001"); } : t[k]) });
  const v3 = node({ registry: down, log: { warn: (m, f) => warns.push([m, f]) } });
  for (let i = 0; i < 3; i++) { const s = await signIn({ ...ADMIN, sub: `40${i}`, email: `d${i}@acme.com` }, { via: v3 }); await exchange(s.code, { cookie: s.cookie, via: v3 }); await new Promise(r => setTimeout(r, 0)); }
  expect(warns).toHaveLength(1);
  expect(JSON.stringify(warns)).not.toMatch(/secret-detail|google:|acme/);
  clock.t += 61_000;
  const s = await signIn({ ...ADMIN, sub: "409", email: "d9@acme.com" }, { via: v3 }); await exchange(s.code, { cookie: s.cookie, via: v3 }); await new Promise(r => setTimeout(r, 0));
  expect(warns).toHaveLength(2);
});

test("a hung directory write keeps its slot past the cutoff (it only logs); the slot frees when the write settles; drops are logged anonymously", async () => {
  let release; const gate = new Promise(r => { release = r; });
  const hang = new Proxy(registry, { get: (t, k) => (k === "touchMember" ? async () => { await gate; } : t[k]) });
  const warns = [];
  const q = new Map(); let tid = 0, vnow = 0;   // virtual timers: the cutoff never depends on how fast this machine runs the 17 sign-ins
  const timers = { set: (fn, ms) => { q.set(++tid, { fn, at: vnow + ms }); return tid; }, clear: h => { q.delete(h); } };
  const advance = ms => { vnow += ms; for (const [h, e] of [...q]) if (e.at <= vnow) { q.delete(h); e.fn(); } };
  const via = node({ registry: hang, timers, log: { warn: (m, f) => warns.push([m, f]) }, config: { ...config, touchTimeoutMs: 30 } });
  const signAs = async n => { const s = await signIn({ ...ADMIN, sub: `50${String(n).padStart(2, "0")}`, email: `h${n}@acme.com` }, { via }); expect((await exchange(s.code, { cookie: s.cookie, via })).status).toBe(200); };
  for (let i = 0; i < 17; i++) await signAs(i);
  await new Promise(r => setTimeout(r, 0));
  expect(warns.map(w => w[0])).toEqual(["member directory write dropped (too many in flight); Home records the person later"]);
  clock.t += 61_000;                                            // the rate limit's window passes
  advance(30);                                                  // past the cutoff: still hung, still holding its slot; the timeout only logs "slow"
  expect(warns.map(w => w[0]).at(-1)).toContain("slow");
  warns.length = 0;
  clock.t += 61_000;
  await signAs(98);                                             // dropped: the 16 slots are still taken
  await new Promise(r => setTimeout(r, 0));
  expect(warns).toHaveLength(1);
  expect(warns[0][0]).toContain("dropped");
  release(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));   // the writes settle (microtasks): slots free
  clock.t += 61_000;
  warns.length = 0;
  await signAs(99); await new Promise(r => setTimeout(r, 0));
  expect(warns).toHaveLength(0);                                // accepted, not dropped
  expect(JSON.stringify(warns)).not.toMatch(/google:|acme/);
});
