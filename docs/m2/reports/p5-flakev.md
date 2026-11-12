# Report: p5-flakev (verify p5-flake: deterministic replay-guard test)

**PASS.** The replay-guard cost test has no wall-clock assertion. It fails on full-scan pruning, on a full scan every
other callback, and on a full scan every 1,000th callback. It also fails when the old uncounted loop is restored with the hook call left in place.
It passed 100 of 100 runs with every core pegged. The
`testHooks` hook has no production caller and does not change pruning, the cap or replay refusal. No HIGH or
MEDIUM findings. There are two LOW findings, below.

Scope checked: `git diff -- server/auth/http.js test/auth/http.test.js` (as in the working tree on 2026-11-11).
Mutations ran in scratch copies only. The real files were not edited.

## Findings

**HIGH:** none.

**MEDIUM:** none.

**LOW 1: the test only sees the visits the counter sees** (`server/auth/http.js:135`).
- **What:** I added a second, uncounted full scan after the counted loop
  (`for (const [s, exp] of usedStates) { if (exp <= t) usedStates.delete(s); }`). The test passes (21/21).
- **Why LOW and not HIGH:** the brief grades "a test that passes on O(n) pruning" as HIGH. Only one kind of O(n) pass
  gets through: one that deliberately bypasses the counted loop. The natural regression is caught. Restoring the old
  loop (`if (exp <= t) delete`, no counters) with the hook call left in place **fails** (mutation E below).
- **The trade:** this is the trade p5-flake chose and reported ("what I did not verify"). A deterministic visit
  count can only measure the instrumented loop. It is not a regression from the old test. To catch an O(n) pass
  that skips the counter, a reviewer has to read `useState`. A code comment on the counted loop saying "all pruning
  goes through here, counted" would make that harder to miss. This is optional.

**LOW 2: a throwing hook changes the response** (`server/auth/http.js:136`; raised by codex, confirmed by reading).
- **What:** `testHooks.pruned` runs inside `useState`, before the replay check. If the hook throws, the exception
  reaches the route catch (`server/auth/http.js:294`) and the catch-all at `server/auth/http.js:302` returns 503 `unavailable`
  instead of the normal 400 replay refusal.
- **Why it is LOW:** only a test can supply the hook. No caller in `server/` constructs `httpRoutes` at all. The
  only caller is `test/auth/http.test.js:34` (`build`), and the only `testHooks` use is the new test. Its hook is
  `p => seen.push(p)`, which cannot throw. Wrapping the call in `try {} catch {}` would remove this edge case. This
  is optional.

## Try to break it: results

| Check | Result |
|---|---|
| **Timing or sleep left in `test/auth/http.test.js`** | None. There is no `performance`, `setTimeout`, sleep or `Date.now` in the file (grep). The test's time comes only from the injected `clock.t`. |
| **Mutation A: full scan on every callback** (`if (exp <= t) delete`, no `break`) | **Fails** (`Expected: true, Received: false`, from the "every prune visits exactly one" check). With that exact-count line removed, it **still fails** on the generic `visited - expired ≤ 1` bound (`Received: 2`). |
| **Mutation B: full scan every other callback, front-pop otherwise** | **Fails** in the same way. With the exact-count line removed, it **still fails** on the generic bound (`Received: 3`). |
| **Mutation D: full scan every 1,000th callback** | **Fails** (exact-count check). With that line removed (mutation F), it **still fails** on the generic bound (`Received: 970`). |
| **Mutation E: the old loop restored without counters, hook call kept** | **Fails** (`Expected: true, Received: false`). `visited` stays 0, so the exact-count check fails, and the churn half's `expired ≥ 2,400` check would fail too. |
| **Mutation C: uncounted extra full scan** | **Passes.** See LOW 1. |
| **Hook reachable from a request?** | No. `testHooks` is a constructor dep defaulting to `null`. No request data reaches it, and no `server/` file calls `httpRoutes` (`grep -rn httpRoutes server/` finds only its definition). |
| **Hook changes behaviour?** | No, provided it does not throw (see LOW 2). The counters only observe the loop, whose `break`/`delete` logic is unchanged. The hook runs after the prune, and `has`, the cap check and `set` are untouched. The cap-and-replay test (`a hard cap fails closed…`) still passes. |
| **Implicit timeout** | The new test has no explicit timeout, so bun's default per-test limit (5 s, with no `bunfig.toml` override) applies. Under the same 12-process load, a run of the whole file filtered to this one test took 1.03–1.47 s, including bun startup (5 runs). The test alone takes about 0.15–0.26 s unloaded. So the margin is at least 3.4x. **I did not measure the test's own time under load.** If CI runners are much slower than this machine, an explicit timeout (for example 30 s) would rule this out. Flagged here, not graded. |
| **100 runs under load** | **100 pass, 0 fail.** I ran 12 `yes > /dev/null` processes (one per core; PIDs 99026–99035, 99037 and 99038 recorded) alongside the loop. The load average reached 72. I stopped those processes by their recorded PIDs afterwards and confirmed they had exited. |
| **Full `bun test`** | **325 pass, 70 skip, 0 fail** (395 tests, 24 files). The 70 skips are the env-gated Postgres, NATS and S3 suites, as p5-flake reported. |

## sdd ensemble review

- **Quota:** `usage` showed codex on the plus plan at 5% (5 h window) and 7% (weekly).
- **`check_adapter`:** codex **ok**, grok **ok**. agy **failed** (quota exhausted, resets in about 67 h). kimi
  **failed** (no model configured). mistral **failed** (no `MISTRAL_API_KEY`). qwen is **missing** (not on PATH).
- **Ran:** codex (effort high) and grok, both against a scratch copy of the repo so they could not write to the
  real tree.

| Harness | Verdict | Findings |
|---|---|---|
| codex | One LOW. The assertions are deterministic and catch both an every-callback and an every-other-callback full scan. | LOW: a throwing hook changes the response. **Confirmed** (LOW 2). |
| grok | Clean, no findings. | It said no O(n) variant gets past the assertions. **Refuted for the uncounted-scan case** by mutation C (LOW 1). Its pointer to `server/main.js:88` as a production path that "never supplies" the hook is correct in effect: that line builds `createServer` without `httpRoutes` at all. |

No finding was raised by two harnesses, so there is no HIGH candidate.

## Not verified

- **Real wall-clock cost of pruning:** the new test does not measure time, by design. A cost that is not a map
  visit (LOW 1, or a slow `Map.delete`) would not show up.
- **Skipped suites:** I did not run the Postgres, NATS or S3 suites, because they need live services. The diff
  does not touch them.

Scratch copies, mutation sources and the loop log are in
`/private/tmp/claude-501/-Users-r-repos-plenary/22cdf827-da94-44b4-88a4-a72cdb1e0277/scratchpad/`.
Nothing is committed.

**Cleanup:** all 24 load processes I started (PIDs 99026–99035, 99037, 99038 and 28249–28259, 28261) were killed by their recorded PIDs, and `ps`/`pgrep` show none left.
