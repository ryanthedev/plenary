// The load client (scripts/load/): stats on fixed inputs, merging workers, and live runs against a real
// single-node server/main.js (port 0, temp data dir) started by the run itself (--local).

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hist } from "../../scripts/load/stats.js";
import { mergeResults, planCounts, planClients, rigConfig, run, buildResult } from "../../scripts/load/run.js";
import { makeTokens, writeTokens, readTokensByRole } from "../../scripts/load/tokens.js";
import { writeFileSync, mkdirSync } from "node:fs";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
const tmp = p => mkdtempSync(join(tmpdir(), p));

// ---- stats ----

test("stats: nearest-rank percentiles on fixed inputs", () => {
  const h = new Hist();
  for (let i = 1; i <= 100; i++) h.add(i);
  expect(h.summary()).toEqual({ n: 100, mean: 50.5, min: 1, p50: 50, p95: 95, p99: 99, max: 100 });
  const g = new Hist();
  for (const v of [3, 1, 2]) g.add(v);
  expect([g.percentile(1), g.percentile(33.3), g.percentile(33.4), g.percentile(50), g.percentile(100)]).toEqual([1, 1, 2, 2, 3]);
  const one = new Hist(); one.add(7.25);   // 0.1 ms resolution
  expect(one.summary()).toMatchObject({ p50: 7.3, p99: 7.3, max: 7.25 });
  expect(new Hist().summary()).toEqual({ n: 0, mean: null, min: null, p50: null, p95: null, p99: null, max: null });
  const neg = new Hist(); neg.add(-5); neg.add(NaN);
  expect(neg.summary()).toMatchObject({ n: 2, min: 0, max: 0 });
});

test("stats: merging histograms gives the percentiles of all samples together (not an average)", () => {
  const a = new Hist(), b = new Hist(), all = new Hist();
  for (let i = 0; i < 90; i++) { a.add(1); all.add(1); }
  for (let i = 0; i < 10; i++) { b.add(1000); all.add(1000); }
  for (let i = 0; i < 5; i++) { b.add(1); all.add(1); }   // a value both workers saw: its counts must add
  const m = Hist.fromJSON(JSON.parse(JSON.stringify(a))).merge(JSON.parse(JSON.stringify(b)));
  expect(m.summary()).toEqual(all.summary());
  expect(m.percentile(95)).toBe(1000);   // an average of the two p95s would say 500.5
  expect(m.percentile(90)).toBe(1);
  expect(m.counts.get(10)).toBe(95);
});

function fakeWorker(worker, values, counts, closes) {
  const h = new Hist(); for (const v of values) h.add(v);
  const lag = new Hist(); lag.add(worker + 1);
  return { worker, pid: 1000 + worker, cpu: [10, 20], cpuLoadMean: 15, cpuLoadMs: 2000, lag: lag.toJSON(), stats: { counts, closes, errors: { unavailable: 1 }, hists: { "echo.editor": h.toJSON() }, joinsPerSec: { 0: counts.joined } } };
}

test("merge: two workers' counts add and their histograms merge exactly", () => {
  // The slowest drain first: neither "last worker wins" nor (below, reversed) "first worker wins" can pass.
  const m = mergeResults([
    fakeWorker(0, [1, 2, 3], { joined: 3, opsSent: 3, echoes: 3, clients: 3, drainMs: 900 }, { 1013: 2 }),
    fakeWorker(1, [100, 200], { joined: 2, opsSent: 2, echoes: 2, clients: 2, drainMs: 700 }, { 1013: 1, 1006: 4 }),
  ]);
  // Counts add; drainMs is the slowest worker's drain, not the sum.
  expect(m.counts).toEqual({ joined: 5, opsSent: 5, echoes: 5, clients: 5, drainMs: 900 });
  expect(mergeResults([fakeWorker(0, [1], { drainMs: 700 }, {}), fakeWorker(1, [1], { drainMs: 900 }, {})]).counts.drainMs).toBe(900);
  expect(m.closes).toEqual({ 1013: 3, 1006: 4 });
  expect(m.errors).toEqual({ unavailable: 2 });
  expect(m.joinsPerSec).toEqual({ 0: 5 });
  expect(m.hists["echo.editor"].summary()).toMatchObject({ n: 5, p50: 3, max: 200, min: 1 });
  expect(m.workers.map(w => w.clients)).toEqual([3, 2]);
  const r = buildResult({ merged: m, config: { url: "ws://x", board: "b" }, counts: { editor: 5, annotator: 0, viewer: 0 }, startedAt: 0, finishedAt: 1 });
  expect(r.connections).toMatchObject({ close1013: 3, closeOther: 4 });
  expect(r.valid).toBe(true);
});

test("plan: --clients splits like the NFRs, viewers share tokens, writers get one each", () => {
  expect(planCounts({ clients: "1005" })).toEqual({ editor: 5, annotator: 20, viewer: 980 });
  expect(planCounts({ editors: "2", annotators: "3", viewers: "4" })).toEqual({ editor: 2, annotator: 3, viewer: 4 });
  const tokensByRole = { editor: ["e0", "e1"], annotator: ["a0"], viewer: ["v0", "v1"] };
  const { jobs, viewersPerToken } = planClients({ editor: 2, annotator: 1, viewer: 5 }, { ramp: 10, procs: 2, tokensByRole });
  expect(viewersPerToken).toBe(3);
  expect(jobs.flat().length).toBe(8);
  expect(jobs[0].length + jobs[1].length).toBe(8);
  expect(jobs.flat().filter(c => c.role === "viewer").map(c => c.token).sort()).toEqual([0, 0, 0, 1, 1]);
  expect(jobs.flat().map(c => c.startAt).sort((a, b) => a - b)).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
  // Writers share a token when they must, at most 8 a user (the writer connection cap).
  expect(planClients({ editor: 16, annotator: 0, viewer: 0 }, { ramp: 10, procs: 1, tokensByRole }).perToken.editor).toBe(8);
  expect(() => planClients({ editor: 17, annotator: 0, viewer: 0 }, { ramp: 10, procs: 1, tokensByRole })).toThrow(/more than 8 per user/);
});

test("tokens: files are 0600; roles grouped; rig.json fields read", () => {
  const dir = tmp("plenary-load-tok-");
  const t = makeTokens({ editors: 2, annotators: 1, viewers: 65, viewersPerUser: 32 });
  const { jsonPath, envPath } = writeTokens(dir, t);
  expect(statSync(jsonPath).mode & 0o777).toBe(0o600);
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
  const by = readTokensByRole(jsonPath);
  expect([by.owner.length, by.editor.length, by.annotator.length, by.viewer.length]).toEqual([1, 2, 1, 3]);
  expect(readFileSync(envPath, "utf8")).toStartWith("PLENARY_DEV_TOKENS='{");
  const rig = tmp("plenary-load-rig-");
  // The shape scripts/cluster-rig.js writes (rig.json version 1)…
  writeFileSync(join(rig, "rig.json"), JSON.stringify({ version: 1, lb: { url: "http://127.0.0.1:9", wsUrl: "ws://127.0.0.1:9/ws", port: 9 }, tokensFile: "/abs/tokens.json" }));
  expect(rigConfig(rig)).toEqual({ url: "ws://127.0.0.1:9/ws", tokens: "/abs/tokens.json", board: null });
  // …and the fallbacks: an http LB URL becomes ws, a relative tokens path is read against the rig dir.
  writeFileSync(join(rig, "rig.json"), JSON.stringify({ lbUrl: "http://127.0.0.1:9", tokensPath: "dev-tokens.json" }));
  expect(rigConfig(rig)).toEqual({ url: "ws://127.0.0.1:9/ws", tokens: join(rig, "dev-tokens.json"), board: null });
});

// ---- live, against server/main.js ----

async function cli(args) {
  const p = Bun.spawn([process.execPath, RUN, ...args], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

test("live, 2 workers: 100 mixed clients join, every editor op is echoed, tokens never printed or saved", async () => {
  const out = tmp("plenary-load-run-");
  const r = await cli(["--local", "--editors", "5", "--annotators", "10", "--viewers", "85", "--ramp", "200", "--duration", "3", "--drain", "15", "--procs", "2", "--note-rate", "1", "--comment-rate", "1", "--out", out]);
  expect(r.code).toBe(0);
  const res = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  expect(res.schema).toBe("plenary.load.result/1");
  expect(res.clients).toMatchObject({ planned: 100, joined: 100, neverJoined: 0, connectedAtEnd: 100 });
  // --procs 2: both workers ran their half, merged into one result.
  expect(res.generator.workers.map(w => w.clients)).toEqual([50, 50]);
  // Each worker's CPU was judged over the load phase only: after the 0.5 s ramp, for the 3 s of load (not from t0).
  for (const w of res.generator.workers) { expect(w.cpuPct.loadMs).toBeGreaterThan(2500); expect(w.cpuPct.loadMs).toBeLessThan(3250); }
  expect(res.server.cpuPct.loadMean).toBeGreaterThanOrEqual(0);
  expect(res.join.latencyMs.n).toBe(100);
  expect(res.join.perSecond.reduce((n, x) => n + x.n, 0)).toBe(100);
  // Every editor op echoed (and acked); annotators' too.
  expect(res.ops.sent.editor).toBeGreaterThan(10);
  expect(res.ops.echoed.editor).toBe(res.ops.sent.editor);
  expect(res.ops.sent.annotator).toBeGreaterThan(5);
  expect(res.ops.echoed.total).toBe(res.ops.sent.total);
  expect(res.ops.acked).toBe(res.ops.sent.total);
  expect([res.ops.unanswered, res.ops.unechoed, res.ops.unacked, res.ops.dropped]).toEqual([0, 0, 0, 0]);
  expect(res.latencyMs.echo.editor.n).toBe(res.ops.sent.editor);
  expect(res.latencyMs.delivery.viewer.n).toBeGreaterThan(0);
  expect(res.connections.close1013).toBe(0);
  expect(res.server.pid).toBeGreaterThan(0);
  expect(readFileSync(join(out, "report.md"), "utf8")).toContain("100/100 clients joined");
  // Tokens: in the 0600 file only.
  const tokens = Object.keys(JSON.parse(readFileSync(join(out, "tokens", "dev-tokens.json"), "utf8")));
  expect(tokens.length).toBe(1 + 5 + 10 + 3);
  const texts = [r.stdout, r.stderr, readFileSync(join(out, "result.json"), "utf8"), readFileSync(join(out, "report.md"), "utf8"), readFileSync(join(out, "server.log"), "utf8")];
  for (const tok of tokens) for (const t of texts) expect(t.includes(tok)).toBe(false);
  expect(r.stdout).toContain("plan: 5 editors, 10 annotators, 85 viewers over 2 worker(s)");
}, 60000);

test("live: a server that refuses (user connection cap 2, three viewers on one token) is counted as 1013", async () => {
  const out = tmp("plenary-load-1013-");
  // On a board made through POST /boards (--create-board), as on a rig: the editor's grant and the viewers' memberRole work.
  const res = await run({ local: true, "create-board": true, editors: "1", viewers: "3", "viewers-per-user": "3", ramp: "50", duration: "2", drain: "5", procs: "1", out, serverEnv: { PLENARY_MAX_CONNS_PER_USER: "2" } }, { log: () => {} });
  expect(res.config.boardCreated).toBe(true);
  expect(res.ops.echoed.editor).toBe(res.ops.sent.editor);
  expect(res.ops.sent.editor).toBeGreaterThan(0);
  expect(res.clients).toMatchObject({ planned: 4, joined: 3, neverJoined: 1 });
  expect(res.connections.close1013).toBeGreaterThanOrEqual(1);
  expect(res.connections.closes["1013"]).toBe(res.connections.close1013);
  expect(res.connections.errors.unavailable).toBeGreaterThanOrEqual(1);
  expect(res.connections.reconnects).toBeGreaterThanOrEqual(1);
}, 30000);

test("valid: a generator late by > 100 ms (p99) or busier than 85% of a core marks the run invalid", () => {
  const counts = { editor: 1, annotator: 0, viewer: 0 }, base = { config: { url: "ws://x", board: "b" }, counts, startedAt: 0, finishedAt: 1 };
  const w = (lagMs, cpu) => { const r = fakeWorker(0, [1], { joined: 1, clients: 1 }, {}); const lag = new Hist(); for (let i = 0; i < 100; i++) lag.add(lagMs); r.lag = lag.toJSON(); r.cpu = cpu; r.cpuLoadMean = cpu.reduce((a, b) => a + b, 0) / cpu.length; return r; };
  expect(buildResult({ ...base, merged: mergeResults([w(5, [50, 60])]) })).toMatchObject({ valid: true, invalidReasons: [] });
  const late = buildResult({ ...base, merged: mergeResults([w(150, [50, 60])]) });
  expect(late.valid).toBe(false);
  expect(late.invalidReasons).toEqual(["worker 0: event-loop lag p99 150 ms > 100 ms"]);
  const busy = buildResult({ ...base, merged: mergeResults([w(5, [90, 95])]) });
  expect(busy.valid).toBe(false);
  expect(busy.invalidReasons[0]).toContain("CPU mean 92.5%");
});
