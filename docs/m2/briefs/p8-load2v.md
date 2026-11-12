# Brief: p8-load2v (verify p8-load2, the fix round for the load client)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p8-load2v.md. Report only
to t187: never prompt, hc send or SendMessage to the proxy (t1bx), engine (t18m) or the CEO. Never print .env values
or dev tokens (print file paths only). No pkill/killall: stop only PIDs you started and recorded. Do not edit code;
do not commit. **Mutations and load runs only in a copy of the repo in your scratchpad (`git worktree add` or
`cp -R` plus the uncommitted files), never in /Users/r/repos/plenary.** Set `TMPDIR` to your scratchpad for every
run so anything you leak names your scratchpad. Leave alone processes you did not start (e.g. nats-server 19379, a
`server/main.js` or `scripts/load/run.js` from the real tree). Another worker (p8-rig3) works on
scripts/cluster-rig.js and test/deploy/*: ignore those. Ports from port 0. Stop at 60% context after writing what
you have.

## Job under check

Round 1 verifier p8-loadv FAILED p8-load (docs/m2/reports/p8-loadv.md: 3 MEDIUM, 10 LOW). Builder p8-load2 claims all
fixed plus a new `drainMs` bug (brief docs/m2/briefs/p8-load2.md, report docs/m2/reports/p8-load2.md). Files:
scripts/load/*, test/load/*, docs/m2/load/*, the correction section in docs/m2/reports/p8-load.md. Read claims as
claims. CHECKER mode: try to break it.

## Check

- **MEDIUM 1, calibration:** do the README and reports now say only what was measured (commit, runs, load average,
  "not pinned down")? Is any number stated more precisely than the runs support? Re-run one 5,000 x 105 and one
  5,000 x 125 on HEAD in your copy and say whether they agree with the report's ranges (note your load average).
- **MEDIUM 2/3:** do the new tests drive the real samplers and the real counting paths (not stubs of the code under
  test)? Re-apply V1, V4, V5, V7, V10, V11, V12, V13, M12 and N1-N11 alone; each must fail `bun test test/load`. Add
  mutations of your own on the new exit rule (finding 7) and `drainMs` merge.
- **LOWs:** each claimed fix (ramp 0, fractional counts, tokens-file error, CPU over the load phase only, exit codes
  0/1/2, headline INVALID/INCOMPLETE/VALID): try one breaking input each.
- **Secrets:** no token or .env value in stdout, stderr, result.json or the markdown output, including error paths.
- **Gates:** `bun test test/load` 3x in your copy; `bun test test/architecture.test.js` in the real tree (read-only
  run). Process list before and after: nothing of yours left.

## Done when

docs/m2/reports/p8-load2v.md: PASS or FAIL (round 2), findings table by severity with file:line and repro, mutation
results, gate output, housekeeping. Then stop.
