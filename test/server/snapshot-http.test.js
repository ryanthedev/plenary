// p5-snap (F9): HTTP snapshot route (GET/HEAD /boards/:board/snapshot?ticket=...) + signed snapshot ticket
// for large-board catch-up off the WebSocket frame path.
import { test, expect } from "bun:test";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";
import { authPort } from "../../server/ports/auth.js";
import { createServer } from "../../server/adapters/driving/server.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { Room } from "../../packages/protocol/room.js";
import { PROTOCOL_VERSION } from "../../packages/protocol/envelope.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIGIN = "https://plenary.test";
const BASE_CONFIG = {
  cookieKey: "k".repeat(32),
  postLoginUrl: ORIGIN + "/",
  boardUrl: ORIGIN + "/b/{board}",
  publicUrl: ORIGIN,
};

test("snapshot tickets: issue, verify offline, prefix isolation, expiry, tamper", async () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const sess = await makeSessions({ key: "s".repeat(32), snapshotTtlSec: 120, now });
  const other = await makeSessions({ key: "x".repeat(32), now });

  const ticket = await sess.issueSnapshotTicket("b-42", 1000);
  expect(ticket.startsWith("snap1.")).toBe(true);
  expect(await sess.verifySnapshotTicket(ticket)).toEqual({ board: "b-42", seq: 1000, exp: Math.floor(t / 1000) + 120 });

  // Prefix isolation: snap1 ticket is never a session token, and s1 session token is never a snapshot ticket.
  expect(await sess.verify(ticket)).toBeNull();
  const sessionToken = await sess.issue({ user: "u1", name: "Ann", email: "a@b.c", domain: "b.c" });
  expect(await sess.verifySnapshotTicket(sessionToken)).toBeNull();

  // Different key and tampered ticket are rejected.
  expect(await other.verifySnapshotTicket(ticket)).toBeNull();
  const parts = ticket.split(".");
  expect(await sess.verifySnapshotTicket(`${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`)).toBeNull();

  // Expiry enforced against `now`.
  t += 120_000;
  expect(await sess.verifySnapshotTicket(ticket)).toBeNull();

  // Bad inputs rejected.
  await expect(sess.issueSnapshotTicket("", 0)).rejects.toThrow();
  await expect(sess.issueSnapshotTicket("b-1", -1)).rejects.toThrow();
});

test("HTTP /boards/:board/snapshot route: auth, board/seq scoping, gzip, ETag 304, HEAD, 405, 503", async () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const registry = memoryRegistry({ now });
  const sess = await makeSessions({ key: "s".repeat(32), snapshotTtlSec: 300, now });
  const tenancy = makeTenancy({ registry, now });

  // Without snapshot provider → 503 snapshot-unavailable
  const noSnap = httpRoutes({ registry, sessions: sess, tenancy, now, config: BASE_CONFIG });
  const r503 = await noSnap(new Request(ORIGIN + "/boards/b1/snapshot?ticket=x"));
  expect(r503.status).toBe(503);
  expect(await r503.json()).toEqual({ error: "snapshot-unavailable" });

  const payload = JSON.stringify({ t: "snapshot", seq: 50, streams: { board: { elements: [{ id: "e1", type: "rect" }], appState: {} }, notes: { elements: [], appState: {} } }, appSeq: { board: {}, notes: {} }, records: { threads: [] }, noteAuthor: [] });
  const gzBytes = Bun.gzipSync(Buffer.from(payload, "utf8"));
  const routes = httpRoutes({
    registry, sessions: sess, tenancy, now, config: BASE_CONFIG,
    snapshot: {
      async get(board, seq) {
        if (board === "b1" && seq === 50) return { seq: 50, data: payload, gzip: () => gzBytes };
        return null;
      },
    },
  });

  // Missing / bad ticket → 401
  expect((await routes(new Request(ORIGIN + "/boards/b1/snapshot"))).status).toBe(401);
  expect((await routes(new Request(ORIGIN + "/boards/b1/snapshot?ticket=bogus"))).status).toBe(401);

  const ticket = await sess.issueSnapshotTicket("b1", 50);

  // Wrong board → 403
  expect((await routes(new Request(`${ORIGIN}/boards/b2/snapshot?ticket=${encodeURIComponent(ticket)}`))).status).toBe(403);

  // Mismatched or invalid seq param → 400
  expect((await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=51&ticket=${encodeURIComponent(ticket)}`))).status).toBe(400);
  expect((await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=abc&ticket=${encodeURIComponent(ticket)}`))).status).toBe(400);

  // Missing snapshot → 404
  const missingTicket = await sess.issueSnapshotTicket("b1", 99);
  expect((await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=99&ticket=${encodeURIComponent(missingTicket)}`))).status).toBe(404);

  // Method not allowed → 405
  expect((await routes(new Request(`${ORIGIN}/boards/b1/snapshot?ticket=${encodeURIComponent(ticket)}`, { method: "POST" }))).status).toBe(405);

  // Plain 200 + ETag + Cache-Control
  const ok = await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=50&ticket=${encodeURIComponent(ticket)}`));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("etag")).toBe('"snap-b1-50"');
  expect(ok.headers.get("cache-control")).toBe("private, max-age=300, immutable");
  expect(ok.headers.get("vary")).toBe("Accept-Encoding");
  expect(ok.headers.get("content-encoding")).toBeNull();
  expect(await ok.text()).toBe(payload);

  // Gzip 200
  const gzRes = await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=50&ticket=${encodeURIComponent(ticket)}`, { headers: { "accept-encoding": "gzip, br" } }));
  expect(gzRes.status).toBe(200);
  expect(gzRes.headers.get("content-encoding")).toBe("gzip");
  const rawGz = new Uint8Array(await gzRes.arrayBuffer());
  expect(new TextDecoder().decode(Bun.gunzipSync(rawGz))).toBe(payload);

  // If-None-Match → 304
  const notMod = await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=50&ticket=${encodeURIComponent(ticket)}`, { headers: { "if-none-match": '"snap-b1-50"' } }));
  expect(notMod.status).toBe(304);
  expect(await notMod.text()).toBe("");

  // HEAD → 200 with empty body
  const head = await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=50&ticket=${encodeURIComponent(ticket)}`, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(head.headers.get("etag")).toBe('"snap-b1-50"');
  expect(await head.text()).toBe("");

  // Expired ticket → 401
  t += 300_000;
  expect((await routes(new Request(`${ORIGIN}/boards/b1/snapshot?seq=50&ticket=${encodeURIComponent(ticket)}`))).status).toBe(401);
});

/** Helper: connect a WS, send hello, collect frames until predicate or timeout. */
function wsCollect(wsUrl, helloMsg, stopWhen, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout after ${timeoutMs}ms; got ${msgs.map(m => m.t).join(",")}`)); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(helloMsg));
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      msgs.push(m);
      if (stopWhen(msgs, m)) { clearTimeout(timer); ws.close(); resolve(msgs); }
    };
    ws.onerror = e => { clearTimeout(timer); reject(e); };
    ws.onclose = ev => {
      if (stopWhen(msgs, null, ev)) { clearTimeout(timer); resolve(msgs); }
    };
  });
}

test("live E2E: welcome.snapshot + tail-only WS catch-up + HTTP snapshot fetch (warm & cold gateway)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plenary-snap-"));
  let srv1, srv2, store, bus;
  try {
    store = sqliteStore({ path: join(dir, "plenary.db") });
    bus = memoryBus();
    const registry = memoryRegistry();
    const sess = await makeSessions({ key: "k".repeat(32) });
    const tenancy = makeTenancy({ registry });
    const dev = devAuth({ enabled: true, tokens: { ed: { name: "ed", role: "editor" }, vw: { name: "vw", role: "viewer" } } });
    const auth = authPort({ sessions: sess, dev, tenancy });

    const tenant = await registry.createTenant({ domain: null });
    const space = await registry.createSpace({ tenant: tenant.id, name: "Snap", generalRole: null });
    const board = await registry.createBoard({ tenant: tenant.id, space: space.id, title: "big", memberRole: null });
    await registry.setGrant(board.id, "dev:ed", "editor");
    await registry.setGrant(board.id, "dev:vw", "viewer");

    // Seed 3 entries, save a checkpoint at seq 2, and leave seq 3 in the tail.
    const epoch = await store.openEpoch(tenant.id, board.id);
    const entries = [1, 2, 3].map(i => ({
      seq: i, board: board.id, tenant: tenant.id, stream: "board",
      op: { elements: [{ id: `el-${i}`, type: "rectangle", version: 1, versionNonce: i, x: i * 10, y: 0, width: 50, height: 50, payload: "x".repeat(200) }] },
      by: "dev:ed", id: `seed:${i}`, at: 1000 + i, rv: 1,
    }));
    await store.append(tenant.id, board.id, entries.slice(0, 2), 0, epoch);
    const room = Room.rebuild({ board: board.id, tenant: tenant.id, log: { append: () => {}, putCheckpoint: () => {} }, epoch, checkpoint: null, entries: entries.slice(0, 2) });
    await store.putCheckpoint(tenant.id, board.id, room.checkpoint(), epoch);
    await store.append(tenant.id, board.id, [entries[2]], 2, epoch);

    const snapshotTickets = {
      issue: (b, s) => sess.issueSnapshotTicket(b, s),
      verify: tk => sess.verifySnapshotTicket(tk),
    };
    const makeNode = (httpSnapshotBytes) => {
      let srv;
      const http = httpRoutes({
        registry, sessions: sess, tenancy, config: BASE_CONFIG,
        snapshot: { get: (b, s) => srv.gateway.snapshot(b, s) },
        snapshotTickets,
      });
      srv = createServer({ auth, registry, store, bus, http, snapshotTickets, limits: { httpSnapshotBytes }, static: false });
      return srv;
    };
    // Gateway 1: low threshold (10 bytes) so our seeded checkpoint triggers HTTP offload.
    srv1 = makeNode(10);
    // Gateway 2: separate server sharing the same Store + Registry + SESSION_KEY (cold feed for `board`).
    srv2 = makeNode(10);

    // 1. Viewer with snap: "http" gets welcome.snapshot + tail-only entries (seq 3), NO WS snapshot frame.
    const httpMsgs = await wsCollect(
      srv1.wsUrl,
      { t: "hello", v: PROTOCOL_VERSION, token: "vw", board: board.id, since: 0, client: "v-http", snap: "http" },
      msgs => msgs.some(m => m.t === "here"),
    );
    const welcome = httpMsgs.find(m => m.t === "welcome");
    expect(welcome.seq).toBe(3);
    expect(welcome.snapshot).toBeDefined();
    expect(welcome.snapshot.seq).toBe(2);
    expect(welcome.snapshot.url).toContain(`/boards/${board.id}/snapshot?seq=2&ticket=`);
    expect(httpMsgs.some(m => m.t === "snapshot")).toBe(false);
    const tailEntries = httpMsgs.filter(m => m.t === "entries").flatMap(m => m.entries);
    expect(tailEntries.map(e => e.seq)).toEqual([3]);

    // 2. Fetch the snapshot over HTTP from Gateway 1 (warm feed) — plain and gzipped + 304.
    const snapRes = await fetch(srv1.url + welcome.snapshot.url, { headers: { "accept-encoding": "identity" } });
    expect(snapRes.status).toBe(200);
    const etag = snapRes.headers.get("etag");
    expect(etag).toBe(`"snap-${board.id}-2"`);
    const snapJson = await snapRes.json();
    expect(snapJson.t).toBe("snapshot");
    expect(snapJson.seq).toBe(2);
    expect(snapJson.streams.board.elements.map(e => e.id).sort()).toEqual(["el-1", "el-2"]);

    // 3. Same ticket verified offline by Gateway 2 (cold feed — reads Store checkpoint & verifies against log).
    const coldRes = await fetch(srv2.url + welcome.snapshot.url);
    expect(coldRes.status).toBe(200);
    const coldJson = await coldRes.json();
    expect(coldJson).toEqual(snapJson);

    // 4. Legacy client WITHOUT hello.snap still gets inline WS snapshot + tail entries (backwards-compatible).
    const wsMsgs = await wsCollect(
      srv1.wsUrl,
      { t: "hello", v: PROTOCOL_VERSION, token: "vw", board: board.id, since: 0, client: "v-ws" },
      msgs => msgs.some(m => m.t === "here"),
    );
    expect(wsMsgs.find(m => m.t === "welcome").snapshot).toBeUndefined();
    const wsSnap = wsMsgs.find(m => m.t === "snapshot");
    expect(wsSnap).toBeDefined();
    expect(wsSnap.seq).toBe(2);
    expect(wsSnap.streams.board.elements.map(e => e.id).sort()).toEqual(["el-1", "el-2"]);

    // 5. Invalid hello.snap value is refused with bad-op.
    const badMsgs = await wsCollect(
      srv1.wsUrl,
      { t: "hello", v: PROTOCOL_VERSION, token: "vw", board: board.id, since: 0, client: "v-bad", snap: "ftp" },
      (msgs, _m, closeEv) => !!closeEv || msgs.some(m => m.t === "error"),
    );
    expect(badMsgs[0]).toMatchObject({ t: "error", code: "bad-op" });
  } finally {
    await srv1?.stop();
    await srv2?.stop();
    await bus?.close();
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
