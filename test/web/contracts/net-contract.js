// The Net contract (web/ports/net.js) as reusable bun tests. Each transport a net hands out is checked by
// transportContract; this checks the net itself: fresh, independent transports per join, and the blobs stand-in.
//
//   netContract("local", () => ({ net: localNet({ board: "b1", users }), settle: async () => {} }));
//
// makeNet() returns { net, settle }: settle() lets whatever the net delivers asynchronously arrive.
import { describe, test, expect } from "bun:test";

const PORT_METHODS = ["send", "onMessage", "reopen", "close", "congested", "backlogBytes"];

export function netContract(name, makeNet) {
  describe(`Net contract: ${name}`, () => {
    test("kind is a non-empty string", async () => {
      const { net } = await makeNet();
      expect(typeof net.kind).toBe("string");
      expect(net.kind.length).toBeGreaterThan(0);
    });

    test("join() gives a fresh transport each time, with the whole transport port", async () => {
      const { net } = await makeNet();
      const a = net.join(), b = net.join();
      expect(a).not.toBe(b);
      for (const t of [a, b]) for (const k of PORT_METHODS) expect(typeof t[k]).toBe("function");
      expect(a.congested()).toBe(false);
      expect(a.backlogBytes()).toBe(0);
      a.close(); b.close();
    });

    test("closing one joined transport leaves another working (they share nothing per connection)", async () => {
      const { net, settle } = await makeNet();
      const a = net.join(), b = net.join();
      const got = [];
      b.onMessage(m => got.push(m));
      a.close();
      b.send({ t: "hello", v: 1, token: "dev-ada", board: "b1", client: "c", since: 0 });
      await settle();
      expect(got.length).toBeGreaterThan(0);              // the room answered b (welcome or an error), a's close didn't end b
      b.close();
    });

    test("put never throws (with or without a blob path) and onFile takes a handler", async () => {
      const { net, settle } = await makeNet();
      net.onFile(() => {});
      expect(() => net.put({ id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64," })).not.toThrow();
      await settle();
    });
  });
}
