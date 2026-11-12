# Brief: p5-load3v (verify Round 3 of p5-load: the gateway patch re-cut onto a90cd6b, LOWs A-D)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine (t18m). Never print .env values or tokens. No pkill/killall. Containers you
start are recorded (Podman id) and only those removed. Do not edit code; do not commit. Scratch copies and worktrees in
your scratchpad. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Stop at 60% context after writing what
you have.

## Job under check

Builder t1gh ran p5-load3 (brief docs/m2/briefs/p5-load3.md; "Round 3" at the end of docs/m2/reports/p5-load.md).
Earlier verifications: docs/m2/reports/p5-loadv.md and p5-load2v.md (with "Re-check 2b"). Read the builder's claims as
claims.

- **In the tree, uncommitted (platform's):** server/auth/tenancy.js, test/auth/role-cache.test.js. Diff against HEAD.
- **The patch:** docs/m2/reports/p5-load.patch (11 files incl. server/gateway.js). Engine (t18m) applies it to
  gateway.js, so it is checked on a clean HEAD worktree plus the two platform files, never applied to the main tree.
- Other sessions have many uncommitted edits in the main tree (room-host, stores, protocol, web). They are not this job.

## Check

- **Engine's p2-tune intact:** in the patched gateway.js, a90cd6b's batching (`recheckConcurrency`), `rc.cut`,
  per-user errors (`sum.errors`, `ok[]`, retry schedule), the "registry down" stop and count-only `here` behave as at
  HEAD. Without `rolesFor` the code path is engine's, unchanged. Run engine's tests (test/server/tune.test.js,
  revocation.test.js, gateway.test.js) on the patched worktree.
- **Key:** grouping uses the imported `identityKey`; no second spelling anywhere in server/ or test/.
- **LOW A / GAP-M4 / GAP-M6 / M7 / finding 1 (rolesFor bounded by recheckLookupMs):** each test exists and fails under
  its mutation. Redo the builder's mutation table yourself; add any mutation you think it missed (e.g. a late
  `rolesFor` answer writing through after a chunk timeout; `{ board, user }` triggering a pass or a revoke).
- **Revocation bound:** adversarially, can a revoked user still get a new hello or keep a socket past the next timed
  pass (lost announce, cache hit, chunk error, timeout)? Write your own test for anything the builder didn't cover.
- **LOW B/C/D:** PROTOCOL sentence in p5-load.md ends as stated, PROTOCOL.md unchanged; tenancy.js header accurate;
  C2 and C3 tests fail under their mutations.
- **Patch applies:** `git apply --check` on a clean HEAD worktree + the two platform files. Builder says the main tree
  fails only on the two `batch: true` hunks in registry tests because of others' edits; confirm, and say whether
  `git apply -3` resolves it.
- **Gates:** full `bun test` on the patched worktree with and without DATABASE_URL (Podman Postgres); `bun test test/auth`
  in the main tree. Known unrelated: test/core-source.test.js. Main-tree failures from other sessions' edits: check any
  you suspect against the isolated worktree.
- **sdd ensemble review** of the gateway hunks (codex + one more harness passing check_adapter). Two agreeing = HIGH
  candidate; confirm or refute each with a test or run.

## Done when

docs/m2/reports/p5-load3v.md written with PASS or FAIL, findings graded HIGH/MEDIUM/LOW, commands and outputs (minus
secrets), each claim confirmed or refuted. Then stop.
