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

import { gateway as makeGateway } from "./gateway.js";
import { roomHost, serveOpens, remoteRooms } from "./room-host.js";
import { quietLogger } from "./log.js";
import { staticSite } from "./static.js";
import { blobAccess } from "./blob-access.js";
import { blobRoutes } from "./blob-http.js";
import { metricsRoute } from "./metrics-http.js";
import { noopMetrics } from "./metrics/port.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * @param {{
 *   auth: import("./auth/port.js").Auth,
 *   registry: { board(id: string): Promise<{ id: string, tenant: string }|null> },
 *   store: import("./store/port.js").Store,
 *   bus: import("./bus/port.js").Bus,
 *   blobs?: import("./blobs/port.js").Blobs | null,
 *   log?: { debug?(msg: string, f?: object): void, info(msg: string, f?: object): void, warn(msg: string, f?: object): void, error(msg: string, f?: object): void },
 *   port?: number, hostname?: string,
 *   http?: (((req: Request, url: URL) => Response | undefined | Promise<Response | undefined>) & { stats?: () => object }) | null,
 *   blobKey?: Uint8Array, quotaBytes?: number, blobUsageTtlMs?: number, publicUrl?: string, maxBlobPuts?: number, blobHttp?: Record<string, any>, idleTimeoutSec?: number,
 *   metrics?: import("./metrics/port.js").Metrics, metricsEndpoint?: { token: string, render: () => string } | null,
 *   limits?: Record<string, any>, host?: Record<string, any>, static?: false | { mounts?: readonly { url: string, dir: string }[], cache?: boolean },
 *   roles?: { gateway: boolean, host: boolean }, node?: string, now?: () => number, timers?: Record<string, any>,
 *   deflate?: ((data: string | Uint8Array) => Promise<Uint8Array | null>) | null,
 *   onWelcomed?: ((user: string, board: string) => void) | null,
 *   snapshotTickets?: { issue(board: string, seq: number): Promise<string> } | null,
 * }} o — `port: 0` picks a free port. `host` options go to the room host (tests; main.js passes hostname and
 *   leaseTtlMs). `static: false` serves no web app; an object passes its `mounts` to staticSite (default: the repo's
 *   web/ and packages/, from static.js's own path). `roles`: see the header (default both). `node`: this node's id
 *   (names a gateway-only node's open requests). `onWelcomed(user, board)`: told when a connection is welcomed (Recent). `now`, `timers`: the gateway's clock and timers; tests inject virtual ones (default Date.now and the globals).
 */
export function createServer({ auth, registry, store, bus, blobs = null, log = quietLogger, port = 0, hostname = "127.0.0.1", http, limits, metrics = noopMetrics, metricsEndpoint, host = {}, static: web = {},
  roles = { gateway: true, host: true }, node = "node", now, timers, deflate, blobKey, quotaBytes, blobUsageTtlMs, publicUrl, maxBlobPuts, blobHttp: blobHttpOpts, onWelcomed, idleTimeoutSec = 30, snapshotTickets = null }) {
  if (!roles || (!roles.gateway && !roles.host)) throw new TypeError("createServer needs at least one role (gateway, host)");
  const started = Date.now();
  const badRequest = badRequestLimiter();
  const site = web === false || !roles.gateway ? null : staticSite({ log, ...web });
  const rooms = roles.host
    ? roomHost({ store, bus, log, metrics, ...host })
    : remoteRooms({ bus, node, timeoutMs: host.leaseTtlMs ?? 10_000, log });
  const unserve = roles.host ? serveOpens({ bus, rooms, log }) : () => {};
  const origin = publicUrl?.replace(/\/+$/, "") ?? "";   // "": signed URLs are the path /blobs/<token>, which the client resolves against the origin it connected to
  const access = blobs && roles.gateway ? blobAccess({ blobs, key: blobKey ?? crypto.getRandomValues(new Uint8Array(32)), origin, log, ...(now ? { now } : {}), ...(quotaBytes !== undefined ? { quotaBytes } : {}), ...(blobUsageTtlMs ? { usageTtlMs: blobUsageTtlMs } : {}) }) : null;
  const blobHttp = access ? blobRoutes({ access, ...(maxBlobPuts ? { maxPuts: maxBlobPuts } : {}), ...(blobHttpOpts ?? {}) }) : null;
  const gw = roles.gateway ? makeGateway({ auth, registry, store, bus, rooms, log, limits, metrics, snapshotTickets, ...(deflate ? { deflate } : {}), ...(access ? { blobUrl: access.url } : {}), ...(now ? { now } : {}), ...(timers ? { timers } : {}), ...(onWelcomed ? { onWelcomed } : {}) }) : null;

  const metricsHttp = metricsRoute({ ...metricsEndpoint, log });
  const server = Bun.serve({
    port, hostname,
    // Bun's default is 10 s without a byte either way, which would cut a slow upload of a 10 MB picture mid-body (WebSockets have their
    // own timeout, the gateway's). Set, not inherited.
    idleTimeout: idleTimeoutSec,
    async fetch(req, srv) {
      try {
        let url;
        try { url = new URL(req.url); }
        catch { badRequest(log); return json(400, { error: "bad-request" }); }   // a malformed Host header: no stack, a short line at most
        if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD"))
          return json(200, { ok: true, uptimeMs: Date.now() - started, roles: { gateway: !!gw, host: !!roles.host }, gateway: gw ? gw.stats() : null, ...(http?.stats ? { http: http.stats() } : {}), ...rooms.stats() });
        if (url.pathname === "/metrics") return await metricsHttp.handle(req);   // before the host-only 404: a host node is the one with the leases
        if (!gw) return json(404, { error: "not-found" });   // host only: nothing but /health
        if (url.pathname === "/ws") {
          if (srv.upgrade(req, /** @type {any} */ ({ data: { z: url.searchParams.get("z") === "deflate" } }))) return undefined;   // § Joining: the client can inflate catch-up
          return json(426, { error: "upgrade", message: "this is a WebSocket endpoint" });
        }
        if (blobHttp) { const res = await blobHttp.handle(req, url); if (res) return res; }
        if (http) { const res = await http(req, url); if (res) return res; }
        if (site) { const res = await site.handle(req, url); if (res) return res; }
        return json(404, { error: "not-found" });
      } catch (err) {
        log.error("http handler failed", { method: req.method, err });
        return json(500, { error: "internal" });
      }
    },
    error(err) { log.error("http error", { err }); return json(500, { error: "internal" }); },
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
