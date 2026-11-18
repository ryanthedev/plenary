// The load client's guards from the p8-load4v review (p8-load5): a server that drops clients mid-run and refuses
// their rejoins is not VALID (MEDIUM: clients must stay connected, ops must not mostly be skipped offline); a
// client's due clock starts at its welcome, not its connect (L2); unknown flags, a flag given as another flag's
// value, and a ramp of years are refused, and --rig goes through the same empty-flag check (L3).

import { test, expect, beforeAll, afterAll } from "bun:test";
import { tmp, cleanTmp, useScratch, scenarioGroup, childEnv } from "./tmp.js";
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mergeResults, buildResult, headline, exitCode, parseArgs, parseOptions, dueRoles, run, MAX_RAMP_S } from "../../scripts/load/run.js";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
beforeAll(useScratch); afterAll(cleanTmp);
const env = childEnv;
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

test("lateJoined: a client welcomed after the join ceiling is INCOMPLETE (exit 1), naming the numbers", () => {
  const r = judge({ ...ok, lateJoined: 1 });
  expect([r.clients.lateJoined, r.clients.complete, r.complete, exitCode(r)]).toEqual([1, false, false, 1]);
  expect(headline(r)).toBe("INCOMPLETE (1 of 4 clients were welcomed more than 10 s after they first connected)");
  expect(headline(judge({ ...ok, lateJoined: 0 }))).toBe("VALID");
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
 * of the users, "one" the first user's only; their later hellos are refused by `refuse`: "close" (1013 at once) or
 * "error" (error unavailable), or, with `rejoinDelay` (ms), welcomed that long after the hello (a server that comes
 * back late), or, with `refuse: null`, welcomed at once (a transient drop).
 */
function midServer({ welcomeDelay = 0, drop = null, dropAfter = 1500, refuse = "close", users = 4, rejoinDelay = null, dropOne = false } = {}) {
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
          if (dropped.has(m.token) && !rejoinDelay && refuse) {
            if (refuse === "error") ws.send(JSON.stringify({ t: "error", code: "unavailable" }));
            ws.close(1013, "busy"); return;
          }
          const delay = dropped.has(m.token) && rejoinDelay ? rejoinDelay : welcomeDelay;
          if (drop && !timer) timer = setTimeout(() => {
            const all = [...conns].filter(c => c.data.token);
            const victims = drop === "all" ? all : drop === "one" ? all.slice(0, 1) : all.slice(0, Math.floor(users / 2));
            for (const c of victims) { dropped.add(c.data.token); c.close(1013, "gone"); }
          }, dropAfter);
          ws.data.token = m.token;
          const reply = () => { ws.data.welcomed = true; ws.send(JSON.stringify({ t: "welcome", user: "dev:g", role: "editor", seq, horizon: 0 })); const back = log.filter(e => e.seq > (m.since ?? 0)); if (back.length) ws.send(JSON.stringify({ t: "entries", entries: back })); };
          delay ? setTimeout(() => { if (ws.readyState === 1) reply(); }, delay) : reply();
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
async function liveRun(url, extra = [], { editors = 4, duration = 5, opRate = 4 } = {}) {
  const dir = tmp("plenary-load-g5live-");
  const r = await cli(["--url", url, "--board", "b", "--tokens", tokensFile(dir, editors), "--editors", String(editors), "--ramp", "10", "--duration", String(duration), "--drain", "1", "--op-rate", String(opRate), "--cursor-rate", "0", "--out", join(dir, "out"), ...extra]);
  return { ...r, res: JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8")) };
}

// The live scenarios each need a few seconds of a real run. They are independent (own server, own CLI process), so
// they run at once, started by the first test that asks for one; each test then checks its own.
const group = scenarioGroup(), scenarios = group.fns, scenario = group.get;
const withServer = (opts, body) => async () => { const s = midServer(opts); try { return await body(s); } finally { s.stop(); } };

for (const [name, drop, refuse, left] of [
  ["drops every client mid-run and refuses rejoins (close 1013)", "all", "close", 0],
  ["drops every client mid-run and answers rejoins with an error", "all", "error", 0],
  ["drops half the clients for good", "half", "close", 2],
]) {
  scenarios[name] = withServer({ drop, refuse, dropAfter: 800 }, s => liveRun(s.url, [], { duration: 3 }));
  test(`live CLI: a server that ${name} headlines INCOMPLETE and exits 1`, async () => {
    const r = await scenario(name);
    expect(r.res.clients.connectedAtEnd).toBe(left);
    expect(r.res.ops.made.total).toBeGreaterThan(0);                  // it did answer ops before the drop
    expect([r.res.clients.stayed, r.res.complete, r.code]).toEqual([false, false, 1]);
    expect(r.stdout).toContain(`**INCOMPLETE (only ${left} of 4 clients were connected at the end`);
  }, 30000);
}

scenarios.healthy = withServer({}, s => liveRun(s.url, [], { duration: 2 }));
test("live CLI: a healthy server reads VALID, exit 0 (the new rules do not flip a good run)", async () => {
  const r = await scenario("healthy");
  expect([r.res.clients.connectedAtEnd, r.res.clients.stayed, r.res.ops.present, r.res.complete, r.code]).toEqual([4, true, true, true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 30000);

scenarios.slow = withServer({ welcomeDelay: 900, users: 1 }, s => liveRun(s.url, [], { editors: 1, duration: 1, opRate: 1.5 }));
test("live CLI: a slow welcome on a healthy server reads VALID (the due clock starts at the welcome); ticks before it are not skipped", async () => {
  const r = await scenario("slow");
  expect(r.res.ops.skippedOffline).toBe(0);
  expect([r.res.ops.due, r.res.complete, r.code]).toEqual([[], true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 30000);

// X4 (p8-load5v LOW 3): the due clock is each client's FIRST welcome. Every client is dropped at 0.8 s and welcomed
// back 3.5 s later, about 1.1 s before the end: measured from that second welcome no role is due and the run would read
// VALID with no ops made; from the first welcome the editors were due, offline most of the run, and it is INCOMPLETE.
scenarios.lateRejoin = withServer({ drop: "all", dropAfter: 800, rejoinDelay: 3500 }, s => liveRun(s.url, [], { duration: 5, opRate: 1 }));
test("live CLI: clients dropped at once and welcomed back late read INCOMPLETE (the due clock is the first welcome, not the last)", async () => {
  const r = await scenario("lateRejoin");
  expect(r.res.clients.connectedAtEnd).toBe(4);                      // they did come back before the end
  expect(r.res.ops.due).toEqual(["editor"]);
  expect(r.res.ops.skippedOffline).toBeGreaterThan(r.res.ops.made.total);
  expect([r.res.ops.present, r.res.complete, r.code]).toEqual([false, false, 1]);
  expect(r.stdout).toContain("**INCOMPLETE (");   // "no editor op was made" or "N ops were skipped offline against M made": made before the drop varies
}, 30000);

// L3 (p8-load5v LOW 4): one client dropped 200 ms before generation ends and let back in at once is back within the
// drain's rejoin grace: VALID. The same drop with the rejoin refused stays INCOMPLETE (the three drop tests above).
scenarios.transient = withServer({ drop: "one", dropAfter: 3200, refuse: null }, s => liveRun(s.url, [], { duration: 3 }));
test("live CLI: one client dropped just before the end and let back in reads VALID (a bounded rejoin grace); a permanent drop does not", async () => {
  const r = await scenario("transient");
  expect(r.res.connections.closes["1013"]).toBe(1);                  // the drop really happened
  expect(r.res.connections.rejoins).toBeGreaterThanOrEqual(1);
  expect([r.res.clients.connectedAtEnd, r.res.clients.stayed, r.res.complete, r.code]).toEqual([4, true, true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 30000);

scenarios.permanentNearEnd = withServer({ drop: "one", dropAfter: 3200, refuse: "close" }, s => liveRun(s.url, [], { duration: 3 }));
test("live CLI: one client dropped just before the end and refused stays INCOMPLETE after the grace", async () => {
  const r = await scenario("permanentNearEnd");
  expect([r.res.clients.connectedAtEnd, r.res.clients.stayed, r.code]).toEqual([3, false, 1]);
  expect(r.stdout).toContain("**INCOMPLETE (only 3 of 4 clients were connected at the end");
}, 30000);

// (b): welcomed later than the join ceiling after its first connect = not joined in time. run() takes the ceiling as
// an internal option (joinCeilingMs, as serverEnv); the CLI uses 10 s.
scenarios.lateJoin = withServer({ welcomeDelay: 1500, users: 2 }, async s => {
  const dir = tmp("plenary-load-g5late-");
  return run({ url: s.url, board: "b", tokens: tokensFile(dir, 2), editors: "2", ramp: "10", duration: "2", drain: "1", "op-rate": "4", "cursor-rate": "0", out: join(dir, "out"), joinCeilingMs: 1000 }, { log: () => {} });
});
test("a client welcomed more than the join ceiling after it first connected is INCOMPLETE (exit 1), not VALID", async () => {
  const res = await scenario("lateJoin");
  expect(res.clients).toMatchObject({ planned: 2, joined: 2, neverJoined: 0, lateJoined: 2, complete: false });
  expect(headline(res)).toBe("INCOMPLETE (2 of 2 clients were welcomed more than 1 s after they first connected)");
  expect([res.complete, exitCode(res)]).toEqual([false, 1]);
}, 30000);

// ---- L3: arguments ----

test("parseArgs refuses an unknown flag and a flag whose value is another flag, naming it", () => {
  expect(() => parseArgs(["--op_rate", "5"])).toThrow("unknown flag --op_rate");
  expect(() => parseArgs(["--tokens", "--local"])).toThrow("--tokens needs a value, not the flag --local");
  expect(() => parseArgs(["--viewers", "5", "--bogus"])).toThrow("unknown flag --bogus");
  expect(() => parseArgs(["--out"])).toThrow("--out needs a value");
  // names on Object.prototype are not flags (a plain `in` check would accept them)
  for (const k of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) expect(() => parseArgs([`--${k}`, "5"])).toThrow(`unknown flag --${k}`);
  // a flag given twice is refused, booleans included
  expect(() => parseArgs(["--op-rate", "4", "--op-rate", "0.5"])).toThrow("--op-rate given twice");
  expect(() => parseArgs(["--local", "--local"])).toThrow("--local given twice");
  // every real flag still parses
  expect(parseArgs(["--local", "--create-board", "--viewers", "5", "--viewers-per-user", "2", "--tokens", "/x", "--op-rate", "0"])).toEqual({ local: true, "create-board": true, viewers: "5", "viewers-per-user": "2", tokens: "/x", "op-rate": "0" });
});

test("CLI: unknown flags and flag-as-value exit 2 with a message naming the flag; --rig ' ' gets the empty-flag message", async () => {
  const a = await cli(["--local", "--op_rate", "5"]);
  expect([a.code, a.stderr]).toEqual([2, "unknown flag --op_rate (see --help)\n"]);
  const b = await cli(["--tokens", "--local"]);
  expect([b.code, b.stderr]).toEqual([2, "--tokens needs a value, not the flag --local\n"]);
  const d = await cli(["--editors", "1", "--editors", "2"]);
  expect([d.code, d.stderr]).toEqual([2, "--editors given twice\n"]);
  const e = await cli(["--local", "--toString", "5", "--editors", "1"]);
  expect([e.code, e.stderr]).toEqual([2, "unknown flag --toString (see --help)\n"]);
  const c = await cli(["--rig", " ", "--editors", "1"]);
  expect([c.code, c.stderr]).toEqual([2, "load: --rig is empty\n"]);
});

test("the ramp may take at most 3600 s: refused past it, accepted at it", () => {
  expect(MAX_RAMP_S).toBe(3600);
  expect(() => parseOptions({ editors: "0", viewers: "1000000", ramp: "1" })).toThrow(/ramp would take 1000000 s/);
  expect(() => parseOptions({ editors: "0", viewers: "3600", ramp: "1" })).not.toThrow();
  expect(() => parseOptions({ editors: "0", viewers: "3601", ramp: "1" })).toThrow(/ramp would take/);
});
