# Report: p2-tune (revocation at scale, `here`, feed and test fixes)

Builder terminal `t1fw` (`plenary-p2-tune`), 2026-11-12. Brief: docs/m2/briefs/p2-tune.md. Not committed.

## Outcome

All seven items done, with tests that go red when their fix is undone (mutation table below). Re-check passes no
longer stall the gateway: 20 `grants` messages on 2,000 connections went from a **261–278 ms** event-loop stall to
**7 ms**. A Registry blip on the timed pass now closes nobody. `here` is built to a written rule that stays bounded
at 100k viewers. All three flaky tests (R6 and the manager's token-expiry and feed-checkpoint tests) had their causes
captured and fixed with event-driven waits, not longer timeouts. test/server passed 10 runs in a row with 0 failures.

**Not met: a green `bun test`.** One test outside my files fails in every run: `test/core-source.test.js`
(packages/core's `editor.js` no longer matches herdr-draw's copy; it needs a re-copy and SOURCE.json update by its
owner). Everything else is green, both plain and with Postgres and NATS.

**Found on the way (not mine to fix):** `server/breather.js` yields per async chain, not per event-loop turn. Code
that runs N concurrent chains through `breathe()` holds the loop about N × 8 ms (see Risks).

## Design (distributed-systems-design, APPLIER mode, brief)

- **Requirements:** a re-check of 2,000 (later 100k) connections must never hold the gateway's event loop long
  enough to delay frames; a revoked user must be cut off fast; a Registry outage must not mass-close a board on a
  routine timer; acknowledged ops are untouched (this is the auth path only).
- **Load:** one `auth.role` lookup per *user* per pass, not per connection. A pass costs users ÷ 8 round trips
  (8 lookups in flight). Grants storms collapse to at most 2 passes (the running one plus one dirty mark).
- **Shape:** per board, one pass in flight; a queued follow-up takes the strictest kind asked for
  (retry < timed < grants). One async chain per pass, yielding through `breathe()` between batches.
- **Failure rule:** fail closed when the trigger is a Registry *change* (`grants`, M1's threat: a revoked user keeps
  access); fail open for a bounded time when the trigger is the clock (nothing changed, the Registry is only down).

## What changed

| File | Change |
|---|---|
| `server/gateway.js` | Re-check rewritten (`requestRecheck` / `recheckPass`): coalesced, per user, writers first, one yielding chain with 8 lookups in flight, timed-pass retry with backoff (2/4/8 s per connection, reset on success, then close that connection), a timed pass stops when its whole first batch failed (Round 2), `stats().rechecks`. `here` built (counters, `.here` bus message, merge across gateways, paced fan-out). Presence flush uses a `Set` for senders. |
| `server/feed.js` | R4: an entry at seq + 1 that can't be served (another board's) sets `gapAt`, so joins get `unavailable`; logged once per position. |
| `PROTOCOL.md` | § Auth "Re-checking live connections" (timed pass, error rule, worst case ~60 s + 14 s past `expiresAt`); § Bus `.grants` pointer and the `.here` message; § Presence `here` (what is counted, merging, pacing, bounds). |
| `test/server/rig.js` | R6 fix: `drop()` during `connect()` wins; the late socket is closed, not adopted. `settled()` timeouts now name the stuck client. |
| `test/server/v1.test.js` | Token-expiry and feed-checkpoint flakes made event-driven (below). |
| `test/server/tune.test.js`, `test/server/harness.test.js` | New (10 tests). |

## Flaky tests: causes and fixes (R6 and the manager's two)

| Test | Cause (captured) | Fix |
|---|---|---|
| R6 (harness, seen as random `settled()` timeouts) | A test's `drop()` landed while `connect()` awaited its socket; the late socket was then adopted, leaving a client open that the test thought dropped, so it never resynced. Seen 1 in 75 and 2 in 120 loaded runs; a trace showed the order. | `rig.js` counts drops; `open_()` closes and discards a socket that opened after a drop. |
| v1 token expiry | `exp` was fixed before the rig was built; on a loaded machine the token had already expired at hello, so no welcome came. | `exp` stamped when verify runs (`now + 2 s`, or `-1` for the expired case). |
| v1 feed checkpoint (base.seq 9, not 10) | The host folds and checkpoints in a `setTimeout` after the append resolves; `idle()` doesn't wait for it, so the test read the checkpoint one op early. | Waits (`until`) for the host's `base.seq === 10` before checking the feed. |

## Tests added and mutation checks

Each mutation undoes one fix in a scratch copy of the tree and runs the named test; every one went red.

| Test | Mutation (fix undone) | Result |
|---|---|---|
| R1: 10 grants during a pass cost exactly one more pass | every ask starts its own pass | fails |
| R1: a user's tabs share one answer; writers asked first | one lookup per connection / users in arrival order | fails / fails |
| R2: timed-pass errors keep, retry, then close after the bound | timed pass fails closed / no retry bound | fails / fails |
| R2: a blip closes nobody; stops early after errors in a row | no early stop | fails |
| R2: grants pass still fails closed, also when it lands mid timed pass | follow-up not upgraded to grants | fails |
| (existing) revocation.test.js M1 | grants pass keeps on error | fails |
| R4: foreign entry at seq + 1 refuses joins | old condition (gap only) | fails |
| here: relayed, updated, never logged or stored | never sent | fails |
| here: merged across two gateways | other gateways ignored | fails |
| here: bounded with many viewers | no cap on the list / big boards paced like small | fails / fails (*) |
| R6 harness | late socket adopted | fails |
| v1 token expiry | old fixed `exp` plus a 1.1 s slow verify | fails; the fixed test with the same slow verify passes (control) |

(*) The first version of this test passed with the pacing undone: its churning viewers closed before going live, so
the count never changed. Each churner now waits for its welcome; the mutant goes red.

The feed-checkpoint fix is not mutation-checked (the old form fails only by timing); it is covered by the repeats.

## Measurements (R1, R3)

Clients in a child process, 2,000 sockets on one board, one gateway, in-memory Registry with a real `await` per
lookup. "Stall" = the longest event-loop delay seen by a 1 ms probe in the server process.

| Case | Before (HEAD) | After |
|---|---|---|
| 20 `grants` messages, max stall | 261–278 ms (all passes done ~1.77 s) | **7 ms** (21–39 ms) |
| 1 grants pass, one user, 2,000 tabs | 13 ms | 2–7 ms |
| 1 grants pass, 2,000 distinct users | 13 ms | 8–9 ms (pass 19–20 ms) |
| R3: revoke 2,000 distinct users, max stall | 90 ms | 13–14 ms |
| R3: Registry change to last close, 2,000 connections | 94 ms | **74–75 ms** |
| Revoke one user with 2,000 tabs, max stall | 82 ms | 22–30 ms (the per-user close loop; production caps tabs at `maxConnsPerUser` 64) |

## Verification

| Check | Result |
|---|---|
| `bun test test/server`, 10 runs in a row | **10/10 with 0 fail** (183 pass in runs 1–5, 200 in runs 6–10: other workers' tests landed mid-loop) |
| Full `bun test` with `DATABASE_URL` + `NATS_URL` (scratch Postgres 17 and nats-server) | 1179 pass, 19 skip, **1 fail**: `core-source.test.js` (below) |
| Full `bun test`, plain (rerun) | 1083 pass, 112 skip, **1 fail**: `core-source.test.js`. The first plain run had 4 failures (below). |
| Mutation checks | every new test goes red with its fix undone (table above) |

Failures outside my files:

- **`test/core-source.test.js`** (packages/core drift): fails in every run. `editor.js`'s hash no longer matches
  herdr-draw's; packages/core is re-copied from herdr-draw, not edited here. Needs a re-copy by its owner.
- **`test/auth/role-cache.test.js`** "a revoke whose `grants` message was lost…" and **`test/web/architecture.test.js`**
  (two tests) failed once in the first plain run and pass on rerun (role-cache 11/11 three times). Cause not established;
  their files (`server/auth/`, `web/`) were changing on disk during that run. role-cache imports nothing I changed.

## Not verified

- **Postgres cost of a pass:** a pass is users ÷ 8 sequential round trips; not measured against a real Registry
  under load (2,000 users at 2 ms ≈ 0.5 s, fine; 100k users ≈ 25 s, longer than one would like).
- **100k scale:** only 2,000 sockets were measured; the `here` pacing for 100k is an estimate (4 KB × 100k per send).
- **`here` over real NATS between processes:** tested with two gateways on one in-memory bus only.

## Risks

- **`breather.js` yields per async chain** (not mine): N concurrent chains through `breathe()` hold the loop
  ~N × 8 ms (measured: 8 chains ≈ 65 ms). The gateway's per-connection pumps use it too. Worth a fix by its owner.
- **A grants pass during a Registry outage closes everyone on the board** (fail closed, as M1 requires). Clients
  reconnect and are refused at hello until the Registry is back. This is the deliberate trade.
- **`viewers` counts connections, not people** (a viewer with two tabs counts twice); writers are counted by user.
- **`.here` subject is derived from `subjects.presence`** in the gateway; `server/bus/port.js` (not mine) should
  get a `subjects.here`.
- **Closing one user's many tabs is a non-yielding loop** (bounded by `maxConnsPerUser`).
- **Overlap with p5-load's role cache** (`server/auth/tenancy.js`, not wired in `main.js` yet): its comments say the
  gateway's timed pass calls `invalidate(board)` once, then the batched `rolesFor` per chunk, and that the `grants`
  subscriber calls `invalidate`. My pass calls `auth.role` per user and doesn't call `invalidate`. Once the cache is
  wired, the gateway needs that change (a small one in `recheckPass`: one `rolesFor` per batch of 8 users instead of
  8 `role` calls), or a lost `grants` message is caught at the cache TTL (30 s) rather than by the next pass. Using
  `rolesFor` would also cut the Postgres cost below users ÷ 8 round trips. Not done: it needs the manager's call.

## Proposals (spec text I wrote that the manager should confirm)

- Timed-pass error budget: 3 retries at 2/4/8 s per connection (reset on a good answer), then close that connection; a timed pass stops when its whole first batch failed (Round 2).
- `here` bounds: 50 writers per message, 15 s TTL per gateway, 1/s on change, every 5 s on boards over 1,000
  connections.

## Round 2 (fixes for p2-tunev; brief docs/m2/briefs/p2-tune-r2.md)

Each finding's repro from docs/m2/reports/p2-tunev.md is now a test in `test/server/tune.test.js` (under "Round 2").

### Findings and fixes

| Finding | Fix (`server/gateway.js` unless named) |
|---|---|
| H1: a hung `role()` held later grants passes; a revoked editor kept writing | Each lookup races a timer (`recheckLookupMs`, 2 s; `rechecks.timeouts`). A grants pass that times out fails closed for that user, so a hung Registry can't keep a revoked writer. A stricter ask (grants) during a running pass sets `cut`: the pass stops at the next batch and the grants pass runs next. |
| H2: 8 failing users closed 300 healthy viewers | Errors are per connection: only the connection that failed counts a retry and, past its budget, is closed. A timed pass stops early only when its *whole first batch* failed (the Registry is down, not one user). |
| M1: full `here` list resent to everyone on a count change | Count-only `here` (no `writers` field) when only counts changed since that connection's last full list (`hVer`); the client keeps its last list (web/core/collab/presence-model.js already did). |
| M3: backoff counter reset only on a clean pass | Backoff is per connection (`checkFails`), reset on a good answer; waits are 2/4/8 s per connection, so the "~60 s + 14 s past `expiresAt`" bound holds. |
| M2: N boards' passes hold the loop ~N × 8 ms | **Open.** The cause is `server/breather.js` (yields per async chain); not mine. |
| LOW 1: ranking by role, not activity | Owners and editors first, then the most recently active; the sent list is then ordered by role and user. |
| LOW 2: `v1.test.js` feed-checkpoint test waited for a fold that never comes | Ops sent in the verifier's order (1; 2+3 together; 4–10 singly); the test asserts on the base the room settles at (9), after one macrotask for the host's `setTimeout(0)` fold. Passes 3/3 alone; the old wait for 10 hangs on this order. |
| LOW 3: strictness upgrade untested | Test from the verifier's B2 (grants queued behind a retry pass must close the revoked writer). |
| LOW 4: per-user grouping used the first tab's identity | Grouped by user, email and domain (what `tenancy.role` reads). |
| LOW 5: first joiner got no `here` | The welcome merges this gateway's own entry before the first send. Also fixed: every joiner within the first tick had an empty writers list. The `here` joiner check now asserts a full list. |
| LOW 6: spec inconsistencies | PROTOCOL.md: timer tick during a pass is skipped; the stop rule names timed passes; PROTOCOL.md:260 says 1/s, 5 s on big boards. |
| LOW 7: `.grants` at-most-once | PROTOCOL.md § Bus says so: a lost `.grants` is repaired by the next timed pass (≤ 60 s). |

### Mutation checks (Round 2)

Each mutation undoes one r2 fix in a scratch copy of the tree; the named test must go red. Log:
scratchpad `mut2.log`.

| Finding | Test | Mutation (fix undone) | Result |
|---|---|---|---|
| H1 hung lookup | H1 | `roleWithin` without the timeout (plain `auth.role`) | fails |
| H2 board-wide close | H2 | a spent retry budget closes every connection on the board | fails |
| M3 backoff never reset | M3 | backoff exponent per board, never reset (the old `rc.retries`) | fails |
| M1 count-only `here` | M2/LOW 5 | every send is the full list | fails |
| LOW 5 first joiner | M2/LOW 5 | welcome back to `if (!b.hText) hereRefresh(…)` | fails |
| LOW 1 ranking | LOW 1 | list cut by role rank only, not activity | fails |
| LOW 3 queued kind (B2) | LOW 3 | no upgrade of a queued follow-up to the stricter kind | fails |
| LOW 4 grouping | LOW 4 | group by user id only | fails |

My first M3 mutation (a shared fail counter) passed: it made the second close *faster*, so it didn't model the bug.
The one above reproduces the verifier's 160/320/640 ms waits.

### Spec (PROTOCOL.md, Round 2)

- **Line 260:** `here` is "at most 1/s (every 5 s on big boards); without `writers` when only a count changed".
- **§ Presence:** a new "Count-only `here`" rule (the client keeps its last list; a joiner's first `here` always has
  the list).
- **§ Auth, re-checking:** the 2 s lookup timeout counts as an error; backoff is per connection and resets on a good
  answer; past the budget only that connection closes; a timer tick during a pass is skipped (the old "(or the
  timer)" contradiction is gone); a `grants` ask cuts a timed or retry pass; a timed pass whose whole first batch
  fails stops; grouping is by user + email + domain.
- **§ Bus:** `.grants` is at-most-once; the next timed pass (≤ 60 s) repairs a lost one.

### Measurements (Round 2)

R1 stall bench (2,000 real sockets, clients in a child process, SQLite Registry; log: scratchpad bench/r2-stall.log):

| Shape | 1 grants pass | 20 grants messages | Revoke all (grants until 0 conns) |
|---|---|---|---|
| One user, 2,000 tabs | 8 ms stall, 2 ms | 8 ms stall, 22 ms | 46 ms stall, 48 ms |
| 2,000 distinct users | 7 ms stall, 32 ms | 9 ms stall, 74 ms | 10 ms stall, 65 ms |

The target (≤ ~10 ms for 20 grants on 2,000 sockets) holds. The one-user revoke-all stall (46 ms) is the 2,000
closes of a single user's group in one loop turn; it is a one-time event per revocation, not per pass (see Risks).

### Verification (Round 2)

| Run | Result | Log (scratchpad) |
|---|---|---|
| `bun test test/server`, 10 runs in a row | 10/10 green: 208 pass, 0 fail each | loop10-r2.log |
| Full `bun test` with DATABASE_URL (brew postgresql@17) + NATS_URL (nats-server), free ports, stopped by recorded PID | 1276 pass, 19 skip, 1 fail (core-source only); the PG and NATS files alone ran 127 pass, 0 fail (not skipped) | full-pg-nats-r2.log |
| Plain `bun test` | 1159 pass, 133 skip, 1 fail (core-source only) | plain-r2.log |
| Each new Round 2 test with its fix undone | all 8 mutations fail (table above) | mut2.log |

**Outside my files:** `core-source.test.js` fails because packages/core has drifted from herdr-draw (editor.js), which
is not mine to fix. `static.test.js:339` (collab.css) failed earlier in this job; it passes now.

### Risks (Round 2)

- **Grants pass on a hung Registry:** every lookup waits the 2 s timeout, so the pass takes about users ÷ 8 × 2 s
  (2,000 users takes about 500 s) and closes everyone it reaches (fail closed). Stalls stay short (8 per batch), but
  revocation on a hung Registry is slow. A circuit breaker (stop after the first all-timeout batch and close the rest
  at once) is the manager's call.
- **A 100k-user pass against Postgres takes about 25 s** (verifier's number); `rolesFor` (p5-load's batch lookup)
  is still not wired into `recheckPass` (t18m: leave `auth.role` per user for now).
- **M2 (breather.js) is still open**; that file isn't mine.
- **One user with 2,000 tabs, all revoked at once:** a 46 ms stall while their connections close in one loop turn.
  This is one-time per revocation; yielding inside the close loop would fix it if it matters.
- **Scratch data** (PG data dir, logs, bench) is left in the scratchpad because `rm -rf` there was refused.
