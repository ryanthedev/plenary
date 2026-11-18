// The load client's guards from the p8-load3v review (p8-load4): a server that welcomes and then stalls, or drops
// everyone for good, is not VALID (finding 1); the --local server and the workers exit when run.js dies without
// stopping them (2); the server's load-phase CPU is its own window (3); empty string flags (4), non-decimal numbers
// and values past their bound (5) are refused; an ack counted twice never covers a missing one (R2).

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runWorker } from "../../scripts/load/worker.js";
import { mergeResults, buildResult, headline, exitCode, parseOptions, serverStats, dueRoles, MAX } from "../../scripts/load/run.js";
import { fakeServer } from "./fake-server.js";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
const tmp = p => mkdtempSync(join(tmpdir(), p));
const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir() });
async function cli(args) {
  const p = Bun.spawn([process.execPath, RUN, ...args], { stdout: "pipe", stderr: "pipe", env: env() });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tokensFile = (dir, n = 1) => {
  const t = {}; for (let i = 0; i < n; i++) t[`lt-g4TOK${i}`] = { name: `g${i}`, role: "editor" };
  const p = join(dir, "t.json"); writeFileSync(p, JSON.stringify(t), { mode: 0o600 }); return p;
};

// ---- finding 1: ops counted when made; a writer role due to make ops must have made some ----

const worker = counts => ({ worker: 0, pid: 1, cpu: [5], cpuLoadMean: 5, cpuLoadMs: 1000, lag: { n: 0, sum: 0, counts: [] },
  stats: { counts: { joined: 2, neverJoined: 0, clients: 2, ...counts }, closes: {}, errors: {}, hists: {}, joinsPerSec: {} } });
const judge = (counts, config, plan = { editor: 1, annotator: 1, viewer: 0 }) =>
  buildResult({ merged: mergeResults([worker(counts)]), config: { url: "ws://x", board: "b", ...config }, counts: plan, startedAt: 0, finishedAt: 1 });
const view = r => [r.ops.answered, r.complete, headline(r), exitCode(r)];

test("due roles: clients planned and rate x duration ≥ 1.5 (each client's first op comes within 1.5/rate s)", () => {
  const plan = { editor: 2, annotator: 3, viewer: 10 };
  expect(dueRoles(plan, { opRate: 2, noteRate: 0.2, commentRate: 0.05, duration: 30 })).toEqual(["editor", "annotator"]);
  expect(dueRoles(plan, { opRate: 0, noteRate: 0, commentRate: 0.05, duration: 30 })).toEqual(["annotator"]);   // comments alone
  expect(dueRoles(plan, { opRate: 1.5, noteRate: 0, commentRate: 0, duration: 1 })).toEqual(["editor"]);         // exactly 1.5
  expect(dueRoles(plan, { opRate: 1.4, noteRate: 0.2, commentRate: 0, duration: 1 })).toEqual([]);              // too short to be sure
  expect(dueRoles({ editor: 0, annotator: 0, viewer: 10 }, { opRate: 2, noteRate: 2, duration: 30 })).toEqual([]);
});

test("answered: no op made by a due role, or an op made and never sent, is INCOMPLETE (exit 1); nothing due passes", () => {
  const rates = { opRate: 2, noteRate: 0.2, commentRate: 0, duration: 30 };
  const cases = [
    // [counts, config, answered, headline]
    [{}, rates, false, "INCOMPLETE (no editor op was made though 1 editor(s) were due to (0 ops skipped offline, 0 for backlog); no annotator op was made though 1 annotator(s) were due to (0 ops skipped offline, 0 for backlog))"],
    [{ skippedOffline: 35 }, { ...rates, noteRate: 0 }, false, "INCOMPLETE (no editor op was made though 1 editor(s) were due to (35 ops skipped offline, 0 for backlog))"],
    // The editors were fine; every annotator was gone: still INCOMPLETE.
    [{ opsMade: 10, opsMade_editor: 10, opsSent: 10, acks: 10, echoes: 10 }, rates, false, "INCOMPLETE (no annotator op was made though 1 annotator(s) were due to (0 ops skipped offline, 0 for backlog))"],
    // Welcome, then no catch-up: the Replica made ops but never wrote one.
    [{ opsMade: 36, opsMade_editor: 20, opsMade_annotator: 16 }, rates, false, "INCOMPLETE (36 of 36 ops made were never acked (36 never sent); 36 of 36 were never echoed to their sender)"],
    [{ opsMade: 12, opsMade_editor: 6, opsMade_annotator: 6, opsSent: 10, acks: 10, echoes: 10 }, rates, false, "INCOMPLETE (2 of 12 ops made were never acked (2 never sent); 2 of 12 were never echoed to their sender)"],
    [{ opsMade: 12, opsMade_editor: 6, opsMade_annotator: 6, opsSent: 12, acks: 12, echoes: 12 }, rates, true, "VALID"],
    // Nothing due: --op-rate 0 and no note or comment rate (a join and fan-out run), or a plan too short to be sure.
    [{}, { opRate: 0, noteRate: 0, commentRate: 0, duration: 30 }, true, "VALID"],
    [{}, { opRate: 1, noteRate: 1, commentRate: 0, duration: 1 }, true, "VALID"],
  ];
  for (const [counts, config, answered, head] of cases) {
    const r = judge(counts, config);
    expect(view(r)).toEqual([answered, answered, head, answered ? 0 : 1]);
  }
  expect(judge({ opsMade: 36, opsMade_editor: 36 }, { ...rates, noteRate: 0 }).ops).toMatchObject({ made: { total: 36, editor: 36, annotator: 0 }, due: ["editor"], missing: [] });
});

/** A fake server for the two failure shapes p8-load3v found: "stall" (welcome with a seq it never sends catch-up
 * for) and "crash" (welcome each client once, close 1013 5 ms later, refuse every rejoin). */
function badServer(mode) {
  const seen = new Set();
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req, { data: {} }) ? undefined : new Response("ws only", { status: 400 }); },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t !== "hello") return;
        if (mode === "stall") { ws.send(JSON.stringify({ t: "welcome", user: "dev:g0", role: "editor", seq: 100, horizon: 0 })); return; }
        if (seen.size >= 3) { ws.close(1013, "busy"); return; }
        seen.add(seen.size);
        ws.send(JSON.stringify({ t: "welcome", user: "dev:g0", role: "editor", seq: 0, horizon: 0 }));
        setTimeout(() => ws.close(1013, "gone"), 5);
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => server.stop(true) };
}
async function liveRun(url, extra = []) {
  const dir = tmp("plenary-load-g4live-"), tokens = tokensFile(dir);
  const r = await cli(["--url", url, "--board", "b", "--tokens", tokens, "--editors", "3", "--ramp", "10", "--duration", "2", "--drain", "1", "--op-rate", "4", "--out", join(dir, "out"), ...extra]);
  return { ...r, res: JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) };
}

test("live CLI: a server that welcomes and then never sends catch-up headlines INCOMPLETE and exits 1", async () => {
  const s = badServer("stall");
  let r; try { r = await liveRun(s.url); } finally { s.stop(); }
  expect([r.res.clients.complete, r.res.ops.sent.total, r.res.ops.acked]).toEqual([true, 0, 0]);
  expect(r.res.ops.made.total).toBeGreaterThan(3);
  expect(r.res.ops.unanswered).toBe(r.res.ops.made.total);
  expect([r.res.ops.answered, r.res.complete, r.code]).toEqual([false, false, 1]);
  const m = r.res.ops.made.total;
  expect(r.stdout).toContain(`**INCOMPLETE (${m} of ${m} ops made were never acked (${m} never sent);`);
  expect(r.stdout + r.stderr).not.toContain("g4TOK");
}, 20000);

test("live CLI: a server that welcomes once, drops everyone and refuses rejoins headlines INCOMPLETE and exits 1", async () => {
  const s = badServer("crash");
  let r; try { r = await liveRun(s.url); } finally { s.stop(); }
  expect([r.res.clients.complete, r.res.ops.sent.total, r.res.ops.made.total, r.res.clients.connectedAtEnd]).toEqual([true, 0, 0, 0]);
  expect(r.res.ops.skippedOffline).toBeGreaterThan(3);
  expect(r.res.ops.missing).toEqual(["editor"]);
  expect([r.res.ops.answered, r.res.complete, r.code]).toEqual([false, false, 1]);
  expect(r.stdout).toContain(`**INCOMPLETE (no editor op was made though 3 editor(s) were due to (${r.res.ops.skippedOffline} ops skipped offline,`);
}, 20000);

test("live CLI: a healthy run with --op-rate 0 (no ops due) is judged on its joins: VALID, exit 0", async () => {
  const fake = fakeServer({ tokens: { "lt-g4TOK0": { user: "dev:g0", role: "editor" } } });
  let r; try { r = await liveRun(fake.url, ["--op-rate", "0"]); } finally { fake.stop(); }
  expect([r.res.ops.made.total, r.res.ops.due, r.res.clients.complete, r.res.complete, r.code]).toEqual([0, [], true, true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 20000);

// ---- R2: an ack counted twice never makes a missing ack look answered ----

test("an op acked twice counts one ack; a later op never acked keeps the run INCOMPLETE", async () => {
  const dir = tmp("plenary-load-r2-"), tokensPath = tokensFile(dir);
  // The first op: ack, ack again, then its entry (the duplicate lands while the op is still tracked). Every later op:
  // its entry only, never an ack.
  const fake = fakeServer({
    tokens: { "lt-g4TOK0": { user: "dev:g0", role: "editor" } },
    onOp(ctx, ws, msg) {
      if (ctx.opsSeen.length === 1) { ctx.ack(ws, msg.id, ctx.seq + 1); ctx.ack(ws, msg.id, ctx.seq + 1); }
      ctx.entry(ws.data.user, msg);
    },
  });
  const t0 = Date.now() + 200, cfg = { opRate: 4, noteRate: 0, commentRate: 0, cursorRate: 0, pool: 5 };
  let w;
  try {
    w = await runWorker({ url: fake.url, board: "b", tokensPath, t0, loadFrom: t0, genEndAt: t0 + 2000, drainMs: 800, clients: [{ role: "editor", token: 0, name: "g-e0", startAt: 0 }], cfg });
  } finally { fake.stop(); }
  const c = w.stats.counts;
  expect(c.opsSent).toBeGreaterThanOrEqual(2);
  expect(c.acks).toBe(1);
  expect(c.echoes).toBe(c.opsSent);
  const r = buildResult({ merged: mergeResults([w]), config: { url: "ws://x", board: "b", ...cfg, duration: 2 }, counts: { editor: 1, annotator: 0, viewer: 0 }, startedAt: 0, finishedAt: 1 });
  expect([r.ops.acked, r.ops.answered, exitCode(r)]).toEqual([1, false, 1]);
}, 15000);

// ---- finding 2: SIGKILL to run.js: the --local server and the workers exit on their own ----

test("SIGKILL to a --local run mid-load: its server and both workers exit on their own within a few seconds", async () => {
  // Killed after a progress line (the workers have their job, so their clients' timers and sockets keep them alive:
  // a worker killed before its job would end anyway, its loop empty, and prove nothing about the watch).
  const out = tmp("plenary-load-kill-");
  const p = Bun.spawn([process.execPath, RUN, "--local", "--editors", "1", "--viewers", "2", "--procs", "2", "--ramp", "10", "--duration", "60", "--out", out], { stdout: "pipe", stderr: "pipe", env: env() });
  let server = 0, workers = [];
  try {
    const reader = p.stdout.getReader(), dec = new TextDecoder(), end = Date.now() + 20000;
    let text = "";
    while (Date.now() < end) {
      const { value, done } = await reader.read(); if (done) break;
      text += dec.decode(value);
      if ((text.match(/worker pid \d+/g) ?? []).length === 2 && /t\+\d+ s: [1-9]/.test(text)) break;
    }
    reader.releaseLock();
    server = Number(/local server pid (\d+)/.exec(text)?.[1]);
    workers = [...text.matchAll(/worker pid (\d+)/g)].map(m => Number(m[1]));
    expect(server).toBeGreaterThan(0);
    expect(workers.length).toBe(2);
    for (const pid of [server, ...workers]) expect(alive(pid)).toBe(true);
    p.kill("SIGKILL");
    expect(await p.exited).toBe(137);
    const end2 = Date.now() + 4000;
    while (Date.now() < end2 && [server, ...workers].some(alive)) await Bun.sleep(50);
    expect({ server: alive(server), workers: workers.map(alive) }).toEqual({ server: false, workers: [false, false] });
  } finally {
    for (const pid of [server, ...workers]) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    if (p.exitCode === null) p.kill("SIGKILL");
  }
}, 40000);

// ---- finding 3: the server's load-phase CPU is the load window's, not the whole run's ----

test("serverStats: loadMean is the load window's CPU (idle ramp, busy load, idle drain), not the whole run's", () => {
  // One sample a second for 30 s: 0.0 CPU-s/s for the ramp (0-10 s), 0.9 for the load (10-20 s), 0.0 in the drain.
  const samples = [];
  let cpuS = 0;
  for (let s = 0; s <= 30; s++) { samples.push({ at: 1000 * s, cpuS, rssKb: 1024 * (s === 15 ? 300 : 100) }); if (s >= 10 && s < 20) cpuS += 0.9; }
  const info = serverStats(42, samples, 10000, 20000);
  expect(info.cpuPct.loadMean).toBe(90);
  expect(info.cpuPct.mean).toBe(30);
  expect(info.cpuPct.max).toBe(90);
  expect(info).toMatchObject({ pid: 42, samples: 31, rssMb: { max: 300 } });
  expect(info.cpuSeries.length).toBe(30);
});

// ---- findings 4 and 5: empty strings, non-decimal numbers and values past their bound are refused (exit 2) ----

test("arguments: plain decimals only, every value bounded, no empty string flag", () => {
  const ok = { editors: "1" };
  const refuse = (o, msg) => expect(() => parseOptions({ ...ok, ...o })).toThrow(msg);
  for (const k of ["tokens", "url", "board", "out", "rig"]) { refuse({ [k]: "" }, `--${k} is empty`); refuse({ [k]: "  " }, `--${k} is empty`); }
  refuse({ editors: "0x1" }, "--editors must be a whole number ≥ 0: 0x1");
  refuse({ editors: "1e3" }, "--editors must be a whole number ≥ 0: 1e3");
  refuse({ editors: " 5" }, "--editors must be a whole number ≥ 0:  5");
  refuse({ procs: "0b1" }, "--procs must be a whole number ≥ 1: 0b1");
  refuse({ duration: "1e12" }, "--duration must be a number ≥ 0 (plain decimal): 1e12");
  refuse({ drain: "Infinity" }, "--drain must be a number ≥ 0 (plain decimal): Infinity");
  refuse({ "op-rate": "-1" }, "--op-rate must be a number ≥ 0 (plain decimal): -1");
  refuse({ duration: "3601" }, "--duration must be ≤ 3600: 3601");
  refuse({ drain: "600.5" }, "--drain must be ≤ 600: 600.5");
  refuse({ ramp: "100001" }, "--ramp must be ≤ 100000: 100001");
  refuse({ editors: "1000001" }, "--editors must be ≤ 1000000: 1000001");
  refuse({ clients: "1000001" }, "--clients must be ≤ 1000000: 1000001");
  refuse({ viewers: "1000001" }, "--viewers must be ≤ 1000000: 1000001");
  refuse({ annotators: "1000001" }, "--annotators must be ≤ 1000000: 1000001");
  refuse({ procs: "257" }, "--procs must be ≤ 256: 257");
  refuse({ pool: "10001" }, "--pool must be ≤ 10000: 10001");
  refuse({ "viewers-per-user": "10001" }, "--viewers-per-user must be ≤ 10000: 10001");
  for (const k of ["op-rate", "note-rate", "comment-rate", "cursor-rate"]) refuse({ [k]: "1001" }, `--${k} must be ≤ 1000: 1001`);
  // At the bounds, and plain decimals: accepted.
  const p = parseOptions({ editors: "1000000", duration: "3600", drain: "600", ramp: "100000", procs: "256", "op-rate": ".5", "note-rate": "1000", pool: "10000", tokens: "t.json" });
  expect([p.counts.editor, p.duration, p.drain, p.ramp, p.procs, p.cfg.opRate, p.cfg.noteRate, p.cfg.pool]).toEqual([1000000, 3600, 600, 100000, 256, 0.5, 1000, 10000]);
  expect(Object.keys(MAX).sort()).toEqual(["annotators", "clients", "comment-rate", "cursor-rate", "drain", "duration", "editors", "note-rate", "op-rate", "pool", "procs", "ramp", "viewers", "viewers-per-user"]);
});

test("exit code 2 from the CLI: --tokens \"\", --duration 1e12, --editors 0x1 and --duration past its bound", async () => {
  // No --local: under a broken guard these fall through to the missing --url/--board error (exit 2 too, but another
  // message), so they never start a server or plan a long run.
  const cases = [
    [["--tokens", "", "--editors", "1"], "load: --tokens is empty"],
    [["--editors", "1", "--duration", "1e12"], "load: --duration must be a number ≥ 0 (plain decimal): 1e12"],
    [["--editors", "0x1"], "load: --editors must be a whole number ≥ 0: 0x1"],
    [["--editors", "1", "--duration", "99999"], "load: --duration must be ≤ 3600: 99999"],
  ];
  for (const [args, msg] of cases) {
    const r = await cli(args);
    expect([r.code, r.stderr.trim()]).toEqual([2, msg]);
  }
}, 20000);

test("--help states the bounds and the due rule", async () => {
  const r = await cli(["--help"]);
  expect(r.code).toBe(0);
  for (const s of ["--duration 1-3600 s", "--drain ≤ 600 s", "--procs 1-256", "≤ 1000000", "rate x duration >= 1.5", "plain decimal"]) expect(r.stdout).toContain(s);
}, 10000);

test("a worker whose parent is not the PID run.js named (it died before the worker started) exits mid-job", async () => {
  // The worker's own parent (this test) is alive; PLENARY_LOAD_PARENT names a process that has already exited, as
  // when run.js is SIGKILLed between spawning a worker and the worker reading its ppid.
  const dead = Bun.spawn(["true"]); await dead.exited;
  const dir = tmp("plenary-load-orphw-"), tokensPath = tokensFile(dir), t0 = Date.now() + 200;
  const job = { url: "ws://127.0.0.1:1/ws", board: "b", tokensPath, t0, loadFrom: t0, genEndAt: t0 + 60000, drainMs: 0, worker: 0,
    clients: [{ role: "editor", token: 0, name: "o-e0", startAt: 0 }], cfg: { opRate: 2, noteRate: 0, commentRate: 0, cursorRate: 0, pool: 5 } };
  let got = false;
  const w = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/load/worker.js")], {
    stdio: ["ignore", "inherit", "inherit"], serialization: "json", env: { ...env(), PLENARY_LOAD_PARENT: String(dead.pid) },
    ipc(m) { if (m.type === "ready") { w.send(job); got = true; } },
  });
  try {
    const code = await Promise.race([w.exited, Bun.sleep(5000).then(() => "still running")]);
    expect(got).toBe(true);
    expect(code).toBe(0);
  } finally { if (w.exitCode === null) w.kill("SIGKILL"); }
}, 15000);
