// @ts-check
// OpenID Connect sign-in: Google OIDC (`googleOidc`) and general OIDC with discovery (`genericOidc`).
// Authorization code + PKCE (S256), and ID-token verification against the IdP's JWKS.
// Everything that touches the network goes through an injected `fetch`, so tests run against a fake IdP.
// Client id/secret come from config (the caller reads env); nothing here holds a credential.
//
// The ID token is used once, at the end of sign-in, to make an Identity; the server then issues its own session
// token (session.js). The Auth port never accepts an external ID token.

import { b64url, unb64url, utf8, fromUtf8, randomId } from "../../../core/auth/util.js";
import { oidcTenantBinding } from "../../../ports/idp.js";

export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

/** @typedef {import("../../../ports/idp.js").Identity} Identity */

// ---- PKCE (RFC 7636) ----

/** A code verifier: 43 chars of base64url (32 random bytes), per RFC 7636 § 4.1. */
export const newVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** S256 code challenge = BASE64URL(SHA256(ASCII(verifier))). */
export async function challengeS256(verifier) {
  if (typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("bad verifier");
  return b64url(await crypto.subtle.digest("SHA-256", utf8(verifier)));
}

// ---- JWT parsing ----

/** Split and decode a compact JWS. Returns null on any malformation. */
export function parseJwt(token) {
  if (typeof token !== "string" || token.length > 16384) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(fromUtf8(unb64url(parts[0])));
    const payload = JSON.parse(fromUtf8(unb64url(parts[1])));
    const sig = unb64url(parts[2]);
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return { header, payload, sig, signed: utf8(parts[0] + "." + parts[1]) };
  } catch { return null; }
}

// ---- SSRF & OIDC URL validation ----

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "metadata.aws.internal", "instance-data"]);

/** @param {number} a @param {number} b @param {boolean} allowLoopback */
function isBlockedIpv4(a, b, allowLoopback) {
  if (a === 0) return true;                             // 0.0.0.0/8
  if (a === 127) return !allowLoopback;                 // 127.0.0.0/8 loopback
  if (a === 10) return true;                            // 10.0.0.0/8 RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12 RFC 1918
  if (a === 192 && b === 168) return true;              // 192.168.0.0/16 RFC 1918
  if (a === 169 && b === 254) return true;              // 169.254.0.0/16 link-local / cloud IMDS
  if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                            // multicast / reserved
  return false;
}

/** Parse a canonical or compressed IPv6 literal into 8 16-bit groups, or null. @param {string} raw */
function parseIpv6(raw) {
  const s = raw.split("%")[0].toLowerCase();
  if (!s.includes(":")) return null;
  let head = s, v4 = null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
    if (!m) return null;
    const oct = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (oct.some(x => x > 255)) return null;
    v4 = [(oct[0] << 8) | oct[1], (oct[2] << 8) | oct[3]];
    head = s.slice(0, lastColon);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const target = v4 ? 6 : 8;
  const missing = halves.length === 2 ? target - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== target)) return null;
  const groups = [];
  for (const part of left) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const part of right) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  if (v4) groups.push(v4[0], v4[1]);
  return groups.length === 8 ? groups : null;
}

/** Whether `hostname` is a loopback address (`localhost`, `*.localhost`, `127.0.0.1`, `::1`). */
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(h) || h.endsWith(".localhost")) return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) return true;
  const g = parseIpv6(h);
  if (g && g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;
  return false;
}

/**
 * Check whether an OIDC endpoint host must be blocked for SSRF protection (cloud metadata, RFC 1918,
 * link-local, ULA, IPv4-mapped IPv6, and loopback when `allowLoopback` is false).
 * @param {string} hostname
 * @param {{ allowLoopback?: boolean }} [o]
 */
export function isBlockedOidcHost(hostname, { allowLoopback = false } = {}) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!h) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return !allowLoopback;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const oct = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (oct.some(x => x > 255)) return true;
    return isBlockedIpv4(oct[0], oct[1], allowLoopback);
  }
  if (h.includes(":")) {
    const g = parseIpv6(h);
    if (!g) return true;
    if (g.every(x => x === 0)) return true;                                     // ::
    if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return !allowLoopback; // ::1
    // IPv4-mapped IPv6 (::ffff:0:0/96) and NAT64 well-known prefix (64:ff9b::/96)
    const isV4Mapped = g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff;
    const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0);
    if (isV4Mapped || isNat64) return isBlockedIpv4(g[6] >> 8, g[6] & 0xff, allowLoopback);
    if ((g[0] & 0xffc0) === 0xfe80) return true;                                // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                // fc00::/7 ULA (incl. fd00:ec2::254)
    if ((g[0] & 0xff00) === 0xff00) return true;                                // ff00::/8 multicast
  }
  return false;
}

/**
 * Validate an OIDC issuer or discovered endpoint URL.
 * - Requires `https:` unless `allowHttpLocalhost` is true AND the host is loopback.
 * - Rejects userinfo (`user:pass@`), fragments, and SSRF-blocked IP literals / metadata hosts.
 * - When `requireQueryFree` is true (issuer URL), rejects query strings as well.
 * @param {string} raw
 * @param {{ allowHttpLocalhost?: boolean, requireQueryFree?: boolean, label?: string }} [o]
 * @returns {URL}
 */
export function validateOidcUrl(raw, { allowHttpLocalhost = false, requireQueryFree = false, label = "url" } = {}) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) throw new Error(`oidc: invalid ${label}`);
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error(`oidc: invalid ${label}`); }
  if (u.username || u.password) throw new Error(`oidc: ${label} must not contain credentials`);
  if (u.hash) throw new Error(`oidc: ${label} must not contain a fragment`);
  if (requireQueryFree && u.search) throw new Error(`oidc: ${label} must not contain a query string`);
  const loopback = isLoopbackHost(u.hostname);
  const allowLoopback = Boolean(allowHttpLocalhost && loopback);
  if (u.protocol === "https:") {
    if (isBlockedOidcHost(u.hostname, { allowLoopback })) throw new Error(`oidc: ${label} host is blocked`);
    return u;
  }
  if (u.protocol === "http:" && allowLoopback) {
    if (isBlockedOidcHost(u.hostname, { allowLoopback: true })) throw new Error(`oidc: ${label} host is blocked`);
    return u;
  }
  throw new Error(`oidc: ${label} must use https`);
}

// ---- JWKS cache ----

/**
 * Keys by `kid`, fetched lazily.
 * - **Max age:** keys are trusted for the response's `Cache-Control: max-age`, capped at `maxAgeCapMs` (1 h) and
 *   floored at `cooldownMs`; with no max-age, the cap. After that the next lookup refetches, so a key the IdP
 *   withdrew stops verifying within the cap.
 * - **Unknown kid:** one refetch, and refetches are spaced at least `cooldownMs` apart (`retryMs` after a failed
 *   one), so a flood of tokens with made-up kids can't hammer the endpoint.
 * - **Failure keeps what we had:** a non-200, a timeout (`timeoutMs`, AbortSignal) or a body with no usable key
 *   is a failed fetch; the old keys stay. Callers that arrive during a fetch share it (refresh dedupes).
 */
export function jwksCache({ url = GOOGLE.jwks, fetch, now = Date.now, cooldownMs = 30_000, retryMs = 5_000,
  maxAgeCapMs = 3_600_000, timeoutMs = 10_000, algorithms = ["RS256"], noRedirect = false }) {
  const allowRS256 = algorithms.includes("RS256");
  const allowES256 = algorithms.includes("ES256");
  /** @type {Map<string, { key: CryptoKey, alg: "RS256"|"ES256" }>} */
  let keys = new Map();
  /** @type {{ key: CryptoKey, alg: "RS256"|"ES256" }[]} */
  let allKeys = [];
  let expiresAt = -Infinity;        // keys are fresh until then
  let nextFetchAt = -Infinity;      // no fetch before then (cooldown / retry)
  let inflight = null;

  const maxAge = res => {
    const m = /(?:^|[,\s])max-age=(\d+)/i.exec(res.headers?.get?.("cache-control") ?? "");
    const ms = m ? Number(m[1]) * 1000 : maxAgeCapMs;
    return Math.max(cooldownMs, Math.min(maxAgeCapMs, ms));
  };

  async function load() {
    const init = /** @type {RequestInit} */ ({ signal: AbortSignal.timeout(timeoutMs), ...(noRedirect ? { redirect: "error" } : {}) });
    const res = await fetch(url, init);
    if (!res.ok) throw new Error("jwks fetch failed");
    const body = await res.json();
    /** @type {Map<string, { key: CryptoKey, alg: "RS256"|"ES256" }>} */
    const next = new Map();
    /** @type {{ key: CryptoKey, alg: "RS256"|"ES256" }[]} */
    const nextAll = [];
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (!jwk || typeof jwk !== "object") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (allowRS256 && jwk.kty === "RSA" && (jwk.alg === undefined || jwk.alg === "RS256")) {
        try {
          // The algorithm is fixed here, never taken from the token or the JWK.
          const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
          const entry = /** @type {{ key: CryptoKey, alg: "RS256" }} */ ({ key, alg: "RS256" });
          nextAll.push(entry);
          if (typeof jwk.kid === "string" && jwk.kid) next.set(jwk.kid, entry);
        } catch { /* skip an unusable key */ }
      } else if (allowES256 && jwk.kty === "EC" && jwk.crv === "P-256" && (jwk.alg === undefined || jwk.alg === "ES256")) {
        try {
          const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
            { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
          const entry = /** @type {{ key: CryptoKey, alg: "ES256" }} */ ({ key, alg: "ES256" });
          nextAll.push(entry);
          if (typeof jwk.kid === "string" && jwk.kid) next.set(jwk.kid, entry);
        } catch { /* skip an unusable key */ }
      }
    }
    if (nextAll.length === 0) throw new Error("jwks: no usable key"); // keep the old keys
    keys = next;
    allKeys = nextAll;
    expiresAt = now() + maxAge(res);
  }

  async function refresh() {
    if (!inflight) {
      inflight = load().then(
        () => { nextFetchAt = now() + cooldownMs; },
        e => { nextFetchAt = now() + retryMs; throw e; },
      ).finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function ensureFresh(kid) {
    if (typeof kid === "string" && kid && keys.has(kid) && now() < expiresAt) return;
    if ((kid == null || kid === "") && allKeys.length > 0 && now() < expiresAt) return;
    if (now() >= nextFetchAt) { try { await refresh(); } catch { /* keep the old keys */ } }
  }

  return {
    /** @returns {Promise<CryptoKey|null>} */
    async key(kid) {
      await ensureFresh(kid);
      return keys.get(kid)?.key ?? null;
    },
    /** @returns {Promise<{ key: CryptoKey, alg: "RS256"|"ES256" }|null>} */
    async entry(kid, alg) {
      await ensureFresh(kid);
      if (typeof kid === "string" && kid) return keys.get(kid) ?? null;
      // Single-key JWKS without `kid` (some minimal OIDC providers omit kid when only 1 key exists).
      const matching = allKeys.filter(e => !alg || e.alg === alg);
      return matching.length === 1 ? matching[0] : null;
    },
  };
}

// ---- OIDC Discovery cache ----

/**
 * Fetch and cache `${issuer}/.well-known/openid-configuration`, enforcing:
 * - HTTPS (or loopback HTTP only when `allowHttpLocalhost` is true) and SSRF host checks on issuer + all endpoints
 * - Exact `issuer` match per OIDC Discovery § 4.3 / OIDC Core § 3.1.3.7 (allowing at most a trailing-slash difference)
 * - No redirects (`redirect: "error"`) so discovery cannot be bounced to internal/metadata endpoints
 * - `response_types_supported` includes `"code"` (if declared) and `code_challenge_methods_supported` includes `"S256"` (if declared)
 * @param {{ issuerUrl: string, fetch: typeof globalThis.fetch, now?: () => number, allowHttpLocalhost?: boolean,
 *   cooldownMs?: number, retryMs?: number, maxAgeCapMs?: number, timeoutMs?: number }} o
 */
export function oidcDiscovery({ issuerUrl, fetch, now = Date.now, allowHttpLocalhost = false,
  cooldownMs = 30_000, retryMs = 5_000, maxAgeCapMs = 3_600_000, timeoutMs = 10_000 }) {
  const issuerParsed = validateOidcUrl(issuerUrl, { allowHttpLocalhost, requireQueryFree: true, label: "issuerUrl" });
  const issuerLoopback = isLoopbackHost(issuerParsed.hostname);
  const endpointAllowHttp = Boolean(allowHttpLocalhost && issuerLoopback && issuerParsed.protocol === "http:");
  const issuerBase = issuerParsed.href.replace(/\/+$/, "");
  const discoveryUrl = `${issuerBase}/.well-known/openid-configuration`;

  /** @type {{ issuer: string, authorizationEndpoint: string, tokenEndpoint: string, jwksUri: string }|null} */
  let doc = null;
  let expiresAt = -Infinity;
  let nextFetchAt = -Infinity;
  let inflight = null;

  const maxAge = res => {
    const m = /(?:^|[,\s])max-age=(\d+)/i.exec(res.headers?.get?.("cache-control") ?? "");
    const ms = m ? Number(m[1]) * 1000 : maxAgeCapMs;
    return Math.max(cooldownMs, Math.min(maxAgeCapMs, ms));
  };

  async function load() {
    let res, body;
    try {
      res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch (e) {
      throw Object.assign(new Error("oidc discovery fetch failed"), { causeCode: e?.name === "TimeoutError" ? "idp_timeout" : "idp_unreachable" });
    }
    if (!res.ok) throw Object.assign(new Error(`oidc discovery HTTP ${res.status}`), { causeCode: "bad_discovery" });
    try { body = await res.json(); } catch {
      throw Object.assign(new Error("oidc discovery invalid json"), { causeCode: "bad_discovery" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw Object.assign(new Error("oidc discovery not an object"), { causeCode: "bad_discovery" });
    }
    // OIDC Discovery § 4.3: returned `issuer` must match the configured issuer URL (allowing trailing slash difference, e.g. Auth0).
    if (typeof body.issuer !== "string" || body.issuer.replace(/\/+$/, "") !== issuerBase) {
      throw Object.assign(new Error("oidc discovery issuer mismatch"), { causeCode: "bad_issuer" });
    }
    if (Array.isArray(body.response_types_supported) && !body.response_types_supported.includes("code")) {
      throw Object.assign(new Error("oidc discovery missing code response type"), { causeCode: "bad_discovery" });
    }
    if (Array.isArray(body.code_challenge_methods_supported) && !body.code_challenge_methods_supported.includes("S256")) {
      throw Object.assign(new Error("oidc discovery missing S256 PKCE support"), { causeCode: "bad_discovery" });
    }
    let authorizationEndpoint, tokenEndpoint, jwksUri;
    try {
      authorizationEndpoint = validateOidcUrl(body.authorization_endpoint, { allowHttpLocalhost: endpointAllowHttp, label: "authorization_endpoint" }).href;
      tokenEndpoint = validateOidcUrl(body.token_endpoint, { allowHttpLocalhost: endpointAllowHttp, label: "token_endpoint" }).href;
      jwksUri = validateOidcUrl(body.jwks_uri, { allowHttpLocalhost: endpointAllowHttp, label: "jwks_uri" }).href;
    } catch {
      throw Object.assign(new Error("oidc discovery invalid endpoint"), { causeCode: "bad_discovery" });
    }
    doc = { issuer: body.issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
    expiresAt = now() + maxAge(res);
  }

  async function refresh() {
    if (!inflight) {
      inflight = load().then(
        () => { nextFetchAt = now() + cooldownMs; },
        e => { nextFetchAt = now() + retryMs; throw e; },
      ).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    discoveryUrl,
    async get() {
      if (doc && now() < expiresAt) return doc;
      if (now() >= nextFetchAt) {
        try { await refresh(); } catch (e) { if (!doc) throw e; }
      }
      if (!doc) throw Object.assign(new Error("oidc discovery unavailable"), { causeCode: "idp_unreachable" });
      return doc;
    },
  };
}

// ---- ID-token verification ----

const MAX_NAME = 200;
const MAX_TOKEN_AGE_SEC = 86_400;

/**
 * The email, only when Google is authoritative for it (Google's "Verify the Google ID token" guide): it ends in
 * `@gmail.com`, or `email_verified` is true AND `hd` equals the email's domain (`hd` arrives trimmed and
 * lower-cased). A consumer account's third-party email may have changed hands since Google verified it, and an
 * `hd` account's email on another domain isn't vouched for by that Workspace, so neither may claim an invite.
 * (A Workspace user on a secondary domain therefore gets no email: still a member via `hd`, and links work.)
 * `email_verified` is required in every case. Otherwise null.
 */
function authoritativeEmail(c, hd) {
  if (c.email_verified !== true || typeof c.email !== "string") return null;
  const e = c.email.trim().toLowerCase();
  if (!e || e.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(e)) return null;
  if (e.endsWith("@gmail.com")) return e;
  return hd && e.slice(e.lastIndexOf("@") + 1) === hd ? e : null;
}

/** Normalize an email claim if syntactically valid; otherwise null. */
function normalizeEmailClaim(raw) {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 320 || !/^[^@\s]+@[^@\s]+$/.test(e)) return null;
  return e;
}

/** Verify JWS signature for RS256 or ES256 against an already-imported CryptoKey + fixed alg. */
async function verifyJwsSignature(alg, key, sig, signed) {
  try {
    if (alg === "RS256") return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, signed);
    if (alg === "ES256") {
      if (sig.byteLength !== 64) return false;
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signed);
    }
    return false;
  } catch { return false; }
}

/**
 * Verify a Google ID token and turn it into an Identity. Returns null on any failure (never throws).
 * Checks: RS256 only; signature against the JWKS key named by `kid`; `iss`; `aud` = clientId (an array `aud`
 * must contain it and, if it has several, `azp` must be clientId); `exp` and `iat` within `skewSec`; `nonce`
 * equals the expected one (required, non-empty). The Workspace domain is the `hd` claim, never the email.
 * @param {string} token
 * `why(cause)`, if given, hears one fixed label when the token is refused (CAUSES below); never the token or a claim.
 * @param {{ clientId: string, nonce: string, keys: ReturnType<typeof jwksCache>, now?: () => number, skewSec?: number,
 *   why?: (cause: string) => void }} o
 * @returns {Promise<Identity|null>}
 */
export async function verifyIdToken(token, { clientId, nonce, keys, now = Date.now, skewSec = 60, why }) {
  const no = cause => { try { why?.(cause); } catch { /* a reporter never changes the verdict */ } return null; };
  if (typeof clientId !== "string" || !clientId) return no("bad_config");
  if (typeof nonce !== "string" || !nonce) return no("bad_nonce");
  const jwt = parseJwt(token);
  if (!jwt) return no("bad_token");
  const { header, payload: c } = jwt;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return no("bad_alg");
  if (header.crit !== undefined) return no("bad_alg");

  const key = await keys.key(header.kid);
  if (!key) return no("unknown_kid");
  const ok = await verifyJwsSignature("RS256", key, jwt.sig, jwt.signed);
  if (!ok) return no("bad_sig");

  if (!GOOGLE.issuers.includes(c.iss)) return no("bad_iss");
  if (typeof c.aud === "string") { if (c.aud !== clientId) return no("bad_aud"); }
  else if (Array.isArray(c.aud)) {
    if (!c.aud.includes(clientId)) return no("bad_aud");
    if (c.aud.length > 1 && c.azp !== clientId) return no("bad_aud");
  } else return no("bad_aud");
  const t = Math.floor(now() / 1000);
  if (!Number.isFinite(c.exp) || !Number.isFinite(c.iat)) return no("bad_time");
  if (t > c.exp + skewSec) return no("expired");
  if (c.iat > t + skewSec) return no("bad_time");
  if (c.exp <= c.iat) return no("bad_time");
  if (c.iat < t - MAX_TOKEN_AGE_SEC) return no("stale");       // Google ID tokens live 1 h; older than a day is stale
  if (c.nonce !== nonce) return no("bad_nonce");
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255) return no("bad_sub");

  const hd = typeof c.hd === "string" ? c.hd.trim().toLowerCase() : "";
  return {
    user: "google:" + c.sub,
    name: typeof c.name === "string" ? c.name.slice(0, MAX_NAME) : null,
    email: authoritativeEmail(c, hd),
    domain: hd || null,
  };
}

/**
 * Verify a generic OIDC ID token and turn it into an issuer-bound Identity. Returns null on any failure.
 * Security invariants:
 * - Signature checked with RS256 or ES256 against the IdP's JWKS; algorithm matched against the imported key.
 * - Strict `iss === expectedIssuer`, `aud` / `azp`, `exp`, `iat`, optional `nbf`, `nonce`, and `sub`.
 * - Requires `email_verified === true` unless `allowUnverifiedEmail` is explicitly true; when `email_verified !== true`,
 *   `Identity.email` is ALWAYS `null` so unverified emails can never claim invites.
 * - Authoritative email domain allowlist (`emailDomains`): only verified emails whose domain is in `emailDomains`
 *   (or matches a non-`oidc:` `tenantDomain`) are carried on `Identity.email`; all others are stripped to `null` so
 *   an IdP user cannot hijack board invites addressed to external domains.
 * - Optional group/claim gate (`allowedGroups` + `groupsClaim`): when set, the token must carry at least one allowed group.
 * - `Identity.domain` is strictly bound to `tenantDomain` (operator/issuer-bound), NEVER derived from email or `hd`.
 * - `Identity.user` is `oidc:<tenantSlug>:<sub>`, namespaced by both source and issuer slug.
 * @param {string} token
 * @param {{ issuer: string, clientId: string, nonce: string, keys: ReturnType<typeof jwksCache>,
 *   tenantSlug: string, tenantDomain: string, emailDomains?: string[], allowedGroups?: string[], groupsClaim?: string,
 *   allowUnverifiedEmail?: boolean, now?: () => number, skewSec?: number, why?: (cause: string) => void }} o
 * @returns {Promise<Identity|null>}
 */
export async function verifyOidcIdToken(token, { issuer, clientId, nonce, keys, tenantSlug, tenantDomain,
  emailDomains = [], allowedGroups = [], groupsClaim = "groups",
  allowUnverifiedEmail = false, now = Date.now, skewSec = 60, why }) {
  const refuse = cause => { try { why?.(cause); } catch { /* a reporter never changes the verdict */ } return null; };
  if (typeof clientId !== "string" || !clientId || typeof issuer !== "string" || !issuer) return refuse("bad_config");
  if (typeof tenantSlug !== "string" || !tenantSlug || typeof tenantDomain !== "string" || !tenantDomain) return refuse("bad_config");
  if (typeof nonce !== "string" || !nonce) return refuse("bad_nonce");
  const jwt = parseJwt(token);
  if (!jwt) return refuse("bad_token");
  const { header, payload: c } = jwt;
  if (header.alg !== "RS256" && header.alg !== "ES256") return refuse("bad_alg");
  if (header.crit !== undefined) return refuse("bad_alg");
  if (header.kid !== undefined && (typeof header.kid !== "string" || !header.kid)) return refuse("bad_alg");

  const entry = await keys.entry(header.kid, header.alg);
  if (!entry) return refuse("unknown_kid");
  if (entry.alg !== header.alg) return refuse("bad_alg");
  const ok = await verifyJwsSignature(entry.alg, entry.key, jwt.sig, jwt.signed);
  if (!ok) return refuse("bad_sig");

  if (c.iss !== issuer) return refuse("bad_issuer");
  if (typeof c.aud === "string") { if (c.aud !== clientId) return refuse("bad_aud"); }
  else if (Array.isArray(c.aud)) {
    if (!c.aud.includes(clientId)) return refuse("bad_aud");
    if (c.aud.length > 1 && c.azp !== clientId) return refuse("bad_aud");
  } else return refuse("bad_aud");
  // OIDC Core § 3.1.3.7 rule 5: if azp is present (even with single aud), it must match clientId.
  if (c.azp !== undefined && c.azp !== clientId) return refuse("bad_aud");
  const t = Math.floor(now() / 1000);
  if (!Number.isFinite(c.exp) || !Number.isFinite(c.iat)) return refuse("bad_time");
  if (t > c.exp + skewSec) return refuse("expired");
  if (c.iat > t + skewSec) return refuse("bad_time");
  if (c.exp <= c.iat) return refuse("bad_time");
  if (c.iat < t - MAX_TOKEN_AGE_SEC) return refuse("stale");
  if (c.nbf !== undefined && (!Number.isFinite(c.nbf) || t + skewSec < c.nbf)) return refuse("bad_time");
  if (c.nonce !== nonce) return refuse("bad_nonce");
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255 || /[\0\r\n]/.test(c.sub)) return refuse("bad_sub");

  if (allowedGroups.length > 0) {
    const rawGroups = c[groupsClaim];
    const tokenGroups = Array.isArray(rawGroups)
      ? rawGroups.filter(g => typeof g === "string")
      : (typeof rawGroups === "string" ? [rawGroups] : []);
    if (!tokenGroups.some(g => allowedGroups.includes(g))) return refuse("group_denied");
  }

  const rawEmail = normalizeEmailClaim(c.email);
  const emailVerified = c.email_verified === true;
  if (!allowUnverifiedEmail && (!emailVerified || !rawEmail)) return refuse("unverified_email");

  // Authoritative email check (mirrors Google's `hd` rule): only carry `email` when the domain is
  // explicitly trusted by the operator (via `emailDomains` or a non-`oidc:` `tenantDomain`).
  let authoritative = null;
  if (emailVerified && rawEmail) {
    const emailDomain = rawEmail.slice(rawEmail.lastIndexOf("@") + 1);
    const allowedDomains = emailDomains.length > 0
      ? emailDomains
      : (!tenantDomain.startsWith("oidc:") ? [tenantDomain] : []);
    if (allowedDomains.includes(emailDomain)) authoritative = rawEmail;
  }

  const rawName = typeof c.name === "string" && c.name.trim()
    ? c.name.trim()
    : (typeof c.preferred_username === "string" && c.preferred_username.trim() ? c.preferred_username.trim() : null);

  return {
    user: `oidc:${tenantSlug}:${c.sub}`,
    name: rawName ? rawName.slice(0, MAX_NAME) : null,
    email: authoritative,
    domain: tenantDomain,
  };
}

// ---- The sign-in flow ----

/** The OAuth token-endpoint error names (RFC 6749 § 5.2) a refusal may report as its cause. */
const TOKEN_ERRORS = ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope"];

/**
 * Every label Google `finish`'s `why` can hear (fixed strings; safe to log, matched by deploy/README.md).
 * `token_http_<status>` covers a token-endpoint refusal (JSON body) without a known error name; `bad_token_response`,
 * a token answer whose body isn't JSON (an empty body included); `idp_unreachable`, a network failure before the whole
 * answer was read.
 */
export const CAUSES = Object.freeze([
  "bad_expected", "state_mismatch", "no_code", ...TOKEN_ERRORS, "token_http_<status>", "idp_timeout", "idp_unreachable",
  "bad_token_response",
  "bad_config", "bad_token", "bad_alg", "unknown_kid", "bad_sig", "bad_iss", "bad_aud", "bad_time", "expired", "stale",
  "bad_nonce", "bad_sub",
]);

/** Additional refusal causes reported by `genericOidc` / `verifyOidcIdToken`. */
export const OIDC_CAUSES = Object.freeze([
  ...CAUSES, "bad_discovery", "bad_issuer", "unverified_email", "group_denied",
]);

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string, fetch: typeof fetch,
 *   now?: () => number, skewSec?: number, jwksCooldownMs?: number, timeoutMs?: number }} config
 * @returns {import("../../../ports/idp.js").IdP & { keys: ReturnType<typeof jwksCache>, verifyIdToken(token: string, nonce: string): Promise<Identity|null> }}
 */
export function googleOidc(config) {
  const { clientId, clientSecret, redirectUri, fetch, now = Date.now, skewSec = 60 } = config;
  if (!clientId || !clientSecret || !redirectUri || typeof fetch !== "function") throw new Error("oidc: incomplete config");
  const keys = jwksCache({ fetch, now, cooldownMs: config.jwksCooldownMs ?? 30_000, timeoutMs: config.timeoutMs ?? 10_000 });

  return {
    displayName: "Google",
    keys,
    /**
     * Start sign-in. Store `{ state, nonce, verifier }` server-side or in a signed, HttpOnly cookie; send the
     * browser to `url`.
     */
    async begin() {
      const state = randomId(32), nonce = randomId(32), verifier = newVerifier();
      const q = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid email profile",
        state, nonce, code_challenge: await challengeS256(verifier), code_challenge_method: "S256",
      });
      return { url: `${GOOGLE.authorize}?${q}`, state, nonce, verifier };
    },
    /**
     * Finish sign-in: check `state`, exchange the code (with the PKCE verifier), verify the ID token.
     * `o.why(cause)`, optional and outside the IdP port (http.js passes it to log a failed sign-in): on a refusal it
     * hears one label from CAUSES. Never a code, token, claim or Google's error_description.
     * @returns {Promise<Identity|null>}
     */
    async finish(o) {
      const { code, state, expected, why } = /** @type {any} */ (o && typeof o === "object" ? o : {});
      const no = cause => { try { if (typeof why === "function") why(cause); } catch { /* never changes the verdict */ } return null; };
      const ok = v => typeof v === "string" && v.length > 0;
      if (!expected || !ok(expected.state) || !ok(expected.nonce) || !ok(expected.verifier)) return no("bad_expected");
      if (state !== expected.state) return no("state_mismatch");
      if (typeof code !== "string" || !code) return no("no_code");
      // Three steps, three kinds of label (p5-tidyv V2, V3): reaching Google and reading its whole answer (a
      // network failure, a reset mid-body included, is `idp_unreachable`; the timeout covers both and is
      // `idp_timeout`); then parsing it (not JSON, an empty body included, is `bad_token_response`, whatever the
      // status); then what it says.
      let res, text, body;
      try {
        res = await fetch(GOOGLE.token, {
          method: "POST",
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, code_verifier: expected.verifier,
          }).toString(),
        });
        text = await res.text();
      } catch (e) { return no(e?.name === "TimeoutError" ? "idp_timeout" : "idp_unreachable"); }
      try { body = JSON.parse(text); } catch { return no("bad_token_response"); }
      if (!res.ok) {
        // Google's `error` field only, and only a name from RFC 6749 § 5.2; never `error_description` or the body.
        const e = body?.error;
        return no(TOKEN_ERRORS.includes(e) ? e : `token_http_${res.status}`);
      }
      return verifyIdToken(body?.id_token, { clientId, nonce: expected.nonce, keys, now, skewSec, why: no });
    },
    /** Verify an ID token directly (exposed for tests and for a future token-exchange endpoint). */
    verifyIdToken: (token, nonce) => verifyIdToken(token, { clientId, nonce, keys, now, skewSec }),
  };
}

/**
 * General OIDC IdP adapter with discovery (`/.well-known/openid-configuration`), PKCE (S256),
 * JWKS signature verification (RS256 & ES256), and issuer-bound tenancy.
 * @param {{ issuerUrl: string, clientId: string, clientSecret: string, redirectUri: string, fetch: typeof globalThis.fetch,
 *   scopes?: string, displayName?: string, tenantSlug?: string, tenantDomain?: string,
 *   emailDomains?: string[], allowedGroups?: string[], groupsClaim?: string,
 *   allowUnverifiedEmail?: boolean, allowHttpLocalhost?: boolean,
 *   now?: () => number, skewSec?: number, jwksCooldownMs?: number, discoveryCooldownMs?: number, timeoutMs?: number }} config
 * @returns {import("../../../ports/idp.js").IdP & {
 *   displayName: string, tenantSlug: string, tenantDomain: string,
 *   discovery: ReturnType<typeof oidcDiscovery>,
 *   verifyIdToken(token: string, nonce: string, o?: { why?: (cause: string) => void }): Promise<Identity|null>
 * }}
 */
export function genericOidc(config) {
  const {
    issuerUrl, clientId, clientSecret, redirectUri, fetch,
    scopes = "openid email profile",
    displayName = "SSO",
    tenantSlug: rawSlug,
    tenantDomain: rawDomain,
    emailDomains: rawEmailDomains = [],
    allowedGroups: rawAllowedGroups = [],
    groupsClaim = "groups",
    allowUnverifiedEmail = false,
    allowHttpLocalhost = false,
    now = Date.now,
    skewSec = 60,
    jwksCooldownMs = 30_000,
    discoveryCooldownMs = 30_000,
    timeoutMs = 10_000,
  } = config ?? {};
  if (!issuerUrl || !clientId || !clientSecret || !redirectUri || typeof fetch !== "function") {
    throw new Error("oidc: incomplete config");
  }

  const discovery = oidcDiscovery({
    issuerUrl, fetch, now, allowHttpLocalhost, cooldownMs: discoveryCooldownMs, timeoutMs,
  });
  const { slug: tenantSlug, domain: tenantDomain } = oidcTenantBinding(issuerUrl, {
    tenantSlug: rawSlug, tenantDomain: rawDomain,
  });
  const emailDomains = (Array.isArray(rawEmailDomains) ? rawEmailDomains : [])
    .map(d => String(d ?? "").trim().toLowerCase()).filter(Boolean);
  const allowedGroups = (Array.isArray(rawAllowedGroups) ? rawAllowedGroups : [])
    .map(g => String(g ?? "").trim()).filter(Boolean);
  const cleanGroupsClaim = typeof groupsClaim === "string" && groupsClaim.trim() ? groupsClaim.trim() : "groups";

  const scopeList = String(scopes ?? "openid email profile").trim().split(/\s+/).filter(Boolean);
  if (!scopeList.includes("openid")) scopeList.unshift("openid");
  const normalizedScopes = [...new Set(scopeList)].join(" ");
  const cleanDisplayName = (typeof displayName === "string" && displayName.trim() ? displayName.trim() : "SSO").slice(0, 64);

  /** @type {{ uri: string, cache: ReturnType<typeof jwksCache> }|null} */
  let jwksHolder = null;
  const keysFor = jwksUri => {
    if (!jwksHolder || jwksHolder.uri !== jwksUri) {
      jwksHolder = {
        uri: jwksUri,
        cache: jwksCache({ url: jwksUri, fetch, now, cooldownMs: jwksCooldownMs, timeoutMs, algorithms: ["RS256", "ES256"], noRedirect: true }),
      };
    }
    return jwksHolder.cache;
  };

  return {
    displayName: cleanDisplayName,
    tenantSlug,
    tenantDomain,
    discovery,

    async begin() {
      const doc = await discovery.get();
      const state = randomId(32), nonce = randomId(32), verifier = newVerifier();
      const authUrl = new URL(doc.authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", normalizedScopes);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("nonce", nonce);
      authUrl.searchParams.set("code_challenge", await challengeS256(verifier));
      authUrl.searchParams.set("code_challenge_method", "S256");
      return { url: authUrl.href, state, nonce, verifier };
    },

    async finish(o) {
      const { code, state, expected, why } = /** @type {any} */ (o && typeof o === "object" ? o : {});
      const refuse = cause => { try { if (typeof why === "function") why(cause); } catch { /* never changes the verdict */ } return null; };
      const ok = v => typeof v === "string" && v.length > 0;
      if (!expected || !ok(expected.state) || !ok(expected.nonce) || !ok(expected.verifier)) return refuse("bad_expected");
      if (state !== expected.state) return refuse("state_mismatch");
      if (typeof code !== "string" || !code) return refuse("no_code");

      let doc;
      try { doc = await discovery.get(); }
      catch (e) {
        const c = e?.causeCode;
        return refuse(typeof c === "string" && OIDC_CAUSES.includes(c) ? c : "bad_discovery");
      }

      let res, text, body;
      try {
        res = await fetch(doc.tokenEndpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, code_verifier: expected.verifier,
          }).toString(),
        });
        text = await res.text();
      } catch (e) { return refuse(e?.name === "TimeoutError" ? "idp_timeout" : "idp_unreachable"); }
      try { body = JSON.parse(text); } catch { return refuse("bad_token_response"); }
      if (!res.ok) {
        const e = body?.error;
        return refuse(TOKEN_ERRORS.includes(e) ? e : `token_http_${res.status}`);
      }
      return verifyOidcIdToken(body?.id_token, {
        issuer: doc.issuer,
        clientId,
        nonce: expected.nonce,
        keys: keysFor(doc.jwksUri),
        tenantSlug,
        tenantDomain,
        emailDomains,
        allowedGroups,
        groupsClaim: cleanGroupsClaim,
        allowUnverifiedEmail,
        now,
        skewSec,
        why: refuse,
      });
    },

    async verifyIdToken(token, nonce, { why } = {}) {
      let doc;
      try { doc = await discovery.get(); }
      catch (e) {
        const c = e?.causeCode;
        try { why?.(typeof c === "string" && OIDC_CAUSES.includes(c) ? c : "bad_discovery"); } catch {}
        return null;
      }
      return verifyOidcIdToken(token, {
        issuer: doc.issuer,
        clientId,
        nonce,
        keys: keysFor(doc.jwksUri),
        tenantSlug,
        tenantDomain,
        emailDomains,
        allowedGroups,
        groupsClaim: cleanGroupsClaim,
        allowUnverifiedEmail,
        now,
        skewSec,
        why,
      });
    },
  };
}
