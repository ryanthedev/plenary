// /metrics endpoint (M2 Phase 8): Prometheus text exposition on both gateway and host-only nodes.
import { test, expect, afterAll } from "bun:test";
import { createServer, formatMetrics } from "../../server/server.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup } from "./helpers.js";

afterAll(cleanup);

test("formatMetrics emits valid Prometheus text lines with gateway and room stats", () => {
  const text = formatMetrics({
    uptimeMs: 12340,
    rooms: { rooms: 2, waiting: 1 },
    gateway: { conns: 5, users: 3, boards: 1, waitingJoiners: 0, owedBytes: 1024, queuedBytes: 0, sharedBytes: 512, accepted: 7, refusedAuth: 1, badFrames: 0, cut: 0, turnedAway: 0 },
    memory: { rss: 50_000_000, heapUsed: 20_000_000 },
  });
  expect(text).toContain("plenary_up 1");
  expect(text).toContain("plenary_uptime_seconds 12.3");
  expect(text).toContain("plenary_rooms 2");
  expect(text).toContain("plenary_rooms_waiting 1");
  expect(text).toContain("plenary_gateway_connections 5");
  expect(text).toContain("plenary_gateway_accepted_total 7");
  expect(text).toContain("plenary_gateway_refused_auth_total 1");
});

test("GET and HEAD /metrics on a live server (both roles and host-only)", async () => {
  const r = await rig();
  const hostOnly = createServer({ auth: {}, registry: {}, store: r.store, bus: r.bus, port: 0, roles: { gateway: false, host: true }, static: false });
  try {
    const s = await r.sock();
    s.send({ t: "hello", v: 1, token: tokenOf("editor"), board: r.ids.board, since: 0, client: "m1" });
    await s.next(m => m.t === "welcome", "welcome");

    const res = await fetch(r.server.url + "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("plenary_up 1");
    expect(body).toContain("plenary_gateway_connections 1");
    expect(body).toContain("plenary_gateway_accepted_total 1");
    expect(body).toContain("plenary_rooms 1");

    const head = await fetch(r.server.url + "/metrics", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);

    // Host-only node exposes /metrics without gateway metrics.
    const hRes = await fetch(hostOnly.url + "/metrics");
    expect(hRes.status).toBe(200);
    const hBody = await hRes.text();
    expect(hBody).toContain("plenary_up 1");
    expect(hBody).toContain("plenary_rooms 0");
    expect(hBody).not.toContain("plenary_gateway_connections");

    await s.close();
  } finally {
    await hostOnly.stop();
    await r.stop();
  }
}, 15_000);
