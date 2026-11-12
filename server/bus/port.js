// The Bus port (PROTOCOL.md § Bus): subject names, the message size cap and how a message is measured. Port-level,
// so the core (gateway, room host, feed) imports this and never an adapter; memory.js and nats.js implement it.
//
// Contract every adapter keeps: exact subjects, at-most-once, ordered per subject, asynchronous delivery, and a
// publish over MAX_BUS_BYTES is refused (the returned promise rejects with PortError "too-large"; nothing is sent).
// Every adapter also has `flush()` (resolves once what was published so far has left this process: memory hands it
// to subscribers, NATS does its round trip, an adapter with nothing to wait for resolves at once) and `maxBytes`
// (its message cap). Core code calls flush() unconditionally (p-audit F15).

import { needId } from "../ids.js";

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
  /** Gateway → gateways: { gateway, window, counts } viewers' emotes per 500 ms window. Never saved. */
  emotes: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.emotes`,
  /** Gateway → room: { n, conn, gateway, user, name, role, client, msg }, { n, conn, gateway, closed: true }, or { gateway, conns }. */
  inbox: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.inbox`,
  /** Anyone who changes a board's grants, invites or links → gateways: { board }. Gateways re-check their connections' roles. */
  grants: (tenant, board) => `plen.${needId(tenant, "tenant")}.${needId(board, "board")}.grants`,
  /** Room → gateway: { conn, data, close? } (welcome, ack, error only). SEAM(p4): § Bus names it per board, `plen.<tenant>.<board>.gw.<gateway>`. */
  gateway: gateway => `plen-gw.${needId(gateway, "gateway")}`,
};
