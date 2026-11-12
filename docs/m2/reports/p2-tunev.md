# p2-tunev: verification of p2-tune (revocation at scale, `here`, feed and test fixes)

Verifier: t1gf (`plenary-p2-tunev`), 2026-11-12. Manager: t18m. Verified the uncommitted job files at these sha256,
the same at the start and at the end of verification:

```
9c85cb7d…dd338  server/gateway.js        27f60d61…7d5be  server/feed.js       e0a48274…7ad  PROTOCOL.md
69393599…564d   test/server/rig.js       82af607f…ccd8c  test/server/v1.test.js
873121de…556    test/server/tune.test.js ef468d43…af    test/server/harness.test.js
```

## Verdict: FAIL

- **HIGH 1 (M1 regression):** one Registry lookup that doesn't settle holds the board's only re-check pass. Every
  later `grants` pass waits behind it, so a revoked editor keeps writing: its op was acked after the revocation. HEAD
  closed the same editor.
- **HIGH 2 (fails R2's goal):** a few users whose lookups always error, at the head of the pass, get every healthy
  connection on the board closed. Measured: 300 of 300 healthy viewers closed; HEAD closed only the failing users.
  The code follows § Auth's stop rule, so the fix starts in PROTOCOL.md.
- **Gate missed:** `bun test test/server` 10x had 2 failures in 10 runs. Both were in `v1.test.js:217`, a test the
  builder edited; its new wait is for a fold that, under load, never comes (LOW 2). Run 2 overlapped my attack runs;
  run 9 ran on a quiet machine.

What holds: R1's stall fix (286 ms → 8 ms for 20 grants), R3, R4 (also with a real Store row), R6, revocation during
a retry window, the strictness upgrade, `here` over real NATS and never logged, the hexagonal rules, and 12 of 13
mutations of the job's tests.

## Gates run

The clean copy is `git archive HEAD` plus only the 7 job files, so other sessions' in-flight edits don't count.

| Gate | Result |
|---|---|
| `bun test`, as-is copy of the shared tree | 1,046 pass, 0 fail |
| `bun test`, clean copy | 927 pass, 0 fail |
| `bun test`, clean copy, DATABASE_URL + NATS_URL (brew postgresql@17 17.11 and nats-server, free ports, `max_payload: 2MB`) | 991 pass, 19 skip, 0 fail |
| `bun test test/server` 10x, clean copy | **8/10 clean.** Runs 2 and 9 timed out in `v1.test.js` "a board feed picks up the host's checkpoint…" at line 217 (LOW 2). R6's convergence test passed all 10. |
| test/architecture.test.js | green in every full run. gateway.js and feed.js import ports only (`./bus/port.js`), no adapter; the diff adds no import. |
| PROTOCOL.md edits | only § Presence (`here`), § Auth (Re-checking live connections) and § Bus (`.grants` note, `.here`) |

## Findings

### HIGH 1: a Registry lookup that doesn't settle holds every later grants pass on the board, so a revoked writer keeps writing

- **Where:** `server/gateway.js:526-545` and `:598`. `requestRecheck` allows one pass per board. `recheckPass`
  awaits `Promise.all(batch.map(one))` with no timeout on `auth.role` (`:581`).
- **What happens:** while one `role()` call is unsettled, `rc.running` stays set. Every `.grants` message only marks
  `rc.again`, which doesn't run, and timed ticks are skipped. If the call never settles, revocation on that board is
  off for the gateway's life.
- **The Registry can wait without limit:** no adapter bounds a call. The port contract
  (`server/auth/registry-port.js:11-14`) says a timeout rejects, but nothing produces one.
  `server/registry/postgres.js:79` builds `new SQL(url)` with no query timeout.
  - Measured on real Postgres: with `reg_grants` locked by another transaction, `registry.grant()` was still
    pending after 15 s and answered once the lock was released.
  - A half-open TCP connection, or a pool waiting on one, would wait the same way (inferred, not reproduced).
- **Against HEAD:** each `grants` message there started its own pass, so a later pass got past a call that stays
  stuck while later calls succeed. Under a lock on the whole table, HEAD's passes would wait too. HEAD's advantage
  is that case only; the job's change makes one stuck call block every later grants pass.
- **Ensemble:** codex flagged it HIGH on its own; grok did not.
- **Repro** (scratch test, the roleRig of tune.test.js; `role` never settles once, for `dev:stuck`):

```js
await open(["stuck"], "editor"); const [victim] = await open(["victim"], "editor");
ctl.hang.add("dev:stuck");                      // that user's NEXT role() never settles; later calls are fine
gw(r).recheck(r.ids.board, "timed");            // not awaited
await until(() => /* the pass called role(dev:stuck) */);
await r.registry.setGrant(r.ids.board, "dev:victim", null);   // revoke
await r.bus.publish(subjects.grants(tenant, board), { board });
// job:  victim not closed after 3 s; stats().rechecks.running = 1; victim sends op "c0:1"
//       → {"t":"ack","id":"c0:1","seq":1}   (a revoked editor's op is acked and logged)
// HEAD: victim closed {"code":1008,"reason":"auth"} within ~25 ms
```

- **Fix direction:**
  - Bound each lookup in a pass with a timeout and count it as an error, so a `grants` pass fails closed.
  - Don't let a `grants` pass wait behind a running timed or retry pass: cut the running pass short when a stricter
    one is asked for. This also fixes the 100k revocation delay in the CHECKER section.
  - Adapter timeouts are worth adding, but the gateway must not rely on them for M1.

### HIGH 2: the "3 errors in a row" stop plus writers-first order closes every healthy connection on the board

- **Where:** `server/gateway.js:599` (stop) and `:602` (unreached users marked failed), with `:564` (writers first).
- **What happens:** the next `retry` pass meets the same failing writers first, stops again and marks everyone
  again. After `recheckRetries` rounds, every connection is closed `unavailable`.
- **This follows the spec:** § Auth says "A timed pass that meets 3 errors in a row stops and treats the users it
  didn't reach the same way". So the fix starts in PROTOCOL.md.
- **Exact trigger:** `inRow` is read after each batch, and a success resets it.

  | Failing users at the head of the pass | `recheckConcurrency` | Healthy viewers closed |
  |---|---|---|
  | 8 (one full batch) | 8 (default) | **300 / 300** |
  | 3 | 1 | **300 / 300** |
  | 3 | 8 (default) | 0 / 300 |
  | HEAD, 8 failing | — | 0 / 300 (only the 8 closed) |

  So it needs `recheckStopAfterErrors` errors that end a batch: by default, a full batch of 8 failing users first in
  order. Since writers come first, that means 8 writers.
- **Why it matters:** it breaks R2's goal ("a Registry blip never closes everyone") for a Registry that fails on some
  users only, for example a bad invite or link row that makes `tenancy.role` throw. On a 100k-viewer board, one such
  pass disconnects everyone and starts a 100k reconnect storm.
- **Ensemble:** grok flagged the same mechanism (HIGH); codex flagged that `inRow` depends on completion order
  (MEDIUM).
- **Repro:**

```js
const { r, ctl, open } = await roleRig({ recheckRetryMs: 20 });
const healthy = await open(names(300, "h"));                // viewers
await open(names(8, "bad"), "annotator");                   // writers: checked first
for (let i = 0; i < 8; i++) ctl.fail.add("dev:bad" + i);    // their role() always throws
await gw(r).recheck(r.ids.board, "timed"); await sleep(1500);
// job: healthy closed 300/300 (1013 "role re-check failed").   HEAD: 0/300.
```

- **Fix direction:**
  - Change the rule in PROTOCOL.md first: never count unreached users as failed. When a pass stops, leave them
    unchanged and schedule the retry.
  - Judge "the Registry is down" by errors over distinct users across the pass (for example, a share of users
    asked), not by the first batch.

### MEDIUM 1: `here` resends the full writer list to every connection when only the viewer count changes

- **Where:** `server/gateway.js:707-710`.
- **Measured:** 2,000 viewers and 50 annotators on one gateway, with viewers joining at about 18/s for 12 s.
  - Each viewer got a `here` every 5 s (big-board pacing), each the full 50-writer list: 2,586 bytes with short test
    names. That is about 1 MB/s of `here` at 2,267 connections.
  - The writers never changed; only `viewers` did.
  - Max event-loop gap during the run: 17.6 ms.
- **At scale (arithmetic):** cost is linear in connections. With realistic ids and names a 50-writer `here` is
  4,499 bytes, so 90 MB/s per gateway holding 100k connections on a board, and 9 MB/s at 10k.
- **Spec vs NFR:** the spec's pacing allows this, so it conforms. Against the NFR it is the largest steady outbound
  cost in the gateway. CHECKER flags the same thing: large-group status fan-out.
- **Fix direction:** send counts separately from the list, or resend the list only when the writers change.

### MEDIUM 2: a long pass on one board holds the event loop about N × 8 ms when N boards' passes run at once

- **Where:** `server/gateway.js:769`: `roleTimer` starts `requestRecheck` for every board in the same tick, one async
  chain per board. A grants storm across boards does the same.
- **Why:** `server/breather.js` yields per chain, so N chains each take their own 8 ms slice in one loop turn. The
  builder named this risk for its pumps; the re-check path has it too. The `here` timer starts at most one
  `hereSend` per board (`:710`), the same shape for boards over 1,000 connections.
- **Measured:** 10 boards × 300 viewers, with 100 µs of synchronous Registry work per call (about 30 ms per pass).
  - One timed tick held the loop up to **82.1 ms**.
  - `grants` on all 10 boards at once: **82.3 ms**.
  - With 300 boards × 7 connections (each pass well under one slice): at most 4.2 ms, so it needs passes longer than
    8 ms.
- **Why it matters:** editors are promised < 150 ms; about 10 busy boards on one process already take half that.
- **Fix direction:** one process-wide re-check queue (boards one after another), or a breather whose slice is shared
  by all chains of one turn.

### MEDIUM 3 → LOW: the retry backoff counter is not reset after a close-out, unless a clean pass comes in between

- **Where:** `server/gateway.js:613`. `rc.retries` resets only on a pass with no error and nothing kept. The pass that
  closes the last failing connections has `lastErr` set, so the counter stays at 3.
- **What it breaks:** a second problem on the same board before any clean pass starts at `2 s × 2^3`, with a cap only
  at `2^10` (2,048 s). The spec's "2 s, 4 s, 8 s" and "an expired link outlives `expiresAt` by at most about
  60 s + 14 s" then don't hold.
- **Ensemble:** both codex and grok flagged it.
- **Repro** (`recheckRetryMs: 20`, so 2/4/8 s become 20/40/80 ms):
  - `dev:a` fails and is closed after 144 ms.
  - `dev:b` then fails on the same board and is closed after **1,123 ms** (waits of 160/320/640 ms). With one clean
    timed pass in between, `dev:b` is closed after 143 ms.
- **Severity:** rated LOW because the next 60 s timed pass is usually clean. It stays wrong while failures keep
  coming.

### LOW

1. **Ranking deviates from the spec.**
   - `hereTop` (`gateway.js:663`) orders by role (owner, editor, annotator, commenter), then by activity. The spec
     (§ Presence) says owners and editors first, then the most recently active.
   - Repro: `hereMax: 1`; an idle annotator and a commenter sending cursors. The annotator is listed.
   - Ensemble: codex and grok both flagged it.
2. **`v1.test.js:217` (the builder's edit) waits for a fold that may never come.**
   - The host folds by bytes only when nothing is in flight (`server/room-host.js:108-109`). Under load, op 2's fold
     is skipped while op 3 is in flight, so folds land on 3, 5, 7, 9. Op 10 alone (50 KB) is under the 64 KB
     trigger, and `base.seq` stays 9 forever.
   - Deterministic repro (same test): op 1, then ops 2 and 3 sent together, then 4 to 10 one at a time. Result:
     `base.seq = 9, resolved 10`, and the test times out at 15 s.
   - It failed 2 in 10 in the gate loop; 0 in 30 isolated runs on a quiet machine.
   - Fix: assert the feed rebases onto whatever the room's base settles at, not on 10. Or use a trigger below one
     op's size.
3. **The strictness upgrade has no test.**
   - Deleting `else if (STRICT[kind] > STRICT[rc.again.kind]) rc.again.kind = kind;` (`gateway.js:531`) passes every
     test in the job.
   - The code is right. My scratch test B2 passes on the job and fails with the line removed: the revoked writer
     stays open, because a `grants` arriving while a `retry` pass is queued then runs as a retry pass, which checks
     only previously failed connections.
   - Add a test like B2: P is a grants pass held at a failing writer; the retry timer fires during P; then revoke
     and send `grants`; release; expect a 1008 close.
4. **Per-user grouping uses the first connection's identity** (`gateway.js:559`, `:581`).
   - `tenancy.role` also reads `identity.email` (invites) and `identity.domain` (member role), at
     `server/auth/tenancy.js:33` and `:38`. Two live tabs of one user id whose tokens carry different email claims
     get the first tab's answer.
   - Codex rated it HIGH. I rate it LOW: it needs one user id with differing email claims in two live tokens (an
     email change), and the spec chose per-user answers. Confirmed by reading; not run.
5. **The first joiner of a board gets no `here` after its catch-up.** `b.hText` is null until the first tick (≤ 1 s;
   `gateway.js:629`). The spec says "to a joiner right after its catch-up". Found by codex; confirmed by reading.
6. **Spec inconsistencies:**
   - § Auth says "A `grants` message (or the timer) during a pass runs one more pass" and then "A timer tick during a
     pass is skipped". The code skips.
   - The stop-after-errors rule also applies to `retry` passes in code; the spec names only the timed pass.
   - `inRow` with 8 lookups in flight depends on the order they finish (codex).
   - § Messages table, PROTOCOL.md:260, says `here` goes "at most 1/s"; big boards get 5 s. That line is outside the
     job's sections.
7. **Grants delivery is at-most-once (bus), and the timed pass is its only repair.** A lost `.grants` costs up to
   60 s, not "within one pass". This was true before the job too; the spec text could say so.

### Refuted (ensemble claims checked against code)

- **grok, feed false positive on a duplicate at seq + 1:** every feed step runs serialized through `run()`, and
  `repair` reads from `seq + 1`, so a page can't hold an entry at or below `seq`. The remaining zero-apply causes are
  a gap and a foreign or corrupt entry, both meant to set `gapAt`.
- **grok, `hereCount` leaks on a role change:** a connection's role never changes in place; a change closes it, and
  `end()` calls `hereCount(c, -1)` before `leaveBoard`.
- **grok, a grants request lost when the board is deleted:** with no board there are no connections left to check.

## What was checked and held

- **R1 (stall).** 2,000 sockets, one user each, SQLite Registry, `setImmediate` loop probe; the same scratch test on
  HEAD and on the job:

  | | HEAD | job |
  |---|---|---|
  | max loop gap, 20 grants | 286 ms | 8.1 ms |
  | passes for 20 grants | 20 (by code: one chain per message) | 2 (measured, `stats().rechecks`) |
  | one pass | 14–16 ms | 17 ms |

  - Memory Registry: 30 ms vs 7 ms.
  - Across boards, see MEDIUM 2.
- **R3.** Revoking the last viewer in the pass, with 2,000 connections: 16 ms from the `grants` message to the close
  (SQLite Registry; 3 ms with the memory Registry).
- **R2 paths that hold:**
  - A blip that clears before the retry closes nobody.
  - A `grants` error fails closed, also when queued during a timed pass.
  - **A writer revoked during a timed pass's retry wait** (retry due in 2 s) was closed `auth` at once by the grants
    pass (B1).
  - **A grants arriving while a retry pass is queued** is upgraded and closes the revoked writer (B2).
- **R4.**
  - A foreign entry at seq + 1 refuses joins.
  - With a **real row in the SQLite Store**: an `entries` row at (tenant, board, 1) whose JSON names another board.
    The viewer was refused `unavailable` (1013, "log gap"), and the log says "the Store returned another board's
    entry" and "has an entry it can't serve".
  - Mutating feed.js back to the old condition fails the R4 test.
- **R6.** Root cause read in rig.js (adopting a socket after a drop). `harness.test.js` fails when the fix is
  reverted. The convergence test passed 10/10.
- **`here`:**
  - Relayed between two gateways over a **real NATS server** (two NATS connections in one process; not two OS
    processes). Both sides got the same merged answer: one user on both gateways listed once, viewers summed.
  - A stopped gateway's users dropped from the other's `here` after 15.0 s (the TTL).
  - A client sending `{t:"here"}` gets `bad-op` "unknown message type", and nothing is relayed.
  - With 2,267 connections and churn (MEDIUM 1's run), nothing reached the room's inbox, no log line contained it,
    and Store `lastSeq` stayed 0.
- **Mutations** of the job's tests (each reverted one at a time; 14 of 15 caught):

  | Mutation | Caught by |
  |---|---|
  | no coalescing | R1 coalescing test |
  | per connection, not per user | R1 per-user test |
  | no writers-first | R1 per-user test |
  | grants fail open | R2 grants test |
  | timed fails closed | R2 timed test |
  | no retry timer | R2 timed test |
  | no stop-after-errors | R2 blip test |
  | R4 reverted | R4 test |
  | no `hereMax` slice | `here` bounded test |
  | no big-board pacing | `here` bounded test |
  | no cross-gateway merge | `here` merged test |
  | `here` written to the log | `here` relayed/never-logged test |
  | `here` published to the room's inbox | `here` relayed/never-logged test |
  | R6 reverted | harness test |
  | **strictness upgrade removed** | **not caught** (LOW 3; my B2 catches it) |

## systems-design CHECKER (distributed-systems-design skill, CHECKER mode, on the re-check path and `here`)

- **Failure scenarios for every component: missing one.** The design handles a Registry that throws, but not one
  that waits. There is no timeout on the dependency (HIGH 1). Retry with limits is present (2/4/8 s), but its state
  isn't reset after a close-out (MEDIUM 3 → LOW).
- **Blast radius:** a partial dependency failure turns into a board-wide close (HIGH 2). Errors should be isolated
  per user.
- **A gateway never stalls:** holds per board; not across boards with long passes (MEDIUM 2).
- **Large-group status fan-out (Ch. 12, "100K members = 100K events per status change"):** `here` correctly uses
  counts, a 50-entry list and pacing. But a count-only change still resends the list to every connection
  (MEDIUM 1).
- **Exactly-once assumption:** none. `.grants` is at-most-once, and the 60 s timed pass is the repair (LOW 7).
- **Presence flapping (Ch. 12):** the 1 s / 5 s pacing and the 15 s TTL act as debounce. Measured: short-lived
  churners that come and go between ticks cause no sends at all.
- **Back of the envelope at 100k (estimate, not measured):** 100k users ÷ 8 concurrent × 2 ms ≈ 25 s per pass
  against Postgres. A `grants` arriving during a timed pass waits for that pass's viewer tail, up to about 25 s,
  before its own pass (writers first, about 0.5 s). Revocation latency at 100k is then about 25 s, not "within one
  pass". HIGH 1's "cut the running pass short" fix also fixes this.

## sdd ensemble

- **Harnesses:**
  - codex (`effort: high`) and grok each ran in their own scratch copy of the job.
  - agy: out of quota (`RESOURCE_EXHAUSTED`, resets in 55 h).
  - kimi: not logged in.
  - mistral: no `MISTRAL_API_KEY`.
  - qwen: not installed.
- **Findings both harnesses raised:**
  - backoff not reset: confirmed (MEDIUM 3 → LOW, with the clean-pass qualifier);
  - ranking: confirmed (LOW 1);
  - the stop or `inRow` logic: confirmed in a stronger form (HIGH 2).
- **codex alone:**
  - HIGH 1: confirmed by repro, and by the real Postgres lock wait;
  - identity grouping: confirmed by reading, downgraded to LOW 4;
  - first joiner without `here`: LOW 5;
  - lost grants: LOW 7.
- **grok alone:** three claims refuted (above).

## Not verified

- `here` between two separate OS processes (verified with two NATS connections in one process).
- Re-check pass cost against a real Postgres Registry under load. The 100k figure is arithmetic.
- A call that never settles on real Postgres. A lock wait was reproduced (pending after 15 s, answered on release); a
  half-open TCP connection was not.
- 100k sockets. The largest run was 2,267 sockets; MEDIUM 1's 100k figure is linear arithmetic from it.

## Housekeeping

- **Services:** Postgres (PID 5600, port 55083, TCP only) and NATS (PID 5694, restarted as 24178 with
  `max_payload: 2MB`, port 55084) were started on free ports and stopped by PID. All three PIDs were confirmed gone.
- **Scratch data NOT deleted:** the `rm -rf` was refused by the session's permission check.
  - What remains: the copies, the stopped Postgres data dir and the attack tests (no `.env`, no secrets), under
    `/private/tmp/claude-501/-Users-r-repos-plenary/86f5311c-c95e-42e9-8217-cd4758a0a648/scratchpad/`.
  - The manager may delete it.
  - Rig temp dirs were removed by each test's `afterAll(cleanup)`.
- **Shared tree:** nothing changed except this report.

## Round 2

Verdict (round 2): PASS (both HIGHs fixed; 2 MEDIUMs and 4 LOWs remain, none blocking)

Re-verified 2026-11-12 by t1gf against the r2 tree, pinned by sha256: gateway.js `aae885a6…`, feed.js `27f60d61…`,
PROTOCOL.md `46c0d6cb…`, rig.js `69393599…`, v1.test.js `c73682cd…`, gateway.test.js `491c369c…` (the job's `here`
filters), tune.test.js `b1879340…`, harness.test.js `ef468d43…`. They were the same at the end. The clean copy is HEAD
`ec731c7` plus these 8 files only; the p4-store-lease files are not included. I used the builder's Round 2 section
for its claims only, and tested each one against the code.

### Gates

| Gate | Result |
|---|---|
| `bun test`, clean copy | 1,130 pass, 0 fail |
| `bun test test/server` 10x, clean copy | **10/10**, 194 pass, 0 fail each. Several runs overlapped my attack and mutation runs. |
| `bun test`, clean copy, DATABASE_URL + NATS_URL | 1,215 pass, 19 skip, 0 fail. Postgres PID 83234 and NATS PID 83295 (`max_payload: 2MB`), free ports, both stopped by PID and confirmed gone. |
| R1 stall: 2,000 sockets, 20 grants, SQLite Registry | max loop gap **8.7 ms** (round 1: 8.1 ms; HEAD: 286 ms). One pass 17–19 ms; revoke to close 17–18 ms. |

### Round-1 findings, each re-run with its own repro

| Finding | Repro (my scratch tests) | Result |
|---|---|---|
| HIGH 1, lookup that never settles | timed pass stuck on `dev:stuck`, then revoke `victim` and send `grants` (`recheckLookupMs` 300) | **Fixed.** Victim closed `auth` 1008 after 296 ms. |
| HIGH 1, cut | slow timed pass (200 viewers × 20 ms, concurrency 1); revoke the writer during its viewer tail | **Fixed.** Victim closed after 37 ms (`cut: 1`). With the cut removed: 3,893 ms. |
| HIGH 2, partial failure | 8 failing writers first + 300 healthy viewers | **Fixed.** Healthy closed 0/300, bad 8/8 (round 1: 300/300). |
| Backoff counter | `dev:a`, then `dev:b` fails on the same board (retry 20 ms) | **Fixed.** Both closed after 143 ms. |
| `here` cost | 2,000 viewers + 50 writers, viewers joining for 11 s | **Fixed.** Count-only frames of about 44 B (was 2,586 B with the list), 0 frames with the list. A writer joining sends the list. A late joiner's first `here` has the full list (50). Nothing in the log or the Store. |
| LOW 1, ranking | `hereMax: 1`, idle annotator vs active commenter | **Fixed.** The commenter is listed. |
| LOW 2, fold test | the gate loop | **Fixed.** 10/10 green. The test now uses the deterministic send order and asserts on the base the room settles at. |
| LOW 3, strictness upgrade | builder's B2 test | **Fixed.** Removing the upgrade fails the test. |
| LOW 4, grouping | one user, two tabs with emails `one@` and `two@`, each with an editor invite; revoke `two@`'s invite | **Fixed.** Only tab two closed (1008). Tab one stays. |
| LOW 4, key | the key at `gateway.js:591` vs `tenancy.js` | **Confirmed identical.** `` `${c.user}\n${c.identity?.email ?? ""}\n${c.identity?.domain ?? ""}` `` matches `identityKey` at `tenancy.js:38`, character for character. `tenancy` reads only `identity.user`, `.email` and `.domain` (checked every `identity.` access), so `rolesFor` keying by `identityKey` agrees with the gateway's groups. Two definitions of one key could drift; the gateway could import `identityKey` (tenancy.js is core, not an adapter). |
| LOW 5, first joiner | `hereMs` 5 s (no tick); one editor joins | **Fixed.** `here` with itself as the 2nd frame, right after catch-up. |
| LOW 6 and LOW 7, spec | read § Auth, § Presence, § Bus, PROTOCOL.md:260 | **Fixed.** The spec now says: timer tick skipped; the cut; per-connection backoff; the stop rule names timed passes; the bound holds "while the Registry answers"; `.grants` is at-most-once and the timed pass repairs it; count-only `here`; line 260 is "1/s (5 s on big boards)". |
| MEDIUM 2, N × 8 ms across boards | not re-run | **Open.** The builder left it (`breather.js` isn't its file). 300 small boards on SQLite: max gap 19.5 ms. |

### Mutations (mine, one at a time in a scratch copy, against tune.test.js)

| Mutation | Result |
|---|---|
| no lookup timeout | caught (H1 test) |
| no cut | **not caught by the job's tests**; my H1b catches it (37 ms vs 3,893 ms) |
| a spent budget closes the whole board | caught (H2) |
| no "whole first batch failed" stop | caught (R2 blip test) |
| backoff exponent per board, never reset | caught (M3) |
| always the full `here` | caught (M2/LOW 5) |
| no first-joiner `here` | caught (M2/LOW 5) |
| rank by role | caught (LOW 1) |
| no strictness upgrade | caught (LOW 3) |
| group by user id only | caught (LOW 4) |

### Remaining findings (round 2)

- **MEDIUM A: on a Registry that hangs, a `grants` pass reaches a revoked writer slowly.**
  - Every lookup now waits `recheckLookupMs` and fails closed, 8 at a time. A revoked writer behind N other writers
    is closed after about N ÷ 8 × 2 s.
  - Measured (`recheckLookupMs` 200, 40 writers ahead): 1,209 ms, and all 41 writers were closed. At 2,000
    annotators and the default 2 s, that is about 500 s.
  - Bounded now (round 1: never), but long. The builder lists it under Risks as the manager's call. A circuit breaker
    (one all-timeout batch closes the rest at once) would make it about 2 s.
- **MEDIUM B: N × 8 ms stall across boards.** Round-1 MEDIUM 2, still open, as above.
- **LOW A: the cut is untested** (mutation above). Add my H1b as a test: a slow timed pass with a writer revoked
  during its tail, asserting a close in under about 1 s.
- **LOW B: in a full outage, only the first batch (the top 8 writers) is closed.**
  - When every lookup errors, the timed pass stops after its first batch. Those 8 retry and are closed after about
    14 s; everyone else is unchanged until the Registry answers.
  - Measured with 50 users: 0 closed at once, 8/50 closed after 1.5 s (retry 20 ms).
  - So a long outage drops each board's top writers (often the presenters) and keeps everyone else. This is
    conformant ("that connection alone… closed"; the stop leaves the rest unchanged). The fix is a policy choice:
    after a "Registry down" stop, either keep the first batch too, or close everyone kept.
- **LOW C: `recheckConcurrency: 1` (not the default) makes one failing writer at the head stop every timed pass.**
  - Each timed pass then checks only that one user, so expiry for everyone else on the board waits one more period
    per failing writer.
  - Measured: 3 failing writers, concurrency 1 → 1/3 closed after 1.5 s, healthy 0/300. With the default 8, it takes
    8 failing users at the head.
  - Bounded, because those users can't reconnect once closed.
- **LOW D: two definitions of the grouping key** (`gateway.js:591` and `tenancy.js:38`). They are identical today.

### Housekeeping (round 2)

- Services were started on free ports, stopped by PID and confirmed gone.
- Scratch copies (`c2`, `a2`, `m2`, `svc2`) are left in the session scratchpad, like round 1's (`rm -rf` there was
  refused). They hold no `.env` and no secrets.
- Nothing in the shared tree changed except this section.
