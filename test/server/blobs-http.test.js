// Issue #101: Image Blobs — blob1. HMAC tickets, WS `{ t: "blob", sha1, put? }`,
// HTTP `/blobs/:tenant/:sha1?ticket=...` (PUT/GET/HEAD), and web client upload + auto-fetch.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessions as makeSessions } from "../../server/auth/session.js";
import { memoryRegistry } from "../../server/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/auth/tenancy.js";
import { devAuth } from "../../server/auth/dev.js";
import { authPort } from "../../server/auth/port.js";
import { createServer } from "../../server/server.js";
import { sqliteStore } from "../../server/store/sqlite.js";
import { memoryBus } from "../../server/bus/memory.js";
import { diskBlobs } from "../../server/blobs/disk.js";
import { MAX_BLOB_BYTES } from "../../server/blobs/port.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { wsNet } from "../../web/adapters/transport/ws.js";
import { createSession } from "../../web/core/session.js";

// Valid 1x1 transparent PNG
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const sha1Of = bytes => new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
const PNG_SHA1 = sha1Of(PNG_BYTES);

function openWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox = [];
    const waiters = [];
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      const w = waiters.shift();
      if (w) w(msg);
      else inbox.push(msg);
    };
    ws.onopen = () => resolve({
      ws,
      send: m => ws.send(JSON.stringify(m)),
      next: (ms = 3000) => {
        if (inbox.length) return Promise.resolve(inbox.shift());
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.indexOf(fn);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error("ws next() timed out"));
          }, ms);
          const fn = m => { clearTimeout(timer); res(m); };
          waiters.push(fn);
        });
      },
      nextOf: async (pred, ms = 3000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const m = await (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((res, rej) => {
            const left = Math.max(10, deadline - Date.now());
            const timer = setTimeout(() => {
              const i = waiters.indexOf(fn);
              if (i >= 0) waiters.splice(i, 1);
              rej(new Error("ws nextOf() timed out"));
            }, left);
            const fn = msg => { clearTimeout(timer); res(msg); };
            waiters.push(fn);
          }));
          if (pred(m)) return m;
        }
        throw new Error("ws nextOf() timed out");
      },
      close: () => ws.close(),
    });
    ws.onerror = reject;
  });
}

async function setupServer({ now = Date.now, limits = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plenary-blobs-"));
  const registry = memoryRegistry({ now });
  const tenant = await registry.createTenant({ domain: "acme.test" });
  const board = await registry.createBoard({ tenant: tenant.id, title: "Blob Board", memberRole: null });
  await registry.setGrant(board.id, "dev:editor", "editor");
  await registry.setGrant(board.id, "dev:annotator", "annotator");
  await registry.setGrant(board.id, "dev:commenter", "commenter");
  await registry.setGrant(board.id, "dev:viewer", "viewer");

  const dev = devAuth({
    enabled: true,
    tokens: {
      "tk-editor": { name: "editor", role: "editor" },
      "tk-annotator": { name: "annotator", role: "annotator" },
      "tk-commenter": { name: "commenter", role: "commenter" },
      "tk-viewer": { name: "viewer", role: "viewer" },
    },
  });
  const sess = await makeSessions({ key: "b".repeat(32), now });
  const tenancy = makeTenancy({ registry, now });
  const auth = authPort({ sessions: sess, dev, tenancy });
  const store = sqliteStore({ path: join(dir, "plenary.db") });
  const bus = memoryBus();
  const blobs = diskBlobs({ dir: join(dir, "blobs") });
  const blobTickets = {
    issue: (t, h, v) => sess.issueBlobTicket(t, h, v),
    verify: tk => sess.verifyBlobTicket(tk),
  };
  const srv = createServer({ auth, registry, store, bus, blobs, blobTickets, limits, static: false, port: 0 });
  return {
    srv, tenant, board, sess, blobs, blobTickets,
    cleanup: async () => {
      await srv.stop();
      await bus.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("blob1. tickets: issue, verify get/put, expiry, tamper, prefix isolation", async () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const sess = await makeSessions({ key: "k".repeat(32), blobTtlSec: 300, now });
  const other = await makeSessions({ key: "z".repeat(32), now });

  const getTicket = await sess.issueBlobTicket("t-1", PNG_SHA1, "get");
  const putTicket = await sess.issueBlobTicket("t-1", PNG_SHA1, "put");
  expect(getTicket.startsWith("blob1.")).toBe(true);
  expect(putTicket.startsWith("blob1.")).toBe(true);

  expect(await sess.verifyBlobTicket(getTicket)).toEqual({
    tenant: "t-1", sha1: PNG_SHA1, verb: "get", exp: Math.floor(t / 1000) + 300,
  });
  expect(await sess.verifyBlobTicket(putTicket)).toEqual({
    tenant: "t-1", sha1: PNG_SHA1, verb: "put", exp: Math.floor(t / 1000) + 300,
  });

  // Cross-ticket / prefix isolation from s1., snap1., l1., x1.
  const sessionToken = await sess.issue({ user: "u1", name: "Ann", email: "a@b.c", domain: "b.c" });
  const snapTicket = await sess.issueSnapshotTicket("b-1", 10);
  expect(await sess.verify(getTicket)).toBeNull();
  expect(await sess.verifySnapshotTicket(getTicket)).toBeNull();
  expect(await sess.verifyBlobTicket(sessionToken)).toBeNull();
  expect(await sess.verifyBlobTicket(snapTicket)).toBeNull();
  expect(await sess.verifyBlobTicket("l1." + getTicket.slice(6))).toBeNull();
  expect(await sess.verifyBlobTicket("x1." + getTicket.slice(6))).toBeNull();

  // Wrong key and tampered MAC rejected
  expect(await other.verifyBlobTicket(getTicket)).toBeNull();
  const parts = getTicket.split(".");
  expect(await sess.verifyBlobTicket(`${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`)).toBeNull();

  // Expiry enforced against `now`
  t += 300_000;
  expect(await sess.verifyBlobTicket(getTicket)).toBeNull();
  expect(await sess.verifyBlobTicket(putTicket)).toBeNull();

  // Invalid issue arguments rejected
  await expect(sess.issueBlobTicket("", PNG_SHA1, "get")).rejects.toThrow();
  await expect(sess.issueBlobTicket("t-1", "not-a-sha1", "get")).rejects.toThrow();
  await expect(sess.issueBlobTicket("t-1", PNG_SHA1, "delete")).rejects.toThrow();
});

test("live E2E: writer uploads PNG via WS signed PUT + HTTP PUT, sends image op, viewer fetches via signed GET + HEAD", async () => {
  const env = await setupServer();
  try {
    const editor = await openWs(env.srv.wsUrl);
    const viewer = await openWs(env.srv.wsUrl);

    editor.send({ t: "hello", v: PROTOCOL_VERSION, token: "tk-editor", board: env.board.id, since: 0, client: "ed1" });
    const edWelcome = await editor.nextOf(m => m.t === "welcome");
    expect(edWelcome.role).toBe("editor");

    viewer.send({ t: "hello", v: PROTOCOL_VERSION, token: "tk-viewer", board: env.board.id, since: 0, client: "vw1" });
    const vwWelcome = await viewer.nextOf(m => m.t === "welcome");
    expect(vwWelcome.role).toBe("viewer");

    // 1. Writer requests signed PUT URL
    editor.send({ t: "blob", sha1: PNG_SHA1, put: true });
    const putMsg = await editor.nextOf(m => m.t === "blob");
    expect(putMsg.sha1).toBe(PNG_SHA1);
    expect(putMsg.url).toContain(`/blobs/${env.tenant.id}/${PNG_SHA1}?ticket=blob1.`);

    // 2. Writer uploads PNG bytes via HTTP PUT
    const putRes = await fetch(`${env.srv.url}${putMsg.url}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    });
    expect(putRes.status).toBe(204);

    // 3. Writer sends image element op with fileId = PNG_SHA1 (no raw files in op)
    editor.send({
      t: "op", id: "ed1:1", sentAt: edWelcome.seq, stream: "board",
      op: {
        elements: [{ id: "img1", type: "image", fileId: PNG_SHA1, x: 10, y: 20, width: 100, height: 100, version: 1, versionNonce: 42 }],
      },
    });
    const ack = await editor.nextOf(m => m.t === "ack" && m.id === "ed1:1");
    expect(ack.seq).toBeGreaterThan(0);

    // 4. Viewer receives image element entry
    const entryMsg = await viewer.nextOf(m => m.t === "entries" && m.entries.some(e => e.id === "ed1:1"));
    expect(entryMsg.entries[0].op.elements[0].fileId).toBe(PNG_SHA1);

    // 5. Viewer requests signed GET URL over WS
    viewer.send({ t: "blob", sha1: PNG_SHA1 });
    const getMsg = await viewer.nextOf(m => m.t === "blob");
    expect(getMsg.sha1).toBe(PNG_SHA1);
    expect(getMsg.url).toContain(`/blobs/${env.tenant.id}/${PNG_SHA1}?ticket=blob1.`);

    // 6. Viewer fetches PNG bytes via HTTP GET and verifies headers
    const getRes = await fetch(`${env.srv.url}${getMsg.url}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getRes.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(getRes.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
    const gotBytes = new Uint8Array(await getRes.arrayBuffer());
    expect(gotBytes).toEqual(PNG_BYTES);

    // 7. HEAD returns 200 with empty body and matching headers
    const headRes = await fetch(`${env.srv.url}${getMsg.url}`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-type")).toBe("image/png");
    expect(headRes.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
    expect(headRes.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await headRes.arrayBuffer()).byteLength).toBe(0);

    editor.close();
    viewer.close();
  } finally {
    await env.cleanup();
  }
});

test("refusals: roles, invalid sha1, rate limit, verb/tenant/sha1 mismatch, >10MB, hash mismatch, non-image, 404, 405", async () => {
  const env = await setupServer({ limits: { blobRate: 3, blobPutPerMin: 3 } });
  try {
    const editor = await openWs(env.srv.wsUrl);
    const annotator = await openWs(env.srv.wsUrl);
    const commenter = await openWs(env.srv.wsUrl);
    const viewer = await openWs(env.srv.wsUrl);

    for (const [sock, tk, client] of [
      [editor, "tk-editor", "ed1"],
      [annotator, "tk-annotator", "an1"],
      [commenter, "tk-commenter", "cm1"],
      [viewer, "tk-viewer", "vw1"],
    ]) {
      sock.send({ t: "hello", v: PROTOCOL_VERSION, token: tk, board: env.board.id, since: 0, client });
      await sock.nextOf(m => m.t === "welcome");
    }

    // Viewer & commenter refused put: true → forbidden
    viewer.send({ t: "blob", sha1: PNG_SHA1, put: true });
    const vwErr = await viewer.nextOf(m => m.t === "error");
    expect(vwErr.code).toBe("forbidden");
    expect(vwErr.id).toBeUndefined();

    commenter.send({ t: "blob", sha1: PNG_SHA1, put: true });
    const cmErr = await commenter.nextOf(m => m.t === "error");
    expect(cmErr.code).toBe("forbidden");
    expect(cmErr.id).toBeUndefined();

    // Annotator allowed put: true
    annotator.send({ t: "blob", sha1: PNG_SHA1, put: true });
    const anBlob = await annotator.nextOf(m => m.t === "blob");
    expect(anBlob.sha1).toBe(PNG_SHA1);

    // Invalid sha1 → bad-op
    for (const bad of ["short", PNG_SHA1.toUpperCase(), "../" + "a".repeat(37), 12345]) {
      editor.send({ t: "blob", sha1: bad });
      const err = await editor.nextOf(m => m.t === "error");
      expect(err.code).toBe("bad-op");
      expect(err.id).toBeUndefined();
    }

    // Per-connection rate limit (blobRate = 3): 4th immediate request → limit
    for (let i = 0; i < 3; i++) {
      viewer.send({ t: "blob", sha1: PNG_SHA1 });
      await viewer.nextOf(m => m.t === "blob");
    }
    viewer.send({ t: "blob", sha1: PNG_SHA1 });
    const limErr = await viewer.nextOf(m => m.t === "error");
    expect(limErr.code).toBe("limit");
    expect(limErr.id).toBeUndefined();

    // HTTP ticket & validation refusals
    const putTicket = await env.sess.issueBlobTicket(env.tenant.id, PNG_SHA1, "put");
    const getTicket = await env.sess.issueBlobTicket(env.tenant.id, PNG_SHA1, "get");
    const base = `${env.srv.url}/blobs/${env.tenant.id}/${PNG_SHA1}`;

    // Missing / invalid ticket → 401
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(`${base}?ticket=bogus`)).status).toBe(401);

    // Method not allowed → 405
    expect((await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { method: "POST" })).status).toBe(405);

    // get ticket used on PUT → 403; put ticket used on GET/HEAD → 403
    expect((await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { method: "PUT", body: PNG_BYTES })).status).toBe(403);
    expect((await fetch(`${base}?ticket=${encodeURIComponent(putTicket)}`, { method: "GET" })).status).toBe(403);
    expect((await fetch(`${base}?ticket=${encodeURIComponent(putTicket)}`, { method: "HEAD" })).status).toBe(403);

    // Cross-tenant or mismatched sha1 URL → 403
    const otherSha1 = "0".repeat(40);
    expect((await fetch(`${env.srv.url}/blobs/other-tenant/${PNG_SHA1}?ticket=${encodeURIComponent(getTicket)}`)).status).toBe(403);
    expect((await fetch(`${env.srv.url}/blobs/${env.tenant.id}/${otherSha1}?ticket=${encodeURIComponent(getTicket)}`)).status).toBe(403);

    // Missing blob on GET / HEAD → 404
    expect((await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`)).status).toBe(404);
    expect((await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { method: "HEAD" })).status).toBe(404);

    // Oversized (>10 MB) upload → 413
    const huge = new Uint8Array(MAX_BLOB_BYTES + 1);
    const hugeRes = await fetch(`${base}?ticket=${encodeURIComponent(putTicket)}`, { method: "PUT", body: huge });
    expect(hugeRes.status).toBe(413);

    // SHA-1 mismatch → 400
    const badHashBytes = new Uint8Array(PNG_BYTES);
    badHashBytes[badHashBytes.length - 1] ^= 0xff;
    const mismatchRes = await fetch(`${base}?ticket=${encodeURIComponent(putTicket)}`, { method: "PUT", body: badHashBytes });
    expect(mismatchRes.status).toBe(400);
    expect((await mismatchRes.json()).error).toBe("hash-mismatch");

    // Non-image bytes (SVG with matching SHA-1) → 400
    const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const svgSha1 = sha1Of(svgBytes);
    const svgPutTicket = await env.sess.issueBlobTicket(env.tenant.id, svgSha1, "put");
    const svgRes = await fetch(`${env.srv.url}/blobs/${env.tenant.id}/${svgSha1}?ticket=${encodeURIComponent(svgPutTicket)}`, {
      method: "PUT",
      headers: { "content-type": "image/svg+xml" },
      body: svgBytes,
    });
    expect(svgRes.status).toBe(400);
    expect((await svgRes.json()).error).toBe("not-image");

    editor.close();
    annotator.close();
    commenter.close();
    viewer.close();
  } finally {
    await env.cleanup();
  }
});

test("client-side upload + auto-fetch: remote image element triggers signed GET and populates doc.files[fileId]", async () => {
  const env = await setupServer();
  const realClock = {
    now: () => Date.now(),
    mono: () => performance.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: h => clearTimeout(h),
    random: () => Math.random(),
  };
  let getFetchCount = 0;
  const countingFetch = async (input, init) => {
    const method = (init?.method || "GET").toUpperCase();
    if (method === "GET" && String(input).includes("/blobs/")) getFetchCount++;
    return fetch(input, init);
  };

  let writerSess = null, viewerSess = null;
  try {
    const writerNet = wsNet({ url: env.srv.wsUrl, WebSocket, clock: realClock, fetch: countingFetch });
    const viewerNet = wsNet({ url: env.srv.wsUrl, WebSocket, clock: realClock, fetch: countingFetch });

    const waitFor = (cond, ms = 4000) => new Promise((res, rej) => {
      const deadline = Date.now() + ms;
      const poll = () => {
        if (cond()) return res();
        if (Date.now() > deadline) return rej(new Error("waitFor timed out"));
        setTimeout(poll, 15);
      };
      poll();
    });

    writerSess = createSession({
      join: () => writerNet.join(),
      fetchSnapshot: writerNet.fetchSnapshot,
      uploadBlob: writerNet.uploadBlob,
      fetchBlob: writerNet.fetchBlob,
      token: "tk-editor",
      board: env.board.id,
      client: "writer",
      user: "dev:editor",
      clock: realClock,
    });
    viewerSess = createSession({
      join: () => viewerNet.join(),
      fetchSnapshot: viewerNet.fetchSnapshot,
      uploadBlob: viewerNet.uploadBlob,
      fetchBlob: viewerNet.fetchBlob,
      token: "tk-viewer",
      board: env.board.id,
      client: "viewer",
      user: "dev:viewer",
      clock: realClock,
    });

    await waitFor(() => writerSess.status === "live" && viewerSess.status === "live");

    // Writer uploads blob via signed PUT and inserts image element
    const uploaded = await writerSess.uploadBlob(PNG_SHA1, PNG_BYTES, "image/png");
    expect(uploaded).toBe(true);
    const expectedDataURL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
    const elId = writerSess.addPicture({ id: PNG_SHA1, mimeType: "image/png", dataURL: expectedDataURL, width: 1, height: 1 }, { x: 0, y: 0 });
    expect(elId).toBeTruthy();

    // Viewer automatically receives the image element, fetches signed GET URL + HTTP GET, and populates doc.files[PNG_SHA1]
    await waitFor(() => Boolean(viewerSess.eds.board.doc.files[PNG_SHA1]));
    const gotFile = viewerSess.eds.board.doc.files[PNG_SHA1];
    expect(gotFile.id).toBe(PNG_SHA1);
    expect(gotFile.mimeType).toBe("image/png");
    expect(gotFile.dataURL).toBe(expectedDataURL);
    // Also populated in notes editor (receiveFiles applies to both) and fetched only once
    expect(viewerSess.eds.notes.doc.files[PNG_SHA1]?.dataURL).toBe(expectedDataURL);
    expect(getFetchCount).toBe(1);
  } finally {
    writerSess?.connection?.close();
    viewerSess?.connection?.close();
    await env.cleanup();
  }
});

test("15 missing images on a board (>10/s burst limit): queued concurrency + backoff retry loads all 15 cleanly", async () => {
  const env = await setupServer(); // default blobRate = 10/s
  const realClock = {
    now: () => Date.now(),
    mono: () => performance.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: h => clearTimeout(h),
    random: () => Math.random(),
  };

  let viewerSess = null;
  try {
    // Seed 15 distinct PNG blobs directly into the server's Blobs store & send 15 image elements via WS
    const items = [];
    for (let i = 0; i < 15; i++) {
      const bytes = new Uint8Array(PNG_BYTES.length + 1);
      bytes.set(PNG_BYTES, 0);
      bytes[PNG_BYTES.length] = i + 1;
      const sha1 = sha1Of(bytes);
      await env.blobs.put(env.tenant.id, sha1, bytes);
      items.push({ sha1, bytes, dataURL: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` });
    }

    const editor = await openWs(env.srv.wsUrl);
    editor.send({ t: "hello", v: PROTOCOL_VERSION, token: "tk-editor", board: env.board.id, since: 0, client: "seed15" });
    const edW = await editor.nextOf(m => m.t === "welcome");
    editor.send({
      t: "op", id: "seed15:1", sentAt: edW.seq, stream: "board",
      op: {
        elements: items.map((it, i) => ({
          id: `img-${i}`, type: "image", fileId: it.sha1,
          x: i * 10, y: 0, width: 10, height: 10, version: 1, versionNonce: i + 1,
        })),
      },
    });
    await editor.nextOf(m => m.t === "ack" && m.id === "seed15:1");
    editor.close();

    // Viewer joins with wsNet + createSession and must load all 15 images despite 10/s gateway burst limit
    const viewerNet = wsNet({ url: env.srv.wsUrl, WebSocket, clock: realClock, fetch });
    viewerSess = createSession({
      join: () => viewerNet.join(),
      fetchSnapshot: viewerNet.fetchSnapshot,
      uploadBlob: viewerNet.uploadBlob,
      fetchBlob: viewerNet.fetchBlob,
      token: "tk-viewer",
      board: env.board.id,
      client: "viewer15",
      user: "dev:viewer",
      clock: realClock,
    });

    const waitFor = (cond, ms = 5000) => new Promise((res, rej) => {
      const deadline = Date.now() + ms;
      const poll = () => {
        if (cond()) return res();
        if (Date.now() > deadline) return rej(new Error("waitFor timed out"));
        setTimeout(poll, 20);
      };
      poll();
    });

    await waitFor(() => items.every(it => Boolean(viewerSess.eds.board.doc.files[it.sha1])));
    for (const it of items) {
      expect(viewerSess.eds.board.doc.files[it.sha1]?.dataURL).toBe(it.dataURL);
    }
  } finally {
    viewerSess?.connection?.close();
    await env.cleanup();
  }
});

test("blob unavailable error rejects pending request cleanly without disconnecting WS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plenary-blobs-unavail-"));
  const registry = memoryRegistry();
  const tenant = await registry.createTenant({ domain: "acme.test" });
  const board = await registry.createBoard({ tenant: tenant.id, title: "No Blobs", memberRole: null });
  await registry.setGrant(board.id, "dev:editor", "editor");
  const dev = devAuth({ enabled: true, tokens: { "tk-editor": { name: "editor", role: "editor" } } });
  const sess = await makeSessions({ key: "u".repeat(32) });
  const auth = authPort({ sessions: sess, dev, tenancy: makeTenancy({ registry }) });
  const store = sqliteStore({ path: join(dir, "plenary.db") });
  const bus = memoryBus();
  // Intentionally omit blobTickets so gateway replies { t: "error", code: "unavailable" }
  const srv = createServer({ auth, registry, store, bus, blobs: null, blobTickets: null, static: false, port: 0 });

  const realClock = {
    now: () => Date.now(),
    mono: () => performance.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: h => clearTimeout(h),
    random: () => Math.random(),
  };
  let clientSess = null;
  try {
    const net = wsNet({ url: srv.wsUrl, WebSocket, clock: realClock, fetch });
    clientSess = createSession({
      join: () => net.join(),
      token: "tk-editor",
      board: board.id,
      client: "ed-unavail",
      user: "dev:editor",
      clock: realClock,
    });
    const waitFor = (cond, ms = 3000) => new Promise((res, rej) => {
      const deadline = Date.now() + ms;
      const poll = () => (cond() ? res() : Date.now() > deadline ? rej(new Error("waitFor timed out")) : setTimeout(poll, 15));
      poll();
    });
    await waitFor(() => clientSess.status === "live");
    expect(clientSess.connection.hellos).toBe(1);

    let caught = null;
    try {
      await clientSess.connection.requestBlobUrl(PNG_SHA1, { put: false });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe("unavailable");

    // Connection stayed live and did NOT reconnect-loop
    await new Promise(r => setTimeout(r, 100));
    expect(clientSess.status).toBe("live");
    expect(clientSess.connection.hellos).toBe(1);
  } finally {
    clientSess?.connection?.close();
    await srv.stop();
    await bus.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP Range requests on /blobs/: 206, 416 with security headers, bytes=0-, invalid bytes=5-2 -> 200, HEAD with Range -> 200", async () => {
  const env = await setupServer();
  try {
    const mp4 = new Uint8Array(64);
    mp4.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
    for (let i = 12; i < mp4.length; i++) mp4[i] = i;
    const mp4Sha1 = sha1Of(mp4);
    const putTicket = await env.sess.issueBlobTicket(env.tenant.id, mp4Sha1, "put");
    const getTicket = await env.sess.issueBlobTicket(env.tenant.id, mp4Sha1, "get");
    const base = `${env.srv.url}/blobs/${env.tenant.id}/${mp4Sha1}`;

    const putRes = await fetch(`${base}?ticket=${encodeURIComponent(putTicket)}`, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: mp4,
    });
    expect(putRes.status).toBe(204);

    // 206 Partial Content
    const r206 = await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { headers: { range: "bytes=0-15" } });
    expect(r206.status).toBe(206);
    expect(r206.headers.get("content-type")).toBe("video/mp4");
    expect(r206.headers.get("content-range")).toBe("bytes 0-15/64");
    expect(r206.headers.get("accept-ranges")).toBe("bytes");
    expect(r206.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await r206.arrayBuffer())).toEqual(mp4.subarray(0, 16));

    // Open-ended bytes=0-
    const rOpen = await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { headers: { range: "bytes=0-" } });
    expect(rOpen.status).toBe(206);
    expect(rOpen.headers.get("content-range")).toBe("bytes 0-63/64");
    expect((await rOpen.arrayBuffer()).byteLength).toBe(64);

    // 416 Unsatisfiable range includes nosniff, cache-control, accept-ranges
    const r416 = await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { headers: { range: "bytes=64-" } });
    expect(r416.status).toBe(416);
    expect(r416.headers.get("content-range")).toBe("bytes */64");
    expect(r416.headers.get("accept-ranges")).toBe("bytes");
    expect(r416.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r416.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    // RFC 9110: invalid range bytes=5-2 (start > end) is ignored -> 200 full body
    const rInvalid = await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { headers: { range: "bytes=5-2" } });
    expect(rInvalid.status).toBe(200);
    expect((await rInvalid.arrayBuffer()).byteLength).toBe(64);

    // HEAD with Range -> 200
    const rHead = await fetch(`${base}?ticket=${encodeURIComponent(getTicket)}`, { method: "HEAD", headers: { range: "bytes=0-15" } });
    expect(rHead.status).toBe(200);
    expect(rHead.headers.get("content-length")).toBe("64");
    expect(rHead.headers.get("accept-ranges")).toBe("bytes");
  } finally {
    await env.cleanup();
  }
});
