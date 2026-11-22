// One program, two roles (CLAUDE.md, M2): a gateway and a room host joined by a bus, behind one Bun HTTP server.
// `roles` picks them (default both, as on a single node):
//   gateway + host  as below; the host also answers other nodes' remote opens (`plen-hosts.open`).
//   host only       a room host and the bus; /health answers; /ws and every other route answer 404. No gateway.
//   gateway only    no room host, so no lease is ever taken here: the gateway's rooms.open() asks the cluster's
//                   hosts over the bus (room-host.js remoteRooms; PROTOCOL.md § Bus). Needs a host node somewhere.
//   GET /health   200 + small JSON
//   GET /metrics  200 + Prometheus text exposition (uptime, memory, rooms, and gateway counters/gauges)
//   GET /ws       the WebSocket (the token goes in the first message, never in a header or the URL)
// Everything else goes to `http` (the platform track's routes: POST /boards, sign-in), then to the web app (static.js:
// GET/HEAD of the page and its module graph, an allowlist built at start-up), else 404.

import { gateway as makeGateway } from "./gateway.js";
import { roomHost, serveOpens, remoteRooms } from "./room-host.js";
import { quietLogger } from "./log.js";
import { staticSite } from "./static.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Prometheus text exposition (0.0.4) of process, room-host, and gateway metrics (M2 Phase 8). */
export function formatMetrics({ uptimeMs, rooms, gateway, memory = process.memoryUsage() }) {
  const L = [];
  const add = (name, type, help, value) => {
    if (!Number.isFinite(value)) return;
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };
  add("plenary_up", "gauge", "1 while the Plenary server process is running.", 1);
  add("plenary_uptime_seconds", "gauge", "Process uptime in seconds.", Math.round(uptimeMs / 100) / 10);
  add("plenary_process_rss_bytes", "gauge", "Resident set size in bytes.", memory.rss);
  add("plenary_process_heap_used_bytes", "gauge", "JS heap used in bytes.", memory.heapUsed);
  add("plenary_rooms", "gauge", "Board rooms currently held by this host.", rooms?.rooms ?? 0);
  add("plenary_rooms_waiting", "gauge", "Boards watched for failover by this host.", rooms?.waiting ?? 0);
  if (gateway) {
    add("plenary_gateway_connections", "gauge", "Open WebSocket connections on this gateway.", gateway.conns);
    add("plenary_gateway_users", "gauge", "Distinct users connected to this gateway.", gateway.users);
    add("plenary_gateway_boards", "gauge", "Active boards served by this gateway.", gateway.boards);
    add("plenary_gateway_waiting_joiners", "gauge", "Joiners currently waiting for outbound budget.", gateway.waitingJoiners);
    add("plenary_gateway_owed_bytes", "gauge", "Outbound bytes buffered in sockets and per-connection queues.", gateway.owedBytes);
    add("plenary_gateway_queued_bytes", "gauge", "Inbound frame bytes queued waiting to be processed.", gateway.queuedBytes);
    add("plenary_gateway_shared_bytes", "gauge", "Distinct shared catch-up bytes referenced by queues.", gateway.sharedBytes);
    add("plenary_gateway_accepted_total", "counter", "Total hellos accepted by this gateway.", gateway.accepted);
    add("plenary_gateway_refused_auth_total", "counter", "Total hellos refused for auth.", gateway.refusedAuth);
    add("plenary_gateway_bad_frames_total", "counter", "Total bad frames received.", gateway.badFrames);
    add("plenary_gateway_cut_total", "counter", "Total connections cut for stalls or budget limits.", gateway.cut);
    add("plenary_gateway_turned_away_total", "counter", "Total joiners turned away for budget limits.", gateway.turnedAway);
  }
  return L.join("\n") + "\n";
}

/**
 * @param {{
 *   auth: object, registry: object, store: object, bus: object, blobs?: object, log?: object,
 *   port?: number, hostname?: string,
 *   http?: (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>,
 *   limits?: object, host?: object, static?: false | { mounts?: { url: string, dir: string }[] },
 *   roles?: { gateway: boolean, host: boolean }, node?: string,
 * }} o — `port: 0` picks a free port. `host` options go to the room host (tests; main.js passes hostname and
 *   leaseTtlMs). `static: false` serves no web app; an object passes its `mounts` to staticSite (default: the repo's
 *   web/ and packages/, from static.js's own path). `roles`: see the header (default both). `node`: this node's id
 *   (names a gateway-only node's open requests).
 */
export function createServer({ auth, registry, store, bus, blobs = null, log = quietLogger, port = 0, hostname = "127.0.0.1", http, limits, host = {}, static: web = {},
  roles = { gateway: true, host: true }, node = "node" }) {
  if (!roles || (!roles.gateway && !roles.host)) throw new TypeError("createServer needs at least one role (gateway, host)");
  const started = Date.now();
  const site = web === false || !roles.gateway ? null : staticSite({ log, ...web });
  const rooms = roles.host
    ? roomHost({ store, bus, log, ...host })
    : remoteRooms({ bus, node, timeoutMs: host.leaseTtlMs ?? 10_000, log });
  const unserve = roles.host ? serveOpens({ bus, rooms, log }) : () => {};
  const gw = roles.gateway ? makeGateway({ auth, registry, store, bus, rooms, log, limits }) : null;

  const server = Bun.serve({
    port, hostname,
    async fetch(req, srv) {
      try {
        const url = new URL(req.url);
        if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD"))
          return json(200, { ok: true, uptimeMs: Date.now() - started, roles: { gateway: !!gw, host: !!roles.host }, gateway: gw ? gw.stats() : null, ...rooms.stats() });
        if (url.pathname === "/metrics" && (req.method === "GET" || req.method === "HEAD")) {
          const text = formatMetrics({ uptimeMs: Date.now() - started, rooms: rooms.stats(), gateway: gw ? gw.stats() : null });
          return new Response(req.method === "HEAD" ? null : text, { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
        }
        if (!gw) return json(404, { error: "not-found" });   // host only: nothing but /health and /metrics
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
