#!/usr/bin/env bun
// `bun run test:compose`: the three-node cluster test on a container runtime (issue #71). NOT part of `bun test` or
// `bun run test:cluster`: it builds an image and starts nine containers, so it runs only when asked.
//
// It builds deploy/Dockerfile as plenary-c3-<pid>:test, starts deploy/cluster.compose.yml plus the test override
// deploy/cluster.compose.test.yml (random loopback ports, short lease, limits, owner labels) as the Compose project
// plenary-c3-<pid>, and checks, with the real protocol client (test/server/rig.js `client`, packages/protocol Replica):
//   1. sequencing: two editors on two gateways write one board; the Postgres log has no gap and no duplicate;
//   2. fan-out: a viewer on the third node (role viewer, asserted) holds every op, and an op it sends is refused
//      (`forbidden`) and appends nothing;
//   3. five failure cases, each streaming ops from both editors while a node dies by SIGKILL:
//        a. the board's host, which has clients, restarted after a survivor took over (rejoin);
//        b. the board's host again, restarted AT ONCE (the cluster file's `restart: unless-stopped` racing a takeover):
//           the lease epoch only rises and no epoch ever has two holders;
//        b2. all three nodes SIGKILLed, only the old host started: it wins the lease back (deterministic) on the Postgres state;
//        c. the board's host with no client on it (clients moved off first);
//        d. a non-host gateway with clients: no takeover, the lease epoch stays.
//      Every case checks: a live lease at a higher epoch (a, b, c), every op acked before the kill is in the log read
//      right after the takeover (before any resend), then after settling every ack ever seen is in the log at its seq, the
//      log has no gap and no duplicate, and every client's full state (canonical JSON of its elements) equals the state
//      folded from the log. Ops never acked and not in the log are counted and reported (the Replica resends them,
//      so normally none is lost).
// Every wait is a bounded condition (health, lease epoch in Postgres, op counts), never a fixed sleep.
//
// Runtime: docker, else podman (auto-detected; CONTAINER_CLI=<docker|podman|path> forces one). Compose: `docker compose`,
// else `docker-compose`; for podman the socket is found and passed as DOCKER_HOST. No runtime: prints a loud SKIP and
// exits 0 (exit 1 with --require or PLENARY_COMPOSE_REQUIRE=1, for a CI job that must not skip silently).
// Exit codes: 0 pass, 1 fail, 124 the run deadline or a command timed out, 130 interrupted by a signal.
// Cleanup runs on every exit path (pass, fail, timeout, SIGINT/SIGTERM/SIGHUP): `down -v --remove-orphans`, then the
// image is removed, then it checks that nothing labelled with the project, and no image, remains. Everything the run makes
// carries the label plenary.c3.owner = machine id|boot|pid|process start. A run that was SIGKILLed cannot clean itself: the next
// run (or `--sweep`) removes what carries an owner label from THIS host whose owner is provably dead (pid gone, or the pid
// now belongs to a process with another start time; a boot id change alone is no proof); it never touches anything on doubt.
// Usage: bun scripts/test-compose.js [--require] [--sweep] [--keep-image]
import { setPriority, hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { postgresStore } from "../server/store/postgres.js";
import { client, tokenOf } from "../test/server/rig.js";
import { sleep } from "../test/server/helpers.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FILES = ["deploy/cluster.compose.yml", "deploy/cluster.compose.test.yml"];
const NODES = ["app-1", "app-2", "app-3"];
const OWNER_LABEL = "plenary.c3.owner";
const RUN_DEADLINE_MS = 12 * 60_000;   // the whole run, pull and build included: a hung run ends, and cleans up
export const TIMEOUT_CODE = 124, INTERRUPTED_CODE = 130;

// ---- running commands ------------------------------------------------------------------------------------------------

/**
 * Run a command, capture it. `detached` puts it in its own session so a terminal Ctrl-C does not reach it. `signal`
 * kills the child when it aborts (aborted: true, code 130); a timeout kills it too (timedOut: true, code 124).
 */
export async function run(cmd, { env, cwd = ROOT, timeoutMs = 120_000, detached = false, signal } = {}) {
  if (signal?.aborted) return { code: INTERRUPTED_CODE, out: "", err: "", aborted: true, timedOut: false };
  let p;
  try { p = Bun.spawn(cmd, { cwd, env: env ?? process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", ...(detached ? { detached: true } : {}) }); }
  catch (e) { return { code: 127, out: "", err: String(e.message), aborted: false, timedOut: false }; }
  let why = null;
  const stop = reason => { why ??= reason; p.kill("SIGKILL"); };
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const onAbort = () => stop("abort");
  signal?.addEventListener("abort", onAbort, { once: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
  return { code: why === "timeout" ? TIMEOUT_CODE : why === "abort" ? INTERRUPTED_CODE : code, out: out.trim(), err: err.trim(), aborted: why === "abort", timedOut: why === "timeout" };
}

// ---- runtime detection (pure given its probes; test/deploy/compose-test.test.js drives it with fakes) -------------------

/**
 * Pick the container CLI and the Compose command. `probe(cmd)` → { code, out }; `which(name)` → path or null.
 * @returns {Promise<{ cli: string, cliName: string, compose: string[], env: Record<string,string> } | { skip: string }>}
 */
export async function detectRuntime({ env = process.env, which = Bun.which, probe = run, exists = existsSync, platform = process.platform } = {}) {
  const forced = env.CONTAINER_CLI?.trim();
  const candidates = forced ? [forced] : ["docker", "podman"];
  const tried = [];
  for (const c of candidates) {
    const path = c.includes("/") ? (exists(c) ? c : null) : which(c);
    if (!path) { tried.push(`${c}: not found`); continue; }
    const name = basename(path);
    const out = {};
    if (name === "podman" && !env.DOCKER_HOST) {
      // docker-compose talks to podman's API socket: the machine's host socket (macOS) or the user socket (Linux).
      const sock = await podmanSocket({ path, probe, exists, platform });
      if (sock) out.DOCKER_HOST = `unix://${sock}`;
    }
    const hostEnv = { ...env, ...out };
    if ((await probe([path, "info"], { env: hostEnv, timeoutMs: 20_000 })).code !== 0) { tried.push(`${c}: daemon not reachable (\`${name} info\` failed)`); continue; }
    let compose = null;
    if (name === "docker" && (await probe([path, "compose", "version"], { env: hostEnv, timeoutMs: 20_000 })).code === 0) compose = [path, "compose"];
    else if (which("docker-compose")) compose = [which("docker-compose")];
    else if (name === "podman" && (await probe([path, "compose", "version"], { env: hostEnv, timeoutMs: 20_000 })).code === 0) compose = [path, "compose"];
    if (!compose) { tried.push(`${c}: no Compose (need \`docker compose\` or \`docker-compose\`)`); continue; }
    if (name === "podman" && compose[0].endsWith("docker-compose") && !hostEnv.DOCKER_HOST) { tried.push(`${c}: no podman API socket found; set DOCKER_HOST`); continue; }
    return { cli: path, cliName: name, compose, env: out };
  }
  return { skip: `no usable container runtime (${tried.join("; ") || "none tried"}). Install docker or podman with Compose, or set CONTAINER_CLI.` };
}

async function podmanSocket({ path, probe, exists, platform }) {
  if (platform === "darwin") {
    const r = await probe([path, "machine", "inspect", "--format", "{{.ConnectionInfo.PodmanSocket.Path}}"], { timeoutMs: 20_000 });
    return r.code === 0 && r.out && exists(r.out) ? r.out : null;
  }
  const r = await probe([path, "info", "--format", "{{.Host.RemoteSocket.Path}}"], { timeoutMs: 20_000 });
  const p = r.out.replace(/^unix:\/\//, "");
  return r.code === 0 && p && exists(p) ? p : null;
}

/** What to print and exit with when no runtime was found: a loud banner, and 0 (skipped) unless the run must not skip. */
export function skipDecision(reason, requireRun) {
  const bar = "=".repeat(78);
  return { code: requireRun ? 1 : 0, banner: `${bar}\nSKIPPED test:compose: ${reason}\nThe three-node compose cluster test did NOT run.${requireRun ? " (--require: failing)" : ""}\n${bar}` };
}

// ---- who owns a leftover ---------------------------------------------------------------------------------------------

const enc = s => String(s).trim().replace(/[^A-Za-z0-9._-]+/g, "_");
export const alive = (pid, kill = process.kill.bind(process)) => { try { kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };   // EPERM: it exists, it is someone else's
/**
 * A process's start time, comparable across calls (null when unknown: never treated as "another process"). Linux: the boot id
 * plus /proc/<pid>/stat field 22 (clock ticks since boot), exact. Elsewhere: `ps -o lstart` as epoch seconds, compared with
 * a few seconds' tolerance (`sameStart`), because a wall-clock step moves what ps derives from the boot time.
 */
export function processStart(pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];   // field 22; the fields after the ")" of the command name start at field 3
      return ticks ? `linux:${bootId()}:${ticks}` : null;
    }
  } catch { return null; }
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "C" }, stdout: "pipe", stderr: "ignore" });
  const s = r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? `epoch:${Math.floor(t / 1000)}` : s ? enc(s) : null;
}
const START_TOLERANCE_S = 5;
/** Two start times of one process: equal, or (epoch form) within START_TOLERANCE_S seconds. */
export function sameStart(a, b) {
  const x = /^epoch:(\d+)$/.exec(a ?? ""), y = /^epoch:(\d+)$/.exec(b ?? "");
  return x && y ? Math.abs(Number(x[1]) - Number(y[1])) <= START_TOLERANCE_S : a === b;
}
/** The boot id: informational in the label (a boot change alone proves nothing); on Linux part of every start time. */
export function bootId() {
  try {
    if (process.platform === "linux") return enc(readFileSync("/proc/sys/kernel/random/boot_id", "utf8"));
    const r = Bun.spawnSync(["sysctl", "-n", "kern.boottime"], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? enc(new TextDecoder().decode(r.stdout)) : "unknown";
  } catch { return "unknown"; }
}
/** A machine id that survives a hostname change: macOS IOPlatformUUID, Linux /etc/machine-id, else the hostname. */
export function machineId() {
  try {
    if (process.platform === "linux") return enc(readFileSync("/etc/machine-id", "utf8"));
    if (process.platform === "darwin") {
      const r = Bun.spawnSync(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], { stdout: "pipe", stderr: "ignore" });
      const m = /"IOPlatformUUID" = "([^"]+)"/.exec(new TextDecoder().decode(r.stdout));
      if (m) return enc(m[1]);
    }
  } catch { /* fall through */ }
  return enc(hostname());
}
export const ownerString = (pid, { host = machineId(), boot = bootId(), start = processStart(pid) ?? "unknown" } = {}) => `${host}|${boot}|${pid}|${start}`;
export function parseOwner(s) {
  const m = /^([^|]+)\|([^|]+)\|(\d+)\|([^|]+)$/.exec(s ?? "");
  return m ? { host: m[1], boot: m[2], pid: Number(m[3]), start: m[4] } : null;
}
/**
 * True only when `owner` is from this machine and provably gone: not `self`, and its pid is dead or now runs a process with
 * another start time. A boot id that differs proves nothing alone (a clock step shifts it while the run lives). Doubt
 * (another machine, an unknown start time) is false.
 */
export function ownerDead(owner, self, { host, isAlive = alive, startOf = processStart }) {
  if (!owner || owner.host !== host) return false;
  if (self && ownerString(owner.pid, owner) === self) return false;
  if (!isAlive(owner.pid)) return true;
  const now = startOf(owner.pid);
  return now !== null && !sameStart(now, owner.start);
}

const GET = k => `{{index .${k} "${OWNER_LABEL}"}}`;
const KINDS = [   // removal order: containers first, then what they used
  { kind: "container", list: ["ps", "-a", "-q"], inspect: ["inspect", "--format", GET("Config.Labels")], rm: ["rm", "-f", "-v"] },
  { kind: "network", list: ["network", "ls", "-q"], inspect: ["network", "inspect", "--format", GET("Labels")], rm: ["network", "rm"] },
  { kind: "volume", list: ["volume", "ls", "-q"], inspect: ["volume", "inspect", "--format", GET("Labels")], rm: ["volume", "rm", "-f"] },
  { kind: "image", list: ["images", "-q"], inspect: ["image", "inspect", "--format", GET("Config.Labels")], rm: ["rmi", "-f"] },
];

/**
 * Remove what runs of this host left behind: every container, network, volume and image labelled plenary.c3.owner whose owner
 * is provably dead (`ownerDead`). `cli(args)` → { code, out } runs the container CLI. Never touches `self`, a live owner or
 * another host's. Found by label (not by name), so a reused pid's leftovers, image included, are swept as well.
 * @returns {Promise<string[]>} what it removed, or could not remove
 */
export async function sweep(cli, self, deps = {}, isAborted = () => false) {
  const d = { host: machineId(), isAlive: alive, startOf: processStart, ...deps };
  const byOwner = new Map();
  for (const k of KINDS) {
    const listed = await cli([...k.list, "--filter", `label=${OWNER_LABEL}`]);
    if (listed.code !== 0) continue;
    for (const id of new Set(listed.out.split("\n").map(x => x.trim()).filter(Boolean))) {
      const label = await cli([...k.inspect, id]);
      if (label.code !== 0 || !parseOwner(label.out.trim())) continue;
      const key = label.out.trim();
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push({ ...k, id });
    }
  }
  const done = [];
  for (const [key, items] of byOwner) {
    if (isAborted()) break;
    if (!ownerDead(parseOwner(key), self, d)) continue;
    const counts = {}, failed = [];
    for (const k of KINDS) for (const it of items.filter(i => i.kind === k.kind)) {
      const r = await cli([...k.rm, it.id]);
      if (r.code === 0) counts[k.kind] = (counts[k.kind] ?? 0) + 1; else failed.push(`${k.kind} ${it.id}`);
    }
    done.push(`pid ${parseOwner(key).pid}: ${Object.entries(counts).map(([a, n]) => `${n} ${a}`).join(", ") || "nothing"}${failed.length ? ` (could not remove: ${failed.join(", ")})` : ""}`);
  }
  return done;
}

// ---- the stack -------------------------------------------------------------------------------------------------------

let aborted = null;   // why the run was interrupted (a signal, or the deadline), if it was
const ac = new AbortController();
const abortRun = why => { aborted ??= why; ac.abort(); };
const say = msg => console.log(`[test:compose] ${msg}`);
class Fatal extends Error {}   // an assertion or a hard failure: a wait never retries past it
const fail = msg => { throw new Fatal(msg); };

/** Polls `fn` until truthy; bounded, abortable, says what it waited for. A Fatal thrown by `fn` ends the wait at once. */
async function waitFor(what, fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    if (aborted) fail(`interrupted by ${aborted} while waiting for ${what}`);
    let v; try { v = await fn(); } catch (e) { if (e instanceof Fatal || Date.now() > end) throw e; v = null; }
    if (v) return v;
    if (Date.now() > end) fail(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}
/** Turns a command result into a Fatal: interrupted, timed out or failed, each said as such. */
function must(r, what) {
  if (r.aborted) fail(`interrupted by ${aborted}: ${what}`);
  if (r.timedOut) fail(`${what} timed out`);
  if (r.code !== 0) fail(`${what} failed (exit ${r.code}):\n${(r.err || r.out).slice(-1500)}`);
  return r;
}

class Stack {
  constructor(rt, pid, owner = ownerString(pid)) {
    this.rt = rt; this.pid = pid; this.owner = owner;
    this.project = `plenary-c3-${pid}`; this.image = `plenary-c3-${pid}:test`;
    this.built = false; this.started = false; this.ports = {};
    this.pw = randomBytes(9).toString("hex");
    this.env = { ...process.env, ...rt.env, C3_OWNER: owner, POSTGRES_PASSWORD: this.pw, MINIO_ROOT_USER: "c3" + randomBytes(4).toString("hex"), MINIO_ROOT_PASSWORD: randomBytes(12).toString("hex"),
      COOKIE_KEY: randomBytes(32).toString("hex"), PLENARY_IMAGE: this.image, PLENARY_DEV_TOKENS: JSON.stringify(Object.fromEntries(
        ["ed1", "ed2", "view", "late"].map(n => [tokenOf(n), { name: n, email: `${n}@cluster.test`, domain: "cluster.test", ...(n === "view" ? {} : { admin: true }) }]))) };
    delete this.env.DATABASE_URL; delete this.env.NATS_URL;   // never inherit another stack's
  }
  // Teardown passes `detached` (shielded from Ctrl-C, and from the abort signal); everything else is killed when the run aborts.
  compose(args, o = {}) { return run([...this.rt.compose, "-p", this.project, ...FILES.flatMap(f => ["-f", f]), ...args], { env: this.env, ...(o.detached ? {} : { signal: ac.signal }), ...o }); }
  cli(args, o = {}) { return run([this.rt.cli, ...args], { env: this.env, ...(o.detached ? {} : { signal: ac.signal }), ...o }); }

  async build() {
    if ((await this.cli(["image", "inspect", this.image])).code === 0) fail(`image ${this.image} already exists; refusing to overwrite and delete it`);
    this.built = true;
    const fmt = this.rt.cliName === "podman" ? ["--format", "docker"] : [];   // podman drops HEALTHCHECK in OCI format
    const rev = (await run(["git", "rev-parse", "HEAD"])).out || "unknown";
    must(await this.cli(["build", ...fmt, "--label", `${OWNER_LABEL}=${this.owner}`, "-f", "deploy/Dockerfile", "--build-arg", "VERSION=c3", "--build-arg", `REVISION=${rev}`, "-t", this.image, "."], { timeoutMs: 420_000 }), "image build");
  }
  async up() {
    this.started = true;
    must(await this.compose(["up", "-d", "--no-build", "--pull", "missing", "postgres", "nats", "blobs", "blobs-init", "image-build", ...NODES], { timeoutMs: 420_000 }), "compose up");
  }
  /** The host port Compose published for `service`:`inner` (re-read after a restart: it changes). */
  async port(service, inner) {
    const r = await this.compose(["port", service, String(inner)]);
    const m = /:(\d+)\s*$/.exec(r.out.split("\n")[0] ?? "");
    if (r.aborted) fail(`interrupted by ${aborted}`);
    if (r.code !== 0 || !m) fail(`no published port for ${service}:${inner}: ${r.err || r.out}`);
    return (this.ports[service] = Number(m[1]));
  }
  async healthy(service) {
    const port = await this.port(service, 8080);
    await waitFor(`${service} /health`, async () => (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([AbortSignal.timeout(2000), ac.signal]) })).ok, 90_000, 250);
    return port;
  }
  async logs(tail = 25) {
    const r = await this.compose(["logs", "--no-color", "--tail", String(tail)], { timeoutMs: 60_000, detached: true });
    return r.out || r.err;
  }
  /** What is left of this run: Compose containers, volumes, networks (by project label) and the image. */
  async leftovers() {
    const label = `label=com.docker.compose.project=${this.project}`;
    const found = [];
    for (const [kind, args] of [["container", ["ps", "-a", "-q", "--filter", label]], ["volume", ["volume", "ls", "-q", "--filter", label]], ["network", ["network", "ls", "-q", "--filter", label]]]) {
      const r = await this.cli(args, { detached: true });
      if (r.code !== 0) found.push(`${kind}: could not list (${r.err.slice(0, 100)})`);
      else for (const l of r.out.split("\n").filter(Boolean)) found.push(`${kind} ${l}`);
    }
    if ((await this.cli(["image", "inspect", this.image], { detached: true })).code === 0) found.push(`image ${this.image}`);
    return found;
  }
  /** Teardown, shielded from a terminal Ctrl-C and the abort signal. Returns what is still left (empty = clean). */
  async teardown(keepImage = false) {
    const opts = { detached: true, timeoutMs: 180_000 };
    let left = [], why = "";
    if (this.started || (await this.leftovers()).length) {
      for (let attempt = 1; attempt <= 3; attempt++) {   // `down` can stop partway when something was mid-change: run it again until nothing is left
        const r = await this.compose(["down", "-v", "--remove-orphans", "-t", "3"], opts);
        why = `exit ${r.code}${r.timedOut ? " (timed out)" : ""}: ${(r.err || r.out).slice(-300)}`;
        if (!(left = await this.leftovers()).length) break;
      }
    }
    if (left.length) {   // last resort: remove what carries the project label directly
      const label = `label=com.docker.compose.project=${this.project}`;
      for (const [list, rm] of [[["ps", "-a", "-q"], ["rm", "-f", "-v"]], [["network", "ls", "-q"], ["network", "rm"]], [["volume", "ls", "-q"], ["volume", "rm", "-f"]]]) {
        const ids = (await this.cli([...list, "--filter", label], opts)).out.split("\n").filter(Boolean);
        if (ids.length) await this.cli([...rm, ...ids], opts);
      }
    }
    if (this.built && !keepImage) await this.cli(["rmi", "-f", this.image], opts);
    left = await this.leftovers();
    return left.length && why ? [...left, `(last down said: ${why})`] : left;
  }
}

// ---- the scenario ----------------------------------------------------------------------------------------------------

const rect = (id, k) => ({ id, type: "rectangle", version: 1, versionNonce: k, x: k, y: 0, width: 1, height: 1, isDeleted: false });
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** JSON with every object's keys sorted: equal states give equal strings whatever order the keys were made in. */
const canon = v => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const elementsOf = e => e.op?.elements ?? e.elements ?? [];

async function scenario(stack, report) {
  const T0 = Date.now();
  const nodes = Object.fromEntries(NODES.map(n => [n, { alive: true, port: 0 }]));
  for (const n of NODES) nodes[n].port = await stack.healthy(n);
  report.healthySeconds = Math.round((Date.now() - T0) / 100) / 10;
  say(`nodes healthy ${report.healthySeconds}s after compose up: ${NODES.map(n => `${n}:${nodes[n].port}`).join(" ")}, postgres:${await stack.port("postgres", 5432)}`);

  // The board: made on app-1 by ed1, Unit members are viewers on it; ed2 and late are granted editor.
  const api = (node, who, method, path, body) => fetch(`http://127.0.0.1:${nodes[node].port}${path}`, { method, headers: { authorization: `Bearer ${tokenOf(who)}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([AbortSignal.timeout(10_000), ac.signal]) });
  const made = await api("app-1", "ed1", "POST", "/boards", { title: "compose3", memberRole: "viewer" });
  if (made.status !== 201) fail(`POST /boards: ${made.status} ${await made.text()}`);
  const { board } = await made.json();
  for (const [who, role] of [["ed2", "editor"], ["late", "editor"]]) {
    const r = await api("app-1", "ed1", "PUT", `/boards/${board.id}/grants/dev:${who}`, { role });
    if (r.status !== 204) fail(`grant ${who}: ${r.status} ${await r.text()}`);
  }

  const pg = await postgresStore({ url: `postgres://plenary:${stack.pw}@127.0.0.1:${stack.ports.postgres}/plenary`, max: 2 });
  const clients = [];
  let keepAlive = null, ticker = null;
  try {
    const lease = () => pg.lease(board.tenant, board.id);
    const readLog = async () => { const log = []; for (;;) { const page = await pg.read(board.tenant, board.id, log.length + 1, 1000); if (!page.length) break; log.push(...page); } return log; };
    const lastSeq = () => pg.lastSeq(board.tenant, board.id);
    const nodeOf = holder => NODES.find(n => holder?.startsWith(n));

    // A client prefers its home node and falls back to the next live one; `client()` reads wsUrl at every (re)connect.
    const mk = (name, home) => {
      const order = () => { const i = NODES.indexOf(c.homeNode); return [...NODES.slice(i), ...NODES.slice(0, i)].filter(n => nodes[n].alive); };
      const fake = { server: { get wsUrl() { const n = order()[0]; c.lastNode = n ?? null; return n ? `ws://127.0.0.1:${nodes[n].port}/ws` : "ws://127.0.0.1:1/ws"; } }, ids: { board: board.id } };
      const c = client(fake, name, name, { board: board.id, maxWaitMs: 250 });
      c.homeNode = home; c.lastNode = null; c.lastTry = 0;
      c.at = () => (c.open ? c.lastNode : null);
      clients.push(c);
      return c;
    };
    // Keeps every client connected: one whose socket is gone and is not already reconnecting tries again.
    keepAlive = setInterval(() => {
      for (const c of clients) {
        if (c.open) continue;
        const idle = Date.now() - c.lastTry;
        // A connect that never settles (a socket that closed before it opened raises no error) is abandoned after 15 s.
        if (c.busy && idle > 15_000) { c.connecting = null; c.reconnecting = null; }
        if (!c.busy && idle > 300) { c.lastTry = Date.now(); c.reconnect().catch(() => {}); }
      }
    }, 100);
    const ed1 = mk("ed1", "app-1"), ed2 = mk("ed2", "app-2"), view = mk("view", "app-3");
    for (const c of [ed1, ed2, view]) c.connect().catch(() => {});
    await waitFor("three clients welcomed", () => [ed1, ed2, view].every(c => c.open && c.r.welcomed), 60_000);
    for (const c of [ed1, ed2, view]) say(`${c.name} -> ${c.at()} role=${c.r.role}`);
    if (view.r.role !== "viewer") fail(`the viewer's welcome says role ${view.r.role}, not viewer`);

    // Every op made, and every ack ever seen (first seq kept; a later ack of the same id must agree: Fatal, never retried).
    const made_ = new Map(), acked = new Map();
    const harvest = () => { for (const c of clients) for (const m of c.msgs) if (m.t === "ack") { if (acked.has(m.id) && acked.get(m.id) !== m.seq) fail(`op ${m.id} acked at seq ${acked.get(m.id)} then ${m.seq}`); acked.set(m.id, m.seq); } };
    let k = 0;
    const emit = (c, n = 1) => { for (let i = 0; i < n; i++) { const id = `${c.name}-${++k}`; const m = c.send("board", { elements: [rect(id, k)] }); made_.set(m.id, id); } };
    const startGen = () => { ticker = setInterval(() => { if (!aborted) { emit(ed1, 3); emit(ed2, 3); } }, 100); };
    const stopGen = () => { clearInterval(ticker); ticker = null; };
    const settled = async (cs, what, ms) => {
      let want = 0;
      try { await waitFor(what, async () => { want = await lastSeq(); return cs.every(c => c.open && !c.busy && !c.r.resync && c.r.welcomed && c.r.pending.size === 0 && c.r.applied === want); }, ms, 150); }
      catch (e) { if (!(e instanceof Fatal)) throw e; fail(`${e.message}; PG last seq ${want}; ${JSON.stringify(cs.map(c => ({ c: c.name, at: c.at(), open: c.open, busy: c.busy, resync: c.r.resync, welcomed: c.r.welcomed, pending: c.r.pending.size, applied: c.r.applied, errors: c.errors.slice(-2).map(x => x.code) })))}`); }
      return want;
    };
    const stateOf = c => canon(c.r.state().board.elements.slice().sort(byId));
    const PROBE = `${view.r.client}:1`;   // an op id of the viewer's own client, so the gateway judges the role, not the id

    /** The log invariants, then every client's whole state against the state folded from the log. Returns the log. */
    const verify = async (label, cs) => {
      harvest();
      const log = await readLog();
      log.forEach((e, i) => { if (e.seq !== i + 1) fail(`${label}: gap or duplicate seq at index ${i}: ${e.seq}`); });
      const seqOf = new Map(log.map(e => [e.id, e.seq]));
      if (seqOf.size !== log.length) fail(`${label}: an op id appears twice in the log`);
      if (seqOf.has(PROBE)) fail(`${label}: the viewer's refused op is in the log`);
      const lost = [...acked].filter(([id, seq]) => seqOf.get(id) !== seq);
      if (lost.length) fail(`${label}: ACKED OPS LOST OR MOVED: ${JSON.stringify(lost.slice(0, 5))} (${lost.length} of ${acked.size})`);
      const want = canon(log.flatMap(elementsOf).sort(byId));
      if (want === "[]" || log.length === 0) fail(`${label}: the log holds no elements (entry shape: ${JSON.stringify(log[0])})`);
      for (const c of cs) {
        const got = stateOf(c);
        if (got !== want) fail(`${label}: ${c.name}'s state differs from the log's (${c.r.state().board.elements.length} elements vs ${log.flatMap(elementsOf).length}); first diff near: ${[...got].findIndex((ch, i) => ch !== want[i])}\nclient ${got.slice(0, 300)}\nlog    ${want.slice(0, 300)}`);
      }
      return log;
    };

    // 1. sequencing and fan-out, before any failure.
    for (let i = 0; i < 30; i++) { emit(ed1); emit(ed2); }
    const seq1 = await settled([ed1, ed2, view], "phase 1: both editors and the viewer hold 60 entries", 60_000);
    const log1 = await verify("phase 1", [ed1, ed2, view]);
    if (seq1 !== 60 || log1.length !== 60) fail(`phase 1: expected 60 entries, PG has ${log1.length} (last seq ${seq1})`);
    // The viewer is a non-writer: an op it sends is refused and appends nothing.
    const before = view.msgs.length;
    view.s.send({ t: "op", id: PROBE, sentAt: 0, stream: "board", op: { elements: [rect("viewer-probe", 9999)] } });
    const refusal = await waitFor("the viewer's op to be refused", () => view.msgs.slice(before).find(m => m.t === "error"), 15_000, 25);
    if (refusal.code !== "forbidden") fail(`the viewer's op got error ${refusal.code}, not forbidden`);
    if (await lastSeq() !== 60) fail("the viewer's refused op was appended to the log");
    report.viewerRefused = refusal.code;
    const l0 = await lease();
    if (!l0?.live) fail(`no live lease after phase 1: ${JSON.stringify(l0)}`);
    say(`phase 1 ok: 60 entries, no gap, viewer (role viewer) on ${view.at() ?? "its node"} holds all and its op was refused (${refusal.code}); ${nodeOf(l0.holder)} hosts the board at epoch ${l0.epoch}`);
    report.phase1 = { entries: 60, host: nodeOf(l0.holder), epoch: l0.epoch };

    // 2. failure cases.
    report.cases = [];
    const restart = async victim => {
      must(await stack.compose(["start", victim]), `start ${victim}`);
      nodes[victim].port = await stack.healthy(victim);
      nodes[victim].alive = true;
    };
    /**
     * Stream ops from both editors, SIGKILL `victim`, and check what the case promises. `takeover`: the victim is the host, so
     * a live lease at a higher epoch must follow. `restartMode`: "after" the takeover, or "now" (right after the kill).
     * `killAll` (with "now"): all three nodes are SIGKILLed, then only the victim is started: nobody else can take the lease, so
     * the restarted node wins it deterministically (the whole cluster restarting on the Postgres state); the others are
     * started once it holds the lease.
     * A poller records every holder/epoch the lease shows (every 50 ms) for the whole case.
     */
    const killCase = async ({ label, victim, takeover, restartMode, killAll = false }) => {
      const L0 = await lease();
      const host0 = nodeOf(L0.holder);
      if (takeover && host0 !== victim) fail(`${label}: wanted to kill the host ${victim} but ${host0} holds the lease`);
      if (!takeover && host0 === victim) fail(`${label}: ${victim} is the host, not a plain gateway`);
      const withClients = clients.filter(c => c.at() === victim).map(c => c.name);
      say(`${label}: host ${host0} (epoch ${L0.epoch}); killing ${victim}, which has clients [${withClients.join(", ")}]`);
      startGen();
      let e1 = null;
      const seen = [];
      let polling = false;
      const watch = async () => { const l = await lease(); if (l) { const last = seen.at(-1); if (!last || last.epoch !== l.epoch || last.holder !== l.holder) seen.push({ epoch: l.epoch, holder: l.holder }); } return l; };
      const poller = setInterval(async () => { if (polling) return; polling = true; try { await watch(); } catch { /* the waits judge a dead database */ } finally { polling = false; } }, 50);
      try {
        const a0 = (harvest(), acked.size);
        await waitFor("20 more acks while streaming", () => (harvest(), acked.size >= a0 + 20), 30_000, 50);
        await waitFor("ops in flight on the editors", () => [ed1, ed2].some(c => c.r.pending.size > 0), 10_000, 20);   // 30 ops/s each is above the client's send pace
        harvest();
        const ackedBeforeKill = new Map(acked);
        const inflightBeforeKill = [ed1, ed2].reduce((a, c) => a + c.r.pending.size, 0);
        must(await stack.compose(["kill", "-s", "SIGKILL", ...(killAll ? NODES : [victim])]), `kill ${killAll ? "every node" : victim}`);
        if (killAll) { stopGen(); for (const n of NODES) nodes[n].alive = false; }   // the outage lasts until the restarted node is up: ops made meanwhile would only pile up in the clients
        const killedAt = Date.now();
        nodes[victim].alive = false;
        const inflightAtKill = [ed1, ed2].reduce((a, c) => a + c.r.pending.size, 0);   // sampled as the kill returns
        if (restartMode === "now") must(await stack.compose(["start", victim]), `start ${victim} at once`);   // `restart: unless-stopped` racing the takeover
        let takeoverMs = null;
        if (takeover) {
          if (killAll) { nodes[victim].port = await stack.healthy(victim); nodes[victim].alive = true; }   // clients reconnect to it: a board is hosted once someone asks
          e1 = await waitFor("the board's lease to be live at a higher epoch", async () => { const l = await watch(); return l?.live && l.epoch > L0.epoch && (killAll ? nodeOf(l.holder) === victim : restartMode === "now" || nodeOf(l.holder) !== victim) ? l : null; }, 90_000, 50);
          takeoverMs = Date.now() - killedAt;
          say(`${label}: ${nodeOf(e1.holder)} holds the lease at epoch ${e1.epoch}, ${takeoverMs} ms after the kill`);
          // Everything acked before the kill is durable already: it is in the log now, before any client resends anything.
          const atTakeover = new Map((await readLog()).map(e => [e.id, e.seq]));
          const gone = [...ackedBeforeKill].filter(([id, seq]) => atTakeover.get(id) !== seq);
          if (gone.length) fail(`${label}: ops acked before the kill are missing from the log read at the takeover: ${JSON.stringify(gone.slice(0, 5))} (${gone.length} of ${ackedBeforeKill.size})`);
        }
        if (killAll) { for (const n of NODES.filter(x => x !== victim)) await restart(n); emit(ed1, 5); emit(ed2, 5); }
        else { const target = made_.size + 10; await waitFor("10 more ops made after the failure", () => made_.size >= target, 20_000, 50); }
        stopGen();
        if (restartMode === "now") { if (!nodes[victim].alive) { nodes[victim].port = await stack.healthy(victim); nodes[victim].alive = true; } }
        else await restart(victim);
        const all = clients.slice();
        const seq = await settled(all, `${label}: every client connected, nothing pending, all applied to the log's end`, 90_000);
        const log = await verify(label, all);
        const l2 = await watch();
        clearInterval(poller);
        const holders = new Map();
        for (const s of seen) { if (holders.has(s.epoch) && holders.get(s.epoch) !== s.holder) fail(`${label}: epoch ${s.epoch} had two holders: ${holders.get(s.epoch)} and ${s.holder}`); holders.set(s.epoch, s.holder); }
        if (seen.some((s, i) => i && s.epoch < seen[i - 1].epoch)) fail(`${label}: the lease epoch fell: ${JSON.stringify(seen)}`);
        if (!takeover && (l2.epoch !== L0.epoch || l2.holder !== L0.holder)) fail(`${label}: a non-host died but the lease moved: ${L0.holder}@${L0.epoch} -> ${l2.holder}@${l2.epoch}`);
        const c = { label, victim, victimHadClients: withClients, hostBefore: host0, epochBefore: L0.epoch, epochAfter: l2.epoch, holderAfter: l2.holder, takeoverMs, leaseHistory: seen,
          ackedBeforeKill: ackedBeforeKill.size, inflightBeforeKill, inflightAtKill, opsMade: made_.size, acked: acked.size, inLog: log.length, neverAckedLost: [...made_.keys()].filter(id => !log.some(e => e.id === id)).length, finalSeq: seq };
        report.cases.push(c);
        say(`${label} ok: ${made_.size} ops made, ${acked.size} acked (${ackedBeforeKill.size} before the kill; in flight ${inflightBeforeKill} just before, ${inflightAtKill} as the kill returned), ${log.length} in the log, 0 acked lost, ${c.neverAckedLost} never-acked lost, lease ${host0}@${L0.epoch} -> ${nodeOf(l2.holder)}@${l2.epoch}; all clients equal the log`);
      } finally { stopGen(); clearInterval(poller); }
    };

    const hostNow = async () => { const l = await waitFor("a live lease", async () => { const x = await lease(); return x?.live ? x : null; }, 30_000, 100); return nodeOf(l.holder); };

    // a. the host, with clients on it; restarted after the takeover; then a client on the rejoined node.
    await killCase({ label: "case a (host with clients, restart after takeover)", victim: await hostNow(), takeover: true, restartMode: "after" });
    const rejoined = report.cases[0].victim;
    const late = mk("late", rejoined);
    late.connect().catch(() => {});
    await waitFor("the rejoined node to welcome a new client", () => late.open && late.r.welcomed, 60_000);
    say(`rejoin: ${late.name} -> ${late.at()} (the node killed in case a) role=${late.r.role}`);
    emit(late);
    await settled(clients, "a client on the rejoined node writes and everyone converges", 60_000);
    await verify("rejoin", clients);

    // b. the host again, restarted at once.
    await killCase({ label: "case b (host, restarted at once: restart racing takeover)", victim: await hostNow(), takeover: true, restartMode: "now" });

    // b2. the restarted node wins the lease back: every node is killed and only the victim is started.
    await killCase({ label: "case b2 (whole cluster killed, only the host restarted: it wins the lease back)", victim: await hostNow(), takeover: true, restartMode: "now", killAll: true });

    // c. the host with no client on it: move every client off it first.
    const h = await hostNow();
    const elsewhere = NODES.filter(n => n !== h);
    clients.forEach((c, i) => { if (c.lastNode === h || c.homeNode === h) c.homeNode = elsewhere[i % elsewhere.length]; });
    for (const c of clients) if (c.at() === h) await c.reconnect().catch(() => {});
    await waitFor(`no client left on the host ${h}`, () => clients.every(c => c.open && c.at() !== h), 30_000, 100);
    await killCase({ label: "case c (host with no client)", victim: h, takeover: true, restartMode: "after" });

    // d. a non-host gateway that has clients.
    const h2 = await hostNow();
    const gw = NODES.find(n => n !== h2 && nodes[n].alive);
    for (const c of [ed1, view]) { c.homeNode = gw; if (c.at() !== gw) await c.reconnect().catch(() => {}); }   // explicit: a plain gateway that has clients
    await waitFor(`ed1 and view on ${gw}`, () => [ed1, view].every(c => c.open && c.at() === gw), 30_000, 100);
    await killCase({ label: "case d (non-host gateway with clients)", victim: gw, takeover: false, restartMode: "after" });
  } finally {
    clearInterval(keepAlive); clearInterval(ticker);
    for (const c of clients) await c.drop().catch(() => {});
    await pg.close().catch(() => {});
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------

async function main() {
  // Signal handlers first: a Ctrl-C during the sweep or the build must still reach the cleanup below.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => abortRun(sig));
  const args = new Set(process.argv.slice(2));
  const rt = await detectRuntime();
  if (rt.skip) {
    const d = skipDecision(rt.skip, args.has("--require") || process.env.PLENARY_COMPOSE_REQUIRE === "1");
    console.error(d.banner);
    return d.code;
  }
  try { setPriority(19); } catch { /* best effort */ }
  say(`runtime: ${rt.cliName}, compose: ${basename(rt.compose.join(" "))}${rt.env.DOCKER_HOST ? ` via ${rt.env.DOCKER_HOST}` : ""}`);
  const stack = new Stack(rt, process.pid);
  const swept = await sweep(args => stack.cli(args, { timeoutMs: 60_000 }), stack.owner, {}, () => !!aborted);
  if (swept.length) say(`swept leftovers of dead runs: ${swept.join("; ")}`);
  if (aborted) return INTERRUPTED_CODE;
  if (args.has("--sweep")) return 0;

  const report = { project: stack.project, runtime: rt.cliName, owner: stack.owner };
  let code = 1, left = [];
  const deadline = setTimeout(() => abortRun("the run deadline"), RUN_DEADLINE_MS);
  const t0 = Date.now();
  try {
    const stale = await stack.leftovers();
    if (stale.length) fail(`project ${stack.project} already has resources an owner that may be alive made: ${stale.join(", ")}`);
    await stack.build();
    report.buildSeconds = Math.round((Date.now() - t0) / 100) / 10;
    await stack.up();
    await scenario(stack, report);
    code = 0;
  } catch (e) {
    console.error(`[test:compose] FAILED: ${e.message}`);
    if (stack.started) console.error(`--- container logs (last lines) ---\n${(await stack.logs()).slice(-6000)}`);
    if (aborted) code = aborted === "the run deadline" ? TIMEOUT_CODE : INTERRUPTED_CODE;
    else if (/timed out/.test(e.message)) code = TIMEOUT_CODE;
  } finally {
    clearTimeout(deadline);
    left = await stack.teardown(args.has("--keep-image")).catch(e => [`teardown failed: ${e.message}`]);
  }
  report.cleanup = left.length ? { left } : "nothing with the project label or image tag remains";
  report.totalSeconds = Math.round((Date.now() - t0) / 100) / 10;
  if (left.length) { console.error(`[test:compose] CLEANUP INCOMPLETE: ${left.join(", ")}`); code = 1; }
  console.log(`[test:compose] ${code === 0 ? "PASS" : "FAIL"} ${JSON.stringify(report)}`);
  return code;
}

if (import.meta.main) process.exit(await main());
