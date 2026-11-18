// The load client's guards from the p8-load4v review (p8-load5): a server that drops clients mid-run and refuses
// their rejoins is not VALID (MEDIUM: clients must stay connected, ops must not mostly be skipped offline); a
// client's due clock starts at its welcome, not its connect (L2); unknown flags, a flag given as another flag's
// value, and a ramp of years are refused, and --rig goes through the same empty-flag check (L3).

import { test, expect, afterAll } from "bun:test";
import { tmp, cleanTmp } from "./tmp.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mergeResults, buildResult, headline, exitCode, parseArgs, parseOptions, dueRoles, MAX_RAMP_S } from "../../scripts/load/run.js";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
afterAll(cleanTmp);
const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir() });
async function cli(args) {
  const p = Bun.spawn([process.execPath, RUN, ...args], { stdout: "pipe", stderr: "pipe", env: env() });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
const tokensFile = (dir, n) => {
  const t = {}; for (let i = 0; i < n; i++) t[`lt-g5TOK${i}`] = { name: `g${i}`, role: "editor" };
  const p = join(dir, "t.json"); writeFileSync(p, JSON.stringify(t), { mode: 0o600 }); return p;
};

// ---- the verdict, from counts ----

const worker = counts => ({ worker: 0, pid: 1, cpu: [5], cpuLoadMean: 5, cpuLoadMs: 1000, lag: { n: 0, sum: 0, counts: [] },
  stats: { counts: { joined: 4, neverJoined: 0, clients: 4, connectedAtEnd: 4, ...counts }, closes: {}, errors: {}, hists: {}, joinsPerSec: {} } });
const judge = (counts, config = {}, plan = { editor: 4, annotator: 0, viewer: 0 }) =>
  buildResult({ merged: mergeResults([worker(counts)]), config: { url: "ws://x", board: "b", opRate: 2, noteRate: 0, commentRate: 0, duration: 30, ...config }, counts: plan, startedAt: 0, finishedAt: 1 });
const ok = { opsMade: 40, opsMade_editor: 40, opsSent: 40, acks: 40, echoes: 40 };

test("stayed: a client not connected at the end is INCOMPLETE (exit 1), naming the numbers", () => {
  expect(headline(judge(ok))).toBe("VALID");
  const r = judge({ ...ok, connectedAtEnd: 3 });
  expect([r.clients.stayed, r.complete, exitCode(r)]).toEqual([false, false, 1]);
  expect(headline(r)).toBe("INCOMPLETE (only 3 of 4 clients were connected at the end)");
  expect(headline(judge({ ...ok, connectedAtEnd: 0 }))).toContain("only 0 of 4 clients were connected at the end");
});

test("present: with a role due, ops skipped offline above ops made is INCOMPLETE; equal passes; nothing due is not judged", () => {
  expect(headline(judge({ ...ok, skippedOffline: 40 }))).toBe("VALID");
  const r = judge({ ...ok, skippedOffline: 41 });
  expect([r.ops.present, r.complete, exitCode(r)]).toEqual([false, false, 1]);
  expect(headline(r)).toBe("INCOMPLETE (41 ops were skipped offline against 40 made)");
  // No role due (op rate 0): a joins-only run; ops skipped offline are not judged.
  expect(headline(judge({ skippedOffline: 5 }, { opRate: 0 }))).toBe("VALID");
});

test("due clock: with the workers' dueClients counts a role is due only if a client had a whole window after its welcome", () => {
  const plan = { editor: 2, annotator: 1, viewer: 0 }, cfg = { opRate: 2, noteRate: 2, commentRate: 0, duration: 30 };
  expect(dueRoles(plan, cfg)).toEqual(["editor", "annotator"]);                                    // the plan alone
  expect(dueRoles(plan, cfg, { editor: 1, annotator: 0 })).toEqual(["editor"]);                    // the annotator welcomed too late
  expect(dueRoles(plan, cfg, { editor: 0, annotator: 0 })).toEqual([]);
  const r = judge({ dueClients: 0, dueClients_editor: 0 }, { duration: 1, opRate: 1.5 }, { editor: 1, annotator: 0, viewer: 0 });
  expect([r.ops.due, r.ops.missing]).toEqual([[], []]);
});

// ---- live: drop clients mid-run, refuse their rejoins; a slow welcome ----

/**
 * A fake server: welcomes everyone, echoes and acks every op. `welcomeDelay`: ms before each welcome. `drop` (after
 * `dropAfter` ms from the first hello): "all" closes every socket 1013, "half" closes the sockets of the first half
 * of the users; their later hellos are refused by `refuse`: "close" (1013 at once) or "error" (error unavailable).
 */
function midServer({ welcomeDelay = 0, drop = null, dropAfter = 1500, refuse = "close", users = 4 } = {}) {
  let seq = 0, timer = null; const log = []; const dropped = new Set(), conns = new Set();
  const sendAll = o => { for (const c of conns) if (c.data.welcomed) c.send(JSON.stringify(o)); };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req, { data: { welcomed: false } }) ? undefined : new Response("ws only", { status: 400 }); },
    websocket: {
      open(ws) { conns.add(ws); }, close(ws) { conns.delete(ws); },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") {
          if (dropped.has(m.token)) {
            if (refuse === "error") ws.send(JSON.stringify({ t: "error", code: "unavailable" }));
            ws.close(1013, "busy"); return;
          }
          if (drop && !timer) timer = setTimeout(() => {
            const all = [...conns].filter(c => c.data.token);
            const victims = drop === "all" ? all : all.slice(0, Math.floor(users / 2));
            for (const c of victims) { dropped.add(c.data.token); c.close(1013, "gone"); }
          }, dropAfter);
          ws.data.token = m.token;
          const reply = () => { ws.data.welcomed = true; ws.send(JSON.stringify({ t: "welcome", user: "dev:g", role: "editor", seq, horizon: 0 })); const back = log.filter(e => e.seq > (m.since ?? 0)); if (back.length) ws.send(JSON.stringify({ t: "entries", entries: back })); };
          welcomeDelay ? setTimeout(() => { if (ws.readyState === 1) reply(); }, welcomeDelay) : reply();
        } else if (m.t === "op") {
          const e = { seq: ++seq, id: m.id, by: "dev:g", at: Date.now(), stream: m.stream, op: m.op };
          log.push(e); sendAll({ t: "entries", entries: [e] });
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: "ack", id: m.id, seq: e.seq }));
        }
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => { clearTimeout(timer); server.stop(true); } };
}
async function liveRun(url, extra = [], { editors = 4, duration = 5 } = {}) {
  const dir = tmp("plenary-load-g5live-");
  const r = await cli(["--url", url, "--board", "b", "--tokens", tokensFile(dir, editors), "--editors", String(editors), "--ramp", "10", "--duration", String(duration), "--drain", "1", "--op-rate", "4", "--cursor-rate", "0", "--out", join(dir, "out"), ...extra]);
  return { ...r, res: JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) };
}

for (const [name, drop, refuse, left] of [
  ["drops every client mid-run and refuses rejoins (close 1013)", "all", "close", 0],
  ["drops every client mid-run and answers rejoins with an error", "all", "error", 0],
  ["drops half the clients for good", "half", "close", 2],
]) {
  test(`live CLI: a server that ${name} headlines INCOMPLETE and exits 1`, async () => {
    const s = midServer({ drop, refuse });
    let r; try { r = await liveRun(s.url); } finally { s.stop(); }
    expect(r.res.clients.connectedAtEnd).toBe(left);
    expect(r.res.ops.made.total).toBeGreaterThan(0);                  // it did answer ops before the drop
    expect([r.res.clients.stayed, r.res.complete, r.code]).toEqual([false, false, 1]);
    expect(r.stdout).toContain(`**INCOMPLETE (only ${left} of 4 clients were connected at the end`);
  }, 30000);
}

test("live CLI: a healthy server reads VALID, exit 0 (the new rules do not flip a good run)", async () => {
  const s = midServer();
  let r; try { r = await liveRun(s.url, [], { duration: 3 }); } finally { s.stop(); }
  expect([r.res.clients.connectedAtEnd, r.res.clients.stayed, r.res.ops.present, r.res.complete, r.code]).toEqual([4, true, true, true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 30000);

test("live CLI: a slow welcome on a healthy server reads VALID (the due clock starts at the welcome); ticks before it are not skipped", async () => {
  const s = midServer({ welcomeDelay: 900, users: 1 });
  let r; try { r = await liveRun(s.url, ["--op-rate", "1.5"], { editors: 1, duration: 1 }); } finally { s.stop(); }
  expect(r.res.ops.skippedOffline).toBe(0);
  expect([r.res.ops.due, r.res.complete, r.code]).toEqual([[], true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 30000);

// ---- L3: arguments ----

test("parseArgs refuses an unknown flag and a flag whose value is another flag, naming it", () => {
  expect(() => parseArgs(["--op_rate", "5"])).toThrow("unknown flag --op_rate");
  expect(() => parseArgs(["--tokens", "--local"])).toThrow("--tokens needs a value, not the flag --local");
  expect(() => parseArgs(["--viewers", "5", "--bogus"])).toThrow("unknown flag --bogus");
  expect(() => parseArgs(["--out"])).toThrow("--out needs a value");
  // every real flag still parses
  expect(parseArgs(["--local", "--create-board", "--viewers", "5", "--viewers-per-user", "2", "--tokens", "/x", "--op-rate", "0"])).toEqual({ local: true, "create-board": true, viewers: "5", "viewers-per-user": "2", tokens: "/x", "op-rate": "0" });
});

test("CLI: unknown flags and flag-as-value exit 2 with a message naming the flag; --rig ' ' gets the empty-flag message", async () => {
  const a = await cli(["--local", "--op_rate", "5"]);
  expect([a.code, a.stderr]).toEqual([2, "unknown flag --op_rate (see --help)\n"]);
  const b = await cli(["--tokens", "--local"]);
  expect([b.code, b.stderr]).toEqual([2, "--tokens needs a value, not the flag --local\n"]);
  const c = await cli(["--rig", " ", "--editors", "1"]);
  expect([c.code, c.stderr]).toEqual([2, "load: --rig is empty\n"]);
});

test("the ramp may take at most 3600 s: refused past it, accepted at it", () => {
  expect(MAX_RAMP_S).toBe(3600);
  expect(() => parseOptions({ editors: "0", viewers: "1000000", ramp: "1" })).toThrow(/ramp would take 1000000 s/);
  expect(() => parseOptions({ editors: "0", viewers: "3600", ramp: "1" })).not.toThrow();
  expect(() => parseOptions({ editors: "0", viewers: "3601", ramp: "1" })).toThrow(/ramp would take/);
});
