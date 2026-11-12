// One process, both roles (CLAUDE.md, M2): a gateway and a room host joined by a bus, behind one Bun HTTP server.
//   GET /health   200 + small JSON
//   GET /ws       the WebSocket (the token goes in the first message, never in a header or the URL)
// Everything else goes to `http` (the platform track's routes: POST /boards, sign-in), else 404.

import { gateway as makeGateway } from "./gateway.js";
import { roomHost } from "./room-host.js";
import { quietLogger } from "./log.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * @param {{
 *   auth: object, registry: object, store: object, bus: object, blobs?: object, log?: object,
 *   port?: number, hostname?: string,
 *   http?: (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>,
 *   limits?: object, host?: object,
 * }} o — `port: 0` picks a free port. `host` options go to the room host (tests).
 */
export function createServer({ auth, registry, store, bus, blobs = null, log = quietLogger, port = 0, hostname = "127.0.0.1", http, limits, host = {} }) {
  const started = Date.now();
  const rooms = roomHost({ store, bus, log, ...host });
  const gw = makeGateway({ auth, registry, bus, rooms, log, limits });

  const server = Bun.serve({
    port, hostname,
    async fetch(req, srv) {
      try {
        const url = new URL(req.url);
        if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD"))
          return json(200, { ok: true, uptimeMs: Date.now() - started, gateway: gw.stats(), ...rooms.stats() });
        if (url.pathname === "/ws") {
          if (srv.upgrade(req, { data: {} })) return undefined;
          return json(426, { error: "upgrade", message: "this is a WebSocket endpoint" });
        }
        if (http) { const res = await http(req, url); if (res) return res; }
        return json(404, { error: "not-found" });
      } catch (err) {
        log.error("http handler failed", { method: req.method, err });
        return json(500, { error: "internal" });
      }
    },
    error(err) { log.error("http error", { err }); return json(500, { error: "internal" }); },
    websocket: gw.websocket,
  });
  log.info("server listening", { port: server.port, hostname, gateway: gw.id });

  return {
    port: server.port,
    url: `http://${hostname}:${server.port}`,
    wsUrl: `ws://${hostname}:${server.port}/ws`,
    gateway: gw, rooms, blobs,
    /** Stop taking connections, close sockets, stop rooms. Does not close the store or the bus (the caller's). */
    async stop() { await gw.close(); await server.stop(true); await rooms.close(); log.info("server stopped", { port: server.port }); },
  };
}
