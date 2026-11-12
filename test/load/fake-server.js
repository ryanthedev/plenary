// A scripted stand-in for the server, for the load client's counting tests: just enough of PROTOCOL.md for a
// Replica (hello → welcome, then catch-up entries; op → entry to everyone + ack to the sender), on port 0.
// Each test bends one rule through the hooks (drop a connection, hold an ack, never ack).

/**
 * @param {{ tokens: Record<string, { user: string, role: string }>,
 *           onOp?: (ctx: object, ws: any, msg: object) => void }} o
 *   onOp replaces the default (ctx.apply: log the entry, send it to everyone, ack the sender at once).
 */
export function fakeServer({ tokens, onOp } = {}) {
  const ctx = {
    seq: 0, log: [], conns: new Set(), opsSeen: [], hellos: 0,
    /** Log the op as an entry and send it to every welcomed connection. Returns the entry. */
    entry(by, msg) {
      const e = { seq: ++ctx.seq, id: msg.id, by, at: Date.now(), stream: msg.stream, op: msg.op };
      ctx.log.push(e);
      for (const c of ctx.conns) if (c.data.welcomed) c.send(JSON.stringify({ t: "entries", entries: [e] }));
      return e;
    },
    ack(ws, id, seq) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ack", id, seq })); },
    apply(ws, msg) { const e = ctx.entry(ws.data.user, msg); ctx.ack(ws, msg.id, e.seq); return e; },
  };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req, { data: { user: null, role: null, welcomed: false } }) ? undefined : new Response("ws only", { status: 400 }); },
    websocket: {
      open(ws) { ctx.conns.add(ws); },
      close(ws) { ctx.conns.delete(ws); },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        if (msg.t === "hello") {
          ctx.hellos++;
          const who = tokens[msg.token];
          if (!who) { ws.send(JSON.stringify({ t: "error", code: "auth" })); ws.close(4001, "auth"); return; }
          ws.data.user = who.user; ws.data.role = who.role; ws.data.welcomed = true;
          ws.send(JSON.stringify({ t: "welcome", user: who.user, role: who.role, seq: ctx.seq, horizon: 0 }));
          const since = msg.since ?? 0, back = ctx.log.filter(e => e.seq > since);
          if (back.length) ws.send(JSON.stringify({ t: "entries", entries: back }));
        } else if (msg.t === "op") {
          ctx.opsSeen.push(msg.id);
          (onOp ?? ((c, w, m) => c.apply(w, m)))(ctx, ws, msg);
        }
        // presence and anything else: ignored
      },
    },
  });
  ctx.url = `ws://127.0.0.1:${server.port}/ws`;
  ctx.stop = () => server.stop(true);
  return ctx;
}

/** Wait until fn() is true (polling), or fail with `what` after ms. */
export async function until(fn, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(10); }
}
