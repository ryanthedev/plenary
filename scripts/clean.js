// Safe cleanup of plenary's test artifacts (stale temp dirs, stopped rigs, agent scratch copies). `bun run clean` lists
// what it would remove and the bytes (a dry run); `bun run clean --yes` removes it. Nothing is ever removed on doubt:
// an entry is removed only when it is old enough AND provably not in use, and any check that fails (lsof, ps, an
// unreadable or odd owner.json) keeps it. Targets:
//   1. temp dir entries named plenary-*, plen-*, pl-reg-* (all prefixes the tests and scripts use): idle >= --min-age
//      (default 2h; the newest mtime in the tree), no process has a file in them open or its cwd there (one `lsof`),
//      and for a plen-run-<pid>-* root the owner pid (owner.json `pid`, else the name's) is gone (kill -0 says ESRCH).
//   2. stopped rigs: <repo>/.rig/<name> dirs whose processes are all gone, as `cluster-rig.js status` decides it (it
//      applies the rig's psInfo rule: a ps that fails reads as "alive", so the rig stays). A live rig is never touched.
//   3. --scratch <dir>: its direct children, same age and in-use rules as 1 (agents' scratch copies).
// Never follows a symlink (a symlinked entry is skipped; links inside an entry are unlinked, not entered), never touches
// anything outside the temp dir, this repo's .rig and the given scratch dir, and refuses a base that is / or $HOME.
// Limits: lsof run as a normal user does not see other users' (or root's) processes, so a dir only such a process holds
// would look unused; hence only this user's entries are candidates, the in-use check runs a second time per entry right
// before removal (the entry is first renamed to `.plen-deleting-<name>` and put back if anything has it open or lsof fails),
// and --min-age under 10 minutes needs --force.
// A composition root (it shells out to lsof and the rig CLI); nothing imports it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, existsSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const ROOT = realpathSync(resolve(fileURLToPath(new URL("..", import.meta.url))));
const RIG_CLI = join(ROOT, "scripts/cluster-rig.js");
/** Every mkdtemp prefix in test/ and scripts/ (grep mkdtemp; re-check when a new one is added). Names are `<prefix><6 chars>`. */
export const TEMP_PREFIXES = ["pl-reg-open-", "plen-nats-", "plenary-bootstrap-", "plenary-cleantest-", "plenary-cluster-cwd-", "plenary-devadmin-",
  "plenary-guard-", "plenary-live-google-", "plenary-load-", "plenary-load-1013-", "plenary-load-badtok-", "plenary-load-cb-", "plenary-load-cbtok-",
  "plenary-load-cpu-", "plenary-load-cwd-", "plenary-load-data-", "plenary-load-dead-", "plenary-load-drain-", "plenary-load-drcpu-",
  "plenary-load-g4live-", "plenary-load-kill-", "plenary-load-noack-", "plenary-load-orph-", "plenary-load-orphw-", "plenary-load-r2-",
  "plenary-load-rig-", "plenary-load-run-", "plenary-load-sat-", "plenary-load-sig-", "plenary-load-tok-", "plenary-main-cwd-",
  "plenary-nats-auth-", "plenary-pass-", "plenary-probe-", "plenary-reap-", "plenary-registry-", "plenary-rig-", "plenary-static-",
  "plenary-static-bad-", "plenary-static-h1-", "plenary-storm-", "plenary-test-"];
const DELETING = ".plen-deleting-";
const TEMP_NAME = new RegExp(`^(?:(?:${TEMP_PREFIXES.join("|")})[A-Za-z0-9]{6}|plen-run-\\d+-[A-Za-z0-9._-]+)$`);
const isTempName = name => TEMP_NAME.test(name.startsWith(DELETING) ? name.slice(DELETING.length) : name);
export const MIN_SAFE_AGE_MS = 600_000;
const HOUR = 3_600_000;
const RIG_GRACE_MS = 60_000;   // a rig dir touched in the last minute may be an `up` still writing it

/** The system temp dir the tests use (os.tmpdir(), what mkdtemp prefixes hang off). */
const defaultTemp = () => process.env.TMPDIR || tmpdir();

/** Total disk bytes and newest mtime (ms) of the tree at `p`, by lstat only (symlinks counted, never entered). */
export function measure(p) {
  const st = lstatSync(p);
  let bytes = st.blocks * 512, newest = st.mtimeMs;
  if (st.isDirectory()) for (const e of readdirSync(p)) {
    const m = measure(join(p, e));
    bytes += m.bytes;
    newest = Math.max(newest, m.newest);
  }
  return { bytes, newest };
}

/**
 * Every path any process has open (files, cwd, mapped files, unix sockets) from one `lsof`. Throws unless lsof ran and
 * answered: exit 0, or exit 1 with output (what lsof does when it could not inspect some process), never an empty answer.
 */
export function openPaths(lsof = "lsof") {
  const r = spawnSync(lsof, ["-w", "-n", "-P", "-F0n"], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 60_000 });
  if (r.error) throw new Error(`lsof did not run (${r.error.code ?? r.error.message})`);
  if (r.status === null) throw new Error(`lsof was killed by ${r.signal}`);
  if (r.status > 1 || !r.stdout) throw new Error(`lsof exited ${r.status} without an answer`);
  return namesOf(r.stdout);
}
/**
 * Path fields of lsof -F0 output (NUL ends a field, a record's NL is dropped). lsof prints a control character in a path
 * escaped (`\n` as backslash-n), so an odd path never equals the real one here: the per-path `openUnder` re-check, which
 * lsof answers by inode, is what covers it.
 */
const namesOf = out => out.split("\0").map(f => f.replace(/^\n/, "")).filter(f => f.startsWith("n/")).map(f => f.slice(1));

/** Why `path` (a dir) cannot be removed by this lsof's view ("" = nothing has anything under it open). Any failure is a reason. */
export function openUnder(path, lsof = "lsof") {
  const r = spawnSync(lsof, ["-w", "-n", "-P", "-F0n", "+D", path], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 60_000 });
  if (r.error) return `in-use re-check failed: lsof did not run (${r.error.code ?? r.error.message})`;
  if (r.status === null) return `in-use re-check failed: lsof was killed by ${r.signal}`;
  if (r.status <= 1 && /(^|\0)\n?p\d/.test(r.stdout)) return "in use (re-check)";   // +D exits 1 even when it lists matches
  if (r.status <= 1 && !r.stdout && !r.stderr) return "";
  return `in-use re-check failed: lsof exited ${r.status}${r.stderr ? ` (${r.stderr.split("\n")[0].slice(0, 120)})` : ""}`;
}

/** True when the pid may be alive (kill -0 succeeds or is denied); false only on ESRCH. Anything else is "alive". */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

/** Alive-check of a rig dir through the rig's own CLI; true (alive, keep) when it cannot answer. */
export function rigAliveViaCli(dir) {
  const r = spawnSync(process.execPath, ["--no-env-file", RIG_CLI, "status", "--json", "--dir", dir], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) return true;
  try { return JSON.parse(r.stdout).procs.some(p => p.alive); } catch { return true; }
}

/** The owner pid of a plen-run root: owner.json's `pid`, else the one in the name; null when unreadable (keep). */
function ownerPid(dir, name) {
  const f = join(dir, "owner.json");
  if (existsSync(f)) {
    try {
      const st = lstatSync(f);
      const pid = st.isFile() ? JSON.parse(readFileSync(f, "utf8")).pid : null;
      return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
    } catch { return null; }
  }
  const m = /^plen-run-(\d+)-/.exec(name.replace(DELETING, ""));
  return m ? Number(m[1]) : null;
}

const underAny = (opens, p) => opens.some(o => o === p || o.startsWith(p + sep));
const refuseBase = (p, what) => {
  const real = realpathSync(p);
  const home = realpathSync(homedir());
  if (real === sep || real === home || home.startsWith(real + sep) || ROOT === real || ROOT.startsWith(real + sep))
    throw new Error(`refusing to clean ${what} ${p}: it resolves to ${real} (/, $HOME, the repo or one of their parents)`);
  return real;
};

/**
 * Scan the three targets and (with yes) remove what is safe. Returns { items: [{ target, path, bytes, status, why }] }
 * where status is "removed" | "would-remove" | "kept" | "failed". Options (all injectable for tests): tempDir, rigRoot,
 * scratch, minAgeMs, now, lsof (binary), rigAlive(dir) => bool, yes.
 */
export function clean({ tempDir = defaultTemp(), rigRoot = join(ROOT, ".rig"), scratch = null, minAgeMs = 2 * HOUR, now = Date.now(),
  lsof = "lsof", rigAlive = rigAliveViaCli, yes = false, force = false, uid = process.getuid(), beforeRemove = null } = {}) {
  if (minAgeMs < MIN_SAFE_AGE_MS && !force) throw new Error(`--min-age under ${MIN_SAFE_AGE_MS / 60_000} minutes needs --force (a younger entry may still be in use)`);
  const items = [];
  const bases = [["temp", tempDir, isTempName], ["scratch", scratch, () => true]];
  let opens = null, opensError = null;
  try { opens = [...new Set(openPaths(lsof).flatMap(p => { try { return [p, realpathSync(p)]; } catch { return [p]; } }))]; } catch (e) { opensError = e.message; }

  const consider = (target, base, name, extra) => {
    const path = join(base, name);
    const item = { target, path, bytes: 0, status: "kept", why: "" };
    items.push(item);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) { item.why = "symlink"; return; }
      if (st.uid !== uid) { item.why = `owned by uid ${st.uid}, not ${uid}`; return; }
      const m = measure(path);
      item.bytes = m.bytes;
      const idle = now - m.newest;
      if (extra?.minIdleMs !== undefined ? idle < extra.minIdleMs : idle < minAgeMs) { item.why = "too young"; return; }
      if (extra?.check) { const why = extra.check(path, name); if (why) { item.why = why; return; } }
      if (extra?.skipOpen !== true) {
        if (opensError) { item.why = `in-use check failed: ${opensError}`; return; }
        if (underAny(opens, realpathSync(path)) || underAny(opens, path)) { item.why = "in use"; return; }
      }
      if (!yes) { item.status = "would-remove"; return; }
      if (now - measure(path).newest < (extra?.minIdleMs ?? minAgeMs)) { item.why = "touched while scanning"; return; }
      beforeRemove?.(path);   // test seam: something may take the dir between the snapshot and here
      // Rename first so no new process can find it by its name, then look again with a per-path lsof; put it back on any doubt.
      const parked = name.startsWith(DELETING) ? path : join(base, DELETING + name);
      if (parked !== path) { if (existsSync(parked)) { item.why = "a parked copy already exists"; return; } renameSync(path, parked); }
      let why;
      try { why = openUnder(parked, lsof); } catch (e) { why = `in-use re-check failed: ${e.message}`; }
      if (why) { if (parked !== path) renameSync(parked, path); item.why = why; return; }
      rmSync(parked, { recursive: true, force: true });
      item.status = "removed";
    } catch (e) { item.status = "failed"; item.why = e.message; }
  };

  for (const [target, dir, match] of bases) {
    if (!dir) continue;
    let real;
    try { real = refuseBase(dir, target === "temp" ? "the temp dir" : "the scratch dir"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    for (const name of readdirSync(real).sort()) {
      if (!match(name)) continue;
      consider(target, real, name, target === "temp" && name.replace(DELETING, "").startsWith("plen-run-")
        ? { check: (p, n) => { const pid = ownerPid(p, n); return pid === null ? "owner unreadable" : pidAlive(pid) ? `owner pid ${pid} alive` : ""; } } : undefined);
    }
  }

  if (rigRoot && existsSync(rigRoot)) {
    const real = refuseBase(rigRoot, "the rig dir");
    for (const name of readdirSync(real).sort()) {
      const dir = join(real, name);
      if (!lstatSync(dir).isDirectory()) continue;
      consider("rig", real, name, { minIdleMs: RIG_GRACE_MS, check: p => !existsSync(join(p, "rig.json")) ? "no rig.json (an up in progress or failed)" : rigAlive(p) ? "rig alive or unknown" : "" });
    }
  }
  return { items };
}

/** Human summary: per-target counts and bytes of what was (or would be) removed. */
export function summarize(items, yes) {
  const sel = items.filter(i => i.status === (yes ? "removed" : "would-remove"));
  const mb = b => `${(b / 1e6).toFixed(1)} MB`;
  const parts = ["temp", "rig", "scratch"].map(t => { const s = sel.filter(i => i.target === t); return `${t}: ${s.length} (${mb(s.reduce((a, i) => a + i.bytes, 0))})`; });
  const failed = items.filter(i => i.status === "failed").length;
  return `${yes ? "removed" : "would remove"} ${sel.length} entries, ${mb(sel.reduce((a, i) => a + i.bytes, 0))} [${parts.join(", ")}]; kept ${items.filter(i => i.status === "kept").length}${failed ? `; ${failed} failed` : ""}${yes ? "" : "; dry run, pass --yes to remove"}`;
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s ?? "");
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 90m, 2h, 1d)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: HOUR, d: 24 * HOUR }[m[2] ?? "h"];
}

if (import.meta.main) {
  const a = process.argv.slice(2), opt = n => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
  const known = new Set(["--yes", "--verbose", "--force", "--min-age", "--scratch"]);
  const bad = a.find((x, i) => x.startsWith("--") && !known.has(x) || !x.startsWith("--") && !["--min-age", "--scratch"].includes(a[i - 1]));
  if (bad) { console.error(`unknown argument ${bad}\nusage: bun run clean [--yes] [--min-age 2h [--force]] [--scratch <dir>] [--verbose]`); process.exit(2); }
  const yes = a.includes("--yes");
  try {
    const { items } = clean({ yes, minAgeMs: parseDuration(opt("--min-age") ?? "2h"), force: a.includes("--force"), scratch: opt("--scratch") ?? null });
    const mb = b => `${(b / 1e6).toFixed(1)} MB`.padStart(9);
    const shown = items.filter(i => i.status !== "kept" || a.includes("--verbose")), all = a.includes("--verbose") || shown.length <= 25;
    for (const i of all ? shown : [...shown].sort((x, y) => y.bytes - x.bytes).slice(0, 25)) console.log(`${i.status.padEnd(12)}${mb(i.bytes)}  ${i.target.padEnd(7)} ${i.path}${i.why ? `  (${i.why})` : ""}`);
    if (!all) console.log(`... the 25 largest of ${shown.length} (--verbose lists all)`);
    console.log(summarize(items, yes));
    process.exit(items.some(i => i.status === "failed") ? 1 : 0);
  } catch (e) { console.error(`[clean] ${e.message}`); process.exit(1); }
}
