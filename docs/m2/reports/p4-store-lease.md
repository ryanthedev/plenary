# Report: p4-store-lease (phase 4, step 1: lease + epoch fence in the Store)

Worker t1gd, 2026-11-12. Nothing committed.

**Status: done, with one red test that isn't mine.**
- **Results:** 1083 pass without Postgres and 1165 pass with DATABASE_URL.
- **The one failure (both runs):** `test/core-source.test.js`. The sibling checkout `../herdr-draw/core` changed on
  disk, so its hash no longer matches SOURCE.json. Nothing under `packages/core` changed here.
- **Lease contract:** passes on both adapters.
- **Mutations:** all 28 were caught.
- **t18m's follow-up (done):** start-up no longer ALTERs, it has a `lock_timeout`, and it wraps the privilege error.

## What changed

| File | Change |
|---|---|
| `server/store/sqlite.js` | `leases` gains `holder` and `expires_at`. Adds `acquire`, `renew`, `release`, `lease`, and an injected `now` (the lease clock, default `Date.now`). `append` and `putCheckpoint` take an optional `epoch`, checked inside their `BEGIN IMMEDIATE` (`fenced`). An old epoch-only `leases` table gets its columns via `ALTER` at open (single node: the process owns the file, no roles). |
| `server/store/postgres.js` | The same calls on `pl_leases`. Time is `clock_timestamp()` in ms (the DB's clock). The fence reads the lease row `FOR SHARE` in the write transaction. Start-up details are in the next table. |
| `packages/protocol/ports.js` | Store typedef only (F13). Adds `lastSeq`, `read`'s `maxBytes` and `.bytes`, `epoch?` on `append`/`putCheckpoint`, `acquire`/`renew`/`release`/`lease`, `close`, and `StoreLease`. `Log` and `MemoryLog` are untouched. |
| `test/server/store-contract.js` | Eight lease/fence cases. `make()` may return `advance(ms)`; without it the cases wait out a 300 ms ttl on the DB's clock. |
| `test/server/store.test.js` | Rewritten to run `storeContract("sqlite")` (F12; the duplicated cases are gone). Also: pragmas, the injected clock to the millisecond, and an upgrade from an old-shape file. |
| `test/server/pg-store.test.js` | See the Postgres-only tests below. |

**Postgres start-up (t18m, after p5-pgpriv)**

| Behaviour | Detail |
|---|---|
| No ALTER | If `pl_leases` lacks `holder`/`expires_at` (looked up in `pg_attribute`), start-up throws code `needs-migration` with the owner's one-off SQL, exported as `LEASE_UPGRADE_SQL(schema)`. |
| `lock_timeout` | Set on the start-up advisory lock: `lockTimeoutMs` option, default 15 s, then code `lock-timeout` with a clear message (p5-pgprivv LOW 3). |
| Privilege error | A 42501 at start-up is wrapped like the Registry's: code `denied`, with the migrate-or-grant fix in the message (p5-pgprivv LOW 2's wording, start-up side only). |

**Postgres-only tests in `pg-store.test.js`**
- **Fence race:** an append waits on an uncommitted takeover, then is fenced (and lands on rollback). The reverse
  ordering is tested too.
- **DB clock:** `expiresAt` = `clock_timestamp()` + ttl.
- **Old table:** an epoch-only `pl_leases` is refused, left unchanged, upgraded by the operator's SQL (twice, since
  it is idempotent), then starts.
- **Lock timeout:** fires at 300 ms while another session holds the lock.
- **Least privilege:** now also checks the wrapped `denied`, and runs `acquire`, a fenced append, `renew` and
  `release` as the bare role.

No `test/server/lease*.test.js`: the cases belong in the contract so both adapters run them. No `server/store/port.js`
either, because nothing needed sharing.

## Upgrade path (t18m asked which)

**Choice: the adapter never ALTERs; the ALTER is an operator migration step.**
- **What start-up does:** detects a pre-lease `pl_leases` and refuses with the exact SQL.
- **Why not `CREATE … IF NOT EXISTS` alone:** it can't add columns to an existing table.
- **Docs:** `deploy/README.md` is platform's file, so I didn't edit it. Proposed text for its Postgres roles section:

> **Upgrading a schema made before the lease (phase 4).** Nodes refuse to start with `needs-migration` if `pl_leases`
> lacks `holder` and `expires_at`. Run once, as the owner role, on each Plenary schema:
> `ALTER TABLE "<schema>".pl_leases ADD COLUMN IF NOT EXISTS holder TEXT, ADD COLUMN IF NOT EXISTS expires_at BIGINT;`
> It is idempotent and keeps every board's epoch.

The same README's line 93 ("They never ALTER, DROP or GRANT anything") stays true for Postgres. SQLite still adds the
columns itself, because a single node's process owns its file.

## Design (distributed-systems-design, APPLIER mode: what I used)

**What the skill covered and what it didn't**
- **Used:** its 5-phase frame (scope, estimate, high level, deep dive, wrap-up), the "clock synchronization is a real
  problem" and "state what happens when each component fails" rules, and its Failover and Heartbeat technique entries
  (techniques.md:418–443).
- **Not in the skill:** `checklists.md` and `techniques.md` have no lease or fencing-token material. The fence design
  below is standard practice (lease + monotonic fencing token checked at the storage write), not something the skill
  supplied.

**Scope:** one sequencer per board, and an acknowledged op is never lost. Takeover in seconds. Host clocks are skewed
and processes pause.

**Estimate:** one lease row per open board. Renewing every 3 s across 10k boards is about 3.3k single-row updates per
second on Postgres: small. Correctness is the point, not throughput.

**High level:** a lease record per board in the Store, `(holder, epoch, expires_at)`.
- **Lease:** decides who *should* sequence.
- **Fence:** the epoch, checked atomically with every log and checkpoint write, decides who *can*.
- **Clock:** expiry is judged only on the Store's clock.

**Deep dive**
1. **Every successful `acquire` bumps the epoch, even for the same holder.**
   - **Reason:** PROTOCOL.md says the epoch rises on every room build. A host rebuilding after a timed-out append must
     fence its own old room's late append.
   - **Brief vs this:** this is a superset of "a new holder bumps the epoch".
2. **The fence checks the epoch, not expiry.**
   - **Why it's safe:** nobody else can write without first bumping the epoch.
   - **What it buys:** a paused holder that was never replaced loses nothing. Renew after a lapse is allowed for the
     same reason.
3. **No window on Postgres.** `FOR SHARE` on the lease row makes a takeover's UPDATE wait for writes in flight. A
   write that starts after the takeover reads the new epoch. On SQLite, `BEGIN IMMEDIATE` serialises every write.
4. **`fenced` beats `conflict`.** `conflict` means rebuild; `fenced` means stop.
5. **`openEpoch` is kept** for single-node rooms. It now bumps the epoch and clears holder and expiry: it takes the
   board with no lease and fences any holder. This keeps room-host and the gateway/revocation tests unchanged until
   p4-host switches.
6. **Failures.**

| Event | What happens |
|---|---|
| Host crash | Lapse after ttl, then takeover and rebuild |
| Paused host wakes | Its next write is `fenced`; it never acks |
| DB unreachable | The holder stops on its own deadline (p4-host) |
| Clean stop | `release` makes takeover immediate |
| Postgres failover | Expiry follows the new primary's clock |
| Stuck start-up lock | `lock-timeout` after 15 s instead of hanging |

**Wrap-up: suggested numbers for p4-host (not measured)**
- **ttl:** 10 s.
- **Renew:** every 3 s, like the skill's heartbeat pattern: a short period with a timeout several periods long, so
  one late renew doesn't flap.
- **Floor:** the ttl must exceed the 4 s append timeout + renew interval + margin, because a Postgres renew queues
  behind the holder's own in-flight append.
- **Bottlenecks:**
  - The lease-row lock serialises a board's renew behind its appends.
  - Takeover latency is bounded below by the ttl.
  - Start-up depends on the schema lock.
- **Monitoring (p4-host / p4-wire):** log every `fenced`, every lost renew and every takeover with its epoch.

## Tests

| Run | Result |
|---|---|
| Baseline before my edits | 1046 pass, 101 skip, 0 fail |
| Final, `bun test` | 1083 pass, 113 skip, **1 fail**: core-source drift (above) |
| Final, with DATABASE_URL (local pg 17, port 60318, PID 99633, stopped) | 1165 pass, 34 skip, **1 fail**: the same core-source drift |
| `store.test.js` / `pg-store.test.js` alone | 23 / 31 pass |
| `test/architecture.test.js` | green in every run |

**Flake seen earlier, in an earlier Postgres run (port 50491, PID 86844, stopped).**
- **What:** `v1.test.js` "a board feed picks up the host's checkpoint…" timed out at 15 s, once in the full run.
- **Rerunning the file:** failed 1 of 6 runs with DATABASE_URL set, and passed 6 of 6 without it.
- **Not Postgres:** the file and its rig use SQLite only.
- **Not seen in the final two full runs.**
- **Which wait timed out:** unknown; I only kept `(fail)` lines, so I don't know which `until` it was.
- **Possible link to my change:** its path uses `openEpoch` (now also clearing two columns) and `append` with no
  epoch. I don't think that explains a 15 s stall, but I haven't proven it.

## Mutation checks

Each mutation was applied alone in a scratch copy and run against the adapter's test file. **All 28 were caught.**

| # | Mutation | Caught by |
|---|---|---|
| S1 | sqlite append not fenced | contract: fence after takeover, released-lease fence, openEpoch fences |
| S2 | sqlite checkpoint not fenced | contract: fence after takeover |
| S3 | CAS checked before the fence | contract: "fenced wins over conflict" |
| S4 | acquire ignores expiry | 9 contract cases |
| S5 | acquire ignores the holder (steals) | 9 contract cases, including the two-holder race |
| S6 | same-holder acquire keeps the epoch | contract: acquire is exclusive… |
| S7 | renew ignores the epoch | contract: renew |
| S8 | release ignores the holder | contract: release |
| S9 | openEpoch keeps the holder | contract: openEpoch and the lease share one record |
| S10 | no column upgrade (sqlite) | store.test.js upgrade |
| S11 | acquire uses `Date.now`, not the store's clock | 4 contract cases |
| V1 | no ttl upper bound | contract: lease calls check… |
| V2 | epoch 0 accepted | contract: fence; lease calls check… |
| V3 | renew without an epoch accepted | contract: lease calls check… |
| V4 | holder id not checked | contract: lease calls check… |
| B1 | expiry `<` instead of `<=` | store.test.js: injected clock to the ms |
| B2 | `live` `>=` instead of `>` | store.test.js: injected clock to the ms |
| B3 | a non-integer clock accepted | store.test.js: injected clock to the ms |
| P1 | pg append not fenced | 4 contract cases |
| P2 | pg fence without `FOR SHARE` | pg: append waits on an uncommitted takeover |
| P3 | pg checkpoint not fenced | contract: fence after takeover |
| P4 | pg acquire steals | 3 contract cases |
| P6 | pg acquire ignores expiry | 4 contract cases |
| P7 | start-up ignores missing lease columns | pg: old table refused |
| P8 | no `lock_timeout` | pg: lock timeout |
| P9 | privilege error not wrapped | pg: least privilege |
| P10 | start-up silently ALTERs again | pg: old table refused, left unchanged |

P5 was the old "no ALTER" mutation, which became P7/P10 once start-up stopped ALTERing.

**New test parts with no killing mutation**
- **Postgres DB-clock test:** it would also pass if the adapter used the host's clock, because the test's Postgres
  runs on the same machine.
- **Postgres fence test, reverse half** (a takeover waits for an append's lock): Postgres guarantees it, so no adapter
  mutation removes it except dropping `FOR SHARE`, which the first half already catches.
- **Least-privilege lease calls:** they show the grants suffice, not adapter logic.

## Not verified

- **`now()` vs `clock_timestamp()`:** not mutation-tested. Within one statement they differ only by a lock wait.
- **SQLite across processes:** the two-handle cases run in one process, not two OS processes on one file.
- **Real failures:** no real crash, pause, Postgres failover or clock skew.
- **Load:** the cost of `FOR SHARE` under load was not measured; that belongs in the 10k load test.
- **PG15+ runtime role with no table grants:** it still starts (p5-pgprivv LOW 2's probe). My wrap only covers a
  42501 during start-up.
- **room-host:** it does not use any of this yet (p4-host).

## Risks

- **`openEpoch` overrides leases.** A single-node process pointed at a cluster database fences the cluster's holder.
  That is safe but disruptive.
- **Renew waits behind appends.** On Postgres, renews and takeovers queue behind appends in flight, so size the ttl
  for it.
- **The fence needs UPDATE.** `FOR SHARE` requires UPDATE on the lease table. Verified that `deploy/README.md:133`
  grants `SELECT, INSERT, UPDATE, DELETE` to `plenary_app`, and the least-privilege test exercises it.
- **Expiry follows the primary's clock.** A failover to a skewed primary moves every expiry.
- **SQLite uses the wall clock.** An NTP step can move a single-node lease's expiry; harmless with one process.
- **`MAX_TTL` is arbitrary.** It is 10 min. The default `lockTimeoutMs` of 15 s is also a guess.
- **Test ttls are tight.** The lease cases sleep 450 ms on a 300 ms ttl on Postgres; a very loaded CI could flake.

## Spec proposal (PROTOCOL.md; for the manager to apply after p2-tune lands)

§ Store table: replace the `append`, `putCheckpoint` and `openEpoch` rows and add the lease rows.

| Call | Contract |
|---|---|
| `append(tenant, board, entries, expectSeq, epoch?)` | atomic: writes every entry or none, only if the board's last `seq` is `expectSeq` (else `conflict`) and, when `epoch` is given, only if it is the board's lease epoch (else `fenced`), both checked in the write's transaction; `fenced` wins when both fail |
| `putCheckpoint(tenant, board, cp, epoch?)`, `getCheckpoint(tenant, board, beforeSeq?) → cp \| null` | the highest `seq` wins, never the last write; `beforeSeq` finds the one before a bad checkpoint; `epoch` fences the write as on `append` |
| `openEpoch(tenant, board) → epoch` | durable atomic increment of the board's epoch (1 on first call) that takes the board **without** a lease (holder cleared): single node only, never on a database a cluster uses |
| `acquire(tenant, board, holder, ttlMs) → { epoch, expiresAt } \| null` | takes the lease if unheld, expired, or already `holder`'s; **every success is a new incarnation**: epoch + 1 in the same row and commit. null = another holder's live lease |
| `renew(tenant, board, holder, epoch, ttlMs) → { epoch, expiresAt } \| null` | extends to now + ttl, only for `holder` at `epoch` (also after a lapse nobody took over) |
| `release(tenant, board, holder, epoch)` | frees it at once if `holder` holds it at `epoch`; idempotent; the epoch stays |
| `lease(tenant, board) → { holder, epoch, expiresAt, live } \| null` | the record, `live` judged on the Store's clock (placement, /health) |

Add to § Store's bullets:

- **Lease time is the Store's clock** (Postgres `clock_timestamp()`; SQLite the single process's clock). `expiresAt`
  is in that clock. A host never compares it with its own clock. It keeps a local monotonic deadline (the renew's
  send time + ttl) and stops sequencing before it.
- **The fence is the epoch, not expiry.** Every writer to a board must first bump the epoch through `acquire` (or
  `openEpoch`), so an epoch check atomic with the write is enough. A holder past its ttl that nobody replaced may
  keep writing. On Postgres the write reads the lease row `FOR SHARE`, so a takeover commits either before the write
  (which is then fenced) or after it.
- **Least privilege:** start-up never ALTERs. A schema from before the lease is refused (`needs-migration`) until the
  owner runs the upgrade.

§ Recovery, Room identity, "Lower than seen" bullet: replace "Phase 4 may add the fence (`append(…, expectSeq,
epoch)`, checked against the lease record) to end it at once." with "In a cluster the room passes its epoch to every
append and checkpoint, so a stale host's next write is refused `fenced` and it stops at once (§ Store)." In
"Where it lives", replace "(phase 4)" with "(`Store.acquire`)".

§ Recovery, the "On `conflict`, failure or timeout of an append" bullet: add "On `fenced`: the board belongs to
another host. Stop, answer `unavailable`, and do not rebuild here."

## What p4-host must do to use it

1. **A holder id unique per process start** (for example host id + boot nonce). A re-acquire by the same holder
   succeeds, so two live processes sharing an id would take the lease from each other in turn.
2. **Build with `acquire`.** Call `store.acquire(tenant, board, holderId, ttl)` instead of `openEpoch`. null means
   another host holds the board (placement). The returned `epoch` is the room's epoch.
3. **Fence every write.** Pass `slot.epoch` as the 5th argument of `store.append` and the 4th of `store.putCheckpoint`
   in `logOf`. Then remove the `SEAM(p4)` notes in both adapters' `fence`. Making the epoch required is p4-host's
   call.
4. **Handle `fenced`.** Call `fail(slot)`, unsubscribe the inbox (holder-only inbox, F5), and don't rebuild or
   re-acquire here at once. `conflict` and timeout still mean rebuild, which is a new `acquire` and a new epoch.
5. **Renew.** Renew every ~ttl/3. Keep `deadline = performance.now()` at send + ttl; if no renew has succeeded by
   deadline − margin, `fail(slot)`. A renew returning null means the lease is lost: `fail` at once. Never compare
   `expiresAt` with `Date.now()`.
6. **Release on clean close.** Call `release(tenant, board, holderId, epoch)` after the final checkpoint in `close()`.
7. **ttl.** Must exceed the 4 s append timeout + renew interval + margin. Suggested: 10 s, renew every 3 s.
8. **Single node.** May keep `openEpoch`, or move to `acquire` and drop `openEpoch` later (then its spec row goes too).
9. **Placement and gateways.** `lease()` gives `{ holder, live }`; `epoch()` is unchanged for a viewer's `welcome`.

**For others**
- **platform:** the `deploy/README.md` upgrade paragraph above.
- **p4-wire:** `lockTimeoutMs` is a factory option if main.js wants it configurable.
- **p4-host:** `MemoryLog` in packages/protocol/ports.js has no lease or epoch-fenced append; changing that is
  p4-host's call.

## Round 2 (fix round after p4-store-leasev, 2026-11-12)

Brief: docs/m2/briefs/p4-store-lease-r2.md. The verifier regraded M2 to **H1 (HIGH)**: all four of its Postgres mutants
must be caught, and they are. Files changed this round: `server/store/postgres.js`, `test/server/pg-store.test.js`,
and one line in `packages/protocol/ports.js` (the Store typedef note on `unavailable`). SQLite is unchanged.

### Per finding

| # | Fix | Test (pg-store.test.js) | Mutant caught |
|---|---|---|---|
| H1 | Tests only: the verifier's appendix tests, adapted to the file's shared client and schemas | "H1 window" ×2 (append, checkpoint); "H1 host clock"; "H1 clock_timestamp, not now()" | H1a fence on `db` in append; H1b same in putCheckpoint; H1c `DB_NOW` = host `Date.now()`; H1d `now()` for `clock_timestamp()`. **All 4 killed.** |
| M1 | Every write transaction sets `SET LOCAL idle_in_transaction_session_timeout` (`txIdleTimeoutMs`, default 5 s). Lease calls set `SET LOCAL lock_timeout` to `min(leaseLockTimeoutMs = 2 s, ttl/2)`. A lock timeout there is `PortError("unavailable")`, so the caller retries. | "M1: a takeover behind a stalled holder's transaction…" (the verifier's repro: `acquire`, `renew` and `release` all settle as `unavailable` in < 1.5 s, then `acquire` succeeds once it ends). "M1: a holder paused mid-write is cut off by the server…" (a real fenced append paused right after its `FOR SHARE`; the server ends it at 300 ms, the takeover gets epoch+1 in < 2 s, the paused write never lands). `settings()` now reports the idle timeout. | M1a no idle timeout; M1b no `lock_timeout`; M1c timeout not mapped to `unavailable`. **All 3 killed.** |
| L3 | Start-up probes `has_table_privilege` for every privilege the Store's statements use (entries SELECT/INSERT, checkpoints SELECT/INSERT/DELETE, leases SELECT/INSERT/UPDATE) and refuses with code `denied`, naming what's missing. | "L3: a role without UPDATE on pl_leases is refused at start-up" | L3 probe removed. **Killed.** |
| L2 | **Kept: `acquire` by the current holder still bumps the epoch.** Reason below. | (existing contract case "acquire is exclusive…") | (round 1, S6) |
| L1, L4, L5 | Report only, below. | — | — |

**One round-1 test changed.** The reverse half of "fence: an append waits on a takeover's uncommitted epoch bump"
used `renew(…, ttl 1)`. The new ttl/2 lock bound (0.5 ms) made it give up at once, which is the intended behaviour.
It now waits with `renew(…, 60_000)`, which is still a lease-row UPDATE that must wait behind the append's lock.

### L2: why `acquire` by the current holder must bump the epoch

- **The guarantee:** PROTOCOL.md § Recovery, Room identity guarantees that **two room incarnations of a board never
  share an epoch**. It lists "a rebuild after a failed append" as a build, and says taking the lease is "the same step"
  as the epoch increment.
- **The failure if it didn't bump:** after a failed or timed-out append, a host's rebuild would keep its old epoch.
  - **The fence can't help:** the old room's late append or checkpoint, still in flight in Postgres, would pass,
    because both rooms share the epoch.
  - **No safe workaround:** the only one is `release` then `acquire`. Every caller would have to remember that order,
    and between the two calls another host could take the board.
- **What the cost actually is:** "renewing" through `acquire` fences your own room. That is why `renew` exists.
  p4-host must use `renew`, and a holder id unique per process start (hand-off items 1 and 5).
- **The brief's wording:** "a new holder bumps the epoch" is satisfied; this is a superset.

### L1 (report only): two processes opening one SQLite file at once

Not fixed this round (the brief makes it report-only).
- **Fix 1:** do the `table_info` check and the `ALTER`s inside one `BEGIN IMMEDIATE`, re-reading `table_info` inside
  it.
- **Fix 2:** port server/registry/sqlite.js's WAL-switch BUSY retry (p5-pgpriv) to the store.
- **Impact:** only a concurrent restart or a second process on one node's file.

### L5 (report only): the SEAM path

- **Gap today:** `append`/`putCheckpoint` without an epoch are unfenced, and room-host passes none, so in today's tree
  the fence protects nothing.
- **p4-host must:**
  - Pass the epoch everywhere.
  - Make it required: delete the `epoch === undefined` branch in both adapters' `fence`, and the contract's "SEAM(p4):
    without an epoch the write is unfenced" lines.
  - Add the epoch to `MemoryLog`.
  - Never call `openEpoch` in cluster mode.

### L4: spec proposal, corrected (replaces the Round 1 proposal where they differ)

**§ Store table**

| Call | Contract |
|---|---|
| `append(tenant, board, entries, expectSeq, epoch?)` | atomic: writes every entry or none, only if the board's last `seq` is `expectSeq` (else `conflict`) and, when `epoch` is given, only if it is the board's lease epoch (else `fenced`), both checked in the write's transaction; `fenced` wins when both fail. M2: `epoch` optional; p4-host makes it required |
| `putCheckpoint(tenant, board, cp, epoch?)`, `getCheckpoint(tenant, board, beforeSeq?) → cp \| null` | the highest `seq` wins, never the last write; `beforeSeq` finds the one before a bad checkpoint; `epoch` fences the write as on `append` |
| `openEpoch(tenant, board) → epoch` | durable atomic increment of the board's epoch (1 on first call) that takes the board **without** a lease (holder cleared): single node only, never on a database a cluster uses |
| `acquire(tenant, board, holder, ttlMs) → { epoch, expiresAt } \| null` | takes the lease if unheld, expired, or already `holder`'s; **every success is a new incarnation**: epoch + 1 in the same row and commit (so `acquire` is never a renew). null = another holder's live lease |
| `renew(tenant, board, holder, epoch, ttlMs) → { epoch, expiresAt } \| null` | extends to now + ttl, only for `holder` at `epoch` (also after a lapse nobody took over) |
| `release(tenant, board, holder, epoch)` | frees it at once if `holder` holds it at `epoch`; idempotent; the epoch stays |
| `lease(tenant, board) → { holder, epoch, expiresAt, live } \| null` | the record, `live` judged on the Store's clock (placement, /health) |

**§ Store bullets**

- **Arguments:**
  - `ttlMs` is a positive integer of at most 600,000 (10 min).
  - `epoch`, where given, is a positive integer.
  - `renew` and `release` require it.
  - `holder` is a server id. A bad value throws `bad-entry` (`bad-id` for ids).
- **Lease time is the Store's clock** (Postgres `clock_timestamp()`; SQLite the single process's clock), and
  `expiresAt` is in that clock.
  - **When it is stamped:** when the statement evaluates it. `acquire` stamps after taking the row lock. A `renew`
    stuck behind a lock may be stamped before its wait and get a shorter lease, never one past the holder's own
    deadline.
  - **Hosts:** a host never compares `expiresAt` with its own clock. It keeps a local monotonic deadline (the renew's
    send time + ttl) and stops sequencing before it.
- **The fence is the epoch, not expiry.** Every writer must first bump the epoch through `acquire` (or `openEpoch`).
  - **Consequence:** a holder past its ttl that nobody replaced may keep writing.
  - **Postgres:** the write reads the lease row `FOR SHARE` in its own transaction, so a takeover commits either
    before it (the write is then `fenced`) or after it.
- **Bounded waits (Postgres):**
  - **Paused writer:** a write transaction left idle (its client paused) is ended by the server after a few seconds,
    which releases its locks.
  - **Lease calls:** a lease call waits on the lease row at most `min(2 s, ttl/2)`, then throws `unavailable`; retry
    it.
- **Errors at start-up:**
  - `needs-migration` (Postgres: a schema from before the lease; the message carries the owner's SQL).
  - `lock-timeout` (Postgres: the schema's start-up lock was held past `lockTimeoutMs`).
  - `denied` (Postgres: a privilege the Store's statements use is missing; probed at open).
  - SQLite: `bad-clock` if the injected clock gives a non-integer.
- **Least privilege:** start-up never ALTERs.

**§ Recovery, Room identity**

| Where | Edit |
|---|---|
| "Where it lives" | Replace "Single node has the same record (its one host holds every lease)." with "Single node uses the same record: `openEpoch` bumps the epoch and leaves it unheld (no lease)." Replace "(phase 4)" with "(`Store.acquire`)". |
| "Lower than seen" | Replace "Phase 4 may add the fence (`append(…, expectSeq, epoch)`, checked against the lease record) to end it at once." with "In a cluster the room passes its epoch to every append and checkpoint, so a stale host's next write is refused `fenced` and it stops at once (§ Store)." |

**§ Recovery, the "On `conflict`, failure or timeout of an append" bullet:** add "On `fenced`: the board belongs to
another host. Stop, answer `unavailable`, and do not rebuild here."

### Round-2 tests and runs

- **Postgres:** brew postgresql@17 on port 62885, PID 61989; stopped after.
- **Mutants:** run in a scratch copy, one at a time, against `pg-store.test.js`. 8 of 8 round-2 mutants were caught,
  bringing the total across both rounds to **36 of 36**.

| Run | Result |
|---|---|
| `pg-store.test.js` alone, with DATABASE_URL | 38 pass, 0 fail |
| `bun test` | 1130 pass, 125 skip, 4 fail |
| `bun test` with DATABASE_URL | 1224 pass, 34 skip, 4 fail |
| `bun test test/server` ×10 with DATABASE_URL | see below |

**The 4 failures are not this job's**
- **`test/core-source.test.js`:** the known herdr-draw drift.
- **Three in `test/server/tune.test.js`:** "R2: a timed pass whose Registry calls fail…", "R2: a Registry blip…" and
  "here: bounded with many viewers…". The file is untracked p2-tune work (t1fw is editing `server/gateway.js` and it
  now).
- **A/B check:** in a scratch copy with my three files reverted to HEAD (`server/store/sqlite.js`,
  `server/store/postgres.js`, `packages/protocol/ports.js`), the same 3 still fail (6 pass, 3 fail). The verifier saw
  the same three.

**`bun test test/server` ×10, with DATABASE_URL**
- **Outside `tune.test.js`:** 0 failures in all 10 runs.
- **Inside `tune.test.js`:** 3 failures in total (run 1: 2; run 4: 1; the other 8 runs: 0).
  - **Not stable work:** the file was being edited during the runs. Its test names changed, and the pass count grew
    from 288 to 303.
  - **Not this job's:** it is p2-tune's (t1fw), and the A/B check above shows the same failures with my files at HEAD.
- **Clean-up:** Postgres was stopped and the scratch data deleted.
