# Brief: p5-flake (make the replay-guard cost test deterministic)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t14q). Report: docs/m2/reports/p5-flake.md.
Never pkill/killall; port 0; kill only PIDs you recorded.

## Goal

`test/auth/http.test.js:503`, "replay guard: per-callback cost stays flat", asserts a wall-clock ratio `b/a < 3`.
It measured 4.13 and failed 2 of 132 full runs under load (found by the client track). Timing ratios on shared
machines and CI runners flake. Replace it with a deterministic check of the same property: per-callback work stays
O(1) as live login states grow, e.g. count entries the pruner visits per callback (a counter or hook exposed for
tests only, not a public API), or drive the guard with an injected clock and assert on the structure. The test must
still FAIL against the old O(n) pruning (show this: re-introduce the old loop in a scratch copy and run it).

## Files you own

`server/auth/http.js` (only if a small test hook is needed), `test/auth/http.test.js`. Nothing else.

## Done when

The test is deterministic (no wall-clock assertions), fails on the O(n) version, passes on the current one; run
`bun test test/auth/http.test.js` 50 times in a loop with 0 failures, and the full `bun test` passes. Report what
changed and the mutation check. Then stop. Do not commit.
