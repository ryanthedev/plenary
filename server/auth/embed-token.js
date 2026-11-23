// @ts-check
// HMAC-signed read-only board embed tokens (Issue #23).
// Pure WebCrypto core (zero bare package imports).
//
// Security invariants:
//   - Every minted token is strictly scoped to `{ board, tenant, scope: "embed", role: "viewer" }`.
//   - Cannot write, annotate, comment, or access any board other than `claims.board`.
//   - Domain-separated HMAC-SHA256 (`emb1.<b64url(payload)>`) with canonical base64url enforcement.
//   - Enforces expiry (`exp`) and optional revocation checks (`isRevoked(claims)`).

import { b64url, unb64url, utf8, fromUtf8, randomId } from "./util.js";
import { isId } from "../ids.js";

export const EMBED_TOKEN_PREFIX = "emb1.";
export const EMBED_SCOPE = "embed";
export const EMBED_ROLE = "viewer";
export const DEFAULT_EMBED_TTL_MS = 24 * 60 * 60_000;
export const MAX_EMBED_TTL_MS = 365 * 24 * 60 * 60_000;

const MAX_TOKEN_CHARS = 2048;
const READ_ONLY_ACTIONS = new Set(["read", "view", "subscribe"]);

/**
 * @typedef {{
 *   v: 1,
 *   jti: string,
 *   board: string,
 *   tenant: string,
 *   scope: "embed",
 *   role: "viewer",
 *   iat: number,
 *   exp: number,
 *   issuedBy?: string,
 * }} EmbedTokenClaims
 */

/**
 * Check whether an embed token's verified claims permit a given action.
 * Embed tokens are strictly read-only (`viewer` on `embed` scope) and can never write,
 * annotate, comment, or perform admin operations.
 * @param {Partial<EmbedTokenClaims> | null | undefined} claims
 * @param {string} action
 * @param {string | null} [targetBoard]
 * @returns {boolean}
 */
export function canEmbedTokenPerform(claims, action, targetBoard = null) {
  if (!claims || typeof claims !== "object") return false;
  if (claims.scope !== EMBED_SCOPE || claims.role !== EMBED_ROLE) return false;
  if (!isId(claims.board) || !isId(claims.tenant)) return false;
  if (targetBoard !== null && claims.board !== targetBoard) return false;
  return typeof action === "string" && READ_ONLY_ACTIONS.has(action);
}

/**
 * Create a mint/verify service for HMAC-SHA256 read-only board embed tokens.
 * @param {{
 *   key: Uint8Array,
 *   now?: () => number,
 *   defaultTtlMs?: number,
 *   isRevoked?: ((claims: EmbedTokenClaims) => boolean | Promise<boolean>) | null,
 * }} opts
 */
export function createEmbedTokens({
  key,
  now = Date.now,
  defaultTtlMs = DEFAULT_EMBED_TTL_MS,
  isRevoked = null,
}) {
  if (!(key instanceof Uint8Array) || key.length < 32) {
    throw new TypeError("createEmbedTokens: key must be a Uint8Array of at least 32 bytes");
  }
  if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0 || defaultTtlMs > MAX_EMBED_TTL_MS) {
    throw new TypeError("createEmbedTokens: defaultTtlMs must be between 1ms and 365 days");
  }

  const mac = crypto.subtle.importKey(
    "raw",
    /** @type {BufferSource} */ (key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  return {
    /**
     * Mint an HMAC-signed read-only embed token bound to a single board and tenant.
     * `scope` is always `"embed"` and `role` is always `"viewer"`.
     * @param {{ board: string, tenant: string, ttlMs?: number, jti?: string, issuedBy?: string | null }} input
     */
    async mint({ board, tenant, ttlMs = defaultTtlMs, jti = randomId(16), issuedBy = null }) {
      if (!isId(board)) throw new TypeError("embed-token: invalid board id");
      if (!isId(tenant)) throw new TypeError("embed-token: invalid tenant id");
      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_EMBED_TTL_MS) {
        throw new TypeError("embed-token: invalid ttlMs");
      }
      if (typeof jti !== "string" || jti.length < 4 || jti.length > 64) {
        throw new TypeError("embed-token: invalid jti");
      }
      const iat = now();
      const exp = iat + Math.floor(ttlMs);
      /** @type {EmbedTokenClaims} */
      const claims = {
        v: 1,
        jti,
        board,
        tenant,
        scope: EMBED_SCOPE,
        role: EMBED_ROLE,
        iat,
        exp,
        ...(typeof issuedBy === "string" && issuedBy.length > 0 && issuedBy.length <= 128 ? { issuedBy } : {}),
      };
      const body = b64url(utf8(JSON.stringify(claims)));
      const sig = b64url(await crypto.subtle.sign("HMAC", await mac, utf8(EMBED_TOKEN_PREFIX + body)));
      return {
        token: `${body}.${sig}`,
        claims,
      };
    },

    /**
     * Verify an embed token signature, canonical encoding, strict read-only scope/role,
     * optional board binding, expiry, and revocation status. Never throws.
     * @param {unknown} token
     * @param {{ board?: string | null, isRevoked?: ((claims: EmbedTokenClaims) => boolean | Promise<boolean>) | null }} [opts]
     * @returns {Promise<{ ok: true, claims: EmbedTokenClaims } | { ok: false, code: "bad-token" | "bad-scope" | "wrong-board" | "expired" | "revoked" }>}
     */
    async verify(token, opts = {}) {
      if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS) {
        return { ok: false, code: "bad-token" };
      }
      const parts = token.split(".");
      if (parts.length !== 2) return { ok: false, code: "bad-token" };

      /** @type {any} */
      let claims;
      try {
        const body = unb64url(parts[0]);
        const sig = unb64url(parts[1]);
        if (b64url(body) !== parts[0] || b64url(sig) !== parts[1]) {
          return { ok: false, code: "bad-token" };
        }
        const valid = await crypto.subtle.verify("HMAC", await mac, sig, utf8(EMBED_TOKEN_PREFIX + parts[0]));
        if (!valid) return { ok: false, code: "bad-token" };
        claims = JSON.parse(fromUtf8(body));
      } catch {
        return { ok: false, code: "bad-token" };
      }

      if (!claims || typeof claims !== "object" || claims.v !== 1) {
        return { ok: false, code: "bad-token" };
      }
      if (!isId(claims.board) || !isId(claims.tenant)) {
        return { ok: false, code: "bad-token" };
      }
      if (typeof claims.jti !== "string" || claims.jti.length < 4 || claims.jti.length > 64) {
        return { ok: false, code: "bad-token" };
      }
      if (claims.scope !== EMBED_SCOPE || claims.role !== EMBED_ROLE) {
        return { ok: false, code: "bad-scope" };
      }
      if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) {
        return { ok: false, code: "bad-token" };
      }
      if (claims.exp <= now()) {
        return { ok: false, code: "expired" };
      }
      if (opts.board != null && claims.board !== opts.board) {
        return { ok: false, code: "wrong-board" };
      }

      const revokeFn = opts.isRevoked !== undefined ? opts.isRevoked : isRevoked;
      if (typeof revokeFn === "function") {
        try {
          if (await revokeFn(claims)) return { ok: false, code: "revoked" };
        } catch {
          return { ok: false, code: "revoked" };
        }
      }

      return {
        ok: true,
        claims: {
          v: 1,
          jti: claims.jti,
          board: claims.board,
          tenant: claims.tenant,
          scope: EMBED_SCOPE,
          role: EMBED_ROLE,
          iat: claims.iat,
          exp: claims.exp,
          ...(typeof claims.issuedBy === "string" ? { issuedBy: claims.issuedBy } : {}),
        },
      };
    },
  };
}
