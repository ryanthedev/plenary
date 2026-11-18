// The per-run temp roots of test/preload.js: `<system temp>/plen-run-<pid>-XXXX`, one per `bun test` process, each
// with an `owner.json` ({ pid, host }) written as soon as it is made.
//
// A pid means something only on the machine and in the pid namespace that made it: two containers sharing one temp dir
// (a bind-mounted /tmp) each see the other's live runs as "no such process". So a root is removed only when its owner
// file says it was made under this same hostname (a container gets its own) AND that pid is gone here. A root with no
// readable owner file, another host's, or a live (or unknowable) pid is kept: never delete on doubt.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * True unless `pid` is known to be gone. Only ESRCH ("no such process") means gone; EPERM (alive, another user's) or
 * anything unexpected keeps the dir. No `ps`: a ps that was killed or failed must never read as "dead".
 */
export function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== "ESRCH"; }
}

/** Make this run's root under `base`, with its owner file. */
export function makeRunRoot(base, { pid = process.pid, host = hostname() } = {}) {
  const root = mkdtempSync(join(base, `plen-run-${pid}-`));
  writeFileSync(join(root, "owner.json"), JSON.stringify({ pid, host }));
  return root;
}

/** Remove `<base>/plen-run-*` roots that this host's dead runs left (never our own, never on doubt). Returns the names removed. */
export function sweepStaleRoots(base, { alive = ownerAlive, host = hostname() } = {}) {
  const gone = [];
  let names = [];
  try { names = readdirSync(base); } catch { return gone; }
  for (const name of names) {
    if (!name.startsWith("plen-run-")) continue;
    let owner;
    try { owner = JSON.parse(readFileSync(join(base, name, "owner.json"), "utf8")); } catch { continue; }
    if (owner?.host !== host || !Number.isSafeInteger(owner?.pid) || owner.pid <= 0) continue;
    if (owner.pid === process.pid || alive(owner.pid)) continue;
    try { rmSync(join(base, name), { recursive: true, force: true }); gone.push(name); } catch { /* another run got it */ }
  }
  return gone;
}
