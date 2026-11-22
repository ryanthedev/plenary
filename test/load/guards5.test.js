// The load client's guards from the p8-load4v review (p8-load5): dropping everyone (or half the clients) mid-run and
// refusing rejoins reads INCOMPLETE, exit 1 (finding 1: connectedAtEnd < planned and skippedOffline > made for a due
// writer role); the due clock starts at each client's first welcome, so a slow welcome on a healthy server reads
// VALID (finding 2); unknown flags, a flag given as a value, --rig " " and an overly long ramp exit 2 (finding 3).

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mergeResults, buildResult, headline, exitCode, parseArgs, parseOptions, MAX_RAMP_S } from "../../scripts/load/run.js";
import { fakeServer } from "./fake-server.js";

const RUN = resolve(import.meta.dir, "../../scripts/load/run.js");
const CAL_DIR = resolve(import.meta.dir, "../../docs/m2/load/2026-11-12-calibration");
const tmp = p => mkdtempSync(join(tmpdir(), p));
const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? tmpdir() });
async function cli(args) {
  const p = Bun.spawn([process.execPath, RUN, ...args], { stdout: "pipe", stderr: "pipe", env: env() });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
const tokensFile = (dir, n = 1) => {
  const t = {}; for (let i = 0; i < n; i++) t[`lt-g5TOK${i}`] = { name: `g${i}`, role: "editor" };
  const p = join(dir, "t.json"); writeFileSync(p, JSON.stringify(t), { mode: 0o600 }); return p;
};

// ---- finding 1: connectedAtEnd < planned and skippedOffline > made ----

const worker = counts => ({ worker: 0, pid: 1, cpu: [5], cpuLoadMean: 5, cpuLoadMs: 1000, lag: { n: 0, sum: 0, counts: [] },
  stats: { counts: { joined: 4, neverJoined: 0, clients: 4, connectedAtEnd: 4, dueClients_editor: 2, dueClients_annotator: 0, ...counts }, closes: {}, errors: {}, hists: {}, joinsPerSec: {} } });
const judge = (counts, config = { opRate: 2, noteRate: 0, commentRate: 0, duration: 30 }, plan = { editor: 2, annotator: 0, viewer: 2 }) =>
  buildResult({ merged: mergeResults([worker(counts)]), config: { url: "ws://x", board: "b", ...config }, counts: plan, startedAt: 0, finishedAt: 1 });

test("buildResult + headline: disconnected clients at end or skippedOffline > made for a due role is INCOMPLETE", () => {
  // All ops answered, but 2 of 4 clients are disconnected at the end.
  const halfDown = judge({ connectedAtEnd: 2, opsMade: 20, opsMade_editor: 20, opsSent: 20, acks: 20, echoes: 20 });
  expect([halfDown.clients.connected, halfDown.ops.answered, halfDown.complete, exitCode(halfDown)]).toEqual([false, true, false, 1]);
  expect(headline(halfDown)).toBe("INCOMPLETE (2 of 4 planned clients were not connected at the end)");

  // Everyone connected at the end (rejoined during drain), but editors skipped more ticks offline than ops made.
  const keptOut = judge({ connectedAtEnd: 4, opsMade: 10, opsMade_editor: 10, opsSent: 10, acks: 10, echoes: 10, skippedOffline: 11, skippedOffline_editor: 11 });
  expect([keptOut.clients.connected, keptOut.ops.answered, keptOut.ops.keptOut, keptOut.complete, exitCode(keptOut)]).toEqual([true, false, ["editor"], false, 1]);
  expect(headline(keptOut)).toBe("INCOMPLETE (editors skipped 11 ops offline, more than the 10 they made)");

  // Brief drop: skippedOffline <= made and everyone reconnected by the drain's end -> VALID.
  const brief = judge({ connectedAtEnd: 4, opsMade: 10, opsMade_editor: 10, opsSent: 10, acks: 10, echoes: 10, skippedOffline: 10, skippedOffline_editor: 10 });
  expect([brief.clients.connected, brief.ops.answered, brief.complete, headline(brief), exitCode(brief)]).toEqual([true, true, true, "VALID", 0]);

  // Both failed at once: headline names both with numbers.
  const both = judge({ connectedAtEnd: 0, opsMade: 5, opsMade_editor: 5, opsSent: 5, acks: 5, echoes: 5, skippedOffline: 30, skippedOffline_editor: 30 });
  expect(headline(both)).toBe("INCOMPLETE (editors skipped 30 ops offline, more than the 5 they made; 4 of 4 planned clients were not connected at the end)");
});

/** Fake server for dropMid / dropMidErr / partialDrop / slowWelcome. */
function scriptedServer(mode, { dropAfterMs = 800, welcomeDelayMs = 0 } = {}) {
  const conns = new Set();
  let dropped = false, seq = 0, timer = null;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req, srv) { return srv.upgrade(req, { data: {} }) ? undefined : new Response("ws only", { status: 400 }); },
    websocket: {
      open(ws) { conns.add(ws); },
      close(ws) { conns.delete(ws); },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") {
          ws.data.client = m.client;
          const isVictim = mode !== "partialDrop" || (Number(m.client?.match(/^load-[a-z](\d+)/)?.[1] ?? 0) % 2 === 0);
          if (dropped && isVictim) {
            if (mode === "dropMidErr") { ws.send(JSON.stringify({ t: "error", code: "unavailable", message: "down" })); ws.close(1013, "down"); }
            else ws.close(1013, "down");
            return;
          }
          const sendWelcome = () => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify({ t: "welcome", user: "dev:g0", role: "editor", seq, horizon: 0 }));
          };
          if (welcomeDelayMs > 0) setTimeout(sendWelcome, welcomeDelayMs);
          else sendWelcome();
          if ((mode === "dropMid" || mode === "dropMidErr" || mode === "partialDrop") && !timer) {
            timer = setTimeout(() => {
              dropped = true;
              for (const c of [...conns]) {
                const v = mode !== "partialDrop" || (Number(c.data.client?.match(/^load-[a-z](\d+)/)?.[1] ?? 0) % 2 === 0);
                if (v) c.close(1013, "mid-run drop");
              }
            }, dropAfterMs);
          }
          return;
        }
        if (m.t === "op") {
          seq++;
          ws.send(JSON.stringify({ t: "ack", id: m.id, seq }));
          const entry = JSON.stringify({ t: "entry", seq, id: m.id, by: "dev:g0", stream: m.stream, op: m.op });
          for (const c of conns) if (c.readyState === 1) c.send(entry);
        }
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/ws`, stop: () => { if (timer) clearTimeout(timer); server.stop(true); } };
}

test("live CLI dropMid: server answers first ops, then drops everyone 1013 and refuses rejoins -> INCOMPLETE, exit 1", async () => {
  const s = scriptedServer("dropMid", { dropAfterMs: 700 });
  const dir = tmp("plenary-load-dropmid-"), tokens = tokensFile(dir);
  let r;
  try {
    r = await cli(["--url", s.url, "--board", "b", "--tokens", tokens, "--editors", "2", "--ramp", "20", "--duration", "4", "--drain", "1", "--op-rate", "6", "--out", join(dir, "out")]);
  } finally { s.stop(); }
  const res = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
  expect(res.ops.made.total).toBeGreaterThan(0);
  expect(res.clients.connectedAtEnd).toBe(0);
  expect(res.clients.connected).toBe(false);
  expect(res.ops.skippedOfflineBy.editor).toBeGreaterThan(res.ops.made.editor);
  expect([res.complete, r.code]).toEqual([false, 1]);
  expect(r.stdout).toContain("INCOMPLETE (");
  expect(r.stdout).toContain("2 of 2 planned clients were not connected at the end");
}, 25000);

test("live CLI dropMidErr: later hellos get error unavailable -> INCOMPLETE, exit 1", async () => {
  const s = scriptedServer("dropMidErr", { dropAfterMs: 700 });
  const dir = tmp("plenary-load-dropmiderr-"), tokens = tokensFile(dir);
  let r;
  try {
    r = await cli(["--url", s.url, "--board", "b", "--tokens", tokens, "--editors", "2", "--ramp", "20", "--duration", "4", "--drain", "1", "--op-rate", "6", "--out", join(dir, "out")]);
  } finally { s.stop(); }
  const res = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
  expect(res.ops.made.total).toBeGreaterThan(0);
  expect(res.clients.connectedAtEnd).toBe(0);
  expect([res.complete, r.code]).toEqual([false, 1]);
  expect(r.stdout).toContain("INCOMPLETE (");
}, 25000);

test("live CLI partialDrop: dropping half the clients for good -> INCOMPLETE, exit 1", async () => {
  const s = scriptedServer("partialDrop", { dropAfterMs: 700 });
  const dir = tmp("plenary-load-partial-"), tokens = tokensFile(dir);
  let r;
  try {
    r = await cli(["--url", s.url, "--board", "b", "--tokens", tokens, "--editors", "4", "--ramp", "40", "--duration", "3", "--drain", "1", "--op-rate", "4", "--out", join(dir, "out")]);
  } finally { s.stop(); }
  const res = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
  expect(res.ops.made.total).toBeGreaterThan(0);
  expect(res.clients.connectedAtEnd).toBe(2);
  expect(res.clients.connected).toBe(false);
  expect([res.complete, r.code]).toEqual([false, 1]);
  expect(r.stdout).toContain("2 of 4 planned clients were not connected at the end");
}, 25000);

// ---- finding 2: due clock starts at welcome, so slowWelcome on a healthy server reads VALID ----

test("live CLI slowWelcome: welcome delayed 900 ms on a 1 s run at 1.5/s -> VALID, exit 0", async () => {
  const s = scriptedServer("slowWelcome", { welcomeDelayMs: 900 });
  const dir = tmp("plenary-load-sloww-"), tokens = tokensFile(dir);
  let r;
  try {
    r = await cli(["--url", s.url, "--board", "b", "--tokens", tokens, "--editors", "1", "--ramp", "10", "--duration", "1", "--drain", "1", "--op-rate", "1.5", "--out", join(dir, "out")]);
  } finally { s.stop(); }
  const res = JSON.parse(readFileSync(join(dir, "out", "result.json"), "utf8"));
  expect(res.clients.complete).toBe(true);
  expect(res.clients.connected).toBe(true);
  expect([res.complete, r.code]).toEqual([true, 0]);
  expect(r.stdout).toContain("**VALID**");
}, 20000);

// ---- finding 3: unknown flags, flag-as-value, --rig " ", ramp cap ----

test("parseArgs and parseOptions: unknown flags, flag-as-value, and ramp cap refused", () => {
  expect(() => parseArgs(["--op_rate", "5"])).toThrow("unknown flag --op_rate (see --help)");
  expect(() => parseArgs(["--tokens", "--local"])).toThrow("--tokens needs a value, not the flag --local");
  expect(() => parseArgs(["--rig", "--create-board"])).toThrow("--rig needs a value, not the flag --create-board");
  expect(() => parseOptions({ viewers: "1000000", ramp: "1" })).toThrow(`at most ${MAX_RAMP_S} s; raise --ramp`);
  // At the ramp bound (3600 s): accepted.
  expect(parseOptions({ editors: "0", viewers: "3600", ramp: "1" }).counts.viewer).toBe(3600);
});

test("CLI exit 2: --op_rate 5, --tokens --local, --rig \" \", and ramp over 3600 s", async () => {
  const cases = [
    [["--op_rate", "5"], "unknown flag --op_rate (see --help)"],
    [["--tokens", "--local"], "--tokens needs a value, not the flag --local"],
    [["--rig", " ", "--editors", "1"], "load: --rig is empty"],
    [["--viewers", "1000000", "--ramp", "1"], "load: the ramp would take 1000005 s (clients / --ramp): at most 3600 s; raise --ramp"],
  ];
  for (const [args, msg] of cases) {
    const r = await cli(args);
    expect([r.code, r.stderr.trim()]).toEqual([2, msg]);
  }
}, 20000);

// ---- calibration result.json files: neither new rule flips any of the 15 documented runs ----

test("none of the 15 calibration result.json files flips under connectedAtEnd or skippedOffline > made", () => {
  const files = [];
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === "result.json") files.push(p);
    }
  };
  walk(CAL_DIR);
  expect(files.length).toBe(15);
  for (const p of files) {
    const r = JSON.parse(readFileSync(p, "utf8"));
    expect(r.clients.connectedAtEnd).toBe(r.clients.planned);
    expect(r.ops.skippedOffline).toBeLessThanOrEqual(r.ops.sent.total);
  }
});
