// @ts-check
// Small helpers for the auth module: base64url, random ids, roles. WebCrypto only (no dependencies).

/** Roles, lowest to highest (PROTOCOL.md § Streams). Kept local: packages/protocol's ports are engine-owned. */
export const ROLES = ["viewer", "commenter", "annotator", "editor", "owner"];
/** Roles a share link may carry (brief p5-auth). */
export const LINK_ROLES = ["viewer", "annotator", "editor"];
/** Roles an invite or grant may carry without being the board's creator. */
export const INVITE_ROLES = ["viewer", "commenter", "annotator", "editor"];

/**
 * The highest role in `allowed` that is no higher than `r`; null for an unknown role. Used to cap what the
 * Registry holds (the engine's SQL Registry is a second writer, so role() trusts no stored role as-is).
 */
export function capTo(r, allowed) {
  const n = ROLES.indexOf(r);
  if (n < 0) return null;
  let best = null;
  for (const a of allowed) if (ROLES.indexOf(a) <= n && (best == null || ROLES.indexOf(a) > ROLES.indexOf(best))) best = a;
  return best;
}

/** @param {string|null|undefined} r */
export const rank = r => (r == null ? -1 : ROLES.indexOf(r));
/** The higher of two roles (null = none). */
export const higher = (a, b) => (rank(b) > rank(a) ? b : a);

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = s => enc.encode(s);
export const fromUtf8 = b => dec.decode(b);

/** @param {Uint8Array|ArrayBuffer} bytes */
export function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decode; throws on anything else. */
export function unb64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
/** A random id over [a-z0-9]; n chars ≈ n·5.17 bits. Rejection sampling, so no bias. */
export function randomId(n) {
  let s = "";
  while (s.length < n) {
    const buf = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const x of buf) if (x < 252 && s.length < n) s += ALPHA[x % 36];
  }
  return s;
}

/** Normalise an email for invite and org-member matching. */
export const normEmail = e => (typeof e === "string" ? e.trim().toLowerCase() : null);

/**
 * Verified email for an Identity, or null if absent/unverified.
 * Google OIDC (`google:<sub>`) populates `email` only when `email_verified === true` and Google is authoritative;
 * an explicit `emailVerified: false` always rejects. Non-Google identities (e.g. dev tokens) are not IdP-verified
 * unless `emailVerified === true` is explicitly set.
 */
export function verifiedEmail(identity) {
  if (!identity || typeof identity.user !== "string") return null;
  if (identity.emailVerified === false) return null;
  const e = normEmail(identity.email);
  if (!e) return null;
  if (identity.user.startsWith("google:")) return e;
  return identity.emailVerified === true ? e : null;
}

/**
 * Whether `caller` is an admin of tenant record `t` (by user id or by verified `email:<addr>` entry).
 * Workspace tenant: `email:` requires `caller.domain === t.domain`.
 * Personal tenant (`t.domain === null`): `email:` requires a consumer Google account (`!caller.domain`).
 */
export function isTenantAdminRecord(t, caller) {
  if (!t || !caller || typeof caller.user !== "string") return false;
  if (!caller.user.startsWith("email:") && Array.isArray(t.admins) && t.admins.includes(caller.user)) return true;
  if (!caller.user.startsWith("google:") || caller.emailVerified === false) return false;
  const email = normEmail(caller.email);
  if (!email || !Array.isArray(t.admins) || !t.admins.includes("email:" + email)) return false;
  return t.domain === null ? !caller.domain : caller.domain === t.domain;
}
