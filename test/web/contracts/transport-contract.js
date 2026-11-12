// The Transport contract (web/ports/transport.js; the p2-land header of web/sync.js), as reusable bun tests.
// Every transport adapter runs it (here: the reference transport; p6-hex: shared-worker via a fake port, local):
//
//   import { transportContract } from "<repo>/test/web/contracts/transport-contract.js";
//   transportContract("reference", () => referenceTransport());
//
// makeTransport() returns a FRESH transport (its first connection open) and a driver for the far side:
//   transport          the adapter under test.
//   request(i)         a message that, sent by the client, makes the far side answer it once on the same connection.
//   answerOf(m)        i if m is the answer to request(i), else undefined (other traffic is ignored).
//   serve()            the far side takes every message sent so far on its current connection and QUEUES the
//                      answers toward the client, delivering none of them yet (sync or async). The test awaits it
//                      and then calls reopen(), so the answers must not be delivered on a microtask: hold them
//                      for a task (a MessagePort / setTimeout) or until flush().
//   flush()            async: deliver everything queued, both ways, until quiet.
//   drop()             the far side drops the current connection without the client asking (a socket closing).
//   hold()             REQUIRED. Returns emit(i), bound to the far side's CURRENT connection: calling it later makes
//                      the far side send, on THAT connection, a message m with answerOf(m) === i, whether or not the
//                      client has since reopened, closed or seen a drop. This is a gateway that has not yet seen
//                      the close and keeps flushing (the normal case for a WebSocket or a SharedWorker), and the
//                      only way to test the generation check itself (p6-portsv H1). hold() and emit() may be async.
// Only what the contract says is asserted: no buffering before onMessage, sync or async delivery both fine, and the
// onDrop tests run only when the adapter has onDrop.

import { describe, test, expect, beforeEach } from "bun:test";

/**
 * @typedef {{ transport: import("../../../web/ports/transport.js").Transport, request(i: number): object,
 *             answerOf(m: object): number | undefined, serve(): void | Promise<void>, flush(): Promise<void>,
 *             drop(): void | Promise<void>,
 *             hold(): ((i: number) => void | Promise<void>) | Promise<(i: number) => void | Promise<void>> }} TransportDriver
 * @param {string} name
 * @param {() => TransportDriver | Promise<TransportDriver>} makeTransport
 * @param {{ skip?: boolean }} [opts]
 */
export function transportContract(name, makeTransport, opts = {}) {
  describe.skipIf(!!opts.skip)(`Transport contract: ${name}`, () => {
    let d, t, got, drops, dropsAfter;
    let mark = false;                    // set when the test calls reopen/close: drops counted after it are wrong
    beforeEach(async () => {
      d = await makeTransport();
      t = d.transport;
      got = []; drops = 0; dropsAfter = 0; mark = false;
      t.onMessage(m => { const i = d.answerOf(m); if (i !== undefined) got.push(i); });
      t.onDrop?.(() => { drops++; if (mark) dropsAfter++; });
    });
    const ask = (...is) => { for (const i of is) t.send(d.request(i)); };
    const reopen = () => { mark = true; t.reopen(); };
    const close = () => { mark = true; t.close(); };

    test("send reaches the far side on the current connection and the answer comes back", async () => {
      ask(1);
      await d.flush();
      expect(got).toEqual([1]);
    });

    test("messages of one connection arrive in the order sent", async () => {
      ask(1, 2, 3, 4, 5);
      await d.flush();
      expect(got).toEqual([1, 2, 3, 4, 5]);
    });

    test("onMessage replaces the handler: only the latest one is called", async () => {
      const first = [];
      t.onMessage(m => first.push(m));
      t.onMessage(m => { const i = d.answerOf(m); if (i !== undefined) got.push(i); });
      ask(1);
      await d.flush();
      expect(first).toEqual([]);
      expect(got).toEqual([1]);
    });

    test("reopen opens a new connection that works", async () => {
      ask(1);
      await d.flush();
      reopen();
      ask(2);
      await d.flush();
      expect(got).toEqual([1, 2]);
    });

    test("generation: an answer the old connection already queued is never delivered after reopen", async () => {
      ask(1);
      await d.serve();                   // the answer to 1 is queued on connection 1, not yet delivered
      reopen();
      await d.flush();
      expect(got).toEqual([]);
      ask(2);
      await d.flush();
      expect(got).toEqual([2]);
    });

    test("generation: a message sent before reopen is not carried onto the new connection", async () => {
      ask(1);
      reopen();
      await d.flush();
      expect(got).toEqual([]);
      ask(2);                            // the new connection is busy now: a carried-over 1 would be answered too
      await d.flush();
      expect(got).toEqual([2]);
    });

    test("reopen twice in a row: only the newest connection delivers", async () => {
      ask(1); await d.serve();
      reopen();
      ask(2); await d.serve();
      reopen();
      ask(3);
      await d.flush();
      expect(got).toEqual([3]);
    });

    test("close is final: nothing queued is delivered; send and reopen afterwards do nothing", async () => {
      ask(1);
      await d.serve();
      close();
      await d.flush();
      ask(2);
      t.reopen();
      ask(3);
      await d.flush();
      expect(got).toEqual([]);
      expect(dropsAfter).toBe(0);
    });

    test("reopen and close never report onDrop", async () => {
      reopen();
      await d.flush();
      close();
      await d.flush();
      expect(drops).toBe(0);
    });

    // ── late far-side traffic on an old connection (p6-portsv H1) ──

    test("hold() is provided by the driver (required: it is how the generation check is tested)", () => {
      expect(typeof d.hold).toBe("function");
    });

    test("generation: the far side sending on the old connection AFTER reopen is never delivered", async () => {
      const old = await d.hold();
      reopen();
      await old(7);
      await d.flush();
      expect(got).toEqual([]);
      ask(8);                            // the new connection still works
      await d.flush();
      expect(got).toEqual([8]);
    });

    test("generation: late traffic on a connection replaced twice is never delivered", async () => {
      const first = await d.hold();
      reopen();
      const second = await d.hold();
      reopen();
      await first(1); await second(2);
      await d.flush();
      expect(got).toEqual([]);
    });

    test("close is final for late traffic too: the far side sending on the closed connection is never delivered", async () => {
      const old = await d.hold();
      close();
      await old(7);
      await d.flush();
      expect(got).toEqual([]);
    });

    describe("onDrop (when the adapter has it)", () => {
      const has = () => typeof t.onDrop === "function";

      test("an unasked drop of the current connection is reported once", async () => {
        if (!has()) return;
        await d.drop();
        await d.flush();
        expect(drops).toBe(1);
        await d.drop();                  // nothing current to drop any more
        await d.flush();
        expect(drops).toBe(1);
      });

      // Whether answers already in flight when the far side drops still arrive is NOT pinned (a WebSocket delivers
      // what it received before onclose); once the client reopens, none of them may.
      test("after a drop, reopen recovers and the dropped connection's answers never arrive", async () => {
        if (!has()) return;
        ask(1);
        await d.serve();
        await d.drop();
        reopen();
        ask(2);
        await d.flush();
        expect(got).toEqual([2]);
      });

      test("generation: a drop of the old connection is never reported after reopen", async () => {
        if (!has()) return;
        await d.drop();                  // a sync transport may report it now (it was current): that is fine
        reopen();                        // an async one must swallow it from here on
        await d.flush();
        expect(dropsAfter).toBe(0);
        ask(1);
        await d.flush();
        expect(got).toEqual([1]);
      });

      test("generation: the far side sending on a dropped connection after reopen is never delivered", async () => {
        if (!has()) return;
        const old = await d.hold();
        await d.drop();
        reopen();
        await old(7);
        await d.flush();
        expect(got).toEqual([]);
        ask(8);
        await d.flush();
        expect(got).toEqual([8]);
      });

      test("no drop is reported after close", async () => {
        if (!has()) return;
        await d.drop();
        close();
        await d.flush();
        expect(dropsAfter).toBe(0);
      });
    });
  });
}
