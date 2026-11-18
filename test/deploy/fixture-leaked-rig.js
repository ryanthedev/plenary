// Fixture for cluster-rig.test.js's cleanupAll tests; skipped unless that test runs it. It leaves a services-only rig UP
// (and a decoy: a live `sleep` recorded in that rig.json with the wrong start time), ends, and lets its afterAll
// cleanupAll() deal with them. RIG_FIXTURE_PS, when set, is a fake ps for the cleanup's one snapshot call.
import { test, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rigUp, track, cleanupAll, CLEANUP_TIMEOUT_MS, _setSnapshotPs, lstart } from "./rig-guard.js";

const DIR = process.env.RIG_FIXTURE_DIR, OUT = process.env.RIG_FIXTURE_OUT;
afterAll(() => { if (process.env.RIG_FIXTURE_PS) _setSnapshotPs(process.env.RIG_FIXTURE_PS); return cleanupAll(); }, CLEANUP_TIMEOUT_MS);

test.skipIf(!DIR || !OUT)("fixture: a services-only rig left up, plus a decoy with the wrong start time", async () => {
  track(DIR);
  const rig = await rigUp({ dir: DIR, servicesOnly: true, timeoutMs: 60_000 });
  const decoy = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  decoy.unref();
  const file = join(DIR, "rig.json"), j = JSON.parse(readFileSync(file, "utf8"));
  j.procs.push({ name: "decoy", pid: decoy.pid, started: "Mon Jan 1 00:00:00 2001", log: "/dev/null" });
  writeFileSync(file, JSON.stringify(j));
  writeFileSync(OUT, JSON.stringify({ real: rig.procs.map(p => ({ name: p.name, pid: p.pid })), decoy: { pid: decoy.pid, started: lstart(decoy.pid) } }));
}, 120_000);
