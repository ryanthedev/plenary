#!/usr/bin/env bun
// Local cluster rig for the M2 load test and the phase-4 takeover check: native Postgres 17 + NATS + N node
// processes (gateways and room hosts split) behind one Caddy load balancer, all on this machine, all on probed ports.
//
//   bun scripts/cluster-rig.js up     [--name default] [--dir <path>] [--gateways 2] [--hosts 1] [--lease-ttl-ms 10000]
//                                     [--max-conns-per-user 100000] [--node-cmd "<cmd> <args>"] [--timeout-ms 60000]
//   bun scripts/cluster-rig.js status [--name|--dir] [--json]
//   bun scripts/cluster-rig.js kill <node-id> [--name|--dir]      SIGKILL one node by its recorded PID (takeover check)
//   bun scripts/cluster-rig.js down   [--name|--dir] [--all] [--clean]
//   bun scripts/cluster-rig.js ls | gc | env [--name|--dir]
//
// Importable for tests: startRig(opts), stopRig(rigOrDir), readRig(dir), rigStatus(dir), killNode(dir, id), missingBins().
// Docs: deploy/cluster/RIG.md.
//
// Rules this file keeps:
// - Every server binary runs in the foreground as a direct, detached child (postgres, nats-server, caddy run, bun), so
//   the PID recorded is the server's own. Output goes to a log file per process, never through a pipe, so `up` can exit
//   and leave them running.
// - rig.json is rewritten (tmp + rename) after every spawn, so `down` finds everything even when `up` was SIGKILLed.
// - Each recorded PID carries its start time (`ps -o lstart=`, always run with TZ=UTC and LC_ALL=C so the text does not
//   depend on the caller's time zone or locale; rig.json says so in `startedClock`). `down` and `kill` signal a PID only
//   while that start time still matches: a reused PID is never ours. Nothing is ever killed by name or pattern.
//   A rig.json without `startedClock` (written before 2026-11-12's fix) is refused while any recorded PID exists:
//   its times were local to an unknown TZ/locale, so they cannot be re-normalised.
// - The rig dir is the one the caller names (--dir / the path given), never the `dir` inside rig.json: a copied or
//   moved rig.json is read and written in place and never touches another rig's file.
// - Secrets (COOKIE_KEY, SESSION_KEY, dev tokens) live only in 0600 files in the rig dir and in the nodes' env. They
//   never go into argv, rig.json, stdout, stderr or an error message. Output names the files, never their contents.
// - Nodes get an explicit minimal env and a cwd outside the repo, so Bun's .env auto-load never reaches them.
//
// rig.json (version 1; the load client, scripts/load/, reads it; fields below are stable):
//   { version: 1, name, dir, startedClock: "lstart TZ=UTC LC_ALL=C", state: "starting" | "up" | "failed" | "down", createdAt, leaseTtlMs, maxConnsPerUser,
//     lb: { url, wsUrl, port }, tokensFile, keysFile, logsDir,
//     postgres: { port, url },               url = DATABASE_URL (trust auth on 127.0.0.1, no password)
//     nats: { port, url, monitorPort },      url = NATS_URL
//     nodes: [{ id, roles: ["gateway"] | ["host"], port, url, dataDir, log }],
//     procs: [{ name: "postgres" | "nats" | "node:<id>" | "caddy", pid, started, log }] }
// tokensFile, keysFile, logsDir and the nodes'/procs' dataDir/log are stored relative to the rig dir (absolute in
// memory and in `status --json`); resolve them against the dir rig.json was read from.
// `ps` is always /bin/ps; a ps that fails refuses every command (never read as "gone"). `up` holds <dir>/up.lock.
// tokensFile is PLENARY_DEV_TOKENS as given to every node: { "<token>": { name, role, domain, admin? } }. One token is
// an owner with admin: true in domain rig.test (POST /boards works with it); every token has domain rig.test.

import { spawn as cpSpawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync, linkSync } from "node:fs";
import { join, resolve, basename, isAbsolute, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const MAIN = join(ROOT, "server/main.js");
const NAME_RE = /^[a-z0-9-]{1,32}$/;
const which = (cmd, fallback) => Bun.which(cmd) ?? (existsSync(fallback) ? fallback : null);
const BUN = Bun.which("bun") ?? process.execPath;

/** Absolute paths of the binaries the rig runs (null when missing). */
export function bins() {
  const pg17 = ["/opt/homebrew/opt/postgresql@17/bin", "/usr/local/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"];
  const find = (cmd, fallback, dirs = []) => Bun.which(cmd) ?? [fallback, ...dirs.map(d => join(d, cmd))].find(p => p && existsSync(p)) ?? null;
  return {
    initdb: find("initdb", "/opt/homebrew/bin/initdb", pg17),
    postgres: find("postgres", "/opt/homebrew/bin/postgres", pg17),
    nats: which("nats-server", "/opt/homebrew/bin/nats-server"),
    caddy: which("caddy", "/opt/homebrew/bin/caddy"),
    minio: find("minio", "/opt/homebrew/bin/minio"),
  };
}
/** Names of missing binaries; empty when the rig can run. */
export function missingBins() { return Object.entries(bins()).filter(([, p]) => !p).map(([k]) => k); }

/** Parse ipcs -m output without performing any system changes. */
export function parseIpcsSegments(output, owner) {
  const lines = String(output).split(/\r?\n/);
  const headerAt = lines.findIndex(line => /\b(?:shmid|id)\b/i.test(line) && /\bowner\b/i.test(line) && /\bnattch\b/i.test(line));
  if (headerAt < 0) return [];
  const headers = lines[headerAt].trim().toLowerCase().split(/\s+/);
  const ix = { shmid: headers.indexOf("shmid") >= 0 ? headers.indexOf("shmid") : headers.indexOf("id"), owner: headers.indexOf("owner"), nattch: headers.indexOf("nattch") };
  return lines.slice(headerAt + 1).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    const id = Number(fields[ix.shmid]), nattch = Number(fields[ix.nattch]);
    return fields.length > Math.max(...Object.values(ix)) && Number.isSafeInteger(id) && id >= 0 && fields[ix.owner] === owner && nattch === 0
      ? [{ id, owner, nattch }] : [];
  });
}

export const defaultDir = name => join(ROOT, ".rig", name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- process identity ----

/** How `started` is recorded; rig.json carries it so an older, env-dependent file is recognised and refused. */
export const STARTED_CLOCK = "lstart TZ=UTC LC_ALL=C";
/** The fixed env every `ps` call runs with: lstart text must not depend on the caller's TZ or locale (p8-rigv H1). */
export const PS_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" });
/** `ps` by absolute path, never via the caller's PATH (p8-rig2v H2). Tests swap it through `_setPsPath` only. */
const PS_DEFAULT = "/bin/ps";
let psPath = PS_DEFAULT;
/** Test seam (in-process only): called as fn("stale", dir) once a stale up.lock has been judged stale. */
let lockHook = null;
export function _setLockHook(fn) { lockHook = fn ?? null; }
/** Test seam (in-process only, deliberately not an env var): run another `ps`; no argument restores /bin/ps. */
export function _setPsPath(p) { psPath = p ?? PS_DEFAULT; }

/**
 * `ps` view of a PID: null when the PID is absent or a zombie, else { started } (lstart in UTC, C locale, second
 * resolution). Throws when `ps` itself did not run or answered something unexpected: a failed `ps` must never read as
 * "process gone" (p8-rig2v H2). "Absent" is only exit 1 with empty stdout and empty stderr (what /bin/ps does for an
 * unused PID); anything else is a ps failure.
 */
function psInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const r = spawnSync(psPath, ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: PS_ENV, timeout: 10_000 });
  const out = (r.stdout || "").trim(), err = (r.stderr || "").trim();
  const fail = why => new Error(`cannot check processes: ${psPath} ${why}; refusing to guess whether this rig's processes are alive`);
  if (r.error) throw fail(`did not run (${r.error.code ?? r.error.message})`);
  if (r.status === null) throw fail(`was killed by ${r.signal ?? "a signal"}`);
  if (r.status === 1 && !out && !err) return null;
  if (r.status !== 0) throw fail(`exited ${r.status}${err ? ` (${err.split("\n")[0].slice(0, 200)})` : ""}`);
  const m = /^(\S+)\s+(\S+ \S+ +\d+ \d\d:\d\d:\d\d \d{4})$/.exec(out);
  if (!m) throw fail(`gave unexpected output for pid ${pid}`);
  if (m[1].startsWith("Z")) return null;
  return { started: m[2].replace(/\s+/g, " ") };
}
/**
 * Throws unless `ps` works: it must see this very process. Run before anything is signalled or removed, so a `ps` that
 * fails, or one that answers "absent" for everything, refuses up front instead of half-way.
 */
export function psCheck() {
  if (!psInfo(process.pid)) throw new Error(`cannot check processes: ${psPath} does not see this process (pid ${process.pid}); refusing to guess whether this rig's processes are alive`);
}
/** True while the recorded process is still the one this rig started (same PID and same start time). */
export function isOurs(proc) {
  const info = psInfo(proc?.pid);
  return !!info && typeof proc.started === "string" && info.started === proc.started;
}

// ---- Postgres SysV shared memory (p8-rig3 Leaks) ----

// A postmaster that exits cleanly removes its own SysV segment; a SIGKILLed one leaves it behind for good, and macOS
// allows only 32 (kern.sysv.shmmni), after which no Postgres on the machine can start. So whoever SIGKILLs a postmaster
// reads its segment from <pg>/postmaster.pid first (line 7: "<key> <shmid>"; line 1 must be that PID) and, once it is
// gone, removes exactly that segment, and only while nothing is attached to it (NATTCH 0).
const IPC_DEFAULT = { ipcs: "/usr/bin/ipcs", ipcrm: "/usr/bin/ipcrm" };
let ipc = IPC_DEFAULT;
/** Test seam (in-process only): run other ipcs/ipcrm; no argument restores /usr/bin's. */
export function _setIpcPaths(p) { ipc = p ? { ...IPC_DEFAULT, ...p } : IPC_DEFAULT; }

/** { key, id } of the postmaster `pid` running on `pgData`, or null. Read it BEFORE the SIGKILL. */
export function pgShmOf(pgData, pid) {
  let lines;
  try { lines = readFileSync(join(pgData, "postmaster.pid"), "utf8").split("\n"); } catch { return null; }
  if (Number(lines[0]?.trim()) !== pid) return null;
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(lines[6] ?? "");
  return m ? { key: Number(m[1]), id: Number(m[2]) } : null;
}
/**
 * Remove segment `shm` only if ipcs lists that id with that key and NATTCH 0. A backend may still be attached for a
 * moment after its postmaster died (p8-rig3v D): while ipcs lists that exact id and key with NATTCH > 0, look again
 * every 100 ms for up to `waitMs`; any other answer (ipcs failing, the id gone, another key) stops at once. Every try
 * re-checks id, key and NATTCH. Synchronous: callers read the result on the next line. Returns true when removed.
 */
export function removeOrphanShm(shm, { waitMs = 5000 } = {}) {
  if (!shm || !Number.isSafeInteger(shm.id) || !Number.isSafeInteger(shm.key)) return false;
  const until = Date.now() + waitMs;
  while (true) {
    const r = spawnSync(ipc.ipcs, ["-m", "-o"], { encoding: "utf8", env: PS_ENV, timeout: 10_000 });
    if (r.error || r.status !== 0) return false;
    const row = (r.stdout || "").split("\n").map(l => l.trim().split(/\s+/)).find(f => f[0] === "m" && Number(f[1]) === shm.id);
    if (!row || Number.parseInt(row[2], 16) !== shm.key || !/^\d+$/.test(row[6] ?? "")) return false;
    if (row[6] === "0") break;
    if (Date.now() >= until) return false;
    Bun.sleepSync(100);
  }
  const rm = spawnSync(ipc.ipcrm, ["-m", String(shm.id)], { encoding: "utf8", env: PS_ENV, timeout: 10_000 });
  return !rm.error && rm.status === 0;
}

/**
 * PID of a postmaster still running on `pgData` (p8-rig3v A, second line of defence): postmaster.pid's line-1 PID is
 * alive and started within 5 s of line 3 (the postmaster's start, epoch seconds). A PID started at another time is a
 * reused PID, not that postmaster. null when there is no such process.
 */
function livePostmaster(pgData) {
  let lines;
  try { lines = readFileSync(join(pgData, "postmaster.pid"), "utf8").split("\n"); } catch { return null; }
  const pid = Number(lines[0]?.trim());
  const info = psInfo(pid);
  if (!info) return null;
  const at = Number(lines[2]?.trim()), ps = Date.parse(info.started + " UTC");   // lstart is UTC (PS_ENV)
  if (Number.isFinite(at) && Number.isFinite(ps) && Math.abs(ps / 1000 - at) > 5) return null;
  return pid;
}

// ---- rig.json ----

// Paths inside the rig dir are stored relative to it on disk (p8-rig2v L6: a moved rig dir still names its own files)
// and are absolute in memory. A relative path is resolved against the dir the caller names; an absolute one written
// by an older cluster-rig.js is rebased when it lies under the file's recorded `dir`.
function mapPaths(rig, f) {
  const out = { ...rig };
  for (const k of ["tokensFile", "keysFile", "logsDir"]) if (typeof out[k] === "string") out[k] = f(out[k]);
  if (Array.isArray(out.nodes)) out.nodes = out.nodes.map(n => ({ ...n, ...(typeof n.dataDir === "string" ? { dataDir: f(n.dataDir) } : {}), ...(typeof n.log === "string" ? { log: f(n.log) } : {}) }));
  if (Array.isArray(out.procs)) out.procs = out.procs.map(p => typeof p.log === "string" ? { ...p, log: f(p.log) } : p);
  return out;
}
const toDisk = rig => mapPaths(rig, p => isAbsolute(p) && (p === rig.dir || p.startsWith(rig.dir + sep)) ? relative(rig.dir, p) || "." : p);
const fromDisk = (rig, fileDir, dir) => mapPaths(rig, p => !isAbsolute(p) ? join(dir, p)
  : typeof fileDir === "string" && isAbsolute(fileDir) && p.startsWith(fileDir.replace(/\/+$/, "") + sep) ? join(dir, relative(fileDir, p)) : p);

function save(rig) {
  const file = join(rig.dir, "rig.json");   // rig.dir is always the caller's dir (loadRig sets it), never the file's
  writeFileSync(file + ".tmp", JSON.stringify(toDisk(rig), null, 2) + "\n");
  renameSync(file + ".tmp", file);
}
export function readRig(dir) {
  const file = join(dir, "rig.json");
  if (!existsSync(file)) throw new Error(`no rig at ${dir} (rig.json missing)`);
  return JSON.parse(readFileSync(file, "utf8"));
}
/**
 * rig.json for stop/status/kill/reuse: `dir` is the caller's (resolved) dir and overrides the file's `dir`, so a save
 * goes back to the file that was read (p8-rigv M1). An older file without `startedClock` is refused while any recorded
 * PID exists, since its start times cannot be compared safely (p8-rigv H1).
 */
function loadRig(dir) {
  dir = resolve(dir);
  psCheck();
  const raw = readRig(dir);
  const rig = fromDisk(raw, raw.dir, dir);
  rig.dir = dir;
  if (rig.startedClock !== STARTED_CLOCK) {
    const present = (rig.procs ?? []).filter(p => psInfo(p?.pid));
    if (present.length) throw new Error(`rig.json at ${dir} comes from an older cluster-rig.js whose start times depend on the caller's TZ and locale, ` +
      `so it cannot tell whether these processes belong to this rig: ${present.map(p => `${p.name} (pid ${p.pid})`).join(", ")}. ` +
      `Check each one's start time and command with: LC_ALL=C TZ=UTC /bin/ps -o lstart=,command= -p <pid>. Stop the ones that are the rig's, then remove ${dir}`);
  }
  return rig;
}
const writeSecret = (file, text) => { writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600); };

// ---- ports and health ----

async function freePort(taken) {
  for (let i = 0; i < 20; i++) {
    const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = l.port; l.stop(true);
    if (!taken.has(port)) { taken.add(port); return port; }
  }
  throw new Error("could not find a free port");
}
/** True when nothing listens on 127.0.0.1:port (a bind succeeds). */
export function portFree(port) {
  try { const l = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); l.stop(true); return true; } catch { return false; }
}
async function httpOk(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); await r.arrayBuffer(); return r.ok; } catch { return false; }
}

const MINIO_ACCESS = "plenary-rig-local";
const MINIO_SECRET = "plenary-rig-local-secret-key";
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
const hmac = async (key, value) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(value)));
async function createMinioBucket(endpoint, bucket) {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), date = now.slice(0, 8), region = "us-east-1";
  const url = new URL(`/${bucket}`, endpoint), payloadHash = await sha256("");
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${now}\n`;
  const canonical = `PUT\n${url.pathname}\n\n${canonicalHeaders}\nhost;x-amz-content-sha256;x-amz-date\n${payloadHash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${await sha256(canonical)}`;
  const kDate = await hmac(new TextEncoder().encode(`AWS4${MINIO_SECRET}`), date);
  const kRegion = await hmac(kDate, region), kService = await hmac(kRegion, "s3"), kSigning = await hmac(kService, "aws4_request");
  const signature = [...await hmac(kSigning, stringToSign)].map(b => b.toString(16).padStart(2, "0")).join("");
  const response = await fetch(url, { method: "PUT", headers: { "x-amz-date": now, "x-amz-content-sha256": payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${MINIO_ACCESS}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok && response.status !== 409) throw new Error(`minio bucket creation failed (HTTP ${response.status})`);
}

/** Poll `check` until true; fail fast if `proc` died or the rig was aborted; clear timeout error naming the log. */
async function waitFor(check, { what, proc, deadline, abort }) {
  while (true) {
    if (abort?.aborted) throw new Error(`aborted while waiting for ${what}`);
    if (await check()) return;
    if (proc && !isOurs(proc)) throw new Error(`${what}: the process exited before it was ready (log: ${proc.log})`);
    if (Date.now() > deadline) throw new Error(`${what}: not ready after the timeout (log: ${proc?.log ?? "n/a"})`);
    await sleep(100);
  }
}

// ---- spawning ----

/**
 * Spawn one server. Its ChildProcess handle goes into `kids` before anything else can fail: while `up` runs, the
 * handle (not ps) is how its own failure cleanup stops it, since an unreaped child's PID cannot be reused.
 */
function launch(rig, kids, name, argv, { env, cwd, log, abort }) {
  // A signal (or a test's teardown) aborts `up`: never start anything after that (p8-rig3 Leaks).
  if (abort?.aborted) throw new Error(`aborted before starting ${name}`);
  const fd = openSync(log, "a", 0o600);
  let child;
  try { child = cpSpawn(argv[0], argv.slice(1), { env, cwd, detached: true, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  child.on("error", () => {});   // e.g. ENOENT: handled below by the missing pid / health wait
  if (!child.pid) throw new Error(`${name}: could not start ${basename(argv[0])} (log: ${log})`);
  kids.push({ name, child });
  child.unref();
  // With ps working, a null here means the process already exited (or is a zombie): `started: null` is then a dead
  // record, which down skips and the health wait reports. If ps fails, psInfo throws and startRig's cleanup stops
  // this child through its handle.
  const info = psInfo(child.pid);
  const proc = { name, pid: child.pid, started: info?.started ?? null, log };
  rig.procs.push(proc);
  save(rig);
  return proc;
}

/** Stop this `up`'s own children through their handles (no ps needed); last started first, SIGKILL after `graceMs`. */
async function stopKids(kids, graceMs = 10_000, pgData = null) {
  const out = [];
  for (const { name, child } of [...kids].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(r => child.once("exit", () => r(true)));
    try { child.kill(name === "postgres" ? "SIGINT" : "SIGTERM"); } catch {}
    if (!await Promise.race([exited, sleep(graceMs).then(() => false)])) {
      const shm = name === "postgres" && pgData ? pgShmOf(pgData, child.pid) : null;   // before the kill
      try { child.kill("SIGKILL"); } catch {}
      if (await Promise.race([exited, sleep(3000).then(() => false)]) && shm) removeOrphanShm(shm);
    }
    out.push(name);
  }
  return out;
}

// ---- the up lock (p8-rig2v M3) ----

/** One `up` per rig dir: `<dir>/up.lock` holds the owner's { pid, started }; a lock whose owner is gone is stale. */
const LOCK = "up.lock";
function acquireLock(dir) {
  const lock = join(dir, LOCK);
  const me = psInfo(process.pid);
  if (!me) throw new Error(`cannot check processes: ${psPath} does not see this process`);
  const body = JSON.stringify({ pid: process.pid, started: me.started }) + "\n";
  const tmp = join(dir, `${LOCK}.${process.pid}.tmp`);
  writeFileSync(tmp, body);
  try {
    for (let i = 0; i < 5; i++) {
      try { linkSync(tmp, lock); return body; } catch (e) { if (e.code !== "EEXIST") throw e; }   // atomic, complete content
      let text;
      try { text = readFileSync(lock, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      let owner = null;
      try { owner = JSON.parse(text); } catch {}
      if (!owner || !Number.isSafeInteger(owner.pid)) throw new Error(`${lock} is unreadable; if no \`up\` is running on ${dir}, remove that file`);
      if (isOurs(owner)) throw new Error(`another \`up\` (pid ${owner.pid}) is starting the rig at ${dir}; wait for it to finish, or stop it`);
      // Stale (its `up` is gone). Clear it only while holding <dir>/up.lock.break, taken exclusively (p8-rig3v B): only
      // a break-lock holder ever removes up.lock, and no `up` can link a new up.lock while the stale one is there, so
      // up.lock still holding exactly the stale text, read under the break lock, is still that stale lock. Anything
      // else loops back and is judged afresh. A break lock is never cleared automatically: a live owner or a left-over
      // one refuses (never two holders).
      lockHook?.("stale", dir);
      const brk = join(dir, `${LOCK}.break`);
      try { linkSync(tmp, brk); } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let btext;
        try { btext = readFileSync(brk, "utf8"); } catch (e2) { if (e2.code === "ENOENT") continue; throw e2; }
        let b = null;
        try { b = JSON.parse(btext); } catch {}
        if (b && Number.isSafeInteger(b.pid) && isOurs(b)) throw new Error(`another \`up\` (pid ${b.pid}) is clearing a stale lock at ${dir}; wait for it to finish, or stop it`);
        throw new Error(`${brk} was left by an \`up\` that stopped while clearing a stale lock; if no \`up\` is running on ${dir}, remove that file`);
      }
      try {
        let now = null;
        try { now = readFileSync(lock, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (now === text) rmSync(lock, { force: true });
      } finally { rmSync(brk, { force: true }); }
    }
    throw new Error(`could not take ${lock}`);
  } finally { rmSync(tmp, { force: true }); }
}
function releaseLock(dir, body) {
  const lock = join(dir, LOCK);
  try { if (readFileSync(lock, "utf8") === body) rmSync(lock, { force: true }); } catch {}
}
const isLockFile = f => f === LOCK || f.startsWith(LOCK + ".");

function baseEnv(extra) {
  // Explicit and minimal: never process.env, which Bun fills from the checkout's .env.
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C", ...extra };
}

function makeTokens(counts) {
  const tok = () => "rig-" + randomBytes(24).toString("base64url");
  const tokens = { [tok()]: { name: "rig-admin", role: "owner", domain: "rig.test", admin: true } };
  for (const [role, n] of Object.entries(counts)) for (let i = 1; i <= n; i++) tokens[tok()] = { name: `${role}-${i}`, role, domain: "rig.test" };
  return tokens;
}

/**
 * Start a rig. Resolves to the saved rig.json object once Postgres, NATS, every node and the LB answer.
 * On any failure (or `opts.abort.aborted`) it stops everything it started, then throws; the error carries `.rig`.
 * @param {{ name?: string, dir?: string, gateways?: number, hosts?: number, leaseTtlMs?: number, maxConnsPerUser?: number,
 *   nodeCmd?: string[], timeoutMs?: number, logLevel?: string, tokens?: Record<string, number>, abort?: { aborted: boolean },
 *   onStep?: (msg: string) => void }} [opts]
 */
export async function startRig(opts = {}) {
  const name = opts.name ?? "default";
  if (!NAME_RE.test(name)) throw new Error("rig name: a-z, 0-9 and - only, at most 32 characters");
  const dir = resolve(opts.dir ?? defaultDir(name));
  const gateways = opts.gateways ?? 2, hosts = opts.hosts ?? 1;
  if (!(Number.isSafeInteger(gateways) && gateways >= 1 && Number.isSafeInteger(hosts) && hosts >= 0)) throw new Error("need at least 1 gateway and 0 or more hosts");
  const leaseTtlMs = opts.leaseTtlMs ?? 10_000, maxConnsPerUser = opts.maxConnsPerUser ?? 100_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const step = opts.onStep ?? (() => {});
  const missing = missingBins();
  if (missing.length) throw new Error(`missing binaries: ${missing.join(", ")}. Install with: brew install postgresql@17 nats-server minio caddy (Debian/Ubuntu: sudo apt-get install postgresql-17 nats-server minio caddy)`);
  const B = bins();
  psCheck();   // before the dir is touched: a broken ps refuses here (p8-rig2v H2)

  // A rig dir is reused only when it is ours (has rig.json) and nothing in it is still running; one `up` at a time.
  const notRig = () => existsSync(dir) && !existsSync(join(dir, "rig.json")) && readdirSync(dir).some(f => !isLockFile(f));
  if (notRig()) throw new Error(`${dir} exists and is not a rig dir (no rig.json); refusing to use it`);
  mkdirSync(dir, { recursive: true });
  const lockBody = acquireLock(dir);
  try { return await startLocked(); } finally { releaseLock(dir, lockBody); }

  async function startLocked() {
  if (existsSync(join(dir, "rig.json"))) {
    const old = loadRig(dir);
    const live = (old.procs ?? []).filter(isOurs);
    if (live.length) throw new Error(`rig "${old.name}" at ${dir} is still running (${live.map(p => p.name).join(", ")}); run down first`);
    const pm = livePostmaster(join(dir, "pg"));
    if (pm) throw new Error(`a postmaster (pid ${pm}) not recorded in rig.json is still running on ${join(dir, "pg")}; stop it (kill -INT ${pm}) before up`);
    for (const f of readdirSync(dir)) if (!isLockFile(f)) rmSync(join(dir, f), { recursive: true, force: true });
  } else if (notRig()) throw new Error(`${dir} exists and is not a rig dir (no rig.json); refusing to use it`);
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });

  const kids = [];
  const taken = new Set();
  const rig = {
    version: 1, name, dir, startedClock: STARTED_CLOCK, state: "starting", createdAt: new Date().toISOString(), leaseTtlMs, maxConnsPerUser,
    lb: null, tokensFile: join(dir, "tokens.json"), keysFile: join(dir, "keys.json"), logsDir,
    postgres: null, nats: null, nodes: [], procs: [],
  };
  save(rig);

  try {
    // Secrets first, 0600, never printed.
    const keys = { COOKIE_KEY: randomBytes(32).toString("base64url"), SESSION_KEY: randomBytes(32).toString("base64url") };
    writeSecret(rig.keysFile, JSON.stringify(keys, null, 2) + "\n");
    const tokens = makeTokens(opts.tokens ?? { editor: 8, annotator: 32, viewer: 64 });
    writeSecret(rig.tokensFile, JSON.stringify(tokens, null, 2) + "\n");

    // Postgres: TCP on 127.0.0.1 only (no Unix socket: macOS caps its path at 103 bytes), trust auth.
    step("postgres: initdb");
    const pgData = join(dir, "pg");
    const pgLog = join(logsDir, "postgres.log");
    const initFd = openSync(pgLog, "a", 0o600);
    let init;
    try { init = spawnSync(B.initdb, ["-D", pgData, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--no-instructions"],
      { env: baseEnv({}), stdio: ["ignore", initFd, initFd], timeout: 120_000 }); }
    finally { closeSync(initFd); }
    if (init.status !== 0) throw new Error(`initdb failed (log: ${pgLog})`);
    if (opts.abort?.aborted) throw new Error("aborted after initdb");
    const pgPort = await freePort(taken);
    const pg = launch(rig, kids, "postgres", [B.postgres, "-D", pgData, "-p", String(pgPort), "-c", "listen_addresses=127.0.0.1",
      "-c", "unix_socket_directories=", "-c", "max_connections=300", "-c", "fsync=on"], { env: baseEnv({}), cwd: dir, log: pgLog, abort: opts.abort });
    rig.postgres = { port: pgPort, url: `postgres://postgres@127.0.0.1:${pgPort}/plenary` };
    save(rig);
    step("postgres: waiting");
    const admin = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
    await waitFor(async () => {
      const sql = new Bun.SQL({ url: admin, max: 1, connectionTimeout: 1 });
      try { await sql`select 1`; return true; } catch { return false; } finally { await sql.close().catch(() => {}); }
    }, { what: "postgres", proc: pg, deadline, abort: opts.abort });
    { const sql = new Bun.SQL({ url: admin, max: 1 }); try { await sql.unsafe("create database plenary"); } finally { await sql.close(); } }

    // NATS core, 2 MB payloads (PROTOCOL.md § Bus; same values as deploy/cluster/nats.conf).
    step("nats: starting");
    const natsPort = await freePort(taken), natsMon = await freePort(taken);
    const natsConf = join(dir, "nats.conf");
    writeFileSync(natsConf, `# generated by scripts/cluster-rig.js\nlisten: 127.0.0.1:${natsPort}\nhttp: 127.0.0.1:${natsMon}\nmax_payload: 2MB\n`);
    const nats = launch(rig, kids, "nats", [B.nats, "--config", natsConf], { env: baseEnv({}), cwd: dir, log: join(logsDir, "nats.log"), abort: opts.abort });
    rig.nats = { port: natsPort, url: `nats://127.0.0.1:${natsPort}`, monitorPort: natsMon };
    save(rig);
    await waitFor(() => httpOk(`http://127.0.0.1:${natsMon}/healthz`), { what: "nats", proc: nats, deadline, abort: opts.abort });

    // S3-compatible object store. Both ports are probed and the API is loopback-only.
    step("minio: starting");
    const minioPort = await freePort(taken), minioConsolePort = await freePort(taken);
    const minioEndpoint = `http://127.0.0.1:${minioPort}`, bucket = "plenary";
    const blobsDir = join(dir, "blobs");
    mkdirSync(blobsDir, { recursive: true });
    const minio = launch(rig, kids, "minio", [B.minio, "server", blobsDir, "--address", `127.0.0.1:${minioPort}`, "--console-address", `127.0.0.1:${minioConsolePort}`],
      { env: baseEnv({ MINIO_ROOT_USER: MINIO_ACCESS, MINIO_ROOT_PASSWORD: MINIO_SECRET }), cwd: dir, log: join(logsDir, "minio.log"), abort: opts.abort });
    rig.blobs = { url: minioEndpoint, bucket, accessKey: MINIO_ACCESS, secretKey: MINIO_SECRET, consolePort: minioConsolePort };
    save(rig);
    await waitFor(() => httpOk(`${minioEndpoint}/minio/health/ready`), { what: "minio", proc: minio, deadline, abort: opts.abort });
    await createMinioBucket(minioEndpoint, bucket);

    // Nodes.
    const nodeCmd = opts.nodeCmd?.length ? opts.nodeCmd : [BUN, MAIN];
    const plan = [...Array.from({ length: gateways }, (_, i) => ({ id: `gw-${i + 1}`, roles: ["gateway"] })),
                  ...Array.from({ length: hosts }, (_, i) => ({ id: `host-${i + 1}`, roles: ["host"] }))];
    const tokensJson = JSON.stringify(tokens);
    const started = [];
    for (const n of plan) {
      step(`node ${n.id}: starting`);
      const port = await freePort(taken);
      const nodeDir = join(dir, "nodes", n.id), dataDir = join(nodeDir, "data");
      mkdirSync(dataDir, { recursive: true });
      const log = join(logsDir, `${n.id}.log`);
      const env = baseEnv({
        PORT: String(port), HOST: "127.0.0.1", PLENARY_DATA_DIR: dataDir, LOG_LEVEL: opts.logLevel ?? "info",
        PLENARY_NODE_ID: n.id, PLENARY_ROLES: n.roles.join(","), PLENARY_LEASE_TTL_MS: String(leaseTtlMs),
        DATABASE_URL: rig.postgres.url, NATS_URL: rig.nats.url,
        COOKIE_KEY: keys.COOKIE_KEY, SESSION_KEY: keys.SESSION_KEY,
        PLENARY_DEV_TOKENS: tokensJson, PLENARY_MAX_CONNS_PER_USER: String(maxConnsPerUser),
      });
      const proc = launch(rig, kids, `node:${n.id}`, nodeCmd, { env, cwd: nodeDir, log, abort: opts.abort });
      rig.nodes.push({ ...n, port, url: `http://127.0.0.1:${port}`, dataDir, log });
      save(rig);
      started.push({ port, proc, id: n.id });
    }
    for (const s of started) {
      step(`node ${s.id}: waiting`);
      await waitFor(() => httpOk(`http://127.0.0.1:${s.port}/health`), { what: `node ${s.id}`, proc: s.proc, deadline, abort: opts.abort });
    }

    // Load balancer in front of the gateways only; WebSocket upgrades pass through reverse_proxy as is.
    step("lb: starting");
    const lbPort = await freePort(taken);
    const caddyfile = join(dir, "Caddyfile");
    const ups = rig.nodes.filter(n => n.roles.includes("gateway")).map(n => `127.0.0.1:${n.port}`).join(" ");
    writeFileSync(caddyfile, `# generated by scripts/cluster-rig.js; shape of deploy/cluster/Caddyfile
{
	admin off
	auto_https off
	storage file_system ${join(dir, "caddy")}
}

:${lbPort} {
	bind 127.0.0.1
	reverse_proxy ${ups} {
		lb_policy round_robin
		lb_try_duration 5s
		health_uri /health
		health_interval 2s
		health_timeout 1s
		fail_duration 10s
	}
}
`);
    const caddyHome = join(dir, "caddy");
    mkdirSync(caddyHome, { recursive: true });
    const caddy = launch(rig, kids, "caddy", [B.caddy, "run", "--config", caddyfile, "--adapter", "caddyfile"],
      { env: baseEnv({ HOME: caddyHome, XDG_DATA_HOME: caddyHome, XDG_CONFIG_HOME: caddyHome }), cwd: dir, log: join(logsDir, "caddy.log"), abort: opts.abort });
    rig.lb = { port: lbPort, url: `http://127.0.0.1:${lbPort}`, wsUrl: `ws://127.0.0.1:${lbPort}/ws` };
    save(rig);
    await waitFor(() => httpOk(`${rig.lb.url}/health`), { what: "lb (caddy)", proc: caddy, deadline, abort: opts.abort });

    rig.state = "up";
    save(rig);
    step("up");
    return rig;
  } catch (err) {
    step(`failed: ${err.message}; stopping what started`);
    rig.state = "failed";
    // Best effort (p8-rig3v C): the failure may be a save that cannot be written; cleanup must run regardless.
    try { save(rig); } catch {}
    // stopRig stops what rig.json records (it needs a working ps). Then, always (p8-rig3v A), stop this up's own
    // children by their handles, which needs no ps: a child spawned but never recorded (ps failed once right after
    // the spawn, then worked again) is known only by its handle. stopKids skips children that already exited. The
    // first error is the one reported.
    let stopErr = null;
    try { await stopRig(dir, { final: "failed" }); } catch (e) { stopErr = e; }
    const stopped = await stopKids(kids, 10_000, join(dir, "pg"));
    if (stopErr) err.message += `; stopping by rig.json failed (${stopErr.message}), so stopped this up's own children instead: ${stopped.join(", ") || "none running"}`;
    try { err.rig = readRig(dir); } catch {}
    throw err;
  }
  }
}

/**
 * Stop every recorded process that is still ours (same PID and start time), last started first; SIGTERM (SIGINT for
 * Postgres: fast shutdown), then SIGKILL after `graceMs`. Never signals anything not in rig.json.
 * @returns {Promise<{ stopped: string[], gone: string[], forced: string[] }>}
 */
export async function stopRig(rigOrDir, { graceMs = 10_000, final = "down" } = {}) {
  const dir = typeof rigOrDir === "string" ? resolve(rigOrDir) : rigOrDir.dir;
  const rig = loadRig(dir);
  const out = { stopped: [], gone: [], forced: [] };
  for (const proc of [...(rig.procs ?? [])].reverse()) {
    if (!isOurs(proc)) { out.gone.push(proc.name); continue; }
    try { process.kill(proc.pid, proc.name === "postgres" ? "SIGINT" : "SIGTERM"); } catch {}
    const until = Date.now() + graceMs;
    while (isOurs(proc) && Date.now() < until) await sleep(50);
    if (isOurs(proc)) {
      const shm = proc.name === "postgres" ? pgShmOf(join(dir, "pg"), proc.pid) : null;   // before the kill
      try { process.kill(proc.pid, "SIGKILL"); } catch {}
      const hard = Date.now() + 3000;
      while (isOurs(proc) && Date.now() < hard) await sleep(50);
      out.forced.push(proc.name);
      if (shm && !isOurs(proc)) removeOrphanShm(shm);
    }
    out.stopped.push(proc.name);
  }
  rig.state = final;
  save(rig);
  return out;
}

/** rig.json plus `alive` per process and node. */
export function rigStatus(dir) {
  const rig = loadRig(dir);
  const procs = (rig.procs ?? []).map(p => ({ ...p, alive: isOurs(p) }));
  const byName = Object.fromEntries(procs.map(p => [p.name, p]));
  return { ...rig, procs, nodes: rig.nodes.map(n => ({ ...n, pid: byName[`node:${n.id}`]?.pid ?? null, alive: !!byName[`node:${n.id}`]?.alive })) };
}

/** SIGKILL one node by its recorded PID (only while it is still ours). */
export async function killNode(dir, id) {
  const rig = loadRig(dir);
  const proc = (rig.procs ?? []).find(p => p.name === `node:${id}`);
  if (!proc) throw new Error(`no node "${id}" in this rig (nodes: ${rig.nodes.map(n => n.id).join(", ")})`);
  if (!isOurs(proc)) throw new Error(`node ${id} (pid ${proc.pid}) is not running`);
  process.kill(proc.pid, "SIGKILL");
  const until = Date.now() + 5000;
  while (isOurs(proc) && Date.now() < until) await sleep(20);
  if (isOurs(proc)) throw new Error(`node ${id} (pid ${proc.pid}) survived SIGKILL`);
  return { id, pid: proc.pid };
}

// ---- CLI ----

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const [k, v] = a.slice(2).split("=", 2);
    if (["json", "all", "clean"].includes(k)) { o[k] = true; continue; }
    o[k] = v ?? argv[++i];
  }
  return o;
}
const num = (v, flag) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${flag} needs a whole number`); return n; };

function printStatus(s) {
  const pid = name => { const p = s.procs.find(x => x.name === name); return p ? `pid ${p.pid} ${p.alive ? "alive" : "dead"}` : "not started"; };
  const lines = [
    `rig ${s.name}: ${s.state}   dir ${s.dir}`,
    `  lb        ${s.lb ? `${s.lb.url}   ${s.lb.wsUrl}` : "-"}   ${pid("caddy")}`,
    `  postgres  ${s.postgres ? `127.0.0.1:${s.postgres.port}   DATABASE_URL ${s.postgres.url}` : "-"}   ${pid("postgres")}`,
    `  nats      ${s.nats ? s.nats.url : "-"}   ${pid("nats")}`,
    ...s3Env(s).map(line => `  ${line}`),
    ...s.nodes.map(n => `  ${n.id.padEnd(9)} ${n.roles.join(",").padEnd(8)} ${n.url}   ${pid("node:" + n.id)}`),
    `  tokens    ${s.tokensFile}   (0600, PLENARY_DEV_TOKENS format; never printed)`,
    `  logs      ${s.logsDir}`,
    `  lease     PLENARY_LEASE_TTL_MS=${s.leaseTtlMs} on every node`,
  ];
  console.log(lines.join("\n"));
}

function rigDirs() {
  const root = join(ROOT, ".rig");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(root, e.name, "rig.json"))).map(e => join(root, e.name));
}
function missingRigMessage(name, dir) {
  const others = rigDirs().filter(d => d !== dir).map(d => basename(d));
  return `no rig named ${name}${others.length ? `; did you mean --name ${others[0]}?` : ""}`;
}

export function s3Env(s) {
  if (!s.blobs) return [];
  return [`S3_ENDPOINT=${s.blobs.url}`, `S3_BUCKET=${s.blobs.bucket}`, "S3_REGION=us-east-1",
    `S3_ACCESS_KEY_ID=${s.blobs.accessKey}`, `S3_SECRET_ACCESS_KEY=${s.blobs.secretKey}`];
}

async function cli(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const dir = resolve(a.dir ?? defaultDir(a.name ?? "default"));
  if (cmd === "up") {
    const abort = { aborted: false };
    const onSig = () => { abort.aborted = true; };
    // Ctrl-C, kill, or a closed terminal: stop what started, then exit 1 (never leave it running).
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, onSig);
    const nodeCmd = a["node-cmd"] ? a["node-cmd"].split(/\s+/).filter(Boolean) : undefined;
    try {
      await startRig({ name: a.name, dir, gateways: num(a.gateways, "gateways"), hosts: num(a.hosts, "hosts"),
        leaseTtlMs: num(a["lease-ttl-ms"], "lease-ttl-ms"), maxConnsPerUser: num(a["max-conns-per-user"], "max-conns-per-user"),
        timeoutMs: num(a["timeout-ms"], "timeout-ms"), nodeCmd, abort, onStep: m => console.error(`[rig] ${m}`) });
    } catch (err) { console.error(`[rig] up failed: ${err.message}`); return 1; }
    printStatus(rigStatus(dir));
    return 0;
  }
  if (cmd === "status") {
    if (!existsSync(join(dir, "rig.json"))) throw new Error(missingRigMessage(a.name ?? basename(dir), dir));
    const s = rigStatus(dir);
    if (a.json) console.log(JSON.stringify(s, null, 2)); else printStatus(s);
    return 0;
  }
  if (cmd === "kill") {
    const id = a._[1];
    if (!id) throw new Error("usage: kill <node-id>");
    const r = await killNode(dir, id);
    console.log(`killed ${r.id} (pid ${r.pid}) with SIGKILL`);
    return 0;
  }
  if (cmd === "down") {
    const targets = a.all ? rigDirs() : [dir];
    if (!a.all && !existsSync(join(dir, "rig.json"))) throw new Error(missingRigMessage(a.name ?? basename(dir), dir));
    for (const target of targets) {
      const r = await stopRig(target);
      console.log(`rig ${basename(target)} down: stopped ${r.stopped.join(", ") || "nothing"}${r.forced.length ? ` (SIGKILL: ${r.forced.join(", ")})` : ""}${r.gone.length ? `; already gone: ${r.gone.join(", ")}` : ""}`);
      if (a.clean) rmSync(target, { recursive: true, force: true });
    }
    return 0;
  }
  if (cmd === "ls") {
    const rows = [];
    for (const d of rigDirs()) {
      const s = rigStatus(d), live = s.procs.filter(p => p.alive).length;
      if (live) rows.push(`${s.name}\t${live} process(es)\t${d}`);
    }
    console.log(rows.length ? rows.join("\n") : "no live rigs");
    return 0;
  }
  if (cmd === "env") {
    const s = rigStatus(dir);
    console.log([`DATABASE_URL=${s.postgres?.url ?? ""}`, `NATS_URL=${s.nats?.url ?? ""}`, ...s3Env(s)].join("\n"));
    return 0;
  }
  if (cmd === "gc") {
    const user = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8", env: PS_ENV });
    if (user.status !== 0 || !user.stdout.trim()) throw new Error("cannot determine current user for shared-memory cleanup");
    const out = spawnSync(ipc.ipcs, ["-m", "-o"], { encoding: "utf8", env: PS_ENV });
    if (out.status !== 0) throw new Error("ipcs -m -o failed; no segments were removed");
    const segments = parseIpcsSegments(out.stdout, user.stdout.trim());
    for (const segment of segments) {
      const removed = spawnSync(ipc.ipcrm, ["-m", String(segment.id)], { encoding: "utf8", env: PS_ENV });
      if (removed.status !== 0) throw new Error(`ipcrm -m ${segment.id} failed`);
      console.log(`removed shared-memory segment ${segment.id} (owner ${segment.owner}, NATTCH 0)`);
    }
    if (!segments.length) console.log("no unattached shared-memory segments for current user");
    return 0;
  }
  console.error("usage: bun scripts/cluster-rig.js up|status [--json]|kill <node-id>|down [--all] [--clean]|ls|env|gc  (see deploy/cluster/RIG.md)");
  return 2;
}

if (import.meta.main) {
  try { process.exit(await cli(process.argv.slice(2))); }
  catch (err) { console.error(`[rig] ${err.message}`); process.exit(1); }
}
