# Brief: p5-slow (replay-guard cost test times out under load)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report: docs/m2/reports/p5-slow.md.
Never pkill/killall; port 0; kill only PIDs you recorded.

## Goal

`test/auth/http.test.js:486`, "replay guard: pruning visits O(1) entries per callback ...", hit bun's default 5 s
test timeout when the full suite ran under load (found by engine's scaffold round 4). It drives 2 × 5,000 callbacks.
Make it robust under load without weakening what it proves:

- Shrink the data set (e.g. 1,000 calls per phase; rescale the churn tick so expiry still starts halfway through,
  e.g. 600 s / 500 calls = 1,200 ms, and rescale the churn bounds to match), AND
- give the test an explicit timeout (third argument to `test`, e.g. 30_000) as a backstop.
- Keep it deterministic (no wall-clock assertion) and keep the mutation property: it must still FAIL against the
  old O(n) full-scan pruning (re-introduce it in a scratch copy of server/auth/http.js and show the failure; don't
  leave the mutation in the tree).

## Files you own

`test/auth/http.test.js` (this test only). Nothing else.

## Done when

Test passes; time it alone and note the ms; run it 50 times while the machine is loaded (e.g. run the full
`bun test` concurrently a few times) with 0 failures; mutation check fails as expected; full `bun test` passes.
Report what changed, timings and the mutation check. Then stop. Do not commit.
