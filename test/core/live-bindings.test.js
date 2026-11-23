// @ts-check
import { describe, test, expect } from "bun:test";
import { makeElement, emptyScene } from "../../packages/core/model.js";
import {
  normalizeLiveBinding,
  liveBindingOf,
  stripSecretsFromBinding,
  evaluateLiveBinding,
  collectBoardLiveBindings,
  computeLiveOverlays,
  MIN_REFRESH_MS,
  MAX_REFRESH_MS,
  MAX_THRESHOLDS,
} from "../../packages/core/live-bindings.js";

describe("packages/core/live-bindings — validation & credential non-leakage", () => {
  test("normalizes valid metric and k8s bindings", () => {
    const metric = normalizeLiveBinding({
      sourceId: "prom-prod",
      kind: "metric",
      query: 'sum(rate(http_requests_total{job="api"}[5m]))',
      unit: "req/s",
      labelTemplate: "RPS: {{value}} {{unit}}",
      refreshMs: 10_000,
      thresholds: [
        { op: ">=", value: 1000, strokeColor: "#e03131", backgroundColor: "#fff5f5", badge: "CRIT" },
        { op: ">", value: 500, strokeColor: "#f08c00", badge: "WARN" },
      ],
    });
    expect(metric).toEqual({
      sourceId: "prom-prod",
      kind: "metric",
      query: 'sum(rate(http_requests_total{job="api"}[5m]))',
      unit: "req/s",
      labelTemplate: "RPS: {{value}} {{unit}}",
      refreshMs: 10_000,
      thresholds: [
        { op: ">=", value: 1000, strokeColor: "#e03131", backgroundColor: "#fff5f5", badge: "CRIT" },
        { op: ">", value: 500, strokeColor: "#f08c00", badge: "WARN" },
      ],
    });

    const k8s = normalizeLiveBinding({
      sourceId: "k8s-us-east",
      kind: "k8s",
      query: "prod/deployments/checkout",
      field: "status.readyReplicas",
      unit: " pods",
    });
    expect(k8s).toEqual({
      sourceId: "k8s-us-east",
      kind: "k8s",
      query: "prod/deployments/checkout",
      field: "status.readyReplicas",
      unit: "pods",
    });
  });

  test("strips all credential, URL, header, and unknown keys from normalized bindings", () => {
    const normalized = normalizeLiveBinding({
      sourceId: "prom-prod",
      kind: "metric",
      query: "up",
      token: "ghp_supersecret123456",
      apiKey: "sk-live-secret",
      password: "hunter2",
      authEnv: "PROM_TOKEN",
      headers: { Authorization: "Bearer secret-token" },
      baseUrl: "https://prom.internal.corp:9090",
      url: "https://admin:pass@prom.internal",
      credentials: { user: "root", pass: "toor" },
      kubeconfig: "apiVersion: v1",
    });

    expect(normalized).toEqual({
      sourceId: "prom-prod",
      kind: "metric",
      query: "up",
    });
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("PROM_TOKEN");
    expect(serialized).not.toContain("prom.internal");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("Authorization");
  });

  test("stripSecretsFromBinding removes secret keys deeply and redacts inline secrets", () => {
    const cleaned = stripSecretsFromBinding({
      sourceId: "prom-prod",
      kind: "metric",
      query: "http_probe{url=\"https://alice:s3cr3t@internal.local\"} Bearer eyJhbGciOiJIUzI1NiJ9",
      token: "tok_12345",
      headers: { Authorization: "Bearer tok_12345" },
      nested: {
        api_key: "secret-key",
        password: "pw",
        note: "api_key=mysecretvalue123",
      },
    });
    expect(cleaned).not.toBeNull();
    expect(cleaned?.token).toBeUndefined();
    expect(cleaned?.headers).toBeUndefined();
    expect(cleaned?.nested?.api_key).toBeUndefined();
    expect(cleaned?.nested?.password).toBeUndefined();
    expect(cleaned?.query).not.toContain("s3cr3t");
    expect(cleaned?.query).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(cleaned?.query).toContain("[REDACTED]");
    expect(cleaned?.nested?.note).not.toContain("mysecretvalue123");
  });

  test("rejects bindings with inline credentials in query, invalid kinds, or prototype-pollution fields", () => {
    expect(normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "Authorization: Bearer abcdef123456" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "https://user:pass@prom.local/api" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "foo token=secret123" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "p", kind: "sql", query: "SELECT 1" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "../etc", kind: "metric", query: "up" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "p", kind: "k8s", query: "prod/pods/api", field: "__proto__.polluted" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "p", kind: "k8s", query: "prod/pods/api", field: "constructor.prototype" })).toBeNull();
    expect(normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "up\nDROP" })).toBeNull();
  });

  test("clamps refreshMs and caps thresholds", () => {
    const low = normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "up", refreshMs: 10 });
    expect(low?.refreshMs).toBe(MIN_REFRESH_MS);

    const high = normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "up", refreshMs: 9_999_999 });
    expect(high?.refreshMs).toBe(MAX_REFRESH_MS);

    const many = Array.from({ length: 30 }, (_, i) => ({ op: ">", value: i }));
    const b = normalizeLiveBinding({ sourceId: "p", kind: "metric", query: "up", thresholds: many });
    expect(b?.thresholds?.length).toBe(MAX_THRESHOLDS);
  });

  test("liveBindingOf ignores deleted elements and invalid customData", () => {
    const el = makeElement("rectangle", {
      customData: {
        liveBinding: { sourceId: "prom", kind: "metric", query: "up" },
      },
    });
    expect(liveBindingOf(el)).toEqual({ sourceId: "prom", kind: "metric", query: "up" });

    el.isDeleted = true;
    expect(liveBindingOf(el)).toBeNull();
  });
});

describe("packages/core/live-bindings — pure threshold evaluation & op-log silence", () => {
  const cpuBinding = normalizeLiveBinding({
    sourceId: "prom-prod",
    kind: "metric",
    query: "cpu_usage_percent",
    unit: "%",
    refreshMs: 10_000,
    thresholds: [
      { op: ">=", value: 90, strokeColor: "#e03131", backgroundColor: "#fff5f5", badge: "CRIT" },
      { op: ">=", value: 75, strokeColor: "#f08c00", backgroundColor: "#fff9db", badge: "WARN" },
    ],
  });

  test("evaluates numeric thresholds in order (first match wins)", () => {
    const crit = evaluateLiveBinding(cpuBinding, { ok: true, value: 95.432, fetchedAt: 100_000 }, { now: 105_000 });
    expect(crit).toEqual({
      status: "crit",
      stale: false,
      strokeColor: "#e03131",
      backgroundColor: "#fff5f5",
      badgeText: "CRIT",
      labelSuffix: "95.43%",
    });

    const warn = evaluateLiveBinding(cpuBinding, { ok: true, value: 80, fetchedAt: 100_000 }, { now: 105_000 });
    expect(warn).toEqual({
      status: "warn",
      stale: false,
      strokeColor: "#f08c00",
      backgroundColor: "#fff9db",
      badgeText: "WARN",
      labelSuffix: "80%",
    });

    const ok = evaluateLiveBinding(cpuBinding, { ok: true, value: 42.5, fetchedAt: 100_000 }, { now: 105_000 });
    expect(ok).toEqual({
      status: "ok",
      stale: false,
      labelSuffix: "42.5%",
    });
  });

  test("evaluates string equality/inequality thresholds for k8s pod phase", () => {
    const phaseBinding = normalizeLiveBinding({
      sourceId: "k8s-prod",
      kind: "k8s",
      query: "prod/pods/api-0",
      field: "status.phase",
      labelTemplate: "Phase: {{value}}",
      thresholds: [
        { op: "!=", value: "Running", strokeColor: "#e03131", badge: "DOWN", status: "crit" },
        { op: "==", value: "Running", strokeColor: "#2f9e44", badge: "OK", status: "ok" },
      ],
    });

    const running = evaluateLiveBinding(phaseBinding, { ok: true, value: "Running", fetchedAt: 1000 }, { now: 2000 });
    expect(running.status).toBe("ok");
    expect(running.strokeColor).toBe("#2f9e44");
    expect(running.badgeText).toBe("OK");
    expect(running.labelSuffix).toBe("Phase: Running");

    const crash = evaluateLiveBinding(phaseBinding, { ok: true, value: "CrashLoopBackOff", fetchedAt: 1000 }, { now: 2000 });
    expect(crash.status).toBe("crit");
    expect(crash.strokeColor).toBe("#e03131");
    expect(crash.badgeText).toBe("DOWN");
    expect(crash.labelSuffix).toBe("Phase: CrashLoopBackOff");
  });

  test("marks readings stale when age exceeds threshold or reading fails", () => {
    // refreshMs is 10_000 -> default staleAfterMs is 30_000
    const stale = evaluateLiveBinding(cpuBinding, { ok: true, value: 50, fetchedAt: 100_000 }, { now: 140_000 });
    expect(stale.stale).toBe(true);
    expect(stale.status).toBe("ok");

    const missing = evaluateLiveBinding(cpuBinding, null);
    expect(missing).toEqual({ status: "unknown", stale: true });

    const failed = evaluateLiveBinding(cpuBinding, { ok: false, error: "timeout", fetchedAt: 100_000 });
    expect(failed).toEqual({ status: "unknown", stale: true });
  });

  test("op-log silence: computing live overlays never mutates elements, versions, or scene state", () => {
    const scene = emptyScene();
    const el = makeElement("rectangle", {
      id: "node-api",
      strokeColor: "#1e1e1e",
      backgroundColor: "#ffffff",
      customData: {
        liveBinding: {
          sourceId: "prom-prod",
          kind: "metric",
          query: "cpu_usage_percent",
          unit: "%",
          thresholds: [
            { op: ">", value: 80, strokeColor: "#e03131", backgroundColor: "#fff5f5", badge: "CRIT" },
          ],
        },
      },
    });
    scene.elements.push(el);
    const beforeSnapshot = JSON.stringify(scene);
    const beforeVersion = el.version;
    const beforeNonce = el.versionNonce;

    const bindings = collectBoardLiveBindings(scene.elements);
    expect(bindings).toHaveLength(1);

    const overlays = computeLiveOverlays(
      scene.elements,
      { "node-api": { ok: true, value: 92, fetchedAt: 10_000 } },
      { now: 12_000 },
    );

    expect(overlays["node-api"].status).toBe("crit");
    expect(overlays["node-api"].strokeColor).toBe("#e03131");
    expect(overlays["node-api"].labelSuffix).toBe("92%");

    // Element & scene remain 100% untouched: zero mutation, zero version bump, zero op-log noise.
    expect(el.strokeColor).toBe("#1e1e1e");
    expect(el.backgroundColor).toBe("#ffffff");
    expect(el.version).toBe(beforeVersion);
    expect(el.versionNonce).toBe(beforeNonce);
    expect(JSON.stringify(scene)).toBe(beforeSnapshot);
  });
});
