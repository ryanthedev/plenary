#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { reapStaleRigs, TERMINAL_SIGNALS, writeOwnerRecord } from "./cluster-rig.js";
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RIG_CLI = join(ROOT, "scripts/cluster-rig.js");
const BUN = Bun.which("bun") ?? process.execPath;
const DEFAULT_FILES = [
  "test/server/pg-store.test.js",
  "test/server/pg-registry.test.js",
  "test/server/nats-bus.test.js",
  "test/server/room-host-lease.test.js",
  "test/server/room-host-proc.test.js",
  "test/server/main-cluster.test.js",
  "test/server/s3-blobs.test.js",
  "test/admin/tenants.test.js",
];
const FILES = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES;   // explicit files (relative to the repo root) only for the guard test

const hash = createHash("sha256").update(`${ROOT}\0${process.pid}`).digest("hex").slice(0, 6);
const name = `test-${process.pid}-${hash}`.slice(0, 32);
// PLENARY_RIG_ROOT: the dir holding the rigs (default `.rig`); the reaper test gives itself its own, so it never touches another run's rigs.
const RIG_ROOT = process.env.PLENARY_RIG_ROOT ? resolve(process.env.PLENARY_RIG_ROOT) : join(ROOT, ".rig");
const dir = join(RIG_ROOT, name);
const ownerFile = `${dir}.owner`;   // this process's start time, beside the rig dir (the dir itself must hold only a rig): lets the reaper tell a reused pid from this run
let child = null, helper = null, rig = null, rigStarted = false, code = 1, interrupted = false, interruptedBy = null;
let tearingDown = false;
const DOWN_TRIES = 20;
const signal = sig => {
  interrupted = true;
  interruptedBy ??= sig;
  try { child?.kill(sig); } catch {}
  if (!tearingDown) try { helper?.kill(sig); } catch {}   // never signal the `down` helper: it must finish stopping the services
};
for (const sig of TERMINAL_SIGNALS) process.on(sig, () => signal(sig));

try {
  await reapStaleRigs(RIG_ROOT, { isInterrupted: () => interrupted,
    down: target => rigDown(["--dir", target, "--clean"], { live: true, cwd: ROOT, shielded: true }) });   // a shielded `down` is never signalled
  await new Promise(r => setTimeout(r, 0));   // let a signal that arrived during a synchronous reap reach its handler first
  if (interrupted) throw new Error("interrupted while reaping");
  mkdirSync(RIG_ROOT, { recursive: true });
  writeOwnerRecord(ownerFile);   // throws (no rig started) rather than write an empty record when ps fails
  mkdirSync(dir, { recursive: true });
  // `up` watches this process: if it dies (SIGKILL), `up` stops what it started and exits. Its output goes straight to our terminal.
  const up = await runRigCli(["up", "--name", name, "--dir", dir, "--services-only", "--timeout-ms", "90000", "--watch-parent", String(process.pid)], { live: true });
  if (up.code !== 0) throw new Error(`cluster rig up failed (exit ${up.code})`);
  rigStarted = true;
  const envOut = await runRigCli(["env", "--dir", dir]);
  if (envOut.code !== 0) throw new Error(`cluster rig env failed: ${envOut.stderr}`);
  rig = Object.fromEntries(envOut.stdout.split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (interrupted) throw new Error("interrupted while starting cluster");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C",
    ...Object.fromEntries(["DATABASE_URL", "NATS_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].map(k => [k, rig[k]])),
  };
  // cwd is the rig dir (no .env or stray files), where bun finds no bunfig.toml: preload test/preload.js (safety nets, temp root) by absolute path, or it is skipped.
  // (the path is split: the L6 guard reads any quoted test path here as a gated test file.)
  child = Bun.spawn([BUN, "--no-env-file", `--preload=${join(ROOT, "test", "preload.js")}`, "test", ...FILES.map(f => resolve(ROOT, f))], {
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
  failIfInterrupted();
} catch (error) {
  console.error(`[test:cluster] failed: ${error.message}`);
  code = 1;
} finally {
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    await child.exited.catch(() => {});
    child = null;
  }
  tearingDown = true;
  console.error("[test:cluster] tearing down");   // readiness marker for the signal-storm guard test
  try {
    if (rigStarted || existsSync(join(dir, "rig.json"))) {
      const down = await rigDown(["--dir", dir, ...(code === 0 ? ["--clean"] : [])], { live: true });
      if (down.code !== 0 && code === 0) code = 1;
    }
  } catch (error) {
    console.error(`[test:cluster] cleanup failed: ${error.message}`);
    if (code === 0) code = 1;
  }
  if (code !== 0 && existsSync(dir)) console.error(`[test:cluster] rig kept at ${dir}`);
  else if (!existsSync(dir)) rmSync(ownerFile, { force: true });
}
failIfInterrupted();   // a signal during teardown
process.exit(code);

/** An interrupted run is never green: say why the exit code is 1 when the tests themselves had passed. */
function failIfInterrupted() {
  if (!interrupted || code !== 0) return;
  code = 1;
  console.error(`[test:cluster] tests passed, but ${interruptedBy} arrived before the run finished: exit 1`);
}

/**
 * Run a rig CLI command as a helper in its OWN process group (detached = setsid), like the services themselves: a
 * terminal Ctrl-C goes to the foreground group, so it reaches this script (which tears down) but never the helper or
 * the `ps` the helper runs while stopping services.
 */
function runRigCli(args, { live = false, cwd = dir, shielded = false } = {}) {
  return new Promise((resolveRun, reject) => {
    // `live` helpers (up, down) inherit stdout/stderr, so their output is live and ordered with ours; the others are captured.
    const proc = spawn(BUN, ["--no-env-file", RIG_CLI, ...args], { cwd, detached: true, stdio: live ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C" } });
    if (!shielded) helper = proc;   // a shielded helper (the reaper's `down`) is never signalled: it must finish
    let stdout = "", stderr = "";
    proc.stdout?.on("data", d => { stdout += d; });
    proc.stderr?.on("data", d => { stderr += d; });
    proc.on("error", reject);
    proc.on("close", (exit, sig) => { helper = null; resolveRun({ stdout, stderr, code: exit ?? 128, signal: sig ?? null }); });
  });
}

/**
 * `cluster-rig.js down`, run again while an attempt died by a signal (rig-tools-v5 M5). With bun 1.4.4 on macOS a
 * `detached` spawn is not atomic: for a moment the child is still in this process group, so a group signal (a terminal
 * Ctrl-C) kills it before it runs any code. Retrying is safe: `down` ignores SIGINT/SIGTERM/SIGHUP from its first
 * statement, and nothing else here signals it, so a signal death means it never ran; and `down` is idempotent. No JS
 * API spawns with signals blocked or with an atomic setsid (and macOS has no setsid(1)), so the race cannot be avoided,
 * only detected. In a 1 ms SIGINT storm a try dies with p = 0.08 (idle) to 0.17 (load 15), measured in rig fix round 6, so 20 tries leak ~p^20.
 */
async function rigDown(args, opts) {
  for (let tries = 1; ; tries++) {
    const r = await runRigCli(["down", ...args], opts);
    if (!r.signal || tries >= DOWN_TRIES) return r;
    console.error(`[test:cluster] down was killed by ${r.signal} before it could start; running it again`);
  }
}
