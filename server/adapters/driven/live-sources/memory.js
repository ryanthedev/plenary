// @ts-check
// In-memory mock adapter for the LiveSources port (#8) — deterministic tests and local dev.

import { PortError } from "../../../core/ids.js";
import {
  extractFieldPath,
  normalizeLiveBinding,
  parseK8sQuery,
  publicSourceView,
} from "../../../ports/live-sources.js";

/**
 * @param {{
 *   sources?: readonly import("../../../ports/live-sources.js").LiveSourceConfig[],
 *   metrics?: Record<string, Record<string, number | string | boolean>>,
 *   k8s?: Record<string, Record<string, Record<string, any>>>,
 *   errors?: Record<string, Record<string, string>>,
 *   now?: () => number,
 * }} [opts]
 */
export function memoryLiveSources({
  sources = [],
  metrics = {},
  k8s = {},
  errors = {},
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, import("../../../ports/live-sources.js").LiveSourceConfig>} */
  const sourceMap = new Map();
  for (const s of sources) {
    if (s && typeof s.id === "string" && s.id && (s.kind === "metric" || s.kind === "k8s")) {
      sourceMap.set(s.id, s);
    }
  }

  /** @type {Map<string, Map<string, number | string | boolean>>} */
  const metricStore = new Map();
  for (const [sid, entries] of Object.entries(metrics)) {
    metricStore.set(sid, new Map(Object.entries(entries)));
  }

  /** @type {Map<string, Map<string, Record<string, any>>>} */
  const k8sStore = new Map();
  for (const [sid, entries] of Object.entries(k8s)) {
    const m = new Map();
    for (const [q, obj] of Object.entries(entries)) {
      m.set(parseK8sQuery(q), obj);
    }
    k8sStore.set(sid, m);
  }

  /** @type {Map<string, Map<string, string>>} */
  const errorStore = new Map();
  for (const [sid, entries] of Object.entries(errors)) {
    errorStore.set(sid, new Map(Object.entries(entries)));
  }

  /**
   * @param {import("../../../ports/live-sources.js").LiveSourceConfig} source
   * @param {string} query
   * @returns {Promise<import("../../../ports/live-sources.js").LiveSourceReading>}
   */
  async function readMetric(source, query) {
    const fetchedAt = now();
    const err = errorStore.get(source.id)?.get(query);
    if (err) return { ok: false, error: err, fetchedAt };
    const store = metricStore.get(source.id);
    if (!store || !store.has(query)) {
      return { ok: false, error: "no-data", fetchedAt };
    }
    return { ok: true, value: store.get(query), fetchedAt };
  }

  /**
   * @param {import("../../../ports/live-sources.js").LiveSourceConfig} source
   * @param {string} query
   * @param {string} [field]
   * @returns {Promise<import("../../../ports/live-sources.js").LiveSourceReading>}
   */
  async function readK8sObject(source, query, field) {
    const fetchedAt = now();
    const canonicalPath = parseK8sQuery(query);
    const err = errorStore.get(source.id)?.get(query) ?? errorStore.get(source.id)?.get(canonicalPath);
    if (err) return { ok: false, error: err, fetchedAt };
    const obj = k8sStore.get(source.id)?.get(canonicalPath);
    if (!obj) return { ok: false, error: "no-data", fetchedAt };
    const value = extractFieldPath(obj, field);
    if (value === null) return { ok: false, error: "no-data", fetchedAt };
    return { ok: true, value, fetchedAt };
  }

  function listSources() {
    return [...sourceMap.values()].map(publicSourceView);
  }

  /**
   * @param {string} boardId
   * @param {readonly import("../../../ports/live-sources.js").BoardLiveBinding[]} bindings
   * @returns {Promise<Record<string, import("../../../ports/live-sources.js").LiveSourceReading>>}
   */
  async function resolveForBoard(boardId, bindings) {
    if (typeof boardId !== "string" || !boardId.trim()) {
      throw new PortError("bad-id", "bad board id");
    }
    /** @type {Record<string, import("../../../ports/live-sources.js").LiveSourceReading>} */
    const out = {};
    if (!Array.isArray(bindings)) return out;

    for (const { elementId, binding } of bindings) {
      if (typeof elementId !== "string" || !elementId) continue;
      const norm = normalizeLiveBinding(binding);
      if (!norm) {
        out[elementId] = { ok: false, error: "bad-binding", fetchedAt: now() };
        continue;
      }
      const source = sourceMap.get(norm.sourceId);
      if (!source || source.kind !== norm.kind) {
        out[elementId] = { ok: false, error: "unknown-source", fetchedAt: now() };
        continue;
      }
      try {
        out[elementId] = norm.kind === "metric"
          ? await readMetric(source, norm.query)
          : await readK8sObject(source, norm.query, norm.field);
      } catch (err) {
        out[elementId] = {
          ok: false,
          error: err instanceof PortError ? err.code : "upstream-error",
          fetchedAt: now(),
        };
      }
    }
    return out;
  }

  /**
   * Test/dev helper: set a metric value.
   * @param {string} sourceId
   * @param {string} query
   * @param {number | string | boolean} value
   */
  function setMetric(sourceId, query, value) {
    let m = metricStore.get(sourceId);
    if (!m) { m = new Map(); metricStore.set(sourceId, m); }
    m.set(query, value);
  }

  /**
   * Test/dev helper: set a k8s object.
   * @param {string} sourceId
   * @param {string} query
   * @param {Record<string, any>} obj
   */
  function setK8sObject(sourceId, query, obj) {
    let m = k8sStore.get(sourceId);
    if (!m) { m = new Map(); k8sStore.set(sourceId, m); }
    m.set(parseK8sQuery(query), obj);
  }

  /**
   * Test/dev helper: simulate an error for a source + query.
   * @param {string} sourceId
   * @param {string} query
   * @param {string} code
   */
  function setError(sourceId, query, code) {
    let m = errorStore.get(sourceId);
    if (!m) { m = new Map(); errorStore.set(sourceId, m); }
    m.set(query, code);
  }

  return {
    readMetric,
    readK8sObject,
    listSources,
    resolveForBoard,
    setMetric,
    setK8sObject,
    setError,
  };
}
