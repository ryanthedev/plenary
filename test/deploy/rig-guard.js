// Teardown for every test that starts a rig (p8-rig3 Leaks): a failed, timed-out or killed (SIGINT/SIGTERM/SIGHUP)
// test run leaves no postgres, nats-server, caddy or node behind.
// - Rig dirs come from freshDir()/track(); in-process rigs start through rigUp() (shared abort), CLI processes
//   through spawnTracked().
// - cleanupAll() (afterAll, and the signal handlers below) aborts in-flight `up`s and waits for them, SIGTERMs tracked
//   CLI children (an `up` then stops its own rig), then stops every rig dir by its recorded PIDs: stopRig first, then
//   the test's own /bin/ps check (SIGKILL of a PID whose start time still matches), so a broken module cannot leak.
//   Only then are the dirs removed. Nothing is ever stopped by name or pattern.
// Not covered: a SIGKILL of the test runner itself (no handler can run); `down` on the recorded dir still works.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRig, stopRig, _setPsPath, pgShmOf, removeOrphanShm } from "../../scripts/cluster-rig.js";

const dirs = [], inflight = new Set(), children = new Set();
export const ABORT = { aborted: false };

export const track = d => { dirs.push(d); return d; };
export const freshDir = () => track(mkdtempSync(join(tmpdir(), "plenary-rig-")));

/** startRig with the shared abort, tracked until it settles. */
export function rigUp(opts) {
  const p = startRig({ abort: ABORT, ...opts });
  inflight.add(p);
  p.then(() => inflight.delete(p), () => inflight.delete(p));
  return p;
}
/** Bun.spawn, tracked until it exits (teardown SIGTERMs it, then SIGKILLs it). */
export function spawnTracked(argv, opts) {
  const p = Bun.spawn(argv, opts);
  children.add(p);
  p.exited.then(() => children.delete(p));
  return p;
}

const PS_FIXED = { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" };
export const lstart = pid => Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { env: PS_FIXED }).stdout.toString().trim().replace(/\s+/g, " ");
/** True while `pid` runs (not a zombie) with that start time. */
const liveAs = (pid, started) => {
  const out = Bun.spawnSync(["/bin/ps", "-o", "stat=,lstart=", "-p", String(pid)], { env: PS_FIXED }).stdout.toString().trim();
  const m = /^(\S+)\s+(.+)$/.exec(out);
  return !!m && !m[1].startsWith("Z") && m[2].replace(/\s+/g, " ") === started;
};
/**
 * SIGKILL every recorded PID whose start time still matches (the test's own check, not the module's). With the rig
 * `dir`, a SIGKILLed postmaster's SysV segment is removed too (read before the kill; only at NATTCH 0).
 */
export function killRecorded(procs, dir = null) {
  for (const p of [...procs].reverse()) if (p?.started && Number.isSafeInteger(p.pid) && p.pid > 1 && lstart(p.pid) === p.started) {
    const shm = dir && p.name === "postgres" ? pgShmOf(join(dir, "pg"), p.pid) : null;
    try { process.kill(p.pid, "SIGKILL"); } catch {}
    if (shm) {
      const until = Date.now() + 3000;
      while (liveAs(p.pid, p.started) && Date.now() < until) Bun.sleepSync(50);
      if (!liveAs(p.pid, p.started)) removeOrphanShm(shm);
    }
  }
}
const recorded = dir => { try { return JSON.parse(readFileSync(join(dir, "rig.json"), "utf8")).procs ?? []; } catch { return []; } };
/** Processes whose command line names `dir` (nats.conf, postgres -D, Caddyfile, a CLI `up --dir`). */
export function namingDir(dir) {
  const out = Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="], { env: PS_FIXED }).stdout.toString();
  return out.split("\n").filter(l => l.includes(dir) && !l.includes("/bin/ps -axo")).map(l => l.trim());
}

let cleaning = null;
export function cleanupAll({ graceMs = 3000 } = {}) {
  return cleaning ??= (async () => {
    ABORT.aborted = true;
    _setPsPath();   // a test that stubbed ps and died before its finally
    for (const c of children) { try { c.kill("SIGTERM"); } catch {} }
    await Promise.race([Promise.allSettled([...children].map(c => c.exited)), Bun.sleep(30_000)]);
    for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
    await Promise.race([Promise.allSettled([...inflight]), Bun.sleep(60_000)]);
    for (const d of dirs) {
      if (existsSync(join(d, "rig.json"))) {
        try { await stopRig(d, { graceMs }); } catch {}
        killRecorded(recorded(d), d);
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    ABORT.aborted = false;   // reusable: bun may share this module between test files in one process
  })().finally(() => { cleaning = null; });
}
const CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
for (const sig of Object.keys(CODES)) process.on(sig, () => { cleanupAll().finally(() => process.exit(CODES[sig])); });
