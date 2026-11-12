# Brief: p5-load4v (verify Round 4 of p5-load: re-cut patch, V1/V2, PROTOCOL hunk)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine (t18m). Never print .env values or tokens. No pkill/killall. Containers you
start are recorded (Podman id) and only those removed. Do not edit code; do not commit. Work in a clean HEAD worktree
in your scratchpad (link the main tree's node_modules). Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`.
Stop at 60% context after writing what you have.

## Job under check

Builder t1hc ran p5-load4 (brief docs/m2/briefs/p5-load4.md; "Round 4" at the end of docs/m2/reports/p5-load.md).
Previous round verified PASS: docs/m2/reports/p5-load3v.md. The patch is docs/m2/reports/p5-load.patch (uncommitted;
the committed version at HEAD is the Round 3 patch). Read the builder's claims as claims.

## Check (this round is small; keep it so)

- **Only intended changes:** compare HEAD's p5-load.patch with the new one (`git diff HEAD -- docs/m2/reports/p5-load.patch`
  and the +/- lines of each). The only behavioural differences may be: re-cut context for the two registry-test
  `batch: true` hunks, V1/V2 in test/server/role-cache.test.js, the PROTOCOL.md hunk. Anything else is a finding.
- **Applies:** `git apply --check` on a clean HEAD worktree and on the main tree.
- **V1/V2:** match docs/m2/reports/p5-load3v.adv.test.js.txt in substance; each fails under its mutation (drop
  `auth.invalidate?.(b.board)` in the chunk catch; drop `chunkErr = null`).
- **PROTOCOL hunk:** sentence verbatim from LOW B in p5-load.md, placed under re-check timing, accurate to the code.
- **Gates:** full `bun test` on the patched worktree with and without DATABASE_URL (Podman Postgres).

## Done when

docs/m2/reports/p5-load4v.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs (minus
secrets). Then stop.
