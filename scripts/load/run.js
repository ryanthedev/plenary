// The M2 load client: N simulated clients (editors, annotators, viewers) against one board, measured.
//
//   bun scripts/load/run.js --url ws://host:port/ws --board <id> --tokens <dev-tokens.json> \
//       [--editors 5] [--annotators n] [--viewers n] [--clients n] [--ramp 200] [--duration 30] [--drain 15] \
//       [--procs 1] [--out <dir>] [--op-rate 2] [--note-rate 0.2] [--comment-rate 0.05] [--cursor-rate 5] [--pool 20]
//   bun scripts/load/run.js --rig <rig dir> --create-board ...   URL and tokens from <rig dir>/rig.json; a fresh board
//                                                      via POST /boards (each rig node has its own dev board)
//   bun scripts/load/run.js --local ...                starts its own single-node server (server/main.js, port 0,
//                                                      temp data dir, tokens made in --out), samples its CPU, stops it
//
// --clients n splits n like the NFRs: the given editors (default 5), ~2% annotators, the rest viewers.
// Writes <out>/result.json (schema SCHEMA below) and <out>/report.md. Prints progress lines; never a token.
// Exit code (exitCode below): 0 = a good run: the generator did not saturate (result.valid) AND every planned
// client joined at least once (result.clients.complete); 1 = the run finished but is not good (report.md's
// headline says INVALID or INCOMPLETE and why); 2 = bad arguments or setup (nothing was measured).

import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hist, addCounts } from "./stats.js";
import { readTokensByRole, makeTokens, writeTokens } from "./tokens.js";
import { startServer, psSample, cpuPct } from "./server.js";
import { MAX_WRITER_CONNS } from "../../packages/protocol/envelope.js";

export const SCHEMA = "plenary.load.result/1";
const WORKER = resolve(import.meta.dir, "worker.js");
const ROLES = ["editor", "annotator", "viewer"];
// A generator whose event loop is late by more than this (p99, whole run), or busier than this (% of one core,
// mean over the load phase: after the ramp, before the drain), is saturated: its latencies say more about itself
// than about the server, so the run is invalid.
export const LAG_P99_LIMIT_MS = 100;
export const CPU_MEAN_LIMIT = 85;

const DEFAULTS = { editors: 5, annotators: 0, viewers: 0, ramp: 200, duration: 30, drain: 15, procs: 1, "op-rate": 2, "note-rate": 0.2, "comment-rate": 0.05, "cursor-rate": 5, pool: 20 };

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (k === "local" || k === "help" || k === "create-board") { o[k] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`--${k} needs a value`);
    o[k] = argv[++i];
  }
  return o;
}

/**
 * URL, tokens path and board from p8-rig's rig.json. The one place its field names are read. scripts/cluster-rig.js
 * (rig.json version 1, read 2026-11-12, still uncommitted) writes `lb.wsUrl` and `tokensFile` (absolute) and no
 * board (use --create-board); other likely names are kept as fallbacks in case it changes (first hit wins).
 */
export function rigConfig(dir) {
  const path = join(dir, "rig.json");
  if (!existsSync(path)) throw new Error(`no rig.json in ${dir}`);
  const r = JSON.parse(readFileSync(path, "utf8"));
  const pick = (...ks) => { for (const k of ks) { const v = k.split(".").reduce((o, p) => o?.[p], r); if (typeof v === "string" && v) return v; } return null; };
  let url = pick("lb.wsUrl", "wsUrl", "lbWsUrl", "lbUrl", "lb.url", "url");
  if (url && /^https?:/.test(url)) url = url.replace(/^http/, "ws").replace(/\/?$/, "/ws");
  let tokens = pick("tokensFile", "tokensPath", "devTokensPath", "devTokensFile", "tokens");
  if (tokens && !tokens.startsWith("/")) tokens = join(dir, tokens);
  return { url, tokens, board: pick("board", "devBoard", "boardId") };
}

/** The client counts from the flags: explicit counts win; --clients n fills annotators (~2%) and viewers. */
export function planCounts(o) {
  const editors = count(o.editors, DEFAULTS.editors, "editors");
  let annotators = o.annotators !== undefined ? count(o.annotators, 0, "annotators") : null, viewers = o.viewers !== undefined ? count(o.viewers, 0, "viewers") : null;
  if (o.clients !== undefined) {
    const total = count(o.clients, 0, "clients"), rest = Math.max(0, total - editors);
    if (annotators === null) annotators = Math.round(rest * 0.02);
    if (viewers === null) viewers = Math.max(0, rest - annotators);
  }
  return { editor: editors, annotator: annotators ?? 0, viewer: viewers ?? 0 };
}
// Flag values: num for rates and seconds (any finite number ≥ 0), count for how many of something (a whole number ≥
// min), positive for the ramp (> 0: 0 clients/s would never finish the ramp).
const num = (v, d) => { if (v === undefined) return d; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`not a number ≥ 0: ${v}`); return n; };
const count = (v, d, name, min = 0) => { if (v === undefined) return d; const n = Number(v); if (!Number.isSafeInteger(n) || n < min) throw new Error(`--${name} must be a whole number ≥ ${min}: ${v}`); return n; };
const positive = (v, d, name) => { const n = num(v, d); if (!(n > 0)) throw new Error(`--${name} must be > 0: ${v}`); return n; };

/**
 * Who starts when, in which worker. Editors first (the presenters are there before the audience), then
 * annotators, then viewers, one every 1/ramp s; dealt round-robin to the workers. Viewers share tokens
 * (`viewersPerToken` clients each); writers get one token each when there are enough, else share, at most 8 a user.
 */
export function planClients(counts, { ramp, procs, tokensByRole }) {
  const order = [];
  for (const role of ROLES) for (let i = 0; i < counts[role]; i++) order.push({ role, i });
  const jobs = Array.from({ length: procs }, () => []);
  const per = {};
  for (const role of ROLES) {
    const have = tokensByRole[role]?.length ?? 0;
    if (counts[role] && !have) throw new Error(`the tokens file has no ${role} tokens (needed for ${counts[role]} ${role} clients)`);
    per[role] = Math.max(1, Math.ceil(counts[role] / Math.max(1, have)));
    // A writer user may hold MAX_WRITER_CONNS (8) connections per board per gateway; more would be refused.
    if (role !== "viewer" && per[role] > MAX_WRITER_CONNS) throw new Error(`${counts[role]} ${role} clients on ${have} ${role} tokens is more than ${MAX_WRITER_CONNS} per user (the writer cap): make more tokens (scripts/load/tokens.js, or the rig's tokens option)`);
  }
  order.forEach((c, k) => jobs[k % procs].push({ role: c.role, token: Math.floor(c.i / per[c.role]), name: `load-${c.role[0]}${c.i}`, startAt: Math.round((k * 1000) / ramp) }));
  return { jobs, viewersPerToken: per.viewer, perToken: per };
}

/**
 * This machine's open-file ceilings for one process: the shell's hard limit (`ulimit -Hn`, a string: may be
 * "unlimited") and the kernel's own cap (macOS kern.maxfilesperproc, Linux fs.nr_open), or Infinity when unknown.
 */
export function readFdLimits() {
  const hard = Bun.spawnSync(["sh", "-c", "ulimit -Hn"]).stdout.toString().trim();
  let kernel = Infinity, kernelName = null;
  const pos = v => (Number.isFinite(v) && v > 0 ? v : Infinity);
  if (process.platform === "darwin") { kernel = pos(Number(Bun.spawnSync(["sysctl", "-n", "kern.maxfilesperproc"]).stdout.toString().trim())); kernelName = "kern.maxfilesperproc"; }
  else if (process.platform === "linux") { try { kernel = pos(Number(readFileSync("/proc/sys/fs/nr_open", "utf8").trim())); } catch { /* not readable */ } kernelName = "fs.nr_open"; }
  return { hard, kernel, kernelName };
}

/** Open-file check: each worker needs a socket per client plus slack. Returns { ok, limit, need, message }. */
export function fdCheck(perWorker, { hard, kernel, kernelName } = readFdLimits()) {
  const need = perWorker + 256;
  const hardN = hard === "unlimited" ? Infinity : Number(hard);
  const limit = Math.min(Number.isFinite(hardN) ? hardN : Infinity, kernel);
  if (limit < need) return { ok: false, limit, need, message: `each worker needs ~${need} open files (${perWorker} clients + 256) but one process may open at most ${limit} here (the lower of ulimit -Hn ${hard}${kernel < Infinity ? ` and ${kernelName} ${kernel}` : ""}). Use more --procs, or raise the limit (macOS: sudo launchctl limit maxfiles; Linux: /etc/security/limits.conf and fs.nr_open).` };
  return { ok: true, limit, need, nofile: Math.min(limit, Math.max(need * 2, 4096)) };
}

/** Merge workers' results into one: counts add, histograms merge (exact percentiles of all samples). */
export function mergeResults(results) {
  const m = { counts: {}, closes: {}, errors: {}, hists: {}, joinsPerSec: {}, lag: new Hist(), workers: [] };
  let drainMs = null;   // a duration, not a count: the run's drain lasted as long as its slowest worker's
  for (const r of results) {
    if (r.stats.counts.drainMs !== undefined) drainMs = Math.max(drainMs ?? 0, r.stats.counts.drainMs);
    addCounts(m.counts, r.stats.counts); addCounts(m.closes, r.stats.closes); addCounts(m.errors, r.stats.errors); addCounts(m.joinsPerSec, r.stats.joinsPerSec);
    for (const [k, h] of Object.entries(r.stats.hists)) (m.hists[k] ??= new Hist()).merge(h);
    const lag = Hist.fromJSON(r.lag); m.lag.merge(lag);
    // CPU judged over the load phase (cpuLoad); a run too short to hold a whole 1 s sample there falls back to all.
    const cpu = r.cpu ?? [], load = r.cpuLoad?.length ? r.cpuLoad : cpu;
    m.workers.push({ worker: r.worker, pid: r.pid, clients: r.stats.counts.clients ?? 0, lagMs: lag.summary(), cpuPct: { mean: avg(load), meanAllPhases: avg(cpu), max: cpu.length ? Math.max(...cpu) : null, samples: cpu.length, loadSamples: r.cpuLoad?.length ?? 0 } });
  }
  if (drainMs !== null) m.counts.drainMs = drainMs;
  return m;
}
const avg = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);

/** The result.json object (schema SCHEMA). */
export function buildResult({ merged, config, counts, startedAt, finishedAt, server }) {
  const c = merged.counts, h = merged.hists;
  const byRole = kind => Object.fromEntries(ROLES.map(r => [r, h[`${kind}.${r}`]?.summary() ?? new Hist().summary()]));
  const secs = Object.keys(merged.joinsPerSec).map(Number).sort((a, b) => a - b);
  const reasons = [];
  for (const w of merged.workers) {
    if ((w.lagMs.p99 ?? 0) > LAG_P99_LIMIT_MS) reasons.push(`worker ${w.worker}: event-loop lag p99 ${w.lagMs.p99} ms > ${LAG_P99_LIMIT_MS} ms`);
    if ((w.cpuPct.mean ?? 0) > CPU_MEAN_LIMIT) reasons.push(`worker ${w.worker}: CPU mean ${w.cpuPct.mean}% of a core > ${CPU_MEAN_LIMIT}%`);
  }
  const close1013 = merged.closes["1013"] ?? 0;
  const otherCloses = Object.entries(merged.closes).filter(([k]) => k !== "1013" && k !== "1000").reduce((n, [, v]) => n + v, 0);
  const planned = counts.editor + counts.annotator + counts.viewer;
  const neverJoined = c.neverJoined ?? 0, joined = c.joined ?? 0;
  // Complete: every planned client got a welcome at least once (a run where some never joined measured a smaller
  // audience than it says, or nothing at all: a wrong URL).
  const complete = planned > 0 && joined === planned && neverJoined === 0;
  return {
    schema: SCHEMA,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
    config,
    valid: reasons.length === 0, invalidReasons: reasons,
    clients: { planned, byRole: counts, joined, neverJoined, complete, connectedAtEnd: c.connectedAtEnd ?? 0 },
    join: {
      latencyMs: h.join?.summary() ?? new Hist().summary(),
      perSecond: secs.map(s => ({ s, n: merged.joinsPerSec[s] })),
      peakPerSecond: secs.length ? Math.max(...secs.map(s => merged.joinsPerSec[s])) : 0,
      firstToLastS: secs.length ? secs[secs.length - 1] - secs[0] + 1 : 0,
    },
    ops: {
      sent: { total: c.opsSent ?? 0, editor: c.opsSent_editor ?? 0, annotator: c.opsSent_annotator ?? 0 },
      acked: c.acks ?? 0, echoed: { total: c.echoes ?? 0, editor: c.echoes_editor ?? 0, annotator: c.echoes_annotator ?? 0 },
      dropped: c.dropped ?? 0, unanswered: c.unanswered ?? 0, unechoed: c.unechoed ?? 0, unacked: c.unacked ?? 0,
      skippedOffline: c.skippedOffline ?? 0, skippedBacklog: c.skippedBacklog ?? 0, presenceSent: c.presenceSent ?? 0,
      drainMs: c.drainMs ?? 0,
    },
    latencyMs: { ack: byRole("ack"), echo: byRole("echo"), delivery: byRole("delivery") },
    connections: {
      connects: c.connects ?? 0, hellos: c.hellos ?? 0, welcomes: c.welcomes ?? 0, rejoins: c.rejoins ?? 0,
      reconnects: c.reconnects ?? 0, resyncs: c.resyncs ?? 0, resets: c.resets ?? 0, wsErrors: c.wsErrors ?? 0,
      closes: merged.closes, close1013, closeOther: otherCloses, errors: merged.errors,
      goneAuth: c.gone_auth ?? 0, goneVersion: c.gone_version ?? 0, badFrames: c.badFrames ?? 0,
    },
    generator: { lagMs: merged.lag.summary(), workers: merged.workers, limits: { lagP99Ms: LAG_P99_LIMIT_MS, cpuMeanPct: CPU_MEAN_LIMIT } },
    server: server ?? null,
    histograms: Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.toJSON()])),
  };
}

/** The process exit code for a finished run: 0 only for a valid AND complete one (see the header). */
export function exitCode(r) { return r.valid && r.clients.complete ? 0 : 1; }

/** The headline word: INVALID (generator saturated) beats INCOMPLETE (not everyone joined) beats VALID. */
export function headline(r) {
  if (!r.valid) return "INVALID (the load generator saturated)";
  if (!r.clients.complete) return `INCOMPLETE (${r.clients.planned - r.clients.joined} of ${r.clients.planned} planned clients never joined)`;
  return "VALID";
}

const fmt = s => (s.n ? `${s.p50} / ${s.p95} / ${s.p99} / ${s.max} (n=${s.n})` : "–");

/** report.md: the result in a page. */
export function renderReport(r) {
  const L = [];
  L.push(`# Load run ${r.startedAt}`, "");
  L.push(`**${headline(r)}** · ${r.clients.joined}/${r.clients.planned} clients joined · ${r.ops.echoed.total}/${r.ops.sent.total} ops echoed · ${r.connections.close1013} closes 1013`, "");
  if (!r.valid) { for (const x of r.invalidReasons) L.push(`- ${x}`); L.push(""); }
  L.push(`Target ${r.config.url} board ${r.config.board} · ${r.config.procs} worker(s) · ramp ${r.config.ramp}/s · duration ${r.config.duration} s · drain ${r.config.drain} s`, "");
  L.push("| Clients | editors | annotators | viewers | joined | never joined | connected at end |", "|---|---|---|---|---|---|---|");
  L.push(`| planned ${r.clients.planned} | ${r.clients.byRole.editor} | ${r.clients.byRole.annotator} | ${r.clients.byRole.viewer} | ${r.clients.joined} | ${r.clients.neverJoined} | ${r.clients.connectedAtEnd} |`, "");
  L.push("Latency, ms: p50 / p95 / p99 / max (n)", "", "| | editor | annotator | viewer |", "|---|---|---|---|");
  for (const k of ["ack", "echo", "delivery"]) L.push(`| ${k} | ${ROLES.map(x => fmt(r.latencyMs[k][x])).join(" | ")} |`);
  L.push(`| join (hello → welcome) | ${fmt(r.join.latencyMs)} | | |`, "");
  L.push(`Joins: peak ${r.join.peakPerSecond}/s, first to last ${r.join.firstToLastS} s.`, "");
  L.push("| Ops | sent | acked | echoed | dropped | unanswered | unechoed | skipped (offline / backlog) |", "|---|---|---|---|---|---|---|---|");
  L.push(`| | ${r.ops.sent.total} (e ${r.ops.sent.editor}, a ${r.ops.sent.annotator}) | ${r.ops.acked} | ${r.ops.echoed.total} | ${r.ops.dropped} | ${r.ops.unanswered} | ${r.ops.unechoed} | ${r.ops.skippedOffline} / ${r.ops.skippedBacklog} |`, "");
  const cn = r.connections;
  L.push(`Connections: ${cn.connects} opened, ${cn.welcomes} welcomes (${cn.rejoins} rejoins), ${cn.reconnects} reconnects, ${cn.resyncs} resyncs, ${cn.wsErrors} socket errors. Closes by code: ${JSON.stringify(cn.closes)}. Errors by code: ${JSON.stringify(cn.errors)}.`, "");
  L.push("| Generator worker | clients | lag p50 / p99 / max ms | CPU mean / max % of a core |", "|---|---|---|---|");
  for (const w of r.generator.workers) L.push(`| ${w.worker} | ${w.clients} | ${w.lagMs.p50} / ${w.lagMs.p99} / ${w.lagMs.max} | ${w.cpuPct.mean} / ${w.cpuPct.max} |`);
  if (r.server) L.push("", `Server (pid ${r.server.pid}): CPU mean ${r.server.cpuPct.mean}% / max ${r.server.cpuPct.max}% of a core, RSS max ${r.server.rssMb.max} MB (${r.server.samples} ps samples).`);
  return L.join("\n") + "\n";
}

/**
 * --create-board: a fresh board through the admin route (server/auth/http.js), for a rig where each node has its
 * own data dir (and so its own dev board). POST /boards as the tokens file's admin token (`admin: true` with a
 * `domain`: main.js makes that domain's tenant and its admins at start), memberRole viewer (every token of the
 * domain is then a viewer), then PUT /boards/:board/grants/dev:<name> for every other non-viewer token's role.
 * Error messages carry statuses and codes only, never a token.
 */
export async function createBoard(wsUrl, tokensPath) {
  const base = wsUrl.replace(/^ws/, "http").replace(/\/ws\/?$/, "");
  const table = JSON.parse(readFileSync(tokensPath, "utf8"));
  const admin = Object.entries(table).find(([, t]) => t?.admin === true && t.domain);
  if (!admin) throw new Error("--create-board needs a token with admin: true and a domain in the tokens file");
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${admin[0]}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    // Only a short code-shaped `error` is echoed: never free text from the server (it could hold anything).
    if (!res.ok) { let code = ""; try { const e = (await res.json()).error; if (typeof e === "string" && /^[a-z_-]{1,40}$/.test(e)) code = e; } catch { /* not JSON */ } throw new Error(`${method} ${path.replace(/grants\/.*/, "grants/…")}: ${res.status} ${code}`); }
    return res.status === 204 ? null : res.json();
  };
  const { board } = await call("POST", "/boards", { title: "load test", memberRole: "viewer" });
  const id = typeof board === "string" ? board : board.id;
  for (const [tok, t] of Object.entries(table)) {
    if (tok === admin[0] || !t?.name || (t.role ?? "editor") === "viewer") continue;
    await call("PUT", `/boards/${encodeURIComponent(id)}/grants/${encodeURIComponent("dev:" + t.name)}`, { role: t.role ?? "editor" });
  }
  return id;
}

function spawnWorker(job, nofile, onProgress) {
  return new Promise((resolveP, reject) => {
    let done = false;
    const child = Bun.spawn(["sh", "-c", `ulimit -n ${nofile} 2>/dev/null; exec "$0" "$1"`, process.execPath, WORKER], {
      stdio: ["ignore", "inherit", "inherit"], serialization: "json",
      ipc(msg) {
        if (msg.type === "ready") child.send(job);
        else if (msg.type === "progress") onProgress?.(msg);
        else if (msg.type === "result") { done = true; resolveP(msg.result); }
        else if (msg.type === "fail") { done = true; reject(new Error(`worker ${job.worker}: ${msg.message}`)); }
      },
    });
    child.exited.then(code => { if (!done) reject(new Error(`worker ${job.worker} exited (${code}) without a result`)); });
  });
}

/** Run a whole load test. Returns the result object (also written to out/ when `out` is set). */
export async function run(o, { log = s => console.log(s) } = {}) {
  let server = null, serverSamples = null;
  let url = o.url, tokensPath = o.tokens, board = o.board;
  if (o.rig) { const r = rigConfig(o.rig); url ??= r.url; tokensPath ??= r.tokens; board ??= r.board; }
  const counts = planCounts(o);
  const out = o.out ? resolve(o.out) : null;
  if (out) mkdirSync(out, { recursive: true });
  const procs = count(o.procs, DEFAULTS.procs, "procs", 1);
  const ramp = positive(o.ramp, DEFAULTS.ramp, "ramp");
  const duration = num(o.duration, DEFAULTS.duration), drain = num(o.drain, DEFAULTS.drain);
  const cfg = { opRate: num(o["op-rate"], DEFAULTS["op-rate"]), noteRate: num(o["note-rate"], DEFAULTS["note-rate"]), commentRate: num(o["comment-rate"], DEFAULTS["comment-rate"]), cursorRate: num(o["cursor-rate"], DEFAULTS["cursor-rate"]), pool: count(o.pool, DEFAULTS.pool, "pool", 1) };
  const viewersPerUser = count(o["viewers-per-user"], 32, "viewers-per-user", 1);
  const total = counts.editor + counts.annotator + counts.viewer;
  if (total < 1) throw new Error("no clients planned: give --clients, --editors, --annotators or --viewers");
  const fd = fdCheck(Math.ceil(total / procs));
  if (!fd.ok) throw new Error(fd.message);

  if (o.local) {
    const dir = out ?? mkdtempSync(join(tmpdir(), "plenary-load-"));
    if (!tokensPath) tokensPath = writeTokens(join(dir, "tokens"), makeTokens({ editors: counts.editor, annotators: counts.annotator, viewers: counts.viewer, viewersPerUser })).jsonPath;
    else readTokensByRole(tokensPath);   // a bad tokens file stops here, before a server waits on it
    server = await startServer({ tokensPath, env: o.serverEnv ?? {}, nofile: Math.max(fd.nofile, total + 1024), logPath: join(dir, "server.log") });
    url = server.wsUrl; if (!o["create-board"]) board ??= server.board;
    log(`local server pid ${server.pid} on port ${server.port}, board ${server.board}, log ${join(dir, "server.log")}`);
  }
  let boardCreated = false;
  if (o["create-board"] && url && tokensPath) { board = await createBoard(url, tokensPath); boardCreated = true; log(`created board ${board}`); }
  if (!url || !tokensPath || !board) throw new Error("need --url, --tokens and --board or --create-board (or --rig <dir>, or --local)");

  try {
    const tokensByRole = readTokensByRole(tokensPath);
    const { jobs, viewersPerToken } = planClients(counts, { ramp, procs, tokensByRole });
    const rampMs = Math.ceil((total * 1000) / ramp);
    const t0 = Date.now() + 1500;   // workers get a moment to start
    const genEndAt = t0 + rampMs + duration * 1000;
    const config = { url, board, boardCreated, procs, ramp, duration, drain, viewersPerToken, ...cfg, rampMs, nofile: fd.nofile };
    log(`plan: ${counts.editor} editors, ${counts.annotator} annotators, ${counts.viewer} viewers over ${procs} worker(s); ramp ${rampMs} ms, then ${duration} s, then drain ≤ ${drain} s`);

    if (server) {
      serverSamples = [];
      const timer = setInterval(() => { const s = psSample(server.pid); if (s) serverSamples.push(s); }, 1000);
      server.sampler = timer;
    }
    const startedAt = Date.now();
    const progress = new Map();
    let lastLog = 0;
    const onProgress = p => {
      progress.set(p.worker, p);
      if (Date.now() - lastLog < 2000) return; lastLog = Date.now();
      let joined = 0, ops = 0; for (const x of progress.values()) { joined += x.joined; ops += x.opsSent; }
      log(`  t+${Math.round((Date.now() - t0) / 1000)} s: ${joined}/${total} joined, ${ops} ops sent`);
    };
    const results = await Promise.all(jobs.map((clients, worker) => spawnWorker({ url, board, tokensPath, t0, loadFrom: t0 + rampMs, genEndAt, drainMs: drain * 1000, clients, cfg, worker }, fd.nofile, onProgress)));
    const finishedAt = Date.now();
    let serverInfo = null;
    if (server) {
      clearInterval(server.sampler);
      const cpu = cpuPct(serverSamples), rss = serverSamples.map(s => s.rssKb / 1024);
      serverInfo = { pid: server.pid, samples: serverSamples.length, cpuPct: { mean: avg(cpu), max: cpu.length ? Math.max(...cpu) : null }, rssMb: { max: rss.length ? Math.round(Math.max(...rss)) : null }, cpuSeries: cpu };
    }
    const result = buildResult({ merged: mergeResults(results), config, counts, startedAt, finishedAt, server: serverInfo });
    if (out) {
      writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 1));
      writeFileSync(join(out, "report.md"), renderReport(result));
      log(`wrote ${join(out, "result.json")} and report.md`);
    }
    return result;
  } finally {
    if (server) { if (server.sampler) clearInterval(server.sampler); await server.stop(); }
  }
}

if (import.meta.main) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) { console.error(String(err.message)); process.exit(2); }
  if (o.help) { console.log((() => { const ls = readFileSync(import.meta.path, "utf8").split("\n"); return ls.slice(0, ls.findIndex(l => !l.startsWith("//"))).map(l => l.slice(3)).join("\n"); })()); process.exit(0); }
  try {
    const r = await run(o);
    console.log(renderReport(r));
    process.exit(exitCode(r));
  } catch (err) { console.error(`load: ${err.message}`); process.exit(2); }
}
