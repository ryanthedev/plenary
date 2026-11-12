# Report: p5-load (Registry load at 100k joins: p-audit F4 and F8)

Builder report to manager platform (t187). Date 2026-11-12. Not committed.

## Summary

- **F4 fixed now** in my `announcingRegistry` hunk: a share-link redemption no longer publishes on `grants`.
  - **What it stops:** a whole-board re-check on every gateway for every redemption.
  - **Measured redemption cost:** 4 Registry queries before (`tenancy.redeemLink`'s link read, plus the wrapper's
    link read, `addLinkUse` and a board read), now **2** (link, `addLinkUse`).
- **F8 built and tested, but not wired yet.**
  - **What exists:** a role cache plus a batched lookup in `server/auth/tenancy.js`, and an optional Registry batch
    method `linkUsesFor`.
  - **Why it isn't live:** turning it on needs `gateway.js`, `server/auth/port.js` and `main.js` wiring, which I don't
    own. Without the gateway calling `invalidate`, a revoke would be hidden for up to the cache's TTL.
  - **What engine applies:** `docs/m2/reports/p5-load.patch`. It applies cleanly to the current tree
    (`git apply --check`); applied to a fresh copy, the related suites give 274 pass, 0 fail.
- **Query counts with the patch** (the gateway's own board read included):

  | Path | Before | After |
  |---|---|---|
  | Timed re-check, 1,000 users | 4,750 | **4** (about 1,005 on SQLite/Postgres until engine adds `linkUsesFor`) |
  | Warm hello | 6 | **1** |
  | Cold hello in a join wave | 6 | **4** |
  | Redemption | 4 | **2** (4 the first time per link per process) |

- **Tests:** full `bun test` gives **1086 pass, 113 skip, 1 fail**. The failure is not mine:
  `test/core-source.test.js` compares against the sibling herdr-draw checkout, which has uncommitted edits in
  `core/editor.js` and `core/geometry.js` that appeared during my run. The baseline at the start was 1063 pass, 0 fail.

## What changed (my files)

| File | Change |
|---|---|
| `server/main.js` (`announcingRegistry` hunk only) | `addLinkUse` is no longer wrapped (passes through, announces nothing). Doc comment says why. |
| `server/auth/tenancy.js` | Pure `combine(rows, identity, t) → { role, until }` (the one rule). `tenancy` gains `resolve`, `resolveMany` and `rolesFor(board, identities) → Map<user, role\|null>`, which reads the board's rows once. New `roleCache({ registry, now, ttlMs = 30 s, recordTtlMs = 60 s, maxEntries, maxRecords })`: `role`, `rolesFor` (fresh, written through), `invalidate(board, user?)`, `board` (memoized), `stats`. `USE_CHUNK = 1000`. |
| `server/auth/registry-port.js` | Optional `linkUsesFor(board, users) → Promise<Map<user, linkIds[]>>`, with its contract in the header. |
| `server/auth/registry.js` | `linkUsesFor` in the memory adapter. |
| `test/auth/registry-contract.js`, `test/auth/registry.test.js` | A `linkUsesFor` contract test, run when the caller passes `{ batch: true }` (memory does). |
| `test/auth/role-cache.test.js` (new) | 14 tests, listed below. |

**Why the cache lives in `tenancy.js`, not a new file:** engine's `test/architecture.test.js` treats every file in
`server/auth/` as an adapter unless its `NOT_ADAPTERS` lists it. A new core file would need an edit to engine's test.
Both architecture tests pass unchanged.

## F4: the choice and its evidence

**Choice: stop announcing on `addLinkUse` now; announce `{ board, user }` once the cache is wired (in the patch).**

The brief's question was whether a user who redeems while already connected needs the upgrade pushed. They don't:

- **Redemption only adds access, and only for the redeemer.** `tenancy.redeemLink` records a use;
  `server/auth/http.js:276` (OIDC callback) and `:378` (`GET /links/:link`) then send the browser to the board, whose
  new hello reads the role.
- **No cache, no need to announce:** that new hello reads the Registry fresh.
- **Other open sockets:** any other socket the redeemer has open keeps its lower role until the next timed pass
  (≤ 60 s), which closes it with "role changed: reconnect" (1012). Today the announcement did that at once.
- **The only loss is a ≤ 60 s delay on an upgrade.** No revoke depends on this message.
- **Old nodes:** this is a publisher-side change only, so it is safe with any gateway version.

**Once the cache is wired, an announcement is needed again.** Without it, a redeemer whose lower role (for example
`memberRole` viewer) is cached on another node would get that lower role on their next hello for up to the TTL. So the
patch announces `{ board, user }` on `addLinkUse`, with link-to-board and board-to-tenant memoized in the wrapper
(neither can change under the port), so a redemption wave costs no extra reads.

**What `{ board, user }` means: "this user's access only rose; drop their cached role; NO re-check."** This differs
from the brief's example ("re-check only that user's sockets"). It is cheaper and needs no per-user socket index in
the gateway. A patched gateway, on `{ board, user }`:

- drops only that user's cached role;
- runs no re-check pass;
- does not bump the hello generation.

**Caution for anyone extending this:** a future change must never send a revoke as `{ board, user }`. It would be
silently skipped until the next timed pass. So `setGrant` stays `{ board }`.

**Order constraint for engine:** apply the announcement and the gateway handling together, as the patch does. An
unpatched gateway reads `{ board, user }` as a whole-board message: correct, but F4's cost comes back.

## F8: design (systems-design skill, APPLIER mode)

**Scope.** The brief plus the NFRs in CLAUDE.md:

- 100k live viewers per board, and 100k joins in 2 min (≈ 833 hellos/s).
- A 60 s timed role re-check (PROTOCOL.md § Auth).
- A revoke must never be hidden longer than today's bound.
- Bus: at-most-once, exact subjects, no wildcards (`server/bus/memory.js`).
- Registry: read-your-writes (`registry-port.js`).

**Estimate** (from the measured counts below):

| Load | Before | After (patch + engine's `linkUsesFor`) |
|---|---|---|
| Joins (833 hellos/s) | 6 queries per hello, ≈ 5k qps | 4 per cold hello, ≈ 3.3k qps (1 per warm hello) |
| Timed pass (100k users / 60 s) | 4.75 queries per user, ≈ 7.9k qps | 4 queries per 1,000-user chunk, ≈ 7 qps |
| Timed pass without `linkUsesFor` (SQLite/Postgres today) | — | ≈ 1.7k qps |

**High-level shape.** One cache per gateway process; no shared cache tier. The `grants` bus subject is the
invalidation feed. The timed pass is the safety net for lost messages, so it always reads fresh.

**Deep dive 1: cache consistency.** Each rule below has a test:

- **Role entries:**
  - **What's stored:** per (board, user), keyed also by email and domain. A refusal (null) is never cached.
  - **Lifetime:** `min(start of read + ttlMs, soonest expiresAt of every live invite or link the answer used)`, so an
    expiry with no message is exact.
  - **Size bound:** `maxEntries`, oldest dropped first.
- **Record memo:**
  - **Board and tenant:** memoized because the port has no update method for them.
  - **Links by id:** memoized because `revokeLink` announces `{ board }`, which drops them. `live()` runs on every
    use.
  - **Single-flight:** concurrent reads of one record share a single query. A reader joins an in-flight read only if
    nothing was invalidated since that read began (the advisor found that hole; a mutation check confirmed the test
    fails without the fix).
  - **Not memoized:** null results and errors.
- **No stale refill:** a read in flight across an invalidation never fills the cache.
  - **Stamps:** per board and per (board, user), so per-user invalidations don't starve the rest of the board.
  - **Bound:** user stamps are capped at 10,000 (`STAMP_MAX`); past that, the whole board is stamped, which is coarser
    but never staler. All stamps clear whenever no read is in flight.
- **Write-through on the timed pass:** the pass calls `invalidate(board)`, then `rolesFor` per chunk. Each call is
  fresh and written through for its users, and also stamps them, so a slower hello read can't overwrite it (tested).
  The board ends the pass holding only what the pass read.

**Deep dive 2: the batched lookup.** `rolesFor(board, identities)` makes these Registry calls:

- `board` and `tenant` (memoized);
- `grants(board)` once;
- `invites(board)` once, only if anyone has an email (matched with `normEmail`, as `invitesFor` does);
- `linkUsesFor` per chunk of 1,000 users, or `linkUses` per user as the fallback;
- `links(board)` once, only if anyone has a use.

`role` and `rolesFor` share `combine`, and a differential test (25 random registries × 30 users) checks that `role`,
`rolesFor` (batch and fallback) and the cache agree.

**Why chunk in the gateway:** chunking at 1,000 users, with a `breathe()` between chunks, keeps one pass from holding
the event loop (awaiting synchronous `bun:sqlite` work does not yield). The cost is `ceil(users / 1000) × 4` queries
per pass.

### How stale a role can be, and why that is safe

| Case | Today | With the cache (patch applied) |
|---|---|---|
| Revoke, `grants` message delivered | Next pass (seconds) | Same. The gateway calls `invalidate` synchronously in its subscriber, before `gen++` and the pass, so the hello re-ask and the pass read fresh. |
| Revoke, message lost (at-most-once) or not yet on another node | ≤ 60 s + 14 s (timed pass plus retries) | Same bound. Every timed pass starts with `invalidate(board)`, reads fresh, and bumps the board's hello generation. So a hello that read a stale entry and is still waiting asks again from the Registry (advisor point), and any cached entry is at most one pass old. TTL (30 s) caps it further. |
| Board with no live socket on this node | No state | No state: the patch drops the board's entries when the gateway releases its `grants` watch, because no invalidations arrive after that (tested). |
| Invite or link expires (no message) | ≤ 60 s + 14 s on live sockets; next hello exact | Same; the next hello is still exact. |
| Across nodes | Each node reads the Registry | Each node has its own cache and its own invalidations. Read-your-writes in the Registry means a read after `invalidate` sees the write. |

A revoke still closes the socket the same way: PROTOCOL.md's re-check rules are unchanged; only where the role comes
from changes.

**Wrap-up.**

- **Bottlenecks left:**
  1. Cold hellos at 4 queries each (the gateway's board read, grant, invitesFor, linkUses).
  2. `grants(board)` and `invites(board)` return the whole board's rows on every chunk (a board with tens of
     thousands of explicit grants would want `grantsFor(board, users)`).
  3. The per-user fallback until engine adds `linkUsesFor`.
- **Failure:** an outage is never cached. Hellos get `unavailable`. A batch error fails the whole chunk under today's
  rules: grants passes fail closed; timed passes keep and retry, and stop after 3 errors in a row.
- **Monitoring:** `roleCache().stats()` (hits, misses, fills, discarded, record hits) is not on `/health` yet; that is
  engine's call.
- **At 10×:** add `grantsFor`, and give the gateway the cache's memoized `board` (below).

## Query counts (counting Registry wrapper, `test/auth/role-cache.test.js`)

Fixture: 1,000 users on one board (500 Workspace members, 250 email-invite guests, 250 guests via one shared link,
50 explicit grants). These counts are the role lookup only: add 1 to every hello row for the gateway's own
`registry.board`.

| Case | Before (`tenancy.role`) | After (`roleCache`) |
|---|---|---|
| Hello, link guest, cold, board's first | 5 | 5 |
| Hello, link guest, cold, board already memoized | 5 | **3** |
| Hello, Workspace member, cold, board memoized (first tenant read) | 5 | 4, then 3 |
| Hello, same user again (warm) | 5 | **0** |
| Timed pass, 1,000 users, Registry with `linkUsesFor` | 4,750 | **4** |
| Timed pass, 1,000 users, no `linkUsesFor` (SQLite/Postgres until engine patches) | 4,750 | 1,005 |

**Redemption** (`tenancy.redeemLink` through `announcingRegistry`):

| Code | Queries per redemption | Extra effect |
|---|---|---|
| Before (git HEAD) | 4: link ×2, addLinkUse, board | A whole-board pass on every gateway |
| Now (my hunk) | 2 | None |
| With the patch | 4 the first time per link per process, then 2 | One map delete per gateway |

The "before" row was measured with HEAD's `main.js`.

**Possible next step (not in the patch):** in `main.js`, give the gateway `{ ...registry, board: cache.board }`.
That makes the warm hello 0 queries and the cold hello 3.

## Tests added (`test/auth/role-cache.test.js`, 14)

1. **Revoke then invalidate:** a revoke, then `invalidate(board, user)` or `invalidate(board)`, gives null.
2. **Lost message:** `rolesFor` is fresh; `invalidate` + `rolesFor` evicts users not read; with no pass, the TTL ends
   it to the millisecond.
3. **Expiry with no message:** an entry and a memoized link stop granting at `expiresAt`.
4. **Revoked link:** `revokeLink` + `invalidate(board)` drops the memoized link record.
5. **In-flight read vs invalidation:** the read is discarded; a per-user invalidation keeps other users' fills.
6. **Single-flight hole:** a reader starting after an invalidation never joins an older link read (mutation-checked).
7. **Write-through vs slow hello:** a hello read in flight during `rolesFor` never overwrites the write-through.
8. **What isn't cached:** null is not cached; an email or domain change misses; errors are not cached.
9. **Size bound:** `maxEntries`.
10. **Differential:** random registries; `role`, `rolesFor` and the cache agree.
11. **`rolesFor` basics:** unknown board, dedup, `USE_CHUNK` chunking.
12. **F4:** `addLinkUse` and `redeemLink` publish nothing; the other 4 writes publish `{ board }`.
13. **Redemption cost:** 2 queries.
14. **Query counts.**

The `linkUsesFor` contract test is in `test/auth/registry-contract.js`.

## Patch for engine: `docs/m2/reports/p5-load.patch`

It touches 11 files.

- **`server/gateway.js`:**
  - **Subscriber:** the `grants` subscriber calls `auth.invalidate?.(board)` before `gen++`; `{ board, user }` means
    invalidate that user only, with no pass and no `gen++`.
  - **Release:** releasing a board's watch calls `auth.invalidate?.(board)`.
  - **New limit:** `recheckBatch: 1000`.
  - **`recheckPass`:** when `auth.rolesFor` exists, it calls `invalidate(board)`, bumps the board's watch `gen`, then
    makes one `rolesFor` per chunk.
  - **Bug fixed during testing:** each concurrency batch is now capped at the chunk's end. Without the cap, a batch
    ran past the chunk and closed users wrongly; my gateway test caught it.
  - **Errors** follow today's rules; without `rolesFor`, the code is unchanged.
- **`server/auth/port.js`:** `authPort` passes `rolesFor` and `invalidate` through when the tenancy has them.
- **`server/main.js`:**
  - `auth = authPort({ …, tenancy: roleCache({ registry, now: Date.now }) })`. HTTP routes keep the plain `tenancy`.
  - `addLinkUse` announces `{ board, user }`, with link-to-board and board-to-tenant memoized (bounded at 10k).
- **`server/registry/sqlite.js`:** `linkUsesFor` binds the users as one JSON array (`json_each(?)`).
- **`server/registry/postgres.js`:** `linkUsesFor` with `jsonb_array_elements_text($2::text::jsonb)`. Plain
  `$2::jsonb` fails because Bun's client sends the string as a JSON scalar.
- **Tests:**
  - `test/server/registry.test.js` and `pg-registry.test.js`: `batch: true` on the SQLite and both Postgres contracts.
  - `test/server/rig.js`: a `cache` option, plus `rolesFor`/`invalidate` passed through and counted in `r.cacheCalls`
    (`r.calls` is unchanged).
  - `test/server/revocation.test.js` M1: the injected failure also covers `rolesFor`, because the default rig now
    takes the batched path.
  - New `test/server/role-cache.test.js`, 4 tests: warm hello cached and a `{ board }` revoke still closes and refuses;
    `{ board, user }` runs no pass and the next hello gets the new role; cached roles go when the last socket closes;
    the timed pass uses `rolesFor` in chunks and closes a lost-message revoke.
  - `test/auth/role-cache.test.js`: the F4 test expects `{ board, user }`.

**How I checked the patch:**

- **Patch file on a fresh copy:** applied to a fresh copy of the current tree, the related suites (`test/auth`, the
  new server test, revocation, tune, gateway, v1, registry, `test/architecture.test.js`) give 274 pass, 0 fail.
- **Postgres:** SQLite and Postgres contracts, including the runtime-role (least-privilege) one, give 72 pass on a
  throwaway local Postgres 17 (free port, PID recorded, stopped after).
- **Full suite with an earlier version of the patch:** the only failures were 4 in `web/`. They failed identically
  without the patch: another session was mid-edit in `web/` when I copied.

### Proposed PROTOCOL.md text (I don't own it)

- **Now (my hunk), § Bus `.grants`:** "A share-link use is not announced (it only adds access, for the redeemer,
  whose next hello reads it); their other open connections take the new role on the next timed re-check."
- **With the patch, replacing that:** "… `{ board }`; or `{ board, user }` when only that user's access ROSE (a
  share-link use): a gateway drops its cached role for that user and does not re-check. A revoke is never sent as
  `{ board, user }`."
- **§ Auth, Re-checking:** "A gateway may cache roles for hellos. Each timed pass drops the board's cached roles and
  reads the Registry, so caching never extends the bounds above."
- **§ Registry table:** add `linkUsesFor(board, users) → Map` (optional batch).

## Not verified

- **Real load:** no 100k-hello or multi-node run. The counts come from a counting wrapper over the memory Registry;
  the qps figures are arithmetic from them.
- **NATS:** the patch's gateway behaviour was tested on the memory bus only.
- **Pass CPU time:** not measured for 100k users through `rolesFor`.

## Risks

1. **Wiring order:** if `roleCache` is wired without the `gateway.js` invalidation, revokes are hidden for up to 30 s
   plus one pass. Don't split the patch.
2. **Revokes on the per-user message:** `{ board, user }` means no re-check, so a revoke sent that way would be skipped
   until the timed pass. See the caution under F4.
3. **Default rig path:** with the patch, rigs built on plain `tenancy` take the batched pass. Tests that inject
   failures through `wrapAuth` with `...a` must also wrap `rolesFor`.
4. **Per-chunk full-board reads:** `grants(board)` and `invites(board)` are re-read per chunk. For boards with very
   many explicit grants, add `grantsFor`.
5. **Hello generation:** a `{ board, user }` message doesn't bump it, so a redeemer's hello in flight may go live with
   the lower role until the next timed pass (an upgrade delay only).

## Round 2 (p5-load2, fix round; scope cut by t187 mid-round)

t187 narrowed this round because engine's `gateway.js` is still mid-edit (p2-tune r2):

- **Done now, in my files only:** steps 1, 2 (GAP-M3 only), 3, 6 and 7.
- **Pending (below):** steps 4–5 (the patch re-cut and its gates) and the gateway gap tests (GAP-M4, GAP-M6, M7).
- **Base recorded for the re-cut:** `git hash-object server/gateway.js` = `30cdfcf3a70e904ae60f5df27a8c370b8777a53a`
  (main tree, uncommitted, at the start of this round). It may have moved since.

### What changed

| File | Change |
|---|---|
| `server/auth/tenancy.js` | **Finding 2 (step 1):** new export `identityKey(id)` = `` `${id.user}\n${id.email ?? ""}\n${id.domain ?? ""}` ``, engine's exact key (gateway.js:590–591, confirmed by t187), for the gateway to import rather than re-spell. Details below. |
| `server/auth/tenancy.js` | **Finding 6 (step 3):** the record TTL is split. Details below. |
| `test/auth/role-cache.test.js` | **GAP-M3** adopted verbatim from `p5-loadv.tests.txt`. **New two-identity test.** Lookups now use `identityKey`. 16 tests. |

**Step 1, identity keying:**

- **`resolveMany` and `rolesFor`** (plain and cached) answer per identity key, not per user. Link uses are still
  fetched once per distinct user (they don't depend on email or domain).
- **Cache entries** are keyed by board + `identityKey`, so two identities of one user are cached side by side.
- **`invalidate(board, user)`** drops every identity of that user (a per-(board, user) index).
- **Stamps** stay per (board, user): coarser than per identity, so never staler.
- **`rolesFor` write-through** computes `moved` for all identities before stamping any, so one identity's stamp doesn't
  mark the call's other identities as moved.

**Step 3, record TTLs:**

- **Board and tenant records:** `recordTtlMs` default is now 10 min (was 60 s), above the 60 s pass, so a
  steady-state pass costs 4 queries, not 6.
- **Link records:** a separate `linkTtlMs`, default 30 s, because a link changes on `revokeLink`.
- **If a future port adds an update or delete** (for example `setMemberRole`, `deleteBoard` or a tenant domain
  change), that write must:
  - announce `{ board }` (every board of the tenant, for a tenant change);
  - and `invalidate(board)` must then also drop the board and tenant records. Today it drops roles and links only.
  - The JSDoc of `roleCache` says this.

### Tests and checks

- **Two-identity test:** one user, one identity with an invited email (`editor`) and one without (`null`). Both
  answers come back from `tenancy.rolesFor`, the per-user fallback (no `linkUsesFor`) and `roleCache.rolesFor`, in
  both orders.
  - `cache.role` gives each its own answer, and both are cached side by side (2 hits).
  - `invalidate(board, user)` drops both.
  - It also asserts `identityKey` spells a missing domain as `''`.
- **Mutations** (applied one at a time, restored, `cmp` clean):

  | Mutation | Result |
  |---|---|
  | M3: write-through ignores `moved` | GAP-M3 fails (1 fail) |
  | `identityKey = id => id.user` (the collapsed key of finding 2) | The two-identity test fails, plus "another email or domain misses" (2 fail) |

- **Full `bun test`:** 1135 pass, 125 skip, 1 fail:
  `(fail) packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)`. Not this job: the sibling
  herdr-draw checkout has uncommitted edits in `core/editor.js` and `core/geometry.js`, as in round 1. `test/auth` is
  172 pass, 0 fail.

### Pending (waiting for engine's commit id from t187)

- **Step 4, the re-cut of `docs/m2/reports/p5-load.patch`** onto engine's committed `gateway.js`, following the
  verifier's merge plan:
  - keep engine's `rc.cut` check before the chunk fetch;
  - feed a chunk error into engine's `ok[]` and `sum.errors` accounting and its "registry down" early stop;
  - bound `rolesFor` with `recheckLookupMs`, as `roleWithin` does (finding 1), then re-run `p5v-hang`;
  - group by and look up with `identityKey(g.identity)`, importing it from `tenancy.js`. The map from `rolesFor` is
    now keyed that way, so `roles.get(g.user)` would return `undefined`, which reads as null and closes the
    connection: the re-cut must use the key.
- **Step 4 gateway gap tests:** GAP-M4 and GAP-M6 (from `p5-loadv.tests.txt`), plus a new test catching M7 (the
  pass-start `w.gen++` removed), each confirmed failing under its mutation.
- **Step 5 gates:**
  - `git apply --check` on a copy of the tree;
  - full `bun test` on scratch (tree + patch), with and without `DATABASE_URL` (Podman Postgres), every failure named
    and compared to the unpatched tree;
  - the p5-loadv revocation table re-run on the merged gateway.
- **The current `p5-load.patch` is stale:** it was cut from `f1ee465`, and its gateway hunk uses `roles.get(g.user)`,
  which no longer matches the identity-keyed `rolesFor`. Engine must not apply it.

### Finding 5: proposed PROTOCOL.md sentence (step 6; I don't edit PROTOCOL.md)

For § Auth, Re-checking live connections, after the timed-pass bullet:

> "A gateway may answer a hello's role from a per-gateway cache. If a `grants` message is lost, a NEW connection may
> therefore be admitted with the old role until the gateway's next timed re-check, which reads the Registry fresh and
> treats the connection like any other live one, or until the cache entry's life ends (at most 30 s), whichever is
> first. The cache never hides a revoke past the next timed pass."

(Updated in Round 2b to p5-load2v's wording. Three things to note:

- **Not live yet:** this describes the cache once the re-cut patch wires it in.
- **"At most 30 s"** holds after Round 2b's link-memo cap.
- **"Like any other live one":** a connection already admitted follows the live-connection rules. If that pass's
  Registry read fails, it is kept and retried, 2/4/8 s.)

### Design check (step 7; distributed-systems-design, APPLIER, short)

- **Time bound (finding 1; applies at the re-cut):**
  - **Rule:** every Registry wait on the revocation path must be bounded. A pass holds its board's one pass chain, so
    an unbounded `rolesFor` blocks the queued `grants` pass, and with it every revoke on that board.
  - **What the bound buys:** with `rolesFor` raced against `recheckLookupMs` (2 s), a hung Registry costs at most
    2 s per chunk. A chunk error becomes per-identity errors in engine's accounting: a grants pass fails closed; a
    timed pass keeps and retries; the first-batch "registry down" check stops the pass.
  - **Cost:** a chunk of 1,000 that times out fails 1,000 identities together, where per-user lookups would fail them
    one by one. That is acceptable: a Registry that can't answer one board query in 2 s can't answer per-user queries
    either.
  - **Abandoned reads:** a late `rolesFor` that settles after its timeout must not write through. It doesn't, if the
    pass calls `invalidate(board)` again on timeout (stamps the board). Do that in the re-cut.
- **Per-identity keying (finding 2, done):**
  - **Why:** a role is a function of (user, email, domain), so the cache key, the batch key and the gateway's grouping
    key must be one function. Exporting `identityKey` from core and importing it in the gateway removes the
    two-spellings hazard that caused finding 2.
  - **Cost:** two identities of one user mean two cache entries. Bounded by `maxEntries`; rare in practice.
  - **Invalidation:** stays per (board, user) (a revoke names a user, not an email), via the per-user index.

## Round 2b (p5-load2b: verifier p5-load2v PASS, one MEDIUM)

**Files touched:** `server/auth/tenancy.js`, `test/auth/role-cache.test.js`, this report.

| Item | Change |
|---|---|
| **MEDIUM 0, option (b)** | A role entry's `until` is capped at the end of the memo of every link record it was built from. The cache stamps each link record it hands out with that record's memo end (a `WeakMap`). `tenancy` gains an optional `recordUntil(record)` hook (default `Infinity`), and `resolve` caps its `until` by it. **Result:** a new hello after a lost link revoke is admitted for at most `ttlMs` (30 s; `linkTtlMs` 30 s ≤ `ttlMs`), not ~60 s. Board and tenant records are not capped: the fields read from them never change. The `rolesFor` path reads `links(board)` fresh, so it needs no cap. The `ttlMs` JSDoc now says what the bound is counted from, and that it holds with `linkTtlMs ≤ ttlMs`. |
| **LOW 3** | The two-identity test now caches three entries (two of gus, one of ann). After `invalidate(board, "google:gus")` it asserts `stats().entries` = 1, that both gus identities miss, and that ann's entry is still a hit. |
| **LOW 2** | The `recordTtlMs` JSDoc names the four fields the cache reads (`board.id`, `board.memberRole`, `board.tenant`, `tenant.domain`) and says they never change. It also says `tenant.admins` does change at runtime (`addTenantAdmin`, add-only), and must never be served from this memo; admin checks read the Registry. |
| **LOW 5** | The proposed PROTOCOL sentence (Round 2, finding 5) now uses p5-load2v's wording, with "at most 30 s" and the live-connection qualification. PROTOCOL.md is not edited. |
| Not in scope | LOW 1 (a newline inside two identity fields could collide keys): it must change together with engine's gateway key. |

**New test, "chained TTLs" (p5-load2v's shape, as assertions):**

1. A's hello memoizes the link record at T0.
2. `revokeLink` is called, and the `grants` message is lost.
3. B's first hello at T0 + 29 s is `editor`: it rides the 29 s old memo.
4. At T0 + 30.001 s, B and A are both `null`. Without the cap, B stayed `editor` until T0 + 59 s.

**Mutations** (one at a time, then restored; `cmp` clean):

| Mutation | `test/auth/role-cache.test.js` |
|---|---|
| Cap removed (no `recordUntil` in `resolve`) | 1 fail: "chained TTLs" |
| M8: `invalidate(board, user)` drops only the first identity | 1 fail: the two-identity test |

**Gates:**

- `bun test test/auth`: 175 pass, 0 fail.
- Full `bun test`: 1143 pass, 131 skip, 1 fail:
  `(fail) packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)`. That is the known
  unrelated failure: the sibling herdr-draw checkout has uncommitted `core/` edits.

**Still pending (from Round 2):** the patch re-cut onto engine's committed `gateway.js`, and the gateway gap tests
GAP-M4, GAP-M6 and M7, waiting for engine's commit id from t187.

## Round 3 (p5-load3: patch re-cut onto engine's a90cd6b; LOWs A–D)

### Patch: `docs/m2/reports/p5-load.patch`

Re-cut against HEAD `a90cd6b` (`server/gateway.js` blob `a22f1fb`, the same as the tree), on top of this round's
platform files (`tenancy.js` and `role-cache.test.js`, uncommitted in the tree). It touches 11 files.

**`server/gateway.js`.** Engine's batching (`recheckConcurrency`), `rc.cut`, per-user errors (`sum.errors`, `ok[]`,
`failed()`/retry schedule), the "registry down" stop and count-only `here` are all kept as they are.

- **Key:** imports `identityKey` from `./auth/tenancy.js` and groups by it; the inline spelling is gone. Each group
  carries its `key`.
- **New limit:** `recheckBatch: 1000`.
- **New `rolesWithin(identities, board)`:** `auth.rolesFor` bounded by `recheckLookupMs`, the same race as
  `roleWithin`, counted in `rechecks.timeouts` (finding 1).
- **`grants` subscriber:** `{ board }` calls `auth.invalidate?.(board)` before `gen++`. `{ board, user }` calls
  `auth.invalidate?.(board, user)` and returns: no pass, no `gen++`, never a revoke.
- **`unwatchGrants`:** releasing a board's last watch calls `auth.invalidate?.(board)`.
- **`recheckPass`, when `auth.rolesFor` exists:**
  1. At the start: `auth.invalidate?.(b.board)` (LOW A) and the board watch's `gen++` (M7).
  2. Per chunk: after engine's `rc.cut` check, one `rolesWithin` per `recheckBatch` identities. A chunk error or
     timeout becomes that chunk's per-identity error inside engine's `one()` (`sum.errors`, `ok[]`, fail closed on
     grants, keep and retry on timed, the "registry down" first-batch stop), and calls `invalidate(board)` so a late
     answer can't write through.
  3. Answers are looked up with `roles.get(g.key)`. Concurrency batches never run past the chunk read.
- **Without `rolesFor`:** the code is engine's, unchanged.

**The other files** (same content as the round 1 patch, re-applied cleanly to a90cd6b):

| File | Change |
|---|---|
| `server/auth/port.js` | Passes `rolesFor` and `invalidate` through. |
| `server/main.js` | `roleCache` wired for hellos; `addLinkUse` announces `{ board, user }`, with link-to-board and board-to-tenant memoized. |
| `server/registry/sqlite.js`, `postgres.js` | `linkUsesFor`. |
| `test/server/registry.test.js`, `pg-registry.test.js` | `batch: true`. |
| `test/server/rig.js` | `cache` option, `cacheCalls`. |
| `test/server/revocation.test.js` | M1 also fails `rolesFor`. |
| `test/auth/role-cache.test.js` | F4 test expects `{ board, user }`. |
| `test/server/role-cache.test.js` (new) | 8 tests, below. |

**Key-equality test not added:** no second spelling of the key remains (`grep` for the inline template in
`server/` and `test/`: none), so the verifier's key-equality test is moot.

### Tests

- **`test/server/role-cache.test.js`** (in the patch), 8 tests:
  - warm hello served from the cache, and a `{ board }` revoke closes and refuses;
  - `{ board, user }` runs no pass;
  - cached roles go when the last socket closes;
  - chunked timed pass with no per-user calls;
  - **GAP-M4:** a new hello while a revoke waits behind a running pass is refused;
  - **GAP-M6 (LOW A):** a cached user who left, revoke lost: refused after one pass;
  - **M7 (new):** two hellos waiting on the room (one served from the cache) when a timed pass runs, revoke lost:
    both refused 1008;
  - **finding 1:** `rolesFor` hangs during a timed pass; a revoke still closes within 4 s; `rechecks.timeouts` ≥ 1.
- **`test/auth/role-cache.test.js`** (tree), 19 tests. New:
  - **C2 (LOW D):** several links; the entry ends at the oldest link memo.
  - **C3 (LOW D):** a joiner of an in-flight link read is capped from that read's start.
- **LOW C:** the `roleCache` header comment now says entries are keyed by `identityKey`, describes the link-memo cap
  (joiners count from the read's start), gives the record lifetimes (board and tenant 10 min with `admins` never
  served; links 30 s), and says `invalidate(board, user)` drops every identity.
- **LOW B:** the proposed PROTOCOL sentence (Round 2, finding 5) now ends "The cache never hides a revoke past the
  next timed pass." PROTOCOL.md is not edited.

### Mutations (one at a time, restored, `cmp` clean)

| Mutation | Result |
|---|---|
| M4: subscriber keeps the cache on `{ board }` | GAP-M4 fails |
| M6: no pass-start `invalidate` (LOW A) | GAP-M6 fails (and M7) |
| M7: no pass-start `gen++` | M7 fails |
| `rolesFor` unbounded (plain `auth.rolesFor`) | finding 1 test fails |
| Chunk overrun (concurrency batch not capped at the chunk) | "chunked timed pass" fails |
| C2: cap by the last link only | C2 fails |
| C3: a joiner capped from its own start | C3 fails |

The gateway mutations ran over `test/server/role-cache.test.js` and `revocation.test.js`; the tenancy mutations over
`test/auth/role-cache.test.js`.

### Gates

| Run | Result |
|---|---|
| `git apply --check`, clean worktree of HEAD + this round's platform files | Applies |
| `git apply --check`, main tree | Fails on `test/server/pg-registry.test.js` and `test/server/registry.test.js` only. Someone has uncommitted edits next to those `batch: true` lines (a new `busy_timeout` pragma test and pg-registry rework). Once those land, the two one-line hunks need re-applying (or `git apply -3`). The other 9 files apply to the tree as it is. |
| Full `bun test`, worktree (HEAD + platform files + patch), no `DATABASE_URL` | **1171 pass, 122 skip, 0 fail** |
| Same, `DATABASE_URL` = Podman Postgres 17.11 | **1262 pass, 34 skip, 0 fail**. The container (`c61457cd906d`) was mine, stopped with `--rm`, and is confirmed gone; no other container touched. |
| Full `bun test`, isolated worktree (HEAD + only this round's platform files) | **1162 pass, 120 skip, 0 fail** |
| `bun test test/auth`, main tree | Green (19 in `role-cache.test.js`) |
| Full `bun test`, main tree | 1157 pass, 135 skip, **48 fail**, run while other sessions had uncommitted edits in `server/room-host.js`, `packages/protocol/room.js`, `ports.js`, the stores, `gateway.test.js` and `revocation.test.js`. They are room, append, Store and catch-up tests, nearly all 5–30 s timeouts. The run took 867 s, against about 110 s isolated. **None is this job's:** the isolated run of HEAD + my files is 0 fail. The known core-source failure is in that list too; it can't run in the worktrees (no herdr-draw beside them). |

The 48 main-tree failures, verbatim (`bun test 2>&1 | grep -E '\(fail\)'`, durations cut):

```
(fail) packages/core is still herdr-draw's core (re-copy when herdr-draw's core changes)
(fail) H1: an annotator rewriting one note over and over leaves the board joinable, before and after a restart
(fail) H1: a tail bigger than any one frame arrives as bounded frames, in order, complete
(fail) H1 (round 3): a board bigger than a user's whole budget is joinable from scratch: a snapshot bigger than the share
(fail) H1 (round 3): a board bigger than a user's whole budget is joinable from scratch: a tail bigger than the share
(fail) H1 (round 3): a slow reader of a board bigger than its budget gets all of it; the server never owes it more than a socket's worth
(fail) H1: sockets that never read stay under the budget, are cut even while they send presence, and lock nobody else out
(fail) H1: non-readers spread over several accounts can't keep joiners out: the longest-stalled is cut to make room
(fail) a joiner that waits too long for room is told `unavailable`, not left hanging
(fail) M1: one writer's burst doesn't freeze the process: /health keeps answering all the way through
(fail) L5: a client refused by the room resyncs, and settled() waits for it (the helper's old race, made certain)
(fail) Store.read can stop a page by size (an extension to § Store), and reports each entry's stored size
(fail) a writer active during catch-up doesn't get a slow joiner (or its other tab) cut
(fail) trickle readers can't hold the budget against a joiner: the one too slow to ever finish makes way (needs python3: skipped without it)
(fail) a reader getting through its catch-up at a fair pace is left alone: the joiner behind it waits its turn
(fail) joiners parked across folds can't pin a board's worth of replaced text each: the longest-waiting are told to come back
(fail) R4-H2: a board whose snapshot is several times the old socket limit joins from since 0, with live traffic queued behind it
(fail) R4-H2: with the limit BELOW the snapshot, flush() holds frames behind it until the socket drains: nothing dropped
(fail) R4-H2: a frame over the socket limit (past the spec's caps) is still sent, and logged loudly once per text
(fail) the order is verify, then board, then role, then the room; the room gets {user, role, client} and never the token
(fail) slow auth: ops after welcome are acked in order and numbered per connection
(fail) bad frames get an error and/or a close, never reach a room, and never kill the process
(fail) rule 1: nothing is acked or broadcast before the append resolves
(fail) the entries subject carries each entry once, after it is durable
(fail) when the append rejects: no ack ever, everyone gets `unavailable`, and the room rebuilds from the Store
(fail) when the append conflicts: no ack ever, everyone gets `unavailable`, and the room rebuilds from the Store
(fail) when the append times out: no ack ever, everyone gets `unavailable`, and the room rebuilds from the Store
(fail) when the append times out and then lands late: no ack ever, everyone gets `unavailable`, and the room rebuilds from the Store
(fail) a room that throws: before logging, only the sender hears; after logging, the room is rebuilt and nothing is stored
(fail) lifecycle: sockets that close mid-auth or after hello leave no room connections behind
(fail) a log with a gap or a foreign entry is corruption: the room refuses to start, the server lives
(fail) H1: a 30,000-deep op is refused before it is parsed, nothing is stored, and joins stay fast
(fail) H1: catch-up is right for every `since`, and the same bytes go to every joiner
(fail) M1/M4: what waits behind a slow sign-in is bounded in bytes; 1,500 small unsent ops still get through
(fail) M5: a v0 `transient` op is refused, not relayed and not logged; an inbox gap closes the connection
(fail) L5: a Room that throws on a hello leaves no half-open connection
(fail) clients converge through the Room over real sockets, with drops and reconnects, and survive a server restart (seed 1)
(fail) clients converge through the Room over real sockets, with drops and reconnects, and survive a server restart (seed 2)
(fail) H1: grants removed while a hello waits on the room (the board's first connection) → refused `auth`, nothing logged
(fail) H1: a role changed while a hello waits → `unavailable` 1012 (reconnect); unchanged grants cost no second look
(fail) L2: a gap in the Store log is logged as an error and a new viewer is refused `unavailable`, not welcomed short
(fail) presence is relayed between two clients (not back to its sender) and never reaches the room, the log or a checkpoint
(fail) a resend after a server restart gets the same seq (rule 2 across restarts); nothing is logged twice
(fail) the bus cap: `.entries` batches are split under it in seq order, and an op too big for the inbox gets `too-large` with its id
(fail) § Pacing: over-rate ops wait in the gateway in order and are all acked; past the queue cap the connection gets `unavailable`
(fail) rule 6: a room forgets a gateway silent for 30 s (its clock), unless the gateway's 5 s connection lists keep it heard
(fail) a board feed picks up the host's checkpoint written just after the entries that triggered it (on the next heartbeat): a joiner from 0 gets that snapshot and only the entries after it
(fail) § Pacing: frames read from a live socket faster than they are handled are capped in bytes: past maxLiveQueuedBytes, `unavailable` and close
```

### Not verified

- **Real load and NATS:** no 100k run, and the gateway behaviour was not run over NATS.
- **The p5-loadv revocation table** was not re-run as a table. Its cases are covered by the gateway tests above
  (in-flight read, waiting tab, lost message, hung lookup) and `revocation.test.js`.

### For engine (when applying)

- **Apply order:** apply after manager commits this round's `tenancy.js` and `role-cache.test.js`.
- **`batch: true` hunks:** if the registry test rework lands first, re-apply the two one-line `batch: true` hunks by
  hand.
- **Keep the wiring together:** `roleCache` wiring (`main.js`) and the gateway invalidation must land together.

## Round 4 (p5-load4): patch re-cut onto 426757d, V1/V2 adopted, PROTOCOL sentence as a hunk

**Base commit:** `426757daef8f03275368cd926603cf17cf041b09` (HEAD). All work was done in a clean HEAD worktree in my
scratchpad. In the main tree, only this report and `docs/m2/reports/p5-load.patch` were written.

### What changed in the patch

- **Re-cut:** two hunks no longer applied, and I applied them by hand. Both add `batch: true`:
  - `test/server/pg-registry.test.js`: the runtime-role contract's options, which c2024f3 moved after a `try … catch`.
  - `test/server/registry.test.js`: the sqlite contract line. Its context changed: the pragmas test now also checks
    `busy_timeout`.
- **Behaviour unchanged otherwise:** I diffed the `+`/`-` lines of the old and new patches. The only differences are
  the PROTOCOL hunk and the V1/V2 tests. Every other hunk applied by offset only.
- **V1 and V2** are now at the end of `test/server/role-cache.test.js`, copied verbatim from
  `p5-load3v.adv.test.js.txt` with two adaptations: the duplicate `outcome` helper is dropped (the file already has
  an identical one), and V2 uses the file's own `publish` helper. That file now has 10 tests.
- **PROTOCOL.md hunk:** adds a "**Role cache.**" sub-bullet to § Auth, Re-checking live connections. It goes after the
  Errors sub-bullet, the last bullet on re-check timing, and carries the LOW B sentence verbatim (ending "The cache
  never hides a revoke past the next timed pass."). Engine and CEO decide whether to apply it.
- **Files (12):** PROTOCOL.md, server/auth/port.js, server/gateway.js, server/main.js, server/registry/postgres.js,
  server/registry/sqlite.js, test/auth/role-cache.test.js, test/server/pg-registry.test.js,
  test/server/registry.test.js, test/server/revocation.test.js, test/server/rig.js, test/server/role-cache.test.js
  (new).

### Apply checks

| Check | Output |
|---|---|
| `git apply --check`, fresh clean worktree of 426757d | Passes (rc 0, no output) |
| `git apply --check`, main tree (with other sessions' uncommitted edits) | Passes (rc 0, no output) |
| `git apply -3 --check`, main tree | Fails, but only with `error: test/server/revocation.test.js: does not match index`. The other 11 files report "Applied patch … cleanly". The failure comes from another session's uncommitted edits to `revocation.test.js`: `-3` needs the working file to match the index. The plain check passes, so this conflict is not textual. |

### Mutations (on the patched worktree, `server/gateway.js` restored after each, `cmp` clean)

| Mutation | Result over `test/server/role-cache.test.js` |
|---|---|
| None (baseline) | 10 pass, 0 fail |
| Drop `auth.invalidate?.(b.board)` from the chunk `catch` | **V1 fails** (`expect(received).toBe(expected)`); 9 pass |
| Drop `chunkErr = null` after a good chunk | **V2 fails** (`expect(received).toBe(expected)`); 9 pass |

### Gates (patched worktree)

The gated worktree's `git diff HEAD` is byte-identical (`cmp`) to the shipped `docs/m2/reports/p5-load.patch`.

| Run | Result |
|---|---|
| Full `bun test`, no `DATABASE_URL` | **1174 pass, 136 skip, 0 fail** (1310 tests, 113 s) |
| Full `bun test`, `DATABASE_URL` = Podman Postgres 17.11 | **1279 pass, 34 skip, 0 fail** (1313 tests, 131 s). The container (`1875fdeb8ef2`) was mine, started with `--rm` and stopped, and it is confirmed gone. No other container was touched. |

- **Worktree setup:** a scratch worktree has no `node_modules`. My first no-DB run therefore failed 3 NATS tests
  (`Cannot find module '@nats-io/transport-node'`), and unpatched HEAD failed the same 3 in the same worktree setup.
  After I linked the main tree's `node_modules`, they pass. They were never the patch's failures.
- **core-source:** `test/core-source.test.js` passes in the worktree (2 pass, run on its own), so the known unrelated
  failure did not show up this round.

### Not verified

- **The main tree:** I did not run tests on the main tree with the patch applied. In particular, I did not check that
  `test/server/revocation.test.js` passes with another session's uncommitted edits and this patch's hunk combined.
  The plain `--check` passing only means the hunk fits textually. I did not run NATS or real load.

### For engine (when applying)

- **Command:** `git apply docs/m2/reports/p5-load.patch` applied to the main tree at the time of this check. Other
  sessions are still editing `test/server/revocation.test.js`, so re-run `git apply --check` first.
- **Keep it whole:** the `roleCache` wiring in `main.js` and the gateway invalidation must still land together.
- **PROTOCOL.md:** drop the PROTOCOL.md hunk if engine and CEO decline the sentence.
