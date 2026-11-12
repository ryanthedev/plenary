# Report: p4-host (the room host holds a Store lease; every write is fenced)

Worker t1h5 (engine), manager t18m. Not committed (brief: the manager commits).

**Outcome:** the room host now builds a room only under the board's Store lease, on one path for a single node and a
cluster. Every Store write is fenced with the lease epoch, and an append or checkpoint with no epoch is refused.
Nothing in the server calls `openEpoch` any more. All gates are green; see "Checks run" below.

## What changed (files)

| File | Change |
|---|---|
| server/room-host.js | Lease claim (`acquire`), renew every ttl/3 from before the rebuild, host deadline by `performance.now()`, `lost()` → `fail()` with no release, holder-only inbox, watch + takeover of a board held elsewhere, dead-holder hello answers, fenced log adapter, clean `close()` → checkpoint → settle writes → `release`. New options `holder`, `hostname`, `leaseTtlMs` (10 s), `watchIdleMs` (60 s). New export `newHolder()`. `stats()` adds `waiting`. Uses `room.status()` only (F14) and `bus.flush()` without `?.` (F15). |
| server/store/sqlite.js, server/store/postgres.js | The no-epoch SEAM branch in `fence` is gone. `append` / `putCheckpoint` with no (or a non-positive-integer) epoch throw PortError `bad-entry`. Postgres: a write cut off by `idle_in_transaction_session_timeout` (SQLSTATE 25P03) throws PortError `unavailable` (R2-L2). |
| packages/protocol/ports.js | Store typedef: `epoch` required on `append` / `putCheckpoint`, documented. Bus typedef: `flush()` and `maxBytes` (F13). `MemoryLog` is unchanged in shape; a note says why (it has no lease, and a Room in a test is its only writer). |
| packages/protocol/room.js | `status()`: read-only `{ inflight, queued, unresolvedCount, tailChars, stateChars, resolved, seq, baseSeq, held, stopped }` (F14). No behaviour change. `stopped` is one field more than the brief's list; foldIfDue needs it. |
| server/bus/port.js | The port's contract text now includes `flush()` and `maxBytes` (F15). memory.js and nats.js already had both, so neither changed. |
| server/server.js | Unchanged. `host` options already pass through (`roomHost({ store, bus, log, ...host })`). |
| test/server/room-host-lease.test.js (new) | 11 tests (2 run on Postgres only), below. |
| test/server/store-contract.js | Every pre-lease case takes a lease (`own()`, exported) and passes its epoch. The SEAM assertion became "no epoch → `bad-entry`, writes nothing" (held board and never-leased board); `undefined` added to the bad-epoch list. |
| test/server/pg-store.test.js | Four tests pass epochs. M1's paused write now asserts `unavailable` (R2-L2). New R2-L1 test. |
| test/server/gateway.test.js, revocation.test.js | Only the lines that wrapped `openEpoch` now wrap `acquire`. |

### Test edits outside my file list (each approved by t18m in this session)

- **test/server/outbound.test.js:360:** the seed acquires a lease and passes its epoch to `append`.
- **test/server/gateway.test.js:287-297:** the append wrapper passes `...rest` (the epoch) through.
- **test/server/gateway.test.js:335:** the late stale append now settles `fenced`, not `conflict`. That is the
  brief's own done-when.
- **test/server/main.test.js, "kill -9 mid-stream, restart":** a new `welcomedAfterRestart()` retries the hello until
  welcomed, as a real client does. Each non-welcome must be `unavailable` (1013) or a timeout; the test fails if no
  welcome comes within `LEASE_TTL_MS + 3 s`. The test timeout went from 90 s to 150 s. Every acked-op assertion is
  kept. main.js still uses the default ttl (p4-wire's job).

## Decisions, and how each is tested

| # | Decision | Where | Test (file: name) |
|---|---|---|---|
| 1 | One path. No `openEpoch` in the server. It stays in the Store for old data; only store tests and `MemoryLog` (packages/protocol, Room tests) call it now. | room-host.js `claim`/`start` | Every rig test goes through `acquire`; gateway.test.js "the order is…" asserts the room opens via `acquire`. |
| 2 | Holder `<host>-<pid>-<random>`, overridable with `holder`. **Deviation:** `-`, not `:`, because the Store's `needId` accepts only `[a-z0-9-]{1,64}`. The host name is lowercased, sanitised and cut to 32 chars. It defaults to `$HOSTNAME`, because room-host is core and may not import `node:os`; p4-wire should pass `hostname: os.hostname()`. | `newHolder` | "holder ids: unique per instance…" |
| 3 | `leaseTtlMs` default 10 s; renew every `floor(ttl/3)` on an unref'd `setInterval`. One renew in flight at a time. | `startLease`, `renewTick` | All lease tests use short ttls. |
| 4 | Renewing starts at once, before the rebuild. The host deadline counts from the acquire's send time. | `start` | "renew starts before the rebuild…": a 1.2 s rebuild under a 600 ms ttl keeps the lease. |
| 5 | Held live elsewhere: `open()` resolves with no room and no inbox subscription. The host watches the board's `.entries` and inbox. One takeover attempt is armed per board, at ttl + max(25 ms, ttl/20) after the lease was read. The attempt asks the Store (`lease()`, then `acquire`); it never compares `expiresAt` with this host's clock. Not won: it re-arms. The watch stops after `watchIdleMs` with no `open()` and no inbox traffic for the board. | `watch`, `arm`, `attempt` | "takeover (sqlite/postgres)…"; "a live remote holder's board is never answered…" (its attempts find A live each time). |
| 6 | **Dead-holder window. What the gateway does:** a forwarded hello that gets no answer is not waited on forever. The gateway's `helloTimeoutMs` (10 s, gateway.js:39 and :1044-1048) refuses it with `unavailable` 1013. To be faster than that, the waiting host answers a hello with `unavailable` (1013) once the holder is silent (no `.entries` message for 2 heartbeats). A hello that arrives before then is held (up to 1,000). It is answered when the silence is reached, or dropped as soon as the holder is heard. When this host builds the room itself, it answers the hellos still held, because its new room never saw them. | `watchInbox`, `armQuiet`, `unwatch(key, true)` | "the dead-holder window…": answered within ttl + 3 s; retries are welcomed after takeover with seq 3 and all acked ops. "a live remote holder's board is never answered…": 10 hellos over 1.5 s, 0 answered by B. |
| 7 | Lease loss → `lost()` → `fail(slot)`, no `release`. Triggers: `renew` null; `fenced` from `append` or `putCheckpoint`; no successful renew by the deadline. The deadline is the send time of the last good renew + ttl − interval, by `performance.now()`. It is a timer re-armed on each success, so no polling. Renew errors are logged and retried at the next tick. | `armDeadline`, `renewTick`, `logOf` | "losing the lease stops the room without a release…" (null renew; fenced checkpoint with renews hung). "the host deadline…" (rooms' clock runs backwards). |
| 8 | Every write passes `slot.epoch`. No epoch → PortError **`bad-entry`**, the code the adapters already use for bad arguments (renew/release without an epoch say the same). | both adapters, contract | Contract "fence: …" (no epoch refused, nothing written). |
| 9 | `close()`: stop watches, await claims, checkpoint each live room, settle `slot.writes`, then stop renewing and `release` every lease still held. A lost lease is never released. | `close` | "clean restart…": released, checkpoint at 3, a new host opens in < 2 s with a 30 s ttl. |
| 10 | R2-L2: 25P03 → `unavailable` (never `fenced`). R2-L1: a test for the ttl/2 cap. | postgres.js `write` | pg-store "M1: a holder paused mid-write…" asserts `unavailable`; "R2-L1: a lease call's lock wait is capped…" |
| 11 | F14: `Room.status()`. room-host reads only it (`peek()` still returns the room, for tests only). | room.js | Whole suite; architecture test. |
| 12 | F15/F13: `bus.flush()` without `?.`; Bus typedef has `flush` and `maxBytes`. | room-host `idle` | bus-contract already calls `flush()` on both adapters. |

Also: the room publishes its first heartbeat **before** it subscribes the inbox. That way a watching host hears that
the holder is alive before any hello can reach both of them.

## Mutation checks

(Run in a scratch copy of the tree against room-host-lease.test.js, store.test.js and pg-store.test.js, with
DATABASE_URL set.)

**14 of 14 caught.** The first six are the brief's list.

| Mutant | Caught by |
|---|---|
| room host drops the epoch on `append` | two-host probe, takeover, clean restart, dead-holder… (7 fail) |
| room host drops the epoch on `putCheckpoint` | clean restart (both adapters), losing the lease (3 fail) |
| ignore a null renew | losing the lease: null renew |
| subscribe the inbox without the lease (build anyway when held live) | two-host probe, takeover… (5 fail) |
| `release` in `fail()` | losing the lease: lease still `h-a`, live |
| host deadline judged by the injected `now` | the host deadline (the rooms' clock runs backwards) |
| SQLite / Postgres fence accepts no epoch (the old SEAM) | contract "fence: …" on each adapter |
| Postgres ttl/2 cap removed from the lease lock wait (R2-L1) | pg-store "R2-L1: …" |
| Postgres 25P03 left raw (R2-L2) | pg-store "M1: a holder paused mid-write…" |
| renew starts only after the rebuild | "renew starts before the rebuild…" (a first, weaker mutant of mine that started it one tick later survived; it wasn't the real mutation) |
| the watcher never answers a silent holder's hello | dead-holder window |
| the watcher answers hellos while the holder is live | two-host probe, live remote holder (2 fail) |
| no `release` on close | clean restart (both adapters) |

## Done-when

| Gate | Result |
|---|---|
| Two-host probe (F5) | "two room hosts on one Store and one bus…": 4 writers across 2 gateways, 60 ops. One welcome each, acks exactly once and in order, no errors, no "room stopped", one room and one waiter, log 1..60 with no duplicates. |
| Takeover, both adapters | "takeover (sqlite)" and "takeover (postgres)": A stops renewing, its append is held past the 300 ms timeout, and B takes over. A's held append, landed after B's acquire, is `fenced`. The log holds exactly A's acked ops. eB > eA. The reconnect is welcomed at seq 3, and B goes on sequencing. |
| Clean restart | "clean restart…" (both adapters). |
| Mutation checks | Table above. |
| `bun test` (shared tree, DATABASE_URL + NATS_URL: brew postgresql@17 and nats-server with `max_payload: 2MB`, free ports, PIDs recorded, stopped after) | 1363 pass, 20 skip, **1 fail**: test/core-source (the known herdr-draw drift). |
| `bun test test/server` ×10 (no DATABASE_URL) | Runs 2–10: 217 pass, 0 fail. Run 1: 2 fails in test/server/static.test.js. Those were the manager's: t18m was editing server/static.js and static.test.js for C-16 (committed 422526c) during that run. Not this job's. |
| test/architecture.test.js, test/purity.test.js | Green (room-host imports ports and core only; no `node:os`). |
| test/server/room-host-lease.test.js with DATABASE_URL | 11 pass (the 2 Postgres takeover cases included). |

## Systems design (distributed-systems-design v0.1.0, APPLIER mode)

- **Scope:** fixed by CLAUDE.md and the brief. There is one sequencer per board, and an acked op is never lost.
  Editors need < 150 ms. A takeover should take seconds. Single node and cluster share one code path.
- **Estimate:**
  - **Holders:** each held board costs 1 renew write per ttl/3, which is 0.3/s at 10 s. 1,000 boards make
    300 lease writes/s cluster-wide, each a one-row primary-key update.
  - **Watchers:** a watching host makes ≤ 1 `lease()` read per watched board per ~10.5 s. 10 hosts × 1,000 boards is
    ≤ ~860 primary-key reads/s in the worst case. `watchIdleMs` bounds it to boards that still have writers
    somewhere, because gateways list their writer connections on the inbox every 5 s.
  - **Fenced appends:** they add one `FOR SHARE` row lock per append.
- **High-level design:** gateway → `rooms.open` → claim. Won: renew + build + inbox. Held: watch (`.entries` +
  inbox) + timed attempt. Writes go through a log adapter fenced with the lease epoch.
- **Deep dive (failure walk):**

  | Failure | What happens |
  |---|---|
  | Holder dies | Its lease lapses within ttl. A watching host's attempt wins within ttl + 5%. Hellos in between get `unavailable` once 2 heartbeats are missed. |
  | Holder partitioned from the Store | Renews fail. The host deadline stops its room at ≤ ttl − ttl/3 after the last good renew's send, before the Store can hand the lease to anyone. The fence also refuses any write that is late anyway. |
  | Holder partitioned from the bus only | It keeps the lease and the board is down for writers until the partition heals. **Not handled:** nothing makes a holder give up a lease because it can't reach the bus. |
  | Store down | Renew errors are retried until the deadline, then the room stops. Opens fail (`down("room")` at the gateway). |
  | Clock skew between hosts | Irrelevant. Expiry is judged by the Store; hosts measure only their own elapsed time (`performance.now()`). |
  | GC pause longer than ttl on the holder | The deadline timer fires late, but any write after the takeover is `fenced` (the Store decides). Acked ops can't be lost: an ack needs a durable, fenced append. |

- **CAP choice:** CP. With no Store, there is no sequencer.

## Risks

- **kill -9 on a single node now costs up to one ttl (10 s) of writer downtime after restart.** The new process has
  a new holder id and must wait for the dead one's lease. Writers retry (main.test.js now does). If p4-wire wants
  this faster: a single-node holder id stable per data dir would let the restart reclaim at once (acquire by the
  same holder bumps the epoch, fencing the dead incarnation). That is unsafe if two processes ever share a data dir,
  and the brief's decision 2 says per-process ids, so I didn't do it.
- **Watch cost at scale** (estimate above). Fine for M2; worth measuring at M4.
- **A holder that is live but whose heartbeats the bus drops** (at-most-once) for 2 heartbeats can get a hello
  answered `unavailable` by a watcher, besides its own welcome. The client then reconnects once. Not a correctness
  problem.
- **Bus-only partition of a holder** (failure walk above): not handled.
- **`hostname` defaults to `$HOSTNAME`**, which macOS doesn't export. Holders are then `host-<pid>-<rand>`: still
  unique, just less readable in `lease()`. p4-wire should pass `os.hostname()`.

## Not verified

- A real kill -9 of a process holding a Postgres lease, and a real network partition. Both were simulated in-process
  (a bus that goes dead, renews that hang).
- NATS as the bus for the lease tests. They use the memory bus; NATS ran only in the suite-wide run (bus contract).
- Hundreds of boards per host: renew timers per board, and watch fan-out.
- Behaviour when holders use different `leaseTtlMs` values. A takeover attempt then may come early, find the lease
  live and re-arm, which costs extra reads but stays safe.

## Cleanup

- **Servers:** Postgres (PID 45920) and NATS (PIDs 45929, then 21155) were stopped by PID. None remain.
- **Scratch data:** the Postgres data dir and a scratch copy of the tree for the mutants stay in this session's
  private scratchpad, because the permission prompt denied `rm -rf`. Nothing was left in the repo or in /tmp.

## PROTOCOL.md proposal (for the owner of PROTOCOL.md)

§ Recovery, Room identity, "Where it lives", replace the `openEpoch` sentence with:

> A room is built only under the board's **lease** in the Store: `Store.acquire(tenant, board, holder, ttlMs) →
> { epoch, expiresAt } | null`, a durable atomic step that takes the lease (if free, expired, or already this
> holder's) and raises the epoch in the same row. The holder renews it every ttl/3 and stops its room, without
> releasing, if a renew is refused, a write is `fenced`, or no renew succeeds within ttl − ttl/3 of the last good
> one's send time (by its own monotonic clock). A clean stop releases it. Single node and cluster take the same
> path; `openEpoch` is kept only for old data.

§ Store, append / putCheckpoint:

> `epoch` is required. A write without one is refused (`bad-entry`); one whose epoch is not the board's lease epoch
> is refused (`fenced`), checked in the write's own transaction. A write the database ended because its client
> paused mid-transaction is `unavailable` (none of it committed).

§ Bus, add:

> Only a board's lease holder subscribes to its inbox. A host waiting to take over a board may answer a hello on
> that inbox with `unavailable` (close 1013), but only once the holder has been silent on `.entries` for 2
> heartbeats. Every adapter has `flush()` and `maxBytes`.

---

# Round 2 (fix round for p4-hostv: 1 HIGH, 3 MEDIUM, 9 LOW)

Brief: docs/m2/briefs/p4-host-r2.md. Findings: docs/m2/reports/p4-hostv.md. Not committed.

**Outcome:** every finding is fixed or answered, and each verifier repro is now a test.
- **Mutants:** the 13 round-2 mutants (each fix undone in a scratch copy) are all caught.
- **Gates:**

  | Gate | Result |
  |---|---|
  | `bun test` with DATABASE_URL + NATS_URL (brew postgresql@17 PID 7665 and nats-server PID 7673 with `max_payload: 2MB`, free ports; includes room-host-proc kill -9 and SIGSTOP) | 1493 pass, 29 skip, 1 fail: test/core-source (the known herdr-draw drift) |
  | `bun test test/server` ×10 | 9 runs: 228 pass, 0 fail. **Run 6: 218 pass, 1 fail, with no `(fail)` line and 10 tests missing:** a test file failed to load, not a test. Another session was editing server/auth/http.js, server/auth/oidc.js and server/admin/tenants.js at the time (`git status`). Three more runs right after: 228 pass, 0 fail each. I couldn't capture which file failed to load; I'm calling it not this job's, but that is unproven. |
  | Earlier round-2 runs | Before the approved gateway.test.js:278 edit, that test failed every run (the `opened` flag). v1.test.js "§ Pacing … maxLiveQueuedBytes" timed out in 2 of 10 runs; it passes alone. It is the load flake the verifier also saw, and not this job's file. |
  | test/architecture.test.js, test/purity.test.js | Green (in the full run). |

## Per finding

| # | Fix (server/room-host.js unless named) | Test | Mutant it catches |
|---|---|---|---|
| HIGH-1 | One guard, `expired(slot)` = `perf() >= okAt + ttl − ttl/3`. It is checked before every inbox message (`onInbox`), before every reply a slot sends (the Room connection's `send`: welcome, ack, error), before publishing an append's entries, and before each heartbeat. Expired: `lost(slot)` and the message is dropped, unanswered. `fail()` of a lost lease sends 1013 only to connections this slot welcomed (`slot.welcomed`). Catch-up isn't sent by the slot at all (the gateway's). | room-host-lease "HIGH-1: a holder woken from a stall…" (in-process, always runs). The stalled holder's inbound bus traffic is queued, and its lease clock and the Store's jump 40 s while its real timers don't run. The new holder's connections get nothing from the stale host; the stale host 1013s only `c1`, its own; B keeps both connections; log `a:1..a:3, x:1, a:4`. Plus room-host-proc "SIGSTOP" (real child on Postgres + NATS; skips without them): nothing from the woken child reaches `x1` or the reconnected writer, the log is `a:1..a:5, x:1, a:6`, and the lease is `h-b`'s. | `high1-no-guards` (both tests), `high1-fail-tells-all` (in-process test; the real-process test can't always see it, see below) |
| MEDIUM-1, L2 | `Store.lease()` returns **`remainingMs`**, judged by the Store's own clock (SQLite: `expires_at − now()` in the store; Postgres: `expires_at − clock_timestamp()` in the same SELECT), 0 unless live. A watcher arms its first attempt at `remainingMs + margin` (margin = max(20 ms, ttl/50)). While it loses, it retries at min(ttl/3, remainingMs + margin). It also attempts at once when the holder goes silent (2 missed heartbeats), and when it sees a release: `close()` now publishes `{ seq, epoch, released: true }` on `.entries` after each `release`. `expiresAt` is never compared with the host's clock. | Contract "lease: remainingMs is the time left…" (both adapters). "MEDIUM-1 (repro C)": takeover within ttl + ttl/3 + 500 ms of the holder's death (the death renew is placed so that a whole-ttl re-arm misses its expiry). "L2 (repro B)": a watcher already in place takes a clean release in < 1 s with ttl 9 s and a 2 s heartbeat; neither the silence rule (4 s) nor the ttl/3 retry (3 s) could do that. | `medium1-whole-ttl`, `l2-no-release-signal`, `sqlite-remaining-fixed`, `pg-remaining-fixed` |
| MEDIUM-2 | The holder's first heartbeat carries `opened: true`. A watcher that hears `opened`, or an epoch above the last one it heard, answers every hello it is holding with `unavailable` (1013); the client retries and reaches the built room. Any other heartbeat means the holder answered them, so they are dropped as before. | "MEDIUM-2 (repro A)": a hello sent mid-build (a 1.5 s rebuild) is answered 1013 in < 2.5 s, and the retry is welcomed. | `medium2-drop-held` |
| MEDIUM-3 | Each renew is bounded. A timeout counts as an error, `renewing` is cleared, and a late result is ignored (it never moves `okAt`). **Deviation from the brief:** the bound is **ttl/6** (half a renew interval), not ttl/3, and a failed or timed-out renew is retried **ttl/12** later, not at the next tick. Why: the deadline is only 2 intervals after the last good send. A renew sent at +1 interval and bounded by a whole interval times out at +2, exactly the deadline, so no retry could ever land. The verifier's repro F failed that way with the literal fix (1 renew call, room dead). | "MEDIUM-3 (repro F)": one hung renew, then ≥ 3 renews within 1.5 s and the room alive. A Store that stays hung: the room is stopped (1013) within ttl, renews kept being retried, and the lease is not released. | `medium3-no-timeout` (7 tests fail) |
| L1 | — | "L1 (repro G)", rescaled to ttl 1.8 s so its 250 ms renews fit under the new 300 ms bound. Stops < ttl − ttl/3 + 100 ms after the last good renew's **send**. | `l1-receive-time` |
| L3 | `renewTick` checks `expired` before sending, and a renew result that comes back after the deadline is `lost`, never accepted. The room reopens only through a new `acquire` (a new epoch). | "L3 (repro H)": event loop blocked 700 ms and 1,500 ms (deadline 600). The room is gone afterwards; a new `open()` builds epoch 2. | `l3-revive` |
| L4 | In-flight appends join `slot.writes`, so `close()` settles them before `release`. | "L4": close waits on a gated append; the order is `append landed`, then `release`. | `l4-append-not-settled` (9 tests fail) |
| L5 | A build that fails for a non-lease reason stops renewing, answers the hellos it was holding, and `release`s the lease. A lost lease is never released. | "L5": `getCheckpoint` throws → lease holder null → another holder acquires epoch 2 at once. | `l5-no-release` |
| L6 | No code change. The shared `heartbeatMs` is in the PROTOCOL.md proposal below. | — | — |
| L7 | Past 1,000 held hellos per watched board, the extra ones are answered `unavailable` at once. | "L7": 1,005 hellos to a dead holder's board. `c1000..c1004` are answered at once, and all 1,005 by the silence. | `l7-drop-extra` |
| L8 | test/server/main.test.js: round 0 (a fresh boot) uses a plain welcome; only post-kill rounds retry. | That test. | — |
| L9 | The PROTOCOL.md proposal below is completed. | — | — |

**Other changes:**
- **New `roomHost` option `monotonic`:** the lease's clock, default `performance.now()`. Tests move it to fake a
  stall; it is never the rooms' `now`.
- **test/server/pg-store.test.js:** two exact `lease()` matches gained `remainingMs`; store.test.js likewise.
- **New files:** test/server/room-host-proc.test.js and its child script, test/server/room-host-child.js.

## Approved test edit outside my file list (round 2)

- **test/server/gateway.test.js "the entries subject carries each entry once…"** (approved by t18m):
  - The first heartbeat is now `toEqual({ seq: 0, epoch: 1, opened: true })`, still an exact match.
  - The rig runs with `host: { heartbeatMs: 50 }` so a later beat arrives in the test, and that later beat is
    asserted exactly `{ seq: 3, epoch: 1 }`, with no `opened`.
- **The gateway ignores the flag:** `server/feed.js:140` is the only `.entries` subscriber in the gateway, and its
  `onMessage` (`feed.js:127-138`) reads only `epoch`, `items`/`from`/`to` and `seq`. `opened` and `released` are
  ignored there, and the message is handled as a plain heartbeat.

## Mutation checks (round 2)

Scratch copy of the tree; each mutant applied alone, its pattern matched exactly once, and run against
room-host-lease, store and pg-store tests (DATABASE_URL set).

| Mutant | Result |
|---|---|
| high1-no-guards (no inbox and no reply guard) | caught (in-process HIGH-1; and room-host-proc SIGSTOP on Postgres + NATS) |
| high1-fail-tells-all (no inbox guard, and a lost lease's `fail` 1013s every connection) | caught by the in-process test. **Survived the real-process SIGSTOP test in one run:** after SIGCONT the child's overdue deadline timer fired before NATS handed it the queued messages, so the mutated branch never ran. Real ordering varies; the in-process test fixes the order and always catches it. |
| medium1-whole-ttl (attempts re-armed a whole ttl, as before) | caught (repro C) |
| l2-no-release-signal | caught (repro B) |
| medium2-drop-held | caught (repro A) |
| medium3-no-timeout | caught (7 tests) |
| l1-receive-time | caught (repro G). It survived G at first: my new 150 ms renew bound timed out G's 250 ms renews. G was rescaled to ttl 1.8 s and now catches it. |
| l3-revive | caught (repro H) |
| l4-append-not-settled | caught (9 tests) |
| l5-no-release | caught |
| l7-drop-extra | caught |
| sqlite-remaining-fixed, pg-remaining-fixed | caught (contract) |

The verifier's 15 round-1 mutants were not re-run as a set: their patterns no longer match the edited code. The tests
that caught them are unchanged and green.

## Risks (new or changed)

- **Watcher load:** a watcher now asks the Store about every ttl/3 while the holder is live, where round 1 asked once
  per ttl. That is ~3× the reads: at 10 hosts × 1,000 boards, up to ~2,600 primary-key reads/s worst case.
  `watchIdleMs` still bounds it to boards that have writers somewhere.
- **Double answers across subjects:** a hello that reaches the watcher before the holder's `opened` heartbeat but
  after the holder subscribed (NATS doesn't order across subjects) gets a welcome and a 1013. The client reconnects
  once.
- **Renew retries during an outage:** up to ~4 attempts per interval until the deadline, instead of 1.

## Not verified (round 2)

- **Postgres stopped under a holder** (the verifier's PGDOWN) was not re-run. The renew path changed (timeout +
  quick retry), but a refusal is just an error to it.
- **The real-process test** is timing-dependent for `high1-fail-tells-all` (above).

## PROTOCOL.md proposal (complete; replaces round 1's)

For the owner of PROTOCOL.md. Line numbers are as of today.

- **:20 ("What changed in v1.1", `welcome`):** "`epoch` rises on every room build: it is the board's **lease** epoch in
  the Store (§ Recovery, Room identity)."
- **:31 (Store row):** "also each board's lease and epoch: `acquire`, `renew`, `release`, `lease`, `epoch` (§ Store)".
- **§ Recovery, Room identity, "Where it lives" (:428-433), replace with:**
  > A room is built only under the board's lease in the Store. `acquire(tenant, board, holder, ttlMs) → { epoch,
  > expiresAt } | null` takes it if it is free, expired, or this holder's, and raises the epoch in the same durable
  > step. The room welcomes nobody before that. Single node and cluster take the same path. Holders are unique per
  > host process (`<host>-<pid>-<random>`).
  >
  > **Renew and deadline.** The holder renews every ttl/3, each renew bounded at ttl/6, and retries a failed one
  > ttl/12 later. It stops its room without releasing if:
  > - a renew is refused;
  > - a write is `fenced`; or
  > - no renew succeeded by its **deadline**: the send time of the last good renew (or the acquire) + ttl − ttl/3,
  >   on its own monotonic clock.
  >
  > Past the deadline it answers nothing (no welcome, ack or error), and it tells `unavailable` only to connections
  > it welcomed. A clean stop checkpoints, settles its writes, releases, and announces `{ seq, epoch, released: true }`
  > on `.entries`.
- **:443-446 (the "Lower than seen" bullet), replace the second and third sentences with:** "This lasts at most until
  the stale host's deadline (ttl − ttl/3 after its last renew), and any write it makes after a takeover is refused
  `fenced` in the write's own transaction."
- **§ Store table (:704, :707, :708), replace those rows:**
  - `append(tenant, board, entries, expectSeq, epoch)`: atomic, only if the last `seq` is `expectSeq` (else
    `conflict`) **and** `epoch` is the board's lease epoch (else `fenced`, checked in the same transaction). No
    epoch: `bad-entry`.
  - `putCheckpoint(tenant, board, cp, epoch)`: fenced like `append`.
  - Remove the `openEpoch` row. Add `acquire`, `renew` and `release` (holder and epoch checked; ttl a positive
    integer ≤ 10 min). Add `lease(tenant, board) → { holder, epoch, expiresAt, live, remainingMs } | null`.
    `remainingMs` is the time to expiry measured on the Store's clock, 0 unless live, so nobody compares clocks with
    the Store.
  - `openEpoch` stays in the adapters for old data only. Nothing in the server calls it.
- **:714 ("gets `conflict` on its next append"), replace with:** "A host that lost its lease gets `fenced` on its
  next write (one that is merely behind gets `conflict`). Either way it stops and answers `unavailable` to the
  connections it welcomed; it never acks."
- **§ Store, add:** "A write the database ended because its client paused mid-transaction is `unavailable`; none of
  it committed."
- **§ Bus, add:**
  - **Inbox:** only a board's lease holder subscribes to its inbox.
  - **Heartbeats:** every host runs the same `heartbeatMs` (2 s), because watchers judge a holder's silence by
    their own value.
  - **`opened`:** only the first heartbeat of a newly built room carries `opened: true` (`{ seq, epoch, opened: true }`,
    published before the room subscribes the inbox); later heartbeats never do. A host waiting on the lease that hears
    it answers every hello it is holding `unavailable` (1013): its room subscribed after those hellos and never saw
    them, so the clients retry and reach it.
  - **`released`:** a clean release publishes `{ seq, epoch, released: true }`. A waiting host answers its held
    hellos and attempts `acquire` at once.
  - **Gateways ignore both flags** and handle such a message as a plain heartbeat (`seq` repair, `epoch`).
  - **What a waiting host answers:** a host waiting to take a board over subscribes to its `.entries` and inbox. It
    answers a writer's hello `unavailable` (1013) only:
    - while the holder is silent (no `.entries` message for 2 heartbeats);
    - when a new holder opens (an `opened` heartbeat, or a higher epoch); or
    - when it already holds 1,000 hellos for the board.

    It holds other hellos and drops them once the holder is heard from. A live holder's board is otherwise never
    answered by it.
  - **Takeover timing:** it attempts `acquire` at `lease().remainingMs` + a small margin, then every ttl/3 while it
    loses. It also attempts at once on silence or on a `released` message. A dead holder's board is taken within
    about ttl + ttl/3; a released one at once.
  - Every adapter has `flush()` and `maxBytes`.

## Cleanup (round 2)

- **Servers:** Postgres (PID 7665) and NATS (PID 7673) were stopped by PID after the gates. Test schemas were dropped
  by the tests' `afterAll`.
- **Scratch data:** scratch copies and the Postgres data dir stay in this session's private scratchpad (`rm -rf` was
  denied in round 1). Nothing was left in the repo or /tmp.
