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
// Paths are resolved by resolveNoOpen (lstat + readlink, never open), so no race can make this open a device. Accepted limit: a
// hung network or autofs path in lsof output can still block the lstat itself.
// Never opens anything that is not a plain file or directory (a FIFO, socket or device is kept, never resolved: opening a
// pty slave or a named pipe can block forever), never follows a symlink (a symlinked entry is skipped; links inside an entry are unlinked, not entered), never touches
// anything outside the temp dir, this repo's .rig and the given scratch dir, and refuses a base that is / or $HOME.
// Limits: lsof run as a normal user does not see other users' (or root's) processes, so a dir only such a process holds
// would look unused; hence only this user's entries are candidates, the in-use check runs a second time per entry right
// before removal (the entry is first renamed to `.plen-deleting-<name>` and put back if anything has it open or lsof fails),
// and --min-age under 10 minutes needs --force. If exclusive rename is unavailable on darwin or linux, removal is refused
// unless --allow-racy-rename explicitly permits the check-then-rename fallback; --force does not permit that fallback.
// A composition root (it shells out to lsof and the rig CLI); nothing imports it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lstatSync, statSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, existsSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { dlopen, FFIType, read } from "bun:ffi";

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
export function measure(p, stat = lstatSync, rootDev = undefined, deadlineCheck = null) {
  if (deadlineCheck?.()) throw new Error("skipped (time limit)");
  const st = stat(p);
  const device = rootDev ?? st.dev;
  if (st.isDirectory() && st.dev !== device) throw new Error(`tree contains a directory on a different device: ${p}`);
  let bytes = st.blocks * 512, newest = st.mtimeMs;
  if (st.isDirectory()) for (const e of readdirSync(p)) {
    const m = measure(join(p, e), stat, device, deadlineCheck);
    bytes += m.bytes;
    newest = Math.max(newest, m.newest);
  }
  return { bytes, newest };
}

/**
 * Every path any process has open (files, cwd, mapped files, unix sockets) from one `lsof`. Throws unless lsof ran and
 * answered: exit 0, or exit 1 with output (what lsof does when it could not inspect some process), never an empty answer.
 */
export function openPaths(lsof = "lsof", timeout = 60_000) {
  if (timeout < 1) throw new Error("lsof skipped (time limit)");
  const r = spawnSync(lsof, ["-w", "-n", "-P", "-F0n"], { encoding: "utf8", maxBuffer: 1 << 28, timeout });
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
export function openUnder(path, lsof = "lsof", timeout = 60_000) {
  if (timeout < 1) return "in-use re-check failed: lsof skipped (time limit)";
  const r = spawnSync(lsof, ["-w", "-n", "-P", "-F0n", "+D", path], { encoding: "utf8", maxBuffer: 1 << 28, timeout });
  if (r.error) return `in-use re-check failed: lsof did not run (${r.error.code ?? r.error.message})`;
  if (r.status === null) return `in-use re-check failed: lsof was killed by ${r.signal}`;
  if (r.status <= 1 && /(^|\0)\n?p\d/.test(r.stdout)) return "in use (re-check)";   // +D exits 1 even when it lists matches
  if (r.status <= 1 && !r.stdout && !r.stderr) return "";
  return `in-use re-check failed: lsof exited ${r.status}${r.stderr ? ` (${r.stderr.split("\n")[0].slice(0, 120)})` : ""}`;
}

/**
 * realpath that never opens anything: walks the components with lstat and readlink only (as Node's JS realpath does), so a
 * device, FIFO or socket met on the way is never opened and there is no lstat-then-open race. Throws the lstat error
 * (ENOENT, ENOTDIR) for a missing component, and ELOOP past 40 links.
 */
export function resolveNoOpen(p, stat = lstatSync, readlink = readlinkSync, cache = new Map(), readdir = readdirSync) {
  let cur = sep, links = 0;
  const names = dir => { if (!cache.has(dir)) { let l; try { l = readdir(dir); } catch { l = []; } cache.set(dir, l); } return cache.get(dir); };   // enterable but unlistable: keep the given spelling
  const todo = (p.startsWith(sep) ? p : process.cwd() + sep + p).split(sep).filter(Boolean).reverse();
  // macOS firmlink: /System/Volumes/Data/<x> is /<x> (what lsof prints). Drop the prefix only where both are provably the same directory.
  if (todo.length > 3 && todo.at(-1) === "System" && todo.at(-2) === "Volumes" && todo.at(-3) === "Data") {
    try {
      const x = todo.at(-4), a = statSync(`/System/Volumes/Data/${x}`), b = statSync(`/${x}`);
      if (a.dev === b.dev && a.ino === b.ino) todo.length -= 3;
    } catch { /* not a firmlinked system: keep the spelling */ }
  }
  while (todo.length) {
    let c = todo.pop();
    if (c === ".") continue;
    if (c === "..") { cur = dirname(cur); continue; }
    const st = stat(join(cur, c));   // throws ENOENT/ENOTDIR for a missing component
    // Restore the stored spelling (a case-insensitive volume answers /USERS/R for /Users/r): the exact name, else the case-insensitive match.
    const all = names(cur);
    if (!all.includes(c)) c = all.find(e => e.toLowerCase() === c.toLowerCase()) ?? c;
    const next = join(cur, c);
    if (!st.isSymbolicLink()) { cur = next; continue; }
    if (++links > 40) throw Object.assign(new Error(`too many symbolic links: ${p}`), { code: "ELOOP" });
    const target = readlink(next);
    if (target.startsWith(sep)) cur = sep;
    todo.push(...target.split(sep).filter(Boolean).reverse());
  }
  if (p.endsWith(sep) && !stat(cur).isDirectory()) throw Object.assign(new Error(`not a directory: ${p}`), { code: "ENOTDIR" });
  return cur;
}

/**
 * The paths a lsof answer is matched against: each as lsof printed it, plus its resolved form for a regular file or a
 * directory only. lsof also lists devices (a pty slave under /dev), named pipes and sockets, and resolving one of those
 * means opening it, which can block for good (a pty slave with no peer hangs open(2) in the kernel, uninterruptibly),
 * so a path is lstat'd first and anything that is not a plain file or directory is never resolved or opened.
 */
export function resolveOpens(paths, stat = lstatSync, realpath = null) {
  const out = new Set(), cache = new Map();
  realpath ??= p => resolveNoOpen(p, lstatSync, readlinkSync, cache);
  for (const p of paths) {
    out.add(p);
    if (p.startsWith("/dev/")) continue;
    try { const st = stat(p); if (st.isFile() || st.isDirectory()) out.add(realpath(p)); } catch { /* gone, or not ours to resolve */ }
  }
  return [...out];
}

/** True when the pid may be alive (kill -0 succeeds or is denied); false only on ESRCH. Anything else is "alive". */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

/** Alive-check of a rig dir through the rig's own CLI; true (alive, keep) when it cannot answer. */
export function rigAliveViaCli(dir, timeout = 60_000, spawn = spawnSync) {
  if (timeout < 1) return true;
  const r = spawn(process.execPath, ["--no-env-file", RIG_CLI, "status", "--json", "--dir", dir], { encoding: "utf8", timeout });
  if (r.status !== 0) return true;
  try { return JSON.parse(r.stdout).procs.some(p => p.alive); } catch { return true; }
}

let nativeRenameExcl = null, nativeRenameErrno = null, warnedNativeFallback = false, nativeRenameFailurePlatform = null;
export function resetNativeRenameWarning() { warnedNativeFallback = false; nativeRenameFailurePlatform = null; }
export function loadNativeRename(loader = dlopen, platform = process.platform, warn = message => console.error(message), install = true, allowRacyRename = false) {
  let rename = null, errnoReader = null;
  try {
    if (platform === "darwin") {
      const lib = loader("libSystem.B.dylib", {
        renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
      });
      const renamex = lib.symbols.renamex_np, getErrno = lib.symbols.__error;
      rename = (from, to) => renamex(Buffer.from(from + "\0"), Buffer.from(to + "\0"), 0x4);
      errnoReader = () => read.i32(getErrno());
    } else if (platform === "linux") {
      const lib = loader("libc.so.6", {
        renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      const renameat2 = lib.symbols.renameat2, getErrno = lib.symbols.__errno_location;
      rename = (from, to) => renameat2(-100, Buffer.from(from + "\0"), -100, Buffer.from(to + "\0"), 1);
      errnoReader = () => read.i32(getErrno());
    }
  } catch {
    rename = null;
    errnoReader = null;
  }
  if (install) {
    if ((platform === "darwin" || platform === "linux") && !rename) nativeRenameFailurePlatform = platform;
    else if (rename && nativeRenameFailurePlatform === platform) nativeRenameFailurePlatform = null;
    nativeRenameExcl = rename;
    nativeRenameErrno = errnoReader;
  }
  return rename;
}
loadNativeRename(dlopen, process.platform, message => console.error(message), true);

export function renameExcl(from, to, { forceFallback = false, stat = lstatSync } = {}) {
  if (!forceFallback && nativeRenameExcl) {
    if (nativeRenameExcl(from, to) === 0) return;
    const errno = nativeRenameErrno?.();
    const errnoNames = { 1: "EPERM", 2: "ENOENT", 13: "EACCES", 16: "EBUSY", 17: "EEXIST", 18: "EXDEV", 20: "ENOTDIR", 22: "EINVAL", 28: "ENOSPC", 30: "EROFS" };
    const name = errnoNames[errno] ?? errno;
    const error = new Error(errnoNames[errno] === "EEXIST" ? `target exists: ${to} (EEXIST)` : `exclusive rename failed: ${name}`);
    error.code = errnoNames[errno] ?? String(errno);
    error.errno = errno;
    error.fromRename = true;
    throw error;
  }
  try { stat(to); const e = new Error(`target exists: ${to}`); e.code = "EEXIST"; e.fromRename = true; throw e; }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  renameSync(from, to);
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
  if (!statSync(p).isDirectory()) throw new Error(`refusing to clean ${what} ${p}: not a directory (never opened)`);   // stat does not open; realpath does
  const real = resolveNoOpen(p);
  const home = resolveNoOpen(homedir());
  // By identity (dev+ino; stat opens nothing; the only check): a case-insensitive volume answers /USERS/R or /users for $HOME or its parents, and no
  // string compare of spellings can be trusted there.
  const key = q => { const st = statSync(q); return `${st.dev}:${st.ino}`; };
  const protectedKeys = new Set();
  const add = q => { try { protectedKeys.add(key(q)); } catch { /* absent here (no firmlink off macOS) */ } };
  const DATA = "/System/Volumes/Data";   // macOS firmlink: the same directories again, under their physical parent
  add(DATA);
  for (const start of [home, ROOT]) for (let d = start; ; d = dirname(d)) { add(d); if (d !== sep) add(DATA + d); if (d === sep) break; }
  if (protectedKeys.has(key(p)))
    throw new Error(`refusing to clean ${what} ${p}: it is /, $HOME, the repo or one of their parents (same directory by identity)`);
  return real;
};

/**
 * Scan the three targets and (with yes) remove what is safe. Returns { items: [{ target, path, bytes, status, why }] }
 * where status is "removed" | "would-remove" | "kept" | "failed". Options (all injectable for tests): tempDir, rigRoot,
 * scratch, minAgeMs, now, lsof (binary), rigAlive(dir) => bool, yes, allowRacyRename.
 */
export function clean({ tempDir = defaultTemp(), rigRoot = join(ROOT, ".rig"), scratch = null, minAgeMs = 2 * HOUR, now = Date.now(),
  lsof = "lsof", rigAlive = rigAliveViaCli, yes = false, force = false, allowRacyRename = false, warn = message => console.error(message), uid = process.getuid(), beforeRemove = null,
  afterRename = null, stat = lstatSync, clock = Date.now, maxTimeMs = 5 * 60_000, openPathsFn = openPaths, openUnderFn = openUnder,
  renameExclFn = null, platform = process.platform, nativeRenameAvailable = !!nativeRenameExcl } = {}) {
  if (minAgeMs < MIN_SAFE_AGE_MS && !force) throw new Error(`--min-age under ${MIN_SAFE_AGE_MS / 60_000} minutes needs --force (a younger entry may still be in use)`);
  if (yes && (platform === "darwin" || platform === "linux") && !nativeRenameAvailable && !warnedNativeFallback) {
    warnedNativeFallback = true;
    if (nativeRenameFailurePlatform === platform || !nativeRenameFailurePlatform) {
      warn(allowRacyRename ? "exclusive rename unavailable; using check-then-rename" : "exclusive rename unavailable; refusing to remove (pass --allow-racy-rename to use check-then-rename)");
    }
  }
  const items = [];
  const bases = [["temp", tempDir, isTempName], ["scratch", scratch, () => true]];
  const deadline = clock() + maxTimeMs;
  const timeLeft = () => Math.max(0, deadline - clock());
  const safeRename = (from, to) => {
    if (!renameExclFn) return renameExcl(from, to, { stat });
    try { return renameExclFn(from, to); }
    catch (e) { if (e.code === "EEXIST") e.fromRename = true; throw e; }
  };
  const deadlineCheck = () => timeLeft() <= 0;
  const existsLstat = p => { try { stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
  // A base that is refused throws before anything shells out (the system-wide lsof below is the slow part). The resolved
  // paths are kept: the scan loops below use them, so each base is resolved once.
  const resolved = new Map();
  for (const [target, dir] of bases) if (dir) try { resolved.set(target, refuseBase(dir, target === "temp" ? "the temp dir" : "the scratch dir")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const realRig = rigRoot && existsSync(rigRoot) ? refuseBase(rigRoot, "the rig dir") : null;
  let opens = null, opensError = null;
  const initialLeft = timeLeft();
  if (initialLeft <= 0) opensError = "skipped (time limit)";
  else try { opens = resolveOpens(openPathsFn(lsof, Math.max(1, Math.min(60_000, initialLeft))), stat); } catch (e) { opensError = e.message; }

  const consider = (target, base, name, extra) => {
    const path = join(base, name);
    const item = { target, path, bytes: 0, status: "kept", why: "" };
    items.push(item);
    try {
      if (timeLeft() <= 0) { item.why = "skipped (time limit)"; return; }
      const st = stat(path);
      if (st.isSymbolicLink()) { item.why = "symlink"; return; }
      if (!st.isDirectory() && !st.isFile()) { item.why = "not a regular file or directory"; return; }   // never open a pipe, socket or device
      if (st.uid !== uid) { item.why = `owned by uid ${st.uid}, not ${uid}`; return; }
      if (yes && (platform === "darwin" || platform === "linux") && !nativeRenameAvailable && !allowRacyRename) { item.why = "exclusive rename unavailable; --allow-racy-rename required to remove"; return; }
      if (st.dev !== stat(base).dev) { item.status = "failed"; item.why = "candidate is a mount point (different device from parent)"; return; }
      const m = measure(path, stat, undefined, deadlineCheck);
      item.bytes = m.bytes;
      const idle = now - m.newest;
      if (extra?.minIdleMs !== undefined ? idle < extra.minIdleMs : idle < minAgeMs) { item.why = "too young"; return; }
      if (extra?.check) { const why = extra.check(path, name); if (why) { item.why = why; return; } }
      if (extra?.skipOpen !== true) {
        if (opensError) { item.why = `in-use check failed: ${opensError}`; return; }
        if (underAny(opens, resolveNoOpen(path)) || underAny(opens, path)) { item.why = "in use"; return; }
      }
      if (!yes) { item.status = "would-remove"; return; }
      const scanned = measure(path, stat, undefined, deadlineCheck);
      const judged = stat(path);
      if (judged.dev !== st.dev || judged.ino !== st.ino || judged.mtimeMs !== st.mtimeMs || now - scanned.newest < (extra?.minIdleMs ?? minAgeMs)) { item.why = "touched while scanning"; return; }
      beforeRemove?.(path);   // test seam: something may take the dir between the snapshot and here
      // Rename first so no new process can find it by its name, then look again with a per-path lsof; put it back on any doubt.
      const parked = name.startsWith(DELETING) ? path : join(base, DELETING + name);
      if (parked !== path) { if (existsLstat(parked)) { item.why = "a parked copy already exists"; return; } safeRename(path, parked); afterRename?.(parked, path); }
      const parkedStat = stat(parked);
      const restoreChanged = () => {
        if (parked === path) return;
        if (existsLstat(path)) item.why = "changed while parking; original path exists";
        else safeRename(parked, path);
      };
      let after;
      try { after = measure(parked, stat, undefined, deadlineCheck); }
      catch (e) {
        if (e.message === "skipped (time limit)") { item.why = "skipped (time limit)"; restoreChanged(); if (item.why.includes("original path exists")) item.why = "skipped (time limit); original path exists"; }
        else { item.why = "changed while parking"; restoreChanged(); }
        return;
      }
      if (parkedStat.dev !== judged.dev || parkedStat.ino !== judged.ino || parkedStat.mtimeMs !== judged.mtimeMs || after.bytes !== scanned.bytes || after.newest !== scanned.newest) {
        restoreChanged();
        if (!item.why) item.why = "changed while parking";
        return;
      }
      const recheckLeft = timeLeft();
      if (recheckLeft <= 0) { item.why = "skipped (time limit)"; if (parked !== path) { if (existsLstat(path)) item.why += "; original path exists"; else safeRename(parked, path); } return; }
      let why;
      try { why = openUnderFn(parked, lsof, Math.max(1, Math.min(60_000, recheckLeft))); } catch (e) { why = `in-use re-check failed: ${e.message}`; }
      if (timeLeft() <= 0) {
        if (parked !== path) { if (existsLstat(path)) item.why = "skipped (time limit); original path exists"; else safeRename(parked, path); }
        if (!item.why) item.why = "skipped (time limit)";
        return;
      }
      if (why) { if (parked !== path) { if (existsLstat(path)) item.why = `${why}; original path exists`; else safeRename(parked, path); } if (!item.why) item.why = why; return; }
      rmSync(parked, { recursive: true, force: true });
      item.status = "removed";
    } catch (e) { if (e.message === "skipped (time limit)") item.why = e.message; else if (e.code === "EEXIST" && e.fromRename) { item.why = `target/original path exists${e.message ? `: ${e.message}` : ""}`; } else { item.status = "failed"; item.why = e.message; } }
  };

  for (const [target, dir, match] of bases) {
    if (!dir) continue;
    const real = resolved.get(target);
    if (!real) continue;   // missing
    for (const name of readdirSync(real).sort()) {
      if (!match(name)) continue;
      consider(target, real, name, target === "temp" && name.replace(DELETING, "").startsWith("plen-run-")
        ? { check: (p, n) => { const pid = ownerPid(p, n); return pid === null ? "owner unreadable" : pidAlive(pid) ? `owner pid ${pid} alive` : ""; } } : undefined);
    }
  }

  if (realRig) {
    const real = realRig;
    for (const name of readdirSync(real).sort()) {
      const dir = join(real, name);
      if (!lstatSync(dir).isDirectory()) continue;
      consider("rig", real, name, { minIdleMs: RIG_GRACE_MS, check: p => {
        let regular = false;
        try { regular = lstatSync(join(p, "rig.json")).isFile(); } catch { /* missing */ }
        if (!regular) return "no rig.json (an up in progress or failed)";
        const left = timeLeft();
        if (left <= 0) return "skipped (time limit)";
        const alive = rigAlive(p, Math.max(1, Math.min(60_000, left)));
        return alive ? "rig alive or unknown" : "";
      } });
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
  const refused = items.filter(i => i.status === "kept" && /exclusive rename unavailable/.test(String(i.why))).length;
  return `${yes ? "removed" : "would remove"} ${sel.length} entries, ${mb(sel.reduce((a, i) => a + i.bytes, 0))} [${parts.join(", ")}]; kept ${items.filter(i => i.status === "kept").length}${refused ? `; ${refused} refused (exclusive rename unavailable)` : ""}${failed ? `; ${failed} failed` : ""}${yes ? "" : "; dry run, pass --yes to remove"}`;
}

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s ?? "");
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 90m, 2h, 1d)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: HOUR, d: 24 * HOUR }[m[2] ?? "h"];
}

if (import.meta.main) {
  const a = process.argv.slice(2), opt = n => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
  const known = new Set(["--yes", "--verbose", "--force", "--allow-racy-rename", "--min-age", "--scratch", "--max-time"]);
  const bad = a.find((x, i) => x.startsWith("--") && !known.has(x) || !x.startsWith("--") && !["--min-age", "--scratch", "--max-time"].includes(a[i - 1]));
  if (bad) { console.error(`unknown argument ${bad}\nusage: bun run clean [--yes] [--min-age 2h [--force]] [--allow-racy-rename] [--max-time 5m] [--scratch <dir>] [--verbose]`); process.exit(2); }
  const yes = a.includes("--yes");
  try {
    const { items } = clean({ yes, minAgeMs: parseDuration(opt("--min-age") ?? "2h"), maxTimeMs: parseDuration(opt("--max-time") ?? "5m"), force: a.includes("--force"), allowRacyRename: a.includes("--allow-racy-rename"), scratch: opt("--scratch") ?? null });
    const mb = b => `${(b / 1e6).toFixed(1)} MB`.padStart(9);
    const shown = items.filter(i => i.status !== "kept" || a.includes("--verbose")), all = a.includes("--verbose") || shown.length <= 25;
    for (const i of all ? shown : [...shown].sort((x, y) => y.bytes - x.bytes).slice(0, 25)) console.log(`${i.status.padEnd(12)}${mb(i.bytes)}  ${i.target.padEnd(7)} ${i.path}${i.why ? `  (${i.why})` : ""}`);
    if (!all) console.log(`... the 25 largest of ${shown.length} (--verbose lists all)`);
    console.log(summarize(items, yes));
    process.exit(items.some(i => i.status === "failed") ? 1 : 0);
  } catch (e) { console.error(`[clean] ${e.message}`); process.exit(1); }
}
