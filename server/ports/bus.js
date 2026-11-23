// @ts-check
// The Bus port (PROTOCOL.md § Bus): subject names, the message size cap and how a message is measured. Port-level,
// so the core (gateway, room host, feed) imports this and never an adapter; memory.js and nats.js implement it.
//
// Contract every adapter keeps: exact subjects, at-most-once, ordered per subject, asynchronous delivery, and a
// publish over MAX_BUS_BYTES is refused (the returned promise rejects with PortError "too-large"; nothing is sent).
// Every adapter also has `flush()` (resolves once what was published so far has left this process: memory hands it
// to subscribers, NATS does its round trip, an adapter with nothing to wait for resolves at once) and `maxBytes`
// (its message cap). Core code calls flush() unconditionally (p-audit F15).

import { needId, isClusterId, PortError } from "../core/ids.js";

/** The members every Bus adapter has (test/server/adapter-surface.test.js). Adapter extras: `subscriberCount` (both), `isUp()` (NATS connection state); neither is called by core. */
export const BUS_MEMBERS = Object.freeze(["publish", "subscribe", "flush", "close", "maxBytes"]);

/**
 * Ordered per subject for one publisher; no order across publishers.
 * @typedef {object} Bus
 * @property {(subject: string, msg: Record<string, any>) => Promise<void>} publish
 *   Fire and forget, at-most-once, asynchronous delivery. msg is plain data (a top-level Uint8Array field is allowed).
 *   Rejects PortError "too-large" over MAX_BUS_BYTES (nothing sent); "unavailable" while a networked bus is down (dropped, not queued);
 *   "bad-id" / TypeError for a bad subject. After close(): resolves, delivers nothing.
 * @property {(subject: string, fn: (msg: Record<string, any>, subject: string) => void) => () => void} subscribe
 *   Exact subject, no wildcards. One handler subscribed twice is one subscription. Returns an idempotent unsubscribe.
 *   A handler that throws or rejects loses that message only (onError hears it); others and later messages are unaffected.
 * @property {() => Promise<void>} flush  resolves once everything published so far has left this process
 * @property {() => Promise<void>} close
 * @property {number} maxBytes  the message cap (MAX_BUS_BYTES)
 */

/** § Bus: no message the protocol needs is over 2 MB (NATS: max_payload, headers included). */
export const MAX_BUS_BYTES = 2 * 1024 * 1024;

/** UTF-8 bytes of a JS string, without TextEncoder or Buffer (one pass). */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** The size a bus adapter counts for a plain-data message: its JSON, in UTF-8 bytes (what NATS carries). */
export const busBytes = msg => utf8Length(JSON.stringify(msg) ?? "");

/** Subject names. Every id is checked, so a subject can't be widened or pointed at another tenant. */
export const subjects = {
  /** Room → gateways, after an append resolves: { items: [entry JSON text…], from, to }, or the heartbeat { seq, epoch }. */
  entries: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.entries`,
  /** Gateway → gateways: { gateway, user, client, msg } presence, or { gateway, user, client, leave: true }. Never saved. */
  presence: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.presence`,
  /** Gateway → gateways: { gateway, … } who is on the board through that gateway (PROTOCOL.md § Presence, `here`). Never saved. */
  here: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.here`,
  /** Gateway → gateways: { gateway, window, counts } viewers' emotes per 500 ms window. Never saved. */
  emotes: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.emotes`,
  /** Gateway → room: { n, conn, gateway, user, name, role, client, msg }, { n, conn, gateway, closed: true }, or { gateway, conns }. */
  inbox: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.inbox`,
  /** Anyone who changes a board's grants, invites or links → gateways: { board }. Gateways re-check their connections' roles. */
  grants: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.grants`,
  /** Room → gateway: { conn, data, close? } (welcome, ack, error only), per board (§ Bus). */
  gateway: (tenant, board, gateway) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.gw.${needId(gateway, "gateway")}`,
  /** Gateway-only node → every room host: { tenant, board, gateway, n } "make sure this board is served" (p4-wire). */
  open: "plen-hosts.open",
  /** Room host → the requester that asked: { n, board, state: "held" | "watching" }, after its local open settled. */
  opened: requester => `plen-hosts.opened.${needId(requester, "requester")}`,
};

/**
 * Scopes a bus to one cluster (PROTOCOL.md § Bus, Cluster id): every subject this process publishes or subscribes
 * on the wire is `<cluster>.<subject>`, so two clusters on one NATS server never hear each other. The core keeps
 * building subjects with `subjects` above and never sees the prefix; handlers get the subject without it (and so
 * does `onError`: build it with `scopeOnError`). A cluster id is "c-" + 16 of [a-z0-9]: it can't equal the first
 * token of an unscoped subject (`plen`, `plen-gw`, `plen-hosts`), so an old node's traffic and a scoped node's
 * never share a subject either. A handler subscribed twice to one subject is still one subscription (the adapters
 * keep handlers in a Set), so this keeps one wrapper per (subject, handler).
 * Every other adapter member (flush, close, maxBytes, subscriberCount, isUp, ...) is the underlying bus's own.
 * @template {{ publish: Function, subscribe: Function, subscriberCount?: (subject: string) => number }} B
 * @param {B} bus
 * @param {string} cluster
 * @returns {B}
 */
export function scopeBus(bus, cluster) {
  if (!isClusterId(cluster)) throw new PortError("bad-id", "bad cluster id");
  const prefix = cluster + ".";
  /** @type {Map<string, Map<Function, Function>>} subject → handler → its wrapper */
  const wrappers = new Map();
  return {
    ...bus,
    publish: (subject, msg) => bus.publish(prefix + subject, msg),
    subscribe(subject, fn) {
      if (typeof subject !== "string" || typeof fn !== "function") throw new TypeError("subscribe(subject, fn)");   // as the adapters do
      let byFn = wrappers.get(subject);
      if (!byFn) wrappers.set(subject, byFn = new Map());
      let w = byFn.get(fn);
      if (!w) byFn.set(fn, w = (msg, wire) => fn(msg, typeof wire === "string" ? wire.slice(prefix.length) : wire));
      const off = bus.subscribe(prefix + subject, w);
      return () => {
        off();
        if (byFn.get(fn) === w) { byFn.delete(fn); if (!byFn.size && wrappers.get(subject) === byFn) wrappers.delete(subject); }
      };
    },
    ...(bus.subscriberCount ? { subscriberCount: subject => bus.subscriberCount(prefix + subject) } : {}),
  };
}

/** An adapter's `onError` for a scoped bus: it hears the subject without the cluster prefix, like a handler does. */
export const scopeOnError = (onError, cluster) => {
  const prefix = cluster + ".";
  return (err, subject) => onError(err, typeof subject === "string" && subject.startsWith(prefix) ? subject.slice(prefix.length) : subject);
};
