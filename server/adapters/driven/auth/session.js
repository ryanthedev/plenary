// @ts-check
// The session token the server issues after sign-in. It travels in `hello.token` (never a header).
//
// Format:  s1.<payload>.<mac>
//   payload = base64url(JSON { u: user, n: name, e: email, d: domain, iat, exp })   (seconds)
//   mac     = base64url(HMAC-SHA256(key, "s1." + payload))
// The key comes from config (≥ 32 bytes, from env); rotating it signs everyone out. `verify` is offline: no
// store lookup, so a session outlives a Workspace departure until `exp` (default 12 h). Roles are NOT in the
// token: they are resolved per board on every hello (tenancy.js), so grant/link/invite changes apply at once.

import { b64url, unb64url, utf8, fromUtf8 } from "../../../core/auth/util.js";

/** @typedef {import("../../../ports/idp.js").Identity} Identity */
/** @typedef {import("../../../ports/idp.js").Session} Session */

/** Maximum allowed per-token TTL override (1 year). */
export const MAX_TTL_SEC = 365 * 24 * 60 * 60;

/** @param {{ key: Uint8Array|string, ttlSec?: number, snapshotTtlSec?: number, blobTtlSec?: number, now?: () => number }} config */
export async function sessions({ key, ttlSec = 12 * 3600, snapshotTtlSec = 300, blobTtlSec = 300, now = Date.now }) {
  const raw = typeof key === "string" ? utf8(key) : key;
  if (!raw || raw.length < 32) throw new Error("session: key must be at least 32 bytes");
  // `exp` = iat + ttlSec must be an integer (the Verifier port and the exchange's 200 body promise one).
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) throw new Error("session: ttlSec must be a positive integer");
  if (!Number.isInteger(snapshotTtlSec) || snapshotTtlSec <= 0) throw new Error("session: snapshotTtlSec must be a positive integer");
  if (!Number.isInteger(blobTtlSec) || blobTtlSec <= 0) throw new Error("session: blobTtlSec must be a positive integer");
  const k = await crypto.subtle.importKey("raw", /** @type {BufferSource} */ (raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

  return {
    /** @param {Identity} id @param {{ ttlSec?: number, ttlMs?: number }} [opts] */
    async issue(id, opts) {
      const iat = Math.floor(now() / 1000);
      let ttl = ttlSec;
      if (opts?.ttlSec !== undefined) {
        if (!Number.isSafeInteger(opts.ttlSec) || opts.ttlSec <= 0 || opts.ttlSec > MAX_TTL_SEC) {
          throw new Error(`session: ttlSec must be a safe integer in [1, ${MAX_TTL_SEC}]`);
        }
        ttl = opts.ttlSec;
      }
      if (opts?.ttlMs !== undefined) {
        if (!Number.isSafeInteger(opts.ttlMs) || opts.ttlMs <= 0 || opts.ttlMs > MAX_TTL_SEC * 1000) {
          throw new Error(`session: ttlMs must be a safe integer in [1, ${MAX_TTL_SEC * 1000}]`);
        }
        if (opts.ttlSec === undefined) ttl = Math.max(1, Math.floor(opts.ttlMs / 1000));
      }
      const payload = b64url(utf8(JSON.stringify({ u: id.user, n: typeof id.name === "string" ? id.name.slice(0, 200) : null, e: id.email ?? null, d: id.domain ?? null, iat, exp: iat + ttl })));
      const mac = await crypto.subtle.sign("HMAC", k, utf8("s1." + payload));
      return `s1.${payload}.${b64url(mac)}`;
    },
    /** The Identity plus `exp` (integer seconds since the epoch, always in the future), or null.
     * @returns {Promise<Session|null>} */
    async verify(token) {
      if (typeof token !== "string" || token.length > 4096 || !token.startsWith("s1.")) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      try {
        const ok = await crypto.subtle.verify("HMAC", k, unb64url(parts[2]), utf8("s1." + parts[1]));
        if (!ok) return null;
        const c = JSON.parse(fromUtf8(unb64url(parts[1])));
        if (typeof c?.u !== "string" || !Number.isInteger(c.exp)) return null;
        if (Math.floor(now() / 1000) >= c.exp) return null;
        return { user: c.u, name: c.n ?? null, email: c.e ?? null, domain: c.d ?? null, exp: c.exp };
      } catch { return null; }
    },
    /** Short-lived HMAC-signed ticket for HTTP snapshot fetch (F9). Prefix "snap1." never verifies as "s1."/"l1."/"x1.". */
    async issueSnapshotTicket(board, seq, ttl = snapshotTtlSec) {
      if (typeof board !== "string" || !board || board.length > 128) throw new Error("session: snapshot ticket requires board id");
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("session: snapshot ticket requires non-negative integer seq");
      if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("session: snapshot ticket ttl must be a positive integer");
      const exp = Math.floor(now() / 1000) + ttl;
      const payload = b64url(utf8(JSON.stringify({ b: board, s: seq, exp })));
      const mac = await crypto.subtle.sign("HMAC", k, utf8("snap1." + payload));
      return `snap1.${payload}.${b64url(mac)}`;
    },
    /** Verify a snapshot ticket offline (no store/registry lookup). Returns `{ board, seq, exp }` or null. */
    async verifySnapshotTicket(ticket) {
      if (typeof ticket !== "string" || ticket.length > 1024 || !ticket.startsWith("snap1.")) return null;
      const parts = ticket.split(".");
      if (parts.length !== 3) return null;
      try {
        const ok = await crypto.subtle.verify("HMAC", k, unb64url(parts[2]), utf8("snap1." + parts[1]));
        if (!ok) return null;
        const c = JSON.parse(fromUtf8(unb64url(parts[1])));
        if (typeof c?.b !== "string" || !c.b || !Number.isSafeInteger(c.s) || c.s < 0 || !Number.isInteger(c.exp)) return null;
        if (Math.floor(now() / 1000) >= c.exp) return null;
        return { board: c.b, seq: c.s, exp: c.exp };
      } catch { return null; }
    },
    /** Short-lived HMAC-signed ticket for HTTP blob GET/PUT (PROTOCOL.md § Blobs). Prefix "blob1." is isolated from s1./l1./x1./snap1. */
    async issueBlobTicket(tenant, sha1, verb, ttl = blobTtlSec) {
      if (typeof tenant !== "string" || !tenant || tenant.length > 128) throw new Error("session: blob ticket requires tenant id");
      if (typeof sha1 !== "string" || !/^[0-9a-f]{40}$/.test(sha1)) throw new Error("session: blob ticket requires 40-char lowercase hex sha1");
      if (verb !== "get" && verb !== "put") throw new Error("session: blob ticket verb must be get or put");
      if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("session: blob ticket ttl must be a positive integer");
      const exp = Math.floor(now() / 1000) + ttl;
      const payload = b64url(utf8(JSON.stringify({ t: tenant, h: sha1, v: verb, exp })));
      const mac = await crypto.subtle.sign("HMAC", k, utf8("blob1." + payload));
      return `blob1.${payload}.${b64url(mac)}`;
    },
    /** Verify a blob ticket offline (timing-safe HMAC). Returns `{ tenant, sha1, verb, exp }` or null. */
    async verifyBlobTicket(ticket) {
      if (typeof ticket !== "string" || ticket.length > 1024 || !ticket.startsWith("blob1.")) return null;
      const parts = ticket.split(".");
      if (parts.length !== 3) return null;
      try {
        const ok = await crypto.subtle.verify("HMAC", k, unb64url(parts[2]), utf8("blob1." + parts[1]));
        if (!ok) return null;
        const c = JSON.parse(fromUtf8(unb64url(parts[1])));
        if (typeof c?.t !== "string" || !c.t || c.t.length > 128) return null;
        if (typeof c?.h !== "string" || !/^[0-9a-f]{40}$/.test(c.h)) return null;
        if (c?.v !== "get" && c?.v !== "put") return null;
        if (!Number.isInteger(c?.exp)) return null;
        if (Math.floor(now() / 1000) >= c.exp) return null;
        return { tenant: c.t, sha1: c.h, verb: c.v, exp: c.exp };
      } catch { return null; }
    },
  };
}
