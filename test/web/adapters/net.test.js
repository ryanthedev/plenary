// Both nets (web/ports/net.js) against the net contract: the in-page room and the SharedWorker's page side wired to a
// real host.js over a fake port pair (the worker side here is host.js with the local room, as worker.js wires it).
import { netContract } from "../contracts/net-contract.js";
import { localNet, localRoom } from "../../../web/adapters/transport/local.js";
import { sharedNet } from "../../../web/adapters/transport/shared-worker/client.js";
import { roomHost } from "../../../web/adapters/transport/shared-worker/host.js";
import { DEV_USERS } from "../../../web/core/dev-users.js";

const tick = () => new Promise(r => setTimeout(r, 0));

netContract("local", () => ({ net: localNet({ board: "b1", users: DEV_USERS }), settle: async () => { for (let i = 0; i < 5; i++) await tick(); } }));

netContract("shared-worker (host.js over a fake port)", () => {
  const q = [];
  const tab = { onmessage: null, start() {}, postMessage: d => q.push(() => far.onmessage?.({ data: structuredClone(d) })) };
  const far = { onmessage: null, start() {}, postMessage: d => q.push(() => tab.onmessage?.({ data: structuredClone(d) })) };
  const host = roomHost({ makeNet: board => localRoom({ board, users: DEV_USERS, auto: true }) });
  host.connect(far);
  const net = sharedNet({ board: "b1", worker: { port: tab } });
  return { net, settle: async () => { for (let i = 0; i < 20; i++) { while (q.length) q.shift()(); await tick(); } } };
});

// The production net: ws.js's wsNet over a fake WebSocket (each join is its own socket to the same URL).
import { wsNet, sameOriginWsUrl } from "../../../web/adapters/transport/ws.js";
import { test, expect } from "bun:test";

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; FakeWS.all.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); }); }
  send(d) { const m = JSON.parse(d); if (m.t === "hello") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ t: "error", code: "auth", message: "fake" }) })); }
  close() { this.readyState = 3; }
}
netContract("ws (fake WebSocket)", () => ({ net: wsNet({ url: "ws://example.test/ws", WebSocket: FakeWS }), settle: async () => { for (let i = 0; i < 5; i++) await tick(); } }));

test("wsNet: one socket per join, all to the same URL; the URL is same-origin /ws and never carries a token", () => {
  FakeWS.all = [];
  const url = sameOriginWsUrl({ protocol: "https:", host: "plenary.example:8443" });
  expect(url).toBe("wss://plenary.example:8443/ws");
  expect(sameOriginWsUrl({ protocol: "http:", host: "127.0.0.1:5000" })).toBe("ws://127.0.0.1:5000/ws");
  const net = wsNet({ url, WebSocket: FakeWS });
  net.join(); net.join();
  expect(FakeWS.all.map(w => w.url)).toEqual([url, url]);
  expect(() => wsNet({ url: "https://x/ws", WebSocket: FakeWS })).toThrow(TypeError);
});
