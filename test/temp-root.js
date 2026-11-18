// The per-run temp roots of test/preload.js: `<system temp>/plen-run-<pid>-XXXX`, one per `bun test` process.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * True unless `pid` is known to be gone. Only ESRCH ("no such process") means gone; EPERM (alive, another user's) or
 * anything unexpected keeps the dir. No `ps`: a ps that was killed or failed must never read as "dead".
 */
export function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== "ESRCH"; }
}

/** Remove `<base>/plen-run-<pid>-*` roots whose pid is gone (never our own). Returns the names removed. */
export function sweepStaleRoots(base, alive = ownerAlive) {
  const gone = [];
  let names = [];
  try { names = readdirSync(base); } catch { return gone; }
  for (const name of names) {
    const m = /^plen-run-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || alive(pid)) continue;
    try { rmSync(join(base, name), { recursive: true, force: true }); gone.push(name); } catch { /* another run got it */ }
  }
  return gone;
}

