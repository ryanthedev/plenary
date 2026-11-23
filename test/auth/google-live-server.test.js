// LIVE check of Google sign-in against the REAL server (brief p5-google2): server/main.js start(env) on
// 127.0.0.1:8080 (the OAuth client's redirect URI fixes the port), Google's real endpoints, dev tokens off.
// Skipped unless PLENARY_LIVE_GOOGLE=1 and .env has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
//
//   PLENARY_LIVE_GOOGLE=1 bun test test/auth/google-live-server.test.js
//
// Never logs in (a human does that). Never prints the client id or secret, COOKIE_KEY, the per-run keys or a session
// token: the env is built here and handed to start() in-process (nothing on a command line), the server's stdout is
// captured (not echoed) and scanned, and URLs are reported as origin + path. Refuses to run if 8080 is taken on
// 127.0.0.1 or ::1 (by anything, HTTP or not: p5-googlev LOW 2).

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../../server/main.js";
import { safeFetch, probeAuthorize, portBusy, REDIRECT_URI } from "../../scripts/dev-google.js";
import { GOOGLE } from "../../server/adapters/driven/auth/oidc.js";
import { LOGIN_COOKIE } from "../../server/adapters/driving/auth-http.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { bootstrapTenant } from "../../server/core/admin/tenants.js";
import { sock } from "../server/rig.js";

const ID = process.env.GOOGLE_CLIENT_ID, SECRET = process.env.GOOGLE_CLIENT_SECRET, ENV_COOKIE_KEY = process.env.COOKIE_KEY;
const LIVE = process.env.PLENARY_LIVE_GOOGLE === "1" && !!ID && !!SECRET;
const PORT = 8080;
const BASE = `http://127.0.0.1:${PORT}`;
const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const where = u => { const x = new URL(u); return x.origin + x.pathname; };

describe.skipIf(!LIVE)("Google sign-in on the real server, live (PLENARY_LIVE_GOOGLE=1)", () => {
  const dataDir = LIVE ? mkdtempSync(join(tmpdir(), "plenary-live-google-")) : "";
  const COOKIE_KEY = rand(), SESSION_KEY = rand(), WRONG_SECRET = "wrong-" + rand();
  const secrets = () => [ID, SECRET, ENV_COOKIE_KEY, COOKIE_KEY, SESSION_KEY, WRONG_SECRET, ...minted].filter(Boolean);
  const leaks = s => secrets().some(x => s.includes(x));
  const minted = [];                    // session tokens this test made: must appear in no log either
  const out = [];                       // everything the server wrote to stdout
  const seen = [];                      // response bodies + headers, scanned at the end
  const tokenCalls = [];                // { status, error } of each call to Google's token endpoint
  let app = null, write = null;

  const spyFetch = async (input, init) => {
    const res = await safeFetch(input, init);             // a thrown error never carries the URL
    if (String(input) === GOOGLE.token) {
      let error = null;
      try { error = (await res.clone().json())?.error ?? null; } catch {}
      tokenCalls.push({ status: res.status, error });
    }
    return res;
  };
  const envFor = clientSecret => ({
    PORT: String(PORT), HOST: "127.0.0.1", PLENARY_DATA_DIR: dataDir, LOG_LEVEL: "info",
    GOOGLE_CLIENT_ID: ID, GOOGLE_CLIENT_SECRET: clientSecret, COOKIE_KEY, SESSION_KEY,
    // no PLENARY_DEV_TOKENS (dev tokens off), no DATABASE_URL / NATS_URL (single node)
  });
  const boot = async clientSecret => { app = await start(envFor(clientSecret), { fetch: spyFetch }); };
  const keep = async res => { const text = await res.text(); seen.push(text, [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")); return text; };
  const logLines = () => out.join("").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });

  beforeAll(async () => {
    if (await portBusy(PORT)) throw new Error(`port ${PORT} is taken (127.0.0.1 or ::1); stop that first: the redirect URI fixes the port`);
    write = process.stdout.write;
    process.stdout.write = s => { out.push(String(s)); return true; };   // captured, never echoed
    await boot(SECRET);
  });
  afterAll(async () => {
    try { await app?.stop(); } finally {
      if (write) process.stdout.write = write;
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function login() {
    const res = await fetch(BASE + "/auth/login", { redirect: "manual" });
    // The Location carries the client id by OAuth's design (the browser must send it to Google): it is scanned for
    // every other secret here, and kept out of the scan of `seen`.
    const loc = res.headers.get("location") ?? "";
    expect(secrets().filter(x => x !== ID).some(x => loc.includes(x))).toBe(false);
    seen.push(await res.clone().text(), [...res.headers].filter(([k]) => k !== "location").map(([k, v]) => `${k}: ${v}`).join("\n"));
    return { res, location: res.headers.get("location"), cookie: res.headers.get("set-cookie") ?? "" };
  }

  test("the real server started with Google on and dev tokens off, and its log is being captured", () => {
    const l = logLines();
    expect(l.some(x => x.msg === "server listening" && x.port === PORT)).toBe(true);
    // `devTokens` itself reads "[redacted]": server/log.js redacts any field whose key looks like a credential.
    expect(l.find(x => x.msg === "sign-in")).toMatchObject({ google: true, cluster: false });
    expect(l.some(x => x.msg === "dev tokens are ON: not for production")).toBe(false);
    expect(l.some(x => x.msg === "dev tokens are off: sign-in is Google only")).toBe(true);
    expect(app.devBoard).toBeNull();
  });

  test("GET /auth/login: 302 to Google with the full authorization request; login cookie HttpOnly, SameSite=Lax", async () => {
    const { res, location, cookie } = await login();
    expect(res.status).toBe(302);
    expect(where(location)).toBe(GOOGLE.authorize);
    const q = new URL(location).searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id") === ID).toBe(true);               // compared, never printed
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(REDIRECT_URI).toBe("http://localhost:8080/auth/callback");
    expect(q.get("scope").split(" ")).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
    expect(q.get("state")).toMatch(/^[a-z0-9]{32}$/);
    expect(q.get("nonce")).toMatch(/^[a-z0-9]{32}$/);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(cookie.startsWith(LOGIN_COOKIE + "=l1.")).toBe(true);
    for (const a of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/", "Max-Age=600"]) expect(cookie).toContain(a);
  });

  test("following it once (plain GET, no cookies) reaches Google's sign-in page, not an error", async () => {
    const { location } = await login();
    const g = await probeAuthorize(location);
    console.log(`google: ${g.status} ${g.where} errors=[${g.errors.join(",")}]`);
    expect(g.status).toBe(200);
    expect(g.errors).toEqual([]);
    expect(g.path).toMatch(/\/signin\/identifier$/);
  });

  test("callback with the right secret and a bogus code: Google says invalid_grant; we refuse cleanly and log the cause", async () => {
    const { location, cookie } = await login();
    const state = new URL(location).searchParams.get("state");
    const before = tokenCalls.length, logsBefore = logLines().length;
    const res = await fetch(`${BASE}/auth/callback?state=${state}&code=4%2F0-bogus-code`, { redirect: "manual", headers: { cookie: cookie.split(";")[0] } });
    const text = await keep(res);
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "login-failed" });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(res.headers.get("location")).toBeNull();
    expect(tokenCalls.slice(before)).toEqual([{ status: 400, error: "invalid_grant" }]);
    const fresh = logLines().slice(logsBefore);
    expect(fresh.filter(l => l.msg === "sign-in failed")).toEqual([expect.objectContaining({ level: "warn", cause: "invalid_grant" })]);
    console.log(`right secret: token endpoint ${JSON.stringify(tokenCalls.slice(before))}; log cause invalid_grant`);
    expect((await fetch(BASE + "/health")).status).toBe(200);    // still up
  });

  test("WebSocket hello on the real gateway: a valid session joins; no token and a bad token are refused", async () => {
    // A tenant and its admin, as scripts/admin-bootstrap.js would make them (same Registry, same use case).
    await bootstrapTenant({ registry: app.registry, domain: "live-check.example", admins: ["admin@live-check.example"] });
    const sessions = await makeSessions({ key: SESSION_KEY });   // the server's per-run key: tokens die with the run
    const token = await sessions.issue({ user: "google:live-check-1", name: "Live Check", email: "admin@live-check.example", domain: "live-check.example" });
    minted.push(token);
    const made = await fetch(BASE + "/boards", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ title: "live check" }) });
    const board = JSON.parse(await keep(made)).board;
    expect(made.status).toBe(201);
    expect(typeof board.id).toBe("string");

    const ok = await sock(`ws://127.0.0.1:${PORT}/ws`);
    ok.send({ t: "hello", v: 1, token, board: board.id, since: 0, client: "live" });
    const w = await ok.next(m => m.t === "welcome" || m.t === "error", "welcome");
    expect(w.t).toBe("welcome");
    await ok.close();

    for (const [label, tok] of [["no token", undefined], ["empty", ""], ["forged", "s1.x.y"], ["other key", await (await makeSessions({ key: rand() })).issue({ user: "google:x", name: null, email: null, domain: null })]]) {
      const s = await sock(`ws://127.0.0.1:${PORT}/ws`);
      s.send({ t: "hello", v: 1, ...(tok === undefined ? {} : { token: tok }), board: board.id, since: 0, client: "bad" });
      const closed = await s.whenClosed(10_000);
      expect({ label, code: closed.code }).toEqual({ label, code: 1008 });
      expect(s.msgs.some(m => m.t === "welcome")).toBe(false);
      expect(s.msgs.some(m => m.t === "error" && m.code === "auth")).toBe(true);
    }
  });

  test("wrong-secret control: Google's token endpoint says invalid_client through our callback; no crash, cause logged", async () => {
    await app.stop(); app = null;
    expect(await portBusy(PORT)).toBe(false);
    await boot(WRONG_SECRET);
    const { location, cookie } = await login();
    const state = new URL(location).searchParams.get("state");
    const before = tokenCalls.length, logsBefore = logLines().length;
    const res = await fetch(`${BASE}/auth/callback?state=${state}&code=4%2F0-bogus-code`, { redirect: "manual", headers: { cookie: cookie.split(";")[0] } });
    expect(res.status).toBe(400);
    expect(JSON.parse(await keep(res))).toEqual({ error: "login-failed" });
    expect(tokenCalls.slice(before)).toEqual([{ status: 401, error: "invalid_client" }]);
    expect(logLines().slice(logsBefore).filter(l => l.msg === "sign-in failed")).toEqual([expect.objectContaining({ cause: "invalid_client" })]);
    console.log(`wrong secret: token endpoint ${JSON.stringify(tokenCalls.slice(before))}; log cause invalid_client`);
    expect((await fetch(BASE + "/health")).status).toBe(200);
  });

  test("nothing secret in any response or in the server's whole log (and the log is not empty)", async () => {
    const all = out.join("");
    expect(all.length).toBeGreaterThan(200);
    expect(all).toContain("server listening");
    expect(leaks(all)).toBe(false);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.some(leaks)).toBe(false);
    expect(all.includes("4/0-bogus-code") || all.includes("bogus-code")).toBe(false);
    console.log(`scan: ${secrets().length} values against ${all.length} log chars and ${seen.length} response parts: 0 hits`);
  });

  test("stopping frees port 8080", async () => {
    await app.stop(); app = null;
    expect(await portBusy(PORT)).toBe(false);
  });
});

test("live real-server Google check is opt-in", () => {
  if (!LIVE) console.log("google-live-server: skipped (set PLENARY_LIVE_GOOGLE=1 with GOOGLE_CLIENT_ID/SECRET in .env)");
  expect(true).toBe(true);
});
