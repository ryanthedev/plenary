# Brief: p8-rig3 (fix round 3 for the local cluster rig after verifier p8-rig2v FAIL)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-rig3.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values,
rig keys or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not
commit. **Mutations and rig runs only in a copy of the repo in your scratchpad, never in /Users/r/repos/plenary.**
Leave nats-server PIDs 53168 and 62656 alone. Another worker (p8-load2) works on scripts/load/* and test/load/*: do
not touch them. Ports from port 0. Stop at 60% context after writing what you have.

## Context

Read docs/m2/reports/p8-rig2v.md in full first (and docs/m2/reports/p8-rig2.md for what round 2 changed). Your files:
scripts/cluster-rig.js, test/deploy/*, deploy/cluster/RIG.md. Nothing else.

## Fix

- **H2 (HIGH), `ps` failure fails open** (scripts/cluster-rig.js ~73-81). Run ps by absolute path (`/bin/ps`);
  distinguish "ps did not run" (`r.error`, `r.status === null`, or non-zero with stderr/unexpected output) from "PID
  absent"; on the former, `up`/`down`/`kill`/`status` and the old-format refusal refuse with a clear error instead of
  guessing. Also: a process started but not yet given `started` (~157-159) must still be stopped by `down` and by the
  failed `up`'s cleanup (record lstart as soon as the PID exists, or stop by recorded PID + command line). **Test:**
  `up` normally, then `status` and a second `up` with PATH lacking ps (and, if cheap, a stubbed ps that fails):
  refusal, rig.json and `pg/` untouched, nothing leaked.
- **M3, second `up` during the first `up`'s initdb window.** Make `up` take an exclusive lock on the rig dir (e.g. an
  `O_EXCL` lock file holding the pid + lstart, stale-checked through the same identity check) before any rmSync.
  Test: two concurrent `up`s on one dir; exactly one proceeds, the other refuses, the dir is not wiped.
- **L6:** after a rig dir is moved, paths in rig.json (`tokensFile`, `keysFile`, `logsDir`) resolve relative to the
  dir given (store them relative, or refuse a moved rig). Test it.
- **L7:** the e2e test's `test.skip` reason is stale and the verifier says it passes un-skipped. Run it 3x in your
  copy; if it is green every time, un-skip it; otherwise keep the skip with an accurate reason and say why.
- **Leaks (added by t187 from the proxy, 2026-11-12):** no leaked services after a failed or killed run. Orphaned
  nats-servers (PPID 1) from deleted plenary-rig-* temp dirs were found and stopped by t187. A failed `up`, a killed
  `up` (SIGTERM/SIGINT midway) and a failed or killed test must leave no nats-server, postgres or node behind: make
  test teardown robust (afterAll/finally stops by recorded PID even when the test throws or times out) and have `up`
  stop what it started on a signal. **Test:** kill an `up` midway and kill a test run midway; assert no process
  tied to the rig dir remains.
- **L8:** fix the refusal message grammar and make its advice locale-independent (e.g. suggest
  `LC_ALL=C TZ=UTC ps -o lstart= -p N`).

## Gates

- The verifier's H2 repro and each new guard, re-applied as a mutation alone in your copy, fails a test; list them.
- `bun test test/deploy` 3x in your copy, all green.
- `bun test test/architecture.test.js` in the real tree (read-only run).
- Process list before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-rig3.md lists each finding with the change, the guarding test, mutation results and gate output.
Then stop.
