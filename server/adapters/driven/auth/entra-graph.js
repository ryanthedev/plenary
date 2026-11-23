// @ts-check
// Driven adapter for the EntraDirectory port (#87): Microsoft Graph API + Entra OAuth2 client credentials.
//
// Security properties:
// - Strict host allow-list: ONLY https://login.microsoftonline.com (token) and https://graph.microsoft.com (Graph + @odata.nextLink).
// - No port overrides, no userinfo, no redirects (`redirect: "error"`).
// - Pagination is capped (`maxPages`) and cycle-guarded (`seenUrls`) to prevent runaway loops.
// - Per-request timeout enforced via AbortController + timer race.
// - Client secret and access tokens are redacted from every error message.

import { ENTRA_DIRECTORY_METHODS } from "../../../ports/entra-directory.js";

const LOGIN_HOST = "login.microsoftonline.com";
const GRAPH_HOST = "graph.microsoft.com";
const TENANT_ID_RE = /^[A-Za-z0-9.-]{1,128}$/;
const GROUP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Validate that `rawUrl` uses HTTPS and targets the exact allowed hostname with no port or credentials.
 * @param {string} rawUrl
 * @param {string} expectedHost
 * @returns {string}
 */
function assertAllowedUrl(rawUrl, expectedHost) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error(`entra-graph: malformed URL`), { code: "disallowed-host" });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== expectedHost ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw Object.assign(
      new Error(`entra-graph: disallowed URL host "${parsed.hostname}" (expected https://${expectedHost})`),
      { code: "disallowed-host" },
    );
  }
  return parsed.href;
}

/**
 * Redact secrets from any error message before surfacing it.
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function redact(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[REDACTED]");
    const encoded = encodeURIComponent(s);
    if (encoded && encoded !== s) {
      out = out.split(encoded).join("[REDACTED]");
    }
  }
  return out;
}

/**
 * Create a Microsoft Graph implementation of `EntraDirectoryPort`.
 *
 * @param {{
 *   tenantId: string,
 *   clientId: string,
 *   clientSecret: string,
 *   fetch?: typeof globalThis.fetch,
 *   timeoutMs?: number,
 *   maxPages?: number,
 *   now?: () => number,
 * }} config
 * @returns {import("../../../ports/entra-directory.js").EntraDirectoryPort}
 */
export function entraGraphDirectory({
  tenantId,
  clientId,
  clientSecret,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPages = DEFAULT_MAX_PAGES,
  now = Date.now,
}) {
  if (typeof tenantId !== "string" || !TENANT_ID_RE.test(tenantId.trim())) {
    throw new Error("entra-graph: tenantId must be a valid Entra tenant ID or domain");
  }
  if (typeof clientId !== "string" || !clientId.trim()) {
    throw new Error("entra-graph: clientId is required");
  }
  if (typeof clientSecret !== "string" || !clientSecret) {
    throw new Error("entra-graph: clientSecret is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("entra-graph: fetch implementation is required");
  }
  const cleanTenant = tenantId.trim();
  const cleanClientId = clientId.trim();
  const reqTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const defaultMaxPages = Number.isInteger(maxPages) && maxPages > 0 ? Math.min(maxPages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;

  const tokenUrl = assertAllowedUrl(
    `https://${LOGIN_HOST}/${encodeURIComponent(cleanTenant)}/oauth2/v2.0/token`,
    LOGIN_HOST,
  );

  /** @type {{ token: string, expiresAt: number } | null} */
  let cachedToken = null;

  const activeSecrets = () => (cachedToken?.token ? [clientSecret, cachedToken.token] : [clientSecret]);

  /**
   * Perform a bounded, host-validated fetch with timeout and secret redaction.
   * @param {string} url
   * @param {string} expectedHost
   * @param {RequestInit} init
   * @returns {Promise<Response>}
   */
  async function guardedFetch(url, expectedHost, init) {
    const safeUrl = assertAllowedUrl(url, expectedHost);
    const controller = new AbortController();
    /** @type {any} */
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error(`entra-graph: request timed out after ${reqTimeoutMs}ms`), { code: "timeout" }));
      }, reqTimeoutMs);
    });

    try {
      const response = await Promise.race([
        fetchImpl(safeUrl, { ...init, signal: controller.signal, redirect: "error" }),
        timeoutPromise,
      ]);
      return response;
    } catch (err) {
      if (err?.code === "timeout" || err?.code === "disallowed-host") throw err;
      const msg = redact(err?.message ?? String(err), activeSecrets());
      const wrapped = new Error(`entra-graph: request failed: ${msg}`);
      if (err?.name === "AbortError") /** @type {any} */ (wrapped).code = "timeout";
      throw wrapped;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Acquire (or reuse cached) OAuth2 client-credentials access token for Microsoft Graph.
   * @returns {Promise<string>}
   */
  async function getAccessToken() {
    if (cachedToken && now() + TOKEN_REFRESH_SKEW_MS < cachedToken.expiresAt) {
      return cachedToken.token;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cleanClientId,
      client_secret: clientSecret,
      scope: `https://${GRAPH_HOST}/.default`,
    }).toString();

    const res = await guardedFetch(tokenUrl, LOGIN_HOST, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });

    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch {}
      const safeDetail = redact(detail.slice(0, 300), activeSecrets());
      throw Object.assign(
        new Error(`entra-graph: token acquisition failed (HTTP ${res.status})${safeDetail ? `: ${safeDetail}` : ""}`),
        { code: "token-error", status: res.status },
      );
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw Object.assign(new Error("entra-graph: invalid JSON from token endpoint"), { code: "token-error" });
    }

    if (!data || typeof data.access_token !== "string" || !data.access_token) {
      throw Object.assign(new Error("entra-graph: token response missing access_token"), { code: "token-error" });
    }

    const expiresInSec = Number(data.expires_in);
    const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 3600_000;
    cachedToken = { token: data.access_token, expiresAt: now() + ttlMs };
    return cachedToken.token;
  }

  /**
   * Fetch all pages of a Graph collection endpoint with strict nextLink host checking and page cap.
   * @param {string} initialUrl
   * @param {number} pageLimit
   * @returns {Promise<any[]>}
   */
  async function fetchPaginated(initialUrl, pageLimit) {
    const token = await getAccessToken();
    /** @type {any[]} */
    const items = [];
    /** @type {string | null} */
    let nextUrl = assertAllowedUrl(initialUrl, GRAPH_HOST);
    const seenUrls = new Set();
    let pages = 0;

    while (nextUrl && pages < pageLimit) {
      if (seenUrls.has(nextUrl)) break;
      seenUrls.add(nextUrl);
      pages++;

      const res = await guardedFetch(nextUrl, GRAPH_HOST, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      });

      if (!res.ok) {
        let detail = "";
        try { detail = await res.text(); } catch {}
        const safeDetail = redact(detail.slice(0, 300), activeSecrets());
        throw Object.assign(
          new Error(`entra-graph: Graph API request failed (HTTP ${res.status})${safeDetail ? `: ${safeDetail}` : ""}`),
          { code: "graph-error", status: res.status },
        );
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw Object.assign(new Error("entra-graph: invalid JSON from Graph API"), { code: "graph-error" });
      }

      if (Array.isArray(data?.value)) {
        items.push(...data.value);
      }

      const rawNext = data?.["@odata.nextLink"];
      if (typeof rawNext === "string" && rawNext.trim()) {
        // Strictly validate EVERY nextLink against graph.microsoft.com before following it.
        nextUrl = assertAllowedUrl(rawNext.trim(), GRAPH_HOST);
      } else {
        nextUrl = null;
      }
    }

    return items;
  }

  const resolvePageLimit = opts => {
    const n = opts?.maxPages;
    return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGES_CAP) : defaultMaxPages;
  };

  /** @type {import("../../../ports/entra-directory.js").EntraDirectoryPort} */
  const adapter = {
    async listGroups(opts) {
      const raw = await fetchPaginated(
        `https://${GRAPH_HOST}/v1.0/groups?$select=id,displayName,description,mail`,
        resolvePageLimit(opts),
      );
      return raw
        .filter(g => g && typeof g.id === "string" && g.id)
        .map(g => ({
          id: String(g.id),
          displayName: typeof g.displayName === "string" ? g.displayName : String(g.id),
          description: typeof g.description === "string" ? g.description : null,
          mail: typeof g.mail === "string" ? g.mail : null,
        }));
    },

    async listGroupMembers(groupId, opts) {
      if (typeof groupId !== "string" || !GROUP_ID_RE.test(groupId.trim())) {
        throw new Error("entra-graph: invalid groupId");
      }
      const raw = await fetchPaginated(
        `https://${GRAPH_HOST}/v1.0/groups/${encodeURIComponent(groupId.trim())}/members?$select=id,displayName,mail,userPrincipalName`,
        resolvePageLimit(opts),
      );
      return raw
        .filter(m => m && typeof m.id === "string" && m.id)
        .map(m => ({
          id: String(m.id),
          displayName: typeof m.displayName === "string" ? m.displayName : null,
          mail: typeof m.mail === "string" ? m.mail : null,
          userPrincipalName: typeof m.userPrincipalName === "string" ? m.userPrincipalName : null,
        }));
    },
  };

  // Sanity reference to port contract constant.
  void ENTRA_DIRECTORY_METHODS;
  return adapter;
}
