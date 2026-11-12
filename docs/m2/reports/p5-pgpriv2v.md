# Report: p5-pgpriv2v (verify p5-pgpriv2: Registry query timeouts + the five LOWs)

**FAIL, on one HIGH.** The bar's first sentence does not hold. Under a held lock, a Registry call queued in Bun's pool
behind other locked calls rejects at 2×, 3×, … N× its limit, not at its limit. This is the production case: the
statements are already prepared, and the builder only measured unprepared ones.

Everything else in the job holds:

- **Error codes:** both codes are right, and other errors pass through unchanged.
- **Writes:** a timed-out write leaves nothing half-done.
- **Start-up:** it no longer hangs on a stuck lock, and the privilege probe is correct, including for deploy/README.md's
  role setup run as written.
- **SQLite:** the busy budget is now a hard cap.
- **Mutations:** every fix has a test that fails when the fix is removed, except the SQLite `busy_timeout` restore (LOW 3).
- **Gates:** pass apart from failures that are not this job's.

Target: the six job files, sha1-pinned at start and re-checked before writing this (all unchanged). Postgres
17.11-alpine3.23 in Podman, Bun 1.4.4, macOS. Scripts are in the session scratchpad (`exp1.js`, `exp2.js`, `exp3.js`,
`probe.sh`).

## Findings

| # | Grade | Finding |
|---|---|---|
| H1 | **HIGH** | Queued calls stack their timeouts: the k-th queued call on a connection rejects at about k × the limit |
| M1 | MEDIUM | A lock on one table stalls every Registry read on that pool, including reads of unlocked tables, once all connections are waiting on it |
| L1 | LOW | Reads on a caller-owned `sql` are unbounded (confirmed: still pending at 3 s). No production path passes `sql` |
| L2 | LOW | `statement-timeout` is recognised by the English message text; a server with translated messages would pass a raw 57014 through (not reproducible here, see below) |
| L3 | LOW | The SQLite `busy_timeout` restore after start-up has no test that fails without it (mutation survives) |
| L4 | LOW | With the equal 15 s defaults, every lock wait reports `statement-timeout`, never `lock-timeout` (confirmed). Documented by the builder; callers must match either code |
| L5 | LOW, pre-existing | `sqliteRegistry` does not close its `Database` when start-up throws (HEAD is the same). That is also why a throw path that leaves `busy_timeout` unrestored can't hurt: nothing uses that handle again |

### H1: queued calls stack their timeouts (refutes the builder's measurement)

**Setup.** Owned pool (`url`), `lockTimeoutMs` 1000, `statementTimeoutMs` 10 000. Another session holds
`LOCK TABLE reg_grants IN ACCESS EXCLUSIVE MODE` or a row lock. The statements were already run before the lock was
taken, so they are prepared: that is the normal state of a running server.

| Case | Each call rejected at (ms) |
|---|---|
| `max: 1`, 8 × `grant()` | 1011, 2013, 3021, 4029, 5039, 6042, 7049, 8052 |
| `max: 1`, 6 × row-locked `setGrant` | 1003, 2010, 3023, 4028, 5037, 6044 |
| `max: 2`, 8 × `grant()` | 1001, 1001, 2003, 2010, 3003, 3011, 4011, 4011 |
| `max: 2`, 6 × `setGrant` | 1003, 1003, 2010, 2010, 3012, 3012 |
| `max: 1`, `grant`, `board` (unlocked table), `grant` | 1008, **board 1008**, 2012 |
| Raw Bun SQL, no adapter, `max: 1`, 4 × the same prepared SELECT | 1004, 2008, 3020, 4020 |

**What decides it is whether the statement was prepared before the lock** (`exp2.js`, `max: 2`, 6 concurrent):

- **Never run before the lock (cold):** all six reject at about 1003 ms.
- **First run under the lock, as in the builder's test:** all six reject at about 1003 ms. A failed prepare seems to
  fail everything pipelined behind it.
- **Run before the lock (warm):** 1003, 1003, 2003, 1003, 3007, 1003. The calls are sent one after another.

**Why it got through.**

- **The builder's test can't catch it.** It prepares `grant` under the lock first, and its bound is
  `max < 5000` at a 400 ms limit, which would pass serial waits anyway.
- **The builder's report is wrong on this point.** It says "all six rejected at about 1004 ms" and "an unrelated read
  is not hurt". On `max: 1` the unrelated `board()` waited 1008 ms.

**Cause.** Bun's pool queues calls client-side, one per connection (the raw Bun SQL row above). The adapter's
server-side limits start counting only when a call reaches Postgres.

**Against the bar.** "A Registry call on Postgres never stays pending past its limit": false for the caller. The
header text "Not covered: time a call spends queued in Bun's pool" admits the gap but describes the measured
behaviour wrongly.

**Suggested fix (builder's call).** Give each call a client-side deadline in the adapter's existing wrapper
(server/registry/postgres.js:346-349):

- Race each call against `max(lockMs, stmtMs)` plus a small margin, and reject with a coded error (e.g.
  `queue-timeout`).
- Better still, add a bounded in-flight gate of about pool size × k. Shed load at once with a coded rejection when it
  is full, and check the deadline before sending, so an abandoned call never occupies a connection.
- Add a test that runs `grant()` before taking the lock, fires more calls than the pool has connections, and asserts
  every call is under about 1.5 × the limit.

### M1: one stuck table stalls the whole Registry on a node

This follows from H1: a `board()` or `tenant()` read queued on a connection that is waiting on the lock waits too.

- **With spare connections it is fine:** on `max: 2` the unrelated read answered in 1 ms.
- **At join rates it is not:** every connection fills with lookups on the locked table, so all Registry reads on that
  node, and therefore all hellos, stall. See the systems-design section.

It is graded separately because it changes the blast radius, not only the latency. The same in-flight gate fixes it.

### Ensemble and verifier claims, confirmed or refuted

The ensemble was codex (effort high) and grok.

- **Not run:** agy (quota exhausted, resets in 54 h), kimi (not logged in) and mistral (no API key), all per
  `check_adapter`. qwen is not installed.
- **No finding was raised by both reviewers**, so there were no automatic HIGH candidates.

| Claim | Source | Result |
|---|---|---|
| Pool queue time is unbounded | codex HIGH | **Confirmed** (H1, found independently first) |
| Caller-`sql` reads are unbounded | codex HIGH | **Confirmed, graded LOW** (L1): `exp1` E2 shows the read still pending after 3 s and answering at 3004 ms when the lock is released. No production root passes `sql`: `scripts/admin-bootstrap.js:62` and the README snippet pass `url`, and `server/main.js` doesn't wire Postgres |
| Probe misses schema `USAGE` | codex MEDIUM | **Refuted.** A role with every table right but no `USAGE` is refused at start-up (`denied`, "permission denied for schema public") because the migrate step's lookups fail first |
| `/statement timeout/` is locale-bound | codex MEDIUM | **Plausible, not reproducible:** this image has no message translations (`SET lc_messages='de_DE.utf8'` still prints English). Graded LOW (L2), because the default is English and the gateway treats any rejection as `unavailable` |
| Wrapper misses `settings`/`readSettings` | grok HIGH | **Refuted.** Both are properties of `api`, which the loop at :346 walks |
| `readSettings` and `settings` differ on a caller's `sql` | grok MEDIUM | **Refuted as a bug.** By design: one shows session values, the other the in-transaction values |
| `busy_timeout` left at 0 on a throw path | grok HIGH | **Refuted as stated.** On a throw no registry is returned, so nothing runs on that handle again (pre-existing leak, L5) |
| `denied` path shows the old message | grok LOW | **Refuted.** `probe.sh` and the tests show the new "lacks X on Y" message |
| Test cleanup gaps | grok LOW | **Refuted** for the paths checked. On a fresh, idle container, a clean pg-registry run and a run with a failing mutation (M4, which fails after its role and schema exist) both left 0 `pl_test%` roles and 0 `pl_test%` schemas |

## Checks run

- **deploy/README.md lines 25–26 (LOW 5):** confirmed. They match server/main.js:114 (`registry.db`) and :129 (`dev-board.json`).

### Timeouts on real Postgres (`exp1.js`)

| Check | Result |
|---|---|
| Table lock, owned pool, unequal limits | `lock-timeout` at about 1 s per call; the pool works after (H1 aside) |
| Row lock, `setGrant`, caller's `sql` | `lock-timeout` at 303 ms (limit 300) |
| Equal limits 500/500, 5 sequential | all `statement-timeout`, 501–510 ms |
| Defaults (15 s/15 s), one lock wait | `statement-timeout` at 15 009 ms |
| Start-up advisory lock (`url` and `sql`) | covered by the builder's test; killed by mutation M3 below |
| `pg_cancel_backend` during a wait | raw `PostgresError`, "canceling statement due to user request", not a `PgRegistryError`. **Passes through** |
| Last owner removed | `last-owner`, unchanged |
| Unique violation (same domain) | unchanged ("domain already has a tenant"; the contract tests pass) |
| Half-done writes: `createTenant` with admins (admins table locked), `addLinkUse` (uses locked), `setGrant` (grants locked) | each rejects `lock-timeout` at about 405 ms and leaves nothing behind: no tenant, no use, no grant |
| Settings after writes, caller `sql`, `max: 1` | the session's `0/0/on` before start-up, after start-up, after writes and after a timed-out write. **`set_config(…, true)` is transaction-local**, and start-up's `statement_timeout=0` doesn't leak |
| Owned pool, `max: 1`, after start-up and after a write | `1234ms` / `5678ms`: start-up's lifted `statement_timeout` does not leak |
| Owned pool after `pg_terminate_backend` | re-run on an idle container (`exp4.js`), where the pool's backend was the only other client: the old pid is gone, the next call succeeds at once, and the new session still has `1234ms`/`5678ms` |

### Privilege probe (`probe.sh`, deploy/README.md steps 1–3 run as written on a fresh database)

| Role | Result |
|---|---|
| `plenary_app` before step 3 (no grants) | refused, `denied`, names every missing right |
| `plenary_app` after step 3 (as written) | starts; read, write and delete work |
| Member of a group role with the grants, `INHERIT` | starts, works |
| Member of a group role with the grants, `NOINHERIT` | refused. **Correct:** a plain `SELECT` as that role also fails with "permission denied for table reg_tenants" |
| SELECT only | refused, names INSERT, UPDATE and DELETE only |
| All table rights, no schema USAGE | refused, `denied` |

### SQLite hard cap

| Check | Result |
|---|---|
| The builder's 2× scenario, new code | 3 of 3 runs pass |
| The same scenario, HEAD's code | 2 of 2 runs fail, at 2029 and 2086 ms |
| `busyTimeoutMs: 0` | opens; `busy_timeout` reads 0 |
| Contended open (WAL file, 600 ms writer, budget 1000) | `busy_timeout` reads 1000 afterwards, **with or without** the restore line. The restore only matters after a retry loop, and no test reaches it (L3) |
| Throw paths | the handle is never returned, and HEAD doesn't close it either (L5) |

### Mutations (scratch copy of the tree; `test/server/pg-registry.test.js` or the SQLite tests)

| Mutation | Killed by |
|---|---|
| M1: drop the `lock-timeout` mapping | the table-lock test and the caller-`sql` write test |
| M2: drop the `statement-timeout` mapping | the row-lock `setGrant` test |
| M3: drop the start-up `set_config` | the start-up lock test, at the 5 s test timeout. Which leg hung was inferred, not run separately: the `sql` leg's client has no session limits, while the `url` pool still has its own `lock_timeout` |
| M4: drop `DELETE` from the probe's rights | the probe test |
| M6: drop the timeouts from `write()` | the caller-`sql` write test |
| M5: put HEAD's `sqlite.js` back (cap undone) | the hard-cap test (2029 ms and 2086 ms) and the pragmas test |
| M7: drop only the `busy_timeout` restore | **survives** (L3) |

### Gates

- **This job's tests, with `DATABASE_URL`** (pg-registry, registry, sqlite open): 77 pass, 0 fail.
- **Full `bun test` without `DATABASE_URL`:** 1130 pass, 118 skip, 4 fail.
- **Full `bun test` with `DATABASE_URL`, first run:** 1223 pass, 34 skip, 5 fail, 1 error. Both the pg-store fence
  failure and the error ("Unhandled error between tests": a `PortError` "the lease row is locked by another session",
  from server/store/postgres.js:158 via `renew`) are under `test/server/pg-store.test.js`. That run shared Postgres with
  my lock experiments.
- **Full `bun test` with `DATABASE_URL`, re-run alone on a fresh, idle container:** 1235 pass, 34 skip, 2 fail, 0 errors:
  core-source and tune's "M2/LOW 5: a count change sends the count-only `here`…".
  - That tune test is new: `test/server/tune.test.js` is untracked and is being edited live by another session.
  - Tune's rig uses the in-memory registry (test/server/rig.js:30), so its results can't depend on this job's adapters.
  - Over 3 more runs in the tree, tune passed twice and failed `here: bounded…` once. It passed 16 of 16 in a scratch
    copy with HEAD's adapters, and 16 of 16 twice with this job's adapters. So it is flaky, and not this job's.

| Failure | Whose |
|---|---|
| `test/core-source.test.js` | known (herdr-draw's tree is dirty) |
| `tune.test.js` R2 ×2 | known; reproduces in a scratch copy of the tree with HEAD's two Registry adapters |
| `tune.test.js` "here: bounded with many viewers" | not this job's: reproduces with HEAD's two adapters (engine's tune work) |
| `pg-store.test.js` "fence: an append waits on a takeover's…" and the unhandled error (first DB run only) | not this job's: the Store's files are not in this diff, it passed 3 of 3 runs alone, and it did not recur in the clean full re-run. It ran while my lock experiments loaded the same Postgres |
| `tune.test.js` "M2/LOW 5…" (clean re-run only) | not this job's: the in-memory registry, a file another session is editing live, and it passes intermittently on either set of adapters |

The builder's gateway ×5 and static failures no longer occur: other sessions have since changed those files.

## Systems design (CHECKER, systems-design v0.1.0): the 15 s limit against `recheckLookupMs` (2 s) and `helloTimeoutMs` (10 s) under a stuck lock

**Load.** 100k joins in 2 min is about 830 hellos/s cluster-wide. Lookups per hello are 3–5 cold and 0 warm (p5-load).
Bun's default pool is `max` 10 per node.

| Check | Verdict |
|---|---|
| **Failure of the DB tier is discussed** | Partly. The adapter bounds the server side, but H1 means the caller-side bound is N × 15 s for the N-th queued call |
| **Fails closed** | Yes. A hello that gets no welcome is closed at `helloTimeoutMs` 10 s (gateway.js:39, :1045), so `unavailable` and the client reconnects. The re-check's 2 s race (gateway.js:557) frees the pass, and R2 backs off |
| **Back-of-envelope** | Under a stuck lock on `reg_grants`, each connection finishes one call per 15 s, about 0.7 calls/s per node, against hundreds of arrivals per second. So the client-side queue grows without bound: about 50k pending lookups per minute cluster-wide. The k-th rejects at about ⌈k/10⌉ × 15 s, minutes to hours later, long after the gateway gave up at 2 s or 10 s |
| **Abandoned work** | The gateway's races don't cancel the Bun call. Every abandoned lookup still takes a connection when its turn comes: 15 s each while the lock lasts, about 1 ms after it clears |
| **Recovery** | Automatic, but delayed. After the lock clears, the backlog drains at about 10 connections × 1 ms, roughly 10k/s per node, and new hellos wait behind it |
| **Blast radius** | M1: once every connection is busy, reads of unlocked tables stall too, so a lock on one table is an outage of all joins on that node |
| **Reconnect pressure** | Hellos that fail at 10 s bring reconnects back into the same queue; client back-off is the only brake |

**Recommendation.** Not changed here (it's a builder or engine decision):

1. **Bound calls in the adapter** with a client-side deadline plus a bounded in-flight gate that sheds load with a
   coded rejection at once (fixes H1 and M1, and stops abandoned work from taking connections).
2. **Use a lower cluster `statementTimeoutMs`** (3–5 s, above `recheckLookupMs`), as the builder suggested, so each
   stuck call pins a connection for less time.
3. **Keep fail-closed and no retry inside the adapter.** Both are right.

## Builder's open points, graded

| Builder's point | Verdict |
|---|---|
| Reads on a caller's `sql` are unbounded | LOW (L1). No production path passes `sql` |
| A queued call can reject with another call's timeout | **Wrong as described.** In the warm case each call waits its own full limit in turn (H1) |
| Equal defaults read as `statement-timeout` | Confirmed (L4) |
| `set_config(…, true)` is transaction-local | Confirmed |

## Not verified

- **Translated server messages** (L2): this image has no translations.
- **PG ≤ 14, Docker and Linux SQLite.** Only Podman, Postgres 17 and macOS were run.
- **The H1 numbers at real pool sizes and node counts.** The serialisation was measured on `max` 1 and 2 and extrapolated.
- **Bun's queueing internals.** Observed only.

## Clean-up

- **Container:** Podman container `5d51498768eb…`, which I started (id recorded in the scratchpad), was removed by its id, and `podman ps -a` no longer lists it. The other running
  Postgres container, `34524fdf553f`, belongs to another session and was not touched.
- **Database leftovers:** test schemas, roles and the `plenary` database lived only inside that container. One `pl_%`
  schema was left in the first container at the end. It was never identified; the likely source is my first `exp1.js`
  run, which was killed mid-E2.
- **Second container:** `8ad1db430304…`, started for the leak checks and the clean re-runs, was removed by its id afterwards.
- **Code:** no code was edited and nothing was committed. The scratch tree copy is in the session scratchpad.
