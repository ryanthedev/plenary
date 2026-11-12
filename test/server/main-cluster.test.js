// `bun server/main.js` as a cluster (p4-wire): three child processes on one Postgres and one NATS, roles gateway,
// gateway, host, each with its own PLENARY_DATA_DIR (so no shared local state hides a gap), serve one board end to
// end; then the host is killed -9 and a second host started: acked ops survive, writers are welcomed again within
// ttl + 3 s. Skips without DATABASE_URL and NATS_URL. A fresh database per run (main.js has no schema setting).
import { test, expect, afterAll, describe } from "bun:test";
import { SQL } from "bun";
import { tempDir, cleanup, until } from "./helpers.js";
import { sock } from "./rig.js";
import { postgresStore } from "../../server/store/postgres.js";

afterAll(cleanup);
const MAIN = new URL("../../server/main.js", import.meta.url).pathname;
const PG = process.env.DATABASE_URL, NATS = process.env.NATS_URL;
const TTL = 3_000;
const TOKEN = "S3CR3T-cluster-token";
const TOKENS = JSON.stringify({ [TOKEN]: { name: "ann", role: "owner", domain: "cluster.test", email: "ann@cluster.test", admin: true } });

function spawn(env) {
  const child = Bun.spawn([process.execPath, MAIN], { cwd: tempDir("plenary-cluster-cwd-"), env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = { text: "", err: "" };
  const pump = async (stream, key) => { const dec = new TextDecoder(); for await (const chunk of stream) out[key] += dec.decode(chunk, { stream: true }); };
  pump(child.stdout, "text"); pump(child.stderr, "err");
  const parsed = () => out.text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const line = (msg, ms = 15000) => until(() => parsed().find(l => l.msg === msg), `log line "${msg}" (stdout: ${out.text.slice(-400)} stderr: ${out.err.slice(0, 300)})`, ms);
  return { child, out, parsed, line };
}

describe.skipIf(!PG || !NATS)("cluster: three main.js processes on Postgres + NATS", () => {
  let dbUrl, dbName, admin;
  const procs = [];
  afterAll(async () => {
    for (const p of procs) { try { p.child.kill("SIGKILL"); await p.child.exited; } catch { /* gone */ } }
    if (admin) { await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {}); await admin.close(); }
  });

  async function node(id, roles) {
    const p = spawn({ DATABASE_URL: dbUrl, NATS_URL: NATS, COOKIE_KEY: "c".repeat(40), PLENARY_DEV_TOKENS: TOKENS, LOG_LEVEL: "info",
      PLENARY_NODE_ID: id, PLENARY_ROLES: roles, PLENARY_LEASE_TTL_MS: String(TTL), PLENARY_DATA_DIR: tempDir(`plenary-cluster-${id}-`) });
    procs.push(p);
    const { port } = await p.line("server listening");
    expect(await p.line("node")).toMatchObject({ node: id, cluster: true, leaseTtlMs: TTL });
    return { p, id, port, url: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
  }

  test("gateway / gateway / host serve one board end to end; kill -9 the host, start another: acked ops survive, writers welcomed within ttl + 3 s", async () => {
    admin = new SQL({ url: PG, max: 1 });
    dbName = `plen_wire_${process.pid}_${Date.now().toString(36)}`;
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const u = new URL(PG); u.pathname = "/" + dbName; dbUrl = u.toString();

    const [g1, g2, h1] = await Promise.all([node("gw-1", "gateway"), node("gw-2", "gateway"), node("host-1", "host")]);
    for (const n of [g1, g2]) expect(n.p.parsed().find(l => l.msg === "node").roles).toEqual({ gateway: true, host: false });
    expect(h1.p.parsed().find(l => l.msg === "node").roles).toEqual({ gateway: false, host: true });
    expect((await fetch(h1.url + "/ws")).status).toBe(404);
    expect((await fetch(h1.url + "/health")).status).toBe(200);

    // One board, made on gateway 1, served through both gateways.
    const res = await fetch(g1.url + "/boards", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ title: "cluster" }) });
    expect(res.status).toBe(201);
    const { board } = await res.json();

    const acked = new Map();   // op id → seq
    const record = s => { for (const m of s.msgs) if (m.t === "ack") { if (acked.has(m.id)) expect(m.seq).toBe(acked.get(m.id)); acked.set(m.id, m.seq); } };
    const op = (client, k) => ({ t: "op", id: `${client}:${k}`, sentAt: 0, stream: "board", op: { elements: [{ id: `${client}-${k}`, type: "rectangle", version: 1, versionNonce: k, x: k, y: 0, width: 1, height: 1, isDeleted: false }] } });
    const hello = (s, client) => s.send({ t: "hello", v: 1, token: TOKEN, board: board.id, since: 0, client });
    /** A writer's hello, retried on 1013 as a client retries, until `end`. */
    async function welcomed(n, client, end) {
      for (;;) {
        const s = await sock(n.ws);
        hello(s, client);
        const got = await until(() => s.msgs.find(m => m.t === "welcome") ?? (s.closed ? "closed" : null), "a welcome or a close", Math.max(1, end - Date.now())).catch(() => "timeout");
        if (got !== "closed" && got !== "timeout") return s;
        if (got === "closed") expect([s.closed.code, s.msgs.filter(m => m.t === "error").map(m => m.code)]).toEqual([1013, ["unavailable"]]);
        else s.close();
        if (Date.now() >= end) throw new Error(`${client}: no welcome in time`);
      }
    }

    const a = await welcomed(g1, "a", Date.now() + 10_000), b = await welcomed(g2, "b", Date.now() + 10_000);
    for (let k = 1; k <= 30; k++) { a.send(op("a", k)); b.send(op("b", k)); }
    await a.next(m => m.t === "ack" && m.id === "a:30", "a's last ack", 15000);
    await b.next(m => m.t === "ack" && m.id === "b:30", "b's last ack", 15000);
    record(a); record(b);
    expect(acked.size).toBe(60);
    // Each writer sees every entry, in one order (one sequencer on the host).
    const logOf = s => s.msgs.filter(m => m.t === "entries").flatMap(m => m.entries).map(e => [e.seq, e.id]);
    await until(() => new Set(logOf(a).map(x => x[0])).size === 60 && new Set(logOf(b).map(x => x[0])).size === 60, "60 entries on both", 10000);
    const sorted = s => [...new Map(logOf(s))].sort((x, y) => x[0] - y[0]);
    expect(sorted(a)).toEqual(sorted(b));
    expect(sorted(a).map(x => x[0])).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));

    // kill -9 the host mid-stream, then start another host (its own data dir and node id).
    for (let k = 31; k <= 40; k++) a.send(op("a", k));
    h1.p.child.kill("SIGKILL"); await h1.p.child.exited;
    const killedAt = Date.now();
    const h2 = await node("host-2", "host");
    const end = killedAt + TTL + 3_000;
    const a2 = await welcomed(g1, "a", end), b2 = await welcomed(g2, "b", end);
    expect(Date.now()).toBeLessThanOrEqual(end);
    record(a);
    // The client resends what it never saw acked; every resend lands once, every earlier ack keeps its seq.
    for (let k = 1; k <= 40; k++) if (!acked.has(`a:${k}`)) a2.send(op("a", k));
    b2.send(op("b", 31));
    await b2.next(m => m.t === "ack" && m.id === "b:31", "b's ack after the takeover", 10000);
    await until(() => { record(a2); return Array.from({ length: 40 }, (_, k) => `a:${k + 1}`).every(id => acked.has(id)); }, "every a op acked", 10000);
    record(b2);
    expect((await (await fetch(h2.url + "/health")).json())).toMatchObject({ rooms: 1 });

    // Read the log straight from Postgres: no gap, no op twice, every ack at its seq.
    const store = await postgresStore({ url: dbUrl, max: 1 });
    const log = [];
    try { for (;;) { const page = await store.read(board.tenant, board.id, log.length + 1, 1000); if (!page.length) break; log.push(...page); } }
    finally { await store.close(); }
    expect(log.map(e => e.seq)).toEqual(Array.from({ length: log.length }, (_, i) => i + 1));
    const seqOf = new Map(log.map(e => [e.id, e.seq]));
    expect(seqOf.size).toBe(log.length);
    expect(log.length).toBe(71);
    for (const [id, seq] of acked) expect([id, seqOf.get(id)]).toEqual([id, seq]);
    for (const p of [g1.p, g2.p, h2.p]) { expect(p.out.err).toBe(""); expect(p.out.text).not.toContain("S3CR3T"); expect(p.out.text).not.toContain(dbUrl); }
  }, 60000);
});
