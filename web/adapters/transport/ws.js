// Transport adapter: one board stream over a browser WebSocket. Implements web/ports/transport.js (contract test:
// test/web/contracts/transport-contract.js, run in test/web/adapters/transport-ws.test.js).
//
// Imports: packages/protocol/codec.js ONLY. It is the one protocol import a web adapter may make (the boundary
// test's allowlist: web/adapters/transport/ws.js → packages/protocol/codec.js). Nothing else from protocol, no
// other adapter, no core.
//
// Rules:
//   - One WebSocket per connection; each socket is a generation. reopen() detaches and closes the current socket
//     and opens a new one; from that moment nothing from an older socket (message, error, close) is delivered.
//   - send() before the socket is open queues on THAT socket (≤ maxQueued messages) and goes out on open; a
//     reopen drops the queue with the socket. Past maxQueued the link counts as dead (closed, onDrop).
//   - onDrop: only the current socket's unasked close or error (connect refused, the server or a proxy closing, a
//     frame the codec rejects), at most once per socket. Never for reopen() or close().
//   - close() is final: the socket is closed, nothing more is delivered, send/reopen do nothing.
//   - No token here at all: the URL is used exactly as given and no subprotocol is passed (Sec-WebSocket-Protocol
//     is a header). The token travels only in the `hello` the core sends (PROTOCOL.md, Herdr refuses credential headers).
//   - Never throws for a network reason; a frame it cannot decode never throws out of the socket's event handler (only
//     the core's own onMessage handler can, which is the core's bug to see). Retry and backoff live in
//     the core (Replica.reconnectWait), never here.

import { jsonCodec } from "../../../packages/protocol/codec.js";

const CONNECTING = 0, OPEN = 1;

/**
 * @param {{ url: string, WebSocket: new (url: string) => any,
 *           codec?: import("../../../packages/protocol/codec.js").Codec, maxQueued?: number }} o
 *   url: the gateway's ws(s)://…/ws URL (the composition root derives it from the page's origin).
 *   WebSocket: the constructor (the root passes globalThis.WebSocket; tests pass a fake). codec: default JSON.
 * @returns {import("../../ports/transport.js").Transport}
 */
export function wsTransport({ url, WebSocket: WS, codec = jsonCodec, maxQueued = 1024 }) {
  if (typeof WS !== "function") throw new TypeError("wsTransport: WebSocket constructor is required");
  let done = false;
  let onMsg = () => {};
  /** @type {(() => void) | null} */
  let onDrop = null;
  /** @type {{ ws: any, queue: any[], dropped: boolean } | null} */
  let cur = null;

  /** Stop listening to a socket and close it (a close the client asked for: never reported). */
  function retire(c) {
    if (!c) return;
    c.dropped = true;
    c.queue = [];
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

  function open() {
    retire(cur);
    cur = null;
    if (done) return;
    const c = { ws: null, queue: [], dropped: false };
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
      for (const data of q) {
        try { ws.send(data); } catch { fail(c); return; }
      }
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
        try { c.ws.send(data); } catch { fail(c); }
      } else if (state === CONNECTING) {
        c.queue.push(data);
        if (c.queue.length > maxQueued) fail(c);
      }
      // CLOSING / CLOSED: the close event reports the drop.
    },
    onMessage(fn) { onMsg = fn; },
    onDrop(fn) { onDrop = fn; },
    reopen() { if (!done) open(); },
    close() { done = true; retire(cur); cur = null; },
  };
}
