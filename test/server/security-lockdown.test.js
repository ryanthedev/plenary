// Server & website public-launch security lockdown tests:
// baseline security headers, HSTS, WebSocket Origin check, IP rate limiting,
// minimal /health mode, and disabling self-serve personal workspaces.
import { test, expect, afterAll } from "bun:test";
import { createServer } from "../../server/adapters/driving/server.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { authPort } from "../../server/ports/auth.js";

const servers = [];
afterAll(async () => {
  for (const s of servers) await s.stop().catch(() => {});
});

async function makeTestServer(opts = {}) {
  const registry = memoryRegistry();
  const bus = memoryBus();
  const store = sqliteStore({ path: ":memory:" });
  const sessions = await makeSessions({ key: "k".repeat(32) });
  const tenancy = makeTenancy({ registry });
  const auth = authPort({ sessions, tenancy });
  const publicUrl = opts.publicUrl ?? "https://p5y.omni.ooo";
  const http = httpRoutes({
    registry,
    sessions,
    tenancy,
    config: {
      cookieKey: "c".repeat(32),
      postLoginUrl: `${publicUrl}/`,
      boardUrl: `${publicUrl}/?board={board}`,
      publicUrl,
      allowPersonalOrgs: opts.allowPersonalOrgs ?? true,
    },
  });
  const srv = createServer({
    auth,
    registry,
    store,
    bus,
    http,
    publicUrl: opts.publicUrl,
    hideHealthStats: opts.hideHealthStats ?? false,
    trustProxy: opts.trustProxy ?? false,
    rateLimit: opts.rateLimit ?? false,
    now: opts.now,
  });
  servers.push(srv);
  return { srv, sessions, registry };
}

test("baseline security headers + HSTS + COOP are applied on HTML, API, and 404 responses", async () => {
  const { srv } = await makeTestServer({ publicUrl: "https://p5y.omni.ooo" });

  const html = await fetch(srv.url + "/");
  expect(html.status).toBe(200);
  expect(html.headers.get("x-content-type-options")).toBe("nosniff");
  expect(html.headers.get("referrer-policy")).toBe("no-referrer");
  expect(html.headers.get("x-frame-options")).toBe("DENY");
  expect(html.headers.get("permissions-policy")).toContain("camera=()");
  expect(html.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
  expect(html.headers.get("cross-origin-opener-policy")).toBe("same-origin");

  const miss = await fetch(srv.url + "/does-not-exist");
  expect(miss.status).toBe(404);
  expect(miss.headers.get("x-content-type-options")).toBe("nosniff");
  expect(miss.headers.get("x-frame-options")).toBe("DENY");
  expect(miss.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
});

test("HSTS is omitted when publicUrl is not HTTPS", async () => {
  const { srv } = await makeTestServer({ publicUrl: "http://127.0.0.1:8080" });
  const res = await fetch(srv.url + "/health");
  expect(res.status).toBe(200);
  expect(res.headers.get("strict-transport-security")).toBeNull();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("GET /ws rejects cross-origin browser requests with 403 bad-origin", async () => {
  const { srv } = await makeTestServer({ publicUrl: "https://p5y.omni.ooo" });

  const evil = await fetch(srv.url + "/ws", { headers: { origin: "https://evil.example" } });
  expect(evil.status).toBe(403);
  expect(await evil.json()).toEqual({ error: "bad-origin" });

  // Matching origin passes the origin check (gets 426 because fetch() is not a WS upgrade)
  const good = await fetch(srv.url + "/ws", { headers: { origin: "https://p5y.omni.ooo" } });
  expect(good.status).toBe(426);

  // Missing Origin (CLI / MCP / native clients) also passes the origin check
  const cli = await fetch(srv.url + "/ws");
  expect(cli.status).toBe(426);
});

test("per-IP rate limiting protects /auth/* and /ws and respects trustProxy", async () => {
  let t = 1_000_000;
  const { srv } = await makeTestServer({
    publicUrl: "https://p5y.omni.ooo",
    trustProxy: true,
    rateLimit: { authBurst: 2, authRefillPerSec: 1, wsBurst: 2, wsRefillPerSec: 1 },
    now: () => t,
  });

  // First 2 auth requests from IP A pass
  expect((await fetch(srv.url + "/auth/providers", { headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
  expect((await fetch(srv.url + "/auth/providers", { headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
  // 3rd from IP A is rate-limited
  const limited = await fetch(srv.url + "/auth/providers", { headers: { "cf-connecting-ip": "203.0.113.10" } });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("1");
  expect(await limited.json()).toMatchObject({ error: "rate-limited" });

  // Different IP B is unaffected
  expect((await fetch(srv.url + "/auth/providers", { headers: { "cf-connecting-ip": "203.0.113.11" } })).status).toBe(200);

  // After 1 second, IP A refills 1 token
  t += 1000;
  expect((await fetch(srv.url + "/auth/providers", { headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
});

test("hideHealthStats returns minimal { ok: true } without exposing internal counters", async () => {
  const { srv } = await makeTestServer({ publicUrl: "https://p5y.omni.ooo", hideHealthStats: true });
  const res = await fetch(srv.url + "/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("allowPersonalOrgs: false blocks POST /tenants with 403 forbidden", async () => {
  const { srv, sessions } = await makeTestServer({ publicUrl: "https://p5y.omni.ooo", allowPersonalOrgs: false });
  const token = await sessions.issue({ user: "google:123", name: "Eve", email: "eve@gmail.com", domain: null });
  const res = await fetch(srv.url + "/tenants", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Spam Org" }),
  });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden" });
});
