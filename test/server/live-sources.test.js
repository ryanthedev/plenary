// @ts-check
import { describe, test, expect } from "bun:test";
import { makeElement } from "../../packages/core/model.js";
import {
  LIVE_SOURCES_METHODS,
  parseK8sQuery,
  extractFieldPath,
  redactSecrets,
} from "../../server/ports/live-sources.js";
import { httpLiveSources } from "../../server/adapters/driven/live-sources/http.js";
import { memoryLiveSources } from "../../server/adapters/driven/live-sources/memory.js";
import {
  handleLiveValuesRequest,
  handleLiveSourcesListRequest,
} from "../../server/adapters/driving/live-sources-http.js";

describe("server/live-sources/port helpers", () => {
  test("parseK8sQuery accepts read-only API paths and shorthands, rejects traversal", () => {
    expect(parseK8sQuery("/api/v1/namespaces/prod/pods/api-0")).toBe("/api/v1/namespaces/prod/pods/api-0");
    expect(parseK8sQuery("/apis/apps/v1/namespaces/prod/deployments/api")).toBe("/apis/apps/v1/namespaces/prod/deployments/api");
    expect(parseK8sQuery("prod/deployments/api")).toBe("/apis/apps/v1/namespaces/prod/deployments/api");
    expect(parseK8sQuery("default/pods/web-1")).toBe("/api/v1/namespaces/default/pods/web-1");

    expect(() => parseK8sQuery("/api/v1/namespaces/prod/pods/../secrets/db")).toThrow();
    expect(() => parseK8sQuery("/api/v1/namespaces/prod/pods/api?watch=true")).toThrow();
    expect(() => parseK8sQuery("/api/v1/namespaces/prod/pods/%2e%2e/secrets")).toThrow();
    expect(() => parseK8sQuery("/metrics")).toThrow();
    expect(() => parseK8sQuery("prod/secrets/db-pass")).toThrow();
  });

  test("extractFieldPath reads nested fields and blocks prototype traversal", () => {
    const dep = {
      status: {
        readyReplicas: 3,
        conditions: [{ type: "Available", status: "True" }],
      },
    };
    expect(extractFieldPath(dep, "status.readyReplicas")).toBe(3);
    expect(extractFieldPath(dep, "status.conditions.0.status")).toBe("True");
    expect(extractFieldPath(dep, undefined)).toBe(3);
    expect(extractFieldPath(dep, "__proto__.toString")).toBeNull();
    expect(extractFieldPath(dep, "constructor.name")).toBeNull();
  });

  test("redactSecrets scrubs explicit tokens, auth headers, and URLs", () => {
    const out = redactSecrets(
      "request to https://prom.internal:9090/api failed with Authorization: Bearer super-secret-tok-999",
      ["super-secret-tok-999"],
    );
    expect(out).not.toContain("super-secret-tok-999");
    expect(out).not.toContain("prom.internal");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("[REDACTED_URL]");
  });
});

describe("server/live-sources/http — Prometheus, K8s, SSRF & secret isolation", () => {
  test("implements the full LiveSourcesPort surface and hides URLs/authEnv in listSources()", () => {
    const adapter = httpLiveSources({
      allowHosts: ["prom.internal.example", "k8s.internal.example"],
      sources: [
        {
          id: "prom-prod",
          kind: "metric",
          baseUrl: "https://prom.internal.example",
          authEnv: "PROM_PROD_TOKEN",
          label: "Prod Prometheus",
        },
        {
          id: "k8s-prod",
          kind: "k8s",
          baseUrl: "https://k8s.internal.example",
          authEnv: "K8S_PROD_TOKEN",
          label: "Prod K8s",
        },
      ],
    });
    for (const m of LIVE_SOURCES_METHODS) {
      expect(typeof adapter[m]).toBe("function");
    }
    const listed = adapter.listSources();
    expect(listed).toEqual([
      { id: "prom-prod", kind: "metric", label: "Prod Prometheus" },
      { id: "k8s-prod", kind: "k8s", label: "Prod K8s" },
    ]);
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain("prom.internal");
    expect(raw).not.toContain("PROM_PROD_TOKEN");
    expect(raw).not.toContain("baseUrl");
  });

  test("reads Prometheus instant query and K8s object using server-side env credentials", async () => {
    /** @type {Array<{ url: string, init: RequestInit | undefined }>} */
    const calls = [];
    const fakeFetch = /** @type {typeof fetch} */ (async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v1/query")) {
        return new Response(
          JSON.stringify({
            status: "success",
            data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "84.25"] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("/apis/apps/v1/namespaces/prod/deployments/api")) {
        return new Response(
          JSON.stringify({ status: { readyReplicas: 4, replicas: 4 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const adapter = httpLiveSources({
      allowHosts: ["prom.corp.example", "k8s.corp.example"],
      env: {
        PROM_SECRET: "prom-tok-xyz987",
        K8S_SECRET: "k8s-sa-tok-abc123",
      },
      fetchImpl: fakeFetch,
      now: () => 1_700_000_000_000,
      sources: [
        { id: "prom", kind: "metric", baseUrl: "https://prom.corp.example", authEnv: "PROM_SECRET" },
        { id: "k8s", kind: "k8s", baseUrl: "https://k8s.corp.example", authEnv: "K8S_SECRET" },
      ],
    });

    const resolved = await adapter.resolveForBoard("board-1", [
      { elementId: "el-cpu", binding: { sourceId: "prom", kind: "metric", query: "cpu_pct" } },
      { elementId: "el-cpu-dup", binding: { sourceId: "prom", kind: "metric", query: "cpu_pct" } },
      { elementId: "el-dep", binding: { sourceId: "k8s", kind: "k8s", query: "prod/deployments/api", field: "status.readyReplicas" } },
    ]);

    // Deduplication: 2 elements bound to same metric query produce 1 upstream request + 1 k8s request = 2 total
    expect(calls).toHaveLength(2);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.redirect).toBe("error");
    expect(/** @type {Record<string, string>} */ (calls[0].init?.headers).authorization).toBe("Bearer prom-tok-xyz987");
    expect(/** @type {Record<string, string>} */ (calls[1].init?.headers).authorization).toBe("Bearer k8s-sa-tok-abc123");

    expect(resolved["el-cpu"]).toEqual({ ok: true, value: 84.25, fetchedAt: 1_700_000_000_000 });
    expect(resolved["el-cpu-dup"]).toEqual({ ok: true, value: 84.25, fetchedAt: 1_700_000_000_000 });
    expect(resolved["el-dep"]).toEqual({ ok: true, value: 4, fetchedAt: 1_700_000_000_000 });
  });

  test("SSRF & allow-list enforcement: rejects non-allowlisted hosts, metadata IPs, http:, and embedded userinfo", async () => {
    let fetchCalled = false;
    const fakeFetch = /** @type {typeof fetch} */ (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const adapter = httpLiveSources({
      allowHosts: ["*.corp.example"],
      fetchImpl: fakeFetch,
      sources: [],
    });

    // Non-allowlisted host
    await expect(
      adapter.readMetric({ id: "evil", kind: "metric", baseUrl: "https://evil.attacker.test" }, "up"),
    ).rejects.toMatchObject({ code: "forbidden-host" });

    // Cloud metadata IP (even if someone tried to allow-list it)
    const metaAdapter = httpLiveSources({
      allowHosts: ["169.254.169.254", "metadata.google.internal"],
      fetchImpl: fakeFetch,
    });
    await expect(
      metaAdapter.readMetric({ id: "meta", kind: "metric", baseUrl: "https://169.254.169.254" }, "up"),
    ).rejects.toMatchObject({ code: "forbidden-host" });
    await expect(
      metaAdapter.readMetric({ id: "gcp", kind: "metric", baseUrl: "https://metadata.google.internal" }, "up"),
    ).rejects.toMatchObject({ code: "forbidden-host" });

    // Plaintext HTTP rejected by default
    await expect(
      adapter.readMetric({ id: "plain", kind: "metric", baseUrl: "http://prom.corp.example" }, "up"),
    ).rejects.toMatchObject({ code: "forbidden-scheme" });

    // Embedded credentials in baseUrl rejected
    await expect(
      adapter.readMetric({ id: "creds", kind: "metric", baseUrl: "https://admin:secret@prom.corp.example" }, "up"),
    ).rejects.toMatchObject({ code: "forbidden-credentials" });

    // Never invoked fetch for any blocked target
    expect(fetchCalled).toBe(false);
  });

  test("enforces response size cap and timeout, and redacts secrets from upstream errors", async () => {
    const bigFetch = /** @type {typeof fetch} */ (async () =>
      new Response("x".repeat(4096), { status: 200, headers: { "content-length": "4096" } }),
    );
    const capped = httpLiveSources({
      allowHosts: ["prom.corp.example"],
      fetchImpl: bigFetch,
      defaultMaxResponseBytes: 512,
    });
    await expect(
      capped.readMetric({ id: "prom", kind: "metric", baseUrl: "https://prom.corp.example" }, "up"),
    ).rejects.toMatchObject({ code: "too-large" });

    const slowFetch = /** @type {typeof fetch} */ (async (_url, init) => {
      return await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const timed = httpLiveSources({
      allowHosts: ["prom.corp.example"],
      fetchImpl: slowFetch,
      defaultTimeoutMs: 25,
    });
    await expect(
      timed.readMetric({ id: "prom", kind: "metric", baseUrl: "https://prom.corp.example" }, "up"),
    ).rejects.toMatchObject({ code: "timeout" });

    const leakyFetch = /** @type {typeof fetch} */ (async () => {
      throw new Error("ECONNREFUSED https://prom.corp.example with Bearer top-secret-token-999");
    });
    const redacting = httpLiveSources({
      allowHosts: ["prom.corp.example"],
      env: { SECRET_ENV: "top-secret-token-999" },
      fetchImpl: leakyFetch,
    });
    try {
      await redacting.readMetric(
        { id: "prom", kind: "metric", baseUrl: "https://prom.corp.example", authEnv: "SECRET_ENV" },
        "up",
      );
      expect.unreachable("should have thrown");
    } catch (/** @type {any} */ err) {
      expect(err.message).not.toContain("top-secret-token-999");
      expect(err.message).not.toContain("prom.corp.example");
    }
  });
});

describe("server/live-sources/memory & handler — authenticated evaluation without leaking secrets", () => {
  const mem = memoryLiveSources({
    now: () => 50_000,
    sources: [
      {
        id: "prom-prod",
        kind: "metric",
        baseUrl: "https://secret-prom.internal:9090",
        authEnv: "SUPER_SECRET_PROM_TOKEN",
        label: "Prod Prometheus",
      },
      {
        id: "k8s-prod",
        kind: "k8s",
        baseUrl: "https://secret-k8s.internal:6443",
        authEnv: "SUPER_SECRET_K8S_TOKEN",
        label: "Prod Cluster",
      },
    ],
    metrics: {
      "prom-prod": {
        "api_error_rate": 12.5,
      },
    },
    k8s: {
      "k8s-prod": {
        "prod/deployments/billing": {
          status: { readyReplicas: 1, replicas: 3 },
        },
      },
    },
  });

  const elements = [
    makeElement("rectangle", {
      id: "el-api",
      customData: {
        liveBinding: {
          sourceId: "prom-prod",
          kind: "metric",
          query: "api_error_rate",
          unit: "%",
          thresholds: [
            { op: ">", value: 5, strokeColor: "#e03131", backgroundColor: "#fff5f5", badge: "CRIT" },
          ],
        },
      },
    }),
    makeElement("rectangle", {
      id: "el-billing",
      customData: {
        liveBinding: {
          sourceId: "k8s-prod",
          kind: "k8s",
          query: "prod/deployments/billing",
          field: "status.readyReplicas",
          labelTemplate: "{{value}}/3 ready",
          thresholds: [
            { op: "<", value: 3, strokeColor: "#f08c00", badge: "DEGRADED" },
          ],
        },
      },
    }),
  ];

  test("rejects unauthenticated requests, forbidden roles, and non-GET methods", async () => {
    const unauth = await handleLiveValuesRequest({
      req: new Request("https://plenary.test/boards/b1/live-values"),
      boardId: "b1",
      role: null,
      elements,
      liveSources: mem,
    });
    expect(unauth.status).toBe(401);

    const forbidden = await handleLiveValuesRequest({
      req: new Request("https://plenary.test/boards/b1/live-values"),
      boardId: "b1",
      role: "none",
      elements,
      liveSources: mem,
    });
    expect(forbidden.status).toBe(403);

    const wrongMethod = await handleLiveValuesRequest({
      req: new Request("https://plenary.test/boards/b1/live-values", { method: "POST" }),
      boardId: "b1",
      role: "viewer",
      elements,
      liveSources: mem,
    });
    expect(wrongMethod.status).toBe(405);
  });

  test("returns evaluated overlays for authenticated viewer/presenter with zero secret leakage", async () => {
    const res = await handleLiveValuesRequest({
      req: new Request("https://plenary.test/boards/b1/live-values"),
      boardId: "b1",
      role: "viewer",
      elements,
      liveSources: mem,
      now: () => 52_000,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const text = await res.text();
    expect(text).not.toContain("secret-prom.internal");
    expect(text).not.toContain("secret-k8s.internal");
    expect(text).not.toContain("SUPER_SECRET");
    expect(text).not.toContain("baseUrl");
    expect(text).not.toContain("authEnv");

    const body = JSON.parse(text);
    expect(body.boardId).toBe("b1");
    expect(body.values["el-api"]).toMatchObject({
      ok: true,
      value: 12.5,
      overlay: {
        status: "crit",
        stale: false,
        strokeColor: "#e03131",
        backgroundColor: "#fff5f5",
        badgeText: "CRIT",
        labelSuffix: "12.5%",
      },
    });
    expect(body.values["el-billing"]).toMatchObject({
      ok: true,
      value: 1,
      overlay: {
        status: "warn",
        stale: false,
        strokeColor: "#f08c00",
        badgeText: "DEGRADED",
        labelSuffix: "1/3 ready",
      },
    });

    const sourcesRes = handleLiveSourcesListRequest({
      req: new Request("https://plenary.test/live-sources"),
      role: "presenter",
      liveSources: mem,
    });
    expect(sourcesRes.status).toBe(200);
    const sourcesText = await sourcesRes.text();
    expect(sourcesText).not.toContain("secret-prom.internal");
    expect(sourcesText).not.toContain("SUPER_SECRET");
    expect(JSON.parse(sourcesText)).toEqual({
      sources: [
        { id: "prom-prod", kind: "metric", label: "Prod Prometheus" },
        { id: "k8s-prod", kind: "k8s", label: "Prod Cluster" },
      ],
    });
  });
});
