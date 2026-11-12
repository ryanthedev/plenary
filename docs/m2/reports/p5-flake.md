# Report: p5-flake (replay-guard cost test made deterministic)

**Done.** The wall-clock ratio test is gone. The new test counts the map entries each prune visits, through a
tests-only hook, and asserts O(1) per callback. It fails against the old full scan and passed 50 of 50 runs.

## What changed

| File | Change |
|---|---|
| `server/auth/http.js` | New optional dep `testHooks` (default `null`; in the header comment and the JSDoc `@param`, marked tests only, not an API). `useState` counts `visited` and `expired` in its prune loop and calls `testHooks?.pruned?.({ visited, expired, live })`. Pruning behaviour is unchanged. |
| `test/auth/http.test.js` | Replaced "replay guard: per-callback cost stays flat…" (the `b/a < 3` timing ratio) and its `msPerCall` helper with "replay guard: pruning visits O(1) entries per callback as live states grow, with and without expiry churn", plus a small `drive` helper. |

## What the new test asserts

- **Per callback:** `visited - expired ≤ 1`. The prune may visit only the expired entries it deletes plus the one
  live entry where it stops.
- **Amortised:** total visited ≤ 2 × callbacks, and total expired ≤ callbacks.
- **No churn (5,000 callbacks, clock still):** live reaches 4,999, and every prune after the first visits exactly
  one entry and expires none.
- **Churn (5,000 callbacks, clock +240 ms each):** at least 2,400 entries expire, and live holds at ≤ 2,501.
- **No wall clock:** time comes only from the test's injected `clock`. The test takes about 0.3 s (the old one had a 60 s
  timeout).

## Mutation check (the old O(n) pruner)

- **Setup:** I copied the repo, without `.git`, to
  `/private/tmp/claude-501/-Users-r-repos-plenary/4a34b25c-0e8b-4b2f-b2d0-60498853162f/scratchpad/mut1`, and
  replaced the prune loop there with the old full scan:
  `for (const [s, exp] of usedStates) { visited++; if (exp <= t) { usedStates.delete(s); expired++; } }`
- **Result:** the new test FAILS (`Expected: true, Received: false` on the "every prune visits exactly one" check).
  The other 20 tests pass. The real file was never mutated.
- **The core property also kills it:** to check that the test does not hinge on that one exact-count line, I
  commented it out in the scratch copy and reran. The `visited - expired ≤ 1` bound in `check(flat)` fails
  (`Expected: <= 1, Received: 2`). With `check(flat)` also commented out, the churn half fails on its own at the
  same bound. So each half, and the generic check, independently rejects the full scan.
- **Caveat:** the old loop is not in git history (p5-http shipped the fix in its first commit). I rebuilt it from
  p5-httpv MEDIUM 1, which says it "walks the whole `usedStates` map to prune it on each callback".

## How I checked it

- `bun test test/auth/http.test.js` 50 times in a row: **0 failures out of 50**.
- Full `bun test`: **322 pass, 70 skip, 0 fail** (392 tests across 24 files).
- **All 70 skips are env-gated service suites:** running only `nats-bus`, `pg-store`, `pg-registry` and
  `s3-blobs` gives exactly 70 skips. They gate on a service URL or binary (`skipIf(!url)` or `URL ? test : test.skip`),
  not on anything this change touches.
- After the last edit (JSDoc), `bun test test/auth/http.test.js` passes again (21 tests). The 50-run loop and full
  suite ran on the same code minus that comment-only edit.

## What I did not verify

- **Real wall-clock cost:** the test now proves the algorithm visits O(1) entries per callback. It no longer
  measures time, so a slowdown that does not come from map visits (for example, a slow `Map.delete`) would not
  show up. That is the intended trade for determinism.
- **Skipped suites:** I did not run the Postgres, NATS or S3 suites, because they need live services. This change
  does not touch them.

## Risks

- **Hook removed or renamed:** if `testHooks` were removed, `seen` would stay empty, and the test would then
  fail on `flat.length === 5000`. A silent no-op is therefore not possible.
- **New dep name:** the dep is named `testHooks` and documented as not an API. Production callers never pass it,
  and its cost is one optional call per callback.

Not committed (brief: the manager commits).
