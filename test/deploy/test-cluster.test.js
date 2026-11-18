// Guards for scripts/test-cluster.js (the rig reviews H1, H2, L6): it starts services only, the gated-file list matches
// the tests that read cluster env, and a SIGINT cannot stop a `down` halfway.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { missingBins, rigStatus, isOurs } from "../../scripts/cluster-rig.js";
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

test("L6: the gated list in test-cluster.js is exactly the test files that read DATABASE_URL, NATS_URL or S3_ENDPOINT", () => {
  const listed = [...SCRIPT.matchAll(/"(test\/[\w./-]+\.test\.js)"/g)].map(m => m[1]).sort();
  const reading = walk(join(ROOT, "test"))
    .filter(f => f.endsWith(".test.js") && !relative(ROOT, f).startsWith("test/deploy/"))
    .filter(f => /process\.env\.(DATABASE_URL|NATS_URL|S3_ENDPOINT)\b|\bS3_ENDPOINT\b/.test(readFileSync(f, "utf8")))
    .map(f => relative(ROOT, f)).sort();
  expect(listed).toEqual(reading);
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

test.skipIf(SKIP)("H2: SIGINT, SIGTERM and SIGHUP sent to `down` do not stop it halfway", async () => {
  const dir = freshDir();
  const rig = await rigUp({ dir, servicesOnly: true, timeoutMs: 60_000 });
  const proc = spawnTracked([process.execPath, "--no-env-file", join(ROOT, "scripts/cluster-rig.js"), "down", "--dir", dir], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  await Bun.sleep(300);   // let the CLI start and install its handlers
  for (const sig of ["SIGINT", "SIGINT", "SIGTERM", "SIGHUP"]) { try { proc.kill(sig); } catch {} await Bun.sleep(30); }
  expect(await proc.exited).toBe(0);
  expect(rigStatus(dir).procs.map(p => isOurs(p))).toEqual([false, false, false]);
}, 120_000);
