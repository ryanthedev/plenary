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
/** `pid`'s start time, "" when there is no such process; throws when ps itself fails (never a silent "" for a live pid). */
export const lstart = pid => {
  const r = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { env: PS_FIXED });
  const out = r.stdout.toString().trim(), err = r.stderr.toString().trim();
  if (r.exitCode === 1 && !out && !err) return "";
  if (r.exitCode !== 0 || !out) throw new Error(`/bin/ps failed for pid ${pid} (exit ${r.exitCode}, signal ${r.signalCode ?? "none"}): ${err}`);
  return out.replace(/\s+/g, " ");
};
/** True while `pid` runs (not a zombie) with that start time; a ps that fails reads as "still live" (keep waiting, remove nothing). */
const liveAs = (pid, started) => {
  const r = Bun.spawnSync(["/bin/ps", "-o", "stat=,lstart=", "-p", String(pid)], { env: PS_FIXED });
  const out = r.stdout.toString().trim();
  if (r.exitCode === 1 && !out && !r.stderr.toString().trim()) return false;
  const m = /^(\S+)\s+(.+)$/.exec(out);
  if (r.exitCode !== 0 || !m) return true;
  return !m[1].startsWith("Z") && m[2].replace(/\s+/g, " ") === started;
};
/**
 * SIGKILL every recorded PID whose start time still matches (the test's own check, not the module's). With the rig
 * `dir`, a SIGKILLed postmaster's SysV segment is removed too (read before the kill; only at NATTCH 0).
 */
export function killRecorded(procs, dir = null) {
  const same = p => { try { return lstart(p.pid) === p.started; } catch { return false; } };   // a failed ps never kills
  for (const p of [...procs].reverse()) if (p?.started && Number.isSafeInteger(p.pid) && p.pid > 1 && same(p)) {
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
  const r = Bun.spawnSync(["/bin/ps", "-axo", "pid=,command="], { env: PS_FIXED });
  if (r.exitCode !== 0) throw new Error(`/bin/ps -axo failed (exit ${r.exitCode}, signal ${r.signalCode ?? "none"}): never read as "nothing names ${dir}"`);
  const out = r.stdout.toString();
  return out.split("\n").filter(l => l.includes(dir) && !l.includes("/bin/ps -axo")).map(l => l.trim());
}

/**
 * The afterAll timeout for cleanupAll(): a backstop, not the budget. The hook used to run one stopRig per dir with a
 * rig.json (every rig stays recorded as "down" until now, ~32 dirs in cluster-rig.test.js), each spawning `ps` per
 * recorded process; with `ps` at 50 ms that was 4.9 s, plus 1.4 s of rmSync = 6.3 s, over bun's 5 s default (reported as
 * an unnamed hook timeout). It now makes one `ps` call and removes ~57 dirs: ~1.4 s whatever ps costs, the rest being the
 * filesystem. The ceiling stays above cleanupAll's own bounded waits (30 s children + 60 s in-flight `up`s).
 */
export const CLEANUP_TIMEOUT_MS = 180_000;
let snapshotPs = "/bin/ps";
/** Test seam: the ps the cleanup snapshot runs (a fake one proves the fail-closed fallback); no argument restores /bin/ps. */
export const _setSnapshotPs = p => { snapshotPs = p ?? "/bin/ps"; };
/**
 * pid -> start time (lstart, whitespace-collapsed) of every non-zombie process, from ONE ps. null (= "unknown": every
 * recorded process is then checked one by one) when ps fails or cannot be spawned, prints nothing, or prints any row
 * that is not `pid stat lstart` in the format psInfo accepts, so a format drift is never read as "not running".
 */
function psSnapshot() {
  let r;
  try { r = Bun.spawnSync([snapshotPs, "-axo", "pid=,stat=,lstart="], { env: PS_FIXED }); } catch { return null; }
  if (r.exitCode !== 0) return null;
  const snap = new Map();
  for (const l of r.stdout.toString().split("\n")) {
    if (!l.trim()) continue;
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+ \S+ +\d+ \d\d:\d\d:\d\d \d{4})\s*$/.exec(l);
    if (!m) return null;
    if (!m[2].startsWith("Z")) snap.set(Number(m[1]), m[3].replace(/\s+/g, " "));
  }
  return snap.size ? snap : null;
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
    try {
      // One ps for every tracked dir (not one per recorded process per dir): a recorded process is live when the snapshot
      // has its pid with the recorded start time and no zombie state. A dir with none is left to the rm below; a ps that
      // fails or cannot be read treats every recorded process as live, so stopRig and killRecorded still check each one.
      const snap = inflight.size ? null : psSnapshot();   // an `up` still running may record a process after any snapshot
      for (const d of dirs) {
        if (!existsSync(join(d, "rig.json"))) continue;
        const procs = recorded(d);
        if (snap && !procs.some(p => snap.get(p?.pid) === p?.started)) continue;
        try { await stopRig(d, { graceMs }); } catch {}
        killRecorded(procs, d);
      }
    } finally {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
      ABORT.aborted = false;   // reusable: bun may share this module between test files in one process
    }
  })().finally(() => { cleaning = null; });
}
const CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
for (const sig of Object.keys(CODES)) process.on(sig, () => { cleanupAll().finally(() => process.exit(CODES[sig])); });
