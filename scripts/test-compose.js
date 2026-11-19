#!/usr/bin/env bun
// `bun run test:compose`: the three-node cluster test on a container runtime (issue #71). NOT part of `bun test` or
// `bun run test:cluster`: it builds an image and starts nine containers, so it runs only when asked.
//
// It builds deploy/Dockerfile as plenary-c3-<pid>:test, starts deploy/cluster.compose.yml plus the test override
// deploy/cluster.compose.test.yml (every node gateway+host, short lease, random loopback ports) as the Compose project
// plenary-c3-<pid>, and checks, with the real protocol client (test/server/rig.js `client`, packages/protocol Replica):
//   1. sequencing: two editors on two gateways write one board; the log in Postgres has no gap and no duplicate;
//   2. fan-out: a viewer on the third node holds every op;
//   3. takeover: SIGKILL the node that holds the board's lease mid-stream; clients move to the survivors; a survivor
//      takes the lease at a higher epoch; every op acked before the kill (and every ack ever seen) is in the log at
//      its seq; all clients converge on the log. Ops never acked are counted and reported (the Replica resends them,
//      so normally none is lost);
//   4. rejoin: the killed node is started again and serves the board.
// Every wait is a bounded condition (health, lease epoch in Postgres, op counts), never a fixed sleep.
//
// Runtime: docker, else podman (auto-detected; CONTAINER_CLI=<docker|podman|path> forces one). Compose: `docker compose`,
// else `docker-compose`; for podman the socket is found and passed as DOCKER_HOST. No runtime: prints a loud SKIP and
// exits 0 (exit 1 with --require or PLENARY_COMPOSE_REQUIRE=1, for a CI job that must not skip silently).
// Cleanup runs on every exit path (pass, fail, timeout, SIGINT/SIGTERM/SIGHUP): `down -v --remove-orphans`, then the
// image is removed, then it checks nothing labelled with the project, and no image, remains. A run that was SIGKILLed
// cannot clean itself: the next run (or `--sweep`) removes the stacks whose pid is dead.
// Usage: bun scripts/test-compose.js [--require] [--sweep] [--keep-image]
import { setPriority } from "node:os";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { postgresStore } from "../server/store/postgres.js";
import { client, tokenOf } from "../test/server/rig.js";
import { sleep } from "../test/server/helpers.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const FILES = ["deploy/cluster.compose.yml", "deploy/cluster.compose.test.yml"];
export const PROJECT_RE = /^plenary-c3-(\d+)$/;
const NODES = ["app-1", "app-2", "app-3"];
const RUN_DEADLINE_MS = 8 * 60_000;   // the whole run, pull and build included: a hung run ends, and cleans up

// ---- runtime detection (pure given its probes; test/deploy/compose-test.test.js drives it with fakes) -------------------

/** Run a command, capture it. `detached` puts it in its own session so a terminal Ctrl-C does not reach it. */
export async function run(cmd, { env, cwd = ROOT, timeoutMs = 120_000, detached = false } = {}) {
  let p;
  try { p = Bun.spawn(cmd, { cwd, env: env ?? process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", ...(detached ? { detached: true } : {}) }); }
  catch (e) { return { code: 127, out: "", err: String(e.message) }; }
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim() };
}

/**
 * Pick the container CLI and the Compose command. `probe(cmd)` → { code, out }; `which(name)` → path or null.
 * @returns {Promise<{ cli: string, cliName: string, compose: string[], env: Record<string,string> } | { skip: string }>}
 */
export async function detectRuntime({ env = process.env, which = Bun.which, probe = run, exists = existsSync, platform = process.platform } = {}) {
  const forced = env.CONTAINER_CLI?.trim();
  const candidates = forced ? [forced] : ["docker", "podman"];
  const tried = [];
  for (const c of candidates) {
    const path = c.includes("/") ? c : which(c);
    if (!path) { tried.push(`${c}: not found`); continue; }
    const name = basename(path);
    const out = {};
    if (name === "podman") {
      // docker-compose talks to podman's API socket. The machine's host socket (macOS) or the user socket (Linux).
      if (!env.DOCKER_HOST) {
        const sock = await podmanSocket({ path, probe, exists, platform });
        if (sock) out.DOCKER_HOST = `unix://${sock}`;
      }
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

/** The pids of Compose projects named plenary-c3-<pid> from a list of network names (every project has one `_default`). */
export function projectsOf(networkNames) {
  const found = new Set();
  for (const n of networkNames) { const m = /^(plenary-c3-\d+)_default$/.exec(n); if (m) found.add(m[1]); }
  return [...found];
}
export const pidOf = project => Number(PROJECT_RE.exec(project)?.[1]);
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ---- the stack -------------------------------------------------------------------------------------------------------

let aborted = null;   // the signal that interrupted the run, if any
const say = msg => console.log(`[test:compose] ${msg}`);
const fail = msg => { throw new Error(msg); };

/** Polls `fn` until truthy; every wait has a bound and an abort check, and says what it waited for. */
async function waitFor(what, fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    if (aborted) fail(`interrupted by ${aborted} while waiting for ${what}`);
    let v; try { v = await fn(); } catch (e) { if (Date.now() > end) throw e; v = null; }
    if (v) return v;
    if (Date.now() > end) fail(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

class Stack {
  constructor(rt, pid) {
    this.rt = rt; this.pid = pid;
    this.project = `plenary-c3-${pid}`; this.image = `plenary-c3-${pid}:test`;
    this.built = false; this.started = false; this.ports = {};
    const pw = randomBytes(9).toString("hex");
    this.env = { ...process.env, ...rt.env, POSTGRES_PASSWORD: pw, MINIO_ROOT_USER: "c3" + randomBytes(4).toString("hex"), MINIO_ROOT_PASSWORD: randomBytes(12).toString("hex"),
      COOKIE_KEY: randomBytes(32).toString("hex"), PLENARY_IMAGE: this.image, PLENARY_DEV_TOKENS: JSON.stringify(Object.fromEntries(
        ["ed1", "ed2", "view", "late"].map(n => [tokenOf(n), { name: n, email: `${n}@cluster.test`, domain: "cluster.test", ...(n === "view" ? {} : { admin: true }) }]))) };
    delete this.env.DATABASE_URL; delete this.env.NATS_URL;   // never inherit another stack's
    this.pw = pw;
  }
  compose(args, o = {}) { return run([...this.rt.compose, "-p", this.project, ...FILES.flatMap(f => ["-f", f]), ...args], { env: this.env, ...o }); }
  cli(args, o = {}) { return run([this.rt.cli, ...args], { env: this.env, ...o }); }

  async build() {
    if ((await this.cli(["image", "inspect", this.image])).code === 0) fail(`image ${this.image} already exists; refusing to overwrite and delete it`);
    this.built = true;
    const fmt = this.rt.cliName === "podman" ? ["--format", "docker"] : [];   // podman drops HEALTHCHECK in OCI format
    const rev = (await run(["git", "rev-parse", "HEAD"])).out || "unknown";
    const r = await this.cli(["build", ...fmt, "-f", "deploy/Dockerfile", "--build-arg", "VERSION=c3", "--build-arg", `REVISION=${rev}`, "-t", this.image, "."], { timeoutMs: 420_000 });
    if (r.code !== 0) fail(`image build failed:\n${r.err.slice(-1500)}`);
  }
  async up() {
    this.started = true;
    const r = await this.compose(["up", "-d", "--no-build", "--pull", "missing", "postgres", "nats", "blobs", "blobs-init", "image-build", ...NODES], { timeoutMs: 420_000 });
    if (r.code !== 0) fail(`compose up failed:\n${(r.err || r.out).slice(-1500)}`);
  }
  /** The host port Compose published for `service`:`inner` (re-read after a restart: it changes). */
  async port(service, inner) {
    const r = await this.compose(["port", service, String(inner)]);
    const m = /:(\d+)\s*$/.exec(r.out.split("\n")[0] ?? "");
    if (r.code !== 0 || !m) fail(`no published port for ${service}:${inner}: ${r.err || r.out}`);
    return (this.ports[service] = Number(m[1]));
  }
  async healthy(service) {
    const port = await this.port(service, 8080);
    await waitFor(`${service} /health`, async () => (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok, 90_000, 250);
    return port;
  }
  async logs(tail = 25) {
    const r = await this.compose(["logs", "--no-color", "--tail", String(tail)], { timeoutMs: 60_000 });
    return r.out || r.err;
  }
  /** What is left of this run: Compose containers, volumes, networks (by project label) and the image. */
  async leftovers() {
    const label = `label=com.docker.compose.project=${this.project}`;
    const found = [];
    for (const [kind, args] of [["container", ["ps", "-a", "-q", "--filter", label]], ["volume", ["volume", "ls", "-q", "--filter", label]], ["network", ["network", "ls", "-q", "--filter", label]]]) {
      const r = await this.cli(args);
      if (r.code !== 0) found.push(`${kind}: could not list (${r.err.slice(0, 100)})`);
      else for (const l of r.out.split("\n").filter(Boolean)) found.push(`${kind} ${l}`);
    }
    if ((await this.cli(["image", "inspect", this.image])).code === 0) found.push(`image ${this.image}`);
    return found;
  }
  /** Teardown, shielded from a terminal Ctrl-C (detached). Returns what is still left (empty = clean). */
  async teardown(keepImage = false) {
    const opts = { detached: true, timeoutMs: 180_000 };
    if (this.started || (await this.leftovers()).length) await this.compose(["down", "-v", "--remove-orphans", "-t", "3"], opts);
    if (this.built && !keepImage) await this.cli(["rmi", "-f", this.image], opts);
    return this.leftovers();
  }
}

/** Remove stacks of earlier runs whose process is gone (a SIGKILLed run cannot clean itself). Never touches a live pid. */
async function sweep(rt, self) {
  const probe = new Stack(rt, 0);
  const nets = (await probe.cli(["network", "ls", "--format", "{{.Name}}"])).out.split("\n");
  const swept = [];
  for (const project of projectsOf(nets)) {
    const pid = pidOf(project);
    if (pid === self || alive(pid)) continue;
    const s = new Stack(rt, pid); s.started = true; s.built = true;
    const left = await s.teardown();
    swept.push(`${project}${left.length ? ` (still left: ${left.join(", ")})` : ""}`);
  }
  // Images of dead runs that never got a network (killed during the build).
  const imgs = (await probe.cli(["images", "--format", "{{.Repository}}"])).out.split("\n");
  for (const repo of new Set(imgs.map(r => /(?:^|\/)(plenary-c3-(\d+))$/.exec(r)).filter(Boolean))) {
    const pid = Number(repo[2]);
    if (pid !== self && !alive(pid)) { await new Stack(rt, pid).cli(["rmi", "-f", `plenary-c3-${pid}:test`]); swept.push(`image plenary-c3-${pid}`); }
  }
  return swept;
}

// ---- the scenario ----------------------------------------------------------------------------------------------------

const rect = (id, k) => ({ id, type: "rectangle", version: 1, versionNonce: k, x: k, y: 0, width: 1, height: 1, isDeleted: false });

async function scenario(stack, report) {
  const T0 = Date.now();
  const nodes = Object.fromEntries(NODES.map(n => [n, { alive: true, port: 0 }]));
  for (const n of NODES) nodes[n].port = await stack.healthy(n);
  report.upSeconds = Math.round((Date.now() - T0) / 100) / 10;
  say(`stack up in ${report.upSeconds}s: ${NODES.map(n => `${n}:${nodes[n].port}`).join(" ")}, postgres:${await stack.port("postgres", 5432)}`);

  // The board: made on app-1 by ed1, with the other members editors and `view` a viewer.
  const api = (node, who, method, path, body) => fetch(`http://127.0.0.1:${nodes[node].port}${path}`, { method, headers: { authorization: `Bearer ${tokenOf(who)}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  const made = await api("app-1", "ed1", "POST", "/boards", { title: "compose3", memberRole: "viewer" });
  if (made.status !== 201) fail(`POST /boards: ${made.status} ${await made.text()}`);
  const { board } = await made.json();
  // Unit members are viewers on the board; the other editors (Unit admins, so known people) are granted editor.
  for (const [who, role] of [["ed2", "editor"], ["late", "editor"]]) {
    const r = await api("app-1", "ed1", "PUT", `/boards/${board.id}/grants/dev:${who}`, { role });
    if (r.status !== 204) fail(`grant ${who}: ${r.status} ${await r.text()}`);
  }

  const pg = await postgresStore({ url: `postgres://plenary:${stack.pw}@127.0.0.1:${stack.ports.postgres}/plenary`, max: 2 });
  const clients = [];
  try {
    const lease = () => pg.lease(board.tenant, board.id);
    const readLog = async () => { const log = []; for (;;) { const page = await pg.read(board.tenant, board.id, log.length + 1, 1000); if (!page.length) break; log.push(...page); } return log; };
    const nodeOf = holder => NODES.find(n => holder?.startsWith(n));

    // A client prefers its own node and falls back to the next live one; `client()` reads wsUrl at every (re)connect.
    const mk = (name, home, o = {}) => {
      const order = () => { const i = NODES.indexOf(home); return [...NODES.slice(i), ...NODES.slice(0, i)].filter(n => nodes[n].alive); };
      const fake = { server: { get wsUrl() { const n = order()[0]; return n ? `ws://127.0.0.1:${nodes[n].port}/ws` : "ws://127.0.0.1:1/ws"; } }, ids: { board: board.id } };
      const c = client(fake, name, name, { board: board.id, maxWaitMs: 250, ...o });
      c.home = home; c.at = () => order()[0]; c.lastTry = 0;
      clients.push(c);
      return c;
    };
    // Keeps every client connected: one whose socket is gone and is not already reconnecting tries again (bounded by the waits that need it).
    const keepAlive = setInterval(() => {
      for (const c of clients) if (!c.open && !c.busy && !c.r.resync && Date.now() - c.lastTry > 300) { c.lastTry = Date.now(); c.reconnect().catch(() => {}); }
    }, 100);
    const ed1 = mk("ed1", "app-1"), ed2 = mk("ed2", "app-2"), view = mk("view", "app-3");
    for (const c of [ed1, ed2, view]) c.connect().catch(() => {});
    await waitFor("three clients welcomed", () => [ed1, ed2, view].every(c => c.open && c.r.welcomed), 60_000);
    for (const [c, n] of [[ed1, "app-1"], [ed2, "app-2"], [view, "app-3"]]) say(`${c.name} -> ${n} role=${c.r.role}`);

    // Every op made, and every ack ever seen (first seq kept; a later ack of the same id must agree).
    const made_ = new Map(), acked = new Map();
    const harvest = () => { for (const c of clients) for (const m of c.msgs) if (m.t === "ack") { if (acked.has(m.id) && acked.get(m.id) !== m.seq) fail(`op ${m.id} acked at seq ${acked.get(m.id)} then ${m.seq}`); acked.set(m.id, m.seq); } };
    let k = 0;
    const emit = (c, n = 1) => { for (let i = 0; i < n; i++) { const id = `${c.name}-${++k}`; const m = c.send("board", { elements: [rect(id, k)] }); made_.set(m.id, id); } };
    const lastSeq = () => pg.lastSeq(board.tenant, board.id);
    const settled = async (cs, what, ms) => {
      let want = 0;
      try { await waitFor(what, async () => { want = await lastSeq(); return cs.every(c => c.open && !c.busy && !c.r.resync && c.r.welcomed && c.r.pending.size === 0 && c.r.applied === want); }, ms, 150); }
      catch (e) { fail(`${e.message}; PG last seq ${want}; ${JSON.stringify(cs.map(c => ({ c: c.name, at: c.at(), open: c.open, busy: c.busy, resync: c.r.resync, welcomed: c.r.welcomed, pending: c.r.pending.size, applied: c.r.applied, errors: c.errors.slice(-2).map(x => x.code) })))}`); }
      return want;
    };
    const idsOf = c => c.r.state().board.elements.map(e => e.id).sort();

    // 1. sequencing and fan-out, before any failure.
    for (let i = 0; i < 30; i++) { emit(ed1); emit(ed2); }
    const seq1 = await settled([ed1, ed2, view], "phase 1: both editors and the viewer hold 60 entries", 60_000);
    harvest();
    const log1 = await readLog();
    if (seq1 !== 60 || log1.length !== 60) fail(`phase 1: expected 60 entries, PG has ${log1.length} (last seq ${seq1})`);
    log1.forEach((e, i) => { if (e.seq !== i + 1) fail(`phase 1: gap or duplicate at index ${i}: seq ${e.seq}`); });
    if (new Set(log1.map(e => e.id)).size !== 60) fail("phase 1: an op id appears twice in the log");
    for (const c of [ed1, ed2, view]) if (idsOf(c).length !== 60) fail(`phase 1: ${c.name} holds ${idsOf(c).length} elements, not 60`);
    if (JSON.stringify(idsOf(view)) !== JSON.stringify(idsOf(ed1)) || JSON.stringify(idsOf(ed2)) !== JSON.stringify(idsOf(ed1))) fail("phase 1: clients differ");
    const l0 = await lease();
    if (!l0?.live) fail(`no live lease after phase 1: ${JSON.stringify(l0)}`);
    const victim = nodeOf(l0.holder);
    if (!victim) fail(`lease holder ${l0.holder} is not one of ${NODES}`);
    report.phase1 = { entries: 60, hostNode: victim, holder: l0.holder, epoch: l0.epoch };
    say(`phase 1 ok: 60 entries, no gap, viewer on app-3 holds all; ${victim} hosts the board at epoch ${l0.epoch}`);

    // 2. takeover: ops stream from both editors; SIGKILL the host mid-stream.
    let gen = true;
    const ticker = setInterval(() => { if (gen && !aborted) { emit(ed1, 3); emit(ed2, 3); } }, 100);
    try {
      const ackedAtStart = (harvest(), acked.size);
      await waitFor("20 more acks while streaming", () => (harvest(), acked.size >= ackedAtStart + 20), 30_000, 50);
      // Kill with ops waiting: the editors make 30 ops/s each, more than the client's send pace, so some are always pending.
      await waitFor("ops in flight on the editors", () => [ed1, ed2].some(c => c.r.pending.size > 0), 10_000, 20);
      const inflight = [ed1, ed2].reduce((a, c) => a + c.r.pending.size, 0);
      const ackedBeforeKill = new Map((harvest(), acked));   // snapshot: everything acked before the kill
      const k0 = await stack.compose(["kill", "-s", "SIGKILL", victim]);
      if (k0.code !== 0) fail(`kill ${victim}: ${k0.err || k0.out}`);
      const killedAt = Date.now();
      nodes[victim].alive = false;
      say(`SIGKILLed ${victim} (host of the board) with ${acked.size} ops acked, ${inflight} in flight on the editors`);
      const l1 = await waitFor("a survivor to take the lease at a higher epoch", async () => { const l = await lease(); return l?.live && nodeOf(l.holder) !== victim && l.epoch > l0.epoch ? l : null; }, 60_000, 150);
      const takeoverMs = Date.now() - killedAt;
      say(`${nodeOf(l1.holder)} took the lease at epoch ${l1.epoch} ${takeoverMs} ms after the kill`);
      // Keep writing a little after the takeover, then stop and let everyone settle.
      const target = made_.size + 10;
      await waitFor("10 more ops made after the takeover", () => made_.size >= target, 20_000, 50);
      gen = false;
      const seq2 = await settled([ed1, ed2, view], "phase 2: every client reconnected, nothing pending, all applied to the log's end", 90_000);
      harvest();
      const log2 = await readLog();
      log2.forEach((e, i) => { if (e.seq !== i + 1) fail(`phase 2: gap at index ${i}: seq ${e.seq}`); });
      const seqOf = new Map(log2.map(e => [e.id, e.seq]));
      if (seqOf.size !== log2.length) fail("phase 2: an op id appears twice in the log");
      if (log2.length !== seq2) fail(`phase 2: log has ${log2.length} entries, last seq ${seq2}`);
      const lostAcked = [...acked].filter(([id, seq]) => seqOf.get(id) !== seq);
      if (lostAcked.length) fail(`ACKED OPS LOST OR MOVED after takeover: ${JSON.stringify(lostAcked.slice(0, 5))} (${lostAcked.length} of ${acked.size})`);
      const lostBefore = [...ackedBeforeKill].filter(([id, seq]) => seqOf.get(id) !== seq);
      if (lostBefore.length) fail(`ops acked before the kill are not in the log: ${JSON.stringify(lostBefore.slice(0, 5))}`);
      // Never acked and not in the log = lost (allowed; counted).
      const neverAckedLost = [...made_.keys()].filter(id => !seqOf.has(id)).length;
      const eds = [ed1, ed2, view].map(idsOf);
      if (!eds.every(e => JSON.stringify(e) === JSON.stringify(eds[0]))) fail("phase 2: clients did not converge to the same board");
      if (eds[0].length !== log2.length) fail(`phase 2: clients hold ${eds[0].length} elements, the log ${log2.length}`);
      const l2 = await lease();
      report.takeover = { killed: victim, newHolder: l1.holder, epochBefore: l0.epoch, epochAfter: l1.epoch, finalEpoch: l2.epoch, takeoverMs,
        opsMade: made_.size, ackedTotal: acked.size, ackedBeforeKill: ackedBeforeKill.size, inflightAtKill: inflight, inLog: log2.length,
        ackedLost: 0, neverAckedLost, finalSeq: seq2 };
      say(`phase 2 ok: ${made_.size} ops made, ${acked.size} acked (${ackedBeforeKill.size} before the kill), ${log2.length} in the log, 0 acked lost, ${report.takeover.neverAckedLost} never-acked lost; clients converged`);
    } finally { gen = false; clearInterval(ticker); }

    // 3. the killed node rejoins and serves the board.
    const rj = await stack.compose(["start", victim]);
    if (rj.code !== 0) fail(`start ${victim}: ${rj.err || rj.out}`);
    nodes[victim].port = await stack.healthy(victim);
    nodes[victim].alive = true;
    const late = mk("late", victim);
    late.connect().catch(() => {});
    await waitFor("the restarted node to welcome a new client", () => late.open && late.r.welcomed, 60_000);
    emit(late);
    emit(ed1);
    const seq3 = await settled([ed1, ed2, view, late], "phase 3: the rejoined node's client and the rest converge", 60_000);
    harvest();
    const e3 = [ed1, ed2, view, late].map(idsOf);
    if (!e3.every(e => JSON.stringify(e) === JSON.stringify(e3[0]))) fail("phase 3: clients differ after the rejoin");
    const log3 = await readLog();
    log3.forEach((e, i) => { if (e.seq !== i + 1) fail(`phase 3: gap at index ${i}`); });
    for (const [id, seq] of acked) if (log3[seq - 1]?.id !== id) fail(`phase 3: acked ${id} is not at seq ${seq}`);
    report.rejoin = { node: victim, finalSeq: seq3, elements: e3[0].length };
    say(`phase 3 ok: ${victim} rejoined and its client converged at seq ${seq3}`);
    clearInterval(keepAlive);
  } finally {
    for (const c of clients) await c.drop().catch(() => {});
    await pg.close().catch(() => {});
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------

async function main() {
  const args = new Set(process.argv.slice(2));
  const require_ = args.has("--require") || process.env.PLENARY_COMPOSE_REQUIRE === "1";
  const rt = await detectRuntime();
  if (rt.skip) {
    const bar = "=".repeat(78);
    console.error(`${bar}\nSKIPPED test:compose: ${rt.skip}\nThe three-node compose cluster test did NOT run.${require_ ? " (--require: failing)" : ""}\n${bar}`);
    return require_ ? 1 : 0;
  }
  try { setPriority(19); } catch { /* best effort */ }
  say(`runtime: ${rt.cliName}, compose: ${basename(rt.compose.join(" "))}${rt.env.DOCKER_HOST ? ` via ${rt.env.DOCKER_HOST}` : ""}`);
  const swept = await sweep(rt, process.pid);
  if (swept.length) say(`swept leftovers of dead runs: ${swept.join(", ")}`);
  if (args.has("--sweep")) return 0;

  const stack = new Stack(rt, process.pid);
  const report = { project: stack.project, runtime: rt.cliName };
  let code = 1, left = [];
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { aborted ??= sig; });
  const deadline = setTimeout(() => { aborted ??= "the run deadline"; }, RUN_DEADLINE_MS);
  const t0 = Date.now();
  try {
    const stale = await stack.leftovers();
    if (stale.length) fail(`project ${stack.project} already has resources (a reused pid?): ${stale.join(", ")}`);
    await stack.build();
    report.buildSeconds = Math.round((Date.now() - t0) / 100) / 10;
    if (aborted) fail(`interrupted by ${aborted}`);
    await stack.up();
    if (aborted) fail(`interrupted by ${aborted}`);
    await scenario(stack, report);
    code = 0;
  } catch (e) {
    console.error(`[test:compose] FAILED: ${e.message}`);
    if (stack.started) console.error(`--- container logs (last lines) ---\n${(await stack.logs()).slice(-6000)}`);
    if (aborted) code = 130;
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
