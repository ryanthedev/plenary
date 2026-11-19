// #92 over a real server (rig.js: real gateway, room host, SQLite Store, disk Blobs): the gateway records a pending reference when it signs a PUT URL,
// the room host hands the op's image fileIds to Store.append, and a Trash purge then condemns exactly what only that board used.
import { test, expect, afterAll } from "bun:test";
import { rig, tokenOf } from "./rig.js";
import { cleanup, fakePng, sha1, until } from "./helpers.js";
import { BLOB_PENDING_MS } from "../../server/blobs/port.js";

afterAll(cleanup);
const H1 = "a".repeat(40), H2 = "b".repeat(40);
const image = (id, fileId, k = 1) => ({ id, type: "image", fileId, version: 1, versionNonce: k, x: 0, y: 0, width: 10, height: 10, isDeleted: false, status: "saved" });
async function as(r, role) {
  const s = await r.sock();
  s.send({ t: "hello", v: 1, token: tokenOf(role), board: r.ids.board, since: 0, client: role });
  await s.next(m => m.t === "welcome");
  s.ask = async (msg, pick) => { const n = s.msgs.length; s.send(msg); return until(() => s.msgs.slice(n).find(pick), "an answer"); };
  return s;
}
const spy = () => { const calls = { pend: [], append: [] }; return { calls, wrapStore: st => ({ ...st,
  blobPend: (...a) => { calls.pend.push(a); return st.blobPend(...a); },
  append: (...a) => { calls.append.push(a); return st.append(...a); } }) }; };

test("DW-92.1 a PUT URL request records a pending reference first; a GET, a refused role and a refused Store record none and sign nothing they should not", async () => {
  const { calls, wrapStore } = spy(), r = await rig({ wrapStore });
  const s = await as(r, "editor"), isBlob = m => m.t === "blob" || (m.t === "error" && m.id === undefined);
  expect(await s.ask({ t: "blob", sha1: H1 }, isBlob)).toMatchObject({ t: "blob", sha1: H1 });
  expect(calls.pend).toEqual([]);                                                          // reading references nothing
  expect(await s.ask({ t: "blob", sha1: H1, put: true }, isBlob)).toMatchObject({ t: "blob", sha1: H1, url: expect.stringContaining("/blobs/") });
  expect(calls.pend).toEqual([[r.ids.tenant, r.ids.board, H1, BLOB_PENDING_MS]]);
  const v = await as(r, "viewer");
  expect(await v.ask({ t: "blob", sha1: H2, put: true }, isBlob)).toMatchObject({ t: "error", code: "forbidden" });
  expect(calls.pend.length).toBe(1);                                                       // a refused role records nothing
  expect(await r.rawStore.blobPend(r.ids.tenant, r.ids.board, H2, 1000)).toBeUndefined();
});

test("DW-92.1 a Store that cannot record the pending reference (or is deleting the hash) means no URL: unavailable, the connection stays", async () => {
  const r = await rig({ wrapStore: st => ({ ...st, blobPend: async () => { throw Object.assign(new Error("the blob is being deleted"), { code: "unavailable" }); } }) });
  const s = await as(r, "editor");
  const m = await s.ask({ t: "blob", sha1: H1, put: true }, x => x.t === "blob" || x.t === "error");
  expect(m).toMatchObject({ t: "error", sha1: H1, code: "unavailable" });
  expect(m.url).toBeUndefined();
  expect(s.closed).toBe(null);
  expect(r.logs().filter(l => l.msg === "blob url failed").map(l => l.level)).toEqual(["info"]);   // "ask again" is expected, not an error
});

test("LOW-8: any other failure of the pending record is still an error", async () => {
  const r = await rig({ wrapStore: st => ({ ...st, blobPend: async () => { throw new Error("db down"); } }) });
  const s = await as(r, "editor");
  expect(await s.ask({ t: "blob", sha1: H1, put: true }, x => x.t === "error")).toMatchObject({ code: "unavailable" });
  expect(r.logs().filter(l => l.msg === "blob url failed").map(l => l.level)).toEqual(["error"]);
});

test("DW-92.1 the op's image fileIds reach Store.append as blobRefs, and a purge condemns the hash only the purged board used", async () => {
  const { calls, wrapStore } = spy(), r = await rig({ wrapStore }), { tenant, board, otherBoard } = r.ids;
  const s = await as(r, "editor");
  s.send({ t: "op", id: "editor:1", sentAt: 0, stream: "board", op: { elements: [image("i1", H1), image("i2", H2, 2), image("i3", H2, 3), { id: "r1", type: "rectangle", version: 1, versionNonce: 4, x: 0, y: 0, width: 1, height: 1, isDeleted: false }] } });
  await until(async () => (await r.rawStore.lastSeq(tenant, board)) >= 1, "the op in the log");
  expect(calls.append.at(-1)[5]).toEqual({ blobRefs: [H1, H2] });                          // distinct, images only
  s.send({ t: "op", id: "editor:2", sentAt: 0, stream: "board", op: { elements: [{ id: "r2", type: "rectangle", version: 1, versionNonce: 5, x: 0, y: 0, width: 1, height: 1, isDeleted: false }] } });
  await until(async () => (await r.rawStore.lastSeq(tenant, board)) >= 2, "the second op");
  expect(calls.append.at(-1)[5]).toEqual({ blobRefs: [] });                                // no pictures: nothing to record
  // Another board of the tenant uses H2 too.
  const e2 = await r.rawStore.acquire(tenant, otherBoard, "h-test", 60_000);
  await r.rawStore.append(tenant, otherBoard, [{ seq: 1, board: otherBoard, tenant, stream: "board", op: { elements: [image("z", H2, 9)] }, by: "u", id: "c:1" }], 0, e2.epoch, { blobRefs: [H2] });
  await r.rawStore.purgeBoard(tenant, board);
  expect(await r.rawStore.blobCondemned({ graceMs: 0, limit: 10 })).toEqual([{ tenant, sha1: H1 }]);   // H2 is still the other board's
});

test("DW-92.1 a rejected op (bad fileId) writes nothing and references nothing", async () => {
  const { calls, wrapStore } = spy(), r = await rig({ wrapStore }), s = await as(r, "editor");
  s.send({ t: "op", id: "editor:1", sentAt: 0, stream: "board", op: { elements: [image("i1", "not-a-hash")] } });
  await until(() => s.msgs.some(m => m.t === "error" && m.id === "editor:1"), "the op refused");
  expect(calls.append.length).toBe(0);
});

test("MED-3: a board is never stopped over its references: ops carrying 21,000 distinct pictures are all acknowledged by a real Room, and the purge condemns every one", async () => {
  const r = await rig({ limits: { opRate: 1e6, opBurst: 1e6 } }), { tenant, board } = r.ids, s = await as(r, "editor");
  const hash = i => i.toString(16).padStart(40, "0");
  for (let k = 0; k < 3; k++) {
    const elements = Array.from({ length: 7000 }, (_, i) => ({ id: `i${k}-${i}`, type: "image", fileId: hash(k * 7000 + i), version: 1, versionNonce: 1 + i }));
    s.send({ t: "op", id: `editor:${k + 1}`, sentAt: 0, stream: "board", op: { elements } });
  }
  await until(async () => (await r.rawStore.lastSeq(tenant, board)) >= 3, "all three ops in the log", 30_000);
  expect(s.msgs.filter(m => m.t === "error")).toEqual([]);
  expect(r.logs().filter(l => l.level === "error")).toEqual([]);                           // the room never failed itself over its references
  await r.rawStore.purgeBoard(tenant, board);
  let n = 0, after = null;
  for (;;) { const page = await r.rawStore.blobCondemned({ graceMs: 0, after, limit: 1000 }); n += page.length; if (page.length < 1000) break; after = page.at(-1); }
  expect(n).toBe(21_000);
}, 60_000);
