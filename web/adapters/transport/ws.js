// Transport adapter: one board stream over a browser WebSocket. Implements web/ports/transport.js (contract test:
// test/web/contracts/transport-contract.js, run in test/web/adapters/transport-ws.test.js).
//
// Imports: its own port (web/ports/transport.js, for the limits) and packages/protocol/codec.js. The codec is the one
// protocol import a web adapter may make (the boundary test's allowlist: web/adapters/transport/ws.js →
// packages/protocol/codec.js). Nothing else from protocol, no other adapter, no core.
//
// Rules:
//   - One WebSocket per connection; each socket is a generation. reopen() detaches and closes the current socket
//     and opens a new one; from that moment nothing from an older socket (message, error, close) is delivered.
//   - send() before the socket is open queues on THAT socket (≤ maxQueued messages and ≤ maxQueuedBytes) and goes
//     out on open; a reopen drops the queue with the socket. Past either cap the link counts as dead: the socket is
//     closed at once and onDrop is reported on a later microtask (never on the caller's stack, p6-edgev LOW-2), and
//     only if that socket is still current by then (a reopen in between swallows it).
//   - Backpressure (the port's congested() and hard cap): backlog = queued bytes + ws.bufferedAmount. congested()
//     is backlog > watermark. Over hardCapBytes, a clock timer samples the backlog every sampleMs. Drain progress
//     between two samples = last backlog + bytes added since − backlog now (so a link that drains while the core
//     adds more still counts as moving). Over the cap with no progress for hardCapMs is a drop (closed, onDrop
//     once); any progress restarts the count, so a slow but moving link is never dropped (manager decision,
//     2026-11-12). The timer belongs to its socket and dies with it.
//   - onDrop: only the current socket's unasked close or error (connect refused, the server or a proxy closing, a
//     frame the codec rejects), at most once per socket. Never for reopen() or close().
//   - close() is final: the socket is closed, nothing more is delivered, send/reopen do nothing.
//   - No token here at all: the URL is used exactly as given and no subprotocol is passed (Sec-WebSocket-Protocol
//     is a header). The token travels only in the `hello` the core sends (PROTOCOL.md, Herdr refuses credential headers).
//   - Never throws for a network reason; a frame it cannot decode never throws out of the socket's event handler (only
//     the core's own onMessage handler can, which is the core's bug to see). Retry and backoff live in
//     the core (Replica.reconnectWait), never here.

import { jsonCodec } from "../../../packages/protocol/codec.js";
import { CONGESTED_BYTES, HARD_CAP_BYTES, HARD_CAP_MS, HARD_CAP_SAMPLE_MS } from "../../ports/transport.js";

const CONNECTING = 0, OPEN = 1;

/** Bytes a frame takes on the wire: UTF-8 length of a text frame, byteLength of a binary one. */
export function frameBytes(data) {
  if (typeof data === "string") {
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  return data?.byteLength ?? data?.size ?? 0;
}

/** The clock when the root passes none: the browser's timers (an adapter may touch globals). */
const globalClock = {
  mono: () => (globalThis.performance?.now?.() ?? Date.now()),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: h => clearTimeout(h),
};

/**
 * @param {{ url: string, WebSocket: new (url: string) => any,
 *           codec?: import("../../../packages/protocol/codec.js").Codec, maxQueued?: number, maxQueuedBytes?: number,
 *           clock?: Pick<import("../../ports/clock.js").Clock, "mono" | "set" | "clear">,
 *           watermark?: number, hardCapBytes?: number, hardCapMs?: number, sampleMs?: number }} o
 *   url: the gateway's ws(s)://…/ws URL (the composition root derives it from the page's origin).
 *   WebSocket: the constructor (the root passes globalThis.WebSocket; tests pass a fake). codec: default JSON.
 *   clock: the clock port (the root passes it; without one, the global timers). The limits default to the port's.
 * @returns {import("../../ports/transport.js").Transport}
 */
export function wsTransport({ url, WebSocket: WS, codec = jsonCodec, maxQueued = 1024, maxQueuedBytes = HARD_CAP_BYTES,
  clock = globalClock, watermark = CONGESTED_BYTES, hardCapBytes = HARD_CAP_BYTES, hardCapMs = HARD_CAP_MS,
  sampleMs = HARD_CAP_SAMPLE_MS }) {
  if (typeof WS !== "function") throw new TypeError("wsTransport: WebSocket constructor is required");
  let done = false;
  let onMsg = () => {};
  /** @type {(() => void) | null} */
  let onDrop = null;
  /** @type {{ ws: any, queue: any[], queueBytes: number, dropped: boolean, overSince: number | null, timer: any,
   *            lastBacklog: number, added: number } | null} */
  let cur = null;

  /** Stop listening to a socket and close it (a close the client asked for: never reported). */
  function retire(c) {
    if (!c) return;
    c.dropped = true;
    c.queue = [];
    c.queueBytes = 0;
    if (c.timer !== null) { try { clock.clear(c.timer); } catch {} c.timer = null; }
    const ws = c.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(1000); } catch {}
  }

  /** The current socket died without the client asking: report it once, then let the core reopen. */
  function fail(c) {
    if (c !== cur || c.dropped || done) return;
    retire(c);
    try { onDrop?.(); } catch {}
  }

  /** A drop found inside send(): the socket is closed now, the report waits a microtask (and a reopen voids it). */
  function failLater(c) {
    if (c !== cur || c.dropped || done) return;
    retire(c);
    Promise.resolve().then(() => { if (c === cur && !done) { try { onDrop?.(); } catch {} } });
  }

  /** Outbound bytes not yet on the wire for this socket. */
  function backlog(c) {
    let b = 0;
    try { b = Number(c.ws?.bufferedAmount) || 0; } catch {}
    return c.queueBytes + b;
  }

  /** Hard cap: start sampling when the backlog passes the cap. A sample at or under it ends the hold; a sample that
   *  saw bytes leave restarts it; hardCapMs over the cap with nothing leaving is a drop. */
  function watchCap(c) {
    if (c.timer !== null || c.dropped || backlog(c) <= hardCapBytes) return;
    c.overSince = clock.mono();
    c.lastBacklog = backlog(c);
    c.added = 0;
    const sample = () => {
      c.timer = null;
      if (c !== cur || c.dropped || done) return;
      const b = backlog(c);
      if (b <= hardCapBytes) { c.overSince = null; return; }
      const drained = c.lastBacklog + c.added - b;
      c.lastBacklog = b; c.added = 0;
      if (drained > 0) c.overSince = clock.mono();
      else if (clock.mono() - c.overSince >= hardCapMs) { fail(c); return; }
      c.timer = clock.set(sample, sampleMs);
    };
    c.timer = clock.set(sample, sampleMs);
  }

  function open() {
    retire(cur);
    cur = null;
    if (done) return;
    const c = { ws: null, queue: [], queueBytes: 0, dropped: false, overSince: null, timer: null, lastBacklog: 0, added: 0 };
    cur = c;
    try { c.ws = new WS(url); } catch {
      Promise.resolve().then(() => fail(c));            // a bad URL: a drop like any other, never a throw
      return;
    }
    const ws = c.ws;
    try { ws.binaryType = "arraybuffer"; } catch {}
    ws.onopen = () => {
      if (c !== cur || c.dropped) return;
      const q = c.queue;
      c.queue = [];
      c.queueBytes = 0;
      for (const data of q) {
        try { ws.send(data); } catch { fail(c); return; }
      }
      watchCap(c);
    };
    ws.onmessage = e => {
      if (c !== cur || c.dropped || done) return;
      let msg;
      try { msg = codec.decode(e.data); } catch { fail(c); return; }
      onMsg(msg);
    };
    ws.onerror = () => fail(c);
    ws.onclose = () => fail(c);
  }

  open();

  return {
    send(msg) {
      const c = cur;
      if (done || !c || c.dropped || !c.ws) return;
      const data = codec.encode(msg);                    // a message the codec can't encode is a bug: it throws
      const state = c.ws.readyState;
      if (state === OPEN) {
        try { c.ws.send(data); } catch { failLater(c); return; }
        c.added += frameBytes(data);
        watchCap(c);
      } else if (state === CONNECTING) {
        c.queue.push(data);
        const n = frameBytes(data);
        c.queueBytes += n;
        c.added += n;
        if (c.queue.length > maxQueued || c.queueBytes > maxQueuedBytes) failLater(c);
        else watchCap(c);
      }
      // CLOSING / CLOSED: the close event reports the drop.
    },
    onMessage(fn) { onMsg = fn; },
    onDrop(fn) { onDrop = fn; },
    congested() {
      const c = cur;
      if (done || !c || c.dropped) return false;
      return backlog(c) > watermark;
    },
    reopen() { if (!done) open(); },
    close() { done = true; retire(cur); cur = null; },
  };
}
