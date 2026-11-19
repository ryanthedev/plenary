// Blob access (PROTOCOL.md § Blobs): the application service between the Blobs port and the two ways in. Core: it
// knows no HTTP, no socket and no adapter, only the Blobs port (server/blobs/port.js), a key and a clock.
//   url(tenant, board, sha1, verb)   a signed, 5-minute URL for one blob and one verb ("GET" | "PUT"); the gateway asks
//                                    for it after it has checked the connection's role.
//   put(token, bytes)                what `PUT /blobs/<token>` does: verify the token, reserve quota, store.
//   get(token)                       what `GET /blobs/<token>` does: verify the token, read.
//   recount(tenant)                  the tenant's cached usage is stale (the reaper deleted blobs): the next put reads usage() again.
// Both answer `{ ok: true, … }` or `{ ok: false, code }` (never throw for a client's mistake); the HTTP adapter
// (blob-http.js) turns a code into a status. Codes: bad-token, wrong-verb, too-large, bad-length, not-image,
// hash-mismatch, quota, not-found, unavailable.
//
// Token: base64url(payload) "." base64url(HMAC-SHA256(key, "b1." payload)); payload = JSON { tenant, board, sha1, verb,
// user?, exp (ms) }. The key is the deployment's (every gateway verifies every other gateway's URLs). The role is checked
// when the URL is asked for, never here: a URL is a bearer capability for its 5 minutes. Tenant, hash and verb come
// only from the verified payload, so nothing a caller sends can name another tenant's blob.
//
// Quota (per tenant, one count per node): the first put for a tenant reads `blobs.usage(tenant)`; after that the node
// adds what it stores. A put reserves its size before storing and gives it back after, so puts racing on one node
// can never go over the quota together. Other nodes' puts are invisible until this node restarts (PROTOCOL.md § Known
// limits). A blob the tenant already has costs nothing, even at the limit.

import { b64url, unb64url, utf8, fromUtf8 } from "./auth/util.js";
import { isId, isSha1, PortError } from "./ids.js";
import { quietLogger } from "./log.js";
import { imageKind, MAX_BLOB_BYTES } from "./blobs/port.js";

export const TYPES = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const DEFAULT_QUOTA_BYTES = 10 * 1024 ** 3;
export const URL_TTL_MS = 5 * 60_000;
const VERBS = ["GET", "PUT"];
const MAX_TOKEN_CHARS = 1024;

// A PortError from the adapter, as the code a client sees. Anything else is a bug or an outage: logged, "unavailable".
const CODES = { "too-large": "too-large", "hash-mismatch": "hash-mismatch", "not-image": "not-image", "bad-entry": "bad-length" };

/**
 * @param {{ blobs: { put: Function, get: Function, usage: Function }, key: Uint8Array, origin?: string,
 *           now?: () => number, quotaBytes?: number, ttlMs?: number, usageTtlMs?: number, log?: object }} o
 *   usageTtlMs: a tenant's cached usage is read again when it is older than this (other nodes' puts and the reaper's deletes change it; default never, main.js passes the reap interval)
 *   key: ≥ 32 bytes (derive it from the shared key; never the key itself). origin: where browsers reach this server
 *   (PUBLIC_URL, no trailing slash); "" (the default) makes every URL the path /blobs/<token>, which the client resolves
 *   against the origin it connected to.
 */
export function blobAccess({ blobs, key, origin = "", now = Date.now, quotaBytes = DEFAULT_QUOTA_BYTES, ttlMs = URL_TTL_MS, usageTtlMs = Infinity, log = quietLogger }) {
  if (!blobs || typeof blobs.put !== "function" || typeof blobs.get !== "function" || typeof blobs.usage !== "function") throw new TypeError("blobAccess needs a Blobs port (put, get, usage)");
  if (!(key instanceof Uint8Array) || key.length < 32) throw new TypeError("blobAccess: key must be at least 32 bytes");
  if (typeof origin !== "string") throw new TypeError("blobAccess: origin must be a string");
  if (!Number.isFinite(quotaBytes) || quotaBytes < 0) throw new TypeError("blobAccess: quotaBytes must be a number ≥ 0");
  const mac = crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

  /** @type {Map<string, { used: number, reserved: number, ready: Promise<void> | null, gen: number, at: number }>} gen counts reads of usage; at: when the last one answered */
  const tenants = new Map();

  /** The signed claims of a token for `verb`, or { ok: false, code }. */
  async function verify(token, verb) {
    if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return { ok: false, code: "bad-token" };
    const parts = token.split(".");
    if (parts.length !== 2) return { ok: false, code: "bad-token" };
    let claims;
    try {
      const sig = unb64url(parts[1]), body = unb64url(parts[0]);
      // One spelling per token: the last base64 character carries unused bits that atob() ignores, so a token has several
      // spellings that all verify. Refuse all but the canonical one (the HTTP adapter's single-flight keys on the string).
      if (b64url(sig) !== parts[1] || b64url(body) !== parts[0]) return { ok: false, code: "bad-token" };
      if (!(await crypto.subtle.verify("HMAC", await mac, sig, utf8("b1." + parts[0])))) return { ok: false, code: "bad-token" };
      claims = JSON.parse(fromUtf8(body));
    } catch { return { ok: false, code: "bad-token" }; }
    const { tenant, board, sha1, exp } = claims ?? {};
    if (!isId(tenant) || !isId(board) || !isSha1(sha1) || !VERBS.includes(claims.verb) || !Number.isFinite(exp) || exp <= now()) return { ok: false, code: "bad-token" };
    if (claims.user !== undefined && (typeof claims.user !== "string" || !claims.user || claims.user.length > 128)) return { ok: false, code: "bad-token" };
    if (claims.verb !== verb) return { ok: false, code: "wrong-verb" };
    return { ok: true, tenant, board, sha1, user: claims.user ?? null };
  }

  /** Read the tenant's usage once (concurrent first puts share one read); a failed read is tried again by the next put. */
  function seed(tenant) {
    let st = tenants.get(tenant);
    if (!st) tenants.set(tenant, st = { used: 0, reserved: 0, ready: null, gen: 0, at: 0 });
    if (st.ready && st.at && now() - st.at >= usageTtlMs) st.ready = null;     // stale: another node (or the reaper) changed what the tenant stores
    // A read SETS the count (never adds to it) and starts a new generation: a put that began before it is already in what it read (or was not yet), so its own `+= n` is ignored.
    st.ready ??= Promise.resolve(blobs.usage(tenant)).then(n => { st.used = n; st.gen++; st.at = now(); }, err => { st.ready = null; throw err; });
    return st.ready.then(() => st);
  }

  const unavailable = (what, tenant, err) => { log.error(`blob ${what} failed`, { tenant, code: err?.code, err }); return { ok: false, code: "unavailable" }; };

  return {
    /** The tenant's quota count is stale (blobs were deleted): the next put reads `usage` again. A put in flight finishes against the old count, which only errs towards refusing. */
    recount(tenant) { const st = tenants.get(tenant); if (st) st.ready = null; },

    /** The claims of a token for `verb`, or { ok: false, code }: the HTTP adapter checks it before it reads a body. */
    verify,

    /** A signed URL for (tenant, board, sha1, verb); `user` (the requester, a string) rides in the token so the HTTP side can cap one user's uploads. The caller has checked the role. */
    async url(tenant, board, sha1, verb, user = null) {
      if (!isId(tenant) || !isId(board) || !isSha1(sha1) || !VERBS.includes(verb)) throw new PortError("bad-id", "bad blob url scope");
      if (user !== null && (typeof user !== "string" || !user || user.length > 128)) throw new PortError("bad-id", "bad blob url user");
      const payload = b64url(utf8(JSON.stringify({ tenant, board, sha1, verb, ...(user !== null ? { user } : {}), exp: now() + ttlMs })));
      return `${origin}/blobs/${payload}.${b64url(await crypto.subtle.sign("HMAC", await mac, utf8("b1." + payload)))}`;
    },

    /** @returns {Promise<{ ok: true, created: boolean } | { ok: false, code: string }>} */
    async put(token, bytes) {
      const v = await verify(token, "PUT");
      if (!v.ok) return v;
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return { ok: false, code: "bad-length" };
      if (bytes.byteLength > MAX_BLOB_BYTES) return { ok: false, code: "too-large" };
      let st;
      try { st = await seed(v.tenant); } catch (err) { return unavailable("usage", v.tenant, err); }
      const n = bytes.byteLength;
      if (st.used + st.reserved + n > quotaBytes) {
        // Over, but a blob the tenant already holds costs nothing: look before refusing (rare: only at the limit).
        try { if (await blobs.get(v.tenant, v.sha1)) return { ok: true, created: false }; } catch (err) { return unavailable("get", v.tenant, err); }
        return { ok: false, code: "quota" };
      }
      st.reserved += n;
      const gen = st.gen;
      try {
        const created = await blobs.put(v.tenant, v.sha1, bytes);
        if (created && st.gen === gen) st.used += n;
        return { ok: true, created: created !== false };
      } catch (err) {
        return CODES[err?.code] ? { ok: false, code: CODES[err.code] } : unavailable("put", v.tenant, err);
      } finally { st.reserved -= n; }
    },

    /** @returns {Promise<{ ok: true, bytes: Uint8Array, type: string } | { ok: false, code: string }>} */
    async get(token) {
      const v = await verify(token, "GET");
      if (!v.ok) return v;
      try {
        const bytes = await blobs.get(v.tenant, v.sha1);
        if (!bytes) return { ok: false, code: "not-found" };
        const kind = imageKind(bytes);
        if (!kind) return unavailable("get", v.tenant, new PortError("not-image", "a stored blob is not an image"));
        return { ok: true, bytes, type: TYPES[kind] };
      } catch (err) { return unavailable("get", v.tenant, err); }
    },
  };
}
