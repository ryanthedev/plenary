// A tiny reference transport (not an app adapter): the smallest thing that keeps the transport contract, so the
// contract itself is tested (reference-transport.test.js). Async like a SharedWorker port: the far side reads the
// client's messages and the client reads the far side's on later tasks (setTimeout 0, like a MessagePort), so stale deliveries really happen
// and only the generation check stops them.
//
// Far side: answers { t: "req", i } with { t: "ans", i } on the same connection.

/** @returns {import("./transport-contract.js").TransportDriver} */
export function referenceTransport() {
  let gen = 0, done = false, onMsg = () => {}, onDrop = () => {};
  /** @type {{ gen: number, up: object[], open: boolean } | null} */
  let conn = null;

  // ── far side ──
  function serve(c) {                                       // read what the client sent on c, queue the answers
    while (c.open && c.up.length) {
      const m = c.up.shift();
      if (m?.t === "req") setTimeout(() => { if (c.gen === gen && !done) onMsg({ t: "ans", i: m.i }); }, 0);
    }
  }
  function open() {
    if (conn) conn.open = false;
    conn = null;
    gen++;                                                  // anything tagged with an older gen is dropped from now
    if (done) return;
    conn = { gen, up: [], open: true };
  }
  open();

  const transport = {
    send(m) {
      const c = conn;
      if (!c || done) return;
      c.up.push(m);
      setTimeout(() => serve(c), 0);
    },
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
    drop() {
      const c = conn;
      if (!c) return;
      c.open = false;
      conn = null;
      setTimeout(() => { if (c.gen === gen && !done) onDrop(); }, 0);
    },
  };
}
