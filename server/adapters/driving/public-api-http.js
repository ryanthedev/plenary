// @ts-check
// Driving HTTP adapter for the versioned Public REST API (#27):
//   GET    /api/v1/boards
//   POST   /api/v1/boards
//   GET    /api/v1/boards/:id
//   GET    /api/v1/webhooks
//   POST   /api/v1/webhooks
//   DELETE /api/v1/webhooks/:id
//
// Enforces scoped Bearer token auth, per-token token-bucket rate limiting
// (429 + Retry-After), and consistent JSON error envelopes.

import {
  createRateLimiter,
  generateWebhookSecret,
  validateWebhookSubscription,
} from "../../core/webhooks.js";
import { isId } from "../../core/ids.js";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RATE_CAPACITY = 60;
const DEFAULT_RATE_REFILL_PER_SEC = 1;
const MAX_BOARD_TITLE_LENGTH = 200;

/**
 * @typedef {{
 *   tokenId?: string,
 *   tenant: string,
 *   user: string,
 *   scopes: readonly string[],
 * }} ApiTokenPrincipal
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   tenant?: string,
 *   space?: string | null,
 *   createdAt?: number | string,
 *   updatedAt?: number | string,
 * }} ApiBoardRecord
 */

/**
 * @typedef {{
 *   id: string,
 *   url: string,
 *   events: readonly import("../../core/webhooks.js").WebhookEventType[],
 *   secret: string,
 *   active?: boolean,
 *   createdAt?: number | string,
 * }} ApiWebhookRecord
 */

/**
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [extraHeaders]
 * @param {Record<string, any>} [extraFields]
 * @returns {Response}
 */
function errorResponse(status, code, message, extraHeaders = {}, extraFields = {}) {
  return json(status, { error: { code, message, ...extraFields } }, extraHeaders);
}

/**
 * Extract a Bearer token from the Authorization header, or null.
 * @param {Request} req
 * @returns {string | null}
 */
function extractBearerToken(req) {
  const raw = req.headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/**
 * Check whether the principal holds `requiredScope` (or wildcard `"*"`).
 * @param {ApiTokenPrincipal} principal
 * @param {string} requiredScope
 * @returns {boolean}
 */
function hasScope(principal, requiredScope) {
  if (!Array.isArray(principal?.scopes)) return false;
  return principal.scopes.includes("*") || principal.scopes.includes(requiredScope);
}

/**
 * Strip `secret` from a webhook record for safe listing.
 * @param {ApiWebhookRecord} sub
 */
function publicWebhookView(sub) {
  return {
    id: sub.id,
    url: sub.url,
    events: [...sub.events],
    active: sub.active !== false,
    ...(sub.createdAt !== undefined ? { createdAt: sub.createdAt } : {}),
  };
}

/**
 * Read and parse a JSON request body within `maxBytes`.
 * @param {Request} req
 * @param {number} maxBytes
 * @returns {Promise<{ ok: boolean, value?: any, status?: number, code?: string, message?: string }>}
 */
async function readJsonBody(req, maxBytes) {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader && /^\d+$/.test(lenHeader) && Number(lenHeader) > maxBytes) {
    return { ok: false, status: 413, code: "payload-too-large", message: "request body exceeds size limit" };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, status: 413, code: "payload-too-large", message: "request body exceeds size limit" };
  }
  if (!text.trim()) {
    return { ok: false, status: 400, code: "bad-json", message: "request body must be valid JSON" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, code: "bad-json", message: "request body must be valid JSON" };
  }
}

/**
 * Build the driving HTTP route handler for `/api/v1/*`.
 *
 * @param {{
 *   verifyApiToken: (token: string) => Promise<ApiTokenPrincipal | null> | ApiTokenPrincipal | null,
 *   boards: {
 *     list(principal: ApiTokenPrincipal): Promise<readonly ApiBoardRecord[]> | readonly ApiBoardRecord[],
 *     create(principal: ApiTokenPrincipal, input: { title: string, space?: string }): Promise<ApiBoardRecord> | ApiBoardRecord,
 *     get(principal: ApiTokenPrincipal, boardId: string): Promise<ApiBoardRecord | null> | ApiBoardRecord | null,
 *   },
 *   webhooks: {
 *     list(principal: ApiTokenPrincipal): Promise<readonly ApiWebhookRecord[]> | readonly ApiWebhookRecord[],
 *     create(principal: ApiTokenPrincipal, input: { url: string, events: import("../../core/webhooks.js").WebhookEventType[], secret: string, active: boolean }): Promise<ApiWebhookRecord> | ApiWebhookRecord,
 *     remove(principal: ApiTokenPrincipal, webhookId: string): Promise<boolean> | boolean,
 *   },
 *   rateLimit?: { capacity?: number, refillPerSec?: number },
 *   clock?: () => number,
 *   maxBodyBytes?: number,
 * }} opts
 */
export function publicApiRoutes({
  verifyApiToken,
  boards,
  webhooks,
  rateLimit = {},
  clock = () => Date.now(),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  const limiter = createRateLimiter({
    capacity: rateLimit.capacity ?? DEFAULT_RATE_CAPACITY,
    refillPerSec: rateLimit.refillPerSec ?? DEFAULT_RATE_REFILL_PER_SEC,
    clock,
  });

  /**
   * Handle an incoming request if it targets `/api/v1/*`, otherwise return `undefined`.
   * @param {Request} req
   * @param {URL} [parsedUrl]
   * @returns {Promise<Response | undefined>}
   */
  async function handle(req, parsedUrl) {
    const url = parsedUrl ?? new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith("/api/v1/")) return undefined;

    const token = extractBearerToken(req);
    if (!token) {
      return errorResponse(401, "unauthorized", "missing or malformed Bearer token", {
        "www-authenticate": 'Bearer realm="plenary-api"',
      });
    }

    const principal = await verifyApiToken(token);
    if (!principal) {
      return errorResponse(401, "unauthorized", "invalid or expired API token", {
        "www-authenticate": 'Bearer realm="plenary-api"',
      });
    }

    const rateKey = principal.tokenId ? `id:${principal.tokenId}` : `tok:${token}`;
    const rl = limiter.consume(rateKey, 1);
    /** @type {Record<string, string>} */
    const rateHeaders = {
      "x-ratelimit-limit": String(rl.limit),
      "x-ratelimit-remaining": String(rl.remaining),
      "x-ratelimit-reset": String(Math.ceil(rl.resetAtMs / 1000)),
    };

    if (!rl.allowed) {
      return errorResponse(
        429,
        "rate-limited",
        "API rate limit exceeded; retry later",
        { ...rateHeaders, "retry-after": String(rl.retryAfterSec) },
        { retryAfterSec: rl.retryAfterSec },
      );
    }

    // ---- /api/v1/boards ----
    if (path === "/api/v1/boards") {
      if (req.method === "GET") {
        if (!hasScope(principal, "boards:read")) {
          return errorResponse(403, "insufficient-scope", "missing required scope: boards:read", rateHeaders);
        }
        const items = await boards.list(principal);
        return json(200, { boards: items }, rateHeaders);
      }
      if (req.method === "POST") {
        if (!hasScope(principal, "boards:write")) {
          return errorResponse(403, "insufficient-scope", "missing required scope: boards:write", rateHeaders);
        }
        const parsed = await readJsonBody(req, maxBodyBytes);
        if (!parsed.ok) return errorResponse(parsed.status, parsed.code, parsed.message, rateHeaders);
        const body = parsed.value;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return errorResponse(400, "bad-request", "body must be a JSON object", rateHeaders);
        }
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title || title.length > MAX_BOARD_TITLE_LENGTH) {
          return errorResponse(400, "bad-title", `title must be 1-${MAX_BOARD_TITLE_LENGTH} characters`, rateHeaders);
        }
        const space = typeof body.space === "string" && body.space.trim() ? body.space.trim() : undefined;
        const created = await boards.create(principal, { title, ...(space ? { space } : {}) });
        return json(201, { board: created }, rateHeaders);
      }
      return errorResponse(405, "method-not-allowed", "method not allowed", { ...rateHeaders, allow: "GET, POST" });
    }

    // ---- /api/v1/boards/:id ----
    const boardMatch = /^\/api\/v1\/boards\/([^/]+)$/.exec(path);
    if (boardMatch) {
      if (req.method !== "GET") {
        return errorResponse(405, "method-not-allowed", "method not allowed", { ...rateHeaders, allow: "GET" });
      }
      if (!hasScope(principal, "boards:read")) {
        return errorResponse(403, "insufficient-scope", "missing required scope: boards:read", rateHeaders);
      }
      const boardId = decodeURIComponent(boardMatch[1]);
      if (!isId(boardId)) {
        return errorResponse(400, "bad-id", "invalid board id", rateHeaders);
      }
      const board = await boards.get(principal, boardId);
      if (!board) {
        return errorResponse(404, "not-found", "board not found", rateHeaders);
      }
      return json(200, { board }, rateHeaders);
    }

    // ---- /api/v1/webhooks ----
    if (path === "/api/v1/webhooks") {
      if (req.method === "GET") {
        if (!hasScope(principal, "webhooks:read")) {
          return errorResponse(403, "insufficient-scope", "missing required scope: webhooks:read", rateHeaders);
        }
        const items = await webhooks.list(principal);
        return json(200, { webhooks: items.map(publicWebhookView) }, rateHeaders);
      }
      if (req.method === "POST") {
        if (!hasScope(principal, "webhooks:write")) {
          return errorResponse(403, "insufficient-scope", "missing required scope: webhooks:write", rateHeaders);
        }
        const parsed = await readJsonBody(req, maxBodyBytes);
        if (!parsed.ok) return errorResponse(parsed.status, parsed.code, parsed.message, rateHeaders);
        const check = validateWebhookSubscription(parsed.value);
        if (!check.ok) {
          return errorResponse(400, check.code, check.message, rateHeaders);
        }
        const secret = check.value.secret ?? generateWebhookSecret();
        const created = await webhooks.create(principal, {
          url: check.value.url,
          events: check.value.events,
          secret,
          active: check.value.active,
        });
        return json(
          201,
          {
            webhook: {
              ...publicWebhookView(created),
              secret: created.secret,
            },
          },
          rateHeaders,
        );
      }
      return errorResponse(405, "method-not-allowed", "method not allowed", { ...rateHeaders, allow: "GET, POST" });
    }

    // ---- /api/v1/webhooks/:id ----
    const webhookMatch = /^\/api\/v1\/webhooks\/([^/]+)$/.exec(path);
    if (webhookMatch) {
      if (req.method !== "DELETE") {
        return errorResponse(405, "method-not-allowed", "method not allowed", { ...rateHeaders, allow: "DELETE" });
      }
      if (!hasScope(principal, "webhooks:write")) {
        return errorResponse(403, "insufficient-scope", "missing required scope: webhooks:write", rateHeaders);
      }
      const webhookId = decodeURIComponent(webhookMatch[1]);
      if (!isId(webhookId)) {
        return errorResponse(400, "bad-id", "invalid webhook id", rateHeaders);
      }
      const removed = await webhooks.remove(principal, webhookId);
      if (!removed) {
        return errorResponse(404, "not-found", "webhook not found", rateHeaders);
      }
      return json(200, { deleted: true, id: webhookId }, rateHeaders);
    }

    return errorResponse(404, "not-found", "unknown API v1 route", rateHeaders);
  }

  return { handle, limiter };
}
