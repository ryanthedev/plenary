# Brief: p5-load2 (fix round: re-cut the role-cache patch onto today's gateway; verifier findings 1-4, 6)

docs/m2/BRIEF-BASE.md applies (Architecture line too). Manager: `manager platform` (t187). Report only to t187; never
prompt, hc send or SendMessage to the proxy (t1bx) or engine. Never pkill/killall; record any Podman id and remove
only it. Never print .env values. Name failing tests with `bun test 2>&1 | grep -E '\(fail\)'`. Do not commit.
If your context passes 60%, write what you have and stop. Append "Round 2" to docs/m2/reports/p5-load.md.

## State

Your tree hunks are committed (1d73436). The verifier (docs/m2/reports/p5-loadv.md, read all of it) passed them, but
`docs/m2/reports/p5-load.patch` was cut from an intermediate gateway.js (blob f1ee465) and does not apply to today's.
Engine's p2-tune round 2 is in the main tree's gateway.js, **uncommitted** (record `git hash-object server/gateway.js`
as your base; do not edit the main tree's gateway.js or main.js, they are engine's).

## Do

1. **Finding 2 (HIGH), in your files:** key `resolveMany`/`rolesFor` (tenancy.js, cache included) by the same
   `user\nemail\ndomain` identity key the gateway's `recheckPass` groups by, so two identities of one user get their own
   answers. A test with two identities of one user (one invited email, one not) shows both answers.
2. **Finding 4:** adopt GAP-M3 into test/auth/role-cache.test.js (from docs/m2/reports/p5-loadv.tests.txt) and confirm it
   fails under mutation M3. Put GAP-M4, GAP-M6 and a new test that catches M7 (pass-start `w.gen++` removed) in the
   patch's gateway tests; confirm each fails under its mutation.
3. **Finding 6:** raise `recordTtlMs` above the pass interval (board and tenant records cannot change under the port);
   say what invalidates them if a future port adds an update/delete.
4. **Re-cut the patch** against today's main-tree gateway.js (and main.js/tests as they are now), following the
   verifier's merge plan (finding 3): keep engine's `rc.cut` check before the chunk fetch; feed a chunk error into
   engine's `ok[]` and `sum.errors` accounting and its "registry down" early stop; **bound `rolesFor` with the same
   time limit as `roleWithin` (`recheckLookupMs`)** (finding 1) and re-run `p5v-hang` to show a hung `rolesFor` no
   longer blocks revocation. Look up roles by the identity key (step 1).
5. **Gates:** `git apply --check` of the new patch on a copy of today's tree; a scratch copy (tree + patch) full
   `bun test` with and without DATABASE_URL (Podman Postgres), every failure named and compared to the unpatched tree;
   the revocation table from p5-loadv re-run on the merged gateway.
6. **Finding 5:** propose one PROTOCOL.md sentence (lost grants message: a new hello may be admitted from cache until
   the next timed pass or the TTL) in the report; do not edit PROTOCOL.md.
7. **Design check:** distributed-systems-design APPLIER, short note on the time bound and per-identity keying.

## Files you own

server/auth/tenancy.js, test/auth/role-cache.test.js, docs/m2/reports/p5-load.patch, docs/m2/reports/p5-load.md.

## Done when

The above, report appended, then stop.
