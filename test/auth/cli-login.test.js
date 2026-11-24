// @ts-check
// Tests for zero-friction `plenary login`:
//   1. Server PKCE S256 loopback login (GET /auth/login?cli_*, multi-provider chooser, callback redirect, POST /auth/cli-exchange, 90-day token).
//   2. Credentials store (~/.config/plenary/credentials.json, 0600 atomic write, resolveCredentials precedence).
//   3. CLI commands (login, whoami, logout, auto-loaded API calls) and MCP dynamic auto-loading.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { httpRoutes, LOGIN_COOKIE, EXCHANGE_COOKIE, CLI_TOKEN_TTL_SEC } from "../../server/adapters/driving/auth-http.js";
import { googleOidc } from "../../server/adapters/driven/auth/oidc.js";
import { sessions as makeSessions, MAX_TTL_SEC } from "../../server/adapters/driven/auth/session.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { fakeIdp, CLIENT_ID } from "./fake-idp.js";

import {
  saveServerCredentials,
  readCredentials,
  removeServerCredentials,
  resolveCredentials,
} from "../../scripts/plenary-client.js";
import { runCli, runLoginFlow } from "../../scripts/plenary-cli.js";
import { createMcpHandler } from "../../scripts/plenary-mcp.js";

const ORIGIN = "https://app.plenary.test";
const config = { cookieKey: "k".repeat(32), postLoginUrl: ORIGIN + "/", boardUrl: ORIGIN + "/b/{board}" };
const ADMIN = { sub: "1001", email: "ann@acme.com", hd: "acme.com", name: "Ann" };

function makePkce() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge };
}

const setCookie = (res, name) => res.headers.getSetCookie().find(s => s.startsWith(name + "="));
const cookieOf = (res, name) => setCookie(res, name)?.split(";")[0] ?? null;

describe("Server PKCE loopback CLI login", () => {
  const clock = { t: 0 };
  const now = () => clock.t;
  let idp, registry, sessions, oidc, tenancy, routes;

  beforeAll(async () => {
    idp = await fakeIdp({ now });
    await idp.addKey("k1");
  });

  beforeEach(async () => {
    clock.t = Date.UTC(2026, 10, 24, 12, 0, 0);
    registry = memoryRegistry({ now });
    sessions = await makeSessions({ key: "s".repeat(32), now });
    oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: ORIGIN + "/auth/callback", fetch: idp.fetch, now });
    tenancy = makeTenancy({ registry, now });
    await registry.createTenant({ domain: "acme.com", admins: ["google:1001"] });
    routes = httpRoutes({ registry, sessions, oidc, tenancy, now, config });
  });

  async function completeCliOidc(who, { cliPort = 43210, pkce = makePkce(), via = routes, provider = null } = {}) {
    const q = new URLSearchParams({
      cli_port: String(cliPort),
      cli_state: pkce.state,
      cli_challenge: pkce.challenge,
      ...(provider ? { provider } : {}),
    });
    const start = await via(new Request(`${ORIGIN}/auth/login?${q}`));
    expect(start.status).toBe(302);
    const idpLoc = new URL(start.headers.get("location"));
    const gCode = "g-" + randomBytes(8).toString("hex");
    idp.codes.set(gCode, await idp.mint({ ...who, nonce: idpLoc.searchParams.get("nonce") }));
    const cbQ = new URLSearchParams({ code: gCode, state: idpLoc.searchParams.get("state") });
    const cb = await via(new Request(`${ORIGIN}/auth/callback?${cbQ}`, {
      headers: { cookie: cookieOf(start, LOGIN_COOKIE) ?? "" },
    }));
    expect(cb.status).toBe(302);
    const cbLoc = new URL(cb.headers.get("location"));
    return { start, cb, cbLoc, code: cbLoc.searchParams.get("code"), state: cbLoc.searchParams.get("state"), pkce };
  }

  test("happy path: PKCE S256 login -> loopback callback -> 90-day token works on protected HTTP routes", async () => {
    const { cb, cbLoc, code, state, pkce } = await completeCliOidc(ADMIN, { cliPort: 45123 });
    expect(cbLoc.origin).toBe("http://127.0.0.1:45123");
    expect(cbLoc.pathname).toBe("/callback");
    expect(state).toBe(pkce.state);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Login cookie cleared, no browser exchange cookie set.
    expect(setCookie(cb, LOGIN_COOKIE)).toContain("Max-Age=0");
    expect(setCookie(cb, EXCHANGE_COOKIE)).toBeUndefined();

    const ex = await routes(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: pkce.verifier }),
    }));
    expect(ex.status).toBe(200);
    expect(ex.headers.get("cache-control")).toBe("no-store");
    const body = await ex.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.startsWith("s1.")).toBe(true);
    const expectedExpSec = Math.floor(clock.t / 1000) + CLI_TOKEN_TTL_SEC;
    expect(body.expiresAt).toBe(expectedExpSec * 1000);
    expect(body.user).toEqual({ id: "google:1001", name: "Ann", email: "ann@acme.com" });

    // Token works on protected HTTP routes immediately and after 89 days.
    const boardsRes = await routes(new Request(`${ORIGIN}/boards`, {
      headers: { authorization: `Bearer ${body.token}` },
    }));
    expect(boardsRes.status).toBe(200);
    const boardsJson = await boardsRes.json();
    expect(boardsJson.isAdmin).toBe(true);

    clock.t += 89 * 24 * 60 * 60 * 1000;
    const stillValid = await sessions.verify(body.token);
    expect(stillValid?.user).toBe("google:1001");

    // Expired after 90 days + 1s.
    clock.t += 24 * 60 * 60 * 1000 + 1000;
    expect(await sessions.verify(body.token)).toBeNull();
  });

  test("invalid or partial cli_port / cli_state / cli_challenge -> 400 bad-request", async () => {
    const pkce = makePkce();
    const badQueries = [
      // Partial params
      `cli_port=43210`,
      `cli_port=43210&cli_state=${pkce.state}`,
      `cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      // Invalid port
      `cli_port=80&cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      `cli_port=1023&cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      `cli_port=65536&cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      `cli_port=04321&cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      `cli_port=abc&cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      `cli_port=1234.5&cli_state=${pkce.state}&cli_challenge=${pkce.challenge}`,
      // Invalid state
      `cli_port=43210&cli_state=short&cli_challenge=${pkce.challenge}`,
      `cli_port=43210&cli_state=${"a".repeat(129)}&cli_challenge=${pkce.challenge}`,
      `cli_port=43210&cli_state=${"a".repeat(20)}!&cli_challenge=${pkce.challenge}`,
      // Invalid challenge
      `cli_port=43210&cli_state=${pkce.state}&cli_challenge=tooshort`,
      `cli_port=43210&cli_state=${pkce.state}&cli_challenge=${"a".repeat(42)}`,
      `cli_port=43210&cli_state=${pkce.state}&cli_challenge=${"a".repeat(43)}+`,
    ];
    for (const qs of badQueries) {
      const res = await routes(new Request(`${ORIGIN}/auth/login?${qs}`));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad-request" });
    }
  });

  test("wrong PKCE verifier -> 401 and consumes code", async () => {
    const { code, pkce } = await completeCliOidc(ADMIN);
    const wrongVerifier = randomBytes(32).toString("base64url");
    const bad = await routes(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: wrongVerifier }),
    }));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "invalid-verifier" });

    // Code was consumed atomically: retrying with the real verifier also fails 401.
    const retry = await routes(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: pkce.verifier }),
    }));
    expect(retry.status).toBe(401);
    expect(await retry.json()).toEqual({ error: "invalid-code" });
  });

  test("code replay -> 401 invalid-code", async () => {
    const { code, pkce } = await completeCliOidc(ADMIN);
    const first = await routes(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: pkce.verifier }),
    }));
    expect(first.status).toBe(200);

    const replay = await routes(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: pkce.verifier }),
    }));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "invalid-code" });
  });

  test("expired CLI exchange code (61s) -> 401 invalid-code", async () => {
    const { code, pkce } = await completeCliOidc(ADMIN);
    clock.t += 61_000;
    const res = await routes(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier: pkce.verifier }),
    }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid-code" });
  });

  test("multi-provider HTML chooser page when provider omitted; direct redirect when provider specified", async () => {
    const msIdp = {
      ...oidc,
      providerId: "microsoft",
      displayName: "Microsoft",
    };
    const multiRoutes = httpRoutes({
      registry,
      sessions,
      providers: [
        { id: "google", label: "Google", idp: oidc },
        { id: "microsoft", label: "Microsoft", idp: msIdp },
      ],
      tenancy,
      now,
      config,
    });
    const pkce = makePkce();
    const q = new URLSearchParams({ cli_port: "49152", cli_state: pkce.state, cli_challenge: pkce.challenge });
    const chooser = await multiRoutes(new Request(`${ORIGIN}/auth/login?${q}`));
    expect(chooser.status).toBe(200);
    expect(chooser.headers.get("content-type")).toContain("text/html");
    expect(chooser.headers.get("cache-control")).toBe("no-store");
    expect(chooser.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(chooser.headers.get("content-security-policy")).toContain("base-uri 'none'");
    const html = await chooser.text();
    expect(html).toContain("Sign in to Plenary CLI");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Microsoft");
    expect(html).toContain("provider=google");
    expect(html).toContain("provider=microsoft");
    expect(html).toContain("cli_port=49152");

    // Specifying provider=microsoft bypasses chooser and redirects directly.
    const direct = await multiRoutes(new Request(`${ORIGIN}/auth/login?provider=microsoft&${q}`));
    expect(direct.status).toBe(302);
    expect(setCookie(direct, LOGIN_COOKIE)).toBeDefined();
  });

  test("no OIDC configured -> POST /auth/cli-exchange returns 503 sign-in-unavailable", async () => {
    const noOidc = httpRoutes({ registry, sessions, oidc: null, tenancy, now, config });
    const res = await noOidc(new Request(`${ORIGIN}/auth/cli-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "a".repeat(43), verifier: "b".repeat(43) }),
    }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sign-in-unavailable" });
  });

  test("sessions.issue rejects invalid, unbounded, or non-integer ttlSec / ttlMs (validates both when both given)", async () => {
    const id = { user: "google:1001", name: "Ann", email: "ann@acme.com", domain: "acme.com" };
    for (const bad of [
      { ttlSec: 0 },
      { ttlSec: -10 },
      { ttlSec: 1.5 },
      { ttlSec: MAX_TTL_SEC + 1 },
      { ttlSec: Number.POSITIVE_INFINITY },
      { ttlMs: 0 },
      { ttlMs: -1 },
      { ttlMs: 1.5 },
      { ttlMs: MAX_TTL_SEC * 1000 + 1 },
      { ttlSec: 60, ttlMs: MAX_TTL_SEC * 1000 + 1 }, // validates ttlMs even when ttlSec is valid
    ]) {
      await expect(sessions.issue(id, bad)).rejects.toThrow();
    }
    const okTok = await sessions.issue(id, { ttlSec: 3600, ttlMs: 3600_000 });
    expect((await sessions.verify(okTok))?.user).toBe("google:1001");
  });

  test("cliCodes maxLoginStates cap fails closed with 503 unavailable", async () => {
    const capped = httpRoutes({
      registry,
      sessions,
      oidc,
      tenancy,
      now,
      config: { ...config, maxLoginStates: 1 },
    });
    // First CLI login fills the single cliCodes slot.
    await completeCliOidc(ADMIN, { via: capped });
    // Second CLI login hits the cap on callback -> 503 unavailable.
    const pkce2 = makePkce();
    const q = new URLSearchParams({ cli_port: "43211", cli_state: pkce2.state, cli_challenge: pkce2.challenge });
    const start = await capped(new Request(`${ORIGIN}/auth/login?${q}`));
    expect(start.status).toBe(302);
    const idpLoc = new URL(start.headers.get("location"));
    const gCode = "g-" + randomBytes(8).toString("hex");
    idp.codes.set(gCode, await idp.mint({ ...ADMIN, nonce: idpLoc.searchParams.get("nonce") }));
    const cbQ = new URLSearchParams({ code: gCode, state: idpLoc.searchParams.get("state") });
    const cb = await capped(new Request(`${ORIGIN}/auth/callback?${cbQ}`, {
      headers: { cookie: cookieOf(start, LOGIN_COOKIE) ?? "" },
    }));
    expect(cb.status).toBe(503);
    expect(await cb.json()).toEqual({ error: "unavailable" });
  });
});

describe("Credentials store, CLI login/whoami/logout, and MCP auto-loading", () => {
  let dir;
  let credPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plenary-creds-"));
    credPath = join(dir, "plenary", "credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("saveServerCredentials writes atomically with 0600 file and 0700 dir permissions", () => {
    const saved = saveServerCredentials({
      url: "https://p5y.omni.ooo/",
      token: "s1.secret.token",
      expiresAt: 1800000000000,
      user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
    }, { credPath });

    expect(saved.url).toBe("https://p5y.omni.ooo");
    const fileMode = statSync(credPath).mode & 0o777;
    const dirMode = statSync(join(dir, "plenary")).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    const parsed = JSON.parse(readFileSync(credPath, "utf8"));
    expect(parsed).toEqual({
      defaultUrl: "https://p5y.omni.ooo",
      servers: {
        "https://p5y.omni.ooo": {
          token: "s1.secret.token",
          expiresAt: 1800000000000,
          user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
        },
      },
    });
  });

  test("resolveCredentials precedence: explicit/env token > credentials.json > none", () => {
    const env = { PLENARY_CREDENTIALS_PATH: credPath };
    const futureExp = Date.now() + 86_400_000;
    expect(resolveCredentials({ env })).toEqual({
      url: null, token: null, source: "none", user: null, expiresAt: null, expired: false,
    });

    saveServerCredentials({
      url: "https://p5y.omni.ooo",
      token: "s1.saved.one",
      expiresAt: futureExp,
      user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
    }, { env });
    saveServerCredentials({
      url: "https://staging.omni.ooo",
      token: "s1.saved.two",
      expiresAt: futureExp + 1,
      user: { id: "google:2", name: "Bo", email: "bo@acme.com" },
      setDefault: false,
    }, { env });

    // Falls back to defaultUrl from credentials.json.
    expect(resolveCredentials({ env })).toEqual({
      url: "https://p5y.omni.ooo",
      token: "s1.saved.one",
      source: "credentials",
      user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
      expiresAt: futureExp,
      expired: false,
    });

    // PLENARY_URL selects matching server entry.
    expect(resolveCredentials({ env: { ...env, PLENARY_URL: "https://staging.omni.ooo/" } })).toEqual({
      url: "https://staging.omni.ooo",
      token: "s1.saved.two",
      source: "credentials",
      user: { id: "google:2", name: "Bo", email: "bo@acme.com" },
      expiresAt: futureExp + 1,
      expired: false,
    });

    // PLENARY_TOKEN overrides credentials.json.
    expect(resolveCredentials({ env: { ...env, PLENARY_TOKEN: "env-tok" } })).toEqual({
      url: "https://p5y.omni.ooo",
      token: "env-tok",
      source: "env",
      user: null,
      expiresAt: null,
      expired: false,
    });

    // Explicit --token overrides both.
    expect(resolveCredentials({ token: "flag-tok", url: "https://custom.test", env: { ...env, PLENARY_TOKEN: "env-tok" } })).toEqual({
      url: "https://custom.test",
      token: "flag-tok",
      source: "env",
      user: null,
      expiresAt: null,
      expired: false,
    });
  });

  test("corrupt defaultUrl in credentials.json is sanitized to null without crashing", () => {
    const env = { PLENARY_CREDENTIALS_PATH: credPath };
    mkdirSync(join(dir, "plenary"), { recursive: true });
    writeFileSync(credPath, JSON.stringify({ defaultUrl: "ftp://bad-proto.example", servers: {} }), "utf8");
    expect(readCredentials({ env })).toEqual({ defaultUrl: null, servers: {} });
    expect(resolveCredentials({ env })).toEqual({
      url: null, token: null, source: "none", user: null, expiresAt: null, expired: false,
    });
  });

  test("expired and missing credentials surface actionable PlenaryError in CLI and MCP", async () => {
    const env = { PLENARY_CREDENTIALS_PATH: credPath };
    // Missing credentials: CLI returns exit 1 with actionable message, MCP returns isError with same message.
    const errs = [];
    const missingCode = await runCli(["list-boards"], env, { out: () => {}, err: s => errs.push(s) });
    expect(missingCode).toBe(1);
    expect(errs[0]).toContain("Not authenticated — run 'plenary login'");

    const mcp = createMcpHandler({ env });
    const mcpMissing = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_boards", arguments: {} } });
    expect(mcpMissing.result.isError).toBe(true);
    expect(JSON.parse(mcpMissing.result.content[0].text).error).toContain("Not authenticated — run 'plenary login'");

    // Expired credentials: resolveCredentials marks expired: true, token: null.
    saveServerCredentials({
      url: "https://p5y.omni.ooo",
      token: "s1.expired.tok",
      expiresAt: Date.now() - 1000,
      user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
    }, { env });
    const resolved = resolveCredentials({ env });
    expect(resolved.expired).toBe(true);
    expect(resolved.token).toBeNull();

    errs.length = 0;
    const expiredCode = await runCli(["list-boards"], env, { out: () => {}, err: s => errs.push(s) });
    expect(expiredCode).toBe(1);
    expect(errs[0]).toContain("Credentials expired — run 'plenary login' to re-authenticate.");

    const mcpExpired = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_boards", arguments: {} } });
    expect(mcpExpired.result.isError).toBe(true);
    expect(JSON.parse(mcpExpired.result.content[0].text).error).toContain("Credentials expired — run 'plenary login' to re-authenticate.");
  });

  test("runLoginFlow hardening: 405 non-GET, 404 no-store, wrong state ignores ?error=, XSS-escaped error page + CSP", async () => {
    const mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/auth/cli-exchange") {
          return new Response(JSON.stringify({ error: "<script>alert(1)</script>" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const baseUrl = `http://127.0.0.1:${mockServer.port}`;
    try {
      const env = { PLENARY_CREDENTIALS_PATH: credPath };
      let resolveUrl;
      const urlReady = new Promise(r => { resolveUrl = r; });
      const flowResult = runLoginFlow({
        url: baseUrl,
        noOpen: true,
        env,
        timeoutMs: 5000,
        err: s => {
          const m = s.match(/https?:\/\/[^\s]+/);
          if (m) resolveUrl(m[0]);
        },
      }).then(
        v => ({ ok: true, value: v }),
        e => ({ ok: false, error: e }),
      );

      const loginUrl = new URL(await urlReady);
      const cliPort = loginUrl.searchParams.get("cli_port");
      const cliState = loginUrl.searchParams.get("cli_state");
      const loopbackBase = `http://127.0.0.1:${cliPort}`;

      // Non-GET -> 405 with cache-control: no-store.
      const postRes = await fetch(`${loopbackBase}/callback`, { method: "POST" });
      expect(postRes.status).toBe(405);
      expect(postRes.headers.get("cache-control")).toBe("no-store");

      // Unknown path -> 404 with cache-control: no-store.
      const notFound = await fetch(`${loopbackBase}/other`);
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get("cache-control")).toBe("no-store");

      // Wrong state with ?error=access_denied returns 400 and does NOT abort the login flow.
      const badStateErr = await fetch(`${loopbackBase}/callback?error=access_denied&state=wrong-state`);
      expect(badStateErr.status).toBe(400);

      // Real state triggers exchange -> server returns XSS payload in error -> escaped HTML + strict CSP + no-referrer.
      const xssRes = await fetch(`${loopbackBase}/callback?code=${"a".repeat(43)}&state=${encodeURIComponent(cliState)}`);
      expect(xssRes.status).toBe(400);
      expect(xssRes.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(xssRes.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await xssRes.text();
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

      const settled = await flowResult;
      expect(settled.ok).toBe(false);
      expect(settled.error?.message).toMatch(/CLI token exchange failed/);
    } finally {
      mockServer.stop(true);
    }
  });

  test("CLI whoami redacts token and logout removes one or all servers", async () => {
    const env = { PLENARY_CREDENTIALS_PATH: credPath };
    saveServerCredentials({
      url: "https://p5y.omni.ooo",
      token: "s1.super.secret.token",
      expiresAt: 1900000000000,
      user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
    }, { env });

    const out = [];
    const code1 = await runCli(["whoami"], env, { out: s => out.push(s), err: () => {} });
    expect(code1).toBe(0);
    expect(out[0]).not.toContain("s1.super.secret.token");
    expect(JSON.parse(out[0])).toEqual({
      url: "https://p5y.omni.ooo",
      source: "credentials",
      user: { id: "google:1", name: "Ann", email: "ann@acme.com" },
      expiresAt: 1900000000000,
    });

    // Logout removes the server.
    out.length = 0;
    const code2 = await runCli(["logout"], env, { out: s => out.push(s), err: () => {} });
    expect(code2).toBe(0);
    expect(JSON.parse(out[0])).toEqual({ ok: true, url: "https://p5y.omni.ooo" });
    expect(readCredentials({ env }).servers).toEqual({});

    // Add two servers and logout --all.
    saveServerCredentials({ url: "https://a.test", token: "t1" }, { env });
    saveServerCredentials({ url: "https://b.test", token: "t2" }, { env });
    out.length = 0;
    const code3 = await runCli(["logout", "--all"], env, { out: s => out.push(s), err: () => {} });
    expect(code3).toBe(0);
    expect(JSON.parse(out[0])).toEqual({ ok: true, url: null, all: true });
    expect(removeServerCredentials({ url: "https://a.test" }, { env }).removed).toBe(false);
  });

  test("E2E: `plenary login --no-open` -> loopback callback -> credentials.json -> CLI & MCP work without PLENARY_TOKEN", async () => {
    const now = Date.now;
    const idp = await fakeIdp({ now });
    await idp.addKey("k1");
    const registry = memoryRegistry({ now });
    const sessions = await makeSessions({ key: "s".repeat(32), now });
    const tenancy = makeTenancy({ registry, now });
    await registry.createTenant({ domain: "acme.com", admins: ["google:1001"] });

    let routes = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const res = await routes(req);
        return res ?? new Response("not found", { status: 404 });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const oidc = googleOidc({
      clientId: CLIENT_ID,
      clientSecret: "secret",
      redirectUri: `${baseUrl}/auth/callback`,
      fetch: idp.fetch,
      now,
    });
    routes = httpRoutes({
      registry,
      sessions,
      oidc,
      tenancy,
      now,
      config: { cookieKey: "k".repeat(32), postLoginUrl: `${baseUrl}/`, boardUrl: `${baseUrl}/b/{board}` },
    });

    try {
      const env = { PLENARY_CREDENTIALS_PATH: credPath };
      const out = [];
      const errs = [];
      let resolveLoginUrl;
      const loginUrlReady = new Promise(r => { resolveLoginUrl = r; });

      // Start `plenary login --url <baseUrl> --no-open`
      const cliPromise = runCli(["login", "--url", baseUrl, "--no-open"], env, {
        out: s => out.push(s),
        err: s => {
          errs.push(s);
          const m = s.match(/https?:\/\/[^\s]+/);
          if (m) resolveLoginUrl(m[0]);
        },
        loginTimeoutMs: 10_000,
      });

      const loginUrl = await loginUrlReady;
      // Simulate the user's browser following loginUrl -> OIDC -> /auth/callback -> http://127.0.0.1:<port>/callback
      const startRes = await fetch(loginUrl, { redirect: "manual" });
      expect(startRes.status).toBe(302);
      const idpLoc = new URL(startRes.headers.get("location"));
      const gCode = "e2e-" + randomBytes(8).toString("hex");
      idp.codes.set(gCode, await idp.mint({ ...ADMIN, nonce: idpLoc.searchParams.get("nonce") }));
      const cbQ = new URLSearchParams({ code: gCode, state: idpLoc.searchParams.get("state") });
      const cbRes = await fetch(`${baseUrl}/auth/callback?${cbQ}`, {
        redirect: "manual",
        headers: { cookie: cookieOf(startRes, LOGIN_COOKIE) ?? "" },
      });
      expect(cbRes.status).toBe(302);
      const loopbackUrl = cbRes.headers.get("location");
      expect(loopbackUrl.startsWith("http://127.0.0.1:")).toBe(true);

      const browserFinish = await fetch(loopbackUrl);
      expect(browserFinish.status).toBe(200);
      expect(await browserFinish.text()).toContain("Signed in to Plenary");

      const exitCode = await cliPromise;
      expect(exitCode).toBe(0);
      const loginJson = JSON.parse(out[0]);
      expect(loginJson.ok).toBe(true);
      expect(loginJson.url).toBe(baseUrl);
      expect(loginJson.user).toEqual({ id: "google:1001", name: "Ann", email: "ann@acme.com" });
      expect(typeof loginJson.expiresAt).toBe("number");

      // CLI `list-boards` works automatically with NO PLENARY_TOKEN / PLENARY_URL env vars!
      const listOut = [];
      const listCode = await runCli(["list-boards"], env, { out: s => listOut.push(s), err: () => {} });
      expect(listCode).toBe(0);
      expect(JSON.parse(listOut[0])).toEqual({ boards: [], isAdmin: true });

      // MCP handler created BEFORE or AFTER login dynamically loads credentials without PLENARY_TOKEN!
      const handleMcp = createMcpHandler({ env });
      const mcpResp = await handleMcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_boards", arguments: {} },
      });
      expect(mcpResp.result.isError).toBeUndefined();
      expect(JSON.parse(mcpResp.result.content[0].text)).toEqual({ boards: [], isAdmin: true });
    } finally {
      server.stop(true);
    }
  });
});
