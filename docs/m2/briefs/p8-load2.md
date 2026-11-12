# Brief: p8-load2 (fix round for p8-load after verifier FAIL)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load2.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not commit.
**Mutation and load runs only in a copy of the repo in your scratchpad (`git worktree add` or `cp -R`), never in
/Users/r/repos/plenary.** Leave nats-server PIDs 53168 and 62656 alone. Ports from port 0. Another worker (p8-rig2)
edits scripts/cluster-rig.js and test/deploy/* at the same time: do not touch them. Stop at 60% context after
writing what you have.

## Context

p8-load (builder report docs/m2/reports/p8-load.md) built the load client. Verifier p8-loadv FAILED it with 3
MEDIUM and 10 LOW findings, no HIGH: read docs/m2/reports/p8-loadv.md in full first. Your files: scripts/load/*,
test/load/*, docs/m2/load/*, and a correction section appended to docs/m2/reports/p8-load.md.

## Fix

- **MEDIUM 1, calibration knee not reproduced.** Correct docs/m2/load/2026-11-12-calibration/README.md and the
  p8-load report: drop "75 writers sustained, 105 collapses". State what is measured: on the current server (say
  the commit), 5,000 clients with 105 writers stayed under 1 s viewer p99 in the verifier's 3 runs; two earlier
  runs on a mid-edit server degraded, cause unknown. Mark the engine "suspects" as resting on those two runs. Do one
  fresh 5,000 x 105 run on HEAD in your copy and add it (note the machine's load average). If you can push to find
  a real knee (more writers, e.g. 150 and 200) in under ~20 min of runs, do; otherwise say it is not found yet.
- **MEDIUM 2, saturation detection untested end to end.** A test that drives the real lag and CPU samplers in
  worker.js (e.g. block the event loop / burn CPU in a worker) and sees the run flagged invalid. The verifier's V11
  and V12 mutations must fail it.
- **MEDIUM 3, counted-once untested for reconnects, rejoins, resent ops.** Tests against a fake server that forces
  a reconnect, a rejoin and a resend; mutations V1, V4 and V13 must fail.
- **LOW, fix if cheap (most are):** 4 (deterministic test: fake server sends the entry and holds the ack; M12 and
  V10 must fail), 5 (catch-up vs live, V5), 6 (fdCheck test, V7; fix the "hard limit" wording), 7 (a run where
  nobody or not everybody joined must not headline VALID and must exit non-zero; pick and document the rule),
  8 (CPU mean over the load phase only), 9 (reject `--ramp 0`), 10 (reject fractional counts), 13 (clear error
  when the server rejects the tokens file). Leave 11 and 12 as documented limits if not fixed.

## Gates

- Every mutation named above, applied alone in your copy, fails `bun test test/load`; list them with results.
- `bun test test/load` 3x in your copy, all green.
- `bun test test/architecture.test.js` in the real tree (read-only run); if you add a file under scripts/load/,
  tell t187 so the manager adds it to COMPOSITION_ROOTS (you do not edit that file).

## Done when

docs/m2/reports/p8-load2.md lists each finding with the change, the guarding test, mutation results, the new run,
and gate output. Then stop.
