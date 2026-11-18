// The load client counts each thing once, measured by its real code paths: against a scripted fake server
// (test/load/fake-server.js) for reconnects, rejoins, resent ops, catch-up and the drain; and with the worker's
// real lag and CPU samplers for saturation. (p8-load2: findings 2-8 of the p8-loadv review.)

import { test, expect, afterAll } from "bun:test";
import { tmp, cleanTmp } from "./tmp.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoadClient } from "../../scripts/load/client.js";
import { Stats, runWorker } from "../../scripts/load/worker.js";
import { mergeResults, buildResult, createBoard, fdCheck, exitCode, headline, planCounts, run, LAG_P99_LIMIT_MS, CPU_MEAN_LIMIT } from "../../scripts/load/run.js";
import { startServer } from "../../scripts/load/server.js";
import { makeElement } from "../../packages/core/model.js";
import { fakeServer, until, busyFrom } from "./fake-server.js";
import { Hist } from "../../scripts/load/stats.js";

afterAll(cleanTmp);

// ---- counted once: reconnect, rejoin, resend (V1, V4, V13) ----

test("a dropped writer reconnects once, rejoins once, and its resent op is counted as one op sent", async () => {
  // The first copy of each op is met by a dropped connection (no ack, no entry); the resend is applied.
  const fake = fakeServer({
    tokens: { tE: { user: "dev:e", role: "editor" } },
    onOp(ctx, ws, msg) { if (ctx.opsSeen.filter(id => id === msg.id).length === 1) ws.close(4000, "test drop"); else ctx.apply(ws, msg); },
  });
  const stats = new Stats(Date.now());
  const c = new LoadClient({ url: fake.url, board: "b", token: "tE", role: "editor", name: "t-e0", cfg: { pool: 5 }, stats });
  try {
    c.connect();
    await until(() => c.welcomed, 5000, "first welcome");
    c.draw("board");
    await until(() => stats.counts.echoes === 1 && stats.counts.acks === 1, 8000, "echo and ack of the resent op");
  } finally { c.close(); fake.stop(); }
  // The server saw the same op id twice: the resend really happened.
  expect(fake.opsSeen.length).toBe(2);
  expect(fake.opsSeen[0]).toBe(fake.opsSeen[1]);
  expect(stats.counts).toMatchObject({ connects: 2, hellos: 2, welcomes: 2, joined: 1, rejoins: 1, reconnects: 1, opsSent: 1, opsSent_editor: 1, acks: 1, echoes: 1 });
  expect(stats.closes["4000"]).toBe(1);
  expect(stats.hists["echo.editor"].n).toBe(1);
  expect(stats.hists["ack.editor"].n).toBe(1);
  expect(stats.hists.join.n).toBe(2);   // every welcome's latency; joined counts only the first
  expect(stats.joinsPerSec[0] ?? 0).toBe(1);
}, 15000);

// ---- catch-up is not delivery (V5) ----

test("entries a client catches up on are not delivery samples; a live one after the welcome is", async () => {
  const fake = fakeServer({ tokens: { tV: { user: "dev:v", role: "viewer" } } });
  const stamped = (id, lt) => ({ id, stream: "board", op: { elements: [{ ...makeElement("rectangle", { id, x: 0, y: 0, width: 10, height: 10 }), customData: { lt } }] } });
  // Two ops already on the board before the viewer comes: catch-up.
  fake.entry("dev:other", stamped("old1", Date.now() - 5000));
  fake.entry("dev:other", stamped("old2", Date.now() - 4000));
  const stats = new Stats(Date.now());
  const c = new LoadClient({ url: fake.url, board: "b", token: "tV", role: "viewer", name: "t-v0", cfg: { pool: 5 }, stats });
  try {
    c.connect();
    await until(() => c.replica.applied === 2, 5000, "catch-up applied");
    expect(stats.hists["delivery.viewer"]?.n ?? 0).toBe(0);
    fake.entry("dev:other", stamped("live1", Date.now()));
    await until(() => c.replica.applied === 3, 5000, "live entry applied");
  } finally { c.close(); fake.stop(); }
  const d = stats.hists["delivery.viewer"];
  expect(d.n).toBe(1);
  expect(d.max).toBeLessThan(1000);   // the live one, not a 4-5 s old catch-up entry
}, 15000);

// ---- the drain waits for acks; unacked is reported (M12, V10) ----

test("the drain waits out an ack held after the entry, and reports ops never acked as unacked", async () => {
  // The editor's acks come 800 ms after its entries; the annotator's never come. Both are echoed at once.
  const tokensPath = join(tmp("plenary-load-drain-"), "t.json");
  writeFileSync(tokensPath, JSON.stringify({ tE: { name: "w-e", role: "editor" }, tA: { name: "w-a", role: "annotator" } }), { mode: 0o600 });
  const fake = fakeServer({
    tokens: { tE: { user: "dev:w-e", role: "editor" }, tA: { user: "dev:w-a", role: "annotator" } },
    onOp(ctx, ws, msg) {
      const e = ctx.entry(ws.data.user, msg);
      if (ws.data.role === "editor") setTimeout(() => ctx.ack(ws, msg.id, e.seq), 800);
    },
  });
  const t0 = Date.now() + 200, drainMs = 2500;
  let r;
  try {
    r = await runWorker({
      url: fake.url, board: "b", tokensPath, t0, loadFrom: t0, genEndAt: t0 + 2500, drainMs,
      clients: [{ role: "editor", token: 0, name: "w-e0", startAt: 0 }, { role: "annotator", token: 0, name: "w-a0", startAt: 0 }],
      cfg: { opRate: 4, noteRate: 4, commentRate: 0, cursorRate: 0, pool: 5 },
    });
  } finally { fake.stop(); }
  const c = r.stats.counts;
  expect(c.opsSent_editor).toBeGreaterThan(3);
  expect(c.opsSent_annotator).toBeGreaterThan(3);
  expect(c.echoes).toBe(c.opsSent);
  expect(c.unechoed).toBe(0);
  expect(c.acks).toBe(c.opsSent_editor);          // the held acks arrived during the drain and were counted
  expect(c.unacked).toBe(c.opsSent_annotator);    // exactly the ops never acked
  expect(c.drainMs).toBeGreaterThanOrEqual(drainMs - 50);   // it waited the whole drain for them
  expect(c.drainMs).toBeLessThan(drainMs + 1000);           // and the drain only: from t0 it would be ~5.2 s
}, 15000);

// ---- saturation, measured by the worker's own samplers (V11, V12, finding 8) ----

const noTokens = () => { const p = join(tmp("plenary-load-sat-"), "t.json"); writeFileSync(p, "{}", { mode: 0o600 }); return p; };
const judge = r => buildResult({ merged: mergeResults([r]), config: { url: "ws://x", board: "b" }, counts: { editor: 0, annotator: 0, viewer: 1 }, startedAt: 0, finishedAt: 1 });

// Burn this process from `from` to `to` (wall clock): `chunk` ms busy, then yield for `gap` ms.
function burn(from, to, chunk, gap) {
  return new Promise(done => {
    const step = () => {
      if (Date.now() >= to) return done();
      const end = performance.now() + chunk; while (performance.now() < end) { /* busy */ }
      gap ? setTimeout(step, gap) : setImmediate(step);
    };
    setTimeout(step, Math.max(0, from - Date.now()));
  });
}

test("a worker whose event loop stalls is flagged by its lag sampler (not by CPU)", async () => {
  const t0 = Date.now(), genEndAt = t0 + 2500;
  const [r] = await Promise.all([
    runWorker({ url: "ws://127.0.0.1:1/ws", board: "b", tokensPath: noTokens(), t0, loadFrom: t0, genEndAt, drainMs: 0, clients: [], cfg: {} }),
    burn(t0 + 100, genEndAt, 160, 240),   // 160 ms blocks, 40% busy
  ]);
  const res = judge(r);
  expect(res.valid).toBe(false);
  expect(res.invalidReasons.length).toBe(1);
  expect(res.invalidReasons[0]).toMatch(/^worker 0: event-loop lag p99 [\d.]+ ms > 100 ms$/);
  expect(res.generator.workers[0].lagMs.p99).toBeGreaterThan(LAG_P99_LIMIT_MS);
}, 15000);

test("a worker pinned during the load phase only is flagged by its CPU sampler, though its whole-run mean is low", async () => {
  // Ramp 2 s idle, then 4 s of load with the process at 100% of a core (a modelled cpuUsage: no real burning, so the
  // result cannot depend on how busy this machine is).
  const t0 = Date.now(), loadFrom = t0 + 2000, genEndAt = loadFrom + 4000;
  const r = await runWorker({ url: "ws://127.0.0.1:1/ws", board: "b", tokensPath: noTokens(), t0, loadFrom, genEndAt, drainMs: 0, clients: [], cfg: {} }, { cpuUsage: busyFrom(loadFrom) });
  expect(r.cpuLoad.length).toBeGreaterThanOrEqual(1);
  r.lag = new Hist().toJSON();   // the event loop's lag is the machine's, not under test here
  const res = judge(r), w = res.generator.workers[0];
  expect(w.cpuPct.meanAllPhases).toBeLessThan(CPU_MEAN_LIMIT);   // averaged with the idle ramp it would pass
  expect(w.cpuPct.mean).toBeGreaterThan(CPU_MEAN_LIMIT);
  expect(res.valid).toBe(false);
  expect(res.invalidReasons).toEqual([`worker 0: CPU mean ${w.cpuPct.mean}% of a core > ${CPU_MEAN_LIMIT}%`]);
}, 15000);

test("a quiet worker's own samplers say it is fine", async () => {
  const t0 = Date.now();
  const r = await runWorker({ url: "ws://127.0.0.1:1/ws", board: "b", tokensPath: noTokens(), t0, loadFrom: t0, genEndAt: t0 + 1500, drainMs: 0, clients: [], cfg: {} });
  const res = judge(r);
  expect(res.valid).toBe(true);
  expect(r.cpu.length).toBeGreaterThanOrEqual(1);
}, 10000);

// ---- the open-file check (V7) ----

test("fdCheck refuses more clients per worker than one process may open, and names the limits", () => {
  const mac = { hard: "unlimited", kernel: 245760, kernelName: "kern.maxfilesperproc" };
  expect(fdCheck(1000, mac)).toMatchObject({ ok: true, need: 1256, limit: 245760 });
  const big = fdCheck(250001, mac);
  expect(big.ok).toBe(false);
  expect(big.message).toContain("each worker needs ~250257 open files (250001 clients + 256) but one process may open at most 245760 here (the lower of ulimit -Hn unlimited and kern.maxfilesperproc 245760)");
  expect(big.message).not.toContain("hard limit is");
  const low = fdCheck(1000, { hard: "512", kernel: Infinity, kernelName: null });
  expect(low).toMatchObject({ ok: false, limit: 512, need: 1256 });
  expect(low.message).toContain("at most 512 here (the lower of ulimit -Hn 512)");
  expect(fdCheck(1e12).ok).toBe(false);   // this machine's real limits
});

// ---- a run nobody (or not everybody) joined is not VALID and exits non-zero (finding 7) ----

test("headline and exit code: VALID and 0 only when the generator was fine and every planned client joined", () => {
  const ops = { sent: { total: 0 }, acked: 0, echoed: { total: 0 }, answered: true };
  const r = (valid, planned, joined) => ({ valid, complete: planned > 0 && joined === planned, clients: { planned, joined, complete: planned > 0 && joined === planned }, ops });
  expect([headline(r(true, 4, 4)), exitCode(r(true, 4, 4))]).toEqual(["VALID", 0]);
  expect([headline(r(true, 4, 3)), exitCode(r(true, 4, 3))]).toEqual(["INCOMPLETE (1 of 4 planned clients never joined)", 1]);
  expect([headline(r(true, 1, 0)), exitCode(r(true, 1, 0))]).toEqual(["INCOMPLETE (1 of 1 planned clients never joined)", 1]);
  expect(exitCode(r(false, 4, 4))).toBe(1);
  expect(headline(r(false, 4, 0))).toStartWith("INVALID");
  // buildResult sets complete from the counts.
  const m = mergeResults([{ worker: 0, pid: 1, cpu: [], cpuLoadMean: 10, cpuLoadMs: 1000, lag: { n: 0, sum: 0, counts: [] }, stats: { counts: { joined: 2, neverJoined: 1, clients: 3 }, closes: {}, errors: {}, hists: {}, joinsPerSec: {} } }]);
  const res = buildResult({ merged: m, config: { url: "ws://x", board: "b" }, counts: { editor: 1, annotator: 0, viewer: 2 }, startedAt: 0, finishedAt: 1 });
  expect(res.clients).toMatchObject({ planned: 3, joined: 2, neverJoined: 1, complete: false });
  expect(res.valid).toBe(true);
  expect(exitCode(res)).toBe(1);
});

test("live CLI: a URL nobody answers headlines INCOMPLETE and exits 1", async () => {
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") }); const port = dead.port; dead.stop(true);
  const dir = tmp("plenary-load-dead-"), tokens = join(dir, "t.json");
  writeFileSync(tokens, JSON.stringify({ "lt-deadTOKENxyz": { name: "d-e", role: "editor" } }), { mode: 0o600 });
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/load/run.js"), "--url", `ws://127.0.0.1:${port}/ws`, "--board", "b", "--tokens", tokens, "--editors", "1", "--ramp", "10", "--duration", "1", "--drain", "0"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(1);
  expect(stdout).toContain("**INCOMPLETE (1 of 1 planned clients never joined)** · 0/1 clients joined");
  expect(stdout).not.toContain("**VALID**");
  expect(stdout).not.toContain("lt-deadTOKENxyz");
}, 20000);

// ---- arguments (findings 9, 10) ----

test("arguments: --ramp 0 and fractional counts are refused before anything starts", async () => {
  expect(() => planCounts({ editors: "1.5" })).toThrow("--editors must be a whole number ≥ 0: 1.5");
  expect(() => planCounts({ clients: "100.5" })).toThrow(/--clients must be a whole number/);
  expect(() => planCounts({ viewers: "-1" })).toThrow(/--viewers must be a whole number/);
  expect(planCounts({ editors: "2", viewers: "3" })).toEqual({ editor: 2, annotator: 0, viewer: 3 });
  const base = { local: true, editors: "1", duration: "1" };
  await expect(run({ ...base, ramp: "0" }, { log: () => {} })).rejects.toThrow("--ramp must be ≥ 1 client/s: 0");
  await expect(run({ ...base, procs: "1.5" }, { log: () => {} })).rejects.toThrow(/--procs must be a whole number ≥ 1/);
  await expect(run({ ...base, procs: "0" }, { log: () => {} })).rejects.toThrow(/--procs must be a whole number ≥ 1/);
  await expect(run({ ...base, pool: "2.5" }, { log: () => {} })).rejects.toThrow(/--pool must be a whole number ≥ 1/);
  await expect(run({ local: true, editors: "0" }, { log: () => {} })).rejects.toThrow(/no clients planned/);
});

// ---- a tokens file the server would reject (finding 13) ----

test("a bad tokens file fails at once with its path only; a server that rejects tokens is reported, not waited on", async () => {
  const dir = tmp("plenary-load-badtok-");
  const arr = join(dir, "array.json"), trunc = join(dir, "trunc.json");
  writeFileSync(arr, JSON.stringify(["lt-secretAAAA", "lt-secretBBBB"]), { mode: 0o600 });
  writeFileSync(trunc, '{"lt-secretCCCC": {"name": "x"', { mode: 0o600 });
  const t = Date.now();
  const e1 = await run({ local: true, tokens: arr, editors: "1", duration: "1" }, { log: () => {} }).catch(e => e);
  expect(e1.message).toBe(`tokens file ${arr} is not a JSON object of token → { name, role }`);
  const e2 = await run({ local: true, tokens: trunc, editors: "1", duration: "1" }, { log: () => {} }).catch(e => e);
  expect(e2.message).toBe(`tokens file ${trunc} is not valid JSON`);
  expect(Date.now() - t).toBeLessThan(3000);
  // The server's own refusal (startServer used directly, as by a test or a rig): ended by the log line.
  const t2 = Date.now();
  const e3 = await startServer({ tokensPath: arr, timeoutMs: 20000 }).catch(e => e);
  expect(e3.message).toBe(`the server rejected the tokens file ${arr}: "PLENARY_DEV_TOKENS is not a JSON object; dev tokens stay off"`);
  expect(Date.now() - t2).toBeLessThan(10000);
  for (const e of [e1, e2, e3]) expect(e.message).not.toContain("lt-secret");
}, 30000);

// ---- --create-board echoes only a code-shaped error (finding 11) ----

test("createBoard: a refused POST /boards reports status and a code, never the server's free text", async () => {
  const dir = tmp("plenary-load-cb-"), tokens = join(dir, "t.json");
  writeFileSync(tokens, JSON.stringify({ "lt-adminSECRET": { name: "adm", role: "owner", domain: "x.test", admin: true } }), { mode: 0o600 });
  let reply = { error: "forbidden" };
  const srv = Bun.serve({ port: 0, fetch: () => Response.json(reply, { status: 403 }) });
  try {
    await expect(createBoard(`ws://127.0.0.1:${srv.port}/ws`, tokens)).rejects.toThrow(/^POST \/boards: 403 forbidden$/);
    reply = { error: "bad token lt-adminSECRET" };
    const e = await createBoard(`ws://127.0.0.1:${srv.port}/ws`, tokens).catch(x => x);
    expect(e.message).toBe("POST /boards: 403 ");
  } finally { srv.stop(true); }
});
