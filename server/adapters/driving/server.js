// @ts-check
// One program, two roles (CLAUDE.md, M2): a gateway and a room host joined by a bus, behind one Bun HTTP server.
// `roles` picks them (default both, as on a single node):
//   gateway + host  as below; the host also answers other nodes' remote opens (`plen-hosts.open`).
//   host only       a room host and the bus; /health answers; /ws and every other route answer 404. No gateway.
//   gateway only    no room host, so no lease is ever taken here: the gateway's rooms.open() asks the cluster's
//                   hosts over the bus (room-host.js remoteRooms; PROTOCOL.md § Bus). Needs a host node somewhere.
//   GET /health   200 + small JSON
//   GET /ws       the WebSocket (the token goes in the first message, never in a header or the URL)
// Everything else goes to `http` (the platform track's routes: POST /boards, sign-in), then to the web app (static.js:
// GET/HEAD of the page and its module graph, an allowlist built at start-up), else 404.
//   GET /metrics  Prometheus text, on every role, only with `metricsEndpoint` (a bearer token) and else a 404 (metrics-http.js; PROTOCOL.md § Metrics)
//   GET|PUT /blobs/<token>   signed blob URLs (blob-http.js); only when `blobs` is given. Without it the gateway
//                            answers a socket's `blob` request `unavailable`.

import { isIP } from "node:net";
import { gateway as makeGateway } from "../../core/gateway.js";
import { roomHost, serveOpens, remoteRooms } from "../../core/room-host.js";
import { quietLogger } from "../../core/log.js";
import { staticSite } from "./static.js";
import { blobAccess } from "../../core/blob-access.js";
import { blobRoutes } from "./blob-http.js";
import { metricsRoute } from "./metrics-http.js";
import { noopMetrics } from "../../ports/metrics.js";

const BASE_SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

const json = (status, body, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...BASE_SECURITY_HEADERS, ...extraHeaders },
  });

/**
 * Apply baseline HTTP security headers to every response without clobbering stricter route-specific headers.
 * @param {Response} res
 * @param {{ https: boolean, isEmbed: boolean }} opts
 */
function hardenResponse(res, { https, isEmbed }) {
  const h = res.headers;
  if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
  if (!h.has("referrer-policy")) h.set("referrer-policy", "no-referrer");
  if (!h.has("permissions-policy")) h.set("permissions-policy", BASE_SECURITY_HEADERS["permissions-policy"]);
  if (!isEmbed && !h.has("x-frame-options")) h.set("x-frame-options", "DENY");
  if (!isEmbed && !h.has("cross-origin-resource-policy")) h.set("cross-origin-resource-policy", "same-origin");
  if (https && !h.has("strict-transport-security")) h.set("strict-transport-security", "max-age=63072000; includeSubDomains");
  const ct = h.get("content-type") ?? "";
  if (ct.includes("text/html") && !h.has("cross-origin-opener-policy")) h.set("cross-origin-opener-policy", "same-origin");
  return res;
}

/**
 * Bounded per-IP LRU token-bucket rate limiter (evicts least-recently-used entry past `maxEntries` so an IP flood cannot OOM).
 * @param {{ burst: number, refillPerSec: number, maxEntries?: number, now?: () => number }} opts
 */
function createIpRateLimiter({ burst, refillPerSec, maxEntries = 50_000, now = Date.now }) {
  /** @type {Map<string, { tokens: number, lastMs: number }>} */
  const buckets = new Map();
  return {
    /** @param {string} key @returns {{ ok: boolean, retryAfterSec?: number }} */
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value);
        b = { tokens: burst, lastMs: t };
        buckets.set(key, b);
      } else {
        const elapsed = Math.max(0, (t - b.lastMs) / 1000);
        b.tokens = Math.min(burst, b.tokens + elapsed * refillPerSec);
        b.lastMs = t;
        // Refresh LRU recency so active buckets aren't evicted by a one-shot IP sweep
        buckets.delete(key);
        buckets.set(key, b);
      }
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      const waitSec = Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec));
      return { ok: false, retryAfterSec: waitSec };
    },
  };
}

/** Normalize an IP for rate limiting: IPv4 as-is; IPv6 collapsed to canonical /64 prefix to prevent /128 rotation bypass. */
function normalizeRateKey(ip) {
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) {
    try {
      const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
      const [head, tail = ""] = canonical.split("::");
      const left = head ? head.split(":") : [];
      const right = tail ? tail.split(":") : [];
      const fill = Math.max(0, 8 - left.length - right.length);
      const full = [...left, ...Array(fill).fill("0"), ...right];
      return full.slice(0, 4).map(h => h.padStart(4, "0")).join(":") + "::/64";
    } catch { return "unknown"; }
  }
  return "unknown";
}

/** Extract client IP for rate limiting: trusts CF-Connecting-IP / rightmost X-Forwarded-For ONLY when `trustProxy` is true AND TCP peer is loopback. */
function clientIpOf(req, srv, trustProxy) {
  let peer = "unknown";
  try { peer = srv.requestIP?.(req)?.address || "unknown"; } catch {}
  const isLoopbackPeer = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (trustProxy && isLoopbackPeer) {
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf && isIP(cf)) return normalizeRateKey(cf);
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map(s => s.trim()).filter(Boolean);
      const rightmost = hops.at(-1);
      if (rightmost && isIP(rightmost)) return normalizeRateKey(rightmost);
    }
  }
  return isIP(peer) ? normalizeRateKey(peer) : "unknown";
}

/**
 * @param {{
 *   auth: import("../../ports/auth.js").Auth,
 *   registry: { board(id: string): Promise<{ id: string, tenant: string }|null> },
 *   store: import("../../ports/store.js").Store,
 *   bus: import("../../ports/bus.js").Bus,
 *   blobs?: import("../../ports/blobs.js").Blobs | null,
 *   log?: { debug?(msg: string, f?: object): void, info(msg: string, f?: object): void, warn(msg: string, f?: object): void, error(msg: string, f?: object): void },
 *   port?: number, hostname?: string,
 *   http?: (((req: Request, url: URL) => Response | undefined | Promise<Response | undefined>) & { stats?: () => object }) | null,
 *   blobKey?: Uint8Array, quotaBytes?: number, blobUsageTtlMs?: number, publicUrl?: string, maxBlobPuts?: number, blobHttp?: Record<string, any>, idleTimeoutSec?: number,
 *   metrics?: import("../../ports/metrics.js").Metrics, metricsEndpoint?: { token: string, render: () => string } | null,
 *   limits?: Record<string, any>, host?: Record<string, any>, static?: false | { mounts?: readonly { url: string, dir: string }[], cache?: boolean },
 *   roles?: { gateway: boolean, host: boolean }, node?: string, now?: () => number, timers?: Record<string, any>,
 *   deflate?: ((data: string | Uint8Array) => Promise<Uint8Array | null>) | null,
 *   onWelcomed?: ((user: string, board: string) => void) | null,
 *   snapshotTickets?: { issue(board: string, seq: number): Promise<string> } | null,
 *   hideHealthStats?: boolean,
 *   trustProxy?: boolean,
 *   rateLimit?: boolean | { authBurst?: number, authRefillPerSec?: number, wsBurst?: number, wsRefillPerSec?: number, apiBurst?: number, apiRefillPerSec?: number } | null,
 * }} o — `port: 0` picks a free port. `host` options go to the room host (tests; main.js passes hostname and
 *   leaseTtlMs). `static: false` serves no web app; an object passes its `mounts` to staticSite (default: the repo's
 *   web/ and packages/, from static.js's own path). `roles`: see the header (default both). `node`: this node's id
 *   (names a gateway-only node's open requests). `onWelcomed(user, board)`: told when a connection is welcomed (Recent). `now`, `timers`: the gateway's clock and timers; tests inject virtual ones (default Date.now and the globals).
 */
export function createServer({ auth, registry, store, bus, blobs = null, log = quietLogger, port = 0, hostname = "127.0.0.1", http, limits, metrics = noopMetrics, metricsEndpoint, host = {}, static: web = {},
  roles = { gateway: true, host: true }, node = "node", now, timers, deflate, blobKey, quotaBytes, blobUsageTtlMs, publicUrl, maxBlobPuts, blobHttp: blobHttpOpts, onWelcomed, idleTimeoutSec = 30, snapshotTickets = null,
  hideHealthStats = false, trustProxy = false, rateLimit = false }) {
  if (!roles || (!roles.gateway && !roles.host)) throw new TypeError("createServer needs at least one role (gateway, host)");
  const started = Date.now();
  const badRequest = badRequestLimiter();
  const site = web === false || !roles.gateway ? null : staticSite({ log, ...web });
  const rooms = roles.host
    ? roomHost({ store, bus, log, metrics, ...host })
    : remoteRooms({ bus, node, timeoutMs: host.leaseTtlMs ?? 10_000, log });
  const unserve = roles.host ? serveOpens({ bus, rooms, log }) : () => {};
  const origin = publicUrl?.replace(/\/+$/, "") ?? "";   // "": signed URLs are the path /blobs/<token>, which the client resolves against the origin it connected to
  const isHttps = origin.startsWith("https://");
  const clock = now ?? Date.now;
  const rlOpts = rateLimit === true ? {} : (rateLimit && typeof rateLimit === "object" ? rateLimit : null);
  const authLimiter = rlOpts ? createIpRateLimiter({ burst: rlOpts.authBurst ?? 30, refillPerSec: rlOpts.authRefillPerSec ?? 1, now: clock }) : null;
  const wsLimiter = rlOpts ? createIpRateLimiter({ burst: rlOpts.wsBurst ?? 120, refillPerSec: rlOpts.wsRefillPerSec ?? 10, now: clock }) : null;
  const apiLimiter = rlOpts ? createIpRateLimiter({ burst: rlOpts.apiBurst ?? 180, refillPerSec: rlOpts.apiRefillPerSec ?? 20, now: clock }) : null;
  const access = blobs && roles.gateway ? blobAccess({ blobs, key: blobKey ?? crypto.getRandomValues(new Uint8Array(32)), origin, log, ...(now ? { now } : {}), ...(quotaBytes !== undefined ? { quotaBytes } : {}), ...(blobUsageTtlMs ? { usageTtlMs: blobUsageTtlMs } : {}) }) : null;
  const blobHttp = access ? blobRoutes({ access, ...(maxBlobPuts ? { maxPuts: maxBlobPuts } : {}), ...(blobHttpOpts ?? {}) }) : null;
  const gw = roles.gateway ? makeGateway({ auth, registry, store, bus, rooms, log, limits, metrics, snapshotTickets, ...(deflate ? { deflate } : {}), ...(access ? { blobUrl: access.url } : {}), ...(now ? { now } : {}), ...(timers ? { timers } : {}), ...(onWelcomed ? { onWelcomed } : {}) }) : null;

  const metricsHttp = metricsRoute({ ...metricsEndpoint, log });
  const finish = (res, pathname) => hardenResponse(res, { https: isHttps, isEmbed: pathname.startsWith("/embed/") });
  const server = Bun.serve({
    port, hostname,
    // Bun's default is 10 s without a byte either way, which would cut a slow upload of a 10 MB picture mid-body (WebSockets have their
    // own timeout, the gateway's). Set, not inherited.
    idleTimeout: idleTimeoutSec,
    async fetch(req, srv) {
      try {
        let url;
        try { url = new URL(req.url); }
        catch { badRequest(log); return hardenResponse(json(400, { error: "bad-request" }), { https: isHttps, isEmbed: false }); }   // a malformed Host header: no stack, a short line at most
        const path = url.pathname;
        if (path === "/health" && (req.method === "GET" || req.method === "HEAD")) {
          const body = hideHealthStats
            ? { ok: true }
            : { ok: true, uptimeMs: Date.now() - started, roles: { gateway: !!gw, host: !!roles.host }, gateway: gw ? gw.stats() : null, ...(http?.stats ? { http: http.stats() } : {}), ...rooms.stats() };
          return finish(json(200, body), path);
        }
        if (path === "/metrics") return finish(await metricsHttp.handle(req), path);   // before the host-only 404: a host node is the one with the leases
        if (!gw) return finish(json(404, { error: "not-found" }), path);   // host only: nothing but /health
        if (path === "/ws") {
          const reqOrigin = req.headers.get("origin");
          if (reqOrigin) {
            const allowedOrigin = origin || url.origin;
            if (reqOrigin !== allowedOrigin) {
              log.warn("ws upgrade rejected: bad origin");
              return finish(json(403, { error: "bad-origin" }), path);
            }
          }
          if (wsLimiter) {
            const rl = wsLimiter.take(clientIpOf(req, srv, trustProxy));
            if (!rl.ok) return finish(json(429, { error: "rate-limited", retryAfter: rl.retryAfterSec }, { "retry-after": String(rl.retryAfterSec) }), path);
          }
          if (srv.upgrade(req, /** @type {any} */ ({ data: { z: url.searchParams.get("z") === "deflate" } }))) return undefined;   // § Joining: the client can inflate catch-up
          return finish(json(426, { error: "upgrade", message: "this is a WebSocket endpoint" }), path);
        }
        if (authLimiter && (path.startsWith("/auth/") || path.startsWith("/links/"))) {
          const rl = authLimiter.take(clientIpOf(req, srv, trustProxy));
          if (!rl.ok) return finish(json(429, { error: "rate-limited", retryAfter: rl.retryAfterSec }, { "retry-after": String(rl.retryAfterSec) }), path);
        }
        if (apiLimiter && (path.startsWith("/boards") || path.startsWith("/tenants") || path.startsWith("/admin/") || path.startsWith("/blobs/") || path.startsWith("/spaces") || path.startsWith("/groups") || path.startsWith("/teams") || path.startsWith("/roles") || path.startsWith("/home") || path.startsWith("/access/") || path.startsWith("/members/") || path.startsWith("/trash") || path === "/directory")) {
          const rl = apiLimiter.take(clientIpOf(req, srv, trustProxy));
          if (!rl.ok) return finish(json(429, { error: "rate-limited", retryAfter: rl.retryAfterSec }, { "retry-after": String(rl.retryAfterSec) }), path);
        }
        if (blobHttp) { const res = await blobHttp.handle(req, url); if (res) return finish(res, path); }
        if (http) { const res = await http(req, url); if (res) return finish(res, path); }
        if (site) { const res = await site.handle(req, url); if (res) return finish(res, path); }
        return finish(json(404, { error: "not-found" }), path);
      } catch (err) {
        log.error("http handler failed", { method: req.method, err });
        return hardenResponse(json(500, { error: "internal" }), { https: isHttps, isEmbed: false });
      }
    },
    error(err) { log.error("http error", { err }); return hardenResponse(json(500, { error: "internal" }), { https: isHttps, isEmbed: false }); },
    // A host-only node never upgrades (/ws is 404 above); Bun still wants handlers.
    websocket: gw ? gw.websocket : { message() {} },
  });
  log.info("server listening", { port: server.port, hostname, gateway: gw ? gw.id : null, roles: { gateway: !!gw, host: !!roles.host } });

  return {
    port: server.port,
    url: `http://${hostname}:${server.port}`,
    wsUrl: `ws://${hostname}:${server.port}/ws`,
    gateway: gw, rooms, blobs, site,
    /** The blob reaper's hook (PROTOCOL.md § Blobs, "Quota"): drops a tenant's cached usage after deletes. A no-op on a node with no blob access. */
    recountBlobs: tenant => access?.recount(tenant),
    /** Stop taking connections, close sockets, stop rooms. Does not close the store or the bus (the caller's). */
    async stop() { unserve(); if (gw) await gw.close(); await server.stop(true); await rooms.close(); log.info("server stopped", { port: server.port }); },
  };
}

// A malformed Host header (empty, bare ::1, userinfo, port > 65535, HTTP/1.0 without Host) is the client's mistake:
// answer 400 and log one short debug line per second at most, so a client cannot flood the log.
/** One limiter per server: the returned function logs the line at most once a second. */
const badRequestLimiter = () => { let last = 0; return log => { const t = Date.now(); if (t - last >= 1000) { last = t; log.debug("bad request: the URL (Host header) did not parse"); } }; };
