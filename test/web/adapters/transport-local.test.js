// The local transport adapter (web/adapters/transport/local.js) against the transport contract, plus its own tests.
// The far side is an echo room put in through localRoom's `makeRoom` seam, so the contract drives the link logic
// itself. hold() keeps the room-side send of a connection and calls it after the client moved on: a gateway that has
// not seen the close yet. That is the only path on which localRoom's generation check (link.gen === gen) matters,
// because the real Room never sends to a connection it was told is closed (p6-landv L3, p6-portsv M9).
import { test, expect } from "bun:test";
import { transportContract } from "../contracts/transport-contract.js";
import { localRoom, localNet } from "../../../web/adapters/transport/local.js";
import { DEV_USERS } from "../../../web/core/dev-users.js";

/** A far side that answers { t: "req", i } with { t: "ans", i } and, like a gateway, keeps a closed connection's send. */
function echoRoom() {
  const conns = [];
  return {
    conns,
    connect(send) { const c = { send, closed: false }; conns.push(c); return c; },
    receive(c, msg) { if (msg?.t === "req") c.send({ t: "ans", i: msg.i }); },
    disconnect(c) { c.closed = true; },
  };
}

function driver() {
  let far = null;
  const net = localRoom({ users: {}, makeRoom: () => (far = echoRoom()) });
  const t = net.join();
  return {
    transport: t,
    request: i => ({ t: "req", i }),
    answerOf: m => (m?.t === "ans" ? m.i : undefined),
    serve: () => net.deliverUp(),
    flush: async () => net.settle(),
    drop: () => t.fail(),
    hold: () => { const c = far.conns.at(-1); return i => c.send({ t: "ans", i }); },
    bufferless: true,
  };
}

transportContract("local (localRoom, echo far side)", driver);

test("localNet: a Net over one in-page room; each join is its own working transport; no blob path", () => {
  const net = localNet({ board: "b1", users: DEV_USERS });
  expect(net.kind).toBe("local");
  const a = net.join(), b = net.join();
  expect(a).not.toBe(b);
  for (const k of ["send", "onMessage", "onDrop", "reopen", "close", "congested", "backlogBytes"]) expect(typeof a[k]).toBe("function");
  expect(() => net.put({ id: "x", mimeType: "image/png", dataURL: "data:," })).not.toThrow();
  a.close(); b.close();
});
