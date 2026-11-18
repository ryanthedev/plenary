// test/preload.js (bunfig.toml preload): its safety nets run for EVERY test file of a run, not only the first that
// imports helpers.js or rig.js (e1-tests-v HIGH-1), and its per-run temp root is swept when its owner is gone.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerAlive, sweepStaleRoots } from "./temp-root.js";

const ROOT = join(import.meta.dir, "..");

test("in one run of five files, every file's failed test has its child reaped and its rig stopped (the next test checks)", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "plen-preload-")), "children.txt");
  const run = Bun.spawn([process.execPath, "test", "./test/preload-fixture"], { cwd: ROOT, env: { ...process.env, PLEN_PRELOAD_FIXTURE: log }, stdout: "pipe", stderr: "pipe" });
  // A run whose children or rigs were left running never exits (they keep its event loop alive): the backstop ends it.
  const exited = await Promise.race([run.exited.then(() => true), Bun.sleep(20_000).then(() => false)]);
  if (!exited) run.kill("SIGKILL");
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const pids = readFileSync(log, "utf8").trim().split("\n").map(l => Number(l.split(" ")[1]));
  const left = pids.filter(ownerAlive);
  for (const pid of left) process.kill(pid, "SIGKILL");                 // only this test's own children, by pid
  const text = out + err;
  expect(exited).toBe(true);
  expect(text).toMatch(/\b5 pass\b/);                                   // every "is gone / is stopped" check, in all five files
  expect(text).toMatch(/\b5 fail\b/);                                   // and only the five failing-on-purpose tests
  expect(pids.length).toBe(3);
  expect(left).toEqual([]);
}, 30_000);

test("the run's temp dirs live under its own root, named after its pid", () => {
  expect(tmpdir()).toBe(globalThis.__plenaryTestRoot);
  expect(tmpdir()).toMatch(new RegExp(`/plen-run-${process.pid}-[^/]+$`));
});

test("a stale root is removed only when its owner is gone: not a live one, not this run's, not another name", async () => {
  const base = mkdtempSync(join(tmpdir(), "plen-sweep-"));
  const dead = Bun.spawn(["true"]); await dead.exited;                   // a pid that has exited (and been reaped)
  const names = [`plen-run-${dead.pid}-a`, `plen-run-${process.pid}-b`, `plen-run-1-c`, `plenary-test-d`, `plen-run-x-e`];
  for (const n of names) mkdirSync(join(base, n));
  expect(sweepStaleRoots(base)).toEqual([`plen-run-${dead.pid}-a`]);     // pid 1 is alive (EPERM, not ESRCH): kept
  expect(readdirSync(base).sort()).toEqual(names.slice(1).sort());
  // Liveness is "anything but ESRCH": an unknown error keeps the dir; a checker that says dead removes it.
  expect(sweepStaleRoots(base, () => false).sort()).toEqual([`plen-run-1-c`]);
  expect(existsSync(join(base, `plen-run-${process.pid}-b`))).toBe(true);
});

test("ownerAlive: ESRCH alone means gone", () => {
  expect(ownerAlive(process.pid)).toBe(true);
  expect(ownerAlive(1)).toBe(true);                                      // EPERM: alive, someone else's
  const kill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error("odd"), { code: "EINVAL" }); };
    expect(ownerAlive(12345)).toBe(true);
    process.kill = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    expect(ownerAlive(12345)).toBe(false);
  } finally { process.kill = kill; }
});
