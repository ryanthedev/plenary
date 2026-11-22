// Harness hygiene (p8-load5 round 2): the load tooling leaves no temp dirs, bounds every subprocess and every wait, and
// a stuck child or a run that overstays cannot hang it. (test/load/tmp.js also fails any test file that leaves a temp
// dir behind, so every other file in this directory checks "leaves nothing" too.)

import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmp, cleanTmp, useScratch, childEnv, scenarioGroup, SCRATCH, ORIG_TMPDIR } from "./tmp.js";
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { startServer, stopChild, HEAD_BYTES } from "../../scripts/load/server.js";
import { stopChildren, parseOptions, wallLimitS, createBoard } from "../../scripts/load/run.js";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
beforeAll(useScratch); afterAll(cleanTmp);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const names = () => new Set(readdirSync(SCRATCH));
const tokensFile = () => { const p = join(tmp("plenary-load-hyg-"), "t.json"); writeFileSync(p, JSON.stringify({ "lt-hygTOK": { name: "h", role: "editor" } }), { mode: 0o600 }); return p; };

// Independent and slow: they run at once, in a private TMPDIR each where they list a directory.
const group = scenarioGroup(), scenarios = group.fns, scenario = group.get;
const privateEnv = () => { const d = tmp("plenary-load-priv-"); return { dir: d, env: childEnv({ TMPDIR: d }) }; };
const cliRun = async (args, env) => {
  const p = Bun.spawn([process.execPath, RUN, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
};

scenarios.servers = async () => {
  const tokensPath = tokensFile(), given = tmp("plenary-load-given-");
  const [a, b, c] = await Promise.all([startServer({ tokensPath }), startServer({ tokensPath, keep: true }), startServer({ tokensPath, dataDir: given })]);
  const running = [];
  try {
    for (const s of [a, b, c]) running.push([(await fetch(`${s.httpUrl}/health`)).status, !!s.board, existsSync(s.cwd)]);
  } finally { await Promise.all([a.stop(), b.stop(), c.stop()]); }
  return { a, b, c, given, running };
};
test("startServer: ready on /health, its dirs are removed on stop; a dir you gave it is yours; keep leaves both", async () => {
  const { a, b, c, given, running } = await scenario("servers");
  expect(running).toEqual([[200, true, true], [200, true, true], [200, true, true]]);   // /health is what ready means
  expect([existsSync(a.cwd), existsSync(a.dataDir)]).toEqual([false, false]);
  expect([existsSync(b.cwd), existsSync(b.dataDir)]).toEqual([true, true]);   // kept on request
  expect([existsSync(c.cwd), existsSync(given)]).toEqual([false, true]);     // the caller's data dir is not ours to remove
  for (const d of [b.cwd, b.dataDir]) rmSync(d, { recursive: true, force: true });
  // a tokens path that is not there leaves nothing at all (nothing else is running now: every scenario is done)
  const before = names();
  await expect(startServer({ tokensPath: join(given, "nope.json") })).rejects.toThrow();
  expect(names()).toEqual(before);
}, 30000);

const localArgs = ["--local", "--editors", "1", "--viewers", "2", "--ramp", "50", "--duration", "1", "--drain", "1"];
scenarios.cleanRun = async () => { const p = privateEnv(); return { ...p, ...(await cliRun(localArgs, p.env)) }; };
scenarios.keepRun = async () => { const p = privateEnv(); return { ...p, ...(await cliRun([...localArgs, "--keep-data"], p.env)) }; };
test("run --local without --out: its own temp dirs (server and run) are removed at the end", async () => {
  const r = await scenario("cleanRun");
  expect(r.code).toBe(0);
  expect(readdirSync(r.dir)).toEqual([]);
});
test("run --local --keep-data: the server's data and working dirs and the run's dir are kept and named", async () => {
  const r = await scenario("keepRun");
  expect(r.code).toBe(0);
  const kept = /--keep-data: kept (.+)/.exec(r.stdout)?.[1].split(", ");
  expect(kept?.length).toBe(3);
  expect(new Set(readdirSync(r.dir))).toEqual(new Set(kept.map(d => d.split("/").pop())));
});

scenarios.stopping = async () => {
  const stubborn = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("up")'], { stdout: "pipe", stderr: "ignore" });
  await stubborn.stdout.getReader().read();                          // handlers installed
  let t = Date.now(), killed, killedMs;
  try { killed = await stopChild(stubborn, 300, 2000); killedMs = Date.now() - t; } finally { stubborn.kill("SIGKILL"); }   // never leaves it, whatever the code does
  const stuck = { exitCode: null, signalCode: null, kill() {}, exited: new Promise(() => {}) };   // survives SIGKILL
  t = Date.now();
  const gaveUp = await stopChild(stuck, 100, 100), gaveUpMs = Date.now() - t;
  t = Date.now();
  await stopChildren(new Set([stuck, { ...stuck }]), 100, 100);      // all at once, not one after another
  return { killed, killedMs, pid: stubborn.pid, gaveUp, gaveUpMs, manyMs: Date.now() - t };
};
test("stopChild is bounded: a child that ignores SIGTERM is killed; one that cannot be killed is given up on", async () => {
  const r = await scenario("stopping");
  expect([r.killed, alive(r.pid), r.killedMs < 2500]).toEqual([true, false, true]);
  expect([r.gaveUp, r.gaveUpMs < 1000, r.manyMs < 600]).toEqual([false, true, true]);
});

scenarios.wall = async () => {
  const p = privateEnv();
  return { ...p, ...(await cliRun(["--local", "--editors", "1", "--viewers", "2", "--procs", "2", "--duration", "60", "--max-wall", "3", "--out", join(p.dir, "out")], p.env)) };
};
test("--max-wall: bounds checked, the default is the plan plus 120 s", () => {
  expect(() => parseOptions({ editors: "1", "max-wall": "0" })).toThrow("--max-wall must be ≥ 1 s: 0");
  expect(() => parseOptions({ editors: "1", "max-wall": "86401" })).toThrow("--max-wall must be ≤ 86400: 86401");
  expect(parseOptions({ editors: "1", "max-wall": "90" }).maxWall).toBe(90);
  expect(parseOptions({ editors: "1" }).maxWall).toBe(null);
  expect(wallLimitS({ total: 1000, ramp: 100, duration: 30, drain: 15 })).toBe(10 + 30 + 15 + 120);
  expect(wallLimitS({ total: 1000, ramp: 100, duration: 30, drain: 15 }, 7)).toBe(7);
});
test("--max-wall: a run past it is stopped (exit 2), and its server and workers are gone", async () => {
  const r = await scenario("wall");
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("load: the run took longer than --max-wall (3 s) and was stopped");
  const pids = [/local server pid (\d+)/.exec(r.stdout)?.[1], ...[...r.stdout.matchAll(/worker pid (\d+)/g)].map(m => m[1])].map(Number);
  expect(pids.length).toBe(3);
  expect(pids.filter(alive)).toEqual([]);
  expect(readdirSync(r.dir)).toEqual(["out"]);   // the server's temp dirs went with it
});

test("startServer is ready when /health answers, not when the log says so; a server that never answers is reported", async () => {
  // A stub server: logs its dev-tokens line at once, and starts listening 700 ms later.
  const dir = tmp("plenary-load-stub-"), stub = join(dir, "stub.js");
  writeFileSync(stub, `console.log(JSON.stringify({ msg: "dev tokens are ON: not for production", board: "stubboard" }));
    if (!process.env.NEVER) setTimeout(() => Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") }), 700);
    setInterval(() => {}, 1000);`);
  const t = Date.now();
  const s = await startServer({ tokensPath: tokensFile(), main: stub });
  try {
    expect(Date.now() - t).toBeGreaterThanOrEqual(650);
    expect([s.board, (await fetch(`${s.httpUrl}/health`)).status]).toEqual(["stubboard", 200]);
  } finally { await s.stop(); }
  const e = await startServer({ tokensPath: tokensFile(), main: stub, env: { NEVER: "1" }, timeoutMs: 800 }).catch(x => x);
  expect(e.message).toBe("server: /health did not answer within 800 ms");
});

test("the server's kept output is capped (the log file gets all of it) and readiness still works", async () => {
  // A stub that logs its dev-tokens line, then 2 MB of lines, then listens.
  const dir = tmp("plenary-load-noisy-"), stub = join(dir, "noisy.js"), logPath = join(dir, "server.log");
  writeFileSync(stub, `console.log(JSON.stringify({ msg: "dev tokens are ON: not for production", board: "noisyboard" }));
    const line = JSON.stringify({ msg: "x".repeat(1000) }) + "\\n";
    for (let i = 0; i < 2000; i++) process.stdout.write(line);
    console.error("e".repeat(600000));
    Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") });
    setInterval(() => {}, 1000);`);
  const s = await startServer({ tokensPath: tokensFile(), main: stub, logPath });
  try {
    expect(s.board).toBe("noisyboard");
    const waitFor = async (cond, what, ms = 10_000) => {          // its own deadline and a named failure
      const end = Date.now() + ms;
      while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await Bun.sleep(20); }
    };
    await waitFor(() => statSync(logPath).size >= 2_000_000, "the log file to reach 2 MB (stdout + stderr)");
    await waitFor(() => s.out.text.length >= HEAD_BYTES, "stdout's kept head to fill");
    await waitFor(() => s.out.err.length >= HEAD_BYTES, "stderr's kept head to fill (the file reaching 2 MB does not say stderr has been read)");
    expect(statSync(logPath).size).toBeGreaterThanOrEqual(2_000_000);   // the file got everything
    expect(s.out.text.length).toBeLessThanOrEqual(HEAD_BYTES);          // memory kept the head only, cut at the cap exactly (whatever size the pipe's chunks were)
    expect(s.out.err.length).toBeLessThanOrEqual(HEAD_BYTES);
    expect(s.out.text.length).toBe(HEAD_BYTES);
    expect(s.out.err.length).toBe(HEAD_BYTES);
    expect((await fetch(`${s.httpUrl}/health`)).status).toBe(200);
  } finally { await s.stop(); }
});

test("createBoard gives up on a server that never answers (and does not echo the token)", async () => {
  const hang = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
  const tokens = join(tmp("plenary-load-cbt-"), "t.json");
  writeFileSync(tokens, JSON.stringify({ "lt-adminHANG": { name: "adm", role: "owner", domain: "x.test", admin: true } }), { mode: 0o600 });
  const t = Date.now();
  try {
    const e = await createBoard(`ws://127.0.0.1:${hang.port}/ws`, tokens, { timeoutMs: 300 }).catch(x => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).not.toContain("lt-adminHANG");
    expect(Date.now() - t).toBeLessThan(3000);
  } finally { hang.stop(true); }
});

test("a stop signal while the --local server is still starting leaves no temp dirs", async () => {
  const { dir, env } = privateEnv();
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    const p = Bun.spawn([process.execPath, RUN, "--local", "--editors", "1", "--duration", "30", "--out", join(dir, "out-" + sig)], { stdout: "ignore", stderr: "pipe", env });
    const end = Date.now() + 15000;
    // the server's dirs exist from the moment startServer starts; signal right then, before it can answer /health
    while (!readdirSync(dir).some(n => n.startsWith("plenary-load-cwd-")) && Date.now() < end) await Bun.sleep(2);
    p.kill(sig);
    expect(await p.exited).toBe(2);
  }
  expect(readdirSync(dir).filter(n => !n.startsWith("out-"))).toEqual([]);
}, 30000);

test("every subprocess the load tooling runs is bounded by a timeout", () => {
  for (const f of ["run.js", "server.js", "client.js", "worker.js", "tokens.js", "stats.js"]) {
    const src = readFileSync(join(import.meta.dir, "../../scripts/load", f), "utf8").split("\n").filter(l => !l.trimStart().startsWith("//"));
    for (const l of src.filter(l => /spawnSync\(/.test(l))) expect(l).toContain("timeout");
  }
});

test("cleanTmp puts TMPDIR back (a later test file must not find it pointing at a deleted dir); useScratch sets it again", () => {
  expect(process.env.TMPDIR).toBe(SCRATCH);
  cleanTmp();
  expect(process.env.TMPDIR).toBe(ORIG_TMPDIR);
  if (ORIG_TMPDIR !== undefined) expect(existsSync(process.env.TMPDIR)).toBe(true);
  expect(existsSync(SCRATCH)).toBe(false);
  useScratch();
  expect([process.env.TMPDIR, existsSync(SCRATCH)]).toEqual([SCRATCH, true]);
});
