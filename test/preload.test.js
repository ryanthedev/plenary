// test/preload.js (bunfig.toml preload): its safety nets run for EVERY test file of a run, not only the first that
// imports helpers.js or rig.js (e1-tests-v HIGH-1), and its per-run temp root is swept when its owner is gone.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { ownerAlive, sweepStaleRoots, makeRunRoot } from "./temp-root.js";

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

test("a stale root is removed only when its owner file says this host and its pid is gone; anything doubtful is kept", async () => {
  const base = mkdtempSync(join(tmpdir(), "plen-sweep-"));
  const dead = Bun.spawn(["true"]); await dead.exited;                   // a pid that has exited (and been reaped)
  const host = hostname();
  const mine = makeRunRoot(base, { pid: dead.pid });                     // this host, dead owner: removed
  const self = makeRunRoot(base);                                         // this run: kept
  const live = makeRunRoot(base, { pid: 1 });                             // pid 1 is alive (EPERM, not ESRCH): kept
  const other = makeRunRoot(base, { pid: dead.pid, host: host + "-other-container" });   // another pid namespace: kept
  const noOwner = join(base, `plen-run-${dead.pid}-noowner`); mkdirSync(noOwner);        // no owner file: kept
  const garbled = makeRunRoot(base, { pid: dead.pid }); writeFileSync(join(garbled, "owner.json"), "{not json");
  mkdirSync(join(base, "plenary-test-d"));                               // not a run root at all
  const name = p => p.split("/").at(-1);
  expect(sweepStaleRoots(base)).toEqual([name(mine)]);
  expect(readdirSync(base).sort()).toEqual([self, live, other, noOwner, garbled].map(name).concat("plenary-test-d").sort());
  // Liveness is "anything but ESRCH": a checker that says dead removes this host's other runs, never another host's.
  expect(sweepStaleRoots(base, { alive: () => false })).toEqual([name(live)]);
  expect(existsSync(self) && existsSync(other) && existsSync(noOwner) && existsSync(garbled)).toBe(true);
});

test("the sweep keeps a root whose owner file is from another pid namespace, lacks one, or names no usable pid", () => {
  const base = mkdtempSync(join(tmpdir(), "plen-sweep-"));
  const owned = owner => { const d = mkdtempSync(join(base, "plen-run-")); writeFileSync(join(d, "owner.json"), JSON.stringify(owner)); return d; };
  const host = hostname(), ns = "pid:[4026531836]";
  const dead = owned({ pid: 999_999, host, ns });                          // control: this host and namespace, dead
  const kept = [
    owned({ pid: 999_999, host, ns: "pid:[4026532999]" }),               // --network=host container: same hostname, other pids
    owned({ pid: 999_999, host }),                                        // no namespace recorded: doubt
    owned({ pid: 999_999, host, ns: null }),                              // a namespace-less host's file, seen from Linux
    owned({ pid: "999999", host, ns }), owned({ pid: -999_999, host, ns }), owned({ pid: 0, host, ns }), owned({ pid: 1.5, host, ns }),
  ];
  expect(sweepStaleRoots(base, { alive: () => false, host, ns })).toEqual([dead.split("/").at(-1)]);
  for (const d of kept) expect([d, existsSync(d)]).toEqual([d, true]);
});

test("an owner file from before `ns` existed: swept where there is no namespace (macOS), kept where there is one (Linux)", () => {
  const base = mkdtempSync(join(tmpdir(), "plen-sweep-"));
  const old = mkdtempSync(join(base, "plen-run-")); writeFileSync(join(old, "owner.json"), JSON.stringify({ pid: 999_999, host: hostname() }));
  expect(sweepStaleRoots(base, { alive: () => false, ns: "pid:[4026531836]" })).toEqual([]);
  expect(sweepStaleRoots(base, { alive: () => false, ns: null })).toEqual([old.split("/").at(-1)]);
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
