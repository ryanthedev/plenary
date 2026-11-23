// @ts-check
// Offline edit queue: buffers local ops while offline, coalesces consecutive geometry/style
// updates to the same element(s), persists to an injected Storage port under a board-scoped key,
// enforces op-count and byte-size caps, and drains in FIFO order on reconnect with conflict-safe
// reconciliation (GitHub Issue #31).
//
// Strictly pure: zero browser globals (no window, document, Date, localStorage, Math.random, etc.).
// Time and randomness come from the injected clock port; persistence comes from the injected store port.

import { clone, utf8Bytes } from "../../packages/core/model.js";
import { wins } from "../../packages/core/doc.js";
import { STORAGE_UNAVAILABLE } from "../ports/storage.js";

export const OFFLINE_QUEUE_KEY_PREFIX = "plenary.offlineQueue.v1:";
export const DEFAULT_MAX_OPS = 500;
export const DEFAULT_MAX_BYTES = 2_000_000;
const SCHEMA_VERSION = 1;

/**
 * Element fields eligible for consecutive-op coalescing (geometry, style, and version metadata).
 * Structural/content changes (type, isDeleted, text, bindings, fileId, groupIds, frameId, locked)
 * are NOT coalesced so distinct edits remain separate in FIFO order.
 */
const COALESCEABLE_FIELDS = new Set([
  // Geometry
  "x",
  "y",
  "width",
  "height",
  "angle",
  "points",
  "pressures",
  "scale",
  "crop",
  "customData",
  // Style
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "startArrowhead",
  "endArrowhead",
  // Version / edit metadata bumped on touch()
  "version",
  "versionNonce",
  "updated",
  "seed",
]);

const VERSION_META_FIELDS = new Set(["version", "versionNonce", "updated"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @typedef {{
 *   id?: string,
 *   stream?: string,
 *   elements?: Record<string, any>[],
 *   appState?: Record<string, any>,
 *   files?: Record<string, any>,
 *   baseElements?: Record<string, Record<string, any>>,
 *   [key: string]: any,
 * }} OfflineOp
 */

/**
 * @typedef {{
 *   op: OfflineOp,
 *   enqueuedAt: number,
 *   updatedAt: number,
 *   coalesced: number,
 * }} QueuedEntry
 */

/**
 * @typedef {{
 *   count: number,
 *   bytes: number,
 *   oldestAt: number | null,
 *   truncated: boolean,
 * }} QueueStats
 */

/**
 * @typedef {{
 *   ok: true,
 *   coalesced: boolean,
 *   persisted: boolean,
 *   stats: QueueStats,
 * } | {
 *   ok: false,
 *   reason: "queue-full" | "invalid-op",
 *   stats: QueueStats,
 * }} EnqueueResult
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   restored: number,
 *   truncated: boolean,
 *   reason?: "storage-unavailable" | "corrupt-data",
 * }} RestoreResult
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   sent: number,
 *   skipped: number,
 *   remaining: number,
 *   reason?: "flush-in-progress" | "disconnected" | "not-acked" | string,
 *   error?: any,
 * }} FlushResult
 */

/**
 * @typedef {{
 *   op: OfflineOp | null,
 *   conflicts: { id: string, resolution: "merged" | "local" | "remote" | "dropped-deleted" }[],
 *   dropped: string[],
 * }} MergeResult
 */

/**
 * Build the board-scoped storage key for a board's offline edit queue.
 * @param {string} boardId
 * @returns {string}
 */
export function offlineQueueKey(boardId) {
  const clean = typeof boardId === "string" ? boardId.trim() : "";
  if (!clean) throw new TypeError("offlineQueueKey: boardId must be a non-empty string");
  return `${OFFLINE_QUEUE_KEY_PREFIX}${clean}`;
}

/**
 * Deep structural equality for plain JSON-serializable values.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Check whether two consecutive element snapshots represent a coalesceable geometry/style update
 * to the same live element.
 * @param {Record<string, any>} prevEl
 * @param {Record<string, any>} nextEl
 * @returns {boolean}
 */
function isCoalesceableElementUpdate(prevEl, nextEl) {
  if (!prevEl || !nextEl || typeof prevEl !== "object" || typeof nextEl !== "object") return false;
  if (typeof prevEl.id !== "string" || !prevEl.id || prevEl.id !== nextEl.id) return false;
  if (prevEl.type !== nextEl.type) return false;
  if (Boolean(prevEl.isDeleted) || Boolean(nextEl.isDeleted)) return false;

  const keys = new Set([...Object.keys(prevEl), ...Object.keys(nextEl)]);
  for (const k of keys) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const hasPrev = Object.hasOwn(prevEl, k);
    const hasNext = Object.hasOwn(nextEl, k);
    if (!hasNext) continue; // partial patch omitting unchanged fields is allowed
    if (!hasPrev || !deepEqual(prevEl[k], nextEl[k])) {
      if (!COALESCEABLE_FIELDS.has(k)) return false;
    }
  }
  return true;
}

/**
 * Check whether `nextOp` can safely coalesce into `prevOp` (same stream, element-only updates,
 * same target element ID set, every element change is a geometry/style update).
 * @param {OfflineOp} prevOp
 * @param {OfflineOp} nextOp
 * @returns {boolean}
 */
function canCoalesceOps(prevOp, nextOp) {
  if (!prevOp || !nextOp) return false;
  if ((prevOp.stream ?? "board") !== (nextOp.stream ?? "board")) return false;
  if (prevOp.appState || nextOp.appState) return false;
  if (prevOp.files || nextOp.files) return false;
  if (!Array.isArray(prevOp.elements) || !Array.isArray(nextOp.elements)) return false;
  if (prevOp.elements.length === 0 || prevOp.elements.length !== nextOp.elements.length) return false;

  /** @type {Map<string, Record<string, any>>} */
  const prevById = new Map();
  for (const el of prevOp.elements) {
    if (!el || typeof el !== "object" || typeof el.id !== "string" || !el.id) return false;
    if (prevById.has(el.id)) return false;
    prevById.set(el.id, el);
  }

  /** @type {Set<string>} */
  const seenNext = new Set();
  for (const el of nextOp.elements) {
    if (!el || typeof el !== "object" || typeof el.id !== "string" || !el.id) return false;
    if (seenNext.has(el.id)) return false;
    const prevEl = prevById.get(el.id);
    if (!prevEl || !isCoalesceableElementUpdate(prevEl, el)) return false;
    seenNext.add(el.id);
  }

  return seenNext.size === prevById.size;
}

/**
 * Merge `nextOp` into `prevOp` after `canCoalesceOps(prevOp, nextOp)` returned true.
 * Preserves any `baseElements` captured by the earlier op so conflict resolution still
 * knows the pre-offline baseline.
 * @param {OfflineOp} prevOp
 * @param {OfflineOp} nextOp
 * @returns {OfflineOp}
 */
function coalesceOps(prevOp, nextOp) {
  /** @type {Map<string, Record<string, any>>} */
  const nextById = new Map();
  for (const el of nextOp.elements ?? []) nextById.set(el.id, el);

  const mergedElements = (prevOp.elements ?? []).map(prevEl => {
    const nextEl = nextById.get(prevEl.id);
    return clone({ ...prevEl, ...nextEl });
  });

  /** @type {OfflineOp} */
  const merged = {
    ...clone(prevOp),
    ...clone(nextOp),
    elements: mergedElements,
  };
  if (prevOp.baseElements) {
    merged.baseElements = clone(prevOp.baseElements);
  }
  return merged;
}

/**
 * Look up an element by ID in a remote Doc, scene snapshot, Map, or plain record.
 * @param {any} remoteDoc
 * @param {string} id
 * @returns {Record<string, any> | null}
 */
function lookupRemoteElement(remoteDoc, id) {
  if (!remoteDoc || typeof id !== "string" || !id) return null;
  if (typeof remoteDoc.getAny === "function") return remoteDoc.getAny(id) ?? null;
  if (remoteDoc.byId instanceof Map) return remoteDoc.byId.get(id) ?? null;
  if (remoteDoc instanceof Map) return remoteDoc.get(id) ?? null;
  if (typeof remoteDoc.get === "function") return remoteDoc.get(id) ?? null;
  if (Array.isArray(remoteDoc.elements)) {
    for (const el of remoteDoc.elements) {
      if (el && el.id === id) return el;
    }
    return null;
  }
  if (typeof remoteDoc === "object" && Object.hasOwn(remoteDoc, id)) {
    const val = remoteDoc[id];
    return val && typeof val === "object" ? val : null;
  }
  return null;
}

/**
 * Check whether any element in `queuedOp` has a newer or conflicting version in `remoteDoc`.
 * @param {OfflineOp} queuedOp
 * @param {any} remoteDoc
 * @returns {boolean}
 */
export function hasRemoteConflict(queuedOp, remoteDoc) {
  if (!queuedOp || !remoteDoc || !Array.isArray(queuedOp.elements)) return false;
  for (const el of queuedOp.elements) {
    if (!el || typeof el.id !== "string") continue;
    const remoteEl = lookupRemoteElement(remoteDoc, el.id);
    if (!remoteEl) continue;
    if (!wins(el, remoteEl) || (remoteEl.version ?? 0) >= (el.version ?? 0)) return true;
  }
  return false;
}

/**
 * Compute a deterministic next versionNonce without touching global Math.random.
 * @param {Record<string, any>} remoteEl
 * @param {Record<string, any>} queuedEl
 * @param {import("../ports/clock.js").Clock | null | undefined} clock
 * @returns {number}
 */
function nextVersionNonce(remoteEl, queuedEl, clock) {
  if (typeof clock?.random === "function") {
    return Math.floor(clock.random() * 2 ** 31);
  }
  const base = Number.isFinite(remoteEl?.versionNonce)
    ? remoteEl.versionNonce
    : Number.isFinite(queuedEl?.versionNonce)
      ? queuedEl.versionNonce
      : 0;
  return ((base + 1) >>> 0) % 2147483647;
}

/**
 * Merge a queued offline op against a live/remote document without clobbering unrelated
 * remote edits.
 *
 * - Elements absent from `remoteDoc` are kept as-is.
 * - Elements where `queuedOp.baseElements[id]` is provided use a 3-way field-level merge:
 *   disjoint local and remote field edits both survive; colliding fields resolve via LWW
 *   (`updated` timestamp, ties favoring local), and the resulting element's `version` is
 *   rebased above `remoteEl.version` so `Doc.apply` accepts it cleanly.
 * - Elements without `baseElements[id]` use LWW by `updated` timestamp (ties favoring local),
 *   overlaying onto `remoteEl` and rebasing `version` above `remoteEl.version`; if remote is
 *   strictly newer, remote wins and the stale local element update is dropped.
 * - Remote tombstones (`remoteEl.isDeleted === true`) win unless the local edit has a strictly
 *   newer `updated` timestamp.
 *
 * @param {OfflineOp} queuedOp
 * @param {any} remoteDoc
 * @param {{ clock?: import("../ports/clock.js").Clock | null }} [opts]
 * @returns {MergeResult}
 */
export function mergeOfflineOp(queuedOp, remoteDoc, { clock = null } = {}) {
  if (!queuedOp || typeof queuedOp !== "object") {
    return { op: null, conflicts: [], dropped: [] };
  }
  const nowFn = typeof clock?.now === "function" ? () => clock.now() : () => 0;

  /** @type {MergeResult["conflicts"]} */
  const conflicts = [];
  /** @type {string[]} */
  const dropped = [];
  /** @type {Record<string, any>[]} */
  const mergedElements = [];

  for (const rawEl of queuedOp.elements ?? []) {
    if (!rawEl || typeof rawEl !== "object" || typeof rawEl.id !== "string" || !rawEl.id) continue;
    const queuedEl = clone(rawEl);
    const remoteEl = lookupRemoteElement(remoteDoc, queuedEl.id);

    if (!remoteEl) {
      mergedElements.push(queuedEl);
      continue;
    }

    const remoteVer = remoteEl.version ?? 0;
    const queuedVer = queuedEl.version ?? 0;
    const remoteUpdated = remoteEl.updated ?? 0;
    const queuedUpdated = queuedEl.updated ?? 0;

    // If queued element already strictly wins on version and isn't behind remote, keep it.
    if (queuedVer > remoteVer && wins(queuedEl, remoteEl)) {
      mergedElements.push(queuedEl);
      continue;
    }

    // Remote deleted the element while offline: tombstone wins unless local edit is strictly newer.
    if (remoteEl.isDeleted && !queuedEl.isDeleted && queuedUpdated <= remoteUpdated) {
      conflicts.push({ id: queuedEl.id, resolution: "dropped-deleted" });
      dropped.push(queuedEl.id);
      continue;
    }

    const baseEl = queuedOp.baseElements && Object.hasOwn(queuedOp.baseElements, queuedEl.id)
      ? queuedOp.baseElements[queuedEl.id]
      : null;

    if (baseEl && typeof baseEl === "object") {
      // 3-way field-level merge: preserve unrelated remote field edits while keeping local edits.
      const merged = clone(remoteEl);
      let appliedLocalField = false;
      const keys = new Set([...Object.keys(queuedEl), ...Object.keys(baseEl)]);
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k) || VERSION_META_FIELDS.has(k)) continue;
        if (!Object.hasOwn(queuedEl, k)) continue;
        const localChanged = !deepEqual(queuedEl[k], baseEl[k]);
        if (!localChanged) continue;
        const remoteChanged = !deepEqual(remoteEl[k], baseEl[k]);
        if (!remoteChanged || queuedUpdated >= remoteUpdated) {
          merged[k] = clone(queuedEl[k]);
          appliedLocalField = true;
        }
      }
      if (!appliedLocalField) {
        conflicts.push({ id: queuedEl.id, resolution: "remote" });
        dropped.push(queuedEl.id);
        continue;
      }
      merged.version = Math.max(queuedVer, remoteVer) + 1;
      merged.versionNonce = nextVersionNonce(remoteEl, queuedEl, clock);
      merged.updated = Math.max(queuedUpdated, remoteUpdated, nowFn());
      mergedElements.push(merged);
      conflicts.push({ id: queuedEl.id, resolution: "merged" });
      continue;
    }

    // 2-way LWW merge when no base snapshot is available.
    if (queuedUpdated >= remoteUpdated) {
      const merged = { ...clone(remoteEl), ...queuedEl };
      merged.version = Math.max(queuedVer, remoteVer) + 1;
      merged.versionNonce = nextVersionNonce(remoteEl, queuedEl, clock);
      merged.updated = Math.max(queuedUpdated, remoteUpdated, nowFn());
      mergedElements.push(merged);
      conflicts.push({ id: queuedEl.id, resolution: "local" });
    } else {
      conflicts.push({ id: queuedEl.id, resolution: "remote" });
      dropped.push(queuedEl.id);
    }
  }

  /** @type {OfflineOp} */
  const nextOp = {};
  if (typeof queuedOp.id === "string") nextOp.id = queuedOp.id;
  if (typeof queuedOp.stream === "string") nextOp.stream = queuedOp.stream;
  if (mergedElements.length > 0) nextOp.elements = mergedElements;
  if (queuedOp.appState && typeof queuedOp.appState === "object") nextOp.appState = clone(queuedOp.appState);
  if (queuedOp.files && typeof queuedOp.files === "object") nextOp.files = clone(queuedOp.files);

  const hasPayload = Boolean(nextOp.elements?.length || nextOp.appState || (nextOp.files && Object.keys(nextOp.files).length > 0));
  return {
    op: hasPayload ? nextOp : null,
    conflicts,
    dropped,
  };
}

/**
 * Create a board-scoped offline edit queue.
 *
 * @param {{
 *   store?: import("../ports/storage.js").Storage | null,
 *   boardId: string,
 *   maxOps?: number,
 *   maxBytes?: number,
 *   clock?: import("../ports/clock.js").Clock | (() => number) | null,
 * }} opts
 */
export function createOfflineQueue({
  store = null,
  boardId,
  maxOps = DEFAULT_MAX_OPS,
  maxBytes = DEFAULT_MAX_BYTES,
  clock = null,
}) {
  const key = offlineQueueKey(boardId);
  const capOps = Number.isFinite(maxOps) && maxOps >= 1 ? Math.floor(maxOps) : DEFAULT_MAX_OPS;
  const capBytes = Number.isFinite(maxBytes) && maxBytes >= 1 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  const clockObj = clock && typeof clock === "object" ? clock : null;
  const now = typeof clock === "function"
    ? clock
    : typeof clockObj?.now === "function"
      ? () => clockObj.now()
      : () => 0;

  /** @type {QueuedEntry[]} */
  let entries = [];
  let cachedBytes = 0;
  let truncated = false;
  let flushing = false;
  let inFlightEntry = /** @type {QueuedEntry | null} */ (null);

  /**
   * Serialize a candidate entry list and measure its UTF-8 byte length.
   * @param {QueuedEntry[]} list
   * @returns {{ json: string, bytes: number }}
   */
  function serialize(list) {
    if (list.length === 0) return { json: "", bytes: 0 };
    const json = JSON.stringify({ v: SCHEMA_VERSION, boardId, entries: list });
    return { json, bytes: utf8Bytes(json) };
  }

  /**
   * Persist serialized queue payload to the storage port. Never throws.
   * @param {string} json
   * @returns {boolean} true if persisted, false if storage unavailable or absent
   */
  function persistJson(json) {
    if (!store) return false;
    try {
      if (!json) {
        store.remove(key);
      } else {
        store.set(key, json);
      }
      return true;
    } catch (err) {
      // Storage port contract: STORAGE_UNAVAILABLE (or quota/blocked); carry on in memory.
      if (err?.code === STORAGE_UNAVAILABLE) return false;
      return false;
    }
  }

  /**
   * Snapshot of queue statistics.
   * @returns {QueueStats}
   */
  function stats() {
    return {
      count: entries.length,
      bytes: cachedBytes,
      oldestAt: entries.length > 0 ? entries[0].enqueuedAt : null,
      truncated,
    };
  }

  /**
   * Return a cloned array of currently queued ops in FIFO order.
   * @returns {OfflineOp[]}
   */
  function pending() {
    return entries.map(e => clone(e.op));
  }

  /**
   * Buffer a local op while offline, coalescing consecutive geometry/style updates
   * to the same element ID(s), persisting to `store`, and enforcing `maxOps`/`maxBytes`.
   * @param {OfflineOp} op
   * @returns {EnqueueResult}
   */
  function enqueue(op) {
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      return { ok: false, reason: "invalid-op", stats: stats() };
    }

    const opCopy = clone(op);
    const ts = now();
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    const shouldCoalesce = Boolean(last && last !== inFlightEntry && canCoalesceOps(last.op, opCopy));

    /** @type {QueuedEntry[]} */
    let candidate;
    if (shouldCoalesce && last) {
      const coalescedEntry = {
        op: coalesceOps(last.op, opCopy),
        enqueuedAt: last.enqueuedAt,
        updatedAt: ts,
        coalesced: last.coalesced + 1,
      };
      candidate = [...entries.slice(0, -1), coalescedEntry];
    } else {
      if (entries.length + 1 > capOps) {
        truncated = true;
        return { ok: false, reason: "queue-full", stats: stats() };
      }
      candidate = [
        ...entries,
        {
          op: opCopy,
          enqueuedAt: ts,
          updatedAt: ts,
          coalesced: 0,
        },
      ];
    }

    const { json, bytes } = serialize(candidate);
    if (bytes > capBytes) {
      truncated = true;
      return { ok: false, reason: "queue-full", stats: stats() };
    }

    entries = candidate;
    cachedBytes = bytes;
    const persisted = persistJson(json);
    return { ok: true, coalesced: shouldCoalesce, persisted, stats: stats() };
  }

  /**
   * Load and validate persisted queued ops after a page reload.
   * Survives corrupt JSON, invalid entry shapes, and unavailable storage gracefully.
   * @returns {RestoreResult}
   */
  function restore() {
    if (!store) {
      entries = [];
      cachedBytes = 0;
      truncated = false;
      return { ok: true, restored: 0, truncated: false };
    }

    /** @type {string | null} */
    let raw = null;
    try {
      raw = store.get(key);
    } catch {
      return { ok: false, restored: 0, truncated: false, reason: "storage-unavailable" };
    }

    if (raw == null || raw === "") {
      entries = [];
      cachedBytes = 0;
      truncated = false;
      return { ok: true, restored: 0, truncated: false };
    }

    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      entries = [];
      cachedBytes = 0;
      truncated = false;
      persistJson("");
      return { ok: false, restored: 0, truncated: false, reason: "corrupt-data" };
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      entries = [];
      cachedBytes = 0;
      truncated = false;
      persistJson("");
      return { ok: false, restored: 0, truncated: false, reason: "corrupt-data" };
    }

    /** @type {QueuedEntry[]} */
    const valid = [];
    let wasTruncated = false;

    for (const item of parsed.entries) {
      if (!item || typeof item !== "object" || !item.op || typeof item.op !== "object" || Array.isArray(item.op)) {
        wasTruncated = true;
        continue;
      }
      if (valid.length >= capOps) {
        wasTruncated = true;
        break;
      }
      const enqueuedAt = typeof item.enqueuedAt === "number" && Number.isFinite(item.enqueuedAt) ? item.enqueuedAt : 0;
      const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : enqueuedAt;
      const coalesced = typeof item.coalesced === "number" && Number.isInteger(item.coalesced) && item.coalesced >= 0 ? item.coalesced : 0;
      /** @type {QueuedEntry} */
      const nextEntry = {
        op: clone(item.op),
        enqueuedAt,
        updatedAt,
        coalesced,
      };
      const trial = [...valid, nextEntry];
      const { bytes } = serialize(trial);
      if (bytes > capBytes) {
        wasTruncated = true;
        break;
      }
      valid.push(nextEntry);
    }

    entries = valid;
    const { json, bytes } = serialize(entries);
    cachedBytes = bytes;
    truncated = wasTruncated;
    if (wasTruncated) {
      persistJson(json);
    }
    return { ok: true, restored: entries.length, truncated: wasTruncated };
  }

  /**
   * Drain queued ops in FIFO order on reconnect.
   *
   * - If `remoteState` has a newer/conflicting version for an element, invokes `reconcile(queuedOp, remoteState)`
   *   (or falls back to `mergeOfflineOp(queuedOp, remoteState, { clock })`).
   * - Removes each op only AFTER `send` acknowledges it.
   * - Stops cleanly if `send` throws or returns a non-ack (`false`, `{ ok: false }`, `{ ack: false }`),
   *   preserving the unacked op and all subsequent ops for the next reconnect.
   *
   * @param {{
   *   send: (op: OfflineOp, entry: QueuedEntry) => boolean | void | { ok?: boolean, ack?: boolean, reason?: string } | Promise<boolean | void | { ok?: boolean, ack?: boolean, reason?: string }>,
   *   reconcile?: ((queuedOp: OfflineOp, remoteState: any) => OfflineOp | { op: OfflineOp | null } | null | undefined) | null,
   *   remoteState?: any | (() => any),
   * }} opts
   * @returns {Promise<FlushResult>}
   */
  async function flush({ send, reconcile = null, remoteState = undefined } = /** @type {any} */ ({})) {
    if (flushing) {
      return { ok: false, reason: "flush-in-progress", sent: 0, skipped: 0, remaining: entries.length };
    }
    if (typeof send !== "function") {
      throw new TypeError("offlineQueue.flush: send must be a function");
    }

    flushing = true;
    let sent = 0;
    let skipped = 0;

    try {
      while (entries.length > 0) {
        const head = entries[0];
        inFlightEntry = head;

        const remote = typeof remoteState === "function" ? remoteState() : remoteState;
        /** @type {OfflineOp | null} */
        let opToSend = clone(head.op);

        if (remote !== undefined) {
          if (hasRemoteConflict(opToSend, remote)) {
            if (typeof reconcile === "function") {
              const reconciled = reconcile(opToSend, remote);
              if (reconciled === null) {
                opToSend = null;
              } else if (reconciled && typeof reconciled === "object" && "op" in reconciled) {
                opToSend = reconciled.op ? clone(reconciled.op) : null;
              } else if (reconciled && typeof reconciled === "object") {
                opToSend = clone(reconciled);
              }
            } else {
              const merged = mergeOfflineOp(opToSend, remote, { clock: clockObj });
              opToSend = merged.op;
            }
          }
        } else if (typeof reconcile === "function") {
          const reconciled = reconcile(opToSend, undefined);
          if (reconciled === null) {
            opToSend = null;
          } else if (reconciled && typeof reconciled === "object" && "op" in reconciled) {
            opToSend = reconciled.op ? clone(reconciled.op) : null;
          } else if (reconciled && typeof reconciled === "object") {
            opToSend = clone(reconciled);
          }
        }

        if (opToSend === null) {
          entries.shift();
          inFlightEntry = null;
          const { json, bytes } = serialize(entries);
          cachedBytes = bytes;
          persistJson(json);
          skipped++;
          continue;
        }

        let res;
        try {
          res = await send(opToSend, clone(head));
        } catch (err) {
          inFlightEntry = null;
          return {
            ok: false,
            reason: "disconnected",
            error: err,
            sent,
            skipped,
            remaining: entries.length,
          };
        }

        const rejected = res === false || (res && typeof res === "object" && (res.ok === false || res.ack === false));
        if (rejected) {
          inFlightEntry = null;
          const reason = res && typeof res === "object" && typeof res.reason === "string" ? res.reason : "not-acked";
          return {
            ok: false,
            reason,
            sent,
            skipped,
            remaining: entries.length,
          };
        }

        entries.shift();
        inFlightEntry = null;
        const { json, bytes } = serialize(entries);
        cachedBytes = bytes;
        persistJson(json);
        sent++;
      }

      return { ok: true, sent, skipped, remaining: 0 };
    } finally {
      inFlightEntry = null;
      flushing = false;
    }
  }

  /**
   * Clear all buffered ops and remove persisted state from storage.
   */
  function clear() {
    entries = [];
    cachedBytes = 0;
    truncated = false;
    persistJson("");
  }

  return {
    key,
    enqueue,
    restore,
    pending,
    stats,
    flush,
    clear,
  };
}
