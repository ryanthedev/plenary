# Brief: p5-slowv (verify p5-slow)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-slowv.md (PASS or FAIL,
HIGH/MEDIUM/LOW). Never pkill/killall; kill only PIDs you recorded. Change nothing in the tree.

## Job under check

Goal: `test/auth/http.test.js` test "replay guard: pruning visits O(1) entries per callback ..." timed out at bun's
default 5 s under a loaded full suite. Make it robust under load without weakening what it proves (per-callback
pruning work is O(1) as live login states grow; deterministic, no wall clock). Diff: `git diff test/auth/http.test.js`.

Builder's not-verified list and risks (not its claims): mutation "full scan every other callback" not re-run at the
new size; an uncounted extra scan still passes (old LOW); only measured on this Mac.

## Try to break it

- Does the shrunk test still fail on O(n) pruning variants (in a scratch copy outside the tree, never in server/)?
  Try at least: full scan every callback, every other callback, every Nth callback near the new size.
- Are the churn bounds (≥ 480 expired, ≤ 501 live) consistent with LOGIN_TTL_SEC and the 1,200 ms tick?
- Run it under load (concurrent full `bun test` loops) many times; full `bun test` passes.
- Skip the sdd ensemble (one-file, ~20-line test change). Then stop.
