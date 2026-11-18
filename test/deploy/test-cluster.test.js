// Guards for scripts/test-cluster.js (the rig reviews H1, H2, L6): it starts services only, the gated-file list matches
// the tests that read cluster env, and a SIGINT cannot stop a `down` halfway.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { missingBins, rigStatus, isOurs, stopRig } from "../../scripts/cluster-rig.js";
import { freshDir, track, cleanupAll, rigUp, spawnTracked } from "./rig-guard.js";

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

// Files that name the gated variables without reading the rig's cluster (they set them explicitly, assert a refusal, or
// are rig-owned): the number of lines allowed to name them. One more line in any of these is a new read and fails the
// guard, so the allowance is per occurrence, never per file.
const ALLOW = { "test/admin/devadmin.test.js": 3, "test/auth/google-live-server.test.js": 1, "test/server/main.test.js": 15,
  "test/server/p4-wire2.test.js": 9, "test/deploy/cluster-rig.test.js": 5, "test/deploy/stub-node.js": 2,   // helper, rig-owned
  "test/server/room-host-child.js": 2,   // helper of room-host-lease and room-host-proc, both listed
  "test/deploy/test-cluster.test.js": 24 };   // this file: the fixtures below
const GATED_NAME = /\b(DATABASE_URL|NATS_URL|S3_[A-Z0-9_]+)\b/;   // any form: process.env.X, ["X"], destructuring, a bare constant
// Every file bun discovers as a test (.test/_test/.spec/_spec x js jsx ts tsx mjs cjs mts cts), and every helper module beside them.
const CODE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const TEST_FILE = /[._](test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const namingLines = (root, f) => readFileSync(join(root, f), "utf8").split("\n").filter(l => GATED_NAME.test(l)).length;
const gatedFiles = (root, allow = ALLOW) => walk(join(root, "test")).filter(f => CODE_FILE.test(f)).map(f => relative(root, f))
  .filter(f => namingLines(root, f) > (allow[f] ?? 0)).sort();

test("L6: the gated list in test-cluster.js is exactly the test files (and helpers) that name DATABASE_URL, NATS_URL or an S3_* variable", () => {
  const listed = [...SCRIPT.matchAll(/"(test\/[\w./-]+)"/g)].map(m => m[1]).sort();
  expect(listed).toEqual(gatedFiles(ROOT));
  expect(listed.every(f => TEST_FILE.test(f))).toBe(true);   // a helper is never listed: it has an allowance and a listed importer
});

test("L12: the allowances are exact (a stale one hides a later read)", () => {
  for (const [f, n] of Object.entries(ALLOW)) expect([f, namingLines(ROOT, f)]).toEqual([f, n]);
});

test("L6b/L12: the scan catches every read form, in every test suffix, in helpers, and one new read in an allowlisted file", () => {
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
      "test/a/allowed-plus-one.test.js": "// DATABASE_URL named in a comment\nprocess.env.NATS_URL",   // allowance 1, two lines
    };
    const quiet = {
      "test/a/clean.test.js": "const u = process.env.HOME;",
      "test/a/allowed.test.js": "process.env.DATABASE_URL",
      "test/a/readme.md": "process.env.DATABASE_URL",
      "test/a/data.json": '{ "DATABASE_URL": 1 }',
    };
    for (const [f, body] of Object.entries({ ...caught, ...quiet })) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); }
    expect(gatedFiles(root, { "test/a/allowed.test.js": 1, "test/a/allowed-plus-one.test.js": 1 })).toEqual(Object.keys(caught).sort());
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

test.skipIf(SKIP)("L15: test-cluster reaps rigs of dead test:cluster runs at startup, and leaves live runs' and other rigs alone", async () => {
  const dead = Bun.spawnSync(["/usr/bin/true"]).pid;   // a pid that has exited
  const stale = join(ROOT, ".rig", `test-${dead}-aaaaaa`), live = join(ROOT, ".rig", `test-${process.pid}-bbbbbb`), other = join(ROOT, ".rig", `l15-other-${process.pid}`);
  const emptyStale = join(ROOT, ".rig", `test-${dead}-cccccc`);
  for (const d of [stale, live, other, emptyStale]) track(d);
  mkdirSync(emptyStale, { recursive: true });   // a run killed before its first service started
  await Promise.all([[stale, `test-${dead}-aaaaaa`], [live, `test-${process.pid}-bbbbbb`], [other, "l15-other"]]
    .map(([dir, name]) => rigUp({ dir, name, servicesOnly: true, timeoutMs: 60_000 })));
  const stalePids = rigStatus(stale).procs.map(p => p.pid), livePids = rigStatus(live).procs.map(p => p.pid);
  const tmp = mkdtempSync(join(tmpdir(), "plenary-reap-"));
  const file = join(tmp, "pass.test.js");
  writeFileSync(file, 'import { test, expect } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n');
  try {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "scripts/test-cluster.js"), file], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString() + r.stderr.toString();
    expect(r.exitCode, out).toBe(0);
    expect(out).toContain(`reaping stale rig test-${dead}-aaaaaa`);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(emptyStale)).toBe(false);
    for (const pid of stalePids) {   // this test process started them, so a dead one stays a zombie until reaped: not "Z" means running
      const stat = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString().trim();
      expect(stat === "" || stat.startsWith("Z")).toBe(true);
    }
    expect(out).not.toContain(`test-${process.pid}-bbbbbb`);
    expect(rigStatus(live).procs.every(p => isOurs(p))).toBe(true);   // a live run's rig is untouched
    expect(rigStatus(other).procs.every(p => isOurs(p))).toBe(true);
    expect(livePids.length).toBe(3);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 180_000);
