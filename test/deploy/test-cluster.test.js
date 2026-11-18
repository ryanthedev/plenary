// Guards for scripts/test-cluster.js (the rig reviews H1, H2, L6): it starts services only, the gated-file list matches
// the tests that read cluster env, and a SIGINT cannot stop a `down` halfway.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { missingBins, rigStatus, isOurs, stopRig, STARTED_CLOCK, ownerGone, writeOwnerRecord, _setPsPath } from "../../scripts/cluster-rig.js";
import { freshDir, track, cleanupAll, rigUp, spawnTracked, lstart } from "./rig-guard.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const SCRIPT = readFileSync(join(ROOT, "scripts/test-cluster.js"), "utf8");
const SKIP = missingBins().length > 0;
afterAll(() => cleanupAll());

const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

test("H1: test-cluster starts the rig services-only, never a node or the LB", () => {
  const up = SCRIPT.match(/\["up",[^\]]*\]/)?.[0] ?? "";
  expect(up).toContain('"--services-only"');
  expect(up).not.toMatch(/--gateways|--hosts/);
});

test("M5 (v5): every `down` (the teardown's and the reaper's) goes through rigDown, which reruns one killed in the spawn window", () => {
  expect(SCRIPT.match(/runRigCli\(\s*\[\s*"down"/g)?.length).toBe(1);   // only inside rigDown
  const rigDown = SCRIPT.slice(SCRIPT.indexOf("async function rigDown("));
  expect(rigDown.slice(0, rigDown.indexOf("\n}\n"))).toMatch(/runRigCli\(\["down"/);
  expect(SCRIPT.match(/await rigDown\(\[/g)?.length).toBe(2);   // teardown and reaper
});

// Files that name the gated variables without reading the rig's cluster (they set them explicitly, assert a refusal, or
// are rig-owned) are allowed exactly the lines in gated-allow.json: the line text (trimmed), not a count and not a line
// number (room-host-child.js is a helper of room-host-proc only; the guard below checks its importers). A new line, an edited line (a second read appended to it), or a read swapped in for a deleted mention is
// not on the list and fails the guard. The JSON is not code, so the scan never reads it.
const ALLOW = JSON.parse(readFileSync(join(ROOT, "test/deploy/gated-allow.json"), "utf8"));
const GATED_NAME = /\b(DATABASE_URL|NATS_URL|S3_[A-Z0-9_]+)\b/;   // any form: process.env.X, ["X"], destructuring, a bare constant
const GATED_ALL = new RegExp(GATED_NAME.source, "g");
// Every file bun discovers as a test (.test/_test/.spec/_spec x js jsx ts tsx mjs cjs mts cts), and every helper module beside them.
const CODE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /[._](test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const namingLines = (root, f) => readFileSync(join(root, f), "utf8").split("\n").filter(l => GATED_NAME.test(l)).map(l => l.trim());
const occurrences = (root, f) => (readFileSync(join(root, f), "utf8").match(GATED_ALL) ?? []).length;
/** Naming lines of `f` that are not on its allowlist (each allowed line is used up once). */
const unallowed = (root, f, allow = ALLOW) => {
  const left = [...(allow[f] ?? [])];
  return namingLines(root, f).filter(l => { const i = left.indexOf(l); if (i < 0) return true; left.splice(i, 1); return false; });
};
const gatedFiles = (root, allow = ALLOW) => walk(join(root, "test")).filter(f => CODE_FILE.test(f)).map(f => relative(root, f))
  .filter(f => unallowed(root, f, allow).length > 0).sort();
/**
 * Files that name an allowlisted helper but are neither listed in `script` nor allowlisted themselves (a new importer).
 * A helper is named by its basename, with or without its extension (bun resolves `./helper` too), as a whole path
 * segment inside a string: `"./helper"`, `'../a/helper.js'`, `` `helper.ts` `` (rig-tools-v5 L24).
 */
const orphans = (root, script, allow = ALLOW) => {
  const listed = [...script.matchAll(/"(test\/[\w./-]+)"/g)].map(m => m[1]);
  const helpers = Object.keys(allow).filter(f => !TEST_FILE.test(f)).map(h => h.split("/").pop().replace(CODE_FILE, ""))
    .map(stem => new RegExp(`[/"'\`]${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.(js|jsx|ts|tsx|mjs|cjs|mts|cts))?["'\`]`));
  return walk(join(root, "test")).filter(f => CODE_FILE.test(f)).map(f => relative(root, f))
    .filter(f => !listed.includes(f) && !(f in allow) && helpers.some(h => h.test(readFileSync(join(root, f), "utf8"))));
};

test("L6: the gated list in test-cluster.js is exactly the test files (and helpers) that name DATABASE_URL, NATS_URL or an S3_* variable", () => {
  const listed = [...SCRIPT.matchAll(/"(test\/[\w./-]+)"/g)].map(m => m[1]).sort();
  expect(listed).toEqual(gatedFiles(ROOT));
  expect(listed.every(f => TEST_FILE.test(f))).toBe(true);   // a helper is never listed: it has an allowance and a listed importer
});

test("L12/L17: the allowed lines are exact (a stale one hides a later read), and each allowed line still occurs", () => {
  for (const [f, lines] of Object.entries(ALLOW)) {
    expect([f, namingLines(ROOT, f).sort()]).toEqual([f, [...lines].sort()]);
    expect(occurrences(ROOT, f)).toBeGreaterThanOrEqual(lines.length);
  }
});

test("L18: every file that names an allowlisted helper is itself listed or allowlisted", () => {
  expect(orphans(ROOT, SCRIPT)).toEqual([]);
});

test("L6b/L12/L17/L18: the scan catches every read form, in every test suffix, in helpers, and any new, appended or swapped read in an allowlisted file", () => {
  const root = mkdtempSync(join(tmpdir(), "plenary-guard-"));
  try {
    const caught = {
      "test/a/dot.test.js": "const u = process.env.DATABASE_URL;",
      "test/a/destructure.test.js": "const { DATABASE_URL } = process.env;",
      "test/a/bracket.test.js": 'const u = process.env["NATS_URL"];',
      "test/a/s3.test.js": "const b = process.env.S3_BUCKET;",
      "test/a/alias.test.js": "const E = process.env; E.S3_ENDPOINT;",
      "test/a/bun-env.test.js": "Bun.env.NATS_URL",
      "test/deploy/gated-in-deploy.test.js": "process.env.DATABASE_URL",
      "test/a/deep/er/x.test.js": "process.env.DATABASE_URL",
      "test/a/spec.spec.js": "process.env.DATABASE_URL",
      "test/a/under_test.js": "process.env.DATABASE_URL",
      "test/a/under_spec.js": "process.env.DATABASE_URL",
      "test/a/typed.test.ts": "process.env.DATABASE_URL",
      "test/a/mod.test.mjs": "process.env.DATABASE_URL",
      "test/a/common.test.cjs": "process.env.DATABASE_URL",
      "test/a/tsx.spec.tsx": "process.env.DATABASE_URL",
      "test/a/helper.js": "export const url = process.env.DATABASE_URL;",   // a helper a test imports
      "test/a/helper-ts.ts": "export const url = process.env.NATS_URL;",
      "test/a/allowed-plus-one.test.js": "// DATABASE_URL named in a comment\nprocess.env.NATS_URL",   // one allowed line, two lines
      "test/a/appended.test.js": "// DATABASE_URL named in a comment; const x = process.env.NATS_URL;",   // a second read appended to the allowed line
      "test/a/swapped.test.js": "const x = process.env.NATS_URL;",   // the allowed mention deleted, a read put elsewhere: same count
    };
    const quiet = {
      "test/a/clean.test.js": "const u = process.env.HOME;",
      "test/a/allowed.test.js": "  // DATABASE_URL named in a comment  ",
      "test/a/readme.md": "process.env.DATABASE_URL",
      "test/a/data.json": '{ "DATABASE_URL": 1 }',
    };
    for (const [f, body] of Object.entries({ ...caught, ...quiet })) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); }
    const allow = { "test/a/allowed.test.js": ["// DATABASE_URL named in a comment"], "test/a/allowed-plus-one.test.js": ["// DATABASE_URL named in a comment"],
      "test/a/appended.test.js": ["// DATABASE_URL named in a comment"], "test/a/swapped.test.js": ["// DATABASE_URL named in a comment"] };
    expect(gatedFiles(root, allow)).toEqual(Object.keys(caught).sort());
    expect(occurrences(root, "test/a/appended.test.js")).toBe(2);   // one line, two occurrences
    // L18: a new importer of an allowlisted helper that names no gated variable
    const helper = { "test/a/helper.js": ["export const url = process.env.DATABASE_URL;"] };
    writeFileSync(join(root, "test/a/importer.test.js"), 'import "./helper.js";');
    writeFileSync(join(root, "test/a/extless.test.js"), "import { url } from './helper';");   // L24: no extension
    writeFileSync(join(root, "test/a/spawned.test.js"), "const f = join(import.meta.dir, `helper.js`);");
    writeFileSync(join(root, "test/a/ok.test.js"), 'import "./helper.js";');
    writeFileSync(join(root, "test/a/lookalike.test.js"), 'import "./helper-ts.ts"; import "./my-helper.js"; const helper = 1;');   // another file, and a bare word
    expect(orphans(root, '"test/a/ok.test.js"', helper).sort()).toEqual(["test/a/extless.test.js", "test/a/importer.test.js", "test/a/spawned.test.js"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(SKIP)("H1: --services-only runs Postgres, NATS and MinIO and no node or Caddy; per-rig MinIO keys, rig.json is 0600", async () => {
  const dir = freshDir(), dir2 = freshDir();
  const rig = await rigUp({ dir, servicesOnly: true, timeoutMs: 60_000 });
  const rig2 = await rigUp({ dir: dir2, gateways: 0, hosts: 0, timeoutMs: 60_000 });
  expect(rig.state).toBe("up");
  expect(rig.nodes).toEqual([]);
  expect(rig.lb).toBeNull();
  expect(rig.procs.map(p => p.name)).toEqual(["postgres", "nats", "minio"]);
  expect(rig2.procs.map(p => p.name)).toEqual(["postgres", "nats", "minio"]);
  expect(rig.blobs.secretKey).not.toBe(rig2.blobs.secretKey);
  expect(rig.blobs.accessKey).not.toBe(rig2.blobs.accessKey);
  expect(rig.blobs.secretKey).not.toBe("plenary-rig-local-secret-key");
  expect(statSync(join(dir, "rig.json")).mode & 0o777).toBe(0o600);
  const run = args => Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "scripts/cluster-rig.js"), ...args], { cwd: dir });
  const st = run(["status", "--dir", dir]);
  expect(st.stdout.toString()).not.toContain(rig.blobs.secretKey);
  expect(run(["status", "--dir", dir, "--json"]).stdout.toString()).not.toContain(rig.blobs.secretKey);
  expect(run(["env", "--dir", dir]).stdout.toString()).toContain(`S3_SECRET_ACCESS_KEY=${rig.blobs.secretKey}`);
  // L4: a missing rig suggests only a live one; env and kill give the hint too.
  for (const cmd of ["env", "kill gw-1", "status", "down"]) {
    const r = run([...cmd.split(" "), "--dir", join(ROOT, ".rig", "nope-xyz")]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("no rig named nope-xyz");
  }
}, 120_000);

// H2/H2b: a terminal Ctrl-C goes to the whole foreground process group. Run the real test-cluster.js as its own group
// leader (as a shell does for a foreground job), wait for its "tearing down" line, then storm that GROUP with the signal.
// The helpers run in their own groups, so `down` (and its `ps`) never see the storm and every service is stopped.
// 5 ms is the gap that fails reliably without `detached` (20 ms failed 2 of 3, 50 ms 0 of 3), so it is the only gap used.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const gap = 5;
  test.skipIf(SKIP)(`H2b/L13/L14: a ${sig} storm (every ${gap} ms) on test-cluster's process group during teardown leaves no service running and says why it exits 1`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plenary-storm-"));
    const file = join(tmp, "pass.test.js");
    writeFileSync(file, 'import { test, expect } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n');
    const proc = nodeSpawn(process.execPath, ["--no-env-file", join(ROOT, "scripts/test-cluster.js"), file], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", storm = null;
    const exited = new Promise(r => proc.on("close", r));
    const onData = d => {
      out += d;
      if (!storm && out.includes("[test:cluster] tearing down")) storm = setInterval(() => { try { process.kill(-proc.pid, sig); } catch { clearInterval(storm); } }, gap);
    };
    proc.stdout.on("data", onData); proc.stderr.on("data", onData);
    try {
      const code = await exited;
      expect(storm).not.toBeNull();   // teardown was reached, so the storm really hit it
      expect(code).not.toBe(0);       // interrupted: never reported green
      expect(out).toMatch(/rig test-[\w-]+ down: stopped/);   // L11: down printed its line
      expect(out).toContain(`tests passed, but ${sig} arrived before the run finished: exit 1`);   // L14
      // The services' PIDs come from the `up` status; none may still exist. (A green run's dir is removed by `down --clean`.)
      const pids = [...out.matchAll(/pid (\d+) alive/g)].map(m => Number(m[1]));
      expect(pids.length).toBe(3);   // postgres, nats, minio
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
      const dir = /dir (\S+\/\.rig\/test-[\w-]+)/.exec(out)?.[1];
      expect(dir).toBeTruthy();
      if (existsSync(join(dir, "rig.json"))) { expect(rigStatus(dir).state).toBe("down"); rmSync(dir, { recursive: true, force: true }); }
    } finally {
      clearInterval(storm);
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      const left = /dir (\S+\/\.rig\/test-[\w-]+)/.exec(out)?.[1];   // a failing run must not leak its services either
      if (left && existsSync(join(left, "rig.json"))) { try { await stopRig(left); } catch {} rmSync(left, { recursive: true, force: true }); }
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
}

test.skipIf(SKIP)("H2: SIGINT, SIGTERM and SIGHUP sent straight to `down` do not stop it halfway", async () => {
  const dir = freshDir();
  await rigUp({ dir, servicesOnly: true, timeoutMs: 60_000 });
  const proc = spawnTracked([process.execPath, "--no-env-file", join(ROOT, "scripts/cluster-rig.js"), "down", "--dir", dir], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  // Wait for down's own readiness line (printed once its handlers are installed), not for a fixed time.
  const reader = proc.stderr.getReader();
  let seen = "";
  while (!seen.includes("down: stopping")) { const { value, done } = await reader.read(); if (done) break; seen += new TextDecoder().decode(value); }
  expect(seen).toContain("down: stopping");
  for (const sig of ["SIGINT", "SIGINT", "SIGTERM", "SIGHUP"]) { try { proc.kill(sig); } catch {} await Bun.sleep(5); }
  expect(await proc.exited).toBe(0);
  expect(rigStatus(dir).procs.map(p => isOurs(p))).toEqual([false, false, false]);
}, 120_000);

// L15: SIGKILL of test-cluster.js cannot be caught, so recovery is by the survivors.
test.skipIf(SKIP)("L15: `up --watch-parent` stops what it started and exits 1 when its parent dies (SIGKILL)", async () => {
  const dir = freshDir();
  const parent = nodeSpawn("/bin/sleep", ["300"], { stdio: "ignore" });
  const up = nodeSpawn(process.execPath, ["--no-env-file", join(ROOT, "scripts/cluster-rig.js"), "up", "--dir", dir, "--name", "watch-parent", "--services-only", "--timeout-ms", "60000", "--watch-parent", String(parent.pid)],
    { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  const exited = new Promise(r => up.on("close", r));
  try {
    await new Promise(r => { up.stderr.on("data", d => { err += d; if (err.includes("postgres")) r(); }); up.on("close", r); });
    parent.kill("SIGKILL");
    expect(await exited).toBe(1);
    expect(err).toContain("up failed");
    expect(rigStatus(dir).procs.map(p => isOurs(p))).not.toContain(true);   // nothing it started is still running
  } finally { try { up.kill("SIGKILL"); } catch {} try { parent.kill("SIGKILL"); } catch {} }
}, 120_000);

// The reaper tests run test-cluster.js with its own rig root (PLENARY_RIG_ROOT), so no other run's rigs are involved.
// A pid that can never be allocated (rig-tools-v5 L22): above macOS's PID_MAX (99 999), or above Linux's pid_max. So
// the reaper judges it dead with kill(0) alone, never by a ps (which a signal storm kills), and pid reuse cannot
// revive it. Planted stale rigs also get an owner record with a start time no process has (deadOwner).
const PID_CEILING = process.platform === "linux" ? Number(readFileSync("/proc/sys/kernel/pid_max", "utf8")) : 99_999;
let deadPids = 0;
const deadPid = () => PID_CEILING + 1 + (deadPids++) * 7 + Math.floor(Math.random() * 7);
const deadOwner = dir => writeFileSync(`${dir}.owner`, "Thu Jan  1 00:00:00 1970\n");
const sleepers = [];
afterAll(() => { for (const p of sleepers) try { p.kill("SIGKILL"); } catch {} });
/** A rig dir whose one "service" is a `sleep`: enough for the reaper to leave alone or stop, with no real services. */
function sleepRig(dir) {
  const proc = nodeSpawn("/bin/sleep", ["300"], { stdio: "ignore" });
  sleepers.push(proc);
  const entry = { name: "sleep", pid: proc.pid, started: lstart(proc.pid) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rig.json"), JSON.stringify({ version: 1, name: "sleep", dir, startedClock: STARTED_CLOCK, state: "up", procs: [entry], nodes: [] }) + "\n");
  return { proc, entry };
}
const rootDir = () => track(mkdtempSync(join(tmpdir(), "plenary-reap-")));
const passFile = () => {
  const tmp = track(mkdtempSync(join(tmpdir(), "plenary-pass-")));
  const file = join(tmp, "pass.test.js");
  writeFileSync(file, 'import { test, expect } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n');
  return file;
};
const runCluster = (root, file) => {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "scripts/test-cluster.js"), file], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, PLENARY_RIG_ROOT: root } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

test.skipIf(SKIP)("L15/L21: test-cluster reaps rigs of dead test:cluster runs at startup, and leaves live runs' and other rigs alone", async () => {
  const root = rootDir(), dead = deadPid();
  const stale = join(root, `test-${dead}-aaaaaa`), live = join(root, `test-${process.pid}-bbbbbb`), other = join(root, "l15-other"), emptyStale = join(root, `test-${dead}-cccccc`);
  track(stale);
  mkdirSync(emptyStale, { recursive: true });   // a run killed before its first service started
  writeFileSync(`${emptyStale}.owner`, "x\n");
  deadOwner(stale);
  const rigStale = await rigUp({ dir: stale, name: `test-${dead}-aaaaaa`, servicesOnly: true, timeoutMs: 60_000 });   // the only real services
  const liveSleep = sleepRig(live), otherSleep = sleepRig(other);
  writeFileSync(`${live}.owner`, lstart(process.pid) + "\n");   // this process, as test-cluster would have recorded it
  const before = [live, other].map(d => readFileSync(join(d, "rig.json"), "utf8"));
  const { code, out } = runCluster(root, passFile());
  expect(code, out).toBe(0);
  expect(out).toContain(`reaping stale rig test-${dead}-aaaaaa`);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(emptyStale)).toBe(false);
  expect(existsSync(`${emptyStale}.owner`)).toBe(false);
  for (const p of rigStale.procs) expect(isOurs(p)).toBe(false);   // stopped (a zombie child of this test counts as gone)
  expect(out).not.toContain(`test-${process.pid}-bbbbbb`);
  expect([live, other].map(d => readFileSync(join(d, "rig.json"), "utf8"))).toEqual(before);   // untouched, byte for byte
  expect(isOurs(liveSleep.entry) && isOurs(otherSleep.entry)).toBe(true);
  expect(readdirSync(root).sort()).toEqual([`test-${process.pid}-bbbbbb`, `test-${process.pid}-bbbbbb.owner`, "l15-other"].sort());   // test-cluster's own rig and owner record are gone
}, 180_000);

test.skipIf(SKIP)("M4: a SIGINT while the reaper's `down` runs does not signal it, and the run stops before starting a rig of its own", async () => {
  const root = rootDir(), dead = deadPid();
  const stale = join(root, `test-${dead}-aaaaaa`);
  track(stale);
  deadOwner(stale);
  const rigStale = await rigUp({ dir: stale, name: `test-${dead}-aaaaaa`, servicesOnly: true, timeoutMs: 60_000 });
  const proc = nodeSpawn(process.execPath, ["--no-env-file", join(ROOT, "scripts/test-cluster.js"), passFile()],
    { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLENARY_RIG_ROOT: root } });
  let out = "", sent = false;
  const exited = new Promise(r => proc.on("close", r));
  const onData = d => { out += d; if (!sent && out.includes("reaping stale rig")) { sent = true; try { process.kill(-proc.pid, "SIGINT"); } catch {} } };
  proc.stdout.on("data", onData); proc.stderr.on("data", onData);
  try {
    const code = await exited;
    expect(sent).toBe(true);
    expect(code, out).not.toBe(0);
    expect(out).toContain("interrupted while reaping");
    expect(out).not.toContain("initdb");   // no rig of its own was brought up
    expect(out).not.toContain("rig kept at");   // L23: it never made one
    for (const p of rigStale.procs) expect(isOurs(p), out).toBe(false);   // the reaper's `down` finished
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }
}, 120_000);

test.skipIf(SKIP)("L20: a rig whose owner pid is now another process (different start time) is reaped; the same pid with the recorded start time is left alone", async () => {
  const root = rootDir();
  const owner = nodeSpawn("/bin/sleep", ["300"], { stdio: "ignore" });   // a live process holding the "owner" pid
  sleepers.push(owner);
  const reused = join(root, `test-${owner.pid}-dddddd`), same = join(root, `test-${owner.pid}-eeeeee`);
  const reusedSvc = sleepRig(reused), sameSvc = sleepRig(same);
  writeFileSync(`${reused}.owner`, "Thu Jan  1 00:00:00 1970\n");   // recorded by a process that is not this one
  writeFileSync(`${same}.owner`, lstart(owner.pid) + "\n");
  const { code, out } = runCluster(root, passFile());
  expect(code, out).toBe(0);
  expect(out).toContain(`reaping stale rig test-${owner.pid}-dddddd`);
  expect(out).not.toContain(`reaping stale rig test-${owner.pid}-eeeeee`);
  expect(existsSync(reused)).toBe(false);
  expect(existsSync(`${reused}.owner`)).toBe(false);
  expect(isOurs(reusedSvc.entry)).toBe(false);
  expect(isOurs(sameSvc.entry)).toBe(true);
  expect(existsSync(same)).toBe(true);
}, 120_000);

/**
 * Run test-cluster.js on rig root `root` as its own group leader (as a shell runs a foreground job); once `marker`
 * appears in its output, SIGINT its whole group every `gap` ms (a held Ctrl-C) until it exits.
 */
async function stormRun(root, marker, gap = 1) {
  const proc = nodeSpawn(process.execPath, ["--no-env-file", join(ROOT, "scripts/test-cluster.js"), passFile()],
    { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PLENARY_RIG_ROOT: root } });
  let out = "", storm = null;
  const exited = new Promise(r => proc.on("close", r));
  const onData = d => {
    out += d;
    if (!storm && out.includes(marker)) storm = setInterval(() => { try { process.kill(-proc.pid, "SIGINT"); } catch { clearInterval(storm); } }, gap);
  };
  proc.stdout.on("data", onData); proc.stderr.on("data", onData);
  try { const code = await exited; return { code, out, stormed: storm !== null }; }
  finally { clearInterval(storm); try { process.kill(-proc.pid, "SIGKILL"); } catch {} }
}

// rig-tools-v5 H1: the reaper's ownership check runs ps in test-cluster's own group, so a Ctrl-C kills that ps. A killed
// (or failed) ps is "unknown", and an unknown owner is never reaped. 20 live rigs owned by this very process, each with
// the right owner record and a sleep as its service; the storm starts when the reaper says it is checking them.
test("H1 (v5): a SIGINT storm while the reaper checks live runs' owners reaps none of them", async () => {
  const root = rootDir(), mine = lstart(process.pid);
  const live = Array.from({ length: 20 }, (_, i) => {
    const dir = join(root, `test-${process.pid}-${(0xa00000 + i).toString(16)}`);
    const rig = sleepRig(dir);
    writeFileSync(`${dir}.owner`, mine + "\n");
    return { dir, ...rig };
  });
  const { code, out, stormed } = await stormRun(root, "[test:cluster] checking 20 earlier run rig(s)");
  expect(stormed).toBe(true);
  expect(code, out).not.toBe(0);
  expect(out).toContain("interrupted while reaping");   // the storm hit the reap itself, not a later phase
  expect(out).not.toContain(`reaping stale rig test-${process.pid}-`);
  for (const r of live) {
    expect({ dir: r.dir, alive: isOurs(r.entry) }).toEqual({ dir: r.dir, alive: true });
    expect(existsSync(join(r.dir, "rig.json"))).toBe(true);
    expect(existsSync(`${r.dir}.owner`)).toBe(true);
  }
}, 60_000);

// rig-tools-v5 M5: a `detached` spawn is not atomic (bun 1.4.4, macOS), so a group signal can kill the reaper's `down`
// before it runs. It must be run again. 8 stale rigs (dead owners, sleeps as their services) and a 1 ms SIGINT storm
// from the first reaping line: every sleep is stopped and nothing is left in the root.
test("M5: a 1 ms SIGINT storm from the first reaping line still stops every stale rig's services and leaves the root empty", async () => {
  const root = rootDir();
  const stale = Array.from({ length: 8 }, () => {
    const dir = join(root, `test-${deadPid()}-aaaaaa`);
    deadOwner(dir);
    return { dir, ...sleepRig(dir) };
  });
  const { code, out, stormed } = await stormRun(root, "reaping stale rig");
  expect(stormed).toBe(true);
  expect(code, out).not.toBe(0);
  expect(out).toContain("interrupted while reaping");
  expect(out).not.toContain("rig kept at");   // L23: no rig of its own was made
  for (const r of stale) expect({ dir: r.dir, alive: isOurs(r.entry) }, out).toEqual({ dir: r.dir, alive: false });
  expect(readdirSync(root), out).toEqual([]);
}, 60_000);

// rig-tools-v5 H1, in-process: the owner-record helpers follow psInfo's rule (a ps that cannot answer is never "gone").
test("H1 (v5): writeOwnerRecord throws and writes nothing, and ownerGone throws instead of answering, when ps cannot answer", () => {
  const root = rootDir();
  const stub = (name, body) => { const f = join(root, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  const broken = { killed: stub("killed", "kill -9 $$"), exit2: stub("exit2", 'echo "ps: broke" >&2; exit 2'), garbage: stub("garbage", "echo hello"),
    absent: stub("absent", "exit 1"), interrupted: stub("interrupted", "kill -INT $$") };
  const rec = join(root, "test-1-aaaaaa.owner"), mine = join(root, "mine.owner"), other = join(root, "other.owner");
  writeOwnerRecord(mine);
  expect(readFileSync(mine, "utf8")).toBe(lstart(process.pid) + "\n");
  writeFileSync(other, "Thu Jan  1 00:00:00 1970\n");
  expect(ownerGone(process.pid, mine)).toBe(false);                   // live, same start time
  expect(ownerGone(process.pid, other)).toBe(true);                   // live pid, another start time: reused
  expect(ownerGone(process.pid, join(root, "none.owner"))).toBe(false);   // no record: only a dead pid counts
  expect(ownerGone(deadPid(), other)).toBe(true);                     // dead
  for (const [kind, ps] of Object.entries(broken)) {
    _setPsPath(ps);
    try {
      expect({ kind, threw: (() => { try { writeOwnerRecord(rec); return false; } catch { return true; } })() }).toEqual({ kind, threw: true });
      expect({ kind, written: existsSync(rec) }).toEqual({ kind, written: false });
      expect({ kind, threw: (() => { try { ownerGone(process.pid, mine); return false; } catch (e) { return /^cannot check processes/.test(e.message); } })() }).toEqual({ kind, threw: true });
    } finally { _setPsPath(); }
  }
});
