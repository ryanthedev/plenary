// Single-node entry point: `bun server/main.js`. SQLite store, in-memory bus, local-disk blobs, dev-token auth.
//
// Environment (no secrets in the repo; none of these values is ever logged):
//   PORT                 default 8080 (0 = any free port)
//   HOST                 default 127.0.0.1 (a container needs HOST=0.0.0.0)
//   PLENARY_DATA_DIR     data directory, default ./data  (plenary.db, blobs/); the name deploy/ uses
//   PLENARY_DEV_TOKENS   JSON: { "<token>": { "name": "ann", "role": "editor", "email"?, "domain"?, "admin"? } }.
//                        Unset = dev tokens off (then only Google sign-in, if configured, admits anyone).
//                        For each `domain` with a token flagged `"admin": true`, the start makes that domain's
//                        tenant if missing and adds those users as its admins (server/admin/tenants.js), so they can
//                        POST /boards. Domains with no admin token get no tenant from here.
//                        Additive: dropping `admin` later removes nobody (the operator CLI is scripts/admin-bootstrap.js).
//   LOG_LEVEL            debug | info | warn | error
//   PLENARY_MAX_CONNS_PER_USER   open sockets one user may hold (default 64). A load test that shares a few dev
//                        tokens between thousands of clients must raise it.
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   Google sign-in; both set → /auth routes work, else they answer 503
//   OIDC_REDIRECT_URI    default http://localhost:8080/auth/callback (must be on PUBLIC_URL's origin)
//   PUBLIC_URL           this server's origin as browsers see it, default the redirect URI's origin
//   COOKIE_KEY           ≥ 32 bytes; signs login/exchange cookies (and sessions, unless SESSION_KEY is set).
//                        Missing on a single node: a random key per process (sign-ins don't survive a restart).
//                        Missing in cluster mode (DATABASE_URL or NATS_URL set): the server refuses to start.
//   SESSION_KEY          ≥ 32 bytes; signs session tokens (default: COOKIE_KEY)
//
// start(env) reads ONLY its `env` argument (never process.env), so tests behave the same in every checkout
// (Bun auto-loads .env into process.env). No value from env is ever logged, only names.
//
// The Registry (tenants, boards, grants, invites, links) is durable: SQLite in <data>/registry.db, next to the
// log in <data>/plenary.db, so boards and their ops both survive a restart or a kill -9.
// POST /boards and sign-in are platform's HTTP routes (server/auth/http.js), mounted here. With dev tokens on there
// is also one dev board: created on the first start, its id kept in
// <data>/dev-board.json and reused afterwards (and logged). Each dev user gets the role its token names (default
// editor; if two tokens name one user, the highest role). A restart never demotes the board's last owner.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./log.js";
import { createServer } from "./server.js";
import { sqliteStore } from "./store/sqlite.js";
import { memoryBus } from "./bus/memory.js";
import { diskBlobs } from "./blobs/disk.js";
import { authPort } from "./auth/port.js";
import { devAuth } from "./auth/dev.js";
import { sqliteRegistry } from "./registry/sqlite.js";
import { tenancy as makeTenancy } from "./auth/tenancy.js";
import { sessions as makeSessions } from "./auth/session.js";
import { googleOidc } from "./auth/oidc.js";
import { httpRoutes } from "./auth/http.js";
import { bootstrapTenant } from "./admin/tenants.js";
import { subjects } from "./bus/port.js";
import { ROLES } from "../packages/protocol/envelope.js";

const KEY_MIN = 32;
const keyOk = k => typeof k === "string" && new TextEncoder().encode(k).length >= KEY_MIN;

/**
 * The Registry with every change to who may use a board, except a share-link use, announced on the board's `grants`
 * subject, so gateways re-check their connections' roles (revocation). Reads pass through. A failed lookup only
 * skips the announcement. A share-link use (addLinkUse) is not announced (p5-load, p-audit F4): it only adds access,
 * for the redeemer alone, whose next hello reads it fresh; announcing it made every gateway re-check the whole
 * board on every redemption. The redeemer's other open sockets pick up the higher role on the next timed re-check.
 */
export function announcingRegistry(registry, bus, log) {
  const announce = async board => {
    try { const b = await registry.board(board); if (b) await bus.publish(subjects.grants(b.tenant, b.id), { board: b.id }); }
    catch (err) { log.warn("grants announcement failed", { board, err }); }
  };
  const after = (name, boardOf) => async (...args) => {
    const before = await boardOf(...args);
    const out = await registry[name](...args);
    const board = before ?? (out && typeof out === "object" ? out.board : null);
    if (typeof board === "string") await announce(board);
    return out;
  };
  return {
    ...registry,
    setGrant: after("setGrant", board => board),
    createInvite: after("createInvite", o => o?.board),
    revokeInvite: after("revokeInvite", async id => (await registry.invite(id).catch(() => null))?.board),
    createLink: after("createLink", o => o?.board),
    revokeLink: after("revokeLink", async id => (await registry.link(id).catch(() => null))?.board),
  };
}

/** @param {Record<string, string|undefined>} env @param {{ fetch?: typeof fetch }} [deps] tests pass a stub fetch for Google */
export async function start(env = {}, { fetch: fetchFn = globalThis.fetch } = {}) {
  const log = createLogger({ level: env.LOG_LEVEL || "info" });
  const dataDir = env.PLENARY_DATA_DIR || "./data";
  mkdirSync(dataDir, { recursive: true });

  let tokens = null;
  if (env.PLENARY_DEV_TOKENS) {
    try { tokens = JSON.parse(env.PLENARY_DEV_TOKENS); } catch { tokens = null; }
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) { log.error("PLENARY_DEV_TOKENS is not a JSON object; dev tokens stay off"); tokens = null; }
  }

  // Keys. In cluster mode every node must share them, so a missing one refuses the start; on one node a random
  // key per process works (sign-ins and sessions then don't survive a restart).
  const cluster = !!(env.DATABASE_URL || env.NATS_URL);
  let cookieKey = env.COOKIE_KEY;
  if (cookieKey !== undefined && !keyOk(cookieKey)) throw new Error(`COOKIE_KEY must be at least ${KEY_MIN} bytes`);
  if (cookieKey === undefined) {
    if (cluster) throw new Error("COOKIE_KEY is required in cluster mode (DATABASE_URL or NATS_URL is set): every node must sign with the same key");
    cookieKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    log.warn("COOKIE_KEY is not set: using a random key for this process; sign-ins won't survive a restart");
  }
  const sessionKey = env.SESSION_KEY ?? cookieKey;
  if (!keyOk(sessionKey)) throw new Error(`SESSION_KEY must be at least ${KEY_MIN} bytes`);
  const redirectUri = env.OIDC_REDIRECT_URI || "http://localhost:8080/auth/callback";
  const origin = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : new URL(redirectUri).origin;

  const store = sqliteStore({ path: join(dataDir, "plenary.db") });
  const bus = memoryBus({ onError: (err, subject) => log.error("bus subscriber failed", { subject, err }) });
  const blobs = diskBlobs({ dir: join(dataDir, "blobs") });
  const rawRegistry = sqliteRegistry({ path: join(dataDir, "registry.db") });
  const registry = announcingRegistry(rawRegistry, bus, log);
  const dev = devAuth(tokens ? { enabled: true, tokens } : undefined);
  const sessions = await makeSessions({ key: sessionKey });
  const tenancy = makeTenancy({ registry });
  const auth = authPort({ sessions, dev, tenancy });
  // Google sign-in only when both halves of the OAuth client are there; otherwise /auth answers 503.
  const oidc = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? googleOidc({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri, fetch: fetchFn })
    : null;
  log.info("sign-in", { google: !!oidc, devTokens: dev.enabled, cluster });

  let devBoard = null;
  if (dev.enabled) {
    // Reuse the dev board across restarts (the Registry has no list call to find it by).
    const devFile = join(dataDir, "dev-board.json");
    let saved = null;
    if (existsSync(devFile)) { try { saved = JSON.parse(readFileSync(devFile, "utf8")).board; } catch { saved = null; } }
    // Not in a try: a Registry that can't answer must fail the start, not mint a second dev board.
    let board = typeof saved === "string" ? await rawRegistry.board(saved) : null;
    if (!board) {
      const tenant = await registry.createTenant({ domain: null });
      board = await registry.createBoard({ tenant: tenant.id, title: "dev board", memberRole: null });
      // Written whole or not at all (a kill mid-write must not leave half a file that hides the board).
      writeFileSync(devFile + ".tmp", JSON.stringify({ board: board.id }));
      renameSync(devFile + ".tmp", devFile);
    }
    // Two tokens may name the same user: one grant per user, the highest role wins (ROLES is highest first), so
    // one start never lowers a grant it has just made.
    const best = new Map();
    for (const t of Object.values(tokens)) {
      if (!t || typeof t.name !== "string" || !t.name) continue;
      const user = "dev:" + t.name, role = ROLES.includes(t.role) ? t.role : "editor";
      if (!best.has(user) || ROLES.indexOf(role) < ROLES.indexOf(best.get(user))) best.set(user, role);
    }
    // Across restarts a token's role may have dropped. The Registry refuses to demote a board's last owner
    // (code "last-owner"): that grant is kept and the start goes on. Raises go first, so a new owner named in the
    // same start is in place before an old one is lowered.
    const byRank = [...best].sort((a, b) => ROLES.indexOf(a[1]) - ROLES.indexOf(b[1]));
    for (const [user, role] of byRank) {
      try { await registry.setGrant(board.id, user, role); }
      catch (err) { if (err?.code !== "last-owner") throw err; log.warn("a dev token would demote the dev board's last owner; kept as owner", { user }); }
    }
    devBoard = board.id;
    // Each dev domain with a token flagged admin gets its tenant, those users as its admins (p5-devadmin). A bad
    // domain is skipped with an error log; a Registry failure fails the start.
    const domains = new Map();
    for (const t of Object.values(tokens)) {
      if (t?.admin !== true || typeof t.name !== "string" || !t.name || typeof t.domain !== "string" || !t.domain) continue;
      const d = t.domain.trim().toLowerCase();
      domains.set(d, [...(domains.get(d) ?? []), "dev:" + t.name]);
    }
    for (const [domain, admins] of domains) {
      try { const r = await bootstrapTenant({ registry, domain, admins }); log.info("dev tenant", { tenant: r.tenant.id, domain, created: r.created, added: r.added }); }
      catch (err) { if (err?.code !== "bad-request") throw err; log.error("dev token domain skipped", { domain, err }); }
    }
    log.warn("dev tokens are ON: not for production", { board: board.id, tenant: board.tenant, users: best.size });
  } else if (oidc) log.info("dev tokens are off: sign-in is Google only");
  else log.warn("dev tokens are off and Google sign-in is not configured (GOOGLE_CLIENT_ID/SECRET): every hello will be refused");

  const perUser = Number(env.PLENARY_MAX_CONNS_PER_USER);
  const limits = Number.isSafeInteger(perUser) && perUser > 0 ? { maxConnsPerUser: perUser } : undefined;
  const config = {
    cookieKey,
    postLoginUrl: env.POST_LOGIN_URL || `${origin}/`,
    boardUrl: env.BOARD_URL || `${origin}/?board={board}`,
    publicUrl: origin,
  };
  const http = httpRoutes({ registry, sessions, oidc, tenancy, now: Date.now, config, ...(dev.enabled ? { dev } : {}) });
  const server = createServer({ auth, registry, store, bus, blobs, log, limits, http, port: Number(env.PORT ?? 8080), hostname: env.HOST || "127.0.0.1" });
  return { server, store, bus, registry, log, devBoard, oidc, async stop() { await server.stop(); await bus.close(); await store.close(); await rawRegistry.close(); } };
}

if (import.meta.main) {
  const env = process.env;   // the process entry point is the one place that reads the real environment
  const log = createLogger({ level: env.LOG_LEVEL || "info" });
  // Handlers catch their own errors; these are the last line, so one bug never takes every board down with it.
  process.on("uncaughtException", err => log.error("uncaught exception", { err }));
  process.on("unhandledRejection", err => log.error("unhandled rejection", { err }));
  const app = await start(env);
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
    if (stopping) return; stopping = true;
    try { await app.stop(); } catch (err) { log.error("shutdown failed", { err }); }
    process.exit(0);
  });
}
