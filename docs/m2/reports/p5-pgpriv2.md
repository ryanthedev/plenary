# Report: p5-pgpriv2 (Registry query timeouts + p5-pgprivv's five LOWs)

> **Round 3 (p5-pgpriv3) is at the end of this file** and supersedes Round 2 where they differ: the client-side gate
> (H1, M1), L1, L3, and the port wording.

**Done, with one gate caveat.** Every Postgres Registry call is now bounded on the server and rejects with a coded
error. The five LOWs are fixed (the Store's half of LOW 3 was already fixed in the tree). Everything was tested
against real Postgres 17.11 in Podman. Not committed.

- **Gate not literally met.** The full suite has 7 (no DB) / 8 (DB) failures beyond the known ones (core-source,
  tune R2 ×2). All 7 reproduce identically in a scratch copy of the tree with HEAD's two Registry adapters: 5 gateway
  and 1 static (other sessions' uncommitted `server/gateway.js`, `server/static.js` and `web/` work) and tune's `here`
  test. The 8th, a static deny-rules failure in the DB run, did not recur in 3 re-runs.
- **This job's own tests:** 104 pass, 0 fail (pg-registry, registry, sqlite open, both architecture tests).

## What changed

| File | Change |
|---|---|
| `server/registry/postgres.js` | Timeouts (`lockTimeoutMs`, `statementTimeoutMs`, both 15 s); bounded start-up lock; start-up privilege probe; `settings()` shows the timeouts; new `readSettings()` |
| `server/registry/sqlite.js` | `onBusyRetry` is a hard cap; busy_timeout restored after start-up; `pragmas()` adds `busy_timeout` |
| `test/server/pg-registry.test.js` | 5 new tests; leak fixes on failure paths |
| `test/server/sqlite-registry-open.test.js` | 1 new test (the hard cap) |
| `test/server/registry.test.js` | the pragmas test also expects `busy_timeout: 5000` (the restore) |
| `deploy/README.md` | lines 25–26 only (the "in-memory registry" text) |

### 1. Registry query timeouts (p2-tunev HIGH 1)

- **Owned pool (`url`).** The pool gets `lock_timeout` and `statement_timeout` as Bun SQL `connection` start-up
  parameters. That costs no extra round trip; I checked Bun 1.4.4 reads them back as set.
- **Every write transaction, on a caller's `sql` as well.** `write()` sets both with `set_config(…, true)` (that is,
  SET LOCAL) in the same round trip that already set `synchronous_commit`. So the write path costs no extra round
  trip either.
- **Reads on a caller's `sql`.** These use that client's session settings, and the header says so: pass
  `connection: { lock_timeout, statement_timeout }` when you build it. I didn't wrap reads in transactions, because
  that adds three round trips to every hello lookup.
- **Coded errors.** Every returned method is wrapped once, in one place:
  - `55P03` becomes `PgRegistryError` with code **`lock-timeout`**: "postgres registry: grant waited over N ms for a lock".
  - `57014` whose message says "statement timeout" becomes code **`statement-timeout`**: "postgres registry:
    setGrant ran past N ms (statement_timeout)". Any other cancel (an operator's `pg_cancel_backend`) passes through.
  - In both cases `cause` is Postgres's own error. Other errors pass through unchanged.
- **Which code you see with equal limits.** Measured: with both limits equal, `statement_timeout` fires first on a
  lock wait, so with the defaults a lock wait reads as `statement-timeout`. The tests use unequal limits, so each code
  is asserted deterministically.
- **The connection stays usable.** Postgres cancels the statement, not the session, so the pool is usable at once.
  The tests assert this.

### 2. The five LOWs

| # | LOW | Fix |
|---|---|---|
| 1 | SQLite retry budget overran `busy_timeout` ~2× | Before each attempt `busy_timeout` is set to what is left of the budget, sleeps are clamped to the deadline, and the full `busy_timeout` is restored after start-up. Measured old vs new below. |
| 2 | PG15+ role with no table grants started, then failed every call (42501) | The start-up transaction probes `has_table_privilege` for SELECT, INSERT, UPDATE and DELETE **each on its own** on every table. A comma list means "any of": verified on PG17, a SELECT-only role gets `true` for `'SELECT,INSERT,UPDATE,DELETE'` and `false` for `'INSERT'`, so the verifier's one-call form would have passed it. A gap fails start-up with the existing "refused for lack of a privilege" message, which now names exactly what is missing (e.g. `lacks DELETE on reg_link_uses`), with code `denied` (the Store's code). |
| 3 | No timeout on the start-up advisory lock | The start-up transaction sets `lock_timeout = lockTimeoutMs` and lifts `statement_timeout`, so a stuck holder fails as code `lock-timeout`, with the Store's message shape. |
| 4 | pg-registry tests leaked pools, schemas and roles on failure paths | The eight-node and six-node tests use `allSettled` and close what started. The least-privilege test creates its role and schemas inside `try`. Roles are dropped with `DROP OWNED BY` then `DROP ROLE` (also in `afterAll`). The runtime-role contract factory drops its schema if start-up fails. |
| 5 | deploy/README.md lines 25–26 were stale | They now say the registry is SQLite in `<data>/registry.db` and the dev board id is kept in `<data>/dev-board.json`. Checked against server/main.js:114, :129 and :170. |

- **LOW 3 for the Store is stale.** The brief says "the Store has the same issue: report it". In the working tree,
  `server/store/postgres.js:92` already sets `lock_timeout` before the advisory lock (p4-store-lease), and I matched
  it. The Store has no runtime statement timeout; that is engine's to decide.

## Tests added (all against real Postgres, `postgres:17.11-alpine3.23`)

- **Table lock, `grant()` rejects** (`lockTimeoutMs` 400). Another connection holds `LOCK TABLE reg_grants`:
  - `grant()` rejects with `lock-timeout` and `cause.errno` 55P03, in 350–2000 ms.
  - `board()` still answers meanwhile.
  - Six concurrent `grant()`s on a 2-connection pool all reject in under 5 s.
  - After the lock is released, four reads and a write succeed (both connections usable).
- **Row lock, `setGrant` rejects** (`statementTimeoutMs` 400). The board row is held `FOR UPDATE`:
  - `setGrant` rejects with `statement-timeout` (57014) near 400 ms and changes nothing.
  - Plain reads don't wait meanwhile.
  - It succeeds after the lock is released.
- **Caller's `sql`, writes still bounded.** `settings()` shows `lock_timeout` 300ms, and a row-locked `setGrant`
  rejects `lock-timeout`.
- **Start-up lock.** Another session holds `pg_advisory_xact_lock('plenary-schema:<s>')`. Start-up fails with
  `lock-timeout` near 400 ms, on both `url` and `sql`, and starts once the lock is released.
- **Privilege probe.**
  - No grants: `denied`, naming `SELECT on reg_tenants, INSERT on …`.
  - SELECT only: names INSERT, UPDATE and DELETE, not SELECT.
  - One right revoked (DELETE on reg_link_uses): named alone.
  - All rights granted: it starts.
- **SQLite hard cap** (separate process; 18 of 18 extra runs passed). The verifier's 2× scenario: a holder locks the rollback-mode file for
  900 ms, then switches it to WAL and locks it for 6 s. With `busyTimeoutMs` 1000, the open must throw
  `SQLITE_BUSY` in 900–1400 ms.
  - **New code:** passes, 3 of 3 runs.
  - **HEAD's sqlite.js** (scratch copy, not the tree): **fails, 2 of 2 runs, at 1968 ms and 2079 ms.**

## How I checked it

- **pg-registry tests:** 51 pass, 0 fail, in 4 separate runs. After the runs, no `pl_test%` roles or schemas were
  left (checked in `pg_roles` and `pg_namespace`).
- **Full `bun test` without `DATABASE_URL`:** 1121 pass, 118 skip, 10 fail.
- **Full `bun test` with `DATABASE_URL`:** 1207 pass, 34 skip, 11 fail.
- **The failures.** Re-run in a scratch copy of the working tree with HEAD's two adapters, the same 9 gateway, tune
  and static failures appear; the deny-rules one did not recur at all:

| Failing test(s) | Why it isn't this job |
|---|---|
| `test/core-source.test.js` | Known (herdr-draw tree is dirty) |
| `test/server/tune.test.js`: R2 ×2 | Known (engine's R2 is in progress); also fails with HEAD's adapters |
| `test/server/tune.test.js`: `here` bounded | Not on the brief's known list; reproduced with HEAD's adapters (engine's tune work) |
| `test/server/gateway.test.js`: slow auth, rule 1, H1 ×2, M5 | Fail identically with HEAD's adapters (`server/gateway.js` is modified by another session) |
| `test/server/static.test.js`: "the real tree…" | Same with HEAD's adapters (`server/static.js` and `web/` are modified by other sessions) |
| `test/server/static.test.js`: "the deny rules themselves" (DB run only) | Did not recur: 3 of 3 re-runs passed, all 19 tests |

## Systems design (APPLIER, short; systems-design v0.1.0)

- **Scope.** Taken from the brief and CLAUDE.md, with no user to ask. A Registry call must reject in bounded time,
  because `registry-port.js` says so and the gateway turns a rejection into `unavailable`.
- **Load.** A hello does about 2–4 Registry reads. 100k joins in 2 min is about 830 hellos/s cluster-wide, so a
  10-connection pool at around 1 ms a query has room. The one dangerous case is a lock that every lookup waits on.
- **Fail closed, no retry in the adapter.** A timeout is a rejection, never a null. Retrying is the caller's job:
  - **Hello:** `unavailable`, then the client reconnects.
  - **Timed re-check:** engine's R2 rule (keep the connection, back off, close after its bound).
  - Retrying inside the adapter would pin pool connections longer exactly when a lock is stuck.
- **How the bounds compose.** The 15 s server-side limit and the gateway's 2 s `recheckLookupMs` do different jobs:

| Bound | Who sets it | What it frees |
|---|---|---|
| `recheckLookupMs` 2 s | gateway (client-side race) | the board's re-check pass (p2-tunev HIGH 1's symptom) |
| `helloTimeoutMs` 10 s | gateway | the hello's socket |
| `statementTimeoutMs` / `lockTimeoutMs` 15 s | Postgres (this job) | the Postgres connection and the pending promise |

  - **Effect of the gap.** The gateway gives up first, but the connection stays busy until Postgres cancels the
    statement. Under a stuck table lock, every lookup pins a connection for up to 15 s and hellos fail `unavailable`
    for that long. That fails closed, and the server-side bound makes it recover on its own.
  - **Recommendation (not changed here).** Cluster gateways could pass a lower `statementTimeoutMs` (e.g. 3–5 s,
    still above `recheckLookupMs`) to shorten pinning. The 15 s default matches the Store, as the brief asked.
- **Measured queueing (Bun 1.4.4).**
  - Six concurrent `grant()`s on a `max: 2` pool, table locked, 1 s `lock_timeout`: all six rejected at about
    1004 ms. `pg_stat_activity` showed only **2** connections waiting on the lock, so the other four were queued
    client-side, yet did not wait a lock_timeout of their own.
  - On `max: 1`: a locked `grant()`, then `board()`, then another locked `grant()`. Both grants rejected at about
    805 ms, and the `board()` queued between them **answered** at 807 ms. So an unrelated read is not hurt, but a
    queued call can share another call's timeout.
  - Cause not established (Bun's pipelining is the likely suspect). Either way nothing hangs.

## Wording for server/auth/registry-port.js (REPLACED by Round 3's wording at the end of this file)

Suggested addition after "…into `unavailable` (server/auth/port.js, http.js).", at line 13:

> Every adapter bounds its calls: the Postgres adapter with `lock_timeout` and `statement_timeout` (default 15 s;
> rejects with code "lock-timeout" or "statement-timeout"), the SQLite adapter with `busy_timeout` (rejects
> SQLITE_BUSY), and the memory adapter never waits. A timeout cancels the statement, not the connection. A call that
> must settle sooner (the gateway's re-check, recheckLookupMs) races it with its own timer.

## What I did NOT verify

- **A dead TCP peer or half-open connection.** `statement_timeout` runs on the server, so a client that never hears
  back still waits; the gateway's own timer is the only bound there. Not reproduced.
- **Why queued calls share a timeout** (see the systems-design note): observed, cause not established.
- **PG ≤ 14**, Docker (Podman only), and Linux SQLite locking (macOS only).
- **`has_table_privilege` with column-level grants only.** It reports table-level rights, so a role granted only
  per-column rights would be refused. I judged that acceptable, but did not test it.

## Risks

- **Reads on a caller-owned `sql` are not bounded** unless the caller sets the session options. No production root
  passes `sql` today (main.js doesn't wire Postgres), but whoever wires cluster mode should pass `url`, or set
  `connection`.
- **The default limits are equal**, so lock waits report `statement-timeout`, not `lock-timeout`. Callers should
  match either code, or any rejection, as the gateway does.
- **A queued call may reject with another call's timeout** (Bun pipelining, measured above). Harmless for lookups
  (it would hit the same lock), but a caller can't read "my call waited N ms" from the error.
- **The start-up probe adds one query** to start-up, in the same transaction. A role with rights on these tables
  through a group role passes (`has_table_privilege` follows membership with INHERIT).

## Clean-up

- **Container.** Podman container `9ed17c22977d…` (recorded in the scratchpad) was removed by its id; `podman ps -a`
  no longer lists it.
- **Leftovers.** No test roles or schemas were left.
- **Scratch files.** Scratch copies are in the session scratchpad only.

---

# Round 3 (p5-pgpriv3: bound Registry calls on the client side)

**Done.** The verifier's H1 and M1 are fixed by a client-side gate in the adapter, and L1 and L3 are fixed too.
Every new test fails with its fix removed. The full suite passes apart from the known `core-source` failure, with and
without `DATABASE_URL`. Not committed.

## Round 2 claims superseded

- **"Six locked calls all rejected at about 1004 ms" and "an unrelated read is not hurt"** were wrong for the running
  state. I measured cold (unprepared) statements. With warm statements, Bun queues calls per connection, so the k-th
  call rejected at about k × the limit, and a read of an unlocked table waited behind them. I reproduced this myself
  with the no-gate mutation copy (table below, "before (mine)").
- **The Round 2 suggested port wording** is replaced by the one at the end of this section.

## What changed

| File | Change |
|---|---|
| `server/registry/postgres.js` | Every call passes a client-side **gate** (below). New codes `overloaded`, `queue-timeout`, `client-timeout`; new options `maxInFlight`, `maxQueued`, `queueTimeoutMs`; `gate()` exposes its state; `close()` rejects waiting calls. The header's "Not covered" text is replaced by a "The gate" section. |
| `test/server/pg-registry.test.js` | 8 new tests (below), Round 2's six-call test updated, and a small `until` helper |
| `test/server/sqlite-registry-open.test.js` | The rollback-mode "held" test also asserts `busy_timeout` is 5000 after the open (L3) |
| `deploy/README.md` | Postgres section only: the start-up probe sentence and a new "Registry time limits" table, with the 3–5 s cluster recommendation |

### The gate

- **In flight.** At most `maxInFlight` calls are sent at once. The default is the pool's `max`, read from
  `db.options.max` (Bun exposes it, also on a caller's `sql`), or 10. So Bun always has a free connection for a sent
  call and never queues one behind a stuck connection.
  - I checked Bun hands a call to an idle connection when one exists: with two connections locked on `max: 3`, an
    unrelated read answered in 52 ms.
- **Queue.** Up to `maxQueued` more calls wait in the adapter, oldest first (default 10 × `maxInFlight`). Past that,
  a call rejects at once with **`overloaded`**, and nothing is sent.
- **Queue deadline.** A call still waiting after `queueTimeoutMs` (default 0.2 × the **smaller** limit + 50 ms) rejects
  with **`queue-timeout`** and is **never sent**. That code always means the call did nothing; a test proves it for a
  write.
- **Backstop.** Once a call is sent, the server limits answer. A backstop fires the larger limit + 1 s after sending
  and rejects with **`client-timeout`**. It bounds the whole call: a dead peer, reads on a caller's `sql` without
  session limits (L1), and a multi-statement call whose statements each stayed under the limit. It does not mean
  nothing happened.
- **Slots.** A call holds its slot until it really settles, even after the backstop has answered the caller, so the
  gate never over-commits connections. Deadline timers use the real clock, never the injected `now`.
- **The caller's bound.** A caller hears back within about `queueTimeoutMs` + the larger limit, plus 1 s only for a
  silent peer. No retries inside the adapter; the gate fails closed.

### H1 re-measured with the fix

Same setup as the verifier: owned pool, statements warmed on every connection before `LOCK TABLE reg_grants`,
Postgres 17.11, 8 concurrent `grant()`s (the last row: `grant`, `board` of an unlocked table, `grant`). "Before" is
my own run against the no-gate mutation copy; the verifier's numbers match it.

| Case | Before (mine, no gate), ms | After, ms |
|---|---|---|
| `max: 1`, lock 1 s / statement 10 s | 1003, 2007, 3007, … 8024 | one sent: 1005 (`lock-timeout`); seven never sent: 251 (`queue-timeout`) |
| `max: 2`, 1 s / 10 s | pairs at about 1005, 2008, 3011, 4014 | two sent: 1001, 1001; six never sent: 251 |
| `max: 1`, equal 1 s / 1 s | 1006, 2009, … 8031 | one sent: 1002 (`statement-timeout`); seven never sent: 251 |
| `max: 2`, equal 1 s / 1 s | pairs at about 1001, 2004, 3004, 4007 | two sent: 1001, 1002; six never sent: 251 |
| `max: 1`, grant / board / grant, 1 s / 10 s | 1001 / board ok 1001 / 2001 | 1001 / board `queue-timeout` 251 / 251 |

- **Every call now settles by about 1 × the lock limit,** with equal or unequal limits. That is because the queue
  wait is based on the smaller limit: calls queued behind a stuck lock give up (never sent) before a second wave
  could be sent.
- **An intermediate version** based the queue wait on the larger limit. At 1 s / 10 s it still sent waves (1003,
  2011, 3014 ms), so I changed it; the warm test now covers 800 / 8000 ms as well.
- **A read of an unlocked table on a fully pinned pool** fails fast (`queue-timeout` or `overloaded`) instead of
  answering after the stuck calls. That is the fail-closed trade, see the design note.

## Tests added

| Test | Asserts |
|---|---|
| Warm statements, `max` 1 and 2 × lock 800 with statement 800 or 8000 ms (4 tests): 8 × `grant()` behind a table lock | Each call settles under 1.5 × the lock limit, exactly `max` calls get the server code (the sent ones) and the rest `queue-timeout`, and the pool works after |
| Round 2's six-call test (400 / 10 000 ms), updated | 2 `lock-timeout` + 4 `queue-timeout`, all under 1.5 × 400 ms (it had asserted 6 × `lock-timeout`, which only the cold case gave) |
| `queue-timeout` means never sent | `max: 1`, row lock on the board. `setGrant(u1)` is sent and `setGrant(u2)` waits, then gets `queue-timeout`. The lock is released before the server limit, so u1 commits, and **u2 is absent** |
| Saturated pool sheds an unrelated read | `max: 2`, `maxQueued: 3`, five locked `grant()`s. `board()` gets `overloaded` in under 50 ms. Once the queue drains, `board()` waits, bounded, and gets `queue-timeout` in under the limit |
| Caller's `sql` without session limits (L1) | `grant()` under a table lock rejects `client-timeout` at the limit + about 1 s (was pending past 3 s). Its slot stays counted until the lock clears |
| `close()` | Rejects a call still waiting at the gate with "registry: closed" |
| SQLite L3 | After a contended rollback-mode open, `busy_timeout` reads 5000, not the remainder |

### Mutations

Each ran in its own fresh scratch copy of the tree, against real Postgres, with the final tests (59).

| Mutation | Tests that fail |
|---|---|
| No gate (the Round 2 wrapper) | 9 + a timed-out hook: the six-call test, all 4 warm tests, never-sent, overloaded, caller-`sql` backstop, `close()` |
| Gate kept, queue deadline never fires | 7: the six-call test, all 4 warm tests, never-sent, overloaded |
| Queue deadline kept, no in-flight limit (Bun queues) | 7: the same seven |
| SQLite: the `busy_timeout` restore removed | the "held" open test |

## Gates

- **pg-registry with `DATABASE_URL`:** 59 pass, 0 fail, 3 of 3 runs (after the smaller-limit change).
- **SQLite registry tests:** 26 pass, 3 of 3 runs.
- **Full `bun test` without `DATABASE_URL`:** 1159 pass, 133 skip, 1 fail (`core-source`, known).
- **Full `bun test` with `DATABASE_URL`:** 1261 pass, 34 skip, 1 fail (`core-source`, known). Both are the final runs,
  after the smaller-limit change, on my own idle container.

## Systems design (APPLIER, short; systems-design v0.1.0): gate size at 830 hellos/s

- **Load.** 100k joins in 2 min is about 830 hellos/s cluster-wide, with 3–5 Registry calls per cold hello (p5-load;
  0 when warm). That is about 3,300 calls/s if every join is cold.
- **Healthy state** (Little's law, about 1 ms a call):
  - **One node:** about 3.3 connections busy on average, against 10 slots.
  - **Ten nodes:** about 0.33 busy per node.
  - **Queue:** rarely used, and adds about 0 ms.
  - **The 100 queue places** absorb a burst of about 30 ms (one node) to 0.3 s (ten nodes) of arrivals.
- **Stuck lock on `reg_grants`:**
  - **Filling:** the 10 slots fill in milliseconds and the 100 queue places in 30–300 ms. After that, each new call
    is shed at once with `overloaded`.
  - **Queued calls:** they give up after `queueTimeoutMs` without being sent.
  - **Pinning:** each sent call pins a connection for at most the limit.
  - **No backlog:** nothing piles up unbounded. Before the fix, by the verifier's estimate, about 50k lookups per
    minute queued in Bun.
  - **Recovery:** when the lock clears, at most 110 calls are pending per node, and they drain in milliseconds. No
    abandoned work runs late, because `queue-timeout` calls were never sent.
- **What callers do with a fast rejection:**
  - **Hello:** any rejection becomes `unavailable` (gateway.js `down("role")`), and the client reconnects with its
    own back-off.
  - **Timed re-check:** R2's rule applies (keep the connection, back off, close after its bound).
  - **Neither retries tightly,** so `overloaded` doesn't spin.
- **Blast radius (M1), what remains.** During a stuck lock, reads of unlocked tables on that node are shed
  (`overloaded` or `queue-timeout`) instead of stalling for minutes. They fail fast and closed, but they still fail
  while the slots are pinned by the locked table. Isolating them further (a gate per table or per method) is not done
  here. With 3–5 s limits, each episode lasts at most one limit after the lock clears.
- **Choice.** Use `maxQueued` = 10 × slots and `queueTimeoutMs` = 0.2 × limit. A larger queue only lengthens the
  wait before failing under a stuck lock, and a healthy node never fills it.

## Wording for server/auth/registry-port.js (replaces Round 2's; not edited, since p5-load owns that hunk)

This replaces the Round 2 block in this report (marked REPLACED above). Insert it in `server/auth/registry-port.js` after
"…into `unavailable` (server/auth/port.js, http.js)." (line 13):

> Every adapter bounds its calls. The Postgres adapter bounds them on the server (`lock_timeout`/`statement_timeout`,
> default 15 s: codes "lock-timeout", "statement-timeout") and on the client, with a gate of at most the pool's size
> in flight and a bounded queue. A full queue rejects at once ("overloaded"); a call that waited past queueTimeoutMs
> is never sent ("queue-timeout"); a sent call with no answer after the larger limit + 1 s rejects ("client-timeout",
> which may still have taken effect). So a caller hears back within about queueTimeoutMs + the limit that applies. The
> SQLite adapter bounds lock waits with `busy_timeout` (SQLITE_BUSY), and the memory adapter never waits. A call that
> must settle sooner (the gateway's re-check, recheckLookupMs) races it with its own timer.

## Not verified

- **L2 (translated server messages):** not addressed. `statement-timeout` is still recognised by the English
  message. A server with `lc_messages` translated would pass a raw 57014 through, which the gateway still treats as
  `unavailable`.
- **The gate at real pool sizes and node counts:** measured at `max` 1–3; the design note extrapolates.
- **A dead TCP peer:** reasoned, not reproduced. The backstop's path is exercised by the caller-`sql` test, which
  has the same shape: sent, no answer.
- **PG ≤ 14, Docker, and Linux SQLite.**

## Risks

- **A call that never settles holds its slot forever.** Bun has no per-query cancel. After `maxInFlight` such calls
  the node sheds every Registry call with `overloaded`, which is fail-closed and visible in `gate()`. The server
  limits make this practically impossible except with a dead peer, and then Bun's socket errors should settle it
  (not verified).
- **`client-timeout` on a write is ambiguous**, as it is for any client-side timeout. The writes are idempotent per
  key (an upsert, revoke, add use), except the `create*` calls, where a retry could create a second tenant, board,
  invite or link.
- **A shared pool.** The gate sizes itself to the pool's `max`, assuming the Registry is that pool's only user. A
  caller's `sql` shared with the Store brings Bun's queueing back; pass `maxInFlight` below the pool size then
  (header and README say so).
- **The backstop is per call,** not per statement. A legitimately long multi-statement call (none today; every method
  is a few millisecond-scale statements) would be cut at the larger limit + 1 s.
- **L5 (pre-existing):** `sqliteRegistry` does not close its handle when start-up throws. Not mine to change this
  round.

## Clean-up

- **Container.** Podman container `3d04cecd9922…` (recorded in the scratchpad) was removed by its id after the
  runs. The engram and opensearch containers belong to others and were not touched.
- **Leftover schema.** One `pl_test%` schema was left inside my container after the no-gate mutation run, whose
  failing tests timed out mid-test. It was removed with the container.
- **Scratch copies.** The mutation copies are in the session scratchpad only.

## Engram

- **The correction was not stored.** I tried to ingest a correction of Round 2's stale gotcha (it said queued calls
  reject together and an unrelated read is not hurt; that is true only for cold statements). Engram refused it with
  429: its OpenSearch index is read-only because the disk passed the flood-stage watermark.
- **Not touched.** Those containers belong to others. The stale memory stands until someone frees the disk and
  re-ingests; the correct facts are in this section and the H1 table above.

---

# Round 4 (p5-pgpriv4: never send a call past its queue deadline)

**Done.** M1 from p5-pgpriv3v is fixed and tested on real Postgres, and the test fails with the fix removed. L2 and L1
are documented, and engine's two README items are in. Gates: only the known `core-source` failure, with and without
`DATABASE_URL`. Not committed.

## What changed

| File | Change |
|---|---|
| `server/registry/postgres.js` | **M1:** each queued entry keeps an absolute deadline (`performance.now() + queueMs`). `pump()` checks it where an entry is taken off the queue: past the deadline, the entry is rejected with `queue-timeout` (its timer cleared through `settle`, no slot taken) and the next entry is tried. The header says so, and says why 3–5 s matters (L2). |
| `test/server/pg-registry.test.js` | 1 new test (below) |
| `deploy/README.md` (Postgres section only) | Store grant probe and the upgrade paragraph (engine's request); the L2 reason for 3–5 s; the L1 burst note |

- **Why M1 happened.** After an event-loop stall, the I/O that frees a connection, and `pump()` in its microtasks,
  ran before the overdue queue timer (a macrotask). So `send()` was reached for a call already past its deadline.
- **No slot can leak on the new path.** `expire()` runs before `running++`, so it never takes a slot, and `settle()`
  clears the queue timer. The test asserts the gate drains back to 0 running and 0 waiting.

## Test

**"a queued call whose deadline passed during an event-loop stall is not sent when the connection frees"**, modelled
on the verifier's `b3.js`:

- **Pool:** `max: 1`, lock 1 s / statement 10 s, so `queueTimeoutMs` is 250 ms; statements warmed first.
- **The lock:** a second session takes `LOCK TABLE reg_grants`, then is sent `SELECT pg_sleep(0.2); COMMIT`. The
  server ends the lock at about 200 ms, independent of this loop.
- **The calls:** A `grant()` is sent and waits on the lock. B `setGrant(late)` is queued (the gate shows 1 running,
  1 waiting).
- **The stall:** `Bun.sleepSync(600)`, past B's deadline; the lock clears during it.
- **Asserts:** A answers ok; B rejects `queue-timeout`; `grant(late)` is null (never committed); the gate drains to
  0 running and 0 waiting.

| Run | Result |
|---|---|
| With the fix | 5 of 5 alone, plus 2 full-file runs (60 pass) |
| Fix removed (`pump` always calls `send`), fresh scratch copy | **fails 3 of 3:** `Expected: "queue-timeout" Received: "ok"`, so B was sent late |

- **Harness gotcha.** A Bun SQL query is lazy: it is only sent once something subscribes with `.then` or `await`. The
  test's release query attaches `.then` at once. Without it, the release went out only after the stall, so A timed
  out instead of answering.

## README (Postgres section only)

- **L2.** 3–5 s keeps `queueTimeoutMs` at 0.65–1.05 s, below the gateway's 2 s `recheckLookupMs`, so a re-check the
  gateway gave up on is never sent. With the 15 s defaults it is 3050 ms. Also in the header.
- **L1, note only.** Bursts above `maxInFlight + maxQueued` (110) get `overloaded` straight away, even on a healthy
  pool. Raise `maxQueued` for bigger bursts: `queueTimeoutMs` bounds the wait, not the queue's length. The default is
  not changed, because I took no measurement.
- **Store grant probe.** It replaces the stale "The Store's message is Postgres's own `permission denied …`". Both
  adapters probe at start-up and refuse with code `denied`, naming what is missing. Checked against
  `server/store/postgres.js` (`NEEDS` at :79–83, the probe at :119–125, code `denied` at :133–136):
  - `pl_entries`: SELECT, INSERT
  - `pl_checkpoints`: SELECT, INSERT, DELETE
  - `pl_leases`: SELECT, INSERT, UPDATE (the fence's `FOR SHARE` needs UPDATE)
  - Step 3's grants cover all of them.
- **Upgrade paragraph.** Engine's text from `p4-store-lease.md:52-55`, verbatim. The column types (holder TEXT,
  expires_at BIGINT) match `LEASE_COLUMNS` and `LEASE_UPGRADE_SQL` (`server/store/postgres.js:69-75`).
- **"They never ALTER, DROP or GRANT anything" still holds.** Start-up only detects a pre-lease table and refuses with
  `needs-migration`; the ALTER is the operator's to run. I added a sentence saying so. I did not touch the endpoints
  hunk near line 20.

## Gates (own Podman Postgres 17.11, idle)

- **pg-registry:** 60 pass, 0 fail, twice.
- **Full `bun test` without `DATABASE_URL`:** 1160 pass, 134 skip, 1 fail (`test/core-source.test.js`, known).
- **Full `bun test` with `DATABASE_URL`:** 1263 pass, 34 skip, 1 fail (`test/core-source.test.js`, known).

## Not done, carried

- **L3 and L4:** documented risks, unchanged.
- **L5:** the +50 ms in `queueTimeoutMs` breaks 1.5× only at limits around 100 ms; no real setting is that small.
- **L6:** Round 2's L2 (English-message match) and L5 (SQLite handle not closed on a start-up throw).

## Clean-up

- **Container.** Podman container `2014c8dd17d3…`, recorded in the scratchpad, was removed by its id; `podman ps -a`
  no longer lists it.
- **Scratch copies.** The mutation copy is in the session scratchpad only.
