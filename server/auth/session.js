// The session token the server issues after sign-in. It travels in `hello.token` (never a header).
//
// Format:  s1.<payload>.<mac>
//   payload = base64url(JSON { u: user, n: name, e: email, d: domain, iat, exp })   (seconds)
//   mac     = base64url(HMAC-SHA256(key, "s1." + payload))
// The key comes from config (≥ 32 bytes, from env); rotating it signs everyone out. `verify` is offline: no
// store lookup, so a session outlives a Workspace departure until `exp` (default 12 h). Roles are NOT in the
// token: they are resolved per board on every hello (tenancy.js), so grant/link/invite changes apply at once.

import { b64url, unb64url, utf8, fromUtf8 } from "./util.js";

/** @typedef {import("./oidc.js").Identity} Identity */

/** @param {{ key: Uint8Array|string, ttlSec?: number, now?: () => number }} config */
export async function sessions({ key, ttlSec = 12 * 3600, now = Date.now }) {
  const raw = typeof key === "string" ? utf8(key) : key;
  if (!raw || raw.length < 32) throw new Error("session: key must be at least 32 bytes");
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

  return {
    /** @param {Identity} id */
    async issue(id) {
      const iat = Math.floor(now() / 1000);
      const payload = b64url(utf8(JSON.stringify({ u: id.user, n: typeof id.name === "string" ? id.name.slice(0, 200) : null, e: id.email ?? null, d: id.domain ?? null, iat, exp: iat + ttlSec })));
      const mac = await crypto.subtle.sign("HMAC", k, utf8("s1." + payload));
      return `s1.${payload}.${b64url(mac)}`;
    },
    /** @returns {Promise<Identity|null>} */
    async verify(token) {
      if (typeof token !== "string" || token.length > 4096 || !token.startsWith("s1.")) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      try {
        const ok = await crypto.subtle.verify("HMAC", k, unb64url(parts[2]), utf8("s1." + parts[1]));
        if (!ok) return null;
        const c = JSON.parse(fromUtf8(unb64url(parts[1])));
        if (typeof c?.u !== "string" || !Number.isFinite(c.exp)) return null;
        if (Math.floor(now() / 1000) >= c.exp) return null;
        return { user: c.u, name: c.n ?? null, email: c.e ?? null, domain: c.d ?? null };
      } catch { return null; }
    },
  };
}
