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
