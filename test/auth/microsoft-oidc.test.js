// Microsoft Entra ID OIDC adapter, simultaneous multi-provider auth (Google + Microsoft),
// corporate domain auto-org provisioning (e.g. alaskaair.com), and web provider discovery tests.
import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  googleOidc,
  microsoftOidc,
  microsoftEndpoints,
  verifyMicrosoftIdToken,
  MICROSOFT_CONSUMER_TID,
  challengeS256,
  jwksCache,
} from "../../server/adapters/driven/auth/oidc.js";
import { httpRoutes, LOGIN_COOKIE, EXCHANGE_COOKIE } from "../../server/adapters/driving/auth-http.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { b64url, utf8 } from "../../server/core/auth/util.js";
import { start } from "../../server/main.js";
import { fetchAuthProviders } from "../../web/adapters/auth/http.js";
import { fakeIdp, CLIENT_ID as GOOGLE_CLIENT_ID } from "./fake-idp.js";

const ORIGIN = "https://plenary.test";
const APP = "https://plenary.test/";
const MS_CLIENT_ID = "ms-app-client-id-1234";
const MS_CLIENT_SECRET = "ms-client-secret-SENTINEL";
const ALASKA_TID = "11111111-2222-3333-4444-555555555555";
const OTHER_TID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function genRsaKey() {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
}

/**
 * In-memory fake Microsoft Entra ID v2.0 provider supporting `/common`, `/organizations`, or a specific tenant GUID,
 * PKCE S256 verification, RS256 JWKS (without `alg`, matching real Entra ID), and single-use codes.
 */
async function fakeMicrosoftIdp({ now = () => Date.now() } = {}) {
  const keys = new Map();
  const codes = new Map(); // code -> { idToken, challenge? }
  const tokenRequests = [];
  const idp = {
    jwksFetches: 0,
    tokenRequests,
    codes,

    async addKey(kid = "ms-k1") {
      const pair = await genRsaKey();
      keys.set(kid, pair);
      return pair;
    },

    async jwks() {
      const out = [];
      for (const [kid, pair] of keys) {
        const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
        // Entra ID discovery/v2.0/keys omits `alg` on RSA signing keys.
        out.push({ kty: "RSA", use: "sig", kid, n: j.n, e: j.e });
      }
      return { keys: out };
    },

    async mint(claims = {}, { kid = [...keys.keys()][0], header = {}, signWith = kid, raw } = {}) {
      const pair = keys.get(signWith);
      const t = Math.floor(now() / 1000);
      const tid = claims.tid === undefined ? ALASKA_TID : claims.tid;
      const h = { alg: "RS256", typ: "JWT", kid, ...header };
      const c = {
        iss: typeof tid === "string" ? `https://login.microsoftonline.com/${tid}/v2.0` : undefined,
        aud: MS_CLIENT_ID,
        sub: "ms-sub-001",
        oid: "ms-oid-001",
        tid,
        iat: t,
        nbf: t,
        exp: t + 3600,
        nonce: "n-1",
        name: "Alex Pilot",
        email: "alex@alaskaair.com",
        preferred_username: "alex@alaskaair.com",
        ...claims,
      };
      for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
      const signing = b64url(utf8(JSON.stringify(h))) + "." + b64url(utf8(JSON.stringify(c)));
      if (raw) return raw(signing);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, utf8(signing)));
      return `${signing}.${b64url(sig)}`;
    },

    strictCode(code, idToken, authUrl) {
      codes.set(code, { idToken, challenge: new URL(authUrl).searchParams.get("code_challenge") });
    },

    fetch: async (url, init = {}) => {
      const u = String(url);
      if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/discovery\/v2\.0\/keys$/.test(u)) {
        idp.jwksFetches++;
        return Response.json(await idp.jwks(), { headers: { "cache-control": "public, max-age=3600" } });
      }
      if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/.test(u)) {
        const params = Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
        tokenRequests.push({ url: u, ...params });
        if (params.client_id !== MS_CLIENT_ID || params.client_secret !== MS_CLIENT_SECRET) {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        const entry = codes.get(params.code);
        if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(params.code);
        if (entry.challenge) {
          if (!params.code_verifier || (await challengeS256(params.code_verifier)) !== entry.challenge) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
        }
        return Response.json({ id_token: entry.idToken, token_type: "Bearer", expires_in: 3600 });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return idp;
}

describe("microsoftOidc + verifyMicrosoftIdToken", () => {
  let msIdp;
  const clock = { t: Date.UTC(2026, 10, 23, 12) };
  const now = () => clock.t;

  beforeAll(async () => {
    msIdp = await fakeMicrosoftIdp({ now });
    await msIdp.addKey("ms-k1");
  });

  test("microsoftEndpoints validates tenant segments and builds v2.0 URLs", () => {
    expect(microsoftEndpoints()).toEqual({
      tenant: "common",
      authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    });
    expect(microsoftEndpoints("organizations").tenant).toBe("organizations");
    expect(microsoftEndpoints(ALASKA_TID.toUpperCase()).tenant).toBe(ALASKA_TID);
    for (const bad of ["../evil", "common?x=1", "not-a-guid", "foo/bar"]) {
      expect(() => microsoftEndpoints(bad)).toThrow("invalid Microsoft tenant id");
    }
  });

  test("multi-tenant `common`: full PKCE S256 + JWKS flow with dynamic tid issuer", async () => {
    const ms = microsoftOidc({
      clientId: MS_CLIENT_ID,
      clientSecret: MS_CLIENT_SECRET,
      redirectUri: ORIGIN + "/auth/callback",
      fetch: msIdp.fetch,
      now,
    });
    expect(ms.providerId).toBe("microsoft");
    expect(ms.displayName).toBe("Microsoft");
    expect(ms.tenant).toBe("common");

    const begun = await ms.begin();
    const u = new URL(begun.url);
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(await challengeS256(begun.verifier));
    expect(u.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email", "profile"]));

    const token = await msIdp.mint({
      nonce: begun.nonce,
      tid: ALASKA_TID,
      oid: "oid-alaska-42",
      sub: "pairwise-sub-42",
      email: "Pilot@AlaskaAir.COM",
      name: "Alex Pilot",
    });
    msIdp.strictCode("ms-code-1", token, begun.url);
    const id = await ms.finish({ code: "ms-code-1", state: begun.state, expected: begun });
    expect(id).toEqual({
      user: "microsoft:oid-alaska-42",
      name: "Alex Pilot",
      email: "pilot@alaskaair.com",
      domain: "alaskaair.com",
      tid: ALASKA_TID,
    });
  });

  test("preferred_username fallback when email claim is absent, and sub fallback when oid is absent", async () => {
    const keys = jwksCache({ url: microsoftEndpoints("common").jwks, fetch: msIdp.fetch, now, algorithms: ["RS256"] });
    const tok = await msIdp.mint({
      nonce: "n-pref",
      tid: ALASKA_TID,
      oid: undefined,
      sub: "sub-only-99",
      email: undefined,
      preferred_username: "Crew.Member@AlaskaAir.com",
      name: "Crew Member",
    });
    const id = await verifyMicrosoftIdToken(tok, { clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-pref", keys, now });
    expect(id).toEqual({
      user: "microsoft:sub-only-99",
      name: "Crew Member",
      email: "crew.member@alaskaair.com",
      domain: "alaskaair.com",
      tid: ALASKA_TID,
    });
  });

  test("MSA consumer tenant gets domain: null in `common` and is rejected in `organizations`", async () => {
    const keys = jwksCache({ url: microsoftEndpoints("common").jwks, fetch: msIdp.fetch, now, algorithms: ["RS256"] });
    const msaTok = await msIdp.mint({
      nonce: "n-msa",
      tid: MICROSOFT_CONSUMER_TID,
      email: "person@outlook.com",
    });
    const commonId = await verifyMicrosoftIdToken(msaTok, { clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-msa", keys, now });
    expect(commonId).toMatchObject({ email: "person@outlook.com", domain: null, tid: MICROSOFT_CONSUMER_TID });

    const causes = [];
    const orgsId = await verifyMicrosoftIdToken(msaTok, {
      clientId: MS_CLIENT_ID, tenant: "organizations", nonce: "n-msa", keys, now, why: c => causes.push(c),
    });
    expect(orgsId).toBeNull();
    expect(causes).toEqual(["bad_iss"]);
  });

  test("trustVerifiedEmail: MSA consumer tenant resolves corporate email domain but keeps consumer mail domains null", async () => {
    const keys = jwksCache({ url: microsoftEndpoints("common").jwks, fetch: msIdp.fetch, now, algorithms: ["RS256"] });

    // Corporate email on MSA consumer tenant -> resolves domain when trustVerifiedEmail: true
    const corpMsaTok = await msIdp.mint({
      nonce: "n-msa-corp",
      tid: MICROSOFT_CONSUMER_TID,
      email: "DeMarco@AlaskaAir.COM",
    });
    expect(await verifyMicrosoftIdToken(corpMsaTok, {
      clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-msa-corp", keys, now,
    })).toMatchObject({ email: "demarco@alaskaair.com", domain: null, tid: MICROSOFT_CONSUMER_TID });
    expect(await verifyMicrosoftIdToken(corpMsaTok, {
      clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-msa-corp", keys, now, trustVerifiedEmail: true,
    })).toMatchObject({ email: "demarco@alaskaair.com", domain: "alaskaair.com", tid: MICROSOFT_CONSUMER_TID });

    // Consumer mail domains (outlook.com, hotmail.com, gmail.com, etc.) stay domain: null
    for (const addr of ["person@outlook.com", "user@hotmail.com", "user@live.com", "user@gmail.com", "user@proton.me"]) {
      const tok = await msIdp.mint({ nonce: "n-msa-cons", tid: MICROSOFT_CONSUMER_TID, email: addr });
      expect(await verifyMicrosoftIdToken(tok, {
        clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-msa-cons", keys, now, trustVerifiedEmail: true,
      })).toMatchObject({ email: addr, domain: null, tid: MICROSOFT_CONSUMER_TID });
    }

    // Explicitly unverified email still drops both email and domain
    const unverifiedTok = await msIdp.mint({
      nonce: "n-msa-unv",
      tid: MICROSOFT_CONSUMER_TID,
      email: "demarco@alaskaair.com",
      email_verified: false,
    });
    expect(await verifyMicrosoftIdToken(unverifiedTok, {
      clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-msa-unv", keys, now, trustVerifiedEmail: true,
    })).toMatchObject({ email: null, domain: null, tid: MICROSOFT_CONSUMER_TID });

    // microsoftOidc forwards trustVerifiedEmail through finish() and verifyIdToken()
    const ms = microsoftOidc({
      clientId: MS_CLIENT_ID,
      clientSecret: MS_CLIENT_SECRET,
      redirectUri: ORIGIN + "/auth/callback",
      fetch: msIdp.fetch,
      now,
      trustVerifiedEmail: true,
    });
    const begun = await ms.begin();
    const tok = await msIdp.mint({ nonce: begun.nonce, tid: MICROSOFT_CONSUMER_TID, email: "pilot@alaskaair.com" });
    msIdp.strictCode("ms-code-trusted", tok, begun.url);
    expect(await ms.finish({ code: "ms-code-trusted", state: begun.state, expected: begun })).toMatchObject({
      email: "pilot@alaskaair.com",
      domain: "alaskaair.com",
      tid: MICROSOFT_CONSUMER_TID,
    });
    expect(await ms.verifyIdToken(tok, begun.nonce)).toMatchObject({
      email: "pilot@alaskaair.com",
      domain: "alaskaair.com",
      tid: MICROSOFT_CONSUMER_TID,
    });
  });

  test("single-tenant GUID accepts matching tid and rejects foreign tid", async () => {
    const msSingle = microsoftOidc({
      clientId: MS_CLIENT_ID,
      clientSecret: MS_CLIENT_SECRET,
      tenant: ALASKA_TID,
      redirectUri: ORIGIN + "/auth/callback",
      fetch: msIdp.fetch,
      now,
    });
    const begun = await msSingle.begin();
    expect(new URL(begun.url).pathname).toBe(`/${ALASKA_TID}/oauth2/v2.0/authorize`);

    const own = await msIdp.mint({ nonce: "n-s", tid: ALASKA_TID, email: "a@alaskaair.com" });
    expect(await msSingle.verifyIdToken(own, "n-s")).toMatchObject({ domain: "alaskaair.com", tid: ALASKA_TID });

    const foreign = await msIdp.mint({ nonce: "n-s", tid: OTHER_TID, email: "b@other.com" });
    const why = [];
    expect(await msSingle.verifyIdToken(foreign, "n-s", { why: c => why.push(c) })).toBeNull();
    expect(why).toEqual(["bad_iss"]);
  });

  test("tampered iss, non-UUID tid, wrong aud, expired token, and bad nonce are rejected", async () => {
    const keys = jwksCache({ url: microsoftEndpoints("common").jwks, fetch: msIdp.fetch, now, algorithms: ["RS256"] });
    const check = async (claims, expectedCause) => {
      const why = [];
      const tok = await msIdp.mint({ nonce: "n-1", ...claims });
      const res = await verifyMicrosoftIdToken(tok, { clientId: MS_CLIENT_ID, tenant: "common", nonce: "n-1", keys, now, why: c => why.push(c) });
      expect(res).toBeNull();
      expect(why).toEqual([expectedCause]);
    };

    // iss tid does not match payload.tid
    await check({ tid: ALASKA_TID, iss: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` }, "bad_iss");
    // non-UUID tid
    await check({ tid: "not-a-uuid", iss: "https://login.microsoftonline.com/not-a-uuid/v2.0" }, "bad_iss");
    // evil issuer host
    await check({ tid: ALASKA_TID, iss: `https://evil.example/${ALASKA_TID}/v2.0` }, "bad_iss");
    // wrong aud
    await check({ aud: "other-app" }, "bad_aud");
    // expired
    const t = Math.floor(now() / 1000);
    await check({ iat: t - 7200, exp: t - 3600 }, "expired");
    // wrong nonce
    await check({ nonce: "wrong-nonce" }, "bad_nonce");
  });
});

describe("Simultaneous Google + Microsoft multi-provider auth & corporate domain auto-provisioning", () => {
  const clock = { t: Date.UTC(2026, 10, 23, 12) };
  const now = () => clock.t;
  let gIdp, msIdp, registry, sessions, tenancy, google, microsoft;

  const baseConfig = {
    cookieKey: "k".repeat(32),
    postLoginUrl: APP,
    postLogoutUrl: "https://plenary.test/bye",
    boardUrl: "https://plenary.test/b/{board}",
    publicUrl: ORIGIN,
  };

  beforeAll(async () => {
    gIdp = await fakeIdp({ now });
    await gIdp.addKey("gk1");
    msIdp = await fakeMicrosoftIdp({ now });
    await msIdp.addKey("msk1");
  });

  beforeEach(async () => {
    clock.t = Date.UTC(2026, 10, 23, 12);
    registry = memoryRegistry({ now });
    sessions = await makeSessions({ key: "s".repeat(32), now });
    tenancy = makeTenancy({ registry, now });
    google = googleOidc({ clientId: GOOGLE_CLIENT_ID, clientSecret: "g-sec", redirectUri: ORIGIN + "/auth/callback", fetch: gIdp.fetch, now });
    microsoft = microsoftOidc({ clientId: MS_CLIENT_ID, clientSecret: MS_CLIENT_SECRET, redirectUri: ORIGIN + "/auth/callback", fetch: msIdp.fetch, now });
  });

  const cookieOf = (res, name = LOGIN_COOKIE) => {
    const c = res.headers.getSetCookie().find(s => s.startsWith(name + "="));
    return c ? c.split(";")[0] : null;
  };
  const fragCode = loc => new URLSearchParams(new URL(loc).hash.slice(1)).get("code");

  async function completeLogin(routes, providerQuery, mintFn) {
    const path = providerQuery ? `/auth/login?provider=${encodeURIComponent(providerQuery)}` : "/auth/login";
    const startRes = await routes(new Request(ORIGIN + path));
    expect(startRes.status).toBe(302);
    const authUrl = startRes.headers.get("location");
    const loc = new URL(authUrl);
    const loginCookie = cookieOf(startRes, LOGIN_COOKIE);
    const code = "c-" + Math.random().toString(36).slice(2);
    await mintFn(code, loc.searchParams.get("nonce"), authUrl);
    const cbRes = await routes(new Request(`${ORIGIN}/auth/callback?${new URLSearchParams({ code, state: loc.searchParams.get("state") })}`, {
      headers: { cookie: loginCookie },
    }));
    expect(cbRes.status).toBe(302);
    const xchgRes = await routes(new Request(ORIGIN + "/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: cookieOf(cbRes, EXCHANGE_COOKIE) },
      body: JSON.stringify({ code: fragCode(cbRes.headers.get("location")) }),
    }));
    expect(xchgRes.status).toBe(200);
    return { authUrl, session: await xchgRes.json() };
  }

  test("GET /auth/providers lists both Google and Microsoft, and login/callback routes each provider cleanly", async () => {
    const routes = httpRoutes({
      registry,
      sessions,
      tenancy,
      now,
      config: baseConfig,
      providers: [
        { id: "google", label: "Google", idp: google },
        { id: "microsoft", label: "Microsoft", idp: microsoft },
      ],
    });

    const pRes = await routes(new Request(ORIGIN + "/auth/providers"));
    expect(pRes.status).toBe(200);
    expect(await pRes.json()).toEqual({
      providers: [
        { id: "google", label: "Google" },
        { id: "microsoft", label: "Microsoft" },
      ],
    });

    // Unknown provider is rejected cleanly
    const badRes = await routes(new Request(ORIGIN + "/auth/login?provider=okta"));
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toEqual({ error: "unknown-provider" });

    // Omitted ?provider= defaults to first configured provider (Google)
    const defaultLogin = await completeLogin(routes, null, async (code, nonce) => {
      gIdp.codes.set(code, await gIdp.mint({ sub: "g-1", email: "ann@acme.com", hd: "acme.com", name: "Ann", nonce }));
    });
    expect(new URL(defaultLogin.authUrl).hostname).toBe("accounts.google.com");
    expect(defaultLogin.session).toMatchObject({ user: "google:g-1", email: "ann@acme.com", domain: "acme.com" });

    // ?provider=microsoft routes to Entra ID and verifies callback against Microsoft IdP
    const msLogin = await completeLogin(routes, "microsoft", async (code, nonce, authUrl) => {
      msIdp.strictCode(code, await msIdp.mint({ oid: "ms-1", email: "pilot@alaskaair.com", name: "Pilot", nonce, tid: ALASKA_TID }), authUrl);
    });
    expect(new URL(msLogin.authUrl).hostname).toBe("login.microsoftonline.com");
    expect(msLogin.session).toMatchObject({ user: "microsoft:ms-1", email: "pilot@alaskaair.com", domain: "alaskaair.com" });
  });

  test("corporate domain (alaskaair.com) auto-provisions tenant on first sign-in with first user as admin; second user joins as member", async () => {
    const routes = httpRoutes({
      registry,
      sessions,
      tenancy,
      now,
      config: { ...baseConfig, autoProvisionDomainOrgs: true },
      providers: [
        { id: "google", label: "Google", idp: google },
        { id: "microsoft", label: "Microsoft", idp: microsoft },
      ],
    });

    // Initially no tenant for alaskaair.com
    expect(await registry.tenantByDomain("alaskaair.com")).toBeNull();

    // First user from alaskaair.com signs in via Microsoft Entra ID
    const first = await completeLogin(routes, "microsoft", async (code, nonce, authUrl) => {
      msIdp.strictCode(code, await msIdp.mint({ oid: "ms-first", email: "captain@alaskaair.com", name: "Captain", nonce, tid: ALASKA_TID }), authUrl);
    });
    const tenant = await registry.tenantByDomain("alaskaair.com");
    expect(tenant).not.toBeNull();
    expect(tenant.domain).toBe("alaskaair.com");
    expect(tenant.admins).toContain("microsoft:ms-first");
    expect(tenant.admins).toContain("email:captain@alaskaair.com");

    // First user can immediately create a board in alaskaair.com
    const boardRes = await routes(new Request(ORIGIN + "/boards", {
      method: "POST",
      headers: { authorization: "Bearer " + first.session.token, "content-type": "application/json" },
      body: JSON.stringify({ title: "Flight Ops Roadmap", memberRole: "editor" }),
    }));
    expect(boardRes.status).toBe(201);
    const { board } = await boardRes.json();
    expect(board.tenant).toBe(tenant.id);

    // Second user from alaskaair.com signs in -> joins existing tenant as regular member (NOT promoted to admin)
    const second = await completeLogin(routes, "microsoft", async (code, nonce, authUrl) => {
      msIdp.strictCode(code, await msIdp.mint({ oid: "ms-second", email: "copilot@alaskaair.com", name: "Copilot", nonce, tid: ALASKA_TID }), authUrl);
    });
    const tenantAfter = await registry.tenantByDomain("alaskaair.com");
    expect(tenantAfter.id).toBe(tenant.id);
    expect(tenantAfter.admins).not.toContain("microsoft:ms-second");

    // Second user sees the shared board on GET /boards (isAdmin: false)
    const listRes = await routes(new Request(ORIGIN + "/boards", {
      headers: { authorization: "Bearer " + second.session.token },
    }));
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.isAdmin).toBe(false);
    expect(listed.boards.map(b => b.id)).toContain(board.id);
  });

  test("when autoProvisionDomainOrgs is false, corporate domain user still signs in cleanly and can create a personal workspace", async () => {
    const routes = httpRoutes({
      registry,
      sessions,
      tenancy,
      now,
      config: { ...baseConfig, autoProvisionDomainOrgs: false },
      providers: [{ id: "microsoft", label: "Microsoft", idp: microsoft }],
    });

    const login = await completeLogin(routes, "microsoft", async (code, nonce, authUrl) => {
      msIdp.strictCode(code, await msIdp.mint({ oid: "ms-self", email: "user@alaskaair.com", name: "User", nonce, tid: ALASKA_TID }), authUrl);
    });
    expect(await registry.tenantByDomain("alaskaair.com")).toBeNull();

    // Microsoft user can create a self-serve personal org via POST /tenants
    const orgRes = await routes(new Request(ORIGIN + "/tenants", {
      method: "POST",
      headers: { authorization: "Bearer " + login.session.token, "content-type": "application/json" },
      body: JSON.stringify({ name: "Alaska Design Team" }),
    }));
    expect(orgRes.status).toBe(201);
    expect((await orgRes.json()).tenant).toMatchObject({ name: "Alaska Design Team", domain: null, isAdmin: true });
  });

  test("server/main.js start() wires Google AND Microsoft simultaneously without mutual-exclusion error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plenary-ms-main-"));
    let app;
    try {
      app = await start({
        PORT: "0",
        HOST: "127.0.0.1",
        PLENARY_DATA_DIR: dir,
        PUBLIC_URL: ORIGIN,
        OIDC_REDIRECT_URI: ORIGIN + "/auth/callback",
        COOKIE_KEY: "k".repeat(32),
        GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: "g-sec",
        MICROSOFT_CLIENT_ID: MS_CLIENT_ID,
        MICROSOFT_CLIENT_SECRET: MS_CLIENT_SECRET,
        MICROSOFT_TENANT_ID: "organizations",
      }, { fetch: msIdp.fetch, write: () => {} });

      expect(app.providers.map(p => ({ id: p.id, label: p.label }))).toEqual([
        { id: "google", label: "Google" },
        { id: "microsoft", label: "Microsoft" },
      ]);
      const ms = app.providers.find(p => p.id === "microsoft")?.idp;
      const begun = await ms.begin();
      expect(new URL(begun.url).pathname).toBe("/organizations/oauth2/v2.0/authorize");
    } finally {
      await app?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("web fetchAuthProviders", () => {
  test("maps GET /auth/providers into Sign-In links and falls back to null on 404/error", async () => {
    const okFetch = async url => {
      expect(url).toBe("/auth/providers");
      return Response.json({ providers: [{ id: "google", label: "Google" }, { id: "microsoft", label: "Microsoft" }] });
    };
    expect(await fetchAuthProviders({ fetch: /** @type {any} */ (okFetch) })).toEqual([
      { id: "google", label: "Google", href: "/auth/login?provider=google", text: "Sign in with Google" },
      { id: "microsoft", label: "Microsoft", href: "/auth/login?provider=microsoft", text: "Sign in with Microsoft" },
    ]);

    const missingFetch = async () => new Response("not found", { status: 404 });
    expect(await fetchAuthProviders({ fetch: /** @type {any} */ (missingFetch) })).toBeNull();

    const failFetch = async () => { throw new Error("offline"); };
    expect(await fetchAuthProviders({ fetch: /** @type {any} */ (failFetch) })).toBeNull();
  });
});
