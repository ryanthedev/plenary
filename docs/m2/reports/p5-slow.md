# Report: p5-slow (replay-guard cost test timed out under load)

**Done.** The test now runs 2 × 1,000 callbacks instead of 2 × 5,000 and has a 30 s backstop timeout. Alone it takes
110 to 143 ms (was 1,280 ms). It passed 50 of 50 runs while three full suites ran at the same time. It still fails
against the old O(n) full-scan pruning. The full `bun test` passes. Not committed.

## What changed

Only `test/auth/http.test.js`, only the test "replay guard: pruning visits O(1) entries per callback ..." (line 486).
`guardRig` and `drive` are unchanged, because the cap test shares them.

| Item | Before | After |
|---|---|---|
| Calls per phase | 5,000 | 1,000 |
| Churn tick | 240 ms (600 s after 2,500 calls) | 1,200 ms (600 s after 500 calls, so expiry still starts halfway) |
| Flat phase: length / final live | 5,000 / 4,999 | 1,000 / 999 |
| Churn phase: expired at least | 2,400 | 480 (actual: 500) |
| Churn phase: final live at most | 2,501 | 501 (actual: 499) |
| Timeout | bun default 5 s | `30_000` (third argument to `test`) |

- **Why 1,200 ms:** `LOGIN_TTL_SEC` is 600 in `server/auth/http.js:49`, and 600 s / 500 calls = 1,200 ms.
- **Comments:** updated to say 1k, 1,200 ms and ~500, and to note why it shrank (p5-slow).
- **Still deterministic:** no wall-clock assertion. The structural checks (`visited - expired ≤ 1` per prune,
  `expired ≤ calls`, `visited ≤ 2 × calls`, exactly one visit per flat prune) are unchanged.

## Tests added

None. One existing test was resized.

## How I checked it

- **Alone:** 3 runs took 143, 143 and 110 ms (bun's own figure). The 2 × 5,000 version took 1,280 ms.
- **Real churn totals:** printed in a scratch copy: 500 expired, 499 live at the end. Both sit within the bounds.
- **Under load:** I started three background loops of the full `bun test`, waited 3 s, then ran the target test
  50 times. The background loops started before run 1 and finished after run 50, so the load covered the whole
  window. Result: **0 failures**, times 119 to 380 ms. All three loaded full suites, which include the edited
  test, also exited 0. That is the closest match to how the timeout was first found. Background PIDs 65731, 65732 and 65734 were waited on, and
  none was left running.
- **Full suite (after the load stopped):** 328 pass, 70 skip, 0 fail, 398 tests across 24 files, 35.8 s.

## Mutation check

Done in a scratch copy (`server/`, `test/`, `packages/`, `package.json`, with `node_modules` symlinked) outside the
tree. `git diff -- server/` is empty afterwards.

- **Provenance:** the first committed `useState` (4fad32a) already pops from the front, so there is no committed
  O(n) loop to restore. The loop below is a reconstruction that matches p5-flakev's mutation A, with the counters kept.
- **Mutation:** a full scan on every callback, with the hook still counting:
  `for (const [s, exp] of usedStates) { visited++; if (exp <= t) { usedStates.delete(s); expired++; } }`.
- **Result: fails**, on the flat-phase exact-count check (`http.test.js:507`,
  `flat.slice(1).every(p => p.visited === 1 && p.expired === 0)`: `Expected: true, Received: false`).
- **With that line removed it still fails**, on the generic bound (`http.test.js:498`,
  `visited - expired ≤ 1`: `Received: 2`).

- **Mutation D (full scan every 1,000th callback, front-pop otherwise):** this is the edge case at the new size,
  because with exactly 1,000 calls per phase the scan fires only once (at call 1,000). It **fails** on the exact-count
  check (`Received: false`). With that line removed (mutation F) it **still fails** on the generic bound
  (`Received: 999`).

## Not verified

- **Mutation B (full scan every other callback):** not re-run at the new size. It fires 500 times per phase, so it
  is caught more easily than D.
- **Known gap unchanged:** an extra *uncounted* scan (p5-flakev mutation C) still passes. That is the existing LOW 1,
  not something this change introduced.
- **Other machines and CI:** only measured on this Mac (Bun 1.4.4).

## Risks

- Low. A 5× smaller data set proves the same per-callback property. The exact-count check fails on any extra visit,
  whatever the size.
