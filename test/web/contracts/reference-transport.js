// A tiny reference transport (not an app adapter): the smallest thing that keeps the transport contract, so the
// contract itself is tested (reference-transport.test.js). Async like a SharedWorker port: the far side reads the
// client's messages and the client reads the far side's on later tasks (setTimeout 0, like a MessagePort), so stale deliveries really happen
// and only the generation check stops them.
//
// Far side: answers { t: "req", i } with { t: "ans", i } on the same connection; ignores anything else.
// Backpressure: a stalled connection keeps what the client sends in `up` (its outbound backlog, counted in JSON
// bytes; trickle(n) reads n of them while staying stalled); the hard cap runs on a virtual clock (the driver's
// advance), sampled like the port says.

import { virtualClock } from "../../../web/adapters/clock/virtual.js";
import { CONGESTED_BYTES, HARD_CAP_BYTES, HARD_CAP_MS, HARD_CAP_SAMPLE_MS } from "../../../web/ports/transport.js";

/** @returns {import("./transport-contract.js").TransportDriver} */
export function referenceTransport() {
  let gen = 0, done = false, onMsg = () => {}, onDrop = () => {};
  const clock = virtualClock();
  /** @type {{ gen: number, up: object[], bytes: number, open: boolean, stalled: boolean, overSince: number | null, timer: any } | null} */
  let conn = null;

  // ── far side ──
  function serve(c) {                                       // read what the client sent on c, queue the answers
    while (c.open && !c.stalled && c.up.length) {
      const m = c.up.shift();
      c.bytes = Math.max(0, c.bytes - JSON.stringify(m).length);
      if (m?.t === "req") setTimeout(() => { if (c.gen === gen && !done) onMsg({ t: "ans", i: m.i }); }, 0);
    }
  }
  function retire(c) {
    if (!c) return;
    c.open = false;
    c.up = []; c.bytes = 0;
    if (c.timer !== null) { clock.clear(c.timer); c.timer = null; }
  }
  function watchCap(c) {
    if (c.timer !== null || c.bytes <= HARD_CAP_BYTES) return;
    c.overSince = clock.mono();
    c.last = c.bytes; c.added = 0;
    const sample = () => {
      c.timer = null;
      if (c !== conn || done) return;
      if (c.bytes <= HARD_CAP_BYTES) { c.overSince = null; return; }
      const drained = c.last + c.added - c.bytes;
      c.last = c.bytes; c.added = 0;
      if (drained > 0) c.overSince = clock.mono();
      else if (clock.mono() - c.overSince >= HARD_CAP_MS) { retire(c); conn = null; onDrop(); return; }
      c.timer = clock.set(sample, HARD_CAP_SAMPLE_MS);
    };
    c.timer = clock.set(sample, HARD_CAP_SAMPLE_MS);
  }
  function open() {
    retire(conn);
    conn = null;
    gen++;                                                  // anything tagged with an older gen is dropped from now
    if (done) return;
    conn = { gen, up: [], bytes: 0, open: true, stalled: false, overSince: null, timer: null, last: 0, added: 0 };
  }
  open();

  const transport = {
    send(m) {
      const c = conn;
      if (!c || done) return;
      c.up.push(m);
      const n = JSON.stringify(m).length;
      c.bytes += n; c.added += n;
      watchCap(c);
      setTimeout(() => serve(c), 0);
    },
    congested: () => !done && !!conn && conn.bytes > CONGESTED_BYTES,
    onMessage(fn) { onMsg = fn; },
    onDrop(fn) { onDrop = fn; },
    reopen: open,
    close() { done = true; open(); },
  };
  return {
    transport,
    request: i => ({ t: "req", i }),
    answerOf: m => (m?.t === "ans" ? m.i : undefined),
    serve() { if (conn) serve(conn); },
    async flush() { for (let k = 0; k < 20; k++) await new Promise(r => setTimeout(r, 0)); },
    hold() {
      const c = conn;                   // the far side keeps its own handle on this connection
      return i => { if (c) setTimeout(() => { if (c.gen === gen && !done) onMsg({ t: "ans", i }); }, 0); };
    },
    stall() { if (conn) conn.stalled = true; },
    drain() { if (conn) { conn.stalled = false; serve(conn); } },
    trickle(n) { if (conn) conn.bytes = Math.max(0, conn.bytes - n); },   // the far side reads n bytes, stays stalled
    advance(ms) { clock.advance(ms); },
    drop() {
      const c = conn;
      if (!c) return;
      retire(c);
      conn = null;
      setTimeout(() => { if (c.gen === gen && !done) onDrop(); }, 0);
    },
  };
}
