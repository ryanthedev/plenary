// @ts-check
// HTTP adapter for the LiveSources port (#8):
// - Prometheus instant-query API (`GET <baseUrl>/api/v1/query?query=...`)
// - Kubernetes API Server read-only GET (`GET <baseUrl>/api/v1/...` or `/apis/...`)
//
// Security invariants:
// - Credentials come strictly from server-side `env[source.authEnv]`, never from bindings or requests.
// - Outbound URLs must match `allowHosts` (SSRF protection), block metadata/link-local IPs,
//   disallow embedded userinfo, disallow redirects, and default to `https:`.
// - Every request enforces a hard timeout and streaming response size cap.
// - Every error is redacted so secrets, headers, and upstream URLs never leak.

import { PortError } from "../ids.js";
import {
  extractFieldPath,
  normalizeLiveBinding,
  parseK8sQuery,
  publicSourceView,
  redactSecrets,
} from "./port.js";

export const DEFAULT_TIMEOUT_MS = 3_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_MAX_BINDINGS_PER_BOARD = 64;

/** Always-blocked metadata / link-local / unspecified hosts even if matched by wildcard. */
const BLOCKED_HOST_RE = /^(?:0\.0\.0\.0|169\.254\.\d{1,3}\.\d{1,3}|\[?::\]?|\[?fe80:.*\]?|\[?fd00:.*\]?|metadata\.google\.internal)$/i;

/**
 * Check if `hostname` (and optional `host` with port) matches an entry in `allowHosts`.
 * Supports exact host (`prom.internal`, `prom.internal:9090`) and wildcard subdomain (`*.corp.example`).
 * @param {URL} url
 * @param {readonly string[]} allowHosts
 * @returns {boolean}
 */
function isHostAllowed(url, allowHosts) {
  if (!Array.isArray(allowHosts) || allowHosts.length === 0) return false;
  const hostname = url.hostname.toLowerCase();
  const hostPort = url.host.toLowerCase();
  if (BLOCKED_HOST_RE.test(hostname)) return false;

  for (const raw of allowHosts) {
    if (typeof raw !== "string") continue;
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
    } else if (rule.includes(":")) {
      if (hostPort === rule) return true;
    } else {
      if (hostname === rule) return true;
    }
  }
  return false;
}

/**
 * Validate a source's baseUrl against scheme, userinfo, and host allow-list rules.
 * @param {string} rawUrl
 * @param {readonly string[]} allowHosts
 * @param {boolean} allowInsecureHttp
 * @returns {URL}
 */
function validateSourceUrl(rawUrl, allowHosts, allowInsecureHttp) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PortError("bad-source-url", "invalid live source url");
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new PortError("forbidden-scheme", "live source must use https");
  }
  if (url.username || url.password) {
    throw new PortError("forbidden-credentials", "live source url must not contain embedded credentials");
  }
  if (!isHostAllowed(url, allowHosts)) {
    throw new PortError("forbidden-host", "live source host is not allow-listed");
  }
  return url;
}

/**
 * Read a Response body as UTF-8 text while enforcing a hard byte cap.
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readCappedText(res, maxBytes) {
  const rawLen = res.headers.get("content-length");
  if (rawLen && /^\d+$/.test(rawLen) && Number(rawLen) > maxBytes) {
    if (res.body) res.body.cancel().catch(() => {});
    throw new PortError("too-large", "live source response exceeded size cap");
  }
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new PortError("too-large", "live source response exceeded size cap");
    }
    return text;
  }
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new PortError("too-large", "live source response exceeded size cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

/**
 * Parse a Prometheus `/api/v1/query` JSON response into a finite number or null.
 * @param {any} payload
 * @returns {number | null}
 */
function parsePrometheusValue(payload) {
  if (!payload || typeof payload !== "object" || payload.status !== "success") return null;
  const data = payload.data;
  if (!data || typeof data !== "object") return null;
  let rawVal;
  if (data.resultType === "vector" && Array.isArray(data.result) && data.result.length > 0) {
    rawVal = data.result[0]?.value?.[1];
  } else if (data.resultType === "scalar" && Array.isArray(data.result) && data.result.length >= 2) {
    rawVal = data.result[1];
  } else {
    return null;
  }
  const num = Number(rawVal);
  return Number.isFinite(num) ? num : null;
}

/**
 * @param {{
 *   sources?: readonly import("./port.js").LiveSourceConfig[],
 *   allowHosts?: readonly string[],
 *   allowInsecureHttp?: boolean,
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   defaultTimeoutMs?: number,
 *   defaultMaxResponseBytes?: number,
 *   maxBindingsPerBoard?: number,
 *   now?: () => number,
 * }} [opts]
 * @returns {import("./port.js").LiveSourcesPort}
 */
export function httpLiveSources({
  sources = [],
  allowHosts = [],
  allowInsecureHttp = false,
  env = process.env,
  fetchImpl = fetch,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultMaxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxBindingsPerBoard = DEFAULT_MAX_BINDINGS_PER_BOARD,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, import("./port.js").LiveSourceConfig>} */
  const sourceMap = new Map();
  for (const s of sources) {
    if (s && typeof s.id === "string" && s.id && (s.kind === "metric" || s.kind === "k8s")) {
      sourceMap.set(s.id, s);
    }
  }

  /**
   * Resolve auth token and collect secrets to redact for a given source.
   * @param {import("./port.js").LiveSourceConfig} source
   */
  function authHeadersAndSecrets(source) {
    /** @type {Record<string, string>} */
    const headers = { accept: "application/json" };
    /** @type {string[]} */
    const secrets = [];

    if (source.headers && typeof source.headers === "object") {
      for (const [k, v] of Object.entries(source.headers)) {
        if (typeof v === "string") {
          headers[k] = v;
          if (/auth|token|key|secret|cookie/i.test(k)) secrets.push(v);
        }
      }
    }

    if (typeof source.authEnv === "string" && source.authEnv.trim()) {
      const token = env?.[source.authEnv.trim()];
      if (typeof token === "string" && token.length > 0) {
        const scheme = source.authScheme === "Basic" ? "Basic" : "Bearer";
        headers.authorization = `${scheme} ${token}`;
        secrets.push(token);
      }
    }

    if (typeof source.baseUrl === "string" && source.baseUrl) {
      secrets.push(source.baseUrl);
    }

    return { headers, secrets };
  }

  /**
   * Perform a bounded, allow-listed, read-only GET JSON request.
   * @param {import("./port.js").LiveSourceConfig} source
   * @param {URL} targetUrl
   * @returns {Promise<any>}
   */
  async function getJson(source, targetUrl) {
    validateSourceUrl(targetUrl.toString(), allowHosts, allowInsecureHttp);
    const { headers, secrets } = authHeadersAndSecrets(source);
    const timeoutMs = typeof source.timeoutMs === "number" && source.timeoutMs > 0 ? source.timeoutMs : defaultTimeoutMs;
    const maxBytes = typeof source.maxResponseBytes === "number" && source.maxResponseBytes > 0 ? source.maxResponseBytes : defaultMaxResponseBytes;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(targetUrl.toString(), {
        method: "GET",
        headers,
        redirect: "error",
        signal: ctl.signal,
      });
      if (!res.ok) {
        if (res.body) res.body.cancel().catch(() => {});
        throw new PortError("upstream-error", `upstream status ${res.status}`);
      }
      const text = await readCappedText(res, maxBytes);
      try {
        return JSON.parse(text);
      } catch {
        throw new PortError("bad-response", "upstream returned invalid json");
      }
    } catch (err) {
      if (err instanceof PortError) {
        throw new PortError(err.code, redactSecrets(err.message, secrets));
      }
      if (ctl.signal.aborted) {
        throw new PortError("timeout", "live source request timed out");
      }
      throw new PortError("upstream-error", redactSecrets(err, secrets));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {import("./port.js").LiveSourceConfig} source
   * @param {string} query
   * @returns {Promise<import("./port.js").LiveSourceReading>}
   */
  async function readMetric(source, query) {
    const fetchedAt = now();
    const base = validateSourceUrl(source.baseUrl, allowHosts, allowInsecureHttp);
    const cleanBase = base.toString().replace(/\/+$/, "");
    const target = new URL(`${cleanBase}/api/v1/query`);
    target.searchParams.set("query", query);
    const payload = await getJson(source, target);
    const value = parsePrometheusValue(payload);
    if (value === null) {
      return { ok: false, error: "no-data", fetchedAt };
    }
    return { ok: true, value, fetchedAt };
  }

  /**
   * @param {import("./port.js").LiveSourceConfig} source
   * @param {string} query
   * @param {string} [field]
   * @returns {Promise<import("./port.js").LiveSourceReading>}
   */
  async function readK8sObject(source, query, field) {
    const fetchedAt = now();
    const base = validateSourceUrl(source.baseUrl, allowHosts, allowInsecureHttp);
    const k8sPath = parseK8sQuery(query);
    const cleanBase = base.toString().replace(/\/+$/, "");
    const target = new URL(`${cleanBase}${k8sPath}`);
    const payload = await getJson(source, target);
    const value = extractFieldPath(payload, field);
    if (value === null) {
      return { ok: false, error: "no-data", fetchedAt };
    }
    return { ok: true, value, fetchedAt };
  }

  function listSources() {
    return [...sourceMap.values()].map(publicSourceView);
  }

  /**
   * @param {string} boardId
   * @param {readonly import("./port.js").BoardLiveBinding[]} bindings
   * @returns {Promise<Record<string, import("./port.js").LiveSourceReading>>}
   */
  async function resolveForBoard(boardId, bindings) {
    if (typeof boardId !== "string" || !boardId.trim()) {
      throw new PortError("bad-id", "bad board id");
    }
    /** @type {Record<string, import("./port.js").LiveSourceReading>} */
    const out = {};
    if (!Array.isArray(bindings) || bindings.length === 0) return out;

    const capped = bindings.slice(0, maxBindingsPerBoard);
    /** @type {Map<string, Promise<import("./port.js").LiveSourceReading>>} */
    const inflight = new Map();

    await Promise.all(
      capped.map(async ({ elementId, binding }) => {
        if (typeof elementId !== "string" || !elementId) return;
        const norm = normalizeLiveBinding(binding);
        if (!norm) {
          out[elementId] = { ok: false, error: "bad-binding", fetchedAt: now() };
          return;
        }
        const source = sourceMap.get(norm.sourceId);
        if (!source || source.kind !== norm.kind) {
          out[elementId] = { ok: false, error: "unknown-source", fetchedAt: now() };
          return;
        }

        const dedupeKey = `${norm.sourceId}\0${norm.kind}\0${norm.query}\0${norm.field ?? ""}`;
        let promise = inflight.get(dedupeKey);
        if (!promise) {
          promise = (norm.kind === "metric"
            ? readMetric(source, norm.query)
            : readK8sObject(source, norm.query, norm.field)
          ).catch(err => ({
            ok: false,
            error: err instanceof PortError ? err.code : "upstream-error",
            fetchedAt: now(),
          }));
          inflight.set(dedupeKey, promise);
        }
        out[elementId] = await promise;
      }),
    );

    return out;
  }

  return { readMetric, readK8sObject, listSources, resolveForBoard };
}
