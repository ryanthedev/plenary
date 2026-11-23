// Phase 2 Gate: F9 HTTP Snapshot Fetch state machine (Replica + sync.js) & live gateway E2E test.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Replica } from "../../packages/protocol/replica.js";
import { PROTOCOL_VERSION, CONNECT_TIMEOUT_MS } from "../../packages/protocol/envelope.js";
import { Room, snapshotOf } from "../../packages/protocol/room.js";
import { Editor } from "../../packages/core/editor.js";
import { makeElement } from "../../packages/core/model.js";
import { openLink, docDiff, seeded } from "../../web/core/sync.js";
import { wsNet, httpSnapshotFetcher } from "../../web/adapters/transport/ws.js";
import { createServer } from "../../server/adapters/driving/server.js";
import { memoryBus } from "../../server/adapters/driven/bus/memory.js";
import { sqliteStore } from "../../server/adapters/driven/store/sqlite.js";
import { memoryRegistry } from "../../server/adapters/driven/auth/registry.js";
import { sessions as makeSessions } from "../../server/adapters/driven/auth/session.js";
import { tenancy as makeTenancy } from "../../server/core/auth/tenancy.js";
import { devAuth } from "../../server/adapters/driven/auth/dev.js";
import { authPort } from "../../server/ports/auth.js";
import { httpRoutes } from "../../server/adapters/driving/auth-http.js";

/** Build a minimal valid snapshot message at `seq` with board elements. */
function makeSnapshot(seq, elements = []) {
  return {
    t: "snapshot",
    seq,
    streams: {
      board: { elements, appState: { herdr: {} } },
      notes: { elements: [], appState: { herdr: {} } },
    },
    appSeq: { board: {}, notes: {} },
    records: { threads: [] },
    noteAuthor: [],
  };
}

/** Build a minimal valid board entry at `seq`. */
function makeEntry(seq, el, by = "alice", id = `a:${seq}`) {
  return { seq, stream: "board", op: { elements: [el] }, by, id, at: 1000 + seq, rv: 1 };
}

/** Fake controllable transport for deterministic openLink unit tests. */
function makeFakeTransport() {
  let onMsg = () => {};
  let onDrop = null;
  let closed = false;
  const sent = [];
  let reopens = 0;
  return {
    sent,
    get reopens() { return reopens; },
    get closed() { return closed; },
    send(m) { if (!closed) sent.push(m); },
    onMessage(fn) { onMsg = fn; },
    onDrop(fn) { onDrop = fn; },
    congested: () => false,
    backlogBytes: () => 0,
    reopen() { if (!closed) reopens++; },
    close() { closed = true; },
    // Test helpers
    deliver(m) { if (!closed) onMsg(m); },
    drop() { if (!closed) onDrop?.(); },
  };
}

const flushMicrotasks = () => new Promise(r => setTimeout(r, 0));

describe("F9 Replica HTTP snapshot state machine (packages/protocol/replica.js)", () => {
  test("hello includes snap: 'http' only when snapHttp is true and not disabled", () => {
    const rOff = new Replica({ client: "c", session: "1", now: () => 0, random: () => 0.5 });
    expect(rOff.connectMessages("tok", "b1")[0].snap).toBeUndefined();

    const rOn = new Replica({ client: "c", session: "2", now: () => 0, random: () => 0.5, snapHttp: true });
    expect(rOn.connectMessages("tok", "b1")[0].snap).toBe("http");

    rOn.disableHttpSnapshot();
    expect(rOn.resync).toBe(true);
    expect(rOn.connectMessages("tok", "b1")[0].snap).toBeUndefined();
  });

  test("welcome.snapshot > applied enters awaitingSnapshot, buffers entries during & after fetch, drains in seq order", () => {
    let t = 0;
    const r = new Replica({ client: "c", session: "s", now: () => t, random: () => 0.5, snapHttp: true });
    r.connectMessages("tok", "b1");

    const el1 = makeElement("rectangle", { id: "e1", x: 10, y: 10, width: 50, height: 50 });
    const el2 = makeElement("rectangle", { id: "e2", x: 20, y: 20, width: 50, height: 50 });
    const el3 = makeElement("rectangle", { id: "e3", x: 30, y: 30, width: 50, height: 50 });
    const el4 = makeElement("rectangle", { id: "e4", x: 40, y: 40, width: 50, height: 50 });

    // Local op queued before catch-up must wait until snapshot + tail catch up
    r.local("board", { elements: [makeElement("rectangle", { id: "mine", x: 0, y: 0, width: 10, height: 10 })] });

    const wDid = r.receive({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 3, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t1", bytes: 500 },
    });
    expect(wDid.snapshotFetch).toEqual({ seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t1", bytes: 500 });
    expect(r.awaitingSnapshot).toEqual({ seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t1", bytes: 500 });
    expect(r.outgoing()).toEqual([]); // held while awaitingSnapshot

    // Tail entry seq 3 arrives while HTTP snapshot is still in flight -> buffered, not applied
    const e3Did = r.receive({ t: "entries", entries: [makeEntry(3, el3)] });
    expect(e3Did.entries).toEqual([]);
    expect(r.applied).toBe(0);
    expect(r.buffer.has(3)).toBe(true);

    // HTTP snapshot completes -> applies seq 2, clears awaitingSnapshot, flushes buffered seq 3
    const sDid = r.receive(makeSnapshot(2, [el1, el2]));
    expect(sDid.snapshot).toBe(true);
    expect(sDid.entries.map(e => e.seq)).toEqual([3]);
    expect(r.awaitingSnapshot).toBeNull();
    expect(r.applied).toBe(3);

    // Now caught up: local pending op is released by outgoing()
    const out = r.outgoing();
    expect(out.length).toBe(1);
    expect(out[0].op.elements[0].id).toBe("mine");

    // Live entry seq 4 arrives after fetch -> applied normally
    const e4Did = r.receive({ t: "entries", entries: [makeEntry(4, el4)] });
    expect(e4Did.entries.map(e => e.seq)).toEqual([4]);
    expect(r.applied).toBe(4);
    expect(["e1", "e2", "e3", "e4"].every(id => !!r.streams.board.get(id))).toBe(true);
  });

  test("welcome.snapshot.seq <= applied ignores HTTP fetch and applies tail entries normally", () => {
    const r = new Replica({ client: "c", session: "s", now: () => 0, random: () => 0.5, snapHttp: true });
    r.connectMessages("tok", "b1");
    const el1 = makeElement("rectangle", { id: "e1", x: 1, y: 1, width: 10, height: 10 });
    const el2 = makeElement("rectangle", { id: "e2", x: 2, y: 2, width: 10, height: 10 });
    const el3 = makeElement("rectangle", { id: "e3", x: 3, y: 3, width: 10, height: 10 });

    // Already applied up to seq 2
    r.receive({ t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0, room: { board: "b1", epoch: 1 } });
    r.receive(makeSnapshot(2, [el1, el2]));
    expect(r.applied).toBe(2);

    // Reconnect and receive welcome with snapshot.seq === 2 (<= applied) and target seq === 3
    r.connectMessages("tok", "b1");
    const did = r.receive({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 3, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t2", bytes: 500 },
    });
    expect(did.snapshotFetch).toBeUndefined();
    expect(r.awaitingSnapshot).toBeNull();

    // Tail entry seq 3 applies directly
    const e3 = r.receive({ t: "entries", entries: [makeEntry(3, el3)] });
    expect(e3.entries.map(e => e.seq)).toEqual([3]);
    expect(r.applied).toBe(3);
  });

  test("timeout while awaitingSnapshot disables snapHttp and triggers resync without dropping pending ops", () => {
    let t = 0;
    const r = new Replica({ client: "c", session: "s", now: () => t, random: () => 0.5, snapHttp: true });
    r.connectMessages("tok", "b1");
    r.local("board", { elements: [makeElement("rectangle", { id: "p1", x: 0, y: 0, width: 10, height: 10 })] });
    r.receive({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t1", bytes: 500 },
    });
    expect(r.awaitingSnapshot).not.toBeNull();

    t += CONNECT_TIMEOUT_MS;
    r.outgoing();
    expect(r.resync).toBe(true);
    expect(r.snapHttpDisabled).toBe(true);
    expect(r.awaitingSnapshot).toBeNull();
    expect(r.pending.size).toBe(1);

    const [hello2] = r.connectMessages("tok", "b1");
    expect(hello2.snap).toBeUndefined();
    expect(r.pending.size).toBe(1);
  });

  test("busy board: live entries arriving while HTTP snapshot hangs do NOT extend the snapshot timeout", () => {
    let t = 0;
    const r = new Replica({ client: "c", session: "s", now: () => t, random: () => 0.5, snapHttp: true });
    r.connectMessages("tok", "b1");
    r.local("board", { elements: [makeElement("rectangle", { id: "keep-me", x: 0, y: 0, width: 10, height: 10 })] });
    r.receive({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t1", bytes: 500 },
    });
    expect(r.awaitingSnapshot).not.toBeNull();

    // Live entries arrive every 2 s while the HTTP fetch hangs
    for (let seq = 3; seq <= 6; seq++) {
      t += 2000;
      r.receive({ t: "entries", entries: [makeEntry(seq, makeElement("rectangle", { id: `live-${seq}`, x: seq, y: 0, width: 10, height: 10 }))] });
      expect(r.resync).toBe(false);
    }
    // Total elapsed is 8000 ms; 2000 ms more hits CONNECT_TIMEOUT_MS (10,000 ms) from welcome
    t += CONNECT_TIMEOUT_MS - 8000;
    r.outgoing();
    expect(r.resync).toBe(true);
    expect(r.snapHttpDisabled).toBe(true);
    expect(r.awaitingSnapshot).toBeNull();
    expect(r.pending.size).toBe(1);

    const [hello2] = r.connectMessages("tok", "b1");
    expect(hello2.snap).toBeUndefined();
    expect(r.pending.size).toBe(1);
  });

  test("unsolicited welcome.snapshot is ignored when snapHttp is disabled", () => {
    const r = new Replica({ client: "c", session: "s", now: () => 0, random: () => 0.5, snapHttp: false });
    r.connectMessages("tok", "b1");
    const did = r.receive({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=unsolicited", bytes: 500 },
    });
    expect(did.snapshotFetch).toBeUndefined();
    expect(r.awaitingSnapshot).toBeNull();
  });
});

describe("F9 sync.js HTTP snapshot orchestration & fallback", () => {
  test("HTTP failure fallback disables snap: 'http', reconnects for inline WS snapshot, preserves pending ops", async () => {
    const transport = makeFakeTransport();
    const editor = new Editor();
    const statuses = [];
    const fetchCalls = [];
    const fetchSnapshot = async (url, { signal }) => {
      fetchCalls.push({ url, aborted: signal?.aborted });
      throw new Error("HTTP 500");
    };

    const link = openLink({
      transport,
      fetchSnapshot,
      token: "tok",
      board: "b1",
      timeoutMs: 0,
      now: () => 1000,
      random: seeded(1),
      onStatus: s => statuses.push(s),
    });
    const handle = link.bind(editor, "board");
    link.start();

    // First hello advertises snap: "http"
    expect(transport.sent[0]).toMatchObject({ t: "hello", snap: "http" });

    // Create a local pending op BEFORE catch-up completes
    const [localId] = editor.insertElements([makeElement("rectangle", { x: 5, y: 5, width: 20, height: 20 })]);
    expect(handle.pending).toBe(1);

    // Server sends welcome with HTTP snapshot -> fetchSnapshot rejects -> fallback reconnects without snap
    transport.deliver({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=bad", bytes: 500 },
    });
    expect(handle.status).toBe("catching-up");

    await flushMicrotasks();

    // Reopened without snap: "http", pending op preserved!
    expect(fetchCalls.length).toBe(1);
    expect(transport.reopens).toBe(1);
    expect(transport.sent[1]).toMatchObject({ t: "hello", board: "b1" });
    expect(transport.sent[1].snap).toBeUndefined();
    expect(handle.pending).toBe(1);

    // Server now sends inline WS snapshot -> client becomes live and sends the preserved pending op!
    const el1 = makeElement("rectangle", { id: "srv-1", x: 10, y: 10, width: 40, height: 40 });
    transport.deliver({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0,
      room: { board: "b1", epoch: 1 },
    });
    transport.deliver(makeSnapshot(2, [el1]));

    expect(handle.status).toBe("live");
    expect(editor.doc.get("srv-1")).toBeTruthy();
    expect(editor.doc.get(localId)).toBeTruthy();
    const sentOp = transport.sent.find(m => m.t === "op");
    expect(sentOp).toBeDefined();
    expect(sentOp.op.elements[0].id).toBe(localId);

    handle.close();
  });

  test("AbortController cancels in-flight fetchSnapshot when socket drops first (and keeps snapHttp enabled)", async () => {
    const transport = makeFakeTransport();
    const editor = new Editor();
    let capturedSignal = null;
    let resolveFetch = null;
    const fetchSnapshot = (_url, { signal }) => new Promise(res => {
      capturedSignal = signal;
      resolveFetch = res;
    });

    const link = openLink({
      transport,
      fetchSnapshot,
      token: "tok",
      board: "b1",
      timeoutMs: 0,
      now: () => 1000,
      random: seeded(2),
    });
    const handle = link.bind(editor, "board");
    link.start();

    transport.deliver({
      t: "welcome", v: PROTOCOL_VERSION, role: "editor", user: "bob", seq: 2, horizon: 0,
      room: { board: "b1", epoch: 1 },
      snapshot: { seq: 2, url: "/boards/b1/snapshot?seq=2&ticket=t1", bytes: 500 },
    });
    await flushMicrotasks();

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal.aborted).toBe(false);

    // Socket drops while HTTP fetch is still in flight
    transport.drop();
    expect(capturedSignal.aborted).toBe(true);

    // Reconnect STILL advertises snap: "http" (socket drop is not an HTTP snapshot failure)
    expect(transport.reopens).toBe(1);
    expect(transport.sent[1]).toMatchObject({ t: "hello", snap: "http" });

    // Late resolution from the aborted first fetch is ignored cleanly
    resolveFetch(makeSnapshot(2, [makeElement("rectangle", { id: "stale-snap", x: 0, y: 0, width: 10, height: 10 })]));
    await flushMicrotasks();
    expect(editor.doc.get("stale-snap")).toBeNull();

    handle.close();
  });

  test("httpSnapshotFetcher enforces same-origin and validates snapshot payload", async () => {
    const fetcher = httpSnapshotFetcher({
      origin: "http://127.0.0.1:8080",
      fetch: async url => ({
        ok: true,
        status: 200,
        json: async () => (
          url.includes("bad-type") ? { t: "nope" }
            : url.includes("bad-streams") ? { t: "snapshot", seq: 2, streams: { board: {} } }
            : makeSnapshot(2, [])
        ),
      }),
    });

    const ok = await fetcher("/boards/b1/snapshot?seq=2&ticket=t");
    expect(ok.t).toBe("snapshot");
    expect(ok.seq).toBe(2);

    await expect(fetcher("https://evil.example/boards/b1/snapshot")).rejects.toThrow(/cross-origin/);
    await expect(fetcher("/boards/b1/snapshot?bad-type=1")).rejects.toThrow(/invalid snapshot/);
    await expect(fetcher("/boards/b1/snapshot?bad-streams=1")).rejects.toThrow(/invalid snapshot/);
  });
});

describe("F9 Live Gateway E2E (sync.js + wsNet against checkpointed createServer)", () => {
  test("HTTP snapshot client, inline WS client, and failing-HTTP fallback client converge to identical board state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plenary-m3-http-snap-"));
    const store = sqliteStore({ path: join(dir, "store.sqlite") });
    const registry = memoryRegistry();
    const bus = memoryBus();
    const sess = await makeSessions({ key: "k".repeat(32) });
    const tenancy = makeTenancy({ registry });
    const BASE_CONFIG = {
      cookieKey: "k".repeat(32),
      postLoginUrl: "http://localhost:8080/",
      boardUrl: "http://localhost:8080/b/{board}",
      publicUrl: "http://localhost:8080",
    };

    const dev = devAuth({ enabled: true, tokens: { ed: { name: "ed", role: "editor" }, vw: { name: "vw", role: "viewer" } } });
    const auth = authPort({ sessions: sess, dev, tenancy });
    const tenant = await registry.createTenant({ domain: null });
    const space = await registry.createSpace({ tenant: tenant.id, name: "Snap", generalRole: null });
    const board = await registry.createBoard({ tenant: tenant.id, space: space.id, title: "M3 Snap Board", memberRole: null });
    await registry.setGrant(board.id, "dev:ed", "editor");
    await registry.setGrant(board.id, "dev:vw", "viewer");

    // Seed 3 entries: checkpoint at seq 2 + tail entry at seq 3
    const epoch = await store.openEpoch(tenant.id, board.id);
    const seedEls = [1, 2, 3].map(i => makeElement("rectangle", {
      id: `el-${i}`, x: i * 50, y: i * 20, width: 80, height: 40,
    }));
    const entries = seedEls.map((el, idx) => ({
      seq: idx + 1,
      board: board.id,
      tenant: tenant.id,
      stream: "board",
      op: { elements: [{ ...el, version: 1, versionNonce: idx + 10 }] },
      by: "dev:ed",
      id: `seed:${idx + 1}`,
      at: 1000 + idx,
      rv: 1,
    }));
    await store.append(tenant.id, board.id, entries.slice(0, 2), 0, epoch);
    const room = Room.rebuild({ board: board.id, tenant: tenant.id, log: { append: () => {}, putCheckpoint: () => {} }, epoch, checkpoint: null, entries: entries.slice(0, 2) });
    await store.putCheckpoint(tenant.id, board.id, room.checkpoint(), epoch);
    await store.append(tenant.id, board.id, [entries[2]], 2, epoch);

    const snapshotTickets = {
      issue: (b, s) => sess.issueSnapshotTicket(b, s),
      verify: tk => sess.verifySnapshotTicket(tk),
    };
    let srv;
    const http = httpRoutes({
      registry,
      sessions: sess,
      tenancy,
      config: BASE_CONFIG,
      snapshot: { get: (b, s) => srv.gateway.snapshot(b, s) },
      snapshotTickets,
    });
    // Low httpSnapshotBytes threshold (10 bytes) forces HTTP offload for this checkpoint
    srv = createServer({ auth, registry, store, bus, http, snapshotTickets, limits: { httpSnapshotBytes: 10 }, static: false });

    const clock = {
      now: () => Date.now(),
      mono: () => performance.now(),
      set: (fn, ms) => setTimeout(fn, ms),
      clear: h => clearTimeout(h),
      random: seeded(7),
    };

    const waitLive = (handle, ms = 4000) => new Promise((resolve, reject) => {
      if (handle.status === "live") return resolve();
      const deadline = Date.now() + ms;
      const poll = setInterval(() => {
        if (handle.status === "live") { clearInterval(poll); resolve(); }
        else if (Date.now() > deadline) { clearInterval(poll); reject(new Error(`timed out waiting for live (status=${handle.status})`)); }
      }, 10);
    });

    let hHttp, hWs, hFallback;
    try {
      // 1. Client A: HTTP snapshot via wsNet
      let httpFetchCount = 0;
      const netHttp = wsNet({
        url: srv.wsUrl,
        WebSocket: globalThis.WebSocket,
        clock,
        fetch: (...a) => { httpFetchCount++; return globalThis.fetch(...a); },
      });
      const edHttp = new Editor();
      const linkHttp = openLink({
        transport: netHttp.join(),
        fetchSnapshot: netHttp.fetchSnapshot,
        token: "vw",
        board: board.id,
        client: "c-http",
        clock,
      });
      hHttp = linkHttp.bind(edHttp, "board");
      linkHttp.start();

      // 2. Client B: Inline WS snapshot (no fetchSnapshot)
      const netWs = wsNet({ url: srv.wsUrl, WebSocket: globalThis.WebSocket, clock });
      const edWs = new Editor();
      const linkWs = openLink({
        transport: netWs.join(),
        token: "vw",
        board: board.id,
        client: "c-ws",
        clock,
      });
      hWs = linkWs.bind(edWs, "board");
      linkWs.start();

      // 3. Client C: Failing HTTP snapshot -> falls back cleanly to inline WS snapshot
      let failAttempts = 0;
      const edFallback = new Editor();
      const linkFallback = openLink({
        transport: netWs.join(),
        fetchSnapshot: async () => { failAttempts++; throw new Error("simulated 503"); },
        token: "vw",
        board: board.id,
        client: "c-fallback",
        clock,
      });
      hFallback = linkFallback.bind(edFallback, "board");
      linkFallback.start();

      await Promise.all([waitLive(hHttp), waitLive(hWs), waitLive(hFallback)]);

      expect(httpFetchCount).toBe(1);
      expect(failAttempts).toBe(1);
      expect(hFallback.hellos).toBeGreaterThanOrEqual(2);

      // All three editors have the exact 3 seeded elements and identical doc state
      expect(edHttp.doc.visible().map(e => e.id).sort()).toEqual(["el-1", "el-2", "el-3"]);
      expect(docDiff(edHttp.doc, edWs.doc)).toEqual([]);
      expect(docDiff(edHttp.doc, edFallback.doc)).toEqual([]);
    } finally {
      hHttp?.close();
      hWs?.close();
      hFallback?.close();
      await srv?.stop();
      await bus?.close();
      await store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
