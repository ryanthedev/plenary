# Brief: p5-load3 (re-cut the gateway patch against engine's a90cd6b; close LOWs A-D)

docs/m2/BRIEF-BASE.md applies. Manager: `manager platform` (t187). Report only to t187; never prompt, hc send or
SendMessage to the proxy (t1bx) or engine (t18m). Never print .env values or tokens. No pkill/killall. Do not commit.
Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Append "Round 3" to docs/m2/reports/p5-load.md.

## Why

Engine committed p2-tune as a90cd6b: server/gateway.js's revocation re-check is now batched and bounded, with
per-user errors and count-only `here`. Your docs/m2/reports/p5-load.patch was cut against the old gateway. Engine
(t18m) applies the patch to gateway.js themselves; server/gateway.js is not ours to edit in the tree.

## Do

1. **Re-cut docs/m2/reports/p5-load.patch against HEAD (a90cd6b)** so it wires `roleCache`/`rolesFor`/`linkUsesFor`
   (server/auth/tenancy.js) into the gateway's hello path and its timed re-check. Keep engine's batching, chunking,
   per-user error handling and count-only `here` intact. The grouping key must be `identityKey` from tenancy.js
   (`user`, `email ?? ""`, `domain ?? ""`); import it rather than spelling it inline.
2. **LOW A (p5-load2v.md):** the timed pass must call `invalidate(board)` before `rolesFor`. A test (GAP-M6) must
   fail if that call is dropped.
3. **Gateway tests GAP-M4/M6/M7** from the earlier rounds, in the patch, passing on a scratch tree with the patch applied.
   Adopt the verifier's key-equality test (p5l2v-adv.test.js, first test) if a second spelling still exists.
4. **LOW B:** proposed PROTOCOL sentence in p5-load.md ends "The cache never hides a revoke past the next timed pass."
   (PROTOCOL.md itself unchanged; engine/CEO own it.)
5. **LOW C:** fix the stale roleCache header comment in tenancy.js (mention the link-memo cap).
6. **LOW D:** tests for min-over-links (C2) and a joiner using the original read's start (C3) in
   test/auth/role-cache.test.js; each fails under its mutation.
7. **Check:** `git apply --check docs/m2/reports/p5-load.patch` against a clean HEAD worktree or scratch copy; full
   `bun test` there with the patch applied, and in the main tree.

## Done when

Round 3 appended (patch summary, test names, mutation results, gates; known unrelated: test/core-source.test.js).
Then stop.
