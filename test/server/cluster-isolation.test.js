// Cluster isolation on a shared NATS (PROTOCOL.md § Bus, Cluster id; GitHub issue #63). Two clusters, each with its
// own Postgres database, share ONE NATS server. A foreign cluster's host must never answer a board-open, take a
// lease, or acknowledge an op into its own Store. Real Postgres and NATS; skips without DATABASE_URL and NATS_URL.
// Nodes run in this process through start() (the same wiring main.js uses). TTL 3 s: a node drops its room after a stall of 2/3 of its ttl, so 2 s of event-loop stall is tolerated (the server accepts as low as 3 ms).
import { test, expect, afterAll, describe, setDefaultTimeout } from "bun:test";
import { SQL } from "bun";
import { start } from "../../server/main.js";
import { postgresStore } from "../../server/adapters/driven/store/postgres.js";
import { natsBus } from "../../server/adapters/driven/bus/nats.js";
import { subjects } from "../../server/ports/bus.js";
import { tempDir, cleanup, until } from "./helpers.js";
import { sock } from "./rig.js";

// Failure-only ceiling for tests (and hooks registered after it) doing real Postgres/NATS work: bun's 5 s default fails them under machine load (TECH-DEBT rows 36, 38).
setDefaultTimeout(30_000);
afterAll(cleanup);
// The rig's S3 (the cluster's picture storage): a cluster node refuses to start without it. Many nodes share it, which the single-gateway local-disk opt-in could not serve.
const S3_ENV = () => Object.fromEntries(["S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const PG = process.env.DATABASE_URL, NATS = process.env.NATS_URL;
const TTL = 3_000;
const TOKEN = "S3CR3T-isolation-token";
const TOKENS = JSON.stringify({ [TOKEN]: { name: "ann", role: "owner", domain: "iso.test", email: "ann@iso.test", admin: true } });

describe.skipIf(!PG || !NATS)("two clusters on one NATS", () => {
  let admin;
  const dbs = [], apps = [], socks = [];
  afterAll(async () => {
    for (const s of socks) try { s.ws.close(); } catch { /* gone */ }
    for (const a of apps) await a.stop().catch(() => {});
    if (admin) { for (const d of dbs) await admin.unsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => {}); await admin.close(); }
  }, 60_000);   // stops up to 4 nodes and force-drops 3 databases: under load this overran bun's 5 s hook default (TECH-DEBT row 36); a failure-only ceiling
  const newDb = async tag => {
    admin ??= new SQL({ url: PG, max: 1 });
    const name = `plen_iso_${tag}_${process.pid}_${Date.now().toString(36)}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`); dbs.push(name);
    const u = new URL(PG); u.pathname = "/" + name; return u.toString();
  };
  const node = async (dbUrl, id, roles) => {
    const app = await start({ DATABASE_URL: dbUrl, NATS_URL: NATS, COOKIE_KEY: "c".repeat(40), ...S3_ENV(), PLENARY_DEV_TOKENS: TOKENS, LOG_LEVEL: "error", PORT: "0",
      PLENARY_NODE_ID: id, PLENARY_ROLES: roles, PLENARY_LEASE_TTL_MS: String(TTL), PLENARY_DATA_DIR: tempDir(`plenary-iso-${id}-`) }, { write: () => {} });
    apps.push(app);
    return { app, url: `http://127.0.0.1:${app.server.port}`, ws: `ws://127.0.0.1:${app.server.port}/ws`, dbUrl };
  };
  const mkBoard = async n => {
    const r = await fetch(n.url + "/boards", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ title: "iso" }) });
    expect(r.status).toBe(201);
    return (await r.json()).board;
  };
  const hello = async (n, board, client) => {
    const s = await sock(n.ws); socks.push(s);
    s.send({ t: "hello", v: 1, token: TOKEN, board: board.id, since: 0, client });
    return s;
  };
  const op = (client, k) => ({ t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [{ id: `${client}-${k}`, type: "rectangle", version: 1, versionNonce: k, x: k, y: 0, width: 1, height: 1, isDeleted: false }] } });
  /** What a Store holds for a board: its lease record and its entries, read straight from that database. */
  const inStore = async (dbUrl, board) => {
    const st = await postgresStore({ url: dbUrl, max: 1 });
    try { return { lease: await st.lease(board.tenant, board.id), last: await st.lastSeq(board.tenant, board.id) }; } finally { await st.close(); }
  };

  test("DW-iso: a host of another cluster on the same NATS never serves, leases or acks a board; each cluster serves only its own", async () => {
    const urlA = await newDb("a"), urlB = await newDb("b");
    // Cluster A starts with a gateway only (its host comes later). Cluster B is one full node.
    const gwA = await node(urlA, "iso-a-gw", "gateway");
    const nodeB = await node(urlB, "iso-b-all", "gateway,host");
    expect(gwA.app.clusterId).toMatch(/^c-[a-z0-9]{16}$/);
    expect(nodeB.app.clusterId).toMatch(/^c-[a-z0-9]{16}$/);
    expect(gwA.app.clusterId).not.toBe(nodeB.app.clusterId);
    const boardA = await mkBoard(gwA), boardB = await mkBoard(nodeB);

    // 1. A's writer asks for A's board while the only host on the bus belongs to B: nobody in A answers, so it
    //    is refused `unavailable`; before the fix B's host would have opened A's board and acked into B's Store.
    const s1 = await hello(gwA, boardA, "a1");
    const closed = await s1.whenClosed(TTL + 15_000);
    expect(closed.code).toBe(1013);
    expect(s1.msgs.filter(m => m.t === "error").map(m => m.code)).toEqual(["unavailable"]);
    expect(s1.msgs.some(m => m.t === "welcome")).toBe(false);
    for (const url of [urlA, urlB]) expect(await inStore(url, boardA)).toEqual({ lease: null, last: 0 });   // no lease anywhere

    // 2. Cluster A gets its own host: A's board is served and acked into A's Store only.
    const hostA = await node(urlA, "iso-a-host", "host");
    let a2;
    const end = Date.now() + TTL + 15_000;
    for (;;) {   // a client retries `unavailable`, as the real one does
      a2 = await hello(gwA, boardA, "a2");
      const got = await until(() => a2.msgs.find(m => m.t === "welcome") ?? (a2.closed ? "closed" : null), "a welcome or a close", 8_000).catch(() => "timeout");
      if (got !== "closed" && got !== "timeout") break;
      if (Date.now() > end) throw new Error("A's host never served A's board");
      a2.ws.close();
    }
    for (let k = 1; k <= 5; k++) a2.send(op("a2", k));
    await a2.next(m => m.t === "ack" && m.id === "a2:5", "ack of the last op in A", 15_000);
    expect((await inStore(urlA, boardA)).last).toBe(5);
    expect((await inStore(urlA, boardA)).lease.holder).toContain("iso-a-host");
    expect(await inStore(urlB, boardA)).toEqual({ lease: null, last: 0 });                    // B's Store never saw A's board

    // 3. The other way: B's board, served by B's node, is untouched by A's host.
    const b1 = await hello(nodeB, boardB, "b1");
    await b1.next(m => m.t === "welcome", "welcome in B", 15_000);
    for (let k = 1; k <= 3; k++) b1.send(op("b1", k));
    await b1.next(m => m.t === "ack" && m.id === "b1:3", "ack of the last op in B", 15_000);
    expect((await inStore(urlB, boardB)).last).toBe(3);
    expect((await inStore(urlB, boardB)).lease.holder).toContain("iso-b-all");
    expect(await inStore(urlA, boardB)).toEqual({ lease: null, last: 0 });
    expect(hostA.app.clusterId).toBe(gwA.app.clusterId);                                      // one database = one cluster id

    // 4. A node from before the cluster id (unscoped subjects) asks every host to open B's board and A's: nobody answers.
    const old = await natsBus({ url: NATS, name: "iso-old-node", cluster: null });
    try {
      const replies = [], probe = [];
      old.subscribe(subjects.opened("old-gw"), m => replies.push(m));                       // where an old node's answer would come
      old.subscribe(`${gwA.app.clusterId}.${subjects.opened("old-gw")}`, m => probe.push(m));   // where cluster A's answer comes
      await old.flush();
      await old.publish(subjects.open, { tenant: boardA.tenant, board: boardA.id, gateway: "old-gw", n: 1 });
      await old.publish(subjects.open, { tenant: boardB.tenant, board: boardB.id, gateway: "old-gw", n: 2 });
      // Positive control after the two unscoped opens, on the same connection: a scoped open that A's host answers.
      // Once its reply is in, the earlier unscoped opens have been through every host, so "no reply" is final.
      await old.publish(`${gwA.app.clusterId}.${subjects.open}`, { tenant: boardA.tenant, board: boardA.id, gateway: "old-gw", n: 3 });
      await until(() => probe.length === 1, "the scoped probe's answer", 10_000);
      await old.flush();
      expect(probe[0]).toMatchObject({ n: 3, board: boardA.id });
      expect(replies).toEqual([]);
      expect((await inStore(urlA, boardA)).lease.epoch).toBe(1);   // no takeover happened
      expect((await inStore(urlB, boardB)).lease.epoch).toBe(1);
    } finally { await old.close(); }
  }, 90_000);

  test("two nodes on ONE database are one cluster and share a bus scope (a gateway-only node still reaches the host)", async () => {
    const url = await newDb("s");
    const gw = await node(url, "iso-s-gw", "gateway"), host = await node(url, "iso-s-host", "host");
    expect(gw.app.clusterId).toBe(host.app.clusterId);
    const board = await mkBoard(gw);
    const end = Date.now() + TTL + 15_000;
    let s;
    for (;;) {
      s = await hello(gw, board, "s1");
      const got = await until(() => s.msgs.find(m => m.t === "welcome") ?? (s.closed ? "closed" : null), "a welcome or a close", 8_000).catch(() => "timeout");
      if (got !== "closed" && got !== "timeout") break;
      if (Date.now() > end) throw new Error("the host never served the board");
      s.ws.close();
    }
    s.send(op("s1", 1));
    await s.next(m => m.t === "ack" && m.id === "s1:1", "ack", 15_000);
  }, 60_000);
});
