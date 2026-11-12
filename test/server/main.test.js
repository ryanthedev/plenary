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
  const child = Bun.spawn([process.execPath, MAIN], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", ...env }, stdout: "pipe", stderr: "pipe" });
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
    wrong.send({ t: "hello", token: TOKEN + "-nope", board, since: 0, client: "x" });
    expect((await wrong.whenClosed()).code).toBe(1008);

    const a = await sock(`ws://127.0.0.1:${port}/ws`), v = await sock(`ws://127.0.0.1:${port}/ws`);
    a.send({ t: "hello", token: TOKEN, board, since: 0, client: "a" });
    v.send({ t: "hello", token: TOKEN + "-2", board, since: 0, client: "v" });
    expect(await a.next(m => m.t === "welcome")).toMatchObject({ role: "editor", user: "dev:ann" });
    expect(await v.next(m => m.t === "welcome")).toMatchObject({ role: "viewer", user: "dev:vic" });
    a.send({ t: "op", id: "a:1", stream: "board", op: { appState: { grid: 20 } } });
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
        s.send({ t: "hello", token: `${TOKEN}-${i}`, board, since: 0, client: "c" + i });
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
      s.send({ t: "hello", token: TOKEN, board: "b-anything", since: 0, client: "x" });
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
const connect = async (port, board, name, extra = {}) => { const s = await sock(WS(port)); s.send({ t: "hello", token: `${TOKEN}-${name}`, board, since: 0, client: name, ...extra }); return s; };
const boardOf = msgs => msgs.filter(m => m.t === "entries").flatMap(m => m.entries);

test("main.js started twice on one data dir: the same board, its acked ops, and the grants are all still there", async () => {
  const dir = tempDir();
  let a = await boot(dir, { ann: "owner", bob: "viewer" });
  let b;
  try {
    const s = await connect(a.port, a.board, "ann");
    await s.next(m => m.t === "welcome");
    for (let i = 1; i <= 5; i++) s.send({ t: "op", id: `ann:${i}`, stream: "board", op: { appState: { grid: i } } });
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
    await fresh.next(m => m.t === "entries");
    expect(boardOf(fresh.msgs).map(e => [e.seq, e.id, e.by])).toEqual([1, 2, 3, 4, 5].map(i => [i, `ann:${i}`, "dev:ann"]));
    const back = await connect(b.port, b.board, "ann", { client: "ann" });
    expect(await back.next(m => m.t === "welcome")).toMatchObject({ role: "owner" });
    // A resend of an acked op gets the same seq and is not logged again; a new op gets the next seq.
    back.send({ t: "op", id: "ann:3", stream: "board", op: { appState: { grid: 3 } } });
    back.send({ t: "op", id: "ann:6", stream: "board", op: { appState: { grid: 6 } } });
    await back.next(m => m.t === "ack" && m.id === "ann:6");
    expect(back.msgs.filter(m => m.t === "ack")).toEqual([acks[2], { t: "ack", id: "ann:6", seq: 6 }]);
    expect((await (await connect(b.port, b.board, "cy")).next(m => m.t === "welcome")).role).toBe("viewer");
    expect(await b.p.line("a dev token would demote the dev board's last owner; kept as owner")).toMatchObject({ user: "dev:ann" });
    b.p.child.kill("SIGTERM");
    expect(await b.p.child.exited).toBe(0);
    expect(a.p.out.err + b.p.out.err).toBe("");
    expect(a.p.out.text + b.p.out.text).not.toContain("S3CR3T");
  } finally { a.p.child.kill("SIGKILL"); b?.p.child.kill("SIGKILL"); }
}, 30000);

test("kill -9 mid-stream, restart: every acked op is present, at its seq, once; resends land once", async () => {
  const dir = tempDir();
  let cur = await boot(dir, { ann: "owner" });
  const board = cur.board, acked = new Map();     // op id → seq, as acknowledged by any incarnation
  let counter = 0, sent = [];
  try {
    for (let round = 0; round < 3; round++) {
      const s = await connect(cur.port, board, "ann");
      await s.next(m => m.t === "welcome");
      const record = () => { for (const m of s.msgs) if (m.t === "ack") { if (acked.has(m.id)) expect([m.id, m.seq]).toEqual([m.id, acked.get(m.id)]); acked.set(m.id, m.seq); } };
      // Resend everything sent so far (acked or not), as a reconnecting client does, then keep writing.
      for (const m of sent) s.send(m);
      const pump = setInterval(() => { for (let k = 0; k < 5; k++) { const m = { t: "op", id: `ann:${++counter}`, stream: "board", op: { appState: { grid: counter % 1000 } } }; sent.push(m); try { s.send(m); } catch { /* socket died with the server */ } } }, 2);
      const before = acked.size;
      await until(() => { record(); return acked.size >= before + 150; }, "150 more acks", 15000);
      cur.p.child.kill("SIGKILL");                // mid-stream: ops are in flight in both directions
      await cur.p.child.exited; clearInterval(pump);
      await s.whenClosed(); record();
      expect(sent.length).toBeGreaterThan(acked.size);                   // some ops really were cut off unacked
      cur = await boot(dir, { ann: "owner" });
      expect(cur.board).toBe(board);
    }
    // After the last restart: resend everything once more, then read the whole board back.
    const s = await connect(cur.port, board, "ann");
    await s.next(m => m.t === "welcome");
    for (const m of sent) s.send(m);
    await s.next(m => m.t === "ack" && m.id === sent[sent.length - 1].id, "the last resend's ack", 20000);
    for (const m of s.msgs) if (m.t === "ack" && acked.has(m.id)) expect([m.id, m.seq]).toEqual([m.id, acked.get(m.id)]);
    expect(s.msgs.some(m => m.t === "error")).toBe(false);
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
}, 90000);

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
