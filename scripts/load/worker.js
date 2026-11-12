// One load-generator process: runs its share of the clients, watches its own event loop and CPU, and hands one
// result object to the parent (run.js) over IPC. Tokens come from the tokens file named in the job (never argv,
// never stdout); the job names clients by role and index into that file's tokens of that role.
//
// Also importable: runWorker(job, { onProgress }) runs in-process (tests use it).

import { LoadClient } from "./client.js";
import { Hist } from "./stats.js";
import { readTokensByRole } from "./tokens.js";

export class Stats {
  constructor(t0) { this.t0 = t0; this.counts = {}; this.closes = {}; this.errors = {}; this.hists = {}; this.joinsPerSec = {}; }
  count(k, n = 1) { this.counts[k] = (this.counts[k] ?? 0) + n; }
  closeCode(code) { this.closes[code] = (this.closes[code] ?? 0) + 1; }
  error(code) { const k = typeof code === "string" && /^[a-z-]{1,32}$/.test(code) ? code : "other"; this.errors[k] = (this.errors[k] ?? 0) + 1; }
  hist(kind, role) { const k = role ? `${kind}.${role}` : kind; return (this.hists[k] ??= new Hist()); }
  join(ms, t, first) {
    this.hist("join").add(ms); this.count("welcomes");
    if (first) { this.count("joined"); const s = Math.max(0, Math.floor((t - this.t0) / 1000)); this.joinsPerSec[s] = (this.joinsPerSec[s] ?? 0) + 1; }
    else this.count("rejoins");
  }
  toJSON() {
    const hists = {}; for (const [k, h] of Object.entries(this.hists)) hists[k] = h.toJSON();
    return { counts: this.counts, closes: this.closes, errors: this.errors, hists, joinsPerSec: this.joinsPerSec };
  }
}

/**
 * @param {{ url: string, board: string, tokensPath: string, t0: number, loadFrom?: number, genEndAt: number, drainMs: number,
 *           clients: { role: string, token: number, name: string, startAt: number }[], cfg: object, worker?: number }} job
 *   t0 / loadFrom (ramp done) / genEndAt: wall-clock ms; startAt: ms after t0.
 */
export async function runWorker(job, { onProgress } = {}) {
  const byRole = readTokensByRole(job.tokensPath);
  const stats = new Stats(job.t0);
  const clients = [];
  const lag = new Hist(), cpu = [], cpuSpans = [];   // cpuSpans[i]: [start, end] wall-clock ms of sample cpu[i]
  const LAG_EVERY = 50;
  let last = performance.now();
  const lagTimer = setInterval(() => { const t = performance.now(); lag.add(Math.max(0, t - last - LAG_EVERY)); last = t; }, LAG_EVERY);
  let cpuPrev = process.cpuUsage(), cpuAt = performance.now(), cpuWall = Date.now();
  const cpuTimer = setInterval(() => {
    const u = process.cpuUsage(cpuPrev), t = performance.now();
    cpu.push(Math.round(((u.user + u.system) / 1000 / (t - cpuAt)) * 1000) / 10);   // % of one core
    cpuSpans.push([cpuWall, Date.now()]); cpuWall = Date.now();
    cpuPrev = process.cpuUsage(); cpuAt = t;
  }, 1000);
  const progress = onProgress ? setInterval(() => onProgress({ worker: job.worker ?? 0, joined: stats.counts.joined ?? 0, clients: job.clients.length, opsSent: stats.counts.opsSent ?? 0, closes: { ...stats.closes } }), 2000) : null;

  const starts = [];
  for (const c of job.clients) {
    const token = byRole[c.role]?.[c.token];
    if (!token) throw new Error(`tokens file has no ${c.role} token #${c.token}: make more with scripts/load/tokens.js`);
    const client = new LoadClient({ url: job.url, board: job.board, token, role: c.role, name: c.name, cfg: job.cfg, stats });
    clients.push(client);
    starts.push(setTimeout(() => { client.connect(); if (Date.now() < job.genEndAt) client.startGenerating(); }, Math.max(0, job.t0 + c.startAt - Date.now())));
  }

  await Bun.sleep(Math.max(0, job.genEndAt - Date.now()));
  for (const s of starts) clearTimeout(s);
  for (const c of clients) c.stopGenerating();

  // Drain: no new ops; wait for every pending op to be answered and applied (or the drain time to run out).
  const drainStart = Date.now();
  const pending = () => clients.reduce((n, c) => n + c.pendingCount(), 0);
  const unechoed = () => clients.reduce((n, c) => { for (const w of c.writeAt.values()) if (!w.echoed) n++; return n; }, 0);
  const unacked = () => clients.reduce((n, c) => { for (const w of c.writeAt.values()) if (!w.acked) n++; return n; }, 0);
  // An op can settle by its entry before its ack arrives: wait for both (writeAt empties only when both are seen).
  while (Date.now() - drainStart < job.drainMs && (pending() > 0 || clients.some(c => c.writeAt.size > 0))) await Bun.sleep(100);
  stats.counts.drainMs = Date.now() - drainStart;
  stats.counts.unanswered = pending();
  stats.counts.unechoed = unechoed();
  stats.counts.unacked = unacked();
  stats.counts.connectedAtEnd = clients.filter(c => c.welcomed).length;
  stats.counts.neverJoined = clients.filter(c => !c.welcomedOnce).length;
  stats.counts.clients = clients.length;

  clearInterval(lagTimer); clearInterval(cpuTimer); if (progress) clearInterval(progress);
  for (const c of clients) c.close();
  // The load phase (ramp done, still generating): the samples wholly inside it, so idle ramp and drain seconds
  // don't dilute a generator that was pinned while it mattered. run.js judges validity on these.
  const loadFrom = job.loadFrom ?? job.t0;
  const cpuLoad = cpu.filter((_, i) => cpuSpans[i][0] >= loadFrom - 50 && cpuSpans[i][1] <= job.genEndAt + 50);
  return { worker: job.worker ?? 0, pid: process.pid, stats: stats.toJSON(), lag: lag.toJSON(), cpu, cpuLoad };
}

if (import.meta.main) {
  process.on("message", async job => {
    try {
      const result = await runWorker(job, { onProgress: p => process.send({ type: "progress", ...p }) });
      process.send({ type: "result", result });
    } catch (err) {
      process.send({ type: "fail", message: String(err?.message ?? err).slice(0, 500) });
    }
    // Give the IPC message time to leave, then exit (open sockets are closing; don't wait for them).
    setTimeout(() => process.exit(0), 200);
  });
  process.send({ type: "ready" });
}
