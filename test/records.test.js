// Comments and reactions (PROTOCOL.md § Records): durable, sequenced, idempotent on resend and replay.
import { test, expect } from "bun:test";
import { direct, world, errors } from "./world.js";
import { Room } from "../packages/protocol/room.js";
import { Records } from "../packages/protocol/records.js";
import { clone } from "../packages/core/model.js";

const point = { point: { x: 10, y: 20 } };
function board() {
  const d = direct();
  const join = (user, role, client, name) => { const inbox = [], c = d.room.connect(m => inbox.push(m)); let n = 0; d.room.receive(c, { t: "hello", v: 1, board: "b1", since: 0, client }, { n: ++n, user, role, name }); let k = 0; const x = { inbox, c, rec: op => { d.room.receive(c, { t: "op", id: `${client}:${++k}`, sentAt: 0, stream: "records", op }, { n: ++n }); return inbox.filter(m => m.t === "ack" || m.t === "error").at(-1); }, resend: op => { d.room.receive(c, { t: "op", id: `${client}:${k}`, sentAt: 0, stream: "records", op }, { n: ++n }); return inbox.filter(m => m.t === "ack" || m.t === "error").at(-1); } }; return x; };
  return { d, owner: join("uo", "owner", "o", "Olga"), editor: join("ue", "editor", "e", "Ed"), ann: join("ua", "annotator", "a", "Ann"), com: join("uc", "commenter", "c", "Cy"), viewer: join("uv", "viewer", "v", "Vi"), threads: () => d.room.records.toJSON().threads };
}

test("threads, replies, edits, deletes, resolve and reactions, with who may do each", () => {
  const b = board();
  expect(b.com.rec({ do: "thread", id: "t1", anchor: point, text: "first" })).toMatchObject({ t: "ack", seq: 1 });
  expect(b.ann.rec({ do: "reply", id: "r1", thread: "t1", text: "a reply" }).t).toBe("ack");
  expect(b.viewer.rec({ do: "reply", id: "r9", thread: "t1", text: "no" }).code).toBe("forbidden");
  expect(b.d.log.entries[0]).toMatchObject({ stream: "records", by: "uc", name: "Cy", at: 5, rv: 1 });
  // edit: its author only, not even a moderator
  expect(b.owner.rec({ do: "edit", id: "r1", text: "hijack" }).code).toBe("forbidden");
  expect(b.ann.rec({ do: "edit", id: "r1", text: "edited" }).t).toBe("ack");
  // move: the thread's author or a moderator
  expect(b.ann.rec({ do: "move", id: "t1", anchor: { stream: "board", element: "el9", x: 1, y: 1 } }).code).toBe("forbidden");
  expect(b.com.rec({ do: "move", id: "t1", anchor: { stream: "board", element: "el9", x: 1, y: 1 } }).t).toBe("ack");   // the element needn't exist
  expect(b.editor.rec({ do: "resolve", id: "t1" }).t).toBe("ack");
  expect(b.owner.rec({ do: "react", id: "r1", emoji: "👍", on: true }).t).toBe("ack");
  expect(b.com.rec({ do: "react", id: "r1", emoji: "👍", on: true }).t).toBe("ack");
  expect(b.threads()).toEqual([{
    id: "t1", anchor: { stream: "board", element: "el9", x: 1, y: 1 }, by: "uc", name: "Cy", at: 5, resolved: { by: "ue", name: "Ed", at: 5 },
    comments: [
      { id: "t1", by: "uc", name: "Cy", at: 5, text: "first", reactions: {} },
      { id: "r1", by: "ua", name: "Ann", at: 5, text: "edited", edited: 5, reactions: { "👍": ["uo", "uc"] } },
    ],
  }]);
  expect(b.com.rec({ do: "reopen", id: "t1" }).t).toBe("ack");
  expect(b.owner.rec({ do: "react", id: "r1", emoji: "👍", on: false }).t).toBe("ack");
  expect(b.threads()[0].resolved).toBeUndefined();
  expect(b.threads()[0].comments[1].reactions).toEqual({ "👍": ["uc"] });
  // delete: the author or a moderator; the text is cleared, the tombstone stays
  expect(b.com.rec({ do: "delete", id: "r1" }).code).toBe("forbidden");
  expect(b.editor.rec({ do: "delete", id: "r1" }).t).toBe("ack");
  expect(b.threads()[0].comments[1]).toEqual({ id: "r1", by: "ua", name: "Ann", at: 5, text: "", edited: 5, deleted: 5, reactions: {} });
  // unknown targets and reused ids are refused
  expect(b.com.rec({ do: "reply", id: "r2", thread: "nope", text: "x" }).code).toBe("bad-op");
  expect(b.com.rec({ do: "react", id: "nope", emoji: "👍", on: true }).code).toBe("bad-op");
  expect(b.com.rec({ do: "resolve", id: "r1" }).code).toBe("bad-op");                 // a comment is not a thread
  expect(b.com.rec({ do: "thread", id: "r1", anchor: point, text: "reuse a tombstone's id" }).code).toBe("bad-op");
  expect(b.com.rec({ do: "reply", id: "t1", thread: "t1", text: "reuse" }).code).toBe("bad-op");
});

test("repeats and dead targets are no-ops that are still logged and acked; rights are checked first", () => {
  const b = board();
  b.com.rec({ do: "thread", id: "t1", anchor: point, text: "first" });
  b.ann.rec({ do: "reply", id: "r1", thread: "t1", text: "reply" });
  b.com.rec({ do: "resolve", id: "t1" });
  const before = clone(b.threads()), seq = b.d.room.seq;
  expect(b.ann.rec({ do: "resolve", id: "t1" })).toMatchObject({ t: "ack", seq: seq + 1 });       // a repeat: gets a seq, changes nothing
  expect(b.threads()).toEqual(before);                                                             // still resolved by the first
  b.ann.rec({ do: "react", id: "r1", emoji: "🎉", on: true });
  const once = clone(b.threads());
  expect(b.ann.rec({ do: "react", id: "r1", emoji: "🎉", on: true }).t).toBe("ack");
  expect(b.ann.rec({ do: "react", id: "t1", emoji: "🎉", on: false }).t).toBe("ack");             // unset what was never set
  expect(b.threads()).toEqual(once);
  b.editor.rec({ do: "delete", id: "r1" });
  const dead = clone(b.threads());
  for (const [who, op] of [[b.ann, { do: "edit", id: "r1", text: "too late" }], [b.com, { do: "react", id: "r1", emoji: "👍", on: true }], [b.owner, { do: "delete", id: "r1" }]])
    expect([op.do, who.rec(op).t]).toEqual([op.do, "ack"]);
  expect(b.com.rec({ do: "edit", id: "r1", text: "not mine" }).code).toBe("forbidden");           // a tombstone still knows its author
  expect(b.threads()).toEqual(dead);
  b.com.rec({ do: "delete", id: "t1" });                                                           // the first comment: the thread is hidden
  const hidden = clone(b.threads());
  for (const [who, op] of [[b.ann, { do: "reply", id: "r5", thread: "t1", text: "late" }], [b.com, { do: "reopen", id: "t1" }], [b.com, { do: "move", id: "t1", anchor: point }], [b.ann, { do: "resolve", id: "t1" }]])
    expect([op.do, who.rec(op).t]).toEqual([op.do, "ack"]);
  expect(b.threads()).toEqual(hidden);
  expect(b.ann.rec({ do: "reply", id: "r5", thread: "t1", text: "the id was not reserved" }).t).toBe("ack");
  expect(b.d.log.entries.length).toBe(b.d.room.seq);
  // replay meets the same no-ops and agrees
  expect(Room.fromLog({ board: "b1", tenant: "t1", log: b.d.log }).records.toJSON().threads).toEqual(hidden);
});

test("a resend of a record op gets the same ack and is applied once; replay and a checkpoint give the same records", () => {
  const b = board();
  b.com.rec({ do: "thread", id: "t1", anchor: point, text: "first" });
  const on = { do: "react", id: "t1", emoji: "❤️", on: true };
  const first = b.ann.rec(on);
  expect(b.ann.resend(on)).toEqual(first);
  expect(b.ann.resend(on)).toEqual(first);
  expect(b.threads()[0].comments[0].reactions).toEqual({ "❤️": ["ua"] });
  expect(b.d.log.entries.length).toBe(2);
  const want = clone(b.threads());
  expect(Room.fromLog({ board: "b1", tenant: "t1", log: b.d.log }).records.toJSON().threads).toEqual(want);
  b.d.room.checkpoint();
  b.com.rec({ do: "reply", id: "r1", thread: "t1", text: "after the checkpoint" });
  const back = Room.fromLog({ board: "b1", tenant: "t1", log: b.d.log });
  expect(back.base.seq).toBe(2);
  expect(clone(back.state())).toEqual(clone(b.d.room.state()));
  expect(back.records.chars).toBe(b.d.room.records.chars);
});

test("caps: emoji per comment, comments per thread, text length; an emoji named like a prototype key is plain data", () => {
  const b = board();
  b.com.rec({ do: "thread", id: "t1", anchor: point, text: "first" });
  for (let i = 0; i < 20; i++) expect(b.com.rec({ do: "react", id: "t1", emoji: `e${i}`, on: true }).t).toBe("ack");
  expect(b.com.rec({ do: "react", id: "t1", emoji: "e20", on: true }).code).toBe("limit");
  expect(b.ann.rec({ do: "react", id: "t1", emoji: "e3", on: true }).t).toBe("ack");               // an emoji already there is fine
  expect(b.com.rec({ do: "react", id: "t1", emoji: "e0", on: false }).t).toBe("ack");
  expect(b.com.rec({ do: "react", id: "t1", emoji: "__proto__", on: true }).t).toBe("ack");
  const r = b.threads()[0].comments[0].reactions;
  expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  expect(Object.keys(r).length).toBe(20);
  expect(new Records(JSON.parse(JSON.stringify(b.d.room.records.toJSON()))).toJSON()).toEqual(b.d.room.records.toJSON());
  expect(b.com.rec({ do: "reply", id: "big", thread: "t1", text: "x".repeat(10_001) }).code).toBe("limit");
  for (let i = 1; i < 500; i++) b.ann.rec({ do: "reply", id: `r${i}`, thread: "t1", text: "x" });
  expect(b.threads()[0].comments.length).toBe(500);
  expect(b.ann.rec({ do: "reply", id: "r500", thread: "t1", text: "x" }).code).toBe("limit");
});

test("a replica shows its own comment at once; a refused record op only leaves the overlay (no reset, no resync)", () => {
  const w = world(["commenter", "editor"], 41);
  w.settle();
  const [com, ed] = w.clients;
  w.send(com, "records", { do: "thread", id: "t1", anchor: point, text: "mine" });
  expect(com.r.recordsState().threads.map(t => t.comments[0].text)).toEqual(["mine"]);   // optimistic
  expect(ed.r.recordsState().threads).toEqual([]);
  w.settle();
  expect(ed.r.recordsState()).toEqual(w.room.records.toJSON());                          // caught up by entries: the name came with the entry
  expect(com.r.recordsState()).toEqual(w.room.records.toJSON());
  expect(ed.r.recordsState().threads[0]).toMatchObject({ by: "u0", name: "User 0", comments: [{ name: "User 0" }] });
  // The moderator deletes the comment while the commenter reacts to a comment that never existed.
  w.send(ed, "records", { do: "delete", id: "t1" });
  w.send(com, "records", { do: "react", id: "ghost", emoji: "👍", on: true });
  const applied = com.r.applied;
  w.flush(com);
  const refusal = errors(com).at(-1);
  expect(refusal.code).toBe("bad-op");
  const did = com.r.receive(refusal);
  expect(did).toMatchObject({ reset: false, dropped: [refusal.id] });
  expect([com.r.resync, com.r.pending.size, com.r.applied]).toEqual([false, 0, applied]);
  w.send(com, "records", { do: "react", id: "t1", emoji: "👍", on: true });              // a race with the delete: a logged no-op
  w.settle();
  expect(com.r.recordsState()).toEqual(w.room.records.toJSON());
  expect(w.room.records.toJSON().threads[0].comments[0]).toMatchObject({ text: "", reactions: {} });
  expect(errors(com).filter(e => e.code !== "bad-op")).toEqual([]);
  // A late joiner gets the records in its catch-up, by entries and by snapshot.
  for (const checkpoint of [false, true]) {
    if (checkpoint) w.room.checkpoint();
    const late = w.clients[1]; late.r = w.replica("late"); w.drop(late); w.connect(late); w.settle();
    expect(late.r.recordsState()).toEqual(w.room.records.toJSON());
  }
  w.send(com, "notes", { elements: [{ id: "n", version: 1, versionNonce: 1 }] }); w.settle();       // a commenter writes no notes in v1
  expect(w.room.streams.notes.getAny("n")).toBe(null);
});

test("Records accepts all-hands poll and Q&A actions alongside comment threads without altering thread snapshots", () => {
  const r = new Records();
  expect(r.check({ do: "thread", id: "t1", anchor: point, text: "hello" }, "uc", "commenter")).toBeNull();
  expect(r.apply({ do: "thread", id: "t1", anchor: point, text: "hello" }, "uc", 1, "Cy")).toBe(true);
  expect(Object.keys(r.toJSON())).toEqual(["threads"]);

  expect(r.check({ do: "poll.create", id: "p1", question: "Ready?", options: ["Yes", "No"] }, "ue", "editor")).toBeNull();
  expect(r.apply({ do: "poll.create", id: "p1", question: "Ready?", options: ["Yes", "No"] }, "ue", 2, "Ed")).toBe(true);
  expect(r.apply({ do: "poll.vote", pollId: "p1", optionIndex: 0 }, "uc", 3, "Cy")).toBe(true);
  expect(r.apply({ do: "qa.ask", id: "q1", text: "Any ETA?" }, "uc", 4, "Cy")).toBe(true);
  expect(r.apply({ do: "qa.upvote", questionId: "q1" }, "ua", 5, "Ann")).toBe(true);

  const snap = JSON.parse(JSON.stringify(r.toJSON()));
  const restored = new Records(snap);
  expect(restored.toJSON()).toEqual(r.toJSON());
  expect(restored.chars).toBe(r.chars);
});
