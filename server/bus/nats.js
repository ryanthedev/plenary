// The Bus port on NATS core (PROTOCOL.md § Bus), for a cluster. Same contract as server/bus/memory.js:
//   - exact subjects, no wildcards (every subject is checked: [a-z0-9-] tokens joined by ".");
//   - at-most-once (NATS core, no JetStream): a message published with no subscriber is gone; a subscriber that
//     throws loses that message;
//   - per subject, this process's subscribers get messages in the order the server delivers them (publish order
//     for one publishing connection; no order across publishers on different nodes);
//   - delivery is asynchronous (a publisher is never re-entered by its own subscribers).
// Unlike memory.js, messages are serialised: publish plain data only. Strings, numbers, booleans, null, arrays and
// plain objects travel as JSON; a Uint8Array is allowed only as a top-level field of the message (e.g. `data` from
// a binary codec) and travels as raw bytes after the JSON, located by a header, so nothing inside a client-authored
// field can forge bytes. A message is at most 2 MB encoded, headers included (MAX_BUS_BYTES); bigger is refused
// before the wire.
//
// One NATS subscription per subject, fanned out locally to this process's handlers (keeps memory.js's order:
// each message goes to every local handler before the next message).
//
// The client library is loaded on first use (dynamic import), so a process that never builds a NATS bus never
// needs node_modules.

import { PortError } from "../ids.js";
export { subjects } from "./port.js";

/** § Bus: a deployment's bus must carry 2 MB messages. Bigger publishes are refused (PortError "too-large"). */
import { MAX_BUS_BYTES } from "./port.js";
export { MAX_BUS_BYTES };

const SUBJECT = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const isSubject = s => typeof s === "string" && s.length <= 512 && SUBJECT.test(s);
const BYTES_HEADER = "Plen-Bytes";     // JSON [[key, length], …] for the top-level Uint8Array fields, in payload order

const enc = new TextEncoder(), dec = new TextDecoder();
// Header-named keys that would reach an object's prototype instead of a field (a foreign publisher could send them).
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Message → { payload, byteFields } (byteFields null when the message has no top-level bytes).
 * @returns {{ payload: Uint8Array, byteFields: [string, number][] | null }}
 */
export function encodeMessage(msg) {
  let body = msg, parts = null, byteFields = null;
  if (msg && typeof msg === "object" && !Array.isArray(msg) && !(msg instanceof Uint8Array)) {
    for (const k of Object.keys(msg)) {
      if (msg[k] instanceof Uint8Array) {
        if (!parts) { body = { ...msg }; parts = []; byteFields = []; }
        delete body[k]; parts.push(msg[k]); byteFields.push([k, msg[k].byteLength]);
      }
    }
  } else if (msg instanceof Uint8Array) throw new PortError("bad-entry", "a bus message must be plain data, not bare bytes");
  const json = JSON.stringify(body, function (key, value) {
    if (value instanceof Uint8Array || this[key] instanceof Uint8Array)     // `this[key]` catches Buffer (it has toJSON)
      throw new PortError("bad-entry", "bytes are allowed only as a top-level field of a bus message");
    if (typeof value === "bigint") throw new PortError("bad-entry", "a bus message can't carry a bigint");
    return value;
  });
  if (json === undefined) throw new PortError("bad-entry", "a bus message must be plain data");
  const text = enc.encode(json);
  if (!parts) return { payload: text, byteFields: null };
  let size = text.byteLength; for (const p of parts) size += p.byteLength;
  const payload = new Uint8Array(size);
  payload.set(text); let at = text.byteLength;
  for (const p of parts) { payload.set(p, at); at += p.byteLength; }
  return { payload, byteFields };
}

/** The inverse of encodeMessage. `byteFields` comes from the header, never from the payload. */
export function decodeMessage(payload, byteFields) {
  if (!byteFields) return JSON.parse(dec.decode(payload));
  if (!Array.isArray(byteFields) || !byteFields.every(f => Array.isArray(f) && f.length === 2 && typeof f[0] === "string"
      && !BAD_KEYS.has(f[0]) && Number.isSafeInteger(f[1]) && f[1] >= 0))
    throw new PortError("bad-entry", "a bus message with a malformed byte-field header");
  let tail = 0; for (const [, n] of byteFields) tail += n;
  const jsonEnd = payload.byteLength - tail;
  if (jsonEnd < 0) throw new PortError("bad-entry", "a bus message shorter than its byte fields");
  const msg = JSON.parse(dec.decode(payload.subarray(0, jsonEnd)));
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new PortError("bad-entry", "byte fields on a message that isn't an object");
  let at = jsonEnd;
  for (const [k, n] of byteFields) { msg[k] = new Uint8Array(payload.subarray(at, at + n)); at += n; }   // a plain copy: NATS hands a Buffer view of its read buffer
  return msg;
}

/**
 * NATS_URL → the client's connect options (p4-wire2 M1). The NATS client drops a URL's userinfo, so it is cut out
 * here: `user:pass@` becomes `{ user, pass }`, a bare `token@` becomes `{ token }` (percent-decoded), and the server
 * goes on without it. `url` is one URL, a comma-separated list or an array; each element may omit the scheme
 * (`host:4222`). The rest of each element (scheme, host, port, path) is kept verbatim. The client takes one set of
 * credentials for every server, so servers that carry different ones are refused ("bad-config"). No error here ever
 * contains a value from the URL.
 * @returns {{ servers: string[], user?: string, pass?: string, token?: string }}
 */
export function natsConnectOptions(url) {
  const list = (Array.isArray(url) ? url : [url]).flatMap(u => String(u ?? "").split(",")).map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new TypeError("natsBus needs a url");
  const decode = x => { try { return decodeURIComponent(x); } catch { return x; } };
  const servers = [];
  let auth = null, authKey = null;
  for (const s of list) {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s)?.[0] ?? "";
    const rest = s.slice(scheme.length);
    const end = rest.search(/[/?#]/);
    const authority = end < 0 ? rest : rest.slice(0, end), tail = end < 0 ? "" : rest.slice(end);
    const at = authority.lastIndexOf("@");
    const host = at < 0 ? authority : authority.slice(at + 1);
    if (!host) throw new PortError("bad-config", "a NATS server URL has no host");
    servers.push(scheme + host + tail);
    const info = at < 0 ? "" : authority.slice(0, at);
    if (!info) continue;
    const colon = info.indexOf(":");
    const a = colon < 0 ? { token: decode(info) } : { user: decode(info.slice(0, colon)), pass: decode(info.slice(colon + 1)) };
    if (colon >= 0 && !a.user) throw new PortError("bad-config", "a NATS server URL has a password but no user");
    const key = JSON.stringify(a);
    if (auth && key !== authKey) throw new PortError("bad-config", "the NATS server URLs carry different credentials; the NATS client takes one set for every server");
    auth = a; authKey = key;
  }
  return { servers, ...(auth ?? {}) };
}

/**
 * Connects to NATS and returns a Bus. Rejects if the server can't carry 2 MB messages (max_payload).
 * Credentials in `url` (user:pass@ or token@) go to the client as options (natsConnectOptions).
 *
 * Outages: the client reconnects forever. While it is disconnected (from the `disconnect` status event until
 * `reconnect`), publish is refused with PortError("unavailable"), so nothing piles up in memory; at-most-once
 * allows the drop, and § Bus repairs entries from the Store. onError hears about each outage once, when it starts,
 * not once per refused publish. Whatever the client had buffered in the moment before it noticed is discarded by
 * the client on reconnect (nats-core resets its outbound buffer before every dial), so stale presence never
 * replays. After a reconnect, max_payload is checked again; a server that can't carry 2 MB keeps publishes refused
 * ("bad-config") until a reconnect to one that can.
 *
 * Stalls: a server that stops reading without closing the socket (frozen process, silent partition, VM pause, an LB
 * dropping the flow without a reset) sends no `disconnect`. Two things catch it:
 *   - pings every `pingIntervalMs` (default 5 s), stale after `maxPingOut` (default 2) unanswered: ~10-15 s;
 *   - a cap on unacknowledged bytes: every byte published counts as pending until a flush round trip (PING/PONG,
 *     which the server answers only after it has read everything sent before it) confirms it. A publish that would
 *     take it past `maxPendingBytes` (default 32 MB) is refused ("unavailable", reported once per episode) until
 *     acks bring it under half the cap. So memory is bounded even inside the ping window, and a healthy but busy
 *     connection only sheds load (no reconnect).
 * On stale pings the bus goes down ("unavailable", reported once) and the socket is destroyed. That matters: nats.js's
 * own stale handling closes the transport by first awaiting a write, which never completes against a frozen server
 * with a full socket buffer, so the client sat "stale" until the server woke and then delivered everything queued
 * (checked, nats-core 3.4.0). Destroying the socket drops what is queued in this process and makes the client
 * reconnect; only what already reached the server's kernel receive buffer can still arrive (one message in the
 * SIGSTOP test). Destroying it reaches into the client (`nc.protocol.transport.socket`); if a client update moves
 * that, the bus still goes down and refuses, but drops nothing queued until the client's own stale handling ends.
 * @param {{ url: string | string[], name?: string, onError?: (err: unknown, subject: string) => void,
 *           connectTimeoutMs?: number, reconnectWaitMs?: number, pingIntervalMs?: number, maxPingOut?: number,
 *           maxPendingBytes?: number, ackEveryMs?: number, connect?: Function }} o — `url` from the caller (NATS_URL
 *           in deploy); nothing is read from env here. connect: the client's connect (tests pass a fake).
 */
export async function natsBus({ url, name = "plenary", onError = () => {}, connectTimeoutMs = 5000, reconnectWaitMs = 2000,
  pingIntervalMs = 5000, maxPingOut = 2, maxPendingBytes = 32 * 1024 * 1024, ackEveryMs = 250, connect: connectFn } = {}) {
  if (!url || (typeof url !== "string" && !Array.isArray(url))) throw new TypeError("natsBus needs a url");
  const target = natsConnectOptions(url);
  const lib = await import("@nats-io/transport-node");
  const connect = connectFn ?? lib.connect, makeHeaders = lib.headers;
  for (const [k, v] of Object.entries({ pingIntervalMs, maxPingOut, maxPendingBytes, ackEveryMs }))
    if (!Number.isFinite(v) || v <= 0) throw new TypeError(`natsBus ${k} must be a positive number`);
  if (maxPendingBytes < MAX_BUS_BYTES) throw new TypeError(`natsBus maxPendingBytes must be at least ${MAX_BUS_BYTES}`);
  const nc = await connect({ ...target, name, timeout: connectTimeoutMs, maxReconnectAttempts: -1, reconnectTimeWait: reconnectWaitMs,
    pingInterval: pingIntervalMs, maxPingOut });
  const serverMax = nc.info?.max_payload ?? 0;
  if (serverMax < MAX_BUS_BYTES) {
    await nc.close().catch(() => {});
    throw new PortError("bad-config", `NATS max_payload is ${serverMax}; PROTOCOL.md § Bus needs at least ${MAX_BUS_BYTES} (set max_payload: 2MB)`);
  }

  /** @type {Map<string, { set: Set<Function>, sub: any }>} */
  const subs = new Map();
  let closed = false;
  /** null while connected and usable; otherwise the PortError publish answers with. */
  let down = null;
  const report = (err, subject) => { try { onError(err, subject); } catch { /* onError must not throw into us */ } };
  const goDown = why => { if (!down) { down = new PortError("unavailable", `the NATS connection is ${why}; publishes are dropped until it reconnects`); report(down, ""); } };

  // Unacknowledged bytes (see "Stalls" above). `epoch` changes on every disconnect, so an old flush can't credit a
  // new connection.
  let pending = 0, acking = false, ackTimer = null, epoch = 0, congested = null;
  const ack = () => {
    ackTimer = null;
    if (acking || closed || down || !pending) return;
    acking = true;
    const covered = pending, mine = epoch;
    nc.flush().then(
      () => {
        if (mine !== epoch) return;
        pending = Math.max(0, pending - covered);
        if (congested && pending <= maxPendingBytes / 2) congested = null;
      },
      () => { /* disconnected meanwhile; the status loop resets */ },
    ).finally(() => { acking = false; if (pending && !closed && !down) scheduleAck(); });
  };
  const scheduleAck = () => { if (!ackTimer && !acking) { ackTimer = setTimeout(ack, ackEveryMs); ackTimer.unref?.(); } };
  /** Declares a stall: down, and the socket destroyed so what is queued in this process is dropped, not replayed. */
  const stall = why => {
    goDown(why);
    epoch++; pending = 0; congested = null; acking = false;   // a flush to the dead socket may never settle
    try { nc.protocol?.transport?.socket?.destroy(); } catch { /* the client's internals moved; see the comment above */ }
  };

  (async () => {
    for await (const s of nc.status()) {
      if (closed) return;
      if (s.type === "staleConnection") stall("stale (no answer to pings)");
      else if (s.type === "disconnect" || s.type === "reconnecting") { epoch++; pending = 0; congested = null; acking = false; goDown("down"); }
      else if (s.type === "reconnect") {
        epoch++; pending = 0; congested = null;
        const max = nc.info?.max_payload ?? 0;
        if (max < MAX_BUS_BYTES) {
          down = new PortError("bad-config", `NATS max_payload is ${max} after a reconnect; PROTOCOL.md § Bus needs at least ${MAX_BUS_BYTES}`);
          report(down, "");
        } else down = null;
      }
    }
  })().catch(err => report(err, ""));

  const deliver = (subject, msg, set) => {
    for (const fn of [...set]) {
      if (!set.has(fn)) continue;                 // unsubscribed while this message was being handed out
      try {
        const r = fn(msg, subject);
        if (r && typeof r.then === "function") r.then(undefined, err => onError(err, subject));
      } catch (err) { onError(err, subject); }
    }
  };

  // A refusal reaches an awaiting caller as a rejection and a fire-and-forget caller through onError, never as an
  // unhandled rejection (gateway.js and room-host.js don't await publish).
  const refuse = (err, subject, quiet = false) => {
    if (!quiet) report(err, subject);
    const p = Promise.reject(err); p.catch(() => {}); return p;
  };

  return {
    maxBytes: MAX_BUS_BYTES,
    /** Resolves once the message is handed to the client (not once it is delivered: there is no delivery receipt). */
    publish(subject, msg) {
      if (closed) return Promise.resolve();
      if (down) return refuse(down, subject, true);             // reported once, when the outage began
      if (!isSubject(subject)) return refuse(new PortError("bad-id", `bad bus subject ${JSON.stringify(String(subject)).slice(0, 80)}`), String(subject));
      let encoded;
      try { encoded = encodeMessage(msg); } catch (err) { return refuse(err, subject); }
      const { payload, byteFields } = encoded;
      // NATS counts headers toward max_payload, so the cap covers them too.
      const h = byteFields ? makeHeaders() : null;
      if (h) h.set(BYTES_HEADER, JSON.stringify(byteFields));
      const size = payload.byteLength + (h ? h.encode().byteLength : 0);
      if (size > MAX_BUS_BYTES)
        return refuse(new PortError("too-large", `a bus message is limited to ${MAX_BUS_BYTES} bytes, headers included (this one is ${size})`), subject);
      if (congested) return refuse(congested, subject, true);
      if (pending + size > maxPendingBytes) {
        congested = new PortError("unavailable", `NATS is not keeping up (over ${maxPendingBytes} bytes unacknowledged); publishes are dropped until it catches up`);
        report(congested, subject);
        scheduleAck();
        return refuse(congested, subject, true);
      }
      try {
        if (h) nc.publish(subject, payload, { headers: h });
        else nc.publish(subject, payload);
        pending += size; scheduleAck();
      } catch (err) { return refuse(err, subject); }
      return Promise.resolve();
    },

    /** @returns {() => void} unsubscribe (idempotent) */
    subscribe(subject, fn) {
      if (typeof subject !== "string" || typeof fn !== "function") throw new TypeError("subscribe(subject, fn)");
      if (!isSubject(subject)) throw new PortError("bad-id", "bad bus subject");
      if (closed) return () => {};
      let entry = subs.get(subject);
      if (!entry) {
        const set = new Set();
        const sub = nc.subscribe(subject, {
          callback: (err, m) => {
            if (err) { onError(err, subject); return; }
            if (closed || !set.size) return;
            let msg;
            try {
              const raw = m.headers?.get(BYTES_HEADER);
              msg = decodeMessage(m.data, raw ? JSON.parse(raw) : null);
            } catch (e) { onError(e, subject); return; }
            deliver(subject, msg, set);
          },
        });
        entry = { set, sub };
        subs.set(subject, entry);
      }
      entry.set.add(fn);
      const mine = entry;
      return () => {
        if (!mine.set.delete(fn) || mine.set.size) return;
        if (subs.get(subject) === mine) subs.delete(subject);
        try { mine.sub.unsubscribe(); } catch { /* connection already closed */ }
      };
    },

    /**
     * Resolves after a round trip to the server: everything this process published so far has reached the server,
     * and every message the server had for this process's subscriptions by then has been handed to them (NATS
     * answers a PING after the messages it queued before it). Says nothing about other nodes' subscribers.
     */
    async flush() { if (!closed) await nc.flush(); },
    subscriberCount: subject => subs.get(subject)?.set.size ?? 0,
    /** True while publishes go out (connected, and the server carries 2 MB). For /health and tests. */
    isUp: () => !closed && !down && !congested,
    async close() {
      if (closed) return;
      closed = true; subs.clear();
      if (ackTimer) clearTimeout(ackTimer);
      // nc.close() flushes first, which never finishes against a frozen server with a full socket: bound it.
      let t;
      const gaveUp = await Promise.race([nc.close().then(() => false, () => false), new Promise(r => { t = setTimeout(() => r(true), 2000); })]);
      clearTimeout(t);
      if (gaveUp) try { nc.protocol?.transport?.socket?.destroy(); } catch { /* best effort */ }
    },
  };
}
