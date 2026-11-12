# Brief: p5-flakev (verify p5-flake: deterministic replay-guard test)

docs/m2/BRIEF-BASE.md applies. You are the verifier, never the builder. Manager: `manager platform` (t14q).
Report: docs/m2/reports/p5-flakev.md, starting with **PASS** or **FAIL**, then HIGH/MEDIUM/LOW findings.
Write nothing outside that report and your session scratchpad. Do not commit. Never pkill/killall.

## Goal and done-when (docs/m2/briefs/p5-flake.md: read it)

The replay-guard cost test (test/auth/http.test.js, formerly a wall-clock ratio that flaked 2/132) becomes
deterministic: no wall-clock assertion; it fails on the old O(n) pruning and passes on the current O(1) one. Any hook
added to server/auth/http.js for the test must not change behaviour or open anything (test-only, not reachable from
a request).

## The diff

`git diff -- server/auth/http.js test/auth/http.test.js`.

## Try to break it

- Any remaining timing assertion or sleep-based race in test/auth/http.test.js.
- Mutation: in a scratch copy, re-introduce the full-map scan on every callback; the test must fail. Also try a
  subtler O(n) (scan only every other callback); say whether it's caught.
- The hook: can a request or any production caller reach it? Does it change pruning, the cap, or replay refusal?
- Run `bun test test/auth/http.test.js` 100 times under load (run something CPU-heavy alongside, started with a
  recorded PID and stopped by it) with 0 failures; full `bun test` passes.

## sdd ensemble review (required, OFFICE.md "sdd helpers")

Load `sdd:subagent-driven-development` first. Check `usage`, then a quick review of the diff by every harness
passing `check_adapter`. List which ran.

Grade HIGH: a test that can still flake, one that passes on O(n) pruning, or a hook that changes behaviour.
Then stop and leave the session idle.
