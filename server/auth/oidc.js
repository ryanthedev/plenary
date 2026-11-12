// Google sign-in (OpenID Connect): authorization code + PKCE (S256), and ID-token verification against Google's
// JWKS. Everything that touches the network goes through an injected `fetch`, so tests run against a fake IdP.
// Client id/secret come from config (the caller reads env); nothing here holds a credential.
//
// The ID token is used once, at the end of sign-in, to make an Identity; the server then issues its own session
// token (session.js). The Auth port never accepts a Google ID token.

import { b64url, unb64url, utf8, fromUtf8, randomId } from "./util.js";

export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

/** @typedef {import("./idp-port.js").Identity} Identity */

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

// ---- JWKS cache ----

/**
 * Keys by `kid`, fetched lazily.
 * - **Max age:** keys are trusted for the response's `Cache-Control: max-age`, capped at `maxAgeCapMs` (1 h) and
 *   floored at `cooldownMs`; with no max-age, the cap. After that the next lookup refetches, so a key Google
 *   withdrew stops verifying within the cap.
 * - **Unknown kid:** one refetch, and refetches are spaced at least `cooldownMs` apart (`retryMs` after a failed
 *   one), so a flood of tokens with made-up kids can't hammer the endpoint.
 * - **Failure keeps what we had:** a non-200, a timeout (`timeoutMs`, AbortSignal) or a body with no usable key
 *   is a failed fetch; the old keys stay. Callers that arrive during a fetch share it (refresh dedupes).
 */
export function jwksCache({ url = GOOGLE.jwks, fetch, now = Date.now, cooldownMs = 30_000, retryMs = 5_000,
  maxAgeCapMs = 3_600_000, timeoutMs = 10_000 }) {
  /** @type {Map<string, CryptoKey>} */
  let keys = new Map();
  let expiresAt = -Infinity;        // keys are fresh until then
  let nextFetchAt = -Infinity;      // no fetch before then (cooldown / retry)
  let inflight = null;

  const maxAge = res => {
    const m = /(?:^|[,\s])max-age=(\d+)/i.exec(res.headers?.get?.("cache-control") ?? "");
    const ms = m ? Number(m[1]) * 1000 : maxAgeCapMs;
    return Math.max(cooldownMs, Math.min(maxAgeCapMs, ms));
  };

  async function load() {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error("jwks fetch failed");
    const body = await res.json();
    const next = new Map();
    for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
      if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      try {
        // The algorithm is fixed here, never taken from the token or the JWK.
        const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        next.set(jwk.kid, key);
      } catch { /* skip an unusable key */ }
    }
    if (next.size === 0) throw new Error("jwks: no usable key"); // keep the old keys
    keys = next;
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
    /** @returns {Promise<CryptoKey|null>} */
    async key(kid) {
      if (keys.has(kid) && now() < expiresAt) return keys.get(kid);
      if (now() >= nextFetchAt) { try { await refresh(); } catch { /* keep the old keys */ } }
      return keys.get(kid) ?? null;
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
  let ok = false;
  try { ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, jwt.sig, jwt.signed); } catch { ok = false; }
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

// ---- The sign-in flow ----

/** The OAuth token-endpoint error names (RFC 6749 § 5.2) a refusal may report as its cause. */
const TOKEN_ERRORS = ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope"];

/**
 * Every label `finish`'s `why` can hear (fixed strings; safe to log). `token_http_<status>` covers a token-endpoint
 * refusal without a known error name.
 */
export const CAUSES = Object.freeze([
  "bad_expected", "state_mismatch", "no_code", ...TOKEN_ERRORS, "token_http_<status>", "idp_timeout", "idp_unreachable",
  "bad_config", "bad_token", "bad_alg", "unknown_kid", "bad_sig", "bad_iss", "bad_aud", "bad_time", "expired", "stale",
  "bad_nonce", "bad_sub",
]);

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string, fetch: typeof fetch,
 *   now?: () => number, skewSec?: number, jwksCooldownMs?: number, timeoutMs?: number }} config
 * @returns {import("./idp-port.js").IdP & { keys: ReturnType<typeof jwksCache>, verifyIdToken(token: string, nonce: string): Promise<Identity|null> }}
 */
export function googleOidc(config) {
  const { clientId, clientSecret, redirectUri, fetch, now = Date.now, skewSec = 60 } = config;
  if (!clientId || !clientSecret || !redirectUri || typeof fetch !== "function") throw new Error("oidc: incomplete config");
  const keys = jwksCache({ fetch, now, cooldownMs: config.jwksCooldownMs ?? 30_000, timeoutMs: config.timeoutMs ?? 10_000 });

  return {
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
      const { code, state, expected, why } = o && typeof o === "object" ? o : {};
      const no = cause => { try { if (typeof why === "function") why(cause); } catch { /* never changes the verdict */ } return null; };
      const ok = v => typeof v === "string" && v.length > 0;
      if (!expected || !ok(expected.state) || !ok(expected.nonce) || !ok(expected.verifier)) return no("bad_expected");
      if (state !== expected.state) return no("state_mismatch");
      if (typeof code !== "string" || !code) return no("no_code");
      let body;
      try {
        const res = await fetch(GOOGLE.token, {
          method: "POST",
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, code_verifier: expected.verifier,
          }).toString(),
        });
        if (!res.ok) {
          // Google's `error` field only, and only a name from RFC 6749 § 5.2; never `error_description` or the body.
          let e = null;
          try { e = (await res.json())?.error; } catch { /* not JSON */ }
          return no(TOKEN_ERRORS.includes(e) ? e : `token_http_${res.status}`);
        }
        body = await res.json();
      } catch (e) { return no(e?.name === "TimeoutError" ? "idp_timeout" : "idp_unreachable"); }
      return verifyIdToken(body?.id_token, { clientId, nonce: expected.nonce, keys, now, skewSec, why: no });
    },
    /** Verify an ID token directly (exposed for tests and for a future token-exchange endpoint). */
    verifyIdToken: (token, nonce) => verifyIdToken(token, { clientId, nonce, keys, now, skewSec }),
  };
}
