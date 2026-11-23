// @ts-check
// Driving HTTP route handler helper for live diagram values (#8).
// Evaluates board live bindings for an authenticated viewer/presenter/editor
// without ever exposing source URLs, headers, authEnv names, or credentials,
// and without mutating board elements or writing to the op log.

import {
  collectBoardLiveBindings,
  evaluateLiveBinding,
} from "../../../packages/core/live-bindings.js";

const VIEWER_ROLES = new Set(["viewer", "commenter", "presenter", "editor", "admin", "owner"]);

const SAFE_ERROR_CODES = new Set([
  "no-data",
  "unknown-source",
  "bad-binding",
  "bad-query",
  "timeout",
  "too-large",
  "forbidden-host",
  "forbidden-scheme",
  "upstream-error",
  "bad-response",
]);

/**
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
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
 * @param {string | undefined} code
 * @returns {string}
 */
function safeErrorCode(code) {
  return typeof code === "string" && SAFE_ERROR_CODES.has(code) ? code : "source-unavailable";
}

/**
 * Pure route handler helper for `GET /boards/:boardId/live-values`.
 *
 * @param {{
 *   req: Request,
 *   boardId: string,
 *   role: string | null | undefined,
 *   elements: readonly any[],
 *   liveSources: import("../../ports/live-sources.js").LiveSourcesPort,
 *   now?: () => number,
 *   staleAfterMs?: number,
 * }} opts
 * @returns {Promise<Response>}
 */
export async function handleLiveValuesRequest({
  req,
  boardId,
  role,
  elements,
  liveSources,
  now = () => Date.now(),
  staleAfterMs,
}) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
  }
  if (!role || typeof role !== "string") {
    return json(401, { error: "unauthorized" });
  }
  if (!VIEWER_ROLES.has(role.toLowerCase())) {
    return json(403, { error: "forbidden" });
  }
  if (typeof boardId !== "string" || !boardId.trim()) {
    return json(400, { error: "bad-board-id" });
  }

  const ts = now();
  const bindings = collectBoardLiveBindings(elements);
  if (bindings.length === 0) {
    return req.method === "HEAD"
      ? new Response(null, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } })
      : json(200, { boardId, fetchedAt: ts, values: {} });
  }

  const readings = await liveSources.resolveForBoard(boardId, bindings);

  /** @type {Record<string, { ok: boolean, value?: number | string | boolean | null, fetchedAt: number, error?: string, overlay: import("../../../packages/core/live-bindings.js").LiveOverlay }>} */
  const values = {};

  for (const { elementId, binding } of bindings) {
    const reading = readings[elementId];
    const overlay = evaluateLiveBinding(binding, reading, { now: ts, staleAfterMs });
    if (reading && reading.ok) {
      values[elementId] = {
        ok: true,
        value: reading.value,
        fetchedAt: reading.fetchedAt,
        overlay,
      };
    } else {
      values[elementId] = {
        ok: false,
        fetchedAt: reading?.fetchedAt ?? ts,
        error: safeErrorCode(reading?.error),
        overlay,
      };
    }
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return json(200, { boardId, fetchedAt: ts, values });
}

/**
 * Pure route handler helper for `GET /live-sources` — returns only public
 * source metadata (`id`, `kind`, `label`), never URLs, headers, or credentials.
 *
 * @param {{
 *   req: Request,
 *   role: string | null | undefined,
 *   liveSources: import("../../ports/live-sources.js").LiveSourcesPort,
 * }} opts
 * @returns {Response}
 */
export function handleLiveSourcesListRequest({ req, role, liveSources }) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(405, { error: "method-not-allowed" }, { allow: "GET, HEAD" });
  }
  if (!role || typeof role !== "string") {
    return json(401, { error: "unauthorized" });
  }
  if (!VIEWER_ROLES.has(role.toLowerCase())) {
    return json(403, { error: "forbidden" });
  }
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return json(200, { sources: liveSources.listSources() });
}
