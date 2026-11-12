# Brief: p8-loadv (verify p8-load, the load client)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-loadv.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not edit code; do
not commit. **Mutations only in a copy of the repo in your scratchpad (`git worktree add` or `cp -R`), never in
/Users/r/repos/plenary** (an earlier job's mutation runs in the shared tree broke another session's tests and left an
orphan nats-server, PID 62656: not yours, leave it). Ports from port 0. Stop at 60% context after writing what you have.

## Job under check

Builder p8-load (brief docs/m2/briefs/p8-load.md, report docs/m2/reports/p8-load.md). Files: scripts/load/*,
test/load/*, docs/m2/load/2026-11-12-calibration/, plus the manager's lines in test/architecture.test.js
(COMPOSITION_ROOTS gains the 6 scripts/load files). Read the builder's claims as claims. CHECKER mode: try to break it.

## Check

- **Replica as consumer only:** nothing under packages/, server/, PROTOCOL.md or test/server/ changed by this job;
  scripts/load imports only packages/protocol and packages/core public modules plus its own files.
- **Secrets:** tokens never in stdout/stderr of run.js/tokens.js/worker.js, in result.json or report.md; token files
  are 0600; a failing run (bad URL, bad token file) does not echo token values in its error.
- **Stats:** percentiles correct on fixed inputs (empty, one value, ties, p99 of 100 values); `--procs n` merge uses
  raw samples or mergeable histograms, not averaged percentiles.
- **Counting:** 1013, other close codes, errors and reconnects counted once each; a client that never gets welcome
  is visible in the result, not dropped.
- **Validity:** generator saturation (event-loop lag/CPU) marks the run invalid; check the threshold is real.
- **Open-file limit:** the up-front check gives a clear message when the requested clients exceed the limit.
- **Calibration claims:** re-run a smaller version (e.g. 1,000 clients) of one calibration run and compare it with
  docs/m2/load/2026-11-12-calibration/; say whether the 75-writer vs 105-writer knee is plausible from the data.
- **--rig:** field names read from rig.json match scripts/cluster-rig.js (read its code; a live rig is optional).
- **Mutations:** redo the builder's mutations in your copy, including M12 (the builder says it is not caught: judge
  whether the `unacked == 0` assertion really covers it), and add your own; each must fail a test.
- **Gates:** `bun test test/load` 3x in your copy; full `bun test` once in the real tree (no mutations there); name
  each failure and whether it is this job's (test/core-source.test.js is a known unrelated failure).

## Done when

docs/m2/reports/p8-loadv.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs (minus
secrets). Then stop.
