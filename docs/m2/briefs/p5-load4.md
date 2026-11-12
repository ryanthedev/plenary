# Brief: p5-load4 (re-cut the gateway patch onto HEAD; adopt verifier tests V1/V2; PROTOCOL sentence as a patch hunk)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine (t18m). Never print .env values or tokens. No pkill/killall. Do not commit.
Do not edit server/gateway.js, PROTOCOL.md or other sessions' files in the main tree: work in a clean HEAD worktree in
your scratchpad and write only docs/m2/reports/p5-load.patch and a "Round 4" section at the end of
docs/m2/reports/p5-load.md. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Stop at 60% context after
writing what you have.

## Why

p5-load3 passed verification (docs/m2/reports/p5-load3v.md) with conditions. The platform half (tenancy.js,
role-cache test) is committed (426757d). The patch docs/m2/reports/p5-load.patch no longer applies to HEAD: hunks in
test/server/pg-registry.test.js (a `batch: true` hunk now inside a `try`, after c2024f3) and registry.test.js fail.

## Do

1. **Re-cut docs/m2/reports/p5-load.patch against HEAD** (`git rev-parse HEAD`) so `git apply --check` passes on a
   clean HEAD worktree. Change nothing else about its behaviour.
2. **Adopt V1 and V2** from docs/m2/reports/p5-load3v.adv.test.js.txt (the verifier's chunk-catch invalidate test and
   chunkErr reset test) into the patch's test/server/role-cache.test.js (or wherever the patch's gateway tests live).
   Confirm each fails under its mutation (drop the invalidate in the chunk catch; drop the chunkErr reset).
3. **PROTOCOL sentence:** add a PROTOCOL.md hunk to the patch carrying the LOW B sentence from p5-load.md (the one
   ending "The cache never hides a revoke past the next timed pass"), placed where revocation timing is described.
   Engine/CEO decide whether to apply it; it travels with the patch so it cannot be forgotten.
4. **Gates on the patched worktree:** full `bun test` without DATABASE_URL, and with it (Podman Postgres; record the
   container id, remove only that). Known unrelated: test/core-source.test.js.
5. **Main tree check:** `git apply --check` (and `-3 --check` if that fails) against the main tree; name the files
   that conflict because of other sessions' edits.

## Done when

docs/m2/reports/p5-load.patch re-cut, "Round 4" appended to p5-load.md with: base commit, apply-check outputs, the two
mutation results, gate counts. Then stop.
