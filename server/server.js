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

import { gateway as makeGateway } from "./gateway.js";
import { roomHost, serveOpens, remoteRooms } from "./room-host.js";
import { quietLogger } from "./log.js";
import { staticSite } from "./static.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * @param {{
 *   auth: object, registry: object, store: object, bus: object, blobs?: object, log?: object,
 *   port?: number, hostname?: string,
 *   http?: (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>,
 *   limits?: object, host?: object, static?: false | { mounts?: { url: string, dir: string }[] },
 *   roles?: { gateway: boolean, host: boolean }, node?: string, now?: () => number, timers?: object,
 * }} o — `port: 0` picks a free port. `host` options go to the room host (tests; main.js passes hostname and
 *   leaseTtlMs). `static: false` serves no web app; an object passes its `mounts` to staticSite (default: the repo's
 *   web/ and packages/, from static.js's own path). `roles`: see the header (default both). `node`: this node's id
 *   (names a gateway-only node's open requests). `now`, `timers`: the gateway's clock and timers; tests inject virtual ones (default Date.now and the globals).
 */
export function createServer({ auth, registry, store, bus, blobs = null, log = quietLogger, port = 0, hostname = "127.0.0.1", http, limits, host = {}, static: web = {},
  roles = { gateway: true, host: true }, node = "node", now, timers }) {
  if (!roles || (!roles.gateway && !roles.host)) throw new TypeError("createServer needs at least one role (gateway, host)");
  const started = Date.now();
  const badRequest = badRequestLimiter();
  const site = web === false || !roles.gateway ? null : staticSite({ log, ...web });
  const rooms = roles.host
    ? roomHost({ store, bus, log, ...host })
    : remoteRooms({ bus, node, timeoutMs: host.leaseTtlMs ?? 10_000, log });
  const unserve = roles.host ? serveOpens({ bus, rooms, log }) : () => {};
  const gw = roles.gateway ? makeGateway({ auth, registry, store, bus, rooms, log, limits, ...(now ? { now } : {}), ...(timers ? { timers } : {}) }) : null;

  const server = Bun.serve({
    port, hostname,
    async fetch(req, srv) {
      try {
        let url;
        try { url = new URL(req.url); }
        catch { badRequest(log); return json(400, { error: "bad-request" }); }   // a malformed Host header: no stack, a short line at most
        if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD"))
          return json(200, { ok: true, uptimeMs: Date.now() - started, roles: { gateway: !!gw, host: !!roles.host }, gateway: gw ? gw.stats() : null, ...rooms.stats() });
        if (!gw) return json(404, { error: "not-found" });   // host only: nothing but /health
        if (url.pathname === "/ws") {
          if (srv.upgrade(req, { data: {} })) return undefined;
          return json(426, { error: "upgrade", message: "this is a WebSocket endpoint" });
        }
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
    /** Stop taking connections, close sockets, stop rooms. Does not close the store or the bus (the caller's). */
    async stop() { unserve(); if (gw) await gw.close(); await server.stop(true); await rooms.close(); log.info("server stopped", { port: server.port }); },
  };
}

// A malformed Host header (empty, bare ::1, userinfo, port > 65535, HTTP/1.0 without Host) is the client's mistake:
// answer 400 and log one short debug line per second at most, so a client cannot flood the log.
/** One limiter per server: the returned function logs the line at most once a second. */
const badRequestLimiter = () => { let last = 0; return log => { const t = Date.now(); if (t - last >= 1000) { last = t; log.debug("bad request: the URL (Host header) did not parse"); } }; };
