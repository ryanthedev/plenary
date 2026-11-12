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
