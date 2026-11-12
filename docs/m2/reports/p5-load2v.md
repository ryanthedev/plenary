# Report: p5-load2v (verify p5-load Round 2, tenancy side only)

Verifier report to manager platform (t187). Date 2026-11-12. Scope: `git diff server/auth/tenancy.js
test/auth/role-cache.test.js` (uncommitted) and the Round 2 section of docs/m2/reports/p5-load.md, steps 1, 2 (GAP-M3),
3, 6, 7. Out of scope: the patch re-cut, GAP-M4/M6/M7, docs/m2/reports/p5-load.patch. Nothing in the main tree changed
except this file. Not committed.

## Verdict: PASS, with one MEDIUM to fix in wording (no code change needed for the bar)

- **MEDIUM 0, new: the "30 s" bound is false for link revokes.** With the `grants` message lost, a new hello stays
  admitted for up to **~60 s**: up to 30 s on the memoized link record, then a fresh 30 s role entry on top. The bar
  still holds, because the next timed pass (≤ 60 s, pass-start invalidate) caps it. But the builder's proposed
  PROTOCOL sentence and the `ttlMs` JSDoc both state 30 s. Details: MEDIUM 0 below.
- **Brief's HIGH trigger, ruled on by t187:** the brief says any path where a board or tenant record changes without
  a restart is HIGH. **`addTenantAdmin` literally meets that:** it changes `tenant.admins` at another node's startup
  on a shared Postgres. I grade it **LOW 2**: no field the cache's consumers read ever changes, and admins are
  add-only. **t187 to confirm the regrade.**
- **Identity keying (finding 2): fixed.** `identityKey` is engine's key character for character. Per-identity answers
  hold for `resolveMany`, `rolesFor` (plain, fallback, cached) and `role`. `invalidate(board, user)` drops every identity.
  No way found to leak one identity's answer to another with reachable data. The only collision needs a `"\n"` inside
  two identity fields at once (LOW 1).
- **GAP-M3: fails under M3, confirmed by my own mutation** (and under a second spelling of it).
- **TTLs (finding 6): safe.** No runtime path changes a field the cache reads from a board or tenant record. One record
  field does change at runtime, `tenant.admins`, which the cache's consumers never read (LOW 2). `revokeLink` +
  `invalidate(board)` drops link records (tested).
- **Finding 5 sentence: true, with three qualifications** (LOW 5).
- **Gates:** green apart from the known core-source failure and one load-flaky test in engine's `tune.test.js`.
- **Ensemble:** codex found nothing; grok's one HIGH is refuted by a test. No HIGH.

## Findings

| # | Grade | Finding | Evidence |
|---|---|---|---|
| 0 | MEDIUM (wording) | **The time-based bound for a new hello after a lost link revoke is `linkTtlMs + ttlMs` (~60 s), not 30 s.** `role()` builds a fresh entry from a link record that may already be up to 30 s old, and an entry's `until` is not capped by the age of the records it read. So the TTL side alone equals the 60 s pass interval. **The bar still holds:** the next timed pass's `invalidate(board)` drops both. **Two things are wrong:** the proposed PROTOCOL sentence ("the cache entry's 30 s life") and the `ttlMs` JSDoc ("a role entry's longest life… keep it ≤ the gateway's 60 s re-check"), which is now met only with equality. **Fix, either:** (a) the sentence says "at most about 60 s (a 30 s role entry built on a link record up to 30 s old)", or (b) the cache caps a role's `until` at the soonest `until` of the link records it read. (b) restores 30 s for a small code change. Invites and grants are not memoized, so only links chain. | Scratch test "chained TTLs" (in p5-load2v.tests.txt): A's hello memoizes the link at T; `revokeLink` with no invalidate. B (prior use, no cached role) is `editor` at T+29 s, T+31 s and T+58 s, and `null` only at T+59.001 s. |
| 1 | LOW | **A `"\n"` inside identity fields can collide keys** and serve one identity's cached answer to another. It needs a newline in **two** fields (for example user `google:a\nb` + email `b@x.com` against user `google:a` + email `b\nb@x.com`), because the template always adds exactly two separators. Unreachable today: dev names match `/^[A-Za-z0-9_.@-]{1,64}$/` (server/auth/dev.js:13), Google users are `google:<sub>` with a Google-signed numeric sub, and emails/domains come from the signed token. The same collision exists in engine's inline spelling (gateway.js:591), which the brief requires the key to match. **Optional hardening for both owners together:** `JSON.stringify([user, email ?? "", domain ?? ""])`, or refuse control characters in `Identity` at the IdP port. | Scratch test "newline in a user id collides keys": the odd identity (no grant, no invite) gets `editor` from the cache, and `resolveMany` answers only one of the two. |
| 2 | LOW | **"Board and tenant records cannot change" is slightly overstated.** `addTenantAdmin` changes `tenant.admins` at runtime: `bootstrapTenant` runs at any node's startup (server/main.js:167, server/admin/tenants.js:68), and in a cluster on a shared Postgres that is while other nodes run. Harmless today: `combine` reads only `tenant.domain`, `board.id`, `board.memberRole`, and neither has a write. The admin path (`isTenantAdmin`, server/admin/boards.js:40) uses the raw registry, not the cache. Admins are add-only, so even a cached admin list would fail closed. **Suggest:** the `recordTtlMs` JSDoc says "the fields the cache reads never change" and warns not to serve `admins` from the memo. | Every Registry write in server/auth/registry.js, server/registry/{sqlite,postgres}.js and server/admin/: inserts only for tenants and boards, plus `addTenantAdmin`; no UPDATE/DELETE of either table. |
| 3 | LOW | **Test gap: dropping only one identity on `invalidate(board, user)` isn't caught.** The builder's two-identity test re-reads only `oldId`, the first entry in the user's index set. | Mutation M8 (drop only the first key of `byUser`): role-cache.test.js 16/16 pass. My scratch tests "three identities…" and "eviction then invalidate…" fail. Fix: after the invalidate, also assert `member` misses, or assert `stats().entries`. |
| 4 | LOW (liveness only) | **The "compute `moved` for every row before stamping" ordering is untested.** Reordering it only makes a call skip caching its own other identities of one user when other reads are in flight (fewer fills). It is never staler. | Mutation M9 (compute `moved` inside the loop, after stamping): 24/24 pass (builder's suite plus mine). |
| 5 | LOW | **Finding 5 sentence: true, but needs three qualifications.** (a) It describes the cache once the re-cut patch is wired. Today `roleCache` is not used by server/main.js, so the behaviour isn't live yet. (b) "30 s" is wrong for links: up to ~60 s (MEDIUM 0). It is "at most 30 s" only for grants and invites, which are not memoized. (c) "a revoke is never hidden past the next timed pass" holds for **new hellos**: the pass-start `invalidate(board)` drops the cache whatever happens next. It does **not** hold for a connection already admitted if that pass's Registry read fails: it is kept and retried (2/4/8 s, PROTOCOL.md § Errors), as for any live connection. Suggested wording: "…until the gateway's next timed re-check, which reads the Registry fresh and treats the connection like any other live one, or until the cache entry's life ends (at most about 60 s; see MEDIUM 0), whichever is first. A revoke is never hidden longer than it would be without the cache." | Read against PROTOCOL.md:640–655 and tenancy.js. Not run on a merged gateway (none exists yet). |
| 6 | Info (engine, out of scope) | **PROTOCOL.md § Re-checking says "Per user, not per connection"**, but engine's gateway now groups per identity (user, email, domain). Engine's PROTOCOL edit, not this job's. | PROTOCOL.md:647; gateway.js:589–593. |

### Ensemble claims refuted or regraded

- **grok HIGH, "email case leaks across identities": refuted.** Different case gives different keys, so two entries, never a shared one. Both answer from the invite through `normEmail`. Scratch test "email case: two keys, both answered…" passes.
- **grok MEDIUM, `"\n"` collision:** confirmed, regraded LOW 1 (needs two crafted fields; unreachable).
- **grok MEDIUM, 10 min TTL "unsafe on future writes":** about the future only. The builder's JSDoc already states the rule for a future `setMemberRole`/`deleteBoard`. Folded into LOW 2.
- **grok LOW, records eviction leaves sets in `linksOf`:** round 1's finding 7, unchanged and still mitigated.
- **grok LOW, GAP-M3 doesn't cover the STAMP_MAX path:** true. That path stamps the whole board, which is coarser and never staler. No test.
- **No two harnesses agreed**, so there is no HIGH candidate.

## Checks

### Identity keying (finding 2)

- **Equal to engine's key:** for every combination of email and domain in {missing, `undefined`, `null`, `""`, a value}, `identityKey(identity)` equals gateway.js:591's template applied to `{ user, identity }`. `c.user` is `identity.user` (gateway.js:886).
- **null / undefined / "" share one key and one answer:** `combine` and `resolve` test email and domain by truthiness (`id.email ?`, `identity.domain &&`), so all three are the same identity. Test: `tenancy.role` gives one answer for all three, and the cache serves 2 hits.
- **Per-identity answers:** checked over a real Postgres registry. 300 users, 2–3 identities each (invited email, domain member, bare), grants, link uses, invites, shuffled. `tenancy.rolesFor`, `roleCache.rolesFor` and the write-through `role()` equal per-identity `tenancy.role` for every key.
- **`invalidate(board, user)` with three identities:** all three dropped; another user's entry kept (hit). After an eviction (`maxEntries: 2`), invalidate leaves 0 entries and no evicted identity comes back.
- **Write-through and a concurrent hello:** a hello for identity B, held inside `grant` while `rolesFor([A])` of the same user completes after a revoke, is not cached. The per-user stamp discards it, and the next `role(B)` reads `null`.

### GAP-M3 (on a scratch copy; restored, `cmp` clean)

| Mutation | role-cache.test.js |
|---|---|
| none | 16 pass |
| M3: `if (r.role == null \|\| moved)` becomes `if (r.role == null)` | **GAP-M3 fails** (15 pass, 1 fail) |
| M3b: `moved` forced to `false` | **GAP-M3 fails** |
| M8: `invalidate(board, user)` drops only the first identity | 16 pass (LOW 3); my scratch tests catch it |
| M9: `moved` computed after stamping | 16 pass (LOW 4) |

### TTLs (finding 6)

- **`recordTtlMs` 600 000 / `linkTtlMs` 30 000** are in the code (tenancy.js:186) and apply per kind (`kind === "link"`).
- **Registry writes:** see LOW 2. Neither board nor tenant has an update or delete; only `tenant.admins` grows.
  - **How checked:** an unfiltered grep for `UPDATE|DELETE|ALTER|TRUNCATE` in both SQL adapters. The only hits are `reg_grants` (setGrant), `${I}`/`reg_invites` and `${L}`/`reg_links` (revoke), and comments.
  - **Method sets:** all three adapters (memory, SQLite, Postgres) expose exactly the port's methods; Postgres adds `linkUsesFor` and `readSettings`, neither a write.
- **`revokeLink`:** `announcingRegistry` announces `{ board }` on it (server/main.js:80), and `invalidate(board)` calls `dropLinks(board)`.
  - Tested: after revoke + invalidate, `role` is `null`.
  - Without a message, the 30 s role and link TTLs bound it (`null` at +30 001 ms).
  - The gateway subscriber that calls `invalidate` is in the pending re-cut. Not verifiable yet.

## Gates

| Run | Result |
|---|---|
| Full `bun test`, main tree, no `DATABASE_URL` | 1141 pass, 125 skip, **2 fail**: `packages/core is still herdr-draw's core` (known) and `M2/LOW 5: a count change sends the count-only here…` (test/server/tune.test.js, engine's). The second passes 3/3 run alone and doesn't touch tenancy: a timing flake under full-suite load. Not this job. |
| Full `bun test`, `DATABASE_URL` = my Podman Postgres 17.11 | 1236 pass, 34 skip, **1 fail**: core-source only. |
| Scratch pg differential (`p5l2v-pg.test.js`) | 1 pass |
| Scratch adversarial (`p5l2v-adv.test.js`, 9 tests) | 9 pass (the "chained TTLs" test logs its result: MEDIUM 0) |

- **Does the role cache touch the pg path?** Only through `linkUsesFor`, which this diff now calls with users deduplicated across identities. That is why I ran the pg differential.
- **Podman:** container `7b8c65561507` started by me and stopped with `--rm` (gone). No other container touched.

## distributed-systems-design, CHECKER (cache staleness bounds)

Skill loaded (systems-design v0.1.0, `distributed-systems-design` § 3 CHECKER; chapter 1 cache criteria). The items that
apply to a per-node in-process cache:

| CHECKER item | Result |
|---|---|
| Read-through: check cache, miss falls through to the DB, store, return | ✓ `role()`; `rolesFor` is write-through and never served from the cache |
| Expiration policy defined, neither too short nor too long | **Partly.** Roles 30 s, links 30 s, board/tenant 10 min are each sound alone, but **they chain**: role staleness after a lost link revoke is ~60 s (MEDIUM 0). The policy should state the composed bound, or cap it. |
| CAP choice explicit | ✓ AP with bounded staleness; the timed pass is the anti-entropy step |
| Reads go to the primary (replication lag gives stale reads) | ✓ The port requires read-your-writes. Still a hazard if a read replica is ever added (round 1). |
| Failure scenarios per component | ✓ Errors never cached. A pass that errors still drops the cache at pass start. Restart means a cold cache, so a fresh read. |
| Single point of failure | ✓ None: a per-node cache with no shared tier |
| 10× load | ✓ Bounded by `maxEntries`/`maxRecords`; cold-join herd unchanged (round 1) |
| Monitoring | ✗ `stats()` not on `/health` (round 1 finding 8) |

- **New hello, `grants` message delivered:** 0 staleness. The subscriber invalidates synchronously, and per-board and per-user stamps discard reads in flight (GAP-M3 now guards the write-through).
- **New hello, message lost:** at most min(entry life, next timed pass ≤ 60 s). Entry life is ≤ 30 s for grants and invites, and ≤ ~60 s for links (MEDIUM 0). The pass-start `invalidate(board)` holds even when the pass then errors. This is a regression in kind only, from "refused at once" (finding 5). PROTOCOL wording: LOW 5.
- **Live connections:** unchanged from today.
- **Records:**
  - **Board and tenant, 10 min:** safe, because the fields read are write-free under the port (LOW 2).
  - **Links, 30 s:** dropped on `{ board }`, and by the pass-start invalidate.
  - **Single-flight:** joins only within one clock epoch (round 1, M2).
- **Keying:** one key function for cache, batch and pass (once engine imports `identityKey`). Stamps per (board, user) are coarser than per identity: the cost is liveness (discarded fills), never staleness.
  - **Until the re-cut lands, two spellings exist.** My equality test (first test in `p5l2v-adv.test.js`) is worth adopting next to GAP-M4/M6, so a future change to either fails loudly.
- **Cross-node:** still correct only under the Registry's read-your-writes (round 1). No replica reads.
- **Missing:** `stats()` still not on `/health` (round 1 finding 8).

## sdd ensemble

- **check_adapter (all six probed):**
  - **Passed:** codex, grok.
  - **Failed:** agy (429 quota, resets in ~54 h), kimi (no model configured), mistral (no `MISTRAL_API_KEY`).
  - **Missing:** qwen (not installed).
- **Setup:** each harness reviewed its own scratch copy (server/, test/, packages/, PROTOCOL.md, no `.env`) with the diff as DIFF.patch.

| Harness | Verdict | Findings |
|---|---|---|
| codex (effort high) | "No actionable findings" | none |
| grok | "Safe with 3 medium/high risks" | 1 HIGH, 2 MEDIUM, 2 LOW (all handled above) |

## Not verified

- **The merged gateway:** the re-cut, subscriber invalidate and pass-start invalidate are pending, so no end-to-end revocation run on the cache in this round.
- **NATS, and load.**
- **The tune.test.js flake:** not root-caused (engine's file).

## Test sources

- **Where:** `docs/m2/reports/p5-load2v.tests.txt` holds `p5l2v-adv.test.js` (9 tests, all pass) and `p5l2v-pg.test.js`.
- **Worth adopting** into test/auth/role-cache.test.js:
  - the key-equality test (first in the file);
  - "three identities…" (catches M8, LOW 3);
  - "chained TTLs", as an assertion once MEDIUM 0 is decided.

## Re-check 2b (p5-load2bv, 2026-11-12)

### Verdict: PASS

- **MEDIUM 0 is fixed.** After a lost link revoke, a new hello is refused at exactly T+30 s. The cap takes the
  oldest of several link memos, and a reader that joins an in-flight read is capped by that read's start.
- **LOW 3 is fixed.** M8 now fails the builder's two-identity test.
- **LOW 2 is fixed.** The JSDoc names the four fields the cache reads and warns against serving `admins`.
- **LOW 5 is fixed, apart from one clause of my own Round 2 wording** (LOW B below).
- **PROTOCOL.md is unchanged by this round.**
- **Nothing else regressed.**
- **Two new LOWs and one test gap**, none blocking.

### Findings

| # | Grade | Finding | Evidence |
|---|---|---|---|
| A | LOW (for the re-cut) | **`rolesFor` alone doesn't refresh the link memo.** A pass that sees a revoked link evicts the role. But a hello right after it, with no `invalidate(board)` first, rebuilds the role from the stale memoized link record: `editor` again, until the memo ends (≤ 30 s, now capped). The gateway's real pass order is `invalidate(board)` and then `rolesFor`, which drops the memo, so the next hello is refused. That makes the pass-start invalidate load-bearing for links as well as roles. **GAP-M6 in the re-cut must keep it.** This predates Round 2b; the cap only bounds it. | Scratch tests "rolesFor (the pass path)…": with no invalidate, the next hello is `editor`. "the gateway's real pass order…": `null`. |
| B | LOW (wording; my own) | **The PROTOCOL sentence's last clause is literally false**, and the clause is mine from Round 2. "A revoke is never hidden longer than it would be without the cache" fails for a user who had no connection open at the revoke: without the cache, their new hello is refused at once; with it, they are admitted for up to 30 s. **Replace with:** "The cache never hides a revoke past the next timed pass." The rest of the sentence is accurate, including "at most 30 s" (MEDIUM 0's fix). | Round 1 finding 5 (the same behaviour change); the boundary test below. |
| C | LOW (doc) | **The roleCache header comment is stale.** It still says an entry lives until "`ttlMs` after the read began, and the soonest `expiresAt`…". It doesn't mention the link-memo cap, which the `ttlMs` JSDoc now describes. | tenancy.js, the comment block above `roleCache`. |
| D | LOW (test gap) | **Two parts of the cap are guarded only by my scratch tests:** taking the min over all links (C2), and a joiner using the original read's start (C3). | Mutation table below. |

### MEDIUM 0, checked with my own tests (`p5l2bv.test.js`, 5 tests, in p5-load2v.tests.txt)

- **Boundary:** A's hello memoizes the link at T0; then `revokeLink` with the message lost.
  - B's first hello at T0 + 29.999 s is `editor`, and again from the cache.
  - At T0 + 30 s and T0 + 30.001 s, B and A are both `null`.
  - The bound is exact: `until` = memo start + 30 s, and both checks are strict (`>`).
- **Several links:** l1 (editor) memoized at T0, l2 (viewer) memoized at T0 + 20 s. B uses both; l1 is revoked with the message lost.
  - B is `editor` at +25 s and at +29.999 s.
  - B is `viewer` from +30 s: l1 is re-read as revoked, while l2's memo still holds. The cap is the min over all links.
- **Joined read:** B joins A's link read, which began at T0, at T0 + 10 s. B's entry still ends at T0 + 30 s.
- **Code read:** fresh reads, joined reads (`from = flight.t`) and memo hits (`hit.until`) all stamp the same memo end.
  - The stamp sits on the `structuredClone` that `resolve` receives, in a `WeakMap`.
  - The `rolesFor` path reads `links(board)` raw (not memoized), so it needs no cap.
  - The JSDoc claim ("with `linkTtlMs ≤ ttlMs` a role is never served from data more than `ttlMs` old") holds: served < memo start + `linkTtlMs`.

### Mutations (scratch copy `mut2b`, restored from the tree after each; `cmp` clean)

| Mutation | Builder's role-cache.test.js | My p5l2bv |
|---|---|---|
| none | 17 pass | 5 pass |
| C1: cap line removed from `resolve` | **"chained TTLs" fails** | 3 fail |
| C2: cap by the last link only | pass | "several links" fails |
| C3: a joiner capped by its own start (`from = t`) | pass | "joined read" fails |
| M8: `invalidate(board, user)` drops only the first identity | **the two-identity test fails** (LOW 3 fixed) | — |

### Scope and regression

- **Builder's diff since my Round 2 copy:**
  - tenancy.js: the cap (`recordUntil`, `linkUntil`, `mark`, `from`, `ttlOf`) and the JSDoc only.
  - role-cache.test.js: the LOW 3 assertions and "chained TTLs" only.
  - Nothing else in either file moved.
- **Other changed files** (gateway.js, registry/postgres.js, pg-registry, sqlite-registry-open, tune, v1, wire tests): other sessions' work. None mentions `roleCache`, `rolesFor`, `identityKey`, `recordUntil` or `linkUntil`, and none touches the pg link paths.
- **PROTOCOL.md:**
  - Its uncommitted diff has no cache wording.
  - It was last modified at 08:58, before Round 2b's edits (09:04).
- **Round 2 checks still hold:** my 9 adversarial tests pass; key equality, identities, eviction and invalidate are unchanged.

### Gates

- **Full `bun test`:** 1157 pass, 131 skip, 3 fail.
  - `packages/core is still herdr-draw's core`: known.
  - `cap: a slot frees: the next automatic try gets in…`: test/web/collab/wire2.test.js.
  - `frame: my selection goes out whenever it changed…`: same file.
  - **The two wire2 failures aren't this job's.** The file was modified at 09:10 by a web session, after Round 2b, and it fails alone too (16 pass, 1 fail). It doesn't import tenancy.
- **Not run:** `DATABASE_URL`, because this round touches no pg path.
