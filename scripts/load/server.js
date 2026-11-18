// Start one single-node server (server/main.js) for a load run or a test: a free port, a data dir, dev tokens from a
// tokens file (never on argv or stdout). Ready when GET /health answers (and its dev-tokens log line, which names
// the dev board, is in). Returns its PID, port, URLs and the dev board id it logged. Its data and working dirs are
// temp dirs removed when it stops (or dies as an orphan) unless `keep`.
//
// The child runs in an empty temp cwd, so Bun's .env auto-load never pulls a checkout's .env into it, and through
// `sh -c 'ulimit -n N; exec bun …'` so it can hold many sockets. Its stdout (JSON log lines) is kept in memory
// and optionally copied to a log file; nothing from it is printed here.
//
// Orphan watch: the child also preloads this file (bun --preload) with PLENARY_LOAD_PARENT = the starting process's
// PID. In the server process, the block at the bottom then checks every 500 ms that its parent is still that PID; if
// not (run.js was SIGKILLed, or died before the server started), it sends itself SIGTERM (server/main.js's own clean
// stop) and exits after 5 s if that did not end it. server/main.js itself is not changed.

import { mkdtempSync, readFileSync, createWriteStream, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../../server/main.js");
const SELF = import.meta.path;
export const ORPHAN_CHECK_MS = 500;
export const SPAWN_TIMEOUT_MS = 5000;   // every ps / sh / sysctl call this tooling makes is bounded
export const HEAD_BYTES = 256 * 1024;          // the head of the server's stdout / stderr kept in memory (the log file gets all)

/** Resolve true if the child exits within ms, false if not (it never rejects, never waits longer than ms). */
export function exitedWithin(c, ms) {
  let t;
  return Promise.race([c.exited.then(() => true, () => true), new Promise(r => { t = setTimeout(r, ms, false); })]).finally(() => clearTimeout(t));
}

/**
 * Stop a child process, bounded: SIGTERM, SIGKILL after graceMs, and give up waiting finalMs after that (a process
 * that survives SIGKILL, in uninterruptible sleep, must not hang the run). Resolves true if it exited.
 */
export async function stopChild(c, graceMs = 5000, finalMs = 2000) {
  if (c.exitCode !== null || c.signalCode) return true;
  try { c.kill("SIGTERM"); } catch { /* gone */ }
  if (await exitedWithin(c, graceMs)) return true;
  try { c.kill("SIGKILL"); } catch { /* gone */ }
  return exitedWithin(c, finalMs);
}

/** A port nothing listens on right now (port 0, read back, released). */
function freePort() {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port; s.stop(true); return port;
}

/**
 * @param {{ tokensPath: string, dataDir?: string, env?: Record<string,string>, nofile?: number, logPath?: string, timeoutMs?: number, keep?: boolean, onChild?: (child: any) => void }} o
 *   onChild: called with the child process as soon as it is spawned, before the server is up (a caller that must
 *   stop it on a signal can't wait for this function to return).
 *   main: the server script (server/main.js; a test passes a stub to prove readiness comes from /health).
 *   keep: leave the server's data dir (when this function made it) and its working dir on disk after stop(); by
 *   default both are removed when the server stops, and also when it exits as an orphan (see below).
 * @returns {Promise<{ pid: number, port: number, httpUrl: string, wsUrl: string, board: string, dataDir: string, cwd: string, child: any, lines: () => object[], stop: () => Promise<void> }>}
 */
export async function startServer({ tokensPath, dataDir, env = {}, nofile = 65536, logPath, timeoutMs = 20000, keep = false, main = MAIN, onChild }) {
  const tokens = readFileSync(tokensPath, "utf8");   // first: a bad path leaves nothing behind
  const ownData = !dataDir;
  dataDir ??= mkdtempSync(join(tmpdir(), "plenary-load-data-"));
  const cwd = mkdtempSync(join(tmpdir(), "plenary-load-cwd-"));
  const scratch = keep ? [] : [cwd, ...(ownData ? [dataDir] : [])];
  const cleanup = () => { for (const d of scratch) try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } };
  const file = logPath ? createWriteStream(logPath, { mode: 0o600 }) : null;
  let lastErr;
  // The port is picked here (read back from a bound port 0), so readiness is an HTTP /health answer, not a log line.
  // A port taken in between makes the server exit at once: try again, at most twice more.
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = freePort();
    const childEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), PLENARY_DATA_DIR: dataDir, LOG_LEVEL: "info",
      PLENARY_DEV_TOKENS: tokens, ...env, PLENARY_LOAD_PARENT: String(process.pid), PLENARY_LOAD_CLEAN: JSON.stringify(scratch),
    };
    // exec: the PID we get (and sample, and stop) is the server's own.
    const child = Bun.spawn(["sh", "-c", `ulimit -n ${Math.floor(nofile)} 2>/dev/null; exec "$0" --preload "$2" "$1"`, process.execPath, main, SELF], { cwd, env: childEnv, stdout: "pipe", stderr: "pipe" });
    onChild?.(child);
    const out = { text: "", err: "" };
    const pump = async (stream, k) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        const s = dec.decode(chunk, { stream: true });
        if (out[k].length < HEAD_BYTES) out[k] += s;   // only the head: a long run logs a lot (and must still be drained)
        file?.write(s);
      }
    };
    pump(child.stdout, "text"); pump(child.stderr, "err");
    const lines = () => out.text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const httpUrl = `http://127.0.0.1:${port}`;
    const end = Date.now() + timeoutMs;
    try {
      let up = false, board = null;
      while (Date.now() < end) {
        // The server refused the tokens (server/main.js logs a fixed sentence, no token): say so now, not after the timeout.
        const all = lines(), refused = all.find(l => typeof l.msg === "string" && l.msg.startsWith("PLENARY_DEV_TOKENS "));
        if (refused) throw new Error(`the server rejected the tokens file ${tokensPath}: "${refused.msg}"`);
        board = all.find(l => l.msg === "dev tokens are ON: not for production")?.board ?? null;
        if (up && board) break;
        if (child.exitCode !== null) { const e = new Error(`server exited (${child.exitCode}) before it answered /health; stderr: ${out.err.slice(0, 300)}`); e.early = true; throw e; }
        if (!up) up = await fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(500) }).then(r => r.ok, () => false);
        if (!(up && board)) await Bun.sleep(25);
      }
      if (!up || !board) throw new Error(`server: ${up ? "no dev-tokens log line" : "/health did not answer"} within ${timeoutMs} ms`);
      return {
        pid: child.pid, port, board, dataDir, cwd, child, out, lines, httpUrl, wsUrl: `ws://127.0.0.1:${port}/ws`, cleanup,
        async stop() { await stopChild(child); file?.end(); cleanup(); },
      };
    } catch (err) {
      await stopChild(child, 0, 2000); lastErr = err;
      if (!err.early || child.signalCode || attempt === 2) break;   // stopped from outside (a signal): do not start another
    }
  }
  file?.end(); cleanup();
  throw lastErr;
}

/**
 * Sample a process with ps: its cumulative CPU time (s) and RSS (KB); null if it is gone. CPU % comes from the
 * difference of two samples (cpuPct): macOS's own `ps %cpu` is a decaying average that hides saturation.
 */
export function psSample(pid) {
  const r = Bun.spawnSync(["ps", "-o", "time=,rss=", "-p", String(pid)], { timeout: SPAWN_TIMEOUT_MS });
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

// The orphan watch (see the header): runs only when preloaded into a server this file started.
const loadParent = Number(process.env.PLENARY_LOAD_PARENT);
if (loadParent > 0 && loadParent !== process.pid && Bun.main === MAIN) {
  const watch = setInterval(() => {
    if (process.ppid === loadParent) return;
    clearInterval(watch);
    // Orphaned: the server's own dirs (the starter's list) go with it, whichever way it ends (its clean stop, or the 5 s exit).
    process.on("exit", () => { try { for (const d of JSON.parse(process.env.PLENARY_LOAD_CLEAN || "[]")) rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(1), 5000).unref?.();
  }, ORPHAN_CHECK_MS);
  watch.unref?.();
}
