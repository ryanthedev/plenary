# Report: p5-loadv (verify p5-load: p-audit F4 and F8)

Verifier report to manager platform (t187). Date 2026-11-12. Nothing in the main tree changed except this file. Not committed.

## Verdict: PASS for the tree hunks; the patch is FAIL as a merge into today's gateway.js

- **Tree hunks (F4 fix, role cache, `linkUsesFor`): PASS, safe to commit.**
  - **Isolated gate:** HEAD plus only this job's files gives 1064 pass, 0 fail.
  - **F4:** a redemption publishes nothing and runs no re-check pass.
  - **Redemption cost:** reproduced: HEAD makes 4 queries and publishes `{ board }`; the tree hunk makes 2 and publishes nothing.
- **The patch must not be applied as it is.** It must be re-cut, or merged by engine with findings 1–3 handled.
  - **Correct on its own base:** it was cut from an intermediate `gateway.js` (blob `f1ee465`). On that base it holds the bar: every revocation case I tried closes and refuses.
  - **Doesn't apply to HEAD:** three files fail (`gateway.js`, `main.js`, `test/auth/role-cache.test.js`); details in finding 3.
  - **Doesn't apply to today's tree:** only `gateway.js` fails there.
- **Merging into today's gateway.js has two HIGH hazards.**
  - **HIGH 1:** engine's lookup timeout (`roleWithin`) does not cover `rolesFor`.
  - **HIGH 2:** engine's per-identity grouping collapses under `rolesFor`'s per-user answer.
  - **How established:** by reading, the merge-file output and tests on the base-patched copy. Not run on a merged gateway.
- **Test gaps:** four guards have no catching test (finding 4).

## Findings

| # | Grade | Finding | Evidence |
|---|---|---|---|
| 1 | **HIGH (merge)** | **A hung `rolesFor` blocks revocation.** The batched pass awaits `auth.rolesFor` with no time bound. Today's tree bounds `auth.role` with `roleWithin` (`recheckLookupMs`, p2-tune HIGH 1), but the patch's batched path skips it. A pass stuck in `rolesFor` holds the board's one pass chain, so the queued `grants` pass never runs. | Scratch test `p5v-hang.test.js`, run on the **base-patched** copy (not a merged gateway): `rolesFor` never settles during a timed pass. After `setGrant(null)` plus a `{ board }` message, the revoked editor's socket was **still open after 4 s** (`socket did not close`). Its base `f1ee465` had the same gap for `auth.role`. So the patch matches its base, but the merge must wrap `rolesFor` in the same bound. |
| 2 | **HIGH (merge)** | **Per-identity groups collapse under `rolesFor`.** Today's `recheckPass` (`server/gateway.js:590`) groups connections by `user + email + domain`, so each identity gets its own answer. `rolesFor` deduplicates by user ("first identity wins"), and the patch reads `roles.get(g.user)`. This merges without a conflict marker, which makes it easy to miss. Two tabs of one user with different emails or domains then get the same role, taken from whichever identity came first. Depending on order, that is a wrong close (1008 "access removed" on a healthy tab) or an invite revoke hidden on every pass. | Unit test plus reading (**not run on a merged gateway**): `rolesFor(b, [{u, new@}, {u, old@ (invited editor)}])` gives **one entry, `u → null`**. Under the merged gateway, the `old@` group would read `null` and be closed. **Fix for engine:** key `resolveMany`/`rolesFor` by the same `user\nemail\ndomain` key the pass groups by, and look up by `g`'s key. |
| 3 | MEDIUM (merge) | **Both `recheckPass` hunks conflict textually** with engine's p2-tune round 2. `git merge-file` (base `f1ee465`, ours = tree, theirs = patched) gives two conflicts: (a) `one()`: engine's `roleWithin` + `sum.errors` against the patch's `batched` branch with `inRow`; (b) the batch loop: engine's `rc.cut` (a grants ask cuts a weaker pass) and the "registry down" early stop (`first && kind === "timed" && !ok.some(Boolean)`) against the patch's chunk fetch and `inRow >= recheckStopAfterErrors`. Every other gateway hunk (LIMITS, subscriber, `unwatchGrants`, the pass-start invalidate and gen bump) merges cleanly. **Merge plan:** keep engine's `cut` check before the chunk fetch; feed a chunk error into engine's `ok[]` and `sum.errors` accounting; bound `rolesFor` (finding 1); fix the key (finding 2). | **On HEAD** (`git apply --check --cached`; the index equals HEAD, `050ef13`): 3 of 11 files fail. `gateway.js:80` fails for the reason above. `main.js:60` and the new `test/auth/role-cache.test.js` fail only because the tree hunks aren't committed yet. The other 8 apply. **Apply order:** commit the tree hunks first. **On today's tree:** only `gateway.js` fails. **On HEAD + tree + `gateway.js` = `f1ee465`:** all 11 apply. |
| 4 | LOW | **Four cache guards have no catching test.** Each was removed one at a time (mutation), and the job's suites stayed green: (a) `rolesFor` write-through skipping `moved` users (`tenancy.js`, `if (r.role == null \|\| moved)`); (b) the gateway subscriber's `auth.invalidate?.(board)` on `{ board }`; (c) the pass-start `auth.invalidate?.(b.board)`; (d) the pass-start `w.gen++` (M7). For (a)–(c) I wrote a test that fails under the mutation and passes without it: `GAP-M3`, `GAP-M4` and `GAP-M6`, in `docs/m2/reports/p5-loadv.tests.txt`, for engine/platform to adopt. For (d), nothing caught it, even with my tests, and I built no test. The case it guards: a hello that read a cached role before the pass and is still waiting on the room. | Mutation table below. |
| 5 | LOW | **A lost message now admits NEW hellos until the next pass.** The report says the stale bound is the "same" as today; that is true for the bound, but behaviour changed. Today, when a `grants` message is lost, a **new** hello reads fresh and is refused at once. With the cache, it is admitted from the cache until the next timed pass (or the 30 s TTL). The bar holds (a revoke is never hidden past the next timed pass), and existing sockets were already exposed this way today. Worth one line in PROTOCOL.md. | Scratch test: revoke with no message; a new hello was **welcomed**, then closed by the pass after 1,495 ms (`roleRecheckMs` 1,500). |
| 6 | LOW | **Pass query count is 6, not 4, in steady state.** The report's "4 per 1,000-user chunk" assumes board and tenant are memoized. `recordTtlMs` (60 s) equals the pass interval (60 s), so the memo has likely expired by the next pass, giving 6 per pass. Negligible next to 4,750. Raise `recordTtlMs` (board and tenant never change) if the 4 matters. | Counts below: pass 1 = 6, passes 2–3 = 4 (memoized). |
| 7 | LOW | **Empty index sets after eviction** (codex). `byBoard` and `linksOf` keep empty sets after an eviction (`tenancy.js:204`, `:227`). They are bounded in practice: the patched gateway calls `invalidate(board)` when a board's watch is released, and `dropBoard`/`dropLinks` delete the sets then. | Confirmed by reading. Mitigated by the release hook (scratch test "cached roles go when its last socket closes" passes; its mutation M5 fails it). |
| 8 | LOW | **Not monitored.** `roleCache().stats()` is not on `/health`. The report already says so. | — |

## Gates

| Run | Result |
|---|---|
| `bun test`, main tree (others mid-edit) | 1119 pass, 113 skip, **11 fail** (listed below the table). **None is this job's**: none is in `test/auth`, the role cache or the registry, and the isolated job-only run below is green. |
| HEAD + **only** this job's tree files, isolated (`git worktree`) | **1064 pass, 101 skip, 0 fail** |
| Patched scratch (tree + `gateway.js` `f1ee465` + patch), no `DATABASE_URL` | 1133 pass, 115 skip, 2 fail. Both failures are `test/web/collab/wire.test.js` M3 (+N avatars). `web/` was being edited live by another session (7 `web/` files differ between the copy and the tree). Not this job. |
| Patched scratch, `DATABASE_URL` = Postgres 17.11 in Podman | 1217 pass, 34 skip, the same 2 web failures. `test/server/pg-registry.test.js` gives **48 pass, 0 fail**, including the `batch: true` contracts (owner and least-privilege runtime role). |
| Architecture tests | Pass in every run above (`test/architecture.test.js`, `test/web/architecture.test.js`). |
| My adversarial and gap tests (scratch only) | 14/14 pass. `p5v-hang` fails as expected (finding 1). |

The 11 main-tree failures, verbatim (`bun test 2>&1 | grep -E '\(fail\)'`):

```
(fail) packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)
(fail) slow auth: ops after welcome are acked in order and numbered per connection
(fail) rule 1: nothing is acked or broadcast before the append resolves
(fail) H1: a 30,000-deep op is refused before it is parsed, nothing is stored, and joins stay fast
(fail) H1: catch-up is right for every `since`, and the same bytes go to every joiner
(fail) M5: a v0 `transient` op is refused, not relayed and not logged; an inbox gap closes the connection
(fail) R2: a timed pass whose Registry calls fail keeps the connections, retries with backoff, then closes after the bound
(fail) R2: a Registry blip during the timed pass closes nobody; the retry clears it; a timed pass that meets errors in a row stops early
(fail) here: bounded with many viewers: at most hereMax writers listed (counts past it), bus messages small, slower to a big board
(fail) the real tree: the allowlist equals an independent crawl of web/main.js (Bun's bundler), minus the deny list
(fail) § Pacing: frames read from a live socket faster than they are handled are capped in bytes: past maxLiveQueuedBytes, `unavailable` and close
```

## Revocation under the cache (patched scratch, memory bus)

| Scenario | Result |
|---|---|
| Revoke during an in-flight hello read (Registry `grant` held at a gate) | Hello refused (1008); the next hello is also refused, so the fill was discarded |
| Revoke while a cached second tab waits to go live | Both tabs closed (1008 or 1012 via the gen re-ask) |
| Revoke during a `rolesFor` chunk (timed pass held in `grants`) | Socket closed 1008; the next hello is refused; the stale chunk is not written through |
| Two gateways sharing one bus and one registry, warm caches on both; revoke via `announcingRegistry.setGrant` | All 3 sockets closed 1008 on both nodes; a new hello is refused on each |
| `{ board, user }` (link use, viewer) and `{ board }` (revoke, editor) published in the same turn | Editor closed 1008; viewer untouched |
| `{ board, user }` during that user's in-flight hello | The next hello gets the new role (`editor`); a stale lower role is not cached |
| Downgrade editor to viewer | 1012; the next hello is `viewer`, not the cached `editor` |
| Share-link revoke (guest via link, warm cache, memoized link record) | Both tabs 1008; a new hello is refused |
| Email or domain change (unit) | Misses the cache; a revoked invite on the new email gives `null`; the domain path still gives `editor` |
| Lost message, new hello | Admitted until the next pass (finding 5) |
| Hung `rolesFor` | Revocation blocked (finding 1) |
| Two identities of one user (unit) | One answer (finding 2) |

**Mutations** (each applied alone, then restored; suites: `test/auth/role-cache`, `test/server/role-cache`, `revocation`, my `p5v-adv`):

| Mutation | Builder's tests | With my gap tests |
|---|---|---|
| M1 `role()` fills despite stamps (invalidation guard) | **3 fail** | — |
| M2 single-flight joins any in-flight read (`flight.c0 === clock` removed) | **1 fails** (the builder's mutation claim holds) | — |
| M3 `rolesFor` write-through ignores `moved` | 0 fail | `GAP-M3` fails |
| M4 subscriber drops no cache on `{ board }` | 0 fail | `GAP-M4` fails (a new hello during a running pass is admitted from a cache refilled after the pass began) |
| M5 no invalidate on watch release | **1 fails** | — |
| M6 no invalidate at pass start (gen bump kept) | 0 fail | `GAP-M6` fails (a user who left, then a lost revoke: admitted after the pass) |
| M7 no gen bump at pass start (invalidate kept) | 0 fail (40 pass) | 0 fail: **untested** (finding 4d) |

**The brief's "between invalidate and the pass":**

- **Rows that cover it:** "Revoke during a `rolesFor` chunk" and GAP-M4. In both, the grants message lands while a pass already runs, so the subscriber's invalidate fires and the grants pass waits behind the running one.
- **The other case:** a message arriving with no pass running starts the pass in the same turn, so there is no gap to hit.

All mutations were restored and checked with `cmp`: `tenancy.js` against the main tree; `gateway.js` against `f1ee465` re-patched. The full `p5v-adv.test.js` was re-run after: 14 pass.

## F4 without the patch (tree as it is)

Test: HEAD + this job's files, an unpatched gateway, a real `announcingRegistry`, and `tenancy.redeemLink`.

- **Nothing announced:** the redemption published nothing on `grants`, and no role lookup ran (no pass).
- **The redeemer's next hello:** welcomed as `editor`, the link's role.
- **The redeemer's already-open viewer socket:** closed **1012 "role changed" by the next timed pass** (737 ms with `roleRecheckMs` 800).
- **Is there a path that must re-check?** No. A redemption only raises the redeemer's role (highest wins; `combine` never lowers), so no revoke rides on it. The one effect is that an upgrade of an already-open socket waits for the timed pass (≤ 60 s), as it did before.
- **Is that 1012 close a wrong close?** It is not new: today's announcement closed the socket the same way, only sooner.
- **Rating:** LOW, and acceptable as shipped.

## F8 counts (my counting wrapper: every Registry method call is one query)

Fixture as the builder's: 1,000 users (500 members with email and domain, 250 invite guests, 250 link guests, 50 grants). `p5v-counts.js` (scratch). Identical on all three backends:

| Path | Memory | SQLite | Postgres 17.11 | Report |
|---|---|---|---|---|
| Before: timed pass, 1,000 × `tenancy.role` | 4,750 | 4,750 | 4,750 | 4,750 ✓ |
| Before: hello (role only) | 5 | 5 | 5 | 5 ✓ |
| After: pass, `rolesFor` with `linkUsesFor` (agrees with `role` for all 1,000) | 6 cold, 4 warm | same | same | 4 (finding 6) |
| After: pass without `linkUsesFor` | 1,005 | 1,005 | 1,005 | 1,005 ✓ |
| Hello, link guest, cold, board's first | 5 | 5 | 5 | 5 ✓ |
| Hello, link guest, board memoized | 3 | 3 | 3 | 3 ✓ |
| Hello, member, first tenant read, then memoized | 4, then 3 | same | same | 4, then 3 ✓ |
| Warm hello | 0 | 0 | 0 | 0 ✓ |
| Redemption (patched `main.js`), first per link, then again | 4, then 2 | same | same | 4, then 2 ✓ |
| `linkUsesFor` with 5,000 users incl. `o'brien`, `dq"x`, `ünï-çødé-用户`, `a,b`, `x\y`, `[]`, `null`, `"  sp  "` | equals per-user `linkUses` for every user | same | same | — |

## distributed-systems-design, CHECKER mode (role cache across gateways)

- **Cache strategy:** a per-node read-through cache, with no shared tier.
  - **TTL:** 30 s, cut short at the soonest invite or link `expiresAt` the answer depended on, so a time-based loss is exact.
  - **Null is never cached**, so a refusal is always fresh.
  - Expiration policy: defined and sound.
- **Consistency:** AP with bounded staleness.
  - **Invalidation feed:** the `grants` subject, at-most-once.
  - **Safety net:** the timed pass, which invalidates the board and reads fresh; the TTL caps it further.
  - **Stale bound:** a new hello on a node that missed the message is ≤ min(TTL, next pass) (finding 5). A live socket keeps today's bound.
  - **Cross-node:** correct only while the Registry keeps read-your-writes (`registry-port.js`). **A future Postgres read replica would break the "read after invalidate sees the write" step.** The port forbids replica reads; keep it that way, or add a version check.
- **Thundering herd:** the cache does not help cold joins. 100k cold hellos still cost about 4 queries each (≈ 3.3k qps at 833 hellos/s), and a gateway restart is all cold. This is no regression; the report already lists it as the top remaining bottleneck. Single-flight covers records only, not roles (fine: roles are per user).
- **Failure:** errors are never cached, and a batch error fails the chunk under today's rules. The missing gap is the **time bound on `rolesFor`** (finding 1).
- **Memoized "immutable" records:** board and tenant are memoized for 60 s, which is safe only because the port has no update or delete for them. Any future `setMemberRole` or `deleteBoard` must announce `{ board }` and drop these records too. Today `invalidate(board)` drops only roles and links, not the board or tenant record.
- **Monitoring:** `stats()` is not exported (finding 8).
- **10×:** `grantsFor(board, users)` (the report's own note) is still the next step for boards with many explicit grants.

## sdd ensemble review

- **Harnesses:** `check_adapter` passed for codex and grok. agy is out of quota (429, resets in 54 h); kimi has no model configured; mistral has no API key; qwen is missing.
- **Setup:** codex (`effort: high`) and grok each reviewed a separate copy of the patched scratch tree, with no `.env`.

| Harness | Verdict | Findings |
|---|---|---|
| codex | "No confirmed revocation or healthy-connection failure" | LOW: empty sets in `byBoard`/`linksOf` → **confirmed, mitigated** (finding 7) |
| grok | "Clean; meets the bar" | none |

- **No two harnesses agreed on anything**, so the ensemble produced no HIGH candidate.
- **Both reviewed the patch against its own base**, where findings 1 and 2 don't arise. Those two come from the merge analysis above.

## Commands (reproduce)

- **Patch base:** `git apply --check docs/m2/reports/p5-load.patch` fails at `server/gateway.js:80`, on HEAD and on the tree. The base blob is `git cat-file -p f1ee465`.
- **Scratch build:** `git worktree add --detach <scratch>/wt HEAD`; rsync the tree; put `f1ee465` in `server/gateway.js`; `git apply` the patch.
- **Merge check:** `git merge-file -p <tree gw> <f1ee465> <patched gw>` gives 2 conflicts, both in `recheckPass`.
- **Postgres:** `podman run -d --rm … postgres:17.11-alpine3.23 -p 127.0.0.1::5432`. Container `34524fdf553f` was recorded, then stopped and removed; no other container was touched.
- **Worktrees:** both of mine (`wt`, `wt-job`) were removed and pruned.
- **Scratch test sources:** saved in `docs/m2/reports/p5-loadv.tests.txt`: `p5v-adv.test.js` (14), `p5v-hang.test.js`, `p5v-f4.test.js`, `p5v-counts.js`, `p5v-c2.js` and `p5v-redeem.js`.

## Gap tests for engine/platform to adopt (finding 4)

These are in the scratch copy only. Their shape:

- **GAP-M3 (unit, `test/auth/role-cache.test.js`):** hold `grants` inside `rolesFor`; `setGrant(u, null)` + `invalidate(board)`; release. Then `role(u)` must be `null` and must make one fresh `grant` read.
- **GAP-M4 (gateway):** hold the timed pass in `rolesFor`; a second hello of the user refills the cache; revoke + `{ board }`. A third hello must be refused (1008) while the pass is still held.
- **GAP-M6 (gateway):** user X cached; X leaves while another user stays; revoke with no message; wait one timed pass. X's new hello must be refused.

## Not verified

- **NATS:** the two-gateway case ran on a memory bus shared by two servers, not on NATS.
- **The merged gateway:** I did not resolve the conflicts. Findings 1–3 come from the base-patched copy, a unit test and the `merge-file` output.
- **Real load:** no 100k run.
- **Main-tree failures:** I did not root-cause the 11 failures in today's main tree. I attribute them to the other sessions' in-progress files because the isolated job-only worktree is green.
