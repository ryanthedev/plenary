// `bun server/main.js` as a child process: it starts, logs JSON lines without secrets, serves /health and a
// socket, survives bad frames, and shuts down on SIGTERM.
import { test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanup, until } from "./helpers.js";
import { sock } from "./rig.js";
import { sqliteStore } from "../../server/store/sqlite.js";

afterAll(cleanup);
const MAIN = new URL("../../server/main.js", import.meta.url).pathname;
const TOKEN = "S3CR3T-main-token";

function spawn(env) {
  // cwd: an empty temp dir, so Bun's .env auto-load finds nothing (a checkout's .env never reaches the child).
  const child = Bun.spawn([process.execPath, MAIN], { cwd: tempDir("plenary-main-cwd-"), env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = { text: "", err: "" };
  const pump = async (stream, key) => { const dec = new TextDecoder(); for await (const chunk of stream) out[key] += dec.decode(chunk, { stream: true }); };
  pump(child.stdout, "text"); pump(child.stderr, "err");
  const lines = () => out.text.split("\n").filter(Boolean);
  const line = msg => until(() => lines().map(l => { try { return JSON.parse(l); } catch { return null; } }).find(l => l?.msg === msg), `log line "${msg}" (stderr: ${out.err.slice(0, 300)})`);
  return { child, out, lines, line };
}

test("main.js: dev tokens on: JSON logs, /health, a socket session, bad frames, clean SIGTERM", async () => {
  const dir = tempDir();
  const p = spawn({ PLENARY_DATA_DIR: dir, PLENARY_DEV_TOKENS: JSON.stringify({ [TOKEN]: { name: "ann", role: "editor" }, [TOKEN + "-2"]: { name: "vic", role: "viewer" } }) });
  try {
    const { port } = await p.line("server listening");
    const { board } = await p.line("dev tokens are ON: not for production");
    const base = `http://127.0.0.1:${port}`;
    expect((await (await fetch(base + "/health")).json()).ok).toBe(true);

    const bad = await sock(`ws://127.0.0.1:${port}/ws`);
    bad.send(`{"token":"${TOKEN}", not json`);
    expect((await bad.whenClosed()).code).toBe(1008);
    const bin = await sock(`ws://127.0.0.1:${port}/ws`);
    bin.send(new Uint8Array(2000));
    expect((await bin.whenClosed()).code).toBe(1008);
    const wrong = await sock(`ws://127.0.0.1:${port}/ws`);
    wrong.send({ t: "hello", v: 1, token: TOKEN + "-nope", board, since: 0, client: "x" });
    expect((await wrong.whenClosed()).code).toBe(1008);

    const a = await sock(`ws://127.0.0.1:${port}/ws`), v = await sock(`ws://127.0.0.1:${port}/ws`);
    a.send({ t: "hello", v: 1, token: TOKEN, board, since: 0, client: "a" });
    v.send({ t: "hello", v: 1, token: TOKEN + "-2", board, since: 0, client: "v" });
    expect(await a.next(m => m.t === "welcome")).toMatchObject({ role: "editor", user: "dev:ann" });
    expect(await v.next(m => m.t === "welcome")).toMatchObject({ role: "viewer", user: "dev:vic" });
    a.send({ t: "op", id: "a:1", sentAt: 0, stream: "board", op: { appState: { grid: 20 }, appBase: { grid: 0 } } });
    expect(await a.next(m => m.t === "ack")).toEqual({ t: "ack", id: "a:1", seq: 1 });
    expect((await v.next(m => m.t === "entries")).entries[0]).toMatchObject({ seq: 1, by: "dev:ann", op: { appState: { grid: 20 } } });
    expect((await (await fetch(base + "/health")).json())).toMatchObject({ ok: true, rooms: 1, gateway: { conns: 2 } });
    expect(existsSync(join(dir, "plenary.db"))).toBe(true);

    p.child.kill("SIGTERM");
    expect(await p.child.exited).toBe(0);
    // Every stdout line is one JSON object with time, level and msg; no token anywhere; nothing on stderr.
    const parsed = p.lines().map(l => JSON.parse(l));
    expect(parsed.length).toBeGreaterThan(5);
    for (const l of parsed) { expect(typeof l.msg).toBe("string"); expect(["debug", "info", "warn", "error"]).toContain(l.level); expect(Number.isNaN(Date.parse(l.time))).toBe(false); }
    expect(parsed.map(l => l.msg)).toContain("server stopped");
    expect(p.out.text).not.toContain("S3CR3T");
    expect(p.out.err).toBe("");
  } finally { p.child.kill("SIGKILL"); }
}, 20000);

test("main.js: two dev tokens for one user: the server starts and the highest role wins, whatever the order", async () => {
  for (const roles of [["owner", "viewer"], ["viewer", "owner"], ["editor", "owner", "annotator"]]) {
    const tokens = Object.fromEntries(roles.map((role, i) => [`${TOKEN}-${i}`, { name: "sam", role }]));
    const p = spawn({ PLENARY_DATA_DIR: tempDir(), PLENARY_DEV_TOKENS: JSON.stringify(tokens) });
    try {
      const { port } = await p.line("server listening");
      const { board, users } = await p.line("dev tokens are ON: not for production");
      expect(users).toBe(1);
      for (let i = 0; i < roles.length; i++) {
        const s = await sock(`ws://127.0.0.1:${port}/ws`);
        s.send({ t: "hello", v: 1, token: `${TOKEN}-${i}`, board, since: 0, client: "c" + i });
        expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "owner", user: "dev:sam" });
      }
      expect(p.out.err).toBe("");
      expect(p.out.text).not.toContain("S3CR3T");
    } finally { p.child.kill("SIGKILL"); await p.child.exited; }
  }
}, 20000);

test("main.js: without dev tokens every hello is refused (off by default), and a bad PLENARY_DEV_TOKENS doesn't turn them on", async () => {
  for (const env of [{}, { PLENARY_DEV_TOKENS: `{"${TOKEN}": oops` }, { PLENARY_DEV_TOKENS: `["${TOKEN}"]` }]) {
    const p = spawn({ PLENARY_DATA_DIR: tempDir(), ...env });
    try {
      const { port } = await p.line("server listening");
      const s = await sock(`ws://127.0.0.1:${port}/ws`);
      s.send({ t: "hello", v: 1, token: TOKEN, board: "b-anything", since: 0, client: "x" });
      expect((await s.whenClosed()).code).toBe(1008);
      expect(s.msgs).toEqual([{ t: "error", code: "auth", message: "not allowed" }]);
      expect(p.out.text).not.toContain("S3CR3T");
    } finally { p.child.kill("SIGKILL"); await p.child.exited; }
  }
}, 20000);

// ---- the durable Registry: the board and its ops survive a restart ----

const WS = port => `ws://127.0.0.1:${port}/ws`;
const devTokens = roles => JSON.stringify(Object.fromEntries(Object.entries(roles).map(([name, role]) => [`${TOKEN}-${name}`, { name, role }])));
async function boot(dir, roles) {
  const p = spawn({ PLENARY_DATA_DIR: dir, PLENARY_DEV_TOKENS: devTokens(roles) });
  const { port } = await p.line("server listening");
  const { board, tenant } = await p.line("dev tokens are ON: not for production");
  return { p, port, board, tenant };
}
const connect = async (port, board, name, extra = {}) => { const s = await sock(WS(port)); s.send({ t: "hello", v: 1, token: `${TOKEN}-${name}`, board, since: 0, client: name, ...extra }); return s; };

test("main.js started twice on one data dir: the same board, its acked ops, and the grants are all still there", async () => {
  const dir = tempDir();
  let a = await boot(dir, { ann: "owner", bob: "viewer" });
  let b;
  try {
    const s = await connect(a.port, a.board, "ann");
    await s.next(m => m.t === "welcome");
    for (let i = 1; i <= 5; i++) s.send({ t: "op", id: `ann:${i}`, sentAt: 0, stream: "board", op: { appState: { grid: i }, appBase: { grid: i - 1 } } });   // v1.1: each settings op names the appSeq it was based on
    await s.next(m => m.t === "ack" && m.id === "ann:5");
    const acks = s.msgs.filter(m => m.t === "ack");
    a.p.child.kill("SIGTERM");
    expect(await a.p.child.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "dev-board.json"), "utf8"))).toEqual({ board: a.board });

    // Second start: ann's token now says editor (she stays owner: the board keeps its last owner), bob is promoted.
    b = await boot(dir, { ann: "editor", bob: "annotator", cy: "viewer" });
    expect([b.board, b.tenant]).toEqual([a.board, a.tenant]);
    const fresh = await connect(b.port, b.board, "bob");
    expect(await fresh.next(m => m.t === "welcome")).toMatchObject({ seq: 5, role: "annotator", user: "dev:bob" });
    // A clean stop wrote a checkpoint at seq 5, so catch-up from 0 is a snapshot (the log is checked from the file below).
    expect(await fresh.next(m => m.t === "snapshot" || m.t === "entries")).toMatchObject({ t: "snapshot", seq: 5, appSeq: { board: { grid: 5 } }, streams: { board: { appState: { herdr: { grid: 5 } } } } });
    const back = await connect(b.port, b.board, "ann", { client: "ann" });
    expect(await back.next(m => m.t === "welcome")).toMatchObject({ role: "owner" });
    // A resend of an acked op gets the same seq and is not logged again; a new op gets the next seq.
    back.send({ t: "op", id: "ann:3", sentAt: 0, stream: "board", op: { appState: { grid: 3 }, appBase: { grid: 2 } } });
    back.send({ t: "op", id: "ann:6", sentAt: 0, stream: "board", op: { appState: { grid: 6 }, appBase: { grid: 5 } } });
    await back.next(m => m.t === "ack" && m.id === "ann:6");
    expect(back.msgs.filter(m => m.t === "ack")).toEqual([acks[2], { t: "ack", id: "ann:6", seq: 6 }]);
    expect((await (await connect(b.port, b.board, "cy")).next(m => m.t === "welcome")).role).toBe("viewer");
    expect(await b.p.line("a dev token would demote the dev board's last owner; kept as owner")).toMatchObject({ user: "dev:ann" });
    b.p.child.kill("SIGTERM");
    expect(await b.p.child.exited).toBe(0);
    const store = sqliteStore({ path: join(dir, "plenary.db") });
    const log = await store.read(b.tenant, b.board, 1, 100);
    await store.close();
    expect(log.map(e => [e.seq, e.id, e.by])).toEqual([1, 2, 3, 4, 5, 6].map(i => [i, `ann:${i}`, "dev:ann"]));
    expect(a.p.out.err + b.p.out.err).toBe("");
    expect(a.p.out.text + b.p.out.text).not.toContain("S3CR3T");
  } finally { a.p.child.kill("SIGKILL"); b?.p.child.kill("SIGKILL"); }
}, 30000);

// A kill -9 leaves the dead process's room lease live for up to its ttl (room-host leaseTtlMs, 10 s by default): a
// writer's hello in that window is answered `unavailable` (1013) or times out at the gateway, and the client retries,
// as a real client does. Anything else is a failure, and so is no welcome within the ttl + 3 s.
const LEASE_TTL_MS = 10_000;
async function welcomedAfterRestart(port, board, name) {
  const end = Date.now() + LEASE_TTL_MS + 3_000;
  for (;;) {
    const s = await connect(port, board, name);
    const got = await until(() => s.msgs.find(m => m.t === "welcome") ?? (s.closed ? "closed" : null), "a welcome or a close", Math.max(1, end - Date.now())).catch(() => "timeout");
    if (got !== "closed" && got !== "timeout") return s;
    if (got === "closed") {
      expect(s.closed.code).toBe(1013);
      expect(s.msgs.filter(m => m.t === "error").map(m => m.code)).toEqual(["unavailable"]);
    } else s.close();
    if (Date.now() >= end) throw new Error(`no welcome within the lease ttl + 3 s (${LEASE_TTL_MS + 3_000} ms)`);
  }
}

test("kill -9 mid-stream, restart: every acked op is present, at its seq, once; resends land once", async () => {
  const dir = tempDir();
  let cur = await boot(dir, { ann: "owner" });
  const board = cur.board, acked = new Map();     // op id → seq, as acknowledged by any incarnation
  let counter = 0;
  const sent = [];
  // The gateway paces ops at 20/s (burst 100) and queues the rest, up to 500 per connection (PROTOCOL.md § Pacing):
  // keep at most 200 unacked so the queue never overflows, and resend what a reconnecting client resends (its
  // unacked ops) plus a sample of acked ones from inside the room's op-id window (the latest W = 256 counters per
  // client, § Op ids): each must come back with its first seq, not be logged again.
  const MAX_UNACKED = 200, unacked = () => sent.filter(m => !acked.has(m.id));
  const counterOf = m => Number(m.id.split(":")[1]);
  const resends = () => { const top = Math.max(0, ...sent.filter(m => acked.has(m.id)).map(counterOf)); const done = sent.filter(m => acked.has(m.id) && counterOf(m) > top - 200), step = Math.max(1, Math.floor(done.length / 30)); const sample = new Set(done.filter((_, i) => i % step === 0)); return sent.filter(m => sample.has(m) || !acked.has(m.id)); };
  const op = n => ({ t: "op", id: `ann:${n}`, sentAt: 0, stream: "board", op: { elements: [{ id: "tick", type: "rectangle", version: n, versionNonce: n, x: n % 1000, y: 0, width: 1, height: 1, isDeleted: false }] } });
  try {
    for (let round = 0; round < 3; round++) {
      // Round 0 is a fresh boot: a plain welcome. Only after a kill does the client retry (L8).
      const s = round === 0 ? await connect(cur.port, board, "ann") : await welcomedAfterRestart(cur.port, board, "ann");
      if (round === 0) await s.next(m => m.t === "welcome");
      const record = () => { for (const m of s.msgs) if (m.t === "ack") { if (acked.has(m.id)) expect([m.id, m.seq]).toEqual([m.id, acked.get(m.id)]); acked.set(m.id, m.seq); } };
      for (const m of resends()) s.send(m);
      const pump = setInterval(() => { record(); for (let k = 0; k < 5 && unacked().length < MAX_UNACKED; k++) { const m = op(++counter); sent.push(m); try { s.send(m); } catch { /* socket died with the server */ } } }, 5);
      const before = acked.size;
      await until(() => { record(); return acked.size >= before + 150; }, "150 more acks", 15000);
      cur.p.child.kill("SIGKILL");                // mid-stream: ops are in flight in both directions
      await cur.p.child.exited; clearInterval(pump);
      await s.whenClosed(); record();
      expect(sent.length).toBeGreaterThan(acked.size);                   // some ops really were cut off unacked
      cur = await boot(dir, { ann: "owner" });
      expect(cur.board).toBe(board);
    }
    // After the last restart: resend once more (every unacked op and the sample), then read the whole board back.
    // ann:1 is far below the window: it is answered `stale` (not logged now), never acked with a guess or logged twice.
    const s = await welcomedAfterRestart(cur.port, board, "ann");
    const last = resends();
    expect(last.some(m => acked.has(m.id))).toBe(true);
    for (const m of [sent[0], ...last]) s.send(m);
    await s.next(m => m.t === "ack" && m.id === last[last.length - 1].id, "the last resend's ack", 30000);
    for (const m of last) if (acked.has(m.id)) expect(s.msgs.find(x => x.t === "ack" && x.id === m.id)).toEqual({ t: "ack", id: m.id, seq: acked.get(m.id) });
    expect(s.msgs.filter(m => m.t === "error")).toEqual([{ t: "error", id: "ann:1", code: "stale", message: expect.any(String) }]);
    // Stop cleanly and read the log straight from the database file (a client would get a folded snapshot).
    cur.p.child.kill("SIGTERM");
    expect(await cur.p.child.exited).toBe(0);
    const store = sqliteStore({ path: join(dir, "plenary.db") }), log = [];
    for (;;) { const page = await store.read(cur.tenant, board, log.length + 1, 5000); if (!page.length) break; log.push(...page); }
    await store.close();
    const seq = log.length;
    expect(log.map(e => e.seq)).toEqual(Array.from({ length: seq }, (_, i) => i + 1));    // no gap, no reuse
    const seqOf = new Map(log.map(e => [e.id, e.seq]));
    expect(seqOf.size).toBe(log.length);                                                  // no op logged twice
    expect(seqOf.size).toBe(sent.length);                                                 // every resend landed, once
    // No count threshold: how many acks beat each kill is timing. What must hold is durability, below.
    expect(acked.size).toBeGreaterThanOrEqual(450);                                       // true by construction (150 a round)
    for (const [id, at] of acked) expect([id, seqOf.get(id)]).toEqual([id, at]);          // every acked op, at its acked seq
  } finally { cur.p.child.kill("SIGKILL"); }
}, 150000);   // up to three lease waits (ttl + 3 s each) on top of the run

test("main.js: PLENARY_MAX_CONNS_PER_USER sets the per-user connection cap", async () => {
  const p = spawn({ PLENARY_DATA_DIR: tempDir(), PLENARY_DEV_TOKENS: devTokens({ ann: "editor" }), PLENARY_MAX_CONNS_PER_USER: "2" });
  try {
    const { port } = await p.line("server listening");
    const { board } = await p.line("dev tokens are ON: not for production");
    for (let i = 0; i < 2; i++) await (await connect(port, board, "ann", { client: "c" + i })).next(m => m.t === "welcome");
    const third = await connect(port, board, "ann", { client: "c2" });
    expect((await third.whenClosed()).code).toBe(1013);
    expect(third.msgs[0]).toMatchObject({ t: "error", code: "unavailable" });
  } finally { p.child.kill("SIGKILL"); await p.child.exited; }
}, 20000);

// ---- start(env) in process: HTTP routes, sign-in config, env isolation (brief p2-swap) ----
import { start } from "../../server/main.js";

const devEnv = (dir, extra = {}) => ({ PLENARY_DATA_DIR: dir, PORT: "0", LOG_LEVEL: "error", PLENARY_DEV_TOKENS: JSON.stringify({ [TOKEN]: { name: "ann", role: "editor", domain: "acme.test", email: "ann@acme.test" } }), ...extra });

test("start(env): POST /boards with a dev Bearer token makes a board a socket can join; /health and /ws stay the engine's; no Google → /auth 503", async () => {
  // Whatever this checkout's process.env holds (Bun loads .env), start() reads only its argument.
  const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  process.env.GOOGLE_CLIENT_ID = "from-process-env"; process.env.GOOGLE_CLIENT_SECRET = "from-process-env";
  const app = await start(devEnv(tempDir()));
  try {
    expect(app.oidc).toBe(null);
    const t = await app.registry.createTenant({ domain: "acme.test", admins: ["dev:ann"] });
    const res = await fetch(app.server.url + "/boards", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ title: "all hands" }) });
    expect(res.status).toBe(201);
    const { board } = await res.json();
    expect(board).toMatchObject({ tenant: t.id });
    const s = await sock(app.server.wsUrl);
    s.send({ t: "hello", v: 1, token: TOKEN, board: board.id, since: 0, client: "ann" });
    expect(await s.next(m => m.t === "welcome")).toMatchObject({ role: "owner", user: "dev:ann", room: { board: board.id, epoch: 1 } });
    await s.close();
    expect((await fetch(app.server.url + "/health")).status).toBe(200);
    expect((await fetch(app.server.url + "/ws")).status).toBe(426);
    expect((await fetch(app.server.url + "/auth/login", { redirect: "manual" })).status).toBe(503);
  } finally {
    await app.stop();
    for (const [k, v] of [["GOOGLE_CLIENT_ID", saved.id], ["GOOGLE_CLIENT_SECRET", saved.secret]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("start(env): fake Google client vars build the OIDC adapter (stub fetch, never the real client); /auth/login no longer 503", async () => {
  const calls = [];
  const fetchStub = async url => { calls.push(String(url)); return new Response("{}", { status: 500 }); };
  const app = await start(devEnv(tempDir(), { GOOGLE_CLIENT_ID: "fake-id.apps.example", GOOGLE_CLIENT_SECRET: "fake-secret", COOKIE_KEY: "k".repeat(32), OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback" }), { fetch: fetchStub });
  try {
    expect(app.oidc).not.toBe(null);
    const res = await fetch(app.server.url + "/auth/login", { redirect: "manual" });
    expect(res.status).not.toBe(503);
    expect(calls.every(u => !u.includes("fake-secret"))).toBe(true);
  } finally { await app.stop(); }
});

test("start(env): COOKIE_KEY: refused when short; required in cluster mode; random (with a warning) on a single node", async () => {
  await expect(start(devEnv(tempDir(), { COOKIE_KEY: "short" }))).rejects.toThrow(/COOKIE_KEY/);
  await expect(start(devEnv(tempDir(), { DATABASE_URL: "postgres://x@127.0.0.1:1/x" }))).rejects.toThrow(/cluster/);
  await expect(start(devEnv(tempDir(), { NATS_URL: "nats://127.0.0.1:1" }))).rejects.toThrow(/cluster/);
  const app = await start(devEnv(tempDir()));
  expect(app.server.port).toBeGreaterThan(0);
  await app.stop();
});

test("revocation: a grant change through the Registry closes a connection that lost its role", async () => {
  const app = await start(devEnv(tempDir()));
  try {
    await app.registry.createTenant({ domain: "acme.test", admins: ["dev:ann"] });
    const res = await fetch(app.server.url + "/boards", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ memberRole: null }) });
    const { board } = await res.json();
    await app.registry.setGrant(board.id, "dev:bob", "owner");          // a second owner, so ann may be removed
    const s = await sock(app.server.wsUrl);
    s.send({ t: "hello", v: 1, token: TOKEN, board: board.id, since: 0, client: "ann" });
    await s.next(m => m.t === "welcome");
    await app.registry.setGrant(board.id, "dev:ann", null);             // memberRole is null: no role left
    expect((await s.whenClosed()).code).toBe(1008);
    expect(s.msgs.at(-1)).toMatchObject({ t: "error", code: "auth" });
    // A lowered role (still some role) closes too, with `unavailable`, so the client rejoins with the new one.
    const t2 = await sock(app.server.wsUrl);
    await app.registry.setGrant(board.id, "dev:ann", "editor");
    t2.send({ t: "hello", v: 1, token: TOKEN, board: board.id, since: 0, client: "ann2" });
    expect(await t2.next(m => m.t === "welcome")).toMatchObject({ role: "editor" });
    await app.registry.setGrant(board.id, "dev:ann", "viewer");
    expect((await t2.whenClosed()).code).toBe(1012);
    expect(t2.msgs.at(-1)).toMatchObject({ t: "error", code: "unavailable" });
  } finally { await app.stop(); }
});
