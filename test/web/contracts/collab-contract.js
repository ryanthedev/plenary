// The collab port contract (web/ports/collab.js), as reusable bun tests. Every collab adapter runs it: the fake
// (web/adapters/collab/fake.js) and the sync-side one (web/adapters/collab/sync.js), test/web/adapters/collab.test.js.
//
//   collabContract(name, makeAdapter)
//
// makeAdapter(role) → Promise<driver>, a FRESH port, live, signed in as `role`, with one other writer (the peer) on
// the board. The driver:
//   port                 the adapter under test
//   peer                 { user } the other writer
//   settle()             async: the room answers everything sent so far (acks, refusals) and every delivery and
//                        coalesced callback runs.
//   peerPresence(m)      async: the peer sends one presence message (k + fields); it reaches the port.
//   peerRecord(op)       async: the peer's records action lands.
//   peerNote()           async: the peer makes a note on the notes stream; returns its element id.
//   peerDeleteNote(id)   async: the peer deletes it.
//   peerPreview(stream, el) async: the peer's drag preview of one element.
//   here(msg), emotes(msg)  async: the gateway sends one `here` / `emotes`.
//   setRole(role)        async: the room changes this user's role; the port goes off live and comes back with it.
//   drop()               async: the connection drops; returns once the port is live again.
//   sent()               the presence messages this port sent: [{ k, ...fields }].
// Only what the port doc says is asserted: onRecords may be coalesced (it runs by the end of settle()).

import { test, expect } from "bun:test";
import { missingFromPort } from "../../../web/ports/collab.js";

export function collabContract(name, makeAdapter) {
  const t = (title, fn) => test(`${name}: ${title}`, fn);

  t("a complete port: every member, me valid, live, role from the room", async () => {
    const d = await makeAdapter("editor");
    expect(missingFromPort(d.port)).toEqual([]);
    expect(d.port.status).toBe("live");
    expect(d.port.role).toBe("editor");
    for (const k of ["user", "name", "client"]) expect(typeof d.port.me[k]).toBe("string");
  });

  t("send forwards one presence message as given", async () => {
    const d = await makeAdapter("editor");
    d.port.send("cursor", { x: 3, y: 4 });
    expect(d.sent().filter(m => m.k === "cursor").map(({ x, y }) => ({ x, y }))).toEqual([{ x: 3, y: 4 }]);
  });

  t("others' presence arrives once, with user and client", async () => {
    const d = await makeAdapter("editor");
    const got = [];
    d.port.onPresence(b => got.push(...b));
    await d.peerPresence({ k: "cursor", x: 7, y: 8 });
    const cur = got.filter(m => m.k === "cursor");
    expect(cur.length).toBe(1);
    expect(cur[0]).toMatchObject({ user: d.peer.user, x: 7, y: 8 });
    expect(typeof cur[0].client).toBe("string");
    expect(cur[0].client).not.toBe(d.port.me.client);
  });

  t("here: the full list, then a count-only here keeps the writers and updates the counts", async () => {
    const d = await makeAdapter("editor");
    const got = [];
    d.port.onHere(h => got.push(h));
    const writers = [{ user: "zed", name: "Zed", role: "owner" }, { user: "ann", name: "Ann", role: "annotator" }];
    await d.here({ t: "here", writers, writerCount: 2, viewers: 10 });
    await d.here({ t: "here", writerCount: 3, viewers: 12 });
    expect(got.at(-1)).toEqual({ writers, writerCount: 3, viewers: 12 });
    await d.here({ t: "here", writers: [], writerCount: 0, viewers: 1 });   // an explicit empty list does clear
    expect(got.at(-1)).toEqual({ writers: [], writerCount: 0, viewers: 1 });
  });

  t("emotes: viewers' counts arrive", async () => {
    const d = await makeAdapter("editor");
    const got = [];
    d.port.onEmotes(m => got.push(m));
    await d.emotes({ t: "emotes", counts: { "👍": 4 } });
    expect(got.at(-1)).toEqual({ counts: { "👍": 4 } });
  });

  t("records: my thread shows at once as pending, then confirmed; onRecords fires", async () => {
    const d = await makeAdapter("annotator");
    let n = 0;
    d.port.onRecords(() => n++);
    d.port.thread({ id: "c1", anchor: { point: { x: 1, y: 2 } }, text: "hello" });
    let r = d.port.records();
    expect(r.threads.map(x => x.id)).toEqual(["c1"]);
    expect(r.pending.map(p => p.op)).toEqual([{ do: "thread", id: "c1", anchor: { point: { x: 1, y: 2 } }, text: "hello" }]);
    await d.settle();
    r = d.port.records();
    expect(r.pending).toEqual([]);
    expect(r.threads[0]).toMatchObject({ id: "c1", by: d.port.me.user });
    expect(r.threads[0].comments[0].text).toBe("hello");
    expect(n).toBeGreaterThan(0);
  });

  t("records: react, unreact, reply, resolve, reopen and delete each send one action", async () => {
    const d = await makeAdapter("editor");
    d.port.thread({ id: "c1", anchor: { point: { x: 0, y: 0 } }, text: "a" });
    await d.settle();
    d.port.reply({ id: "c2", thread: "c1", text: "b" });
    d.port.react({ id: "c1", emoji: "👍" });
    d.port.resolve({ id: "c1" });
    expect(d.port.records().pending.map(p => p.op.do)).toEqual(["reply", "react", "resolve"]);
    await d.settle();
    let th = d.port.records().threads[0];
    expect(th.comments.map(c => c.id)).toEqual(["c1", "c2"]);
    expect(th.comments[0].reactions).toEqual({ "👍": [d.port.me.user] });
    expect(!!th.resolved).toBe(true);
    d.port.unreact({ id: "c1", emoji: "👍" }); d.port.reopen({ id: "c1" }); d.port.deleteComment({ id: "c2" });
    await d.settle();
    th = d.port.records().threads[0];
    expect(th.comments[0].reactions).toEqual({});
    expect(!!th.resolved).toBe(false);
    expect(th.comments[1].deleted).toBeDefined();
  });

  t("records: a refused action fires onRefused and leaves pending", async () => {
    const d = await makeAdapter("annotator");
    await d.peerRecord({ do: "thread", id: "p1", anchor: { point: { x: 0, y: 0 } }, text: "peer's" });
    const refused = [];
    d.port.onRefused(r => refused.push(r));
    d.port.deleteComment({ id: "p1" });                     // an annotator can't delete someone else's comment
    expect(d.port.records().pending.length).toBe(1);
    await d.settle();
    expect(refused.length).toBe(1);
    expect(refused[0].op).toEqual({ do: "delete", id: "p1" });
    expect(refused[0].code).toBe("forbidden");
    expect(d.port.records().pending).toEqual([]);
    expect(d.port.records().threads[0].comments[0].deleted).toBeUndefined();
  });

  t("others' records arrive, signed with their name", async () => {
    const d = await makeAdapter("viewer");
    await d.peerRecord({ do: "thread", id: "p1", anchor: { point: { x: 0, y: 0 } }, text: "hi all" });
    const th = d.port.records().threads;
    expect(th.length).toBe(1);
    expect(th[0]).toMatchObject({ id: "p1", by: d.peer.user });
    expect(typeof th[0].name).toBe("string");
  });

  t("notes: notes(), noteAuthor and element follow the notes stream", async () => {
    const d = await makeAdapter("annotator");
    const id = await d.peerNote();
    expect(d.port.notes().some(e => e.id === id)).toBe(true);
    expect(d.port.noteAuthor(id)).toBe(d.peer.user);
    const b = d.port.element("notes", id);
    expect(b).toMatchObject({ x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number) });
    expect(d.port.element("notes", "nope")).toBe(null);
    expect(d.port.noteAuthor("nope")).toBe(null);
    await d.peerDeleteNote(id);
    expect(d.port.element("notes", id)).toBe(null);
    expect(d.port.notes().some(e => e.id === id)).toBe(false);
  });

  t("previews: others' drags with the sender", async () => {
    const d = await makeAdapter("editor");
    await d.peerPreview("board", { id: "e1", type: "rectangle", x: 1, y: 2, width: 3, height: 4, version: 2, versionNonce: 5 });
    const p = d.port.previews("board");
    expect(p.length).toBe(1);
    expect(p[0].el.id).toBe("e1");
    expect(p[0].user).toBe(d.peer.user);
    expect(d.port.previews("notes")).toEqual([]);
  });

  t("role change mid-session: onStatus says so, port.role follows, and is never null on the way", async () => {
    const d = await makeAdapter("editor");
    const seen = [];
    d.port.onStatus((status, role) => seen.push({ status, role, now: d.port.role }));
    await d.setRole("viewer");
    expect(d.port.role).toBe("viewer");
    expect(d.port.status).toBe("live");
    expect(seen.some(s => s.status !== "live")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ status: "live", role: "viewer" });
    for (const s of seen) { expect(s.role).not.toBe(null); expect(s.now).not.toBe(null); }
  });

  t("a drop: status leaves live and comes back; records sent while down are kept", async () => {
    const d = await makeAdapter("editor");
    const seen = [];
    d.port.onStatus(s => seen.push(s));
    await d.drop(() => {
      expect(d.port.status).not.toBe("live");
      expect(d.port.role).toBe("editor");
      d.port.thread({ id: "off1", anchor: { point: { x: 0, y: 0 } }, text: "while down" });
    });
    await d.settle();
    expect(seen[0]).not.toBe("live");
    expect(seen.at(-1)).toBe("live");
    const r = d.port.records();
    expect(r.pending).toEqual([]);
    expect(r.threads.map(x => x.id)).toEqual(["off1"]);
  });
}
