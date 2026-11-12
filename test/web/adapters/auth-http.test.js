// The HTTP auth adapter (web/adapters/auth/http.js): the auth contract over a fake fetch that plays the server of
// docs/m2/contracts/auth-exchange.md, its own mapping rules, and one run against platform's real route in-process
// (server/auth/http.js, set up as test/auth/exchange.test.js does).
import { describe, test, expect, beforeAll } from "bun:test";
import { authContract } from "../contracts/auth-contract.js";
import { httpAuth } from "../../../web/adapters/auth/http.js";
import { virtualClock } from "../../../web/adapters/clock/virtual.js";
import { httpRoutes, EXCHANGE_COOKIE, LOGIN_COOKIE } from "../../../server/auth/http.js";
import { googleOidc } from "../../../server/auth/oidc.js";
import { sessions as makeSessions } from "../../../server/auth/session.js";
import { memoryRegistry } from "../../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../../server/auth/tenancy.js";
import { fakeIdp, CLIENT_ID } from "../../auth/fake-idp.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fake same-origin server for POST /auth/exchange: single-use codes, and a forced failure. Answers 404 to a
 * request of the wrong shape, so the contract's happy path fails if the adapter sends anything else.
 */
function fakeServer() {
  const codes = new Map();
  let n = 0, fail = null;
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push({ url, init });
    if (fail === "network") throw new TypeError("Failed to fetch");
    const ok = url === "/auth/exchange" && init.method === "POST" && init.credentials === "same-origin" &&
      init.headers?.["Content-Type"] === "application/json";
    if (!ok) return json(404, { error: "not-found" });
    if (fail === "bad-origin") return json(403, { error: "bad-origin" });
    if (fail === "unavailable") return json(503, { error: "unavailable" });
    let code;
    try { ({ code } = JSON.parse(init.body)); } catch { return json(400, { error: "invalid-code" }); }
    if (fail === "malformed") return json(200, { ok: true });
    const s = codes.get(code);
    codes.delete(code);
    if (!s) return json(400, { error: "invalid-code" });
    return json(200, s);
  }
  return {
    fetch, calls,
    mint({ token = `s1.h${++n}.${"A".repeat(43)}`, user = "google:ann", name = "Ann", email = "ann@acme.com",
      domain = "acme.com", exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
      const code = "c" + String(++n).padStart(42, "0");
      codes.set(code, { token, user, name, email, domain, exp });
      return code;
    },
    force(k) { fail = k; },
  };
}

authContract("http (fake fetch)", () => {
  const s = fakeServer();
  return { auth: httpAuth({ fetch: s.fetch }), mint: async f => s.mint(f), force: k => s.force(k) };
});

describe("http auth adapter", () => {
  test("posts {code} as JSON to the relative /auth/exchange, same-origin credentials; the code is never in the URL", async () => {
    const s = fakeServer(), code = s.mint();
    await httpAuth({ fetch: s.fetch }).exchange(code);
    expect(s.calls.length).toBe(1);
    const { url, init } = s.calls[0];
    expect(url).toBe("/auth/exchange");
    expect(url).not.toContain(code);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ code });
    expect(init.redirect).toBe("error");                // p6-edgev LOW-3: a redirect never carries the code on
  });

  test("base is a prefix of the path", async () => {
    const seen = [];
    await httpAuth({ fetch: async u => { seen.push(u); return json(400, { error: "invalid-code" }); }, base: "https://app.test" }).exchange("x");
    expect(seen).toEqual(["https://app.test/auth/exchange"]);
  });

  test("a code that is not a non-empty string makes no request", async () => {
    const s = fakeServer(), a = httpAuth({ fetch: s.fetch });
    for (const c of ["", null, undefined, 7]) expect(await a.exchange(/** @type {any} */ (c))).toEqual({ error: "invalid-code" });
    expect(s.calls.length).toBe(0);
  });

  const answer = r => httpAuth({ fetch: async () => r }).exchange("c");
  test("a JSON 400 is invalid-code and a JSON 403 bad-origin, whatever the JSON says", async () => {
    expect(await answer(json(400, { error: "bad-request" }))).toEqual({ error: "invalid-code" });
    expect(await answer(json(403, { error: "something" }))).toEqual({ error: "bad-origin" });
  });
  test("a 400 or 403 that is not JSON (a proxy or WAF page) is network: retryable, never final", async () => {
    expect(await answer(new Response("<html>Bad Request</html>", { status: 400 }))).toEqual({ error: "network" });
    expect(await answer(new Response("Forbidden", { status: 403 }))).toEqual({ error: "network" });
  });
  test("503 with the route's sign-in-unavailable body, other 5xx and unknown statuses are unavailable (retryable)", async () => {
    for (const r of [json(503, { error: "sign-in-unavailable" }), new Response("<html>bad gateway</html>", { status: 502 }),
      new Response("", { status: 504 }), json(404, {}), json(401, {}), json(500, {})])
      expect(await answer(r)).toEqual({ error: "unavailable" });
  });
  test("a 200 whose body is not JSON is network (not our server); JSON of the wrong shape is unavailable", async () => {
    expect(await answer(new Response("<html>captive portal</html>", { status: 200 }))).toEqual({ error: "network" });
    const good = { token: "s1.a.b", user: "google:1", name: null, email: null, domain: null, exp: 1_900_000_000 };
    for (const bad of [null, [], { ...good, exp: "1900000000" }, { ...good, exp: 1.5 }, { ...good, token: "" }, { ...good, user: 3 },
      { ...good, name: 5 }, { ...good, extra: 1 }, (({ domain, ...r }) => r)(good)])
      expect(await answer(json(200, bad))).toEqual({ error: "unavailable" });
    expect(await answer(json(200, good))).toEqual(good);
  });
  test("a fetch that throws (offline, DNS) is network; so is a rejected body read", async () => {
    expect(await httpAuth({ fetch: async () => { throw new TypeError("Failed to fetch"); } }).exchange("c")).toEqual({ error: "network" });
    expect(await httpAuth({ fetch: () => { throw new Error("sync throw"); } }).exchange("c")).toEqual({ error: "network" });
    expect(await answer({ status: 200, text: () => Promise.reject(new Error("reset")) })).toEqual({ error: "network" });
  });
  test("no answer within timeoutMs is network, and the request is aborted", async () => {
    const c = virtualClock();
    let signal;
    const a = httpAuth({ fetch: (_u, init) => { signal = init.signal; return new Promise(() => {}); }, timeoutMs: 10_000, timers: c });
    const p = a.exchange("c");
    let r = null;
    p.then(v => { r = v; });
    await Promise.resolve();
    c.advance(9_999);
    await Promise.resolve();
    expect(r).toBe(null);
    c.advance(1);
    expect(await p).toEqual({ error: "network" });
    expect(signal.aborted).toBe(true);
    expect(c.pending).toBe(0);
  });
  test("an answer in time clears the timer", async () => {
    const c = virtualClock();
    await httpAuth({ fetch: async () => json(400, {}), timers: c }).exchange("c");
    expect(c.pending).toBe(0);
  });
});

// ── against platform's real route (server/auth/http.js), in-process ─────────────────────────────────────────────
describe("http auth adapter against the real /auth/exchange route", () => {
  const ORIGIN = "https://app.plenary.test";
  let idp, routes, sessions;
  beforeAll(async () => {
    const now = () => Date.now();
    idp = await fakeIdp({ now });
    await idp.addKey("k1");
    const registry = memoryRegistry({ now });
    sessions = await makeSessions({ key: "s".repeat(32), now });
    const oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: ORIGIN + "/auth/callback", fetch: idp.fetch, now });
    const tenancy = makeTenancy({ registry, now });
    await registry.createTenant({ domain: "acme.com", admins: ["google:1001"] });
    routes = httpRoutes({ registry, sessions, oidc, tenancy, now, config: { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}" } });
  });
  const call = req => routes(req, new URL(req.url));
  const cookieOf = (res, name) => res.headers.getSetCookie().find(s => s.startsWith(name + "="))?.split(";")[0] ?? null;

  /** Google sign-in through the real callback: returns the #code and the browser's cookie jar. */
  async function signIn(who) {
    const start = await call(new Request(ORIGIN + "/auth/login"));
    const loc = new URL(start.headers.get("location"));
    const g = "g-" + Math.random().toString(36).slice(2);
    idp.codes.set(g, await idp.mint({ ...who, nonce: loc.searchParams.get("nonce") }));
    const q = new URLSearchParams({ code: g, state: loc.searchParams.get("state") });
    const res = await call(new Request(ORIGIN + "/auth/callback?" + q, { headers: { cookie: cookieOf(start, LOGIN_COOKIE) } }));
    expect(res.status).toBe(302);
    const code = new URLSearchParams(new URL(res.headers.get("location")).hash.slice(1)).get("code");
    return { code, jar: { cookie: cookieOf(res, EXCHANGE_COOKIE) } };
  }
  /** What a same-origin browser fetch does: resolve the relative URL, send Origin and the cookie jar, keep Set-Cookie. */
  const browserFetch = (jar, origin = ORIGIN) => async (url, init) => {
    const req = new Request(new URL(url, ORIGIN), { ...init, headers: { ...init.headers, origin, ...(jar.cookie ? { cookie: jar.cookie } : {}) } });
    const res = await call(req);
    const set = res.headers.getSetCookie().find(s => s.startsWith(EXCHANGE_COOKIE + "="));
    if (set) jar.cookie = /Max-Age=0/.test(set) ? null : set.split(";")[0];
    return res;
  };

  test("a real code gives a session whose token verifies; the same code again is invalid-code", async () => {
    const { code, jar } = await signIn({ sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann" });
    const a = httpAuth({ fetch: browserFetch(jar) });
    const r = await a.exchange(code);
    expect(r).toMatchObject({ user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
    expect(Number.isInteger(r.exp) && r.exp < 1e11 && r.exp > Date.now() / 1000).toBe(true);
    expect(await sessions.verify(r.token)).toBeTruthy();
    expect(await a.exchange(code)).toEqual({ error: "invalid-code" });
  });
  test("a consumer account comes back with domain null", async () => {
    const { code, jar } = await signIn({ sub: "2001", email: "carol@gmail.com", hd: undefined, name: "Carol" });
    expect(await httpAuth({ fetch: browserFetch(jar) }).exchange(code)).toMatchObject({ user: "google:2001", domain: null });
  });
  test("another origin is bad-origin, and the code is not spent by it", async () => {
    const { code, jar } = await signIn({ sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann" });
    expect(await httpAuth({ fetch: browserFetch(jar, "https://evil.test") }).exchange(code)).toEqual({ error: "bad-origin" });
    expect("token" in await httpAuth({ fetch: browserFetch(jar) }).exchange(code)).toBe(true);
  });
  test("a code without its browser's cookie is invalid-code", async () => {
    const { code } = await signIn({ sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann" });
    expect(await httpAuth({ fetch: browserFetch({ cookie: null }) }).exchange(code)).toEqual({ error: "invalid-code" });
  });
});
