// The shared-worker transport adapter, page side (web/adapters/transport/shared-worker/client.js), against the
// transport contract over a fake MessagePort pair. The far side speaks host.js's port protocol by hand (join, send,
// close, drop → msg, dropped), so the generation check under test is the client's own (one link id per connection,
// handlers only for the current link), not the room's. hold() keeps a link id and posts on it after the client moved on.
import { test, expect } from "bun:test";
import { transportContract } from "../contracts/transport-contract.js";
import { sharedNet } from "../../../web/adapters/transport/shared-worker/client.js";

/** Two fake MessagePort ends; nothing moves until the test pumps a direction. Data is cloned like postMessage. */
function portPair() {
  const toFar = [], toTab = [];
  const tab = { onmessage: null, start() {}, postMessage: d => toFar.push(structuredClone(d)) };
  const far = { onmessage: null, start() {}, postMessage: d => toTab.push(structuredClone(d)) };
  return {
    tab, far,
    up() { let n = 0; while (toFar.length) { far.onmessage?.({ data: toFar.shift() }); n++; } return n; },
    down() { let n = 0; while (toTab.length) { tab.onmessage?.({ data: toTab.shift() }); n++; } return n; },
  };
}

/** host.js's protocol with an echo room: { t: "req", i } on a link comes back as { t: "ans", i } on that link. */
function echoHost(port) {
  const links = new Set();
  let last = null;
  port.onmessage = ({ data: d }) => {
    if (d.t === "join") { links.add(d.link); last = d.link; }
    else if (d.t === "close") links.delete(d.link);
    else if (d.t === "send" && links.has(d.link) && d.m?.t === "req") port.postMessage({ t: "msg", link: d.link, m: { t: "ans", i: d.m.i } });
  };
  return {
    get last() { return last; },
    drop: link => { links.delete(link); port.postMessage({ t: "dropped", link }); },
  };
}

function driver() {
  const pair = portPair(), host = echoHost(pair.far);
  const net = sharedNet({ board: "b1", worker: { port: pair.tab } });
  const t = net.join();
  pair.up();                                        // the first join reaches the host
  return {
    transport: t,
    request: i => ({ t: "req", i }),
    answerOf: m => (m?.t === "ans" ? m.i : undefined),
    serve: () => { pair.up(); },                    // the host answers; the answers wait in the tab's queue
    flush: async () => { while (pair.up() + pair.down()); },
    drop: () => { pair.up(); host.drop(host.last); },
    hold: () => { pair.up(); const link = host.last; return i => pair.far.postMessage({ t: "msg", link, m: { t: "ans", i } }); },
    bufferless: true,
  };
}

transportContract("shared-worker (page side, fake port)", driver);

test("sharedNet returns null when SharedWorker is missing, so the root can fall back", () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "SharedWorker");
  try {
    Object.defineProperty(globalThis, "SharedWorker", { value: undefined, configurable: true, writable: true });
    expect(sharedNet({ board: "b1" })).toBeNull();
  } finally {
    if (had) Object.defineProperty(globalThis, "SharedWorker", had); else delete globalThis.SharedWorker;
  }
});
