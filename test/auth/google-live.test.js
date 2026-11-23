// LIVE check against Google's real OAuth endpoints (brief p5-google), through the dev harness scripts/dev-google.js.
// Skipped unless PLENARY_LIVE_GOOGLE=1 and .env has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, so CI and the
// normal `bun test` never call Google:
//
//   PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live.test.js
//
// Goes as far as a script can: up to Google's sign-in page, plus a callback with a bogus code. The human login is
// the only step left. Never prints the client id or secret; any URL it reports is reduced to origin + path.

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { startDevGoogle, REDIRECT_URI, safeFetch, probeAuthorize } from "../../scripts/dev-google.js";
import { GOOGLE, jwksCache } from "../../server/adapters/driven/auth/oidc.js";
import { LOGIN_COOKIE } from "../../server/adapters/driving/auth-http.js";

const ID = process.env.GOOGLE_CLIENT_ID, SECRET = process.env.GOOGLE_CLIENT_SECRET;
const LIVE = process.env.PLENARY_LIVE_GOOGLE === "1" && !!ID && !!SECRET;
const where = u => { const x = new URL(u); return x.origin + x.pathname; };
// Always a boolean: with no .env, ID and SECRET are undefined and a bare `&&`/`||` chain would yield undefined,
// which fails `toBe(false)` (p5-tidy).
const leaks = s => Boolean((ID && s.includes(ID)) || (SECRET && s.includes(SECRET)));

describe.skipIf(!LIVE)("Google sign-in, live (PLENARY_LIVE_GOOGLE=1)", () => {
  let h;
  const logs = [];
  const tokenCalls = [];               // { status, error } of each call to Google's token endpoint
  const spyFetch = async (input, init) => {
    const res = await safeFetch(input, init);              // a thrown fetch error never carries the URL
    if (String(input) === GOOGLE.token) {
      let error = null;
      try { error = (await res.clone().json())?.error ?? null; } catch {}
      tokenCalls.push({ status: res.status, error });
    }
    return res;
  };

  beforeAll(async () => { h = await startDevGoogle({ port: 0, fetch: spyFetch, log: r => logs.push(JSON.stringify(r)) }); });
  afterAll(() => h?.stop());

  async function login() {
    const res = await fetch(h.url + "/auth/login", { redirect: "manual" });
    return { res, location: res.headers.get("location"), cookie: res.headers.get("set-cookie") ?? "" };
  }

  test("GET /auth/login redirects to Google with the full authorization request", async () => {
    const { res, location, cookie } = await login();
    expect(res.status).toBe(302);
    const u = new URL(location);
    expect(where(location)).toBe(GOOGLE.authorize);
    const q = u.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id") === ID).toBe(true);               // compared, never printed
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(REDIRECT_URI).toBe("http://localhost:8080/auth/callback");
    expect(q.get("scope").split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
    expect(q.get("state")).toMatch(/^[a-z0-9]{32}$/);
    expect(q.get("nonce")).toMatch(/^[a-z0-9]{32}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(cookie.startsWith(LOGIN_COOKIE + "=l1.")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(leaks(cookie)).toBe(false);
  });

  test("Google answers that URL with its sign-in page, not an error", async () => {
    const { location } = await login();
    const g = await probeAuthorize(location);                   // plain GET: no cookies, no login; safeFetch
    console.log(`google: ${g.status} ${g.where} errors=[${g.errors.join(",")}]`);
    expect(g.status).toBe(200);
    expect(g.errors).toEqual([]);
    expect(g.path).toMatch(/\/signin\/identifier$/);              // marker: Google's account chooser
  });

  test("negative control: the same check does catch a wrong redirect URI", async () => {
    const { location } = await login();
    const u = new URL(location);
    u.searchParams.set("redirect_uri", "http://localhost:8081/auth/callback");
    const g = await probeAuthorize(u.href);
    console.log(`control: ${g.status} ${g.where} errors=[${g.errors.join(",")}]`);
    expect(g.errors).toContain("redirect_uri_mismatch");
  });

  test("Google's discovery document names the endpoints we use, and its JWKS parses through jwksCache", async () => {
    const d = await (await safeFetch("https://accounts.google.com/.well-known/openid-configuration")).json();
    expect(GOOGLE.issuers).toContain(d.issuer);
    expect(d.authorization_endpoint).toBe(GOOGLE.authorize);
    expect(d.token_endpoint).toBe(GOOGLE.token);
    expect(d.jwks_uri).toBe(GOOGLE.jwks);
    expect(d.id_token_signing_alg_values_supported).toContain("RS256");
    expect(d.code_challenge_methods_supported).toContain("S256");

    const raw = await (await safeFetch(GOOGLE.jwks)).json();
    const kids = raw.keys.filter(k => k.kty === "RSA").map(k => k.kid);
    expect(kids.length).toBeGreaterThan(0);
    const cache = jwksCache({ fetch: safeFetch });
    for (const kid of kids) expect(await cache.key(kid)).toBeInstanceOf(CryptoKey);
    expect(await cache.key("no-such-kid")).toBeNull();
    console.log(`jwks: ${kids.length} RS256 keys imported`);
  });

  test("callback with a bogus code and a valid state: Google says invalid_grant, we refuse cleanly", async () => {
    const { location, cookie } = await login();
    const state = new URL(location).searchParams.get("state");
    const before = tokenCalls.length;
    const res = await fetch(`${h.url}/auth/callback?state=${state}&code=4%2F0-bogus-code`, {
      redirect: "manual", headers: { cookie: cookie.split(";")[0] },
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "login-failed" });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");      // login cookie cleared
    expect(res.headers.get("location")).toBeNull();
    expect(tokenCalls.slice(before)).toEqual([{ status: 400, error: "invalid_grant" }]);
    console.log(`token endpoint: ${JSON.stringify(tokenCalls.slice(before))}`);

    // Nothing secret in the response or the logs.
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(leaks(text) || leaks(headers)).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some(leaks)).toBe(false);
    expect(logs.some(l => l.includes("state=") || l.includes("code="))).toBe(false);   // no query strings logged
    expect(logs.some(l => l.includes('"path":"/auth/callback"') && l.includes('"loginCookie":true'))).toBe(true);

    // The harness is still up (no crash).
    expect((await fetch(h.url + "/")).status).toBe(200);
  });

  test("the harness's own pages: /whoami decodes a session server-side; /signed-in never contains a token", async () => {
    const token = await h.sessions.issue({ user: "google:1", name: "T", email: "t@gmail.com", domain: null });
    const ok = await fetch(h.url + "/whoami", { headers: { authorization: "Bearer " + token } });
    expect(await ok.json()).toEqual({ email: "t@gmail.com" });
    expect((await fetch(h.url + "/whoami", { headers: { authorization: "Bearer s1.x.y" } })).status).toBe(401);
    const page = await (await fetch(h.url + "/signed-in")).text();
    expect(page).not.toContain("s1.");
  });
});

// Not live: runs in the normal suite and never reaches Google (p5-googlev MEDIUM 1). When Google is unreachable, a
// thrown fetch error must not print the authorization URL (it carries the client id). A child process lets the error
// go uncaught, exactly as a failing test would print it, and we read everything it wrote.
describe("an unreachable Google never prints the client id", () => {
  const SENTINEL = "SENTINEL-client-id-7f3a9c.apps.googleusercontent.com";
  const run = async (fetchName, host) => {
    const url = `http://${host}/o/oauth2/v2/auth?response_type=code&client_id=${SENTINEL}&scope=openid`;
    const src = `import { probeAuthorize, safeFetch } from ${JSON.stringify(import.meta.dir + "/../../scripts/dev-google.js")};
      await probeAuthorize(${JSON.stringify(url)}, { fetch: ${fetchName} });`;
    const p = Bun.spawn([process.execPath, "-e", src], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    return { code: await p.exited, out };
  };
  for (const [label, host] of [["refused", "127.0.0.1:9"], ["no such host", "plenary-unreachable.invalid"]]) {
    test(`${label}: safeFetch rethrows "google unreachable: <code>" with no URL`, async () => {
      const r = await run("safeFetch", host);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("google unreachable: ");
      expect(r.out.includes("SENTINEL")).toBe(false);
      expect(r.out.includes(host)).toBe(false);
      expect(leaks(r.out)).toBe(false);                            // nor the real ones (the child may load .env)
    }, 20_000);
    test(`${label}: control: a raw fetch does print it (so the check above has teeth)`, async () => {
      const r = await run("fetch", host);
      expect(r.code).not.toBe(0);
      expect(r.out.includes("SENTINEL")).toBe(true);
    }, 20_000);
  }
});

test("live Google check is opt-in", () => {
  if (!LIVE) console.log("google-live: skipped (set PLENARY_LIVE_GOOGLE=1 with GOOGLE_CLIENT_ID/SECRET in .env)");
  expect(true).toBe(true);
});
