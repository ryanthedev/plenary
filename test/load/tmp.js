// Scratch space for the load tests. Importing this file points TMPDIR at one fresh directory for the whole test
// process, so everything the tests start (spawned CLIs get it through childEnv(), in-process run()/startServer()
// through os.tmpdir()) makes its temp dirs there. Test dirs come from tmp() and are removed by cleanTmp() in each
// file's afterAll. cleanTmp also FAILS the file when anything else is left in the scratch dir (a "stray": a temp
// dir the code under test made and did not remove), so `bun test test/load` leaves nothing behind, and says if not.
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

// One scratch dir for the whole process, even if each test file gets its own copy of this module.
export const SCRATCH = process.env.PLENARY_TEST_SCRATCH || mkdtempSync(join(process.env.TMPDIR || tmpdir(), "plenary-load-test-"));
process.env.PLENARY_TEST_SCRATCH = SCRATCH;
process.env.TMPDIR = SCRATCH;
/** Make sure the scratch dir exists and TMPDIR names it (each file's cleanTmp removes the whole dir; the next file's beforeAll(useScratch) makes it again). */
export const useScratch = () => { mkdirSync(SCRATCH, { recursive: true }); process.env.TMPDIR = SCRATCH; };

const made = new Set();
export const tmp = prefix => { useScratch(); const d = mkdtempSync(join(SCRATCH, prefix)); made.add(basename(d)); return d; };
/** The environment for a spawned CLI: PATH, HOME, and the scratch dir as TMPDIR. */
export const childEnv = (extra = {}) => useScratch() ?? ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: SCRATCH, ...extra });
/** What is in the scratch dir that tmp() did not make. */
export const strays = () => (useScratch(), readdirSync(SCRATCH)).filter(n => !made.has(n));
export function cleanTmp() {
  const left = strays();
  rmSync(SCRATCH, { recursive: true, force: true });   // the dir too: after the last file nothing is left
  made.clear();
  if (left.length) throw new Error(`temp dirs left behind by the code under test: ${left.join(", ")}`);
}

/**
 * Independent slow scenarios (each its own server and processes) run at once instead of one after another: register
 * them as fns[name] = fn at module level, then each test awaits its own with get(name). The first get starts all of
 * them and waits for all, so by the time any test runs, every scenario is done (and a test that measures this
 * process's own event loop, registered after, runs alone).
 */
export function scenarioGroup() {
  const fns = {};
  let started = null;
  return {
    fns,
    async get(name) {
      started ??= Promise.all(Object.entries(fns).map(async ([k, fn]) => [k, await fn().then(v => ({ v }), error => ({ error }))])).then(Object.fromEntries);
      const got = (await started)[name];
      if (got.error) throw got.error;
      return got.v;
    },
  };
}
