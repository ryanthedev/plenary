// @ts-check
// Presence (PROTOCOL.md § Presence): cursors, selections, laser, previews, emotes. Never sequenced, never
// logged, may drop at any hop. A room never sees it; gateways check, rate-limit, coalesce and relay it.
// Pure, with the clock passed in.

import { ELEMENT_STREAMS, ROLES, canWrite, deeperThan, MAX_ID_CHARS, MAX_OP_DEPTH } from "./envelope.js";

const WRITERS = ["owner", "editor", "annotator", "commenter"];
/** Per kind: who may send it, and how many per second per connection. */
export const PRESENCE = {
  cursor: { roles: WRITERS, rate: 20 },
  select: { roles: WRITERS, rate: 5 },
  laser: { roles: ["owner", "editor"], rate: 30 },
  preview: { roles: WRITERS, rate: 20 },   // and only by a writer of that stream
  emote: { roles: ROLES, rate: 4 },
};
export const EMOTES = ["👍", "❤️", "😂", "🎉", "👏", "😮", "🙏", "🔥"];
export const MAX_SELECT_IDS = 500, MAX_LASER_POINTS = 64, MAX_PREVIEW_ELEMENTS = 50, MAX_PREVIEW_CHARS = 64_000;
export const PREVIEW_TTL_MS = 5000;

const isNum = v => typeof v === "number" && Number.isFinite(v);
const isId = v => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;

/**
 * What's wrong with a presence message from someone with `role`, or null. A bad one is dropped silently:
 * presence never gets an error.
 * @returns {null | string}
 */
export function presenceProblem(msg, role) {
  if (!msg || typeof msg !== "object" || !Object.prototype.hasOwnProperty.call(PRESENCE, msg.k)) return "unknown presence kind";
  if (!PRESENCE[msg.k].roles.includes(role)) return `${role} can't send ${msg.k}`;
  if (msg.k === "cursor") return isNum(msg.x) && isNum(msg.y) ? null : "cursor needs x and y";
  if (msg.k === "select") {
    if (!ELEMENT_STREAMS.includes(msg.stream)) return "select names a stream";
    return Array.isArray(msg.ids) && msg.ids.length <= MAX_SELECT_IDS && msg.ids.every(isId) ? null : `select holds at most ${MAX_SELECT_IDS} ids`;
  }
  if (msg.k === "laser") {
    const ok = Array.isArray(msg.pts) && msg.pts.length >= 1 && msg.pts.length <= MAX_LASER_POINTS && msg.pts.every(p => Array.isArray(p) && p.length === 3 && p.every(isNum));
    return ok ? null : `laser holds 1 to ${MAX_LASER_POINTS} points of [x, y, t]`;
  }
  if (msg.k === "preview") {
    if (!ELEMENT_STREAMS.includes(msg.stream) || !canWrite(role, msg.stream)) return "preview needs a stream you can write";
    if (!Array.isArray(msg.elements) || !msg.elements.length || msg.elements.length > MAX_PREVIEW_ELEMENTS) return `preview holds 1 to ${MAX_PREVIEW_ELEMENTS} elements`;
    if (!msg.elements.every(el => el && typeof el === "object" && isId(el.id))) return "every preview element needs an id";
    if (deeperThan(msg.elements, MAX_OP_DEPTH)) return "preview nests too deep";
    return JSON.stringify(msg.elements).length <= MAX_PREVIEW_CHARS ? null : "preview is too large";
  }
  return EMOTES.includes(msg.e) ? null : "unknown emote";
}

/**
 * One connection's presence rates: a bucket per kind, `rate` a second, at most one second's worth saved up.
 * @param {() => number} now a clock in ms
 * @returns {{ allow(k: string): boolean }} false = over the rate: drop it, no error
 */
export function presenceLimiter(now) {
  const buckets = {};
  return {
    allow(k) {
      if (!Object.prototype.hasOwnProperty.call(PRESENCE, k)) return false;
      const rate = PRESENCE[k].rate, t = now();
      const b = buckets[k] ?? (buckets[k] = { tokens: rate, at: t });
      b.tokens = Math.min(rate, b.tokens + Math.max(0, t - b.at) * rate / 1000); b.at = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
  };
}

/**
 * Gathers presence between two sends and gives back one batch: the latest cursor and selection per
 * (user, client), the latest preview per element, every laser batch and emote, and `leave`.
 * @returns {{ add(user: string, client: string, msg: object): void, leave(user: string, client: string): void, flush(): object[], size: number }}
 */
export function presenceCoalescer() {
  let latest = new Map(), each = [];
  const key = (user, client, rest) => JSON.stringify([user, client, rest]);
  return {
    add(user, client, msg) {
      if (msg.k === "cursor") latest.set(key(user, client, "cursor"), { user, client, k: "cursor", x: msg.x, y: msg.y });
      else if (msg.k === "select") latest.set(key(user, client, "select"), { user, client, k: "select", stream: msg.stream, ids: msg.ids });
      else if (msg.k === "preview") for (const el of msg.elements) latest.set(key(user, client, ["preview", msg.stream, el.id]), { user, client, k: "preview", stream: msg.stream, elements: [el] });
      else if (msg.k === "laser") each.push({ user, client, k: "laser", pts: msg.pts });
      else if (msg.k === "emote") each.push({ user, client, k: "emote", e: msg.e });
    },
    /** The connection is gone: what it had waiting goes with it, and the others are told. */
    leave(user, client) {
      for (const [k, m] of latest) if (m.user === user && m.client === client) latest.delete(k);
      each = each.filter(m => !(m.user === user && m.client === client));
      each.push({ user, client, k: "leave" });
    },
    flush() { const batch = [...latest.values(), ...each]; latest = new Map(); each = []; return batch; },
    get size() { return latest.size + each.length; },
  };
}
