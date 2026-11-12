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

/** A body whose read rejects with a TimeoutError, as fetch's AbortSignal.timeout does mid-body. */
const stalled = () => new ReadableStream({ pull(c) { c.error(Object.assign(new Error("timed out " + DESC), { name: "TimeoutError" })); } });

test("Google's token endpoint: its RFC 6749 error name, never error_description; others by status", async () => {
  const cases = [
    [() => Response.json({ error: "invalid_grant", error_description: DESC }, { status: 400 }), "invalid_grant"],
    [() => Response.json({ error: "invalid_client", error_description: DESC }, { status: 401 }), "invalid_client"],
    [() => Response.json({ error: "made_up_" + DESC }, { status: 401 }), "token_http_401"],
    [() => new Response("<html>" + DESC, { status: 502 }), "bad_token_response"],   // not JSON, whatever the status
    [() => new Response("", { status: 503 }), "bad_token_response"],
    [() => { throw new Error("connect failed: https://oauth2.googleapis.com/token?" + DESC); }, "idp_unreachable"],
    [() => { throw Object.assign(new Error("timed out " + DESC), { name: "TimeoutError" }); }, "idp_timeout"],
    [() => Response.json({ id_token: "not.a.jwt" }), "bad_token"],
    // Google answered, but not with JSON: not "unreachable" (p5-google2v L2)
    [() => new Response("<html>" + DESC, { status: 200 }), "bad_token_response"],
    [() => new Response("", { status: 200 }), "bad_token_response"],
    [() => new Response("{\"id_token\":", { status: 201, headers: { "content-type": "application/json" } }), "bad_token_response"],
    // the timeout also covers reading the body: still idp_timeout, on either branch
    [() => new Response(stalled(), { status: 200 }), "idp_timeout"],
    [() => new Response(stalled(), { status: 500 }), "idp_timeout"],
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

// p5-tidyv V2, V3: a real socket, not a synthetic Response (Bun's fetch reads an empty real body as JSON `null`, and
// a reset mid-body rejects the body read). A raw node:net server on port 0 writes one canned answer per connection.
/** @param {(s: import("node:net").Socket) => void} answer */
async function rawServer(answer) {
  const { createServer } = await import("node:net");
  const srv = createServer(s => { s.on("error", () => {}); s.once("data", () => answer(s)); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  return { port: srv.address().port, close: () => new Promise(r => srv.close(r)) };
}
const EXPECTED = { state: "s".repeat(20), nonce: "n".repeat(20), verifier: "v".repeat(43) };
async function causeFrom(answer) {
  const srv = await rawServer(answer);
  try {
    const heard = [];
    // A timeout well past the answer, so a loaded full run can't turn a reset into idp_timeout.
    const o = googleOidc({ clientId: CLIENT_ID, clientSecret: SECRET, redirectUri: ORIGIN + "/auth/callback", timeoutMs: 8000,
      fetch: (_u, init) => fetch(`http://127.0.0.1:${srv.port}/token`, init) });
    expect(await o.finish({ code: "4/real-looking-code", state: EXPECTED.state, expected: EXPECTED, why: c => heard.push(c) })).toBeNull();
    expect(heard.length).toBe(1);
    return heard[0];
  } finally { await srv.close(); }
}
const head = (status, extra) => `HTTP/1.1 ${status} X\r\ncontent-type: application/json\r\n${extra}\r\n`;

test("token answer on a real socket: a reset mid-body is idp_unreachable; an empty body is bad_token_response", async () => {
  for (const status of [200, 500]) {
    // headers and part of a body, then a reset: the network failed, whatever the status (V2)
    expect(await causeFrom(s => { s.write(head(status, "content-length: 500\r\n") + "{\"id_token\":\"abc"); setTimeout(() => s.destroy(), 50); }),
      `reset, ${status}`).toBe("idp_unreachable");
    expect(await causeFrom(s => { s.write(head(status, "content-length: 500\r\n") + "{\"error\":\"invalid_gr"); setTimeout(() => s.resetAndDestroy?.() ?? s.destroy(), 50); }),
      `RST, ${status}`).toBe("idp_unreachable");
  }
  for (const status of [200, 503]) {
    // an empty body, by length or chunked, is not JSON (V3)
    expect(await causeFrom(s => s.end(head(status, "content-length: 0\r\n"))), `empty, ${status}`).toBe("bad_token_response");
    expect(await causeFrom(s => s.end(head(status, "transfer-encoding: chunked\r\n") + "0\r\n\r\n")), `empty chunked, ${status}`).toBe("bad_token_response");
  }
  // and a whole JSON answer still means what it says, on a real socket too
  const body = JSON.stringify({ error: "invalid_grant", error_description: DESC });
  expect(await causeFrom(s => s.end(head(400, `content-length: ${body.length}\r\n`) + body))).toBe("invalid_grant");
  expect(await causeFrom(s => s.end(head(200, "content-length: 4\r\n") + "null"))).toBe("bad_token");
}, 30000);

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

test("sign-in succeeds but the exchange code can't be made: 503, logged as mint_failed (p5-google2v L4)", async () => {
  const registry = memoryRegistry();
  const r = httpRoutes({ registry, sessions: await makeSessions({ key: "s".repeat(32) }), tenancy: makeTenancy({ registry }), config, log,
    oidc: { begin: async () => ({ url: "https://idp.test/a?state=" + "m".repeat(20), state: "m".repeat(20), nonce: "n", verifier: "v" }),
      // a BigInt user id: JSON.stringify inside mintCode throws, the cheapest way to make it fail
      finish: async () => ({ user: 10n, name: null, email: null, domain: null }) } });
  const b = await begin(r);
  lines = [];
  const res = await callback(r, { state: b.state, code: "x" }, b.cookie);
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "unavailable" });
  expect(onlyCause(b.state)).toBe("mint_failed");
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
  // The causes in the source match the lists, both ways (p5-tidyv V5): a new refusal must be added to a list on
  // purpose, and a list holds no label the code never logs.
  const src = await Bun.file(new URL("../../server/auth/oidc.js", import.meta.url)).text();
  const http = await Bun.file(new URL("../../server/auth/http.js", import.meta.url)).text();
  const fromOidc = sourceLabels(src, ["no"]);
  const fromHttp = sourceLabels(http, ["fail", "failed"]);
  expect(fromOidc).toContain("bad_token_response");   // a ternary label
  expect(fromOidc).toContain("token_http_<>");        // a template literal
  expect(fromHttp).toContain("bad_login_cookie");     // a ternary label
  expect(fromHttp).toContain("idp_error:<>");         // a template literal
  expect(fromHttp).toContain("idp_threw");            // the `cause ??=` fallback
  for (const c of fromOidc) expect(CAUSES.map(norm)).toContain(c);
  for (const c of fromHttp) expect(SIGN_IN_CAUSES.map(norm)).toContain(c);
  // The other way: every listed label is in the source. The only ones that aren't literals are oidc.js's RFC 6749
  // names, passed through as `e` after TOKEN_ERRORS.includes(e).
  const RFC6749 = ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope"];
  expect(CAUSES.map(norm).filter(c => !fromOidc.includes(c)).sort()).toEqual([...RFC6749].sort());
  expect(SIGN_IN_CAUSES.map(norm).filter(c => !fromHttp.includes(c))).toEqual([]);
  // The scanner itself: single quotes, template literals and a call split over lines are all seen.
  expect(sourceLabels("no('a_b');\nno(`c_d_${x}`);\nreturn no(\n  x\n    ? \"e_f\"\n    : 'g_h'\n);", ["no"]).sort())
    .toEqual(["a_b", "c_d_<>", "e_f", "g_h"]);
  expect(sourceLabels("fail(`x_${y}_z`)", ["fail"])).toEqual(["x_<>_z"]);
});

/** A placeholder in either form (`<status>`, `<n>`, `${res.status}`) as `<>`. */
const norm = s => s.replace(/<[^>]*>/g, "<>");

/**
 * Every lowercase label written as a string literal ("…", '…' or `…`, `${…}` read as `<>`) anywhere inside a call
 * to one of `calls`, the call's whole text up to its closing parenthesis, over any number of lines; plus a
 * `cause ??= "…"` fallback.
 */
function sourceLabels(text, calls) {
  const out = new Set();
  const literals = s => [...s.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map(m => norm((m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, "<>")));
  const add = s => { for (const l of literals(s)) if (/^[a-z][a-z0-9_:]*(?:<>[a-z0-9_:]*)*$/.test(l)) out.add(l); };
  for (const m of text.matchAll(new RegExp(`\\b(?:${calls.join("|")})\\(`, "g"))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
    add(text.slice(m.index + m[0].length, i - 1));
  }
  for (const m of text.matchAll(/\bcause\s*\?\?=\s*([^;\n]*)/g)) add(m[1]);
  return [...out];
}

// p5-tidyv V5: the CEO's hand-off table (docs/m2/reports/p5-google2.md, section (e)) lists exactly what can be logged.
test("the hand-off cause table lists every label the server can log, and nothing else", async () => {
  const doc = await Bun.file(new URL("../../docs/m2/reports/p5-google2.md", import.meta.url)).text();
  const from = doc.indexOf("**(e) If it fails:**");
  expect(from).toBeGreaterThan(-1);
  const rows = doc.slice(from).split("\n").slice(1).filter(Boolean);
  const table = rows.slice(0, rows.findIndex(r => !r.startsWith("|")));
  expect(table[0]).toMatch(/^\| `cause` \|/);
  const listed = table.slice(2).flatMap(r => [...r.split("|")[1].matchAll(/`([^`]+)`/g)].map(m => norm(m[1])));
  const known = [...new Set([...CAUSES, ...SIGN_IN_CAUSES].map(norm))];
  for (const c of known) expect(listed, `${c} missing from the table`).toContain(c);
  // A concrete example of a pattern row (`idp_error:server_error`, `token_http_502`) is fine; anything else isn't.
  const instance = l => known.filter(k => k.endsWith("<>")).some(k => l.startsWith(k.slice(0, -2)) && /^[a-z0-9_]+$/.test(l.slice(k.length - 2)));
  for (const l of listed) expect(known.includes(l) || instance(l), `${l} is in the table but never logged`).toBe(true);
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
