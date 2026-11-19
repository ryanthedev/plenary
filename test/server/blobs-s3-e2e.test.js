// Issue #42 on S3-compatible storage (a cluster): a page uploads through a gateway, the gateway is replaced, a
// different gateway (the same key and bucket, no shared disk) serves the bytes to a fresh page, which draws them. Skips without S3_ENDPOINT (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY); `bun run test:cluster` sets them.
import { test, expect, afterAll } from "bun:test";
import { appClient, restoreAppGlobals } from "../web/app-client.js";
import { s3Blobs } from "../../server/blobs/s3.js";
import { rig, tokenOf } from "./rig.js";
import { cleanup, fakePng, sha1 } from "./helpers.js";

afterAll(() => { restoreAppGlobals(); cleanup(); });
const E = process.env, on = !!E.S3_ENDPOINT, st = on ? test : test.skip;
const cfg = () => ({ endpoint: E.S3_ENDPOINT, bucket: E.S3_BUCKET, region: E.S3_REGION ?? "us-east-1", accessKeyId: E.S3_ACCESS_KEY_ID, secretAccessKey: E.S3_SECRET_ACCESS_KEY });

const page = (r, name) => appClient({ url: r.server.wsUrl, board: r.ids.board, token: tokenOf(name), user: "dev:" + name });

st("DW-42.2: bytes uploaded through one gateway are drawn by a page on another, from S3, after the first is gone", async () => {
  const key = new Uint8Array(32).fill(9), bytes = fakePng(4000, 21), id = sha1(bytes);
  const dataURL = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
  let up, down;
  try {
    const a = await rig({ blobs: s3Blobs(cfg()), server: { blobKey: key } });
    up = page(a, "owner");
    await up.until(() => up.S.role === "presenter", "welcome as a presenter");
    expect(up.upload({ id, mimeType: "image/png", dataURL, width: 100, height: 80 })).toBeTruthy();
    const raw = new Bun.S3Client(cfg());
    await up.until(async () => (await raw.file(`${a.ids.tenant}/${id}`).exists()) && (await a.rawStore.lastSeq(a.ids.tenant, a.ids.board)) >= 1, "the object in the bucket and the element in the log");
    up.close();
    await a.stop();

    const b = await rig({ dir: a.dir, blobs: s3Blobs(cfg()), registry: a.registry, ids: a.ids, server: { blobKey: key } });   // the same log (a clean restart); the blobs are only in S3, none on this disk
    down = page(b, "viewer");
    await down.until(() => down.S.eds.board.doc.files[id]?.dataURL === dataURL, "the bytes from S3 in the fresh page");
  } finally { up?.close(); down?.close(); }
}, 40_000);

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
