// @ts-check
// The LiveSources port (#8): server-side read-only metric (Prometheus) and
// Kubernetes state lookups for live-bound diagrams.
//   readMetric(source, query)               query a Prometheus-compatible metric source
//   readK8sObject(source, query, field?)    read-only GET of a Kubernetes API object
//   listSources()                           public source metadata (id, kind, label) — NEVER URLs or credentials
//   resolveForBoard(boardId, bindings)      batch-resolve all live bindings for a board
//
// Shared port pieces only; no adapter code and no bare packages.
// Adapters (http.js, memory.js) import this module and never import each other.

import { PortError } from "../ids.js";
import {
  MAX_QUERY_LENGTH,
  normalizeLiveBinding,
  stripSecretsFromBinding,
} from "../../packages/core/live-bindings.js";

export { MAX_QUERY_LENGTH, normalizeLiveBinding, stripSecretsFromBinding };

/** The method names every LiveSources adapter implements. */
export const LIVE_SOURCES_METHODS = Object.freeze([
  "readMetric",
  "readK8sObject",
  "listSources",
  "resolveForBoard",
]);

/**
 * Server-side live source configuration. NEVER sent to clients or viewers.
 * @typedef {{
 *   id: string,
 *   kind: "metric" | "k8s",
 *   baseUrl: string,
 *   authEnv?: string,
 *   authScheme?: "Bearer" | "Basic",
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 *   label?: string,
 * }} LiveSourceConfig
 */

/**
 * Safe metadata about a configured source that may be exposed to clients.
 * Contains no URLs, hostnames, env var names, headers, or credentials.
 * @typedef {{
 *   id: string,
 *   kind: "metric" | "k8s",
 *   label?: string,
 * }} PublicLiveSource
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   value?: number | string | boolean | null,
 *   fetchedAt: number,
 *   stale?: boolean,
 *   error?: string,
 * }} LiveSourceReading
 */

/**
 * @typedef {{
 *   elementId: string,
 *   binding: import("../../packages/core/live-bindings.js").LiveBinding,
 * }} BoardLiveBinding
 */

/**
 * @typedef {{
 *   readMetric(source: LiveSourceConfig, query: string): Promise<LiveSourceReading>,
 *   readK8sObject(source: LiveSourceConfig, query: string, field?: string): Promise<LiveSourceReading>,
 *   listSources(): PublicLiveSource[],
 *   resolveForBoard(boardId: string, bindings: readonly BoardLiveBinding[]): Promise<Record<string, LiveSourceReading>>,
 * }} LiveSourcesPort
 */

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const K8S_SEGMENT_RE = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/i;
const K8S_PATH_RE = /^\/(?:api\/v1|apis\/[a-z0-9.-]+\/[a-z0-9]+)(?:\/namespaces\/[a-z0-9-]+)?\/[a-z0-9-]+\/[a-z0-9._-]+$/i;
const ENCODED_TRAVERSAL_RE = /%(?:2e|2f|5c|00)/i;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

/** Map common shorthand k8s resource kinds to their API group prefix. */
const K8S_RESOURCE_PREFIX = Object.freeze({
  pods: "/api/v1",
  pod: "/api/v1",
  services: "/api/v1",
  service: "/api/v1",
  svc: "/api/v1",
  configmaps: "/api/v1",
  endpoints: "/api/v1",
  nodes: "/api/v1",
  persistentvolumeclaims: "/api/v1",
  pvc: "/api/v1",
  deployments: "/apis/apps/v1",
  deployment: "/apis/apps/v1",
  deploy: "/apis/apps/v1",
  statefulsets: "/apis/apps/v1",
  statefulset: "/apis/apps/v1",
  sts: "/apis/apps/v1",
  daemonsets: "/apis/apps/v1",
  daemonset: "/apis/apps/v1",
  ds: "/apis/apps/v1",
  replicasets: "/apis/apps/v1",
  replicaset: "/apis/apps/v1",
  jobs: "/apis/batch/v1",
  job: "/apis/batch/v1",
  cronjobs: "/apis/batch/v1",
  cronjob: "/apis/batch/v1",
  ingresses: "/apis/networking.k8s.io/v1",
  ingress: "/apis/networking.k8s.io/v1",
  horizontalpodautoscalers: "/apis/autoscaling/v2",
  hpa: "/apis/autoscaling/v2",
});

const K8S_PLURAL = Object.freeze({
  pod: "pods",
  service: "services",
  svc: "services",
  pvc: "persistentvolumeclaims",
  deployment: "deployments",
  deploy: "deployments",
  statefulset: "statefulsets",
  sts: "statefulsets",
  daemonset: "daemonsets",
  ds: "daemonsets",
  replicaset: "replicasets",
  job: "jobs",
  cronjob: "cronjobs",
  ingress: "ingresses",
  hpa: "horizontalpodautoscalers",
});

/**
 * Project a server-side LiveSourceConfig down to its safe public view.
 * Never includes baseUrl, authEnv, authScheme, headers, or credentials.
 * @param {LiveSourceConfig} source
 * @returns {PublicLiveSource}
 */
export function publicSourceView(source) {
  /** @type {PublicLiveSource} */
  const view = { id: source.id, kind: source.kind };
  if (typeof source.label === "string" && source.label.trim()) {
    view.label = source.label.trim().slice(0, 64);
  }
  return view;
}

/**
 * Validate and normalize a read-only Kubernetes object query into a canonical
 * `/api/v1/...` or `/apis/...` GET path. Rejects path traversal, query strings,
 * fragments, and non-resource paths.
 *
 * Accepts either:
 * - Full API path: `/api/v1/namespaces/<ns>/<kind>/<name>` or `/apis/<group>/<ver>/namespaces/<ns>/<kind>/<name>`
 * - Shorthand: `<namespace>/<kind>/<name>` (e.g. `prod/deployments/api`)
 *
 * @param {string} query
 * @returns {string}
 */
export function parseK8sQuery(query) {
  if (typeof query !== "string" || CONTROL_CHAR_RE.test(query)) {
    throw new PortError("bad-query", "invalid k8s query");
  }
  const q = query.trim();
  if (!q || q.length > MAX_QUERY_LENGTH || q.includes("..") || q.includes("?") || q.includes("#") || q.includes("\\") || ENCODED_TRAVERSAL_RE.test(q)) {
    throw new PortError("bad-query", "invalid k8s query");
  }
  if (q.startsWith("/")) {
    if (!K8S_PATH_RE.test(q)) {
      throw new PortError("bad-query", "k8s path must target a single /api/v1 or /apis resource object");
    }
    return q;
  }
  const parts = q.split("/");
  if (parts.length !== 3) {
    throw new PortError("bad-query", "k8s shorthand must be namespace/kind/name");
  }
  const [ns, rawKind, name] = parts;
  if (!K8S_SEGMENT_RE.test(ns) || !K8S_SEGMENT_RE.test(name)) {
    throw new PortError("bad-query", "invalid k8s namespace or name");
  }
  const kindKey = rawKind.toLowerCase();
  const prefix = /** @type {Record<string, string>} */ (K8S_RESOURCE_PREFIX)[kindKey];
  if (!prefix) {
    throw new PortError("bad-query", "unsupported k8s resource kind");
  }
  const plural = /** @type {Record<string, string>} */ (K8S_PLURAL)[kindKey] ?? kindKey;
  return `${prefix}/namespaces/${ns}/${plural}/${name}`;
}

/**
 * Safely extract a primitive value from a JSON object via a dotted field path
 * (e.g. `"status.readyReplicas"` or `"status.conditions.0.status"`).
 * Blocks prototype pollution segments.
 * @param {any} obj
 * @param {string | undefined} fieldPath
 * @returns {number | string | boolean | null}
 */
export function extractFieldPath(obj, fieldPath) {
  if (!obj || typeof obj !== "object") return null;
  if (!fieldPath) {
    const st = obj.status;
    if (st && typeof st === "object") {
      if (typeof st.readyReplicas === "number") return st.readyReplicas;
      if (typeof st.availableReplicas === "number") return st.availableReplicas;
      if (typeof st.phase === "string") return st.phase;
    }
    return null;
  }
  const parts = fieldPath.split(".");
  let cur = obj;
  for (const part of parts) {
    if (!part || FORBIDDEN_PATH_SEGMENTS.has(part)) return null;
    if (cur === null || typeof cur !== "object") return null;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return null;
    cur = cur[part];
  }
  if (typeof cur === "number") return Number.isFinite(cur) ? cur : null;
  if (typeof cur === "string" || typeof cur === "boolean") return cur;
  return null;
}

/**
 * Scrub secrets, auth headers, and internal URLs from any error or diagnostic text.
 * @param {unknown} input
 * @param {readonly string[]} [secrets]
 * @returns {string}
 */
export function redactSecrets(input, secrets = []) {
  let text = typeof input === "string" ? input : input instanceof Error ? input.message : String(input ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 4) {
      text = text.split(s).join("[REDACTED]");
    }
  }
  text = text
    .replace(/authorization\s*:\s*(?:bearer|basic)\s+[^\s;,"']+/gi, "Authorization: [REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{6,}/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>)]+/gi, "[REDACTED_URL]");
  return text;
}
