import { describe, test, expect } from "bun:test";
import { Doc } from "../../packages/core/doc.js";
import { makeElement, emptyScene, clone } from "../../packages/core/model.js";
import {
  createReplaySession,
  replayStateAt,
  replayStateAtTime,
  replaySummary,
  stepReplay,
} from "../../packages/core/replay.js";

function rect(id, props = {}) {
  return makeElement("rectangle", {
    id,
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    version: 1,
    versionNonce: 1,
    ...props,
  });
}

describe("packages/core/replay.js", () => {
  test("reconstructs exact board state at any seq including creates, updates, appState, and deletes", () => {
    const r1v1 = rect("r1", { x: 10, y: 10, version: 1, versionNonce: 10 });
    const r2v1 = rect("r2", { x: 200, y: 50, version: 1, versionNonce: 20 });
    const r1v2 = { ...clone(r1v1), x: 90, y: 40, version: 2, versionNonce: 11 };
    const r2del = { ...clone(r2v1), isDeleted: true, version: 2, versionNonce: 21 };

    const entries = [
      { seq: 1, ts: 1_700_000_001_000, user: "alice", op: { elements: [r1v1] } },
      { seq: 2, ts: 1_700_000_002_000, user: "bob", op: { elements: [r2v1] } },
      { seq: 3, ts: 1_700_000_003_000, user: "alice", op: { elements: [r1v2] } },
      { seq: 4, ts: 1_700_000_004_000, user: "carol", op: { appState: { grid: 20, snap: true } } },
      { seq: 5, ts: 1_700_000_005_000, user: "bob", op: { elements: [r2del] } },
    ];

    const session = createReplaySession(entries, { keyframeInterval: 2 });

    // Before first op: empty base state
    const s0 = replayStateAt(session, 0);
    expect(s0.seq).toBe(0);
    expect(s0.index).toBe(-1);
    expect(s0.total).toBe(5);
    expect(s0.elements).toEqual([]);

    // seq 1: r1 created
    const s1 = replayStateAt(session, 1);
    expect(s1.seq).toBe(1);
    expect(s1.ts).toBe(1_700_000_001_000);
    expect(s1.user).toBe("alice");
    expect(s1.index).toBe(0);
    expect(s1.total).toBe(5);
    expect(s1.elements.map(e => e.id)).toEqual(["r1"]);
    expect(s1.elements[0].x).toBe(10);

    // seq 2: r1 and r2 exist
    const s2 = replayStateAt(session, 2);
    expect(s2.user).toBe("bob");
    expect(s2.elements.map(e => e.id)).toEqual(["r1", "r2"]);

    // seq 3: r1 moved
    const s3 = replayStateAt(session, 3);
    expect(s3.elements.find(e => e.id === "r1").x).toBe(90);
    expect(s3.elements.find(e => e.id === "r1").y).toBe(40);

    // seq 4: appState updated
    const s4 = replayStateAt(session, 4);
    expect(s4.user).toBe("carol");
    expect(s4.appState.herdr.grid).toBe(20);
    expect(s4.appState.herdr.snap).toBe(true);

    // seq 5: r2 deleted (excluded from live elements)
    const s5 = replayStateAt(session, 5);
    expect(s5.index).toBe(4);
    expect(s5.elements.map(e => e.id)).toEqual(["r1"]);
    expect(s5.appState.herdr.grid).toBe(20);

    // Beyond endSeq clamps to last entry
    const s99 = replayStateAt(session, 99);
    expect(s99.seq).toBe(5);
    expect(s99.index).toBe(4);
    expect(s99.elements).toEqual(s5.elements);
  });

  test("supports Plenary Room log entry shape ({ seq, at, by, stream, op }) and ignores records stream", () => {
    const r1 = rect("r1", { version: 1, versionNonce: 1 });
    const entries = [
      { seq: 10, at: 5000, by: "u-alice", stream: "board", op: { elements: [r1] } },
      { seq: 11, at: 6000, by: "u-bob", stream: "records", op: { do: "thread", id: "t1", text: "hi" } },
      { seq: 12, at: 7000, by: "u-alice", stream: "board", op: { elements: [{ ...clone(r1), x: 300, version: 2, versionNonce: 2 }] } },
    ];

    const session = createReplaySession(entries);
    expect(replaySummary(session)).toEqual({
      startSeq: 10,
      endSeq: 12,
      startTs: 5000,
      endTs: 7000,
      count: 3,
      authors: ["u-alice", "u-bob"],
    });

    const at11 = replayStateAt(session, 11);
    expect(at11.seq).toBe(11);
    expect(at11.ts).toBe(6000);
    expect(at11.user).toBe("u-bob");
    expect(at11.elements.map(e => [e.id, e.x])).toEqual([["r1", 10]]);

    const at12 = replayStateAt(session, 12);
    expect(at12.elements.map(e => [e.id, e.x])).toEqual([["r1", 300]]);
  });

  test("keyframe cache produces bit-identical state to full replay across 120 ops", () => {
    const entries = [];
    const versions = new Map();
    const users = ["alice", "bob", "carol", "dave"];

    for (let seq = 1; seq <= 120; seq++) {
      const id = `el-${(seq % 15) + 1}`;
      const nextVer = (versions.get(id) ?? 0) + 1;
      versions.set(id, nextVer);

      let op;
      if (seq % 17 === 0) {
        op = { appState: { grid: (seq % 4) * 10, snap: seq % 2 === 0 } };
      } else if (seq % 11 === 0) {
        op = {
          elements: [rect(id, {
            x: seq * 3,
            y: seq * 2,
            isDeleted: true,
            version: nextVer,
            versionNonce: seq,
          })],
        };
      } else {
        op = {
          elements: [rect(id, {
            x: seq * 5,
            y: seq * 4,
            width: 50 + (seq % 40),
            isDeleted: false,
            version: nextVer,
            versionNonce: seq,
          })],
        };
      }

      entries.push({
        seq,
        ts: 1_700_000_000_000 + seq * 1000,
        user: users[seq % users.length],
        op,
      });
    }

    const withKeyframes = createReplaySession(entries, { keyframeInterval: 7 });
    const fullReplay = createReplaySession(entries, { keyframeInterval: 10_000 });

    expect(withKeyframes.keyframes.length).toBe(Math.floor(120 / 7));
    expect(fullReplay.keyframes.length).toBe(0);

    for (let seq = 0; seq <= 121; seq++) {
      expect(replayStateAt(withKeyframes, seq)).toEqual(replayStateAt(fullReplay, seq));
    }
  });

  test("replayStateAtTime binary-searches by timestamp accurately", () => {
    const entries = [
      { seq: 1, ts: 1000, user: "a", op: { elements: [rect("e1", { version: 1, versionNonce: 1 })] } },
      { seq: 2, ts: 2000, user: "b", op: { elements: [rect("e2", { version: 1, versionNonce: 1 })] } },
      { seq: 3, ts: 2000, user: "c", op: { elements: [rect("e3", { version: 1, versionNonce: 1 })] } },
      { seq: 4, ts: 5000, user: "d", op: { elements: [rect("e4", { version: 1, versionNonce: 1 })] } },
    ];

    const session = createReplaySession(entries, { keyframeInterval: 2 });

    // Before first timestamp -> base state
    const before = replayStateAtTime(session, 500);
    expect(before.index).toBe(-1);
    expect(before.elements).toEqual([]);

    // Exact match
    const t1 = replayStateAtTime(session, 1000);
    expect(t1.seq).toBe(1);
    expect(t1.elements.map(e => e.id)).toEqual(["e1"]);

    // Duplicate timestamp returns last entry at that timestamp
    const t2 = replayStateAtTime(session, 2000);
    expect(t2.seq).toBe(3);
    expect(t2.elements.map(e => e.id)).toEqual(["e1", "e2", "e3"]);

    // Between timestamps
    const tMid = replayStateAtTime(session, 3500);
    expect(tMid.seq).toBe(3);

    // Past end timestamp
    const tAfter = replayStateAtTime(session, 99_999);
    expect(tAfter.seq).toBe(4);
    expect(tAfter.elements.map(e => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
  });

  test("strict read-only isolation: never mutates live Doc, input entries, baseSnapshot, or cached keyframes", () => {
    const liveDoc = new Doc(emptyScene());
    const baseEl = rect("base-1", { x: 42, version: 1, versionNonce: 1 });
    liveDoc.apply({ elements: [baseEl] });
    const revBefore = liveDoc.rev;
    const liveBefore = clone(liveDoc.toScene());

    const inputEntries = [
      { seq: 1, ts: 100, user: "alice", op: { elements: [rect("new-1", { x: 100, version: 1, versionNonce: 2 })] } },
      { seq: 2, ts: 200, user: "bob", op: { elements: [{ ...clone(baseEl), x: 999, version: 2, versionNonce: 3 }] } },
    ];
    const entriesSnapshot = clone(inputEntries);

    const session = createReplaySession(inputEntries, { baseSnapshot: liveDoc, keyframeInterval: 1 });

    // Mutate input entries after session creation
    inputEntries[0].op.elements[0].x = -9999;
    inputEntries.push({ seq: 3, ts: 300, user: "eve", op: { elements: [rect("injected")] } });

    // Mutate liveDoc after session creation
    liveDoc.apply({ elements: [rect("live-only", { version: 1, versionNonce: 9 })] });

    // Replay is completely unaffected by external mutations
    const s1 = replayStateAt(session, 1);
    expect(s1.elements.find(e => e.id === "new-1").x).toBe(100);
    expect(s1.elements.find(e => e.id === "live-only")).toBeUndefined();
    expect(replaySummary(session).count).toBe(2);

    // Mutating returned snapshot cannot corrupt cached keyframes
    s1.elements[0].x = 77777;
    s1.appState.herdr.grid = 999;
    const s1Again = replayStateAt(session, 1);
    expect(s1Again.elements[0].x).not.toBe(77777);
    expect(s1Again.appState.herdr.grid).not.toBe(999);

    // Original input entries were never mutated by createReplaySession
    expect(entriesSnapshot[0].op.elements[0].x).toBe(100);

    // Verify a live Doc passed as baseSnapshot is never mutated by replay operations
    const untouchedDoc = new Doc(liveBefore);
    const revUntouched = untouchedDoc.rev;
    const s2Session = createReplaySession(entriesSnapshot, { baseSnapshot: untouchedDoc, keyframeInterval: 1 });
    replayStateAt(s2Session, 2);
    stepReplay(s2Session, 1, 1);
    expect(untouchedDoc.rev).toBe(revUntouched);
    expect(untouchedDoc.toScene()).toEqual(liveBefore);
    expect(revBefore).toBeGreaterThan(0);
  });

  test("stepReplay steps forward/backward by 1 or N ops and clamps cleanly to [startSeq, endSeq]", () => {
    const entries = [
      { seq: 5, ts: 100, user: "a", op: { elements: [rect("e1", { version: 1, versionNonce: 1 })] } },
      { seq: 10, ts: 200, user: "b", op: { elements: [rect("e2", { version: 1, versionNonce: 1 })] } },
      { seq: 20, ts: 300, user: "c", op: { elements: [rect("e3", { version: 1, versionNonce: 1 })] } },
      { seq: 25, ts: 400, user: "d", op: { elements: [rect("e4", { version: 1, versionNonce: 1 })] } },
    ];
    const session = createReplaySession(entries);

    expect(stepReplay(session, 5, 1).seq).toBe(10);
    expect(stepReplay(session, 5, 2).seq).toBe(20);
    expect(stepReplay(session, 5, 100).seq).toBe(25);
    expect(stepReplay(session, 25, -1).seq).toBe(20);
    expect(stepReplay(session, 25, -3).seq).toBe(5);
    expect(stepReplay(session, 5, -1).seq).toBe(5);
    expect(stepReplay(session, 5, -50).seq).toBe(5);
  });

  test("handles empty history and unsorted entries gracefully", () => {
    const empty = createReplaySession([]);
    expect(replaySummary(empty)).toEqual({
      startSeq: 0,
      endSeq: 0,
      startTs: 0,
      endTs: 0,
      count: 0,
      authors: [],
    });
    expect(replayStateAt(empty, 1).elements).toEqual([]);
    expect(replayStateAtTime(empty, 1000).elements).toEqual([]);
    expect(stepReplay(empty, 0, 1).elements).toEqual([]);

    // Unsorted entries get sorted ascending by seq
    const unsorted = createReplaySession([
      { seq: 3, ts: 300, user: "c", op: { elements: [rect("e3", { version: 1, versionNonce: 1 })] } },
      { seq: 1, ts: 100, user: "a", op: { elements: [rect("e1", { version: 1, versionNonce: 1 })] } },
      { seq: 2, ts: 200, user: "b", op: { elements: [rect("e2", { version: 1, versionNonce: 1 })] } },
    ]);
    expect(replaySummary(unsorted).startSeq).toBe(1);
    expect(replaySummary(unsorted).endSeq).toBe(3);
    expect(replayStateAt(unsorted, 2).elements.map(e => e.id)).toEqual(["e1", "e2"]);
  });
});
