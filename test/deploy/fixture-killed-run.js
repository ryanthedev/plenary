// Fixture for cluster-rig.test.js's "a test run killed midway" test; skipped unless that test runs it. It starts one rig
// in-process and one through the CLI, both stuck waiting on nodes that never answer, and then hangs until killed.
import { test, afterAll } from "bun:test";
import { join } from "node:path";
import { rigUp, track, spawnTracked, cleanupAll, CLEANUP_TIMEOUT_MS } from "./rig-guard.js";

const A = process.env.RIG_FIXTURE_DIR_A, B = process.env.RIG_FIXTURE_DIR_B;
afterAll(() => cleanupAll(), CLEANUP_TIMEOUT_MS);

test.skipIf(!A || !B)("fixture: two rigs mid-up, then hang until killed", async () => {
  track(A); track(B);
  const cli = spawnTracked([process.execPath, join(import.meta.dir, "../../scripts/cluster-rig.js"), "up", "--dir", B, "--timeout-ms", "300000", "--node-cmd", "sleep 300"],
    { stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  await rigUp({ dir: A, nodeCmd: ["sleep", "300"], timeoutMs: 300_000 }).catch(() => {});
  await cli.exited;
}, 600_000);
