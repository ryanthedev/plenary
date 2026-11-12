# Report: p5-pgpriv3v (verify p5-pgpriv2 Round 3: the client-side Registry bound)

**FAIL, narrowly, on one clause of the bar.** The fix is small: a deadline check in `send()` plus one test.
Everything else passes:

- **Round 2's H1 and M1 are fixed.** Behind a stuck lock, every Registry call on Postgres now settles by about 1.0 ×
  the lock limit (up to 1.24× when calls arrive spread out), sent or not, with coded errors.
- **Unsent calls are proven unsent** by the server's own log.
- **The gate recovers.** Pool and gate return to 0/0 on every error path tried.
- **Tests catch regressions.** Every mutation the brief lists, plus three more, makes a test fail.

**The clause that fails:** "a call whose deadline passed before it got a connection is never sent".

- **What happens:** when the event loop stalls past a queued call's deadline, the call is sent once the loop resumes,
  and it commits. This happened in 7 of 7 stalled trials; the control without a stall stayed in time (M1 below).
- **Impact (for the manager's waiver decision):** the caller is never misled. It never received `queue-timeout`,
  it gets the real answer, and it is still bounded by the server limits. Graded MEDIUM for that reason.
- **Why FAIL and not PASS:** the bar states this clause outright, and Round 2 was failed on a bar sentence that did
  not hold.

If the manager prefers to waive it, M1 becomes a follow-up item.

Target: the six job files, sha1-pinned at start (`pins.txt` in the scratchpad) and re-checked after the last run (see
Clean-up). Postgres 17 (alpine, Podman), Bun 1.4.4 (`bun --version`), macOS. Experiment scripts are in the session
scratchpad, `exp/` (`a.js` … `st.js`), and the mutation copies are in `mut/`.

## Findings

| # | Grade | Finding |
|---|---|---|
| M1 | MEDIUM | A queued call is sent after its deadline if the event loop stalls: `send()` never checks the clock, and only the queue timer enforces the deadline |
| L1 | LOW | Healthy-pool bursts are shed: more than `maxInFlight + maxQueued` (110) calls at once get `overloaded`, even though the pool answers 110 calls in 6 ms. `maxQueued` could be much larger at no cost to the bound, because `queueTimeoutMs` (not the queue's length) bounds the wait |
| L2 | LOW | With the 15 s defaults, `queueTimeoutMs` is 3050 ms, above the gateway's 2 s `recheckLookupMs`. So a re-check the gateway has already given up on can still be sent (abandoned work). The README's 3–5 s cluster setting (0.65–1.05 s) avoids it; the README doesn't say this is a reason |
| L3 | LOW, documented | A caller's `sql` shared with another user brings Bun's queueing back: calls stack again (codex's HIGH, reproduced, see the ensemble). The header and README say to pass `maxInFlight` below the pool size then. No production path passes `sql` |
| L4 | LOW, documented | A call that never settles holds its slot for as long as it is pending (codex's MEDIUM). Measured with a paused server: slots are held while it is paused and return to 0 within 211 ms of resuming. This is the builder's own stated risk |
| L5 | LOW | Very small limits break the 1.5× bound: with arrivals spread out, the worst call took 1.24× at a 1000 ms limit but **1.75× at 100 ms**, because of the fixed +50 ms in `queueTimeoutMs`. No real setting is that small |
| L6 | LOW, carried | Round 2's L2 (the English-message match for `statement-timeout`) and L5 (SQLite handle not closed when start-up throws) are unchanged, as the builder says |

### M1: a queued call is sent after its deadline when the loop stalls

**Code.** `send()` (server/registry/postgres.js:385) is called from `pump()` when a running call settles. It does not
compare the clock with the call's deadline. The deadline is enforced only by the queue timer (:401), which is a
macrotask, while `pump()` runs in a microtask after the I/O callback. So after a stall, the I/O and its microtasks run
before the overdue timer gets its turn.

**Run (`exp/b3.js`).** Setup:

- **Limits:** `max: 1`, lock 1000 ms, statement 10 000 ms, so `queueTimeoutMs` is 250 ms.
- **The lock:** `psql` inside the container holds a table lock on `reg_grants` and releases it **on the server** after
  `pg_sleep(0.2)`, independent of my event loop. The lock is confirmed held in `pg_locks` before t0.
- **The calls:** A `grant()` is sent; B `setGrant(tag)` is queued behind it.
- **The stall:** at 10–11 ms the loop is blocked with `Bun.sleepSync`. The lock clears at about 190 ms, during the
  stall.

| Stall | Trials | A | B (deadline 250 ms) | B's row committed |
|---|---|---|---|---|
| 600 ms | 5 | ok at 612–616 ms | **ok at 616–624 ms** | **yes, 5 of 5** |
| 330 ms (just past the deadline) | 2 | ok at 343–345 ms | **ok at 347–352 ms** | **yes, 2 of 2** |
| none (control) | 1 | ok at 214 ms | ok at 231 ms (in time) | yes |

So a call is sent late by exactly the loop lag. An earlier version (`exp/b.js`) released the lock from the same loop
before the stall. In 2 of its 5 trials A settled before the stall, so those trials did not test the clause; `b3.js`
replaces it.

**Against the bar.** "A call whose deadline passed before it got a connection is never sent" fails under load.

**Why MEDIUM, not HIGH.**

- **Callers stay correct.** No caller is told `queue-timeout` for a call that ran, so the claim "`queue-timeout` means
  nothing happened" still holds. The caller just hears back later than `queueTimeoutMs`.
- **The stall is the trigger.** It happens exactly when a node is overloaded (GC, a burst of hellos). Then an abandoned
  call, one the gateway's 2 s race has already given up on, can still take a connection.

**Fix (cheap).** Store each call's `deadline = performance.now() + queueMs`. In `send()` (or in `pump()`), reject an
entry with `queue-timeout` instead of sending it once its deadline has passed, then try the next entry. Add a test
along the lines of `exp/b.js`: release the lock, block the loop with `sleepSync`, and assert B is absent.

## Checks run (Postgres 17, my own container, statements logged with parameters)

### H1 and M1 of Round 2: no stacking, and an unrelated read is bounded

| Case (`exp/a.js`, `c.js`, `c2.js`, `st.js`) | Result |
|---|---|
| **Partly warmed pool** (only sequential calls before the lock), `max` 4 and 10, `max` calls and `max` + 6 calls, lock 1 s / statement 10 s | the sent calls get `lock-timeout` at 1002–1012 ms and the rest `queue-timeout` at 251 ms. **Nothing stacks.** Bun had opened every pooled connection by then |
| **Truly cold** (`rl.js`: no call before the lock), `max` 4, 9 × `grant()` with `board()` among them | 4 × `lock-timeout` at 1003 ms, 6 × `queue-timeout` at 251 ms (the `board()` included) |
| **Row lock** (`rl.js`: another session holds `SELECT … FOR UPDATE` on the board row), `max` 2, 6 × `setGrant` | 2 × `lock-timeout` at 1003 ms, 4 × `queue-timeout` at 251 ms, gate 0/0. A `board()` read of that row answers at 2 ms (a plain SELECT doesn't wait on a row lock) |
| **Table lock on `reg_boards`** (`c.js`, `max` 1, `maxQueued` 3, 6 × `setGrant`) | `lock-timeout` at 1005 ms, 3 × `queue-timeout` at 250 ms, 2 × `overloaded` at 0 ms |
| **Advisory lock** | only start-up takes one (postgres.js:149), outside the gate and bounded by `lock_timeout`. The builder's start-up test passes. No runtime call takes an advisory lock |
| **Unrelated read with a spare connection** (`rl.js`, `max` 4, 2 locked `grant()`s) | `board()` is `ok` at 2 ms |
| **Never sent, proven by the server** (`c2.js`, `max: 2`, 8 tagged `grant()`s) | the log between `LOCK TABLE` and `ROLLBACK` shows exactly 2 statements on `reg_grants` (two `lock timeout` errors, backends 132 and 133). The six `queue-timeout`/`overloaded` calls never reached Postgres |
| **Unrelated read on a saturated pool** | the builder's test: `overloaded` in under 50 ms, otherwise `queue-timeout` within `queueTimeoutMs`. Re-run passes |
| **Gate full** | `overloaded` at 0 ms (`c.js`, `c2.js`, `h2.js`) |
| **Late but in time** (`c.js` F: lock released at 200 ms, deadline 250) | the queued call is sent and answers `ok` at 205 ms |
| **Small limits, everything at once** (`c.js` G, 100 and 300 ms) | worst 1.01× |
| **Spread-out arrivals** (`st.js`, one call every limit/20) | worst 1.24× at 1000 ms and 1.75× at 100 ms (L5) |
| **Recovery after the lock clears** | every case: `gate()` 0/0, and the next call answers in 1–2 ms |

### Round 2's checks still hold

| Round 2 check | Evidence this round |
|---|---|
| Start-up is bounded (advisory lock) | the builder's start-up lock test, in the 85-test run with `DATABASE_URL` |
| Privilege probe (`denied`, names the missing right) | the probe and runtime-role contract tests, in the same run (the role-creating paths ran: the container's superuser can create roles) |
| SQLite busy budget is a hard cap | the cap test passes; Round 2's cap mutation was not re-run, and the `sqlite.js` hunk is unchanged since p5-pgpriv2v (only the restore line is new) |
| Error pass-through | `e.js`: `pg_cancel_backend` and `pg_terminate_backend` come through as raw Postgres errors; validation errors, `last-owner` and the duplicate-domain error are unchanged |
| No half-done writes | the builder's never-sent test (u2 absent) and `b3.js`/`c.js` (rows only for calls that got a connection). Round 2's per-table half-done checks were not re-run; `write()` is unchanged since then |

### Dead peer (`exp/d.js`, `podman pause` on my own container)

| Check | Result |
|---|---|
| 2 sent calls, lock 1 s / statement 2 s | `client-timeout` at 3001 ms (= larger limit + 1 s) |
| Queued calls and later arrivals | `queue-timeout` at 250 ms, then `overloaded` at 0 ms once the queue is full |
| Slots while paused | `running` 2: held until the real settle, as designed |
| After unpause | `gate()` 0/0 within 211 ms; the next call is `ok` at 1 ms |

The builder reasoned about this case but did not run it. It is now confirmed.

### Slot accounting on every error path (`exp/e.js`)

Every case left `gate()` at 0/0:

- **Validation:** an unknown board, and a non-string id (the synchronous key check).
- **`last-owner`.**
- **Duplicate domain:** sequential, and two creates racing.
- **`pg_cancel_backend`:** the raw error passes through, as designed.
- **`pg_terminate_backend`** on two waiting calls: the next 6 calls succeed.
- **`close()` with 2 calls in flight and 3 waiting:** the waiting ones get "registry: closed" at once, the in-flight
  ones get `lock-timeout`, `close()` resolves, and a later call gets "registry: closed".

### Healthy pool (`exp/h2.js`, defaults, nothing locked)

| Check | Result |
|---|---|
| Service time, sequential | `grant` 0.17–0.19 ms, `board` 0.18 ms, `tenantByDomain` 0.45–0.54 ms, `setGrant` 1.0 ms |
| `db.options.max` on a default `url` pool | 10, so `maxInFlight` defaults to 10 as the header and README say |
| Bursts of `grant()` all at once | 100 and 110: all `ok` in 6–7 ms. **200: 90 `overloaded`. 2000: 1890 `overloaded`** (L1) |
| Sustained 3,300 calls/s (100 every 30 ms for 2 s) | 6,600 of 6,600 `ok` |

### Mutations (scratch copies of the tree, `mut/`, run against real Postgres)

| Mutation | Killed by |
|---|---|
| Drop the queue deadline | 7 tests: the table-lock test, all 4 warm tests, never-sent, saturated pool |
| Drop the gate (send at once) | the same 7 |
| Never release the slot (no `running--`) | the contract suites (every test times out after the gate fills), 19+ tests |
| Release the slot early (when the backstop fires) | "reads on a caller's sql … client-timeout" (asserts the slot stays counted) |
| Reject at the deadline but leave the entry queued (it is sent later) | never-sent, saturated pool |
| `maxInFlight` = pool `max` + 1 (Bun queues again) | the same 7 as the queue-deadline mutation |
| No backstop | the caller-`sql` client-timeout test (and its hook) |
| SQLite: no `busy_timeout` restore | "open while another process holds the new file's write lock" (L3 of Round 2: fixed) |
| (not a mutation) send after the deadline under a loop stall | **no test**: M1 |

### Docs

| Claim | Verdict |
|---|---|
| Header "The gate" and the codes in `PgRegistryError`'s JSDoc | accurate; the old "Not covered: time queued in Bun's pool" is gone |
| "Each call holds one connection at a time" | true: every multi-statement read awaits its statements one after another, and writes are one `begin` |
| README table (defaults, codes, `client-timeout` "may still have taken effect") | accurate against the code and the runs |
| README "queued calls give up after about 0.65–1.05 s" at 3–5 s | arithmetic right (0.2 × 3000 + 50, 0.2 × 5000 + 50) |
| README "every call settles by about 1 × the lock limit" | true when calls arrive together; up to 1.24× when spread out (L5). Close enough at real limits |
| 3–5 s recommendation vs the gateway's 2 s | `recheckLookupMs` is 2000 (server/gateway.js:81) and `helloTimeoutMs` is 10 000 (:39), as stated. L2: the README could add that 3–5 s also keeps `queueTimeoutMs` under 2 s |
| README anchors | `#cluster-phase-4-not-functional-yet` still resolves; the section moved below the Postgres one |
| Consumers of the new codes | nothing in server/, web/ or packages/ matches `client-timeout`, `queue-timeout` or `overloaded`. Every rejection becomes `unavailable` (gateway `down("role")`), so no consumer misses the fifth code |
| Proposed registry-port.js wording (report, end of Round 3) | accurate. It could say "about queueTimeoutMs + the limit" instead of implying a hard bound (M1, L5) |

### L1, L3 and the other Round 2 LOWs

| Round 2 LOW | Now |
|---|---|
| L1 (reads on a caller's `sql` unbounded) | **fixed for the caller** by the backstop (`client-timeout`); the connection stays busy until the lock clears, as documented |
| L2 (English message) | unchanged, documented as not verified |
| L3 (SQLite restore untested) | **fixed:** the restore mutation is killed |
| L4 (equal limits read as `statement-timeout`) | unchanged, documented in the README table |
| L5 (SQLite handle not closed on a throw) | unchanged, pre-existing |

## Ensemble review

- **Ran:** codex (effort high) and grok, each on its own scratch copy of the tree with the Round 3 diff.
- **Not run:** agy (quota exhausted, resets in about 53 h), kimi (not logged in), mistral (no API key) and qwen (not
  installed), all per `check_adapter`.
- **Agreement:** the one area both raised is slots held by calls that never settle (codex MEDIUM, grok HIGH), but by
  different mechanisms. Confirmed only for codex's mechanism, which the builder already documented.

| Claim | Source | Result |
|---|---|---|
| A shared caller `sql` lets Bun queue again; a queued write may commit after `client-timeout` | codex HIGH | **Stacking confirmed, graded LOW (L3).** `exp/s.js`: on `max: 2` with one connection reserved elsewhere, the second call settles at 1005 ms against a 500 ms limit. **The commit after `client-timeout` was not attempted as codex described.** My run used two writes, which `SET LOCAL` bounded before the backstop; codex's case needs an unbounded read pinning the free connection while a write waits in Bun. It is plausible: a backstop rejection does not remove a call from Bun's queue. It is documented (pass `maxInFlight` below the pool size when shared), and no production path passes `sql` |
| A never-settling call holds its slot forever | codex MEDIUM | **Confirmed as documented (L4).** Held while the server was paused, released 211 ms after it resumed |
| A stale `timer` shared across calls can clear another call's backstop | grok HIGH | **Refuted.** `timer` and `settled` are declared inside each call's Promise executor (:383), so no two calls share them. Every run ended at 0/0, and the backstop fired at 3001 ms with queue timeouts happening alongside it (`d.js`) |
| `settle(reject)` throwing in the queue timer leaks a slot | grok MEDIUM | **Refuted.** A queued call never took a slot (`running` is only incremented in `send`), and a Promise's `reject` does not throw |
| `pg_cancel_backend` passes a raw 57014 | grok LOW | **Refuted as a bug.** By design, any other cancel passes through (the bar: error pass-through) |
| SQLite restore removal not caught | grok MEDIUM | **Refuted.** The mutation is killed (table above) |
| Tests loose on gate state | grok LOW | **Partly:** the gap that matters is M1, which has no test. The other paths are covered by mutations |

## Gates

| Run | Result |
|---|---|
| pg-registry, registry, sqlite open, with `DATABASE_URL` | 85 pass, 0 fail (pg-registry alone in the base copy: 59 pass) |
| Full `bun test` with `DATABASE_URL` | 1262 pass, 34 skip, **1 fail:** `core-source` (known) |
| Full `bun test` without `DATABASE_URL` | 1158 pass, 133 skip, **3 fail:** `core-source` (known); tune "here: bounded with many viewers" (known); wire2 "cap, then \`auth\` on the automatic retry…" |

The wire2 failure is not this job's:

- **The file:** `test/web/collab/wire2.test.js` is untracked, another session's work, and the brief names this file as
  known.
- **No registry:** it imports only web/ and core modules, so it cannot reach either Registry adapter.
- **Its name differs** from the brief's "LOW-1: limited…" test, because that session is still editing the file.
- **It passed elsewhere.** It passed in the later full run with `DATABASE_URL` (which ran 3 more tests, 1297 vs 1294,
  so the file changed in between). Alone, 3 of 3 runs passed in a scratch copy with HEAD's two Registry adapters, and
  3 of 3 with this job's.

Each full run had my Postgres to itself: no experiment ran during it.

## Systems design (CHECKER, systems-design v0.1.0): the gate at 830 hellos/s cluster-wide

**Load.** 830 hellos/s × 3–5 lookups (cold) is about 3,300 calls/s. `role()` (server/auth/tenancy.js:69-76) awaits
its lookups one after another, so each hello holds at most one slot at a time.

| Check | Verdict |
|---|---|
| **Back-of-envelope** | Measured service time on loopback is about 0.2 ms per read and 1 ms per write. A real same-region round trip is more like 1–2 ms per call. Then 10 slots serve about 5–10k calls/s, so 3,300 calls/s on **one** node is 33–66% busy, and on 10 nodes 3–7%. Healthy pools rarely queue in a cluster, but a single node at full join rate runs with modest headroom, and its burst tolerance is the queue (next row) |
| **Failure of the DB tier** | A stuck lock is bounded at about 1.0–1.25 × the lock limit per call (measured), and a dead peer at the larger limit + 1 s (measured). Fail-closed: every rejection becomes `unavailable` |
| **Load shedding (the rate-limit item)** | Present and fast. But the shedding point is set by queue **length** (110 calls at once), not by time. A burst over 110 simultaneous calls on one node is shed while the database is healthy (L1). Because a hello holds one slot at a time, such a burst needs more than 110 hellos mid-lookup at once on one node: at a 1–2 ms round trip, about 55–110k hellos/s arriving in a burst. Steady 830/s is far below that, but a reconnect storm (a gateway lost, and its thousands of sockets reconnecting through the load balancer within a few ms, if clients don't jitter) can reach it. The wait is already bounded by `queueTimeoutMs`, so a `maxQueued` of 10–100 × higher costs no latency under a stuck lock, only memory and the wait before failing. Recommend sizing it from rate × `queueTimeoutMs` (e.g. 3,300/s × 1 s, about 3,000) instead of 10 × slots |
| **10× load** | 33k calls/s at 0.2 ms needs about 7 slots busy in steady state: within 10 slots on one node, comfortable across several nodes. Shedding bursts (above) is the limit, not throughput |
| **Abandoned work** | Gone in the normal case: `queue-timeout` calls are never sent (log-proven). Two leaks remain: M1 (after a loop stall), and L2 (with the 15 s defaults, `queueTimeoutMs` 3.05 s is above `recheckLookupMs` 2 s). Both are closed by the M1 fix plus the README's 3–5 s setting |
| **Blast radius** | Still node-wide during a stuck lock (one gate for all tables), but now fail-fast instead of a stall. Accepted and documented by the builder; a per-table gate is not needed at these numbers |
| **Single point of failure** | Unchanged by this job (one Postgres; replication is M7/M8 work) |

**Verdict.** The gate's size is right for throughput, and its deadline is right for the 3–5 s cluster setting. Raise
the queue length (L1) and add the deadline check in `send()` (M1).

## Not verified

- **Dead TCP peer.** I used a paused container, which keeps the socket open. A peer whose socket is reset, or a real
  network partition, was not run.
- **Real node counts and load-balancer reconnect storms.** The design numbers above are measured on one node and
  extrapolated.
- **Translated server messages, PG ≤ 14, Docker and Linux.**
- **Bun's internals.** Observed only: Bun opened every connection of a 4- and 10-connection pool before the lock, and
  spread `max` sent calls across them.

## Clean-up

- **Container:** Podman container `9b82ba2e141e…` (started by me, id in the scratchpad `container.txt`) was removed
  by its id after the last run, and `podman ps -a` no longer lists it. The engram, opensearch, k3d and omniai containers
  belong to others and were not touched.
- **Database leftovers:** test schemas lived only in that container.
- **Code:** no code edited, nothing committed. Scratch copies (`review/`, `mut/`) and scripts (`exp/`) are in the
  session scratchpad.
- **Pins:** the six job files' sha1s matched the start-of-job pins when re-checked after the last run (`shasum -c`, all OK).

**Question for t187:** waive M1 (the send-after-deadline clause) as a follow-up, or send p5-pgpriv3 back for the `send()` deadline check plus its test?

# Re-check Round 4 (p5-pgpriv4v)

**PASS.** M1 is fixed. A queued call whose deadline passed during an event-loop stall now rejects with
`queue-timeout`, is never sent (the server's statement log confirms it), and the gate returns to 0/0. The builder's new
test fails with the check mutated away. No Round 3 check regressed. The README's new Postgres text matches
`server/store/postgres.js`, and "never ALTER, DROP or GRANT" still holds. Gates: only failures from other sessions'
files.

Target pinned at start (`pins4.txt` in the scratchpad). The six job files matched again at the end.
`server/store/postgres.js` changed during the run (another session's edit), so I re-read it at the end; every fact
the README relies on is unchanged (table below). Fresh Podman Postgres 17 (alpine) with `log_statement=all`, Bun 1.4.4.

## Findings

| # | Grade | Finding |
|---|---|---|
| — | — | No new findings |
| L1 | LOW, documented | Bursts over `maxInFlight + maxQueued` get `overloaded` on a healthy pool. The README now says so and how to raise it; the default is unchanged (the brief allowed a note only) |
| L3, L4, L5, L6 | LOW, carried | Unchanged, as the builder says: shared pool, slot held by a call that never settles, 1.7× at 100 ms limits, Round 2's L2/L5 |

## M1: re-run of `exp/b3.js`

The setup is as in Round 3: `max: 1`, `queueTimeoutMs` 250 ms, the lock held by `psql` in the container and released
by the server after `pg_sleep(0.2)`, and the loop stalled at 10–11 ms.

| Stall | Trials | A | B (deadline 250 ms) | B's row | Gate after | B's statements in the server log |
|---|---|---|---|---|---|---|
| 600 ms | 5 | ok at 612–616 ms | **`queue-timeout` at 612–616 ms** | absent | 0/0 | **none** (the tag appears only in my own check query) |
| 330 ms (just past) | 2 | ok at 344–346 ms | **`queue-timeout` at 344–346 ms** | absent | 0/0 | **none** |
| none (control) | 1 | ok at 205 ms | ok at 212 ms | present | 0/0 | `FOR UPDATE`, `SELECT role`, `INSERT`, `COMMIT` |

- **Code:** `pump()` (server/registry/postgres.js:386-391) now expires an entry past its deadline instead of sending
  it. `expire()` goes through `settle` (which clears the queue timer) and never increments `running`, so no slot is
  taken on that path.
- **The fast path** (`if (running < slots) return send()`) only runs with an empty queue in practice, because `pump()`
  drains the queue whenever a slot frees.

**Mutation.** In a scratch copy, `pump()` always calls `send()`. The builder's test "a queued call whose deadline
passed during an event-loop stall is not sent when the connection frees" fails 3 of 3 times
(`Expected: "queue-timeout" Received: "ok"`), and passes 3 of 3 in an unmutated copy.

## No regression (Round 3 scripts, re-run)

| Check | Result |
|---|---|
| No stacking, partly warm (`a.js`, `max` 4 and 10, +0 and +6 calls) | sent calls `lock-timeout` at 1001–1004 ms, the rest `queue-timeout` at 251 ms |
| Truly cold, row lock, spare connection (`rl.js`) | cold: 4 × `lock-timeout` 1003 ms, 6 × `queue-timeout` 251 ms (`board()` included). Row lock: 2 × `lock-timeout`, 4 × `queue-timeout`, gate 0/0. Unrelated `board()` with a spare connection: ok at 0 ms |
| Gate full (`c2.js`) | 3 × `overloaded` at 0 ms |
| Spread-out arrivals (`st.js`) | worst 1.25× at 1000 ms, 1.71× at 100 ms (L5, unchanged) |
| Dead peer (`d.js`, my container paused) | `client-timeout` at 3001 ms; slots held while paused; 0/0 within 169 ms of resuming; next call ok |
| Slot accounting (`e.js`) | 0/0 after validation, `last-owner`, duplicate domain, cancel, terminate, and `close()` with calls in flight and waiting |

## Docs

| Claim (deploy/README.md, Postgres section) | Checked against | Verdict |
|---|---|---|
| L2: 3–5 s keeps `queueTimeoutMs` at 0.65–1.05 s, below the 2 s `recheckLookupMs`; 3050 ms with the 15 s defaults | the formula at postgres.js:380, gateway.js:81 | correct (also in the header) |
| L1: bursts over `maxInFlight + maxQueued` (110) get `overloaded`; `queueTimeoutMs` bounds the wait, not the queue length | Round 3's `h2.js` measurements | correct |
| Store probes at start-up, code `denied`, names what's missing, message `postgres store: …` | store/postgres.js:119-125 (probe), :133-137 (`denied`) | correct |
| Store needs `pl_entries` SELECT, INSERT; `pl_checkpoints` SELECT, INSERT, DELETE; `pl_leases` SELECT, INSERT, UPDATE | `NEEDS`, store/postgres.js:80-84 | correct |
| "the epoch fence's `FOR SHARE` needs `UPDATE`" | ran on PG 17: a role with only SELECT gets "permission denied for table" on `SELECT … FOR SHARE`; with SELECT, UPDATE it succeeds | correct |
| Step 3's grants cover both | README step 3: SELECT, INSERT, UPDATE, DELETE on all tables, plus default privileges | correct |
| Upgrade paragraph: `needs-migration`, the ALTER, columns `holder TEXT`, `expires_at BIGINT` | `LEASE_COLUMNS`, `LEASE_UPGRADE_SQL` (:69-76), the start-up check (:113-118); text matches p4-store-lease.md:52-55 | correct |
| "They never ALTER, DROP or GRANT anything" (README:93); "nodes still never ALTER" (:152) | the only `ALTER` in either adapter is the `LEASE_UPGRADE_SQL` string, which goes into an error message and is never executed; no DROP or GRANT is executed | still true |
| Only the Postgres section touched by this job | README diff: the endpoints hunk near line 20 is another job's, as in Round 3 | correct |

## Gates (own container, nothing else running against it)

| Run | Result |
|---|---|
| pg-registry, registry, sqlite open, with `DATABASE_URL` | 86 pass, 0 fail |
| Full `bun test` with `DATABASE_URL` | 1336 pass, 35 skip, **2 fail:** `core-source` (known); `test/web/collab/perf.test.js` "C-1: a pan frame is O(1) in pins…" |
| Full `bun test` without `DATABASE_URL` | 1233 pass, 136 skip, **1 fail:** `core-source` (known) |

The C-1 failure is not this job's:

- **Its file:** `test/web/collab/perf.test.js` is untracked, another session's new work.
- **No registry:** it has no registry import.
- **It's a timing test** (15 ms run).
- **It passed elsewhere:** in the run without `DATABASE_URL`, and 3 of 3 times alone.

## Clean-up

- **Container:** Podman container `d16243f02aad…` (mine, id in the scratchpad `container4.txt`) was removed by its id,
  and `podman ps -a` no longer lists it. The `FOR SHARE` probe's table and roles lived only in it.
- **Code:** no code edited, nothing committed. The mutation copies (`mut/r4base`, `mut/r4_nocheck`) are in the
  scratchpad.
