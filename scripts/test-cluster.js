#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RIG_CLI = join(ROOT, "scripts/cluster-rig.js");
const BUN = Bun.which("bun") ?? process.execPath;
const FILES = [
  "test/server/pg-store.test.js",
  "test/server/pg-registry.test.js",
  "test/server/nats-bus.test.js",
  "test/server/room-host-lease.test.js",
  "test/server/room-host-proc.test.js",
  "test/server/main-cluster.test.js",
  "test/server/s3-blobs.test.js",
  "test/admin/tenants.test.js",
];

const hash = createHash("sha256").update(`${ROOT}\0${process.pid}`).digest("hex").slice(0, 6);
const name = `test-${process.pid}-${hash}`.slice(0, 32);
const dir = join(ROOT, ".rig", name);
let child = null, helper = null, rig = null, rigStarted = false, code = 1, interrupted = false;
const signal = sig => {
  interrupted = true;
  try { child?.kill(sig); } catch {}
  try { helper?.kill(sig); } catch {}
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => signal(sig));

try {
  mkdirSync(dir, { recursive: true });
  const up = await runRigCli(["up", "--name", name, "--dir", dir, "--gateways", "1", "--hosts", "1", "--timeout-ms", "90000"]);
  process.stdout.write(up.stdout);
  process.stderr.write(up.stderr);
  if (up.code !== 0) throw new Error(`cluster rig up failed (exit ${up.code})`);
  rigStarted = true;
  const status = await runRigCli(["status", "--dir", dir, "--json"]);
  if (status.code !== 0) throw new Error(`cluster rig status failed: ${status.stderr}`);
  rig = JSON.parse(status.stdout);
  if (interrupted) throw new Error("interrupted while starting cluster");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C",
    DATABASE_URL: rig.postgres.url, NATS_URL: rig.nats.url,
    S3_ENDPOINT: rig.blobs.url, S3_BUCKET: rig.blobs.bucket, S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: rig.blobs.accessKey, S3_SECRET_ACCESS_KEY: rig.blobs.secretKey,
  };
  child = Bun.spawn([BUN, "--no-env-file", "test", ...FILES.map(f => join(ROOT, f))], {
    cwd: dir, env, stdin: "inherit", stdout: "pipe", stderr: "pipe",
  });
  let combined = "";
  const forward = async (stream, target) => {
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      combined += new TextDecoder().decode(value, { stream: true });
      target.write(value);
    }
  };
  const [exit] = await Promise.all([child.exited, forward(child.stdout, process.stdout), forward(child.stderr, process.stderr)]);
  child = null;
  code = exit;
  if (/\b[1-9]\d*\s+skip(?:ped)?\b/i.test(combined)) {
    console.error("[test:cluster] cluster test files reported skipped tests; cluster environment is incomplete");
    if (code === 0) code = 1;
  }
  if (interrupted && code === 0) code = 1;
} catch (error) {
  console.error(`[test:cluster] failed: ${error.message}`);
  code = 1;
} finally {
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    await child.exited.catch(() => {});
    child = null;
  }
  try {
    if (rigStarted || existsSync(join(dir, "rig.json"))) {
      const down = await runRigCli(["down", "--dir", dir, ...(code === 0 ? ["--clean"] : [])]);
      process.stdout.write(down.stdout);
      process.stderr.write(down.stderr);
      if (down.code !== 0 && code === 0) code = 1;
    }
  } catch (error) {
    console.error(`[test:cluster] cleanup failed: ${error.message}`);
    if (code === 0) code = 1;
  }
  if (code === 0) rmSync(dir, { recursive: true, force: true });
  else console.error(`[test:cluster] rig kept at ${dir}`);
}
if (interrupted && code === 0) code = 1;
process.exit(code);

async function runRigCli(args) {
  const proc = Bun.spawn([BUN, "--no-env-file", RIG_CLI, ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  helper = proc;
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  helper = null;
  return { stdout, stderr, code: exit };
}
