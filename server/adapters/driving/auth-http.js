// @ts-check
// HTTP routes for sign-in and the admin API, as one standalone handler (brief p5-http). The engine's server mounts
// it with `createServer({ http: httpRoutes(deps) })`: its own routes run first, then these, then a 404.
//
//   httpRoutes(deps) → async (req: Request, url?: URL) => Response | null      (null = "not my route")
//   deps = { registry, sessions, oidc, tenancy, now, config, dev?, log?, testHooks? }
//     log: optional { warn(msg, fields) } (server/log.js shape). A failed callback logs ONE line,
//          "sign-in failed" { cause }, cause from SIGN_IN_CAUSES below or oidc.js CAUSES (p5-googlev LOW 1): fixed
//          labels only, never a code, state, token, cookie value or Google's error_description. Default: one JSON
//          line on stdout in server/log.js's format, so the real server logs causes even when its composition root
//          passes no logger (this file may not import server/log.js: test/auth/architecture.test.js rule 3).
//     testHooks: tests only, not an API. { pruned({ visited, expired, live }) } runs after the first replay-guard prune of each
//                callback (the up-front `seen` check; the later `use` prunes again without reporting).
//     dev: optional dev-token verifier (server/auth/dev.js devAuth). Only when given AND enabled does Bearer accept
//          dev tokens as well as session tokens; off by default.
//     config.cookieKey      ≥ 32 bytes (string or bytes), signs the login cookie AND the exchange cookie, which carries
//                           an identity the exchange turns into a session: whoever holds it can mint sessions, so
//                           guard and rotate it like the session key. Required when `oidc` is set.
//     config.postLoginUrl   absolute http(s) URL; the callback sends the browser here with `#code=…`. Its origin is
//                           the only Origin POST /auth/exchange accepts; it must be this server's origin (the
//                           exchange cookie is a host-only `__Host-` cookie sent with same-origin fetches).
//     config.postLogoutUrl  absolute http(s) URL (default postLoginUrl)
//     ONE ORIGIN: postLoginUrl, postLogoutUrl, boardUrl, publicUrl and the OIDC redirect URI must share one origin
//     (this server's). The first four are checked at build time; the redirect URI is the caller's duty.
//     config.boardUrl       absolute URL template with "{board}"; where a redeemed share link lands
//     config.publicUrl      optional absolute base URL; when set, a created link carries `url` (<publicUrl>/links/<id>)
//     config.devSignIn      optional { board, users: [{ name, token, role }], hosts: [hostname], waitMs?: Registry wait, default 3000 }: GET /auth/dev answers it, only while
//                           `dev` is on and the request's Host is one of `hosts` (else 404: a DNS-rebinding page can't read it)
//     config.requestDeadlineMs  every route answers within this many ms (default 8000) or 503 `unavailable`; deps.timers { set, clear } runs it (tests pass a virtual one)
//     config.maxBody        JSON body cap in bytes (default 16384)
//     config.maxLoginStates replay-guard size cap (default 100000); when full, callbacks get 503 (fails closed).
//                           The used-code set of /auth/exchange has the same cap and also fails closed.
//   `oidc` may be null (Google not configured): sign-in routes then answer 503 `sign-in-unavailable`.
//
// Routes (anything else, including /health, /ws, /blobs/*, /metrics, gives null):
//   GET    /auth/login                         302 to Google; login state in a signed short-lived cookie
//   GET    /auth/callback                      302 to postLoginUrl (or the board of a pending share link) #code=…,
//                                              sets the exchange cookie
//   POST   /auth/exchange                      { code } + exchange cookie + Origin → 200 { token, user, name, email,
//                                              domain, exp }; 400 invalid-code; 403 bad-origin; 503 unavailable
//   GET    /auth/logout                        clears the login cookie, 302 to postLogoutUrl
//   GET    /boards                             → 200 { boards, isAdmin }; boards accessible in caller's tenant(s)
//   POST   /boards                             { title?, space?, memberRole?, tenant? } → 201 { board }; board.create at `space`, else the personal space
//   PATCH  /boards/:board                      { title?, memberRole? } → 200 { board }; DELETE /boards/:board → 204
//   GET    /boards/:board/audit                ?limit=&before= → 200 { events, nextBefore } (owner or tenant admin)
//   GET    /boards/:board/snapshot             ?seq=&ticket= → 200/304 (F9 off-WS HTTP catch-up)
//   GET    /admin/audit                        ?limit=&before=&board= → 200 { events, nextBefore } (tenant admin)
//   GET|POST /tenants, GET|POST /tenants/:id/members, DELETE /tenants/:id/members/:email (self-serve personal orgs)
//   GET /spaces?can=board.create, GET /groups?can=space.create,
//   POST /spaces, GET|PATCH /spaces/:id, GET|PATCH /groups/:id: PROTOCOL.md § Spaces and Groups (server/auth/spaces.js)
//   GET|POST /teams, GET|PATCH|DELETE /teams/:id, PUT|DELETE /teams/:id/members/:user, GET /directory,
//   GET /access/:type/:id, PUT|DELETE /access/:type/:id/grants/:subjectType/:subject: PROTOCOL.md § Teams and access (server/auth/access.js)
//   POST /access/:type/:id/requests, DELETE /access/:type/:id/requests/:user, GET /boards/:board/explain: PROTOCOL.md § Access explanation and requests
//   GET|POST /roles, PATCH|DELETE /roles/:id: PROTOCOL.md § Roles (server/auth/roles.js)
//   GET    /boards/:board/share                → { board, unit: { domains }, limits, invites: [{ …, guest }], links: [{ …, url? }], more } (the Share dialog's one read; `members.manage`)
//   GET    /boards/:board/invites              → { invites }
//   POST   /boards/:board/invites              { email, role, expiresAt? (default now + 30 days; null = never) } → 201 { invite: { …, guest } }
//   DELETE /boards/:board/invites/:invite      → 204
//   GET    /boards/:board/links                → { links }
//   POST   /boards/:board/links                { role, expiresAt? } → 201 { link, url? }
//   DELETE /boards/:board/links/:link          → 204
//   PUT    /boards/:board/grants/:user         { role | null } → 204   (user ids are URL-encoded, e.g. google%3A123)
//   GET    /home                               → { guest, user, unit, recent, starred, owned, shared, tree, limits }   (needs `home`; PROTOCOL.md § Home)
//   GET    /home/search?q=                     → { q, results, more }   (q: 1-100 chars, else 400)
//   GET    /home/search?space=<id>             → { space, results, more }   (the Space's boards the person can open; `space` null unless they can open the Space)
//   PUT    /home/stars/:board                  → 204 (403 `forbidden` for a guest, or without a role on the board)
//   DELETE /home/stars/:board                  → 204
//   GET    /links/:link                        redeem: Bearer → 200 { board, url }; no Bearer → sign in first,
//                                              the link rides in the login cookie, the callback redeems it
//
// Security choices:
// - API routes authenticate with `Authorization: Bearer <session token>` only. No cookie authenticates an API
//   request, so they have no CSRF surface. The one cookie-bearing POST is /auth/exchange (below), guarded by Origin. (Herdr can't send credential headers; nothing drawh needs lives here.)
// - No session token ever goes in a URL (brief p5-code: browsers keep URLs, fragments included, in on-disk history).
//   The callback puts a one-time CODE in the fragment of a configured URL: 32 random bytes, nothing else (no
//   identity, so history leaks no email either). The identity rides in the exchange cookie (`__Host-plen_xchg`:
//   Secure, HttpOnly, SameSite=Strict, Path=/, 60 s) holding { h: sha256(code), identity, exp } signed with HMAC,
//   prefix "x1." (never verifies as "l1." or "s1."). POST /auth/exchange checks Origin, then the cookie's MAC and
//   expiry (inside the payload, against `now`), then sha256(code) == h, then issues the session token. A code is
//   useless without the HttpOnly cookie and the cookie without the code. Stateless, so the callback and the exchange
//   may hit different nodes. Single use: the 200 and the 400 clear the cookie, and each node keeps a set of used
//   code hashes until they expire. NOT covered: a replay on ANOTHER node within 60 s by someone holding both the
//   code and the HttpOnly cookie (i.e. who already controls that browser). The exchange is a cookie-authenticated
//   POST, so it checks Origin (CSRF guard); it hands out a token only in its own response body.
// - Redirect targets come from config only, never from the request (no open redirect).
// - The login cookie (`__Host-plen_login`: Secure, HttpOnly, SameSite=Lax, Path=/, ≤ 10 min) holds
//   { state, nonce, verifier, link? } signed with HMAC; its expiry is inside the signed payload and checked
//   against `now`. Prefix "l1." so it can never pass as a session token ("s1.").
// - Errors are JSON `{ error: code }`. An unknown board and a board the caller can't manage give the same 403
//   (server/admin/boards.js). Infrastructure errors (a Registry or verifier that throws) give 503 `unavailable`.
//   This handler never throws (the engine would turn a throw into a 500).

import { b64url, unb64url, utf8, fromUtf8, higher, isTenantAdminRecord } from "../../core/auth/util.js";
import { BOARD_VERSIONS } from "../../ports/registry.js";
import { spaceService } from "../../core/auth/spaces.js";
import { accessService } from "../../core/auth/access.js";
import { explainService } from "../../core/auth/explain.js";
import { rolesService } from "../../core/auth/roles.js";
import { moveService } from "../../core/auth/move.js";
import { trashService } from "../../core/auth/trash.js";
import { offboardService } from "../../core/auth/offboard.js";
import { versionService } from "../../core/auth/versions.js";
import { ComplianceError, exportBoardData, exportTenantData, eraseUserData } from "../../core/auth/compliance.js";
import { createLinkRateLimiter } from "../../core/auth/share-policy.js";
import { AdminError, listBoards, createBoard, updateBoard, deleteBoard, createInvite, listInvites, readInvite, revokeInvite, createLink, listLinks, readLink, revokeLink, verifyLinkAccess, setGrant, shareView, listBoardAudit, listTenantAudit } from "../../core/admin/boards.js";
import { createPersonalTenant, listTenants, listTenantMembers, addTenantMember, removeTenantMember, promoteTenantAdmin, demoteTenantAdmin, getTenantMemberSummary, listTenantSpacesOverview, provisionDomainTenant } from "../../core/admin/tenants.js";

const defaultLinkRateLimiter = createLinkRateLimiter();

export const LOGIN_COOKIE = "__Host-plen_login";
export const EXCHANGE_COOKIE = "__Host-plen_xchg";
const LOGIN_TTL_SEC = 600;
const CODE_TTL_SEC = 60;
export const CLI_TOKEN_TTL_SEC = 90 * 24 * 60 * 60;
export const CLI_TOKEN_TTL_MS = CLI_TOKEN_TTL_SEC * 1000;
const CLI_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CLI_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CLI_VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CLI_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax";
const XCHG_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Strict";

/** How long GET /auth/dev waits for the Registry before it answers 503 (a tighter bound than the request deadline). */
const DEV_MENU_WAIT_MS = 3000;
/** The default request deadline (PROTOCOL.md "HTTP request deadline"): under the idle cut (server.js sets 30 s; Bun's own default is 10 s) and the inner limits main.js sets. */
export const REQUEST_DEADLINE_MS = 8000;
/** `Idempotency-Key`: 8-64 of [A-Za-z0-9_-] (PROTOCOL.md "Idempotent creates"). */
const IDEM_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const NO_STORE = { "cache-control": "no-store" };
const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...NO_STORE, ...headers },
  });
const err = (status, error, extra = {}, headers) => json(status, { error, ...extra }, headers);
const redirect = (location, cookies = []) => {
  const h = new Headers({ location, ...NO_STORE, "referrer-policy": "no-referrer" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};
const withCookie = (res, cookie) => { res.headers.append("set-cookie", cookie); return res; };

const absUrl = (v, name) => {
  let u;
  try { u = new URL(v); } catch { throw new Error(`http: config.${name} must be an absolute URL`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`http: config.${name} must be http(s)`);
  if (u.hash) throw new Error(`http: config.${name} must not have a fragment (the sign-in code goes there)`);
  return u.href;
};

/** Thrown inside the handler for a refusal that maps straight to a response. */
class Refusal { constructor(res) { this.res = res; } }
const refuse = (status, code, extra) => new Refusal(err(status, code, extra));

/**
 * @param {{
 *   registry: import("../../ports/registry.js").Registry,
 *   sessions: { issue(id: import("../../ports/idp.js").Identity, opts?: { ttlSec?: number, ttlMs?: number }): Promise<string>, verify(t: string): Promise<import("../../ports/idp.js").Session|null>, verifySnapshotTicket?(t: string): Promise<{ board: string, seq: number, exp: number }|null> },
 *   oidc?: import("../../ports/idp.js").IdP | null,
 *   providers?: Array<{ id: string, label?: string, idp: import("../../ports/idp.js").IdP }> | Record<string, import("../../ports/idp.js").IdP> | null,
 *   tenancy: ReturnType<typeof import("../../core/auth/tenancy.js").tenancy>,
 *   home?: ReturnType<typeof import("../../core/auth/home.js").homeService> | null,
 *   now?: () => number,
 *   explainer?: ReturnType<typeof explainService>,
 *   spaces?: ReturnType<typeof spaceService>,
 *   moves?: ReturnType<typeof moveService>,
 *   trash?: ReturnType<typeof trashService>,
 *   access?: ReturnType<typeof accessService>,
 *   roles?: ReturnType<typeof rolesService>,
 *   offboard?: ReturnType<typeof offboardService>,
 *   versions?: ReturnType<typeof versionService>,
 *   config?: Record<string, any>,
 *   dev?: { enabled?: boolean, verify(t: string): Promise<import("../../ports/idp.js").Session|null> } | null,
 *   log?: { warn(msg: string, fields?: object): void, info?(msg: string, fields?: object): void, error?(msg: string, fields?: object): void },
 *   testHooks?: { pruned?(p: { visited: number, expired: number, live: number }): void, routes?(table: { pattern: string, methods: string[], names: string[] }[]): void } | null,
 *   snapshot?: { get(board: string, seq: number): Promise<any> } | null,
 *   snapshotTickets?: { verify(t: string): Promise<{ board: string, seq: number, exp: number }|null> } | null,
 *   linkRateLimiter?: import("../../core/auth/share-policy.js").LinkRateLimiter | null,
 *   timers?: { set(fn: () => void, ms: number): any, clear(h: any): void },
 * }} deps
 */
export function httpRoutes({ registry, sessions, oidc = null, providers = null, tenancy, home = null, now = Date.now, explainer = explainService({ registry, now }), spaces = spaceService({ registry, tenancy, home, now, explainer }), moves = moveService({ registry, tenancy, spaces, now }), trash = trashService({ registry, tenancy, spaces, now }), access = accessService({ registry, tenancy, now, explainer, announce: spaces.announceChange, backlog: spaces.backlog, settled: spaces.settled }), roles = rolesService({ registry, tenancy, announce: spaces.announceChange }), offboard = offboardService({ registry, tenancy, announce: spaces.announceChange }), versions = versionService({ registry, tenancy, now }), config = {}, dev = null, log = stdoutLog, testHooks = null, snapshot = null, snapshotTickets = null, linkRateLimiter = defaultLinkRateLimiter, timers = { set: (f, ms) => setTimeout(f, ms), clear: h => clearTimeout(h) } }) {
  if (!registry || !sessions || !tenancy) throw new Error("http: registry, sessions and tenancy are required");
  /** `p`, or a rejection with message "timeout" after `ms` on the injected timers. */
  const bounded = (p, ms) => new Promise((res, rej) => { const t = timers.set(() => rej(new Error("timeout")), ms); p.then(v => { timers.clear(t); res(v); }, e => { timers.clear(t); rej(e); }); });
  const deadlineMs = config.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 2 ** 31 - 1) throw new Error("http: config.requestDeadlineMs must be a positive integer (ms)");
  const postLoginUrl = absUrl(config.postLoginUrl, "postLoginUrl");
  const postLogoutUrl = config.postLogoutUrl ? absUrl(config.postLogoutUrl, "postLogoutUrl") : postLoginUrl;
  if (typeof config.boardUrl !== "string" || !config.boardUrl.includes("{board}")) throw new Error("http: config.boardUrl must contain {board}");
  absUrl(config.boardUrl.replace("{board}", "x"), "boardUrl");
  const boardUrl = board => config.boardUrl.replace("{board}", encodeURIComponent(board));
  const publicUrl = config.publicUrl ? absUrl(config.publicUrl, "publicUrl").replace(/\/+$/, "") : null;
  // One origin (p5-codev MEDIUM 1): the exchange cookie is a host-only `__Host-` cookie set by the callback, and the
  // exchange accepts only postLoginUrl's Origin, so a page on any other origin could never exchange its code. The
  // OIDC redirect URI (the callback) must be on this origin too; http.js can't see it (the IdP port hides it), so the
  // composition root must keep it there.
  {
    const o = new URL(postLoginUrl).origin;
    const others = { postLogoutUrl, boardUrl: config.boardUrl.replace("{board}", "x"), ...(publicUrl ? { publicUrl } : {}) };
    for (const [k, v] of Object.entries(others))
      if (new URL(v).origin !== o) throw new Error(`http: config.${k} must be on postLoginUrl's origin (${o}): sign-in only completes on one origin`);
  }
  const verifiers = [sessions, dev && dev.enabled === true ? dev : null].filter(Boolean);
  const maxBody = Number.isInteger(config.maxBody) && config.maxBody > 0 ? config.maxBody : 16_384;
  const versionMaxBody = Math.max(maxBody, BOARD_VERSIONS.maxSnapshotBytes + 4096);

  // ---- providers & login cookie ----
  /** @type {{ id: string, label: string, idp: import("../../ports/idp.js").IdP }[]} */
  const providerList = [];
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (!p?.idp || typeof p.id !== "string" || !p.id.trim()) continue;
      const id = p.id.trim().toLowerCase();
      if (providerList.some(x => x.id === id)) continue;
      providerList.push({ id, label: String(p.label || p.idp.displayName || id), idp: p.idp });
    }
  } else if (providers && typeof providers === "object") {
    for (const [rawId, idp] of Object.entries(providers)) {
      if (!idp) continue;
      const id = rawId.trim().toLowerCase();
      if (!id || providerList.some(x => x.id === id)) continue;
      providerList.push({ id, label: String(idp.displayName || id), idp });
    }
  } else if (oidc) {
    const id = String(oidc.providerId || (oidc.displayName === "Microsoft" ? "microsoft" : oidc.displayName === "Google" ? "google" : "oidc")).toLowerCase();
    providerList.push({ id, label: String(oidc.displayName || "Google"), idp: oidc });
  }
  const providerMap = new Map(providerList.map(p => [p.id, p]));
  const hasOidc = providerList.length > 0;
  const autoProvisionDomainOrgs = Boolean(config.autoProvisionDomainOrgs);

  let macKey = null;
  if (hasOidc) {
    const raw = typeof config.cookieKey === "string" ? utf8(config.cookieKey) : config.cookieKey;
    if (!(raw instanceof Uint8Array) || raw.length < 32) throw new Error("http: config.cookieKey must be at least 32 bytes");
    macKey = crypto.subtle.importKey("raw", /** @type {BufferSource} */ (raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  const clearLogin = `${LOGIN_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
  const clearXchg = `${EXCHANGE_COOKIE}=; ${XCHG_ATTRS}; Max-Age=0`;
  const appOrigin = new URL(postLoginUrl).origin;

  async function sealLogin({ state, nonce, verifier, link, provider, cli = null }) {
    const exp = Math.floor(now() / 1000) + LOGIN_TTL_SEC;
    const payload = b64url(utf8(JSON.stringify({
      s: state, n: nonce, v: verifier,
      ...(link ? { l: link } : {}),
      ...(provider ? { p: provider } : {}),
      ...(cli ? { cp: cli.cliPort, cs: cli.cliState, cc: cli.cliChallenge } : {}),
      exp,
    })));
    const mac = b64url(await crypto.subtle.sign("HMAC", await macKey, utf8("l1." + payload)));
    return `${LOGIN_COOKIE}=l1.${payload}.${mac}; ${COOKIE_ATTRS}; Max-Age=${LOGIN_TTL_SEC}`;
  }
  async function openLogin(req) {
    const v = cookie(req, LOGIN_COOKIE);
    if (!v || v.length > 4096) return null;
    const parts = v.split(".");
    if (parts.length !== 3 || parts[0] !== "l1") return null;
    try {
      if (!(await crypto.subtle.verify("HMAC", await macKey, unb64url(parts[2]), utf8("l1." + parts[1])))) return null;
      const c = JSON.parse(fromUtf8(unb64url(parts[1])));
      if (!c || !Number.isFinite(c.exp) || Math.floor(now() / 1000) >= c.exp) return null;
      if (![c.s, c.n, c.v].every(x => typeof x === "string" && x)) return null;
      let cli = null;
      if (c.cp !== undefined || c.cs !== undefined || c.cc !== undefined) {
        if (!Number.isInteger(c.cp) || c.cp < 1024 || c.cp > 65535
          || typeof c.cs !== "string" || !CLI_STATE_RE.test(c.cs)
          || typeof c.cc !== "string" || !CLI_CHALLENGE_RE.test(c.cc)) return null;
        cli = { cliPort: c.cp, cliState: c.cs, cliChallenge: c.cc };
      }
      return { state: c.s, nonce: c.n, verifier: c.v, link: typeof c.l === "string" ? c.l : null, provider: typeof c.p === "string" ? c.p : null, cli };
    } catch { return null; }
  }
  // States already used in THIS process (defence in depth against a replayed callback; not shared across gateways,
  // where Google's single-use code is the guard). A Map keeps insertion order, and every entry gets the same TTL
  // from `now()` at insertion, so the map is in expiry order: pruning pops expired entries from the front and stops
  // at the first live one (amortised O(1) per callback; p5-httpv MEDIUM 1). If the clock steps back, pruning just
  // stops early and entries live longer (safe). A hard cap fails CLOSED: when full, the login is refused (503),
  // never accepted without the replay guard.
  const maxStates = Number.isInteger(config.maxLoginStates) && config.maxLoginStates > 0 ? config.maxLoginStates : 100_000;
  /** A bounded per-process used-set; `use` is synchronous (no await between the check and the set). */
  const usedSet = (ttlSec, hook) => {
    const m = new Map();
    const prune = (report = true) => {
      const t = now();
      let visited = 0, expired = 0;
      for (const [s, exp] of m) { visited++; if (exp > t) break; m.delete(s); expired++; }
      if (report) hook?.({ visited, expired, live: m.size });   // tests: one report per callback, from `seen`
      return t;
    };
    return {
      /** Already used (and not expired)? Prunes first. */
      seen(key) { prune(); return m.has(key); },
      /** @returns {"ok"|"replay"|"full"} */
      use(key) {
        const t = prune(false);
        if (m.has(key)) return "replay";
        if (m.size >= maxStates) return "full";
        m.set(key, t + ttlSec * 1000);
        return "ok";
      },
      /** Un-spend a key (the work it guarded failed for an infrastructure reason). */
      release(key) { m.delete(key); },
    };
  };
  const usedStates = usedSet(LOGIN_TTL_SEC, p => testHooks?.pruned?.(p));
  // Exchange codes already spent in THIS process, by sha256(code). Defence in depth: the cookie is cleared on first
  // use, but a client could keep it. Not shared across nodes (see the header).
  const usedCodes = usedSet(CODE_TTL_SEC, null);
  // Single-use PKCE-bound CLI exchange codes (60 s TTL, bounded by maxStates, insertion-ordered by expiry).
  /** @type {Map<string, { identity: import("../../ports/idp.js").Identity, cliChallenge: string, expMs: number }>} */
  const cliCodes = new Map();
  const pruneCliCodes = () => {
    const t = now();
    for (const [k, v] of cliCodes) {
      if (v.expMs > t) break;
      cliCodes.delete(k);
    }
    return t;
  };

  // ---- exchange code + cookie ----
  async function mintCode(identity) {
    const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const h = b64url(await crypto.subtle.digest("SHA-256", utf8(code)));
    const exp = Math.floor(now() / 1000) + CODE_TTL_SEC;
    // Field types: name/email/domain string or null (empty name → null).
    const str = (v, max = 320) => (typeof v === "string" && v ? v.slice(0, max) : null);
    const payload = b64url(utf8(JSON.stringify({ h, u: identity.user, n: str(identity.name, 200), e: str(identity.email), d: str(identity.domain, 253), exp })));
    const mac = b64url(await crypto.subtle.sign("HMAC", await macKey, utf8("x1." + payload)));
    return { code, cookie: `${EXCHANGE_COOKIE}=x1.${payload}.${mac}; ${XCHG_ATTRS}; Max-Age=${CODE_TTL_SEC}` };
  }
  /** The identity and code hash the exchange cookie holds, if it is ours, unexpired and matches `code`; else null. */
  async function openXchg(req, code) {
    const v = cookie(req, EXCHANGE_COOKIE);
    if (!v || v.length > 4096 || typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
    const parts = v.split(".");
    if (parts.length !== 3 || parts[0] !== "x1") return null;
    try {
      if (!(await crypto.subtle.verify("HMAC", await macKey, unb64url(parts[2]), utf8("x1." + parts[1])))) return null;
      const c = JSON.parse(fromUtf8(unb64url(parts[1])));
      if (!c || !Number.isFinite(c.exp) || Math.floor(now() / 1000) >= c.exp) return null;
      if (typeof c.h !== "string" || typeof c.u !== "string" || !c.u) return null;
      const h = b64url(await crypto.subtle.digest("SHA-256", utf8(code)));
      if (!sameString(h, c.h)) return null;
      const s = v => (typeof v === "string" && v ? v : null);
      return { h, identity: { user: c.u, name: s(c.n), email: s(c.e), domain: s(c.d) } };
    } catch { return null; }
  }

  // The member directory write after a sign-in: best effort and bounded. At most TOUCH_MAX in flight and one per user at a time; the excess is
  // dropped (the person's next Home records them). A slot frees only when the write itself settles: the Registry adapters bound their own calls
  // (SQLite busy_timeout, Postgres lock_timeout/statement_timeout), so a hang cannot hold it for long. config.touchTimeoutMs (default 5 s,
  // clamped like devSignIn.waitMs) only stops WAITING: it logs, it never frees the slot. A failure, a slow write or a drop logs one
  // rate-limited line that identifies no one.
  const TOUCH_MAX = 16, touching = new Set();
  const tm = Number(config.touchTimeoutMs ?? 5000), TOUCH_MS = Number.isFinite(tm) && tm > 0 ? Math.min(2 ** 31 - 1, Math.max(1, Math.round(tm))) : 5000;
  let lastTouchWarn = -Infinity;
  const touchWarn = why => { if (now() - lastTouchWarn < 60_000) return; lastTouchWarn = now(); try { log?.warn?.(`member directory write ${why}; Home records the person later`); } catch {} };
  function recordMember(identity) {
    if (typeof registry.touchMember !== "function") return;
    if (touching.size >= TOUCH_MAX || touching.has(identity.user)) { if (!touching.has(identity.user)) touchWarn("dropped (too many in flight)"); return; }
    touching.add(identity.user);
    const timer = timers.set(() => touchWarn("is slow"), TOUCH_MS);
    (async () => { const unit = await tenancy.tenantOf(identity); if (unit) await registry.touchMember(unit.id, identity); })()
      .catch(() => touchWarn("failed"))
      .finally(() => { timers.clear(timer); touching.delete(identity.user); });
  }

  async function exchange(req) {
    if (!hasOidc) return err(503, "sign-in-unavailable");
    // Origin first: a refusal here spends nothing (the contract's fake does the same).
    if (req.headers.get("origin") !== appOrigin) return err(403, "bad-origin");
    const b = await body(req, ["code"]);
    const invalid = () => withCookie(err(400, "invalid-code"), clearXchg);
    const x = await openXchg(req, b.code);
    if (!x) return invalid();
    const used = usedCodes.use(x.h);
    if (used === "replay") return invalid();
    if (used === "full") return err(503, "unavailable");
    let token;
    try { token = await sessions.issue(x.identity); } catch { usedCodes.release(x.h); return err(503, "unavailable"); }
    // `exp` from the Verifier port (the token format is session.js's business). The contract promises an integer
    // exp; a sessions adapter that can't give one for its own fresh token can't meet it.
    let exp;
    try { exp = (await sessions.verify(token))?.exp; } catch { exp = null; }
    if (!Number.isInteger(exp)) { usedCodes.release(x.h); return err(503, "unavailable"); }
    // The member directory (PROTOCOL.md § Teams and access): a Unit member who signs in is findable by the pickers. Best effort, off the request path.
    recordMember(x.identity);
    return withCookie(json(200, { token, ...x.identity, exp }), clearXchg);
  }

  /**
   * Parse optional PKCE loopback CLI login params from `/auth/login`.
   * Returns `null` when none are present, `{ cliPort, cliState, cliChallenge }` when all three are valid,
   * or throws a 400 Refusal if any is present and incomplete/invalid.
   */
  function parseCliLoginParams(url) {
    const hasPort = url.searchParams.has("cli_port");
    const hasState = url.searchParams.has("cli_state");
    const hasChallenge = url.searchParams.has("cli_challenge");
    if (!hasPort && !hasState && !hasChallenge) return null;
    if (!hasPort || !hasState || !hasChallenge) throw refuse(400, "bad-request");
    const rawPort = url.searchParams.get("cli_port") ?? "";
    const cliState = url.searchParams.get("cli_state") ?? "";
    const cliChallenge = url.searchParams.get("cli_challenge") ?? "";
    if (!/^[1-9]\d{3,4}$/.test(rawPort)) throw refuse(400, "bad-request");
    const cliPort = Number(rawPort);
    if (!Number.isInteger(cliPort) || cliPort < 1024 || cliPort > 65535) throw refuse(400, "bad-request");
    if (!CLI_STATE_RE.test(cliState) || !CLI_CHALLENGE_RE.test(cliChallenge)) throw refuse(400, "bad-request");
    return { cliPort, cliState, cliChallenge };
  }

  function renderCliProviderChooser(cli) {
    const links = providerList.map(p => {
      const q = new URLSearchParams({
        provider: p.id,
        cli_port: String(cli.cliPort),
        cli_state: cli.cliState,
        cli_challenge: cli.cliChallenge,
      });
      const href = `/auth/login?${q.toString()}`;
      return `<a class="btn" href="${escapeHtml(href)}">Continue with ${escapeHtml(p.label)}</a>`;
    }).join("\n      ");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign in to Plenary CLI</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:360px;width:100%;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    h1{font-size:20px;margin:0 0 8px}
    p{font-size:14px;color:#94a3b8;margin:0 0 24px}
    .providers{display:flex;flex-direction:column;gap:12px}
    .btn{display:block;padding:12px 16px;border-radius:8px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600;font-size:15px}
    .btn:hover{background:#2563eb}
  </style>
</head>
<body>
  <main class="card">
    <h1>Sign in to Plenary CLI</h1>
    <p>Choose an identity provider to authenticate your CLI session.</p>
    <div class="providers">
      ${links}
    </div>
  </main>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...NO_STORE,
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      },
    });
  }

  async function cliExchange(req) {
    if (!hasOidc) return err(503, "sign-in-unavailable");
    const b = await body(req, ["code", "verifier"]);
    if (typeof b.code !== "string" || !CLI_CODE_RE.test(b.code)
      || typeof b.verifier !== "string" || !CLI_VERIFIER_RE.test(b.verifier)) {
      return err(401, "invalid-code");
    }
    const t = pruneCliCodes();
    const entry = cliCodes.get(b.code);
    if (!entry || entry.expMs <= t) {
      if (entry) cliCodes.delete(b.code);
      return err(401, "invalid-code");
    }
    // Single-use: consume atomically before any await.
    cliCodes.delete(b.code);
    const computed = b64url(await crypto.subtle.digest("SHA-256", utf8(b.verifier)));
    if (!sameString(computed, entry.cliChallenge)) return err(401, "invalid-verifier");
    let token;
    try { token = await sessions.issue(entry.identity, { ttlMs: CLI_TOKEN_TTL_MS, ttlSec: CLI_TOKEN_TTL_SEC }); }
    catch { return err(503, "unavailable"); }
    let verified;
    try { verified = await sessions.verify(token); } catch { verified = null; }
    if (!Number.isInteger(verified?.exp)) return err(503, "unavailable");
    recordMember(entry.identity);
    return json(200, {
      token,
      expiresAt: verified.exp * 1000,
      user: {
        id: entry.identity.user,
        name: entry.identity.name ?? null,
        email: entry.identity.email ?? null,
      },
    });
  }

  async function beginLogin(link, requestedProvider = null, cli = null) {
    if (!hasOidc) return err(503, "sign-in-unavailable");
    const rawProvider = typeof requestedProvider === "string" ? requestedProvider.trim().toLowerCase() : "";
    if (cli && !rawProvider && providerList.length > 1) {
      return renderCliProviderChooser(cli);
    }
    const selected = rawProvider ? (providerMap.get(rawProvider) ?? null) : providerList[0];
    if (!selected) return err(400, "unknown-provider");
    let b;
    try { b = await selected.idp.begin(); } catch { return err(503, "unavailable"); }
    return redirect(b.url, [await sealLogin({ ...b, link, provider: selected.id, cli })]);
  }

  /** One "sign-in failed" line; a broken logger never changes the answer. */
  const failed = cause => { try { log?.warn?.("sign-in failed", { cause }); } catch { /* logging is best effort */ } };

  async function callback(req, url) {
    if (!hasOidc) return err(503, "sign-in-unavailable");
    const fail = cause => { failed(cause); return withCookie(err(400, "login-failed"), clearLogin); };
    const expected = await openLogin(req);
    if (!expected) return fail(cookie(req, LOGIN_COOKIE) === null ? "no_login_cookie" : "bad_login_cookie");
    const selected = (expected.provider ? providerMap.get(expected.provider) : providerList[0]) ?? null;
    if (!selected) return fail("bad_login_cookie");
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    if (url.searchParams.has("error")) {
      const e = url.searchParams.get("error");
      return fail(AUTHORIZE_ERRORS.includes(e) ? `idp_error:${e}` : "idp_error");
    }
    if (state !== expected.state) return fail("state_mismatch");
    if (!code) return fail("no_code");
    // A state takes a replay-guard slot only once its callback SUCCEEDS (p5-googlev MEDIUM 2): a bogus code costs
    // no slot, so anonymous callbacks with free login cookies can't fill the guard and lock sign-in out. A used state
    // is refused up front (no Google call), and again after `finish` for two callbacks racing on one state (Google's
    // single-use code already lets only one of them through; the synchronous `use` is the second guard).
    if (usedStates.seen(expected.state)) return fail("state_used");
    let identity, cause = null;
    // Label-shaped only: 1-4 short lowercase words joined by "_", optionally "_<3 digits>" (token_http_502). A state,
    // nonce or code (32+ random chars, or mixed case) can never pass, whatever an adapter hands `why`.
    const why = c => { if (cause === null && typeof c === "string" && /^[a-z]{1,12}(?:_[a-z]{1,12}){0,3}(?:_\d{3})?$/.test(c)) cause = c; };
    try { identity = await selected.idp.finish({ code, state, expected, why }); } catch { identity = null; cause ??= "idp_threw"; }
    if (!identity) return fail(cause ?? "idp_refused");
    const used = usedStates.use(expected.state);
    if (used === "replay") return fail("state_used");
    if (used === "full") { failed("replay_guard_full"); return withCookie(err(503, "unavailable"), clearLogin); }
    if (autoProvisionDomainOrgs) {
      try { await provisionDomainTenant({ caller: identity }, { registry, now }); }
      catch { try { log?.warn?.("domain org auto-provision failed"); } catch {} }
    }
    if (expected.cli) {
      const t = pruneCliCodes();
      if (cliCodes.size >= maxStates) {
        failed("replay_guard_full");
        return withCookie(err(503, "unavailable"), clearLogin);
      }
      const cliCode = b64url(crypto.getRandomValues(new Uint8Array(32)));
      cliCodes.set(cliCode, { identity, cliChallenge: expected.cli.cliChallenge, expMs: t + CODE_TTL_SEC * 1000 });
      const loc = `http://127.0.0.1:${expected.cli.cliPort}/callback?code=${encodeURIComponent(cliCode)}&state=${encodeURIComponent(expected.cli.cliState)}`;
      return redirect(loc, [clearLogin]);
    }
    let x;
    try { x = await mintCode(identity); } catch { failed("mint_failed"); return withCookie(err(503, "unavailable"), clearLogin); }
    const frag = "#code=" + x.code;   // base64url: URL-safe as is
    if (expected.link) {
      let r = null, outage = false, passcodeRequired = false;
      try {
        r = await tenancy.redeemLink(identity, expected.link);
        if (!r) {
          const l = await registry.link(expected.link);
          if (l && !l.revoked && (l.expiresAt == null || now() < l.expiresAt) && l.hasPasscode) {
            passcodeRequired = true;
          }
        }
      } catch { outage = true; }
      if (r) return redirect(boardUrl(r.board) + frag, [clearLogin, x.cookie]);
      const linkParam = outage ? "unavailable" : passcodeRequired ? `passcode-required&linkId=${encodeURIComponent(expected.link)}` : "invalid";
      return redirect(postLoginUrl + frag + "&link=" + linkParam, [clearLogin, x.cookie]);
    }
    return redirect(postLoginUrl + frag, [clearLogin, x.cookie]);
  }

  // ---- bearer + bodies ----
  async function caller(req) {
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer ([^\s]+)$/i.exec(h);
    if (!m) throw new Refusal(err(401, "auth", {}, { "www-authenticate": "Bearer" }));
    let id;
    try {
      id = null;
      for (const v of verifiers) { id = await v.verify(m[1]); if (id) break; }
    } catch { throw refuse(503, "unavailable"); }
    if (!id) throw new Refusal(err(401, "auth", {}, { "www-authenticate": "Bearer" }));
    return id;
  }

  /** Read a JSON object body: JSON content type, ≤ limit bytes (counted as read), only `allowed` fields. */
  async function body(req, allowed, limit = maxBody) {
    const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") throw refuse(415, "unsupported-media-type");
    const len = Number(req.headers.get("content-length"));
    if (Number.isFinite(len) && len > limit) throw refuse(413, "too-large");
    const chunks = [];
    let n = 0;
    try {
      if (req.body) {
        const reader = req.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.byteLength;
          if (n > limit) { try { await reader.cancel(); } catch {} throw refuse(413, "too-large"); }
          chunks.push(value);
        }
      }
    } catch (e) { if (e instanceof Refusal) throw e; throw refuse(400, "bad-request"); }
    const bytes = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
    let v;
    try { v = JSON.parse(fromUtf8(bytes)); } catch { throw refuse(400, "bad-json"); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw refuse(400, "bad-request");
    for (const k of Object.keys(v)) if (!allowed.includes(k)) throw refuse(400, "unknown-field", { field: k.slice(0, 64) });
    return v;
  }
  const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  // ---- snapshot route (F9): off-WS HTTP catch-up with short-lived signed ticket ----
  const verifyTicket = snapshotTickets?.verify ?? (typeof sessions.verifySnapshotTicket === "function" ? t => sessions.verifySnapshotTicket(t) : null);
  async function serveSnapshot(req, p, url) {
    if (!snapshot || !verifyTicket) return err(503, "snapshot-unavailable");
    const ticket = url.searchParams.get("ticket");
    if (!ticket) return err(401, "auth");
    let claims;
    try { claims = await verifyTicket(ticket); } catch { return err(503, "unavailable"); }
    if (!claims) return err(401, "auth");
    if (claims.board !== p.board) return err(403, "forbidden");
    if (url.searchParams.has("seq")) {
      const raw = url.searchParams.get("seq");
      if (!/^\d+$/.test(raw) || Number(raw) !== claims.seq) return err(400, "bad-request");
    }
    const snap = await snapshot.get(p.board, claims.seq);
    if (!snap) return err(404, "not-found");
    const etag = `"snap-${p.board}-${snap.seq}"`;
    const cacheControl = snap.seq > 0 ? "private, max-age=300, immutable" : "private, max-age=60";
    const baseHeaders = { etag, "cache-control": cacheControl, vary: "Accept-Encoding" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: baseHeaders });
    const wantsGzip = /\bgzip\b/i.test(req.headers.get("accept-encoding") ?? "");
    const gz = wantsGzip ? (typeof snap.gzip === "function" ? snap.gzip() : snap.gzip) : null;
    if (gz) {
      return new Response(req.method === "HEAD" ? null : gz, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", ...baseHeaders },
      });
    }
    return new Response(req.method === "HEAD" ? null : snap.data, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...baseHeaders },
    });
  }

  /** SHA-256 hex of the route, its path parameters and the body with sorted keys: what "the same request" means for a key. */
  async function fingerprint(route, params, b) {
    const text = JSON.stringify([route, Object.entries(params).sort(), Object.entries(b).sort(([x], [y]) => (x < y ? -1 : 1))]);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)))].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  /**
   * A create route's body of work, made exactly-once by the `Idempotency-Key` header (PROTOCOL.md "Idempotent creates"). `run(idem)` makes the
   * object and resolves its 201 body; `idem` (`{ user, key, fp }`, absent without a key) goes to the Registry create, which writes the key's row in
   * the SAME transaction as the object, so the two exist together or not at all. `rebuild(id)` answers a repeat: it authorizes the caller AGAIN, as
   * the create did, and reads the object fresh (throws `forbidden` for a caller who lost access since). Only the object's id is stored, never a body
   * (a link or an invite carries its secret). A repeat is answered from the row (`idemGet`) or, when it raced the first create, by the create's own
   * `idem-replay` rejection; a changed request is 422. `run` is NOT cancelled by the request deadline: it commits or rolls back whole.
   */
  async function keyed(req, who, route, params, b, run, rebuild, status = 201) {
    const k = req.headers.get("idempotency-key");
    if (k === null) return json(status, await run(undefined));
    if (!IDEM_KEY.test(k)) throw refuse(400, "bad-idempotency-key");
    const idem = { user: who.user, key: k, fp: await fingerprint(route, params, b) };
    const replayed = async id => json(status, await rebuild(id), { "idempotent-replayed": "true" });   // re-authorized for the caller as they are NOW; a refusal propagates as the route's own
    let g;
    try { g = await registry.idemGet(idem); } catch { throw refuse(503, "unavailable"); }
    if (g.state === "mismatch") return err(422, "idempotency-key-reused");
    if (g.state === "done") return replayed(g.ref);
    try { return json(status, await run(idem)); }
    catch (e) {
      if (e?.code === "idem-replay") return replayed(e.ref);
      if (e?.code === "idem-mismatch") return err(422, "idempotency-key-reused");
      throw e;
    }
  }

  // ---- routes ----
  const admin = { registry, tenancy, now, announce: spaces.announceChange };
  async function redeemLinkHttp(who, linkId, passcode) {
    const checked = await verifyLinkAccess({ link: linkId, passcode }, { registry, now, rateLimiter: linkRateLimiter });
    if ("code" in checked) {
      if (checked.code === "passcode-required") return err(401, "passcode-required");
      if (checked.code === "bad-passcode") return err(403, "bad-passcode");
      if (checked.code === "rate-limited") {
        const retryAfterMs = checked.retryAfterMs ?? 0;
        const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return err(429, "rate-limited", { retryAfterMs, retryAfter }, { "retry-after": String(retryAfter) });
      }
      return err(404, "not-found");
    }
    const r = await tenancy.redeemLink(who, linkId, { verified: true });
    if (!r) return err(404, "not-found");
    return json(200, { board: r.board, url: boardUrl(r.board), ...(checked.policy.noDownload ? { noDownload: true } : {}) });
  }
  const firstAdminTenant = async who => {
    const list = typeof tenancy.tenantsFor === "function" ? await tenancy.tenantsFor(who) : [];
    const adm = list.find(t => isTenantAdminRecord(t, who));
    if (adm) return adm;
    return tenancy.tenantOf(who);
  };
  function auditQuery(url) {
    let limit = 50;
    if (url.searchParams.has("limit") && url.searchParams.get("limit") !== "") {
      const raw = url.searchParams.get("limit");
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw refuse(400, "bad-request");
      limit = Math.min(200, Number(raw));
    }
    let before = null;
    if (url.searchParams.has("before") && url.searchParams.get("before") !== "") {
      const raw = url.searchParams.get("before");
      if (!/^\d+:\d+$/.test(raw)) throw refuse(400, "bad-request");
      before = raw;
    }
    const rawBoard = url.searchParams.get("board");
    const rawTenant = url.searchParams.get("tenant");
    return { limit, before, board: rawBoard ? rawBoard : null, tenant: rawTenant ? rawTenant : null };
  }
  // GET /auth/dev: the dev sign-in menu for the served page (web/adapters/auth/devconfig.js). Exists ONLY while the dev
  // verifier is on and main.js allowed the menu (a loopback bind, no Google, a gateway, an offerable user), and it leaves out any name that is a tenant admin in the Registry
  // right now; otherwise there
  // is no such route (404). It publishes those dev tokens, which main.js says loudly at start.
  const devMenu = dev && dev.enabled === true && config.devSignIn ? { board: config.devSignIn.board, users: config.devSignIn.users } : null;
  const menuWarned = new Set();
  let lastMenuWarn = -Infinity;
  const devHosts = new Set((config.devSignIn?.hosts ?? []).map(h => String(h).toLowerCase()));
  // The Host header's name, port cut off ("[::1]:8099" -> "[::1]"). Bun builds req.url from it, but read it directly.
  const hostName = req => (req.headers.get("host") ?? "").toLowerCase().replace(/:\d*$/, "");
  const routes = [
    ...(devMenu ? [["/auth/dev", { GET: async req => {
      if (!devHosts.has(hostName(req))) return err(404, "not-found");
      // Checked per request, through the Registry port: a dev name that is a tenant admin (an earlier run's admin token, or
      // scripts/admin-bootstrap.js --admin dev:<name>, even after this server started) is never offered. A Registry that
      // cannot answer fails closed: nothing is published.
      let admins;
      // Whole ms (the Registry ignores a fractional bound), at most 2^31-1 (a bigger delay overflows the timer and fires at once).
      const w = Number(config.devSignIn.waitMs ?? DEV_MENU_WAIT_MS), waitMs = Number.isFinite(w) && w > 0 ? Math.min(2 ** 31 - 1, Math.max(1, Math.round(w))) : DEV_MENU_WAIT_MS;
      try { admins = new Set(await bounded(registry.tenantAdminsAmong(devMenu.users.map(u => "dev:" + u.name), { timeoutMs: waitMs }), waitMs)); }
      catch (e) {
        // Fail closed with a hint, at most one short line per 10 s (no stack, no token).
        if (now() - lastMenuWarn >= 10_000) { lastMenuWarn = now(); log.warn(`dev sign-in menu: ${e?.message === "timeout" ? "the Registry did not answer in time" : "the Registry failed"}; answering 503`); }
        return err(503, "unavailable");
      }
      const users = devMenu.users.filter(u => !admins.has("dev:" + u.name));
      for (const u of devMenu.users) if (admins.has("dev:" + u.name) && !menuWarned.has(u.name)) {
        menuWarned.add(u.name);   // once per name, not per request
        log.warn(`dev sign-in menu: ${u.name} is a tenant admin in the registry, so it is not offered`);
      }
      return users.length ? json(200, { board: devMenu.board, users }) : err(404, "not-found");
    } }]] : []),
    ["/auth/providers", { GET: () => json(200, { providers: providerList.map(p => ({ id: p.id, label: p.label })) }) }],
    ["/auth/login", { GET: (_req, url) => beginLogin(null, url.searchParams.get("provider"), parseCliLoginParams(url)) }],
    ["/auth/callback", { GET: (req, url) => callback(req, url) }],
    ["/auth/exchange", { POST: req => exchange(req) }],
    ["/auth/cli-exchange", { POST: req => cliExchange(req) }],
    ["/auth/logout", { GET: () => redirect(postLogoutUrl, [clearLogin]) }],
    ["/tenants", {
      GET: async req => {
        const who = await caller(req);
        return json(200, await listTenants({ caller: who }, { tenancy }));
      },
      POST: async req => {
        const who = await caller(req);
        const b = await body(req, ["name"]);
        const tenant = await createPersonalTenant({ caller: who, name: b.name }, admin);
        return json(201, { tenant });
      },
    }],
    ["/tenants/:tenant/members", {
      GET: async (req, p, url) => {
        const who = await caller(req);
        return json(200, await listTenantMembers({
          caller: who,
          tenant: p.tenant,
          q: url.searchParams.get("q"),
          role: url.searchParams.get("role"),
          after: url.searchParams.get("after"),
          limit: url.searchParams.get("limit"),
        }, admin));
      },
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["email"]);
        return json(201, await addTenantMember({ caller: who, tenant: p.tenant, email: b.email }, admin));
      },
    }],
    ["/tenants/:tenant/members/:user/summary", {
      GET: async (req, p) => {
        const who = await caller(req);
        return json(200, await getTenantMemberSummary({ caller: who, tenant: p.tenant, user: p.user }, admin));
      },
    }],
    ["/tenants/:tenant/members/:email", {
      DELETE: async (req, p) => {
        const who = await caller(req);
        await removeTenantMember({ caller: who, tenant: p.tenant, email: p.email }, admin);
        return json(204);
      },
    }],
    ["/tenants/:tenant/admins", {
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["userId", "email"]);
        return json(201, await promoteTenantAdmin({ caller: who, tenant: p.tenant, userId: b.userId, email: b.email }, admin));
      },
    }],
    ["/tenants/:tenant/admins/:member", {
      DELETE: async (req, p) => {
        const who = await caller(req);
        await demoteTenantAdmin({ caller: who, tenant: p.tenant, member: p.member }, admin);
        return json(204);
      },
    }],
    ["/tenants/:tenant/spaces-overview", {
      GET: async (req, p) => {
        const who = await caller(req);
        return json(200, await listTenantSpacesOverview({ caller: who, tenant: p.tenant }, admin));
      },
    }],
    ["/admin/audit", { GET: async (req, url) => {
      const who = await caller(req);
      const { limit, before, board, tenant: askedTenant } = auditQuery(url);
      const tid = askedTenant ?? (await firstAdminTenant(who))?.id ?? null;
      if (!tid) throw new AdminError("forbidden", "not allowed");
      return json(200, await listTenantAudit({ caller: who, tenant: tid, board, limit, before }, admin));
    } }],
    ["/admin/export-data", { GET: async (req, url) => {
      const who = await caller(req);
      const askedTenant = url.searchParams.get("tenant") || null;
      const tid = askedTenant ?? (await firstAdminTenant(who))?.id ?? null;
      if (!tid) throw new ComplianceError("forbidden", "not allowed");
      return json(200, await exportTenantData({ registry, tenant: tid, actor: who, now }));
    } }],
    ["/admin/gdpr/erase", { POST: async (req, url) => {
      const who = await caller(req);
      const b = await body(req, ["userId", "tenant"]);
      const tid = (typeof b.tenant === "string" && b.tenant ? b.tenant : null)
        ?? (url.searchParams.get("tenant") || null)
        ?? (await firstAdminTenant(who))?.id
        ?? null;
      if (!tid) throw new ComplianceError("forbidden", "not allowed");
      return json(200, await eraseUserData({ registry, tenant: tid, targetUserId: b.userId, actor: who, now }));
    } }],
    ["/spaces", {
      GET: async (req, url) => {
        const who = await caller(req);
        if (url.searchParams.get("can") !== "board.create" || [...url.searchParams.keys()].length !== 1) throw refuse(400, "bad-request");
        return json(200, await spaces.boardPicker(who));
      },
      POST: async req => {
        const who = await caller(req);
        const b = defined(await body(req, ["name", "group", "general"]));
        return keyed(req, who, "POST /spaces", {}, b, async idem => ({ space: await spaces.createSpace(who, b, idem) }),
          async id => ({ space: await spaces.replaySpace(who, id) }));
      },
    }],
    ["/groups", {
      POST: async (req) => {
        const who = await caller(req);
        const b = defined(await body(req, ["name", "general"]));
        return keyed(req, who, "POST /groups", {}, b, async idem => ({ group: await spaces.createGroup(who, b, idem) }),
          async id => ({ group: await spaces.replayGroup(who, id) }));
      },
      GET: async (req, url) => {
      const who = await caller(req);
      if (url.searchParams.get("can") !== "space.create" || [...url.searchParams.keys()].length !== 1) throw refuse(400, "bad-request");
      return json(200, await spaces.spacePicker(who));
    } }],
    ["/spaces/:id", {
      GET: async (req, p) => json(200, await spaces.spacePage(await caller(req), p.id)),
      PATCH: async (req, p) => { const who = await caller(req); return json(200, { space: await spaces.update(who, "space", p.id, await body(req, ["name", "general"])) }); },
    }],
    ["/groups/:id", {
      GET: async (req, p, url) => json(200, await spaces.groupPage(await caller(req), p.id, url.searchParams.get("after"))),
      PATCH: async (req, p) => { const who = await caller(req); return json(200, { group: await spaces.update(who, "group", p.id, await body(req, ["name", "general"])) }); },
    }],
    ["/teams", {
      GET: async (req, url) => json(200, await access.listTeams(await caller(req), { after: url.searchParams.get("after"), q: url.searchParams.get("q") })),
      POST: async req => {
        const who = await caller(req);
        const b = await body(req, ["name"]);
        return keyed(req, who, "POST /teams", {}, b, async idem => ({ team: await access.createTeam(who, b, idem) }),
          async id => ({ team: await access.replayTeam(who, id) }));
      },
    }],
    ["/teams/:id", {
      GET: async (req, p, url) => json(200, await access.teamPage(await caller(req), p.id, url.searchParams.get("after"))),
      PATCH: async (req, p) => { const who = await caller(req); const b = await body(req, ["name"]); return json(200, { team: await access.renameTeam(who, p.id, b.name) }); },
      DELETE: async (req, p) => { await access.deleteTeam(await caller(req), p.id); return json(204); },
    }],
    ["/teams/:id/members/:user", {
      PUT: async (req, p) => { await access.setMember(await caller(req), p.id, p.user, true); return json(204); },
      DELETE: async (req, p) => { await access.setMember(await caller(req), p.id, p.user, false); return json(204); },
    }],
    ["/roles", {
      GET: async req => json(200, await roles.list(await caller(req))),
      POST: async req => {
        const who = await caller(req);
        const b = await body(req, ["name", "boardRole", "permissions", "base"]);
        return keyed(req, who, "POST /roles", {}, b, async idem => ({ role: await roles.create(who, b, idem) }),
          async id => ({ role: await roles.read(who, id) }));
      },
    }],
    ["/roles/:id", {
      PATCH: async (req, p) => { const who = await caller(req); return json(200, { role: await roles.update(who, p.id, await body(req, ["name", "boardRole", "permissions", "confirm"])) }); },
      DELETE: async (req, p) => { await roles.remove(await caller(req), p.id); return json(204); },
    }],
    ["/directory", { GET: async (req, url) => json(200, await access.directory(await caller(req), { q: url.searchParams.get("q") })) }],
    ["/access/:type/:id", { GET: async (req, p, url) => json(200, await access.accessPage(await caller(req), p.type, p.id, url.searchParams.get("after"))) }],
    ["/access/:type/:id/requests", {
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["role"]);
        return keyed(req, who, "POST /access/requests", { type: p.type, id: p.id }, b, async idem => ({ request: await access.requestAccess(who, p.type, p.id, b.role, idem) }),
          async id => ({ request: await access.replayRequest(who, p.type, p.id, id) }));
      },
    }],
    ["/access/:type/:id/requests/:user", { DELETE: async (req, p) => { await access.dismissRequest(await caller(req), p.type, p.id, p.user); return json(204); } }],
    ["/boards/:board/explain", { GET: async (req, p) => json(200, await access.boardExplain(await caller(req), p.board)) }],
    ["/access/:type/:id/grants/:subjectType/:subject", {
      PUT: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["role"]);
        if (typeof b.role !== "string") throw refuse(400, "bad-request");
        return json(200, { row: await access.setGrant(who, p.type, p.id, p.subjectType, p.subject, b.role) });
      },
      DELETE: async (req, p) => { await access.setGrant(await caller(req), p.type, p.id, p.subjectType, p.subject, null); return json(204); },
    }],
    ["/boards/:board/move", {
      GET: async (req, p) => json(200, await moves.options(await caller(req), p.board)),
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["from", "to"]);
        return keyed(req, who, "POST /boards/:board/move", p, b, async idem => moves.move(who, p.board, b, idem), async ref => moves.replay(who, p.board, b, ref), 200);
      },
    }],
    ["/boards/:board/move/preview", { GET: async (req, p, url) => {
      const who = await caller(req), to = url.searchParams.get("to");
      if (to === null || [...url.searchParams.keys()].length !== 1) throw refuse(400, "bad-request");
      return json(200, await moves.preview(who, p.board, to));
    } }],
    ["/boards/:board/trash", {
      GET: async (req, p) => json(200, await trash.notice(await caller(req), p.board)),
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["from"]);
        return keyed(req, who, "POST /boards/:board/trash", p, b, async idem => trash.trashBoard(who, p.board, b, idem), async ref => trash.replayTrash(who, p.board, b, ref), 200);
      },
    }],
    ["/boards/:board/restore", { POST: async (req, p) => {
      const who = await caller(req);
      const b = await body(req, []);
      return keyed(req, who, "POST /boards/:board/restore", p, b, async idem => trash.restoreBoard(who, p.board, idem), async ref => trash.replayRestore(who, p.board, ref), 200);
    } }],
    ["/spaces/:space/trash", { POST: async (req, p) => {
      const who = await caller(req);
      const b = await body(req, []);
      return keyed(req, who, "POST /spaces/:space/trash", p, b, async idem => trash.trashSpace(who, p.space, idem), async ref => trash.replayTrashSpace(who, p.space, ref), 200);
    } }],
    ["/spaces/:space/restore", { POST: async (req, p) => {
      const who = await caller(req);
      const b = await body(req, []);
      return keyed(req, who, "POST /spaces/:space/restore", p, b, async idem => trash.restoreSpace(who, p.space, idem), async ref => trash.replayRestoreSpace(who, p.space, ref), 200);
    } }],
    ["/members/:user/offboarding", { GET: async (req, p, url) => {
      const who = await caller(req), keys = [...url.searchParams.keys()];
      if (keys.some(k => k !== "after") || keys.length > 1) throw refuse(400, "bad-request");
      return json(200, await offboard.list(who, p.user, url.searchParams.get("after")));
    } }],
    ["/members/:user/offboarding/reassign", { POST: async (req, p) => {
      const who = await caller(req);
      const b = await body(req, ["type", "id", "to"]);
      return keyed(req, who, "POST /members/:user/offboarding/reassign", p, b, async idem => offboard.reassign(who, p.user, b, idem), async ref => offboard.replayReassign(who, p.user, b, ref), 200);
    } }],
    ["/members/:user/remove", { POST: async (req, p) => {
      const who = await caller(req);
      const b = await body(req, ["to"]);
      return keyed(req, who, "POST /members/:user/remove", p, b, async idem => offboard.remove(who, p.user, b, idem), async ref => offboard.replayRemove(who, p.user, ref), 200);
    } }],
    ["/trash", { GET: async req => json(200, await trash.list(await caller(req))) }],
    ["/boards/:board/share", { GET: async (req, p) => {
      const v = await shareView({ caller: await caller(req), board: p.board }, admin);
      return json(200, publicUrl ? { ...v, links: v.links.map(l => ({ ...l, url: `${publicUrl}/links/${encodeURIComponent(l.id)}` })) } : v);
    } }],
    ["/boards", {
      GET: async req => {
        const who = await caller(req);
        const tenantIds = new Set();
        if (typeof tenancy.tenantsFor === "function") {
          for (const t of await tenancy.tenantsFor(who)) tenantIds.add(t.id);
        } else {
          const t = await tenancy.tenantOf(who);
          if (t) tenantIds.add(t.id);
        }
        const byId = new Map();
        const merge = b => {
          const cur = byId.get(b.id);
          if (!cur) byId.set(b.id, b);
          else cur.role = higher(cur.role, b.role);
        };
        let isAdmin = false;
        for (const tid of tenantIds) {
          const res = await listBoards({ caller: who, tenant: tid }, admin);
          if (res.isAdmin) isAdmin = true;
          for (const b of res.boards) merge(b);
        }
        // Indexed lookup for any boards where the caller has a direct grant, live invite, or live link use
        // (e.g. invited personal-tenant guest), without scanning unrelated personal tenants.
        if (typeof registry.boardsForUser === "function") {
          const email = who.emailVerified === false ? null : (who.email ?? null);
          for (const b of await registry.boardsForUser(who.user, email, { at: now() })) merge(b);
        }
        const boards = [...byId.values()].sort((a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return json(200, { boards, isAdmin });
      },
      POST: async req => {
        const who = await caller(req);
        const b = defined(await body(req, ["title", "memberRole", "space", "tenant"]));
        if (b.tenant !== undefined && b.tenant !== null) {
          if (typeof b.tenant !== "string" || !b.tenant) throw refuse(400, "bad-request");
          const targetTenant = await registry.tenant(b.tenant);
          if (!targetTenant) throw new AdminError("forbidden", "not allowed");
          // Cross-domain tenant creation via explicit `tenant` field is refused.
          if (targetTenant.domain !== null && (!who.domain || !targetTenant.domains?.includes(who.domain))) {
            throw new AdminError("forbidden", "not allowed");
          }
          if (targetTenant.domain === null) {
            const board = await createBoard(/** @type {any} */ (defined({ caller: who, tenant: b.tenant, title: b.title, memberRole: b.memberRole, space: b.space })), admin);
            return json(201, { board });
          }
        } else {
          const unit = await tenancy.tenantOf(who);
          if (unit && unit.domain === null && isTenantAdminRecord(unit, who)) {
            const board = await createBoard(/** @type {any} */ (defined({ caller: who, tenant: unit.id, title: b.title, memberRole: b.memberRole, space: b.space })), admin);
            return json(201, { board });
          }
        }
        const spBody = defined({ title: b.title, memberRole: b.memberRole, space: b.space });
        return keyed(req, who, "POST /boards", {}, spBody, async idem => {
          const board = await spaces.createBoard(who, spBody, idem);
          if (typeof registry.appendAudit === "function") {
            await registry.appendAudit({ tenant: board.tenant, board: board.id, actor: who.user, action: "board.create", target: board.id, detail: { title: board.title, memberRole: board.memberRole }, at: now() });
          }
          return { board };
        }, async id => ({ board: await spaces.replayBoard(who, id) }));
      },
    }],
    ["/boards/:board", {
      PATCH: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["title", "memberRole"]);
        if (!("title" in b) && !("memberRole" in b)) throw refuse(400, "bad-request");
        if ("memberRole" in b) {
          const board = await updateBoard({ caller: who, board: p.board, title: b.title, memberRole: b.memberRole }, admin);
          return json(200, { board });
        }
        if (typeof b.title !== "string" || /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/u.test(b.title)) throw refuse(400, "bad-request");
        const board = await spaces.renameBoard(who, p.board, b.title);
        if (typeof registry.appendAudit === "function") {
          const br = /** @type {import("../../ports/registry.js").Board} */ (board);
          await registry.appendAudit({ tenant: br.tenant, board: br.id, actor: who.user, action: "board.update", target: br.id, detail: { title: br.title, memberRole: br.memberRole }, at: now() });
        }
        return json(200, { board });
      },
      DELETE: async (req, p) => {
        const who = await caller(req);
        await deleteBoard({ caller: who, board: p.board }, admin);
        return json(204);
      },
    }],
    ["/boards/:board/audit", { GET: async (req, p, url) => {
      const who = await caller(req);
      const { limit, before } = auditQuery(url);
      return json(200, await listBoardAudit({ caller: who, board: p.board, limit, before }, admin));
    } }],
    ["/boards/:board/export-data", { GET: async (req, p, url) => {
      const who = await caller(req);
      const askedTenant = url.searchParams.get("tenant") || null;
      return json(200, await exportBoardData({ registry, tenant: askedTenant, board: p.board, actor: who, now }));
    } }],
    ["/boards/:board/snapshot", { GET: serveSnapshot, HEAD: serveSnapshot }],
    ["/boards/:board/versions", {
      GET: async (req, p) => json(200, await versions.list(await caller(req), p.board)),
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["label", "snapshot"], versionMaxBody);
        return json(201, await versions.create(who, p.board, b));
      },
    }],
    ["/boards/:board/versions/:versionId", {
      GET: async (req, p) => json(200, await versions.get(await caller(req), p.board, p.versionId)),
      DELETE: async (req, p) => {
        await versions.remove(await caller(req), p.board, p.versionId);
        return json(204);
      },
    }],
    ["/boards/:board/invites", {
      GET: async (req, p) => json(200, { invites: await listInvites({ caller: await caller(req), board: p.board }, admin) }),
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["email", "role", "expiresAt"]);
        return keyed(req, who, "POST /boards/:board/invites", p, b,
          async idem => ({ invite: await createInvite({ caller: who, board: p.board, email: b.email, role: b.role, expiresAt: b.expiresAt, idem }, admin) }),
          async id => ({ invite: await readInvite({ caller: who, board: p.board, invite: id }, admin) }));
      },
    }],
    ["/boards/:board/invites/:id", { DELETE: async (req, p) => {
      await revokeInvite({ caller: await caller(req), board: p.board, invite: p.id }, admin);
      return json(204);
    } }],
    ["/boards/:board/links", {
      GET: async (req, p) => json(200, { links: await listLinks({ caller: await caller(req), board: p.board }, admin) }),
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["role", "expiresAt", "passcode", "noDownload"]);
        // Never feed plaintext passcode into the fast SHA-256 idempotency fingerprint (would create an offline guess oracle in reg_idempotency).
        const { passcode: _omitPasscode, ...fpRest } = b;
        const fpBody = b.passcode !== undefined ? { ...fpRest, hasPasscode: b.passcode != null } : fpRest;
        const linkBody = link => ({ link, ...(publicUrl ? { url: `${publicUrl}/links/${encodeURIComponent(link.id)}` } : {}) });
        return keyed(req, who, "POST /boards/:board/links", p, fpBody,
          async idem => linkBody(await createLink({
            caller: who,
            board: p.board,
            role: b.role,
            expiresAt: b.expiresAt ?? null,
            ...(b.passcode !== undefined ? { passcode: b.passcode } : {}),
            ...(b.noDownload !== undefined ? { noDownload: b.noDownload } : {}),
            idem,
          }, admin)),
          async id => linkBody(await readLink({ caller: who, board: p.board, link: id }, admin)));
      },
    }],
    ["/boards/:board/links/:id", { DELETE: async (req, p) => {
      await revokeLink({ caller: await caller(req), board: p.board, link: p.id }, admin);
      return json(204);
    } }],
    ["/boards/:board/grants/:user", { PUT: async (req, p) => {
      const who = await caller(req);
      const b = await body(req, ["role"]);
      if (!("role" in b)) throw refuse(400, "bad-request");
      await setGrant({ caller: who, board: p.board, user: p.user, role: b.role }, admin);
      return json(204);
    } }],
    ...(home ? [
      ["/home", { GET: async req => json(200, await home.home(await caller(req))) }],
      ["/home/search", { GET: async (req, url) => {
        const who = await caller(req);
        const space = url.searchParams.get("space");
        if (space !== null) {
          if (!/^[\w-]{1,64}$/.test(space) || url.searchParams.has("q")) throw refuse(400, "bad-request");
          return json(200, await home.spaceBoards(who, space));
        }
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q || q.length > 100 || q.includes("\0")) throw refuse(400, "bad-request");
        return json(200, await home.search(who, q));
      } }],
      ["/home/stars/:board", {
        PUT: async (req, p) => { if (!(await home.star(await caller(req), p.board, true))) throw new AdminError("forbidden", "not allowed"); return json(204); },
        DELETE: async (req, p) => { await home.star(await caller(req), p.board, false); return json(204); },
      }],
    ] : []),
    ["/links/:id", {
      GET: async (req, p, url) => {
        if (!req.headers.has("authorization")) return beginLogin(p.id.slice(0, 128), url.searchParams.get("provider"));
        const who = await caller(req);
        // Passcodes are never accepted in URL query strings (prevents browser history / access-log leakage).
        const passcode = req.headers.get("x-link-passcode") ?? undefined;
        return redeemLinkHttp(who, p.id, passcode);
      },
      POST: async (req, p) => {
        const who = await caller(req);
        const hasCt = Boolean(req.headers.get("content-type"));
        const b = hasCt ? await body(req, ["passcode"]) : {};
        const passcode = b.passcode ?? req.headers.get("x-link-passcode") ?? undefined;
        return redeemLinkHttp(who, p.id, passcode);
      },
    }],
  ].map(([pattern, methods]) => {
    const names = [];
    const pat = String(pattern);
    const re = new RegExp("^" + pat.replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
    return { re, names, methods, pattern: pat };
  });

  // One deadline for the whole route table (PROTOCOL.md "HTTP request deadline"). The work is not cancellable (the Registry port has no
  // cancel), so on expiry the 503 wins and the late settlement is dropped here: handled, never an unhandled rejection, never sent;
  // it is counted and logged (at most one line per 10 s) so an operator sees what finished after the client was told 503.
  const stat = { deadline: {}, late: { applied: 0, failed: 0 } };
  let lastWarn = -Infinity, lastLate = -Infinity;
  const withDeadline = (run, what) => new Promise((resolve, reject) => {
    let over = false;
    const late = (ok, why) => {
      stat.late[ok ? "applied" : "failed"]++;
      if (now() - lastLate >= 10_000) { lastLate = now(); log.warn(`${what} finished after its 503 (${ok ? "applied" : "failed"}${why ? ": " + why : ""})`); }
    };
    const t = timers.set(() => {
      over = true;
      stat.deadline[what] = (stat.deadline[what] ?? 0) + 1;
      if (now() - lastWarn >= 10_000) { lastWarn = now(); log.warn(`request deadline (${deadlineMs} ms) passed on ${what}; answering 503`); }
      resolve(err(503, "unavailable"));
    }, deadlineMs);
    (async () => run())().then(
      v => { if (over) late(!(v instanceof Response) || v.status < 400, v instanceof Response ? String(v.status) : ""); else { timers.clear(t); resolve(v); } },
      e => { if (over) late(false, String(e?.code ?? e?.message ?? e).slice(0, 80)); else { timers.clear(t); reject(e); } });
  });

  async function handle(req, url) {
    try {
      url = url ?? new URL(req.url);
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const fn = r.methods[req.method];
        if (!fn) return err(405, "method-not-allowed", {}, { allow: Object.keys(r.methods).join(", ") });
        const params = {};
        try { r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); }); }
        catch { return err(400, "bad-request"); }
        const what = `${req.method} ${r.pattern}`;
        return await withDeadline(() => r.names.length ? fn(req, params, url) : fn(req, url), what);
      }
      return null;
    } catch (e) {
      if (e instanceof Refusal) return e.res;
      if (e instanceof ComplianceError) {
        if (e.code === "forbidden") return err(403, "forbidden");
        if (e.code === "not-found") return err(404, "not-found");
        if (e.code === "bad-request") return err(400, "bad-request", { message: String(e.message).slice(0, 200) });
        if (e.code === "last-admin" || e.code === "is-admin" || e.code === "still-owns") return err(409, e.code);
      }
      if (e instanceof AdminError) {
        if (e.code === "forbidden") return err(403, "forbidden");
        if (e.code === "not-found") return err(404, "not-found");
        if (e.code === "bad-request") return err(400, "bad-request", { message: String(e.message).slice(0, 200) });
        if (e.code === "limit") return err(429, "limit", { message: String(e.message).slice(0, 200) });
        if (e.code === "last-owner") return err(409, "last-owner");
        if (e.code === "too-large") return err(e.data?.httpStatus === 413 ? 413 : 409, "too-large");
        if (e.code === "in-use" || e.code === "confirm-required") return err(409, e.code, e.data ?? {});
        if (e.code === "superseded") return err(409, "superseded");
        if (e.code === "moved") return err(409, "moved");
        if (e.code === "with-space" || e.code === "space-in-trash" || e.code === "purged" || e.code === "would-escalate") return err(409, e.code);
        if (e.code === "unknown-person" || e.code === "bad-role" || e.code === "bad-recipient") return err(400, e.code);
        if (/** @type {string} */ (e.code) === "bad-passcode" || /** @type {string} */ (e.code) === "invalid") return err(400, e.code, { message: String(e.message).slice(0, 200) });
        if (e.code === "still-owns" || e.code === "is-admin" || e.code === "last-admin" || e.code === "removed" || e.code === "personal") return err(409, e.code);
        if (e.code === "rate-limited") { const s = e.data?.retryAfter ?? null; return err(429, "rate-limited", { retryAfter: s }, s == null ? undefined : { "retry-after": String(s) }); }
      }
      if (e?.code === "removed") return err(403, "forbidden");   // a create racing a removal (the Registry refused in its own step)
      return err(503, "unavailable");
    }
  }
  /** Deadline hits per "METHOD /pattern" and the late settlements counted since start (for /health). */
  handle.stats = () => ({ deadlineMs, deadline: { ...stat.deadline }, late: { ...stat.late } });
  // The route table, for the guard test: every entry is dispatched through withDeadline.
  testHooks?.routes?.(routes.map(r => ({ pattern: r.pattern, methods: Object.keys(r.methods), names: r.names })));
  return handle;
}

/**
 * Causes this file adds to oidc.js's CAUSES for a failed callback. `idp_error:<name>` carries Google's `error`
 * parameter only when it is one of AUTHORIZE_ERRORS (RFC 6749 § 4.1.2.1, OIDC Core § 3.1.2.6); else plain idp_error.
 * `idp_refused`: the IdP refused without naming a cause (an adapter with no `why`). `mint_failed` (503): sign-in
 * succeeded but the exchange code couldn't be made (p5-google2v L4).
 */
export const SIGN_IN_CAUSES = Object.freeze(["no_login_cookie", "bad_login_cookie", "idp_error", "idp_error:<name>",
  "state_mismatch", "no_code", "state_used", "idp_threw", "idp_refused", "replay_guard_full", "mint_failed"]);
const AUTHORIZE_ERRORS = ["access_denied", "invalid_request", "unauthorized_client", "unsupported_response_type",
  "invalid_scope", "server_error", "temporarily_unavailable", "interaction_required", "login_required",
  "consent_required", "account_selection_required", "invalid_request_uri", "invalid_request_object"];

/** The default `log`: one JSON line on stdout, server/log.js's shape ({ ...fields, time, level, msg }). */
const stdoutLog = {
  warn(msg, fields) {
    try { process.stdout.write(JSON.stringify({ ...fields, time: new Date().toISOString(), level: "warn", msg }) + "\n"); }
    catch { /* a broken stdout must not take the server down */ }
  },
};

/** One cookie's value from the request, or null. */
function cookie(req, name) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Compare two strings without an early exit (lengths are public). */
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Escape HTML special characters for safe interpolation in static HTML templates. */
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
