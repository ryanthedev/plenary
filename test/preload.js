// Loaded once per `bun test` process, before any test file (bunfig.toml `[test] preload`). Hooks registered here run
// around EVERY test of EVERY file; a hook registered at a module's top level runs only for the first test file that
// imports the module (bun evaluates a module once per process), which is how the old per-module safety nets missed
// every file but the first (e1-tests-v HIGH-1).
//
// - Safety nets: after each test, every child started through test/server/helpers.js `spawnTracked` is SIGKILLed and
//   reaped, and every test/server/rig.js rig still running is stopped, pass or fail.
// - Temp dirs: one root per run, `<system temp>/plen-run-<pid>-XXXX`. TMPDIR points at it, so `os.tmpdir()` in tests
//   and in the processes they spawn lands there; it is removed after the last test. A run that is SIGKILLed can't
//   remove its own, so each run first removes the roots of runs whose process is gone.
import { afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleRoots } from "./temp-root.js";

/** Shared with helpers.js and rig.js through globalThis: they need no import of this file, and fail loudly without it. */
const nets = globalThis.__plenaryTestNets = { children: new Set(), rigs: new Set() };

afterEach(async () => {
  const kids = [...nets.children];
  for (const c of kids) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  await Promise.all([...kids.map(c => c.exited.catch(() => {})), ...[...nets.rigs].map(r => r.stop().catch(() => {}))]);
}, 30_000);

const base = tmpdir();
sweepStaleRoots(base);
const root = mkdtempSync(join(base, `plen-run-${process.pid}-`));
process.env.TMPDIR = root;
globalThis.__plenaryTestRoot = root;
// A preload's afterAll runs once, after every file (bun test emits no process "exit" or "beforeExit" event).
afterAll(() => rmSync(root, { recursive: true, force: true }));
