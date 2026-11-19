// Issue #42 on S3-compatible storage (a cluster): the web client uploads through a gateway, the gateway process is
// replaced, a different gateway (its own data dir, its own process, the same key and bucket) serves the bytes to a fresh
// client. Skips without S3_ENDPOINT (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY); `bun run test:cluster` sets them.
import { test, expect, afterAll } from "bun:test";
import { wsNet } from "../../web/adapters/transport/ws.js";
import { s3Blobs } from "../../server/blobs/s3.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, fakePng, sha1, until } from "./helpers.js";

afterAll(cleanup);
const E = process.env, on = !!E.S3_ENDPOINT, st = on ? test : test.skip;
const cfg = () => ({ endpoint: E.S3_ENDPOINT, bucket: E.S3_BUCKET, region: E.S3_REGION ?? "us-east-1", accessKeyId: E.S3_ACCESS_KEY_ID, secretAccessKey: E.S3_SECRET_ACCESS_KEY });

async function join(server, ids, name) {
  const net = wsNet({ url: server.wsUrl, WebSocket }), got = [], tr = net.join(), msgs = [];
  net.onFile(f => got.push(f));
  tr.onMessage(m => msgs.push(m));
  tr.send({ t: "hello", v: 1, token: tokenOf(name), board: ids.board, since: 0, client: name });
  await until(() => msgs.find(m => m.t === "welcome"), `${name}'s welcome`);
  return { net, got, close: () => tr.close() };
}

st("DW-42.2: bytes uploaded through one gateway are served by another, from S3, after the first is gone", async () => {
  const key = new Uint8Array(32).fill(9), bytes = fakePng(4000, 21), id = sha1(bytes);
  const file = { id, mimeType: "image/png", dataURL: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` };
  const a = await rig({ blobs: s3Blobs(cfg()), server: { blobKey: key } });
  const up = await join(a.server, a.ids, "editor");
  up.net.put(file);
  const raw = new Bun.S3Client(cfg());
  await until(() => raw.file(`${a.ids.tenant}/${id}`).exists(), "the object in the bucket");
  up.close();
  await a.stop();

  const b = await rig({ blobs: s3Blobs(cfg()), registry: a.registry, ids: a.ids, server: { blobKey: key } });   // no disk shared with a's blobs
  const down = await join(b.server, b.ids, "viewer");
  down.net.want(id);
  expect(await until(() => down.got[0], "the bytes from S3")).toEqual(file);
  down.close();
});

st("S3: the quota reads the tenant's usage from the bucket", async () => {
  const bytes = fakePng(900, 22), id = sha1(bytes);
  const r = await rig({ blobs: s3Blobs(cfg()), server: { quotaBytes: 1000 } }), s = await r.sock();
  s.send({ t: "hello", v: 1, token: tokenOf("editor"), board: r.ids.board, since: 0, client: "q" });
  await s.next(m => m.t === "welcome");
  const url = async h => { s.send({ t: "blob", sha1: h, put: true }); const m = await s.next(x => x.t === "blob" && x.sha1 === h); return r.server.url + m.url; };
  expect((await fetch(await url(id), { method: "PUT", body: bytes })).status).toBe(201);
  const more = fakePng(300, 23);
  expect((await fetch(await url(sha1(more)), { method: "PUT", body: more })).status).toBe(507);
  await r.stop();
  const again = await rig({ blobs: s3Blobs(cfg()), registry: r.registry, ids: r.ids, server: { quotaBytes: 1000 } }), s2 = await again.sock();   // a new process learns the 900 from the bucket
  s2.send({ t: "hello", v: 1, token: tokenOf("editor"), board: again.ids.board, since: 0, client: "q2" });
  await s2.next(m => m.t === "welcome");
  s2.send({ t: "blob", sha1: sha1(more), put: true });
  const m = await s2.next(x => x.t === "blob");
  expect((await fetch(again.server.url + m.url, { method: "PUT", body: more })).status).toBe(507);
});
