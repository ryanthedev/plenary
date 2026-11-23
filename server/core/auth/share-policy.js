// @ts-check
// Share link policy (#37): passcode hashing & verification (scrypt + constant-time compare),
// policy validation (passcode length, future expiry, noDownload), link policy evaluation,
// and in-memory per-link brute-force exponential backoff.
//
// Security invariants:
//   - Passcodes are hashed with node:crypto scryptSync (16-byte random salt, 32-byte derived key)
//     and verified with timingSafeEqual.
//   - Plaintext passcodes and passcode hashes are NEVER returned in policy check results.
//   - Rate limiting is checked BEFORE scrypt verification to prevent CPU DoS on locked links.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const PASSCODE_MIN_LEN = 4;
export const PASSCODE_MAX_LEN = 128;
/** Maximum share link expiry horizon: 10 years (matches server/admin/boards.js MAX_EXPIRY_MS). */
export const MAX_SHARE_EXPIRY_MS = 10 * 365 * 86_400_000;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_LEN = 32;
const HEX_RE = /^[0-9a-f]+$/;

/**
 * Hash a share-link passcode using scryptSync (16-byte random salt, 32-byte key).
 * Output format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`.
 * @param {string} passcode
 * @returns {string}
 */
export function hashPasscode(passcode) {
  if (typeof passcode !== "string" || passcode.length < PASSCODE_MIN_LEN || passcode.length > PASSCODE_MAX_LEN) {
    throw new Error(`share-policy: passcode must be a string of ${PASSCODE_MIN_LEN}-${PASSCODE_MAX_LEN} characters`);
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(passcode, salt, SCRYPT_KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a candidate passcode against a stored scrypt hash using constant-time comparison.
 * Returns false for any malformed hash, invalid parameters, or non-string input (never throws).
 * @param {unknown} passcode
 * @param {unknown} storedHash
 * @returns {boolean}
 */
export function verifyPasscode(passcode, storedHash) {
  if (typeof passcode !== "string" || typeof storedHash !== "string") return false;
  if (passcode.length === 0 || passcode.length > PASSCODE_MAX_LEN) return false;
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];

  // Validate scrypt parameters are safe positive integers within sane bounds to prevent DoS from tampered hashes.
  if (!Number.isSafeInteger(N) || N < 1024 || N > 65536 || (N & (N - 1)) !== 0) return false;
  if (!Number.isSafeInteger(r) || r < 1 || r > 16) return false;
  if (!Number.isSafeInteger(p) || p < 1 || p > 4) return false;
  if (saltHex.length !== SCRYPT_SALT_BYTES * 2 || !HEX_RE.test(saltHex)) return false;
  if (hashHex.length !== SCRYPT_KEY_LEN * 2 || !HEX_RE.test(hashHex)) return false;

  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = scryptSync(passcode, salt, expected.length, { N, r, p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Validate share link policy inputs before creation.
 * @param {{ passcode?: unknown, noDownload?: unknown, expiresAt?: unknown }} [input]
 * @param {number} [now]
 * @returns {{ ok: true, policy: { passcode: string|null, noDownload: boolean, expiresAt: number|null } } | { ok: false, code: "bad-policy"|"bad-passcode"|"bad-no-download"|"bad-expiry", error: string }}
 */
export function validateSharePolicy(input = {}, now = Date.now()) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "bad-policy", error: "share policy must be an object" };
  }
  const { passcode, noDownload, expiresAt } = input;

  /** @type {string|null} */
  let cleanPasscode = null;
  if (passcode !== undefined && passcode !== null) {
    if (typeof passcode !== "string") {
      return { ok: false, code: "bad-passcode", error: "passcode must be a string" };
    }
    if (passcode.length < PASSCODE_MIN_LEN || passcode.length > PASSCODE_MAX_LEN) {
      return {
        ok: false,
        code: "bad-passcode",
        error: `passcode must be between ${PASSCODE_MIN_LEN} and ${PASSCODE_MAX_LEN} characters`,
      };
    }
    cleanPasscode = passcode;
  }

  let cleanNoDownload = false;
  if (noDownload !== undefined) {
    if (typeof noDownload !== "boolean") {
      return { ok: false, code: "bad-no-download", error: "noDownload must be a boolean" };
    }
    cleanNoDownload = noDownload;
  }

  /** @type {number|null} */
  let cleanExpiresAt = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      return { ok: false, code: "bad-expiry", error: "expiresAt must be a whole number of ms in the future, at most 10 years ahead" };
    }
    if (expiresAt > now + MAX_SHARE_EXPIRY_MS) {
      return { ok: false, code: "bad-expiry", error: "expiresAt may be at most 10 years ahead" };
    }
    cleanExpiresAt = expiresAt;
  }

  return {
    ok: true,
    policy: {
      passcode: cleanPasscode,
      noDownload: cleanNoDownload,
      expiresAt: cleanExpiresAt,
    },
  };
}

/**
 * @typedef {{
 *   check(linkId: string, now?: number): { allowed: boolean, retryAfterMs: number },
 *   recordFailure(linkId: string, now?: number): { failures: number, lockedUntil: number, retryAfterMs: number },
 *   reset(linkId: string): void,
 *   size(): number,
 * }} LinkRateLimiter
 */

/**
 * In-memory per-link brute-force exponential backoff helper.
 * Bounded to `maxEntries` (oldest key evicted first) so probing random link IDs cannot exhaust memory.
 * @param {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, windowMs?: number, maxEntries?: number }} [opts]
 * @returns {LinkRateLimiter}
 */
export function createLinkRateLimiter({
  maxAttempts = 5,
  baseDelayMs = 1_000,
  maxDelayMs = 15 * 60_000,
  windowMs = 15 * 60_000,
  maxEntries = 10_000,
} = {}) {
  const posInt = (v, fallback) => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback);
  const cap = posInt(maxEntries, 10_000);
  const attempts = posInt(maxAttempts, 5);
  const baseDelay = posInt(baseDelayMs, 1_000);
  const maxDelay = Math.max(baseDelay, posInt(maxDelayMs, 15 * 60_000));
  const winMs = posInt(windowMs, 15 * 60_000);
  /** @type {Map<string, { failures: number, lockedUntil: number, lastFailureAt: number }>} */
  const state = new Map();

  const isStale = (entry, now) => now >= entry.lockedUntil && now - entry.lastFailureAt >= winMs;

  return {
    check(linkId, now = Date.now()) {
      if (typeof linkId !== "string" || !linkId) return { allowed: true, retryAfterMs: 0 };
      const entry = state.get(linkId);
      if (!entry) return { allowed: true, retryAfterMs: 0 };
      if (isStale(entry, now)) {
        state.delete(linkId);
        return { allowed: true, retryAfterMs: 0 };
      }
      if (now < entry.lockedUntil) {
        return { allowed: false, retryAfterMs: entry.lockedUntil - now };
      }
      return { allowed: true, retryAfterMs: 0 };
    },

    recordFailure(linkId, now = Date.now()) {
      if (typeof linkId !== "string" || !linkId) return { failures: 0, lockedUntil: 0, retryAfterMs: 0 };
      let entry = state.get(linkId);
      if (entry && isStale(entry, now)) {
        state.delete(linkId);
        entry = undefined;
      }
      const failures = (entry?.failures ?? 0) + 1;
      let lockedUntil = entry?.lockedUntil ?? 0;
      if (failures >= attempts) {
        const exp = Math.min(30, failures - attempts);
        const delay = Math.min(maxDelay, baseDelay * (2 ** exp));
        lockedUntil = now + delay;
      }
      if (!entry && state.size >= cap) {
        const oldestKey = state.keys().next().value;
        if (oldestKey !== undefined) state.delete(oldestKey);
      } else if (entry) {
        // Refresh insertion order for LRU eviction.
        state.delete(linkId);
      }
      state.set(linkId, { failures, lockedUntil, lastFailureAt: now });
      return { failures, lockedUntil, retryAfterMs: Math.max(0, lockedUntil - now) };
    },

    reset(linkId) {
      if (typeof linkId === "string" && linkId) state.delete(linkId);
    },

    size() {
      return state.size;
    },
  };
}

/**
 * Evaluate a share link's policy (expiry, passcode, rate-limit, noDownload).
 * Accepts `passcodeHash` either on `link.passcodeHash` or via `opts.passcodeHash` so callers
 * can keep public `Link` objects completely free of hash material.
 *
 * @param {{ id?: string, revoked?: boolean, expiresAt?: number|null, hasPasscode?: boolean, passcodeHash?: string|null, noDownload?: boolean } | null | undefined} link
 * @param {{ passcode?: unknown, passcodeHash?: string|null, now?: number, rateLimiter?: LinkRateLimiter|null }} [opts]
 * @returns {{ ok: true, policy: { noDownload: boolean, expiresAt: number|null, hasPasscode: boolean } } | { ok: false, code: "expired"|"passcode-required"|"bad-passcode"|"rate-limited", retryAfterMs?: number }}
 */
export function checkLinkPolicy(link, { passcode = undefined, passcodeHash = undefined, now = Date.now(), rateLimiter = null } = {}) {
  if (!link || typeof link !== "object" || link.revoked === true) {
    return { ok: false, code: "expired" };
  }
  const expiresAt = link.expiresAt ?? null;
  if (expiresAt != null && now >= expiresAt) {
    return { ok: false, code: "expired" };
  }

  const hash = typeof passcodeHash === "string" && passcodeHash.length > 0
    ? passcodeHash
    : (typeof link.passcodeHash === "string" && link.passcodeHash.length > 0 ? link.passcodeHash : null);
  const hasPasscode = Boolean(hash || link.hasPasscode);

  if (hasPasscode) {
    const key = typeof link.id === "string" && link.id.length > 0 ? link.id : null;
    if (rateLimiter && key) {
      const rl = rateLimiter.check(key, now);
      if (!rl.allowed) {
        return { ok: false, code: "rate-limited", retryAfterMs: rl.retryAfterMs };
      }
    }
    if (passcode == null || passcode === "") {
      return { ok: false, code: "passcode-required" };
    }
    if (!hash || !verifyPasscode(passcode, hash)) {
      if (rateLimiter && key) rateLimiter.recordFailure(key, now);
      return { ok: false, code: "bad-passcode" };
    }
    if (rateLimiter && key) rateLimiter.reset(key);
  }

  return {
    ok: true,
    policy: {
      noDownload: Boolean(link.noDownload),
      expiresAt,
      hasPasscode,
    },
  };
}
