// @ts-check
// Pure read-only session replay engine (Issue #17: scrub a board's history).
//
// Builds an immutable, keyframe-indexed replay view over historical op log entries
// without ever mutating input entries, base snapshots, or any live Doc.
//
// Zero bare imports and zero host globals: runs anywhere packages/core runs.

import { Doc } from "./doc.js";
import { clone, emptyScene } from "./model.js";

/**
 * @typedef {object} ReplayLogEntry
 * @property {number} seq
 * @property {number} [ts]
 * @property {number} [at]
 * @property {string | null} [user]
 * @property {string | null} [by]
 * @property {string | null} [name]
 * @property {string} [stream]
 * @property {{ elements?: any[], appState?: Record<string, any>, files?: Record<string, any> }} [op]
 */

/**
 * @typedef {object} NormalizedEntry
 * @property {number} seq
 * @property {number} ts
 * @property {string | null} user
 * @property {string | null} stream
 * @property {{ elements?: any[], appState?: Record<string, any>, files?: Record<string, any> } | null} op
 */

/**
 * @typedef {object} ReplayKeyframe
 * @property {number} index
 * @property {number} seq
 * @property {Record<string, any>} scene
 */

/**
 * @typedef {object} ReplaySessionOptions
 * @property {Record<string, any> | Doc | null} [baseSnapshot]
 * @property {number} [keyframeInterval]
 */

/**
 * @typedef {object} ReplaySession
 * @property {readonly NormalizedEntry[]} entries
 * @property {Record<string, any>} baseScene
 * @property {number} keyframeInterval
 * @property {readonly ReplayKeyframe[]} keyframes
 * @property {number} startSeq
 * @property {number} endSeq
 * @property {number} startTs
 * @property {number} endTs
 * @property {number} count
 * @property {readonly string[]} authors
 */

/**
 * @typedef {object} ReplaySnapshot
 * @property {number} seq
 * @property {number} ts
 * @property {string | null} user
 * @property {any[]} elements
 * @property {Record<string, any>} appState
 * @property {number} index
 * @property {number} total
 */

/**
 * @typedef {object} ReplaySummary
 * @property {number} startSeq
 * @property {number} endSeq
 * @property {number} startTs
 * @property {number} endTs
 * @property {number} count
 * @property {string[]} authors
 */

/**
 * Capture a Doc's exact state preserving `byId` insertion order (including tombstones),
 * so loading a keyframe produces bit-identical `live()` tie-break ordering to full replay.
 * @param {Doc} doc
 * @returns {Record<string, any>}
 */
function snapshotDoc(doc) {
  return {
    type: "excalidraw",
    version: 2,
    source: "herdr-draw",
    elements: clone([...doc.byId.values()]),
    appState: clone(doc.appState),
    files: clone(doc.files),
  };
}

/**
 * Normalize a base snapshot (plain scene object, Doc instance, or null) into a fresh cloned scene.
 * @param {Record<string, any> | Doc | null | undefined} baseSnapshot
 * @returns {Record<string, any>}
 */
function normalizeBaseScene(baseSnapshot) {
  if (!baseSnapshot) return emptyScene();
  if (typeof /** @type {any} */ (baseSnapshot).byId?.values === "function") {
    return snapshotDoc(/** @type {Doc} */ (baseSnapshot));
  }
  const raw = typeof /** @type {any} */ (baseSnapshot).toScene === "function"
    ? /** @type {Doc} */ (baseSnapshot).toScene()
    : baseSnapshot;
  const doc = new Doc(clone(raw));
  return snapshotDoc(doc);
}

/**
 * Normalize a single op log entry into a cloned, read-only shape.
 * Supports both `{ seq, ts, user, op }` and Plenary Room entries `{ seq, at, by, op, stream }`.
 * @param {ReplayLogEntry} raw
 * @param {number} fallbackIndex
 * @returns {NormalizedEntry}
 */
function normalizeEntry(raw, fallbackIndex) {
  const seq = typeof raw?.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : fallbackIndex + 1;
  const tsVal = typeof raw?.ts === "number" && Number.isFinite(raw.ts)
    ? raw.ts
    : (typeof raw?.at === "number" && Number.isFinite(raw.at) ? raw.at : 0);
  const userVal = typeof raw?.user === "string" && raw.user.length > 0
    ? raw.user
    : (typeof raw?.by === "string" && raw.by.length > 0
      ? raw.by
      : (typeof raw?.name === "string" && raw.name.length > 0 ? raw.name : null));
  const stream = typeof raw?.stream === "string" ? raw.stream : null;
  const op = raw?.op && typeof raw.op === "object" ? clone(raw.op) : null;
  return Object.freeze({ seq, ts: tsVal, user: userVal, stream, op });
}

/**
 * Apply a single normalized entry to a scratch Doc.
 * Record-stream ops (`stream === "records"`) do not mutate canvas elements or board appState.
 * @param {Doc} doc
 * @param {NormalizedEntry} entry
 */
function applyToDoc(doc, entry) {
  if (!entry.op || entry.stream === "records") return;
  doc.apply(entry.op);
}

/**
 * Build a strictly read-only replay index over historical op log entries,
 * caching periodic keyframes for fast scrubbing.
 * Never mutates input entries, baseSnapshot, or any live Doc.
 *
 * @param {readonly ReplayLogEntry[]} entries
 * @param {ReplaySessionOptions} [options]
 * @returns {ReplaySession}
 */
export function createReplaySession(entries, { baseSnapshot = null, keyframeInterval = 50 } = {}) {
  const interval = typeof keyframeInterval === "number" && Number.isFinite(keyframeInterval) && keyframeInterval >= 1
    ? Math.floor(keyframeInterval)
    : 50;

  const baseScene = normalizeBaseScene(baseSnapshot);

  // Clone and sort ascending by seq (stable tie-break on original index).
  const indexed = (Array.isArray(entries) ? entries : []).map((raw, i) => ({
    i,
    entry: normalizeEntry(raw, i),
  }));
  indexed.sort((a, b) => (a.entry.seq - b.entry.seq) || (a.i - b.i));
  const normalized = Object.freeze(indexed.map(x => x.entry));

  // Build keyframes by walking a private scratch Doc once.
  const scratch = new Doc(clone(baseScene));
  /** @type {ReplayKeyframe[]} */
  const keyframes = [];
  /** @type {string[]} */
  const authors = [];
  const seenAuthors = new Set();

  for (let i = 0; i < normalized.length; i++) {
    const entry = normalized[i];
    if (entry.user && !seenAuthors.has(entry.user)) {
      seenAuthors.add(entry.user);
      authors.push(entry.user);
    }
    applyToDoc(scratch, entry);
    if ((i + 1) % interval === 0) {
      keyframes.push(Object.freeze({
        index: i,
        seq: entry.seq,
        scene: snapshotDoc(scratch),
      }));
    }
  }

  const count = normalized.length;
  const startSeq = count > 0 ? normalized[0].seq : 0;
  const endSeq = count > 0 ? normalized[count - 1].seq : 0;
  const startTs = count > 0 ? normalized[0].ts : 0;
  const endTs = count > 0 ? normalized[count - 1].ts : 0;

  return Object.freeze({
    entries: normalized,
    baseScene,
    keyframeInterval: interval,
    keyframes: Object.freeze(keyframes),
    startSeq,
    endSeq,
    startTs,
    endTs,
    count,
    authors: Object.freeze(authors),
  });
}

/**
 * Find the greatest keyframe index `<= targetIndex`, or null if none precedes it.
 * @param {readonly ReplayKeyframe[]} keyframes
 * @param {number} targetIndex
 * @returns {ReplayKeyframe | null}
 */
function nearestKeyframe(keyframes, targetIndex) {
  let lo = 0;
  let hi = keyframes.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (keyframes[mid].index <= targetIndex) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? keyframes[best] : null;
}

/**
 * Reconstruct a fresh read-only snapshot at entry array index `targetIndex` (-1 = base snapshot).
 * @param {ReplaySession} session
 * @param {number} targetIndex
 * @returns {ReplaySnapshot}
 */
function stateAtIndex(session, targetIndex) {
  const total = session.entries.length;
  if (total === 0 || targetIndex < 0) {
    const baseDoc = new Doc(clone(session.baseScene));
    return Object.freeze({
      seq: 0,
      ts: 0,
      user: null,
      elements: clone(baseDoc.live()),
      appState: clone(baseDoc.appState),
      index: -1,
      total,
    });
  }

  const clampedIdx = Math.min(targetIndex, total - 1);
  const kf = nearestKeyframe(session.keyframes, clampedIdx);
  const startIdx = kf ? kf.index + 1 : 0;
  const doc = new Doc(clone(kf ? kf.scene : session.baseScene));

  for (let i = startIdx; i <= clampedIdx; i++) {
    applyToDoc(doc, session.entries[i]);
  }

  const entry = session.entries[clampedIdx];
  return Object.freeze({
    seq: entry.seq,
    ts: entry.ts,
    user: entry.user,
    elements: clone(doc.live()),
    appState: clone(doc.appState),
    index: clampedIdx,
    total,
  });
}

/**
 * Binary-search `entries` for the last entry with `entry.seq <= seq`. Returns -1 if none.
 * @param {readonly NormalizedEntry[]} entries
 * @param {number} seq
 * @returns {number}
 */
function findIndexBySeq(entries, seq) {
  let lo = 0;
  let hi = entries.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].seq <= seq) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Binary-search `entries` for the last entry with `entry.ts <= ts`. Returns -1 if none.
 * @param {readonly NormalizedEntry[]} entries
 * @param {number} ts
 * @returns {number}
 */
function findIndexByTime(entries, ts) {
  let lo = 0;
  let hi = entries.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].ts <= ts) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Reconstruct a fresh read-only board snapshot at `seq` using the nearest preceding
 * keyframe plus forward apply.
 *
 * @param {ReplaySession} session
 * @param {number} seq
 * @returns {ReplaySnapshot}
 */
export function replayStateAt(session, seq) {
  if (!session || session.entries.length === 0) return stateAtIndex(session, -1);
  const targetSeq = typeof seq === "number" && Number.isFinite(seq) ? seq : session.endSeq;
  const idx = findIndexBySeq(session.entries, targetSeq);
  return stateAtIndex(session, idx);
}

/**
 * Binary-search entries by timestamp and return the fresh read-only board snapshot at `ts`.
 *
 * @param {ReplaySession} session
 * @param {number} ts
 * @returns {ReplaySnapshot}
 */
export function replayStateAtTime(session, ts) {
  if (!session || session.entries.length === 0) return stateAtIndex(session, -1);
  const targetTs = typeof ts === "number" && Number.isFinite(ts) ? ts : session.endTs;
  const idx = findIndexByTime(session.entries, targetTs);
  return stateAtIndex(session, idx);
}

/**
 * Return scrubber header metadata for a replay session.
 *
 * @param {ReplaySession} session
 * @returns {ReplaySummary}
 */
export function replaySummary(session) {
  return {
    startSeq: session.startSeq,
    endSeq: session.endSeq,
    startTs: session.startTs,
    endTs: session.endTs,
    count: session.count,
    authors: [...session.authors],
  };
}

/**
 * Step forward or backward by `delta` ops from `currentSeq`, cleanly clamped to `[startSeq, endSeq]`.
 *
 * @param {ReplaySession} session
 * @param {number} currentSeq
 * @param {number} delta
 * @returns {ReplaySnapshot}
 */
export function stepReplay(session, currentSeq, delta) {
  if (!session || session.entries.length === 0) return stateAtIndex(session, -1);
  const step = typeof delta === "number" && Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const currentIdx = findIndexBySeq(session.entries, currentSeq);
  const nextIdx = Math.max(0, Math.min(session.entries.length - 1, currentIdx + step));
  return stateAtIndex(session, nextIdx);
}
