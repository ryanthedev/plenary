// Guards for scripts/test-cluster.js (the rig reviews H1, H2, L6): it starts services only, the gated-file list matches
// the tests that read cluster env, and a SIGINT cannot stop a `down` halfway.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { missingBins, rigStatus, isOurs, stopRig } from "../../scripts/cluster-rig.js";
import { freshDir, cleanupAll, rigUp, spawnTracked } from "./rig-guard.js";

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

// Files that name these variables only to set them explicitly or to assert a refusal (they never read the rig's cluster).
const ALLOW = ["test/admin/devadmin.test.js", "test/auth/google-live-server.test.js", "test/server/main.test.js", "test/server/p4-wire2.test.js",
  "test/deploy/cluster-rig.test.js", "test/deploy/test-cluster.test.js"];
const GATED_NAME = /\b(DATABASE_URL|NATS_URL|S3_[A-Z0-9_]+)\b/;   // any form: process.env.X, ["X"], destructuring, a bare constant
const gatedFiles = (root, allow = ALLOW) => walk(join(root, "test")).filter(f => f.endsWith(".test.js")).map(f => relative(root, f))
  .filter(f => !allow.includes(f) && GATED_NAME.test(readFileSync(join(root, f), "utf8"))).sort();

test("L6: the gated list in test-cluster.js is exactly the test files that name DATABASE_URL, NATS_URL or an S3_* variable", () => {
  const listed = [...SCRIPT.matchAll(/"(test\/[\w./-]+\.test\.js)"/g)].map(m => m[1]).sort();
  expect(listed).toEqual(gatedFiles(ROOT));
});

test("L6b: the gated-file scan catches every way to read the cluster env, in any test directory, and skips the allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "plenary-guard-"));
  try {
    const forms = {
      "test/a/dot.test.js": "const u = process.env.DATABASE_URL;",
      "test/a/destructure.test.js": "const { DATABASE_URL } = process.env;",
      "test/a/bracket.test.js": 'const u = process.env["NATS_URL"];',
      "test/a/s3.test.js": "const b = process.env.S3_BUCKET;",
      "test/a/alias.test.js": "const E = process.env; E.S3_ENDPOINT;",
      "test/deploy/gated-in-deploy.test.js": "process.env.DATABASE_URL",
      "test/a/clean.test.js": "const u = process.env.HOME;",
      "test/a/allowed.test.js": "process.env.DATABASE_URL",
      "test/a/not-a-test.js": "process.env.DATABASE_URL",
    };
    for (const [f, body] of Object.entries(forms)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), body); }
    expect(gatedFiles(root, ["test/a/allowed.test.js"])).toEqual(["test/a/alias.test.js", "test/a/bracket.test.js", "test/a/destructure.test.js", "test/a/dot.test.js", "test/a/s3.test.js", "test/deploy/gated-in-deploy.test.js"]);
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
// leader (as a shell does for a foreground job), wait for its "tearing down" line, then storm that GROUP with SIGINT.
// The helpers run in their own groups, so `down` (and its `ps`) never see the storm and every service is stopped.
for (const gap of [5, 20, 50]) {
  test.skipIf(SKIP)(`H2b: a SIGINT storm (every ${gap} ms) on test-cluster's process group during teardown leaves no service running`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plenary-storm-"));
    const file = join(tmp, "pass.test.js");
    writeFileSync(file, 'import { test, expect } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n');
    const proc = nodeSpawn(process.execPath, ["--no-env-file", join(ROOT, "scripts/test-cluster.js"), file], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", storm = null;
    const exited = new Promise(r => proc.on("close", r));
    const onData = d => {
      out += d;
      if (!storm && out.includes("[test:cluster] tearing down")) storm = setInterval(() => { try { process.kill(-proc.pid, "SIGINT"); } catch { clearInterval(storm); } }, gap);
    };
    proc.stdout.on("data", onData); proc.stderr.on("data", onData);
    try {
      const code = await exited;
      expect(storm).not.toBeNull();   // teardown was reached, so the storm really hit it
      expect(code).not.toBe(0);       // interrupted: never reported green
      expect(out).toMatch(/rig test-[\w-]+ down: stopped/);   // L11: down printed its line
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
