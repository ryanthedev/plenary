// Entry point (single node or one cluster node): `bun server/main.js`.
//   Single node (neither DATABASE_URL nor NATS_URL): SQLite store and registry, in-memory bus, both roles.
//   Cluster node (both set): Postgres store and registry, NATS bus, the roles PLENARY_ROLES names.
//   Blobs (picture bytes; PROTOCOL.md § Blobs): S3-compatible when S3_ENDPOINT is set, else local disk
//   (PLENARY_DATA_DIR/blobs). A cluster node (DATABASE_URL/NATS_URL) with no S3_ENDPOINT REFUSES to start: a
//   picture put through one node would be unreadable through another. PLENARY_BLOBS=local-disk opts in to disk for a
//   cluster with a single gateway (the start warns).
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
//   S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY   S3-compatible blobs (the bucket must
//                        exist). S3_ENDPOINT set → all five are required, else the start is refused naming the missing
//                        ones. S3_SESSION_TOKEN (optional) goes to the client. Never logged.
//   PLENARY_BLOBS        unset, or `local-disk` (see above); anything else refuses the start. Not with S3_ENDPOINT.
//   PLENARY_BLOB_QUOTA_BYTES   per-tenant picture storage, default 10 GiB (a positive integer, else the start is refused)
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
//   DATABASE_URL         Postgres for the Store (server/store/postgres.js) and the Registry (server/registry/postgres.js).
//   NATS_URL             NATS for the Bus (server/bus/nats.js; the connection is named after PLENARY_NODE_ID).
//                        Either URL set = cluster mode, and then BOTH are required: one without the other refuses the
//                        start (a Postgres store with an in-memory bus would split-brain across nodes). Set but
//                        empty (or blank) refuses the start too. Their values carry passwords: never logged, never in
//                        an error (only the names are); every log line of the node is redacted (redactingLogger).
//                        Clusters may share one NATS server: every subject is prefixed with the cluster id kept in the
//                        Postgres store (PROTOCOL.md § Bus, Cluster id), so there is nothing to configure.
//                        NATS_URL may be a comma list; its credentials (user:pass@ or token@, one set for all
//                        servers) go to the NATS client as options (bus/nats.js natsConnectOptions).
//   PLENARY_NODE_ID      this node's id: [a-z0-9-], 1-32 chars, a letter or digit at both ends, else the start is
//                        refused. Default: the hostname, lowercased, other characters turned into "-", cut to 32,
//                        edge dashes dropped. Room leases name their holder
//                        "<node>-<pid>-<random>". Logged at start.
//   PLENARY_ROLES        comma list of gateway, host (spaces trimmed, any case); default both. Empty, unknown or
//                        repeated names refuse the start; a single node (no URLs) refuses anything but both.
//                        gateway: sockets, sign-in, POST /boards, the web app. host: room hosts (one sequencer per
//                        board, under its Store lease). A gateway-only node asks the cluster's hosts to open a board
//                        over NATS, so a cluster needs at least one host node. A host-only node serves /health only.
//   PLENARY_LEASE_TTL_MS a room lease's ttl, integer ms from 3 to 600000, default 10000. EVERY NODE MUST USE THE SAME
//                        VALUE: watchers time takeovers by it, and a gateway-only node waits this long for a host's
//                        first answer before telling the writer `unavailable` (a `watching` answer then resolves
//                        after its grace, so at worst ttl + min(1000, ttl/4)).
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

import { hostname as osHostname } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./log.js";
import { createServer } from "./server.js";
import { sqliteStore } from "./store/sqlite.js";
import { postgresStore } from "./store/postgres.js";
import { memoryBus } from "./bus/memory.js";
import { natsBus } from "./bus/nats.js";
import { postgresRegistry } from "./registry/postgres.js";
import { checkLeaseTtl } from "./room-host.js";
import { diskBlobs } from "./blobs/disk.js";
import { zlibDeflate } from "./compress/zlib.js";
import { s3Blobs } from "./blobs/s3.js";
import { authPort } from "./auth/port.js";
import { devAuth } from "./auth/dev.js";
import { sqliteRegistry } from "./registry/sqlite.js";
import { tenancy as makeTenancy, roleCache } from "./auth/tenancy.js";
import { sessions as makeSessions } from "./auth/session.js";
import { googleOidc } from "./auth/oidc.js";
import { httpRoutes } from "./auth/http.js";
import { homeService, recentRecorder } from "./auth/home.js";
import { spaceService } from "./auth/spaces.js";
import { bootstrapTenant } from "./admin/tenants.js";
import { subjects } from "./bus/port.js";
import { isClusterId } from "./ids.js";
import { ROLES } from "../packages/protocol/envelope.js";

const KEY_MIN = 32;
const keyOk = k => typeof k === "string" && new TextEncoder().encode(k).length >= KEY_MIN;

// A letter or digit at both ends (p4-wire2 L6): newHolder strips edge dashes, so "-" would not name the node.
const NODE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ROLE_NAMES = ["gateway", "host"];

/** The default node id: the hostname, lowercased, other characters turned into "-", cut to 32, no "-" at either end (never refused). */
export function defaultNodeId(host) {
  return String(host ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32).replace(/^-+|-+$/g, "") || "node";
}

/**
 * Reads the cluster part of env (nothing else), or throws an Error naming the variable. Never puts a URL's value
 * in a message. @returns {{ cluster: boolean, node: string, roles: { gateway: boolean, host: boolean }, leaseTtlMs: number }}
 */
export function nodeConfig(env, host = osHostname()) {
  // Present but empty is a mistake (an unset compose interpolation), not "single node" (p4-wire2 L7).
  for (const name of ["DATABASE_URL", "NATS_URL"])
    if (env[name] !== undefined && !String(env[name]).trim()) throw new Error(`${name} is set but empty: unset it for a single node, or give the URL for a cluster`);
  const hasDb = env.DATABASE_URL !== undefined, hasNats = env.NATS_URL !== undefined, cluster = hasDb || hasNats;
  if (cluster && !hasDb) throw new Error("DATABASE_URL is required in cluster mode (NATS_URL is set): every node needs the shared Postgres store; an in-memory one would split-brain across nodes");
  if (cluster && !hasNats) throw new Error("NATS_URL is required in cluster mode (DATABASE_URL is set): every node needs the shared NATS bus; an in-memory one would split-brain across nodes");
  let node;
  if (env.PLENARY_NODE_ID !== undefined) {
    node = env.PLENARY_NODE_ID;
    if (!NODE_ID.test(node)) throw new Error("PLENARY_NODE_ID must be 1-32 characters of a-z, 0-9 and -, starting and ending with a letter or digit");
  } else node = defaultNodeId(host);
  let roles = { gateway: true, host: true };
  if (env.PLENARY_ROLES !== undefined) {
    const names = String(env.PLENARY_ROLES).split(",").map(r => r.trim().toLowerCase());
    if (names.some(r => !r)) throw new Error("PLENARY_ROLES has an empty name: use a comma list of gateway, host");
    const bad = names.find(r => !ROLE_NAMES.includes(r));
    if (bad !== undefined) throw new Error(`PLENARY_ROLES names an unknown role "${bad.slice(0, 20)}": use gateway, host`);
    if (new Set(names).size !== names.length) throw new Error("PLENARY_ROLES names a role twice");
    roles = { gateway: names.includes("gateway"), host: names.includes("host") };
    if (!cluster && !(roles.gateway && roles.host)) throw new Error("PLENARY_ROLES on a single node (no DATABASE_URL or NATS_URL) must be both gateway and host");
  }
  let leaseTtlMs = 10_000;
  if (env.PLENARY_LEASE_TTL_MS !== undefined) {
    const raw = String(env.PLENARY_LEASE_TTL_MS).trim();
    leaseTtlMs = /^\d+$/.test(raw) ? Number(raw) : NaN;
    try { checkLeaseTtl(leaseTtlMs); }
    catch (err) { throw new Error(`PLENARY_LEASE_TTL_MS: ${err instanceof RangeError ? err.message.replace("leaseTtlMs", "the lease ttl") : "invalid"}`); }
  }
  return { cluster, node, roles, leaseTtlMs };
}

/**
 * The secret parts of one env URL value, longest first: each comma-separated element whole, its userinfo password
 * (raw and decoded) and `user:password`, a bare userinfo token (raw and decoded; not for postgres: URLs, where a bare
 * userinfo is a user name), and the value of every query parameter whose name says pass, token, secret or key.
 * Userinfo is cut out by hand as natsConnectOptions does (bus/nats.js), so both read the same credentials.
 */
export function urlSecrets(value) {
  const parts = [];
  const decode = x => { try { return decodeURIComponent(x); } catch { return x; } };
  const both = x => { if (x) parts.push(x, decode(x)); };
  const raw = String(value ?? "");
  if (!raw.trim()) return [];
  // The whole value too, not only its comma elements: a raw comma inside a password (postgres://u:pa,ss@h) is not a
  // list separator there.
  for (const el of [raw, ...raw.split(",").map(x => x.trim()).filter(Boolean)]) {
    parts.push(el);
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(el)?.[0] ?? "";
    const rest = el.slice(scheme.length);
    const end = rest.search(/[/?#]/);
    const authority = end < 0 ? rest : rest.slice(0, end);
    const at = authority.lastIndexOf("@");
    const info = at < 0 ? "" : authority.slice(0, at);
    if (info) {
      const colon = info.indexOf(":");
      if (colon >= 0) { both(info.slice(colon + 1)); if (colon > 0 && colon < info.length - 1) parts.push(info); }
      else if (!/^postgres(ql)?:\/\//i.test(scheme)) both(info);
    }
    const q = el.indexOf("?");
    if (q >= 0) for (const pair of el.slice(q + 1).split("#")[0].split("&")) {
      const eq = pair.indexOf("=");
      if (eq > 0 && /pass|token|secret|key/i.test(decode(pair.slice(0, eq)))) both(pair.slice(eq + 1));
    }
  }
  return [...new Set(parts.filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Every secret part of the given URLs, deduplicated, longest first (for redact's `parts`). */
const secretsOf = urls => [...new Set(urls.flatMap(urlSecrets))].sort((a, b) => b.length - a.length);

/** Text with every secret part of the given URLs (urlSecrets) replaced by "***", and any `scheme://userinfo@` too. */
export function redact(text, urls, parts = secretsOf(urls)) {
  let out = String(text ?? "");
  for (const s of parts) out = out.split(s).join("***");
  // No quote, comma or space inside the userinfo: on a JSON log line this must not run from a URL to a later "@".
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"',]*@/gi, "$1***@");
}

/**
 * A logger whose every line has the URLs' secrets redacted (p4-wire2 L2): the message, every string field, and an
 * Error's message, code and stack (log.js logs no `cause`), before log.js clips or escapes them. Errors stay
 * Errors, so lines keep their shape. Children redact too. With no URL set it returns `log` unchanged.
 */
export function redactingLogger(log, urls) {
  if (!urls.some(u => typeof u === "string" && u.trim())) return log;
  const parts = secretsOf(urls);   // once, not per string
  const r = t => redact(t, urls, parts);
  const scrub = (v, depth) => {
    if (typeof v === "string") return r(v);
    if (v instanceof Error) {
      const e = new Error(r(v.message));
      e.name = r(v.name);
      if (v.code !== undefined) e.code = r(String(v.code));
      e.stack = v.stack ? r(v.stack) : undefined;
      return e;
    }
    if (!v || typeof v !== "object" || depth >= 5 || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
    if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, depth + 1);
    return out;
  };
  const wrap = inner => ({
    debug: (msg, fields) => inner.debug(r(msg), scrub(fields, 0)),
    info: (msg, fields) => inner.info(r(msg), scrub(fields, 0)),
    warn: (msg, fields) => inner.warn(r(msg), scrub(fields, 0)),
    error: (msg, fields) => inner.error(r(msg), scrub(fields, 0)),
    child: fields => wrap(inner.child(scrub(fields, 0))),
  });
  return wrap(log);
}

/**
 * The Registry with every change to who may use a board, except a share-link use, announced on the board's `grants`
 * subject, so gateways re-check their connections' roles (revocation). Reads pass through. A failed lookup only
 * skips the announcement. A share-link use (addLinkUse) is not announced (p5-load, p-audit F4): it only adds access,
 * for the redeemer alone, whose next hello reads it fresh; announcing it made every gateway re-check the whole
 * board on every redemption. The redeemer's other open sockets pick up the higher role on the next timed re-check.
 */
export function announcingRegistry(registry, bus, log) {
  // board → tenant and link → board never change (the port has no update for either): remembered, bounded, so a
  // redemption wave costs no extra Registry reads (p5-load).
  const tenantOf = new Map(), boardOfLink = new Map();
  const remember = (m, k, v) => { if (m.size >= 10_000) m.delete(m.keys().next().value); m.set(k, v); };
  const announce = async (board, user) => {
    try {
      let tenant = tenantOf.get(board);
      if (!tenant) { const b = await registry.board(board); if (!b) return; tenant = b.tenant; remember(tenantOf, board, tenant); }
      await bus.publish(subjects.grants(tenant, board), typeof user === "string" ? { board, user } : { board });
    }
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
    // Scoped to the redeemer: gateways drop that user's cached role only (no re-check pass; it only adds access).
    async addLinkUse(link, user) {
      let board = boardOfLink.get(link);
      if (!board) { board = (await registry.link(link).catch(() => null))?.board; if (typeof board === "string") remember(boardOfLink, link, board); }
      const out = await registry.addLinkUse(link, user);
      if (typeof board === "string") await announce(board, String(user));
      return out;
    },
  };
}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "[::1]", "localhost"];

/**
 * Who may use the served page's dev sign-in menu (GET /auth/dev, which publishes dev tokens): only a local run. Returns the
 * reason it must be OFF, or null when it may be on: no user to offer (a token with `admin` or a `domain` is never
 * offered), a bind host that is not loopback, Google sign-in configured, or a node with no gateway role.
 * `publicHost`: the hostname of PUBLIC_URL when it is set (a public name means a reverse proxy or a real deployment).
 * @param {{ users: number, host: string, google: boolean, gateway: boolean, publicHost?: string | null }} o
 */
export function devMenuOff({ users, host, google, gateway, publicHost = null }) {
  if (!gateway) return "this node has no gateway role";
  if (!users) return "no dev token is offerable (tokens with admin or a domain never are)";
  if (!LOOPBACK_HOSTS.includes(String(host).toLowerCase())) return `HOST=${String(host).slice(0, 64)} is not a loopback address`;
  if (publicHost && !LOOPBACK_HOSTS.includes(publicHost.toLowerCase())) return `PUBLIC_URL (${publicHost.slice(0, 64)}) is not a loopback name`;
  if (google) return "Google sign-in is configured";
  return null;
}

/** The hostname of a PUBLIC_URL value, or null when unset or not a URL. */
const publicHostOf = v => { try { return v ? new URL(v).hostname : null; } catch { return null; } };

/** @param {Record<string, string|undefined>} env @param {{ fetch?: typeof fetch }} [deps] tests pass a stub fetch for Google */
export async function start(env = {}, { fetch: fetchFn = globalThis.fetch, write, hostname, adapters } = {}) {
  // write: tests capture log lines; hostname: tests fix the default node id; adapters: tests replace the cluster
  // adapter factories ({ postgresStore?, postgresRegistry?, natsBus? }) with fakes.
  // Every line this node logs, from any component, has the URLs' secrets redacted (p4-wire2 L2).
  const log = redactingLogger(createLogger({ level: env.LOG_LEVEL || "info", ...(write ? { write } : {}) }), [env.DATABASE_URL, env.NATS_URL]);
  // Every refusal of the cluster env comes before anything is created, connected or listening.
  const { cluster, node, roles, leaseTtlMs } = nodeConfig(env, hostname ?? osHostname());
  const dataDir = env.PLENARY_DATA_DIR || "./data";
  mkdirSync(dataDir, { recursive: true });

  let tokens = null;
  if (env.PLENARY_DEV_TOKENS) {
    try { tokens = JSON.parse(env.PLENARY_DEV_TOKENS); } catch { tokens = null; }
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) { log.error("PLENARY_DEV_TOKENS is not a JSON object; dev tokens stay off"); tokens = null; }
    else if (!Object.keys(tokens).length) tokens = null;   // "{}" is empty, so off (deploy/README.md: unset or empty = off)
  }

  // Keys. In cluster mode every node must share them, so a missing one refuses the start; on one node a random
  // key per process works (sign-ins and sessions then don't survive a restart).
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

  // Blob settings are checked before anything opens, so a bad one refuses the start with nothing to close.
  const blobs = openBlobs(env, dataDir, cluster, log);
  const quotaRaw = env.PLENARY_BLOB_QUOTA_BYTES;
  if (quotaRaw !== undefined && !/^[1-9]\d{0,15}$/.test(quotaRaw)) throw new Error("PLENARY_BLOB_QUOTA_BYTES must be a positive integer");
  // Signed blob URLs: a subkey of the shared cookie key, so every node verifies every other node's URLs and the key
  // itself never signs two kinds of thing.
  const blobKey = new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(cookieKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode("plenary/blob-url/v1")));
  log.info("node", { node, roles, cluster, leaseTtlMs });
  const { store, bus, rawRegistry, clusterId } = cluster ? await openCluster(env, node, log, adapters) : {
    store: sqliteStore({ path: join(dataDir, "plenary.db") }),
    bus: memoryBus({ onError: (err, subject) => log.error("bus subscriber failed", { subject, err }) }),
    rawRegistry: sqliteRegistry({ path: join(dataDir, "registry.db") }),
  };
  const registry = announcingRegistry(rawRegistry, bus, log);
  const dev = devAuth(tokens ? { enabled: true, tokens } : undefined);
  const sessions = await makeSessions({ key: sessionKey });
  // PLENARY_ADMIN_BOARD_CONTENT=1: a Unit admin enters every room of the Unit as owner (default off: an admin manages
  // every board but needs a role to enter one, as before Spaces; PROTOCOL.md § Organization).
  const adminBoardContent = ["1", "true"].includes(String(env.PLENARY_ADMIN_BOARD_CONTENT ?? "").trim().toLowerCase());
  const tenancy = makeTenancy({ registry, adminBoardContent });
  // Hellos read roles through a per-process cache; the gateway invalidates it on `grants` and its timed pass reads fresh (p5-load).
  const auth = authPort({ sessions, dev, tenancy: roleCache({ registry, now: Date.now, adminBoardContent }) });
  // Google sign-in only when both halves of the OAuth client are there; otherwise /auth answers 503.
  const oidc = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? googleOidc({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri, fetch: fetchFn })
    : null;
  log.info("sign-in", { google: !!oidc, devTokens: dev.enabled, cluster });
  if (!!env.GOOGLE_CLIENT_ID !== !!env.GOOGLE_CLIENT_SECRET)
    log.warn(`Google sign-in is half configured: ${env.GOOGLE_CLIENT_ID ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"} is missing, so it stays off`);

  let devBoard = null, devMenu = null;
  // Dev users from the token table (names; one grant per user), and whether the dev sign-in menu may be on at all: ONE
  // decision (devMenuOff), used by both branches below.
  let best = new Map(), offered = new Map(), off = null;
  const host = env.HOST || "127.0.0.1";
  if (dev.enabled) {
    // Two tokens may name the same user: one grant per user, the highest role wins (ROLES is highest first), so
    // one start never lowers a grant it has just made.
    for (const t of Object.values(tokens)) {
      if (!t || typeof t.name !== "string" || !t.name) continue;
      const user = "dev:" + t.name, role = ROLES.includes(t.role) ? t.role : "editor";
      if (!best.has(user) || ROLES.indexOf(role) < ROLES.indexOf(best.get(user))) best.set(user, role);
    }
    // The dev sign-in menu: each name once, with the role it is actually granted (the highest across its tokens). A token
    // with admin or a domain is a tenant admin or a Workspace member. Identity is per name (dev:<name>), so a name that ANY
    // token flags admin or gives a domain is never published, whatever its other tokens say.
    const privileged = new Set(Object.values(tokens).filter(t => t && (t.admin === true || t.domain)).map(t => t.name));
    for (const [token, t] of Object.entries(tokens)) {
      if (!t || typeof t.name !== "string" || !t.name || privileged.has(t.name) || offered.has(t.name)) continue;
      offered.set(t.name, { name: t.name, token, role: best.get("dev:" + t.name) });
    }
    // The same Registry filter the route runs per request (server/auth/http.js), so the count below is true at start.
    // A Registry that cannot answer turns the menu OFF with one warn line; it never stops the start.
    let registryDown = null;
    if (offered.size) {
      try {
        const admins = new Set(await registry.tenantAdminsAmong([...offered.keys()].map(n => "dev:" + n), { timeoutMs: 5000 }));
        for (const n of [...offered.keys()]) if (admins.has("dev:" + n)) { offered.delete(n); log.warn(`dev sign-in menu: ${n} is a tenant admin in the registry, so it is not offered`); }
      } catch (err) {
        // Why, in a few characters: an error code or name (never its message, which may quote a URL), so the default log level shows the cause.
        // The 5-character Postgres SQLSTATE (errno, e.g. 42P01) first, then code, then name; letters, digits and "_" only.
        const code = [/^[0-9A-Z]{5}$/.test(err?.errno) ? err.errno : null, err?.code, err?.name].find(c => typeof c === "string" && /^[A-Za-z0-9_]{1,40}$/.test(c)) ?? "error";
        registryDown = `the Registry could not say who is a tenant admin (${code})`;
        log.debug("dev sign-in menu: the admin check failed", { err });
      }
    }
    off = registryDown ?? devMenuOff({ users: offered.size, host, google: !!oidc, gateway: roles.gateway, publicHost: publicHostOf(env.PUBLIC_URL) });
  }
  if (dev.enabled && !roles.gateway) log.warn("dev tokens are on, but the dev sign-in menu (GET /auth/dev) is OFF: " + off + " (no dev board on this node)", { host });
  else if (dev.enabled) {
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
    if (off) log.warn("dev tokens are on, but the dev sign-in menu (GET /auth/dev) is OFF: " + off, { host });
    else {
      devMenu = { board: board.id, users: [...offered.values()], hosts: LOOPBACK_HOSTS };
      log.warn("dev sign-in menu is ON: GET /auth/dev publishes the tokens of the dev users to anyone who can reach this server", { users: offered.size, host });
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
  if (devMenu) config.devSignIn = devMenu;
  const home = homeService({ registry, tenancy });
  // A general-access change on a Space or Group tells every board it reaches to re-check roles (PROTOCOL.md § Organization, Freshness).
  const spaces = spaceService({ registry, tenancy, home, announce: (tenant, board) => bus.publish(subjects.grants(tenant, board), { board }), log: log.child({ component: "spaces" }) });
  const http = httpRoutes({ registry, sessions, oidc, tenancy, home, spaces, now: Date.now, config, log: log.child({ component: "auth" }), ...(dev.enabled ? { dev } : {}) });
  const server = createServer({ auth, registry, store, bus, blobs, blobKey, ...(env.PUBLIC_URL ? { publicUrl: origin } : {}), ...(quotaRaw ? { quotaBytes: Number(quotaRaw) } : {}), log, limits, http, deflate: zlibDeflate(), onWelcomed: recentRecorder({ registry, log: log.child({ component: "home" }) }), port: Number(env.PORT ?? 8080), hostname: env.HOST || "127.0.0.1",
    roles, node, host: { hostname: node, leaseTtlMs } });
  return { server, store, bus, registry, log, devBoard, oidc, node, roles, cluster, clusterId, leaseTtlMs,
    async stop() { await server.stop(); await Promise.race([spaces.settled(), new Promise(r => setTimeout(r, 2000).unref?.())]);   // let grants announcements finish (bounded)
      await bus.close(); await store.close(); await rawRegistry.close(); } };
}

/**
 * S3 when S3_ENDPOINT is set (all five settings, or the start is refused), else this node's disk. A cluster node must
 * name its choice: without S3_ENDPOINT it needs PLENARY_BLOBS=local-disk (a cluster with ONE gateway, where nobody else
 * reads the disk), because a picture put through one node would be unreadable through another.
 */
function openBlobs(env, dataDir, cluster, log) {
  const mode = env.PLENARY_BLOBS;
  if (mode !== undefined && mode !== "local-disk") throw new Error('PLENARY_BLOBS must be "local-disk" (or unset)');
  if (mode === "local-disk" && env.S3_ENDPOINT) throw new Error("PLENARY_BLOBS=local-disk and S3_ENDPOINT are both set: pick one");
  if (!env.S3_ENDPOINT) {
    if (cluster && mode !== "local-disk") throw new Error("cluster mode needs picture storage every node can reach: set S3_ENDPOINT (with S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY), or PLENARY_BLOBS=local-disk for a cluster with a single gateway");
    if (cluster) log.warn("PLENARY_BLOBS=local-disk: pictures are stored on this node's disk; a second gateway could not read them");
    return diskBlobs({ dir: join(dataDir, "blobs") });
  }
  const names = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"], missing = names.filter(n => !env[n]);
  if (missing.length) throw new Error(`S3_ENDPOINT is set, so ${missing.join(", ")} must be set too`);
  log.info("blobs: S3-compatible", { bucket: env.S3_BUCKET });
  return s3Blobs({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}) });
}

/**
 * The cluster adapters: Postgres store and registry (DATABASE_URL), NATS bus (NATS_URL, named after the node).
 * A failure closes what already opened and throws an Error naming the variable, with every URL part redacted.
 */
async function openCluster(env, node, log, adapters = {}) {
  const make = { postgresStore, postgresRegistry, natsBus, ...adapters };
  const urls = [env.DATABASE_URL, env.NATS_URL];
  const opened = [];
  const open = async (what, name, fn) => {
    try { const x = await fn(); opened.push(x); return x; }
    catch (err) {
      for (const x of opened.reverse()) await Promise.resolve().then(() => x.close()).catch(() => {});
      const code = typeof err?.code === "string" ? ` [${redact(err.code, urls).slice(0, 40)}]` : "";
      throw new Error(`could not open the ${what} (${name})${code}: ${redact(err?.message ?? String(err), urls).slice(0, 500)}`);
    }
  };
  const store = await open("Postgres store", "DATABASE_URL", () => make.postgresStore({ url: env.DATABASE_URL }));
  const rawRegistry = await open("Postgres registry", "DATABASE_URL", () => make.postgresRegistry({ url: env.DATABASE_URL }));
  // The cluster id lives in the Store: two nodes on one database are one cluster. It enters the Bus through the
  // adapter's `cluster` option, so every subject on the wire carries it and a foreign cluster on the same NATS can't
  // answer a remote open, take a lease or ack an op (PROTOCOL.md § Bus, Cluster id). A missing or malformed id
  // refuses the start (fail closed; the entry point logs "start refused").
  let clusterId;
  try {
    if (typeof store.clusterId !== "function") throw new Error("the store has no clusterId()");
    clusterId = await store.clusterId();
    if (!isClusterId(clusterId)) throw new Error("the store returned a malformed cluster id");
  } catch (err) {
    for (const x of [rawRegistry, store]) await Promise.resolve().then(() => x.close()).catch(() => {});
    throw new Error(`could not read the cluster id (DATABASE_URL): ${redact(err?.message ?? String(err), urls).slice(0, 500)}`);
  }
  const bus = await open("NATS bus", "NATS_URL", () => make.natsBus({ url: env.NATS_URL, name: node, cluster: clusterId,
    // `log` is the redacting logger: the error's message, code and stack are redacted there.
    onError: (err, subject) => log.error("bus error", { subject, err }) }));
  log.info("cluster adapters open", { store: "postgres", registry: "postgres", bus: "nats", cluster: clusterId });
  return { store, bus, rawRegistry, clusterId };
}

if (import.meta.main) {
  const env = process.env;   // the process entry point is the one place that reads the real environment
  const log = redactingLogger(createLogger({ level: env.LOG_LEVEL || "info" }), [env.DATABASE_URL, env.NATS_URL]);
  // Handlers catch their own errors; these are the last line, so one bug never takes every board down with it.
  process.on("uncaughtException", err => log.error("uncaught exception", { err }));
  process.on("unhandledRejection", err => log.error("unhandled rejection", { err }));
  let app;
  // A refused start (bad env, an adapter that won't open) prints its message and exits non-zero, before listening.
  try { app = await start(env); }
  catch (err) { log.error("start refused", { message: redact(err?.message ?? String(err), [env.DATABASE_URL, env.NATS_URL]) }); process.exit(1); }
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
    if (stopping) return; stopping = true;
    try { await app.stop(); } catch (err) { log.error("shutdown failed", { err }); }
    process.exit(0);
  });
}
