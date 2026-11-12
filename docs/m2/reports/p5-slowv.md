# Report: p5-slowv (verify p5-slow)

**PASS.** No HIGH or MEDIUM findings. Two LOW findings. The resized test (2 × 1,000 callbacks, 1,200 ms churn tick,
30 s backstop) still fails on every O(n) pruning variant the brief asked for. It passed 150 of 150 runs under load,
and every full `bun test` I ran passed. I changed nothing in the tree.

## What I checked

- **Diff:** only `test/auth/http.test.js`, only the test at line 486. There are 12 insertions and 11 deletions.
  `git diff -- server/ packages/` is empty.
- **Churn bounds, by hand:** `LOGIN_TTL_SEC` is 600 (`server/auth/http.js:49`). An entry inserted at call i expires
  at (i + 500) × 1,200 ms. Pruning deletes it when `exp <= t`, before the new state is inserted. So call j deletes
  entry j − 500, and calls 501 to 1,000 each expire exactly one entry.
  - That gives 500 expired in total, against a bound of at least 480.
  - The last prune sees entries 501 to 999 live, which is 499, against a bound of at most 501.
  - Both bounds are consistent and leave a small margin. With no pruning the map would hold 999, so the live
    bound still catches pruning that stops working.
  - This matches the builder's printed totals (500 expired, 499 live).
- **Determinism:** there is no wall-clock assertion. The only change to timing is the `30_000` backstop.

## Mutation check

All mutations were run in a scratch copy outside the tree (`server/`, `test/`, `packages/`, `package.json`, with
`node_modules` symlinked). Afterwards the copy's `server/auth/http.js` was restored and `cmp` matched the tree.

| Mutation (to `useState`'s prune loop) | Result | Where it fails |
|---|---|---|
| A: full scan on every callback | **fails** | `:507` (flat exact count) |
| B: full scan every 2nd callback | **fails** | `:507` |
| Full scan every 3rd, 7th, 10th, 100th, 250th, 500th, 999th callback | **fails** | `:507` |
| D: full scan every 1,000th callback (counter in the closure) | **fails** | `:507` |
| Full scan every 1,500th or 2,000th (counter global across both rigs) | **fails** | `:498` (`visited - expired ≤ 1`, got 499) |
| No pruning at all | **fails** | `:507` |
| Front-pop that never deletes an expired entry | **fails** | `:512` (expired ≥ 480, got 0) |
| Full scan every 1,001st callback (counter in the closure) | passes | see LOW 2 |
| Full scan only once the map holds ≥ 1,000 live entries | passes | see LOW 2 |
| Front-pop plus an extra scan that isn't counted | passes | LOW 1, an existing gap |

- **The full scan on every 2nd callback is now covered.** The builder listed it as not re-run; it fails.

## Under load

- **Method:** a bash script (`load2.sh`, in my scratchpad) started three background loops, each running the full
  `bun test` twice. It waited 3 s, then ran the target test 50 times.
  - All three loops were alive before run 1 and after run 50.
  - The machine's load average was about 95 to 105 throughout. Other sessions were also running on it.
- **Result:** 0 of 50 target runs failed. Times ranged from 101 to 255 ms.
  - All six loaded full suites passed: 328 pass, 70 skip, 0 fail each, in 38 to 42 s.
- **Earlier batches:** two earlier batches of 50 runs also had 0 failures, at 99 to 633 ms. Those were also under
  load, because background suites were running. Total: 150 of 150 passed.
- **Six suites at once:** all passed.
- **Alone:** 457 to 513 ms on this busy machine. Earlier, on a quieter machine, it took 99 to 143 ms. Either way it
  sits far below the old 5 s default.
- **Full `bun test` with nothing else of mine running:** 328 pass, 70 skip, 0 fail, 398 tests, 37.7 s, exit 0.

## Findings

- **LOW 1 (existing, unchanged):** an extra scan that isn't counted still passes. This is p5-flakev's mutation C.
  The test can only see what the `pruned` hook counts.
- **LOW 2 (new, small):** shrinking the data set narrows what the test can catch. Two kinds of mutation now pass:
  - a periodic full scan whose period is longer than one phase (more than 1,000 callbacks);
  - a scan that switches on only above 999 live entries.

  At the old size (5,000) these thresholds would have had to exceed 5,000 to slip through. Every finite test has
  this blind spot, so it is a matter of degree, not a new gap. Both mutations are contrived. No action is needed
  unless someone wants a cheap backstop, such as a cap test with a smaller `maxLoginStates`. I don't recommend one.

## Process note (no effect on the result)

- **What went wrong:** in my first load attempt the script's "alive" check was broken (zsh does not word-split
  `$P`). It reported the background loops dead while they were running. My second attempt started a further three
  loops. All six wrote to the same log file names, and a cleanup step deleted logs that were still open.
- **A lost failure:** one of those overlapping full suites exited 1, and its log is gone. I could not reproduce it:
  the clean three-loop run (six suites) and a six-at-once run (six suites) all passed.
  - **Not verified:** whether that exit was a real test failure or a side effect of the clobbered logs.
- **Cleanup:** I killed only PIDs I had recorded: the loop shells 15126, 15127, 15130, 19785, 19787 and 19790, and
  their `bun test` children 22735, 22873, 22884, 26708, 26846 and 26918. The final runs' PIDs were all waited on.
- **Not mine:** other `bun test` processes still on the machine (65432, 67972) belong to other sessions. I left
  them alone.

## Not verified

- **Other machines and CI:** I measured only on this Mac (Bun 1.4.4).
- **sdd ensemble review:** skipped, as the brief said.
