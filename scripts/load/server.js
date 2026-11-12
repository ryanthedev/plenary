// Start one single-node server (server/main.js) for a load run or a test: port 0, a data dir, dev tokens from a
// tokens file (never on argv or stdout). Returns its PID, port, URLs and the dev board id it logged.
//
// The child runs in an empty temp cwd, so Bun's .env auto-load never pulls a checkout's .env into it, and through
// `sh -c 'ulimit -n N; exec bun …'` so it can hold many sockets. Its stdout (JSON log lines) is kept in memory
// and optionally copied to a log file; nothing from it is printed here.

import { mkdtempSync, readFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../../server/main.js");

/**
 * @param {{ tokensPath: string, dataDir?: string, env?: Record<string,string>, nofile?: number, logPath?: string, timeoutMs?: number }} o
 * @returns {Promise<{ pid: number, port: number, httpUrl: string, wsUrl: string, board: string, dataDir: string, child: any, lines: () => object[], stop: () => Promise<void> }>}
 */
export async function startServer({ tokensPath, dataDir, env = {}, nofile = 65536, logPath, timeoutMs = 20000 }) {
  dataDir ??= mkdtempSync(join(tmpdir(), "plenary-load-data-"));
  const cwd = mkdtempSync(join(tmpdir(), "plenary-load-cwd-"));
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: "0", PLENARY_DATA_DIR: dataDir, LOG_LEVEL: "info",
    PLENARY_DEV_TOKENS: readFileSync(tokensPath, "utf8"), ...env,
  };
  const child = Bun.spawn(["sh", "-c", `ulimit -n ${Math.floor(nofile)} 2>/dev/null; exec "$0" "$1"`, process.execPath, MAIN], { cwd, env: childEnv, stdout: "pipe", stderr: "pipe" });
  const out = { text: "", err: "" };
  const file = logPath ? createWriteStream(logPath, { mode: 0o600 }) : null;
  const pump = async (stream, k) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const s = dec.decode(chunk, { stream: true });
      // Keep only the head of stdout in memory (a long run logs a lot); the file gets everything.
      if (out[k].length < 4_000_000) out[k] += s;
      file?.write(s);
    }
  };
  pump(child.stdout, "text"); pump(child.stderr, "err");
  const lines = () => out.text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const until = async (msg) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const all = lines(), hit = all.find(l => l.msg === msg);
      if (hit) return hit;
      // The server refused the tokens (server/main.js logs a fixed sentence, no token): say so now, not after the timeout.
      const refused = all.find(l => typeof l.msg === "string" && l.msg.startsWith("PLENARY_DEV_TOKENS "));
      if (refused) throw new Error(`the server rejected the tokens file ${tokensPath}: "${refused.msg}"`);
      if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}) before "${msg}"; stderr: ${out.err.slice(0, 300)}`);
      await Bun.sleep(25);
    }
    throw new Error(`server: no "${msg}" log line within ${timeoutMs} ms`);
  };
  try {
    const { port } = await until("server listening");
    const { board } = await until("dev tokens are ON: not for production");
    return {
      pid: child.pid, port, board, dataDir, child, out, lines,
      httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`,
      async stop() {
        if (child.exitCode === null) { child.kill("SIGTERM"); const t = setTimeout(() => child.kill("SIGKILL"), 5000); await child.exited; clearTimeout(t); }
        file?.end();
      },
    };
  } catch (err) { child.kill("SIGKILL"); await child.exited; file?.end(); throw err; }
}

/**
 * Sample a process with ps: its cumulative CPU time (s) and RSS (KB); null if it is gone. CPU % comes from the
 * difference of two samples (cpuPct): macOS's own `ps %cpu` is a decaying average that hides saturation.
 */
export function psSample(pid) {
  const r = Bun.spawnSync(["ps", "-o", "time=,rss=", "-p", String(pid)]);
  const s = r.stdout.toString().trim();
  if (!s) return null;
  const [time, rss] = s.split(/\s+/);
  // [[dd-]hh:]mm:ss.cc
  let days = 0, rest = time;
  if (rest.includes("-")) { const [d, x] = rest.split("-"); days = Number(d); rest = x; }
  const cpuS = days * 86400 + rest.split(":").map(Number).reduce((acc, v) => acc * 60 + v, 0);
  return { at: Date.now(), cpuS, rssKb: Number(rss) };
}

/** CPU % of one core between consecutive samples. */
export function cpuPct(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].at - samples[i - 1].at) / 1000;
    if (dt > 0) out.push(Math.round(((samples[i].cpuS - samples[i - 1].cpuS) / dt) * 1000) / 10);
  }
  return out;
}
