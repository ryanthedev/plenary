// @ts-check
// Pure webhook validation, HMAC-SHA256 signing/verification, and token-bucket
// rate limiting (#27). Zero bare package imports — uses global WebCrypto.

export const WEBHOOK_EVENTS = Object.freeze(/** @type {const} */ ([
  "board.changed",
  "comment.added",
  "role.changed",
]));

/** @typedef {(typeof WEBHOOK_EVENTS)[number]} WebhookEventType */

const WEBHOOK_EVENT_SET = new Set(/** @type {readonly string[]} */ (WEBHOOK_EVENTS));
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const DEFAULT_TOLERANCE_SEC = 300;

const enc = new TextEncoder();

/**
 * Check whether an IPv4 dotted-quad address is private, loopback, link-local,
 * CGNAT, multicast, broadcast, or unspecified.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIpv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return true;
  if (a === 0) return true;                             // 0.0.0.0/8 (unspecified)
  if (a === 10) return true;                            // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                           // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true;     // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 168) return true;              // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true;                            // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Decode an IPv4-mapped IPv6 suffix (either dotted-quad or `xxxx:xxxx` hex form)
 * into a dotted-quad IPv4 string, or null if not IPv4-mapped.
 * @param {string} bareV6 lowercase IPv6 without brackets
 * @returns {string | null}
 */
function extractMappedIpv4(bareV6) {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bareV6);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bareV6);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

/**
 * Check whether an IPv6 literal (with or without surrounding `[...]`) is
 * loopback, unspecified, ULA, link-local, multicast, or maps to a private IPv4.
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateIpv6(host) {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare.includes(":")) return false;
  const low = bare.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (/^(?:0+:){7}0+$/.test(low) || /^(?:0+:){7}0*1$/.test(low)) return true;
  const mapped = extractMappedIpv4(low);
  if (mapped) return isPrivateIpv4(mapped);
  const firstGroup = low.split(":")[0];
  if (/^f[cd][0-9a-f]{2}$/.test(firstGroup)) return true;   // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]$/.test(firstGroup)) return true;   // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}$/.test(firstGroup)) return true;      // ff00::/8 multicast
  return false;
}

/**
 * Return true if `hostname` is a forbidden SSRF target (loopback, private IP,
 * link-local, cloud metadata, `.local`, `.internal`, or `.localhost`).
 * @param {string} hostname
 * @returns {boolean}
 */
export function isForbiddenWebhookHost(hostname) {
  if (typeof hostname !== "string" || !hostname) return true;
  const low = hostname.toLowerCase().replace(/\.+$/, "");
  if (!low) return true;
  if (
    low === "localhost" ||
    low.endsWith(".localhost") ||
    low.endsWith(".local") ||
    low.endsWith(".internal") ||
    low === "metadata.google.internal" ||
    low === "metadata.goog" ||
    low === "instance-data"
  ) {
    return true;
  }
  if (/^\d+$/.test(low) || /^0x[0-9a-f]+$/i.test(low)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(low)) return isPrivateIpv4(low);
  if (low.includes(":")) return isPrivateIpv6(low);
  if (!low.includes(".")) return true; // single-label internal hostnames
  return false;
}

/**
 * Validate a webhook target URL: HTTPS-only, no embedded credentials,
 * and SSRF host guard rejecting private/loopback/metadata hosts.
 * @param {string} rawUrl
 * @returns {{ ok: boolean, url?: string, code?: string, message?: string }}
 */
export function validateWebhookUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, code: "bad-url", message: "webhook url must be a non-empty string" };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, code: "bad-url", message: "webhook url is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, code: "https-required", message: "webhook url must use https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "forbidden-credentials", message: "webhook url must not include credentials" };
  }
  if (isForbiddenWebhookHost(parsed.hostname)) {
    return { ok: false, code: "forbidden-host", message: "webhook host is not allowed (private, loopback, or metadata address)" };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Validate a webhook subscription payload (`url`, `events`, optional `secret`).
 * @param {{ url?: unknown, events?: unknown, secret?: unknown, active?: unknown }} input
 * @param {{ requireSecret?: boolean }} [opts]
 * @returns {{
 *   ok: boolean,
 *   value?: { url: string, events: WebhookEventType[], secret?: string, active: boolean },
 *   code?: string,
 *   message?: string,
 * }}
 */
export function validateWebhookSubscription(input, { requireSecret = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "bad-request", message: "webhook subscription must be an object" };
  }
  const urlCheck = validateWebhookUrl(/** @type {string} */ (input.url));
  if (!urlCheck.ok) return { ok: false, code: urlCheck.code, message: urlCheck.message };

  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, code: "bad-events", message: "events must be a non-empty array" };
  }
  /** @type {WebhookEventType[]} */
  const events = [];
  const seen = new Set();
  for (const ev of input.events) {
    if (typeof ev !== "string" || !WEBHOOK_EVENT_SET.has(ev)) {
      return {
        ok: false,
        code: "bad-events",
        message: `unsupported webhook event "${String(ev)}"; allowed: ${WEBHOOK_EVENTS.join(", ")}`,
      };
    }
    if (!seen.has(ev)) {
      seen.add(ev);
      events.push(/** @type {WebhookEventType} */ (ev));
    }
  }

  /** @type {string | undefined} */
  let secret;
  if (input.secret !== undefined) {
    if (typeof input.secret !== "string" || input.secret.length < MIN_SECRET_LENGTH || input.secret.length > MAX_SECRET_LENGTH) {
      return {
        ok: false,
        code: "bad-secret",
        message: `secret must be a string between ${MIN_SECRET_LENGTH} and ${MAX_SECRET_LENGTH} characters`,
      };
    }
    secret = input.secret;
  } else if (requireSecret) {
    return { ok: false, code: "bad-secret", message: "webhook secret is required" };
  }

  const active = input.active === undefined ? true : Boolean(input.active);
  return {
    ok: true,
    value: {
      url: urlCheck.url,
      events,
      ...(secret !== undefined ? { secret } : {}),
      active,
    },
  };
}

/**
 * Generate a 32-byte cryptographically random webhook signing secret (`whsec_<hex>`).
 * @returns {string}
 */
export function generateWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "whsec_" + bytesToHex(bytes);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Constant-time comparison of two UTF-8 strings (compares all bytes without early exit).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

/**
 * Compute lowercase hex HMAC-SHA256 using global WebCrypto.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Sign a webhook payload body using HMAC-SHA256.
 * Returns header value `t=<unixSec>,v1=<hex>`.
 *
 * @param {string} secret
 * @param {number | string} timestamp Unix epoch seconds
 * @param {string} body Raw request body string
 * @returns {Promise<string>}
 */
export async function signWebhookPayload(secret, timestamp, body) {
  if (typeof secret !== "string" || !secret) {
    throw new TypeError("webhook secret must be a non-empty string");
  }
  const tsNum = typeof timestamp === "number" ? Math.floor(timestamp) : Number(timestamp);
  if (!Number.isSafeInteger(tsNum) || tsNum < 0) {
    throw new TypeError("webhook timestamp must be a non-negative integer (unix seconds)");
  }
  const rawBody = typeof body === "string" ? body : String(body ?? "");
  const digest = await hmacSha256Hex(secret, `${tsNum}.${rawBody}`);
  return `t=${tsNum},v1=${digest}`;
}

/**
 * Verify a `t=<unixSec>,v1=<hex>` webhook signature header in constant time,
 * checking the replay tolerance window.
 *
 * @param {string} secret
 * @param {string} body
 * @param {string} sigHeader
 * @param {{ nowSec?: number, toleranceSec?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature(
  secret,
  body,
  sigHeader,
  { nowSec = Math.floor(Date.now() / 1000), toleranceSec = DEFAULT_TOLERANCE_SEC } = {},
) {
  if (typeof secret !== "string" || !secret) return false;
  if (typeof body !== "string" || typeof sigHeader !== "string" || !sigHeader) return false;

  /** @type {string | null} */
  let tsStr = null;
  /** @type {string[]} */
  const v1Sigs = [];
  for (const part of sigHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) tsStr = v;
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1Sigs.push(v.toLowerCase());
  }
  if (!tsStr || v1Sigs.length === 0) return false;

  const tsNum = Number(tsStr);
  if (!Number.isSafeInteger(tsNum)) return false;
  if (toleranceSec > 0 && Math.abs(nowSec - tsNum) > toleranceSec) return false;

  const expected = await hmacSha256Hex(secret, `${tsNum}.${body}`);
  let matched = false;
  for (const candidate of v1Sigs) {
    if (constantTimeEqual(expected, candidate)) matched = true;
  }
  return matched;
}

/**
 * @typedef {{
 *   allowed: boolean,
 *   limit: number,
 *   remaining: number,
 *   retryAfterSec: number,
 *   resetAtMs: number,
 * }} RateLimitResult
 */

/**
 * Pure token-bucket rate limiter with injectable clock.
 *
 * @param {{
 *   capacity: number,
 *   refillPerSec: number,
 *   clock?: () => number,
 *   maxKeys?: number,
 * }} opts
 */
export function createRateLimiter({
  capacity,
  refillPerSec,
  clock = () => Date.now(),
  maxKeys = 10_000,
}) {
  if (!(typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0)) {
    throw new RangeError("capacity must be a positive number");
  }
  if (!(typeof refillPerSec === "number" && Number.isFinite(refillPerSec) && refillPerSec > 0)) {
    throw new RangeError("refillPerSec must be a positive number");
  }

  /** @type {Map<string, { tokens: number, lastMs: number }>} */
  const buckets = new Map();

  /**
   * @param {string} key
   * @param {number} nowMs
   */
  function getRefilled(key, nowMs) {
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
      bucket = { tokens: capacity, lastMs: nowMs };
      buckets.set(key, bucket);
      return bucket;
    }
    if (nowMs > bucket.lastMs) {
      const elapsedSec = (nowMs - bucket.lastMs) / 1000;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
      bucket.lastMs = nowMs;
    }
    return bucket;
  }

  /**
   * Attempt to consume `cost` tokens for `key`.
   * @param {string} key
   * @param {number} [cost]
   * @returns {RateLimitResult}
   */
  function consume(key, cost = 1) {
    const nowMs = clock();
    const bucket = getRefilled(String(key), nowMs);
    const fullRefillMs = Math.ceil(((capacity - bucket.tokens) / refillPerSec) * 1000);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      const afterFullMs = Math.ceil(((capacity - bucket.tokens) / refillPerSec) * 1000);
      return {
        allowed: true,
        limit: capacity,
        remaining: Math.floor(bucket.tokens),
        retryAfterSec: 0,
        resetAtMs: nowMs + afterFullMs,
      };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / refillPerSec));
    return {
      allowed: false,
      limit: capacity,
      remaining: Math.floor(bucket.tokens),
      retryAfterSec,
      resetAtMs: nowMs + fullRefillMs,
    };
  }

  /**
   * Inspect current remaining tokens without consuming.
   * @param {string} key
   * @returns {number}
   */
  function remaining(key) {
    const bucket = buckets.get(String(key));
    if (!bucket) return capacity;
    const nowMs = clock();
    const elapsedSec = Math.max(0, (nowMs - bucket.lastMs) / 1000);
    return Math.floor(Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec));
  }

  /**
   * Reset one key or all keys.
   * @param {string} [key]
   */
  function reset(key) {
    if (key === undefined) buckets.clear();
    else buckets.delete(String(key));
  }

  return { consume, remaining, reset };
}
