// A failed sign-in callback logs its cause (p5-googlev LOW 1): one "sign-in failed" { cause } line per refusal, a
// fixed label only, never a code, state, token, cookie value or Google's error_description. Fake IdP, no network.
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { httpRoutes, LOGIN_COOKIE, SIGN_IN_CAUSES } from "../../server/auth/http.js";
import { googleOidc, verifyIdToken, CAUSES } from "../../server/auth/oidc.js";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

const ORIGIN = "https://plenary.test";
const SECRET = "client-secret-SENTINEL-9d2f";
const DESC = "error-description-SENTINEL-41ab";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}" };

let idp, lines, routes, tokenOverride, oidc;
const log = { warn: (msg, fields) => lines.push({ msg, ...fields }) };

beforeAll(async () => { idp = await fakeIdp(); await idp.addKey("k1"); });

async function build(over = {}) {
  const registry = memoryRegistry();
  const fetch = async (url, init) => (url === "https://oauth2.googleapis.com/token" && tokenOverride ? tokenOverride(url, init) : idp.fetch(url, init));
  oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUri: ORIGIN + "/auth/callback", fetch, timeoutMs: 200 });
  return httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), oidc, tenancy: makeTenancy({ registry }), config, log, ...over });
}
beforeEach(async () => { lines = []; tokenOverride = null; routes = await build(); });

const call = (r, path, init) => r(new Request(ORIGIN + path, init));
async function begin(r = routes) {
  const res = await call(r, "/auth/login");
  const loc = new URL(res.headers.get("location"));
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return { state: loc.searchParams.get("state"), nonce: loc.searchParams.get("nonce"), cookie };
}
const callback = (r, q, cookie) => call(r, "/auth/callback?" + new URLSearchParams(q), cookie ? { headers: { cookie } } : undefined);

/** The one failure line, after checking nothing secret or request-specific reached any line. */
function onlyCause(...secrets) {
  const text = JSON.stringify(lines);
  for (const s of [SECRET, DESC, ...secrets]) expect(text.includes(s)).toBe(false);
  expect(lines.length).toBe(1);
  expect(lines[0].msg).toBe("sign-in failed");
  expect(Object.keys(lines[0]).sort()).toEqual(["cause", "msg"]);
  return lines[0].cause;
}

test("before Google: no cookie, a forged cookie, Google's ?error=, a wrong state, no code", async () => {
  const b = await begin();
  const cases = [
    [{ state: b.state, code: "c1" }, null, "no_login_cookie"],
    [{ state: b.state, code: "c1" }, b.cookie.slice(0, -3) + "AAA", "bad_login_cookie"],
    [{ state: b.state, error: "access_denied" }, b.cookie, "idp_error:access_denied"],
    [{ state: b.state, error: "<script>x" }, b.cookie, "idp_error"],              // unknown names are not echoed
    [{ state: "wrong", code: "c1" }, b.cookie, "state_mismatch"],
    [{ state: b.state }, b.cookie, "no_code"],
  ];
  for (const [q, cookie, cause] of cases) {
    lines = [];
    const res = await callback(routes, q, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "login-failed" });
    expect(onlyCause(b.state, "c1", b.cookie.slice(LOGIN_COOKIE.length + 1), "<script>")).toBe(cause);
  }
  expect(idp.tokenRequests.length).toBe(0);                                      // none of these reached Google
});

test("Google's token endpoint: its RFC 6749 error name, never error_description; others by status", async () => {
  const cases = [
    [() => Response.json({ error: "invalid_grant", error_description: DESC }, { status: 400 }), "invalid_grant"],
    [() => Response.json({ error: "invalid_client", error_description: DESC }, { status: 401 }), "invalid_client"],
    [() => Response.json({ error: "made_up_" + DESC }, { status: 401 }), "token_http_401"],
    [() => new Response("<html>" + DESC, { status: 502 }), "token_http_502"],
    [() => { throw new Error("connect failed: https://oauth2.googleapis.com/token?" + DESC); }, "idp_unreachable"],
    [() => { throw Object.assign(new Error("timed out " + DESC), { name: "TimeoutError" }); }, "idp_timeout"],
    [() => Response.json({ id_token: "not.a.jwt" }), "bad_token"],
  ];
  for (const [respond, cause] of cases) {
    tokenOverride = respond;
    const b = await begin();
    lines = [];
    const res = await callback(routes, { state: b.state, code: "4/real-looking-code" }, b.cookie);
    expect(res.status).toBe(400);
    expect(onlyCause("4/real-looking-code", b.state)).toBe(cause);
  }
});

test("ID-token refusals name the check that failed", async () => {
  const cases = [
    [n => idp.mint({ nonce: n, aud: "someone-else" }), "bad_aud"],
    [n => idp.mint({ nonce: n + "x" }), "bad_nonce"],
    [n => idp.mint({ nonce: n, iss: "https://evil.example" }), "bad_iss"],
    [n => idp.mint({ nonce: n, exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }), "expired"],
    [n => idp.mint({ nonce: n }, { kid: "nope", signWith: "k1" }), "unknown_kid"],
    [n => idp.mint({ nonce: n }, { header: { alg: "HS256" } }), "bad_alg"],
    [async n => (await idp.mint({ nonce: n })).slice(0, -6) + "AAAAAA", "bad_sig"],
  ];
  for (const [mint, cause] of cases) {
    const b = await begin();
    const token = await mint(b.nonce);
    idp.codes.set("code-" + cause, token);
    lines = [];
    const res = await callback(routes, { state: b.state, code: "code-" + cause }, b.cookie);
    expect(res.status).toBe(400);
    expect(onlyCause(token, b.nonce, "code-" + cause)).toBe(cause);
  }
});

test("a success logs nothing; replaying its callback logs state_used; a full replay guard logs replay_guard_full", async () => {
  const r = await build({ config: { ...config, maxLoginStates: 1 } });
  const ok = async () => {
    const b = await begin(r);
    idp.codes.set("good-" + b.state, await idp.mint({ nonce: b.nonce }));
    return { b, res: await callback(r, { state: b.state, code: "good-" + b.state }, b.cookie) };
  };
  const first = await ok();
  expect(first.res.status).toBe(302);
  expect(lines).toEqual([]);
  const again = await callback(r, { state: first.b.state, code: "good-" + first.b.state }, first.b.cookie);
  expect(again.status).toBe(400);
  expect(onlyCause()).toBe("state_used");
  lines = [];
  const second = await ok();
  expect(second.res.status).toBe(503);
  expect(onlyCause()).toBe("replay_guard_full");
});

test("an IdP adapter that refuses without a cause logs idp_refused; one that throws logs idp_threw", async () => {
  for (const [finish, cause] of [[async () => null, "idp_refused"], [async () => { throw new Error("boom " + DESC); }, "idp_threw"]]) {
    const registry = memoryRegistry();
    const fake = { begin: async () => ({ url: "https://idp.test/a?state=" + "s".repeat(20), state: "s".repeat(20), nonce: "n", verifier: "v" }), finish };
    const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), oidc: fake, tenancy: makeTenancy({ registry }), config, log });
    const b = await begin(r);
    lines = [];
    expect((await callback(r, { state: b.state, code: "x" }, b.cookie)).status).toBe(400);
    expect(onlyCause()).toBe(cause);
  }
});

test("a throwing logger changes no answer; a cause that isn't a plain label is dropped", async () => {
  const registry = memoryRegistry();
  const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry }), config,
    oidc: { begin: async () => ({ url: "https://idp.test/a?state=" + "s".repeat(20), state: "s".repeat(20), nonce: "n", verifier: "v" }),
      finish: async ({ why }) => { why("Bearer s1.leaked.token value"); return null; } },
    log: { warn: msg => { lines.push({ msg, cause: "seen" }); throw new Error("log down"); } } });
  const b = await begin(r);
  const res = await callback(r, { state: b.state, code: "x" }, b.cookie);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "login-failed" });
  expect(lines.length).toBe(1);
  // and with a recording logger, the bad label became idp_refused
  const r2 = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry }), config, log,
    oidc: { begin: async () => ({ url: "https://idp.test/a?state=" + "t".repeat(20), state: "t".repeat(20), nonce: "n", verifier: "v" }),
      finish: async ({ why }) => { why("Bearer s1.leaked.token value"); return null; } } });
  const b2 = await begin(r2);
  lines = [];
  await callback(r2, { state: b2.state, code: "x" }, b2.cookie);
  expect(onlyCause("leaked")).toBe("idp_refused");
});

test("a state- or code-shaped string handed to `why` is never logged", async () => {
  for (const bad of ["abcdefghijklmnopqrstuvwxyzabcdef", "k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8", "4/0AfJohXn", "Bad_Case", "a_b_c_d_e"]) {
    const registry = memoryRegistry();
    const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry }), config, log,
      oidc: { begin: async () => ({ url: "https://idp.test/a?state=" + "u".repeat(20), state: "u".repeat(20), nonce: "n", verifier: "v" }),
        finish: async ({ why }) => { why(bad); return null; } } });
    const b = await begin(r);
    lines = [];
    await callback(r, { state: b.state, code: "x" }, b.cookie);
    expect(onlyCause(bad)).toBe("idp_refused");
  }
});

test("default logger: one JSON line on stdout in server/log.js's shape", async () => {
  const registry = memoryRegistry();
  const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry }), config,
    oidc: { begin: async () => ({ url: "https://idp.test/a?state=" + "s".repeat(20), state: "s".repeat(20), nonce: "n", verifier: "v" }), finish: async () => null } });
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = s => { out.push(String(s)); return true; };
  try { await callback(r, { state: "x", code: "y" }, null); } finally { process.stdout.write = write; }
  expect(out.length).toBe(1);
  const l = JSON.parse(out[0]);
  expect(l).toMatchObject({ level: "warn", msg: "sign-in failed", cause: "no_login_cookie" });
  expect(typeof l.time).toBe("string");
});

test("verifyIdToken: a throwing `why` changes no verdict; every cause either file reports is listed", async () => {
  const keys = { key: async () => null };
  expect(await verifyIdToken("a.b.c", { clientId: CLIENT_ID, nonce: "n", keys, why: () => { throw new Error("x"); } })).toBeNull();
  const heard = [];
  await verifyIdToken("nope", { clientId: CLIENT_ID, nonce: "n", keys, why: c => heard.push(c) });
  expect(heard).toEqual(["bad_token"]);
  for (const c of CAUSES) expect(c.replace("<status>", "502")).toMatch(/^[a-z]{1,12}(?:_[a-z]{1,12}){0,3}(?:_\d{3})?$/);   // http.js's filter admits each
  for (const c of SIGN_IN_CAUSES) expect(c).toMatch(/^[a-z0-9_:<>]{1,40}$/);
  // The causes in the source match the lists (a new refusal must be added to CAUSES on purpose).
  const src = await Bun.file(new URL("../../server/auth/oidc.js", import.meta.url)).text();
  for (const m of src.matchAll(/\bno\("([a-z_]+)"\)/g)) expect(CAUSES).toContain(m[1]);
  const http = await Bun.file(new URL("../../server/auth/http.js", import.meta.url)).text();
  for (const m of http.matchAll(/\b(?:fail|failed)\("([a-z_]+)"\)/g)) expect(SIGN_IN_CAUSES).toContain(m[1]);
});

test("restart mid-login / a second gateway: same COOKIE_KEY finishes the login; a different key logs bad_login_cookie", async () => {
  // Two httpRoutes over one Registry stand for one server before and after a restart, or two gateways behind a load
  // balancer: the login cookie is the only login state, so only the key matters.
  const registry = memoryRegistry();
  const node = async cookieKey => httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), oidc, tenancy: makeTenancy({ registry }),
    config: { ...config, cookieKey }, log });
  const a = await node("k".repeat(32)), same = await node("k".repeat(32)), other = await node("r".repeat(32));
  const b = await begin(a);
  idp.codes.set("restart-ok", await idp.mint({ nonce: b.nonce }));
  lines = [];
  const res = await callback(other, { state: b.state, code: "restart-ok" }, b.cookie);
  expect(res.status).toBe(400);
  expect(onlyCause()).toBe("bad_login_cookie");                 // e.g. a single node with no COOKIE_KEY, restarted
  lines = [];
  const ok = await callback(same, { state: b.state, code: "restart-ok" }, b.cookie);
  expect(ok.status).toBe(302);
  expect(new URL(ok.headers.get("location")).hash).toMatch(/^#code=/);
  expect(lines).toEqual([]);
});
