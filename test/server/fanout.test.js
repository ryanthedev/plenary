// E-4 (role-scoped presence fan-out in server/gateway.js) and E-3 (incremental Replica.recordsState()).
import { test, expect, afterAll } from "bun:test";
import { Replica } from "../../packages/protocol/replica.js";
import { Records } from "../../packages/protocol/records.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, sleep } from "./helpers.js";

afterAll(cleanup);
const hello = (r, name, extra = {}) => ({ t: "hello", v: 1, token: tokenOf(name), board: r.ids.board, since: 0, client: name, ...extra });

test("E-4: viewers receive presenters' (owner/editor) presence + writer emotes only; annotator cursors/leaves stay with writers", async () => {
  const r = await rig({ limits: { presenceMs: 30, viewerPresenceMs: 60, hereMs: 60_000, herePublishMs: 60_000 } });
  try {
    const owner = await r.sock(), ann = await r.sock(), viewer = await r.sock();
    owner.send(hello(r, "owner", { client: "own" }));
    ann.send(hello(r, "annotator", { client: "ann" }));
    viewer.send(hello(r, "viewer", { client: "vw" }));
    await Promise.all([
      owner.next(m => m.t === "welcome", "owner welcome"),
      ann.next(m => m.t === "welcome", "ann welcome"),
      viewer.next(m => m.t === "welcome", "viewer welcome"),
    ]);

    // Annotator sends cursor + select: owner sees them, viewer does NOT.
    ann.send({ t: "presence", k: "cursor", x: 10, y: 20 });
    ann.send({ t: "presence", k: "select", stream: "notes", ids: ["n1"] });
    const ownGotAnn = await owner.next(m => m.t === "presence" && m.batch.some(x => x.client === "ann" && x.k === "cursor"), "owner sees ann cursor", 2000);
    expect(ownGotAnn.batch.some(x => x.client === "ann" && x.k === "select")).toBe(true);
    await sleep(150);
    const viewerAnn = viewer.msgs.filter(m => m.t === "presence").flatMap(m => m.batch).filter(x => x.client === "ann");
    expect(viewerAnn).toEqual([]);

    // Owner (presenter) sends cursor + laser: both annotator AND viewer receive them.
    owner.send({ t: "presence", k: "cursor", x: 100, y: 200 });
    owner.send({ t: "presence", k: "laser", pts: [[1, 2, 0]] });
    const [annGotOwn, vwGotOwn] = await Promise.all([
      ann.next(m => m.t === "presence" && m.batch.some(x => x.client === "own" && x.k === "cursor"), "ann sees owner", 2000),
      viewer.next(m => m.t === "presence" && m.batch.some(x => x.client === "own" && x.k === "cursor"), "viewer sees owner", 2000),
    ]);
    expect(annGotOwn.batch.some(x => x.k === "laser")).toBe(true);
    expect(vwGotOwn.batch.some(x => x.k === "laser")).toBe(true);

    // Annotator sends an emote: viewer DOES see emotes.
    ann.send({ t: "presence", k: "emote", e: "🎉" });
    const vwEmote = await viewer.next(m => m.t === "presence" && m.batch.some(x => x.k === "emote" && x.e === "🎉"), "viewer sees emote", 2000);
    expect(vwEmote.batch.some(x => x.client === "ann" && x.e === "🎉")).toBe(true);

    // Viewer closing does NOT broadcast a `leave` on presence; annotator closing sends `leave` to writers only.
    const viewer2 = await r.sock();
    viewer2.send(hello(r, "viewer", { client: "vw2" }));
    await viewer2.next(m => m.t === "welcome", "vw2 welcome");
    await viewer2.close();
    await sleep(120);
    expect(owner.msgs.filter(m => m.t === "presence").flatMap(m => m.batch).some(x => x.client === "vw2")).toBe(false);

    await ann.close();
    await owner.next(m => m.t === "presence" && m.batch.some(x => x.client === "ann" && x.k === "leave"), "owner sees ann leave", 2000);
    await sleep(120);
    expect(viewer.msgs.filter(m => m.t === "presence").flatMap(m => m.batch).some(x => x.client === "ann" && x.k === "leave")).toBe(false);

    // Owner closing DOES send `leave` to viewer.
    await owner.close();
    await viewer.next(m => m.t === "presence" && m.batch.some(x => x.client === "own" && x.k === "leave"), "viewer sees owner leave", 2000);

    await viewer.close();
  } finally {
    await r.stop();
  }
}, 20_000);

test("E-3: Replica.recordsState() is incremental and matches full rebuild byte-for-byte with/without pending ops", () => {
  let t = 1000;
  const r = new Replica({ client: "u", now: () => t, random: () => 0.5 });
  r.connectMessages("tok", "b1");
  r.receive({ t: "welcome", seq: 0, role: "editor", user: "u1", horizon: 0, rv: 1 });

  // Seed 2,000 threads x 2 comments = 4,000 comments via snapshot.
  const threads = [];
  for (let i = 0; i < 2000; i++) {
    threads.push({
      id: `t${i}`, anchor: { point: { x: i, y: 0 } }, by: "u0", name: "Host", at: 100,
      comments: [
        { id: `t${i}`, by: "u0", name: "Host", at: 100, text: `thread ${i}`, reactions: { "👍": ["u0"] } },
        { id: `r${i}`, by: "u0", name: "Host", at: 101, text: `reply ${i}`, reactions: {} },
      ],
    });
  }
  r.receive({ t: "snapshot", seq: 1, streams: { board: { elements: [], appState: {} }, notes: { elements: [], appState: {} } }, appSeq: { board: {}, notes: {} }, records: { threads }, noteAuthor: [] });

  // Warm cache once.
  const base = r.recordsState();
  expect(base.threads.length).toBe(2000);

  // Incoming confirmed reaction on 1 thread: fast incremental update, matches full rebuild.
  t += 10;
  const t0 = performance.now();
  r.receive({ t: "entries", entries: [{ seq: 2, board: "b1", tenant: "t1", stream: "records", op: { do: "react", id: "t500", emoji: "🔥", on: true }, by: "u2", id: "other:1", at: t, rv: 1, name: "Peer" }] });
  const afterConfirmed = r.recordsState();
  const confirmedMs = performance.now() - t0;
  expect(afterConfirmed.threads[500].comments[0].reactions["🔥"]).toEqual(["u2"]);
  expect(confirmedMs).toBeLessThan(20);

  // Pending local ops: react on existing thread + reply on existing thread + new thread + react on new thread.
  t += 10;
  r.local("records", { do: "react", id: "r10", emoji: "🎉", on: true });
  r.local("records", { do: "reply", id: "my-rep", thread: "t10", text: "hi" });
  r.local("records", { do: "thread", id: "my-th", anchor: { point: { x: 9, y: 9 } }, text: "new" });
  r.local("records", { do: "react", id: "my-th", emoji: "❤️", on: true });
  const t1 = performance.now();
  const withPending = r.recordsState();
  const pendingMs = performance.now() - t1;
  expect(pendingMs).toBeLessThan(20);

  // Compare byte-for-byte with a full fresh rebuild.
  const ref = new Records(r.confirmedRecords.toJSON());
  for (const p of r.pending.values()) if (p.stream === "records") ref.apply(p.op, r.user, t, null);
  expect(withPending).toEqual(ref.toJSON());
});
