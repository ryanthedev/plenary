// A stand-in for server/main.js in the cluster-rig tests: HTTP + WebSocket echo on PORT that says which node it is.
//   GET /health  200 { ok, node, roles }
//   GET /info    the cluster env it was given: values only for non-secrets, a hash for the shared keys, names otherwise
//   /ws          on open sends { node, roles }; echoes every message back as { node, echo }
// argv: --die-if-role=<role>  exit 3 at once when PLENARY_ROLES contains <role> (the "up fails midway" test)
// It never prints anything (the secrets test reads every byte the rig and its children write to the terminal).
import { createHash } from "node:crypto";

const env = process.env;
const node = env.PLENARY_NODE_ID, roles = (env.PLENARY_ROLES ?? "").split(",").filter(Boolean);
const die = process.argv.find(a => a.startsWith("--die-if-role="))?.split("=")[1];
if (die && roles.includes(die)) process.exit(3);

const hash = v => v ? createHash("sha256").update(v).digest("hex") : null;
const info = {
  node, roles, port: Number(env.PORT), leaseTtlMs: Number(env.PLENARY_LEASE_TTL_MS), databaseUrl: env.DATABASE_URL,
  natsUrl: env.NATS_URL, dataDir: env.PLENARY_DATA_DIR, maxConnsPerUser: Number(env.PLENARY_MAX_CONNS_PER_USER),
  cookieKeyHash: hash(env.COOKIE_KEY), sessionKeyHash: hash(env.SESSION_KEY), devTokensHash: hash(env.PLENARY_DEV_TOKENS),
  envNames: Object.keys(env).sort(), cwd: process.cwd(),
};

Bun.serve({
  hostname: env.HOST || "127.0.0.1",
  port: Number(env.PORT),
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, node, roles });
    if (url.pathname === "/info") return Response.json(info);
    if (url.pathname === "/ws" && srv.upgrade(req)) return undefined;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { ws.send(JSON.stringify({ node, roles })); },
    message(ws, m) { ws.send(JSON.stringify({ node, echo: String(m) })); },
  },
});
process.on("SIGTERM", () => process.exit(0));
