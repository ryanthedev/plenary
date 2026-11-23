// @ts-check
// Pure live-binding schema, secret-stripping normalization, and ephemeral render
// overlay evaluation for diagrams bound to metrics and Kubernetes state (#8).
// Strictly pure: no DOM, Node, Bun, or host globals. Never mutates elements or writes ops.

export const LIVE_BINDING_KINDS = Object.freeze(["metric", "k8s"]);
export const LIVE_THRESHOLD_OPS = Object.freeze([">", ">=", "<", "<=", "==", "!="]);
export const LIVE_STATUSES = Object.freeze(["ok", "warn", "crit", "unknown"]);

export const MAX_SOURCE_ID_LENGTH = 64;
export const MAX_QUERY_LENGTH = 512;
export const MAX_FIELD_LENGTH = 128;
export const MAX_UNIT_LENGTH = 24;
export const MAX_LABEL_TEMPLATE_LENGTH = 128;
export const MAX_BADGE_LENGTH = 32;
export const MAX_THRESHOLDS = 16;
export const MIN_REFRESH_MS = 5_000;
export const MAX_REFRESH_MS = 300_000;
export const DEFAULT_REFRESH_MS = 15_000;
export const DEFAULT_STALE_MS = 45_000;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_CHAR_GLOBAL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR_RE = /^(?:rgba?|hsla?)\(\s*[0-9.%,\s/+-]+\s*\)$/i;
const NAMED_COLOR_RE = /^[a-zA-Z]{3,20}$/;
const FIELD_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Keys that must never live in element.customData.liveBinding or reach viewers. */
const SECRET_KEYS = new Set([
  "token",
  "apikey",
  "api_key",
  "password",
  "passwd",
  "secret",
  "secrets",
  "auth",
  "authenv",
  "auth_env",
  "authscheme",
  "auth_scheme",
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "header",
  "headers",
  "credential",
  "credentials",
  "clientsecret",
  "client_secret",
  "privatekey",
  "private_key",
  "cert",
  "ca",
  "kubeconfig",
  "serviceaccounttoken",
  "url",
  "baseurl",
  "base_url",
  "endpoint",
  "host",
  "hostname",
  "username",
  "user",
]);

/** Patterns indicating inline credentials inside a query or string value. */
const INLINE_SECRET_RE = /(?:^|[\s;,"'])(?:authorization\s*:|bearer\s+[a-z0-9._~+/=-]{6,}|basic\s+[a-z0-9+/=]{6,})|[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@|(?:^|[?&\s;,])(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*=\s*[^\s&;,"']+/i;

const INLINE_SECRET_GLOBAL_RE = /(?:authorization\s*:\s*(?:bearer|basic)\s+[^\s;,"']+|(?:bearer|basic)\s+[a-z0-9._~+/=-]{6,}|[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@|(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*=\s*[^\s&;,"']+)/gi;

const CRIT_BADGE_RE = /\b(?:crit|critical|err|error|fail|failed|down|crash|alert|oom)\b/i;
const WARN_BADGE_RE = /\b(?:warn|warning|degraded|slow|pending|high|elevated)\b/i;
const OK_BADGE_RE = /\b(?:ok|healthy|ready|running|up|normal|good)\b/i;

/**
 * @typedef {"metric" | "k8s"} LiveBindingKind
 * @typedef {">" | ">=" | "<" | "<=" | "==" | "!="} LiveThresholdOp
 * @typedef {"ok" | "warn" | "crit" | "unknown"} LiveStatus
 *
 * @typedef {{
 *   op: LiveThresholdOp,
 *   value: number | string | boolean,
 *   strokeColor?: string,
 *   backgroundColor?: string,
 *   badge?: string,
 *   status?: LiveStatus,
 * }} LiveThreshold
 *
 * @typedef {{
 *   sourceId: string,
 *   kind: LiveBindingKind,
 *   query: string,
 *   field?: string,
 *   unit?: string,
 *   labelTemplate?: string,
 *   thresholds?: LiveThreshold[],
 *   refreshMs?: number,
 * }} LiveBinding
 *
 * @typedef {{
 *   ok?: boolean,
 *   value?: number | string | boolean | null,
 *   fetchedAt?: number,
 *   stale?: boolean,
 *   unit?: string,
 *   error?: string,
 * }} LiveReading
 *
 * @typedef {{
 *   strokeColor?: string,
 *   backgroundColor?: string,
 *   badgeText?: string,
 *   labelSuffix?: string,
 *   status: LiveStatus,
 *   stale: boolean,
 * }} LiveOverlay
 */

/**
 * @param {unknown} raw
 * @param {number} maxLen
 * @returns {string}
 */
function cleanString(raw, maxLen) {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(CONTROL_CHAR_GLOBAL_RE, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trimEnd() : cleaned;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeColor(raw) {
  if (typeof raw !== "string" || CONTROL_CHAR_RE.test(raw)) return null;
  const s = raw.trim();
  if (!s || s.length > 32) return null;
  if (HEX_COLOR_RE.test(s) || FUNC_COLOR_RE.test(s) || NAMED_COLOR_RE.test(s)) return s;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeFieldPath(raw) {
  if (typeof raw !== "string" || CONTROL_CHAR_RE.test(raw)) return null;
  const s = raw.trim();
  if (!s || s.length > MAX_FIELD_LENGTH) return null;
  const parts = s.split(".");
  for (const part of parts) {
    if (!part || !FIELD_SEGMENT_RE.test(part) || FORBIDDEN_PATH_SEGMENTS.has(part)) return null;
  }
  return parts.join(".");
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isSecretKey(raw) {
  if (typeof raw !== "string") return false;
  return SECRET_KEYS.has(raw.toLowerCase());
}

/**
 * Redact inline credential patterns from a string.
 * @param {string} str
 * @returns {string}
 */
function redactInlineSecrets(str) {
  return str.replace(INLINE_SECRET_GLOBAL_RE, "[REDACTED]");
}

/**
 * Deeply strip secret/credential/connection keys and inline secrets from a raw
 * live-binding object. Pure: never mutates the input.
 * @param {any} raw
 * @returns {Record<string, any> | null}
 */
export function stripSecretsFromBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return /** @type {Record<string, any>} */ (stripRecursive(raw, 0));
}

/**
 * @param {any} val
 * @param {number} depth
 * @returns {any}
 */
function stripRecursive(val, depth) {
  if (depth > 8) return undefined;
  if (typeof val === "string") return redactInlineSecrets(val);
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) {
    const arr = [];
    for (const item of val) arr.push(stripRecursive(item, depth + 1));
    return arr;
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (isSecretKey(k) || FORBIDDEN_PATH_SEGMENTS.has(k)) continue;
    out[k] = stripRecursive(v, depth + 1);
  }
  return out;
}

/**
 * @param {any} raw
 * @returns {LiveThreshold | null}
 */
function normalizeThreshold(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.op !== "string" || !LIVE_THRESHOLD_OPS.includes(/** @type {LiveThresholdOp} */ (raw.op))) {
    return null;
  }
  const op = /** @type {LiveThresholdOp} */ (raw.op);
  const isOrderOp = op === ">" || op === ">=" || op === "<" || op === "<=";

  /** @type {number | string | boolean} */
  let value;
  if (typeof raw.value === "number") {
    if (!Number.isFinite(raw.value)) return null;
    value = raw.value;
  } else if (typeof raw.value === "boolean") {
    if (isOrderOp) return null;
    value = raw.value;
  } else if (typeof raw.value === "string") {
    if (CONTROL_CHAR_RE.test(raw.value)) return null;
    const trimmed = raw.value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    if (isOrderOp) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      value = n;
    } else {
      value = trimmed;
    }
  } else {
    return null;
  }

  /** @type {LiveThreshold} */
  const out = { op, value };

  const strokeColor = normalizeColor(raw.strokeColor);
  if (strokeColor) out.strokeColor = strokeColor;

  const backgroundColor = normalizeColor(raw.backgroundColor);
  if (backgroundColor) out.backgroundColor = backgroundColor;

  const badge = cleanString(raw.badge, MAX_BADGE_LENGTH);
  if (badge) out.badge = badge;

  if (typeof raw.status === "string" && LIVE_STATUSES.includes(/** @type {LiveStatus} */ (raw.status))) {
    out.status = /** @type {LiveStatus} */ (raw.status);
  }

  return out;
}

/**
 * Validate and normalize `element.customData.liveBinding`.
 * Strictly allow-lists fields so credentials, URLs, headers, and unknown keys
 * can never survive into normalized bindings. Returns `null` when invalid.
 * @param {any} raw
 * @returns {LiveBinding | null}
 */
export function normalizeLiveBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  if (typeof raw.sourceId !== "string" || CONTROL_CHAR_RE.test(raw.sourceId)) return null;
  const sourceId = raw.sourceId.trim();
  if (!sourceId || sourceId.length > MAX_SOURCE_ID_LENGTH || !SOURCE_ID_RE.test(sourceId) || sourceId.includes("..")) {
    return null;
  }

  if (raw.kind !== "metric" && raw.kind !== "k8s") return null;
  const kind = /** @type {LiveBindingKind} */ (raw.kind);

  if (typeof raw.query !== "string" || CONTROL_CHAR_RE.test(raw.query)) return null;
  const query = raw.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) return null;
  if (INLINE_SECRET_RE.test(query)) return null;

  /** @type {LiveBinding} */
  const out = { sourceId, kind, query };

  if (raw.field !== undefined && raw.field !== null && raw.field !== "") {
    const field = normalizeFieldPath(raw.field);
    if (!field) return null;
    out.field = field;
  }

  if (raw.unit !== undefined && raw.unit !== null) {
    const unit = cleanString(raw.unit, MAX_UNIT_LENGTH);
    if (unit) out.unit = unit;
  }

  if (raw.labelTemplate !== undefined && raw.labelTemplate !== null) {
    if (typeof raw.labelTemplate === "string" && !INLINE_SECRET_RE.test(raw.labelTemplate)) {
      const tpl = cleanString(raw.labelTemplate, MAX_LABEL_TEMPLATE_LENGTH);
      if (tpl) out.labelTemplate = tpl;
    }
  }

  if (Array.isArray(raw.thresholds)) {
    /** @type {LiveThreshold[]} */
    const thresholds = [];
    for (const item of raw.thresholds) {
      if (thresholds.length >= MAX_THRESHOLDS) break;
      const t = normalizeThreshold(item);
      if (t) thresholds.push(t);
    }
    if (thresholds.length) out.thresholds = thresholds;
  }

  if (typeof raw.refreshMs === "number" && Number.isFinite(raw.refreshMs)) {
    out.refreshMs = Math.max(MIN_REFRESH_MS, Math.min(MAX_REFRESH_MS, Math.trunc(raw.refreshMs)));
  }

  return out;
}

/**
 * Safely read and normalize `el.customData?.liveBinding`.
 * Returns `null` when absent, deleted, or invalid.
 * @param {any} el
 * @returns {LiveBinding | null}
 */
export function liveBindingOf(el) {
  if (!el || typeof el !== "object" || el.isDeleted) return null;
  return normalizeLiveBinding(el.customData?.liveBinding);
}

/**
 * Collect all valid live bindings from a board's elements array without mutating
 * any element.
 * @param {readonly any[]} elements
 * @returns {Array<{ elementId: string, binding: LiveBinding }>}
 */
export function collectBoardLiveBindings(elements) {
  if (!Array.isArray(elements)) return [];
  /** @type {Array<{ elementId: string, binding: LiveBinding }>} */
  const out = [];
  for (const el of elements) {
    if (!el || typeof el !== "object" || el.isDeleted || typeof el.id !== "string" || !el.id) continue;
    const binding = liveBindingOf(el);
    if (binding) out.push({ elementId: el.id, binding });
  }
  return out;
}

/**
 * @param {number | string | boolean} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param {number | string | boolean} actual
 * @param {LiveThreshold} threshold
 * @returns {boolean}
 */
function matchesThreshold(actual, threshold) {
  const { op, value } = threshold;
  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    const a = toFiniteNumber(actual);
    const b = toFiniteNumber(value);
    if (a === null || b === null) return false;
    if (op === ">") return a > b;
    if (op === ">=") return a >= b;
    if (op === "<") return a < b;
    return a <= b;
  }
  const aNum = toFiniteNumber(actual);
  const bNum = toFiniteNumber(value);
  const eq = (aNum !== null && bNum !== null && typeof actual !== "boolean" && typeof value !== "boolean")
    ? aNum === bNum
    : String(actual) === String(value);
  return op === "==" ? eq : !eq;
}

/**
 * @param {LiveThreshold} threshold
 * @returns {LiveStatus}
 */
function statusForThreshold(threshold) {
  if (threshold.status) return threshold.status;
  if (threshold.badge) {
    if (CRIT_BADGE_RE.test(threshold.badge)) return "crit";
    if (WARN_BADGE_RE.test(threshold.badge)) return "warn";
    if (OK_BADGE_RE.test(threshold.badge)) return "ok";
  }
  return "warn";
}

/**
 * @param {number | string | boolean} value
 * @returns {string}
 */
function formatValue(value) {
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(Number(value.toFixed(2)));
  }
  return String(value);
}

/**
 * Purely evaluate a live binding against a reading to produce an ephemeral
 * render overlay. Never mutates `binding`, `reading`, or any board element,
 * and never writes to the op log.
 *
 * Thresholds are evaluated in order; the first matching threshold wins.
 *
 * @param {LiveBinding | null | undefined} binding
 * @param {LiveReading | null | undefined} reading
 * @param {{ now?: number, staleAfterMs?: number }} [opts]
 * @returns {LiveOverlay}
 */
export function evaluateLiveBinding(binding, reading, opts = {}) {
  const norm = binding ? normalizeLiveBinding(binding) : null;
  if (!norm || !reading || typeof reading !== "object" || reading.ok === false) {
    return { status: "unknown", stale: true };
  }

  const val = reading.value;
  if (
    val === undefined ||
    val === null ||
    (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean") ||
    (typeof val === "number" && !Number.isFinite(val))
  ) {
    return { status: "unknown", stale: true };
  }

  const staleAfterMs = typeof opts.staleAfterMs === "number" && Number.isFinite(opts.staleAfterMs) && opts.staleAfterMs > 0
    ? opts.staleAfterMs
    : (norm.refreshMs ? norm.refreshMs * 3 : DEFAULT_STALE_MS);

  let stale = Boolean(reading.stale);
  if (!stale && typeof opts.now === "number" && Number.isFinite(opts.now) && typeof reading.fetchedAt === "number" && Number.isFinite(reading.fetchedAt)) {
    if (opts.now - reading.fetchedAt > staleAfterMs) stale = true;
  }

  /** @type {LiveThreshold | null} */
  let matched = null;
  if (norm.thresholds) {
    for (const t of norm.thresholds) {
      if (matchesThreshold(val, t)) {
        matched = t;
        break;
      }
    }
  }

  /** @type {LiveStatus} */
  const status = matched ? statusForThreshold(matched) : "ok";
  const formatted = formatValue(val);
  const unit = norm.unit ?? (typeof reading.unit === "string" ? cleanString(reading.unit, MAX_UNIT_LENGTH) : "");
  const badgeText = matched?.badge;

  let labelSuffix;
  if (norm.labelTemplate) {
    labelSuffix = norm.labelTemplate
      .replace(/\{\{\s*value\s*\}\}/g, formatted)
      .replace(/\{\{\s*unit\s*\}\}/g, unit)
      .replace(/\{\{\s*status\s*\}\}/g, status)
      .replace(/\{\{\s*badge\s*\}\}/g, badgeText ?? "");
  } else {
    labelSuffix = unit ? `${formatted}${unit}` : formatted;
  }

  /** @type {LiveOverlay} */
  const overlay = { status, stale, labelSuffix };
  if (matched?.strokeColor) overlay.strokeColor = matched.strokeColor;
  if (matched?.backgroundColor) overlay.backgroundColor = matched.backgroundColor;
  if (badgeText) overlay.badgeText = badgeText;

  return overlay;
}

/**
 * Compute read-only render overlays for all live-bound elements in a scene.
 * Pure: never mutates `elements` or emits ops.
 * @param {readonly any[]} elements
 * @param {Record<string, LiveReading> | Map<string, LiveReading>} readings
 * @param {{ now?: number, staleAfterMs?: number }} [opts]
 * @returns {Record<string, LiveOverlay>}
 */
export function computeLiveOverlays(elements, readings, opts = {}) {
  /** @type {Record<string, LiveOverlay>} */
  const out = {};
  const bindings = collectBoardLiveBindings(elements);
  for (const { elementId, binding } of bindings) {
    const reading = readings instanceof Map ? readings.get(elementId) : readings?.[elementId];
    out[elementId] = evaluateLiveBinding(binding, reading, opts);
  }
  return out;
}
