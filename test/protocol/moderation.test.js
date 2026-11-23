// All-hands audience moderation: pure model, envelope validation, and Room enforcement (#33).
import { test, expect } from "bun:test";
import { direct, slowLog, tick } from "../world.js";
import { Room } from "../../packages/protocol/room.js";
import { Replica } from "../../packages/protocol/replica.js";
import { opProblem, appStateProblem } from "../../packages/protocol/envelope.js";
import {
  MAX_MUTED_USERS,
  MAX_MODERATION_USER_ID_CHARS,
  moderationOf,
  moderationProblem,
  canWriteUnderModeration,
} from "../../packages/protocol/moderation.js";
import { makeElement } from "../../packages/core/model.js";

const rect = (id, extra = {}) => makeElement("rectangle", { id, ...extra });
const threadOp = id => ({ do: "thread", id, anchor: { point: { x: 1, y: 2 } }, text: "hello" });

// ---- pure moderation model ----

test("moderationOf safely normalizes missing, malformed, duplicate and over-cap inputs", () => {
  expect(moderationOf(null)).toEqual({ locked: false, mutedUsers: [] });
  expect(moderationOf(undefined)).toEqual({ locked: false, mutedUsers: [] });
  expect(moderationOf({})).toEqual({ locked: false, mutedUsers: [] });
  expect(moderationOf({ herdr: {} })).toEqual({ locked: false, mutedUsers: [] });
  expect(moderationOf({ herdr: { moderation: null } })).toEqual({ locked: false, mutedUsers: [] });
  expect(moderationOf({ herdr: { moderation: [] } })).toEqual({ locked: false, mutedUsers: [] });
  expect(moderationOf({ herdr: { moderation: { locked: "yes", mutedUsers: "u1" } } })).toEqual({ locked: false, mutedUsers: [] });

  // Accepts both doc.appState ({ herdr: { moderation } }) and herdr ({ moderation })
  expect(moderationOf({ herdr: { moderation: { locked: true, mutedUsers: ["u1", "u2"] } } }))
    .toEqual({ locked: true, mutedUsers: ["u1", "u2"] });
  expect(moderationOf({ moderation: { locked: true, mutedUsers: ["u1"] } }))
    .toEqual({ locked: true, mutedUsers: ["u1"] });

  // Deduplicates, strips invalid IDs, and caps at MAX_MUTED_USERS
  const messy = ["u1", "", "u1", 42, null, "x".repeat(MAX_MODERATION_USER_ID_CHARS + 1), "u2"];
  expect(moderationOf({ herdr: { moderation: { locked: false, mutedUsers: messy } } }))
    .toEqual({ locked: false, mutedUsers: ["u1", "u2"] });

  const many = Array.from({ length: MAX_MUTED_USERS + 25 }, (_, i) => `u${i}`);
  const norm = moderationOf({ herdr: { moderation: { locked: false, mutedUsers: many } } });
  expect(norm.mutedUsers.length).toBe(MAX_MUTED_USERS);
  expect(norm.mutedUsers[0]).toBe("u0");
  expect(norm.mutedUsers[MAX_MUTED_USERS - 1]).toBe(`u${MAX_MUTED_USERS - 1}`);
});

test("moderationProblem strictly validates schema, bounds, duplicates, and unknown keys", () => {
  expect(moderationProblem({ locked: false, mutedUsers: [] })).toBe(null);
  expect(moderationProblem({ locked: true, mutedUsers: ["u1", "u".repeat(128)] })).toBe(null);
  expect(moderationProblem({ locked: false, mutedUsers: Array.from({ length: MAX_MUTED_USERS }, (_, i) => `u${i}`) })).toBe(null);

  for (const bad of [
    null,
    undefined,
    [],
    "locked",
    {},
    { locked: true },
    { mutedUsers: [] },
    { locked: "true", mutedUsers: [] },
    { locked: false, mutedUsers: "u1" },
    { locked: false, mutedUsers: [""] },
    { locked: false, mutedUsers: ["x".repeat(129)] },
    { locked: false, mutedUsers: [123] },
    { locked: false, mutedUsers: ["u1", "u1"] },
    { locked: false, mutedUsers: Array.from({ length: MAX_MUTED_USERS + 1 }, (_, i) => `u${i}`) },
    { locked: false, mutedUsers: [], extra: true },
  ]) {
    expect([bad, typeof moderationProblem(bad)]).toEqual([bad, "string"]);
  }
});

test("canWriteUnderModeration: presenters never blocked; locked -> board-locked; muted -> user-muted", () => {
  const locked = { locked: true, mutedUsers: ["u-ed", "u-own", "u-ann", "u-com"] };
  const mutedOnly = { locked: false, mutedUsers: ["u-ed", "u-own", "u-ann", "u-com"] };
  const open = { locked: false, mutedUsers: [] };

  // Owners and editors are NEVER blocked, even when locked and listed in mutedUsers
  for (const role of ["owner", "editor"]) {
    expect(canWriteUnderModeration(role, "u-ed", locked)).toEqual({ allowed: true, reason: null });
    expect(canWriteUnderModeration(role, "u-own", mutedOnly)).toEqual({ allowed: true, reason: null });
  }

  // Annotator and commenter are blocked when locked ("board-locked" takes precedence)
  for (const role of ["annotator", "commenter"]) {
    expect(canWriteUnderModeration(role, "u-ann", locked)).toEqual({ allowed: false, reason: "board-locked" });
    expect(canWriteUnderModeration(role, "u-other", locked)).toEqual({ allowed: false, reason: "board-locked" });
  }

  // Annotator and commenter are blocked when muted ("user-muted"), unmuted users allowed
  expect(canWriteUnderModeration("annotator", "u-ann", mutedOnly)).toEqual({ allowed: false, reason: "user-muted" });
  expect(canWriteUnderModeration("commenter", "u-com", mutedOnly)).toEqual({ allowed: false, reason: "user-muted" });
  expect(canWriteUnderModeration("annotator", "u-free", mutedOnly)).toEqual({ allowed: true, reason: null });
  expect(canWriteUnderModeration("commenter", "u-free", mutedOnly)).toEqual({ allowed: true, reason: null });

  // Open or missing moderation allows all
  expect(canWriteUnderModeration("annotator", "u-ann", open)).toEqual({ allowed: true, reason: null });
  expect(canWriteUnderModeration("commenter", "u-com", null)).toEqual({ allowed: true, reason: null });
});

// ---- envelope validation ----

test("envelope allowlists and validates appState.moderation", () => {
  const op = moderation => ({
    t: "op",
    id: "c:1",
    sentAt: 0,
    stream: "board",
    op: { appState: { moderation }, appBase: { moderation: 0 } },
  });

  expect(appStateProblem({ moderation: { locked: true, mutedUsers: ["u1"] } })).toBe(null);
  expect(opProblem(op({ locked: true, mutedUsers: ["u1"] }))).toBe(null);
  expect(opProblem(op({ locked: false, mutedUsers: [] }))).toBe(null);

  expect(opProblem(op({ locked: "yes", mutedUsers: [] }))).toMatchObject({ code: "bad-op" });
  expect(opProblem(op({ locked: false, mutedUsers: ["u1", "u1"] }))).toMatchObject({ code: "bad-op" });
  expect(opProblem(op({ locked: false, mutedUsers: [], bogus: 1 }))).toMatchObject({ code: "bad-op" });
});

// ---- Room enforcement ----

test("backwards compatibility: boards without moderation allow annotators and commenters normally", () => {
  const d = direct();
  const ann = d.join("u-ann", "annotator", "ann");
  const com = d.join("u-com", "commenter", "com");

  ann.op(1, "notes", { elements: [rect("n1")] });
  com.op(1, "records", threadOp("t1"));
  expect(ann.of("ack")).toEqual([{ t: "ack", id: "ann:1", seq: 1 }]);
  expect(com.of("ack")).toEqual([{ t: "ack", id: "com:1", seq: 2 }]);
  expect(d.log.entries.length).toBe(2);
});

test("only owner/editor may change moderation; annotator cannot modify appState.herdr.moderation", () => {
  const d = direct();
  const ann = d.join("u-ann", "annotator", "ann");
  ann.op(1, "notes", { appState: { moderation: { locked: true, mutedUsers: [] } }, appBase: { moderation: 0 } });
  expect(ann.of("error").at(-1)).toMatchObject({ id: "ann:1", code: "forbidden" });
  expect(d.log.entries.length).toBe(0);
});

test("Room enforces board lock: annotator & commenter get { t: 'refused', reason: 'board-locked' }; editor & owner unaffected", () => {
  const d = direct();
  const ed = d.join("u-ed", "editor", "ed");
  const own = d.join("u-own", "owner", "own");
  const ann = d.join("u-ann", "annotator", "ann");
  const com = d.join("u-com", "commenter", "com");

  // Presenter locks the board (and even lists themselves in mutedUsers)
  ed.op(1, "board", {
    appState: { moderation: { locked: true, mutedUsers: ["u-ed", "u-own"] } },
    appBase: { moderation: 0 },
  });
  expect(ed.of("ack")).toEqual([{ t: "ack", id: "ed:1", seq: 1 }]);

  // Annotator writes to notes and records -> refused with board-locked, nothing logged
  ann.op(1, "notes", { elements: [rect("n1")] });
  expect(ann.inbox.at(-1)).toEqual({ t: "refused", id: "ann:1", reason: "board-locked" });
  ann.op(2, "records", threadOp("t1"));
  expect(ann.inbox.at(-1)).toEqual({ t: "refused", id: "ann:2", reason: "board-locked" });

  // Commenter writes to records -> refused with board-locked, nothing logged
  com.op(1, "records", threadOp("t2"));
  expect(com.inbox.at(-1)).toEqual({ t: "refused", id: "com:1", reason: "board-locked" });

  // Room state is uncorrupted
  expect(d.room.seq).toBe(1);
  expect(d.log.entries.length).toBe(1);
  expect(d.room.streams.notes.byId.size).toBe(0);
  expect(d.room.records.threads.size).toBe(0);

  // Editor and owner can still write to board, notes, and records
  ed.op(2, "board", { elements: [rect("b1")] });
  ed.op(3, "notes", { elements: [rect("en1")] });
  ed.op(4, "records", threadOp("et1"));
  own.op(1, "notes", { elements: [rect("on1")] });
  own.op(2, "records", threadOp("ot1"));
  expect(d.room.seq).toBe(6);

  // Presenter unlocks the board -> annotator and commenter can write again
  ed.op(5, "board", {
    appState: { moderation: { locked: false, mutedUsers: [] } },
    appBase: { moderation: 1 },
  });
  expect(ed.of("ack").at(-1)).toEqual({ t: "ack", id: "ed:5", seq: 7 });

  ann.op(3, "notes", { elements: [rect("n2")] });
  com.op(2, "records", threadOp("t3"));
  expect(ann.of("ack").at(-1)).toEqual({ t: "ack", id: "ann:3", seq: 8 });
  expect(com.of("ack").at(-1)).toEqual({ t: "ack", id: "com:2", seq: 9 });
});

test("Room enforces user mute: muted user gets { t: 'refused', reason: 'user-muted' }; unmuted user succeeds", () => {
  const d = direct();
  const ed = d.join("u-ed", "editor", "ed");
  const mutedAnn = d.join("u-muted", "annotator", "ma");
  const freeAnn = d.join("u-free", "annotator", "fa");
  const mutedCom = d.join("u-muted-c", "commenter", "mc");

  ed.op(1, "board", {
    appState: { moderation: { locked: false, mutedUsers: ["u-muted", "u-muted-c"] } },
    appBase: { moderation: 0 },
  });
  expect(d.room.seq).toBe(1);

  // Muted annotator & commenter are refused with user-muted
  mutedAnn.op(1, "notes", { elements: [rect("n1")] });
  expect(mutedAnn.inbox.at(-1)).toEqual({ t: "refused", id: "ma:1", reason: "user-muted" });
  mutedAnn.op(2, "records", threadOp("t1"));
  expect(mutedAnn.inbox.at(-1)).toEqual({ t: "refused", id: "ma:2", reason: "user-muted" });
  mutedCom.op(1, "records", threadOp("t2"));
  expect(mutedCom.inbox.at(-1)).toEqual({ t: "refused", id: "mc:1", reason: "user-muted" });

  // Unmuted annotator succeeds
  freeAnn.op(1, "notes", { elements: [rect("n-ok")] });
  expect(freeAnn.of("ack")).toEqual([{ t: "ack", id: "fa:1", seq: 2 }]);
  expect(d.log.entries.length).toBe(2);

  // Unmuting restores write access
  ed.op(2, "board", {
    appState: { moderation: { locked: false, mutedUsers: [] } },
    appBase: { moderation: 1 },
  });
  mutedAnn.op(3, "notes", { elements: [rect("n-after")] });
  expect(mutedAnn.of("ack").at(-1)).toEqual({ t: "ack", id: "ma:3", seq: 4 });
});

test("moderation refusal waits for unresolved lock entry and turns unavailable if append fails", async () => {
  const slow = slowLog();
  const d = direct(slow);
  const ed = d.join("u-ed", "editor", "ed");
  const ann = d.join("u-ann", "annotator", "ann");

  // Lock op accepted speculatively, append still in flight
  ed.op(1, "board", {
    appState: { moderation: { locked: true, mutedUsers: [] } },
    appBase: { moderation: 0 },
  });
  // Annotator op is refused against speculative lock, held until lock resolves
  ann.op(1, "notes", { elements: [rect("n1")] });
  expect(ann.inbox.filter(m => m.t !== "welcome")).toEqual([]);

  // Lock append fails -> held refusal becomes unavailable
  slow.waiting.shift().fail(Object.assign(new Error("io"), { code: "io" }));
  await tick();
  expect(ann.of("error").at(-1)).toMatchObject({ id: "ann:1", code: "unavailable" });
});

test("moderation state survives Room.fromLog and checkpoint rebuild", () => {
  const d = direct();
  const ed = d.join("u-ed", "editor", "ed");
  const ann = d.join("u-ann", "annotator", "ann");

  ann.op(1, "notes", { elements: [rect("before-lock")] });
  ed.op(1, "board", {
    appState: { moderation: { locked: true, mutedUsers: ["u-ann"] } },
    appBase: { moderation: 0 },
  });
  expect(d.room.seq).toBe(2);

  // Rebuild from log (replay does not block the earlier note)
  const rebuilt = Room.fromLog({ board: "b1", tenant: "t1", log: d.log, now: () => 5 });
  expect(rebuilt.state()).toEqual(d.room.state());
  expect(rebuilt.streams.board.appState.herdr.moderation).toEqual({ locked: true, mutedUsers: ["u-ann"] });

  // Checkpoint + rebuild
  d.room.checkpoint();
  const fromCp = Room.fromLog({ board: "b1", tenant: "t1", log: d.log, now: () => 5 });
  expect(fromCp.state()).toEqual(d.room.state());

  // Enforced on the rebuilt room too
  const inbox = [];
  const c = fromCp.connect(m => inbox.push(m));
  fromCp.receive(c, { t: "hello", v: 1, board: "b1", since: 0, client: "ann2" }, { n: 1, user: "u-ann", role: "annotator" });
  fromCp.receive(c, { t: "op", id: "ann2:1", sentAt: 2, stream: "notes", op: { elements: [rect("after-lock")] } }, { n: 2 });
  expect(inbox.at(-1)).toEqual({ t: "refused", id: "ann2:1", reason: "board-locked" });
});

test("resend of an op accepted before lock still gets its ack (op-id table precedes moderation)", () => {
  const d = direct();
  const ed = d.join("u-ed", "editor", "ed");
  const ann = d.join("u-ann", "annotator", "ann");

  ann.op(1, "notes", { elements: [rect("n1")] });
  expect(ann.of("ack")).toEqual([{ t: "ack", id: "ann:1", seq: 1 }]);

  ed.op(1, "board", {
    appState: { moderation: { locked: true, mutedUsers: ["u-ann"] } },
    appBase: { moderation: 0 },
  });

  // Resend of ann:1 still gets its original ack
  ann.op(1, "notes", { elements: [rect("n1")] });
  expect(ann.inbox.at(-1)).toEqual({ t: "ack", id: "ann:1", seq: 1 });
});

test("own-property enforcement: inherited prototype fields are ignored by moderationOf and rejected by moderationProblem", () => {
  const inherited = Object.create({ locked: true, mutedUsers: ["u1"] });
  expect(moderationProblem(inherited)).toBe("moderation.locked must be a boolean");
  expect(moderationOf({ herdr: { moderation: inherited } })).toEqual({ locked: false, mutedUsers: [] });
  const inheritedApp = Object.create({ herdr: { moderation: { locked: true, mutedUsers: ["u1"] } } });
  expect(moderationOf(inheritedApp)).toEqual({ locked: false, mutedUsers: [] });
});

test("Replica handles { t: 'refused' } as a terminal refusal on both notes and records", () => {
  const r = new Replica({ client: "ann", session: "s1", now: () => 0, random: () => 0 });
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 0, role: "annotator", user: "u-ann", high: 0, horizon: 0, rv: 1, room: { board: "b1", epoch: 1 } });

  // On records: op is dropped from pending, no resync/reset
  const recMsg = r.local("records", threadOp("t1"));
  expect(r.pending.size).toBe(1);
  const didRec = r.receive({ t: "refused", id: recMsg.id, reason: "user-muted" });
  expect(didRec.dropped).toEqual([recMsg.id]);
  expect(didRec.reset).toBe(false);
  expect(r.resync).toBe(false);
  expect(r.pending.size).toBe(0);

  // On notes: op is dropped from pending, optimistic note discarded, resync set
  const noteMsg = r.local("notes", { elements: [rect("n1")] });
  expect(r.streams.notes.get("n1")).toBeTruthy();
  const didNote = r.receive({ t: "refused", id: noteMsg.id, reason: "board-locked" });
  expect(didNote.dropped).toEqual([noteMsg.id]);
  expect(didNote.reset).toBe(true);
  expect(r.resync).toBe(true);
  expect(r.pending.size).toBe(0);
  expect(r.streams.notes.get("n1")).toBe(null);
});

