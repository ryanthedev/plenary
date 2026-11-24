// The S3 Blobs (server/blobs/s3.js) against the Blobs contract, and the contract against disk.js too (so the
// contract itself is known to describe the single-node adapter). S3 tests skip when S3_ENDPOINT is unset; when it
// is set, a store that can't be reached fails them. Env: S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY (the bucket must exist).
import { test, expect, afterAll } from "bun:test";
import { diskBlobs } from "../../server/adapters/driven/blobs/disk.js";
import { s3Blobs } from "../../server/adapters/driven/blobs/s3.js";
import { blobsContract, freshTenant } from "./blobs-contract.js";
import { tempDir, cleanup, fakePng, sha1, until } from "./helpers.js";

afterAll(cleanup);
const E = process.env;
const cfg = { endpoint: E.S3_ENDPOINT, bucket: E.S3_BUCKET, region: E.S3_REGION ?? "us-east-1", accessKeyId: E.S3_ACCESS_KEY_ID, secretAccessKey: E.S3_SECRET_ACCESS_KEY };
const on = !!E.S3_ENDPOINT;
const st = on ? test : test.skip;
const code = async p => { try { await p; return "resolved"; } catch (e) { return e.code ?? `threw ${e.message}`; } };

blobsContract("disk blobs", () => diskBlobs({ dir: tempDir() }));
blobsContract("s3 blobs", () => s3Blobs(cfg), { skip: !on });

test("s3: every setting is required from the caller", () => {
  const full = { endpoint: "http://127.0.0.1:1", bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" };
  expect(() => s3Blobs(full)).not.toThrow();
  for (const k of Object.keys(full)) expect(() => s3Blobs({ ...full, [k]: undefined })).toThrow(`s3Blobs needs ${k}`);
  expect(() => s3Blobs()).toThrow();
});

st("s3: a blob is the object <tenant>/<sha1>, typed as its image kind", async () => {
  const blobs = s3Blobs(cfg), ta = freshTenant();
  const bytes = fakePng(120, 3), h = sha1(bytes);
  await blobs.put(ta, h, bytes);
  const raw = new Bun.S3Client(cfg);
  const f = raw.file(`${ta}/${h}`);
  expect(await f.exists()).toBe(true);
  expect((await f.stat()).type).toBe("image/png");
  const list = await raw.list({ prefix: `${ta}/` });
  expect(list.contents.map(c => c.key)).toEqual([`${ta}/${h}`]);
});

st("s3: put keeps the first object for a hash (an existing object is not rewritten)", async () => {
  const blobs = s3Blobs(cfg), ta = freshTenant();
  const bytes = fakePng(200, 4), h = sha1(bytes);
  await blobs.put(ta, h, bytes);
  const raw = new Bun.S3Client(cfg);
  const before = (await raw.file(`${ta}/${h}`).stat()).lastModified;
  await Bun.sleep(1100);                                   // S3 times have 1 s resolution
  await blobs.put(ta, h, bytes);
  expect((await raw.file(`${ta}/${h}`).stat()).lastModified).toEqual(before);
});

st("s3: only a missing key is null; a missing bucket or bad credentials throw", async () => {
  const png = fakePng(64, 1), h = sha1(png), ta = freshTenant();
  expect(await s3Blobs(cfg).get(ta, h)).toBe(null);
  expect(await code(s3Blobs({ ...cfg, bucket: `nope-${Date.now()}` }).get(ta, h))).not.toBe("resolved");
  expect(await code(s3Blobs({ ...cfg, secretAccessKey: "wrong-secret" }).get(ta, h))).not.toBe("resolved");
  expect(await code(s3Blobs({ ...cfg, secretAccessKey: "wrong-secret" }).put(ta, h, png))).not.toBe("resolved");
});

// ---- fix round: H1 (session token from env), M1 (deadlines) ----

/** Runs a snippet in a fresh bun with `env` set at start (Bun's S3 client reads env when the process starts). */
const inFreshBun = async (env, body) => {
  const script = `import { s3Blobs } from ${JSON.stringify(new URL("../../server/adapters/driven/blobs/s3.js", import.meta.url).pathname)};
    const base = { endpoint: "http://127.0.0.1:1", bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" };
    try { ${body} } catch (e) { console.log("ERR " + (e.code ?? e.message)); }`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWS|S3)_/.test(k)));
  const p = Bun.spawn([process.execPath, "-e", script], { env: { ...clean, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return out.trim();
};

test("s3 H1: a session token in the environment makes s3Blobs refuse to start (Bun can't be told to ignore it)", async () => {
  expect(await inFreshBun({}, `s3Blobs(base); console.log("OK");`)).toBe("OK");
  for (const env of [{ AWS_SESSION_TOKEN: "from-env" }, { S3_SESSION_TOKEN: "from-env" }, { AWS_SESSION_TOKEN: "a", S3_SESSION_TOKEN: "b" }])
    expect(await inFreshBun(env, `s3Blobs(base); console.log("OK");`)).toBe("ERR bad-config");
  // Neither "" nor deleting the variable at run time turns Bun's fallback off; still refused.
  expect(await inFreshBun({ AWS_SESSION_TOKEN: "a", S3_SESSION_TOKEN: "b" }, `delete process.env.AWS_SESSION_TOKEN; delete process.env.S3_SESSION_TOKEN; s3Blobs(base); console.log("OK");`)).toBe("ERR bad-config");
  // An explicit token from the caller is what Bun signs with, so it starts.
  expect(await inFreshBun({ AWS_SESSION_TOKEN: "a", S3_SESSION_TOKEN: "b" }, `s3Blobs({ ...base, sessionToken: "from-caller" }); console.log("OK");`)).toBe("OK");
  expect(() => s3Blobs({ endpoint: "http://127.0.0.1:1", bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s", sessionToken: "" })).toThrow();
});

test("s3 M1: a store that accepts the connection and never answers is aborted at the deadline (timeout), get and put", async () => {
  let opened = 0, closed = 0;
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { opened++; }, data() {}, close() { closed++; } } });
  try {
    const blobs = s3Blobs({ endpoint: `http://127.0.0.1:${srv.port}`, bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s", getTimeoutMs: 300, putTimeoutMs: 400 });
    const bytes = fakePng(64, 2), h = sha1(bytes);
    // "Aborted at the deadline, not left hanging" is the outcome: a call that never gave up never returns, and the test's
    // own limit fails it; how long the deadline took on a loaded machine is not asserted. Which deadline is: every
    // AbortSignal.timeout the adapter arms is recorded, and each call's must be its configured one (the 10 s and 30 s
    // defaults would also time out here, just later).
    const armed = [], timeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => { armed.push(ms); return timeout.call(AbortSignal, ms); };
    try {
      expect(await code(blobs.get("t-a", h))).toBe("timeout");
      expect(armed).toEqual([300]);
      expect(await code(blobs.put("t-a", h, bytes))).toBe("timeout");
      expect(armed).toEqual([300, 400]);
    } finally { AbortSignal.timeout = timeout; }
    expect(opened).toBeGreaterThanOrEqual(1);
    await until(() => closed >= opened, "the aborted requests' sockets closed");   // aborted, not left open
  } finally { srv.stop(true); }
}, 30_000);

test("s3 M1: a refused connection is unavailable, fast; deadlines must be positive", async () => {
  const port = (() => { const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = l.port; l.stop(true); return p; })();
  const blobs = s3Blobs({ endpoint: `http://127.0.0.1:${port}`, bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" });
  const bytes = fakePng(64, 3);
  expect(await code(blobs.get("t-a", sha1(bytes)))).toBe("unavailable");
  expect(await code(blobs.put("t-a", sha1(bytes), bytes))).toBe("unavailable");
  const full = { endpoint: "http://127.0.0.1:1", bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" };
  for (const bad of [0, -1, NaN, "5"]) { expect(() => s3Blobs({ ...full, getTimeoutMs: bad })).toThrow(); expect(() => s3Blobs({ ...full, putTimeoutMs: bad })).toThrow(); }
}, 30_000);   // two refused connections; failure-only ceiling for a loaded machine (TECH-DEBT row 36)

st("s3: a caller-given session token is what gets signed (the store rejects a wrong one)", async () => {
  const png = fakePng(64, 5), h = sha1(png);
  expect(await code(s3Blobs({ ...cfg, sessionToken: "not-a-real-token" }).get(freshTenant(), h))).toBe("unavailable");
});

st("s3: delete of an object removes exactly that key; a missing bucket is an error, not 'already gone'", async () => {
  const blobs = s3Blobs(cfg), ta = freshTenant();
  const a = fakePng(90, 31), b = fakePng(91, 32);
  await blobs.put(ta, sha1(a), a); await blobs.put(ta, sha1(b), b);
  await blobs.delete(ta, sha1(a));
  const raw = new Bun.S3Client(cfg);
  expect((await raw.list({ prefix: `${ta}/` })).contents.map(c => c.key)).toEqual([`${ta}/${sha1(b)}`]);
  const nowhere = s3Blobs({ ...cfg, bucket: `plenary-no-such-bucket-${process.pid}` });
  expect(await code(nowhere.delete(ta, sha1(a)))).toBe("unavailable");
});
