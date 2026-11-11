import { test, expect, beforeAll } from "bun:test";
import { verifyIdToken, jwksCache, challengeS256, newVerifier, googleOidc, parseJwt } from "../../server/auth/oidc.js";
import { b64url, utf8 } from "../../server/auth/util.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

let idp, clock = { t: Date.UTC(2026, 10, 11, 12) };
const now = () => clock.t;
const keys = () => jwksCache({ fetch: idp.fetch, now });
const v = (tok, o = {}) => verifyIdToken(tok, { clientId: CLIENT_ID, nonce: "n-1", keys: o.keys ?? keys(), now, ...o });

beforeAll(async () => { idp = await fakeIdp({ now }); await idp.addKey("k1"); });

test("a good token gives an identity; domain from hd, user from sub", async () => {
  expect(await v(await idp.mint())).toEqual({ user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" });
});

test("hd is the domain, never the email; no hd = no tenant", async () => {
  expect((await v(await idp.mint({ email: "x@a.com", hd: "b.com" }))).domain).toBe("b.com");
  expect((await v(await idp.mint({ email: "x@acme.com", hd: undefined }))).domain).toBe(null);
  expect((await v(await idp.mint({ hd: 42 }))).domain).toBe(null);
});

test("unverified email is not carried (so it can't claim an invite)", async () => {
  expect((await v(await idp.mint({ email_verified: false }))).email).toBe(null);
  expect((await v(await idp.mint({ email: "Ann@ACME.com" }))).email).toBe("ann@acme.com");
});

test("both Google issuer spellings pass; others fail", async () => {
  expect(await v(await idp.mint({ iss: "accounts.google.com" }))).not.toBe(null);
  expect(await v(await idp.mint({ iss: "https://evil.example" }))).toBe(null);
  expect(await v(await idp.mint({ iss: undefined }))).toBe(null);
});

test("refusals: signature, aud, exp, iat, nonce, missing claims", async () => {
  const good = await idp.mint();
  const [h, p, s] = good.split(".");
  const flipped = s.slice(0, -2) + (s.at(-2) === "A" ? "B" : "A") + s.at(-1);
  expect(await v(`${h}.${p}.${flipped}`)).toBe(null);                                     // bad signature
  const otherPayload = b64url(utf8(JSON.stringify({ ...parseJwt(good).payload, sub: "evil" })));
  expect(await v(`${h}.${otherPayload}.${s}`)).toBe(null);                                // payload swapped
  expect(await v(await idp.mint({ aud: "someone-else" }))).toBe(null);
  expect(await v(await idp.mint({ aud: undefined }))).toBe(null);
  expect(await v(await idp.mint({ aud: [CLIENT_ID] }))).not.toBe(null);
  expect(await v(await idp.mint({ aud: [CLIENT_ID, "x"] }))).toBe(null);                  // several aud, no azp
  expect(await v(await idp.mint({ aud: [CLIENT_ID, "x"], azp: CLIENT_ID }))).not.toBe(null);
  const t = Math.floor(clock.t / 1000);
  expect(await v(await idp.mint({ exp: t - 120 }))).toBe(null);                           // expired
  expect(await v(await idp.mint({ exp: t - 120, iat: t - 3000 }))).toBe(null);                // expired, iat sane
  expect(await v(await idp.mint({ exp: t - 30, iat: t - 3000 }))).not.toBe(null);                        // within skew
  expect(await v(await idp.mint({ exp: undefined }))).toBe(null);
  expect(await v(await idp.mint({ iat: t + 600 }))).toBe(null);                           // issued in the future
  expect(await v(await idp.mint({ iat: undefined }))).toBe(null);
  expect(await v(await idp.mint({ nonce: "other" }))).toBe(null);
  expect(await v(await idp.mint({ nonce: undefined }))).toBe(null);
  expect(await v(good, { nonce: "" })).toBe(null);                                        // expected nonce required
  expect(await v(await idp.mint({ sub: undefined }))).toBe(null);
});

test("alg none and HS256-with-the-public-key are refused", async () => {
  const none = await idp.mint({}, { header: { alg: "none" }, raw: s => s + "." });
  expect(await v(none)).toBe(null);
  // A valid RS256 signature under a header that names another alg is still refused (alg is checked, not trusted).
  expect(await v(await idp.mint({}, { header: { alg: "RS512" } }))).toBe(null);
  expect(await v(await idp.mint({}, { header: { alg: "rs256" } }))).toBe(null);
  const noneUpper = await idp.mint({}, { header: { alg: "None" }, raw: s => s + "." });
  expect(await v(noneUpper)).toBe(null);
  // Key confusion: sign with HMAC keyed by the public key (both SPKI bytes and the JWK's n).
  for (const secret of [new Uint8Array(await idp.exportPublic("k1")), utf8(JSON.stringify(await idp.exportPublicJwk("k1")))]) {
    const hk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const tok = await idp.mint({}, { header: { alg: "HS256" }, raw: async s => s + "." + b64url(await crypto.subtle.sign("HMAC", hk, utf8(s))) });
    expect(await v(await tok)).toBe(null);
  }
});

test("malformed tokens are refused without throwing", async () => {
  for (const t of [undefined, null, 42, "", "a", "a.b", "a.b.c", "a.b.c.d", "!!.??.**", "e30.e30.", "W10.W10.AA", "x".repeat(20000)])
    expect(await v(t)).toBe(null);
});

test("JWKS: cached by kid; unknown kid refetched once, then refused; cooldown stops floods", async () => {
  const idp2 = await fakeIdp({ now });
  await idp2.addKey("a");
  const k = jwksCache({ fetch: idp2.fetch, now, cooldownMs: 30_000 });
  const vv = tok => verifyIdToken(tok, { clientId: CLIENT_ID, nonce: "n-1", keys: k, now });
  expect(await vv(await idp2.mint())).not.toBe(null);
  expect(idp2.jwksFetches).toBe(1);
  expect(await vv(await idp2.mint())).not.toBe(null);
  expect(idp2.jwksFetches).toBe(1);                               // cached
  clock.t += 60_000;
  // A kid the IdP doesn't have: one refetch, then refused.
  const forged = await idp2.mint({}, { kid: "ghost", signWith: "a" });
  expect(await vv(forged)).toBe(null);
  expect(idp2.jwksFetches).toBe(2);
  for (let i = 0; i < 20; i++) expect(await vv(forged)).toBe(null);
  expect(idp2.jwksFetches).toBe(2);                               // cooldown: no more fetches
  // Rotation: a new key appears; after the cooldown, its first token triggers one refetch and passes.
  await idp2.addKey("b");
  clock.t += 60_000;
  expect(await vv(await idp2.mint({}, { kid: "b" }))).not.toBe(null);
  expect(idp2.jwksFetches).toBe(3);
});

test("PKCE: RFC 7636 appendix B vector; verifiers are 43 chars", async () => {
  expect(await challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const ver = newVerifier();
  expect(ver).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(newVerifier()).not.toBe(ver);
  await expect(challengeS256("short")).rejects.toThrow();
});

test("sign-in flow: auth URL carries state, nonce, S256 challenge; finish exchanges with the verifier", async () => {
  const g = googleOidc({ clientId: CLIENT_ID, clientSecret: "not-a-secret", redirectUri: "http://localhost/cb", fetch: idp.fetch, now });
  const s = await g.begin();
  const u = new URL(s.url);
  expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  const q = Object.fromEntries(u.searchParams);
  expect(q).toMatchObject({ response_type: "code", client_id: CLIENT_ID, state: s.state, nonce: s.nonce, code_challenge_method: "S256" });
  expect(q.code_challenge).toBe(await challengeS256(s.verifier));
  expect(q.scope.split(" ")).toContain("openid");

  idp.codes.set("code-1", await idp.mint({ nonce: s.nonce }));
  expect(await g.finish({ code: "code-1", state: "wrong", expected: s })).toBe(null);    // state mismatch
  const id = await g.finish({ code: "code-1", state: s.state, expected: s });
  expect(id?.user).toBe("google:1001");
  expect(idp.tokenRequests.at(-1)).toMatchObject({ grant_type: "authorization_code", code: "code-1", code_verifier: s.verifier, client_id: CLIENT_ID });
  // A token minted for another sign-in (other nonce) fails.
  idp.codes.set("code-2", await idp.mint({ nonce: "someone-elses" }));
  expect(await g.finish({ code: "code-2", state: s.state, expected: s })).toBe(null);
  expect(await g.finish({ code: "unknown", state: s.state, expected: s })).toBe(null);
});

test("config without client id/secret is refused", () => {
  expect(() => googleOidc({ clientId: "", clientSecret: "x", redirectUri: "x", fetch: idp.fetch })).toThrow();
});

test("JWKS: concurrent sign-ins on a cold cache share one fetch and all pass", async () => {
  const idp3 = await fakeIdp({ now });
  await idp3.addKey("a");
  const k = jwksCache({ fetch: idp3.fetch, now });
  const toks = await Promise.all([1, 2, 3, 4].map(i => idp3.mint({ sub: "u" + i })));
  const ids = await Promise.all(toks.map(t => verifyIdToken(t, { clientId: CLIENT_ID, nonce: "n-1", keys: k, now })));
  expect(ids.map(i => i?.user)).toEqual(["google:u1", "google:u2", "google:u3", "google:u4"]);
  expect(idp3.jwksFetches).toBe(1);
});

test("JWKS: a failed fetch refuses, then retries after 5 s (not the full cooldown)", async () => {
  const idp4 = await fakeIdp({ now });
  await idp4.addKey("a");
  let down = true, calls = 0;
  const f = async (url, init) => { calls++; if (down) return new Response("", { status: 503 }); return idp4.fetch(url, init); };
  const k = jwksCache({ fetch: f, now });
  const tok = await idp4.mint();
  const vv = () => verifyIdToken(tok, { clientId: CLIENT_ID, nonce: "n-1", keys: k, now });
  expect(await vv()).toBe(null);
  expect(await vv()).toBe(null);
  expect(calls).toBe(1);                       // no hammering while down
  down = false;
  clock.t += 6_000;
  expect(await vv()).not.toBe(null);
  expect(calls).toBe(2);
});

// ---- Fix round (p5-authv) ----

const cold = (fetch, o = {}) => jwksCache({ fetch, now, ...o });
const vk = (tok, k) => verifyIdToken(tok, { clientId: CLIENT_ID, nonce: "n-1", keys: k, now });

test("M1: email only when Google is authoritative (gmail.com, or verified AND hd)", async () => {
  expect((await v(await idp.mint({ email: "cfo@partner.example", hd: undefined }))).email).toBe(null);
  expect((await v(await idp.mint({ email: "Gus@Gmail.com", hd: undefined }))).email).toBe("gus@gmail.com");
  expect((await v(await idp.mint({ email: "ann@acme.com", hd: "acme.com" }))).email).toBe("ann@acme.com");
  expect((await v(await idp.mint({ email: "gus@gmail.com", hd: undefined, email_verified: false }))).email).toBe(null);
  expect((await v(await idp.mint({ email: "x@gmail.com.evil.example", hd: undefined }))).email).toBe(null);
});

test("M2: keys expire at Cache-Control max-age (capped at 1 h); a withdrawn key stops verifying", async () => {
  const i = await fakeIdp({ now }); await i.addKey("a"); await i.addKey("b");
  i.cacheControl = "public, max-age=120, must-revalidate";
  const k = cold(i.fetch);
  const tok = await i.mint({}, { kid: "b" });
  expect(await vk(tok, k)).not.toBe(null);
  expect(i.jwksFetches).toBe(1);
  i.removeKey("b");
  clock.t += 60_000;
  expect(await vk(await i.mint({}, { kid: "a" }), k)).not.toBe(null);   // still fresh: no fetch
  expect(i.jwksFetches).toBe(1);
  clock.t += 61_000;
  expect(await vk(await i.mint({}, { kid: "a" }), k)).not.toBe(null);   // stale: refetched
  expect(i.jwksFetches).toBe(2);
  expect(await vk(tok, k)).toBe(null);                                   // b is gone
  // A huge max-age is capped at 1 h.
  i.cacheControl = "max-age=604800";
  clock.t += 3_600_000;
  await vk(await i.mint({}, { kid: "a" }), k);
  const n = i.jwksFetches;
  clock.t += 3_601_000;
  await vk(await i.mint({}, { kid: "a" }), k);
  expect(i.jwksFetches).toBe(n + 1);
});

test("M3: a 200 with no usable keys is a failed fetch; the old keys stay", async () => {
  const i = await fakeIdp({ now }); await i.addKey("a");
  let body = null, bodyFetches = 0;
  const f = async (url, init) => (body ? (bodyFetches++, Response.json(body)) : i.fetch(url, init));
  const k = cold(f);
  const tok = await i.mint();
  expect(await vk(tok, k)).not.toBe(null);
  for (const b of [{}, { keys: [] }, { keys: [{ kty: "EC", kid: "x" }] }]) {
    body = b;
    clock.t += 3_700_000;                                   // stale: forces a refetch
    expect(await vk(await i.mint(), k)).not.toBe(null);                // old key kept
  }
  expect(bodyFetches).toBe(3);                              // each stale lookup did refetch
});

test("M4: a JWKS fetch that never answers times out; sign-in recovers once the network does", async () => {
  const i = await fakeIdp({ now }); await i.addKey("a");
  let hang = true;
  const f = (url, init) => hang
    ? new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal.reason)))
    : i.fetch(url, init);
  const k = cold(f, { timeoutMs: 30 });
  const tok = await i.mint();
  expect(await vk(tok, k)).toBe(null);                      // timed out, not pending forever
  hang = false;
  clock.t += 6_000;                                         // past the retry window
  expect(await vk(tok, k)).not.toBe(null);
});

test("M4: the token request has a timeout too", async () => {
  const f = (url, init) => url.includes("token")
    ? new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal.reason)))
    : idp.fetch(url, init);
  const g = googleOidc({ clientId: CLIENT_ID, clientSecret: "x", redirectUri: "http://l/cb", fetch: f, now, timeoutMs: 30 });
  const s = await g.begin();
  expect(await g.finish({ code: "c", state: s.state, expected: s })).toBe(null);
});

test("M7: finish refuses unless state, nonce and verifier are non-empty strings", async () => {
  const g = googleOidc({ clientId: CLIENT_ID, clientSecret: "x", redirectUri: "http://l/cb", fetch: idp.fetch, now });
  const s = await g.begin();
  idp.codes.set("code-m7", await idp.mint({ nonce: s.nonce }));
  const before = idp.tokenRequests.length;
  for (const bad of [{ ...s, state: "" }, { ...s, verifier: undefined }, { ...s, verifier: "" }, { ...s, nonce: "" }, { ...s, nonce: 1 }])
    expect(await g.finish({ code: "code-m7", state: bad.state, expected: bad })).toBe(null);
  expect(idp.tokenRequests.length).toBe(before);           // nothing sent to Google
  expect((await g.finish({ code: "code-m7", state: s.state, expected: s }))?.user).toBe("google:1001");
});

test("L3: a long name is capped at sign-in", async () => {
  expect((await v(await idp.mint({ name: "x".repeat(5000) }))).name.length).toBe(200);
});

test("L6: exp must be after iat; an iat older than a day is refused", async () => {
  const t = Math.floor(clock.t / 1000);
  expect(await v(await idp.mint({ iat: t, exp: t }))).toBe(null);
  expect(await v(await idp.mint({ iat: t, exp: t - 10 }))).toBe(null);
  expect(await v(await idp.mint({ iat: t - 86_400 * 3650, exp: t + 3600 }))).toBe(null);
  expect(await v(await idp.mint({ iat: t - 3000, exp: t + 600 }))).not.toBe(null);
});

test("L7: hd is trimmed", async () => {
  expect((await v(await idp.mint({ hd: "  Acme.com " }))).domain).toBe("acme.com");
  expect((await v(await idp.mint({ hd: "   " }))).domain).toBe(null);
});

// ---- Fix round (p5-fix) ----

test("p5-fix 2: with hd, the email counts only if its domain IS hd (case-insensitive, trimmed)", async () => {
  expect((await v(await idp.mint({ email: "x@other.com", hd: "acme.com" }))).email).toBe(null);
  expect((await v(await idp.mint({ email: "x@sub.acme.com", hd: "acme.com" }))).email).toBe(null);
  expect((await v(await idp.mint({ email: "x@other.com", hd: "acme.com" }))).domain).toBe("acme.com");   // still a member
  expect((await v(await idp.mint({ email: "X@ACME.com", hd: "  Acme.COM " }))).email).toBe("x@acme.com");
  expect((await v(await idp.mint({ email: "x@acme.com", hd: "acme.com", email_verified: false }))).email).toBe(null);
  expect((await v(await idp.mint({ email: "gus@gmail.com", hd: "acme.com" }))).email).toBe("gus@gmail.com");
});
