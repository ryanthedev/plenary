// @ts-check
import { describe, test, expect } from "bun:test";
import {
  WEBHOOK_EVENTS,
  validateWebhookUrl,
  validateWebhookSubscription,
  signWebhookPayload,
  verifyWebhookSignature,
  createRateLimiter,
  generateWebhookSecret,
} from "../../server/core/webhooks.js";
import { WEBHOOK_DELIVERY_METHODS } from "../../server/ports/webhook-delivery.js";
import { httpWebhookDelivery } from "../../server/adapters/driven/webhooks/http.js";
import { memoryWebhookDelivery } from "../../server/adapters/driven/webhooks/memory.js";
import { publicApiRoutes } from "../../server/adapters/driving/public-api-http.js";

describe("core/webhooks: URL & subscription validation", () => {
  test("accepts valid HTTPS public webhook URLs", () => {
    const res = validateWebhookUrl("https://hooks.example.com/plenary/events");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toBe("https://hooks.example.com/plenary/events");
  });

  test("rejects non-HTTPS schemes and embedded credentials", () => {
    expect(validateWebhookUrl("http://hooks.example.com/events")).toMatchObject({ ok: false, code: "https-required" });
    expect(validateWebhookUrl("ftp://hooks.example.com/events")).toMatchObject({ ok: false, code: "https-required" });
    expect(validateWebhookUrl("https://user:pass@hooks.example.com/events")).toMatchObject({ ok: false, code: "forbidden-credentials" });
    expect(validateWebhookUrl("not a url")).toMatchObject({ ok: false, code: "bad-url" });
  });

  test("SSRF guard rejects loopback, private, link-local, metadata, and IPv6 local hosts", () => {
    const blocked = [
      "https://localhost/hook",
      "https://sub.localhost/hook",
      "https://127.0.0.1/hook",
      "https://127.12.34.56/hook",
      "https://10.0.0.1/hook",
      "https://172.16.0.1/hook",
      "https://172.31.255.254/hook",
      "https://192.168.1.10/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/hook",
      "https://0.0.0.0/hook",
      "https://[::1]/hook",
      "https://[::]/hook",
      "https://[fe80::1]/hook",
      "https://[fd00::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:169.254.169.254]/hook",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://printer.local/hook",
      "https://service.internal/hook",
      "https://intranet/hook",
    ];
    for (const u of blocked) {
      const res = validateWebhookUrl(u);
      expect([u, res.ok]).toEqual([u, false]);
    }
    // Public IP outside RFC1918 ranges is allowed
    expect(validateWebhookUrl("https://172.32.0.1/hook").ok).toBe(true);
    expect(validateWebhookUrl("https://93.184.216.34/hook").ok).toBe(true);
  });

  test("validates events against WEBHOOK_EVENTS and deduplicates", () => {
    expect(WEBHOOK_EVENTS).toEqual(["board.changed", "comment.added", "role.changed"]);
    const ok = validateWebhookSubscription({
      url: "https://hooks.example.com/plenary",
      events: ["board.changed", "comment.added", "board.changed"],
      secret: "whsec_0123456789abcdef0123456789abcdef",
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.events).toEqual(["board.changed", "comment.added"]);
      expect(ok.value.active).toBe(true);
    }

    expect(validateWebhookSubscription({ url: "https://hooks.example.com/p", events: [] })).toMatchObject({ ok: false, code: "bad-events" });
    expect(validateWebhookSubscription({ url: "https://hooks.example.com/p", events: ["board.deleted"] })).toMatchObject({ ok: false, code: "bad-events" });
    expect(validateWebhookSubscription({ url: "https://hooks.example.com/p", events: ["board.changed"], secret: "short" })).toMatchObject({ ok: false, code: "bad-secret" });
  });
});

describe("core/webhooks: HMAC-SHA256 signing & verification", () => {
  const secret = "whsec_test_secret_key_1234567890";
  const body = JSON.stringify({ id: "evt-1", type: "board.changed", data: { boardId: "b-1" } });

  test("signWebhookPayload produces t=...,v1=... and verifyWebhookSignature validates it", async () => {
    const ts = 1_700_000_000;
    const header = await signWebhookPayload(secret, ts, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);

    expect(await verifyWebhookSignature(secret, body, header, { nowSec: ts + 10 })).toBe(true);
    expect(await verifyWebhookSignature(secret, body + " ", header, { nowSec: ts + 10 })).toBe(false);
    expect(await verifyWebhookSignature("wrong_secret_1234567890", body, header, { nowSec: ts + 10 })).toBe(false);
  });

  test("rejects replayed timestamps outside toleranceSec", async () => {
    const ts = 1_700_000_000;
    const header = await signWebhookPayload(secret, ts, body);
    expect(await verifyWebhookSignature(secret, body, header, { nowSec: ts + 301, toleranceSec: 300 })).toBe(false);
    expect(await verifyWebhookSignature(secret, body, header, { nowSec: ts - 301, toleranceSec: 300 })).toBe(false);
    expect(await verifyWebhookSignature(secret, body, header, { nowSec: ts + 300, toleranceSec: 300 })).toBe(true);
  });

  test("supports key rotation with multiple v1 signatures", async () => {
    const ts = 1_700_000_000;
    const valid = await signWebhookPayload(secret, ts, body);
    const fakeV1 = "0".repeat(64);
    const rotated = `${valid},v1=${fakeV1}`;
    expect(await verifyWebhookSignature(secret, body, rotated, { nowSec: ts })).toBe(true);
  });
});

describe("core/webhooks: token-bucket rate limiter", () => {
  test("enforces burst capacity, refills over time, and computes Retry-After", () => {
    let nowMs = 1_000_000;
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 1, clock: () => nowMs });

    expect(rl.consume("tok-1")).toMatchObject({ allowed: true, remaining: 2, retryAfterSec: 0 });
    expect(rl.consume("tok-1")).toMatchObject({ allowed: true, remaining: 1, retryAfterSec: 0 });
    expect(rl.consume("tok-1")).toMatchObject({ allowed: true, remaining: 0, retryAfterSec: 0 });

    const denied = rl.consume("tok-1");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSec).toBe(1);

    // Separate key has its own bucket
    expect(rl.consume("tok-2")).toMatchObject({ allowed: true, remaining: 2 });

    // Advance 1.5 seconds -> 1.5 tokens refilled, 1 allowed
    nowMs += 1500;
    expect(rl.consume("tok-1")).toMatchObject({ allowed: true, remaining: 0 });
    expect(rl.consume("tok-1").allowed).toBe(false);

    // Advance 10 seconds -> capped at capacity 3
    nowMs += 10_000;
    expect(rl.remaining("tok-1")).toBe(3);
  });
});

describe("adapters/driven/webhooks: http & memory", () => {
  const secret = generateWebhookSecret();
  const sub = {
    id: "wh-1",
    url: "https://hooks.example.com/plenary",
    secret,
    events: /** @type {const} */ (["board.changed"]),
  };
  const event = {
    id: "evt-1",
    type: /** @type {const} */ ("board.changed"),
    timestamp: 1_700_000_000_000,
    data: { boardId: "b-1", title: "Q3 Roadmap" },
  };

  test("port lists deliver method and memory adapter records verifiable signed deliveries", async () => {
    expect(WEBHOOK_DELIVERY_METHODS).toEqual(["deliver"]);
    const mem = memoryWebhookDelivery({ now: () => 1_700_000_000_000 });
    const res = await mem.deliver(sub, event);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(mem.deliveries).toHaveLength(1);

    const rec = mem.deliveries[0];
    expect(rec.headers["x-plenary-event"]).toBe("board.changed");
    expect(rec.headers["x-plenary-delivery"]).toBe("evt-1");
    expect(await verifyWebhookSignature(secret, rec.body, rec.signature, { nowSec: 1_700_000_000 })).toBe(true);

    mem.setFailure(sub.url, { status: 503, error: "upstream-5xx", times: 1 });
    const failed = await mem.deliver(sub, event);
    expect(failed.ok).toBe(false);
    expect(failed.status).toBe(503);
  });

  test("http adapter sends signed X-Plenary-Signature and retries on 5xx", async () => {
    let calls = 0;
    /** @type {Array<{ url: string, headers: Record<string, string>, body: string, redirect?: string }>} */
    const seen = [];
    const sleeps = [];

    const adapter = httpWebhookDelivery({
      now: () => 1_700_000_000_000,
      maxRetries: 2,
      baseBackoffMs: 50,
      sleep: async ms => { sleeps.push(ms); },
      fetchImpl: /** @type {typeof fetch} */ (async (url, init) => {
        calls++;
        seen.push({
          url: String(url),
          headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
          body: String(init?.body ?? ""),
          redirect: init?.redirect,
        });
        if (calls < 3) return new Response("unavailable", { status: 503 });
        return new Response("ok", { status: 200 });
      }),
    });

    const res = await adapter.deliver(sub, event);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(sleeps).toEqual([50, 100]);
    expect(seen[0].redirect).toBe("error");
    expect(await verifyWebhookSignature(secret, seen[2].body, seen[2].headers["x-plenary-signature"], { nowSec: 1_700_000_000 })).toBe(true);
  });

  test("http adapter does NOT retry 4xx responses", async () => {
    let calls = 0;
    const adapter = httpWebhookDelivery({
      maxRetries: 3,
      baseBackoffMs: 1,
      sleep: async () => {},
      fetchImpl: /** @type {typeof fetch} */ (async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      }),
    });

    const res = await adapter.deliver(sub, event);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("http adapter blocks SSRF targets without calling fetch", async () => {
    let called = false;
    const adapter = httpWebhookDelivery({
      fetchImpl: /** @type {typeof fetch} */ (async () => {
        called = true;
        return new Response("ok", { status: 200 });
      }),
    });
    const res = await adapter.deliver({ ...sub, url: "https://169.254.169.254/latest/meta-data/" }, event);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden-host");
    expect(res.attempts).toBe(0);
    expect(called).toBe(false);
  });

  test("http adapter enforces request timeout and retries", async () => {
    let calls = 0;
    const adapter = httpWebhookDelivery({
      timeoutMs: 15,
      maxRetries: 1,
      baseBackoffMs: 1,
      sleep: async () => {},
      fetchImpl: /** @type {typeof fetch} */ ((_url, init) => {
        calls++;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }),
    });

    const res = await adapter.deliver(sub, event);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timeout");
    expect(res.attempts).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("adapters/driving/public-api-http: versioned REST API", () => {
  function setup({ capacity = 10, refillPerSec = 1 } = {}) {
    let nowMs = 1_700_000_000_000;
    const boardStore = new Map([
      ["b-alpha", { id: "b-alpha", title: "Alpha Architecture", tenant: "t-1" }],
    ]);
    const webhookStore = new Map();
    let seq = 1;

    /** @type {Record<string, { tokenId: string, tenant: string, user: string, scopes: string[] }>} */
    const tokens = {
      "full-token": { tokenId: "tok-full", tenant: "t-1", user: "u-1", scopes: ["boards:read", "boards:write", "webhooks:read", "webhooks:write"] },
      "readonly-token": { tokenId: "tok-ro", tenant: "t-1", user: "u-2", scopes: ["boards:read"] },
    };

    const api = publicApiRoutes({
      verifyApiToken: tok => tokens[tok] ?? null,
      boards: {
        list: () => [...boardStore.values()],
        create: (p, { title, space }) => {
          const id = `b-${seq++}`;
          const rec = { id, title, tenant: p.tenant, ...(space ? { space } : {}) };
          boardStore.set(id, rec);
          return rec;
        },
        get: (_p, id) => boardStore.get(id) ?? null,
      },
      webhooks: {
        list: () => [...webhookStore.values()],
        create: (_p, sub) => {
          const id = `wh-${seq++}`;
          const rec = { id, ...sub, createdAt: nowMs };
          webhookStore.set(id, rec);
          return rec;
        },
        remove: (_p, id) => webhookStore.delete(id),
      },
      rateLimit: { capacity, refillPerSec },
      clock: () => nowMs,
    });

    const req = (method, path, { token = "full-token", body } = {}) =>
      api.handle(
        new Request(`https://plenary.example${path}`, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
        }),
      );

    return { api, req, advanceMs: ms => { nowMs += ms; } };
  }

  test("returns undefined for non-/api/v1/ routes", async () => {
    const { api } = setup();
    const res = await api.handle(new Request("https://plenary.example/health"));
    expect(res).toBeUndefined();
  });

  test("enforces Bearer auth and scopes with JSON error envelopes", async () => {
    const { req } = setup();
    const noAuth = await req("GET", "/api/v1/boards", { token: "" });
    expect(noAuth?.status).toBe(401);
    expect(await noAuth?.json()).toMatchObject({ error: { code: "unauthorized" } });

    const badAuth = await req("GET", "/api/v1/boards", { token: "invalid" });
    expect(badAuth?.status).toBe(401);

    const forbidden = await req("POST", "/api/v1/boards", { token: "readonly-token", body: { title: "Blocked" } });
    expect(forbidden?.status).toBe(403);
    expect(await forbidden?.json()).toMatchObject({ error: { code: "insufficient-scope" } });
  });

  test("supports boards list, create, and get", async () => {
    const { req } = setup();
    const listRes = await req("GET", "/api/v1/boards");
    expect(listRes?.status).toBe(200);
    expect((await listRes?.json()).boards).toHaveLength(1);

    const createRes = await req("POST", "/api/v1/boards", { body: { title: "Incident War Room" } });
    expect(createRes?.status).toBe(201);
    const created = (await createRes?.json()).board;
    expect(created.title).toBe("Incident War Room");

    const getRes = await req("GET", `/api/v1/boards/${created.id}`);
    expect(getRes?.status).toBe(200);
    expect((await getRes?.json()).board.id).toBe(created.id);

    const missing = await req("GET", "/api/v1/boards/does-not-exist");
    expect(missing?.status).toBe(404);
  });

  test("supports webhooks create (returning secret once), list (redacting secret), SSRF reject, and delete", async () => {
    const { req } = setup();

    const ssrf = await req("POST", "/api/v1/webhooks", {
      body: { url: "https://127.0.0.1/evil", events: ["board.changed"] },
    });
    expect(ssrf?.status).toBe(400);
    expect(await ssrf?.json()).toMatchObject({ error: { code: "forbidden-host" } });

    const createRes = await req("POST", "/api/v1/webhooks", {
      body: { url: "https://hooks.example.com/plenary", events: ["board.changed", "comment.added"] },
    });
    expect(createRes?.status).toBe(201);
    const created = (await createRes?.json()).webhook;
    expect(created.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const listRes = await req("GET", "/api/v1/webhooks");
    expect(listRes?.status).toBe(200);
    const listed = (await listRes?.json()).webhooks;
    expect(listed).toHaveLength(1);
    expect(listed[0].secret).toBeUndefined();

    const delRes = await req("DELETE", `/api/v1/webhooks/${created.id}`);
    expect(delRes?.status).toBe(200);
    expect(await delRes?.json()).toEqual({ deleted: true, id: created.id });

    const delAgain = await req("DELETE", `/api/v1/webhooks/${created.id}`);
    expect(delAgain?.status).toBe(404);
  });

  test("enforces per-token rate limiting with 429 and Retry-After header", async () => {
    const { req, advanceMs } = setup({ capacity: 2, refillPerSec: 1 });

    expect((await req("GET", "/api/v1/boards"))?.status).toBe(200);
    expect((await req("GET", "/api/v1/boards"))?.status).toBe(200);

    const limited = await req("GET", "/api/v1/boards");
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("1");
    expect(await limited?.json()).toMatchObject({ error: { code: "rate-limited", retryAfterSec: 1 } });

    // Other token is unaffected
    expect((await req("GET", "/api/v1/boards", { token: "readonly-token" }))?.status).toBe(200);

    // After 1 second, token refills
    advanceMs(1000);
    expect((await req("GET", "/api/v1/boards"))?.status).toBe(200);
  });
});
