// End to end through server/auth/http.js against the fake IdP (no network): sign-in, the admin API, share links.
import { test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { httpRoutes, LOGIN_COOKIE, EXCHANGE_COOKIE } from "../../server/auth/http.js";
import { googleOidc } from "../../server/auth/oidc.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { createBoard } from "./fixtures.js";
import { devAuth } from "../../server/auth/dev.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

const ORIGIN = "https://plenary.test";
const APP = "https://plenary.test/";   // one origin with the callback: a deployment that can sign in
const config = {
  cookieKey: "k".repeat(32),
  postLoginUrl: APP,
  postLogoutUrl: "https://plenary.test/bye",
  boardUrl: "https://plenary.test/b/{board}",
  publicUrl: ORIGIN,
};

const clock = { t: Date.UTC(2026, 10, 11, 12) };
const now = () => clock.t;
let idp, registry, sessions, oidc, tenancy, routes, acme;

const ADMIN = { sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann" };
const MEMBER = { sub: "1002", email: "max@acme.com", hd: "acme.com", name: "Max" };
const GUEST = { sub: "2001", email: "carol@gmail.com", hd: undefined, name: "Carol" };
const INVITEE = { sub: "3001", email: "bob@globex.com", hd: "globex.com", name: "Bob" };

beforeAll(async () => { idp = await fakeIdp({ now }); await idp.addKey("k1"); });

function build(over = {}) {
  return httpRoutes({ registry, sessions, oidc, tenancy, now, config, ...over });
}
beforeEach(async () => {
  clock.t = Date.UTC(2026, 10, 11, 12);
  registry = memoryRegistry({ now });
  sessions = await makeSessions({ key: "s".repeat(32), now });
  oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: ORIGIN + "/auth/callback", fetch: idp.fetch, now });
  tenancy = makeTenancy({ registry, now });
  acme = await registry.createTenant({ domain: "acme.com", admins: ["google:1001"] });
  routes = build();
});

const call = (path, init = {}) => routes(new Request(ORIGIN + path, init));
const cookieOf = (res, name = LOGIN_COOKIE) => {
  const c = res.headers.getSetCookie().find(s => s.startsWith(name + "="));
  return c ? c.split(";")[0] : null;
};
const APP_ORIGIN = new URL(APP).origin;
const fragCode = loc => new URLSearchParams(new URL(loc).hash.slice(1)).get("code");
/** POST /auth/exchange as the web client would (same origin, the exchange cookie riding along). */
const exchangeCall = (code, { cookie, origin = APP_ORIGIN, via = routes, base = ORIGIN, headers = {} } = {}) =>
  via(new Request(base + "/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify({ code }),
  }));
/** The session token a callback response leads to, via the code exchange. */
async function fragToken(res) {
  const r = await exchangeCall(fragCode(res.headers.get("location")), { cookie: cookieOf(res, EXCHANGE_COOKIE) });
  expect(r.status).toBe(200);
  return (await r.json()).token;
}

/** GET /auth/login (or a /links/:id), then the callback with a fake code. Returns { res, start, cookie }. */
async function signIn(who, { startPath = "/auth/login", claims = {}, tamper } = {}) {
  const start = await call(startPath);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location"));
  const cookie = cookieOf(start);
  const code = "code-" + Math.random().toString(36).slice(2);
  idp.codes.set(code, await idp.mint({ ...who, nonce: loc.searchParams.get("nonce"), ...claims }));
  const q = new URLSearchParams({ code, state: loc.searchParams.get("state") });
  const res = await call("/auth/callback?" + q, { headers: { cookie: tamper ? tamper(cookie) : cookie } });
  return { res, start, cookie, code, state: loc.searchParams.get("state") };
}
async function tokenFor(who) {
  const { res } = await signIn(who);
  expect(res.status).toBe(302);
  return fragToken(res);
}
const api = (path, token, method = "GET", body) => call(path, {
  method,
  headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

// ---------------------------------------------------------------------------------------------------------------

test("full flow: login → token → POST /boards → invite → link → another user redeems → roles resolve", async () => {
  // Login: 302 to Google with PKCE S256, state and nonce; the cookie is __Host-, Secure, HttpOnly, Lax, ≤ 10 min.
  const start = await call("/auth/login");
  const google = new URL(start.headers.get("location"));
  expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(google.searchParams.get("code_challenge_method")).toBe("S256");
  expect(google.searchParams.get("redirect_uri")).toBe(ORIGIN + "/auth/callback");
  const set = start.headers.getSetCookie()[0];
  for (const a of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"]) expect(set).toContain(a);
  expect(set).not.toContain("Domain");

  // Callback: a one-time code in the fragment of the configured URL, never the query; login cookie cleared.
  const { res } = await signIn(ADMIN);
  const loc = res.headers.get("location");
  expect(loc.startsWith(APP + "#code=")).toBe(true);
  expect(new URL(loc).search).toBe("");
  expect(res.headers.getSetCookie().some(c => c.startsWith(LOGIN_COOKIE + "=;") && c.includes("Max-Age=0"))).toBe(true);
  const admin = await fragToken(res);
  expect(await sessions.verify(admin)).toMatchObject({ user: "google:1001", domain: "acme.com" });
  // The idp received the PKCE verifier.
  expect(idp.tokenRequests.at(-1).code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // POST /boards: tenant from the caller's identity.
  const cb = await api("/boards", admin, "POST", { title: "All hands", memberRole: "annotator" });
  expect(cb.status).toBe(201);
  const { board } = await cb.json();
  expect(board).toMatchObject({ tenant: acme.id, title: "All hands", memberRole: "annotator" });
  expect(await registry.grant(board.id, "google:1001")).toBe("owner");

  // Invite (cross-domain), list it.
  const inv = await api(`/boards/${board.id}/invites`, admin, "POST", { email: "Bob@Globex.com", role: "editor" });
  expect(inv.status).toBe(201);
  const { invite } = await inv.json();
  expect(invite).toMatchObject({ board: board.id, email: "bob@globex.com", role: "editor" });
  expect((await (await api(`/boards/${board.id}/invites`, admin)).json()).invites.map(i => i.id)).toEqual([invite.id]);

  // Share link, list it.
  const lk = await api(`/boards/${board.id}/links`, admin, "POST", { role: "annotator" });
  expect(lk.status).toBe(201);
  const { link, url } = await lk.json();
  expect(url).toBe(`${ORIGIN}/links/${link.id}`);
  expect((await (await api(`/boards/${board.id}/links`, admin)).json()).links.map(l => l.id)).toEqual([link.id]);

  // A guest (gmail, no tenant) opens the link signed out: sign-in runs, the callback redeems, lands on the board.
  const guest = await signIn(GUEST, { startPath: `/links/${link.id}` });
  const gl = guest.res.headers.get("location");
  expect(gl.startsWith(`https://plenary.test/b/${board.id}#code=`)).toBe(true);
  expect(await sessions.verify(await fragToken(guest.res))).toMatchObject({ user: "google:2001" });
  expect(await tenancy.role({ user: "google:2001", email: "carol@gmail.com", domain: null }, board.id)).toBe("annotator");

  // The invitee signs in and gets the invite's role; a member gets memberRole.
  const bob = await sessions.verify(await tokenFor(INVITEE));
  expect(await tenancy.role(bob, board.id)).toBe("editor");
  const max = await sessions.verify(await tokenFor(MEMBER));
  expect(await tenancy.role(max, board.id)).toBe("annotator");

  // Grants: the owner raises the guest to editor; then revoke invite and link.
  const g = await api(`/boards/${board.id}/grants/${encodeURIComponent("google:2001")}`, admin, "PUT", { role: "editor" });
  expect(g.status).toBe(204);
  expect(await registry.grant(board.id, "google:2001")).toBe("editor");
  expect((await api(`/boards/${board.id}/invites/${invite.id}`, admin, "DELETE")).status).toBe(204);
  expect(await tenancy.role(bob, board.id)).toBe(null);
  expect((await api(`/boards/${board.id}/links/${link.id}`, admin, "DELETE")).status).toBe(204);
  // Last owner can't be demoted.
  const lo = await api(`/boards/${board.id}/grants/${encodeURIComponent("google:1001")}`, admin, "PUT", { role: "editor" });
  expect(lo.status).toBe(409);
  expect(await lo.json()).toEqual({ error: "last-owner" });
});

test("GET /links/:id with a Bearer redeems at once; a dead link is 404", async () => {
  const admin = await tokenFor(ADMIN);
  const { board } = await (await api("/boards", admin, "POST", {})).json();
  const { link } = await (await api(`/boards/${board.id}/links`, admin, "POST", { role: "viewer" })).json();
  const guest = await tokenFor(GUEST);
  const r = await api(`/links/${link.id}`, guest);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ board: board.id, url: `https://plenary.test/b/${board.id}` });
  expect(await tenancy.role(await sessions.verify(guest), board.id)).toBe("viewer");
  expect((await api(`/links/nope`, guest)).status).toBe(404);
  await api(`/boards/${board.id}/links/${link.id}`, admin, "DELETE");
  expect((await api(`/links/${link.id}`, guest)).status).toBe(404);
});

test("a dead link at sign-in still signs in, flagged in the fragment, landing on postLoginUrl", async () => {
  const { res } = await signIn(GUEST, { startPath: "/links/not-a-link" });
  const loc = res.headers.get("location");
  expect(loc.startsWith(APP + "#code=")).toBe(true);
  expect(new URLSearchParams(new URL(loc).hash.slice(1)).get("link")).toBe("invalid");
  expect(await sessions.verify(await fragToken(res))).toMatchObject({ user: "google:2001" });
});

test("the link rides in the signed login cookie, never in a URL parameter", async () => {
  const start = await call("/links/abcdefabcdefabcdefabcdefab");
  const google = start.headers.get("location");
  expect(google).not.toContain("abcdefabcdefabcdefabcdefab");
  const v = cookieOf(start).split("=")[1];
  const payload = JSON.parse(atob(v.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  expect(payload.l).toBe("abcdefabcdefabcdefabcdefab");
});

// ---- login cookie, state, nonce ----

const loginFailed = async res => {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "login-failed" });
  expect(res.headers.getSetCookie().some(c => c.startsWith(LOGIN_COOKIE + "=;") && c.includes("Max-Age=0"))).toBe(true);
  expect(res.headers.get("location")).toBe(null);
};

test("missing, tampered, forged-prefix and expired login cookies are refused", async () => {
  await loginFailed((await signIn(ADMIN, { tamper: () => "" })).res);
  await loginFailed((await signIn(ADMIN, { tamper: c => c.slice(0, -3) + (c.at(-3) === "A" ? "B" : "A") + c.slice(-2) })).res);
  // Payload swapped (another state) with the old MAC.
  await loginFailed((await signIn(ADMIN, {
    tamper: c => {
      const [name, v] = [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)];
      const [, p, mac] = v.split(".");
      const obj = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
      obj.exp += 3600;
      const p2 = btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `${name}=l1.${p2}.${mac}`;
    },
  })).res);
  // A session token can't stand in for the login cookie.
  const tok = await tokenFor(ADMIN);
  await loginFailed((await signIn(ADMIN, { tamper: () => `${LOGIN_COOKIE}=${tok}` })).res);
  // Expired: 10 min + 1 s after the login started (the expiry is inside the signed payload).
  const start = await call("/auth/login");
  const loc = new URL(start.headers.get("location"));
  clock.t += 601_000;
  idp.codes.set("late", await idp.mint({ ...ADMIN, nonce: loc.searchParams.get("nonce") }));
  await loginFailed(await call(`/auth/callback?code=late&state=${loc.searchParams.get("state")}`, { headers: { cookie: cookieOf(start) } }));
});

test("state mismatch, missing code, and an IdP error are refused", async () => {
  const start = await call("/auth/login");
  const loc = new URL(start.headers.get("location"));
  idp.codes.set("c-state", await idp.mint({ ...ADMIN, nonce: loc.searchParams.get("nonce") }));
  const h = { headers: { cookie: cookieOf(start) } };
  await loginFailed(await call("/auth/callback?code=c-state&state=wrong", h));
  await loginFailed(await call(`/auth/callback?state=${loc.searchParams.get("state")}`, h));
  await loginFailed(await call(`/auth/callback?error=access_denied&state=${loc.searchParams.get("state")}`, h));
  // Another login's state cookie doesn't pair with this state.
  const other = await call("/auth/login");
  await loginFailed(await call(`/auth/callback?code=c-state&state=${loc.searchParams.get("state")}`, { headers: { cookie: cookieOf(other) } }));
});

test("nonce: a token minted for another login is refused; a replayed callback is refused", async () => {
  await loginFailed((await signIn(ADMIN, { claims: { nonce: "someone-elses-nonce" } })).res);
  // Replay of a good callback (same cookie, same state, same code) in this process.
  const { res, cookie, code, state } = await signIn(ADMIN);
  expect(res.status).toBe(302);
  await loginFailed(await call(`/auth/callback?${new URLSearchParams({ code, state })}`, { headers: { cookie } }));
});

test("no open redirect: the request can't choose where the browser goes", async () => {
  for (const p of ["redirect", "next", "return_to", "redirect_uri", "url"]) {
    const start = await call(`/auth/login?${p}=https://evil.example/`);
    const loc = new URL(start.headers.get("location"));
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe(ORIGIN + "/auth/callback");
    idp.codes.set("c-" + p, await idp.mint({ ...ADMIN, nonce: loc.searchParams.get("nonce") }));
    const q = new URLSearchParams({ code: "c-" + p, state: loc.searchParams.get("state"), [p]: "https://evil.example/" });
    const res = await routes(new Request(ORIGIN + "/auth/callback?" + q, { headers: { cookie: cookieOf(start), host: "evil.example" } }));
    expect(res.headers.get("location").startsWith(APP + "#code=")).toBe(true);
    const out = await call(`/auth/logout?${p}=https://evil.example/`);
    expect(out.headers.get("location")).toBe("https://plenary.test/bye");
  }
  // Config is checked: relative, non-http and fragment URLs are refused at build time.
  for (const bad of ["/relative", "javascript:alert(1)", "https://plenary.test/#x"])
    expect(() => build({ config: { ...config, postLoginUrl: bad } })).toThrow();
  expect(() => build({ config: { ...config, boardUrl: "https://plenary.test/b/" } })).toThrow();
  expect(() => build({ config: { ...config, cookieKey: "short" } })).toThrow();
  // One origin (p5-codev MEDIUM 1): any URL off postLoginUrl's origin is refused at build time with a clear error.
  for (const [k, v] of [["postLogoutUrl", "https://app.plenary.test/bye"], ["boardUrl", "https://app.plenary.test/b/{board}"],
    ["publicUrl", "https://links.plenary.test"], ["boardUrl", "http://plenary.test/b/{board}"], ["postLogoutUrl", "https://plenary.test:8443/bye"]])
    expect(() => build({ config: { ...config, [k]: v } })).toThrow(`config.${k} must be on postLoginUrl's origin`);
  expect(() => build({ config: { ...config, postLoginUrl: "https://app.plenary.test/" } })).toThrow("must be on postLoginUrl's origin");
  expect(() => build({ config: { ...config, postLogoutUrl: undefined, publicUrl: undefined } })).not.toThrow();
});

test("logout clears the login cookie and redirects; the session token stays valid until exp (stateless)", async () => {
  const tok = await tokenFor(ADMIN);
  const out = await call("/auth/logout");
  expect(out.status).toBe(302);
  expect(out.headers.getSetCookie().some(c => c.startsWith(LOGIN_COOKIE + "=;") && c.includes("Max-Age=0"))).toBe(true);
  expect(await sessions.verify(tok)).not.toBe(null);
});

// ---- bearer ----

test("Bearer missing, malformed, forged or expired → 401 auth; cookies never authenticate", async () => {
  const tok = await tokenFor(ADMIN);
  const r = await api("/boards", null, "POST", {});
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toBe("Bearer");
  expect(await r.json()).toEqual({ error: "auth" });
  for (const h of ["Basic abc", "Bearer", "Bearer  ", "bearer s1.x.y", "Bearer " + tok.slice(0, -2) + "AA", tok]) {
    const res = await call("/boards", { method: "POST", headers: { authorization: h, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  }
  const viaCookie = await call("/boards", { method: "POST", headers: { cookie: `session=${tok}; token=${tok}`, "content-type": "application/json" }, body: "{}" });
  expect(viaCookie.status).toBe(401);
  clock.t += 13 * 3600_000;                                // past the 12 h session
  expect((await api(`/boards`, tok, "POST", {})).status).toBe(401);
});

// ---- admin rules ----

test("POST /boards: tenantless callers get 403; a Unit member makes a board in their personal space; a cross-tenant tenant field is refused and creates nothing", async () => {
  let creates = 0;
  const counting = { ...registry, createBoard: async o => { creates++; return registry.createBoard(o); } };
  routes = build({ registry: counting });
  const member = await tokenFor(MEMBER), guest = await tokenFor(GUEST), admin = await tokenFor(ADMIN);
  const r0 = await api("/boards", guest, "POST", { title: "x" });
  expect(r0.status).toBe(403);
  expect(await r0.json()).toEqual({ error: "forbidden" });
  expect(creates).toBe(0);
  const mine = await api("/boards", member, "POST", { title: "x" });
  expect(mine.status).toBe(201);
  expect(creates).toBe(1);
  creates = 0;
  const other = await registry.createTenant({ domain: "globex.com", admins: ["google:1001"] });
  const r = await api("/boards", admin, "POST", { tenant: other.id });
  expect(r.status).toBe(403);
  expect(await r.json()).toEqual({ error: "forbidden" });
  const unk = await api("/boards", admin, "POST", { bogus: 1 });
  expect(unk.status).toBe(400);
  expect(await unk.json()).toEqual({ error: "unknown-field", field: "bogus" });
  expect(creates).toBe(0);
  const bad = await api("/boards", admin, "POST", { memberRole: "owner" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("bad-request");
  expect(creates).toBe(0);
});

test("an unknown board and a board the caller can't manage give byte-identical answers", async () => {
  const admin = await tokenFor(ADMIN), member = await tokenFor(MEMBER);
  const { board } = await (await api("/boards", admin, "POST", {})).json();
  const { link } = await (await api(`/boards/${board.id}/links`, admin, "POST", { role: "viewer" })).json();
  const cases = b => [
    [`/boards/${b}/invites`, "GET"], [`/boards/${b}/invites`, "POST", { email: "a@b.com", role: "viewer" }],
    [`/boards/${b}/invites/i-x`, "DELETE"], [`/boards/${b}/links`, "GET"], [`/boards/${b}/links`, "POST", { role: "viewer" }],
    [`/boards/${b}/links/${link.id}`, "DELETE"], [`/boards/${b}/grants/google%3A9`, "PUT", { role: "viewer" }],
  ];
  const known = cases(board.id), unknown = cases("b-0000000000000000"), weird = cases("..%2F");
  for (let i = 0; i < known.length; i++) {
    const a = await api(known[i][0], member, known[i][1], known[i][2]);
    const b = await api(unknown[i][0], member, unknown[i][1], unknown[i][2]);
    const c = await api(weird[i][0], member, weird[i][1], weird[i][2]);
    expect([a.status, b.status, c.status]).toEqual([403, 403, 403]);
    const [ta, tb, tc] = [await a.text(), await b.text(), await c.text()];
    expect(ta).toBe(tb);
    expect(ta).toBe(tc);
    expect([...a.headers]).toEqual([...b.headers]);
  }
  // A link id from this board can't be revoked through another board the caller manages.
  const { board: b2 } = await (await api("/boards", admin, "POST", {})).json();
  expect((await api(`/boards/${b2.id}/links/${link.id}`, admin, "DELETE")).status).toBe(403);
});

// ---- bodies ----

test("bodies: JSON only, capped at 16 KB (counted as read), objects only, unknown fields refused", async () => {
  const admin = await tokenFor(ADMIN);
  const post = (body, headers = {}) => call("/boards", { method: "POST", headers: { authorization: "Bearer " + admin, "content-type": "application/json", ...headers }, body });
  const big = JSON.stringify({ title: "x".repeat(17_000) });
  expect((await post(big)).status).toBe(413);
  // No Content-Length (a stream): still cut off at the cap.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000))); c.close(); } });
  const sr = await post(stream);
  expect(sr.status).toBe(413);
  expect(await sr.json()).toEqual({ error: "too-large" });
  // A lying (small) Content-Length doesn't help either.
  expect((await post(big, { "content-length": "10" })).status).toBe(413);
  expect(await (await post("{nope")).json()).toEqual({ error: "bad-json" });
  expect((await post("")).status).toBe(400);
  expect(await (await post("[]")).json()).toEqual({ error: "bad-request" });
  expect(await (await post("null")).json()).toEqual({ error: "bad-request" });
  expect(await (await post('{"title":"a","x":1}')).json()).toEqual({ error: "unknown-field", field: "x" });
  expect(await (await post('{"__proto__":{"admin":true}}')).json()).toEqual({ error: "unknown-field", field: "__proto__" });
  const form = await post("title=a", { "content-type": "application/x-www-form-urlencoded" });
  expect(form.status).toBe(415);
  expect((await post('{"title":"ok"}', { "content-type": "application/json; charset=utf-8" })).status).toBe(201);
  // Grants need `role` (null removes).
  const { board } = await (await post("{}")).json();
  await registry.touchMember(acme.id, { user: "google:9" });          // a new person grant needs someone the server knows
  const g = p => call(`/boards/${board.id}/grants/google%3A9`, { method: "PUT", headers: { authorization: "Bearer " + admin, "content-type": "application/json" }, body: p });
  expect((await g("{}")).status).toBe(400);
  expect((await g('{"role":"viewer"}')).status).toBe(204);
  expect((await g('{"role":null}')).status).toBe(204);
  const unknown = await call(`/boards/${board.id}/grants/email%3Azed%40acme.com`, { method: "PUT", headers: { authorization: "Bearer " + admin, "content-type": "application/json" }, body: '{"role":"viewer"}' });
  expect([unknown.status, await unknown.json()]).toEqual([400, { error: "unknown-person" }]);
  expect(await registry.grant(board.id, "google:9")).toBe(null);
  // A bad percent-escape in a path segment is a 400, not a throw.
  expect((await call(`/boards/${board.id}/grants/%E0%A4%A`, { method: "PUT", headers: { authorization: "Bearer " + admin, "content-type": "application/json" }, body: '{"role":"viewer"}' })).status).toBe(400);
});

// ---- outages ----

test("a Registry that throws gives 503 unavailable, never 403 or 500", async () => {
  const admin = await tokenFor(ADMIN);
  const { board } = await (await api("/boards", admin, "POST", {})).json();
  const down = new Proxy(registry, { get: () => async () => { throw new Error("db down"); } });
  routes = build({ registry: down, tenancy: makeTenancy({ registry: down, now }) });
  const reqs = [
    api("/boards", admin, "POST", {}), api(`/boards/${board.id}/invites`, admin), api(`/boards/${board.id}/links`, admin, "POST", { role: "viewer" }),
    api(`/boards/${board.id}/grants/google%3A9`, admin, "PUT", { role: "viewer" }), api(`/links/abc`, admin),
  ];
  for (const r of await Promise.all(reqs)) {
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "unavailable" });
  }
  // A session verifier that throws is an outage too.
  routes = build({ sessions: { ...sessions, verify: async () => { throw new Error("x"); } } });
  expect((await api(`/boards/${board.id}/invites`, admin)).status).toBe(503);
  // A link redeem outage at sign-in still signs in, flagged.
  routes = build({ tenancy: { ...tenancy, redeemLink: async () => { throw new Error("x"); } } });
  const { res } = await signIn(GUEST, { startPath: "/links/abc" });
  expect(new URLSearchParams(new URL(res.headers.get("location")).hash.slice(1)).get("link")).toBe("unavailable");
});

test("createBoard: the board and its owner grant are one Registry step (a failing setGrant is not part of it; no ownerless board)", async () => {
  const admin = await tokenFor(ADMIN);
  routes = build({ registry: { ...registry, setGrant: async () => { throw new Error("db blip"); } } });
  const r = await api("/boards", admin, "POST", { title: "whole" });
  expect(r.status).toBe(201);
  const id = (await r.json()).board.id;
  expect(await registry.grant(id, "google:1001")).toBe("owner");
  expect((await registry.board(id)).space).toMatch(/^s-/);   // it sits in the caller's personal space
});

// ---- mounting ----

test("not my route: /health, /ws, /blobs/*, /metrics and unknown paths give null; wrong method 405", async () => {
  for (const p of ["/health", "/ws", "/blobs/abc", "/blobs/t/x/y", "/metrics", "/", "/auth", "/auth/other", "/boards/x/y", "/links", "/links/a/b", "/varz"])
    for (const m of ["GET", "POST", "PUT", "DELETE"]) expect(await call(p, { method: m })).toBe(null);
  const rb = await call("/boards/x", { method: "GET" });
  expect(rb.status).toBe(405);
  expect(rb.headers.get("allow")).toBe("PATCH, DELETE");
  const r = await call("/boards", { method: "DELETE" });
  expect(r.status).toBe(405);
  expect(r.headers.get("allow")).toBe("GET, POST");
  // The engine passes the parsed URL as the second argument; it is used if given.
  expect(await routes(new Request(ORIGIN + "/boards", { method: "GET" }), new URL(ORIGIN + "/health"))).toBe(null);
});

test("no oidc configured: sign-in routes answer 503; the Bearer API still works", async () => {
  routes = build({ oidc: null, config: { ...config, cookieKey: undefined } });
  expect((await call("/auth/login")).status).toBe(503);
  expect(await (await call("/auth/callback?code=x&state=y")).json()).toEqual({ error: "sign-in-unavailable" });
  expect((await call("/links/abc")).status).toBe(503);
  const tok = await sessions.issue({ user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
  expect((await api("/boards", tok, "POST", {})).status).toBe(201);
});

let server;
afterAll(() => server?.stop(true));
test("over a real socket (Bun.serve on port 0): login → callback → POST /boards", async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => (await routes(req, new URL(req.url))) ?? new Response("nf", { status: 404 }) });
  const base = `http://127.0.0.1:${server.port}`;
  const start = await fetch(base + "/auth/login", { redirect: "manual" });
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location"));
  idp.codes.set("sock", await idp.mint({ ...ADMIN, nonce: loc.searchParams.get("nonce") }));
  const cb = await fetch(`${base}/auth/callback?code=sock&state=${loc.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: cookieOf(start) } });
  expect(cb.status).toBe(302);
  const ex = await fetch(base + "/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie: cookieOf(cb, EXCHANGE_COOKIE) },
    body: JSON.stringify({ code: fragCode(cb.headers.get("location")) }),
  });
  expect(ex.status).toBe(200);
  const tok = (await ex.json()).token;
  const r = await fetch(base + "/boards", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: '{"title":"sock"}' });
  expect(r.status).toBe(201);
  expect((await fetch(base + "/health")).status).toBe(404);   // ours returned null; this bare server 404s
});

test("dev tokens: refused unless a dev verifier is configured and enabled; accepted when it is", async () => {
  await registry.addTenantAdmin(acme.id, "dev:ann");
  const tokens = { "dev-ann": { name: "ann", domain: "acme.com" } };
  // Not configured (the default): a dev token is just a bad Bearer.
  expect((await api("/boards", "dev-ann", "POST", {})).status).toBe(401);
  // Configured but off (devAuth with no config, or enabled !== true): still refused.
  routes = build({ dev: devAuth() });
  expect((await api("/boards", "dev-ann", "POST", {})).status).toBe(401);
  routes = build({ dev: devAuth({ enabled: false, tokens }) });
  expect((await api("/boards", "dev-ann", "POST", {})).status).toBe(401);
  // A verifier object that doesn't say it's enabled is ignored, even if it would accept.
  routes = build({ dev: { verify: async () => ({ user: "dev:ann", name: "ann", email: null, domain: "acme.com" }) } });
  expect((await api("/boards", "dev-ann", "POST", {})).status).toBe(401);
  // Configured and on: accepted; unknown dev tokens still refused; session tokens still work.
  routes = build({ dev: devAuth({ enabled: true, tokens }) });
  const r = await api("/boards", "dev-ann", "POST", { title: "dev" });
  expect(r.status).toBe(201);
  expect(await registry.grant((await r.json()).board.id, "dev:ann")).toBe("owner");
  expect((await api("/boards", "dev-bob", "POST", {})).status).toBe(401);
  expect((await api("/boards", await tokenFor(ADMIN), "POST", {})).status).toBe(201);
  // A dev verifier that throws is an outage, not a refusal.
  routes = build({ dev: { enabled: true, verify: async () => { throw new Error("x"); } } });
  expect((await api("/boards", "dev-ann", "POST", {})).status).toBe(503);
});

// ---- replay guard: amortised O(1) pruning and a fail-closed cap (p5-httpv MEDIUM 1) ----

/**
 * A handler with a stub oidc, plus a forger of valid login cookies (the test holds the key). `accept`: the stub's
 * finish succeeds (302; the state takes a guard slot) or refuses every code (400; since p5-code no slot is taken).
 */
async function guardRig({ accept = true, ...over } = {}) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.cookieKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const who = { user: "google:9", name: "G", email: "g@acme.com", domain: "acme.com" };
  const h = build({ oidc: { begin: async () => ({}), finish: async () => (accept ? who : null) }, ...over });
  let n = 0;
  /** One callback with a fresh, valid login cookie for `state` (a fresh state by default). */
  const hit = async (state = "st-" + n++) => {
    const p = b64(new TextEncoder().encode(JSON.stringify({ s: state, n: "n", v: "v", exp: Math.floor(now() / 1000) + 600 })));
    const mac = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("l1." + p)));
    return h(new Request(`${ORIGIN}/auth/callback?code=bogus&state=${state}`, { headers: { cookie: `${LOGIN_COOKIE}=l1.${p}.${mac}` } }));
  };
  return { hit };
}
const drive = async (hit, calls, tick = 0) => { for (let i = 0; i < calls; i++) { clock.t += tick; await hit(); } };

test("replay guard: pruning visits O(1) entries per callback as live states grow, with and without expiry churn", async () => {
  // Deterministic: a tests-only hook counts the map entries each prune visits (no wall clock). Front-popping visits
  // every expired entry it deletes plus at most one live entry, where it stops. The old full scan visited every live
  // entry on every callback, so at 1k live it would visit ~1,000 per callback here, not ≤ 1. Sized at 2 × 1,000
  // callbacks (was 2 × 5,000, which hit bun's 5 s default under a loaded full suite; p5-slow), with a 30 s backstop.
  const rig = async (calls, tick) => {
    const seen = [];
    const { hit } = await guardRig({ testHooks: { pruned: p => seen.push(p) } });
    await drive(hit, calls, tick);
    return seen;
  };
  const check = seen => {
    for (const { visited, expired } of seen) expect(visited - expired).toBeLessThanOrEqual(1);   // ≤ 1 live entry
    const visited = seen.reduce((n, p) => n + p.visited, 0), expired = seen.reduce((n, p) => n + p.expired, 0);
    expect(expired).toBeLessThanOrEqual(seen.length);                 // each entry is inserted, so deleted, at most once
    expect(visited).toBeLessThanOrEqual(2 * seen.length);             // amortised O(1)
  };
  // No churn: the map only grows (to 1k live); every prune visits exactly the one live front entry.
  const flat = await rig(1_000, 0);
  expect(flat.length).toBe(1_000);
  expect(flat.at(-1).live).toBe(999);
  expect(flat.slice(1).every(p => p.visited === 1 && p.expired === 0)).toBe(true);
  check(flat);
  // Churn: the clock moves 1,200 ms per callback, so after 500 calls (600 s, the login TTL) each call also expires
  // ~1 entry from the front and live states hold at ~500.
  const churn = await rig(1_000, 1_200);
  expect(churn.reduce((n, p) => n + p.expired, 0)).toBeGreaterThanOrEqual(480);
  expect(churn.at(-1).live).toBeLessThanOrEqual(501);
  check(churn);
}, 30_000);

test("replay guard: a hard cap fails closed (503, cookie cleared); expiry frees room; replays still 400", async () => {
  const { hit } = await guardRig({ config: { ...config, maxLoginStates: 3 } });
  for (const s of ["a", "b", "c"]) expect((await hit(s)).status).toBe(302);         // used: three good logins
  const full = await hit("d");
  expect(full.status).toBe(503);
  expect(await full.json()).toEqual({ error: "unavailable" });
  expect(full.headers.getSetCookie().some(c => c.startsWith(LOGIN_COOKIE + "=;") && c.includes("Max-Age=0"))).toBe(true);
  expect(await (await hit("a")).json()).toEqual({ error: "login-failed" });         // a replay is still a refusal
  clock.t += 601_000;                                                                 // all three expire
  expect((await hit("d")).status).toBe(302);                                         // room again: back to normal
  // A good login through the real oidc still works under a cap with room left.
  routes = build({ config: { ...config, maxLoginStates: 1 } });
  const { res } = await signIn(ADMIN);
  expect(res.status).toBe(302);
  expect((await signIn(ADMIN)).res.status).toBe(503);                                // full → refused, not unguarded
});

test("replay guard: bogus-code callbacks take no slot, so they can't lock sign-in out; replays still refused (p5-googlev MEDIUM 2)", async () => {
  const cap = { ...config, maxLoginStates: 3 };
  // An anonymous client with free login cookies and bogus codes: every one is 400, none fills the guard.
  const { hit } = await guardRig({ accept: false, config: cap });
  for (let i = 0; i < 50; i++) expect((await hit()).status).toBe(400);
  // Same shape against the real oidc + fake Google: bogus codes refused by Google, then a real login still works.
  routes = build({ config: cap });
  for (let i = 0; i < 10; i++) {
    const start = await call("/auth/login");
    const st = new URL(start.headers.get("location")).searchParams.get("state");
    await loginFailed(await call(`/auth/callback?code=bogus-${i}&state=${st}`, { headers: { cookie: cookieOf(start) } }));
  }
  const good = await signIn(ADMIN);
  expect(good.res.status).toBe(302);
  // A replay of that successful callback is still refused (before any call to Google)...
  const before = idp.tokenRequests.length;
  await loginFailed(await call(`/auth/callback?${new URLSearchParams({ code: good.code, state: good.state })}`, { headers: { cookie: good.cookie } }));
  expect(idp.tokenRequests.length).toBe(before);
  // ...and a state whose first callback failed may be retried (it took no slot), but once it succeeds it is spent.
  const { hit: ok } = await guardRig({ config: cap });
  expect((await ok("s-1")).status).toBe(302);
  expect((await ok("s-1")).status).toBe(400);
});
