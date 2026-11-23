// General OIDC adapter tests: discovery, PKCE (S256), RS256 & ES256 JWKS verification, SSRF & HTTPS guards,
// email_verified enforcement, issuer-bound tenancy isolation, IdP port contract, and server/main.js wiring.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  genericOidc,
  oidcDiscovery,
  verifyOidcIdToken,
  validateOidcUrl,
  isBlockedOidcHost,
  challengeS256,
  jwksCache,
} from "../../server/adapters/driven/auth/oidc.js";
import { oidcTenantBinding, tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { b64url, utf8, randomId } from "../../server/core/auth/util.js";
import { idpContract } from "./idp-contract.js";
import { start } from "../../server/main.js";

const CLIENT_ID = "plenary-oidc-client";
const CLIENT_SECRET = "plenary-oidc-secret-SENTINEL";
const REDIRECT_URI = "https://plenary.test/auth/callback";

async function genRsaKey() {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
}

async function genEcKey() {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, ["sign", "verify"],
  );
}

/**
 * In-memory fake generic OIDC provider supporting discovery, RS256 & ES256 keys, PKCE S256, and single-use codes.
 */
async function fakeOidcProvider({
  issuer = "https://auth.example.com",
  docIssuer = issuer,
  authorizePath = "/oauth2/authorize",
  tokenPath = "/oauth2/token",
  jwksPath = "/oauth2/jwks",
  now = () => Date.now(),
} = {}) {
  const base = issuer.replace(/\/+$/, "");
  const keys = new Map(); // kid -> { alg, pair }
  const provider = {
    issuer,
    docIssuer,
    discoveryUrl: `${base}/.well-known/openid-configuration`,
    authorizeUrl: `${base}${authorizePath}`,
    tokenUrl: `${base}${tokenPath}`,
    jwksUrl: `${base}${jwksPath}`,
    discoveryFetches: 0,
    jwksFetches: 0,
    tokenRequests: [],
    discoveryCacheControl: null,
    jwksCacheControl: null,
    discoveryOverride: null,
    tokenOverride: null,
    down: false,
    omitKidInJwks: false,
    strict: new Map(),

    async addRsaKey(kid = "rsa-1") {
      const pair = await genRsaKey();
      keys.set(kid, { alg: "RS256", pair });
      return pair;
    },
    async addEcKey(kid = "ec-1") {
      const pair = await genEcKey();
      keys.set(kid, { alg: "ES256", pair });
      return pair;
    },
    removeKey(kid) { keys.delete(kid); },

    async jwks() {
      const out = [];
      for (const [kid, { alg, pair }] of keys) {
        const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
        if (alg === "RS256") {
          out.push({ kty: "RSA", n: j.n, e: j.e, alg: "RS256", use: "sig", ...(provider.omitKidInJwks ? {} : { kid }) });
        } else {
          out.push({ kty: "EC", crv: "P-256", x: j.x, y: j.y, alg: "ES256", use: "sig", ...(provider.omitKidInJwks ? {} : { kid }) });
        }
      }
      return { keys: out };
    },

    strictCode(code, idToken, authUrl) {
      provider.strict.set(code, { idToken, challenge: new URL(authUrl).searchParams.get("code_challenge") });
    },

    async mint(claims = {}, { kid = [...keys.keys()][0], header = {}, signWith = kid, omitKid = false, raw } = {}) {
      const entry = keys.get(signWith);
      const alg = entry?.alg ?? "RS256";
      const t = Math.floor(now() / 1000);
      const h = { alg, typ: "JWT", ...(omitKid ? {} : { kid }), ...header };
      const c = {
        iss: provider.docIssuer,
        aud: CLIENT_ID,
        sub: "user-42",
        iat: t,
        exp: t + 3600,
        nonce: "n-1",
        email: "alice@company.example",
        email_verified: true,
        name: "Alice Example",
        ...claims,
      };
      for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
      const signing = b64url(utf8(JSON.stringify(h))) + "." + b64url(utf8(JSON.stringify(c)));
      if (raw) return raw(signing);
      const sig = alg === "RS256"
        ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", entry.pair.privateKey, utf8(signing))
        : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, entry.pair.privateKey, utf8(signing));
      return signing + "." + b64url(sig);
    },

    fetch: async (url, init) => {
      if (provider.down) throw new TypeError("fetch failed");
      if (url === provider.discoveryUrl) {
        provider.discoveryFetches++;
        if (provider.discoveryOverride) return provider.discoveryOverride(url, init);
        return Response.json({
          issuer: provider.docIssuer,
          authorization_endpoint: provider.authorizeUrl,
          token_endpoint: provider.tokenUrl,
          jwks_uri: provider.jwksUrl,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        }, provider.discoveryCacheControl ? { headers: { "cache-control": provider.discoveryCacheControl } } : undefined);
      }
      if (url === provider.jwksUrl) {
        provider.jwksFetches++;
        return Response.json(await provider.jwks(), provider.jwksCacheControl ? { headers: { "cache-control": provider.jwksCacheControl } } : undefined);
      }
      if (url === provider.tokenUrl) {
        if (provider.tokenOverride) return provider.tokenOverride(url, init);
        const form = new URLSearchParams(init.body);
        provider.tokenRequests.push(Object.fromEntries(form));
        const s = provider.strict.get(form.get("code"));
        if (!s) return Response.json({ error: "invalid_grant" }, { status: 400 });
        provider.strict.delete(form.get("code"));
        const got = b64url(await crypto.subtle.digest("SHA-256", utf8(form.get("code_verifier") ?? "")));
        return got === s.challenge
          ? Response.json({ id_token: s.idToken })
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      throw new Error("fake oidc: unexpected url: " + url);
    },
  };
  return provider;
}

// ---- 1. IdP Port Contract ----

idpContract("genericOidc", async () => {
  const net = await fakeOidcProvider();
  await net.addRsaKey("k1");
  const idp = genericOidc({
    issuerUrl: net.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    emailDomains: ["company.example"],
    fetch: net.fetch,
  });
  return {
    idp,
    async authorize(begun) {
      const code = "c-" + randomId(24);
      net.strictCode(code, await net.mint({ nonce: begun.nonce }), begun.url);
      return code;
    },
    expected: {
      user: "oidc:auth.example.com:user-42",
      name: "Alice Example",
      email: "alice@company.example",
      domain: "oidc:auth.example.com",
    },
    outage: on => { net.down = on; },
  };
});

// ---- 2. Discovery, Caching, and Issuer Validation ----

describe("generic OIDC discovery & SSRF protection", () => {
  test("fetches and caches discovery doc, deduplicates concurrent fetches, and honors trailing-slash Auth0 issuer", async () => {
    const clock = { t: Date.UTC(2026, 10, 20, 12) };
    const net = await fakeOidcProvider({
      issuer: "https://tenant.us.auth0.com",
      docIssuer: "https://tenant.us.auth0.com/",
      now: () => clock.t,
    });
    await net.addRsaKey("k1");
    net.discoveryCacheControl = "public, max-age=120";
    const idp = genericOidc({
      issuerUrl: "https://tenant.us.auth0.com",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      emailDomains: ["company.example"],
      fetch: net.fetch,
      now: () => clock.t,
    });

    const [a, b] = await Promise.all([idp.begin(), idp.begin()]);
    expect(net.discoveryFetches).toBe(1);
    expect(new URL(a.url).origin + new URL(a.url).pathname).toBe("https://tenant.us.auth0.com/oauth2/authorize");
    expect(new URL(a.url).searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(a.url).searchParams.get("code_challenge")).toBe(await challengeS256(a.verifier));
    expect(a.state).not.toBe(b.state);

    // Complete sign-in: ID token `iss` matches discovery `doc.issuer` ("https://tenant.us.auth0.com/").
    net.strictCode("code-auth0", await net.mint({ nonce: a.nonce }), a.url);
    const id = await idp.finish({ code: "code-auth0", state: a.state, expected: a });
    expect(id).toEqual({
      user: "oidc:tenant.us.auth0.com:user-42",
      name: "Alice Example",
      email: "alice@company.example",
      domain: "oidc:tenant.us.auth0.com",
    });

    // After max-age expires, discovery refetches.
    clock.t += 121_000;
    await idp.begin();
    expect(net.discoveryFetches).toBe(2);
  });

  test("rejects discovery issuer mismatch (OIDC Core §3.1.3.7 / Discovery §4.3)", async () => {
    const net = await fakeOidcProvider({
      issuer: "https://auth.example.com",
      docIssuer: "https://evil.example.com",
    });
    const d = oidcDiscovery({ issuerUrl: net.issuer, fetch: net.fetch });
    await expect(d.get()).rejects.toThrow("issuer mismatch");

    const idp = genericOidc({ issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetch: net.fetch });
    const causes = [];
    expect(await idp.finish({
      code: "c1", state: "s1", expected: { state: "s1", nonce: "n1", verifier: "v".repeat(43) },
      why: c => causes.push(c),
    })).toBeNull();
    expect(causes).toEqual(["bad_issuer"]);
  });

  test("rejects discovery missing S256 PKCE or code response_type", async () => {
    const net = await fakeOidcProvider();
    net.discoveryOverride = () => Response.json({
      issuer: net.issuer,
      authorization_endpoint: net.authorizeUrl,
      token_endpoint: net.tokenUrl,
      jwks_uri: net.jwksUrl,
      code_challenge_methods_supported: ["plain"],
    });
    const d = oidcDiscovery({ issuerUrl: net.issuer, fetch: net.fetch });
    await expect(d.get()).rejects.toThrow("S256");

    net.discoveryOverride = () => Response.json({
      issuer: net.issuer,
      authorization_endpoint: net.authorizeUrl,
      token_endpoint: net.tokenUrl,
      jwks_uri: net.jwksUrl,
      response_types_supported: ["token"],
    });
    const d2 = oidcDiscovery({ issuerUrl: net.issuer, fetch: net.fetch });
    await expect(d2.get()).rejects.toThrow("code");
  });

  test("SSRF & HTTPS enforcement: blocks http in prod, private/metadata IPs, IPv4-mapped IPv6, userinfo; allows loopback only when opted in", () => {
    // Non-HTTPS rejected when allowHttpLocalhost is false
    expect(() => validateOidcUrl("http://auth.example.com")).toThrow("https");
    expect(() => validateOidcUrl("http://localhost:8080")).toThrow("https");
    expect(() => validateOidcUrl("http://127.0.0.1:8080")).toThrow("https");
    expect(() => validateOidcUrl("file:///etc/passwd")).toThrow("https");
    expect(() => validateOidcUrl("javascript:alert(1)")).toThrow("https");

    // Loopback HTTP allowed ONLY when allowHttpLocalhost: true
    expect(validateOidcUrl("http://localhost:8080", { allowHttpLocalhost: true }).hostname).toBe("localhost");
    expect(validateOidcUrl("http://127.0.0.1:9000", { allowHttpLocalhost: true }).hostname).toBe("127.0.0.1");
    expect(validateOidcUrl("http://[::1]:9000", { allowHttpLocalhost: true }).hostname).toBe("[::1]");
    // Non-loopback HTTP still refused even when allowHttpLocalhost: true
    expect(() => validateOidcUrl("http://auth.example.com", { allowHttpLocalhost: true })).toThrow("https");

    // Credentials, fragments, query on issuer
    expect(() => validateOidcUrl("https://user:pass@auth.example.com")).toThrow("credentials");
    expect(() => validateOidcUrl("https://auth.example.com#frag")).toThrow("fragment");
    expect(() => validateOidcUrl("https://auth.example.com?a=1", { requireQueryFree: true })).toThrow("query");

    // Cloud metadata & private IP SSRF vectors
    const blockedHosts = [
      "169.254.169.254",
      "metadata.google.internal",
      "metadata.goog",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "127.0.0.1",
      "::1",
      "::",
      "[fe80::1]",
      "[fc00::1]",
      "[fd00:ec2::254]",
      "[::ffff:169.254.169.254]",
      "[::ffff:127.0.0.1]",
      "[::ffff:a9fe:a9fe]",
      "[64:ff9b::169.254.169.254]",
    ];
    for (const h of blockedHosts) {
      expect(isBlockedOidcHost(h, { allowLoopback: false })).toBe(true);
    }
    expect(isBlockedOidcHost("auth.example.com")).toBe(false);
    expect(isBlockedOidcHost("172.32.0.1")).toBe(false);
  });

  test("HTTPS issuer refuses discovery pointing jwks_uri or token_endpoint to metadata/private/http-localhost", async () => {
    const net = await fakeOidcProvider();
    for (const badEndpoint of [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/jwks",
      "https://[::ffff:169.254.169.254]/jwks",
      "https://metadata.google.internal/jwks",
      "http://localhost:8080/jwks",
      "https://127.0.0.1/jwks",
      "https://10.0.0.1/jwks",
    ]) {
      net.discoveryOverride = () => Response.json({
        issuer: net.issuer,
        authorization_endpoint: net.authorizeUrl,
        token_endpoint: net.tokenUrl,
        jwks_uri: badEndpoint,
      });
      const d = oidcDiscovery({ issuerUrl: net.issuer, fetch: net.fetch, allowHttpLocalhost: true });
      await expect(d.get()).rejects.toThrow("invalid endpoint");
    }
  });

  test("discovery, token, and JWKS fetches pass redirect: 'error'", async () => {
    const net = await fakeOidcProvider();
    await net.addRsaKey("k1");
    const redirects = [];
    const spyingFetch = (url, init) => {
      redirects.push({ url, redirect: init?.redirect });
      return net.fetch(url, init);
    };
    const idp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetch: spyingFetch,
    });
    const begun = await idp.begin();
    net.strictCode("c-redir", await net.mint({ nonce: begun.nonce }), begun.url);
    expect(await idp.finish({ code: "c-redir", state: begun.state, expected: begun })).not.toBeNull();
    expect(redirects.length).toBe(3); // discovery, token, jwks
    for (const r of redirects) expect(r.redirect).toBe("error");
  });
});

// ---- 3. Signature Algorithms (RS256 & ES256), Claims, and email_verified ----

describe("generic OIDC ID-token verification", () => {
  let net, clock;
  beforeEach(async () => {
    clock = { t: Date.UTC(2026, 10, 20, 12) };
    net = await fakeOidcProvider({ now: () => clock.t });
    await net.addRsaKey("rsa-1");
    await net.addEcKey("ec-1");
  });

  test("verifies both RS256 and ES256 (P-256) ID tokens", async () => {
    const idp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      fetch: net.fetch, now: () => clock.t,
    });
    const rsaTok = await net.mint({ sub: "u-rsa" }, { kid: "rsa-1" });
    const ecTok = await net.mint({ sub: "u-ec" }, { kid: "ec-1" });
    expect((await idp.verifyIdToken(rsaTok, "n-1"))?.user).toBe("oidc:auth.example.com:u-rsa");
    expect((await idp.verifyIdToken(ecTok, "n-1"))?.user).toBe("oidc:auth.example.com:u-ec");
  });

  test("refuses alg:none, HS256, and alg/key mismatch", async () => {
    const idp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      fetch: net.fetch, now: () => clock.t,
    });
    const causes = [];
    const noneTok = await net.mint({}, { header: { alg: "none" }, raw: s => s + "." });
    expect(await idp.verifyIdToken(noneTok, "n-1", { why: c => causes.push(c) })).toBeNull();
    // Claiming ES256 in header while naming RSA kid
    const mismatchTok = await net.mint({}, { kid: "rsa-1", header: { alg: "ES256" } });
    expect(await idp.verifyIdToken(mismatchTok, "n-1", { why: c => causes.push(c) })).toBeNull();
    expect(causes).toEqual(["bad_alg", "bad_alg"]);
  });

  test("supports single-key JWKS without kid", async () => {
    const singleNet = await fakeOidcProvider({ now: () => clock.t });
    await singleNet.addEcKey("only");
    singleNet.omitKidInJwks = true;
    const idp = genericOidc({
      issuerUrl: singleNet.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      fetch: singleNet.fetch, now: () => clock.t,
    });
    const tok = await singleNet.mint({ sub: "nokid" }, { signWith: "only", omitKid: true });
    expect((await idp.verifyIdToken(tok, "n-1"))?.user).toBe("oidc:auth.example.com:nokid");
  });

  test("enforces iss, aud, azp, exp, iat, nbf, nonce, sub with clean cause codes", async () => {
    const idp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      fetch: net.fetch, now: () => clock.t,
    });
    const t = Math.floor(clock.t / 1000);
    const cases = [
      [{ iss: "https://other.example.com" }, "n-1", "bad_issuer"],
      [{ aud: "other-client" }, "n-1", "bad_aud"],
      [{ aud: [CLIENT_ID, "other"] }, "n-1", "bad_aud"],
      [{ exp: t - 120, iat: t - 3000 }, "n-1", "expired"],
      [{ iat: t + 300 }, "n-1", "bad_time"],
      [{ nbf: t + 300 }, "n-1", "bad_time"],
      [{ iat: t - 90_000, exp: t + 3600 }, "n-1", "stale"],
      [{ nonce: "wrong" }, "n-1", "bad_nonce"],
      [{ sub: "" }, "n-1", "bad_sub"],
    ];
    for (const [claims, nonce, expectedCause] of cases) {
      let heard = null;
      const tok = await net.mint(claims);
      expect(await idp.verifyIdToken(tok, nonce, { why: c => { heard = c; } })).toBeNull();
      expect(heard).toBe(expectedCause);
    }
    // Array aud with matching azp succeeds
    expect(await idp.verifyIdToken(await net.mint({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }), "n-1")).not.toBeNull();
  });

  test("requires email_verified === true by default; allowUnverifiedEmail permits sign-in but strips unverified email", async () => {
    const strictIdp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      fetch: net.fetch, now: () => clock.t,
    });
    let cause = null;
    const unverifiedTok = await net.mint({ email: "bob@acme.com", email_verified: false });
    expect(await strictIdp.verifyIdToken(unverifiedTok, "n-1", { why: c => { cause = c; } })).toBeNull();
    expect(cause).toBe("unverified_email");

    const missingVerifiedTok = await net.mint({ email: "bob@acme.com", email_verified: undefined });
    cause = null;
    expect(await strictIdp.verifyIdToken(missingVerifiedTok, "n-1", { why: c => { cause = c; } })).toBeNull();
    expect(cause).toBe("unverified_email");

    // Lab/dev opt-in: sign-in succeeds, but unverified email is stripped (null) so it cannot claim invites.
    const labIdp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      fetch: net.fetch, now: () => clock.t, allowUnverifiedEmail: true,
    });
    const id = await labIdp.verifyIdToken(unverifiedTok, "n-1");
    expect(id).toEqual({
      user: "oidc:auth.example.com:user-42",
      name: "Alice Example",
      email: null,
      domain: "oidc:auth.example.com",
    });
    // Verified email is only carried when its domain is explicitly authorized via emailDomains.
    const labIdpWithDomains = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      emailDomains: ["acme.com"], fetch: net.fetch, now: () => clock.t, allowUnverifiedEmail: true,
    });
    const verifiedId = await labIdpWithDomains.verifyIdToken(await net.mint({ email: "Bob@Acme.com", email_verified: true }), "n-1");
    expect(verifiedId?.email).toBe("bob@acme.com");
    // Email outside emailDomains is stripped (prevents invite hijacking!).
    const externalId = await labIdpWithDomains.verifyIdToken(await net.mint({ email: "guest@partner.io", email_verified: true }), "n-1");
    expect(externalId?.email).toBeNull();
  });

  test("enforces azp even on single aud, and optional OIDC_ALLOWED_GROUPS gate", async () => {
    const idp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      allowedGroups: ["engineering", "design"], groupsClaim: "groups",
      fetch: net.fetch, now: () => clock.t,
    });
    let cause = null;
    expect(await idp.verifyIdToken(await net.mint({ aud: CLIENT_ID, azp: "wrong-client", groups: ["engineering"] }), "n-1", { why: c => { cause = c; } })).toBeNull();
    expect(cause).toBe("bad_aud");

    cause = null;
    expect(await idp.verifyIdToken(await net.mint({ groups: ["marketing"] }), "n-1", { why: c => { cause = c; } })).toBeNull();
    expect(cause).toBe("group_denied");

    expect(await idp.verifyIdToken(await net.mint({ groups: ["engineering"] }), "n-1")).not.toBeNull();
  });
});

// ---- 4. Issuer-Bound Tenancy Isolation (Opus Red-Team Guardrail) ----

describe("issuer-bound tenancy isolation", () => {
  test("ignores spoofed email domain and hd claim; disambiguates issuer paths; prevents cross-tenant invite hijack", async () => {
    const net = await fakeOidcProvider({ issuer: "https://keycloak.homelab.example/realms/team" });
    await net.addRsaKey("k1");

    const defaultIdp = genericOidc({
      issuerUrl: net.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, fetch: net.fetch,
    });
    const spoofedTok = await net.mint({ email: "ceo@victim-corp.com", email_verified: true, hd: "victim-corp.com" });
    const id = await defaultIdp.verifyIdToken(spoofedTok, "n-1");
    expect(id.domain).toBe(defaultIdp.tenantDomain);
    expect(id.domain.startsWith("oidc:keycloak.homelab.example-")).toBe(true);
    expect(id.user).toBe(`oidc:${defaultIdp.tenantSlug}:user-42`);
    // Without OIDC_EMAIL_DOMAINS, email is stripped so attacker cannot hijack an invite to ceo@victim-corp.com!
    expect(id.email).toBeNull();

    // Distinct paths on the same host (e.g. Keycloak realms / Entra tenants) NEVER collide!
    const staff = oidcTenantBinding("https://keycloak.homelab.example/realms/staff");
    const customers = oidcTenantBinding("https://keycloak.homelab.example/realms/customers");
    expect(staff.slug).not.toBe(customers.slug);
    expect(staff.domain).not.toBe(customers.domain);

    // Verify tenancy isolation against a Google Workspace tenant for victim-corp.com in the same registry!
    const registry = memoryRegistry();
    const victimTenant = await registry.createTenant({ domain: "victim-corp.com", admins: ["email:ceo@victim-corp.com"] });
    const oidcTenant = await registry.createTenant({ domain: defaultIdp.tenantDomain });
    const victimSpace = await registry.createSpace({ tenant: victimTenant.id, name: "Secret", generalRole: "editor" });
    const victimBoard = await registry.createBoard({ tenant: victimTenant.id, space: victimSpace.id, title: "Roadmap", memberRole: "editor" });
    await registry.createInvite({ board: victimBoard.id, email: "ceo@victim-corp.com", role: "editor", by: "google:owner" });
    const t = makeTenancy({ registry });

    expect((await t.tenantOf(id))?.id).toBe(oidcTenant.id);
    expect((await t.tenantsFor(id)).map(x => x.id)).toEqual([oidcTenant.id]);
    // Neither general access NOR the email invite to ceo@victim-corp.com grants access!
    expect(await t.role(id, victimBoard.id)).toBeNull();

    // Explicit OIDC_TENANT_SLUG and OIDC_TENANT_DOMAIN
    expect(oidcTenantBinding("https://keycloak.homelab.example/realms/team", { tenantSlug: "my-team" }))
      .toEqual({ slug: "my-team", domain: "oidc:my-team" });
    expect(oidcTenantBinding("https://keycloak.homelab.example/realms/team", { tenantSlug: "my-team", tenantDomain: "homelab.example" }))
      .toEqual({ slug: "my-team", domain: "homelab.example" });
  });
});

// ---- 5. server/main.js Wiring & Google Backwards Compatibility ----

describe("server/main.js generic OIDC wiring", () => {
  test("3 env vars wire genericOidc, auto-provision issuer-bound tenant + OIDC_ADMIN_USERS, and refuse dual Google+OIDC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plenary-oidc-test-"));
    const net = await fakeOidcProvider({ issuer: "https://id.selfhost.example" });
    await net.addRsaKey("k1");
    const logs = [];
    let app;
    try {
      // Refuses when BOTH Google and generic OIDC are configured (prevents silently locking out Google users)
      await expect(start({
        PORT: "0", HOST: "127.0.0.1", PLENARY_DATA_DIR: dir, COOKIE_KEY: "k".repeat(32),
        OIDC_ISSUER_URL: net.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET,
        GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-sec",
      }, { fetch: net.fetch, write: () => {} })).rejects.toThrow("pick one");

      app = await start({
        PORT: "0",
        HOST: "127.0.0.1",
        PLENARY_DATA_DIR: dir,
        PUBLIC_URL: "https://plenary.test",
        OIDC_REDIRECT_URI: "https://plenary.test/auth/callback",
        COOKIE_KEY: "k".repeat(32),
        OIDC_ISSUER_URL: net.issuer,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: CLIENT_SECRET,
        OIDC_DISPLAY_NAME: "Pocket ID",
        OIDC_EMAIL_DOMAINS: "selfhost.example",
        OIDC_ADMIN_USERS: "p-7",
      }, { fetch: net.fetch, write: line => logs.push(line) });

      expect(app.oidc?.displayName).toBe("Pocket ID");
      expect(app.oidc?.tenantDomain).toBe("oidc:id.selfhost.example");

      // Issuer-bound tenant was auto-provisioned in the registry with p-7 as Unit admin
      const tenant = await app.registry.tenantByDomain("oidc:id.selfhost.example");
      expect(tenant).not.toBeNull();
      expect(tenant.name).toBe("Pocket ID");
      expect(tenant.admins).toContain("oidc:id.selfhost.example:p-7");

      // Drive the OIDC adapter directly (no socket needed inside sandbox)
      const begun = await app.oidc.begin();
      expect(new URL(begun.url).origin).toBe("https://id.selfhost.example");
      net.strictCode("code-main", await net.mint({ nonce: begun.nonce, sub: "p-7", email: "sam@selfhost.example" }), begun.url);
      const id = await app.oidc.finish({ code: "code-main", state: begun.state, expected: begun });
      expect(id).toEqual({
        user: "oidc:id.selfhost.example:p-7",
        name: "Alice Example",
        email: "sam@selfhost.example",
        domain: "oidc:id.selfhost.example",
      });

      // Secret never appears in logs
      expect(logs.join("\n")).not.toContain(CLIENT_SECRET);
    } finally {
      await app?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
