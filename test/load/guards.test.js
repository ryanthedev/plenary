// The load client's guards from the p8-load2v review (p8-load3): a tokens file's text never reaches an error
// (finding 2), a run whose ops the server never answered is not VALID (3), no child process outlives a run that
// failed or was signalled (4), arguments that would plan nonsense are refused with exit 2 (5, 6, 7), and the
// generator's CPU is judged over the load phase however short it is (8).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmp, cleanTmp, useScratch, childEnv, scenarioGroup } from "./tmp.js";
import { Hist } from "../../scripts/load/stats.js";
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runWorker } from "../../scripts/load/worker.js";
import { mergeResults, buildResult, createBoard, exitCode, headline, run, CPU_MEAN_LIMIT } from "../../scripts/load/run.js";
import { fakeServer, busyFrom } from "./fake-server.js";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
beforeAll(useScratch); afterAll(cleanTmp);
// The slow tests that do not measure this process's own event loop (a fake server or a real CLI each, a modelled CPU)
// run at once, started by the first of them.
const group = scenarioGroup(), scenarios = group.fns, scenario = group.get;
const env = childEnv;
async function cli(args) {
  const p = Bun.spawn([process.execPath, RUN, ...args], { stdout: "pipe", stderr: "pipe", env: env() });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---- finding 2: --create-board never quotes the tokens file ----

test("createBoard: a tokens file that is not JSON fails with its path only, never a piece of its text (exit 2)", async () => {
  const dir = tmp("plenary-load-cbtok-");
  const bare = join(dir, "a.json"), envish = join(dir, "b.json");
  writeFileSync(bare, "ltSECRETbare999 and more\n", { mode: 0o600 });
  writeFileSync(envish, "MYSECRETVAR='lt-abc'\n", { mode: 0o600 });
  for (const [file, bits] of [[bare, ["ltSECRET", "SECRET", "bare999", "more"]], [envish, ["MYSECRETVAR", "SECRET", "lt-abc"]]]) {
    const e = await createBoard("ws://127.0.0.1:1/ws", file).catch(x => x);
    expect(e.message).toBe(`tokens file ${file} is not valid JSON`);
    const r = await cli(["--url", "ws://127.0.0.1:1/ws", "--create-board", "--tokens", file, "--editors", "1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`tokens file ${file} is not valid JSON`);
    for (const b of bits) expect(r.stdout + r.stderr).not.toContain(b);
  }
}, 20000);

// ---- finding 3: ops sent but not answered ----

const ops = (sent, acked, echoed) => ({ worker: 0, pid: 1, cpu: [5], cpuLoadMean: 5, cpuLoadMs: 1000, lag: { n: 0, sum: 0, counts: [] },
  stats: { counts: { joined: 1, neverJoined: 0, clients: 1, connectedAtEnd: 1, opsSent: sent, acks: acked, echoes: echoed }, closes: {}, errors: {}, hists: {}, joinsPerSec: {} } });
const judge = w => buildResult({ merged: mergeResults([w]), config: { url: "ws://x", board: "b" }, counts: { editor: 1, annotator: 0, viewer: 0 }, startedAt: 0, finishedAt: 1 });

test("answered: every op sent acked and ≥ 99% echoed, or the run is INCOMPLETE (exit 1); no ops sent passes", () => {
  const cases = [
    [0, 0, 0, true, "VALID"],
    [1000, 1000, 1000, true, "VALID"],
    [1000, 1000, 990, true, "VALID"],                     // 1% of echoes cut off (a resync at the drain's end)
    [1000, 1000, 989, false, "INCOMPLETE (11 of 1000 were never echoed to their sender)"],
    [1000, 999, 1000, false, "INCOMPLETE (1 of 1000 ops made were never acked)"],
    [6, 0, 0, false, "INCOMPLETE (6 of 6 ops made were never acked; 6 of 6 were never echoed to their sender)"],
  ];
  for (const [sent, acked, echoed, answered, head] of cases) {
    const r = judge(ops(sent, acked, echoed));
    expect([r.ops.answered, r.complete, r.clients.complete, r.valid, headline(r), exitCode(r)]).toEqual([answered, answered, true, true, head, answered ? 0 : 1]);
  }
});

scenarios.swallow = async () => {
  const fake = fakeServer({ tokens: { "lt-swallowTOK": { user: "dev:s", role: "editor" } }, onOp() { /* no entry, no ack */ } });
  const dir = tmp("plenary-load-noack-"), tokens = join(dir, "t.json");
  writeFileSync(tokens, JSON.stringify({ "lt-swallowTOK": { name: "s", role: "editor" } }), { mode: 0o600 });
  let r;
  try { r = await cli(["--url", fake.url, "--board", "b", "--tokens", tokens, "--editors", "1", "--ramp", "10", "--duration", "2", "--drain", "1", "--op-rate", "4", "--out", join(dir, "out")]); }
  finally { fake.stop(); }
  return { r, res: JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) };
};
test("live CLI: a server that welcomes everyone and swallows every op headlines INCOMPLETE and exits 1", async () => {
  const { r, res } = await scenario("swallow");
  expect(res.clients.complete).toBe(true);
  expect(res.ops.sent.total).toBeGreaterThan(2);
  expect([res.ops.acked, res.ops.answered, res.complete]).toEqual([0, false, false]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain(`**INCOMPLETE (${res.ops.made.total} of ${res.ops.made.total} ops made were never acked`);
  expect(r.stdout).not.toContain("**VALID**");
  expect(r.stdout + r.stderr).not.toContain("lt-swallowTOK");
}, 20000);

// ---- finding 4: nothing outlives the run ----

scenarios.setupFailure = async () => {
  const dir = tmp("plenary-load-orph-"), tokens = join(dir, "t.json");
  writeFileSync(tokens, JSON.stringify({ "lt-noADMIN": { name: "e", role: "editor" } }), { mode: 0o600 });
  const lines = [];
  const e = await run({ local: true, "create-board": true, tokens, editors: "1", duration: "1", out: join(dir, "out") }, { log: s => lines.push(s) }).catch(x => x);
  return { e, lines };
};
test("a setup failure after the --local server started stops the server", async () => {
  const { e, lines } = await scenario("setupFailure");
  expect(e.message).toBe("--create-board needs a token with admin: true and a domain in the tokens file");
  const pid = Number(/local server pid (\d+)/.exec(lines.join("\n"))?.[1]);
  expect(pid).toBeGreaterThan(0);
  try { expect(alive(pid)).toBe(false); } finally { if (alive(pid)) process.kill(pid, "SIGKILL"); }
}, 30000);

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`${sig} to a --local run stops its server and workers, then exits 2`, async () => {
    const out = tmp("plenary-load-sig-");
    const p = Bun.spawn([process.execPath, RUN, "--local", "--editors", "2", "--viewers", "2", "--procs", "2", "--ramp", "10", "--duration", "60", "--out", out], { stdout: "pipe", stderr: "pipe", env: env() });
    const pids = [];
    let text = "";
    try {
      const reader = p.stdout.getReader(), dec = new TextDecoder(), end = Date.now() + 20000;
      // Wait for the server and both workers (their PIDs are logged as they start).
      while (Date.now() < end) {
        const { value, done } = await reader.read(); if (done) break;
        text += dec.decode(value);
        if ((text.match(/worker pid \d+/g) ?? []).length === 2) break;
      }
      reader.releaseLock();
      pids.push(Number(/local server pid (\d+)/.exec(text)?.[1]), ...[...text.matchAll(/worker pid (\d+)/g)].map(m => Number(m[1])));
      expect(pids.length).toBe(3);
      for (const pid of pids) expect(alive(pid)).toBe(true);
      p.kill(sig);
      expect(await p.exited).toBe(2);
      for (const pid of pids) expect(alive(pid)).toBe(false);
    } finally {
      for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      if (p.exitCode === null) p.kill("SIGKILL");
    }
  }, 40000);
}

// ---- findings 5, 6, 7: arguments refused, exit 2 ----

test("arguments: a ramp under 1 client/s, a load phase under 1 s and an empty count are refused", async () => {
  const quiet = { log: () => {} }, base = { local: true, editors: "1", duration: "1" };
  await expect(run({ ...base, ramp: "0.0001" }, quiet)).rejects.toThrow("--ramp must be ≥ 1 client/s: 0.0001");
  await expect(run({ ...base, ramp: "0.5" }, quiet)).rejects.toThrow("--ramp must be ≥ 1 client/s: 0.5");
  await expect(run({ ...base, duration: "0.5" }, quiet)).rejects.toThrow("--duration must be ≥ 1 s: 0.5");
  await expect(run({ local: true, editors: "", viewers: "1" }, quiet)).rejects.toThrow("--editors is empty");
  await expect(run({ local: true, editors: " ", viewers: "1" }, quiet)).rejects.toThrow("--editors is empty");
  await expect(run({ ...base, viewers: "" }, quiet)).rejects.toThrow("--viewers is empty");
  await expect(run({ ...base, drain: "" }, quiet)).rejects.toThrow("--drain is empty");
  // A ramp of exactly 1 client/s passes the check (this run then stops at the next one: no clients).
  await expect(run({ local: true, editors: "0", ramp: "1" }, quiet)).rejects.toThrow(/no clients planned/);
});

test("exit code 2: a bad argument (parse) and a bad value (setup) both exit 2, before anything starts", async () => {
  const parse = await cli(["--editors"]);
  expect([parse.code, parse.stderr.trim()]).toEqual([2, "--editors needs a value"]);
  const stray = await cli(["oops"]);
  expect([stray.code, stray.stderr.trim()]).toEqual([2, "unexpected argument oops"]);
  const empty = await cli(["--local", "--editors", "", "--viewers", "1"]);
  expect([empty.code, empty.stderr.trim()]).toEqual([2, "load: --editors is empty"]);
  const ramp = await cli(["--local", "--editors", "1", "--ramp", "0.0001"]);
  expect([ramp.code, ramp.stderr.trim()]).toEqual([2, "load: --ramp must be ≥ 1 client/s: 0.0001"]);
  for (const r of [empty, ramp]) expect(r.stdout).not.toContain("local server pid");
}, 20000);

// ---- finding 8: CPU over a short load phase, and only the load phase ----

const noTokens = () => { const p = join(tmp("plenary-load-cpu-"), "t.json"); writeFileSync(p, "{}", { mode: 0o600 }); return p; };
scenarios.shortPinned = async () => {
  // The process is modelled as 100% of a core from loadFrom on (busyFrom: no real burning, so how busy this machine
  // is cannot change the result).
  const t0 = Date.now(), loadFrom = t0 + 1200, genEndAt = loadFrom + 800;
  const r = await runWorker({ url: "ws://127.0.0.1:1/ws", board: "b", tokensPath: noTokens(), t0, loadFrom, genEndAt, drainMs: 0, clients: [], cfg: {} }, { cpuUsage: busyFrom(loadFrom) });
  r.lag = new Hist().toJSON();   // the event loop's lag is the machine's, not under test here
  return r;
};
test("a load phase shorter than one CPU sample, pinned, is still measured and flagged", async () => {
  const r = await scenario("shortPinned");
  expect(r.cpuLoad.length).toBe(0);   // no whole 1 s sample fits: the old fallback judged all samples (mostly idle)
  expect(r.cpuLoadMs).toBeGreaterThanOrEqual(700);
  expect(r.cpuLoadMean).toBeGreaterThan(CPU_MEAN_LIMIT);
  const res = buildResult({ merged: mergeResults([r]), config: {}, counts: { editor: 0, annotator: 0, viewer: 1 }, startedAt: 0, finishedAt: 1 });
  expect(res.valid).toBe(false);
  expect(res.invalidReasons).toEqual([`worker 0: CPU mean ${r.cpuLoadMean}% of a core > ${CPU_MEAN_LIMIT}%`]);
}, 15000);

scenarios.drainCpu = async () => {
  // An editor whose ops the server never acks keeps the drain open for its whole 2 s; this process burns in it.
  const tokensPath = join(tmp("plenary-load-drcpu-"), "t.json");
  writeFileSync(tokensPath, JSON.stringify({ tE: { name: "d-e", role: "editor" } }), { mode: 0o600 });
  const fake = fakeServer({ tokens: { tE: { user: "dev:d-e", role: "editor" } }, onOp(ctx, ws, msg) { ctx.entry(ws.data.user, msg); } });
  const t0 = Date.now() + 200, loadFrom = t0 + 300, genEndAt = loadFrom + 1000, drainMs = 2000;
  // CPU: idle through the load phase, 100% of a core from 300 ms into the drain (modelled, not burned): the sample
  // from the 2nd to the 3rd second of the run is wholly busy.
  let r;
  try {
    r = await runWorker({ url: fake.url, board: "b", tokensPath, t0, loadFrom, genEndAt, drainMs, clients: [{ role: "editor", token: 0, name: "d-e0", startAt: 0 }], cfg: { opRate: 4, noteRate: 0, commentRate: 0, cursorRate: 0, pool: 5 } }, { cpuUsage: busyFrom(genEndAt + 300) });
  } finally { fake.stop(); }
  r.lag = new Hist().toJSON();   // the event loop's lag is the machine's, not under test here
  // And the worker reports none for a load phase too short to judge.
  const t1 = Date.now();
  const z = await runWorker({ url: "ws://127.0.0.1:1/ws", board: "b", tokensPath: noTokens(), t0: t1, loadFrom: t1 + 300, genEndAt: t1 + 400, drainMs: 0, clients: [], cfg: {} });
  return { r, z, drainMs };
};
test("CPU burned in the drain is not the load phase's; a load phase with no measurement is not VALID", async () => {
  const { r, z, drainMs } = await scenario("drainCpu");
  expect(r.stats.counts.drainMs).toBeGreaterThanOrEqual(drainMs - 50);
  expect(r.cpuLoadMs).toBeLessThan(1700);
  expect(r.cpuLoadMean).toBeLessThan(40);                        // the drain's CPU is not the load phase's
  expect(Math.max(...r.cpu)).toBeGreaterThan(CPU_MEAN_LIMIT);   // the whole-run samples saw it
  // No measurement: never read as fine.
  const unmeasured = { ...r, cpuLoadMean: null, cpuLoadMs: 0 };
  const res = buildResult({ merged: mergeResults([unmeasured]), config: {}, counts: { editor: 1, annotator: 0, viewer: 0 }, startedAt: 0, finishedAt: 1 });
  expect(res.valid).toBe(false);
  expect(res.invalidReasons).toContain("worker 0: CPU over the load phase not measured (0 ms of load phase)");
  // The worker reports none for a load phase too short to judge.
  expect(z.cpuLoadMean).toBe(null);
}, 20000);
