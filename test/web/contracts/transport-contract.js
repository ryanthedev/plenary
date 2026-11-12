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
// Backpressure (p6-edgev M1; the port's congested(), backlogBytes() and hard cap). REQUIRED of every driver, never skipped:
//   stall()            async: the far side stops reading the CURRENT connection, so what the client sends piles up
//                      in its outbound backlog (a slow uplink). A new connection (reopen) starts unstalled.
//   drain()            async: the far side reads everything on the current connection again (backlog to zero) and
//                      keeps reading.
//   trickle(n)         async: the far side reads n bytes of the current connection's backlog and stays stalled
//                      (a slow but moving link).
//   advance(ms)        async: move the transport's clock (the clock port it was given) by ms.
//   bufferless: true   instead of the four hooks, for a transport with no outbound buffer (in-memory): then
//                      congested() is asserted to stay false, and nothing else of this section runs.
// Traffic the far side ignores: { t: "pad", s } (a request/answer driver must ignore unknown t).
// Only what the contract says is asserted: no buffering before onMessage, sync or async delivery both fine, and the
// onDrop tests run only when the adapter has onDrop.

import { describe, test, expect, beforeEach } from "bun:test";
import { CONGESTED_BYTES, HARD_CAP_BYTES, HARD_CAP_MS, HARD_CAP_SAMPLE_MS } from "../../../web/ports/transport.js";

/** A message that encodes to about n bytes of JSON (ASCII), which the far side ignores. */
export const pad = n => ({ t: "pad", s: "x".repeat(Math.max(0, n - 18)) });

/**
 * @typedef {{ transport: import("../../../web/ports/transport.js").Transport, request(i: number): object,
 *             answerOf(m: object): number | undefined, serve(): void | Promise<void>, flush(): Promise<void>,
 *             drop(): void | Promise<void>,
 *             hold(): ((i: number) => void | Promise<void>) | Promise<(i: number) => void | Promise<void>>,
 *             stall?(): void | Promise<void>, drain?(): void | Promise<void>, advance?(ms: number): void | Promise<void>,
 *             trickle?(n: number): void | Promise<void>,
 *             bufferless?: boolean }} TransportDriver
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

    // ── backpressure (p6-edgev M1): congested() and the hard cap ──
    describe("backpressure", () => {
      test("congested() is implemented, and false on a fresh connection", () => {
        expect(typeof t.congested).toBe("function");
        expect(t.congested()).toBe(false);
      });

      test("the driver declares bufferless or provides stall, drain, trickle and advance (never a silent skip)", () => {
        if (d.bufferless === true) return;
        for (const k of ["stall", "drain", "trickle", "advance"]) expect(typeof d[k]).toBe("function");
      });

      test("bufferless: congested() stays false whatever is sent", async () => {
        if (d.bufferless !== true) return;
        for (let k = 0; k < 5; k++) t.send(pad(CONGESTED_BYTES));
        expect(t.congested()).toBe(false);
        await d.flush();
        expect(t.congested()).toBe(false);
      });

      // backlogBytes() (manager decision, p6-edge2v M1): the number the core's presence gate reads.
      test("backlogBytes() is implemented, a number, and 0 on a fresh connection", () => {
        expect(typeof t.backlogBytes).toBe("function");
        expect(t.backlogBytes()).toBe(0);
      });

      test("bufferless: backlogBytes() stays 0 whatever is sent", async () => {
        if (d.bufferless !== true) return;
        for (let k = 0; k < 5; k++) t.send(pad(CONGESTED_BYTES));
        expect(t.backlogBytes()).toBe(0);
        await d.flush();
        expect(t.backlogBytes()).toBe(0);
      });

      const buffered = () => d.bufferless !== true;

      test("backlogBytes() counts what is not yet on the wire, agrees with congested(), and is 0 after drain, reopen and close", async () => {
        if (!buffered()) return;
        const n = 20 * 1024, near = (v, want) => { expect(v).toBeGreaterThanOrEqual(want - 64); expect(v).toBeLessThanOrEqual(want + 256); };
        await d.stall();
        t.send(pad(n));
        near(t.backlogBytes(), n);
        t.send(pad(n));
        near(t.backlogBytes(), 2 * n);
        expect(t.congested()).toBe(t.backlogBytes() > CONGESTED_BYTES);
        await d.trickle(n);
        near(t.backlogBytes(), n);
        await d.drain();
        await d.stall();
        t.send({ t: "pad", s: "é".repeat(n / 2) });     // 2 UTF-8 bytes per character: bytes, not characters
        near(t.backlogBytes(), n);
        await d.drain();
        expect(t.backlogBytes()).toBe(0);
        await d.stall();
        t.send(pad(CONGESTED_BYTES + 1024));
        expect(t.congested()).toBe(true);
        expect(t.backlogBytes()).toBeGreaterThan(CONGESTED_BYTES);
        reopen();
        expect(t.backlogBytes()).toBe(0);
        await d.stall();
        t.send(pad(n));
        expect(t.backlogBytes()).toBeGreaterThan(0);
        close();
        expect(t.backlogBytes()).toBe(0);
      });

      test("watermark: under it not congested, over it congested, drained not congested", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(CONGESTED_BYTES / 2));
        expect(t.congested()).toBe(false);
        t.send(pad(CONGESTED_BYTES / 2 + 1024));
        expect(t.congested()).toBe(true);
        await d.drain();
        expect(t.congested()).toBe(false);
      });

      test("congested drops nothing: everything sent while congested arrives, in order", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(CONGESTED_BYTES + 1024));
        expect(t.congested()).toBe(true);
        ask(1, 2, 3);
        await d.drain();
        await d.flush();
        expect(got).toEqual([1, 2, 3]);
      });

      test("reopen gives a connection that is not congested; close() is never congested", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(CONGESTED_BYTES + 1024));
        expect(t.congested()).toBe(true);
        reopen();
        expect(t.congested()).toBe(false);
        await d.stall();
        t.send(pad(CONGESTED_BYTES + 1024));
        expect(t.congested()).toBe(true);
        close();
        expect(t.congested()).toBe(false);
      });

      test("hard cap: a stalled backlog over the cap (nothing drains) for the whole hold is one drop; reopen then works", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        await d.advance(HARD_CAP_MS - HARD_CAP_SAMPLE_MS);
        await d.flush();
        expect(drops).toBe(0);
        await d.advance(2 * HARD_CAP_SAMPLE_MS);
        await d.flush();
        expect(drops).toBe(1);
        expect(t.congested()).toBe(false);               // the dead connection's backlog is gone with it
        await d.advance(3 * HARD_CAP_MS);
        await d.flush();
        expect(drops).toBe(1);
        reopen();
        ask(1);
        await d.flush();
        expect(got).toEqual([1]);
      });

      // Manager decision 2026-11-12: only a link that makes no drain progress is dropped, never a slow one.
      test("hard cap: a slow link that stays over the cap but keeps draining is never dropped", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 512 * 1024));
        for (let k = 0; k < 40; k++) {                  // 40 s over the cap, 8 KB leaving per second
          await d.trickle(8 * 1024);
          await d.advance(HARD_CAP_SAMPLE_MS);
        }
        await d.flush();
        expect(drops).toBe(0);
        expect(t.congested()).toBe(true);
      });

      test("hard cap: draining while the client adds more (the backlog grows) is still progress, no drop", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        for (let k = 0; k < 30; k++) {
          await d.trickle(8 * 1024);
          t.send(pad(16 * 1024));                        // more in than out: the backlog rises every second
          await d.advance(HARD_CAP_SAMPLE_MS);
        }
        await d.flush();
        expect(drops).toBe(0);
      });

      test("hard cap: stalled while the client keeps sending is a drop (adding is not draining)", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        for (let k = 0; k < 9; k++) { t.send(pad(1024)); await d.advance(HARD_CAP_SAMPLE_MS); }
        await d.flush();
        expect(drops).toBe(0);
        for (let k = 0; k < 2; k++) { t.send(pad(1024)); await d.advance(HARD_CAP_SAMPLE_MS); }
        await d.flush();
        expect(drops).toBe(1);
      });

      test("hard cap: the hold counts from the last progress: a link that drains, then stops, drops 10 s later", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 512 * 1024));
        for (let k = 0; k < 15; k++) { await d.trickle(8 * 1024); await d.advance(HARD_CAP_SAMPLE_MS); }
        await d.advance(HARD_CAP_MS - HARD_CAP_SAMPLE_MS);  // stopped: 9 s with nothing leaving
        await d.flush();
        expect(drops).toBe(0);
        await d.advance(2 * HARD_CAP_SAMPLE_MS);
        await d.flush();
        expect(drops).toBe(1);
      });

      test("hard cap: a backlog that drains before the hold ends is no drop", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        await d.advance(HARD_CAP_MS / 2);
        await d.drain();
        await d.advance(2 * HARD_CAP_MS);
        await d.flush();
        expect(drops).toBe(0);
      });

      test("hard cap: one sample under the cap restarts the hold", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        await d.advance(HARD_CAP_MS - 2 * HARD_CAP_SAMPLE_MS);
        await d.drain();
        await d.advance(2 * HARD_CAP_SAMPLE_MS);          // a sample sees the drained backlog
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        await d.advance(HARD_CAP_MS - 2 * HARD_CAP_SAMPLE_MS);
        await d.flush();
        expect(drops).toBe(0);                           // 18 s over in all, but never 10 s straight
        await d.advance(4 * HARD_CAP_SAMPLE_MS);
        await d.flush();
        expect(drops).toBe(1);
      });

      test("hard cap: reopen or close during the hold cancels it (no drop)", async () => {
        if (!buffered()) return;
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        await d.advance(HARD_CAP_MS / 2);
        reopen();
        await d.advance(2 * HARD_CAP_MS);
        await d.flush();
        expect(drops).toBe(0);
        await d.stall();
        t.send(pad(HARD_CAP_BYTES + 1024));
        await d.advance(HARD_CAP_MS / 2);
        close();
        await d.advance(2 * HARD_CAP_MS);
        await d.flush();
        expect(drops).toBe(0);
      });
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
