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
//     config.maxBody        JSON body cap in bytes (default 16384)
//     config.maxLoginStates replay-guard size cap (default 100000); when full, callbacks get 503 (fails closed).
//                           The used-code set of /auth/exchange has the same cap and also fails closed.
//   `oidc` may be null (Google not configured): sign-in routes then answer 503 `sign-in-unavailable`.
//
// Routes (anything else, including /health, /ws, /blobs/*, /metrics, gives null):
//   GET    /auth/login                         302 to Google; login state in a signed short-lived cookie
//   GET    /auth/callback                      302 to postLoginUrl (or the board of a pending share link) #code=…,
//                                              sets the exchange cookie (docs/m2/contracts/auth-exchange.md)
//   POST   /auth/exchange                      { code } + exchange cookie + Origin → 200 { token, user, name, email,
//                                              domain, exp }; 400 invalid-code; 403 bad-origin; 503 unavailable
//   GET    /auth/logout                        clears the login cookie, 302 to postLogoutUrl
//   POST   /boards                             { title?, memberRole? } → 201 { board }; tenant = the caller's
//   GET    /boards/:board/invites              → { invites }
//   POST   /boards/:board/invites              { email, role, expiresAt? } → 201 { invite }
//   DELETE /boards/:board/invites/:invite      → 204
//   GET    /boards/:board/links                → { links }
//   POST   /boards/:board/links                { role, expiresAt? } → 201 { link, url? }
//   DELETE /boards/:board/links/:link          → 204
//   PUT    /boards/:board/grants/:user         { role | null } → 204   (user ids are URL-encoded, e.g. google%3A123)
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

import { b64url, unb64url, utf8, fromUtf8 } from "./util.js";
import { AdminError, createBoard, createInvite, listInvites, revokeInvite, createLink, listLinks, revokeLink, setGrant } from "../admin/boards.js";

export const LOGIN_COOKIE = "__Host-plen_login";
export const EXCHANGE_COOKIE = "__Host-plen_xchg";
const LOGIN_TTL_SEC = 600;
const CODE_TTL_SEC = 60;
const COOKIE_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax";
const XCHG_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Strict";

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
 * @param {{ registry: object, sessions: { issue(id: object): Promise<string>, verify(t: string): Promise<{ exp?: number }|null> },
 *   oidc?: import("./idp-port.js").IdP | null,
 *   tenancy: { redeemLink(id: object, link: string): Promise<{board: string}|null>, tenantOf(id: object): Promise<{id: string}|null> },
 *   now?: () => number, config: object, dev?: { enabled?: boolean, verify(t: string): Promise<object|null> } | null,
 *   testHooks?: { pruned?(p: { visited: number, expired: number, live: number }): void } | null }} deps   (tests only, not an API)
 */
export function httpRoutes({ registry, sessions, oidc = null, tenancy, now = Date.now, config = {}, dev = null, log = stdoutLog, testHooks = null }) {
  if (!registry || !sessions || !tenancy) throw new Error("http: registry, sessions and tenancy are required");
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

  // ---- login cookie ----
  let macKey = null;
  if (oidc) {
    const raw = typeof config.cookieKey === "string" ? utf8(config.cookieKey) : config.cookieKey;
    if (!(raw instanceof Uint8Array) || raw.length < 32) throw new Error("http: config.cookieKey must be at least 32 bytes");
    macKey = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  const clearLogin = `${LOGIN_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
  const clearXchg = `${EXCHANGE_COOKIE}=; ${XCHG_ATTRS}; Max-Age=0`;
  const appOrigin = new URL(postLoginUrl).origin;

  async function sealLogin({ state, nonce, verifier, link }) {
    const exp = Math.floor(now() / 1000) + LOGIN_TTL_SEC;
    const payload = b64url(utf8(JSON.stringify({ s: state, n: nonce, v: verifier, ...(link ? { l: link } : {}), exp })));
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
      return { state: c.s, nonce: c.n, verifier: c.v, link: typeof c.l === "string" ? c.l : null };
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

  // ---- exchange code + cookie ----
  async function mintCode(identity) {
    const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const h = b64url(await crypto.subtle.digest("SHA-256", utf8(code)));
    const exp = Math.floor(now() / 1000) + CODE_TTL_SEC;
    // Field types per docs/m2/contracts/auth-exchange.md: name/email/domain string or null (empty name → null).
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

  async function exchange(req) {
    if (!oidc) return err(503, "sign-in-unavailable");
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
    return withCookie(json(200, { token, ...x.identity, exp }), clearXchg);
  }

  async function beginLogin(link) {
    if (!oidc) return err(503, "sign-in-unavailable");
    let b;
    try { b = await oidc.begin(); } catch { return err(503, "unavailable"); }
    return redirect(b.url, [await sealLogin({ ...b, link })]);
  }

  /** One "sign-in failed" line; a broken logger never changes the answer. */
  const failed = cause => { try { log?.warn?.("sign-in failed", { cause }); } catch { /* logging is best effort */ } };

  async function callback(req, url) {
    if (!oidc) return err(503, "sign-in-unavailable");
    const fail = cause => { failed(cause); return withCookie(err(400, "login-failed"), clearLogin); };
    const expected = await openLogin(req);
    if (!expected) return fail(cookie(req, LOGIN_COOKIE) === null ? "no_login_cookie" : "bad_login_cookie");
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
    try { identity = await oidc.finish({ code, state, expected, why }); } catch { identity = null; cause ??= "idp_threw"; }
    if (!identity) return fail(cause ?? "idp_refused");
    const used = usedStates.use(expected.state);
    if (used === "replay") return fail("state_used");
    if (used === "full") { failed("replay_guard_full"); return withCookie(err(503, "unavailable"), clearLogin); }
    let x;
    try { x = await mintCode(identity); } catch { return withCookie(err(503, "unavailable"), clearLogin); }
    const frag = "#code=" + x.code;   // base64url: URL-safe as is
    if (expected.link) {
      let r = null, outage = false;
      try { r = await tenancy.redeemLink(identity, expected.link); } catch { outage = true; }
      if (r) return redirect(boardUrl(r.board) + frag, [clearLogin, x.cookie]);
      return redirect(postLoginUrl + frag + (outage ? "&link=unavailable" : "&link=invalid"), [clearLogin, x.cookie]);
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

  /** Read a JSON object body: JSON content type, ≤ maxBody bytes (counted as read), only `allowed` fields. */
  async function body(req, allowed) {
    const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") throw refuse(415, "unsupported-media-type");
    const len = Number(req.headers.get("content-length"));
    if (Number.isFinite(len) && len > maxBody) throw refuse(413, "too-large");
    const chunks = [];
    let n = 0;
    try {
      if (req.body) {
        const reader = req.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.byteLength;
          if (n > maxBody) { try { await reader.cancel(); } catch {} throw refuse(413, "too-large"); }
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

  // ---- routes ----
  const admin = { registry, now };
  const routes = [
    ["/auth/login", { GET: () => beginLogin(null) }],
    ["/auth/callback", { GET: (req, url) => callback(req, url) }],
    ["/auth/exchange", { POST: req => exchange(req) }],
    ["/auth/logout", { GET: () => redirect(postLogoutUrl, [clearLogin]) }],
    ["/boards", { POST: async req => {
      const who = await caller(req);
      const b = await body(req, ["title", "memberRole"]);
      const t = await tenancy.tenantOf(who);
      if (!t) throw new AdminError("forbidden", "not allowed");
      const board = await createBoard(defined({ caller: who, tenant: t.id, title: b.title, memberRole: b.memberRole }), admin);
      return json(201, { board });
    } }],
    ["/boards/:board/invites", {
      GET: async (req, p) => json(200, { invites: await listInvites({ caller: await caller(req), board: p.board }, admin) }),
      POST: async (req, p) => {
        const who = await caller(req);
        const b = await body(req, ["email", "role", "expiresAt"]);
        return json(201, { invite: await createInvite({ caller: who, board: p.board, email: b.email, role: b.role, expiresAt: b.expiresAt ?? null }, admin) });
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
        const b = await body(req, ["role", "expiresAt"]);
        const link = await createLink({ caller: who, board: p.board, role: b.role, expiresAt: b.expiresAt ?? null }, admin);
        return json(201, { link, ...(publicUrl ? { url: `${publicUrl}/links/${encodeURIComponent(link.id)}` } : {}) });
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
    ["/links/:id", { GET: async (req, p) => {
      if (!req.headers.has("authorization")) return beginLogin(p.id.slice(0, 128));
      const who = await caller(req);
      const r = await tenancy.redeemLink(who, p.id);
      if (!r) return err(404, "not-found");
      return json(200, { board: r.board, url: boardUrl(r.board) });
    } }],
  ].map(([pattern, methods]) => {
    const names = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; }) + "$");
    return { re, names, methods };
  });

  return async function handle(req, url) {
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
        if (r.names.length) return await fn(req, params);
        return await fn(req, url);
      }
      return null;
    } catch (e) {
      if (e instanceof Refusal) return e.res;
      if (e instanceof AdminError) {
        if (e.code === "forbidden") return err(403, "forbidden");
        if (e.code === "bad-request") return err(400, "bad-request", { message: String(e.message).slice(0, 200) });
        if (e.code === "last-owner") return err(409, "last-owner");
        if (e.code === "owner-grant-failed") return err(503, "owner-grant-failed", { board: e.board });
      }
      return err(503, "unavailable");
    }
  };
}

/**
 * Causes this file adds to oidc.js's CAUSES for a failed callback. `idp_error:<name>` carries Google's `error`
 * parameter only when it is one of AUTHORIZE_ERRORS (RFC 6749 § 4.1.2.1, OIDC Core § 3.1.2.6); else plain idp_error.
 * `idp_refused`: the IdP refused without naming a cause (an adapter with no `why`).
 */
export const SIGN_IN_CAUSES = Object.freeze(["no_login_cookie", "bad_login_cookie", "idp_error", "idp_error:<name>",
  "state_mismatch", "no_code", "state_used", "idp_threw", "idp_refused", "replay_guard_full"]);
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
