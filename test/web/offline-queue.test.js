// @ts-check
import { describe, test, expect } from "bun:test";
import { Doc } from "../../packages/core/doc.js";
import { emptyScene } from "../../packages/core/model.js";
import { STORAGE_UNAVAILABLE } from "../../web/ports/storage.js";
import { memoryStore } from "../../web/adapters/storage/memory.js";
import { virtualClock } from "../../web/adapters/clock/virtual.js";
import {
  createOfflineQueue,
  mergeOfflineOp,
  hasRemoteConflict,
  offlineQueueKey,
} from "../../web/core/offline-queue.js";

/** Helper to build deterministic test elements without touching ambient globals. */
function makeEl(id, overrides = {}) {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    version: 1,
    versionNonce: 101,
    updated: 1000,
    isDeleted: false,
    customData: { layer: "base", z: 0 },
    ...overrides,
  };
}

describe("offline edit queue (#31)", () => {
  test("buffers offline ops, persists under board-scoped key, and restores across reload", () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 10_000 });

    const q1 = createOfflineQueue({ store, boardId: "board-alpha", clock });
    const qOther = createOfflineQueue({ store, boardId: "board-beta", clock });

    expect(q1.key).toBe(offlineQueueKey("board-alpha"));
    expect(q1.key).not.toBe(qOther.key);
    expect(q1.stats()).toEqual({ count: 0, bytes: 0, oldestAt: null, truncated: false });

    const op1 = { stream: "board", elements: [makeEl("el-1", { x: 10, y: 20, version: 2, updated: 10_000 })] };
    const r1 = q1.enqueue(op1);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.coalesced).toBe(false);
      expect(r1.persisted).toBe(true);
    }

    clock.advance(500);
    const op2 = { stream: "board", elements: [makeEl("el-2", { x: 50, y: 60, version: 1, updated: 10_500 })] };
    const r2 = q1.enqueue(op2);
    expect(r2.ok).toBe(true);

    // Other board's queue is isolated
    expect(qOther.restore()).toEqual({ ok: true, restored: 0, truncated: false });
    expect(qOther.pending()).toEqual([]);

    // Simulate page reload with a fresh queue instance on the same store
    const reloaded = createOfflineQueue({ store, boardId: "board-alpha", clock });
    const restored = reloaded.restore();
    expect(restored).toEqual({ ok: true, restored: 2, truncated: false });

    const s = reloaded.stats();
    expect(s.count).toBe(2);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.oldestAt).toBe(10_000);
    expect(s.truncated).toBe(false);

    const ops = reloaded.pending();
    expect(ops).toHaveLength(2);
    expect(ops[0].elements[0].id).toBe("el-1");
    expect(ops[1].elements[0].id).toBe("el-2");

    // Mutating returned pending() copy does not corrupt internal state
    ops[0].elements[0].x = 9999;
    expect(reloaded.pending()[0].elements[0].x).toBe(10);
  });

  test("coalesces consecutive geometry and style updates (drag-storm protection) while keeping structural ops separate", () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 5_000 });
    const q = createOfflineQueue({ store, boardId: "b-drag", clock });

    const base = makeEl("r1", { x: 0, y: 0, version: 1, updated: 5_000 });
    // Simulate a 100-frame drag storm on r1
    for (let i = 1; i <= 100; i++) {
      clock.advance(16);
      const res = q.enqueue({
        stream: "board",
        elements: [makeEl("r1", { x: i * 3, y: i * 2, version: i + 1, updated: clock.now() })],
        ...(i === 1 ? { baseElements: { r1: base } } : {}),
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.coalesced).toBe(i > 1);
    }

    // Style update immediately following drag also coalesces
    clock.advance(50);
    const styleRes = q.enqueue({
      stream: "board",
      elements: [makeEl("r1", { x: 300, y: 200, strokeColor: "#e03131", strokeWidth: 4, version: 102, updated: clock.now() })],
    });
    expect(styleRes.ok && styleRes.coalesced).toBe(true);
    expect(q.stats().count).toBe(1);

    const [only] = q.pending();
    expect(only.elements[0].x).toBe(300);
    expect(only.elements[0].y).toBe(200);
    expect(only.elements[0].strokeColor).toBe("#e03131");
    expect(only.elements[0].strokeWidth).toBe(4);
    expect(only.elements[0].version).toBe(102);
    // Original baseElements preserved across coalescing
    expect(only.baseElements?.r1?.x).toBe(0);

    // Different element does NOT coalesce
    q.enqueue({ stream: "board", elements: [makeEl("r2", { x: 10, y: 10, version: 2 })] });
    expect(q.stats().count).toBe(2);

    // Returning to r1 after r2 is non-consecutive -> preserves FIFO order
    q.enqueue({ stream: "board", elements: [makeEl("r1", { x: 320, y: 200, strokeColor: "#e03131", strokeWidth: 4, version: 103 })] });
    expect(q.stats().count).toBe(3);

    // Delete (structural change) does NOT coalesce into previous geometry op
    const delRes = q.enqueue({
      stream: "board",
      elements: [makeEl("r1", { x: 320, y: 200, isDeleted: true, version: 104 })],
    });
    expect(delRes.ok && !delRes.coalesced).toBe(true);
    expect(q.stats().count).toBe(4);

    // appState op does NOT coalesce
    q.enqueue({ stream: "board", appState: { grid: true } });
    expect(q.stats().count).toBe(5);
  });

  test("enforces maxOps and maxBytes caps without crashing or losing existing queued ops", () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 1_000 });

    // maxOps cap
    const qOps = createOfflineQueue({ store, boardId: "b-cap-ops", maxOps: 2, clock });
    expect(qOps.enqueue({ elements: [makeEl("a", { x: 1 })] }).ok).toBe(true);
    expect(qOps.enqueue({ elements: [makeEl("b", { x: 2 })] }).ok).toBe(true);

    // Coalescing onto last element still succeeds even at maxOps!
    const coal = qOps.enqueue({ elements: [makeEl("b", { x: 25, version: 2 })] });
    expect(coal.ok).toBe(true);
    if (coal.ok) expect(coal.coalesced).toBe(true);

    // A distinct 3rd op is rejected with queue-full
    const full = qOps.enqueue({ elements: [makeEl("c", { x: 3 })] });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toBe("queue-full");
    expect(qOps.stats().count).toBe(2);
    expect(qOps.stats().truncated).toBe(true);
    expect(qOps.pending().map(o => o.elements[0].id)).toEqual(["a", "b"]);

    // maxBytes cap
    const qBytes = createOfflineQueue({ store, boardId: "b-cap-bytes", maxOps: 100, maxBytes: 500, clock });
    expect(qBytes.enqueue({ elements: [makeEl("small", { x: 1 })] }).ok).toBe(true);
    const huge = qBytes.enqueue({
      elements: [makeEl("big", { text: "x".repeat(2000) })],
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.reason).toBe("queue-full");
    expect(qBytes.stats().count).toBe(1);
    expect(qBytes.pending()[0].elements[0].id).toBe("small");

    // Invalid op returns invalid-op
    const bad = qBytes.enqueue(/** @type {any} */ (null));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid-op");
  });

  test("survives corrupt JSON, invalid persisted entries, and unavailable/throwing storage gracefully", () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 2_000 });
    const key = offlineQueueKey("b-corrupt");

    // 1. Corrupt JSON string
    store.set(key, "{not valid json!!!");
    const q1 = createOfflineQueue({ store, boardId: "b-corrupt", clock });
    const r1 = q1.restore();
    expect(r1).toEqual({ ok: false, restored: 0, truncated: false, reason: "corrupt-data" });
    expect(q1.stats().count).toBe(0);
    // Corrupt value cleaned up
    expect(store.get(key)).toBeNull();

    // 2. Valid JSON but wrong schema shape
    store.set(key, JSON.stringify({ v: 1, entries: "not-an-array" }));
    expect(q1.restore()).toEqual({ ok: false, restored: 0, truncated: false, reason: "corrupt-data" });

    // 3. Partially valid entries + exceeding maxOps on restore
    store.set(
      key,
      JSON.stringify({
        v: 1,
        boardId: "b-corrupt",
        entries: [
          { op: { elements: [makeEl("ok-1")] }, enqueuedAt: 100, updatedAt: 100, coalesced: 0 },
          { op: null, enqueuedAt: 101 }, // invalid -> skipped
          { op: { elements: [makeEl("ok-2")] }, enqueuedAt: 200, updatedAt: 200, coalesced: 0 },
          { op: { elements: [makeEl("ok-3")] }, enqueuedAt: 300, updatedAt: 300, coalesced: 0 },
        ],
      })
    );
    const qLimited = createOfflineQueue({ store, boardId: "b-corrupt", maxOps: 2, clock });
    const rPartial = qLimited.restore();
    expect(rPartial).toEqual({ ok: true, restored: 2, truncated: true });
    expect(qLimited.pending().map(o => o.elements[0].id)).toEqual(["ok-1", "ok-2"]);
    expect(qLimited.stats().truncated).toBe(true);

    // 4. Completely unavailable storage port (throws STORAGE_UNAVAILABLE on every call)
    const brokenStore = memoryStore({ unavailable: true });
    const qMem = createOfflineQueue({ store: brokenStore, boardId: "b-broken", clock });
    expect(qMem.restore()).toEqual({ ok: false, restored: 0, truncated: false, reason: "storage-unavailable" });

    // Enqueue still works in memory without throwing
    const enq = qMem.enqueue({ elements: [makeEl("in-mem")] });
    expect(enq.ok).toBe(true);
    if (enq.ok) expect(enq.persisted).toBe(false);
    expect(qMem.stats().count).toBe(1);

    // Clear also never throws on broken store
    expect(() => qMem.clear()).not.toThrow();
    expect(qMem.stats().count).toBe(0);

    // 5. Storage that throws quota error only on set
    const quotaStore = {
      get: () => null,
      set: () => {
        throw Object.assign(new Error("QuotaExceededError"), { code: STORAGE_UNAVAILABLE });
      },
      remove: () => {},
    };
    const qQuota = createOfflineQueue({ store: quotaStore, boardId: "b-quota", clock });
    const rQuota = qQuota.enqueue({ elements: [makeEl("q1")] });
    expect(rQuota.ok).toBe(true);
    if (rQuota.ok) expect(rQuota.persisted).toBe(false);
  });

  test("drains in FIFO order, removes each op only after ack, and resumes cleanly after mid-flush disconnect", async () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 1_000 });
    const q = createOfflineQueue({ store, boardId: "b-flush", clock });

    q.enqueue({ id: "op-1", elements: [makeEl("e1", { x: 1 })] });
    clock.advance(10);
    q.enqueue({ id: "op-2", elements: [makeEl("e2", { x: 2 })] });
    clock.advance(10);
    q.enqueue({ id: "op-3", elements: [makeEl("e3", { x: 3 })] });

    /** @type {string[]} */
    const delivered = [];
    let failOnSecond = true;

    // First flush: op-1 acks, op-2 throws (connection dropped mid-flush)
    const first = await q.flush({
      send: async op => {
        if (op.id === "op-2" && failOnSecond) {
          throw new Error("socket closed");
        }
        delivered.push(op.id);
        return true;
      },
    });

    expect(first.ok).toBe(false);
    expect(first.reason).toBe("disconnected");
    expect(first.sent).toBe(1);
    expect(first.remaining).toBe(2);
    expect(delivered).toEqual(["op-1"]);

    // Verify op-1 was removed from storage, while op-2 and op-3 remain persisted
    const afterCrash = createOfflineQueue({ store, boardId: "b-flush", clock });
    expect(afterCrash.restore()).toEqual({ ok: true, restored: 2, truncated: false });
    expect(afterCrash.pending().map(o => o.id)).toEqual(["op-2", "op-3"]);

    // Also test explicit non-ack ({ ok: false }) stops without dropping head
    const nonAck = await afterCrash.flush({
      send: async () => ({ ok: false, reason: "backpressure" }),
    });
    expect(nonAck).toEqual({ ok: false, reason: "backpressure", sent: 0, skipped: 0, remaining: 2 });
    expect(afterCrash.pending().map(o => o.id)).toEqual(["op-2", "op-3"]);

    // Reconnect and resume: op-2 and op-3 drain in FIFO order
    failOnSecond = false;
    const resumed = await afterCrash.flush({
      send: async op => {
        delivered.push(op.id);
        return { ok: true };
      },
    });
    expect(resumed).toEqual({ ok: true, sent: 2, skipped: 0, remaining: 0 });
    expect(delivered).toEqual(["op-1", "op-2", "op-3"]);
    expect(afterCrash.stats()).toEqual({ count: 0, bytes: 0, oldestAt: null, truncated: false });
    expect(store.get(afterCrash.key)).toBeNull();
  });

  test("guards against concurrent flush and avoids coalescing into an in-flight head op", async () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 1_000 });
    const q = createOfflineQueue({ store, boardId: "b-inflight", clock });

    q.enqueue({ elements: [makeEl("e1", { x: 10, version: 2 })] });

    let releaseSend = () => {};
    const sendGate = new Promise(resolve => {
      releaseSend = () => resolve(undefined);
    });

    /** @type {number[]} */
    const sentX = [];
    const flushPromise = q.flush({
      send: async op => {
        sentX.push(op.elements[0].x);
        if (sentX.length === 1) await sendGate;
        return true;
      },
    });

    // Re-entrant flush is rejected cleanly
    const concurrent = await q.flush({ send: async () => true });
    expect(concurrent.ok).toBe(false);
    expect(concurrent.reason).toBe("flush-in-progress");

    // Enqueueing an update to the same element while head is in-flight MUST NOT coalesce into head
    const mid = q.enqueue({ elements: [makeEl("e1", { x: 99, version: 3 })] });
    expect(mid.ok).toBe(true);
    if (mid.ok) expect(mid.coalesced).toBe(false);
    expect(q.stats().count).toBe(2);

    releaseSend();
    const done = await flushPromise;
    expect(done).toEqual({ ok: true, sent: 2, skipped: 0, remaining: 0 });
    expect(sentX).toEqual([10, 99]);
  });

  test("conflict-safe 3-way merge preserves unrelated remote edits and rebases version for Doc.apply", async () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 20_000, seed: 7 });

    // Shared initial board state: e1 (v2) and e2 (v1)
    const baseE1 = makeEl("e1", { x: 0, y: 0, strokeColor: "#1e1e1e", version: 2, versionNonce: 10, updated: 19_000 });
    const baseE2 = makeEl("e2", { x: 200, y: 200, strokeColor: "#1e1e1e", version: 1, versionNonce: 20, updated: 19_000 });

    // Live remote Doc diverges while we are offline:
    // - Remote changes e1's strokeColor and width (v2 -> v5)
    // - Remote moves unrelated element e2 (v1 -> v3)
    const remoteDoc = new Doc(emptyScene());
    remoteDoc.apply({
      elements: [
        makeEl("e1", { x: 0, y: 0, width: 180, strokeColor: "#2f9e44", version: 5, versionNonce: 55, updated: 20_100 }),
        makeEl("e2", { x: 400, y: 500, strokeColor: "#1971c2", version: 3, versionNonce: 33, updated: 20_200 }),
      ],
    }, { force: true });

    // Local user offline moves e1 from (0,0) -> (120, 80) in multiple drag steps (v2 -> v3 -> v4)
    const q = createOfflineQueue({ store, boardId: "b-merge", clock });
    q.enqueue({
      elements: [makeEl("e1", { x: 60, y: 40, strokeColor: "#1e1e1e", version: 3, updated: 20_050 })],
      baseElements: { e1: baseE1 },
    });
    clock.advance(50);
    q.enqueue({
      elements: [makeEl("e1", { x: 120, y: 80, strokeColor: "#1e1e1e", version: 4, updated: 20_150 })],
    });
    expect(q.stats().count).toBe(1);
    expect(hasRemoteConflict(q.pending()[0], remoteDoc)).toBe(true);

    // Flush using built-in LWW/3-way merge against remoteDoc
    const res = await q.flush({
      remoteState: () => remoteDoc,
      send: async op => {
        const changed = remoteDoc.apply(op);
        expect(changed).toEqual(["e1"]);
        return true;
      },
    });

    expect(res).toEqual({ ok: true, sent: 1, skipped: 0, remaining: 0 });

    // Local x/y survived AND remote strokeColor/width survived AND version was rebased > 5!
    const mergedE1 = remoteDoc.get("e1");
    expect(mergedE1.x).toBe(120);
    expect(mergedE1.y).toBe(80);
    expect(mergedE1.width).toBe(180);
    expect(mergedE1.strokeColor).toBe("#2f9e44");
    expect(mergedE1.version).toBe(6);

    // Unrelated remote element e2 was untouched
    const untouchedE2 = remoteDoc.get("e2");
    expect(untouchedE2.x).toBe(400);
    expect(untouchedE2.strokeColor).toBe("#1971c2");
    expect(untouchedE2.version).toBe(3);
  });

  test("2-way LWW merge handles remote wins, local wins, remote deletions, and custom reconcile hooks", async () => {
    const clock = virtualClock({ t0: 30_000, seed: 11 });
    const remoteDoc = new Doc(emptyScene());
    remoteDoc.apply({
      elements: [
        makeEl("stale", { x: 500, version: 4, updated: 35_000 }),
        makeEl("deleted", { x: 10, version: 4, updated: 32_000, isDeleted: true }),
        makeEl("newer-local", { x: 10, version: 4, updated: 25_000 }),
      ],
    }, { force: true });

    // Stale offline op (updated 29_000 < remote 35_000) -> remote wins, op becomes null
    const mStale = mergeOfflineOp(
      { elements: [makeEl("stale", { x: 20, version: 2, updated: 29_000 })] },
      remoteDoc,
      { clock }
    );
    expect(mStale.op).toBeNull();
    expect(mStale.dropped).toEqual(["stale"]);
    expect(mStale.conflicts).toEqual([{ id: "stale", resolution: "remote" }]);

    // Remote deleted element wins over older offline move
    const mDel = mergeOfflineOp(
      { elements: [makeEl("deleted", { x: 99, version: 2, updated: 31_000 })] },
      remoteDoc,
      { clock }
    );
    expect(mDel.op).toBeNull();
    expect(mDel.conflicts).toEqual([{ id: "deleted", resolution: "dropped-deleted" }]);

    // Newer local edit wins and rebases version above remote (4 -> 5)
    const mLocal = mergeOfflineOp(
      { elements: [makeEl("newer-local", { x: 77, version: 2, updated: 30_000 })] },
      remoteDoc,
      { clock }
    );
    expect(mLocal.op).not.toBeNull();
    expect(mLocal.op?.elements?.[0].x).toBe(77);
    expect(mLocal.op?.elements?.[0].version).toBe(5);
    expect(mLocal.conflicts).toEqual([{ id: "newer-local", resolution: "local" }]);

    // Custom reconcile hook in flush: skipped when returning null, applied when returning merged op
    const store = memoryStore();
    const q = createOfflineQueue({ store, boardId: "b-custom-reconcile", clock });
    q.enqueue({ elements: [makeEl("stale", { x: 20, version: 2, updated: 29_000 })] });
    q.enqueue({ elements: [makeEl("brand-new", { x: 42, version: 1, updated: 30_000 })] });

    let reconcileCalls = 0;
    /** @type {string[]} */
    const sentIds = [];
    const flushRes = await q.flush({
      remoteState: remoteDoc,
      reconcile: (queuedOp, remote) => {
        reconcileCalls++;
        return mergeOfflineOp(queuedOp, remote, { clock });
      },
      send: async op => {
        sentIds.push(op.elements[0].id);
        return true;
      },
    });

    // reconcile only called for "stale" (which conflicted with remoteDoc), NOT for "brand-new"
    expect(reconcileCalls).toBe(1);
    expect(flushRes).toEqual({ ok: true, sent: 1, skipped: 1, remaining: 0 });
    expect(sentIds).toEqual(["brand-new"]);
  });

  test("clear() empties memory and removes persisted storage key", () => {
    const store = memoryStore();
    const clock = virtualClock({ t0: 1_000 });
    const q = createOfflineQueue({ store, boardId: "b-clear", maxOps: 1, clock });

    q.enqueue({ elements: [makeEl("a")] });
    q.enqueue({ elements: [makeEl("b")] }); // triggers truncated = true
    expect(q.stats().truncated).toBe(true);
    expect(store.get(q.key)).not.toBeNull();

    q.clear();
    expect(q.stats()).toEqual({ count: 0, bytes: 0, oldestAt: null, truncated: false });
    expect(q.pending()).toEqual([]);
    expect(store.get(q.key)).toBeNull();
  });
});
